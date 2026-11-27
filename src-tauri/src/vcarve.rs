//! V-CARVE und INLAY (Zwilling von src/vcarve.ts): Bahnen für den V-Stichel
//!
//! Der V-Stichel fährt Ringe im Abstand d vom Rand der Fläche ab. Je weiter der Ring vom Rand weg ist, desto tiefer:
//! Tiefe = (d − Spitzenradius) / tan(halber Spitzenwinkel). Ist die erlaubte Tiefe erreicht, bleibt der Boden flach.
//! Fläche = Inneres der geschlossenen Konturen nach der gerade/ungerade-Regel (Buchstaben mit Löchern, Inseln).
//!
//! Die Rechnung folgt dem TypeScript Schritt für Schritt. Geprüft mit denselben Fällen auf beiden Seiten:
//! tests/fixtures/vcarve-cases.json und vcarve-expected.json (tests/vcarveRust.test.ts und die Tests unten).
//! Wegen Sinus/Kosinus/Tangens (jsmath.rs) mit kleiner Toleranz: gleiche Bahnen, gleiche Punktzahl, Lage auf 1e-9 mm.
//!
//! Noch nicht gerufen: der Fräs-G-Code (cam.ts) entsteht im Fenster. Zieht er um, ruft er `vcarve_paths` direkt.
#![allow(dead_code)]

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath;
use crate::polyoffset::{offset_polygon, polygon_area, P};
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct VPath {
    pub pts: Vec<P>,
    pub closed: bool,
    /// Tiefe (negativ)
    pub z: f64,
}

#[derive(Clone, Debug)]
pub struct VOptions {
    /// Spitzenwinkel in Grad (z. B. 60, 90)
    pub angle: f64,
    /// Spitzen-Ø in mm
    pub tip_dia: f64,
    /// größter Schneiden-Ø – begrenzt die Tiefe (Kegelhöhe)
    pub tool_dia: f64,
    /// größte Tiefe ab Oberfläche (positiv); darunter flacher Boden
    pub max_depth: f64,
    /// Start-Tiefe (positiv): Stecker beim Inlay, sonst 0
    pub start: f64,
    /// Ring-Abstand (mm)
    pub step: f64,
    /// true = um die Form herum carven (Stecker), false = innen (Tasche / Schrift)
    pub outside: bool,
    /// nur outside: so weit (mm) ab der Kontur wird gecarvt
    pub outside_limit: Option<f64>,
}

/// Kante mit Kennung (Kontur, Nummer in der Kontur) – im TypeScript ist das „dasselbe Objekt“
#[derive(Clone, Copy)]
struct Seg {
    a: P,
    b: P,
    id: (usize, usize),
}

fn segs_of(loops: &[Vec<P>]) -> Vec<Seg> {
    let mut out = Vec::new();
    for (li, l) in loops.iter().enumerate() {
        for i in 0..l.len() {
            out.push(Seg { a: l[i], b: l[(i + 1) % l.len()], id: (li, i) });
        }
    }
    out
}

/// gerade/ungerade-Regel über alle Konturen
fn inside_all(x: f64, y: f64, loops: &[Vec<P>]) -> bool {
    let mut c = false;
    for l in loops {
        let n = l.len();
        let mut j = n.wrapping_sub(1);
        for i in 0..n {
            let (a, b) = (l[i], l[j]);
            if (a[1] > y) != (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0] {
                c = !c;
            }
            j = i;
        }
    }
    c
}

fn dist_seg(p: P, a: P, b: P) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l = dx * dx + dy * dy;
    let t = if l > 0.0 { mx(0.0, mn(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) } else { 0.0 };
    hypot2(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

/// Raster über die Kanten, damit Abstands- und Schnitt-Tests nicht jede Kante prüfen müssen
struct Grid {
    cell: f64,
    segs: Vec<Seg>,
    map: HashMap<(i64, i64), Vec<usize>>,
}

impl Grid {
    fn new(segs: Vec<Seg>, cell: f64) -> Self {
        let mut g = Grid { cell: mx(0.2, cell), segs, map: HashMap::new() };
        for k in 0..g.segs.len() {
            let s = g.segs[k];
            let mut keys = Vec::new();
            g.cells(s.a, s.b, 0.0, |key| keys.push(key));
            for key in keys {
                g.map.entry(key).or_default().push(k);
            }
        }
        g
    }
    fn cells(&self, a: P, b: P, pad: f64, mut each: impl FnMut((i64, i64))) {
        let c = self.cell;
        let (x0, x1) = (((mn(a[0], b[0]) - pad) / c).floor(), ((mx(a[0], b[0]) + pad) / c).floor());
        let (y0, y1) = (((mn(a[1], b[1]) - pad) / c).floor(), ((mx(a[1], b[1]) + pad) / c).floor());
        let mut x = x0;
        while x <= x1 {
            let mut y = y0;
            while y <= y1 {
                each((x as i64, y as i64));
                y += 1.0;
            }
            x += 1.0;
        }
    }
    /// Kanten in der Nähe, jede einmal, in der Reihenfolge des ersten Auftretens
    fn near(&self, a: P, b: P, pad: f64, seen: &mut [u32], tag: u32, out: &mut Vec<usize>) {
        out.clear();
        self.cells(a, b, pad, |key| {
            if let Some(l) = self.map.get(&key) {
                for &k in l {
                    if seen[k] != tag {
                        seen[k] = tag;
                        out.push(k);
                    }
                }
            }
        });
    }
}

fn cross_t(a: P, b: P, c: P, d: P) -> Option<f64> {
    let (rx, ry, sx, sy) = (b[0] - a[0], b[1] - a[1], d[0] - c[0], d[1] - c[1]);
    let den = rx * sy - ry * sx;
    if den.abs() < 1e-12 {
        return None;
    }
    let t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
    let u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
    if t > 1e-9 && t < 1.0 - 1e-9 && u >= 0.0 && u <= 1.0 {
        Some(t)
    } else {
        None
    }
}

struct Piece {
    pts: Vec<P>,
    closed: bool,
}

/// Ring an allen Kreuzungen mit anderen Ringen teilen und nur Stücke behalten, deren Mitte gültig ist
fn clip_ring(ring: &[P], ring_no: usize, others: &Grid, seen: &mut [u32], tag: &mut u32, keep: &dyn Fn(P) -> bool) -> Vec<Piece> {
    let n = ring.len();
    let mut pieces: Vec<Vec<P>> = Vec::new();
    let mut cur: Vec<P> = vec![ring[0]];
    let mut cut = false;
    let mut near: Vec<usize> = Vec::new();
    let mut ts: Vec<f64> = Vec::new();
    for i in 1..=n {
        let (a, b) = (ring[i - 1], ring[i % n]);
        ts.clear();
        *tag += 1;
        others.near(a, b, 0.0, seen, *tag, &mut near);
        for &k in &near {
            let s = others.segs[k];
            if s.id == (ring_no, i - 1) {
                continue; // die Kante selbst
            }
            if let Some(t) = cross_t(a, b, s.a, s.b) {
                ts.push(t);
            }
        }
        ts.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
        for &t in &ts {
            let q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            cur.push(q);
            pieces.push(std::mem::replace(&mut cur, vec![q]));
            cut = true;
        }
        cur.push(b);
    }
    pieces.push(cur);
    if !cut {
        let mid = [(ring[0][0] + ring[1][0]) / 2.0, (ring[0][1] + ring[1][1]) / 2.0];
        return if keep(mid) { vec![Piece { pts: ring.to_vec(), closed: true }] } else { vec![] };
    }
    // erstes und letztes Stück hängen am Startpunkt zusammen
    if pieces.len() > 1 {
        let mut last = pieces.pop().unwrap();
        last.extend_from_slice(&pieces[0][1..]);
        pieces[0] = last;
    }
    let mut out = Vec::new();
    for p in pieces {
        if p.len() < 2 {
            continue;
        }
        let k = (p.len() - 1) / 2;
        let mid = [(p[k][0] + p[k + 1][0]) / 2.0, (p[k][1] + p[k + 1][1]) / 2.0];
        if keep(mid) {
            out.push(Piece { pts: p, closed: false });
        }
    }
    out
}

/// Ringe einer Ebene zu wenigen langen Zügen verbinden (Enden, die sich berühren)
fn chain(pieces: Vec<Piece>) -> Vec<Piece> {
    let close = |a: P, b: P| hypot2(a[0] - b[0], a[1] - b[1]) < 1e-4;
    let mut open: Vec<Vec<P>> = Vec::new();
    let mut out: Vec<Piece> = Vec::new();
    for p in pieces {
        if p.closed {
            out.push(p);
        } else {
            open.push(p.pts);
        }
    }
    while let Some(mut cur) = open.pop() {
        let mut grew = true;
        while grew {
            grew = false;
            for i in 0..open.len() {
                let end = cur[cur.len() - 1];
                let q = &open[i];
                if close(end, q[0]) {
                    cur.extend_from_slice(&q[1..]);
                } else if close(end, q[q.len() - 1]) {
                    cur.extend(q[..q.len() - 1].iter().rev());
                } else {
                    continue;
                }
                open.remove(i);
                grew = true;
                break;
            }
        }
        let closed = cur.len() > 3 && close(cur[0], cur[cur.len() - 1]);
        if closed {
            cur.pop();
        }
        out.push(Piece { pts: cur, closed });
    }
    out
}

/// Bahnen für V-Carve bzw. Inlay-Stecker. loops = alle geschlossenen Konturen der Fläche (Löcher eingeschlossen).
/// Antwort: Bahnen mit ihrer Tiefe (z negativ), von außen (flach) nach innen (tief), und ob es einen flachen Boden gibt.
pub fn vcarve_paths(loops: &[Vec<P>], o: &VOptions) -> (Vec<VPath>, bool) {
    let pi = std::f64::consts::PI;
    let half = (mx(10.0, mn(170.0, o.angle)) / 2.0) * pi / 180.0;
    let tan = jsmath::tan(half);
    let tip_r = mx(0.0, o.tip_dia) / 2.0;
    let cone_h = mx(0.1, (mx(o.tool_dia, o.tip_dia + 0.1) / 2.0 - tip_r) / tan);
    let max_d = mn(o.max_depth, o.start + cone_h);
    let step = mx(0.03, o.step);
    let clean: Vec<Vec<P>> = loops.iter().filter(|l| l.len() >= 3 && polygon_area(l).abs() > 1e-6).cloned().collect();
    if clean.is_empty() {
        return (vec![], false);
    }
    let mut ext = 0.0f64;
    for l in &clean {
        for p in l {
            ext = mx(mx(ext, p[0].abs()), p[1].abs());
        }
    }
    let base_grid = Grid::new(segs_of(&clean), 2.0);
    let base_seen = std::cell::RefCell::new((vec![0u32; base_grid.segs.len()], 0u32, Vec::<usize>::new()));
    // kleinster Abstand zu allen Konturen (nur Kanten in der Nähe; weiter weg ist sicher > lim)
    let dist = |p: P, lim: f64| -> f64 {
        let mut st = base_seen.borrow_mut();
        let (seen, tag, near) = &mut *st;
        *tag += 1;
        base_grid.near(p, p, lim + 0.01, seen, *tag, near);
        let mut m = f64::INFINITY;
        for &k in near.iter() {
            m = mn(m, dist_seg(p, base_grid.segs[k].a, base_grid.segs[k].b));
        }
        m
    };
    let depth_at = |d: f64| o.start + mx(0.0, d - tip_r) / tan;
    // Abstand, ab dem die Tiefe begrenzt ist; danach flacher Boden (Tasche) bzw. Ende (Stecker)
    let d_flat = tip_r + mx(0.0, max_d - o.start) * tan;
    let floor_step = mx(step, 0.4 * tan);
    let mut paths: Vec<VPath> = Vec::new();
    let mut flat = false;
    let mut d = tip_r + step * 0.5;
    let d_end = if o.outside { mn(d_flat, o.outside_limit.unwrap_or(d_flat)) } else { f64::INFINITY };
    let mut guard = 0;
    while guard < 4000 && d <= d_end + 1e-9 {
        guard += 1;
        // Konturen in die Fläche hinein verschieben: Innen = mit der Orientierung, außen = dagegen
        let mut rings: Vec<Vec<P>> = Vec::new();
        for l in &clean {
            let ccw = polygon_area(l) > 0.0;
            // Liegt der Punkt gleich links neben der Kante in der Fläche? Dann zeigt „innen“ dorthin.
            let (a, b) = (l[0], l[1]);
            let mut len = hypot2(b[0] - a[0], b[1] - a[1]);
            if len == 0.0 || len.is_nan() {
                len = 1.0;
            }
            let probe = [(a[0] + b[0]) / 2.0 - ((b[1] - a[1]) / len) * 1e-3, (a[1] + b[1]) / 2.0 + ((b[0] - a[0]) / len) * 1e-3];
            let left_in = inside_all(probe[0], probe[1], &clean) != o.outside;
            // offset_polygon: d > 0 = nach außen (bezogen auf die Kontur selbst)
            let toward_left = if ccw { -d } else { d };
            rings.extend(offset_polygon(l, if left_in { toward_left } else { -toward_left }, 0.01));
        }
        if rings.is_empty() {
            break;
        }
        let ring_grid = Grid::new(segs_of(&rings), mx(0.5, d));
        let tol = mn(step * 0.3, 0.05);
        let keep = |p: P| inside_all(p[0], p[1], &clean) != o.outside && dist(p, d) >= d - tol;
        let mut seen = vec![0u32; ring_grid.segs.len()];
        let mut tag = 0u32;
        let mut clipped: Vec<Piece> = Vec::new();
        for (ri, r) in rings.iter().enumerate() {
            clipped.extend(clip_ring(r, ri, &ring_grid, &mut seen, &mut tag, &keep));
        }
        let kept = chain(clipped);
        if kept.is_empty() {
            break;
        }
        let depth = mn(max_d, depth_at(d));
        if depth >= max_d - 1e-6 && d > d_flat + 1e-6 {
            flat = true;
        }
        for k in kept {
            if k.pts.len() >= 2 {
                paths.push(VPath { pts: k.pts, closed: k.closed, z: -depth });
            }
        }
        d += if d >= d_flat { floor_step } else { step };
        if d > ext * 4.0 + 1000.0 {
            break;
        }
    }
    (paths, flat)
}

/// Konturen spiegeln (an der senkrechten Achse durch x0) – für den Inlay-Stecker
pub fn mirror_x(pts: &[P], x0: f64) -> Vec<P> {
    pts.iter().rev().map(|p| [2.0 * x0 - p[0], p[1]]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn opts() -> VOptions {
        VOptions { angle: 90.0, tip_dia: 0.0, tool_dia: 20.0, max_depth: 50.0, start: 0.0, step: 0.5, outside: false, outside_limit: None }
    }

    #[test]
    fn square_gets_deeper_towards_the_middle() {
        let sq = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let (paths, flat) = vcarve_paths(&[sq], &opts());
        assert!(!flat && paths.len() >= 8);
        // 90°: Tiefe = Abstand vom Rand; in der Mitte (5 mm vom Rand) knapp 5 mm
        let deepest = paths.iter().map(|p| p.z).fold(0.0, f64::min);
        assert!(deepest < -4.4 && deepest > -5.0, "{deepest}");
        for w in paths.windows(2) {
            assert!(w[1].z <= w[0].z + 1e-12, "from shallow to deep");
        }
        for p in &paths {
            assert!(p.closed && p.pts.len() == 4);
        }
    }

    #[test]
    fn depth_limit_gives_a_flat_floor() {
        let sq = vec![[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]];
        let (paths, flat) = vcarve_paths(&[sq], &VOptions { max_depth: 2.0, ..opts() });
        assert!(flat);
        assert!(paths.iter().all(|p| p.z >= -2.0 - 1e-9));
        assert!(paths.iter().filter(|p| (p.z + 2.0).abs() < 1e-9).count() > 3);
    }

    #[test]
    fn mirror_turns_the_direction() {
        assert_eq!(mirror_x(&[[1.0, 0.0], [3.0, 5.0]], 10.0), vec![[17.0, 5.0], [19.0, 0.0]]);
    }

    // ---- Vergleich mit dem TypeScript: dieselben Fälle ----

    fn fixture(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures").join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }
    fn base64(s: &str) -> Vec<u8> {
        let val = |c: u8| match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            _ => 63,
        } as u32;
        let mut out = Vec::with_capacity(s.len() / 4 * 3);
        for q in s.as_bytes().chunks(4) {
            let pad = q.iter().filter(|&&c| c == b'=').count();
            let n = q.iter().fold(0u32, |a, &c| (a << 6) | if c == b'=' { 0 } else { val(c) });
            out.extend_from_slice(&n.to_be_bytes()[1..4 - pad]);
        }
        out
    }

    #[test]
    fn same_result_as_typescript() {
        let cases: Value = serde_json::from_str(&fixture("vcarve-cases.json")).unwrap();
        let expected: Value = serde_json::from_str(&fixture("vcarve-expected.json")).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 20);
        let (mut numbers, mut exact, mut worst, mut total) = (0usize, 0usize, 0.0f64, 0usize);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let want = expected.get(name).unwrap_or_else(|| panic!("{name}: no expected result (run UPDATE_FIXTURES=1 npm test)"));
            let loops: Vec<Vec<P>> = c["loops"].as_array().unwrap().iter().map(|l| l.as_array().unwrap().iter().map(|p| [p[0].as_f64().unwrap(), p[1].as_f64().unwrap()]).collect()).collect();
            let o = &c["o"];
            let num = |k: &str| o[k].as_f64().unwrap();
            let opt = VOptions { angle: num("angle"), tip_dia: num("tipDia"), tool_dia: num("toolDia"), max_depth: num("maxDepth"), start: num("start"), step: num("step"), outside: o["outside"].as_bool().unwrap(), outside_limit: o["outsideLimit"].as_f64() };
            let (paths, flat) = vcarve_paths(&loops, &opt);
            assert_eq!(flat, want["flat"].as_bool().unwrap(), "{name}: flat floor");
            // je Bahn: Punktzahl, geschlossen (1/0)
            let shape: Vec<[u64; 2]> = serde_json::from_value(want["paths"].clone()).unwrap();
            assert_eq!(paths.iter().map(|p| [p.pts.len() as u64, p.closed as u64]).collect::<Vec<_>>(), shape, "{name}: paths, their point counts and closed/open");
            // Zahlen: je Bahn erst z, dann x, y aller Punkte
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut flate2::read::ZlibDecoder::new(&base64(want["data"].as_str().unwrap())[..]), &mut bytes).unwrap();
            let mut wanted = bytes.chunks(8).map(|q| f64::from_le_bytes(q.try_into().unwrap()));
            for (pi, p) in paths.iter().enumerate() {
                for v in std::iter::once(p.z).chain(p.pts.iter().flat_map(|q| [q[0], q[1]])) {
                    let w = wanted.next().unwrap();
                    numbers += 1;
                    exact += (v.to_bits() == w.to_bits()) as usize;
                    worst = worst.max((v - w).abs());
                    assert!((v - w).abs() <= 1e-9, "{name}: path {pi}: {v} != {w}");
                }
            }
            total += paths.len();
        }
        println!("{} cases, {total} paths, {numbers} numbers: {exact} identical to the last bit, largest difference {worst:e} mm", cases.len());
    }
}
