//! ZWEISEITIG FRÄSEN – Zwilling der Rechnung in `src/twoSided.ts` (cleanSetup, flipLine, mirrorPoint, defaultPins,
//! pinIssues, pinCut, depthIssues, otherSideDepth, throughDepth).
//!
//! Eine Seite fräsen, das Material umdrehen, die andere Seite fräsen; Passstifte in der Opferplatte richten beide Seiten
//! aus. Hier: wo ein Punkt nach dem Umdrehen liegt, wo Stifte sinnvoll sind und was an ihnen nicht passt, und was beide
//! Seiten zusammen mit der Tiefe anrichten (Teil lose, Stege zu dünn, Loch, zu dünne Wand). Folgt dem TypeScript Zeile
//! für Zeile. Nur Vergleich: was gefräst wird und welche Warnungen kommen, bestimmt weiter das Fenster.
//! Gemeinsame Fälle: `tests/fixtures/twosided-cases.json.gz`.

use crate::gcodesim::{hypot2, js_space, mn, mx};
use crate::jsmath::js_num;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct StockRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub on: bool,
    pub flip: String,
    pub stock: StockRect,
    pub thickness: f64,
    pub z_ref: String,
    pub pins_on: bool,
    pub pin_dia: f64,
    pub pin_depth: f64,
    pub pins: Vec<Pt>,
    pub pins_auto: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_tool_id: Option<String>,
}

pub const MAX_PINS: usize = 12;

// ---- JavaScript Number(v) ----

/// StringToNumber: Leerraum außen weg, leer = 0, Infinity, 0x/0o/0b, sonst eine ganze Dezimalzahl – sonst NaN
fn string_to_number(s: &str) -> f64 {
    let t = s.trim_matches(js_space);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let b = t.as_bytes();
    if b.len() > 2 && b[0] == b'0' {
        let radix = match b[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix > 0 {
            let mut v = 0.0f64;
            for &c in &b[2..] {
                match (c as char).to_digit(radix) {
                    Some(d) => v = v * radix as f64 + d as f64,
                    None => return f64::NAN,
                }
            }
            return v;
        }
    }
    // [+-] (Ziffern [. Ziffern] | . Ziffern) [e [+-] Ziffern]
    let mut i = 0;
    if matches!(b.first(), Some(b'+' | b'-')) {
        i = 1;
    }
    let d0 = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - d0;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let f0 = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - f0;
    }
    if int_digits + frac_digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let e0 = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == e0 {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// String(v) für die Teile eines Felds (Array.prototype.join)
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_num(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// Number(v); None (fehlendes Feld) = undefined = NaN
pub fn js_to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(a @ Value::Array(_)) => string_to_number(&js_string(a)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// JavaScript-Wahrheit eines Werts (für `p && …` und `raw.stock || {}`)
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}

/// Number(v) in [lo, hi], sonst (nicht endlich) d
fn num(v: Option<&Value>, d: f64, lo: f64, hi: f64) -> f64 {
    let n = js_to_number(v);
    if n.is_finite() {
        mn(hi, mx(lo, n))
    } else {
        d
    }
}

/// Einrichtung aus einer Projektdatei: nur bekannte Felder, Zahlen in vernünftigen Grenzen (None = keine)
pub fn clean_setup(raw: &Value) -> Option<Setup> {
    if !truthy(Some(raw)) || !(raw.is_object() || raw.is_array()) {
        return None;
    }
    let get = |k: &str| raw.as_object().and_then(|o| o.get(k));
    let st = get("stock").filter(|v| truthy(Some(v)));
    let sg = |k: &str| st.and_then(|s| s.as_object()).and_then(|o| o.get(k));
    let pins = match get("pins").and_then(|v| v.as_array()) {
        Some(list) => list
            .iter()
            .filter(|p| truthy(Some(p)))
            .filter(|p| {
                let o = p.as_object();
                js_to_number(o.and_then(|o| o.get("x"))).is_finite() && js_to_number(o.and_then(|o| o.get("y"))).is_finite()
            })
            .take(MAX_PINS)
            .map(|p| {
                let o = p.as_object();
                Pt { x: js_to_number(o.and_then(|o| o.get("x"))), y: js_to_number(o.and_then(|o| o.get("y"))) }
            })
            .collect(),
        None => vec![],
    };
    Some(Setup {
        on: get("on") == Some(&Value::Bool(true)),
        flip: if get("flip").and_then(|v| v.as_str()) == Some("fb") { "fb".into() } else { "lr".into() },
        stock: StockRect { x: num(sg("x"), 20.0, -1e5, 1e5), y: num(sg("y"), 20.0, -1e5, 1e5), w: num(sg("w"), 200.0, 1.0, 1e5), h: num(sg("h"), 150.0, 1.0, 1e5) },
        thickness: num(get("thickness"), 18.0, 0.1, 500.0),
        z_ref: if get("zRef").and_then(|v| v.as_str()) == Some("top") { "top".into() } else { "spoil".into() },
        pins_on: get("pinsOn") != Some(&Value::Bool(false)),
        pin_dia: num(get("pinDia"), 6.0, 0.5, 50.0),
        pin_depth: num(get("pinDepth"), 8.0, 0.0, 100.0),
        pins,
        pins_auto: get("pinsAuto") == Some(&Value::Bool(true)),
        pin_tool_id: get("pinToolId").and_then(|v| v.as_str()).map(|s| s.chars().take(80).collect()),
    })
}

/// Die Linie, um die gedreht wird: "lr" → x = at (läuft entlang Y), "fb" → y = at (läuft entlang X)
pub fn flip_line(flip: &str, st: &StockRect) -> (bool, f64) {
    if flip == "lr" {
        (true, st.x + st.w / 2.0)
    } else {
        (false, st.y + st.h / 2.0)
    }
}

/// Wo ein Punkt des Teils nach dem Umdrehen liegt
pub fn mirror_point(p: Pt, s: &Setup) -> Pt {
    let (along_y, at) = flip_line(&s.flip, &s.stock);
    if along_y {
        Pt { x: 2.0 * at - p.x, y: p.y }
    } else {
        Pt { x: p.x, y: 2.0 * at - p.y }
    }
}

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BoxR {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

pub fn pin_margin(dia: f64) -> f64 {
    mx(8.0, dia * 1.5)
}

/// Zwei Stifte auf der Drehlinie; liegt einer in einem Teil, vier in den Ecken (zwei gespiegelte Paare)
pub fn default_pins(s: &Setup, parts: &[BoxR]) -> Vec<Pt> {
    let StockRect { x, y, w, h } = s.stock;
    let m = mn(mn(pin_margin(s.pin_dia), w / 2.0), h / 2.0);
    let (along_y, at) = flip_line(&s.flip, &s.stock);
    let on_line = if along_y { vec![Pt { x: at, y: y + m }, Pt { x: at, y: y + h - m }] } else { vec![Pt { x: x + m, y: at }, Pt { x: x + w - m, y: at }] };
    let r = s.pin_dia / 2.0 + 1.0;
    let hit = |p: &Pt| parts.iter().any(|b| p.x + r > b.min_x && p.x - r < b.max_x && p.y + r > b.min_y && p.y - r < b.max_y);
    if !on_line.iter().any(hit) {
        return on_line;
    }
    let corners = vec![Pt { x: x + m, y: y + m }, Pt { x: x + w - m, y: y + m }, Pt { x: x + w - m, y: y + h - m }, Pt { x: x + m, y: y + h - m }];
    if corners.iter().any(hit) {
        on_line
    } else {
        corners
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct Obstacle {
    pub pts: Vec<Pt>,
    pub closed: bool,
    pub grow: f64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct PinIssue {
    pub code: String,
    pub pin: usize,
}

fn seg_dist(p: Pt, a: Pt, b: Pt) -> f64 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let l2 = dx * dx + dy * dy;
    let f = if l2 > 1e-18 { mx(0.0, mn(1.0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) } else { 0.0 };
    hypot2(a.x + dx * f - p.x, a.y + dy * f - p.y)
}
fn path_dist(p: Pt, pts: &[Pt], closed: bool) -> f64 {
    let mut d = f64::INFINITY;
    let n = pts.len();
    if n == 1 {
        return hypot2(pts[0].x - p.x, pts[0].y - p.y);
    }
    let count = if closed { n } else { n.saturating_sub(1) };
    for i in 0..count {
        d = mn(d, seg_dist(p, pts[i], pts[(i + 1) % n]));
    }
    d
}
fn inside(p: Pt, poly: &[Pt]) -> bool {
    let mut c = false;
    let n = poly.len();
    if n == 0 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a.y > p.y) != (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x {
            c = !c;
        }
        j = i;
    }
    c
}

pub const PIN_SYM_TOL: f64 = 0.01;

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Bed {
    pub w: f64,
    pub h: f64,
}

pub fn pin_issues(s: &Setup, obstacles: &[Obstacle], bed: Option<Bed>) -> Vec<PinIssue> {
    let mut out = vec![];
    if !s.pins_on {
        return out;
    }
    let pins = &s.pins;
    let r = s.pin_dia / 2.0;
    let issue = |code: &str, pin: usize| PinIssue { code: code.into(), pin };
    if pins.len() < 2 {
        out.push(issue("few", 0));
    }
    for (i, &p) in pins.iter().enumerate() {
        let n = i + 1;
        let m = mirror_point(p, s);
        if !pins.iter().any(|q| hypot2(q.x - m.x, q.y - m.y) <= PIN_SYM_TOL) {
            out.push(issue("asym", n));
        }
        let st = s.stock;
        if p.x - r < st.x - 1e-9 || p.x + r > st.x + st.w + 1e-9 || p.y - r < st.y - 1e-9 || p.y + r > st.y + st.h + 1e-9 {
            out.push(issue("offStock", n));
        }
        if let Some(bed) = bed {
            if p.x - r < 0.0 || p.x + r > bed.w || p.y - r < 0.0 || p.y + r > bed.h {
                out.push(issue("offBed", n));
            }
        }
        let spots = [p, m];
        if obstacles.iter().any(|o| spots.iter().any(|&q| (o.closed && o.pts.len() >= 3 && inside(q, &o.pts)) || path_dist(q, &o.pts, o.closed) < r + o.grow)) {
            out.push(issue("inPart", n));
        }
    }
    if pins.len() >= 2 {
        let mut far = 0.0f64;
        for a in pins {
            for b in pins {
                far = mx(far, hypot2(a.x - b.x, a.y - b.y));
            }
        }
        if far < mx(20.0, 4.0 * s.pin_dia) {
            out.push(issue("close", 0));
        }
    }
    out
}

/// Wie das Stiftloch mit einem Werkzeug entsteht: gebohrt, als Kreis gefräst, als Tasche, oder gar nicht
pub fn pin_cut(pin_dia: f64, tool_dia: f64, tool_is_drill: bool) -> &'static str {
    if (tool_dia - pin_dia).abs() <= 0.05 {
        return "drill";
    }
    if tool_dia > pin_dia || tool_is_drill {
        return "tooBig";
    }
    if pin_dia > 2.0 * tool_dia + 0.01 {
        "pocket"
    } else {
        "inside"
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    pub side: String,
    pub n: f64,
    pub kind: String,
    pub pts: Vec<Pt>,
    pub closed: bool,
    pub depth: f64,
    pub width: f64,
    pub outline: bool,
    pub tab_h: f64,
    #[serde(default)]
    pub skin: Option<f64>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct DepthIssue {
    pub code: String,
    pub front: f64,
    pub back: f64,
    pub left: f64,
}

pub const MIN_WEB: f64 = 0.5;
pub const MIN_TAB: f64 = 0.3;

fn sample(pts: &[Pt], closed: bool, step: f64) -> Vec<Pt> {
    let mut out = vec![];
    let n = pts.len();
    let count = if closed { n } else { n.saturating_sub(1) };
    for i in 0..count {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        let k = mx(1.0, (hypot2(b.x - a.x, b.y - a.y) / step).ceil());
        let mut j = 0.0;
        while j < k {
            out.push(Pt { x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k });
            j += 1.0;
        }
    }
    if !closed && n > 0 {
        out.push(pts[n - 1]);
    }
    out
}
fn reach(r: &Removal) -> f64 {
    if r.kind == "groove" {
        r.width / 2.0
    } else {
        0.0
    }
}
fn removes(r: &Removal, p: Pt, extra: f64) -> bool {
    if r.kind == "area" {
        return (r.pts.len() >= 3 && inside(p, &r.pts)) || path_dist(p, &r.pts, true) <= extra + 1e-6;
    }
    path_dist(p, &r.pts, r.closed) <= r.width / 2.0 + extra + 1e-6
}
/// Anteil (0…1) der eigenen Linie von a, den b auch wegnimmt
fn shared_share(a: &Removal, b: &Removal) -> f64 {
    // (a.width || 2)
    let wd = if a.width != 0.0 && !a.width.is_nan() { a.width } else { 2.0 };
    let pts = sample(&a.pts, if a.kind == "area" { true } else { a.closed }, mx(0.5, mn(2.0, wd / 2.0)));
    if pts.is_empty() {
        return 0.0;
    }
    pts.iter().filter(|&&p| removes(b, p, reach(a))).count() as f64 / pts.len() as f64
}

/// Was Vorder- und Rückseite zusammen anrichten (T = Materialdicke)
pub fn depth_issues(list: &[Removal], t: f64) -> Vec<DepthIssue> {
    let mut out = vec![];
    let fronts: Vec<&Removal> = list.iter().filter(|r| r.side == "front").collect();
    let backs: Vec<&Removal> = list.iter().filter(|r| r.side == "back").collect();
    const EPS: f64 = 1e-6;
    let tab = |r: &Removal| r.tab_h > 0.0;
    let issue = |code: &str, front: f64, back: f64, left: f64| DepthIssue { code: code.into(), front, back, left };
    for f in &fronts {
        if f.outline && f.depth >= t - EPS && !tab(f) {
            out.push(issue("looseFront", f.n, 0.0, 0.0));
        }
    }
    for f in &fronts {
        for b in &backs {
            let left = t - f.depth - b.depth;
            if left >= MIN_WEB {
                continue;
            }
            let (f_through, b_through) = (f.depth >= t - EPS, b.depth >= t - EPS);
            let (fb, bf) = (shared_share(f, b), shared_share(b, f));
            if fb <= 0.0 && bf <= 0.0 {
                continue;
            }
            if [f, b].iter().any(|r| r.skin.unwrap_or(0.0) > 0.0 && left >= r.skin.unwrap() - 1e-6) {
                continue;
            }
            if f.outline && b.outline && mn(fb, bf) > 0.95 {
                if f_through && !tab(f) {
                    continue;
                }
                if left > EPS {
                    out.push(issue("thin", f.n, b.n, left));
                    continue;
                }
                let over = -left;
                let tb = mx(if tab(f) { f.tab_h - over } else { f64::NEG_INFINITY }, if tab(b) { b.tab_h - over } else { f64::NEG_INFINITY });
                if tb == f64::NEG_INFINITY {
                    out.push(issue("loose", f.n, b.n, 0.0));
                } else if tb < MIN_TAB {
                    out.push(issue("tabsThin", f.n, b.n, mx(0.0, tb)));
                }
                continue;
            }
            if f_through || b_through {
                continue;
            }
            out.push(issue(if left > EPS { "thin" } else { "through" }, f.n, b.n, mx(0.0, left)));
        }
    }
    out
}

/// Tiefster Schnitt der anderen Seite an dieser Form (0 = keiner)
pub fn other_side_depth(shape: &Removal, others: &[Removal]) -> f64 {
    let mut d = 0.0f64;
    for o in others {
        if o.side == shape.side {
            continue;
        }
        if shared_share(shape, o) > 0.95 {
            d = mx(d, o.depth);
        }
    }
    d
}

pub const THROUGH_EXTRA: f64 = 0.2;

/// Tiefe, die gerade durchschneidet, wenn die andere Seite dort schon otherDepth weggenommen hat
pub fn through_depth(t: f64, other: f64, extra: f64) -> f64 {
    mx(0.0, t - mx(0.0, other)) + extra
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub setup: Setup,
    pub obstacles: Vec<Obstacle>,
    #[serde(default)]
    pub bed: Option<Bed>,
    pub removals: Vec<Removal>,
    pub all: Vec<Removal>,
    pub parts: Vec<BoxR>,
    pub tool_dia: f64,
    pub tool_drill: bool,
}

/// Alles, was die Fräsdatei beider Seiten prüft, in einem Zug (wie twoSidedJob im Fenster)
pub fn run(job: &Job) -> Value {
    let s = &job.setup;
    let other: Vec<f64> = job.all.iter().map(|r| other_side_depth(r, &job.all)).collect();
    serde_json::json!({
        "pins": pin_issues(s, &job.obstacles, job.bed),
        "depth": depth_issues(&job.removals, s.thickness),
        "other": other,
        "through": other.iter().map(|&o| through_depth(s.thickness, o, THROUGH_EXTRA)).collect::<Vec<_>>(),
        "defaults": default_pins(s, &job.parts),
        "pinCut": pin_cut(s.pin_dia, job.tool_dia, job.tool_drill),
        "mirrored": s.pins.iter().map(|&p| mirror_point(p, s)).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn js_number() {
        let n = |s: &str| string_to_number(s);
        assert_eq!((n(""), n(" 12 "), n("0x1f"), n("0b11"), n("1e3"), n(".5"), n("5.")), (0.0, 12.0, 31.0, 3.0, 1000.0, 0.5, 5.0));
        assert!(n("1e").is_nan() && n("1_0").is_nan() && n("inf").is_nan() && n("0x").is_nan() && n("-0x5").is_nan());
        assert_eq!(js_to_number(Some(&serde_json::json!([7]))), 7.0);
        assert!(js_to_number(Some(&serde_json::json!([1, 2]))).is_nan());
    }

    #[test]
    fn same_result_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("twosided-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        for (i, c) in all["clean"].as_array().unwrap().iter().enumerate() {
            same(&serde_json::to_value(clean_setup(&c["raw"])).unwrap(), &c["want"], &format!("clean {i}"));
        }
        let jobs = all["jobs"].as_array().unwrap();
        assert!(jobs.len() >= 20, "only {} jobs", jobs.len());
        for j in jobs {
            let job: Job = serde_json::from_value(j["job"].clone()).unwrap();
            same(&run(&job), &j["want"], j["name"].as_str().unwrap());
        }
        println!("{} setups cleaned and {} two-sided jobs checked the same as twoSided.ts", all["clean"].as_array().unwrap().len(), jobs.len());
    }
}
