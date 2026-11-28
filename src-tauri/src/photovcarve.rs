//! FOTO MIT DEM V-STICHEL – Zwilling von `src/photoVcarve.ts` (photoPlan, photoLines, coneDepth, depthForWidth,
//! widthAtDepth) samt dem Abtaster des Dialogs (photoVcarveDialog.ts: bilinear im aufbereiteten Raster).
//!
//! Parallele Linien im festen Abstand; je dunkler, desto tiefer (und breiter) schneidet der Stichel. Helle Stellen
//! werden ausgelassen; nie tiefer als maxDepth und als der Kegel hoch ist. Die G-Code-Zeilen gehen durchgangsweise.
//! Folgt dem TypeScript Zeile für Zeile; der Test vergleicht die Zeilen Zeichen für Zeichen. Nur Vergleich: welche
//! Datei die Maschine bekommt, bestimmt weiter das Fenster. Gemeinsame Fälle: `tests/fixtures/photovcarve-cases.json.gz`.

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath::{self, js_num, to_fixed};
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PhotoOpts {
    pub x0: f64,
    pub y0: f64,
    pub w: f64,
    pub h: f64,
    pub spacing: f64,
    pub angle: f64,
    pub tip_dia: f64,
    pub tool_dia: f64,
    pub max_depth: f64,
    pub step_down: f64,
    pub lines: f64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct PhotoPt {
    pub x: f64,
    pub y: f64,
    pub d: f64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct PhotoPlan {
    pub segs: Vec<Vec<PhotoPt>>,
    pub deepest: f64,
    pub clipped: f64,
    pub lines: f64,
}

fn half(angle: f64) -> f64 {
    mx(10.0, mn(170.0, angle)) / 2.0 * PI / 180.0
}
/// Höhe des Kegels
pub fn cone_depth(o: &PhotoOpts) -> f64 {
    mx(0.0, (o.tool_dia - o.tip_dia) / 2.0 / jsmath::tan(half(o.angle)))
}
/// Tiefe für eine Nut der Breite w; 0 = hier nicht schneiden
pub fn depth_for_width(w: f64, o: &PhotoOpts) -> f64 {
    let tip = mx(0.0, o.tip_dia);
    if w < mx(tip / 2.0, 0.02) {
        return 0.0;
    }
    mx(0.02, (w - tip) / 2.0 / jsmath::tan(half(o.angle)))
}
/// Breite der Nut bei dieser Tiefe
pub fn width_at_depth(d: f64, o: &PhotoOpts) -> f64 {
    if d > 0.0 {
        mx(0.0, o.tip_dia) + 2.0 * d * jsmath::tan(half(o.angle))
    } else {
        0.0
    }
}
pub fn sample_step(spacing: f64) -> f64 {
    mx(0.05, mn(0.3, spacing / 3.0))
}

/// Stücke einer Linie, die tiefer als `above` sind; Übergänge genau zwischen den Stützstellen
fn cut_parts(line: &[PhotoPt], above: f64) -> Vec<Vec<PhotoPt>> {
    let mut out: Vec<Vec<PhotoPt>> = vec![];
    let mut cur: Vec<PhotoPt> = vec![];
    let mix = |a: PhotoPt, b: PhotoPt| {
        let f = (above - a.d) / (b.d - a.d);
        PhotoPt { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, d: above }
    };
    for i in 0..line.len() {
        let p = line[i];
        let q = line.get(i + 1).copied();
        if p.d > above {
            cur.push(p);
            if q.is_none_or(|q| q.d <= above) {
                if let Some(q) = q {
                    cur.push(mix(p, q));
                }
                out.push(std::mem::take(&mut cur));
            }
        } else if let Some(q) = q {
            if q.d > above {
                cur = vec![mix(p, q)];
            }
        }
    }
    out.into_iter().filter(|s| s.len() > 1).collect()
}

/// Punkte weglassen, die auf der Geraden im Raum liegen (Tiefe weicht weniger als 0,01 mm ab)
fn thin(p: &[PhotoPt]) -> Vec<PhotoPt> {
    if p.len() < 3 {
        return p.to_vec();
    }
    let mut keep = vec![false; p.len()];
    keep[0] = true;
    keep[p.len() - 1] = true;
    let mut stack = vec![(0usize, p.len() - 1)];
    while let Some((i, j)) = stack.pop() {
        let l = hypot2(p[j].x - p[i].x, p[j].y - p[i].y);
        let len = if l == 0.0 || l.is_nan() { 1.0 } else { l };
        let (mut worst, mut at) = (0.01, 0usize);
        let mut found = false;
        for k in i + 1..j {
            let f = hypot2(p[k].x - p[i].x, p[k].y - p[i].y) / len;
            let e = (p[i].d + (p[j].d - p[i].d) * f - p[k].d).abs();
            if e > worst {
                worst = e;
                at = k;
                found = true;
            }
        }
        if found && at > 0 {
            keep[at] = true;
            stack.push((i, at));
            stack.push((at, j));
        }
    }
    p.iter().zip(&keep).filter(|(_, k)| **k).map(|(q, _)| *q).collect()
}

/// dark(u, v) = Dunkelheit 0…1 an der Stelle u (von links) und v (von unten) in mm
pub fn photo_plan(dark: &dyn Fn(f64, f64) -> f64, o: &PhotoOpts) -> PhotoPlan {
    let a = o.lines * PI / 180.0;
    let (ux, uy) = (jsmath::cos(a), jsmath::sin(a));
    let (nx, ny) = (-uy, ux);
    let limit = mn(o.max_depth, cone_depth(o));
    let mut segs: Vec<Vec<PhotoPt>> = vec![];
    let (mut deepest, mut over, mut all, mut count) = (0.0f64, 0.0, 0.0, 0.0);
    let cs: Vec<f64> = [[0.0, 0.0], [o.w, 0.0], [0.0, o.h], [o.w, o.h]].iter().map(|[x, y]| x * nx + y * ny).collect();
    let lo = cs.iter().copied().fold(f64::INFINITY, mn);
    let hi = cs.iter().copied().fold(f64::NEG_INFINITY, mx);
    let n = mx(1.0, ((hi - lo) / o.spacing + 1e-9).floor());
    let rest = (hi - lo - (n - 1.0) * o.spacing) / 2.0;
    let mut k = 0.0;
    while k < n {
        let c = lo + rest + k * o.spacing;
        k += 1.0;
        let (mut s0, mut s1, mut ok) = (f64::NEG_INFINITY, f64::INFINITY, true);
        for (p, d, size) in [(c * nx, ux, o.w), (c * ny, uy, o.h)] {
            if d.abs() < 1e-9 {
                if p < -1e-9 || p > size + 1e-9 {
                    ok = false;
                }
                continue;
            }
            let (t0, t1) = (-p / d, (size - p) / d);
            s0 = mx(s0, mn(t0, t1));
            s1 = mn(s1, mx(t0, t1));
        }
        if !ok || !(s1 - s0 > 1e-6) {
            continue;
        }
        count += 1.0;
        let m = mx(1.0, ((s1 - s0) / sample_step(o.spacing)).ceil());
        let mut line: Vec<PhotoPt> = vec![];
        let mut i = 0.0;
        while i <= m {
            let s = s0 + (s1 - s0) * i / m;
            let (x, y) = (c * nx + s * ux, c * ny + s * uy);
            let want = depth_for_width(o.spacing * mx(0.0, mn(1.0, dark(x, y))), o);
            if want > limit + 1e-9 {
                over += 1.0;
            }
            all += 1.0;
            line.push(PhotoPt { x: o.x0 + x, y: o.y0 + y, d: mn(want, limit) });
            i += 1.0;
        }
        let mut parts = cut_parts(&line, 0.0);
        if count % 2.0 == 0.0 {
            parts.reverse();
            for p in parts.iter_mut() {
                p.reverse();
            }
        }
        for p in parts {
            let t = thin(&p);
            for q in &t {
                deepest = mx(deepest, q.d);
            }
            segs.push(t);
        }
    }
    PhotoPlan { segs, deepest, clipped: if all > 0.0 { over / all } else { 0.0 }, lines: count }
}

/// Tiefe auf floor begrenzen; wo die Kurve floor kreuzt, kommt ein Punkt dazu
fn clamp_part(p: &[PhotoPt], floor: f64) -> Vec<PhotoPt> {
    if !floor.is_finite() {
        return p.to_vec();
    }
    let mut out = vec![];
    for (i, a) in p.iter().enumerate() {
        out.push(PhotoPt { d: mn(a.d, floor), ..*a });
        if let Some(b) = p.get(i + 1) {
            if (a.d - floor) * (b.d - floor) < 0.0 {
                let t = (floor - a.d) / (b.d - a.d);
                out.push(PhotoPt { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, d: floor });
            }
        }
    }
    out
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct PhotoLines {
    pub lines: Vec<String>,
    pub cut: f64,
    pub air: f64,
}

/// G-Code-Zeilen: durchgangsweise; in jedem Durchgang nur, was tiefer liegt als der vorige
pub fn photo_lines(plan: &PhotoPlan, o: &PhotoOpts, feed: f64, plunge: f64, safe_z: f64) -> PhotoLines {
    let f = |v: f64| to_fixed(v, 3);
    let mut lines: Vec<String> = vec![];
    let clear = mn(safe_z, 1.5);
    let (mut cut, mut air, mut lx, mut ly) = (0.0, 0.0, 0.0, 0.0);
    let step = mx(0.05, o.step_down);
    let passes = mx(1.0, (plan.deepest / step - 1e-6).ceil());
    let (fs, ps) = (js_num(feed), js_num(plunge));
    let mut k = 0.0;
    while k < passes {
        let above = k * step;
        let floor = if k == passes - 1.0 { f64::INFINITY } else { (k + 1.0) * step };
        if k > 0.0 {
            lines.push(format!("G0 Z{}", f(safe_z)));
        }
        for seg in &plan.segs {
            let parts = if k == 0.0 { vec![seg.clone()] } else { cut_parts(seg, above) };
            for part in parts {
                let pts = clamp_part(&part, floor);
                let a = pts[0];
                lines.push(format!("G0 X{} Y{}", f(a.x), f(a.y)));
                lines.push(format!("G1 Z{} F{ps}", f(-a.d)));
                air += hypot2(a.x - lx, a.y - ly);
                for i in 1..pts.len() {
                    let fw = if i == 1 { format!(" F{fs}") } else { String::new() };
                    lines.push(format!("G1 X{} Y{} Z{}{fw}", f(pts[i].x), f(pts[i].y), f(-pts[i].d)));
                    cut += hypot2(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
                }
                lines.push(format!("G0 Z{}", f(clear)));
                lx = pts[pts.len() - 1].x;
                ly = pts[pts.len() - 1].y;
            }
        }
        k += 1.0;
    }
    lines.push(format!("G0 Z{}", f(safe_z)));
    PhotoLines { lines, cut, air }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    pub opts: PhotoOpts,
    pub nx: usize,
    pub ny: usize,
    pub feed: f64,
    pub plunge: f64,
    pub safe_z: f64,
}

/// Kopf (JSON) und Raster (f32, little-endian) aus dem Rohdaten-Aufruf
pub fn split_body(body: &[u8]) -> Result<(Head, Vec<f32>), String> {
    let n = u32::from_le_bytes(body.get(..4).ok_or("short body")?.try_into().map_err(|_| "short body")?) as usize;
    let head: Head = serde_json::from_slice(body.get(4..4 + n).ok_or("short body")?).map_err(|e| e.to_string())?;
    let data = &body[4 + n..];
    if data.len() != head.nx * head.ny * 4 {
        return Err(format!("grid has {} bytes, expected {}", data.len(), head.nx * head.ny * 4));
    }
    Ok((head, data.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()))
}

/// Wie der Dialog: bilinear im Raster g (nx × ny, Zeile 0 = oben), dann Plan und Zeilen
pub fn run(head: &Head, g: &[f32]) -> serde_json::Value {
    let (nx, ny, o) = (head.nx as f64, head.ny as f64, &head.opts);
    let w = head.nx;
    let at = |u: f64, v: f64| -> f64 {
        let fx = mx(0.0, mn(nx - 1.0, u / o.w * (nx - 1.0)));
        let fy = mx(0.0, mn(ny - 1.0, (1.0 - v / o.h) * (ny - 1.0)));
        let i = mn(nx - 2.0, fx.floor());
        let j = mn(ny - 2.0, fy.floor());
        let (a, b) = (fx - i, fy - j);
        let (i, j) = (i as usize, j as usize);
        let gv = |k: usize| g[k] as f64;
        (gv(j * w + i) * (1.0 - a) + gv(j * w + i + 1) * a) * (1.0 - b) + (gv((j + 1) * w + i) * (1.0 - a) + gv((j + 1) * w + i + 1) * a) * b
    };
    let plan = photo_plan(&at, o);
    let pl = photo_lines(&plan, o, head.feed, head.plunge, head.safe_z);
    serde_json::json!({ "plan": plan, "lines": pl.lines, "cut": pl.cut, "air": pl.air, "width": width_at_depth(plan.deepest, o) })
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
        };
        let bytes: Vec<u8> = s.bytes().filter(|&c| c != b'=').collect();
        let mut out = vec![];
        for ch in bytes.chunks(4) {
            let v: Vec<u32> = ch.iter().map(|&c| val(c) as u32).collect();
            let n = v.iter().enumerate().fold(0u32, |a, (i, x)| a | (x << (18 - 6 * i)));
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
    fn fnv(t: &str) -> u64 {
        let mut h: u32 = 0x811c9dc5;
        for b in t.bytes() {
            h = (h ^ b as u32).wrapping_mul(0x01000193);
        }
        h as u64
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
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("photovcarve-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let cases: Value = serde_json::from_str(&text).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 20, "only {} cases", cases.len());
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let head: Head = serde_json::from_value(c["head"].clone()).unwrap();
            let g: Vec<f32> = b64(c["grid"].as_str().unwrap()).chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
            let mut got = run(&head, &g);
            let segs = got["plan"]["segs"].as_array().unwrap().clone();
            let pts: Vec<String> = segs.iter().flat_map(|s| s.as_array().unwrap().iter().flat_map(|q| ["x", "y", "d"].map(|k| to_fixed(q[k].as_f64().unwrap(), 6)))).collect();
            got["plan"]["segs"] = serde_json::json!({ "n": segs.len(), "pts": pts.len(), "h": fnv(&pts.join(",")) });
            let lines: Vec<String> = serde_json::from_value(got["lines"].clone()).unwrap();
            if lines.len() > 300 {
                got["lines"] = serde_json::json!({ "n": lines.len(), "h": fnv(&lines.join("\n")) });
            } else if let Some(w) = c["want"]["lines"].as_array() {
                if let Some(i) = lines.iter().zip(w).position(|(a, b)| a != b.as_str().unwrap()) {
                    panic!("{name}: line {}: {} vs {}", i + 1, lines[i], w[i]);
                }
            }
            same(&got, &c["want"], name);
        }
        println!("{} photo V-carve jobs the same as photoVcarve.ts", cases.len());
    }
}
