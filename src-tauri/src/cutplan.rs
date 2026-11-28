//! PLANUNG JE FORM FÜR LASER UND PLASMA – Zwilling von computePlan (plasmaCam.ts), withLeadIn (laserCam.ts),
//! tabRuns (tabs.ts) und applyCut (cutSetting.ts).
//!
//! Plasma: aus den versetzten Konturen (Schnittspalt; das Versetzen selbst hat seinen Zwilling in polyoffset.rs)
//! aufräumen, Richtung (außen im Uhrzeigersinn, Löcher gegen, von Hand gesetzt gewinnt), Startpunkt (von Hand oder
//! schärfste Ecke – von gleich scharfen die erste), Anfahrbahn, Haltestege, Überlauf, Ausfahrbahn.
//! Laser: gesetzte Richtung und gesetzten Start anwenden, Freischnitt an der schärfsten Ecke, Haltestege.
//! Das Fenster schickt beim Erzeugen des G-Codes, was es geplant hat, und vergleicht (planRust.ts).
//! Gemeinsame Fälle: `tests/fixtures/cutplan-cases.json.gz` (festgehalten von `tests/cutPlanRust.test.ts`).

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

/// Was an der Form von Hand gesetzt ist (planRust.ts shapeCutData)
#[derive(Deserialize, Clone, Debug)]
pub struct ShapeCut {
    pub dir: Option<String>,
    pub start: Option<f64>,
    /// erster Pfad der Form in Welt-Pixeln (für den gesetzten Startpunkt)
    pub path: Option<RawPath>,
    pub px: f64,
    pub tab: Tab,
}
#[derive(Deserialize, Clone, Debug)]
pub struct RawPath {
    pub pts: Vec<Pt>,
    pub closed: bool,
}
#[derive(Deserialize, Clone, Debug)]
pub struct Tab {
    pub len: f64,
    pub mode: String,
    pub n: f64,
    /// tabPts ist eine Liste (Array.isArray)
    pub list: bool,
    pub pts: Vec<Option<f64>>,
    /// Kontur der Form in Welt-Pixeln (nur Kreise und geschlossene Linienzüge)
    pub outline: Option<Vec<Pt>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlasmaPath {
    pub closed: bool,
    pub pts: Vec<Pt>,
    /// versetzte Konturen (null bei offenen Pfaden und „auf der Linie“)
    pub loops: Option<Vec<Vec<Pt>>>,
}
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlasmaIn {
    pub cut: ShapeCut,
    pub mode: String,
    pub kerf: f64,
    pub lead_in: f64,
    pub lead_out: f64,
    pub overcut: f64,
    pub small_hole: f64,
    pub paths: Vec<PlasmaPath>,
}
#[derive(Serialize, Clone, Debug)]
pub struct PlasmaPlan {
    pub pts: Vec<Pt>,
    pub closed: bool,
    pub lead: Option<Pt>,
    pub over: Vec<Pt>,
    pub out: Option<Pt>,
    pub area: f64,
    pub hole: bool,
    pub size: f64,
    pub runs: Option<Vec<Vec<Pt>>>,
}
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShapePlan {
    pub plans: Vec<PlasmaPlan>,
    pub too_small: bool,
    pub lead_short: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub dir_by_hand: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub start_in_tab: bool,
}

#[derive(Deserialize, Clone, Debug)]
pub struct LaserClosed {
    pub pts: Vec<Pt>,
    pub cut: ShapeCut,
}
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LaserIn {
    pub lead_in: f64,
    pub closed: Vec<LaserClosed>,
    pub open: Vec<(Vec<Pt>, Option<String>)>,
}
#[derive(Serialize, Clone, Debug)]
pub struct LaserPath {
    pub pts: Vec<Pt>,
    pub lead: Option<Pt>,
    pub runs: Option<Vec<Vec<Pt>>>,
}
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LaserOut {
    pub closed: Vec<LaserPath>,
    pub open: Vec<Vec<Pt>>,
    pub start_in_tab: usize,
}

#[derive(Deserialize)]
pub struct Job {
    pub plasma: Vec<PlasmaIn>,
    pub laser: Vec<LaserIn>,
}
#[derive(Serialize)]
pub struct Output {
    pub plasma: Vec<ShapePlan>,
    pub laser: Vec<LaserOut>,
}

pub fn run(job: &Job) -> Output {
    Output { plasma: job.plasma.iter().map(plasma_plan).collect(), laser: job.laser.iter().map(laser_plan).collect() }
}

const CORNER_TIE: f64 = 1e-9;

fn d(a: Pt, b: Pt) -> f64 {
    hypot2(a.x - b.x, a.y - b.y)
}
fn area(pts: &[Pt]) -> f64 {
    let mut a = 0.0;
    let n = pts.len();
    if n == 0 {
        return 0.0;
    }
    let mut j = n - 1;
    for i in 0..n {
        a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
        j = i;
    }
    a / 2.0
}
fn point_in_poly(px: f64, py: f64, poly: &[Pt]) -> bool {
    let mut inside = false;
    let n = poly.len();
    if n == 0 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi, xj, yj) = (poly[i].x, poly[i].y, poly[j].x, poly[j].y);
        if ((yi > py) != (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}
fn rot(loop_: &[Pt], k: usize) -> Vec<Pt> {
    loop_[k..].iter().chain(&loop_[..k]).copied().collect()
}

// ---- cutSetting.ts ----

fn cut_dir(c: &ShapeCut) -> Option<&str> {
    c.dir.as_deref().filter(|d| matches!(*d, "cw" | "ccw" | "forward" | "reverse"))
}
fn cut_start(c: &ShapeCut) -> Option<f64> {
    c.start.filter(|v| v.is_finite() && *v >= 0.0 && *v <= 1.0)
}
fn orient_closed(loop_: Vec<Pt>, dir: &str) -> Vec<Pt> {
    if loop_.len() < 3 {
        return loop_;
    }
    if (area(&loop_) > 0.0) == (dir == "ccw") {
        loop_
    } else {
        std::iter::once(loop_[0]).chain(loop_[1..].iter().rev().copied()).collect()
    }
}
fn open_loop(l: &[Pt]) -> &[Pt] {
    let n = l.len();
    if n > 1 && d(l[0], l[n - 1]) < 1e-9 {
        &l[..n - 1]
    } else {
        l
    }
}
fn rotate_loop_to(input: Vec<Pt>, target: Pt) -> Vec<Pt> {
    let lp = open_loop(&input).to_vec();
    let n = lp.len();
    if n < 2 {
        return input;
    }
    let (mut best, mut edge, mut u) = (f64::INFINITY, 0, 0.0);
    for i in 0..n {
        let (a, b) = (lp[i], lp[(i + 1) % n]);
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l2 = dx * dx + dy * dy;
        let k = if l2 > 0.0 { mx(0.0, mn(1.0, ((target.x - a.x) * dx + (target.y - a.y) * dy) / l2)) } else { 0.0 };
        let dd = hypot2(a.x + dx * k - target.x, a.y + dy * k - target.y);
        if dd < best - 1e-12 {
            best = dd;
            edge = i;
            u = k;
        }
    }
    let (a, b) = (lp[edge], lp[(edge + 1) % n]);
    let len = d(a, b);
    if u * len < 1e-6 {
        return rot(&lp, edge);
    }
    if (1.0 - u) * len < 1e-6 {
        return rot(&lp, (edge + 1) % n);
    }
    let p = Pt { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    std::iter::once(p).chain(lp[edge + 1..].iter().copied()).chain(lp[..=edge].iter().copied()).collect()
}
fn point_at_fraction(pts: &[Pt], closed: bool, f: f64) -> Pt {
    let list: Vec<Pt> = if closed { pts.iter().chain(std::iter::once(&pts[0])).copied().collect() } else { pts.to_vec() };
    let mut total = 0.0;
    for i in 1..list.len() {
        total += d(list[i], list[i - 1]);
    }
    let mut left = mx(0.0, mn(1.0, f)) * total;
    for i in 1..list.len() {
        let l = d(list[i], list[i - 1]);
        if left <= l && l > 0.0 {
            let u = left / l;
            return Pt { x: list[i - 1].x + (list[i].x - list[i - 1].x) * u, y: list[i - 1].y + (list[i].y - list[i - 1].y) * u };
        }
        left -= l;
    }
    list[list.len() - 1]
}
/// gesetzter Startpunkt in mm (cutStartMm)
fn cut_start_mm(c: &ShapeCut) -> Option<Pt> {
    let f = cut_start(c)?;
    let p = c.path.as_ref()?;
    if !p.closed || p.pts.len() < 2 {
        return None;
    }
    let q = point_at_fraction(&p.pts, true, f);
    Some(Pt { x: q.x / c.px, y: q.y / c.px })
}
fn apply_cut_closed(lp: Vec<Pt>, c: &ShapeCut) -> Vec<Pt> {
    if cut_dir(c).is_none() && cut_start(c).is_none() {
        return lp;
    }
    let mut out = lp;
    if let Some(dir @ ("cw" | "ccw")) = cut_dir(c) {
        out = orient_closed(out, dir);
    }
    if let Some(s) = cut_start_mm(c) {
        out = rotate_loop_to(out, s);
    }
    out
}

// ---- plasmaCam.ts ----

fn far_point(lp: &[Pt], i: usize, step: i64, dist: f64) -> Pt {
    let n = lp.len() as i64;
    let p = lp[i];
    for k in 1..n {
        let q = lp[((i as i64 + step * k) % n + n) as usize % n as usize];
        if d(q, p) >= dist {
            return q;
        }
    }
    lp[((i as i64 + step) % n + n) as usize % n as usize]
}

pub fn corner_index(lp: &[Pt]) -> usize {
    let (mut best, mut best_turn) = (0, 0.52);
    for i in 0..lp.len() {
        let (a, p, b) = (far_point(lp, i, -1, 0.5), lp[i], far_point(lp, i, 1, 0.5));
        let (ux, uy, vx, vy) = (p.x - a.x, p.y - a.y, b.x - p.x, b.y - p.y);
        let (lu, lv) = (hypot2(ux, uy), hypot2(vx, vy));
        if lu < 1e-6 || lv < 1e-6 {
            continue;
        }
        let turn = jsmath::acos(mx(-1.0, mn(1.0, (ux * vx + uy * vy) / (lu * lv))));
        if turn > best_turn + CORNER_TIE {
            best_turn = turn;
            best = i;
        }
    }
    best
}

/// `x || 1`
fn or1(v: f64) -> f64 {
    if v == 0.0 || v.is_nan() {
        1.0
    } else {
        v
    }
}

pub fn lead_point(lp: &[Pt], outside: bool, len: f64) -> Option<Pt> {
    if !(len > 0.0) {
        return None;
    }
    let p0 = lp[0];
    let (prev, next) = (far_point(lp, 0, -1, 0.5), far_point(lp, 0, 1, 0.5));
    let ln = or1(hypot2(next.x - p0.x, next.y - p0.y));
    let lpv = or1(hypot2(p0.x - prev.x, p0.y - prev.y));
    let mut dx = (next.x - p0.x) / ln + (p0.x - prev.x) / lpv;
    let mut dy = (next.y - p0.y) / ln + (p0.y - prev.y) / lpv;
    let l = hypot2(dx, dy);
    if l < 1e-9 {
        dx = next.x - p0.x;
        dy = next.y - p0.y;
    } else {
        dx /= l;
        dy /= l;
    }
    let mut ll = len;
    for _ in 0..4 {
        for s in [1.0, -1.0] {
            let (nx, ny) = (-dy * s, dx * s);
            let q = Pt { x: p0.x + nx * ll, y: p0.y + ny * ll };
            let mid = Pt { x: p0.x + nx * ll * 0.5, y: p0.y + ny * ll * 0.5 };
            let (in_q, in_m) = (point_in_poly(q.x, q.y, lp), point_in_poly(mid.x, mid.y, lp));
            if if outside { !in_q && !in_m } else { in_q && in_m } {
                return Some(q);
            }
        }
        ll /= 2.0;
    }
    None
}

pub fn overcut_points(lp: &[Pt], len: f64) -> Vec<Pt> {
    let mut out = vec![];
    let mut rest = len;
    let mut i = 1;
    while i <= lp.len() && rest > 1e-6 {
        let (a, b) = (lp[i - 1], lp[i % lp.len()]);
        let dd = d(b, a);
        i += 1;
        if dd < 1e-9 {
            continue;
        }
        if dd >= rest {
            out.push(Pt { x: a.x + (b.x - a.x) * (rest / dd), y: a.y + (b.y - a.y) * (rest / dd) });
            rest = 0.0;
        } else {
            out.push(b);
            rest -= dd;
        }
    }
    out
}

fn loop_from(lp: &[Pt], over: &[Pt]) -> Vec<Pt> {
    if over.is_empty() {
        return lp.to_vec();
    }
    let end = over[over.len() - 1];
    let k = over.len() % lp.len();
    let rest = rot(lp, k);
    if d(rest[0], end) < 1e-6 {
        rest
    } else {
        std::iter::once(end).chain(rest).collect()
    }
}

fn extent(pts: &[Pt]) -> f64 {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in pts {
        x0 = mn(x0, p.x);
        y0 = mn(y0, p.y);
        x1 = mx(x1, p.x);
        y1 = mx(y1, p.y);
    }
    if pts.is_empty() {
        0.0
    } else {
        mx(x1 - x0, y1 - y0)
    }
}

fn clean_loop(lp: &[Pt], tol: f64) -> Vec<Pt> {
    let mut pts: Vec<Pt> = vec![];
    for &p in lp {
        match pts.last() {
            Some(&l) if !(d(p, l) > tol) => {}
            _ => pts.push(p),
        }
    }
    while pts.len() > 3 && d(pts[0], pts[pts.len() - 1]) <= tol {
        pts.pop();
    }
    let mut changed = true;
    while changed && pts.len() > 3 {
        changed = false;
        let mut i: i64 = 0;
        while (i as usize) < pts.len() && pts.len() > 3 {
            let n = pts.len();
            let iu = i as usize;
            let (a, p, b) = (pts[(iu + n - 1) % n], pts[iu], pts[(iu + 1) % n]);
            let (ux, uy, vx, vy) = (p.x - a.x, p.y - a.y, b.x - p.x, b.y - p.y);
            let (lu, lv) = (hypot2(ux, uy), hypot2(vx, vy));
            // fast genau umkehren = Zacke
            if lu > 0.0 && lv > 0.0 && (ux * vx + uy * vy) / (lu * lv) < -0.95 {
                pts.remove(iu);
                changed = true;
                i -= 1;
            }
            i += 1;
        }
    }
    pts
}

// ---- tabs.ts ----

fn cumulative(ring: &[Pt]) -> Vec<f64> {
    let mut cum = vec![0.0];
    for i in 1..=ring.len() {
        let (a, b) = (ring[i - 1], ring[i % ring.len()]);
        cum.push(cum[i - 1] + d(b, a));
    }
    cum
}
fn point_at(ring: &[Pt], cum: &[f64], s: f64) -> Pt {
    let l = cum[cum.len() - 1];
    let s = ((s % l) + l) % l;
    let mut i = 1;
    while i < cum.len() - 1 && cum[i] < s {
        i += 1;
    }
    let (a, b) = (ring[i - 1], ring[i % ring.len()]);
    let f = (s - cum[i - 1]) / mx(1e-12, cum[i] - cum[i - 1]);
    Pt { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
}
fn project(ring: &[Pt], cum: &[f64], p: Pt) -> (f64, f64) {
    let (mut bs, mut bd) = (0.0, f64::INFINITY);
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 { mx(0.0, mn(1.0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) } else { 0.0 };
        let dd = hypot2(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
        if dd < bd {
            bs = cum[i] + l2.sqrt() * t;
            bd = dd;
        }
    }
    (bs, bd)
}
/// tabSettings(shape, false) != null
fn has_tabs(t: &Tab) -> bool {
    if !(t.len > 0.0) {
        return false;
    }
    if t.mode == "manual" {
        return t.list && !t.pts.is_empty();
    }
    jsmath::js_round(t.n) > 0.0
}
fn tab_centers(t: &Tab, px: f64, ring: &[Pt], cum: &[f64], near: f64) -> Vec<f64> {
    let l = cum[cum.len() - 1];
    if t.mode == "manual" {
        let mut out = vec![];
        for f in &t.pts {
            let f = f.unwrap_or(f64::NAN);
            let Some(ol) = t.outline.as_ref() else { continue };
            let oc = cumulative(ol);
            let w = point_at(ol, &oc, f * oc[oc.len() - 1]);
            let (s, dd) = project(ring, cum, Pt { x: w.x / px, y: w.y / px });
            if dd <= near {
                out.push(s);
            }
        }
        return out;
    }
    let n = jsmath::js_round(t.n);
    let n = if n > 0.0 { n as usize } else { 0 };
    (0..n).map(|k| ((k as f64 + 0.5) / n as f64) * l).collect()
}

/// Laser/Plasma: Kontur an den Stegen in Schneid-Stücke zerlegen; rotated = Anfang lag in einem Steg
pub fn tab_runs(c: &ShapeCut, lp: &[Pt], gap: f64) -> Option<(Vec<Vec<Pt>>, bool)> {
    if !has_tabs(&c.tab) || lp.len() < 3 || !(gap > 0.0) {
        return None;
    }
    let cum = cumulative(lp);
    let l = cum[cum.len() - 1];
    let half = gap / 2.0;
    let mut centers = tab_centers(&c.tab, c.px, lp, &cum, half + 1.0);
    // sort((a, b) => a - b)
    centers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if centers.is_empty() || centers.len() as f64 * gap >= l * 0.9 {
        return None;
    }
    let mut s0 = 0.0;
    for &cc in &centers {
        let dd = mn(cc.abs(), (cc - l).abs());
        if dd < half {
            s0 = if cc < l / 2.0 { cc + half } else { cc - l + half };
            break;
        }
    }
    let rel = |x: f64| (((x - s0) % l) + l) % l;
    let mut gaps: Vec<[f64; 2]> = centers.iter().map(|&cc| [rel(cc) - half, rel(cc) + half]).collect();
    gaps.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap_or(std::cmp::Ordering::Equal));
    let mut merged: Vec<[f64; 2]> = vec![];
    for g in gaps {
        match merged.last_mut() {
            Some(last) if g[0] <= last[1] => last[1] = mx(last[1], g[1]),
            _ => merged.push(g),
        }
    }
    let mut bounds: Vec<[f64; 2]> = vec![];
    let mut from = 0.0;
    for [a, b] in merged {
        if a > from + 1e-6 {
            bounds.push([from, mn(a, l)]);
        }
        from = mx(from, b);
    }
    if from < l - 1e-6 {
        bounds.push([from, l]);
    }
    let verts: Vec<(Pt, f64)> = lp.iter().enumerate().map(|(i, &p)| (p, rel(cum[i]))).collect();
    let runs = bounds
        .iter()
        .map(|&[a, b]| {
            let mut mid: Vec<(Pt, f64)> = verts.iter().filter(|v| v.1 > a + 1e-6 && v.1 < b - 1e-6).copied().collect();
            // stabile Sortierung wie Array.prototype.sort
            mid.sort_by(|u, v| u.1.partial_cmp(&v.1).unwrap_or(std::cmp::Ordering::Equal));
            std::iter::once(point_at(lp, &cum, s0 + a)).chain(mid.into_iter().map(|v| v.0)).chain(std::iter::once(point_at(lp, &cum, s0 + b))).collect()
        })
        .collect();
    Some((runs, s0.abs() > 1e-9))
}

// ---- Plasma: computePlan ----

pub fn plasma_plan(inp: &PlasmaIn) -> ShapePlan {
    let mut res = ShapePlan { plans: vec![], too_small: false, lead_short: false, dir_by_hand: false, start_in_tab: false };
    let c = &inp.cut;
    for path in &inp.paths {
        if path.pts.len() < 2 {
            continue;
        }
        let Some(loops) = path.loops.as_ref() else {
            // offen oder „auf der Linie“: nur gesetzte Richtung/Start
            let pts = if path.closed { apply_cut_closed(path.pts.clone(), c) } else if cut_dir(c) == Some("reverse") { path.pts.iter().rev().copied().collect() } else { path.pts.clone() };
            res.plans.push(PlasmaPlan { pts, closed: path.closed, lead: None, over: vec![], out: None, area: 0.0, hole: false, size: extent(&path.pts), runs: None });
            continue;
        };
        let outside = inp.mode == "outside";
        if loops.is_empty() {
            res.too_small = true;
            continue;
        }
        for lp0 in loops {
            let mut lp = clean_loop(lp0, 0.05);
            if lp.len() < 3 {
                continue;
            }
            let ccw = area(&lp) > 0.0;
            match cut_dir(c) {
                Some(dir @ ("cw" | "ccw")) => {
                    if (dir == "ccw") == outside {
                        res.dir_by_hand = true;
                    }
                    lp = orient_closed(lp, dir);
                }
                _ => {
                    if outside == ccw {
                        lp.reverse();
                    }
                }
            }
            if let Some(s) = cut_start_mm(c) {
                lp = rotate_loop_to(lp, s);
            } else {
                let si = corner_index(&lp);
                lp = rot(&lp, si);
            }
            let mut lead = lead_point(&lp, outside, inp.lead_in);
            if inp.lead_in > 0.0 && lead.is_none() {
                res.lead_short = true;
            }
            let tr = tab_runs(c, &lp, c.tab.len + inp.kerf);
            if tr.as_ref().is_some_and(|t| t.1) {
                lead = None;
                if cut_start(c).is_some() {
                    res.start_in_tab = true;
                }
            }
            let over = if tr.is_some() { vec![] } else { overcut_points(&lp, inp.overcut) };
            let mut plan = PlasmaPlan { area: area(&lp).abs(), size: extent(&lp), pts: lp, closed: true, lead, over, out: None, hole: !outside, runs: tr.map(|t| t.0) };
            // Ausfahrbahn: nicht mit Haltestegen und nicht bei kleinen Löchern
            let small = plan.hole && inp.small_hole > 0.0 && plan.size <= inp.small_hole + 1e-9;
            if inp.lead_out > 0.0 && plan.runs.is_none() && !small {
                plan.out = lead_point(&loop_from(&plan.pts, &plan.over), outside, inp.lead_out);
            }
            res.plans.push(plan);
        }
    }
    res
}

// ---- Laser: applyCut, withLeadIn, tabRuns ----

pub fn laser_plan(inp: &LaserIn) -> LaserOut {
    let open = inp.open.iter().map(|(pts, dir)| if dir.as_deref() == Some("reverse") { pts.iter().rev().copied().collect() } else { pts.clone() }).collect();
    let closed: Vec<Vec<Pt>> = inp.closed.iter().map(|c| apply_cut_closed(c.pts.clone(), &c.cut)).collect();
    let mut start_in_tab = 0;
    let out = closed
        .iter()
        .enumerate()
        .map(|(k, pts)| {
            let c = &inp.closed[k].cut;
            let (lp, lead) = with_lead_in(pts, k, &closed, inp.lead_in, cut_start(c).is_some());
            let tr = tab_runs(c, &lp, c.tab.len);
            if tr.as_ref().is_some_and(|t| t.1) && cut_start(c).is_some() {
                start_in_tab += 1;
            }
            let rotated = tr.as_ref().is_some_and(|t| t.1);
            LaserPath { pts: lp, lead: if rotated { None } else { lead }, runs: tr.map(|t| t.0) }
        })
        .collect();
    LaserOut { closed: out, open, start_in_tab }
}

fn with_lead_in(pts: &[Pt], me: usize, all: &[Vec<Pt>], len: f64, fixed_start: bool) -> (Vec<Pt>, Option<Pt>) {
    if !(len > 0.0) || pts.len() < 3 {
        return (pts.to_vec(), None);
    }
    let mut lp = pts.to_vec();
    if d(lp[0], lp[lp.len() - 1]) < 1e-6 {
        lp.pop();
    }
    if lp.len() < 3 {
        return (pts.to_vec(), None);
    }
    let depth = all.iter().enumerate().filter(|(k, o)| *k != me && point_in_poly(lp[0].x, lp[0].y, o)).count();
    let si = if fixed_start { 0 } else { corner_index(&lp) };
    let lp = rot(&lp, si);
    let lead = lead_point(&lp, depth % 2 == 0, len);
    (lp, lead)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Read;

    #[test]
    fn regular_polygon_starts_at_the_first_corner() {
        let p: Vec<Pt> = (0..6).map(|i| {
            let a = 0.3 + 2.0 * std::f64::consts::PI * i as f64 / 6.0;
            Pt { x: 50.0 + 20.0 * a.cos(), y: 50.0 + 20.0 * a.sin() }
        }).collect();
        assert_eq!(corner_index(&p), 0);
        assert_eq!(overcut_points(&[Pt { x: 0.0, y: 0.0 }, Pt { x: 10.0, y: 0.0 }, Pt { x: 10.0, y: 10.0 }], 12.0), [Pt { x: 10.0, y: 0.0 }, Pt { x: 10.0, y: 2.0 }]);
    }

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
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("cutplan-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        let job: Job = serde_json::from_value(all["job"].clone()).unwrap();
        assert!(job.plasma.len() >= 30 && job.laser.len() >= 10, "{} plasma, {} laser", job.plasma.len(), job.laser.len());
        let got = serde_json::to_value(run(&job)).unwrap();
        let names = all["names"].as_object().unwrap();
        for kind in ["plasma", "laser"] {
            let (g, w) = (got[kind].as_array().unwrap(), all["want"][kind].as_array().unwrap());
            assert_eq!(g.len(), w.len());
            for (k, (gi, wi)) in g.iter().zip(w).enumerate() {
                same(wi, gi, &format!("{kind} {k} {}", names[kind][k]));
            }
        }
        println!("{} plasma shapes and {} laser layers planned the same as the TypeScript", job.plasma.len(), job.laser.len());
    }
}
