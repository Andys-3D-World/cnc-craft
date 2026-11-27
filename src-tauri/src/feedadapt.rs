//! VORSCHUB IN KURVEN ANPASSEN – Zwilling von `src/feedAdapt.ts` (adaptFeed), Zeile für Zeile.
//!
//! In engen Kurven und Innenecken umschlingt der Fräser mehr Material als auf der Geraden. Der fertige G-Code einer
//! Form wird deshalb nachbearbeitet: zusammenhängende Schnitt-Bewegungen in der Ebene bilden eine Kette, entlang der
//! Kette wird die Richtungsänderung gezählt, daraus ein Faktor für den Vorschub (in 10-%-Stufen, nie unter dem Minimum).
//! Lange Geraden und Bögen werden dafür geteilt; F wird nur geschrieben, wenn es sich ändert.
//! Bei G20 (Zoll), G91 (relativ) oder einer anderen Ebene als G17 bleibt der G-Code unverändert.
//!
//! Die Winkelfunktionen kommen aus jsmath.rs: ihre letzte Stelle kann von der im Fenster abweichen. Das trifft nur die
//! Teilpunkte geteilter Bögen (dritte Nachkommastelle, selten).

use crate::gcodesim::{hypot2, js_space, mn, mx};
use crate::jsmath::{self, js_num, to_fixed};
use std::collections::HashMap;

type Pt = [f64; 2];

/// Schnitt-Bewegung in der Ebene
struct Move {
    line: usize,
    /// Originalzeile ohne F
    text: String,
    g: u8,
    a: Pt,
    b: Pt,
    /// Bogen: Mittelpunkt und Radius
    c: Option<Pt>,
    r: f64,
    len: f64,
    d0: Pt,
    d1: Pt,
    /// Lage in der Kette
    s0: f64,
}

struct Piece {
    g: u8,
    a: Pt,
    b: Pt,
    c: Option<Pt>,
    f: f64,
    text: Option<String>,
}

fn unit(x: f64, y: f64) -> Pt {
    let l = hypot2(x, y);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    [x / l, y / l]
}

/// kleinster Vorschub in % (clampPct)
pub fn clamp_pct(v: f64) -> f64 {
    mx(10.0, mn(100.0, jsmath::js_round(v)))
}

/// Zahl wie im Muster `[+-]?(?:\d+\.?\d*|\.\d+)` ab Stelle i; Antwort: Ende der Zahl
fn number_at(s: &[char], i: usize) -> Option<usize> {
    let mut j = i;
    if j < s.len() && (s[j] == '+' || s[j] == '-') {
        j += 1;
    }
    let d0 = j;
    while j < s.len() && s[j].is_ascii_digit() {
        j += 1;
    }
    if j > d0 {
        if j < s.len() && s[j] == '.' {
            j += 1;
            while j < s.len() && s[j].is_ascii_digit() {
                j += 1;
            }
        }
        return Some(j);
    }
    if j < s.len() && s[j] == '.' {
        let k = j + 1;
        let mut e = k;
        while e < s.len() && s[e].is_ascii_digit() {
            e += 1;
        }
        if e > k {
            return Some(e);
        }
    }
    None
}

fn skip_space(s: &[char], mut i: usize) -> usize {
    while i < s.len() && js_space(s[i]) {
        i += 1;
    }
    i
}

fn parse_num(s: &[char]) -> f64 {
    s.iter().collect::<String>().parse::<f64>().unwrap_or(f64::NAN)
}

/// Kommentare weg: `(…)` und alles ab `;`
fn strip_comments(raw: &[char]) -> Vec<char> {
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
    out
}

/// Wörter einer Zeile: (Buchstabe groß, Zahl) – Muster `([A-Z])\s*(Zahl)` ohne Rücksicht auf Groß/Klein
fn words(code: &[char]) -> Vec<(char, f64)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < code.len() {
        if code[i].is_ascii_alphabetic() {
            let j = skip_space(code, i + 1);
            if let Some(e) = number_at(code, j) {
                out.push((code[i].to_ascii_uppercase(), parse_num(&code[j..e])));
                i = e;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Erstes `F Zahl` der Zeile: (Anfang samt Leerzeichen davor, Stelle des F, Ende, Wert)
fn first_f(s: &[char]) -> Option<(usize, usize, usize, f64)> {
    for at in 0..s.len() {
        let j = skip_space(s, at);
        if j < s.len() && (s[j] == 'F' || s[j] == 'f') {
            let k = skip_space(s, j + 1);
            if let Some(e) = number_at(s, k) {
                return Some((at, j, e, parse_num(&s[k..e])));
            }
        }
    }
    None
}

fn trim_end(s: &str) -> &str {
    s.trim_end_matches(js_space)
}

/// F an die Zeile hängen – vor einen Kommentar, wenn sie einen hat
fn with_f(line: &str, f: f64) -> String {
    match line.find(['(', ';']) {
        None => format!("{} F{}", trim_end(line), js_num(f)),
        Some(k) => format!("{} F{} {}", trim_end(&line[..k]), js_num(f), &line[k..]),
    }
}

/// `gcode` = G-Code einer Form, `tool_radius` in mm, `min_pct` = kleinster Vorschub in % (10 … 100)
pub fn adapt_feed(gcode: &str, tool_radius: f64, min_pct: f64) -> String {
    let pi = std::f64::consts::PI;
    let r = mx(0.05, tool_radius);
    let min_f = clamp_pct(min_pct) / 100.0;
    if min_f >= 1.0 {
        return gcode.to_string();
    }
    let win = mx(0.5, 2.0 * r); // Fenster = Fräserdurchmesser
    let lead = mx(0.5, r); // so weit vor/nach der Ecke schon langsam

    let lines: Vec<&str> = gcode.split('\n').collect();
    let (mut pos, mut z, mut mot, mut base): (Option<Pt>, f64, f64, f64) = (None, f64::NAN, 0.0, f64::NAN);
    // je Zeile: Nummer der Kette und Platz darin, wenn die Zeile eine Schnitt-Bewegung ist
    let mut is_move: Vec<bool> = vec![false; lines.len()];
    let mut chains: Vec<Vec<Move>> = Vec::new();
    let mut chain: Vec<Move> = Vec::new();

    for (i, raw) in lines.iter().enumerate() {
        let raw_c: Vec<char> = raw.chars().collect();
        let has_comment = raw_c.iter().any(|&c| c == '(' || c == ';');
        let stripped = strip_comments(&raw_c);
        let start = skip_space(&stripped, 0);
        let mut end = stripped.len();
        while end > start && js_space(stripped[end - 1]) {
            end -= 1;
        }
        let code = &stripped[start..end];
        if code.is_empty() {
            continue;
        }
        let mut w: HashMap<char, f64> = HashMap::new();
        let mut gs: Vec<f64> = Vec::new();
        let mut other = false;
        for (k, v) in words(code) {
            if k == 'G' {
                gs.push(v);
            } else {
                w.insert(k, v);
            }
            if !"GXYZIJF".contains(k) {
                other = true;
            }
        }
        // Zoll, relativ, andere Ebene: lieber gar nichts ändern
        if gs.iter().any(|&g| g == 20.0 || g == 91.0 || g == 18.0 || g == 19.0) {
            return gcode.to_string();
        }
        let is_motion = |g: f64| g == 0.0 || g == 1.0 || g == 2.0 || g == 3.0;
        if let Some(&m) = gs.iter().find(|&&g| is_motion(g)) {
            mot = m;
        }
        if let Some(&f) = w.get(&'F') {
            base = f;
        }
        let moving = w.contains_key(&'X') || w.contains_key(&'Y') || w.contains_key(&'Z');
        if !moving {
            // reine F-Zeile oder Kommentar trennt die Kette nicht, alles andere schon
            if (other || gs.iter().any(|&g| !is_motion(g))) && !chain.is_empty() {
                chains.push(std::mem::take(&mut chain));
            }
            continue;
        }
        let a = pos;
        let b: Option<Pt> = match a {
            Some(a) => Some([w.get(&'X').copied().unwrap_or(a[0]), w.get(&'Y').copied().unwrap_or(a[1])]),
            None => match (w.get(&'X'), w.get(&'Y')) {
                (Some(&x), Some(&y)) => Some([x, y]),
                _ => None,
            },
        };
        let nz = w.get(&'Z').copied().unwrap_or(z);
        let flat = z.is_finite() && (nz - z).abs() < 1e-6;
        let mut mv: Option<Move> = None;
        if let (Some(a), Some(b)) = (a, b) {
            if flat && !has_comment && !other && mot >= 1.0 && base.is_finite() && base > 0.0 && gs.iter().all(|&g| g == mot) {
                let text: String = match first_f(&raw_c) {
                    Some((at, _, e, _)) => raw_c[..at].iter().chain(raw_c[e..].iter()).collect(),
                    None => raw.to_string(),
                };
                if mot == 1.0 {
                    let len = hypot2(b[0] - a[0], b[1] - a[1]);
                    if len > 1e-6 {
                        let d = unit(b[0] - a[0], b[1] - a[1]);
                        mv = Some(Move { line: i, text, g: 1, a, b, c: None, r: 0.0, len, d0: d, d1: d, s0: 0.0 });
                    }
                } else if w.contains_key(&'I') || w.contains_key(&'J') {
                    let c = [a[0] + w.get(&'I').copied().unwrap_or(0.0), a[1] + w.get(&'J').copied().unwrap_or(0.0)];
                    let rad = hypot2(a[0] - c[0], a[1] - c[1]);
                    if rad > 1e-4 {
                        let a0 = jsmath::atan2(a[1] - c[1], a[0] - c[0]);
                        let a1 = jsmath::atan2(b[1] - c[1], b[0] - c[0]);
                        let mut sweep = if mot == 2.0 { a0 - a1 } else { a1 - a0 };
                        while sweep <= 1e-9 {
                            sweep += 2.0 * pi;
                        }
                        let tan = |p: Pt| if mot == 3.0 { unit(-(p[1] - c[1]), p[0] - c[0]) } else { unit(p[1] - c[1], -(p[0] - c[0])) };
                        mv = Some(Move { line: i, text, g: mot as u8, a, b, c: Some(c), r: rad, len: rad * sweep, d0: tan(a), d1: tan(b), s0: 0.0 });
                    }
                }
            }
        }
        match mv {
            Some(m) => {
                chain.push(m);
                is_move[i] = true;
            }
            None => {
                if !chain.is_empty() {
                    chains.push(std::mem::take(&mut chain));
                }
            }
        }
        if b.is_some() {
            pos = b;
        }
        z = nz;
    }
    if !chain.is_empty() {
        chains.push(chain);
    }

    // ---- Faktoren je Stück berechnen ----
    let mut pieces: HashMap<usize, Vec<Piece>> = HashMap::new();
    for ch in chains.iter_mut() {
        let mut s = 0.0;
        for m in ch.iter_mut() {
            m.s0 = s;
            s += m.len;
        }
        let total = s;
        let ch: &Vec<Move> = ch;
        let (first, last) = (&ch[0], &ch[ch.len() - 1]);
        let closed = ch.len() > 1 && hypot2(first.a[0] - last.b[0], first.a[1] - last.b[1]) < 1e-3;
        // Ecken: Sprung am Ende jeder Bewegung (bei geschlossenen Ketten auch am Schluss)
        let kink: Vec<f64> = (0..ch.len())
            .map(|k| {
                let m = &ch[k];
                let n = if k + 1 < ch.len() {
                    &ch[k + 1]
                } else if closed {
                    first
                } else {
                    return 0.0;
                };
                jsmath::atan2((m.d1[0] * n.d0[1] - m.d1[1] * n.d0[0]).abs(), m.d1[0] * n.d0[0] + m.d1[1] * n.d0[1])
            })
            .collect();
        // T(s): Richtungsänderung von 0 bis s (Ecke zählt ab ihrer Stelle)
        let mut t_at: Vec<f64> = Vec::with_capacity(ch.len());
        let mut acc = 0.0;
        for (k, m) in ch.iter().enumerate() {
            t_at.push(acc);
            acc += (if m.c.is_some() { m.len / m.r } else { 0.0 }) + kink[k];
        }
        let t_tot = acc;
        let t0 = |u: f64| -> f64 {
            if u <= 0.0 {
                return 0.0;
            }
            if u >= total {
                return t_tot;
            }
            let (mut lo, mut hi) = (0usize, ch.len() - 1);
            while lo < hi {
                let mid = (lo + hi + 1) >> 1;
                if ch[mid].s0 <= u {
                    lo = mid;
                } else {
                    hi = mid - 1;
                }
            }
            let m = &ch[lo];
            t_at[lo] + if m.c.is_some() { (u - m.s0) / m.r } else { 0.0 }
        };
        let t = |u: f64| -> f64 {
            if !closed {
                return if u < 0.0 {
                    0.0
                } else if u >= total {
                    t_tot
                } else {
                    t0(u)
                };
            }
            let k = (u / total).floor();
            k * t_tot + t0(u - k * total)
        };
        let f_at = |u: f64| -> f64 {
            let turn = t(u + win / 2.0) - t(u - win / 2.0 - 1e-9);
            if turn < 1e-9 {
                return 1.0;
            }
            let r_eff = win / turn;
            r_eff / (r_eff + r)
        };
        // kleinster Faktor für das Stück [p, q] einer Bewegung, mit Vor-/Nachlauf
        let f_piece = |m: &Move, p: f64, q: f64| -> f64 {
            let mut f = if m.len > win { f_at(m.s0 + m.len / 2.0) } else { 1.0 };
            let step = win / 4.0;
            let mut sample = |u0: f64, u1: f64| {
                if u1 < u0 {
                    return;
                }
                let n = mx(1.0, ((u1 - u0) / step).ceil());
                for k in 0..=(n as usize) {
                    f = mn(f, f_at(u0 + (u1 - u0) * k as f64 / n));
                }
            };
            sample(p - lead, mn(q + lead, m.s0 + win / 2.0));
            sample(mx(p - lead, m.s0 + m.len - win / 2.0), q + lead);
            if p - lead < m.s0 + win / 2.0 && q + lead > m.s0 + m.len - win / 2.0 {
                sample(p - lead, q + lead);
            }
            f
        };
        let quant = |f: f64| if f >= 0.9 { 1.0 } else { mx(min_f, (f * 10.0 + 1e-9).floor() / 10.0) };
        let d = lead + win / 2.0 + 0.01;
        for m in ch {
            let (s0, s1) = (m.s0, m.s0 + m.len);
            let mut cuts = vec![s0, s1];
            let mut fs = vec![quant(f_piece(m, s0, s1))];
            if m.len > 2.0 * d + 0.1 {
                let (fa, fm, fb) = (quant(f_piece(m, s0, s0 + d)), quant(f_piece(m, s0 + d, s1 - d)), quant(f_piece(m, s1 - d, s1)));
                cuts = vec![s0, s0 + d, s1 - d, s1];
                fs = vec![fa, fm, fb];
                // gleiche Nachbarn zusammenfassen
                let mut k = fs.len() - 1;
                while k > 0 {
                    if fs[k] == fs[k - 1] {
                        fs.remove(k);
                        cuts.remove(k);
                    }
                    k -= 1;
                }
            }
            let at = |u: f64| -> Pt {
                let tt = (u - s0) / m.len;
                match m.c {
                    Some(c) if m.r != 0.0 => {
                        let a0 = jsmath::atan2(m.a[1] - c[1], m.a[0] - c[0]);
                        let an = a0 + (if m.g == 3 { 1.0 } else { -1.0 }) * (u - s0) / m.r;
                        [c[0] + m.r * jsmath::cos(an), c[1] + m.r * jsmath::sin(an)]
                    }
                    _ => [m.a[0] + (m.b[0] - m.a[0]) * tt, m.a[1] + (m.b[1] - m.a[1]) * tt],
                }
            };
            let count = fs.len();
            let mut list: Vec<Piece> = (0..count)
                .map(|k| Piece { g: m.g, a: if k == 0 { m.a } else { at(cuts[k]) }, b: if k == count - 1 { m.b } else { at(cuts[k + 1]) }, c: m.c, f: fs[k], text: None })
                .collect();
            if list.len() == 1 {
                list[0].text = Some(m.text.clone());
            }
            pieces.insert(m.line, list);
        }
    }

    // ---- neu schreiben: F nur bei Änderung ----
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut out_f = f64::NAN;
    base = f64::NAN;
    mot = 0.0;
    for (i, raw) in lines.iter().enumerate() {
        let raw_c: Vec<char> = raw.chars().collect();
        let code = strip_comments(&raw_c);
        // erstes F mit Zahl (ohne die Leerzeichen davor zu brauchen)
        let fm = first_f(&code).map(|x| x.3);
        // erstes G-Wort mit einer Nummer bis 3
        let mut k = 0;
        while k < code.len() {
            if code[k] == 'G' || code[k] == 'g' {
                let j = skip_space(&code, k + 1);
                let mut e = j;
                while e < code.len() && code[e].is_ascii_digit() {
                    e += 1;
                }
                if e > j {
                    let v = parse_num(&code[j..e]);
                    if v <= 3.0 {
                        mot = v;
                        break;
                    }
                    k = e;
                    continue;
                }
            }
            k += 1;
        }
        if let Some(f) = fm {
            base = f;
        }
        let ps = if is_move[i] { pieces.get(&i) } else { None };
        let Some(ps) = ps else {
            // fremde Vorschub-Bewegung ohne F: ursprünglichen Vorschub wiederherstellen
            if fm.is_some() {
                out_f = base;
            } else if mot >= 1.0 && code.iter().any(|c| matches!(c, 'X' | 'Y' | 'Z' | 'x' | 'y' | 'z')) && base.is_finite() && out_f != base {
                out.push(with_f(raw, base));
                out_f = base;
                continue;
            }
            out.push(raw.to_string());
            continue;
        };
        for p in ps {
            let f = if p.f >= 1.0 { base } else { mx(1.0, jsmath::js_round(base * p.f)) };
            let mut text = match (&p.text, p.c) {
                (Some(t), _) => t.clone(),
                (None, Some(c)) if p.g != 1 => format!("G{} X{} Y{} I{} J{}", p.g, to_fixed(p.b[0], 3), to_fixed(p.b[1], 3), to_fixed(c[0] - p.a[0], 3), to_fixed(c[1] - p.a[1], 3)),
                _ => format!("G1 X{} Y{}", to_fixed(p.b[0], 3), to_fixed(p.b[1], 3)),
            };
            if f != out_f {
                text = with_f(&text, f);
                out_f = f;
            }
            out.push(text);
        }
    }
    // am Ende wieder den ursprünglichen Vorschub, damit folgender Code stimmt
    if base.is_finite() && out_f != base {
        let tail = if out.last().is_some_and(|l| l.is_empty()) { out.pop() } else { None };
        out.push(format!("F{}", js_num(base)));
        if let Some(t) = tail {
            out.push(t);
        }
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn straight_lines_keep_their_feed() {
        let g = "G1 Z-1.000 F300\nG1 F800\nG1 X0.000 Y0.000\nG1 X50.000 Y0.000\nG1 X100.000 Y0.000\n";
        assert_eq!(adapt_feed(g, 1.5, 50.0), g);
    }

    #[test]
    fn sharp_corner_is_slower_and_the_feed_comes_back() {
        // rechter Winkel bei X50: davor und danach langsamer, auf den langen Geraden wieder 800
        let g = "G0 X0.000 Y0.000\nG1 Z-1.000 F300\nG1 F800\nG1 X50.000 Y0.000\nG1 X50.000 Y50.000\nG0 Z5.00\n";
        let out = adapt_feed(g, 1.5, 50.0);
        let fs: Vec<&str> = out.split('\n').filter(|l| l.contains(" F") && l.starts_with("G1 X")).collect();
        assert!(fs.len() >= 2, "{out}");
        assert!(out.contains("F400"), "slow at the corner: {out}");
        assert!(out.lines().filter(|l| l.ends_with("F800")).count() >= 1, "back to full feed: {out}");
    }

    /// Dieselben Fälle wie tests/feedAdaptRust.test.ts: der G-Code Zeile für Zeile wie im TypeScript
    #[test]
    fn same_gcode_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let cases: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("feedadapt-cases.json")).unwrap()).unwrap();
        let expected: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("feedadapt-expected.json")).unwrap()).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 25);
        let mut lines = 0;
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let src = c["gcode"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect::<Vec<_>>().join("\n");
            let got = adapt_feed(&src, c["r"].as_f64().unwrap(), c["pct"].as_f64().unwrap());
            let want: Vec<&str> = expected[name].as_array().unwrap_or_else(|| panic!("{name}: no expected result")).iter().map(|l| l.as_str().unwrap()).collect();
            let got: Vec<&str> = got.split('\n').collect();
            for (k, (a, b)) in got.iter().zip(&want).enumerate() {
                assert_eq!(a, b, "{name}: line {}", k + 1);
            }
            assert_eq!(got.len(), want.len(), "{name}: number of lines");
            lines += want.len();
        }
        println!("{} cases, {lines} G-code lines the same as feedAdapt.ts", cases.len());
    }

    #[test]
    fn inch_relative_or_other_planes_stay_untouched() {
        for head in ["G20", "G91", "G18"] {
            let g = format!("{head}\nG1 Z-1 F300\nG1 F800\nG1 X5 Y0\nG1 X5 Y5\n");
            assert_eq!(adapt_feed(&g, 1.5, 50.0), g);
        }
        assert_eq!(adapt_feed("G1 X1 Y1 F100\nG1 X2 Y9", 1.5, 100.0), "G1 X1 Y1 F100\nG1 X2 Y9");
    }
}
