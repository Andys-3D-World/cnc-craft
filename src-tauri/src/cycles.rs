//! Bohrzyklen (G73, G74, G81–G85, G89) in einfache G0/G1-Bewegungen umwandeln
//!
//! GRBL (und Marlin) kennen keine Bohrzyklen – G-Code aus Fusion 360 & Co. bricht dort mit
//! „error:20“ ab. Vor dem Senden wandelt expand() die Zyklen deshalb in G0/G1/G4 um.
//! Jede neue Zeile merkt sich ihre Original-Zeile (`origin`), damit Fortschritt, „Fortsetzen ab“
//! und Live-Bearbeitung in der Oberfläche weiter auf die geladene Datei zeigen.
//!
//! Regeln (wie LinuxCNC/RS274NGC):
//!   - nur absolute Koordinaten (G90); G91-Zyklen werden abgelehnt
//!   - R (Rückzugsebene) und Z (Bohrtiefe) bleiben gültig, bis G80 oder eine andere Bewegungsart kommt
//!   - G98 = zurück auf die Starthöhe (höchstens bis R herunter), G99 = zurück auf R
//!   - eine Zeile mit X/Y/Z bohrt im aktiven Zyklus das nächste Loch
//!   - P (Verweilzeit) in Sekunden wie bei G4; Werte über 60 s sehen nach Millisekunden aus -> abgelehnt
//!   - G84/G74 (Gewindebohren): GRBL kann die Spindel nicht mit dem Vorschub koppeln – nur mit
//!     Ausgleichsfutter (Längenausgleich)! Unten wird die Drehrichtung umgeschaltet (M4/M3)

use serde::Serialize;

#[derive(Clone, Debug)]
struct Word {
    letter: char,
    text: String,
    val: f64,
}

/// Zeile in Wörter zerlegen (Kommentare in Klammern und nach ';' fallen weg)
fn parse(line: &str) -> Vec<Word> {
    let mut out = Vec::new();
    let mut chars = line.chars().peekable();
    let mut depth = 0;
    while let Some(c) = chars.next() {
        if c == '(' { depth += 1; continue; }
        if c == ')' { depth = (depth - 1).max(0); continue; }
        if depth > 0 { continue; }
        if c == ';' { break; }
        if !c.is_ascii_alphabetic() { continue; }
        let mut num = String::new();
        while let Some(&d) = chars.peek() {
            if d.is_ascii_digit() || d == '.' || d == '-' || d == '+' || d == ' ' {
                if d != ' ' { num.push(d); }
                chars.next();
            } else {
                break;
            }
        }
        let val = num.parse::<f64>().unwrap_or(f64::NAN);
        out.push(Word { letter: c.to_ascii_uppercase(), text: num, val });
    }
    out
}

/// G-Nummer mal 10 (G38.2 -> 382), damit sie sich als Ganzzahl vergleichen lässt
fn g10(w: &Word) -> Option<i32> {
    if w.letter == 'G' && w.val.is_finite() { Some((w.val * 10.0).round() as i32) } else { None }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Cycle {
    G73,
    G74,
    G81,
    G82,
    G83,
    G84,
    G85,
    G89,
}

fn cycle_of(g: i32) -> Option<Cycle> {
    match g {
        730 => Some(Cycle::G73),
        740 => Some(Cycle::G74),
        810 => Some(Cycle::G81),
        820 => Some(Cycle::G82),
        830 => Some(Cycle::G83),
        840 => Some(Cycle::G84),
        850 => Some(Cycle::G85),
        890 => Some(Cycle::G89),
        _ => None,
    }
}

/// Zyklen, die es gibt, die hier aber nicht umgewandelt werden (Spindel-Ausrichtung, Rückwärts-Senken …)
fn unsupported_cycle(g: i32) -> bool { matches!(g, 760 | 860 | 870 | 880) }

struct State {
    abs: bool,
    inch: bool,
    /// Position in Werkstück-Koordinaten (None = unbekannt, z. B. nach G28/G53)
    pos: [Option<f64>; 3],
    cycle: Option<Cycle>,
    retract_initial: bool,
    feed: Option<f64>,
    r: Option<f64>,
    z: Option<f64>,
    q: Option<f64>,
    p: Option<f64>,
}

impl State {
    fn reset_cycle(&mut self) {
        self.cycle = None;
        self.r = None;
        self.z = None;
        self.q = None;
        self.p = None;
    }
}

/// Zahl kurz ausgeben: höchstens 4 Nachkommastellen, ohne Nullen am Ende
fn f(v: f64) -> String {
    let s = format!("{:.4}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" || s.is_empty() { "0".into() } else { s.to_string() }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Expanded {
    pub lines: Vec<String>,
    /// je neue Zeile: Index der Original-Zeile
    pub origin: Vec<usize>,
    /// so viele Löcher wurden umgewandelt (0 = nichts zu tun)
    pub holes: usize,
    /// davon Gewindebohrungen (G84/G74) – Hinweis auf das Ausgleichsfutter
    pub taps: usize,
    /// Zeilen geändert (Zyklen oder entfernte G98/G99)?
    pub changed: bool,
}

/// Fehler: "Zeilenindex:Grund" (Grund = Schlüssel für die Übersetzung, z. B. "noQ")
fn err(i: usize, why: &str) -> String { format!("{}:{}", i, why) }

/// Ein Loch an (x, y) bohren – Ergebnis sind G0/G1/G4/M-Zeilen
fn hole(c: Cycle, x: Option<f64>, y: Option<f64>, st: &mut State) -> Result<Vec<String>, &'static str> {
    let r = st.r.ok_or("noR")?;
    let zb = st.z.ok_or("noZ")?;
    if zb > r { return Err("rBelowZ"); }
    let feed = st.feed.filter(|v| *v > 0.0).ok_or("noF")?;
    let p = st.p.unwrap_or(0.0);
    if !(0.0..=60.0).contains(&p) { return Err("dwellMs"); }
    let zi = st.pos[2];
    let ret = if st.retract_initial { zi.ok_or("unknownZ")?.max(r) } else { r };
    let clear = if st.inch { 0.01 } else { 0.25 };

    let mut out = Vec::new();
    let mut cz = zi;
    let rapid_z = |out: &mut Vec<String>, z: f64, cz: &mut Option<f64>| {
        if *cz != Some(z) { out.push(format!("G0 Z{}", f(z))); *cz = Some(z); }
    };
    let feed_z = |out: &mut Vec<String>, z: f64, cz: &mut Option<f64>| {
        out.push(format!("G1 Z{} F{}", f(z), f(feed)));
        *cz = Some(z);
    };
    // Höhe unbekannt oder unter R: erst auf R hoch, dann seitlich fahren
    if cz.is_none_or(|z| z < r) { rapid_z(&mut out, r, &mut cz); }
    if x.is_some() || y.is_some() {
        let mut l = String::from("G0");
        if let Some(x) = x { l += &format!(" X{}", f(x)); }
        if let Some(y) = y { l += &format!(" Y{}", f(y)); }
        out.push(l);
    }
    rapid_z(&mut out, r, &mut cz);
    let dwell = |out: &mut Vec<String>| if p > 0.0 { out.push(format!("G4 P{}", f(p))); };
    match c {
        Cycle::G81 => feed_z(&mut out, zb, &mut cz),
        Cycle::G82 => { feed_z(&mut out, zb, &mut cz); dwell(&mut out); }
        Cycle::G83 | Cycle::G73 => {
            let q = st.q.filter(|v| *v > 0.0).ok_or("noQ")?;
            let mut depth = r;
            loop {
                let next = (depth - q).max(zb);
                if depth < r { rapid_z(&mut out, depth + clear, &mut cz); }
                feed_z(&mut out, next, &mut cz);
                depth = next;
                if depth <= zb + 1e-9 { break; }
                if c == Cycle::G83 {
                    rapid_z(&mut out, r, &mut cz); // ganz heraus: Späne aus dem Loch
                } else {
                    rapid_z(&mut out, depth + clear, &mut cz); // nur kurz zurück: Span brechen
                }
                if out.len() > 10_000 { return Err("noQ"); } // Q winzig: lieber ablehnen
            }
        }
        Cycle::G84 | Cycle::G74 => {
            // Rechtsgewinde: rechts hinein, unten links herum wieder heraus (G74 umgekehrt)
            let (back, fwd) = if c == Cycle::G84 { ("M4", "M3") } else { ("M3", "M4") };
            feed_z(&mut out, zb, &mut cz);
            dwell(&mut out);
            out.push(back.into());
            feed_z(&mut out, r, &mut cz);
            out.push(fwd.into());
        }
        Cycle::G85 => { feed_z(&mut out, zb, &mut cz); feed_z(&mut out, r, &mut cz); }
        Cycle::G89 => { feed_z(&mut out, zb, &mut cz); dwell(&mut out); feed_z(&mut out, r, &mut cz); }
    }
    rapid_z(&mut out, ret, &mut cz);
    if let Some(x) = x { st.pos[0] = Some(x); }
    if let Some(y) = y { st.pos[1] = Some(y); }
    st.pos[2] = Some(ret);
    Ok(out)
}

/// Wörter wieder zu einer Zeile zusammensetzen
fn join(words: &[&Word]) -> String {
    words.iter().map(|w| format!("{}{}", w.letter, w.text)).collect::<Vec<_>>().join(" ")
}

pub fn expand(lines: &[String]) -> Result<Expanded, String> {
    let mut st = State {
        abs: true, inch: false, pos: [None; 3], cycle: None, retract_initial: true,
        feed: None, r: None, z: None, q: None, p: None,
    };
    let mut out = Expanded { lines: Vec::with_capacity(lines.len()), origin: Vec::with_capacity(lines.len()), holes: 0, taps: 0, changed: false };
    for (i, line) in lines.iter().enumerate() {
        let words = parse(line);
        let mut new_cycle: Option<Cycle> = None;
        let mut other_motion = false;
        let mut has_retract_mode = false;
        // Positionen ändern sich auf eine Art, die hier nicht nachgerechnet wird
        let mut lose_all = false;
        let mut machine_coords = false;
        let mut set_coords = false;
        for w in &words {
            match w.letter {
                'G' => {
                    let g = g10(w).unwrap_or(-1);
                    if let Some(c) = cycle_of(g) { new_cycle = Some(c); continue; }
                    if unsupported_cycle(g) { return Err(err(i, &format!("unsupported G{}", w.text))); }
                    match g {
                        0 | 10 | 20 | 30 | 800 => other_motion = true,
                        900 => st.abs = true,
                        910 => st.abs = false,
                        200 => st.inch = true,
                        210 => st.inch = false,
                        980 => { st.retract_initial = true; has_retract_mode = true; }
                        990 => { st.retract_initial = false; has_retract_mode = true; }
                        280 | 300 | 100 | 540..=590 => lose_all = true,
                        382..=385 => { other_motion = true; lose_all = true; }
                        530 => machine_coords = true,
                        920 => set_coords = true,
                        _ => {}
                    }
                }
                'F' if w.val.is_finite() => st.feed = Some(w.val),
                _ => {}
            }
        }
        let axis = |l: char| words.iter().find(|w| w.letter == l).map(|w| w.val).filter(|v| v.is_finite());
        let (ax, ay, az) = (axis('X'), axis('Y'), axis('Z'));
        if other_motion { st.reset_cycle(); }
        if let Some(c) = new_cycle { st.cycle = Some(c); }

        if let Some(c) = st.cycle.filter(|_| ax.is_some() || ay.is_some() || az.is_some()) {
            if !st.abs { return Err(err(i, "incremental")); }
            if let Some(v) = axis('R') { st.r = Some(v); }
            if let Some(v) = az { st.z = Some(v); }
            if let Some(v) = axis('Q') { st.q = Some(v.abs()); }
            if let Some(v) = axis('P') { st.p = Some(v); }
            // alles andere auf der Zeile (G90, S, M8 …) vorher als eigene Zeile senden
            let rest: Vec<&Word> = words.iter().filter(|w| {
                let g = g10(w).unwrap_or(-1);
                !(matches!(w.letter, 'X' | 'Y' | 'Z' | 'R' | 'Q' | 'P' | 'L' | 'N')
                    || (w.letter == 'G' && (cycle_of(g).is_some() || g == 980 || g == 990)))
            }).collect();
            if !rest.is_empty() { out.lines.push(join(&rest)); out.origin.push(i); }
            let moves = hole(c, ax, ay, &mut st).map_err(|why| err(i, why))?;
            if matches!(c, Cycle::G84 | Cycle::G74) { out.taps += 1; }
            out.holes += 1;
            out.changed = true;
            for m in moves { out.lines.push(m); out.origin.push(i); }
            continue;
        }

        // keine Bohrung: Zeile bleibt, nur G98/G99 (kennt GRBL nicht) und Zyklus-Codes ohne Achsen fallen weg
        if has_retract_mode || new_cycle.is_some() {
            let keep: Vec<&Word> = words.iter().filter(|w| {
                let g = g10(w).unwrap_or(-1);
                !(w.letter == 'G' && (cycle_of(g).is_some() || g == 980 || g == 990))
                    && !(new_cycle.is_some() && matches!(w.letter, 'R' | 'Q' | 'P' | 'L'))
            }).collect();
            if new_cycle.is_some() {
                // Zyklus ohne Loch auf dieser Zeile: Werte für die nächsten Zeilen merken
                if let Some(v) = axis('R') { st.r = Some(v); }
                if let Some(v) = axis('Q') { st.q = Some(v.abs()); }
                if let Some(v) = axis('P') { st.p = Some(v); }
            }
            out.changed = true;
            if !keep.is_empty() { out.lines.push(join(&keep)); out.origin.push(i); }
        } else {
            out.lines.push(line.clone());
            out.origin.push(i);
        }
        // Position nachführen
        if lose_all {
            st.pos = [None; 3];
        } else if machine_coords {
            for (k, v) in [ax, ay, az].iter().enumerate() { if v.is_some() { st.pos[k] = None; } }
        } else if set_coords {
            for (k, v) in [ax, ay, az].iter().enumerate() { if let Some(v) = v { st.pos[k] = Some(*v); } }
        } else {
            for (k, v) in [ax, ay, az].iter().enumerate() {
                if let Some(v) = v {
                    st.pos[k] = if st.abs { Some(*v) } else { st.pos[k].map(|p| p + v) };
                }
            }
        }
    }
    Ok(out)
}

/// Für die Oberfläche: Zyklen vor dem Job-Start umwandeln. Fehler: "Zeilenindex:Grund"
#[tauri::command]
pub async fn gcode_expand_cycles(lines: Vec<String>) -> Result<Expanded, String> {
    tauri::async_runtime::spawn_blocking(move || expand(&lines)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(src: &str) -> Expanded {
        expand(&src.lines().map(String::from).collect::<Vec<_>>()).unwrap()
    }
    fn fail(src: &str) -> String {
        expand(&src.lines().map(String::from).collect::<Vec<_>>()).unwrap_err()
    }

    #[test]
    fn program_without_cycles_stays_the_same() {
        let src = "G21 G90\nG0 Z5\nG1 X10 Y10 F300\nG2 X20 Y0 I5 J0\nM5";
        let e = run(src);
        assert_eq!(e.lines, src.lines().map(String::from).collect::<Vec<_>>());
        assert_eq!(e.origin, vec![0, 1, 2, 3, 4]);
        assert!(!e.changed);
        assert_eq!(e.holes, 0);
    }

    #[test]
    fn g81_with_g98_returns_to_start_height() {
        let e = run("G90 G21\nG0 Z10\nG98 G81 X5 Y6 Z-3 R2 F100\nX15\nG80\nG0 Z20");
        assert_eq!(e.lines, vec![
            "G90 G21", "G0 Z10",
            "F100", "G0 X5 Y6", "G0 Z2", "G1 Z-3 F100", "G0 Z10",
            "G0 X15", "G0 Z2", "G1 Z-3 F100", "G0 Z10",
            "G80", "G0 Z20",
        ]);
        assert_eq!(e.origin, vec![0, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 4, 5]);
        assert_eq!(e.holes, 2);
    }

    #[test]
    fn g99_returns_to_r_plane() {
        let e = run("G0 Z10\nG99 G81 X0 Y0 Z-2 R1 F50\nY10");
        assert_eq!(e.lines, vec!["G0 Z10", "F50", "G0 X0 Y0", "G0 Z1", "G1 Z-2 F50", "G0 Z1", "G0 Y10", "G1 Z-2 F50", "G0 Z1"]);
    }

    #[test]
    fn starts_below_r_goes_up_first() {
        let e = run("G0 Z0.5\nG99 G81 X3 Y4 Z-1 R2 F80");
        assert_eq!(&e.lines[1..], &["F80", "G0 Z2", "G0 X3 Y4", "G1 Z-1 F80", "G0 Z2"]);
    }

    #[test]
    fn g82_dwells() {
        let e = run("G0 Z5\nG82 X1 Y1 Z-2 R1 P0.5 F60");
        assert!(e.lines.contains(&"G4 P0.5".to_string()));
        assert_eq!(e.lines.last().unwrap(), "G0 Z5");
    }

    #[test]
    fn g83_full_retract_pecks() {
        let e = run("G0 Z5\nG83 X0 Y0 Z-5 R1 Q2 F100");
        assert_eq!(&e.lines[1..], &[
            "F100", "G0 X0 Y0", "G0 Z1",
            "G1 Z-1 F100", "G0 Z1",
            "G0 Z-0.75", "G1 Z-3 F100", "G0 Z1",
            "G0 Z-2.75", "G1 Z-5 F100",
            "G0 Z5",
        ]);
    }

    #[test]
    fn g73_chip_break_pecks() {
        let e = run("G0 Z5\nG73 X0 Y0 Z-4 R0 Q2 F100");
        assert_eq!(&e.lines[1..], &["F100", "G0 X0 Y0", "G0 Z0", "G1 Z-2 F100", "G0 Z-1.75", "G1 Z-4 F100", "G0 Z5"]);
    }

    #[test]
    fn g84_reverses_spindle_at_bottom() {
        let e = run("M3 S500\nG0 Z5\nG84 X0 Y0 Z-6 R2 F400");
        assert_eq!(&e.lines[2..], &["F400", "G0 X0 Y0", "G0 Z2", "G1 Z-6 F400", "M4", "G1 Z2 F400", "M3", "G0 Z5"]);
        assert_eq!(e.taps, 1);
        let l = run("M4 S500\nG0 Z5\nG74 X0 Y0 Z-6 R2 F400");
        assert!(l.lines.contains(&"M3".to_string()) && l.lines.last().unwrap() == "G0 Z5");
    }

    #[test]
    fn g85_and_g89_feed_out() {
        let e = run("G0 Z5\nG85 X0 Y0 Z-2 R1 F30");
        assert_eq!(&e.lines[3..], &["G0 Z1", "G1 Z-2 F30", "G1 Z1 F30", "G0 Z5"]);
        let e = run("G0 Z5\nG89 X0 Y0 Z-2 R1 P1 F30");
        assert!(e.lines.contains(&"G4 P1".to_string()));
    }

    #[test]
    fn other_words_on_the_cycle_line_are_kept() {
        let e = run("G0 Z5\nN20 G90 G98 G81 X1 Y2 Z-1 R1 F99 S8000 M8 (bohren)");
        assert_eq!(e.lines[1], "G90 F99 S8000 M8");
        assert!(!e.lines.iter().any(|l| l.contains("G98") || l.contains("G81") || l.contains("N20")));
    }

    #[test]
    fn g98_alone_is_removed() {
        let e = run("G0 Z5\nG98\nG0 X1");
        assert_eq!(e.lines, vec!["G0 Z5", "G0 X1"]);
        assert_eq!(e.origin, vec![0, 2]);
        assert!(e.changed);
    }

    #[test]
    fn cycle_params_on_line_without_hole_are_remembered() {
        let e = run("G0 Z5\nG99 G83 R1 Q1 F50\nX0 Y0 Z-2");
        assert_eq!(e.holes, 1);
        assert!(e.lines.contains(&"G1 Z-2 F50".to_string()));
    }

    #[test]
    fn errors() {
        assert!(fail("G91\nG0 Z5\nG81 X1 Y1 Z-1 R1 F10").ends_with(":incremental"));
        assert!(fail("G0 Z5\nG81 X1 Y1 Z-1 F10").ends_with(":noR"));
        assert!(fail("G0 Z5\nG81 X1 Y1 R1 F10").ends_with(":noZ"));
        assert!(fail("G0 Z5\nG81 X1 Y1 Z2 R1 F10").ends_with(":rBelowZ"));
        assert!(fail("G0 Z5\nG83 X1 Y1 Z-2 R1 F10").ends_with(":noQ"));
        assert!(fail("G0 Z5\nG81 X1 Y1 Z-2 R1").ends_with(":noF"));
        assert!(fail("G0 Z5\nG82 X1 Y1 Z-2 R1 P500 F10").ends_with(":dwellMs"));
        assert_eq!(fail("G28\nG98 G81 X1 Y1 Z-2 R1 F10"), "1:unknownZ");
        assert!(fail("G0 Z5\nG76 X1 Z-2").ends_with(":unsupported G76"));
        // G99 geht auch ohne bekannte Höhe (erst auf R, dann seitlich)
        assert!(run("G28\nG99 G81 X1 Y1 Z-2 R1 F10").lines.starts_with(&["G28".to_string(), "F10".into(), "G0 Z1".into(), "G0 X1 Y1".into()]));
    }

    #[test]
    fn g0_after_cycle_ends_it() {
        let e = run("G0 Z5\nG81 X0 Y0 Z-1 R1 F10\nG0 X50\nY20");
        assert_eq!(e.holes, 1);
        assert_eq!(&e.lines[e.lines.len() - 2..], &["G0 X50", "Y20"]);
    }

    #[test]
    fn numbers_are_short() {
        assert_eq!(f(1.0), "1");
        assert_eq!(f(-0.25), "-0.25");
        assert_eq!(f(-0.00001), "0");
        assert_eq!(f(12.345678), "12.3457");
    }
}
