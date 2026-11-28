//! WERKZEUG-BILDER: Fräser als 3D-Körper mit Spannuten und als gerechnetes Bild (nur Anzeige, keine Kollisionsprüfung)
//!
//! Das ist die Rechnung, die in der App läuft. Dieselbe Rechnung gibt es noch einmal in TypeScript
//! (`src/sim/toolMesh.ts`, `src/toolRender.ts`) für die Vorschau im Browser und die Tests ohne Rust –
//! beide müssen gleich bleiben (die Tests auf beiden Seiten prüfen dieselben Zahlen).
//!
//!   sweep          – Körper aus einem Umriss (r, z), auf Wunsch mit Nuten; glatte Flächen, scharfe Kanten
//!   cutter_look    – Anzahl Nuten, Kerndicke und Drall je Werkzeugart
//!   mill_tool_mesh – Fräser + Schaft (fest) und Spannmutter + Spindelnase (halb durchsichtig) für die Simulation
//!   library_mesh   – Fräser für die Werkzeug-Bibliothek, auf Wunsch mit Farbring am Schaft
//!   rasterize      – Dreiecke in ein Pixelbild rechnen (von der Seite oder von unten, ohne Perspektive = maßstäblich)
//!
//! Jeder Punkt: 10 Zahlen (Ort, Normale, Farbe, Deckkraft). Deckkraft über 1 heißt „blankes Metall“.

use serde::Deserialize;
use std::f64::consts::PI;

type Rgb = [f64; 3];
const STEEL: Rgb = [0.74, 0.76, 0.8];
const NUT: Rgb = [0.5, 0.53, 0.58];
const SPINDLE: Rgb = [0.3, 0.33, 0.4];

/// Farbe des Fräsers je Beschichtung – gleiche Tabelle wie COATING_RGB in toolCoating.ts
fn coating_rgb(c: Option<&str>) -> Rgb {
    match c.unwrap_or("none") {
        "tin" => [0.86, 0.68, 0.27],
        "tialn" => [0.33, 0.27, 0.37],
        "altin" => [0.24, 0.24, 0.27],
        "alcrn" => [0.47, 0.5, 0.56],
        "crn" => [0.74, 0.75, 0.77],
        "zrn" => [0.87, 0.81, 0.55],
        "dlc" => [0.15, 0.15, 0.17],
        _ => [0.66, 0.68, 0.72],
    }
}

/// Die Angaben vom Werkzeug, die das Bild braucht (der Rest des Werkzeugs wird überlesen)
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub diameter: f64,
    #[serde(default)]
    pub flutes: f64,
    #[serde(default)]
    pub helix: Option<String>,
    #[serde(default)]
    pub coating: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Holder {
    pub r: f64,
    pub shank_r: f64,
    pub flute_len: f64,
    pub stickout: f64,
    pub holder_r: f64,
    pub holder_h: f64,
    pub spindle_r: f64,
    pub spindle_h: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Look {
    pub flutes: f64,
    pub core: f64,
    pub rate: f64,
    /// Kompressionsfräser: bis zu dieser Höhe Rechtsdrall, darüber Linksdrall; fehlt = nie
    #[serde(default)]
    pub split: Option<f64>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct MillJob {
    pub tool: Option<Tool>,
    pub holder: Holder,
    pub outline: Vec<[f64; 2]>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct CutterJob {
    pub outline: Vec<[f64; 2]>,
    pub look: Look,
}

#[derive(Deserialize, Clone, Debug)]
pub struct PictureJob {
    pub tool: Tool,
    pub cut: Vec<[f64; 2]>,
    pub rest: Vec<[f64; 2]>,
    pub ring: Option<[f64; 3]>,
    /// "side" = von vorn, "end" = von unten auf die Spitze
    pub view: String,
    /// Ausschnitt in mm, der das ganze Bild füllt: x0, x1, y0, y1
    pub frame: [f64; 4],
    pub w: u32,
    pub h: u32,
}

/// Körper aus einem Umriss: Flächen weich schattiert, Knicke im Umriss bleiben scharfe Kanten
pub fn sweep(out: &mut Vec<f32>, pts: &[[f64; 2]], seg: usize, col: Rgb, alpha: f64, factor: Option<&dyn Fn(f64, f64) -> f64>) {
    if pts.len() < 2 || seg < 3 {
        return;
    }
    let k_max = pts.len() - 1;
    let p = |k: usize, th: f64| -> [f64; 3] {
        let [r, z] = pts[k];
        let rr = match factor {
            Some(f) => r * f(th, z),
            None => r,
        };
        [rr * th.cos(), rr * th.sin(), z]
    };
    let cos_crease = (28.0 * PI / 180.0).cos();
    let smooth: Vec<bool> = (0..=k_max)
        .map(|k| {
            if k == 0 || k == k_max {
                return false;
            }
            let (ax, az) = (pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
            let (bx, bz) = (pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
            let (la, lb) = (ax.hypot(az), bx.hypot(bz));
            la > 1e-9 && lb > 1e-9 && (ax * bx + az * bz) / (la * lb) > cos_crease
        })
        .collect();
    let dth = 2.0 * PI / seg as f64;
    let eps = dth * 0.5;
    // Normale am Punkt k für die Reihe row (row = k oder k − 1)
    let normal = |k: usize, row: usize, th: f64| -> [f64; 3] {
        let (a, b) = (p(k, th - eps), p(k, th + eps));
        let (c, d) = if smooth[k] { (p(k - 1, th), p(k + 1, th)) } else { (p(row, th), p(row + 1, th)) };
        let (tx, ty, tz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        let (kx, ky, kz) = (d[0] - c[0], d[1] - c[1], d[2] - c[2]);
        let (nx, ny, nz) = (ty * kz - tz * ky, tz * kx - tx * kz, tx * ky - ty * kx);
        let l = (nx * nx + ny * ny + nz * nz).sqrt();
        if l < 1e-12 {
            // in der Mitte (r = 0) gibt es keine Richtung rundherum: Normale des Umriss-Stücks nehmen
            let (dr, dz) = (pts[row + 1][0] - pts[row][0], pts[row + 1][1] - pts[row][1]);
            let m = dr.hypot(dz);
            let m = if m == 0.0 { 1.0 } else { m };
            return [dz / m * th.cos(), dz / m * th.sin(), -dr / m];
        }
        [nx / l, ny / l, nz / l]
    };
    let mut v = |p: &[f64; 3], n: &[f64; 3]| {
        out.extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32, n[0] as f32, n[1] as f32, n[2] as f32, col[0] as f32, col[1] as f32, col[2] as f32, alpha as f32]);
    };
    for k in 0..k_max {
        if (pts[k][0] - pts[k + 1][0]).abs() < 1e-9 && (pts[k][1] - pts[k + 1][1]).abs() < 1e-9 {
            continue;
        }
        let (mut p0, mut p1, mut n0, mut n1) = (p(k, 0.0), p(k + 1, 0.0), normal(k, k, 0.0), normal(k + 1, k, 0.0));
        for j in 0..seg {
            let th = (j + 1) as f64 * dth;
            let (q0, q1, m0, m1) = (p(k, th), p(k + 1, th), normal(k, k, th), normal(k + 1, k, th));
            v(&p0, &n0);
            v(&q0, &m0);
            v(&q1, &m1);
            v(&p0, &n0);
            v(&q1, &m1);
            v(&p1, &n1);
            p0 = q0;
            p1 = q1;
            n0 = m0;
            n1 = m1;
        }
    }
}

/// Querschnitt einer Nut: u = Stelle innerhalb eines Zahns (0…1). Bei 0 liegt die Schneidkante (voller Radius),
/// dahinter fällt der Rücken zum Kern ab, am Ende steigt die Spanfläche des nächsten Zahns steil wieder an.
pub fn flute_section(u: f64, core: f64) -> f64 {
    let u = u - u.floor();
    if u < 0.1 {
        1.0 - 0.04 * (u / 0.1)
    } else if u < 0.6 {
        0.96 + (core - 0.96) * (0.5 - 0.5 * (PI * (u - 0.1) / 0.5).cos())
    } else if u < 0.8 {
        core
    } else {
        core + (1.0 - core) * ((u - 0.8) / 0.2).powf(1.6)
    }
}

/// Aussehen der Schneiden je Werkzeugart – R und Schneidenlänge in mm
pub fn cutter_look(tl: Option<&Tool>, r: f64, flute_len: f64) -> Look {
    let kind = tl.map(|t| t.kind.as_str()).filter(|k| !k.is_empty()).unwrap_or("endmill");
    let raw = tl.map(|t| t.flutes).filter(|f| f.is_finite() && *f != 0.0).unwrap_or(2.0);
    let flutes = (raw + 0.5).floor().clamp(1.0, 8.0);
    let by_count = (0.445 + 0.056 * flutes).min(0.74);
    let helix = |deg: f64| (deg * PI / 180.0).tan() / r.max(0.05);
    let straight = |flutes: f64, core: f64| Look { flutes, core, rate: 0.0, split: None };
    match kind {
        "drill" => return Look { flutes: flutes.max(2.0), core: 0.34, rate: helix(28.0), split: None },
        "spotdrill" => return straight(flutes.max(2.0), 0.42),
        "vbit" | "chamfer" | "countersink" => return straight(flutes, 0.55),
        "reamer" => return straight(flutes, 0.84),
        "facemill" => return straight(flutes, 0.82),
        "threadmill" => return straight(flutes, 0.62),
        _ => {}
    }
    let rate = helix(30.0);
    match tl.and_then(|t| t.helix.as_deref()).unwrap_or("up") {
        "straight" => straight(flutes, by_count),
        "compression" => Look { flutes, core: by_count, rate, split: Some(flute_len * 0.35) },
        "down" => Look { flutes, core: by_count, rate: -rate, split: None },
        _ => Look { flutes, core: by_count, rate, split: None },
    }
}

/// Schneidenteil: Umriss von der Spitze (z = 0) bis oben an die Schneiden; oben laufen die Nuten aus
pub fn cutter_mesh(out: &mut Vec<f32>, outline: &[[f64; 2]], look: &Look, col: Rgb, alpha: f64) {
    if outline.len() < 2 {
        return;
    }
    let top = outline[outline.len() - 1][1];
    let r = outline.iter().fold(0.05f64, |m, p| m.max(p[0]));
    let fade = (r * 1.2).min(top * 0.3).max(0.2);
    let split = look.split.unwrap_or(f64::INFINITY);
    let rate = look.rate;
    let flutes = look.flutes.clamp(1.0, 8.0);
    let period = 2.0 * PI / flutes;
    let core = look.core;
    let factor = move |th: f64, z: f64| -> f64 {
        let x = ((top - z) / fade).clamp(0.0, 1.0);
        let open = x * x * (3.0 - 2.0 * x);
        if open <= 0.0 {
            return 1.0;
        }
        let tw = if z <= split { rate * z } else { rate * (2.0 * split - z) };
        1.0 - (1.0 - flute_section((th - tw) / period, core)) * open
    };
    // Umriss so fein teilen, dass sich die Nut von Schritt zu Schritt höchstens ~11° weiterdreht
    let mut pts = vec![outline[0]];
    for k in 1..outline.len() {
        let ([r0, z0], [r1, z1]) = (outline[k - 1], outline[k]);
        let dz = (z1 - z0).abs();
        let n = (rate.abs() * dz / 0.2).max(dz * 4.0 / fade).ceil().clamp(1.0, 120.0) as usize;
        for i in 1..=n {
            let t = i as f64 / n as f64;
            pts.push([r0 + (r1 - r0) * t, z0 + (z1 - z0) * t]);
        }
    }
    let seg = if flutes <= 2.0 { 48 } else { ((flutes * 20.0) as usize).min(96) };
    sweep(out, &pts, seg, col, alpha, Some(&factor));
}

/// Fräser + Schaft (undurchsichtig) und Spannmutter + Spindelnase (halb durchsichtig), Spitze bei 0
pub fn mill_tool_mesh(tl: Option<&Tool>, hd: &Holder, outline: &[[f64; 2]]) -> (Vec<f32>, Vec<f32>) {
    let (mut solid, mut ghost) = (Vec::new(), Vec::new());
    let col = coating_rgb(tl.and_then(|t| t.coating.as_deref()));
    cutter_mesh(&mut solid, outline, &cutter_look(tl, hd.r, hd.flute_len), col, 2.0);
    // Übergang zum Schaft: schräg statt als Stufe, soweit Platz bis zur Spannzange ist
    let (fl, zt) = (hd.flute_len, hd.stickout);
    let zs = zt + hd.holder_h;
    let neck = (hd.r - hd.shank_r).abs().min(zt - fl - 0.5).max(0.0);
    // die Beschichtung sitzt nur auf den Schneiden – der Schaft bleibt blank
    sweep(&mut solid, &[[hd.r, fl], [hd.shank_r, fl + neck], [hd.shank_r, zt + 1.0]], 48, STEEL, 2.0, None);
    // Spannmutter (ER-Form: unten angefast, oben Bund) und Spindelnase
    let h = hd.holder_r;
    let bevel = (h * 0.3).min(hd.holder_h * 0.4);
    sweep(&mut ghost, &[[hd.shank_r, zt], [h * 0.7, zt], [h, zt + bevel], [h, zs - 1.5], [h * 0.9, zs]], 48, NUT, 1.55, None);
    let s = hd.spindle_r;
    let nose = (h * 1.08).min(s);
    sweep(&mut ghost, &[[h * 0.9, zs], [nose, zs], [nose, zs + 6.0], [s, zs + 10.0], [s, zs + hd.spindle_h], [0.0, zs + hd.spindle_h]], 48, SPINDLE, 1.4, None);
    (solid, ghost)
}

/// Fräser für die Bibliothek: Schneiden (cut, Spitze bei 0) und der Rest bis oben (rest), auf Wunsch mit Farbring am Schaft
pub fn library_mesh(g: &Tool, cut: &[[f64; 2]], rest: &[[f64; 2]], ring: Option<Rgb>) -> Vec<f32> {
    let mut out = Vec::new();
    if cut.len() < 2 {
        return out;
    }
    let col = coating_rgb(g.coating.as_deref());
    let top = cut[cut.len() - 1][1];
    cutter_mesh(&mut out, cut, &cutter_look(Some(g), g.diameter / 2.0, top), col, 2.0);
    if rest.len() > 1 {
        let end = rest[rest.len() - 1];
        let before = rest[rest.len() - 2];
        let (rs, len) = (end[0], end[1] - before[1]);
        // Farbring wie bei gekennzeichneten Werkzeugen: oben am Schaft, in der Farbe des Werkzeugs
        let h = (len * 0.22).min((rs * 1.2).max(1.5));
        let z1 = end[1] - (len * 0.12).min(rs);
        let z0 = z1 - h;
        match ring {
            Some(c) if len > 2.0 && z0 > before[1] => {
                let mut a: Vec<[f64; 2]> = rest[..rest.len() - 1].to_vec();
                a.push([rs, z0]);
                sweep(&mut out, &a, 48, STEEL, 2.0, None);
                sweep(&mut out, &[[rs, z0], [rs, z1]], 48, c, 1.0, None);
                sweep(&mut out, &[[rs, z1], end, [0.0, end[1]]], 48, STEEL, 2.0, None);
            }
            _ => {
                let mut a = rest.to_vec();
                a.push([0.0, end[1]]);
                sweep(&mut out, &a, 48, STEEL, 2.0, None);
            }
        }
    }
    out
}

fn unit(v: [f64; 3]) -> [f64; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    let l = if l == 0.0 { 1.0 } else { l };
    [v[0] / l, v[1] / l, v[2] / l]
}
fn sstep(a: f64, b: f64, x: f64) -> f64 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Licht wie MESH_FS in simCarveGl.ts; v = Richtung zum Betrachter. Ergebnis 0…1 je Farbe
fn shade(n: [f64; 3], v: [f64; 3], c: [f64; 3], metal: bool) -> [f64; 3] {
    let key = unit([-0.55, -0.75, 0.2]);
    let rim = unit([0.85, 0.35, 0.1]);
    let light = unit([-0.45, -0.6, 0.75]);
    let mut n = unit(n);
    let mut ndv = n[0] * v[0] + n[1] * v[1] + n[2] * v[2];
    if ndv < 0.0 {
        n = [-n[0], -n[1], -n[2]];
        ndv = -ndv;
    }
    let diff = 0.5 + 0.5 * (n[0] * light[0] + n[1] * light[1] + n[2] * light[2]).max(0.0);
    if !metal {
        let k = 0.45 + 0.6 * diff;
        return [c[0] * k, c[1] * k, c[2] * k];
    }
    let (rx, ry, rz) = (2.0 * ndv * n[0] - v[0], 2.0 * ndv * n[1] - v[1], 2.0 * ndv * n[2] - v[2]);
    let hl = (rx * rx + ry * ry + (rz * 0.4) * (rz * 0.4)).sqrt();
    let hl = if hl == 0.0 { 1.0 } else { hl };
    let (hx, hy, hz) = (rx / hl, ry / hl, rz * 0.4 / hl);
    let k = (hx * key[0] + hy * key[1] + hz * key[2]).max(0.0).powi(3);
    let r = (hx * rim[0] + hy * rim[1] + hz * rim[2]).max(0.0).powi(14);
    let sky = sstep(-0.95, 0.7, rz);
    let fres = (1.0 - ndv).powi(3);
    let body = 0.22 + 0.34 * diff + 0.4 * sky + 0.75 * k;
    let add = k * k * k * 0.5 + r * 0.45 + fres * 0.15;
    [c[0] * body + add, c[1] * body + add, c[2] * body + add]
}

/// Dreiecke in ein Pixelbild rechnen (RGBA, 0…255). side: Bild-x = x, Bild-y = Höhe z; sonst Blick von unten.
pub fn rasterize(mesh: &[f32], side: bool, f: [f64; 4], w: usize, h: usize) -> Vec<u8> {
    let mut px = vec![0u8; w * h * 4];
    let mut zb = vec![f64::NEG_INFINITY; w * h];
    if w == 0 || h == 0 {
        return px;
    }
    // von unten: Licht gespiegelt rechnen (als läge das Werkzeug mit der Spitze nach oben), sonst läge die Stirn im Schatten
    let (v, zs) = if side { ([0.0, -1.0, 0.0], 1.0) } else { ([0.0, 0.0, 1.0], -1.0) };
    let (kx, ky) = (w as f64 / (f[1] - f[0]), h as f64 / (f[3] - f[2]));
    let byte = |x: f64| (x * 255.0).round().clamp(0.0, 255.0) as u8;
    for t in mesh.chunks_exact(30) {
        let (mut x, mut y, mut d) = ([0.0f64; 3], [0.0f64; 3], [0.0f64; 3]);
        for i in 0..3 {
            let o = i * 10;
            x[i] = (t[o] as f64 - f[0]) * kx;
            y[i] = (f[3] - if side { t[o + 2] } else { t[o + 1] } as f64) * ky;
            d[i] = if side { -(t[o + 1] as f64) } else { -(t[o + 2] as f64) };
        }
        let area = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0]);
        if area.abs() < 1e-9 {
            continue;
        }
        let min3 = |a: &[f64; 3]| a[0].min(a[1]).min(a[2]);
        let max3 = |a: &[f64; 3]| a[0].max(a[1]).max(a[2]);
        let (xa, xb) = (min3(&x).floor().max(0.0) as usize, (max3(&x).ceil().min(w as f64 - 1.0)).max(0.0) as usize);
        let (ya, yb) = (min3(&y).floor().max(0.0) as usize, (max3(&y).ceil().min(h as f64 - 1.0)).max(0.0) as usize);
        let metal = t[9] > 1.0;
        let c = [t[6] as f64, t[7] as f64, t[8] as f64];
        for yy in ya..=yb {
            for xx in xa..=xb {
                let (cx, cy) = (xx as f64 + 0.5, yy as f64 + 0.5);
                let w0 = ((x[1] - cx) * (y[2] - cy) - (x[2] - cx) * (y[1] - cy)) / area;
                let w1 = ((x[2] - cx) * (y[0] - cy) - (x[0] - cx) * (y[2] - cy)) / area;
                let w2 = 1.0 - w0 - w1;
                if w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4 {
                    continue;
                }
                let dd = w0 * d[0] + w1 * d[1] + w2 * d[2];
                let at = yy * w + xx;
                if dd <= zb[at] {
                    continue;
                }
                zb[at] = dd;
                let n = [
                    w0 * t[3] as f64 + w1 * t[13] as f64 + w2 * t[23] as f64,
                    w0 * t[4] as f64 + w1 * t[14] as f64 + w2 * t[24] as f64,
                    (w0 * t[5] as f64 + w1 * t[15] as f64 + w2 * t[25] as f64) * zs,
                ];
                let rgb = shade(n, v, c, metal);
                let p = at * 4;
                px[p] = byte(rgb[0]);
                px[p + 1] = byte(rgb[1]);
                px[p + 2] = byte(rgb[2]);
                px[p + 3] = 255;
            }
        }
    }
    px
}

/// Zahlen als Bytes (little endian), wie sie das Fenster als Float32Array liest
pub fn bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// Antwort für die Simulation: Anzahl Zahlen des festen Teils (u32), dann fester Teil, dann durchsichtiger Teil
pub fn mill_bytes(job: &MillJob) -> Vec<u8> {
    let (solid, ghost) = mill_tool_mesh(job.tool.as_ref(), &job.holder, &job.outline);
    let mut out = (solid.len() as u32).to_le_bytes().to_vec();
    out.extend(bytes(&solid));
    out.extend(bytes(&ghost));
    out
}

pub fn cutter_bytes(job: &CutterJob) -> Vec<u8> {
    let mut v = Vec::new();
    cutter_mesh(&mut v, &job.outline, &job.look, [1.0, 1.0, 1.0], 1.0);
    bytes(&v)
}

/// Bild für die Bibliothek: RGBA, w × h (höchstens 2000 × 2000)
pub fn picture(job: &PictureJob) -> Result<Vec<u8>, String> {
    if job.w == 0 || job.h == 0 || job.w > 2000 || job.h > 2000 {
        return Err("picture size".into());
    }
    let f = job.frame;
    if !(f[1] > f[0]) || !(f[3] > f[2]) {
        return Err("picture frame".into());
    }
    let mesh = library_mesh(&job.tool, &job.cut, &job.rest, job.ring);
    Ok(rasterize(&mesh, job.view != "end", f, job.w as usize, job.h as usize))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(kind: &str, flutes: f64, helix: &str) -> Tool {
        Tool { kind: kind.into(), diameter: 6.0, flutes, helix: Some(helix.into()), coating: None }
    }
    const FLAT: [[f64; 2]; 3] = [[0.0, 0.0], [3.0, 0.0], [3.0, 22.0]];

    /// größter Radius, kleinste/größte Höhe, Anzahl Punkte, Summe aller Orte (zum Vergleich mit TypeScript)
    fn stats(a: &[f32]) -> (f64, f64, f64, usize, f64) {
        let (mut r, mut z0, mut z1, mut sum) = (0.0f64, f64::INFINITY, f64::NEG_INFINITY, 0.0f64);
        for v in a.chunks_exact(10) {
            r = r.max((v[0] as f64).hypot(v[1] as f64));
            z0 = z0.min(v[2] as f64);
            z1 = z1.max(v[2] as f64);
            sum += (v[0] as f64).abs() + (v[1] as f64).abs() + v[2] as f64;
            let n = ((v[3] * v[3] + v[4] * v[4] + v[5] * v[5]) as f64).sqrt();
            assert!((n - 1.0).abs() < 1e-4, "normal length {n}");
        }
        (r, z0, z1, a.len() / 10, sum)
    }

    #[test]
    fn flute_section_edge_and_core() {
        assert_eq!(flute_section(0.0, 0.55), 1.0);
        let mut u = 0.0;
        while u < 1.0 {
            let v = flute_section(u, 0.55);
            assert!(v >= 0.55 - 1e-9 && v <= 1.0 + 1e-9);
            u += 0.01;
        }
        assert!((flute_section(0.999, 0.55) - 1.0).abs() < 0.02);
    }

    #[test]
    fn cutter_keeps_diameter_and_flute_length() {
        let mut out = Vec::new();
        cutter_mesh(&mut out, &FLAT, &cutter_look(Some(&tool("endmill", 2.0, "up")), 3.0, 22.0), [1.0, 1.0, 1.0], 2.0);
        let (r, z0, z1, n, sum) = stats(&out);
        assert!((r - 3.0).abs() < 1e-5, "radius {r}");
        assert_eq!(z0, 0.0);
        assert!((z1 - 22.0).abs() < 1e-5);
        // dieselben Zahlen prüft tests/toolMesh.test.ts für die TypeScript-Rechnung
        assert_eq!(n, 7488);
        assert!((sum - 100366.57).abs() < 0.5, "sum {sum}");
    }

    #[test]
    fn look_per_tool_type() {
        assert!(cutter_look(Some(&tool("endmill", 2.0, "up")), 3.0, 22.0).rate > 0.0);
        assert!(cutter_look(Some(&tool("endmill", 2.0, "down")), 3.0, 22.0).rate < 0.0);
        assert_eq!(cutter_look(Some(&tool("endmill", 2.0, "straight")), 3.0, 22.0).rate, 0.0);
        assert_eq!(cutter_look(Some(&tool("vbit", 2.0, "up")), 3.0, 22.0).rate, 0.0);
        assert!(cutter_look(Some(&tool("endmill", 2.0, "compression")), 3.0, 22.0).split.is_some());
        assert_eq!(cutter_look(Some(&tool("drill", 1.0, "up")), 3.0, 22.0).flutes, 2.0);
        assert_eq!(cutter_look(Some(&tool("endmill", 40.0, "up")), 3.0, 22.0).flutes, 8.0);
        assert_eq!(cutter_look(None, 1.5, 12.0).flutes, 2.0);
    }

    #[test]
    fn whole_tool_sizes() {
        let hd = Holder { r: 3.0, shank_r: 3.0, flute_len: 22.0, stickout: 30.0, holder_r: 9.5, holder_h: 18.0, spindle_r: 26.0, spindle_h: 70.0 };
        let (solid, ghost) = mill_tool_mesh(Some(&tool("endmill", 4.0, "up")), &hd, &FLAT);
        let (s, g) = (stats(&solid), stats(&ghost));
        assert!((s.0 - 3.0).abs() < 1e-4);
        assert!((g.0 - 26.0).abs() < 1e-4);
        assert!(s.3 + g.3 < 120000);
        let b = mill_bytes(&MillJob { tool: None, holder: hd, outline: FLAT.to_vec() });
        let n = u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize;
        assert!(n > 0 && n % 30 == 0 && (b.len() - 4) % 4 == 0 && (b.len() - 4) / 4 > n);
    }

    /// genau die Form, in der das Fenster die Aufträge schickt (toolRust.ts) – auch mit null und einem ganzen Werkzeug
    #[test]
    fn jobs_from_the_window_are_understood() {
        let mill: MillJob = serde_json::from_str(
            r#"{"tool":{"type":"ball","diameter":6,"flutes":2,"helix":null,"coating":"tin"},
                "holder":{"r":3,"shankR":3,"fluteLen":22,"stickout":30,"holderR":9.5,"holderH":18,"spindleR":26,"spindleH":70},
                "outline":[[0,0],[3,3],[3,22]]}"#,
        )
        .unwrap();
        assert_eq!(mill.tool.as_ref().unwrap().kind, "ball");
        assert!(mill_bytes(&mill).len() > 1000);
        let none: MillJob = serde_json::from_str(r#"{"tool":null,"holder":{"r":1.5,"shankR":1.5,"fluteLen":12,"stickout":20,"holderR":9.5,"holderH":18,"spindleR":26,"spindleH":70},"outline":[[0,0],[1.5,0],[1.5,12]]}"#).unwrap();
        assert!(none.tool.is_none());
        let cut: CutterJob = serde_json::from_str(r#"{"outline":[[0,0],[2.5,1.5],[2.5,31.5]],"look":{"flutes":2,"core":0.34,"rate":0.21,"split":null}}"#).unwrap();
        assert!(cut.look.split.is_none() && cutter_bytes(&cut).len() % 40 == 0);
        let pic: PictureJob = serde_json::from_str(
            r#"{"tool":{"type":"endmill","diameter":3,"flutes":1,"helix":"up","coating":null},"cut":[[0,0],[1.5,0],[1.5,12]],
                "rest":[[1.5,12],[1.5875,12.07],[1.5875,38]],"ring":null,"view":"end","frame":[-1.5,1.5,-1.5,1.5],"w":40,"h":40}"#,
        )
        .unwrap();
        assert_eq!(picture(&pic).unwrap().len(), 40 * 40 * 4);
    }

    #[test]
    fn picture_is_true_to_scale() {
        let job = PictureJob {
            tool: Tool { kind: "endmill".into(), diameter: 6.0, flutes: 2.0, helix: Some("up".into()), coating: None },
            cut: vec![[0.0, 0.0], [3.0, 0.0], [3.0, 20.0]],
            rest: vec![[3.0, 20.0], [3.0, 50.0]],
            ring: Some([1.0, 0.0, 0.0]),
            view: "side".into(),
            frame: [-3.0, 3.0, 0.0, 50.0],
            w: 60,
            h: 500,
        };
        let px = picture(&job).unwrap();
        let row = |y: usize| (0..60).filter(|x| px[(y * 60 + x) * 4 + 3] != 0).count();
        assert_eq!(row(100), 60, "shank fills the width");
        assert!(row(400) < 60, "flutes are narrower somewhere");
        let red = px.chunks_exact(4).filter(|p| p[0] > 120 && p[1] < 60 && p[2] < 60).count();
        assert!(red > 200, "{red} red pixels");
        let end = picture(&PictureJob { view: "end".into(), frame: [-3.0, 3.0, -3.0, 3.0], w: 80, h: 80, ..job.clone() }).unwrap();
        assert_eq!(end[3], 0);
        assert_eq!(end[(40 * 80 + 40) * 4 + 3], 255);
        assert!(picture(&PictureJob { w: 0, ..job.clone() }).is_err());
        assert!(picture(&PictureJob { w: 5000, ..job }).is_err());
    }
}
