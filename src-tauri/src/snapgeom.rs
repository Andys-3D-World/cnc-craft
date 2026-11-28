//! FANG-GEOMETRIE UND ECKEN – Zwilling von `src/editor/snapGeom.ts` (Schnittpunkte, Lot, Tangente, Viertelpunkte) und
//! `src/editor/cornerOps.ts` (eine Ecke verrunden/fasen, Linie verlängern).
//!
//! Die Bausteine (gerade Stücke, Kreise, Bögen) sucht das Fenster aus den Formen (`primsNear`, braucht die Formen) und
//! schickt sie mit. Folgt dem TypeScript Zeile für Zeile, auch bei NaN (Math.max/min, Math.hypot wie in JavaScript).
//! Nur Vergleich: was gefangen bzw. geändert wird, bestimmt weiter das Fenster. Fälle: `tests/fixtures/snapgeom-cases.json.gz`.

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath;
use serde::{Deserialize, Deserializer, Serialize};
use std::f64::consts::PI;

fn nan_num<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN))
}
/// fehlt = None (undefined), null = NaN
fn nan_opt<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(Some(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN)))
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Pt {
    #[serde(deserialize_with = "nan_num")]
    pub x: f64,
    #[serde(deserialize_with = "nan_num")]
    pub y: f64,
}
fn pt(x: f64, y: f64) -> Pt {
    Pt { x, y }
}

/// a0/sweep nur bei Bögen (Bogenmaß, sweep < 0 = im Uhrzeigersinn)
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum Prim {
    Seg {
        a: Pt,
        b: Pt,
        #[serde(default)]
        id: String,
    },
    Circ {
        c: Pt,
        #[serde(deserialize_with = "nan_num")]
        r: f64,
        #[serde(default, deserialize_with = "nan_opt")]
        a0: Option<f64>,
        #[serde(default, deserialize_with = "nan_opt")]
        sweep: Option<f64>,
        #[serde(default)]
        id: String,
    },
}
impl Prim {
    fn id(&self) -> &str {
        match self {
            Prim::Seg { id, .. } | Prim::Circ { id, .. } => id,
        }
    }
}
struct Circ {
    c: Pt,
    r: f64,
    a0: Option<f64>,
    sweep: Option<f64>,
}

const EPS: f64 = 1e-9;

/// Liegt der Punkt auf dem Bogen? (volle Kreise: immer)
fn on_circ(c: &Circ, p: Pt, tol: f64) -> bool {
    let (Some(sweep), Some(a0)) = (c.sweep, c.a0) else { return true };
    if sweep.abs() >= PI * 2.0 - 1e-9 {
        return true;
    }
    let a = jsmath::atan2(p.y - c.c.y, p.x - c.c.x);
    // Math.sign(sweep) || 1
    let s = if sweep > 0.0 { 1.0 } else if sweep < 0.0 { -1.0 } else { 1.0 };
    let mut d = (a - a0) * s;
    d = ((d % (PI * 2.0)) + PI * 2.0) % (PI * 2.0);
    let tol_a = if c.r > 0.0 { tol / c.r + 1e-9 } else { tol };
    d <= sweep.abs() + tol_a || d >= PI * 2.0 - tol_a
}

fn seg_seg(pa: Pt, pb: Pt, qa: Pt, qb: Pt) -> Vec<Pt> {
    let (rx, ry, sx, sy) = (pb.x - pa.x, pb.y - pa.y, qb.x - qa.x, qb.y - qa.y);
    let den = rx * sy - ry * sx;
    if den.abs() < EPS {
        return vec![];
    }
    let (qx, qy) = (qa.x - pa.x, qa.y - pa.y);
    let t = (qx * sy - qy * sx) / den;
    let u = (qx * ry - qy * rx) / den;
    let e = 1e-9;
    if t < -e || t > 1.0 + e || u < -e || u > 1.0 + e {
        return vec![];
    }
    vec![pt(pa.x + t * rx, pa.y + t * ry)]
}

fn seg_circ(pa: Pt, pb: Pt, c: &Circ) -> Vec<Pt> {
    let (dx, dy) = (pb.x - pa.x, pb.y - pa.y);
    let (fx, fy) = (pa.x - c.c.x, pa.y - c.c.y);
    let a = dx * dx + dy * dy;
    if a < EPS {
        return vec![];
    }
    let b = 2.0 * (fx * dx + fy * dy);
    let cc = fx * fx + fy * fy - c.r * c.r;
    let mut disc = b * b - 4.0 * a * cc;
    if disc < -EPS * a {
        return vec![];
    }
    disc = mx(0.0, disc);
    let sq = disc.sqrt();
    let ts = if disc == 0.0 { vec![-b / (2.0 * a)] } else { vec![(-b - sq) / (2.0 * a), (-b + sq) / (2.0 * a)] };
    let mut out = vec![];
    for t in ts {
        if t < -1e-9 || t > 1.0 + 1e-9 {
            continue;
        }
        let p = pt(pa.x + t * dx, pa.y + t * dy);
        if on_circ(c, p, 1e-6) {
            out.push(p);
        }
    }
    out
}

fn circ_circ(a: &Circ, b: &Circ) -> Vec<Pt> {
    let (dx, dy) = (b.c.x - a.c.x, b.c.y - a.c.y);
    let d = hypot2(dx, dy);
    if d < EPS || d > a.r + b.r + 1e-9 || d < (a.r - b.r).abs() - 1e-9 {
        return vec![];
    }
    let x = (d * d + a.r * a.r - b.r * b.r) / (2.0 * d);
    let h = mx(0.0, a.r * a.r - x * x).sqrt();
    let (mxx, myy) = (a.c.x + (dx * x) / d, a.c.y + (dy * x) / d);
    let pts = if h < 1e-9 { vec![pt(mxx, myy)] } else { vec![pt(mxx - (dy * h) / d, myy + (dx * h) / d), pt(mxx + (dy * h) / d, myy - (dx * h) / d)] };
    pts.into_iter().filter(|p| on_circ(a, *p, 1e-6) && on_circ(b, *p, 1e-6)).collect()
}

fn circ_of(p: &Prim) -> Option<Circ> {
    match p {
        Prim::Circ { c, r, a0, sweep, .. } => Some(Circ { c: *c, r: *r, a0: *a0, sweep: *sweep }),
        _ => None,
    }
}

/// Schnittpunkte zweier Bausteine
pub fn intersect(p: &Prim, q: &Prim) -> Vec<Pt> {
    match (p, q) {
        (Prim::Seg { a, b, .. }, Prim::Seg { a: c, b: d, .. }) => seg_seg(*a, *b, *c, *d),
        (Prim::Seg { a, b, .. }, Prim::Circ { .. }) => seg_circ(*a, *b, &circ_of(q).unwrap()),
        (Prim::Circ { .. }, Prim::Seg { a, b, .. }) => seg_circ(*a, *b, &circ_of(p).unwrap()),
        _ => circ_circ(&circ_of(p).unwrap(), &circ_of(q).unwrap()),
    }
}

fn same(a: Pt, b: Pt) -> bool {
    (a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9
}

/// Alle Schnittpunkte zwischen den Bausteinen. Nachbarstücke derselben Form (gemeinsamer Eckpunkt) zählen nicht
pub fn all_intersections(prims: &[Prim], max: usize) -> Vec<Pt> {
    let list = if prims.len() > max { &prims[..max] } else { prims };
    let mut out = vec![];
    for i in 0..list.len() {
        for j in i + 1..list.len() {
            let (p, q) = (&list[i], &list[j]);
            if p.id() == q.id() {
                match (p, q) {
                    (Prim::Seg { a: pa, b: pb, .. }, Prim::Seg { a: qa, b: qb, .. }) => {
                        if same(*pa, *qa) || same(*pa, *qb) || same(*pb, *qa) || same(*pb, *qb) {
                            continue;
                        }
                    }
                    _ => continue,
                }
            }
            out.extend(intersect(p, q));
        }
    }
    out
}

/// Lotfußpunkte vom Punkt from auf die Bausteine (nur innerhalb der Strecke bzw. des Bogens)
pub fn perp_feet(prims: &[Prim], from: Pt) -> Vec<Pt> {
    let mut out = vec![];
    for p in prims {
        match p {
            Prim::Seg { a, b, .. } => {
                let (dx, dy) = (b.x - a.x, b.y - a.y);
                let l2 = dx * dx + dy * dy;
                if l2 < EPS {
                    continue;
                }
                let t = ((from.x - a.x) * dx + (from.y - a.y) * dy) / l2;
                if t < -1e-9 || t > 1.0 + 1e-9 {
                    continue;
                }
                let f = pt(a.x + t * dx, a.y + t * dy);
                if hypot2(f.x - from.x, f.y - from.y) > 1e-6 {
                    out.push(f);
                }
            }
            Prim::Circ { .. } => {
                let c = circ_of(p).unwrap();
                let (dx, dy) = (from.x - c.c.x, from.y - c.c.y);
                let d = hypot2(dx, dy);
                if d < 1e-9 {
                    continue;
                }
                for k in [1.0, -1.0] {
                    let f = pt(c.c.x + (k * c.r * dx) / d, c.c.y + (k * c.r * dy) / d);
                    if hypot2(f.x - from.x, f.y - from.y) > 1e-6 && on_circ(&c, f, 1e-6) {
                        out.push(f);
                    }
                }
            }
        }
    }
    out
}

/// Tangentenpunkte vom Punkt from an Kreise und Bögen (from muss außerhalb liegen)
pub fn tangent_pts(prims: &[Prim], from: Pt) -> Vec<Pt> {
    let mut out = vec![];
    for p in prims {
        let Some(c) = circ_of(p) else { continue };
        let (dx, dy) = (from.x - c.c.x, from.y - c.c.y);
        let d = hypot2(dx, dy);
        if d <= c.r + 1e-9 {
            continue;
        }
        let base = jsmath::atan2(dy, dx);
        let alpha = jsmath::acos(c.r / d);
        for a in [base + alpha, base - alpha] {
            let t = pt(c.c.x + c.r * jsmath::cos(a), c.c.y + c.r * jsmath::sin(a));
            if on_circ(&c, t, 1e-6) {
                out.push(t);
            }
        }
    }
    out
}

/// Viertelpunkte (0°, 90°, 180°, 270°) eines Kreises oder Bogens
fn quadrants(c: &Circ) -> Vec<Pt> {
    [[1.0, 0.0], [0.0, 1.0], [-1.0, 0.0], [0.0, -1.0]].iter().map(|[x, y]| pt(c.c.x + x * c.r, c.c.y + y * c.r)).filter(|p| on_circ(c, *p, 1e-6)).collect()
}

// ---------------------------------------------------------------------
// Ecke und Verlängern (cornerOps.ts)
// ---------------------------------------------------------------------

/// Nächste Ecke einer Polylinie zur Maus (innerhalb tol), -1 = keine. Offene Linien: Anfang und Ende sind keine Ecken
pub fn nearest_corner(pts: &[Pt], closed: bool, at: Pt, tol: f64) -> f64 {
    let (mut best, mut best_d) = (-1.0, tol);
    let n = pts.len();
    for (i, p) in pts.iter().enumerate() {
        if !closed && (i == 0 || i == n - 1) {
            continue;
        }
        let d = hypot2(p.x - at.x, p.y - at.y);
        if d <= best_d {
            best_d = d;
            best = i as f64;
        }
    }
    best
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CornerResult {
    pub pts: Vec<Pt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arc: Option<Vec<Pt>>,
}

/// Ecke i verrunden (chamfer = false) oder fasen; tol = größte Abweichung des Bogens als Vieleck
pub fn fillet_corner(pts: &[Pt], closed: bool, i: f64, r: f64, chamfer: bool, tol: f64) -> CornerResult {
    let n = pts.len();
    let none = |e: &'static str| CornerResult { pts: pts.to_vec(), error: Some(e), arc: None };
    if n < 3 || i < 0.0 || i >= n as f64 || i.fract() != 0.0 || (!closed && (i == 0.0 || i == n as f64 - 1.0)) || !(r > 0.0) {
        return none("none");
    }
    let i = i as usize;
    let (a, b, c) = (pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n]);
    let l1 = hypot2(a.x - b.x, a.y - b.y);
    let l2 = hypot2(c.x - b.x, c.y - b.y);
    if l1 < 1e-9 || l2 < 1e-9 {
        return none("none");
    }
    let u1 = pt((a.x - b.x) / l1, (a.y - b.y) / l1);
    let u2 = pt((c.x - b.x) / l2, (c.y - b.y) / l2);
    let inner = jsmath::acos(mx(-1.0, mn(1.0, u1.x * u2.x + u1.y * u2.y)));
    if PI - inner < 1e-3 || inner < 1e-6 {
        return none("straight");
    }
    let half = inner / 2.0;
    let d = if chamfer { r } else { r / jsmath::tan(half) };
    let eps = 1e-9 * mx(1.0, d);
    if d > l1 + eps || d > l2 + eps {
        return none("tooBig");
    }
    let t1 = pt(b.x + u1.x * d, b.y + u1.y * d);
    let t2 = pt(b.x + u2.x * d, b.y + u2.y * d);
    let piece: Vec<Pt> = if chamfer {
        vec![t1, t2]
    } else {
        let bis = pt(u1.x + u2.x, u1.y + u2.y);
        let bl = hypot2(bis.x, bis.y);
        let bl = if bl != 0.0 && !bl.is_nan() { bl } else { 1.0 };
        let k = r / jsmath::sin(half);
        let cx = b.x + (bis.x / bl) * k;
        let cy = b.y + (bis.y / bl) * k;
        let a0 = jsmath::atan2(t1.y - cy, t1.x - cx);
        let a1 = jsmath::atan2(t2.y - cy, t2.x - cx);
        let mut sweep = a1 - a0;
        while sweep > PI {
            sweep -= 2.0 * PI;
        }
        while sweep < -PI {
            sweep += 2.0 * PI;
        }
        let step = 2.0 * jsmath::acos(mx(-1.0, 1.0 - tol / mx(r, tol)));
        let steps = mx(3.0, (sweep.abs() / step).ceil());
        let mut piece = vec![];
        let mut s = 0.0;
        while s <= steps {
            let ang = a0 + (sweep * s) / steps;
            piece.push(pt(cx + r * jsmath::cos(ang), cy + r * jsmath::sin(ang)));
            s += 1.0;
        }
        // wie im Fenster: bei NaN ist die Liste leer, piece[0] = t1 macht sie 1 lang, dann überschreibt t2 dieses Feld
        if piece.is_empty() {
            piece.push(t1);
        } else {
            piece[0] = t1;
        }
        let last = piece.len() - 1;
        piece[last] = t2;
        piece
    };
    let same = |p: Pt, q: Pt| hypot2(p.x - q.x, p.y - q.y) < 1e-9 * mx(1.0, r);
    let head: &[Pt] = if same(piece[0], a) { &piece[1..] } else { &piece };
    let body: &[Pt] = if head.last().is_some_and(|&h| same(h, c)) { &head[..head.len() - 1] } else { head };
    let mut out = pts[..i].to_vec();
    out.extend_from_slice(body);
    out.extend_from_slice(&pts[i + 1..]);
    CornerResult { pts: out, error: None, arc: Some(piece) }
}

/// Ende einer offenen Linie bis zur nächsten Form verlängern; None = nichts in Reichweite
pub fn extend_to(pts: &[Pt], at_end: bool, targets: &[Prim], max_len: f64) -> Option<Pt> {
    let n = pts.len();
    if n < 2 {
        return None;
    }
    let (tip, prev) = if at_end { (pts[n - 1], pts[n - 2]) } else { (pts[0], pts[1]) };
    let (dx, dy) = (tip.x - prev.x, tip.y - prev.y);
    let len = hypot2(dx, dy);
    if len < 1e-12 {
        return None;
    }
    let (ux, uy) = (dx / len, dy / len);
    let ray = Prim::Seg { a: tip, b: pt(tip.x + ux * max_len, tip.y + uy * max_len), id: "\u{0}ray".into() };
    let min_go = 1e-6 * mx(1.0, len);
    let (mut best, mut best_t) = (None, f64::INFINITY);
    for p in targets {
        for q in intersect(&ray, p) {
            let t = (q.x - tip.x) * ux + (q.y - tip.y) * uy;
            if t > min_go && t < best_t {
                best_t = t;
                best = Some(q);
            }
        }
    }
    best
}

// ---------------------------------------------------------------------
// Auftrag des Fensters
// ---------------------------------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Job {
    /// Ecke unter der Maus suchen und verrunden/fasen (cornerTool.ts)
    #[serde(rename_all = "camelCase")]
    Corner {
        pts: Vec<Pt>,
        closed: bool,
        at: Pt,
        #[serde(deserialize_with = "nan_num")]
        tol: f64,
        #[serde(deserialize_with = "nan_num")]
        r: f64,
        chamfer: bool,
        #[serde(deserialize_with = "nan_num")]
        arc_tol: f64,
    },
    /// Linie verlängern (cornerTool.ts)
    #[serde(rename_all = "camelCase")]
    Extend {
        pts: Vec<Pt>,
        end: String,
        targets: Vec<Prim>,
        #[serde(deserialize_with = "nan_num")]
        max_len: f64,
    },
    /// Viertelpunkte, Schnittpunkte, Lot und Tangente nahe der Maus (snap.ts)
    Snap {
        prims: Vec<Prim>,
        #[serde(default)]
        from: Option<Pt>,
    },
}

pub fn run(job: &Job) -> serde_json::Value {
    use serde_json::json;
    match job {
        Job::Corner { pts, closed, at, tol, r, chamfer, arc_tol } => {
            let i = nearest_corner(pts, *closed, *at, *tol);
            if i < 0.0 {
                json!({ "i": i })
            } else {
                json!({ "i": i, "res": fillet_corner(pts, *closed, i, *r, *chamfer, *arc_tol) })
            }
        }
        Job::Extend { pts, end, targets, max_len } => json!(extend_to(pts, end == "end", targets, *max_len)),
        Job::Snap { prims, from } => {
            let quads: Vec<Pt> = prims.iter().filter_map(circ_of).filter(|c| c.sweep.is_some()).flat_map(|c| quadrants(&c)).collect();
            let (perp, tan) = match from {
                Some(f) => (perp_feet(prims, *f), tangent_pts(prims, *f)),
                None => (vec![], vec![]),
            };
            json!({ "quads": quads, "ints": all_intersections(prims, 400), "perp": perp, "tan": tan })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Read;

    /// Zahlen auf 1e-9, NaN kommt als null, der Rest genau
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
    fn same_points_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("snapgeom-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let cases: Vec<Value> = serde_json::from_str(&text).unwrap();
        assert!(cases.len() >= 400, "only {} cases", cases.len());
        for (i, c) in cases.iter().enumerate() {
            let job: Job = serde_json::from_value(c["job"].clone()).unwrap_or_else(|e| panic!("case {i}: {e}"));
            same(&run(&job), &c["want"], &format!("case {i} ({})", c["job"]["kind"]));
        }
        println!("{} corner, extend and snap jobs the same as snapGeom.ts/cornerOps.ts", cases.len());
    }
}
