//! ARC FITTING (Zwilling von src/arcFit.ts): kurze G1-Stücke zu echten Bögen G2/G3 zusammenfassen
//!
//! Es wird nur zusammengefasst, was sicher gleich bleibt:
//!  - nur Zeilen der Form „G1 X… Y…“, dazwischen nichts (kein Z, keine Kommentare, keine andere Zeile)
//!  - ein neues F beendet die Kette: die Zeile mit F darf nur am Anfang eines Bogens stehen
//!  - nur G17, G21 und G90; sonst bleibt der Rest des Programms unverändert
//!  - mindestens MIN_SEGS Stücke, nicht gerade, gleichbleibende Drehrichtung, höchstens MAX_SWEEP je Bogen
//!  - Abstand zwischen alter Bahn und Bogen nirgends größer als die Toleranz
//!
//! Die Rechnung folgt dem TypeScript Schritt für Schritt, auch im Runden auf drei Stellen (wie `toFixed(3)`) und im
//! Erkennen der Zeilen. Geprüft mit denselben Fällen auf beiden Seiten: tests/fixtures/arcfit-cases.json und
//! arcfit-expected.json (tests/arcFitRust.test.ts und die Tests unten) – der G-Code Zeile für Zeile.
//!
//! Noch nicht gerufen: cam.ts ruft fitArcs im Fenster. Zieht der Fräs-G-Code um, ruft er `fit_arcs` direkt.
#![allow(dead_code)]

use crate::gcodesim::{hypot2, js_space, mn, mx, word_char};
use crate::jsmath;

pub const ARC_TOL_DEFAULT: f64 = 0.01;
pub const ARC_TOL_MIN: f64 = 0.001;
pub const ARC_TOL_MAX: f64 = 0.1;
pub fn clamp_arc_tol(v: f64) -> f64 {
    mx(ARC_TOL_MIN, mn(ARC_TOL_MAX, v))
}

const MIN_SEGS: usize = 4;
const MAX_SWEEP: f64 = (270.0 * std::f64::consts::PI) / 180.0;
const MAX_PROBE: usize = 512;
const MAX_RADIUS: f64 = 5000.0;
const MIN_RADIUS: f64 = 0.05;

pub type Pt = [f64; 2];

pub struct ArcFitResult {
    pub gcode: String,
    pub before: usize,
    pub after: usize,
    pub arcs: usize,
}

/// Zahl mit drei Nachkommastellen, wie `toFixed(3)` in JavaScript: genau auf der Hälfte wird vom Nullpunkt weg
/// gerundet (Rust rundet dort zur geraden Ziffer). Solche Hälften gibt es nur bei Vielfachen von 1/16.
pub fn to_fixed3(v: f64) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if v == 0.0 {
        return "0.000".into();
    }
    let a = v.abs();
    let sixteenth = a * 16.0;
    if a < 1e15 && sixteenth.fract() == 0.0 && sixteenth % 2.0 == 1.0 {
        let n = (a * 1000.0).floor() as u64 + 1;
        return format!("{}{}.{:03}", if v < 0.0 { "-" } else { "" }, n / 1000, n % 1000);
    }
    format!("{:.3}", v)
}
/// `+v.toFixed(3)`
fn round3(v: f64) -> f64 {
    to_fixed3(v).parse::<f64>().unwrap_or(f64::NAN)
}

/// Mittelpunkt durch drei Punkte; None = (fast) auf einer Linie
fn circle3(a: Pt, b: Pt, c: Pt) -> Option<Pt> {
    let d = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if d.abs() < 1e-9 || d.is_nan() {
        return None;
    }
    let (a2, b2, c2) = (a[0] * a[0] + a[1] * a[1], b[0] * b[0] + b[1] * b[1], c[0] * c[0] + c[1] * c[1]);
    Some([(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d])
}

#[derive(Clone, Copy, Debug)]
struct Fit {
    i: usize,
    j: usize,
    ccw: bool,
    ci: f64,
    cj: f64,
    sweep: f64,
}

/// Passt ein Bogen auf die Punkte i..j?
fn try_fit(p: &[Pt], i: usize, j: usize, tol: f64) -> Option<Fit> {
    let (a, b, m) = (p[i], p[j], p[(i + j) >> 1]);
    let raw = circle3(a, m, b)?;
    // I/J werden auf 3 Stellen gerundet: mit dem Mittelpunkt rechnen, den die Maschine wirklich sieht
    let (ci, cj) = (round3(raw[0] - a[0]), round3(raw[1] - a[1]));
    let c = [a[0] + ci, a[1] + cj];
    let r = hypot2(ci, cj);
    if r < MIN_RADIUS || r > MAX_RADIUS {
        return None;
    }
    if (hypot2(b[0] - c[0], b[1] - c[1]) - r).abs() > mn(tol, 0.002) {
        return None; // sonst Fehler 33 bei GRBL
    }

    // gerade? (dann ist es kein Bogen, auch wenn ein riesiger Kreis passen würde)
    let (cx, cy) = (b[0] - a[0], b[1] - a[1]);
    let chord = hypot2(cx, cy);
    let mut bulge = 0.0f64;
    if chord > 1e-9 {
        for q in &p[i + 1..j] {
            bulge = mx(bulge, (cx * (q[1] - a[1]) - cy * (q[0] - a[0])).abs() / chord);
        }
    }
    if chord > 1e-9 && bulge <= tol {
        return None;
    }

    let off = |q: Pt| (hypot2(q[0] - c[0], q[1] - c[1]) - r).abs();
    let (mut sweep, mut sign) = (0.0f64, 0.0f64);
    for k in i..j {
        let (s, e) = (p[k], p[k + 1]);
        if off(e) > tol {
            return None;
        }
        let (dx, dy) = (e[0] - s[0], e[1] - s[1]);
        let l2 = dx * dx + dy * dy;
        if l2 < 1e-12 {
            continue;
        }
        // der größte Abstand einer Sehne zum Kreis liegt am Lot vom Mittelpunkt auf die Sehne
        let f = ((c[0] - s[0]) * dx + (c[1] - s[1]) * dy) / l2;
        if f > 0.0 && f < 1.0 && off([s[0] + dx * f, s[1] + dy * f]) > tol {
            return None;
        }
        // Winkel um den Mittelpunkt: immer in dieselbe Richtung
        let an = jsmath::atan2((s[0] - c[0]) * (e[1] - c[1]) - (s[1] - c[1]) * (e[0] - c[0]), (s[0] - c[0]) * (e[0] - c[0]) + (s[1] - c[1]) * (e[1] - c[1]));
        if an.abs() > 1e-9 {
            let sg = if an > 0.0 { 1.0 } else { -1.0 };
            if sign != 0.0 && sg != sign {
                return None;
            }
            sign = sg;
            sweep += an.abs();
        }
    }
    if sign == 0.0 || sweep > MAX_SWEEP {
        return None;
    }
    Some(Fit { i, j, ccw: sign > 0.0, ci, cj, sweep })
}

/// Längsten passenden Bogen ab i finden: in Sprüngen verlängern, dann eingrenzen
fn longest_fit(p: &[Pt], i: usize, tol: f64) -> Option<Fit> {
    let last = p.len() - 1;
    // Feine Kurven sehen auf wenigen Punkten noch gerade aus: deshalb auch längere Stücke probieren
    let mut best: Option<Fit> = None;
    let mut size = MIN_SEGS;
    while i + size <= last && size <= MAX_PROBE {
        best = try_fit(p, i, i + size, tol);
        if best.is_some() {
            break;
        }
        size *= 2;
    }
    let mut best = best?;
    let (mut lo, mut step, mut hi) = (best.j, 4usize, None);
    while lo < last {
        let j = last.min(lo + step);
        match try_fit(p, i, j, tol) {
            Some(f) => {
                best = f;
                lo = j;
                step *= 2;
            }
            None => {
                hi = Some(j);
                break;
            }
        }
    }
    if let Some(mut hi) = hi {
        while hi - lo > 1 {
            let mid = (lo + hi) >> 1;
            match try_fit(p, i, mid, tol) {
                Some(f) => {
                    best = f;
                    lo = mid;
                }
                None => hi = mid,
            }
        }
    }
    Some(best)
}

/// Linienzug als Geraden und Bögen: pts[i] → pts[i+1] mit Wölbung bulges[i]
/// (0 = Gerade; tan(Winkel/4), + = gegen den Uhrzeigersinn)
pub fn fit_path_arcs(pts: &[Pt], closed: bool, tol: f64) -> (Vec<Pt>, Vec<f64>) {
    let pi = std::f64::consts::PI;
    let mut seq: Vec<Pt> = pts.to_vec();
    if closed && pts.len() > 2 {
        // an der schärfsten Ecke anfangen, damit kein Bogen am Anfang zerschnitten wird
        let n = pts.len();
        let (mut best, mut turn) = (0usize, -1.0f64);
        for i in 0..n {
            let (a, b, c) = (pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n]);
            let an = jsmath::atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])).abs();
            if an > turn {
                turn = an;
                best = i;
            }
        }
        // keine echte Ecke (alles tangential): am Anfang der längsten Geraden
        if turn < pi / 18.0 {
            let mut len = -1.0f64;
            for i in 0..n {
                let l = hypot2(pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1]);
                if l > len {
                    len = l;
                    best = i;
                }
            }
        }
        seq = pts[best..].iter().chain(pts[..best].iter()).copied().collect();
        seq.push(pts[best]);
    }
    let (mut out_p, mut out_b): (Vec<Pt>, Vec<f64>) = (Vec::new(), Vec::new());
    if seq.is_empty() {
        return (out_p, out_b);
    }
    let last = seq.len() - 1;
    let mut i = 0;
    while i < last {
        let fit = longest_fit(&seq, i, tol);
        out_p.push(seq[i]);
        match fit {
            Some(f) => {
                out_b.push((if f.ccw { 1.0 } else { -1.0 }) * jsmath::tan(f.sweep / 4.0));
                i = f.j;
            }
            None => {
                out_b.push(0.0);
                i += 1;
            }
        }
    }
    if !closed {
        out_p.push(seq[last]);
        out_b.push(0.0);
    }
    // Punkte auf einer Geraden weglassen
    let (mut pp, mut bb): (Vec<Pt>, Vec<f64>) = (Vec::new(), Vec::new());
    let m = out_p.len();
    for i in 0..m {
        let next = if i + 1 < m { Some(out_p[i + 1]) } else if closed { Some(out_p[0]) } else { None };
        if i >= 1 && out_b[i] == 0.0 && bb.last() == Some(&0.0) {
            if let (Some(next), Some(&prev)) = (next, pp.last()) {
                let (dx, dy) = (next[0] - prev[0], next[1] - prev[1]);
                let l = hypot2(dx, dy);
                if l > 1e-9 && (dx * (out_p[i][1] - prev[1]) - dy * (out_p[i][0] - prev[0])).abs() / l < 1e-3 && (out_p[i][0] - prev[0]) * dx + (out_p[i][1] - prev[1]) * dy >= 0.0 {
                    continue;
                }
            }
        }
        pp.push(out_p[i]);
        bb.push(out_b[i]);
    }
    (pp, bb)
}

/// Ist der geschlossene Linienzug ein Kreis? Alle Ecken auf einem Kreis, mindestens 20. Antwort: (cx, cy, r)
pub fn fit_circle(pts: &[Pt], tol: f64) -> Option<[f64; 3]> {
    let pi = std::f64::consts::PI;
    let n = pts.len();
    if n < 20 {
        return None;
    }
    let c = circle3(pts[0], pts[n / 3], pts[(2 * n) / 3])?;
    let r = hypot2(pts[0][0] - c[0], pts[0][1] - c[1]);
    if r > MAX_RADIUS {
        return None;
    }
    let keep = mx(tol, r * 0.001);
    let mut sum = 0.0f64;
    for i in 0..n {
        let d = hypot2(pts[i][0] - c[0], pts[i][1] - c[1]);
        if (d - r).abs() > keep {
            return None;
        }
        let q = pts[(i + 1) % n];
        // rundherum in einer Richtung und ohne große Lücke
        let an = jsmath::atan2((pts[i][0] - c[0]) * (q[1] - c[1]) - (pts[i][1] - c[1]) * (q[0] - c[0]), (pts[i][0] - c[0]) * (q[0] - c[0]) + (pts[i][1] - c[1]) * (q[1] - c[1]));
        if an.abs() > pi / 6.0 {
            return None;
        }
        sum += an;
    }
    if (sum.abs() - 2.0 * pi).abs() > 1e-3 {
        return None;
    }
    Some([c[0], c[1], pts.iter().fold(0.0, |s, p| s + hypot2(p[0] - c[0], p[1] - c[1])) / n as f64])
}

// ---- Zeilen erkennen (die Muster aus arcFit.ts, von Hand) ----

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// Zahl  -?\d*\.?\d+  ab Stelle i. Antwort: Stelle danach
fn number_end(s: &[char], i: usize, minus: bool) -> Option<usize> {
    let mut j = i;
    if minus && j < s.len() && s[j] == '-' {
        j += 1;
    }
    let d1 = j;
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
    if j == d1 {
        None
    } else {
        Some(j)
    }
}
fn spaces(s: &[char], mut i: usize) -> usize {
    while i < s.len() && js_space(s[i]) {
        i += 1;
    }
    i
}
fn text(s: &[char]) -> String {
    s.iter().collect()
}

/// Zeile der Form  ^G0?1\s+X(zahl)\s+Y(zahl)(?:\s+F(zahl))?\s*$  – Antwort: x, y und F als Text
fn plain_move(line: &str) -> Option<(f64, f64, Option<String>)> {
    let s: Vec<char> = line.chars().collect();
    let mut i = 0;
    if s.first() != Some(&'G') {
        return None;
    }
    i += 1;
    if s.get(i) == Some(&'0') && s.get(i + 1) == Some(&'1') {
        i += 2;
    } else if s.get(i) == Some(&'1') {
        i += 1;
    } else {
        return None;
    }
    let after = spaces(&s, i);
    if after == i || s.get(after) != Some(&'X') {
        return None;
    }
    let x0 = after + 1;
    let x1 = number_end(&s, x0, true)?;
    let after = spaces(&s, x1);
    if after == x1 || s.get(after) != Some(&'Y') {
        return None;
    }
    let y0 = after + 1;
    let y1 = number_end(&s, y0, true)?;
    let x = text(&s[x0..x1]).parse::<f64>().ok()?;
    let y = text(&s[y0..y1]).parse::<f64>().ok()?;
    let after = spaces(&s, y1);
    if after == s.len() {
        return Some((x, y, None));
    }
    if after == y1 || s[after] != 'F' {
        return None;
    }
    let f0 = after + 1;
    let f1 = number_end(&s, f0, false)?;
    if spaces(&s, f1) != s.len() {
        return None;
    }
    Some((x, y, Some(text(&s[f0..f1]))))
}

/// Erstes Wort  c\s*(zahl)  in der Zeile (wie WORD in arcFit.ts)
fn word(code: &[char], c: char) -> Option<f64> {
    for i in 0..code.len() {
        if code[i] != c {
            continue;
        }
        let n0 = spaces(code, i + 1);
        if let Some(n1) = number_end(code, n0, true) {
            return text(&code[n0..n1]).parse::<f64>().ok();
        }
    }
    None
}

/// \bG(?:eine der Nummern)\b  – Nummern als Text, z. B. "091", "91", "20"
fn has_g(code: &[char], numbers: &[&str]) -> bool {
    for i in 0..code.len() {
        if code[i] != 'G' || (i > 0 && word_char(code[i - 1])) {
            continue;
        }
        for n in numbers {
            let end = i + 1 + n.len();
            if end <= code.len() && code[i + 1..end].iter().copied().eq(n.chars()) && (end == code.len() || !word_char(code[end])) {
                return true;
            }
        }
    }
    false
}

/// Kommentare weg und groß schreiben:  .replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").toUpperCase()
fn code_of(line: &str) -> Vec<char> {
    let s: Vec<char> = line.chars().collect();
    let mut out: Vec<char> = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == '(' {
            if let Some(close) = s[i + 1..].iter().position(|&c| c == ')') {
                out.push(' ');
                i += close + 2;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    // `;.*$`: der Punkt hält an Zeilenende-Zeichen – ein ; zählt nur, wenn danach keines mehr kommt
    let after_last_end = out.iter().rposition(|&c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')).map_or(0, |k| k + 1);
    if let Some(k) = out[after_last_end..].iter().position(|&c| c == ';') {
        out.truncate(after_last_end + k);
    }
    text(&out).to_uppercase().chars().collect()
}

struct Link {
    line: String,
    p: Pt,
    f: Option<String>,
}

/// Fertigen Fräs-G-Code nachbearbeiten: G1-Ketten, die auf einem Bogen liegen, werden zu G2/G3
pub fn fit_arcs(gcode: &str, tolerance: f64) -> ArcFitResult {
    let tol = clamp_arc_tol(tolerance);
    let lines: Vec<&str> = gcode.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut pos: Option<Pt> = None;
    let mut arcs = 0usize;
    let mut chain: Vec<Link> = Vec::new();
    let mut chain_start: Option<Pt> = None;

    fn flush(chain: &mut Vec<Link>, chain_start: &mut Option<Pt>, out: &mut Vec<String>, arcs: &mut usize, tol: f64) {
        if chain.is_empty() {
            return;
        }
        let mut pts: Vec<Pt> = Vec::with_capacity(chain.len() + 1);
        pts.push(chain_start.unwrap_or([0.0, 0.0]));
        pts.extend(chain.iter().map(|c| c.p));
        let mut i = 0;
        while i < chain.len() {
            match longest_fit(&pts, i, tol) {
                Some(fit) => {
                    let end = pts[fit.j];
                    let f = chain[fit.i].f.as_ref().map_or(String::new(), |f| format!(" F{f}"));
                    out.push(format!("{} X{} Y{} I{} J{}{}", if fit.ccw { "G3" } else { "G2" }, to_fixed3(end[0]), to_fixed3(end[1]), to_fixed3(fit.ci), to_fixed3(fit.cj), f));
                    *arcs += 1;
                    i = fit.j;
                }
                None => {
                    out.push(chain[i].line.clone());
                    i += 1;
                }
            }
        }
        chain.clear();
        *chain_start = None;
    }

    for (n, raw) in lines.iter().enumerate() {
        let line = js_trim(raw);
        if let (Some((x, y, f)), Some(at)) = (plain_move(line), pos) {
            if f.is_some() && !chain.is_empty() {
                flush(&mut chain, &mut chain_start, &mut out, &mut arcs, tol);
            }
            if chain.is_empty() {
                chain_start = Some(at);
            }
            chain.push(Link { line: raw.to_string(), p: [x, y], f });
            pos = Some([x, y]);
            continue;
        }
        flush(&mut chain, &mut chain_start, &mut out, &mut arcs, tol);
        let code = code_of(line);
        // etwas, das die Rechnung ungültig macht: ab hier alles unverändert lassen
        if has_g(&code, &["091", "91", "20", "18", "19", "92", "10"]) {
            out.extend(lines[n..].iter().map(|l| l.to_string()));
            break;
        }
        let (x, y) = (word(&code, 'X'), word(&code, 'Y'));
        // Maschinenkoordinaten / Referenzfahrt: Lage im Werkstück danach unbekannt
        if has_g(&code, &["53", "28", "30"]) {
            pos = None;
        } else if x.is_some() || y.is_some() {
            if let (Some(x), Some(y)) = (x, y) {
                pos = Some([x, y]);
            } else if let Some(at) = pos {
                pos = Some([x.unwrap_or(at[0]), y.unwrap_or(at[1])]);
            }
        }
        out.push(raw.to_string());
    }
    flush(&mut chain, &mut chain_start, &mut out, &mut arcs, tol);
    ArcFitResult { gcode: out.join("\n"), before: lines.len(), after: out.len(), arcs }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn rounding_like_to_fixed() {
        assert_eq!(to_fixed3(0.0625), "0.063"); // genau auf der Hälfte: JavaScript rundet weg von null
        assert_eq!(to_fixed3(-0.0625), "-0.063");
        assert_eq!(to_fixed3(2.1875), "2.188");
        assert_eq!(to_fixed3(0.0005), "0.001"); // 0,0005 liegt als Zahl knapp über der Hälfte
        assert_eq!(to_fixed3(1.0005), "1.000"); // 1,0005 liegt als Zahl knapp darunter
        assert_eq!(to_fixed3(-0.0001), "-0.000");
        assert_eq!(to_fixed3(-0.0), "0.000");
        assert_eq!(to_fixed3(12.0), "12.000");
        assert_eq!(to_fixed3(-3.14159), "-3.142");
    }

    #[test]
    fn line_patterns() {
        assert_eq!(plain_move("G1 X10 Y-2.5"), Some((10.0, -2.5, None)));
        assert_eq!(plain_move("G01 X.5 Y3 F800"), Some((0.5, 3.0, Some("800".into()))));
        for bad in ["G1 X10 Y2 Z1", "G1 X10", "G1X10 Y2", "G0 X1 Y2", "g1 X1 Y2", "G1 X1. Y2", "G1 X1 Y2 F", "G1 X1 Y2 F-5", "G1 X1 Y2 ; c", "G11 X1 Y2", "G1 Y2 X1"] {
            assert_eq!(plain_move(bad), None, "{bad}");
        }
        let c = |s: &str| code_of(s);
        assert!(has_g(&c("G91"), &["091", "91"]) && has_g(&c("g091 x1"), &["091", "91"]) && has_g(&c("G92.1"), &["92"]));
        assert!(!has_g(&c("G910"), &["91"]) && !has_g(&c("XG91"), &["91"]) && !has_g(&c("(G91) G1"), &["91"]) && !has_g(&c("G1 ; G91"), &["91"]));
        assert_eq!(word(&c("G0 X 12.5 Y-3"), 'X'), Some(12.5));
        assert_eq!(word(&c("G0 X. X7"), 'X'), Some(7.0));
        assert_eq!(word(&c("G0 Z5"), 'X'), None);
    }

    fn circle_gcode(n: usize, r: f64, part: f64) -> String {
        let mut l = vec!["G21".to_string(), "G90".to_string(), format!("G0 X{:.3} Y0.000", r), "G1 Z-1.000 F100".to_string()];
        for i in 1..=n {
            let a = part * std::f64::consts::PI * 2.0 * i as f64 / n as f64;
            l.push(format!("G1 X{:.3} Y{:.3}{}", r * a.cos(), r * a.sin(), if i == 1 { " F600" } else { "" }));
        }
        l.push("G0 Z5.000".into());
        l.join("\n")
    }

    #[test]
    fn quarter_circle_becomes_one_arc() {
        let r = fit_arcs(&circle_gcode(40, 20.0, 0.25), 0.01);
        assert_eq!(r.arcs, 1);
        assert_eq!(r.after, 6);
        let arc = r.gcode.split('\n').nth(4).unwrap();
        assert_eq!(arc, "G3 X0.000 Y20.000 I-20.000 J0.000 F600");
    }

    #[test]
    fn full_circle_is_split_and_other_modes_stop_the_fitting() {
        let full = fit_arcs(&circle_gcode(120, 15.0, 1.0), 0.01);
        assert_eq!(full.arcs, 2, "at most 270 degrees per arc");
        let rel = format!("G91\n{}", circle_gcode(40, 20.0, 0.25));
        assert_eq!(fit_arcs(&rel, 0.01).arcs, 0);
        assert_eq!(fit_arcs(&rel, 0.01).gcode, rel);
        let straight = "G0 X0 Y0\nG1 X1 Y0\nG1 X2 Y0\nG1 X3 Y0\nG1 X4 Y0\nG1 X5 Y0";
        assert_eq!(fit_arcs(straight, 0.01).gcode, straight);
    }

    // ---- Vergleich mit dem TypeScript: dieselben Fälle ----

    fn fixture(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures").join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    #[test]
    fn same_result_as_typescript() {
        let cases: Value = serde_json::from_str(&fixture("arcfit-cases.json")).unwrap();
        let expected: Value = serde_json::from_str(&fixture("arcfit-expected.json")).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 40);
        let (mut lines, mut arcs, mut numbers, mut differ) = (0usize, 0usize, 0usize, 0usize);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let want = expected.get(name).unwrap_or_else(|| panic!("{name}: no expected result (run UPDATE_FIXTURES=1 npm test)"));
            let tol = c["tol"].as_f64().unwrap_or(ARC_TOL_DEFAULT);
            if let Some(g) = c["gcode"].as_array() {
                // G-Code: Zeile für Zeile gleich
                let src = g.iter().map(|l| l.as_str().unwrap()).collect::<Vec<_>>().join("\n");
                let r = fit_arcs(&src, tol);
                let wanted: Vec<&str> = want["gcode"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
                let got: Vec<&str> = r.gcode.split('\n').collect();
                for (k, (a, b)) in got.iter().zip(&wanted).enumerate() {
                    assert_eq!(a, b, "{name}: line {}", k + 1);
                }
                assert_eq!(got.len(), wanted.len(), "{name}: number of lines");
                assert_eq!((r.before as u64, r.after as u64, r.arcs as u64), (want["before"].as_u64().unwrap(), want["after"].as_u64().unwrap(), want["arcs"].as_u64().unwrap()), "{name}: counts");
                lines += got.len();
                arcs += r.arcs;
                continue;
            }
            let pts: Vec<Pt> = c["pts"].as_array().unwrap().iter().map(|p| [p[0].as_f64().unwrap(), p[1].as_f64().unwrap()]).collect();
            if c["circle"].as_bool() == Some(true) {
                let got = fit_circle(&pts, tol);
                assert_eq!(got.is_some(), !want["circle"].is_null(), "{name}: is it a circle");
                if let Some(g) = got {
                    for k in 0..3 {
                        let w = want["circle"][k].as_f64().unwrap();
                        assert!((g[k] - w).abs() <= 1e-9, "{name}: circle value {k}: {} != {w}", g[k]);
                    }
                }
                continue;
            }
            let (p, b) = fit_path_arcs(&pts, c["closed"].as_bool().unwrap(), tol);
            let wp: Vec<Pt> = want["pts"].as_array().unwrap().iter().map(|p| [p[0].as_f64().unwrap(), p[1].as_f64().unwrap()]).collect();
            let wb: Vec<f64> = want["bulges"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
            assert_eq!(p, wp, "{name}: points (they are input points, so exactly the same)");
            assert_eq!(b.len(), wb.len(), "{name}: bulges");
            for (k, (g, w)) in b.iter().zip(&wb).enumerate() {
                numbers += 1;
                differ += (g.to_bits() != w.to_bits()) as usize;
                assert!((g - w).abs() <= 1e-9, "{name}: bulge {k}: {g} != {w}");
            }
        }
        println!("{} cases: {lines} G-code lines identical ({arcs} arcs); {numbers} bulges, {differ} differ in the last digit", cases.len());
    }
}
