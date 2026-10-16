//! MARLIN – Creality, Anycubic, Prusa-artige Boards, MPCNC/LowRider (V1 Engineering) …
//!
//! Marlin ist 3D-Drucker-Firmware und spricht anders als GRBL:
//!   - jede Zeile wird mit "ok" bestätigt – es gibt KEINE Echtzeit-Bytes (?, !, ~, Ctrl-X)
//!     → wir senden „Ping-Pong“: immer eine Zeile, dann auf "ok" warten (wie OctoPrint)
//!   - Position kommt per M114 ("X:10.00 Y:5.00 Z:0.00 E:0.00 Count …")
//!   - lange Fahrten: "echo:busy: processing" (Lebenszeichen)
//!   - unbekannte Befehle: "echo:Unknown command: …" und danach trotzdem "ok"
//!   - Pause = einfach nichts mehr schicken (Laser: zusätzlich M5), Stopp = M410 (Schnellstopp) + M5
//!   - Job-Ende: M400 (wartet, bis alle Fahrten fertig sind)
//!
//! GRBL-Zeilen aus der Oberfläche werden übersetzt:
//!   $H → G28 · $X → M999 · $$ → M503 · $I → M115 · $J=G91 X1 F… → G91 / G0 X1 F… / G90
//!   G10 L20 P1 X0 Y0 → G92 X0 Y0 · G4 P2 (Sekunden) → G4 S2 · einzelnes "F600" → G1 F600
//!
//! Meldet dieselben Ereignisse wie die GRBL-Verbindung (machine-status, machine-line, machine-job-…).

use crate::grbl::{clean_line, comment_of, is_tool_change};
use crate::machine::{jstr, Emit};
use std::collections::VecDeque;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Wie lange eine Zeile ohne Lebenszeichen auf "ok" warten darf
const ACK_TIMEOUT: Duration = Duration::from_secs(30);
/// Position während eines Jobs etwa so oft abfragen
const POS_EVERY_JOB: Duration = Duration::from_millis(1000);
const POS_EVERY_IDLE: Duration = Duration::from_millis(400);

// ---------------------------------------------------------------------
// Übersetzen (reine Funktionen, getestet)
// ---------------------------------------------------------------------

/// GRBL-Zeile der Oberfläche -> Marlin-Zeilen. Err = gibt es bei Marlin nicht
pub fn translate_manual(line: &str) -> Result<Vec<String>, String> {
    let Some(c) = clean_line(line) else { return Ok(vec![]) };
    let u = c.to_ascii_uppercase();
    let u = u.trim();
    match u {
        "$H" => return Ok(vec!["G28".into()]),
        "$X" => return Ok(vec!["M999".into()]),
        "$$" => return Ok(vec!["M503".into()]),
        "$I" => return Ok(vec!["M115".into()]),
        "?" => return Ok(vec!["M114".into()]),
        _ => {}
    }
    if let Some(rest) = u.strip_prefix("$J=") {
        // Joggen: Einheiten/relativ aus dem Befehl übernehmen, danach wieder absolut
        let mut rel = false;
        let mut out = Vec::new();
        let mut moves: Vec<String> = Vec::new();
        for tok in rest.split_whitespace() {
            match tok {
                "G91" => rel = true,
                "G90" => rel = false,
                "G20" | "G21" => out.push(tok.to_string()),
                _ => moves.push(tok.to_string()),
            }
        }
        if moves.is_empty() { return Ok(out); }
        out.push(if rel { "G91".into() } else { "G90".into() });
        out.push(format!("G0 {}", moves.join(" ")));
        if rel { out.push("G90".into()); }
        return Ok(out);
    }
    if u.starts_with('$') { return Err("marlin-unsupported".into()); }
    if u.starts_with("G10") && u.contains("L20") {
        // Werkstück-Nullpunkt setzen -> aktuelle Position umbenennen
        let axes: Vec<&str> = u.split_whitespace().filter(|t| t.starts_with('X') || t.starts_with('Y') || t.starts_with('Z')).collect();
        if axes.is_empty() { return Ok(vec![]); }
        return Ok(vec![format!("G92 {}", axes.join(" "))]);
    }
    Ok(vec![job_line(u, &mut 1).unwrap_or_default()].into_iter().filter(|s| !s.is_empty()).collect())
}

/// Eine (bereinigte) Job-Zeile für Marlin anpassen. None = weglassen.
/// `motion` merkt sich den letzten G0/G1/G2/G3 (Marlin kennt keine „modalen“ Zeilen ohne G).
pub fn job_line(cleaned: &str, motion: &mut u8) -> Option<String> {
    let u = cleaned.trim().to_ascii_uppercase();
    if u.is_empty() { return None; }
    let first = u.split_whitespace().next().unwrap_or("");
    // GRBL/CNC-Kopfzeilen, die Marlin meist nicht kennt oder die schaden (M30 = SD-Datei löschen!)
    if matches!(first, "G17" | "G94" | "G54" | "G40" | "G49" | "G80" | "G61" | "G64" | "M30" | "M2" | "M02" | "M6" | "M06" | "M48") { return None; }
    if first.starts_with('T') && first[1..].chars().all(|c| c.is_ascii_digit()) { return None; }
    if first.starts_with('$') { return None; }
    // Bewegungsart merken
    for tok in u.split_whitespace() {
        match tok {
            "G0" | "G00" => *motion = 0,
            "G1" | "G01" => *motion = 1,
            "G2" | "G02" => *motion = 2,
            "G3" | "G03" => *motion = 3,
            _ => {}
        }
    }
    // G4 P = Sekunden (GRBL) -> G4 S (Marlin: P wären Millisekunden)
    if first == "G4" || first == "G04" {
        let mut out = vec!["G4".to_string()];
        for tok in u.split_whitespace().skip(1) {
            if let Some(v) = tok.strip_prefix('P') { out.push(format!("S{}", v)); } else { out.push(tok.to_string()); }
        }
        return Some(out.join(" "));
    }
    // Zeile ohne G/M (z. B. "F600" oder "X10 Y5") -> letzte Bewegungsart davor
    let c0 = first.chars().next().unwrap_or(' ');
    if matches!(c0, 'X' | 'Y' | 'Z' | 'I' | 'J' | 'F' | 'S') {
        let only_fs = u.split_whitespace().all(|t| t.starts_with('F') || t.starts_with('S'));
        let g = if only_fs { 1 } else { *motion };
        return Some(format!("G{} {}", g, u));
    }
    Some(u)
}

/// "X:10.00 Y:5.00 Z:0.00 E:0.00 Count X:…" -> (x, y, z)
pub fn parse_position(line: &str) -> Option<[f64; 3]> {
    let part = line.split("Count").next().unwrap_or(line);
    if !part.contains("X:") || !part.contains("Y:") { return None; }
    let mut v = [f64::NAN; 3];
    for tok in part.split_whitespace() {
        let (k, val) = match tok.split_once(':') { Some(x) => x, None => continue };
        let Ok(n) = val.parse::<f64>() else { continue };
        match k { "X" => v[0] = n, "Y" => v[1] = n, "Z" => v[2] = n, _ => {} }
    }
    if v[0].is_nan() || v[1].is_nan() { return None; }
    if v[2].is_nan() { v[2] = 0.0; }
    Some(v)
}

/// Version aus "FIRMWARE_NAME:Marlin 2.1.2.1 (…)" oder "echo:Marlin 2.0.9"
pub fn parse_version(line: &str) -> Option<String> {
    let i = line.find("Marlin")?;
    let rest = &line[i + 6..];
    let v: String = rest.trim_start().chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_').collect();
    Some(v)
}

// ---------------------------------------------------------------------
// Verbindung
// ---------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
enum Who { Manual(u64), Job(usize), Internal }

struct Job {
    lines: Vec<String>,
    notes: Vec<String>,
    next: usize,
    acked: usize,
    paused: bool,
    stopping: bool,
    tool_change: Option<String>,
    tc_announced: bool,
    tc_emit: bool,       // Werkzeugwechsel melden, sobald M400 fertig ist
    finishing: bool,     // M400 gesendet – warten aufs Ende
    errors: usize,
    last_spindle: Option<String>, // letztes M3/M4 (zum Wiederherstellen nach Pause)
}

struct Inner {
    queue: VecDeque<(String, Who)>, // wartet aufs Senden (Handbefehle haben Vorrang vor Job-Zeilen)
    inflight: Option<(Who, Instant)>,
    last_alive: Instant,
    unknown: Option<String>,        // "Unknown command" vor dem nächsten "ok"
    job: Option<Job>,
    pos: [f64; 3],
    last_pos_req: Instant,
    welcomed: bool,
    halted: bool,
    next_id: u64,
    feed_ov: i32,
    last_progress: Instant,
    motion: u8,
}

struct Shared {
    writer: Mutex<Box<dyn Write + Send>>,
    inner: Mutex<Inner>,
    alive: AtomicBool,
    emit: Emit,
    laser: bool,
}

#[derive(Clone)]
pub struct Marlin {
    sh: Arc<Shared>,
}

impl Marlin {
    /// laser = Laser-Maschine (bei Pause/Stopp wird M5 geschickt)
    pub fn start(mut reader: Box<dyn Read + Send>, writer: Box<dyn Write + Send>, laser: bool, emit: Emit) -> Marlin {
        let now = Instant::now();
        let sh = Arc::new(Shared {
            writer: Mutex::new(writer),
            inner: Mutex::new(Inner {
                queue: VecDeque::new(), inflight: None, last_alive: now, unknown: None, job: None,
                pos: [0.0; 3], last_pos_req: now, welcomed: false, halted: false, next_id: 1, feed_ov: 100,
                last_progress: now, motion: 0,
            }),
            alive: AtomicBool::new(true),
            emit,
            laser,
        });
        let m = Marlin { sh };

        // ---- Lese-Thread ----
        let m1 = m.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 1024];
            let mut acc: Vec<u8> = Vec::with_capacity(512);
            while m1.sh.alive.load(Ordering::SeqCst) {
                match reader.read(&mut buf) {
                    Ok(0) => thread::sleep(Duration::from_millis(5)),
                    Ok(n) => {
                        for &b in &buf[..n] {
                            if b == b'\n' {
                                let line = String::from_utf8_lossy(&acc).trim().to_string();
                                acc.clear();
                                if !line.is_empty() { m1.handle_line(&line); }
                            } else if b != b'\r' {
                                acc.push(b);
                                if acc.len() > 4096 { acc.clear(); }
                            }
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::Interrupted => {}
                    Err(e) => {
                        if m1.sh.alive.swap(false, Ordering::SeqCst) {
                            (m1.sh.emit)("machine-disconnected", format!("{{\"reason\":{}}}", jstr(&e.to_string())));
                        }
                        break;
                    }
                }
            }
        });

        // ---- Takt-Thread ----
        let m2 = m.clone();
        thread::spawn(move || {
            let t0 = Instant::now();
            let mut asked_version = false;
            while m2.sh.alive.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(100));
                // Boards, die beim Verbinden nicht neu starten, melden sich nicht -> nachfragen
                if !asked_version && t0.elapsed() > Duration::from_millis(2500) {
                    asked_version = true;
                    if !m2.sh.inner.lock().unwrap().welcomed { m2.enqueue("M115".into(), Who::Internal, true); }
                }
                m2.tick();
            }
        });
        m
    }

    pub fn is_alive(&self) -> bool { self.sh.alive.load(Ordering::SeqCst) }
    pub fn shutdown(&self) { self.sh.alive.store(false, Ordering::SeqCst); }

    fn emit(&self, name: &str, json: String) { (self.sh.emit)(name, json); }

    fn status_json(&self, inner: &Inner) -> String {
        let st = if inner.halted { "Alarm" } else {
            match inner.job.as_ref() {
                Some(j) if j.paused || j.tool_change.is_some() => if j.tc_announced { "Idle" } else { "Hold" },
                Some(_) => "Run",
                // Handbefehl unterwegs (z. B. Joggen) = fährt; M114/M400 zählen nicht
                None => if matches!(inner.inflight, Some((Who::Manual(_), _))) || inner.queue.iter().any(|q| matches!(q.1, Who::Manual(_))) { "Run" } else { "Idle" },
            }
        };
        let p = inner.pos;
        let r = |v: f64| (v * 1000.0).round() / 1000.0;
        format!("{{\"state\":{},\"sub\":null,\"mpos\":[{},{},{}],\"wpos\":[{},{},{}],\"feed\":0,\"spindle\":0,\"ov\":[{},100,100],\"pins\":\"\"}}",
            jstr(st), r(p[0]), r(p[1]), r(p[2]), r(p[0]), r(p[1]), r(p[2]), inner.feed_ov)
    }

    // -----------------------------------------------------------------
    // Antworten
    // -----------------------------------------------------------------

    fn handle_line(&self, line: &str) {
        let lower = line.to_ascii_lowercase();
        if lower == "ok" || lower.starts_with("ok ") || lower.starts_with("ok:") || lower.starts_with("ok\t") {
            self.on_ok();
            return;
        }
        {
            let mut inner = self.sh.inner.lock().unwrap();
            inner.last_alive = Instant::now();
        }
        if lower.starts_with("echo:busy") || lower.starts_with("busy:") { return; }
        if let Some(p) = parse_position(line) {
            let json = {
                let mut inner = self.sh.inner.lock().unwrap();
                inner.pos = p;
                self.status_json(&inner)
            };
            self.emit("machine-status", json);
            return;
        }
        // Temperatur-Meldungen ("T:20.0 /0.0 B:…") nicht in die Konsole
        if lower.starts_with("t:") || lower.starts_with(" t:") || lower.starts_with("b:") { return; }
        if lower.contains("unknown command") {
            self.sh.inner.lock().unwrap().unknown = Some(line.to_string());
        }
        if line == "start" || lower.contains("firmware_name:marlin") || lower.starts_with("echo:marlin") || lower.starts_with("marlin") {
            let first = {
                let mut inner = self.sh.inner.lock().unwrap();
                let f = !inner.welcomed || line == "start";
                inner.welcomed = true;
                if line == "start" {
                    // Board hat neu gestartet: alles Offene ist verloren
                    inner.inflight = None;
                    inner.queue.clear();
                    inner.halted = false;
                }
                f
            };
            if line == "start" { self.abort_job("reset"); }
            if first || parse_version(line).is_some() {
                let v = parse_version(line).unwrap_or_default();
                self.emit("machine-welcome", format!("{{\"firmware\":\"Marlin\",\"version\":{},\"raw\":{}}}", jstr(&v), jstr(line)));
            }
        }
        if lower.contains("printer halted") || lower.contains("kill() called") || lower.starts_with("error:printer stopped") {
            self.sh.inner.lock().unwrap().halted = true;
            self.emit("machine-alarm", "{\"code\":-1}".into());
            self.abort_job("alarm");
        }
        let kind = if lower.starts_with("echo:") || lower.starts_with("//") { "msg" } else { "text" };
        self.emit("machine-line", format!("{{\"kind\":\"{}\",\"text\":{}}}", kind, jstr(line)));
    }

    fn on_ok(&self) {
        let mut out: Vec<(String, String)> = Vec::new();
        {
            let mut inner = self.sh.inner.lock().unwrap();
            inner.last_alive = Instant::now();
            let unknown = inner.unknown.take();
            let who = inner.inflight.take().map(|w| w.0);
            match who {
                Some(Who::Manual(id)) => match unknown {
                    None => out.push(("machine-line".into(), format!("{{\"kind\":\"ok\",\"id\":{}}}", id))),
                    Some(_) => out.push(("machine-line".into(), format!("{{\"kind\":\"error\",\"code\":20,\"id\":{}}}", id))),
                },
                Some(Who::Job(idx)) => {
                    if let Some(j) = inner.job.as_mut() {
                        j.acked = j.acked.max(idx + 1);
                        if let Some(u) = unknown {
                            // Marlin kennt den Befehl nicht – nicht anhalten, nur melden
                            j.errors += 1;
                            out.push(("machine-line".into(), format!("{{\"kind\":\"text\",\"text\":{}}}", jstr(&format!("⚠ {} ({})", u, j.lines.get(idx).cloned().unwrap_or_default())))));
                        }
                    }
                }
                Some(Who::Internal) => {
                    if let Some(j) = inner.job.as_mut() {
                        if j.tc_emit {
                            j.tc_emit = false;
                            out.push(("machine-job-toolchange".into(), format!("{{\"note\":{}}}", jstr(j.tool_change.as_deref().unwrap_or("")))));
                        }
                    }
                    // M400 am Job-Ende fertig?
                    let done = match inner.job.as_ref() { Some(j) => j.finishing && inner.queue.iter().all(|q| q.1 != Who::Internal) , None => false };
                    if done {
                        let j = inner.job.take().unwrap();
                        out.push(("machine-job-done".into(), format!("{{\"aborted\":false,\"reason\":\"done\",\"acked\":{},\"sent\":{},\"total\":{},\"errors\":{}}}", j.lines.len(), j.lines.len(), j.lines.len(), j.errors)));
                        out.push(("machine-status".into(), self.status_json(&inner)));
                    }
                }
                None => {}
            }
        }
        for (n, j) in out { self.emit(&n, j); }
        self.pump();
    }

    // -----------------------------------------------------------------
    // Senden
    // -----------------------------------------------------------------

    fn write_line(&self, s: &str) -> bool {
        let mut data = s.as_bytes().to_vec();
        data.push(b'\n');
        match self.sh.writer.lock() {
            Ok(mut w) => w.write_all(&data).and_then(|_| w.flush()).is_ok(),
            Err(_) => false,
        }
    }

    fn enqueue(&self, line: String, who: Who, front: bool) {
        {
            let mut inner = self.sh.inner.lock().unwrap();
            if front { inner.queue.push_front((line, who)); } else { inner.queue.push_back((line, who)); }
        }
        self.pump();
    }

    /// Nächste Zeile senden, wenn keine mehr unterwegs ist
    fn pump(&self) {
        let mut write_fail = false;
        {
            let mut inner = self.sh.inner.lock().unwrap();
            if inner.inflight.is_some() { return; }
            // 1) Warteschlange (Handbefehle, interne Befehle)
            let next: Option<(String, Who)> = if let Some(q) = inner.queue.pop_front() {
                Some(q)
            } else {
                // 2) Position ab und zu abfragen
                let every = if inner.job.is_some() { POS_EVERY_JOB } else { POS_EVERY_IDLE };
                let want_pos = inner.welcomed && !inner.halted && inner.last_pos_req.elapsed() >= every;
                let job_next = {
                    let Inner { job, motion, .. } = &mut *inner;
                    let mut pick: Option<(String, Who)> = None;
                    if let Some(j) = job.as_mut() {
                        if !(j.paused || j.stopping || j.tool_change.is_some() || j.finishing) {
                            while j.next < j.lines.len() {
                                let idx = j.next;
                                if is_tool_change(&j.lines[idx]) {
                                    j.tool_change = Some(j.notes[idx].clone());
                                    j.tc_announced = false;
                                    j.next += 1;
                                    break;
                                }
                                j.next += 1;
                                if let Some(l) = job_line(&j.lines[idx], motion) {
                                    let f = l.split_whitespace().next().unwrap_or("");
                                    if f == "M3" || f == "M4" || f == "M03" || f == "M04" { j.last_spindle = Some(l.clone()); }
                                    if f == "M5" || f == "M05" { j.last_spindle = None; }
                                    pick = Some((l, Who::Job(idx)));
                                    break;
                                } else {
                                    j.acked = j.acked.max(idx + 1);
                                }
                            }
                            if pick.is_none() && j.tool_change.is_none() && j.next >= j.lines.len() {
                                j.finishing = true;
                                pick = Some(("M400".into(), Who::Internal));
                            }
                        } else if j.tool_change.is_some() && !j.tc_announced {
                            // Werkzeugwechsel: erst warten, bis alles gefahren ist (M400), dann melden
                            j.tc_announced = true;
                            j.tc_emit = true;
                            pick = Some(("M400".into(), Who::Internal));
                        }
                    }
                    pick
                };
                if want_pos && job_next.as_ref().map(|p| p.1 != Who::Internal).unwrap_or(true) {
                    inner.last_pos_req = Instant::now();
                    if let Some(jn) = job_next { inner.queue.push_front(jn); }
                    Some(("M114".into(), Who::Internal))
                } else {
                    job_next
                }
            };
            if let Some((line, who)) = next {
                if self.write_line(&line) {
                    inner.inflight = Some((who, Instant::now()));
                    inner.last_alive = Instant::now();
                } else {
                    write_fail = true;
                }
            }
        }
        if write_fail {
            if self.sh.alive.swap(false, Ordering::SeqCst) {
                self.emit("machine-disconnected", "{\"reason\":\"write failed\"}".into());
            }
        }
    }

    fn tick(&self) {
        let mut lost: Option<Who> = None;
        {
            let mut inner = self.sh.inner.lock().unwrap();
            if let Some((who, _)) = inner.inflight {
                if inner.last_alive.elapsed() > ACK_TIMEOUT {
                    inner.inflight = None;
                    inner.last_alive = Instant::now();
                    lost = Some(who);
                }
            }
        }
        match lost {
            Some(Who::Manual(id)) => self.emit("machine-line", format!("{{\"kind\":\"timeout\",\"id\":{}}}", id)),
            Some(Who::Job(idx)) => {
                if let Some(j) = self.sh.inner.lock().unwrap().job.as_mut() { j.paused = true; }
                self.emit("machine-job-error", format!("{{\"index\":{},\"code\":-3,\"line\":\"timeout\"}}", idx));
            }
            _ => {}
        }
        self.pump();
        self.progress(false);
    }

    fn progress(&self, force: bool) {
        let json = {
            let mut inner = self.sh.inner.lock().unwrap();
            if !force && inner.last_progress.elapsed() < Duration::from_millis(250) { return; }
            inner.last_progress = Instant::now();
            match inner.job.as_ref() {
                Some(j) => format!("{{\"sent\":{},\"acked\":{},\"total\":{},\"paused\":{},\"toolChange\":{},\"stopping\":{},\"buffer\":0}}",
                    j.next, j.acked.min(j.lines.len().saturating_sub(1)), j.lines.len(), j.paused || j.tc_announced, j.tool_change.is_some(), j.stopping),
                None => return,
            }
        };
        self.emit("machine-job-progress", json);
    }

    fn emit_status(&self) {
        let json = self.status_json(&self.sh.inner.lock().unwrap());
        self.emit("machine-status", json);
    }

    fn abort_job(&self, reason: &str) {
        let j = self.sh.inner.lock().unwrap().job.take();
        if let Some(j) = j {
            self.emit("machine-job-done", format!("{{\"aborted\":true,\"reason\":{},\"acked\":{},\"sent\":{},\"total\":{},\"errors\":{}}}",
                jstr(reason), j.acked, j.next, j.lines.len(), j.errors));
        }
    }

    // -----------------------------------------------------------------
    // Öffentliche Befehle (wie Machine)
    // -----------------------------------------------------------------

    pub fn send_line(&self, line: &str) -> Result<u64, String> {
        let lines = translate_manual(line)?;
        if lines.is_empty() { return Ok(0); }
        let id = {
            let mut inner = self.sh.inner.lock().unwrap();
            if let Some(j) = inner.job.as_ref() { if !(j.paused || j.tc_announced) { return Err("job running".into()); } }
            if lines.iter().any(|l| l == "M999") { inner.halted = false; }
            if inner.queue.len() > 50 { return Err("busy".into()); }
            let id = inner.next_id;
            inner.next_id += 1;
            let n = lines.len();
            for (i, l) in lines.into_iter().enumerate() {
                let who = if i + 1 == n { Who::Manual(id) } else { Who::Internal };
                inner.queue.push_back((l, who));
            }
            id
        };
        self.pump();
        Ok(id)
    }

    pub fn realtime(&self, byte: u8) -> Result<(), String> {
        match byte {
            b'!' => self.pause_job().or(Ok(())),
            b'~' => self.resume_job().or(Ok(())),
            0x18 => {
                if self.sh.inner.lock().unwrap().job.is_some() { self.stop_job() } else { self.quickstop(); Ok(()) }
            }
            0x85 => { self.quickstop(); Ok(()) } // Joggen abbrechen
            0x90..=0x94 => {
                let ov = {
                    let mut inner = self.sh.inner.lock().unwrap();
                    inner.feed_ov = match byte {
                        0x90 => 100,
                        0x91 => (inner.feed_ov + 10).min(200),
                        0x92 => (inner.feed_ov - 10).max(10),
                        0x93 => (inner.feed_ov + 1).min(200),
                        _ => (inner.feed_ov - 1).max(10),
                    };
                    inner.feed_ov
                };
                // Noch nicht gesendete M220 ersetzen – sonst landet bei schnellen Klicks
                // (vorne eingereiht) ein alter Wert zuletzt
                self.sh.inner.lock().unwrap().queue.retain(|q| !(matches!(q.1, Who::Internal) && q.0.starts_with("M220 ")));
                self.enqueue(format!("M220 S{}", ov), Who::Internal, true);
                Ok(())
            }
            _ => Ok(()), // Status kommt von selbst; Spindel/Eilgang-Overrides gibt es so nicht
        }
    }

    /// Schnellstopp: Warteschlange leeren, M410 (stoppt sofort, wenn Marlin den Notfall-Parser hat), Laser/Spindel aus
    /// (Ping-Pong: Marlin hat höchstens die gerade laufende Zeile – M410 ist sofort die nächste)
    fn quickstop(&self) {
        let dropped: Vec<u64> = {
            let mut inner = self.sh.inner.lock().unwrap();
            let ids = inner.queue.iter().filter_map(|q| if let Who::Manual(id) = q.1 { Some(id) } else { None }).collect();
            inner.queue.clear();
            inner.queue.push_back(("M410".into(), Who::Internal));
            inner.queue.push_back(("M5".into(), Who::Internal));
            ids
        };
        for id in dropped { self.emit("machine-line", format!("{{\"kind\":\"timeout\",\"id\":{}}}", id)); }
        self.pump();
    }

    pub fn start_job(&self, raw_lines: Vec<String>) -> Result<usize, String> {
        let mut lines = Vec::new();
        let mut notes = Vec::new();
        for l in &raw_lines {
            if let Some(c) = clean_line(l) { notes.push(comment_of(l)); lines.push(c); }
        }
        if lines.is_empty() { return Err("empty".into()); }
        let n = lines.len();
        {
            let mut inner = self.sh.inner.lock().unwrap();
            if inner.job.is_some() { return Err("busy".into()); }
            if inner.halted { return Err("alarm".into()); }
            inner.motion = 0;
            inner.job = Some(Job { lines, notes, next: 0, acked: 0, paused: false, stopping: false, tool_change: None, tc_announced: false, tc_emit: false, finishing: false, errors: 0, last_spindle: None });
        }
        self.pump();
        self.progress(true);
        Ok(n)
    }

    pub fn pause_job(&self) -> Result<(), String> {
        {
            let mut inner = self.sh.inner.lock().unwrap();
            let j = inner.job.as_mut().ok_or("no job")?;
            j.paused = true;
        }
        // Laser: sobald die gepufferten Fahrten fertig sind, Laser aus
        if self.sh.laser { self.enqueue("M5".into(), Who::Internal, true); }
        self.progress(true);
        Ok(())
    }

    pub fn resume_job(&self) -> Result<(), String> {
        let restore = {
            let mut inner = self.sh.inner.lock().unwrap();
            let j = inner.job.as_mut().ok_or("no job")?;
            if j.tool_change.is_some() && !j.tc_announced { return Err("tool change pending".into()); }
            j.tool_change = None;
            j.tc_announced = false;
            j.paused = false;
            if self.sh.laser { j.last_spindle.clone() } else { None }
        };
        if let Some(s) = restore { self.enqueue(s, Who::Internal, true); }
        self.pump();
        self.progress(true);
        Ok(())
    }

    pub fn stop_job(&self) -> Result<(), String> {
        {
            let mut inner = self.sh.inner.lock().unwrap();
            if inner.job.is_none() { return Err("no job".into()); }
            inner.queue.clear();
        }
        self.abort_job("stopped");
        self.quickstop();
        self.emit_status();
        Ok(())
    }
}

// =====================================================================
// TESTS mit einem simulierten Marlin-Board
// =====================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Receiver, Sender as TxS};

    #[test]
    fn manual_translation() {
        assert_eq!(translate_manual("$H").unwrap(), vec!["G28"]);
        assert_eq!(translate_manual("$J=G21 G91 X10 F3000").unwrap(), vec!["G21", "G91", "G0 X10 F3000", "G90"]);
        assert_eq!(translate_manual("G10 L20 P1 X0 Y0").unwrap(), vec!["G92 X0 Y0"]);
        assert_eq!(translate_manual("$$").unwrap(), vec!["M503"]);
        assert!(translate_manual("$130=300").is_err());
        assert_eq!(translate_manual("G21 G90 G0 X0 Y0").unwrap(), vec!["G21 G90 G0 X0 Y0"]);
        assert_eq!(translate_manual("(nur Kommentar)").unwrap(), Vec::<String>::new());
    }

    #[test]
    fn job_lines() {
        let mut m = 0u8;
        assert_eq!(job_line("G17", &mut m), None);
        assert_eq!(job_line("M30", &mut m), None);
        assert_eq!(job_line("T2", &mut m), None);
        assert_eq!(job_line("G4 P2", &mut m).unwrap(), "G4 S2");
        assert_eq!(job_line("F600", &mut m).unwrap(), "G1 F600");
        assert_eq!(job_line("G1 X1 Y1 F500", &mut m).unwrap(), "G1 X1 Y1 F500");
        assert_eq!(job_line("X2 Y2", &mut m).unwrap(), "G1 X2 Y2");
        assert_eq!(job_line("G0 X0", &mut m).unwrap(), "G0 X0");
        assert_eq!(job_line("Y5", &mut m).unwrap(), "G0 Y5");
    }

    #[test]
    fn parsing() {
        assert_eq!(parse_position("X:10.00 Y:5.50 Z:0.20 E:0.00 Count X:800 Y:440 Z:80").unwrap(), [10.0, 5.5, 0.2]);
        assert!(parse_position("echo:busy: processing").is_none());
        assert_eq!(parse_version("FIRMWARE_NAME:Marlin 2.1.2.1 (Jun 1 2023) SOURCE_CODE_URL:…").unwrap(), "2.1.2.1");
        assert_eq!(parse_version("echo:Marlin bugfix-2.1.x").unwrap(), "bugfix-2.1.x");
    }

    struct FakeReader { rx: Receiver<u8> }
    impl Read for FakeReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.rx.recv_timeout(Duration::from_millis(20)) {
                Ok(b) => {
                    buf[0] = b;
                    let mut n = 1;
                    while n < buf.len() { match self.rx.try_recv() { Ok(b) => { buf[n] = b; n += 1; } Err(_) => break } }
                    Ok(n)
                }
                Err(_) => Err(std::io::Error::new(ErrorKind::TimedOut, "timeout")),
            }
        }
    }
    struct FakeWriter { tx: TxS<u8> }
    impl Write for FakeWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> { for &b in buf { let _ = self.tx.send(b); } Ok(buf.len()) }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }

    /// Simuliertes Marlin: höchstens 4 Befehle im Puffer (BUFSIZE), "ok" nach dem Abarbeiten
    fn spawn_board(received: Arc<Mutex<Vec<String>>>, max_queued: Arc<Mutex<usize>>) -> (Box<dyn Read + Send>, Box<dyn Write + Send>) {
        let (to_tx, to_rx) = channel::<u8>();
        let (from_tx, from_rx) = channel::<u8>();
        thread::spawn(move || {
            let send = |s: &str| for b in s.bytes() { let _ = from_tx.send(b); };
            send("start\necho:Marlin 2.1.2.1\necho: Last Updated: 2023-06-01\n");
            let mut line = Vec::new();
            let mut q: VecDeque<String> = VecDeque::new();
            let (mut x, mut y) = (0.0f64, 0.0f64);
            let mut ticks = 0u32;
            loop {
                match to_rx.recv_timeout(Duration::from_millis(2)) {
                    Ok(b'\n') => {
                        let l = String::from_utf8_lossy(&line).to_string();
                        line.clear();
                        received.lock().unwrap().push(l.clone());
                        q.push_back(l);
                        let mut m = max_queued.lock().unwrap();
                        if q.len() > *m { *m = q.len(); }
                    }
                    Ok(b) => line.push(b),
                    Err(_) => {}
                }
                ticks += 1;
                if ticks % 2 == 0 {
                    if let Some(l) = q.pop_front() {
                        let first = l.split_whitespace().next().unwrap_or("").to_string();
                        if first == "M114" { send(&format!("X:{:.2} Y:{:.2} Z:0.00 E:0.00 Count X:0 Y:0 Z:0\n", x, y)); }
                        if first == "M115" { send("FIRMWARE_NAME:Marlin 2.1.2.1 (Jun 1 2023) MACHINE_TYPE:Ender-3\n"); }
                        if first == "G0" || first == "G1" {
                            for t in l.split_whitespace() {
                                if let Some(v) = t.strip_prefix('X') { x = v.parse().unwrap_or(x); }
                                if let Some(v) = t.strip_prefix('Y') { y = v.parse().unwrap_or(y); }
                            }
                        }
                        let known = ["G0", "G1", "G2", "G3", "G4", "G21", "G90", "G91", "G92", "G28", "M3", "M4", "M5", "M114", "M115", "M400", "M410", "M220", "M503", "M999"];
                        if !known.contains(&first.as_str()) { send(&format!("echo:Unknown command: \"{}\"\n", l)); }
                        if first == "M400" { send("echo:busy: processing\n"); }
                        send("ok\n");
                    }
                }
            }
        });
        (Box::new(FakeReader { rx: from_rx }), Box::new(FakeWriter { tx: to_tx }))
    }

    fn collect() -> (Emit, Arc<Mutex<Vec<(String, String)>>>) {
        let ev: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let e2 = ev.clone();
        (Arc::new(move |n: &str, j: String| e2.lock().unwrap().push((n.to_string(), j))), ev)
    }

    fn wait_for(ev: &Arc<Mutex<Vec<(String, String)>>>, name: &str, needle: &str, secs: u64) -> Option<String> {
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(secs) {
            if let Some((_, j)) = ev.lock().unwrap().iter().find(|(n, j)| n == name && j.contains(needle)) { return Some(j.clone()); }
            thread::sleep(Duration::from_millis(10));
        }
        None
    }

    #[test]
    fn full_job_ping_pong() {
        let rec = Arc::new(Mutex::new(Vec::new()));
        let maxq = Arc::new(Mutex::new(0));
        let (r, w) = spawn_board(rec.clone(), maxq.clone());
        let (emit, ev) = collect();
        let m = Marlin::start(r, w, true, emit);
        assert!(wait_for(&ev, "machine-welcome", "2.1.2.1", 2).is_some());
        assert!(wait_for(&ev, "machine-status", "Idle", 3).is_some());
        let mut job = vec!["G21".to_string(), "G90".into(), "G17 (CNC-Kopf)".into(), "M4 S0".into(), "F1200".into()];
        for i in 0..60 { job.push(format!("G1 X{} Y{} S128", i, i)); }
        job.push("M8 (Luft)".into());
        job.push("M5".into());
        job.push("M30".into());
        let n = m.start_job(job).unwrap();
        assert_eq!(n, 68);
        let done = wait_for(&ev, "machine-job-done", "", 10).expect("done");
        assert!(done.contains("\"aborted\":false"), "{}", done);
        assert!(done.contains("\"errors\":1"), "{}", done); // M8 unbekannt -> nur Warnung
        let r = rec.lock().unwrap().clone();
        assert!(!r.iter().any(|l| l.starts_with("G17") || l.starts_with("M30")), "{:?}", r);
        assert!(r.iter().any(|l| l == "G1 F1200"));
        assert!(r.iter().any(|l| l == "M400"));
        assert!(r.iter().any(|l| l == "M114"), "Position wird zwischendurch abgefragt");
        assert!(*maxq.lock().unwrap() <= 1, "Ping-Pong: nie mehr als eine Zeile unterwegs");
        // Position kam an
        assert!(wait_for(&ev, "machine-status", "59", 2).is_some());
        m.shutdown();
    }

    #[test]
    fn tool_change() {
        let rec = Arc::new(Mutex::new(Vec::new()));
        let (r, w) = spawn_board(rec.clone(), Arc::new(Mutex::new(0)));
        let (emit, ev) = collect();
        let m = Marlin::start(r, w, false, emit);
        wait_for(&ev, "machine-welcome", "", 2).unwrap();
        m.start_job(vec!["M3 S1000".into(), "G1 X1 F100".into(), "M0 (WERKZEUG 2)".into(), "G1 X2".into()]).unwrap();
        assert!(wait_for(&ev, "machine-job-toolchange", "WERKZEUG 2", 3).is_some());
        assert!(!rec.lock().unwrap().iter().any(|l| l == "M0"), "M0 geht nicht an Marlin");
        assert!(!rec.lock().unwrap().iter().any(|l| l == "G1 X2"));
        m.resume_job().unwrap();
        assert!(wait_for(&ev, "machine-job-done", "\"aborted\":false", 3).is_some());
        assert!(rec.lock().unwrap().iter().any(|l| l == "G1 X2"));
        m.shutdown();
    }

    #[test]
    fn manual_and_pause_stop() {
        let rec = Arc::new(Mutex::new(Vec::new()));
        let (r, w) = spawn_board(rec.clone(), Arc::new(Mutex::new(0)));
        let (emit, ev) = collect();
        let m = Marlin::start(r, w, true, emit);
        wait_for(&ev, "machine-welcome", "", 2).unwrap();
        let id = m.send_line("$J=G21 G91 X5 F1000").unwrap();
        assert!(wait_for(&ev, "machine-line", &format!("\"kind\":\"ok\",\"id\":{}", id), 3).is_some());
        let id2 = m.send_line("G99").unwrap();
        assert!(wait_for(&ev, "machine-line", &format!("\"kind\":\"error\",\"code\":20,\"id\":{}", id2), 3).is_some());
        // Pause mitten im Job: Laser aus, danach M4 wieder an
        let mut job = vec!["M4 S0".to_string()];
        for i in 0..400 { job.push(format!("G1 X{} S100", i)); }
        m.start_job(job).unwrap();
        thread::sleep(Duration::from_millis(150));
        m.pause_job().unwrap();
        thread::sleep(Duration::from_millis(200));
        let before = rec.lock().unwrap().len();
        thread::sleep(Duration::from_millis(300));
        let after = rec.lock().unwrap().len();
        assert!(after - before <= 2, "pausiert: keine Job-Zeilen mehr ({} -> {})", before, after);
        assert!(rec.lock().unwrap().iter().any(|l| l == "M5"));
        m.resume_job().unwrap();
        thread::sleep(Duration::from_millis(150));
        assert!(rec.lock().unwrap().iter().filter(|l| *l == "M4 S0").count() >= 2, "Laser-Befehl wiederhergestellt");
        m.stop_job().unwrap();
        assert!(wait_for(&ev, "machine-job-done", "\"aborted\":true", 2).is_some());
        thread::sleep(Duration::from_millis(100));
        assert!(rec.lock().unwrap().iter().any(|l| l == "M410"));
        m.shutdown();
    }

    #[test]
    fn feed_override_steps() {
        let rec = Arc::new(Mutex::new(Vec::new()));
        let (r, w) = spawn_board(rec.clone(), Arc::new(Mutex::new(0)));
        let (emit, ev) = collect();
        let m = Marlin::start(r, w, false, emit);
        wait_for(&ev, "machine-welcome", "", 2).unwrap();
        // +10 +10 +1 -1 -1 → 119 %; Reset → 100 %
        for b in [0x91u8, 0x91, 0x93, 0x94, 0x94] { m.realtime(b).unwrap(); }
        thread::sleep(Duration::from_millis(300));
        assert!(rec.lock().unwrap().iter().any(|l| l == "M220 S119"), "{:?}", rec.lock().unwrap());
        m.realtime(0x90).unwrap();
        thread::sleep(Duration::from_millis(200));
        assert!(rec.lock().unwrap().iter().any(|l| l == "M220 S100"));
        // nie unter 10 %
        for _ in 0..30 { m.realtime(0x92).unwrap(); }
        m.realtime(0x94).unwrap();
        thread::sleep(Duration::from_millis(300));
        assert_eq!(rec.lock().unwrap().iter().filter(|l| l.starts_with("M220")).last().map(|s| s.as_str()), Some("M220 S10"));
        m.shutdown();
    }
}
