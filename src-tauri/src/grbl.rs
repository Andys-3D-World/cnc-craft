//! GRBL-PROTOKOLL (ohne Hardware – reine Logik, mit Tests)
//!
//! Gilt für GRBL 1.1, grblHAL, Grbl_ESP32, FluidNC und die MKS-/China-Boards (DLC32 usw.),
//! die alle dasselbe Protokoll sprechen:
//!   - jede gesendete Zeile wird mit "ok" oder "error:N" beantwortet
//!   - "?" (ohne Zeilenende) liefert sofort einen Statusbericht "<Idle|MPos:...|...>"
//!   - "!" "~" Strg-X usw. sind Echtzeit-Befehle (ein Byte, ohne "ok")
//!   - der Empfangspuffer des Boards ist klein (GRBL: 128 Zeichen). Damit er nie überläuft,
//!     zählen wir die Zeichen aller noch nicht bestätigten Zeilen ("character counting").

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Statusbericht, z. B. `<Run|MPos:10.000,5.000,-1.000|FS:1200,12000|Bf:15,128|Ov:100,100,100|WCO:0,0,0>`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Status {
    pub state: String,            // Idle, Run, Hold, Jog, Alarm, Door, Check, Home, Sleep
    pub sub: Option<i32>,         // z. B. Hold:0 = Anhalten fertig, Hold:1 = bremst noch
    pub mpos: Option<[f64; 3]>,   // Maschinenposition
    pub wpos: Option<[f64; 3]>,   // Werkstückposition
    pub wco: Option<[f64; 3]>,    // Versatz Werkstück <-> Maschine
    pub feed: Option<f64>,
    pub spindle: Option<f64>,
    pub planner: Option<i32>,     // freie Plätze im Bewegungsplaner
    pub rx: Option<i32>,          // freie Zeichen im Empfangspuffer
    pub ov: Option<[i32; 3]>,     // Overrides: Vorschub, Eilgang, Spindel in %
    pub pins: Option<String>,     // ausgelöste Eingänge: X Y Z = Endschalter, P = Taster, D = Tür …
    pub line: Option<i64>,
    /// Zubehör "A:" – S = Spindel rechts, C = links, F = Kühlung (Flood, M8), M = Nebel (M7).
    /// GRBL schickt das Feld nur zusammen mit "Ov:" und lässt es weg, wenn alles aus ist:
    /// None = diesmal nicht gemeldet, Some("") = alles aus.
    pub acc: Option<String>,
}

fn parse_xyz(s: &str) -> Option<[f64; 3]> {
    let v: Vec<f64> = s.split(',').filter_map(|x| x.trim().parse::<f64>().ok()).collect();
    if v.len() >= 3 { Some([v[0], v[1], v[2]]) } else if v.len() == 2 { Some([v[0], v[1], 0.0]) } else { None }
}

pub fn parse_status(line: &str) -> Option<Status> {
    let l = line.trim();
    if !l.starts_with('<') || !l.ends_with('>') { return None; }
    let inner = &l[1..l.len() - 1];
    // GRBL 1.1 trennt mit '|', die alte 0.9 mit ','
    let mut parts = inner.split('|');
    let first = parts.next()?;
    let mut st = Status::default();
    let mut state_parts = first.splitn(2, ':');
    st.state = state_parts.next().unwrap_or("").to_string();
    st.sub = state_parts.next().and_then(|x| x.trim().parse::<i32>().ok());
    for p in parts {
        let mut kv = p.splitn(2, ':');
        let k = kv.next().unwrap_or("");
        let v = kv.next().unwrap_or("");
        match k {
            "MPos" => st.mpos = parse_xyz(v),
            "WPos" => st.wpos = parse_xyz(v),
            "WCO" => st.wco = parse_xyz(v),
            "FS" => {
                let mut it = v.split(',');
                st.feed = it.next().and_then(|x| x.parse().ok());
                st.spindle = it.next().and_then(|x| x.parse().ok());
            }
            "F" => st.feed = v.parse().ok(),
            "Bf" => {
                let mut it = v.split(',');
                st.planner = it.next().and_then(|x| x.parse().ok());
                st.rx = it.next().and_then(|x| x.parse().ok());
            }
            "Ov" => {
                let v: Vec<i32> = v.split(',').filter_map(|x| x.parse().ok()).collect();
                if v.len() >= 3 { st.ov = Some([v[0], v[1], v[2]]); }
            }
            "Pn" => st.pins = Some(v.to_string()),
            "Ln" => st.line = v.parse().ok(),
            "A" => st.acc = Some(v.to_string()),
            _ => {}
        }
    }
    if st.ov.is_some() && st.acc.is_none() { st.acc = Some(String::new()); }
    Some(st)
}

/// Welche Firmware hat sich gemeldet?
#[derive(Debug, Clone, PartialEq)]
pub struct Welcome {
    pub firmware: String, // "GRBL", "grblHAL", "FluidNC", "Grbl_ESP32", "Marlin", "Smoothieware"
    pub version: String,
    pub raw: String,
}

pub fn parse_welcome(line: &str) -> Option<Welcome> {
    let l = line.trim();
    let lower = l.to_lowercase();
    let raw = l.to_string();
    if lower.contains("fluidnc") {
        let ver = l.split_whitespace().skip_while(|w| !w.contains("FluidNC")).nth(1).unwrap_or("").trim_matches(|c| c == ']' || c == '\'' || c == '(').to_string();
        return Some(Welcome { firmware: "FluidNC".into(), version: ver, raw });
    }
    if lower.starts_with("grblhal") {
        let ver = l.split_whitespace().nth(1).unwrap_or("").to_string();
        return Some(Welcome { firmware: "grblHAL".into(), version: ver, raw });
    }
    if lower.starts_with("grbl ") || lower.starts_with("grbl\t") {
        let ver = l.split_whitespace().nth(1).unwrap_or("").to_string();
        // Grbl_ESP32 meldet sich als "Grbl 1.3a"
        let fw = if ver.starts_with("1.3") { "Grbl_ESP32" } else { "GRBL" };
        return Some(Welcome { firmware: fw.into(), version: ver, raw });
    }
    if lower.contains("marlin") && (lower.starts_with("echo:") || lower.starts_with("start") || lower.contains("marlin ")) {
        return Some(Welcome { firmware: "Marlin".into(), version: String::new(), raw });
    }
    if lower.contains("smoothie") {
        return Some(Welcome { firmware: "Smoothieware".into(), version: String::new(), raw });
    }
    None
}

/// Einordnung einer empfangenen Zeile
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Ok,
    Error(i32),
    Alarm(i32),
    Status(Status),
    Welcome(Welcome),
    Setting(String, String), // "$110", "5000.000"
    Opt(usize),              // [OPT:...,15,128] -> Empfangspuffer-Größe
    Msg(String),             // [MSG:...], [GC:...], [VER:...] usw.
    Text(String),
}

pub fn classify(line: &str) -> Incoming {
    let l = line.trim();
    if l == "ok" { return Incoming::Ok; }
    if let Some(rest) = l.strip_prefix("error:") {
        return Incoming::Error(rest.trim().parse().unwrap_or(-1));
    }
    if l.starts_with("error") { return Incoming::Error(-1); }
    if let Some(rest) = l.strip_prefix("ALARM:") {
        return Incoming::Alarm(rest.trim().parse().unwrap_or(-1));
    }
    if let Some(st) = parse_status(l) { return Incoming::Status(st); }
    if let Some(w) = parse_welcome(l) { return Incoming::Welcome(w); }
    if l.starts_with("[OPT:") {
        if let Some(n) = parse_opt_rx(l) { return Incoming::Opt(n); }
        return Incoming::Msg(l.to_string());
    }
    if l.starts_with('$') {
        if let Some(eq) = l.find('=') {
            let key = l[..eq].trim().to_string();
            if key.len() > 1 && key[1..].chars().all(|c| c.is_ascii_digit()) {
                return Incoming::Setting(key, l[eq + 1..].trim().to_string());
            }
        }
    }
    if l.starts_with('[') { return Incoming::Msg(l.to_string()); }
    Incoming::Text(l.to_string())
}

/// `[OPT:VL,15,128]` -> 128 (Empfangspuffer). Unplausible Werte werden ignoriert.
pub fn parse_opt_rx(line: &str) -> Option<usize> {
    let inner = line.trim().strip_prefix("[OPT:")?.strip_suffix(']')?;
    let parts: Vec<&str> = inner.split(',').collect();
    if parts.len() < 3 { return None; }
    let rx: usize = parts[2].trim().parse().ok()?;
    if (64..=16384).contains(&rx) { Some(rx) } else { None }
}

/// Zeile fürs Senden vorbereiten: Kommentare und überflüssige Leerzeichen weg.
/// Gibt None zurück, wenn nichts übrig bleibt.
pub fn clean_line(line: &str) -> Option<String> {
    let mut out = String::with_capacity(line.len());
    let mut in_paren = false;
    for ch in line.chars() {
        match ch {
            '(' => in_paren = true,
            ')' if in_paren => in_paren = false,
            ';' if !in_paren => break,
            '%' if !in_paren => {}
            c if !in_paren => out.push(c),
            _ => {}
        }
    }
    let t = out.trim();
    if t.is_empty() { return None; }
    // Mehrfache Leerzeichen zusammenfassen (spart Puffer)
    let compact: Vec<&str> = t.split_whitespace().collect();
    Some(compact.join(" "))
}

/// Werkzeugwechsel-Pause im Programm (M0 / M1 – wird von CNC Craft selbst angehalten)
pub fn is_tool_change(cleaned: &str) -> bool {
    let u = cleaned.to_uppercase();
    let u = u.trim();
    u == "M0" || u == "M00" || u == "M1" || u == "M01"
}

/// Kommentar aus der Originalzeile (für die Werkzeugwechsel-Meldung)
pub fn comment_of(line: &str) -> String {
    if let (Some(a), Some(b)) = (line.find('('), line.rfind(')')) {
        if b > a { return line[a + 1..b].trim().to_string(); }
    }
    String::new()
}

/// Zeichenzählung für den Empfangspuffer
#[derive(Debug)]
pub struct CharCounter {
    pub rx_size: usize,
    used: usize,
    pending: VecDeque<(usize, Sender, Instant)>,
}

/// Wer hat die Zeile geschickt? (damit das "ok" richtig zugeordnet wird)
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Sender {
    Manual(u64), // Nummer der Handzeile (die Oberfläche wartet auf genau diese Antwort)
    Job(usize),  // Index der Job-Zeile
}

impl CharCounter {
    pub fn new(rx_size: usize) -> Self {
        CharCounter { rx_size, used: 0, pending: VecDeque::new() }
    }
    /// Passt eine Zeile (inkl. Zeilenende) noch in den Puffer?
    /// Eine Zeile, die allein größer ist als der Puffer, darf nur bei leerem Puffer gesendet werden.
    pub fn can_send(&self, len_with_newline: usize) -> bool {
        self.pending.is_empty() || self.used + len_with_newline <= self.rx_size.saturating_sub(1)
    }
    pub fn push(&mut self, len_with_newline: usize, who: Sender) {
        self.used += len_with_newline;
        self.pending.push_back((len_with_newline, who, Instant::now()));
    }
    /// Bei "ok"/"error": älteste Zeile ist erledigt
    pub fn pop(&mut self) -> Option<Sender> {
        let (len, who, _) = self.pending.pop_front()?;
        self.used = self.used.saturating_sub(len);
        Some(who)
    }
    /// Älteste Handzeile, die schon länger als `max_age` auf "ok" wartet (Antwort verloren gegangen).
    /// Wird entfernt, damit sich die Zuordnung nicht dauerhaft verschiebt.
    pub fn drop_stale_manual(&mut self, max_age: Duration) -> Option<u64> {
        let stale = match self.pending.front() {
            Some((_, Sender::Manual(_), t)) => t.elapsed() > max_age,
            _ => false,
        };
        if !stale { return None; }
        match self.pop() { Some(Sender::Manual(id)) => Some(id), _ => None }
    }
    pub fn clear(&mut self) {
        self.pending.clear();
        self.used = 0;
    }
    pub fn is_empty(&self) -> bool { self.pending.is_empty() }
    pub fn used(&self) -> usize { self.used }
    #[cfg(test)]
    pub fn pending_count(&self) -> usize { self.pending.len() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_grbl11() {
        let s = parse_status("<Run|MPos:10.000,5.500,-1.250|FS:1200,12000|Bf:15,127|Ov:100,90,110|WCO:1.000,2.000,0.000>").unwrap();
        assert_eq!(s.state, "Run");
        assert_eq!(s.mpos, Some([10.0, 5.5, -1.25]));
        assert_eq!(s.feed, Some(1200.0));
        assert_eq!(s.spindle, Some(12000.0));
        assert_eq!(s.planner, Some(15));
        assert_eq!(s.rx, Some(127));
        assert_eq!(s.ov, Some([100, 90, 110]));
        assert_eq!(s.wco, Some([1.0, 2.0, 0.0]));
        // Ov ohne A: = Spindel/Kühlung aus
        assert_eq!(s.acc.as_deref(), Some(""));
    }

    #[test]
    fn status_accessories() {
        let s = parse_status("<Hold:0|MPos:0,0,0|FS:0,8000|Ov:100,100,150|A:SF>").unwrap();
        assert_eq!(s.acc.as_deref(), Some("SF"));
        assert_eq!(s.ov, Some([100, 100, 150]));
        // ohne Ov kein Urteil über das Zubehör
        let s = parse_status("<Idle|MPos:0,0,0|FS:0,0>").unwrap();
        assert_eq!(s.acc, None);
    }

    #[test]
    fn status_hold_and_pins() {
        let s = parse_status("<Hold:0|WPos:1,2,3|F:500|Pn:XZP>").unwrap();
        assert_eq!(s.state, "Hold");
        assert_eq!(s.sub, Some(0));
        assert_eq!(s.wpos, Some([1.0, 2.0, 3.0]));
        assert_eq!(s.feed, Some(500.0));
        assert_eq!(s.pins.as_deref(), Some("XZP"));
        assert!(parse_status("ok").is_none());
    }

    #[test]
    fn status_alarm_with_four_axes() {
        let s = parse_status("<Alarm|MPos:0.000,0.000,0.000,0.000|FS:0,0>").unwrap();
        assert_eq!(s.state, "Alarm");
        assert_eq!(s.mpos, Some([0.0, 0.0, 0.0]));
    }

    #[test]
    fn welcome_variants() {
        assert_eq!(parse_welcome("Grbl 1.1h ['$' for help]").unwrap().firmware, "GRBL");
        assert_eq!(parse_welcome("Grbl 1.1h ['$' for help]").unwrap().version, "1.1h");
        assert_eq!(parse_welcome("GrblHAL 1.1f ['$' or '$HELP' for help]").unwrap().firmware, "grblHAL");
        assert_eq!(parse_welcome("Grbl 3.7 [FluidNC v3.7.17 (wifi) '$' for help]").unwrap().firmware, "FluidNC");
        assert_eq!(parse_welcome("Grbl 3.7 [FluidNC v3.7.17 (wifi) '$' for help]").unwrap().version, "v3.7.17");
        assert_eq!(parse_welcome("Grbl 1.3a ['$' for help]").unwrap().firmware, "Grbl_ESP32");
        assert_eq!(parse_welcome("echo:Marlin 2.1.2").unwrap().firmware, "Marlin");
        assert!(parse_welcome("ok").is_none());
        assert!(parse_welcome("[MSG:Grbl is great]").is_none());
    }

    #[test]
    fn classify_lines() {
        assert_eq!(classify("ok"), Incoming::Ok);
        assert_eq!(classify("ok\r"), Incoming::Ok);
        assert_eq!(classify("error:20"), Incoming::Error(20));
        assert_eq!(classify("ALARM:1"), Incoming::Alarm(1));
        assert_eq!(classify("$110=5000.000"), Incoming::Setting("$110".into(), "5000.000".into()));
        assert_eq!(classify("$N0="), Incoming::Text("$N0=".into()));
        assert_eq!(classify("[OPT:VL,15,128]"), Incoming::Opt(128));
        assert_eq!(classify("[OPT:PHSW]"), Incoming::Msg("[OPT:PHSW]".into()));
        assert_eq!(classify("[MSG:'$H'|'$X' to unlock]"), Incoming::Msg("[MSG:'$H'|'$X' to unlock]".into()));
        assert!(matches!(classify("<Idle|MPos:0,0,0>"), Incoming::Status(_)));
    }

    #[test]
    fn opt_rx() {
        assert_eq!(parse_opt_rx("[OPT:V,15,128]"), Some(128));
        assert_eq!(parse_opt_rx("[OPT:VNMHS,35,1024]"), Some(1024));
        assert_eq!(parse_opt_rx("[OPT:V,15,3]"), None);
        assert_eq!(parse_opt_rx("[OPT:V]"), None);
    }

    #[test]
    fn clean() {
        assert_eq!(clean_line("G1 X10  Y5 (Kommentar) F100 ; Rest"), Some("G1 X10 Y5 F100".into()));
        assert_eq!(clean_line("(nur Kommentar)"), None);
        assert_eq!(clean_line("   "), None);
        assert_eq!(clean_line("%"), None);
        assert_eq!(clean_line("M0 (WERKZEUGWECHSEL 2: 6 mm)"), Some("M0".into()));
        assert!(is_tool_change("M0"));
        assert!(is_tool_change("m01"));
        assert!(!is_tool_change("M03"));
        assert!(!is_tool_change("M0 X1"));
        assert_eq!(comment_of("M0 (WERKZEUGWECHSEL 2: 6 mm)"), "WERKZEUGWECHSEL 2: 6 mm");
    }

    #[test]
    fn char_counting() {
        let mut c = CharCounter::new(128);
        assert!(c.can_send(200)); // leer: auch eine überlange Zeile darf raus
        c.push(60, Sender::Job(0));
        c.push(60, Sender::Job(1));
        assert!(!c.can_send(10)); // 120 + 10 > 127
        assert!(c.can_send(7));
        assert_eq!(c.pop(), Some(Sender::Job(0)));
        assert!(c.can_send(60));
        c.push(5, Sender::Manual(7));
        assert_eq!(c.pending_count(), 2);
        assert_eq!(c.pop(), Some(Sender::Job(1)));
        assert_eq!(c.pop(), Some(Sender::Manual(7)));
        assert_eq!(c.pop(), None);
        assert_eq!(c.used(), 0);
    }

    #[test]
    fn stale_manual_is_dropped() {
        let mut c = CharCounter::new(128);
        c.push(4, Sender::Manual(1));
        assert_eq!(c.drop_stale_manual(Duration::from_secs(5)), None);
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(c.drop_stale_manual(Duration::from_millis(10)), Some(1));
        assert!(c.is_empty());
        c.push(4, Sender::Job(0));
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(c.drop_stale_manual(Duration::from_millis(10)), None, "job lines are never dropped");
    }
}
