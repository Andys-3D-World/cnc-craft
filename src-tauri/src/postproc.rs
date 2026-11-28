//! POSTPROZESSOR – Zwilling von `postProcess` in `src/post/postProcess.ts`.
//!
//! Macht aus dem neutralen Fräsprogramm (mm, für GRBL) eine Datei für LinuxCNC, Mach3, Mach4 …: Zoll umrechnen,
//! Bögen nach dem Runden neu zentrieren, Werkzeuglänge vor der ersten Bewegung, Pausen, Zeilennummern. Unbekanntes
//! bricht mit Zeilennummer ab. Folgt dem TypeScript Zeile für Zeile (toFixed/parseFloat wie in JavaScript); der
//! Test vergleicht den Text Zeichen für Zeichen. Gemeinsame Fälle: `tests/fixtures/postproc-cases.json`.

use crate::gcodesim::{hypot2, js_space};
use crate::importdxf::parse_float;
use crate::jsmath::{self, js_num, js_round, to_fixed};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PostDef {
    pub rewrite: bool,
    pub start: Vec<String>,
    pub end: Option<Vec<String>>,
    pub tool_table: Option<Vec<String>>,
    pub tool_pause: Option<Vec<String>>,
    pub dwell: String,
    pub spin_up: f64,
    pub line_numbers: f64,
    pub comment: String,
    pub blend: f64,
    pub has_tool_table: bool,
}
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PostOptions {
    pub inch: bool,
    pub tool_table: bool,
    pub info: Option<Vec<String>>,
    pub inch_note: Option<String>,
}
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct PostError {
    pub code: String,
    pub line: usize,
    pub text: String,
}
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct PostResult {
    pub gcode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<PostError>,
    /// Rückprüfung (pathcheck.rs) – nur der Befehl `post_process` füllt sie
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check: Option<crate::pathcheck::PathCheck>,
}

const MM_PER_INCH: f64 = 25.4;
const G_KEEP: [f64; 15] = [0.0, 1.0, 2.0, 3.0, 17.0, 40.0, 54.0, 55.0, 56.0, 57.0, 58.0, 59.0, 80.0, 90.0, 94.0];
const M_KEEP: [f64; 8] = [0.0, 1.0, 3.0, 4.0, 5.0, 7.0, 8.0, 9.0];

#[derive(Clone, Debug)]
struct Word {
    l: char,
    txt: String,
    v: f64,
}
struct Line {
    words: Vec<Word>,
    comments: Vec<String>,
    rest: String,
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// Muster `([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))` ab i: (Ende, Buchstabe, Zahl-Text) oder None
fn word_at(c: &[char], i: usize) -> Option<(usize, char, String)> {
    if !c[i].is_ascii_alphabetic() {
        return None;
    }
    let mut j = i + 1;
    while j < c.len() && js_space(c[j]) {
        j += 1;
    }
    let num = |k: usize| -> Option<usize> {
        if c.get(k).is_some_and(|ch| ch.is_ascii_digit()) {
            let mut e = k;
            while e < c.len() && c[e].is_ascii_digit() {
                e += 1;
            }
            if c.get(e) == Some(&'.') {
                e += 1;
                while e < c.len() && c[e].is_ascii_digit() {
                    e += 1;
                }
            }
            Some(e)
        } else if c.get(k) == Some(&'.') && c.get(k + 1).is_some_and(|ch| ch.is_ascii_digit()) {
            let mut e = k + 1;
            while e < c.len() && c[e].is_ascii_digit() {
                e += 1;
            }
            Some(e)
        } else {
            None
        }
    };
    let s = j;
    let e = (if matches!(c.get(j), Some('-' | '+')) { num(j + 1) } else { None }).or_else(|| num(j))?;
    Some((e, c[i], c[s..e].iter().collect()))
}

fn read_line(raw: &str) -> Line {
    let mut comments = vec![];
    // \(([^)]*)\) -> " "
    let rc: Vec<char> = raw.chars().collect();
    let mut code = String::new();
    let mut i = 0;
    while i < rc.len() {
        if rc[i] == '(' {
            if let Some(p) = rc[i + 1..].iter().position(|&ch| ch == ')') {
                comments.push(rc[i + 1..i + 1 + p].iter().collect::<String>());
                code.push(' ');
                i += p + 2;
                continue;
            }
        }
        code.push(rc[i]);
        i += 1;
    }
    if let Some(semi) = code.find(';') {
        let c = js_trim(&code[semi + 1..]).to_string();
        if !c.is_empty() {
            comments.push(c);
        }
        code.truncate(semi);
    }
    let cc: Vec<char> = code.chars().collect();
    let mut words = vec![];
    let mut rest = String::new();
    let mut k = 0;
    while k < cc.len() {
        if let Some((e, l, txt)) = word_at(&cc, k) {
            words.push(Word { l: l.to_ascii_uppercase(), v: parse_float(&txt), txt });
            k = e;
        } else {
            rest.push(cc[k]);
            k += 1;
        }
    }
    Line { words, comments, rest: js_trim(&rest).to_string() }
}

/// Zahl mit fester Stellenzahl, nie „-0.000“
pub fn fixed(v: f64, d: usize) -> String {
    let s = to_fixed(v, d);
    // /^-0\.?0*$/: „-0“, vielleicht ein Punkt, dann nur Nullen
    if let Some(r) = s.strip_prefix("-0") {
        if r.strip_prefix('.').unwrap_or(r).bytes().all(|c| c == b'0') {
            return s[1..].to_string();
        }
    }
    s
}

/// Vorschub: bis 2 Stellen, ohne Nullen am Ende, nie 0
fn feed_text(v: f64) -> String {
    let s = to_fixed(v, 2);
    // replace(/\.?0+$/, "") – die früheste Stelle, ab der nur noch „.“ (höchstens eins) und Nullen kommen
    let b = s.as_bytes();
    let mut cut = b.len();
    for i in 0..b.len() {
        let r = &b[i..];
        let z = if r.first() == Some(&b'.') { &r[1..] } else { r };
        if !z.is_empty() && z.iter().all(|&c| c == b'0') {
            cut = i;
            break;
        }
    }
    let s = &s[..cut];
    if s == "0" || s.is_empty() {
        "0.01".into()
    } else {
        s.into()
    }
}

/// `^\s*(MSG|DEBUG|…)\s*,` ohne Groß/Klein
fn active_comment(c: &str) -> bool {
    let t = c.trim_start_matches(js_space).to_ascii_uppercase();
    ["MSG", "DEBUG", "PRINT", "LOG", "LOGOPEN", "LOGAPPEND", "LOGCLOSE", "PROBEOPEN", "PROBECLOSE", "PYRUN", "PYRELOAD", "ABORT"].iter().any(|w| {
        t.starts_with(w) && t[w.len()..].trim_start_matches(js_space).starts_with(',')
    })
}

fn pow10(k: i32) -> f64 {
    format!("1e{k}").parse().unwrap()
}

pub fn post_process(neutral: &str, def: &PostDef, o: &PostOptions) -> PostResult {
    if !def.rewrite && !o.inch {
        return PostResult { gcode: neutral.to_string(), error: None, check: None };
    }
    let src: Vec<&str> = neutral.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let lines: Vec<Line> = src.iter().map(|l| read_line(l)).collect();
    let mut out: Vec<String> = vec![];
    let dec = if o.inch { 4 } else { 3 };
    let ij_dec = dec + 1;
    let table = o.tool_table && def.has_tool_table && def.tool_table.is_some();
    // slice(0, 80) zählt UTF-16-Einheiten
    let text80 = |i: usize| {
        let mut n = 0;
        src.get(i).map_or(String::new(), |s| s.chars().take_while(|c| { n += c.len_utf16(); n <= 80 }).collect())
    };
    let fail = |code: &str, i: usize| PostResult { gcode: String::new(), error: Some(PostError { code: code.into(), line: i + 1, text: text80(i) }), check: None };
    let cmt = |list: &[String]| -> String {
        if list.is_empty() {
            return String::new();
        }
        let text = list.iter().map(|c| if active_comment(c) { format!("- {c}") } else { c.clone() }).collect::<Vec<_>>().join(" - ");
        if def.comment == "semicolon" {
            format!("; {text}")
        } else {
            format!("({text})")
        }
    };
    let with_cmt = |code: &str, list: &[String]| -> String {
        let c = cmt(list);
        if !code.is_empty() && !c.is_empty() {
            format!("{code} {c}")
        } else if !code.is_empty() {
            code.into()
        } else {
            c
        }
    };
    let len = |txt: &str, v: f64| if o.inch { fixed(v / MM_PER_INCH, dec) } else { txt.to_string() };
    let dwell = |sec: f64, txt: &str| -> String {
        match def.dwell.as_str() {
            "ms" => js_num(js_round(sec * 1000.0)),
            "s." => {
                if sec.fract() == 0.0 && sec.is_finite() {
                    to_fixed(sec, 1)
                } else {
                    js_num(sec)
                }
            }
            _ => txt.into(),
        }
    };
    let has = |ln: &Line, l: char, v: f64| ln.words.iter().any(|w| w.l == l && w.v == v);
    let word = |ln: &Line, l: char| ln.words.iter().find(|w| w.l == l).cloned();
    let start_has = |w: &str| def.start.iter().any(|s| s.split(js_space).any(|p| p == w));
    let rotary = |ln: &Line| ln.words.iter().any(|w| "ABCUVW".contains(w.l));

    for (i, ln) in lines.iter().enumerate() {
        if rotary(ln) {
            return fail("rotary", i);
        }
    }
    let mut first_tool: Option<usize> = None;
    if table {
        for (i, ln) in lines.iter().enumerate() {
            if has(ln, 'M', 6.0) {
                first_tool = Some(i);
                break;
            }
            if has(ln, 'M', 3.0) || has(ln, 'M', 4.0) {
                break;
            }
        }
        if first_tool.is_none() {
            return fail("noTool", 0);
        }
    }
    let tool_lines = |ln: &Line, i: usize, z: Option<&str>| -> Result<Vec<String>, PostError> {
        let tw = word(ln, 'T');
        let bad = match &tw {
            None => true,
            Some(t) => !(t.v >= 1.0) || t.v.fract() != 0.0 || !t.v.is_finite() || ln.words.len() != 2,
        };
        if bad {
            return Err(PostError { code: "noTool".into(), line: i + 1, text: text80(i) });
        }
        let tv = js_num(tw.unwrap().v);
        let tpl = if table { def.tool_table.as_ref().unwrap() } else { def.tool_pause.as_ref().unwrap() };
        let mut res: Vec<String> = vec![];
        for s in tpl {
            if s.contains("{z}") && z.is_none() {
                continue;
            }
            res.push(s.replace("{t}", &tv).replace("{z}", z.unwrap_or("")));
        }
        if !res.is_empty() {
            res[0] = with_cmt(&res[0], &ln.comments);
        }
        Ok(res)
    };

    // ---- Start ----
    for tpl in &def.start {
        if tpl == "{info}" {
            for s in o.info.as_deref().unwrap_or(&[]) {
                out.push(cmt(std::slice::from_ref(s)));
            }
            continue;
        }
        let blend = {
            let b = fixed(if o.inch { def.blend / MM_PER_INCH } else { def.blend }, dec);
            let b = b.trim_end_matches('0').to_string();
            if b.ends_with('.') {
                b + "0"
            } else {
                b
            }
        };
        let s = tpl.replace("{units}", if o.inch { "G20" } else { "G21" }).replace("{g49}", if table { "G49" } else { "" }).replace("{blend}", &blend);
        let s = s.split(js_space).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ");
        // replace(/\s+/g, " ").trim(): Leerraum-Läufe zu einem Leerzeichen, außen weg
        if !s.is_empty() {
            out.push(s);
        }
    }
    if let Some(ft) = first_tool {
        match tool_lines(&lines[ft], ft, None) {
            Ok(r) => out.extend(r),
            Err(e) => return PostResult { gcode: String::new(), error: Some(e), check: None },
        }
    }

    // ---- Programm ----
    let (mut x, mut y, mut ox, mut oy): (Option<f64>, Option<f64>, Option<f64>, Option<f64>) = (None, None, None, None);
    let mut z_text: Option<String> = None;
    let mut motion: f64 = -1.0;
    let (mut spin_wait, mut ended) = (false, false);
    for (i, ln) in lines.iter().enumerate() {
        if !ln.rest.is_empty() {
            return fail("unknown", i);
        }
        if ln.words.is_empty() {
            if ended {
                if !ln.comments.is_empty() {
                    return fail("afterEnd", i);
                }
                continue;
            }
            out.push(cmt(&ln.comments));
            continue;
        }
        if ended {
            return fail("afterEnd", i);
        }
        if rotary(ln) {
            return fail("rotary", i);
        }
        if has(ln, 'G', 20.0) {
            return fail("inchInput", i);
        }
        if has(ln, 'G', 91.0) {
            return fail("relative", i);
        }
        let is_dwell = has(ln, 'G', 4.0);
        if spin_wait && !is_dwell {
            out.push(format!("G4 P{}", dwell(def.spin_up, &js_num(def.spin_up))));
        }
        spin_wait = false;
        // Programmende
        if has(ln, 'M', 30.0) || has(ln, 'M', 2.0) {
            if ln.words.len() != 1 {
                return fail("unknown", i);
            }
            ended = true;
            match &def.end {
                Some(end) => {
                    for (k, s) in end.iter().enumerate() {
                        out.push(if k == 0 { with_cmt(s, &ln.comments) } else { s.clone() });
                    }
                }
                None => out.push(with_cmt(&format!("{}{}", ln.words[0].l, ln.words[0].txt), &ln.comments)),
            }
            continue;
        }
        // Werkzeugwechsel
        if has(ln, 'M', 6.0) {
            if Some(i) == first_tool {
                continue;
            }
            if def.tool_pause.is_none() || def.tool_table.is_none() {
                out.push(src[i].to_string());
                continue;
            }
            match tool_lines(ln, i, z_text.as_deref()) {
                Ok(r) => out.extend(r),
                Err(e) => return PostResult { gcode: String::new(), error: Some(e), check: None },
            }
            continue;
        }
        // Verweilen
        if is_dwell {
            let p = word(ln, 'P');
            match p {
                Some(p) if ln.words.len() == 2 && p.v >= 0.0 => {
                    out.push(with_cmt(&format!("G4 P{}", dwell(p.v, &p.txt)), &ln.comments));
                    continue;
                }
                _ => return fail("unknown", i),
            }
        }
        if ln.words.len() == 1 && has(ln, 'G', 21.0) {
            if !start_has("{units}") {
                out.push(if o.inch {
                    let note: Vec<String> = o.inch_note.iter().filter(|n| !n.is_empty()).cloned().collect();
                    with_cmt("G20", &note)
                } else {
                    with_cmt("G21", &ln.comments)
                });
            }
            continue;
        }
        if ln.words.len() == 1 && has(ln, 'G', 90.0) {
            if !start_has("G90") {
                out.push(with_cmt("G90", &ln.comments));
            }
            continue;
        }
        // Bewegungen, Vorschub, Spindel
        let mut line_motion: f64 = -1.0;
        for w in &ln.words {
            if w.l == 'G' {
                if !G_KEEP.contains(&w.v) {
                    return fail("unknown", i);
                }
                if w.v <= 3.0 {
                    line_motion = w.v;
                }
            } else if w.l == 'M' {
                if !M_KEEP.contains(&w.v) {
                    return fail("unknown", i);
                }
                if (w.v == 3.0 || w.v == 4.0) && def.spin_up > 0.0 {
                    spin_wait = true;
                }
            } else if !"XYZIJFS".contains(w.l) {
                return fail("unknown", i);
            }
        }
        let (wx, wy, wz, wi, wj) = (word(ln, 'X'), word(ln, 'Y'), word(ln, 'Z'), word(ln, 'I'), word(ln, 'J'));
        let moves = wx.is_some() || wy.is_some() || wz.is_some();
        if line_motion < 0.0 && moves {
            if motion < 0.0 {
                return fail("unknown", i);
            }
            line_motion = motion;
        }
        let arc = moves && (line_motion == 2.0 || line_motion == 3.0);
        if (wi.is_some() || wj.is_some()) && !arc && !(line_motion >= 2.0 && !moves) {
            return fail("arc", i);
        }
        let full_circle_no_axis = !moves && (line_motion == 2.0 || line_motion == 3.0) && (wi.is_some() || wj.is_some());
        let nx = wx.as_ref().map(|w| w.v).or(x);
        let ny = wy.as_ref().map(|w| w.v).or(y);
        let tx = wx.as_ref().map(|w| len(&w.txt, w.v));
        let ty = wy.as_ref().map(|w| len(&w.txt, w.v));
        let nox = tx.as_ref().map(|t| parse_float(t)).or(ox);
        let noy = ty.as_ref().map(|t| parse_float(t)).or(oy);
        let mut i_text = wi.as_ref().map(|w| len(&w.txt, w.v));
        let mut j_text = wj.as_ref().map(|w| len(&w.txt, w.v));
        let mut as_line = false;
        if arc || full_circle_no_axis {
            let (Some(x0), Some(y0), Some(ox0), Some(oy0), Some(nx0), Some(ny0), Some(nox0), Some(noy0)) = (x, y, ox, oy, nx, ny, nox, noy) else {
                return fail("arc", i);
            };
            let k = if o.inch { 1.0 / MM_PER_INCH } else { 1.0 };
            let (iv, jv) = (wi.as_ref().map_or(0.0, |w| w.v), wj.as_ref().map_or(0.0, |w| w.v));
            let mut cx = (x0 + iv) * k;
            let mut cy = (y0 + jv) * k;
            let (chord_x, chord_y) = (nox0 - ox0, noy0 - oy0);
            let chord = hypot2(chord_x, chord_y);
            if chord < 1e-12 {
                let was = hypot2(nx0 - x0, ny0 - y0);
                if was > 1e-9 {
                    let a0 = jsmath::atan2(y0 - (y0 + jv), x0 - (x0 + iv));
                    let a1 = jsmath::atan2(ny0 - (y0 + jv), nx0 - (x0 + iv));
                    let mut sweep = if line_motion == 2.0 { a0 - a1 } else { a1 - a0 };
                    while sweep < 0.0 {
                        sweep += std::f64::consts::PI * 2.0;
                    }
                    if sweep < std::f64::consts::PI {
                        as_line = true;
                    }
                }
            } else {
                let (mx, my) = ((ox0 + nox0) / 2.0, (oy0 + noy0) / 2.0);
                let (ux, uy) = (-chord_y / chord, chord_x / chord);
                let along = (cx - mx) * ux + (cy - my) * uy;
                cx = mx + ux * along;
                cy = my + uy * along;
            }
            if !as_line {
                let step = pow10(-(ij_dec as i32));
                let bi = ((cx - ox0) / step).floor() * step;
                let bj = ((cy - oy0) / step).floor() * step;
                let mut best = f64::INFINITY;
                for di in [0.0, step] {
                    for dj in [0.0, step] {
                        let ci = parse_float(&to_fixed(bi + di, ij_dec));
                        let cj = parse_float(&to_fixed(bj + dj, ij_dec));
                        let r1 = hypot2(ci, cj);
                        let r2 = hypot2(ox0 + ci - nox0, oy0 + cj - noy0);
                        let off = hypot2(ox0 + ci - cx, oy0 + cj - cy);
                        let score = (r1 - r2).abs() + off * 1e-3;
                        if score < best {
                            best = score;
                            i_text = Some(fixed(ci, ij_dec));
                            j_text = Some(fixed(cj, ij_dec));
                        }
                    }
                }
            }
        }
        let mut parts: Vec<String> = vec![];
        let mut ij_done = false;
        if moves && !ln.words.iter().any(|w| w.l == 'G' && w.v <= 3.0) {
            parts.push(if as_line { "G1".into() } else { format!("G{}", js_num(line_motion)) });
        }
        for w in &ln.words {
            match w.l {
                'G' => {
                    if w.v == 21.0 {
                        if !start_has("{units}") {
                            parts.push(if o.inch { "G20" } else { "G21" }.into());
                        }
                    } else if as_line && (w.v == 2.0 || w.v == 3.0) {
                        parts.push("G1".into());
                    } else {
                        parts.push(format!("G{}", w.txt));
                    }
                }
                'X' => parts.push(format!("X{}", tx.clone().unwrap_or_default())),
                'Y' => parts.push(format!("Y{}", ty.clone().unwrap_or_default())),
                'Z' => {
                    let zt = len(&w.txt, w.v);
                    parts.push(format!("Z{zt}"));
                    z_text = Some(zt);
                }
                'I' | 'J' => {
                    if as_line || ij_done {
                        continue;
                    }
                    ij_done = true;
                    parts.push(format!("I{}", i_text.clone().unwrap_or_else(|| fixed(0.0, ij_dec))));
                    parts.push(format!("J{}", j_text.clone().unwrap_or_else(|| fixed(0.0, ij_dec))));
                }
                'F' => parts.push(format!("F{}", if o.inch { feed_text(w.v / MM_PER_INCH) } else { w.txt.clone() })),
                _ => parts.push(format!("{}{}", w.l, w.txt)),
            }
        }
        out.push(with_cmt(&parts.join(" "), &ln.comments));
        if line_motion >= 0.0 {
            motion = line_motion;
        }
        if moves {
            x = nx;
            y = ny;
            ox = nox;
            oy = noy;
        }
    }
    if !ended {
        return fail("noEnd", src.len() - 1);
    }
    // ---- Zeilennummern ----
    if def.line_numbers > 0.0 {
        let mut n = def.line_numbers;
        for s in out.iter_mut() {
            if s.is_empty() || s.starts_with('%') || s.starts_with('(') || s.starts_with(';') {
                continue;
            }
            *s = format!("N{} {s}", js_num(n));
            n += def.line_numbers;
            if n > 99999.0 {
                n = def.line_numbers;
            }
        }
    }
    PostResult { gcode: out.join("\n") + "\n", error: None, check: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn small_pieces() {
        assert_eq!((fixed(-0.00001, 3), fixed(-1.5, 1), feed_text(12.5), feed_text(0.001), feed_text(10.0)), ("0.000".into(), "-1.5".into(), "12.5".into(), "0.01".into(), "10".into()));
        let l = read_line("G1 X1.5 y-.5 (cmt) F 100 ; tail");
        assert_eq!((l.words.len(), l.comments.len(), l.rest.as_str()), (4, 2, ""));
    }

    #[test]
    fn same_result_as_typescript() {
        use std::io::Read;
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("postproc-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        let cases = all["cases"].as_array().unwrap();
        assert!(cases.len() >= 1500, "only {} cases", cases.len());
        let (mut ok, mut errors) = (0, 0);
        for c in cases {
            let (p, d, oi) = (c["p"].as_str().unwrap(), c["d"].as_str().unwrap(), c["o"].as_u64().unwrap() as usize);
            let def: PostDef = serde_json::from_value(all["defs"][d].clone()).unwrap();
            let o: PostOptions = serde_json::from_value(all["opts"][oi].clone()).unwrap();
            let got = post_process(all["programs"][p].as_str().unwrap(), &def, &o);
            let gv = serde_json::to_value(&got).unwrap();
            if gv != c["want"] {
                let w = c["want"]["gcode"].as_str().unwrap_or("");
                let k = got.gcode.split('\n').zip(w.split('\n')).position(|(a, b)| a != b);
                panic!("{p} / {d} / options {oi}: first different line {:?}: {:?} vs {:?}; error {} vs {}", k.map(|k| k + 1),
                    k.and_then(|k| got.gcode.split('\n').nth(k)), k.and_then(|k| w.split('\n').nth(k)), gv["error"], c["want"]["error"]);
            }
            if got.error.is_some() { errors += 1 } else { ok += 1 }
        }
        println!("{} programs posted the same as postProcess.ts ({ok} files, {errors} stopped with the same error)", cases.len());
    }
}
