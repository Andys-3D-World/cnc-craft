//! X/Y ANTASTEN – Zwilling von `src/xyProbe.ts` (Kante, Außenecke, Innenecke, Mitte einer Bohrung; dazu cleanXY,
//! sidesCentre, zeroLine).
//!
//! Der Ablauf fährt die Maschine. Rust fährt hier NICHTS: Das Fenster zeichnet jeden Aufruf an die Maschine samt Antwort
//! auf (src/xyProbeRec.ts), Rust spielt den Ablauf mit genau diesen Antworten nach und prüft dabei, dass es dieselben
//! Fahrten in derselben Reihenfolge geschickt hätte, und am Ende dasselbe Ergebnis (bzw. denselben Fehler) hat.
//! Weicht ein Aufruf ab, steht im Ergebnis, an welcher Stelle. Fälle: `tests/fixtures/xyprobe-cases.json.gz`.

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath::to_fixed;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

fn nan_num<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN))
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct XYState {
    #[serde(deserialize_with = "nan_num")]
    pub x: f64,
    #[serde(deserialize_with = "nan_num")]
    pub y: f64,
    pub contact: bool,
    pub state: String,
}

/// Ein Aufruf an die Maschine und was zurückkam (err = der Aufruf warf einen Fehler)
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "c", rename_all = "lowercase")]
pub enum Call {
    Jog {
        #[serde(deserialize_with = "nan_num")]
        dx: f64,
        #[serde(deserialize_with = "nan_num")]
        dy: f64,
        #[serde(deserialize_with = "nan_num")]
        feed: f64,
        #[serde(default)]
        r: Option<bool>,
        #[serde(default)]
        err: bool,
    },
    Status {
        #[serde(default)]
        r: Option<XYState>,
        #[serde(default)]
        err: bool,
    },
    Cancel {
        #[serde(default)]
        err: bool,
    },
    Aborted {
        r: bool,
    },
    Now {
        #[serde(deserialize_with = "nan_num")]
        r: f64,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Fail {
    /// XYFail mit Code (wie im Fenster)
    Code(&'static str),
    /// anderer Fehler (ein Aufruf an die Maschine warf)
    Other,
    /// Nachspielen weicht ab: Rust hätte etwas anderes geschickt
    Replay(String),
}
type R<T> = Result<T, Fail>;

/// Die aufgezeichneten Antworten der Maschine, in der Reihenfolge der Aufrufe
pub struct Replay<'a> {
    log: &'a [Call],
    at: usize,
}
fn kind(c: &Call) -> &'static str {
    match c {
        Call::Jog { .. } => "jog",
        Call::Status { .. } => "status",
        Call::Cancel { .. } => "cancel",
        Call::Aborted { .. } => "aborted",
        Call::Now { .. } => "now",
    }
}
fn close(a: f64, b: f64) -> bool {
    a == b || (a - b).abs() <= 1e-9 * (1.0 + a.abs()) || (a.is_nan() && b.is_nan())
}
impl<'a> Replay<'a> {
    pub fn new(log: &'a [Call]) -> Self {
        Replay { log, at: 0 }
    }
    fn next(&mut self, want: &str) -> R<&'a Call> {
        let Some(c) = self.log.get(self.at) else {
            return Err(Fail::Replay(format!("call {}: Rust calls {want}, the window made no more calls", self.at)));
        };
        if kind(c) != want {
            return Err(Fail::Replay(format!("call {}: Rust calls {want}, the window called {}", self.at, kind(c))));
        }
        self.at += 1;
        Ok(c)
    }
    fn jog(&mut self, dx: f64, dy: f64, feed: f64) -> R<bool> {
        let at = self.at;
        let Call::Jog { dx: x, dy: y, feed: f, r, err } = self.next("jog")? else { unreachable!() };
        if !close(dx, *x) || !close(dy, *y) || !close(feed, *f) {
            return Err(Fail::Replay(format!("call {at}: Rust jogs {dx} {dy} F{feed}, the window jogged {x} {y} F{f}")));
        }
        if *err {
            return Err(Fail::Other);
        }
        Ok(r.unwrap_or(false))
    }
    fn status(&mut self) -> R<Option<XYState>> {
        let Call::Status { r, err } = self.next("status")? else { unreachable!() };
        if *err {
            return Err(Fail::Other);
        }
        Ok(r.clone())
    }
    fn cancel(&mut self) -> R<()> {
        let Call::Cancel { err } = self.next("cancel")? else { unreachable!() };
        if *err {
            return Err(Fail::Other);
        }
        Ok(())
    }
    fn aborted(&mut self) -> R<bool> {
        let Call::Aborted { r } = self.next("aborted")? else { unreachable!() };
        Ok(*r)
    }
    fn now(&mut self) -> R<f64> {
        let Call::Now { r } = self.next("now")? else { unreachable!() };
        Ok(*r)
    }
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct XYOpts {
    pub tip: f64,
    pub side: f64,
    pub search: f64,
    pub along: f64,
}

pub const FAST: f64 = 100.0;
pub const SLOW: f64 = 25.0;
pub const TRAVEL: f64 = 200.0;
pub const AHEAD_S: f64 = 0.8;
const CHUNK_S: f64 = 0.4;
const BACK: f64 = 2.0;
const BACK_MAX: f64 = 8.0;

#[derive(Clone, Copy, Debug)]
struct Dir {
    x: f64,
    y: f64,
}

fn good(io: &mut Replay, s: Option<XYState>) -> R<XYState> {
    if io.aborted()? {
        return Err(Fail::Code("aborted"));
    }
    let Some(s) = s else { return Err(Fail::Code("lost")) };
    if s.state.starts_with("Alarm") {
        return Err(Fail::Code("alarm"));
    }
    Ok(s)
}

/// Warten, bis die Maschine steht (zwei Berichte „Idle“)
fn still(io: &mut Replay) -> R<XYState> {
    let end = io.now()? + 10000.0;
    let mut idle = 0;
    loop {
        let st = io.status()?;
        let s = good(io, st)?;
        idle = if s.state.starts_with("Idle") { idle + 1 } else { 0 };
        if idle >= 2 {
            return Ok(s);
        }
        if io.now()? > end {
            return Err(Fail::Code("timeout"));
        }
    }
}

#[derive(PartialEq, Clone, Copy)]
enum Until {
    End,
    Contact,
    Free,
}

/// Überwachte Fahrt (siehe drive in xyProbe.ts)
fn drive(io: &mut Replay, d: Dir, dist: f64, feed: f64, until: Until) -> R<(bool, XYState)> {
    let from = still(io)?;
    if !(dist > 1e-4) {
        return Ok((false, from));
    }
    let v = feed / 60.0;
    let chunk = mx(0.05, v * CHUNK_S);
    let limit = io.now()? + (dist / v) * 1000.0 * 3.0 + 10000.0;
    let (mut sent, mut hits, mut begun): (f64, u32, f64) = (0.0, 0, 0.0);
    let mut seen = from.clone();
    let done = |s: &XYState| (s.x - from.x) * d.x + (s.y - from.y) * d.y;
    loop {
        loop {
            let c = mn(chunk, dist - sent);
            if !(c > 1e-6) || sent + c - done(&seen) > v * AHEAD_S + 1e-6 {
                break;
            }
            if io.aborted()? {
                return Err(Fail::Code("aborted"));
            }
            if !io.jog(d.x * c, d.y * c, feed)? {
                io.cancel()?;
                return Err(Fail::Code(if io.aborted()? { "aborted" } else { "jog" }));
            }
            sent += c;
            // if (!begun): 0 oder NaN
            if begun == 0.0 || begun.is_nan() {
                begun = io.now()?;
            }
        }
        // ein Fehler beim Bericht: erst Jog-Abbruch (dessen Fehler zählt nicht), dann weiterreichen
        let st = match io.status().and_then(|st| good(io, st)) {
            Ok(s) => s,
            Err(Fail::Replay(m)) => return Err(Fail::Replay(m)),
            Err(e) => {
                match io.cancel() {
                    Err(Fail::Replay(m)) => return Err(Fail::Replay(m)),
                    _ => {}
                }
                return Err(e);
            }
        };
        seen = st.clone();
        let s = st;
        let want = if until == Until::Free { !s.contact } else { s.contact };
        hits = if want { hits + 1 } else { 0 };
        if hits >= 2 {
            io.cancel()?;
            let at = still(io)?;
            if until != Until::End {
                return Ok((true, at));
            }
            return Err(Fail::Code("contactOnWay"));
        }
        if sent >= dist - 1e-6 && s.state.starts_with("Idle") && (done(&s) > dist - 0.05 || io.now()? - begun > (dist / v) * 1000.0 + 3000.0) {
            return Ok((false, still(io)?));
        }
        if io.now()? > limit {
            io.cancel()?;
            return Err(Fail::Code("timeout"));
        }
    }
}

/// Math.sign
fn sign(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        v // 0, -0 oder NaN
    }
}

/// Überwachte Fahrt zu einer Stelle, erst X, dann Y oder umgekehrt
fn go_to(io: &mut Replay, x: f64, y: f64, x_first: bool) -> R<()> {
    for a_is_x in if x_first { [true, false] } else { [false, true] } {
        let s = still(io)?;
        let diff = if a_is_x { x - s.x } else { y - s.y };
        let d = if a_is_x { Dir { x: sign(diff), y: 0.0 } } else { Dir { x: 0.0, y: sign(diff) } };
        drive(io, d, diff.abs(), TRAVEL, Until::End)?;
    }
    Ok(())
}

/// Weg vom Kontakt: 2 mm, ist der Taster dann noch zu, weiter bis höchstens 8 mm
fn back_off(io: &mut Replay, d: Dir) -> R<f64> {
    let a = still(io)?;
    let away = Dir { x: -d.x, y: -d.y };
    if !drive(io, away, BACK_MAX, TRAVEL / 2.0, Until::Free)?.0 {
        return Err(Fail::Code("stuck"));
    }
    let r = match drive(io, away, BACK, TRAVEL / 2.0, Until::End) {
        Err(Fail::Code("contactOnWay")) => return Err(Fail::Code("stuck")),
        x => x?,
    };
    Ok(hypot2(r.1.x - a.x, r.1.y - a.y))
}

/// Schnell suchen, zurück, langsam messen. Rückgabe: Lage der Spitzen-MITTE beim Kontakt
fn touch(io: &mut Replay, d: Dir, dist: f64) -> R<XYState> {
    let seek = |io: &mut Replay, len: f64, feed: f64| -> R<Option<XYState>> {
        let mut left = len;
        let mut glitch = 0;
        while glitch < 10 && left > 0.02 {
            let a = still(io)?;
            let (hit, at) = drive(io, d, left, feed, Until::Contact)?;
            if !hit {
                return Ok(None);
            }
            let st = io.status()?;
            let s1 = good(io, st)?;
            let st = io.status()?;
            let s2 = good(io, st)?;
            if s1.contact && s2.contact {
                return Ok(Some(at));
            }
            left -= mx(0.0, (at.x - a.x) * d.x + (at.y - a.y) * d.y);
            glitch += 1;
        }
        Ok(None)
    };
    let Some(p1) = seek(io, dist, FAST)? else { return Err(Fail::Code("noContact")) };
    let back = back_off(io, d)?;
    let Some(p2) = seek(io, back + 1.0, SLOW)? else { return Err(Fail::Code("unstable")) };
    if (p2.x - p1.x) * d.x + (p2.y - p1.y) * d.y > 0.5 || hypot2(p2.x - p1.x, p2.y - p1.y) > 3.0 {
        return Err(Fail::Code("unstable"));
    }
    back_off(io, d)?;
    Ok(p2)
}

/// Wird nichts gefunden, zurück zum Anfang (die zuletzt gefahrene Achse zuerst)
fn with_return<T>(io: &mut Replay, f: impl FnOnce(&mut Replay, &XYState) -> R<T>) -> R<T> {
    let s0 = still(io)?;
    let r = f(io, &s0);
    if let Err(Fail::Code(c)) = &r {
        if matches!(*c, "noContact" | "unstable" | "size") && !io.aborted()? {
            // Fehler auf dem Rückweg zählen nicht (bleibt stehen) – nur ein abweichendes Nachspielen
            let back = (|| -> R<()> {
                let s = still(io)?;
                go_to(io, s0.x, s0.y, !((s.x - s0.x).abs() < (s.y - s0.y).abs()))
            })();
            if let Err(Fail::Replay(m)) = back {
                return Err(Fail::Replay(m));
            }
        }
    }
    r
}

fn dir_of(name: &str) -> Option<Dir> {
    Some(match name {
        "xp" => Dir { x: 1.0, y: 0.0 },
        "xn" => Dir { x: -1.0, y: 0.0 },
        "yp" => Dir { x: 0.0, y: 1.0 },
        "yn" => Dir { x: 0.0, y: -1.0 },
        _ => return None,
    })
}

pub fn probe_edge(io: &mut Replay, dir: &str, o: &XYOpts) -> R<f64> {
    let d = dir_of(dir).ok_or_else(|| Fail::Replay(format!("unknown direction {dir}")))?;
    with_return(io, |io, s0| {
        let p = touch(io, d, o.search)?;
        go_to(io, s0.x, s0.y, true)?;
        Ok(if d.x != 0.0 { p.x + d.x * (o.tip / 2.0 + o.side) } else { p.y + d.y * (o.tip / 2.0 + o.side) })
    })
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Corner {
    pub cx: f64,
    pub cy: f64,
}

pub fn probe_outer_corner(io: &mut Replay, c: Corner, o: &XYOpts) -> R<(f64, f64)> {
    with_return(io, |io, s0| {
        let (ix, iy, off) = (-c.cx, -c.cy, o.tip / 2.0 + o.side);
        drive(io, Dir { x: 0.0, y: iy }, o.along, TRAVEL, Until::End)?;
        let px = touch(io, Dir { x: ix, y: 0.0 }, o.search)?;
        go_to(io, s0.x, s0.y, true)?;
        drive(io, Dir { x: ix, y: 0.0 }, o.along, TRAVEL, Until::End)?;
        let py = touch(io, Dir { x: 0.0, y: iy }, o.search)?;
        go_to(io, s0.x, s0.y, false)?;
        Ok((px.x + ix * off, py.y + iy * off))
    })
}

pub fn probe_inner_corner(io: &mut Replay, c: Corner, o: &XYOpts) -> R<(f64, f64)> {
    with_return(io, |io, s0| {
        let px = touch(io, Dir { x: c.cx, y: 0.0 }, o.search)?;
        go_to(io, s0.x, s0.y, true)?;
        let py = touch(io, Dir { x: 0.0, y: c.cy }, o.search)?;
        go_to(io, s0.x, s0.y, false)?;
        Ok((px.x + c.cx * o.tip / 2.0, py.y + c.cy * o.tip / 2.0))
    })
}

pub fn probe_hole(io: &mut Replay, o: &XYOpts) -> R<(f64, f64, f64, f64)> {
    with_return(io, |io, s0| {
        let l = touch(io, Dir { x: -1.0, y: 0.0 }, o.search)?;
        go_to(io, s0.x, s0.y, true)?;
        let r = touch(io, Dir { x: 1.0, y: 0.0 }, o.search)?;
        let x = (l.x + r.x) / 2.0;
        let w = r.x - l.x + o.tip;
        go_to(io, x, s0.y, true)?;
        let f = touch(io, Dir { x: 0.0, y: -1.0 }, o.search)?;
        go_to(io, x, s0.y, false)?;
        let b = touch(io, Dir { x: 0.0, y: 1.0 }, o.search)?;
        let y = (f.y + b.y) / 2.0;
        let h = b.y - f.y + o.tip;
        if !(w > o.tip && h > o.tip) {
            return Err(Fail::Code("size"));
        }
        go_to(io, x, y, false)?;
        Ok((x, y, w, h))
    })
}

// ---------------------------------------------------------------------
// Kleine Rechnungen
// ---------------------------------------------------------------------

/// String(v) in JavaScript für das, was in gespeicherten Einstellungen stehen kann
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => crate::jsmath::js_num(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|e| if e.is_null() { String::new() } else { js_string(e) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
/// Einstellungen säubern: Zahl (oder Text, der mit einer Zahl beginnt) in die Grenzen, sonst der Standard
pub fn clean_xy(o: &Value) -> Value {
    let lim = [("tip", 3.0, 0.0, 25.0), ("side", 0.0, 0.0, 60.0), ("search", 15.0, 2.0, 100.0), ("along", 10.0, 3.0, 40.0)];
    let mut out = serde_json::Map::new();
    for (k, d, lo, hi) in lim {
        let n = match o.get(k) {
            Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
            // fehlt = undefined → parseFloat("undefined") = NaN
            None => f64::NAN,
            Some(v) => crate::importdxf::parse_float(&js_string(v)),
        };
        out.insert(k.into(), json!(if n.is_finite() { mx(lo, mn(hi, n)) } else { d }));
    }
    Value::Object(out)
}

/// Mitte eines Teils aus einzelnen Kanten
pub fn sides_centre(left: Option<f64>, right: Option<f64>, front: Option<f64>, back: Option<f64>) -> Value {
    let mut out = serde_json::Map::new();
    if let (Some(l), Some(r)) = (left, right) {
        if r > l {
            out.insert("x".into(), json!((l + r) / 2.0));
            out.insert("w".into(), json!(r - l));
        }
    }
    if let (Some(f), Some(b)) = (front, back) {
        if b > f {
            out.insert("y".into(), json!((f + b) / 2.0));
            out.insert("h".into(), json!(b - f));
        }
    }
    Value::Object(out)
}

/// Nullpunkt so setzen, dass die gemessene Stelle den Wert val bekommt (G10 L20), None = nichts gemessen
pub fn zero_line(pos: (f64, f64), found: (Option<f64>, Option<f64>), val: (f64, f64)) -> Option<String> {
    let mut parts = vec![];
    if let Some(x) = found.0 {
        parts.push(format!("X{}", to_fixed(pos.0 - x + val.0, 3)));
    }
    if let Some(y) = found.1 {
        parts.push(format!("Y{}", to_fixed(pos.1 - y + val.1, 3)));
    }
    if parts.is_empty() {
        None
    } else {
        Some(format!("G10 L20 P0 {}", parts.join(" ")))
    }
}

// ---------------------------------------------------------------------
// Auftrag des Fensters
// ---------------------------------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Job {
    Edge { dir: String, opts: XYOpts },
    Outer { corner: Corner, opts: XYOpts },
    Inner { corner: Corner, opts: XYOpts },
    Hole { opts: XYOpts },
    /// gespeicherte Einstellungen säubern (cleanXY)
    Clean {
        #[serde(default)]
        o: Value,
    },
    /// Mitte aus einzelnen Kanten (sidesCentre)
    Sides { s: SidesIn },
    /// Zeile für den Nullpunkt (zeroLine)
    Zero { pos: P2, found: Found, val: P2 },
}
#[derive(Deserialize, Debug, Default)]
pub struct SidesIn {
    pub left: Option<f64>,
    pub right: Option<f64>,
    pub front: Option<f64>,
    pub back: Option<f64>,
}
#[derive(Deserialize, Debug, Clone, Copy)]
pub struct P2 {
    pub x: f64,
    pub y: f64,
}
#[derive(Deserialize, Debug, Default)]
pub struct Found {
    pub x: Option<f64>,
    pub y: Option<f64>,
}

/// Ablauf mit den aufgezeichneten Antworten nachspielen: {ok: Ergebnis} oder {err: Code}; "error" = ein Aufruf warf.
/// Weicht ein Aufruf ab oder bleiben Aufrufe übrig: {replay: wo}
pub fn run(job: &Job, log: &[Call]) -> Value {
    match job {
        Job::Clean { o } => return clean_xy(o),
        Job::Sides { s } => return sides_centre(s.left, s.right, s.front, s.back),
        Job::Zero { pos, found, val } => return json!(zero_line((pos.x, pos.y), (found.x, found.y), (val.x, val.y))),
        _ => {}
    }
    let mut io = Replay::new(log);
    let r = match job {
        Job::Edge { dir, opts } => probe_edge(&mut io, dir, opts).map(|v| json!(v)),
        Job::Outer { corner, opts } => probe_outer_corner(&mut io, *corner, opts).map(|(x, y)| json!({ "x": x, "y": y })),
        Job::Inner { corner, opts } => probe_inner_corner(&mut io, *corner, opts).map(|(x, y)| json!({ "x": x, "y": y })),
        Job::Hole { opts } => probe_hole(&mut io, opts).map(|(x, y, w, h)| json!({ "x": x, "y": y, "w": w, "h": h })),
        Job::Clean { .. } | Job::Sides { .. } | Job::Zero { .. } => unreachable!(),
    };
    match r {
        Err(Fail::Replay(m)) => json!({ "replay": m }),
        _ if io.at != log.len() => json!({ "replay": format!("Rust stops after {} calls, the window made {}", io.at, log.len()) }),
        Ok(v) => json!({ "ok": v }),
        Err(Fail::Code(c)) => json!({ "err": c }),
        Err(Fail::Other) => json!({ "err": "error" }),
    }
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
                assert_eq!(kx, ky, "{at}: keys {a} vs {b}");
                for (k, p) in x {
                    same(p, &y[k], &format!("{at}.{k}"));
                }
            }
            _ => assert_eq!(a, b, "{at}"),
        }
    }

    #[test]
    fn same_moves_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("xyprobe-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        let cases = all["cases"].as_array().unwrap();
        assert!(cases.len() >= 40);
        for c in cases {
            let job: Job = serde_json::from_value(c["job"].clone()).unwrap();
            let log: Vec<Call> = serde_json::from_value(c["log"].clone()).unwrap();
            same(&run(&job, &log), &c["want"], &format!("{}", c["name"]));
        }
        for c in all["cleans"].as_array().unwrap() {
            same(&clean_xy(&c["o"]), &c["want"], &format!("cleanXY {}", c["o"]));
        }
        for c in all["sides"].as_array().unwrap() {
            let g = |k: &str| c["s"][k].as_f64();
            same(&sides_centre(g("left"), g("right"), g("front"), g("back")), &c["want"], &format!("sidesCentre {}", c["s"]));
        }
        for c in all["zeros"].as_array().unwrap() {
            let f = |v: &Value, k: &str| v[k].as_f64();
            let got = zero_line((c["pos"]["x"].as_f64().unwrap(), c["pos"]["y"].as_f64().unwrap()), (f(&c["found"], "x"), f(&c["found"], "y")),
                (c["val"]["x"].as_f64().unwrap(), c["val"]["y"].as_f64().unwrap()));
            same(&json!(got), &c["want"], &format!("zeroLine {}", c["pos"]));
        }
        // ein Aufruf anders als im Fenster: das Nachspielen meldet die Stelle
        let c = &cases[0];
        let job: Job = serde_json::from_value(c["job"].clone()).unwrap();
        let mut log: Vec<Call> = serde_json::from_value(c["log"].clone()).unwrap();
        let k = log.iter().position(|e| matches!(e, Call::Jog { .. })).unwrap();
        if let Call::Jog { dx, .. } = &mut log[k] {
            *dx += 0.01;
        }
        assert!(run(&job, &log)["replay"].as_str().unwrap().contains(&format!("call {k}:")));
        log.truncate(k);
        assert!(run(&job, &log)["replay"].is_string());
        println!("{} probing runs replayed the same as xyProbe.ts", cases.len());
    }
}
