//! DREHACHSE + 3D-MODELL – Zwilling von `src/rotary3d.ts`: Modell auf die Drehachse legen (meshForRotary), um X drehen
//! (rotateX, für das Fräsen von mehreren Seiten), Rundum-Schruppen und -Schlichten aus dem Höhenfeld (roughRotary,
//! finishRotary mit thin3), Bahnen aneinanderhängen (chainRotary) und die Vorschau auf dem Zylinder (fieldPreview).
//!
//! Das Höhenfeld rechnet schon der App-Kern (cam3d.rs → rotary_field); hier nur, was das Fenster daraus macht. Folgt dem
//! TypeScript Zeile für Zeile, mit Float32 an denselben Stellen. Nur Vergleich: die Bahnen und der G-Code kommen weiter
//! aus dem Fenster (cam3dDialog.ts). Gemeinsame Fälle: `tests/fixtures/rotary3d-cases.json.gz`.

use crate::gcodesim::{hypot2, hypot3, mn, mx};
use crate::jsmath::{self, js_round};
use crate::relief::f32_hash;
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

/// Spitzenradius je Winkel (Zeile j) und X-Stelle (Spalte i): h[j * nx + i]
pub struct RField<'a> {
    pub x0: f64,
    pub dx: f64,
    pub nx: usize,
    pub nt: usize,
    pub h: &'a [f32],
}
impl RField<'_> {
    fn at(&self, j: usize, i: usize) -> f64 {
        self.h.get(j * self.nx + i).map_or(f64::NAN, |v| *v as f64)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Path3D {
    pub kind: f64,
    pub layer: f64,
    pub top: f64,
    pub pts: Vec<f32>,
}

/// Wert an einer Stelle des Float32Array (dahinter: undefined → NaN)
fn get(v: &[f32], i: usize) -> f64 {
    v.get(i).map_or(f64::NAN, |x| *x as f64)
}

/// Modell drehen: gewählte Modell-Achse → X (Länge), Querschnitt mittig auf die Achse, gleichmäßig skaliert
pub fn mesh_for_rotary(pos: &[f32], axis: f64, length: f64) -> (Vec<f32>, f64, f64) {
    let ord = if axis == 0.0 { [0, 1, 2] } else if axis == 1.0 { [1, 2, 0] } else { [2, 0, 1] };
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    let mut i = 0;
    while i < pos.len() {
        for a in 0..3 {
            let v = get(pos, i + ord[a]);
            if v < lo[a] {
                lo[a] = v;
            }
            if v > hi[a] {
                hi[a] = v;
            }
        }
        i += 3;
    }
    let k = length / mx(1e-9, hi[0] - lo[0]);
    let (cy, cz) = ((lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0);
    let mut out = vec![0f32; pos.len()];
    let mut max_r = 0.0;
    let mut i = 0;
    while i < pos.len() {
        let x = (get(pos, i + ord[0]) - lo[0]) * k;
        let y = (get(pos, i + ord[1]) - cy) * k;
        let z = (get(pos, i + ord[2]) - cz) * k;
        for (d, v) in [x, y, z].into_iter().enumerate() {
            if let Some(o) = out.get_mut(i + d) {
                *o = v as f32;
            }
        }
        max_r = mx(max_r, hypot2(y, z));
        i += 3;
    }
    (out, max_r, k)
}

/// Modell um +X drehen (wie die Maschine bei A = deg): (y, z) → (y cos − z sin, y sin + z cos)
pub fn rotate_x(pos: &[f32], deg: f64) -> Vec<f32> {
    let a = (deg * PI) / 180.0;
    let (c, s) = (jsmath::cos(a), jsmath::sin(a));
    let mut out = vec![0f32; pos.len()];
    let mut i = 0;
    while i < pos.len() {
        let (y, z) = (get(pos, i + 1), get(pos, i + 2));
        for (d, v) in [get(pos, i), y * c - z * s, y * s + z * c].into_iter().enumerate() {
            if let Some(o) = out.get_mut(i + d) {
                *o = v as f32;
            }
        }
        i += 3;
    }
    out
}

/// Schichten von R nach innen bis zum Boden
fn radii(r_out: f64, step: f64, bottom: f64) -> Vec<f64> {
    let mut out = vec![];
    let st = mx(0.05, step);
    let mut r = r_out - st;
    while r > bottom + 1e-6 {
        out.push(r);
        r -= st;
    }
    if bottom < r_out - 1e-6 {
        out.push(bottom);
    }
    out
}

/// Punkte auf fast geraden Stücken weglassen (Abweichung höchstens tol)
pub fn thin3(pts: &[[f64; 3]], tol: f64) -> Vec<[f64; 3]> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let mut out = vec![pts[0]];
    let mut a = 0;
    let dist = |p: &[f64; 3], s: &[f64; 3], e: &[f64; 3]| {
        let d = [e[0] - s[0], e[1] - s[1], e[2] - s[2]];
        let w = [p[0] - s[0], p[1] - s[1], p[2] - s[2]];
        let l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        let u = if l2 > 1e-18 { mx(0.0, mn(1.0, (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / l2)) } else { 0.0 };
        hypot3(w[0] - u * d[0], w[1] - u * d[1], w[2] - u * d[2])
    };
    for e in 2..pts.len() {
        let mut ok = e - a <= 400;
        let mut m = a + 1;
        while ok && m < e {
            if dist(&pts[m], &pts[a], &pts[e]) > tol {
                ok = false;
            }
            m += 1;
        }
        if !ok {
            out.push(pts[e - 1]);
            a = e - 1;
        }
    }
    out.push(pts[pts.len() - 1]);
    out
}

fn to_path(kind: f64, layer: f64, top: f64, pts: &[[f64; 3]], tol: f64) -> Path3D {
    let t = thin3(pts, tol);
    Path3D { kind, layer, top, pts: t.iter().flat_map(|p| p.iter().map(|v| *v as f32)).collect() }
}

/// SCHRUPPEN rundum: Schichten, je Schicht zusammenhängende Zeilen-Gruppen im Zickzack
pub fn rough_rotary(f: &RField, r: f64, step_down: f64, core: f64, tol: f64) -> Vec<Path3D> {
    let ds = (2.0 * PI * r) / f.nt as f64;
    let lowest = f.h.iter().fold(f64::INFINITY, |a, v| mn(a, *v as f64));
    let zs = radii(r, step_down, mx(core, lowest));
    let mut out = vec![];
    for (k, &rho) in zs.iter().enumerate() {
        let prev = if k == 0 { r } else { zs[k - 1] };
        let tip = |j: usize, i: usize| mn(r, mx(rho, f.at(j, i)));
        let cuts: Vec<bool> = (0..f.nt).map(|j| (0..f.nx).any(|i| tip(j, i) < prev - 1e-3)).collect();
        if !cuts.iter().any(|c| *c) {
            continue;
        }
        let starts: Vec<usize> = if cuts.iter().all(|c| *c) { vec![0] } else { (0..f.nt).filter(|&j| cuts[j] && !cuts[(j + f.nt - 1) % f.nt]).collect() };
        for s in starts {
            let mut pts = vec![];
            let mut m = 0;
            while m < f.nt && cuts[(s + m) % f.nt] {
                let j = (s + m) % f.nt;
                let y = (s + m) as f64 * ds;
                for q in 0..f.nx {
                    let i = if m % 2 == 0 { q } else { f.nx - 1 - q };
                    pts.push([f.x0 + i as f64 * f.dx, y, tip(j, i) - r]);
                }
                m += 1;
            }
            out.push(to_path(0.0, k as f64, prev - r, &pts, tol));
        }
    }
    out
}

/// SCHLICHTEN rundum. along_x: Zeilen entlang der Achse, sonst Spirale (je Umdrehung um stepOver weiter in X).
/// level_step > 0: ohne Schruppen in Zustellungen von außen nach innen
pub fn finish_rotary(f: &RField, r: f64, along_x: bool, step_over: f64, tol: f64, level_step: f64) -> Vec<Path3D> {
    let ds = (2.0 * PI * r) / f.nt as f64;
    let mut pts: Vec<[f64; 3]> = vec![];
    if along_x {
        for j in 0..f.nt {
            for q in 0..f.nx {
                let i = if j % 2 == 0 { q } else { f.nx - 1 - q };
                pts.push([f.x0 + i as f64 * f.dx, j as f64 * ds, f.at(j, i) - r]);
            }
        }
    } else {
        let x1 = f.x0 + (f.nx as f64 - 1.0) * f.dx;
        let per = mx(0.01, step_over);
        let total = (((x1 - f.x0) / per) * f.nt as f64).ceil();
        let nx1 = f.nx as f64 - 1.0;
        let mut u = 0.0;
        while u <= total {
            let x = mn(x1, f.x0 + (u / f.nt as f64) * per);
            let j = (u % f.nt as f64) as usize;
            let fi = (x - f.x0) / f.dx;
            let i0 = mn(nx1, fi.floor());
            let i1 = mn(nx1, i0 + 1.0);
            let w = fi - i0;
            let (h0, h1) = (f.at(j, i0 as usize), f.at(j, i1 as usize));
            let h = if w < 1e-6 { h0 } else { mx(h0, h1) };
            pts.push([x, u * ds, h - r]);
            u += 1.0;
        }
    }
    if !(level_step > 0.0) {
        return vec![to_path(1.0, 0.0, 0.0, &pts, tol)];
    }
    let lowest = pts.iter().fold(f64::INFINITY, |a, p| mn(a, p[2]));
    let lv = radii(r, level_step, lowest + r);
    let last = lv.len().wrapping_sub(1);
    lv.iter()
        .enumerate()
        .map(|(k, &rho)| {
            let p2: Vec<[f64; 3]> = pts.iter().map(|p| [p[0], p[1], if k == last { p[2] } else { mx(p[2], rho - r) }]).collect();
            to_path(1.0, k as f64, 0.0, &p2, tol)
        })
        .collect()
}

/// Bahnen rundherum aneinanderhängen: jede Bahn um ganze Umfänge verschieben, so dass sie dort beginnt, wo A gerade steht
pub fn chain_rotary(paths: &mut [Path3D], r: f64) {
    let c = 2.0 * PI * r;
    let mut cur = 0.0;
    for p in paths.iter_mut() {
        if p.pts.len() < 3 {
            continue;
        }
        let m = js_round((cur - p.pts[1] as f64) / c);
        if m != 0.0 && !m.is_nan() {
            let mut i = 1;
            while i < p.pts.len() {
                p.pts[i] = (p.pts[i] as f64 + m * c) as f32;
                i += 3;
            }
        }
        cur = p.pts[p.pts.len() - 2] as f64;
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub nx: f64,
    pub ny: f64,
    pub x0: f64,
    pub y0: f64,
    pub cell: f64,
    pub h: u64,
    pub min_z: f64,
    pub moves: f64,
}

/// Vorschau: Höhenraster (abgewickelt, Zellen quadratisch); h als Prüfsumme über die f32-Bits
pub fn field_preview(f: &RField, r: f64) -> (Preview, Vec<f32>) {
    let cell = f.dx;
    let c = 2.0 * PI * r;
    let ny = mx(8.0, js_round(c / cell));
    let n = (f.nx as f64 * ny) as usize;
    let mut h = vec![0f32; n];
    let mut min_z = 0.0;
    let nt = f.nt as f64;
    let mut j = 0.0;
    while j < ny {
        let t = ((j + 0.5) / ny) * nt;
        let j0 = (t.floor() % nt) as usize;
        let j1 = (j0 + 1) % f.nt;
        let w = t - t.floor();
        for i in 0..f.nx {
            let v = mn(0.0, f.at(j0, i) * (1.0 - w) + f.at(j1, i) * w - r);
            if let Some(o) = h.get_mut(j as usize * f.nx + i) {
                *o = v as f32;
            }
            min_z = mn(min_z, v);
        }
        j += 1.0;
    }
    (Preview { nx: f.nx as f64, ny, x0: f.x0 - cell / 2.0, y0: 0.0, cell, h: f32_hash(&h), min_z, moves: 0.0 }, h)
}

// ---------------------------------------------------------------------
// Auftrag des Fensters (Rohdaten: Kopf als JSON, dann die f32-Werte)
// ---------------------------------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FieldHead {
    pub x0: f64,
    pub dx: f64,
    pub nx: usize,
    pub nt: usize,
}
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoughHead {
    #[serde(flatten)]
    pub field: FieldHead,
    pub step_down: f64,
    pub core: f64,
    pub tol: f64,
}
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FinishHead {
    #[serde(flatten)]
    pub field: FieldHead,
    #[serde(default)]
    pub dir: String,
    pub step_over: f64,
    pub tol: f64,
    pub level_step: f64,
}
#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Head {
    /// Modell auf die Drehachse legen; Daten = Dreiecke des Modells
    Mesh { axis: f64, length: f64 },
    /// Modell für jede Seite drehen; Daten = Modell auf der Achse
    Rotate { degs: Vec<f64> },
    /// Rundum: Bahnen aus den Höhenfeldern (Daten: erst Schruppen, dann Schlichten), aneinandergehängt
    Wrap {
        r: f64,
        #[serde(default)]
        rough: Option<RoughHead>,
        #[serde(default)]
        finish: Option<FinishHead>,
    },
    /// Vorschau auf dem Zylinder; Daten = Höhenfeld
    Preview {
        r: f64,
        #[serde(flatten)]
        field: FieldHead,
    },
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PathSum {
    pub kind: f64,
    pub layer: f64,
    pub top: f64,
    pub n: usize,
    pub h: u64,
}
pub fn summary(paths: &[Path3D]) -> Vec<PathSum> {
    paths.iter().map(|p| PathSum { kind: p.kind, layer: p.layer, top: p.top, n: p.pts.len(), h: f32_hash(&p.pts) }).collect()
}

pub fn split_body(body: &[u8]) -> Result<(Head, Vec<f32>), String> {
    let n = u32::from_le_bytes(body.get(..4).ok_or("short body")?.try_into().map_err(|_| "short body")?) as usize;
    let head: Head = serde_json::from_slice(body.get(4..4 + n).ok_or("short body")?).map_err(|e| e.to_string())?;
    let data = &body[4 + n..];
    Ok((head, data.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()))
}

fn field<'a>(h: &FieldHead, data: &'a [f32], from: usize) -> Result<RField<'a>, String> {
    let n = h.nx.checked_mul(h.nt).ok_or("field too big")?;
    let d = data.get(from..from + n).ok_or("field data missing")?;
    Ok(RField { x0: h.x0, dx: h.dx, nx: h.nx, nt: h.nt, h: d })
}

pub fn run(head: &Head, data: &[f32]) -> Result<serde_json::Value, String> {
    use serde_json::json;
    Ok(match head {
        Head::Mesh { axis, length } => {
            let (tris, max_r, scale) = mesh_for_rotary(data, *axis, *length);
            json!({ "tris": f32_hash(&tris), "n": tris.len(), "maxR": max_r, "scale": scale })
        }
        Head::Rotate { degs } => json!(degs.iter().map(|d| f32_hash(&rotate_x(data, *d))).collect::<Vec<_>>()),
        Head::Wrap { r, rough, finish } => {
            let mut out = vec![];
            let mut at = 0;
            if let Some(o) = rough {
                let f = field(&o.field, data, at)?;
                at += f.h.len();
                out.extend(rough_rotary(&f, *r, o.step_down, o.core, o.tol));
            }
            if let Some(o) = finish {
                let f = field(&o.field, data, at)?;
                out.extend(finish_rotary(&f, *r, o.dir == "x", o.step_over, o.tol, o.level_step));
            }
            chain_rotary(&mut out, *r);
            json!(summary(&out))
        }
        Head::Preview { r, field: fh } => json!(field_preview(&field(fh, data, 0)?, *r).0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Read;

    fn b64(s: &str) -> Vec<f32> {
        let val = |c: u8| match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            _ => 63,
        } as u32;
        let chars: Vec<u8> = s.bytes().filter(|&c| c != b'=').collect();
        let mut bytes = vec![];
        for ch in chars.chunks(4) {
            let n = ch.iter().enumerate().fold(0u32, |a, (i, &c)| a | (val(c) << (18 - 6 * i)));
            bytes.push((n >> 16) as u8);
            if ch.len() > 2 {
                bytes.push((n >> 8) as u8);
            }
            if ch.len() > 3 {
                bytes.push(n as u8);
            }
        }
        bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
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
    fn same_paths_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("rotary3d-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        for (i, c) in all["meshes"].as_array().unwrap().iter().enumerate() {
            let head: Head = serde_json::from_value(serde_json::json!({ "kind": "mesh", "axis": c["axis"], "length": c["length"] })).unwrap();
            same(&run(&head, &b64(c["pos"].as_str().unwrap())).unwrap(), &c["want"], &format!("mesh {i} ({})", c["name"]));
        }
        for (i, c) in all["rotates"].as_array().unwrap().iter().enumerate() {
            let head: Head = serde_json::from_value(serde_json::json!({ "kind": "rotate", "degs": c["degs"] })).unwrap();
            same(&run(&head, &b64(c["pos"].as_str().unwrap())).unwrap(), &c["want"], &format!("rotate {i} ({})", c["name"]));
        }
        let wraps = all["wraps"].as_array().unwrap();
        assert!(wraps.len() >= 30);
        for (i, c) in wraps.iter().enumerate() {
            let head: Head = serde_json::from_value(c["head"].clone()).unwrap();
            let h = b64(c["h"].as_str().unwrap());
            let mut data = vec![];
            for k in ["rough", "finish"] {
                if !c["head"][k].is_null() {
                    data.extend_from_slice(&h);
                }
            }
            same(&run(&head, &data).unwrap(), &c["want"], &format!("wrap {i} ({})", c["name"]));
        }
        for (i, c) in all["previews"].as_array().unwrap().iter().enumerate() {
            let head: Head = serde_json::from_value(c["head"].clone()).unwrap();
            same(&run(&head, &b64(c["h"].as_str().unwrap())).unwrap(), &c["want"], &format!("preview {i} ({})", c["name"]));
        }
        for (i, c) in all["thins"].as_array().unwrap().iter().enumerate() {
            let pts: Vec<[f64; 3]> = serde_json::from_value(c["pts"].clone()).unwrap();
            same(&serde_json::json!(thin3(&pts, c["tol"].as_f64().unwrap())), &c["out"], &format!("thin3 {i}"));
        }
        println!("{} rotary jobs the same as rotary3d.ts", wraps.len());
    }
}
