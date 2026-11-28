//! DXF-IMPORT – Zwilling von `dxfParse` in `src/importers/dxfParse.ts`.
//!
//! Liest eine ASCII-DXF in Linienzüge, Kreise und Texte (mm): LINE, ARC, CIRCLE, ELLIPSE, LWPOLYLINE/POLYLINE mit Bögen,
//! SPLINE (NURBS oder Stützpunkte), SOLID/TRACE/3DFACE, INSERT (Blöcke, verschachtelt, gedreht, in Reihen), TEXT/MTEXT/ATTRIB.
//! Folgt dem TypeScript Zeile für Zeile, auch parseInt/parseFloat/trim und die Reihenfolge von `Object.entries`.
//! Bögen und Drehungen gehen über Sinus/Kosinus: der Test vergleicht Zahlen auf 1e-9 genau, alles andere exakt.
//! Gemeinsame Fälle: `tests/fixtures/importdxf-cases.json` (festgehalten von `tests/importDxfRust.test.ts`).

use crate::gcodesim::{hypot2, js_space, mn, mx, to_int32};
use crate::importplt::{arc_points, arc_segments, Pt, CURVE_TOL};
use crate::jsmath;
use serde::Serialize;
use std::collections::HashMap;
use std::f64::consts::PI;

#[derive(Serialize, Clone, Debug, Default)]
pub struct Origin {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
}
#[derive(Serialize, Clone, Debug)]
pub struct Path {
    pub pts: Vec<Pt>,
    pub closed: bool,
    #[serde(flatten)]
    pub origin: Origin,
}
#[derive(Serialize, Clone, Debug)]
pub struct Circle {
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
    #[serde(flatten)]
    pub origin: Origin,
}
#[derive(Serialize, Clone, Debug)]
pub struct Text {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub height: f64,
    pub rotation: f64,
    #[serde(flatten)]
    pub origin: Origin,
}
#[derive(Serialize, Clone, Debug, Default)]
pub struct Parsed {
    pub binary: bool,
    pub paths: Vec<Path>,
    pub circles: Vec<Circle>,
    pub texts: Vec<Text>,
    pub units: f64,
    pub counts: Vec<(String, usize)>,
    pub skipped: Vec<(String, usize)>,
}

type Pair = (f64, String);
type Mat = [f64; 6];

struct Entity {
    kind: String,
    pairs: Vec<Pair>,
    vertices: Vec<Vec<Pair>>,
}
struct Block {
    base: Pt,
    entities: Vec<Entity>,
}

// ---- JavaScript: trim, parseInt(…, 10), parseFloat ----

fn trim(s: &str) -> &str {
    s.trim_matches(js_space)
}
fn digits_end(c: &[char], mut j: usize) -> usize {
    while j < c.len() && c[j].is_ascii_digit() {
        j += 1;
    }
    j
}
fn parse_int(s: &str) -> f64 {
    let c: Vec<char> = trim(s).chars().collect();
    let neg = c.first() == Some(&'-');
    let i = usize::from(matches!(c.first(), Some('-') | Some('+')));
    let e = digits_end(&c, i);
    if e == i {
        return f64::NAN;
    }
    let v: f64 = c[i..e].iter().collect::<String>().parse().unwrap_or(f64::NAN);
    if neg {
        -v
    } else {
        v
    }
}
pub(crate) fn parse_float(s: &str) -> f64 {
    let c: Vec<char> = trim(s).chars().collect();
    let neg = c.first() == Some(&'-');
    let i = usize::from(matches!(c.first(), Some('-') | Some('+')));
    let sign = if neg { -1.0 } else { 1.0 };
    if c[i..].starts_with(&['I', 'n', 'f', 'i', 'n', 'i', 't', 'y']) {
        return sign * f64::INFINITY;
    }
    let ie = digits_end(&c, i);
    let (mut fs, mut fe) = (ie, ie);
    if ie < c.len() && c[ie] == '.' {
        fs = ie + 1;
        fe = digits_end(&c, fs);
    }
    if ie == i && fe == fs {
        return f64::NAN; // keine Ziffer
    }
    let mut ee = (String::new(), String::new());
    if fe < c.len() && (c[fe] == 'e' || c[fe] == 'E') {
        let k = fe + 1 + usize::from(matches!(c.get(fe + 1), Some('-') | Some('+')));
        let ke = digits_end(&c, k);
        if ke > k {
            ee = (if c.get(fe + 1) == Some(&'-') { "-".into() } else { String::new() }, c[k..ke].iter().collect());
        }
    }
    let int: String = c[i..ie].iter().collect();
    let frac: String = c[fs..fe].iter().collect();
    let txt = format!("{}{}.{}e{}{}", if neg { "-" } else { "" }, if int.is_empty() { "0" } else { &int }, if frac.is_empty() { "0" } else { &frac }, ee.0, if ee.1.is_empty() { "0" } else { &ee.1 });
    txt.parse().unwrap_or(f64::NAN)
}

// ---- Matrix wie in importers/common.ts:  x' = a*x + c*y + e,  y' = b*x + d*y + f ----

fn mat_mul(m: &Mat, n: &Mat) -> Mat {
    [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ]
}
fn mat_apply(m: &Mat, x: f64, y: f64) -> Pt {
    Pt { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}
fn translate(tx: f64, ty: f64) -> Mat {
    [1.0, 0.0, 0.0, 1.0, tx, ty]
}
fn scale(sx: f64, sy: f64) -> Mat {
    [sx, 0.0, 0.0, sy, 0.0, 0.0]
}
fn rotate(rad: f64) -> Mat {
    let (c, s) = (jsmath::cos(rad), jsmath::sin(rad));
    [c, s, -s, c, 0.0, 0.0]
}
/// `Math.sqrt(Math.abs(det)) || 1`
fn scale_factor(m: &Mat) -> f64 {
    let v = (m[0] * m[3] - m[1] * m[2]).abs().sqrt();
    if v == 0.0 || v.is_nan() {
        1.0
    } else {
        v
    }
}
fn is_uniform(m: &Mat) -> bool {
    let (sx, sy) = (hypot2(m[0], m[1]), hypot2(m[2], m[3]));
    let dot = m[0] * m[2] + m[1] * m[3];
    (sx - sy).abs() < 1e-6 * mx(sx, sy) && dot.abs() < 1e-6 * sx * sy
}

// ---- Kurven (importers/common.ts) ----

#[allow(clippy::too_many_arguments)]
fn ellipse_points(cx: f64, cy: f64, mvx: f64, mvy: f64, ratio: f64, t0: f64, t1: f64, tol: f64) -> Vec<Pt> {
    let a = hypot2(mvx, mvy);
    let b = a * ratio;
    let rot = jsmath::atan2(mvy, mvx);
    let sweep = t1 - t0;
    let n = arc_segments(mx(a, b), sweep, tol);
    if n.is_nan() {
        return vec![];
    }
    let (cr, sr) = (jsmath::cos(rot), jsmath::sin(rot));
    (0..=n as usize)
        .map(|i| {
            let t = t0 + (sweep * i as f64) / n;
            let (x, y) = (a * jsmath::cos(t), b * jsmath::sin(t));
            Pt { x: cx + x * cr - y * sr, y: cy + x * sr + y * cr }
        })
        .collect()
}
/// Wölbung zwischen zwei Punkten (ohne Startpunkt)
fn bulge_points(p0: Pt, p1: Pt, bulge: f64, tol: f64) -> Vec<Pt> {
    if bulge.abs() < 1e-9 {
        return vec![p1];
    }
    let chord = hypot2(p1.x - p0.x, p1.y - p0.y);
    if chord < 1e-12 {
        return vec![p1];
    }
    let theta = 4.0 * jsmath::atan(bulge);
    let r = chord / (2.0 * jsmath::sin(theta.abs() / 2.0));
    let (mpx, mpy) = ((p0.x + p1.x) / 2.0, (p0.y + p1.y) / 2.0);
    let d = mx(0.0, r * r - (chord / 2.0).powi(2)).sqrt();
    let (nx, ny) = (-(p1.y - p0.y) / chord, (p1.x - p0.x) / chord);
    let side = if (bulge > 0.0) == (theta.abs() < PI) { 1.0 } else { -1.0 };
    let (cx, cy) = (mpx + nx * d * side, mpy + ny * d * side);
    let a0 = jsmath::atan2(p0.y - cy, p0.x - cx);
    let mut pts = arc_points(cx, cy, r, a0, theta, tol);
    if !pts.is_empty() {
        pts.remove(0);
    }
    // pts[pts.length - 1] = p1 – bei leerer Liste setzt JavaScript nur eine Eigenschaft „-1“, die Liste bleibt leer
    if let Some(l) = pts.last_mut() {
        *l = p1;
    }
    pts
}

// ---- Gruppen lesen ----

fn read_pairs(text: &str) -> Vec<Pair> {
    // split(/\r\n|\r|\n/)
    let mut lines: Vec<&str> = Vec::new();
    let b = text.as_bytes();
    let (mut s, mut i) = (0, 0);
    while i < b.len() {
        if b[i] == b'\r' || b[i] == b'\n' {
            lines.push(&text[s..i]);
            i += if b[i] == b'\r' && b.get(i + 1) == Some(&b'\n') { 2 } else { 1 };
            s = i;
        } else {
            i += 1;
        }
    }
    lines.push(&text[s..]);
    let mut pairs = Vec::new();
    let mut i: isize = 0;
    while (i + 1) < lines.len() as isize {
        let code = parse_int(trim(lines[i as usize]));
        if code.is_nan() {
            i -= 1; // verrutschte Zeile -> eine Zeile weiter versuchen
        } else {
            pairs.push((code, lines[i as usize + 1].to_string()));
        }
        i += 2;
    }
    pairs
}
fn read_entity(pairs: &[Pair], start: usize) -> (Vec<Pair>, usize) {
    let mut i = start + 1;
    while i < pairs.len() && pairs[i].0 != 0.0 {
        i += 1;
    }
    (pairs[(start + 1).min(i)..i].to_vec(), i)
}
fn get_num(p: &[Pair], code: f64, def: f64) -> f64 {
    match p.iter().find(|(c, _)| *c == code) {
        Some((_, v)) => {
            let n = parse_float(v);
            if n.is_finite() {
                n
            } else {
                def
            }
        }
        None => def,
    }
}
fn get_str(p: &[Pair], code: f64) -> Option<String> {
    p.iter().find(|(c, _)| *c == code).map(|(_, v)| trim(v).to_string())
}
fn has_code(p: &[Pair], code: f64) -> bool {
    p.iter().any(|(c, _)| *c == code)
}
fn get_all(p: &[Pair], code: f64) -> Vec<f64> {
    p.iter().filter(|(c, _)| *c == code).map(|(_, v)| parse_float(v)).collect()
}

/// $INSUNITS -> Faktor zu mm (UNITS_TO_MM in dxfParse.ts; unbekannt oder 0/4 = 1)
fn units_to_mm(units: f64) -> f64 {
    const TABLE: [(f64, f64); 9] = [(1.0, 25.4), (2.0, 304.8), (5.0, 10.0), (6.0, 1000.0), (8.0, 0.0000254), (9.0, 0.0254), (10.0, 914.4), (13.0, 0.001), (14.0, 100.0)];
    TABLE.iter().find(|e| e.0 == units).map_or(1.0, |e| e.1)
}

/// Reihenfolge von `Object.entries`: Schlüssel wie „0“, „12“ (Feld-Nummern) zuerst aufsteigend, dann die übrigen wie eingefügt
fn js_entries(list: &[(String, usize)]) -> Vec<(String, usize)> {
    let index = |k: &str| -> Option<u64> {
        let v: u64 = k.parse().ok()?;
        (v < 4294967295 && v.to_string() == k).then_some(v)
    };
    let mut ints: Vec<(u64, (String, usize))> = list.iter().filter_map(|e| index(&e.0).map(|v| (v, e.clone()))).collect();
    ints.sort_by_key(|e| e.0);
    ints.into_iter().map(|e| e.1).chain(list.iter().filter(|e| index(&e.0).is_none()).cloned()).collect()
}
fn bump(list: &mut Vec<(String, usize)>, k: &str) {
    match list.iter_mut().find(|e| e.0 == k) {
        Some(e) => e.1 += 1,
        None => list.push((k.to_string(), 1)),
    }
}

struct InBlock {
    key: String,
    layer: String,
}
struct Ctx<'a> {
    blocks: &'a HashMap<String, Block>,
    res: Parsed,
    origin: Origin,
}

impl Ctx<'_> {
    fn emit(&mut self, list: &[Entity], m: &Mat, depth: u32, in_block: Option<&InBlock>) -> Result<(), String> {
        if depth > 20 {
            return Ok(());
        }
        for e in list {
            bump(&mut self.res.counts, &e.kind);
            let handle = get_str(&e.pairs, 5.0).unwrap_or_default();
            let own = get_str(&e.pairs, 8.0).unwrap_or_default();
            // Ebene „0“ im Block heißt: Ebene der Einfügung
            let layer = match in_block {
                Some(b) if own == "0" || own.is_empty() => b.layer.clone(),
                _ => own,
            };
            let key = if !handle.is_empty() && in_block.is_none_or(|b| !b.key.is_empty()) {
                in_block.map_or(String::new(), |b| b.key.clone() + "/") + &handle
            } else {
                String::new()
            };
            self.origin = Origin { keys: (!key.is_empty()).then(|| vec![key]), layer: (!layer.is_empty()).then_some(layer) };
            if !self.entity(e, m, depth)? {
                bump(&mut self.res.skipped, &e.kind);
            }
        }
        Ok(())
    }

    fn add_path(&mut self, pts: Vec<Pt>, closed: bool, m: &Mat) {
        if pts.len() < 2 {
            return;
        }
        let pts = pts.iter().map(|p| mat_apply(m, p.x, p.y)).collect();
        self.res.paths.push(Path { pts, closed, origin: self.origin.clone() });
    }

    fn entity(&mut self, e: &Entity, m0: &Mat, depth: u32) -> Result<bool, String> {
        let p = &e.pairs;
        // Objekt-Koordinatensystem: Extrusion Z = -1 bedeutet gespiegelt
        let flipped = get_num(p, 230.0, 1.0) < 0.0;
        let m = if flipped { mat_mul(m0, &scale(-1.0, 1.0)) } else { *m0 };
        let tol = CURVE_TOL / scale_factor(&m);
        let g = |c: f64| get_num(p, c, 0.0);
        match e.kind.as_str() {
            "LINE" => self.add_path(vec![Pt { x: g(10.0), y: g(20.0) }, Pt { x: g(11.0), y: g(21.0) }], false, &m),
            "CIRCLE" => {
                let (cx, cy, r) = (g(10.0), g(20.0), g(40.0));
                if r <= 0.0 {
                    return Ok(true);
                }
                if is_uniform(&m) {
                    let c = mat_apply(&m, cx, cy);
                    self.res.circles.push(Circle { cx: c.x, cy: c.y, r: r * scale_factor(&m), origin: self.origin.clone() });
                } else {
                    let mut pts = arc_points(cx, cy, r, 0.0, PI * 2.0, tol);
                    pts.pop();
                    self.add_path(pts, true, &m);
                }
            }
            "ARC" => {
                let (cx, cy, r) = (g(10.0), g(20.0), g(40.0));
                let a0 = (g(50.0) * PI) / 180.0;
                let mut a1 = (g(51.0) * PI) / 180.0;
                while a1 <= a0 {
                    a1 += PI * 2.0;
                }
                self.add_path(arc_points(cx, cy, r, a0, a1 - a0, tol), false, &m);
            }
            "ELLIPSE" => {
                let (cx, cy) = (g(10.0), g(20.0));
                let (mvx, mvy, ratio) = (g(11.0), g(21.0), get_num(p, 40.0, 1.0));
                let t0 = get_num(p, 41.0, 0.0);
                let mut t1 = get_num(p, 42.0, PI * 2.0);
                while t1 <= t0 {
                    t1 += PI * 2.0;
                }
                let full = (t1 - t0 - PI * 2.0).abs() < 1e-6;
                let mut pts = ellipse_points(cx, cy, mvx, mvy, ratio, t0, t1, tol);
                if full {
                    pts.pop();
                }
                self.add_path(pts, full, &m);
            }
            "LWPOLYLINE" => {
                let closed = to_int32(g(70.0)) & 1 == 1;
                let mut verts: Vec<(Pt, f64)> = Vec::new();
                for (c, v) in p {
                    if *c == 10.0 {
                        verts.push((Pt { x: parse_float(v), y: 0.0 }, 0.0));
                    } else if *c == 20.0 && !verts.is_empty() {
                        verts.last_mut().unwrap().0.y = parse_float(v);
                    } else if *c == 42.0 && !verts.is_empty() {
                        verts.last_mut().unwrap().1 = parse_float(v);
                    }
                }
                self.add_path(poly_with_bulges(&verts, closed, tol), closed, &m);
            }
            "POLYLINE" => {
                let flags = to_int32(g(70.0));
                if flags & (16 | 64) != 0 {
                    return Ok(false); // 3D-Netze
                }
                let closed = flags & 1 == 1;
                let verts: Vec<(Pt, f64)> = e
                    .vertices
                    .iter()
                    .filter(|v| to_int32(get_num(v, 70.0, 0.0)) & 16 == 0) // Spline-Stützpunkte überspringen
                    .map(|v| (Pt { x: get_num(v, 10.0, 0.0), y: get_num(v, 20.0, 0.0) }, get_num(v, 42.0, 0.0)))
                    .collect();
                self.add_path(poly_with_bulges(&verts, closed, tol), closed, &m);
            }
            "SPLINE" => {
                let Some(mut pts) = spline_points(p, tol)? else { return Ok(false) };
                let n = pts.len();
                let closed = to_int32(g(70.0)) & 1 == 1 || (n > 2 && hypot2(pts[0].x - pts[n - 1].x, pts[0].y - pts[n - 1].y) < 1e-9);
                if closed && n > 2 {
                    pts.pop();
                }
                self.add_path(pts, closed, &m);
            }
            "SOLID" | "TRACE" | "3DFACE" => {
                let c: Vec<Pt> = [(10.0, 20.0), (11.0, 21.0), (13.0, 23.0), (12.0, 22.0)].iter().map(|&(a, b)| Pt { x: g(a), y: g(b) }).collect();
                // SOLID: Punkte 3 und 4 sind vertauscht (Ecken-Reihenfolge 1-2-4-3)
                let pts = if e.kind == "3DFACE" { vec![c[0], c[1], c[3], c[2]] } else { c };
                self.add_path(pts, true, &m);
            }
            "INSERT" => {
                let blocks = self.blocks;
                let Some(blk) = blocks.get(&get_str(p, 2.0).unwrap_or_default()) else { return Ok(false) };
                let (ix, iy) = (g(10.0), g(20.0));
                let (sx, sy) = (get_num(p, 41.0, 1.0), get_num(p, 42.0, 1.0));
                let rot = (g(50.0) * PI) / 180.0;
                let (cols, rows) = (mx(1.0, get_num(p, 70.0, 1.0)), mx(1.0, get_num(p, 71.0, 1.0)));
                let insert = self.origin.clone();
                let (dc, dr) = (g(44.0), g(45.0));
                let mut r = 0.0;
                while r < rows {
                    let mut c = 0.0;
                    while c < cols {
                        // Reihen/Spalten liegen im gedrehten Koordinatensystem
                        let off = mat_apply(&rotate(rot), c * dc, r * dr);
                        let inner = mat_mul(&rotate(rot), &mat_mul(&scale(sx, sy), &translate(-blk.base.x, -blk.base.y)));
                        let bm = mat_mul(&m, &mat_mul(&translate(ix + off.x, iy + off.y), &inner));
                        let at = if r != 0.0 || c != 0.0 { format!("@{}:{}", jsmath::js_num(r), jsmath::js_num(c)) } else { String::new() };
                        let ib = InBlock { key: insert.keys.as_ref().map_or(String::new(), |k| k[0].clone() + &at), layer: insert.layer.clone().unwrap_or_default() };
                        self.emit(&blk.entities, &bm, depth + 1, Some(&ib))?;
                        c += 1.0;
                    }
                    r += 1.0;
                }
            }
            "TEXT" | "MTEXT" | "ATTRIB" => {
                let mtext = e.kind == "MTEXT";
                let txt = if mtext { mtext_plain(p) } else { get_str(p, 1.0).unwrap_or_default() };
                let txt = percent_codes(&txt);
                if trim(&txt).is_empty() {
                    return Ok(true);
                }
                let h = get_num(p, 40.0, 2.5);
                let mut rot = g(50.0);
                if mtext && has_code(p, 11.0) {
                    rot = (jsmath::atan2(g(21.0), g(11.0)) * 180.0) / PI;
                }
                // Einfügepunkt: bei ausgerichtetem TEXT steht er in 11/21
                let aligned = e.kind == "TEXT" && (g(72.0) != 0.0 || g(73.0) != 0.0) && has_code(p, 11.0);
                let (x, y) = if aligned { (g(11.0), g(21.0)) } else { (g(10.0), g(20.0)) };
                let pos = mat_apply(&m, x, y);
                let s = scale_factor(&m);
                let mrot = (jsmath::atan2(m[1], m[0]) * 180.0) / PI;
                // MTEXT-Einfügepunkt ist meist oben links -> grob nach unten verschieben
                let a71 = get_num(p, 71.0, 1.0);
                let top_left = mtext && [1.0, 2.0, 3.0, 0.0].contains(&a71);
                self.res.texts.push(Text { text: txt, x: pos.x, y: if top_left { pos.y - h * s } else { pos.y }, height: h * s, rotation: rot + mrot, origin: self.origin.clone() });
            }
            _ => return Ok(false),
        }
        Ok(true)
    }
}

fn poly_with_bulges(verts: &[(Pt, f64)], closed: bool, tol: f64) -> Vec<Pt> {
    if verts.is_empty() {
        return vec![];
    }
    let mut out = vec![verts[0].0];
    let n = verts.len();
    let last = if closed { n } else { n - 1 };
    for i in 0..last {
        let (a, b) = (verts[i], verts[(i + 1) % n]);
        out.extend(bulge_points(a.0, b.0, a.1, tol));
    }
    if closed && out.len() > 1 {
        out.pop(); // letzter Punkt = erster Punkt
    }
    out
}

/// %%c, %%d, %%p, %%% wie die vier replace() im TypeScript (nacheinander)
fn percent_codes(s: &str) -> String {
    let rep = |s: &str, f: &dyn Fn(char) -> Option<&'static str>| -> String {
        let c: Vec<char> = s.chars().collect();
        let mut out = String::new();
        let mut i = 0;
        while i < c.len() {
            if i + 2 < c.len() && c[i] == '%' && c[i + 1] == '%' {
                if let Some(r) = f(c[i + 2]) {
                    out.push_str(r);
                    i += 3;
                    continue;
                }
            }
            out.push(c[i]);
            i += 1;
        }
        out
    };
    let s = rep(s, &|ch| matches!(ch, 'c' | 'C').then_some("Ø"));
    let s = rep(&s, &|ch| matches!(ch, 'd' | 'D').then_some("°"));
    let s = rep(&s, &|ch| matches!(ch, 'p' | 'P').then_some("±"));
    rep(&s, &|ch| (ch == '%').then_some("%"))
}

/// MTEXT: Formatierungs-Codes entfernen, \P = neue Zeile (die replace()-Kette im TypeScript, Schritt für Schritt)
fn mtext_plain(p: &[Pair]) -> String {
    let mut s: String = p.iter().filter(|(c, _)| *c == 3.0).map(|(_, v)| v.as_str()).collect();
    s += &get_str(p, 1.0).unwrap_or_default();
    // Muster `\` + Buchstabe (+ bis zum ersten `;`): f gibt (Länge, Ersatz) oder None
    fn scan(s: &str, f: &dyn Fn(&[char], usize) -> Option<(usize, String)>) -> String {
        let c: Vec<char> = s.chars().collect();
        let mut out = String::new();
        let mut i = 0;
        while i < c.len() {
            if let Some((len, r)) = f(&c, i) {
                out += &r;
                i += len;
            } else {
                out.push(c[i]);
                i += 1;
            }
        }
        out
    }
    let to_semi = |c: &[char], from: usize| c[from..].iter().position(|&ch| ch == ';').map(|k| from + k);
    let s = scan(&s, &|c, i| (c[i] == '\\' && c.get(i + 1) == Some(&'P')).then(|| (2, "\n".into())));
    let s = scan(&s, &|c, i| {
        if c[i] == '\\' && c.get(i + 1).is_some_and(|ch| "ACcFfHhQqTtWw".contains(*ch)) {
            return to_semi(c, i + 2).map(|e| (e + 1 - i, String::new()));
        }
        None
    });
    let s = scan(&s, &|c, i| (c[i] == '\\' && c.get(i + 1).is_some_and(|ch| "LlOoKk".contains(*ch))).then(|| (2, String::new())));
    let s = scan(&s, &|c, i| {
        if c[i] == '\\' && c.get(i + 1) == Some(&'S') {
            return to_semi(c, i + 2).map(|e| (e + 1 - i, c[i + 2..e].iter().map(|&ch| if "#^/".contains(ch) { '/' } else { ch }).collect()));
        }
        None
    });
    let s = scan(&s, &|c, i| (c[i] == '\\' && c.get(i + 1) == Some(&'~')).then(|| (2, " ".into())));
    let s: String = s.chars().filter(|&ch| ch != '{' && ch != '}').collect();
    scan(&s, &|c, i| (c[i] == '\\' && c.get(i + 1) == Some(&'\\')).then(|| (2, "\\".into())))
}

/// NURBS auswerten (de Boor); ohne Kontrollpunkte die Stützpunkte glatt verbinden. Err: das TypeScript bricht hier ab
fn spline_points(p: &[Pair], tol: f64) -> Result<Option<Vec<Pt>>, String> {
    let degree = get_num(p, 71.0, 3.0);
    let knots = get_all(p, 40.0);
    let (xs, ys) = (get_all(p, 10.0), get_all(p, 20.0));
    let weights = get_all(p, 41.0);
    if xs.len() < 2 || (knots.len() as f64) < xs.len() as f64 + degree + 1.0 {
        let (fx, fy) = (get_all(p, 11.0), get_all(p, 21.0));
        if fx.len() >= 2 {
            let pts: Vec<Pt> = fx.iter().enumerate().map(|(i, &x)| Pt { x, y: fy.get(i).copied().unwrap_or(0.0) }).collect();
            return Ok(Some(catmull_rom(&pts, tol)));
        }
        return Ok(None);
    }
    if degree < 0.0 || degree.fract() != 0.0 {
        return Err("spline degree".into()); // im TypeScript: Zugriff auf einen fehlenden Punkt (TypeError)
    }
    let deg = degree as usize;
    let ctrl: Vec<(f64, f64, f64)> = xs.iter().enumerate().map(|(i, &x)| (x, ys.get(i).copied().unwrap_or(0.0), if weights.len() == xs.len() { weights[i] } else { 1.0 })).collect();
    let (k0, k1) = (knots[deg], knots[knots.len() - deg - 1]);
    let mut len = 0.0;
    for i in 1..ctrl.len() {
        len += hypot2(ctrl[i].0 - ctrl[i - 1].0, ctrl[i].1 - ctrl[i - 1].1);
    }
    let n = mn(4000.0, mx(ctrl.len() as f64 * 8.0, (len / mx(tol * 20.0, 0.05)).ceil()));
    if n.is_nan() {
        return Ok(Some(vec![]));
    }
    Ok(Some((0..=n as usize).map(|s| de_boor(k0 + ((k1 - k0) * s as f64) / n, deg, &knots, &ctrl)).collect()))
}

fn de_boor(t: f64, p: usize, knots: &[f64], ctrl: &[(f64, f64, f64)]) -> Pt {
    let mut k = p;
    let last = knots.len() as isize - p as isize - 2;
    while (k as isize) < last && t >= knots[k + 1] {
        k += 1;
    }
    let mut d: Vec<(f64, f64, f64)> = (0..=p)
        .map(|j| {
            let c = ctrl[((j + k) as isize - p as isize).clamp(0, ctrl.len() as isize - 1) as usize];
            (c.0 * c.2, c.1 * c.2, c.2)
        })
        .collect();
    for r in 1..=p {
        for j in (r..=p).rev() {
            let i = j + k - p;
            let den = knots[i + p - r + 1] - knots[i];
            let a = if den == 0.0 { 0.0 } else { (t - knots[i]) / den };
            d[j] = ((1.0 - a) * d[j - 1].0 + a * d[j].0, (1.0 - a) * d[j - 1].1 + a * d[j].1, (1.0 - a) * d[j - 1].2 + a * d[j].2);
        }
    }
    let r = d[p];
    let w = if r.2 == 0.0 || r.2.is_nan() { 1.0 } else { r.2 };
    Pt { x: r.0 / w, y: r.1 / w }
}

fn catmull_rom(pts: &[Pt], tol: f64) -> Vec<Pt> {
    let mut out = vec![pts[0]];
    for i in 0..pts.len() - 1 {
        let (p0, p1, p2, p3) = (pts[i.saturating_sub(1)], pts[i], pts[i + 1], pts[(i + 2).min(pts.len() - 1)]);
        let seg = hypot2(p2.x - p1.x, p2.y - p1.y);
        let n = mx(2.0, mn(100.0, (seg / mx(tol * 20.0, 0.05)).ceil()));
        if n.is_nan() {
            continue;
        }
        for s in 1..=n as usize {
            let t = s as f64 / n;
            let (t2, t3) = (t * t, t * t * t);
            let f = |a: f64, b: f64, c: f64, d: f64| 0.5 * (2.0 * b + (-a + c) * t + (2.0 * a - 5.0 * b + 4.0 * c - d) * t2 + (-a + 3.0 * b - 3.0 * c + d) * t3);
            out.push(Pt { x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
        }
    }
    out
}

pub fn parse_dxf(text: &str) -> Result<Parsed, String> {
    let mut res = Parsed::default();
    if text.starts_with("AutoCAD Binary DXF") {
        res.binary = true;
        return Ok(res);
    }
    let pairs = read_pairs(text);
    let mut units = 0.0;
    let mut blocks: HashMap<String, Block> = HashMap::new();
    let mut entities: Vec<Entity> = Vec::new();
    let mut section = String::new();
    let mut current: Option<(String, Block)> = None;
    let mut i = 0;
    while i < pairs.len() {
        let code = pairs[i].0;
        let val = trim(&pairs[i].1);
        if code == 0.0 && val == "SECTION" {
            section = pairs.get(i + 1).map_or(String::new(), |p| trim(&p.1).to_string());
            i += 2;
            continue;
        }
        if code == 0.0 && val == "ENDSEC" {
            section.clear();
            i += 1;
            continue;
        }
        if section == "HEADER" {
            if code == 9.0 && val == "$INSUNITS" {
                if let Some(next) = pairs.get(i + 1).filter(|n| n.0 == 70.0) {
                    let u = parse_int(&next.1);
                    units = if u == 0.0 || u.is_nan() { 0.0 } else { u };
                }
            }
            i += 1;
            continue;
        }
        if (section == "ENTITIES" || section == "BLOCKS") && code == 0.0 {
            if val == "BLOCK" {
                let (bp, next) = read_entity(&pairs, i);
                let name = get_str(&bp, 2.0).unwrap_or_default();
                current = Some((name, Block { base: Pt { x: get_num(&bp, 10.0, 0.0), y: get_num(&bp, 20.0, 0.0) }, entities: vec![] }));
                i = next;
                continue;
            }
            if val == "ENDBLK" {
                if let Some((name, b)) = current.take() {
                    blocks.insert(name, b);
                }
                i = read_entity(&pairs, i).1;
                continue;
            }
            let kind = val.to_string();
            let (ep, next) = read_entity(&pairs, i);
            i = next;
            let mut e = Entity { kind, pairs: ep, vertices: vec![] };
            // POLYLINE: die folgenden VERTEX-Einträge bis SEQEND einsammeln
            if e.kind == "POLYLINE" {
                while i < pairs.len() {
                    let v = trim(&pairs[i].1);
                    if pairs[i].0 != 0.0 {
                        i += 1;
                        continue;
                    }
                    if v == "VERTEX" {
                        let (vp, next) = read_entity(&pairs, i);
                        e.vertices.push(vp);
                        i = next;
                        continue;
                    }
                    if v == "SEQEND" {
                        i = read_entity(&pairs, i).1;
                    }
                    break;
                }
            }
            if let (true, Some(cb)) = (section == "BLOCKS", current.as_mut()) {
                cb.1.entities.push(e);
            } else if section == "ENTITIES" {
                entities.push(e);
            }
            continue;
        }
        i += 1;
    }
    let to_mm = units_to_mm(units);
    let mut ctx = Ctx { blocks: &blocks, res, origin: Origin::default() };
    ctx.emit(&entities, &scale(to_mm, to_mm), 0, None)?;
    let mut res = ctx.res;
    res.units = units;
    res.counts = js_entries(&res.counts);
    res.skipped = js_entries(&res.skipped);
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn js_number_parsing() {
        for (s, v) in [(" 12.5e1x", 125.0), ("-.5", -0.5), ("+3.", 3.0), ("1e", 1.0), ("1e+", 1.0), ("7e-1", 0.7), ("0x10", 0.0)] {
            assert_eq!(parse_float(s), v, "{s}");
        }
        assert!(parse_float(".").is_nan() && parse_float("-").is_nan() && parse_float("e5").is_nan());
        assert_eq!((parse_float("-Infinityx"), parse_int(" 70 "), parse_int("1e3"), parse_int("-4.9")), (f64::NEG_INFINITY, 70.0, 1.0, -4.0));
        assert!(parse_int("x1").is_nan());
    }

    /// Dieselben Fälle wie tests/importDxfRust.test.ts: Zahlen auf 1e-9 genau, alles andere exakt
    #[test]
    fn same_result_as_typescript() {
        fn same(a: &Value, b: &Value, at: &str) {
            match (a, b) {
                (Value::Number(x), Value::Number(y)) => {
                    let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
                    assert!(x == y || (x - y).abs() <= 1e-9, "{at}: {x} vs {y}");
                }
                (Value::Array(x), Value::Array(y)) => {
                    assert_eq!(x.len(), y.len(), "{at}: entries");
                    for (k, (p, q)) in x.iter().zip(y).enumerate() {
                        same(p, q, &format!("{at}[{k}]"));
                    }
                }
                (Value::Object(x), Value::Object(y)) => {
                    let mut keys: Vec<&String> = x.keys().chain(y.keys()).collect();
                    keys.sort();
                    keys.dedup();
                    for k in keys {
                        same(x.get(k).unwrap_or(&Value::Null), y.get(k).unwrap_or(&Value::Null), &format!("{at}.{k}"));
                    }
                }
                _ => assert_eq!(a, b, "{at}"),
            }
        }
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let cases: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("importdxf-cases.json")).unwrap()).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 30, "only {} cases", cases.len());
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let got = serde_json::to_value(parse_dxf(c["text"].as_str().unwrap()).unwrap()).unwrap();
            same(&c["want"], &got, name);
        }
        println!("{} DXF cases the same as dxfParse.ts", cases.len());
    }
}
