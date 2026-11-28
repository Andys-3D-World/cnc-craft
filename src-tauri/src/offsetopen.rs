//! VERSATZ FÜR OFFENE LINIEN – Zwilling von `src/editor/offsetOpen.ts` (offsetOpenPath, sideOf).
//!
//! Jedes Stück um d zur Seite (d > 0 = links in Zeichenrichtung), innen am Schnittpunkt, außen spitz oder mit Bogen;
//! dann wird weggeschnitten, was näher als d am Original liegt (keine Schleifen), und aufgeräumt. Folgt dem TypeScript
//! Zeile für Zeile. Nur Vergleich: was in die Zeichnung kommt, bestimmt weiter das Fenster (commands.ts).
//! Gemeinsame Fälle: `tests/fixtures/offsetopen-cases.json.gz`.

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath;
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct P {
    pub x: f64,
    pub y: f64,
}

fn cross(a: P, b: P) -> f64 {
    a.x * b.y - a.y * b.x
}
fn dot(a: P, b: P) -> f64 {
    a.x * b.x + a.y * b.y
}
fn dist(a: P, b: P) -> f64 {
    hypot2(a.x - b.x, a.y - b.y)
}
fn sub(a: P, b: P) -> P {
    P { x: a.x - b.x, y: a.y - b.y }
}

/// Schnittpunkt zweier Geraden (Punkt + Richtung), None = parallel
fn line_x(p: P, u: P, q: P, v: P) -> Option<P> {
    let den = cross(u, v);
    if den.abs() < 1e-12 {
        return None;
    }
    let t = cross(sub(q, p), v) / den;
    Some(P { x: p.x + u.x * t, y: p.y + u.y * t })
}

/// Bogen um c von a nach b (dir +1 gegen, -1 mit dem Uhrzeigersinn), ohne a und b
fn arc_between(c: P, a: P, b: P, r: f64, dir: f64, tol: f64) -> Vec<P> {
    let a0 = jsmath::atan2(a.y - c.y, a.x - c.x);
    let a1 = jsmath::atan2(b.y - c.y, b.x - c.x);
    let mut sweep = a1 - a0;
    if dir > 0.0 {
        while sweep <= 0.0 {
            sweep += 2.0 * PI;
        }
    } else {
        while sweep >= 0.0 {
            sweep -= 2.0 * PI;
        }
    }
    let step = 2.0 * jsmath::acos(mx(-1.0, 1.0 - tol / mx(r, tol)));
    let n = mx(2.0, (sweep.abs() / step).ceil());
    let mut out = vec![];
    let mut k = 1.0;
    while k < n {
        let t = a0 + (sweep * k) / n;
        out.push(P { x: c.x + r * jsmath::cos(t), y: c.y + r * jsmath::sin(t) });
        k += 1.0;
    }
    out
}

struct Seg {
    a: P,
    b: P,
    u: P,
    l: f64,
    o1: P,
}

/// Schritt 1: grob versetzte Linie (kann sich in engen Stellen selbst kreuzen)
fn raw_offset(p: &[P], d: f64, tol: f64) -> Vec<P> {
    let ad = d.abs();
    const MITER: f64 = 2.0;
    let mut segs: Vec<Seg> = vec![];
    for i in 0..p.len() - 1 {
        let l = dist(p[i], p[i + 1]);
        let u = P { x: (p[i + 1].x - p[i].x) / l, y: (p[i + 1].y - p[i].y) / l };
        let n = P { x: -u.y * d, y: u.x * d };
        segs.push(Seg { a: P { x: p[i].x + n.x, y: p[i].y + n.y }, b: P { x: p[i + 1].x + n.x, y: p[i + 1].y + n.y }, u, l, o1: p[i + 1] });
    }
    let mut out = vec![segs[0].a];
    for i in 0..segs.len() - 1 {
        let (s, t) = (&segs[i], &segs[i + 1]);
        let c = cross(s.u, t.u);
        if c.abs() < 1e-12 && dot(s.u, t.u) > 0.0 {
            out.push(s.b);
            continue;
        }
        let outer = c * d < 0.0 || c.abs() < 1e-12;
        let x = if c.abs() < 1e-12 { None } else { line_x(s.a, s.u, t.a, t.u) };
        match x {
            Some(x) if !outer => {
                let t1 = dot(sub(x, s.a), s.u);
                let t2 = dot(sub(x, t.a), t.u);
                if t1 >= 0.0 && t1 <= s.l && t2 >= 0.0 && t2 <= t.l {
                    out.push(x);
                } else {
                    out.push(s.b);
                    out.push(t.a);
                }
            }
            Some(x) if outer && dist(x, s.o1) <= MITER * ad => out.push(x),
            _ => {
                out.push(s.b);
                out.extend(arc_between(s.o1, s.b, t.a, ad, if d > 0.0 { -1.0 } else { 1.0 }, tol));
                out.push(t.a);
            }
        }
    }
    out.push(segs[segs.len() - 1].b);
    let mut res = vec![];
    for (i, q) in out.iter().enumerate() {
        if i == 0 || dist(*q, out[i - 1]) > 1e-12 {
            res.push(*q);
        }
    }
    res
}

fn at(a: P, b: P, t: f64) -> P {
    if t == 0.0 {
        a
    } else if t == 1.0 {
        b
    } else {
        P { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
}
fn path_len(pc: &[P]) -> f64 {
    let mut s = 0.0;
    for i in 1..pc.len() {
        s += dist(pc[i], pc[i - 1]);
    }
    s
}

/// t, für die c0 + c1·t zwischen lo und hi liegt
fn lin(c0: f64, c1: f64, lo: f64, hi: f64) -> Option<(f64, f64)> {
    if c1.abs() < 1e-15 {
        return if c0 > lo && c0 < hi { Some((f64::NEG_INFINITY, f64::INFINITY)) } else { None };
    }
    let (a, b) = ((lo - c0) / c1, (hi - c0) / c1);
    Some(if a < b { (a, b) } else { (b, a) })
}

/// Teil [t0, t1] der Strecke A→B, der näher als r an der Strecke P→Q liegt (eine Kapsel), None = keiner
fn near_interval(a_: P, b_: P, pp: P, q: P, r: f64) -> Option<(f64, f64)> {
    let d = sub(b_, a_);
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut add = |iv: Option<(f64, f64)>| {
        if let Some((x, y)) = iv {
            if y > x {
                lo = mn(lo, x);
                hi = mx(hi, y);
            }
        }
    };
    for c in [pp, q] {
        let f = sub(a_, c);
        let (a, b, cc) = (dot(d, d), 2.0 * dot(f, d), dot(f, f) - r * r);
        let disc = b * b - 4.0 * a * cc;
        if a > 0.0 && disc > 0.0 {
            let sq = disc.sqrt();
            add(Some(((-b - sq) / (2.0 * a), (-b + sq) / (2.0 * a))));
        }
    }
    let l = dist(pp, q);
    if l > 1e-12 {
        let u = P { x: (q.x - pp.x) / l, y: (q.y - pp.y) / l };
        let f = sub(a_, pp);
        if let (Some(s), Some(h)) = (lin(dot(f, u), dot(d, u), 0.0, l), lin(cross(u, f), cross(u, d), -r, r)) {
            add(Some((mx(s.0, h.0), mn(s.1, h.1))));
        }
    }
    let (t0, t1) = (mx(0.0, lo), mn(1.0, hi));
    if t1 > t0 {
        Some((t0, t1))
    } else {
        None
    }
}

/// Was von [0, 1] übrig bleibt, wenn die Stücke in gone wegfallen
fn kept_intervals(gone: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut g = gone.to_vec();
    g.sort_by(|a, b| (a.0 - b.0).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut out = vec![];
    let mut pos = 0.0;
    for (a, b) in g {
        if a > pos + 1e-12 {
            out.push((pos, a));
        }
        pos = mx(pos, b);
    }
    if pos < 1.0 - 1e-12 {
        out.push((pos, 1.0));
    }
    out
}

/// Aufräumen: winzige Stummel weg, Stücke auf derselben Geraden wieder verbinden
fn tidy(pieces: Vec<Vec<P>>, eps: f64, tol: f64) -> Vec<Vec<P>> {
    let stub = 4.0 * eps + 1e-9;
    let cleaned: Vec<Vec<P>> = pieces
        .into_iter()
        .map(|pc| {
            let mut q = pc;
            while q.len() > 2 && dist(q[q.len() - 1], q[q.len() - 2]) < stub {
                q.pop();
            }
            while q.len() > 2 && dist(q[0], q[1]) < stub {
                q.remove(0);
            }
            q
        })
        .filter(|pc| pc.len() >= 2 && path_len(pc) > tol)
        .collect();
    let on_seg = |q: P, a: P, b: P| {
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l2 = dx * dx + dy * dy;
        if l2 <= 0.0 {
            return false;
        }
        let t = ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2;
        t >= -1e-9 && t <= 1.0 + 1e-9 && cross(P { x: dx, y: dy }, sub(q, a)).abs() / l2.sqrt() < eps
    };
    let dir_of = |a: P, b: P| {
        let l = dist(a, b);
        let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
        P { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
    };
    let mut out: Vec<Vec<P>> = vec![];
    for pc in cleaned {
        if let Some(last) = out.last_mut() {
            let (a0, a1, b0, b1) = (last[last.len() - 2], last[last.len() - 1], pc[0], pc[1]);
            if dot(dir_of(a0, a1), dir_of(b0, b1)) > 0.9999 {
                if on_seg(b0, a0, a1) {
                    last.pop();
                    last.extend(pc);
                    continue;
                }
                if on_seg(a1, b0, b1) {
                    last.extend_from_slice(&pc[1..]);
                    continue;
                }
            }
        }
        out.push(pc);
    }
    out
}

/// Parallele zu einer offenen Linie. d > 0 = links, d < 0 = rechts. tol: größte Abweichung der Bögen
pub fn offset_open_path(pts: &[P], d: f64, tol: f64) -> Vec<Vec<P>> {
    let mut p: Vec<P> = vec![];
    for &q in pts {
        if p.is_empty() || dist(q, p[p.len() - 1]) > 1e-9 {
            p.push(q);
        }
    }
    if p.len() < 2 {
        return vec![];
    }
    if d == 0.0 {
        return vec![p];
    }
    let raw = raw_offset(&p, d, tol);
    let r = d.abs() - mx(1.5 * tol, 1e-6 * d.abs());
    let o_box: Vec<[f64; 4]> = (0..p.len() - 1)
        .map(|k| {
            let (a, b) = (p[k], p[k + 1]);
            [mn(a.x, b.x) - r, mn(a.y, b.y) - r, mx(a.x, b.x) + r, mx(a.y, b.y) + r]
        })
        .collect();
    let mut out: Vec<Vec<P>> = vec![];
    let mut open = false;
    for i in 0..raw.len().saturating_sub(1) {
        let (a, b) = (raw[i], raw[i + 1]);
        let bx = [mn(a.x, b.x), mn(a.y, b.y), mx(a.x, b.x), mx(a.y, b.y)];
        let mut gone: Vec<(f64, f64)> = vec![];
        for k in 0..p.len() - 1 {
            let ob = o_box[k];
            if ob[0] > bx[2] || ob[2] < bx[0] || ob[1] > bx[3] || ob[3] < bx[1] {
                continue;
            }
            if let Some(iv) = near_interval(a, b, p[k], p[k + 1], r) {
                gone.push(iv);
            }
        }
        let kept = kept_intervals(&gone);
        for &(t0, t1) in &kept {
            let (q0, q1) = (at(a, b, t0), at(a, b, t1));
            if open && t0 == 0.0 {
                out.last_mut().unwrap().push(q1);
            } else {
                out.push(vec![q0, q1]);
            }
            open = t1 == 1.0;
        }
        if !kept.iter().any(|&(_, t1)| t1 == 1.0) {
            open = false;
        }
    }
    tidy(out, d.abs() - r, tol)
}

/// Auf welcher Seite der Linie liegt der Punkt? +1 = links, -1 = rechts (am nächsten Stück gemessen)
pub fn side_of(pts: &[P], at_: P) -> f64 {
    let (mut best, mut side) = (f64::INFINITY, 1.0);
    for i in 0..pts.len().saturating_sub(1) {
        let (a, b) = (pts[i], pts[i + 1]);
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l2 = dx * dx + dy * dy;
        if l2 < 1e-18 {
            continue;
        }
        let t = mx(0.0, mn(1.0, ((at_.x - a.x) * dx + (at_.y - a.y) * dy) / l2));
        let q = P { x: a.x + dx * t, y: a.y + dy * t };
        let dd = hypot2(at_.x - q.x, at_.y - q.y);
        if dd < best {
            best = dd;
            side = if cross(P { x: dx, y: dy }, sub(at_, a)) >= 0.0 { 1.0 } else { -1.0 };
        }
    }
    side
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Read;

    #[test]
    fn same_result_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("offsetopen-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let cases: Value = serde_json::from_str(&text).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 100, "only {} cases", cases.len());
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let pts: Vec<P> = serde_json::from_value(c["pts"].clone()).unwrap();
            let at: P = serde_json::from_value(c["at"].clone()).unwrap();
            let got = offset_open_path(&pts, c["d"].as_f64().unwrap(), c["tol"].as_f64().unwrap());
            let want: Vec<Vec<P>> = serde_json::from_value(c["want"]["lines"].clone()).unwrap();
            assert_eq!(got.len(), want.len(), "{name}: lines");
            for (k, (g, w)) in got.iter().zip(&want).enumerate() {
                assert_eq!(g.len(), w.len(), "{name}: line {k} points");
                for (i, (a, b)) in g.iter().zip(w).enumerate() {
                    assert!((a.x - b.x).abs() <= 1e-9 && (a.y - b.y).abs() <= 1e-9, "{name}: line {k} point {i}: {a:?} vs {b:?}");
                }
            }
            assert_eq!(side_of(&pts, at), c["want"]["side"].as_f64().unwrap(), "{name}: side");
        }
        println!("{} open lines offset the same as offsetOpen.ts", cases.len());
    }
}
