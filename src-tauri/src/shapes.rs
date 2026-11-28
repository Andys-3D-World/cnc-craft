//! GEOMETRIE-GRUNDLAGE FÜR ALLE FORMEN – Zwilling von `src/shapeTransform.ts` (ohne newId/create…): Rechteck-, Ellipsen-
//! und Vieleck-Punkte, Bogen-Daten, Form → Punktezüge, Umriss-Box, verschieben, skalieren/spiegeln, drehen, scheren,
//! in Polylinie umwandeln, Abstand zum Anklicken, Punkt in Fläche, Fläche.
//!
//! Formen sind die Objekte des Fensters (JSON). Gearbeitet wird direkt darauf wie in JavaScript: fehlende Zahlen zählen
//! als NaN, null als 0, unbekannte Felder bleiben unverändert, neue Punkte haben nur x und y.
//! Nur Vergleich: verändert werden die Formen weiter im Fenster. Fälle: `tests/fixtures/shapes-cases.json.gz`.

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath;
use serde_json::{json, Map, Value};
use std::f64::consts::PI;

const ARC_TOL: f64 = 0.02;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}
fn pt(x: f64, y: f64) -> Pt {
    Pt { x, y }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Path {
    pub pts: Vec<Pt>,
    pub closed: bool,
    /// Polylinie: die Punkte der Form, wie sie sind (im Fenster dieselben Objekte; null bleibt beim Kopieren null)
    pub raw: Option<Vec<Value>>,
}
/// { x: q.x, y: q.y } in JavaScript: kopiert, was da ist (fehlt = kein Feld)
fn copy_xy(q: &Value) -> Value {
    let mut o = Map::new();
    for k in ["x", "y"] {
        if let Some(v) = q.get(k) {
            o.insert(k.into(), v.clone());
        }
    }
    Value::Object(o)
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

/// Zahl eines Felds wie in JavaScript gerechnet: fehlt (undefined) = NaN, null = 0, true/false = 1/0.
/// NaN einer Form im Fenster kommt als null an – so wie nach cloneShape (JSON) auch im Fenster
pub fn num(v: &Value, k: &str) -> f64 {
    match v.get(k) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        _ => f64::NAN,
    }
}
fn set(s: &mut Value, k: &str, v: f64) {
    if let Some(m) = s.as_object_mut() {
        m.insert(k.into(), json!(v));
    }
}
fn kind(s: &Value) -> &str {
    s.get("type").and_then(|t| t.as_str()).unwrap_or("")
}
/// !!v in JavaScript
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}
fn pt_of(v: &Value) -> Pt {
    pt(num(v, "x"), num(v, "y"))
}
fn pt_json(p: Pt) -> Value {
    json!({ "x": p.x, "y": p.y })
}
fn points_of(s: &Value) -> Vec<Pt> {
    s.get("points").and_then(|p| p.as_array()).map(|a| a.iter().map(pt_of).collect()).unwrap_or_default()
}

// =====================================================================
// FORMEN ERZEUGEN
// =====================================================================

fn arc_steps(r: f64, sweep: f64) -> f64 {
    if r <= ARC_TOL {
        return 4.0;
    }
    let max_step = 2.0 * jsmath::acos(mx(-1.0, 1.0 - ARC_TOL / r));
    mx(4.0, (sweep.abs() / max_step).ceil())
}
/// Schleife „for (i = 0; i <= steps; i++)“ – höchstens 10 Mio. (im Fenster hinge es sonst)
fn upto(steps: f64) -> usize {
    if steps >= 0.0 {
        steps.min(1e7) as usize
    } else {
        0
    }
}

/// Rechteck von (x0,y0) bis (x1,y1), optional mit runden Ecken. Gegen den Uhrzeigersinn
pub fn make_rect_points(x0: f64, y0: f64, x1: f64, y1: f64, radius: f64) -> Vec<Pt> {
    let (min_x, max_x) = (mn(x0, x1), mx(x0, x1));
    let (min_y, max_y) = (mn(y0, y1), mx(y0, y1));
    let r = mx(0.0, mn(mn(radius, (max_x - min_x) / 2.0), (max_y - min_y) / 2.0));
    if r <= 1e-6 {
        return vec![pt(min_x, min_y), pt(max_x, min_y), pt(max_x, max_y), pt(min_x, max_y)];
    }
    let mut pts = vec![];
    let mut corner = |cx: f64, cy: f64, a0: f64| {
        let steps = arc_steps(r, PI / 2.0);
        if steps.is_nan() {
            return;
        }
        for i in 0..=upto(steps) {
            let a = a0 + (PI / 2.0) * (i as f64 / steps);
            pts.push(pt(cx + r * jsmath::cos(a), cy + r * jsmath::sin(a)));
        }
    };
    corner(max_x - r, min_y + r, -PI / 2.0);
    corner(max_x - r, max_y - r, 0.0);
    corner(min_x + r, max_y - r, PI / 2.0);
    corner(min_x + r, min_y + r, PI);
    pts
}

/// Ellipse mit Mittelpunkt und Halbachsen. Gegen den Uhrzeigersinn
pub fn make_ellipse_points(cx: f64, cy: f64, rx: f64, ry: f64) -> Vec<Pt> {
    let steps = mx(24.0, arc_steps(mx(rx.abs(), ry.abs()), PI * 2.0));
    let mut pts = vec![];
    let mut i = 0.0;
    while i < steps && i < 1e7 {
        let a = (i / steps) * PI * 2.0;
        pts.push(pt(cx + rx.abs() * jsmath::cos(a), cy + ry.abs() * jsmath::sin(a)));
        i += 1.0;
    }
    pts
}

/// Regelmäßiges Vieleck: Mittelpunkt, Radius (zu den Ecken), Anzahl Ecken, Drehung der ersten Ecke
#[allow(dead_code)] // im Fenster beim Zeichnen: nur vom Test verglichen
pub fn make_polygon_points(cx: f64, cy: f64, r: f64, sides: f64, start_angle: f64) -> Vec<Pt> {
    let n = mx(3.0, jsmath::js_round(sides));
    let mut pts = vec![];
    let mut i = 0.0;
    while i < n && i < 1e7 {
        let a = start_angle + (i / n) * PI * 2.0;
        pts.push(pt(cx + r * jsmath::cos(a), cy + r * jsmath::sin(a)));
        i += 1.0;
    }
    pts
}

// =====================================================================
// FORM -> PUNKTEZÜGE
// =====================================================================

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArcGeo {
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
    pub start: f64,
    pub sweep: f64,
    pub clockwise: bool,
}

/// Bogen-Daten: Mittelpunkt, Radius, Start-/Endwinkel und Drehrichtung (berechne3PunktBogen in arcEngine.ts)
pub fn arc_geometry(s: &Value) -> Option<ArcGeo> {
    let (x1, y1, w, h) = (num(s, "x"), num(s, "y"), num(s, "w"), num(s, "h"));
    let (x2, y2, x3, y3) = (x1 + w, y1 + h, num(s, "midX"), num(s, "midY"));
    let d = 2.0 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
    if d.abs() < 0.1 {
        return None;
    }
    let cx = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
    let cy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;
    let r = hypot2(x1 - cx, y1 - cy);
    let start = jsmath::atan2(y1 - cy, x1 - cx);
    let end = jsmath::atan2(y2 - cy, x2 - cx);
    // Liegt der Mittelpunkt LINKS der Sehne Start->Ende, läuft der Bogen im Uhrzeigersinn
    let cross = (w * (y3 - y1)) - (h * (x3 - x1));
    let clockwise = cross > 0.0;
    let mut sweep = end - start;
    if clockwise {
        while sweep > 0.0 {
            sweep -= PI * 2.0;
        }
    } else {
        while sweep < 0.0 {
            sweep += PI * 2.0;
        }
    }
    Some(ArcGeo { cx, cy, r, start, sweep, clockwise })
}

pub fn shape_to_paths(s: &Value) -> Vec<Path> {
    let (x, y, w, h) = (num(s, "x"), num(s, "y"), num(s, "w"), num(s, "h"));
    match kind(s) {
        "polyline" => vec![Path { pts: points_of(s), closed: truthy(s.get("closed")), raw: Some(s.get("points").and_then(|p| p.as_array()).cloned().unwrap_or_default()) }],
        "line" => vec![Path { pts: vec![pt(x, y), pt(x + w, y + h)], closed: false, raw: None }],
        "circle" => {
            let r = w.abs();
            vec![Path { pts: make_ellipse_points(x, y, r, r), closed: true, raw: None }]
        }
        "arc" => {
            let Some(g) = arc_geometry(s) else { return vec![Path { pts: vec![pt(x, y), pt(x + w, y + h)], closed: false, raw: None }] };
            let steps = arc_steps(g.r, g.sweep);
            let mut pts = vec![];
            if !steps.is_nan() {
                for i in 0..=upto(steps) {
                    let a = g.start + g.sweep * (i as f64 / steps);
                    pts.push(pt(g.cx + g.r * jsmath::cos(a), g.cy + g.r * jsmath::sin(a)));
                }
            }
            vec![Path { pts, closed: false, raw: None }]
        }
        "rect" => vec![Path { pts: make_rect_points(x, y, x + w, y + h, 0.0), closed: true, raw: None }],
        _ => vec![],
    }
}

pub fn is_closed_shape(s: &Value) -> bool {
    let k = kind(s);
    k == "circle" || k == "rect" || (k == "polyline" && truthy(s.get("closed")))
}

// =====================================================================
// UMRISS-BOX
// =====================================================================

pub fn update_polyline_bounds(s: &mut Value) {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in points_of(s) {
        if p.x < min_x {
            min_x = p.x;
        }
        if p.x > max_x {
            max_x = p.x;
        }
        if p.y < min_y {
            min_y = p.y;
        }
        if p.y > max_y {
            max_y = p.y;
        }
    }
    set(s, "x", min_x);
    set(s, "y", min_y);
    set(s, "w", max_x - min_x);
    set(s, "h", max_y - min_y);
}

pub fn shape_bounds(s: &Value) -> Option<Bounds> {
    let (x, y, w, h) = (num(s, "x"), num(s, "y"), num(s, "w"), num(s, "h"));
    match kind(s) {
        "polyline" | "image" => Some(Bounds { min_x: x, min_y: y, max_x: x + w, max_y: y + h }),
        "circle" => {
            let r = w.abs();
            Some(Bounds { min_x: x - r, min_y: y - r, max_x: x + r, max_y: y + r })
        }
        "arc" => paths_bounds(&shape_to_paths(s)),
        "line" | "rect" | "path" => Some(Bounds { min_x: mn(x, x + w), min_y: mn(y, y + h), max_x: mx(x, x + w), max_y: mx(y, y + h) }),
        _ => None,
    }
}

fn paths_bounds(paths: &[Path]) -> Option<Bounds> {
    let mut b: Option<Bounds> = None;
    for p in paths {
        for q in &p.pts {
            match &mut b {
                None => b = Some(Bounds { min_x: q.x, min_y: q.y, max_x: q.x, max_y: q.y }),
                Some(b) => {
                    if q.x < b.min_x {
                        b.min_x = q.x;
                    }
                    if q.x > b.max_x {
                        b.max_x = q.x;
                    }
                    if q.y < b.min_y {
                        b.min_y = q.y;
                    }
                    if q.y > b.max_y {
                        b.max_y = q.y;
                    }
                }
            }
        }
    }
    b
}

pub fn group_bounds(shapes: &[Value]) -> Option<Bounds> {
    let mut b: Option<Bounds> = None;
    for s in shapes {
        let Some(sb) = shape_bounds(s) else { continue };
        match &mut b {
            None => b = Some(sb),
            Some(b) => {
                b.min_x = mn(b.min_x, sb.min_x);
                b.min_y = mn(b.min_y, sb.min_y);
                b.max_x = mx(b.max_x, sb.max_x);
                b.max_y = mx(b.max_y, sb.max_y);
            }
        }
    }
    b
}

// =====================================================================
// VERÄNDERN
// =====================================================================

/// Bézier-Knoten samt Tangenten und die Kurve von Text auf Pfad mitbewegen (neue Punkte: nur x und y)
fn map_bez_nodes(s: &mut Value, f: &dyn Fn(Pt) -> Pt) {
    let Some(m) = s.as_object_mut() else { return };
    if truthy(m.get("textPath")) {
        if let Some(Value::Object(tp)) = m.get("textPath") {
            let mut tp = tp.clone();
            if let Some(Value::Array(pts)) = tp.get("pts") {
                let mapped: Vec<Value> = pts.iter().map(|p| pt_json(f(pt_of(p)))).collect();
                tp.insert("pts".into(), Value::Array(mapped));
            }
            m.insert("textPath".into(), Value::Object(tp));
        }
    }
    if !truthy(m.get("bez")) {
        return;
    }
    if let Some(Value::Array(nodes)) = m.get("bez") {
        let out: Vec<Value> = nodes
            .iter()
            .map(|n| {
                let p = f(pt_of(n));
                let mut o = Map::new();
                o.insert("x".into(), json!(p.x));
                o.insert("y".into(), json!(p.y));
                for k in ["hi", "ho"] {
                    if truthy(n.get(k)) {
                        o.insert(k.into(), pt_json(f(pt_of(&n[k]))));
                    }
                }
                if truthy(n.get("smooth")) {
                    o.insert("smooth".into(), json!(true));
                }
                Value::Object(o)
            })
            .collect();
        m.insert("bez".into(), Value::Array(out));
    }
}

/// Punkte in ihren Objekten ändern (weitere Felder der Punkte bleiben)
fn map_points_in_place(s: &mut Value, f: &dyn Fn(Pt) -> Pt) {
    if let Some(Value::Array(pts)) = s.get_mut("points") {
        for p in pts.iter_mut() {
            let q = f(pt_of(p));
            set(p, "x", q.x);
            set(p, "y", q.y);
        }
    }
}
/// Neue Punkte (nur x und y), wie points.map(...)
fn map_points_new(s: &mut Value, f: &dyn Fn(Pt) -> Pt) {
    let pts: Vec<Value> = points_of(s).into_iter().map(|p| pt_json(f(p))).collect();
    if let Some(m) = s.as_object_mut() {
        m.insert("points".into(), Value::Array(pts));
    }
}

pub fn translate_shape(s: &mut Value, dx: f64, dy: f64) {
    let k = kind(s).to_string();
    if k == "polyline" || k == "image" {
        let f = |p: Pt| pt(p.x + dx, p.y + dy);
        map_bez_nodes(s, &f);
        map_points_in_place(s, &f);
        update_polyline_bounds(s);
        return;
    }
    let (x, y) = (num(s, "x"), num(s, "y"));
    set(s, "x", x + dx);
    set(s, "y", y + dy);
    if k == "arc" {
        let (mxv, myv) = (num(s, "midX"), num(s, "midY"));
        set(s, "midX", mxv + dx);
        set(s, "midY", myv + dy);
    }
}

/// Wandelt eine Form in eine Polylinie um
pub fn convert_to_polyline(s: &mut Value) {
    let paths = shape_to_paths(s);
    let Some(p) = paths.first() else { return };
    let pts: Vec<Value> = match &p.raw {
        Some(raw) => raw.iter().map(copy_xy).collect(),
        None => p.pts.iter().map(|q| pt_json(*q)).collect(),
    };
    let closed = p.closed;
    if let Some(m) = s.as_object_mut() {
        m.insert("type".into(), json!("polyline"));
        m.insert("points".into(), Value::Array(pts));
        m.insert("closed".into(), json!(closed));
        m.shift_remove("midX");
        m.shift_remove("midY");
    }
    update_polyline_bounds(s);
}

fn swap_cut_dir(s: &mut Value) {
    let d = s.get("cutDir").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if d == "cw" || d == "ccw" {
        if let Some(m) = s.as_object_mut() {
            m.insert("cutDir".into(), json!(if d == "cw" { "ccw" } else { "cw" }));
        }
    }
}

/// Skaliert eine Form um den Punkt (ox, oy). Negative Faktoren = spiegeln
pub fn scale_shape(s: &mut Value, ox: f64, oy: f64, sx: f64, sy: f64) {
    let fx = |x: f64| ox + (x - ox) * sx;
    let fy = |y: f64| oy + (y - oy) * sy;
    if sx * sy < 0.0 {
        swap_cut_dir(s);
    }
    if kind(s) == "circle" && (sx.abs() - sy.abs()).abs() > 1e-9 {
        let r = num(s, "w").abs();
        let pts = make_ellipse_points(num(s, "x"), num(s, "y"), r, r);
        if let Some(m) = s.as_object_mut() {
            m.insert("type".into(), json!("polyline"));
            m.insert("points".into(), Value::Array(pts.into_iter().map(pt_json).collect()));
            m.insert("closed".into(), json!(true));
        }
    }
    if kind(s) == "rect" {
        convert_to_polyline(s);
    }
    let k = kind(s).to_string();
    let (x, y, w, h) = (num(s, "x"), num(s, "y"), num(s, "w"), num(s, "h"));
    if k == "polyline" || k == "image" {
        let f = |p: Pt| pt(fx(p.x), fy(p.y));
        map_bez_nodes(s, &f);
        map_points_in_place(s, &f);
        update_polyline_bounds(s);
    } else if k == "circle" {
        set(s, "x", fx(x));
        set(s, "y", fy(y));
        let nw = (w * sx).abs();
        set(s, "w", nw);
        set(s, "h", nw);
    } else {
        let (ex, ey) = (fx(x + w), fy(y + h));
        let (nx, ny) = (fx(x), fy(y));
        set(s, "x", nx);
        set(s, "y", ny);
        set(s, "w", ex - nx);
        set(s, "h", ey - ny);
        if k == "arc" {
            let (mxv, myv) = (num(s, "midX"), num(s, "midY"));
            set(s, "midX", fx(mxv));
            set(s, "midY", fy(myv));
        }
    }
}

/// Dreht eine Form um (cx, cy). Winkel im Bogenmaß, positiv = gegen den Uhrzeigersinn
pub fn rotate_shape(s: &mut Value, cx: f64, cy: f64, angle: f64) {
    let (c, sn) = (jsmath::cos(angle), jsmath::sin(angle));
    let rot = |x: f64, y: f64| pt(cx + (x - cx) * c - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * c);
    if kind(s) == "rect" {
        convert_to_polyline(s);
    }
    let k = kind(s).to_string();
    let (x, y, w, h) = (num(s, "x"), num(s, "y"), num(s, "w"), num(s, "h"));
    if k == "polyline" || k == "image" {
        let f = |p: Pt| rot(p.x, p.y);
        map_bez_nodes(s, &f);
        map_points_new(s, &f);
        update_polyline_bounds(s);
    } else if k == "circle" {
        let p = rot(x, y);
        set(s, "x", p.x);
        set(s, "y", p.y);
    } else if k == "arc" || k == "line" {
        let a = rot(x, y);
        let e = rot(x + w, y + h);
        let m = if k == "arc" { Some(rot(num(s, "midX"), num(s, "midY"))) } else { None };
        set(s, "x", a.x);
        set(s, "y", a.y);
        set(s, "w", e.x - a.x);
        set(s, "h", e.y - a.y);
        if let Some(m) = m {
            set(s, "midX", m.x);
            set(s, "midY", m.y);
        }
    }
    set(s, "rotation", 0.0);
}

/// Schert eine Form um (cx, cy): x' = x + shx·(y − cy), y' = y + shy·(x − cx)
pub fn shear_shape(s: &mut Value, cx: f64, cy: f64, shx: f64, shy: f64) {
    if kind(s) != "polyline" {
        convert_to_polyline(s);
    }
    let f = |p: Pt| pt(p.x + shx * (p.y - cy), p.y + shy * (p.x - cx));
    map_bez_nodes(s, &f);
    map_points_new(s, &f);
    update_polyline_bounds(s);
    set(s, "rotation", 0.0);
    if 1.0 - shx * shy < 0.0 {
        swap_cut_dir(s);
    }
}

// =====================================================================
// ABSTÄNDE
// =====================================================================

pub fn seg_dist(px: f64, py: f64, a: Pt, b: Pt) -> f64 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let l2 = dx * dx + dy * dy;
    let mut t = if l2 > 0.0 { ((px - a.x) * dx + (py - a.y) * dy) / l2 } else { 0.0 };
    t = mx(0.0, mn(1.0, t));
    hypot2(px - (a.x + t * dx), py - (a.y + t * dy))
}

pub fn distance_to_shape(px: f64, py: f64, s: &Value) -> f64 {
    if kind(s) == "circle" {
        return (hypot2(px - num(s, "x"), py - num(s, "y")) - num(s, "w").abs()).abs();
    }
    if kind(s) == "image" {
        let pts = points_of(s);
        if point_in_path(px, py, &pts) {
            return 0.0;
        }
        let mut d = f64::INFINITY;
        let g = |i: usize| pts.get(i).copied().unwrap_or(pt(f64::NAN, f64::NAN));
        for i in 0..4 {
            d = mn(d, seg_dist(px, py, g(i), g((i + 1) % 4)));
        }
        return d;
    }
    let mut best = f64::INFINITY;
    for path in shape_to_paths(s) {
        let n = path.pts.len();
        let last = if path.closed { n } else { n.saturating_sub(1) };
        for i in 0..last {
            let d = seg_dist(px, py, path.pts[i], path.pts[(i + 1) % n]);
            if d < best {
                best = d;
            }
        }
    }
    best
}

pub fn point_in_path(px: f64, py: f64, pts: &[Pt]) -> bool {
    let mut inside = false;
    let n = pts.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (xi, yi, xj, yj) = (pts[i].x, pts[i].y, pts[j].x, pts[j].y);
        if ((yi > py) != (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

pub fn path_area(pts: &[Pt]) -> f64 {
    let mut a = 0.0;
    let n = pts.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
        j = i;
    }
    a / 2.0
}

// =====================================================================
// Auftrag des Fensters
// =====================================================================

pub fn bounds_json(b: Option<Bounds>) -> Value {
    b.map_or(Value::Null, |b| json!({ "minX": b.min_x, "minY": b.min_y, "maxX": b.max_x, "maxY": b.max_y }))
}
/// shapeBounds als JSON wie im Fenster: bei Polylinie und Bild sind minX/minY die Felder x/y selbst (null bleibt null)
pub fn shape_bounds_json(s: &Value) -> Value {
    let mut b = bounds_json(shape_bounds(s));
    if matches!(kind(s), "polyline" | "image") {
        if let Some(m) = b.as_object_mut() {
            for (k, f) in [("minX", "x"), ("minY", "y")] {
                match s.get(f) {
                    Some(v) => m.insert(k.into(), v.clone()),
                    None => m.shift_remove(k),
                };
            }
        }
    }
    b
}
#[cfg(test)]
pub fn paths_json(p: &[Path]) -> Value {
    json!(p
        .iter()
        .map(|p| {
            let pts: Vec<Value> = match &p.raw {
                Some(raw) => raw.iter().map(copy_xy).collect(),
                None => p.pts.iter().map(|q| pt_json(*q)).collect(),
            };
            json!({ "pts": pts, "closed": p.closed })
        })
        .collect::<Vec<_>>())
}

/// Eine Änderung an allen Formen (wie transformSelection in commands.ts): Ergebnis = die geänderten Formen
pub fn transform(shapes: &[Value], op: &Value) -> Result<Vec<Value>, String> {
    let g = |k: &str| num(op, k);
    let what = op.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let mut out = shapes.to_vec();
    for s in out.iter_mut() {
        match what {
            "translate" => translate_shape(s, g("dx"), g("dy")),
            "scale" => scale_shape(s, g("ox"), g("oy"), g("sx"), g("sy")),
            "rotate" => rotate_shape(s, g("cx"), g("cy"), g("angle")),
            "shear" => shear_shape(s, g("cx"), g("cy"), g("shx"), g("shy")),
            "polyline" => convert_to_polyline(s),
            _ => return Err(format!("unknown change {what}")),
        }
    }
    Ok(out)
}

/// Kurzbeschreibung jeder Form an einer Stelle (x, y): Box, geschlossen, Abstand; je Punktezug Anzahl, Fläche, innen?
/// Gleiche Rechnung wie shapeInfo in src/editor/shapeRust.ts
pub fn info(shapes: &[Value], x: f64, y: f64) -> Value {
    let each: Vec<Value> = shapes
        .iter()
        .map(|s| {
            let paths: Vec<Value> = shape_to_paths(s)
                .iter()
                .map(|p| json!({ "n": p.pts.len(), "closed": p.closed, "area": path_area(&p.pts), "inside": point_in_path(x, y, &p.pts) }))
                .collect();
            json!({ "bounds": shape_bounds_json(s), "closed": is_closed_shape(s), "dist": distance_to_shape(x, y, s), "paths": paths })
        })
        .collect();
    json!({ "bounds": bounds_json(group_bounds(shapes)), "each": each })
}

/// Auftrag des Fensters: {kind: "transform", op, shapes} oder {kind: "info", shapes, x, y}
pub fn run(job: &Value) -> Result<Value, String> {
    let shapes = job.get("shapes").and_then(|v| v.as_array()).ok_or("no shapes")?;
    match job.get("kind").and_then(|v| v.as_str()) {
        Some("transform") => Ok(Value::Array(transform(shapes, job.get("op").ok_or("no change")?)?)),
        Some("info") => Ok(info(shapes, num(job, "x"), num(job, "y"))),
        k => Err(format!("unknown job {k:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsmath::to_fixed;
    use std::io::Read;

    fn flat_nums(v: &Value) -> Option<Vec<f64>> {
        match v {
            Value::Number(n) => Some(vec![n.as_f64().unwrap()]),
            Value::Array(a) => {
                let mut out = vec![];
                for e in a {
                    out.extend(flat_nums(e)?);
                }
                Some(out)
            }
            Value::Object(o) => {
                let mut keys: Vec<&String> = o.keys().collect();
                keys.sort();
                let mut out = vec![];
                for k in keys {
                    out.extend(flat_nums(&o[k])?);
                }
                Some(out)
            }
            _ => None,
        }
    }
    fn digest(v: &Value) -> Value {
        match v {
            Value::Array(a) => match flat_nums(v) {
                Some(f) if f.len() > 64 => {
                    let text = f.iter().map(|x| to_fixed(*x, 6)).collect::<Vec<_>>().join(",");
                    let mut h: u32 = 0x811c9dc5;
                    for b in text.bytes() {
                        h = (h ^ b as u32).wrapping_mul(0x01000193);
                    }
                    json!({ "n": f.len(), "h": h })
                }
                _ => Value::Array(a.iter().map(digest).collect()),
            },
            Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), digest(x))).collect()),
            _ => v.clone(),
        }
    }
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
    fn pts(v: &Value) -> Vec<Pt> {
        v.as_array().unwrap().iter().map(pt_of).collect()
    }

    #[test]
    fn same_shapes_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("shapes-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        for t in all["transforms"].as_array().unwrap() {
            let job = json!({ "kind": "transform", "op": t["op"], "shapes": t["shapes"] });
            let got = run(&job).unwrap();
            same(&digest(&got), &t["want"], &format!("{}", t["op"]));
        }
        for i in all["info"].as_array().unwrap() {
            let s = &i["s"];
            let at = format!("shape {}", s["id"]);
            same(&digest(&paths_json(&shape_to_paths(s))), &i["paths"], &format!("{at} paths"));
            same(&shape_bounds_json(s), &i["bounds"], &format!("{at} bounds"));
            assert_eq!(json!(is_closed_shape(s)), i["closed"], "{at} closed");
            let d: Vec<f64> = [(0.0, 0.0), (12.0, 7.0), (-40.0, 60.0), (50.0, 52.0)].iter().map(|(x, y)| distance_to_shape(*x, *y, s)).collect();
            same(&json!(d), &i["dist"], &format!("{at} distance"));
        }
        for g in all["groups"].as_array().unwrap() {
            same(&bounds_json(group_bounds(g["g"].as_array().unwrap())), &g["b"], "groupBounds");
        }
        let a = |v: &Value| -> Vec<f64> { v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect() };
        let ptsj = |p: Vec<Pt>| json!(p.into_iter().map(pt_json).collect::<Vec<_>>());
        for m in all["makers"]["rect"].as_array().unwrap() {
            let v = a(&m["a"]);
            same(&digest(&ptsj(make_rect_points(v[0], v[1], v[2], v[3], v[4]))), &m["out"], &format!("rect {}", m["a"]));
        }
        for m in all["makers"]["ellipse"].as_array().unwrap() {
            let v = a(&m["a"]);
            same(&digest(&ptsj(make_ellipse_points(v[0], v[1], v[2], v[3]))), &m["out"], &format!("ellipse {}", m["a"]));
        }
        for m in all["makers"]["polygon"].as_array().unwrap() {
            let v = a(&m["a"]);
            same(&ptsj(make_polygon_points(v[0], v[1], v[2], v[3], v[4])), &m["out"], &format!("polygon {}", m["a"]));
        }
        for c in all["inside"].as_array().unwrap() {
            let p = pt_of(&c["p"]);
            assert_eq!(json!(point_in_path(p.x, p.y, &pts(&c["l"]))), c["in"], "pointInPath {} {}", c["l"], c["p"]);
        }
        for c in all["areas"].as_array().unwrap() {
            same(&json!(path_area(&pts(&c["l"]))), &c["a"], "pathArea");
        }
        for c in all["infos"].as_array().unwrap() {
            same(&run(&json!({ "kind": "info", "shapes": c["shapes"], "x": c["x"], "y": c["y"] })).unwrap(), &c["want"], &format!("info at {} {}", c["x"], c["y"]));
        }
        println!("{} changes on every kind of shape the same as shapeTransform.ts", all["transforms"].as_array().unwrap().len());
    }
}
