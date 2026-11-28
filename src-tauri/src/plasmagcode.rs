//! PLASMA-G-CODE – Zwilling von `generatePlasmaGcode` in `src/plasmaCam.ts`.
//!
//! Der Auftrag kommt aus dem Fenster (`src/plasmaJob.ts`): je Schnitt-Einstellung die fertig geplanten Konturen
//! (Schnittspalt, Richtung, Startpunkt, Anfahr-/Ausfahrbahn, Überlauf, Haltestege – planShape in plasmaCam.ts) und die
//! Punkte zum Ankörnen. Hier entsteht daraus der Rest, Zeile für Zeile wie im TypeScript: Reihenfolge (kurze Wege, cutorder.rs,
//! oder Wärme verteilen, heatSpread.ts), Ankörnen in der Reihenfolge des nächsten Punkts (plasmaSpot.ts), Umwege um
//! ausgeschnittene Teile (RapidPlanner aus lasergcode.rs), Abtasten der Blechhöhe, Einstechen, Höhenregelung (THC) samt
//! Anti-Dive, kleine Löcher langsamer, und der Text. Vergleich: `tests/fixtures/plasmagcode-cases.json.gz`.

use crate::cutorder;
use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath::{js_num, js_round};
use crate::lasergcode::{n, Bed, RapidPlanner, Warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

type P = [f64; 2];

/// Das Format, das diese Datei versteht (gleiche Zahl wie PLASMA_JOB_VERSION in plasmaJob.ts)
pub const JOB_VERSION: u32 = 1;

/// mm/min für Z-Bewegungen unter Last, und beim Abtasten
const Z_FEED: f64 = 600.0;
const PROBE_FEED: f64 = 300.0;
/// mm Abstand der Leerfahrt-Umwege zu ausgeschnittenen Teilen
const AVOID_MARGIN: f64 = 5.0;

/// Eine geplante Kontur (PlasmaPlan in plasmaCam.ts)
#[derive(Deserialize, Clone, Debug)]
pub struct Plan {
    /// Kontur in Schneid-Richtung, beginnt am Startpunkt (mm)
    pub pts: Vec<P>,
    pub closed: bool,
    /// Einstichpunkt der Anfahrbahn, None = direkt auf der Kontur
    #[serde(default)]
    pub lead: Option<P>,
    /// Überlauf-Punkte nach dem Schließen
    #[serde(default)]
    pub over: Vec<P>,
    /// Ende der Ausfahrbahn im Abfall, None = keine
    #[serde(default)]
    pub out: Option<P>,
    pub area: f64,
    /// Innenkontur (Loch)
    pub hole: bool,
    /// größte Ausdehnung in mm
    pub size: f64,
    /// mit Haltestegen: die Schneid-Stücke (dazwischen Brenner aus, neu einstechen)
    #[serde(default)]
    pub runs: Option<Vec<Vec<P>>>,
}

/// Ein Hinweis aus dem Fenster: Schlüssel und Werte (schon als Text)
#[derive(Deserialize, Clone, Debug)]
pub struct WarnIn {
    pub key: String,
    pub p: Vec<(String, String)>,
}

/// Eine Schnitt-Einstellung mit ihren Konturen
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Cut {
    /// Überschrift, fertiger Kommentar in Klammern
    pub head: String,
    pub speed: f64,
    pub pierce_height: f64,
    pub pierce_delay: f64,
    pub cut_height: f64,
    pub plans: Vec<Plan>,
    /// Lochmitten zum Ankörnen (mm)
    #[serde(default)]
    pub spots: Vec<P>,
    /// Hinweise der Formen (zu klein, kein Platz zum Anfahren …) in ihrer Reihenfolge
    #[serde(default)]
    pub warns: Vec<WarnIn>,
    /// so viele Formen sind auf „auslassen“ gestellt
    #[serde(default)]
    pub skipped: usize,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub safe_z: f64,
    pub use_z: bool,
    pub probe: bool,
    pub probe_offset: f64,
    pub probe_dist: f64,
    /// "none" | "external" | "grblhal"
    pub thc: String,
    /// Freigabe-Ausgang der externen Box: "M8" | "M7"
    pub thc_out: String,
    pub anti_dive: f64,
    pub small_hole: f64,
    pub hole_speed: f64,
    pub avoid_cut: bool,
    pub optimize_order: bool,
    pub spot_time: f64,
    pub probe_skip: f64,
    pub spread: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub version: u32,
    /// so viele Faltlinien wurden weggelassen
    #[serde(default)]
    pub folds: usize,
    pub settings: Settings,
    #[serde(default)]
    pub bed: Option<Bed>,
    pub cuts: Vec<Cut>,
    pub texts: HashMap<String, String>,
    #[serde(default)]
    pub warn_texts: HashMap<String, String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Output {
    /// None = nichts zu tun (alles ausgelassen)
    pub gcode: Option<String>,
    pub warnings: Vec<Warn>,
}

fn dist(a: P, b: P) -> f64 {
    hypot2(b[0] - a[0], b[1] - a[1])
}

/// Ist das ein „kleines Loch“ (ohne THC, langsamer)?
fn is_small_hole(p: &Plan, s: &Settings) -> bool {
    p.closed && p.hole && s.small_hole > 0.0 && p.size <= s.small_hole + 1e-9
}

/// Kontur kurz vor dem Ende teilen: Ziel-Punkte und der Index, ab dem die letzten `rest` mm beginnen (None = zu kurz)
pub fn split_before_end(start: P, targets: &[P], rest: f64) -> (Vec<P>, Option<usize>) {
    let mut total = 0.0;
    let mut prev = start;
    for &q in targets {
        total += dist(prev, q);
        prev = q;
    }
    if !(rest > 0.0) || total <= rest + 1e-6 {
        return (targets.to_vec(), None);
    }
    let cut = total - rest;
    let mut run = 0.0;
    prev = start;
    for (i, &q) in targets.iter().enumerate() {
        let d = dist(prev, q);
        if run + d >= cut - 1e-9 {
            let f = if d > 0.0 { (cut - run) / d } else { 1.0 };
            if f >= 1.0 - 1e-6 {
                return (targets.to_vec(), Some(i + 1)); // genau auf einem Punkt
            }
            let m = [prev[0] + (q[0] - prev[0]) * f, prev[1] + (q[1] - prev[1]) * f];
            let mut pts = targets[..i].to_vec();
            pts.push(m);
            pts.extend_from_slice(&targets[i..]);
            return (pts, Some(i + 1));
        }
        run += d;
        prev = q;
    }
    (targets.to_vec(), None)
}

/// Wärme verteilen (heatSpread.ts): immer der Schnitt, der am weitesten von den letzten Schnitten weg ist; Löcher
/// weiter vor ihrem Teil. Antwort: die Nummern in der neuen Reihenfolge
pub fn spread_order(items: &[cutorder::Item], from: P) -> Vec<usize> {
    const WEIGHTS: [f64; 4] = [1.0, 1.5, 2.0, 3.0];
    let n = items.len();
    let preds = cutorder::precedence(items);
    let mid: Vec<P> = items
        .iter()
        .map(|it| {
            let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
            for p in &it.pts {
                x0 = mn(x0, p[0]);
                x1 = mx(x1, p[0]);
                y0 = mn(y0, p[1]);
                y1 = mx(y1, p[1]);
            }
            [(x0 + x1) / 2.0, (y0 + y1) / 2.0]
        })
        .collect();
    let mut left: Vec<usize> = preds.iter().map(|p| p.len()).collect();
    let mut done = vec![false; n];
    let mut succ: Vec<Vec<usize>> = vec![vec![]; n];
    for (b, p) in preds.iter().enumerate() {
        for &a in p {
            succ[a].push(b);
        }
    }
    let mut out: Vec<usize> = Vec::with_capacity(n);
    for _ in 0..n {
        let (mut best, mut best_score): (Option<usize>, f64) = (None, f64::NEG_INFINITY);
        for i in 0..n {
            if done[i] || left[i] > 0 {
                continue;
            }
            let score = if out.is_empty() {
                -dist(items[i].entry, from)
            } else {
                let mut s = f64::INFINITY;
                for (w, weight) in WEIGHTS.iter().enumerate().take(out.len()) {
                    let q = mid[out[out.len() - 1 - w]];
                    s = mn(s, dist(mid[i], q) * weight);
                }
                s
            };
            if score > best_score + 1e-9 {
                best_score = score;
                best = Some(i);
            }
        }
        let Some(best) = best else { return (0..n).collect() }; // kommt nicht vor: die Regel hat keine Kreise
        done[best] = true;
        out.push(best);
        for &b in &succ[best] {
            left[b] -= 1;
        }
    }
    out
}

/// Punkte in der Reihenfolge des jeweils nächsten (nearestOrder in plasmaSpot.ts)
fn nearest_order(points: &[P], from: P) -> Vec<P> {
    let mut left = points.to_vec();
    let mut out = Vec::with_capacity(points.len());
    let mut at = from;
    while !left.is_empty() {
        let (mut best, mut bd) = (0usize, f64::INFINITY);
        for (i, &p) in left.iter().enumerate() {
            let d = dist(p, at);
            if d < bd {
                bd = d;
                best = i;
            }
        }
        at = left.remove(best);
        out.push(at);
    }
    out
}

struct Gen<'a> {
    job: &'a Job,
    g: String,
    warns: Vec<Warn>,
    avoid: Option<RapidPlanner>,
    pos: Option<P>,
    probed_at: Option<P>,
    probes_saved: usize,
}

impl Gen<'_> {
    fn c(&self, key: &str, params: &[(&str, String)]) -> String {
        let mut s = self.job.texts.get(key).cloned().unwrap_or_else(|| key.to_string());
        for (k, v) in params {
            s = s.replace(&format!("{{{k}}}"), v);
        }
        format!("({s})")
    }
    fn w(&mut self, key: &str, params: Vec<(String, String)>) {
        let mut text = self.job.warn_texts.get(key).cloned().unwrap_or_else(|| key.to_string());
        for (k, v) in &params {
            text = text.replace(&format!("{{{k}}}"), v);
        }
        self.warns.push(Warn { key: key.to_string(), p: params, text });
    }
    fn line(&mut self, s: &str) {
        self.g.push_str(s);
        self.g.push('\n');
    }
    /// Leerfahrt – um schon ausgeschnittene Teile herum, wenn das eingeschaltet ist
    fn rapid(&mut self, to: P, note: &str) {
        if let (Some(avoid), Some(pos)) = (&self.avoid, self.pos) {
            let c = self.c("gc.avoid", &[]);
            for v in avoid.route(pos, to) {
                self.g.push_str(&format!("G0 X{} Y{} {c}\n", n(v[0]), n(v[1])));
            }
        }
        self.g.push_str(&format!("G0 X{} Y{}{note}\n", n(to[0]), n(to[1])));
        self.pos = Some(to);
    }
    /// Blechhöhe abtasten – außer der letzte Messpunkt ist nah genug (und seitdem lief keine Höhenregelung)
    fn probe(&mut self, at: P) {
        let s = &self.job.settings;
        if s.probe_skip > 0.0 {
            if let Some(p) = self.probed_at {
                if dist(at, p) <= s.probe_skip + 1e-9 {
                    self.probes_saved += 1;
                    let l = self.c("pgc.probeSkip", &[]);
                    self.line(&l);
                    return;
                }
            }
        }
        // relativ ab der aktuellen Höhe – ein fester Zielwert reicht nicht, wenn Z0 weit über dem Blech liegt
        let l = format!("G91 G38.2 Z{} F{} {}\nG90\nG92 Z{} {}", n(-s.probe_dist), js_num(PROBE_FEED), self.c("pgc.probe", &[]), n(s.probe_offset), self.c("pgc.probeSet", &[]));
        self.line(&l);
        self.probed_at = Some(at);
    }
}

/// G-Code und Hinweise für den Auftrag. Err = der Auftrag passt nicht zu dieser Datei
pub fn generate(job: &Job) -> Result<Output, String> {
    if job.version != JOB_VERSION {
        return Err(format!("job version {} (this build understands {})", job.version, JOB_VERSION));
    }
    for cut in &job.cuts {
        for p in &cut.plans {
            if p.pts.is_empty() || p.runs.as_ref().is_some_and(|r| r.is_empty() || r.iter().any(|run| run.is_empty())) {
                return Err("a plan without points".into());
            }
        }
    }
    let s = &job.settings;
    let mut x = Gen { job, g: String::new(), warns: vec![], avoid: None, pos: None, probed_at: None, probes_saved: 0 };
    if job.folds > 0 {
        x.w("fold.plasmaSkipped", vec![("n".into(), job.folds.to_string())]);
    }
    let thc_on = match s.thc.as_str() {
        "external" => format!("{} {}", s.thc_out, x.c("pgc.thcOn", &[])),
        "grblhal" => format!("M63 P2 {}", x.c("pgc.thcOn", &[])),
        _ => String::new(),
    };
    let thc_off = match s.thc.as_str() {
        "external" => format!("M9 {}", x.c("pgc.thcOff", &[])),
        "grblhal" => format!("M62 P2 {}", x.c("pgc.thcOff", &[])),
        _ => String::new(),
    };
    if s.thc == "external" && s.use_z && !s.probe {
        x.w("pgw.thcProbe", vec![]);
    }
    if s.probe_skip > 0.0 && s.probe && s.use_z && s.thc != "none" {
        x.w("pgw.probeSkipThc", vec![]);
    }
    let head = format!("G21 {}\nG90 {}\nM5 {}", x.c("gc.unitMm", &[]), x.c("gc.absolute", &[]), x.c("pgc.torchOffStart", &[]));
    x.line(&head);
    if s.thc == "external" {
        let l = format!("M9 {}", x.c("pgc.thcOff", &[]));
        x.line(&l);
    }
    if s.thc == "grblhal" {
        let l = format!("{}\nM64 P2 {}", x.c("pgc.thcHal", &[]), x.c("pgc.thcOff", &[]));
        x.line(&l);
    }
    let l = x.c("pgc.header", &[("n", job.cuts.len().to_string())]);
    x.line(&l);
    if s.use_z {
        let l = format!("G0 Z{} {}", n(s.safe_z), x.c("gc.safeZ", &[]));
        x.line(&l);
    }
    let (mut pierces, mut small_holes, mut spotted, mut skipped) = (0usize, 0usize, 0usize, 0usize);
    if s.avoid_cut {
        x.avoid = Some(RapidPlanner::new(AVOID_MARGIN, job.bed));
    }

    for cut in &job.cuts {
        x.g.push('\n');
        x.line(&cut.head);
        skipped += cut.skipped;
        for w in &cut.warns {
            x.w(&w.key, w.p.clone());
        }
        // offene Linien zuerst, dann geschlossene von klein nach groß (stabil wie Array.sort)
        let mut plans: Vec<&Plan> = cut.plans.iter().collect();
        plans.sort_by(|a, b| {
            let d = (a.closed as i32 - b.closed as i32) as f64;
            let d = if d != 0.0 { d } else { a.area - b.area };
            d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
        });
        // kürzeste Leerfahrten oder Wärme verteilen: Einstichpunkte bleiben, Löcher weiter vor ihrem Teil
        if (s.optimize_order || s.spread) && plans.len() > 1 {
            let last = |v: &Vec<P>| v[v.len() - 1];
            let items: Vec<cutorder::Item> = plans
                .iter()
                .map(|p| {
                    let entry = match &p.runs {
                        Some(runs) => p.lead.unwrap_or(runs[0][0]),
                        None => p.lead.unwrap_or(p.pts[0]),
                    };
                    let exit = match (&p.runs, p.out) {
                        (Some(runs), _) => last(&runs[runs.len() - 1]),
                        (None, Some(o)) => o,
                        _ if !p.over.is_empty() => last(&p.over),
                        _ if p.closed => p.pts[0],
                        _ => last(&p.pts),
                    };
                    cutorder::Item { entry, exit, pts: p.pts.clone(), closed: p.closed, free_start: false, reversible: false }
                })
                .collect();
            let from = x.pos.unwrap_or([0.0, 0.0]);
            let steps: Vec<cutorder::Step> = if s.spread {
                spread_order(&items, from).into_iter().map(|index| cutorder::Step { index, reversed: false, start: 0 }).collect()
            } else {
                cutorder::optimize(&items, from, 150.0)
            };
            let plain: Vec<cutorder::Step> = (0..items.len()).map(|i| cutorder::Step { index: i, reversed: false, start: 0 }).collect();
            let before = cutorder::travel_length(&items, &plain, from);
            let after = cutorder::travel_length(&items, &steps, from);
            let l = x.c(if s.spread { "pgc.spread" } else { "gc.orderOpt" }, &[("a", js_num(js_round(before))), ("b", js_num(js_round(after)))]);
            x.line(&l);
            plans = steps.iter().map(|st| plans[st.index]).collect();
        }

        // Ankörnen zuerst (solange noch nichts ausgeschnitten ist): Brenner kurz an, ohne Bewegung, ohne Höhenregelung
        for at in nearest_order(&cut.spots, x.pos.unwrap_or([0.0, 0.0])) {
            spotted += 1;
            let l = x.c("pgc.spot", &[("n", spotted.to_string())]);
            x.line(&l);
            x.rapid(at, "");
            if s.use_z {
                if s.probe {
                    x.probe(at);
                }
                let l = format!("G0 Z{} {}", n(cut.pierce_height), x.c("pgc.pierceHeight", &[]));
                x.line(&l);
            }
            let l = format!("M3 S1000 {}\nG4 P{} {}\nM5 {}", x.c("pgc.torchOn", &[]), n(s.spot_time / 1000.0), x.c("pgc.spotTime", &[]), x.c("pgc.torchOff", &[]));
            x.line(&l);
            if s.use_z {
                let l = format!("G0 Z{}", n(s.safe_z));
                x.line(&l);
            }
        }

        for p in plans {
            let small = is_small_hole(p, s);
            if small {
                small_holes += 1;
            }
            let thc = !thc_on.is_empty() && !small;
            // Stücke zum Schneiden: normal eins; mit Haltestegen eins pro Abschnitt zwischen den Stegen
            let mut pieces: Vec<(P, Vec<P>)> = Vec::new();
            match &p.runs {
                Some(runs) => {
                    for (ri, run) in runs.iter().enumerate() {
                        match p.lead.filter(|_| ri == 0) {
                            Some(lead) => pieces.push((lead, run.clone())),
                            None => pieces.push((run[0], run[1..].to_vec())),
                        }
                    }
                }
                None => {
                    let mut targets: Vec<P> = Vec::with_capacity(p.pts.len() + p.over.len() + 2);
                    if p.lead.is_some() {
                        targets.push(p.pts[0]);
                    }
                    targets.extend_from_slice(&p.pts[1..]);
                    if p.closed {
                        targets.push(p.pts[0]);
                        targets.extend_from_slice(&p.over);
                        if let Some(o) = p.out {
                            targets.push(o);
                        }
                    }
                    pieces.push((p.lead.unwrap_or(p.pts[0]), targets));
                }
            }
            for (k, (start, targets)) in pieces.into_iter().enumerate() {
                pierces += 1;
                let mut l = x.c("pgc.pierce", &[("n", pierces.to_string())]);
                if small {
                    l.push(' ');
                    l.push_str(&x.c("pgc.smallHole", &[("d", n(p.size)), ("p", js_num(s.hole_speed))]));
                }
                if k > 0 {
                    l.push(' ');
                    l.push_str(&x.c("gc.tab", &[]));
                }
                x.line(&l);
                x.rapid(start, "");
                if s.use_z {
                    if s.probe {
                        x.probe(start);
                    }
                    let l = format!("G0 Z{} {}", n(cut.pierce_height), x.c("pgc.pierceHeight", &[]));
                    x.line(&l);
                }
                let l = format!("M3 S1000 {}", x.c("pgc.torchOn", &[]));
                x.line(&l);
                if cut.pierce_delay > 0.0 {
                    let l = format!("G4 P{} {}", n(cut.pierce_delay), x.c("pgc.pierceDelay", &[]));
                    x.line(&l);
                }
                if s.use_z {
                    let l = format!("G1 Z{} F{} {}", n(cut.cut_height), js_num(Z_FEED), x.c("pgc.cutHeight", &[]));
                    x.line(&l);
                }
                // THC erst freigeben, wenn die Maschine auf Schneidhöhe steht (vor der ersten Bewegung)
                if thc {
                    x.line(&thc_on);
                    x.probed_at = None;
                }
                let feed = if small { cut.speed * s.hole_speed / 100.0 } else { cut.speed };
                x.line(&format!("G1 F{}", n(feed)));
                // Anti-Dive: nur grblHAL kann mitten in der Bewegung ohne Anhalten sperren
                let (pts, at) = if thc && s.thc == "grblhal" { split_before_end(start, &targets, s.anti_dive) } else { (targets, None) };
                for (i, q) in pts.iter().enumerate() {
                    if Some(i) == at {
                        let l = format!("M62 P2 {}", x.c("pgc.antiDive", &[]));
                        x.line(&l);
                    }
                    x.line(&format!("G1 X{} Y{}", n(q[0]), n(q[1])));
                }
                let l = format!("M5 {}", x.c("pgc.torchOff", &[]));
                x.line(&l);
                if thc && at.is_none() {
                    x.line(&thc_off);
                }
                if s.use_z {
                    x.line(&format!("G0 Z{}", n(s.safe_z)));
                }
                x.pos = Some(pts.last().copied().unwrap_or(start));
            }
            // ganz ausgeschnitten (ohne Haltestege) -> kann kippen, ab jetzt umfahren
            if p.closed && p.runs.is_none() {
                if let Some(avoid) = &mut x.avoid {
                    avoid.add_cut(&p.pts);
                }
            }
        }
    }

    if small_holes > 0 {
        let l = x.c("pgc.smallHoles", &[("n", small_holes.to_string())]);
        x.line(&l);
    }
    if spotted > 0 {
        let l = x.c("pgc.spots", &[("n", spotted.to_string())]);
        x.line(&l);
    }
    if x.probes_saved > 0 {
        let l = x.c("pgc.probesSaved", &[("n", x.probes_saved.to_string())]);
        x.line(&l);
    }
    if skipped > 0 {
        let l = x.c("pgc.skipped", &[("n", skipped.to_string())]);
        x.line(&l);
        x.w("pgw.skipped", vec![("n".into(), skipped.to_string())]);
    }
    // nichts zu tun (alles ausgelassen): kein Programm
    if skipped > 0 && pierces == 0 && spotted == 0 {
        return Ok(Output { gcode: None, warnings: x.warns });
    }
    x.g.push_str("\nM5\n");
    if !thc_off.is_empty() {
        x.line(if s.thc == "grblhal" { "M64 P2" } else { "M9" });
    }
    if s.use_z {
        x.line(&format!("G0 Z{}", n(s.safe_z)));
    }
    // Verschiebung durchs Abtasten (G92) wieder aufheben – sonst stimmt Z beim nächsten Job nicht
    if s.use_z && s.probe {
        let l = format!("G92.1 {}", x.c("pgc.probeClear", &[]));
        x.line(&l);
    }
    let note = format!(" {}", x.c("gc.park", &[]));
    x.rapid([0.0, 0.0], &note);
    let l = format!("M30 {}", x.c("gc.end", &[]));
    x.line(&l);
    Ok(Output { gcode: Some(x.g), warnings: x.warns })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// von Hand: Strecke 0→10→20 auf der X-Achse, die letzten 5 mm abtrennen → Teilungspunkt bei 15 vor dem letzten Ziel
    #[test]
    fn split_before_the_end_of_a_contour() {
        assert_eq!(split_before_end([0.0, 0.0], &[[10.0, 0.0], [20.0, 0.0]], 5.0), (vec![[10.0, 0.0], [15.0, 0.0], [20.0, 0.0]], Some(2)));
        assert_eq!(split_before_end([0.0, 0.0], &[[10.0, 0.0], [20.0, 0.0]], 10.0), (vec![[10.0, 0.0], [20.0, 0.0]], Some(1)), "exactly on a point");
        assert_eq!(split_before_end([0.0, 0.0], &[[3.0, 0.0]], 5.0).1, None, "too short");
        assert_eq!(split_before_end([0.0, 0.0], &[[30.0, 0.0]], 0.0).1, None, "no anti-dive");
    }

    /// von Hand: drei Löcher in einer Reihe bei 0, 10, 100: von (0,0) aus erst das nächste, dann immer das weiteste
    #[test]
    fn heat_spread_jumps_far_away() {
        let sq = |x: f64| cutorder::Item { entry: [x, 0.0], exit: [x, 0.0], pts: vec![[x - 1.0, -1.0], [x + 1.0, -1.0], [x + 1.0, 1.0], [x - 1.0, 1.0]], closed: true, free_start: false, reversible: false };
        assert_eq!(spread_order(&[sq(10.0), sq(0.0), sq(100.0)], [0.0, 0.0]), vec![1, 2, 0]);
        assert_eq!(nearest_order(&[[5.0, 0.0], [1.0, 0.0], [3.0, 0.0]], [0.0, 0.0]), vec![[1.0, 0.0], [3.0, 0.0], [5.0, 0.0]]);
    }

    /// Vergleich mit plasmaCam.ts: Fälle aus der Vorschau (tests/fixtures/README.md) – G-Code Zeile für Zeile, Hinweise
    #[test]
    fn same_gcode_as_plasma_cam_ts() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/plasmagcode-cases.json.gz");
        let file = std::fs::File::open(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let cases: Value = serde_json::from_reader(flate2::read::GzDecoder::new(file)).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 30, "only {} cases", cases.len());
        let (mut lines, mut warnings) = (0usize, 0usize);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let job: Job = serde_json::from_value(c["job"].clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
            let out = generate(&job).unwrap_or_else(|e| panic!("{name}: {e}"));
            match (c["gcode"].as_str(), &out.gcode) {
                (None, None) => {}
                (Some(want), Some(got)) => {
                    let (want, got): (Vec<&str>, Vec<&str>) = (want.split('\n').collect(), got.split('\n').collect());
                    for (k, (a, b)) in got.iter().zip(&want).enumerate() {
                        assert!(a == b, "{name}: line {}\n  Rust:         {a}\n  plasmaCam.ts: {b}", k + 1);
                    }
                    assert_eq!(got.len(), want.len(), "{name}: number of lines");
                    lines += want.len();
                }
                (w, g) => panic!("{name}: plasmaCam.ts gives a program: {}, Rust: {}", w.is_some(), g.is_some()),
            }
            let texts: Vec<&str> = out.warnings.iter().map(|w| w.text.as_str()).collect();
            let want_w: Vec<&str> = c["warnings"].as_array().unwrap().iter().map(|w| w.as_str().unwrap()).collect();
            assert_eq!(texts, want_w, "{name}: warnings");
            warnings += want_w.len();
        }
        println!("{} cases, {lines} G-code lines and {warnings} warnings the same as plasmaCam.ts", cases.len());
    }
}
