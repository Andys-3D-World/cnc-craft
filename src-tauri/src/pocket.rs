//! TASCHE FRÄSEN (Zwilling von src/pocket.ts, src/adaptive.ts und orientLoop aus src/millDir.ts)
//!
//!  - „Parallel“ (linear): Zickzack-Bahnen quer durch die Tasche, danach eine Schlichtbahn an der Wand
//!  - „Kontur“ (spiral):   Ringe im Abstand der Zustellung von innen nach außen, zuletzt die Wand
//!  - „Adaptiv“ (adaptive): gleichmäßige Umschlingung mit Schleifen und Helix-Einstieg
//! Inseln bleiben stehen. Der Fräsermittelpunkt bleibt immer mindestens den Werkzeugradius von Wand und Inseln weg.
//!
//! Die Rechnung folgt dem TypeScript Schritt für Schritt. Geprüft mit denselben Fällen auf beiden Seiten:
//! tests/fixtures/pocket-cases.json und pocket-expected.json (tests/pocketRust.test.ts und die Tests unten).
//! Wegen der Winkelfunktionen (jsmath.rs) mit kleiner Toleranz: gleiche Bahnen, gleiche Punktzahl, Lage auf 1e-9 mm.
//!
//! Noch nicht gerufen: der Fräs-G-Code (cam.ts) entsteht im Fenster. Zieht er um, ruft er diese Funktionen direkt.
#![allow(dead_code)]

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath;
use crate::polyoffset::{offset_polygon, point_in_poly, polygon_area, P};

/// helix: schraubenförmig um (x, y) mit Radius r eintauchen statt senkrecht (nur „Adaptiv“)
#[derive(Clone, Debug)]
pub struct PocketPath {
    pub pts: Vec<P>,
    pub closed: bool,
    pub helix: Option<[f64; 3]>,
}

type Edge = (P, P);

// ---- Fräsrichtung (millDir.ts) ----

/// Soll die Bahn gegen den Uhrzeigersinn laufen? None = Standard, nichts vorgeben.
/// inside = in Loch oder Tasche; dir: "" | "climb" | "conventional"
fn wants_ccw(inside: bool, dir: &str) -> Option<bool> {
    if dir.is_empty() {
        return None;
    }
    Some(inside == (dir == "climb"))
}

/// Geschlossene Bahn in die gewünschte Richtung drehen; sie fängt weiter am selben Punkt an
pub fn orient_loop(lp: Vec<P>, inside: bool, dir: &str) -> Vec<P> {
    let Some(ccw) = wants_ccw(inside, dir) else { return lp };
    if lp.len() < 3 || (polygon_area(&lp) > 0.0) == ccw {
        return lp;
    }
    let mut out = Vec::with_capacity(lp.len());
    out.push(lp[0]);
    out.extend(lp[1..].iter().rev());
    out
}

// ---- Bahnen an Kanten teilen ----

fn edges_of<'a>(loops: impl IntoIterator<Item = &'a Vec<P>>) -> Vec<Edge> {
    let mut out = Vec::new();
    for l in loops {
        for i in 0..l.len() {
            out.push((l[i], l[(i + 1) % l.len()]));
        }
    }
    out
}

/// Schnittpunkt-Anteil t auf Strecke a→b mit Strecke c→d (nur echte Kreuzungen)
fn cross_t(a: P, b: P, c: P, d: P) -> Option<f64> {
    let (rx, ry, sx, sy) = (b[0] - a[0], b[1] - a[1], d[0] - c[0], d[1] - c[1]);
    let den = rx * sy - ry * sx;
    if den.abs() < 1e-12 {
        return None;
    }
    let t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
    let u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
    if t > 1e-9 && t < 1.0 - 1e-9 && u >= 0.0 && u <= 1.0 {
        Some(t)
    } else {
        None
    }
}

/// Punkt in der Mitte der Linie (nach Länge)
fn mid(p: &[P]) -> P {
    let mut len = 0.0;
    for i in 1..p.len() {
        len += hypot2(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    }
    let mut half = len / 2.0;
    for i in 1..p.len() {
        let l = hypot2(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
        if l >= half && l > 0.0 {
            let t = half / l;
            return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t];
        }
        half -= l;
    }
    p[0]
}

/// Linie an allen Kreuzungen mit den Kanten teilen, nur Stücke behalten, deren Mitte erlaubt ist
fn clip(pts: &[P], closed: bool, edges: &[Edge], keep: &dyn Fn(P) -> bool) -> Vec<PocketPath> {
    let n = pts.len();
    let count = if closed { n + 1 } else { n };
    let at = |i: usize| pts[i % n];
    let mut pieces: Vec<Vec<P>> = Vec::new();
    let mut cur: Vec<P> = vec![at(0)];
    let mut ts: Vec<f64> = Vec::new();
    for i in 1..count {
        let (a, b) = (at(i - 1), at(i));
        ts.clear();
        for &(c, d) in edges {
            if let Some(t) = cross_t(a, b, c, d) {
                ts.push(t);
            }
        }
        ts.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
        for &t in &ts {
            let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            cur.push(p);
            pieces.push(std::mem::replace(&mut cur, vec![p]));
        }
        cur.push(b);
    }
    pieces.push(cur);
    // ein geschlossener Ring ohne Kreuzung bleibt geschlossen
    if closed && pieces.len() == 1 {
        return if keep(mid(&pieces[0])) { vec![PocketPath { pts: pts.to_vec(), closed: true, helix: None }] } else { vec![] };
    }
    // bei einem Ring gehören das letzte und das erste Stück zusammen
    if closed && pieces.len() > 1 {
        let mut last = pieces.pop().unwrap();
        last.extend_from_slice(&pieces[0][1..]);
        pieces[0] = last;
    }
    pieces.into_iter().filter(|p| p.len() >= 2 && keep(mid(p))).map(|p| PocketPath { pts: p, closed: false, helix: None }).collect()
}

/// Wand und Inseln mit ihren Prüfungen (was im TypeScript die Funktionen inWall / inIsl sind)
struct Zone {
    wall: Vec<Vec<P>>,
    isl: Vec<Vec<P>>,
}

impl Zone {
    fn in_wall(&self, p: P) -> bool {
        self.wall.iter().any(|w| point_in_poly(p[0], p[1], w))
    }
    /// in einer Insel? `skip` = diese Insel nicht mitzählen
    fn in_isl(&self, p: P, skip: Option<usize>) -> bool {
        self.isl.iter().enumerate().any(|(k, i)| Some(k) != skip && point_in_poly(p[0], p[1], i))
    }
    /// Wand ohne die Stücke in Inseln, dann die Inseln ohne Stücke außerhalb der Wand
    fn finish(&self) -> Vec<PocketPath> {
        let mut out = Vec::new();
        let isl_edges = edges_of(&self.isl);
        for w in &self.wall {
            out.extend(clip(w, true, &isl_edges, &|p| !self.in_isl(p, None)));
        }
        for (k, i) in self.isl.iter().enumerate() {
            let edges = edges_of(self.wall.iter().chain(self.isl.iter().enumerate().filter(|(o, _)| *o != k).map(|(_, l)| l)));
            out.extend(clip(i, true, &edges, &|p| self.in_wall(p) && !self.in_isl(p, Some(k))));
        }
        out
    }
}

fn zone(outer: &[P], islands: &[Vec<P>], r: f64, dir: &str) -> Zone {
    Zone {
        wall: offset_polygon(outer, -r, 0.01).into_iter().map(|l| orient_loop(l, true, dir)).collect(),
        isl: islands.iter().flat_map(|i| offset_polygon(i, r, 0.01)).map(|l| orient_loop(l, false, dir)).collect(),
    }
}

/// Nur die Wand-Bahnen (Wand + Inseln, Fräsermittelpunkt im Abstand r) – für den Schlichtgang
pub fn pocket_wall_paths(outer: &[P], islands: &[Vec<P>], r: f64, dir: &str) -> Vec<PocketPath> {
    zone(outer, islands, r, dir).finish()
}

/// `outer`: Wand der Tasche, `islands`: Inseln, die stehen bleiben, `r`: Werkzeugradius, `step`: seitliche Zustellung,
/// `strategy`: "linear" | "spiral" | "adaptive". Antwort: Bahnen in Fräs-Reihenfolge; true = Werkzeug passt nicht hinein
pub fn pocket_paths(outer: &[P], islands: &[Vec<P>], r: f64, step: f64, strategy: &str, dir: &str) -> (Vec<PocketPath>, bool) {
    // Wand: Fräser innen; Insel: Fräser außen herum. Ohne Vorgabe bleibt alles, wie es ist
    let z = zone(outer, islands, r, dir);
    if z.wall.is_empty() {
        return (vec![], true);
    }
    let edges = edges_of(z.wall.iter().chain(z.isl.iter()));
    let allowed = |p: P| z.in_wall(p) && !z.in_isl(p, None);
    let finish = z.finish();

    let mut rough: Vec<PocketPath> = Vec::new();
    if strategy == "adaptive" {
        rough.extend(adaptive_paths(outer, islands, r, &z.wall, &z.isl));
    } else if strategy == "spiral" {
        // Ringe immer weiter nach innen (bzw. um die Inseln nach außen), bis nichts mehr übrig ist
        let mut levels: Vec<Vec<PocketPath>> = Vec::new();
        for k in 1..2000 {
            let d = r + k as f64 * step;
            let mut kept = Vec::new();
            for g in offset_polygon(outer, -d, 0.01).into_iter().map(|l| orient_loop(l, true, dir)) {
                kept.extend(clip(&g, true, &edges, &allowed));
            }
            for g in islands.iter().flat_map(|i| offset_polygon(i, d, 0.01)).map(|l| orient_loop(l, false, dir)) {
                kept.extend(clip(&g, true, &edges, &allowed));
            }
            if kept.is_empty() {
                break;
            }
            levels.push(kept);
        }
        // von innen nach außen
        for l in levels.into_iter().rev() {
            rough.extend(l);
        }
    } else {
        // Zickzack: waagerechte Bahnen, Verbindung zur nächsten Bahn ohne Absetzen, wenn der Weg frei ist
        let (mut y0, mut y1) = (f64::INFINITY, f64::NEG_INFINITY);
        for w in &z.wall {
            for p in w {
                y0 = mn(y0, p[1]);
                y1 = mx(y1, p[1]);
            }
        }
        let n = mx(1.0, ((y1 - y0) / step).ceil());
        let dy = (y1 - y0) / n;
        let mut cur: Option<Vec<P>> = None;
        let mut flip = false;
        let mut xs: Vec<f64> = Vec::new();
        let mut k = 0.0f64;
        while k <= n {
            let y = mn(y1, y0 + k * dy) + if k == 0.0 { 1e-6 } else if k == n { -1e-6 } else { 0.0 };
            xs.clear();
            for &(a, b) in &edges {
                if (a[1] > y) != (b[1] > y) {
                    xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
                }
            }
            xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let mut spans: Vec<(f64, f64)> = Vec::new();
            for i in 0..xs.len().saturating_sub(1) {
                if xs[i + 1] - xs[i] > 1e-6 && allowed([(xs[i] + xs[i + 1]) / 2.0, y]) {
                    spans.push((xs[i], xs[i + 1]));
                }
            }
            if flip {
                spans.reverse();
            }
            for &(a, b) in &spans {
                let (s, e) = if flip { ([b, y], [a, y]) } else { ([a, y], [b, y]) };
                let free = match cur.as_ref().map(|c| c[c.len() - 1]) {
                    Some(last) => {
                        (last[1] - y).abs() > 1e-9
                            && (last[1] - y).abs() <= dy * 1.01
                            && !edges.iter().any(|&(c, d)| cross_t(last, s, c, d).is_some())
                            && allowed([(last[0] + s[0]) / 2.0, (last[1] + s[1]) / 2.0])
                    }
                    None => false,
                };
                if free {
                    let c = cur.as_mut().unwrap();
                    c.push(s);
                    c.push(e);
                } else {
                    if let Some(c) = cur.take() {
                        rough.push(PocketPath { pts: c, closed: false, helix: None });
                    }
                    cur = Some(vec![s, e]);
                }
            }
            if !spans.is_empty() {
                flip = !flip;
            }
            k += 1.0;
        }
        if let Some(c) = cur {
            rough.push(PocketPath { pts: c, closed: false, helix: None });
        }
    }
    rough.extend(finish);
    (rough, false)
}

// ---------------------------------------------------------------------
// Adaptives Ausräumen (adaptive.ts)
// ---------------------------------------------------------------------

/// Abstand der Ringe (× Durchmesser) = seitliche Zustellung auf geraden Stücken
const RING: f64 = 0.3;
/// Radius der Schleifen (× Durchmesser)
const LOOP: f64 = 0.3;
/// Vorschub je Schleife (× Durchmesser)
const PITCH: f64 = 0.08;
/// erlaubte Umschlingung (Anteil des Umfangs, 0.25 = 90°)
const EMAX: f64 = 0.25;
/// Punkte je Schleife
const LOOP_PTS: usize = 16;
const MAX_CELLS: f64 = 3_000_000.0;

/// Raster über der Tasche: was noch Material ist und wie viel Platz der Fräsermittelpunkt hat
struct Grid {
    x0: f64,
    y0: f64,
    c: f64,
    w: usize,
    h: usize,
    /// Material steht noch
    rest: Vec<bool>,
    /// Abstand (mm) des Mittelpunkts bis zur verbotenen Zone (32-Bit-Zahlen wie im TypeScript)
    clear: Vec<f32>,
}

impl Grid {
    fn new(x0: f64, y0: f64, x1: f64, y1: f64, c: f64) -> Self {
        let w = mx(1.0, ((x1 - x0) / c).ceil());
        let h = mx(1.0, ((y1 - y0) / c).ceil());
        let (w, h) = if w.is_finite() && h.is_finite() && w * h <= 50_000_000.0 { (w as usize, h as usize) } else { (1, 1) };
        Grid { x0, y0, c, w, h, rest: vec![false; w * h], clear: vec![0.0; w * h] }
    }
    fn idx(&self, x: f64, y: f64) -> Option<usize> {
        let (i, j) = (((x - self.x0) / self.c).floor(), ((y - self.y0) / self.c).floor());
        if i < 0.0 || j < 0.0 || i >= self.w as f64 || j >= self.h as f64 || i.is_nan() || j.is_nan() {
            None
        } else {
            Some(j as usize * self.w + i as usize)
        }
    }
    /// Zeilenweise füllen (gerade/ungerade-Regel): fn bekommt Zeile und Spalten-Bereich
    fn spans(&self, polys: &[&Vec<P>], mut each: impl FnMut(usize, usize, usize)) {
        let mut xs: Vec<f64> = Vec::new();
        for j in 0..self.h {
            let y = self.y0 + (j as f64 + 0.5) * self.c;
            xs.clear();
            for p in polys {
                for k in 0..p.len() {
                    let (a, b) = (p[k], p[(k + 1) % p.len()]);
                    if (a[1] > y) != (b[1] > y) {
                        xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
                    }
                }
            }
            xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let mut k = 0;
            while k + 1 < xs.len() {
                let i0 = mx(0.0, ((xs[k] - self.x0) / self.c - 0.5).ceil());
                let i1 = mn(self.w as f64 - 1.0, ((xs[k + 1] - self.x0) / self.c - 0.5).floor());
                if i1 >= i0 {
                    each(j, i0 as usize, i1 as usize);
                }
                k += 2;
            }
        }
    }
    /// Fräser (Kreis) an dieser Stelle: Material dort ist weg
    fn stamp(&mut self, x: f64, y: f64, rad: f64) {
        let (c, r2) = (self.c, rad * rad);
        let i0 = mx(0.0, ((x - rad - self.x0) / c).floor());
        let i1 = mn(self.w as f64 - 1.0, ((x + rad - self.x0) / c).ceil());
        let j0 = mx(0.0, ((y - rad - self.y0) / c).floor());
        let j1 = mn(self.h as f64 - 1.0, ((y + rad - self.y0) / c).ceil());
        if !(i1 >= i0 && j1 >= j0) {
            return;
        }
        for j in j0 as usize..=j1 as usize {
            let dy = self.y0 + (j as f64 + 0.5) * c - y;
            for i in i0 as usize..=i1 as usize {
                let dx = self.x0 + (i as f64 + 0.5) * c - x;
                if dx * dx + dy * dy <= r2 {
                    self.rest[j * self.w + i] = false;
                }
            }
        }
    }
    fn is_rest(&self, x: f64, y: f64) -> bool {
        self.idx(x, y).is_some_and(|k| self.rest[k])
    }
    fn clearance(&self, x: f64, y: f64) -> f64 {
        self.idx(x, y).map_or(0.0, |k| mx(0.0, self.clear[k] as f64 - self.c))
    }
}

/// Abstand jeder erlaubten Zelle bis zur nächsten verbotenen (Chamfer 1 / √2, in mm)
fn distance(g: &mut Grid, allowed: &[bool]) {
    let (w, h, s2) = (g.w, g.h, std::f64::consts::SQRT_2);
    let d = &mut g.clear;
    for k in 0..w * h {
        d[k] = if allowed[k] { 1e9 } else { 0.0 };
    }
    let at = |d: &Vec<f32>, k: usize| d[k] as f64;
    for j in 0..h {
        for i in 0..w {
            let k = j * w + i;
            if d[k] == 0.0 {
                continue;
            }
            let mut v = at(d, k);
            v = if i > 0 { mn(v, at(d, k - 1) + 1.0) } else { mn(v, 1.0) };
            if j > 0 {
                v = mn(v, at(d, k - w) + 1.0);
                if i > 0 {
                    v = mn(v, at(d, k - w - 1) + s2);
                }
                if i < w - 1 {
                    v = mn(v, at(d, k - w + 1) + s2);
                }
            } else {
                v = mn(v, 1.0);
            }
            d[k] = v as f32;
        }
    }
    for j in (0..h).rev() {
        for i in (0..w).rev() {
            let k = j * w + i;
            if d[k] == 0.0 {
                continue;
            }
            let mut v = at(d, k);
            v = if i < w - 1 { mn(v, at(d, k + 1) + 1.0) } else { mn(v, 1.0) };
            if j < h - 1 {
                v = mn(v, at(d, k + w) + 1.0);
                if i < w - 1 {
                    v = mn(v, at(d, k + w + 1) + s2);
                }
                if i > 0 {
                    v = mn(v, at(d, k + w - 1) + s2);
                }
            } else {
                v = mn(v, 1.0);
            }
            d[k] = v as f32;
        }
    }
    // Chamfer schätzt bis ~8 % zu viel -> etwas abziehen (lieber kleinere Schleifen)
    for k in 0..w * h {
        d[k] = (d[k] as f64 * g.c * 0.92) as f32;
    }
}

/// Linie in gleich lange Stücke teilen (closed: zurück zum Anfang)
fn resample(pts: &[P], closed: bool, h: f64) -> Vec<P> {
    let n = pts.len();
    let count = if closed { n + 1 } else { n };
    let at = |i: usize| pts[i % n];
    let mut out: Vec<P> = vec![at(0)];
    let mut carry = 0.0f64;
    for i in 1..count {
        let (a, b) = (at(i - 1), at(i));
        let len = hypot2(b[0] - a[0], b[1] - a[1]);
        let mut d = h - carry;
        while d <= len {
            let t = d / len;
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            d += h;
        }
        carry = len - (d - h);
    }
    let (last, end) = (at(count - 1), out[out.len() - 1]);
    if hypot2(last[0] - end[0], last[1] - end[1]) > 1e-6 {
        out.push(last);
    }
    out
}

/// Punkte auf geraden Strecken weglassen (kleinere Dateien)
fn simplify(p: Vec<P>, tol: f64) -> Vec<P> {
    if p.len() < 3 {
        return p;
    }
    let mut out = vec![p[0]];
    for i in 1..p.len() - 1 {
        let (a, b, c) = (out[out.len() - 1], p[i], p[i + 1]);
        let len = hypot2(c[0] - a[0], c[1] - a[1]);
        let dist = if len < 1e-9 { hypot2(b[0] - a[0], b[1] - a[1]) } else { ((c[0] - a[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (c[1] - a[1])).abs() / len };
        if dist > tol {
            out.push(b);
        }
    }
    out.push(p[p.len() - 1]);
    out
}

/// `wall`: Grenze für den Fräsermittelpunkt (outer um −r versetzt), `isl`: Inseln um +r versetzt
pub fn adaptive_paths(outer: &[P], islands: &[Vec<P>], r: f64, wall: &[Vec<P>], isl: &[Vec<P>]) -> Vec<PocketPath> {
    let pi = std::f64::consts::PI;
    let dia = 2.0 * r;
    let s = mx(0.02, RING * dia);
    let a = LOOP * dia;
    let h = mx(0.01, PITCH * dia);

    // ---- Raster ----
    let inf = f64::INFINITY;
    let (mut x0, mut y0, mut x1, mut y1) = (inf, inf, -inf, -inf);
    for p in outer {
        x0 = mn(x0, p[0]);
        y0 = mn(y0, p[1]);
        x1 = mx(x1, p[0]);
        y1 = mx(y1, p[1]);
    }
    let area = (x1 - x0 + 2.0 * dia) * (y1 - y0 + 2.0 * dia);
    let c = mx(mx(dia / 20.0, (area / MAX_CELLS).sqrt()), 0.005);
    let mut g = Grid::new(x0 - dia, y0 - dia, x1 + dia, y1 + dia, c);
    let gw = g.w;
    let outer_vec = outer.to_vec();
    {
        let mut polys: Vec<&Vec<P>> = vec![&outer_vec];
        polys.extend(islands.iter());
        let mut fills: Vec<(usize, usize, usize)> = Vec::new();
        g.spans(&polys, |j, i0, i1| fills.push((j, i0, i1)));
        for (j, i0, i1) in fills {
            g.rest[j * gw + i0..=j * gw + i1].iter_mut().for_each(|v| *v = true);
        }
    }
    let mut allowed = vec![false; g.w * g.h];
    g.spans(&wall.iter().collect::<Vec<_>>(), |j, i0, i1| allowed[j * gw + i0..=j * gw + i1].iter_mut().for_each(|v| *v = true));
    for i in isl {
        g.spans(&[i], |j, i0, i1| allowed[j * gw + i0..=j * gw + i1].iter_mut().for_each(|v| *v = false));
    }
    distance(&mut g, &allowed);

    // Umschlingung: Anteil des Umfangs (knapp außerhalb des Fräsers), der noch im Material liegt
    const N: usize = 48;
    let rm = r + c;
    let ring: Vec<P> = (0..N).map(|k| [jsmath::cos((2.0 * pi * k as f64) / N as f64) * rm, jsmath::sin((2.0 * pi * k as f64) / N as f64) * rm]).collect();
    // dir = Fahrtrichtung: nur die vordere Hälfte zählt; ohne dir der ganze Umfang
    let engage = |g: &Grid, q: P, dir: Option<P>| -> f64 {
        let mut n = 0;
        for o in &ring {
            if dir.is_none_or(|d| o[0] * d[0] + o[1] * d[1] >= 0.0) && g.is_rest(q[0] + o[0], q[1] + o[1]) {
                n += 1;
            }
        }
        n as f64 / N as f64
    };
    let dir_at = |sq: &[P], k: usize| -> P {
        let (a, b) = (sq[k.saturating_sub(1)], sq[k.max(1)]);
        [b[0] - a[0], b[1] - a[1]]
    };

    // ---- Ringe von innen nach außen (wie „Kontur“, nur umgekehrt) ----
    let mut levels: Vec<Vec<PocketPath>> = Vec::new();
    for k in 1..4000 {
        let d = r + k as f64 * s;
        let w = offset_polygon(outer, -d, 0.01);
        if w.is_empty() {
            break;
        }
        let z = Zone { wall: w, isl: islands.iter().flat_map(|i| offset_polygon(i, d, 0.01)).collect() };
        let kept = z.finish();
        if kept.is_empty() {
            break;
        }
        levels.push(kept);
    }
    levels.reverse();

    let mut out: Vec<PocketPath> = Vec::new();
    for level in &levels {
        for rp in level {
            let sq = resample(&rp.pts, rp.closed, h);
            if sq.len() < 2 {
                continue;
            }
            let mut pts: Vec<P> = vec![sq[0]];
            let mut helix: Option<[f64; 3]> = None;
            // Einstieg: steht dort noch Material, schraubenförmig eintauchen
            if engage(&g, sq[0], None) > EMAX {
                let rho = mn(a, g.clearance(sq[0][0], sq[0][1]));
                if rho >= 0.15 * r {
                    helix = Some([sq[0][0], sq[0][1], rho]);
                    g.stamp(sq[0][0], sq[0][1], rho + r);
                }
            }
            g.stamp(sq[0][0], sq[0][1], r);

            // Seite mit weniger Material (dort beginnt jede Schleife) als Winkel
            let side_angle = |g: &Grid, k: usize, rho: f64| -> f64 {
                let (p, q, o) = (sq[k], sq[(sq.len() - 1).min(k + 1)], sq[k.saturating_sub(1)]);
                let (mut tx, mut ty) = (q[0] - o[0], q[1] - o[1]);
                let mut tl = hypot2(tx, ty);
                if tl == 0.0 || tl.is_nan() {
                    tl = 1.0;
                }
                tx /= tl;
                ty /= tl;
                let reach = rho + r;
                let count = |sx: f64, sy: f64| -> usize {
                    let mut n = 0;
                    let mut f = 0.4f64;
                    while f <= 1.01 {
                        if g.is_rest(p[0] + sx * reach * f, p[1] + sy * reach * f) {
                            n += 1;
                        }
                        f += 0.3;
                    }
                    n
                };
                if count(-ty, tx) <= count(ty, -tx) {
                    jsmath::atan2(tx, -ty)
                } else {
                    jsmath::atan2(-tx, ty)
                }
            };
            let rho_at = |g: &Grid, k: usize| mn(a, g.clearance(sq[k][0], sq[k][1]));

            let mut i = 1;
            while i < sq.len() {
                if engage(&g, sq[i], Some(dir_at(&sq, i))) <= EMAX {
                    pts.push(sq[i]);
                    g.stamp(sq[i][0], sq[i][1], r);
                    i += 1;
                    continue;
                }
                // ---- Schleifen ab sq[i-1], bis das Material hinter dem Schleifen-Streifen wieder normal ist ----
                let mut k = i - 1;
                let mut rho = rho_at(&g, k);
                let mut phi = side_angle(&g, k, rho);
                if rho < 0.15 * r {
                    // zu eng: gerade (wie bisher)
                    pts.push(sq[i]);
                    g.stamp(sq[i][0], sq[i][1], r);
                    i += 1;
                    continue;
                }
                pts.push([sq[k][0] + rho * jsmath::cos(phi), sq[k][1] + rho * jsmath::sin(phi)]);
                while k < sq.len() - 1 {
                    let rho2 = rho_at(&g, k + 1);
                    if rho2 < 0.15 * r {
                        break; // zu eng für Schleifen
                    }
                    let phi2 = side_angle(&g, k + 1, rho2);
                    let mut dphi = phi2 - phi;
                    while dphi > pi {
                        dphi -= 2.0 * pi;
                    }
                    while dphi <= -pi {
                        dphi += 2.0 * pi;
                    }
                    for m in 1..=LOOP_PTS {
                        let u = m as f64 / LOOP_PTS as f64;
                        let (cx, cy) = (sq[k][0] + (sq[k + 1][0] - sq[k][0]) * u, sq[k][1] + (sq[k + 1][1] - sq[k][1]) * u);
                        let rr = rho + (rho2 - rho) * u;
                        let an = phi + (2.0 * pi + dphi) * u; // gegen den Uhrzeiger = Gleichlauf
                        let q = [cx + rr * jsmath::cos(an), cy + rr * jsmath::sin(an)];
                        pts.push(q);
                        g.stamp(q[0], q[1], r);
                    }
                    k += 1;
                    rho = rho2;
                    phi = phi2;
                    // vorausschauen: hinter dem Streifen der Schleife wieder normale Umschlingung?
                    let ahead = ((rho + r * 0.5) / h).ceil();
                    let look = if ahead.is_finite() && ahead >= 0.0 { (sq.len() - 1).min(k.saturating_add(ahead as usize)) } else { sq.len() - 1 };
                    if engage(&g, sq[look], Some(dir_at(&sq, look))) <= EMAX {
                        break;
                    }
                }
                if k == i - 1 {
                    k = i; // keine Schleife möglich (zu eng): ein gerader Schritt, damit es weitergeht
                }
                pts.push(sq[k]); // zurück auf die Mittellinie
                g.stamp(sq[k][0], sq[k][1], r);
                i = k + 1;
            }
            out.push(PocketPath { pts: simplify(pts, 0.002), closed: false, helix });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<P> {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    #[test]
    fn tool_too_big() {
        let (paths, too_big) = pocket_paths(&rect(0.0, 0.0, 4.0, 4.0), &[], 3.0, 1.0, "linear", "");
        assert!(too_big && paths.is_empty());
    }

    #[test]
    fn every_strategy_stays_a_tool_radius_from_the_wall() {
        let outer = rect(0.0, 0.0, 40.0, 30.0);
        let island = rect(15.0, 10.0, 25.0, 20.0);
        for strategy in ["linear", "spiral", "adaptive"] {
            let (paths, too_big) = pocket_paths(&outer, &[island.clone()], 2.0, 1.5, strategy, "");
            assert!(!too_big && paths.len() >= 2, "{strategy}");
            for p in &paths {
                for q in &p.pts {
                    assert!(q[0] >= 2.0 - 1e-6 && q[0] <= 38.0 + 1e-6 && q[1] >= 2.0 - 1e-6 && q[1] <= 28.0 + 1e-6, "{strategy}: {q:?} too near the wall");
                    // Abstand zur Insel (Rechteck 15…25 × 10…20): mindestens der Werkzeugradius (Eckbögen bis 0,02 mm näher)
                    let (dx, dy) = ((15.0 - q[0]).max(q[0] - 25.0).max(0.0), (10.0 - q[1]).max(q[1] - 20.0).max(0.0));
                    assert!((dx * dx + dy * dy).sqrt() >= 2.0 - 0.021, "{strategy}: {q:?} too near the island");
                }
            }
        }
    }

    #[test]
    fn direction_turns_the_loop_but_keeps_its_start() {
        let sq = rect(0.0, 0.0, 10.0, 10.0);
        assert_eq!(orient_loop(sq.clone(), true, ""), sq);
        assert_eq!(orient_loop(sq.clone(), true, "climb"), sq);
        assert_eq!(orient_loop(sq.clone(), true, "conventional"), vec![[0.0, 0.0], [0.0, 10.0], [10.0, 10.0], [10.0, 0.0]]);
        assert_eq!(orient_loop(sq.clone(), false, "climb")[1], [0.0, 10.0]);
    }

    // ---- Vergleich mit dem TypeScript: dieselben Fälle ----

    fn fixture(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures").join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }
    fn base64(s: &str) -> Vec<u8> {
        let val = |c: u8| match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            _ => 63,
        } as u32;
        let mut out = Vec::with_capacity(s.len() / 4 * 3);
        for q in s.as_bytes().chunks(4) {
            let pad = q.iter().filter(|&&c| c == b'=').count();
            let n = q.iter().fold(0u32, |a, &c| (a << 6) | if c == b'=' { 0 } else { val(c) });
            out.extend_from_slice(&n.to_be_bytes()[1..4 - pad]);
        }
        out
    }
    fn pts(v: &Value) -> Vec<P> {
        v.as_array().unwrap().iter().map(|p| [p[0].as_f64().unwrap(), p[1].as_f64().unwrap()]).collect()
    }

    #[test]
    fn same_result_as_typescript() {
        let cases: Value = serde_json::from_str(&fixture("pocket-cases.json")).unwrap();
        let expected: Value = serde_json::from_str(&fixture("pocket-expected.json")).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 30);
        let (mut numbers, mut exact, mut worst, mut total) = (0usize, 0usize, 0.0f64, 0usize);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let want = expected.get(name).unwrap_or_else(|| panic!("{name}: no expected result (run UPDATE_FIXTURES=1 npm test)"));
            let outer = pts(&c["outer"]);
            let islands: Vec<Vec<P>> = c["islands"].as_array().unwrap().iter().map(pts).collect();
            let (r, dir) = (c["r"].as_f64().unwrap(), c["dir"].as_str().unwrap_or(""));
            let (paths, too_big) = match c["strategy"].as_str().unwrap() {
                "wall" => (pocket_wall_paths(&outer, &islands, r, dir), false),
                strategy => pocket_paths(&outer, &islands, r, c["step"].as_f64().unwrap(), strategy, dir),
            };
            assert_eq!(too_big, want["tooBig"].as_bool().unwrap(), "{name}: too big");
            // je Bahn: Punktzahl, geschlossen (1/0), Helix (1/0)
            let shape: Vec<[u64; 3]> = serde_json::from_value(want["paths"].clone()).unwrap();
            assert_eq!(paths.iter().map(|p| [p.pts.len() as u64, p.closed as u64, p.helix.is_some() as u64]).collect::<Vec<_>>(), shape, "{name}: paths, their point counts, closed/open, helix");
            // Zahlen: je Bahn [Helix x, y, r] und dann x, y aller Punkte
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut flate2::read::ZlibDecoder::new(&base64(want["data"].as_str().unwrap())[..]), &mut bytes).unwrap();
            let mut wanted = bytes.chunks(8).map(|q| f64::from_le_bytes(q.try_into().unwrap()));
            for (pi, p) in paths.iter().enumerate() {
                for v in p.helix.iter().flatten().copied().chain(p.pts.iter().flat_map(|q| [q[0], q[1]])) {
                    let w = wanted.next().unwrap();
                    numbers += 1;
                    exact += (v.to_bits() == w.to_bits()) as usize;
                    worst = worst.max((v - w).abs());
                    assert!((v - w).abs() <= 1e-9, "{name}: path {pi}: {v} != {w}");
                }
            }
            total += paths.len();
        }
        println!("{} cases, {total} paths, {numbers} numbers: {exact} identical to the last bit, largest difference {worst:e} mm", cases.len());
    }
}
