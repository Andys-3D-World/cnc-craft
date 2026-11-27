//! FRÄS-G-CODE (Zwilling des Fräs-Teils von src/cam.ts) – ETAPPE 1
//!
//! Erzeugt aus einem Auftrag (src/camJob.ts sammelt alles, was cam.ts sonst aus Einstellungen, Werkzeug-Bibliothek
//! und Sprachdatei liest) denselben G-Code wie cam.ts – Zeile für Zeile.
//!
//! Bisher (Etappen 1 und 2): mehrere Werkzeuge mit Werkzeugwechsel · Konturen (Linienzug offen/geschlossen), Kreise,
//! Linien und Bögen · außen, innen, auf der Linie · Taschen (Zickzack, Kontur, Adaptiv; Inseln; Schlicht-Aufmaß) ·
//! Haltestege (automatisch und selbst gesetzt) · Material-Profil je Form · Eintauchen senkrecht oder als Rampe ·
//! Reihenfolge (innen vor außen, kurze Leerfahrten).
//! Alles andere (Bohren, V-Carve, Gewinde, Fase, An-/Wegfahren, Schlichtgang, Zwiebelhaut, Trochoidal,
//! Drehachse …) meldet camJob.ts als „noch nicht“ – dann entsteht hier gar nichts.
//!
//! AN DER MASCHINE NUR GEPRÜFT: „Zur Maschine“ und „G-Code speichern“ holen den G-Code hier (Befehl `millgcode_generate`),
//! cam.ts rechnet denselben Auftrag daneben, und das Fenster nimmt diesen G-Code nur, wenn er Zeichen für Zeichen gleich ist
//! und Hinweise, Gewinde und Werkzeuge stimmen (rustChecked in camJob.ts) – sonst bleibt es bei cam.ts. Alle Vorschauen
//! rechnen weiter mit cam.ts; im Entwicklungs-Build wird dort daneben verglichen (Befehl `millgcode_shadow`).
//! Neben dem G-Code entstehen hier auch die Hinweise (gcw.*, cut.*), die Gewinde-Liste und das Werkzeug je Abschnitt.
//! Geprüft außerdem mit festen Fällen: tests/fixtures/millgcode-cases.json.gz (in der Vorschau aus cam.ts erzeugt,
//! siehe tests/fixtures/README.md) und die Tests unten.

use crate::cutorder;
use crate::gcodesim::{hypot2, hypot3, mn, mx};
use crate::jsmath::{self, js_num, to_fixed};
use crate::milllead::{dist_to_path, lead_at_point, plan_lead, plan_lead_at_start, LeadMove, LeadOpts, LeadPlan};
use crate::pocket::{pocket_paths, pocket_wall_paths, PocketPath};
use crate::vcarve::{vcarve_paths, VOptions};
use crate::polyoffset::{offset_polygon, point_in_poly, polygon_area, simplify_polygon, simplify_polyline, P};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const MM_TO_PIXEL: f64 = 2.0;
/// Sicherheitsabstand über dem Werkstück
const SAFE_Z: f64 = 5.0;
/// wie CAM_SIMPLIFY_MM in cam.ts
const SIMPLIFY_MM: f64 = 0.005;
/// wie ARC_TOL in shapeTransform.ts
const ARC_TOL: f64 = 0.02;

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    /// Name, schon ohne Umlaute und Sonderzeichen (wie er im G-Code steht)
    pub name: String,
    /// Name, wie er in der Bibliothek steht (für Hinweise)
    #[serde(default)]
    pub raw_name: String,
    /// Wählrad der Oberfräse reicht nicht: "low" | "high" (Hinweis gcw.dial.*) und die Drehzahl der Stufe
    #[serde(default)]
    pub dial_out: Option<String>,
    #[serde(default)]
    pub dial_rpm: f64,
    /// Anbohrer: sein Ø muss nicht zum Loch passen
    #[serde(default)]
    pub spot: bool,
    /// Werkzeugart in der Sprache der Oberfläche – nur bei Arten, die nicht für Konturen/Taschen taugen (gcw.toolType)
    #[serde(default)]
    pub type_text: Option<String>,
    /// Einzahn-Gewindefräser und die Länge seines Halses (gcw.threadReach)
    #[serde(default)]
    pub thread_single: bool,
    #[serde(default)]
    pub flute_len: f64,
    /// Schneiden-Ø abzüglich Verschleiß (cutDiameter)
    pub diameter: f64,
    pub step_z: f64,
    pub feedrate: f64,
    pub rpm: f64,
    pub plunge_feed: f64,
    /// tan(Eintauchwinkel), vom Fenster gerechnet (dort kann die letzte Stelle anders sein als hier – und an genau
    /// halben Höhen kippt sonst die Rundung); 0 = senkrecht (für Bohrer, V-Stichel & Co. immer 0)
    pub ramp_tan: f64,
    /// Zeile für die Oberfräse mit Wählrad (fertiger Text), sonst None
    #[serde(default)]
    pub dial: Option<String>,
    /// Ø ohne Verschleiß-Abzug (Reihenfolge der Werkzeuge, Werkzeugliste im Kopf)
    #[serde(default)]
    pub raw_diameter: f64,
    /// Platz in der Bibliothek (Reihenfolge der Werkzeuge bei gleichem Ø)
    #[serde(default)]
    pub lib_index: f64,
    /// Anfang der Werkzeugwechsel-Zeile: "M0 " oder "M6 T3 " (toolChangeGcode in toolChange.ts)
    #[serde(default)]
    pub change: String,
    /// Reibahle: in einem Zug auf Tiefe und mit Vorschub wieder heraus
    #[serde(default)]
    pub reamer: bool,
    /// Kegel, Reibahle, Gewindefräser, Konusfräser: damit wird nicht trochoidal gefräst
    #[serde(default)]
    pub no_tro: bool,
    /// Kegel-Werkzeug (V-Stichel, Fasenfräser, Senker, Bohrer): nur damit geht eine Fase
    #[serde(default)]
    pub cone: bool,
    /// Winkel an der Spitze in Grad
    #[serde(default)]
    pub angle: f64,
    /// Ø der Spitze
    #[serde(default)]
    pub tip_dia: f64,
    /// tan(halber Winkel), vom Fenster gerechnet (wie ramp_tan)
    #[serde(default)]
    pub chamfer_tan: f64,
    /// Gewindefräser: Steigung des Werkzeugs (0 = Einzahn); None = kein Gewindefräser
    #[serde(default)]
    pub thread_pitch: Option<f64>,
}

/// Gewinde an einem Kreis (millThread in cam.ts)
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    /// Gewindelänge (positiv)
    pub len: f64,
    /// Nenn-Ø (0 = automatisch)
    pub d: f64,
    /// Steigung (0 = automatisch)
    pub pitch: f64,
    pub left: bool,
    pub passes: f64,
    pub spring: bool,
}

/// Trochoidal: Nutbreite und Vorschub je Kreis in % vom Fräser-Ø, Zustellung in mm (0 = vom Fräser)
#[derive(Deserialize, Clone, Debug)]
pub struct TroOpts {
    pub w: f64,
    pub step: f64,
    pub down: f64,
}

/// so viel bleibt an der Wand für die Kontur danach stehen
const TRO_LEAVE: f64 = 0.05;

struct TroPlan {
    /// Radius der kleinen Kreise
    rho: f64,
    /// je Umlauf: (Mitte des Kreises, Stelle auf dem Kreis, an der er beginnt und endet)
    loops: Vec<Vec<(P, P)>>,
    /// hat die Nut die ganze Kontur freigelegt?
    full: bool,
}

/// Bahnen für eine Kontur in mm (trochoidPlan in trochoid.ts). None = kein Platz oder zu viele Kreise
fn trochoid_plan(poly: &[P], inside: bool, r: f64, allow: f64, o: &TroOpts) -> Option<TroPlan> {
    let rho = (2.0 * r * o.w / 100.0 - 2.0 * r) / 2.0;
    let sg = if inside { -1.0 } else { 1.0 };
    let rings = offset_polygon(poly, sg * (r + allow + TRO_LEAVE + rho), 0.01);
    if rings.is_empty() || !(rho > 0.0) {
        return None;
    }
    let step = 2.0 * r * o.step / 100.0;
    let mut loops: Vec<Vec<(P, P)>> = Vec::new();
    let mut total = 0.0;
    for ring0 in &rings {
        // Umlauf wie die normale Kontur: außen gegen, innen im Uhrzeigersinn
        let ring = if (!inside) == (polygon_area(ring0) > 0.0) { ring0.clone() } else { reversed_keep_first(ring0) };
        let n_pts = ring.len();
        let mut cum = vec![0.0f64];
        for i in 1..=n_pts {
            cum.push(cum[i - 1] + hypot2(ring[i % n_pts][0] - ring[i - 1][0], ring[i % n_pts][1] - ring[i - 1][1]));
        }
        let l = cum[cum.len() - 1];
        if l < 1e-6 {
            continue;
        }
        let n = mx(8.0, (l / step).ceil());
        total += n;
        if total > 40000.0 {
            return None;
        }
        let mut list = Vec::new();
        let mut i = 1;
        for k in 0..=(n as usize) {
            let s = l * k as f64 / n;
            while i < cum.len() - 1 && cum[i] < s {
                i += 1;
            }
            let (a, b) = (ring[i - 1], ring[i % n_pts]);
            let len = mx(1e-12, cum[i] - cum[i - 1]);
            let f = (s - cum[i - 1]) / len;
            let (ux, uy) = ((b[0] - a[0]) / len, (b[1] - a[1]) / len);
            let c = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
            list.push((c, [c[0] - ux * rho, c[1] - uy * rho]));
        }
        loops.push(list);
    }
    if loops.is_empty() {
        return None;
    }
    // Jeder Punkt der fertigen Kontur muss in der freigefrästen Nut liegen, sonst steht dort (enge Ecke) noch Material
    let want = offset_polygon(poly, sg * (r + allow), 0.01);
    let mut full = !want.is_empty();
    let tol = TRO_LEAVE + mx(0.05, 0.1 * rho);
    for w in &want {
        let mut i = 0;
        while full && i < w.len() {
            let (a, b) = (w[i], w[(i + 1) % w.len()]);
            let l = hypot2(b[0] - a[0], b[1] - a[1]);
            let m = mx(1.0, (l / mx(0.2, r / 2.0)).ceil());
            for k in 0..(m as usize) {
                let p = [a[0] + (b[0] - a[0]) * k as f64 / m, a[1] + (b[1] - a[1]) * k as f64 / m];
                if !rings.iter().any(|q| dist_to_path(p, q, true) <= rho + tol) {
                    full = false;
                    break;
                }
            }
            i += 1;
        }
    }
    Some(TroPlan { rho, loops, full })
}

/// Höhen, in denen der Fräser bei einem Kreis mit Radius rho in Schraubenlinie eintaucht (helixZ); `tan3` = tan(3°)
fn helix_z(z_top: f64, z: f64, rho: f64, tan: f64, tan3: f64) -> Vec<f64> {
    let drop = z_top - z;
    if !(drop > 1e-6) {
        return vec![z];
    }
    let revs = mx(1.0, mn(400.0, (drop / mx(1e-6, (if tan > 0.0 { tan } else { tan3 }) * 2.0 * std::f64::consts::PI * rho)).ceil()));
    (0..revs as usize).map(|k| z_top - drop * (k as f64 + 1.0) / revs).collect()
}

/// Flöte: Länge von Ein- und Auslauf (mm), Tiefe am Anfang und Ende (% von voll), gerade Schräge statt S-Kurve
#[derive(Deserialize, Clone, Debug)]
pub struct FluteOpts {
    #[serde(rename = "in")]
    pub lin: f64,
    pub out: f64,
    pub start: f64,
    pub end: f64,
    pub linear: bool,
}

/// Ein- und Auslauf auf eine Bahn der Länge l bringen: zusammen nie länger als die Bahn (fluteZones)
fn flute_zones(l: f64, o: &FluteOpts) -> (f64, f64) {
    let sum = o.lin + o.out;
    if sum > l && sum > 0.0 {
        (l * o.lin / sum, l * o.out / sum)
    } else {
        (o.lin, o.out)
    }
}

/// Anteil der vollen Tiefe (0…1) bei Länge s auf einer Bahn der Länge l (fluteFrac)
fn flute_frac(s: f64, l: f64, o: &FluteOpts) -> f64 {
    let (zin, zout) = flute_zones(l, o);
    let ease = |u: f64| {
        let u = mx(0.0, mn(1.0, u));
        if o.linear {
            u
        } else {
            u * u * (3.0 - 2.0 * u)
        }
    };
    let a = if zin > 0.0 { o.start / 100.0 + (1.0 - o.start / 100.0) * ease(s / zin) } else { 1.0 };
    let b = if zout > 0.0 { o.end / 100.0 + (1.0 - o.end / 100.0) * ease((l - s) / zout) } else { 1.0 };
    mn(a, b)
}

/// Bahnen je Durchgang (flutePasses in fluting.ts): Punkte [x, y, z]. Jeder Durchgang fährt nur das Stück, das tiefer
/// liegt als der Durchgang davor
fn flute_passes(path: &[P], passes: &[f64], o: &FluteOpts) -> Vec<Vec<[f64; 3]>> {
    let depth = passes[passes.len() - 1];
    if path.len() < 2 || !(depth < 0.0) {
        return vec![];
    }
    // Stützstellen mit der Tiefe nach der Kurve: alle Ecken und im Ein-/Auslauf alle ~0,5 mm
    let mut cum = vec![0.0f64];
    for i in 1..path.len() {
        cum.push(cum[i - 1] + hypot2(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
    }
    let l = cum[cum.len() - 1];
    if !(l > 1e-6) {
        return vec![];
    }
    let (zin, zout) = flute_zones(l, o);
    let mut at: Vec<f64> = cum.clone();
    for (from, len) in [(0.0, zin), (l - zout, zout)] {
        let n = mn(400.0, mx(32.0, (len / 0.5).ceil()));
        if len > 1e-6 {
            for k in 0..=(n as usize) {
                at.push(mn(l, mx(0.0, from + len * k as f64 / n)));
            }
        }
    }
    at.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut prof: Vec<(f64, [f64; 3])> = Vec::new();
    let mut i = 1;
    for s in at {
        if prof.last().is_some_and(|q| s - q.0 < 1e-6) {
            continue;
        }
        while i < cum.len() - 1 && cum[i] < s {
            i += 1;
        }
        let f = (s - cum[i - 1]) / mx(1e-12, cum[i] - cum[i - 1]);
        prof.push((s, [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * f, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * f, depth * flute_frac(s, l, o)]));
    }
    let p: Vec<[f64; 3]> = prof.iter().map(|q| q.1).collect();
    let mut out = Vec::new();
    let mut prev = 0.0f64;
    for &z in passes {
        let deep = |w: Option<&[f64; 3]>| w.is_some_and(|w| w[2] < prev - 1e-9);
        let mut pts: Vec<[f64; 3]> = Vec::new();
        for i in 0..p.len() {
            let q = p.get(i + 1);
            let before = if i > 0 { p.get(i - 1) } else { None };
            // genau auf der Höhe des vorigen Durchgangs zählt mit, wenn es daneben tiefer wird
            let below = deep(Some(&p[i])) || (p[i][2] <= prev + 1e-9 && (deep(before) || deep(q)));
            if below {
                pts.push([p[i][0], p[i][1], mx(z, p[i][2])]);
            }
            // Übergänge genau treffen: Tiefe des vorigen Durchgangs (rein/raus) und Tiefe dieses Durchgangs (Knick)
            if let Some(q) = q {
                let mut cross: Vec<f64> = [prev, z].iter().map(|c| (c - p[i][2]) / (q[2] - p[i][2])).filter(|f| f.is_finite() && *f > 1e-9 && *f < 1.0 - 1e-9).collect();
                cross.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                for f in cross {
                    let zz = p[i][2] + (q[2] - p[i][2]) * f;
                    pts.push([p[i][0] + (q[0] - p[i][0]) * f, p[i][1] + (q[1] - p[i][1]) * f, mx(z, mn(prev, zz))]);
                }
            }
        }
        // Punkte, die auf einer Geraden im Raum liegen, weglassen (Abweichung unter 0,002 mm)
        let mut thin: Vec<[f64; 3]> = Vec::new();
        for i in 0..pts.len() {
            if i == 0 || i == pts.len() - 1 {
                thin.push(pts[i]);
                continue;
            }
            let (a, b, c) = (thin[thin.len() - 1], pts[i + 1], pts[i]);
            let (dx, dy, dz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
            let l2 = dx * dx + dy * dy + dz * dz;
            let f = if l2 > 0.0 { ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy + (c[2] - a[2]) * dz) / l2 } else { 0.0 };
            if f < 0.0 || f > 1.0 || hypot3(a[0] + dx * f - c[0], a[1] + dy * f - c[1], a[2] + dz * f - c[2]) > 0.002 {
                thin.push(c);
            }
        }
        if thin.len() > 1 {
            out.push(thin);
        }
        prev = z;
    }
    out
}

/// Nachmessen: Abstand zwischen zwei Messungen in Minuten (geschätzte Laufzeit) und die Zeile für einen Mess-Punkt
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Drift {
    pub every_min: f64,
    pub marker: String,
    /// kein Messplatz eingetragen (Hinweis gcw.driftNoSpot)
    #[serde(default)]
    pub no_spot: bool,
}

/// Platzhalter-Zeile an jeder sicheren Stelle (zwischen zwei Formen, Fräser oben)
const DRIFT_SLOT: &str = "(#drift-slot#)";

/// Aus den Platzhaltern Mess-Punkte machen (placeDriftPoints): am ersten Platz einer, danach einer, sobald seit dem
/// letzten die geschätzte Laufzeit erreicht ist. Alle anderen Plätze fallen weg. Die Laufzeit kommt aus gcodesim.rs
fn place_drift_points(gcode: &str, d: &Drift) -> String {
    let lines: Vec<&str> = gcode.split('\n').collect();
    let prog = crate::gcodesim::parse(gcode, &crate::gcodesim::Options::default());
    let every = mx(1.0, d.every_min) * 60.0;
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let (mut k, mut t_now, mut last, mut points) = (0usize, 0.0f64, f64::NEG_INFINITY, 0usize);
    for (i, l) in lines.iter().enumerate() {
        while k < prog.line.len() && (prog.line[k] as usize) < i {
            t_now = prog.t0[k] + prog.dur[k] as f64;
            k += 1;
        }
        if *l != DRIFT_SLOT {
            out.push(l);
            continue;
        }
        if points == 0 || t_now - last >= every {
            out.push(&d.marker);
            last = t_now;
            points += 1;
        }
    }
    out.join("\n")
}

/// Zwiebelhaut: Dicke der Haut, am Ende durchfräsen?, Vorschub dafür (0 = automatisch)
#[derive(Deserialize, Clone, Debug)]
pub struct SkinSettings {
    pub h: f64,
    pub cut: bool,
    pub feed: f64,
}

/// Zustellungen mit Zwiebelhaut (skinPlan in onionSkin.ts)
#[derive(Clone, Debug)]
struct SkinPlan {
    /// Z des tiefsten normalen Gangs
    floor: f64,
    /// Frästiefe der Form – tiefer geht nie etwas
    through: f64,
    stock: f64,
    /// Dicke der Haut, die wirklich stehen bleibt
    skin: f64,
    passes: Vec<f64>,
    /// Gänge des letzten Schnitts durch die Haut (leer = die Haut bleibt)
    last: Vec<f64>,
}

/// Was aus der Zwiebelhaut einer Form wird (skinPlan in onionSkin.ts)
enum Skin {
    Plan(SkinPlan),
    /// die Haut ist so dick wie die Frästiefe: die Form wird ausgelassen
    TooThick,
    /// der Schnitt reicht nicht bis zur Unterseite (nur zweiseitig bekannt): fräsen wie immer, ohne Haut
    NotThrough,
}

/// `stock_under` = zweiseitig fräsen: Material unter der Oberseite an dieser Stelle (None = die Frästiefe ist die Unterseite)
fn skin_plan(depth: f64, step_z: f64, s: &SkinSettings, stock_under: Option<f64>) -> Skin {
    let d = -mn(0.0, depth);
    let known = stock_under.filter(|u| u.is_finite() && *u > 0.0);
    if known.is_some_and(|u| d < u - 1e-6) {
        return Skin::NotThrough;
    }
    let stock = known.map_or(d, |u| mn(d, u));
    let floor_d = ((stock - s.h) * 100.0 + 1e-6).floor() / 100.0;
    if !(floor_d >= 0.01) {
        return Skin::TooThick;
    }
    let step = mx(0.05, step_z.abs());
    let (floor, through) = (-floor_d, -d);
    Skin::Plan(SkinPlan {
        floor,
        through,
        stock,
        skin: to_fixed(stock - floor_d, 6).parse().unwrap_or(stock - floor_d),
        passes: depth_passes_from(floor, step, 0.0),
        last: if s.cut { depth_passes_from(through, step, floor) } else { vec![] },
    })
}

/// Vorschub des letzten Gangs: der Wunsch, aber nie schneller als normal; ohne Wunsch die Hälfte (skinFeed)
fn skin_feed(s: &SkinSettings, normal: f64) -> f64 {
    let f = if s.feed > 0.0 { mn(s.feed, normal) } else { jsmath::js_round(normal / 2.0) };
    mx(1.0, mn(normal, mx(10.0, f)))
}

/// Der letzte Gang einer Form mit Haut, vorgemerkt für das Programmende – mit allem, was beim Fräsen der Form galt
struct SkinJob {
    rank: u8,
    plan: SkinPlan,
    set: SkinSettings,
    shape: Shape,
    k: usize,
    gi: usize,
    n: usize,
    tool: Option<usize>,
    dia: f64,
    step_z: f64,
    feed: f64,
    rpm: f64,
    plunge: f64,
    ramp_tan: f64,
    lead: Option<LeadOpts>,
    /// der Gang gehört zur Restbearbeitung der Form (kleineres Werkzeug), nicht zur Form selbst
    rest: bool,
}

/// Bahn einer Form in mm (shapeToPaths, im Fenster gerechnet)
#[derive(Deserialize, Clone, Debug)]
pub struct MmPath {
    pub pts: Vec<P>,
    pub closed: bool,
}

/// Schnittwerte aus dem Material-Profil der Form
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Cut {
    pub feedrate: f64,
    pub rpm: f64,
    pub step_z: f64,
    pub plunge_feed: f64,
    /// Name des Profils, schon ohne Umlaute
    pub label: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub len: f64,
    pub h: f64,
    /// selbst gesetzt (tabPts) statt gleichmäßig verteilt (n)
    pub manual: bool,
    #[serde(default)]
    pub n: f64,
    /// Stellen 0…1 entlang der Kontur der Form
    #[serde(default)]
    pub pts: Vec<f64>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Shape {
    /// "polyline" | "circle" | "line" | "arc"
    #[serde(rename = "type")]
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub points: Vec<P>,
    #[serde(default)]
    pub closed: bool,
    /// "outside" | "inside" | "on-line"
    pub mode: String,
    /// Frästiefe (negativ)
    pub depth: f64,
    /// "" | "climb" | "conventional"
    #[serde(default)]
    pub mill_dir: String,
    #[serde(default)]
    pub cut: Option<Cut>,
    #[serde(default)]
    pub tab: Option<Tab>,
    /// Formen derselben Kette werden nur einmal gefräst
    #[serde(default)]
    pub parent_chain_id: Option<String>,
    /// Werkzeug der Form: Nummer in `tools` (None = kein Werkzeug in der Bibliothek, „Standard“)
    #[serde(default)]
    pub tool: Option<usize>,
    /// Bogen: Punkt auf dem Bogen (Start = x/y, Ende = x+w / y+h)
    #[serde(default)]
    pub mid_x: f64,
    #[serde(default)]
    pub mid_y: f64,
    /// Bogen: Rahmen der Form [minX, minY, maxX, maxY] (shapeBounds) – für die Reihenfolge
    #[serde(default)]
    pub bounds: Option<[f64; 4]>,
    /// Kennung der Form (für „Insel nur für diese Taschen“)
    #[serde(default)]
    pub id: String,
    /// Umriss, der nie als Insel zählt
    #[serde(default)]
    pub no_island: bool,
    /// Insel nur für die Taschen mit diesen Kennungen (None = für jede)
    #[serde(default)]
    pub island_for: Option<Vec<String>>,
    /// Schlicht-Aufmaß in mm (Taschen und geschlossene Konturen außen/innen), 0 = keins
    #[serde(default)]
    pub finish_allow: f64,
    /// An-/Wegfahren (nur geschlossene Formen außen/innen), None = aus
    #[serde(default)]
    pub lead: Option<LeadOpts>,
    /// Planfräsen: Fläche der Form in mm [x0, y0, Breite, Höhe] (aus shapeToPaths, im Fenster gerechnet)
    #[serde(default)]
    pub face: Option<[f64; 4]>,
    /// Fase an einem Bogen: die Bahn in mm
    #[serde(default)]
    pub paths: Option<Vec<MmPath>>,
    #[serde(default)]
    pub thread: Option<Thread>,
    /// Fase: Breite in mm (0 = nichts angegeben, dann 1) und Seite (1 außen, −1 innen, 0 auf der Linie);
    /// die Seite gilt auch für das Gewinde (−1 innen, 1 außen)
    #[serde(default)]
    pub chamfer_w: f64,
    #[serde(default)]
    pub chamfer_side: f64,
    /// Kopie für eine weitere Bearbeitung (ops.ts): Nummer des Originals in `shapes`. Kopien zählen nicht als Insel
    /// und nicht als Hindernis beim Anfahren; „die eigene Form“ ist dort das Original
    #[serde(default)]
    pub base: Option<usize>,
    /// Stufenbohrung: [Ø der Senkung, Ø des Lochs darunter]
    #[serde(default)]
    pub cbore: Option<[f64; 2]>,
    /// Zweiseitig, Loch für einen Passstift: fertige Kommentar-Zeile statt „Form n“
    #[serde(default)]
    pub pin_mark: Option<String>,
    /// Zwiebelhaut (onionSkin.ts) für diesen Schnitt, None = keine
    #[serde(default)]
    pub skin: Option<SkinSettings>,
    /// zweiseitig fräsen: Material unter der Oberseite an der Stelle dieser Form (die Haut zählt von dort)
    #[serde(default)]
    pub stock_under: Option<f64>,
    /// Trochoidal (trochoid.ts), None = aus
    #[serde(default)]
    pub tro: Option<TroOpts>,
    /// Restmaterial: kleineres Werkzeug (Nummer in `tools`), das nach dem eigenen noch einmal kommt
    #[serde(default)]
    pub rest_tool: Option<usize>,
    /// Flöte (fluting.ts): Nut, die sanft ein- und ausläuft; None = aus
    #[serde(default)]
    pub flute: Option<FluteOpts>,
    /// Inlay-Stecker (vplug): Start-Tiefe (positiv)
    #[serde(default)]
    pub v_start: f64,
    /// Richtung von Hand (cutSetting.ts): "cw" | "ccw" | "forward" | "reverse" | "" (nichts gesetzt)
    #[serde(default)]
    pub cut_dir: String,
    /// Startpunkt von Hand: Anteil 0..1 entlang der eigenen Kontur
    #[serde(default)]
    pub cut_start: Option<f64>,
    /// Kreis, Bogen oder Linie mit Startpunkt/Richtung von Hand: die Form als Linienzug (so fräst cam.ts sie dann)
    #[serde(default)]
    pub cut_points: Option<MmPath>,
    /// nur intern: die Form ist so ein Linienzug (cam.ts arbeitet dann mit einer Kopie – die eigene Zeichnung zählt
    /// beim Anfahren als fremde Form)
    #[serde(skip)]
    pub converted: bool,
    /// Material-Profil gilt für ein anderes Werkzeug: sein Name (Hinweis gcw.cutDataOff)
    #[serde(default)]
    pub cut_off: Option<String>,
    /// Startpunkt/Richtung von Hand: "ignored" (wirkt bei dieser Art nicht) | "millDir" (gewinnt über Gleich-/Gegenlauf)
    #[serde(default)]
    pub cut_warn: String,
    /// Zwiebelhaut eingestellt, wirkt hier aber nicht (zählt für gcw.skinIgnored)
    #[serde(default)]
    pub skin_ignored: bool,
    /// Gewinde in ein Loch, das als Kontur „Innen“ gefräst wird: Schneiden-Ø und Ø jenes Fräsers (gcw.threadCore)
    #[serde(default)]
    pub thread_first: Option<[f64; 2]>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    /// Kennung des Auftrags-Formats: ändert sich, wenn camJob.ts etwas anders liefert
    pub version: u32,
    /// alle Werkzeuge des Auftrags (die Formen nennen ihre Nummer)
    pub tools: Vec<Tool>,
    /// "M3" oder "M4" (Drehrichtung umgekehrt)
    pub spindle: String,
    /// Textbausteine der Kommentare (gc.*), schon ohne Umlaute, mit Platzhaltern {n}
    pub texts: HashMap<String, String>,
    pub shapes: Vec<Shape>,
    /// Taschen-Strategie: "linear" | "spiral" | "adaptive"
    #[serde(default)]
    pub pocket_strategy: String,
    /// Vorschub in Kurven anpassen (feedadapt.rs): kleinster Vorschub in %, None = aus
    #[serde(default)]
    pub feed_adapt: Option<f64>,
    /// Werkzeug während langer Jobs nachmessen (driftPoints.ts), None = aus
    #[serde(default)]
    pub drift: Option<Drift>,
    /// tan(3°) für den Helix-Einstieg der adaptiven Tasche, vom Fenster gerechnet (Grund wie bei ramp_tan)
    #[serde(default)]
    pub helix_tan: f64,
    /// Bahnen aller Formen in mm (shapeToPaths) – nur wenn An-/Wegfahren vorkommt: dort darf nichts im Weg sein
    #[serde(default)]
    pub lead_others: Vec<Other>,
    /// Texte der Hinweise (gcw.*, cut.*) in der Sprache der Oberfläche, mit Platzhaltern {n}
    #[serde(default)]
    pub warn_texts: HashMap<String, String>,
    /// Formen, deren Restmaterial-Werkzeug nicht passt (Hinweis gcw.restIgnored)
    #[serde(default)]
    pub rest_ignored: usize,
    /// so viele Bilder lagen neben den Formen (nur der Laser kann sie): Hinweis img.onlyLaser, ganz vorn
    #[serde(default)]
    pub images: usize,
    /// Datei für eine Steuerung mit Werkzeugtabelle: jedes Werkzeug mit Nummer, auch das erste (gc.toolLoad)
    #[serde(default)]
    pub tool_table: bool,
    /// Formen ohne Werkzeug („Standard“): Anfang der Werkzeugwechsel-Zeile und Stufe am Wählrad der Oberfräse
    #[serde(default)]
    pub no_tool: Option<NoTool>,
}

/// Was für „Standard“ (kein Werkzeug in der Bibliothek, 12000 U/min) gilt – sonst steht es beim Werkzeug
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NoTool {
    /// Anfang der Werkzeugwechsel-Zeile ("M0 " oder "M6 T0 ")
    pub change: String,
    #[serde(default)]
    pub dial: Option<String>,
    #[serde(default)]
    pub dial_out: Option<String>,
    #[serde(default)]
    pub dial_rpm: f64,
}

/// Ein Hinweis zum G-Code: Schlüssel der Sprachdatei und die Werte dazu (das Fenster setzt sie mit t() ein).
/// `text` = derselbe Hinweis schon eingesetzt (in mm) – daran wird „schon gemeldet“ erkannt, wie in cam.ts
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Warn {
    pub key: String,
    pub p: Vec<(String, String)>,
    pub text: String,
}

/// Ein gefrästes Gewinde (ThreadInfo in threadMill.ts) – die 3D-Ansicht zeichnet daraus die Gewindegänge
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ThreadInfo {
    pub cx: f64,
    pub cy: f64,
    #[serde(rename = "D")]
    pub d: f64,
    #[serde(rename = "P")]
    pub p: f64,
    pub internal: bool,
    pub left: bool,
    pub length: f64,
    #[serde(rename = "majorD")]
    pub major_d: f64,
    #[serde(rename = "minorD")]
    pub minor_d: f64,
}

/// Alles, was cam.ts beim Erzeugen liefert: G-Code, Hinweise, Gewinde, Werkzeug je Abschnitt (Nummer in job.tools)
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub gcode: String,
    pub warnings: Vec<Warn>,
    pub threads: Vec<ThreadInfo>,
    pub section_tools: Vec<Option<usize>>,
}

/// Bahn einer Form, an der eine Anfahrbahn vorbeikommen muss
#[derive(Deserialize, Clone, Debug)]
pub struct Other {
    pub pts: Vec<P>,
    pub closed: bool,
    /// Nummer der Form, zu der die Bahn gehört
    pub owner: usize,
}

/// Das Format, das diese Datei versteht (gleiche Zahl wie MILL_JOB_VERSION in camJob.ts)
pub const JOB_VERSION: u32 = 19;

struct Gen<'a> {
    job: &'a Job,
    out: String,
    tool_radius: f64,
    step_z: f64,
    feed_xy: f64,
    rpm: f64,
    plunge: f64,
    /// tan(Eintauchwinkel) – 0 = senkrecht
    ramp_tan: f64,
    passes: Vec<f64>,
    /// An-/Wegfahren der Form, die gerade gefräst wird
    cur_lead: Option<LeadOpts>,
    /// Nummer der Form, die gerade gefräst wird
    cur_shape: usize,
    /// Reibahle eingesetzt
    reamer: bool,
    /// Werkzeug der laufenden Gruppe (None = „Standard“)
    tool: Option<&'a Tool>,
    /// die laufende Form wird als Linienzug-Kopie gefräst (Startpunkt/Richtung von Hand an Kreis, Bogen, Linie)
    converted: bool,
    /// Z, bei dem der erste Durchgang anfängt: 0 = Oberseite; beim letzten Gang durch die Zwiebelhaut die Haut
    pass_top: f64,
    /// Frästiefe der Form, solange eine Form mit Haut gefräst wird
    skin_depth: Option<f64>,
    /// Hinweise (lastGcodeWarnings), Gewinde (lastThreads), Werkzeug je Abschnitt (lastSectionTools)
    warns: Vec<Warn>,
    threads: Vec<ThreadInfo>,
    sections: Vec<Option<usize>>,
    /// Nummer der Form im G-Code (formCounter)
    n: usize,
    /// Formen, deren Zwiebelhaut nicht wirkt
    skin_ignored: usize,
}

fn to_machine(x: f64, y: f64) -> P {
    [x / MM_TO_PIXEL, y / MM_TO_PIXEL]
}
fn f2(v: f64) -> String {
    to_fixed(v, 2)
}
fn f3(v: f64) -> String {
    to_fixed(v, 3)
}

/// Geschlossene Kontur in die gewünschte Richtung drehen; sie fängt weiter am selben Punkt an (orientClosed)
fn orient_closed(lp: Vec<P>, ccw: bool) -> Vec<P> {
    if lp.len() < 3 || (polygon_area(&lp) > 0.0) == ccw {
        lp
    } else {
        reversed_keep_first(&lp)
    }
}

/// Geschlossene Kontur so drehen, dass sie am nächsten Punkt zu `target` beginnt; liegt der auf einer Kante, kommt
/// dort ein Punkt dazu (rotateLoopTo in cutSetting.ts)
fn rotate_loop_to(input: Vec<P>, target: P) -> Vec<P> {
    let n0 = input.len();
    let lp: &[P] = if n0 > 1 && hypot2(input[0][0] - input[n0 - 1][0], input[0][1] - input[n0 - 1][1]) < 1e-9 { &input[..n0 - 1] } else { &input };
    let n = lp.len();
    if n < 2 {
        return input;
    }
    let (mut best, mut edge, mut u) = (f64::INFINITY, 0usize, 0.0f64);
    for i in 0..n {
        let (a, b) = (lp[i], lp[(i + 1) % n]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        let k = if l2 > 0.0 { mx(0.0, mn(1.0, ((target[0] - a[0]) * dx + (target[1] - a[1]) * dy) / l2)) } else { 0.0 };
        let d = hypot2(a[0] + dx * k - target[0], a[1] + dy * k - target[1]);
        if d < best - 1e-12 {
            best = d;
            edge = i;
            u = k;
        }
    }
    let (a, b) = (lp[edge], lp[(edge + 1) % n]);
    let len = hypot2(b[0] - a[0], b[1] - a[1]);
    if u * len < 1e-6 {
        return [&lp[edge..], &lp[..edge]].concat();
    }
    if (1.0 - u) * len < 1e-6 {
        let k = (edge + 1) % n;
        return [&lp[k..], &lp[..k]].concat();
    }
    let p = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    let mut out = vec![p];
    out.extend_from_slice(&lp[edge + 1..]);
    out.extend_from_slice(&lp[..edge + 1]);
    out
}

/// Punkt bei einem Anteil 0..1 entlang einer geschlossenen Kontur (pointAtFraction)
fn point_at_fraction(pts: &[P], f: f64) -> P {
    let mut list = pts.to_vec();
    list.push(pts[0]);
    let mut total = 0.0;
    for i in 1..list.len() {
        total += hypot2(list[i][0] - list[i - 1][0], list[i][1] - list[i - 1][1]);
    }
    let mut left = mx(0.0, mn(1.0, f)) * total;
    for i in 1..list.len() {
        let l = hypot2(list[i][0] - list[i - 1][0], list[i][1] - list[i - 1][1]);
        if left <= l && l > 0.0 {
            let u = left / l;
            return [list[i - 1][0] + (list[i][0] - list[i - 1][0]) * u, list[i - 1][1] + (list[i][1] - list[i - 1][1]) * u];
        }
        left -= l;
    }
    list[list.len() - 1]
}

/// Gesetzter Startpunkt der Form in mm; None = keiner gesetzt (cutStartMm). Formen mit Startpunkt sind hier immer Linienzüge
fn cut_start_mm(s: &Shape) -> Option<P> {
    let f = s.cut_start?;
    if s.kind != "polyline" || !s.closed || s.points.len() < 2 {
        return None;
    }
    let q = point_at_fraction(&s.points, f);
    Some([q[0] / MM_TO_PIXEL, q[1] / MM_TO_PIXEL])
}

/// Geschlossene Bahn (mm): gesetzte Richtung und gesetzten Start anwenden (applyCutClosed)
fn apply_cut_closed(lp: Vec<P>, s: &Shape) -> Vec<P> {
    let mut out = lp;
    if s.cut_dir == "cw" || s.cut_dir == "ccw" {
        out = orient_closed(out, s.cut_dir == "ccw");
    }
    if let Some(start) = cut_start_mm(s) {
        out = rotate_loop_to(out, start);
    }
    out
}

/// Bahn (mm) mit der Einstellung von Hand: geschlossen wie oben, offen nur rückwärts oder nicht (applyCut)
fn apply_cut(pts: Vec<P>, closed: bool, s: &Shape) -> Vec<P> {
    if closed {
        apply_cut_closed(pts, s)
    } else if s.cut_dir == "reverse" {
        pts.into_iter().rev().collect()
    } else {
        pts
    }
}

/// Kreis/Ellipse als Vieleck (makeEllipsePoints in shapeTransform.ts)
fn ellipse_points(cx: f64, cy: f64, rx: f64, ry: f64) -> Vec<P> {
    let pi = std::f64::consts::PI;
    let r = mx(rx.abs(), ry.abs());
    let arc_steps = if r <= ARC_TOL {
        4.0
    } else {
        let max_step = 2.0 * jsmath::acos(mx(-1.0, 1.0 - ARC_TOL / r));
        mx(4.0, ((pi * 2.0).abs() / max_step).ceil())
    };
    let steps = mx(24.0, arc_steps);
    let n = if steps.is_finite() { steps as usize } else { 24 };
    (0..n)
        .map(|i| {
            let a = (i as f64 / steps) * pi * 2.0;
            [cx + rx.abs() * jsmath::cos(a), cy + ry.abs() * jsmath::sin(a)]
        })
        .collect()
}

/// Zustellungen bis `target` in Schritten von step_z (depthPasses in onionSkin.ts, ab Oberseite 0)
fn depth_passes(target: f64, step_z: f64) -> Vec<f64> {
    depth_passes_from(target, step_z, 0.0)
}
/// `from` = Z, bei dem der Schnitt anfängt (0 = Oberseite)
fn depth_passes_from(target: f64, step_z: f64, from: f64) -> Vec<f64> {
    let mut passes = Vec::new();
    if target >= from {
        passes.push(if target == 0.0 { 0.0 } else { target });
    } else {
        let mut z = from - step_z;
        let mut guard = 0;
        while z > target + 0.001 && guard < 100_000 {
            passes.push(z);
            z -= step_z;
            guard += 1;
        }
        passes.push(target);
    }
    passes
}

/// Bahn umdrehen, aber am selben Punkt anfangen
fn reversed_keep_first(l: &[P]) -> Vec<P> {
    let mut out = Vec::with_capacity(l.len());
    if let Some(first) = l.first() {
        out.push(*first);
        out.extend(l[1..].iter().rev());
    }
    out
}

/// Soll die Bahn gegen den Uhrzeigersinn laufen? None = keine Vorgabe (millDir.ts)
fn wants_ccw(inside: bool, dir: &str) -> Option<bool> {
    if dir != "climb" && dir != "conventional" {
        return None;
    }
    Some(inside == (dir == "climb"))
}
fn orient_loop(l: Vec<P>, inside: bool, dir: &str) -> Vec<P> {
    match wants_ccw(inside, dir) {
        Some(ccw) if l.len() >= 3 && (polygon_area(&l) > 0.0) != ccw => reversed_keep_first(&l),
        _ => l,
    }
}

// ---- Haltestege (tabs.ts) ----

/// Laufende Länge entlang des Rings (geschlossen, letzter Punkt != erster)
fn cumulative(ring: &[P]) -> Vec<f64> {
    let mut cum = vec![0.0];
    for i in 1..=ring.len() {
        let (a, b) = (ring[i - 1], ring[i % ring.len()]);
        cum.push(cum[i - 1] + hypot2(b[0] - a[0], b[1] - a[1]));
    }
    cum
}
/// Punkt bei Länge s auf dem Ring
fn point_at(ring: &[P], cum: &[f64], s: f64) -> P {
    let l = cum[cum.len() - 1];
    let s = ((s % l) + l) % l;
    let mut i = 1;
    while i < cum.len() - 1 && cum[i] < s {
        i += 1;
    }
    let (a, b) = (ring[i - 1], ring[i % ring.len()]);
    let f = (s - cum[i - 1]) / mx(1e-12, cum[i] - cum[i - 1]);
    [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
}
/// Nächste Stelle auf dem Ring: Länge s und Abstand d
fn project(ring: &[P], cum: &[f64], p: P) -> (f64, f64) {
    let mut best = (0.0, f64::INFINITY);
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 { mx(0.0, mn(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) } else { 0.0 };
        let d = hypot2(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
        if d < best.1 {
            best = (cum[i] + l2.sqrt() * t, d);
        }
    }
    best
}
/// Kontur der Form in Welt-Pixeln (nur geschlossene Formen)
fn outline(s: &Shape) -> Option<Vec<P>> {
    if s.kind == "circle" {
        return Some(ellipse_points(s.x, s.y, s.w.abs(), s.w.abs()));
    }
    if s.kind == "polyline" && s.closed && s.points.len() >= 3 {
        return Some(s.points.clone());
    }
    None
}
/// Mitten der Stege als Länge s auf der Fräserbahn `ring` (in mm)
fn tab_centers(shape: &Shape, tab: &Tab, ring: &[P], cum: &[f64], near: f64) -> Vec<f64> {
    let l = cum[cum.len() - 1];
    if tab.manual {
        let mut out = Vec::new();
        let Some(world) = outline(shape) else { return out };
        let wcum = cumulative(&world);
        for &f in &tab.pts {
            let w = point_at(&world, &wcum, f * wcum[wcum.len() - 1]);
            let (s, d) = project(ring, cum, to_machine(w[0], w[1]));
            if d <= near {
                out.push(s);
            }
        }
        return out;
    }
    let n = tab.n;
    let count = if n.is_finite() && n > 0.0 { n as usize } else { 0 };
    (0..count).map(|k| ((k as f64 + 0.5) / n) * l).collect()
}

impl Gen<'_> {
    /// Kommentar in Klammern aus einem Textbaustein:  c("gc.shape", { n, type, mode })
    fn c(&self, key: &str, params: &[(&str, String)]) -> String {
        let mut s = self.job.texts.get(key).cloned().unwrap_or_else(|| key.to_string());
        for (k, v) in params {
            s = s.replace(&format!("{{{k}}}"), v);
        }
        format!("({s})")
    }
    fn push(&mut self, s: &str) {
        self.out.push_str(s);
    }
    fn warn_of(&self, key: &str, params: &[(&str, String)]) -> Warn {
        let mut text = self.job.warn_texts.get(key).cloned().unwrap_or_else(|| key.to_string());
        for (k, v) in params {
            text = text.replace(&format!("{{{k}}}"), v);
        }
        Warn { key: key.to_string(), p: params.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(), text }
    }
    /// Hinweis melden:  w("gcw.split", { n, parts })
    fn w(&mut self, key: &str, params: &[(&str, String)]) {
        let w = self.warn_of(key, params);
        self.warns.push(w);
    }
    /// Hinweis nur melden, wenn derselbe Text noch nicht da ist
    fn w_once(&mut self, key: &str, params: &[(&str, String)]) {
        let w = self.warn_of(key, params);
        if !self.warns.iter().any(|o| o.text == w.text) {
            self.warns.push(w);
        }
    }
    /// Hinweis, der nur die Nummer der Form nennt
    fn wn(&mut self, key: &str) {
        self.w(key, &[("n", self.n.to_string())]);
    }
    fn too_big(&mut self) {
        self.w("gcw.toolTooBig", &[("n", self.n.to_string()), ("d", js_num(self.tool_radius * 2.0))]);
    }
    fn no_lead(&mut self) {
        self.w_once("gcw.leadNoRoom", &[("n", self.n.to_string())]);
    }
    fn safe(&mut self) {
        let s = format!("G0 Z{}\n", f2(SAFE_Z));
        self.push(&s);
    }
    fn g1(&mut self, p: P) {
        let s = format!("G1 X{} Y{}\n", f3(p[0]), f3(p[1]));
        self.push(&s);
    }
    fn g0(&mut self, p: P) {
        let s = format!("G0 X{} Y{}\n", f3(p[0]), f3(p[1]));
        self.push(&s);
    }

    /// Werkzeug-Werte setzen (useTool), Werkzeug einsetzen und Spindel starten (toolStart in cam.ts);
    /// `gi` = Nummer in der Werkzeugliste, `change` = mit Werkzeugwechsel
    fn start_tool(&mut self, t: Option<usize>, gi: usize, change: bool) {
        let job = self.job;
        // ---- Werkzeug-Werte ----
        let tool = t.map(|t| &job.tools[t]);
        let dia = tool.map_or(3.0, |t| t.diameter);
        self.tool_radius = dia / 2.0;
        self.step_z = tool.map_or(1.5, |t| mx(0.05, t.step_z.abs()));
        self.feed_xy = tool.map_or(800.0, |t| t.feedrate);
        self.rpm = tool.map_or(12000.0, |t| t.rpm);
        self.plunge = tool.map_or(300.0, |t| t.plunge_feed);
        self.ramp_tan = tool.map_or(0.0, |t| t.ramp_tan);
        self.reamer = tool.is_some_and(|t| t.reamer);
        self.tool = tool;

        // ---- Werkzeug einsetzen (ab dem zweiten mit Werkzeugwechsel) und Spindel starten ----
        let tool_name = t.map_or("Standard".to_string(), |t| job.tools[t].name.clone());
        let none = job.no_tool.as_ref();
        let dial = match tool {
            Some(t) => t.dial.clone(),
            None => none.and_then(|n| n.dial.clone()),
        };
        let prefix = match tool {
            Some(t) => t.change.clone(),
            None => none.map_or("M0 ".to_string(), |n| n.change.clone()),
        };
        if change {
            let shown = dial.as_ref().map_or(tool_name.clone(), |d| format!("{tool_name} - {d}"));
            let comment = self.c(if job.tool_table { "gc.toolLoad" } else { "gc.toolChange" }, &[("i", (gi + 1).to_string()), ("name", shown), ("d", to_fixed(dia, 1))]);
            let line = format!("\nG0 Z{}\nM5 {}\n{prefix}{comment}\n", f2(SAFE_Z), self.c("gc.spindleOff", &[]));
            self.push(&line);
        } else if job.tool_table {
            // Datei für eine Steuerung mit Werkzeugtabelle: auch das erste Werkzeug mit Nummer (ohne die Stufe am Wählrad)
            let comment = self.c("gc.toolLoad", &[("i", (gi + 1).to_string()), ("name", tool_name.clone()), ("d", to_fixed(dia, 1))]);
            let line = format!("{prefix}{comment}\n");
            self.push(&line);
        }
        let line = format!("\n{}\n", self.c("gc.tool", &[("name", tool_name), ("d", to_fixed(dia, 1))]));
        self.push(&line);
        if let Some(d) = dial {
            let line = format!("({d})\n");
            self.push(&line);
        }
        let dial_out = match tool {
            Some(t) => t.dial_out.as_ref().map(|o| (o.clone(), t.raw_name.clone(), t.dial_rpm)),
            None => none.and_then(|n| n.dial_out.as_ref().map(|o| (o.clone(), "Standard".to_string(), n.dial_rpm))),
        };
        if let Some((out, name, min)) = dial_out {
            self.w_once(&format!("gcw.dial.{out}"), &[("name", name), ("rpm", js_num(self.rpm)), ("min", js_num(min))]);
        }
        let line = format!("{} S{} {}\n", job.spindle, js_num(self.rpm), self.c("gc.spindleOn", &[("rpm", js_num(self.rpm))]));
        self.push(&line);
        if change {
            let line = format!("G4 P2 {}\n", self.c("gc.spinUp", &[]));
            self.push(&line);
        }
        let line = format!("F{} {}\n", js_num(self.feed_xy), self.c("gc.feed", &[("f", js_num(self.feed_xy))]));
        self.push(&line);
        self.sections.push(t);
    }

    /// EINTAUCHEN von z_top auf z am Anfang der Bahn pts – mit Eintauchwinkel als Rampe entlang der Bahn
    fn plunge_to(&mut self, pts: &[P], closed: bool, z_top: f64, z: f64, max_len: f64) {
        let drop = z_top - z;
        if !(self.ramp_tan > 0.0) || drop <= 1e-6 || pts.len() < 2 {
            return self.plunge_straight(z);
        }
        let mut seq: Vec<P> = pts.to_vec();
        if closed {
            seq.push(pts[0]);
        }
        let mut cum = vec![0.0f64];
        for i in 1..seq.len() {
            cum.push(cum[i - 1] + hypot2(seq[i][0] - seq[i - 1][0], seq[i][1] - seq[i - 1][1]));
        }
        let avail = mn(cum[cum.len() - 1], max_len);
        let l = drop / self.ramp_tan;
        let k = (l / (2.0 * mx(avail, 1e-9))).ceil();
        if avail < 0.5 || k > 50.0 || !k.is_finite() {
            return self.plunge_straight(z);
        }
        let d = l / (2.0 * k);
        let at = |sd: f64| -> P {
            let mut i = 1;
            while i < cum.len() - 1 && cum[i] < sd {
                i += 1;
            }
            let f = (sd - cum[i - 1]) / mx(1e-12, cum[i] - cum[i - 1]);
            [seq[i - 1][0] + (seq[i][0] - seq[i - 1][0]) * f, seq[i - 1][1] + (seq[i][1] - seq[i - 1][1]) * f]
        };
        // Stützpunkte der Strecke 0 → d (Ecken der Bahn dazwischen), zurück dieselben rückwärts
        let mut fwd: Vec<f64> = cum.iter().copied().filter(|&x| x > 1e-9 && x < d - 1e-9).collect();
        fwd.push(d);
        let mut steps = fwd.clone();
        steps.extend(fwd[..fwd.len() - 1].iter().rev());
        steps.push(0.0);
        let line = format!("G1 Z{} F{} {}\n", f3(z_top), js_num(self.plunge), self.c("gc.ramp", &[]));
        self.push(&line);
        let (mut travelled, mut pos, mut first) = (0.0f64, 0.0f64, true);
        for _ in 0..k as usize {
            for &sd in &steps {
                travelled += (sd - pos).abs();
                pos = sd;
                let p = at(sd);
                let hz = mx(z, z_top - drop * travelled / l);
                let feed = if first { format!(" F{}", js_num(self.feed_xy)) } else { String::new() };
                let line = format!("G1 X{} Y{} Z{}{}\n", f3(p[0]), f3(p[1]), f3(hz), feed);
                self.push(&line);
                first = false;
            }
        }
    }
    /// Andere Formen im Weg? Der Fräser muss mit seinem Radius (und etwas Luft) daran vorbeikommen
    fn lead_free(&self) -> impl Fn(&[P]) -> bool + '_ {
        self.lead_free_extra(0.0)
    }
    /// `extra` = so viel Platz braucht der Fräser zusätzlich (trochoidal: der Radius der kleinen Kreise)
    fn lead_free_extra(&self, extra: f64) -> impl Fn(&[P]) -> bool + '_ {
        let (job, keep, k, converted) = (self.job, self.tool_radius + 0.1 + extra, self.cur_shape, self.converted);
        move |pts: &[P]| {
            let k = job.shapes[k].base.unwrap_or(k);
            let chain = job.shapes[k].parent_chain_id.as_ref().filter(|c| !c.is_empty());
            for o in &job.lead_others {
                if (o.owner == k && !converted) || (chain.is_some() && job.shapes.get(o.owner).and_then(|s| s.parent_chain_id.as_ref()) == chain) {
                    continue;
                }
                if pts.iter().any(|p| dist_to_path(*p, &o.pts, o.closed) < keep) {
                    return false;
                }
            }
            true
        }
    }
    fn emit_lead(&mut self, m: &LeadMove) {
        let line = match m.arc {
            Some((cmd, i, j)) => format!("{cmd} X{} Y{} I{} J{}\n", f3(m.to[0]), f3(m.to[1]), f3(i), f3(j)),
            None => format!("G1 X{} Y{}\n", f3(m.to[0]), f3(m.to[1])),
        };
        self.push(&line);
    }
    /// Anfang einer Zustellung mit An-/Wegfahren: oben zum Anfang der Anfahrbahn, dort im Abfall eintauchen, anfahren.
    /// false = keine Anfahrbahn (nur Wegfahren): der Aufrufer taucht an der Kontur ein
    fn lead_begin(&mut self, plan: &LeadPlan, top: f64, z: f64) -> bool {
        let p0 = plan.lin.as_ref().map_or(plan.start, |m| m.from);
        let line = format!("G0 Z{}\nG0 X{} Y{}\nG0 Z{}\n", f2(SAFE_Z), f3(p0[0]), f3(p0[1]), f3((if self.pass_top < 0.0 { 0.0 } else { top }) + 0.5));
        self.push(&line);
        match &plan.lin {
            Some(m) => {
                let two = [m.from, m.to];
                let pts: &[P] = if m.arc.is_some() { &m.pts } else { &two };
                self.plunge_to(pts, false, top, z, f64::INFINITY);
                self.emit_lead(m);
                true
            }
            None => false,
        }
    }
    fn lead_end(&mut self, plan: &LeadPlan) {
        if let Some(m) = &plan.out {
            self.emit_lead(m);
        }
    }
    /// Geschlossene Bahn mit An-/Wegfahren: jede Zustellung für sich
    fn mill_path_plan(&mut self, pts: &[P], plan: &LeadPlan) {
        if pts.len() < 2 {
            return;
        }
        let passes = self.passes.clone();
        for (i, &z) in passes.iter().enumerate() {
            let top = if i > 0 { passes[i - 1] } else { self.pass_top };
            if !self.lead_begin(plan, top, z) {
                self.plunge_to(pts, true, top, z, f64::INFINITY);
            }
            for p in &pts[1..] {
                self.g1(*p);
            }
            self.g1(pts[0]);
            self.lead_end(plan);
        }
        self.safe();
    }

    fn plunge_straight(&mut self, z: f64) {
        let s = format!("G1 Z{} F{}\nG1 F{}\n", f3(z), js_num(self.plunge), js_num(self.feed_xy));
        self.push(&s);
    }

    /// Punktezug in allen Zustellungen fräsen (ohne An-/Wegfahren, ohne Schlichtgang)
    fn mill_path(&mut self, pts: &[P], closed: bool) {
        if pts.len() < 2 {
            return;
        }
        let start = pts[0];
        self.safe();
        self.g0(start);
        let passes = self.passes.clone();
        for (i, &z) in passes.iter().enumerate() {
            if !closed && i > 0 {
                self.safe();
                self.g0(start);
            }
            self.plunge_to(pts, closed, if i > 0 { passes[i - 1] } else { self.pass_top }, z, f64::INFINITY);
            for p in &pts[1..] {
                self.g1(*p);
            }
            if closed {
                self.g1(start);
            }
        }
        self.safe();
    }

    /// Geschlossene Kontur mit Haltestegen fräsen; false = ging nicht (dann normal fräsen)
    /// `lead` = Schrupp-Bahnen beim Schlichtgang: dort eintauchen (da ist schon alles frei), dann seitlich anfahren
    fn mill_tabbed(&mut self, lp: &[P], shape: &Shape, tab: &Tab, lead: Option<&[Vec<P>]>) -> bool {
        let passes = self.passes.clone();
        // mit Zwiebelhaut zählen die Stege weiter ab der Frästiefe der Form
        let target = self.skin_depth.unwrap_or(passes[passes.len() - 1]);
        let z_tab = target + tab.h;
        if z_tab >= -0.001 {
            // Stege höher als die Frästiefe
            self.w("gcw.tabsTooHigh", &[("n", self.n.to_string()), ("h", js_num(tab.h))]);
            return false;
        }
        let cum = cumulative(lp);
        let len = cum[cum.len() - 1];
        // Fräserbahn über dem Steg = Steglänge + Fräserdurchmesser
        let half = tab.len / 2.0 + self.tool_radius;
        let mut centers = tab_centers(shape, tab, lp, &cum, self.tool_radius * 1.5 + 1.0);
        centers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        if centers.is_empty() {
            return false;
        }
        // Anfangen in der Mitte der größten Lücke – so taucht der Fräser nie in einem Steg ein
        let (mut s0, mut gap) = (0.0f64, -1.0f64);
        for (i, &c) in centers.iter().enumerate() {
            let next = if i + 1 < centers.len() { centers[i + 1] } else { centers[0] + len };
            // gleich große Lücken: immer die erste (wie in cam.ts) – nicht die, die die letzte Rechenstelle „größer“ macht
            if next - c > gap + 1e-9 {
                gap = next - c;
                s0 = (c + next) / 2.0;
            }
        }
        // Startpunkt von Hand: die Bahn beginnt schon dort. Liegt er in einem Steg, gewinnt der Steg
        if shape.cut_start.is_some() {
            if centers.iter().any(|&c| mn(c.abs(), (c - len).abs()) < half) {
                self.w("cut.startInTab", &[]);
            } else {
                s0 = 0.0;
            }
        }
        let too_many = if tab.manual { gap <= 2.0 * half } else { len / (centers.len() as f64) < 3.0 * half };
        if too_many {
            self.w("gcw.tabsTooMany", &[("n", self.n.to_string()), ("k", centers.len().to_string())]);
            return false;
        }
        let rel = |x: f64| (((x - s0) % len) + len) % len;
        let spans: Vec<[f64; 2]> = centers.iter().map(|&c| [rel(c) - half, rel(c) + half]).collect();
        // Punkte der Bahn ab s0 + Anfang/Ende jedes Stegs, nach Länge sortiert
        let start = point_at(lp, &cum, s0);
        let mut seq: Vec<(P, f64)> = vec![(start, 0.0)];
        seq.extend(lp.iter().enumerate().map(|(i, &p)| (p, rel(cum[i]))).filter(|q| q.1 > 1e-9));
        for sp in &spans {
            for &m in sp {
                seq.push((point_at(lp, &cum, s0 + m), m));
            }
        }
        seq.push((start, len));
        seq.sort_by(|u, v| u.1.partial_cmp(&v.1).unwrap_or(std::cmp::Ordering::Equal));
        let in_tab = |x: f64| spans.iter().any(|sp| x > sp[0] && x < sp[1]);
        let seq_pts: Vec<P> = seq.iter().map(|q| q.0).collect();
        // Rampe nur bis kurz vor den ersten Steg
        let ramp_len = mx(0.0, gap / 2.0 - half - self.tool_radius);

        // eine Runde auf Tiefe z, über den Stegen auf Steg-Höhe
        macro_rules! round {
            ($z:expr) => {{
                let z: f64 = $z;
                let mut up = false;
                for j in 1..seq.len() {
                    let want = z < z_tab - 1e-6 && in_tab((seq[j - 1].1 + seq[j].1) / 2.0);
                    if want && !up {
                        let line = format!("G1 Z{} {}\n", f3(z_tab), self.c("gc.tab", &[]));
                        self.push(&line);
                        up = true;
                    } else if !want && up {
                        self.plunge_straight(z);
                        up = false;
                    }
                    self.g1(seq[j].0);
                }
            }};
        }
        // An-/Wegfahren an der Startstelle (nicht beim Schlichtgang: der taucht auf der Schrupp-Bahn ein)
        if lead.is_none() {
            if let Some(o) = self.cur_lead.clone() {
                let far = |q: &&(P, f64)| hypot2(q.0[0] - start[0], q.0[1] - start[1]) > 1e-6;
                let next = seq.iter().find(far).map(|q| q.0);
                let prev = seq.iter().rev().find(far).map(|q| q.0);
                let mut plan = None;
                if let (Some(next), Some(prev)) = (next, prev) {
                    let u = |a: P, b: P| -> P {
                        let l = hypot2(b[0] - a[0], b[1] - a[1]);
                        [(b[0] - a[0]) / l, (b[1] - a[1]) / l]
                    };
                    plan = lead_at_point(start, u(start, next), u(prev, start), lp, polygon_area(lp) > 0.0, shape.mode == "inside", &o, &self.lead_free());
                }
                if let Some(pl) = plan {
                    for (pi, &z) in passes.iter().enumerate() {
                        let top = if pi > 0 { passes[pi - 1] } else { self.pass_top };
                        if !self.lead_begin(&pl, top, z) {
                            self.plunge_to(&seq_pts, false, top, z, ramp_len);
                        }
                        round!(z);
                        self.lead_end(&pl);
                    }
                    self.safe();
                    return true;
                }
                self.no_lead();
            }
        }
        let entry = lead.and_then(|l| nearest_on(&loops_as_paths(l), start));
        self.safe();
        self.g0(entry.unwrap_or(start));
        for (pi, &z) in passes.iter().enumerate() {
            if entry.is_some() && pi == 0 {
                let line = format!("G1 Z{} F{}\nG1 X{} Y{} F{}\n", f3(z), js_num(self.plunge), f3(start[0]), f3(start[1]), js_num(self.feed_xy));
                self.push(&line);
            } else {
                self.plunge_to(&seq_pts, false, if pi > 0 { passes[pi - 1] } else { self.pass_top }, z, ramp_len);
            }
            round!(z);
        }
        // Schlichtgang: mit „Wegfahren“ zurück auf die freie Schrupp-Bahn, bevor es nach oben geht
        if let Some(e) = entry {
            if self.cur_lead.as_ref().is_some_and(|l| l.out) {
                self.g1(e);
            }
        }
        self.safe();
        true
    }

    fn mill_line(&mut self, shape: &Shape) {
        let s0 = to_machine(shape.x, shape.y);
        self.g0(s0);
        let e0 = to_machine(shape.x + shape.w, shape.y + shape.h);
        let passes = self.passes.clone();
        let last = passes[passes.len() - 1];
        for (pi, &z) in passes.iter().enumerate() {
            self.plunge_to(&[s0, e0], false, if pi > 0 { passes[pi - 1] } else { 0.0 }, z, f64::INFINITY);
            self.g1(e0);
            if z != last {
                self.safe();
                self.g0(s0);
            }
        }
        self.safe();
    }

    /// `last` = letzter Gang der Zwiebelhaut (am Programmende): nur die Kontur auf Maß, ohne Schlicht-Aufmaß
    fn mill_circle(&mut self, shape: &Shape, offset: f64, last: bool) {
        let pi = std::f64::consts::PI;
        let mode = shape.mode.as_str();
        let center = to_machine(shape.x, shape.y);
        let radius_px = shape.w.abs();
        let radius_final = radius_px / MM_TO_PIXEL + offset;
        // Schlichtgang: erst mit Aufmaß (außen größer, innen kleiner), danach auf Maß
        let mut allow = if !last && (mode == "outside" || mode == "inside") { shape.finish_allow } else { 0.0 };
        if allow > 0.0 && mode == "inside" && radius_final - allow <= 0.05 {
            self.w("gcw.finishSkip", &[("n", self.n.to_string()), ("a", js_num(allow))]);
            allow = 0.0;
        }
        let radius_mm = radius_final + if mode == "outside" { allow } else { -allow };
        let all_passes = self.passes.clone();
        let tab = if mode != "on-line" { shape.tab.as_ref() } else { None };
        if !last && (mode == "outside" || mode == "inside") {
            let r = radius_px / MM_TO_PIXEL;
            self.mill_trochoid(shape, &ellipse_points(center[0], center[1], r, r), mode == "inside", allow, tab);
        }
        let side_inside = match mode {
            "outside" => Some(false),
            "inside" => Some(true),
            _ => None,
        };
        let dir = if side_inside.is_some() { shape.mill_dir.as_str() } else { "" };
        // Vollkreis: ohne Vorgabe G2, sonst nach der Fräsrichtung
        let cmd = match wants_ccw(side_inside.unwrap_or(false), dir) {
            Some(true) => "G3",
            _ => "G2",
        };
        // mit Haltestegen: Kreis als Vieleck. Standard wie die Konturen: außen gegen, innen im Uhrzeigersinn
        if let Some(tab) = tab {
            if radius_mm > 0.05 {
                let ring = ellipse_points(center[0], center[1], radius_mm, radius_mm);
                let ring = if wants_ccw(side_inside.unwrap_or(false), dir).is_some() {
                    orient_loop(ring, side_inside.unwrap_or(false), dir)
                } else if mode == "inside" {
                    reversed_keep_first(&ring)
                } else {
                    ring
                };
                if self.mill_tabbed(&ring, shape, tab, None) {
                    if allow > 0.0 {
                        let fin = ellipse_points(center[0], center[1], radius_final, radius_final);
                        let fin = if wants_ccw(side_inside.unwrap_or(false), dir).is_some() {
                            orient_loop(fin, side_inside.unwrap_or(false), dir)
                        } else if mode == "inside" {
                            reversed_keep_first(&fin)
                        } else {
                            fin
                        };
                        self.finish_start();
                        self.mill_tabbed(&fin, shape, tab, Some(&[ring]));
                    }
                    self.passes = all_passes;
                    return;
                }
            }
        }
        if radius_mm > 0.05 {
            let passes = self.passes.clone();
            let (entry_x, entry_y) = (center[0], center[1] + radius_mm);
            // An-/Wegfahren oben am Kreis; Fahrtrichtung dort: G2 nach +X, G3 nach −X
            let plan = match (self.cur_lead.clone(), side_inside) {
                (Some(o), Some(ins)) => {
                    let ccw = cmd == "G3";
                    let tan = [if ccw { -1.0 } else { 1.0 }, 0.0];
                    let plan = lead_at_point([entry_x, entry_y], tan, tan, &ellipse_points(center[0], center[1], radius_mm, radius_mm), ccw, ins, &o, &self.lead_free());
                    if plan.is_none() {
                        self.no_lead();
                    }
                    plan
                }
                _ => None,
            };
            let full = |zz: Option<f64>| format!("{cmd} X{} Y{}{} I0.000 J{}\n", f3(entry_x), f3(entry_y), zz.map_or(String::new(), |v| format!(" Z{}", f3(v))), f3(-radius_mm));
            for (i, &z) in passes.iter().enumerate() {
                let z_top = if i > 0 { passes[i - 1] } else { self.pass_top };
                let drop = z_top - z;
                if let Some(pl) = &plan {
                    if !self.lead_begin(pl, z_top, z) {
                        self.plunge_straight(z);
                    }
                    let line = full(None);
                    self.push(&line);
                    self.lead_end(pl);
                    continue;
                }
                self.g0([entry_x, entry_y]);
                if self.ramp_tan > 0.0 && drop > 1e-6 {
                    // Rampe als Schraube auf dem Kreis (so viele Runden, dass der Winkel nicht steiler wird)
                    let revs = mx(1.0, (drop / self.ramp_tan / (2.0 * pi * radius_mm)).ceil());
                    let line = format!("G1 Z{} F{} {}\nG1 F{}\n", f3(z_top), js_num(self.plunge), self.c("gc.ramp", &[]), js_num(self.feed_xy));
                    self.push(&line);
                    let mut k = 1.0;
                    while k <= revs {
                        let line = full(Some(z_top - (drop * k) / revs));
                        self.push(&line);
                        k += 1.0;
                    }
                } else {
                    let line = format!("G1 Z{} F{}\nF{}\n", f2(z), js_num(self.plunge), js_num(self.feed_xy));
                    self.push(&line);
                }
                let line = full(None);
                self.push(&line);
            }
            if allow > 0.0 {
                // auf der Schrupp-Bahn eintauchen, seitlich auf Maß, eine Runde, zurück
                if plan.is_some() {
                    // nach An-/Wegfahren steht der Fräser woanders: oben zurück auf die Schrupp-Bahn
                    self.safe();
                    self.g0([center[0], center[1] + radius_mm]);
                }
                let z = passes[passes.len() - 1];
                let y_f = center[1] + radius_final;
                let line = format!(
                    "{}\nG1 Z{} F{}\nG1 X{} Y{} F{}\n{cmd} X{} Y{} I0.000 J{}\nG1 X{} Y{}\n",
                    self.c("gc.finish", &[]), f3(z), js_num(self.plunge), f3(center[0]), f3(y_f), js_num(self.feed_xy),
                    f3(center[0]), f3(y_f), f3(-radius_final), f3(center[0]), f3(center[1] + radius_mm)
                );
                self.push(&line);
            }
            self.safe();
        } else {
            let line = format!("{}\n", self.c("gc.circleTooSmall", &[]));
            self.push(&line);
            self.wn("gcw.circleTooSmall");
        }
    }

    /// BOHREN: in der Mitte der Form senkrecht hinein, nach jeder Zustellung ganz heraus (Späne brechen)
    fn mill_drill(&mut self, shape: &Shape) {
        /// so weit über dem Material beginnt der Vorschub (DRILL_CLEAR in cam.ts)
        const DRILL_CLEAR: f64 = 0.5;
        let (c_px, hole_px) = if shape.kind == "circle" {
            ([shape.x, shape.y], 2.0 * shape.w.abs())
        } else {
            let (min_x, max_x, min_y, max_y) = match (shape.kind.as_str(), shape.bounds) {
                (_, Some(b)) => (b[0], b[2], b[1], b[3]),
                ("polyline", _) => (shape.x, shape.x + shape.w, shape.y, shape.y + shape.h),
                _ => (mn(shape.x, shape.x + shape.w), mx(shape.x, shape.x + shape.w), mn(shape.y, shape.y + shape.h), mx(shape.y, shape.y + shape.h)),
            };
            ([(min_x + max_x) / 2.0, (min_y + max_y) / 2.0], mx(max_x - min_x, max_y - min_y))
        };
        // Anbohrer: zentriert nur, sein Ø muss nicht zum Loch passen
        let hole_dia = hole_px / MM_TO_PIXEL;
        if !self.tool.is_some_and(|t| t.spot) && (hole_dia - self.tool_radius * 2.0).abs() > 0.05 {
            self.w("gcw.drillSize", &[("n", self.n.to_string()), ("h", to_fixed(hole_dia, 2)), ("d", js_num(self.tool_radius * 2.0))]);
        }
        let p = to_machine(c_px[0], c_px[1]);
        let passes = self.passes.clone();
        let line = format!("G0 Z{}\nG0 X{} Y{}\nG0 Z{}\n", f2(SAFE_Z), f3(p[0]), f3(p[1]), f2(DRILL_CLEAR));
        self.push(&line);
        if self.reamer {
            let line = format!("G1 Z{} F{}\nG1 Z{}\nG0 Z{}\n", f3(passes[passes.len() - 1]), js_num(self.plunge), f2(DRILL_CLEAR), f2(SAFE_Z));
            self.push(&line);
            return;
        }
        for (i, &z) in passes.iter().enumerate() {
            if i > 0 {
                let line = format!("G0 Z{} {}\nG0 Z{}\n", f2(DRILL_CLEAR), self.c("gc.peck", &[]), f3(passes[i - 1] + 0.3));
                self.push(&line);
            }
            let line = format!("G1 Z{} F{}\n", f3(z), js_num(self.plunge));
            self.push(&line);
        }
        self.safe();
    }

    /// PLANFRÄSEN (facingPath in facing.ts): Zeilen entlang X über die Fläche der Form, je Tiefe einmal
    /// RESTMATERIAL mit dem aktuellen (kleinen) Werkzeug (millRest in cam.ts): Bahnen des kleinen Fräsers wie für die ganze
    /// Form, aber nur die Stücke, an denen das große Werkzeug nicht hinkam. Ein Punkt gilt als schon frei, wenn der
    /// kleine Fräser dort ganz in einen Kreis des großen passt: Abstand zur großen Bahn ≤ R − r
    fn mill_rest(&mut self, k: usize) {
        let job = self.job;
        let shape = &job.shapes[k];
        let Some(big) = shape.tool else { return };
        let (big_r, r, dir) = (job.tools[big].diameter / 2.0, self.tool_radius, shape.mill_dir.as_str());
        let (big_paths, small): (Vec<(Vec<P>, bool)>, Vec<(Vec<P>, bool)>);
        if shape.mode == "pocket" {
            let Some(outer) = closed_mm(shape) else { return };
            let isl = islands_of(job, k, &outer);
            big_paths = pocket_paths(&outer, &isl, big_r, mx(0.05, 2.0 * big_r * 0.4), &job.pocket_strategy, "").0.into_iter().map(|p| (p.pts, p.closed)).collect();
            small = pocket_paths(&outer, &isl, r, mx(0.05, r * 2.0 * 0.4), "spiral", dir).0.into_iter().map(|p| (p.pts, p.closed)).collect();
        } else if shape.kind == "polyline" && shape.closed {
            let pts: Vec<P> = shape.points.iter().map(|p| to_machine(p[0], p[1])).collect();
            big_paths = offset_polygon(&pts, -big_r, 0.01).into_iter().map(|l| (l, true)).collect();
            // Standard wie die Konturen: innen im Uhrzeigersinn (umgedreht); sonst die Vorgabe der Form
            small = offset_polygon(&pts, -r, 0.01).into_iter().map(|l| (if dir.is_empty() { reversed_keep_first(&l) } else { orient_loop(l, true, dir) }, true)).collect();
        } else {
            // Kreis innen: keine Ecken
            let line = format!("{}\n", self.c("gc.restNone", &[]));
            self.push(&line);
            return;
        }
        if small.is_empty() {
            self.too_big();
            return;
        }
        // Strecken der großen Bahn in einem Raster (schnelle Abstandsfrage)
        let thr = big_r - r + 0.005;
        let cell = mx(1.0, thr);
        let mut grid: HashMap<(i64, i64), Vec<(P, P)>> = HashMap::new();
        for (pts, closed) in &big_paths {
            let count = if *closed { pts.len() } else { pts.len().saturating_sub(1) };
            for i in 0..count {
                let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
                for gx in (mn(a[0], b[0]) / cell).floor() as i64..=(mx(a[0], b[0]) / cell).floor() as i64 {
                    for gy in (mn(a[1], b[1]) / cell).floor() as i64..=(mx(a[1], b[1]) / cell).floor() as i64 {
                        grid.entry((gx, gy)).or_default().push((a, b));
                    }
                }
            }
        }
        let cleared = |p: P| -> bool {
            for gx in ((p[0] - thr) / cell).floor() as i64..=((p[0] + thr) / cell).floor() as i64 {
                for gy in ((p[1] - thr) / cell).floor() as i64..=((p[1] + thr) / cell).floor() as i64 {
                    for (a, b) in grid.get(&(gx, gy)).map_or(&[][..], |v| &v[..]) {
                        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                        let l2 = dx * dx + dy * dy;
                        let f = if l2 > 1e-12 { mx(0.0, mn(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) } else { 0.0 };
                        if hypot2(a[0] + dx * f - p[0], a[1] + dy * f - p[1]) <= thr {
                            return true;
                        }
                    }
                }
            }
            false
        };
        let step_s = mx(0.02, mn(0.2, r / 4.0));
        // Abtastpunkte auf geraden Stücken wieder weglassen (kürzerer G-Code)
        let thin = |q: &[P]| -> Vec<P> {
            (0..q.len())
                .filter(|&i| {
                    if i == 0 || i == q.len() - 1 {
                        return true;
                    }
                    let (a, b, p) = (q[i - 1], q[i + 1], q[i]);
                    ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])).abs() > 1e-6
                })
                .map(|i| q[i])
                .collect()
        };
        let mut pieces = 0;
        for (pts, closed) in &small {
            let closed = *closed;
            // Bahn fein abtasten
            let mut seq = pts.clone();
            if closed {
                seq.push(pts[0]);
            }
            let mut sm: Vec<P> = vec![seq[0]];
            for i in 1..seq.len() {
                let (a, b) = (seq[i - 1], seq[i]);
                let n = mx(1.0, (hypot2(b[0] - a[0], b[1] - a[1]) / step_s).ceil());
                for kk in 1..=(n as usize) {
                    sm.push([a[0] + (b[0] - a[0]) * kk as f64 / n, a[1] + (b[1] - a[1]) * kk as f64 / n]);
                }
            }
            let need: Vec<bool> = sm.iter().map(|&p| !cleared(p)).collect();
            if !need.iter().any(|&v| v) {
                continue;
            }
            if need.iter().all(|&v| v) && closed {
                self.mill_path(pts, true);
                pieces += 1;
                continue;
            }
            // jedes Stück um den Fräserradius verlängern (sauberer Übergang, Eintauchen im Freien)
            let ext = (r / step_s).ceil() as i64 + 1;
            let n = sm.len() as i64;
            let mut keep = need.clone();
            for (i, &v) in need.iter().enumerate() {
                if !v {
                    continue;
                }
                for d in -ext..=ext {
                    let j = if closed { ((i as i64 + d) % n + n) % n } else { i as i64 + d };
                    if j >= 0 && j < n {
                        keep[j as usize] = true;
                    }
                }
            }
            // geschlossene Bahn: am Anfang eines freien Stücks beginnen, damit Stücke nicht über das Ende zerfallen
            let s0 = if closed { keep.iter().position(|&v| !v).unwrap_or(0) } else { 0 };
            let mut cur: Vec<P> = Vec::new();
            for kk in 0..sm.len() {
                let i = (s0 + kk) % sm.len();
                if keep[i] {
                    cur.push(sm[i]);
                } else if !cur.is_empty() {
                    if cur.len() > 1 {
                        self.mill_path(&thin(&cur), false);
                        pieces += 1;
                    }
                    cur.clear();
                }
            }
            if cur.len() > 1 {
                self.mill_path(&thin(&cur), false);
                pieces += 1;
            }
        }
        if pieces == 0 {
            let line = format!("{}\n", self.c("gc.restNone", &[]));
            self.push(&line);
        }
    }

    /// TROCHOIDAL (millTrochoid in cam.ts): die Nut neben der Kontur in kleinen Kreisen freiräumen, bevor die normale
    /// Kontur kommt. Bei Haltestegen nur bis zu deren Oberkante. Ist die ganze Kontur frei, fährt die Kontur danach in
    /// einem Zug auf Tiefe (self.passes wird dafür gekürzt)
    fn mill_trochoid(&mut self, shape: &Shape, poly: &[P], inside: bool, allow: f64, tab: Option<&Tab>) {
        let Some(o) = shape.tro.as_ref() else { return };
        if self.pass_top < 0.0 {
            return;
        }
        let target = self.passes[self.passes.len() - 1];
        if !(target < -1e-6) {
            return;
        }
        if self.tool.is_some_and(|t| t.no_tro) {
            return self.w_once("gcw.troTool", &[("n", self.n.to_string())]);
        }
        let r = self.tool_radius;
        let Some(plan) = trochoid_plan(poly, inside, r, allow, o) else {
            return self.w_once("gcw.troNoRoom", &[("n", self.n.to_string())]);
        };
        // andere Formen: der Fräser braucht neben der Mitte den Kreisradius und seinen eigenen Radius Platz
        let every = mx(1.0, (r / 2.0 / mx(1e-6, 2.0 * r * o.step / 100.0)).floor()) as usize;
        let near = {
            let free = self.lead_free_extra(plan.rho);
            plan.loops.iter().any(|l| {
                let centres: Vec<P> = l.iter().enumerate().filter(|(i, _)| i % every == 0).map(|(_, x)| x.0).collect();
                !free(&centres)
            })
        };
        if near {
            return self.w_once("gcw.troNear", &[("n", self.n.to_string())]);
        }
        let z_tab = tab.map_or(f64::NEG_INFINITY, |t| self.skin_depth.unwrap_or(target) + t.h);
        let bottom = if z_tab < -0.001 { mx(target, z_tab) } else { target };
        let levels = depth_passes(bottom, if o.down > 0.0 { mx(0.05, o.down) } else { self.step_z });
        let cmd = if shape.mill_dir == "conventional" { "G2" } else { "G3" };
        let line = format!("{}\n", self.c("gc.trochoid", &[("w", f2(2.0 * (r + plan.rho))), ("s", f2(2.0 * r * o.step / 100.0))]));
        self.push(&line);
        let ring = |at: &(P, P), z: Option<f64>, feed: &str| {
            let zz = z.map_or(String::new(), |z| format!(" Z{}", f3(z)));
            format!("{cmd} X{} Y{}{zz} I{} J{}{feed}\n", f3(at.1[0]), f3(at.1[1]), f3(at.0[0] - at.1[0]), f3(at.0[1] - at.1[1]))
        };
        let (feed, plunge, tan, tan3) = (js_num(self.feed_xy), js_num(self.plunge), self.ramp_tan, self.job.helix_tan);
        for list in &plan.loops {
            let first = list[0];
            let s = format!("G0 Z{}\nG0 X{} Y{}\n", f2(SAFE_Z), f3(first.1[0]), f3(first.1[1]));
            self.push(&s);
            for (li, &z) in levels.iter().enumerate() {
                let top = if li > 0 { levels[li - 1] } else { 0.0 };
                // Anfang = Ende des Umlaufs: dort ist bis zur vorigen Ebene alles frei. Eintauchen in einer Schraube
                let mut s = String::new();
                if li > 0 {
                    s += &format!("G1 X{} Y{} F{feed}\n", f3(first.1[0]), f3(first.1[1]));
                }
                s += &format!("G1 Z{} F{plunge}\n", f3(top));
                for (i, zz) in helix_z(top, z, plan.rho, tan, tan3).into_iter().enumerate() {
                    s += &ring(&first, Some(zz), &if i == 0 { format!(" F{feed}") } else { String::new() });
                }
                for (i, at) in list.iter().enumerate() {
                    if i > 0 {
                        s += &format!("G1 X{} Y{}\n", f3(at.1[0]), f3(at.1[1]));
                    }
                    s += &ring(at, None, "");
                }
                self.push(&s);
            }
        }
        self.safe();
        if plan.full && self.cur_lead.is_none() {
            self.passes = if bottom > target + 1e-6 {
                let mut v = vec![bottom];
                v.extend(depth_passes_from(target, self.step_z, bottom));
                v
            } else {
                vec![target]
            };
        }
    }

    /// FLÖTE (millFlute in cam.ts): offene Linie mit Tiefe nach Kurve
    fn mill_flute(&mut self, shape: &Shape, o: &FluteOpts) {
        let line = format!("{}\n", self.c("gc.flute", &[]));
        self.push(&line);
        let paths: Vec<Vec<P>> = match (shape.kind.as_str(), &shape.paths) {
            (_, Some(p)) => p.iter().map(|q| q.pts.clone()).collect(),
            ("polyline", _) => vec![shape.points.iter().map(|p| to_machine(p[0], p[1])).collect()],
            ("line", _) => vec![vec![to_machine(shape.x, shape.y), to_machine(shape.x + shape.w, shape.y + shape.h)]],
            _ => vec![],
        };
        let passes = self.passes.clone();
        for path in paths {
            let run = apply_cut(path, false, shape);
            for pts in flute_passes(&run, &passes, o) {
                let a = pts[0];
                let s = format!("G0 Z{}\nG0 X{} Y{}\nG1 Z{} F{}\n", f2(SAFE_Z), f3(a[0]), f3(a[1]), f3(a[2]), js_num(self.plunge));
                self.push(&s);
                for (i, q) in pts[1..].iter().enumerate() {
                    let feed = if i == 0 { format!(" F{}", js_num(self.feed_xy)) } else { String::new() };
                    let s = format!("G1 X{} Y{} Z{}{feed}\n", f3(q[0]), f3(q[1]), f3(q[2]));
                    self.push(&s);
                }
            }
        }
        self.safe();
    }

    /// V-CARVE / Inlay-Stecker (millVcarve in cam.ts): alle Konturen einer Gruppe zusammen, Ringe von flach nach tief
    fn mill_vcarve(&mut self, list: &[usize], plug: bool, depth: f64, start: f64) {
        const VSTEP: f64 = 0.12;
        const CLEAR: f64 = 1.0;
        let Some(tool) = self.tool.filter(|t| t.cone && t.angle > 0.0) else {
            return self.wn("gcw.vNeedsVbit");
        };
        let loops: Vec<Vec<P>> = list.iter().filter_map(|&k| closed_mm(&self.job.shapes[k])).collect();
        if loops.is_empty() {
            return;
        }
        let o = VOptions { angle: tool.angle, tip_dia: tool.tip_dia, tool_dia: tool.raw_diameter, max_depth: depth.abs(), start, step: VSTEP, outside: plug, outside_limit: None };
        let (paths, flat) = vcarve_paths(&loops, &o);
        if paths.is_empty() {
            return self.wn("gcw.vEmpty");
        }
        let deepest = paths.iter().fold(f64::INFINITY, |a, p| mn(a, p.z));
        if !plug && flat && depth.abs() > 0.0 {
            self.w("gcw.vFlat", &[("n", self.n.to_string()), ("d", to_fixed(-deepest, 2))]);
        }
        self.passes = depth_passes(deepest, self.step_z);
        let mut prev = 0.0;
        for lz in self.passes.clone() {
            for p in paths.iter().filter(|p| p.z < prev - 1e-6) {
                let z = mx(p.z, lz);
                let s0 = p.pts[0];
                let s = format!("G0 Z{}\nG0 X{} Y{}\n", f2(CLEAR), f3(s0[0]), f3(s0[1]));
                self.push(&s);
                self.plunge_straight(z);
                for q in &p.pts[1..] {
                    let s = format!("G1 X{} Y{}\n", f3(q[0]), f3(q[1]));
                    self.push(&s);
                }
                if p.closed {
                    let s = format!("G1 X{} Y{}\n", f3(s0[0]), f3(s0[1]));
                    self.push(&s);
                }
            }
            prev = lz;
        }
        self.safe();
    }

    /// FASE mit Fasen- oder V-Fräser (millChamfer in cam.ts): Tiefe = Breite / tan(halber Winkel); die Spitze läuft
    /// um ihren halben Ø neben der Kante (außen bei Außenkonturen, innen bei Löchern)
    fn mill_chamfer(&mut self, shape: &Shape) {
        let Some(tool) = self.tool.filter(|t| t.cone && t.angle > 0.0 && !(t.angle >= 180.0)) else {
            return self.wn("gcw.chamferTool");
        };
        let w = mx(0.05, if shape.chamfer_w != 0.0 { shape.chamfer_w } else { 1.0 });
        let h = w / tool.chamfer_tan;
        let o = tool.tip_dia / 2.0;
        if o + w > tool.raw_diameter / 2.0 + 1e-6 {
            return self.w("gcw.chamferWide", &[("n", self.n.to_string()), ("w", js_num(w)), ("d", js_num(tool.raw_diameter))]);
        }
        self.passes = depth_passes(-h, self.step_z);
        let side = shape.chamfer_side;
        let dir = if side != 0.0 { shape.mill_dir.as_str() } else { "" };
        let inside = !(side > 0.0);
        if shape.kind == "circle" {
            let c0 = to_machine(shape.x, shape.y);
            let r = shape.w.abs() / MM_TO_PIXEL + side * o;
            if r <= 0.05 {
                return self.too_big();
            }
            let cmd = match wants_ccw(inside, dir) {
                Some(true) => "G3",
                _ => "G2",
            };
            let top = format!("X{} Y{}", f3(c0[0]), f3(c0[1] + r));
            let s = format!("G0 Z{}\nG0 {top}\n", f2(SAFE_Z));
            self.push(&s);
            for z in self.passes.clone() {
                self.plunge_straight(z);
                let s = format!("{cmd} {top} I0.000 J{}\n", f3(-r));
                self.push(&s);
            }
            self.safe();
            return;
        }
        if shape.kind == "polyline" && shape.closed && side != 0.0 {
            let pts: Vec<P> = shape.points.iter().map(|p| to_machine(p[0], p[1])).collect();
            let loops = if o > 1e-9 { offset_polygon(&pts, side * o, 0.01) } else { vec![pts] };
            if loops.is_empty() {
                return self.too_big();
            }
            // Standard wie die Konturen: außen gegen, innen im Uhrzeigersinn; sonst die Vorgabe
            for l in loops {
                let l = if !dir.is_empty() {
                    orient_loop(l, inside, dir)
                } else if (side > 0.0) != (polygon_area(&l) > 0.0) {
                    reversed_keep_first(&l)
                } else {
                    l
                };
                self.mill_path(&apply_cut_closed(l, shape), true);
            }
            return;
        }
        // offene Linien, Bögen: auf der Linie
        let paths: Vec<MmPath> = match (shape.kind.as_str(), &shape.paths) {
            (_, Some(p)) => p.clone(),
            ("polyline", _) => vec![MmPath { pts: shape.points.iter().map(|p| to_machine(p[0], p[1])).collect(), closed: shape.closed }],
            ("line", _) => vec![MmPath { pts: vec![to_machine(shape.x, shape.y), to_machine(shape.x + shape.w, shape.y + shape.h)], closed: false }],
            _ => vec![],
        };
        for p in paths {
            if p.pts.len() > 1 {
                let closed = p.closed;
                self.mill_path(&apply_cut(p.pts, closed, shape), closed);
            }
        }
    }

    /// GEWINDE an einem Kreis (millThread in cam.ts, Bahn aus threadMill.ts)
    fn mill_thread(&mut self, shape: &Shape, n: usize) {
        let Some((tool, tool_pitch)) = self.tool.and_then(|t| t.thread_pitch.map(|p| (t, p))) else {
            return self.wn("gcw.threadTool");
        };
        let Some(th) = shape.thread.as_ref() else { return };
        let Some((x, y, r)) = round_of(shape) else {
            return self.wn("gcw.threadCircle");
        };
        let side = shape.chamfer_side;
        if side == 0.0 {
            return self.wn("gcw.threadSide");
        }
        let c0 = to_machine(x, y);
        // Loch nur als Kontur „Innen“ gefräst: ab Loch-Ø > 2 × Fräser-Ø bleibt in der Mitte ein Kern stehen
        if let Some([first_cut, first_d]) = shape.thread_first.filter(|f| side < 0.0 && 2.0 * r / MM_TO_PIXEL > 2.0 * f[0] - 0.01) {
            let _ = first_cut;
            self.w("gcw.threadCore", &[("n", self.n.to_string()), ("h", to_fixed(2.0 * r / MM_TO_PIXEL, 2)), ("d", js_num(first_d))]);
        }
        let p = ThreadParams {
            cx: c0[0],
            cy: c0[1],
            hole_d: 2.0 * r / MM_TO_PIXEL,
            internal: side < 0.0,
            d: th.d,
            pitch: th.pitch,
            tool_pitch,
            tool_d: self.tool_radius * 2.0,
            length: th.len,
            left: th.left,
            passes: th.passes,
            spring: th.spring,
            feed: self.feed_xy,
            plunge: self.plunge,
            safe_z: SAFE_Z,
        };
        let (lines, d, pitch, info) = match thread_path(&p) {
            Ok(r) => r,
            Err(why) => return self.w(&format!("gcw.thread.{why}"), &[("n", self.n.to_string()), ("d", js_num(tool.raw_diameter))]),
        };
        // Einzahn: Hals muss tief genug reichen
        if tool.thread_single && tool.flute_len > 0.0 && info.length > tool.flute_len + 1e-6 {
            self.w("gcw.threadReach", &[("n", self.n.to_string()), ("l", js_num(info.length)), ("r", js_num(tool.flute_len))]);
        }
        self.threads.push(info);
        let side_text = self.job.texts.get(if side < 0.0 { "gc.threadIn" } else { "gc.threadOut" }).cloned().unwrap_or_default();
        let hand = self.job.texts.get(if th.left { "gc.threadLeft" } else { "gc.threadRight" }).cloned().unwrap_or_default();
        let head = self.c("gc.thread", &[("n", n.to_string()), ("d", js_num(d)), ("p", js_num(pitch)), ("l", js_num(th.len)), ("side", side_text), ("hand", hand)]);
        let s = format!("\n{head}\n{}\n", lines.join("\n"));
        self.push(&s);
    }

    fn mill_face(&mut self, shape: &Shape) {
        let Some([x0, y0, w, h]) = shape.face else { return };
        let (depth, step_z, tool_d) = (shape.depth.abs(), self.step_z, self.tool_radius * 2.0);
        if !(w > 0.0 && h > 0.0 && depth > 0.0 && tool_d > 0.0 && step_z > 0.0) {
            return self.wn("gcw.faceEmpty");
        }
        // Zahl wie String(+v.toFixed(3)): höchstens drei Stellen, ohne Nullen am Ende
        let n3 = |v: f64| js_num(to_fixed(v, 3).parse::<f64>().unwrap_or(v));
        let r = tool_d / 2.0;
        let step = tool_d * mn(0.9, mx(0.1, 0.6));
        let (a0, a1) = (x0 - r - 1.0, x0 + w + r + 1.0);
        let (c0, c1) = (y0, y0 + h);
        if !(a1 > a0 && c1 >= c0) {
            return self.wn("gcw.faceEmpty");
        }
        // Zeilen gleichmäßig von Kante zu Kante (Fräsermitte genau auf beiden Kanten)
        let rows = if c1 - c0 < 1e-9 { 1.0 } else { mx(1.0, ((c1 - c0) / step).ceil()) + 1.0 };
        let dc = if rows > 1.0 { (c1 - c0) / (rows - 1.0) } else { 0.0 };
        let passes = mx(1.0, (depth / step_z - 1e-9).ceil());
        let pt = |a: f64, c: f64| format!("X{} Y{}", n3(a), n3(c));
        let mut out = String::new();
        let mut k = 1.0;
        while k <= passes {
            let z = -mn(depth, k * step_z);
            out += &format!("G0 Z{}\nG0 {}\nG1 Z{} F{}\n", n3(SAFE_Z), pt(a0, c0), n3(z), js_num(jsmath::js_round(self.plunge)));
            let mut i = 0.0;
            while i < rows {
                let c = c0 + i * dc;
                let fwd = i % 2.0 == 0.0;
                if i > 0.0 {
                    out += &format!("G1 {}\n", pt(if fwd { a0 } else { a1 }, c));
                }
                let feed = if i == 0.0 { format!(" F{}", js_num(jsmath::js_round(self.feed_xy))) } else { String::new() };
                out += &format!("G1 {}{feed}\n", pt(if fwd { a1 } else { a0 }, c));
                i += 1.0;
            }
            k += 1.0;
        }
        out += &format!("G0 Z{}\n", n3(SAFE_Z));
        self.push(&out);
    }

    /// TASCHE: je Tiefe alle Bahnen; zwischen den Bahnen abheben. Adaptiv taucht schraubenförmig ein (Helix).
    fn mill_pocket(&mut self, k: usize, outer: &[P]) {
        let pi = std::f64::consts::PI;
        let job = self.job;
        let shape = &job.shapes[k];
        let islands = islands_of(job, k, outer);
        let step = mx(0.05, self.tool_radius * 2.0 * 0.4);
        let strategy = if job.pocket_strategy == "spiral" || job.pocket_strategy == "adaptive" { job.pocket_strategy.as_str() } else { "linear" };
        let dir = shape.mill_dir.as_str();
        let mut allow = shape.finish_allow;
        // adaptive Bögen laufen fest im Gleichlauf: die Vorgabe gilt dort nur für die Wand
        if dir == "conventional" && strategy == "adaptive" {
            self.wn("gcw.dirAdaptive");
        }
        let (mut paths, mut too_big) = pocket_paths(outer, &islands, self.tool_radius + allow, step, strategy, dir);
        if allow > 0.0 && (too_big || paths.is_empty()) {
            // mit Aufmaß passt der Fräser nicht mehr hinein → ohne Schlichtgang
            self.w("gcw.finishSkip", &[("n", self.n.to_string()), ("a", js_num(allow))]);
            allow = 0.0;
            (paths, too_big) = pocket_paths(outer, &islands, self.tool_radius, step, strategy, dir);
        }
        if too_big || paths.is_empty() {
            let line = format!("{}\n", self.c("gc.toolTooBig", &[]));
            self.push(&line);
            return self.too_big();
        }
        let passes = self.passes.clone();
        for (i, &z) in passes.iter().enumerate() {
            let prev_z = if i > 0 { passes[i - 1] } else { 0.0 };
            for p in &paths {
                let s = p.pts[0];
                if let Some([hx, hy, hr]) = p.helix {
                    // schraubenförmig in neues Material (von der letzten Tiefe aus), unten eine volle Runde
                    let per_rev = mx(0.05, mn(self.step_z, 2.0 * pi * hr * job.helix_tan));
                    let revs = mx(1.0, ((prev_z + 0.5 - z) / per_rev).ceil());
                    let seg = 24.0;
                    self.safe();
                    self.g0([hx + hr, hy]);
                    let half_feed = mx(self.plunge, jsmath::js_round(self.feed_xy / 2.0));
                    let line = format!("G1 Z{} F{} {}\nG1 F{}\n", f3(prev_z + 0.5), js_num(self.plunge), self.c("gc.helix", &[]), js_num(half_feed));
                    self.push(&line);
                    let mut n = 1.0;
                    while n <= (revs + 1.0) * seg {
                        let an = (2.0 * pi * n) / seg;
                        let hz = mx(z, prev_z + 0.5 - ((prev_z + 0.5 - z) * n) / (revs * seg));
                        let line = format!("G1 X{} Y{} Z{}\n", f3(hx + hr * jsmath::cos(an)), f3(hy + hr * jsmath::sin(an)), f3(hz));
                        self.push(&line);
                        n += 1.0;
                    }
                    let line = format!("G1 X{} Y{} F{}\n", f3(s[0]), f3(s[1]), js_num(self.feed_xy));
                    self.push(&line);
                } else {
                    self.safe();
                    self.g0(s);
                    self.plunge_to(&p.pts, p.closed, prev_z, z, f64::INFINITY);
                }
                for q in &p.pts[1..] {
                    self.g1(*q);
                }
                if p.closed {
                    self.g1(s);
                }
            }
        }
        self.safe();
        if allow > 0.0 {
            // Schlichtgang: nur die Endtiefe, an der Wand entlang; eintauchen auf der Schrupp-Bahn (dort ist schon alles frei)
            let line = format!("{}\n", self.c("gc.finish", &[]));
            self.push(&line);
            let z = passes[passes.len() - 1];
            self.passes = vec![z];
            for w in pocket_wall_paths(outer, &islands, self.tool_radius, dir) {
                if w.pts.len() < 2 {
                    continue;
                }
                let start = w.pts[0];
                let entry = nearest_on(&paths, start);
                self.safe();
                self.g0(entry.unwrap_or(start));
                if entry.is_some() {
                    let line = format!("G1 Z{} F{}\nG1 X{} Y{} F{}\n", f3(z), js_num(self.plunge), f3(start[0]), f3(start[1]), js_num(self.feed_xy));
                    self.push(&line);
                } else {
                    self.plunge_to(&w.pts, w.closed, 0.0, z, f64::INFINITY);
                }
                for q in &w.pts[1..] {
                    self.g1(*q);
                }
                if w.closed {
                    self.g1(start);
                }
                self.safe();
            }
        }
    }

    /// Bogen durch Start, Ende und einen Punkt dazwischen (berechne3PunktBogen in arcEngine.ts): ein G2/G3 je Zustellung
    fn mill_arc(&mut self, shape: &Shape) {
        let mode = shape.mode.as_str();
        let (x1, y1, x2, y2, x3, y3) = (shape.x, shape.y, shape.x + shape.w, shape.y + shape.h, shape.mid_x, shape.mid_y);
        let d = 2.0 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
        if d.abs() < 0.1 || d.is_nan() {
            return; // (fast) eine Gerade: cam.ts fräst dann nichts
        }
        let cx = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
        let cy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;
        let r = hypot2(x1 - cx, y1 - cy);
        // Außen/Innen: Fräser um den Radius weg vom Mittelpunkt bzw. zum Mittelpunkt hin (gleicher Mittelpunkt)
        let center = to_machine(cx, cy);
        let r_mm = r / MM_TO_PIXEL;
        let r_new = r_mm + match mode {
            "outside" => self.tool_radius,
            "inside" => -self.tool_radius,
            _ => 0.0,
        };
        if r_new <= 0.05 {
            let line = format!("{}\n", self.c("gc.toolTooBig", &[]));
            self.push(&line);
            return self.too_big();
        }
        let k = r_new / r_mm;
        let radial = |p: P| -> P { [center[0] + (p[0] - center[0]) * k, center[1] + (p[1] - center[1]) * k] };
        let mut start = radial(to_machine(x1, y1));
        let mut end = radial(to_machine(x2, y2));
        // Liegt der Mittelpunkt links der Sehne Start->Ende, läuft der Bogen im Uhrzeigersinn (G2)
        let cross = shape.w * (shape.mid_y - shape.y) - shape.h * (shape.mid_x - shape.x);
        let mut clockwise = cross > 0.0;
        // Fräsrichtung vorgegeben (nur mit Seite außen/innen): Bogen von der anderen Seite fahren
        if (mode == "outside" || mode == "inside") && wants_ccw(mode == "inside", &shape.mill_dir) == Some(clockwise) {
            std::mem::swap(&mut start, &mut end);
            clockwise = !clockwise;
        }
        let (i_val, j_val) = (center[0] - start[0], center[1] - start[1]);
        let cmd = if clockwise { "G2" } else { "G3" };
        for z in self.passes.clone() {
            self.g0(start);
            let line = format!("G1 Z{} F{}\nF{}\n{cmd} X{} Y{} I{} J{}\n", f2(z), js_num(self.plunge), js_num(self.feed_xy), f3(end[0]), f3(end[1]), f3(i_val), f3(j_val));
            self.push(&line);
        }
        self.safe();
    }

    fn mill_polyline(&mut self, shape: &Shape, offset: f64, last: bool) {
        let mode = shape.mode.as_str();
        let mm: Vec<P> = shape.points.iter().map(|p| to_machine(p[0], p[1])).collect();
        // Konturen vor dem Fräsen vereinfachen (nur bei vielen Punkten)
        let pts = if mm.len() < 8 {
            mm
        } else if shape.closed {
            simplify_polygon(&mm, SIMPLIFY_MM)
        } else {
            simplify_polyline(&mm, SIMPLIFY_MM)
        };
        // (eine „Tasche“ kommt hier nur an, wenn die Form keine Fläche hat: dann auf der Linie, ohne Startpunkt von Hand)
        if mode == "pocket" {
            return self.mill_path(&pts, shape.closed);
        }
        if !shape.closed || mode == "on-line" {
            return self.mill_path(&apply_cut(pts, shape.closed, shape), shape.closed);
        }
        // Schlichtgang: erst mit Aufmaß schruppen, danach die Kontur auf Maß
        let mut allow = if last { 0.0 } else { shape.finish_allow };
        let sign = if offset > 0.0 { 1.0 } else if offset < 0.0 { -1.0 } else { 0.0 };
        let mut loops = offset_polygon(&pts, offset + sign * allow, 0.01);
        if allow > 0.0 && loops.is_empty() {
            self.w("gcw.finishSkip", &[("n", self.n.to_string()), ("a", js_num(allow))]);
            allow = 0.0;
            loops = offset_polygon(&pts, offset, 0.01);
        }
        if loops.is_empty() {
            let line = format!("{}\n", self.c("gc.toolTooBig", &[]));
            self.push(&line);
            self.too_big();
        }
        if loops.len() > 1 {
            self.w("gcw.split", &[("n", self.n.to_string()), ("parts", loops.len().to_string())]);
        }
        // Standard: außen gegen den Uhrzeigersinn, innen im Uhrzeigersinn; mit Vorgabe der Form die gewählte Richtung
        let inside = mode == "inside";
        let dir = shape.mill_dir.as_str();
        // Startpunkt und Richtung von Hand gewinnen über Gleich-/Gegenlauf
        let orient = |lp: Vec<P>| -> Vec<P> {
            let lp = if wants_ccw(inside, dir).is_some() {
                orient_loop(lp, inside, dir)
            } else if (mode == "outside") != (polygon_area(&lp) > 0.0) {
                reversed_keep_first(&lp)
            } else {
                lp
            };
            apply_cut_closed(lp, shape)
        };
        let all_passes = self.passes.clone();
        if !last && !loops.is_empty() {
            self.mill_trochoid(shape, &pts, inside, allow, shape.tab.as_ref());
        }
        let rough: Vec<Vec<P>> = loops.into_iter().map(orient).collect();
        for path in &rough {
            if let Some(tab) = shape.tab.as_ref() {
                if self.mill_tabbed(path, shape, tab, None) {
                    continue;
                }
            }
            if let Some(o) = self.cur_lead.clone() {
                let planned = if shape.cut_start.is_some() {
                    plan_lead_at_start(path, inside, &o, &self.lead_free()).map(|plan| (plan, path.clone()))
                } else {
                    plan_lead(path, inside, &o, &self.lead_free())
                };
                if let Some((plan, lp)) = planned {
                    self.mill_path_plan(&lp, &plan);
                    continue;
                }
                self.no_lead();
            }
            self.mill_path(path, true);
        }
        if allow > 0.0 {
            self.finish_start();
            for path in offset_polygon(&pts, offset, 0.01).into_iter().map(orient) {
                let tabbed = match shape.tab.as_ref() {
                    Some(tab) => self.mill_tabbed(&path, shape, tab, Some(&rough)),
                    None => false,
                };
                if !tabbed {
                    self.mill_path_from(&path, true, &loops_as_paths(&rough));
                }
            }
        }
        self.passes = all_passes;
    }

    /// Schlichtgang-Hinweis in den G-Code und nur noch die Endtiefe fräsen
    fn finish_start(&mut self) {
        let line = format!("{}\n", self.c("gc.finish", &[]));
        self.push(&line);
        let z = self.passes[self.passes.len() - 1];
        self.passes = vec![z];
    }

    /// Punktezug fräsen, aber auf den Bahnen `lead` eintauchen und seitlich anfahren (Schlichtgang)
    fn mill_path_from(&mut self, pts: &[P], closed: bool, lead: &[PocketPath]) {
        if pts.len() < 2 {
            return;
        }
        let start = pts[0];
        let entry = nearest_on(lead, start);
        self.safe();
        self.g0(entry.unwrap_or(start));
        let passes = self.passes.clone();
        for (i, &z) in passes.iter().enumerate() {
            if !closed && i > 0 {
                self.safe();
                self.g0(start);
            }
            if entry.is_some() && i == 0 {
                let line = format!("G1 Z{} F{}\nG1 X{} Y{} F{}\n", f3(z), js_num(self.plunge), f3(start[0]), f3(start[1]), js_num(self.feed_xy));
                self.push(&line);
            } else {
                self.plunge_to(pts, closed, if i > 0 { passes[i - 1] } else { self.pass_top }, z, f64::INFINITY);
            }
            for p in &pts[1..] {
                self.g1(*p);
            }
            if closed {
                self.g1(start);
            }
        }
        if let Some(e) = entry {
            if self.cur_lead.as_ref().is_some_and(|l| l.out) {
                self.g1(e);
            }
        }
        self.safe();
    }
}

/// Geschlossene Kontur der Form in mm (Kreis als Vieleck), None = nicht geschlossen (closedInfo in cam.ts)
/// Ist die Form ein Kreis (roundOf in cam.ts)? Echte Kreise – und runde Linienzüge: alle Ecken und Kantenmitten
/// höchstens 1,5 % (mind. 0,05 mm) vom Radius entfernt. Ergebnis in Zeichen-Einheiten (Mitte, Radius)
fn round_of(s: &Shape) -> Option<(f64, f64, f64)> {
    if s.kind == "circle" {
        return Some((s.x, s.y, s.w.abs()));
    }
    let pts = &s.points;
    if s.kind != "polyline" || !s.closed || pts.len() < 12 {
        return None;
    }
    let n = pts.len() as f64;
    let x = pts.iter().fold(0.0, |a, p| a + p[0]) / n;
    let y = pts.iter().fold(0.0, |a, p| a + p[1]) / n;
    let (mut r_max, mut r_min) = (f64::NEG_INFINITY, f64::INFINITY);
    for (i, p) in pts.iter().enumerate() {
        let q = pts[(i + 1) % pts.len()];
        for r in [hypot2(p[0] - x, p[1] - y), hypot2((p[0] + q[0]) / 2.0 - x, (p[1] + q[1]) / 2.0 - y)] {
            r_max = mx(r_max, r);
            r_min = mn(r_min, r);
        }
    }
    if r_max - r_min > mx(0.05 * MM_TO_PIXEL, 0.015 * r_max) {
        return None;
    }
    Some((x, y, pts.iter().fold(0.0, |a, p| a + hypot2(p[0] - x, p[1] - y)) / n))
}

/// ISO-Regelgewinde (metrisch grob): Nenn-Ø → Steigung
const ISO_COARSE: [(f64, f64); 25] = [
    (1.4, 0.3), (1.6, 0.35), (2.0, 0.4), (2.5, 0.45), (3.0, 0.5), (3.5, 0.6), (4.0, 0.7), (5.0, 0.8), (6.0, 1.0), (7.0, 1.0),
    (8.0, 1.25), (10.0, 1.5), (12.0, 1.75), (14.0, 2.0), (16.0, 2.0), (18.0, 2.5), (20.0, 2.5), (22.0, 2.5), (24.0, 3.0), (27.0, 3.0),
    (30.0, 3.5), (33.0, 3.5), (36.0, 4.0), (42.0, 4.5), (48.0, 5.0),
];

struct ThreadParams {
    cx: f64,
    cy: f64,
    /// gezeichneter Kreis-Ø (Kernloch bzw. Bolzen)
    hole_d: f64,
    internal: bool,
    d: f64,
    pitch: f64,
    tool_pitch: f64,
    tool_d: f64,
    length: f64,
    left: bool,
    passes: f64,
    spring: bool,
    feed: f64,
    plunge: f64,
    safe_z: f64,
}

/// Der erste Eintrag mit dem kleinsten Abstand (wie `reduce((a, b) => d(b) < d(a) ? b : a)`)
fn nearest_iso(d: impl Fn((f64, f64)) -> f64) -> (f64, f64) {
    let mut a = ISO_COARSE[0];
    for &b in &ISO_COARSE[1..] {
        if d(b) < d(a) {
            a = b;
        }
    }
    a
}

/// Nenn-Ø und Steigung festlegen (resolveThread in threadMill.ts)
fn resolve_thread(p: &ThreadParams) -> (f64, f64) {
    let mut pitch = if p.pitch > 0.0 {
        p.pitch
    } else if p.tool_pitch > 0.0 {
        p.tool_pitch
    } else {
        0.0
    };
    let mut d = p.d;
    if !(d > 0.0) {
        if pitch > 0.0 {
            d = if p.internal { jsmath::js_round((p.hole_d + pitch) * 2.0) / 2.0 } else { p.hole_d };
        } else {
            d = nearest_iso(|(dd, s)| ((if p.internal { dd - s } else { dd }) - p.hole_d).abs()).0;
        }
    }
    if !(pitch > 0.0) {
        pitch = nearest_iso(|(dd, _)| (dd - d).abs()).1;
    }
    (d, pitch)
}

/// Bahn des Gewindefräsers (threadPath in threadMill.ts): Zeilen, Nenn-Ø, Steigung, das Gewinde.
/// Err = geht nicht, mit dem Grund ("pitch" | "length" | "small" | "toolTooBig" | "toolNoFit")
fn thread_path(p: &ThreadParams) -> Result<(Vec<String>, f64, f64, ThreadInfo), &'static str> {
    let t3 = |v: f64| to_fixed(if v.abs() < 5e-4 { 0.0 } else { v }, 3);
    let (d, pitch) = resolve_thread(p);
    if !(pitch > 0.0) {
        return Err("pitch");
    }
    if !(p.length > 0.0) {
        return Err("length");
    }
    let rt = p.tool_d / 2.0;
    if !(d > pitch) {
        return Err("small");
    }
    let minor = d - 1.22687 * pitch;
    // Bahnradius der Fräsermitte bei voller Tiefe
    let rf = if p.internal { d / 2.0 - rt } else { minor / 2.0 + rt };
    if p.internal && rf < 0.05 {
        return Err("toolTooBig");
    }
    // innen muss der Fräser ins Kernloch passen
    if p.internal && p.tool_d > p.hole_d + 1e-6 {
        return Err("toolNoFit");
    }
    // Radien der Durchgänge: vom ersten Kontakt mit dem Material bis zur vollen Tiefe
    let passes = if p.passes != 0.0 && !p.passes.is_nan() { p.passes } else { 1.0 };
    let n = mx(1.0, mn(10.0, jsmath::js_round(passes)));
    let r0 = if p.internal { mx(0.05, mn(rf, p.hole_d / 2.0 - rt)) } else { mx(rf, p.hole_d / 2.0 + rt) };
    let mut radii: Vec<f64> = (0..n as usize).map(|k| r0 + (rf - r0) * (k as f64 + 1.0) / n).collect();
    if p.spring {
        radii.push(rf);
    }
    let up = p.internal != p.left; // innen rechts / außen links: von unten nach oben
    let arc = if p.internal { "G3" } else { "G2" };
    let q = if p.internal { 0.5 } else { 0.25 }; // Ein-/Ausfahrbogen: halbe bzw. Viertel-Umdrehung
    let dz = if up { pitch } else { -pitch };
    // so viele volle Umdrehungen, dass die Bahn genau bei −Länge beginnt bzw. endet und oben über Z0 reicht
    let turns = mx(1.0, ((if up { p.length - q * pitch } else { p.length - 2.0 * q * pitch }) / pitch - 1e-9).ceil()) as usize;
    let z_start = if up { -p.length } else { -p.length + 2.0 * q * pitch + turns as f64 * pitch };
    let mut l: Vec<String> = vec![format!("G0 Z{}", t3(p.safe_z))];
    let plunge = js_num(jsmath::js_round(p.plunge));
    for (k, &r) in radii.iter().enumerate() {
        let edge = if p.internal { r + rt } else { mx(0.1, r - rt) };
        let feed = js_num(mx(1.0, jsmath::js_round(p.feed * r / edge)));
        let mut z = z_start;
        let rl = mx(1.0, rt); // Bogenradius außen
        if p.internal {
            // Lochmitte: einmal mit Eilgang hinüber, dann im leeren Loch senkrecht auf Starthöhe
            if k == 0 {
                l.push(format!("G0 X{} Y{}", t3(p.cx), t3(p.cy)));
            }
            l.push(format!("G1 Z{} F{plunge}", t3(z)));
            // Halbkreis (Mitte bei R/2) von der Lochmitte tangential auf die Bahn
            z += q * dz;
            l.push(format!("G3 X{} Y{} Z{} I{} J0 F{feed}", t3(p.cx + r), t3(p.cy), t3(z), t3(r / 2.0)));
        } else {
            l.push(format!("G0 Z{}", t3(p.safe_z)));
            l.push(format!("G0 X{} Y{}", t3(p.cx + r + rl), t3(p.cy + rl)));
            l.push(format!("G1 Z{} F{plunge}", t3(z)));
            z += q * dz;
            l.push(format!("G3 X{} Y{} Z{} I0 J{} F{feed}", t3(p.cx + r), t3(p.cy), t3(z), t3(-rl)));
        }
        for _ in 0..turns {
            z += dz;
            l.push(format!("{arc} X{} Y{} Z{} I{} J0", t3(p.cx + r), t3(p.cy), t3(z), t3(-r)));
        }
        z += q * dz;
        if p.internal {
            l.push(format!("G3 X{} Y{} Z{} I{} J0", t3(p.cx), t3(p.cy), t3(z), t3(-r / 2.0)));
        } else {
            l.push(format!("G3 X{} Y{} Z{} I{} J0", t3(p.cx + r + rl), t3(p.cy - rl), t3(z), t3(rl)));
        }
    }
    l.push(format!("G0 Z{}", t3(p.safe_z)));
    let info = ThreadInfo {
        cx: p.cx,
        cy: p.cy,
        d,
        p: pitch,
        internal: p.internal,
        left: p.left,
        length: p.length,
        major_d: if p.internal { d } else { mn(d, p.hole_d) },
        minor_d: if p.internal { mx(p.hole_d, minor) } else { minor },
    };
    Ok((l, d, pitch, info))
}

fn closed_mm(s: &Shape) -> Option<Vec<P>> {
    if s.kind == "circle" {
        return Some(ellipse_points(s.x, s.y, s.w.abs(), s.w.abs()).iter().map(|p| to_machine(p[0], p[1])).collect());
    }
    if s.kind == "polyline" && s.closed && s.points.len() >= 3 {
        let mm: Vec<P> = s.points.iter().map(|p| to_machine(p[0], p[1])).collect();
        return Some(if mm.len() < 8 { mm } else { simplify_polygon(&mm, SIMPLIFY_MM) });
    }
    None
}

/// Inseln = geschlossene Formen direkt in der Tasche (was in einer Insel liegt, zählt nicht extra)
fn islands_of(job: &Job, k: usize, outer: &[P]) -> Vec<Vec<P>> {
    let shape = &job.shapes[k];
    let area = polygon_area(outer).abs();
    let inf = f64::INFINITY;
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (inf, inf, -inf, -inf);
    for q in outer {
        if q[0] < min_x {
            min_x = q[0];
        }
        if q[0] > max_x {
            max_x = q[0];
        }
        if q[1] < min_y {
            min_y = q[1];
        }
        if q[1] > max_y {
            max_y = q[1];
        }
    }
    let mut cand: Vec<(Vec<P>, f64)> = Vec::new();
    for (i, s) in job.shapes.iter().enumerate() {
        // Kopien (weitere Bearbeitungen) sind keine Formen der Zeichnung; Stufenbohrung: das Loch in der Mitte ist keine Insel
        if i == k || s.no_island || s.base.is_some() || (shape.cbore.is_some() && shape.base == Some(i)) {
            continue;
        }
        // Insel nur für bestimmte Taschen
        if s.island_for.as_ref().is_some_and(|ids| !ids.contains(&shape.id)) {
            continue;
        }
        let Some(pts) = closed_mm(s) else { continue };
        // Punkt außerhalb des umgebenden Rechtecks -> kann nicht drin liegen
        let q = pts[0];
        if q[0] < min_x || q[0] > max_x || q[1] < min_y || q[1] > max_y {
            continue;
        }
        let a = polygon_area(&pts).abs();
        if a < area && point_in_poly(q[0], q[1], outer) {
            cand.push((pts, a));
        }
    }
    (0..cand.len())
        .filter(|&c| !(0..cand.len()).any(|o| o != c && cand[o].1 > cand[c].1 && point_in_poly(cand[c].0[0][0], cand[c].0[0][1], &cand[o].0)))
        .map(|c| cand[c].0.clone())
        .collect()
}

/// geschlossene Bahnen als Liste für nearest_on
fn loops_as_paths(loops: &[Vec<P>]) -> Vec<PocketPath> {
    loops.iter().map(|l| PocketPath { pts: l.clone(), closed: true, helix: None }).collect()
}

/// nächster Punkt auf den Bahnen (Eintauchstelle für den Schlichtgang)
fn nearest_on(paths: &[PocketPath], p: P) -> Option<P> {
    let (mut best, mut bd) = (None, f64::INFINITY);
    for path in paths {
        let n = path.pts.len();
        if n == 0 {
            continue;
        }
        for i in 0..(if path.closed { n } else { n - 1 }) {
            let (a, b) = (path.pts[i], path.pts[(i + 1) % n]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let l2 = dx * dx + dy * dy;
            let f = if l2 > 1e-12 { mx(0.0, mn(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) } else { 0.0 };
            let q = [a[0] + dx * f, a[1] + dy * f];
            let d = hypot2(q[0] - p[0], q[1] - p[1]);
            if d < bd {
                bd = d;
                best = Some(q);
            }
        }
    }
    best
}

/// Formen über ihre Eintragsnummer (siehe order)
struct Entries<'a>(&'a [Shape]);
impl std::ops::Index<usize> for Entries<'_> {
    type Output = Shape;
    fn index(&self, e: usize) -> &Shape {
        &self.0[e % self.0.len()]
    }
}

/// Reihenfolge der Formen eines Werkzeugs: innen vor außen, und innerhalb einer Art kurze Leerfahrten (cutOrder).
/// `idx` = Nummern der Formen dieses Werkzeugs, `from` = wo der Fräser vorher steht (wird weitergetragen)
/// Einträge ab shapes.len() sind die Restbearbeitung der Form (Eintrag − shapes.len()): Lage und Art der Original-Form
fn order(all: &[Shape], mut idx: Vec<usize>, from: &mut P) -> Vec<usize> {
    let shapes = Entries(all);
    let priority = |mode: &str| match mode {
        "face" => -2.0,
        "drill" => -1.0,
        "inside" => 0.0,
        "pocket" => 1.0,
        "vcarve" | "vplug" => 1.5,
        "on-line" => 2.0,
        "chamfer" => 2.5,
        _ => 3.0,
    };
    idx.sort_by(|&a, &b| priority(&shapes[a].mode).partial_cmp(&priority(&shapes[b].mode)).unwrap());
    let mut out: Vec<usize> = Vec::with_capacity(idx.len());
    let mut i = 0;
    while i < idx.len() {
        let mut j = i;
        while j < idx.len() && priority(&shapes[idx[j]].mode) == priority(&shapes[idx[i]].mode) {
            j += 1;
        }
        let run = &idx[i..j];
        let items: Vec<cutorder::Item> = run
            .iter()
            .map(|&k| {
                let sh = &shapes[k];
                // Rahmen der Form (shapeBounds); beim Bogen liefert ihn der Auftrag
                let (min_x, max_x, min_y, max_y) = match (sh.kind.as_str(), sh.bounds) {
                    (_, Some(b)) => (b[0], b[2], b[1], b[3]),
                    ("circle", _) => (sh.x - sh.w.abs(), sh.x + sh.w.abs(), sh.y - sh.w.abs(), sh.y + sh.w.abs()),
                    ("polyline", _) => (sh.x, sh.x + sh.w, sh.y, sh.y + sh.h),
                    _ => (mn(sh.x, sh.x + sh.w), mx(sh.x, sh.x + sh.w), mn(sh.y, sh.y + sh.h), mx(sh.y, sh.y + sh.h)),
                };
                let ring: Option<Vec<P>> = if sh.kind == "circle" {
                    Some(ellipse_points(sh.x, sh.y, sh.w.abs(), sh.w.abs()))
                } else if sh.kind == "polyline" && sh.closed && sh.points.len() >= 3 {
                    Some(sh.points.clone())
                } else {
                    None
                };
                let mid = to_machine((min_x + max_x) / 2.0, (min_y + max_y) / 2.0);
                let closed = ring.is_some();
                let pts = ring.map_or(vec![mid], |r| r.iter().map(|q| to_machine(q[0], q[1])).collect());
                cutorder::Item { entry: mid, exit: mid, pts, closed, free_start: false, reversible: false }
            })
            .collect();
        let before = out.len();
        if run.len() > 1 {
            for st in cutorder::optimize(&items, *from, cutorder::DEFAULT_TIME_MS) {
                out.push(run[st.index]);
            }
        } else {
            out.extend_from_slice(run);
        }
        if out.len() > before {
            let last = out[out.len() - 1];
            if let Some(pos) = run.iter().position(|&k| k == last) {
                *from = items[pos].exit;
            }
        }
        i = j;
    }
    out
}

/// Formen nach Werkzeug aufteilen und die Werkzeuge ordnen (orderToolGroups in cam.ts): Werkzeuge, die Teile
/// ausschneiden (außen), zuletzt; sonst kleineres Werkzeug zuerst, dann die Reihenfolge in der Bibliothek
fn tool_groups(job: &Job) -> Vec<(Option<usize>, Vec<usize>)> {
    let mut groups: Vec<(Option<usize>, Vec<usize>)> = Vec::new();
    for (k, s) in job.shapes.iter().enumerate() {
        match groups.iter_mut().find(|g| g.0 == s.tool) {
            Some(g) => g.1.push(k),
            None => groups.push((s.tool, vec![k])),
        }
    }
    // Gewinde immer zum Schluss: das Kern-Loch bzw. der Bolzen muss vorher fertig sein
    let threads = |g: &(Option<usize>, Vec<usize>)| g.1.iter().any(|&k| job.shapes[k].mode == "thread") as i32 as f64;
    let cuts_out = |g: &(Option<usize>, Vec<usize>)| g.1.iter().any(|&k| job.shapes[k].mode == "outside") as i32 as f64;
    let dia = |g: &(Option<usize>, Vec<usize>)| g.0.map_or(0.0, |t| job.tools[t].raw_diameter);
    let lib = |g: &(Option<usize>, Vec<usize>)| g.0.map_or(-1.0, |t| job.tools[t].lib_index);
    groups.sort_by(|a, b| {
        for d in [threads(a) - threads(b), cuts_out(a) - cuts_out(b), dia(a) - dia(b), lib(a) - lib(b)] {
            if d < 0.0 {
                return std::cmp::Ordering::Less;
            }
            if d > 0.0 {
                return std::cmp::Ordering::Greater;
            }
        }
        std::cmp::Ordering::Equal
    });
    // RESTMATERIAL (withRestGroups in cam.ts): Formen mit Rest-Werkzeug bekommen nach ihrem Werkzeug einen zweiten Durchgang
    // mit dem kleineren. Schneidet eine Gruppe auch Teile aus, wird sie geteilt: erst innen, dann Restmaterial, dann ausschneiden
    let n = job.shapes.len();
    let mut out: Vec<(Option<usize>, Vec<usize>)> = Vec::new();
    let mut push = |tool: Option<usize>, list: Vec<usize>| {
        if list.is_empty() {
            return;
        }
        match out.last_mut() {
            Some(last) if last.0 == tool => last.1.extend(list),
            _ => out.push((tool, list)),
        }
    };
    for grp in groups {
        let mut rests: Vec<(usize, Vec<usize>)> = Vec::new();
        for &k in &grp.1 {
            if let Some(r) = job.shapes[k].rest_tool {
                match rests.iter_mut().find(|x| x.0 == r) {
                    Some(x) => x.1.push(k + n),
                    None => rests.push((r, vec![k + n])),
                }
            }
        }
        if rests.is_empty() {
            push(grp.0, grp.1);
            continue;
        }
        let (outer, inner): (Vec<usize>, Vec<usize>) = grp.1.iter().partition(|&&k| job.shapes[k].mode == "outside");
        push(grp.0, inner);
        // größeres Restwerkzeug zuerst
        rests.sort_by(|a, b| job.tools[b.0].raw_diameter.partial_cmp(&job.tools[a.0].raw_diameter).unwrap_or(std::cmp::Ordering::Equal));
        for (tool, list) in rests {
            push(Some(tool), list);
        }
        push(grp.0, outer);
    }
    out
}

/// G-Code für den Auftrag. Err = der Auftrag passt nicht zu dieser Datei
#[cfg(test)]
pub fn generate(job: &Job) -> Result<String, String> {
    generate_full(job).map(|o| o.gcode)
}

/// Wie `generate`, dazu die Hinweise, die Gewinde und das Werkzeug je Abschnitt (alles, was cam.ts liefert)
pub fn generate_full(job: &Job) -> Result<Output, String> {
    if job.version != JOB_VERSION {
        return Err(format!("job version {} (this build understands {})", job.version, JOB_VERSION));
    }
    if job.shapes.is_empty() {
        return Err("no shapes".into());
    }
    for s in &job.shapes {
        if !matches!(s.kind.as_str(), "polyline" | "circle" | "line" | "arc") || !matches!(s.mode.as_str(), "outside" | "inside" | "on-line" | "pocket" | "drill" | "face" | "chamfer" | "thread" | "cbore" | "vcarve" | "vplug") {
            return Err(format!("shape {} / {} is not in this stage", s.kind, s.mode));
        }
        if s.tool.is_some_and(|t| t >= job.tools.len()) {
            return Err("shape names a tool that is not in the job".into());
        }
    }
    let mut g = Gen { job, out: String::new(), tool_radius: 1.5, step_z: 1.5, feed_xy: 800.0, rpm: 12000.0, plunge: 300.0, ramp_tan: 0.0, passes: vec![], cur_lead: None, cur_shape: 0, reamer: false, tool: None, converted: false, pass_top: 0.0, skin_depth: None, warns: vec![], threads: vec![], sections: vec![], n: 0, skin_ignored: 0 };

    // ---- Kopf ----
    let head = format!("G21 {}\nG90 {}\nG0 Z{} {}\n", g.c("gc.unitMm", &[]), g.c("gc.absolute", &[]), f2(SAFE_Z), g.c("gc.safeZ", &[]));
    g.push(&head);
    let groups = tool_groups(job);
    if job.rest_ignored > 0 {
        g.w("gcw.restIgnored", &[("n", job.rest_ignored.to_string())]);
    }
    let name_of = |t: Option<usize>| t.map_or("Standard".to_string(), |t| job.tools[t].name.clone());
    if groups.len() > 1 {
        let line = format!("{}\n", g.c("gc.toolList", &[("n", groups.len().to_string())]));
        g.push(&line);
        for (i, grp) in groups.iter().enumerate() {
            let d = to_fixed(grp.0.map_or(3.0, |t| job.tools[t].raw_diameter), 1);
            let line = format!("{}\n", g.c("gc.toolListItem", &[("i", (i + 1).to_string()), ("name", name_of(grp.0)), ("d", d)]));
            g.push(&line);
        }
    }

    let mut form_counter = 0usize;
    let mut skin_jobs: Vec<SkinJob> = Vec::new();
    let mut chained: HashSet<String> = HashSet::new();
    let mut order_from: P = [0.0, 0.0];
    // Reihenfolge der Formen je Werkzeug zuerst für alle Werkzeuge (der Startpunkt wird von Werkzeug zu Werkzeug weitergetragen)
    let ordered: Vec<Vec<usize>> = groups.iter().map(|grp| order(&job.shapes, grp.1.clone(), &mut order_from)).collect();

    for (gi, grp) in groups.iter().enumerate() {
        g.start_tool(grp.0, gi, gi > 0);

        // Werte des Werkzeugs (ohne Material-Profil gelten sie)
        let (tool_feed, tool_rpm, tool_step, tool_plunge) = (g.feed_xy, g.rpm, g.step_z, g.plunge);
        let mut last_cut_key = String::new();

        // V-Carve: Formen, die schon zusammen mit einer anderen gefräst wurden
        let mut v_done: HashSet<usize> = HashSet::new();
        let cut_key = |sh: &Shape| sh.cut.as_ref().map_or(String::new(), |r| format!("{}|{}|{}|{}", js_num(r.feedrate), js_num(r.rpm), js_num(r.step_z), js_num(r.plunge_feed)));
        for &k in &ordered[gi] {
            // Vorschub in engen Kurven und Innenecken senken: den G-Code dieser Form für sich erzeugen, anpassen, anhängen.
            // Nur bei Fräsern mit Schneide am Umfang – nicht Bohren, V-Carve, Fase, Planfräsen, adaptive Tasche,
            // Trochoidal, Flöte (adaptsFeed in cam.ts)
            // sichere Stelle (Fräser oben) – hier darf später zum Nachmessen angehalten werden
            if job.drift.is_some() {
                g.push(DRIFT_SLOT);
                g.push("\n");
            }
            let mark = g.out.len();
            let adapts = job.feed_adapt.is_some() && !g.tool.is_some_and(|t| t.no_tro) && (k >= job.shapes.len() || {
                let sh = &job.shapes[k];
                sh.tro.is_none() && sh.flute.is_none() && !matches!(sh.mode.as_str(), "drill" | "vcarve" | "vplug" | "chamfer" | "face") && !(sh.mode == "pocket" && job.pocket_strategy == "adaptive")
            });
            'shape: {
            // Startpunkt/Richtung von Hand, die hier nicht wirken oder über Gleich-/Gegenlauf gewinnen (cutReady in cam.ts)
            if k < job.shapes.len() {
                match job.shapes[k].cut_warn.as_str() {
                    "ignored" => g.w("cut.ignored", &[("n", (form_counter + 1).to_string())]),
                    "millDir" => g.w("cut.millDir", &[("n", (form_counter + 1).to_string())]),
                    _ => {}
                }
            }
            if v_done.contains(&k) {
                break 'shape;
            }
            // ---- Restmaterial einer Form: Werte des Werkzeugs (kein Material-Profil), dann nur die Stellen, die fehlen ----
            if k >= job.shapes.len() {
                let k = k - job.shapes.len();
                g.step_z = tool_step;
                g.plunge = tool_plunge;
                last_cut_key = String::new();
                if tool_rpm != g.rpm {
                    let line = format!("G0 Z{}\n{} S{} {}\nG4 P2 {}\n", f2(SAFE_Z), job.spindle, js_num(tool_rpm), g.c("gc.spindleOn", &[("rpm", js_num(tool_rpm))]), g.c("gc.spinUp", &[]));
                    g.push(&line);
                    g.rpm = tool_rpm;
                }
                if tool_feed != g.feed_xy {
                    let line = format!("F{} {}\n", js_num(tool_feed), g.c("gc.feed", &[("f", js_num(tool_feed))]));
                    g.push(&line);
                    g.feed_xy = tool_feed;
                }
                form_counter += 1;
                g.n = form_counter;
                g.cur_lead = None;
                g.skin_depth = None;
                g.converted = false;
                g.cur_shape = k;
                g.passes = depth_passes(job.shapes[k].depth, g.step_z);
                // Form mit Zwiebelhaut: auch der kleine Fräser hört auf der Haut auf (Hinweise kamen schon bei der Form selbst)
                let rest = &job.shapes[k];
                let rest_skin = match &rest.skin {
                    Some(set) => match skin_plan(rest.depth, g.step_z, set, rest.stock_under) {
                        Skin::Plan(plan) => Some((plan, set.clone())),
                        Skin::TooThick => break 'shape,
                        Skin::NotThrough => None,
                    },
                    None => None,
                };
                if let Some((plan, _)) = &rest_skin {
                    g.passes = plan.passes.clone();
                    g.skin_depth = Some(plan.through);
                }
                let line = format!("\n{}\n", g.c("gc.rest", &[("n", form_counter.to_string())]));
                g.push(&line);
                g.mill_rest(k);
                if let Some((plan, set)) = rest_skin {
                    if !plan.last.is_empty() {
                        skin_jobs.push(SkinJob {
                            rank: if rest.mode == "inside" { 0 } else { 1 },
                            plan,
                            set,
                            shape: rest.clone(),
                            k,
                            gi,
                            n: form_counter,
                            tool: grp.0,
                            dia: g.tool_radius * 2.0,
                            step_z: g.step_z,
                            feed: g.feed_xy,
                            rpm: g.rpm,
                            plunge: g.plunge,
                            ramp_tan: g.ramp_tan,
                            lead: None,
                            rest: true,
                        });
                    }
                }
                break 'shape;
            }
            // Startpunkt/Richtung von Hand an Kreis, Bogen, Linie: als Linienzug fräsen (cutReady in cam.ts)
            let derived: Shape;
            let shape = match &job.shapes[k].cut_points {
                Some(cp) => {
                    derived = Shape { kind: "polyline".into(), points: cp.pts.iter().map(|p| [p[0], p[1]]).collect(), closed: cp.closed, converted: true, ..job.shapes[k].clone() };
                    &derived
                }
                None => &job.shapes[k],
            };
            g.converted = shape.converted;
            if let Some(id) = shape.parent_chain_id.as_ref().filter(|id| !id.is_empty()) {
                if !chained.insert(id.clone()) {
                    break 'shape;
                }
            }
            // ---- Schnittwerte der Form (Material-Profil) ----
            // für ein anderes Werkzeug angewendet: Werkzeug-Werte nehmen und sagen
            if let Some(label) = &shape.cut_off {
                g.w_once("gcw.cutDataOff", &[("name", label.clone())]);
            }
            let r = shape.cut.as_ref();
            let f = r.map_or(tool_feed, |r| r.feedrate);
            let s = r.map_or(tool_rpm, |r| r.rpm);
            g.step_z = r.map_or(tool_step, |r| r.step_z);
            g.plunge = r.map_or(tool_plunge, |r| r.plunge_feed);
            let key = r.map_or(String::new(), |r| format!("{}|{}|{}|{}", js_num(r.feedrate), js_num(r.rpm), js_num(r.step_z), js_num(r.plunge_feed)));
            if let Some(r) = r {
                if key != last_cut_key {
                    let line = format!("\n{}\n", g.c("gc.cutData", &[("name", r.label.clone()), ("f", js_num(f)), ("s", js_num(s)), ("z", js_num(g.step_z))]));
                    g.push(&line);
                }
            }
            last_cut_key = key;
            if s != g.rpm {
                // Drehzahl nur über dem Material ändern, dann kurz hochlaufen lassen
                let line = format!("G0 Z{}\n{} S{} {}\nG4 P2 {}\n", f2(SAFE_Z), job.spindle, js_num(s), g.c("gc.spindleOn", &[("rpm", js_num(s))]), g.c("gc.spinUp", &[]));
                g.push(&line);
                g.rpm = s;
            }
            if f != g.feed_xy {
                let line = format!("F{} {}\n", js_num(f), g.c("gc.feed", &[("f", js_num(f))]));
                g.push(&line);
                g.feed_xy = f;
            }

            form_counter += 1;
            g.n = form_counter;
            g.passes = depth_passes(shape.depth, g.step_z);
            let mode = shape.mode.as_str();
            if shape.skin_ignored {
                g.skin_ignored += 1;
            }
            // Zwiebelhaut: geschlossene Konturen außen/innen hören über dem Boden auf. Haut so dick wie die Frästiefe:
            // nichts zu fräsen – die Form bleibt ganz
            g.skin_depth = None;
            let skin = match &shape.skin {
                Some(set) => match skin_plan(shape.depth, g.step_z, set, shape.stock_under) {
                    Skin::Plan(plan) => {
                        if set.h > mx(0.05, g.step_z.abs()) + 1e-9 {
                            g.w("gcw.skinThick", &[("n", form_counter.to_string()), ("h", js_num(set.h)), ("z", js_num(g.step_z))]);
                        }
                        Some((plan, set.clone()))
                    }
                    Skin::TooThick => {
                        g.w("gcw.skinTooThick", &[("n", form_counter.to_string()), ("h", js_num(set.h)), ("d", js_num(shape.depth.abs()))]);
                        break 'shape;
                    }
                    // zweiseitig: der Schnitt reicht nicht bis zur Unterseite – fräsen wie immer und sagen
                    Skin::NotThrough => {
                        let under: f64 = to_fixed(shape.stock_under.unwrap_or(0.0), 2).parse().unwrap_or(0.0);
                        g.w("gcw.skinNotThrough", &[("n", form_counter.to_string()), ("d", js_num(shape.depth.abs())), ("t", js_num(under))]);
                        None
                    }
                },
                None => None,
            };
            if let Some((plan, _)) = &skin {
                g.passes = plan.passes.clone();
                g.skin_depth = Some(plan.through);
            }
            g.cur_shape = k;
            // An-/Wegfahren nur an geschlossenen Konturen mit Seite (Kreis und geschlossener Linienzug)
            let sided_closed = (mode == "outside" || mode == "inside") && (shape.kind == "circle" || (shape.kind == "polyline" && shape.closed));
            g.cur_lead = if sided_closed { shape.lead.clone() } else { None };
            let offset = match mode {
                "outside" => g.tool_radius,
                "inside" => -g.tool_radius,
                _ => 0.0,
            };
            if let Some([d, hole]) = shape.cbore {
                // an anderen Formen als Kreisen geht keine Stufenbohrung; die Senkung muss größer sein als das Loch
                if mode == "cbore" {
                    g.wn("gcw.cboreShape");
                    break 'shape;
                }
                if d <= hole + 0.01 {
                    g.w("gcw.cboreSmall", &[("n", form_counter.to_string()), ("d", js_num(d)), ("h", to_fixed(hole, 2))]);
                    break 'shape;
                }
            }
            if mode == "vcarve" || mode == "vplug" {
                let same: Vec<usize> = ordered[gi]
                    .iter()
                    .copied()
                    .filter(|&o| o < job.shapes.len())
                    .filter(|&o| {
                        let sh = &job.shapes[o];
                        sh.mode == mode && sh.depth == shape.depth && cut_key(sh) == cut_key(shape) && (mode != "vplug" || sh.v_start == shape.v_start)
                    })
                    .collect();
                v_done.extend(same.iter().copied());
                let line = format!("\n{}\n", g.c(if mode == "vplug" { "gc.vplug" } else { "gc.vcarve" }, &[("n", form_counter.to_string()), ("k", same.len().to_string())]));
                g.push(&line);
                g.mill_vcarve(&same, mode == "vplug", shape.depth, shape.v_start);
                break 'shape;
            }
            if mode == "chamfer" {
                let w = if shape.chamfer_w != 0.0 { shape.chamfer_w } else { 1.0 };
                let line = format!("\n{}\n", g.c("gc.chamfer", &[("n", form_counter.to_string()), ("w", js_num(w))]));
                g.push(&line);
                g.mill_chamfer(shape);
                break 'shape;
            }
            if mode == "thread" {
                g.mill_thread(shape, form_counter);
                break 'shape;
            }
            if mode == "face" || mode == "drill" {
                let line = match (&shape.pin_mark, mode) {
                    (Some(pin), "drill") => format!("\n{pin}\n"),
                    _ => format!("\n{}\n", g.c(if mode == "face" { "gc.face" } else { "gc.drill" }, &[("n", form_counter.to_string())])),
                };
                g.push(&line);
                if mode == "face" {
                    g.mill_face(shape);
                } else {
                    g.mill_drill(shape);
                }
                break 'shape;
            }
            // V-Stichel, Bohrer und Senker taugen nicht für Konturen mit Fräser-Versatz/Taschen
            if mode != "on-line" {
                if let Some((t, ty)) = g.tool.and_then(|t| t.type_text.as_ref().map(|ty| (t, ty))) {
                    g.w_once("gcw.toolType", &[("name", t.raw_name.clone()), ("type", ty.clone())]);
                }
            }
            let line = match &shape.pin_mark {
                Some(pin) => format!("\n{pin}\n"),
                None => format!("\n{}\n", g.c("gc.shape", &[("n", form_counter.to_string()), ("type", shape.kind.to_uppercase()), ("mode", mode.to_string())])),
            };
            g.push(&line);
            // die Simulation und das Einrichteblatt lesen aus diesem Hinweis die Materialdicke
            if let Some((plan, _)) = &skin {
                let line = format!("{}\n", g.c("gc.skin", &[("h", f2(plan.skin)), ("t", f2(plan.stock))]));
                g.push(&line);
            }
            // Tasche an einer Form ohne Fläche (offene Linie, Bogen): cam.ts fräst dann auf der Linie – weiter unten
            if let Some(outer) = closed_mm(shape).filter(|_| mode == "pocket") {
                g.mill_pocket(k, &outer);
                break 'shape;
            }
            if let Some(o) = shape.flute.as_ref().filter(|_| g.passes[g.passes.len() - 1] < 0.0) {
                g.mill_flute(shape, o);
                break 'shape;
            }
            match shape.kind.as_str() {
                "line" => g.mill_line(shape),
                "circle" => g.mill_circle(shape, offset, false),
                "arc" => g.mill_arc(shape),
                _ => g.mill_polyline(shape, offset, false),
            }
            // den letzten Gang durch die Haut für das Ende des Programms vormerken (nur „am Ende durchfräsen“)
            if let Some((plan, set)) = skin {
                if !plan.last.is_empty() && (shape.kind == "circle" || shape.kind == "polyline") {
                    skin_jobs.push(SkinJob {
                        rank: if mode == "inside" { 0 } else { 1 },
                        plan,
                        set,
                        shape: shape.clone(),
                        k,
                        gi,
                        n: form_counter,
                        tool: grp.0,
                        dia: g.tool_radius * 2.0,
                        step_z: g.step_z,
                        feed: g.feed_xy,
                        rpm: g.rpm,
                        plunge: g.plunge,
                        ramp_tan: g.ramp_tan,
                        lead: g.cur_lead.clone(),
                        rest: false,
                    });
                }
            }
            }
            if adapts {
                let own = g.out.split_off(mark);
                let adapted = crate::feedadapt::adapt_feed(&own, g.tool_radius, job.feed_adapt.unwrap_or(100.0));
                g.push(&adapted);
            }
        }
    }

    // ---- Zwiebelhaut durchfräsen: ganz am Ende, zuerst der Abfall in den Löchern (innen), dann die Teile (außen) ----
    if !skin_jobs.is_empty() {
        // innerhalb „innen“ und „außen“ zuerst das Werkzeug, das gerade eingesetzt ist (spart Werkzeugwechsel)
        let mut cur_tool: Option<usize> = groups.last().and_then(|grp| grp.0);
        let mut in_use = cur_tool;
        let mut order: Vec<usize> = Vec::new();
        for rank in [0u8, 1] {
            let mut rest: Vec<usize> = (0..skin_jobs.len()).filter(|&i| skin_jobs[i].rank == rank).collect();
            while !rest.is_empty() {
                let next = if rest.iter().any(|&i| skin_jobs[i].tool == in_use) { in_use } else { skin_jobs[rest[0]].tool };
                order.extend(rest.iter().copied().filter(|&i| skin_jobs[i].tool == next));
                in_use = next;
                rest.retain(|&i| skin_jobs[i].tool != next);
            }
        }
        if job.drift.is_some() {
            g.push(DRIFT_SLOT);
            g.push("\n");
        }
        let line = format!("\n{}\n", g.c("gc.skinCutAll", &[]));
        g.push(&line);
        for i in order {
            let j = &skin_jobs[i];
            // anderes Werkzeug als gerade eingesetzt: noch einmal wechseln
            if j.tool != cur_tool {
                g.start_tool(j.tool, j.gi, true);
                cur_tool = j.tool;
            }
            g.tool_radius = j.dia / 2.0;
            g.step_z = j.step_z;
            g.ramp_tan = j.ramp_tan;
            if j.rpm != g.rpm {
                let line = format!("G0 Z{}\n{} S{} {}\nG4 P2 {}\n", f2(SAFE_Z), job.spindle, js_num(j.rpm), g.c("gc.spindleOn", &[("rpm", js_num(j.rpm))]), g.c("gc.spinUp", &[]));
                g.push(&line);
                g.rpm = j.rpm;
            }
            let f = skin_feed(&j.set, j.feed);
            g.feed_xy = f;
            g.plunge = mn(j.plunge, f);
            let line = format!("\n{}\nG0 Z{}\nF{} {}\n", g.c("gc.skinCut", &[("n", j.n.to_string())]), f2(SAFE_Z), js_num(f), g.c("gc.feed", &[("f", js_num(f))]));
            g.push(&line);
            g.passes = j.plan.last.clone();
            g.pass_top = j.plan.floor;
            g.skin_depth = Some(j.plan.through);
            g.cur_lead = j.lead.clone();
            g.cur_shape = j.k;
            g.converted = j.shape.converted;
            g.n = j.n;
            // Hinweise, die schon beim Fräsen der Form kamen (Stege passen nicht, kein Platz zum Anfahren …), nicht doppelt
            let known = g.warns.len();
            let offset = if j.shape.mode == "inside" { -g.tool_radius } else { g.tool_radius };
            if j.rest {
                g.converted = false;
                g.mill_rest(j.k);
            } else if j.shape.kind == "circle" {
                g.mill_circle(&j.shape, offset, true);
            } else {
                g.mill_polyline(&j.shape, offset, true);
            }
            let old: Vec<String> = g.warns[..known].iter().map(|w| w.text.clone()).collect();
            let mut i = 0;
            g.warns.retain(|w| {
                i += 1;
                i <= known || !old.contains(&w.text)
            });
            g.pass_top = 0.0;
            g.skin_depth = None;
        }
    }

    // ---- Programmende ----
    let foot = format!("\nG0 Z{}\nM5 {}\nG0 X0 Y0 {}\nM30 {}\n", f2(SAFE_Z), g.c("gc.spindleOff", &[]), g.c("gc.park", &[]), g.c("gc.end", &[]));
    g.push(&foot);
    if g.skin_ignored > 0 {
        g.w("gcw.skinIgnored", &[("n", g.skin_ignored.to_string())]);
    }
    // ---- Nachmessen: Mess-Punkte nach geschätzter Laufzeit ----
    if let Some(d) = &job.drift {
        g.out = place_drift_points(&g.out, d);
        if d.no_spot {
            g.w("gcw.driftNoSpot", &[]);
        }
    }
    // Bilder neben den Formen (Bildgravur gibt es nur beim Laser): der Hinweis steht ganz vorn
    if job.images > 0 {
        let w = g.warn_of("img.onlyLaser", &[("n", job.images.to_string())]);
        g.warns.insert(0, w);
    }
    Ok(Output { gcode: g.out, warnings: g.warns, threads: g.threads, section_tools: g.sections })
}

/// Zwei Zeilen sind „fast gleich“, wenn nur Zahlen um höchstens ein Tausendstel abweichen (X12.345 / X12.346).
/// Das kommt vor, wo die letzte Stelle von Sinus/Kosinus genau an einer Rundungsgrenze entscheidet (siehe jsmath.rs).
fn nearly_same(a: &str, b: &str) -> bool {
    let (mut x, mut y) = (a.split(' '), b.split(' '));
    loop {
        match (x.next(), y.next()) {
            (None, None) => return true,
            (Some(p), Some(q)) if p == q => continue,
            (Some(p), Some(q)) => {
                // gleicher Buchstabe, Zahl dahinter höchstens 0,001 anders
                let (Some(lp), Some(lq)) = (p.chars().next(), q.chars().next()) else { return false };
                if lp != lq || !lp.is_ascii_alphabetic() {
                    return false;
                }
                match (p[1..].parse::<f64>(), q[1..].parse::<f64>()) {
                    (Ok(u), Ok(v)) if (u - v).abs() <= 0.0011 => continue,
                    _ => return false,
                }
            }
            _ => return false,
        }
    }
}

/// Ergebnis des Vergleichs mit dem G-Code aus cam.ts
#[derive(Debug, PartialEq)]
pub struct Diff {
    /// Zeilen, die sich nur um ein Tausendstel in einer Zahl unterscheiden
    pub near: usize,
    /// erste wirklich andere Zeile: (Zeilennummer ab 1, Zeile hier, Zeile dort)
    pub first: Option<(usize, String, String)>,
}

/// Vergleich mit dem G-Code aus cam.ts, Zeile für Zeile
pub fn compare(mine: &str, theirs: &str) -> Diff {
    let (mut a, mut b) = (mine.split('\n'), theirs.split('\n'));
    let (mut n, mut near) = (0, 0);
    loop {
        n += 1;
        match (a.next(), b.next()) {
            (None, None) => return Diff { near, first: None },
            (x, y) if x == y => continue,
            (Some(x), Some(y)) if nearly_same(x, y) => {
                if std::env::var("MILLGCODE_SHOW_NEAR").is_ok() {
                    eprintln!("near line {n}: {x} | {y}");
                }
                near += 1
            }
            (x, y) => return Diff { near, first: Some((n, x.unwrap_or("<end>").to_string(), y.unwrap_or("<end>").to_string())) },
        }
    }
}

/// Gleiche JSON-Werte? Zahlen zählen als Zahl (8 und 8.0 sind gleich)
fn same_json(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    use serde_json::Value::*;
    match (a, b) {
        (Number(x), Number(y)) => x.as_f64() == y.as_f64(),
        (Array(x), Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same_json(p, q)),
        (Object(x), Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same_json(v, w))),
        _ => a == b,
    }
}

/// Hinweise, Gewinde und Werkzeug je Abschnitt mit denen aus cam.ts vergleichen.
/// `side` = { warnings: [Text, …] | null, threads: […], sectionTools: [Nummer | null, …] }; None = alles gleich
pub fn compare_side(out: &Output, side: &serde_json::Value) -> Option<String> {
    if let Some(want) = side["warnings"].as_array() {
        let want: Vec<&str> = want.iter().map(|w| w.as_str().unwrap_or("")).collect();
        let got: Vec<&str> = out.warnings.iter().map(|w| w.text.as_str()).collect();
        if got != want {
            let i = (0..got.len().max(want.len())).find(|&i| got.get(i) != want.get(i)).unwrap_or(0);
            return Some(format!("warning {} of {} / {}: Rust {:?}, cam.ts {:?}", i + 1, got.len(), want.len(), got.get(i).unwrap_or(&"(none)"), want.get(i).unwrap_or(&"(none)")));
        }
    }
    let threads = serde_json::to_value(&out.threads).unwrap_or_default();
    if !same_json(&threads, &side["threads"]) {
        return Some(format!("threads: Rust {threads}, cam.ts {}", side["threads"]));
    }
    let sections = serde_json::to_value(&out.section_tools).unwrap_or_default();
    if !same_json(&sections, &side["sectionTools"]) {
        return Some(format!("tools per section: Rust {sections}, cam.ts {}", side["sectionTools"]));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn texts() -> HashMap<String, String> {
        [
            ("gc.unitMm", "unit mm"), ("gc.absolute", "absolute"), ("gc.safeZ", "safe height"), ("gc.tool", "Tool: {name}, diameter {d} mm"),
            ("gc.spindleOn", "spindle on, {rpm} rpm"), ("gc.feed", "feed {f} mm/min"), ("gc.shape", "--- shape {n}: {type} {mode} ---"),
            ("gc.tab", "tab"), ("gc.ramp", "ramp"), ("gc.spindleOff", "spindle off"), ("gc.park", "park"), ("gc.end", "end"),
            ("gc.circleTooSmall", "circle too small"), ("gc.toolTooBig", "tool too big"), ("gc.cutData", "profile {name}: F{f} S{s} Z{z}"), ("gc.spinUp", "spin up"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }
    fn tool() -> Tool {
        Tool { name: "End mill 4".into(), diameter: 4.0, step_z: 1.5, feedrate: 840.0, rpm: 12000.0, plunge_feed: 672.0, ramp_tan: 0.0, dial: None, raw_diameter: 4.0, lib_index: 0.0, change: "M0 ".into(), reamer: false, ..Default::default() }
    }
    fn square(mode: &str) -> Shape {
        Shape {
            kind: "polyline".into(), x: 20.0, y: 20.0, w: 80.0, h: 60.0,
            points: vec![[20.0, 20.0], [100.0, 20.0], [100.0, 80.0], [20.0, 80.0]], closed: true,
            mode: mode.into(), depth: -3.0, mill_dir: String::new(), cut: None, tab: None, parent_chain_id: None,
            tool: Some(0),
            ..Default::default()
        }
    }
    fn job(shapes: Vec<Shape>) -> Job {
        Job { version: JOB_VERSION, tools: vec![tool()], spindle: "M3".into(), texts: texts(), shapes, pocket_strategy: String::new(), feed_adapt: None, drift: None, helix_tan: 0.0, lead_others: vec![], warn_texts: HashMap::new(), rest_ignored: 0, images: 0, tool_table: false, no_tool: None }
    }

    /// „Standard“ (kein Werkzeug in der Bibliothek) kann die Vorschau nicht erzeugen – die Bibliothek behält immer ein
    /// Werkzeug. Darum von Hand nach toolStart in cam.ts: Name „Standard“, Ø 3,0, 12000 U/min, Vorschub 800
    #[test]
    fn standard_tool_with_router_dial_and_tool_table() {
        let mut s = square("on-line");
        s.tool = None;
        let mut j = job(vec![s]);
        j.tools.clear();
        j.texts.insert("gc.toolLoad".into(), "load tool {i}: {name}, {d} mm".into());
        j.warn_texts.insert("gcw.dial.low".into(), "{name}: {rpm} rpm is below the dial ({min})".into());
        // ohne Angaben: wie bisher, keine Stufe, kein Hinweis
        let plain = generate_full(&j).unwrap();
        assert!(plain.gcode.starts_with("G21 (unit mm)\nG90 (absolute)\nG0 Z5.00 (safe height)\n\n(Tool: Standard, diameter 3.0 mm)\nM3 S12000 (spindle on, 12000 rpm)\nF800 (feed 800 mm/min)\n"));
        assert!(plain.warnings.is_empty() && plain.section_tools == vec![None]);
        // Oberfräse mit Wählrad: Stufe unter der Werkzeug-Zeile, Hinweis mit dem Namen „Standard“
        j.no_tool = Some(NoTool { change: "M0 ".into(), dial: Some("dial 1 = 13000 rpm".into()), dial_out: Some("low".into()), dial_rpm: 13000.0 });
        let dial = generate_full(&j).unwrap();
        assert!(dial.gcode.contains("\n\n(Tool: Standard, diameter 3.0 mm)\n(dial 1 = 13000 rpm)\nM3 S12000 (spindle on, 12000 rpm)\nF800 (feed 800 mm/min)\n"));
        assert_eq!(dial.warnings.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(), ["Standard: 12000 rpm is below the dial (13000)"]);
        // Datei für eine Steuerung mit Werkzeugtabelle: auch das erste Werkzeug mit Nummer – ohne Werkzeug die 0
        j.tool_table = true;
        j.no_tool = Some(NoTool { change: "M6 T0 ".into(), ..Default::default() });
        let table = generate_full(&j).unwrap();
        assert!(table.gcode.starts_with("G21 (unit mm)\nG90 (absolute)\nG0 Z5.00 (safe height)\nM6 T0 (load tool 1: Standard, 3.0 mm)\n\n(Tool: Standard, diameter 3.0 mm)\nM3 S12000"));
    }

    /// Bilder neben den Formen: der Hinweis steht vor allen anderen
    #[test]
    fn images_are_told_first() {
        let mut j = job(vec![square("outside")]);
        j.images = 2;
        j.rest_ignored = 1;
        j.warn_texts.insert("img.onlyLaser".into(), "{n} image(s) left out".into());
        let out = generate_full(&j).unwrap();
        assert_eq!(out.warnings.iter().map(|w| w.key.as_str()).collect::<Vec<_>>(), ["img.onlyLaser", "gcw.restIgnored"]);
        assert_eq!(out.warnings[0].text, "2 image(s) left out");
    }

    #[test]
    fn outside_square_by_hand() {
        // 40 x 30 mm, Fräser 4 mm außen herum: Bahn 2 mm außerhalb, zwei Zustellungen (−1,5 und −3)
        let g = generate(&job(vec![square("outside")])).unwrap();
        let l: Vec<&str> = g.split('\n').collect();
        assert_eq!(&l[..8], &["G21 (unit mm)", "G90 (absolute)", "G0 Z5.00 (safe height)", "", "(Tool: End mill 4, diameter 4.0 mm)", "M3 S12000 (spindle on, 12000 rpm)", "F840 (feed 840 mm/min)", ""]);
        assert_eq!(l[8], "(--- shape 1: POLYLINE outside ---)");
        assert_eq!(l[9], "G0 Z5.00");
        assert!(g.contains("G1 Z-1.500 F672\nG1 F840\n") && g.contains("G1 Z-3.000 F672\nG1 F840\n"));
        assert!(g.contains("G1 X8.000 Y") && g.contains(" Y42.000\n") && g.contains("G1 X52.000 Y"));
        assert!(g.ends_with("\nG0 Z5.00\nM5 (spindle off)\nG0 X0 Y0 (park)\nM30 (end)\n"));
        // nie tiefer als die Frästiefe, und über dem Material nur im Eilgang nach oben
        for line in &l {
            if let Some(z) = line.split(" Z").nth(1).and_then(|r| r.split(' ').next()).and_then(|v| v.parse::<f64>().ok()) {
                assert!(z >= -3.0 - 1e-9, "{line}");
            }
        }
    }

    #[test]
    fn inside_circle_is_a_full_arc_per_pass() {
        let c = Shape { kind: "circle".into(), x: 100.0, y: 60.0, w: 20.0, h: 20.0, points: vec![], closed: true, mode: "inside".into(), depth: -2.0, mill_dir: String::new(), cut: None, tab: None, parent_chain_id: None, tool: Some(0), ..Default::default() };
        let g = generate(&job(vec![c])).unwrap();
        // Kreis Ø 20 mm bei (50, 30), Fräser 4 mm innen: Radius 8, Einstieg oben bei Y 38
        assert_eq!(g.matches("G2 X50.000 Y38.000 I0.000 J-8.000\n").count(), 2);
        assert!(g.contains("G0 X50.000 Y38.000\nG1 Z-1.50 F672\nF840\n"));
    }

    #[test]
    fn tabs_lift_the_tool_only_below_the_tab_height() {
        let mut s = square("outside");
        s.depth = -6.0;
        s.tab = Some(Tab { len: 5.0, h: 2.0, manual: false, n: 4.0, pts: vec![] });
        let g = generate(&job(vec![s])).unwrap();
        // Steg-Oberkante bei −4: nur die Durchgänge −4,5 und −6 heben an, je 4 Stege
        assert_eq!(g.matches("G1 Z-4.000 (tab)\n").count(), 8);
        assert_eq!(g.matches("G1 Z-6.000 F672\nG1 F840\n").count(), 5); // einmal eintauchen + nach 4 Stegen wieder hinunter
    }

    #[test]
    fn ramp_goes_down_along_the_path() {
        let mut j = job(vec![square("on-line")]);
        j.tools[0].ramp_tan = (10.0f64).to_radians().tan();
        let g = generate(&j).unwrap();
        assert!(g.contains("G1 Z0.000 F672 (ramp)\n"));
        assert!(!g.contains("G1 Z-1.500 F672\n"), "no straight plunge with a ramp angle");
        // Rampe endet auf der Tiefe am Anfang der Bahn
        assert!(g.contains("G1 X10.000 Y10.000 Z-1.500\n"));
    }

    #[test]
    fn inside_before_outside_and_unknown_things_are_refused() {
        let mut small = square("inside");
        small.points = vec![[40.0, 40.0], [60.0, 40.0], [60.0, 60.0], [40.0, 60.0]];
        small.x = 40.0;
        small.y = 40.0;
        small.w = 20.0;
        small.h = 20.0;
        let g = generate(&job(vec![square("outside"), small])).unwrap();
        assert!(g.find("POLYLINE inside").unwrap() < g.find("POLYLINE outside").unwrap());
        let mut thread = square("relief");
        thread.mode = "relief".into();
        assert!(generate(&job(vec![thread])).is_err());
        let mut old = job(vec![square("outside")]);
        old.version = 0;
        assert!(generate(&old).is_err());
    }

    #[test]
    fn difference_is_reported_with_its_line() {
        assert_eq!(compare("a\nb\nc", "a\nb\nc"), Diff { near: 0, first: None });
        assert_eq!(compare("a\nb\nc", "a\nx\nc").first, Some((2, "b".into(), "x".into())));
        assert_eq!(compare("a", "a\nb").first, Some((2, "<end>".into(), "b".into())));
        // ein Tausendstel in einer Zahl zählt als „fast gleich“, mehr nicht – und nie ein anderer Befehl
        assert_eq!(compare("G1 X1.000 Y2.313 Z-1.313", "G1 X1.000 Y2.313 Z-1.312"), Diff { near: 1, first: None });
        assert!(compare("G1 X1.000 Z-1.314", "G1 X1.000 Z-1.312").first.is_some());
        assert!(compare("G1 X1.000 Y2.000", "G0 X1.000 Y2.000").first.is_some());
        assert!(compare("G1 X1.000", "G1 Y1.000").first.is_some());
        assert!(compare("G1 X1.000 F600", "G1 X1.000").first.is_some());
        assert!(compare("M3 S12000", "M3 S12001").first.is_some());
    }

    // ---- Vergleich mit cam.ts: feste Fälle, in der Vorschau erzeugt (siehe tests/fixtures/README.md) ----

    #[test]
    fn same_gcode_as_cam_ts() {
        // gepackt (gzip), weil der G-Code der Taschen lang ist
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/millgcode-cases.json.gz");
        let file = std::fs::File::open(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let cases: Value = serde_json::from_reader(flate2::read::GzDecoder::new(file)).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 20, "only {} cases", cases.len());
        let (mut lines, mut shapes, mut near, mut warnings, mut threads) = (0usize, 0usize, 0usize, 0usize, 0usize);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let job: Job = serde_json::from_value(c["job"].clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
            let want = c["gcode"].as_str().unwrap();
            let full = generate_full(&job).unwrap_or_else(|e| panic!("{name}: {e}"));
            let got = full.gcode.clone();
            let d = compare(&got, want);
            if let Some((n, mine, theirs)) = d.first {
                panic!("{name}: line {n}\n  Rust:   {mine}\n  cam.ts: {theirs}");
            }
            // Hinweise, Gewinde, Werkzeug je Abschnitt: genau wie cam.ts, in derselben Reihenfolge
            if let Some(diff) = compare_side(&full, &c["side"]) {
                panic!("{name}: {diff}");
            }
            warnings += full.warnings.len();
            threads += full.threads.len();
            let count = want.split('\n').count();
            // Ein Tausendstel in einer Zahl: kommt bei Rampen auf Anfahr-Bögen vor (deren Punkte brauchen Sinus/Kosinus,
            // und Rampen-Höhen liegen oft genau auf einer Rundungsgrenze). Höchstens eine von 300 Zeilen.
            assert!(d.near * 300 <= count.max(300), "{name}: {} lines differ by a thousandth", d.near);
            if d.near > 0 {
                println!("{name}: {} of {count} lines differ by 0.001 in one number", d.near);
            }
            near += d.near;
            lines += count;
            shapes += job.shapes.len();
        }
        println!("{} cases, {shapes} shapes, {lines} G-code lines the same as cam.ts ({near} of them differ by 0.001 in one number); {warnings} warnings and {threads} threads the same", cases.len());
    }

    /// Eigene Projekte (nicht im Repository): Ordner mit *.milljob.json = { job, gcode } aus der Vorschau
    /// MILLGCODE_COMPARE=<Ordner> cargo test millgcode -- --ignored --nocapture
    #[test]
    #[ignore]
    fn same_gcode_as_cam_ts_on_local_files() {
        let dir = std::env::var("MILLGCODE_COMPARE").expect("MILLGCODE_COMPARE = folder");
        let mut count = 0;
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = e.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".milljob.json")) else { continue };
            let c: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let job: Job = serde_json::from_value(c["job"].clone()).unwrap();
            let want = c["gcode"].as_str().unwrap();
            let start = std::time::Instant::now();
            let got = generate(&job).unwrap();
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            let d = compare(&got, want);
            match d.first {
                None => println!("{name}: {} shapes, {} lines the same as cam.ts ({} differ by 0.001), {ms:.1} ms in Rust (cam.ts: {} ms)", job.shapes.len(), want.split('\n').count(), d.near, c["ms"]),
                Some((n, mine, theirs)) => panic!("{name}: line {n}\n  Rust:   {mine}\n  cam.ts: {theirs}"),
            }
            count += 1;
        }
        assert!(count > 0, "no *.milljob.json in {dir}");
    }
}
