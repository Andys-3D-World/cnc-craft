//! MASCHINEN-VERBINDUNG (GRBL & Co.)
//!
//! Läuft in zwei Hintergrund-Threads:
//!   - Lese-Thread: liest alle Antworten des Boards, ordnet "ok"/"error" den gesendeten Zeilen zu,
//!     wertet Statusberichte aus und meldet alles als Ereignis an die Oberfläche
//!   - Takt-Thread: fragt 5× pro Sekunde den Status ab ("?"), meldet den Job-Fortschritt,
//!     erkennt Job-Ende und Werkzeugwechsel
//!
//! Jobs werden HIER gesendet (nicht aus der Oberfläche): immer so viele Zeilen, wie in den
//! Empfangspuffer des Boards passen ("character counting", wie UGS/OpenBuilds/bCNC).
//! Dadurch läuft die Maschine flüssig ohne Ruckeln, und der Puffer läuft nie über.
//!
//! Der Port ist hier nur "etwas zum Lesen/Schreiben" – so lässt sich alles ohne Hardware testen.
//! Ereignisse gehen über `emit(name, json)` an die Oberfläche (siehe lib.rs).

use crate::grbl::{classify, clean_line, comment_of, is_m6, is_tool_change, tool_word, CharCounter, Incoming, Sender, Status};
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub type Emit = Arc<dyn Fn(&str, String) + Send + Sync>;

pub const RT_STATUS: u8 = b'?';
pub const RT_HOLD: u8 = b'!';
pub const RT_RESUME: u8 = b'~';
pub const RT_RESET: u8 = 0x18;
/// Wartet eine Handzeile länger als das auf "ok", obwohl die Maschine steht, ging die Antwort verloren
pub const STALE_MANUAL: Duration = Duration::from_secs(5);
/// Live-Bearbeitung: so viele Zeilen hinter der nächsten zu sendenden bleiben gesperrt (Sicherheitsabstand)
pub const PATCH_MARGIN: usize = 5;

struct Job {
    lines: Vec<String>,      // bereinigte Zeilen
    notes: Vec<String>,      // Kommentar der Originalzeile (für Werkzeugwechsel)
    next: usize,             // nächste zu sendende Zeile
    acked: usize,            // bestätigte Zeilen
    paused: bool,
    tool_change: Option<String>,
    tc_tool: Option<u32>,    // Werkzeugnummer des Wechsels (T-Wort, bei "T2" + "M6" in zwei Zeilen das letzte T)
    tc_m6: bool,             // Wechsel kam von M6 (sonst M0/M1)
    last_t: Option<u32>,     // zuletzt gesehenes T-Wort im Job
    tc_announced: bool,
    stopping: bool,
    errors: usize,
}

struct Inner {
    counter: CharCounter,
    job: Option<Job>,
    wco: [f64; 3],
    state: String,
    sub: Option<i32>,
    status_after_ack: bool,  // kam nach der letzten Bestätigung schon ein Statusbericht?
    poll: bool,              // Statusabfrage (bei Marlin aus)
    last_progress: Instant,
    next_id: u64,            // Nummer für die nächste Handzeile
}

struct Shared {
    writer: Mutex<Box<dyn Write + Send>>,
    inner: Mutex<Inner>,
    alive: AtomicBool,
    emit: Emit,
}

#[derive(Clone)]
pub struct Machine {
    sh: Arc<Shared>,
}

// ---------------------------------------------------------------------
// kleine JSON-Helfer (ohne Bibliothek, damit dieser Teil allein testbar bleibt)
// ---------------------------------------------------------------------

pub fn jstr(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn jnum(v: Option<f64>) -> String {
    match v {
        Some(x) if x.is_finite() => format!("{}", (x * 1000.0).round() / 1000.0),
        _ => "null".into(),
    }
}

fn jxyz(v: Option<[f64; 3]>) -> String {
    match v {
        Some(a) => format!("[{},{},{}]", jnum(Some(a[0])), jnum(Some(a[1])), jnum(Some(a[2]))),
        None => "null".into(),
    }
}

impl Machine {
    /// Startet die Hintergrund-Threads für einen geöffneten Port.
    pub fn start(mut reader: Box<dyn Read + Send>, writer: Box<dyn Write + Send>, emit: Emit) -> Machine {
        let sh = Arc::new(Shared {
            writer: Mutex::new(writer),
            inner: Mutex::new(Inner {
                counter: CharCounter::new(128),
                job: None,
                wco: [0.0; 3],
                state: String::new(),
                sub: None,
                status_after_ack: false,
                poll: true,
                last_progress: Instant::now(),
                next_id: 1,
            }),
            alive: AtomicBool::new(true),
            emit,
        });
        let m = Machine { sh };

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
                                if acc.len() > 4096 { acc.clear(); } // Müll (z. B. Bootmeldung mit falscher Baudrate)
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

        // ---- Takt-Thread (Statusabfrage, Fortschritt, Job-Ende) ----
        let m2 = m.clone();
        thread::spawn(move || {
            while m2.sh.alive.load(Ordering::SeqCst) {
                let poll = m2.sh.inner.lock().map(|i| i.poll).unwrap_or(false);
                if poll { let _ = m2.write_raw(&[RT_STATUS]); }
                thread::sleep(Duration::from_millis(200));
                m2.tick();
            }
        });

        m
    }

    /// Läuft gerade ein Job? (für sicheres Trennen/Beenden)
    pub fn has_job(&self) -> bool {
        self.sh.inner.lock().map(|i| i.job.is_some()).unwrap_or(false)
    }

    pub fn is_alive(&self) -> bool {
        self.sh.alive.load(Ordering::SeqCst)
    }

    pub fn shutdown(&self) {
        self.sh.alive.store(false, Ordering::SeqCst);
    }

    fn emit(&self, name: &str, json: String) {
        (self.sh.emit)(name, json);
    }

    fn write_raw(&self, bytes: &[u8]) -> Result<(), String> {
        let mut w = self.sh.writer.lock().map_err(|_| "writer lock".to_string())?;
        w.write_all(bytes).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }

    // -----------------------------------------------------------------
    // Antworten des Boards
    // -----------------------------------------------------------------

    fn handle_line(&self, line: &str) {
        match classify(line) {
            Incoming::Status(st) => self.on_status(st),
            Incoming::Ok => self.on_ack(None),
            Incoming::Error(code) => self.on_ack(Some(code)),
            Incoming::Alarm(code) => {
                self.emit("machine-alarm", format!("{{\"code\":{}}}", code));
                // Alarm: GRBL hat angehalten und den Puffer verworfen
                self.abort_job_internal("alarm");
            }
            Incoming::Welcome(w) => {
                {
                    let mut inner = self.sh.inner.lock().unwrap();
                    inner.counter.clear();
                    inner.counter.rx_size = 128;
                    inner.poll = w.firmware != "Marlin";
                }
                self.abort_job_internal("reboot");
                self.emit("machine-welcome", format!("{{\"firmware\":{},\"version\":{},\"raw\":{}}}",
                    jstr(&w.firmware), jstr(&w.version), jstr(&w.raw)));
            }
            Incoming::Opt(rx) => {
                if let Ok(mut inner) = self.sh.inner.lock() { inner.counter.rx_size = rx; }
                self.emit("machine-line", format!("{{\"kind\":\"msg\",\"text\":{}}}", jstr(line)));
            }
            Incoming::Setting(k, v) => {
                self.emit("machine-line", format!("{{\"kind\":\"setting\",\"key\":{},\"value\":{},\"text\":{}}}", jstr(&k), jstr(&v), jstr(line)));
            }
            Incoming::Msg(t) => self.emit("machine-line", format!("{{\"kind\":\"msg\",\"text\":{}}}", jstr(&t))),
            Incoming::Text(t) => self.emit("machine-line", format!("{{\"kind\":\"text\",\"text\":{}}}", jstr(&t))),
        }
    }

    fn on_status(&self, st: Status) {
        let json;
        {
            let mut inner = self.sh.inner.lock().unwrap();
            if let Some(w) = st.wco { inner.wco = w; }
            let wco = inner.wco;
            let mpos = st.mpos.or_else(|| st.wpos.map(|w| [w[0] + wco[0], w[1] + wco[1], w[2] + wco[2]]));
            let wpos = st.wpos.or_else(|| st.mpos.map(|m| [m[0] - wco[0], m[1] - wco[1], m[2] - wco[2]]));
            inner.state = st.state.clone();
            inner.sub = st.sub;
            inner.status_after_ack = true;
            json = format!(
                "{{\"state\":{},\"sub\":{},\"mpos\":{},\"wpos\":{},\"feed\":{},\"spindle\":{},\"planner\":{},\"rx\":{},\"ov\":{},\"pins\":{},\"acc\":{}}}",
                jstr(&st.state),
                st.sub.map(|s| s.to_string()).unwrap_or_else(|| "null".into()),
                jxyz(mpos), jxyz(wpos), jnum(st.feed), jnum(st.spindle),
                st.planner.map(|s| s.to_string()).unwrap_or_else(|| "null".into()),
                st.rx.map(|s| s.to_string()).unwrap_or_else(|| "null".into()),
                st.ov.map(|o| format!("[{},{},{}]", o[0], o[1], o[2])).unwrap_or_else(|| "null".into()),
                st.pins.as_deref().map(jstr).unwrap_or_else(|| "null".into()),
                st.acc.as_deref().map(jstr).unwrap_or_else(|| "null".into())
            );
        }
        self.emit("machine-status", json);
    }

    /// "ok" (code = None) oder "error:N"
    fn on_ack(&self, code: Option<i32>) {
        let mut job_error: Option<(usize, i32)> = None;
        let mut manual = false;
        let mut manual_id: Option<u64> = None;
        {
            let mut inner = self.sh.inner.lock().unwrap();
            inner.status_after_ack = false;
            match inner.counter.pop() {
                Some(Sender::Job(idx)) => {
                    if let Some(job) = inner.job.as_mut() {
                        job.acked += 1;
                        if let Some(c) = code {
                            job.errors += 1;
                            job.paused = true; // bei Fehler nicht weitersenden – du entscheidest
                            job_error = Some((idx, c));
                        }
                    }
                }
                Some(Sender::Manual(id)) => { manual = true; manual_id = Some(id); }
                None => manual = true, // "ok" ohne gesendete Zeile (z. B. nach Reset) – keiner Zeile zuordnen
            }
        }
        if let Some((idx, c)) = job_error {
            let text = self.job_line(idx);
            self.emit("machine-job-error", format!("{{\"index\":{},\"code\":{},\"line\":{}}}", idx, c, jstr(&text)));
        } else if manual {
            let id = manual_id.map(|i| i.to_string()).unwrap_or_else(|| "null".into());
            match code {
                None => self.emit("machine-line", format!("{{\"kind\":\"ok\",\"id\":{}}}", id)),
                Some(c) => self.emit("machine-line", format!("{{\"kind\":\"error\",\"code\":{},\"id\":{}}}", c, id)),
            }
        }
        self.pump();
    }

    fn job_line(&self, idx: usize) -> String {
        let inner = self.sh.inner.lock().unwrap();
        inner.job.as_ref().and_then(|j| j.lines.get(idx).cloned()).unwrap_or_default()
    }

    // -----------------------------------------------------------------
    // Job senden
    // -----------------------------------------------------------------

    /// So viele Job-Zeilen senden, wie in den Puffer passen
    fn pump(&self) {
        let mut inner = self.sh.inner.lock().unwrap();
        loop {
            let Inner { counter, job, .. } = &mut *inner;
            let Some(job) = job.as_mut() else { return };
            if job.paused || job.stopping || job.tool_change.is_some() || job.next >= job.lines.len() { return; }
            let idx = job.next;
            if let Some(n) = tool_word(&job.lines[idx]) { job.last_t = Some(n); }
            if is_tool_change(&job.lines[idx]) {
                job.tool_change = Some(job.notes[idx].clone());
                job.tc_m6 = is_m6(&job.lines[idx]);
                job.tc_tool = if job.tc_m6 { job.last_t } else { None };
                job.tc_announced = false;
                job.next += 1;
                return;
            }
            let len = job.lines[idx].len() + 1;
            if !counter.can_send(len) { return; }
            let mut data = job.lines[idx].clone().into_bytes();
            data.push(b'\n');
            // Schreiben, während inner gesperrt ist (Reihenfolge immer: inner -> writer)
            let ok = match self.sh.writer.lock() {
                Ok(mut w) => w.write_all(&data).and_then(|_| w.flush()).is_ok(),
                Err(_) => false,
            };
            if !ok {
                job.paused = true;
                drop(inner);
                self.emit("machine-job-error", format!("{{\"index\":{},\"code\":-2,\"line\":{}}}", idx, jstr("write failed")));
                return;
            }
            counter.push(len, Sender::Job(idx));
            job.next += 1;
        }
    }

    pub fn start_job(&self, raw_lines: Vec<String>) -> Result<usize, String> {
        let mut lines = Vec::new();
        let mut notes = Vec::new();
        for l in &raw_lines {
            if let Some(c) = clean_line(l) {
                notes.push(comment_of(l));
                lines.push(c);
            }
        }
        if lines.is_empty() { return Err("empty".into()); }
        let n = lines.len();
        {
            let mut inner = self.sh.inner.lock().unwrap();
            if inner.job.is_some() { return Err("busy".into()); }
            if inner.state == "Alarm" { return Err("alarm".into()); }
            inner.job = Some(Job { lines, notes, next: 0, acked: 0, paused: false, tool_change: None, tc_tool: None, tc_m6: false, last_t: None, tc_announced: false, stopping: false, errors: 0 });
            inner.last_progress = Instant::now() - Duration::from_secs(1);
        }
        self.pump();
        self.progress(true);
        Ok(n)
    }

    /// Laufenden Job ändern: Zeilen [from, from+delete) durch `insert` ersetzen.
    /// Nur Zeilen, die noch nicht gesendet sind – mit Sicherheitsabstand (`PATCH_MARGIN`) hinter `next`.
    /// `expect_total` = Zeilenzahl, von der die Oberfläche ausgeht (sonst wurde inzwischen etwas anderes geändert).
    /// Gibt die neue Zeilenzahl zurück.
    pub fn patch_job(&self, from: usize, delete: usize, insert: Vec<String>, expect_total: usize) -> Result<usize, String> {
        let mut lines = Vec::with_capacity(insert.len());
        let mut notes = Vec::with_capacity(insert.len());
        for l in &insert {
            // jede neue Zeile muss etwas zum Senden enthalten, sonst verrutscht die Zuordnung in der Oberfläche
            let c = clean_line(l).ok_or("empty line")?;
            notes.push(comment_of(l));
            lines.push(c);
        }
        let total = {
            let mut inner = self.sh.inner.lock().unwrap();
            let job = inner.job.as_mut().ok_or("no job")?;
            if job.stopping { return Err("stopping".into()); }
            if job.lines.len() != expect_total { return Err("changed".into()); }
            let end = from.checked_add(delete).ok_or("range")?;
            if end > job.lines.len() { return Err("range".into()); }
            if from < job.next + PATCH_MARGIN { return Err("locked".into()); }
            job.lines.splice(from..end, lines);
            job.notes.splice(from..end, notes);
            job.lines.len()
        };
        self.pump();
        self.progress(true);
        Ok(total)
    }

    /// Erste Zeile, die `patch_job` gerade noch ändern darf (None = kein Job)
    pub fn patch_floor(&self) -> Option<usize> {
        let inner = self.sh.inner.lock().unwrap();
        inner.job.as_ref().map(|j| j.next + PATCH_MARGIN)
    }

    pub fn pause_job(&self) -> Result<(), String> {
        {
            let mut inner = self.sh.inner.lock().unwrap();
            let job = inner.job.as_mut().ok_or("no job")?;
            job.paused = true;
        }
        self.write_raw(&[RT_HOLD])?;
        self.progress(true);
        Ok(())
    }

    pub fn resume_job(&self) -> Result<(), String> {
        let was_tool_change;
        {
            let mut inner = self.sh.inner.lock().unwrap();
            let job = inner.job.as_mut().ok_or("no job")?;
            was_tool_change = job.tool_change.is_some() && job.tc_announced;
            if job.tool_change.is_some() && !job.tc_announced { return Err("tool change pending".into()); }
            job.tool_change = None;
            job.tc_announced = false;
            job.paused = false;
        }
        if !was_tool_change { self.write_raw(&[RT_RESUME])?; }
        self.pump();
        self.progress(true);
        Ok(())
    }

    /// Job abbrechen: anhalten (!), warten bis die Maschine steht, dann Reset (Puffer leeren).
    /// So gibt es keinen Alarm "Reset während der Fahrt".
    pub fn stop_job(&self) -> Result<(), String> {
        {
            let mut inner = self.sh.inner.lock().unwrap();
            let job = inner.job.as_mut().ok_or("no job")?;
            if job.stopping { return Ok(()); }
            job.stopping = true;
            job.paused = true;
        }
        self.write_raw(&[RT_HOLD])?;
        let m = self.clone();
        thread::spawn(move || {
            let t0 = Instant::now();
            loop {
                thread::sleep(Duration::from_millis(50));
                let (state, sub) = {
                    let i = m.sh.inner.lock().unwrap();
                    (i.state.clone(), i.sub)
                };
                if (state == "Hold" && sub == Some(0)) || state == "Idle" || t0.elapsed() > Duration::from_millis(2500) { break; }
            }
            let _ = m.write_raw(&[RT_RESET]);
            m.abort_job_internal("stopped");
        });
        Ok(())
    }

    fn abort_job_internal(&self, reason: &str) {
        let done = {
            let mut inner = self.sh.inner.lock().unwrap();
            inner.counter.clear();
            inner.job.take()
        };
        if let Some(job) = done {
            self.emit("machine-job-done", format!("{{\"aborted\":true,\"reason\":{},\"acked\":{},\"sent\":{},\"total\":{},\"errors\":{}}}",
                jstr(reason), job.acked, job.next, job.lines.len(), job.errors));
        }
    }

    /// Takt: Werkzeugwechsel ankündigen, Job-Ende erkennen, Fortschritt melden
    fn tick(&self) {
        let mut announce: Option<(String, Option<u32>, bool)> = None;
        let mut finished: Option<(usize, usize)> = None;
        let mut stale: Vec<u64> = Vec::new();
        {
            let mut inner = self.sh.inner.lock().unwrap();
            // Verlorene Antworten aufräumen (nur ohne Job und wenn die Maschine steht)
            if inner.job.is_none() && inner.state == "Idle" {
                while let Some(id) = inner.counter.drop_stale_manual(STALE_MANUAL) { stale.push(id); }
            }
            let idle = inner.state == "Idle";
            let fresh = inner.status_after_ack;
            let buffer_empty = inner.counter.is_empty();
            if let Some(job) = inner.job.as_mut() {
                if !job.stopping {
                    if job.tool_change.is_some() && !job.tc_announced && buffer_empty && fresh && idle {
                        job.tc_announced = true;
                        job.paused = true;
                        announce = job.tool_change.clone().map(|n| (n, job.tc_tool, job.tc_m6));
                    } else if job.tool_change.is_none() && job.next >= job.lines.len() && buffer_empty && fresh && idle {
                        finished = Some((job.lines.len(), job.errors));
                    }
                }
            }
            if finished.is_some() { inner.job = None; }
        }
        for id in stale {
            self.emit("machine-line", format!("{{\"kind\":\"timeout\",\"id\":{}}}", id));
        }
        if let Some((note, tool, m6)) = announce {
            let tool = tool.map(|n| n.to_string()).unwrap_or_else(|| "null".into());
            self.emit("machine-job-toolchange", format!("{{\"note\":{},\"tool\":{},\"m6\":{}}}", jstr(&note), tool, m6));
            self.progress(true);
        }
        if let Some((total, errors)) = finished {
            self.emit("machine-job-done", format!("{{\"aborted\":false,\"reason\":\"done\",\"acked\":{},\"sent\":{},\"total\":{},\"errors\":{}}}", total, total, total, errors));
        } else {
            self.progress(false);
        }
    }

    fn progress(&self, force: bool) {
        let json = {
            let mut inner = self.sh.inner.lock().unwrap();
            if !force && inner.last_progress.elapsed() < Duration::from_millis(250) { return; }
            inner.last_progress = Instant::now();
            let buf = inner.counter.used();
            match inner.job.as_ref() {
                Some(j) => format!("{{\"sent\":{},\"acked\":{},\"total\":{},\"paused\":{},\"toolChange\":{},\"stopping\":{},\"buffer\":{}}}",
                    j.next, j.acked, j.lines.len(), j.paused, j.tool_change.is_some(), j.stopping, buf),
                None => return,
            }
        };
        self.emit("machine-job-progress", json);
    }

    // -----------------------------------------------------------------
    // Einzelne Befehle
    // -----------------------------------------------------------------

    /// Einzelne Zeile (Konsole, $$, Joggen, Nullpunkt …). Während ein Job läuft, gesperrt.
    /// Gibt die Nummer der Zeile zurück – die Antwort ("ok"/"error") trägt dieselbe Nummer.
    /// 0 = nichts gesendet (leere Zeile / nur Kommentar).
    pub fn send_line(&self, line: &str) -> Result<u64, String> {
        let Some(clean) = clean_line(line) else { return Ok(0) };
        let len = clean.len() + 1;
        let t0 = Instant::now();
        loop {
            {
                let mut inner = self.sh.inner.lock().unwrap();
                if let Some(j) = inner.job.as_ref() {
                    if !j.paused { return Err("job running".into()); }
                }
                if inner.counter.can_send(len) {
                    let mut data = clean.clone().into_bytes();
                    data.push(b'\n');
                    {
                        let mut w = self.sh.writer.lock().map_err(|_| "writer lock".to_string())?;
                        w.write_all(&data).map_err(|e| e.to_string())?;
                        w.flush().map_err(|e| e.to_string())?;
                    }
                    let id = inner.next_id;
                    inner.next_id += 1;
                    inner.counter.push(len, Sender::Manual(id));
                    return Ok(id);
                }
            }
            if t0.elapsed() > Duration::from_secs(3) { return Err("busy".into()); }
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// Echtzeit-Befehl (ein Byte, wird sofort ausgeführt, ohne "ok")
    pub fn realtime(&self, byte: u8) -> Result<(), String> {
        if byte == RT_RESET {
            // Reset leert den Puffer des Boards -> unsere Zählung auch
            self.write_raw(&[byte])?;
            self.abort_job_internal("reset");
            if let Ok(mut inner) = self.sh.inner.lock() { inner.counter.clear(); }
            return Ok(());
        }
        self.write_raw(&[byte])
    }
}

// =====================================================================
// TESTS mit einem simulierten GRBL-Board
// =====================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Receiver, Sender as TxS};

    /// Port-Ersatz: was wir schreiben, landet beim simulierten Board; seine Antworten lesen wir
    struct FakeReader { rx: Receiver<u8> }
    impl Read for FakeReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.rx.recv_timeout(Duration::from_millis(20)) {
                Ok(b) => {
                    buf[0] = b;
                    let mut n = 1;
                    while n < buf.len() {
                        match self.rx.try_recv() { Ok(b) => { buf[n] = b; n += 1; } Err(_) => break }
                    }
                    Ok(n)
                }
                Err(_) => Err(std::io::Error::new(ErrorKind::TimedOut, "timeout")),
            }
        }
    }
    struct FakeWriter { tx: TxS<u8> }
    impl Write for FakeWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            for &b in buf { let _ = self.tx.send(b); }
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }

    /// Simuliertes GRBL: 128 Zeichen Puffer, "führt" jede Zeile nach 2 ms aus
    struct Board { max_used: Arc<Mutex<usize>>, received: Arc<Mutex<Vec<String>>>, error_on: Option<String>, silent_on: Option<String> }

    fn spawn_board(board: Board) -> (Box<dyn Read + Send>, Box<dyn Write + Send>) {
        let (to_board_tx, to_board_rx) = channel::<u8>();
        let (from_board_tx, from_board_rx) = channel::<u8>();
        thread::spawn(move || {
            let send = |s: &str| for b in s.bytes() { let _ = from_board_tx.send(b); };
            send("Grbl 1.1h ['$' for help]\r\n");
            let mut line = Vec::new();
            let mut queue: std::collections::VecDeque<String> = Default::default();
            let mut used = 0usize;
            let mut running = 0u32;
            let mut hold = false;
            loop {
                match to_board_rx.recv_timeout(Duration::from_millis(2)) {
                    Ok(b'?') => {
                        let st = if hold { "Hold:0" } else if running > 0 || !queue.is_empty() { "Run" } else { "Idle" };
                        send(&format!("<{}|MPos:1.000,2.000,3.000|FS:0,0|WCO:1.000,1.000,1.000>\r\n", st));
                    }
                    Ok(b'!') => hold = true,
                    Ok(b'~') => hold = false,
                    Ok(0x18) => { queue.clear(); used = 0; hold = false; running = 0; send("\r\nGrbl 1.1h ['$' for help]\r\n"); }
                    Ok(b'\n') => {
                        let l = String::from_utf8_lossy(&line).to_string();
                        line.clear();
                        used += l.len() + 1;
                        { let mut m = board.max_used.lock().unwrap(); if used > *m { *m = used; } }
                        board.received.lock().unwrap().push(l.clone());
                        queue.push_back(l);
                    }
                    Ok(b) => line.push(b),
                    Err(_) => {}
                }
                // eine Zeile "ausführen"
                if !hold {
                    if let Some(l) = queue.pop_front() {
                        used -= l.len() + 1;
                        running = 3;
                        if board.silent_on.as_deref() == Some(l.as_str()) { /* Antwort geht verloren */ }
                        else if board.error_on.as_deref() == Some(l.as_str()) { send("error:20\r\n"); } else { send("ok\r\n"); }
                    } else if running > 0 { running -= 1; }
                }
            }
        });
        (Box::new(FakeReader { rx: from_board_rx }), Box::new(FakeWriter { tx: to_board_tx }))
    }

    fn collect() -> (Emit, Arc<Mutex<Vec<(String, String)>>>) {
        let ev: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let e2 = ev.clone();
        let emit: Emit = Arc::new(move |n: &str, j: String| e2.lock().unwrap().push((n.to_string(), j)));
        (emit, ev)
    }

    fn wait_for(ev: &Arc<Mutex<Vec<(String, String)>>>, name: &str, secs: u64) -> Option<String> {
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(secs) {
            if let Some((_, j)) = ev.lock().unwrap().iter().find(|(n, _)| n == name) { return Some(j.clone()); }
            thread::sleep(Duration::from_millis(10));
        }
        None
    }

    fn job(n: usize) -> Vec<String> {
        let mut v = vec!["G21 (mm)".to_string(), "G90".to_string()];
        for i in 0..n { v.push(format!("G1 X{}.123 Y{}.456 F1000 ; Kommentar", i, i)); }
        v
    }

    #[test]
    fn welcome_status_and_full_job() {
        let max_used = Arc::new(Mutex::new(0));
        let received = Arc::new(Mutex::new(Vec::new()));
        let (r, w) = spawn_board(Board { max_used: max_used.clone(), received: received.clone(), error_on: None, silent_on: None });
        let (emit, ev) = collect();
        let m = Machine::start(r, w, emit);
        let wel = wait_for(&ev, "machine-welcome", 2).expect("welcome");
        assert!(wel.contains("\"GRBL\""));
        let st = wait_for(&ev, "machine-status", 2).expect("status");
        assert!(st.contains("\"wpos\":[0,1,2]"), "{}", st); // MPos - WCO
        assert_eq!(m.start_job(job(200)).unwrap(), 202);
        let done = wait_for(&ev, "machine-job-done", 10).expect("job done");
        assert!(done.contains("\"aborted\":false"), "{}", done);
        assert_eq!(received.lock().unwrap().len(), 202);
        assert!(*max_used.lock().unwrap() <= 127, "buffer overflow: {}", max_used.lock().unwrap());
        assert_eq!(received.lock().unwrap()[2], "G1 X0.123 Y0.456 F1000");
        m.shutdown();
    }

    #[test]
    fn tool_change_pauses_and_resumes() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let (r, w) = spawn_board(Board { max_used: Arc::new(Mutex::new(0)), received: received.clone(), error_on: None, silent_on: None });
        let (emit, ev) = collect();
        let m = Machine::start(r, w, emit);
        wait_for(&ev, "machine-status", 2).unwrap();
        let mut lines = job(5);
        lines.push("M5".into());
        lines.push("M0 (WERKZEUGWECHSEL 2: 6 mm Fraeser)".into());
        lines.push("M3 S12000".into());
        lines.push("G1 X9 Y9".into());
        m.start_job(lines).unwrap();
        let tc = wait_for(&ev, "machine-job-toolchange", 5).expect("tool change");
        assert!(tc.contains("6 mm Fraeser"));
        assert!(!received.lock().unwrap().iter().any(|l| l == "M0"), "M0 must not be sent");
        assert!(!received.lock().unwrap().iter().any(|l| l == "M3 S12000"), "must wait at tool change");
        assert!(wait_for(&ev, "machine-job-done", 1).is_none());
        // während der Pause darf man joggen / nullen
        m.send_line("G10 L20 P1 Z0").unwrap();
        m.resume_job().unwrap();
        let done = wait_for(&ev, "machine-job-done", 5).expect("done");
        assert!(done.contains("\"aborted\":false"));
        assert!(received.lock().unwrap().iter().any(|l| l == "M3 S12000"));
        m.shutdown();
    }

    #[test]
    fn m6_tool_change_reports_tool_number() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let (r, w) = spawn_board(Board { max_used: Arc::new(Mutex::new(0)), received: received.clone(), error_on: None, silent_on: None });
        let (emit, ev) = collect();
        let m = Machine::start(r, w, emit);
        wait_for(&ev, "machine-status", 2).unwrap();
        let mut lines = job(3);
        lines.push("T4".into());
        lines.push("M6 (TOOL CHANGE 2)".into());
        lines.push("M3 S12000".into());
        lines.push("M6 T7".into());
        lines.push("G1 X9 Y9".into());
        m.start_job(lines).unwrap();
        let tc = wait_for(&ev, "machine-job-toolchange", 5).expect("tool change");
        assert!(tc.contains("\"tool\":4") && tc.contains("\"m6\":true"), "{}", tc);
        assert!(!received.lock().unwrap().iter().any(|l| l.starts_with("M6")), "M6 must not be sent");
        ev.lock().unwrap().retain(|(n, _)| n != "machine-job-toolchange");
        m.resume_job().unwrap();
        let tc = wait_for(&ev, "machine-job-toolchange", 5).expect("second tool change");
        assert!(tc.contains("\"tool\":7"), "{}", tc);
        m.resume_job().unwrap();
        let done = wait_for(&ev, "machine-job-done", 5).expect("done");
        assert!(done.contains("\"aborted\":false"));
        assert!(received.lock().unwrap().iter().any(|l| l == "G1 X9 Y9"));
        m.shutdown();
    }

    #[test]
    fn error_pauses_job() {
        let (r, w) = spawn_board(Board { max_used: Arc::new(Mutex::new(0)), received: Arc::new(Mutex::new(Vec::new())), error_on: Some("G1 X3.123 Y3.456 F1000".into()), silent_on: None });
        let (emit, ev) = collect();
        let m = Machine::start(r, w, emit);
        wait_for(&ev, "machine-status", 2).unwrap();
        m.start_job(job(50)).unwrap();
        let err = wait_for(&ev, "machine-job-error", 5).expect("error event");
        assert!(err.contains("\"code\":20"), "{}", err);
        assert!(err.contains("X3.123"));
        thread::sleep(Duration::from_millis(400));
        assert!(wait_for(&ev, "machine-job-done", 1).is_none(), "paused job must not finish");
        assert!(m.send_line("$X").is_ok(), "manual commands allowed while paused");
        m.resume_job().unwrap();
        let done = wait_for(&ev, "machine-job-done", 5).expect("done");
        assert!(done.contains("\"errors\":1"), "{}", done);
        m.shutdown();
    }

    #[test]
    fn stop_job_holds_then_resets() {
        let (r, w) = spawn_board(Board { max_used: Arc::new(Mutex::new(0)), received: Arc::new(Mutex::new(Vec::new())), error_on: None, silent_on: None });
        let (emit, ev) = collect();
        let m = Machine::start(r, w, emit);
        wait_for(&ev, "machine-status", 2).unwrap();
        m.start_job(job(5000)).unwrap();
        thread::sleep(Duration::from_millis(150));
        assert!(m.send_line("G0 X0").is_err(), "manual blocked while running");
        m.stop_job().unwrap();
        let done = wait_for(&ev, "machine-job-done", 5).expect("done");
        assert!(done.contains("\"aborted\":true"), "{}", done);
        // nach Stopp ist die Zählung leer -> neue Befehle gehen sofort
        thread::sleep(Duration::from_millis(100));
        assert!(m.send_line("$$").is_ok());
        m.shutdown();
    }

    #[test]
    fn lost_answer_does_not_shift_later_answers() {
        let (r, w) = spawn_board(Board { max_used: Arc::new(Mutex::new(0)), received: Arc::new(Mutex::new(Vec::new())), error_on: None, silent_on: Some("$I".into()) });
        let (emit, ev) = collect();
        let m = Machine::start(r, w, emit);
        wait_for(&ev, "machine-status", 2).unwrap();
        let id_i = m.send_line("$I").unwrap();
        thread::sleep(Duration::from_millis(100));
        // solange die verlorene Antwort noch "aussteht", bekommt die nächste Zeile ihr "ok" unter falscher Nummer …
        // … aber nach STALE_MANUAL wird aufgeräumt und danach stimmt alles wieder
        thread::sleep(STALE_MANUAL + Duration::from_millis(600));
        let timeouts: Vec<String> = ev.lock().unwrap().iter().filter(|(n, j)| n == "machine-line" && j.contains("timeout")).map(|(_, j)| j.clone()).collect();
        assert_eq!(timeouts.len(), 1, "{:?}", timeouts);
        assert!(timeouts[0].contains(&format!("\"id\":{}", id_i)));
        let id2 = m.send_line("$100=80").unwrap();
        let t0 = Instant::now();
        let mut ok_for_id2 = false;
        while t0.elapsed() < Duration::from_secs(2) && !ok_for_id2 {
            ok_for_id2 = ev.lock().unwrap().iter().any(|(n, j)| n == "machine-line" && j.contains("\"kind\":\"ok\"") && j.contains(&format!("\"id\":{}", id2)));
            thread::sleep(Duration::from_millis(10));
        }
        assert!(ok_for_id2, "answer must carry the right id");
        assert_eq!(m.send_line("(nur Kommentar)").unwrap(), 0);
        m.shutdown();
    }

    #[test]
    fn patch_cannot_touch_sent_lines() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let (r, w) = spawn_board(Board { max_used: Arc::new(Mutex::new(0)), received: received.clone(), error_on: None, silent_on: None });
        let (emit, ev) = collect();
        let m = Machine::start(r, w, emit);
        wait_for(&ev, "machine-status", 2).unwrap();
        let mut lines = job(3);
        lines.push("M0 (WECHSEL)".into()); // hält den Job an, damit nichts weiterläuft
        for i in 0..20 { lines.push(format!("G1 X{} Y1", i)); }
        let total = m.start_job(lines).unwrap();
        wait_for(&ev, "machine-job-toolchange", 5).expect("paused at M0");
        let floor = m.patch_floor().unwrap();
        assert_eq!(floor, 6 + PATCH_MARGIN); // 5 Zeilen + M0 sind "weg", dahinter der Abstand
        // gesendete oder zu nahe Zeilen: abgelehnt, nichts verändert
        assert_eq!(m.patch_job(2, 1, vec!["G0 X0".into()], total), Err("locked".into()));
        assert_eq!(m.patch_job(floor - 1, 1, vec!["G0 X0".into()], total), Err("locked".into()));
        assert_eq!(m.patch_job(floor, 0, vec!["(nur Kommentar)".into()], total), Err("empty line".into()));
        assert_eq!(m.patch_job(floor, 100, vec![], total), Err("range".into()));
        assert_eq!(m.patch_job(floor, 1, vec![], total + 1), Err("changed".into()));
        // erlaubt: eine Zeile ersetzen, eine löschen, zwei einfügen -> Zeilenzahl stimmt
        let t2 = m.patch_job(floor, 2, vec!["G1 X99 Y99 F500 (neu)".into(), "M0 (PAUSE)".into(), "G1 X98".into()], total).unwrap();
        assert_eq!(t2, total + 1);
        let t3 = m.patch_job(t2, 0, vec!["G0 Z5".into()], t2).unwrap(); // am Ende anhängen
        assert_eq!(t3, t2 + 1);
        // Fortschritt meldet die neue Gesamtzahl
        ev.lock().unwrap().clear();
        m.resume_job().unwrap();
        let p = wait_for(&ev, "machine-job-progress", 2).expect("progress");
        assert!(p.contains(&format!("\"total\":{}", t3)), "{}", p);
        // die eingefügte Pause hält an
        let tc = wait_for(&ev, "machine-job-toolchange", 5).expect("inserted M0");
        assert!(tc.contains("PAUSE"), "{}", tc);
        m.resume_job().unwrap();
        let done = wait_for(&ev, "machine-job-done", 5).expect("done");
        assert!(done.contains(&format!("\"total\":{}", t3)), "{}", done);
        let rec = received.lock().unwrap().clone();
        // alte Zeilen vor dem Bereich unverändert gesendet, ersetzte nie
        assert!(rec.iter().any(|l| l == "G1 X0 Y1"));
        assert!(!rec.iter().any(|l| l == &format!("G1 X{} Y1", floor - 6)), "replaced line must not be sent");
        assert!(!rec.iter().any(|l| l == &format!("G1 X{} Y1", floor - 5)), "deleted line must not be sent");
        let pos = |s: &str| rec.iter().position(|l| l == s).unwrap_or_else(|| panic!("{} missing", s));
        assert!(pos("G1 X99 Y99 F500") < pos("G1 X98"));
        assert_eq!(rec.last().unwrap(), "G0 Z5");
        // alle Zeilen außer den zwei M0 wurden genau einmal gesendet
        assert_eq!(rec.len(), t3 - 2);
        m.shutdown();
    }

    #[test]
    fn patch_without_job_or_while_stopping() {
        let (r, w) = spawn_board(Board { max_used: Arc::new(Mutex::new(0)), received: Arc::new(Mutex::new(Vec::new())), error_on: None, silent_on: None });
        let (emit, ev) = collect();
        let m = Machine::start(r, w, emit);
        wait_for(&ev, "machine-status", 2).unwrap();
        assert_eq!(m.patch_job(0, 0, vec!["G0 X0".into()], 0), Err("no job".into()));
        assert!(m.patch_floor().is_none());
        let total = m.start_job(job(5000)).unwrap();
        m.stop_job().unwrap();
        assert_eq!(m.patch_job(4000, 1, vec![], total), Err("stopping".into()));
        wait_for(&ev, "machine-job-done", 5).expect("done");
        m.shutdown();
    }

    #[test]
    fn json_escape() {
        assert_eq!(jstr("a\"b\\c\n"), "\"a\\\"b\\\\c\\n\"");
        assert_eq!(jnum(Some(1.23456)), "1.235");
        assert_eq!(jnum(None), "null");
    }
}
