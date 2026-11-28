//! DREHACHSE – G-Code auf den Zylinder umrechnen. Zwilling von `src/rotaryWrap.ts` (`wrapGcode`).
//!
//! Der G-Code ist für die abgewickelte Fläche gerechnet (Y = mm rundherum). Hier wird Y in die Drehung umgerechnet
//! (A in Grad oder Y-Weg), jeder Bogen in kurze Geraden zerlegt und der Vorschub je Fahrt neu gesetzt. Rohteil-Formen:
//! rund (wrap_internal), Kegel (wrap_cone), eckig/Vieleck (wrap_prism). Was sich nicht sicher umrechnen lässt, wird
//! abgelehnt (Fehler + Zeile).
//!
//! Folgt dem TypeScript Zeile für Zeile, auch in den Eigenheiten seiner Text-Muster (welche Zeichen Leerzeichen sind,
//! wo ein `;`-Kommentar endet, dass ein Y auch in einem `;`-Kommentar umgerechnet wird). Was das Fenster mit Winkel-
//! funktionen vorab rechnet (Flächen eines Vielecks, Eckenradius), kommt fertig im Auftrag – deren letzte Stelle kann
//! zwischen Rust und dem Fenster abweichen. Bögen brauchen Sinus/Kosinus hier: dort kann eine Zahl in der vierten
//! Nachkommastelle anders gerundet sein (dann nimmt die App das Ergebnis aus dem TypeScript).
//! Gemeinsame Fälle: `tests/fixtures/rotarywrap-cases.json.gz`, festgehalten von `tests/rotaryWrapRust.test.ts`.

use crate::gcodesim::{hypot2, hypot3, js_space, mn, mx};
use crate::jsmath::{self, js_num, js_round, to_fixed};
use serde::Deserialize;

/// Form des Rohteils (RotaryStock in rotaryStock.ts) – fehlende Zahlen zählen wie in JavaScript als „keine Zahl“
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stock {
    #[serde(default)]
    pub shape: String,
    #[serde(default)]
    pub d0: Option<f64>,
    #[serde(default)]
    pub d1: Option<f64>,
    #[serde(default)]
    pub cone_len: Option<f64>,
}

/// Fläche eines eckigen Rohteils (Face in rotaryStock.ts), vom Fenster gerechnet
#[derive(Deserialize, Clone, Debug)]
pub struct Face {
    pub k: f64,
    pub width: f64,
    pub apothem: f64,
    pub angle: f64,
    pub end: f64,
    pub center: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// "a" = eigene A-Achse (Grad), sonst Y-Anschluss (Y-Weg)
    pub axis: String,
    pub drive_dia: f64,
    pub part_dia: f64,
    #[serde(default)]
    pub mm_per_rot: Option<f64>,
    #[serde(default)]
    pub depth_feed: bool,
    /// Lage der Drehachse an der Maschine: "y" oder sonst X
    #[serde(default)]
    pub along: Option<String>,
    #[serde(default)]
    pub reverse: bool,
    /// "internal": der G-Code ist schon intern (Achse entlang X)
    #[serde(default)]
    pub input: Option<String>,
    #[serde(default)]
    pub stock: Option<Stock>,
    #[serde(default)]
    pub overrun: Option<f64>,
    #[serde(default)]
    pub laser: bool,
    /// eckig/Vieleck: die Flächen und der Eckenradius (faces(), cornerRadius() – im Fenster gerechnet)
    #[serde(default)]
    pub faces: Vec<Face>,
    #[serde(default)]
    pub corner_radius: f64,
    /// Kommentar an der Drehung je Fläche (None = keiner)
    #[serde(default)]
    pub face_labels: Option<Vec<String>>,
}

/// Warum sich ein Programm nicht umrechnen lässt, und in welcher Zeile (ab 1)
pub type WrapError = (&'static str, usize);

const SEG: f64 = 0.5;
const CLEAR_ROTATE: f64 = 5.0;
const NAN: f64 = f64::NAN;

fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `/^\s*\$/`
fn dollar_line(raw: &[char]) -> bool {
    raw.iter().find(|&&c| !js_space(c)) == Some(&'$')
}

/// Ende des Klammer-Kommentars, der bei i beginnt (`\([^)]*\)`): Stelle hinter der `)`
fn paren_end(s: &[char], i: usize) -> Option<usize> {
    if s.get(i) != Some(&'(') {
        return None;
    }
    s[i + 1..].iter().position(|&c| c == ')').map(|p| i + p + 2)
}

/// Beginnt bei i ein `;`-Kommentar bis zum Ende (`;.*$`)? Nur wenn danach kein Zeilenende-Zeichen mehr kommt
fn semi_to_end(s: &[char], i: usize) -> bool {
    s.get(i) == Some(&';') && !s[i + 1..].iter().any(|&c| line_end(c))
}

/// Ende einer Zahl nach dem Muster `[-+]?(?:\d+\.?\d*|\.\d+)` ab Stelle i
fn number_end(s: &[char], i: usize) -> Option<usize> {
    let mut j = i;
    if j < s.len() && (s[j] == '-' || s[j] == '+') {
        j += 1;
    }
    let d0 = j;
    while j < s.len() && s[j].is_ascii_digit() {
        j += 1;
    }
    if j > d0 {
        if j < s.len() && s[j] == '.' {
            j += 1;
            while j < s.len() && s[j].is_ascii_digit() {
                j += 1;
            }
        }
        return Some(j);
    }
    if j + 1 < s.len() && s[j] == '.' && s[j + 1].is_ascii_digit() {
        j += 1;
        while j < s.len() && s[j].is_ascii_digit() {
            j += 1;
        }
        return Some(j);
    }
    None
}

fn skip_space(s: &[char], mut i: usize) -> usize {
    while i < s.len() && js_space(s[i]) {
        i += 1;
    }
    i
}

fn parse(s: &[char]) -> f64 {
    s.iter().collect::<String>().parse::<f64>().unwrap_or(NAN)
}

/// Zeile ohne Kommentare, in Großbuchstaben: `raw.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").toUpperCase()`
fn code_of(raw: &[char]) -> Vec<char> {
    let mut out: Vec<char> = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if let Some(e) = paren_end(raw, i) {
            out.push(' ');
            i = e;
        } else {
            out.push(raw[i]);
            i += 1;
        }
    }
    if let Some(semi) = (0..out.len()).find(|&i| semi_to_end(&out, i)) {
        out.truncate(semi);
    }
    out.iter().collect::<String>().to_uppercase().chars().collect()
}

/// Wörter einer Zeile (ohne Kommentare): Muster `([A-Z])\s*(Zahl)`
struct Words(Vec<(char, f64)>);
impl Words {
    fn of(raw: &[char]) -> Words {
        let code = code_of(raw);
        let mut out = Vec::new();
        let mut i = 0;
        while i < code.len() {
            if code[i].is_ascii_uppercase() {
                let j = skip_space(&code, i + 1);
                if let Some(e) = number_end(&code, j) {
                    out.push((code[i], parse(&code[j..e])));
                    i = e;
                    continue;
                }
            }
            i += 1;
        }
        Words(out)
    }
    fn get(&self, l: char) -> Option<f64> {
        self.0.iter().find(|w| w.0 == l).map(|w| w.1)
    }
    fn gs(&self) -> impl Iterator<Item = f64> + '_ {
        self.0.iter().filter(|w| w.0 == 'G').map(|w| w.1)
    }
    fn has_g(&self, v: f64) -> bool {
        self.gs().any(|g| g == v)
    }
    /// übrige Wörter (S, M …), wie sie an einer neu geschriebenen Zeile hängen bleiben
    fn extra(&self) -> String {
        self.0.iter().filter(|w| !"GXYZIJKRFN".contains(w.0)).map(|w| format!("{}{}", w.0, n4(w.1))).collect::<Vec<_>>().join(" ")
    }
}

/// Zahl mit höchstens vier Nachkommastellen: `Math.abs(v) < 5e-5 ? "0" : String(+v.toFixed(4))`
fn n4(v: f64) -> String {
    if v.abs() < 5e-5 {
        return "0".into();
    }
    js_num(to_fixed(v, 4).parse().unwrap_or(NAN))
}
/// Zahl mit höchstens drei Nachkommastellen
fn n3(v: f64) -> String {
    if v.abs() < 5e-4 {
        return "0".into();
    }
    js_num(to_fixed(v, 3).parse().unwrap_or(NAN))
}

/// Achsen-Wörter einer Zeile ersetzen. Muster im TypeScript:
/// `(\([^)]*\)|;.*$)|(?<![A-Z])([Buchstaben])\s*(Zahl)` ohne Rücksicht auf Groß/Klein – Klammer-Kommentare bleiben,
/// mit `semi` auch ein `;`-Kommentar bis zum Zeilenende. `f(Buchstabe groß, Wert)` gibt den neuen Text oder None (bleibt).
fn replace_words(raw: &[char], letters: &str, semi: bool, f: impl Fn(char, f64) -> Option<String>) -> String {
    let mut out = String::with_capacity(raw.len() + 8);
    let mut i = 0;
    while i < raw.len() {
        if let Some(e) = paren_end(raw, i) {
            out.extend(&raw[i..e]);
            i = e;
            continue;
        }
        if semi && semi_to_end(raw, i) {
            out.extend(&raw[i..]);
            break;
        }
        let up = raw[i].to_ascii_uppercase();
        if raw[i].is_ascii_alphabetic() && letters.contains(up) && (i == 0 || !raw[i - 1].is_ascii_alphabetic()) {
            let j = skip_space(raw, i + 1);
            if let Some(e) = number_end(raw, j) {
                match f(up, parse(&raw[j..e])) {
                    Some(t) => out.push_str(&t),
                    None => out.extend(&raw[i..e]),
                }
                i = e;
                continue;
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    out
}

/// F-Wörter samt den Leerzeichen davor entfernen: `(\([^)]*\))|\s*(?<![A-Z])F\s*Zahl`
fn remove_feed(raw: &[char]) -> Vec<char> {
    let mut out: Vec<char> = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if let Some(e) = paren_end(raw, i) {
            out.extend(&raw[i..e]);
            i = e;
            continue;
        }
        let j = skip_space(raw, i);
        if j < raw.len() && (raw[j] == 'F' || raw[j] == 'f') && (j == 0 || !raw[j - 1].is_ascii_alphabetic()) {
            if let Some(e) = number_end(raw, skip_space(raw, j + 1)) {
                i = e;
                continue;
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    out
}

/// Wo der Kommentar am Zeilenende beginnt (samt Leerzeichen davor): `\s*(\([^)]*\)|;.*)\s*$`
fn tail_comment(s: &[char]) -> Option<usize> {
    for i in 0..s.len() {
        let j = skip_space(s, i);
        if let Some(e) = paren_end(s, j) {
            if skip_space(s, e) == s.len() {
                return Some(i);
            }
        } else if s.get(j) == Some(&';') {
            // der Rest ohne die Leerzeichen am Ende darf kein Zeilenende-Zeichen enthalten
            let rest = &s[j + 1..];
            let end = rest.iter().rposition(|&c| !js_space(c)).map_or(0, |p| p + 1);
            if !rest[..end].iter().any(|&c| line_end(c)) {
                return Some(i);
            }
        }
    }
    None
}

/// Y (mm auf der Oberfläche) → Wert für die Maschine
fn map_surface_y(y: f64, o: &Options) -> f64 {
    let turns = (if o.reverse { -y } else { y }) / (std::f64::consts::PI * o.drive_dia);
    if o.axis == "a" {
        turns * 360.0
    } else {
        turns * o.mm_per_rot.unwrap_or(NAN)
    }
}

/// Wörter X/Y/I/J umbenennen (mit Vorzeichen) – eine Drehung um 90° um Z. `to_machine`: intern → Maschine
fn remap_axes(src: &[String], to_machine: bool) -> Vec<String> {
    src.iter()
        .map(|line| {
            let raw: Vec<char> = line.chars().collect();
            if dollar_line(&raw) {
                return line.clone();
            }
            replace_words(&raw, "XYIJ", true, |l, v| {
                let (nl, sg) = match (l, to_machine) {
                    ('X', false) => ('Y', -1.0),
                    ('Y', false) => ('X', 1.0),
                    ('I', false) => ('J', -1.0),
                    ('J', false) => ('I', 1.0),
                    ('X', true) => ('Y', 1.0),
                    ('Y', true) => ('X', -1.0),
                    ('I', true) => ('J', 1.0),
                    _ => ('I', -1.0),
                };
                Some(format!("{nl}{}", n4(sg * v)))
            })
        })
        .collect()
}

/// Punkte eines Bogens (ohne Start, mit Ende) als (x, y, Anteil 0…1); None = ungültig
#[allow(clippy::too_many_arguments)]
fn arc_points(sx: f64, sy: f64, tx: f64, ty: f64, cw: bool, i: Option<f64>, j: Option<f64>, r: Option<f64>, seg: f64) -> Option<Vec<[f64; 3]>> {
    let (cx, cy);
    if let Some(rr) = r {
        let (dxe, dye) = (tx - sx, ty - sy);
        let d = hypot2(dxe, dye);
        if d < 1e-9 || rr.abs() < d / 2.0 - 1e-6 {
            return None;
        }
        let hgt = mx(0.0, rr * rr - (d * d) / 4.0).sqrt() * if cw != (rr < 0.0) { -1.0 } else { 1.0 };
        cx = sx + dxe / 2.0 - (dye / d) * hgt;
        cy = sy + dye / 2.0 + (dxe / d) * hgt;
    } else {
        cx = sx + i.unwrap_or(0.0);
        cy = sy + j.unwrap_or(0.0);
    }
    let rad = hypot2(sx - cx, sy - cy);
    if rad < 1e-6 || (rad - hypot2(tx - cx, ty - cy)).abs() > 0.01 {
        return None;
    }
    let a0 = jsmath::atan2(sy - cy, sx - cx);
    let mut sweep = jsmath::atan2(ty - cy, tx - cx) - a0;
    if cw {
        if sweep >= -1e-9 {
            sweep -= 2.0 * std::f64::consts::PI;
        }
    } else if sweep <= 1e-9 {
        sweep += 2.0 * std::f64::consts::PI;
    }
    let n = mx(4.0, ((sweep.abs() * rad) / seg).ceil());
    // (keine Zahl: die Schleife im TypeScript läuft dann gar nicht)
    let count = if n.is_nan() { 0 } else { n as usize };
    let mut out = Vec::with_capacity(count);
    for k in 1..=count {
        let u = k as f64 / n;
        let an = a0 + sweep * u;
        out.push([if k == count { tx } else { cx + rad * jsmath::cos(an) }, if k == count { ty } else { cy + rad * jsmath::sin(an) }, u]);
    }
    Some(out)
}

fn chars(s: &str) -> Vec<char> {
    s.chars().collect()
}

/// G-Code (Zeilen) für die Drehachse umrechnen
pub fn wrap_gcode(src: &[String], o: &Options) -> Result<Vec<String>, WrapError> {
    let shape = o.stock.as_ref().map(|s| s.shape.as_str()).unwrap_or("");
    if shape == "rect" || shape == "poly" {
        return wrap_prism(src, o);
    }
    let inner = |l: &[String]| if shape == "cone" { wrap_cone(l, o) } else { wrap_internal(l, o) };
    if o.along.as_deref() != Some("y") {
        return inner(src);
    }
    let lines = if o.input.as_deref() == Some("internal") { inner(src)? } else { inner(&remap_axes(src, false))? };
    Ok(remap_axes(&lines, true))
}

/// Vorschub-Wort, wenn sich der gerundete Vorschub geändert hat (fWord)
fn f_word(f: Option<f64>, sent: &mut Option<f64>) -> String {
    let Some(f) = f else { return String::new() };
    let r = mx(1.0, js_round(f));
    if *sent == Some(r) {
        return String::new();
    }
    *sent = Some(r);
    format!(" F{}", js_num(r))
}

fn wrap_internal(src: &[String], o: &Options) -> Result<Vec<String>, WrapError> {
    let mut out: Vec<String> = Vec::with_capacity(src.len());
    let rr = o.part_dia / 2.0;
    let yw = if o.axis == "a" { "A" } else { "Y" };
    let (mut abs, mut plane, mut motion) = (true, 17.0f64, -1.0f64);
    let (mut x, mut y, mut z): (Option<f64>, Option<f64>, Option<f64>) = (None, None, None);
    // Vorschub laut Programm (mm/min auf der Oberfläche) und der zuletzt an die Maschine geschickte
    let (mut feed, mut sent_f): (Option<f64>, Option<f64>) = (None, None);

    // Vorschub für eine Schnittfahrt, damit die Oberfläche mit `feed` läuft
    let feed_for = |feed: Option<f64>, dx: f64, dy: f64, dz: f64, z_mid: f64| -> Option<f64> {
        let feed = feed?;
        let dm = map_surface_y(dy, o);
        // Weg an der Schneide rundherum: auf der Oberfläche dy, in der Tiefe entsprechend kürzer
        let k = if o.depth_feed && rr > 0.0 { mx(0.05, (rr + mn(0.0, z_mid)) / rr) } else { 1.0 };
        let (surf, mach) = (hypot3(dx, dy * k, dz), hypot3(dx, dm, dz));
        Some(if surf > 1e-9 { feed * (mach / surf) } else { feed })
    };

    for (li, line) in src.iter().enumerate() {
        let raw = chars(line);
        let code = code_of(&raw);
        if dollar_line(&raw) || code.iter().all(|&c| js_space(c)) {
            out.push(line.clone());
            continue;
        }
        let w = Words::of(&raw);
        if w.has_g(20.0) {
            return Err(("inch", li + 1));
        }
        if w.gs().any(|g| g == 92.0 || g == 10.0) {
            return Err(("offset", li + 1));
        }
        if w.has_g(90.0) {
            abs = true;
        }
        if w.has_g(91.0) {
            abs = false;
        }
        for p in [17.0, 18.0, 19.0] {
            if w.has_g(p) {
                plane = p;
            }
        }
        for g in w.gs() {
            if g == 0.0 || g == 1.0 || g == 2.0 || g == 3.0 {
                motion = g;
            }
        }
        if w.gs().any(|g| g == 80.0 || (g >= 81.0 && g <= 89.0)) {
            motion = -1.0;
        }
        let f = w.get('F');
        if f.is_some() {
            feed = f;
        }
        // Maschinenkoordinaten / Referenzfahrt: unverändert, Lage danach unbekannt
        if w.gs().any(|g| g == 53.0 || g == 28.0 || g == 30.0) {
            out.push(line.clone());
            x = None;
            y = None;
            z = None;
            continue;
        }
        let (wx, wy, wz) = (w.get('X'), w.get('Y'), w.get('Z'));
        let moves = wx.is_some() || wy.is_some() || wz.is_some();
        if moves && !abs {
            return Err(("relative", li + 1));
        }

        // Bogen → Geraden
        if moves && (motion == 2.0 || motion == 3.0) {
            if plane != 17.0 {
                return Err(("plane", li + 1));
            }
            let (Some(sx), Some(sy)) = (x, y) else { return Err(("arc", li + 1)) };
            // Laser fährt kein Z: dann bleibt Z auch in den Stücken weg
            let z_known = z.is_some() || wz.is_some();
            let sz = z.or(wz).unwrap_or(0.0);
            let (tx, ty, tz) = (wx.unwrap_or(sx), wy.unwrap_or(sy), wz.unwrap_or(sz));
            let Some(pts) = arc_points(sx, sy, tx, ty, motion == 2.0, w.get('I'), w.get('J'), w.get('R'), SEG) else { return Err(("arc", li + 1)) };
            // übrige Wörter (S, M …) bleiben am ersten Stück
            let extra = w.extra();
            let (mut px, mut py, mut pz) = (sx, sy, sz);
            for (k, p) in pts.iter().enumerate() {
                let (qx, qy, u) = (p[0], p[1], p[2]);
                let qz = sz + (tz - sz) * u;
                let mut l = format!("G1 X{} {yw}{}", n4(qx), n4(map_surface_y(qy, o)));
                if z_known && (qz != pz || k == 0) {
                    l.push_str(&format!(" Z{}", n4(qz)));
                }
                l.push_str(&f_word(feed_for(feed, qx - px, qy - py, qz - pz, (qz + pz) / 2.0), &mut sent_f));
                if k == 0 && !extra.is_empty() {
                    l.push(' ');
                    l.push_str(&extra);
                }
                out.push(l);
                px = qx;
                py = qy;
                pz = qz;
            }
            x = Some(tx);
            y = Some(ty);
            z = if z_known { Some(tz) } else { None };
            continue;
        }

        // alle anderen Zeilen: Y umrechnen, F bei Schnittfahrten neu setzen (Klammer-Kommentare bleiben unangetastet)
        let mut text = replace_words(&raw, "Y", false, |_, v| Some(format!("{yw}{}", n4(map_surface_y(v, o)))));
        let cut = moves && motion == 1.0;
        if !cut {
            if let Some(f) = f {
                sent_f = Some(mx(1.0, js_round(f))); // Bohrzyklus, Vorschub ohne Fahrt …
            }
        }
        if cut {
            let stripped = remove_feed(&chars(&text));
            let (tx, ty, tz) = (wx.or(x), wy.or(y), wz.or(z));
            // Z unbekannt (Laser): zählt als 0
            let z0 = z.or(tz).unwrap_or(0.0);
            let z1 = tz.unwrap_or(z0);
            let fw = match (x, y, tx, ty) {
                (Some(x), Some(y), Some(tx), Some(ty)) => f_word(feed_for(feed, tx - x, ty - y, z1 - z0, (z0 + z1) / 2.0), &mut sent_f),
                _ => f_word(feed, &mut sent_f),
            };
            // F vor einen Kommentar am Zeilenende setzen
            let at = tail_comment(&stripped).unwrap_or(stripped.len());
            text = stripped[..at].iter().collect::<String>() + &fw + &stripped[at..].iter().collect::<String>();
        }
        out.push(text);
        if moves && motion >= 0.0 {
            x = wx.or(x);
            y = wy.or(y);
            z = wz.or(z);
        } else if moves && motion == -1.0 {
            // Bohrzyklus: X/Y bleiben, Z endet oben
            x = wx.or(x);
            y = wy.or(y);
        }
    }
    Ok(out)
}

/// Fläche, in der die Stelle u des Bands liegt, und die Mitte dieser Fläche im Band (faceAt)
fn face_at(fs: &[Face], u: f64) -> (usize, f64) {
    let p = fs[fs.len() - 1].end;
    let m = (u / p).floor();
    let w = u - m * p;
    let i = fs.iter().position(|f| w < f.end).unwrap_or(fs.len() - 1);
    (i, fs[i].center + m * p)
}

/// ECKIG / VIELECK: jede Fläche wird eben bearbeitet – A dreht auf die Fläche, dann normaler X/Y/Z-Code.
/// u = Y (Achse entlang X) bzw. X (Achse entlang Y): der Wert wird zum Abstand von der Flächenmitte.
fn wrap_prism(src: &[String], o: &Options) -> Result<Vec<String>, WrapError> {
    let fs = &o.faces;
    if fs.is_empty() {
        return Err(("crossing", 1));
    }
    let ay = o.along.as_deref() == Some("y");
    let (u_ax, a_ax) = if ay { ('X', 'Y') } else { ('Y', 'X') };
    let overrun = o.overrun.unwrap_or(5.0);
    let sign = (if ay { -1.0 } else { 1.0 }) * (if o.reverse { -1.0 } else { 1.0 });
    let a0 = fs[0].apothem;
    let z_safe = o.corner_radius - a0 + CLEAR_ROTATE;

    // 1. Durchgang: Gruppen (Eilgang über dem Material bis zum nächsten) und ihr Bereich im Band
    struct Group {
        start: Option<usize>,
        u: Option<f64>,
        min: f64,
        max: f64,
        first_cut: Option<usize>,
    }
    let mut groups = vec![Group { start: None, u: None, min: f64::INFINITY, max: f64::NEG_INFINITY, first_cut: None }];
    let (mut abs, mut plane, mut motion) = (true, 17.0f64, -1.0f64);
    let (mut cu, mut ca, mut cz): (Option<f64>, Option<f64>, Option<f64>) = (None, None, None);
    for (li, line) in src.iter().enumerate() {
        let raw = chars(line);
        if dollar_line(&raw) {
            continue;
        }
        let w = Words::of(&raw);
        if w.0.is_empty() {
            continue;
        }
        if w.has_g(20.0) {
            return Err(("inch", li + 1));
        }
        if w.gs().any(|g| g == 92.0 || g == 10.0) {
            return Err(("offset", li + 1));
        }
        if w.gs().any(|g| g >= 73.0 && g <= 89.0 && g != 80.0) {
            return Err(("cycle", li + 1));
        }
        if w.has_g(90.0) {
            abs = true;
        }
        if w.has_g(91.0) {
            abs = false;
        }
        for p in [17.0, 18.0, 19.0] {
            if w.has_g(p) {
                plane = p;
            }
        }
        for g in w.gs() {
            if g == 0.0 || g == 1.0 || g == 2.0 || g == 3.0 {
                motion = g;
            }
        }
        if w.gs().any(|g| g == 53.0 || g == 28.0 || g == 30.0) {
            continue;
        }
        let (wu, wa, wz) = (w.get(u_ax), w.get(a_ax), w.get('Z'));
        if wu.is_none() && wa.is_none() && wz.is_none() {
            continue;
        }
        if !abs {
            return Err(("relative", li + 1));
        }
        if motion < 0.0 {
            continue;
        }
        let (tu, ta, tz) = (wu.or(cu), wa.or(ca), wz.or(cz));
        let lateral = wu.is_some() || wa.is_some();
        if motion == 0.0 && lateral && cz.unwrap_or(0.0) >= -1e-6 && tz.unwrap_or(0.0) >= -1e-6 {
            groups.push(Group { start: Some(li), u: tu, min: f64::INFINITY, max: f64::NEG_INFINITY, first_cut: None });
        } else {
            // Schnitt (oder Eilgang im Material): zählt zum Bereich
            let g = groups.last_mut().unwrap();
            let mut add = |v: Option<f64>| {
                if let Some(v) = v {
                    if g.first_cut.is_none() {
                        g.first_cut = Some(li);
                    }
                    g.min = mn(g.min, v);
                    g.max = mx(g.max, v);
                }
            };
            add(cu);
            add(tu);
            if motion == 2.0 || motion == 3.0 {
                if plane != 17.0 {
                    return Err(("plane", li + 1));
                }
                let (Some(su), Some(sa)) = (cu, ca) else { return Err(("arc", li + 1)) };
                // Achsen wie im Programm: (X, Y)
                let (sx, sy) = if ay { (su, sa) } else { (sa, su) };
                let (ex, ey) = if ay { (tu.unwrap_or(su), ta.unwrap_or(sa)) } else { (ta.unwrap_or(sa), tu.unwrap_or(su)) };
                let Some(pts) = arc_points(sx, sy, ex, ey, motion == 2.0, w.get('I'), w.get('J'), w.get('R'), 2.0) else { return Err(("arc", li + 1)) };
                for p in pts {
                    add(Some(if ay { p[0] } else { p[1] }));
                }
            }
        }
        cu = tu;
        ca = ta;
        cz = tz;
    }
    // Fläche je Gruppe: (Nummer der Fläche, Mitte im Band)
    let mut face_of: Vec<(usize, f64)> = Vec::with_capacity(groups.len());
    let mut prev = (0usize, fs[0].center);
    for g in &groups {
        let mut f = prev;
        if g.min <= g.max {
            f = face_at(fs, (g.min + g.max) / 2.0);
            let (lo, hi) = (f.1 - fs[f.0].width / 2.0 - overrun, f.1 + fs[f.0].width / 2.0 + overrun);
            if g.min < lo || g.max > hi {
                // (im TypeScript firstCut + 1; ohne Schnitt −1 + 1 = 0 – kommt mit einem Bereich nicht vor)
                return Err(("crossing", g.first_cut.map_or(0, |l| l + 1)));
            }
        } else if let Some(u) = g.u {
            f = face_at(fs, u);
        }
        face_of.push(f);
        prev = f;
    }

    // 2. Durchgang: ausgeben
    let mut out: Vec<String> = Vec::with_capacity(src.len() + 8);
    let (mut gi, mut cur, mut sent_a): (usize, (usize, f64), Option<f64>) = (0, face_of[0], None);
    let mut begun = false;
    cu = None;
    ca = None;
    cz = None;
    motion = -1.0;
    let rotate = |f: (usize, f64), sent_a: &mut Option<f64>, out: &mut Vec<String>| {
        out.push(format!("G0 Z{}{}", n3(z_safe), if o.laser { " S0" } else { "" }));
        let want = fs[f.0].angle * sign;
        // der kurze Weg: ganze Umdrehungen dazu oder weg
        let a = match *sent_a {
            None => want,
            Some(s) => want + 360.0 * js_round((s - want) / 360.0),
        };
        *sent_a = Some(a);
        let label = o.face_labels.as_ref().map_or(String::new(), |l| format!(" ({})", l.get(fs[f.0].k as usize).cloned().unwrap_or_default()));
        out.push(format!("G0 A{}{label}", n3(a)));
    };
    let rewrite = |raw: &[char], f: (usize, f64)| -> String {
        let dz = fs[f.0].apothem - a0;
        replace_words(raw, "XYZ", true, |l, v| {
            if l == u_ax {
                Some(format!("{u_ax}{}", n3(v - f.1)))
            } else if l == 'Z' {
                Some(format!("Z{}", n3(v + dz)))
            } else {
                None
            }
        })
    };
    for (li, line) in src.iter().enumerate() {
        let raw = chars(line);
        if dollar_line(&raw) {
            out.push(line.clone());
            continue;
        }
        let w = Words::of(&raw);
        if w.0.is_empty() {
            out.push(line.clone());
            continue;
        }
        for g in w.gs() {
            if g == 0.0 || g == 1.0 || g == 2.0 || g == 3.0 {
                motion = g;
            }
        }
        let moves = w.get(u_ax).is_some() || w.get(a_ax).is_some() || w.get('Z').is_some();
        let machine_coord = w.gs().any(|g| g == 53.0 || g == 28.0 || g == 30.0);
        if !moves || motion < 0.0 || machine_coord {
            out.push(line.clone());
            continue;
        }
        // vor der ersten Fahrt: sicher hoch, A auf die erste Fläche
        if !begun {
            begun = true;
            rotate(cur, &mut sent_a, &mut out);
        }
        let (tu, ta, tz) = (w.get(u_ax).or(cu), w.get(a_ax).or(ca), w.get('Z').or(cz));
        if gi + 1 < groups.len() && groups[gi + 1].start == Some(li) {
            gi += 1;
            let next = face_of[gi];
            if fs[next.0].k != fs[cur.0].k {
                rotate(next, &mut sent_a, &mut out);
                cur = next;
                // erst querfahren, dann auf die alte Höhe über der neuen Fläche
                if let Some(tu) = tu {
                    let along = ta.map_or(String::new(), |ta| format!("{a_ax}{} ", n3(ta)));
                    out.push(format!("G0 {along}{u_ax}{}", n3(tu - cur.1)));
                }
                out.push(rewrite(&raw, cur));
                if w.get('Z').is_none() {
                    out.push(format!("G0 Z{}", n3(tz.unwrap_or(0.0) + fs[cur.0].apothem - a0)));
                }
                cu = tu;
                ca = ta;
                cz = tz;
                continue;
            }
            cur = next;
        }
        out.push(rewrite(&raw, cur));
        cu = tu;
        ca = ta;
        cz = tz;
    }
    Ok(out)
}

/// Radius des Kegels an der Stelle `along` entlang der Achse (coneRadius)
fn cone_radius(s: &Stock, along: f64) -> f64 {
    let (d0, d1, len) = (s.d0.unwrap_or(NAN), s.d1.unwrap_or(NAN), s.cone_len.unwrap_or(NAN));
    let u = mx(0.0, mn(1.0, along / mx(1e-9, len)));
    mx(0.01, (d0 + (d1 - d0) * u) / 2.0)
}

/// KEGEL (intern: Achse entlang X, y = Weg rundherum): rundherum zählt die Oberfläche am örtlichen Durchmesser,
/// Z folgt der Schräge; Stücke höchstens 1 mm, weil der Winkel sich entlang der Achse ändert.
fn wrap_cone(src: &[String], o: &Options) -> Result<Vec<String>, WrapError> {
    let stock = o.stock.as_ref().expect("cone stock");
    let mut out: Vec<String> = Vec::with_capacity(src.len());
    let yw = if o.axis == "a" { "A" } else { "Y" };
    let r0 = cone_radius(stock, 0.0);
    // Mitte des Bands intern (halber Umfang am größeren Ø): Achse entlang Y zählt die Zeichnung in X, intern Y = −X
    let center = (std::f64::consts::PI * mx(stock.d0.unwrap_or(NAN), stock.d1.unwrap_or(NAN))) / 2.0;
    let yc = (if o.along.as_deref() == Some("y") { -1.0 } else { 1.0 }) * center;
    let turn = |y: f64, x: f64| -> f64 {
        let t = (((if o.reverse { -1.0 } else { 1.0 }) * (y - yc)) / cone_radius(stock, x)) / (2.0 * std::f64::consts::PI);
        if o.axis == "a" {
            t * 360.0
        } else {
            t * o.mm_per_rot.unwrap_or(NAN)
        }
    };
    let (mut abs, mut plane, mut motion) = (true, 17.0f64, -1.0f64);
    let (mut x, mut y, mut z): (Option<f64>, Option<f64>, f64) = (None, None, 0.0);
    let (mut feed, mut sent_f): (Option<f64>, Option<f64>) = (None, None);
    for (li, line) in src.iter().enumerate() {
        let raw = chars(line);
        if dollar_line(&raw) {
            out.push(line.clone());
            continue;
        }
        let w = Words::of(&raw);
        if w.0.is_empty() {
            out.push(line.clone());
            continue;
        }
        if w.has_g(20.0) {
            return Err(("inch", li + 1));
        }
        if w.gs().any(|g| g == 92.0 || g == 10.0) {
            return Err(("offset", li + 1));
        }
        if w.gs().any(|g| g >= 73.0 && g <= 89.0 && g != 80.0) {
            return Err(("cycle", li + 1));
        }
        if w.has_g(90.0) {
            abs = true;
        }
        if w.has_g(91.0) {
            abs = false;
        }
        for p in [17.0, 18.0, 19.0] {
            if w.has_g(p) {
                plane = p;
            }
        }
        for g in w.gs() {
            if g == 0.0 || g == 1.0 || g == 2.0 || g == 3.0 {
                motion = g;
            }
        }
        let f = w.get('F');
        if f.is_some() {
            feed = f;
        }
        if w.gs().any(|g| g == 53.0 || g == 28.0 || g == 30.0) {
            out.push(line.clone());
            continue;
        }
        let (wx, wy, wz) = (w.get('X'), w.get('Y'), w.get('Z'));
        if wx.is_none() && wy.is_none() && wz.is_none() {
            if let Some(f) = f {
                sent_f = Some(mx(1.0, js_round(f)));
            }
            out.push(line.clone());
            continue;
        }
        if !abs {
            return Err(("relative", li + 1));
        }
        if motion < 0.0 {
            out.push(line.clone());
            continue;
        }
        let (tx, ty, tz) = (wx.or(x), wy.or(y), wz.unwrap_or(z));
        let comment: Option<String> = (0..raw.len()).find_map(|i| paren_end(&raw, i).map(|e| raw[i..e].iter().collect()));
        let extra = w.extra();
        let tail = format!("{}{}", if extra.is_empty() { String::new() } else { format!(" {extra}") }, comment.as_ref().map_or(String::new(), |c| format!(" {c}")));
        let (Some(tx), Some(ty)) = (tx, ty) else {
            // Lage noch unbekannt (z. B. „G0 Z5“ am Anfang): Z gilt über dem Anfang des Kegels
            if tx.is_some() || ty.is_some() {
                x = tx;
                y = ty;
            }
            out.push(format!("G{} Z{}{tail}", js_num(motion), n4(tz + tx.map_or(0.0, |tx| cone_radius(stock, tx) - r0))));
            z = tz;
            continue;
        };
        let (sx, sy, sz) = (x.unwrap_or(tx), y.unwrap_or(ty), z);
        let pts: Vec<[f64; 3]> = if motion == 2.0 || motion == 3.0 {
            if plane != 17.0 {
                return Err(("plane", li + 1));
            }
            match arc_points(sx, sy, tx, ty, motion == 2.0, w.get('I'), w.get('J'), w.get('R'), SEG) {
                Some(a) => a,
                None => return Err(("arc", li + 1)),
            }
        } else if motion == 0.0 || (tx - sx).abs() < 1e-9 {
            vec![[tx, ty, 1.0]]
        } else {
            let n = mx(1.0, hypot2(tx - sx, ty - sy).ceil());
            (0..if n.is_nan() { 0 } else { n as usize })
                .map(|k| {
                    let u = (k as f64 + 1.0) / n;
                    [sx + (tx - sx) * u, sy + (ty - sy) * u, u]
                })
                .collect()
        };
        let (mut px, mut py, mut pz) = (sx, sy, sz);
        let g = if motion == 0.0 { 0 } else { 1 };
        for (k, p) in pts.iter().enumerate() {
            let (qx, qy, u) = (p[0], p[1], p[2]);
            let qz = sz + (tz - sz) * u;
            let (rq, rp) = (cone_radius(stock, qx), cone_radius(stock, px));
            let zm = qz + rq - r0;
            let mut fw = String::new();
            if let Some(feed) = feed.filter(|_| g == 1) {
                let zm_p = pz + rp - r0;
                let d_t = turn(qy, qx) - turn(py, px);
                let k_cut = if o.depth_feed { mx(0.05, (rq + mn(0.0, qz)) / rq) } else { 1.0 };
                let (surf, mach) = (hypot3(qx - px, (qy - py) * k_cut, qz - pz), hypot3(qx - px, d_t, zm - zm_p));
                let f = mx(1.0, js_round(if surf > 1e-9 { feed * (mach / surf) } else { feed }));
                if sent_f != Some(f) {
                    sent_f = Some(f);
                    fw = format!(" F{}", js_num(f));
                }
            }
            out.push(format!("G{g} X{} {yw}{} Z{}{fw}{}", n4(qx), n4(turn(qy, qx)), n4(zm), if k == 0 { tail.as_str() } else { "" }));
            px = qx;
            py = qy;
            pz = qz;
        }
        x = Some(tx);
        y = Some(ty);
        z = tz;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn lines(s: &[&str]) -> Vec<String> {
        s.iter().map(|l| l.to_string()).collect()
    }
    fn round(axis: &str, dia: f64) -> Options {
        Options { axis: axis.into(), drive_dia: dia, part_dia: dia, mm_per_rot: Some(100.0), ..Default::default() }
    }

    /// von Hand: Ø 100/π → Umfang 100 mm. Y 50 = halbe Umdrehung = A 180; am Y-Anschluss mit 100 mm je Umdrehung Y 50.
    /// Der Vorschub 600 auf der Oberfläche: 50 mm Weg sind 180 „Grad-Einheiten“ → F 600 · 180/50 = 2160.
    #[test]
    fn y_becomes_degrees_and_the_feed_follows() {
        let d = 100.0 / std::f64::consts::PI;
        let src = lines(&["G90", "G0 X0 Y0", "G1 Y50 F600 (cut)", "G1 X10 Y50"]);
        let a = wrap_gcode(&src, &round("a", d)).unwrap();
        assert_eq!(a, ["G90", "G0 X0 A0", "G1 A180 F2160 (cut)", "G1 X10 A180 F600"]);
        let y = wrap_gcode(&src, &round("y", d)).unwrap();
        assert_eq!(y, ["G90", "G0 X0 Y0", "G1 Y50 F600 (cut)", "G1 X10 Y50"]);
    }

    #[test]
    fn what_cannot_be_converted_is_refused_with_its_line() {
        let o = round("a", 30.0);
        assert_eq!(wrap_gcode(&lines(&["G90", "G20"]), &o), Err(("inch", 2)));
        assert_eq!(wrap_gcode(&lines(&["G91", "G1 X5"]), &o), Err(("relative", 2)));
        assert_eq!(wrap_gcode(&lines(&["G92 X0"]), &o), Err(("offset", 1)));
        assert_eq!(wrap_gcode(&lines(&["G0 X0 Y0", "G18", "G2 X5 Y5 I5"]), &o), Err(("plane", 3)));
        assert_eq!(wrap_gcode(&lines(&["G2 X5 Y5 I5"]), &o), Err(("arc", 1)));
    }

    #[test]
    fn text_patterns() {
        let c = |s: &str| chars(s);
        assert_eq!(remove_feed(&c("G1 X5 F100 (f200) Y2F3")).iter().collect::<String>(), "G1 X5 (f200) Y2");
        assert_eq!(remove_feed(&c("G1 XF5 F.5")).iter().collect::<String>(), "G1 XF5");
        assert_eq!(tail_comment(&c("G1 X5 (a) (b) ")), Some(9));
        assert_eq!(tail_comment(&c("G1 X5 ; c\r")), Some(5));
        assert_eq!(tail_comment(&c("G1 X5 ; c\rx")), None);
        assert_eq!(code_of(&c("g1 (a) x5 ; y6")).iter().collect::<String>(), "G1   X5 ");
        assert_eq!(code_of(&c("g1 ; y6\r")).iter().collect::<String>(), "G1 ; Y6\r");
        assert_eq!(replace_words(&c("X1 (Y2) y3 GY4 ;Y5"), "Y", true, |_, v| Some(format!("A{v}"))), "X1 (Y2) A3 GY4 ;Y5");
        assert_eq!(replace_words(&c("y3 ;Y5"), "Y", false, |_, v| Some(format!("A{v}"))), "A3 ;A5");
        assert_eq!((n4(0.00004), n4(-0.00004), n4(1.23456), n4(-2.0), n3(0.0004), n3(1.0005)), ("0".into(), "0".into(), "1.2346".into(), "-2".into(), "0".into(), "1".into()));
    }

    /// Dieselben Fälle wie tests/rotaryWrapRust.test.ts: jede Zeile genau wie im TypeScript, auch die Bogen-Stücke
    /// (dort stecken Sinus/Kosinus drin – gemessen weicht auf diesem Rechner keine einzige Zahl ab). Sollte auf einem
    /// anderen Rechner eine letzte Stelle anders gerundet sein, ist das ein Befund und kein Fall für eine Toleranz hier:
    /// die App nimmt in so einem Fall ohnehin das Ergebnis aus dem TypeScript (nearLines in camPost.ts).
    #[test]
    fn same_result_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let read = |name: &str| -> Value { serde_json::from_reader(flate2::read::GzDecoder::new(std::fs::File::open(dir.join(name)).unwrap())).unwrap() };
        let (cases, expected) = (read("rotarywrap-cases.json.gz"), read("rotarywrap-expected.json.gz"));
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 60, "only {} cases", cases.len());
        let (mut total, mut refused) = (0usize, 0usize);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let src: Vec<String> = c["gcode"].as_array().unwrap().iter().map(|l| l.as_str().unwrap().to_string()).collect();
            let want = &expected[name];
            assert!(want.is_object(), "{name}: no expected result");
            // der Auftrag, wie das Fenster ihn schickt (wrapJob in rotaryRust.ts)
            let o: Options = serde_json::from_value(want["job"].clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
            match wrap_gcode(&src, &o) {
                Err((error, line)) => {
                    assert_eq!(want["ok"], Value::Bool(false), "{name}: Rust refuses ({error}, line {line}), TypeScript does not");
                    assert_eq!((want["error"].as_str().unwrap(), want["line"].as_u64().unwrap() as usize), (error, line), "{name}");
                    refused += 1;
                }
                Ok(got) => {
                    assert_eq!(want["ok"], Value::Bool(true), "{name}: TypeScript refuses ({}), Rust does not", want["error"]);
                    let want: Vec<&str> = want["lines"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
                    for (k, (a, b)) in got.iter().zip(&want).enumerate() {
                        assert!(a == b, "{name}: line {}\n  Rust:       {a}\n  TypeScript: {b}", k + 1);
                    }
                    assert_eq!(got.len(), want.len(), "{name}: number of lines");
                    total += want.len();
                }
            }
        }
        println!("{} cases, {total} G-code lines the same as rotaryWrap.ts, {refused} programs refused by both", cases.len());
    }}
