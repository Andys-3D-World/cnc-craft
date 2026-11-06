//! USB-SUCHE: Auf welchem Port und mit welcher Baudrate antwortet eine GRBL-Steuerung?
//!
//! Läuft nur auf Knopfdruck: Das Öffnen eines Ports setzt viele Boards zurück (DTR), und ein `?` an ein fremdes Gerät
//! (3D-Drucker …) soll nicht ungefragt passieren. Gesendet wird nur `?`. Verbundene Ports werden nie angefasst
//! (lib.rs überspringt sie und bricht ab, sobald irgendwo ein Job läuft).
//! Der Port wird danach wieder geschlossen: Verbunden wird auf dem normalen Weg (machine_connect).

use crate::grbl;
use serde::Serialize;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub static CANCEL: AtomicBool = AtomicBool::new(false);
pub static BUSY: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Found {
    pub port: String,
    pub baud: u32,
    pub firmware: String,
}

/// Nur eine gültige GRBL-Antwort zählt. Zurück: Firmware-Name ("" = Status ohne Namen).
pub fn grbl_reply(line: &str) -> Option<String> {
    if let Some(st) = grbl::parse_status(line) {
        const STATES: [&str; 9] = ["Idle", "Run", "Hold", "Jog", "Alarm", "Door", "Check", "Home", "Sleep"];
        if STATES.contains(&st.state.as_str()) && (st.mpos.is_some() || st.wpos.is_some()) {
            return Some(String::new());
        }
        return None;
    }
    let w = grbl::parse_welcome(line)?;
    matches!(w.firmware.as_str(), "GRBL" | "grblHAL" | "FluidNC" | "Grbl_ESP32").then_some(w.firmware)
}

/// Lauscht bis `window` um ist und fragt dabei immer wieder mit `?`. Status + Name: sofort fertig;
/// nur Status: kurz weiter auf einen Namen warten (reicht aber auch allein).
pub fn probe<P: Read + Write>(port: &mut P, window: Duration, ask_every: Duration, cancel: &AtomicBool) -> Option<String> {
    let start = Instant::now();
    let mut last_ask: Option<Instant> = None;
    let mut line: Vec<u8> = Vec::with_capacity(128);
    let mut buf = [0u8; 256];
    let mut hit: Option<String> = None;
    let mut deadline = start + window;
    while Instant::now() < deadline {
        if cancel.load(Ordering::Relaxed) { return None; }
        if last_ask.map_or(true, |t| t.elapsed() >= ask_every) {
            if port.write_all(b"?").is_err() { return hit; }
            let _ = port.flush();
            last_ask = Some(Instant::now());
        }
        match port.read(&mut buf) {
            Ok(0) => std::thread::sleep(Duration::from_millis(5)),
            Ok(n) => {
                for &b in &buf[..n] {
                    if b == b'\n' || b == b'\r' {
                        if let Ok(text) = std::str::from_utf8(&line) {
                            if let Some(fw) = grbl_reply(text) {
                                if !fw.is_empty() { return Some(fw); }
                                if hit.is_none() {
                                    hit = Some(fw);
                                    deadline = deadline.min(Instant::now() + Duration::from_millis(300));
                                }
                            }
                        }
                        line.clear();
                    } else if line.len() < 200 {
                        line.push(b);
                    } else {
                        line.clear(); // falsche Baudrate liefert Datensalat ohne Zeilenende
                    }
                }
            }
            Err(e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock => {}
            Err(_) => return hit,
        }
    }
    hit
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct Fake { reads: VecDeque<Vec<u8>>, written: Vec<u8> }
    impl Read for Fake {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.reads.pop_front() {
                Some(d) => { let n = d.len().min(buf.len()); buf[..n].copy_from_slice(&d[..n]); Ok(n) }
                None => { std::thread::sleep(Duration::from_millis(2)); Err(ErrorKind::TimedOut.into()) }
            }
        }
    }
    impl Write for Fake {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> { self.written.extend_from_slice(b); Ok(b.len()) }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    fn fake(reads: &[&[u8]]) -> Fake { Fake { reads: reads.iter().map(|r| r.to_vec()).collect(), written: vec![] } }
    fn run(f: &mut Fake) -> Option<String> {
        let c = AtomicBool::new(false);
        probe(f, Duration::from_millis(120), Duration::from_millis(40), &c)
    }

    #[test]
    fn nur_gueltige_antworten() {
        assert_eq!(grbl_reply("<Idle|MPos:0.000,0.000,0.000|FS:0,0>"), Some(String::new()));
        assert_eq!(grbl_reply("<Alarm|WPos:1,2,3>"), Some(String::new()));
        assert_eq!(grbl_reply("Grbl 1.1h ['$' for help]").as_deref(), Some("GRBL"));
        assert_eq!(grbl_reply("GrblHAL 1.1f ['$' or '$HELP' for help]").as_deref(), Some("grblHAL"));
        assert_eq!(grbl_reply("[MSG:INFO: FluidNC v3.7.8]").as_deref(), Some("FluidNC"));
        assert_eq!(grbl_reply("<abc>"), None);
        assert_eq!(grbl_reply("<Idle>"), None);
        assert_eq!(grbl_reply("<Busy|MPos:0,0,0>"), None);
        assert_eq!(grbl_reply("ok"), None);
        assert_eq!(grbl_reply("echo:Unknown command: \"?\""), None);
        assert_eq!(grbl_reply("start"), None);
        assert_eq!(grbl_reply("echo: Marlin 2.1.2"), None);
        assert_eq!(grbl_reply("\u{fffd}\u{fffd}x"), None);
    }

    #[test]
    fn findet_namen_und_sendet_nur_fragezeichen() {
        let mut f = fake(&[b"\r\nGrbl 1.1h ['$' for help]\r\n"]);
        assert_eq!(run(&mut f).as_deref(), Some("GRBL"));
        assert!(!f.written.is_empty() && f.written.iter().all(|&b| b == b'?'));
    }

    #[test]
    fn zerstueckelte_zeile_und_status_ohne_namen() {
        let mut f = fake(&[b"<Idle|MPos:0.0", b"00,0.000,0.000|FS:0,0>\r\n"]);
        assert_eq!(run(&mut f).as_deref(), Some(""));
    }

    #[test]
    fn datensalat_und_fremde_geraete_zaehlen_nicht() {
        let mut f = fake(&[&[0xff, 0xfe, 0x80, b'\n', b'x', b'\n'], b"ok\nstart\n"]);
        assert_eq!(run(&mut f), None);
        let long = vec![b'z'; 1000];
        let mut g = fake(&[&long]);
        assert_eq!(run(&mut g), None);
    }

    #[test]
    fn abbrechen_wirkt_sofort() {
        let c = AtomicBool::new(true);
        let mut f = fake(&[b"Grbl 1.1h\n"]);
        assert_eq!(probe(&mut f, Duration::from_secs(5), Duration::from_millis(40), &c), None);
        assert!(f.written.is_empty());
    }
}
