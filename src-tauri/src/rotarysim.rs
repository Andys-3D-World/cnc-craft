//! SIMULATION MIT DREHACHSE – Zwilling von `src/sim/rotarySim.ts` (wrapSimProgram, radialDepth): die Bewegungen der
//! Simulation um das Teil wickeln (Achse entlang X oder Y, umgekehrte Drehrichtung, Rollen-Drehachse, eckig, Vieleck,
//! Kegel), in Stücke von höchstens 2° teilen, Tiefe je Bewegung und das Raster für den Materialabtrag.
//!
//! Das Fenster schickt das gelesene Programm als Rohdaten (Kopf als JSON, dann die Bewegungen als f32 und die Startzeiten
//! als f64) und vergleicht eine Zusammenfassung (Anzahlen, Maße, Prüfsummen über die Bits jeder Liste). Angezeigt wird
//! weiter das Ergebnis des Fensters; Rust bildet Float32Array/Uint32Array/Int16Array an denselben Stellen nach.
//! Fälle: `tests/fixtures/rotarysim-cases.json.gz`.

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath;
use crate::rotarystock::{cone_center, cone_radius, faces, is_prism, perimeter, surface_radius, Face, RotaryStock};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::f64::consts::PI;

const STEP: f64 = (2.0 * PI) / 180.0;
const MAX_MOVES: f64 = 4_000_000.0;

fn nan_num<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN))
}
/// fehlt = None (undefined), null = NaN
fn nan_opt<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(Some(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN)))
}

/// Zahl in ein Uint32Array schreiben (ToUint32: NaN/±∞ = 0, sonst abgeschnitten modulo 2^32)
fn u32_of(v: f64) -> u32 {
    if !v.is_finite() {
        return 0;
    }
    (v.trunc().rem_euclid(4294967296.0)) as u32
}
/// Math.min / Math.max mit drei Werten (NaN gewinnt)
fn mn3(a: f64, b: f64, c: f64) -> f64 {
    mn(mn(a, b), c)
}
fn mx3(a: f64, b: f64, c: f64) -> f64 {
    mx(mx(a, b), c)
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    #[serde(deserialize_with = "nan_num")]
    pub min_x: f64,
    #[serde(deserialize_with = "nan_num")]
    pub min_y: f64,
    #[serde(deserialize_with = "nan_num")]
    pub min_z: f64,
    #[serde(deserialize_with = "nan_num")]
    pub max_x: f64,
    #[serde(deserialize_with = "nan_num")]
    pub max_y: f64,
    #[serde(deserialize_with = "nan_num")]
    pub max_z: f64,
}

/// Das gelesene Programm (SimProgram), nur was das Wickeln braucht
pub struct Prog {
    pub n: usize,
    pub x0: Vec<f32>,
    pub y0: Vec<f32>,
    pub z0: Vec<f32>,
    pub x1: Vec<f32>,
    pub y1: Vec<f32>,
    pub z1: Vec<f32>,
    pub a0: Option<Vec<f32>>,
    pub a1: Option<Vec<f32>>,
    pub kind: Vec<u8>,
    pub line: Vec<u32>,
    pub t0: Vec<f64>,
    pub dur: Vec<f32>,
    pub dur_plain: Option<Vec<f32>>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WrapOpts {
    #[serde(default, deserialize_with = "nan_opt")]
    pub a_scale: Option<f64>,
    #[serde(default)]
    pub along: Option<String>,
    #[serde(default)]
    pub reverse: bool,
    #[serde(default)]
    pub stock: Option<RotaryStock>,
}

pub struct Raster {
    pub x0: Vec<f32>,
    pub y0: Vec<f32>,
    pub z0: Vec<f32>,
    pub x1: Vec<f32>,
    pub y1: Vec<f32>,
    pub z1: Vec<f32>,
    pub face: Option<Vec<i16>>,
}
pub struct Wrapped {
    pub n: usize,
    pub x0: Vec<f32>,
    pub y0: Vec<f32>,
    pub z0: Vec<f32>,
    pub x1: Vec<f32>,
    pub y1: Vec<f32>,
    pub z1: Vec<f32>,
    pub kind: Vec<u8>,
    pub line: Vec<u32>,
    pub t0: Vec<f64>,
    pub dur: Vec<f32>,
    pub dur_plain: Option<Vec<f32>>,
    pub bounds: Bounds,
    /// nur gesetzt, wenn das Rohteil nicht rund ist und es Schnitte gab (sonst bleiben die Werte des Programms)
    pub cut: Option<(f64, f64)>,
    pub a_min: f64,
    pub a_max: f64,
    pub along_y: bool,
    pub depth: Vec<f32>,
    pub theta: Option<Vec<f32>>,
    pub raster: Option<Raster>,
}

pub fn wrap_sim_program(p: &Prog, r: f64, mode_a: bool, o: &WrapOpts) -> Wrapped {
    let use_a = mode_a && p.a0.is_some() && p.a1.is_some();
    let ay = o.along.as_deref() == Some("y");
    let a_k = o.a_scale.unwrap_or(1.0) * if o.reverse { -1.0 } else { 1.0 };
    let f = |v: &[f32], i: usize| v[i] as f64;
    let ax = |i: usize, end: bool| if ay { if end { f(&p.y1, i) } else { f(&p.y0, i) } } else if end { f(&p.x1, i) } else { f(&p.x0, i) };
    let cr = |i: usize, end: bool| if ay { -(if end { f(&p.x1, i) } else { f(&p.x0, i) }) } else if end { f(&p.y1, i) } else { f(&p.y0, i) };
    let stock = o.stock.clone().unwrap_or(RotaryStock {
        shape: "round".into(),
        diameter: 2.0 * r,
        width: 0.0,
        height: 0.0,
        sides: 4.0,
        flats: 0.0,
        d0: 0.0,
        d1: 0.0,
        cone_len: 1.0,
    });
    let cone = !use_a && stock.shape == "cone";
    let cone_mid = (if ay { -1.0 } else { 1.0 }) * cone_center(&stock);
    let th_at = |axial: f64, cross: f64| if cone { (cross - cone_mid) / cone_radius(&stock, axial) } else { cross / r };
    let th = |i: usize, end: bool| {
        if use_a {
            let a = if end { p.a1.as_ref().unwrap()[i] } else { p.a0.as_ref().unwrap()[i] } as f64;
            (a * PI * a_k) / 180.0
        } else {
            th_at(ax(i, end), cr(i, end))
        }
    };
    // Stückzahl je Bewegung (Uint32Array)
    let mut total: f64 = 0.0;
    let mut pieces = vec![0u32; p.n];
    for i in 0..p.n {
        pieces[i] = u32_of(mx(1.0, ((th(i, true) - th(i, false)).abs() / STEP - 1e-9).ceil()));
        if cone {
            pieces[i] = u32_of(mx(pieces[i] as f64, ((ax(i, true) - ax(i, false)).abs() / 5.0).ceil()));
        }
        total += pieces[i] as f64;
    }
    if total > MAX_MOVES {
        let k = MAX_MOVES / total;
        total = 0.0;
        for pc in pieces.iter_mut() {
            *pc = u32_of(mx(1.0, (*pc as f64 * k).floor()));
            total += *pc as f64;
        }
    }
    let total = total as usize;
    let (mut x0, mut y0, mut z0) = (vec![0f32; total], vec![0f32; total], vec![0f32; total]);
    let (mut x1, mut y1, mut z1) = (vec![0f32; total], vec![0f32; total], vec![0f32; total]);
    let mut depth = vec![0f32; total];
    let body = stock.shape != "round";
    let fs: Vec<Face> = if is_prism(&stock) { faces(&stock) } else { vec![] };
    let r_max = perimeter(&stock) / (2.0 * PI);
    let a0 = fs.first().map_or(r, |f| f.apothem);
    let band = if ay { -1.0 } else { 1.0 };
    let nb = if body { total } else { 0 };
    let mut theta = vec![0f32; nb];
    let (mut rx0, mut ry0, mut rz0) = (vec![0f32; nb], vec![0f32; nb], vec![0f32; nb]);
    let (mut rx1, mut ry1, mut rz1) = (vec![0f32; nb], vec![0f32; nb], vec![0f32; nb]);
    let mut rface: Option<Vec<i16>> = if fs.is_empty() { None } else { Some(vec![-1i16; nb]) };
    let face_on = |t: f64| -> i16 {
        let d = ((((t * band * 180.0) / PI) % 360.0) + 360.0) % 360.0;
        fs.iter().position(|f| mn((d - f.angle).abs(), 360.0 - (d - f.angle).abs()) < 0.01).map_or(-1, |k| k as i16)
    };
    let mut kind = vec![0u8; total];
    let mut line = vec![0u32; total];
    let mut t0 = vec![0f64; total];
    let mut dur = vec![0f32; total];
    let mut dur_plain = p.dur_plain.as_ref().map(|_| vec![0f32; total]);
    let mut b = Bounds { min_x: f64::INFINITY, min_y: f64::INFINITY, min_z: f64::INFINITY, max_x: f64::NEG_INFINITY, max_y: f64::NEG_INFINITY, max_z: f64::NEG_INFINITY };
    let (mut a_min, mut a_max) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut cut_min, mut cut_max) = (f64::INFINITY, f64::NEG_INFINITY);
    // Abstand Punkt – Oberfläche (negativ = im Material)
    let depth_at = |along: f64, q: f64, zz: f64| {
        let u = zz + r;
        hypot2(q, u) - surface_radius(&stock, &fs, along, jsmath::atan2(q, u))
    };
    // Punkt (x, Querfahrt ym, Höhe z, Winkel t) → Lage am Teil; min/max aus den Zahlen vor dem Speichern
    let put = |x: f64, ym: f64, z: f64, t: f64, b: &mut Bounds| -> (f32, f32, f32) {
        let (c, s, rr) = (jsmath::cos(t), jsmath::sin(t), r + z);
        let py = ym * c + rr * s;
        let pz = -ym * s + rr * c - r;
        let (qx, qy) = if ay { (-py, x) } else { (x, py) };
        if qx < b.min_x {
            b.min_x = qx;
        }
        if qx > b.max_x {
            b.max_x = qx;
        }
        if qy < b.min_y {
            b.min_y = qy;
        }
        if qy > b.max_y {
            b.max_y = qy;
        }
        if pz < b.min_z {
            b.min_z = pz;
        }
        if pz > b.max_z {
            b.max_z = pz;
        }
        (qx as f32, qy as f32, pz as f32)
    };
    let l = |a: f64, b: f64, u: f64| a + (b - a) * u;
    let mut k = 0usize;
    for i in 0..p.n {
        let n = pieces[i];
        let nf = n as f64;
        let (ta, tb) = (th(i, false), th(i, true));
        a_min = mn3(a_min, ta, tb);
        a_max = mx3(a_max, ta, tb);
        let (ya, yb) = if use_a { (cr(i, false), cr(i, true)) } else { (0.0, 0.0) };
        let (xa, xb) = (ax(i, false), ax(i, true));
        for q in 0..n {
            let qf = q as f64;
            let (u0, u1) = (qf / nf, (qf + 1.0) / nf);
            let t_at = |u: f64| if cone { th_at(l(xa, xb, u), l(cr(i, false), cr(i, true), u)) } else { l(ta, tb, u) };
            let z_at = |u: f64| l(f(&p.z0, i), f(&p.z1, i), u) + if cone { cone_radius(&stock, l(xa, xb, u)) - r } else { 0.0 };
            let (px, py, pz) = put(l(xa, xb, u0), l(ya, yb, u0), z_at(u0), t_at(u0), &mut b);
            x0[k] = px;
            y0[k] = py;
            z0[k] = pz;
            let (px, py, pz) = put(l(xa, xb, u1), l(ya, yb, u1), z_at(u1), t_at(u1), &mut b);
            x1[k] = px;
            y1[k] = py;
            z1[k] = pz;
            let q0 = if ay { -(x0[k] as f64) } else { y0[k] as f64 };
            let q1 = if ay { -(x1[k] as f64) } else { y1[k] as f64 };
            let d = mn(depth_at(l(xa, xb, u0), q0, z0[k] as f64), depth_at(l(xa, xb, u1), q1, z1[k] as f64));
            depth[k] = d as f32;
            if p.kind[i] == 1 {
                if d < cut_min {
                    cut_min = d;
                }
                if d > cut_max {
                    cut_max = d;
                }
            }
            if body {
                let (t0v, t1) = (t_at(u0), t_at(u1));
                let (z0k, z1k) = (z_at(u0), z_at(u1));
                let (a0k, a1k) = (l(xa, xb, u0), l(xa, xb, u1));
                theta[k] = t1 as f32;
                rx0[k] = a0k as f32;
                rx1[k] = a1k as f32;
                if !fs.is_empty() {
                    let fk = if (t1 - t0v).abs() < 1e-5 { face_on(t1) } else { -1 };
                    rface.as_mut().unwrap()[k] = fk;
                    if fk >= 0 {
                        let fc = &fs[fk as usize];
                        let dz = fc.apothem - a0;
                        ry0[k] = (fc.center + band * l(ya, yb, u0)) as f32;
                        ry1[k] = (fc.center + band * l(ya, yb, u1)) as f32;
                        rz0[k] = (z0k - dz) as f32;
                        rz1[k] = (z1k - dz) as f32;
                    } else {
                        rz0[k] = 1e3;
                        rz1[k] = 1e3;
                    }
                } else {
                    ry0[k] = (t0v * r_max) as f32;
                    ry1[k] = (t1 * r_max) as f32;
                    rz0[k] = (r + z0k - cone_radius(&stock, a0k)) as f32;
                    rz1[k] = (r + z1k - cone_radius(&stock, a1k)) as f32;
                }
            }
            kind[k] = p.kind[i];
            line[k] = p.line[i];
            dur[k] = (p.dur[i] as f64 / nf) as f32;
            if let (Some(dp), Some(src)) = (dur_plain.as_mut(), p.dur_plain.as_ref()) {
                dp[k] = (src[i] as f64 / nf) as f32;
            }
            t0[k] = p.t0[i] + (p.dur[i] as f64 * qf) / nf;
            k += 1;
        }
    }
    if total == 0 {
        b = Bounds { min_x: 0.0, min_y: 0.0, min_z: 0.0, max_x: 0.0, max_y: 0.0, max_z: 0.0 };
        a_min = 0.0;
        a_max = 0.0;
    }
    let deg = 180.0 / PI;
    Wrapped {
        n: total,
        x0,
        y0,
        z0,
        x1,
        y1,
        z1,
        kind,
        line,
        t0,
        dur,
        dur_plain,
        bounds: b,
        cut: if stock.shape != "round" && cut_min <= cut_max { Some((cut_min, cut_max)) } else { None },
        a_min: a_min * deg,
        a_max: a_max * deg,
        along_y: ay,
        depth,
        theta: if body { Some(theta) } else { None },
        raster: if body { Some(Raster { x0: rx0, y0: ry0, z0: rz0, x1: rx1, y1: ry1, z1: rz1, face: rface }) } else { None },
    }
}

/// Tiefe eines Punkts am gewickelten Teil (Abstand zur Achse − R); q = quer zur Achse
#[allow(dead_code)] // im Fenster nur für die Farben: vom Test verglichen
pub fn radial_depth(q: f64, z: f64, r: f64) -> f64 {
    hypot2(q, z + r) - r
}

// ---------------------------------------------------------------------
// Auftrag des Fensters und Zusammenfassung
// ---------------------------------------------------------------------

/// FNV-1a, 32 bit, über die Bytes (little-endian) einer Liste
fn fnv(bytes: impl Iterator<Item = u8>) -> u64 {
    let mut h: u32 = 0x811c9dc5;
    for b in bytes {
        h = (h ^ b as u32).wrapping_mul(0x01000193);
    }
    h as u64
}
fn h32(v: &[f32]) -> u64 {
    fnv(v.iter().flat_map(|x| x.to_bits().to_le_bytes()))
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    #[serde(deserialize_with = "nan_num")]
    pub r: f64,
    /// "a" = fertiger G-Code mit A-Achse, sonst die Zeichnung auf der Oberfläche
    pub mode: String,
    #[serde(default)]
    pub o: WrapOpts,
    pub n: usize,
    pub has_a: bool,
    pub has_plain: bool,
    pub bounds: Bounds,
    #[serde(deserialize_with = "nan_num")]
    pub cut_min_z: f64,
    #[serde(deserialize_with = "nan_num")]
    pub cut_max_z: f64,
}

/// Rohdaten: 4 Byte Länge des Kopfs, Kopf (JSON), dann f32: x0 y0 z0 x1 y1 z1 [a0 a1] dur [durPlain] type line,
/// dann f64: t0
pub fn split_body(body: &[u8]) -> Result<(Head, Prog), String> {
    let hl = u32::from_le_bytes(body.get(..4).ok_or("short body")?.try_into().map_err(|_| "short body")?) as usize;
    let head: Head = serde_json::from_slice(body.get(4..4 + hl).ok_or("short body")?).map_err(|e| e.to_string())?;
    let n = head.n;
    let lists = 9 + if head.has_a { 2 } else { 0 } + usize::from(head.has_plain);
    let need = 4 + hl + n.checked_mul(lists * 4 + 8).ok_or("too big")?;
    if body.len() != need {
        return Err(format!("expected {need} bytes, got {}", body.len()));
    }
    let mut at = 4 + hl;
    let mut f32s = || {
        let v: Vec<f32> = body[at..at + n * 4].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        at += n * 4;
        v
    };
    let (x0, y0, z0, x1, y1, z1) = (f32s(), f32s(), f32s(), f32s(), f32s(), f32s());
    let (a0, a1) = if head.has_a { (Some(f32s()), Some(f32s())) } else { (None, None) };
    let dur = f32s();
    let dur_plain = if head.has_plain { Some(f32s()) } else { None };
    let kind: Vec<u8> = f32s().into_iter().map(|v| v as u8).collect();
    let line: Vec<u32> = f32s().into_iter().map(|v| v as u32).collect();
    let t0: Vec<f64> = body[at..at + n * 8].chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    Ok((head, Prog { n, x0, y0, z0, x1, y1, z1, a0, a1, kind, line, t0, dur, dur_plain }))
}

/// Zusammenfassung wie rotarySimSummary in src/sim/rotarySimRust.ts
pub fn summary(w: &Wrapped, head: &Head) -> Value {
    let (cmin, cmax) = w.cut.unwrap_or((head.cut_min_z, head.cut_max_z));
    let mut rot = json!({ "R": head.r, "flat": head.bounds, "aMin": w.a_min, "aMax": w.a_max, "along": if w.along_y { "y" } else { "x" }, "depth": h32(&w.depth) });
    if let Some(t) = &w.theta {
        rot["theta"] = json!(h32(t));
    }
    if let Some(rs) = &w.raster {
        rot["raster"] = json!({ "x0": h32(&rs.x0), "y0": h32(&rs.y0), "z0": h32(&rs.z0), "x1": h32(&rs.x1), "y1": h32(&rs.y1), "z1": h32(&rs.z1),
            "face": rs.face.as_ref().map(|f| fnv(f.iter().flat_map(|v| v.to_le_bytes()))) });
    }
    let mut out = json!({ "n": w.n, "bounds": w.bounds, "cutMinZ": cmin, "cutMaxZ": cmax,
        "x0": h32(&w.x0), "y0": h32(&w.y0), "z0": h32(&w.z0), "x1": h32(&w.x1), "y1": h32(&w.y1), "z1": h32(&w.z1),
        "type": fnv(w.kind.iter().copied()), "line": fnv(w.line.iter().flat_map(|v| v.to_le_bytes())),
        "t0": fnv(w.t0.iter().flat_map(|v| v.to_bits().to_le_bytes())), "dur": h32(&w.dur), "rotary": rot });
    if let Some(dp) = &w.dur_plain {
        out["durPlain"] = json!(h32(dp));
    }
    out
}

pub fn run(head: &Head, p: &Prog) -> Value {
    let w = wrap_sim_program(p, head.r, head.mode == "a", &head.o);
    summary(&w, head)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rotarystock::*;
    use std::io::Read;

    fn b64(s: &str) -> Vec<u8> {
        let val = |c: u8| match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            _ => 63,
        } as u32;
        let chars: Vec<u8> = s.bytes().filter(|&c| c != b'=').collect();
        let mut out = vec![];
        for ch in chars.chunks(4) {
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
    fn same_wrap_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("rotarysim-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        let cases = all["cases"].as_array().unwrap();
        assert!(cases.len() >= 60);
        for c in cases {
            let (head, p) = split_body(&b64(c["body"].as_str().unwrap())).unwrap();
            same(&run(&head, &p), &c["want"], &format!("{}", c["name"]));
        }
        for h in all["helpers"].as_array().unwrap() {
            let s: RotaryStock = serde_json::from_value(h["s"].clone()).unwrap();
            let at = format!("stock {}", h["s"]);
            let fs = faces(&s);
            let cone: Vec<f64> = [-10.0, 0.0, 13.3, 40.0, 80.0, 200.0].iter().map(|a| cone_radius(&s, *a)).collect();
            let surface: Vec<f64> = [-3.0, -1.0, -0.2, 0.0, 0.3, 1.0, 2.5, 3.1].iter().map(|phi| surface_radius(&s, &fs, 20.0, *phi)).collect();
            let fa: Vec<Value> = if fs.is_empty() { vec![] } else { [-50.0, -0.1, 0.0, 5.0, 33.3, 64.0, 1000.0].iter().map(|u| { let (i, c) = face_at(&fs, *u); json!([fs[i].k, c]) }).collect() };
            let got = json!({ "s": h["s"], "faces": fs, "perimeter": perimeter(&s), "corner": corner_radius(&s),
                "ref": if !fs.is_empty() || s.shape != "poly" { json!(ref_radius(&s)) } else { Value::Null }, "min": min_radius(&s), "coneCenter": cone_center(&s),
                "cone": cone, "section": [section_at(&s, 0.0, 72.0), section_at(&s, 33.0, 72.0)], "section7": section_at(&s, 5.0, 7.0), "surface": surface, "faceAt": fa });
            same(&got, h, &at);
        }
        for r in all["radial"].as_array().unwrap() {
            let g = |k: &str| r[k].as_f64().unwrap();
            same(&json!(radial_depth(g("q"), g("z"), g("R"))), &r["d"], "radialDepth");
        }
        println!("{} wrapped programs the same as rotarySim.ts", cases.len());
    }
}
