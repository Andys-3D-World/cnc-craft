//! STL EINLESEN UND SCHNEIDEN – Zwilling von `src/stlMesh.ts` (readStl, weldMesh, viewCoords, sliceMesh,
//! findBestHeight).
//!
//! Binäre und Text-STL lesen, gleiche Eckpunkte zusammenfassen (Nummern in der Reihenfolge des ersten Auftretens –
//! genau wie die Hash-Tabelle im Fenster sie vergibt), in Blickrichtung drehen, auf einer Höhe schneiden (Höhen-Index,
//! Kanten-Punkte, Ketten, undichte Enden zusammenführen, vereinfachen, Löcher erkennen und ausrichten) und die Höhe mit
//! dem größten Umriss suchen. Folgt dem TypeScript Zeile für Zeile; die Zahlen kommen ohne Winkelrechnung aus, der
//! Test vergleicht trotzdem auf 1e-9. Gemeinsame Fälle: `tests/fixtures/stlslice-cases.json.gz`
//! (festgehalten von `tests/stlSliceRust.test.ts`). Der Auftrag kommt aus stlBody() in stlMesh.ts.

use crate::gcodesim::{hypot2, mn, mx};
use crate::importdxf::parse_float;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const STITCH_TOL: f64 = 0.05;
const SIMPLIFY_TOL: f64 = 0.003;

#[derive(Deserialize, Debug, Clone)]
pub struct Head {
    pub source: String,
    pub view: String,
    pub height: f64,
}
pub struct Mesh {
    pub positions: Vec<f32>,
    pub min: [f64; 3],
    pub max: [f64; 3],
}
pub struct Welded {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub z: Vec<f64>,
    pub tris: Vec<u32>,
}
#[derive(Serialize, Clone, Copy, Debug)]
pub struct Pt {
    pub u: f64,
    pub v: f64,
}
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Loop {
    pub points: Vec<Pt>,
    pub closed: bool,
    pub is_hole: bool,
    pub area: f64,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Slice {
    pub height: f64,
    pub loops: Vec<Loop>,
    pub outer_count: usize,
    pub hole_count: usize,
    pub open_count: usize,
    pub min_u: f64,
    pub max_u: f64,
    pub min_v: f64,
    pub max_v: f64,
}
#[derive(Serialize, Debug)]
pub struct Output {
    pub triangles: usize,
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub vertices: usize,
    pub best: f64,
    pub slice: Slice,
}

/// Auftrag: 4 Bytes Länge, JSON, dann STL-Datei oder f32-Dreiecksliste
pub fn split_body(body: &[u8]) -> Result<(Head, &[u8]), String> {
    let n = u32::from_le_bytes(body.get(..4).ok_or("short body")?.try_into().map_err(|_| "short body")?) as usize;
    let head: Head = serde_json::from_slice(body.get(4..4 + n).ok_or("short body")?).map_err(|e| e.to_string())?;
    Ok((head, &body[4 + n..]))
}

pub fn run(head: &Head, data: &[u8]) -> Result<Output, String> {
    let mesh = if head.source == "stl" {
        read_stl(data)?
    } else {
        if data.len() % 4 != 0 {
            return Err("positions are not f32".into());
        }
        finish_mesh(data.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
    };
    let welded = weld_mesh(&mesh);
    let vc = view_coords(&welded, &head.view)?;
    let slab = slab_index(&welded, &vc);
    Ok(Output {
        triangles: mesh.positions.len() / 9,
        min: mesh.min,
        max: mesh.max,
        vertices: welded.x.len(),
        best: find_best_height(&welded, &vc, &slab, 40),
        slice: slice_mesh(&welded, &vc, &slab, head.height),
    })
}

// =====================================================================
// 1. STL EINLESEN
// =====================================================================

pub fn read_stl(b: &[u8]) -> Result<Mesh, String> {
    if b.len() < 15 {
        return Err("small".into());
    }
    let mut binary = false;
    if b.len() >= 84 {
        let count = u32::from_le_bytes([b[80], b[81], b[82], b[83]]) as u64;
        let expected = 84 + count * 50;
        if expected == b.len() as u64 {
            binary = true;
        } else if count > 0 && expected < b.len() as u64 && !starts_with_solid(b) {
            binary = true;
        }
    }
    let mesh = if binary { parse_binary(b) } else { parse_ascii(b) };
    if mesh.positions.len() < 9 {
        return Err("noTriangles".into());
    }
    Ok(mesh)
}

/// Kopf (300 Bytes, windows-1252) ohne führenden Leerraum, klein: beginnt mit „solid“ und enthält „facet“?
fn starts_with_solid(b: &[u8]) -> bool {
    let head = &b[..b.len().min(300)];
    let start = head.iter().position(|&c| !matches!(c, 9..=13 | 32 | 0xA0)).unwrap_or(head.len());
    let low: Vec<u8> = head[start..].iter().map(|c| c.to_ascii_lowercase()).collect();
    low.starts_with(b"solid") && low.windows(5).any(|w| w == b"facet")
}

fn parse_binary(b: &[u8]) -> Mesh {
    let declared = u32::from_le_bytes([b[80], b[81], b[82], b[83]]) as usize;
    let count = declared.min((b.len() - 84) / 50);
    let mut positions = Vec::with_capacity(count * 9);
    for i in 0..count {
        let off = 84 + i * 50 + 12;
        for k in 0..9 {
            let o = off + k * 4;
            positions.push(f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]));
        }
    }
    finish_mesh(positions)
}

/// `vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)` über den Text (UTF-8)
fn parse_ascii(b: &[u8]) -> Mesh {
    let text = String::from_utf8_lossy(b);
    let c: Vec<char> = text.chars().collect();
    let num = |ch: char| ch.is_ascii_digit() || matches!(ch, '-' | '+' | '.' | 'e' | 'E');
    let space = crate::gcodesim::js_space;
    let mut values: Vec<f64> = Vec::new();
    let mut i = 0;
    'scan: while i + 6 <= c.len() {
        if c[i..i + 6] != ['v', 'e', 'r', 't', 'e', 'x'] {
            i += 1;
            continue;
        }
        let mut j = i + 6;
        let mut got = [0.0f64; 3];
        for g in got.iter_mut() {
            let s = j;
            while j < c.len() && space(c[j]) {
                j += 1;
            }
            let n0 = j;
            while j < c.len() && num(c[j]) {
                j += 1;
            }
            if s == n0 || n0 == j {
                i += 1;
                continue 'scan;
            }
            *g = parse_float(&c[n0..j].iter().collect::<String>());
        }
        values.extend_from_slice(&got);
        i = j;
    }
    let usable = values.len() - values.len() % 9;
    finish_mesh(values[..usable].iter().map(|&v| v as f32).collect())
}

fn finish_mesh(positions: Vec<f32>) -> Mesh {
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    let mut i = 0;
    while i + 2 < positions.len() {
        for k in 0..3 {
            let v = positions[i + k] as f64;
            if v < lo[k] && v > f64::NEG_INFINITY {
                lo[k] = v;
            }
            if v > hi[k] && v < f64::INFINITY {
                hi[k] = v;
            }
        }
        i += 3;
    }
    Mesh { positions, min: lo, max: hi }
}

// =====================================================================
// 2. VERSCHWEISSEN: gleiche Float32-Bits = gleicher Punkt (-0 = 0)
// =====================================================================

pub fn weld_mesh(mesh: &Mesh) -> Welded {
    let p = &mesh.positions;
    let corners = p.len() / 9 * 3;
    let norm = |v: f32| {
        let b = v.to_bits();
        if b == 0x8000_0000 {
            0
        } else {
            b
        }
    };
    let mut ids: HashMap<(u32, u32, u32), u32> = HashMap::with_capacity(corners / 4 + 16);
    let (mut x, mut y, mut z) = (Vec::new(), Vec::new(), Vec::new());
    let mut tris = Vec::with_capacity(corners);
    for i in 0..corners {
        let key = (norm(p[i * 3]), norm(p[i * 3 + 1]), norm(p[i * 3 + 2]));
        let id = *ids.entry(key).or_insert_with(|| {
            // die Bits (bei -0 die von 0) zurück als Zahl
            x.push(f32::from_bits(key.0) as f64);
            y.push(f32::from_bits(key.1) as f64);
            z.push(f32::from_bits(key.2) as f64);
            (x.len() - 1) as u32
        });
        tris.push(id);
    }
    Welded { x, y, z, tris }
}

// =====================================================================
// 3. BLICKRICHTUNG
// =====================================================================

pub struct View {
    pub u: Vec<f64>,
    pub v: Vec<f64>,
    pub w: Vec<f64>,
    pub min_w: f64,
    pub max_w: f64,
}

pub fn view_coords(m: &Welded, view: &str) -> Result<View, String> {
    let n = m.x.len();
    let (mut u, mut v, mut w) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
    for i in 0..n {
        let (x, y, z) = (m.x[i], m.y[i], m.z[i]);
        let (a, b, c) = match view {
            "top" => (x, y, z),
            "bottom" => (-x, y, -z),
            "front" => (x, z, -y),
            "back" => (-x, z, y),
            "left" => (-y, z, -x),
            "right" => (y, z, x),
            _ => return Err(format!("unknown view {view}")),
        };
        u[i] = a;
        v[i] = b;
        w[i] = c;
    }
    let (mut min_w, mut max_w) = (f64::INFINITY, f64::NEG_INFINITY);
    for &x in &w {
        if x < min_w {
            min_w = x;
        }
        if x > max_w {
            max_w = x;
        }
    }
    Ok(View { u, v, w, min_w, max_w })
}

// =====================================================================
// 4. SCHNITT AUF EINER HÖHE
// =====================================================================

pub struct Slab {
    min_w: f64,
    bin_w: f64,
    bins: usize,
    start: Vec<u32>,
    list: Vec<u32>,
}

fn max3(a: f64, b: f64, c: f64) -> f64 {
    mx(mx(a, b), c)
}
fn min3(a: f64, b: f64, c: f64) -> f64 {
    mn(mn(a, b), c)
}

pub fn slab_index(m: &Welded, vc: &View) -> Slab {
    let (w, tris) = (&vc.w, &m.tris);
    let t_count = tris.len() / 3;
    let span = vc.max_w - vc.min_w;
    let mut ext = 0.0;
    for t in 0..t_count {
        let (wa, wb, wc) = (w[tris[t * 3] as usize], w[tris[t * 3 + 1] as usize], w[tris[t * 3 + 2] as usize]);
        ext += max3(wa, wb, wc) - min3(wa, wb, wc);
    }
    ext /= mx(1.0, t_count as f64);
    let by_ext = if ext > 0.0 { (span / (2.0 * ext)).floor() } else { 512.0 };
    let bins = mx(1.0, mn(mn(512.0, (t_count as f64 / 32.0).floor()), by_ext)) as usize;
    let bin_w = if span > 0.0 { span / bins as f64 } else { 1.0 };
    let bin = |x: f64| mx(0.0, mn((bins - 1) as f64, ((x - vc.min_w) / bin_w).floor())) as usize;
    let (mut lo, mut hi) = (vec![0usize; t_count], vec![0usize; t_count]);
    let mut count = vec![0u32; bins + 1];
    for t in 0..t_count {
        let (wa, wb, wc) = (w[tris[t * 3] as usize], w[tris[t * 3 + 1] as usize], w[tris[t * 3 + 2] as usize]);
        let (b0, b1) = (bin(min3(wa, wb, wc)), bin(max3(wa, wb, wc)));
        lo[t] = b0;
        hi[t] = b1;
        for b in b0..=b1 {
            count[b + 1] += 1;
        }
    }
    for b in 0..bins {
        count[b + 1] += count[b];
    }
    let start = count.clone();
    let mut fill = count[..bins].to_vec();
    let mut list = vec![0u32; start[bins] as usize];
    for t in 0..t_count {
        for b in lo[t]..=hi[t] {
            list[fill[b] as usize] = t as u32;
            fill[b] += 1;
        }
    }
    Slab { min_w: vc.min_w, bin_w, bins, start, list }
}

pub fn slice_mesh(m: &Welded, vc: &View, slab: &Slab, height: f64) -> Slice {
    let (u, v, w, tris) = (&vc.u, &vc.v, &vc.w, &m.tris);
    let sb = mx(0.0, mn((slab.bins - 1) as f64, ((height - slab.min_w) / slab.bin_w).floor())) as usize;
    // Kanten-Punkte: Nummer je Kante (a,b) in der Reihenfolge des ersten Auftretens
    let mut edge_ids: HashMap<(u32, u32), usize> = HashMap::new();
    let (mut pu, mut pv): (Vec<f64>, Vec<f64>) = (vec![], vec![]);
    let (mut seg_a, mut seg_b): (Vec<usize>, Vec<usize>) = (vec![], vec![]);
    let mut edge_point = |a: u32, b: u32| -> usize {
        let key = if a < b { (a, b) } else { (b, a) };
        *edge_ids.entry(key).or_insert_with(|| {
            let (a, b) = (a as usize, b as usize);
            let t = (height - w[a]) / (w[b] - w[a]);
            pu.push(u[a] + t * (u[b] - u[a]));
            pv.push(v[a] + t * (v[b] - v[a]));
            pu.len() - 1
        })
    };
    for k in slab.start[sb] as usize..slab.start[sb + 1] as usize {
        let t = slab.list[k] as usize;
        let (a, b, c) = (tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]);
        // Punkte genau auf der Ebene zählen als "oben"
        let (ua, ub, uc) = (w[a as usize] >= height, w[b as usize] >= height, w[c as usize] >= height);
        if ua == ub && ub == uc {
            continue;
        }
        let (lone, o1, o2) = if ua != ub && ua != uc {
            (a, b, c)
        } else if ub != ua && ub != uc {
            (b, c, a)
        } else {
            (c, a, b)
        };
        let p1 = edge_point(lone, o1);
        let p2 = edge_point(lone, o2);
        if p1 != p2 {
            seg_a.push(p1);
            seg_b.push(p2);
        }
    }
    // Segmente über gemeinsame Punkte verketten (Reihenfolge wie eingetragen)
    let mut at: Vec<Vec<usize>> = vec![vec![]; pu.len()];
    for s in 0..seg_a.len() {
        at[seg_a[s]].push(s);
        at[seg_b[s]].push(s);
    }
    let mut used = vec![false; seg_a.len()];
    let free_at = |used: &[bool], p: usize| at[p].iter().copied().find(|&s| !used[s]);
    let walk = |used: &mut Vec<bool>, start: usize, first: usize, ids: &mut Vec<usize>| -> usize {
        let (mut seg, mut cur) = (Some(first), start);
        while let Some(s) = seg {
            used[s] = true;
            let next = if seg_a[s] == cur { seg_b[s] } else { seg_a[s] };
            ids.push(next);
            cur = next;
            seg = free_at(used, cur);
        }
        cur
    };
    let mut chains: Vec<(Vec<usize>, bool)> = Vec::new();
    for s in 0..seg_a.len() {
        if used[s] {
            continue;
        }
        let mut ids = vec![seg_a[s]];
        let end = walk(&mut used, seg_a[s], s, &mut ids);
        if end == ids[0] && ids.len() > 3 {
            ids.pop();
            chains.push((ids, true));
        } else {
            let mut back = Vec::new();
            if let Some(other) = free_at(&used, ids[0]) {
                walk(&mut used, ids[0], other, &mut back);
            }
            back.reverse();
            back.extend(ids);
            chains.push((back, false));
        }
    }
    let loops: Vec<(Vec<Pt>, bool)> = chains.into_iter().map(|(ids, closed)| (ids.into_iter().map(|id| Pt { u: pu[id], v: pv[id] }).collect(), closed)).collect();
    let loops = stitch_open_chains(loops);
    let mut cleaned: Vec<Loop> = Vec::new();
    for (pts, closed) in loops {
        let pts = remove_duplicates(&pts, closed);
        let pts = if closed { simplify_closed(&pts, SIMPLIFY_TOL) } else { douglas_peucker(&pts, SIMPLIFY_TOL) };
        if closed && pts.len() < 3 || !closed && pts.len() < 2 {
            continue;
        }
        let area = if closed { signed_area(&pts) } else { 0.0 };
        if closed && area.abs() < 1e-4 {
            continue; // winzige Splitter
        }
        cleaned.push(Loop { points: pts, closed, is_hole: false, area });
    }
    classify_and_orient(&mut cleaned);
    let (mut min_u, mut max_u, mut min_v, mut max_v) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for l in &cleaned {
        for p in &l.points {
            if p.u < min_u {
                min_u = p.u;
            }
            if p.u > max_u {
                max_u = p.u;
            }
            if p.v < min_v {
                min_v = p.v;
            }
            if p.v > max_v {
                max_v = p.v;
            }
        }
    }
    Slice {
        height,
        outer_count: cleaned.iter().filter(|l| l.closed && !l.is_hole).count(),
        hole_count: cleaned.iter().filter(|l| l.closed && l.is_hole).count(),
        open_count: cleaned.iter().filter(|l| !l.closed).count(),
        loops: cleaned,
        min_u,
        max_u,
        min_v,
        max_v,
    }
}

/// Probiert viele Höhen durch und nimmt die mit der größten Außenfläche
pub fn find_best_height(m: &Welded, vc: &View, slab: &Slab, samples: usize) -> f64 {
    let span = vc.max_w - vc.min_w;
    if span <= 0.0 {
        return vc.min_w;
    }
    let (mut best, mut best_area) = (vc.min_w + span / 2.0, -1.0);
    for i in 0..samples {
        let h = vc.min_w + span * (i as f64 + 0.5) / samples as f64;
        let r = slice_mesh(m, vc, slab, h);
        let area: f64 = r.loops.iter().fold(0.0, |s, l| s + if l.closed && !l.is_hole { l.area.abs() } else { 0.0 });
        if area > best_area * 1.0001 {
            best_area = area;
            best = h;
        }
    }
    best
}

// =====================================================================
// HILFSFUNKTIONEN
// =====================================================================

fn d(a: Pt, b: Pt) -> f64 {
    hypot2(a.u - b.u, a.v - b.v)
}

fn stitch_open_chains(loops: Vec<(Vec<Pt>, bool)>) -> Vec<(Vec<Pt>, bool)> {
    let mut closed: Vec<(Vec<Pt>, bool)> = loops.iter().filter(|l| l.1).cloned().collect();
    let mut open: Vec<Vec<Pt>> = loops.into_iter().filter(|l| !l.1).map(|l| l.0).collect();
    let mut changed = true;
    while changed {
        changed = false;
        let mut i = 0;
        while i < open.len() && !changed {
            let a = &open[i];
            // Schließt sich die Kette selbst?
            if a.len() > 2 && d(a[0], a[a.len() - 1]) < STITCH_TOL {
                let mut a = open.remove(i);
                a.pop();
                closed.push((a, true));
                changed = true;
                break;
            }
            // Passt eine andere Kette an das Ende?
            let (mut best_j, mut best_rev, mut best_d) = (None, false, STITCH_TOL);
            let end = a[a.len() - 1];
            for (j, b) in open.iter().enumerate() {
                if j == i {
                    continue;
                }
                let (ds, de) = (d(end, b[0]), d(end, b[b.len() - 1]));
                if ds < best_d {
                    best_d = ds;
                    best_j = Some(j);
                    best_rev = false;
                }
                if de < best_d {
                    best_d = de;
                    best_j = Some(j);
                    best_rev = true;
                }
            }
            if let Some(j) = best_j {
                let mut b = open[j].clone();
                if best_rev {
                    b.reverse();
                }
                open[i].extend(b);
                open.remove(j);
                changed = true;
            }
            i += 1;
        }
    }
    closed.extend(open.into_iter().map(|p| (p, false)));
    closed
}

fn remove_duplicates(pts: &[Pt], closed: bool) -> Vec<Pt> {
    const EPS2: f64 = 1e-12;
    let mut out: Vec<Pt> = Vec::new();
    for &p in pts {
        match out.last() {
            Some(l) if (p.u - l.u).powi(2) + (p.v - l.v).powi(2) <= EPS2 => {}
            // NaN-Abstand: ">" ist falsch, also wie im TypeScript nicht übernehmen
            Some(l) if ((p.u - l.u).powi(2) + (p.v - l.v).powi(2)).is_nan() => {}
            _ => out.push(p),
        }
    }
    if closed && out.len() > 1 {
        let (f, l) = (out[0], out[out.len() - 1]);
        if (f.u - l.u).powi(2) + (f.v - l.v).powi(2) <= EPS2 {
            out.pop();
        }
    }
    out
}

fn perp_dist2(p: Pt, a: Pt, b: Pt) -> f64 {
    let (dx, dy) = (b.u - a.u, b.v - a.v);
    let len2 = dx * dx + dy * dy;
    if len2 == 0.0 {
        return (p.u - a.u).powi(2) + (p.v - a.v).powi(2);
    }
    let t = ((p.u - a.u) * dx + (p.v - a.v) * dy) / len2;
    let t = if t < 0.0 {
        0.0
    } else if t > 1.0 {
        1.0
    } else {
        t
    };
    let (ex, ey) = (p.u - (a.u + t * dx), p.v - (a.v + t * dy));
    ex * ex + ey * ey
}

fn douglas_peucker(pts: &[Pt], tol: f64) -> Vec<Pt> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let tol2 = tol * tol;
    let mut stack = vec![(0usize, pts.len() - 1)];
    while let Some((s, e)) = stack.pop() {
        let (mut max_d, mut idx) = (0.0, None);
        for i in s + 1..e {
            let dd = perp_dist2(pts[i], pts[s], pts[e]);
            if dd > max_d {
                max_d = dd;
                idx = Some(i);
            }
        }
        if let Some(i) = idx.filter(|_| max_d > tol2) {
            keep[i] = true;
            stack.push((s, i));
            stack.push((i, e));
        }
    }
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

fn simplify_closed(pts: &[Pt], tol: f64) -> Vec<Pt> {
    if pts.len() < 4 {
        return pts.to_vec();
    }
    let (mut far, mut far_d) = (0, -1.0);
    for i in 1..pts.len() {
        let dd = (pts[i].u - pts[0].u).powi(2) + (pts[i].v - pts[0].v).powi(2);
        if dd > far_d {
            far_d = dd;
            far = i;
        }
    }
    let a = douglas_peucker(&pts[..=far], tol);
    let mut tail = pts[far..].to_vec();
    tail.push(pts[0]);
    let b = douglas_peucker(&tail, tol);
    a[..a.len() - 1].iter().chain(&b[..b.len() - 1]).copied().collect()
}

fn signed_area(pts: &[Pt]) -> f64 {
    let mut a = 0.0;
    let mut j = pts.len() - 1;
    for i in 0..pts.len() {
        a += (pts[j].u * pts[i].v) - (pts[i].u * pts[j].v);
        j = i;
    }
    a / 2.0
}

fn point_in_polygon(px: f64, py: f64, poly: &[Pt]) -> bool {
    let mut inside = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let (xi, yi, xj, yj) = (poly[i].u, poly[i].v, poly[j].u, poly[j].v);
        if ((yi > py) != (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Loch oder Außenkontur (Anzahl umschließender Konturen ungerade = Loch), dann Außen gegen, Löcher mit dem Uhrzeigersinn
fn classify_and_orient(loops: &mut [Loop]) {
    let closed: Vec<usize> = (0..loops.len()).filter(|&i| loops[i].closed).collect();
    let boxes: Vec<[f64; 4]> = closed
        .iter()
        .map(|&i| {
            let (mut u0, mut u1, mut v0, mut v1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
            for p in &loops[i].points {
                if p.u < u0 {
                    u0 = p.u;
                }
                if p.u > u1 {
                    u1 = p.u;
                }
                if p.v < v0 {
                    v0 = p.v;
                }
                if p.v > v1 {
                    v1 = p.v;
                }
            }
            [u0, u1, v0, v1]
        })
        .collect();
    for li in 0..closed.len() {
        let l = closed[li];
        let probe = loops[l].points[0];
        let mut depth = 0;
        for oi in 0..closed.len() {
            let o = closed[oi];
            if o == l || loops[o].area.abs() < loops[l].area.abs() {
                continue;
            }
            let b = boxes[oi];
            if probe.u < b[0] || probe.u > b[1] || probe.v < b[2] || probe.v > b[3] {
                continue;
            }
            if point_in_polygon(probe.u, probe.v, &loops[o].points) {
                depth += 1;
            }
        }
        let lp = &mut loops[l];
        lp.is_hole = depth % 2 == 1;
        if (lp.area > 0.0) != !lp.is_hole {
            lp.points.reverse();
            lp.area = -lp.area;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Read;

    #[test]
    fn cube_cut_in_the_middle() {
        // Würfel 10 mm als Text-STL: 12 Dreiecke
        let v = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
        let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
        let mut s = String::from("solid c\n");
        for t in f {
            s += "facet normal 0 0 0\nouter loop\n";
            for k in t {
                s += &format!("vertex {} {} {}\n", v[k][0], v[k][1], v[k][2]);
            }
            s += "endloop\nendfacet\n";
        }
        let head = Head { source: "stl".into(), view: "top".into(), height: 5.0 };
        let o = run(&head, s.as_bytes()).unwrap();
        // 4 Ecken + der Startpunkt der Kette mitten auf einer Seite (bleibt beim Vereinfachen stehen, wie im Fenster)
        assert_eq!((o.triangles, o.vertices, o.slice.outer_count, o.slice.loops[0].points.len()), (12, 8, 1, 5));
        assert!((o.slice.loops[0].area - 100.0).abs() < 1e-9);
    }

    /// Dieselben Fälle wie tests/stlSliceRust.test.ts: Zahlen auf 1e-9 genau, alles andere exakt
    #[test]
    fn same_result_as_typescript() {
        fn same(a: &Value, b: &Value, at: &str) {
            match (a, b) {
                (Value::Number(x), Value::Number(y)) => {
                    let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
                    assert!(x == y || (x - y).abs() <= 1e-9, "{at}: {x} vs {y}");
                }
                (Value::Array(x), Value::Array(y)) => {
                    assert_eq!(x.len(), y.len(), "{at}: entries");
                    for (k, (p, q)) in x.iter().zip(y).enumerate() {
                        same(p, q, &format!("{at}[{k}]"));
                    }
                }
                (Value::Object(x), Value::Object(y)) => {
                    assert_eq!(x.len(), y.len(), "{at}: keys {:?} vs {:?}", x.keys().collect::<Vec<_>>(), y.keys().collect::<Vec<_>>());
                    for (k, v) in x {
                        same(v, y.get(k).unwrap_or(&Value::Null), &format!("{at}.{k}"));
                    }
                }
                _ => assert_eq!(a, b, "{at}"),
            }
        }
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("stlslice-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        let (files, cases) = (all["files"].as_array().unwrap(), all["cases"].as_array().unwrap());
        assert!(cases.len() >= 20, "only {} cases", cases.len());
        let mut loops = 0;
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let hex = files[c["file"].as_u64().unwrap() as usize].as_str().unwrap().as_bytes();
            let data: Vec<u8> = hex.chunks(2).map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap()).collect();
            let head: Head = serde_json::from_value(c["head"].clone()).unwrap();
            match run(&head, &data) {
                Ok(o) => {
                    let got = serde_json::to_value(&o).unwrap();
                    same(&c["want"], &got, name);
                    loops += o.slice.loops.len();
                }
                Err(e) => assert_eq!(c["want"]["error"].as_str(), Some(e.as_str()), "{name}"),
            }
        }
        println!("{} STL cases, {loops} loops the same as stlMesh.ts", cases.len());
    }
}
