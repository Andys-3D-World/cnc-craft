//! HPGL/PLT- und G-CODE-IMPORT – Zwilling von `parseHpgl` und `parseGcode` in `src/importers/plotImport.ts`.
//!
//! Liest den Text einer Plotter- oder G-Code-Datei in Linienzüge (mm) und Kreise. Folgt dem TypeScript Zeile für Zeile,
//! auch in den Text-Mustern. Bögen werden mit Sinus/Kosinus in Stücke zerlegt: deren letzte Stelle kann vom Fenster
//! abweichen, darum vergleicht der Test die Punkte auf 1e-9 mm genau, alles andere exakt.
//! Gemeinsame Fälle: `tests/fixtures/importplt-cases.json` (festgehalten von `tests/importPltRust.test.ts`).

use crate::gcodesim::{hypot2, js_space, mn, mx};
use crate::jsmath;
use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}
#[derive(Serialize, Clone, Debug)]
pub struct Path {
    pub pts: Vec<Pt>,
    pub closed: bool,
}
#[derive(Serialize, Clone, Debug)]
pub struct Circle {
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
}
/// Ergebnis: Linienzüge, Kreise und eine Zahl für den Info-Text (HPGL: Befehle, G-Code: Zeilen)
#[derive(Serialize, Clone, Debug)]
pub struct Parsed {
    pub paths: Vec<Path>,
    pub circles: Vec<Circle>,
    pub n: usize,
}

const HPGL_UNIT: f64 = 0.025;
pub(crate) const CURVE_TOL: f64 = 0.01;

/// Anzahl Stücke für einen Bogen (arcSegments in importers/common.ts)
pub(crate) fn arc_segments(r: f64, sweep: f64, tol: f64) -> f64 {
    if r <= tol {
        return mx(2.0, (sweep.abs() / (std::f64::consts::PI / 4.0)).ceil());
    }
    let step = 2.0 * jsmath::acos(mx(-1.0, 1.0 - tol / r));
    mn(2000.0, mx(2.0, (sweep.abs() / step).ceil()))
}
/// Kreisbogen ab Winkel a0 um sweep (mit Startpunkt)
pub(crate) fn arc_points(cx: f64, cy: f64, r: f64, a0: f64, sweep: f64, tol: f64) -> Vec<Pt> {
    let n = arc_segments(r, sweep, tol);
    if n.is_nan() {
        return vec![]; // `i <= NaN` ist in JavaScript nie wahr
    }
    (0..=n as usize)
        .map(|i| {
            let a = a0 + (sweep * i as f64) / n;
            Pt { x: cx + r * jsmath::cos(a), y: cy + r * jsmath::sin(a) }
        })
        .collect()
}

/// `Number(s)` für Teile ohne Buchstaben, Komma und Leerzeichen: None = keine endliche Zahl
fn js_number(s: &str) -> Option<f64> {
    let v: f64 = s.parse().ok()?;
    v.is_finite().then_some(v)
}

pub fn parse_hpgl(text: &str) -> Parsed {
    let mut res = Parsed { paths: vec![], circles: vec![], n: 0 };
    let (mut x, mut y) = (0.0f64, 0.0f64);
    let (mut pen_down, mut absolute) = (false, true);
    let mut cur: Vec<Pt> = Vec::new();
    let c: Vec<char> = text.chars().collect();
    let letter = |ch: char| ch.is_ascii_alphabetic();
    let mut i = 0;
    while i + 1 < c.len() {
        if !(letter(c[i]) && letter(c[i + 1])) {
            i += 1;
            continue;
        }
        let cmd: String = c[i..i + 2].iter().collect::<String>().to_ascii_uppercase();
        let mut e = i + 2;
        while e < c.len() && !letter(c[e]) && c[e] != ';' && c[e] != '\u{3}' {
            e += 1;
        }
        let arg_text: String = c[i + 2..e].iter().collect();
        // split(/[\s,]+/), leere Teile weg, Number(), nur endliche Zahlen
        let args: Vec<f64> = arg_text.split(|ch: char| js_space(ch) || ch == ',').filter(|p| !p.is_empty()).filter_map(js_number).collect();
        i = e;
        res.n += 1;
        let flush = |cur: &mut Vec<Pt>, res: &mut Parsed| {
            if cur.len() >= 2 {
                res.paths.push(Path { pts: std::mem::take(cur), closed: false });
            }
            cur.clear();
        };
        let apply = |args: &[f64], absolute: bool, pen_down: bool, x: &mut f64, y: &mut f64, cur: &mut Vec<Pt>| {
            let mut k = 0;
            while k + 1 < args.len() {
                let nx = if absolute { args[k] } else { *x + args[k] };
                let ny = if absolute { args[k + 1] } else { *y + args[k + 1] };
                if pen_down {
                    if cur.is_empty() {
                        cur.push(Pt { x: *x * HPGL_UNIT, y: *y * HPGL_UNIT });
                    }
                    cur.push(Pt { x: nx * HPGL_UNIT, y: ny * HPGL_UNIT });
                }
                *x = nx;
                *y = ny;
                k += 2;
            }
        };
        match cmd.as_str() {
            "IN" | "DF" => {
                flush(&mut cur, &mut res);
                pen_down = false;
                absolute = true;
                x = 0.0;
                y = 0.0;
            }
            "PA" => {
                absolute = true;
                apply(&args, absolute, pen_down, &mut x, &mut y, &mut cur);
            }
            "PR" => {
                absolute = false;
                apply(&args, absolute, pen_down, &mut x, &mut y, &mut cur);
            }
            "PU" => {
                flush(&mut cur, &mut res);
                pen_down = false;
                apply(&args, absolute, pen_down, &mut x, &mut y, &mut cur);
            }
            "PD" => {
                if !pen_down {
                    cur = vec![Pt { x: x * HPGL_UNIT, y: y * HPGL_UNIT }];
                }
                pen_down = true;
                apply(&args, absolute, pen_down, &mut x, &mut y, &mut cur);
            }
            "CI" => {
                if let Some(&r) = args.first() {
                    if r > 0.0 {
                        res.circles.push(Circle { cx: x * HPGL_UNIT, cy: y * HPGL_UNIT, r: r * HPGL_UNIT });
                    }
                }
            }
            "AA" | "AR" => {
                if args.len() < 3 {
                    continue;
                }
                let cx = if cmd == "AA" { args[0] } else { x + args[0] };
                let cy = if cmd == "AA" { args[1] } else { y + args[1] };
                let sweep = (args[2] * std::f64::consts::PI) / 180.0;
                let r = hypot2(x - cx, y - cy);
                let a0 = jsmath::atan2(y - cy, x - cx);
                let pts = arc_points(cx * HPGL_UNIT, cy * HPGL_UNIT, r * HPGL_UNIT, a0, sweep, CURVE_TOL);
                if pen_down {
                    if cur.is_empty() {
                        cur.push(pts[0]);
                    }
                    cur.extend_from_slice(&pts[1..]);
                }
                x = cx + r * jsmath::cos(a0 + sweep);
                y = cy + r * jsmath::sin(a0 + sweep);
            }
            _ => {}
        }
    }
    if cur.len() >= 2 {
        res.paths.push(Path { pts: cur, closed: false });
    }
    res
}

fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Wörter einer Zeile (schon groß geschrieben): Muster `([A-Z])\s*([-+]?\d*\.?\d+)`
fn words(code: &[char]) -> Vec<(char, f64)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < code.len() {
        if code[i].is_ascii_uppercase() {
            let mut j = i + 1;
            while j < code.len() && js_space(code[j]) {
                j += 1;
            }
            let s0 = j;
            if j < code.len() && (code[j] == '-' || code[j] == '+') {
                j += 1;
            }
            let d0 = j;
            while j < code.len() && code[j].is_ascii_digit() {
                j += 1;
            }
            let end = if j + 1 < code.len() && code[j] == '.' && code[j + 1].is_ascii_digit() {
                let mut k = j + 1;
                while k < code.len() && code[k].is_ascii_digit() {
                    k += 1;
                }
                Some(k)
            } else if j > d0 {
                Some(j)
            } else {
                None
            };
            if let Some(e) = end {
                let v = code[s0..e].iter().collect::<String>().parse::<f64>().unwrap_or(f64::NAN);
                out.push((code[i], v));
                i = e;
                continue;
            }
        }
        i += 1;
    }
    out
}

pub fn parse_gcode(text: &str) -> Parsed {
    let mut res = Parsed { paths: vec![], circles: vec![], n: 0 };
    let (mut x, mut y) = (0.0f64, 0.0f64);
    let (mut absolute, mut inch, mut motion) = (true, false, 0.0f64);
    let mut cur: Vec<Pt> = Vec::new();
    // split(/\r?\n/)
    let mut lines: Vec<&str> = text.split('\n').collect();
    for l in lines.iter_mut() {
        if let Some(s) = l.strip_suffix('\r') {
            *l = s;
        }
    }
    for raw in lines {
        res.n += 1;
        // Klammer-Kommentare weg, dann `;.*$` (nur, wenn danach kein Zeilenende-Zeichen mehr kommt), trim, groß
        let mut s: Vec<char> = Vec::with_capacity(raw.len());
        let rc: Vec<char> = raw.chars().collect();
        let mut i = 0;
        while i < rc.len() {
            if rc[i] == '(' {
                if let Some(p) = rc[i + 1..].iter().position(|&ch| ch == ')') {
                    i += p + 2;
                    continue;
                }
            }
            s.push(rc[i]);
            i += 1;
        }
        if let Some(p) = (0..s.len()).find(|&p| s[p] == ';' && !s[p + 1..].iter().any(|&ch| line_end(ch))) {
            s.truncate(p);
        }
        let a = s.iter().position(|&ch| !js_space(ch)).unwrap_or(s.len());
        let b = s.iter().rposition(|&ch| !js_space(ch)).map_or(a, |p| p + 1);
        let code: Vec<char> = s[a..b].iter().collect::<String>().to_uppercase().chars().collect();
        if code.is_empty() {
            continue;
        }
        let (mut wx, mut wy, mut wr, mut wi, mut wj) = (None, None, None, None, None);
        for (l, v) in words(&code) {
            match l {
                'G' => {
                    if v == 0.0 || v == 1.0 || v == 2.0 || v == 3.0 {
                        motion = v;
                    } else if v == 90.0 {
                        absolute = true;
                    } else if v == 91.0 {
                        absolute = false;
                    } else if v == 20.0 {
                        inch = true;
                    } else if v == 21.0 {
                        inch = false;
                    }
                }
                'X' => wx = Some(v),
                'Y' => wy = Some(v),
                'R' => wr = Some(v),
                'I' => wi = Some(v),
                'J' => wj = Some(v),
                _ => {}
            }
        }
        if wx.is_none() && wy.is_none() {
            continue;
        }
        let f = if inch { 25.4 } else { 1.0 };
        let nx = wx.map_or(x, |v| if absolute { v * f } else { x + v * f });
        let ny = wy.map_or(y, |v| if absolute { v * f } else { y + v * f });
        if motion == 0.0 {
            if cur.len() >= 2 {
                res.paths.push(Path { pts: std::mem::take(&mut cur), closed: false });
            }
            cur.clear();
        } else {
            if cur.is_empty() {
                cur.push(Pt { x, y });
            }
            if motion == 1.0 {
                cur.push(Pt { x: nx, y: ny });
            } else {
                let (cx, cy);
                if let Some(rv) = wr {
                    // Radius-Schreibweise
                    let r = rv * f;
                    let (dx, dy) = (nx - x, ny - y);
                    let d = hypot2(dx, dy);
                    let h = mx(0.0, r * r - (d / 2.0) * (d / 2.0)).sqrt();
                    let sgn = if (motion == 2.0) == (r > 0.0) { -1.0 } else { 1.0 };
                    cx = x + dx / 2.0 + (sgn * h * -dy) / d;
                    cy = y + dy / 2.0 + (sgn * h * dx) / d;
                } else {
                    let or0 = |v: Option<f64>| v.filter(|v| *v != 0.0 && !v.is_nan()).unwrap_or(0.0);
                    cx = x + or0(wi) * f;
                    cy = y + or0(wj) * f;
                }
                let r = hypot2(x - cx, y - cy);
                let a0 = jsmath::atan2(y - cy, x - cx);
                let a1 = jsmath::atan2(ny - cy, nx - cx);
                let mut sweep = a1 - a0;
                if motion == 2.0 {
                    while sweep >= -1e-9 {
                        sweep -= std::f64::consts::PI * 2.0;
                    }
                } else {
                    while sweep <= 1e-9 {
                        sweep += std::f64::consts::PI * 2.0;
                    }
                }
                let mut pts = arc_points(cx, cy, r, a0, sweep, CURVE_TOL);
                if let Some(last) = pts.last_mut() {
                    *last = Pt { x: nx, y: ny };
                }
                cur.extend_from_slice(pts.get(1..).unwrap_or(&[]));
            }
        }
        x = nx;
        y = ny;
    }
    if cur.len() >= 2 {
        res.paths.push(Path { pts: cur, closed: false });
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// von Hand: 40 Plotter-Einheiten = 1 mm
    #[test]
    fn hpgl_square_in_plotter_units() {
        let r = parse_hpgl("IN;PU0,0;PD400,0,400,400,0,400,0,0;PU;CI200;");
        assert_eq!(r.paths.len(), 1);
        assert_eq!(r.paths[0].pts.iter().map(|p| (p.x, p.y)).collect::<Vec<_>>(), vec![(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0), (0.0, 0.0)]);
        assert_eq!((r.circles.len(), r.circles[0].r, r.n), (1, 5.0, 5));
    }

    /// Dieselben Fälle wie tests/importPltRust.test.ts: Zahlen genau, Punkte auf 1e-9 mm
    #[test]
    fn same_result_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let cases: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("importplt-cases.json")).unwrap()).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 25, "only {} cases", cases.len());
        let mut points = 0;
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let text = c["text"].as_str().unwrap();
            let got = if c["kind"] == "hpgl" { parse_hpgl(text) } else { parse_gcode(text) };
            let want = &c["want"];
            assert_eq!(got.n as u64, want["n"].as_u64().unwrap(), "{name}: count");
            let wp = want["paths"].as_array().unwrap();
            assert_eq!(got.paths.len(), wp.len(), "{name}: paths");
            for (k, (g, w)) in got.paths.iter().zip(wp).enumerate() {
                let w = w.as_array().unwrap();
                assert_eq!(g.pts.len(), w.len(), "{name}: points of path {k}");
                for (p, q) in g.pts.iter().zip(w) {
                    let (qx, qy) = (q[0].as_f64().unwrap(), q[1].as_f64().unwrap());
                    assert!((p.x - qx).abs() <= 1e-9 && (p.y - qy).abs() <= 1e-9, "{name}: path {k}: ({}, {}) vs ({qx}, {qy})", p.x, p.y);
                    points += 1;
                }
            }
            let wc = want["circles"].as_array().unwrap();
            assert_eq!(got.circles.len(), wc.len(), "{name}: circles");
            for (g, w) in got.circles.iter().zip(wc) {
                assert_eq!((g.cx, g.cy, g.r), (w[0].as_f64().unwrap(), w[1].as_f64().unwrap(), w[2].as_f64().unwrap()), "{name}: circle");
            }
        }
        println!("{} cases, {points} points the same as plotImport.ts", cases.len());
    }
}
