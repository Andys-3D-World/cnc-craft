//! LANGE PLATTE WEITERSCHIEBEN – Zwilling von `src/longBoard.ts` (sections, checkLong, unsupported, cutBounds,
//! splitProgram, pinHits, holeLines).
//!
//! Ein Teil, länger als die Maschine, wird in Abschnitten gefräst; nach jedem Abschnitt wird die Platte um S geschoben,
//! Passstifte halten sie genau. Geteilt wird das fertige Programm: Abschnitt k bekommt alle Schnitte seines Fensters,
//! um k·S verschoben; an der Grenze hoch und im Nachbar-Abschnitt an derselben Stelle wieder eintauchen.
//! Folgt dem TypeScript Zeile für Zeile (auch die regulären Ausdrücke, von Hand); der Test vergleicht die Zeilen
//! Zeichen für Zeichen. Nur Vergleich: welche Datei die Maschine bekommt, bestimmt weiter das Fenster.
//! Gemeinsame Fälle: `tests/fixtures/longboard-cases.json.gz`.

use crate::gcodesim::{hypot2, js_space, mn, mx};
use crate::importdxf::parse_float;
use crate::jsmath::{self, js_num, js_round, to_fixed};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::f64::consts::PI;

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct XY {
    pub x: f64,
    pub y: f64,
}
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct P {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LongOpts {
    pub axis: String,
    pub bed: f64,
    pub start: f64,
    pub shift: f64,
    pub overlap: f64,
    pub pins: Vec<XY>,
    pub pin_d: f64,
}

/// ±Unendlich geht als null über JSON (wie JSON.stringify es schreibt)
fn de_lo<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NEG_INFINITY))
}
fn de_hi<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::INFINITY))
}
fn ser_inf<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    if v.is_finite() {
        s.serialize_f64(*v)
    } else {
        s.serialize_none()
    }
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Section {
    pub n: f64,
    #[serde(deserialize_with = "de_lo", serialize_with = "ser_inf")]
    pub lo: f64,
    #[serde(deserialize_with = "de_hi", serialize_with = "ser_inf")]
    pub hi: f64,
    pub shift: f64,
}

/// Fenster je Abschnitt in Zeichnungs-Koordinaten entlang der Achse; max = Ende der Fräsbahnen
pub fn sections(o: &LongOpts, max: f64) -> Vec<Section> {
    let mut out = vec![];
    if !(o.shift > 0.0) {
        return out;
    }
    for k in 0..200 {
        let kf = k as f64;
        let lo = o.start + kf * o.shift;
        let hi = lo + o.shift;
        let last = hi >= max - 1e-6;
        out.push(Section { n: kf + 1.0, lo: if k == 0 { f64::NEG_INFINITY } else { lo - o.overlap }, hi: if last { f64::INFINITY } else { hi + o.overlap }, shift: kf * o.shift });
        if last {
            break;
        }
    }
    out
}

/// Was nicht geht (Fehler) – vor dem Teilen prüfen
pub fn check_long(o: &LongOpts, min: f64, max: f64) -> Vec<&'static str> {
    let mut e = vec![];
    let a = |p: &XY| if o.axis == "x" { p.x } else { p.y };
    if !(o.shift >= 20.0) {
        e.push("shift");
    }
    if o.start - o.overlap < -1e-6 || o.start + o.shift + o.overlap > o.bed + 1e-6 {
        e.push("window");
    }
    if min < -1e-6 {
        e.push("minOut");
    }
    let s = sections(o, max);
    if let Some(l) = s.last() {
        if max - l.shift > o.bed + 1e-6 {
            e.push("lastOut");
        }
    }
    if o.pins.len() < 2 || o.pins.iter().any(|p| a(p) - o.pin_d / 2.0 < 0.0 || a(p) + o.pin_d / 2.0 > o.bed) {
        e.push("pinOut");
    }
    if o.pins.iter().any(|p| a(p) + o.shift + o.pin_d / 2.0 > o.bed) {
        e.push("holeOut");
    }
    if o.pins.len() >= 2 && hypot2(o.pins[0].x - o.pins[1].x, o.pins[0].y - o.pins[1].y) < o.pin_d * 2.0 {
        e.push("pinsSame");
    }
    e
}

// ---- kleine Nachbauten der regulären Ausdrücke ----

fn word_ch(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}
fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}
fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").trim()
fn strip(l: &str) -> String {
    let rc: Vec<char> = l.chars().collect();
    let mut t: Vec<char> = vec![];
    let mut i = 0;
    while i < rc.len() {
        if rc[i] == '(' {
            if let Some(p) = rc[i + 1..].iter().position(|&ch| ch == ')') {
                t.push(' ');
                i += p + 2;
                continue;
            }
        }
        t.push(rc[i]);
        i += 1;
    }
    let after = t.iter().rposition(|&c| line_end(c)).map_or(0, |p| p + 1);
    if let Some(p) = t[after..].iter().position(|&c| c == ';') {
        t.truncate(after + p);
    }
    js_trim(&t.iter().collect::<String>()).to_string()
}
fn up(s: &str) -> Vec<char> {
    s.to_uppercase().chars().collect()
}

/// Zahl `[-+]?(?:\d+\.?\d*|\.\d+)` ab k: Ende
fn number_at(c: &[char], k: usize) -> Option<usize> {
    let digits = |mut e: usize| {
        while e < c.len() && c[e].is_ascii_digit() {
            e += 1;
        }
        e
    };
    let plain = |k: usize| -> Option<usize> {
        if c.get(k).is_some_and(|ch| ch.is_ascii_digit()) {
            let e = digits(k);
            Some(if c.get(e) == Some(&'.') { digits(e + 1) } else { e })
        } else if c.get(k) == Some(&'.') && c.get(k + 1).is_some_and(|ch| ch.is_ascii_digit()) {
            Some(digits(k + 1))
        } else {
            None
        }
    };
    (if matches!(c.get(k), Some('-' | '+')) { plain(k + 1) } else { None }).or_else(|| plain(k))
}

/// /(?:^|[^A-Z])K\s*(Zahl)/i – erster Treffer
fn val(c: &[char], k: char) -> Option<f64> {
    for p in 0..c.len() {
        if c[p] != k || (p > 0 && c[p - 1].is_ascii_alphabetic()) {
            continue;
        }
        let mut j = p + 1;
        while j < c.len() && js_space(c[j]) {
            j += 1;
        }
        if let Some(e) = number_at(c, j) {
            return Some(parse_float(&c[j..e].iter().collect::<String>()));
        }
    }
    None
}

/// `\bL\s*0*(alt1|alt2…)\b` (Wortgrenzen nach Wunsch) – irgendwo im Text
fn mword(c: &[char], letter: char, b_before: bool, alts: &[&str], b_after: bool) -> bool {
    for p in 0..c.len() {
        if c[p] != letter || (b_before && p > 0 && word_ch(c[p - 1])) {
            continue;
        }
        let mut j = p + 1;
        while j < c.len() && js_space(c[j]) {
            j += 1;
        }
        let mut z = 0;
        while j + z < c.len() && c[j + z] == '0' {
            z += 1;
        }
        for k in (0..=z).rev() {
            let q = j + k;
            for alt in alts {
                let a: Vec<char> = alt.chars().collect();
                if c.len() >= q + a.len() && c[q..q + a.len()] == a[..] && (!b_after || c.get(q + a.len()).is_none_or(|&ch| !word_ch(ch))) {
                    return true;
                }
            }
        }
    }
    false
}
const DIGITS: [&str; 10] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/// Was der Teiler nicht kann (kommt in eigenen Fräsprogrammen nicht vor)
pub fn unsupported(lines: &[String]) -> Option<String> {
    const ALTS: [&str; 26] = ["20", "18", "19", "91", "92", "10", "28", "30", "38", "41", "42", "43", "53", "54", "55", "56", "57", "58", "59", "68", "73", "81", "82", "83", "84", "85"];
    const MORE: [&str; 4] = ["86", "87", "88", "89"];
    for l in lines {
        let c = up(&strip(l));
        for p in 0..c.len() {
            if c[p] != 'G' || (p > 0 && (c[p - 1].is_ascii_uppercase() || c[p - 1].is_ascii_digit())) {
                continue;
            }
            let mut j = p + 1;
            while j < c.len() && js_space(c[j]) {
                j += 1;
            }
            let mut z = 0;
            while j + z < c.len() && c[j + z] == '0' {
                z += 1;
            }
            for k in (0..=z).rev() {
                let q = j + k;
                for alt in ALTS.iter().chain(MORE.iter()) {
                    let a: Vec<char> = alt.chars().collect();
                    if c.len() >= q + 2 && c[q..q + 2] == a[..] && !c.get(q + 2).is_some_and(|ch| ch.is_ascii_digit()) {
                        return Some(format!("G{alt}"));
                    }
                }
            }
        }
        // /(?:^|\s)[AB]\s*[-+\d.]/
        for p in 0..c.len() {
            if !matches!(c[p], 'A' | 'B') || (p > 0 && !js_space(c[p - 1])) {
                continue;
            }
            let mut j = p + 1;
            while j < c.len() && js_space(c[j]) {
                j += 1;
            }
            if c.get(j).is_some_and(|&ch| ch == '-' || ch == '+' || ch == '.' || ch.is_ascii_digit()) {
                return Some("A/B".into());
            }
        }
    }
    None
}

#[derive(Clone, Debug)]
struct Move {
    g: u8,
    from: P,
    to: P,
    i: f64,
    j: f64,
    feed: f64,
    pts: Vec<P>,
}
enum Ev {
    Move(Move),
    Other(String, String),
}

fn arc_points(m: &Move) -> Vec<P> {
    let (cx, cy) = (m.from.x + m.i, m.from.y + m.j);
    let r = hypot2(m.i, m.j);
    let a0 = jsmath::atan2(m.from.y - cy, m.from.x - cx);
    let a1 = jsmath::atan2(m.to.y - cy, m.to.x - cx);
    let mut sw = a1 - a0;
    if m.g == 2 {
        while sw > -1e-9 {
            sw -= 2.0 * PI;
        }
        if sw < -2.0 * PI {
            sw += 2.0 * PI;
        }
    } else {
        while sw < 1e-9 {
            sw += 2.0 * PI;
        }
        if sw > 2.0 * PI {
            sw -= 2.0 * PI;
        }
    }
    if hypot2(m.to.x - m.from.x, m.to.y - m.from.y) < 1e-6 {
        sw = if m.g == 2 { -2.0 * PI } else { 2.0 * PI };
    }
    let step = mx(0.02, 2.0 * jsmath::acos(mx(0.0, 1.0 - mn(1.0, 0.005 / mx(r, 1e-6)))));
    let n = mx(2.0, mn(720.0, (sw.abs() / step).ceil()));
    let mut out = vec![m.from];
    let mut k = 1.0;
    while k < n {
        let a = a0 + sw * k / n;
        out.push(P { x: cx + r * jsmath::cos(a), y: cy + r * jsmath::sin(a), z: m.from.z + (m.to.z - m.from.z) * k / n });
        k += 1.0;
    }
    out.push(m.to);
    out
}

/// Programm durchgehen: Bewegungen (Bögen zusätzlich als Punkte) und andere Zeilen, in der Reihenfolge der Aufrufe
fn walk(lines: &[String]) -> Vec<Ev> {
    let mut ev = vec![];
    let (mut g, mut pos, mut feed) = (0u8, P { x: 0.0, y: 0.0, z: 0.0 }, 0.0);
    for line in lines {
        let s = strip(line).to_uppercase();
        let c: Vec<char> = s.chars().collect();
        if c.is_empty() {
            if !js_trim(line).is_empty() {
                ev.push(Ev::Other(line.clone(), String::new()));
            }
            continue;
        }
        if let Some(f) = val(&c, 'F') {
            feed = f;
        }
        // [...s.matchAll(/G\s*0*(\d+)(?![\d.])/g)]
        let mut gm: Vec<f64> = vec![];
        let mut i = 0;
        while i < c.len() {
            if c[i] == 'G' {
                let mut j = i + 1;
                while j < c.len() && js_space(c[j]) {
                    j += 1;
                }
                let mut e = j;
                while e < c.len() && c[e].is_ascii_digit() {
                    e += 1;
                }
                if e > j && c.get(e) != Some(&'.') {
                    gm.push(c[j..e].iter().collect::<String>().parse::<f64>().unwrap());
                    i = e;
                    continue;
                }
            }
            i += 1;
        }
        if let Some(&m) = gm.iter().filter(|&&x| x <= 3.0).last() {
            g = m as u8;
        }
        let (x, y, z) = (val(&c, 'X'), val(&c, 'Y'), val(&c, 'Z'));
        if gm.contains(&4.0) || (x.is_none() && y.is_none() && z.is_none()) {
            ev.push(Ev::Other(line.clone(), s.clone()));
            continue;
        }
        let to = P { x: x.unwrap_or(pos.x), y: y.unwrap_or(pos.y), z: z.unwrap_or(pos.z) };
        let mut m = Move { g, from: pos, to, i: val(&c, 'I').unwrap_or(0.0), j: val(&c, 'J').unwrap_or(0.0), feed, pts: vec![] };
        m.pts = if g >= 2 { arc_points(&m) } else { vec![pos, to] };
        if mword(&c, 'M', false, &["3", "4", "5", "6", "7", "8", "9"], true) {
            ev.push(Ev::Other(line.clone(), s.clone()));
        }
        ev.push(Ev::Move(m));
        pos = to;
    }
    ev
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Bounds {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    #[serde(rename = "minZ")]
    pub min_z: f64,
}

/// Ausdehnung der Schnitte entlang beider Achsen
pub fn cut_bounds(lines: &[String]) -> Option<Bounds> {
    let mut b: Option<Bounds> = None;
    for e in walk(lines) {
        let Ev::Move(m) = e else { continue };
        if m.g == 0 {
            continue;
        }
        for p in &m.pts {
            let q = b.get_or_insert(Bounds { x0: p.x, y0: p.y, x1: p.x, y1: p.y, min_z: p.z });
            q.x0 = mn(q.x0, p.x);
            q.x1 = mx(q.x1, p.x);
            q.y0 = mn(q.y0, p.y);
            q.y1 = mx(q.y1, p.y);
            q.min_z = mn(q.min_z, p.z);
        }
    }
    b
}

const EPS: f64 = 1e-4;
fn f3(v: f64) -> String {
    to_fixed(if v.abs() < 5e-4 { 0.0 } else { v }, 3)
}
fn f3feed(v: f64) -> String {
    js_num(js_round(v * 100.0) / 100.0)
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct BoxR {
    pub min: f64,
    pub max: f64,
}
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SplitProgram {
    pub lines: Vec<String>,
    pub cuts: u32,
    pub entries: u32,
    pub first_tool: String,
    #[serde(rename = "box")]
    pub bbox: Option<BoxR>,
    pub trace: Vec<P>,
}

/// Anteil [t0, t1] der Strecke a→b, der zwischen lo und hi liegt
fn span(a: f64, b: f64, lo: f64, hi: f64) -> Option<(f64, f64)> {
    if (b - a).abs() < 1e-12 {
        return if a >= lo - EPS && a <= hi + EPS { Some((0.0, 1.0)) } else { None };
    }
    let (t0, t1) = ((lo - a) / (b - a), (hi - a) / (b - a));
    let s = mx(0.0, mn(t0, t1));
    let e = mn(1.0, mx(t0, t1));
    if e - s > 1e-9 {
        Some((s, e))
    } else {
        None
    }
}

struct Split<'a> {
    x_axis: bool,
    sec: &'a Section,
    safe_z: f64,
    tool_prefix: &'a str,
    keep_m6: bool,
    out: SplitProgram,
    at: Option<P>,
    up: bool,
    feed_out: f64,
    plunge: f64,
    touched: bool,
    group: Vec<String>,
    tool_block: Vec<String>,
    spin_block: Vec<String>,
}

fn has_m(l: &str) -> bool {
    mword(&up(&strip(l)), 'M', true, &DIGITS, false)
}

impl Split<'_> {
    fn a(&self, p: &P) -> f64 {
        if self.x_axis {
            p.x
        } else {
            p.y
        }
    }
    fn inside(&self, p: &P) -> bool {
        let a = self.a(p);
        a >= self.sec.lo - EPS && a <= self.sec.hi + EPS
    }
    fn sx(&self, p: &P) -> String {
        f3(if self.x_axis { p.x - self.sec.shift } else { p.x })
    }
    fn sy(&self, p: &P) -> String {
        f3(if !self.x_axis { p.y - self.sec.shift } else { p.y })
    }
    fn close_group(&mut self) {
        if self.group.is_empty() {
            return;
        }
        let code: Vec<char> = self.group.iter().map(|l| strip(l).to_uppercase()).collect::<Vec<_>>().join("\n").chars().collect();
        if mword(&code, 'M', true, &["0", "1", "6"], true) {
            self.tool_block = self.group.clone();
            self.spin_block = vec![];
        } else if mword(&code, 'M', true, &DIGITS, false) {
            if !self.tool_block.is_empty() {
                let g = self.group.clone();
                self.tool_block.extend(g);
            } else {
                self.spin_block = self.group.clone();
            }
        }
        self.group = vec![];
    }
    fn raise(&mut self) {
        if !self.up {
            self.out.lines.push(format!("G0 Z{}", f3(self.safe_z)));
            self.up = true;
        }
    }
    fn flush(&mut self) {
        self.close_group();
        let b: Vec<String> = self.tool_block.iter().chain(self.spin_block.iter()).cloned().collect();
        if b.is_empty() {
            return;
        }
        self.raise();
        self.at = None;
        let ti = b.iter().position(|l| js_trim(l).starts_with(&format!("({}", self.tool_prefix)));
        let m6 = if self.keep_m6 { b.iter().position(|l| mword(&up(&strip(l)), 'M', true, &["6"], true)) } else { None };
        let use_: Vec<String> = if self.touched {
            b.clone()
        } else {
            let from = match (m6, ti) {
                (Some(m), Some(t)) if m < t => m,
                (_, Some(t)) => t,
                _ => 0,
            };
            b[from..]
                .iter()
                .filter(|l| {
                    let c = up(&strip(l));
                    let ms: &[&str] = if self.keep_m6 { &["0", "1", "5"] } else { &["0", "1", "5", "6"] };
                    !(mword(&c, 'M', true, ms, true) || mword(&c, 'G', true, &["17", "21", "90"], true))
                })
                .cloned()
                .collect()
        };
        if !self.touched {
            if let Some(t) = ti {
                let s: Vec<char> = js_trim(&b[t]).chars().collect();
                self.out.first_tool = if s.len() >= 2 { s[1..s.len() - 1].iter().collect() } else { String::new() };
            }
        }
        self.out.lines.extend(use_);
        self.tool_block = vec![];
        self.spin_block = vec![];
        self.feed_out = -1.0;
    }
    fn reach(&mut self, p: P) {
        self.flush();
        if let Some(at) = self.at {
            if (at.x - p.x).abs() < EPS && (at.y - p.y).abs() < EPS && (at.z - p.z).abs() < EPS {
                return;
            }
        }
        self.raise();
        let l = format!("G0 X{} Y{}", self.sx(&p), self.sy(&p));
        self.out.lines.push(l);
        if p.z < self.safe_z - EPS {
            let l = format!("G1 Z{} F{}", f3(p.z), f3feed(self.plunge));
            self.out.lines.push(l);
            self.up = false;
            self.feed_out = self.plunge;
        }
        self.at = Some(p);
        self.out.entries += 1;
    }
    fn note(&mut self, p: &P) {
        let a = self.a(p) - self.sec.shift;
        self.out.bbox = Some(match &self.out.bbox {
            Some(b) => BoxR { min: mn(b.min, a), max: mx(b.max, a) },
            None => BoxR { min: a, max: a },
        });
        let t = P { x: if self.x_axis { p.x - self.sec.shift } else { p.x }, y: if !self.x_axis { p.y - self.sec.shift } else { p.y }, z: p.z };
        self.out.trace.push(t);
    }
    fn cut_to(&mut self, p: P, feed: f64, from: P) {
        let mut w: Vec<String> = vec![];
        if (p.x - from.x).abs() >= 5e-5 || (p.y - from.y).abs() >= 5e-5 {
            w.push(format!("X{}", self.sx(&p)));
            w.push(format!("Y{}", self.sy(&p)));
        }
        if (p.z - from.z).abs() >= 5e-5 {
            w.push(format!("Z{}", f3(p.z)));
        }
        if w.is_empty() {
            return;
        }
        let fw = if feed > 0.0 && feed != self.feed_out { format!(" F{}", f3feed(feed)) } else { String::new() };
        self.out.lines.push(format!("G1 {}{fw}", w.join(" ")));
        if feed > 0.0 {
            self.feed_out = feed;
        }
        self.at = Some(p);
        self.up = p.z >= self.safe_z - EPS;
        self.out.cuts += 1;
        self.touched = true;
        self.note(&from);
        self.note(&p);
    }
    fn close_group_if_move(&mut self) {
        if self.group.iter().any(|l| has_m(l)) {
            self.close_group();
        } else if self.tool_block.is_empty() {
            self.group = vec![];
        }
    }
    /// wie reach, aber ein senkrechter Eintauch-Befehl an einer neuen Stelle fährt gleich von oben
    fn reach2(&mut self, p: P, flat: bool, m: &mut Move) {
        let away = match self.at {
            None => true,
            Some(at) => (at.x - p.x).abs() > EPS || (at.y - p.y).abs() > EPS || (at.z - p.z).abs() > EPS,
        };
        if flat && m.to.z < m.from.z && away {
            self.flush();
            self.raise();
            let l = format!("G0 X{} Y{}", self.sx(&p), self.sy(&p));
            self.out.lines.push(l);
            let at = P { x: p.x, y: p.y, z: self.safe_z };
            self.at = Some(at);
            m.from = at;
            return;
        }
        self.reach(p);
    }
    fn on_move(&mut self, mut m: Move) {
        if m.g == 0 {
            self.close_group_if_move();
            let synced = self.at.is_some_and(|at| (at.x - m.from.x).abs() < EPS && (at.y - m.from.y).abs() < EPS && (at.z - m.from.z).abs() < EPS);
            let pend = self.tool_block.len() + self.spin_block.len() + self.group.len() > 0;
            if synced && !pend && self.inside(&m.to) {
                let mut w: Vec<String> = vec![];
                if (m.to.x - m.from.x).abs() >= 5e-5 || (m.to.y - m.from.y).abs() >= 5e-5 {
                    w.push(format!("X{}", self.sx(&m.to)));
                    w.push(format!("Y{}", self.sy(&m.to)));
                }
                if (m.to.z - m.from.z).abs() >= 5e-5 {
                    w.push(format!("Z{}", f3(m.to.z)));
                }
                if !w.is_empty() {
                    self.out.lines.push(format!("G0 {}", w.join(" ")));
                }
                self.at = Some(m.to);
                self.up = m.to.z >= self.safe_z - EPS;
            } else if !pend && self.inside(&m.to) && m.to.z > 0.0 && ((m.to.x - m.from.x).abs() > EPS || (m.to.y - m.from.y).abs() > EPS) {
                self.raise();
                let l = format!("G0 X{} Y{}", self.sx(&m.to), self.sy(&m.to));
                self.out.lines.push(l);
                if m.to.z < self.safe_z - EPS {
                    self.out.lines.push(format!("G0 Z{}", f3(m.to.z)));
                    self.up = false;
                }
                self.at = Some(m.to);
            } else if synced && !pend {
                self.raise();
                self.at = None;
            }
            return;
        }
        let flat = (m.to.x - m.from.x).abs() < EPS && (m.to.y - m.from.y).abs() < EPS && m.g == 1;
        if flat && m.feed > 0.0 && m.to.z < m.from.z {
            self.plunge = m.feed;
        }
        let all_in = m.pts.iter().all(|p| self.inside(p));
        let any_span = (1..m.pts.len()).any(|i| span(self.a(&m.pts[i - 1]), self.a(&m.pts[i]), self.sec.lo, self.sec.hi).is_some());
        if !all_in && !any_span {
            if self.at.is_some() {
                self.raise();
                self.at = None;
            }
            return;
        }
        if all_in {
            let from = m.from;
            self.reach2(from, flat, &mut m);
            if m.g == 1 {
                self.cut_to(m.to, m.feed, m.from);
            } else {
                let z = if (m.to.z - m.from.z).abs() >= 5e-5 { format!(" Z{}", f3(m.to.z)) } else { String::new() };
                let fw = if m.feed > 0.0 && m.feed != self.feed_out { format!(" F{}", f3feed(m.feed)) } else { String::new() };
                let l = format!("G{} X{} Y{}{z} I{} J{}{fw}", m.g, self.sx(&m.to), self.sy(&m.to), f3(m.i), f3(m.j));
                self.out.lines.push(l);
                if m.feed > 0.0 {
                    self.feed_out = m.feed;
                }
                self.at = Some(m.to);
                self.up = false;
                self.out.cuts += 1;
                self.touched = true;
                for k in 1..m.pts.len() {
                    let (a, b) = (m.pts[k - 1], m.pts[k]);
                    self.note(&a);
                    self.note(&b);
                }
            }
            return;
        }
        // an der Grenze: Stück für Stück, nur was innen liegt
        for k in 1..m.pts.len() {
            let (a, b) = (m.pts[k - 1], m.pts[k]);
            let Some(s) = span(self.a(&a), self.a(&b), self.sec.lo, self.sec.hi) else {
                if self.at.is_some() {
                    self.raise();
                    self.at = None;
                }
                continue;
            };
            let lerp = |t: f64| P { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
            let p0 = if s.0 <= 0.0 { a } else { lerp(s.0) };
            let p1 = if s.1 >= 1.0 { b } else { lerp(s.1) };
            self.reach(p0);
            self.cut_to(p1, m.feed, p0);
            if s.1 < 1.0 {
                self.raise();
                self.at = None;
            }
        }
    }
    fn on_other(&mut self, line: String, code: &str) {
        let c: Vec<char> = code.chars().collect();
        if mword(&c, 'M', true, &["2", "30"], true) {
            return;
        }
        // /^F[\d.]+$/
        if c.len() > 1 && c[0] == 'F' && c[1..].iter().all(|&ch| ch.is_ascii_digit() || ch == '.') {
            return;
        }
        self.group.push(line.clone());
        if code.is_empty() && self.group.len() > 1 && !self.group.iter().any(|l| has_m(l)) {
            self.group = vec![line];
        }
    }
}

/// Programm eines Abschnitts: nur die Schnitte zwischen lo und hi, um shift verschoben
pub fn split_program(lines: &[String], axis: &str, sec: &Section, safe_z: f64, tool_prefix: &str, keep_m6: bool) -> SplitProgram {
    let mut s = Split {
        x_axis: axis == "x",
        sec,
        safe_z,
        tool_prefix,
        keep_m6,
        out: SplitProgram { lines: vec![], cuts: 0, entries: 0, first_tool: String::new(), bbox: None, trace: vec![] },
        at: None,
        up: true,
        feed_out: -1.0,
        plunge: 300.0,
        touched: false,
        group: vec![],
        tool_block: vec![],
        spin_block: vec![],
    };
    for e in walk(lines) {
        match e {
            Ev::Move(m) => s.on_move(m),
            Ev::Other(line, code) => s.on_other(line, &code),
        }
    }
    s.raise();
    s.out
}

/// Wo dürfen die Stifte nicht stehen: kommt ein Schnitt näher als keep?
pub fn pin_hits(trace: &[P], pins: &[XY], keep: f64) -> Vec<usize> {
    let mut out = vec![];
    for (i, p) in pins.iter().enumerate() {
        let mut k = 1;
        while k < trace.len() {
            let (a, b) = (trace[k - 1], trace[k]);
            k += 2;
            if mn(a.z, b.z) >= 0.0 {
                continue;
            }
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let l2 = dx * dx + dy * dy;
            let t = if l2 > 0.0 { mx(0.0, mn(1.0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) } else { 0.0 };
            if hypot2(a.x + dx * t - p.x, a.y + dy * t - p.y) < keep {
                out.push(i);
                break;
            }
        }
    }
    out
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HoleTool {
    pub drill: bool,
    pub diameter: f64,
    pub feed: f64,
    pub plunge: f64,
    pub step_z: f64,
}

/// Löcher (Mitte, Ø) bohren oder mit einem kleineren Fräser in Schraubenlinie fräsen
pub fn hole_lines(holes: &[XY], d: f64, depth: f64, tl: &HoleTool, safe_z: f64) -> Vec<String> {
    let mut out = vec![];
    let round = |v: f64| js_num(js_round(v));
    for h in holes {
        let r = (d - tl.diameter) / 2.0;
        let step = mx(0.1, tl.step_z);
        out.push(format!("G0 Z{}", f3(safe_z)));
        if tl.drill || r < 0.05 {
            out.push(format!("G0 X{} Y{}", f3(h.x), f3(h.y)));
            out.push("G0 Z0.500".into());
            let mut z = 0.0;
            while z > -depth + 1e-6 {
                let n = mx(-depth, z - step);
                if z < 0.0 {
                    out.push("G0 Z0.500".into());
                    out.push(format!("G0 Z{}", f3(z + 0.3)));
                }
                out.push(format!("G1 Z{} F{}", f3(n), round(tl.plunge)));
                z = n;
            }
        } else {
            let pitch = mx(0.05, mn(step, 2.0 * PI * r * jsmath::tan(3.0 * PI / 180.0)));
            let n = (depth / pitch).ceil();
            out.push(format!("G0 X{} Y{}", f3(h.x + r), f3(h.y)));
            out.push("G0 Z0.500".into());
            out.push(format!("G1 Z0.000 F{}", round(tl.plunge)));
            let mut k = 1.0;
            while k <= n {
                let fw = if k == 1.0 { format!(" F{}", round(tl.feed)) } else { String::new() };
                out.push(format!("G3 X{} Y{} Z{} I{} J0.000{fw}", f3(h.x + r), f3(h.y), f3(-depth * k / n), f3(-r)));
                k += 1.0;
            }
            out.push(format!("G3 X{} Y{} I{} J0.000", f3(h.x + r), f3(h.y), f3(-r)));
            out.push(format!("G1 X{} Y{}", f3(h.x), f3(h.y)));
        }
        out.push(format!("G0 Z{}", f3(safe_z)));
    }
    out
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub text: String,
    pub opts: LongOpts,
    pub min: f64,
    pub max: f64,
    pub safe_z: f64,
    pub tool_prefix: String,
    pub keep_m6: bool,
    pub keep: f64,
    pub holes: Vec<XY>,
    pub hole_tool: HoleTool,
    pub hole_depth: f64,
}

/// Alles, was der Dialog rechnet, in einem Zug (wie die Fälle im Test)
pub fn run(job: &Job) -> serde_json::Value {
    let lines: Vec<String> = job.text.split('\n').map(String::from).collect();
    let o = &job.opts;
    let errs = check_long(o, job.min, job.max);
    let secs = if errs.contains(&"shift") { vec![] } else { sections(o, job.max) };
    let parts: Vec<SplitProgram> = secs.iter().map(|s| split_program(&lines, &o.axis, s, job.safe_z, &job.tool_prefix, job.keep_m6)).collect();
    let hits: Vec<serde_json::Value> = parts.iter().map(|p| serde_json::json!({ "pins": pin_hits(&p.trace, &o.pins, job.keep), "holes": pin_hits(&p.trace, &job.holes, job.keep) })).collect();
    serde_json::json!({
        "bad": unsupported(&lines), "bounds": cut_bounds(&lines), "errs": errs, "secs": secs, "parts": parts, "hits": hits,
        "holeLines": hole_lines(&job.holes, o.pin_d, job.hole_depth, &job.hole_tool, job.safe_z),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Read;

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
    fn small_pieces() {
        let c: Vec<char> = "G1X5 MAX7 Y-.5".chars().collect();
        assert_eq!((val(&c, 'X'), val(&c, 'Y'), val(&c, 'Z')), (Some(5.0), Some(-0.5), None));
        assert!(mword(&"M03".chars().collect::<Vec<_>>(), 'M', true, &["3"], true) && !mword(&"M30".chars().collect::<Vec<_>>(), 'M', true, &["3"], true));
        assert_eq!(unsupported(&["G0 X1".into(), "G091 G0 X5".into()]), Some("G91".into()));
        assert_eq!(unsupported(&["G38.2 Z-5".into()]), Some("G38".into()));
        assert_eq!(span(0.0, 10.0, f64::NEG_INFINITY, 5.0), Some((0.0, 0.5)));
    }

    #[test]
    fn same_result_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("longboard-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let cases: Value = serde_json::from_str(&text).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 30, "only {} cases", cases.len());
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let job: Job = serde_json::from_value(c["job"].clone()).unwrap();
            let got = run(&job);
            // erst die Zeilen, damit ein Unterschied lesbar gemeldet wird
            for (k, (g, w)) in got["parts"].as_array().unwrap().iter().zip(c["want"]["parts"].as_array().unwrap()).enumerate() {
                let (gl, wl) = (g["lines"].as_array().unwrap(), w["lines"].as_array().unwrap());
                if let Some(i) = gl.iter().zip(wl).position(|(a, b)| a != b) {
                    panic!("{name}: section {}: line {}: {} vs {}", k + 1, i + 1, gl[i], wl[i]);
                }
            }
            same(&got, &c["want"], name);
        }
        println!("{} long-board jobs split the same as longBoard.ts", cases.len());
    }
}
