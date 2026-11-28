//! VEKTOR-EXPORT – Zwilling von `src/vectorExport.ts` (curveItems, toSvg, toDxf, toPdf, toHpgl).
//!
//! Eingabe sind neutrale Elemente in mm mit Y nach oben (Pfad mit Wölbungen, Kreis, Bogen, Bild). Linienzüge werden
//! vorher zu Kreisen und Bögen zusammengefasst (arcfit.rs). SVG mit Inkscape-Ebenen, DXF R12, PDF eine Seite, PLT (HPGL).
//! Folgt dem TypeScript Zeile für Zeile; der Test vergleicht den Text Zeichen für Zeichen.
//! Gemeinsame Fälle: `tests/fixtures/vexport-cases.json.gz`.

use crate::arcfit::{fit_circle, fit_path_arcs};
use crate::gcodesim::{hypot2, js_space, mn, mx};
use crate::jsmath::{self, js_num, js_round, to_fixed};
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;
use unicode_normalization::UnicodeNormalization;

#[derive(Deserialize, Serialize, Clone, Copy, Debug)]
pub struct XY {
    pub x: f64,
    pub y: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Shape {
    Path {
        pts: Vec<XY>,
        closed: bool,
        #[serde(default)]
        bulges: Option<Vec<Option<f64>>>,
    },
    Circle { cx: f64, cy: f64, r: f64 },
    Arc { cx: f64, cy: f64, r: f64, start: f64, sweep: f64 },
    Image { corners: [XY; 4], src: String },
}

#[derive(Deserialize, Clone, Debug)]
pub struct Item {
    pub layer: String,
    pub color: String,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(flatten)]
    pub shape: Shape,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExpResult {
    pub data: String,
    pub skipped_images: u32,
}

/// `bulges[i] || 0`
fn bulge(b: &Option<Vec<Option<f64>>>, i: usize) -> f64 {
    b.as_ref().and_then(|v| v.get(i).copied().flatten()).filter(|w| !w.is_nan()).unwrap_or(0.0)
}

/// replace(/\.?0+$/, ""): ab der frühesten Stelle, nach der nur noch ein Punkt und Nullen kommen
fn strip_zeros(s: &str) -> &str {
    let b = s.as_bytes();
    for i in 0..b.len() {
        let r = &b[i..];
        let z = if r.first() == Some(&b'.') { &r[1..] } else { r };
        if !z.is_empty() && z.iter().all(|&c| c == b'0') {
            return &s[..i];
        }
    }
    s
}

/// Zahl auf d Stellen, ohne Nullen am Ende, nie „-0“
fn f(v: f64, d: usize) -> String {
    let p = format!("1e{d}").parse::<f64>().unwrap();
    let s = to_fixed(js_round(v * p) / p, d);
    let s = strip_zeros(&s);
    if s == "-0" {
        "0".into()
    } else {
        s.into()
    }
}
fn f4(v: f64) -> String {
    f(v, 4)
}

/// Punkte entlang eines Bogens (höchstens tol mm Abweichung)
fn arc_pts(cx: f64, cy: f64, r: f64, a0: f64, sweep: f64, tol: f64) -> Vec<XY> {
    let step = if r > tol { 2.0 * jsmath::acos(1.0 - tol / r) } else { PI / 4.0 };
    let n = mx(2.0, (sweep.abs() / mx(1e-3, step)).ceil());
    let mut out = vec![];
    let mut i = 0.0;
    while i <= n {
        let a = a0 + sweep * (i / n);
        out.push(XY { x: cx + r * jsmath::cos(a), y: cy + r * jsmath::sin(a) });
        i += 1.0;
    }
    out
}

/// Geschlossene Pfade: doppelten Endpunkt (= Anfang) weglassen
fn open_pts(pts: &[XY], closed: bool) -> Vec<XY> {
    if !closed || pts.len() < 2 {
        return pts.to_vec();
    }
    let (a, b) = (pts[0], pts[pts.len() - 1]);
    if hypot2(a.x - b.x, a.y - b.y) < 1e-6 {
        pts[..pts.len() - 1].to_vec()
    } else {
        pts.to_vec()
    }
}

struct Bulged {
    cx: f64,
    cy: f64,
    r: f64,
    start: f64,
    sweep: f64,
}

/// Mittelpunkt, Radius und Winkel eines gewölbten Stücks
fn bulge_arc(a: XY, b: XY, w: f64) -> Bulged {
    let sweep = 4.0 * jsmath::atan(w);
    let d = hypot2(b.x - a.x, b.y - a.y);
    let r = d / (2.0 * jsmath::sin(sweep.abs() / 2.0));
    // Math.sign
    let sign = if w > 0.0 { 1.0 } else if w < 0.0 { -1.0 } else { w };
    let h = r * jsmath::cos(sweep / 2.0) * sign;
    let cx = (a.x + b.x) / 2.0 - ((b.y - a.y) / d) * h;
    let cy = (a.y + b.y) / 2.0 + ((b.x - a.x) / d) * h;
    Bulged { cx, cy, r, start: jsmath::atan2(a.y - cy, a.x - cx), sweep }
}

/// Pfad als reine Punkte (Bögen fein abgetastet)
fn flat_path(pts: &[XY], closed: bool, bulges: &Option<Vec<Option<f64>>>, tol: f64) -> Vec<XY> {
    let src = open_pts(pts, closed);
    if bulges.is_none() {
        return src;
    }
    let mut out = vec![];
    let n = src.len();
    let count = if closed { n as i64 } else { n as i64 - 1 };
    for i in 0..count.max(0) as usize {
        let (a, b, w) = (src[i], src[(i + 1) % n], bulge(bulges, i));
        if w == 0.0 {
            out.push(a);
            continue;
        }
        let g = bulge_arc(a, b, w);
        let mut q = arc_pts(g.cx, g.cy, g.r, g.start, g.sweep, tol);
        q.pop();
        if !q.is_empty() {
            q[0] = a;
        }
        out.extend(q);
    }
    if !closed && n > 0 {
        out.push(src[n - 1]);
    }
    out
}

/// Linienzüge zusammenfassen: Kreis → circle, Rundungen → Bögen im Pfad. Höchstens tol mm Abweichung
pub fn curve_items(items: &[Item], tol: f64) -> Vec<Item> {
    items
        .iter()
        .map(|it| {
            let Shape::Path { pts, closed, .. } = &it.shape else { return it.clone() };
            if pts.len() < 5 {
                return it.clone();
            }
            let p: Vec<[f64; 2]> = open_pts(pts, *closed).iter().map(|q| [q.x, q.y]).collect();
            if *closed {
                if let Some([cx, cy, r]) = fit_circle(&p, tol) {
                    return Item { shape: Shape::Circle { cx, cy, r }, ..it.clone() };
                }
            }
            let (np, nb) = fit_path_arcs(&p, *closed, tol);
            Item {
                shape: Shape::Path { pts: np.iter().map(|q| XY { x: q[0], y: q[1] }).collect(), closed: *closed, bulges: Some(nb.into_iter().map(Some).collect()) },
                ..it.clone()
            }
        })
        .collect()
}

#[derive(Clone, Copy)]
struct Bounds {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

fn export_bounds(items: &[Item]) -> Option<Bounds> {
    let mut b: Option<Bounds> = None;
    let mut add = |x: f64, y: f64| match &mut b {
        None => b = Some(Bounds { min_x: x, min_y: y, max_x: x, max_y: y }),
        Some(b) => {
            b.min_x = mn(b.min_x, x);
            b.min_y = mn(b.min_y, y);
            b.max_x = mx(b.max_x, x);
            b.max_y = mx(b.max_y, y);
        }
    };
    for it in items {
        match &it.shape {
            Shape::Path { pts, closed, bulges } => flat_path(pts, *closed, bulges, 0.005).iter().for_each(|p| add(p.x, p.y)),
            Shape::Circle { cx, cy, r } => {
                add(cx - r, cy - r);
                add(cx + r, cy + r);
            }
            Shape::Arc { cx, cy, r, start, sweep } => arc_pts(*cx, *cy, *r, *start, *sweep, 0.005).iter().for_each(|p| add(p.x, p.y)),
            Shape::Image { corners, .. } => corners.iter().for_each(|p| add(p.x, p.y)),
        }
    }
    b
}

/// Ebenen in der Reihenfolge, in der sie zuerst vorkommen (Name, Farbe der ersten Form)
fn layers_of(items: &[Item]) -> Vec<(String, String)> {
    let mut seen: Vec<(String, String)> = vec![];
    for it in items {
        if !seen.iter().any(|(n, _)| *n == it.layer) {
            seen.push((it.layer.clone(), it.color.clone()));
        }
    }
    seen
}

fn truthy(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

// ---- SVG ----

fn xml(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            _ => o.push(c),
        }
    }
    o
}
fn safe_color(c: &str) -> String {
    let ok = c.len() >= 4 && c.len() <= 9 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit());
    if ok {
        c.into()
    } else {
        "#000000".into()
    }
}
/// nur Bild-Daten-URLs einbetten
fn safe_image(s: &str) -> bool {
    for t in ["png", "jpeg", "gif", "webp", "bmp"] {
        if let Some(rest) = s.strip_prefix(&format!("data:image/{t};base64,")) {
            return rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=' || js_space(c));
        }
    }
    false
}

pub fn to_svg(items: &[Item], stroke_mm: f64) -> ExpResult {
    let b = export_bounds(items).unwrap_or(Bounds { min_x: 0.0, min_y: 0.0, max_x: 1.0, max_y: 1.0 });
    let w = mx(b.max_x - b.min_x, 0.001);
    let h = mx(b.max_y - b.min_y, 0.001);
    let sx = |x: f64| f4(x - b.min_x);
    let sy = |y: f64| f4(b.max_y - y);
    let mut skipped = 0;
    let mut el = |it: &Item| -> String {
        let id = truthy(&it.name).map_or(String::new(), |n| format!(" id=\"{}\"", xml(n)));
        match &it.shape {
            Shape::Path { pts, closed, bulges } => {
                let p = open_pts(pts, *closed);
                if p.len() < 2 {
                    return String::new();
                }
                let seg = |i: usize, q: XY| {
                    let w = bulge(bulges, i);
                    if w == 0.0 {
                        return format!("L{} {}", sx(q.x), sy(q.y));
                    }
                    let g = bulge_arc(p[i], q, w);
                    format!("A{} {} 0 {} {} {} {}", f4(g.r), f4(g.r), if g.sweep.abs() > PI { 1 } else { 0 }, if w > 0.0 { 0 } else { 1 }, sx(q.x), sy(q.y))
                };
                let mut parts = vec![format!("M{} {}", sx(p[0].x), sy(p[0].y))];
                for i in 1..p.len() {
                    parts.push(seg(i - 1, p[i]));
                }
                if *closed && bulge(bulges, p.len() - 1) != 0.0 {
                    parts.push(seg(p.len() - 1, p[0]));
                }
                let d = parts.join(" ") + if *closed { " Z" } else { "" };
                format!("<path{id} d=\"{d}\"/>")
            }
            Shape::Circle { cx, cy, r } => format!("<circle{id} cx=\"{}\" cy=\"{}\" r=\"{}\"/>", sx(*cx), sy(*cy), f4(*r)),
            Shape::Arc { cx, cy, r, start, sweep } => {
                let a = XY { x: cx + r * jsmath::cos(*start), y: cy + r * jsmath::sin(*start) };
                let e = start + sweep;
                let z = XY { x: cx + r * jsmath::cos(e), y: cy + r * jsmath::sin(e) };
                let large = if sweep.abs() > PI { 1 } else { 0 };
                let sw = if *sweep > 0.0 { 0 } else { 1 };
                format!("<path{id} d=\"M{} {} A{} {} 0 {large} {sw} {} {}\"/>", sx(a.x), sy(a.y), f4(*r), f4(*r), sx(z.x), sy(z.y))
            }
            Shape::Image { corners, src } => {
                if !safe_image(src) {
                    skipped += 1;
                    return String::new();
                }
                let (bl, tr, tl) = (corners[0], corners[2], corners[3]);
                let m: Vec<String> = [tr.x - tl.x, -(tr.y - tl.y), bl.x - tl.x, -(bl.y - tl.y), tl.x - b.min_x, b.max_y - tl.y].iter().map(|v| f(*v, 5)).collect();
                format!("<image{id} x=\"0\" y=\"0\" width=\"1\" height=\"1\" preserveAspectRatio=\"none\" transform=\"matrix({})\" href=\"{src}\" xlink:href=\"{src}\"/>", m.join(" "))
            }
        }
    };
    let mut out: Vec<String> = vec![];
    out.push("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>".into());
    out.push("<!-- Created with CNC Craft -->".into());
    out.push(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" xmlns:inkscape=\"http://www.inkscape.org/namespaces/inkscape\" width=\"{}mm\" height=\"{}mm\" viewBox=\"0 0 {} {}\" version=\"1.1\">",
        f4(w), f4(h), f4(w), f4(h)
    ));
    for (li, (name, color)) in layers_of(items).iter().enumerate() {
        out.push(format!(
            "  <g id=\"layer{}\" inkscape:groupmode=\"layer\" inkscape:label=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linejoin=\"round\" stroke-linecap=\"round\">",
            li + 1, xml(name), safe_color(color), f4(stroke_mm)
        ));
        let mine: Vec<&Item> = items.iter().filter(|it| it.layer == *name).collect();
        let mut done: Vec<&str> = vec![];
        for it in &mine {
            let Some(g) = truthy(&it.group) else {
                let s = el(it);
                if !s.is_empty() {
                    out.push(format!("    {s}"));
                }
                continue;
            };
            if done.contains(&g) {
                continue;
            }
            done.push(g);
            let inner: Vec<String> = mine.iter().filter(|o| o.group.as_deref() == Some(g)).map(|o| el(o)).filter(|s| !s.is_empty()).collect();
            if !inner.is_empty() {
                // name.replace(/\s+/g, "_")
                let mut nm = String::new();
                let mut in_space = false;
                for c in name.chars() {
                    if js_space(c) {
                        if !in_space {
                            nm.push('_');
                        }
                        in_space = true;
                    } else {
                        nm.push(c);
                        in_space = false;
                    }
                }
                out.push(format!("    <g id=\"{}\">", xml(&format!("{nm}-{g}"))));
                out.extend(inner.iter().map(|s| format!("      {s}")));
                out.push("    </g>".into());
            }
        }
        out.push("  </g>".into());
    }
    out.push("</svg>".into());
    out.push(String::new());
    ExpResult { data: out.join("\n"), skipped_images: skipped }
}

// ---- DXF (R12) ----

const ACI: [(i64, i64, i64, i64); 13] = [
    (1, 255, 0, 0), (2, 255, 255, 0), (3, 0, 255, 0), (4, 0, 255, 255), (5, 0, 0, 255), (6, 255, 0, 255), (7, 0, 0, 0),
    (8, 128, 128, 128), (9, 192, 192, 192), (30, 255, 127, 0), (40, 255, 191, 0), (140, 0, 127, 255), (200, 191, 0, 255),
];

/// /^#?([0-9a-f]{n})$/i → die Ziffern
fn hex_digits(s: &str, n: usize) -> Option<&str> {
    let h = s.strip_prefix('#').unwrap_or(s);
    (h.len() == n && h.bytes().all(|b| b.is_ascii_hexdigit())).then_some(h)
}

pub fn aci_color(hex: &str) -> i64 {
    let h = match hex_digits(hex, 6) {
        Some(h) => h.to_string(),
        None => match hex_digits(hex, 3) {
            Some(h) => h.chars().flat_map(|c| [c, c]).collect(),
            None => return 7,
        },
    };
    let p = |i: usize| i64::from_str_radix(&h[i..i + 2], 16).unwrap();
    let (r, g, bl) = (p(0), p(2), p(4));
    if r.max(g).max(bl) - r.min(g).min(bl) < 24 && (r > 220 || r < 40) {
        return 7;
    }
    let (mut best, mut best_d) = (7, i64::MAX);
    for (n, cr, cg, cb) in ACI {
        let d = (cr - r).pow(2) + (cg - g).pow(2) + (cb - bl).pow(2);
        if d < best_d {
            best_d = d;
            best = n;
        }
    }
    best
}

/// DXF-Ebenennamen: nur A–Z, 0–9, _ und - (R12), höchstens 31 Zeichen, nie leer
pub fn dxf_layer_name(name: &str) -> String {
    let s: String = name.nfkd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect::<String>().to_uppercase();
    let mut o = String::new();
    let mut run = false;
    for c in s.chars() {
        if c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_' || c == '-' {
            o.push(c);
            run = false;
        } else if !run {
            o.push('_');
            run = true;
        }
    }
    let t: String = o.trim_matches('_').chars().take(31).collect();
    if t.is_empty() {
        "0".into()
    } else {
        t
    }
}

pub fn to_dxf(items: &[Item]) -> ExpResult {
    let b = export_bounds(items).unwrap_or(Bounds { min_x: 0.0, min_y: 0.0, max_x: 0.0, max_y: 0.0 });
    let mut o: Vec<String> = vec![];
    let ps = |o: &mut Vec<String>, code: i64, v: &str| {
        o.push(code.to_string());
        o.push(v.to_string());
    };
    let pn = |o: &mut Vec<String>, code: i64, v: f64| {
        o.push(code.to_string());
        o.push(f(v, 6));
    };
    let mut names: Vec<(String, String)> = vec![];
    let mut colors: Vec<(String, i64)> = vec![];
    for (layer, color) in layers_of(items) {
        let n = dxf_layer_name(&layer);
        if !colors.iter().any(|(c, _)| *c == n) {
            colors.push((n.clone(), aci_color(&color)));
        }
        names.push((layer, n));
    }
    ps(&mut o, 999, "Created with CNC Craft");
    ps(&mut o, 0, "SECTION");
    ps(&mut o, 2, "HEADER");
    ps(&mut o, 9, "$ACADVER");
    ps(&mut o, 1, "AC1009");
    ps(&mut o, 9, "$INSUNITS");
    ps(&mut o, 70, "4");
    ps(&mut o, 9, "$MEASUREMENT");
    ps(&mut o, 70, "1");
    ps(&mut o, 9, "$EXTMIN");
    pn(&mut o, 10, b.min_x);
    pn(&mut o, 20, b.min_y);
    pn(&mut o, 30, 0.0);
    ps(&mut o, 9, "$EXTMAX");
    pn(&mut o, 10, b.max_x);
    pn(&mut o, 20, b.max_y);
    pn(&mut o, 30, 0.0);
    ps(&mut o, 0, "ENDSEC");

    ps(&mut o, 0, "SECTION");
    ps(&mut o, 2, "TABLES");
    ps(&mut o, 0, "TABLE");
    ps(&mut o, 2, "LTYPE");
    ps(&mut o, 70, "1");
    ps(&mut o, 0, "LTYPE");
    ps(&mut o, 2, "CONTINUOUS");
    ps(&mut o, 70, "0");
    ps(&mut o, 3, "Solid line");
    ps(&mut o, 72, "65");
    ps(&mut o, 73, "0");
    pn(&mut o, 40, 0.0);
    ps(&mut o, 0, "ENDTAB");
    ps(&mut o, 0, "TABLE");
    ps(&mut o, 2, "LAYER");
    ps(&mut o, 70, &(colors.len() + 1).to_string());
    ps(&mut o, 0, "LAYER");
    ps(&mut o, 2, "0");
    ps(&mut o, 70, "0");
    ps(&mut o, 62, "7");
    ps(&mut o, 6, "CONTINUOUS");
    for (n, c) in &colors {
        if n == "0" {
            continue;
        }
        ps(&mut o, 0, "LAYER");
        ps(&mut o, 2, n);
        ps(&mut o, 70, "0");
        ps(&mut o, 62, &c.to_string());
        ps(&mut o, 6, "CONTINUOUS");
    }
    ps(&mut o, 0, "ENDTAB");
    ps(&mut o, 0, "ENDSEC");

    let mut skipped = 0;
    let deg = |r: f64| r * 180.0 / PI;
    ps(&mut o, 0, "SECTION");
    ps(&mut o, 2, "ENTITIES");
    for it in items {
        let l = names.iter().find(|(n, _)| *n == it.layer).map_or("0".to_string(), |(_, d)| d.clone());
        match &it.shape {
            Shape::Path { pts, closed, bulges } => {
                let pts = open_pts(pts, *closed);
                if pts.len() < 2 {
                    continue;
                }
                if pts.len() == 2 && !*closed && bulge(bulges, 0) == 0.0 {
                    ps(&mut o, 0, "LINE");
                    ps(&mut o, 8, &l);
                    pn(&mut o, 10, pts[0].x);
                    pn(&mut o, 20, pts[0].y);
                    pn(&mut o, 30, 0.0);
                    pn(&mut o, 11, pts[1].x);
                    pn(&mut o, 21, pts[1].y);
                    pn(&mut o, 31, 0.0);
                    continue;
                }
                ps(&mut o, 0, "POLYLINE");
                ps(&mut o, 8, &l);
                ps(&mut o, 66, "1");
                pn(&mut o, 10, 0.0);
                pn(&mut o, 20, 0.0);
                pn(&mut o, 30, 0.0);
                ps(&mut o, 70, if *closed { "1" } else { "0" });
                for (i, q) in pts.iter().enumerate() {
                    ps(&mut o, 0, "VERTEX");
                    ps(&mut o, 8, &l);
                    pn(&mut o, 10, q.x);
                    pn(&mut o, 20, q.y);
                    pn(&mut o, 30, 0.0);
                    let w = bulge(bulges, i);
                    if w != 0.0 {
                        pn(&mut o, 42, w);
                    }
                }
                ps(&mut o, 0, "SEQEND");
                ps(&mut o, 8, &l);
            }
            Shape::Circle { cx, cy, r } => {
                ps(&mut o, 0, "CIRCLE");
                ps(&mut o, 8, &l);
                pn(&mut o, 10, *cx);
                pn(&mut o, 20, *cy);
                pn(&mut o, 30, 0.0);
                pn(&mut o, 40, *r);
            }
            Shape::Arc { cx, cy, r, start, sweep } => {
                if sweep.abs() >= PI * 2.0 - 1e-9 {
                    ps(&mut o, 0, "CIRCLE");
                    ps(&mut o, 8, &l);
                    pn(&mut o, 10, *cx);
                    pn(&mut o, 20, *cy);
                    pn(&mut o, 30, 0.0);
                    pn(&mut o, 40, *r);
                    continue;
                }
                // DXF-Bögen laufen immer gegen den Uhrzeigersinn
                let a0 = if *sweep >= 0.0 { *start } else { start + sweep };
                let a1 = a0 + sweep.abs();
                let norm = |d: f64| ((d % 360.0) + 360.0) % 360.0;
                ps(&mut o, 0, "ARC");
                ps(&mut o, 8, &l);
                pn(&mut o, 10, *cx);
                pn(&mut o, 20, *cy);
                pn(&mut o, 30, 0.0);
                pn(&mut o, 40, *r);
                pn(&mut o, 50, norm(deg(a0)));
                pn(&mut o, 51, norm(deg(a1)));
            }
            Shape::Image { .. } => skipped += 1,
        }
    }
    ps(&mut o, 0, "ENDSEC");
    ps(&mut o, 0, "EOF");
    ExpResult { data: o.join("\r\n") + "\r\n", skipped_images: skipped }
}

// ---- PDF (eine Seite, nur Linien) ----

const PT: f64 = 72.0 / 25.4;

fn hex_rgb(hex: &str) -> [f64; 3] {
    match hex_digits(hex, 6) {
        None => [0.0, 0.0, 0.0],
        Some(h) => [0, 2, 4].map(|i| i64::from_str_radix(&h[i..i + 2], 16).unwrap() as f64 / 255.0),
    }
}

/// Punkte einer Form für PDF und PLT; None = Bild
fn shape_pts(it: &Item, tol: f64) -> Option<(Vec<XY>, bool)> {
    match &it.shape {
        Shape::Path { pts, closed, bulges } => Some((flat_path(pts, *closed, bulges, tol), *closed)),
        Shape::Circle { cx, cy, r } => {
            let mut p = arc_pts(*cx, *cy, *r, 0.0, PI * 2.0, tol);
            p.pop();
            Some((p, true))
        }
        Shape::Arc { cx, cy, r, start, sweep } => Some((arc_pts(*cx, *cy, *r, *start, *sweep, tol), false)),
        Shape::Image { .. } => None,
    }
}

pub fn to_pdf(items: &[Item], stroke_mm: f64) -> ExpResult {
    let b = export_bounds(items).unwrap_or(Bounds { min_x: 0.0, min_y: 0.0, max_x: 1.0, max_y: 1.0 });
    let w = mx(b.max_x - b.min_x, 0.001) * PT;
    let h = mx(b.max_y - b.min_y, 0.001) * PT;
    let px = |x: f64| f((x - b.min_x) * PT, 3);
    let py = |y: f64| f((y - b.min_y) * PT, 3);
    let mut c: Vec<String> = vec![format!("{} w 1 J 1 j", f(stroke_mm * PT, 3))];
    let mut skipped = 0;
    for (name, color) in layers_of(items) {
        let [r, g, bl] = hex_rgb(&color);
        c.push(format!("{} {} {} RG", f(r, 3), f(g, 3), f(bl, 3)));
        for it in items {
            if it.layer != name {
                continue;
            }
            let Some((pts, closed)) = shape_pts(it, 0.01) else {
                skipped += 1;
                continue;
            };
            if pts.len() < 2 {
                continue;
            }
            let line: Vec<String> = pts.iter().enumerate().map(|(i, q)| format!("{} {} {}", px(q.x), py(q.y), if i > 0 { "l" } else { "m" })).collect();
            c.push(line.join(" ") + if closed { " s" } else { " S" });
        }
    }
    let content = c.join("\n");
    let objs = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Contents 4 0 R /Resources << >> >>", f(w, 3), f(h, 3)),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.encode_utf16().count()),
        "<< /Producer (CNC Craft) >>".to_string(),
    ];
    let mut out = String::from("%PDF-1.4\n");
    let mut offs: Vec<usize> = vec![];
    for (i, s) in objs.iter().enumerate() {
        offs.push(out.encode_utf16().count());
        out += &format!("{} 0 obj\n{s}\nendobj\n", i + 1);
    }
    let xref = out.encode_utf16().count();
    out += &format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1);
    for n in offs {
        out += &format!("{n:0>10} 00000 n \n");
    }
    out += &format!("trailer\n<< /Size {} /Root 1 0 R /Info 5 0 R >>\nstartxref\n{xref}\n%%EOF\n", objs.len() + 1);
    ExpResult { data: out, skipped_images: skipped }
}

// ---- PLT / HPGL ----

pub const HPGL_PER_MM: f64 = 40.0;

pub fn to_hpgl(items: &[Item]) -> ExpResult {
    let b = export_bounds(items).unwrap_or(Bounds { min_x: 0.0, min_y: 0.0, max_x: 0.0, max_y: 0.0 });
    let u = |v: f64, o: f64| js_num(js_round((v - o) * HPGL_PER_MM));
    let mut o: Vec<String> = vec!["IN".into(), "PA".into()];
    let mut skipped = 0;
    for (li, (name, _)) in layers_of(items).iter().enumerate() {
        o.push(format!("SP{}", (li % 8) + 1));
        for it in items {
            if it.layer != *name {
                continue;
            }
            let Some((pts, closed)) = shape_pts(it, 0.025) else {
                skipped += 1;
                continue;
            };
            if pts.len() < 2 {
                continue;
            }
            let mut seq = pts.clone();
            if closed {
                seq.push(pts[0]);
            }
            o.push(format!("PU{},{}", u(seq[0].x, b.min_x), u(seq[0].y, b.min_y)));
            o.push(format!("PD{}", seq[1..].iter().map(|q| format!("{},{}", u(q.x, b.min_x), u(q.y, b.min_y))).collect::<Vec<_>>().join(",")));
        }
    }
    o.push("PU".into());
    o.push("SP0".into());
    o.push(String::new());
    ExpResult { data: o.join(";\n"), skipped_images: skipped }
}

/// Wie exportMenu.ts: erst zusammenfassen (curveItems, 0,02 mm), dann schreiben
pub fn export(items: &[Item], format: &str) -> Option<ExpResult> {
    let items = curve_items(items, 0.02);
    match format {
        "svg" => Some(to_svg(&items, 0.1)),
        "dxf" => Some(to_dxf(&items)),
        "pdf" => Some(to_pdf(&items, 0.1)),
        "plt" => Some(to_hpgl(&items)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Read;

    #[test]
    fn small_pieces() {
        assert_eq!((f(1.23456, 4), f(-0.00001, 4), f(2.5, 4), f(100.0, 6)), ("1.2346".into(), "0".into(), "2.5".into(), "100".into()));
        assert_eq!((aci_color("#ff0000"), aci_color("#fff"), aci_color("xyz")), (1, 7, 7));
        assert_eq!((dxf_layer_name("Fräsen außen"), dxf_layer_name("___"), dxf_layer_name("ﬁ½")), ("FRASEN_AUSSEN".into(), "0".into(), "FI1_2".into()));
    }

    #[test]
    fn same_result_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("vexport-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let cases: Value = serde_json::from_str(&text).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 6, "only {} drawings", cases.len());
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let items: Vec<Item> = serde_json::from_value(c["items"].clone()).unwrap();
            for fmt in ["svg", "dxf", "pdf", "plt"] {
                let got = export(&items, fmt).unwrap();
                let want = &c["want"][fmt];
                let w = want["data"].as_str().unwrap();
                if got.data != w {
                    let k = got.data.lines().zip(w.lines()).position(|(a, b)| a != b).unwrap_or(0);
                    panic!("{name} / {fmt}: line {}: {:?} vs {:?}", k + 1, got.data.lines().nth(k), w.lines().nth(k));
                }
                assert_eq!(got.skipped_images as u64, want["skippedImages"].as_u64().unwrap(), "{name} / {fmt}: skipped images");
            }
        }
        println!("{} drawings written the same as vectorExport.ts (SVG, DXF, PDF, PLT)", cases.len());
    }
}
