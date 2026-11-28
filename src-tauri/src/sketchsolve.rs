//! SKIZZEN-BEDINGUNGEN – Zwilling von `src/editor/sketchSolve.ts` (circumcircle, residual, satisfied, solve, freedom).
//!
//! Bedingungen an Strecken, Punkten und Kreisen (waagerecht, parallel, gleich lang, aufeinander, Tangente …). Lösen mit
//! dem Newton-Verfahren und kleinstem gewichtetem Schritt, Jacobi-Matrix numerisch, Gauß mit Spaltenpivot; Freiheiten
//! = Unbekannte − Rang. Folgt dem TypeScript Zeile für Zeile (Reihenfolge der Unbekannten wie die Map dort). Nur
//! Vergleich: was in die Zeichnung geschrieben wird, bestimmt weiter das Fenster (constrainTool.ts).
//! Gemeinsame Fälle: `tests/fixtures/sketchsolve-cases.json.gz`.

use crate::gcodesim::{hypot2, mx};
use crate::jsmath;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::f64::consts::PI;

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct P {
    pub x: f64,
    pub y: f64,
}
#[derive(Deserialize, Clone, Debug)]
pub struct SegRef {
    pub id: String,
    pub i: usize,
    pub j: usize,
}
#[derive(Deserialize, Clone, Debug)]
pub struct PtRef {
    pub id: String,
    pub i: usize,
}
#[derive(Deserialize, Clone, Debug)]
pub struct CirRef {
    pub id: String,
    #[serde(default)]
    pub arc: Option<bool>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "k")]
pub enum GCon {
    #[serde(rename = "h")]
    H { a: SegRef },
    #[serde(rename = "v")]
    V { a: SegRef },
    #[serde(rename = "par")]
    Par { a: SegRef, b: SegRef },
    #[serde(rename = "perp")]
    Perp { a: SegRef, b: SegRef },
    #[serde(rename = "eq")]
    Eq { a: SegRef, b: SegRef },
    #[serde(rename = "len")]
    Len { a: SegRef, v: f64 },
    #[serde(rename = "ang")]
    Ang { a: SegRef, b: SegRef, v: f64 },
    #[serde(rename = "coin")]
    Coin { p: PtRef, q: PtRef },
    #[serde(rename = "fix")]
    Fix { p: PtRef, at: P },
    #[serde(rename = "onLine")]
    OnLine { p: PtRef, a: SegRef },
    #[serde(rename = "rad")]
    Rad { c: CirRef, v: f64 },
    #[serde(rename = "conc")]
    Conc { c: CirRef, d: CirRef },
    #[serde(rename = "eqR")]
    EqR { c: CirRef, d: CirRef },
    #[serde(rename = "tanL")]
    TanL { a: SegRef, c: CirRef },
    #[serde(rename = "tanC")]
    TanC { c: CirRef, d: CirRef, inner: bool },
    #[serde(rename = "onCirc")]
    OnCirc { p: PtRef, c: CirRef },
}

/// Formen in der Reihenfolge der Map im Fenster
pub type Shapes = Vec<(String, Vec<P>)>;

/// Umkreis durch drei Punkte (None = auf einer Geraden)
pub fn circumcircle(a: P, b: P, c: P) -> Option<(P, f64)> {
    let d = 2.0 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if d.abs() < 1e-12 {
        return None;
    }
    let (a2, b2, c2) = (a.x * a.x + a.y * a.y, b.x * b.x + b.y * b.y, c.x * c.x + c.y * c.y);
    let x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    let y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    Some((P { x, y }, hypot2(a.x - x, a.y - y)))
}

fn seg_refs(s: &SegRef) -> [(String, usize); 2] {
    [(s.id.clone(), s.i), (s.id.clone(), s.j)]
}
fn cir_refs(r: &CirRef) -> Vec<(String, usize)> {
    if r.arc == Some(true) {
        vec![(r.id.clone(), 0), (r.id.clone(), 1), (r.id.clone(), 2)]
    } else {
        vec![(r.id.clone(), 0), (r.id.clone(), 1)]
    }
}

/// Alle Punkte, die eine Bedingung braucht
pub fn refs_of(c: &GCon) -> Vec<(String, usize)> {
    use GCon::*;
    match c {
        H { a } | V { a } | Len { a, .. } => seg_refs(a).to_vec(),
        Par { a, b } | Perp { a, b } | Eq { a, b } | Ang { a, b, .. } => [seg_refs(a), seg_refs(b)].concat(),
        Coin { p, q } => vec![(p.id.clone(), p.i), (q.id.clone(), q.i)],
        Fix { p, .. } => vec![(p.id.clone(), p.i)],
        OnLine { p, a } => [vec![(p.id.clone(), p.i)], seg_refs(a).to_vec()].concat(),
        Rad { c, .. } => cir_refs(c),
        Conc { c, d } | EqR { c, d } | TanC { c, d, .. } => [cir_refs(c), cir_refs(d)].concat(),
        TanL { a, c } => [seg_refs(a).to_vec(), cir_refs(c)].concat(),
        OnCirc { p, c } => [vec![(p.id.clone(), p.i)], cir_refs(c)].concat(),
    }
}

/// Fehler einer Bedingung (0 = erfüllt)
pub fn residual(c: &GCon, get: &dyn Fn(&str, usize) -> P) -> Vec<f64> {
    use GCon::*;
    let seg = |s: &SegRef| {
        let (a, b) = (get(&s.id, s.i), get(&s.id, s.j));
        P { x: b.x - a.x, y: b.y - a.y }
    };
    let circ = |r: &CirRef| -> (P, f64) {
        if r.arc != Some(true) {
            return (get(&r.id, 0), get(&r.id, 1).x);
        }
        circumcircle(get(&r.id, 0), get(&r.id, 1), get(&r.id, 2)).unwrap_or((get(&r.id, 2), 1e9))
    };
    // `x || 1`
    let or1 = |v: f64| if v == 0.0 || v.is_nan() { 1.0 } else { v };
    match c {
        H { a } => vec![seg(a).y],
        V { a } => vec![seg(a).x],
        Len { a, v } => {
            let d = seg(a);
            vec![hypot2(d.x, d.y) - v]
        }
        Eq { a, b } => {
            let (d, e) = (seg(a), seg(b));
            vec![hypot2(d.x, d.y) - hypot2(e.x, e.y)]
        }
        Par { a, b } | Perp { a, b } => {
            let (d, e) = (seg(a), seg(b));
            let l = or1(hypot2(d.x, d.y) * hypot2(e.x, e.y));
            let v = if matches!(c, Par { .. }) { d.x * e.y - d.y * e.x } else { d.x * e.x + d.y * e.y };
            vec![v / l]
        }
        Coin { p, q } => {
            let (p, q) = (get(&p.id, p.i), get(&q.id, q.i));
            vec![p.x - q.x, p.y - q.y]
        }
        Fix { p, at } => {
            let p = get(&p.id, p.i);
            vec![p.x - at.x, p.y - at.y]
        }
        OnLine { p, a } => {
            let (pp, aa, d) = (get(&p.id, p.i), get(&a.id, a.i), seg(a));
            let l = or1(hypot2(d.x, d.y));
            vec![(d.x * (pp.y - aa.y) - d.y * (pp.x - aa.x)) / l]
        }
        Ang { a, b, v } => {
            let (d, e) = (seg(a), seg(b));
            let l = or1(hypot2(d.x, d.y) * hypot2(e.x, e.y));
            let t = (v * PI) / 180.0;
            vec![((d.x * e.y - d.y * e.x) * jsmath::cos(t) - (d.x * e.x + d.y * e.y) * jsmath::sin(t)) / l]
        }
        Rad { c, v } => vec![circ(c).1 - v],
        EqR { c, d } => vec![circ(c).1 - circ(d).1],
        Conc { c, d } => {
            let (p, q) = (circ(c).0, circ(d).0);
            vec![p.x - q.x, p.y - q.y]
        }
        TanL { a, c } => {
            let (aa, d) = (get(&a.id, a.i), seg(a));
            let l = or1(hypot2(d.x, d.y));
            let k = circ(c);
            vec![(d.x * (k.0.y - aa.y) - d.y * (k.0.x - aa.x)).abs() / l - k.1]
        }
        TanC { c, d, inner } => {
            let (k1, k2) = (circ(c), circ(d));
            vec![hypot2(k1.0.x - k2.0.x, k1.0.y - k2.0.y) - if *inner { (k1.1 - k2.1).abs() } else { k1.1 + k2.1 }]
        }
        OnCirc { p, c } => {
            let (pp, k) = (get(&p.id, p.i), circ(c));
            vec![hypot2(pp.x - k.0.x, pp.y - k.0.y) - k.1]
        }
    }
}

fn is_angle(c: &GCon) -> bool {
    matches!(c, GCon::Par { .. } | GCon::Perp { .. } | GCon::Ang { .. })
}

fn find<'a>(shapes: &'a Shapes, id: &str) -> Option<&'a Vec<P>> {
    shapes.iter().find(|(k, _)| k == id).map(|(_, v)| v)
}

/// Gilt die Bedingung? Im Fenster läuft das für die Farben bei jedem Zeichnen – dort nicht verglichen, nur vom Test
#[allow(dead_code)]
pub fn satisfied(c: &GCon, shapes: &Shapes, tol: f64) -> bool {
    let get = |id: &str, i: usize| find(shapes, id).unwrap()[i];
    residual(c, &get).iter().all(|r| r.abs() <= if is_angle(c) { 1e-5 } else { tol })
}

/// Sind alle Punkte der Bedingung vorhanden?
pub fn valid(c: &GCon, shapes: &Shapes) -> bool {
    refs_of(c).iter().all(|(id, i)| find(shapes, id).is_some_and(|s| *i < s.len()))
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct SolveResult {
    pub ok: bool,
    pub shapes: Vec<(String, Vec<P>)>,
    pub iterations: usize,
}

/// Gauß-Elimination mit Spaltenpivot, None = singulär
fn gauss(a: &[Vec<f64>], b: &[f64]) -> Option<Vec<f64>> {
    let m = b.len();
    let mut mm: Vec<Vec<f64>> = a
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let mut r = row.clone();
            r.push(b[i]);
            r
        })
        .collect();
    for c in 0..m {
        let mut piv = c;
        for r in c + 1..m {
            if mm[r][c].abs() > mm[piv][c].abs() {
                piv = r;
            }
        }
        if mm[piv][c].abs() < 1e-300 {
            return None;
        }
        mm.swap(c, piv);
        for r in c + 1..m {
            let f = mm[r][c] / mm[c][c];
            if f == 0.0 {
                continue;
            }
            for k in c..=m {
                let v = mm[c][k];
                mm[r][k] -= f * v;
            }
        }
    }
    let mut y = vec![0.0; m];
    for r in (0..m).rev() {
        let mut s = mm[r][m];
        for k in r + 1..m {
            s -= mm[r][k] * y[k];
        }
        y[r] = s / mm[r][r];
    }
    Some(y)
}

/// Bedingungen erfüllen, mit möglichst kleinen Verschiebungen. weights: je Form das Gewicht jedes Punkts (fehlt = 1)
pub fn solve(shapes: &Shapes, cons: &[GCon], weights: &HashMap<String, Vec<f64>>, max_iter: usize) -> SolveResult {
    let mut out: Shapes = shapes.clone();
    let use_: Vec<&GCon> = cons.iter().filter(|c| valid(c, &out)).collect();
    if use_.is_empty() {
        return SolveResult { ok: true, shapes: out, iterations: 0 };
    }
    // Unbekannte: x und y jedes beteiligten Punkts
    let mut idx: HashMap<String, usize> = HashMap::new();
    let mut vars: Vec<(String, usize)> = vec![];
    for c in &use_ {
        for (id, i) in refs_of(c) {
            let k = format!("{id}#{i}");
            if let std::collections::hash_map::Entry::Vacant(e) = idx.entry(k) {
                e.insert(vars.len());
                vars.push((id, i));
            }
        }
    }
    let n = vars.len() * 2;
    let mut x = vec![0.0f64; n];
    for (k, (id, i)) in vars.iter().enumerate() {
        let p = find(&out, id).unwrap()[*i];
        x[2 * k] = p.x;
        x[2 * k + 1] = p.y;
    }
    let mut w = vec![0.0f64; n];
    for (k, (id, i)) in vars.iter().enumerate() {
        let wt = weights.get(id).and_then(|v| v.get(*i)).copied().unwrap_or(1.0);
        let v = mx(1e-6, wt);
        w[2 * k] = v;
        w[2 * k + 1] = v;
    }
    let mut scale = 1.0f64;
    for v in &x {
        scale = mx(scale, v.abs());
    }
    let tol_of = |c: &GCon| if is_angle(c) { 1e-10 } else { 1e-9 * scale };
    let res_at = |xs: &[f64], c: &GCon| {
        let get = |id: &str, i: usize| {
            let k = idx[&format!("{id}#{i}")];
            P { x: xs[2 * k], y: xs[2 * k + 1] }
        };
        residual(c, &get)
    };
    let rows = |xs: &[f64]| -> Vec<(usize, f64)> { use_.iter().enumerate().flat_map(|(ci, c)| res_at(xs, c).into_iter().map(move |v| (ci, v))).collect() };
    let mut iter = 0;
    while iter < max_iter {
        let r = rows(&x);
        if r.iter().all(|(ci, v)| v.abs() <= tol_of(use_[*ci])) {
            break;
        }
        let m = r.len();
        let mut jm: Vec<Vec<f64>> = vec![vec![0.0; n]; m];
        let mut row = 0;
        for c in &use_ {
            let mut cols: Vec<usize> = vec![];
            for (id, i) in refs_of(c) {
                let k = idx[&format!("{id}#{i}")];
                for col in [2 * k, 2 * k + 1] {
                    if !cols.contains(&col) {
                        cols.push(col);
                    }
                }
            }
            let base = res_at(&x, c);
            for col in cols {
                let h = 1e-7 * mx(1.0, x[col].abs());
                let old = x[col];
                x[col] = old + h;
                let fp = res_at(&x, c);
                x[col] = old - h;
                let fm = res_at(&x, c);
                x[col] = old;
                for q in 0..base.len() {
                    jm[row + q][col] = (fp[q] - fm[q]) / (2.0 * h);
                }
            }
            row += base.len();
        }
        // kleinster gewichteter Schritt: Δ = -W⁻¹ Jᵀ (J W⁻¹ Jᵀ + μI)⁻¹ r
        let mut a: Vec<Vec<f64>> = vec![vec![0.0; m]; m];
        let mut trace = 0.0;
        for ai in 0..m {
            for bi in ai..m {
                let mut s = 0.0;
                let (ja, jb) = (&jm[ai], &jm[bi]);
                for k in 0..n {
                    if ja[k] != 0.0 && jb[k] != 0.0 {
                        s += (ja[k] * jb[k]) / w[k];
                    }
                }
                a[ai][bi] = s;
                a[bi][ai] = s;
                if ai == bi {
                    trace += s;
                }
            }
        }
        let mu = 1e-10 * (trace / mx(1.0, m as f64)) + 1e-14;
        for (ai, row) in a.iter_mut().enumerate() {
            row[ai] += mu;
        }
        let rv: Vec<f64> = r.iter().map(|q| q.1).collect();
        let Some(y) = gauss(&a, &rv) else {
            return SolveResult { ok: false, shapes: shapes.clone(), iterations: iter };
        };
        let mut step_max = 0.0f64;
        for k in 0..n {
            let mut s = 0.0;
            for ai in 0..m {
                s += jm[ai][k] * y[ai];
            }
            let d = -s / w[k];
            x[k] += d;
            step_max = mx(step_max, d.abs());
        }
        if !step_max.is_finite() {
            return SolveResult { ok: false, shapes: shapes.clone(), iterations: iter };
        }
        iter += 1;
    }
    let fin = rows(&x);
    let ok = fin.iter().all(|(ci, v)| {
        let c = use_[*ci];
        v.abs() <= mx(tol_of(c) * 1e3, if is_angle(c) { 1e-7 } else { 1e-6 * scale })
    });
    if !ok {
        return SolveResult { ok: false, shapes: shapes.clone(), iterations: iter };
    }
    let g = |id: &str, i: usize| {
        let k = idx[&format!("{id}#{i}")];
        P { x: x[2 * k], y: x[2 * k + 1] }
    };
    for c in &use_ {
        use GCon::*;
        let segs: Vec<&SegRef> = match c {
            Par { a, b } | Perp { a, b } | Eq { a, b } | Ang { a, b, .. } => vec![a, b],
            H { a } | V { a } | Len { a, .. } | OnLine { a, .. } | TanL { a, .. } => vec![a],
            _ => vec![],
        };
        for s in segs {
            let orig = find(shapes, &s.id).unwrap();
            let (a0, b0, a1, b1) = (orig[s.i], orig[s.j], g(&s.id, s.i), g(&s.id, s.j));
            if hypot2(b0.x - a0.x, b0.y - a0.y) > 1e-9 && hypot2(b1.x - a1.x, b1.y - a1.y) < 1e-6 * scale {
                return SolveResult { ok: false, shapes: shapes.clone(), iterations: iter };
            }
        }
    }
    for (k, (id, i)) in vars.iter().enumerate() {
        let pts = &mut out.iter_mut().find(|(s, _)| s == id).unwrap().1;
        pts[*i] = P { x: x[2 * k], y: x[2 * k + 1] };
    }
    SolveResult { ok: true, shapes: out, iterations: iter }
}

/// Rang einer Matrix (Gauß mit relativer Toleranz)
fn rank(m: &[Vec<f64>]) -> usize {
    let mut a: Vec<Vec<f64>> = m.to_vec();
    let rows_n = a.len();
    let cols_n = if rows_n > 0 { a[0].len() } else { 0 };
    let mut scale = 0.0f64;
    for r in &a {
        for v in r {
            scale = mx(scale, v.abs());
        }
    }
    let tol = 1e-7 * mx(1.0, scale);
    let mut rk = 0;
    let mut c = 0;
    while c < cols_n && rk < rows_n {
        let mut piv = rk;
        for r in rk + 1..rows_n {
            if a[r][c].abs() > a[piv][c].abs() {
                piv = r;
            }
        }
        if a[piv][c].abs() <= tol {
            c += 1;
            continue;
        }
        a.swap(rk, piv);
        for r in rk + 1..rows_n {
            let f = a[r][c] / a[rk][c];
            if f == 0.0 {
                continue;
            }
            for k in c..cols_n {
                let v = a[rk][k];
                a[r][k] -= f * v;
            }
        }
        rk += 1;
        c += 1;
    }
    rk
}

/// Wie viele Freiheiten bleiben? (0 = voll bestimmt). Bei Kreisen zählt vom zweiten „Punkt“ nur x (der Radius)
pub fn freedom(shapes: &Shapes, cons: &[GCon], circles: &[String]) -> usize {
    let use_: Vec<&GCon> = cons.iter().filter(|c| valid(c, shapes)).collect();
    let mut cols: HashMap<String, usize> = HashMap::new();
    for (id, pts) in shapes {
        for i in 0..pts.len() {
            // cols.set(key, cols.size): ein doppelter Schlüssel bekommt die aktuelle Größe, ohne zu wachsen
            let len = cols.len();
            cols.insert(format!("{id}#{i}#x"), len);
            if !(circles.contains(id) && i == 1) {
                let len = cols.len();
                cols.insert(format!("{id}#{i}#y"), len);
            }
        }
    }
    let n = cols.len();
    if use_.is_empty() {
        return n;
    }
    let mut x: Shapes = shapes.clone();
    let mut rows: Vec<Vec<f64>> = vec![];
    for c in &use_ {
        let base = {
            let get = |id: &str, i: usize| find(&x, id).unwrap()[i];
            residual(c, &get)
        };
        let mut local = vec![vec![0.0; n]; base.len()];
        for (id, i) in refs_of(c) {
            for ax in ['x', 'y'] {
                let Some(&col) = cols.get(&format!("{id}#{i}#{ax}")) else { continue };
                let si = x.iter().position(|(s, _)| *s == id).unwrap();
                let old = if ax == 'x' { x[si].1[i].x } else { x[si].1[i].y };
                let h = 1e-6 * mx(1.0, old.abs());
                let set = |x: &mut Shapes, v: f64| if ax == 'x' { x[si].1[i].x = v } else { x[si].1[i].y = v };
                set(&mut x, old + h);
                let fp = {
                    let get = |id: &str, i: usize| find(&x, id).unwrap()[i];
                    residual(c, &get)
                };
                set(&mut x, old - h);
                let fm = {
                    let get = |id: &str, i: usize| find(&x, id).unwrap()[i];
                    residual(c, &get)
                };
                set(&mut x, old);
                for (q, v) in fp.iter().enumerate() {
                    local[q][col] = (v - fm[q]) / (2.0 * h);
                }
            }
        }
        rows.extend(local);
    }
    n - rank(&rows)
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
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("sketchsolve-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let cases: Value = serde_json::from_str(&text).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 20, "only {} cases", cases.len());
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let shapes: Shapes = serde_json::from_value(c["shapes"].clone()).unwrap();
            let cons: Vec<GCon> = serde_json::from_value(c["cons"].clone()).unwrap();
            let weights: HashMap<String, Vec<f64>> = serde_json::from_value(c["weights"].clone()).unwrap();
            let circles: Vec<String> = serde_json::from_value(c["circles"].clone()).unwrap();
            let r = solve(&shapes, &cons, &weights, 60);
            let sat: Vec<Option<bool>> = cons.iter().map(|k| valid(k, &r.shapes).then(|| satisfied(k, &r.shapes, 1e-3))).collect();
            let got = serde_json::json!({ "ok": r.ok, "shapes": r.shapes, "iterations": r.iterations, "free": freedom(&shapes, &cons, &circles), "sat": sat });
            same(&got, &c["want"], name);
        }
        println!("{} constraint sets solved the same as sketchSolve.ts", cases.len());
    }
}
