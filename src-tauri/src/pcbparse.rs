//! GERBER- UND EXCELLON-LESER – Zwilling von `parseGerber` (src/pcb/gerber.ts) und `parseExcellon` (src/pcb/excellon.ts).
//!
//! Gerber (RS-274X): Flächen in mm in Zeichen-Reihenfolge (Strich mit rundem Pinsel, Vieleck, Blitz einer Blende aus
//! Teilen), dazu die Mittellinien, die Dateifunktion und Hinweise. Excellon: Löcher und Langlöcher in mm.
//! Folgt dem TypeScript Zeile für Zeile, die Text-Muster sind von Hand nachgebaut. Bögen und Drehungen gehen über
//! Sinus/Kosinus: der Test vergleicht Zahlen auf 1e-9, alles andere exakt.
//! Gemeinsame Fälle: `tests/fixtures/pcbparse-cases.json` (festgehalten von `tests/pcbParseRust.test.ts`).

use crate::gcodesim::{hypot2, js_space, mn, mx};
use crate::importdxf::parse_float;
use crate::jsmath::{self, js_round};
use serde::Serialize;
use std::collections::HashMap;
use std::f64::consts::PI;

type Pt2 = [f64; 2];

#[derive(Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum Part {
    C { on: bool, c: [f64; 3] },
    P { on: bool, p: Vec<Pt2> },
}
impl Part {
    fn on(&self) -> bool {
        match self {
            Part::C { on, .. } | Part::P { on, .. } => *on,
        }
    }
}
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum GObj {
    Stroke { dark: bool, a: Pt2, b: Pt2, r: f64 },
    Poly { dark: bool, p: Vec<Pt2> },
    Flash { dark: bool, parts: Vec<Part> },
}
#[derive(Serialize, Debug, Default)]
pub struct GerberFile {
    pub objs: Vec<GObj>,
    pub lines: Vec<Vec<Pt2>>,
    pub func: String,
    pub warnings: Vec<String>,
}

const MAX_OBJS: usize = 400_000;
const ARC_TOL: f64 = 0.004;

/// `!deg`: 0 und „keine Zahl“ drehen nicht
fn rot(p: Pt2, deg: f64) -> Pt2 {
    if deg == 0.0 || deg.is_nan() {
        return p;
    }
    let a = deg * PI / 180.0;
    let (c, s) = (jsmath::cos(a), jsmath::sin(a));
    [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
}
/// `x || 0`
fn or0(v: Option<f64>) -> f64 {
    v.filter(|v| *v != 0.0 && !v.is_nan()).unwrap_or(0.0)
}
fn rect_pts(w: f64, h: f64) -> Vec<Pt2> {
    vec![[-w / 2.0, -h / 2.0], [w / 2.0, -h / 2.0], [w / 2.0, h / 2.0], [-w / 2.0, h / 2.0]]
}
pub fn arc_steps(r: f64, sweep: f64) -> f64 {
    if !(r > 0.0) {
        return 1.0;
    }
    let st = 2.0 * jsmath::acos(mx(0.0, 1.0 - mn(1.0, ARC_TOL / r)));
    mx(2.0, mn(720.0, (sweep.abs() / mx(1e-3, st)).ceil()))
}
fn steps(n: f64) -> usize {
    if n.is_nan() {
        0
    } else {
        n as usize
    }
}
fn obround(w: f64, h: f64) -> Vec<Pt2> {
    let r = mn(w, h) / 2.0;
    let n = arc_steps(r, PI);
    let (dx, dy) = (w / 2.0 - r, h / 2.0 - r);
    let mut out = vec![];
    let ns = steps(n);
    if w >= h {
        for i in 0..=ns {
            let a = -PI / 2.0 + PI * i as f64 / n;
            out.push([dx + r * jsmath::cos(a), r * jsmath::sin(a)]);
        }
        for i in 0..=ns {
            let a = PI / 2.0 + PI * i as f64 / n;
            out.push([-dx + r * jsmath::cos(a), r * jsmath::sin(a)]);
        }
    } else {
        for i in 0..=ns {
            let a = PI * i as f64 / n;
            out.push([r * jsmath::cos(a), dy + r * jsmath::sin(a)]);
        }
        for i in 0..=ns {
            let a = PI + PI * i as f64 / n;
            out.push([r * jsmath::cos(a), -dy + r * jsmath::sin(a)]);
        }
    }
    out
}
fn ngon(d: f64, n: f64, deg: f64) -> Vec<Pt2> {
    (0..steps(n)).map(|i| rot([d / 2.0, 0.0], deg + 360.0 * i as f64 / n)).collect()
}
fn circle_pts(x: f64, y: f64, r: f64) -> Vec<Pt2> {
    let n = mx(12.0, arc_steps(r, 2.0 * PI));
    (0..steps(n)).map(|i| [x + r * jsmath::cos(2.0 * PI * i as f64 / n), y + r * jsmath::sin(2.0 * PI * i as f64 / n)]).collect()
}

/// Rechenausdruck im Makro: Zahlen, $n, + - x /, Klammern. Err = „macro“
pub fn macro_expr(s: &str, vars: &HashMap<String, f64>) -> Result<f64, ()> {
    let src: Vec<char> = s.chars().filter(|c| !js_space(*c)).collect();
    let mut i = 0usize;
    fn prim(src: &[char], i: &mut usize, vars: &HashMap<String, f64>) -> Result<f64, ()> {
        match src.get(*i) {
            Some('(') => {
                *i += 1;
                let v = sum(src, i, vars)?;
                if src.get(*i) == Some(&')') {
                    *i += 1;
                }
                Ok(v)
            }
            Some('-') => {
                *i += 1;
                Ok(-prim(src, i, vars)?)
            }
            Some('+') => {
                *i += 1;
                prim(src, i, vars)
            }
            Some('$') => {
                let d0 = *i + 1;
                let mut e = d0;
                while e < src.len() && src[e].is_ascii_digit() {
                    e += 1;
                }
                if e == d0 {
                    return Err(());
                }
                *i = e;
                Ok(*vars.get(&src[d0..e].iter().collect::<String>()).unwrap_or(&0.0))
            }
            _ => {
                // ^(\d+\.?\d*|\.\d+)
                let s0 = *i;
                let mut e = s0;
                while e < src.len() && src[e].is_ascii_digit() {
                    e += 1;
                }
                if e > s0 {
                    if src.get(e) == Some(&'.') {
                        e += 1;
                        while e < src.len() && src[e].is_ascii_digit() {
                            e += 1;
                        }
                    }
                } else if src.get(e) == Some(&'.') && src.get(e + 1).is_some_and(|c| c.is_ascii_digit()) {
                    e += 1;
                    while e < src.len() && src[e].is_ascii_digit() {
                        e += 1;
                    }
                } else {
                    return Err(());
                }
                *i = e;
                Ok(parse_float(&src[s0..e].iter().collect::<String>()))
            }
        }
    }
    fn prod(src: &[char], i: &mut usize, vars: &HashMap<String, f64>) -> Result<f64, ()> {
        let mut v = prim(src, i, vars)?;
        while matches!(src.get(*i), Some('x' | 'X' | '/')) {
            let op = src[*i];
            *i += 1;
            let w = prim(src, i, vars)?;
            v = if op == '/' {
                if w != 0.0 && !w.is_nan() {
                    v / w
                } else {
                    0.0
                }
            } else {
                v * w
            };
        }
        Ok(v)
    }
    fn sum(src: &[char], i: &mut usize, vars: &HashMap<String, f64>) -> Result<f64, ()> {
        let mut v = prod(src, i, vars)?;
        while matches!(src.get(*i), Some('+' | '-')) {
            let op = src[*i];
            *i += 1;
            let w = prod(src, i, vars)?;
            v = if op == '+' { v + w } else { v - w };
        }
        Ok(v)
    }
    let v = sum(&src, &mut i, vars)?;
    if i < src.len() {
        return Err(());
    }
    Ok(v)
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}
fn no_ws(s: &str) -> String {
    s.chars().filter(|c| !js_space(*c)).collect()
}

/// Makro mit Werten zu Teilen (Datei-Einheiten)
fn run_macro(body: &[String], args: &[f64], warn: &mut dyn FnMut(&str)) -> Result<Vec<Part>, ()> {
    let mut vars: HashMap<String, f64> = HashMap::new();
    for (i, v) in args.iter().enumerate() {
        vars.insert((i + 1).to_string(), *v);
    }
    let mut out = vec![];
    for raw in body {
        let line = js_trim(raw);
        // leer oder Kommentar-Teil 0
        if line.is_empty() || (line.starts_with('0') && line[1..].chars().next().is_none_or(js_space)) {
            continue;
        }
        let compact = no_ws(line);
        if let Some(rest) = compact.strip_prefix('$') {
            let d: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !d.is_empty() && rest[d.len()..].starts_with('=') && rest.len() > d.len() + 1 {
                let v = macro_expr(&rest[d.len() + 1..], &vars)?;
                vars.insert(d, v);
                continue;
            }
        }
        let f: Vec<f64> = line.split(',').map(|x| macro_expr(x, &vars)).collect::<Result<_, _>>()?;
        let g = |k: usize| f.get(k).copied();
        let gn = |k: usize| f.get(k).copied().unwrap_or(f64::NAN);
        let code = js_round(gn(0));
        let on = g(1).unwrap_or(1.0) != 0.0;
        let rr = |pts: Vec<Pt2>, deg: f64| -> Vec<Pt2> { pts.into_iter().map(|p| rot(p, deg)).collect() };
        if code == 1.0 {
            let [x, y] = rot([or0(g(3)), or0(g(4))], or0(g(5)));
            out.push(Part::C { on, c: [x, y, or0(g(2)) / 2.0] });
        } else if code == 20.0 || code == 2.0 {
            let (w, x0, y0, x1, y1, deg) = (gn(2), gn(3), gn(4), gn(5), gn(6), g(7));
            let l = hypot2(x1 - x0, y1 - y0);
            let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
            let (nx, ny) = (-(y1 - y0) / l * w / 2.0, (x1 - x0) / l * w / 2.0);
            out.push(Part::P { on, p: rr(vec![[x0 + nx, y0 + ny], [x0 - nx, y0 - ny], [x1 - nx, y1 - ny], [x1 + nx, y1 + ny]], or0(deg)) });
        } else if code == 21.0 {
            let (w, h, x, y, deg) = (gn(2), gn(3), gn(4), gn(5), g(6));
            out.push(Part::P { on, p: rr(rect_pts(w, h).into_iter().map(|q| [q[0] + x, q[1] + y]).collect(), or0(deg)) });
        } else if code == 22.0 {
            let (w, h, x, y, deg) = (gn(2), gn(3), gn(4), gn(5), g(6));
            out.push(Part::P { on, p: rr(vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]], or0(deg)) });
        } else if code == 4.0 {
            let n = mx(0.0, js_round(gn(2)));
            let mut pts = vec![];
            for k in 0..steps(n) {
                pts.push([or0(g(3 + 2 * k)), or0(g(4 + 2 * k))]);
            }
            let degk = 3 + 2 * (steps(n) + 1);
            out.push(Part::P { on, p: rr(pts, or0(g(degk))) });
        } else if code == 5.0 {
            let (n, x, y, d, deg) = (gn(2), gn(3), gn(4), gn(5), g(6));
            let k = mx(3.0, mn(12.0, js_round(n)));
            out.push(Part::P { on, p: rr(ngon(d, k, 0.0).into_iter().map(|q| [q[0] + x, q[1] + y]).collect(), or0(deg)) });
        } else if code == 7.0 {
            let (x, y, od, id, gap, deg) = (gn(1), gn(2), gn(3), gn(4), gn(5), or0(g(6)));
            let c = rot([x, y], deg);
            out.push(Part::C { on: true, c: [c[0], c[1], od / 2.0] });
            out.push(Part::C { on: false, c: [c[0], c[1], id / 2.0] });
            for (w, h) in [(gap, od * 1.1), (od * 1.1, gap)] {
                out.push(Part::P { on: false, p: rr(rect_pts(w, h).into_iter().map(|q| [q[0] + x, q[1] + y]).collect(), deg) });
            }
        } else if code == 6.0 {
            let (x, y, od, th, gap, n, ct, cl, deg) = (gn(1), gn(2), gn(3), gn(4), gn(5), gn(6), gn(7), gn(8), or0(g(9)));
            let mut d = od;
            let lim = mn(20.0, js_round(n));
            let mut k = 0.0;
            while k < lim && d > 0.0 {
                out.push(Part::C { on: true, c: [x, y, d / 2.0] });
                if d - 2.0 * th > 0.0 {
                    out.push(Part::C { on: false, c: [x, y, d / 2.0 - th] });
                }
                k += 1.0;
                d -= 2.0 * (th + gap);
            }
            for (w, h) in [(ct, cl), (cl, ct)] {
                out.push(Part::P { on: true, p: rr(rect_pts(w, h).into_iter().map(|q| [q[0] + x, q[1] + y]).collect(), deg) });
            }
        } else {
            warn("macro");
        }
    }
    Ok(out)
}

/// konvexe Hülle (Monotone Chain), Reihenfolge wie im TypeScript
fn hull(pts: &[Pt2]) -> Vec<Pt2> {
    let mut s = pts.to_vec();
    s.sort_by(|a, b| {
        let d = a[0] - b[0];
        let d = if d != 0.0 && !d.is_nan() { d } else { a[1] - b[1] };
        d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    let half = |list: &[Pt2]| -> Vec<Pt2> {
        let mut h: Vec<Pt2> = vec![];
        for &p in list {
            while h.len() > 1 {
                let (a, b) = (h[h.len() - 2], h[h.len() - 1]);
                if (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) <= 0.0 {
                    h.pop();
                } else {
                    break;
                }
            }
            h.push(p);
        }
        h.pop();
        h
    };
    let mut out = half(&s);
    s.reverse();
    out.extend(half(&s));
    out
}

fn sweep(ax: f64, ay: f64, bx: f64, by: f64, cw: bool) -> f64 {
    let mut d = jsmath::atan2(by, bx) - jsmath::atan2(ay, ax);
    if cw {
        while d > 1e-12 {
            d -= 2.0 * PI;
        }
    } else {
        while d < -1e-12 {
            d += 2.0 * PI;
        }
    }
    d
}

fn shift(o: &GObj, dx: f64, dy: f64) -> GObj {
    let m = |p: Pt2| [p[0] + dx, p[1] + dy];
    match o {
        GObj::Stroke { dark, a, b, r } => GObj::Stroke { dark: *dark, a: m(*a), b: m(*b), r: *r },
        GObj::Poly { dark, p } => GObj::Poly { dark: *dark, p: p.iter().map(|q| m(*q)).collect() },
        GObj::Flash { dark, parts } => GObj::Flash {
            dark: *dark,
            parts: parts
                .iter()
                .map(|s| match s {
                    Part::C { on, c } => Part::C { on: *on, c: [c[0] + dx, c[1] + dy, c[2]] },
                    Part::P { on, p } => Part::P { on: *on, p: p.iter().map(|q| m(*q)).collect() },
                })
                .collect(),
        },
    }
}

struct Aperture {
    round: Option<f64>,
    parts: Vec<Part>,
}

/// `parseInt(s, 10)`
fn parse_int(s: &str) -> f64 {
    let t = js_trim(s);
    let (neg, r) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let d: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
    if d.is_empty() {
        return f64::NAN;
    }
    let v: f64 = d.parse().unwrap_or(f64::NAN);
    if neg {
        -v
    } else {
        v
    }
}
/// `+s` für Ziffernfolgen
fn plus(s: &str) -> f64 {
    s.parse().unwrap_or(f64::NAN)
}

/// Werte nach einem Buchstaben: [-+]?[\d.]+ (Länge 0 = keine)
fn value_len(c: &[char], i: usize) -> usize {
    let mut j = i + usize::from(matches!(c.get(i), Some('-' | '+')));
    let d0 = j;
    while j < c.len() && (c[j].is_ascii_digit() || c[j] == '.') {
        j += 1;
    }
    if j == d0 {
        0
    } else {
        j - i
    }
}

pub fn parse_gerber(text: &str) -> Result<GerberFile, String> {
    let mut st = Gerber::default();
    let c: Vec<char> = text.chars().collect();
    let n = c.len();
    let find = |ch: char, from: usize| (from..n).find(|&k| c[k] == ch);
    let mut i = 0;
    while i < n {
        if c[i] == '%' {
            let e = find('%', i + 1);
            let body: String = c[i + 1..e.unwrap_or(n)].iter().collect();
            i = e.map_or(n, |e| e + 1);
            let parts: Vec<String> = body.split('*').map(|q| js_trim(&q.replace(['\r', '\n'], "")).to_string()).filter(|q| !q.is_empty()).collect();
            if parts.is_empty() {
                continue;
            }
            if parts[0].starts_with("AM") {
                st.ext(&parts)?;
            } else {
                for p in &parts {
                    st.ext(std::slice::from_ref(p))?;
                }
            }
            continue;
        }
        let e = find('*', i);
        let pct = find('%', i);
        if e.is_none() || (pct.is_some() && pct < e) {
            i = pct.unwrap_or(n);
            continue;
        }
        let e = e.unwrap();
        let cmd: String = c[i..e].iter().filter(|ch| !js_space(**ch)).collect();
        i = e + 1;
        if !cmd.is_empty() && st.cmd(&cmd)? {
            break;
        }
    }
    st.end_contour()?;
    st.close_sr()?;
    Ok(GerberFile { objs: st.objs, lines: st.lines, func: st.func, warnings: st.warnings })
}

#[derive(Default)]
struct Gerber {
    objs: Vec<GObj>,
    lines: Vec<Vec<Pt2>>,
    func: String,
    warnings: Vec<String>,
    unit: f64,
    int_x: usize,
    dec_x: usize,
    int_y: usize,
    dec_y: usize,
    trailing: bool,
    /// D-Nummer -> Blende; gewählt wird die Blende selbst (wie im TypeScript: spätere Neudefinition ändert sie nicht)
    ap: HashMap<i64, usize>,
    arena: Vec<Aperture>,
    macros: HashMap<String, Vec<String>>,
    cur: Option<usize>,
    light: bool,
    interp: u8,
    single: bool,
    region: bool,
    op: i64,
    incremental: bool,
    x: f64,
    y: f64,
    lm: String,
    lr: f64,
    ls: f64,
    contour: Vec<Pt2>,
    sr: Option<(f64, f64, f64, f64, usize)>,
    started: bool,
}

impl Gerber {
    fn init(&mut self) {
        if !self.started {
            self.started = true;
            self.int_x = 2;
            self.dec_x = 4;
            self.int_y = 2;
            self.dec_y = 4;
            self.interp = 1;
            self.op = 2;
            self.lm = "N".into();
            self.ls = 1.0;
        }
    }
    fn warn(&mut self, w: &str) {
        if !self.warnings.iter().any(|x| x == w) {
            self.warnings.push(w.to_string());
        }
    }
    #[allow(non_snake_case)]
    fn U(&mut self) -> f64 {
        if self.unit == 0.0 {
            self.warn("units");
            self.unit = 1.0;
        }
        self.unit
    }
    fn push(&mut self, o: GObj) -> Result<(), String> {
        self.objs.push(o);
        if self.objs.len() > MAX_OBJS {
            return Err("too-big".into());
        }
        Ok(())
    }
    fn coord(&mut self, s: &str, ints: usize, dec: usize) -> f64 {
        if s.contains('.') {
            return parse_float(s) * self.U();
        }
        let neg = s.starts_with('-');
        let d = s.strip_prefix(['+', '-']).unwrap_or(s);
        let v = if self.trailing {
            let mut p = d.to_string();
            while p.chars().count() < ints + dec {
                p.push('0');
            }
            parse_int(&p)
        } else {
            parse_int(d)
        };
        (if neg { -1.0 } else { 1.0 }) * v / 10f64.powi(dec as i32) * self.U()
    }
    fn close_sr(&mut self) -> Result<(), String> {
        let Some((nx, ny, dx, dy, from)) = self.sr.take() else { return Ok(()) };
        let block: Vec<GObj> = self.objs[from..].to_vec();
        let mut j = 0.0;
        while j < ny {
            let mut i = 0.0;
            while i < nx {
                if !(i == 0.0 && j == 0.0) {
                    for o in &block {
                        let s = shift(o, i * dx, j * dy);
                        self.push(s)?;
                    }
                }
                i += 1.0;
            }
            j += 1.0;
        }
        Ok(())
    }
    fn end_contour(&mut self) -> Result<(), String> {
        if self.contour.len() >= 3 {
            let p = std::mem::take(&mut self.contour);
            let dark = !self.light;
            self.push(GObj::Poly { dark, p })?;
        }
        self.contour.clear();
        Ok(())
    }
    fn tf(&self, p: Pt2, px: f64, py: f64) -> Pt2 {
        let mut q = [p[0] * self.ls, p[1] * self.ls];
        if self.lm.contains('X') {
            q = [-q[0], q[1]];
        }
        if self.lm.contains('Y') {
            q = [q[0], -q[1]];
        }
        q = rot(q, self.lr);
        [q[0] + px, q[1] + py]
    }
    fn place(&self, s: &Part, px: f64, py: f64) -> Part {
        match s {
            Part::C { on, c } => {
                let p = self.tf([c[0], c[1]], px, py);
                Part::C { on: *on, c: [p[0], p[1], c[2] * self.ls] }
            }
            Part::P { on, p } => Part::P { on: *on, p: p.iter().map(|q| self.tf(*q, px, py)).collect() },
        }
    }
    fn flash(&mut self) -> Result<(), String> {
        let Some(a) = self.cur.map(|k| &self.arena[k]) else {
            self.warn("aperture");
            return Ok(());
        };
        if !a.parts.is_empty() {
            let parts = a.parts.iter().map(|s| self.place(s, self.x, self.y)).collect();
            self.push(GObj::Flash { dark: !self.light, parts })?;
        }
        Ok(())
    }
    fn stroke_to(&mut self, pts: Vec<Pt2>) -> Result<(), String> {
        match self.lines.last_mut() {
            Some(last) if { let e = last[last.len() - 1]; hypot2(e[0] - pts[0][0], e[1] - pts[0][1]) < 1e-9 } => last.extend_from_slice(&pts[1..]),
            _ => self.lines.push(pts.clone()),
        }
        let Some(a) = self.cur.map(|k| &self.arena[k]) else {
            self.warn("aperture");
            return Ok(());
        };
        let dark = !self.light;
        if let Some(round) = a.round {
            let r = round * self.ls;
            for i in 1..pts.len() {
                self.push(GObj::Stroke { dark, a: pts[i - 1], b: pts[i], r })?;
            }
            return Ok(());
        }
        // anderer Pinsel: konvexe Hülle aus Anfang und Ende je Stück
        let parts: Vec<Part> = a.parts.iter().filter(|s| s.on()).cloned().collect();
        for i in 1..pts.len() {
            let at = |p: Pt2| -> Vec<Pt2> {
                parts
                    .iter()
                    .flat_map(|s| match self.place(s, p[0], p[1]) {
                        Part::C { c, .. } => circle_pts(c[0], c[1], c[2]),
                        Part::P { p, .. } => p,
                    })
                    .collect()
            };
            let mut all = at(pts[i - 1]);
            all.extend(at(pts[i]));
            let h = hull(&all);
            if h.len() >= 3 {
                self.push(GObj::Poly { dark, p: h })?;
            }
        }
        Ok(())
    }
    fn mv(&mut self, nx: f64, ny: f64, ox: f64, oy: f64) -> Result<(), String> {
        let (x, y) = (self.x, self.y);
        let pts: Vec<Pt2> = if self.interp == 1 {
            vec![[x, y], [nx, ny]]
        } else {
            let cw = self.interp == 2;
            let (mut cx, mut cy) = (x + ox, y + oy);
            if self.single {
                // Viertelkreis-Modus: I/J ohne Vorzeichen – die Mitte suchen, die passt
                let mut best = f64::INFINITY;
                for sx in [1.0, -1.0] {
                    for sy in [1.0, -1.0] {
                        let (tx, ty) = (x + sx * ox.abs(), y + sy * oy.abs());
                        let e = (hypot2(x - tx, y - ty) - hypot2(nx - tx, ny - ty)).abs();
                        let sw = sweep(x - tx, y - ty, nx - tx, ny - ty, cw);
                        if sw.abs() <= PI / 2.0 + 0.01 && e < best {
                            best = e;
                            cx = tx;
                            cy = ty;
                        }
                    }
                }
            }
            let r = hypot2(x - cx, y - cy);
            let mut sw = sweep(x - cx, y - cy, nx - cx, ny - cy, cw);
            if !self.single && hypot2(nx - x, ny - y) < 1e-9 {
                sw = if cw { -2.0 * PI } else { 2.0 * PI };
            }
            let n = arc_steps(r, sw);
            let a0 = jsmath::atan2(y - cy, x - cx);
            let r1 = hypot2(nx - cx, ny - cy);
            let mut pts = vec![[x, y]];
            let mut k = 1.0;
            while k < n {
                let a = a0 + sw * k / n;
                let rr = r + (r1 - r) * k / n;
                pts.push([cx + rr * jsmath::cos(a), cy + rr * jsmath::sin(a)]);
                k += 1.0;
            }
            pts.push([nx, ny]);
            pts
        };
        if self.region {
            if self.contour.is_empty() {
                self.contour.push(pts[0]);
            }
            self.contour.extend_from_slice(&pts[1..]);
            Ok(())
        } else {
            self.stroke_to(pts)
        }
    }

    fn ext(&mut self, block: &[String]) -> Result<(), String> {
        self.init();
        let head = block[0].as_str();
        let hc: Vec<char> = head.chars().collect();
        // ^FS([LTD])?([AI])X(\d)(\d)Y(\d)(\d)
        if head.starts_with("FS") {
            let mut k = 2;
            let mut z = None;
            if matches!(hc.get(k), Some('L' | 'T' | 'D')) {
                z = hc.get(k).copied();
                k += 1;
            }
            let fs = (|| {
                let ai = *hc.get(k).filter(|c| matches!(c, 'A' | 'I'))?;
                if hc.get(k + 1) != Some(&'X') || hc.get(k + 4) != Some(&'Y') {
                    return None;
                }
                let dg = |j: usize| hc.get(j).and_then(|c| c.to_digit(10)).map(|d| d as usize);
                Some((ai, dg(k + 2)?, dg(k + 3)?, dg(k + 5)?, dg(k + 6)?))
            })();
            if let Some((ai, a, b, cc, d)) = fs {
                self.trailing = z == Some('T');
                self.incremental = ai == 'I';
                self.int_x = a;
                self.dec_x = b;
                self.int_y = cc;
                self.dec_y = d;
                return Ok(());
            }
        }
        if head.starts_with("MOMM") {
            self.unit = 1.0;
            return Ok(());
        }
        if head.starts_with("MOIN") {
            self.unit = 25.4;
            return Ok(());
        }
        if let Some(name) = head.strip_prefix("AM") {
            self.macros.insert(name.to_string(), block[1..].to_vec());
            return Ok(());
        }
        // ^ADD(\d+)([A-Za-z_.$][\w.$-]*),?(.*)$
        if let Some(rest) = head.strip_prefix("ADD") {
            let rc: Vec<char> = rest.chars().collect();
            let dl = rc.iter().take_while(|c| c.is_ascii_digit()).count();
            let first_ok = rc.get(dl).is_some_and(|c| c.is_ascii_alphabetic() || matches!(c, '_' | '.' | '$'));
            if dl > 0 && first_ok {
                let mut e = dl + 1;
                while e < rc.len() && (rc[e].is_ascii_alphanumeric() || matches!(rc[e], '_' | '.' | '$' | '-')) {
                    e += 1;
                }
                let code = plus(&rc[..dl].iter().collect::<String>()) as i64;
                let name: String = rc[dl..e].iter().collect();
                let mut tail: String = rc[e..].iter().collect();
                if tail.starts_with(',') {
                    tail.remove(0);
                }
                let u = self.U();
                let v: Vec<f64> = if tail.is_empty() { vec![] } else { tail.split(['x', 'X']).map(parse_float).collect() };
                let vg = |k: usize| v.get(k).copied();
                let vn = |k: usize| v.get(k).copied().unwrap_or(f64::NAN);
                let hole = |d: Option<f64>| -> Vec<Part> {
                    match d {
                        Some(d) if d != 0.0 && !d.is_nan() && d > 0.0 => vec![Part::C { on: false, c: [0.0, 0.0, d * u / 2.0] }],
                        _ => vec![],
                    }
                };
                let mut a: Option<Aperture> = None;
                if name == "C" {
                    let round = if vg(1).is_some_and(|h| h > 0.0) { None } else { Some(or0(vg(0)) * u / 2.0) };
                    let mut parts = vec![Part::C { on: true, c: [0.0, 0.0, or0(vg(0)) * u / 2.0] }];
                    parts.extend(hole(vg(1)));
                    a = Some(Aperture { round, parts });
                } else if name == "R" {
                    let mut parts = vec![Part::P { on: true, p: rect_pts(vn(0) * u, vn(1) * u) }];
                    parts.extend(hole(vg(2)));
                    a = Some(Aperture { round: None, parts });
                } else if name == "O" {
                    let mut parts = vec![Part::P { on: true, p: obround(vn(0) * u, vn(1) * u) }];
                    parts.extend(hole(vg(2)));
                    a = Some(Aperture { round: None, parts });
                } else if name == "P" {
                    let mut parts = vec![Part::P { on: true, p: ngon(vn(0) * u, mx(3.0, mn(12.0, js_round(vn(1)))), or0(vg(2))) }];
                    parts.extend(hole(vg(3)));
                    a = Some(Aperture { round: None, parts });
                } else if let Some(body) = self.macros.get(&name).cloned() {
                    let mut ws: Vec<String> = vec![];
                    match run_macro(&body, &v, &mut |w| ws.push(w.to_string())) {
                        Ok(parts) => {
                            let parts = parts
                                .into_iter()
                                .map(|s| match s {
                                    Part::C { on, c } => Part::C { on, c: [c[0] * u, c[1] * u, c[2] * u] },
                                    Part::P { on, p } => Part::P { on, p: p.into_iter().map(|q| [q[0] * u, q[1] * u]).collect() },
                                })
                                .collect();
                            for w in ws {
                                self.warn(&w);
                            }
                            a = Some(Aperture { round: None, parts });
                        }
                        Err(()) => {
                            for w in ws {
                                self.warn(&w);
                            }
                            self.warn("macro");
                        }
                    }
                    // ein einzelner Kreis um die Mitte ist ein runder Pinsel
                    if let Some(ap) = a.as_mut() {
                        if ap.parts.len() == 1 {
                            if let Part::C { on: true, c } = ap.parts[0] {
                                if hypot2(c[0], c[1]) < 1e-9 {
                                    ap.round = Some(c[2]);
                                }
                            }
                        }
                    }
                } else {
                    self.warn("aperture");
                }
                if a.as_ref().is_some_and(|a| {
                    a.parts.iter().any(|s| match s {
                        Part::C { c, .. } => c.iter().any(|q| !q.is_finite()),
                        Part::P { p, .. } => p.iter().any(|q| !q[0].is_finite() || !q[1].is_finite()),
                    })
                }) {
                    self.warn("aperture");
                    a = None;
                }
                match a {
                    Some(a) => {
                        self.arena.push(a);
                        self.ap.insert(code, self.arena.len() - 1);
                    }
                    None => {
                        self.ap.remove(&code);
                    }
                }
                return Ok(());
            }
        }
        if head.starts_with("LPD") || head.starts_with("LPC") {
            self.light = hc[2] != 'D';
            return Ok(());
        }
        if let Some(r) = head.strip_prefix("LM") {
            self.lm = r.to_string();
            return Ok(());
        }
        if let Some(r) = head.strip_prefix("LR") {
            let v = parse_float(r);
            self.lr = if v == 0.0 || v.is_nan() { 0.0 } else { v };
            return Ok(());
        }
        if let Some(r) = head.strip_prefix("LS") {
            let v = parse_float(r);
            self.ls = if v == 0.0 || v.is_nan() { 1.0 } else { v };
            return Ok(());
        }
        if head.starts_with("SR") {
            self.close_sr()?;
            // ^SRX(\d+)Y(\d+)I([-+\d.]+)J([-+\d.]+)
            let m = (|| {
                let r = head.strip_prefix("SRX")?;
                let a: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
                let r = r[a.len()..].strip_prefix('Y').filter(|_| !a.is_empty())?;
                let b: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
                let r = r[b.len()..].strip_prefix('I').filter(|_| !b.is_empty())?;
                let ci: String = r.chars().take_while(|c| c.is_ascii_digit() || matches!(c, '-' | '+' | '.')).collect();
                let r = r[ci.len()..].strip_prefix('J').filter(|_| !ci.is_empty())?;
                let cj: String = r.chars().take_while(|c| c.is_ascii_digit() || matches!(c, '-' | '+' | '.')).collect();
                if cj.is_empty() {
                    return None;
                }
                Some((plus(&a), plus(&b), ci, cj))
            })();
            if let Some((a, b, ci, cj)) = m {
                if (a > 1.0 || b > 1.0) && a * b <= 10000.0 {
                    let dx = parse_float(&ci) * self.U();
                    let dy = parse_float(&cj) * self.U();
                    self.sr = Some((a, b, dx, dy, self.objs.len()));
                }
            }
            return Ok(());
        }
        if head.starts_with("AB") {
            self.warn("block");
            return Ok(());
        }
        if head.starts_with("TF") {
            if let Some(f) = head.strip_prefix("TF.FileFunction,") {
                if !f.is_empty() {
                    self.func = f.to_string();
                }
            }
            return Ok(());
        }
        if head.starts_with("IPNEG") {
            self.warn("negative");
            return Ok(());
        }
        if ["TA", "TO", "TD", "IP", "LN", "IN", "OF", "MI", "SF", "AS", "IR", "IF", "KO"].iter().any(|p| head.starts_with(p)) {
            return Ok(());
        }
        self.warn("syntax");
        Ok(())
    }

    /// Rückgabe true = Programmende (M00/M01/M02)
    fn cmd(&mut self, line: &str) -> Result<bool, String> {
        self.init();
        let lc: Vec<char> = line.chars().collect();
        // ^G0?4 = Kommentar
        if lc.first() == Some(&'G') && (lc.get(1) == Some(&'4') || (lc.get(1) == Some(&'0') && lc.get(2) == Some(&'4'))) {
            if let Some(p) = line.find("TF.FileFunction,") {
                let r: String = line[p + 16..].chars().take_while(|c| *c != '*').collect();
                if !r.is_empty() && self.func.is_empty() {
                    self.func = js_trim(&r).to_string();
                }
            }
            return Ok(false);
        }
        let mut s: &[char] = &lc;
        // ^G0*(\d+) wiederholt
        while s.first() == Some(&'G') {
            let mut k = 1;
            while s.get(k) == Some(&'0') {
                k += 1;
            }
            let mut e = k;
            while e < s.len() && s[e].is_ascii_digit() {
                e += 1;
            }
            // \d+ braucht mindestens eine Ziffer: bei lauter Nullen gibt 0* eine zurück
            let (k, e) = if e == k && k > 1 { (k - 1, k) } else { (k, e) };
            if e == k {
                break;
            }
            let n = plus(&s[k..e].iter().collect::<String>());
            s = &s[e..];
            match n as i64 {
                1..=3 => self.interp = n as u8,
                36 => {
                    self.region = true;
                    self.contour.clear();
                }
                37 => {
                    self.end_contour()?;
                    self.region = false;
                }
                74 => self.single = true,
                75 => self.single = false,
                70 => self.unit = 25.4,
                71 => self.unit = 1.0,
                90 => self.incremental = false,
                91 => self.incremental = true,
                54 | 55 => {}
                _ => self.warn("syntax"),
            }
        }
        // ^M0*[0-2]
        if s.first() == Some(&'M') {
            let mut k = 1;
            while s.get(k) == Some(&'0') {
                k += 1;
            }
            // 0* gibt nach, wenn danach keine 0-2 kommt
            let hit = matches!(s.get(k), Some('0'..='2')) || (k > 1 && matches!(s.get(k - 1), Some('0')));
            if hit {
                return Ok(true);
            }
        }
        // ^((?:[XYIJ][-+]?[\d.]+)*)(?:D0*(\d+))?$
        let mut j = 0;
        while j < s.len() && matches!(s[j], 'X' | 'Y' | 'I' | 'J') {
            let l = value_len(s, j + 1);
            if l == 0 {
                break;
            }
            j += 1 + l;
        }
        let coords: String = s[..j].iter().collect();
        let mut dcode: Option<f64> = None;
        let mut k = j;
        if s.get(k) == Some(&'D') {
            let e = (k + 1..s.len()).find(|&q| !s[q].is_ascii_digit()).unwrap_or(s.len());
            if e > k + 1 {
                dcode = Some(plus(&s[k + 1..e].iter().collect::<String>()));
                k = e;
            }
        }
        if k != s.len() {
            if !s.is_empty() {
                self.warn("syntax");
            }
            return Ok(false);
        }
        if let Some(d) = dcode.filter(|d| *d >= 10.0) {
            self.cur = self.ap.get(&(d as i64)).copied();
            if self.cur.is_none() {
                self.warn("aperture");
            }
            return Ok(false);
        }
        let cc: Vec<char> = coords.chars().collect();
        let get = |letter: char| -> Option<String> {
            (0..cc.len()).find_map(|q| {
                if cc[q] != letter {
                    return None;
                }
                let l = value_len(&cc, q + 1);
                (l > 0).then(|| cc[q + 1..q + 1 + l].iter().collect())
            })
        };
        if let Some(d) = dcode {
            self.op = d as i64;
        } else if coords.is_empty() {
            return Ok(false);
        }
        let (gx, gy, gi, gj) = (get('X'), get('Y'), get('I'), get('J'));
        let nx = match gx {
            None => self.x,
            Some(v) => self.coord(&v, self.int_x, self.dec_x) + if self.incremental { self.x } else { 0.0 },
        };
        let ny = match gy {
            None => self.y,
            Some(v) => self.coord(&v, self.int_y, self.dec_y) + if self.incremental { self.y } else { 0.0 },
        };
        if self.op == 1 {
            let ox = match gi {
                None => 0.0,
                Some(v) => self.coord(&v, self.int_x, self.dec_x),
            };
            let oy = match gj {
                None => 0.0,
                Some(v) => self.coord(&v, self.int_y, self.dec_y),
            };
            self.mv(nx, ny, ox, oy)?;
        } else if self.op == 2 && self.region {
            self.end_contour()?;
        }
        self.x = nx;
        self.y = ny;
        if self.op == 3 {
            self.flash()?;
        }
        Ok(false)
    }
}

// =====================================================================
// EXCELLON
// =====================================================================

#[derive(Serialize, Debug, Clone, Copy)]
pub struct Hole {
    pub x: f64,
    pub y: f64,
    pub d: f64,
}
#[derive(Serialize, Debug, Clone)]
pub struct Slot {
    pub pts: Vec<Pt2>,
    pub d: f64,
}
#[derive(Serialize, Debug)]
pub struct DrillFile {
    pub holes: Vec<Hole>,
    pub slots: Vec<Slot>,
    pub plated: String,
    pub guessed: bool,
    pub warnings: Vec<String>,
}

const MAX_DRILL: usize = 200_000;

/// Erstes Vorkommen von Buchstabe + `[-+]?[\d.]+` in s
fn letter_value(s: &[char], letter: char) -> Option<String> {
    (0..s.len()).find_map(|q| {
        if s[q] != letter {
            return None;
        }
        let l = value_len(s, q + 1);
        (l > 0).then(|| s[q + 1..q + 1 + l].iter().collect())
    })
}

struct Drill {
    holes: Vec<Hole>,
    slots: Vec<Slot>,
    warnings: Vec<String>,
    unit: f64,
    zeros: char,
    int_n: usize,
    dec: usize,
    no_point: bool,
    dia: f64,
    x: f64,
    y: f64,
    inc: bool,
    path: Vec<Pt2>,
}
impl Drill {
    fn warn(&mut self, w: &str) {
        if !self.warnings.iter().any(|x| x == w) {
            self.warnings.push(w.into());
        }
    }
    fn num(&mut self, s: &str) -> f64 {
        if s.contains('.') {
            return parse_float(s) * self.unit;
        }
        self.no_point = true;
        let neg = s.starts_with('-');
        let d = s.strip_prefix(['+', '-']).unwrap_or(s);
        let i = if self.int_n != 0 { self.int_n } else if self.unit == 1.0 { 3 } else { 2 };
        let f = if self.dec != 0 { self.dec } else if self.unit == 1.0 { 3 } else { 4 };
        let v = if self.zeros == 'L' {
            let mut p = d.to_string();
            while p.chars().count() < i + f {
                p.push('0');
            }
            parse_int(&p)
        } else {
            parse_int(d)
        };
        (if neg { -1.0 } else { 1.0 }) * v / 10f64.powi(f as i32) * self.unit
    }
    fn go(&mut self, s: &[char]) -> bool {
        let (mx_, my_) = (letter_value(s, 'X'), letter_value(s, 'Y'));
        if mx_.is_none() && my_.is_none() {
            return false;
        }
        let nx = mx_.map(|v| self.num(&v));
        let ny = my_.map(|v| self.num(&v));
        if let Some(v) = nx {
            self.x = if self.inc { self.x + v } else { v };
        }
        if let Some(v) = ny {
            self.y = if self.inc { self.y + v } else { v };
        }
        true
    }
    fn add(&mut self) -> Result<(), String> {
        if !(self.dia > 0.0) {
            self.warn("tool");
            return Ok(());
        }
        self.holes.push(Hole { x: self.x, y: self.y, d: self.dia });
        if self.holes.len() + self.slots.len() > MAX_DRILL {
            return Err("too-big".into());
        }
        Ok(())
    }
    fn end_path(&mut self) {
        if self.path.len() > 1 {
            if self.dia > 0.0 {
                let p = std::mem::take(&mut self.path);
                self.slots.push(Slot { pts: p, d: self.dia });
            } else {
                self.warn("tool");
            }
        }
        self.path.clear();
    }
}

fn ci_find(s: &str, pat: &str) -> Option<usize> {
    s.to_ascii_lowercase().find(&pat.to_ascii_lowercase())
}

pub fn parse_excellon(text: &str) -> Result<DrillFile, String> {
    let mut d = Drill { holes: vec![], slots: vec![], warnings: vec![], unit: 25.4, zeros: ' ', int_n: 0, dec: 0, no_point: false, dia: 0.0, x: 0.0, y: 0.0, inc: false, path: vec![] };
    let (mut known, mut explicit, mut route, mut down, mut header) = (false, false, false, false, false);
    let mut mode = 0;
    let (mut plated, mut type_plated) = (String::new(), String::new());
    let mut tools: HashMap<i64, f64> = HashMap::new();
    // split(/\r\n|\r|\n/)
    let mut lines: Vec<&str> = vec![];
    let b = text.as_bytes();
    let (mut s0, mut i) = (0, 0);
    while i < b.len() {
        if b[i] == b'\r' || b[i] == b'\n' {
            lines.push(&text[s0..i]);
            i += if b[i] == b'\r' && b.get(i + 1) == Some(&b'\n') { 2 } else { 1 };
            s0 = i;
        } else {
            i += 1;
        }
    }
    lines.push(&text[s0..]);
    for raw in lines {
        let line = js_trim(raw);
        if line.is_empty() {
            continue;
        }
        if line.starts_with(';') {
            // FILE_FORMAT\s*=\s*(\d)\s*:\s*(\d)
            if let Some(p) = ci_find(line, "FILE_FORMAT") {
                let r: Vec<char> = line[p + 11..].chars().collect();
                let mut k = 0;
                let sk = |k: &mut usize| {
                    while *k < r.len() && js_space(r[*k]) {
                        *k += 1;
                    }
                };
                sk(&mut k);
                if r.get(k) == Some(&'=') {
                    k += 1;
                    sk(&mut k);
                    if let Some(a) = r.get(k).and_then(|c| c.to_digit(10)) {
                        k += 1;
                        sk(&mut k);
                        if r.get(k) == Some(&':') {
                            k += 1;
                            sk(&mut k);
                            if let Some(bb) = r.get(k).and_then(|c| c.to_digit(10)) {
                                d.int_n = a as usize;
                                d.dec = bb as usize;
                                explicit = true;
                            }
                        }
                    }
                }
            }
            let up = line.to_ascii_uppercase();
            let type_is = |want: &str| -> bool {
                // TYPE\s*=\s*NON_?PLATED bzw. PLATED
                let mut from = 0;
                while let Some(p) = up[from..].find("TYPE").map(|p| p + from) {
                    let r = up[p + 4..].trim_start_matches(|c: char| js_space(c));
                    if let Some(r) = r.strip_prefix('=') {
                        let r = r.trim_start_matches(|c: char| js_space(c));
                        if want == "NON" && (r.starts_with("NONPLATED") || r.starts_with("NON_PLATED")) {
                            return true;
                        }
                        if want == "P" && r.starts_with("PLATED") {
                            return true;
                        }
                    }
                    from = p + 1;
                }
                false
            };
            if type_is("NON") {
                type_plated = "nonplated".into();
            } else if type_is("P") {
                type_plated = "plated".into();
            }
            if let Some(p) = ci_find(line, "FileFunction,") {
                let r = &up[p + 13..];
                if r.starts_with("PLATED") {
                    plated = "plated".into();
                } else if r.starts_with("NONPLATED") {
                    plated = "nonplated".into();
                }
            }
            continue;
        }
        let s: String = line.chars().filter(|c| !js_space(*c)).collect::<String>().to_uppercase();
        let sc: Vec<char> = s.chars().collect();
        if s == "M48" {
            header = true;
            continue;
        }
        if s == "%" || s == "M95" {
            header = false;
            continue;
        }
        // ^(METRIC|INCH)(?:,(LZ|TZ))?(?:,(0+)\.(0+))?
        let unit_word = if s.starts_with("METRIC") { Some(("METRIC", 1.0)) } else if s.starts_with("INCH") { Some(("INCH", 25.4)) } else { None };
        if let Some((w, u)) = unit_word {
            d.unit = u;
            known = true;
            let mut r = &s[w.len()..];
            if let Some(z) = r.strip_prefix(",LZ").or_else(|| r.strip_prefix(",TZ")) {
                d.zeros = r.as_bytes()[1] as char;
                r = z;
            }
            if let Some(f) = r.strip_prefix(',') {
                let a = f.chars().take_while(|c| *c == '0').count();
                if a > 0 && f[a..].starts_with('.') {
                    let bb = f[a + 1..].chars().take_while(|c| *c == '0').count();
                    if bb > 0 {
                        d.int_n = a;
                        d.dec = bb;
                        explicit = true;
                    }
                }
            }
            continue;
        }
        match s.as_str() {
            "M71" => {
                d.unit = 1.0;
                known = true;
                continue;
            }
            "M72" => {
                d.unit = 25.4;
                known = true;
                continue;
            }
            "G90" | "ICI,OFF" => {
                d.inc = false;
                continue;
            }
            "G91" | "ICI" | "ICI,ON" => {
                d.inc = true;
                continue;
            }
            "M30" | "M00" => {
                d.end_path();
                if s == "M30" {
                    break;
                }
                continue;
            }
            "M15" | "Z-1" => {
                down = true;
                d.path = vec![[d.x, d.y]];
                continue;
            }
            "M16" | "M17" => {
                down = false;
                d.end_path();
                continue;
            }
            "G05" => {
                route = false;
                d.end_path();
                continue;
            }
            _ => {}
        }
        let skip = ["FMAT", "VER", "DETECT", "ATC", "G93", "M25", "M01", "M08", "R,", "G40", "G41", "G42"].iter().any(|p| s.starts_with(p))
            || (s.starts_with('F') && sc.get(1).is_some_and(|c| c.is_ascii_digit()))
            || (s.starts_with('S') && sc.get(1).is_some_and(|c| c.is_ascii_digit()))
            || (header && s.starts_with('T') && sc.get(1).is_some_and(|c| c.is_ascii_digit()) && {
                let k = 1 + sc[1..].iter().take_while(|c| c.is_ascii_digit()).count();
                !sc[k..].contains(&'C')
            });
        if skip {
            continue;
        }
        // Werkzeug: ^T(\d+)(.*)$
        if s.starts_with('T') && sc.get(1).is_some_and(|c| c.is_ascii_digit()) {
            let k = 1 + sc[1..].iter().take_while(|c| c.is_ascii_digit()).count();
            let num = plus(&sc[1..k].iter().collect::<String>()) as i64;
            let rest: Vec<char> = sc[k..].to_vec();
            // C([\d.]+)
            let cval = (0..rest.len()).find_map(|q| {
                if rest[q] != 'C' {
                    return None;
                }
                let l = rest[q + 1..].iter().take_while(|c| c.is_ascii_digit() || **c == '.').count();
                (l > 0).then(|| rest[q + 1..q + 1 + l].iter().collect::<String>())
            });
            if let Some(cv) = &cval {
                tools.insert(num, parse_float(cv) * d.unit);
            }
            if !header || cval.is_none() {
                d.end_path();
                if num != 0 {
                    d.dia = tools.get(&num).copied().unwrap_or(0.0);
                    if d.dia == 0.0 || d.dia.is_nan() {
                        d.dia = 0.0;
                        d.warn("tool");
                    }
                }
            }
            continue;
        }
        // ^G0*([0123])(?=[XY]|$)
        let g = (|| {
            if !s.starts_with('G') {
                return None;
            }
            let mut k = 1;
            while sc.get(k) == Some(&'0') {
                k += 1;
            }
            // 0* gibt nach: „G0“ allein oder „G00X…“
            let tryk = |k: usize| -> Option<u32> {
                let dg = sc.get(k).filter(|c| matches!(c, '0'..='3'))?.to_digit(10)?;
                matches!(sc.get(k + 1), None | Some('X' | 'Y')).then_some(dg)
            };
            tryk(k).or_else(|| if k > 1 { tryk(k - 1) } else { None })
        })();
        if let Some(gv) = g {
            mode = gv;
            route = true;
            if mode == 0 {
                d.end_path();
                d.go(&sc);
                continue;
            }
        }
        // ^((?:[XY][-+]?[\d.]+)+)G85((?:[XY][-+]?[\d.]+)+)
        let xy_run = |from: usize| -> usize {
            let mut j = from;
            while j < sc.len() && matches!(sc[j], 'X' | 'Y') {
                let l = value_len(&sc, j + 1);
                if l == 0 {
                    break;
                }
                j += 1 + l;
            }
            j
        };
        let a_end = xy_run(0);
        if a_end > 0 && s[a_end..].starts_with("G85") {
            let b_end = xy_run(a_end + 3);
            if b_end > a_end + 3 {
                d.go(&sc[..a_end]);
                let a = [d.x, d.y];
                d.go(&sc[a_end + 3..b_end]);
                if d.dia > 0.0 {
                    let dia = d.dia;
                    d.slots.push(Slot { pts: vec![a, [d.x, d.y]], d: dia });
                } else {
                    d.warn("tool");
                }
                continue;
            }
        }
        // ^R0*(\d+)((?:[XY][-+]?[\d.]+)+)
        if s.starts_with('R') {
            let dl = sc[1..].iter().take_while(|c| c.is_ascii_digit()).count();
            let e = xy_run(1 + dl);
            if dl > 0 && e > 1 + dl {
                let reps = plus(&sc[1..1 + dl].iter().collect::<String>());
                let part = &sc[1 + dl..e];
                let (mxv, myv) = (letter_value(part, 'X'), letter_value(part, 'Y'));
                let dx = mxv.map_or(0.0, |v| d.num(&v));
                let dy = myv.map_or(0.0, |v| d.num(&v));
                let mut k = 0.0;
                while k < mn(reps, 5000.0) {
                    d.x += dx;
                    d.y += dy;
                    d.add()?;
                    k += 1.0;
                }
                continue;
            }
        }
        // ^(G0*[123])?[XY]
        let after_g = (|| {
            if !s.starts_with('G') {
                return Some(0);
            }
            let mut k = 1;
            while sc.get(k) == Some(&'0') {
                k += 1;
            }
            if matches!(sc.get(k), Some('1'..='3')) {
                return Some(k + 1);
            }
            None
        })();
        if after_g.is_some_and(|k| matches!(sc.get(k), Some('X' | 'Y'))) || matches!(sc.first(), Some('X' | 'Y')) {
            let (x0, y0) = (d.x, d.y);
            if !d.go(&sc) {
                continue;
            }
            if route || down {
                if mode == 2 || mode == 3 {
                    arc_to(&mut d, x0, y0, &sc, mode == 2);
                    continue;
                }
                if down || (route && mode == 1) {
                    if d.path.is_empty() {
                        d.path.push([x0, y0]);
                    }
                    let p = [d.x, d.y];
                    d.path.push(p);
                }
            } else {
                d.add()?;
            }
            continue;
        }
        if !sc.iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || matches!(c, ',' | '.' | '-')) || !header {
            d.warn("syntax");
        }
    }
    d.end_path();
    if !known {
        d.warn("units");
    }
    let plated_out = if plated.is_empty() { type_plated } else { plated };
    Ok(DrillFile { holes: d.holes, slots: d.slots, plated: plated_out, guessed: d.no_point && !explicit, warnings: d.warnings })
}

/// Bogen in einem gefrästen Langloch: Radius A oder Mittelpunkt I/J
fn arc_to(d: &mut Drill, x0: f64, y0: f64, s: &[char], cw: bool) {
    let (x1, y1) = (d.x, d.y);
    if d.path.is_empty() {
        d.path.push([x0, y0]);
    }
    let (a, i, j) = (letter_value(s, 'A'), letter_value(s, 'I'), letter_value(s, 'J'));
    let dd = hypot2(x1 - x0, y1 - y0);
    let (cx, cy);
    if i.is_some() || j.is_some() {
        cx = x0 + i.map_or(0.0, |v| d.num(&v));
        cy = y0 + j.map_or(0.0, |v| d.num(&v));
    } else if a.is_some() && dd > 1e-9 {
        let r = mx(d.num(&a.unwrap()), dd / 2.0);
        let h = mx(0.0, r * r - dd * dd / 4.0).sqrt();
        let sg = if cw { 1.0 } else { -1.0 };
        cx = (x0 + x1) / 2.0 + sg * h * (y1 - y0) / dd;
        cy = (y0 + y1) / 2.0 - sg * h * (x1 - x0) / dd;
    } else {
        d.warn("syntax");
        d.path.push([x1, y1]);
        return;
    }
    let mut sw = jsmath::atan2(y1 - cy, x1 - cx) - jsmath::atan2(y0 - cy, x0 - cx);
    if cw {
        while sw > 1e-12 {
            sw -= 2.0 * PI;
        }
    } else {
        while sw < -1e-12 {
            sw += 2.0 * PI;
        }
    }
    let a0 = jsmath::atan2(y0 - cy, x0 - cx);
    let r = hypot2(x0 - cx, y0 - cy);
    let n = mx(2.0, mn(200.0, (sw.abs() * r.sqrt() * 8.0).ceil()));
    let mut k = 1.0;
    while k < n {
        d.path.push([cx + r * jsmath::cos(a0 + sw * k / n), cy + r * jsmath::sin(a0 + sw * k / n)]);
        k += 1.0;
    }
    d.path.push([x1, y1]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn small_pieces() {
        let v = HashMap::from([("1".to_string(), 2.0)]);
        assert_eq!(macro_expr("$1x3+(4-1)/3", &v), Ok(7.0));
        assert!(macro_expr("2+", &v).is_err());
        let g = parse_gerber("%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.5*%\nD10*\nX10000Y0D02*\nX20000Y0D01*\nM02*\n").unwrap();
        assert_eq!((g.objs.len(), g.lines.len()), (1, 1));
        let e = parse_excellon("M48\nMETRIC\nT1C0.8\n%\nT1\nX1.0Y2.0\nM30\n").unwrap();
        assert_eq!((e.holes.len(), e.holes[0].d), (1, 0.8));
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
        let cases: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("pcbparse-cases.json")).unwrap()).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 30, "only {} cases", cases.len());
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let text = c["text"].as_str().unwrap();
            let got = if c["kind"] == "gerber" {
                parse_gerber(text).map(|g| serde_json::to_value(g).unwrap())
            } else {
                parse_excellon(text).map(|g| serde_json::to_value(g).unwrap())
            };
            match got {
                Ok(v) => same(&c["want"], &v, name),
                Err(e) => assert_eq!(c["want"]["error"].as_str(), Some(e.as_str()), "{name}"),
            }
        }
        println!("{} Gerber and Excellon files read the same as the TypeScript", cases.len());
    }
}
