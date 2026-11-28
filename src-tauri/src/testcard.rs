//! LASER-TESTKARTE – Zwilling von `src/testCard.ts` (buildCard mit allen Feldern, packPanels, wrapText, sortByStage,
//! scanSpeeds, kerfSlots, kerfFromFit, focusAllowed) und `src/materialGrid.ts` (step, layoutTest).
//!
//! Ein Stück Material, einmal lasern, viele Felder – jedes trägt seine Werte (Leistung, Geschwindigkeit, Abstand, Stufe).
//! Die übersetzten Texte bringt das Fenster mit (Schlüssel → Text). Folgt dem TypeScript Zeile für Zeile. Nur Vergleich:
//! was eingefügt wird, bestimmt weiter das Fenster. Gemeinsame Fälle: `tests/fixtures/testcard-cases.json.gz`.

use crate::gcodesim::{mn, mx};
use crate::generators::{living_hinge, suggest_for_thickness, HingeOptions};
use crate::jsmath::{self, js_num, js_round, to_fixed};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const PANEL_IDS: [&str; 13] = ["engrave", "cut", "interval", "wedge", "threshold", "scan", "kerf", "text", "hinge", "air", "repeat", "ruler", "focus"];

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CardOptions {
    pub laser_type: String,
    pub laser_w: f64,
    pub card_w: f64,
    pub card_h: f64,
    pub material: String,
    pub thickness: f64,
    pub machine: String,
    pub header: bool,
    pub outline: bool,
    pub panels: Vec<String>,
    #[serde(rename = "ePMin")]
    pub e_pmin: f64,
    #[serde(rename = "ePMax")]
    pub e_pmax: f64,
    pub e_cols: f64,
    #[serde(rename = "eSMin")]
    pub e_smin: f64,
    #[serde(rename = "eSMax")]
    pub e_smax: f64,
    pub e_rows: f64,
    pub interval: f64,
    #[serde(rename = "cPMin")]
    pub c_pmin: f64,
    #[serde(rename = "cPMax")]
    pub c_pmax: f64,
    pub c_cols: f64,
    #[serde(rename = "cSMin")]
    pub c_smin: f64,
    #[serde(rename = "cSMax")]
    pub c_smax: f64,
    pub c_rows: f64,
    pub cut_air: bool,
    pub ref_power: f64,
    pub ref_speed: f64,
    pub cut_power: f64,
    pub cut_speed: f64,
    pub i_min: f64,
    pub i_max: f64,
    pub scan_max: f64,
    pub kerf_max: f64,
    pub text_power: f64,
    pub text_speed: f64,
    pub cell: f64,
    /// prüft der Dialog nicht (leeres Feld = NaN, kommt als null)
    #[serde(deserialize_with = "nan_num")]
    pub focus_step: f64,
    #[serde(deserialize_with = "nan_num")]
    pub focus_steps: f64,
    pub z_confirmed: bool,
}
fn nan_num<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN))
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}
fn pt(x: f64, y: f64) -> Pt {
    Pt { x, y }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ov {
    pub power: f64,
    pub speed: f64,
    pub interval: f64,
    pub stage: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub air: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_mm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub z_off: Option<f64>,
}
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Cell {
    pub p: String,
    pub r: f64,
    pub c: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v: Option<f64>,
}
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Item {
    Poly {
        pts: Vec<Pt>,
        closed: bool,
        role: String,
        ov: Ov,
        #[serde(skip_serializing_if = "Option::is_none")]
        cell: Option<Cell>,
    },
    Text {
        text: String,
        x: f64,
        y: f64,
        h: f64,
        align: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        rot: Option<bool>,
        ov: Ov,
    },
}
impl Item {
    fn stage(&self) -> f64 {
        match self {
            Item::Poly { ov, .. } | Item::Text { ov, .. } => ov.stage,
        }
    }
}

const ST_TEXT: f64 = 0.0;
const ST_REPEAT_A: f64 = 1.0;
const ST_ENGRAVE: f64 = 2.0;
const ST_REPEAT_B: f64 = 3.0;
const ST_LINES: f64 = 4.0;
const ST_CUT_INNER: f64 = 5.0;
const ST_OUTLINE: f64 = 6.0;

const CARD_MARGIN: f64 = 3.0;
const PANEL_GAP: f64 = 4.0;
const LAB: f64 = 2.0;
const CAP: f64 = 1.5;
const TITLE: f64 = 2.4;
const HEADER: f64 = 3.0;
const CHAR: f64 = 0.82;
pub const KERF_TAB: f64 = 4.0;
const SCALES: [f64; 5] = [1.0, 0.9, 0.8, 0.7, 0.6];

fn rect(x: f64, y: f64, w: f64, h: f64) -> Vec<Pt> {
    vec![pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)]
}
/// s.length in UTF-16-Einheiten wie im Fenster
fn jlen(s: &str) -> f64 {
    s.encode_utf16().count() as f64
}
fn text_w(s: &str, h: f64) -> f64 {
    jlen(s) * CHAR * h
}
fn round(v: f64, d: i32) -> f64 {
    let f = format!("1e{d}").parse::<f64>().unwrap();
    js_round(v * f) / f
}

/// Werte einer Stufe i von n zwischen a und b (materialGrid.ts)
pub fn step(a: f64, b: f64, i: f64, n: f64, digits: i32) -> f64 {
    let v = if n <= 1.0 { a } else { a + ((b - a) * i) / (n - 1.0) };
    let f = jsmath::pow(10.0, digits as f64);
    js_round(v * f) / f
}

struct GridCell {
    x: f64,
    y: f64,
    power: f64,
    speed: f64,
    interval: f64,
}
struct GridLabel {
    text: String,
    x: f64,
    y: f64,
    align: &'static str,
    rot: Option<bool>,
}
struct MatOpts {
    fill: bool,
    row_speed: bool,
    cols: f64,
    pmin: f64,
    pmax: f64,
    rows: f64,
    rmin: f64,
    rmax: f64,
    speed: f64,
    interval: f64,
    cell: f64,
    gap: f64,
    text_h: f64,
}
fn layout_test(o: &MatOpts) -> (Vec<GridCell>, Vec<GridLabel>, f64, f64) {
    let pitch = o.cell + o.gap;
    let h = o.rows * pitch - o.gap;
    let w = o.cols * pitch - o.gap;
    let (mut cells, mut labels) = (vec![], vec![]);
    let rd = if o.row_speed { 0 } else { 2 };
    let mut r = 0.0;
    while r < o.rows {
        let rv = step(o.rmin, o.rmax, r, o.rows, rd);
        let y = h - r * pitch - o.cell;
        let mut c = 0.0;
        while c < o.cols {
            let pw = step(o.pmin, o.pmax, c, o.cols, 1);
            cells.push(GridCell { x: c * pitch, y, power: pw, speed: if o.row_speed { rv } else { o.speed }, interval: if o.row_speed { o.interval } else { rv } });
            c += 1.0;
        }
        labels.push(GridLabel { text: js_num(rv), x: -o.text_h * 0.6, y: y + (o.cell - o.text_h) / 2.0, align: "right", rot: None });
        r += 1.0;
    }
    let mut c = 0.0;
    while c < o.cols {
        labels.push(GridLabel { text: js_num(step(o.pmin, o.pmax, c, o.cols, 1)), x: c * pitch + o.cell / 2.0, y: h + o.text_h * 0.6, align: "center", rot: Some(o.cell < o.text_h * 2.6) });
        c += 1.0;
    }
    labels.push(GridLabel { text: if o.row_speed { "mm/min".into() } else { "mm".into() }, x: -o.text_h * 0.6, y: h + o.text_h * 0.6, align: "right", rot: None });
    let t = if o.fill && o.row_speed { format!("% {}mm", js_num(o.interval)) } else if o.row_speed { "%".into() } else { format!("% {}mm/min", js_num(o.speed)) };
    labels.push(GridLabel { text: t, x: 0.0, y: h + o.text_h * 2.2 + if o.cell < o.text_h * 2.6 { o.text_h * 1.5 } else { 0.0 }, align: "left", rot: None });
    (cells, labels, w, h)
}

/// Text in Zeilen dieser Breite umbrechen
pub fn wrap_text(s: &str, max_w: f64, h: f64) -> Vec<String> {
    let max = mx(4.0, (max_w / (CHAR * h)).floor());
    let mut out = vec![];
    let mut line = String::new();
    for w in s.split(crate::gcodesim::js_space).filter(|w| !w.is_empty()) {
        if !line.is_empty() && jlen(&line) + 1.0 + jlen(w) > max {
            out.push(std::mem::take(&mut line));
            line = w.to_string();
        } else if line.is_empty() {
            line = w.to_string();
        } else {
            line = format!("{line} {w}");
        }
    }
    if !line.is_empty() {
        out.push(line);
    }
    out
}

struct Ctx<'a> {
    o: &'a CardOptions,
    tr: &'a HashMap<String, String>,
}
impl Ctx<'_> {
    fn tr(&self, k: &str) -> String {
        self.tr.get(k).cloned().unwrap_or_else(|| k.to_string())
    }
    fn text_ov(&self) -> Ov {
        Ov { power: self.o.text_power, speed: self.o.text_speed, interval: self.o.interval, stage: ST_TEXT, air: None, scan_mm: None, z_off: None }
    }
    fn fill_ov(&self) -> Ov {
        Ov { power: self.o.ref_power, speed: self.o.ref_speed, interval: self.o.interval, stage: ST_ENGRAVE, air: None, scan_mm: None, z_off: None }
    }
    fn cut_ov(&self, stage: f64) -> Ov {
        Ov { power: self.o.cut_power, speed: self.o.cut_speed, interval: self.o.interval, stage, air: Some(self.o.cut_air), scan_mm: None, z_off: None }
    }
    fn text(&self, text: String, x: f64, y: f64, h: f64, align: &str, rot: Option<bool>, ov: Ov) -> Item {
        Item::Text { text, x, y, h, align: align.into(), rot, ov }
    }
}

struct Panel {
    id: &'static str,
    w: f64,
    h: f64,
    items: Vec<Item>,
}

fn shift(it: &Item, dx: f64, dy: f64) -> Item {
    match it {
        Item::Poly { pts, closed, role, ov, cell } => Item::Poly { pts: pts.iter().map(|q| pt(q.x + dx, q.y + dy)).collect(), closed: *closed, role: role.clone(), ov: ov.clone(), cell: cell.clone() },
        Item::Text { text, x, y, h, align, rot, ov } => Item::Text { text: text.clone(), x: x + dx, y: y + dy, h: *h, align: align.clone(), rot: *rot, ov: ov.clone() },
    }
}

fn frame(cx: &Ctx, id: &'static str, cw: f64, ch: f64, items: &[Item], ox: f64) -> Panel {
    let w = mx(cw + ox, 36.0);
    let cap = wrap_text(&cx.tr(&format!("tcard.read.{id}")), w, CAP);
    let ov = cx.text_ov();
    let mut out: Vec<Item> = items.iter().map(|it| shift(it, ox, 0.0)).collect();
    let mut y = ch + 1.2 + (cap.len() as f64 - 1.0) * CAP * 1.5;
    for (i, line) in cap.iter().enumerate() {
        out.push(cx.text(line.clone(), 0.0, y - i as f64 * CAP * 1.5, CAP, "left", None, ov.clone()));
    }
    y += CAP + 1.0;
    out.push(cx.text(cx.tr(&format!("tcard.p.{id}")), 0.0, y, TITLE, "left", None, ov));
    Panel { id, w, h: y + TITLE, items: out }
}

fn cell_of(p: &str, r: f64, c: f64, v: Option<f64>) -> Option<Cell> {
    Some(Cell { p: p.into(), r, c, v })
}

fn grid(cx: &Ctx, id: &'static str, cell: f64) -> Panel {
    let o = cx.o;
    let engrave = id == "engrave";
    let mt = MatOpts {
        fill: engrave,
        row_speed: true,
        cols: if engrave { o.e_cols } else { o.c_cols },
        pmin: if engrave { o.e_pmin } else { o.c_pmin },
        pmax: if engrave { o.e_pmax } else { o.c_pmax },
        rows: if engrave { o.e_rows } else { o.c_rows },
        rmin: if engrave { o.e_smin } else { o.c_smin },
        rmax: if engrave { o.e_smax } else { o.c_smax },
        speed: o.ref_speed,
        interval: o.interval,
        cell,
        gap: mx(1.0, cell * 0.2),
        text_h: LAB,
    };
    let (cells, labels, lw, lh) = layout_test(&mt);
    let mut items: Vec<Item> = cells
        .iter()
        .enumerate()
        .map(|(i, c)| Item::Poly {
            pts: rect(c.x, c.y, cell, cell),
            closed: true,
            role: if engrave { "engrave".into() } else { "cut".into() },
            ov: Ov { power: c.power, speed: c.speed, interval: c.interval, stage: if engrave { ST_ENGRAVE } else { ST_CUT_INNER }, air: if engrave { None } else { Some(o.cut_air) }, scan_mm: None, z_off: None },
            cell: cell_of(id, (i as f64 / mt.cols).floor(), i as f64 % mt.cols, None),
        })
        .collect();
    let ov = cx.text_ov();
    for lb in labels {
        items.push(cx.text(lb.text, lb.x, lb.y, LAB, lb.align, lb.rot, ov.clone()));
    }
    let top = if cell < LAB * 2.6 { LAB * 5.2 } else { LAB * 3.7 };
    frame(cx, id, lw, lh + top, &items, LAB * 5.0)
}

struct Field {
    label: String,
    ov: Ov,
    cell: Option<Cell>,
}
fn strip(cx: &Ctx, id: &'static str, fields: Vec<Field>, fw: f64, fh: f64, gap: f64) -> Panel {
    let ov = cx.text_ov();
    let rot = fields.iter().any(|f| text_w(&f.label, LAB) > fw + gap);
    let label_h = if rot { fields.iter().map(|f| text_w(&f.label, LAB)).fold(f64::NEG_INFINITY, mx) + 1.0 } else { LAB + 1.0 };
    let mut items = vec![];
    let n = fields.len() as f64;
    for (i, f) in fields.into_iter().enumerate() {
        let x = i as f64 * (fw + gap);
        items.push(Item::Poly { pts: rect(x, 0.0, fw, fh), closed: true, role: "engrave".into(), ov: f.ov, cell: f.cell });
        items.push(cx.text(f.label, x + fw / 2.0, fh + 1.0, LAB, "center", Some(rot), ov.clone()));
    }
    frame(cx, id, n * (fw + gap) - gap, fh + label_h, &items, 0.0)
}

/// String(+v.toFixed(2))
fn lab(v: f64) -> String {
    js_num(to_fixed(v, 2).parse::<f64>().unwrap())
}

fn interval_panel(cx: &Ctx, cell: f64) -> Panel {
    let o = cx.o;
    let fields = (0..6).map(|i| {
        let v = step(o.i_min, o.i_max, i as f64, 6.0, 3);
        Field { label: lab(v), ov: Ov { interval: v, ..cx.fill_ov() }, cell: cell_of("interval", 0.0, i as f64, Some(v)) }
    }).collect();
    strip(cx, "interval", fields, cell, cell, 1.5)
}
fn wedge_panel(cx: &Ctx, cell: f64) -> Panel {
    let o = cx.o;
    let fields = (0..10).map(|i| {
        let v = step(o.e_pmin, o.e_pmax, i as f64, 10.0, 1);
        Field { label: js_num(js_round(v)), ov: Ov { power: v, ..cx.fill_ov() }, cell: cell_of("wedge", 0.0, i as f64, Some(v)) }
    }).collect();
    strip(cx, "wedge", fields, mx(3.0, cell * 0.7), cell, 0.0)
}
fn threshold_panel(cx: &Ctx, cell: f64) -> Panel {
    let o = cx.o;
    let n = 8.0;
    let top = mx(n, js_round(o.e_pmin));
    let fields = (0..8).map(|i| {
        let v = step(1.0, top, i as f64, n, 1);
        Field { label: js_num(v), ov: Ov { power: v, ..cx.fill_ov() }, cell: cell_of("threshold", 0.0, i as f64, Some(v)) }
    }).collect();
    strip(cx, "threshold", fields, mx(3.0, cell * 0.7), cell, 0.8)
}

/// Geschwindigkeiten der Versatz-Zeilen
pub fn scan_speeds(o: &CardOptions) -> Vec<f64> {
    [o.e_smin, (o.e_smin + o.e_smax) / 2.0, o.e_smax].iter().map(|&v| js_round(v)).collect()
}
fn scan_panel(cx: &Ctx) -> Panel {
    let o = cx.o;
    let (cols, bar, gap_bar, bars) = (7.0, 1.0, 1.0, 3.0);
    let fw = bars * bar + (bars - 1.0) * gap_bar;
    let fh = 7.0;
    let (pitch_x, pitch_y) = (fw + 2.0, fh + 2.0);
    let speeds = scan_speeds(o);
    let lm = LAB * 5.0;
    let ov = cx.text_ov();
    let mut items = vec![];
    let h = speeds.len() as f64 * pitch_y - 2.0;
    for (r, &sp) in speeds.iter().enumerate() {
        let y = h - (r as f64 + 1.0) * pitch_y + 2.0;
        items.push(cx.text(js_num(sp), -1.0, y + (fh - LAB) / 2.0, LAB, "right", None, ov.clone()));
        let mut c = 0.0;
        while c < cols {
            let mm = step(0.0, o.scan_max, c, cols, 3);
            let mut b = 0.0;
            while b < bars {
                items.push(Item::Poly {
                    pts: rect(c * pitch_x + b * (bar + gap_bar), y, bar, fh),
                    closed: true,
                    role: "engrave".into(),
                    ov: Ov { speed: sp, interval: 0.2, scan_mm: Some(mm), ..cx.fill_ov() },
                    cell: cell_of("scan", r as f64, c, Some(mm)),
                });
                b += 1.0;
            }
            c += 1.0;
        }
    }
    let mut c = 0.0;
    while c < cols {
        items.push(cx.text(lab(step(0.0, o.scan_max, c, cols, 3)), c * pitch_x + fw / 2.0, h + 1.0, LAB, "center", Some(true), ov.clone()));
        c += 1.0;
    }
    frame(cx, "scan", cols * pitch_x - 2.0, h + 9.0, &items, lm)
}

/// Schlitze: (Schnittbreite k, Schlitzbreite)
pub fn kerf_slots(kerf_max: f64, n: usize) -> Vec<(f64, f64)> {
    let top = mn(1.0, mx(0.05, kerf_max));
    (0..n).map(|i| {
        let k = step(0.0, top, i as f64, n as f64, 3);
        (k, round(KERF_TAB - 2.0 * k, 3))
    }).collect()
}
/// Schnittbreite aus dem Schlitz, der passt (im Fenster nur beim Ablesen der Karte: nur vom Test verglichen)
#[allow(dead_code)]
pub fn kerf_from_fit(tab: f64, slot_width: f64) -> f64 {
    mx(0.0, round((tab - slot_width) / 2.0, 3))
}
fn kerf_panel(cx: &Ctx) -> Panel {
    let slots = kerf_slots(cx.o.kerf_max, 7);
    let (pitch, sh) = (6.5, 10.0);
    let ov = cx.text_ov();
    let cut = cx.cut_ov(ST_CUT_INNER);
    let mut items = vec![];
    for (i, &(k, width)) in slots.iter().enumerate() {
        let x = i as f64 * pitch + (KERF_TAB - width) / 2.0;
        items.push(Item::Poly { pts: rect(x, 0.0, width, sh), closed: true, role: "cut".into(), ov: cut.clone(), cell: cell_of("kerf", 0.0, i as f64, Some(k)) });
        items.push(cx.text(lab(k), i as f64 * pitch + KERF_TAB / 2.0, sh + 1.0, LAB, "center", Some(true), ov.clone()));
    }
    let px = slots.len() as f64 * pitch + 1.0;
    let (head, stem, sl, hh) = (10.0, KERF_TAB, sh - 2.0, 3.0);
    let sx = px + (head - stem) / 2.0;
    items.push(Item::Poly {
        pts: vec![pt(sx, 0.0), pt(sx + stem, 0.0), pt(sx + stem, sl), pt(px + head, sl), pt(px + head, sl + hh), pt(px, sl + hh), pt(px, sl), pt(sx, sl)],
        closed: true,
        role: "cut".into(),
        ov: cut,
        cell: None,
    });
    frame(cx, "kerf", px + head, sh + 8.0, &items, 0.0)
}
fn text_panel(cx: &Ctx) -> Panel {
    let ov = cx.text_ov();
    let mut items = vec![];
    let mut y = 0.0;
    for s in [1.0, 1.5, 2.0, 3.0, 4.0] {
        items.push(cx.text(format!("Ag8 {}", js_num(s)), 0.0, y, s, "left", None, ov.clone()));
        y += s + 1.2;
    }
    frame(cx, "text", 30.0, y, &items, 0.0)
}
fn hinge_panel(cx: &Ctx) -> Panel {
    let (w, h) = (34.0, 20.0);
    let t = cx.o.thickness;
    let sg = suggest_for_thickness(t);
    let g = |k: &str| sg[k].as_f64().unwrap_or(f64::NAN);
    let r = living_hinge(&HingeOptions {
        pattern: "lines".into(),
        width: w,
        height: h,
        panel: true,
        length: 20.0,
        thickness: t,
        spacing: g("spacing"),
        cut: g("cut"),
        bridge: g("bridge"),
        amplitude: g("amplitude"),
        slot_width: g("slotWidth"),
    });
    let cut = cx.cut_ov(ST_CUT_INNER);
    let mut items: Vec<Item> = r.lines.iter().map(|l| Item::Poly { pts: l.pts.iter().map(|q| pt(q[0], q[1])).collect(), closed: l.closed, role: "cut".into(), ov: cut.clone(), cell: None }).collect();
    if let Some(ol) = &r.outline {
        items.push(Item::Poly { pts: ol.iter().map(|q| pt(q[0], q[1])).collect(), closed: true, role: "cut".into(), ov: cut, cell: None });
    }
    frame(cx, "hinge", w, h, &items, 0.0)
}
fn air_panel(cx: &Ctx, cell: f64) -> Panel {
    let ov = cx.text_ov();
    let fw = mx(10.0, cell * 2.0);
    let slit = 5.0;
    let mut items = vec![];
    for (i, air) in [true, false].into_iter().enumerate() {
        let x = i as f64 * (fw + 3.0);
        items.push(Item::Poly { pts: rect(x, slit + 1.0, fw, fw * 0.7), closed: true, role: "engrave".into(), ov: Ov { air: Some(air), ..cx.fill_ov() }, cell: cell_of("air", 0.0, i as f64, None) });
        items.push(Item::Poly { pts: vec![pt(x, slit / 2.0), pt(x + fw, slit / 2.0)], closed: false, role: "cut".into(), ov: Ov { air: Some(air), ..cx.cut_ov(ST_CUT_INNER) }, cell: None });
        items.push(cx.text(cx.tr(if air { "tcard.airOn" } else { "tcard.airOff" }), x, slit + 2.0 + fw * 0.7, LAB, "left", None, ov.clone()));
    }
    frame(cx, "air", 2.0 * fw + 3.0, slit + 2.0 + fw * 0.7 + LAB + 1.0, &items, 0.0)
}
fn repeat_panel(cx: &Ctx, cell: f64) -> Panel {
    let fw = mx(10.0, cell * 2.0);
    strip(cx, "repeat", vec![
        Field { label: "A".into(), ov: Ov { stage: ST_REPEAT_A, ..cx.fill_ov() }, cell: cell_of("repeat", 0.0, 0.0, None) },
        Field { label: "B".into(), ov: Ov { stage: ST_REPEAT_B, ..cx.fill_ov() }, cell: cell_of("repeat", 0.0, 1.0, None) },
    ], fw, fw * 0.7, 3.0)
}
fn ruler_panel(cx: &Ctx) -> Panel {
    let (l, v) = (50.0, 12.0);
    let ov = Ov { stage: ST_LINES, ..cx.text_ov() };
    let t_ov = cx.text_ov();
    let mut items = vec![];
    let tick = |a: Pt, b: Pt, items: &mut Vec<Item>| items.push(Item::Poly { pts: vec![a, b], closed: false, role: "text".into(), ov: ov.clone(), cell: None });
    tick(pt(0.0, 0.0), pt(l, 0.0), &mut items);
    for i in 0..=50 {
        let fi = i as f64;
        tick(pt(fi, 0.0), pt(fi, if i % 10 == 0 { 3.5 } else if i % 5 == 0 { 2.5 } else { 1.5 }), &mut items);
    }
    let mut i = 10;
    while i <= 50 {
        items.push(cx.text(i.to_string(), i as f64, 4.0, LAB, "center", None, t_ov.clone()));
        i += 10;
    }
    tick(pt(l + 4.0, 0.0), pt(l + 4.0, v), &mut items);
    for i in 0..=12 {
        let fi = i as f64;
        tick(pt(l + 4.0, fi), pt(l + 4.0 + if i % 10 == 0 { 3.0 } else if i % 5 == 0 { 2.0 } else { 1.0 }, fi), &mut items);
    }
    frame(cx, "ruler", l + 8.0, mx(v, 4.0 + LAB) + 0.5, &items, 0.0)
}

/// Fokus-Leiter nur mit kleinen Schritten, kurzem Weg und bestätigter Z-Achse
pub fn focus_allowed(o: &CardOptions) -> bool {
    o.z_confirmed && o.focus_step > 0.0 && o.focus_step <= 1.0 && o.focus_steps.fract() == 0.0 && o.focus_steps.is_finite() && o.focus_steps >= 2.0 && o.focus_steps <= 9.0
        && o.focus_step * (o.focus_steps - 1.0) <= 5.0
}
fn focus_panel(cx: &Ctx) -> Panel {
    let o = cx.o;
    let ov = cx.text_ov();
    let lm = LAB * 3.5;
    let pitch = 3.5;
    let mut items = vec![];
    let mut i = 0.0;
    while i < o.focus_steps {
        let z = round(i * o.focus_step, 3);
        let y = i * pitch;
        items.push(Item::Poly {
            pts: vec![pt(0.0, y), pt(26.0, y)],
            closed: false,
            role: "line".into(),
            ov: Ov { power: o.ref_power, speed: o.ref_speed, interval: o.interval, stage: ST_LINES, air: None, scan_mm: None, z_off: if z != 0.0 { Some(z) } else { None } },
            cell: cell_of("focus", i, 0.0, Some(z)),
        });
        items.push(cx.text(format!("+{}", lab(z)), -1.0, y - LAB / 2.0, LAB, "right", None, ov.clone()));
        i += 1.0;
    }
    let shifted: Vec<Item> = items.iter().map(|it| shift(it, 0.0, LAB / 2.0)).collect();
    frame(cx, "focus", 26.0, (o.focus_steps - 1.0) * pitch + LAB / 2.0 + 0.5, &shifted, lm)
}

fn build_panel(cx: &Ctx, id: &'static str, s: f64) -> Option<Panel> {
    let cell = mx(3.0, js_round(cx.o.cell * s * 10.0) / 10.0);
    Some(match id {
        "engrave" | "cut" => grid(cx, id, cell),
        "interval" => interval_panel(cx, cell),
        "wedge" => wedge_panel(cx, cell),
        "threshold" => threshold_panel(cx, cell),
        "scan" => scan_panel(cx),
        "kerf" => kerf_panel(cx),
        "text" => text_panel(cx),
        "hinge" => hinge_panel(cx),
        "air" => air_panel(cx, cell),
        "repeat" => repeat_panel(cx, cell),
        "ruler" => ruler_panel(cx),
        "focus" => {
            if focus_allowed(cx.o) {
                focus_panel(cx)
            } else {
                return None;
            }
        }
        _ => return None,
    })
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Placed {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Fläche füllen: die höchsten Felder zuerst, jedes in die erste Reihe, in die es passt
pub fn pack_panels(sizes: &[(&str, f64, f64)], w: f64, h: f64, gap: f64) -> (Vec<Placed>, Vec<String>) {
    let mut order: Vec<(&str, f64, f64)> = sizes.to_vec();
    // b.h - a.h || b.w - a.w, stabil
    order.sort_by(|a, b| {
        let d = b.2 - a.2;
        let d = if d != 0.0 && !d.is_nan() { d } else { b.1 - a.1 };
        if d > 0.0 {
            std::cmp::Ordering::Greater
        } else if d < 0.0 {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Equal
        }
    });
    let mut shelves: Vec<(f64, f64, f64)> = vec![]; // y, h, x
    let (mut placed, mut left) = (vec![], vec![]);
    let mut used = 0.0;
    for (id, pw, ph) in order {
        let mut sh = shelves.iter().position(|q| q.2 + pw <= w + 1e-6 && ph <= q.1 + 1e-6);
        if sh.is_none() && pw <= w && used + ph <= h + 1e-6 {
            shelves.push((used, ph, 0.0));
            sh = Some(shelves.len() - 1);
            used += ph + gap;
        }
        let Some(k) = sh else {
            left.push(id.to_string());
            continue;
        };
        placed.push(Placed { id: id.into(), x: shelves[k].2, y: h - shelves[k].0 - ph, w: pw, h: ph });
        shelves[k].2 += pw + gap;
    }
    (placed, left)
}

/// Reihenfolge nach Stufe, gleiche Stufe bleibt wie sie ist
pub fn sort_by_stage(items: Vec<Item>) -> Vec<Item> {
    let mut idx: Vec<(usize, Item)> = items.into_iter().enumerate().collect();
    idx.sort_by(|a, b| {
        let d = a.1.stage() - b.1.stage();
        if d < 0.0 {
            std::cmp::Ordering::Less
        } else if d > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            a.0.cmp(&b.0)
        }
    });
    idx.into_iter().map(|x| x.1).collect()
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardResult {
    pub items: Vec<Item>,
    pub placed: Vec<Placed>,
    pub left: Vec<String>,
    pub scale: f64,
    pub focus_refused: bool,
}

/// Karte zusammensetzen: Felder werden erst verkleinert, was dann noch nicht passt, bleibt weg
pub fn build_card(o: &CardOptions, tr: &HashMap<String, String>) -> CardResult {
    let cx = Ctx { o, tr };
    let wanted: Vec<&'static str> = PANEL_IDS.iter().copied().filter(|id| o.panels.iter().any(|p| p == id)).collect();
    let focus_refused = wanted.contains(&"focus") && !focus_allowed(o);
    let top = if o.header { HEADER + 2.0 } else { 0.0 };
    let w = o.card_w - 2.0 * CARD_MARGIN;
    let h = o.card_h - 2.0 * CARD_MARGIN - top;
    let mut best: Option<(Vec<Panel>, (Vec<Placed>, Vec<String>), f64)> = None;
    for s in SCALES {
        let panels: Vec<Panel> = wanted.iter().filter_map(|id| build_panel(&cx, id, s)).collect();
        let sizes: Vec<(&str, f64, f64)> = panels.iter().map(|p| (p.id, p.w, p.h)).collect();
        let pack = pack_panels(&sizes, w, h, PANEL_GAP);
        let better = best.as_ref().is_none_or(|b| pack.1.len() < b.1 .1.len());
        let done = pack.1.is_empty();
        if better {
            best = Some((panels, pack, s));
        }
        if done {
            break;
        }
    }
    let (panels, (placed, left), scale) = best.unwrap();
    let mut items = vec![];
    for pl in &placed {
        let pn = panels.iter().find(|q| q.id == pl.id).unwrap();
        for it in &pn.items {
            items.push(shift(it, CARD_MARGIN + pl.x, CARD_MARGIN + pl.y));
        }
    }
    if o.header {
        let parts = [o.material.clone(), if o.thickness > 0.0 { format!("{} mm", js_num(o.thickness)) } else { String::new() }, format!("{} {} W", cx.tr(&format!("tcard.type.{}", o.laser_type)), js_num(o.laser_w)), o.machine.clone()];
        let text = parts.iter().map(|s| s.trim_matches(crate::gcodesim::js_space).to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" - ");
        items.push(cx.text(text, CARD_MARGIN, o.card_h - CARD_MARGIN - HEADER, HEADER, "left", None, cx.text_ov()));
    }
    if o.outline {
        items.push(Item::Poly { pts: rect(0.0, 0.0, o.card_w, o.card_h), closed: true, role: "cut".into(), ov: cx.cut_ov(ST_OUTLINE), cell: None });
    }
    CardResult { items: sort_by_stage(items), placed, left, scale, focus_refused }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::io::Read;

    /// Gleiche Schreibweise wie `canon` in tests/testCardRust.test.ts
    fn canon(v: &Value) -> String {
        match v {
            Value::Number(n) => to_fixed(n.as_f64().unwrap(), 6),
            Value::String(s) => serde_json::to_string(s).unwrap(),
            Value::Bool(b) => b.to_string(),
            Value::Array(a) => format!("[{}]", a.iter().map(canon).collect::<Vec<_>>().join(",")),
            Value::Object(o) => {
                let mut keys: Vec<&String> = o.keys().collect();
                keys.sort();
                format!("{{{}}}", keys.iter().map(|k| format!("{}:{}", serde_json::to_string(k).unwrap(), canon(&o[*k]))).collect::<Vec<_>>().join(","))
            }
            Value::Null => "null".into(),
        }
    }
    fn fnv(t: &str) -> u32 {
        let mut h: u32 = 0x811c9dc5;
        for b in t.bytes() {
            h = (h ^ b as u32).wrapping_mul(0x01000193);
        }
        h
    }
    fn chunks(items: &[Value]) -> Vec<u32> {
        items.chunks(8).map(|c| fnv(&c.iter().map(canon).collect::<Vec<_>>().join(";"))).collect()
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
    fn tr_of(v: &Value) -> HashMap<String, String> {
        serde_json::from_value(v.clone()).unwrap()
    }

    #[test]
    fn same_card_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("testcard-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();

        let first = &all["first"];
        let o: CardOptions = serde_json::from_value(first["o"].clone()).unwrap();
        same(&serde_json::to_value(build_card(&o, &tr_of(&first["tr"]))).unwrap(), &first["card"], "first card");

        let cases = all["cases"].as_array().unwrap();
        assert!(cases.len() >= 100, "only {} cards", cases.len());
        for (i, c) in cases.iter().enumerate() {
            let o: CardOptions = serde_json::from_value(c["o"].clone()).unwrap();
            let card = build_card(&o, &tr_of(&c["tr"]));
            let items: Vec<Value> = card.items.iter().map(|it| serde_json::to_value(it).unwrap()).collect();
            let got = json!({ "items": items.len(), "h": chunks(&items), "placed": card.placed, "left": card.left, "scale": card.scale, "focusRefused": card.focus_refused });
            same(&got, &c["want"], &format!("card {i}"));
        }

        for (i, s) in all["steps"].as_array().unwrap().iter().enumerate() {
            let f = |k: &str| s[k].as_f64().unwrap();
            same(&json!(step(f("a"), f("b"), f("i"), f("n"), f("d") as i32)), &s["v"], &format!("step {i}"));
        }
        for (i, w) in all["wraps"].as_array().unwrap().iter().enumerate() {
            let got = wrap_text(w["s"].as_str().unwrap(), w["w"].as_f64().unwrap(), w["h"].as_f64().unwrap());
            same(&json!(got), &w["out"], &format!("wrap {i}"));
        }
        for (i, k) in all["kerfs"].as_array().unwrap().iter().enumerate() {
            let got: Vec<Value> = kerf_slots(k["m"].as_f64().unwrap(), k["n"].as_u64().unwrap() as usize).iter().map(|(k, w)| json!({ "k": k, "width": w })).collect();
            same(&json!(got), &k["out"], &format!("kerf slots {i}"));
        }
        for (i, f) in all["fits"].as_array().unwrap().iter().enumerate() {
            same(&json!(kerf_from_fit(f["t"].as_f64().unwrap(), f["w"].as_f64().unwrap())), &f["k"], &format!("kerf fit {i}"));
        }
        for (i, f) in all["focus"].as_array().unwrap().iter().enumerate() {
            let o: CardOptions = serde_json::from_value(f["o"].clone()).unwrap();
            same(&json!({ "ok": focus_allowed(&o), "speeds": scan_speeds(&o) }), &json!({ "ok": f["ok"], "speeds": f["speeds"] }), &format!("focus {i}"));
        }
        for (i, p) in all["packs"].as_array().unwrap().iter().enumerate() {
            let sizes: Vec<(&str, f64, f64)> = p["sizes"].as_array().unwrap().iter().map(|s| (s["id"].as_str().unwrap(), s["w"].as_f64().unwrap(), s["h"].as_f64().unwrap())).collect();
            let (placed, left) = pack_panels(&sizes, p["W"].as_f64().unwrap(), p["H"].as_f64().unwrap(), p["gap"].as_f64().unwrap());
            same(&json!({ "placed": placed, "left": left }), &p["out"], &format!("pack {i}"));
        }
        println!("{} test cards laid out the same as testCard.ts", cases.len());
    }
}
