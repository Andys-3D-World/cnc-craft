//! SCHNITT-REIHENFOLGE OPTIMIEREN (Zwilling von src/cutOrder.ts): kürzeste Leerfahrten zwischen den Konturen einer Ebene
//!
//!   1. Nächster Nachbar  2. 2-opt (mit Grenze für die Rechenmenge)  3. freie Startpunkte
//! Feste Regel: was in einer geschlossenen Kontur liegt, kommt vor ihr – sonst fällt das Teil heraus, bevor es fertig ist.
//!
//! Die Rechnung folgt dem TypeScript Schritt für Schritt, damit dieselben Konturen dieselbe Reihenfolge geben.
//! Geprüft mit denselben Fällen auf beiden Seiten: tests/fixtures/cutorder-cases.json und cutorder-expected.json
//! (tests/cutOrderRust.test.ts und die Tests unten).
//!
//! Noch nicht gerufen: der G-Code für Laser, Plasma und Fräse entsteht im Fenster (laserCam.ts, plasmaCam.ts, cam.ts)
//! und kann dort auf eine Antwort von hier nicht warten. Zieht dieser Teil um, ruft er `optimize` direkt.
#![allow(dead_code)]

use crate::gcodesim::{hypot2, mn, mx};
use std::collections::HashMap;

pub type Pt = [f64; 2];

#[derive(Clone, Debug, Default)]
pub struct Item {
    /// Einstieg (Einstich / erster Punkt)
    pub entry: Pt,
    /// wo der Kopf danach steht
    pub exit: Pt,
    /// Kontur (für „liegt in“ und als mögliche Startpunkte)
    pub pts: Vec<Pt>,
    /// geschlossen -> umschließt andere Konturen
    pub closed: bool,
    /// geschlossen und Start darf auf jeden Punkt der Kontur wandern
    pub free_start: bool,
    /// offene Linie darf auch rückwärts gefahren werden
    pub reversible: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Step {
    /// Index in der Eingabe-Liste
    pub index: usize,
    /// offene Linie rückwärts fahren
    pub reversed: bool,
    /// freier Start: Index des Startpunkts in pts (sonst 0)
    pub start: usize,
}

/// so viele Punkte je Kontur reichen für die grobe Auswahl beim nächsten Nachbarn
const SAMPLE: usize = 16;
const TOL: f64 = 1e-6;
/// ab so vielen Konturen sucht der nächste Nachbar über ein Raster
const GRID_FROM: usize = 1500;
/// Rechenschritte von 2-opt, die einer Millisekunde entsprechen (wie WORK_PER_MS in cutOrder.ts)
pub const WORK_PER_MS: f64 = 25_000.0;
/// Rechenmenge, wenn nichts angegeben ist (wie `timeMs = 150` im TypeScript)
pub const DEFAULT_TIME_MS: f64 = 150.0;

struct Work {
    used: f64,
    max: f64,
}

fn dist(a: Pt, b: Pt) -> f64 {
    hypot2(b[0] - a[0], b[1] - a[1])
}

/// Zustand, den entryOf/exitOf im TypeScript von außen lesen
struct State<'a> {
    items: &'a [Item],
    rev: Vec<bool>,
    start: Vec<usize>,
}

impl State<'_> {
    fn entry_of(&self, i: usize) -> Pt {
        let it = &self.items[i];
        if it.free_start {
            it.pts[self.start[i]]
        } else if self.rev[i] {
            it.exit
        } else {
            it.entry
        }
    }
    fn exit_of(&self, i: usize) -> Pt {
        let it = &self.items[i];
        if it.free_start {
            it.pts[self.start[i]]
        } else if self.rev[i] {
            it.entry
        } else {
            it.exit
        }
    }
    /// Ein- oder Ausstieg, wenn der Abschnitt umgedreht gefahren wird
    fn flipped(&self, i: usize, e: bool) -> Pt {
        let it = &self.items[i];
        if !it.reversible || it.free_start {
            return if e { self.entry_of(i) } else { self.exit_of(i) };
        }
        if e {
            self.exit_of(i)
        } else {
            self.entry_of(i)
        }
    }
}

fn identity(n: usize) -> Vec<Step> {
    (0..n).map(|i| Step { index: i, reversed: false, start: 0 }).collect()
}

/// Reihenfolge für die Konturen einer Ebene. `from` = wo der Kopf vorher steht.
/// `time_ms` begrenzt die Rechenmenge für 2-opt (WORK_PER_MS Schritte je Millisekunde); 0 = ohne 2-opt.
pub fn optimize(items: &[Item], from: Pt, time_ms: f64) -> Vec<Step> {
    let n = items.len();
    if n == 0 {
        return vec![];
    }
    // Ein freier Start braucht Punkte (im TypeScript wäre das ein Absturz – hier bleibt die Reihenfolge, wie sie ist)
    if items.iter().any(|it| it.free_start && it.pts.is_empty()) {
        return identity(n);
    }
    let mut work = Work { used: 0.0, max: time_ms * WORK_PER_MS };
    let preds = precedence(items);
    let mut st = State { items, rev: vec![false; n], start: vec![0; n] };

    // ---- 1. nächster Nachbar (nur Konturen, deren „Innenleben“ schon fertig ist) ----
    let mut left: Vec<usize> = preds.iter().map(|p| p.len()).collect();
    let mut succ: Vec<Vec<usize>> = vec![vec![]; n];
    for (b, p) in preds.iter().enumerate() {
        for &a in p {
            succ[a].push(b);
        }
    }
    let mut avail: Vec<usize> = (0..n).filter(|&i| left[i] == 0).collect();
    let mut order: Vec<usize> = Vec::with_capacity(n);
    let mut pos = from;
    // sehr viele Konturen: Suche über ein Raster, sonst wächst die Rechenzeit mit dem Quadrat der Anzahl
    let mut near = if n > GRID_FROM { Some(NearGrid::new(items)) } else { None };
    if let Some(g) = near.as_mut() {
        for &i in &avail {
            g.add(i);
        }
    }
    loop {
        let i = match near.as_mut() {
            Some(g) => {
                if g.live == 0 {
                    break;
                }
                match g.take(pos) {
                    Some(i) => i,
                    None => return identity(n),
                }
            }
            None => {
                if avail.is_empty() {
                    break;
                }
                let (mut best_k, mut best_d) = (0, f64::INFINITY);
                for (k, &a) in avail.iter().enumerate() {
                    let d = rough_dist(&items[a], pos);
                    if d < best_d {
                        best_d = d;
                        best_k = k;
                    }
                }
                avail.swap_remove(best_k)
            }
        };
        let it = &items[i];
        if it.free_start {
            st.start[i] = nearest_idx(&it.pts, pos);
        } else if it.reversible {
            st.rev[i] = dist(pos, it.exit) < dist(pos, it.entry) - TOL;
        }
        order.push(i);
        pos = st.exit_of(i);
        for &b in &succ[i] {
            left[b] -= 1;
            if left[b] == 0 {
                match near.as_mut() {
                    Some(g) => g.add(b),
                    None => avail.push(b),
                }
            }
        }
    }
    if order.len() < n {
        return identity(n); // (kann nicht passieren: keine Kreise)
    }

    // ---- 2. 2-opt + 3. Startpunkte, solange die Rechenmenge reicht ----
    for _ in 0..4 {
        let better = two_opt(&mut order, &preds, &mut st, from, &mut work);
        let moved = place_starts(&order, &mut st, from);
        if !better && !moved {
            break;
        }
        if work.used >= work.max {
            break;
        }
    }
    order.iter().map(|&i| Step { index: i, reversed: st.rev[i], start: st.start[i] }).collect()
}

/// Summe der Leerfahrten (gerade Linien) für eine Reihenfolge
pub fn travel_length(items: &[Item], steps: &[Step], from: Pt) -> f64 {
    let (mut pos, mut sum) = (from, 0.0);
    for s in steps {
        let it = &items[s.index];
        let e = if it.free_start { it.pts[s.start] } else if s.reversed { it.exit } else { it.entry };
        let x = if it.free_start { it.pts[s.start] } else if s.reversed { it.entry } else { it.exit };
        sum += dist(pos, e);
        pos = x;
    }
    sum
}

fn bbox(pts: &[Pt]) -> [f64; 4] {
    let inf = f64::INFINITY;
    let mut b = [inf, inf, -inf, -inf];
    for p in pts {
        b[0] = mn(b[0], p[0]);
        b[1] = mn(b[1], p[1]);
        b[2] = mx(b[2], p[0]);
        b[3] = mx(b[3], p[1]);
    }
    b
}

fn poly_area(pts: &[Pt]) -> f64 {
    let mut a = 0.0;
    let n = pts.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
        j = i;
    }
    a / 2.0
}

fn point_in_poly(px: f64, py: f64, poly: &[Pt]) -> bool {
    let mut inside = false;
    let n = poly.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (xi, yi, xj, yj) = (poly[i][0], poly[i][1], poly[j][0], poly[j][1]);
        if ((yi > py) != (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Liegt die Kontur a in b? Ein paar Punkte von a prüfen (einer kann genau auf dem Rand liegen)
fn any_inside(a: &[Pt], b: &[Pt]) -> bool {
    let step = (a.len() / 3).max(1);
    (0..a.len()).step_by(step).any(|i| point_in_poly(a[i][0], a[i][1], b))
}

/// Wer muss vor wem? preds[b] = alle Konturen, die in der geschlossenen Kontur b liegen.
/// „Liegt in“: Rahmen ganz innerhalb, kleinere Fläche und ein Punkt in der Kontur.
pub fn precedence(items: &[Item]) -> Vec<Vec<usize>> {
    let n = items.len();
    let boxes: Vec<[f64; 4]> = items.iter().map(|it| bbox(&it.pts)).collect();
    let area: Vec<f64> = items.iter().map(|it| if it.closed { poly_area(&it.pts).abs() } else { 0.0 }).collect();
    let mut preds: Vec<Vec<usize>> = vec![vec![]; n];
    // nach linker Kante sortiert: für jede Kontur kommen nur die in Frage, deren linke Kante innerhalb von ihr liegt
    let mut by_left: Vec<usize> = (0..n).collect();
    by_left.sort_by(|&p, &q| {
        let d = boxes[p][0] - boxes[q][0];
        if d < 0.0 {
            std::cmp::Ordering::Less
        } else if d > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    let lefts: Vec<f64> = by_left.iter().map(|&i| boxes[i][0]).collect();
    let first_from = |v: f64| {
        let (mut lo, mut hi) = (0usize, lefts.len());
        while lo < hi {
            let m = (lo + hi) >> 1;
            if lefts[m] < v {
                lo = m + 1;
            } else {
                hi = m;
            }
        }
        lo
    };
    for b in 0..n {
        if !items[b].closed || items[b].pts.len() < 3 {
            continue;
        }
        let bb = boxes[b];
        let mut k = first_from(bb[0] - TOL);
        while k < n && lefts[k] <= bb[2] + TOL {
            let a = by_left[k];
            k += 1;
            if a == b || !(area[a] < area[b] - TOL) {
                continue;
            }
            let ab = boxes[a];
            if ab[1] < bb[1] - TOL || ab[2] > bb[2] + TOL || ab[3] > bb[3] + TOL {
                continue;
            }
            if any_inside(&items[a].pts, &items[b].pts) {
                preds[b].push(a);
            }
        }
        preds[b].sort_unstable();
    }
    preds
}

/// 2-opt: Abschnitt i..j umdrehen, wenn die Leerfahrten kürzer werden. Offene Linien werden im umgedrehten
/// Abschnitt mit umgedreht, feste Einstiege bleiben. Verboten, wenn im Abschnitt eine Kontur und etwas darin
/// liegen (das Innere käme sonst nach der Kontur).
fn two_opt(order: &mut [usize], preds: &[Vec<usize>], st: &mut State, from: Pt, work: &mut Work) -> bool {
    let n = order.len();
    if n < 3 {
        return false;
    }
    let mut pos_of = vec![0usize; n];
    let mut f = vec![0.0f64; n];
    let mut r = vec![0.0f64; n];
    let mut max_pred = vec![-1i64; n];
    fn rebuild(order: &[usize], preds: &[Vec<usize>], st: &State, pos_of: &mut [usize], f: &mut [f64], r: &mut [f64], max_pred: &mut [i64], work: &mut Work) {
        let n = order.len();
        work.used += n as f64;
        for (k, &it) in order.iter().enumerate() {
            pos_of[it] = k;
        }
        for k in 0..n {
            let mut m = -1i64;
            for &p in &preds[order[k]] {
                if pos_of[p] as i64 > m {
                    m = pos_of[p] as i64;
                }
            }
            max_pred[k] = m;
            if k > 0 {
                f[k] = f[k - 1] + dist(st.exit_of(order[k - 1]), st.entry_of(order[k]));
                r[k] = r[k - 1] + dist(st.flipped(order[k], false), st.flipped(order[k - 1], true));
            }
        }
    }
    rebuild(order, preds, st, &mut pos_of, &mut f, &mut r, &mut max_pred, work);
    let (mut any, mut improved) = (false, true);
    while improved {
        improved = false;
        for i in 0..n - 1 {
            if work.used >= work.max {
                return any;
            }
            let before = if i > 0 { st.exit_of(order[i - 1]) } else { from };
            let old_in = dist(before, st.entry_of(order[i]));
            for j in i + 1..n {
                work.used += 1.0;
                if max_pred[j] >= i as i64 {
                    break; // ab hier läge eine Kontur samt Innerem im Abschnitt
                }
                let after = if j + 1 < n { Some(st.entry_of(order[j + 1])) } else { None };
                let old_d = old_in + (f[j] - f[i]) + after.map_or(0.0, |a| dist(st.exit_of(order[j]), a));
                let new_d = dist(before, st.flipped(order[j], true)) + (r[j] - r[i]) + after.map_or(0.0, |a| dist(st.flipped(order[i], false), a));
                if new_d < old_d - 1e-6 {
                    for &o in &order[i..=j] {
                        let it = &st.items[o];
                        if it.reversible && !it.free_start {
                            st.rev[o] = !st.rev[o];
                        }
                    }
                    order[i..=j].reverse();
                    rebuild(order, preds, st, &mut pos_of, &mut f, &mut r, &mut max_pred, work);
                    improved = true;
                    any = true;
                    break;
                }
            }
        }
    }
    any
}

/// Freie Startpunkte: der Punkt, der Anfahrt + Weiterfahrt am kürzesten macht
fn place_starts(order: &[usize], st: &mut State, from: Pt) -> bool {
    let mut moved = false;
    for k in 0..order.len() {
        let o = order[k];
        if !st.items[o].free_start {
            continue;
        }
        let a = if k > 0 { st.exit_of(order[k - 1]) } else { from };
        let b = if k + 1 < order.len() { Some(st.entry_of(order[k + 1])) } else { None };
        let (mut best, mut best_d) = (st.start[o], f64::INFINITY);
        for (i, &p) in st.items[o].pts.iter().enumerate() {
            let d = dist(a, p) + b.map_or(0.0, |b| dist(p, b));
            if d < best_d - TOL {
                best_d = d;
                best = i;
            }
        }
        if best != st.start[o] {
            st.start[o] = best;
            moved = true;
        }
    }
    moved
}

/// Punkte, an denen eine Kontur begonnen werden kann – dieselben, die rough_dist prüft
fn start_points(it: &Item) -> Vec<Pt> {
    if it.free_start {
        let step = (it.pts.len() / SAMPLE).max(1);
        return it.pts.iter().step_by(step).copied().collect();
    }
    if it.reversible {
        vec![it.entry, it.exit]
    } else {
        vec![it.entry]
    }
}

/// grober Abstand für die Auswahl beim nächsten Nachbarn
fn rough_dist(it: &Item, p: Pt) -> f64 {
    if it.free_start {
        let step = (it.pts.len() / SAMPLE).max(1);
        let mut d = f64::INFINITY;
        for q in it.pts.iter().step_by(step) {
            d = mn(d, dist(p, *q));
        }
        return d;
    }
    let d = dist(p, it.entry);
    if it.reversible {
        mn(d, dist(p, it.exit))
    } else {
        d
    }
}

fn nearest_idx(pts: &[Pt], p: Pt) -> usize {
    let (mut best, mut bd) = (0, f64::INFINITY);
    for (i, q) in pts.iter().enumerate() {
        let d = dist(p, *q);
        if d < bd {
            bd = d;
            best = i;
        }
    }
    best
}

/// Nächste verfügbare Kontur über ein Raster: gesucht wird ringförmig, bis kein näherer Treffer mehr möglich ist
struct NearGrid<'a> {
    items: &'a [Item],
    x0: f64,
    y0: f64,
    cell: f64,
    nx: f64,
    ny: f64,
    cells: HashMap<i64, Vec<usize>>,
    in_grid: Vec<bool>,
    live: usize,
}

impl<'a> NearGrid<'a> {
    fn new(items: &'a [Item]) -> Self {
        let inf = f64::INFINITY;
        let (mut x0, mut y0, mut x1, mut y1) = (inf, inf, -inf, -inf);
        for it in items {
            for p in start_points(it) {
                x0 = mn(x0, p[0]);
                y0 = mn(y0, p[1]);
                x1 = mx(x1, p[0]);
                y1 = mx(y1, p[1]);
            }
        }
        let cell = mx((mx(x1 - x0, 1e-6) * mx(y1 - y0, 1e-6) / items.len() as f64).sqrt(), mx(mx(x1 - x0, y1 - y0), 1e-6) / 2000.0);
        let nx = ((x1 - x0) / cell).floor() + 1.0;
        let ny = ((y1 - y0) / cell).floor() + 1.0;
        NearGrid { items, x0, y0, cell, nx, ny, cells: HashMap::new(), in_grid: vec![false; items.len()], live: 0 }
    }

    /// Schlüssel der Zelle wie im TypeScript (cy * nx + cx als Zahl); None = keine Zahl
    fn key(&self, cx: f64, cy: f64) -> Option<i64> {
        let k = cy * self.nx + cx;
        if k.is_finite() {
            Some(k as i64)
        } else {
            None
        }
    }

    fn add(&mut self, i: usize) {
        self.in_grid[i] = true;
        self.live += 1;
        for p in start_points(&self.items[i]) {
            if let Some(k) = self.key(((p[0] - self.x0) / self.cell).floor(), ((p[1] - self.y0) / self.cell).floor()) {
                self.cells.entry(k).or_default().push(i);
            }
        }
    }

    fn take(&mut self, pos: Pt) -> Option<usize> {
        let (px, py) = ((pos[0] - self.x0) / self.cell, (pos[1] - self.y0) / self.cell);
        let (cx, cy) = (px.floor(), py.floor());
        // außerhalb des Rasters liegt der erste Ring mit Zellen erst nach diesem Abstand
        let max_r = mx(mx((cx).abs(), (cx - self.nx).abs()), mx(cy.abs(), (cy - self.ny).abs())) + 1.0;
        let mut best: Option<usize> = None;
        let mut best_d = f64::INFINITY;
        if max_r.is_finite() {
            let mut r = 0.0f64;
            while r <= max_r {
                // Zellen in Ring r sind mindestens (r - 1) Zellen entfernt: danach kann nichts Näheres mehr kommen
                if best.is_some() && best_d < (r - 1.0) * self.cell {
                    break;
                }
                let mut y = cy - r;
                while y <= cy + r {
                    if !(y < 0.0 || y >= self.ny) {
                        let on_edge = y == cy - r || y == cy + r;
                        let step = if on_edge || r == 0.0 { 1.0 } else { 2.0 * r };
                        let mut x = cx - r;
                        while x <= cx + r {
                            if !(x < 0.0 || x >= self.nx) {
                                if let Some(list) = self.key(x, y).and_then(|k| self.cells.get_mut(&k)) {
                                    let in_grid = &self.in_grid;
                                    list.retain(|&i| in_grid[i]); // schon gefahren: aus der Liste nehmen
                                    for &i in list.iter() {
                                        let d = rough_dist(&self.items[i], pos);
                                        if d < best_d || (d == best_d && best.is_some_and(|b| i < b)) {
                                            best_d = d;
                                            best = Some(i);
                                        }
                                    }
                                }
                            }
                            x += step;
                        }
                    }
                    y += 1.0;
                }
                r += 1.0;
            }
        }
        let b = best?;
        self.in_grid[b] = false;
        self.live -= 1;
        Some(b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<Pt> {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }
    fn fixed(pts: Vec<Pt>) -> Item {
        Item { entry: pts[0], exit: pts[0], pts, closed: true, ..Default::default() }
    }
    fn free(pts: Vec<Pt>) -> Item {
        Item { entry: pts[0], exit: pts[0], pts, closed: true, free_start: true, ..Default::default() }
    }
    fn place(steps: &[Step]) -> Vec<usize> {
        let mut at = vec![0; steps.len()];
        for (k, s) in steps.iter().enumerate() {
            at[s.index] = k;
        }
        at
    }

    #[test]
    fn every_item_once_and_holes_first() {
        let mut items = vec![];
        for k in 0..6 {
            let x = k as f64 * 100.0;
            items.push(fixed(rect(x, 0.0, x + 80.0, 80.0)));
            items.push(fixed(rect(x + 20.0, 20.0, x + 40.0, 40.0)));
        }
        let steps = optimize(&items, [400.0, 0.0], DEFAULT_TIME_MS);
        let mut seen: Vec<usize> = steps.iter().map(|s| s.index).collect();
        seen.sort_unstable();
        assert_eq!(seen, (0..12).collect::<Vec<_>>());
        let at = place(&steps);
        for k in (0..12).step_by(2) {
            assert!(at[k + 1] < at[k], "hole before part");
        }
    }

    #[test]
    fn nested_inside_out() {
        let items = vec![fixed(rect(0.0, 0.0, 300.0, 300.0)), fixed(rect(50.0, 50.0, 250.0, 250.0)), fixed(rect(100.0, 100.0, 200.0, 200.0))];
        let order: Vec<usize> = optimize(&items, [0.0, 0.0], DEFAULT_TIME_MS).iter().map(|s| s.index).collect();
        assert_eq!(order, vec![2, 1, 0]);
        assert_eq!(precedence(&items), vec![vec![1, 2], vec![2], vec![]]);
    }

    #[test]
    fn open_line_direction_and_free_start() {
        let a = Item { entry: [100.0, 0.0], exit: [0.0, 0.0], pts: vec![[100.0, 0.0], [0.0, 0.0]], reversible: true, ..Default::default() };
        let s = optimize(&[a], [0.0, 0.0], DEFAULT_TIME_MS);
        assert!(s[0].reversed);
        let sq = rect(50.0, 50.0, 150.0, 150.0);
        assert_eq!(optimize(&[free(sq.clone())], [160.0, 160.0], DEFAULT_TIME_MS)[0].start, 2);
        assert_eq!(optimize(&[fixed(sq)], [160.0, 160.0], DEFAULT_TIME_MS)[0].start, 0);
    }

    #[test]
    fn two_opt_shortens_the_travel() {
        let mut s = 1u32;
        let mut rnd = || {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            s as f64 / 4294967296.0
        };
        let items: Vec<Item> = (0..60)
            .map(|_| {
                let (x, y) = (rnd() * 500.0, rnd() * 500.0);
                fixed(rect(x, y, x + 5.0, y + 5.0))
            })
            .collect();
        let nn = travel_length(&items, &optimize(&items, [0.0, 0.0], 0.0), [0.0, 0.0]);
        let full = travel_length(&items, &optimize(&items, [0.0, 0.0], 500.0), [0.0, 0.0]);
        let drawn = travel_length(&items, &identity(60), [0.0, 0.0]);
        assert!(full < nn && nn < drawn * 0.5, "{full} {nn} {drawn}");
    }

    #[test]
    fn same_limit_as_typescript() {
        // tests/cutOrderRust.test.ts prüft dieselbe Zahl in cutOrder.ts
        assert_eq!(WORK_PER_MS, 25_000.0);
        assert_eq!(DEFAULT_TIME_MS, 150.0);
        assert_eq!((SAMPLE, GRID_FROM, TOL), (16, 1500, 1e-6));
    }

    #[test]
    fn free_start_without_points_keeps_the_order() {
        let items = vec![Item { free_start: true, closed: true, ..Default::default() }, fixed(rect(0.0, 0.0, 1.0, 1.0))];
        assert_eq!(optimize(&items, [0.0, 0.0], DEFAULT_TIME_MS), identity(2));
    }

    // ---- Vergleich mit dem TypeScript: dieselben Fälle ----

    /// Zufall wie in tests/cutOrderRust.test.ts (xorshift, nur ganze Zahlen – in beiden Sprachen bitgleich)
    struct Rng(u32);
    impl Rng {
        fn next(&mut self) -> f64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 17;
            self.0 ^= self.0 << 5;
            self.0 as f64 / 4294967296.0
        }
    }
    /// Achteck-Richtungen (ohne Winkelfunktionen, damit beide Seiten dieselben Zahlen haben)
    const DIRS: [Pt; 8] = [[1.0, 0.0], [0.7, 0.7], [0.0, 1.0], [-0.7, 0.7], [-1.0, 0.0], [-0.7, -0.7], [0.0, -1.0], [0.7, -0.7]];

    fn poly(cx: f64, cy: f64, r: f64, level: usize) -> Vec<Pt> {
        let mut pts: Vec<Pt> = DIRS.iter().map(|d| [cx + r * d[0], cy + r * d[1]]).collect();
        for _ in 0..level {
            let mut out = Vec::with_capacity(pts.len() * 2);
            for i in 0..pts.len() {
                let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
                out.push(a);
                out.push([(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0]);
            }
            pts = out;
        }
        pts
    }

    /// Konturen aus der Beschreibung eines Falls – muss Zeile für Zeile makeItems() im TypeScript-Test entsprechen
    fn make_items(c: &Value) -> Vec<Item> {
        let pt = |v: &Value| -> Pt { [v[0].as_f64().unwrap(), v[1].as_f64().unwrap()] };
        if let Some(list) = c["items"].as_array() {
            return list
                .iter()
                .map(|v| Item {
                    entry: pt(&v["entry"]),
                    exit: pt(&v["exit"]),
                    pts: v["pts"].as_array().unwrap().iter().map(pt).collect(),
                    closed: v["closed"].as_bool().unwrap_or(false),
                    free_start: v["freeStart"].as_bool().unwrap_or(false),
                    reversible: v["reversible"].as_bool().unwrap_or(false),
                })
                .collect();
        }
        let g = &c["random"];
        let mut r = Rng(g["seed"].as_u64().unwrap() as u32);
        let (n, w, h) = (g["n"].as_u64().unwrap() as usize, g["w"].as_f64().unwrap(), g["h"].as_f64().unwrap());
        let kind = g["kind"].as_str().unwrap();
        let mut list: Vec<Item> = Vec::new();
        if kind == "nested" {
            // Rahmen ineinander, dazwischen kleine Teile
            let depth = g["depth"].as_u64().unwrap() as usize;
            for d in 0..depth {
                let m = d as f64 * 12.0;
                let pts = vec![[m, m], [w - m, m], [w - m, h - m], [m, h - m]];
                list.push(Item { entry: pts[0], exit: pts[0], pts, closed: true, ..Default::default() });
            }
        }
        if kind == "lattice" {
            // kurze Linien auf einem regelmäßigen Raster, 40 je Reihe: viele genau gleiche Abstände
            for i in 0..n {
                let at = (i * 37) % n; // nicht in Zeichen-Reihenfolge
                let a = [(at % 40) as f64 * 10.0, (at / 40) as f64 * 10.0];
                let b = [a[0] + 1.0, a[1]];
                list.push(Item { entry: a, exit: b, pts: vec![a, b], reversible: i % 3 == 0, ..Default::default() });
            }
        }
        while list.len() < n {
            let (k, x, y) = (r.next(), r.next() * w, r.next() * h);
            if kind == "lines" || k >= 0.55 {
                let a = [x, y];
                let b = [x + (r.next() - 0.5) * 60.0, y + (r.next() - 0.5) * 60.0];
                let mut pts = vec![a];
                if r.next() < 0.3 {
                    pts.push([(a[0] + b[0]) / 2.0 + 3.0, (a[1] + b[1]) / 2.0 - 2.0]);
                }
                pts.push(b);
                let reversible = r.next() < 0.7;
                list.push(Item { entry: a, exit: b, pts, reversible, ..Default::default() });
            } else if k < 0.3 {
                let rad = 3.0 + r.next() * 20.0;
                let level = (r.next() * 3.0) as usize;
                let pts = poly(x, y, rad, level);
                list.push(Item { entry: pts[0], exit: pts[0], pts, closed: true, free_start: true, ..Default::default() });
                if r.next() < 0.6 {
                    let hole = poly(x, y, rad * 0.3, 0);
                    let free_start = r.next() < 0.5;
                    list.push(Item { entry: hole[0], exit: hole[0], pts: hole, closed: true, free_start, ..Default::default() });
                }
            } else if k < 0.45 {
                // mit Anfahrbahn: Einstieg neben der Kontur, danach steht der Kopf am ersten Punkt
                let pts = poly(x, y, 3.0 + r.next() * 20.0, 1);
                let lead = [x + r.next(), y + r.next()];
                list.push(Item { entry: lead, exit: pts[0], pts, closed: true, ..Default::default() });
            } else {
                // mit Haltestegen: Einstieg und Ende an verschiedenen Punkten
                let pts = poly(x, y, 2.0 + r.next() * 10.0, 0);
                list.push(Item { entry: pts[0], exit: pts[4], pts, closed: true, ..Default::default() });
            }
        }
        list
    }

    fn fixture(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures").join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    #[test]
    fn same_order_as_typescript() {
        let cases: Value = serde_json::from_str(&fixture("cutorder-cases.json")).unwrap();
        let expected: Value = serde_json::from_str(&fixture("cutorder-expected.json")).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 30);
        let mut contours = 0;
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let want = expected.get(name).unwrap_or_else(|| panic!("{name}: no expected result (run UPDATE_FIXTURES=1 npm test)"));
            let items = make_items(c);
            // erst prüfen, dass beide Seiten dieselben Konturen gebaut haben
            assert_eq!(items.len() as u64, want["count"].as_u64().unwrap(), "{name}: number of contours");
            let sum: f64 = items.iter().fold(0.0, |s, it| s + it.pts.iter().fold(0.0, |q, p| q + (p[0] + 2.0 * p[1])) + it.entry[0] + it.exit[1]);
            // genaue Zahlen stehen als Text in der Datei (serde_json liest lange Zahlen sonst bis zu eine Stelle daneben)
            let exact = |key: &str| want[key].as_str().unwrap().parse::<f64>().unwrap();
            assert_eq!(sum, exact("inputSum"), "{name}: the contours differ from the TypeScript ones");
            let from: Pt = [c["from"][0].as_f64().unwrap(), c["from"][1].as_f64().unwrap()];
            let time_ms = c["timeMs"].as_f64().unwrap_or(DEFAULT_TIME_MS);
            let steps = optimize(&items, from, time_ms);
            let got: Vec<[u64; 3]> = steps.iter().map(|s| [s.index as u64, s.reversed as u64, s.start as u64]).collect();
            let wanted: Vec<[u64; 3]> = serde_json::from_value(want["steps"].clone()).unwrap();
            if got != wanted {
                let at = got.iter().zip(&wanted).position(|(a, b)| a != b).unwrap_or(got.len().min(wanted.len()));
                panic!("{name}: order differs from step {at} on: {:?} != {:?}", got.get(at), wanted.get(at));
            }
            let preds: Vec<Vec<usize>> = precedence(&items);
            let pairs: u64 = preds.iter().map(|p| p.len() as u64).sum();
            assert_eq!(pairs, want["insidePairs"].as_u64().unwrap(), "{name}: inside pairs");
            if let Some(p) = want["preds"].as_array() {
                let wanted: Vec<Vec<usize>> = p.iter().map(|l| serde_json::from_value(l.clone()).unwrap()).collect();
                assert_eq!(preds, wanted, "{name}: preds");
            }
            assert_eq!(travel_length(&items, &steps, from), exact("travel"), "{name}: travel length");
            contours += items.len();
        }
        println!("{} cases, {contours} contours: same order as TypeScript", cases.len());
    }
}
