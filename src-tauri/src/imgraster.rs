//! BILDGRAVUR – RECHNEN (Zwilling von src/raster/dither.ts)
//!
//! Ablauf: Graustufen (0 = schwarz, 1 = weiß) → auf das Gravur-Raster umrechnen (1 Bildpunkt = Linienabstand)
//!         → verbessern (Schwarz-/Weißpunkt, Gamma, Helligkeit, Kontrast, Kurve, lokaler Kontrast, Entrauschen, Schärfen)
//!         → Rasterverfahren → „burn“ je Bildpunkt 0…1 (1 = Laser voll an).
//!
//! Die Rechnung folgt dem TypeScript Schritt für Schritt (auch darin, dass Zwischenwerte als 32-Bit-Zahlen gespeichert
//! werden), damit App und Vorschau dieselben Punkte brennen. Geprüft mit denselben Fällen auf beiden Seiten:
//! tests/fixtures/imgraster-cases.json und imgraster-expected.json (tests/imgRasterRust.test.ts und die Tests unten).
//! Gerechnet wird auf allen Kernen, wo jeder Bildpunkt (oder jede Zeile, jede Spalte) für sich steht – die Rechenschritte
//! je Punkt bleiben dieselben, also auch das Ergebnis. Die Fehlerverteilung (Jarvis, Floyd …) geht nur der Reihe nach.
//! Verfahren mit Winkelfunktionen je Bildpunkt (Spirale, Wellen, Kreuzschraffur, gedrehte Raster) können an einzelnen
//! Kanten-Punkten abweichen (siehe jsmath.rs) – dort wird gezählt statt genau verglichen.

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath;
use rayon::prelude::*;
use serde::Deserialize;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Adjust {
    pub black: f64,
    pub white: f64,
    pub gamma: f64,
    pub brightness: f64,
    pub contrast: f64,
    pub sharpen: f64,
    pub denoise: f64,
    #[serde(default)]
    pub invert: bool,
    /// lokaler Kontrast 0…100
    #[serde(default)]
    pub local: Option<f64>,
    /// Bildkurve: Punkte [ein, aus] 0…1
    #[serde(default)]
    pub curve: Option<Vec<Vec<f64>>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Raster {
    pub method: String,
    /// 0…1 (nur „threshold“)
    pub threshold: f64,
    /// Zellgröße in Raster-Punkten (Punkt-/Linienraster, Effekte)
    pub cell: f64,
    /// Winkel in Grad
    pub angle: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    /// Größe des Quellbilds
    pub sw: usize,
    pub sh: usize,
    /// Größe des Gravur-Rasters
    pub gw: usize,
    pub gh: usize,
    pub adjust: Adjust,
    pub raster: Raster,
}

/// Math.round: halbe Werte nach oben
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}
/// Math.min(hi, Math.max(lo, v))
fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    mn(hi, mx(lo, v))
}

// ---------------------------------------------------------------------
// Umrechnen aufs Raster
// ---------------------------------------------------------------------

/// Auf gw × gh umrechnen: verkleinern = Mittelwert der Fläche, vergrößern = bilinear
pub fn resample(src: &[f32], sw: usize, sh: usize, gw: usize, gh: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; gw * gh];
    if gw <= sw && gh <= sh {
        // Summen-Tabelle für schnelle Flächen-Mittelwerte
        let tw = sw + 1;
        let mut s = vec![0.0f64; tw * (sh + 1)];
        for y in 0..sh {
            let mut row = 0.0f64;
            for x in 0..sw {
                row += src[y * sw + x] as f64;
                s[(y + 1) * tw + x + 1] = s[y * tw + x + 1] + row;
            }
        }
        out.par_chunks_mut(gw).enumerate().for_each(|(y, line)| {
            let y0 = (y * sh) / gh;
            let y1 = (y0 + 1).max(((y + 1) * sh) / gh);
            for (x, o) in line.iter_mut().enumerate() {
                let x0 = (x * sw) / gw;
                let x1 = (x0 + 1).max(((x + 1) * sw) / gw);
                let sum = s[y1 * tw + x1] - s[y0 * tw + x1] - s[y1 * tw + x0] + s[y0 * tw + x0];
                *o = (sum / ((x1 - x0) * (y1 - y0)) as f64) as f32;
            }
        });
        return out;
    }
    out.par_chunks_mut(gw).enumerate().for_each(|(y, line)| {
        let fy = clamp(((y as f64 + 0.5) * sh as f64) / gh as f64 - 0.5, 0.0, sh as f64 - 1.0);
        let y0 = fy.floor() as usize;
        let y1 = (sh - 1).min(y0 + 1);
        let ty = fy - y0 as f64;
        for (x, o) in line.iter_mut().enumerate() {
            let fx = clamp(((x as f64 + 0.5) * sw as f64) / gw as f64 - 0.5, 0.0, sw as f64 - 1.0);
            let x0 = fx.floor() as usize;
            let x1 = (sw - 1).min(x0 + 1);
            let tx = fx - x0 as f64;
            let a = src[y0 * sw + x0] as f64 * (1.0 - tx) + src[y0 * sw + x1] as f64 * tx;
            let b = src[y1 * sw + x0] as f64 * (1.0 - tx) + src[y1 * sw + x1] as f64 * tx;
            *o = (a * (1.0 - ty) + b * ty) as f32;
        }
    });
    out
}

// ---------------------------------------------------------------------
// Verbessern
// ---------------------------------------------------------------------

/// Weichzeichnen (3 × Kastenfilter ≈ Gauß), Radius in Bildpunkten – dieselben Rechenschritte wie im TypeScript:
/// waagerecht eine laufende Summe je Zeile, senkrecht eine laufende Summe je Spalte. Zeilen und Spalten hängen nicht
/// voneinander ab, darum dürfen sie auf mehreren Kernen laufen.
fn blur(g: &[f32], w: usize, h: usize, r: f64) -> Vec<f32> {
    if !(r >= 1.0) || w == 0 || h == 0 {
        return g.to_vec();
    }
    let r = r as i64;
    let (wi, hi) = (w as i64, h as i64);
    let mut a = g.to_vec();
    let mut b = vec![0.0f32; g.len()];
    /// so viele Spalten rechnet ein Kern am Stück
    const STRIPE: usize = 128;
    for _ in 0..3 {
        // waagerecht: a → b
        b.par_chunks_mut(w).zip(a.par_chunks(w)).for_each(|(out, line)| {
            let (mut s, mut n) = (0.0f64, 0i64);
            let mut x = -r;
            while x < wi {
                if x + r < wi {
                    s += line[(x + r) as usize] as f64;
                    n += 1;
                }
                if x - r - 1 >= 0 {
                    s -= line[(x - r - 1) as usize] as f64;
                    n -= 1;
                }
                if x >= 0 {
                    out[x as usize] = (s / n.max(1) as f64) as f32;
                }
                x += 1;
            }
        });
        // senkrecht: b → a, in Streifen von Spalten (jeder Streifen: Ergebnis h × Breite, danach zeilenweise einsetzen)
        let src = &b;
        let stripes: Vec<Vec<f32>> = (0..w.div_ceil(STRIPE))
            .into_par_iter()
            .map(|k| {
                let x0 = k * STRIPE;
                let sw = STRIPE.min(w - x0);
                let mut col = vec![0.0f64; sw];
                let mut out = vec![0.0f32; sw * h];
                let mut n = 0i64;
                let mut y = -r;
                while y < hi {
                    if y + r < hi {
                        let o = (y + r) as usize * w + x0;
                        for x in 0..sw {
                            col[x] += src[o + x] as f64;
                        }
                        n += 1;
                    }
                    if y - r - 1 >= 0 {
                        let o = (y - r - 1) as usize * w + x0;
                        for x in 0..sw {
                            col[x] -= src[o + x] as f64;
                        }
                        n -= 1;
                    }
                    if y >= 0 {
                        let o = y as usize * sw;
                        let d = n.max(1) as f64;
                        for x in 0..sw {
                            out[o + x] = (col[x] / d) as f32;
                        }
                    }
                    y += 1;
                }
                out
            })
            .collect();
        a.par_chunks_mut(w).enumerate().for_each(|(y, line)| {
            for (k, st) in stripes.iter().enumerate() {
                let x0 = k * STRIPE;
                let sw = STRIPE.min(w - x0);
                line[x0..x0 + sw].copy_from_slice(&st[y * sw..(y + 1) * sw]);
            }
        });
    }
    a
}

/// Ist die Kurve nur die Diagonale (ändert nichts)?
pub fn curve_is_identity(c: Option<&Vec<Vec<f64>>>) -> bool {
    let Some(c) = c else { return true };
    let at = |p: &Vec<f64>, k: usize| p.get(k).copied().unwrap_or(f64::NAN);
    c.len() < 2 || c.iter().all(|p| (at(p, 0) - at(p, 1)).abs() < 1e-4)
}

/// Bildkurve als Tabelle mit 256 Werten: weiche Kurve durch die Punkte, die nie „überschwingt“
/// (monotone kubische Interpolation nach Fritsch–Carlson)
pub fn curve_lut(pts: &[Vec<f64>]) -> Vec<f32> {
    let at = |q: &Vec<f64>, k: usize| q.get(k).copied().unwrap_or(f64::NAN);
    let mut p: Vec<[f64; 2]> = pts.iter().map(|q| [mn(1.0, mx(0.0, at(q, 0))), mn(1.0, mx(0.0, at(q, 1)))]).collect();
    p.sort_by(|a, b| {
        let v = a[0] - b[0];
        if v < 0.0 {
            std::cmp::Ordering::Less
        } else if v > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    let mut lut = vec![0.0f32; 256];
    let n = p.len();
    if n < 2 {
        for (i, v) in lut.iter_mut().enumerate() {
            *v = (i as f64 / 255.0) as f32;
        }
        return lut;
    }
    let d: Vec<f64> = (0..n - 1).map(|i| (p[i + 1][1] - p[i][1]) / mx(1e-6, p[i + 1][0] - p[i][0])).collect();
    let mut m = vec![0.0f64; n];
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for i in 1..n - 1 {
        m[i] = if d[i - 1] * d[i] <= 0.0 { 0.0 } else { (d[i - 1] + d[i]) / 2.0 };
    }
    for i in 0..n - 1 {
        if d[i].abs() < 1e-9 {
            m[i] = 0.0;
            m[i + 1] = 0.0;
            continue;
        }
        let (a, b) = (m[i] / d[i], m[i + 1] / d[i]);
        let r = a * a + b * b;
        if r > 9.0 {
            let k = 3.0 / r.sqrt();
            m[i] = k * a * d[i];
            m[i + 1] = k * b * d[i];
        }
    }
    for (k, v) in lut.iter_mut().enumerate() {
        let x = k as f64 / 255.0;
        let mut i = 0;
        while i + 2 < n && x > p[i + 1][0] {
            i += 1;
        }
        let y = if x <= p[0][0] {
            p[0][1]
        } else if x >= p[n - 1][0] {
            p[n - 1][1]
        } else {
            let h = p[i + 1][0] - p[i][0];
            let t = (x - p[i][0]) / h;
            let t2 = t * t;
            let t3 = t2 * t;
            (2.0 * t3 - 3.0 * t2 + 1.0) * p[i][1] + (t3 - 2.0 * t2 + t) * h * m[i] + (-2.0 * t3 + 3.0 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1]
        };
        *v = mn(1.0, mx(0.0, y)) as f32;
    }
    lut
}

/// Bild verbessern (wie applyAdjustCpu – die Referenz-Rechnung)
pub fn apply_adjust(src: &[f32], w: usize, h: usize, a: &Adjust) -> Vec<f32> {
    let mut g = vec![0.0f32; src.len()];
    let span = mx(0.02, a.white - a.black);
    let inv = 1.0 / mx(0.1, a.gamma);
    let c = if a.contrast >= 0.0 { 1.0 + a.contrast / 50.0 } else { 1.0 + a.contrast / 100.0 }; // -100 → flach, +100 → 3-fach
    let b = a.brightness / 200.0;
    g.par_iter_mut().zip(src.par_iter()).for_each(|(o, &p)| {
        let mut v = mn(1.0, mx(0.0, (p as f64 - a.black) / span));
        v = jsmath::pow(v, inv);
        v = (v - 0.5) * c + 0.5 + b;
        *o = mn(1.0, mx(0.0, v)) as f32;
    });
    if !curve_is_identity(a.curve.as_ref()) {
        let lut = curve_lut(a.curve.as_ref().unwrap());
        g.par_iter_mut().for_each(|v| {
            let f = *v as f64 * 255.0;
            if f.is_nan() {
                *v = f32::NAN;
                return;
            }
            let k = mn(254.0, f.floor()) as usize;
            *v = (lut[k] as f64 + (lut[k + 1] as f64 - lut[k] as f64) * (f - k as f64)) as f32;
        });
    }
    if let Some(local) = a.local {
        if local > 0.0 {
            g = local_contrast(&g, w, h, local);
        }
    }
    if a.denoise > 0.0 {
        g = blur(&g, w, h, js_round(a.denoise));
    }
    if a.sharpen > 0.0 {
        let soft = blur(&g, w, h, 1.0);
        let k = a.sharpen / 40.0;
        g.par_iter_mut().zip(soft.par_iter()).for_each(|(o, &sf)| {
            let v = *o as f64;
            *o = mn(1.0, mx(0.0, v + k * (v - sf as f64))) as f32;
        });
    }
    if a.invert {
        for v in g.iter_mut() {
            *v = (1.0 - *v as f64) as f32;
        }
    }
    g
}

/// Lokaler Kontrast: Unterschied zur weichgezeichneten Umgebung verstärken, mit Schutz vor hellen Säumen
fn local_contrast(g: &[f32], w: usize, h: usize, amount: f64) -> Vec<f32> {
    let r = mx(2.0, js_round(w.max(h) as f64 * 0.04));
    let amount = mn(100.0, mx(0.0, amount));
    let base = blur(g, w, h, r);
    let k = (amount / 100.0) * 1.6;
    let (lim_up, lim_down) = (0.06 + 0.06 * (amount / 100.0), 0.18);
    let mut out = vec![0.0f32; g.len()];
    out.par_iter_mut().zip(g.par_iter().zip(base.par_iter())).for_each(|(o, (&p, &bs))| {
        let v = p as f64;
        let d = (v - bs as f64) * k;
        let lim = if d > 0.0 { lim_up * (1.0 - 0.7 * mx(0.0, v - 0.8) / 0.2) } else { lim_down };
        *o = mn(1.0, mx(0.0, v + d / (1.0 + d.abs() / mx(0.01, lim)))) as f32;
    });
    out
}

// ---------------------------------------------------------------------
// Rasterverfahren
// ---------------------------------------------------------------------

/// Kern der Fehlerverteilung: Teiler und [dx, dy, Gewicht]
fn kernel(method: &str) -> (f64, &'static [[i64; 3]]) {
    match method {
        "jarvis" => (48.0, &[[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]]),
        "stucki" => (42.0, &[[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]]),
        "atkinson" => (8.0, &[[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]]),
        "sierra" => (32.0, &[[1, 0, 5], [2, 0, 3], [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2], [-1, 2, 2], [0, 2, 3], [1, 2, 2]]),
        // „floyd“ und alles Unbekannte
        _ => (16.0, &[[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]]),
    }
}

/// Bayer-Matrix 8×8 (Schwellen 0…1)
fn bayer8() -> [[f64; 8]; 8] {
    let mut cur: Vec<Vec<f64>> = vec![vec![0.0]];
    let mut n = 1;
    while n < 8 {
        let mut nx: Vec<Vec<f64>> = Vec::new();
        for y in 0..n * 2 {
            let mut row = Vec::new();
            for x in 0..n * 2 {
                let add = [0.0, 2.0, 3.0, 1.0][(if y < n { 0 } else { 2 }) + (if x < n { 0 } else { 1 })];
                row.push(cur[y % n][x % n] * 4.0 + add);
            }
            nx.push(row);
        }
        cur = nx;
        n *= 2;
    }
    let mut out = [[0.0; 8]; 8];
    for y in 0..8 {
        for x in 0..8 {
            out[y][x] = (cur[y][x] + 0.5) / 64.0;
        }
    }
    out
}

/// Graustufen (0 = schwarz) → burn 0…1 (1 = Laser an)
pub fn rasterize(g: &[f32], w: usize, h: usize, s: &Raster) -> Vec<f32> {
    let pi = std::f64::consts::PI;
    let mut out = vec![0.0f32; g.len()];
    let on = |b: bool| if b { 1.0f32 } else { 0.0 };
    match s.method.as_str() {
        "gray" => {
            for i in 0..g.len() {
                out[i] = (1.0 - g[i] as f64) as f32;
            }
            return out;
        }
        "threshold" => {
            for i in 0..g.len() {
                out[i] = on((g[i] as f64) < s.threshold);
            }
            return out;
        }
        "bayer" => {
            let bayer = bayer8();
            for y in 0..h {
                for x in 0..w {
                    out[y * w + x] = on(1.0 - g[y * w + x] as f64 > bayer[y & 7][x & 7]);
                }
            }
            return out;
        }
        "halftone" | "lines" => {
            let lines = s.method == "lines";
            let cell = mx(2.0, s.cell);
            let a = (s.angle * pi) / 180.0;
            let (ca, sa) = (jsmath::cos(a), jsmath::sin(a));
            // Helligkeit geglättet, damit die Punkte rund und die Linien ruhig bleiben
            let soft = blur(g, w, h, mx(1.0, js_round(cell / 3.0)));
            for y in 0..h {
                for x in 0..w {
                    let (xf, yf) = (x as f64 + 0.5, y as f64 + 0.5);
                    let (u, v) = (xf * ca + yf * sa, -xf * sa + yf * ca);
                    let (cu, cv) = (((u / cell).floor() + 0.5) * cell, ((v / cell).floor() + 0.5) * cell);
                    if lines {
                        // Linie beginnt am Zellrand und ist so dick wie die Dunkelheit
                        out[y * w + x] = on(v - (cv - cell / 2.0) < (1.0 - soft[y * w + x] as f64) * cell);
                        continue;
                    }
                    // Zellmitte zurück ins Bild → Helligkeit dort
                    let px = mn(w as f64 - 1.0, mx(0.0, js_round(cu * ca - cv * sa)));
                    let py = mn(h as f64 - 1.0, mx(0.0, js_round(cu * sa + cv * ca)));
                    let d = 1.0 - soft[py as usize * w + px as usize] as f64;
                    // Fläche des Punktes = Dunkelheit; ab ~78 % wachsen die Punkte zusammen
                    let r = (d / pi).sqrt() * cell * (if d > 0.78 { 1.0 + (d - 0.78) } else { 1.0 });
                    out[y * w + x] = on(hypot2(u - cu, v - cv) < r);
                }
            }
            return out;
        }
        "stipple" | "spiral" | "waves" | "crosshatch" => return effect(g, w, h, s, out),
        _ => {}
    }
    // Fehlerverteilung, Zeilen abwechselnd von links und von rechts
    let (kd, k) = kernel(&s.method);
    let mut e: Vec<f32> = g.iter().map(|&v| (1.0 - v as f64) as f32).collect();
    let (wi, hi) = (w as i64, h as i64);
    for y in 0..hi {
        let rtl = y % 2 == 1;
        for j in 0..wi {
            let x = if rtl { wi - 1 - j } else { j };
            let i = (y * wi + x) as usize;
            let v = e[i] as f64;
            let lit = if v >= 0.5 { 1.0 } else { 0.0 };
            out[i] = lit as f32;
            let err = v - lit;
            if err == 0.0 || err.is_nan() {
                continue;
            }
            for t in k {
                let xx = if rtl { x - t[0] } else { x + t[0] };
                let yy = y + t[1];
                if xx < 0 || xx >= wi || yy >= hi {
                    continue;
                }
                let q = (yy * wi + xx) as usize;
                e[q] = (e[q] as f64 + (err * t[2] as f64) / kd) as f32;
            }
        }
    }
    out
}

/// Pseudo-Zufall 0…1 je Zelle (immer gleich → Vorschau und G-Code stimmen überein)
fn hash(a: f64, b: f64) -> f64 {
    // (a * 374761393 + b * 668265263) | 0  – die Summe ist als Kommazahl genau, dann auf 32 Bit gekürzt
    let sum = a * 374761393.0 + b * 668265263.0;
    let mut x = if sum.is_finite() { sum.trunc().rem_euclid(4294967296.0) as u64 as u32 } else { 0 };
    x = (x ^ (x >> 13)).wrapping_mul(1274126177);
    (x ^ (x >> 16)) as f64 / 4294967296.0
}

/// Bildeffekte: getupft, Spirale, Wellen, Kreuzschraffur
fn effect(g: &[f32], w: usize, h: usize, s: &Raster, mut out: Vec<f32>) -> Vec<f32> {
    let pi = std::f64::consts::PI;
    let bayer = bayer8();
    let cell = mx(2.0, s.cell);
    let soft = blur(g, w, h, mx(1.0, js_round(cell / 3.0)));
    let a = (s.angle * pi) / 180.0;
    let (ca, sa) = (jsmath::cos(a), jsmath::sin(a));
    // Kante einer Linie: der angeschnittene Bildpunkt wird nach Bayer-Raster an/aus gesetzt
    let edge = |dist: f64, half: f64, x: usize, y: usize| -> f32 {
        let cov = mn(1.0, mx(0.0, half - dist + 0.5));
        if cov > bayer[y & 7][x & 7] {
            1.0
        } else {
            0.0
        }
    };
    let dark = |x: f64, y: f64| -> f64 {
        let yy = mn(h as f64 - 1.0, mx(0.0, js_round(y)));
        let xx = mn(w as f64 - 1.0, mx(0.0, js_round(x)));
        if yy.is_nan() || xx.is_nan() {
            return f64::NAN;
        }
        1.0 - soft[yy as usize * w + xx as usize] as f64
    };
    match s.method.as_str() {
        "stipple" => {
            // jede Zelle: ein Punkt an verwackelter Stelle, Fläche = Dunkelheit (Nachbarzellen mitprüfen)
            for y in 0..h {
                for x in 0..w {
                    let (cx0, cy0) = ((x as f64 / cell).floor(), (y as f64 / cell).floor());
                    let mut lit = false;
                    'cells: for j in -1..=1 {
                        for i in -1..=1 {
                            let (cx, cy) = (cx0 + i as f64, cy0 + j as f64);
                            let px = (cx + 0.2 + 0.6 * hash(cx, cy)) * cell;
                            let py = (cy + 0.2 + 0.6 * hash(cy + 7919.0, cx)) * cell;
                            let d = dark(px, py);
                            if d < 0.02 {
                                continue;
                            }
                            let r = (d / pi).sqrt() * cell * 1.05;
                            if hypot2(x as f64 + 0.5 - px, y as f64 + 0.5 - py) < r {
                                lit = true;
                                break 'cells;
                            }
                        }
                    }
                    out[y * w + x] = if lit { 1.0 } else { 0.0 };
                }
            }
        }
        "spiral" => {
            // archimedische Spirale ab der Bildmitte, Windungsabstand = cell, Linie so dick wie die Dunkelheit
            let (mid_x, mid_y) = (w as f64 / 2.0, h as f64 / 2.0);
            for y in 0..h {
                for x in 0..w {
                    let (dx, dy) = (x as f64 + 0.5 - mid_x, y as f64 + 0.5 - mid_y);
                    let r = hypot2(dx, dy);
                    let th = jsmath::atan2(dy, dx) + a;
                    let f = ((r - (th / (2.0 * pi)) * cell) % cell + cell) % cell; // 0…cell: Lage zwischen zwei Windungen
                    out[y * w + x] = edge((f - cell / 2.0).abs(), (dark(x as f64, y as f64) * cell) / 2.0, x, y);
                }
            }
        }
        "waves" => {
            for y in 0..h {
                for x in 0..w {
                    let (xf, yf) = (x as f64 + 0.5, y as f64 + 0.5);
                    let (u, v) = (xf * ca + yf * sa, -xf * sa + yf * ca);
                    let vv = v + jsmath::sin((u / (cell * 3.0)) * 2.0 * pi) * cell * 0.6;
                    let f = ((vv % cell) + cell) % cell;
                    out[y * w + x] = edge((f - cell / 2.0).abs(), (dark(x as f64, y as f64) * cell) / 2.0, x, y);
                }
            }
        }
        _ => {
            // Kreuzschraffur: Lagen ab 15 %, 40 %, 65 %, 85 % Dunkelheit
            let layers = [a + pi / 4.0, a - pi / 4.0, a, a + pi / 2.0];
            let from = [0.15, 0.4, 0.65, 0.85];
            let sc: Vec<(f64, f64)> = layers.iter().map(|&l| (jsmath::sin(l), jsmath::cos(l))).collect();
            for y in 0..h {
                for x in 0..w {
                    let d = dark(x as f64, y as f64);
                    let mut lit = false;
                    for k in 0..4 {
                        if d < from[k] {
                            break;
                        }
                        let v = -(x as f64 + 0.5) * sc[k].0 + (y as f64 + 0.5) * sc[k].1;
                        if ((v % cell) + cell) % cell < 1.0 {
                            lit = true;
                            break;
                        }
                    }
                    out[y * w + x] = if lit { 1.0 } else { 0.0 };
                }
            }
        }
    }
    out
}

/// Der ganze Ablauf: umrechnen → verbessern → rastern. `base` = Graustufen des Quellbilds (sw × sh)
pub fn run(base: &[f32], job: &Job) -> Result<Vec<f32>, String> {
    let cells = job.gw.checked_mul(job.gh).ok_or("size")?;
    if job.sw == 0 || job.sh == 0 || job.gw == 0 || job.gh == 0 || base.len() != job.sw * job.sh || cells > 200_000_000 {
        return Err("image size does not fit the data".into());
    }
    let g = apply_adjust(&resample(base, job.sw, job.sh, job.gw, job.gh), job.gw, job.gh, &job.adjust);
    Ok(rasterize(&g, job.gw, job.gh, &job.raster))
}

/// Ergebnis als Bytes für das Fenster (Little Endian), gelesen in src/raster/rasterRust.ts:
///   u32 gw · u32 gh · u32 Art (0 = je Punkt ein Byte 0/1, 1 = je Punkt eine 32-Bit-Zahl) · u32 0 · Daten
pub fn encode(burn: &[f32], gw: usize, gh: usize) -> Vec<u8> {
    let binary = burn.iter().all(|&v| v == 0.0 || v == 1.0);
    let mut out = Vec::with_capacity(16 + burn.len() * if binary { 1 } else { 4 });
    for v in [gw as u32, gh as u32, !binary as u32, 0] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    if binary {
        out.extend(burn.iter().map(|&v| v as u8));
    } else {
        for v in burn {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    out
}

/// Graustufen aus den Bytes des Fensters (32-Bit-Zahlen, Little Endian)
pub fn floats(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|q| f32::from_le_bytes([q[0], q[1], q[2], q[3]])).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn no_adjust() -> Adjust {
        Adjust { black: 0.0, white: 1.0, gamma: 1.0, brightness: 0.0, contrast: 0.0, sharpen: 0.0, denoise: 0.0, invert: false, local: None, curve: None }
    }
    fn raster(method: &str) -> Raster {
        Raster { method: method.into(), threshold: 0.5, cell: 6.0, angle: 0.0 }
    }

    #[test]
    fn error_diffusion_keeps_the_mean_brightness() {
        let (w, h) = (80, 60);
        let g = vec![0.7f32; w * h];
        for m in ["floyd", "jarvis", "stucki", "sierra"] {
            let b = rasterize(&g, w, h, &raster(m));
            assert!(b.iter().all(|&v| v == 0.0 || v == 1.0));
            let on = b.iter().sum::<f32>() as f64 / (w * h) as f64;
            assert!((on - 0.3).abs() < 0.02, "{m}: {on}");
        }
    }

    #[test]
    fn resample_area_and_bilinear() {
        let src = vec![0.0f32, 1.0, 1.0, 0.0];
        assert_eq!(resample(&src, 2, 2, 1, 1), vec![0.5]);
        let up = resample(&[0.0, 1.0], 2, 1, 4, 1);
        assert_eq!(up, vec![0.0, 0.25, 0.75, 1.0]);
    }

    #[test]
    fn no_adjust_changes_nothing_and_invert_flips() {
        let g = vec![0.1f32, 0.5, 0.9, 0.0];
        assert_eq!(apply_adjust(&g, 2, 2, &no_adjust()), g);
        let inv = apply_adjust(&g, 2, 2, &Adjust { invert: true, ..no_adjust() });
        assert!((inv[0] - 0.9).abs() < 1e-6 && inv[3] == 1.0);
    }

    #[test]
    fn encode_binary_and_gray() {
        let b = encode(&[0.0, 1.0, 1.0, 0.0], 2, 2);
        assert_eq!(b.len(), 20);
        assert_eq!(&b[8..12], &0u32.to_le_bytes());
        let g = encode(&[0.0, 0.25, 1.0, 0.0], 2, 2);
        assert_eq!(g.len(), 32);
        assert_eq!(&g[8..12], &1u32.to_le_bytes());
        assert_eq!(floats(&g[16..]), vec![0.0, 0.25, 1.0, 0.0]);
    }

    #[test]
    fn wrong_sizes_are_refused() {
        let job = Job { sw: 2, sh: 2, gw: 2, gh: 2, adjust: no_adjust(), raster: raster("gray") };
        assert!(run(&[0.0; 3], &job).is_err());
        assert!(run(&[0.0; 4], &Job { gw: 0, ..job.clone() }).is_err());
        assert_eq!(run(&[0.0, 1.0, 0.5, 0.25], &job).unwrap(), vec![1.0, 0.0, 0.5, 0.75]);
    }

    // ---- Vergleich mit dem TypeScript: dieselben Fälle ----

    fn fixture(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures").join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    /// Testbild wie in tests/imgRasterRust.test.ts: Verlauf, Rechtecke, Kreis und Rauschen – nur Grundrechenarten
    /// und ganzzahliger Zufall, damit beide Seiten dieselben Zahlen haben
    pub fn test_image(w: usize, h: usize, seed: u32) -> Vec<f32> {
        let mut s = seed;
        let mut rnd = || {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            s as f64 / 4294967296.0
        };
        let mut g = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let (u, v) = (x as f64 / w as f64, y as f64 / h as f64);
                let mut val = 0.15 + 0.7 * u * (1.0 - 0.5 * v);
                if u > 0.2 && u < 0.45 && v > 0.3 && v < 0.7 {
                    val = 0.05;
                }
                if u > 0.6 && u < 0.9 && v > 0.1 && v < 0.35 {
                    val = 0.95;
                }
                let (dx, dy) = (u - 0.7, v - 0.7);
                if dx * dx + dy * dy < 0.03 {
                    val = 0.5 + 0.4 * (dx + dy) * 4.0;
                }
                val += (rnd() - 0.5) * 0.08;
                g[y * w + x] = (if val < 0.0 { 0.0 } else if val > 1.0 { 1.0 } else { val }) as f32;
            }
        }
        g
    }

    /// FNV-1a über die Bytes der 32-Bit-Zahlen (dieselbe Prüfsumme wie im TypeScript-Test)
    pub fn fnv(v: &[f32]) -> u32 {
        let mut hsh = 0x811c9dc5u32;
        for x in v {
            for b in x.to_le_bytes() {
                hsh = (hsh ^ b as u32).wrapping_mul(16777619);
            }
        }
        hsh
    }

    fn job_of(c: &Value) -> Job {
        serde_json::from_value(c["job"].clone()).unwrap()
    }

    #[test]
    fn same_result_as_typescript() {
        let cases: Value = serde_json::from_str(&fixture("imgraster-cases.json")).unwrap();
        let expected: Value = serde_json::from_str(&fixture("imgraster-expected.json")).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 40);
        let (mut pixels, mut differ) = (0usize, 0usize);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let want = expected.get(name).unwrap_or_else(|| panic!("{name}: no expected result (run UPDATE_FIXTURES=1 npm test)"));
            let job = job_of(c);
            let base = test_image(job.sw, job.sh, c["seed"].as_u64().unwrap() as u32);
            assert_eq!(fnv(&base) as u64, want["image"].as_u64().unwrap(), "{name}: the test image differs from the TypeScript one");
            let small = resample(&base, job.sw, job.sh, job.gw, job.gh);
            assert_eq!(fnv(&small) as u64, want["resampled"].as_u64().unwrap(), "{name}: resample");
            let g = apply_adjust(&small, job.gw, job.gh, &job.adjust);
            assert_eq!(fnv(&g) as u64, want["adjusted"].as_u64().unwrap(), "{name}: adjust");
            let burn = rasterize(&g, job.gw, job.gh, &job.raster);
            assert_eq!(burn, run(&base, &job).unwrap(), "{name}: run() is the three steps");
            pixels += burn.len();
            // Verfahren mit Winkelfunktionen: einzelne Kanten-Punkte dürfen abweichen (höchstens 1 von 2000)
            if let Some(bits) = want["bits"].as_str() {
                let wanted: Vec<bool> = bits.bytes().map(|b| b == b'1').collect();
                assert_eq!(wanted.len(), burn.len(), "{name}: size");
                let d = burn.iter().zip(&wanted).filter(|(b, w)| (**b >= 0.5) != **w).count();
                assert!(d * 2000 <= burn.len(), "{name}: {d} of {} pixels differ", burn.len());
                differ += d;
            } else {
                assert_eq!(fnv(&burn) as u64, want["burn"].as_u64().unwrap(), "{name}: burn");
            }
            if want["bits"].is_null() {
                assert_eq!(burn.iter().filter(|&&b| b >= 0.5).count() as u64, want["on"].as_u64().unwrap(), "{name}: pixels on");
            }
        }
        println!("{} cases, {pixels} pixels: {differ} differ from TypeScript", cases.len());
    }

    /// Großer Vergleich mit einem eigenen Bild (nicht im Repository). Erst schreibt das TypeScript daneben:
    /// IMGRASTER_COMPARE=<Ordner mit *.gray + *.json> node --test tests/imgRasterRust.test.ts
    /// IMGRASTER_COMPARE=<derselbe Ordner> cargo test --release imgraster -- --ignored --nocapture
    #[test]
    #[ignore]
    fn same_result_as_typescript_on_local_files() {
        let dir = std::env::var("IMGRASTER_COMPARE").expect("IMGRASTER_COMPARE = folder");
        let mut count = 0;
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = e.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".expected.json")) else { continue };
            let want: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let job = job_of(&want);
            let base = floats(&std::fs::read(path.with_file_name(want["gray"].as_str().unwrap())).unwrap());
            let t = std::time::Instant::now();
            let small = resample(&base, job.sw, job.sh, job.gw, job.gh);
            let t1 = t.elapsed().as_secs_f64() * 1000.0;
            let g = apply_adjust(&small, job.gw, job.gh, &job.adjust);
            let t2 = t.elapsed().as_secs_f64() * 1000.0;
            let burn = rasterize(&g, job.gw, job.gh, &job.raster);
            let t3 = t.elapsed().as_secs_f64() * 1000.0;
            let lit = burn.iter().filter(|&&b| b >= 0.5).count() as u64;
            println!(
                "{name}: {} x {} – resample {:.0} ms, adjust {:.0} ms, raster {:.0} ms, total {:.0} ms in Rust; resample {}, adjust {}, burn {} ({} of {} on, TypeScript {})",
                job.gw, job.gh, t1, t2 - t1, t3 - t2, t3,
                if fnv(&small) as u64 == want["resampled"].as_u64().unwrap() { "same" } else { "DIFFERENT" },
                if fnv(&g) as u64 == want["adjusted"].as_u64().unwrap() { "same" } else { "DIFFERENT" },
                if fnv(&burn) as u64 == want["burn"].as_u64().unwrap() { "same" } else { "DIFFERENT" },
                lit, burn.len(), want["on"]
            );
            count += 1;
        }
        assert!(count > 0, "no *.expected.json in {dir}");
    }
}
