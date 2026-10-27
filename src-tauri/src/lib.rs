//! CNC CRAFT – Rust-Teil (Tauri)
//!
//! Module:
//!   grbl.rs    – GRBL-Protokoll (Antworten verstehen, Puffer zählen) – reine Logik mit Tests
//!   machine.rs – Verbindung zur GRBL-Maschine: Lesen, Status, Job senden, Pause/Stopp, Werkzeugwechsel
//!   k40.rs     – K40 mit Original-Board (M2 Nano …): EGV-Sprache, Pakete, Status – testbar ohne Hardware
//!   usb_k40.rs – USB-Zugriff auf das K40-Board (CH341 über libusb)
//!   marlin.rs  – Marlin-Maschinen (Creality, Anycubic, MPCNC …): Ping-Pong-Senden, M114-Position
//!   ruida.rs   – CO₂-Laser mit Ruida-Steuerung: RD-Auftrag bauen, Netzwerk (UDP) / USB, Status
//!   serial.rs  – Ports auflisten (mit Chip-Erkennung) und öffnen
//!   elfimg.rs  – .elf-Programme in flashbare ESP-Abbilder umwandeln (wie esptool elf2image)
//!   flash.rs   – Firmware flashen: ESP32/ESP32-S3 (MKS DLC32 …) und Arduino (GRBL) – ohne Zusatzprogramm
//!   fonts.rs   – Systemschriften für das Text-Werkzeug auflisten und laden
//!   workshop.rs – Werkstatt-Geräte (Absaugung, Kompressor …) per HTTP/MQTT mit dem Job schalten
//!   controller.rs – gemeinsame Schnittstelle aller Steuerungen (MachineController)
//!   modbus.rs  – Modbus TCP/RTU (async, Zeitlimit + Wiederholen) – Rahmen/CRC mit Tests
//!   vfd.rs     – Frequenzumrichter (Spindel) per Modbus: Drehzahl, Richtung, Störung – Profile
//!
//! Die Oberfläche ruft die Befehle unten per invoke(...) auf und bekommt Ereignisse:
//!   machine-welcome, machine-status, machine-line, machine-alarm, machine-disconnected,
//!   machine-job-progress, machine-job-error, machine-job-toolchange, machine-job-done,
//!   flash-progress, workshop-action
//! GRBL und Ruida melden dieselben Ereignisse – die Oberfläche muss kaum unterscheiden.

mod cam3d;
mod controller;
mod elfimg;
mod flash;
mod fonts;
mod fwzip;
mod grbl;
mod k40;
mod libsync;
mod machine;
mod marlin;
mod modbus;
mod netscan;
mod camfetch;
mod ruida;
mod serial;
mod store;
mod update;
mod usb_k40;
mod vfd;
mod workshop;

use controller::MachineController;
use machine::{Emit, Machine};
use k40::{K40Options, K40};
use marlin::Marlin;
use ruida::{Origin, RdOptions, Ruida};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// Eine Verbindung: GRBL-Familie oder Ruida
#[derive(Clone)]
enum Conn {
    Grbl(Machine),
    Marlin(Marlin),
    Ruida(Ruida),
    K40(K40),
}

/// Ruft dieselbe Methode auf allen Verbindungsarten auf
macro_rules! each {
    ($s:expr, $c:ident => $e:expr) => {
        match $s { Conn::Grbl($c) => $e, Conn::Marlin($c) => $e, Conn::Ruida($c) => $e, Conn::K40($c) => $e }
    };
}

impl Conn {
    /// Gemeinsame Schnittstelle der Steuerung (controller.rs)
    fn ctl(&self) -> &dyn MachineController { each!(self, c => c) }
    fn is_alive(&self) -> bool { self.ctl().is_alive() }
    fn shutdown(&self) { self.ctl().shutdown() }
    fn send_line(&self, l: &str) -> Result<u64, String> { self.ctl().send_line(l) }
    fn realtime(&self, b: u8) -> Result<(), String> { self.ctl().realtime(b) }
    fn start_job(&self, lines: Vec<String>) -> Result<usize, String> { self.ctl().start_job(lines) }
    fn pause_job(&self) -> Result<(), String> { self.ctl().pause_job() }
    fn resume_job(&self) -> Result<(), String> { self.ctl().resume_job() }
    fn stop_job(&self) -> Result<(), String> { self.ctl().stop_job() }
    /// Live-Bearbeitung nur bei GRBL (Zeilen werden einzeln gesendet; Ruida/K40 bekommen die Datei als Ganzes)
    fn patch_job(&self, from: usize, delete: usize, insert: Vec<String>, expect_total: usize) -> Result<usize, String> {
        self.ctl().patch_job(from, delete, insert, expect_total)
    }

    /// Vor dem Trennen/Beenden: laufenden Job sicher anhalten, damit die Maschine nicht mit
    /// gepuffertem G-Code weiterfährt und Laser/Spindel danach nicht eingeschaltet bleiben.
    /// Gibt zurück, wie lange gewartet werden muss, bis der Halt beim Board angekommen ist.
    fn stop_for_close(&self) -> std::time::Duration {
        use std::time::Duration;
        match self {
            // GRBL: Vorschub-Halt, abbremsen lassen, dann Soft-Reset (schaltet Spindel/Laser ab) – max. 2,5 s
            Conn::Grbl(m) if m.has_job() => { let _ = m.stop_job(); Duration::from_millis(2700) }
            Conn::Marlin(m) if m.has_job() => { let _ = m.stop_job(); Duration::from_millis(300) }
            // Ruida/K40 melden keinen Job-Zustand nach außen: Stopp schadet im Leerlauf nicht
            Conn::Ruida(m) => { let _ = m.stop_job(); Duration::from_millis(400) }
            Conn::K40(m) => { let _ = m.stop_job(); Duration::from_millis(400) }
            _ => Duration::ZERO,
        }
    }
}

/// Eine Verbindung mit ihrer Kennung (vergibt die Oberfläche, z. B. "m2") und ihrem Ziel (Port, IP …)
struct Slot {
    id: String,
    target: String,
    conn: Conn,
}

/// Alle Verbindungen – mehrere Maschinen gleichzeitig. Befehle gehen an die ausgewählte (ACTIVE),
/// die anderen laufen im Hintergrund weiter (Jobs, Statusberichte).
static MACHINES: Mutex<Vec<Slot>> = Mutex::new(Vec::new());
static ACTIVE: Mutex<String> = Mutex::new(String::new());

const DEFAULT_ID: &str = "m1";

fn active_id() -> String {
    ACTIVE.lock().map(|a| if a.is_empty() { DEFAULT_ID.to_string() } else { a.clone() }).unwrap_or_else(|_| DEFAULT_ID.to_string())
}

fn set_active(id: &str) {
    if let Ok(mut a) = ACTIVE.lock() { *a = id.to_string(); }
}

/// Die ausgewählte Verbindung
fn current() -> Result<Conn, String> {
    let id = active_id();
    let guard = MACHINES.lock().map_err(|_| "lock".to_string())?;
    match guard.iter().find(|s| s.id == id) {
        Some(s) if s.conn.is_alive() => Ok(s.conn.clone()),
        _ => Err("not connected".into()),
    }
}

/// Verbindungen sicher beenden: laufende Jobs vorher anhalten (Laser/Spindel aus), dann trennen.
/// Erst aus der Sperre nehmen, dann außerhalb anhalten – das Warten soll nichts blockieren.
fn close_slots(taken: Vec<Slot>) {
    let mut wait = std::time::Duration::ZERO;
    for s in &taken {
        if s.conn.is_alive() { wait = wait.max(s.conn.stop_for_close()); }
    }
    if !wait.is_zero() { std::thread::sleep(wait); }
    for s in taken {
        s.conn.shutdown();
        workshop::job_ended(&s.id); // Werkstatt-Geräte: Nachlauf starten (falls ein Job lief)
    }
}

fn close_id(id: &str) {
    let taken: Vec<Slot> = match MACHINES.lock() {
        Ok(mut g) => { let (out, keep): (Vec<Slot>, Vec<Slot>) = g.drain(..).partition(|s| s.id == id); *g = keep; out }
        Err(_) => Vec::new(),
    };
    close_slots(taken);
}

/// Ausgewählte Verbindung trennen
fn close_current() {
    close_id(&active_id());
}

/// Alle Verbindungen trennen (Programm wird geschlossen / startet nach einem Update neu)
pub(crate) fn close_all() {
    let taken: Vec<Slot> = MACHINES.lock().map(|mut g| g.drain(..).collect()).unwrap_or_default();
    close_slots(taken);
}

/// Vor dem Verbinden: dieselbe Kennung neu belegen (alte Verbindung schließen) und prüfen,
/// dass das Ziel nicht schon von einer anderen Verbindung benutzt wird
fn prepare_slot(id: &str, target: &str) -> Result<(), String> {
    close_id(id);
    let others: Vec<String> = MACHINES.lock().map_err(|_| "lock".to_string())?
        .iter().filter(|s| s.conn.is_alive()).map(|s| s.target.clone()).collect();
    if others.iter().any(|t| t == target) { return Err("already-connected".into()); }
    // Netzwerk: dieselbe Maschine unter anderem Namen (cnc-fraese.local vs. IP) erkennen
    let mine = tcp_addrs(target);
    if !mine.is_empty() && others.iter().any(|t| tcp_addrs(t).iter().any(|a| mine.contains(a))) {
        return Err("already-connected".into());
    }
    Ok(())
}

/// "tcp://host:port" -> Adressen (leer bei USB-Ports und wenn der Name nicht aufgelöst werden kann)
fn tcp_addrs(target: &str) -> Vec<std::net::SocketAddr> {
    use std::net::ToSocketAddrs;
    match target.strip_prefix("tcp://") {
        Some(hp) => hp.to_socket_addrs().map(|i| i.collect()).unwrap_or_default(),
        None => Vec::new(),
    }
}

fn add_slot(id: String, target: String, conn: Conn) -> Result<(), String> {
    let mut g = MACHINES.lock().map_err(|_| "lock".to_string())?;
    g.retain(|s| s.id != id && s.conn.is_alive());
    g.push(Slot { id: id.clone(), target, conn });
    drop(g);
    set_active(&id);
    Ok(())
}

fn slot_id(conn: Option<String>) -> String {
    conn.filter(|c| !c.is_empty() && c.len() <= 32 && c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'))
        .unwrap_or_else(|| DEFAULT_ID.to_string())
}

/// Ereignisse einer Verbindung tragen deren Kennung ("conn"), damit die Oberfläche sie zuordnen kann
fn emitter(app: &AppHandle, id: &str) -> Emit {
    let app2 = app.clone();
    let id = id.to_string();
    Arc::new(move |name: &str, json: String| {
        // Job zu Ende (fertig/abgebrochen) oder Verbindung weg: Werkstatt-Geräte nach dem Nachlauf aus
        if name == "machine-job-done" || name == "machine-disconnected" { workshop::job_ended(&id); }
        let mut value: serde_json::Value = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
        if let serde_json::Value::Object(map) = &mut value {
            map.insert("conn".into(), serde_json::Value::String(id.clone()));
        }
        let _ = app2.emit(name, value);
    })
}

#[derive(Serialize)]
struct PortJson {
    name: String,
    vid: Option<u16>,
    pid: Option<u16>,
    chip: String,
    product: String,
    manufacturer: String,
}

#[tauri::command]
async fn list_ports() -> Vec<PortJson> {
    serial::list_ports()
        .into_iter()
        .map(|p| PortJson { name: p.name, vid: p.vid, pid: p.pid, chip: p.chip, product: p.product, manufacturer: p.manufacturer })
        .collect()
}

#[tauri::command]
async fn machine_connect(app: AppHandle, port: String, baud: u32, conn: Option<String>) -> Result<(), String> {
    let id = slot_id(conn);
    prepare_slot(&id, &port)?; // gleiche Kennung: alte Verbindung sauber beenden
    // "tcp://host:port" = GRBL über Netzwerk (FluidNC, grblHAL, ESP32-Boards per WLAN, xTool F1)
    let m = if let Some(addr) = port.strip_prefix("tcp://") {
        let addr = addr.to_string();
        let emit = emitter(&app, &id);
        tauri::async_runtime::spawn_blocking(move || serial::open_machine_tcp(&addr, emit)).await.map_err(|e| e.to_string())??
    } else {
        serial::open_machine(&port, baud, emitter(&app, &id))?
    };
    add_slot(id, port, Conn::Grbl(m))
}

/// Marlin-Maschine verbinden (Creality, Anycubic, MPCNC …). laser = bei Pause Laser aus
#[tauri::command]
async fn marlin_connect(app: AppHandle, port: String, baud: u32, laser: bool, conn: Option<String>) -> Result<(), String> {
    let id = slot_id(conn);
    prepare_slot(&id, &port)?;
    let m = serial::open_marlin(&port, baud, laser, emitter(&app, &id))?;
    add_slot(id, port, Conn::Marlin(m))
}

fn k40_options(bed_w: f64, bed_h: f64, board: &str, s_max: f64) -> K40Options {
    let board = match board { "M2" | "M3" | "M1" | "M" | "B2" | "B1" | "B" | "A" => board, _ => "M2" };
    K40Options {
        bed_w: if bed_w > 0.0 { bed_w } else { 300.0 },
        bed_h: if bed_h > 0.0 { bed_h } else { 200.0 },
        board: board.to_string(),
        s_max: if s_max > 0.0 { s_max } else { 1000.0 },
    }
}

/// Wie viele K40-Boards (USB 1a86:5512) hängen am Rechner?
#[tauri::command]
async fn k40_count() -> usize {
    tauri::async_runtime::spawn_blocking(usb_k40::count).await.unwrap_or(0)
}

/// K40 mit Original-Board verbinden (board = "M2", "M3", "B2" …)
#[tauri::command]
async fn k40_connect(app: AppHandle, index: usize, bed_w: f64, bed_h: f64, board: String, s_max: f64, conn: Option<String>) -> Result<(), String> {
    let id = slot_id(conn);
    let target = format!("k40:{}", index);
    prepare_slot(&id, &target)?;
    let opt = k40_options(bed_w, bed_h, &board, s_max);
    let emit = emitter(&app, &id);
    let k = tauri::async_runtime::spawn_blocking(move || -> Result<K40, String> {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let usb = usb_k40::open(index)?;
        K40::start(Box::new(usb), opt, emit)
    })
    .await
    .map_err(|e| e.to_string())??;
    add_slot(id, target, Conn::K40(k))
}

#[tauri::command]
async fn k40_set_options(bed_w: f64, bed_h: f64, board: String, s_max: f64) -> Result<(), String> {
    if let Conn::K40(k) = current()? { k.set_options(k40_options(bed_w, bed_h, &board, s_max)); }
    Ok(())
}

fn rd_options(bed_w: f64, bed_h: f64, origin: &str, s_max: f64, magic: u8, min_power: f64) -> RdOptions {
    RdOptions {
        bed_w: if bed_w > 0.0 { bed_w } else { 600.0 },
        bed_h: if bed_h > 0.0 { bed_h } else { 400.0 },
        origin: Origin::parse(origin),
        s_max: if s_max > 0.0 { s_max } else { 1000.0 },
        magic: if magic == 0 { 0x88 } else { magic },
        min_power: min_power.clamp(0.0, 100.0),
    }
}

/// Ruida verbinden. target = IP-Adresse (Netzwerk) oder Port-Name (USB)
#[tauri::command]
async fn ruida_connect(app: AppHandle, target: String, bed_w: f64, bed_h: f64, origin: String, s_max: f64, magic: u8, min_power: f64, conn: Option<String>) -> Result<(), String> {
    let id = slot_id(conn);
    let key = target.trim().to_string();
    prepare_slot(&id, &key)?;
    let opt = rd_options(bed_w, bed_h, &origin, s_max, magic, min_power);
    let emit = emitter(&app, &id);
    let r = tauri::async_runtime::spawn_blocking(move || -> Result<Ruida, String> {
        // kurz warten, falls eine alte Verbindung den UDP-Port / USB-Port noch hält
        std::thread::sleep(std::time::Duration::from_millis(150));
        let t = target.trim();
        let link: Box<dyn ruida::Link> = if t.starts_with("/dev/") || t.to_ascii_uppercase().starts_with("COM") {
            Box::new(serial::open_ruida(t)?)
        } else {
            Box::new(ruida::UdpLink::open(t)?)
        };
        Ruida::start(link, opt, emit)
    })
    .await
    .map_err(|e| e.to_string())??;
    add_slot(id, key, Conn::Ruida(r))
}

/// Bettgröße / Nullpunkt / S-Max ändern, während Ruida verbunden ist
#[tauri::command]
async fn ruida_set_options(bed_w: f64, bed_h: f64, origin: String, s_max: f64, min_power: f64) -> Result<(), String> {
    if let Conn::Ruida(r) = current()? {
        r.set_options(rd_options(bed_w, bed_h, &origin, s_max, 0, min_power));
    }
    Ok(())
}

/// G-Code als .rd-Datei speichern (für USB-Stick / RDWorks / LightBurn)
#[derive(Serialize)]
struct RdInfo {
    bytes: usize,
    parts: usize,
    cuts: usize,
    w: f64, // Größe des Auftrags in mm
    h: f64,
}

#[tauri::command]
async fn ruida_export(lines: Vec<String>, path: String, bed_w: f64, bed_h: f64, origin: String, s_max: f64, magic: u8, min_power: f64) -> Result<RdInfo, String> {
    let opt = rd_options(bed_w, bed_h, &origin, s_max, magic, min_power);
    let segs = ruida::parse_gcode(&lines, opt.s_max);
    let job = ruida::build_rd(&segs, &opt)?;
    if job.outside { return Err("outside".into()); }
    let data = job.file(opt.magic);
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(RdInfo {
        bytes: data.len(),
        parts: job.parts,
        cuts: job.cuts,
        w: (job.max.0 - job.min.0) as f64 / 1000.0,
        h: (job.max.1 - job.min.1) as f64 / 1000.0,
    })
}

#[tauri::command]
async fn machine_disconnect(conn: Option<String>) -> Result<(), String> {
    match conn { Some(c) => close_id(&slot_id(Some(c))), None => close_current() }
    Ok(())
}

/// Maschine auswählen: ab jetzt gehen Befehle und Jobs an diese Verbindung
#[tauri::command]
async fn machine_select(conn: String) -> Result<(), String> {
    set_active(&slot_id(Some(conn)));
    Ok(())
}

/// Not-Halt für alle: laufende Jobs auf allen Maschinen sicher anhalten (Laser/Spindel aus).
/// Rückgabe: Zahl der Verbindungen, an die der Halt ging
#[tauri::command]
async fn machine_stop_all() -> usize {
    let all: Vec<Conn> = MACHINES.lock().map(|g| g.iter().filter(|s| s.conn.is_alive()).map(|s| s.conn.clone()).collect()).unwrap_or_default();
    for c in &all {
        let _ = c.stop_for_close();
        // GRBL ohne Job: Jog-Fahrt abbrechen (schadet im Stillstand nicht)
        if let Conn::Grbl(m) = c { let _ = m.realtime(0x85); }
    }
    all.len()
}

#[tauri::command]
async fn machine_is_connected() -> bool {
    current().is_ok()
}

#[tauri::command]
async fn machine_send(line: String) -> Result<u64, String> {
    current()?.send_line(&line)
}

/// Echtzeit-Befehl als Zahl (z. B. 0x18 Reset, 0x85 Joggen abbrechen, 0x90… Overrides)
#[tauri::command]
async fn machine_realtime(code: u8) -> Result<(), String> {
    current()?.realtime(code)
}

#[tauri::command]
async fn machine_job_start(lines: Vec<String>) -> Result<usize, String> {
    let id = active_id();
    let n = current()?.start_job(lines)?;
    workshop::job_started(&id); // Werkstatt-Geräte ein (eigene Threads, blockiert den Job nicht)
    Ok(n)
}

/// Werkstatt-Geräte aus den Einstellungen übernehmen
#[tauri::command]
async fn workshop_set_devices(devices: Vec<workshop::Device>) {
    if let Some(w) = workshop::global() { w.set_devices(devices); }
}

/// „Test Ein/Aus“ für ein Gerät (auch nicht aktivierte)
#[tauri::command]
async fn workshop_test(device: workshop::Device, on: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || workshop::send_real(&device, on)).await.map_err(|e| e.to_string())?
}

/// Laufenden Job ändern (nur noch nicht gesendete Zeilen, siehe Machine::patch_job)
#[tauri::command]
async fn machine_job_patch(from: usize, delete: usize, insert: Vec<String>, expect_total: usize) -> Result<usize, String> {
    current()?.patch_job(from, delete, insert, expect_total)
}

#[tauri::command]
async fn machine_job_pause() -> Result<(), String> {
    current()?.pause_job()
}

#[tauri::command]
async fn machine_job_resume() -> Result<(), String> {
    current()?.resume_job()
}

#[tauri::command]
async fn machine_job_stop() -> Result<(), String> {
    current()?.stop_job()
}

/// Mitgelieferte Firmware: GRBL 1.1h für Arduino UNO/Nano (GPLv3, unverändert von github.com/gnea/grbl)
const GRBL_HEX: &str = include_str!("../firmware/grbl_v1.1h.20190825.hex");

/// Programm-Version (aus tauri.conf.json) und System – für die Update-Prüfung
#[derive(Serialize)]
struct AppInfo {
    version: String,
    os: String,   // "macos", "windows", "linux"
    arch: String, // "aarch64", "x86_64"
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

/// Ergebnis der Netzwerk-Suche (netscan.rs)
#[derive(Serialize)]
struct NetDevice {
    ip: String,
    port: u16,
    kind: String,
    firmware: String,
    name: String,
    host: String,
}
#[derive(Serialize)]
struct NetScan {
    own: String,
    devices: Vec<NetDevice>,
}

/// Netzwerk nach GRBL-Maschinen absuchen (FluidNC, grblHAL, MKS DLC32 per WLAN …), dauert ein paar Sekunden.
/// hints = zuletzt benutzte/gefundene Adressen (werden zuerst und gründlich geprüft)
#[tauri::command]
async fn net_scan(hints: Option<Vec<String>>) -> Result<NetScan, String> {
    let hints = hints.unwrap_or_default();
    // verbundene Netzwerk-Maschinen nicht anklopfen (ESP32-Boards würden die Verbindung sonst trennen)
    let busy_targets: Vec<String> = MACHINES.lock().map(|g| g.iter().filter(|s| s.conn.is_alive()).map(|s| s.target.clone()).collect()).unwrap_or_default();
    let (own, found) = tauri::async_runtime::spawn_blocking(move || {
        let busy: Vec<std::net::SocketAddr> = busy_targets.iter().flat_map(|t| tcp_addrs(t)).collect();
        netscan::scan_network(&hints, &busy)
    }).await.map_err(|e| e.to_string())?;
    Ok(NetScan {
        own: own.map(|ip| ip.to_string()).unwrap_or_default(),
        devices: found
            .into_iter()
            .map(|f| NetDevice { ip: f.ip, port: f.port, kind: f.kind, firmware: f.firmware, name: f.name, host: f.host })
            .collect(),
    })
}

/// Ein Bild von einer IP-Kamera holen (camfetch.rs) – JPEG-Bytes direkt als ArrayBuffer
#[tauri::command]
async fn camera_snapshot(url: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || camfetch::fetch_frame(&url, std::time::Duration::from_secs(4)))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Alle installierten Schriften auflisten (fonts.rs) – für die Schriftauswahl im Text-Werkzeug
#[tauri::command]
async fn system_fonts() -> Result<Vec<fonts::SysFont>, String> {
    tauri::async_runtime::spawn_blocking(fonts::list).await.map_err(|e| e.to_string())
}

/// Eine Systemschrift als Datei holen (nur Schriften aus der Liste oben) – Bytes direkt als ArrayBuffer
#[tauri::command]
async fn system_font_data(path: String, index: u32) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || fonts::data(&path, index))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Befehl über die Weboberfläche eines ESP32-Boards schicken (für WLAN-Passwörter mit ! ? ~ oder Umlauten)
#[tauri::command]
async fn esp_web_command(host: String, command: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || camfetch::web_command(&host, &command, std::time::Duration::from_secs(5)))
        .await
        .map_err(|e| e.to_string())?
}

/// Einstellungen-Datei (store.rs): Ordner + gespeicherter Stand
#[derive(Serialize)]
struct StoreRead {
    dir: String,
    main: Option<String>,
    backups: Vec<String>,
}

fn store_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// Gespeicherte Einstellungen lesen (beim Start, falls der Speicher der Oberfläche leer ist)
#[tauri::command]
async fn settings_store_read(app: AppHandle) -> Result<StoreRead, String> {
    let dir = store_dir(&app)?;
    let s = store::read_settings(&dir);
    Ok(StoreRead { dir: dir.to_string_lossy().to_string(), main: s.main, backups: s.backups })
}

/// Einstellungen in die Datei schreiben (+ Tages-Sicherung)
#[tauri::command]
async fn settings_store_write(app: AppHandle, data: String) -> Result<(), String> {
    let dir = store_dir(&app)?;
    store::write_settings(&dir, &data).map_err(|e| e.to_string())
}

/// Werkstatt-Sync (libsync.rs): eine Bibliothek mit dem gemeinsamen Ordner abgleichen
#[tauri::command]
async fn libsync_sync(folder: String, kind: String, local: String, device: String, device_name: String, now: u64) -> Result<libsync::SyncResult, String> {
    // Netzlaufwerk kann langsam sein + Sperre wartet kurz -> nicht im Haupt-Thread
    tauri::async_runtime::spawn_blocking(move || {
        libsync::sync_kind(std::path::Path::new(&folder), &kind, &local, &device, &device_name, now).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Werkstatt-Sync: Sicherung der Bibliotheken, bevor der Abgleich lokal etwas ändert
#[tauri::command]
async fn libsync_backup(app: AppHandle, data: String) -> Result<String, String> {
    let dir = store_dir(&app)?;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    libsync::write_backup(&dir, &data, secs).map(|p| p.to_string_lossy().to_string()).map_err(|e| e.to_string())
}

/// Text einer mitgelieferten Firmware (zum Anzeigen/Prüfen in der Oberfläche)
#[tauri::command]
async fn bundled_firmware(name: String) -> Result<String, String> {
    match name.as_str() {
        "grbl" => Ok(GRBL_HEX.to_string()),
        _ => Err("unknown firmware".into()),
    }
}

#[derive(Serialize)]
struct ElfInfo {
    chip: String,
    chip_id: u16,
    size: usize,
    segments: usize,
    project: String,
    version: String,
    idf: String,
    date: String,
}

/// .elf-Datei prüfen (für welchen Chip, welches Programm, wie groß nach dem Umwandeln)
#[tauri::command]
async fn elf_inspect(path: String) -> Result<ElfInfo, String> {
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let img = elfimg::elf_to_image(&data, 0x20)?;
    let app = img.app.unwrap_or_default();
    Ok(ElfInfo {
        chip: img.chip.name().into(),
        chip_id: img.chip.image_id(),
        size: img.image.len(),
        segments: img.segments,
        project: app.project,
        version: app.version,
        idf: app.idf,
        date: app.date,
    })
}

/// Flash-Größe in Bytes -> Kennung im Firmware-Kopf
fn flash_size_code(bytes: u32) -> u8 {
    match bytes / (1024 * 1024) { 0 | 1 => 0x00, 2 => 0x10, 4 => 0x20, 8 => 0x30, 16 => 0x40, 32 => 0x50, 64 => 0x60, _ => 0x70 }
}

/// Abbruch-Schalter für das Flashen
static FLASH_CANCEL: AtomicBool = AtomicBool::new(false);

/// Firmware flashen. kind = "esp" (ESP32-Familie, .bin) oder "avr" (Arduino, .hex).
/// Trennt vorher die Maschinen-Verbindung (der Port muss frei sein).
#[tauri::command]
async fn flash_firmware(app: AppHandle, port: String, path: String, kind: String, offset: u32, baud: u32, usb_jtag: bool, flash_size: u32) -> Result<String, String> {
    close_port(&port);
    FLASH_CANCEL.store(false, Ordering::SeqCst);
    // "bundled:grbl" = mitgelieferte GRBL-Datei
    let data = if path == "bundled:grbl" { GRBL_HEX.as_bytes().to_vec() } else { std::fs::read(&path).map_err(|e| e.to_string())? };
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // den Lese-Threads der alten Verbindung Zeit geben, den Port loszulassen
        std::thread::sleep(std::time::Duration::from_millis(400));
        let mut p = serial::open_flash_port(&port)?;
        let prog = move |name: &str, json: String| {
            let value: serde_json::Value = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
            let _ = app2.emit(name, value);
        };
        if kind == "elf" {
            // .elf erst in ein ESP-Abbild umwandeln, dann wie eine .bin flashen
            let img = elfimg::elf_to_image(&data, flash_size_code(flash_size))?;
            let opt = flash::EspOptions { offset, baud, usb_jtag, flash_size };
            return flash::flash_esp(&mut p, &img.image, &opt, &prog, &FLASH_CANCEL);
        }
        if kind == "avr" {
            let text = String::from_utf8_lossy(&data).to_string();
            flash::flash_avr(&mut p, &text, &prog, &FLASH_CANCEL)
        } else {
            let opt = flash::EspOptions { offset, baud, usb_jtag, flash_size };
            flash::flash_esp(&mut p, &data, &opt, &prog, &FLASH_CANCEL)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Verbindung(en) auf genau diesem Port trennen (Flashen braucht den Port; andere Maschinen bleiben verbunden)
fn close_port(port: &str) {
    let ids: Vec<String> = MACHINES.lock().map(|g| g.iter().filter(|s| s.target == port).map(|s| s.id.clone()).collect()).unwrap_or_default();
    for id in ids { close_id(&id); }
}

/// Firmware-ZIP (grblHAL Web Builder) prüfen: Teile mit Adressen, Chip, nötige Flash-Größe, Version,
/// und ob der erwartete Board-Name (z. B. "MKS DLC32 MAX") in der Firmware steht
#[derive(Serialize)]
struct ZipPartInfo { name: String, role: String, offset: u32, size: usize }
#[derive(Serialize)]
struct ZipInfo { parts: Vec<ZipPartInfo>, chip_id: Option<u16>, chip: String, needs_flash: u32, version: String, board_ok: Option<bool> }

#[tauri::command]
async fn fw_zip_inspect(path: String, expect: Option<String>) -> Result<ZipInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let fw = fwzip::firmware_from_zip(&bytes)?;
        let app = fw.parts.iter().find(|p| p.role == "app").map(|p| p.data.as_slice()).unwrap_or(&[]);
        Ok(ZipInfo {
            parts: fw.parts.iter().map(|p| ZipPartInfo { name: p.name.clone(), role: p.role.into(), offset: p.offset, size: p.data.len() }).collect(),
            chip_id: fw.chip_id,
            chip: fw.chip_id.map(|c| flash::chip_name_from_image_id(c).to_string()).unwrap_or_else(|| "?".into()),
            needs_flash: fw.needs_flash,
            version: fwzip::find_version(app),
            board_ok: expect.filter(|e| !e.is_empty()).map(|e| fwzip::contains_text(app, &e)),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Alle Teile einer Firmware-ZIP in einer Sitzung flashen
#[tauri::command]
async fn flash_zip(app: AppHandle, port: String, path: String, baud: u32, usb_jtag: bool, flash_size: u32) -> Result<String, String> {
    close_port(&port);
    FLASH_CANCEL.store(false, Ordering::SeqCst);
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let fw = fwzip::firmware_from_zip(&bytes)?;
    if fw.needs_flash > flash_size { return Err(format!("too large: needs {} MB flash", fw.needs_flash >> 20)); }
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        let mut p = serial::open_flash_port(&port)?;
        let prog = move |name: &str, json: String| {
            let value: serde_json::Value = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
            let _ = app2.emit(name, value);
        };
        let parts: Vec<(u32, &[u8])> = fw.parts.iter().map(|p| (p.offset, p.data.as_slice())).collect();
        let opt = flash::EspOptions { offset: 0, baud, usb_jtag, flash_size };
        flash::flash_esp_parts(&mut p, &parts, &opt, &prog, &FLASH_CANCEL)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- 3D-Fräsen (cam3d.rs) ----

/// zuletzt übergebenes 3D-Modell (Dreiecke in den Maßen der Datei)
static CAM3D_MODEL: Mutex<Option<Arc<Vec<cam3d::Tri>>>> = Mutex::new(None);
/// Abbruch-Schalter für die 3D-Berechnung
static CAM3D_CANCEL: AtomicBool = AtomicBool::new(false);

/// 3D-Fräsen: Modell als STL-Bytes (binär oder Text) übernehmen. Antwort: Anzahl Dreiecke
#[tauri::command]
async fn cam3d_load(request: tauri::ipc::Request<'_>) -> Result<usize, String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else { return Err("expected STL bytes".into()) };
    let data = data.clone();
    let tris = tauri::async_runtime::spawn_blocking(move || cam3d::parse_stl(&data)).await.map_err(|e| e.to_string())??;
    let n = tris.len();
    *CAM3D_MODEL.lock().unwrap() = Some(Arc::new(tris));
    Ok(n)
}

/// 3D-Fräsen: Schrupp- und Schlicht-Bahnen rechnen (Fortschritt: Ereignis "cam3d-progress").
/// Antwort: Bahnen als Bytes (Aufbau siehe cam3d::encode)
#[tauri::command]
async fn cam3d_compute(app: AppHandle, job: cam3d::Job) -> Result<tauri::ipc::Response, String> {
    let tris = CAM3D_MODEL.lock().unwrap().clone().ok_or("no model loaded")?;
    CAM3D_CANCEL.store(false, Ordering::SeqCst);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let last = Mutex::new(-1.0f64);
        let prog = |f: f64, stage: &str| {
            let mut l = last.lock().unwrap();
            // höchstens alle 1 % melden
            if f - *l >= 0.01 || f >= 1.0 {
                *l = f;
                let _ = app.emit("cam3d-progress", serde_json::json!({ "p": f, "stage": stage }));
            }
        };
        cam3d::compute(&tris, &job, &CAM3D_CANCEL, &prog).map(|p| cam3d::encode(&p))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn cam3d_cancel() {
    CAM3D_CANCEL.store(true, Ordering::SeqCst);
}

#[tauri::command]
async fn flash_cancel() {
    FLASH_CANCEL.store(true, Ordering::SeqCst);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Werkstatt: Ergebnisse als Ereignis an die Oberfläche (Konsole) – ohne Adressen/Passwörter
            let handle = app.handle().clone();
            workshop::init(Arc::new(move |d: &workshop::Device, on: bool, why: &str, err: Option<String>| {
                let _ = handle.emit("workshop-action", serde_json::json!({ "id": d.id, "name": d.name, "on": on, "why": why, "error": err }));
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_ports,
            machine_connect,
            marlin_connect,
            k40_count,
            k40_connect,
            k40_set_options,
            ruida_connect,
            ruida_set_options,
            ruida_export,
            machine_disconnect,
            machine_select,
            machine_stop_all,
            machine_is_connected,
            machine_send,
            machine_realtime,
            machine_job_start,
            machine_job_patch,
            machine_job_pause,
            machine_job_resume,
            machine_job_stop,
            flash_firmware,
            bundled_firmware,
            elf_inspect,
            flash_cancel,
            fw_zip_inspect,
            flash_zip,
            app_info,
            settings_store_read,
            settings_store_write,
            libsync_sync,
            libsync_backup,
            net_scan,
            camera_snapshot,
            system_fonts,
            system_font_data,
            esp_web_command,
            cam3d_load,
            cam3d_compute,
            cam3d_cancel,
            workshop_set_devices,
            workshop_test,
            vfd::vfd_profiles,
            vfd::vfd_connect,
            vfd::vfd_disconnect,
            vfd::vfd_set_speed,
            vfd::vfd_set_direction,
            vfd::vfd_status,
            update::update_install,
            update::update_restart
        ])
        // Fenster wird geschlossen: laufenden Job vorher sicher anhalten (Laser/Spindel aus)
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                close_all();
                vfd::stop_blocking(); // Spindel am Umrichter (Modbus) ebenfalls anhalten
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running CNC Craft");
}

#[cfg(test)]
mod multi_tests {
    use super::{slot_id, tcp_addrs};

    #[test]
    fn tcp_addrs_only_for_network_targets() {
        let a = tcp_addrs("tcp://127.0.0.1:8080");
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].port(), 8080);
        assert!(tcp_addrs("/dev/cu.usbserial-110").is_empty());
        assert!(tcp_addrs("k40:0").is_empty());
    }

    #[test]
    fn slot_id_accepts_simple_ids() {
        assert_eq!(slot_id(Some("m2".into())), "m2");
        assert_eq!(slot_id(Some("laser_1-a".into())), "laser_1-a");
    }

    #[test]
    fn slot_id_falls_back_for_bad_ids() {
        assert_eq!(slot_id(None), "m1");
        assert_eq!(slot_id(Some("".into())), "m1");
        assert_eq!(slot_id(Some("<script>".into())), "m1");
        assert_eq!(slot_id(Some("x".repeat(40))), "m1");
    }
}
