//! FRÄSERGEBNIS AUS DEM G-CODE (Zwilling von src/view3d/carveSim.ts): Materialabtrag für die 3D-Ansicht
//!
//! Das Material ist ein Höhenraster: jede Zelle merkt sich, wie hoch dort noch Material steht (Oberkante Z = 0).
//! Jede Bewegung des G-Codes (aus gcodesim.rs, Bögen schon in Geraden zerlegt) drückt die Fräserform hinein.
//! Die Rechnung folgt dem TypeScript Zeile für Zeile; geprüft mit denselben Fällen auf beiden Seiten:
//! tests/fixtures/carvesim-cases.json und carvesim-expected.json (tests/carveSimRust.test.ts und die Tests unten).
//!
//! Nur Anzeige – nichts hiervon geht an die Maschine.

use crate::gcodesim::{self, hypot2, hypot3, js_space, mn, mx, word_char};
use serde::Deserialize;

const MAX_CELLS: f64 = 5_000_000.0;

/// Fräser, wie das Fenster ihn schickt (nur was die Form bestimmt); fehlende Angabe = None
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub diameter: Option<f64>,
    #[serde(default)]
    pub angle: Option<f64>,
    #[serde(default)]
    pub tip_dia: Option<f64>,
    #[serde(default)]
    pub corner_r: Option<f64>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    /// Fräser je Abschnitt (Abschnitt = zwischen zwei Werkzeugwechseln); null = 3-mm-Schaftfräser
    #[serde(default)]
    pub tools: Vec<Option<Tool>>,
    #[serde(default)]
    pub max_cells: Option<f64>,
}

#[derive(Debug)]
pub struct CarveResult {
    pub nx: usize,
    pub ny: usize,
    /// linke untere Ecke (mm)
    pub x0: f64,
    pub y0: f64,
    /// Zellgröße (mm)
    pub cell: f64,
    /// Höhe je Zelle (≤ 0), h[j * nx + i]
    pub h: Vec<f32>,
    pub min_z: f64,
    /// Schnittbewegungen
    pub moves: usize,
}

/// Form der Schneide: Höhe über der Spitze im Abstand r von der Mitte (Unendlich = außerhalb)
enum Profile {
    Flat { r: f64 },
    Ball { r: f64 },
    Bull { r: f64, cr: f64, flat: f64 },
    Cone { r: f64, tr: f64, k: f64 },
    Taper { r: f64, dia: f64, tip_dia: f64, angle: f64 },
}

fn radius(tool: Option<&Tool>) -> f64 {
    mx(0.05, tool.and_then(|t| t.diameter).unwrap_or(3.0) / 2.0)
}

/// Konischer Fräser mit Kugelspitze (wie taperHeight in toolGraphics.ts)
fn taper_height(dia: f64, tip_dia: f64, angle: f64, r: f64) -> f64 {
    let pi = std::f64::consts::PI;
    let big = dia / 2.0;
    let tip = mn(big, mx(0.0, tip_dia / 2.0));
    let half = mx(0.25, mn(85.0, angle / 2.0)) * pi / 180.0;
    let rt = tip * half.cos();
    if r <= rt {
        tip - mx(0.0, tip * tip - r * r).sqrt()
    } else {
        tip - tip * half.sin() + (r - rt) / half.tan()
    }
}

fn profile(tool: Option<&Tool>) -> Profile {
    let pi = std::f64::consts::PI;
    let r = radius(tool);
    let kind = tool.and_then(|t| t.kind.as_deref()).unwrap_or("endmill");
    match kind {
        "ball" => Profile::Ball { r },
        "bullnose" => {
            let cr = mn(r, mx(0.0, tool.and_then(|t| t.corner_r).unwrap_or(0.0)));
            Profile::Bull { r, cr, flat: r - cr }
        }
        "vbit" | "chamfer" | "countersink" | "drill" | "spotdrill" => {
            // `angle || Standard`: 0, NaN und fehlend zählen als „nicht angegeben“
            let given = tool.and_then(|t| t.angle).filter(|a| *a != 0.0 && !a.is_nan());
            let half = (given.unwrap_or(if kind == "drill" { 118.0 } else { 90.0 }) * pi) / 360.0;
            let tr = mn(r, mx(0.0, tool.and_then(|t| t.tip_dia).unwrap_or(0.0) / 2.0));
            Profile::Cone { r, tr, k: 1.0 / mx(0.05, half).tan() }
        }
        "taper" if tool.is_some() => {
            let t = tool.unwrap();
            let nan = f64::NAN;
            Profile::Taper { r, dia: t.diameter.unwrap_or(nan), tip_dia: t.tip_dia.unwrap_or(nan), angle: t.angle.unwrap_or(nan) }
        }
        _ => Profile::Flat { r },
    }
}

impl Profile {
    fn at(&self, d: f64) -> f64 {
        let inf = f64::INFINITY;
        match *self {
            Profile::Flat { r } => {
                if d > r {
                    inf
                } else {
                    0.0
                }
            }
            Profile::Ball { r } => {
                if d > r {
                    inf
                } else {
                    r - mx(0.0, r * r - d * d).sqrt()
                }
            }
            Profile::Bull { r, cr, flat } => {
                if d > r {
                    inf
                } else if d <= flat {
                    0.0
                } else {
                    cr - mx(0.0, cr * cr - (d - flat) * (d - flat)).sqrt()
                }
            }
            Profile::Cone { r, tr, k } => {
                if d > r {
                    inf
                } else if d <= tr {
                    0.0
                } else {
                    (d - tr) * k
                }
            }
            Profile::Taper { r, dia, tip_dia, angle } => {
                if d > r {
                    inf
                } else {
                    taper_height(dia, tip_dia, angle, d)
                }
            }
        }
    }
}

/// Zellen um den Fräser, nach Abstand sortiert (dist als f32, wie die Float32Array im TypeScript)
struct Kernel {
    di: Vec<i32>,
    dj: Vec<i32>,
    dist: Vec<f32>,
    r: f64,
}

/// Zellen für den genauen Abdruck: etwas größer als der Fräser, weil seine Mitte nicht auf einer Zellmitte liegen muss
fn exact_kernel(tool: Option<&Tool>, c: f64) -> Kernel {
    let dia = tool.and_then(|t| t.diameter).unwrap_or(3.0);
    let big = mx(0.05, (dia + 2.0 * c) / 2.0);
    let n = (big / c).ceil();
    let n = if n.is_finite() { n as i64 } else { 0 };
    let mut list: Vec<(i32, i32, f64)> = Vec::new();
    for j in -n..=n {
        for i in -n..=n {
            let d = hypot2(i as f64, j as f64) * c;
            if d <= big + c * 0.5 {
                list.push((i as i32, j as i32, d));
            }
        }
    }
    list.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
    Kernel {
        di: list.iter().map(|q| q.0).collect(),
        dj: list.iter().map(|q| q.1).collect(),
        dist: list.iter().map(|q| q.2 as f32).collect(),
        r: mx(0.05, dia / 2.0),
    }
}

/// Werkzeugwechsel-Zeile?  /^\s*M0?[016]\b/i  nach dem Entfernen geschlossener Klammern  /\([^)]*\)/g
fn is_tool_change(line: &str, buf: &mut Vec<char>) -> bool {
    buf.clear();
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '(' {
            if let Some(close) = chars[i + 1..].iter().position(|&c| c == ')') {
                i += close + 2;
                continue;
            }
        }
        buf.push(chars[i]);
        i += 1;
    }
    let mut j = 0;
    while j < buf.len() && js_space(buf[j]) {
        j += 1;
    }
    if j >= buf.len() || (buf[j] != 'M' && buf[j] != 'm') {
        return false;
    }
    let ok = |k: usize| k < buf.len() && matches!(buf[k], '0' | '1' | '6') && (k + 1 >= buf.len() || !word_char(buf[k + 1]));
    (j + 1 < buf.len() && buf[j + 1] == '0' && ok(j + 2)) || ok(j + 1)
}

/// Fortschritt 0…1 melden; false = abbrechen
pub fn carve(text: &str, job: &Job, on_progress: &mut dyn FnMut(f64) -> bool) -> Option<CarveResult> {
    let prog = gcodesim::parse(text, &gcodesim::Options::default());
    let tools = &job.tools;
    let max_cells = job.max_cells.unwrap_or(MAX_CELLS);
    // Abschnitt (Werkzeug) je Zeile
    let mut sect: Vec<usize> = Vec::new();
    let mut buf = Vec::new();
    let mut k = 0usize;
    for l in text.split('\n') {
        sect.push(k);
        if is_tool_change(l, &mut buf) {
            k += 1;
        }
    }
    let tool_index = |line: u32| -> Option<usize> {
        if tools.is_empty() {
            return None;
        }
        Some((tools.len() - 1).min(sect.get(line as usize).copied().unwrap_or(0)))
    };
    let tool_of = |line: u32| -> Option<&Tool> { tool_index(line).and_then(|i| tools[i].as_ref()) };
    let n_moves = prog.kind.len();
    let (px0, py0, pz0, px1, py1, pz1) = (&prog.x0, &prog.y0, &prog.z0, &prog.x1, &prog.y1, &prog.z1);
    let f = |v: f32| v as f64;

    // Bereich: alle Bewegungen unter Z = 0 plus Fräserradius und Rand
    let inf = f64::INFINITY;
    let (mut x0, mut y0, mut x1, mut y1, mut cuts) = (inf, inf, -inf, -inf, 0usize);
    for m in 0..n_moves {
        if mn(f(pz0[m]), f(pz1[m])) >= 0.0 {
            continue;
        }
        let r = radius(tool_of(prog.line[m]));
        x0 = mn(mn(x0, f(px0[m]) - r), f(px1[m]) - r);
        x1 = mx(mx(x1, f(px0[m]) + r), f(px1[m]) + r);
        y0 = mn(mn(y0, f(py0[m]) - r), f(py1[m]) - r);
        y1 = mx(mx(y1, f(py0[m]) + r), f(py1[m]) + r);
        cuts += 1;
    }
    if cuts == 0 {
        return None;
    }
    let margin = mx(4.0, 0.06 * mx(x1 - x0, y1 - y0));
    x0 -= margin;
    y0 -= margin;
    x1 += margin;
    y1 += margin;
    // Kleine Teile: nicht feiner als nötig. Feine Fräser dürfen feiner.
    let r_min = if tools.is_empty() { radius(None) } else { tools.iter().map(|t| radius(t.as_ref())).fold(inf, mn) };
    let c = mx(mn(0.06, mx(0.03, r_min / 4.0)), (((x1 - x0) * (y1 - y0)) / max_cells).sqrt());
    let nx = mx(2.0, ((x1 - x0) / c).ceil());
    let ny = mx(2.0, ((y1 - y0) / c).ceil());
    // (so groß kann das Raster nur mit unsinnigen Angaben werden – dann lieber nichts als ein Absturz)
    if !(nx.is_finite() && ny.is_finite()) || nx * ny > 400_000_000.0 {
        return None;
    }
    let (nx, ny) = (nx as usize, ny as usize);
    let mut h = vec![0.0f32; nx * ny]; // 0 = Oberkante

    // Kern und Form je Fräser (Platz 0 = kein Fräser angegeben)
    let slots = tools.len() + 1;
    let mut kernels: Vec<Option<(Kernel, Profile)>> = (0..slots).map(|_| None).collect();

    let (mut min_z, mut done, mut budget) = (0.0f64, 0usize, 0.0f64);
    for m in 0..n_moves {
        let (za, zb) = (f(pz0[m]), f(pz1[m]));
        if mn(za, zb) >= 0.0 {
            continue;
        }
        let ti = tool_index(prog.line[m]);
        let slot = ti.map_or(0, |i| i + 1);
        if kernels[slot].is_none() {
            let tl = ti.and_then(|i| tools[i].as_ref());
            kernels[slot] = Some((exact_kernel(tl, c), profile(tl)));
        }
        let (kern, prof) = kernels[slot].as_ref().unwrap();
        // so weit reicht der Fräser bis zur Oberkante (V-Fräser in geringer Tiefe nur ein kleiner Kreis)
        let zmin = mn(za, zb);
        let mut reach = kern.r;
        if prof.at(kern.r) > -zmin {
            let (mut lo, mut hi) = (0.0f64, kern.r);
            for _ in 0..20 {
                let mid = (lo + hi) / 2.0;
                if prof.at(mid) <= -zmin {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            reach = lo + c;
        }
        // Abstand der Punkte: höchstens ein Viertel des wirksamen Radius, mindestens eine Zelle
        let (ax, ay, bx, by) = (f(px0[m]), f(py0[m]), f(px1[m]), f(py1[m]));
        let len = hypot3(bx - ax, by - ay, zb - za);
        let step = mx(c * 0.7, mn(reach / 4.0, c * 3.0));
        let n = mx(1.0, (len / step).ceil());
        let limit = reach + c;
        // (n = NaN: im TypeScript läuft die Schleife dann gar nicht)
        let count = if n.is_finite() { n as u64 + 1 } else { 0 };
        for s in 0..count {
            let u = s as f64 / n;
            let z = za + (zb - za) * u;
            if z >= 0.0 {
                continue;
            }
            // Fräser an Punkt (x, y) mit Spitze auf z. Abstand von der echten Mitte zur Zellmitte – nicht aufs Raster gerundet
            let (x, y) = (ax + (bx - ax) * u, ay + (by - ay) * u);
            let (ci, cj) = (((x - x0) / c).floor(), ((y - y0) / c).floor());
            let (fx, fy) = ((x - x0) / c - ci - 0.5, (y - y0) / c - cj - 0.5);
            let (ci, cj) = (ci as i64, cj as i64);
            for q in 0..kern.di.len() {
                if kern.dist[q] as f64 > limit {
                    break;
                }
                let (i, j) = (ci + kern.di[q] as i64, cj + kern.dj[q] as i64);
                if i < 0 || j < 0 || i >= nx as i64 || j >= ny as i64 {
                    continue;
                }
                let (ex, ey) = (kern.di[q] as f64 - fx, kern.dj[q] as f64 - fy);
                let d = (ex * ex + ey * ey).sqrt() * c;
                if d > reach {
                    continue;
                }
                let v = z + prof.at(d);
                let id = j as usize * nx + i as usize;
                if v < h[id] as f64 {
                    h[id] = v as f32;
                }
            }
        }
        min_z = mn(min_z, zmin);
        done += 1;
        let area = std::f64::consts::PI * (reach / c) * (reach / c);
        budget += n * mn(kern.di.len() as f64, area);
        if budget > 4_000_000.0 {
            budget = 0.0;
            if !on_progress(done as f64 / cuts as f64) {
                return None;
            }
        }
    }
    on_progress(1.0);
    Some(CarveResult { nx, ny, x0, y0, cell: c, h, min_z, moves: cuts })
}

/// Ergebnis als Bytes für das Fenster (Little Endian), gelesen in src/view3d/carveRust.ts:
///   u32 nx · u32 ny · u32 moves · u32 0 · f64 x0, y0, cell, minZ · h (f32 × nx × ny)
pub fn encode(r: &CarveResult) -> Vec<u8> {
    let mut out = Vec::with_capacity(48 + r.h.len() * 4);
    for v in [r.nx as u32, r.ny as u32, r.moves as u32, 0] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for v in [r.x0, r.y0, r.cell, r.min_z] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for v in &r.h {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn tool(kind: &str, d: f64) -> Option<Tool> {
        Some(Tool { kind: Some(kind.into()), diameter: Some(d), ..Default::default() })
    }
    fn run(lines: &[&str], tools: Vec<Option<Tool>>) -> Option<CarveResult> {
        carve(&lines.join("\n"), &Job { tools, max_cells: None }, &mut |_| true)
    }

    #[test]
    fn hole_is_round_and_as_deep_as_cut() {
        let r = run(&["G21", "G90", "G0 X10.013 Y20.037", "G1 Z-2 F100", "G0 Z5"], vec![tool("endmill", 6.0)]).unwrap();
        let mut cut = 0.0;
        for j in 0..r.ny {
            for i in 0..r.nx {
                let (x, y) = (r.x0 + (i as f64 + 0.5) * r.cell, r.y0 + (j as f64 + 0.5) * r.cell);
                let inside = ((x - 10.013).powi(2) + (y - 20.037).powi(2)).sqrt() <= 3.0;
                let v = r.h[j * r.nx + i];
                assert_eq!(v < 0.0, inside, "{x},{y}");
                if inside {
                    assert!((v + 2.0).abs() < 1e-4);
                    cut += 1.0;
                }
            }
        }
        assert!(((cut * r.cell * r.cell) / (std::f64::consts::PI * 9.0) - 1.0).abs() < 0.01);
        assert_eq!(r.moves, 2);
        assert!((r.min_z + 2.0).abs() < 1e-9);
    }

    #[test]
    fn ball_is_deep_in_the_middle() {
        let r = run(&["G0 X0 Y0", "G1 Z-3 F100", "G0 Z5"], vec![tool("ball", 6.0)]).unwrap();
        let at = |x: f64, y: f64| r.h[((y - r.y0) / r.cell).floor() as usize * r.nx + ((x - r.x0) / r.cell).floor() as usize] as f64;
        assert!((at(0.0, 0.0) + 3.0).abs() < 0.01);
        assert!((at(2.0, 0.0) + (3.0 - (3.0 - 5.0f64.sqrt()))).abs() < 0.05);
    }

    #[test]
    fn nothing_below_the_surface_gives_nothing() {
        assert!(run(&["G0 X5 Y5", "G1 X20 F300"], vec![tool("endmill", 3.0)]).is_none());
    }

    #[test]
    fn cancel_stops() {
        let lines: Vec<String> = (0..4000).map(|i| format!("G1 X{} Y{} Z-1 F500", i % 97, i % 89)).collect();
        let mut calls = 0;
        let r = carve(&lines.join("\n"), &Job { tools: vec![tool("endmill", 6.0)], max_cells: None }, &mut |_| {
            calls += 1;
            false
        });
        assert!(r.is_none() && calls == 1);
    }

    #[test]
    fn tool_change_lines() {
        let mut b = Vec::new();
        for l in ["M0", " m00 ", "M1", "M06 T2", "M6", "(x) M0", "M0.5"] {
            assert!(is_tool_change(l, &mut b), "{l}");
        }
        for l in ["M10", "M016", "G1 M6", "M3", "(M0", "M", "M60"] {
            assert!(!is_tool_change(l, &mut b), "{l}");
        }
    }

    // ---- Vergleich mit dem TypeScript ----

    fn fixture(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures").join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    /// Base64 → Bytes (die Höhen stehen so in der Vergleichsdatei: bitgenaue f32, zlib-gepackt)
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

    /// Antwort: (größte Abweichung in f32-Schritten, Zellen mit Abweichung)
    fn compare(name: &str, text: &str, job: &Job, want: &Value) -> (i64, usize) {
        let got = carve(text, job, &mut |_| true);
        if want.is_null() {
            assert!(got.is_none(), "{name}: TypeScript gives no result");
            return (0, 0);
        }
        let r = got.unwrap_or_else(|| panic!("{name}: no result"));
        assert_eq!(r.nx as u64, want["nx"].as_u64().unwrap(), "{name}: nx");
        assert_eq!(r.ny as u64, want["ny"].as_u64().unwrap(), "{name}: ny");
        assert_eq!(r.moves as u64, want["moves"].as_u64().unwrap(), "{name}: moves");
        for (what, g) in [("x0", r.x0), ("y0", r.y0), ("cell", r.cell), ("minZ", r.min_z)] {
            let w = want[what].as_f64().unwrap();
            assert!((g - w).abs() <= 1e-12 * w.abs().max(1.0), "{name}: {what} {g} != {w}");
        }
        // in der Datei: zlib-gepackt, dann Base64
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut flate2::read::ZlibDecoder::new(&base64(want["h"].as_str().unwrap())[..]), &mut bytes).unwrap();
        assert_eq!(bytes.len(), r.h.len() * 4, "{name}: cells");
        let (mut worst, mut cells) = (0i64, 0usize);
        for (i, q) in bytes.chunks(4).enumerate() {
            let w = f32::from_le_bytes(q.try_into().unwrap());
            let g = r.h[i];
            if g == w {
                continue;
            }
            let d = (g.to_bits() as i64 - w.to_bits() as i64).abs();
            assert!(d <= 2, "{name}: h[{i}] {g} != {w}");
            worst = worst.max(d);
            cells += 1;
        }
        (worst, cells)
    }

    fn case_text(c: &Value) -> String {
        match c["file"].as_str() {
            Some(f) => fixture(f),
            None => c["lines"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect::<Vec<_>>().join("\n"),
        }
    }

    #[test]
    fn same_result_as_typescript() {
        let cases: Value = serde_json::from_str(&fixture("carvesim-cases.json")).unwrap();
        let expected: Value = serde_json::from_str(&fixture("carvesim-expected.json")).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 20);
        let (mut worst, mut cells) = (0, 0);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let job: Job = serde_json::from_value(c["job"].clone()).unwrap();
            let want = expected.get(name).unwrap_or_else(|| panic!("{name}: no expected result (run UPDATE_FIXTURES=1 npm test)"));
            let (w, n) = compare(name, &case_text(c), &job, want);
            worst = worst.max(w);
            cells += n;
        }
        println!("largest difference to TypeScript: {worst} f32 step(s) in {cells} cell(s)");
    }

    /// Die Bytes für das Fenster (tests/fixtures/carvesim-sample.bin liest tests/carveSimRust.test.ts zurück).
    /// Schaftfräser: nur Grundrechenarten und Wurzeln, darum auf jedem Rechner dieselben Bytes.
    /// Neu schreiben: UPDATE_FIXTURES=1 cargo test carvesim
    #[test]
    fn encoded_sample_is_the_fixture() {
        let cases: Value = serde_json::from_str(&fixture("carvesim-cases.json")).unwrap();
        let c = cases.as_array().unwrap().iter().find(|c| c["name"] == "byte layout sample").unwrap();
        let job: Job = serde_json::from_value(c["job"].clone()).unwrap();
        let bytes = encode(&carve(&case_text(c), &job, &mut |_| true).unwrap());
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/carvesim-sample.bin");
        if std::env::var("UPDATE_FIXTURES").is_ok() {
            std::fs::write(&path, &bytes).unwrap();
        }
        assert!(std::fs::read(&path).unwrap() == bytes, "carvesim-sample.bin is not what encode() gives now");
    }

    /// Großer Vergleich mit eigenen Dateien (nicht im Repository), in voller Auflösung:
    /// CARVESIM_COMPARE=<Ordner mit *.gcode> node --test tests/carveSimRust.test.ts
    /// CARVESIM_COMPARE=<derselbe Ordner> cargo test --release carvesim -- --ignored --nocapture
    #[test]
    #[ignore]
    fn same_result_as_typescript_on_local_files() {
        let dir = std::env::var("CARVESIM_COMPARE").expect("CARVESIM_COMPARE = folder");
        let mut count = 0;
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = e.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".carve.json")) else { continue };
            let want: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let text = std::fs::read_to_string(path.with_file_name(format!("{name}.gcode"))).unwrap();
            let job: Job = serde_json::from_value(want["job"].clone()).unwrap();
            let start = std::time::Instant::now();
            let cells = carve(&text, &job, &mut |_| true).map_or(0, |r| r.h.len());
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            let (worst, n) = compare(name, &text, &job, &want["result"]);
            println!("{name}: {cells} cells, {ms:.0} ms in Rust, largest difference {worst} f32 step(s) in {n} cell(s)");
            count += 1;
        }
        assert!(count > 0, "no *.carve.json in {dir}");
    }
}
