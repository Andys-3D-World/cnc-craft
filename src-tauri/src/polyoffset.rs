//! KONTUR-VERSATZ (Zwilling von src/polyOffset.ts): Werkzeugradius-Korrektur für geschlossene Konturen
//!
//!   1. Jede Kante um d verschieben; an Ecken mit Lücke einen Bogen einfügen.
//!   2. Alle Selbst-Kreuzungen suchen und die Linie dort aufteilen.
//!   3. Nur die Stücke behalten, die überall mindestens |d| von der Originalkontur entfernt sind.
//! Dazu: Fläche, Punkt-in-Kontur und das Vereinfachen von Konturen und Linien (Douglas-Peucker).
//!
//! Die Rechnung folgt dem TypeScript Schritt für Schritt. Geprüft mit denselben Fällen auf beiden Seiten:
//! tests/fixtures/polyoffset-cases.json und polyoffset-expected.json (tests/polyOffsetRust.test.ts und die Tests unten).
//! Die Bögen brauchen Sinus und Kosinus (jsmath.rs) – dort kann die letzte Stelle anders sein als im Fenster,
//! darum wird mit einer kleinen Toleranz verglichen (gleiche Konturen, gleiche Punktzahl, Lage auf 1e-9 mm).
//!
//! Noch nicht gerufen: der Fräs-G-Code (cam.ts, pocket.ts, vcarve.ts) entsteht im Fenster und kann dort nicht auf
//! eine Antwort von hier warten. Zieht dieser Teil um, ruft er die Funktionen direkt.
#![allow(dead_code)]

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath;
use std::collections::HashMap;

pub type P = [f64; 2];

pub fn polygon_area(pts: &[P]) -> f64 {
    let mut a = 0.0;
    let n = pts.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
        j = i;
    }
    a / 2.0
}

pub fn point_in_poly(px: f64, py: f64, poly: &[P]) -> bool {
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

/// `polygon`: geschlossene Kontur in mm (letzter Punkt != erster Punkt). `d` > 0 nach außen, < 0 nach innen.
/// `arc_tol`: größte Abweichung der Bögen in mm (im TypeScript 0,01, wenn nichts angegeben ist).
/// Antwort: Konturen, gegen den Uhrzeigersinn; keine, wenn das Werkzeug zu dick für die Form ist.
pub fn offset_polygon(polygon: &[P], d: f64, arc_tol: f64) -> Vec<Vec<P>> {
    let res = offset_once(polygon, d, arc_tol);
    if !res.is_empty() || d.abs() < 1e-9 {
        return res;
    }
    // Sonderfall: liegt ein Kreuzungspunkt genau auf einem Streckenende, wird er übersehen und die Kontur
    // schließt sich nicht. Mit winzig anderem Abstand nochmal.
    for f in [1.0 + 1e-6, 1.0 - 1e-6] {
        let again = offset_once(polygon, d * f, arc_tol);
        if !again.is_empty() {
            return again;
        }
    }
    res
}

fn offset_once(polygon: &[P], d: f64, arc_tol: f64) -> Vec<Vec<P>> {
    let mut pts = clean_polygon(polygon);
    if pts.len() < 3 {
        return vec![];
    }
    if polygon_area(&pts) < 0.0 {
        pts.reverse();
    }
    if d.abs() < 1e-9 {
        return vec![pts];
    }

    let (raw, arc) = build_raw_offset(&pts, d, arc_tol);
    let pieces = split_at_intersections(&raw, &arc);

    // Nur Stücke behalten, die weit genug weg liegen. Eingefügte Bögen sind nur Sehnen (bis arc_tol zu nah),
    // verschobene Kanten liegen genau auf |d| – für sie gilt die enge Grenze
    let arc_min = d.abs() - (arc_tol * 2.0 + 1e-6);
    let edge_min = d.abs() * (1.0 - 1e-9) - 1e-9;
    let grid = SegmentGrid::new(&pts);
    let kept: Vec<Piece> = pieces
        .into_iter()
        .filter(|pc| {
            let (mx_, my_) = ((pc.a[0] + pc.b[0]) / 2.0, (pc.a[1] + pc.b[1]) / 2.0);
            !grid.nearer_than(mx_, my_, if pc.arc { arc_min } else { edge_min })
        })
        .collect();

    // Eine fertige Kontur liegt komplett auf einer Seite -> ein Test pro Kontur reicht
    let mut loops: Vec<Vec<P>> = chain_pieces(&kept, mx(arc_tol * 4.0, d.abs() * 0.05))
        .into_iter()
        .filter(|l| {
            if l.len() < 3 || polygon_area(l) <= 1e-6 {
                return false;
            }
            let (mx_, my_) = ((l[0][0] + l[1][0]) / 2.0, (l[0][1] + l[1][1]) / 2.0);
            let inside = point_in_poly(mx_, my_, &pts);
            if d > 0.0 {
                !inside
            } else {
                inside
            }
        })
        .collect();
    // Der Versatz EINER Kontur liefert nie ineinanderliegende Konturen – liegt eine in einer anderen,
    // ist sie eine (fast) doppelte Kopie und fliegt raus
    loops.sort_by(|a, b| {
        let v = polygon_area(b) - polygon_area(a);
        if v < 0.0 {
            std::cmp::Ordering::Less
        } else if v > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    let centre = |l: &[P]| -> P {
        let n = l.len() as f64;
        [l.iter().fold(0.0, |s, p| s + p[0]) / n, l.iter().fold(0.0, |s, p| s + p[1]) / n]
    };
    let mut out: Vec<Vec<P>> = Vec::with_capacity(loops.len());
    for i in 0..loops.len() {
        let c = centre(&loops[i]);
        if !loops[..i].iter().any(|o| point_in_poly(c[0], c[1], o)) {
            out.push(loops[i].clone());
        }
    }
    out
}

/// Douglas-Peucker auf einem Abschnitt-Stapel (gemeinsamer Teil von simplify_polygon und simplify_polyline)
fn peucker(pts: &[P], keep: &mut [bool], mut stack: Vec<(usize, usize)>, tol: f64) {
    let n = pts.len();
    let tol2 = tol * tol;
    while let Some((s, e)) = stack.pop() {
        let (a, b) = (pts[s], pts[e % n]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        let (mut max_d, mut idx) = (0.0f64, None);
        for i in s + 1..e {
            let p = pts[i];
            let mut t = if l2 > 0.0 { ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 } else { 0.0 };
            t = if t < 0.0 {
                0.0
            } else if t > 1.0 {
                1.0
            } else {
                t
            };
            let (ex, ey) = (p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
            let d2 = ex * ex + ey * ey;
            if d2 > max_d {
                max_d = d2;
                idx = Some(i);
            }
        }
        if let Some(i) = idx {
            if max_d > tol2 {
                keep[i] = true;
                stack.push((s, i));
                stack.push((i, e));
            }
        }
    }
}

/// Geschlossene Kontur vereinfachen: Punkte, die weniger als tol von der Verbindungslinie ihrer Nachbarn
/// abweichen, fallen weg. Antwort: die Nummern der Punkte, die bleiben.
pub fn simplify_polygon_idx(pts: &[P], tol: f64) -> Vec<usize> {
    let n = pts.len();
    if n < 8 {
        return (0..n).collect();
    }
    // am weitesten vom ersten Punkt entfernten Punkt teilen, beide Hälften vereinfachen
    let (mut far, mut far_d) = (0, -1.0f64);
    for i in 1..n {
        let dd = (pts[i][0] - pts[0][0]) * (pts[i][0] - pts[0][0]) + (pts[i][1] - pts[0][1]) * (pts[i][1] - pts[0][1]);
        if dd > far_d {
            far_d = dd;
            far = i;
        }
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[far] = true;
    peucker(pts, &mut keep, vec![(0, far), (far, n)], tol);
    let out: Vec<usize> = (0..n).filter(|&i| keep[i]).collect();
    if out.len() >= 3 {
        out
    } else {
        (0..n).collect()
    }
}

/// Offene Linie vereinfachen: Anfang und Ende bleiben, Abweichung höchstens tol. Antwort: Nummern der Punkte, die bleiben.
pub fn simplify_polyline_idx(pts: &[P], tol: f64) -> Vec<usize> {
    let n = pts.len();
    if n < 3 {
        return (0..n).collect();
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    peucker(pts, &mut keep, vec![(0, n - 1)], tol);
    (0..n).filter(|&i| keep[i]).collect()
}

pub fn simplify_polygon(pts: &[P], tol: f64) -> Vec<P> {
    simplify_polygon_idx(pts, tol).into_iter().map(|i| pts[i]).collect()
}
pub fn simplify_polyline(pts: &[P], tol: f64) -> Vec<P> {
    simplify_polyline_idx(pts, tol).into_iter().map(|i| pts[i]).collect()
}

// ---------------------------------------------------------------------

fn clean_polygon(input: &[P]) -> Vec<P> {
    let mut out: Vec<P> = Vec::with_capacity(input.len());
    for &p in input {
        match out.last() {
            Some(last) if !(hypot2(p[0] - last[0], p[1] - last[1]) > 1e-7) => {}
            _ => out.push(p),
        }
    }
    while out.len() > 1 && hypot2(out[0][0] - out[out.len() - 1][0], out[0][1] - out[out.len() - 1][1]) <= 1e-7 {
        out.pop();
    }
    out
}

/// raw: verschobener Linienzug; arc[k]: Strecke raw[k] → raw[k+1] gehört zu einem eingefügten Eckbogen
fn build_raw_offset(pts: &[P], d: f64, arc_tol: f64) -> (Vec<P>, Vec<bool>) {
    let n = pts.len();
    let pi = std::f64::consts::PI;
    // Normale nach außen (rechts der Fahrtrichtung bei gegen-Uhrzeigersinn-Kontur)
    let normals: Vec<P> = (0..n)
        .map(|i| {
            let (a, b) = (pts[i], pts[(i + 1) % n]);
            let len = hypot2(b[0] - a[0], b[1] - a[1]);
            [(b[1] - a[1]) / len, -(b[0] - a[0]) / len]
        })
        .collect();

    let r = d.abs();
    let max_step = if r > arc_tol { 2.0 * jsmath::acos(1.0 - arc_tol / r) } else { pi / 4.0 };

    let mut raw: Vec<P> = Vec::new();
    let mut arc: Vec<bool> = Vec::new();
    fn add(raw: &mut Vec<P>, arc: &mut Vec<bool>, q: P, is_arc: bool) {
        if let Some(last) = raw.last() {
            if hypot2(q[0] - last[0], q[1] - last[1]) <= 1e-7 {
                let k = arc.len() - 1;
                arc[k] = is_arc;
                return;
            }
        }
        raw.push(q);
        arc.push(is_arc);
    }
    for i in 0..n {
        let prev = (i + n - 1) % n;
        let p = pts[i];
        let (n0, n1) = (normals[prev], normals[i]);
        let v0 = [n0[0] * d, n0[1] * d];
        let v1 = [n1[0] * d, n1[1] * d];

        let e0 = [p[0] - pts[prev][0], p[1] - pts[prev][1]];
        let e1 = [pts[(i + 1) % n][0] - p[0], pts[(i + 1) % n][1] - p[1]];
        let turn = e0[0] * e1[1] - e0[1] * e1[0]; // > 0 = Linkskurve (konvexe Ecke)

        let gap = turn * d > 1e-12;
        add(&mut raw, &mut arc, [p[0] + v0[0], p[1] + v0[1]], gap);
        if gap {
            // Lücke an der Ecke -> mit Bogen um den Eckpunkt füllen
            let ang = jsmath::atan2(v0[0] * v1[1] - v0[1] * v1[0], v0[0] * v1[0] + v0[1] * v1[1]);
            let steps = (ang.abs() / max_step).ceil();
            let mut s = 1.0f64;
            while s < steps {
                let t = ang * s / steps;
                let (c, sn) = (jsmath::cos(t), jsmath::sin(t));
                add(&mut raw, &mut arc, [p[0] + v0[0] * c - v0[1] * sn, p[1] + v0[0] * sn + v0[1] * c], true);
                s += 1.0;
            }
        }
        add(&mut raw, &mut arc, [p[0] + v1[0], p[1] + v1[1]], false);
    }
    while raw.len() > 1 && hypot2(raw[0][0] - raw[raw.len() - 1][0], raw[0][1] - raw[raw.len() - 1][1]) <= 1e-7 {
        raw.pop();
        arc.pop();
    }
    (raw, arc)
}

struct Piece {
    a: P,
    b: P,
    a_id: usize,
    b_id: usize,
    arc: bool,
}

/// Zerlegt den geschlossenen Linienzug an allen Selbst-Kreuzungen
fn split_at_intersections(raw: &[P], arc: &[bool]) -> Vec<Piece> {
    let n = raw.len();
    // je Strecke: (Stelle auf der Strecke, Kennung, Punkt)
    let mut cuts: Vec<Vec<(f64, usize, P)>> = vec![vec![]; n];
    let mut next_id = n; // 0..n-1 = Original-Punkte, ab n = Kreuzungspunkte

    let grid = SegmentGrid::new(raw);
    let mut cand: Vec<usize> = Vec::new();
    let mut seen = vec![usize::MAX; n];
    for i in 0..n {
        let (a, b) = (raw[i], raw[(i + 1) % n]);
        grid.candidates(a, b, i, &mut seen, &mut cand);
        for &j in &cand {
            if j <= i {
                continue;
            }
            if j == i + 1 || (i == 0 && j == n - 1) {
                continue; // Nachbarn teilen nur einen Punkt
            }
            let (c, dd) = (raw[j], raw[(j + 1) % n]);
            let Some((t, u, p)) = seg_intersect(a, b, c, dd) else { continue };
            let id = next_id;
            next_id += 1;
            cuts[i].push((t, id, p));
            cuts[j].push((u, id, p));
        }
    }

    let mut pieces: Vec<Piece> = Vec::new();
    for i in 0..n {
        cuts[i].sort_by(|x, y| {
            let v = x.0 - y.0;
            if v < 0.0 {
                std::cmp::Ordering::Less
            } else if v > 0.0 {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        });
        let (mut cur_p, mut cur_id) = (raw[i], i);
        for c in &cuts[i] {
            pieces.push(Piece { a: cur_p, b: c.2, a_id: cur_id, b_id: c.1, arc: arc[i] });
            cur_p = c.2;
            cur_id = c.1;
        }
        let end_idx = (i + 1) % n;
        pieces.push(Piece { a: cur_p, b: raw[end_idx], a_id: cur_id, b_id: end_idx, arc: arc[i] });
    }
    pieces
}

fn seg_intersect(a: P, b: P, c: P, d: P) -> Option<(f64, f64, P)> {
    let (rx, ry, sx, sy) = (b[0] - a[0], b[1] - a[1], d[0] - c[0], d[1] - c[1]);
    let den = rx * sy - ry * sx;
    if den.abs() < 1e-14 {
        return None; // parallel
    }
    let (qx, qy) = (c[0] - a[0], c[1] - a[1]);
    let t = (qx * sy - qy * sx) / den;
    let u = (qx * ry - qy * rx) / den;
    let eps = 1e-9;
    if t <= eps || t >= 1.0 - eps || u <= eps || u >= 1.0 - eps {
        return None;
    }
    Some((t, u, [a[0] + t * rx, a[1] + t * ry]))
}

/// Behaltene Stücke wieder zu geschlossenen Konturen verbinden.
/// tol: liegen zwei Kreuzungspunkte fast aufeinander, fällt das winzige Stück dazwischen weg – dann darf am
/// nächsten Stück weitergemacht werden, das höchstens tol entfernt beginnt.
fn chain_pieces(pieces: &[Piece], tol: f64) -> Vec<Vec<P>> {
    let mut by_start: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, pc) in pieces.iter().enumerate() {
        by_start.entry(pc.a_id).or_default().push(i);
    }
    let mut used = vec![false; pieces.len()];
    let mut loops: Vec<Vec<P>> = Vec::new();

    for s in 0..pieces.len() {
        if used[s] {
            continue;
        }
        let mut lp: Vec<P> = Vec::new();
        let mut cur: Option<usize> = Some(s);
        let start_id = pieces[s].a_id;
        let mut ok = false;
        while let Some(c) = cur {
            if used[c] {
                break;
            }
            used[c] = true;
            lp.push(pieces[c].a);
            let (end_id, end_p) = (pieces[c].b_id, pieces[c].b);
            if end_id == start_id {
                ok = true;
                break;
            }
            cur = by_start.get(&end_id).and_then(|next| next.iter().copied().find(|&k| !used[k]));
            if cur.is_none() && tol > 0.0 {
                if lp.len() > 2 && hypot2(end_p[0] - pieces[s].a[0], end_p[1] - pieces[s].a[1]) <= tol {
                    ok = true;
                    break;
                }
                let mut best = tol;
                for k in 0..pieces.len() {
                    if used[k] {
                        continue;
                    }
                    let dd = hypot2(pieces[k].a[0] - end_p[0], pieces[k].a[1] - end_p[1]);
                    if dd <= best {
                        best = dd;
                        cur = Some(k);
                    }
                }
            }
        }
        if ok {
            loops.push(clean_polygon(&lp));
        }
    }
    loops
}

/// Einfaches Raster, damit die Suche auch bei vielen Punkten schnell bleibt
struct SegmentGrid<'a> {
    cells: HashMap<i64, Vec<usize>>,
    size: f64,
    pts: &'a [P],
}

impl<'a> SegmentGrid<'a> {
    fn new(pts: &'a [P]) -> Self {
        let inf = f64::INFINITY;
        let (mut min_x, mut max_x, mut min_y, mut max_y) = (inf, -inf, inf, -inf);
        for p in pts {
            min_x = mn(min_x, p[0]);
            max_x = mx(max_x, p[0]);
            min_y = mn(min_y, p[1]);
            max_y = mx(max_y, p[1]);
        }
        let span = mx(mx(max_x - min_x, max_y - min_y), 1e-6);
        let size = mx(span / mx(4.0, (pts.len() as f64).sqrt() * 2.0), 1e-4);
        let mut g = SegmentGrid { cells: HashMap::new(), size, pts };
        let n = pts.len();
        for i in 0..n {
            let mut keys = Vec::new();
            g.keys_for(pts[i], pts[(i + 1) % n], 0.0, |k| keys.push(k));
            for k in keys {
                g.cells.entry(k).or_default().push(i);
            }
        }
        g
    }

    /// Zellen, die das Rechteck um a und b (plus Rand) berühren – in derselben Reihenfolge wie im TypeScript
    fn keys_for(&self, a: P, b: P, pad: f64, mut each: impl FnMut(i64)) {
        let s = self.size;
        let (x0, x1) = (((mn(a[0], b[0]) - pad) / s).floor(), ((mx(a[0], b[0]) + pad) / s).floor());
        let (y0, y1) = (((mn(a[1], b[1]) - pad) / s).floor(), ((mx(a[1], b[1]) + pad) / s).floor());
        let mut x = x0;
        while x <= x1 {
            let mut y = y0;
            while y <= y1 {
                each((x * 1048576.0 + y) as i64);
                y += 1.0;
            }
            x += 1.0;
        }
    }

    /// Strecken in den Zellen um a–b, jede einmal, in der Reihenfolge des ersten Auftretens
    /// (`seen` merkt je Strecke, für welches `tag` sie schon genannt wurde)
    fn candidates(&self, a: P, b: P, tag: usize, seen: &mut [usize], out: &mut Vec<usize>) {
        out.clear();
        self.keys_for(a, b, 0.0, |k| {
            if let Some(l) = self.cells.get(&k) {
                for &i in l {
                    if seen[i] != tag {
                        seen[i] = tag;
                        out.push(i);
                    }
                }
            }
        });
    }

    /// Liegt irgendein Teil der Kontur näher als "limit" am Punkt?
    fn nearer_than(&self, px: f64, py: f64, limit: f64) -> bool {
        let n = self.pts.len();
        let mut hit = false;
        self.keys_for([px, py], [px, py], limit, |k| {
            if hit {
                return;
            }
            if let Some(l) = self.cells.get(&k) {
                for &i in l {
                    if seg_dist(px, py, self.pts[i], self.pts[(i + 1) % n]) < limit {
                        hit = true;
                        return;
                    }
                }
            }
        });
        hit
    }
}

fn seg_dist(px: f64, py: f64, a: P, b: P) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let mut t = if l2 > 0.0 { ((px - a[0]) * dx + (py - a[1]) * dy) / l2 } else { 0.0 };
    t = mx(0.0, mn(1.0, t));
    hypot2(px - (a[0] + t * dx), py - (a[1] + t * dy))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn square(s: f64) -> Vec<P> {
        vec![[0.0, 0.0], [s, 0.0], [s, s], [0.0, s]]
    }

    #[test]
    fn inside_offset_of_a_square_is_a_smaller_square() {
        let r = offset_polygon(&square(20.0), -3.0, 0.01);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].len(), 4);
        assert!((polygon_area(&r[0]) - 14.0 * 14.0).abs() < 1e-9);
    }

    #[test]
    fn outside_offset_rounds_the_corners() {
        let r = offset_polygon(&square(20.0), 3.0, 0.01);
        assert_eq!(r.len(), 1);
        let want = 400.0 + 4.0 * 20.0 * 3.0 + std::f64::consts::PI * 9.0;
        // (die Bögen sind Sehnen: etwas weniger Fläche als der genaue Kreis)
        assert!((polygon_area(&r[0]) - want).abs() < 0.2, "{}", polygon_area(&r[0]));
        // jeder Punkt liegt 3 mm (± Bogen-Toleranz) von der Kontur entfernt
        let sq = square(20.0);
        let g = SegmentGrid::new(&sq);
        for p in &r[0] {
            assert!(!g.nearer_than(p[0], p[1], 3.0 - 1e-6));
        }
    }

    #[test]
    fn tool_too_big_gives_nothing_and_narrow_part_splits() {
        assert!(offset_polygon(&square(4.0), -2.5, 0.01).is_empty());
        // Hantel: zwei Quadrate, verbunden durch einen 2 mm breiten Steg
        let bone = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 4.0], [20.0, 4.0], [20.0, 0.0], [30.0, 0.0], [30.0, 10.0], [20.0, 10.0], [20.0, 6.0], [10.0, 6.0], [10.0, 10.0], [0.0, 10.0]];
        assert_eq!(offset_polygon(&bone, -1.5, 0.01).len(), 2);
    }

    #[test]
    fn clockwise_input_and_zero_distance() {
        let mut sq = square(10.0);
        sq.reverse();
        let r = offset_polygon(&sq, 0.0, 0.01);
        assert!(polygon_area(&r[0]) > 0.0);
        assert_eq!(offset_polygon(&[[0.0, 0.0], [1.0, 1.0]], 1.0, 0.01).len(), 0);
    }

    #[test]
    fn simplify_keeps_ends_and_corners() {
        let line: Vec<P> = (0..=100).map(|i| [i as f64, if i == 50 { 5.0 } else { 0.0 }]).collect();
        assert_eq!(simplify_polyline_idx(&line, 0.01), vec![0, 49, 50, 51, 100]);
        assert_eq!(simplify_polygon_idx(&square(5.0), 1.0), vec![0, 1, 2, 3]);
    }

    // ---- Vergleich mit dem TypeScript: dieselben Fälle ----

    fn fixture(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures").join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }
    fn pts(v: &Value) -> Vec<P> {
        v.as_array().unwrap().iter().map(|p| [p[0].as_f64().unwrap(), p[1].as_f64().unwrap()]).collect()
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

    #[test]
    fn same_result_as_typescript() {
        let cases: Value = serde_json::from_str(&fixture("polyoffset-cases.json")).unwrap();
        let expected: Value = serde_json::from_str(&fixture("polyoffset-expected.json")).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 40);
        let (mut numbers, mut exact, mut worst) = (0usize, 0usize, 0.0f64);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let want = expected.get(name).unwrap_or_else(|| panic!("{name}: no expected result (run UPDATE_FIXTURES=1 npm test)"));
            let poly = pts(&c["pts"]);
            if let Some(tol) = c["simplify"].as_f64() {
                // Vereinfachen: keine Winkelfunktionen -> dieselben Punkte, genau
                let idx: Vec<usize> = if c["closed"].as_bool().unwrap() { simplify_polygon_idx(&poly, tol) } else { simplify_polyline_idx(&poly, tol) };
                let wanted: Vec<usize> = serde_json::from_value(want["keep"].clone()).unwrap();
                assert_eq!(idx, wanted, "{name}: kept points");
                continue;
            }
            let (d, arc_tol) = (c["d"].as_f64().unwrap(), c["arcTol"].as_f64().unwrap_or(0.01));
            let got = offset_polygon(&poly, d, arc_tol);
            let sizes: Vec<usize> = serde_json::from_value(want["loops"].clone()).unwrap();
            assert_eq!(got.iter().map(|l| l.len()).collect::<Vec<_>>(), sizes, "{name}: contours and their point counts");
            let bytes = base64(want["xy"].as_str().unwrap());
            let mut wanted = bytes.chunks(8).map(|q| f64::from_le_bytes(q.try_into().unwrap()));
            for (li, l) in got.iter().enumerate() {
                for (pi, p) in l.iter().enumerate() {
                    for k in 0..2 {
                        let w = wanted.next().unwrap();
                        numbers += 1;
                        if p[k].to_bits() == w.to_bits() {
                            exact += 1;
                        }
                        let diff = (p[k] - w).abs();
                        worst = worst.max(diff);
                        assert!(diff <= 1e-9, "{name}: contour {li}, point {pi}: {} != {w}", p[k]);
                    }
                }
            }
            assert!((polygon_area(&poly) - want["area"].as_f64().unwrap()).abs() <= 1e-9 * polygon_area(&poly).abs().max(1.0), "{name}: area");
            let inside: Vec<bool> = serde_json::from_value(want["inside"].clone()).unwrap();
            let probes = pts(&c["probes"]);
            assert_eq!(probes.iter().map(|q| point_in_poly(q[0], q[1], &poly)).collect::<Vec<_>>(), inside, "{name}: point in contour");
        }
        println!("{} cases, {numbers} coordinates: {exact} identical to the last bit, largest difference {worst:e} mm", cases.len());
    }
}
