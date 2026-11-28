//! GLEICHER WEG? – Zwilling von `samePath` in `src/post/pathCompare.ts`.
//!
//! Liest die übersetzte Datei (postproc.rs) mit dem Leser der Simulation (gcodesim.rs) zurück und vergleicht sie mit
//! dem neutralen Programm: jede Ecke und jede Mitte einer Bewegung (mit Art: Eilgang, Schnitt, Fahrt), in Reihenfolge,
//! auf `tol` mm, in beide Richtungen; jeden Vorschub (F) und jede Drehzahl (S); die Einheit der Datei. Folgt dem
//! TypeScript Zeile für Zeile; die Positionen sind wie dort Float32. Gemeinsame Fälle: `tests/fixtures/postcheck-cases.json.gz`.

use crate::gcodesim::{self, hypot3, js_space, mn, mx};
use crate::importdxf::parse_float;
use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PathCheck {
    pub ok: bool,
    /// was abweicht: "" = nichts, sonst "path" | "feed" | "speed" | "unit"
    pub why: String,
    /// größter Abstand zwischen den beiden Wegen (mm)
    pub max_dev: f64,
    /// Zeile (ab 1) des ersten Unterschieds – im neutralen Programm, oder in der Datei bei `in_posted`
    pub line: u32,
    pub in_posted: bool,
}

/// Bögen werden für den Vergleich feiner geteilt als für die Simulation
const ARC_TOL: f64 = 0.002;

struct Follow {
    ok: bool,
    dev: f64,
    line: u32,
}

/// jeder Punkt von A (Ecken, Mitten mit der Art der Bewegung) muss auf B liegen, in derselben Reihenfolge
fn follow(a: &gcodesim::Program, b: &gcodesim::Program, tol: f64) -> Follow {
    let bn = b.x0.len();
    let (mut j, mut tj, mut dev) = (0usize, 0.0f64, 0.0f64);
    let tol2 = tol * tol;
    // Abstand² vom Punkt zur Bewegung k von B, nicht vor `lo` auf ihr; dazu die Stelle t
    let near = |k: usize, lo: f64, px: f64, py: f64, pz: f64| -> (f64, f64) {
        let (ax, ay, az) = (b.x0[k] as f64, b.y0[k] as f64, b.z0[k] as f64);
        let (dx, dy, dz) = (b.x1[k] as f64 - ax, b.y1[k] as f64 - ay, b.z1[k] as f64 - az);
        let l2 = dx * dx + dy * dy + dz * dz;
        let t = mx(lo, mn(1.0, if l2 > 0.0 { ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2 } else { 0.0 }));
        let (qx, qy, qz) = (ax + dx * t - px, ay + dy * t - py, az + dz * t - pz);
        (qx * qx + qy * qy + qz * qz, t)
    };
    let hit = |px: f64, py: f64, pz: f64, kind: i32, j: &mut usize, tj: &mut f64, dev: &mut f64| -> bool {
        for k in *j..bn {
            if kind >= 0 && b.kind[k] as i32 != kind {
                continue;
            }
            let (mut d2, t) = near(k, if k == *j { *tj } else { 0.0 }, px, py, pz);
            if d2 > tol2 {
                continue;
            }
            // die erste Bewegung, die nah genug ist; für den gemeldeten Abstand ein paar weiter schauen
            let mut m = k + 1;
            while m < bn && m <= k + 16 && d2 > 0.0 {
                if kind >= 0 && b.kind[m] as i32 != kind {
                    break;
                }
                let (n2, _) = near(m, 0.0, px, py, pz);
                if n2 < d2 {
                    d2 = n2;
                }
                m += 1;
            }
            *j = k;
            *tj = t;
            if d2 > *dev {
                *dev = d2;
            }
            return true;
        }
        false
    };
    let an = a.x0.len();
    if an > 0 && bn == 0 {
        return Follow { ok: false, dev: 0.0, line: a.line[0] + 1 };
    }
    for i in 0..an {
        let (x0, y0, z0) = (a.x0[i] as f64, a.y0[i] as f64, a.z0[i] as f64);
        let (x1, y1, z1) = (a.x1[i] as f64, a.y1[i] as f64, a.z1[i] as f64);
        let fail = |dev: f64| Follow { ok: false, dev: dev.sqrt(), line: a.line[i] + 1 };
        if i == 0 && !hit(x0, y0, z0, -1, &mut j, &mut tj, &mut dev) {
            return fail(dev);
        }
        let long = hypot3(x1 - x0, y1 - y0, z1 - z0) > 4.0 * tol;
        if long && !hit((x0 + x1) / 2.0, (y0 + y1) / 2.0, (z0 + z1) / 2.0, a.kind[i] as i32, &mut j, &mut tj, &mut dev) {
            return fail(dev);
        }
        if !hit(x1, y1, z1, -1, &mut j, &mut tj, &mut dev) {
            return fail(dev);
        }
    }
    Follow { ok: true, dev: dev.sqrt(), line: 0 }
}

#[derive(Default)]
struct Words {
    f: Vec<f64>,
    f_line: Vec<u32>,
    s: Vec<f64>,
    s_line: Vec<u32>,
    inch: Option<bool>,
}

/// `.` in JavaScript passt auf alles außer Zeilenenden
fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// F- und S-Wörter der Reihe nach (außerhalb von Kommentaren), F in mm/min; die Einheit ist das erste G20/G21
fn feeds_and_speeds(code: &str) -> Words {
    let mut w = Words::default();
    let mut inch = false;
    for (i, raw) in code.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).enumerate() {
        if raw.is_empty() || raw.starts_with('%') {
            continue;
        }
        // replace(/\([^)]*\)/g, " ")
        let rc: Vec<char> = raw.chars().collect();
        let mut text: Vec<char> = vec![];
        let mut k = 0;
        while k < rc.len() {
            if rc[k] == '(' {
                if let Some(p) = rc[k + 1..].iter().position(|&ch| ch == ')') {
                    text.push(' ');
                    k += p + 2;
                    continue;
                }
            }
            text.push(rc[k]);
            k += 1;
        }
        // replace(/;.*$/, ""): das erste „;“, nach dem kein Zeilenende mehr kommt
        let after = text.iter().rposition(|&c| line_end(c)).map_or(0, |p| p + 1);
        if let Some(p) = text[after..].iter().position(|&c| c == ';') {
            text.truncate(after + p);
        }
        let text: Vec<char> = text.iter().collect::<String>().to_uppercase().chars().collect();
        let (mut f, mut s): (Option<f64>, Option<f64>) = (None, None);
        let mut k = 0;
        while k < text.len() {
            match word(&text, k) {
                Some((e, l, txt)) => {
                    let v = parse_float(&txt);
                    if l == 'G' && (v == 20.0 || v == 21.0) {
                        inch = v == 20.0;
                        if w.inch.is_none() {
                            w.inch = Some(inch);
                        }
                    } else if l == 'F' {
                        f = Some(v);
                    } else if l == 'S' {
                        s = Some(v);
                    }
                    k = e;
                }
                None => k += 1,
            }
        }
        if let Some(f) = f {
            w.f.push(if inch { f * 25.4 } else { f });
            w.f_line.push(i as u32 + 1);
        }
        if let Some(s) = s {
            w.s.push(s);
            w.s_line.push(i as u32 + 1);
        }
    }
    w
}

/// Muster `([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))` ab i: (Ende, Buchstabe, Zahl-Text)
fn word(c: &[char], i: usize) -> Option<(usize, char, String)> {
    if !c[i].is_ascii_uppercase() {
        return None;
    }
    let mut j = i + 1;
    while j < c.len() && js_space(c[j]) {
        j += 1;
    }
    let digits = |mut e: usize| {
        while e < c.len() && c[e].is_ascii_digit() {
            e += 1;
        }
        e
    };
    let num = |k: usize| -> Option<usize> {
        if c.get(k).is_some_and(|ch| ch.is_ascii_digit()) {
            let e = digits(k);
            Some(if c.get(e) == Some(&'.') { digits(e + 1) } else { e })
        } else if c.get(k) == Some(&'.') && c.get(k + 1).is_some_and(|ch| ch.is_ascii_digit()) {
            Some(digits(k + 1))
        } else {
            None
        }
    };
    let e = (if matches!(c.get(j), Some('-' | '+')) { num(j + 1) } else { None }).or_else(|| num(j))?;
    Some((e, c[i], c[j..e].iter().collect()))
}

fn read(code: &str) -> gcodesim::Program {
    // split(/\r?\n/) und join("\n") wie im TypeScript
    let text = code.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect::<Vec<_>>().join("\n");
    gcodesim::parse(&text, &gcodesim::Options { arc_tol: Some(ARC_TOL), ..Default::default() })
}

/// `inch` = Einheit, die die Datei haben soll; `tol` in mm (0,02 im Programm)
pub fn same_path(neutral: &str, posted: &str, inch: bool, tol: f64) -> PathCheck {
    let bad = |why: &str, line: u32, in_posted: bool, max_dev: f64| PathCheck { ok: false, why: why.into(), max_dev, line, in_posted };
    let (a, b) = (feeds_and_speeds(neutral), feeds_and_speeds(posted));
    if b.inch != Some(inch) {
        return bad("unit", 1, true, 0.0);
    }
    if a.f.len() != b.f.len() {
        return bad("feed", b.f_line.get(a.f.len().min(b.f.len())).copied().unwrap_or(1), true, 0.0);
    }
    for i in 0..a.f.len() {
        // 2 Stellen Zoll pro Minute = 0,13 mm/min
        if (a.f[i] - b.f[i]).abs() > 0.2 + a.f[i] * 0.001 {
            return bad("feed", b.f_line[i], true, 0.0);
        }
    }
    if a.s.len() != b.s.len() {
        return bad("speed", b.s_line.get(a.s.len().min(b.s.len())).copied().unwrap_or(1), true, 0.0);
    }
    for i in 0..a.s.len() {
        if a.s[i] != b.s[i] {
            return bad("speed", b.s_line[i], true, 0.0);
        }
    }
    let (pa, pb) = (read(neutral), read(posted));
    let ab = follow(&pa, &pb, tol);
    if !ab.ok {
        return bad("path", ab.line, false, ab.dev);
    }
    let ba = follow(&pb, &pa, tol);
    if !ba.ok {
        return bad("path", ba.line, true, ba.dev);
    }
    PathCheck { ok: true, why: String::new(), max_dev: mx(ab.dev, ba.dev), line: 0, in_posted: false }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::postproc::{post_process, PostDef, PostOptions};
    use serde_json::Value;
    use std::io::Read;

    fn load(name: &str) -> Value {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join(name)).unwrap()).read_to_string(&mut text).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    /// Zahlen auf 1e-9, der Rest genau
    fn same(got: &PathCheck, want: &Value, at: &str) {
        let g = serde_json::to_value(got).unwrap();
        for k in ["ok", "why", "line", "inPosted"] {
            assert_eq!(g[k], want[k], "{at}: {k}");
        }
        let (a, b) = (got.max_dev, want["maxDev"].as_f64().unwrap());
        assert!((a - b).abs() <= 1e-9, "{at}: maxDev {a} vs {b}");
    }

    #[test]
    fn pieces() {
        let w = feeds_and_speeds("G21\n(F1)G1 X1 f100 s5 ; F2\nG20 F2 (S1)\n%F9\nG1 F3 S7 S8");
        assert_eq!((w.f, w.s, w.inch), (vec![100.0, 2.0 * 25.4, 3.0 * 25.4], vec![5.0, 8.0], Some(false)));
        assert_eq!((w.f_line, w.s_line), (vec![2, 3, 5], vec![2, 5]));
    }

    #[test]
    fn same_result_as_typescript() {
        let pp = load("postproc-cases.json.gz");
        let all = load("postcheck-cases.json.gz");
        let checks = all["checks"].as_array().unwrap();
        assert!(checks.len() >= 1000, "only {} checks", checks.len());
        for c in checks {
            let case = &pp["cases"][c["c"].as_u64().unwrap() as usize];
            let (p, d, oi) = (case["p"].as_str().unwrap(), case["d"].as_str().unwrap(), case["o"].as_u64().unwrap() as usize);
            let def: PostDef = serde_json::from_value(pp["defs"][d].clone()).unwrap();
            let o: PostOptions = serde_json::from_value(pp["opts"][oi].clone()).unwrap();
            let neutral = pp["programs"][p].as_str().unwrap();
            let posted = post_process(neutral, &def, &o);
            same(&same_path(neutral, &posted.gcode, o.inch, 0.02), &c["want"], &format!("{p} / {d} / options {oi}"));
        }
        let wrong = all["wrong"].as_array().unwrap();
        for (k, w) in wrong.iter().enumerate() {
            let p = w["p"].as_str().unwrap();
            let got = same_path(pp["programs"][p].as_str().unwrap(), w["posted"].as_str().unwrap(), w["inch"].as_bool().unwrap(), w["tol"].as_f64().unwrap());
            same(&got, &w["want"], &format!("spoilt file {k} of {p}"));
        }
        println!("{} translated files and {} spoilt ones checked the same as samePath", checks.len(), wrong.len());
    }
}
