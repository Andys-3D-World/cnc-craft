//! VERKNÜPFTE KOPIEN (Serienteile) – Zwilling von `src/linkedCopies.ts`: starre Abbildungen (compose, invert, fitRigid),
//! Kontrollpunkte, Stempel des Originals, Kopie aus dem Original bauen (materialize), Abgleich nach einer Aktion
//! (syncLinks), Auffrischen ohne „vorher“ (refreshLinks), Generator neu (relinkRun) und die kleinen Helfer.
//!
//! Formen sind die Objekte des Fensters (JSON, Felder in derselben Reihenfolge – serde_json mit preserve_order).
//! Wo das Fenster Formen als JSON-Text vergleicht, tut Rust das auch (`js_json` = JSON.stringify). Nur Vergleich:
//! die Kopien baut weiter das Fenster. Fälle: `tests/fixtures/linkedcopies-cases.json.gz`.

use crate::jsmath::{self, js_num, js_round};
use crate::shapes::{num, rotate_shape, scale_shape, translate_shape, truthy, Pt};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub type Mat = [f64; 6];
pub const IDENT: Mat = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
pub const FIT_TOL: f64 = 0.002;

/// JSON.stringify(v) (Felder in ihrer Reihenfolge, Zahlen wie JavaScript)
pub fn js_json(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f.is_finite() {
                js_num(f)
            } else {
                "null".into()
            }
        }
        Value::String(s) => serde_json::to_string(s).unwrap(),
        Value::Array(a) => format!("[{}]", a.iter().map(js_json).collect::<Vec<_>>().join(",")),
        Value::Object(o) => format!("{{{}}}", o.iter().map(|(k, x)| format!("{}:{}", serde_json::to_string(k).unwrap(), js_json(x))).collect::<Vec<_>>().join(",")),
    }
}
/// JSON.stringify(x) mit undefined (= fehlt) → None
fn json_opt(v: Option<&Value>) -> Option<String> {
    v.map(js_json)
}
/// String(v) in JavaScript (undefined = fehlt)
fn js_str(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => js_num(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Null) => "null".into(),
        Some(Value::Array(a)) => a.iter().map(|e| if e.is_null() { String::new() } else { js_str(Some(e)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}
/// Schlüssel einer Map in JavaScript (gleicher Wert = gleicher Schlüssel): Typ und Inhalt
fn map_key(v: Option<&Value>) -> String {
    match v {
        None => "u".into(),
        Some(v) => format!("{}:{}", if v.is_string() { "s" } else { "j" }, js_json(v)),
    }
}
fn id_of(s: &Value) -> Option<&str> {
    s.get("id").and_then(|v| v.as_str())
}

fn tidy(v: f64) -> f64 {
    if v.abs() < 1e-12 {
        0.0
    } else {
        v
    }
}

/// p ∘ q (erst q, dann p)
pub fn compose(p: &Mat, q: &Mat) -> Mat {
    [
        tidy(p[0] * q[0] + p[2] * q[1]),
        tidy(p[1] * q[0] + p[3] * q[1]),
        tidy(p[0] * q[2] + p[2] * q[3]),
        tidy(p[1] * q[2] + p[3] * q[3]),
        p[0] * q[4] + p[2] * q[5] + p[4],
        p[1] * q[4] + p[3] * q[5] + p[5],
    ]
}
pub fn invert(m: &Mat) -> Mat {
    let det = m[0] * m[3] - m[1] * m[2];
    let (a, b, c, d) = (m[3] / det, -m[1] / det, -m[2] / det, m[0] / det);
    [tidy(a), tidy(b), tidy(c), tidy(d), -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]
}
pub fn apply_pt(m: &Mat, p: Pt) -> Pt {
    Pt { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] }
}
pub fn is_ident(m: &Mat) -> bool {
    m.iter().zip(IDENT.iter()).all(|(v, i)| (v - i).abs() < 1e-12)
}
fn mat_json(m: &Mat) -> Value {
    json!(m.to_vec())
}

/// Abbildung aus fremden Daten: sechs endliche Zahlen, starr – sonst None
pub fn clean_mat(v: Option<&Value>) -> Option<Mat> {
    let a = v?.as_array()?;
    if a.len() != 6 {
        return None;
    }
    let mut m = [0.0; 6];
    for (i, x) in a.iter().enumerate() {
        let f = x.as_f64()?;
        if !f.is_finite() {
            return None;
        }
        m[i] = f;
    }
    let [a, b, c, d, e, f] = m;
    if (a * a + b * b - 1.0).abs() > 1e-6 || (c * c + d * d - 1.0).abs() > 1e-6 || (a * c + b * d).abs() > 1e-6 {
        return None;
    }
    if e.abs() > 1e7 || f.abs() > 1e7 {
        return None;
    }
    Some(m)
}
pub fn frame_of(s: &Value) -> Mat {
    clean_mat(s.get("linkFrame")).unwrap_or(IDENT)
}
pub fn is_linked(s: &Value) -> bool {
    s.is_object() && truthy(s.get("link")) && s["link"].get("of").is_some_and(|v| v.is_string())
}
fn link_of(s: &Value) -> &str {
    s["link"]["of"].as_str().unwrap_or("")
}

/// s?.x ?? 0
fn num0(s: &Value, k: &str) -> f64 {
    match s.get(k) {
        None | Some(Value::Null) => 0.0,
        _ => num(s, k),
    }
}
/// Kontrollpunkte (gleiche Reihenfolge vor und nach Verschieben/Drehen/Spiegeln)
pub fn control_points(s: &Value) -> Vec<Pt> {
    let p = |x: f64, y: f64| Pt { x, y };
    match s.get("type").and_then(|t| t.as_str()) {
        Some("polyline") | Some("image") => s.get("points").and_then(|v| v.as_array()).map(|a| a.iter().map(|q| p(num(q, "x"), num(q, "y"))).collect()).unwrap_or_default(),
        Some("circle") => vec![p(num(s, "x"), num(s, "y"))],
        Some("arc") => vec![p(num(s, "x"), num(s, "y")), p(num(s, "x") + num(s, "w"), num(s, "y") + num(s, "h")), p(num(s, "midX"), num(s, "midY"))],
        Some("rect") => {
            let (x, y, w, h) = (num(s, "x"), num(s, "y"), num(s, "w"), num(s, "h"));
            crate::shapes::make_rect_points(x, y, x + w, y + h, 0.0).into_iter().map(|q| p(q.x, q.y)).collect()
        }
        _ => {
            let (x, y) = (num0(s, "x"), num0(s, "y"));
            vec![p(x, y), p(x + num0(s, "w"), y + num0(s, "h"))]
        }
    }
}

/// Starre Abbildung (drehen + verschieben, oder spiegeln + drehen + verschieben), die from Punkt für Punkt auf to legt
pub fn fit_rigid(from: &[Pt], to: &[Pt], tol: f64) -> Option<Mat> {
    let n = from.len();
    if n == 0 || n != to.len() {
        return None;
    }
    let (mut fx, mut fy, mut tx, mut ty) = (0.0, 0.0, 0.0, 0.0);
    for i in 0..n {
        fx += from[i].x;
        fy += from[i].y;
        tx += to[i].x;
        ty += to[i].y;
    }
    let nf = n as f64;
    fx /= nf;
    fy /= nf;
    tx /= nf;
    ty /= nf;
    let try_fit = |mirror: bool| -> Option<Mat> {
        let sg = if mirror { -1.0 } else { 1.0 };
        let (mut sxx, mut sxy) = (0.0, 0.0);
        for i in 0..n {
            let (ux, uy, vx, vy) = (sg * (from[i].x - fx), from[i].y - fy, to[i].x - tx, to[i].y - ty);
            sxx += ux * vx + uy * vy;
            sxy += ux * vy - uy * vx;
        }
        let mut ang = if sxx.abs() + sxy.abs() < 1e-12 { 0.0 } else { jsmath::atan2(sxy, sxx) };
        if ang.abs() < 1e-10 {
            ang = 0.0;
        }
        let (c, s) = (tidy(jsmath::cos(ang)), tidy(jsmath::sin(ang)));
        let (a, b, cc, d) = (sg * c, sg * s, -s, c);
        let e = tx - (a * fx + cc * fy);
        let f = ty - (b * fx + d * fy);
        let m = [a, b, cc, d, e, f];
        for i in 0..n {
            let p = apply_pt(&m, from[i]);
            if (p.x - to[i].x).abs() > tol || (p.y - to[i].y).abs() > tol {
                return None;
            }
        }
        Some(m)
    };
    try_fit(false).or_else(|| try_fit(true))
}

/// Form mit einer starren Abbildung bewegen – mit denselben Schritten wie im Fenster
pub fn apply_rigid(s: &mut Value, m: &Mat) {
    let mirror = m[0] * m[3] - m[1] * m[2] < 0.0;
    let ang = if mirror { jsmath::atan2(-m[1], -m[0]) } else { jsmath::atan2(m[1], m[0]) };
    if mirror {
        scale_shape(s, 0.0, 0.0, -1.0, 1.0);
    }
    if ang.abs() > 1e-12 {
        rotate_shape(s, 0.0, 0.0, ang);
    }
    // if (m[4] || m[5])
    if (m[4] != 0.0 && !m[4].is_nan()) || (m[5] != 0.0 && !m[5].is_nan()) {
        translate_shape(s, m[4], m[5]);
    }
}

const OWN: [&str; 6] = ["id", "groupId", "link", "linkFrame", "gen", "ngOut"];
const GEOM: [&str; 13] = ["type", "points", "closed", "x", "y", "w", "h", "midX", "midY", "bez", "textPath", "rotation", "cutDir"];

/// Alle Einstellungen einer Form als vergleichbarer Text
pub fn settings_key(s: &Value) -> String {
    let empty = Map::new();
    let o = s.as_object().unwrap_or(&empty);
    let mut keys: Vec<&String> = o.keys().filter(|k| !OWN.contains(&k.as_str()) && !GEOM.contains(&k.as_str())).collect();
    keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let mut parts: Vec<String> = keys.iter().map(|k| format!("[{},{}]", serde_json::to_string(k).unwrap(), js_json(&o[*k]))).collect();
    if s.get("type").and_then(|t| t.as_str()) == Some("circle") {
        // Math.abs(Number(s.w) || 0)
        let w = match s.get("w") {
            Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
            Some(Value::Bool(true)) => 1.0,
            Some(Value::String(t)) => t.trim().parse::<f64>().unwrap_or(0.0),
            _ => 0.0,
        };
        let w = if w == 0.0 || w.is_nan() { 0.0 } else { w };
        parts.push(format!("[\"~r\",{}]", js_num(w.abs())));
    }
    format!("[{}]", parts.join(","))
}

fn r4(v: f64) -> f64 {
    js_round(v * 1e4) / 1e4
}
fn base36(mut v: u64) -> String {
    if v == 0 {
        return "0".into();
    }
    let mut out = vec![];
    while v > 0 {
        out.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(v % 36) as usize]);
        v /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// Stempel eines Originals: Einstellungen und Form im eigenen Rahmen
pub fn source_stamp(src: &Value) -> String {
    let inv = invert(&frame_of(src));
    let pts = control_points(src).into_iter().map(|p| apply_pt(&inv, p)).map(|p| format!("{},{}", js_num(r4(p.x)), js_num(r4(p.y)))).collect::<Vec<_>>().join(";");
    let text = format!("{}|{}|{}|{}", js_str(src.get("type")), if truthy(src.get("closed")) { 1 } else { 0 }, pts, settings_key(src));
    let mut h: u32 = 0x811c9dc5;
    let mut len = 0u64;
    for c in text.encode_utf16() {
        h ^= c as u32;
        h = h.wrapping_mul(0x01000193);
        len += 1;
    }
    format!("{}{}", base36(h as u64), base36(len))
}

/// Kopie aus dem Original bauen: Form und Einstellungen von src, id/Gruppe von copy, mit m gelegt
pub fn materialize(src: &Value, copy: &mut Value, m: &Mat) {
    let mut n = src.clone();
    if let Some(o) = n.as_object_mut() {
        for k in OWN {
            o.shift_remove(k);
        }
        if let Some(id) = copy.get("id") {
            o.insert("id".into(), id.clone());
        }
        if truthy(copy.get("groupId")) {
            o.insert("groupId".into(), copy["groupId"].clone());
        }
    }
    apply_rigid(&mut n, &compose(m, &invert(&frame_of(src))));
    let link = json!({ "of": src.get("id").cloned().unwrap_or(Value::Null), "m": mat_json(m), "h": source_stamp(src) });
    if src.get("id").is_none() {
        // { of: undefined } → JSON ohne of
        let mut l = link;
        l.as_object_mut().unwrap().shift_remove("of");
        n.as_object_mut().map(|o| o.insert("link".into(), l));
    } else if let Some(o) = n.as_object_mut() {
        o.insert("link".into(), link);
    }
    *copy = n;
}

/// Abbildung (zum Rahmen des Originals), die src genau auf copy legt
pub fn placement_of(src: &Value, copy: &Value) -> Option<Mat> {
    fit_rigid(&control_points(src), &control_points(copy), FIT_TOL).map(|a| compose(&a, &frame_of(src)))
}

#[derive(Default, Debug, PartialEq)]
pub struct SyncResult {
    pub blocked: f64,
    pub orphaned: f64,
    pub changed: bool,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Loc {
    Shapes(usize),
    Other(usize, usize),
}

/// Nach einer Aktion: Kopien und Originale in shapes abgleichen (siehe syncLinks in linkedCopies.ts)
pub fn sync_links(shapes: &mut [Value], before: &[Value], others: &[Vec<Value>]) -> SyncResult {
    let mut res = SyncResult::default();
    let mut was: HashMap<String, &Value> = HashMap::new();
    for s in before {
        if let Some(id) = id_of(s) {
            was.insert(id.to_string(), s);
        }
    }
    let mut lookup: HashMap<String, Loc> = HashMap::new();
    for (l, list) in others.iter().enumerate() {
        for (i, s) in list.iter().enumerate() {
            if !s.is_null() {
                lookup.insert(map_key(s.get("id")), Loc::Other(l, i));
            }
        }
    }
    for (i, s) in shapes.iter().enumerate() {
        lookup.insert(map_key(s.get("id")), Loc::Shapes(i));
    }
    let mut referenced: HashSet<String> = HashSet::new();
    for s in shapes.iter().chain(others.iter().flatten()) {
        if is_linked(s) {
            referenced.insert(link_of(s).to_string());
        }
    }
    let unit_of = |s: &Value| if truthy(s.get("groupId")) { s.get("groupId").cloned() } else { s.get("id").cloned() };
    let canonical = |s: &Value| {
        let inv = invert(&frame_of(s));
        control_points(s).into_iter().map(|p| apply_pt(&inv, p)).collect::<Vec<_>>()
    };
    let get = |shapes: &[Value], loc: Loc| -> Value {
        match loc {
            Loc::Shapes(i) => shapes[i].clone(),
            Loc::Other(l, i) => others[l][i].clone(),
        }
    };

    // 1. Originale, als ganzes Teil bewegt: ihr Rahmen geht mit
    let mut src_units: Vec<(String, Vec<usize>)> = vec![];
    for (i, s) in shapes.iter().enumerate() {
        let Some(id) = id_of(s) else { continue };
        if is_linked(s) || !referenced.contains(id) || !was.contains_key(id) {
            continue;
        }
        let k = map_key(unit_of(s).as_ref());
        match src_units.iter_mut().find(|u| u.0 == k) {
            Some(u) => u.1.push(i),
            None => src_units.push((k, vec![i])),
        }
    }
    for (_, members) in &src_units {
        if members.iter().all(|&i| js_json(was[id_of(&shapes[i]).unwrap()]) == js_json(&shapes[i])) {
            continue;
        }
        let from: Vec<Pt> = members.iter().flat_map(|&i| control_points(was[id_of(&shapes[i]).unwrap()])).collect();
        let to: Vec<Pt> = members.iter().flat_map(|&i| control_points(&shapes[i])).collect();
        let r = fit_rigid(&from, &to, FIT_TOL);
        for &i in members {
            let old = was[id_of(&shapes[i]).unwrap()];
            let f = match &r {
                Some(r) => compose(r, &frame_of(old)),
                None => frame_of(old),
            };
            let prev = json_opt(shapes[i].get("linkFrame"));
            let o = shapes[i].as_object_mut().unwrap();
            if is_ident(&f) {
                o.shift_remove("linkFrame");
            } else {
                o.insert("linkFrame".into(), mat_json(&f));
            }
            if json_opt(shapes[i].get("linkFrame")) != prev {
                res.changed = true;
            }
        }
    }

    // 2. Kopien je gelegtem Teil
    let mut copy_units: Vec<(String, Vec<(usize, Loc)>)> = vec![];
    for i in 0..shapes.len() {
        if !is_linked(&shapes[i]) {
            continue;
        }
        let src = lookup.get(&map_key(shapes[i]["link"].get("of"))).copied();
        let bad = match src {
            None => true,
            Some(Loc::Shapes(j)) if j == i => true,
            Some(loc) => is_linked(&get(shapes, loc)),
        };
        if bad {
            shapes[i].as_object_mut().unwrap().shift_remove("link");
            res.orphaned += 1.0;
            res.changed = true;
            continue;
        }
        let src = src.unwrap();
        let k = format!("{}|{}", js_str(unit_of(&shapes[i]).as_ref()), js_str(unit_of(&get(shapes, src)).as_ref()));
        match copy_units.iter_mut().find(|u| u.0 == k) {
            Some(u) => u.1.push((i, src)),
            None => copy_units.push((k, vec![(i, src)])),
        }
    }
    let was_of = |s: &Value| id_of(s).and_then(|id| was.get(id).copied());
    for (_, unit) in &copy_units {
        let touched = unit.iter().any(|&(c, _)| match was_of(&shapes[c]) {
            None => true,
            Some(w) => js_json(w) != js_json(&shapes[c]),
        });
        let stored: Vec<Option<Mat>> = unit.iter().map(|&(c, _)| clean_mat(shapes[c]["link"].get("m"))).collect();
        let mut m: Option<Mat> = None;
        if touched || stored.iter().any(|x| x.is_none()) {
            let from: Vec<Pt> = unit
                .iter()
                .flat_map(|&(_, s)| {
                    let src = get(shapes, s);
                    canonical(was_of(&src).unwrap_or(&src))
                })
                .collect();
            let to: Vec<Pt> = unit.iter().flat_map(|&(c, _)| control_points(&shapes[c])).collect();
            m = fit_rigid(&from, &to, FIT_TOL);
            if m.is_some() {
                for &(c, s) in unit {
                    if let Some(c_old) = was_of(&shapes[c]) {
                        let k = settings_key(&shapes[c]);
                        if k != settings_key(c_old) && k != settings_key(&get(shapes, s)) {
                            res.blocked += 1.0;
                            break;
                        }
                    }
                }
            } else if unit.iter().any(|&(c, _)| was_of(&shapes[c]).is_some()) {
                res.blocked += 1.0;
            }
        }
        for (i, &(c, s)) in unit.iter().enumerate() {
            let mi = m.or(if was_of(&shapes[c]).is_some() { stored[i] } else { None });
            let Some(mi) = mi else {
                shapes[c].as_object_mut().unwrap().shift_remove("link");
                res.changed = true;
                continue;
            };
            let src = get(shapes, s);
            let s_old = was_of(&src).cloned().unwrap_or_else(|| src.clone());
            if m.is_none() && !touched && js_json(&s_old) == js_json(&src) {
                continue;
            }
            let old = js_json(&shapes[c]);
            materialize(&src, &mut shapes[c], &mi);
            if js_json(&shapes[c]) != old {
                res.changed = true;
            }
        }
    }
    res
}

/// Vergleichbarer Text: Schlüssel sortiert, Zahlen auf 1e-6 gerundet
fn canon(v: &Value) -> String {
    match v {
        Value::Number(n) => js_num(js_round(n.as_f64().unwrap_or(f64::NAN) * 1e6) / 1e6),
        Value::Array(a) => format!("[{}]", a.iter().map(canon).collect::<Vec<_>>().join(",")),
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            format!("{{{}}}", keys.iter().map(|k| format!("{}:{}", serde_json::to_string(k).unwrap(), canon(&o[*k]))).collect::<Vec<_>>().join(","))
        }
        _ => js_json(v),
    }
}
fn without_link(v: &Value) -> Value {
    let mut c = v.clone();
    if let Some(o) = c.as_object_mut() {
        o.shift_remove("link");
    }
    c
}

/// Ohne „vorher“: nur Kopien neu bauen, deren Original sich seit dem letzten Bau geändert hat (Stempel h).
/// lists = alle Listen; geändert wird lists[li]. indexed: lists[li] gehört selbst zum Index (shapeIndex im Fenster)
pub fn refresh_links(lists: &mut [Vec<Value>], li: usize, indexed: bool) -> bool {
    let mut changed = false;
    // shapeIndex: alle Formen mit Text-id, spätere gewinnen
    let mut lookup: HashMap<String, (usize, usize)> = HashMap::new();
    for (l, list) in lists.iter().enumerate() {
        if l == li && !indexed {
            continue;
        }
        for (i, s) in list.iter().enumerate() {
            if let Some(id) = id_of(s) {
                lookup.insert(id.to_string(), (l, i));
            }
        }
    }
    for i in 0..lists[li].len() {
        if !is_linked(&lists[li][i]) {
            continue;
        }
        let src = lookup.get(link_of(&lists[li][i])).copied();
        let bad = match src {
            None => true,
            Some((l, j)) if l == li && j == i => true,
            Some((l, j)) => is_linked(&lists[l][j]),
        };
        if bad {
            lists[li][i].as_object_mut().unwrap().shift_remove("link");
            changed = true;
            continue;
        }
        let (sl, sj) = src.unwrap();
        let src = lists[sl][sj].clone();
        let stamp = source_stamp(&src);
        if lists[li][i]["link"].get("h").and_then(|h| h.as_str()) == Some(stamp.as_str()) {
            continue;
        }
        let Some(m) = clean_mat(lists[li][i]["link"].get("m")).or_else(|| placement_of(&src, &lists[li][i])) else {
            lists[li][i].as_object_mut().unwrap().shift_remove("link");
            changed = true;
            continue;
        };
        let keep = lists[li][i].clone();
        let old = canon(&without_link(&keep));
        materialize(&src, &mut lists[li][i], &m);
        // nur Rundungsrauschen: die alten Zahlen behalten, nur die Verknüpfung neu
        if canon(&without_link(&lists[li][i])) == old {
            let mut c = keep;
            c.as_object_mut().unwrap().insert("link".into(), json!({ "of": src.get("id").cloned().unwrap_or(Value::Null), "m": mat_json(&m), "h": stamp }));
            lists[li][i] = c;
        }
        changed = true;
    }
    changed
}

/// Generator neu gelaufen: Kopien der alten Teile zeigen auf die neuen (ids: die Reihe, die newId im Fenster gab)
pub fn relink_run(lists: &mut [Vec<Value>], old_parts: &[Value], made: &[Value], ids: &[String]) -> Result<(), String> {
    let mut next = ids.iter();
    let mut new_id = || next.next().cloned().ok_or_else(|| "more new ids needed than the window made".to_string());
    let old_ids: HashMap<String, &Value> = old_parts.iter().filter_map(|s| id_of(s).map(|id| (id.to_string(), s))).collect();
    let gen_i = |s: &Value| s.get("gen").and_then(|g| g.get("i")).cloned();
    let is_int = |v: &Option<Value>| v.as_ref().and_then(|v| v.as_f64()).is_some_and(|f| f.is_finite() && f.fract() == 0.0);
    let same_shape = old_parts.len() == made.len()
        && old_parts.iter().all(|s| is_int(&gen_i(s)) && made.iter().any(|m| gen_i(m).and_then(|v| v.as_f64()) == gen_i(s).and_then(|v| v.as_f64())));
    // new Map(made.map(m => [m.gen?.i, m])): spätere gewinnen
    let by_index = |i: f64| made.iter().rev().find(|m| gen_i(m).and_then(|v| v.as_f64()) == Some(i));
    for list in lists.iter_mut() {
        let copies: Vec<usize> = (0..list.len()).filter(|&i| is_linked(&list[i]) && old_ids.contains_key(link_of(&list[i]))).collect();
        if copies.is_empty() {
            continue;
        }
        if same_shape {
            for &ci in &copies {
                let old = old_ids[link_of(&list[ci])];
                let nu = by_index(gen_i(old).and_then(|v| v.as_f64()).unwrap()).unwrap().clone();
                let m = clean_mat(list[ci]["link"].get("m")).or_else(|| placement_of(old, &list[ci])).unwrap_or(IDENT);
                materialize(&nu, &mut list[ci], &compose(&m, &invert(&frame_of(old))));
            }
            continue;
        }
        // gelegte Stücke: Kopien mit derselben Abbildung (alt → Kopie)
        let mut inst: Vec<(String, Mat, Vec<usize>)> = vec![];
        for &ci in &copies {
            let old = old_ids[link_of(&list[ci])];
            let m = clean_mat(list[ci]["link"].get("m")).or_else(|| placement_of(old, &list[ci])).unwrap_or(IDENT);
            let a = compose(&m, &invert(&frame_of(old)));
            let key = a.iter().map(|v| js_num(js_round(v * 1000.0))).collect::<Vec<_>>().join(",");
            match inst.iter_mut().find(|x| x.0 == key) {
                Some(x) => x.2.push(ci),
                None => inst.push((key, a, vec![ci])),
            }
        }
        // die Stellen gelten für die Liste zu Beginn; jedes Stück ersetzt seine Formen
        let mut current: Vec<(Value, Option<usize>)> = list.drain(..).enumerate().map(|(i, v)| (v, Some(i))).collect();
        for (_, a, members) in &inst {
            let at = current.iter().position(|(_, o)| *o == Some(members[0])).unwrap_or(current.len());
            let mut groups: Vec<(String, String)> = vec![];
            let mut fresh = vec![];
            for p in made {
                let mut c = Map::new();
                c.insert("id".into(), json!(new_id()?));
                if truthy(p.get("groupId")) {
                    let g = js_str(p.get("groupId"));
                    let gid = match groups.iter().find(|x| x.0 == g) {
                        Some(x) => x.1.clone(),
                        None => {
                            let v = format!("grp-{}", new_id()?);
                            groups.push((g, v.clone()));
                            v
                        }
                    };
                    c.insert("groupId".into(), json!(gid));
                }
                let mut c = Value::Object(c);
                materialize(p, &mut c, a);
                fresh.push((c, None));
            }
            let rest: Vec<(Value, Option<usize>)> = current.into_iter().filter(|(_, o)| !o.is_some_and(|o| members.contains(&o))).collect();
            let at = at.min(rest.len());
            let mut next_list = rest;
            next_list.splice(at..at, fresh);
            current = next_list;
        }
        *list = current.into_iter().map(|(v, _)| v).collect();
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Kleine Helfer und Auftrag des Fensters
// ---------------------------------------------------------------------

/// Projektdatei: nur saubere Verknüpfungen behalten
pub fn clean_links(list: &mut [Value]) {
    for s in list.iter_mut() {
        if !s.is_object() {
            continue;
        }
        if s.get("link").is_some() {
            let l = &s["link"];
            let m = clean_mat(l.get("m"));
            let of = l.get("of").and_then(|v| v.as_str()).map(|v| v.to_string());
            let bad = !truthy(Some(l)) || of.as_ref().is_none_or(|o| o.is_empty() || o.encode_utf16().count() > 60 || Some(o.as_str()) == id_of(s));
            if bad {
                s.as_object_mut().unwrap().shift_remove("link");
            } else {
                let mut nl = Map::new();
                nl.insert("of".into(), json!(of.unwrap()));
                if let Some(m) = m {
                    nl.insert("m".into(), mat_json(&m));
                }
                if let Some(h) = l.get("h").and_then(|v| v.as_str()).filter(|h| h.encode_utf16().count() <= 40) {
                    nl.insert("h".into(), json!(h));
                }
                s.as_object_mut().unwrap().insert("link".into(), Value::Object(nl));
            }
        }
        if s.get("linkFrame").is_some() && clean_mat(s.get("linkFrame")).is_none() {
            s.as_object_mut().unwrap().shift_remove("linkFrame");
        }
    }
}

fn shapes_of(v: Option<&Value>) -> Vec<Value> {
    v.and_then(|v| v.as_array()).cloned().unwrap_or_default()
}
fn lists_of(v: Option<&Value>) -> Vec<Vec<Value>> {
    v.and_then(|v| v.as_array()).map(|a| a.iter().map(|l| shapes_of(Some(l))).collect()).unwrap_or_default()
}

/// Auftrag des Fensters (linked.ts, beds.ts): sync / refresh / relink / clean
pub fn run(job: &Value) -> Result<Value, String> {
    match job.get("kind").and_then(|v| v.as_str()) {
        Some("sync") => {
            let mut shapes = shapes_of(job.get("shapes"));
            let r = sync_links(&mut shapes, &shapes_of(job.get("before")), &lists_of(job.get("others")));
            Ok(json!({ "shapes": shapes, "res": { "blocked": r.blocked, "orphaned": r.orphaned, "changed": r.changed } }))
        }
        Some("refresh") => {
            // same ≥ 0: die Liste ist lists[same]; sonst kommt sie extra (list) und steht nicht im Index
            let mut lists = lists_of(job.get("lists"));
            let same = job.get("same").and_then(|v| v.as_i64()).unwrap_or(-1);
            let li = if same >= 0 && (same as usize) < lists.len() {
                same as usize
            } else {
                lists.push(shapes_of(job.get("list")));
                lists.len() - 1
            };
            let changed = refresh_links(&mut lists, li, same >= 0);
            Ok(json!({ "list": lists[li], "changed": changed }))
        }
        Some("relink") => {
            let mut lists = lists_of(job.get("lists"));
            let ids: Vec<String> = job.get("ids").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            relink_run(&mut lists, &shapes_of(job.get("oldParts")), &shapes_of(job.get("made")), &ids)?;
            Ok(json!(lists))
        }
        Some("clean") => {
            let mut list = shapes_of(job.get("list"));
            clean_links(&mut list);
            Ok(json!(list))
        }
        Some("stamp") => Ok(json!(shapes_of(job.get("shapes")).iter().map(|s| json!({ "stamp": source_stamp(s), "key": settings_key(s), "cp": control_points(s).iter().map(|p| json!({ "x": p.x, "y": p.y })).collect::<Vec<_>>() })).collect::<Vec<_>>())),
        k => Err(format!("unknown job {k:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// Zahlen auf 1e-9, der Rest genau; Objekte zusätzlich in derselben Feld-Reihenfolge
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
                let (kx, ky): (Vec<_>, Vec<_>) = (x.keys().collect(), y.keys().collect());
                assert_eq!(kx, ky, "{at}: keys (order counts)");
                for (k, p) in x {
                    same(p, &y[k], &format!("{at}.{k}"));
                }
            }
            _ => assert_eq!(a, b, "{at}"),
        }
    }

    #[test]
    fn same_links_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("linkedcopies-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        for group in ["syncs", "refreshes", "relinks"] {
            for (i, c) in all[group].as_array().unwrap().iter().enumerate() {
                same(&run(&c["job"]).unwrap(), &c["want"], &format!("{group} {i}"));
            }
        }
        same(&run(&all["clean"]["job"]).unwrap(), &all["clean"]["want"], "cleanLinks");
        same(&run(&all["stamps"]["job"]).unwrap(), &all["stamps"]["want"], "stamps");
        println!("{} syncs, {} refreshes, {} relinks the same as linkedCopies.ts", all["syncs"].as_array().unwrap().len(), all["refreshes"].as_array().unwrap().len(), all["relinks"].as_array().unwrap().len());
    }
}
