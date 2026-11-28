//! BILD NACHZEICHNEN – Zwilling von `traceAll`/`otsu` in `src/importers/traceCalc.ts` (mit `marchingSquares` und
//! `simplifyClosed` aus `src/traceUtil.ts` und den Mittellinien aus `src/centerline.ts`).
//!
//! Umrisse: weichzeichnen (Kastenfilter), Rand von 1 Pixel, Marching Squares, Douglas-Peucker, kleine Flecken weg.
//! Mittellinien: Maske, Zhang-Suen-Ausdünnung, Gerippe nachfahren, kurze Stummel weg, vereinfachen.
//! Wie im Fenster: gerechnet wird mit f64, was dort in einem Float32Array liegt, wird hier als f32 gespeichert
//! (`as f32` rundet wie Math.fround). Gemeinsame Fälle: `tests/fixtures/imagetrace-cases.json.gz`
//! (festgehalten von `tests/imageTraceRust.test.ts`).

use crate::gcodesim::{hypot2, mn, mx};
use crate::importplt::Pt;
use crate::jsmath::js_round;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const CENTER_SIDE: f64 = 900.0;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Opts {
    pub w: usize,
    pub h: usize,
    pub threshold: f64,
    pub invert: bool,
    pub blur: i64,
    pub smooth: f64,
    pub min_area: f64,
    pub center: bool,
}
#[derive(Serialize, Clone, Debug)]
pub struct TracePath {
    pub pts: Vec<Pt>,
    pub closed: bool,
}
#[derive(Serialize, Debug)]
pub struct Output {
    pub otsu: f64,
    pub paths: Vec<TracePath>,
}

/// Auftrag aus traceBody(): 4 Bytes Länge, JSON, dann die Graustufen als f32 (little-endian)
pub fn split_body(body: &[u8]) -> Result<(Opts, Vec<f32>), String> {
    let n = u32::from_le_bytes(body.get(..4).ok_or("short body")?.try_into().map_err(|_| "short body")?) as usize;
    let head = body.get(4..4 + n).ok_or("short body")?;
    let o: Opts = serde_json::from_slice(head).map_err(|e| e.to_string())?;
    let data = &body[4 + n..];
    if data.len() != o.w * o.h * 4 {
        return Err(format!("image has {} bytes, expected {}", data.len(), o.w * o.h * 4));
    }
    Ok((o, data.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()))
}

pub fn run(gray: &[f32], o: &Opts) -> Output {
    Output { otsu: otsu(gray), paths: trace_all(gray, o) }
}

/// Automatische Schwelle (Otsu); bei reinen Schwarz/Weiß-Bildern die Mitte aller gleich guten Werte
pub fn otsu(gray: &[f32]) -> f64 {
    let mut hist = [0f64; 256];
    for &g in gray {
        if g.is_nan() {
            continue; // hist[NaN]++ zählt in JavaScript in keinem Fach
        }
        hist[mx(0.0, mn(255.0, js_round(g as f64))) as usize] += 1.0;
    }
    let total = gray.len() as f64;
    let sum: f64 = (0..256).map(|i| i as f64 * hist[i]).sum();
    let (mut sum_b, mut w_b, mut best, mut first, mut last) = (0.0, 0.0, -1.0, 128.0, 128.0);
    for t in 0..256 {
        w_b += hist[t];
        if w_b == 0.0 {
            continue;
        }
        let w_f = total - w_b;
        if w_f == 0.0 {
            break;
        }
        sum_b += t as f64 * hist[t];
        let (m_b, m_f) = (sum_b / w_b, (sum - sum_b) / w_f);
        let between = w_b * w_f * (m_b - m_f).powi(2);
        if between > best * (1.0 + 1e-9) {
            best = between;
            first = t as f64;
            last = t as f64;
        } else if between >= best * (1.0 - 1e-9) {
            last = t as f64;
        }
    }
    mx(1.0, mn(254.0, js_round((first + last) / 2.0) + 1.0))
}

pub fn box_blur(src: &[f32], w: usize, h: usize, r: i64) -> Vec<f32> {
    if r <= 0 {
        return src.to_vec();
    }
    let (wi, hi) = (w as i64, h as i64);
    let div = (2 * r + 1) as f64;
    let mut tmp = vec![0f32; w * h];
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        let row = |x: i64| src[y * w + x.clamp(0, wi - 1) as usize] as f64;
        let mut acc = 0.0f64;
        for x in -r..=r {
            acc += row(x);
        }
        for x in 0..wi {
            tmp[y * w + x as usize] = (acc / div) as f32;
            acc += row((x + r + 1).min(wi - 1)) - row((x - r).max(0));
        }
    }
    for x in 0..w {
        let col = |y: i64| tmp[y.clamp(0, hi - 1) as usize * w + x] as f64;
        let mut acc = 0.0f64;
        for y in -r..=r {
            acc += col(y);
        }
        for y in 0..hi {
            out[y as usize * w + x] = (acc / div) as f32;
            acc += col((y + r + 1).min(hi - 1)) - col((y - r).max(0));
        }
    }
    out
}

/// Marching Squares wie traceUtil.ts: jeder Kantenpunkt hat eine feste Nummer, so schließen sich die Ringe genau
pub fn marching_squares(v: &[f32], w: usize, h: usize, iso: f64) -> Vec<Vec<Pt>> {
    let mut point_idx: HashMap<usize, usize> = HashMap::new();
    let (mut px, mut py): (Vec<f64>, Vec<f64>) = (vec![], vec![]);
    let (mut seg_a, mut seg_b): (Vec<usize>, Vec<usize>) = (vec![], vec![]);
    let mut edge = |key: usize, ax: f64, ay: f64, bx: f64, by: f64, va: f64, vb: f64| -> usize {
        *point_idx.entry(key).or_insert_with(|| {
            let t = (iso - va) / (vb - va);
            px.push(ax + (bx - ax) * t);
            py.push(ay + (by - ay) * t);
            px.len() - 1
        })
    };
    for j in 0..h.saturating_sub(1) {
        for i in 0..w.saturating_sub(1) {
            let (tl, tr) = (v[j * w + i] as f64, v[j * w + i + 1] as f64);
            let (br, bl) = (v[(j + 1) * w + i + 1] as f64, v[(j + 1) * w + i] as f64);
            let c = (if tl > iso { 8 } else { 0 }) | (if tr > iso { 4 } else { 0 }) | (if br > iso { 2 } else { 0 }) | (if bl > iso { 1 } else { 0 });
            if c == 0 || c == 15 {
                continue;
            }
            let (fi, fj) = (i as f64, j as f64);
            macro_rules! top {
                () => {
                    edge(2 * (j * w + i), fi, fj, fi + 1.0, fj, tl, tr)
                };
            }
            macro_rules! bottom {
                () => {
                    edge(2 * ((j + 1) * w + i), fi, fj + 1.0, fi + 1.0, fj + 1.0, bl, br)
                };
            }
            macro_rules! left {
                () => {
                    edge(2 * (j * w + i) + 1, fi, fj, fi, fj + 1.0, tl, bl)
                };
            }
            macro_rules! right {
                () => {
                    edge(2 * (j * w + i + 1) + 1, fi + 1.0, fj, fi + 1.0, fj + 1.0, tr, br)
                };
            }
            let mut seg = |a: usize, b: usize| {
                seg_a.push(a);
                seg_b.push(b);
            };
            match c {
                1 | 14 => {
                    let (a, b) = (left!(), bottom!());
                    seg(a, b)
                }
                2 | 13 => {
                    let (a, b) = (bottom!(), right!());
                    seg(a, b)
                }
                3 | 12 => {
                    let (a, b) = (left!(), right!());
                    seg(a, b)
                }
                4 | 11 => {
                    let (a, b) = (top!(), right!());
                    seg(a, b)
                }
                6 | 9 => {
                    let (a, b) = (top!(), bottom!());
                    seg(a, b)
                }
                7 | 8 => {
                    let (a, b) = (left!(), top!());
                    seg(a, b)
                }
                _ => {
                    // 5 oder 10: Sattel – die Mitte entscheidet
                    let center = (tl + tr + br + bl) / 4.0;
                    if (c == 5) == (center > iso) {
                        let (a, b) = (left!(), top!());
                        seg(a, b);
                        let (a, b) = (bottom!(), right!());
                        seg(a, b);
                    } else {
                        let (a, b) = (left!(), bottom!());
                        seg(a, b);
                        let (a, b) = (top!(), right!());
                        seg(a, b);
                    }
                }
            }
        }
    }
    // Segmente zu Ringen verketten
    let mut at: Vec<Vec<usize>> = vec![vec![]; px.len()];
    for s in 0..seg_a.len() {
        at[seg_a[s]].push(s);
        at[seg_b[s]].push(s);
    }
    let mut used = vec![false; seg_a.len()];
    let mut loops = Vec::new();
    for s in 0..seg_a.len() {
        if used[s] {
            continue;
        }
        used[s] = true;
        let start = seg_a[s];
        let mut cur = seg_b[s];
        let mut ids = vec![start, cur];
        let mut guard = 0;
        while cur != start && guard < seg_a.len() {
            guard += 1;
            let Some(next) = at[cur].iter().copied().find(|&k| !used[k]) else { break };
            used[next] = true;
            cur = if seg_a[next] == cur { seg_b[next] } else { seg_a[next] };
            ids.push(cur);
        }
        if cur == start {
            ids.pop();
        }
        if ids.len() >= 3 {
            loops.push(ids.iter().map(|&id| Pt { x: px[id], y: py[id] }).collect());
        }
    }
    loops
}

fn perp(p: Pt, a: Pt, b: Pt) -> f64 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let l2 = dx * dx + dy * dy;
    if l2 == 0.0 || l2.is_nan() {
        return hypot2(p.x - a.x, p.y - a.y);
    }
    let t = mx(0.0, mn(1.0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    hypot2(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

fn dp(pts: &[Pt], tol: f64) -> Vec<Pt> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let mut stack = vec![(0usize, pts.len() - 1)];
    while let Some((s, e)) = stack.pop() {
        let (mut md, mut idx) = (0.0, None);
        for i in s + 1..e {
            let d = perp(pts[i], pts[s], pts[e]);
            if d > md {
                md = d;
                idx = Some(i);
            }
        }
        if let Some(i) = idx.filter(|_| md > tol) {
            keep[i] = true;
            stack.push((s, i));
            stack.push((i, e));
        }
    }
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

pub fn simplify_closed(pts: &[Pt], tol: f64) -> Vec<Pt> {
    if pts.len() < 4 {
        return pts.to_vec();
    }
    let (mut far, mut fd) = (0, -1.0);
    for i in 1..pts.len() {
        let d = hypot2(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
        if d > fd {
            fd = d;
            far = i;
        }
    }
    let a = dp(&pts[..=far], tol);
    let mut tail = pts[far..].to_vec();
    tail.push(pts[0]);
    let b = dp(&tail, tol);
    a[..a.len() - 1].iter().chain(&b[..b.len() - 1]).copied().collect()
}

fn path_area(pts: &[Pt]) -> f64 {
    let mut a = 0.0;
    let n = pts.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
        j = i;
    }
    a / 2.0
}

fn trace(gray: &[f32], o: &Opts) -> Vec<Vec<Pt>> {
    let (w, h) = (o.w, o.h);
    let g = box_blur(gray, w, h, o.blur);
    // Rand von 1 Pixel "außen", damit sich alle Konturen schließen
    let (pw, ph) = (w + 2, h + 2);
    let mut v = vec![0f32; pw * ph];
    for y in 0..h {
        for x in 0..w {
            let val = g[y * w + x] as f64;
            v[(y + 1) * pw + x + 1] = (if o.invert { val } else { 255.0 - val }) as f32;
        }
    }
    let iso = if o.invert { o.threshold } else { 255.0 - o.threshold };
    marching_squares(&v, pw, ph, iso)
        .into_iter()
        .map(|l| simplify_closed(&l.iter().map(|p| Pt { x: p.x - 1.0, y: p.y - 1.0 }).collect::<Vec<_>>(), o.smooth * 0.5))
        .filter(|l| l.len() >= 3 && path_area(l).abs() >= mx(1.0, o.min_area))
        .collect()
}

fn trace_center(gray: &[f32], o: &Opts) -> Vec<TracePath> {
    let (w0, h0) = (o.w, o.h);
    let g = box_blur(gray, w0, h0, o.blur);
    let k = mn(1.0, CENTER_SIDE / mx(w0 as f64, h0 as f64));
    let w = mx(1.0, js_round(w0 as f64 * k)) as usize;
    let h = mx(1.0, js_round(h0 as f64 * k)) as usize;
    let mut mask = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let sy = mn((h0 - 1) as f64, (y as f64 / k).floor()) as usize;
            let sx = mn((w0 - 1) as f64, (x as f64 / k).floor()) as usize;
            let v = g[sy * w0 + sx] as f64;
            mask[y * w + x] = u8::from(if o.invert { v >= o.threshold } else { v < o.threshold });
        }
    }
    // Mindestlänge aus „Flecken ignorieren“ (Fläche → Seitenlänge), Vereinfachung aus „Glätten“
    let min_len = mx(3.0, o.min_area.sqrt() * k);
    centerlines(&mask, w, h, min_len, mx(0.3, o.smooth * 0.6))
        .into_iter()
        .map(|p| TracePath { pts: p.pts.iter().map(|q| Pt { x: q.x / k, y: q.y / k }).collect(), closed: p.closed })
        .collect()
}

pub fn trace_all(gray: &[f32], o: &Opts) -> Vec<TracePath> {
    if o.center {
        trace_center(gray, o)
    } else {
        trace(gray, o).into_iter().map(|pts| TracePath { pts, closed: true }).collect()
    }
}

// ---- Mittellinien (centerline.ts) ----

/// Zhang-Suen-Ausdünnung (ändert die Maske)
fn thin(m: &mut [u8], w: usize, h: usize) {
    let (wi, hi) = (w as i64, h as i64);
    let mut del: Vec<usize> = Vec::new();
    let mut changed = true;
    let mut guard = 0;
    while changed && guard < 500 {
        changed = false;
        for step in 0..2 {
            del.clear();
            for y in 0..hi {
                for x in 0..wi {
                    if m[(y * wi + x) as usize] == 0 {
                        continue;
                    }
                    let at = |x: i64, y: i64| if x < 0 || y < 0 || x >= wi || y >= hi { 0 } else { m[(y * wi + x) as usize] };
                    let p = [at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1)];
                    let b: u32 = p.iter().map(|&v| v as u32).sum();
                    if !(2..=6).contains(&b) {
                        continue;
                    }
                    let a = (0..8).filter(|&i| p[i] == 0 && p[(i + 1) % 8] != 0).count();
                    if a != 1 {
                        continue;
                    }
                    let on = |i: usize| p[i] != 0;
                    let keep = if step == 0 { (on(0) && on(2) && on(4)) || (on(2) && on(4) && on(6)) } else { (on(0) && on(2) && on(6)) || (on(0) && on(4) && on(6)) };
                    if keep {
                        continue;
                    }
                    del.push((y * wi + x) as usize);
                }
            }
            for &i in &del {
                m[i] = 0;
            }
            if !del.is_empty() {
                changed = true;
            }
        }
        guard += 1;
    }
}

const DIRS: [(i64, i64); 8] = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)];
const RING: [(i64, i64); 8] = [(0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1)];

fn trace_skeleton(m: &mut [u8], w: usize, h: usize) -> Vec<TracePath> {
    let (wi, hi) = (w as i64, h as i64);
    let on = |m: &[u8], x: i64, y: i64| x >= 0 && y >= 0 && x < wi && y < hi && m[(y * wi + x) as usize] == 1;
    let cross = |m: &[u8], x: i64, y: i64| {
        let (mut a, mut b) = (0, 0);
        for i in 0..8 {
            let (p, q) = (RING[i], RING[(i + 1) % 8]);
            if on(m, x + p.0, y + p.1) {
                b += 1;
            }
            if !on(m, x + p.0, y + p.1) && on(m, x + q.0, y + q.1) {
                a += 1;
            }
        }
        (a, b)
    };
    // Treppenstufen wegräumen
    let mut changed = true;
    let mut guard = 0;
    while changed && guard < 20 {
        changed = false;
        for y in 0..hi {
            for x in 0..wi {
                if !on(m, x, y) {
                    continue;
                }
                let (a, b) = cross(m, x, y);
                if a == 1 && b >= 2 {
                    m[(y * wi + x) as usize] = 0;
                    changed = true;
                }
            }
        }
        guard += 1;
    }
    let n = w * h;
    let mut kind = vec![0u8; n]; // 0 leer, 1 Ende, 2 Linie, 3 Kreuzung
    for y in 0..hi {
        for x in 0..wi {
            if !on(m, x, y) {
                continue;
            }
            let (a, b) = cross(m, x, y);
            kind[(y * wi + x) as usize] = if b <= 1 { 1 } else if a == 2 { 2 } else if a >= 3 { 3 } else { 1 };
        }
    }
    let m: &[u8] = m;
    let mut visited = vec![false; n];
    let pt = |i: usize| Pt { x: (i % w) as f64 + 0.5, y: (i / w) as f64 + 0.5 };
    // gerade Nachbarn zuerst, dann schräge
    let order: Vec<(i64, i64)> = DIRS.iter().filter(|d| d.0 == 0 || d.1 == 0).chain(DIRS.iter().filter(|d| d.0 != 0 && d.1 != 0)).copied().collect();
    let next_of = |visited: &[bool], cur: usize, prev: i64| -> i64 {
        let (x, y) = ((cur % w) as i64, (cur / w) as i64);
        let mut junction = -1i64;
        for &(dx, dy) in &order {
            if !on(m, x + dx, y + dy) {
                continue;
            }
            let nn = (y + dy) * wi + x + dx;
            if nn == prev {
                continue;
            }
            if !visited[nn as usize] {
                return nn;
            }
            if kind[nn as usize] == 3 && junction < 0 {
                junction = nn;
            }
        }
        junction
    };
    let walk = |visited: &mut Vec<bool>, start: usize, first: i64| -> Vec<usize> {
        let mut line = vec![start];
        if kind[start] != 3 {
            visited[start] = true;
        }
        let (mut prev, mut cur) = (start as i64, first);
        let mut g = 0;
        while g < n && cur >= 0 {
            let c = cur as usize;
            line.push(c);
            if kind[c] == 3 && line.len() > 1 && c != start {
                visited[c] = true;
                break;
            }
            visited[c] = true;
            let nx = next_of(visited, c, prev);
            if nx < 0 || (nx == start as i64 && line.len() < 3) {
                break;
            }
            prev = cur;
            cur = nx;
            g += 1;
        }
        line
    };
    let mut paths = Vec::new();
    let emit = |paths: &mut Vec<TracePath>, line: Vec<usize>| {
        if line.len() >= 2 {
            paths.push(TracePath { pts: line.into_iter().map(pt).collect(), closed: false });
        }
    };
    // 1. von Enden aus
    for i in 0..n {
        if kind[i] == 1 && !visited[i] {
            let nn = next_of(&visited, i, -1);
            if nn >= 0 {
                let line = walk(&mut visited, i, nn);
                emit(&mut paths, line);
            } else {
                visited[i] = true;
            }
        }
    }
    // 2. von Kreuzungen aus in jede noch freie Richtung
    for i in 0..n {
        if kind[i] == 3 {
            visited[i] = true;
            loop {
                let nn = next_of(&visited, i, -1);
                if nn < 0 || visited[nn as usize] {
                    break;
                }
                let line = walk(&mut visited, i, nn);
                emit(&mut paths, line);
            }
        }
    }
    // 3. Ringe
    for i in 0..n {
        if kind[i] != 0 && !visited[i] {
            let nn = next_of(&visited, i, -1);
            if nn < 0 {
                visited[i] = true;
                continue;
            }
            let mut line = walk(&mut visited, i, nn);
            let last = *line.last().unwrap();
            let (lx, ly, sx, sy) = ((last % w) as i64, (last / w) as i64, (i % w) as i64, (i / w) as i64);
            let closed = line.len() > 3 && (lx - sx).abs() <= 1 && (ly - sy).abs() <= 1;
            if closed {
                line.push(i);
            }
            paths.push(TracePath { pts: line.into_iter().map(pt).collect(), closed });
        }
    }
    paths
}

/// Douglas-Peucker für offene Linien (Ring: am entferntesten Punkt teilen)
fn simplify_open(pts: &[Pt], tol: f64) -> Vec<Pt> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let (f, l) = (pts[0], pts[pts.len() - 1]);
    if hypot2(f.x - l.x, f.y - l.y) < 1e-9 {
        let (mut far, mut best) = (1usize, -1.0);
        for (i, q) in pts.iter().enumerate() {
            let d = hypot2(q.x - f.x, q.y - f.y);
            if d > best {
                best = d;
                far = i;
            }
        }
        if far > 0 && far < pts.len() - 1 {
            let a = simplify_open(&pts[..=far], tol);
            return a[..a.len() - 1].iter().copied().chain(simplify_open(&pts[far..], tol)).collect();
        }
    }
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let mut stack = vec![(0usize, pts.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        let (pa, pb) = (pts[a], pts[b]);
        let (dx, dy) = (pb.x - pa.x, pb.y - pa.y);
        let ll = hypot2(dx, dy);
        let ll = if ll == 0.0 || ll.is_nan() { 1.0 } else { ll };
        let (mut best, mut bi) = (-1.0, 0usize);
        for i in a + 1..b {
            let d = ((pts[i].x - pa.x) * dy - (pts[i].y - pa.y) * dx).abs() / ll;
            if d > best {
                best = d;
                bi = i;
            }
        }
        if best > tol {
            keep[bi] = true;
            stack.push((a, bi));
            stack.push((bi, b));
        }
    }
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

fn length_of(p: &[Pt]) -> f64 {
    let mut s = 0.0;
    for i in 1..p.len() {
        s += hypot2(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    }
    s
}

fn centerlines(mask: &[u8], w: usize, h: usize, min_len: f64, tol: f64) -> Vec<TracePath> {
    let mut m = mask.to_vec();
    thin(&mut m, w, h);
    trace_skeleton(&mut m, w, h)
        .into_iter()
        .filter(|p| length_of(&p.pts) >= min_len)
        .map(|p| TracePath { pts: simplify_open(&p.pts, tol), closed: p.closed })
        .filter(|p| p.pts.len() >= 2)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Read;

    #[test]
    fn square_outline() {
        let mut g = vec![255f32; 100];
        for y in 3..7 {
            for x in 3..7 {
                g[y * 10 + x] = 0.0;
            }
        }
        let o = Opts { w: 10, h: 10, threshold: 128.0, invert: false, blur: 0, smooth: 1.0, min_area: 1.0, center: false };
        let r = run(&g, &o);
        assert_eq!((r.otsu, r.paths.len(), r.paths[0].pts.len()), (128.0, 1, 4));
    }

    /// Dieselben Fälle wie tests/imageTraceRust.test.ts: Zahlen auf 1e-9 genau, alles andere exakt
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
                    assert_eq!(x.len(), y.len(), "{at}: keys");
                    for (k, v) in x {
                        same(v, y.get(k).unwrap_or(&Value::Null), &format!("{at}.{k}"));
                    }
                }
                _ => assert_eq!(a, b, "{at}"),
            }
        }
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("imagetrace-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let all: Value = serde_json::from_str(&text).unwrap();
        let (images, cases) = (all["images"].as_array().unwrap(), all["cases"].as_array().unwrap());
        assert!(cases.len() >= 20, "only {} cases", cases.len());
        let mut points = 0;
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let o: Opts = serde_json::from_value(c["opts"].clone()).unwrap();
            let img = &images[c["image"].as_u64().unwrap() as usize];
            let gray: Vec<f32> = img.as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect();
            let got = serde_json::to_value(run(&gray, &o)).unwrap();
            same(&c["want"], &got, name);
            points += got["paths"].as_array().unwrap().iter().map(|p| p["pts"].as_array().unwrap().len()).sum::<usize>();
        }
        println!("{} trace cases, {points} points the same as traceCalc.ts", cases.len());
    }
}
