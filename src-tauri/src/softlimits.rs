//! MASCHINENGRENZEN VOR DEM JOBSTART – Zwilling von `src/softLimits.ts` (scanJobExtents, arcExtents, axisRange, checkLimits).
//!
//! Der Job ist in Werkstück-Koordinaten geschrieben; Maschine = Werkstück + WCO. Erlaubte Strecke aus $130/$131/$132,
//! Lage des Bereichs aus der aktuellen Position (nie angenommen). Was nicht zu berechnen ist (G92, G10, anderes G5x,
//! G28/G30, Antasten, G91 aus unbekannter Lage, Zyklen) wird gemeldet, die Fahrten danach zählen nicht. Folgt dem
//! TypeScript Zeile für Zeile; das Fenster vergleicht (limitGuard.ts), entschieden wird weiter dort.
//! Gemeinsame Fälle: `tests/fixtures/softlimits-cases.json.gz`.

use crate::gcodesim::{hypot2, js_space, mn, mx};
use crate::importdxf::parse_float;
use crate::jsmath::{self, js_round};
use serde::{Deserialize, Deserializer, Serialize};
use std::f64::consts::PI;

/// Zahl, für die JSON `null` schickt, wenn sie in JavaScript NaN war
fn nan_vec<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<f64>, D::Error> {
    Ok(Vec::<Option<f64>>::deserialize(d)?.into_iter().map(|v| v.unwrap_or(f64::NAN)).collect())
}
fn nan_opt_vec<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<f64>>, D::Error> {
    Ok(Option::<Vec<Option<f64>>>::deserialize(d)?.map(|v| v.into_iter().map(|v| v.unwrap_or(f64::NAN)).collect()))
}
fn nan_num<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN))
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanStart {
    #[serde(default, deserialize_with = "nan_opt_vec")]
    pub wpos: Option<Vec<f64>>,
    #[serde(default, deserialize_with = "nan_opt_vec")]
    pub wco: Option<Vec<f64>>,
    #[serde(default)]
    pub active_wcs: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ZRange {
    pub min: f64,
    pub max: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobExtents {
    pub min: Vec<f64>,
    pub max: Vec<f64>,
    pub used: Vec<bool>,
    pub z_later: Option<ZRange>,
    pub mach_min: Vec<f64>,
    pub mach_max: Vec<f64>,
    pub mach_used: Vec<bool>,
    pub notes: Vec<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LimitEnv {
    #[serde(deserialize_with = "nan_vec")]
    pub travel: Vec<f64>,
    pub home_dir_mask: i64,
    #[serde(deserialize_with = "nan_num")]
    pub pulloff: f64,
    pub homed: bool,
    #[serde(deserialize_with = "nan_vec")]
    pub mpos: Vec<f64>,
    #[serde(deserialize_with = "nan_vec")]
    pub wpos: Vec<f64>,
    #[serde(default)]
    pub skip: Option<Vec<usize>>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct LimitOver {
    pub axis: String,
    pub kind: String,
    pub by: f64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimitResult {
    pub over: Vec<LimitOver>,
    pub z_later_over: Vec<LimitOver>,
    pub unknown_axes: Vec<String>,
    pub no_settings: Vec<String>,
    pub not_homed: bool,
}

fn add(min: &mut [f64], max: &mut [f64], used: &mut [bool], i: usize, v: f64) {
    if !used[i] {
        used[i] = true;
        min[i] = v;
        max[i] = v;
        return;
    }
    if v < min[i] {
        min[i] = v;
    }
    if v > max[i] {
        max[i] = v;
    }
}

/// Grenzen eines Bogens in seiner Ebene: Mittelpunkt ± Radius zählt nur, wo der Bogen wirklich hinkommt
pub fn arc_extents(sa: f64, sb: f64, ea: f64, eb: f64, ca: f64, cb: f64, cw: bool) -> [f64; 4] {
    let r = hypot2(sa - ca, sb - cb);
    let (mut a_min, mut a_max, mut b_min, mut b_max) = (mn(sa, ea), mx(sa, ea), mn(sb, eb), mx(sb, eb));
    let (a0, a1) = (jsmath::atan2(sb - cb, sa - ca), jsmath::atan2(eb - cb, ea - ca));
    let full = hypot2(sa - ea, sb - eb) < 1e-9;
    let mut sweep = if cw { a0 - a1 } else { a1 - a0 };
    while sweep < 0.0 {
        sweep += PI * 2.0;
    }
    if full || sweep < 1e-12 {
        sweep = PI * 2.0;
    }
    for q in 0..4 {
        let ang = (q as f64 * PI) / 2.0;
        let mut d = if cw { a0 - ang } else { ang - a0 };
        while d < 0.0 {
            d += PI * 2.0;
        }
        while d >= PI * 2.0 {
            d -= PI * 2.0;
        }
        if d > sweep {
            continue;
        }
        let (pa, pb) = (ca + r * jsmath::cos(ang), cb + r * jsmath::sin(ang));
        if pa < a_min {
            a_min = pa;
        }
        if pa > a_max {
            a_max = pa;
        }
        if pb < b_min {
            b_min = pb;
        }
        if pb > b_max {
            b_max = pb;
        }
    }
    [a_min, a_max, b_min, b_max]
}

/// Muster `([A-Z])\s*([-+]?\d*\.?\d+)` ab i: (Ende, Buchstabe, Zahl-Text)
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
    // \d*\.?\d+ mit Zurückgehen: Ziffern, dann „.Ziffern“ wenn möglich; sonst die Ziffern allein (mindestens eine)
    let num = |k: usize| -> Option<usize> {
        let a = digits(k);
        if c.get(a) == Some(&'.') && c.get(a + 1).is_some_and(|ch| ch.is_ascii_digit()) {
            Some(digits(a + 1))
        } else if a > k {
            Some(a)
        } else {
            None
        }
    };
    let e = (if matches!(c.get(j), Some('-' | '+')) { num(j + 1) } else { None }).or_else(|| num(j))?;
    Some((e, c[i], c[j..e].iter().collect()))
}

/// Alle Ziele im Job, jede Fahrt zählt (auch Eilgang)
pub fn scan_job_extents(lines: &[String], start: &ScanStart) -> JobExtents {
    let (mut min, mut max, mut used) = (vec![0.0; 3], vec![0.0; 3], vec![false; 3]);
    let (mut mach_min, mut mach_max, mut mach_used) = (vec![0.0; 3], vec![0.0; 3], vec![false; 3]);
    let mut notes: Vec<&'static str> = vec![];
    let note = |notes: &mut Vec<&'static str>, n: &'static str| {
        if !notes.contains(&n) {
            notes.push(n);
        }
    };
    let mut pos: Vec<f64> = match &start.wpos {
        Some(w) => w.iter().take(3).copied().collect(),
        None => vec![f64::NAN; 3],
    };
    // slice(0, 3) eines kürzeren Felds: fehlende Einträge sind undefined → NaN beim Rechnen
    while pos.len() < 3 {
        pos.push(f64::NAN);
    }
    let mut blind = [false; 3];
    let wco = start.wco.as_ref();
    let (mut abs, mut k, mut motion, mut plane, mut later) = (true, 1.0f64, 0.0f64, 17.0f64, false);
    let mut z_later: Option<ZRange> = None;
    let axes = ['X', 'Y', 'Z'];
    let mut wcs = start.active_wcs.clone().unwrap_or_default();

    for raw in lines {
        if raw.is_empty() {
            continue;
        }
        // replace(/\([^)]*\)/g, "")
        let rc: Vec<char> = raw.chars().collect();
        let mut line = String::new();
        let mut i = 0;
        while i < rc.len() {
            if rc[i] == '(' {
                if let Some(p) = rc[i + 1..].iter().position(|&ch| ch == ')') {
                    i += p + 2;
                    continue;
                }
            }
            line.push(rc[i]);
            i += 1;
        }
        if let Some(semi) = line.find(';') {
            line.truncate(semi);
        }
        let line = line.trim_matches(js_space).to_uppercase();
        if line.is_empty() || line.starts_with('$') || line.starts_with('%') {
            continue;
        }
        let c: Vec<char> = line.chars().collect();
        // Record<string, number>: Buchstabe → letzter Wert
        let mut w: Vec<(char, f64)> = vec![];
        let (mut g53, mut skip, mut cycle, mut home_move, mut probe, mut words) = (false, false, false, false, false, false);
        let mut p = 0;
        while p < c.len() {
            let Some((e, letter, txt)) = word(&c, p) else {
                p += 1;
                continue;
            };
            p = e;
            let v = parse_float(&txt);
            if letter == 'G' {
                let g = js_round(v * 10.0);
                if g == 0.0 || g == 10.0 || g == 20.0 || g == 30.0 {
                    motion = g / 10.0;
                } else if g == 800.0 {
                    motion = -1.0;
                } else if g == 900.0 {
                    abs = true;
                } else if g == 910.0 {
                    abs = false;
                } else if g == 200.0 {
                    k = 25.4;
                } else if g == 210.0 {
                    k = 1.0;
                } else if g == 170.0 || g == 180.0 || g == 190.0 {
                    plane = g / 10.0;
                } else if g == 530.0 {
                    g53 = true;
                } else if g == 40.0 || g == 281.0 || g == 301.0 {
                    skip = true;
                } else if g == 100.0 || g == 920.0 || g == 921.0 || g == 922.0 || g == 923.0 {
                    note(&mut notes, "offsets");
                    blind = [true; 3];
                    skip = true;
                } else if g == 431.0 || g == 490.0 || g == 430.0 {
                    note(&mut notes, "tlo");
                    blind[2] = true;
                    skip = true;
                } else if g == 280.0 || g == 300.0 {
                    home_move = true;
                } else if (380.0..390.0).contains(&g) {
                    probe = true;
                } else if (540.0..=590.0).contains(&g) && g % 10.0 == 0.0 {
                    let sys = format!("G{}", jsmath::js_num(g / 10.0));
                    if sys != wcs {
                        note(&mut notes, "wcs");
                        blind = [true; 3];
                        wcs = sys;
                    }
                } else if g == 730.0 || g == 740.0 || (810.0..=890.0).contains(&g) {
                    cycle = true;
                }
            } else if letter == 'M' {
                if v == 0.0 || v == 1.0 || v == 6.0 {
                    later = true;
                }
            } else if letter != 'N' {
                match w.iter_mut().find(|(l, _)| *l == letter) {
                    Some(x) => x.1 = v,
                    None => w.push((letter, v)),
                }
                if letter == 'X' || letter == 'Y' || letter == 'Z' {
                    words = true;
                }
            }
        }
        let get = |l: char| w.iter().find(|(x, _)| *x == l).map(|x| x.1);
        if skip {
            continue;
        }
        if cycle {
            note(&mut notes, "cycle");
            blind = [true; 3];
            continue;
        }
        if home_move {
            note(&mut notes, "homeMove");
            pos = vec![f64::NAN; 3];
            continue;
        }
        if !words {
            continue;
        }
        if probe {
            note(&mut notes, "probe");
            for (i, a) in axes.iter().enumerate() {
                if get(*a).is_some() {
                    pos[i] = f64::NAN;
                }
            }
            continue;
        }
        if g53 {
            for (i, a) in axes.iter().enumerate() {
                let Some(wv) = get(*a) else { continue };
                let v = wv * k;
                add(&mut mach_min, &mut mach_max, &mut mach_used, i, v);
                pos[i] = match wco {
                    Some(o) if !blind[i] => v - o.get(i).copied().unwrap_or(f64::NAN),
                    _ => f64::NAN,
                };
            }
            continue;
        }
        if motion < 0.0 {
            continue;
        }
        let from = pos.clone();
        let mut unknown = false;
        let to: Vec<f64> = axes
            .iter()
            .enumerate()
            .map(|(i, a)| {
                let Some(wv) = get(*a) else { return pos[i] };
                let v = wv * k;
                if abs {
                    return v;
                }
                if pos[i].is_nan() {
                    note(&mut notes, "relative");
                    unknown = true;
                    return f64::NAN;
                }
                pos[i] + v
            })
            .collect();
        let mut count = |i: usize, v: f64| {
            if blind[i] {
                return;
            }
            if i == 2 && later {
                match &mut z_later {
                    None => z_later = Some(ZRange { min: v, max: v }),
                    Some(z) => {
                        if v < z.min {
                            z.min = v;
                        }
                        if v > z.max {
                            z.max = v;
                        }
                    }
                }
                return;
            }
            add(&mut min, &mut max, &mut used, i, v);
        };
        for (i, a) in axes.iter().enumerate() {
            if get(*a).is_some() && !to[i].is_nan() {
                count(i, to[i]);
            }
        }
        pos = to.clone();
        if unknown || motion < 2.0 {
            continue;
        }
        // Bogen: in seiner Ebene kann er über Start und Ziel hinausragen
        let (ia, ib) = match plane as i32 {
            18 => (2, 0),
            19 => (1, 2),
            _ => (0, 1),
        };
        if from[ia].is_nan() || from[ib].is_nan() || to[ia].is_nan() || to[ib].is_nan() {
            note(&mut notes, "relative");
            continue;
        }
        let cw = motion == 2.0;
        let (la, lb) = match plane as i32 {
            18 => ('K', 'I'),
            19 => ('J', 'K'),
            _ => ('I', 'J'),
        };
        let (ca, cb);
        if let (Some(rv), None, None) = (get('R'), get(la), get(lb)) {
            let r = rv * k;
            let (dx, dy) = (to[ia] - from[ia], to[ib] - from[ib]);
            let d = hypot2(dx, dy);
            if d < 1e-9 {
                continue;
            }
            let half = d / 2.0;
            let h = mx(0.0, r * r - half * half).sqrt();
            let sgn = if cw == (r > 0.0) { -1.0 } else { 1.0 };
            ca = from[ia] + dx / 2.0 + (sgn * h * -dy) / d;
            cb = from[ib] + dy / 2.0 + (sgn * h * dx) / d;
        } else {
            // w[la] || 0
            let or0 = |v: Option<f64>| v.filter(|v| *v != 0.0 && !v.is_nan()).unwrap_or(0.0);
            ca = from[ia] + or0(get(la)) * k;
            cb = from[ib] + or0(get(lb)) * k;
        }
        let [a0, a1, b0, b1] = arc_extents(from[ia], from[ib], to[ia], to[ib], ca, cb, cw);
        count(ia, a0);
        count(ia, a1);
        count(ib, b0);
        count(ib, b1);
    }
    JobExtents { min, max, used, z_later, mach_min, mach_max, mach_used, notes: notes.iter().map(|s| s.to_string()).collect() }
}

/// Erlaubter Maschinen-Bereich einer Achse aus Weg und aktueller Position, oder None, wenn nicht eindeutig
pub fn axis_range(travel: f64, mpos: f64, inverted: bool, pulloff: f64) -> Option<(f64, f64)> {
    if !(travel > 0.0) || !mpos.is_finite() {
        return None;
    }
    // Math.max(1, pulloff || 0) + 0.5
    let tol = mx(1.0, if pulloff.is_nan() { 0.0 } else { pulloff }) + 0.5;
    if mpos < -travel - tol || mpos > travel + tol {
        return None;
    }
    if mpos < -tol {
        return Some((-travel, 0.0));
    }
    if mpos > tol {
        return if inverted { Some((0.0, travel)) } else { None };
    }
    if inverted {
        None
    } else {
        Some((-travel, 0.0))
    }
}

const EPS: f64 = 0.005;

pub fn check_limits(ext: &JobExtents, env: &LimitEnv) -> LimitResult {
    let mut res = LimitResult { over: vec![], z_later_over: vec![], unknown_axes: vec![], no_settings: vec![], not_homed: !env.homed };
    let at = |v: &[f64], i: usize| v.get(i).copied().unwrap_or(f64::NAN);
    for i in 0..3 {
        if env.skip.as_ref().is_some_and(|s| s.contains(&i)) {
            continue;
        }
        let axis = ["X", "Y", "Z"][i].to_string();
        let over = |kind: &str, by: f64| LimitOver { axis: axis.clone(), kind: kind.into(), by };
        let later = if i == 2 { ext.z_later.as_ref() } else { None };
        if !ext.used[i] && !ext.mach_used[i] && later.is_none() {
            continue;
        }
        let travel = at(&env.travel, i);
        if !(travel > 0.0) {
            res.no_settings.push(axis);
            continue;
        }
        if ext.used[i] && ext.max[i] - ext.min[i] > travel + EPS {
            res.over.push(over("span", ext.max[i] - ext.min[i] - travel));
        }
        if !env.homed {
            continue;
        }
        let Some((lo, hi)) = axis_range(travel, at(&env.mpos, i), (env.home_dir_mask >> i) & 1 == 1, env.pulloff) else {
            res.unknown_axes.push(axis);
            continue;
        };
        let wco = at(&env.mpos, i) - at(&env.wpos, i);
        let (mut high, mut low) = (f64::NEG_INFINITY, f64::INFINITY);
        if ext.used[i] {
            high = ext.max[i] + wco;
            low = ext.min[i] + wco;
        }
        if ext.mach_used[i] {
            high = mx(high, ext.mach_max[i]);
            low = mn(low, ext.mach_min[i]);
        }
        if high > hi + EPS {
            res.over.push(over("+", high - hi));
        }
        if low < lo - EPS {
            res.over.push(over("-", lo - low));
        }
        if let Some(l) = later {
            if l.max + wco > hi + EPS {
                res.z_later_over.push(over("+", l.max + wco - hi));
            }
            if l.min + wco < lo - EPS {
                res.z_later_over.push(over("-", lo - l.min - wco));
            }
        }
    }
    res
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
                assert_eq!(x.keys().collect::<Vec<_>>(), y.keys().collect::<Vec<_>>(), "{at}: keys");
                for (k, p) in x {
                    same(p, &y[k], &format!("{at}.{k}"));
                }
            }
            _ => assert_eq!(a, b, "{at}"),
        }
    }

    #[test]
    fn pieces() {
        let c: Vec<char> = "X1.2.3 Y-.5 Z1. A+3".chars().collect();
        assert_eq!(word(&c, 0).map(|w| w.2), Some("1.2".into()));
        assert_eq!(word(&c, 7).map(|w| w.2), Some("-.5".into()));
        assert_eq!(word(&c, 12).map(|w| w.2), Some("1".into()));
        assert_eq!(word(&c, 16).map(|w| w.2), Some("+3".into()));
        assert_eq!(axis_range(300.0, 150.0, true, 1.0), Some((0.0, 300.0)));
        assert_eq!(axis_range(300.0, 0.0, true, f64::NAN), None);
    }

    #[test]
    fn same_result_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("softlimits-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        let envs: Vec<LimitEnv> = serde_json::from_value(all["envs"].clone()).unwrap();
        let cases = all["cases"].as_array().unwrap();
        assert!(cases.len() >= 45, "only {} jobs", cases.len());
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let lines: Vec<String> = c["text"].as_str().unwrap().split('\n').map(String::from).collect();
            let start: ScanStart = serde_json::from_value(c["start"].clone()).unwrap();
            let ext = scan_job_extents(&lines, &start);
            same(&serde_json::to_value(&ext).unwrap(), &c["ext"], &format!("{name}: extents"));
            for (k, e) in envs.iter().enumerate() {
                same(&serde_json::to_value(check_limits(&ext, e)).unwrap(), &c["res"][k], &format!("{name}: machine state {k}"));
            }
        }
        println!("{} jobs × {} machine states checked the same as softLimits.ts", cases.len(), envs.len());
    }
}
