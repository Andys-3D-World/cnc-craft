//! ISOLATIONSBAHNEN FÜR PLATINEN – Zwilling von `isolate` in `src/pcb/field.ts`.
//!
//! Alle Kupferflächen kommen als Abstandsfeld auf ein feines Raster (negativ = im Kupfer); die Mitte des Fräsers fährt
//! auf den Höhenlinien „Abstand = halbe Schnittbreite (+ weitere Durchgänge)“. Dazu: Kupferumrisse, Netze und die
//! Stellen, an denen zwei Netze enger beisammen liegen als die Schnittbreite.
//! Wie im Fenster: gerechnet wird mit f64, das Raster ist ein Float32Array (hier Vec<f32>, gespeichert wird gerundet).
//! Die Reihenfolge der Linien folgt den JavaScript-Maps (Einfüge-Reihenfolge), damit die Bahnen in derselben Folge kommen.
//! Gemeinsame Fälle: `tests/fixtures/pcbiso-cases.json.gz` (festgehalten von `tests/pcbIsoRust.test.ts`).

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath::js_round;
use crate::polyoffset::simplify_polygon;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

type Pt2 = [f64; 2];

#[derive(Deserialize, Clone, Debug)]
pub struct Part {
    pub on: bool,
    pub c: Option<[f64; 3]>,
    pub p: Option<Vec<Pt2>>,
}
#[derive(Deserialize, Clone, Debug)]
pub struct GObj {
    pub k: String,
    pub dark: bool,
    pub a: Option<Pt2>,
    pub b: Option<Pt2>,
    pub r: Option<f64>,
    pub p: Option<Vec<Pt2>>,
    pub parts: Option<Vec<Part>>,
}
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct BoxR {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}
#[derive(Deserialize, Clone, Debug)]
pub struct IsoJob {
    pub objs: Vec<GObj>,
    #[serde(rename = "box")]
    pub bx: BoxR,
    pub width: f64,
    pub passes: f64,
    pub overlap: f64,
    pub step: Option<f64>,
}
#[derive(Serialize, Clone, Copy, Debug)]
pub struct P {
    pub x: f64,
    pub y: f64,
}
#[derive(Serialize, Debug)]
pub struct IsoLine {
    pub pts: Vec<P>,
    pub closed: bool,
    pub pass: usize,
}
#[derive(Serialize, Debug, Clone, Copy)]
pub struct Bridge {
    pub x: f64,
    pub y: f64,
    pub gap: f64,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IsoResult {
    pub copper: Vec<Vec<P>>,
    pub lines: Vec<IsoLine>,
    pub bridges: Vec<Bridge>,
    pub nets: usize,
    pub h: f64,
    /// Infinity, wenn keine Engstelle (JSON: null)
    pub min_gap: f64,
}

const MAX_NODES: f64 = 9_000_000.0;

#[derive(Clone)]
struct Grid {
    x0: f64,
    y0: f64,
    h: f64,
    nx: usize,
    ny: usize,
    f: Vec<f32>,
    cap: f64,
}

pub fn grid_step(w: f64, hgt: f64, want: f64) -> f64 {
    mx(want, ((w * hgt) / MAX_NODES).sqrt())
}

fn make_grid(x0: f64, y0: f64, x1: f64, y1: f64, h: f64, cap: f64) -> Grid {
    let nx = mx(3.0, ((x1 - x0) / h).ceil() + 1.0) as usize;
    let ny = mx(3.0, ((y1 - y0) / h).ceil() + 1.0) as usize;
    Grid { x0, y0, h, nx, ny, f: vec![cap as f32; nx * ny], cap }
}

/// Abstand zu einer Strecke in alle Punkte eintragen, die näher als R sind: put(Index, Abstand²)
fn splat(g: &Grid, ax: f64, ay: f64, bx: f64, by: f64, rr: f64, put: &mut dyn FnMut(usize, f64)) {
    let (x0, y0, h, nx, ny) = (g.x0, g.y0, g.h, g.nx as f64, g.ny as f64);
    let (dx, dy) = (bx - ax, by - ay);
    let l2 = dx * dx + dy * dy;
    let r2 = rr * rr;
    let j0 = mx(0.0, ((mn(ay, by) - rr - y0) / h).ceil());
    let j1 = mn(ny - 1.0, ((mx(ay, by) + rr - y0) / h).floor());
    let mut j = j0;
    while j <= j1 {
        let y = y0 + j * h;
        let (mut t0, mut t1) = (0.0, 1.0);
        if dy.abs() > 1e-12 {
            let (a, b) = ((y - rr - ay) / dy, (y + rr - ay) / dy);
            t0 = mx(0.0, mn(a, b));
            t1 = mn(1.0, mx(a, b));
            if t0 > t1 {
                j += 1.0;
                continue;
            }
        }
        let (xa, xb) = (ax + dx * t0, ax + dx * t1);
        let i0 = mx(0.0, ((mn(xa, xb) - rr - x0) / h).ceil());
        let i1 = mn(nx - 1.0, ((mx(xa, xb) + rr - x0) / h).floor());
        let mut i = i0;
        while i <= i1 {
            let x = x0 + i * h;
            let mut t = if l2 > 0.0 { ((x - ax) * dx + (y - ay) * dy) / l2 } else { 0.0 };
            t = if t < 0.0 {
                0.0
            } else if t > 1.0 {
                1.0
            } else {
                t
            };
            let (ex, ey) = (x - ax - t * dx, y - ay - t * dy);
            let d2 = ex * ex + ey * ey;
            if d2 < r2 {
                put((j * nx + i) as usize, d2);
            }
            i += 1.0;
        }
        j += 1.0;
    }
}

/// Teil-Raster auf denselben Punkten
fn sub(g: &Grid, x0: f64, y0: f64, x1: f64, y1: f64) -> Option<Grid> {
    let i0 = mx(0.0, ((x0 - g.x0) / g.h).floor());
    let j0 = mx(0.0, ((y0 - g.y0) / g.h).floor());
    let i1 = mn(g.nx as f64 - 1.0, ((x1 - g.x0) / g.h).ceil());
    let j1 = mn(g.ny as f64 - 1.0, ((y1 - g.y0) / g.h).ceil());
    if i1 < i0 || j1 < j0 || i1.is_nan() || j1.is_nan() {
        return None;
    }
    let (nx, ny) = ((i1 - i0 + 1.0) as usize, (j1 - j0 + 1.0) as usize);
    Some(Grid { x0: g.x0 + i0 * g.h, y0: g.y0 + j0 * g.h, h: g.h, nx, ny, f: vec![g.cap as f32; nx * ny], cap: g.cap })
}

fn each(g: &Grid, s: &Grid, put: &mut dyn FnMut(usize, f64)) {
    let i0 = js_round((s.x0 - g.x0) / g.h) as usize;
    let j0 = js_round((s.y0 - g.y0) / g.h) as usize;
    for j in 0..s.ny {
        let (mut k, mut q) = ((j + j0) * g.nx + i0, j * s.nx);
        for _ in 0..s.nx {
            put(k, s.f[q] as f64);
            k += 1;
            q += 1;
        }
    }
}

/// Ausschnitt mit dem Abstand zu einem Vieleck (innen negativ)
fn poly_field(g: &Grid, pts: &[Pt2]) -> Option<Grid> {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in pts {
        x0 = mn(x0, p[0]);
        y0 = mn(y0, p[1]);
        x1 = mx(x1, p[0]);
        y1 = mx(y1, p[1]);
    }
    let mut s = sub(g, x0 - g.cap, y0 - g.cap, x1 + g.cap, y1 + g.cap)?;
    let n = pts.len();
    for k in 0..n {
        let (a, b) = (pts[k], pts[(k + 1) % n]);
        let mut sf = std::mem::take(&mut s.f);
        splat(&s, a[0], a[1], b[0], b[1], g.cap, &mut |q, d2| {
            let v = sf[q] as f64;
            if d2 < v * v {
                sf[q] = d2.sqrt() as f32;
            }
        });
        s.f = sf;
    }
    // innen: ungerade Zahl von Kanten links davon
    let mut xs: Vec<f64> = Vec::new();
    for j in 0..s.ny {
        let y = s.y0 + j as f64 * s.h;
        xs.clear();
        for k in 0..n {
            let (a, b) = (pts[k], pts[(k + 1) % n]);
            if (a[1] > y) != (b[1] > y) {
                xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
            }
        }
        if xs.len() < 2 {
            continue;
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mut k = 0;
        while k + 1 < xs.len() {
            let i0 = mx(0.0, ((xs[k] - s.x0) / s.h).ceil());
            let i1 = mn(s.nx as f64 - 1.0, ((xs[k + 1] - s.x0) / s.h).floor());
            let mut i = i0;
            while i <= i1 {
                let q = j * s.nx + i as usize;
                s.f[q] = -mx(1e-6, (s.f[q] as f64).abs()) as f32;
                i += 1.0;
            }
            k += 2;
        }
    }
    Some(s)
}

fn circle_field(g: &Grid, c: [f64; 3], put: &mut dyn FnMut(usize, f64)) {
    let rr = c[2] + g.cap;
    splat(g, c[0], c[1], c[0], c[1], rr, &mut |k, d2| put(k, d2.sqrt() - c[2]));
}

fn part(g: &Grid, p: &Part, put: &mut dyn FnMut(usize, f64)) {
    if let Some(c) = p.c {
        circle_field(g, c, put);
    } else if let Some(s) = poly_field(g, p.p.as_deref().unwrap_or(&[])) {
        each(g, &s, put);
    }
}

/// dunkel: kleinster Abstand gewinnt; hell (löschen): -d, wenn größer
fn put_into(f: &mut [f32], dark: bool, k: usize, d: f64) {
    let v = f[k] as f64;
    if dark {
        if d < v {
            f[k] = d as f32;
        }
    } else if -d > v {
        f[k] = (-d) as f32;
    }
}

/// Flächen in Zeichen-Reihenfolge eintragen. Rückgabe: wurde irgendwo etwas gelöscht?
fn add_objects(g: &mut Grid, objs: &[GObj]) -> bool {
    let mut cleared = false;
    for o in objs {
        if !o.dark {
            cleared = true;
        }
        let dark = o.dark;
        let mut f = std::mem::take(&mut g.f);
        match o.k.as_str() {
            "stroke" => {
                let (a, b, r) = (o.a.unwrap_or([0.0; 2]), o.b.unwrap_or([0.0; 2]), o.r.unwrap_or(0.0));
                splat(g, a[0], a[1], b[0], b[1], r + g.cap, &mut |k, d2| put_into(&mut f, dark, k, d2.sqrt() - r));
            }
            "poly" => {
                if let Some(s) = poly_field(g, o.p.as_deref().unwrap_or(&[])) {
                    each(g, &s, &mut |k, d| put_into(&mut f, dark, k, d));
                }
            }
            _ => {
                let parts = o.parts.as_deref().unwrap_or(&[]);
                if parts.iter().all(|p| p.on) {
                    for p in parts {
                        part(g, p, &mut |k, d| put_into(&mut f, dark, k, d));
                    }
                } else {
                    // Blende mit Aussparung: erst für sich zusammensetzen
                    cleared = true;
                    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
                    for p in parts.iter().filter(|p| p.on) {
                        let pts: Vec<[f64; 3]> = match p.c {
                            Some(c) => vec![c],
                            None => p.p.as_deref().unwrap_or(&[]).iter().map(|q| [q[0], q[1], 0.0]).collect(),
                        };
                        for [x, y, r] in pts {
                            x0 = mn(x0, x - r);
                            y0 = mn(y0, y - r);
                            x1 = mx(x1, x + r);
                            y1 = mx(y1, y + r);
                        }
                    }
                    if let Some(mut s) = sub(g, x0 - g.cap, y0 - g.cap, x1 + g.cap, y1 + g.cap) {
                        for p in parts {
                            let mut sf = std::mem::take(&mut s.f);
                            part(&s, p, &mut |k, d| put_into(&mut sf, p.on, k, d));
                            s.f = sf;
                        }
                        each(g, &s, &mut |k, d| put_into(&mut f, dark, k, d));
                    }
                }
            }
        }
        g.f = f;
    }
    cleared
}

/// Nach Löschungen stimmt das Vorzeichen, aber nicht jeder Abstand: neu messen – zum Umriss
fn redistance(g: &mut Grid) {
    let loops = contours(g, 0.0, 0.0);
    let mut d = vec![g.cap as f32; g.f.len()];
    for l in &loops {
        for i in 0..l.len() {
            let (a, b) = (l[i], l[(i + 1) % l.len()]);
            splat(g, a.x, a.y, b.x, b.y, g.cap, &mut |k, d2| {
                let v = d[k] as f64;
                if d2 < v * v {
                    d[k] = d2.sqrt() as f32;
                }
            });
        }
    }
    for k in 0..d.len() {
        g.f[k] = if g.f[k] < 0.0 { -d[k] } else { d[k] };
    }
}

/// Map mit Einfüge-Reihenfolge wie in JavaScript (set auf vorhandenen Schlüssel behält den Platz)
struct OrderedMap {
    keys: Vec<usize>,
    vals: HashMap<usize, (usize, usize)>, // Schlüssel -> (Platz, Wert)
    alive: Vec<bool>,
    first: usize,
}
impl OrderedMap {
    fn new() -> Self {
        Self { keys: vec![], vals: HashMap::new(), alive: vec![], first: 0 }
    }
    fn set(&mut self, k: usize, v: usize) {
        if let Some(e) = self.vals.get_mut(&k) {
            e.1 = v;
        } else {
            self.vals.insert(k, (self.keys.len(), v));
            self.keys.push(k);
            self.alive.push(true);
        }
    }
    fn get(&self, k: usize) -> Option<usize> {
        self.vals.get(&k).map(|e| e.1)
    }
    fn delete(&mut self, k: usize) {
        if let Some((pos, _)) = self.vals.remove(&k) {
            self.alive[pos] = false;
        }
    }
    fn first_key(&mut self) -> Option<usize> {
        while self.first < self.keys.len() && !self.alive[self.first] {
            self.first += 1;
        }
        self.keys.get(self.first).copied()
    }
}

/// Höhenlinie „Abstand = level“ als geschlossene Linien. tol = Vereinfachen (0 = nicht)
fn contours(g: &Grid, level: f64, tol: f64) -> Vec<Vec<P>> {
    let (nx, ny, h, x0, y0) = (g.nx, g.ny, g.h, g.x0, g.y0);
    let f = &g.f;
    let mut next = OrderedMap::new();
    let mut pos: HashMap<usize, P> = HashMap::new();
    let v = |i: usize, j: usize| -> f64 {
        let fv = f[j * nx + i] as f64;
        (if i == 0 || j == 0 || i >= nx - 1 || j >= ny - 1 { mx(fv, level + h * 0.5) } else { fv }) - level
    };
    let mut edge = |i: usize, j: usize, vert: bool, a: f64, b: f64| -> usize {
        let id = 2 * (j * nx + i) + usize::from(vert);
        pos.entry(id).or_insert_with(|| {
            let t = a / (a - b);
            if vert {
                P { x: x0 + i as f64 * h, y: y0 + (j as f64 + t) * h }
            } else {
                P { x: x0 + (i as f64 + t) * h, y: y0 + j as f64 * h }
            }
        });
        id
    };
    for j in 0..ny.saturating_sub(1) {
        for i in 0..nx.saturating_sub(1) {
            let k = j * nx + i;
            let lt = |q: usize| (f[q] as f64) < level;
            let (q, r, s, u) = (lt(k), lt(k + 1), lt(k + nx + 1), lt(k + nx));
            if q == r && r == s && s == u && i > 0 && j > 0 && i + 2 < nx && j + 2 < ny {
                continue;
            }
            let (a, b, c, d) = (v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1));
            let code = (if a < 0.0 { 1 } else { 0 }) | (if b < 0.0 { 2 } else { 0 }) | (if c < 0.0 { 4 } else { 0 }) | (if d < 0.0 { 8 } else { 0 });
            if code == 0 || code == 15 {
                continue;
            }
            macro_rules! bt {
                () => {
                    edge(i, j, false, a, b)
                };
            }
            macro_rules! rt {
                () => {
                    edge(i + 1, j, true, b, c)
                };
            }
            macro_rules! tp {
                () => {
                    edge(i, j + 1, false, d, c)
                };
            }
            macro_rules! lf {
                () => {
                    edge(i, j, true, a, d)
                };
            }
            // seg(from, to): Argumente wie im TypeScript von links nach rechts
            macro_rules! seg {
                ($x:expr, $y:expr) => {{
                    let p = $x;
                    let q = $y;
                    next.set(p, q);
                }};
            }
            match code {
                1 => seg!(bt!(), lf!()),
                2 => seg!(rt!(), bt!()),
                3 => seg!(rt!(), lf!()),
                4 => seg!(tp!(), rt!()),
                6 => seg!(tp!(), bt!()),
                7 => seg!(tp!(), lf!()),
                8 => seg!(lf!(), tp!()),
                9 => seg!(bt!(), tp!()),
                11 => seg!(rt!(), tp!()),
                12 => seg!(lf!(), rt!()),
                13 => seg!(bt!(), rt!()),
                14 => seg!(lf!(), bt!()),
                5 => {
                    if a + b + c + d < 0.0 {
                        seg!(bt!(), rt!());
                        seg!(tp!(), lf!());
                    } else {
                        seg!(bt!(), lf!());
                        seg!(tp!(), rt!());
                    }
                }
                _ => {
                    // 10
                    if a + b + c + d < 0.0 {
                        seg!(lf!(), bt!());
                        seg!(rt!(), tp!());
                    } else {
                        seg!(rt!(), bt!());
                        seg!(lf!(), tp!());
                    }
                }
            }
        }
    }
    let mut out = vec![];
    while let Some(start) = next.first_key() {
        let mut lp: Vec<P> = vec![];
        let mut cur = Some(start);
        while let Some(c) = cur {
            let Some(nv) = next.get(c) else { break };
            lp.push(pos[&c]);
            next.delete(c);
            cur = Some(nv);
            if nv == start {
                break;
            }
        }
        let n = lp.len();
        let clean: Vec<P> = (0..n)
            .filter(|&i| {
                let (p, o) = (lp[i], lp[(i + n - 1) % n]);
                hypot2(p.x - o.x, p.y - o.y) > 1e-7
            })
            .map(|i| lp[i])
            .collect();
        if clean.len() >= 3 {
            if tol > 0.0 {
                let arr: Vec<[f64; 2]> = clean.iter().map(|p| [p.x, p.y]).collect();
                out.push(simplify_polygon(&arr, tol).into_iter().map(|q| P { x: q[0], y: q[1] }).collect());
            } else {
                out.push(clean);
            }
        }
    }
    out
}

/// Zusammenhängende Kupferflächen nummerieren (1…n), 0 = kein Kupfer
fn nets(g: &Grid) -> (Vec<i32>, usize) {
    let (nx, f) = (g.nx, &g.f);
    let len = f.len();
    let mut label = vec![0i32; len];
    let mut n = 0;
    let mut stack: Vec<usize> = vec![];
    for k in 0..len {
        if label[k] != 0 || f[k] > 0.0 {
            continue;
        }
        n += 1;
        label[k] = n;
        stack.push(k);
        while let Some(q) = stack.pop() {
            let i = q % nx;
            let cand = [if i > 0 { q as i64 - 1 } else { -1 }, if i < nx - 1 { q as i64 + 1 } else { -1 }, q as i64 - nx as i64, (q + nx) as i64];
            for r in cand {
                if r >= 0 && (r as usize) < len && label[r as usize] == 0 && f[r as usize] <= 0.0 {
                    label[r as usize] = n;
                    stack.push(r as usize);
                }
            }
        }
    }
    (label, n as usize)
}

/// Stellen, an denen zwei Netze enger als 2·d beisammen liegen
fn bridges(g: &Grid, d: f64) -> (Vec<Bridge>, usize) {
    let (nx, f) = (g.nx, &g.f);
    let len = f.len();
    let (mut own, n) = nets(g);
    let bn = mx(1.0, (d / g.h * 4.0).ceil()) as usize + 1;
    let mut buckets: Vec<Vec<usize>> = vec![vec![]; bn];
    let bucket = |k: usize, min: usize| -> usize {
        let v = (mx(0.0, f[k] as f64) / d * (bn - 1) as f64).floor();
        mx(min as f64, mn((bn - 1) as f64, v)) as usize
    };
    let nb = |q: usize| -> [i64; 4] {
        let i = q % nx;
        [if i > 0 { q as i64 - 1 } else { -1 }, if i < nx - 1 { q as i64 + 1 } else { -1 }, q as i64 - nx as i64, (q + nx) as i64]
    };
    // Paare in Einfüge-Reihenfolge (Map im TypeScript)
    let mut order: Vec<(i32, i32)> = vec![];
    let mut pairs: HashMap<(i32, i32), (f64, usize)> = HashMap::new();
    for k in 0..len {
        if own[k] != 0 && nb(k).iter().any(|&r| r >= 0 && (r as usize) < len && own[r as usize] == 0) {
            buckets[0].push(k);
        }
    }
    for b in 0..bn {
        let mut q = 0;
        while q < buckets[b].len() {
            let k = buckets[b][q];
            for r in nb(k) {
                if r < 0 || r as usize >= len {
                    continue;
                }
                let r = r as usize;
                if own[r] == 0 {
                    if (f[r] as f64) < d {
                        own[r] = own[k];
                        let t = bucket(r, b);
                        buckets[t].push(r);
                    }
                } else if own[r] != own[k] {
                    let key = if own[k] < own[r] { (own[k], own[r]) } else { (own[r], own[k]) };
                    let gap = mx(0.0, f[k] as f64) + mx(0.0, f[r] as f64) + g.h;
                    match pairs.get_mut(&key) {
                        Some(old) => {
                            if gap < old.0 {
                                *old = (gap, k);
                            }
                        }
                        None => {
                            pairs.insert(key, (gap, k));
                            order.push(key);
                        }
                    }
                }
            }
            q += 1;
        }
    }
    let mut list: Vec<Bridge> = order
        .iter()
        .map(|key| {
            let (gap, k) = pairs[key];
            Bridge { x: g.x0 + (k % nx) as f64 * g.h, y: g.y0 + (k / nx) as f64 * g.h, gap }
        })
        .collect();
    list.sort_by(|a, b| a.gap.partial_cmp(&b.gap).unwrap_or(std::cmp::Ordering::Equal));
    (list, n)
}

/// Abstände der Fräser-Mitte je Durchgang
fn pass_levels(width: f64, passes: f64, overlap: f64) -> Vec<f64> {
    let step = width * (1.0 - mx(0.0, mn(0.9, overlap)));
    let n = mx(1.0, mn(40.0, js_round(passes))) as usize;
    (0..n).map(|k| width / 2.0 + k as f64 * step).collect()
}

/// Stücke einer geschlossenen Linie im Rechteck
fn clip_loop(l: &[P], b: &BoxR) -> Vec<(Vec<P>, bool)> {
    let inside = |p: &P| p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
    if l.iter().all(inside) {
        return vec![(l.to_vec(), true)];
    }
    let first = l.iter().position(|p| !inside(p)).unwrap();
    let r: Vec<P> = l[first..].iter().chain(&l[..=first]).copied().collect();
    let mut out = vec![];
    let mut cur: Vec<P> = vec![];
    for i in 0..r.len() - 1 {
        let (a, c) = (r[i], r[i + 1]);
        let (dx, dy) = (c.x - a.x, c.y - a.y);
        let (mut t0, mut t1, mut ok) = (0.0, 1.0, true);
        for (p, q) in [(-dx, a.x - b.x0), (dx, b.x1 - a.x), (-dy, a.y - b.y0), (dy, b.y1 - a.y)] {
            if p.abs() < 1e-12 {
                if q < 0.0 {
                    ok = false;
                }
                continue;
            }
            let t = q / p;
            if p < 0.0 {
                t0 = mx(t0, t);
            } else {
                t1 = mn(t1, t);
            }
        }
        if !ok || t0 >= t1 {
            if cur.len() > 1 {
                out.push((std::mem::take(&mut cur), false));
            }
            cur.clear();
            continue;
        }
        if cur.is_empty() || t0 > 0.0 {
            if cur.len() > 1 {
                out.push((std::mem::take(&mut cur), false));
            }
            cur = vec![P { x: a.x + dx * t0, y: a.y + dy * t0 }];
        }
        cur.push(P { x: a.x + dx * t1, y: a.y + dy * t1 });
        if t1 < 1.0 {
            if cur.len() > 1 {
                out.push((std::mem::take(&mut cur), false));
            }
            cur.clear();
        }
    }
    if cur.len() > 1 {
        out.push((cur, false));
    }
    out
}

pub fn isolate(job: &IsoJob) -> IsoResult {
    let lv = pass_levels(job.width, job.passes, job.overlap);
    let last = lv[lv.len() - 1];
    let b = job.bx;
    let want = job.step.unwrap_or_else(|| mx(0.02, mn(0.04, job.width / 4.0)));
    let h0 = grid_step(b.x1 - b.x0 + 2.0 * last, b.y1 - b.y0 + 2.0 * last, want);
    let cap = mx(last, job.width) + 3.0 * h0;
    let m = cap + 2.0 * h0;
    let h = grid_step(b.x1 - b.x0 + 2.0 * m, b.y1 - b.y0 + 2.0 * m, h0);
    let mut g = make_grid(b.x0 - m, b.y0 - m, b.x1 + m, b.y1 + m, h, cap);
    if add_objects(&mut g, &job.objs) {
        redistance(&mut g);
    }
    let copper = contours(&g, 0.0, g.h * 0.06);
    let mut lines = vec![];
    let keep = BoxR { x0: b.x0 - job.width, y0: b.y0 - job.width, x1: b.x1 + job.width, y1: b.y1 + job.width };
    for (pass, &d) in lv.iter().enumerate() {
        for l in contours(&g, d, g.h * 0.06) {
            if pass == 0 {
                lines.push(IsoLine { pts: l, closed: true, pass });
            } else {
                for (pts, closed) in clip_loop(&l, &keep) {
                    lines.push(IsoLine { pts, closed, pass });
                }
            }
        }
    }
    let (br, nets_n) = bridges(&g, lv[0]);
    let list: Vec<Bridge> = br.into_iter().filter(|x| x.gap < job.width - h * 0.25).collect();
    let min_gap = list.first().map_or(f64::INFINITY, |x| x.gap);
    IsoResult { copper, lines, bridges: list, nets: nets_n, h, min_gap }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Read;

    #[test]
    fn one_round_pad_gives_one_ring() {
        let job = IsoJob { objs: vec![GObj { k: "flash".into(), dark: true, a: None, b: None, r: None, p: None, parts: Some(vec![Part { on: true, c: Some([5.0, 5.0, 1.0]), p: None }]) }], bx: BoxR { x0: 3.0, y0: 3.0, x1: 7.0, y1: 7.0 }, width: 0.2, passes: 1.0, overlap: 0.5, step: None };
        let r = isolate(&job);
        assert_eq!((r.copper.len(), r.lines.len(), r.nets), (1, 1, 1));
        let p = r.lines[0].pts[0];
        assert!((hypot2(p.x - 5.0, p.y - 5.0) - 1.1).abs() < 0.03, "{p:?}");
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
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("pcbiso-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let cases: Value = serde_json::from_str(&text).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 12, "only {} cases", cases.len());
        let mut lines = 0;
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let job: IsoJob = serde_json::from_value(c["job"].clone()).unwrap();
            let got = serde_json::to_value(isolate(&job)).unwrap();
            same(&c["want"], &got, name);
            lines += got["lines"].as_array().unwrap().len();
        }
        println!("{} boards, {lines} isolation lines the same as field.ts", cases.len());
    }
}
