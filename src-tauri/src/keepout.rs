//! SPERRZONEN FÜR SPANNPRATZEN (nur Fräse) – Zwilling von `src/keepOut.ts` (`applyKeepOuts`).
//!
//! Nachbearbeitung des fertigen G-Codes: Eilfahrten durch eine Zone unter der Sicherheitshöhe bekommen vorher einen
//! Hub und danach wieder die alte Höhe; Schnitte in eine Zone unter ihrer Höhe lassen sich nicht umgehen und werden
//! gemeldet. Folgt dem TypeScript Zeile für Zeile, auch in den Eigenheiten (welche Zeichen als Leerzeichen zählen, wie
//! Zahlen gelesen und geschrieben werden). Gemeinsame Fälle: `tests/fixtures/keepout-cases.json`, festgehalten von
//! `tests/keepOutRust.test.ts`, verglichen von `cargo test keepout`.

use crate::gcodesim::{hypot2, js_space, mn, mx};
use crate::jsmath::{self, js_num, js_round, to_fixed};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

type P = [f64; 2];

/// Eine Sperrzone: Umriss in mm, Höhe der Pratze über Z0, Luft darüber
#[derive(Deserialize, Clone, Debug)]
pub struct Zone {
    pub pts: Vec<Pt>,
    pub height: f64,
    pub margin: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

/// Schnitt oder Eilfahrt, die in einer Zone unter ihrer Höhe endet: Nummer der Zone (unter denen mit mindestens drei
/// Punkten), Name der Form aus dem G-Code, Zeile (ab 0), Art
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Hit {
    pub zone: usize,
    pub label: String,
    pub line: usize,
    pub kind: &'static str,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct KeepResult {
    pub gcode: String,
    pub raised: usize,
    pub hits: Vec<Hit>,
    pub unsure: bool,
}

struct Z {
    pts: Vec<P>,
    height: f64,
    margin: f64,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

fn prep(z: &Zone) -> Z {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in &z.pts {
        x0 = mn(x0, p.x);
        y0 = mn(y0, p.y);
        x1 = mx(x1, p.x);
        y1 = mx(y1, p.y);
    }
    Z { pts: z.pts.iter().map(|p| [p.x, p.y]).collect(), height: z.height, margin: z.margin, x0, y0, x1, y1 }
}

fn point_in_poly(p: P, poly: &[P]) -> bool {
    let mut inside = false;
    let n = poly.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0] {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Abstand zweier Strecken (0 = sie kreuzen sich)
fn seg_dist(a: P, b: P, c: P, d: P) -> f64 {
    let cross = |o: P, p: P, q: P| (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    let (d1, d2, d3, d4) = (cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b));
    if d1 * d2 < 0.0 && d3 * d4 < 0.0 {
        return 0.0;
    }
    let pt = |p: P, q: P, r: P| {
        let (dx, dy) = (r[0] - q[0], r[1] - q[1]);
        let l = dx * dx + dy * dy;
        let f = if l > 1e-12 { mx(0.0, mn(1.0, ((p[0] - q[0]) * dx + (p[1] - q[1]) * dy) / l)) } else { 0.0 };
        hypot2(p[0] - (q[0] + dx * f), p[1] - (q[1] + dy * f))
    };
    mn(mn(pt(a, c, d), pt(b, c, d)), mn(pt(c, a, b), pt(d, a, b)))
}

/// Berührt die Strecke a–b die um r vergrößerte Zone?
fn seg_hits_zone(a: P, b: P, q: &Z, r: f64) -> bool {
    if mx(a[0], b[0]) < q.x0 - r || mn(a[0], b[0]) > q.x1 + r || mx(a[1], b[1]) < q.y0 - r || mn(a[1], b[1]) > q.y1 + r {
        return false;
    }
    if point_in_poly(a, &q.pts) || point_in_poly(b, &q.pts) {
        return true;
    }
    let n = q.pts.len();
    (0..n).any(|i| seg_dist(a, b, q.pts[i], q.pts[(i + 1) % n]) <= r)
}

/// Zeichen, an denen `.` in einem JavaScript-Muster anhält
fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn js_trim(s: &[char]) -> &[char] {
    let a = s.iter().position(|&c| !js_space(c)).unwrap_or(s.len());
    let b = s.iter().rposition(|&c| !js_space(c)).map_or(a, |i| i + 1);
    &s[a..b]
}

/// Überschrift einer Form im G-Code, `(--- Form 3: … ---)`: der Text dazwischen.
/// Muster im TypeScript: `^\(-{2,}\s*(.*?)\s*-*\)$` auf der Zeile ohne Ränder
fn mark(raw: &[char]) -> Option<String> {
    let s = js_trim(raw);
    if s.len() < 4 || s[0] != '(' || s[s.len() - 1] != ')' {
        return None;
    }
    let body = &s[1..s.len() - 1];
    let dashes = body.iter().take_while(|&&c| c == '-').count();
    if dashes < 2 {
        return None;
    }
    let mut a = dashes;
    while a < body.len() && js_space(body[a]) {
        a += 1;
    }
    // hinten: alle Striche, davor alle Leerzeichen
    let mut b = body.len();
    while b > a && body[b - 1] == '-' {
        b -= 1;
    }
    while b > a && js_space(body[b - 1]) {
        b -= 1;
    }
    let label = &body[a..b];
    if label.iter().any(|&c| line_end(c)) {
        return None;
    }
    Some(label.iter().collect())
}

/// Kommentare weg (`(…)` paarweise, dann alles ab `;`), Ränder ab, Großbuchstaben
fn code_of(raw: &[char]) -> Vec<char> {
    let mut out: Vec<char> = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == '(' {
            if let Some(close) = raw[i + 1..].iter().position(|&c| c == ')') {
                i += close + 2;
                continue;
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    if let Some(semi) = out.iter().position(|&c| c == ';') {
        out.truncate(semi);
    }
    js_trim(&out).iter().collect::<String>().to_uppercase().chars().collect()
}

/// Ende einer Zahl nach dem Muster `[-+]?\d*\.?\d+` ab Stelle i (None = keine Zahl)
fn number_end(s: &[char], i: usize) -> Option<usize> {
    let mut j = i;
    if j < s.len() && (s[j] == '-' || s[j] == '+') {
        j += 1;
    }
    let d0 = j;
    while j < s.len() && s[j].is_ascii_digit() {
        j += 1;
    }
    if j + 1 < s.len() && s[j] == '.' && s[j + 1].is_ascii_digit() {
        j += 1;
        while j < s.len() && s[j].is_ascii_digit() {
            j += 1;
        }
        return Some(j);
    }
    if j > d0 {
        Some(j)
    } else {
        None
    }
}

/// Wörter der Zeile: Buchstabe A–Z, Leerzeichen, Zahl (Muster `([A-Z])\s*([-+]?\d*\.?\d+)`)
fn words(code: &[char]) -> Vec<(char, f64)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < code.len() {
        if code[i].is_ascii_uppercase() {
            let mut j = i + 1;
            while j < code.len() && js_space(code[j]) {
                j += 1;
            }
            if let Some(e) = number_end(code, j) {
                let v = code[j..e].iter().collect::<String>().parse::<f64>().unwrap_or(f64::NAN);
                out.push((code[i], v));
                i = e;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Zahl mit drei Stellen: `(Math.round(v * 1000) / 1000).toFixed(3)`
fn num(v: f64) -> String {
    to_fixed(js_round(v * 1000.0) / 1000.0, 3)
}

/// Sperrzonen auf den fertigen G-Code anwenden. `radius` = Fräser-Radius (die Zone wird um ihn größer),
/// `note` = Kommentar hinter jedem eingefügten Hub
pub fn apply_keep_outs(gcode: &str, zones_in: &[Zone], radius: f64, note: &str) -> KeepResult {
    let zones: Vec<Z> = zones_in.iter().filter(|z| z.pts.len() >= 3).map(prep).collect();
    if zones.is_empty() {
        return KeepResult { gcode: gcode.to_string(), raised: 0, hits: vec![], unsure: false };
    }
    let r = mx(0.0, radius);
    let mut out: Vec<String> = Vec::new();
    let mut hits: Vec<Hit> = Vec::new();
    let mut seen: HashSet<(usize, String)> = HashSet::new();
    let (mut x, mut y, mut z): (Option<f64>, Option<f64>, Option<f64>) = (None, None, None);
    let (mut abs, mut k, mut motion, mut plane, mut raised, mut unsure) = (true, 1.0f64, 0i64, 17i64, 0usize, false);
    let mut label = String::new();

    for (li, raw_line) in gcode.split('\n').enumerate() {
        let raw: Vec<char> = raw_line.chars().collect();
        if let Some(m) = mark(&raw) {
            label = m;
        }
        let code = code_of(&raw);
        if code.is_empty() || code[0] == '$' {
            out.push(raw_line.to_string());
            continue;
        }
        let (mut wx, mut wy, mut wz, mut wr, mut wi, mut wj): (Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>) = (None, None, None, None, None, None);
        let (mut special, mut stop) = (false, false);
        for (c, v) in words(&code) {
            match c {
                'G' => {
                    let g = js_round(v * 10.0);
                    if g == 0.0 || g == 10.0 || g == 20.0 || g == 30.0 {
                        motion = (g / 10.0) as i64;
                    } else if g == 900.0 {
                        abs = true;
                    } else if g == 910.0 {
                        abs = false;
                        unsure = true;
                    } else if g == 200.0 {
                        k = 25.4;
                    } else if g == 210.0 {
                        k = 1.0;
                    } else if g == 170.0 || g == 180.0 || g == 190.0 {
                        plane = (g / 10.0) as i64;
                    } else if g == 530.0 || g == 280.0 || g == 300.0 || (g >= 380.0 && g < 390.0) {
                        special = true;
                    } else if g == 100.0 || g == 920.0 || g == 921.0 {
                        special = true;
                        unsure = true;
                    }
                }
                'M' => {
                    if v == 0.0 || v == 1.0 || v == 6.0 {
                        stop = true;
                    }
                }
                'N' => {}
                'X' => wx = Some(v),
                'Y' => wy = Some(v),
                'Z' => wz = Some(v),
                'R' => wr = Some(v),
                'I' => wi = Some(v),
                'J' => wj = Some(v),
                _ => {}
            }
        }
        // Maschine steht danach woanders (Handbetrieb, Wechselposition); relative Maße: Lage unbekannt
        if stop || special || !abs {
            out.push(raw_line.to_string());
            x = None;
            y = None;
            z = None;
            continue;
        }
        let (has_xy, has_z) = (wx.is_some() || wy.is_some(), wz.is_some());
        if !has_xy && !has_z {
            out.push(raw_line.to_string());
            continue;
        }
        let nx = wx.map(|v| v * k).or(x);
        let ny = wy.map(|v| v * k).or(y);
        let nz = wz.map(|v| v * k).or(z);
        let from: Option<P> = match (x, y) {
            (Some(a), Some(b)) => Some([a, b]),
            _ => None,
        };
        let to: Option<P> = match (nx, ny) {
            (Some(a), Some(b)) => Some([a, b]),
            _ => None,
        };
        // Endet die Fahrt tief in einer Zone, kommt der Fräser dort herunter
        let mut rapid_hits = |to: P, nz: f64, label: &str, hits: &mut Vec<Hit>| {
            for (i, q) in zones.iter().enumerate() {
                if nz < q.height && seg_hits_zone(to, to, q, r) && seen.insert((i, label.to_string())) {
                    hits.push(Hit { zone: i, label: label.to_string(), line: li, kind: "rapid" });
                }
            }
        };

        if motion == 0 {
            if has_xy {
                // Welche Zonen liegen im Weg? Lage unbekannt: alle
                let mut need = f64::NEG_INFINITY;
                for q in &zones {
                    let crossing = match (from, to) {
                        (Some(a), Some(b)) => seg_hits_zone(a, b, q, r),
                        _ => true,
                    };
                    if crossing {
                        need = mx(need, q.height + q.margin);
                    }
                }
                if need > f64::NEG_INFINITY && (z.is_none_or(|z| z < need) || nz.is_some_and(|nz| nz < need)) {
                    let up = z.map_or(need, |z| mx(z, need));
                    if z.is_none_or(|z| z < up) {
                        out.push(format!("G0 Z{} {note}", num(up / k)));
                        raised += 1;
                    }
                    // X/Y für sich, Z danach
                    if has_z {
                        let mut line = String::from("G0");
                        if let Some(v) = wx {
                            line.push_str(&format!(" X{}", js_num(v)));
                        }
                        if let Some(v) = wy {
                            line.push_str(&format!(" Y{}", js_num(v)));
                        }
                        out.push(line);
                    } else {
                        out.push(raw_line.to_string());
                    }
                    if let Some(nz) = nz.filter(|&nz| nz < up) {
                        out.push(format!("G0 Z{} {note}", num(nz / k)));
                    }
                } else {
                    out.push(raw_line.to_string());
                }
                if let (Some(to), Some(nz)) = (to, nz) {
                    rapid_hits(to, nz, &label, &mut hits);
                }
            } else {
                out.push(raw_line.to_string());
                if let (Some(to), Some(nz)) = (to, nz) {
                    if z.is_none_or(|z| nz < z) {
                        rapid_hits(to, nz, &label, &mut hits);
                    }
                }
            }
        } else {
            out.push(raw_line.to_string());
            // Schnitt: Bogen als Strecken prüfen
            let low = mn(z.unwrap_or(f64::INFINITY), nz.unwrap_or(f64::INFINITY));
            if let Some(to) = to.filter(|_| low < f64::INFINITY) {
                let mut path: Vec<P> = vec![from.unwrap_or(to)];
                if let Some(from) = from.filter(|_| motion >= 2 && plane == 17) {
                    let (cx, cy);
                    if let (Some(rv), None, None) = (wr, wi, wj) {
                        let rr = rv * k;
                        let (dx, dy) = (to[0] - from[0], to[1] - from[1]);
                        let d = hypot2(dx, dy);
                        let h = if d > 1e-9 { mx(0.0, rr * rr - (d / 2.0) * (d / 2.0)).sqrt() } else { 0.0 };
                        let sgn = if (motion == 2) == (rr > 0.0) { -1.0 } else { 1.0 };
                        cx = from[0] + dx / 2.0 + if d > 1e-9 { (sgn * h * -dy) / d } else { 0.0 };
                        cy = from[1] + dy / 2.0 + if d > 1e-9 { (sgn * h * dx) / d } else { 0.0 };
                    } else {
                        cx = from[0] + wi.unwrap_or(0.0) * k;
                        cy = from[1] + wj.unwrap_or(0.0) * k;
                    }
                    let rad = hypot2(from[0] - cx, from[1] - cy);
                    let a0 = jsmath::atan2(from[1] - cy, from[0] - cx);
                    let a1 = jsmath::atan2(to[1] - cy, to[0] - cx);
                    let mut sw = a1 - a0;
                    if motion == 2 {
                        while sw >= -1e-9 {
                            sw += -std::f64::consts::PI * 2.0;
                        }
                    } else {
                        while sw <= 1e-9 {
                            sw += std::f64::consts::PI * 2.0;
                        }
                    }
                    let segs = mx(4.0, (sw.abs() / 0.2).ceil()) as usize;
                    for s in 1..segs {
                        let a = a0 + (sw * s as f64) / segs as f64;
                        path.push([cx + rad * jsmath::cos(a), cy + rad * jsmath::sin(a)]);
                    }
                }
                path.push(to);
                for (i, q) in zones.iter().enumerate() {
                    if low >= q.height {
                        continue;
                    }
                    if (1..path.len()).any(|s| seg_hits_zone(path[s - 1], path[s], q, r)) && seen.insert((i, label.clone())) {
                        hits.push(Hit { zone: i, label: label.clone(), line: li, kind: "cut" });
                    }
                }
            }
        }
        x = nx;
        y = ny;
        z = nz;
    }
    KeepResult { gcode: out.join("\n"), raised, hits, unsure }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Zone {
        Zone { pts: vec![Pt { x: x0, y: y0 }, Pt { x: x1, y: y0 }, Pt { x: x1, y: y1 }, Pt { x: x0, y: y1 }], height: 10.0, margin: 5.0 }
    }

    /// von Hand: Pratze 40…60 × −10…10, 10 hoch, 5 Luft. Die Eilfahrt von X0 nach X100 auf Z5 geht mitten durch:
    /// vorher auf 15, danach zurück auf 5. Die Lage am Anfang ist unbekannt, deshalb auch dort ein Hub.
    #[test]
    fn rapid_through_a_zone_goes_up_and_comes_down_again() {
        let src = "G21\nG90\nG0 Z5\nG0 X0 Y0\nG0 X100 Y0\nG1 Z-1 F100";
        let r = apply_keep_outs(src, &[rect(40.0, -10.0, 60.0, 10.0)], 1.5, "(keep)");
        let l: Vec<&str> = r.gcode.split('\n').collect();
        assert_eq!(&l[3..], &["G0 Z15.000 (keep)", "G0 X0 Y0", "G0 Z5.000 (keep)", "G0 Z15.000 (keep)", "G0 X100 Y0", "G0 Z5.000 (keep)", "G1 Z-1 F100"]);
        assert_eq!((r.raised, r.hits.len(), r.unsure), (2, 0, false));
    }

    /// Ein Schnitt in die Zone unter ihrer Höhe bleibt, wie er ist, und wird mit dem Namen der Form gemeldet – einmal
    #[test]
    fn cut_into_a_zone_is_reported_once_with_the_shape() {
        let src = "G0 Z20\nG0 X0 Y0\n(--- shape 2: POLYLINE outside ---)\nG1 Z-1 F100\nG1 X50 Y0\nG1 X55 Y0";
        let r = apply_keep_outs(src, &[Zone { pts: vec![], height: 1.0, margin: 1.0 }, rect(40.0, -10.0, 60.0, 10.0)], 1.5, "(keep)");
        assert_eq!(r.gcode, src);
        assert_eq!(r.hits, vec![Hit { zone: 0, label: "shape 2: POLYLINE outside".into(), line: 4, kind: "cut" }]);
    }

    #[test]
    fn heading_pattern() {
        let m = |s: &str| mark(&s.chars().collect::<Vec<_>>());
        assert_eq!(m("(--- a - b ---)"), Some("a - b".into()));
        assert_eq!(m("  (--x)  "), Some("x".into()));
        assert_eq!(m("(-----)"), Some(String::new()));
        assert_eq!(m("(- x -)"), None);
        assert_eq!(m("(--- x ---) G1"), None);
        assert_eq!(m("(--- a - -)"), Some("a -".into()));
    }

    #[test]
    fn numbers_like_the_pattern() {
        let w = |s: &str| words(&s.chars().collect::<Vec<_>>());
        assert_eq!(w("G1X5.Y.5Z-.25"), vec![('G', 1.0), ('X', 5.0), ('Y', 0.5), ('Z', -0.25)]);
        assert_eq!(w("X 1.2.3 GY+4"), vec![('X', 1.2), ('Y', 4.0)]);
        assert_eq!(w("X- Y"), vec![]);
    }

    /// Dieselben Fälle wie tests/keepOutRust.test.ts: G-Code, Zahl der Hübe, Meldungen genau wie im TypeScript
    #[test]
    fn same_result_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let cases: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("keepout-cases.json")).unwrap()).unwrap();
        let expected: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("keepout-expected.json")).unwrap()).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 40, "only {} cases", cases.len());
        let (mut lines, mut raised, mut hits) = (0, 0, 0);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let src = c["gcode"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect::<Vec<_>>().join("\n");
            let zones: Vec<Zone> = serde_json::from_value(c["zones"].clone()).unwrap();
            let got = apply_keep_outs(&src, &zones, c["radius"].as_f64().unwrap(), c["note"].as_str().unwrap());
            let want = &expected[name];
            assert!(want.is_object(), "{name}: no expected result");
            let want_lines: Vec<&str> = want["gcode"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
            let got_lines: Vec<&str> = got.gcode.split('\n').collect();
            for (k, (a, b)) in got_lines.iter().zip(&want_lines).enumerate() {
                assert_eq!(a, b, "{name}: line {}", k + 1);
            }
            assert_eq!(got_lines.len(), want_lines.len(), "{name}: number of lines");
            assert_eq!(got.raised as u64, want["raised"].as_u64().unwrap(), "{name}: raised");
            assert_eq!(got.unsure, want["unsure"].as_bool().unwrap(), "{name}: unsure");
            assert_eq!(serde_json::to_value(&got.hits).unwrap(), want["hits"], "{name}: hits");
            lines += want_lines.len();
            raised += got.raised;
            hits += got.hits.len();
        }
        println!("{} cases, {lines} G-code lines, {raised} lifts and {hits} reports the same as keepOut.ts", cases.len());
    }
}
