//! 3D-FRÄSEN aus einem STL-Modell (Schild mit Relief, Schale, Freiform)
//!
//!  1. STL lesen (binär oder Text) und aufs Bett legen: Lage, Größe, Modellhöhe – Oberkante = Z 0
//!  2. Raster über XY: jedes Feld kennt die Dreiecke darüber (schnelle Suche)
//!  3. Drop-Cutter: den Fräser über (x, y) von oben absenken, bis er das Modell berührt.
//!     Kugelfräser: Kugel gegen Fläche, Kante und Ecke · Schaftfräser: flache Scheibe.
//!     Andere Arten (Radius, V …) rechnen wie ein Schaftfräser: das lässt eher etwas stehen, fräst nie zu tief.
//!  4. Schruppen: Z-Schichten. In jeder Schicht darf der Fräser überall hin, wo die Drop-Cutter-Höhe
//!     (mit Aufmaß) unter der Schicht liegt. Diese Fläche wird in Ringen ausgeräumt (Abstandsfeld).
//!  5. Schlichten: Zeilen in X und/oder Y, Punkte auf geraden Stücken ausgedünnt.
//!
//! Alles auf allen Kernen (rayon), abbrechbar, mit Fortschritt. Ergebnis: Bahnen mit XYZ (der G-Code
//! entsteht im Frontend, src/cam3d.ts – dort sitzen Werkzeugwechsel, Drehzahl und Vorschub).

use rayon::prelude::*;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

pub type Tri = [[f64; 3]; 3];
type P2 = [f64; 2];
type P3 = [f64; 3];

const CANCELLED: &str = "cancelled";

// =====================================================================
// 1. STL EINLESEN
// =====================================================================

pub fn parse_stl(data: &[u8]) -> Result<Vec<Tri>, String> {
    if data.len() < 15 {
        return Err("STL file too small".into());
    }
    let mut binary = false;
    if data.len() >= 84 {
        let count = u32::from_le_bytes([data[80], data[81], data[82], data[83]]) as usize;
        let expected = count.saturating_mul(50).saturating_add(84);
        // exakt passende Größe = sicher binär (auch wenn der Kopf mit "solid" beginnt)
        if expected == data.len() || (count > 0 && expected < data.len() && !starts_with_solid(data)) {
            binary = true;
        }
    }
    let tris: Vec<Tri> = if binary { parse_binary(data) } else { parse_ascii(data) }
        .into_iter()
        .filter(|t| t.iter().all(|p| p.iter().all(|v| v.is_finite())))
        .collect();
    if tris.is_empty() {
        return Err("STL file has no triangles".into());
    }
    Ok(tris)
}

fn starts_with_solid(data: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&data[..data.len().min(300)]).to_ascii_lowercase();
    let head = head.trim_start();
    head.starts_with("solid") && head.contains("facet")
}

fn parse_binary(data: &[u8]) -> Vec<Tri> {
    let declared = u32::from_le_bytes([data[80], data[81], data[82], data[83]]) as usize;
    let count = declared.min((data.len() - 84) / 50);
    let f = |o: usize| f32::from_le_bytes([data[o], data[o + 1], data[o + 2], data[o + 3]]) as f64;
    (0..count)
        .map(|i| {
            // 12 Bytes Normale überspringen, dann 3 Eckpunkte à 3 Floats
            let o = 84 + i * 50 + 12;
            let v = |k: usize| [f(o + k * 12), f(o + k * 12 + 4), f(o + k * 12 + 8)];
            [v(0), v(1), v(2)]
        })
        .collect()
}

fn parse_ascii(data: &[u8]) -> Vec<Tri> {
    let text = String::from_utf8_lossy(data);
    let mut it = text.split_whitespace();
    let mut pts: Vec<P3> = Vec::new();
    while let Some(tok) = it.next() {
        if tok.eq_ignore_ascii_case("vertex") {
            let mut v = [0.0; 3];
            for c in v.iter_mut() {
                *c = it.next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(f64::NAN);
            }
            pts.push(v);
        }
    }
    pts.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect()
}

// =====================================================================
// 2. AUFS BETT LEGEN + SUCHRASTER
// =====================================================================

/// Lage auf dem Bett: linke untere Ecke (x0, y0), Größe in X/Y und Modellhöhe (alles mm).
/// Die Oberkante des Modells liegt auf Z 0 (= Material-Oberkante), der Boden auf -height.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub x0: f64,
    pub y0: f64,
    pub size_x: f64,
    pub size_y: f64,
    pub height: f64,
}

pub fn place(src: &[Tri], p: &Place) -> Vec<Tri> {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for t in src {
        for v in t {
            for a in 0..3 {
                lo[a] = lo[a].min(v[a]);
                hi[a] = hi[a].max(v[a]);
            }
        }
    }
    let k = |want: f64, a: usize| if hi[a] - lo[a] > 1e-9 { want / (hi[a] - lo[a]) } else { 1.0 };
    let (kx, ky, kz) = (k(p.size_x, 0), k(p.size_y, 1), k(p.height, 2));
    src.iter()
        .map(|t| t.map(|v| [(v[0] - lo[0]) * kx + p.x0, (v[1] - lo[1]) * ky + p.y0, (v[2] - hi[2]) * kz]))
        .collect()
}

struct Facet {
    p: Tri,
    /// Einheits-Normale, immer nach oben gedreht (nz ≥ 0)
    n: P3,
    lo: P2,
    hi: P2,
    zmax: f64,
}

/// Modell mit Suchraster. `floor` = Boden: dort, wo kein Dreieck ist, darf der Fräser bis hierhin.
pub struct Model {
    facets: Vec<Facet>,
    x0: f64,
    y0: f64,
    cell: f64,
    nx: usize,
    ny: usize,
    start: Vec<u32>,
    items: Vec<u32>,
    pub floor: f64,
}

#[derive(Clone, Copy, Debug)]
pub enum Cutter {
    Flat(f64),
    Ball(f64),
}

impl Cutter {
    pub fn r(self) -> f64 {
        match self {
            Cutter::Flat(r) | Cutter::Ball(r) => r,
        }
    }
    fn grown(self, a: f64) -> Cutter {
        match self {
            Cutter::Flat(r) => Cutter::Flat(r + a),
            Cutter::Ball(r) => Cutter::Ball(r + a),
        }
    }
}

/// Merkzettel je Rechen-Faden: welche Dreiecke bei dieser Abfrage schon geprüft wurden
pub struct Scratch {
    seen: Vec<u32>,
    stamp: u32,
}

impl Model {
    pub fn new(tris: Vec<Tri>, floor: f64) -> Model {
        let facets: Vec<Facet> = tris
            .into_iter()
            .map(|p| {
                let u = sub(p[1], p[0]);
                let v = sub(p[2], p[0]);
                let mut n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
                let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
                if l > 1e-300 {
                    n = [n[0] / l, n[1] / l, n[2] / l];
                }
                if n[2] < 0.0 {
                    n = [-n[0], -n[1], -n[2]];
                }
                let lo = [p[0][0].min(p[1][0]).min(p[2][0]), p[0][1].min(p[1][1]).min(p[2][1])];
                let hi = [p[0][0].max(p[1][0]).max(p[2][0]), p[0][1].max(p[1][1]).max(p[2][1])];
                Facet { p, n, lo, hi, zmax: p[0][2].max(p[1][2]).max(p[2][2]) }
            })
            .collect();
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for f in &facets {
            x0 = x0.min(f.lo[0]);
            y0 = y0.min(f.lo[1]);
            x1 = x1.max(f.hi[0]);
            y1 = y1.max(f.hi[1]);
        }
        if facets.is_empty() {
            (x0, y0, x1, y1) = (0.0, 0.0, 1.0, 1.0);
        }
        let area = ((x1 - x0) * (y1 - y0)).max(1e-6);
        // etwa 2 Dreiecke je Feld, höchstens 1 Mio. Felder
        let cell = (area / (facets.len().max(1) as f64 / 2.0)).sqrt().max((area / 1e6).sqrt()).max(0.05);
        let nx = ((x1 - x0) / cell).floor() as usize + 1;
        let ny = ((y1 - y0) / cell).floor() as usize + 1;
        let span = |f: &Facet| {
            let i0 = ((f.lo[0] - x0) / cell).floor().max(0.0) as usize;
            let i1 = (((f.hi[0] - x0) / cell).floor().max(0.0) as usize).min(nx - 1);
            let j0 = ((f.lo[1] - y0) / cell).floor().max(0.0) as usize;
            let j1 = (((f.hi[1] - y0) / cell).floor().max(0.0) as usize).min(ny - 1);
            (i0.min(nx - 1), i1, j0.min(ny - 1), j1)
        };
        let mut count = vec![0u32; nx * ny + 1];
        for f in &facets {
            let (i0, i1, j0, j1) = span(f);
            for j in j0..=j1 {
                for i in i0..=i1 {
                    count[j * nx + i + 1] += 1;
                }
            }
        }
        for k in 1..count.len() {
            count[k] += count[k - 1];
        }
        let start = count.clone();
        let mut items = vec![0u32; *count.last().unwrap() as usize];
        let mut fill = count;
        for (id, f) in facets.iter().enumerate() {
            let (i0, i1, j0, j1) = span(f);
            for j in j0..=j1 {
                for i in i0..=i1 {
                    let c = j * nx + i;
                    items[fill[c] as usize] = id as u32;
                    fill[c] += 1;
                }
            }
        }
        Model { facets, x0, y0, cell, nx, ny, start, items, floor }
    }

    pub fn scratch(&self) -> Scratch {
        Scratch { seen: vec![0; self.facets.len()], stamp: 0 }
    }

    /// Drop-Cutter: Höhe der Fräserspitze über (x, y), wenn der Fräser von oben das Modell berührt
    pub fn drop(&self, x: f64, y: f64, c: Cutter, s: &mut Scratch) -> f64 {
        let r = c.r();
        let mut best = self.floor;
        let fi = |v: f64, o: f64, n: usize| -> Option<usize> {
            let k = ((v - o) / self.cell).floor();
            if k < 0.0 {
                None
            } else {
                Some((k as usize).min(n - 1))
            }
        };
        // Bereich [x-r, x+r] × [y-r, y+r] im Suchraster
        let (Some(i1), Some(j1)) = (fi(x + r, self.x0, self.nx), fi(y + r, self.y0, self.ny)) else { return best };
        let i0 = fi(x - r, self.x0, self.nx).unwrap_or(0);
        let j0 = fi(y - r, self.y0, self.ny).unwrap_or(0);
        if i0 > i1 || j0 > j1 || x - r > self.x0 + self.nx as f64 * self.cell || y - r > self.y0 + self.ny as f64 * self.cell {
            return best;
        }
        s.stamp = s.stamp.wrapping_add(1);
        if s.stamp == 0 {
            s.seen.iter_mut().for_each(|v| *v = 0);
            s.stamp = 1;
        }
        for j in j0..=j1 {
            for i in i0..=i1 {
                let c0 = j * self.nx + i;
                for &id in &self.items[self.start[c0] as usize..self.start[c0 + 1] as usize] {
                    if s.seen[id as usize] == s.stamp {
                        continue;
                    }
                    s.seen[id as usize] = s.stamp;
                    let f = &self.facets[id as usize];
                    // Spitze liegt nie höher als der höchste Punkt des Dreiecks
                    if f.zmax <= best || f.lo[0] > x + r || f.hi[0] < x - r || f.lo[1] > y + r || f.hi[1] < y - r {
                        continue;
                    }
                    let h = match c {
                        Cutter::Flat(r) => flat_tri(f, x, y, r),
                        Cutter::Ball(r) => ball_tri(f, x, y, r),
                    };
                    if h > best {
                        best = h;
                    }
                }
            }
        }
        best
    }
}

fn sub(a: P3, b: P3) -> P3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// Liegt (x, y) im Dreieck (von oben gesehen)?
fn inside_xy(t: &Tri, x: f64, y: f64) -> bool {
    let d = |a: P3, b: P3| (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    let (d0, d1, d2) = (d(t[0], t[1]), d(t[1], t[2]), d(t[2], t[0]));
    let e = 1e-12;
    (d0 >= -e && d1 >= -e && d2 >= -e) || (d0 <= e && d1 <= e && d2 <= e)
}

fn plane_z(f: &Facet, x: f64, y: f64) -> f64 {
    let p = f.p[0];
    p[2] - (f.n[0] * (x - p[0]) + f.n[1] * (y - p[1])) / f.n[2]
}

/// Schaftfräser (flache Scheibe, Radius r) gegen ein Dreieck: Ecken, Fläche, Kanten
fn flat_tri(f: &Facet, cx: f64, cy: f64, r: f64) -> f64 {
    let mut best = f64::NEG_INFINITY;
    let r2 = r * r;
    for v in &f.p {
        if (v[0] - cx).powi(2) + (v[1] - cy).powi(2) <= r2 && v[2] > best {
            best = v[2];
        }
    }
    // Fläche: höchster Punkt der Scheibe auf der schrägen Ebene liegt am Rand, bergauf
    if f.n[2] > 1e-9 {
        let nxy = f.n[0].hypot(f.n[1]);
        let (px, py) = if nxy > 1e-12 { (cx - r * f.n[0] / nxy, cy - r * f.n[1] / nxy) } else { (cx, cy) };
        if inside_xy(&f.p, px, py) {
            best = best.max(plane_z(f, px, py));
        }
    }
    // Kanten: Stück der Kante innerhalb der Scheibe, höchstes Ende zählt
    for k in 0..3 {
        let (p, q) = (f.p[k], f.p[(k + 1) % 3]);
        let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
        let a = dx * dx + dy * dy;
        if a < 1e-18 {
            continue;
        }
        let (fx, fy) = (p[0] - cx, p[1] - cy);
        let b = 2.0 * (fx * dx + fy * dy);
        let c = fx * fx + fy * fy - r2;
        let disc = b * b - 4.0 * a * c;
        if disc < 0.0 {
            continue;
        }
        let sq = disc.sqrt();
        for t in [(-b - sq) / (2.0 * a), (-b + sq) / (2.0 * a)] {
            if (0.0..=1.0).contains(&t) {
                best = best.max(p[2] + t * (q[2] - p[2]));
            }
        }
    }
    best
}

/// Kugelfräser (Radius r) gegen ein Dreieck: Höhe der Spitze (Kugelmitte − r)
fn ball_tri(f: &Facet, cx: f64, cy: f64, r: f64) -> f64 {
    let mut best = f64::NEG_INFINITY;
    let r2 = r * r;
    // Ecken
    for v in &f.p {
        let d2 = (v[0] - cx).powi(2) + (v[1] - cy).powi(2);
        if d2 <= r2 {
            best = best.max(v[2] + (r2 - d2).sqrt() - r);
        }
    }
    // Fläche: Berührpunkt = Kugelmitte − r·n
    if f.n[2] > 1e-9 {
        let (px, py) = (cx - r * f.n[0], cy - r * f.n[1]);
        if inside_xy(&f.p, px, py) {
            best = best.max(plane_z(f, px, py) + r * f.n[2] - r);
        }
    }
    // Kanten: Schnitt der Kugel mit der senkrechten Ebene durch die Kante ist ein Kreis (Radius rr)
    for k in 0..3 {
        let (p, q) = (f.p[k], f.p[(k + 1) % 3]);
        let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
        let l = dx.hypot(dy);
        if l < 1e-9 {
            continue;
        }
        let (ux, uy) = (dx / l, dy / l);
        let (wx, wy) = (cx - p[0], cy - p[1]);
        let sc = wx * ux + wy * uy;
        let dp = wx * uy - wy * ux;
        if dp.abs() > r {
            continue;
        }
        let rr = (r2 - dp * dp).sqrt();
        let slope = (q[2] - p[2]) / l;
        let kk = (1.0 + slope * slope).sqrt();
        // Kreis liegt auf der Geraden z = p.z + slope·s; Berührpunkt muss auf der Kante liegen
        let st = sc + rr * slope / kk;
        if (0.0..=l).contains(&st) {
            best = best.max(p[2] + slope * sc + rr * kk - r);
        }
    }
    best
}

// =====================================================================
// 3. HILFEN: Höhenraster, Abstandsfeld, Konturen, Ausdünnen
// =====================================================================

/// Rasterpunkte (x0 + i·cell, y0 + j·cell); Rand (äußerster Ring) = gesperrt
struct Grid {
    x0: f64,
    y0: f64,
    cell: f64,
    nx: usize,
    ny: usize,
}

impl Grid {
    /// Raster über das Rechteck [bx0, bx1] × [by0, by1] mit einem gesperrten Ring außen herum
    fn over(b: [f64; 4], want: f64, max_cells: f64) -> Grid {
        let (w, h) = ((b[2] - b[0]).max(1e-6), (b[3] - b[1]).max(1e-6));
        let cell = want.max((w * h / max_cells).sqrt());
        let ix = (w / cell).ceil().max(1.0) as usize;
        let iy = (h / cell).ceil().max(1.0) as usize;
        // genau auf die Ränder des Rechtecks legen (Abstand leicht angepasst)
        let cell = (w / ix as f64).max(h / iy as f64);
        Grid { x0: b[0] - cell, y0: b[1] - cell, cell, nx: ix + 3, ny: iy + 3 }
    }
    fn xy(&self, i: usize, j: usize) -> P2 {
        [self.x0 + i as f64 * self.cell, self.y0 + j as f64 * self.cell]
    }
    fn border(&self, i: usize, j: usize) -> bool {
        i == 0 || j == 0 || i + 1 >= self.nx || j + 1 >= self.ny
    }
}

const BLOCKED: f64 = 1e9;

/// Drop-Cutter-Höhe an allen Rasterpunkten (parallel), Rand = gesperrt
fn height_field(m: &Model, g: &Grid, c: Cutter, add: f64, cancel: &AtomicBool, prog: &(dyn Fn(f64) + Sync)) -> Result<Vec<f64>, String> {
    let done = std::sync::atomic::AtomicUsize::new(0);
    let rows: Vec<Option<Vec<f64>>> = (0..g.ny)
        .into_par_iter()
        .map_init(
            || m.scratch(),
            |s, j| {
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
                let row = (0..g.nx)
                    .map(|i| {
                        if g.border(i, j) {
                            return BLOCKED;
                        }
                        let [x, y] = g.xy(i, j);
                        m.drop(x, y, c, s) + add
                    })
                    .collect();
                let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                if d % 16 == 0 {
                    prog(d as f64 / g.ny as f64);
                }
                Some(row)
            },
        )
        .collect();
    let mut out = Vec::with_capacity(g.nx * g.ny);
    for r in rows {
        out.extend(r.ok_or(CANCELLED)?);
    }
    Ok(out)
}

/// Euklidischer Abstand (in Rasterschritten) jedes Innen-Punktes zum nächsten Außen-Punkt (Felzenszwalb)
fn distance_field(inside: &[bool], nx: usize, ny: usize) -> Vec<f64> {
    const INF: f64 = 1e20;
    let mut d: Vec<f64> = inside.iter().map(|&b| if b { INF } else { 0.0 }).collect();
    let n = nx.max(ny);
    let (mut f, mut out, mut v, mut z) = (vec![0.0; n], vec![0.0; n], vec![0usize; n], vec![0.0; n + 1]);
    for i in 0..nx {
        for j in 0..ny {
            f[j] = d[j * nx + i];
        }
        edt_1d(&f[..ny], &mut out[..ny], &mut v, &mut z);
        for j in 0..ny {
            d[j * nx + i] = out[j];
        }
    }
    for j in 0..ny {
        f[..nx].copy_from_slice(&d[j * nx..(j + 1) * nx]);
        edt_1d(&f[..nx], &mut out[..nx], &mut v, &mut z);
        d[j * nx..(j + 1) * nx].copy_from_slice(&out[..nx]);
    }
    d.iter_mut().for_each(|x| *x = x.sqrt());
    d
}

fn edt_1d(f: &[f64], d: &mut [f64], v: &mut [usize], z: &mut [f64]) {
    let n = f.len();
    let mut k = 0usize;
    v[0] = 0;
    z[0] = f64::NEG_INFINITY;
    z[1] = f64::INFINITY;
    for q in 1..n {
        loop {
            let p = v[k];
            let s = ((f[q] + (q * q) as f64) - (f[p] + (p * p) as f64)) / (2.0 * (q as f64 - p as f64));
            if s <= z[k] && k > 0 {
                k -= 1;
                continue;
            }
            if s <= z[k] {
                // k == 0: ersetzen
                v[0] = q;
                z[0] = f64::NEG_INFINITY;
                z[1] = f64::INFINITY;
            } else {
                k += 1;
                v[k] = q;
                z[k] = s;
                z[k + 1] = f64::INFINITY;
            }
            break;
        }
    }
    k = 0;
    for q in 0..n {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let p = v[k];
        d[q] = (q as f64 - p as f64).powi(2) + f[p];
    }
}

/// Linien gleicher Höhe (Marching Squares): geschlossene Ringe, wo das Feld `level` kreuzt.
/// `refine(a, b)`: optional genauer Kreuzungspunkt zwischen zwei Rasterpunkten (Anteil 0…1).
fn contours(field: &[f64], g: &Grid, level: f64, refine: &mut dyn FnMut(P2, P2, f64) -> f64) -> Vec<Vec<P2>> {
    let (nx, ny) = (g.nx, g.ny);
    let ins = |i: usize, j: usize| field[j * nx + i] > level;
    // Kante: waagerecht (i,j)-(i+1,j) = 2·id, senkrecht (i,j)-(i,j+1) = 2·id+1
    let h = |i: usize, j: usize| ((j * nx + i) * 2) as u64;
    let vk = |i: usize, j: usize| ((j * nx + i) * 2 + 1) as u64;
    let mut segs: Vec<(u64, u64)> = Vec::new();
    for j in 0..ny - 1 {
        for i in 0..nx - 1 {
            let (b0, b1, b2, b3) = (ins(i, j), ins(i + 1, j), ins(i + 1, j + 1), ins(i, j + 1));
            let case = b0 as u8 | (b1 as u8) << 1 | (b2 as u8) << 2 | (b3 as u8) << 3;
            let (e0, e1, e2, e3) = (h(i, j), vk(i + 1, j), h(i, j + 1), vk(i, j));
            let center = || {
                (field[j * nx + i] + field[j * nx + i + 1] + field[(j + 1) * nx + i + 1] + field[(j + 1) * nx + i]) / 4.0 > level
            };
            match case {
                1 | 14 => segs.push((e3, e0)),
                2 | 13 => segs.push((e0, e1)),
                3 | 12 => segs.push((e3, e1)),
                4 | 11 => segs.push((e1, e2)),
                6 | 9 => segs.push((e0, e2)),
                7 | 8 => segs.push((e3, e2)),
                5 => {
                    if center() {
                        segs.push((e0, e1));
                        segs.push((e2, e3));
                    } else {
                        segs.push((e3, e0));
                        segs.push((e1, e2));
                    }
                }
                10 => {
                    if center() {
                        segs.push((e3, e0));
                        segs.push((e1, e2));
                    } else {
                        segs.push((e0, e1));
                        segs.push((e2, e3));
                    }
                }
                _ => {}
            }
        }
    }
    // Punkt auf einer Kante
    let mut point = |key: u64| -> P2 {
        let id = (key / 2) as usize;
        let (i, j) = (id % nx, id / nx);
        let (i2, j2) = if key % 2 == 0 { (i + 1, j) } else { (i, j + 1) };
        let (fa, fb) = (field[j * nx + i], field[j2 * nx + i2]);
        let mut t = if (fb - fa).abs() > 1e-300 { ((level - fa) / (fb - fa)).clamp(0.0, 1.0) } else { 0.5 };
        let (a, b) = (g.xy(i, j), g.xy(i2, j2));
        t = refine(a, b, t);
        [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    };
    // Stücke zu Ringen verketten (jede Kante gehört zu genau zwei Stücken)
    let mut at: HashMap<u64, [usize; 2]> = HashMap::with_capacity(segs.len() * 2);
    for (k, &(a, b)) in segs.iter().enumerate() {
        for key in [a, b] {
            at.entry(key).and_modify(|e| e[1] = k).or_insert([k, usize::MAX]);
        }
    }
    let mut used = vec![false; segs.len()];
    let mut loops = Vec::new();
    let mut cache: HashMap<u64, P2> = HashMap::new();
    for s0 in 0..segs.len() {
        if used[s0] {
            continue;
        }
        used[s0] = true;
        let first = segs[s0].0;
        let mut keys = vec![first];
        let mut key = segs[s0].1;
        let mut cur = s0;
        while key != first {
            keys.push(key);
            let e = at[&key];
            let next = if e[0] == cur { e[1] } else { e[0] };
            if next == usize::MAX || used[next] {
                break;
            }
            used[next] = true;
            key = if segs[next].0 == key { segs[next].1 } else { segs[next].0 };
            cur = next;
        }
        if keys.len() >= 3 {
            loops.push(keys.iter().map(|&k| *cache.entry(k).or_insert_with(|| point(k))).collect());
        }
    }
    loops
}

/// Wert des Feldes an (x, y), bilinear zwischen den Rasterpunkten
fn sample(field: &[f64], g: &Grid, x: f64, y: f64) -> f64 {
    let fx = ((x - g.x0) / g.cell).clamp(0.0, (g.nx - 1) as f64 - 1e-9);
    let fy = ((y - g.y0) / g.cell).clamp(0.0, (g.ny - 1) as f64 - 1e-9);
    let (i, j) = (fx.floor() as usize, fy.floor() as usize);
    let (u, v) = (fx - i as f64, fy - j as f64);
    let f = |a: usize, b: usize| field[(j + b) * g.nx + i + a];
    f(0, 0) * (1.0 - u) * (1.0 - v) + f(1, 0) * u * (1.0 - v) + f(1, 1) * u * v + f(0, 1) * (1.0 - u) * v
}

/// Ring so drehen, dass die freie Fläche rechts liegt (Gleichlauf bei rechtsdrehender Spindel)
fn orient(lp: &mut [P2], field: &[f64], g: &Grid) {
    if lp.len() < 2 {
        return;
    }
    // längstes Stück nehmen (sicherer als ein winziges)
    let (mut k, mut best) = (0, 0.0);
    for i in 0..lp.len() {
        let (a, b) = (lp[i], lp[(i + 1) % lp.len()]);
        let l = (b[0] - a[0]).hypot(b[1] - a[1]);
        if l > best {
            best = l;
            k = i;
        }
    }
    let (a, b) = (lp[k], lp[(k + 1) % lp.len()]);
    if best < 1e-12 {
        return;
    }
    let (mx, my) = ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0);
    let e = g.cell * 0.35;
    let (nx, ny) = (-(b[1] - a[1]) / best * e, (b[0] - a[0]) / best * e);
    let left = sample(field, g, mx + nx, my + ny) - sample(field, g, mx - nx, my - ny);
    if left > 0.0 {
        lp.reverse();
    }
}

fn seg_dist2(p: &[f64], a: &[f64], b: &[f64]) -> f64 {
    let n = p.len();
    let (mut ab2, mut t) = (0.0, 0.0);
    for k in 0..n {
        ab2 += (b[k] - a[k]).powi(2);
        t += (p[k] - a[k]) * (b[k] - a[k]);
    }
    let t = if ab2 > 1e-300 { (t / ab2).clamp(0.0, 1.0) } else { 0.0 };
    (0..n).map(|k| (p[k] - a[k] - t * (b[k] - a[k])).powi(2)).sum()
}

/// Punkte auf fast geraden Stücken weglassen (Douglas-Peucker), Abweichung höchstens `tol`
fn thin<const N: usize>(pts: &[[f64; N]], tol: f64) -> Vec<[f64; N]> {
    if pts.len() <= 2 {
        return pts.to_vec();
    }
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let mut stack = vec![(0usize, pts.len() - 1)];
    let tol2 = tol * tol;
    while let Some((a, b)) = stack.pop() {
        let (mut idx, mut dmax) = (0, tol2);
        for i in a + 1..b {
            let d = seg_dist2(&pts[i], &pts[a], &pts[b]);
            if d > dmax {
                dmax = d;
                idx = i;
            }
        }
        if idx > 0 {
            keep[idx] = true;
            stack.push((a, idx));
            stack.push((idx, b));
        }
    }
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

// =====================================================================
// 4. AUFTRAG: Schruppen + Schlichten
// =====================================================================

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolOp {
    /// true = Kugelfräser, sonst wie ein Schaftfräser gerechnet
    pub ball: bool,
    pub diameter: f64,
    /// Zustellung (Schruppen; beim Schlichten ohne Schruppen: Schichten von oben)
    pub step_down: f64,
    /// seitlicher Bahnabstand
    pub step_over: f64,
    /// Aufmaß (nur Schruppen)
    #[serde(default)]
    pub allowance: f64,
    /// "x", "y" oder "xy" (nur Schlichten)
    #[serde(default)]
    pub dir: String,
    /// Toleranz beim Ausdünnen (mm)
    #[serde(default)]
    pub tolerance: f64,
}

impl ToolOp {
    fn cutter(&self) -> Cutter {
        let r = (self.diameter / 2.0).max(0.01);
        if self.ball {
            Cutter::Ball(r)
        } else {
            Cutter::Flat(r)
        }
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub place: Place,
    /// Außenkante freifräsen: der Fräser darf eine Fräserbreite um das Modell herum fahren
    pub margin: bool,
    pub rough: Option<ToolOp>,
    pub finish: Option<ToolOp>,
}

/// Eine zusammenhängende Bahn im Vorschub. kind 0 = Schruppen, 1 = Schlichten.
/// top: bis zu dieser Höhe kann über dem Startpunkt noch Material stehen (Eintauchen von dort aus).
#[derive(Debug, Clone)]
pub struct Path {
    pub kind: u32,
    pub layer: u32,
    pub top: f64,
    pub pts: Vec<P3>,
}

pub type Progress<'a> = &'a (dyn Fn(f64, &str) + Sync);

pub fn compute(src: &[Tri], job: &Job, cancel: &AtomicBool, prog: Progress) -> Result<Vec<Path>, String> {
    let p = &job.place;
    for v in [p.size_x, p.size_y, p.height] {
        if !(v.is_finite() && v > 0.0) {
            return Err("invalid model size".into());
        }
    }
    let model = Model::new(place(src, p), -p.height);
    let bounds = [p.x0, p.y0, p.x0 + p.size_x, p.y0 + p.size_y];
    let mut out = Vec::new();
    let both = job.rough.is_some() && job.finish.is_some();
    if let Some(r) = &job.rough {
        let w = if both { 0.6 } else { 1.0 };
        out.extend(rough(&model, bounds, job.margin, r, cancel, &|f, s| prog(f * w, s))?);
    }
    if let Some(f) = &job.finish {
        let w0 = if both { 0.6 } else { 0.0 };
        out.extend(finish(&model, bounds, job.margin, f, job.rough.as_ref(), cancel, &|x, s| prog(w0 + x * (1.0 - w0), s))?);
    }
    prog(1.0, "done");
    Ok(out)
}

fn expand(b: [f64; 4], m: f64) -> [f64; 4] {
    [b[0] - m, b[1] - m, b[2] + m, b[3] + m]
}

fn check(op: &ToolOp) -> Result<(), String> {
    for v in [op.diameter, op.step_over] {
        if !(v.is_finite() && v > 0.0) {
            return Err("invalid tool settings".into());
        }
    }
    Ok(())
}

/// Schrupp-Schichten von oben nach unten bis zum Boden (+ Aufmaß)
fn layers(step: f64, bottom: f64) -> Vec<f64> {
    let mut zs = Vec::new();
    if bottom >= -1e-6 {
        return zs;
    }
    let step = step.max(0.05);
    let mut z = -step;
    while z > bottom + 1e-6 {
        zs.push(z);
        z -= step;
    }
    zs.push(bottom);
    zs
}

/// SCHRUPPEN: je Schicht die erlaubte Fläche (Drop-Cutter mit Aufmaß ≤ Schicht) in Ringen ausräumen
pub fn rough(m: &Model, bounds: [f64; 4], margin: bool, op: &ToolOp, cancel: &AtomicBool, prog: Progress) -> Result<Vec<Path>, String> {
    check(op)?;
    if !(op.step_down.is_finite() && op.step_down > 0.0) {
        return Err("invalid step down".into());
    }
    let c = op.cutter();
    let r = c.r();
    let a = op.allowance.max(0.0);
    // Abstand der Ringe: höchstens 0,9 × Radius, sonst bleiben zwischen den Ringen Reste stehen
    let s = op.step_over.min(0.9 * r).max(0.01);
    let b = if margin { expand(bounds, r) } else { bounds };
    let g = Grid::over(b, (s / 4.0).min(r / 4.0).max(0.05), 3e6);
    // Aufmaß rundherum: Fräser um a dicker und a höher
    let cg = c.grown(a);
    let d = height_field(m, &g, cg, a, cancel, &|f| prog(f * 0.5, "rough"))?;
    let zs = layers(op.step_down, m.floor + a);
    let mut sc = m.scratch();
    let mut out = Vec::new();
    for (k, &z) in zs.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        prog(0.5 + 0.5 * k as f64 / zs.len() as f64, "rough");
        // (kleine Zugabe: eine Fläche genau auf Schichthöhe gehört noch dazu)
        let f0: Vec<f64> = d.iter().map(|&h| z + 1e-6 - h).collect();
        let inside: Vec<bool> = f0.iter().map(|&v| v > 0.0).collect();
        if !inside.iter().any(|&b| b) {
            continue;
        }
        // Rand der Fläche genau: Kreuzung mit dem echten Drop-Cutter nachrechnen (Halbierung)
        let mut refine = |pa: P2, pb: P2, t: f64| -> f64 {
            let ok = |u: f64, sc: &mut Scratch| m.drop(pa[0] + (pb[0] - pa[0]) * u, pa[1] + (pb[1] - pa[1]) * u, cg, sc) + a <= z + 1e-6;
            let (mut lo, mut hi) = (0.0, 1.0);
            let a_in = ok(0.0, &mut sc);
            if a_in == ok(1.0, &mut sc) {
                return t;
            }
            for _ in 0..8 {
                let mid = (lo + hi) / 2.0;
                if ok(mid, &mut sc) == a_in {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            if a_in {
                lo
            } else {
                hi
            }
        };
        let mut rings: Vec<Vec<P2>> = Vec::new();
        for mut lp in contours(&f0, &g, 0.0, &mut refine) {
            orient(&mut lp, &f0, &g);
            rings.push(lp);
        }
        // weitere Ringe nach innen im Abstand s
        let dist: Vec<f64> = distance_field(&inside, g.nx, g.ny).iter().map(|v| v * g.cell).collect();
        let dmax = dist.iter().cloned().fold(0.0, f64::max);
        let mut lvl = s + 0.5 * g.cell;
        while lvl < dmax {
            for mut lp in contours(&dist, &g, lvl, &mut |_, _, t| t) {
                orient(&mut lp, &dist, &g);
                rings.push(lp);
            }
            lvl += s;
        }
        let rings: Vec<Vec<P2>> = rings
            .into_iter()
            .map(|mut lp| {
                lp.push(lp[0]);
                let mut t = thin(&lp, (g.cell * 0.2).min(0.02));
                t.pop();
                t
            })
            .filter(|lp| lp.len() >= 2)
            .collect();
        let top = if k == 0 { 0.0 } else { zs[k - 1] };
        out.extend(link(rings, &d, &g, z, top, k as u32));
    }
    Ok(out)
}

/// Ringe der Reihe nach verbinden: immer den nächstgelegenen; im Material bleiben, wo die gerade
/// Verbindung frei ist (alle umliegenden Rasterpunkte erlaubt), sonst neue Bahn (= hochfahren)
fn link(rings: Vec<Vec<P2>>, d: &[f64], g: &Grid, z: f64, top: f64, layer: u32) -> Vec<Path> {
    let free = |x: f64, y: f64| -> bool {
        let i = ((x - g.x0) / g.cell).floor();
        let j = ((y - g.y0) / g.cell).floor();
        if i < 0.0 || j < 0.0 || i as usize + 1 >= g.nx || j as usize + 1 >= g.ny {
            return false;
        }
        let (i, j) = (i as usize, j as usize);
        [(0, 0), (1, 0), (0, 1), (1, 1)].iter().all(|&(a, b)| d[(j + b) * g.nx + i + a] <= z + 1e-9)
    };
    let safe = |p: P2, q: P2| -> bool {
        let l = (q[0] - p[0]).hypot(q[1] - p[1]);
        let n = (l / (g.cell * 0.5)).ceil().max(1.0) as usize;
        (1..n).all(|k| {
            let t = k as f64 / n as f64;
            free(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)
        })
    };
    let mut used = vec![false; rings.len()];
    let mut out = Vec::new();
    let mut path: Vec<P3> = Vec::new();
    let mut cur: Option<P2> = None;
    for _ in 0..rings.len() {
        let (mut bi, mut bv, mut bd) = (usize::MAX, 0, f64::INFINITY);
        for (i, lp) in rings.iter().enumerate() {
            if used[i] {
                continue;
            }
            match cur {
                None => {
                    bi = i;
                    break;
                }
                Some(c) => {
                    for (v, p) in lp.iter().enumerate() {
                        let dd = (p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2);
                        if dd < bd {
                            bd = dd;
                            bi = i;
                            bv = v;
                        }
                    }
                }
            }
        }
        if bi == usize::MAX {
            break;
        }
        used[bi] = true;
        let lp = &rings[bi];
        let start = lp[bv];
        let joined = matches!(cur, Some(c) if safe(c, start));
        if !joined && !path.is_empty() {
            out.push(Path { kind: 0, layer, top, pts: std::mem::take(&mut path) });
        }
        for k in 0..=lp.len() {
            let p = lp[(bv + k) % lp.len()];
            path.push([p[0], p[1], z]);
        }
        cur = Some(start);
    }
    if !path.is_empty() {
        out.push(Path { kind: 0, layer, top, pts: path });
    }
    out
}

/// SCHLICHTEN: Zeilen über das Modell, Fräser folgt der Oberfläche (Drop-Cutter).
/// Ohne Schruppen in Schichten (Zustellung) von oben, damit der Fräser nie die volle Tiefe auf einmal nimmt.
pub fn finish(m: &Model, bounds: [f64; 4], margin: bool, op: &ToolOp, rough: Option<&ToolOp>, cancel: &AtomicBool, prog: Progress) -> Result<Vec<Path>, String> {
    check(op)?;
    let c = op.cutter();
    let r = c.r();
    let b = if margin { expand(bounds, r) } else { bounds };
    let s = op.step_over.max(0.01);
    let tol = if op.tolerance > 0.0 { op.tolerance.clamp(0.001, 1.0) } else { 0.01 };
    let sample = (r / 5.0).clamp(0.05, 0.5).min(s.max(0.05));
    let dirs: &[usize] = match op.dir.as_str() {
        "y" => &[1],
        "xy" => &[0, 1],
        _ => &[0],
    };
    let mut lines_all: Vec<(usize, Vec<Vec<P3>>)> = Vec::new();
    // Anzahl Zeilen insgesamt (für den Fortschritt)
    let total: f64 = dirs.iter().map(|&a| (if a == 0 { b[3] - b[1] } else { b[2] - b[0] } / s).ceil() + 1.0).sum::<f64>().max(1.0);
    let done = std::sync::atomic::AtomicUsize::new(0);
    for (pass, &axis) in dirs.iter().enumerate() {
        // axis 0: Zeilen entlang X (y fest), axis 1: entlang Y
        let (a0, a1, c0, c1) = if axis == 0 { (b[0], b[2], b[1], b[3]) } else { (b[1], b[3], b[0], b[2]) };
        let nl = ((c1 - c0) / s).ceil().max(0.0) as usize + 1;
        let sl = if nl > 1 { (c1 - c0) / (nl - 1) as f64 } else { 0.0 };
        let ns = ((a1 - a0) / sample).ceil().max(1.0) as usize + 1;
        let sa = (a1 - a0) / (ns - 1) as f64;
        let at = |u: f64, v: f64| if axis == 0 { (u, v) } else { (v, u) };
        let rows: Vec<Option<Vec<P3>>> = (0..nl)
            .into_par_iter()
            .map_init(
                || m.scratch(),
                |sc, k| {
                    if cancel.load(Ordering::Relaxed) {
                        return None;
                    }
                    let v = c0 + k as f64 * sl;
                    let mut row: Vec<P3> = (0..ns)
                        .map(|i| {
                            let (x, y) = at(a0 + i as f64 * sa, v);
                            [x, y, m.drop(x, y, c, sc)]
                        })
                        .collect();
                    // Zickzack: jede zweite Zeile rückwärts
                    if k % 2 == 1 {
                        row.reverse();
                    }
                    // Übergang zur nächsten Zeile (quer, ebenfalls auf der Oberfläche)
                    if k + 1 < nl {
                        let u = if k % 2 == 0 { a1 } else { a0 };
                        let nlk = (sl / sample).ceil().max(1.0) as usize;
                        for q in 1..nlk {
                            let (x, y) = at(u, v + sl * q as f64 / nlk as f64);
                            row.push([x, y, m.drop(x, y, c, sc)]);
                        }
                    }
                    let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if d % 8 == 0 {
                        prog(d as f64 / total, "finish");
                    }
                    Some(row)
                },
            )
            .collect();
        let mut lines = Vec::with_capacity(rows.len());
        for r in rows {
            lines.push(r.ok_or(CANCELLED)?);
        }
        lines_all.push((pass, lines));
    }
    let mut out = Vec::new();
    // Nach dem Schruppen steht über (x, y) noch Material bis zur tiefsten Schicht, in der der Schrupp-Fräser
    // dort hin durfte (gleiche Rechnung wie beim Schruppen); kam er nie hin: bis zur Oberkante
    let mut sc = m.scratch();
    let mut rough_top = |x: f64, y: f64| -> Option<f64> {
        let ro = rough?;
        let a = ro.allowance.max(0.0);
        let d = m.drop(x, y, ro.cutter().grown(a), &mut sc) + a;
        Some(layers(ro.step_down, m.floor + a).into_iter().filter(|&z| z >= d - 1e-6).fold(0.0, f64::min))
    };
    for (pass, lines) in lines_all {
        let full: Vec<P3> = lines.into_iter().flatten().collect();
        if full.is_empty() {
            continue;
        }
        let zmin = full.iter().map(|p| p[2]).fold(f64::INFINITY, f64::min);
        // Schichten: mit Schruppen nur eine (die Fläche), sonst von oben in Zustellungen
        let levels: Vec<f64> = match rough {
            Some(_) => vec![f64::NEG_INFINITY],
            None if op.step_down > 0.0 => {
                let mut v = layers(op.step_down, zmin);
                if let Some(l) = v.last_mut() {
                    *l = f64::NEG_INFINITY;
                }
                v
            }
            None => vec![f64::NEG_INFINITY],
        };
        let mut prev_level = 0.0;
        for (li, &lv) in levels.iter().enumerate() {
            let pts: Vec<P3> = full.iter().map(|p| [p[0], p[1], p[2].max(lv)]).collect();
            let pts = thin(&pts, tol);
            let top = rough_top(pts[0][0], pts[0][1]).unwrap_or(prev_level).max(pts[0][2]);
            out.push(Path { kind: 1, layer: (pass * 1000 + li) as u32, top, pts });
            prev_level = lv;
        }
    }
    Ok(out)
}

/// Bahnen als Bytes fürs Frontend (alles Little-Endian):
/// u32 Anzahl, je Bahn: u32 kind, u32 layer, f32 top, u32 n, n × (f32 x, f32 y, f32 z)
pub fn encode(paths: &[Path]) -> Vec<u8> {
    let n: usize = paths.iter().map(|p| 16 + p.pts.len() * 12).sum();
    let mut v = Vec::with_capacity(4 + n);
    v.extend((paths.len() as u32).to_le_bytes());
    for p in paths {
        v.extend(p.kind.to_le_bytes());
        v.extend(p.layer.to_le_bytes());
        v.extend((p.top as f32).to_le_bytes());
        v.extend((p.pts.len() as u32).to_le_bytes());
        for q in &p.pts {
            for c in q {
                v.extend((*c as f32).to_le_bytes());
            }
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plane(z: f64, s: f64) -> Vec<Tri> {
        vec![[[-s, -s, z], [s, -s, z], [s, s, z]], [[-s, -s, z], [s, s, z], [-s, s, z]]]
    }

    /// Halbkugel (Radius rs, Mitte im Ursprung) aus vielen Dreiecken
    fn hemisphere(rs: f64, nu: usize, nv: usize) -> Vec<Tri> {
        let p = |i: usize, j: usize| {
            let th = std::f64::consts::TAU * i as f64 / nu as f64;
            let ph = std::f64::consts::FRAC_PI_2 * j as f64 / nv as f64; // 0 = Äquator, π/2 = Pol
            [rs * ph.cos() * th.cos(), rs * ph.cos() * th.sin(), rs * ph.sin()]
        };
        let mut t = Vec::new();
        for i in 0..nu {
            for j in 0..nv {
                t.push([p(i, j), p(i + 1, j), p(i + 1, j + 1)]);
                t.push([p(i, j), p(i + 1, j + 1), p(i, j + 1)]);
            }
        }
        t
    }

    /// Pyramide: Grundfläche 2a × 2a auf z = 0, Spitze (0, 0, hp)
    fn pyramid(a: f64, hp: f64) -> Vec<Tri> {
        let top = [0.0, 0.0, hp];
        let c = [[-a, -a, 0.0], [a, -a, 0.0], [a, a, 0.0], [-a, a, 0.0]];
        (0..4).map(|k| [c[k], c[(k + 1) % 4], top]).collect()
    }

    #[test]
    fn plane_any_cutter() {
        let m = Model::new(plane(-2.0, 50.0), -10.0);
        let mut s = m.scratch();
        for (x, y) in [(0.0, 0.0), (10.0, -7.3), (-30.0, 22.0)] {
            assert!((m.drop(x, y, Cutter::Flat(3.0), &mut s) + 2.0).abs() < 1e-9);
            assert!((m.drop(x, y, Cutter::Ball(3.0), &mut s) + 2.0).abs() < 1e-9);
        }
        // außerhalb des Modells: Boden
        assert!((m.drop(200.0, 0.0, Cutter::Ball(3.0), &mut s) + 10.0).abs() < 1e-9);
    }

    #[test]
    fn hemisphere_ball_and_flat() {
        let rs = 20.0;
        let m = Model::new(hemisphere(rs, 256, 96), -1.0);
        let mut s = m.scratch();
        // Sehnenfehler der Facetten: rs·(1−cos(Δ/2)) mit Δ = 2π/256 ≈ 0,006 mm
        let tol = 0.02;
        let r = 3.0;
        for rho in [0.0, 4.0, 9.5, 15.0, 19.0] {
            let (x, y) = (rho * 0.6, rho * 0.8);
            // Kugelfräser: Kugelmitte liegt auf einer Kugel mit Radius rs + r
            let want = ((rs + r).powi(2) - rho * rho).sqrt() - r;
            let got = m.drop(x, y, Cutter::Ball(r), &mut s);
            assert!((got - want).abs() < tol, "ball rho={rho}: {got} vs {want}");
            // Schaftfräser: oben flach (Pol unter der Scheibe), sonst nächster Scheibenrand
            let want_f = if rho <= r { rs } else { (rs * rs - (rho - r).powi(2)).sqrt() };
            let got_f = m.drop(x, y, Cutter::Flat(r), &mut s);
            assert!((got_f - want_f).abs() < tol, "flat rho={rho}: {got_f} vs {want_f}");
        }
    }

    #[test]
    fn pyramid_faces_edges_apex() {
        let (a, hp) = (20.0, 10.0);
        let m = Model::new(pyramid(a, hp), -1.0);
        let mut s = m.scratch();
        let r = 2.0;
        let k = hp / a; // Steigung der Seiten
        for x in [5.0, 9.0, 14.0] {
            // Schaftfräser auf der Seite +X: höchster Scheibenpunkt bei x − r
            let want = hp - k * (x - r);
            assert!((m.drop(x, 0.0, Cutter::Flat(r), &mut s) - want).abs() < 1e-9);
            // Kugelfräser: Abstand r senkrecht zur Fläche
            let want_b = hp - k * x + r * (1.0 + k * k).sqrt() - r;
            assert!((m.drop(x, 0.0, Cutter::Ball(r), &mut s) - want_b).abs() < 1e-9, "x={x}");
        }
        // über der Spitze: berührt die Ecke
        assert!((m.drop(0.0, 0.0, Cutter::Ball(r), &mut s) - hp).abs() < 1e-9);
        assert!((m.drop(0.0, 0.0, Cutter::Flat(r), &mut s) - hp).abs() < 1e-9);
        // über dem Grat (Diagonale): Kugel gegen die Kante von (a,a,0) zur Spitze
        let d = 8.0_f64;
        let (x, y) = (d / 2f64.sqrt(), d / 2f64.sqrt());
        let l = a * 2f64.sqrt();
        let slope = -hp / l;
        let kk = (1.0 + slope * slope).sqrt();
        let want = hp + slope * d + r * kk - r;
        assert!((m.drop(x, y, Cutter::Ball(r), &mut s) - want).abs() < 1e-9);
    }

    #[test]
    fn stl_binary_and_ascii() {
        let tris = pyramid(10.0, 5.0);
        let mut bin = vec![0u8; 80];
        bin.extend((tris.len() as u32).to_le_bytes());
        for t in &tris {
            bin.extend([0u8; 12]);
            for v in t {
                for c in v {
                    bin.extend((*c as f32).to_le_bytes());
                }
            }
            bin.extend([0u8; 2]);
        }
        let b = parse_stl(&bin).unwrap();
        assert_eq!(b.len(), 4);
        assert_eq!(b[1][2], [0.0, 0.0, 5.0]);
        let mut txt = String::from("solid test\n");
        for t in &tris {
            txt += "facet normal 0 0 1\nouter loop\n";
            for v in t {
                txt += &format!("vertex {} {} {}\n", v[0], v[1], v[2]);
            }
            txt += "endloop\nendfacet\n";
        }
        txt += "endsolid test\n";
        let a = parse_stl(txt.as_bytes()).unwrap();
        assert_eq!(a.len(), 4);
        assert_eq!(a[3][0], [-10.0, 10.0, 0.0]);
    }

    #[test]
    fn distance_field_line() {
        // 1 × 7: Mitte am weitesten weg
        let inside = [false, true, true, true, true, true, false];
        let d = distance_field(&inside, 7, 1);
        assert_eq!(d, vec![0.0, 1.0, 2.0, 3.0, 2.0, 1.0, 0.0]);
    }

    fn job(rough: bool, finish: bool) -> Job {
        Job {
            place: Place { x0: 10.0, y0: 10.0, size_x: 40.0, size_y: 40.0, height: 10.0 },
            margin: true,
            rough: rough.then(|| ToolOp { ball: false, diameter: 6.0, step_down: 3.0, step_over: 2.5, allowance: 0.5, dir: String::new(), tolerance: 0.01 }),
            finish: finish.then(|| ToolOp { ball: true, diameter: 3.0, step_down: 2.0, step_over: 0.5, allowance: 0.0, dir: "x".into(), tolerance: 0.01 }),
        }
    }

    #[test]
    fn rough_and_finish_never_gouge() {
        // Halbkugel auf einer Platte: 40 × 40 mm, 10 mm hoch
        let mut tris = hemisphere(20.0, 96, 32);
        tris.extend(plane(0.0, 20.0));
        let cancel = AtomicBool::new(false);
        let j = job(true, true);
        let paths = compute(&tris, &j, &cancel, &|_, _| {}).unwrap();
        let rough: Vec<&Path> = paths.iter().filter(|p| p.kind == 0).collect();
        let fin: Vec<&Path> = paths.iter().filter(|p| p.kind == 1).collect();
        assert!(!rough.is_empty() && !fin.is_empty());
        // Schichten: -3, -6, -9, dann Boden + Aufmaß (-9,5)
        let mut zs: Vec<f64> = rough.iter().map(|p| p.pts[0][2]).collect();
        zs.dedup();
        assert_eq!(zs.first().copied(), Some(-3.0));
        assert!((zs.last().unwrap() + 9.5).abs() < 1e-9);
        // Kein Schrupp-Punkt darf das Modell + Aufmaß verletzen (Toleranz: Facetten + Halbierung)
        let m = Model::new(place(&tris, &j.place), -10.0);
        let mut s = m.scratch();
        let cg = Cutter::Flat(3.5);
        for p in &rough {
            for q in &p.pts {
                let need = m.drop(q[0], q[1], cg, &mut s) + 0.5;
                assert!(q[2] >= need - 0.03, "rough gouge at {:?}: need {}", q, need);
            }
        }
        // Schlichten liegt genau auf der Drop-Cutter-Höhe (ausgedünnt mit 0,01 mm)
        for p in &fin {
            // Eintauchen: von der Höhe, bis zu der nach dem Schruppen noch Material steht
            assert!(p.top <= 0.0 && p.top >= p.pts[0][2] - 1e-9 && p.top <= p.pts[0][2] + 3.5 + 1e-9, "top {}", p.top);
            for q in &p.pts {
                let need = m.drop(q[0], q[1], Cutter::Ball(1.5), &mut s);
                assert!(q[2] >= need - 1e-6, "finish gouge at {:?}", q);
            }
            assert!(p.pts.iter().all(|q| q[0] >= 8.5 - 1e-9 && q[0] <= 51.5 + 1e-9));
        }
        let bytes = encode(&paths);
        assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize, paths.len());
    }

    #[test]
    fn finish_only_in_layers() {
        let tris = hemisphere(20.0, 64, 24);
        let cancel = AtomicBool::new(false);
        let paths = compute(&tris, &job(false, true), &cancel, &|_, _| {}).unwrap();
        // 10 mm tief, 2 mm Zustellung: 5 Schichten, die erste nie tiefer als -2
        assert_eq!(paths.len(), 5);
        assert!(paths[0].pts.iter().all(|q| q[2] >= -2.0 - 1e-9));
        assert!(paths[4].pts.iter().any(|q| q[2] < -9.0));
    }

    #[test]
    fn cancel_stops() {
        let tris = hemisphere(20.0, 64, 24);
        let cancel = AtomicBool::new(true);
        assert_eq!(compute(&tris, &job(true, true), &cancel, &|_, _| {}).unwrap_err(), CANCELLED);
    }
}
