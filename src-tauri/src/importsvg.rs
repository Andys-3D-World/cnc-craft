//! SVG-PFADE – Zwilling von `parsePathData` und `parseTransform` in `src/importers/svgPath.ts`.
//!
//! Das SVG selbst liest der Browser (DOMParser) – das bleibt im Fenster. Hier wird gerechnet: Pfad-Daten ("d") mit allen
//! Befehlen M L H V C S Q T A Z (absolut/relativ, Bogen-Flags ohne Trennzeichen) in Linienzüge, transform-Angaben in eine
//! Matrix. Folgt dem TypeScript Zeile für Zeile; Kurven gehen über Sinus/Kosinus/Wurzel, darum vergleicht der Test Zahlen
//! auf 1e-9 genau. Gemeinsame Fälle: `tests/fixtures/importsvg-cases.json` (festgehalten von `tests/importSvgRust.test.ts`).
//! Nicht nachgebaut: kaputte Pfade, bei denen JavaScript Zahlen und Buchstaben zu Text zusammenfügt – dort rechnet Rust
//! mit „keine Zahl“ weiter.

use crate::gcodesim::{hypot2, js_space, mn, mx};
use crate::importdxf::parse_float;
use crate::importplt::{arc_segments, Pt};
use crate::jsmath;
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

type Mat = [f64; 6];
const IDENTITY: Mat = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

#[derive(Serialize, Clone, Debug)]
pub struct Sub {
    pub pts: Vec<Pt>,
    pub closed: bool,
}
#[derive(Deserialize)]
pub struct Job {
    pub paths: Vec<(String, f64)>,
    pub transforms: Vec<String>,
}
#[derive(Serialize)]
pub struct Output {
    pub paths: Vec<Vec<Sub>>,
    pub transforms: Vec<Mat>,
}

pub fn run(job: &Job) -> Output {
    Output { paths: job.paths.iter().map(|(d, tol)| parse_path_data(d, *tol)).collect(), transforms: job.transforms.iter().map(|t| parse_transform(t)).collect() }
}

fn mat_mul(m: &Mat, n: &Mat) -> Mat {
    [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ]
}
fn translate(tx: f64, ty: f64) -> Mat {
    [1.0, 0.0, 0.0, 1.0, tx, ty]
}
/// `a || 0` (NaN, 0 und „fehlt“ werden 0)
fn or0(v: Option<f64>) -> f64 {
    v.filter(|v| *v != 0.0 && !v.is_nan()).unwrap_or(0.0)
}
/// `s.trim().split(/[\s,]+/)` – Teile zwischen Läufen aus Leerzeichen/Kommas (am Anfang ein leerer Teil, wenn ein Komma vorne steht)
fn js_split(s: &str) -> Vec<f64> {
    let t = s.trim_matches(js_space);
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_sep = false;
    for ch in t.chars() {
        if js_space(ch) || ch == ',' {
            if !in_sep {
                out.push(parse_float(&cur));
                cur.clear();
                in_sep = true;
            }
        } else {
            in_sep = false;
            cur.push(ch);
        }
    }
    out.push(parse_float(&cur));
    out
}

pub fn parse_transform(t: &str) -> Mat {
    let mut m = IDENTITY;
    let c: Vec<char> = t.chars().collect();
    let lower: Vec<char> = c.iter().map(|ch| ch.to_ascii_lowercase()).collect();
    let names = ["matrix", "translate", "scale", "rotate", "skewx", "skewy"];
    let mut i = 0;
    while i < c.len() {
        // Muster (matrix|translate|…)\s*\(([^)]*)\) ohne Groß/Klein
        let hit = names.iter().find_map(|name| {
            let nl: Vec<char> = name.chars().collect();
            if !lower[i..].starts_with(&nl) {
                return None;
            }
            let mut j = i + nl.len();
            while j < c.len() && js_space(c[j]) {
                j += 1;
            }
            if c.get(j) != Some(&'(') {
                return None;
            }
            let close = c[j + 1..].iter().position(|&ch| ch == ')')? + j + 1;
            Some((*name, c[j + 1..close].iter().collect::<String>(), close + 1))
        });
        let Some((name, args, next)) = hit else {
            i += 1;
            continue;
        };
        i = next;
        let a = js_split(&args);
        let at = |k: usize| a.get(k).copied();
        let n: Mat = match name {
            "matrix" if a.len() >= 6 => [a[0], a[1], a[2], a[3], a[4], a[5]],
            "translate" => translate(or0(at(0)), or0(at(1))),
            "scale" => {
                let sx = at(0).unwrap_or(1.0);
                [sx, 0.0, 0.0, if a.len() > 1 { a[1] } else { sx }, 0.0, 0.0]
            }
            "rotate" => {
                let rad = (or0(at(0)) * PI) / 180.0;
                let (co, si) = (jsmath::cos(rad), jsmath::sin(rad));
                let r = [co, si, -si, co, 0.0, 0.0];
                if a.len() >= 3 {
                    mat_mul(&translate(a[1], a[2]), &mat_mul(&r, &translate(-a[1], -a[2])))
                } else {
                    r
                }
            }
            "skewx" => [1.0, 0.0, jsmath::tan((or0(at(0)) * PI) / 180.0), 1.0, 0.0, 0.0],
            "skewy" => [1.0, jsmath::tan((or0(at(0)) * PI) / 180.0), 0.0, 1.0, 0.0, 0.0],
            _ => IDENTITY,
        };
        m = mat_mul(&m, &n);
    }
    m
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Tok {
    Num(f64),
    Cmd(char),
}

/// Muster `([MmZz…Aa])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)`: Länge der Zahl ab i (0 = keine)
fn number_len(c: &[char], i: usize) -> usize {
    let digits = |mut j: usize| {
        while j < c.len() && c[j].is_ascii_digit() {
            j += 1;
        }
        j
    };
    let s = i + usize::from(matches!(c.get(i), Some('-') | Some('+')));
    let mut j;
    if c.get(s).is_some_and(|ch| ch.is_ascii_digit()) {
        j = digits(s);
        if c.get(j) == Some(&'.') {
            j = digits(j + 1);
        }
    } else if c.get(s) == Some(&'.') && c.get(s + 1).is_some_and(|ch| ch.is_ascii_digit()) {
        j = digits(s + 1);
    } else {
        return 0;
    }
    if matches!(c.get(j), Some('e') | Some('E')) {
        let k = j + 1 + usize::from(matches!(c.get(j + 1), Some('-') | Some('+')));
        let e = digits(k);
        if e > k {
            j = e;
        }
    }
    j - i
}

fn tokenize(d: &str) -> Vec<Tok> {
    let c: Vec<char> = d.chars().collect();
    let mut out = Vec::new();
    let (mut last_cmd, mut arg) = (' ', 0usize);
    let mut i = 0;
    while i < c.len() {
        if "MmZzLlHhVvCcSsQqTtAa".contains(c[i]) {
            out.push(Tok::Cmd(c[i]));
            last_cmd = c[i].to_ascii_uppercase();
            arg = 0;
            i += 1;
            continue;
        }
        let len = number_len(&c, i);
        if len == 0 {
            i += 1;
            continue;
        }
        let s: String = c[i..i + len].iter().collect();
        // Bogen-Flags (4. und 5. Argument) können zusammengeschrieben sein: "a10 10 0 0110 20"
        if last_cmd == 'A' {
            let pos = arg % 7;
            if (pos == 3 || pos == 4) && (s.starts_with('0') || s.starts_with('1')) && s.chars().count() > 1 && !s.contains('.') {
                out.push(Tok::Num(if s.starts_with('1') { 1.0 } else { 0.0 }));
                arg += 1;
                i += 1; // Rest erneut lesen
                continue;
            }
        }
        out.push(Tok::Num(parse_float(&s)));
        arg += 1;
        i += len;
    }
    out
}

pub(crate) fn flatten_cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, tol: f64) -> Vec<Pt> {
    let ddx = mx((p0.x - 2.0 * p1.x + p2.x).abs(), (p1.x - 2.0 * p2.x + p3.x).abs());
    let ddy = mx((p0.y - 2.0 * p1.y + p2.y).abs(), (p1.y - 2.0 * p2.y + p3.y).abs());
    let n = mn(500.0, mx(1.0, ((0.75 * hypot2(ddx, ddy)) / tol).sqrt().ceil()));
    if n.is_nan() {
        return vec![];
    }
    (1..=n as usize)
        .map(|i| {
            let t = i as f64 / n;
            let u = 1.0 - t;
            Pt {
                x: u * u * u * p0.x + 3.0 * u * u * t * p1.x + 3.0 * u * t * t * p2.x + t * t * t * p3.x,
                y: u * u * u * p0.y + 3.0 * u * u * t * p1.y + 3.0 * u * t * t * p2.y + t * t * t * p3.y,
            }
        })
        .collect()
}
fn flatten_quad(p0: Pt, p1: Pt, p2: Pt, tol: f64) -> Vec<Pt> {
    let dd = hypot2(p0.x - 2.0 * p1.x + p2.x, p0.y - 2.0 * p1.y + p2.y);
    let n = mn(500.0, mx(1.0, ((0.25 * dd) / tol).sqrt().ceil()));
    if n.is_nan() {
        return vec![];
    }
    (1..=n as usize)
        .map(|i| {
            let t = i as f64 / n;
            let u = 1.0 - t;
            Pt { x: u * u * p0.x + 2.0 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2.0 * u * t * p1.y + t * t * p2.y }
        })
        .collect()
}

/// SVG-Ellipsenbogen (Endpunkt-Schreibweise) in Punkte (ohne Startpunkt)
#[allow(clippy::too_many_arguments)]
fn arc_to_points(x1: f64, y1: f64, mut rx: f64, mut ry: f64, rot_deg: f64, large: f64, sweep: f64, x2: f64, y2: f64, tol: f64) -> Vec<Pt> {
    if rx == 0.0 || ry == 0.0 || (x1 == x2 && y1 == y2) {
        return vec![Pt { x: x2, y: y2 }];
    }
    let phi = (rot_deg * PI) / 180.0;
    let (cp, sp) = (jsmath::cos(phi), jsmath::sin(phi));
    let (dx, dy) = ((x1 - x2) / 2.0, (y1 - y2) / 2.0);
    let (x1p, y1p) = (cp * dx + sp * dy, -sp * dx + cp * dy);
    let lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if lam > 1.0 {
        let s = lam.sqrt();
        rx *= s;
        ry *= s;
    }
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let mut coef = mx(0.0, num / den).sqrt();
    if large == sweep {
        coef = -coef;
    }
    let (cxp, cyp) = ((coef * rx * y1p) / ry, (-coef * ry * x1p) / rx);
    let cx = cp * cxp - sp * cyp + (x1 + x2) / 2.0;
    let cy = sp * cxp + cp * cyp + (y1 + y2) / 2.0;
    let ang = |ux: f64, uy: f64, vx: f64, vy: f64| jsmath::atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    let t1 = ang(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let mut dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if sweep == 0.0 && dt > 0.0 {
        dt -= PI * 2.0;
    }
    if sweep != 0.0 && dt < 0.0 {
        dt += PI * 2.0;
    }
    let n = arc_segments(mx(rx, ry), dt, tol);
    if n.is_nan() {
        return vec![]; // out[-1] = … ändert in JavaScript die leere Liste nicht
    }
    let mut out: Vec<Pt> = (1..=n as usize)
        .map(|i| {
            let t = t1 + (dt * i as f64) / n;
            let (ex, ey) = (rx * jsmath::cos(t), ry * jsmath::sin(t));
            Pt { x: cp * ex - sp * ey + cx, y: sp * ex + cp * ey + cy }
        })
        .collect();
    if let Some(l) = out.last_mut() {
        *l = Pt { x: x2, y: y2 };
    }
    out
}

pub fn parse_path_data(d: &str, tol: f64) -> Vec<Sub> {
    let tokens = tokenize(d);
    let mut out: Vec<Sub> = Vec::new();
    let mut cur: Vec<Pt> = Vec::new();
    let (mut x, mut y, mut sx, mut sy) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut last_ctrl: Option<Pt> = None;
    let mut last_cmd = ' ';
    let mut i = 0usize;
    let mut cmd: Option<char> = None;
    fn flush(cur: &mut Vec<Pt>, out: &mut Vec<Sub>, closed: bool) {
        if cur.len() >= 2 {
            out.push(Sub { pts: std::mem::take(cur), closed });
        }
        cur.clear();
    }
    while i < tokens.len() {
        if let Tok::Cmd(ch) = tokens[i] {
            cmd = Some(ch);
            i += 1;
        } else if cmd.is_none() {
            i += 1;
            continue;
        }
        let ch = cmd.unwrap_or(' ');
        let rel = ch.is_ascii_lowercase();
        let up = ch.to_ascii_uppercase();
        let is_num = |i: usize| matches!(tokens.get(i), Some(Tok::Num(_)));
        // tokens[i++] als Zahl (ein Befehl oder das Ende gibt hier „keine Zahl“)
        macro_rules! n {
            () => {{
                let v = match tokens.get(i) {
                    Some(Tok::Num(v)) => *v,
                    _ => f64::NAN,
                };
                i += 1;
                v
            }};
        }
        match up {
            'M' => {
                if !is_num(i) {
                    i += 1;
                } else {
                    flush(&mut cur, &mut out, false);
                    x = (if rel { x } else { 0.0 }) + n!();
                    y = (if rel { y } else { 0.0 }) + n!();
                    sx = x;
                    sy = y;
                    cur = vec![Pt { x, y }];
                    cmd = Some(if rel { 'l' } else { 'L' }); // weitere Koordinaten = Linien
                    last_ctrl = None;
                }
            }
            'L' | 'H' | 'V' if !is_num(i) => i += 1,
            'L' => {
                x = (if rel { x } else { 0.0 }) + n!();
                y = (if rel { y } else { 0.0 }) + n!();
                cur.push(Pt { x, y });
                last_ctrl = None;
            }
            'H' => {
                x = (if rel { x } else { 0.0 }) + n!();
                cur.push(Pt { x, y });
                last_ctrl = None;
            }
            'V' => {
                y = (if rel { y } else { 0.0 }) + n!();
                cur.push(Pt { x, y });
                last_ctrl = None;
            }
            'C' | 'S' | 'Q' | 'T' | 'A' if !is_num(i) => i += 1,
            'C' | 'S' => {
                let (bx, by) = if rel { (x, y) } else { (0.0, 0.0) };
                let p1 = if up == 'C' {
                    Pt { x: bx + n!(), y: by + n!() }
                } else {
                    match last_ctrl {
                        Some(lc) if last_cmd == 'C' || last_cmd == 'S' => Pt { x: 2.0 * x - lc.x, y: 2.0 * y - lc.y },
                        _ => Pt { x, y },
                    }
                };
                let p2 = Pt { x: bx + n!(), y: by + n!() };
                let p3 = Pt { x: bx + n!(), y: by + n!() };
                cur.extend(flatten_cubic(Pt { x, y }, p1, p2, p3, tol));
                x = p3.x;
                y = p3.y;
                last_ctrl = Some(p2);
            }
            'Q' | 'T' => {
                let (bx, by) = if rel { (x, y) } else { (0.0, 0.0) };
                let p1 = if up == 'Q' {
                    Pt { x: bx + n!(), y: by + n!() }
                } else {
                    match last_ctrl {
                        Some(lc) if last_cmd == 'Q' || last_cmd == 'T' => Pt { x: 2.0 * x - lc.x, y: 2.0 * y - lc.y },
                        _ => Pt { x, y },
                    }
                };
                let p2 = Pt { x: bx + n!(), y: by + n!() };
                cur.extend(flatten_quad(Pt { x, y }, p1, p2, tol));
                x = p2.x;
                y = p2.y;
                last_ctrl = Some(p1);
            }
            'A' => {
                let (rx, ry, rot) = (n!().abs(), n!().abs(), n!());
                // Flags: nur die Zahl 1 zählt als 1
                let large = if n!() == 1.0 { 1.0 } else { 0.0 };
                let sweep = if n!() == 1.0 { 1.0 } else { 0.0 };
                let ex = (if rel { x } else { 0.0 }) + n!();
                let ey = (if rel { y } else { 0.0 }) + n!();
                cur.extend(arc_to_points(x, y, rx, ry, rot, large, sweep, ex, ey, tol));
                x = ex;
                y = ey;
                last_ctrl = None;
            }
            'Z' => {
                if !cur.is_empty() {
                    flush(&mut cur, &mut out, true);
                    x = sx;
                    y = sy;
                    cur = vec![Pt { x, y }];
                }
                last_ctrl = None;
                cmd = None;
            }
            _ => i += 1,
        }
        last_cmd = up;
    }
    flush(&mut cur, &mut out, false);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn square_and_flags_without_spaces() {
        let s = parse_path_data("M0 0 H10 V10 h-10 z", 0.01);
        assert_eq!((s.len(), s[0].closed, s[0].pts.len()), (1, true, 4));
        assert_eq!(tokenize("a1 1 0 0110 20"), [1.0, 1.0, 0.0, 0.0, 1.0, 10.0, 20.0].iter().map(|v| Tok::Num(*v)).fold(vec![Tok::Cmd('a')], |mut a, t| {
            a.push(t);
            a
        }));
        assert_eq!(parse_transform("translate(5) scale(2)"), [2.0, 0.0, 0.0, 2.0, 5.0, 0.0]);
    }

    /// Dieselben Fälle wie tests/importSvgRust.test.ts: Zahlen auf 1e-9 genau, alles andere exakt
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
                    assert_eq!(x.len(), y.len(), "{at}: keys");
                    for (k, v) in x {
                        same(v, y.get(k).unwrap_or(&Value::Null), &format!("{at}.{k}"));
                    }
                }
                _ => assert_eq!(a, b, "{at}"),
            }
        }
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let c: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("importsvg-cases.json")).unwrap()).unwrap();
        let job: Job = serde_json::from_value(c["job"].clone()).unwrap();
        assert!(job.paths.len() >= 40 && job.transforms.len() >= 20, "{} paths, {} transforms", job.paths.len(), job.transforms.len());
        let got = serde_json::to_value(run(&job)).unwrap();
        for (k, (g, w)) in got["paths"].as_array().unwrap().iter().zip(c["want"]["paths"].as_array().unwrap()).enumerate() {
            same(w, g, &format!("path {k} {:?}", job.paths[k].0));
        }
        for (k, (g, w)) in got["transforms"].as_array().unwrap().iter().zip(c["want"]["transforms"].as_array().unwrap()).enumerate() {
            same(w, g, &format!("transform {k} {:?}", job.transforms[k]));
        }
        assert_eq!(got["paths"].as_array().unwrap().len(), c["want"]["paths"].as_array().unwrap().len());
        println!("{} paths and {} transforms the same as svgPath.ts", job.paths.len(), job.transforms.len());
    }
}
