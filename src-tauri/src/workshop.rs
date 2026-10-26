//! SMARTE WERKSTATT: Geräte (Absaugung, Kompressor …) mit dem Job ein- und ausschalten
//!
//! Geräte hängen an smarten Steckdosen (Shelly, Tasmota, Home Assistant …) und werden über
//!   - HTTP (GET/POST/PUT an eine Adresse, optional mit Text und „Bearer“-Schlüssel) oder
//!   - MQTT (Nachricht an einen Broker: Host, Port, optional Benutzer/Passwort, Thema, Inhalt)
//! geschaltet. Nur http:// bzw. MQTT ohne TLS – die Geräte stehen im eigenen Netz. Keine Zusatz-Bibliothek.
//!
//! Ablauf:
//!   - Job startet (irgendeine Maschine) → „Ein“ an alle aktivierten Geräte
//!   - Job endet (fertig, abgebrochen, Verbindung getrennt) und keine andere Maschine arbeitet noch →
//!     je Gerät nach der eingestellten Wartezeit (Nachlauf, z. B. 30 s) „Aus“
//!   - Startet in der Wartezeit ein neuer Job, entfällt das Ausschalten
//!
//! Die Anfragen laufen in eigenen Threads (ein Arbeits-Thread je Gerät, damit „Ein“ und „Aus“ in der
//! richtigen Reihenfolge ankommen) mit kurzen Zeitlimits. Fehler beeinflussen den Job nie – sie werden
//! nur gemeldet (Ereignis `workshop-action`). Passwörter/Schlüssel kommen in keiner Meldung vor.
//! Ohne Tauri – das Senden ist austauschbar, die Tests laufen mit einem falschen Sender ohne Netzwerk.

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

/// Zeitlimit für Verbinden und Antwort (je Anfrage)
pub const TIMEOUT: Duration = Duration::from_secs(4);
/// Längster Nachlauf (1 Stunde)
pub const MAX_DELAY_S: f64 = 3600.0;

/// Ein Gerät, wie es die Oberfläche schickt (Einstellung `cnc_craft_workshop_devices`)
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    /// "http" oder "mqtt"
    pub kind: String,
    pub enabled: bool,
    /// Nachlauf nach dem Job in Sekunden
    pub delay: f64,
    // --- HTTP ---
    /// GET, POST oder PUT
    pub method: String,
    pub on_url: String,
    pub on_body: String,
    pub off_url: String,
    pub off_body: String,
    /// optional: „Authorization: Bearer …“ (z. B. Home Assistant)
    pub token: String,
    // --- MQTT ---
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub topic: String,
    pub on_payload: String,
    pub off_payload: String,
}

/// Schickt „Ein“ (true) oder „Aus“ (false) an ein Gerät
pub type SendFn = Arc<dyn Fn(&Device, bool) -> Result<(), String> + Send + Sync>;
/// Meldet das Ergebnis: Gerät, ein/aus, Anlass ("job-start", "job-end", "test"), Fehler (None = ok)
pub type ReportFn = Arc<dyn Fn(&Device, bool, &str, Option<String>) + Send + Sync>;

struct State {
    devices: Vec<Device>,
    /// Maschinen (Kennung wie "m1"), die gerade einen Job haben
    running: HashSet<String>,
    /// Zählt bei jedem Job-Start hoch – ein wartendes „Aus“ mit älterem Stand entfällt
    generation: u64,
    /// Arbeits-Thread je Gerät (Kennung)
    workers: HashMap<String, mpsc::Sender<(Device, bool, String)>>,
}

#[derive(Clone)]
pub struct Workshop {
    state: Arc<Mutex<State>>,
    send: SendFn,
    report: ReportFn,
}

impl Workshop {
    pub fn new(send: SendFn, report: ReportFn) -> Workshop {
        Workshop {
            state: Arc::new(Mutex::new(State { devices: Vec::new(), running: HashSet::new(), generation: 0, workers: HashMap::new() })),
            send,
            report,
        }
    }

    pub fn set_devices(&self, devices: Vec<Device>) {
        if let Ok(mut st) = self.state.lock() {
            st.devices = devices;
        }
    }

    /// Anfrage in die Schlange des Geräts stellen (läuft in dessen Arbeits-Thread)
    fn queue(&self, st: &mut State, dev: &Device, on: bool, why: &str) {
        let key = if dev.id.is_empty() { dev.name.clone() } else { dev.id.clone() };
        let job = (dev.clone(), on, why.to_string());
        if let Some(tx) = st.workers.get(&key) {
            if tx.send(job.clone()).is_ok() {
                return;
            }
        }
        let (tx, rx) = mpsc::channel::<(Device, bool, String)>();
        let send = self.send.clone();
        let report = self.report.clone();
        thread::spawn(move || {
            for (d, on, why) in rx {
                let r = send(&d, on);
                report(&d, on, &why, r.err());
            }
        });
        let _ = tx.send(job);
        st.workers.insert(key, tx);
    }

    /// Eine Maschine hat einen Job gestartet
    pub fn job_started(&self, conn: &str) {
        let Ok(mut st) = self.state.lock() else { return };
        st.running.insert(conn.to_string());
        st.generation += 1; // wartendes „Aus“ entfällt
        let devs: Vec<Device> = st.devices.iter().filter(|d| d.enabled).cloned().collect();
        for d in &devs {
            self.queue(&mut st, d, true, "job-start");
        }
    }

    /// Job einer Maschine ist zu Ende (fertig, abgebrochen, getrennt). Mehrfach-Aufrufe schaden nicht.
    pub fn job_ended(&self, conn: &str) {
        let Ok(mut st) = self.state.lock() else { return };
        if !st.running.remove(conn) || !st.running.is_empty() {
            return; // kein Job auf dieser Maschine – oder eine andere arbeitet noch
        }
        let generation = st.generation;
        let devs: Vec<Device> = st.devices.iter().filter(|d| d.enabled).cloned().collect();
        drop(st);
        for d in devs {
            let me = self.clone();
            let wait = Duration::from_secs_f64(d.delay.clamp(0.0, MAX_DELAY_S));
            thread::spawn(move || {
                let until = Instant::now() + wait;
                // in kleinen Schritten warten: ein neuer Job bricht das Warten gleich ab
                loop {
                    {
                        let Ok(st) = me.state.lock() else { return };
                        if st.generation != generation || !st.running.is_empty() {
                            return;
                        }
                    }
                    let left = until.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    thread::sleep(left.min(Duration::from_millis(100)));
                }
                let Ok(mut st) = me.state.lock() else { return };
                if st.generation == generation && st.running.is_empty() {
                    me.queue(&mut st, &d, false, "job-end");
                }
            });
        }
    }
}

// ---------------------------------------------------------------------
// Für die App: eine gemeinsame Werkstatt (lib.rs ruft das bei Job-Start/-Ende auf)
// ---------------------------------------------------------------------

static WORKSHOP: OnceLock<Workshop> = OnceLock::new();

/// Beim Programmstart: mit echtem Sender und Meldung an die Oberfläche
pub fn init(report: ReportFn) {
    let _ = WORKSHOP.set(Workshop::new(Arc::new(send_real), report));
}

pub fn global() -> Option<&'static Workshop> {
    WORKSHOP.get()
}

pub fn job_started(conn: &str) {
    if let Some(w) = global() { w.job_started(conn); }
}

pub fn job_ended(conn: &str) {
    if let Some(w) = global() { w.job_ended(conn); }
}

// ---------------------------------------------------------------------
// Echt senden: HTTP oder MQTT
// ---------------------------------------------------------------------

pub fn send_real(d: &Device, on: bool) -> Result<(), String> {
    match d.kind.as_str() {
        "mqtt" => {
            let payload = if on { &d.on_payload } else { &d.off_payload };
            mqtt_publish(&d.host, if d.port == 0 { 1883 } else { d.port }, &d.user, &d.password, &d.topic, payload.as_bytes(), TIMEOUT)
        }
        _ => {
            let (url, body) = if on { (&d.on_url, &d.on_body) } else { (&d.off_url, &d.off_body) };
            let code = http_request(&d.method, url, body, &d.token, TIMEOUT)?;
            if (200..300).contains(&code) { Ok(()) } else { Err(format!("HTTP {}", code)) }
        }
    }
}

fn connect(host: &str, port: u16, timeout: Duration) -> Result<TcpStream, String> {
    if host.trim().is_empty() {
        return Err("no-host".into());
    }
    let addr = (host.trim(), port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or_else(|| "bad-host".to_string())?;
    let s = TcpStream::connect_timeout(&addr, timeout).map_err(|e| e.to_string())?;
    let _ = s.set_read_timeout(Some(timeout));
    let _ = s.set_write_timeout(Some(timeout));
    Ok(s)
}

/// Anfrage als Text (ohne Netzwerk testbar)
pub fn http_request_text(method: &str, host: &str, port: u16, path: &str, body: &str, token: &str) -> String {
    let m = match method.trim().to_ascii_uppercase().as_str() {
        "POST" => "POST",
        "PUT" => "PUT",
        _ => "GET",
    };
    let hostname = if port == 80 { host.to_string() } else { format!("{}:{}", host, port) };
    let mut req = format!("{} {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: CNC-Craft\r\nConnection: close\r\n", m, path, hostname);
    // Zeilenumbrüche im Schlüssel würden eigene Kopfzeilen einschleusen
    let token: String = token.chars().filter(|c| !c.is_control()).collect();
    if !token.trim().is_empty() {
        req.push_str(&format!("Authorization: Bearer {}\r\n", token.trim()));
    }
    if m != "GET" || !body.is_empty() {
        let ct = if body.trim_start().starts_with('{') || body.trim_start().starts_with('[') { "application/json" } else { "text/plain" };
        req.push_str(&format!("Content-Type: {}\r\nContent-Length: {}\r\n", ct, body.len()));
    }
    req.push_str("\r\n");
    req.push_str(body);
    req
}

/// HTTP-Anfrage schicken, gibt den Status zurück (200 …). Nur http://
pub fn http_request(method: &str, url: &str, body: &str, token: &str, timeout: Duration) -> Result<u16, String> {
    let (host, port, path) = crate::camfetch::parse_url(url)?;
    let mut s = connect(&host, port, timeout)?;
    s.write_all(http_request_text(method, &host, port, &path, body, token).as_bytes()).map_err(|e| e.to_string())?;
    // Nur die Statuszeile lesen
    let deadline = Instant::now() + timeout;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while Instant::now() < deadline && !buf.contains(&b'\n') && buf.len() < 8192 {
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) => return Err(e.to_string()),
        }
    }
    let line = String::from_utf8_lossy(&buf);
    line.lines().next().and_then(|l| l.split_whitespace().nth(1)).and_then(|c| c.parse().ok()).ok_or_else(|| "no-answer".to_string())
}

/// MQTT-Länge (1–4 Bytes, je 7 Bit)
fn mqtt_len(mut n: usize, out: &mut Vec<u8>) {
    loop {
        let mut b = (n % 128) as u8;
        n /= 128;
        if n > 0 { b |= 0x80; }
        out.push(b);
        if n == 0 { break; }
    }
}

fn mqtt_str(s: &[u8], out: &mut Vec<u8>) {
    out.extend_from_slice(&(s.len() as u16).to_be_bytes());
    out.extend_from_slice(s);
}

/// CONNECT-Paket (MQTT 3.1.1, „clean session“)
pub fn mqtt_connect_packet(client_id: &str, user: &str, password: &str) -> Vec<u8> {
    let mut v = Vec::new();
    mqtt_str(b"MQTT", &mut v);
    v.push(4); // Version 3.1.1
    let mut flags = 0x02u8;
    if !user.is_empty() { flags |= 0x80; }
    if !user.is_empty() && !password.is_empty() { flags |= 0x40; }
    v.push(flags);
    v.extend_from_slice(&30u16.to_be_bytes()); // keep alive
    mqtt_str(client_id.as_bytes(), &mut v);
    if !user.is_empty() {
        mqtt_str(user.as_bytes(), &mut v);
        if !password.is_empty() { mqtt_str(password.as_bytes(), &mut v); }
    }
    let mut p = vec![0x10];
    mqtt_len(v.len(), &mut p);
    p.extend(v);
    p
}

/// PUBLISH-Paket (QoS 0, nicht behalten)
pub fn mqtt_publish_packet(topic: &str, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    mqtt_str(topic.as_bytes(), &mut v);
    v.extend_from_slice(payload);
    let mut p = vec![0x30];
    mqtt_len(v.len(), &mut p);
    p.extend(v);
    p
}

/// Eine Nachricht an den Broker schicken: verbinden, auf CONNACK warten, PUBLISH, trennen
pub fn mqtt_publish(host: &str, port: u16, user: &str, password: &str, topic: &str, payload: &[u8], timeout: Duration) -> Result<(), String> {
    if topic.trim().is_empty() || topic.contains('+') || topic.contains('#') {
        return Err("bad-topic".into());
    }
    let mut s = connect(host, port, timeout)?;
    let client = format!("cnc-craft-{}", std::process::id());
    s.write_all(&mqtt_connect_packet(&client, user, password)).map_err(|e| e.to_string())?;
    let mut ack = [0u8; 4];
    s.read_exact(&mut ack).map_err(|e| e.to_string())?;
    if ack[0] != 0x20 || ack[1] != 0x02 {
        return Err("mqtt-bad-answer".into());
    }
    match ack[3] {
        0 => {}
        4 | 5 => return Err("mqtt-login-refused".into()),
        c => return Err(format!("mqtt-refused-{}", c)),
    }
    s.write_all(&mqtt_publish_packet(topic.trim(), payload)).map_err(|e| e.to_string())?;
    s.write_all(&[0xE0, 0x00]).map_err(|e| e.to_string())?; // DISCONNECT
    let _ = s.flush();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    type Log = Arc<Mutex<Vec<(String, bool, String)>>>;

    fn dev(id: &str, delay: f64, enabled: bool) -> Device {
        Device { id: id.into(), name: id.into(), kind: "http".into(), enabled, delay, ..Default::default() }
    }

    /// Werkstatt mit falschem Sender: merkt sich (Gerät, ein/aus, Anlass)
    fn fake() -> (Workshop, Log) {
        let log: Log = Arc::new(Mutex::new(Vec::new()));
        let l2 = log.clone();
        let w = Workshop::new(
            Arc::new(|_d: &Device, _on: bool| Ok(())),
            Arc::new(move |d: &Device, on: bool, why: &str, _e: Option<String>| l2.lock().unwrap().push((d.id.clone(), on, why.to_string()))),
        );
        (w, log)
    }

    fn wait_count(log: &Log, n: usize, ms: u64) -> Vec<(String, bool, String)> {
        let until = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < until && log.lock().unwrap().len() < n {
            thread::sleep(Duration::from_millis(10));
        }
        log.lock().unwrap().clone()
    }

    #[test]
    fn start_switches_enabled_devices_on() {
        let (w, log) = fake();
        w.set_devices(vec![dev("dust", 0.2, true), dev("air", 0.2, false)]);
        w.job_started("m1");
        let got = wait_count(&log, 1, 1000);
        assert_eq!(got, vec![("dust".to_string(), true, "job-start".to_string())]);
        thread::sleep(Duration::from_millis(100));
        assert_eq!(log.lock().unwrap().len(), 1, "disabled device must stay untouched");
    }

    #[test]
    fn off_comes_after_the_delay() {
        let (w, log) = fake();
        w.set_devices(vec![dev("dust", 0.4, true)]);
        w.job_started("m1");
        wait_count(&log, 1, 1000);
        let t0 = Instant::now();
        w.job_ended("m1");
        thread::sleep(Duration::from_millis(200));
        assert_eq!(log.lock().unwrap().len(), 1, "no off before the delay");
        let got = wait_count(&log, 2, 2000);
        assert_eq!(got[1], ("dust".to_string(), false, "job-end".to_string()));
        assert!(t0.elapsed() >= Duration::from_millis(400));
    }

    #[test]
    fn abort_and_double_end_send_one_off() {
        // Abbruch meldet job-done UND danach evtl. getrennt – nur ein „Aus“
        let (w, log) = fake();
        w.set_devices(vec![dev("dust", 0.1, true)]);
        w.job_started("m1");
        w.job_ended("m1");
        w.job_ended("m1");
        thread::sleep(Duration::from_millis(500));
        let got = log.lock().unwrap().clone();
        assert_eq!(got.iter().filter(|e| !e.1).count(), 1, "{:?}", got);
    }

    #[test]
    fn new_start_cancels_pending_off() {
        let (w, log) = fake();
        w.set_devices(vec![dev("dust", 0.3, true)]);
        w.job_started("m1");
        w.job_ended("m1");
        thread::sleep(Duration::from_millis(100));
        w.job_started("m1");
        thread::sleep(Duration::from_millis(600));
        let got = log.lock().unwrap().clone();
        assert!(got.iter().all(|e| e.1), "pending off must be cancelled: {:?}", got);
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn other_machine_still_running_keeps_devices_on() {
        let (w, log) = fake();
        w.set_devices(vec![dev("dust", 0.1, true)]);
        w.job_started("m1");
        w.job_started("m2");
        w.job_ended("m1");
        thread::sleep(Duration::from_millis(400));
        assert!(log.lock().unwrap().iter().all(|e| e.1));
        w.job_ended("m2");
        let got = wait_count(&log, 3, 1000);
        assert_eq!(got.last().unwrap().1, false);
    }

    #[test]
    fn end_without_start_does_nothing() {
        let (w, log) = fake();
        w.set_devices(vec![dev("dust", 0.0, true)]);
        w.job_ended("m1");
        thread::sleep(Duration::from_millis(200));
        assert!(log.lock().unwrap().is_empty());
    }

    #[test]
    fn failed_send_is_reported_not_fatal() {
        let errs = Arc::new(Mutex::new(Vec::new()));
        let e2 = errs.clone();
        let w = Workshop::new(
            Arc::new(|_d: &Device, _on: bool| Err("timed out".to_string())),
            Arc::new(move |_d: &Device, _on: bool, _w: &str, e: Option<String>| e2.lock().unwrap().push(e)),
        );
        w.set_devices(vec![dev("dust", 0.0, true)]);
        w.job_started("m1");
        w.job_ended("m1");
        let until = Instant::now() + Duration::from_secs(1);
        while Instant::now() < until && errs.lock().unwrap().len() < 2 { thread::sleep(Duration::from_millis(10)); }
        assert_eq!(*errs.lock().unwrap(), vec![Some("timed out".to_string()), Some("timed out".to_string())]);
    }

    #[test]
    fn http_text() {
        let get = http_request_text("get", "192.168.1.5", 80, "/relay/0?turn=on", "", "");
        assert!(get.starts_with("GET /relay/0?turn=on HTTP/1.1\r\nHost: 192.168.1.5\r\n"));
        assert!(!get.contains("Content-Length"));
        let post = http_request_text("POST", "ha.local", 8123, "/api/webhook/x", "{\"a\":1}", "abc\r\nX: y");
        assert!(post.contains("Host: ha.local:8123\r\n"));
        assert!(post.contains("Authorization: Bearer abcX: y\r\n"), "no header injection: {}", post);
        assert!(post.contains("Content-Type: application/json\r\nContent-Length: 7\r\n\r\n{\"a\":1}"));
    }

    #[test]
    fn http_against_local_server() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(String::new()));
        let s2 = seen.clone();
        thread::spawn(move || {
            for code in ["200 OK", "500 Internal Server Error"] {
                let (mut c, _) = l.accept().unwrap();
                let mut b = [0u8; 2048];
                let n = c.read(&mut b).unwrap();
                *s2.lock().unwrap() = String::from_utf8_lossy(&b[..n]).to_string();
                let _ = c.write_all(format!("HTTP/1.1 {}\r\nContent-Length: 0\r\n\r\n", code).as_bytes());
            }
        });
        let mut d = dev("plug", 0.0, true);
        d.on_url = format!("http://127.0.0.1:{}/cm?cmnd=Power%20On", port);
        d.off_url = d.on_url.clone();
        assert_eq!(send_real(&d, true), Ok(()));
        assert!(seen.lock().unwrap().starts_with("GET /cm?cmnd=Power%20On HTTP/1.1"));
        assert_eq!(send_real(&d, false), Err("HTTP 500".to_string()));
        assert_eq!(http_request("GET", "https://x/", "", "", TIMEOUT), Err("https-not-supported".to_string()));
    }

    #[test]
    fn mqtt_packets() {
        let c = mqtt_connect_packet("id", "u", "pw");
        assert_eq!(c[0], 0x10);
        assert_eq!(c[1] as usize, c.len() - 2);
        assert_eq!(&c[2..8], b"\x00\x04MQTT");
        assert_eq!(c[8], 4);
        assert_eq!(c[9], 0xC2);
        let p = mqtt_publish_packet("cmnd/plug/POWER", b"ON");
        assert_eq!(p, [&[0x30, 19, 0, 15][..], b"cmnd/plug/POWER", b"ON"].concat());
        let mut long = Vec::new();
        mqtt_len(321, &mut long);
        assert_eq!(long, vec![0xC1, 0x02]);
    }

    #[test]
    fn mqtt_against_fake_broker() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let got = Arc::new(Mutex::new(Vec::new()));
        let g2 = got.clone();
        thread::spawn(move || {
            for rc in [0u8, 5] {
                let (mut c, _) = l.accept().unwrap();
                let mut hdr = [0u8; 2];
                c.read_exact(&mut hdr).unwrap();
                let mut rest = vec![0u8; hdr[1] as usize];
                c.read_exact(&mut rest).unwrap();
                c.write_all(&[0x20, 0x02, 0x00, rc]).unwrap();
                let mut all = Vec::new();
                let _ = c.set_read_timeout(Some(Duration::from_millis(500)));
                let _ = c.read_to_end(&mut all);
                g2.lock().unwrap().push(all);
            }
        });
        let mut d = dev("air", 0.0, true);
        d.kind = "mqtt".into();
        d.host = "127.0.0.1".into();
        d.port = port;
        d.topic = "cmnd/air/POWER".into();
        d.on_payload = "ON".into();
        assert_eq!(send_real(&d, true), Ok(()));
        let until = Instant::now() + Duration::from_secs(2);
        while Instant::now() < until && got.lock().unwrap().is_empty() { thread::sleep(Duration::from_millis(10)); }
        let first = got.lock().unwrap()[0].clone();
        assert_eq!(first, [mqtt_publish_packet("cmnd/air/POWER", b"ON"), vec![0xE0, 0x00]].concat());
        d.user = "u".into();
        d.password = "geheim".into();
        let e = send_real(&d, false).unwrap_err();
        assert_eq!(e, "mqtt-login-refused");
        assert!(!e.contains("geheim"));
    }
}
