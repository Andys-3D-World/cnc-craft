//! KLEINE GENERATOREN – Zwillinge von `src/livingHinge.ts`, `src/vent.ts`, `src/scales.ts` und `src/mandala.ts`.
//!
//! Biegescharnier (Schnittmuster zum Biegen), Lüftungsgitter (Lochfeld), Lineal/Winkelmesser/Zifferblatt, Mandala
//! (Ringe mit Mustern, Zufall nur über seed). Nur Geometrie in mm. Folgt dem TypeScript Zeile für Zeile. Nur Vergleich:
//! was eingefügt wird, bestimmt weiter das Fenster. Gemeinsame Fälle: `tests/fixtures/generators-cases.json.gz`.

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath::{self, js_num, js_round};
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

pub type XY = [f64; 2];

fn sin(x: f64) -> f64 {
    jsmath::sin(x)
}
fn cos(x: f64) -> f64 {
    jsmath::cos(x)
}

// =====================================================================
// Biegescharnier
// =====================================================================

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HingeOptions {
    pub pattern: String,
    pub width: f64,
    pub height: f64,
    pub panel: bool,
    pub length: f64,
    pub spacing: f64,
    pub cut: f64,
    pub bridge: f64,
    pub amplitude: f64,
    pub slot_width: f64,
    pub thickness: f64,
}
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct HingeLine {
    pub pts: Vec<XY>,
    pub closed: bool,
}
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HingeResult {
    pub outline: Option<Vec<XY>>,
    pub lines: Vec<HingeLine>,
    pub columns: f64,
    pub x0: f64,
    pub x1: f64,
    pub cut_length: f64,
    pub radius90: f64,
    pub radius180: f64,
    pub warnings: Vec<String>,
}

/// Vorschlag für Abstand, Schnittlänge und Steg aus der Materialdicke (Scharnier-Feld der Laser-Testkarte, testcard.rs)
pub fn suggest_for_thickness(t: f64) -> serde_json::Value {
    let th = mx(0.5, t);
    let r1 = |v: f64| js_round(v * 10.0) / 10.0;
    serde_json::json!({ "spacing": r1(mx(1.2, 0.6 * th)), "cut": r1(mx(10.0, 6.0 * th)), "bridge": r1(mx(2.0, th)),
        "amplitude": r1(mx(0.6, 0.3 * th)), "slotWidth": r1(mx(0.5, 0.25 * th)) })
}

/// Schnitt-Abschnitte einer Spalte: [y0, y1], symmetrisch zur Mitte, oben/unten ein Rand von margin
pub fn column_segments(height: f64, cut: f64, bridge: f64, shifted: bool, margin: f64) -> Vec<[f64; 2]> {
    let p = cut + bridge;
    let center = height / 2.0 + if shifted { p / 2.0 } else { 0.0 };
    let k_min = ((margin - center - cut / 2.0) / p).floor() - 1.0;
    let k_max = ((height - margin - center + cut / 2.0) / p).ceil() + 1.0;
    let mut out = vec![];
    let min_len = mx(1.0, mn(cut / 4.0, 3.0));
    let mut k = k_min;
    while k <= k_max {
        let a = mx(margin, center + k * p - cut / 2.0);
        let b = mn(height - margin, center + k * p + cut / 2.0);
        if b - a >= min_len {
            out.push([a, b]);
        }
        k += 1.0;
    }
    out
}

fn stadium(x: f64, y0: f64, y1: f64, w: f64) -> Vec<XY> {
    let r = w / 2.0;
    let mut pts = vec![];
    let n = 8.0;
    let mut i = 0.0;
    while i <= n {
        let a = PI + PI * i / n;
        pts.push([x + r * cos(a), y0 + r + r * sin(a)]);
        i += 1.0;
    }
    let mut i = 0.0;
    while i <= n {
        let a = PI * i / n;
        pts.push([x + r * cos(a), y1 - r + r * sin(a)]);
        i += 1.0;
    }
    pts.push(pts[0]);
    pts
}

pub fn living_hinge(o: &HingeOptions) -> HingeResult {
    let mut warnings: Vec<String> = vec![];
    let (w, h) = (mx(1.0, o.width), mx(1.0, o.height));
    let l = mn(mx(0.0, o.length), w);
    if o.length > w {
        warnings.push("hinge.warnLength".into());
    }
    let x0 = (w - l) / 2.0;
    let x1 = x0 + l;
    let n = mx(1.0, js_round(l / mx(0.3, o.spacing)));
    let s = l / n;
    let margin = mx(o.bridge, 0.5);
    let mut lines = vec![];
    let mut cut_length = 0.0;
    let amp = if o.pattern == "wave" { mx(0.0, mn(o.amplitude, s * 0.45)) } else { 0.0 };
    let lambda = mx(2.0 * PI * amp, 4.0);
    let mut i = 0.0;
    while i <= n {
        let x = x0 + i * s;
        for [a, b] in column_segments(h, o.cut, o.bridge, i % 2.0 == 1.0, margin) {
            if o.pattern == "slots" {
                let wd = mn(o.slot_width, b - a);
                lines.push(HingeLine { pts: stadium(x, a, b, wd), closed: true });
                cut_length += 2.0 * (b - a - wd) + PI * wd;
            } else if o.pattern == "wave" {
                let steps = mx(2.0, ((b - a) / 0.5).ceil());
                let mut pts: Vec<XY> = vec![];
                let mut k = 0.0;
                while k <= steps {
                    let y = a + (b - a) * k / steps;
                    pts.push([x + amp * sin(2.0 * PI * (y - h / 2.0) / lambda), y]);
                    k += 1.0;
                }
                for k in 1..pts.len() {
                    cut_length += hypot2(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
                }
                lines.push(HingeLine { pts, closed: false });
            } else {
                lines.push(HingeLine { pts: vec![[x, a], [x, b]], closed: false });
                cut_length += b - a;
            }
        }
        i += 1.0;
    }
    let outline = if o.panel { Some(vec![[0.0, 0.0], [w, 0.0], [w, h], [0.0, h], [0.0, 0.0]]) } else { None };
    if o.panel {
        cut_length += 2.0 * (w + h);
    }
    let strip = s - (if o.pattern == "slots" { o.slot_width } else { 0.0 }) - (if o.pattern == "wave" { 2.0 * amp * 0.3 } else { 0.0 });
    if strip < 0.8 {
        warnings.push("hinge.warnStrip".into());
    }
    if o.bridge < 1.0 {
        warnings.push("hinge.warnBridge".into());
    }
    if o.cut < 2.0 * o.bridge {
        warnings.push("hinge.warnStiff".into());
    }
    if o.cut + 2.0 * margin > h {
        warnings.push("hinge.warnShort".into());
    }
    let t = mx(0.0, o.thickness);
    let radius90 = mx(0.0, l / (PI / 2.0) - t / 2.0);
    let radius180 = mx(0.0, l / PI - t / 2.0);
    HingeResult { outline, lines, columns: n + 1.0, x0, x1, cut_length, radius90, radius180, warnings }
}

// =====================================================================
// Lüftungsgitter
// =====================================================================

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VentOptions {
    pub shape: String,
    pub width: f64,
    pub height: f64,
    pub radius: f64,
    pub margin: f64,
    pub pattern: String,
    pub size: f64,
    pub web: f64,
    pub slot_length: f64,
    pub plate: bool,
    pub mount_d: f64,
    pub mount_inset: f64,
}
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VentResult {
    pub outline: Option<Vec<XY>>,
    pub holes: Vec<Vec<XY>>,
    pub mounts: Vec<Vec<XY>>,
    pub open_area: f64,
    pub warnings: Vec<String>,
}

fn vcircle(cx: f64, cy: f64, r: f64, n: f64) -> Vec<XY> {
    let k = if n != 0.0 { n } else { mx(16.0, mn(96.0, (2.0 * PI * r / 0.4).ceil())) };
    let mut out = vec![];
    let mut i = 0.0;
    while i < k {
        out.push([cx + r * cos(2.0 * PI * i / k), cy + r * sin(2.0 * PI * i / k)]);
        i += 1.0;
    }
    out.push(out[0]);
    out
}

fn round_rect(w: f64, h: f64, r: f64) -> Vec<XY> {
    let r = mx(0.0, mn(mn(r, w / 2.0), h / 2.0));
    let mut pts = vec![];
    let corners = [(w / 2.0 - r, -h / 2.0 + r, -90.0), (w / 2.0 - r, h / 2.0 - r, 0.0), (-w / 2.0 + r, h / 2.0 - r, 90.0), (-w / 2.0 + r, -h / 2.0 + r, 180.0)];
    for (cx, cy, a0) in corners {
        if r == 0.0 {
            pts.push([cx, cy]);
            continue;
        }
        for k in 0..=8 {
            let a = (a0 + k as f64 * 90.0 / 8.0) * PI / 180.0;
            pts.push([cx + r * cos(a), cy + r * sin(a)]);
        }
    }
    pts.push(pts[0]);
    pts
}

fn in_field(o: &VentOptions, x: f64, y: f64) -> bool {
    if o.shape == "circle" {
        return hypot2(x, y) <= o.width / 2.0 - o.margin + 1e-9;
    }
    let (hw, hh) = (o.width / 2.0 - o.margin, o.height / 2.0 - o.margin);
    let r = mx(0.0, o.radius - o.margin);
    if x.abs() > hw + 1e-9 || y.abs() > hh + 1e-9 {
        return false;
    }
    let (dx, dy) = (x.abs() - (hw - r), y.abs() - (hh - r));
    dx <= 0.0 || dy <= 0.0 || hypot2(dx, dy) <= r + 1e-9
}

fn ring_area(r: &[XY]) -> f64 {
    let mut a = 0.0;
    let n = r.len();
    if n == 0 {
        return 0.0;
    }
    let mut j = n - 1;
    for i in 0..n {
        a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
        j = i;
    }
    (a / 2.0).abs()
}

fn staggered(span: f64, dx: f64, dy: f64, centers: &mut Vec<XY>) {
    let jn = (span / dy).ceil();
    let inn = (span / dx).ceil() + 1.0;
    let mut j = -jn;
    while j <= jn {
        let mut i = -inn;
        while i <= inn {
            centers.push([i * dx + if j.abs() % 2.0 != 0.0 { dx / 2.0 } else { 0.0 }, j * dy]);
            i += 1.0;
        }
        j += 1.0;
    }
}

fn cells_for(o: &VentOptions, span: f64) -> (Vec<XY>, Vec<XY>) {
    let s = mx(0.3, o.size);
    let w = mx(0.0, o.web);
    let mut centers = vec![];
    let mut shape: Vec<XY>;
    match o.pattern.as_str() {
        "hex" => {
            let rr = s / 3f64.sqrt();
            shape = (0..6).map(|k| {
                let a = PI / 2.0 + k as f64 * PI / 3.0;
                [rr * cos(a), rr * sin(a)]
            }).collect();
            shape.push(shape[0]);
            let dx = s + w;
            staggered(span, dx, dx * 3f64.sqrt() / 2.0, &mut centers);
        }
        "round" => {
            shape = vcircle(0.0, 0.0, s / 2.0, 0.0);
            let dx = s + w;
            staggered(span, dx, dx * 3f64.sqrt() / 2.0, &mut centers);
        }
        "square" => {
            shape = vec![[-s / 2.0, -s / 2.0], [s / 2.0, -s / 2.0], [s / 2.0, s / 2.0], [-s / 2.0, s / 2.0], [-s / 2.0, -s / 2.0]];
            let d = s + w;
            let n = (span / d).ceil();
            let mut j = -n;
            while j <= n {
                let mut i = -n;
                while i <= n {
                    centers.push([i * d, j * d]);
                    i += 1.0;
                }
                j += 1.0;
            }
        }
        _ => {
            let l = mx(s, o.slot_length);
            let r = s / 2.0;
            shape = vec![];
            for k in 0..=8 {
                let a = -PI / 2.0 + PI * k as f64 / 8.0;
                shape.push([l / 2.0 - r + r * cos(a), r * sin(a)]);
            }
            for k in 0..=8 {
                let a = PI / 2.0 + PI * k as f64 / 8.0;
                shape.push([-l / 2.0 + r + r * cos(a), r * sin(a)]);
            }
            shape.push(shape[0]);
            staggered(span, l + w, s + w, &mut centers);
        }
    }
    (centers, shape)
}

pub fn vent(o: &VentOptions) -> VentResult {
    let mut warnings: Vec<String> = vec![];
    let w = o.width;
    let h = if o.shape == "circle" { o.width } else { o.height };
    let (centers, shape) = cells_for(o, mx(w, h) / 2.0 + o.size + o.web);
    let mut holes: Vec<Vec<XY>> = vec![];
    for [cx, cy] in centers {
        let pts: Vec<XY> = shape.iter().map(|&[x, y]| [x + cx, y + cy]).collect();
        if pts.iter().all(|&[x, y]| in_field(o, x, y)) {
            holes.push(pts);
        }
    }
    let mut mounts = vec![];
    if o.mount_d > 0.0 {
        let pos: Vec<XY> = if o.shape == "circle" {
            (0..4).map(|k| {
                let a = PI / 4.0 + k as f64 * PI / 2.0;
                let r = w / 2.0 - o.mount_inset;
                [r * cos(a), r * sin(a)]
            }).collect()
        } else {
            [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]].iter().map(|&[sx, sy]| [sx * (w / 2.0 - o.mount_inset), sy * (h / 2.0 - o.mount_inset)]).collect()
        };
        for &[x, y] in &pos {
            mounts.push(vcircle(x, y, o.mount_d / 2.0, 0.0));
        }
        let keep = o.mount_d / 2.0 + mx(o.web, 1.0);
        holes.retain(|hl| !hl.iter().any(|&[hx, hy]| pos.iter().any(|&[x, y]| hypot2(hx - x, hy - y) < keep)));
        if o.mount_inset < o.mount_d / 2.0 + 1.0 {
            warnings.push("vent.warnMount".into());
        }
    }
    let outline = if o.plate { Some(if o.shape == "circle" { vcircle(0.0, 0.0, w / 2.0, 180.0) } else { round_rect(w, h, o.radius) }) } else { None };
    let field_area = if o.shape == "circle" {
        let r = w / 2.0 - o.margin;
        PI * (r * r)
    } else {
        mx(1e-9, (w - 2.0 * o.margin) * (h - 2.0 * o.margin))
    };
    let mut sum = 0.0;
    for hl in &holes {
        sum += ring_area(hl);
    }
    let open_area = 100.0 * sum / field_area;
    if holes.is_empty() {
        warnings.push("vent.warnNone".into());
    }
    if o.web < 0.8 {
        warnings.push("vent.warnWeb".into());
    }
    VentResult { outline, holes, mounts, open_area, warnings }
}

// =====================================================================
// Lineal, Winkelmesser, Zifferblatt
// =====================================================================

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScaleOptions {
    pub kind: String,
    pub unit: String,
    pub length: f64,
    pub width: f64,
    pub hole_d: f64,
    pub radius: f64,
    pub diameter: f64,
    pub numerals: String,
    pub center_hole: f64,
    pub text_h: f64,
}
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Label {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub h: f64,
    pub angle: f64,
}
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ScaleResult {
    pub outline: Vec<XY>,
    pub holes: Vec<Vec<XY>>,
    pub ticks: Vec<Vec<XY>>,
    pub labels: Vec<Label>,
    pub w: f64,
    pub h: f64,
    pub warnings: Vec<String>,
}

fn scircle(cx: f64, cy: f64, r: f64) -> Vec<XY> {
    let k = mx(32.0, mn(240.0, (2.0 * PI * r / 0.5).ceil()));
    let mut out = vec![];
    let mut i = 0.0;
    while i < k {
        out.push([cx + r * cos(2.0 * PI * i / k), cy + r * sin(2.0 * PI * i / k)]);
        i += 1.0;
    }
    out.push(out[0]);
    out
}

const ROMAN: [&str; 12] = ["XII", "I", "II", "III", "IIII", "V", "VI", "VII", "VIII", "IX", "X", "XI"];

/// Strichlänge auf dem Lineal: (Stelle, Stufe, Beschriftung)
pub fn ruler_ticks(unit: &str, length: f64) -> Vec<(f64, f64, Option<String>)> {
    let mut out = vec![];
    if unit == "mm" {
        let n = (length + 1e-9).floor();
        let mut i = 0.0;
        while i <= n {
            let level = if i % 10.0 == 0.0 { 2.0 } else if i % 5.0 == 0.0 { 1.0 } else { 0.0 };
            out.push((i, level, if i % 10.0 == 0.0 { Some(js_num(i / 10.0)) } else { None }));
            i += 1.0;
        }
    } else {
        let n = (length * 16.0 + 1e-9).floor();
        let mut i = 0.0;
        while i <= n {
            let level = if i % 16.0 == 0.0 { 4.0 } else if i % 8.0 == 0.0 { 3.0 } else if i % 4.0 == 0.0 { 2.0 } else if i % 2.0 == 0.0 { 1.0 } else { 0.0 };
            out.push((i * 25.4 / 16.0, level, if i % 16.0 == 0.0 { Some(js_num(i / 16.0)) } else { None }));
            i += 1.0;
        }
    }
    out
}

fn ruler(o: &ScaleOptions) -> ScaleResult {
    let mut warnings = vec![];
    let w = mx(8.0, o.width);
    let ticks0 = ruler_ticks(&o.unit, o.length);
    let scale_len = ticks0.last().map_or(0.0, |t| t.0);
    let left = 5.0;
    let right = if o.hole_d > 0.0 { o.hole_d + 8.0 } else { 5.0 };
    let l = left + scale_len + right;
    let max_level = if o.unit == "mm" { 2.0 } else { 4.0 };
    let longest = mn(w * 0.45, 8.0);
    let len = |lv: f64| longest * (0.4 + 0.6 * lv / max_level);
    let (mut ticks, mut labels) = (vec![], vec![]);
    for (pos, level, label) in ticks0 {
        let x = left + pos;
        ticks.push(vec![[x, w], [x, w - len(level)]]);
        if let Some(text) = label {
            labels.push(Label { text, x, y: w - longest - 1.0 - o.text_h / 2.0, h: o.text_h, angle: 0.0 });
        }
    }
    if w - longest - 1.0 - o.text_h < 1.5 {
        warnings.push("scale.warnNarrow".into());
    }
    let holes = if o.hole_d > 0.0 { vec![scircle(l - right / 2.0, w / 2.0, o.hole_d / 2.0)] } else { vec![] };
    if o.hole_d > w - 3.0 {
        warnings.push("scale.warnHole".into());
    }
    ScaleResult { outline: vec![[0.0, 0.0], [l, 0.0], [l, w], [0.0, w], [0.0, 0.0]], holes, ticks, labels, w: l, h: w, warnings }
}

fn protractor(o: &ScaleOptions) -> ScaleResult {
    let r = mx(20.0, o.radius);
    let base = mx(6.0, r * 0.12);
    let mut outline: Vec<XY> = vec![[r, -base], [r, 0.0]];
    let n = mx(90.0, (PI * r / 0.5).ceil());
    let mut i = 1.0;
    while i < n {
        let a = PI * i / n;
        outline.push([r * cos(a), r * sin(a)]);
        i += 1.0;
    }
    outline.extend([[-r, 0.0], [-r, -base], [r, -base]]);
    let longest = mn(r * 0.12, 8.0);
    let (mut ticks, mut labels) = (vec![], vec![]);
    for d in 0..=180 {
        let df = d as f64;
        let a = df * PI / 180.0;
        let l = if d % 10 == 0 { longest } else if d % 5 == 0 { longest * 0.7 } else { longest * 0.4 };
        let (c, s) = (cos(a), sin(a));
        ticks.push(vec![[r * c, r * s], [(r - l) * c, (r - l) * s]]);
        if d % 10 == 0 {
            let rr = r - longest - 1.0 - o.text_h / 2.0;
            labels.push(Label { text: d.to_string(), x: rr * c, y: rr * s, h: o.text_h, angle: a - PI / 2.0 });
        }
    }
    let m = mn(5.0, r * 0.08);
    ticks.push(vec![[-m, 0.0], [m, 0.0]]);
    ticks.push(vec![[0.0, -mn(m, base - 1.0)], [0.0, m]]);
    let mut warnings = vec![];
    let r_text = r - longest - 1.0 - o.text_h;
    if r_text * PI / 18.0 < o.text_h * 1.6 {
        warnings.push("scale.warnBig".into());
    }
    ScaleResult { outline, holes: vec![], ticks, labels, w: 2.0 * r, h: r + base, warnings }
}

fn clock(o: &ScaleOptions) -> ScaleResult {
    let r = mx(20.0, o.diameter / 2.0);
    let (e, major, minor) = (r * 0.04, r * 0.12, r * 0.05);
    let (mut ticks, mut labels) = (vec![], vec![]);
    for k in 0..60 {
        let a = PI / 2.0 - k as f64 * PI / 30.0;
        let (c, s) = (cos(a), sin(a));
        let l = if k % 5 == 0 { major } else { minor };
        ticks.push(vec![[(r - e) * c, (r - e) * s], [(r - e - l) * c, (r - e - l) * s]]);
    }
    let mut warnings = vec![];
    if o.numerals != "none" {
        let rr = r - e - major - 1.5 - o.text_h * 0.8;
        for k in 0..12 {
            let a = PI / 2.0 - k as f64 * PI / 6.0;
            let text = if o.numerals == "roman" { ROMAN[k].to_string() } else { (if k == 0 { 12 } else { k }).to_string() };
            labels.push(Label { text, x: rr * cos(a), y: rr * sin(a), h: o.text_h, angle: 0.0 });
        }
        if o.text_h > rr * PI / 6.0 * 0.7 {
            warnings.push("scale.warnBig".into());
        }
    }
    let holes = if o.center_hole > 0.0 { vec![scircle(0.0, 0.0, o.center_hole / 2.0)] } else { vec![] };
    ScaleResult { outline: scircle(0.0, 0.0, r), holes, ticks, labels, w: 2.0 * r, h: 2.0 * r, warnings }
}

pub fn scale(o: &ScaleOptions) -> ScaleResult {
    match o.kind.as_str() {
        "ruler" => ruler(o),
        "protractor" => protractor(o),
        _ => clock(o),
    }
}

// =====================================================================
// Mandala
// =====================================================================

#[derive(Deserialize, Clone, Debug)]
pub struct MandalaOptions {
    pub d: f64,
    pub n: f64,
    pub rings: f64,
    pub web: f64,
    pub edge: String,
    pub center: String,
    pub seed: f64,
    #[serde(default)]
    pub motif: Option<String>,
}
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Mandala {
    pub outer: Vec<Pt>,
    pub holes: Vec<Vec<Pt>>,
    pub motifs: Vec<String>,
}

const MOTIFS: [&str; 10] = ["petal", "drop", "circle", "diamond", "arch", "spike", "onion", "hourglass", "capsule", "fan"];
const MIN_FEATURE: f64 = 0.8;
const SAMPLES: usize = 24;

/// einfacher, fester Zufall (mulberry32) wie im Fenster
struct Rng(u32);
impl Rng {
    fn new(seed: f64) -> Rng {
        // (Math.floor(seed) >>> 0) || 1
        let f = seed.floor();
        let a = if f.is_finite() { crate::gcodesim::to_int32(f) as u32 } else { 0 };
        Rng(if a == 0 { 1 } else { a })
    }
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }
}

fn pw(a: f64, b: f64) -> f64 {
    jsmath::pow(a, b)
}

/// Breite (0 … 1) entlang des Musters, s = 0 innen … 1 außen
fn profile(m: &str, s: f64) -> f64 {
    match m {
        "petal" => sin(PI * s),
        "drop" => sin(PI * pw(s, 0.6)) * if s < 0.15 { s / 0.15 } else { 1.0 },
        "diamond" => 1.0 - (2.0 * s - 1.0).abs(),
        "arch" => mx(0.0, 1.0 - pw(mx(0.0, 2.0 * s - 1.0), 2.0)).sqrt() * mn(1.0, s * 12.0),
        "spike" => pw(1.0 - s, 1.3) * mn(1.0, s * 10.0),
        "onion" => pw(sin(PI * pw(s, 0.8)), 1.5) * (0.35 + 0.65 * mn(1.0, s * 2.5)) * (1.0 - pw(s, 6.0)),
        "hourglass" => mx(0.0, 1.0 - pw(2.0 * s - 1.0, 8.0)).sqrt() * (0.35 + 0.65 * pw(2.0 * s - 1.0, 2.0)),
        "capsule" => {
            let e = mn(s, 1.0 - s) / 0.2;
            if e >= 1.0 {
                1.0
            } else {
                mx(0.0, 1.0 - (1.0 - e) * (1.0 - e)).sqrt()
            }
        }
        "fan" => mn(1.0, 0.2 + 0.8 * s) * mx(0.0, 1.0 - pw(mx(0.0, (s - 0.8) / 0.2), 2.0)).sqrt() * mn(1.0, s * 12.0),
        _ => mx(0.0, 1.0 - pw(2.0 * s - 1.0, 2.0)).sqrt(),
    }
}

fn rot(p: Pt, a: f64) -> Pt {
    Pt { x: p.x * cos(a) - p.y * sin(a), y: p.x * sin(a) + p.y * cos(a) }
}

fn motif_shape(m: &str, r0: f64, r1: f64, half: f64, web: f64) -> Option<Vec<Pt>> {
    let len = r1 - r0;
    if len < MIN_FEATURE {
        return None;
    }
    let allow = |r: f64| r * sin(half) - web / 2.0;
    if m == "circle" {
        let rc = mn(len / 2.0, allow(r0 + len / 2.0) * 0.98);
        if rc < MIN_FEATURE / 2.0 {
            return None;
        }
        let c = r0 + len / 2.0;
        let mut pts = vec![];
        for i in 0..SAMPLES * 2 {
            let a = (i as f64 / (SAMPLES * 2) as f64) * PI * 2.0;
            pts.push(Pt { x: c + rc * cos(a), y: rc * sin(a) });
        }
        return Some(pts);
    }
    let mut w_max = f64::INFINITY;
    for i in 0..=SAMPLES {
        let s = i as f64 / SAMPLES as f64;
        let p = profile(m, s);
        if p > 0.05 {
            w_max = mn(w_max, allow(r0 + s * len) / p);
        }
    }
    w_max = mn(w_max, len * 0.45);
    if !(w_max * 2.0 >= MIN_FEATURE) {
        return None;
    }
    let w = |r: f64| w_max * profile(m, (r - r0) / len);
    let (mut right, mut left) = (vec![], vec![]);
    for i in 0..=SAMPLES {
        let r = r0 + (i as f64 / SAMPLES as f64) * len;
        let v = mx(0.0, w(r));
        right.push(Pt { x: r, y: -v });
        left.push(Pt { x: r, y: v });
    }
    left.reverse();
    let all: Vec<Pt> = right.into_iter().chain(left).collect();
    let mut pts = vec![];
    for (i, p) in all.iter().enumerate() {
        if i == 0 || hypot2(p.x - all[i - 1].x, p.y - all[i - 1].y) > 1e-6 {
            pts.push(*p);
        }
    }
    if pts.len() >= 3 {
        Some(pts)
    } else {
        None
    }
}

fn edge_radius(edge: &str, d: f64, n: f64, a: f64) -> f64 {
    let r = d / 2.0;
    match edge {
        "wavy" => r - r * 0.04 * (1.0 - cos(n * a)) / 2.0,
        "petals" => r - r * 0.08 * (1.0 - cos((n * a) / 2.0).abs()),
        "zigzag" => {
            let u = ((n * a) / (2.0 * PI)) % 1.0;
            r - r * 0.08 * (2.0 * u - 1.0).abs()
        }
        "lace" => r - r * 0.04 * (1.0 - cos(n * a).abs()),
        _ => r,
    }
}

fn edge_depth(edge: &str) -> f64 {
    match edge {
        "round" => 0.0,
        "wavy" | "lace" => 0.04,
        "petals" | "zigzag" => 0.08,
        _ => 0.0,
    }
}

pub fn mandala(o: &MandalaOptions) -> Mandala {
    let n = mx(3.0, mn(36.0, js_round(o.n)));
    let rings = mx(1.0, mn(8.0, js_round(o.rings))) as usize;
    let r_out = o.d / 2.0;
    let web = mx(0.3, o.web);
    let mut rand = Rng::new(o.seed);
    let mut outer = vec![];
    let steps = mx(120.0, n * 24.0);
    let mut i = 0.0;
    while i < steps {
        let a = (i / steps) * PI * 2.0;
        let r = edge_radius(&o.edge, o.d, n, a);
        outer.push(Pt { x: r * cos(a), y: r * sin(a) });
        i += 1.0;
    }
    let r_edge = r_out * (1.0 - edge_depth(&o.edge)) - web;
    let r_center = if o.center == "none" { web } else { mx(web * 2.0, r_out * 0.12) };
    let parts: Vec<f64> = (0..rings).map(|_| 0.6 + rand.next()).collect();
    let sum: f64 = parts.iter().fold(0.0, |a, b| a + b);
    let (mut holes, mut motifs): (Vec<Vec<Pt>>, Vec<String>) = (vec![], vec![]);
    let mut r = r_center;
    for part in parts.iter().take(rings) {
        let band = ((r_edge - r_center) * part) / sum;
        let (r0, r1) = (r + web / 2.0, r + band - web / 2.0);
        r += band;
        let pick = MOTIFS[(rand.next() * MOTIFS.len() as f64).floor() as usize];
        let m = match &o.motif {
            Some(mm) if mm != "mixed" && MOTIFS.contains(&mm.as_str()) => mm.clone(),
            _ => pick.to_string(),
        };
        motifs.push(m.clone());
        let count = if rand.next() < 0.35 && n <= 18.0 { n * 2.0 } else { n };
        let offset = if rand.next() < 0.5 { PI / count } else { 0.0 };
        let Some(shape) = motif_shape(&m, r0, r1, PI / count, web) else { continue };
        let mut i = 0.0;
        while i < count {
            let a = offset + (i * 2.0 * PI) / count;
            holes.push(shape.iter().map(|&p| rot(p, a)).collect());
            i += 1.0;
        }
    }
    match o.center.as_str() {
        "hole" => {
            let rc = r_center - web;
            if rc >= MIN_FEATURE / 2.0 {
                holes.push((0..48).map(|i| {
                    let a = (i as f64 / 48.0) * PI * 2.0;
                    Pt { x: rc * cos(a), y: rc * sin(a) }
                }).collect());
            }
        }
        "flower" => {
            let cnt = mn(n, 12.0);
            if let Some(shape) = motif_shape("petal", web, r_center - web / 2.0, PI / cnt, web) {
                let mut i = 0.0;
                while i < cnt {
                    let a = (i * 2.0 * PI) / cnt;
                    holes.push(shape.iter().map(|&p| rot(p, a)).collect());
                    i += 1.0;
                }
            }
        }
        "star" => {
            let cnt = mx(5.0, mn(n, 12.0));
            let ro = r_center - web;
            let ri = ro * 0.5;
            if ri >= MIN_FEATURE / 2.0 {
                let mut st = vec![];
                let mut i = 0.0;
                while i < 2.0 * cnt {
                    let a = (i * PI) / cnt;
                    let rr = if i % 2.0 != 0.0 { ri } else { ro };
                    st.push(Pt { x: rr * cos(a), y: rr * sin(a) });
                    i += 1.0;
                }
                holes.push(st);
            }
        }
        "dots" => {
            let rc = r_center - web;
            let size = |c: f64| mn(rc / 4.0, ((rc * sin(PI / c) - web / 2.0) / (1.0 + sin(PI / c))) * 0.95);
            let divs: Vec<f64> = (0..10).map(|i| 12.0 - i as f64).filter(|c| n % c == 0.0).collect();
            let cnt = divs.iter().copied().find(|&c| size(c) >= mn(rc / 4.0, 1.1)).or(divs.last().copied()).unwrap_or(3.0);
            let rd = size(cnt);
            let ring = rc - rd;
            let r0 = ring - rd - web;
            let disc = |cx: f64, cy: f64, r: f64, k: usize| -> Vec<Pt> {
                (0..k).map(|i| Pt { x: cx + r * cos((2.0 * PI * i as f64) / k as f64), y: cy + r * sin((2.0 * PI * i as f64) / k as f64) }).collect()
            };
            if rd >= MIN_FEATURE / 2.0 && ring * sin(PI / cnt) - rd >= web / 2.0 {
                let mut i = 0.0;
                while i < cnt {
                    let a = (i * 2.0 * PI) / cnt;
                    holes.push(disc(ring * cos(a), ring * sin(a), rd, 24));
                    i += 1.0;
                }
                if r0 >= MIN_FEATURE / 2.0 {
                    holes.push(disc(0.0, 0.0, r0, 32));
                }
            }
        }
        _ => {}
    }
    Mandala { outer, holes, motifs }
}

#[derive(Deserialize, Clone, Debug)]
pub struct Job {
    pub kind: String,
    #[serde(default)]
    pub hinge: Option<HingeOptions>,
    #[serde(default)]
    pub vent: Option<VentOptions>,
    #[serde(default)]
    pub scale: Option<ScaleOptions>,
    #[serde(default)]
    pub mandala: Option<MandalaOptions>,
}

/// Einer der vier Generatoren, wie das Fenster ihn beim Einfügen gerechnet hat
pub fn run(job: &Job) -> Result<serde_json::Value, String> {
    let v = match job.kind.as_str() {
        "hinge" => job.hinge.as_ref().map(|o| serde_json::to_value(living_hinge(o))),
        "vent" => job.vent.as_ref().map(|o| serde_json::to_value(vent(o))),
        "scale" => job.scale.as_ref().map(|o| serde_json::to_value(scale(o))),
        "mandala" => job.mandala.as_ref().map(|o| serde_json::to_value(mandala(o))),
        _ => None,
    };
    v.ok_or_else(|| format!("no options for {}", job.kind))?.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsmath::to_fixed;
    use serde_json::Value;
    use std::io::Read;

    fn flat(v: &Value) -> Option<Vec<f64>> {
        match v {
            Value::Number(n) => Some(vec![n.as_f64().unwrap()]),
            Value::Array(a) => {
                let mut out = vec![];
                for e in a {
                    out.extend(flat(e)?);
                }
                Some(out)
            }
            Value::Object(o) => {
                let mut keys: Vec<&String> = o.keys().collect();
                keys.sort();
                let mut out = vec![];
                for k in keys {
                    out.extend(flat(&o[k])?);
                }
                Some(out)
            }
            _ => None,
        }
    }
    /// wie digest() im Test des Fensters: lange Punktlisten als Anzahl und Prüfsumme (6 Stellen)
    fn digest(v: &Value) -> Value {
        match v {
            Value::Array(a) => match flat(v) {
                Some(f) if f.len() > 64 => {
                    let text = f.iter().map(|x| to_fixed(*x, 6)).collect::<Vec<_>>().join(",");
                    let mut h: u32 = 0x811c9dc5;
                    for b in text.bytes() {
                        h = (h ^ b as u32).wrapping_mul(0x01000193);
                    }
                    serde_json::json!({ "n": f.len(), "h": h })
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

    #[test]
    fn same_result_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("generators-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        let cases = all["cases"].as_array().unwrap();
        assert!(cases.len() >= 80, "only {} cases", cases.len());
        for (i, c) in cases.iter().enumerate() {
            let job: Job = serde_json::from_value(c["job"].clone()).unwrap();
            same(&digest(&run(&job).unwrap()), &c["want"], &format!("case {i} ({})", job.kind));
        }
        for s in all["suggest"].as_array().unwrap() {
            same(&suggest_for_thickness(s["t"].as_f64().unwrap()), &s["want"], "suggestForThickness");
        }
        println!("{} generator results the same as the TypeScript", cases.len());
    }
}
