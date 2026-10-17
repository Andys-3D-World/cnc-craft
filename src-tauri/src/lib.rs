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
//!
//! Die Oberfläche ruft die Befehle unten per invoke(...) auf und bekommt Ereignisse:
//!   machine-welcome, machine-status, machine-line, machine-alarm, machine-disconnected,
//!   machine-job-progress, machine-job-error, machine-job-toolchange, machine-job-done,
//!   flash-progress
//! GRBL und Ruida melden dieselben Ereignisse – die Oberfläche muss kaum unterscheiden.

mod elfimg;
mod flash;
mod grbl;
mod k40;
mod machine;
mod marlin;
mod netscan;
mod camfetch;
mod ruida;
mod serial;
mod store;
mod usb_k40;

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
    fn is_alive(&self) -> bool { each!(self, c => c.is_alive()) }
    fn shutdown(&self) { each!(self, c => c.shutdown()) }
    fn send_line(&self, l: &str) -> Result<u64, String> { each!(self, c => c.send_line(l)) }
    fn realtime(&self, b: u8) -> Result<(), String> { each!(self, c => c.realtime(b)) }
    fn start_job(&self, lines: Vec<String>) -> Result<usize, String> { each!(self, c => c.start_job(lines)) }
    fn pause_job(&self) -> Result<(), String> { each!(self, c => c.pause_job()) }
    fn resume_job(&self) -> Result<(), String> { each!(self, c => c.resume_job()) }
    fn stop_job(&self) -> Result<(), String> { each!(self, c => c.stop_job()) }
}

/// Die aktuelle Verbindung (None = nicht verbunden)
static MACHINE: Mutex<Option<Conn>> = Mutex::new(None);

fn current() -> Result<Conn, String> {
    let guard = MACHINE.lock().map_err(|_| "lock".to_string())?;
    match guard.as_ref() {
        Some(m) if m.is_alive() => Ok(m.clone()),
        _ => Err("not connected".into()),
    }
}

fn close_current() {
    if let Ok(mut g) = MACHINE.lock() {
        if let Some(m) = g.take() { m.shutdown(); }
    }
}

fn emitter(app: &AppHandle) -> Emit {
    let app2 = app.clone();
    Arc::new(move |name: &str, json: String| {
        let value: serde_json::Value = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
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
async fn machine_connect(app: AppHandle, port: String, baud: u32) -> Result<(), String> {
    close_current(); // alte Verbindung sauber beenden
    // "tcp://host:port" = GRBL über Netzwerk (FluidNC, grblHAL, ESP32-Boards per WLAN, xTool F1)
    let m = if let Some(addr) = port.strip_prefix("tcp://") {
        let addr = addr.to_string();
        let emit = emitter(&app);
        tauri::async_runtime::spawn_blocking(move || serial::open_machine_tcp(&addr, emit)).await.map_err(|e| e.to_string())??
    } else {
        serial::open_machine(&port, baud, emitter(&app))?
    };
    let mut g = MACHINE.lock().map_err(|_| "lock".to_string())?;
    *g = Some(Conn::Grbl(m));
    Ok(())
}

/// Marlin-Maschine verbinden (Creality, Anycubic, MPCNC …). laser = bei Pause Laser aus
#[tauri::command]
async fn marlin_connect(app: AppHandle, port: String, baud: u32, laser: bool) -> Result<(), String> {
    close_current();
    let m = serial::open_marlin(&port, baud, laser, emitter(&app))?;
    let mut g = MACHINE.lock().map_err(|_| "lock".to_string())?;
    *g = Some(Conn::Marlin(m));
    Ok(())
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
async fn k40_connect(app: AppHandle, index: usize, bed_w: f64, bed_h: f64, board: String, s_max: f64) -> Result<(), String> {
    close_current();
    let opt = k40_options(bed_w, bed_h, &board, s_max);
    let emit = emitter(&app);
    let k = tauri::async_runtime::spawn_blocking(move || -> Result<K40, String> {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let usb = usb_k40::open(index)?;
        K40::start(Box::new(usb), opt, emit)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut g = MACHINE.lock().map_err(|_| "lock".to_string())?;
    *g = Some(Conn::K40(k));
    Ok(())
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
async fn ruida_connect(app: AppHandle, target: String, bed_w: f64, bed_h: f64, origin: String, s_max: f64, magic: u8, min_power: f64) -> Result<(), String> {
    close_current();
    let opt = rd_options(bed_w, bed_h, &origin, s_max, magic, min_power);
    let emit = emitter(&app);
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
    let mut g = MACHINE.lock().map_err(|_| "lock".to_string())?;
    *g = Some(Conn::Ruida(r));
    Ok(())
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
async fn machine_disconnect() -> Result<(), String> {
    close_current();
    Ok(())
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
    current()?.start_job(lines)
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
    let (own, found) = tauri::async_runtime::spawn_blocking(move || netscan::scan_network(&hints)).await.map_err(|e| e.to_string())?;
    Ok(NetScan {
        own: own.map(|ip| ip.to_string()).unwrap_or_default(),
        devices: found
            .into_iter()
            .map(|f| NetDevice { ip: f.ip, port: f.port, kind: f.kind, firmware: f.firmware, name: f.name })
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
    close_current();
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
            machine_is_connected,
            machine_send,
            machine_realtime,
            machine_job_start,
            machine_job_pause,
            machine_job_resume,
            machine_job_stop,
            flash_firmware,
            bundled_firmware,
            elf_inspect,
            flash_cancel,
            app_info,
            settings_store_read,
            settings_store_write,
            net_scan,
            camera_snapshot,
            esp_web_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running CNC Craft");
}
