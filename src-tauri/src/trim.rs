//! TRIMMEN – Zwilling der Rechnung in `src/editor/trim.ts` (normalizePath, pathLength, intersections, nearestStation,
//! trimSpan, remainingSpans, slicePath).
//!
//! Alles über Stationen = Strecke entlang der Kontur: wo andere Konturen (oder sie selbst) sie kreuzen, welches Stück um
//! den Klick dazwischen liegt, was übrig bleibt. Folgt dem TypeScript Zeile für Zeile. Nur Vergleich: was in die
//! Zeichnung kommt, bestimmt weiter das Fenster (trimTool.ts). Gemeinsame Fälle: `tests/fixtures/trim-cases.json.gz`.

use crate::gcodesim::{hypot2, mn, mx};
use serde::{Deserialize, Serialize};

pub const TRIM_EPS: f64 = 0.02;

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct Path {
    pub pts: Vec<Pt>,
    pub closed: bool,
}
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Span {
    pub from: f64,
    pub to: f64,
}

/// Offene Kontur mit gleichem Anfang und Ende wie eine geschlossene behandeln
pub fn normalize_path(p: &Path, eps: f64) -> Path {
    let n = p.pts.len();
    if !p.closed && n > 3 && hypot2(p.pts[0].x - p.pts[n - 1].x, p.pts[0].y - p.pts[n - 1].y) <= eps {
        return Path { pts: p.pts[..n - 1].to_vec(), closed: true };
    }
    p.clone()
}

fn vertices(p: &Path) -> Vec<Pt> {
    let mut v = p.pts.clone();
    if p.closed && !p.pts.is_empty() {
        v.push(p.pts[0]);
    }
    v
}

pub fn path_length(p: &Path) -> f64 {
    let v = vertices(p);
    let mut l = 0.0;
    for i in 1..v.len() {
        l += hypot2(v[i].x - v[i - 1].x, v[i].y - v[i - 1].y);
    }
    l
}

struct Chunk {
    from: usize,
    to: usize,
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

fn chunks_of(v: &[Pt]) -> Vec<Chunk> {
    const SIZE: usize = 24;
    let mut out = vec![];
    let mut from = 0;
    while from + 1 < v.len() {
        let to = (from + SIZE).min(v.len() - 1);
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for p in &v[from..=to] {
            if p.x < min_x {
                min_x = p.x;
            }
            if p.x > max_x {
                max_x = p.x;
            }
            if p.y < min_y {
                min_y = p.y;
            }
            if p.y > max_y {
                max_y = p.y;
            }
        }
        out.push(Chunk { from, to, min_x, min_y, max_x, max_y });
        from += SIZE;
    }
    out
}

fn overlap(a: &Chunk, b: &Chunk, e: f64) -> bool {
    a.min_x <= b.max_x + e && b.min_x <= a.max_x + e && a.min_y <= b.max_y + e && b.min_y <= a.max_y + e
}

/// Alle Stationen auf `target`, an denen eine andere Kontur (oder target selbst) sie kreuzt oder berührt
pub fn intersections(target: &Path, cutters: &[Path], eps: f64) -> Vec<f64> {
    let tv = vertices(target);
    let mut cum = vec![0.0];
    for i in 1..tv.len() {
        cum.push(cum[i - 1] + hypot2(tv[i].x - tv[i - 1].x, tv[i].y - tv[i - 1].y));
    }
    let total = cum[cum.len() - 1];
    let tc = chunks_of(&tv);
    let mut hits: Vec<f64> = vec![];
    let mut test = |cv: &[Pt], selfc: bool| {
        let cc = chunks_of(cv);
        let last_seg = tv.len() as i64 - 2;
        for a in &tc {
            for b in &cc {
                if !overlap(a, b, eps) {
                    continue;
                }
                for i in a.from..a.to {
                    let (p, q) = (tv[i], tv[i + 1]);
                    let (rx, ry) = (q.x - p.x, q.y - p.y);
                    let rl = hypot2(rx, ry);
                    if rl < 1e-12 {
                        continue;
                    }
                    for j in b.from..b.to {
                        if selfc {
                            let (ii, jj) = (i as i64, j as i64);
                            if jj <= ii + 1 && jj >= ii - 1 {
                                continue;
                            }
                            if target.closed && ((ii == 0 && jj == last_seg) || (jj == 0 && ii == last_seg)) {
                                continue;
                            }
                        }
                        let (c, d) = (cv[j], cv[j + 1]);
                        let (sx, sy) = (d.x - c.x, d.y - c.y);
                        let sl = hypot2(sx, sy);
                        if sl < 1e-12 {
                            continue;
                        }
                        let den = rx * sy - ry * sx;
                        if den.abs() < 1e-9 * rl * sl {
                            continue;
                        }
                        let t = ((c.x - p.x) * sy - (c.y - p.y) * sx) / den;
                        let u = ((c.x - p.x) * ry - (c.y - p.y) * rx) / den;
                        let (et, eu) = (eps / rl, eps / sl);
                        if t < -et || t > 1.0 + et || u < -eu || u > 1.0 + eu {
                            continue;
                        }
                        hits.push(cum[i] + mx(0.0, mn(1.0, t)) * rl);
                    }
                }
            }
        }
    };
    for c in cutters {
        if c.pts.len() >= 2 {
            test(&vertices(c), false);
        }
    }
    test(&tv, true);
    hits.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<f64> = vec![];
    for h in hits {
        if !target.closed && (h <= eps || h >= total - eps) {
            continue;
        }
        if let Some(&l) = out.last() {
            if h - l <= eps {
                continue;
            }
        }
        out.push(h);
    }
    if target.closed && out.len() > 1 && out[0] + total - out[out.len() - 1] <= eps {
        out.pop();
    }
    out
}

/// Nächste Station zum Punkt
pub fn nearest_station(p: &Path, at: Pt) -> (f64, f64) {
    let v = vertices(p);
    let (mut best, mut best_s, mut run) = (f64::INFINITY, 0.0, 0.0);
    for i in 0..v.len().saturating_sub(1) {
        let (a, b) = (v[i], v[i + 1]);
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l2 = dx * dx + dy * dy;
        let u = if l2 > 0.0 { mx(0.0, mn(1.0, ((at.x - a.x) * dx + (at.y - a.y) * dy) / l2)) } else { 0.0 };
        let d = hypot2(a.x + dx * u - at.x, a.y + dy * u - at.y);
        if d < best {
            best = d;
            best_s = run + u * l2.sqrt();
        }
        run += l2.sqrt();
    }
    (best_s, best)
}

/// Das Stück um die Station s0 zwischen den beiden nächsten Schnittpunkten; None = nichts zu begrenzen
pub fn trim_span(length: f64, closed: bool, cuts: &[f64], s0: f64) -> Option<Span> {
    if cuts.is_empty() {
        return None;
    }
    if closed {
        if cuts.len() < 2 {
            return None;
        }
        let i = cuts.iter().position(|&c| c > s0).unwrap_or(0);
        let (to, from) = (cuts[i], cuts[(i + cuts.len() - 1) % cuts.len()]);
        return Some(if to > from { Span { from, to } } else { Span { from, to: to + length } });
    }
    let (mut from, mut to) = (0.0, length);
    for &c in cuts {
        if c <= s0 {
            from = c;
        } else {
            to = c;
            break;
        }
    }
    Some(Span { from, to })
}

/// Was nach dem Entfernen von `span` übrig bleibt
pub fn remaining_spans(length: f64, closed: bool, span: Span, eps: f64) -> Vec<Span> {
    if closed {
        return vec![Span { from: span.to, to: span.from + length }];
    }
    let mut out = vec![];
    if span.from > eps {
        out.push(Span { from: 0.0, to: span.from });
    }
    if span.to < length - eps {
        out.push(Span { from: span.to, to: length });
    }
    out
}

/// Punkte der Kontur von Station from bis to
pub fn slice_path(p: &Path, span: Span) -> Vec<Pt> {
    let v = vertices(p);
    let n = v.len();
    let closed_len = if p.closed { path_length(p) } else { 0.0 };
    let mut out: Vec<Pt> = vec![];
    let mut push = |q: Pt| {
        if out.last().is_none_or(|l| hypot2(l.x - q.x, l.y - q.y) > 1e-9) {
            out.push(q);
        }
    };
    let rounds = if p.closed && span.to > closed_len + 1e-9 { 2 } else { 1 };
    let mut run = 0.0;
    for _ in 0..rounds {
        for i in 0..n.saturating_sub(1) {
            let (a, b) = (v[i], v[i + 1]);
            let l = hypot2(b.x - a.x, b.y - a.y);
            let (s0, s1) = (run, run + l);
            run = s1;
            if l < 1e-12 || s1 < span.from || s0 > span.to {
                continue;
            }
            let (lo, hi) = (mx(0.0, (span.from - s0) / l), mn(1.0, (span.to - s0) / l));
            push(Pt { x: a.x + (b.x - a.x) * lo, y: a.y + (b.y - a.y) * lo });
            push(Pt { x: a.x + (b.x - a.x) * hi, y: a.y + (b.y - a.y) * hi });
        }
    }
    out
}

/// Ein Klick bei `at`: Schnittpunkte, Station, das wegfallende Stück und was übrig bleibt (wie trimTool.ts)
pub fn check(path: &Path, cutters: &[Path], at: Pt) -> serde_json::Value {
    // das Fenster schickt die Kontur schon so (trimTargetPath); zweimal ändert nichts
    let path = &normalize_path(path, TRIM_EPS);
    let cuts = intersections(path, cutters, TRIM_EPS);
    let len = path_length(path);
    let (s, _) = nearest_station(path, at);
    let span = trim_span(len, path.closed, &cuts, s);
    let remaining = span.map(|sp| remaining_spans(len, path.closed, sp, TRIM_EPS));
    serde_json::json!({
        "cuts": cuts, "s": s, "span": span,
        "removed": span.map(|sp| slice_path(path, sp)),
        "remaining": remaining,
        "pieces": remaining.as_ref().map(|r| r.iter().map(|&sp| slice_path(path, sp)).collect::<Vec<_>>()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Read;

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
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("trim-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        let cases = all["cases"].as_array().unwrap();
        assert!(cases.len() >= 40, "only {} cases", cases.len());
        for c in cases {
            let path: Path = serde_json::from_value(c["path"].clone()).unwrap();
            let cutters: Vec<Path> = serde_json::from_value(c["cutters"].clone()).unwrap();
            let at: Pt = serde_json::from_value(c["at"].clone()).unwrap();
            same(&check(&path, &cutters, at), &c["want"], c["name"].as_str().unwrap());
        }
        for n in all["norm"].as_array().unwrap() {
            let p: Path = serde_json::from_value(n["p"].clone()).unwrap();
            same(&serde_json::to_value(normalize_path(&p, TRIM_EPS)).unwrap(), &n["want"], "normalizePath");
        }
        println!("{} trim clicks the same as trim.ts", cases.len());
    }
}
