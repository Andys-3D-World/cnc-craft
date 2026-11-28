//! DREHEN – Zwilling von `planLathe` und `latheGcode` in `src/lathe/turn.ts` (Bahnen und G-Code der Drehbank).
//!
//! Folgt dem TypeScript Zeile für Zeile. Die Winkelfunktionen der Werkzeugform (Sinus, Kosinus, Tangens der beiden
//! Schneidkanten) kommen fertig aus dem Fenster (`src/lathe/latheRust.ts`): ihre letzte Stelle kann zwischen Rust und dem
//! Fenster abweichen, und hier entscheiden sie über Rundungen (Rasterzellen, Bahnen auf 0,001 mm).
//! Gemeinsame Fälle: `tests/fixtures/lathe-cases.json.gz` (festgehalten von `tests/latheRust.test.ts`).

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath::{js_num, js_round, to_fixed};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

type Arr = Vec<f64>;

/// Das Format, das diese Datei versteht (gleiche Zahl wie LATHE_JOB_VERSION in latheRust.ts)
pub const JOB_VERSION: u32 = 1;

const HUGE: f64 = 1e9;
const EPS: f64 = 1e-6;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub id: String,
    pub num: f64,
    /// Name, schon ohne Umlaute und Klammern (für die Kommentare)
    pub name: String,
    /// "turn" | "groove" | "drill"
    #[serde(rename = "type")]
    pub kind: String,
    /// "R" | "L" | "N"
    pub hand: String,
    pub nose: f64,
    pub width: f64,
    pub dia: f64,
    pub ap: f64,
    pub feed: f64,
    pub vc_pct: f64,
    /// Werkzeugform (shapeOf in turn.ts): Kantenwinkel links/rechts in Grad
    pub a_l: f64,
    pub a_r: f64,
    /// sin, cos, tan des linken und des rechten Kantenwinkels, im Fenster gerechnet
    pub trig_l: [f64; 3],
    pub trig_r: [f64; 3],
}

#[derive(Deserialize, Clone, Debug)]
pub struct Op {
    /// "face" | "rough" | "finish" | "drill" | "groove" | "part"
    pub kind: String,
    pub on: bool,
    pub tool: String,
    #[serde(default)]
    pub z: Option<f64>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub d: Option<f64>,
    #[serde(default)]
    pub depth: Option<f64>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub stock_d: f64,
    pub face_allow: f64,
    pub stick_out: f64,
    pub margin: f64,
    pub allow_x: f64,
    pub allow_z: f64,
    pub vc: f64,
    pub max_rpm: f64,
    pub safe_x: f64,
    pub safe_z: f64,
    pub clear: f64,
    pub tail_on: bool,
    pub tail_d: f64,
    pub tail_z: f64,
    pub ops: Vec<Op>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Out {
    /// "radius" | "dia" | "g8" | "g7"
    pub x_mode: String,
    pub x_sign: f64,
    /// "auto" | "m8" | "hand"
    pub spindle: String,
    /// "M3" | "M4"
    pub dir: String,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Pt {
    pub z: f64,
    pub r: f64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Job {
    pub version: u32,
    pub job: Settings,
    pub tools: Vec<Tool>,
    /// Kontur: rechtes Ende bei z = 0
    pub profile: Vec<Vec<Pt>>,
    pub out: Out,
    /// Kommentare (lathe.gc.*), schon ohne Umlaute, mit Platzhaltern {n}
    pub texts: HashMap<String, String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Issue {
    pub code: String,
    pub op: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v: Option<f64>,
    pub hard: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Output {
    /// None: harte Meldungen oder nichts zu tun (dann gibt das Fenster keinen G-Code aus)
    pub gcode: Option<String>,
    pub issues: Vec<Issue>,
    /// Zahl der Bearbeitungen mit Bahnen
    pub runs: usize,
}

// ---------------- Raster ----------------
#[derive(Clone, Copy, Debug)]
struct Grid {
    z0: f64,
    h: f64,
    n: usize,
}
fn make_grid(z_min: f64, z_max: f64, h: f64) -> Grid {
    let z0 = (z_min / h).floor() * h;
    Grid { z0, h, n: (((z_max - z0) / h).ceil() + 1.0).max(0.0) as usize }
}
fn z_of(g: &Grid, i: usize) -> f64 {
    g.z0 + i as f64 * g.h
}
fn i_of(g: &Grid, z: f64) -> usize {
    mx(0.0, mn(g.n as f64 - 1.0, js_round((z - g.z0) / g.h))) as usize
}

/// Höhenlinie der Kontur: größter Radius je Stelle. Links vom Teil bleibt das Rohteil stehen, rechts ist Luft
fn height_line(lines: &[Vec<Pt>], g: &Grid, left: f64) -> Arr {
    let mut p = vec![-HUGE; g.n];
    let put = |i: f64, r: f64, p: &mut Arr| {
        if i >= 0.0 && (i as usize) < g.n && r > p[i as usize] {
            p[i as usize] = r;
        }
    };
    let mut z_min = HUGE;
    for l in lines {
        for k in 0..l.len() {
            let (b, a) = (l[k], l[k.saturating_sub(1)]);
            z_min = mn(z_min, b.z);
            let (lo, hi) = if a.z <= b.z { (a, b) } else { (b, a) };
            let i0 = ((lo.z - g.z0) / g.h - 0.5 - EPS).ceil();
            let i1 = ((hi.z - g.z0) / g.h + 0.5 - 1e-3).floor();
            if hi.z - lo.z < EPS {
                put(js_round((lo.z - g.z0) / g.h), mx(lo.r, hi.r), &mut p);
                continue;
            }
            let at = |z: f64| lo.r + (hi.r - lo.r) * mx(0.0, mn(1.0, (z - lo.z) / (hi.z - lo.z)));
            let mut i = i0;
            while i <= i1 {
                let z = g.z0 + i * g.h;
                put(i, mx(at(mx(lo.z, z - g.h / 2.0)), at(mn(hi.z, z + g.h / 2.0))), &mut p);
                i += 1.0;
            }
        }
    }
    if z_min < HUGE {
        let mut i = 0;
        while i < g.n && z_of(g, i) < z_min - g.h / 2.0 {
            p[i] = left;
            i += 1;
        }
    }
    p
}

// ---------------- Werkzeugform ----------------
#[derive(Clone, Copy, Debug)]
struct Shape {
    flat: f64,
    nose: f64,
    a_l: f64,
    a_r: f64,
    /// sin, cos, tan
    t_l: [f64; 3],
    t_r: [f64; 3],
}
fn shape_of(t: &Tool) -> Shape {
    let flat = match t.kind.as_str() {
        "groove" => t.width / 2.0,
        "drill" => t.dia / 2.0,
        _ => 0.0,
    };
    let nose = if t.kind == "turn" { t.nose } else { 0.0 };
    Shape { flat, nose, a_l: t.a_l, a_r: t.a_r, t_l: t.trig_l, t_r: t.trig_r }
}
fn mirror(s: &Shape) -> Shape {
    Shape { a_l: s.a_r, a_r: s.a_l, t_l: s.t_r, t_r: s.t_l, ..*s }
}
/// Abstand der programmierten Spitze von der Mitte des Schneidenradius
fn ref_dz(t: &Tool) -> f64 {
    match t.kind.as_str() {
        "groove" => -t.width / 2.0,
        "drill" => 0.0,
        _ => match t.hand.as_str() {
            "R" => -t.nose,
            "L" => t.nose,
            _ => 0.0,
        },
    }
}
/// `flat || x` in JavaScript: die flache Breite, wenn sie nicht 0 ist (oder keine Zahl), sonst x
fn or(flat: f64, x: f64) -> f64 {
    if flat != 0.0 && !flat.is_nan() {
        flat
    } else {
        x
    }
}

/// Werkzeug-Unterkante über dem tiefsten Punkt an der Stelle dz
fn tool_edge(s: &Shape, dz: f64) -> f64 {
    if s.flat != 0.0 && !s.flat.is_nan() {
        return if dz.abs() <= s.flat + EPS { 0.0 } else { HUGE };
    }
    let (a, t) = if dz < 0.0 { (s.a_l, s.t_l) } else { (s.a_r, s.t_r) };
    let d = dz.abs();
    let d0 = s.nose * t[0];
    if d <= d0 + EPS {
        return s.nose - mx(0.0, s.nose * s.nose - d * d).sqrt();
    }
    if a >= 90.0 - EPS {
        HUGE
    } else {
        s.nose * (1.0 - t[1]) + (d - d0) * t[2]
    }
}

/// F[c] = max über i von p[i] − t(z_i − z_c): so tief darf der tiefste Punkt der Schneide an der Stelle c
fn dilate(p: &[f64], g: &Grid, s: &Shape) -> Arr {
    let (n, h) = (g.n, g.h);
    let mut f = vec![-HUGE; n];
    let kl = (or(s.flat, s.nose * s.t_l[0]) / h + 1e-6).floor() as i64;
    let kr = (or(s.flat, s.nose * s.t_r[0]) / h + 1e-6).floor() as i64;
    let off: Vec<f64> = (-kl..=kr).map(|k| tool_edge(s, k as f64 * h)).collect();
    let ni = n as i64;
    for c in 0..ni {
        let mut best = -HUGE;
        let (mut k, e) = ((-kl).max(-c), kr.min(ni - 1 - c));
        while k <= e {
            let v = p[(c + k) as usize] - off[(k + kl) as usize];
            if v > best {
                best = v;
            }
            k += 1;
        }
        f[c as usize] = best;
    }
    if !(s.flat != 0.0 && !s.flat.is_nan()) {
        let side = |a: f64, t: [f64; 3], k0: i64, dir: i64, f: &mut Arr| {
            if a >= 90.0 - EPS {
                return;
            }
            let tan = t[2];
            let c0 = s.nose * (1.0 - t[1]) - s.nose * t[0] * tan;
            let mut run = -HUGE;
            for q in 0..ni {
                let c = if dir < 0 { q } else { ni - 1 - q };
                let i = c + dir * (k0 + 1); // dir −1: Material links vom Werkzeug
                run -= tan * h;
                if i >= 0 && i < ni && p[i as usize] - tan * (k0 + 1) as f64 * h > run {
                    run = p[i as usize] - tan * (k0 + 1) as f64 * h;
                }
                if run - c0 > f[c as usize] {
                    f[c as usize] = run - c0;
                }
            }
        };
        side(s.a_l, s.t_l, kl, -1, &mut f);
        side(s.a_r, s.t_r, kr, 1, &mut f);
    }
    f
}

/// Restmaterial nach einer geraden Fahrt des tiefsten Punkts von (z1, r1) nach (z2, r2)
#[allow(clippy::too_many_arguments)]
fn sweep(s_arr: &mut Arr, g: &Grid, s: &Shape, z1: f64, r1: f64, z2: f64, r2: f64) {
    let mut a_arr = vec![-HUGE; g.n];
    let (a, b) = (mn(z1, z2), mx(z1, z2));
    let i0 = mx(0.0, ((a - g.z0) / g.h - 1e-6).ceil());
    let i1 = mn(g.n as f64 - 1.0, ((b - g.z0) / g.h + 1e-6).floor());
    let put = |i: usize, r: f64, a_arr: &mut Arr| {
        if -r > a_arr[i] {
            a_arr[i] = -r;
        }
    };
    if b - a < EPS {
        put(i_of(g, a), mn(r1, r2), &mut a_arr);
    } else {
        let mut i = i0;
        while i <= i1 {
            put(i as usize, r1 + (r2 - r1) * (g.z0 + i * g.h - z1) / (z2 - z1), &mut a_arr);
            i += 1.0;
        }
    }
    let e = dilate(&a_arr, g, &mirror(s));
    for i in 0..g.n {
        if -e[i] < s_arr[i] {
            s_arr[i] = if -e[i] > 1e-6 { -e[i] } else { -HUGE }; // bis zur Mitte: dort ist kein Material mehr
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct P2 {
    z: f64,
    r: f64,
}

/// Bahn vereinfachen (Douglas-Peucker)
fn simplify(pts: &[P2], tol: f64) -> Vec<P2> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let mut st: Vec<(usize, usize)> = vec![(0, pts.len() - 1)];
    while let Some((a, b)) = st.pop() {
        let (pa, pb) = (pts[a], pts[b]);
        let (dz, dr) = (pb.z - pa.z, pb.r - pa.r);
        let l = hypot2(dz, dr);
        let (mut bi, mut bd) = (None, tol);
        for (i, q) in pts.iter().enumerate().take(b).skip(a + 1) {
            let d = if l < 1e-9 { hypot2(q.z - pa.z, q.r - pa.r) } else { ((q.z - pa.z) * dr - (q.r - pa.r) * dz).abs() / l };
            if d > bd {
                bd = d;
                bi = Some(i);
            }
        }
        if let Some(bi) = bi {
            keep[bi] = true;
            st.push((a, bi));
            st.push((bi, b));
        }
    }
    pts.iter().enumerate().filter(|(i, _)| keep[*i]).map(|(_, p)| *p).collect()
}

/// Drehzahl aus Schnittgeschwindigkeit, begrenzt
fn rpm_for(vc: f64, d: f64, max: f64) -> f64 {
    mx(1.0, js_round(mn(max, vc * 1000.0 / (std::f64::consts::PI * mx(0.5, d)))))
}

#[derive(Clone, Debug)]
struct Move {
    rapid: bool,
    z: f64,
    r: f64,
    feed: f64,
}
struct Run {
    op: usize,
    tool: usize,
    rpm: f64,
    moves: Vec<Move>,
    passes: usize,
    rpms: Vec<f64>,
}

fn grid_step(len: f64) -> f64 {
    mx(0.01, len / 6000.0)
}
fn right_end(s: &[f64], g: &Grid) -> f64 {
    for i in (0..g.n).rev() {
        if s[i] > 0.01 {
            return z_of(g, i);
        }
    }
    0.0
}

struct Issues(Vec<Issue>);
impl Issues {
    fn bad(&mut self, code: &str, op: i64, v: Option<f64>, hard: bool) {
        if !self.0.iter().any(|i| i.code == code && i.op == op) {
            self.0.push(Issue { code: code.into(), op, v, hard });
        }
    }
    fn any_hard(&self) -> bool {
        self.0.iter().any(|i| i.hard)
    }
}

/// Zustand einer Bearbeitung (die Hilfsfunktionen in planLathe)
struct OpState<'a> {
    job: &'a Settings,
    g: Grid,
    sh: Shape,
    dz: f64,
    tool: &'a Tool,
    oi: i64,
    big_r: f64,
    z_chuck: f64,
    cz: f64,
    cr: f64,
    rpm: f64,
    need: Arr,
    stale: bool,
    run: Run,
}

impl OpState<'_> {
    fn fresh(&mut self, s: &[f64]) {
        if self.stale {
            self.need = dilate(s, &self.g, &self.sh);
            self.stale = false;
        }
    }
    fn push(&mut self, s: &mut Arr, issues: &mut Issues, rapid: bool, z: f64, r: f64, f: f64) {
        let (job, g, sh) = (self.job, self.g, self.sh);
        if (z - self.cz).abs() < 1e-9 && (r - self.cr).abs() < 1e-9 {
            return;
        }
        // geprüft wird jede Fahrt: im Eilgang nie ins Material, nie ins Futter, nie in den Reitstock
        if rapid {
            self.fresh(s);
            let (i0, i1) = (i_of(&g, mn(z, self.cz)), i_of(&g, mx(z, self.cz)));
            for i in i0..=i1 {
                let rr = if i0 == i1 || (z - self.cz).abs() < 1e-9 { mn(r, self.cr) } else { self.cr + (r - self.cr) * mx(0.0, mn(1.0, (z_of(&g, i) - self.cz) / (z - self.cz))) };
                if self.need[i] > rr + 0.02 && rr < self.big_r + 0.02 {
                    issues.bad("rapidHit", self.oi, None, true);
                    break;
                }
            }
        } else if self.tool.kind != "drill" {
            sweep(s, &g, &sh, self.cz, self.cr, z, r);
            self.stale = true;
        }
        let left_edge = z - or(sh.flat, sh.nose * sh.t_l[0]);
        if left_edge < self.z_chuck + job.margin - 1e-6 {
            issues.bad("chuck", self.oi, None, true);
        }
        if job.tail_on && self.tool.kind == "drill" {
            issues.bad("tailDrill", self.oi, None, true);
        }
        if job.tail_on && mn(r, self.cr) < job.tail_d / 2.0 + 0.2 && mx(z, self.cz) + or(sh.flat, sh.nose) > job.tail_z {
            issues.bad("tail", self.oi, None, true);
        }
        self.run.moves.push(Move { rapid, z: z + self.dz, r, feed: if rapid { 0.0 } else { f } });
        self.run.rpms.push(self.rpm);
        self.cz = z;
        self.cr = r;
    }
    /// höchste Stelle, über der das Werkzeug zwischen zwei Stellen frei ist
    fn top(&mut self, s: &[f64], a: f64, b: f64) -> f64 {
        self.fresh(s);
        let mut m = -HUGE;
        for i in i_of(&self.g, mn(a, b))..=i_of(&self.g, mx(a, b)) {
            if self.need[i] > m {
                m = self.need[i];
            }
        }
        m
    }
    /// im Eilgang nach (z, r): erst hoch, dann längs, dann so weit wie frei hinunter, den Rest im Vorschub
    fn travel(&mut self, s: &mut Arr, issues: &mut Issues, z: f64, r: f64, f: f64, safe_r: f64) {
        let t = mx(mx(self.top(s, self.cz, z) + self.job.clear, self.cr), mn(r, safe_r));
        if self.cr < t {
            self.push(s, issues, true, self.cz, t, 0.0);
        }
        self.push(s, issues, true, z, t, 0.0);
        let free = mx(r, self.top(s, z, z) + self.job.clear);
        if free < t {
            self.push(s, issues, true, z, free, 0.0);
        }
        if free > r {
            self.push(s, issues, false, z, r, f);
        }
    }
    fn set_rpm(&mut self, vc: f64, d: f64) {
        self.rpm = rpm_for(vc, d, self.job.max_rpm);
        if self.run.rpm == 0.0 {
            self.run.rpm = self.rpm;
        }
    }
}

fn plan(job: &Settings, tools: &[Tool], profile: &[Vec<Pt>]) -> (Vec<Run>, Issues) {
    let mut issues = Issues(Vec::new());
    let big_r = job.stock_d / 2.0;
    let (mut z_end, mut r_top) = (0.0f64, 0.0f64);
    for l in profile {
        for p in l {
            z_end = mn(z_end, p.z);
            r_top = mx(r_top, p.r);
        }
    }
    let part_len = -z_end;
    let part_op = job.ops.iter().find(|o| o.kind == "part" && o.on);
    let part_tool = part_op.and_then(|o| tools.iter().find(|x| x.id == o.tool));
    let ext = part_tool.map_or(0.0, |t| t.width + 1.0); // hinter dem Teil Platz für den Abstechstahl
    let z_min = mn(z_end - ext, -job.stick_out) - 6.0;
    let z_max = job.face_allow + job.safe_z + 12.0;
    let g = make_grid(z_min, z_max, grid_step(z_max - z_min));
    let mut runs: Vec<Run> = Vec::new();
    let (z_stock, z_chuck) = (job.face_allow, -job.stick_out);

    if !profile.iter().any(|l| l.len() > 1) || !(part_len > 0.05) {
        issues.bad("noProfile", -1, None, true);
    }
    if r_top > big_r + 1e-3 {
        issues.bad("stockSmall", -1, Some(r_top * 2.0), true);
    }
    if !(big_r > 0.0) {
        issues.bad("stockBad", -1, None, true);
    }
    if !(job.max_rpm > 0.0) || !(job.vc > 0.0) {
        issues.bad("speedBad", -1, None, true);
    }
    if -z_end + ext > job.stick_out - job.margin + 1e-6 {
        issues.bad("stickOut", -1, Some(part_len + ext + job.margin), true);
    }
    let lod = job.stick_out / mx(0.1, job.stock_d);
    if !job.tail_on && lod > 4.0 {
        issues.bad("slender", -1, Some(js_round(lod * 10.0) / 10.0), false);
    }
    let last = profile.iter().flat_map(|l| l.iter().filter(|q| (q.z - z_end).abs() < 1e-6)).fold(0.0, |m, q| mx(m, q.r));
    let mut prof: Vec<Vec<Pt>> = profile.to_vec();
    if ext != 0.0 && !ext.is_nan() {
        prof.push(vec![Pt { z: z_end - ext, r: last }, Pt { z: z_end, r: last }]);
    }
    let p = height_line(&prof, &g, big_r);
    // Rohteil
    let mut s: Arr = (0..g.n).map(|i| if z_of(&g, i) <= z_stock + EPS { big_r } else { -HUGE }).collect();
    if issues.any_hard() {
        return (runs, issues);
    }

    for (oi, op) in job.ops.iter().enumerate() {
        if !op.on {
            continue;
        }
        let oi_i = oi as i64;
        let Some(ti) = tools.iter().position(|x| x.id == op.tool) else {
            issues.bad("noTool", oi_i, None, true);
            continue;
        };
        let tool = &tools[ti];
        let want = match op.kind.as_str() {
            "drill" => "drill",
            "groove" | "part" => "groove",
            _ => "turn",
        };
        if tool.kind != want {
            issues.bad("wrongTool", oi_i, None, true);
            continue;
        }
        let sh = shape_of(tool);
        let dz = ref_dz(tool);
        let vc = job.vc * tool.vc_pct / 100.0;
        if !(tool.feed > 0.0) || !(tool.ap > 0.0) || !(vc > 0.0) {
            issues.bad("toolBad", oi_i, None, true);
            continue;
        }
        let safe_r = big_r + job.safe_x;
        let safe_c = z_stock + job.safe_z;
        let need = dilate(&s, &g, &sh);
        let mut st = OpState { job, g, sh, dz, tool, oi: oi_i, big_r, z_chuck, cz: safe_c - dz, cr: safe_r, rpm: 0.0, need, stale: false, run: Run { op: oi, tool: ti, rpm: 0.0, moves: vec![], passes: 0, rpms: vec![] } };
        st.set_rpm(vc, job.stock_d);
        let iss = &mut issues;

        match op.kind.as_str() {
            "face" => {
                // Planen: von außen zur Mitte, Schneide muss mit dem Radius über die Mitte hinaus
                let n = mx(1.0, (job.face_allow / tool.ap - 1e-6).ceil());
                let nose_l = sh.nose * sh.t_l[0];
                if job.face_allow < 1e-6 {
                    iss.bad("faceNothing", oi_i, None, false);
                }
                if job.tail_on {
                    iss.bad("tailFace", oi_i, None, true);
                }
                let mut k = 1.0;
                while k <= n && job.face_allow >= 1e-6 {
                    let z = job.face_allow * (1.0 - k / n) + nose_l;
                    if st.cr < safe_r {
                        let cz = st.cz;
                        st.push(&mut s, iss, true, cz, safe_r, 0.0);
                    }
                    st.push(&mut s, iss, true, z, safe_r, 0.0);
                    st.push(&mut s, iss, true, z, big_r + job.clear, 0.0);
                    st.push(&mut s, iss, false, z, -tool.nose, tool.feed);
                    st.push(&mut s, iss, false, z + job.clear, -tool.nose, tool.feed * 2.0);
                    st.push(&mut s, iss, true, z + job.clear, safe_r, 0.0);
                    st.run.passes += 1;
                    k += 1.0;
                }
            }
            "rough" => {
                let w = js_round(job.allow_z / g.h) as i64;
                let ni = g.n as i64;
                let pa: Arr = (0..ni)
                    .map(|i| {
                        let mut m = -HUGE;
                        let (mut k, e) = ((i - w).max(0), (i + w).min(ni - 1));
                        while k <= e {
                            if p[k as usize] > m {
                                m = p[k as usize];
                            }
                            k += 1;
                        }
                        if m > -HUGE / 2.0 {
                            m + job.allow_x
                        } else {
                            -HUGE
                        }
                    })
                    .collect();
                let f = dilate(&pa, &g, &sh);
                let z_right = mx(0.0, right_end(&s, &g)) + job.clear + or(sh.flat, tool.nose);
                let (cs, c_min) = (i_of(&g, z_right) as i64, i_of(&g, z_chuck + job.margin + tool.nose) as i64);
                let mut low = big_r;
                let mut c = c_min;
                while c <= i_of(&g, 0.0) as i64 {
                    let fc = f[c as usize];
                    if fc > -HUGE / 2.0 && fc < low {
                        low = fc;
                    }
                    c += 1;
                }
                low = mx(low, 0.0);
                let n = mx(1.0, ((big_r - low) / tool.ap - 1e-6).ceil());
                let step = (big_r - low) / n;
                let mut k = 1.0;
                while k <= n && step > 1e-4 {
                    let r = big_r - step * k;
                    let r_prev = r + step;
                    st.set_rpm(vc, r_prev * 2.0);
                    let mut b = cs;
                    while b >= c_min {
                        if f[b as usize] > r + EPS {
                            b -= 1;
                            continue;
                        }
                        let mut a = b;
                        while a - 1 >= c_min && f[(a - 1) as usize] <= r + EPS {
                            a -= 1;
                        }
                        let any = (a..=b).any(|i| s[i as usize] > r + 2e-3);
                        // auch links vom Ende des Intervalls nimmt die Schneide noch Material mit (Schneidenradius)
                        if any {
                            if b == cs {
                                st.travel(&mut s, iss, z_of(&g, b as usize), r, tool.feed, safe_r);
                            } else {
                                // Tal: an der rechten Flanke (Freiwinkel des Stahls) entlang hinunter
                                let mut q = b;
                                while q < cs && f[(q + 1) as usize] <= r_prev && f[(q + 1) as usize] > f[q as usize] - EPS {
                                    q += 1;
                                }
                                st.travel(&mut s, iss, z_of(&g, q as usize), mx(f[q as usize], r), tool.feed, safe_r);
                                if q > b {
                                    let pts: Vec<P2> = (b..=q).rev().map(|i| P2 { z: z_of(&g, i as usize), r: mx(f[i as usize], r) }).collect();
                                    for t in simplify(&pts, 0.005).into_iter().skip(1) {
                                        st.push(&mut s, iss, false, t.z, t.r, tool.feed);
                                    }
                                }
                                st.push(&mut s, iss, false, z_of(&g, b as usize), r, tool.feed);
                            }
                            st.push(&mut s, iss, false, z_of(&g, a as usize), r, tool.feed);
                            // am Ende der Kontur nach bis zur vorigen Höhe: keine Stufen
                            let mut e = a;
                            let mut up: Vec<P2> = vec![P2 { z: z_of(&g, a as usize), r }];
                            while e - 1 >= c_min && f[(e - 1) as usize] <= r_prev {
                                e -= 1;
                                up.push(P2 { z: z_of(&g, e as usize), r: mx(r, f[e as usize]) });
                            }
                            for t in simplify(&up, 0.005).into_iter().skip(1) {
                                st.push(&mut s, iss, false, t.z, t.r, tool.feed);
                            }
                            if st.cr < r_prev {
                                let cz = st.cz;
                                st.push(&mut s, iss, false, cz, r_prev, tool.feed);
                            }
                            let (cz, cr) = (st.cz, st.cr);
                            st.push(&mut s, iss, false, cz + mn(0.3, job.clear), cr + mn(0.3, job.clear), tool.feed * 3.0);
                            st.run.passes += 1;
                        }
                        b = a - 1;
                    }
                    k += 1.0;
                }
            }
            "finish" => {
                let f = dilate(&p, &g, &sh);
                let z_right = mx(0.0, right_end(&s, &g)) + job.clear + tool.nose;
                let (cs, c_min) = (i_of(&g, z_right), i_of(&g, z_chuck + job.margin + tool.nose));
                let mut c = cs;
                while c > c_min && f[c] < -tool.nose - EPS {
                    c -= 1;
                }
                let r0 = mx(-tool.nose, f[c]);
                let mut pts: Vec<P2> = vec![P2 { z: z_of(&g, c), r: r0 }];
                let mut i = c as i64 - 1;
                while i >= c_min as i64 {
                    let iu = i as usize;
                    let r = mx(-tool.nose, f[iu]);
                    pts.push(P2 { z: z_of(&g, iu), r: mn(r, big_r + 0.3) });
                    if r >= big_r - EPS && z_of(&g, iu) < z_end - ext {
                        break;
                    }
                    i -= 1;
                }
                // Schlichten heißt wenig abnehmen: steht irgendwo noch viel Material, wird es abgelehnt (erst schruppen)
                let thr = mx(job.allow_x, tool.ap) * 2.0 + 0.1;
                let (mut run0, mut big) = (0usize, 0.0f64);
                for i in 0..g.n {
                    let zi = z_of(&g, i);
                    let e = if zi >= z_end && zi <= z_stock { s[i] - mx(0.0, p[i]) } else { 0.0 };
                    if e > thr {
                        run0 += 1;
                        big = mx(big, e);
                        if run0 as f64 * g.h > job.allow_z + thr + 4.0 * g.h && f[i] < s[i] - thr {
                            iss.bad("finishDeep", oi_i, Some(js_round(big * 10.0) / 10.0), true);
                        }
                    } else {
                        run0 = 0;
                        big = 0.0;
                    }
                }
                let mut d_max = 0.0;
                for i in 0..g.n {
                    if z_of(&g, i) >= z_end && p[i] > d_max {
                        d_max = p[i];
                    }
                }
                st.set_rpm(vc, d_max * 2.0);
                st.travel(&mut s, iss, z_of(&g, cs), r0, tool.feed, safe_r);
                for t in simplify(&pts, 0.002) {
                    st.push(&mut s, iss, false, t.z, t.r, tool.feed);
                }
                if st.cr < big_r + 0.3 {
                    let (cz, cr) = (st.cz, st.cr);
                    let up = mn(big_r + 0.3, mx(cr + 0.3, st.top(&s, cz, cz) + 0.3));
                    st.push(&mut s, iss, false, cz, up, tool.feed);
                }
                st.run.passes = 1;
                // was dieser Stahl nicht erreicht (der Schneidenradius in Ecken zählt nicht)
                let mut rest = 0.0;
                for i in 0..g.n {
                    let zi = z_of(&g, i);
                    if zi >= z_end + 0.05 && zi <= -0.05 && p[i] > 0.0 {
                        rest = mx(rest, s[i] - p[i]);
                    }
                }
                if rest > mx(0.05, tool.nose) {
                    iss.bad("rest", oi_i, Some(js_round(rest * 100.0) / 100.0), false);
                }
            }
            "groove" | "part" => {
                let w = tool.width;
                let is_part = op.kind == "part";
                let z_l = if is_part { z_end - w } else { op.z.unwrap_or(-10.0) };
                let ww = if is_part { w } else { op.width.unwrap_or(w) };
                let r_b = if is_part { mx(0.0, op.d.unwrap_or(0.0) / 2.0) } else { op.d.unwrap_or(0.0) / 2.0 };
                if ww < w - 1e-6 {
                    iss.bad("grooveNarrow", oi_i, Some(w), true);
                    continue;
                }
                if r_b >= big_r - 1e-6 || r_b < 0.0 {
                    iss.bad("grooveDepth", oi_i, None, true);
                    continue;
                }
                if !is_part && (z_l < z_end - 1e-6 || z_l + ww > 1e-6) {
                    iss.bad("grooveOutside", oi_i, None, true);
                }
                let cnt = mx(1.0, ((ww - w) / (w * 0.8) - 1e-6).ceil() + 1.0);
                let bottom = if cnt > 1.0 { r_b + 0.05 } else { r_b };
                let r_out = mx(0.0, st.top(&s, z_l + w / 2.0, z_l + ww - w / 2.0)) + job.clear;
                st.set_rpm(vc, mx(1.0, (r_out - job.clear) * 2.0));
                if r_b < 0.02 {
                    iss.bad("falls", oi_i, None, false);
                }
                let mut k = 0.0;
                while k < cnt {
                    let z = z_l + ww - w / 2.0 - if cnt > 1.0 { (ww - w) * k / (cnt - 1.0) } else { 0.0 };
                    st.travel(&mut s, iss, z, mx(r_out, r_b + job.clear), tool.feed, safe_r);
                    let mut r = mx(0.0, st.top(&s, z, z));
                    while r > bottom + 1e-6 {
                        r = mx(bottom, r - tool.ap);
                        // nahe der Mitte langsamer (Abstechen)
                        let f = if r < mn(3.0, big_r * 0.3) && is_part { tool.feed * 0.5 } else { tool.feed };
                        st.push(&mut s, iss, false, z, r, f);
                        if r > bottom + 1e-6 {
                            st.push(&mut s, iss, false, z, r + 0.2, tool.feed * 3.0);
                        }
                    }
                    let cr = st.cr;
                    st.push(&mut s, iss, false, z, mx(cr, r_out), tool.feed * 4.0);
                    st.run.passes += 1;
                    k += 1.0;
                }
                if cnt > 1.0 {
                    st.travel(&mut s, iss, z_l + ww - w / 2.0, r_out, tool.feed, safe_r);
                    st.push(&mut s, iss, false, z_l + ww - w / 2.0, r_b, tool.feed);
                    st.push(&mut s, iss, false, z_l + w / 2.0, r_b, tool.feed);
                    st.push(&mut s, iss, false, z_l + w / 2.0, r_out, tool.feed * 4.0);
                }
            }
            "drill" => {
                let depth = op.depth.unwrap_or(0.0);
                if !(depth > 0.0) {
                    iss.bad("drillDepth", oi_i, None, true);
                    continue;
                }
                if tool.dia >= job.stock_d {
                    iss.bad("drillBig", oi_i, None, true);
                    continue;
                }
                if depth > job.stick_out + 1e-6 {
                    iss.bad("drillDeep", oi_i, Some(depth), false);
                }
                st.set_rpm(vc, tool.dia);
                let z_top = mx(0.0, right_end(&s, &g));
                // der Bohrer steht auf der Drehmitte: erst vor dem Teil zur Mitte, dann längs (die Außenform zählt hier nicht)
                let mut raw = |st: &mut OpState, rapid: bool, z: f64, r: f64, f: f64| {
                    if job.tail_on {
                        iss.bad("tailDrill", oi_i, None, true);
                    }
                    if rapid && z < z_top + 0.2 && r > 1e-6 {
                        iss.bad("rapidHit", oi_i, None, true);
                    }
                    st.run.moves.push(Move { rapid, z, r, feed: if rapid { 0.0 } else { f } });
                    st.run.rpms.push(st.rpm);
                    st.cz = z;
                    st.cr = r;
                };
                raw(&mut st, true, safe_c, 0.0, 0.0);
                raw(&mut st, true, z_top + job.clear, 0.0, 0.0);
                let mut z = z_top;
                while z > -depth + 1e-6 {
                    let next = mx(-depth, z - tool.ap);
                    if z < z_top {
                        raw(&mut st, true, z_top + job.clear, 0.0, 0.0);
                        raw(&mut st, true, z + 0.5, 0.0, 0.0);
                    }
                    raw(&mut st, false, next, 0.0, tool.feed);
                    z = next;
                    st.run.passes += 1;
                }
                raw(&mut st, true, safe_c, 0.0, 0.0);
                raw(&mut st, true, safe_c, safe_r, 0.0);
                runs.push(st.run);
                continue;
            }
            _ => {}
        }
        // frei fahren: erst nach außen, dann vor das Teil
        if st.cr < safe_r {
            let cz = st.cz;
            st.push(&mut s, iss, true, cz, safe_r, 0.0);
        }
        st.push(&mut s, iss, true, safe_c - dz, safe_r, 0.0);
        if st.run.passes > 0 {
            runs.push(st.run);
        }
    }
    (runs, issues)
}

/// Bahnen, Meldungen und – wenn nichts Hartes dagegen spricht – der G-Code (latheGcodeFromDesign in latheJob.ts)
pub fn generate(j: &Job) -> Result<Output, String> {
    if j.version != JOB_VERSION {
        return Err(format!("job version {} (this build understands {})", j.version, JOB_VERSION));
    }
    let (runs, issues) = plan(&j.job, &j.tools, &j.profile);
    let n_runs = runs.len();
    if issues.any_hard() || runs.is_empty() {
        return Ok(Output { gcode: None, issues: issues.0, runs: n_runs });
    }
    Ok(Output { gcode: Some(gcode(&runs, j)), issues: issues.0, runs: n_runs })
}

fn gcode(runs: &[Run], j: &Job) -> String {
    let (job, o) = (&j.job, &j.out);
    let c = |key: &str, params: &[(&str, String)]| -> String {
        let mut s = j.texts.get(key).cloned().unwrap_or_else(|| key.to_string());
        for (k, v) in params {
            s = s.replace(&format!("{{{k}}}"), v);
        }
        format!("({s})")
    };
    let mut out: Vec<String> = Vec::new();
    let k = (if o.x_mode == "dia" || o.x_mode == "g7" { 2.0 } else { 1.0 }) * o.x_sign;
    let f3 = |v: f64| to_fixed(if v.abs() < 5e-4 { 0.0 } else { v }, 3);
    let x_w = |r: f64| format!("X{}", f3(r * k));
    let z_w = |z: f64| format!("Z{}", f3(z));
    let safe_r = job.stock_d / 2.0 + job.safe_x;
    let safe_z = job.face_allow + job.safe_z;
    out.push(c("title", &[]));
    out.push(format!("G21 {}", c("mm", &[])));
    out.push(format!("G90 {}", c("abs", &[])));
    out.push(format!("G94 {}", c("feedMin", &[])));
    if o.x_mode == "g7" {
        out.push(format!("G7 {}", c("g7", &[])));
    }
    if o.x_mode == "g8" {
        out.push(format!("G8 {}", c("g8", &[])));
    }
    // m8: Ein/Aus des Motorreglers hängt am Kühlmittel-Ausgang
    let ctl = o.spindle != "hand";
    let stop = |out: &mut Vec<String>| {
        if o.spindle == "m8" {
            out.push(format!("M9 {}", c("off", &[])));
        }
        out.push(format!("M5 {}", c("off", &[])));
    };
    let mut tool_id = String::new();
    let mut on = 0.0f64;
    for (ri, run) in runs.iter().enumerate() {
        let tool = &j.tools[run.tool];
        let tn = [("n", js_num(tool.num)), ("name", tool.name.clone())];
        let same = ri > 0 && tool_id == tool.id;
        if ri > 0 && !same {
            if on != 0.0 && ctl {
                stop(&mut out);
            }
            out.push(format!("M0 {}", c("tool", &tn)));
            on = 0.0;
        }
        if o.spindle == "hand" {
            if on != run.rpm {
                out.push(format!("M0 {}", c("hand", &[("rpm", js_num(run.rpm))])));
            }
            on = run.rpm;
        }
        // nach jeder Pause kann die Maschine von Hand verfahren worden sein: immer erst vor das Teil, dann nach außen
        out.push(format!("G0 {} {}", z_w(safe_z), c(&format!("op.{}", job.ops[run.op].kind), &tn)));
        out.push(format!("G0 {}", x_w(safe_r)));
        let (mut rpm, mut feed, mut lz, mut lr) = (on, -1.0f64, safe_z, safe_r);
        for (i, m) in run.moves.iter().enumerate() {
            let want = run.rpms[i];
            if ctl && want != rpm && (on == 0.0 || m.rapid) {
                out.push(format!("{} S{} {}", o.dir, js_num(want), c("on", &[("rpm", js_num(want))])));
                if on == 0.0 && o.spindle == "m8" {
                    out.push(format!("M8 {}", c("on", &[("rpm", js_num(want))])));
                }
                if on == 0.0 {
                    out.push(format!("G4 P3 {}", c("spinUp", &[])));
                }
                rpm = want;
                on = want;
            }
            let mut w: Vec<String> = Vec::new();
            if (m.z - lz).abs() > 4e-4 {
                w.push(z_w(m.z));
            }
            if (m.r - lr).abs() > 4e-4 {
                w.push(x_w(m.r));
            }
            if w.is_empty() {
                continue;
            }
            // Vorschub je Minute aus der Drehzahl, die gerade läuft
            let f = mx(1.0, js_round(m.feed * if o.spindle == "hand" { run.rpm } else { rpm }));
            out.push(if m.rapid { format!("G0 {}", w.join(" ")) } else { format!("G1 {}{}", w.join(" "), if f != feed { format!(" F{}", js_num(f)) } else { String::new() }) });
            if !m.rapid {
                feed = f;
            }
            lz = m.z;
            lr = m.r;
        }
        tool_id = tool.id.clone();
    }
    if ctl {
        stop(&mut out);
    } else {
        out.push(format!("M0 {}", c("handOff", &[])));
    }
    out.push(format!("M30 {}", c("end", &[])));
    out.join("\n") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// von Hand: Raster ab −10 in Schritten von 0,5 bis +3 → 27 Zellen, Zelle 20 liegt bei 0
    #[test]
    fn grid_and_speed() {
        let g = make_grid(-10.0, 3.0, 0.5);
        assert_eq!((g.z0, g.n), (-10.0, 27));
        assert_eq!(i_of(&g, 0.0), 20);
        assert_eq!(i_of(&g, 100.0), 26);
        // 90 m/min an Ø 30: 90 000 / (π · 30) = 954,9 → 955 U/min; begrenzt auf 800
        assert_eq!(rpm_for(90.0, 30.0, 1500.0), 955.0);
        assert_eq!(rpm_for(90.0, 30.0, 800.0), 800.0);
    }

    /// Vergleich mit turn.ts: dieselben Fälle wie tests/latheRust.test.ts – Meldungen und G-Code genau gleich
    #[test]
    fn same_result_as_typescript() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/lathe-cases.json.gz");
        let cases: Value = serde_json::from_reader(flate2::read::GzDecoder::new(std::fs::File::open(&path).unwrap())).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 30, "only {} cases", cases.len());
        let (mut lines, mut issues) = (0usize, 0usize);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let job: Job = serde_json::from_value(c["job"].clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
            let out = generate(&job).unwrap_or_else(|e| panic!("{name}: {e}"));
            let want: Vec<(String, i64, Option<f64>, bool)> = c["issues"].as_array().unwrap().iter().map(|i| (i["code"].as_str().unwrap().to_string(), i["op"].as_i64().unwrap(), i["v"].as_f64(), i["hard"].as_bool().unwrap())).collect();
            let got: Vec<(String, i64, Option<f64>, bool)> = out.issues.iter().map(|i| (i.code.clone(), i.op, i.v, i.hard)).collect();
            assert_eq!(got, want, "{name}: issues");
            assert_eq!(out.runs as u64, c["runs"].as_u64().unwrap(), "{name}: runs");
            match (out.gcode.as_deref(), c["gcode"].as_str()) {
                (None, None) => {}
                (Some(got), Some(want)) => {
                    let (got, want): (Vec<&str>, Vec<&str>) = (got.split('\n').collect(), want.split('\n').collect());
                    for (k, (a, b)) in got.iter().zip(&want).enumerate() {
                        assert!(a == b, "{name}: line {}\n  Rust:    {a}\n  turn.ts: {b}", k + 1);
                    }
                    assert_eq!(got.len(), want.len(), "{name}: number of lines");
                    lines += want.len();
                }
                (g, w) => panic!("{name}: Rust gives a program: {}, turn.ts: {}", g.is_some(), w.is_some()),
            }
            issues += out.issues.len();
        }
        println!("{} cases, {lines} G-code lines and {issues} messages the same as turn.ts", cases.len());
    }
}
