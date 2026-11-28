//! BOX-GENERATOR – Zwilling von `src/box.ts` (boxPanels, outerSize, profile, outline, merge, tabsOn, flexCuts,
//! finishPanels mit Dogbones und Schnittspalt, diceMinHeight, diceAngle, cabinetDrawer, hingeAxis, hingeHoleD).
//!
//! Kiste mit Fingerzinken in 26 Arten (geschlossen, offen, Sortierkasten, Schublade, Schiebedeckel, Regal, rund mit
//! Biegescharnier, Laterne, Spardose, Vogelhaus, Vieleck, Würfelturm, Schubladenschrank, Klappdeckel, Geldgeschenk,
//! Buch …). Folgt dem TypeScript Zeile für Zeile; Schnittspalt über polyoffset.rs (Zwilling von polyOffset.ts).
//! Nur Vergleich: welche Platten eingefügt werden, bestimmt weiter das Fenster (boxGen.ts).
//! Gemeinsame Fälle: `tests/fixtures/boxgen-cases.json.gz`.

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath::{self, js_round};
use crate::polyoffset::offset_polygon;
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BoxOptions {
    pub w: f64,
    pub d: f64,
    pub h: f64,
    pub inner: bool,
    pub t: f64,
    pub finger: f64,
    pub lid: bool,
    pub kerf: f64,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub nx: Option<f64>,
    #[serde(default)]
    pub ny: Option<f64>,
    #[serde(default)]
    pub overhang: Option<f64>,
    #[serde(default)]
    pub shelves: Option<f64>,
    #[serde(default)]
    pub radius: Option<f64>,
    #[serde(default)]
    pub sides: Option<f64>,
    #[serde(default)]
    pub tool: Option<f64>,
}

const BOX_TYPES: [&str; 26] = ["closed", "open", "lidbox", "slide", "tray", "traylid", "handle", "drawer", "shelf", "flex", "flexcup", "lantern", "coin", "tissue", "bird", "planter", "scoop", "hex", "dice", "cabinet", "pulltop", "hingetop", "hingeduo", "jewel", "money", "slidebook"];
const LIDDED: [&str; 5] = ["closed", "lantern", "coin", "tissue", "bird"];
const HINGED: [&str; 3] = ["hingetop", "hingeduo", "jewel"];

fn money_rim(t: f64) -> f64 {
    mx(6.0, 2.0 * t)
}
fn is_flex(ty: &str) -> bool {
    ty == "flex" || ty == "flexcup"
}
fn cos(x: f64) -> f64 {
    jsmath::cos(x)
}
fn sin(x: f64) -> f64 {
    jsmath::sin(x)
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Pt2 {
    pub x: f64,
    pub y: f64,
}
fn p(x: f64, y: f64) -> Pt2 {
    Pt2 { x, y }
}
pub type V3 = [f64; 3];
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Place {
    pub o: V3,
    pub u: V3,
    pub v: V3,
    pub n: V3,
}
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Wrap {
    #[serde(rename = "loop")]
    pub lp: Vec<Pt2>,
    pub z0: f64,
    pub z1: f64,
}
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Panel {
    pub name: String,
    pub w: f64,
    pub h: f64,
    pub pts: Vec<Pt2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holes: Option<Vec<Vec<Pt2>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<Vec<Pt2>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<Place>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap: Option<Wrap>,
}
fn panel(name: &str, w: f64, h: f64, pts: Vec<Pt2>) -> Panel {
    Panel { name: name.into(), w, h, pts, holes: None, lines: None, at: None, wrap: None }
}

const EX: V3 = [1.0, 0.0, 0.0];
const EY: V3 = [0.0, 1.0, 0.0];
const EZ: V3 = [0.0, 0.0, 1.0];
fn flat(x: f64, y: f64, z: f64) -> Place {
    Place { o: [x, y, z], u: EX, v: EY, n: EZ }
}
fn across(x: f64, y: f64, z: f64) -> Place {
    Place { o: [x, y, z], u: EX, v: EZ, n: EY }
}
fn along(x: f64, y: f64, z: f64) -> Place {
    Place { o: [x, y, z], u: EY, v: EZ, n: EX }
}
fn move_place(pl: &Place, m: &dyn Fn(V3) -> V3, t: V3) -> Place {
    let o = m(pl.o);
    Place { o: [o[0] + t[0], o[1] + t[1], o[2] + t[2]], u: m(pl.u), v: m(pl.v), n: m(pl.n) }
}

fn type_of(o: &BoxOptions) -> String {
    match &o.kind {
        Some(k) if !k.is_empty() => k.clone(),
        _ => if o.lid { "closed".into() } else { "open".into() },
    }
}

/// Außenmaße (W × D × H) aus den eingegebenen Maßen
pub fn outer_size(o: &BoxOptions) -> (f64, f64, f64) {
    let t = mx(0.1, o.t);
    let ty = type_of(o);
    if ty == "hex" {
        return hex_size(o);
    }
    if ty == "money" {
        let m = money_rim(t);
        return if o.inner { (o.w + 2.0 * m, 3.0 * t, o.h + m) } else { (o.w, 3.0 * t, o.h) };
    }
    if !o.inner {
        return (o.w, o.d, o.h);
    }
    if HINGED.contains(&ty.as_str()) {
        return (o.w + 2.0 * t, o.d + 2.0 * t, o.h + 3.0 * t);
    }
    if ty == "shelf" || ty == "cabinet" || ty == "slidebook" {
        return (o.w + 2.0 * t, o.d + t, o.h + 2.0 * t);
    }
    (o.w + 2.0 * t, o.d + 2.0 * t, o.h + if LIDDED.contains(&ty.as_str()) { 2.0 } else { 1.0 } * t)
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<Pt2> {
    vec![p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)]
}
/// Kreis als Vieleck
pub fn circle(cx: f64, cy: f64, r: f64, n: usize) -> Vec<Pt2> {
    (0..n).map(|i| p(cx + r * cos((2.0 * PI * i as f64) / n as f64), cy + r * sin((2.0 * PI * i as f64) / n as f64))).collect()
}
fn arch_window(x0: f64, y0: f64, w: f64, h: f64) -> Vec<Pt2> {
    let r = mn(w / 2.0, h / 2.0);
    let mut pts = vec![p(x0, y0), p(x0 + w, y0)];
    for i in 0..=16 {
        let a = (PI * i as f64) / 16.0;
        pts.push(p(x0 + w / 2.0 + (w / 2.0) * cos(a), y0 + h - r + r * sin(a)));
    }
    pts
}
fn slot(cx: f64, cy: f64, len: f64, hgt: f64) -> Vec<Pt2> {
    let r = hgt / 2.0;
    let a = len / 2.0 - r;
    let mut pts = vec![];
    for i in 0..=16 {
        let t = -PI / 2.0 + (PI * i as f64) / 16.0;
        pts.push(p(cx + a + r * cos(t), cy + r * sin(t)));
    }
    for i in 0..=16 {
        let t = PI / 2.0 + (PI * i as f64) / 16.0;
        pts.push(p(cx - a + r * cos(t), cy + r * sin(t)));
    }
    pts
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Seg {
    pub a: f64,
    pub b: f64,
    pub out: bool,
}
fn sg(a: f64, b: f64, out: bool) -> Seg {
    Seg { a, b, out }
}

/// Abschnitte einer Kante (Länge L)
pub fn profile(l: f64, t: f64, finger: f64, corner: bool, odd: bool, fingers: bool) -> Vec<Seg> {
    let mut segs = vec![];
    let li = l - 2.0 * t;
    if li <= 0.0 {
        return vec![sg(0.0, l, corner)];
    }
    segs.push(sg(0.0, t, corner));
    if !fingers {
        segs.push(sg(t, l - t, true));
    } else {
        let mut k = mx(1.0, 2.0 * (li / mx(0.1, finger) / 2.0).floor() + 1.0);
        if k < 3.0 && li >= 3.0 * mx(0.5, t) {
            k = 3.0;
        }
        let s = li / k;
        let mut i = 0.0;
        while i < k {
            segs.push(sg(t + i * s, t + (i + 1.0) * s, (i % 2.0 == 1.0) == odd));
            i += 1.0;
        }
    }
    segs.push(sg(l - t, l, corner));
    merge(&segs)
}

/// Umriss einer Platte W × H aus vier Kanten-Profilen
pub fn outline(w: f64, h: f64, t: f64, bottom: &[Seg], right: &[Seg], top: &[Seg], left: &[Seg]) -> Vec<Pt2> {
    let mut pts: Vec<Pt2> = vec![];
    let add = |x: f64, y: f64, pts: &mut Vec<Pt2>| {
        if pts.last().is_none_or(|l| (l.x - x).abs() > 1e-9 || (l.y - y).abs() > 1e-9) {
            pts.push(p(x, y));
        }
    };
    let dep = |g: &Seg| if g.out { 0.0 } else { t };
    let clip = |segs: &[Seg], lo: f64, hi: f64| -> Vec<Seg> { segs.iter().map(|g| sg(mx(g.a, lo), mn(g.b, hi), g.out)).filter(|g| g.b - g.a > 1e-9).collect() };
    let (bl, bf) = (bottom[bottom.len() - 1], bottom[0]);
    let (rl, rf) = (right[right.len() - 1], right[0]);
    let (tl, tf) = (top[top.len() - 1], top[0]);
    let (ll, lf) = (left[left.len() - 1], left[0]);
    let bb = clip(bottom, dep(&lf), w - dep(&rf));
    let rr = clip(right, dep(&bl), h - dep(&tl));
    let tt = clip(top, dep(&ll), w - dep(&rl));
    let lff = clip(left, dep(&bf), h - dep(&tf));
    add(dep(&lf), dep(&bf), &mut pts);
    for g in &bb {
        let y = if g.out { 0.0 } else { t };
        add(g.a, y, &mut pts);
        add(g.b, y, &mut pts);
    }
    add(w - dep(&rf), dep(&bl), &mut pts);
    for g in &rr {
        let x = if g.out { w } else { w - t };
        add(x, g.a, &mut pts);
        add(x, g.b, &mut pts);
    }
    add(w - dep(&rl), h - dep(&tl), &mut pts);
    for g in tt.iter().rev() {
        let y = if g.out { h } else { h - t };
        add(g.b, y, &mut pts);
        add(g.a, y, &mut pts);
    }
    add(dep(&ll), h - dep(&tf), &mut pts);
    for g in lff.iter().rev() {
        let x = if g.out { 0.0 } else { t };
        add(x, g.b, &mut pts);
        add(x, g.a, &mut pts);
    }
    if pts.len() > 1 && (pts[0].x - pts[pts.len() - 1].x).abs() < 1e-9 && (pts[0].y - pts[pts.len() - 1].y).abs() < 1e-9 {
        pts.pop();
    }
    let n = pts.len();
    let mut out = vec![];
    for i in 0..n {
        let (a, q, b) = (pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n]);
        let cross = (q.x - a.x) * (b.y - q.y) - (q.y - a.y) * (b.x - q.x);
        if cross.abs() > 1e-9 {
            out.push(q);
        }
    }
    out
}

pub fn box_panels(o: &BoxOptions) -> Vec<Panel> {
    finish_panels(raw_panels(o), o.kerf, o.tool.unwrap_or(0.0))
}

/// Dogbones (Fräser Ø tool), dann Schnittspalt: Umriss um kerf/2 nach außen, Löcher um kerf/2 nach innen
pub fn finish_panels(mut panels: Vec<Panel>, kerf: f64, tool: f64) -> Vec<Panel> {
    if tool > 0.0 {
        for pn in panels.iter_mut() {
            if pn.lines.as_ref().is_none_or(|l| l.is_empty()) {
                dogbone_into(pn, tool / 2.0);
            }
        }
    }
    if kerf > 0.0 {
        let to = |v: &[Pt2]| -> Vec<[f64; 2]> { v.iter().map(|q| [q.x, q.y]).collect() };
        let back = |v: &[[f64; 2]]| -> Vec<Pt2> { v.iter().map(|q| p(q[0], q[1])).collect() };
        for pn in panels.iter_mut() {
            let loops = offset_polygon(&to(&pn.pts), kerf / 2.0, 0.005);
            if let Some(l) = loops.first() {
                pn.pts = back(l);
            }
            if let Some(holes) = &pn.holes {
                pn.holes = Some(holes.iter().filter_map(|hl| offset_polygon(&to(hl), -kerf / 2.0, 0.005).first().map(|l| back(l))).collect());
            }
        }
    }
    panels
}

/// Innenecken (Knick über 90° oder mindestens minTurn), wie concaveCorners in joints.ts: Index und beide Kantenrichtungen
fn concave_corners(ring: &[[f64; 2]], hole: bool, min_turn: f64) -> Vec<(usize, [f64; 2], [f64; 2])> {
    // ringArea über den Ring mit doppeltem Endpunkt
    let mut area = 0.0;
    let n = ring.len();
    let mut j = n - 1;
    for i in 0..n {
        area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
        j = i;
    }
    let area = area / 2.0;
    let pts = &ring[..n - 1];
    let ccw = (if area > 0.0 { 1.0 } else { -1.0 }) * if hole { -1.0 } else { 1.0 };
    let lim = jsmath::sin(min_turn * PI / 180.0);
    let m = pts.len();
    let mut out = vec![];
    for i in 0..m {
        let (a, q, b) = (pts[(i + m - 1) % m], pts[i], pts[(i + 1) % m]);
        let n1 = hypot2(a[0] - q[0], a[1] - q[1]);
        let n2 = hypot2(b[0] - q[0], b[1] - q[1]);
        if n1 < 1e-9 || n2 < 1e-9 {
            continue;
        }
        let cr = ((q[0] - a[0]) * (b[1] - q[1]) - (q[1] - a[1]) * (b[0] - q[0])) / (n1 * n2);
        let dot = ((q[0] - a[0]) * (b[0] - q[0]) + (q[1] - a[1]) * (b[1] - q[1])) / (n1 * n2);
        let sharp = dot < 0.0 || cr.abs() >= lim;
        if cr * ccw < -1e-9 && sharp {
            out.push((i, [(a[0] - q[0]) / n1, (a[1] - q[1]) / n1], [(b[0] - q[0]) / n2, (b[1] - q[1]) / n2]));
        }
    }
    out
}

fn dogbone_ring(l: &[Pt2], r: f64, hole: bool) -> Vec<Pt2> {
    if l.is_empty() {
        return vec![];
    }
    let mut ring: Vec<[f64; 2]> = l.iter().map(|a| [a.x, a.y]).collect();
    ring.push(ring[0]);
    let corners = concave_corners(&ring, hole, 30.0);
    let mut out = vec![];
    let n = l.len();
    for i in 0..n {
        let Some(&(_, e1, e2)) = corners.iter().find(|c| c.0 == i) else {
            out.push(l[i]);
            continue;
        };
        let q = [l[i].x, l[i].y];
        let (a, b) = (l[(i + n - 1) % n], l[(i + 1) % n]);
        let (bx, by) = (e1[0] + e2[0], e1[1] + e2[1]);
        let m = hypot2(bx, by);
        let m = if m == 0.0 || m.is_nan() { 1.0 } else { m };
        let d = r * m;
        if d > 0.49 * mn(hypot2(a.x - q[0], a.y - q[1]), hypot2(b.x - q[0], b.y - q[1])) {
            out.push(l[i]);
            continue;
        }
        let (cx, cy) = (q[0] + (bx / m) * r, q[1] + (by / m) * r);
        let a0 = jsmath::atan2(q[1] + e1[1] * d - cy, q[0] + e1[0] * d - cx);
        let a1 = jsmath::atan2(q[1] + e2[1] * d - cy, q[0] + e2[0] * d - cx);
        let to_corner = jsmath::atan2(q[1] - cy, q[0] - cx);
        let norm = |x: f64| ((x % (2.0 * PI)) + 2.0 * PI) % (2.0 * PI);
        let mut sweep = norm(a1 - a0);
        if norm(to_corner - a0) < sweep {
            sweep -= 2.0 * PI;
        }
        let k_n = mx(6.0, (sweep.abs() / 0.35).ceil());
        let mut k = 0.0;
        while k <= k_n {
            let an = a0 + (sweep * k) / k_n;
            out.push(p(cx + r * cos(an), cy + r * sin(an)));
            k += 1.0;
        }
    }
    out
}
fn dogbone_into(pn: &mut Panel, r: f64) {
    pn.pts = dogbone_ring(&pn.pts, r + 0.02, false);
    if let Some(holes) = &pn.holes {
        pn.holes = Some(holes.iter().map(|h| dogbone_ring(h, r + 0.02, true)).collect());
    }
}

/// Zusammenhängende Abschnitte gleicher Art zusammenfassen
pub fn merge(segs: &[Seg]) -> Vec<Seg> {
    let mut m: Vec<Seg> = vec![];
    for g in segs {
        match m.last_mut() {
            Some(last) if last.out == g.out => last.b = g.b,
            _ => m.push(*g),
        }
    }
    m
}

fn find<'a>(panels: &'a mut [Panel], n: &str) -> &'a mut Panel {
    panels.iter_mut().find(|q| q.name == n).unwrap()
}

fn raw_panels(o: &BoxOptions) -> Vec<Panel> {
    let ty: String = match &o.kind {
        Some(k) if BOX_TYPES.contains(&k.as_str()) => k.clone(),
        _ => if o.lid { "closed".into() } else { "open".into() },
    };
    let with = |k: &str| BoxOptions { kind: Some(k.into()), ..o.clone() };
    if is_flex(&ty) {
        return flex_panels(&with(&ty));
    }
    if ty == "hex" {
        return hex_panels(o);
    }
    if ty == "cabinet" {
        return cabinet_panels(o);
    }
    if ty == "money" {
        return money_panels(o);
    }
    if ty == "slidebook" {
        return book_panels(o);
    }
    if ty == "shelf" {
        let (w, d, h) = outer_size(o);
        let rename = |n: &str| match n {
            "bottom" => "shelfBack",
            "front" | "back" => "shelfEnd",
            "divX" => "shelf",
            x => x,
        }
        .to_string();
        let m = |v: V3| [v[0], -v[2], v[1]];
        let inner = BoxOptions { inner: false, w, d: h, h: d, kind: Some("tray".into()), nx: Some(o.shelves.unwrap_or(2.0)), ny: Some(0.0), ..o.clone() };
        return raw_panels(&inner).into_iter().map(|pn| Panel { name: rename(&pn.name), at: pn.at.map(|a| move_place(&a, &m, [0.0, d, 0.0])), ..pn }).collect();
    }
    let lid = LIDDED.contains(&ty.as_str());
    let t = mx(0.1, o.t);
    let (w, d, h) = outer_size(&with(&ty));
    let f = mx(t, o.finger);
    let pr = |l: f64, corner: bool, odd: bool, fingers: bool| profile(l, t, f, corner, odd, fingers);
    let mut panels: Vec<Panel> = vec![];
    let bt = |name: &str| panel(name, w, d, outline(w, d, t, &pr(w, false, false, true), &pr(d, false, false, true), &pr(w, false, false, true), &pr(d, false, false, true)));
    panels.push(bt("bottom"));
    if lid {
        panels.push(bt("top"));
    }
    let slide_ = ty == "slide";
    let c = 0.3;
    let swing = ty == "hingetop" || ty == "jewel";
    let low_front = slide_ || swing;
    let hf = if slide_ { h - 3.0 * t - c } else if swing { h - 2.0 * t } else { h };
    let fb = |name: &str, hh: f64| {
        let top = if lid { pr(w, true, true, true) } else { vec![sg(0.0, w, true)] };
        panel(name, w, hh, outline(w, hh, t, &pr(w, true, true, true), &pr(hh, true, true, true), &top, &pr(hh, true, true, true)))
    };
    panels.push(fb("front", hf));
    panels.push(fb("back", h));
    let front_edge = if low_front { merge(&[pr(hf, false, false, true), vec![sg(hf, h, true)]].concat()) } else { pr(h, false, false, true) };
    let top_edge = if low_front { merge(&[vec![sg(0.0, t, true)], pr(d, false, true, false)[1..].to_vec()].concat()) } else { pr(d, false, true, lid) };
    let lr = |name: &str| panel(name, d, h, outline(d, h, t, &pr(d, false, true, true), &pr(h, false, false, true), &top_edge, &front_edge));
    panels.push(lr("left"));
    panels.push(lr("right"));
    find(&mut panels, "bottom").at = Some(flat(0.0, 0.0, 0.0));
    if lid {
        find(&mut panels, "top").at = Some(flat(0.0, 0.0, h - t));
    }
    find(&mut panels, "front").at = Some(across(0.0, 0.0, 0.0));
    find(&mut panels, "back").at = Some(across(0.0, d - t, 0.0));
    find(&mut panels, "left").at = Some(along(0.0, 0.0, 0.0));
    find(&mut panels, "right").at = Some(along(w - t, 0.0, 0.0));

    let (wi, di, hi) = (w - 2.0 * t, d - 2.0 * t, h - t);
    if ty == "tray" || ty == "traylid" || ty == "jewel" || ty == "hingeduo" {
        let duo = ty == "hingeduo";
        let nx = if duo { 1.0 } else { mx(0.0, mn(20.0, js_round(o.nx.unwrap_or(1.0)))) };
        let ny = if duo { 0.0 } else { mx(0.0, mn(20.0, js_round(o.ny.unwrap_or(1.0)))) };
        let hd = if ty == "traylid" { hi - t } else if duo { hi - 2.0 * t } else if ty == "jewel" { h - 2.5 * t - hinge_axis(t).1 - 1.0 } else { hi };
        let tab_h = mx(t, hd / 3.0);
        let tb = (hd - tab_h) / 2.0;
        let te = tb + tab_h;
        let xs: Vec<f64> = (0..ny as usize).map(|i| (wi * (i + 1) as f64) / (ny + 1.0)).collect();
        let ys: Vec<f64> = (0..nx as usize).map(|i| (di * (i + 1) as f64) / (nx + 1.0)).collect();
        for n in ["left", "right"] {
            find(&mut panels, n).holes = Some(ys.iter().map(|&y| rect(t + y - t / 2.0, t + tb, t + y + t / 2.0, t + te)).collect());
        }
        for n in ["front", "back"] {
            find(&mut panels, n).holes = Some(xs.iter().map(|&x| rect(t + x - t / 2.0, t + tb, t + x + t / 2.0, t + te)).collect());
        }
        let divider = |l: f64, cuts: &[f64], from_top: bool, name: &str| -> Panel {
            let mut pts = vec![p(t, 0.0)];
            if !from_top {
                for &c in cuts {
                    pts.extend([p(t + c - t / 2.0, 0.0), p(t + c - t / 2.0, hd / 2.0), p(t + c + t / 2.0, hd / 2.0), p(t + c + t / 2.0, 0.0)]);
                }
            }
            pts.extend([p(l + t, 0.0), p(l + t, tb), p(l + 2.0 * t, tb), p(l + 2.0 * t, te), p(l + t, te), p(l + t, hd)]);
            if from_top {
                for &c in cuts.iter().rev() {
                    pts.extend([p(t + c + t / 2.0, hd), p(t + c + t / 2.0, hd / 2.0), p(t + c - t / 2.0, hd / 2.0), p(t + c - t / 2.0, hd)]);
                }
            }
            pts.extend([p(t, hd), p(t, te), p(0.0, te), p(0.0, tb), p(t, tb)]);
            panel(name, l + 2.0 * t, hd, pts)
        };
        for &y in &ys {
            panels.push(Panel { at: Some(across(0.0, t + y - t / 2.0, t)), ..divider(wi, &xs, true, "divX") });
        }
        for &x in &xs {
            panels.push(Panel { at: Some(along(t + x - t / 2.0, 0.0, t)), ..divider(di, &ys, false, "divY") });
        }
    }
    if ty == "handle" {
        let len = mn(d * 0.5, 100.0);
        let hg = mn(30.0, h * 0.25);
        if len > hg * 1.5 && h > hg + 3.0 * t + 10.0 {
            for n in ["left", "right"] {
                find(&mut panels, n).holes = Some(vec![slot(d / 2.0, h - 8.0 - hg / 2.0, len, hg)]);
            }
        }
    }
    if ty == "drawer" {
        let ov = mx(0.0, o.overhang.unwrap_or(5.0));
        let (bw, bh) = (w + 2.0 * ov, h + ov);
        let (hl, hh) = (mn(bw * 0.35, 90.0), mn(25.0, bh * 0.25));
        panels.push(Panel { holes: Some(if hl > hh * 1.5 { vec![slot(bw / 2.0, bh * 0.6, hl, hh)] } else { vec![] }), at: Some(across(-ov, -t, 0.0)), ..panel("blende", bw, bh, rect(0.0, 0.0, bw, bh)) });
    }
    if slide_ {
        let lh = hf - t;
        let bw = wi - 2.0 * t;
        if lh > 0.5 {
            panels.push(Panel { at: Some(along(t, t, t)), ..panel("linerSide", di, lh, rect(0.0, 0.0, di, lh)) });
            panels.push(Panel { at: Some(along(w - 2.0 * t, t, t)), ..panel("linerSide", di, lh, rect(0.0, 0.0, di, lh)) });
            panels.push(Panel { at: Some(across(2.0 * t, d - 2.0 * t, t)), ..panel("linerBack", bw, lh, rect(0.0, 0.0, bw, lh)) });
        }
        panels.push(Panel { at: Some(along(t, t, h - 2.0 * t)), ..panel("railSide", di, 2.0 * t, rect(0.0, 0.0, di, 2.0 * t)) });
        panels.push(Panel { at: Some(along(w - 2.0 * t, t, h - 2.0 * t)), ..panel("railSide", di, 2.0 * t, rect(0.0, 0.0, di, 2.0 * t)) });
        panels.push(Panel { at: Some(across(2.0 * t, d - 2.0 * t, h - 2.0 * t)), ..panel("railBack", bw, 2.0 * t, rect(0.0, 0.0, bw, 2.0 * t)) });
        let (lw, ld) = (wi - 2.0 * c, d - t - c);
        let (gl, gh) = (mn(lw * 0.4, 50.0), mn(10.0, ld * 0.15));
        panels.push(Panel { holes: Some(if gl > gh * 1.5 { vec![slot(lw / 2.0, 6.0 + gh / 2.0, gl, gh)] } else { vec![] }), at: Some(flat(t + c, 0.0, hf)), ..panel("slideLid", lw, ld, rect(0.0, 0.0, lw, ld)) });
    }
    if ty == "lantern" {
        let m = mx(8.0, 3.0 * t + 4.0);
        for n in ["front", "back", "left", "right"] {
            let pn = find(&mut panels, n);
            let (ww, wh) = (pn.w - 2.0 * m, pn.h - 2.0 * m);
            if ww > 8.0 && wh > 8.0 {
                pn.holes = Some(vec![arch_window(m, m, ww, wh)]);
            }
        }
        let top = find(&mut panels, "top");
        let vr = mn(top.w, top.h) * 0.15;
        if vr > 4.0 {
            top.holes = Some(vec![circle(top.w / 2.0, top.h / 2.0, vr, 64)]);
        }
    }
    if ty == "coin" {
        let top = find(&mut panels, "top");
        let sl = mn(32.0, top.w - 4.0 * t);
        let sh = 4.0;
        if sl > 2.0 * sh {
            top.holes = Some(vec![slot(top.w / 2.0, top.h / 2.0, sl, sh)]);
        }
        let bot = find(&mut panels, "bottom");
        let hr = mn(25.0, (mn(bot.w, bot.h) - 4.0 * t) / 2.0 - 2.0);
        if hr > 6.0 {
            bot.holes = Some(vec![circle(bot.w / 2.0, bot.h / 2.0, hr, 64)]);
            panels.push(Panel { at: Some(flat(w / 2.0 - hr - 5.0, d / 2.0 - hr - 5.0, -t)), ..panel("plugOuter", 2.0 * hr + 10.0, 2.0 * hr + 10.0, circle(hr + 5.0, hr + 5.0, hr + 5.0, 64)) });
            panels.push(Panel { at: Some(flat(w / 2.0 - hr, d / 2.0 - hr, 0.0)), ..panel("plugInner", 2.0 * hr, 2.0 * hr, circle(hr, hr, hr - 0.2, 64)) });
        }
    }
    if ty == "tissue" {
        let top = find(&mut panels, "top");
        let (sl, sh) = (mn(140.0, top.w * 0.6), mn(30.0, top.h * 0.3));
        if sl > sh * 1.5 && sh > 5.0 {
            top.holes = Some(vec![slot(top.w / 2.0, top.h / 2.0, sl, sh)]);
        }
    }
    if ty == "bird" {
        let fr = find(&mut panels, "front");
        let r = mn(mn(16.0, (fr.w - 6.0 * t) / 2.0 - 2.0), (fr.h - 6.0 * t) / 4.0);
        if r > 5.0 {
            fr.holes = Some(vec![circle(fr.w / 2.0, mn(fr.h * 0.65, fr.h - 3.0 * t - r - 4.0), r, 64)]);
        }
        for n in ["left", "right"] {
            let pn = find(&mut panels, n);
            if pn.h > 8.0 * t + 20.0 {
                pn.holes = Some(vec![circle(pn.w / 2.0, pn.h - 3.0 * t - 6.0, 3.0, 24)]);
            }
        }
        let bot = find(&mut panels, "bottom");
        let m = 3.0 * t + 6.0;
        if bot.w > 2.0 * m + 10.0 && bot.h > 2.0 * m + 10.0 {
            let (bw, bh) = (bot.w, bot.h);
            bot.holes = Some([[m, m], [bw - m, m], [bw - m, bh - m], [m, bh - m]].iter().map(|&[x, y]| circle(x, y, 2.5, 24)).collect());
        }
    }
    if ty == "planter" {
        let bot = find(&mut panels, "bottom");
        let m = 3.0 * t + 6.0;
        let (aw, ah) = (bot.w - 2.0 * m, bot.h - 2.0 * m);
        if aw > 0.0 && ah > 0.0 {
            let nxh = mx(1.0, js_round(aw / 30.0) + 1.0);
            let nyh = mx(1.0, js_round(ah / 30.0) + 1.0);
            let mut holes = vec![];
            let (bw, bh) = (bot.w, bot.h);
            let mut i = 0.0;
            while i < nxh {
                let mut j = 0.0;
                while j < nyh {
                    holes.push(circle(if nxh > 1.0 { m + (aw * i) / (nxh - 1.0) } else { bw / 2.0 }, if nyh > 1.0 { m + (ah * j) / (nyh - 1.0) } else { bh / 2.0 }, 3.0, 24));
                    j += 1.0;
                }
                i += 1.0;
            }
            bot.holes = Some(holes);
        }
    }
    if ty == "scoop" {
        front_notch(find(&mut panels, "front"), t, 25.0);
    }
    if ty == "pulltop" || swing {
        front_notch(find(&mut panels, "front"), t, 14.0);
    }
    if swing {
        let (a, _, gap, _) = hinge_axis(t);
        let len = d - t - gap;
        let ye = len - a;
        if ye > 2.0 * t {
            panels.push(Panel { at: Some(flat(0.0, 0.0, h - 2.0 * t)), ..hinge_lid_panel(w, len, ye, t, gap, false) });
            ear_holes(&mut panels, &[ye], h, t, o.kerf);
        }
    }
    if ty == "hingeduo" {
        let (a, _, gap, _) = hinge_axis(t);
        let mid = 0.25;
        let len = d / 2.0 - mid - t - gap;
        let ye = len - a;
        if ye > 2.0 * t {
            panels.push(Panel { at: Some(Place { o: [0.0, d / 2.0 - mid, h - 2.0 * t], u: EX, v: [0.0, -1.0, 0.0], n: EZ }), ..hinge_lid_panel(w, len, ye, t, gap, true) });
            panels.push(Panel { at: Some(flat(0.0, d / 2.0 + mid, h - 2.0 * t)), ..hinge_lid_panel(w, len, ye, t, gap, true) });
            ear_holes(&mut panels, &[d / 2.0 - mid - ye, d / 2.0 + mid + ye], h, t, o.kerf);
        }
    }
    if ty == "dice" {
        let ramps = dice_ramps(&mut panels, t, f);
        panels.extend(ramps);
    }
    if ty == "lidbox" || ty == "traylid" || ty == "pulltop" {
        let c = 0.2;
        panels.push(Panel { at: Some(flat(0.0, 0.0, h)), ..panel("lidOuter", w, d, rect(0.0, 0.0, w, d)) });
        panels.push(Panel { at: Some(flat(t + c, t + c, h - t)), ..panel("lidInner", wi - 2.0 * c, di - 2.0 * c, rect(0.0, 0.0, wi - 2.0 * c, di - 2.0 * c)) });
    }
    panels
}

/// Halbrunde Griffmulde oben in der Mitte einer Platte mit glatter Oberkante
fn front_notch(fr: &mut Panel, t: f64, max_r: f64) {
    let r = mn(mn(max_r, fr.w * 0.2), (fr.h - 2.0 * t) * 0.5);
    let n = fr.pts.len();
    let i = (0..n).position(|k| (fr.pts[k].y - fr.h).abs() < 1e-9 && (fr.pts[(k + 1) % n].y - fr.h).abs() < 1e-9);
    if let (true, Some(i)) = (r > 4.0, i) {
        let notch: Vec<Pt2> = (0..=24).map(|k| {
            let a = (PI * k as f64) / 24.0;
            p(fr.w / 2.0 + r * cos(a), fr.h - r * sin(a))
        }).collect();
        fr.pts.splice(i + 1..i + 1, notch);
    }
}

/// Klappdeckel-Achse: (a, reach, gap, earW)
pub fn hinge_axis(t: f64) -> (f64, f64, f64, f64) {
    let a = 2.5 * t;
    let reach = hypot2(a, t / 2.0);
    (a, reach, mx(0.3, reach - a + 0.15), 0.8 * t)
}
/// Bohrung für den Deckel-Zapfen
pub fn hinge_hole_d(t: f64, kerf: f64) -> f64 {
    hypot2(t, hinge_axis(t).3 + kerf) + 0.3 + kerf
}
fn hinge_lid_panel(w: f64, len: f64, ye: f64, t: f64, gap: f64, notch: bool) -> Panel {
    let e = t + gap;
    let wd = hinge_axis(t).3;
    let r = mn(mn(12.0, (w - 2.0 * e) * 0.15), len * 0.3);
    let mut pts = vec![p(e, 0.0)];
    if notch && r > 4.0 {
        for k in 0..=24 {
            let a = PI - (PI * k as f64) / 24.0;
            pts.push(p(w / 2.0 + r * cos(a), r * sin(a)));
        }
    }
    pts.extend([p(w - e, 0.0), p(w - e, ye - wd / 2.0), p(w, ye - wd / 2.0), p(w, ye + wd / 2.0), p(w - e, ye + wd / 2.0), p(w - e, len)]);
    pts.extend([p(e, len), p(e, ye + wd / 2.0), p(0.0, ye + wd / 2.0), p(0.0, ye - wd / 2.0), p(e, ye - wd / 2.0)]);
    panel("hingeLid", w, len, pts)
}
fn ear_holes(panels: &mut [Panel], ys: &[f64], h: f64, t: f64, kerf: f64) {
    let r = hinge_hole_d(t, kerf) / 2.0;
    for n in ["left", "right"] {
        let pn = find(panels, n);
        let mut holes = pn.holes.clone().unwrap_or_default();
        holes.extend(ys.iter().map(|&y| circle(y, h - 1.5 * t, r, 32)));
        pn.holes = Some(holes);
    }
}

fn money_panels(o: &BoxOptions) -> Vec<Panel> {
    let t = mx(0.1, o.t);
    let m = money_rim(t);
    let (w, _, h) = outer_size(&BoxOptions { kind: Some("money".into()), ..o.clone() });
    let frame = vec![p(0.0, 0.0), p(w, 0.0), p(w, h), p(w - m, h), p(w - m, m), p(m, m), p(m, h), p(0.0, h)];
    let (rx, ry) = ((w - 2.0 * m) * 0.36, (h - 2.0 * m) * 0.3);
    let n = 64;
    let win: Vec<Pt2> = (0..n).map(|i| p(w / 2.0 + rx * cos((2.0 * PI * i as f64) / n as f64), h * 0.46 + ry * sin((2.0 * PI * i as f64) / n as f64))).collect();
    let mut front = Panel { holes: Some(if rx > 4.0 && ry > 4.0 { vec![win] } else { vec![] }), at: Some(flat(0.0, 0.0, 2.0 * t)), ..panel("moneyFront", w, h, rect(0.0, 0.0, w, h)) };
    front_notch(&mut front, 0.0, mn(14.0, h * 0.12));
    vec![
        Panel { at: Some(flat(0.0, 0.0, 0.0)), ..panel("moneyBack", w, h, rect(0.0, 0.0, w, h)) },
        Panel { at: Some(flat(0.0, 0.0, t)), ..panel("moneyFrame", w, h, frame) },
        front,
    ]
}

fn book_panels(o: &BoxOptions) -> Vec<Panel> {
    let t = mx(0.1, o.t);
    let ov = mx(1.0, o.overhang.unwrap_or(3.0));
    let (w, d, h) = outer_size(&BoxOptions { kind: Some("cabinet".into()), ..o.clone() });
    let (cw, cd) = (w + 2.0 * ov, d + ov);
    let mut out = cabinet_panels(&BoxOptions { shelves: Some(0.0), kind: Some("cabinet".into()), ..o.clone() });
    out.push(Panel { at: Some(flat(-ov, -ov, -t)), ..panel("bookCover", cw, cd, rect(0.0, 0.0, cw, cd)) });
    out.push(Panel { at: Some(flat(-ov, -ov, h)), ..panel("bookCover", cw, cd, rect(0.0, 0.0, cw, cd)) });
    out
}

/// Zapfen auf einer geraden Strecke der Länge L
pub fn tabs_on(l: f64, t: f64, finger: f64) -> Vec<[f64; 2]> {
    if l < 3.0 * t {
        return vec![];
    }
    let mut k = mx(1.0, 2.0 * (l / mx(0.5, finger) / 2.0).floor() + 1.0);
    if k < 3.0 {
        k = 3.0;
    }
    let s = l / k;
    let mut out = vec![];
    let mut i = 1.0;
    while i < k {
        out.push([i * s, (i + 1.0) * s]);
        i += 2.0;
    }
    out
}

struct Bump {
    t: f64,
    finger: f64,
    d: f64,
}
fn round_rect(x0: f64, y0: f64, x1: f64, y1: f64, rad: f64, bump: Option<Bump>) -> Vec<Pt2> {
    let rad = mx(0.0, mn(mn(rad, (x1 - x0) / 2.0), (y1 - y0) / 2.0));
    let (lw, ld) = (x1 - x0 - 2.0 * rad, y1 - y0 - 2.0 * rad);
    struct Side {
        p: Pt2,
        u: Pt2,
        n: Pt2,
        l: f64,
        c: Pt2,
        a0: f64,
    }
    let sides = [
        Side { p: p(x0 + rad, y0), u: p(1.0, 0.0), n: p(0.0, -1.0), l: lw, c: p(x1 - rad, y0 + rad), a0: -90.0 },
        Side { p: p(x1, y0 + rad), u: p(0.0, 1.0), n: p(1.0, 0.0), l: ld, c: p(x1 - rad, y1 - rad), a0: 0.0 },
        Side { p: p(x1 - rad, y1), u: p(-1.0, 0.0), n: p(0.0, 1.0), l: lw, c: p(x0 + rad, y1 - rad), a0: 90.0 },
        Side { p: p(x0, y1 - rad), u: p(0.0, -1.0), n: p(-1.0, 0.0), l: ld, c: p(x0 + rad, y0 + rad), a0: 180.0 },
    ];
    let mut pts = vec![];
    let at = |sd: &Side, s: f64, out: f64| p(sd.p.x + sd.u.x * s + sd.n.x * out, sd.p.y + sd.u.y * s + sd.n.y * out);
    for sd in &sides {
        pts.push(at(sd, 0.0, 0.0));
        if let Some(b) = &bump {
            for [a, bb] in tabs_on(sd.l, b.t, b.finger) {
                pts.extend([at(sd, a, 0.0), at(sd, a, b.d), at(sd, bb, b.d), at(sd, bb, 0.0)]);
            }
        }
        if rad > 0.01 {
            for i in 0..12 {
                let a = ((sd.a0 + (90.0 * i as f64) / 12.0) * PI) / 180.0;
                pts.push(p(sd.c.x + rad * cos(a), sd.c.y + rad * sin(a)));
            }
        }
    }
    let n = pts.len();
    (0..n).filter(|&i| {
        let (q, nq) = (pts[i], pts[(i + 1) % n]);
        hypot2(q.x - nq.x, q.y - nq.y) > 1e-6
    }).map(|i| pts[i]).collect()
}

/// Biegescharnier auf der Strecke x = from … from + span, Wandstreifen y0 … y0 + H
pub fn flex_cuts(from: f64, span: f64, y0: f64, h: f64, t: f64) -> Vec<Vec<Pt2>> {
    let mut lines = vec![];
    let g = mx(2.0, t);
    let step = mn(2.5, mx(1.0, t * 0.5));
    let cut = |x: f64, a: f64, b: f64, lines: &mut Vec<Vec<Pt2>>| {
        if b - a > 1.0 {
            lines.push(vec![p(x, y0 + a), p(x, y0 + b)]);
        }
    };
    let n = mx(2.0, js_round(span / step));
    let mut j = 0.0;
    while j < n {
        let x = from + ((j + 0.5) * span) / n;
        if j % 2.0 == 0.0 {
            cut(x, g, h / 2.0 - g / 2.0, &mut lines);
            cut(x, h / 2.0 + g / 2.0, h - g, &mut lines);
        } else {
            cut(x, 0.0, h / 4.0 - g / 2.0, &mut lines);
            cut(x, h / 4.0 + g / 2.0, (3.0 * h) / 4.0 - g / 2.0, &mut lines);
            cut(x, (3.0 * h) / 4.0 + g / 2.0, h, &mut lines);
        }
        j += 1.0;
    }
    lines
}

fn flex_panels(o: &BoxOptions) -> Vec<Panel> {
    let t = mx(0.1, o.t);
    let f = mx(t, o.finger);
    let c = 0.2;
    let (w, d, h) = outer_size(&BoxOptions { kind: Some("flex".into()), ..o.clone() });
    let r = mx(t + 1.0, mn(mn(o.radius.unwrap_or(15.0), w / 2.0), d / 2.0));
    let (lw, ld) = (w - 2.0 * r, d - 2.0 * r);
    let arc = (PI / 2.0) * (r - t / 2.0);
    let rw = mx(6.0, 2.0 * t + 2.0);
    let mut panels = vec![];
    let plate = || round_rect(t, t, w - t, d - t, r - t, Some(Bump { t, finger: f, d: t }));
    panels.push(Panel { at: Some(flat(0.0, 0.0, 0.0)), ..panel("bottom", w, d, plate()) });
    let hole = round_rect(t + rw, t + rw, w - t - rw, d - t - rw, mx(0.5, r - t - rw), None);
    panels.push(Panel { holes: Some(vec![hole]), at: Some(flat(0.0, 0.0, h - t)), ..panel("flexRing", w, d, plate()) });
    let straight = [lw, ld, lw, ld];
    let seam_side = if lw >= ld { 2 } else { 3 };
    let order = [seam_side, (seam_side + 1) % 4, (seam_side + 2) % 4, (seam_side + 3) % 4, seam_side];
    struct Sec {
        l: f64,
        bend: bool,
        tabs: Vec<[f64; 2]>,
    }
    let mut secs: Vec<Sec> = vec![];
    let ls = straight[seam_side];
    let tabs_s = tabs_on(ls, t, f);
    let mut sp = ls / 2.0;
    if !tabs_s.is_empty() {
        let mut gaps = vec![tabs_s[0][0] / 2.0];
        for i in 0..tabs_s.len() {
            gaps.push((tabs_s[i][1] + if i + 1 < tabs_s.len() { tabs_s[i + 1][0] } else { ls }) / 2.0);
        }
        sp = gaps[1..].iter().fold(gaps[0], |best, &x| if (x - ls / 2.0).abs() < (best - ls / 2.0).abs() { x } else { best });
    }
    for (i, &side) in order.iter().enumerate() {
        let l = straight[side];
        let all = tabs_on(l, t, f);
        if i == 0 {
            secs.push(Sec { l: l - sp, bend: false, tabs: all.iter().filter(|[a2, _]| *a2 > sp).map(|[a2, b2]| [a2 - sp, b2 - sp]).collect() });
        } else if i == 4 {
            secs.push(Sec { l: sp, bend: false, tabs: all.iter().filter(|[_, b2]| *b2 < sp).copied().collect() });
        } else {
            secs.push(Sec { l, bend: false, tabs: all });
        }
        if i < 4 {
            secs.push(Sec { l: arc, bend: true, tabs: vec![] });
        }
    }
    let len = secs.iter().fold(0.0, |n, q| n + q.l);
    let mut lines: Vec<Vec<Pt2>> = vec![];
    let mut notches: Vec<[f64; 2]> = vec![];
    let mut s0 = 0.0;
    for sec in &secs {
        if !sec.bend {
            for [a2, b2] in &sec.tabs {
                notches.push([s0 + a2, s0 + b2]);
            }
        } else {
            let m = mn(mn(t, s0), len - s0 - sec.l);
            lines.extend(flex_cuts(s0 - m, sec.l + 2.0 * m, 0.0, h, t));
        }
        s0 += sec.l;
    }
    let kd = mx(4.0, 2.0 * t);
    let (hw, nw) = (kd * 1.3, kd * 0.75);
    let free = h - 2.0 * t - 4.0;
    let n_k = mx(1.0, mn(4.0, (free / (2.6 * hw)).floor())) as usize;
    let knobs: Vec<f64> = (0..n_k).map(|i| t + 2.0 + (free * (i as f64 + 0.5)) / n_k as f64).collect();
    let mut pts = vec![p(0.0, 0.0)];
    for [a2, b2] in &notches {
        pts.extend([p(*a2, 0.0), p(*a2, t), p(*b2, t), p(*b2, 0.0)]);
    }
    pts.push(p(len, 0.0));
    for &yc in &knobs {
        pts.extend([p(len, yc - nw / 2.0), p(len + kd, yc - hw / 2.0), p(len + kd, yc + hw / 2.0), p(len, yc + nw / 2.0)]);
    }
    pts.push(p(len, h));
    for [a2, b2] in notches.iter().rev() {
        pts.extend([p(*b2, h), p(*b2, h - t), p(*a2, h - t), p(*a2, h)]);
    }
    pts.push(p(0.0, h));
    for &yc in knobs.iter().rev() {
        pts.extend([p(0.0, yc + nw / 2.0), p(kd, yc + hw / 2.0), p(kd, yc - hw / 2.0), p(0.0, yc - nw / 2.0)]);
    }
    let n = pts.len();
    let clean: Vec<Pt2> = (0..n).filter(|&i| {
        let (q, nq) = (pts[i], pts[(i + 1) % n]);
        hypot2(q.x - nq.x, q.y - nq.y) > 1e-6
    }).map(|i| pts[i]).collect();
    panels.push(Panel { lines: Some(lines), wrap: Some(Wrap { lp: round_rect(t / 2.0, t / 2.0, w - t / 2.0, d - t / 2.0, r - t / 2.0, None), z0: 0.0, z1: h }), ..panel("flexWall", len + kd, h, clean) });
    if o.kind.as_deref() != Some("flexcup") {
        panels.push(Panel { at: Some(flat(0.0, 0.0, h)), ..panel("lidOuter", w, d, round_rect(0.0, 0.0, w, d, r, None)) });
        let iw = w - 2.0 * (t + rw) - 2.0 * c;
        let id = d - 2.0 * (t + rw) - 2.0 * c;
        panels.push(Panel { at: Some(flat(t + rw + c, t + rw + c, h - t)), ..panel("lidInner", iw, id, round_rect(0.0, 0.0, iw, id, mx(0.5, r - t - rw - c), None)) });
    }
    panels
}

struct Dice {
    k: f64,
    ze: f64,
    z3lo: f64,
    z3hi: f64,
    z2lo: f64,
    z2hi: f64,
    z1lo: f64,
    z1hi: f64,
    deg: f64,
}
fn dice_tan_max() -> f64 {
    jsmath::tan((35.0 * PI) / 180.0)
}
fn dice_tan_min() -> f64 {
    jsmath::tan((20.0 * PI) / 180.0)
}
fn dice_levels(t: f64, di: f64, h: f64) -> Dice {
    let (k, g) = (0.6, 26.0 + t);
    let ze = 2.0 * t + 1.0;
    let z3lo = ze - t / 2.0;
    let tan3 = (h - t - 15.0 - z3lo - 2.0 * g) / ((4.0 * k - 1.0) * di);
    let tan2 = (h - t / 2.0 - 2.0 - z3lo - g) / (2.0 * k * di);
    let tan = if tan3 >= dice_tan_min() { mn(tan3, dice_tan_max()) } else { mx(dice_tan_min(), mn(tan2, dice_tan_max())) };
    let z3hi = z3lo + di * tan;
    let z2lo = z3lo + k * di * tan + g;
    let z2hi = z2lo + k * di * tan;
    let z1lo = z2hi - (1.0 - k) * di * tan + g;
    let z1hi = z1lo + k * di * tan;
    Dice { k, ze, z3lo, z3hi, z2lo, z2hi, z1lo, z1hi, deg: (jsmath::atan(tan) * 180.0) / PI }
}
/// Würfelturm: Mindesthöhe außen (mm, aufgerundet)
pub fn dice_min_height(o: &BoxOptions) -> f64 {
    let t = mx(0.1, o.t);
    let di = outer_size(&BoxOptions { kind: Some("dice".into()), ..o.clone() }).1 - 2.0 * t;
    (t / 2.0 + 2.0 + (2.0 * t + 1.0 - t / 2.0) + 2.0 * 0.6 * di * dice_tan_min() + 26.0 + t).ceil()
}
/// Würfelturm: Neigung der Rampen in Grad
pub fn dice_angle(o: &BoxOptions) -> f64 {
    let t = mx(0.1, o.t);
    let (_, d, h) = outer_size(&BoxOptions { kind: Some("dice".into()), ..o.clone() });
    dice_levels(t, d - 2.0 * t, h).deg
}

fn dice_ramps(panels: &mut [Panel], t: f64, f: f64) -> Vec<Panel> {
    let w = find(panels, "front").w;
    let (d, h) = {
        let l = find(panels, "left");
        (l.w, l.h)
    };
    let (wi, di) = (w - 2.0 * t, d - 2.0 * t);
    let dl = dice_levels(t, di, h);
    let eh = mn(mx(24.0, h * 0.2), h - dl.ze - 2.0 * t);
    if wi > 8.0 && eh > 8.0 {
        find(panels, "front").holes = Some(vec![rect(t + 2.0, dl.ze, w - t - 2.0, dl.ze + eh)]);
    }
    let mut lines: Vec<(Pt2, Pt2)> = vec![(p(d - t, dl.z3hi), p(t, dl.z3lo)), (p(t, dl.z2hi), p(t + dl.k * di, dl.z2lo))];
    if dl.z1hi + t + 15.0 <= h {
        lines.push((p(d - t, dl.z1hi), p(d - t - dl.k * di, dl.z1lo)));
    }
    let (mut ramps, mut slots): (Vec<Panel>, Vec<Vec<Pt2>>) = (vec![], vec![]);
    for (pp, q) in lines {
        if mx(pp.y, q.y) + t / 2.0 > h - 2.0 {
            continue;
        }
        let l = hypot2(q.x - pp.x, q.y - pp.y);
        let (ux, uy) = ((q.x - pp.x) / l, (q.y - pp.y) / l);
        let d0 = (t / 2.0) * (uy / ux).abs() + 0.25;
        let lr = l - 2.0 * d0;
        let tabs = tabs_on(lr, t, f);
        for [a, b] in &tabs {
            slots.push([[*a, -1.0], [*b, -1.0], [*b, 1.0], [*a, 1.0]].iter().map(|&[s, n]| p(pp.x + ux * (d0 + s) - uy * n * t / 2.0, pp.y + uy * (d0 + s) + ux * n * t / 2.0)).collect());
        }
        let mut pts = vec![p(0.0, t)];
        for [a, b] in &tabs {
            pts.extend([p(*a, t), p(*a, 0.0), p(*b, 0.0), p(*b, t)]);
        }
        pts.extend([p(lr, t), p(lr, t + wi)]);
        for [a, b] in tabs.iter().rev() {
            pts.extend([p(*b, t + wi), p(*b, wi + 2.0 * t), p(*a, wi + 2.0 * t), p(*a, t + wi)]);
        }
        pts.push(p(0.0, t + wi));
        let sx = pp.x + ux * d0 + uy * t / 2.0;
        let sz = pp.y + uy * d0 - ux * t / 2.0;
        ramps.push(Panel { at: Some(Place { o: [0.0, sx, sz], u: [0.0, ux, uy], v: EX, n: [0.0, -uy, ux] }), ..panel("ramp", lr, wi + 2.0 * t, pts) });
    }
    find(panels, "left").holes = Some(slots.clone());
    find(panels, "right").holes = Some(slots);
    ramps
}

fn poly_verts(cx: f64, cy: f64, ap: f64, n: f64) -> Vec<Pt2> {
    let r = ap / cos(PI / n);
    (0..n as usize).map(|i| {
        let a = ((2.0 * i as f64 - 1.0) * PI) / n;
        p(cx + r * cos(a), cy + r * sin(a))
    }).collect()
}
fn hex_dims(o: &BoxOptions) -> (f64, f64, f64, f64, f64, f64) {
    let t = mx(0.1, o.t);
    let n = mx(3.0, mn(12.0, js_round(o.sides.unwrap_or(6.0))));
    let a_big = if o.inner { o.w / 2.0 + 2.0 * t } else { o.w / 2.0 };
    let a = a_big - t;
    let ai = a - t;
    let hw = if o.inner { o.h } else { o.h - 2.0 * t };
    (t, n, a_big, a, ai, hw)
}
fn hex_size(o: &BoxOptions) -> (f64, f64, f64) {
    let (t, n, a_big, _, _, hw) = hex_dims(o);
    let v = poly_verts(0.0, 0.0, a_big, n);
    let ext = |f: &dyn Fn(&Pt2) -> f64| v.iter().map(f).fold(f64::NEG_INFINITY, mx) - v.iter().map(f).fold(f64::INFINITY, mn);
    (ext(&|q| q.x), ext(&|q| q.y), hw + 2.0 * t)
}
fn hex_panels(o: &BoxOptions) -> Vec<Panel> {
    let (t, n, a_big, a, ai, hw) = hex_dims(o);
    let f = mx(t, o.finger);
    let c = 0.2;
    let (w, d, _) = hex_size(o);
    let cx = w - poly_verts(0.0, 0.0, a_big, n).iter().map(|q| q.x).fold(f64::NEG_INFINITY, mx);
    let cy = d / 2.0;
    let side = 2.0 * ai * jsmath::tan(PI / n);
    let tabs = tabs_on(side, t, f);
    let mut slots = vec![];
    for i in 0..n as usize {
        let th = (2.0 * PI * i as f64) / n;
        let (nx, ny) = (cos(th), sin(th));
        for [s0, s1] in &tabs {
            slots.push([[ai, *s0], [a, *s0], [a, *s1], [ai, *s1]].iter().map(|&[r, s]| {
                let u = s - side / 2.0;
                p(cx + nx * r - ny * u, cy + ny * r + nx * u)
            }).collect::<Vec<_>>());
        }
    }
    let mut panels = vec![Panel { holes: Some(slots), ..panel("bottom", w, d, poly_verts(cx, cy, a_big, n)) }];
    let mut wall = vec![p(0.0, t)];
    for [s0, s1] in &tabs {
        wall.extend([p(*s0, t), p(*s0, 0.0), p(*s1, 0.0), p(*s1, t)]);
    }
    wall.extend([p(side, t), p(side, t + hw), p(0.0, t + hw)]);
    for i in 0..n as usize {
        let th = (2.0 * PI * i as f64) / n;
        let (nx, ny) = (cos(th), sin(th));
        panels.push(Panel { at: Some(Place { o: [cx + nx * ai + ny * side / 2.0, cy + ny * ai - nx * side / 2.0, 0.0], u: [-ny, nx, 0.0], v: EZ, n: [nx, ny, 0.0] }), ..panel("hexWall", side, hw + t, wall.clone()) });
    }
    panels[0].at = Some(flat(0.0, 0.0, 0.0));
    panels.push(Panel { at: Some(flat(0.0, 0.0, hw + t)), ..panel("lidOuter", w, d, poly_verts(cx, cy, a_big, n)) });
    let li = poly_verts(0.0, 0.0, ai - c, n);
    let lx = li.iter().map(|q| q.x).fold(f64::INFINITY, mn);
    let ly = li.iter().map(|q| q.y).fold(f64::INFINITY, mn);
    let lw = li.iter().map(|q| q.x).fold(f64::NEG_INFINITY, mx) - lx;
    let lh = li.iter().map(|q| q.y).fold(f64::NEG_INFINITY, mx) - ly;
    panels.push(Panel { at: Some(flat(cx + lx, cy + ly, hw)), ..panel("lidInner", lw, lh, li.iter().map(|q| p(q.x - lx, q.y - ly)).collect()) });
    panels
}

/// Schubladenschrank: Fächer und Schubladen (n, w, d, h)
pub fn cabinet_drawer(o: &BoxOptions) -> (f64, f64, f64, f64) {
    let t = mx(0.1, o.t);
    let c = 1.0;
    let n = mx(0.0, mn(20.0, js_round(o.shelves.unwrap_or(2.0))));
    let (w, d, h) = outer_size(&BoxOptions { kind: Some("cabinet".into()), ..o.clone() });
    let ch = (h - 2.0 * t) / (n + 1.0) - t;
    (n + 1.0, w - 2.0 * t - 2.0 * c, d - t - t - c, ch - c)
}
fn cabinet_panels(o: &BoxOptions) -> Vec<Panel> {
    let mut panels = raw_panels(&BoxOptions { kind: Some("shelf".into()), ..o.clone() });
    let (dn, dw, dd, dh) = cabinet_drawer(o);
    let rename = |n: &str| match n {
        "bottom" => "drBottom",
        "front" | "back" => "drEnd",
        "left" | "right" => "drSide",
        "blende" => "drPlate",
        x => x,
    }
    .to_string();
    let t = mx(0.1, o.t);
    let (_, _, h) = outer_size(&BoxOptions { kind: Some("cabinet".into()), ..o.clone() });
    let ident = |v: V3| v;
    let floor = |k: f64| if k == 0.0 { t } else { t + ((h - 2.0 * t) * k) / dn + t / 2.0 };
    if mn(mn(dw, dd), dh) > 3.0 * t {
        let mut i = 0.0;
        while i < dn {
            let drawer = raw_panels(&BoxOptions { inner: false, kind: Some("drawer".into()), w: dw, d: dd, h: dh, overhang: Some(0.0), ..o.clone() });
            let fl = floor(i);
            panels.extend(drawer.into_iter().map(|pn| Panel { name: rename(&pn.name), at: pn.at.map(|a| move_place(&a, &ident, [t + 1.0, t, fl])), ..pn }));
            i += 1.0;
        }
    }
    panels
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsmath::to_fixed;
    use serde_json::Value;
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
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("boxgen-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        let cases = all["cases"].as_array().unwrap();
        assert!(cases.len() >= 100, "only {} boxes", cases.len());
        for (i, c) in cases.iter().enumerate() {
            let o: BoxOptions = serde_json::from_value(c["o"].clone()).unwrap();
            let at = format!("box {i} ({:?})", o.kind);
            same(&digest(&serde_json::to_value(box_panels(&o)).unwrap()), &c["want"], &at);
        }
        for (i, hl) in all["helpers"].as_array().unwrap().iter().enumerate() {
            let o: BoxOptions = serde_json::from_value(hl["o"].clone()).unwrap();
            let (w, d, h) = outer_size(&o);
            let (n, dw, dd, dh) = cabinet_drawer(&o);
            let got = serde_json::json!({ "o": hl["o"], "size": { "W": w, "D": d, "H": h }, "diceMin": dice_min_height(&o), "diceDeg": dice_angle(&o),
                "drawer": { "n": n, "w": dw, "d": dd, "h": dh }, "hole": hinge_hole_d(o.t, o.kerf) });
            same(&got, hl, &format!("helpers {i}"));
        }
        println!("{} boxes made the same as box.ts", cases.len());
    }
}
