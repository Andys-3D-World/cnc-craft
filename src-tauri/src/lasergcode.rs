//! LASER-G-CODE – Zwilling von `generateLaserGcode` in `src/laserCam.ts` samt der Bildgravur (`imageGcode` in
//! `src/raster/imageShape.ts`: Zeile für Zeile, abwechselnd hin und zurück). Die gerasterten Bildpunkte kommen als
//! Rohdaten neben dem Auftrag (ein Byte je Punkt für an/aus, vier Bytes je Punkt für Graustufen).
//!
//! Der Auftrag kommt fertig gesammelt aus dem Fenster (`src/laserJob.ts`): Ebenen in ihrer Reihenfolge, die Bahnen der
//! Formen in mm (mit Startpunkt/Richtung von Hand, Freischnitt und Haltestegen – das hängt an den Formen und wird dort
//! gerechnet). Hier entsteht daraus alles Weitere, Zeile für Zeile wie im TypeScript:
//!   Füllen mit Linien (hatch), über Kreuz oder in Ringen (ringFill.ts) · Versatz hin/zurück (scanOffset.ts) ·
//!   Reihenfolge mit kurzen Leerfahrten (cutorder.rs) · Umwege um ausgeschnittene Teile (rapidAvoid.ts) ·
//!   Ecken-Leistung ohne M4 (cornerPower.ts) · Überlauf · Z je Durchgang (zPerPass.ts) · der G-Code-Text.
//! Kosinus/Sinus des Füll-Winkels kommen aus dem Auftrag (ihre letzte Stelle kann zwischen Rust und dem Fenster
//! abweichen); sonst wird hier nichts mit Winkelfunktionen gerechnet.
//! Vergleich mit laserCam.ts: `tests/fixtures/lasergcode-cases.json.gz` (in der Vorschau erzeugt, lasergcode-make.js).

use crate::cutorder;
use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath::{js_num, js_round, to_fixed};
use crate::pocket::pocket_wall_paths;
use crate::polyoffset::{point_in_poly, polygon_area, simplify_polygon};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

type P = [f64; 2];

/// Das Format, das diese Datei versteht (gleiche Zahl wie LASER_JOB_VERSION in laserJob.ts)
pub const JOB_VERSION: u32 = 2;

const MAX_SCANLINES: f64 = 40000.0;
/// mm Abstand der Leerfahrt-Umwege zu ausgeschnittenen Teilen
const AVOID_MARGIN: f64 = 3.0;

/// Eine Kontur der Ebene für „Linie“, schon vorbereitet (Freischnitt, Haltestege)
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LinePath {
    pub pts: Vec<P>,
    pub closed: bool,
    /// Einstich im Abfall (Freischnitt), None = keiner
    #[serde(default)]
    pub lead: Option<P>,
    /// mit Haltestegen: die Stücke, die geschnitten werden
    #[serde(default)]
    pub runs: Option<Vec<Vec<P>>>,
    /// offene Linie darf auch rückwärts gefahren werden
    #[serde(default)]
    pub reversible: bool,
    /// geschlossen ohne Startpunkt von Hand: der Start darf wandern
    #[serde(default)]
    pub free_start: bool,
}

/// Ein Bild der Ebene (Bildgravur): Lage in mm, Raster, wo seine Punkte in den Rohdaten stehen
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    /// Kommentar über dem Bild, fertig in Klammern; `{rows}` wird hier eingesetzt
    pub comment: String,
    /// Ecke unten links und die beiden Kanten (unten, links) in mm
    pub o: P,
    pub ex: P,
    pub ey: P,
    /// über den Rand hinaus fahren (mm), Mindest-Leistung in % (nur Graustufen)
    #[serde(default)]
    pub overscan: f64,
    #[serde(default)]
    pub min_power: f64,
    /// Graustufen (Leistung folgt der Helligkeit) statt an/aus
    pub gray: bool,
    pub gw: usize,
    pub gh: usize,
    /// Anfang der Bildpunkte in den Rohdaten (Zeile 0 = oben): 1 Byte je Punkt, bei Graustufen 4 Bytes (f32)
    pub offset: usize,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    /// Überschrift der Ebene, fertiger Kommentar in Klammern
    pub head: String,
    /// Name der Ebene (für Hinweise)
    pub name: String,
    pub has_fill: bool,
    pub has_line: bool,
    /// „Füllen + Linie“: Fläche und Linie haben eigene Leistung/Geschwindigkeit
    pub both: bool,
    pub power: f64,
    pub speed: f64,
    pub fill_power: f64,
    pub fill_speed: f64,
    pub passes: f64,
    /// Versatz hin/zurück in mm (0 = keiner)
    #[serde(default)]
    pub scan_mm: f64,
    #[serde(default)]
    pub z_off: f64,
    #[serde(default)]
    pub air: bool,
    pub interval: f64,
    /// "lines" | "cross" | "rings"
    #[serde(default)]
    pub fill_kind: String,
    /// Kosinus/Sinus des Füll-Winkels, und des Winkels + 90° (über Kreuz)
    pub ca: f64,
    pub sa: f64,
    pub ca90: f64,
    pub sa90: f64,
    #[serde(default)]
    pub overcut: f64,
    #[serde(default)]
    pub z_step: f64,
    #[serde(default)]
    pub thickness: f64,
    /// Bilder der Ebene (werden zuerst graviert)
    #[serde(default)]
    pub images: Vec<Image>,
    /// geschlossene Konturen der Ebene (für das Füllen)
    pub closed: Vec<Vec<P>>,
    /// Anzahl offener Linien (lassen sich nicht füllen)
    #[serde(default)]
    pub open: usize,
    /// Konturen für „Linie“: offene zuerst, dann geschlossene nach Fläche
    #[serde(default)]
    pub paths: Vec<LinePath>,
    /// so oft lag ein Startpunkt von Hand in einem Haltesteg (Hinweis cut.startInTab)
    #[serde(default)]
    pub start_in_tab: usize,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Corner {
    pub accel: f64,
    pub deviation: f64,
    pub min_pct: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Bed {
    pub w: f64,
    pub h: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub version: u32,
    pub s_max: f64,
    /// M4 (Leistung folgt der Geschwindigkeit) statt M3
    pub dynamic: bool,
    #[serde(default)]
    pub avoid_cut: bool,
    #[serde(default)]
    pub optimize_order: bool,
    /// Ecken-Leistung (nur ohne M4), None = aus
    #[serde(default)]
    pub corner: Option<Corner>,
    /// Arbeitsfläche in mm, None = keine Grenze für Umwege
    #[serde(default)]
    pub bed: Option<Bed>,
    /// Fokus-Leiter: der Job fährt Z von selbst (Hinweis tcard.w.zJob)
    #[serde(default)]
    pub z_job: bool,
    pub layers: Vec<Layer>,
    /// Textbausteine der Kommentare, schon ohne Umlaute, mit Platzhaltern {n}
    pub texts: HashMap<String, String>,
    /// Texte der Hinweise in der Sprache der Oberfläche, mit Platzhaltern
    #[serde(default)]
    pub warn_texts: HashMap<String, String>,
}

/// Ein Hinweis: Schlüssel der Sprachdatei, die Werte dazu und derselbe Hinweis schon eingesetzt
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Warn {
    pub key: String,
    pub p: Vec<(String, String)>,
    pub text: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Output {
    pub gcode: String,
    pub warnings: Vec<Warn>,
}

/// Zahl mit höchstens drei Nachkommastellen: `String(+v.toFixed(3))`
fn n(v: f64) -> String {
    let mut out = String::with_capacity(12);
    push_n(&mut out, v);
    out
}

/// Der genaue, langsame Weg (so rechnet JavaScript nachweislich): runden wie toFixed, als Zahl lesen, kürzeste Schreibweise
fn n_exact(v: f64) -> String {
    js_num(to_fixed(v, 3).parse().unwrap_or(f64::NAN))
}

/// `n(v)` an einen Text anhängen – schnell: Millionen Koordinaten einer Bildgravur gehen hier durch.
/// Tausendstel = v · 1000 gerundet. Liegt v · 1000 nicht nahe an einer Hälfte (dort entscheidet toFixed nach der genauen
/// Dezimalzahl), ist das Ergebnis eindeutig und wird direkt als Ziffern geschrieben; sonst – und bei sehr großen Zahlen –
/// der genaue Weg. Dass beide Wege dasselbe schreiben, prüft ein Test mit Millionen Werten.
fn push_n(out: &mut String, v: f64) {
    let s = v * 1000.0;
    if !(s.abs() < 1e9) {
        out.push_str(&n_exact(v));
        return;
    }
    let f = s.floor();
    let frac = s - f;
    if (frac - 0.5).abs() < 1e-4 {
        out.push_str(&n_exact(v));
        return;
    }
    let k = (if frac > 0.5 { f + 1.0 } else { f }) as i64;
    if k == 0 {
        out.push('0');
        return;
    }
    if k < 0 {
        out.push('-');
    }
    let (whole, mut rest) = (k.unsigned_abs() / 1000, k.unsigned_abs() % 1000);
    let mut buf = [0u8; 20];
    let mut i = buf.len();
    let mut w = whole;
    loop {
        i -= 1;
        buf[i] = b'0' + (w % 10) as u8;
        w /= 10;
        if w == 0 {
            break;
        }
    }
    out.push_str(std::str::from_utf8(&buf[i..]).unwrap_or("0"));
    if rest > 0 {
        out.push('.');
        let mut digits = [b'0' + (rest / 100) as u8, b'0' + (rest / 10 % 10) as u8, b'0' + (rest % 10) as u8];
        let mut len = 3;
        while rest % 10 == 0 {
            rest /= 10;
            len -= 1;
        }
        digits[len..].fill(b'0');
        out.push_str(std::str::from_utf8(&digits[..len]).unwrap_or(""));
    }
}

fn dist(a: P, b: P) -> f64 {
    hypot2(b[0] - a[0], b[1] - a[1])
}

// ---------------------------------------------------------------------------------------------------------------
// Bildgravur (imageGcode in raster/imageShape.ts)
// ---------------------------------------------------------------------------------------------------------------

/// Bildzeilen als G-Code: (Text, Zahl der Zeilen mit Laser). Zeilen laufen entlang der unteren Bildkante; leere
/// Ränder werden übersprungen, vor und nach jeder Zeile wird um „overscan“ mit Laser aus weitergefahren.
/// `scan_mm`: Versatz hin/zurück – jede Zeile um die Hälfte entgegen ihrer Fahrtrichtung. `max_s`: S bei voller Leistung
fn image_rows(im: &Image, data: &[u8], max_s: f64, scan_mm: f64) -> Result<(String, usize), String> {
    let (gw, gh) = (im.gw, im.gh);
    let cells = gw.checked_mul(gh).ok_or("image too large")?;
    let bytes = if im.gray { cells.checked_mul(4).ok_or("image too large")? } else { cells };
    let end = im.offset.checked_add(bytes).ok_or("image data")?;
    let px = data.get(im.offset..end).ok_or("image data is shorter than the job says")?;
    let (o, ex, ey) = (im.o, im.ex, im.ey);
    let pt = |u: f64, v: f64| -> P { [o[0] + u * ex[0] + v * ey[0], o[1] + u * ex[1] + v * ey[1]] };
    let hyp = hypot2(ex[0], ex[1]);
    let width_mm = if hyp == 0.0 || hyp.is_nan() { 1.0 } else { hyp };
    let over = mx(0.0, im.overscan) / width_mm; // in Bildbreiten
    let du = scan_mm / 2.0 / width_mm; // halber Versatz in Bildbreiten
    let min_s = js_round((mx(0.0, mn(100.0, im.min_power)) / 100.0) * max_s);
    let power = |i: usize| -> f64 {
        if im.gray {
            let b = f32::from_le_bytes([px[4 * i], px[4 * i + 1], px[4 * i + 2], px[4 * i + 3]]) as f64;
            if b < 0.004 {
                0.0
            } else {
                js_round(min_s + b * (max_s - min_s))
            }
        } else if px[i] != 0 {
            max_s
        } else {
            0.0
        }
    };
    let mut g = String::new();
    let mut rows = 0usize;
    let (mut lx, mut ly) = (String::new(), String::new());
    let (mut x, mut y) = (String::new(), String::new());
    // S-Werte sind ganze Zahlen (gerundet): als Text nur einmal je Wert rechnen
    let (s_max_text, mut s_last, mut s_text) = (js_num(max_s), f64::NAN, String::new());
    let mut mv = |cmd: &str, q: P, s: f64, g: &mut String| {
        x.clear();
        y.clear();
        push_n(&mut x, q[0]);
        push_n(&mut y, q[1]);
        g.push_str(cmd);
        if x != lx {
            g.push_str(" X");
            g.push_str(&x);
        }
        if y != ly {
            g.push_str(" Y");
            g.push_str(&y);
        }
        g.push_str(" S");
        if s == 0.0 {
            g.push('0');
        } else if s == max_s {
            g.push_str(&s_max_text);
        } else {
            if s != s_last {
                s_text = js_num(s);
                s_last = s;
            }
            g.push_str(&s_text);
        }
        g.push('\n');
        std::mem::swap(&mut lx, &mut x);
        std::mem::swap(&mut ly, &mut y);
    };
    let gwf = gw as f64;
    for row in 0..gh {
        let v = 1.0 - (row as f64 + 0.5) / gh as f64;
        let base = row * gw;
        let (mut a, mut z): (Option<usize>, usize) = (None, 0);
        for x in 0..gw {
            if power(base + x) > 0.0 {
                if a.is_none() {
                    a = Some(x);
                }
                z = x;
            }
        }
        let Some(a) = a else { continue };
        let rtl = rows % 2 == 1;
        rows += 1;
        // Läufe gleicher Leistung von a bis z (Kanten der Bildpunkte bei x / gw)
        let mut runs: Vec<(f64, f64, f64)> = Vec::new();
        for x in a..=z {
            let s = power(base + x);
            match runs.last_mut() {
                Some(last) if last.2 == s => last.1 = (x as f64 + 1.0) / gwf,
                _ => runs.push((x as f64 / gwf, (x as f64 + 1.0) / gwf, s)),
            }
        }
        let (u0, u1) = (a as f64 / gwf, (z as f64 + 1.0) / gwf);
        if !rtl {
            mv("G0", pt(u0 - over - du, v), 0.0, &mut g);
            mv("G1", pt(u0 - du, v), 0.0, &mut g);
            for rn in &runs {
                mv("G1", pt(rn.1 - du, v), rn.2, &mut g);
            }
            mv("G1", pt(u1 + over - du, v), 0.0, &mut g);
        } else {
            mv("G0", pt(u1 + over + du, v), 0.0, &mut g);
            mv("G1", pt(u1 + du, v), 0.0, &mut g);
            for rn in runs.iter().rev() {
                mv("G1", pt(rn.0 + du, v), rn.2, &mut g);
            }
            mv("G1", pt(u0 - over + du, v), 0.0, &mut g);
        }
    }
    Ok((g, rows))
}

// ---------------------------------------------------------------------------------------------------------------
// Füllen mit Linien (hatch in laserCam.ts)
// ---------------------------------------------------------------------------------------------------------------

/// Scanlinien-Füllung (gerade/ungerade-Regel) für mehrere geschlossene Konturen. `ca`/`sa` = Kosinus/Sinus des
/// Winkels. Antwort: Strecken [x0, y0, x1, y1] in Fahr-Reihenfolge (abwechselnd hin und zurück); true = begrenzt.
pub fn hatch(polys: &[Vec<P>], interval: f64, ca: f64, sa: f64) -> (Vec<[f64; 4]>, bool) {
    // ins gedrehte System (Scanlinien dort waagerecht)
    let rot = |p: P| -> P { [p[0] * ca + p[1] * sa, -p[0] * sa + p[1] * ca] };
    let back = |x: f64, y: f64| -> P { [x * ca - y * sa, x * sa + y * ca] };
    #[derive(Clone, Copy)]
    struct Edge {
        y0: f64,
        y1: f64,
        x0: f64,
        dxdy: f64,
    }
    let mut edges: Vec<Edge> = Vec::new();
    let (mut min_y, mut max_y) = (f64::INFINITY, f64::NEG_INFINITY);
    for poly in polys {
        let r: Vec<P> = poly.iter().map(|&p| rot(p)).collect();
        for i in 0..r.len() {
            let (p, q) = (r[i], r[(i + 1) % r.len()]);
            if p[1] == q[1] {
                continue; // waagerecht: trägt nichts bei
            }
            let (lo, hi) = if p[1] < q[1] { (p, q) } else { (q, p) };
            edges.push(Edge { y0: lo[1], y1: hi[1], x0: lo[0], dxdy: (hi[0] - lo[0]) / (hi[1] - lo[1]) });
            if lo[1] < min_y {
                min_y = lo[1];
            }
            if hi[1] > max_y {
                max_y = hi[1];
            }
        }
    }
    let mut segs: Vec<[f64; 4]> = Vec::new();
    if edges.is_empty() || !(interval > 0.0) {
        return (segs, false);
    }
    edges.sort_by(|e, f| (e.y0 - f.y0).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));

    let lines = ((max_y - min_y) / interval).floor();
    let mut step = interval;
    let mut clipped = false;
    if lines > MAX_SCANLINES {
        clipped = true;
        step = (max_y - min_y) / MAX_SCANLINES;
    }
    let mut next = 0;
    let mut active: Vec<Edge> = Vec::new();
    let mut row = 0usize;
    let mut y = min_y + step / 2.0;
    while y < max_y {
        while next < edges.len() && edges[next].y0 <= y {
            active.push(edges[next]);
            next += 1;
        }
        active.retain(|e| e.y1 > y);
        let mut xs: Vec<f64> = active.iter().filter(|e| e.y0 <= y).map(|e| e.x0 + (y - e.y0) * e.dxdy).collect();
        if xs.len() >= 2 {
            xs.sort_by(|p, q| (p - q).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
            let mut row_segs: Vec<(f64, f64)> = Vec::new();
            let mut i = 0;
            while i + 1 < xs.len() {
                if !(xs[i + 1] - xs[i] < 1e-6) {
                    row_segs.push((xs[i], xs[i + 1]));
                }
                i += 2;
            }
            if !row_segs.is_empty() {
                // abwechselnd hin und zurück (spart Leerfahrten)
                let rev = row % 2 == 1;
                if rev {
                    row_segs.reverse();
                }
                for (x0, x1) in row_segs {
                    let a = back(if rev { x1 } else { x0 }, y);
                    let b = back(if rev { x0 } else { x1 }, y);
                    segs.push([a[0], a[1], b[0], b[1]]);
                }
                row += 1;
            }
        }
        y += step;
    }
    (segs, clipped)
}

/// Strecke um den halben Versatz entgegen der Fahrtrichtung schieben (shiftSeg in scanOffset.ts)
fn shift_seg(seg: [f64; 4], mm: f64) -> [f64; 4] {
    let (dx, dy) = (seg[2] - seg[0], seg[3] - seg[1]);
    let len = hypot2(dx, dy);
    if mm == 0.0 || mm.is_nan() || len == 0.0 || len.is_nan() {
        return seg;
    }
    let (sx, sy) = ((dx / len) * (mm / 2.0), (dy / len) * (mm / 2.0));
    [seg[0] - sx, seg[1] - sy, seg[2] - sx, seg[3] - sy]
}

// ---------------------------------------------------------------------------------------------------------------
// Füllen in Ringen (ringFill.ts)
// ---------------------------------------------------------------------------------------------------------------

struct RingPath {
    pts: Vec<P>,
    closed: bool,
}

fn open_ring(l: &[P]) -> Vec<P> {
    if l.len() > 1 && hypot2(l[0][0] - l[l.len() - 1][0], l[0][1] - l[l.len() - 1][1]) < 1e-6 {
        l[..l.len() - 1].to_vec()
    } else {
        l.to_vec()
    }
}

fn bbox(l: &[P]) -> [f64; 4] {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in l {
        x0 = mn(x0, p[0]);
        x1 = mx(x1, p[0]);
        y0 = mn(y0, p[1]);
        y1 = mx(y1, p[1]);
    }
    [x0, y0, x1, y1]
}

/// Konturen nach Flächen sortiert: Außenkontur mit ihren direkten Löchern (fillGroups)
fn fill_groups(polys: &[Vec<P>]) -> Vec<(Vec<P>, Vec<Vec<P>>)> {
    let loops: Vec<Vec<P>> = polys.iter().map(|l| open_ring(l)).filter(|l| l.len() >= 3 && polygon_area(l).abs() > 1e-9).collect();
    let boxes: Vec<[f64; 4]> = loops.iter().map(|l| bbox(l)).collect();
    let area: Vec<f64> = loops.iter().map(|l| polygon_area(l).abs()).collect();
    let parents: Vec<Vec<usize>> = (0..loops.len())
        .map(|i| {
            let l = &loops[i];
            (0..loops.len())
                .filter(|&k| {
                    if k == i || area[k] <= area[i] {
                        return false;
                    }
                    let b = boxes[k];
                    if l[0][0] < b[0] || l[0][0] > b[2] || l[0][1] < b[1] || l[0][1] > b[3] {
                        return false;
                    }
                    point_in_poly(l[0][0], l[0][1], &loops[k])
                })
                .collect()
        })
        .collect();
    // Reihenfolge wie die Map im TypeScript: Außenkonturen in der Reihenfolge der Eingabe
    let outer: Vec<usize> = (0..loops.len()).filter(|&i| parents[i].len() % 2 == 0).collect();
    let mut groups: Vec<(Vec<P>, Vec<Vec<P>>)> = outer.iter().map(|&i| (loops[i].clone(), Vec::new())).collect();
    for i in 0..loops.len() {
        if parents[i].len() % 2 == 0 {
            continue;
        }
        // direkter Elternteil = die kleinste Kontur darum (bei gleicher Fläche die erste)
        let p = parents[i].iter().copied().reduce(|a, b| if area[b] < area[a] { b } else { a }).unwrap();
        if let Some(g) = outer.iter().position(|&o| o == p) {
            groups[g].1.push(loops[i].clone());
        }
    }
    groups
}

/// Ringe von innen nach außen; `rest` = Konturen, die dafür zu schmal oder zu aufwendig sind (bekommen Linien)
fn ring_fill(polys: &[Vec<P>], interval: f64) -> (Vec<RingPath>, Vec<Vec<P>>) {
    let (mut paths, mut rest): (Vec<RingPath>, Vec<Vec<P>>) = (Vec::new(), Vec::new());
    if !(interval > 0.0) {
        return (paths, polys.to_vec());
    }
    for (raw_outer, raw_holes) in fill_groups(polys) {
        // weniger Punkte = viel schneller, und weit unter dem, was ein Laser zeigen kann
        let tol = mn(0.01, interval / 5.0);
        let outer = simplify_polygon(&raw_outer, tol);
        let holes: Vec<Vec<P>> = raw_holes.iter().map(|h| simplify_polygon(h, tol)).collect();
        let b = bbox(&outer);
        let rings = mn(b[2] - b[0], b[3] - b[1]) / 2.0 / interval;
        let pts = (outer.len() + holes.iter().map(|h| h.len()).sum::<usize>()) as f64;
        let mut levels: Vec<Vec<RingPath>> = Vec::new();
        if rings <= 1900.0 && rings * pts * pts <= 1.5e8 {
            for k in 0..2000 {
                let level: Vec<RingPath> = pocket_wall_paths(&outer, &holes, (k as f64 + 0.5) * interval, "").into_iter().filter(|q| q.pts.len() >= 2).map(|q| RingPath { pts: q.pts, closed: q.closed }).collect();
                if level.is_empty() {
                    break;
                }
                levels.push(level);
            }
        }
        if levels.is_empty() {
            rest.push(raw_outer);
            rest.extend(raw_holes);
            continue;
        }
        for l in levels.into_iter().rev() {
            paths.extend(l); // von innen nach außen
        }
    }
    (paths, rest)
}

// ---------------------------------------------------------------------------------------------------------------
// Z je Durchgang (zPerPass.ts)
// ---------------------------------------------------------------------------------------------------------------

/// Tiefe unter der Starthöhe für jeden Durchgang (erster 0, positive Zahlen = tiefer)
fn z_depths(passes: f64, step: f64, thickness: f64) -> Vec<f64> {
    let s = if step.is_finite() { js_round(mn(2.0, mx(0.0, step)) * 100.0) / 100.0 } else { 0.0 };
    let limit = if thickness > 0.0 { mn(5.0, thickness) } else { 5.0 };
    let count = mx(1.0, passes.floor());
    let count = if count.is_nan() { 0 } else { count as usize };
    (0..count).map(|i| js_round(mn(limit, i as f64 * s) * 1000.0) / 1000.0).collect()
}

// ---------------------------------------------------------------------------------------------------------------
// Ecken-Leistung ohne M4 (cornerPower.ts)
// ---------------------------------------------------------------------------------------------------------------

/// Kurvengeschwindigkeit (mm/s) an einem Punkt zwischen zwei Richtungen, höchstens v
fn junction_speed(a: P, b: P, c: P, v: f64, o: &Corner) -> f64 {
    let (ux, uy, wx, wy) = (b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]);
    let (lu, lw) = (hypot2(ux, uy), hypot2(wx, wy));
    if lu < 1e-9 || lw < 1e-9 {
        return v;
    }
    let cos = -(ux * wx + uy * wy) / (lu * lw);
    if cos < -0.999999 {
        return v; // geradeaus
    }
    let sin = mx(0.0, 0.5 * (1.0 - cos)).sqrt();
    if sin >= 0.999999 {
        return v;
    }
    mn(v, ((o.accel * o.deviation * sin) / (1.0 - sin)).sqrt())
}

/// Pfad (erster Punkt = Startposition) → G1-Stücke (x, y, S). Der Laser nutzt nur offene Wege (Anfang und Ende im Stand)
fn corner_power_path(pts: &[P], feed: f64, s_full: f64, o: &Corner) -> Vec<(f64, f64, f64)> {
    let n = pts.len();
    if n < 2 {
        return vec![];
    }
    let (v, a, min_k) = (mx(1.0, feed / 60.0), mx(10.0, o.accel), mn(1.0, mx(0.0, o.min_pct / 100.0)));
    // Geschwindigkeit an jedem Punkt: Anfang und Ende Stillstand
    let v_at: Vec<f64> = (0..n).map(|i| if i == 0 || i == n - 1 { 0.0 } else { junction_speed(pts[i - 1], pts[i], pts[i + 1], v, o) }).collect();
    let s_of = |sp: f64| js_round(s_full * mx(min_k, mn(1.0, sp / v)));
    let mut out: Vec<(f64, f64, f64)> = Vec::new();
    let push = |x: f64, y: f64, s: f64, out: &mut Vec<(f64, f64, f64)>| {
        let len = out.len();
        if len > 1 && out[len - 1].2 == s {
            // gleiche Leistung wie das Stück davor: nur verlängern, wenn es auf derselben Geraden liegt
            let (last, prev) = (out[len - 1], out[len - 2]);
            let cross = (last.0 - prev.0) * (y - last.1) - (last.1 - prev.1) * (x - last.0);
            if cross.abs() < 1e-9 {
                out[len - 1].0 = x;
                out[len - 1].1 = y;
                return;
            }
        }
        out.push((x, y, s));
    };
    for i in 0..n - 1 {
        let (pa, pb) = (pts[i], pts[i + 1]);
        let l = hypot2(pb[0] - pa[0], pb[1] - pa[1]);
        if l < 1e-9 {
            continue;
        }
        let (va, vb) = (v_at[i], v_at[i + 1]);
        // Beschleunigen ab A, Bremsen vor B; treffen sich die Bereiche, gilt die kleinere Kurve (Dreieck)
        let (mut d_a, mut d_b) = (mx(0.0, (v * v - va * va) / (2.0 * a)), mx(0.0, (v * v - vb * vb) / (2.0 * a)));
        if d_a + d_b > l {
            let peak2 = (2.0 * a * l + va * va + vb * vb) / 2.0; // höchste Geschwindigkeit²
            d_a = mx(0.0, (peak2 - va * va) / (2.0 * a));
            d_b = mx(0.0, l - d_a);
        }
        let at = |d: f64| -> P { [pa[0] + ((pb[0] - pa[0]) * d) / l, pa[1] + ((pb[1] - pa[1]) * d) / l] };
        let speed_at = |d: f64| mn(mn(v, (va * va + 2.0 * a * d).sqrt()), (vb * vb + 2.0 * a * (l - d)).sqrt());
        let mut cuts: Vec<f64> = Vec::new();
        if d_a >= 0.15 {
            for k in 1..=3 {
                cuts.push((d_a * k as f64) / 3.0);
            }
        }
        if d_b >= 0.15 {
            for k in (0..3).rev() {
                cuts.push(l - (d_b * k as f64) / 3.0);
            }
        }
        cuts.push(l);
        let mut cuts: Vec<f64> = cuts.into_iter().map(|x| mn(l, mx(0.0, x))).collect();
        cuts.sort_by(|p, q| (p - q).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
        cuts.dedup();
        let mut from = 0.0;
        for d in cuts {
            if d - from < 1e-6 {
                continue;
            }
            let q = at(d);
            push(q[0], q[1], s_of(speed_at((from + d) / 2.0)), &mut out);
            from = d;
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------------------------
// Leerfahrten um ausgeschnittene Teile herum (rapidAvoid.ts)
// ---------------------------------------------------------------------------------------------------------------

const EPS: f64 = 1e-9;
const INSIDE_TOL: f64 = 0.2;
const EDGE_TOL: f64 = 0.02;
const MAX_NODES: usize = 400;
const MIN_KEEP: f64 = 0.5;
const BED_TOL: f64 = 1e-6;

struct Obstacle {
    poly: Vec<P>,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

pub struct RapidPlanner {
    obs: Vec<Obstacle>,
    margin: f64,
    bed: Option<Bed>,
    /// Rahmen um alle Hindernisse bisher
    ext: [f64; 4],
}

fn in_box(p: P, o: &Obstacle) -> bool {
    p[0] >= o.x0 && p[0] <= o.x1 && p[1] >= o.y0 && p[1] <= o.y1
}

fn seg_dist(p: P, a: P, b: P) -> f64 {
    let (ex, ey) = (b[0] - a[0], b[1] - a[1]);
    let l2 = ex * ex + ey * ey;
    let t = if l2 > 0.0 { mx(0.0, mn(1.0, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / l2)) } else { 0.0 };
    hypot2(p[0] - a[0] - ex * t, p[1] - a[1] - ey * t)
}

/// Liegt der Punkt wirklich in der Kontur (nicht nur auf dem Rand)?
fn strictly_inside(p: P, o: &Obstacle) -> bool {
    if !in_box(p, o) || !point_in_poly(p[0], p[1], &o.poly) {
        return false;
    }
    let n = o.poly.len();
    let mut j = n - 1;
    for i in 0..n {
        if seg_dist(p, o.poly[j], o.poly[i]) < EDGE_TOL {
            return false;
        }
        j = i;
    }
    true
}

/// Geht die Strecke p-q durch das Innere der Kontur (mehr als INSIDE_TOL)?
fn crosses(p: P, q: P, o: &Obstacle) -> bool {
    if mx(p[0], q[0]) < o.x0 || mn(p[0], q[0]) > o.x1 || mx(p[1], q[1]) < o.y0 || mn(p[1], q[1]) > o.y1 {
        return false;
    }
    let len = dist(p, q);
    if len < INSIDE_TOL {
        return false;
    }
    // Schnittpunkte mit allen Kanten als Anteil t auf p-q, dann jedes Stück dazwischen prüfen
    let mut ts: Vec<f64> = vec![0.0, 1.0];
    let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
    let poly = &o.poly;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let (a, b) = (poly[j], poly[i]);
        j = i;
        let (ex, ey) = (b[0] - a[0], b[1] - a[1]);
        let den = dx * ey - dy * ex;
        if den.abs() < EPS {
            continue; // parallel: berührt höchstens, geht nicht hindurch
        }
        let t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;
        let u = ((a[0] - p[0]) * dy - (a[1] - p[1]) * dx) / den;
        if t > 0.0 && t < 1.0 && u >= -EPS && u <= 1.0 + EPS {
            ts.push(t);
        }
    }
    ts.sort_by(|s, t| (s - t).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut inside = 0.0;
    for k in 1..ts.len() {
        let seg = (ts[k] - ts[k - 1]) * len;
        if seg < EPS {
            continue;
        }
        let tm = (ts[k] + ts[k - 1]) / 2.0;
        if point_in_poly(p[0] + dx * tm, p[1] + dy * tm, poly) {
            inside += seg;
            if inside > INSIDE_TOL {
                return true;
            }
        }
    }
    false
}

/// A* über die Knoten (0 = Start, 1 = Ziel); Wegstücke werden erst beim Ausprobieren geprüft
fn a_star(nodes: &[P], free: &dyn Fn(P, P) -> bool) -> Option<Vec<P>> {
    let n = nodes.len();
    let goal = nodes[1];
    let mut g = vec![f64::INFINITY; n];
    let mut prev: Vec<Option<usize>> = vec![None; n];
    let mut done = vec![false; n];
    g[0] = 0.0;
    loop {
        let (mut cur, mut best) = (None, f64::INFINITY);
        for i in 0..n {
            if done[i] || g[i] == f64::INFINITY {
                continue;
            }
            let f = g[i] + dist(nodes[i], goal);
            if f < best {
                best = f;
                cur = Some(i);
            }
        }
        let cur = cur?;
        if cur == 1 {
            break;
        }
        done[cur] = true;
        for j in 0..n {
            if done[j] || j == cur {
                continue;
            }
            let d = g[cur] + dist(nodes[cur], nodes[j]);
            if d >= g[j] - EPS {
                continue;
            }
            if !free(nodes[cur], nodes[j]) {
                continue;
            }
            g[j] = d;
            prev[j] = Some(cur);
        }
    }
    let mut out: Vec<P> = Vec::new();
    let mut i = Some(1usize);
    while let Some(k) = i {
        out.insert(0, nodes[k]);
        i = prev[k];
    }
    Some(out)
}

impl RapidPlanner {
    /// `margin` = Abstand des Umwegs zum Rahmen der Kontur in mm; `bed` = Arbeitsfläche (Umwege bleiben darauf)
    pub fn new(margin: f64, bed: Option<Bed>) -> RapidPlanner {
        RapidPlanner { obs: Vec::new(), margin, bed: bed.filter(|b| b.w > 0.0 && b.h > 0.0), ext: [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY] }
    }

    /// Geschlossene Kontur ist fertig geschnitten -> ab jetzt Hindernis
    pub fn add_cut(&mut self, lp: &[P]) {
        let mut poly = lp;
        if poly.len() > 1 && dist(poly[0], poly[poly.len() - 1]) < EPS {
            poly = &poly[..poly.len() - 1];
        }
        if poly.len() < 3 {
            return;
        }
        let b = bbox(poly);
        self.obs.push(Obstacle { poly: poly.to_vec(), x0: b[0], y0: b[1], x1: b[2], y1: b[3] });
        let e = &mut self.ext;
        e[0] = mn(e[0], b[0]);
        e[1] = mn(e[1], b[1]);
        e[2] = mx(e[2], b[2]);
        e[3] = mx(e[3], b[3]);
    }

    /// Zwischenpunkte für die Leerfahrt von a nach b (ohne a und b selbst). Leer = gerade fahren.
    pub fn route(&self, a: P, b: P) -> Vec<P> {
        if self.obs.is_empty() || dist(a, b) < INSIDE_TOL {
            return vec![];
        }
        // Konturen, in denen Start oder Ziel liegt, kann man nicht umfahren
        let active: Vec<&Obstacle> = self.obs.iter().filter(|o| !strictly_inside(a, o) && !strictly_inside(b, o)).collect();
        if !active.iter().any(|o| crosses(a, b, o)) {
            return vec![];
        }
        let free = |p: P, q: P| !active.iter().any(|o| crosses(p, q, o));
        let mut path = a_star(&self.nodes(a, b, &active, None), &free);
        let lim = self.limits(a, b);
        if let (Some(p), Some(lim)) = (&path, lim) {
            if p.len() > 2 && p[1..p.len() - 1].iter().any(|&q| q[0] < lim[0] - BED_TOL || q[0] > lim[2] + BED_TOL || q[1] < lim[1] - BED_TOL || q[1] > lim[3] + BED_TOL) {
                path = a_star(&self.nodes(a, b, &active, Some(lim)), &free);
            }
        }
        match path {
            Some(p) if p.len() > 2 => p[1..p.len() - 1].to_vec(),
            _ => vec![],
        }
    }

    /// Die Arbeitsfläche ohne die Ränder, über die dieser Job schon hinausreicht; None = nichts begrenzt
    fn limits(&self, a: P, b: P) -> Option<[f64; 4]> {
        let bed = self.bed?;
        let e = self.ext;
        Some([
            if mn(mn(a[0], b[0]), e[0]) < -BED_TOL { f64::NEG_INFINITY } else { 0.0 },
            if mn(mn(a[1], b[1]), e[1]) < -BED_TOL { f64::NEG_INFINITY } else { 0.0 },
            if mx(mx(a[0], b[0]), e[2]) > bed.w + BED_TOL { f64::INFINITY } else { bed.w },
            if mx(mx(a[1], b[1]), e[3]) > bed.h + BED_TOL { f64::INFINITY } else { bed.h },
        ])
    }

    /// Start, Ziel und die Rahmen-Ecken aller Hindernisse; mit `bed` jede Ecke auf die Fläche zurückgezogen
    fn nodes(&self, a: P, b: P, active: &[&Obstacle], bed: Option<[f64; 4]>) -> Vec<P> {
        let m = self.margin;
        let mut nodes: Vec<P> = vec![a, b];
        for o in active {
            for corner in [[o.x0 - m, o.y0 - m], [o.x1 + m, o.y0 - m], [o.x1 + m, o.y1 + m], [o.x0 - m, o.y1 + m]] {
                let mut c = corner;
                if let Some(bed) = bed {
                    c = [mn(mx(c[0], bed[0]), bed[2]), mn(mx(c[1], bed[1]), bed[3])];
                    let keep = m * MIN_KEEP - EPS;
                    if mx(o.x0 - c[0], c[0] - o.x1) < keep || mx(o.y0 - c[1], c[1] - o.y1) < keep {
                        continue;
                    }
                }
                // Ecken, die selbst in einem Teil liegen, taugen nicht als Umweg
                if !active.iter().any(|q| in_box(c, q) && point_in_poly(c[0], c[1], &q.poly)) {
                    nodes.push(c);
                }
            }
            if nodes.len() > MAX_NODES {
                break;
            }
        }
        nodes
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Der G-Code
// ---------------------------------------------------------------------------------------------------------------

/// Überlauf: nach dem Schließen ein Stück weiter auf der Kontur (overcutPoints in plasmaCam.ts)
fn overcut_points(lp: &[P], len: f64) -> Vec<P> {
    let mut out: Vec<P> = Vec::new();
    let mut rest = len;
    let mut i = 1;
    while i <= lp.len() && rest > 1e-6 {
        let (a, b) = (lp[i - 1], lp[i % lp.len()]);
        let d = hypot2(b[0] - a[0], b[1] - a[1]);
        i += 1;
        if d < 1e-9 {
            continue;
        }
        if d >= rest {
            out.push([a[0] + (b[0] - a[0]) * (rest / d), a[1] + (b[1] - a[1]) * (rest / d)]);
            rest = 0.0;
        } else {
            out.push(b);
            rest -= d;
        }
    }
    out
}

struct Gen<'a> {
    job: &'a Job,
    g: String,
    warns: Vec<Warn>,
    avoid: Option<RapidPlanner>,
    pos: Option<P>,
}

impl Gen<'_> {
    /// Kommentar in Klammern aus einem Textbaustein; die Werte werden der Reihe nach eingesetzt (wie tMm)
    fn c(&self, key: &str, params: &[(&str, String)]) -> String {
        let mut s = self.job.texts.get(key).cloned().unwrap_or_else(|| key.to_string());
        for (k, v) in params {
            s = s.replace(&format!("{{{k}}}"), v);
        }
        format!("({s})")
    }
    fn w(&mut self, key: &str, params: &[(&str, String)]) {
        let mut text = self.job.warn_texts.get(key).cloned().unwrap_or_else(|| key.to_string());
        for (k, v) in params {
            text = text.replace(&format!("{{{k}}}"), v);
        }
        self.warns.push(Warn { key: key.to_string(), p: params.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(), text });
    }
    /// Leerfahrt mit Laser aus – um schon ausgeschnittene Teile herum, wenn das eingeschaltet ist
    fn rapid(&mut self, to: P, note: &str) {
        if let (Some(avoid), Some(pos)) = (&self.avoid, self.pos) {
            let c = self.c("gc.avoid", &[]);
            for v in avoid.route(pos, to) {
                self.g.push_str(&format!("G0 X{} Y{} S0 {c}\n", n(v[0]), n(v[1])));
            }
        }
        self.g.push_str(&format!("G0 X{} Y{} S0{note}\n", n(to[0]), n(to[1])));
        self.pos = Some(to);
    }
    /// Weg mit Ecken-Leistung: jedes Stück mit seinem S, das nur geschrieben wird, wenn es sich ändert
    fn corner_moves(&mut self, way: &[P], feed: f64, s_full: f64, o: &Corner) {
        let mut last = -1.0;
        for m in corner_power_path(way, feed, s_full, o) {
            let s = if m.2 != last { format!(" S{}", js_num(m.2)) } else { String::new() };
            self.g.push_str(&format!("G1 X{} Y{}{s}\n", n(m.0), n(m.1)));
            last = m.2;
        }
    }
}

/// Konturpunkte ab dem gewählten Start (geschlossen) bzw. rückwärts (offen) – orientPts in cutOrder.ts
fn orient_pts(p: &LinePath, st: &cutorder::Step, free_start: bool) -> Vec<P> {
    if free_start && st.start > 0 {
        let mut lp: &[P] = &p.pts;
        if lp.len() > 1 && dist(lp[0], lp[lp.len() - 1]) < 1e-6 {
            lp = &lp[..lp.len() - 1];
        }
        let s = st.start.min(lp.len());
        return [&lp[s..], &lp[..s]].concat();
    }
    if st.reversed {
        p.pts.iter().rev().copied().collect()
    } else {
        p.pts.clone()
    }
}

/// Rohdaten des Befehls laser_generate zerlegen (laserBody in laserJob.ts): 4 Bytes Länge des Auftrags (little endian),
/// der Auftrag als JSON, danach die Bildpunkte aller Bilder
pub fn split_body(body: &[u8]) -> Result<(Job, &[u8]), String> {
    let len = body.get(..4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize).ok_or("no job")?;
    let json = body.get(4..4usize.saturating_add(len)).ok_or("the job is shorter than its length says")?;
    let job: Job = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    Ok((job, &body[4 + len..]))
}

/// G-Code und Hinweise für den Auftrag; `data` = die Bildpunkte aller Bilder (leer ohne Bildgravur).
/// Err = der Auftrag passt nicht zu dieser Datei
pub fn generate(job: &Job, data: &[u8]) -> Result<Output, String> {
    if job.version != JOB_VERSION {
        return Err(format!("job version {} (this build understands {})", job.version, JOB_VERSION));
    }
    for l in &job.layers {
        for p in &l.paths {
            if p.pts.len() < 2 || p.runs.as_ref().is_some_and(|r| r.is_empty() || r.iter().any(|run| run.len() < 2)) {
                return Err("a path with fewer than two points".into());
            }
        }
    }
    let s_of = |power: f64| js_round((power / 100.0) * job.s_max);
    let mut x = Gen { job, g: String::new(), warns: vec![], avoid: if job.avoid_cut { Some(RapidPlanner::new(AVOID_MARGIN, job.bed)) } else { None }, pos: None };
    // Testkarte, Fokus-Leiter: der Job fährt Z von selbst
    if job.z_job {
        x.w("tcard.w.zJob", &[]);
    }
    let head = format!(
        "G21 {}\nG90 {}\n{}\n{} S0 {}\n",
        x.c("gc.unitMm", &[]),
        x.c("gc.absolute", &[]),
        x.c("lgc.header", &[("n", job.layers.len().to_string()), ("s", js_num(job.s_max))]),
        if job.dynamic { "M4" } else { "M3" },
        x.c(if job.dynamic { "lgc.m4" } else { "lgc.m3" }, &[])
    );
    x.g.push_str(&head);

    for layer in &job.layers {
        // „Füllen + Linie“: Fläche und Linie haben eigene Leistung/Geschwindigkeit
        let both = layer.both;
        let s_line = s_of(layer.power);
        let fill_s = if both { s_of(layer.fill_power) } else { s_line };
        let fill_f = if both { layer.fill_speed } else { layer.speed };
        x.g.push_str(&format!("\n{}\n", layer.head));
        let scan_mm = layer.scan_mm;
        // Fokus-Leiter: relativ nach oben, am Ende des Blocks wieder genauso weit zurück. Nur solange Laser aus (S0)
        let z_off = layer.z_off != 0.0 && !layer.z_off.is_nan();
        if z_off {
            let l = format!("{}\nG91\nG0 Z{} S0\nG90\n", x.c("lgc.zUp", &[("z", js_num(layer.z_off))]), n(layer.z_off));
            x.g.push_str(&l);
        }
        if layer.air {
            let l = format!("M8 {}\n", x.c("lgc.airOn", &[]));
            x.g.push_str(&l);
        }
        x.g.push_str(&format!("F{}\n", n(layer.speed)));

        // ---- BILDER (zuerst gravieren, dann schneiden) ----
        for im in &layer.images {
            let (rows_g, rows) = image_rows(im, data, s_line, scan_mm)?;
            if rows == 0 {
                continue;
            }
            let mut pass = 0.0;
            while pass < layer.passes {
                x.g.push_str(&im.comment.replace("{rows}", &rows.to_string()));
                x.g.push('\n');
                if both {
                    x.g.push_str(&format!("F{}\n", n(fill_f)));
                }
                x.g.push_str(&rows_g);
                pass += 1.0;
            }
            x.pos = None; // Position nach dem Bild unbekannt -> nächste Leerfahrt gerade
            if both {
                x.g.push_str(&format!("F{}\n", n(layer.speed)));
            }
        }
        let closed = &layer.closed;

        // ---- FÜLLEN ----
        if layer.has_fill {
            if layer.open > 0 {
                x.w("lgw.openNoFill", &[("name", layer.name.clone()), ("n", layer.open.to_string())]);
            }
            if !closed.is_empty() {
                // Ringe entlang der Kontur; was dafür zu schmal oder zu aufwendig ist, bekommt Linien
                let ring = if layer.fill_kind == "rings" { Some(ring_fill(closed, layer.interval)) } else { None };
                if let Some((_, rest)) = &ring {
                    if !rest.is_empty() {
                        x.w("lgw.ringRest", &[("name", layer.name.clone()), ("n", rest.len().to_string())]);
                    }
                }
                let (mut segs, mut clipped) = hatch(ring.as_ref().map_or(closed, |r| &r.1), layer.interval, layer.ca, layer.sa);
                // über Kreuz: noch einmal um 90° gedreht
                if layer.fill_kind == "cross" {
                    let b = hatch(closed, layer.interval, layer.ca90, layer.sa90);
                    segs.extend(b.0);
                    clipped = clipped || b.1;
                }
                if clipped {
                    x.w("lgw.tooManyLines", &[("name", layer.name.clone()), ("max", js_num(MAX_SCANLINES))]);
                }
                let ring_paths: &[RingPath] = ring.as_ref().map_or(&[], |r| &r.0);
                let mut pass = 0.0;
                while pass < layer.passes {
                    if layer.passes > 1.0 {
                        let l = format!("{}\n", x.c("lgc.pass", &[("i", js_num(pass + 1.0)), ("n", js_num(layer.passes))]));
                        x.g.push_str(&l);
                    }
                    let l = format!("{}\n", x.c("lgc.fill", &[("n", (segs.len() + ring_paths.len()).to_string())]));
                    x.g.push_str(&l);
                    if both {
                        x.g.push_str(&format!("F{}\n", n(fill_f)));
                    }
                    for p in ring_paths {
                        x.g.push_str(&format!("G0 X{} Y{} S0\n", n(p.pts[0][0]), n(p.pts[0][1])));
                        x.g.push_str(&format!("G1 X{} Y{} S{}\n", n(p.pts[1][0]), n(p.pts[1][1]), js_num(fill_s)));
                        for q in &p.pts[2..] {
                            x.g.push_str(&format!("G1 X{} Y{}\n", n(q[0]), n(q[1])));
                        }
                        if p.closed {
                            x.g.push_str(&format!("G1 X{} Y{}\n", n(p.pts[0][0]), n(p.pts[0][1])));
                        }
                        x.pos = Some(if p.closed { p.pts[0] } else { p.pts[p.pts.len() - 1] });
                    }
                    for raw in &segs {
                        let sg = if scan_mm != 0.0 && !scan_mm.is_nan() { shift_seg(*raw, scan_mm) } else { *raw };
                        x.g.push_str(&format!("G0 X{} Y{} S0\n", n(sg[0]), n(sg[1])));
                        x.g.push_str(&format!("G1 X{} Y{} S{}\n", n(sg[2]), n(sg[3]), js_num(fill_s)));
                    }
                    if let Some(last) = segs.last() {
                        x.pos = Some([last[2], last[3]]);
                    }
                    pass += 1.0;
                }
            }
        }

        // ---- LINIE ----
        if layer.has_line {
            for _ in 0..layer.start_in_tab {
                x.w("cut.startInTab", &[]);
            }
            let mut paths: Vec<LinePath> = layer.paths.clone();
            // kürzeste Leerfahrten (Löcher bleiben vor ihrem Teil, siehe cutorder.rs)
            if job.optimize_order && paths.len() > 1 {
                let items: Vec<cutorder::Item> = paths
                    .iter()
                    .map(|p| {
                        let last = |r: &Vec<P>| r[r.len() - 1];
                        if let Some(runs) = &p.runs {
                            return cutorder::Item { entry: p.lead.unwrap_or(runs[0][0]), exit: last(&runs[runs.len() - 1]), pts: p.pts.clone(), closed: true, free_start: false, reversible: false };
                        }
                        if !p.closed {
                            return cutorder::Item { entry: p.pts[0], exit: last(&p.pts), pts: p.pts.clone(), closed: false, free_start: false, reversible: p.reversible };
                        }
                        if let Some(lead) = p.lead {
                            return cutorder::Item { entry: lead, exit: p.pts[0], pts: p.pts.clone(), closed: true, free_start: false, reversible: false };
                        }
                        // Startpunkt von Hand bleibt liegen; ohne ihn darf der Start wandern
                        cutorder::Item { entry: p.pts[0], exit: p.pts[0], pts: p.pts.clone(), closed: true, free_start: p.free_start, reversible: false }
                    })
                    .collect();
                let from = x.pos.unwrap_or([0.0, 0.0]);
                let steps = cutorder::optimize(&items, from, 150.0);
                let plain: Vec<cutorder::Step> = (0..items.len()).map(|i| cutorder::Step { index: i, reversed: false, start: 0 }).collect();
                let before = cutorder::travel_length(&items, &plain, from);
                let after = cutorder::travel_length(&items, &steps, from);
                let l = format!("{}\n", x.c("gc.orderOpt", &[("a", js_num(js_round(before))), ("b", js_num(js_round(after)))]));
                x.g.push_str(&l);
                paths = steps.iter().map(|st| LinePath { pts: orient_pts(&paths[st.index], st, items[st.index].free_start), ..paths[st.index].clone() }).collect();
            }
            if both {
                x.g.push_str(&format!("F{}\n", n(layer.speed))); // nach dem Füllen wieder die Linien-Geschwindigkeit
            }
            // Z je Durchgang: relativ und nur mit Laser aus (S0); am Ende der Ebene wieder genauso weit hoch
            let depths = z_depths(layer.passes, layer.z_step, layer.thickness);
            let deepest = depths[depths.len() - 1];
            if deepest > 0.0 {
                x.w("lgw.zStep", &[("name", layer.name.clone()), ("z", js_num(deepest))]);
            }
            let (mut pass, mut pi) = (0.0, 0usize);
            while pass < layer.passes {
                if layer.passes > 1.0 {
                    let l = format!("{}\n", x.c("lgc.pass", &[("i", js_num(pass + 1.0)), ("n", js_num(layer.passes))]));
                    x.g.push_str(&l);
                }
                let down = if pi > 0 && pi < depths.len() { depths[pi] - depths[pi - 1] } else { 0.0 };
                if down > 0.0 {
                    let l = format!("{}\nG91\nG0 Z{} S0\nG90\n", x.c("lgc.zDown", &[("z", n(depths[pi]))]), n(-down));
                    x.g.push_str(&l);
                }
                for p in &paths {
                    if let Some(runs) = &p.runs {
                        // mit Haltestegen: jedes Stück schneiden, über den Steg mit Laser aus springen
                        for (ri, run) in runs.iter().enumerate() {
                            let lead = if ri == 0 { p.lead } else { None };
                            if let Some(lead) = lead {
                                let note = format!(" {}", x.c("lgc.leadIn", &[]));
                                x.rapid(lead, &note);
                            } else {
                                let note = if ri > 0 { format!(" {}", x.c("gc.tab", &[])) } else { String::new() };
                                x.rapid(run[0], &note);
                            }
                            if let Some(corner) = &job.corner {
                                // jedes Stück beginnt und endet im Stand (Laser aus über dem Steg)
                                let way: Vec<P> = lead.into_iter().chain(run.iter().copied()).collect();
                                x.corner_moves(&way, layer.speed, s_line, corner);
                            } else {
                                if lead.is_some() {
                                    x.g.push_str(&format!("G1 X{} Y{} S{}\n", n(run[0][0]), n(run[0][1]), js_num(s_line)));
                                }
                                x.g.push_str(&format!("G1 X{} Y{} S{}\n", n(run[1][0]), n(run[1][1]), js_num(s_line)));
                                for q in &run[2..] {
                                    x.g.push_str(&format!("G1 X{} Y{}\n", n(q[0]), n(q[1])));
                                }
                            }
                            x.pos = Some(run[run.len() - 1]);
                        }
                        continue;
                    }
                    let pts = &p.pts;
                    // Überlauf: nach dem Schließen ein Stück weiter auf der Kontur, damit am Start nichts hängen bleibt
                    let over = if p.closed && layer.overcut > 0.0 { overcut_points(&open_ring(pts), layer.overcut) } else { vec![] };
                    // Freischnitt: im Abfall einstechen und zur Kontur fahren
                    if let Some(lead) = p.lead {
                        let note = format!(" {}", x.c("lgc.leadIn", &[]));
                        x.rapid(lead, &note);
                    } else {
                        x.rapid(pts[0], "");
                    }
                    if let Some(corner) = &job.corner {
                        // ohne M4: in Ecken weniger Leistung – immer als offener Weg vom Einstich bis zurück zum Start
                        let mut way: Vec<P> = p.lead.into_iter().chain(pts.iter().copied()).collect();
                        if p.closed {
                            way.push(pts[0]);
                            way.extend(over.iter().copied());
                        }
                        x.corner_moves(&way, layer.speed, s_line, corner);
                    } else {
                        if p.lead.is_some() {
                            x.g.push_str(&format!("G1 X{} Y{} S{}\n", n(pts[0][0]), n(pts[0][1]), js_num(s_line)));
                        }
                        x.g.push_str(&format!("G1 X{} Y{} S{}\n", n(pts[1][0]), n(pts[1][1]), js_num(s_line)));
                        for q in &pts[2..] {
                            x.g.push_str(&format!("G1 X{} Y{}\n", n(q[0]), n(q[1])));
                        }
                        if p.closed {
                            x.g.push_str(&format!("G1 X{} Y{}\n", n(pts[0][0]), n(pts[0][1])));
                        }
                        for o in &over {
                            x.g.push_str(&format!("G1 X{} Y{}\n", n(o[0]), n(o[1])));
                        }
                    }
                    x.pos = Some(match over.last() {
                        Some(&o) => o,
                        None if p.closed => pts[0],
                        None => pts[pts.len() - 1],
                    });
                    // ganz ausgeschnitten (ohne Haltestege) -> kann kippen, ab jetzt umfahren (einmal reicht)
                    if p.closed && pi == 0 {
                        if let Some(avoid) = &mut x.avoid {
                            avoid.add_cut(pts);
                        }
                    }
                }
                pass += 1.0;
                pi += 1;
            }
            if deepest > 0.0 {
                let l = format!("{}\nG91\nG0 Z{} S0\nG90\n", x.c("lgc.zBack", &[]), n(deepest));
                x.g.push_str(&l);
            }
        }
        if layer.air {
            let l = format!("M9 {}\n", x.c("lgc.airOff", &[]));
            x.g.push_str(&l);
        }
        if z_off {
            let l = format!("{}\nG91\nG0 Z{} S0\nG90\n", x.c("lgc.zBack", &[]), n(-layer.z_off));
            x.g.push_str(&l);
        }
    }

    let l = format!("\nS0\nM5 {}\n", x.c("lgc.laserOff", &[]));
    x.g.push_str(&l);
    let note = format!(" {}", x.c("gc.park", &[]));
    x.rapid([0.0, 0.0], &note);
    let l = format!("M30 {}\n", x.c("gc.end", &[]));
    x.g.push_str(&l);
    Ok(Output { gcode: x.g, warnings: x.warns })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn base64(s: &str) -> Vec<u8> {
        let val = |c: u8| -> u32 {
            match c {
                b'A'..=b'Z' => (c - b'A') as u32,
                b'a'..=b'z' => (c - b'a') as u32 + 26,
                b'0'..=b'9' => (c - b'0') as u32 + 52,
                b'+' => 62,
                _ => 63,
            }
        };
        let bytes: Vec<u8> = s.bytes().filter(|&c| c != b'=').collect();
        let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
        for ch in bytes.chunks(4) {
            let v = ch.iter().fold(0u32, |a, &c| (a << 6) | val(c)) << (6 * (4 - ch.len()));
            out.extend_from_slice(&[(v >> 16) as u8, (v >> 8) as u8, v as u8][..ch.len() - 1]);
        }
        out
    }

    /// von Hand: Bild 4 × 2 Punkte, 4 mm breit und 2 mm hoch bei (10, 20), an/aus. Obere Zeile: Punkte 1 und 2 an →
    /// von links nach rechts bei y = 21,5: Anlauf 2 mm vor x = 11, Laser an bis x = 13, Auslauf bis x = 15.
    /// Untere Zeile: nur Punkt 3 an → von rechts nach links bei y = 20,5.
    #[test]
    fn image_rows_run_back_and_forth_and_skip_empty_edges() {
        let im = Image { comment: String::new(), o: [10.0, 20.0], ex: [4.0, 0.0], ey: [0.0, 2.0], overscan: 2.0, min_power: 0.0, gray: false, gw: 4, gh: 2, offset: 1 };
        let data = [9u8, 0, 1, 1, 0, 0, 0, 0, 1];
        let (g, rows) = image_rows(&im, &data, 500.0, 0.0).unwrap();
        assert_eq!(rows, 2);
        assert_eq!(g, "G0 X9 Y21.5 S0\nG1 X11 S0\nG1 X13 S500\nG1 X15 S0\nG0 X16 Y20.5 S0\nG1 X14 S0\nG1 X13 S500\nG1 X11 S0\n");
        // Graustufen: 0,5 → halbe Leistung über der Mindest-Leistung (10 % von 500 = 50): 50 + 0,5 · 450 = 275
        let gray = Image { gray: true, min_power: 10.0, gw: 2, gh: 1, offset: 0, ..im.clone() };
        let px: Vec<u8> = [0.5f32, 0.001].iter().flat_map(|v| v.to_le_bytes()).collect();
        let (g, rows) = image_rows(&gray, &px, 500.0, 0.0).unwrap();
        assert_eq!((rows, g.as_str()), (1, "G0 X8 Y21 S0\nG1 X10 S0\nG1 X12 S275\nG1 X14 S0\n"));
        assert!(image_rows(&gray, &px[..7], 500.0, 0.0).is_err(), "too little data is refused");
    }

    /// Zeit für ein großes Foto (nicht im normalen Lauf):  cargo test --lib lasergcode -- --ignored --nocapture
    #[test]
    #[ignore]
    fn speed_of_a_large_picture() {
        let (gw, gh) = (3067usize, 3851usize);
        // Muster wie ein gerastertes Foto: etwa 40 % der Punkte an, kurze Läufe
        let mut seed = 12345u32;
        let data: Vec<u8> = (0..gw * gh).map(|_| { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; (seed % 5 < 2) as u8 }).collect();
        let im = Image { comment: String::new(), o: [10.0, 10.0], ex: [306.7, 0.0], ey: [0.0, 385.1], overscan: 2.0, min_power: 0.0, gray: false, gw, gh, offset: 0 };
        let start = std::time::Instant::now();
        let (g, rows) = image_rows(&im, &data, 1000.0, 0.0).unwrap();
        println!("{gw} x {gh}: {rows} rows, {} lines, {} MB in {:.0} ms", g.matches('\n').count(), g.len() / 1_000_000, start.elapsed().as_secs_f64() * 1000.0);
    }

    /// Der schnelle Weg, Zahlen zu schreiben, gibt dasselbe wie der genaue: viele Zufallswerte, alle Tausendstel und
    /// halben Tausendstel in einem Bereich, Werte dicht an den Hälften, große, kleine, negative Zahlen
    #[test]
    fn fast_number_text_is_the_exact_one() {
        let mut seed = 0x9E3779B97F4A7C15u64;
        let mut next = || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed };
        let mut count = 0usize;
        let mut check = |v: f64| { assert_eq!(n(v), n_exact(v), "{v:?}"); count += 1; };
        for _ in 0..1_000_000 {
            let r = next();
            let v = ((r >> 11) as f64 / (1u64 << 53) as f64 - 0.5) * [1.0, 10.0, 700.0, 2500.0, 1e6][(r % 5) as usize];
            check(v);
        }
        for k in -20_000i64..=20_000 {
            let v = k as f64 / 2000.0; // jedes halbe Tausendstel zwischen −10 und 10
            for d in [0.0, 1e-13, -1e-13, 1e-9, -1e-9, 2e-5, -2e-5] {
                check(v + d);
                check((v + d) * 37.0 + 123.0);
            }
        }
        for v in [0.0, -0.0, 0.0004, -0.0004, 0.0005, -0.0005, 0.9995, 0.99949999, 999999.9995, -999999.9995, 1e6, 1e6 + 0.0005, 123456789.0625, 1e15, -1e15, 1e21, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 5e-324, 1.0005, 2.5, 1.0000000000000002] {
            check(v);
        }
        assert!(count > 1_500_000);
    }

    /// Eigene Projekte (nicht im Repository): Ordner mit body.bin (laserBody aus der Vorschau) und gcode.txt (laserCam.ts)
    /// LASER_COMPARE=<Ordner> cargo test --lib lasergcode -- --ignored --nocapture
    #[test]
    #[ignore]
    fn same_gcode_as_laser_cam_ts_on_local_files() {
        let Ok(dir) = std::env::var("LASER_COMPARE") else { return };
        let dir = std::path::Path::new(&dir);
        let body = std::fs::read(dir.join("body.bin")).unwrap();
        let want = std::fs::read_to_string(dir.join("gcode.txt")).unwrap();
        let start = std::time::Instant::now();
        let (job, data) = split_body(&body).unwrap();
        let parsed = start.elapsed().as_secs_f64() * 1000.0;
        let start = std::time::Instant::now();
        let out = generate(&job, data).unwrap();
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        let same = out.gcode == want;
        if !same {
            let first = out.gcode.split('\n').zip(want.split('\n')).position(|(a, b)| a != b);
            panic!("different at line {:?} ({} / {} lines)", first.map(|i| i + 1), out.gcode.split('\n').count(), want.split('\n').count());
        }
        println!("{} MB of data, job read in {parsed:.0} ms; {} lines, {} MB of G-code in {ms:.0} ms – the same as laserCam.ts", body.len() / 1_000_000, want.split('\n').count(), want.len() / 1_000_000);
    }

    /// Rohdaten wie aus laserBody(): Länge, Auftrag, Bildpunkte – und was nicht passt, wird abgelehnt statt falsch gelesen
    #[test]
    fn body_is_split_into_job_and_image_points() {
        let json = br#"{"version":2,"sMax":1000,"dynamic":true,"layers":[],"texts":{}}"#;
        let mut body = (json.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(json);
        body.extend_from_slice(&[1, 0, 1]);
        let (job, data) = split_body(&body).unwrap();
        assert_eq!((job.version, job.s_max, data), (2, 1000.0, &[1u8, 0, 1][..]));
        assert!(split_body(&body[..3]).is_err());
        assert!(split_body(&body[..20]).is_err(), "length says more than there is");
        let mut wrong = body.clone();
        wrong[0] = wrong[0].wrapping_sub(2);
        assert!(split_body(&wrong).is_err(), "cut-off JSON");
    }

    fn square(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<P> {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    /// von Hand: Quadrat 10 × 10, Linienabstand 2 → fünf Zeilen bei y = 1, 3, 5, 7, 9, abwechselnd hin und zurück
    #[test]
    fn hatch_fills_a_square_back_and_forth() {
        let (segs, clipped) = hatch(&[square(0.0, 0.0, 10.0, 10.0)], 2.0, 1.0, 0.0);
        assert!(!clipped);
        assert_eq!(segs, vec![[0.0, 1.0, 10.0, 1.0], [10.0, 3.0, 0.0, 3.0], [0.0, 5.0, 10.0, 5.0], [10.0, 7.0, 0.0, 7.0], [0.0, 9.0, 10.0, 9.0]]);
        // ein Loch in der Mitte bleibt frei (gerade/ungerade): die Zeile bei y = 5 hat zwei Stücke
        let (segs, _) = hatch(&[square(0.0, 0.0, 10.0, 10.0), square(4.0, 4.0, 6.0, 6.0)], 2.0, 1.0, 0.0);
        assert_eq!(&segs[2..4], &[[0.0, 5.0, 4.0, 5.0], [6.0, 5.0, 10.0, 5.0]]);
    }

    /// von Hand: Z je Durchgang 0,5 mm, vier Durchgänge → 0 / 0,5 / 1 / 1,5; höchstens 2 mm je Durchgang und 5 mm
    /// insgesamt, nie tiefer als das Material dick ist
    #[test]
    fn z_per_pass_has_narrow_limits() {
        assert_eq!(z_depths(4.0, 0.5, 0.0), vec![0.0, 0.5, 1.0, 1.5]);
        assert_eq!(z_depths(4.0, 9.0, 0.0), vec![0.0, 2.0, 4.0, 5.0]);
        assert_eq!(z_depths(4.0, 1.0, 1.5), vec![0.0, 1.0, 1.5, 1.5]);
        assert_eq!(z_depths(0.0, 1.0, 0.0), vec![0.0]);
        assert_eq!(z_depths(3.0, f64::NAN, 0.0), vec![0.0, 0.0, 0.0]);
    }

    /// von Hand: ausgeschnittenes Quadrat 40…60; die Leerfahrt von (0, 50) nach (100, 50) ginge mitten hindurch →
    /// sie geht über zwei Ecken des Rahmens mit 3 mm Abstand (oben oder unten herum, beides gleich lang: die erste)
    #[test]
    fn rapid_goes_round_a_cut_part() {
        let mut pl = RapidPlanner::new(3.0, None);
        assert!(pl.route([0.0, 50.0], [100.0, 50.0]).is_empty());
        pl.add_cut(&square(40.0, 40.0, 60.0, 60.0));
        assert_eq!(pl.route([0.0, 50.0], [100.0, 50.0]), vec![[37.0, 37.0], [63.0, 37.0]]);
        assert!(pl.route([0.0, 0.0], [100.0, 0.0]).is_empty(), "nothing in the way");
        assert!(pl.route([50.0, 50.0], [100.0, 50.0]).is_empty(), "a start inside the part cannot be avoided");
    }

    /// Vergleich mit laserCam.ts: Fälle aus der Vorschau (siehe tests/fixtures/README.md) – G-Code Zeile für Zeile
    /// genau, Hinweise mit ihrem Text in derselben Reihenfolge
    #[test]
    fn same_gcode_as_laser_cam_ts() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/lasergcode-cases.json.gz");
        let file = std::fs::File::open(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let cases: Value = serde_json::from_reader(flate2::read::GzDecoder::new(file)).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 40, "only {} cases", cases.len());
        let (mut lines, mut warnings, mut images) = (0usize, 0usize, 0usize);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let job: Job = serde_json::from_value(c["job"].clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
            // Bildpunkte der Bilder (wenn der Fall welche hat): gepackt und als Text abgelegt
            let data = match c["data"].as_str() {
                Some(b64) => {
                    let mut bytes = Vec::new();
                    std::io::Read::read_to_end(&mut flate2::read::ZlibDecoder::new(&base64(b64)[..]), &mut bytes).unwrap();
                    images += job.layers.iter().map(|l| l.images.len()).sum::<usize>();
                    bytes
                }
                None => Vec::new(),
            };
            let out = generate(&job, &data).unwrap_or_else(|e| panic!("{name}: {e}"));
            let want: Vec<&str> = c["gcode"].as_str().unwrap().split('\n').collect();
            let got: Vec<&str> = out.gcode.split('\n').collect();
            for (k, (a, b)) in got.iter().zip(&want).enumerate() {
                assert!(a == b, "{name}: line {}\n  Rust:        {a}\n  laserCam.ts: {b}", k + 1);
            }
            assert_eq!(got.len(), want.len(), "{name}: number of lines");
            let texts: Vec<&str> = out.warnings.iter().map(|w| w.text.as_str()).collect();
            let want_w: Vec<&str> = c["warnings"].as_array().unwrap().iter().map(|w| w.as_str().unwrap()).collect();
            assert_eq!(texts, want_w, "{name}: warnings");
            lines += want.len();
            warnings += want_w.len();
        }
        assert!(images >= 10, "only {images} images in the cases");
        println!("{} cases, {lines} G-code lines and {warnings} warnings the same as laserCam.ts ({images} engraved images)", cases.len());
    }
}
