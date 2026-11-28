//! WERKZEUGMAGAZIN – Zwilling von `src/magazine.ts` (cleanMagazine, rackProblem, getSteps/putSteps/lookSteps, forgetTests,
//! toolNumbersIn, rackBlocked, rackBox, runsOn).
//!
//! Plätze mit Nummer und Werkzeug; bei der Reihe (rack) legt CNC Craft selbst ab und holt. Z fährt nur über einem Platz
//! nach unten, quer nur auf der freien Höhe, der Spanner nur mit M64/M65. Folgt dem TypeScript Zeile für Zeile. Nur
//! Vergleich: welche Schritte die Maschine fährt, bestimmt weiter das Fenster (toolChange.ts).
//! Gemeinsame Fälle: `tests/fixtures/magazine-cases.json.gz`.

use crate::gcodesim::{hypot2, js_space, mn, mx};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub n: f64,
    pub tool_id: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub set: bool,
    pub ok_get: bool,
    pub ok_put: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Magazine {
    pub kind: String,
    pub entry: String,
    pub dir: String,
    pub slide: f64,
    pub approach: f64,
    pub z_clear: f64,
    #[serde(rename = "feedXY")]
    pub feed_xy: f64,
    pub feed_z: f64,
    pub slow: f64,
    pub open: String,
    pub close: String,
    pub open_s: f64,
    pub spin_s: f64,
    pub always: bool,
    pub auto: bool,
    pub size: f64,
    pub top: f64,
    pub slots: Vec<Slot>,
    pub in_spindle: f64,
}

pub const MAX_SLOTS: usize = 24;

/// typeof v === "number" && finite && lo ≤ v ≤ hi ? v : d
fn num(v: Option<&Value>, lo: f64, hi: f64, d: f64) -> f64 {
    match v.and_then(|v| v.as_f64()) {
        Some(x) if x.is_finite() && x >= lo && x <= hi => x,
        _ => d,
    }
}
fn is_true(v: Option<&Value>) -> bool {
    v == Some(&Value::Bool(true))
}

/// Nur Schaltbefehle für freie Ausgänge (M64/M65 P0–99), sonst ""
pub fn clean_output(v: Option<&Value>) -> String {
    let Some(s) = v.and_then(|v| v.as_str()) else { return String::new() };
    let c: Vec<char> = s.trim_matches(js_space).to_uppercase().chars().collect();
    // /^M(64|65)\s*P(\d{1,2})$/
    if c.len() < 5 || c[0] != 'M' || c[1] != '6' || !(c[2] == '4' || c[2] == '5') {
        return String::new();
    }
    let mut j = 3;
    while j < c.len() && js_space(c[j]) {
        j += 1;
    }
    if c.get(j) != Some(&'P') {
        return String::new();
    }
    let d: String = c[j + 1..].iter().collect();
    if d.is_empty() || d.chars().count() > 2 || !d.chars().all(|ch| ch.is_ascii_digit()) {
        return String::new();
    }
    format!("M6{} P{}", c[2], d.parse::<u32>().unwrap())
}

const DEFAULT: (f64, f64, f64, f64, f64, f64, f64, f64, f64, f64, f64) = (40.0, 15.0, -5.0, 2000.0, 800.0, 150.0, 1.0, 8.0, 30.0, 60.0, -1.0);

pub fn clean_magazine(raw: &Value) -> Magazine {
    let (d_slide, d_approach, d_zclear, d_fxy, d_fz, d_slow, d_opens, d_spins, d_size, d_top, _) = DEFAULT;
    let empty = serde_json::Map::new();
    let r = raw.as_object().unwrap_or(&empty);
    let mut slots: Vec<Slot> = vec![];
    if let Some(list) = r.get("slots").and_then(|v| v.as_array()) {
        for s in list {
            let g = |k: &str| s.as_object().and_then(|o| o.get(k));
            let n = num(g("n"), 1.0, 99.0, 0.0);
            if n == 0.0 || n != n.floor() || slots.iter().any(|o| o.n == n) || slots.len() >= MAX_SLOTS {
                continue;
            }
            let ok = ["x", "y", "z"].iter().all(|k| g(k).and_then(|v| v.as_f64()).is_some_and(|v| v.is_finite() && v.abs() <= 20000.0));
            let set = is_true(g("set")) && ok;
            let tool_id = match g("toolId").and_then(|v| v.as_str()) {
                Some(t) if (1..=60).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') => t.to_string(),
                _ => String::new(),
            };
            let at = |k: &str| if ok { g(k).and_then(|v| v.as_f64()).unwrap_or(0.0) } else { 0.0 };
            slots.push(Slot { n, tool_id, x: at("x"), y: at("y"), z: at("z"), set, ok_get: set && is_true(g("okGet")), ok_put: set && is_true(g("okPut")) });
        }
    }
    // stabil sortiert, wie Array.prototype.sort
    slots.sort_by(|a, b| a.n.partial_cmp(&b.n).unwrap());
    let in_s = num(r.get("inSpindle"), -1.0, 99.0, -1.0).floor();
    let s = |k: &str| r.get(k).and_then(|v| v.as_str());
    let kind = match s("kind") {
        Some(k @ ("hand" | "rack")) => k.to_string(),
        _ => "off".into(),
    };
    let dir = match s("dir") {
        Some(d @ ("x+" | "x-" | "y+" | "y-")) => d.to_string(),
        _ => "y-".into(),
    };
    let in_spindle = if in_s <= 0.0 || slots.iter().any(|x| x.n == in_s) { in_s } else { -1.0 };
    Magazine {
        kind,
        entry: if s("entry") == Some("fork") { "fork".into() } else { "top".into() },
        dir,
        slide: num(r.get("slide"), 5.0, 200.0, d_slide),
        approach: num(r.get("approach"), 2.0, 100.0, d_approach),
        z_clear: num(r.get("zClear"), -2000.0, 2000.0, d_zclear),
        feed_xy: num(r.get("feedXY"), 50.0, 10000.0, d_fxy),
        feed_z: num(r.get("feedZ"), 20.0, 5000.0, d_fz),
        slow: num(r.get("slow"), 10.0, 500.0, d_slow),
        open: clean_output(r.get("open")),
        close: clean_output(r.get("close")),
        open_s: num(r.get("openS"), 0.3, 20.0, d_opens),
        spin_s: num(r.get("spinS"), 3.0, 60.0, d_spins),
        always: is_true(r.get("always")),
        auto: is_true(r.get("auto")),
        size: num(r.get("size"), 5.0, 300.0, d_size),
        top: num(r.get("top"), -500.0, 500.0, d_top),
        slots,
        in_spindle,
    }
}

pub fn slot_of(m: &Magazine, n: f64) -> Option<&Slot> {
    m.slots.iter().find(|s| s.n == n)
}
/// Platz eines Werkzeugs (None = liegt nicht im Magazin)
pub fn slot_for_tool<'a>(m: &'a Magazine, tool_id: &str) -> Option<&'a Slot> {
    if m.kind == "off" || tool_id.is_empty() {
        return None;
    }
    m.slots.iter().find(|s| s.tool_id == tool_id)
}

#[allow(dead_code)]
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Rect {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct XY {
    pub x: f64,
    pub y: f64,
}

/// Wo ein Platz vor der Gabel-Einfahrt steht
pub fn before(m: &Magazine, s: &Slot) -> XY {
    let d = m.slide;
    let v = match m.dir.as_str() {
        "x+" => (d, 0.0),
        "x-" => (-d, 0.0),
        "y+" => (0.0, d),
        _ => (0.0, -d),
    };
    XY { x: s.x + v.0, y: s.y + v.1 }
}

/// Rechteck um die ganze Reihe in der Zeichnung (None = noch kein Platz eingetragen). Nur fürs Zeichnen (rackView.ts):
/// in der App nicht verglichen, nur vom Test
#[allow(dead_code)]
pub fn rack_box(m: &Magazine, zero: XY, with_slide: bool) -> Option<Rect> {
    let mut b: Option<Rect> = None;
    for s in &m.slots {
        if !s.set {
            continue;
        }
        let mut at = vec![XY { x: s.x - zero.x, y: s.y - zero.y }];
        if with_slide && m.entry == "fork" {
            let p = before(m, s);
            at.push(XY { x: p.x - zero.x, y: p.y - zero.y });
        }
        for p in at {
            let r = m.size / 2.0;
            let q = Rect { x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r };
            b = Some(match b {
                Some(b) => Rect { x0: mn(b.x0, q.x0), y0: mn(b.y0, q.y0), x1: mx(b.x1, q.x1), y1: mx(b.y1, q.y1) },
                None => q,
            });
        }
    }
    b
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Why {
    pub why: String,
    pub n: f64,
}
fn why(w: &str, n: f64) -> Why {
    Why { why: w.into(), n }
}

/// Stimmen die Einstellungen der Reihe? Grund und Platz
pub fn rack_problem(m: &Magazine) -> Why {
    if m.open.is_empty() || m.close.is_empty() {
        return why("outputs", 0.0);
    }
    if m.open == m.close {
        return why("same", 0.0);
    }
    if m.slots.is_empty() {
        return why("noSlot", 0.0);
    }
    for s in &m.slots {
        if !s.set {
            return why("unset", s.n);
        }
        if m.z_clear < s.z + m.approach + 5.0 {
            return why("clear", s.n);
        }
    }
    for i in 0..m.slots.len() {
        for j in i + 1..m.slots.len() {
            let (a, b) = (&m.slots[i], &m.slots[j]);
            if hypot2(a.x - b.x, a.y - b.y) < 8.0 {
                return why("near", b.n);
            }
            if !a.tool_id.is_empty() && a.tool_id == b.tool_id {
                return why("double", b.n);
            }
        }
    }
    why("", 0.0)
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum Step {
    Up { z: f64 },
    Xy {
        x: f64,
        y: f64,
        feed: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<Xyz>,
    },
    Z { z: f64, feed: f64, at: XY },
    Out { cmd: String, what: String, wait: f64 },
}
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub struct Xyz {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

fn out(cmd: &str, what: &str, wait: f64) -> Step {
    Step::Out { cmd: cmd.into(), what: what.into(), wait }
}

/// Werkzeug holen (Spindel ist leer)
pub fn get_steps(m: &Magazine, s: &Slot) -> Vec<Step> {
    let at = XY { x: s.x, y: s.y };
    let mut st = vec![
        Step::Up { z: m.z_clear },
        Step::Xy { x: at.x, y: at.y, feed: m.feed_xy, at: None },
        out(&m.open, "open", m.open_s),
        Step::Z { z: s.z + m.approach, feed: m.feed_z, at },
        Step::Z { z: s.z, feed: m.slow, at },
        out(&m.close, "close", m.open_s),
    ];
    if m.entry == "top" {
        st.push(Step::Z { z: s.z + m.approach, feed: m.slow, at });
        st.push(Step::Up { z: m.z_clear });
        return st;
    }
    let b = before(m, s);
    st.push(Step::Xy { x: b.x, y: b.y, feed: m.slow, at: Some(Xyz { x: at.x, y: at.y, z: s.z }) });
    st.push(Step::Up { z: m.z_clear });
    st
}

/// Werkzeug ablegen (es steckt in der Spindel)
pub fn put_steps(m: &Magazine, s: &Slot) -> Vec<Step> {
    let at = XY { x: s.x, y: s.y };
    let leave = vec![
        out(&m.open, "open", m.open_s),
        Step::Z { z: s.z + m.approach, feed: m.slow, at },
        Step::Up { z: m.z_clear },
        out(&m.close, "close", m.open_s),
    ];
    let mut st = if m.entry == "top" {
        vec![
            Step::Up { z: m.z_clear },
            Step::Xy { x: at.x, y: at.y, feed: m.feed_xy, at: None },
            Step::Z { z: s.z + m.approach, feed: m.feed_z, at },
            Step::Z { z: s.z, feed: m.slow, at },
        ]
    } else {
        let b = before(m, s);
        vec![
            Step::Up { z: m.z_clear },
            Step::Xy { x: b.x, y: b.y, feed: m.feed_xy, at: None },
            Step::Z { z: s.z + m.approach, feed: m.feed_z, at: b },
            Step::Z { z: s.z, feed: m.slow, at: b },
            Step::Xy { x: at.x, y: at.y, feed: m.slow, at: Some(Xyz { x: b.x, y: b.y, z: s.z }) },
        ]
    };
    st.extend(leave);
    st
}

/// Platz nur anfahren, um die Stelle zu prüfen: bis knapp darüber, Spanner bleibt zu
pub fn look_steps(m: &Magazine, s: &Slot) -> Vec<Step> {
    let at = if m.entry == "fork" { before(m, s) } else { XY { x: s.x, y: s.y } };
    vec![
        Step::Up { z: m.z_clear },
        Step::Xy { x: at.x, y: at.y, feed: m.feed_xy, at: None },
        Step::Z { z: s.z + m.approach, feed: m.feed_z, at },
        Step::Up { z: m.z_clear },
    ]
}

/// Muss dieser Vorgang Schritt für Schritt bestätigt werden?
pub fn needs_steps(m: &Magazine, s: &Slot, what: &str) -> bool {
    m.always || !(if what == "get" { s.ok_get } else { s.ok_put })
}

/// Darf ein Wechsel ohne Klick weiterlaufen? Nur auf Wunsch, und nur wenn beide Plätze schon geprüft sind
pub fn runs_on(m: &Magazine, want: &Slot) -> bool {
    let old = if m.in_spindle > 0.0 { slot_of(m, m.in_spindle) } else { None };
    m.auto && old.is_some_and(|o| !needs_steps(m, o, "put")) && !needs_steps(m, want, "get")
}

/// JSON.stringify-Gleichheit einer Zahl (NaN = NaN, -0 = 0)
fn same_num(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

/// Nach einer Änderung: was an Werten den Ablauf ändert, verlangt eine neue Prüfung
pub fn forget_tests(prev: &Magazine, next: &Magazine) -> Magazine {
    let nums = |m: &Magazine| [m.slide, m.approach, m.z_clear, m.feed_xy, m.feed_z, m.slow, m.open_s, m.spin_s];
    let all = prev.entry != next.entry || prev.dir != next.dir || prev.open != next.open || prev.close != next.close
        || nums(prev).iter().zip(nums(next).iter()).any(|(a, b)| !same_num(*a, *b));
    let mut m = next.clone();
    m.slots = next
        .slots
        .iter()
        .map(|s| {
            let keep = !all && slot_of(prev, s.n).is_some_and(|o| o.set && o.x == s.x && o.y == s.y && o.z == s.z);
            if keep {
                s.clone()
            } else {
                Slot { ok_get: false, ok_put: false, ..s.clone() }
            }
        })
        .collect();
    m
}

/// Werkzeugnummern der M6-Zeilen eines Programms (auch „T2“ in einer Zeile davor). 0 = M6 ohne Nummer
pub fn tool_numbers_in(lines: &[String]) -> Vec<f64> {
    let mut out: Vec<f64> = vec![];
    let mut last = 0.0;
    for raw in lines {
        // replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").toUpperCase()
        let rc: Vec<char> = raw.chars().collect();
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
        let after = t.iter().rposition(|&c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')).map_or(0, |p| p + 1);
        if let Some(p) = t[after..].iter().position(|&c| c == ';') {
            t.truncate(after + p);
        }
        let l: Vec<char> = t.iter().collect::<String>().to_uppercase().chars().collect();
        // /T\s*(\d+)/
        for p in 0..l.len() {
            if l[p] != 'T' {
                continue;
            }
            let mut j = p + 1;
            while j < l.len() && js_space(l[j]) {
                j += 1;
            }
            let mut e = j;
            while e < l.len() && l[e].is_ascii_digit() {
                e += 1;
            }
            if e > j {
                last = l[j..e].iter().collect::<String>().parse::<f64>().unwrap();
                break;
            }
        }
        // /M0*6(?!\d)/
        let mut m6 = false;
        for p in 0..l.len() {
            if l[p] != 'M' {
                continue;
            }
            let mut j = p + 1;
            while j < l.len() && l[j] == '0' {
                j += 1;
            }
            if l.get(j) == Some(&'6') && !l.get(j + 1).is_some_and(|c| c.is_ascii_digit()) {
                m6 = true;
                break;
            }
        }
        if m6 && !out.contains(&last) {
            out.push(last);
        }
    }
    out
}

#[derive(Deserialize, Clone, Debug)]
pub struct RackEnv {
    pub grbl: bool,
    #[serde(default)]
    pub firmware: String,
    pub homed: bool,
    pub inches: bool,
    pub sensor: bool,
}

/// Darf die Reihe jetzt fahren?
pub fn rack_blocked(m: &Magazine, o: &RackEnv) -> Why {
    if !o.grbl {
        return why("grbl", 0.0);
    }
    // Ausgänge mit M64/M65 gibt es bei grblHAL und FluidNC, nicht bei GRBL 1.1
    if o.firmware != "grblHAL" && o.firmware != "FluidNC" {
        return why("firmware", 0.0);
    }
    if !o.homed {
        return why("home", 0.0);
    }
    if o.inches {
        return why("inch", 0.0);
    }
    let p = rack_problem(m);
    if !p.why.is_empty() {
        return p;
    }
    if !o.sensor {
        return why("sensor", 0.0);
    }
    if m.in_spindle < 0.0 {
        return why("spindle", 0.0);
    }
    why("", 0.0)
}

/// Schritte für den Befehl `magazine_steps`: "get", "put" oder "look"
pub fn steps(m: &Magazine, s: &Slot, what: &str) -> Vec<Step> {
    match what {
        "get" => get_steps(m, s),
        "put" => put_steps(m, s),
        _ => look_steps(m, s),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// Zahlen auf 1e-9, der Rest genau
    fn same(a: &Value, b: &Value, at: &str) {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => assert!((x.as_f64().unwrap() - y.as_f64().unwrap()).abs() <= 1e-9, "{at}: {x} vs {y}"),
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
    fn v<T: Serialize>(t: T) -> Value {
        serde_json::to_value(t).unwrap()
    }

    #[test]
    fn small_pieces() {
        let o = |s: &str| clean_output(Some(&Value::String(s.into())));
        assert_eq!((o(" m64 p3 "), o("M65P07"), o("M64 P123"), o("M3")), ("M64 P3".into(), "M65 P7".into(), String::new(), String::new()));
        assert_eq!(tool_numbers_in(&["M6 T2".into(), "T5".into(), "M06".into(), "M60".into()]), vec![2.0, 5.0]);
    }

    #[test]
    fn same_result_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("magazine-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        let envs: Vec<RackEnv> = serde_json::from_value(all["envs"].clone()).unwrap();
        let cases = all["cases"].as_array().unwrap();
        assert!(cases.len() >= 12, "only {} magazines", cases.len());
        for (i, c) in cases.iter().enumerate() {
            let at = format!("magazine {i}");
            let m = clean_magazine(&c["raw"]);
            let w = &c["want"];
            same(&v(&m), &w["m"], &format!("{at}: cleaned"));
            same(&v(rack_problem(&m)), &w["problem"], &format!("{at}: problem"));
            same(&v(envs.iter().map(|e| rack_blocked(&m, e)).collect::<Vec<_>>()), &w["blocked"], &format!("{at}: blocked"));
            same(&v([rack_box(&m, XY { x: 0.0, y: 0.0 }, false), rack_box(&m, XY { x: 50.5, y: -10.0 }, true)]), &w["box"], &format!("{at}: box"));
            let slots: Vec<Value> = m
                .slots
                .iter()
                .map(|s| {
                    serde_json::json!({ "get": get_steps(&m, s), "put": put_steps(&m, s), "look": look_steps(&m, s), "needGet": needs_steps(&m, s, "get"),
                        "needPut": needs_steps(&m, s, "put"), "runs": runs_on(&m, s), "forTool": slot_for_tool(&m, &s.tool_id).map(|x| x.n) })
                })
                .collect();
            same(&Value::Array(slots), &w["slots"], &format!("{at}: slots"));
        }
        for (i, f) in all["forget"].as_array().unwrap().iter().enumerate() {
            let (p, n): (Magazine, Magazine) = (serde_json::from_value(f["prev"].clone()).unwrap(), serde_json::from_value(f["next"].clone()).unwrap());
            same(&v(forget_tests(&p, &n)), &f["want"], &format!("forget {i}"));
        }
        for t in all["tools"].as_array().unwrap() {
            let lines: Vec<String> = serde_json::from_value(t["lines"].clone()).unwrap();
            same(&v(tool_numbers_in(&lines)), &t["want"], "tool numbers");
        }
        println!("{} magazines checked the same as magazine.ts", cases.len());
    }
}
