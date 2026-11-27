//! G-CODE-LESER FÜR DIE SIMULATION (Zwilling von src/sim/gcodeParser.ts, motionPlan.ts und simNotes.ts)
//!
//! Wandelt G-Code in eine Liste von Bewegungen um (gerade Stücke; Bögen fein unterteilt), mit Zeile, Art und Zeit.
//! Die Rechnung folgt dem TypeScript Zeile für Zeile – auch in den Eigenheiten (z. B. wie Kommentare und Zahlen
//! erkannt werden), damit App und Vorschau dasselbe zeigen. Geprüft wird das mit denselben Fällen auf beiden Seiten:
//! tests/fixtures/gcodesim-cases.json (Eingaben) und gcodesim-expected.json (Ergebnis des TypeScript),
//! siehe tests/gcodeSimRust.test.ts und die Tests unten.
//!
//! Nur Anzeige und Zeitschätzung – nichts hiervon geht an die Maschine.

use serde::{Deserialize, Serialize};

pub const MOVE_RAPID: u8 = 0;
pub const MOVE_CUT: u8 = 1;
pub const MOVE_TRAVEL: u8 = 2;

/// Bohrzyklen, die nachgebildet werden (wie cycles.rs)
const CYCLES: [f64; 8] = [73.0, 74.0, 81.0, 82.0, 83.0, 84.0, 85.0, 89.0];

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub accel: Vec<f64>,
    pub max_rate: Vec<f64>,
    pub junction_dev: f64,
    #[serde(default)]
    pub arc_tol: Option<f64>,
    pub lookahead: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    #[serde(default)]
    pub rapid_rate: Option<f64>,
    #[serde(default)]
    pub default_feed: Option<f64>,
    #[serde(default)]
    pub arc_tol: Option<f64>,
    #[serde(default)]
    pub motion: Option<Limits>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Note {
    pub kind: String,
    pub code: String,
    pub line: u32,
    pub count: u32,
}

#[derive(Debug, Default)]
pub struct Program {
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
    /// nur mit Beschleunigung: Dauer ohne Rampen
    pub dur_plain: Option<Vec<f32>>,
    pub total_time: f64,
    pub cut_length: f64,
    pub rapid_length: f64,
    /// minX, minY, minZ, maxX, maxY, maxZ
    pub bounds: [f64; 6],
    pub cut_min_z: f64,
    pub cut_max_z: f64,
    pub notes: Vec<Note>,
    /// nur wenn der G-Code eine A-Achse hat
    pub a: Option<(Vec<f32>, Vec<f32>)>,
}

// ---- Rechnen wie JavaScript ----

/// Math.hypot wie V8: größten Betrag herausziehen, Quadrate mit Kahan-Summe addieren
pub(crate) fn hypot(v: &[f64]) -> f64 {
    let mut max = 0.0f64;
    let mut nan = false;
    for &x in v {
        if x.is_infinite() {
            return f64::INFINITY;
        }
        if x.is_nan() {
            nan = true;
        }
        let a = x.abs();
        if a > max {
            max = a;
        }
    }
    if nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut comp) = (0.0f64, 0.0f64);
    for &x in v {
        let n = x.abs() / max;
        let summand = n * n - comp;
        let prelim = sum + summand;
        comp = (prelim - sum) - summand;
        sum = prelim;
    }
    sum.sqrt() * max
}
pub(crate) fn hypot2(a: f64, b: f64) -> f64 {
    hypot(&[a, b])
}
pub(crate) fn hypot3(a: f64, b: f64, c: f64) -> f64 {
    hypot(&[a, b, c])
}
/// Math.max / Math.min: NaN bleibt NaN (f64::max würde es verschlucken)
pub(crate) fn mx(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}
pub(crate) fn mn(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}
/// Math.round: halbe Werte nach oben
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}
/// `x | 0`
fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let m = x.trunc().rem_euclid(4294967296.0);
    (m as u64) as u32 as i32
}
/// Leerzeichen, wie `\s` und trim() sie in JavaScript sehen
pub(crate) fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
/// Zeilenende-Zeichen: daran hält `.` in einem JavaScript-Muster an
fn js_line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}
pub(crate) fn word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Kommentare ( ) und ; entfernen, Ränder abschneiden – wie stripComments() im TypeScript.
/// Nicht geschlossene Klammer: der Rest ist Kommentar. `;` zählt nur, wenn danach kein Zeilenende-Zeichen
/// mehr kommt (ein übrig gebliebenes \r am Ende lässt den ;-Kommentar stehen – so macht es das Muster dort auch).
fn strip_comments(l: &str, out: &mut Vec<char>) {
    out.clear();
    let mut in_paren = false;
    for c in l.chars() {
        if in_paren {
            if c == ')' {
                in_paren = false;
            }
        } else if c == '(' {
            in_paren = true;
        } else {
            out.push(c);
        }
    }
    let after_last_end = out.iter().rposition(|&c| js_line_end(c)).map_or(0, |i| i + 1);
    if let Some(i) = out[after_last_end..].iter().position(|&c| c == ';') {
        out.truncate(after_last_end + i);
    }
    let end = out.iter().rposition(|&c| !js_space(c)).map_or(0, |i| i + 1);
    out.truncate(end);
    let start = out.iter().position(|&c| !js_space(c)).unwrap_or(0);
    out.drain(..start);
}

/// Kommt die Drehachse A vor?  /(^|[^A-Z])A\s*[-+]?[\d.]/i
fn has_a_word(s: &[char]) -> bool {
    for i in 0..s.len() {
        if s[i] != 'A' && s[i] != 'a' {
            continue;
        }
        if i > 0 && s[i - 1].is_ascii_alphabetic() {
            continue;
        }
        let mut j = i + 1;
        while j < s.len() && js_space(s[j]) {
            j += 1;
        }
        if j < s.len() && (s[j] == '-' || s[j] == '+') {
            j += 1;
        }
        if j < s.len() && (s[j].is_ascii_digit() || s[j] == '.') {
            return true;
        }
    }
    false
}

/// Kommt M3/M4/M5 vor?  /\bM0?[345]\b/i
fn has_spindle_word(s: &[char]) -> bool {
    for i in 0..s.len() {
        if s[i] != 'M' && s[i] != 'm' {
            continue;
        }
        if i > 0 && word_char(s[i - 1]) {
            continue;
        }
        let mut j = i + 1;
        if j < s.len() && s[j] == '0' {
            j += 1;
        }
        if j < s.len() && matches!(s[j], '3' | '4' | '5') && (j + 1 >= s.len() || !word_char(s[j + 1])) {
            return true;
        }
    }
    false
}

/// Ein Wort lesen:  /([A-Z])\s*([-+]?\d*\.?\d+)/  ab Stelle i. Antwort: (Buchstabe, Wert, Stelle danach)
fn word_at(s: &[char], i: usize, num: &mut String) -> Option<(char, f64, usize)> {
    let letter = s[i];
    if !letter.is_ascii_uppercase() {
        return None;
    }
    let mut j = i + 1;
    while j < s.len() && js_space(s[j]) {
        j += 1;
    }
    num.clear();
    if j < s.len() && (s[j] == '-' || s[j] == '+') {
        num.push(s[j]);
        j += 1;
    }
    let d1 = j;
    while j < s.len() && s[j].is_ascii_digit() {
        num.push(s[j]);
        j += 1;
    }
    // Punkt nur, wenn danach eine Ziffer kommt ("12." ist 12, der Punkt bleibt stehen)
    if j + 1 < s.len() && s[j] == '.' && s[j + 1].is_ascii_digit() {
        num.push('.');
        j += 1;
        while j < s.len() && s[j].is_ascii_digit() {
            num.push(s[j]);
            j += 1;
        }
    } else if j == d1 {
        return None;
    }
    num.parse::<f64>().ok().map(|v| (letter, v, j))
}

// ---- Hinweise (simNotes.ts) ----

/// G-Befehle (mal 10), die nachgebildet werden oder die Bahn nicht ändern
const KNOWN: [i64; 45] = [
    0, 10, 20, 30, 40, 150, 170, 180, 190, 200, 210, 281, 301, 400, 430, 431, 432, 490, 500, 501, 610, 611, 640, 690, 730,
    740, 800, 810, 820, 830, 840, 850, 890, 900, 901, 910, 911, 920, 921, 922, 923, 940, 970, 980, 990,
];
const TURNED: [char; 5] = ['B', 'C', 'U', 'V', 'W'];
const MAX_NOTES: usize = 50;

/// Buchstabe + Zahl mit höchstens einer Nachkommastelle:  letter + String(+v.toFixed(1))
fn code_name(letter: char, v: f64) -> String {
    // toFixed rundet genaue Hälften nach oben; die gibt es nur bei …,25 und …,75
    let tie = (v * 4.0).fract() == 0.0 && (v * 4.0).rem_euclid(2.0) == 1.0;
    let r = if tie { v.signum() * (v.abs() * 10.0).ceil() / 10.0 } else { format!("{:.1}", v).parse::<f64>().unwrap_or(v) };
    if r == 0.0 {
        format!("{}0", letter)
    } else {
        format!("{}{}", letter, r)
    }
}

#[derive(Default)]
struct Notes {
    found: Vec<Note>,
    wcs: i64,
    moved: bool,
}

impl Notes {
    fn add(&mut self, kind: &str, code: String, line: usize) {
        if let Some(n) = self.found.iter_mut().find(|n| n.kind == kind && n.code == code) {
            n.count += 1;
        } else if self.found.len() < MAX_NOTES {
            self.found.push(Note { kind: kind.into(), code, line: line as u32, count: 1 });
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn line(&mut self, code: &[char], gs: &[f64], ms: &[f64], words: &[Option<f64>; 26], li: usize, absolute: bool, plane: f64) {
        let c0 = code[0];
        if c0 == '$' || c0 == '%' {
            return;
        }
        if code.iter().any(|&c| c == '#' || c == '[' || c == '=') {
            self.add("expr", String::new(), li);
        }
        if c0 == 'O' && is_sub_line(code) {
            self.add("sub", "O".into(), li);
        }
        for &g in gs {
            let k = js_round(g * 10.0) as i64;
            if k == 280 || k == 300 || k == 530 {
                self.add("move", code_name('G', g), li);
            } else if (540..=599).contains(&k) {
                // Nur der Wechsel zählt: mit einem einzigen System ist das Bild richtig, egal welches es ist
                let changed = if self.wcs != 0 { k != self.wcs } else { self.moved && k != 540 };
                if k == 541 || changed {
                    self.add("wcs", code_name('G', g), li);
                }
                self.wcs = k;
            } else if k == 650 || k == 660 {
                self.add("sub", code_name('G', g), li);
            } else if k == 930 || k == 950 {
                self.add("time", code_name('G', g), li);
            } else if (380..390).contains(&k) {
                continue;
            } else if !KNOWN.contains(&k) {
                self.add("code", code_name('G', g), li);
            } else if ((810..=890).contains(&k) || k == 730 || k == 740) && (!absolute || plane != 17.0) {
                let mode = if absolute { format!("G{}", plane) } else { "G91".to_string() };
                self.add("code", format!("{} ({})", code_name('G', g), mode), li);
            }
        }
        for &m in ms {
            if m == 97.0 || m == 98.0 {
                self.add("sub", code_name('M', m), li);
            }
        }
        for a in TURNED {
            if words[(a as u8 - b'A') as usize].is_some() {
                self.add("axis", a.to_string(), li);
            }
        }
        if words[23].is_some() || words[24].is_some() || words[25].is_some() {
            self.moved = true;
        }
    }

    fn list(mut self) -> Vec<Note> {
        self.found.sort_by_key(|n| n.line);
        self.found
    }
}

/// /^O\s*(<|\d+\s*(SUB|CALL|IF|WHILE|DO|REPEAT))/
fn is_sub_line(code: &[char]) -> bool {
    let mut j = 1;
    while j < code.len() && js_space(code[j]) {
        j += 1;
    }
    if j < code.len() && code[j] == '<' {
        return true;
    }
    let d = j;
    while j < code.len() && code[j].is_ascii_digit() {
        j += 1;
    }
    if j == d {
        return false;
    }
    while j < code.len() && js_space(code[j]) {
        j += 1;
    }
    let rest: String = code[j..].iter().take(6).collect();
    ["SUB", "CALL", "IF", "WHILE", "DO", "REPEAT"].iter().any(|k| rest.starts_with(k))
}

// ---- Laufzeit mit Beschleunigung (motionPlan.ts) ----

struct PlanInput<'a> {
    x0: &'a [f64],
    y0: &'a [f64],
    z0: &'a [f64],
    x1: &'a [f64],
    y1: &'a [f64],
    z1: &'a [f64],
    /// gewünschter Vorschub in mm/min; 0 = Eilgang
    rate: &'a [f64],
    len: &'a [f64],
    stop: &'a [bool],
    dwell: &'a [f64],
    arc_r: &'a [f64],
    arc_in: &'a [bool],
}

/// Zeit für eine Strecke L von v²=e nach v²=x mit Höchstwert v²=n
fn block_time(l: f64, e: f64, x: f64, n: f64, a: f64) -> f64 {
    let (ve, vx) = (e.sqrt(), x.sqrt());
    let peak2 = (2.0 * a * l + e + x) / 2.0;
    if peak2 <= n {
        return mx(0.0, (2.0 * peak2.sqrt() - ve - vx) / a);
    }
    let vn = n.sqrt();
    let cruise = mx(0.0, l - (n - e) / (2.0 * a) - (n - x) / (2.0 * a));
    (vn - ve) / a + (vn - vx) / a + cruise / vn
}

/// Dauer jeder Bewegung in Sekunden (mit Wartezeit)
fn plan_durations(m: &PlanInput, lim: &Limits) -> Vec<f64> {
    let n = m.len.len();
    let mut dur = vec![0.0f64; n];
    if n == 0 {
        return dur;
    }
    let get = |v: &Vec<f64>, i: usize| v.get(i).copied().unwrap_or(f64::NAN);
    let (ax, ay, az) = (get(&lim.accel, 0), get(&lim.accel, 1), get(&lim.accel, 2));
    let (rx, ry, rz) = (get(&lim.max_rate, 0), get(&lim.max_rate, 1), get(&lim.max_rate, 2));
    let look = to_int32(lim.lookahead).max(1) as usize;
    let tol = match lim.arc_tol {
        Some(t) if t > 0.0 => t,
        _ => 0.002,
    };
    let mut nom2 = vec![0.0f64; n];
    let mut acc = vec![0.0f64; n];
    let mut ent = vec![0.0f64; n];
    let (mut px, mut py, mut pz, mut pn, mut has_prev) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, false);
    for i in 0..n {
        let (dx, dy, dz) = (m.x1[i] - m.x0[i], m.y1[i] - m.y0[i], m.z1[i] - m.z0[i]);
        let geo = hypot3(dx, dy, dz);
        let l = m.len[i];
        let on = geo > 1e-12;
        let (ux, uy, uz) = (if on { dx / l } else { 0.0 }, if on { dy / l } else { 0.0 }, if on { dz / l } else { 0.0 });
        let (ax_u, ay_u, az_u) = (ux.abs(), uy.abs(), uz.abs());
        // Achsen-Grenzen auf die Bahn umrechnen (X allein: voll; schräg: die erste Achse am Limit begrenzt)
        let (mut v, mut a) = (f64::INFINITY, f64::INFINITY);
        if ax_u > 1e-12 {
            v = mn(v, rx / ax_u);
            a = mn(a, ax / ax_u);
        }
        if ay_u > 1e-12 {
            v = mn(v, ry / ay_u);
            a = mn(a, ay / ay_u);
        }
        if az_u > 1e-12 {
            v = mn(v, rz / az_u);
            a = mn(a, az / az_u);
        }
        if a == f64::INFINITY {
            // nur Drehachse
            a = mn(ax, ay);
            v = if m.rate[i] > 0.0 { m.rate[i] } else { mn(rx, ry) };
        }
        let want = if m.rate[i] > 0.0 { mn(m.rate[i], v) } else { v };
        let vn = mx(1.0, want) / 60.0;
        nom2[i] = vn * vn;
        acc[i] = a;

        let mut j = 0.0f64;
        if has_prev && !m.stop[i] {
            let c = -(px * ux + py * uy + pz * uz); // −1 = geradeaus, +1 = Umkehr
            if c < -0.999999 && !m.arc_in[i] {
                j = f64::INFINITY;
            } else if c > 0.999999 {
                j = 0.0;
            } else {
                let (wx, wy, wz) = (ux - px, uy - py, uz - pz);
                let mut wl = hypot3(wx, wy, wz);
                if wl == 0.0 || wl.is_nan() {
                    wl = 1.0;
                }
                let mut ja = f64::INFINITY;
                if wx.abs() > 1e-12 {
                    ja = mn(ja, ax / (wx / wl).abs());
                }
                if wy.abs() > 1e-12 {
                    ja = mn(ja, ay / (wy / wl).abs());
                }
                if wz.abs() > 1e-12 {
                    ja = mn(ja, az / (wz / wl).abs());
                }
                if ja == f64::INFINITY {
                    ja = mn(ax, ay);
                }
                let s = (0.5 * (1.0 - c)).sqrt();
                // Im Bogen zählen die Stücke der Steuerung (Knick aus $12), nicht die der Anzeige
                j = if m.arc_in[i] { (ja * lim.junction_dev * m.arc_r[i]) / tol } else { (ja * lim.junction_dev * s) / (1.0 - s) };
            }
            j = mn(mn(j, nom2[i]), pn);
        }
        ent[i] = j;
        px = ux;
        py = uy;
        pz = uz;
        pn = nom2[i];
        has_prev = true;
    }

    // rückwärts: von jedem Punkt aus muss das Anhalten am Ende (und am Pufferende) reichen
    let (mut exit2, mut sum) = (0.0f64, 0.0f64);
    for i in (0..n).rev() {
        let (l, a) = (m.len[i], acc[i]);
        sum += l;
        if i + look < n {
            sum -= m.len[i + look];
        }
        let mut e = mn(mn(ent[i], exit2 + 2.0 * a * l), 2.0 * a * mx(0.0, sum));
        let r = m.arc_r[i];
        if r > 0.0 {
            // im Bogen sind die Puffer-Blöcke kurz
            e = mn(e, 2.0 * a * look as f64 * (8.0 * tol * r).sqrt());
        }
        if m.stop[i] {
            e = 0.0;
        }
        ent[i] = e;
        exit2 = e;
    }
    // vorwärts: Beschleunigen braucht Weg
    let mut v2 = 0.0f64;
    for i in 0..n {
        let (l, a) = (m.len[i], acc[i]);
        let e = mn(ent[i], v2);
        let x = mn(if i + 1 < n { ent[i + 1] } else { 0.0 }, e + 2.0 * a * l);
        dur[i] = (if l > 0.0 { block_time(l, e, x, nom2[i], a) } else { 0.0 }) + m.dwell[i];
        v2 = x;
    }
    dur
}

// ---- Leser (gcodeParser.ts) ----

/// Sammelt die Bewegungen (das `add` aus dem TypeScript mit allem, was es von außen braucht)
struct Moves {
    x0: Vec<f64>,
    y0: Vec<f64>,
    z0: Vec<f64>,
    x1: Vec<f64>,
    y1: Vec<f64>,
    z1: Vec<f64>,
    kind: Vec<u8>,
    line: Vec<u32>,
    dur: Vec<f64>,
    plan: bool,
    rate_of: Vec<f64>,
    len_of: Vec<f64>,
    stop_of: Vec<bool>,
    dwell_of: Vec<f64>,
    arc_r_of: Vec<f64>,
    arc_in_of: Vec<bool>,
    arc_now: f64,
    arc_inside: bool,
    stop_next: bool,
    has_a: bool,
    a0: Vec<f64>,
    a1: Vec<f64>,
    a: f64,
    na: f64,
    rapid_rate: f64,
    dwell: f64,
    cut_length: f64,
    rapid_length: f64,
}

impl Moves {
    #[allow(clippy::too_many_arguments)]
    fn add(&mut self, ax: f64, ay: f64, az: f64, bx: f64, by: f64, bz: f64, kind: u8, li: usize, f: f64) {
        // A zählt wie GRBL als „mm“ mit (Grad) – nur für die Zeit; die Länge bleibt die XYZ-Strecke
        let da = if self.has_a { self.na - self.a } else { 0.0 };
        let geo = hypot3(bx - ax, by - ay, bz - az);
        let len = hypot2(geo, da);
        // (NaN < 1e-9 ist falsch – dann wird die Bewegung wie im TypeScript trotzdem aufgenommen)
        if len < 1e-9 {
            return;
        }
        self.x0.push(ax);
        self.y0.push(ay);
        self.z0.push(az);
        self.x1.push(bx);
        self.y1.push(by);
        self.z1.push(bz);
        if self.has_a {
            self.a0.push(self.a);
            self.a1.push(self.na);
            self.a = self.na;
        }
        self.kind.push(kind);
        self.line.push(li as u32);
        let rate = if kind == MOVE_RAPID { self.rapid_rate } else { mx(1.0, f) };
        self.dur.push(len / (rate / 60.0) + self.dwell);
        if self.plan {
            self.rate_of.push(if kind == MOVE_RAPID { 0.0 } else { mx(1.0, f) });
            self.len_of.push(len);
            self.stop_of.push(self.stop_next);
            self.dwell_of.push(self.dwell);
            self.arc_r_of.push(self.arc_now);
            self.arc_in_of.push(self.arc_inside);
            self.stop_next = false;
        }
        self.dwell = 0.0;
        if kind == MOVE_RAPID {
            self.rapid_length += geo;
        } else if kind == MOVE_CUT {
            self.cut_length += geo;
        }
    }
}

const X: usize = 23;
const Y: usize = 24;
const Z: usize = 25;
fn w(words: &[Option<f64>; 26], c: u8) -> Option<f64> {
    words[(c - b'A') as usize]
}

/// G-Code lesen. `text` = alle Zeilen, mit \n getrennt (wie `lines.join("\n")` im TypeScript)
pub fn parse(text: &str, opts: &Options) -> Program {
    let rapid_rate = opts.rapid_rate.unwrap_or(5000.0);
    let arc_tol = opts.arc_tol.unwrap_or(0.02);
    let pi = std::f64::consts::PI;

    let mut buf: Vec<char> = Vec::new();
    // Drehachse A: nur wenn sie vorkommt. Spindel-Befehle: sonst ist jede Vorschub-Bewegung ein Schnitt.
    let (mut has_a, mut has_spindle) = (false, false);
    for l in text.split('\n') {
        if has_a && has_spindle {
            break;
        }
        strip_comments(l, &mut buf);
        has_a = has_a || has_a_word(&buf);
        has_spindle = has_spindle || has_spindle_word(&buf);
    }

    let mut mv = Moves {
        x0: vec![], y0: vec![], z0: vec![], x1: vec![], y1: vec![], z1: vec![], kind: vec![], line: vec![], dur: vec![],
        plan: opts.motion.is_some(),
        rate_of: vec![], len_of: vec![], stop_of: vec![], dwell_of: vec![], arc_r_of: vec![], arc_in_of: vec![],
        arc_now: 0.0, arc_inside: false, stop_next: false,
        has_a, a0: vec![], a1: vec![], a: 0.0, na: 0.0,
        rapid_rate, dwell: 0.0, cut_length: 0.0, rapid_length: 0.0,
    };

    let (mut x, mut y, mut z) = (0.0f64, 0.0f64, 0.0f64);
    let (mut absolute, mut inch, mut plane, mut arc_abs) = (true, false, 17.0f64, false);
    // G92: Versatz je Achse (x, y, z bleiben die gezeichnete Lage) und ob die Lage schon bekannt ist
    let (mut ox, mut oy, mut oz) = (0.0f64, 0.0f64, 0.0f64);
    let mut kept = [0.0f64; 3];
    let (mut kx, mut ky, mut kz) = (false, false, false);
    let mut notes = Notes::default();
    let mut motion = 0.0f64;
    let mut feed = opts.default_feed.unwrap_or(1000.0);
    let mut tool_cmd_on = false; // M3/M4 aktiv
    let mut power = 1.0f64; // letzter S-Wert (S0 = Laser/Plasma aus)
    // Bohrzyklus: aktive Nummer (0 = keiner), Rückzug auf Starthöhe (G98) oder R (G99), gemerkte Werte
    let (mut cycle, mut retract_initial) = (0.0f64, true);
    let (mut c_r, mut c_z, mut c_q, mut c_p): (Option<f64>, Option<f64>, Option<f64>, Option<f64>) = (None, None, None, None);

    let mut gs: Vec<f64> = Vec::new();
    let mut ms: Vec<f64> = Vec::new();
    let mut num = String::new();

    for (li, raw) in text.split('\n').enumerate() {
        strip_comments(raw, &mut buf);
        if buf.is_empty() {
            continue;
        }
        if buf.iter().all(|c| c.is_ascii()) {
            buf.iter_mut().for_each(|c| *c = c.to_ascii_uppercase());
        } else {
            let up: String = buf.iter().collect::<String>().to_uppercase();
            buf.clear();
            buf.extend(up.chars());
        }
        let code = &buf[..];

        let mut words: [Option<f64>; 26] = [None; 26];
        gs.clear();
        ms.clear();
        let mut i = 0;
        while i < code.len() {
            match word_at(code, i, &mut num) {
                Some((letter, v, next)) => {
                    match letter {
                        'G' => gs.push(v),
                        'M' => ms.push(v),
                        _ => words[(letter as u8 - b'A') as usize] = Some(v),
                    }
                    i = next;
                }
                None => i += 1,
            }
        }

        for &g in &gs {
            if g == 0.0 || g == 1.0 || g == 2.0 || g == 3.0 || g == 80.0 || (g >= 38.0 && g < 39.0) {
                if g <= 3.0 {
                    motion = g;
                }
                cycle = 0.0;
                c_r = None;
                c_z = None;
                c_q = None;
                c_p = None;
            } else if CYCLES.contains(&g) {
                cycle = g;
            } else if g == 98.0 {
                retract_initial = true;
            } else if g == 99.0 {
                retract_initial = false;
            } else if g == 90.0 {
                absolute = true;
            } else if g == 91.0 {
                absolute = false;
            } else if g == 20.0 {
                inch = true;
            } else if g == 21.0 {
                inch = false;
            } else if g == 17.0 || g == 18.0 || g == 19.0 {
                plane = g;
            } else if g == 90.1 {
                arc_abs = true;
            } else if g == 91.1 {
                arc_abs = false;
            }
        }
        notes.line(code, &gs, &ms, &words, li, absolute, plane);
        let f = if inch { 25.4 } else { 1.0 };
        if let Some(v) = w(&words, b'F') {
            feed = v * f;
        }

        if let Some(v) = w(&words, b'S') {
            power = v;
        }
        for &mc in &ms {
            if mc == 3.0 || mc == 4.0 {
                tool_cmd_on = true;
            } else if mc == 5.0 || mc == 2.0 || mc == 30.0 {
                tool_cmd_on = false;
            }
            // Die Steuerung wartet hier, bis alle Fahrten fertig sind (Spindel, Kühlung, Pause)
            if mc <= 5.0 || mc == 7.0 || mc == 8.0 || mc == 9.0 {
                mv.stop_next = true;
            }
        }
        let spindle_on = !has_spindle || (tool_cmd_on && power > 0.0);

        // G4 P = warten (Sekunden; bei GRBL immer Sekunden)
        if gs.contains(&4.0) {
            if let Some(p) = w(&words, b'P') {
                mv.dwell += mx(0.0, p);
            }
            mv.stop_next = true;
            continue;
        }
        // Antasten (G38.2 usw.): Ergebnis ist unbekannt -> nicht nachbilden
        if gs.iter().any(|&g| g >= 38.0 && g < 39.0) {
            if words[X].is_some() {
                kx = false;
            }
            if words[Y].is_some() {
                ky = false;
            }
            if words[Z].is_some() {
                kz = false;
            }
            continue;
        }
        // G92: die jetzige Stelle bekommt neue Werte. Ist die Lage unbekannt (Programmanfang, nach dem Antasten),
        // gibt es nichts zu verschieben – dann gilt einfach der angegebene Wert.
        if gs.contains(&92.0) {
            if let Some(v) = words[X] {
                if kx {
                    ox = x - v * f;
                } else {
                    x = v * f;
                    ox = 0.0;
                    kx = true;
                }
            }
            if let Some(v) = words[Y] {
                if ky {
                    oy = y - v * f;
                } else {
                    y = v * f;
                    oy = 0.0;
                    ky = true;
                }
            }
            if let Some(v) = words[Z] {
                if kz {
                    oz = z - v * f;
                } else {
                    z = v * f;
                    oz = 0.0;
                    kz = true;
                }
            }
            kept = [ox, oy, oz];
            continue;
        }
        if gs.contains(&92.1) {
            ox = 0.0;
            oy = 0.0;
            oz = 0.0;
            kept = [0.0; 3];
        } else if gs.contains(&92.2) {
            ox = 0.0;
            oy = 0.0;
            oz = 0.0;
        } else if gs.contains(&92.3) {
            ox = kept[0];
            oy = kept[1];
            oz = kept[2];
        }

        // Zyklus-Werte auch von Zeilen ohne Loch merken (z. B. "G99 G83 R1 Q2")
        if cycle != 0.0 {
            if let Some(v) = w(&words, b'R') {
                c_r = Some(v * f + oz);
            }
            if let Some(v) = w(&words, b'Q') {
                c_q = Some((v * f).abs());
            }
            if let Some(v) = w(&words, b'P') {
                c_p = Some(v);
            }
        }
        if has_a {
            mv.na = match w(&words, b'A') {
                None => mv.a,
                Some(v) => {
                    if absolute {
                        v
                    } else {
                        mv.a + v
                    }
                }
            };
        }
        let has_xyz = words[X].is_some() || words[Y].is_some() || words[Z].is_some() || (has_a && mv.na != mv.a);
        if !has_xyz {
            continue;
        }
        // G53/G28 usw. nicht nachbilden (Lage in Werkstück-Koordinaten unbekannt)
        if gs.iter().any(|&g| g == 28.0 || g == 30.0 || g == 53.0) {
            if words[X].is_some() {
                kx = false;
            }
            if words[Y].is_some() {
                ky = false;
            }
            if words[Z].is_some() {
                kz = false;
            }
            continue;
        }
        if words[X].is_some() {
            kx = true;
        }
        if words[Y].is_some() {
            ky = true;
        }
        if words[Z].is_some() {
            kz = true;
        }

        // Bohrzyklus: ein Loch an X/Y (Z = Bohrtiefe, nicht Position)
        if cycle != 0.0 && absolute {
            if let Some(v) = words[Z] {
                c_z = Some(v * f + oz);
            }
            let hx = words[X].map_or(x, |v| v * f + ox);
            let hy = words[Y].map_or(y, |v| v * f + oy);
            let (r, zb) = match (c_r, c_z) {
                (Some(r), Some(zb)) if !(zb > r) => (r, zb),
                _ => {
                    x = hx;
                    y = hy;
                    continue;
                }
            };
            let ret = if retract_initial { mx(z, r) } else { r };
            let kind = if spindle_on { MOVE_CUT } else { MOVE_TRAVEL };
            let clear = if inch { 0.254 } else { 0.25 };
            // senkrecht auf eine neue Höhe
            macro_rules! to {
                ($nz:expr, $k:expr) => {{
                    let nz: f64 = $nz;
                    mv.add(x, y, z, x, y, nz, $k, li, feed);
                    z = nz;
                }};
            }
            if z < r {
                to!(r, MOVE_RAPID);
            }
            mv.add(x, y, z, hx, hy, z, MOVE_RAPID, li, feed);
            x = hx;
            y = hy;
            to!(r, MOVE_RAPID);
            let peck = (cycle == 83.0 || cycle == 73.0) && c_q.is_some_and(|q| q > 0.0);
            if peck {
                let q = c_q.unwrap_or(0.0);
                let mut depth = r;
                for _ in 0..10000 {
                    let next = mx(depth - q, zb);
                    if depth < r {
                        to!(depth + clear, MOVE_RAPID);
                    }
                    to!(next, kind);
                    depth = next;
                    if depth <= zb + 1e-9 {
                        break;
                    }
                    to!(if cycle == 83.0 { r } else { depth + clear }, MOVE_RAPID);
                }
            } else {
                to!(zb, kind);
            }
            if let Some(p) = c_p {
                if p > 0.0 && cycle != 81.0 && cycle != 83.0 && cycle != 73.0 && cycle != 85.0 {
                    mv.dwell += mn(p, 60.0);
                }
            }
            // Ausbohren / Gewindebohren: mit Vorschub wieder heraus
            if cycle == 84.0 || cycle == 74.0 || cycle == 85.0 || cycle == 89.0 {
                to!(r, kind);
            }
            to!(ret, MOVE_RAPID);
            continue;
        }

        let target = |cur: f64, word: Option<f64>, off: f64| match word {
            None => cur,
            Some(v) => {
                if absolute {
                    v * f + off
                } else {
                    cur + v * f
                }
            }
        };
        let (nx, ny, nz) = (target(x, words[X], ox), target(y, words[Y], oy), target(z, words[Z], oz));
        let kind = if motion == 0.0 { MOVE_RAPID } else if spindle_on { MOVE_CUT } else { MOVE_TRAVEL };

        if motion == 0.0 || motion == 1.0 {
            mv.add(x, y, z, nx, ny, nz, kind, li, feed);
        } else {
            // Bogen in der gewählten Ebene, die dritte Achse läuft linear mit (Helix). u/v = Achsen der Ebene, w = dritte:
            // G17: X/Y, Z · G18: Z/X, Y · G19: Y/Z, X (Reihenfolge wie GRBL, dann stimmt die Drehrichtung)
            let (xz, yz) = (plane == 18.0, plane == 19.0);
            let pick = |a: f64, b: f64, c: f64| if xz { a } else if yz { b } else { c };
            let (u0, v0, w0) = (pick(z, y, x), pick(x, z, y), pick(y, x, z));
            let (u1, v1, w1) = (pick(nz, ny, nx), pick(nx, nz, ny), pick(ny, nx, nz));
            let (wi, wj, wk) = (w(&words, b'I'), w(&words, b'J'), w(&words, b'K'));
            let iu = if xz { wk } else if yz { wj } else { wi };
            let iv = if xz { wi } else if yz { wk } else { wj };
            let (cx, cy);
            match w(&words, b'R') {
                Some(rw) if iu.is_none() && iv.is_none() => {
                    let r = rw * f;
                    let (dx, dy) = (u1 - u0, v1 - v0);
                    let d = hypot2(dx, dy);
                    if d < 1e-9 {
                        x = nx;
                        y = ny;
                        z = nz;
                        continue;
                    }
                    let h = mx(0.0, r * r - (d / 2.0) * (d / 2.0)).sqrt();
                    let sgn = if (motion == 2.0) == (r > 0.0) { -1.0 } else { 1.0 };
                    cx = u0 + dx / 2.0 + (sgn * h * -dy) / d;
                    cy = v0 + dy / 2.0 + (sgn * h * dx) / d;
                }
                _ if arc_abs => {
                    cx = iu.map_or(u0, |v| v * f + pick(oz, oy, ox));
                    cy = iv.map_or(v0, |v| v * f + pick(ox, oz, oy));
                }
                _ => {
                    cx = u0 + iu.unwrap_or(0.0) * f;
                    cy = v0 + iv.unwrap_or(0.0) * f;
                }
            }
            let r = hypot2(u0 - cx, v0 - cy);
            let ang0 = (v0 - cy).atan2(u0 - cx);
            let ang1 = (v1 - cy).atan2(u1 - cx);
            let mut sweep = ang1 - ang0;
            if sweep.is_finite() {
                if motion == 2.0 {
                    while sweep >= -1e-9 {
                        sweep -= pi * 2.0;
                    }
                } else {
                    while sweep <= 1e-9 {
                        sweep += pi * 2.0;
                    }
                }
            }
            let step = if r > arc_tol { 2.0 * (1.0 - arc_tol / r).acos() } else { pi / 8.0 };
            // Math.min(720, Math.max(2, Math.ceil(…))): NaN ergäbe dort gar kein Stück
            let want = (sweep.abs() / step).ceil();
            let segs = if want.is_nan() { 0 } else { mn(720.0, mx(2.0, want)) as usize };
            let (mut px, mut py, mut pz) = (x, y, z);
            let (a_s, a_e) = (mv.a, mv.na);
            for s in 1..=segs {
                let tt = s as f64 / segs as f64;
                mv.na = a_s + (a_e - a_s) * tt;
                let ang = ang0 + sweep * tt;
                let qu = if s == segs { u1 } else { cx + r * ang.cos() };
                let qv = if s == segs { v1 } else { cy + r * ang.sin() };
                let qw = w0 + (w1 - w0) * tt;
                let (qx, qy, qz) = (pick(qv, qw, qu), pick(qw, qu, qv), pick(qu, qv, qw));
                mv.arc_now = r;
                mv.arc_inside = s > 1;
                mv.add(px, py, pz, qx, qy, qz, kind, li, feed);
                px = qx;
                py = qy;
                pz = qz;
            }
            mv.arc_now = 0.0;
            mv.arc_inside = false;
        }
        x = nx;
        y = ny;
        z = nz;
    }

    let n = mv.x0.len();
    let planned = opts.motion.as_ref().map(|lim| {
        plan_durations(
            &PlanInput {
                x0: &mv.x0, y0: &mv.y0, z0: &mv.z0, x1: &mv.x1, y1: &mv.y1, z1: &mv.z1,
                rate: &mv.rate_of, len: &mv.len_of, stop: &mv.stop_of, dwell: &mv.dwell_of,
                arc_r: &mv.arc_r_of, arc_in: &mv.arc_in_of,
            },
            lim,
        )
    });
    let mut t0 = vec![0.0f64; n];
    let mut t = 0.0f64;
    for i in 0..n {
        t0[i] = t;
        t += planned.as_ref().map_or(mv.dur[i], |p| p[i]);
    }

    let inf = f64::INFINITY;
    let (mut min, mut max) = ([inf; 3], [-inf; 3]);
    let (mut cut_min_z, mut cut_max_z) = (inf, -inf);
    for i in 0..n {
        for p in [[mv.x0[i], mv.y0[i], mv.z0[i]], [mv.x1[i], mv.y1[i], mv.z1[i]]] {
            for k in 0..3 {
                if p[k] < min[k] {
                    min[k] = p[k];
                }
                if p[k] > max[k] {
                    max[k] = p[k];
                }
            }
        }
        // Tiefen-Farben nur aus waagerechten Schnitten (Eintauchen von Z+5 würde die Skala verzerren)
        if mv.kind[i] == MOVE_CUT && (mv.z0[i] - mv.z1[i]).abs() < 1e-6 {
            if mv.z0[i] < cut_min_z {
                cut_min_z = mv.z0[i];
            }
            if mv.z0[i] > cut_max_z {
                cut_max_z = mv.z0[i];
            }
        }
    }
    if n == 0 {
        min = [0.0; 3];
        max = [0.0; 3];
    }
    if cut_min_z == inf {
        cut_min_z = min[2];
        cut_max_z = max[2];
    }

    let f32s = |v: &[f64]| v.iter().map(|&x| x as f32).collect::<Vec<f32>>();
    Program {
        x0: f32s(&mv.x0), y0: f32s(&mv.y0), z0: f32s(&mv.z0), x1: f32s(&mv.x1), y1: f32s(&mv.y1), z1: f32s(&mv.z1),
        kind: mv.kind,
        line: mv.line,
        t0,
        dur: f32s(planned.as_deref().unwrap_or(&mv.dur[..])),
        dur_plain: planned.as_ref().map(|_| f32s(&mv.dur)),
        total_time: t,
        cut_length: mv.cut_length,
        rapid_length: mv.rapid_length,
        bounds: [min[0], min[1], min[2], max[0], max[1], max[2]],
        cut_min_z,
        cut_max_z,
        notes: notes.list(),
        a: if has_a { Some((f32s(&mv.a0), f32s(&mv.a1))) } else { None },
    }
}

/// Ergebnis als Bytes für das Fenster (alles Little Endian), gelesen in src/sim/parseRust.ts:
///   u32 n · u32 Schalter (1 = mit durPlain, 2 = mit A-Achse) · u32 Länge der Hinweise · u32 0
///   11 × f64: totalTime, cutLength, rapidLength, minX, minY, minZ, maxX, maxY, maxZ, cutMinZ, cutMaxZ
///   t0 (f64 × n) · x0 y0 z0 x1 y1 z1 dur [durPlain] [a0 a1] (je f32 × n) · line (u32 × n) · type (u8 × n)
///   Hinweise als JSON-Text
pub fn encode(p: &Program) -> Vec<u8> {
    let n = p.kind.len();
    let notes = serde_json::to_vec(&p.notes).unwrap_or_else(|_| b"[]".to_vec());
    let flags = (p.dur_plain.is_some() as u32) | ((p.a.is_some() as u32) << 1);
    let mut out = Vec::with_capacity(16 + 88 + n * (8 + 4 * 11 + 4 + 1) + notes.len());
    for v in [n as u32, flags, notes.len() as u32, 0] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    let b = p.bounds;
    for v in [p.total_time, p.cut_length, p.rapid_length, b[0], b[1], b[2], b[3], b[4], b[5], p.cut_min_z, p.cut_max_z] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for v in &p.t0 {
        out.extend_from_slice(&v.to_le_bytes());
    }
    let mut f32s = |v: &[f32]| v.iter().for_each(|x| out.extend_from_slice(&x.to_le_bytes()));
    for v in [&p.x0, &p.y0, &p.z0, &p.x1, &p.y1, &p.z1, &p.dur] {
        f32s(v);
    }
    if let Some(v) = &p.dur_plain {
        f32s(v);
    }
    if let Some((a0, a1)) = &p.a {
        f32s(a0);
        f32s(a1);
    }
    for v in &p.line {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&p.kind);
    out.extend_from_slice(&notes);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn lines(l: &[&str]) -> String {
        l.join("\n")
    }
    fn plain(l: &[&str]) -> Program {
        parse(&lines(l), &Options::default())
    }
    fn near(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() < tol, "{a} != {b}");
    }

    #[test]
    fn straight_move_time_and_kind() {
        let p = plain(&["G1 X100 F600"]);
        assert_eq!(p.kind, vec![MOVE_CUT]);
        near(p.total_time, 10.0, 1e-9);
        assert!(p.dur_plain.is_none());
    }

    #[test]
    fn tool_off_is_travel_and_rapid_is_rapid() {
        let p = plain(&["M3 S1000", "G0 X10", "G1 X20 F600", "M5", "G1 X30"]);
        assert_eq!(p.kind, vec![MOVE_RAPID, MOVE_CUT, MOVE_TRAVEL]);
        assert_eq!(p.line, vec![1, 2, 4]);
    }

    #[test]
    fn comments_and_numbers_like_typescript() {
        // nicht geschlossene Klammer = Rest ist Kommentar; "12." ist 12; Wort ohne Zahl zählt nicht
        let p = plain(&["G1 X12. Y-.5 (to here", "G1 X ; nothing", "G1X+3(a)Y1;Z9"]);
        assert_eq!(p.x1, vec![12.0, 3.0]);
        assert_eq!(p.y1, vec![-0.5, 1.0]);
    }

    #[test]
    fn semicolon_comment_stays_before_a_carriage_return() {
        // Eigenheit des TypeScript-Musters: mit \r am Zeilenende wird der ;-Kommentar nicht entfernt
        let mut b = Vec::new();
        strip_comments("G1 X1 ; X5\r", &mut b);
        assert_eq!(b.iter().collect::<String>(), "G1 X1 ; X5");
        strip_comments("G1 X1 ; X5", &mut b);
        assert_eq!(b.iter().collect::<String>(), "G1 X1");
    }

    #[test]
    fn spindle_and_a_axis_detection() {
        let c = |s: &str| s.chars().collect::<Vec<char>>();
        assert!(has_spindle_word(&c("M3")) && has_spindle_word(&c("m05 s0")));
        assert!(!has_spindle_word(&c("M30")) && !has_spindle_word(&c("M3S1000")) && !has_spindle_word(&c("G1X5M3")));
        assert!(has_a_word(&c("G1 A90")) && has_a_word(&c("G1 X1a-.5")));
        assert!(!has_a_word(&c("CALLA1")) && !has_a_word(&c("A")) && !has_a_word(&c("A X1")));
    }

    #[test]
    fn full_circle_is_divided_and_closed() {
        let p = plain(&["G0 X10 Y0", "G2 X10 Y0 I-10 J0 F600"]);
        let n = p.kind.len();
        assert!(n > 20);
        near(p.x1[n - 1] as f64, 10.0, 1e-6);
        near(p.cut_length, 2.0 * std::f64::consts::PI * 10.0, 0.05);
    }

    #[test]
    fn acceleration_ramp() {
        let lim = Limits { accel: vec![100.0, 100.0, 50.0], max_rate: vec![6000.0, 6000.0, 600.0], junction_dev: 0.01, arc_tol: None, lookahead: 1000.0 };
        let p = parse("G1 X1 F6000", &Options { motion: Some(lim), ..Default::default() });
        // 1 mm, a = 100: Spitze 10 mm/s, Zeit 2 × 0,1 s
        near(p.total_time, 0.2, 1e-9);
        assert!(p.dur_plain.is_some());
    }

    #[test]
    fn note_names() {
        assert_eq!(code_name('G', 54.1), "G54.1");
        assert_eq!(code_name('G', 28.0), "G28");
        assert_eq!(code_name('G', 0.25), "G0.3");
        let p = plain(&["G54", "G1 X1", "G55", "G65 P100", "#1 = 5"]);
        let kinds: Vec<&str> = p.notes.iter().map(|n| n.kind.as_str()).collect();
        assert_eq!(kinds, vec!["wcs", "sub", "expr"]);
    }

    #[test]
    fn encode_layout() {
        let p = plain(&["G1 X1 F600", "G1 A90"]);
        let b = encode(&p);
        let n = p.kind.len();
        assert_eq!(u32::from_le_bytes(b[0..4].try_into().unwrap()) as usize, n);
        assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()), 2);
        let notes = u32::from_le_bytes(b[8..12].try_into().unwrap()) as usize;
        assert_eq!(b.len(), 16 + 88 + n * (8 + 4 * 9 + 4 + 1) + notes);
    }

    // ---- Vergleich mit dem TypeScript: dieselben Fälle, Ergebnis aus tests/gcodeSimRust.test.ts ----

    fn arr(v: &Value) -> Vec<f64> {
        // null steht für „keine endliche Zahl“ (JSON kennt weder NaN noch Unendlich)
        v.as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect()).unwrap_or_default()
    }
    /// Ganze Zahlen genau; Kommazahlen: die f32 der Datei genau oder höchstens `ulps` Schritte daneben
    fn same_f32(name: &str, what: &str, got: &[f32], want: &[f64], ulps: i64, worst: &mut i64) {
        assert_eq!(got.len(), want.len(), "{name}: {what} count");
        for (i, (&g, &wv)) in got.iter().zip(want).enumerate() {
            let wv = wv as f32;
            if g.is_nan() && wv.is_nan() {
                continue;
            }
            let d = (g.to_bits() as i64 - wv.to_bits() as i64).abs();
            let d = if g == wv { 0 } else { d };
            *worst = (*worst).max(d);
            assert!(d <= ulps, "{name}: {what}[{i}] {g} != {wv}");
        }
    }
    fn same_f64(name: &str, what: &str, g: f64, wv: f64, rel: f64) {
        if g.is_nan() && wv.is_nan() {
            return;
        }
        assert!((g - wv).abs() <= rel * wv.abs().max(1.0), "{name}: {what} {g} != {wv}");
    }

    /// Antwort: größte Abweichung der Kommazahlen in f32-Schritten
    fn compare(name: &str, text: &str, opts: &Options, want: &Value) -> i64 {
        let p = parse(text, opts);
        let n = want["n"].as_u64().unwrap() as usize;
        assert_eq!(p.kind.len(), n, "{name}: number of moves");
        assert_eq!(p.kind.iter().map(|&k| k as f64).collect::<Vec<_>>(), arr(&want["type"]), "{name}: type");
        assert_eq!(p.line.iter().map(|&k| k as f64).collect::<Vec<_>>(), arr(&want["line"]), "{name}: line");
        let mut worst = 0;
        for (what, got) in [("x0", &p.x0), ("y0", &p.y0), ("z0", &p.z0), ("x1", &p.x1), ("y1", &p.y1), ("z1", &p.z1), ("dur", &p.dur)] {
            same_f32(name, what, got, &arr(&want[what]), 2, &mut worst);
        }
        assert_eq!(p.dur_plain.is_some(), !want["durPlain"].is_null(), "{name}: durPlain present");
        if let Some(d) = &p.dur_plain {
            same_f32(name, "durPlain", d, &arr(&want["durPlain"]), 2, &mut worst);
        }
        assert_eq!(p.a.is_some(), !want["a0"].is_null(), "{name}: A axis present");
        if let Some((a0, a1)) = &p.a {
            same_f32(name, "a0", a0, &arr(&want["a0"]), 2, &mut worst);
            same_f32(name, "a1", a1, &arr(&want["a1"]), 2, &mut worst);
        }
        let t0 = arr(&want["t0"]);
        for i in 0..n {
            same_f64(name, "t0", p.t0[i], t0[i], 1e-9);
        }
        same_f64(name, "totalTime", p.total_time, want["totalTime"].as_f64().unwrap_or(f64::NAN), 1e-9);
        same_f64(name, "cutLength", p.cut_length, want["cutLength"].as_f64().unwrap_or(f64::NAN), 1e-9);
        same_f64(name, "rapidLength", p.rapid_length, want["rapidLength"].as_f64().unwrap_or(f64::NAN), 1e-9);
        let b = arr(&want["bounds"]);
        for k in 0..6 {
            same_f64(name, "bounds", p.bounds[k], b[k], 1e-9);
        }
        same_f64(name, "cutMinZ", p.cut_min_z, want["cutMinZ"].as_f64().unwrap_or(f64::NAN), 1e-9);
        same_f64(name, "cutMaxZ", p.cut_max_z, want["cutMaxZ"].as_f64().unwrap_or(f64::NAN), 1e-9);
        let notes: Vec<Note> = serde_json::from_value(want["notes"].clone()).unwrap_or_default();
        assert_eq!(p.notes, notes, "{name}: notes");
        worst
    }

    fn fixture(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures").join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    #[test]
    fn same_result_as_typescript() {
        let cases: Value = serde_json::from_str(&fixture("gcodesim-cases.json")).unwrap();
        let expected: Value = serde_json::from_str(&fixture("gcodesim-expected.json")).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 20);
        let mut worst = 0;
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let text = match c["file"].as_str() {
                Some(f) => fixture(f),
                None => c["lines"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect::<Vec<_>>().join("\n"),
            };
            let opts: Options = serde_json::from_value(c["opts"].clone()).unwrap();
            let want = &expected[name];
            assert!(want.is_object(), "{name}: no expected result (run UPDATE_FIXTURES=1 npm test)");
            worst = worst.max(compare(name, &text, &opts, want));
        }
        println!("largest difference to TypeScript: {worst} f32 step(s)");
    }

    /// Die Bytes für das Fenster: tests/fixtures/gcodesim-sample.bin liest tests/gcodeSimRust.test.ts mit dem
    /// TypeScript-Leser zurück. Der Fall hat keine Bögen (nur Grundrechenarten und Wurzeln), darum auf jedem
    /// Rechner dieselben Bytes. Neu schreiben: UPDATE_FIXTURES=1 cargo test gcodesim
    #[test]
    fn encoded_sample_is_the_fixture() {
        let cases: Value = serde_json::from_str(&fixture("gcodesim-cases.json")).unwrap();
        let c = cases.as_array().unwrap().iter().find(|c| c["name"] == "byte layout sample").unwrap();
        let text = c["lines"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect::<Vec<_>>().join("\n");
        let opts: Options = serde_json::from_value(c["opts"].clone()).unwrap();
        let bytes = encode(&parse(&text, &opts));
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/gcodesim-sample.bin");
        if std::env::var("UPDATE_FIXTURES").is_ok() {
            std::fs::write(&path, &bytes).unwrap();
        }
        assert!(std::fs::read(&path).unwrap() == bytes, "gcodesim-sample.bin is not what encode() gives now");
    }

    /// Großer Vergleich mit eigenen Dateien (nicht im Repository). Erst schreibt das TypeScript sein Ergebnis daneben:
    /// GCODESIM_COMPARE=<Ordner mit *.gcode> node --test tests/gcodeSimRust.test.ts
    /// GCODESIM_COMPARE=<derselbe Ordner> cargo test --release gcodesim -- --ignored --nocapture
    #[test]
    #[ignore]
    fn same_result_as_typescript_on_local_files() {
        let dir = std::env::var("GCODESIM_COMPARE").expect("GCODESIM_COMPARE = folder");
        let mut count = 0;
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = e.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".expected.json")) else { continue };
            let want: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let text = std::fs::read_to_string(path.with_file_name(format!("{name}.gcode"))).unwrap();
            let opts: Options = serde_json::from_value(want["opts"].clone()).unwrap();
            let start = std::time::Instant::now();
            let n = parse(&text, &opts).kind.len();
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            let worst = compare(name, &text, &opts, &want);
            println!("{name}: {n} moves, {ms:.1} ms in Rust, largest difference {worst} f32 step(s)");
            count += 1;
        }
        assert!(count > 0, "no *.expected.json in {dir}");
    }
}
