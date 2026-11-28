//! RELIEF – Zwilling von `src/relief/heightField.ts`, `imageRelief.ts`, `vectorRelief.ts` und `reliefBuild.ts`.
//!
//! Höhenfeld aus einem Bild (Helligkeit wird Höhe: nachrechnen, weichzeichnen, Schwarz-/Weißpunkt, Gamma, Kontrast,
//! Rand) oder aus geschlossenen Konturen (gerade/ungerade innen, Abstandsfeld, Kantenprofil), dazu die Dreiecksfläche
//! für den 3D-Dialog. Das TypeScript speichert in Float32-Feldern – hier wird an genau denselben Stellen auf f32
//! gerundet. Nur Vergleich: welches Relief in den 3D-Dialog geht, bestimmt weiter das Fenster (reliefDialog.ts).
//! Gemeinsame Fälle: `tests/fixtures/relief-cases.json.gz`.

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath::{self, js_round};
use serde::{Deserialize, Serialize};

pub const MAX_NODES: f64 = 1_200_000.0;
const MIN_CELL: f64 = 0.05;

#[derive(Clone, Debug)]
pub struct HeightField {
    pub nx: usize,
    pub ny: usize,
    pub w: f64,
    pub h: f64,
    pub z: Vec<f32>,
}

/// Rastergröße für w × h mm
pub fn grid_for(w: f64, h: f64, long_side: f64) -> (usize, usize) {
    let l = mx(w, h);
    let mut cell = mx(l / mx(2.0, long_side), MIN_CELL);
    let count = |cell: f64| (mx(2.0, js_round(w / cell) + 1.0), mx(2.0, js_round(h / cell) + 1.0));
    let (mut nx, mut ny) = count(cell);
    if nx * ny > MAX_NODES {
        cell *= ((nx * ny) / MAX_NODES).sqrt() * 1.001;
        (nx, ny) = count(cell);
    }
    (nx as usize, ny as usize)
}

/// Weichzeichnen: drei Durchläufe Kastenfilter, wirkt direkt auf das Feld (f32 wie Float32Array)
pub fn blur(a: &mut [f32], nx: usize, ny: usize, sigma_x: f64, sigma_y: f64) {
    let rad = |s: f64| js_round(((4.0 * s * s + 1.0).sqrt() - 1.0) / 2.0);
    let (rx, ry) = (rad(sigma_x), rad(sigma_y));
    let mut buf = vec![0f32; nx.max(ny)];
    let mut line = |a: &mut [f32], start: usize, step: usize, n: usize, r: f64| {
        if r < 1.0 {
            return;
        }
        let ri = r as i64;
        for _ in 0..3 {
            for k in 0..n {
                buf[k] = a[start + k * step];
            }
            let at = |buf: &[f32], k: i64| buf[if k < 0 { 0 } else if k >= n as i64 { n - 1 } else { k as usize }] as f64;
            let mut sum = 0.0f64;
            for k in -ri..=ri {
                sum += at(&buf, k);
            }
            let f = 1.0 / (2.0 * r + 1.0);
            for k in 0..n {
                a[start + k * step] = (sum * f) as f32;
                let ki = k as i64;
                sum += at(&buf, ki + ri + 1) - at(&buf, ki - ri);
            }
        }
    };
    for j in 0..ny {
        line(a, j * nx, 1, nx, rx);
    }
    for i in 0..nx {
        line(a, i, nx, ny, ry);
    }
}

/// Oberkante genau auf 0 schieben; true = das Feld ist ganz flach
pub fn normalize_top(z: &mut [f32]) -> bool {
    let (mut hi, mut lo) = (f64::NEG_INFINITY, f64::INFINITY);
    for &v in z.iter() {
        let v = v as f64;
        if v > hi {
            hi = v;
        }
        if v < lo {
            lo = v;
        }
    }
    if hi != 0.0 {
        for v in z.iter_mut() {
            *v = (*v as f64 - hi) as f32;
        }
    }
    hi - lo < 1e-4
}

pub fn field_range(f: &HeightField) -> f64 {
    let mut lo = 0.0f64;
    for &v in &f.z {
        if (v as f64) < lo {
            lo = v as f64;
        }
    }
    if lo < 0.0 {
        -lo
    } else {
        0.0
    }
}

/// Fläche als Dreiecke (9 Werte je Dreieck)
pub fn field_to_mesh(f: &HeightField) -> Vec<f32> {
    let (nx, ny) = (f.nx, f.ny);
    let dx = f.w / (nx - 1) as f64;
    let dy = f.h / (ny - 1) as f64;
    let mut out = Vec::with_capacity((nx - 1) * (ny - 1) * 18);
    let put = |i: usize, j: usize, out: &mut Vec<f32>| {
        out.push((i as f64 * dx) as f32);
        out.push((j as f64 * dy) as f32);
        out.push(f.z[j * nx + i]);
    };
    for j in 0..ny - 1 {
        for i in 0..nx - 1 {
            put(i, j, &mut out);
            put(i + 1, j, &mut out);
            put(i + 1, j + 1, &mut out);
            put(i, j, &mut out);
            put(i + 1, j + 1, &mut out);
            put(i, j + 1, &mut out);
        }
    }
    out
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct DetailLoss {
    pub share: f64,
    pub worst: f64,
}

/// Wie viel der Fläche erreicht ein Kugelfräser nicht? (Warnung im 3D-Dialog; hier nur vom Test verglichen)
#[allow(dead_code)]
pub fn detail_loss(f: &HeightField, size_x: f64, size_y: f64, height: f64, ball_r: f64) -> DetailLoss {
    let range = field_range(f);
    let range = if range == 0.0 { 1.0 } else { range };
    let kz = height / range;
    let g = mx(ball_r / 5.0, mx(size_x, size_y) / 220.0);
    let nx = mx(2.0, js_round(size_x / g) + 1.0) as usize;
    let ny = mx(2.0, js_round(size_y / g) + 1.0) as usize;
    let gx = size_x / (nx - 1) as f64;
    let gy = size_y / (ny - 1) as f64;
    let mut z = vec![0f32; nx * ny];
    for j in 0..ny {
        let fj = js_round((j as f64 / (ny - 1) as f64) * (f.ny - 1) as f64) as usize;
        for i in 0..nx {
            z[j * nx + i] = (f.z[fj * f.nx + js_round((i as f64 / (nx - 1) as f64) * (f.nx - 1) as f64) as usize] as f64 * kz) as f32;
        }
    }
    let mut disc: Vec<(i64, i64, f64)> = vec![];
    let (ni, nj) = ((ball_r / gx).floor() as i64, (ball_r / gy).floor() as i64);
    for dj in -nj..=nj {
        for di in -ni..=ni {
            let (a, b) = (di as f64 * gx, dj as f64 * gy);
            let d2 = a * a + b * b;
            if d2 <= ball_r * ball_r {
                disc.push((di, dj, ball_r - (ball_r * ball_r - d2).sqrt()));
            }
        }
    }
    if disc.len() < 5 {
        return DetailLoss { share: 0.0, worst: 0.0 };
    }
    let (nxi, nyi) = (nx as i64, ny as i64);
    let mut tip = vec![0f32; nx * ny];
    for j in 0..nyi {
        for i in 0..nxi {
            let mut m = f64::NEG_INFINITY;
            for &(di, dj, cb) in &disc {
                let (a, b) = (i + di, j + dj);
                if a < 0 || b < 0 || a >= nxi || b >= nyi {
                    continue;
                }
                let v = z[(b * nxi + a) as usize] as f64 - cb;
                if v > m {
                    m = v;
                }
            }
            tip[(j * nxi + i) as usize] = m as f32;
        }
    }
    let limit = mx(0.1, 0.03 * height);
    let (mut over, mut worst) = (0.0, 0.0f64);
    for j in 0..nyi {
        for i in 0..nxi {
            let mut m = f64::INFINITY;
            for &(di, dj, cb) in &disc {
                let (a, b) = (i + di, j + dj);
                if a < 0 || b < 0 || a >= nxi || b >= nyi {
                    continue;
                }
                let v = tip[(b * nxi + a) as usize] as f64 + cb;
                if v < m {
                    m = v;
                }
            }
            let gap = m - z[(j * nxi + i) as usize] as f64;
            if gap > limit {
                over += 1.0;
            }
            if gap > worst {
                worst = gap;
            }
        }
    }
    DetailLoss { share: over / (nx * ny) as f64, worst }
}

// ---- Bild ----

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImageReliefOpts {
    pub w: f64,
    pub h: f64,
    pub nx: usize,
    pub ny: usize,
    pub depth: f64,
    pub invert: bool,
    pub smooth: f64,
    pub contrast: f64,
    pub gamma: f64,
    pub border: f64,
    pub fade: f64,
    pub fade_to: String,
}

/// Grauwerte auf nx × ny Knoten bringen: beim Verkleinern mitteln, sonst weich zwischen den Pixeln
pub fn resample_gray(gray: &[f32], sw: usize, sh: usize, nx: usize, ny: usize) -> Vec<f32> {
    let mut out = vec![0f32; nx * ny];
    let kx = (sw as f64 - 1.0) / mx(1.0, nx as f64 - 1.0);
    let ky = (sh as f64 - 1.0) / mx(1.0, ny as f64 - 1.0);
    let (rx, ry) = (kx / 2.0, ky / 2.0);
    let g = |k: usize| gray[k] as f64;
    for j in 0..ny {
        let v = j as f64 * ky;
        for i in 0..nx {
            let u = i as f64 * kx;
            if rx >= 1.0 || ry >= 1.0 {
                let x0 = mx(0.0, (u - rx).ceil());
                let x1 = mn(sw as f64 - 1.0, (u + rx).floor());
                let y0 = mx(0.0, (v - ry).ceil());
                let y1 = mn(sh as f64 - 1.0, (v + ry).floor());
                let (mut s, mut c) = (0.0, 0.0);
                let mut y = y0;
                while y <= y1 {
                    let mut x = x0;
                    while x <= x1 {
                        s += g(y as usize * sw + x as usize);
                        c += 1.0;
                        x += 1.0;
                    }
                    y += 1.0;
                }
                if c != 0.0 {
                    out[j * nx + i] = (s / c) as f32;
                    continue;
                }
            }
            let a = mn(sw as f64 - 1.0, u.floor());
            let b = mn(sh as f64 - 1.0, v.floor());
            let a1 = mn(sw as f64 - 1.0, a + 1.0);
            let b1 = mn(sh as f64 - 1.0, b + 1.0);
            let (fu, fv) = (u - a, v - b);
            let (a, b, a1, b1) = (a as usize, b as usize, a1 as usize, b1 as usize);
            out[j * nx + i] = ((g(b * sw + a) * (1.0 - fu) + g(b * sw + a1) * fu) * (1.0 - fv) + (g(b1 * sw + a) * (1.0 - fu) + g(b1 * sw + a1) * fu) * fv) as f32;
        }
    }
    out
}

/// Schwarz- und Weißpunkt (je 0,2 % zählen nicht)
fn levels(t: &[f32]) -> (f64, f64) {
    let mut bins = vec![0u32; 1024];
    for &v in t {
        let k = mx(0.0, mn(1023.0, (v as f64 * 1024.0).floor())) as usize;
        bins[k] += 1;
    }
    let skip = t.len() as f64 * 0.002;
    let (mut c, mut lo, mut hi) = (0.0, 0usize, 1023usize);
    for (k, &b) in bins.iter().enumerate() {
        c += b as f64;
        if c > skip {
            lo = k;
            break;
        }
    }
    c = 0.0;
    for k in (0..1024).rev() {
        c += bins[k] as f64;
        if c > skip {
            hi = k;
            break;
        }
    }
    (lo as f64 / 1024.0, (hi + 1) as f64 / 1024.0)
}

/// Grauwerte → Höhenfeld. flat = keine Helligkeits-Unterschiede
pub fn gray_to_field(gray: &[f32], sw: usize, sh: usize, o: &ImageReliefOpts) -> (HeightField, bool) {
    let (nx, ny) = (o.nx, o.ny);
    let mut t = resample_gray(gray, sw, sh, nx, ny);
    let dx = o.w / (nx - 1) as f64;
    let dy = o.h / (ny - 1) as f64;
    if o.invert {
        for v in t.iter_mut() {
            *v = (1.0 - *v as f64) as f32;
        }
    }
    if o.smooth > 0.0 {
        blur(&mut t, nx, ny, o.smooth / dx, o.smooth / dy);
    }
    let (lo, hi) = levels(&t);
    let mut flat = hi - lo < 2.0 / 1024.0 + 1e-6;
    let g = 1.0 / mx(0.05, o.gamma);
    let c = mx(0.05, o.contrast);
    for v in t.iter_mut() {
        let mut x = if flat { 1.0 } else { mx(0.0, mn(1.0, (*v as f64 - lo) / (hi - lo))) };
        if g != 1.0 {
            x = jsmath::pow(x, g);
        }
        if c != 1.0 && x > 0.0 && x < 1.0 {
            let (p, q) = (jsmath::pow(x, c), jsmath::pow(1.0 - x, c));
            x = p / (p + q);
        }
        *v = x as f32;
    }
    let band = mx(0.0, o.border);
    let fade = mx(0.0, o.fade);
    if band + fade > 0.0 {
        let target = if o.fade_to == "bottom" { 0.0 } else { 1.0 };
        for j in 0..ny {
            for i in 0..nx {
                let e = mn(mn(mn(i as f64 * dx, (nx - 1 - i) as f64 * dx), j as f64 * dy), (ny - 1 - j) as f64 * dy);
                if e >= band + fade {
                    continue;
                }
                let mut k = 0.0;
                if e > band && fade > 0.0 {
                    let u = (e - band) / fade;
                    k = u * u * (3.0 - 2.0 * u);
                }
                let idx = j * nx + i;
                t[idx] = (target + (t[idx] as f64 - target) * k) as f32;
            }
        }
    }
    let mut z = vec![0f32; nx * ny];
    let d = mx(0.0, o.depth);
    for j in 0..ny {
        for i in 0..nx {
            z[j * nx + i] = ((t[(ny - 1 - j) * nx + i] as f64 - 1.0) * d) as f32;
        }
    }
    flat = normalize_top(&mut z) || flat;
    (HeightField { nx, ny, w: o.w, h: o.h, z }, flat)
}

// ---- Vektoren ----

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct VPt {
    pub x: f64,
    pub y: f64,
}
#[derive(Deserialize, Clone, Debug)]
pub struct VectorReliefOpts {
    pub height: f64,
    pub profile: String,
    pub width: f64,
    pub pad: f64,
    pub smooth: f64,
    pub long: f64,
}

fn loop_bounds(loops: &[&Vec<VPt>]) -> (f64, f64, f64, f64) {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for l in loops {
        for p in l.iter() {
            if p.x < x0 {
                x0 = p.x;
            }
            if p.x > x1 {
                x1 = p.x;
            }
            if p.y < y0 {
                y0 = p.y;
            }
            if p.y > y1 {
                y1 = p.y;
            }
        }
    }
    (x0, y0, x1, y1)
}

/// Knoten innerhalb nach gerade/ungerade
fn inside_mask(loops: &[&Vec<VPt>], x0: f64, y0: f64, dx: f64, dy: f64, nx: usize, ny: usize) -> Vec<u8> {
    let mut rows: Vec<Vec<f64>> = vec![vec![]; ny];
    for l in loops {
        if l.len() < 3 {
            continue;
        }
        for k in 0..l.len() {
            let (a, b) = (l[k], l[if k + 1 == l.len() { 0 } else { k + 1 }]);
            if a.y == b.y {
                continue;
            }
            let (lo, hi) = (mn(a.y, b.y), mx(a.y, b.y));
            let j0 = mx(0.0, ((lo - y0) / dy).ceil());
            let j1 = mn(ny as f64 - 1.0, ((hi - y0) / dy).ceil() - 1.0);
            let mut j = j0;
            while j <= j1 {
                rows[j as usize].push(a.x + ((y0 + j * dy - a.y) / (b.y - a.y)) * (b.x - a.x));
                j += 1.0;
            }
        }
    }
    let mut m = vec![0u8; nx * ny];
    for (j, r) in rows.iter_mut().enumerate() {
        r.sort_by(|p, q| p.partial_cmp(q).unwrap_or(std::cmp::Ordering::Equal));
        let mut k = 0;
        while k + 1 < r.len() {
            let i0 = mx(0.0, ((r[k] - x0) / dx).ceil());
            let i1 = mn(nx as f64 - 1.0, ((r[k + 1] - x0) / dx).floor());
            let mut i = i0;
            while i <= i1 {
                m[j * nx + i as usize] = 1;
                i += 1.0;
            }
            k += 2;
        }
    }
    m
}

/// Abstand jedes Knotens zur nächsten Kontur (mm)
fn contour_distance(loops: &[&Vec<VPt>], x0: f64, y0: f64, dx: f64, dy: f64, nx: usize, ny: usize) -> Vec<f32> {
    let mut seg: Vec<f64> = vec![];
    for l in loops {
        if l.len() < 2 {
            continue;
        }
        for k in 0..l.len() {
            let (a, b) = (l[k], l[if k + 1 == l.len() { 0 } else { k + 1 }]);
            seg.extend([a.x, a.y, b.x, b.y]);
        }
    }
    let mut near = vec![-1i64; nx * ny];
    let mut d2 = vec![f64::INFINITY; nx * ny];
    let dist2 = |i: usize, j: usize, s: usize| {
        let (px, py) = (x0 + i as f64 * dx, y0 + j as f64 * dy);
        let (ax, ay) = (seg[s], seg[s + 1]);
        let (bx, by) = (seg[s + 2] - ax, seg[s + 3] - ay);
        let l = bx * bx + by * by;
        let u = if l > 0.0 { mx(0.0, mn(1.0, ((px - ax) * bx + (py - ay) * by) / l)) } else { 0.0 };
        let (qx, qy) = (px - ax - u * bx, py - ay - u * by);
        qx * qx + qy * qy
    };
    let offer = |i: usize, j: usize, s: usize, d2: &mut Vec<f64>, near: &mut Vec<i64>| {
        let v = dist2(i, j, s);
        let c = j * nx + i;
        if v < d2[c] {
            d2[c] = v;
            near[c] = s as i64;
        }
    };
    let step = mn(dx, dy) / 2.0;
    let mut s = 0;
    while s < seg.len() {
        let n = mx(1.0, (hypot2(seg[s + 2] - seg[s], seg[s + 3] - seg[s + 1]) / step).ceil());
        let mut k = 0.0;
        while k <= n {
            let x = seg[s] + ((seg[s + 2] - seg[s]) * k) / n;
            let y = seg[s + 1] + ((seg[s + 3] - seg[s + 1]) * k) / n;
            let ci = ((x - x0) / dx).floor() as i64;
            let cj = ((y - y0) / dy).floor() as i64;
            let mut j = cj.max(0);
            while j <= (ny as i64 - 1).min(cj + 1) {
                let mut i = ci.max(0);
                while i <= (nx as i64 - 1).min(ci + 1) {
                    offer(i as usize, j as usize, s, &mut d2, &mut near);
                    i += 1;
                }
                j += 1;
            }
            k += 1.0;
        }
        s += 4;
    }
    let (nxi, nyi) = (nx as i64, ny as i64);
    let take = |i: i64, j: i64, a: i64, b: i64, d2: &mut Vec<f64>, near: &mut Vec<i64>| {
        if a < 0 || b < 0 || a >= nxi || b >= nyi {
            return;
        }
        let s = near[(b * nxi + a) as usize];
        if s >= 0 {
            offer(i as usize, j as usize, s as usize, d2, near);
        }
    };
    for _ in 0..2 {
        for j in 0..nyi {
            for i in 0..nxi {
                take(i, j, i - 1, j, &mut d2, &mut near);
                take(i, j, i - 1, j - 1, &mut d2, &mut near);
                take(i, j, i, j - 1, &mut d2, &mut near);
                take(i, j, i + 1, j - 1, &mut d2, &mut near);
            }
        }
        for j in (0..nyi).rev() {
            for i in (0..nxi).rev() {
                take(i, j, i + 1, j, &mut d2, &mut near);
                take(i, j, i + 1, j + 1, &mut d2, &mut near);
                take(i, j, i, j + 1, &mut d2, &mut near);
                take(i, j, i - 1, j + 1, &mut d2, &mut near);
            }
        }
    }
    d2.iter().map(|v| v.sqrt() as f32).collect()
}

/// Konturen (mm, Y nach oben) → Höhenfeld; (x0, y0) = linke untere Ecke
pub fn loops_to_field(loops: &[Vec<VPt>], o: &VectorReliefOpts) -> Option<(HeightField, f64, f64, bool)> {
    let used: Vec<&Vec<VPt>> = loops.iter().filter(|l| l.len() >= 3).collect();
    if used.is_empty() {
        return None;
    }
    let (bx0, by0, bx1, by1) = loop_bounds(&used);
    let pad = mx(0.0, o.pad);
    let w = bx1 - bx0 + 2.0 * pad;
    let h = by1 - by0 + 2.0 * pad;
    if !(w > 0.0 && h > 0.0) {
        return None;
    }
    let (nx, ny) = grid_for(w, h, o.long);
    let dx = w / (nx - 1) as f64;
    let dy = h / (ny - 1) as f64;
    let (x0, y0) = (bx0 - pad, by0 - pad);
    let inside = inside_mask(&used, x0, y0, dx, dy, nx, ny);
    let dist = contour_distance(&used, x0, y0, dx, dy, nx, ny);
    let mut dmax = 0.0f64;
    for i in 0..dist.len() {
        if inside[i] != 0 && dist[i] as f64 > dmax {
            dmax = dist[i] as f64;
        }
    }
    let hh = mx(0.0, o.height);
    let wid = if o.profile == "dome" && !(o.width > 0.0) { dmax } else { mx(0.0, o.width) };
    let mut lift = vec![0f32; nx * ny];
    for i in 0..lift.len() {
        if inside[i] == 0 {
            continue;
        }
        let t = if wid > 0.0 { mn(1.0, dist[i] as f64 / wid) } else { 1.0 };
        lift[i] = (hh * if o.profile == "slope" { t } else { (1.0 - (1.0 - t) * (1.0 - t)).sqrt() }) as f32;
    }
    if o.smooth > 0.0 {
        let mut soft = lift.clone();
        blur(&mut soft, nx, ny, o.smooth / dx, o.smooth / dy);
        for i in 0..lift.len() {
            if soft[i] < lift[i] {
                lift[i] = soft[i];
            }
        }
    }
    let mut z: Vec<f32> = lift.iter().map(|&v| (v as f64 - hh) as f32).collect();
    let flat = normalize_top(&mut z);
    Some((HeightField { nx, ny, w, h, z }, x0, y0, flat))
}

// ---- Zusammenfassung für den Vergleich ----

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Summary {
    pub nx: usize,
    pub ny: usize,
    pub w: f64,
    pub h: f64,
    pub x0: f64,
    pub y0: f64,
    pub flat: bool,
    /// FNV-1a über die f32-Bits von z bzw. der Dreiecksfläche
    pub z: u64,
    pub pos: u64,
    pub low: f64,
}

pub fn f32_hash(v: &[f32]) -> u64 {
    let mut h: u32 = 0x811c9dc5;
    for x in v {
        for b in x.to_bits().to_le_bytes() {
            h = (h ^ b as u32).wrapping_mul(0x01000193);
        }
    }
    h as u64
}

pub fn summary(f: &HeightField, x0: f64, y0: f64, flat: bool) -> Summary {
    let pos = field_to_mesh(f);
    Summary { nx: f.nx, ny: f.ny, w: f.w, h: f.h, x0, y0, flat, z: f32_hash(&f.z), pos: f32_hash(&pos), low: field_range(f) }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    pub kind: String,
    #[serde(default)]
    pub sw: usize,
    #[serde(default)]
    pub sh: usize,
    #[serde(default)]
    pub image: Option<ImageReliefOpts>,
    #[serde(default)]
    pub loops: Option<Vec<Vec<VPt>>>,
    #[serde(default)]
    pub vector: Option<VectorReliefOpts>,
}

/// Wie buildRelief im Fenster: Bild (Grauwerte als f32-Rohdaten) oder Konturen; None = kein Relief
pub fn build(head: &Head, gray: &[f32]) -> Result<Option<Summary>, String> {
    if head.kind == "image" {
        let o = head.image.as_ref().ok_or("no image options")?;
        if gray.len() != head.sw * head.sh {
            return Err(format!("image has {} values, expected {}", gray.len(), head.sw * head.sh));
        }
        let (f, flat) = gray_to_field(gray, head.sw, head.sh, o);
        return Ok(Some(summary(&f, 0.0, 0.0, flat)));
    }
    let o = head.vector.as_ref().ok_or("no vector options")?;
    Ok(loops_to_field(head.loops.as_deref().unwrap_or(&[]), o).map(|(f, x0, y0, flat)| summary(&f, x0, y0, flat)))
}

/// Kopf (JSON) und Grauwerte (f32, little-endian) aus dem Rohdaten-Aufruf
pub fn split_body(body: &[u8]) -> Result<(Head, Vec<f32>), String> {
    let n = u32::from_le_bytes(body.get(..4).ok_or("short body")?.try_into().map_err(|_| "short body")?) as usize;
    let head: Head = serde_json::from_slice(body.get(4..4 + n).ok_or("short body")?).map_err(|e| e.to_string())?;
    let data = &body[4 + n..];
    Ok((head, data.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Read;

    fn b64(s: &str) -> Vec<u8> {
        let val = |c: u8| match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            _ => 63,
        } as u32;
        let bytes: Vec<u8> = s.bytes().filter(|&c| c != b'=').collect();
        let mut out = vec![];
        for ch in bytes.chunks(4) {
            let n = ch.iter().enumerate().fold(0u32, |a, (i, &c)| a | (val(c) << (18 - 6 * i)));
            out.push((n >> 16) as u8);
            if ch.len() > 2 {
                out.push((n >> 8) as u8);
            }
            if ch.len() > 3 {
                out.push(n as u8);
            }
        }
        out
    }
    /// Zahlen auf 1e-9, der Rest genau
    fn same(a: &Value, b: &Value, at: &str) {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => {
                let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
                assert!((x - y).abs() <= 1e-9 * (1.0 + x.abs()), "{at}: {x} vs {y}");
            }
            (Value::Array(x), Value::Array(y)) => {
                assert_eq!(x.len(), y.len(), "{at}: length");
                for (k, (p, q)) in x.iter().zip(y).enumerate() {
                    same(p, q, &format!("{at}[{k}]"));
                }
            }
            (Value::Object(x), Value::Object(y)) => {
                let (mut kx, mut ky): (Vec<_>, Vec<_>) = (x.keys().collect(), y.keys().collect());
                kx.sort();
                ky.sort();
                assert_eq!(kx, ky, "{at}: keys");
                for (k, p) in x {
                    same(p, &y[k], &format!("{at}.{k}"));
                }
            }
            _ => assert_eq!(a, b, "{at}"),
        }
    }

    #[test]
    fn same_result_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("relief-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        let cases = all["cases"].as_array().unwrap();
        assert!(cases.len() >= 40, "only {} cases", cases.len());
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let head: Head = serde_json::from_value(c["head"].clone()).unwrap();
            let pic = c["pic"].as_str().unwrap();
            let gray: Vec<f32> = if pic.is_empty() { vec![] } else { b64(all["pictures"][pic].as_str().unwrap()).chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect() };
            let got = build(&head, &gray).unwrap();
            same(&serde_json::to_value(&got).unwrap(), &c["want"], name);
            if !c["loss"].is_null() {
                // das Feld noch einmal, für die Restfläche des Kugelfräsers
                let f = if head.kind == "image" {
                    gray_to_field(&gray, head.sw, head.sh, head.image.as_ref().unwrap()).0
                } else {
                    loops_to_field(head.loops.as_deref().unwrap(), head.vector.as_ref().unwrap()).unwrap().0
                };
                let loss = [detail_loss(&f, f.w, f.h, 5.0, 1.0), detail_loss(&f, 2.0 * f.w, f.h, 2.0, 3.0)];
                same(&serde_json::to_value(loss).unwrap(), &c["loss"], &format!("{name}: detail loss"));
            }
        }
        for g in all["grids"].as_array().unwrap() {
            let (nx, ny) = grid_for(g["w"].as_f64().unwrap(), g["h"].as_f64().unwrap(), g["l"].as_f64().unwrap());
            assert_eq!((nx as u64, ny as u64), (g["want"]["nx"].as_u64().unwrap(), g["want"]["ny"].as_u64().unwrap()), "gridFor {g}");
        }
        println!("{} reliefs built the same as the TypeScript (bit for bit in f32)", cases.len());
    }
}
