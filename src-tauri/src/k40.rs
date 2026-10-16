//! K40 – CO₂-Laser mit Original-Board von Lihuiyu (M2 Nano, M3 Nano, B2 …)
//!
//! Das Board hängt nicht als serieller Port am Rechner, sondern als CH341-Chip im
//! „Parallel-Modus“ (USB 1a86:5512). Es versteht die Sprache LHYMICRO-GL („EGV“):
//!   I            Befehl beginnen (Eilgang-/Fertig-Modus)
//!   B T L R      Richtung rechts / links / oben / unten   (Y nach unten = R)
//!   M            diagonal
//!   D U          Laser an / aus
//!   a…y, |a…|z   Strecke 1…51 Schritte, ab 52 dreistellig, je 255 ein „z“
//!   CV……C        Geschwindigkeits-Code, N … S1E  Programm-Modus (Schneiden)
//!   S1P          Eilgang ausführen,  FNSE  Programm beenden,  IPP  Referenzfahrt
//! 1 Schritt = 1/1000 Zoll (0,0254 mm). Laserleistung stellt man am Poti der Maschine ein.
//!
//! Daten gehen in Paketen zu 30 Zeichen (+ CRC) über den CH341; nach jedem Paket wird der
//! Status gelesen (206 OK, 238 beschäftigt, 207 Prüfsumme falsch → nochmal, 236 fertig).
//!
//! Umsetzung nach dem MIT-lizenzierten MeerK40t (meerk40t/lihuiyu/driver.py, controller.py,
//! laserspeed.py, meerk40t/ch341/libusb.py).

use crate::machine::{jstr, Emit};
use crate::ruida::{parse_gcode, Seg};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const USB_VID: u16 = 0x1A86;
pub const USB_PID: u16 = 0x5512;

pub const STATUS_OK: u8 = 206;
pub const STATUS_ERROR: u8 = 207;
pub const STATUS_FINISH: u8 = 236;
pub const STATUS_BUSY: u8 = 238;
// 239 = „Low Power“ (wird hier nicht ausgewertet)
pub const STATUS_M3_FINISH: u8 = 204;

/// Schritte pro mm (1000 dpi)
pub const STEPS_PER_MM: f64 = 1000.0 / 25.4;

// ---------------------------------------------------------------------
// Zahlen und Geschwindigkeit
// ---------------------------------------------------------------------

/// Strecke in Schritten -> EGV-Text
pub fn distance(mut v: u32) -> String {
    let mut s = String::new();
    if v >= 255 {
        for _ in 0..(v / 255) { s.push('z'); }
        v %= 255;
    }
    if v >= 52 {
        s.push_str(&format!("{:03}", v));
    } else if v >= 26 {
        s.push('|');
        s.push((b'a' + (v - 26) as u8) as char);
    } else if v >= 1 {
        s.push((b'a' + (v - 1) as u8) as char);
    }
    s
}

fn encode_16bit(value: i64) -> String {
    let b0 = value & 255;
    let b1 = (value >> 8) & 0xFF_FFFF;
    format!("{:03}{:03}", b1, b0)
}

fn acceleration_for(mm_s: f64) -> u8 {
    if mm_s <= 25.4 { 1 } else if mm_s <= 60.0 { 2 } else if mm_s < 127.0 { 3 } else { 4 }
}

fn equation(board: &str, accel: u8, suffix_c: bool) -> (f64, f64) {
    let mut b = match accel { 3 => 896.0, 4 => 1024.0, _ => 784.0 };
    if matches!(board, "A" | "B" | "B1") { return (b, 2000.0); }
    let mut m = 12120.0;
    if board == "B2" {
        m *= 2.0;
        if suffix_c { return (b, m / 12.0); }
    } else {
        b = match accel { 3 => 5632.0, 4 => 6144.0, _ => 5120.0 };
        if suffix_c { return (8.0, m / 12.0); }
    }
    (b, m)
}

/// Geschwindigkeits-Code für Vektor-Schnitte (wie MeerK40t im Standard „ohne Zucken“)
pub fn speed_code(mm_s: f64, board: &str) -> String {
    let mm_s = mm_s.clamp(0.5, 500.0);
    let accel = acceleration_for(mm_s);
    let suffix_c = true;
    let (b, m) = equation(board, accel, suffix_c);
    let period_ms = 1.0 / (mm_s / 25.4);
    let mut speed_value = (65536.0 - (m * period_ms + b)) as i64;
    if speed_value < 0 { speed_value = 0; }
    let enc = encode_16bit(speed_value);
    if matches!(board, "A" | "B" | "M") {
        return format!("CV{}1C", enc);
    }
    let d_ratio = 0.261199033289;
    let step_value = ((mm_s.floor() as i64) + 1).min(128);
    let mut d_value = d_ratio * m * period_ms / step_value as f64;
    if d_value > 65535.0 { d_value = 65535.0; }
    if d_value < 0.0 { d_value = 0.0; }
    format!("CV{}1{:03}{}C", enc, step_value, encode_16bit(d_value as i64))
}

// ---------------------------------------------------------------------
// EGV erzeugen
// ---------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct K40Options {
    pub bed_w: f64,   // mm
    pub bed_h: f64,   // mm
    pub board: String, // "M2", "M3", "B2", "M1", "M", "A", "B"
    pub s_max: f64,
}

impl Default for K40Options {
    fn default() -> Self { K40Options { bed_w: 300.0, bed_h: 200.0, board: "M2".into(), s_max: 1000.0 } }
}

impl K40Options {
    /// Programm-mm (unten links, Y oben) -> Schritte ab Referenzpunkt (oben links, Y nach unten)
    pub fn to_native(&self, x: f64, y: f64) -> (i64, i64) {
        ((x * STEPS_PER_MM).round() as i64, ((self.bed_h - y) * STEPS_PER_MM).round() as i64)
    }
    pub fn to_user(&self, nx: i64, ny: i64) -> (f64, f64) {
        (nx as f64 / STEPS_PER_MM, self.bed_h - ny as f64 / STEPS_PER_MM)
    }
}

#[derive(PartialEq, Clone, Copy)]
enum Mode { Rapid, Program }

/// Schreibt EGV-Befehle und merkt sich Position/Richtung/Laser – wie der MeerK40t-Treiber
pub struct Egv {
    pub out: String,
    pub x: i64,
    pub y: i64,
    mode: Mode,
    leftward: bool,
    topward: bool,
    x_eng: bool, // zuletzt fuhr die X-Achse
    y_eng: bool, // zuletzt fuhr die Y-Achse
    laser: bool,
    speed: f64,
    board: String,
}

impl Egv {
    pub fn new(board: &str) -> Egv {
        Egv { out: String::new(), x: 0, y: 0, mode: Mode::Rapid, leftward: false, topward: false, x_eng: false, y_eng: false, laser: false, speed: -1.0, board: board.to_string() }
    }

    /// Referenzfahrt: Kopf nach oben links, Position 0/0
    pub fn home(&mut self) {
        self.rapid_mode();
        self.out.push_str("IPP\n");
        self.x = 0;
        self.y = 0;
        self.leftward = false;
        self.topward = false;
        self.x_eng = false;
        self.y_eng = false;
        self.laser = false;
    }

    fn laser_set(&mut self, on: bool) {
        if on && !self.laser { self.out.push('D'); self.laser = true; }
        if !on && self.laser { self.out.push('U'); self.laser = false; }
    }

    fn goto_xy(&mut self, dx: i64, dy: i64, on: Option<bool>) {
        let rapid = self.mode == Mode::Rapid;
        if dx != 0 {
            self.x += dx;
            let x_only = self.x_eng && !self.y_eng;
            if dx > 0 {
                if !(x_only && !self.leftward) || rapid { self.out.push('B'); self.leftward = false; }
            } else if !(x_only && self.leftward) || rapid { self.out.push('T'); self.leftward = true; }
            self.x_eng = true;
            self.y_eng = false;
            if let Some(o) = on { self.laser_set(o); }
            self.out.push_str(&distance(dx.unsigned_abs() as u32));
        }
        if dy != 0 {
            self.y += dy;
            let y_only = self.y_eng && !self.x_eng;
            if dy > 0 {
                if !(y_only && !self.topward) || rapid { self.out.push('R'); self.topward = false; }
            } else if !(y_only && self.topward) || rapid { self.out.push('L'); self.topward = true; }
            self.x_eng = false;
            self.y_eng = true;
            if let Some(o) = on { self.laser_set(o); }
            self.out.push_str(&distance(dy.unsigned_abs() as u32));
        }
    }

    fn goto_octent(&mut self, dx: i64, dy: i64, on: bool) {
        if dx == 0 && dy == 0 { return; }
        if dx.abs() == dy.abs() {
            if dx > 0 { if self.leftward { self.out.push('B'); self.leftward = false; } }
            else if !self.leftward { self.out.push('T'); self.leftward = true; }
            if dy > 0 { if self.topward { self.out.push('R'); self.topward = false; } }
            else if !self.topward { self.out.push('L'); self.topward = true; }
            self.x += dx;
            self.y += dy;
            self.x_eng = true;
            self.y_eng = true;
            self.out.push('M');
            self.laser_set(on);
            self.out.push_str(&distance(dy.unsigned_abs() as u32));
        } else {
            self.goto_xy(dx, dy, Some(on));
        }
    }

    /// Schneiden beenden, zurück in den Eilgang-Modus („-“ = warten, bis die Maschine fertig ist)
    pub fn rapid_mode(&mut self) {
        if self.mode == Mode::Program {
            self.out.push_str("FNSE-\n");
            self.laser = false;
            self.mode = Mode::Rapid;
        }
    }

    /// In den Programm-Modus (Schneiden) mit Geschwindigkeit mm/s
    pub fn program_mode(&mut self, speed: f64) {
        if self.mode == Mode::Program && (self.speed - speed).abs() < 1e-6 { return; }
        self.rapid_mode();
        self.out.push('I');
        self.out.push_str(&speed_code(speed, &self.board));
        self.out.push('N');
        self.out.push(if self.leftward { 'T' } else { 'B' });
        self.out.push(if self.topward { 'L' } else { 'R' });
        self.x_eng = false;
        self.y_eng = true;
        self.out.push_str("S1E");
        self.mode = Mode::Program;
        self.speed = speed;
        self.laser = false;
    }

    /// Eilgang zu einer Position (Schritte)
    pub fn rapid_to(&mut self, tx: i64, ty: i64) {
        self.rapid_mode();
        let (dx, dy) = (tx - self.x, ty - self.y);
        if dx == 0 && dy == 0 { return; }
        self.out.push('I');
        self.goto_xy(dx, dy, None);
        self.out.push_str("S1P\n");
    }

    /// Linie im Programm-Modus (Bresenham, gruppiert in gerade/diagonale Stücke)
    pub fn line_to(&mut self, tx: i64, ty: i64, on: bool) {
        let (x0, y0) = (self.x, self.y);
        let (sx, sy) = (if x0 < tx { 1 } else { -1 }, if y0 < ty { 1 } else { -1 });
        let (dx, dy) = ((tx - x0).abs(), -(ty - y0).abs());
        let (mut x, mut y, mut err) = (x0, y0, dx + dy);
        // Gruppen: gleiche Schrittrichtung zusammenfassen
        let (mut gx, mut gy) = (x0, y0);       // Ende der aktuellen Gruppe
        let (mut gdx, mut gdy) = (0i64, 0i64); // Richtung der Gruppe
        let (mut mx, mut my) = (x0, y0);       // zuletzt ausgegebener Punkt
        loop {
            if x == tx && y == ty { break; }
            let e2 = 2 * err;
            let (px, py) = (x, y);
            if e2 >= dy { err += dy; x += sx; }
            if e2 <= dx { err += dx; y += sy; }
            let (sdx, sdy) = (x - px, y - py);
            if (sdx, sdy) != (gdx, gdy) {
                if gx != mx || gy != my { self.goto_octent(gx - mx, gy - my, on); mx = gx; my = gy; }
                gdx = sdx; gdy = sdy;
            }
            gx = x; gy = y;
        }
        if gx != mx || gy != my { self.goto_octent(gx - mx, gy - my, on); }
    }
}

/// Ganzer Auftrag als EGV: Referenzfahrt, Schnitte, zurück zum Referenzpunkt
pub struct K40Job {
    pub egv: String,
    #[allow(dead_code)] // nur für Tests/Anzeige
    pub cuts: usize,
    pub outside: bool,
    /// (Byte-Position im EGV, G-Code-Zeile) für den Fortschritt
    pub marks: Vec<(usize, usize)>,
}

pub fn build_egv(segs: &[(Seg, usize)], opt: &K40Options) -> Result<K40Job, String> {
    let mut e = Egv::new(&opt.board);
    let mut cuts = 0;
    let mut outside = false;
    let mut marks = Vec::new();
    e.home();
    // kurze Leerwege (< 5 mm) im Schneid-Modus fahren, längere als Eilgang
    let short = (5.0 * STEPS_PER_MM) as i64;
    let mut pending: Option<(i64, i64)> = None;
    for (s, line) in segs {
        match *s {
            Seg::Move { x, y } => { pending = Some(opt.to_native(x, y)); }
            Seg::Cut { x, y, speed, .. } => {
                for &(px, py) in &[(x, y)] {
                    if px < -0.01 || py < -0.01 || px > opt.bed_w + 0.01 || py > opt.bed_h + 0.01 { outside = true; }
                }
                if let Some((sx, sy)) = pending.take() {
                    if sx < 0 || sy < 0 { outside = true; }
                    let far = (sx - e.x).abs() > short || (sy - e.y).abs() > short;
                    if e.mode == Mode::Program && !far && (e.speed - speed).abs() < 1e-6 {
                        e.line_to(sx, sy, false);
                    } else {
                        e.rapid_to(sx, sy);
                    }
                }
                e.program_mode(speed);
                let (tx, ty) = opt.to_native(x, y);
                e.line_to(tx, ty, true);
                cuts += 1;
                marks.push((e.out.len(), *line));
            }
        }
    }
    if cuts == 0 { return Err("no cuts".into()); }
    e.rapid_mode();
    e.rapid_to(0, 0);
    Ok(K40Job { egv: e.out, cuts, outside, marks })
}

// ---------------------------------------------------------------------
// Pakete
// ---------------------------------------------------------------------

const CRC_TABLE: [u8; 32] = [
    0x00, 0x5E, 0xBC, 0xE2, 0x61, 0x3F, 0xDD, 0x83, 0xC2, 0x9C, 0x7E, 0x20, 0xA3, 0xFD, 0x1F, 0x41,
    0x00, 0x9D, 0x23, 0xBE, 0x46, 0xDB, 0x65, 0xF8, 0x8C, 0x11, 0xAF, 0x32, 0xCA, 0x57, 0xE9, 0x74,
];

/// 1-Wire-CRC (Arjen Lentz, BSD-Lizenz) über die 30 Nutzbytes
pub fn crc(line: &[u8]) -> u8 {
    let mut c: u8 = 0;
    for &b in line.iter().take(30) {
        c ^= b;
        c = CRC_TABLE[(c & 0x0F) as usize] ^ CRC_TABLE[16 + ((c >> 4) & 0x0F) as usize];
    }
    c
}

#[derive(Debug, PartialEq, Clone)]
pub struct Packet {
    pub data: Vec<u8>,     // 30 Zeichen
    pub wait_finish: bool, // nach dem Senden warten, bis die Maschine fertig ist ("-")
    pub end: usize,        // Ende im EGV-Text (für den Fortschritt)
}

/// EGV-Text in 30-Zeichen-Pakete teilen (Zeilenende = Paketende, Rest mit "F" auffüllen)
pub fn packets(egv: &str) -> Vec<Packet> {
    let b = egv.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let rest = &b[i..];
        let len = match rest.iter().take(30).position(|&c| c == b'\n') { Some(p) => p + 1, None => rest.len().min(30) };
        let mut chunk: Vec<u8> = rest[..len].to_vec();
        let mut used = len;
        // Steuerzeichen direkt nach 30 Zeichen gehören noch dazu
        if chunk.last().map(|c| *c == b'-').unwrap_or(false) && rest.get(len) == Some(&b'\n') { chunk.push(b'\n'); used += 1; }
        let mut wait = false;
        if chunk.last() == Some(&b'\n') {
            chunk.pop();
            if chunk.last() == Some(&b'-') { chunk.pop(); wait = true; }
            if chunk.last() == Some(&b'P') { chunk.push(b'F'); } // Eigenheit der Nano-Boards
            if chunk.is_empty() { chunk.push(b'F'); }
        }
        while chunk.len() < 30 { chunk.push(b'F'); }
        chunk.truncate(30);
        i += used;
        out.push(Packet { data: chunk, wait_finish: wait, end: i });
    }
    out
}

/// Paket für die Leitung: 0x00 + 30 Zeichen + CRC, im EPP-Format (je 32 Byte ein 0xA6 davor)
pub fn frame(data: &[u8]) -> Vec<u8> {
    let mut p = Vec::with_capacity(34);
    p.push(0x00);
    p.extend_from_slice(&data[..30]);
    p.push(crc(data));
    let mut out = Vec::with_capacity(36);
    for chunk in p.chunks(31) {
        out.push(0xA6);
        out.extend_from_slice(chunk);
    }
    out
}

// ---------------------------------------------------------------------
// USB (CH341 im EPP-Modus)
// ---------------------------------------------------------------------

pub trait Ch341: Send {
    fn bulk_write(&mut self, data: &[u8]) -> Result<(), String>;
    fn bulk_read(&mut self, n: usize) -> Result<Vec<u8>, String>;
    fn describe(&self) -> String { "CH341".into() }
}

/// Status lesen: 0xA0 schicken, 6 Bytes lesen, Byte 1 ist der Status
pub fn read_status(u: &mut dyn Ch341) -> Result<u8, String> {
    u.bulk_write(&[0xA0])?;
    let r = u.bulk_read(6)?;
    r.get(1).copied().ok_or_else(|| "short status".to_string())
}

/// Ein Paket senden und bestätigen lassen. Ok(true) = angenommen
pub fn send_packet(u: &mut dyn Ch341, data: &[u8], cancel: &AtomicBool) -> Result<(), String> {
    let wire = frame(data);
    for _attempt in 0..6 {
        // warten, bis das Board Pakete annimmt
        let t0 = Instant::now();
        loop {
            if cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
            let s = read_status(u)?;
            if s == STATUS_OK || s == STATUS_ERROR || s == STATUS_FINISH || s == STATUS_M3_FINISH { break; }
            if s == 0 && t0.elapsed() > Duration::from_secs(5) { return Err("no status".into()); }
            if t0.elapsed() > Duration::from_secs(120) { return Err("busy timeout".into()); }
            thread::sleep(Duration::from_millis(if s == STATUS_BUSY { 20 } else { 5 }));
        }
        u.bulk_write(&wire)?;
        // Bestätigung abwarten
        let mut rejected = false;
        for i in 0..500 {
            let s = read_status(u)?;
            match s {
                STATUS_OK => return Ok(()),
                STATUS_ERROR => { rejected = true; break; }
                _ => {}
            }
            if i > 10 { thread::sleep(Duration::from_millis((i as u64).min(100))); }
        }
        if !rejected { return Err("no confirmation".into()); }
    }
    Err("crc rejected".into())
}

/// Warten, bis die Maschine alle Befehle abgearbeitet hat
pub fn wait_finished(u: &mut dyn Ch341, cancel: &AtomicBool, mut tick: impl FnMut()) -> Result<(), String> {
    let t0 = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
        let s = read_status(u)?;
        if s == 0 { return Err("no status".into()); }
        if s & 0x02 == 0 { return Ok(()); }
        if t0.elapsed() > Duration::from_secs(3600) { return Err("timeout".into()); }
        tick();
        thread::sleep(Duration::from_millis(30));
    }
}

// ---------------------------------------------------------------------
// Laufende Verbindung
// ---------------------------------------------------------------------

/// GRBL-Zeile der Oberfläche -> K40-Handbefehl
#[derive(Debug, PartialEq)]
pub enum Manual { Nothing, Home, Unlock, MoveTo { x: Option<f64>, y: Option<f64>, rel: bool } }

pub fn manual_from_line(line: &str) -> Result<Manual, String> {
    // dieselbe Übersetzung wie bei Ruida (Eilgang, keine Z-Achse)
    match crate::ruida::manual_from_line(line) {
        Ok(crate::ruida::Manual::Nothing) => {
            if line.trim().eq_ignore_ascii_case("$X") { Ok(Manual::Unlock) } else { Ok(Manual::Nothing) }
        }
        Ok(crate::ruida::Manual::Home) => Ok(Manual::Home),
        Ok(crate::ruida::Manual::MoveTo { x, y, rel, .. }) => Ok(Manual::MoveTo { x, y, rel }),
        Err(_) => Err("k40-unsupported".into()),
    }
}

enum Cmd { Line(u64, Manual), Job(String, Vec<(usize, usize)>, usize), Pause, Resume, Stop, Shutdown }

struct Shared {
    tx: Mutex<Sender<Cmd>>,
    alive: AtomicBool,
    busy: AtomicBool,
    cancel: AtomicBool,
    paused: AtomicBool,
    next_id: Mutex<u64>,
    opt: Mutex<K40Options>,
}

#[derive(Clone)]
pub struct K40 {
    sh: Arc<Shared>,
}

impl K40 {
    pub fn start(mut usb: Box<dyn Ch341>, opt: K40Options, emit: Emit) -> Result<K40, String> {
        let st = read_status(usb.as_mut()).map_err(|e| format!("k40: {}", e))?;
        if st == 0 { return Err("k40: no status".into()); }
        let (tx, rx) = channel();
        let sh = Arc::new(Shared {
            tx: Mutex::new(tx), alive: AtomicBool::new(true), busy: AtomicBool::new(false), cancel: AtomicBool::new(false),
            paused: AtomicBool::new(false), next_id: Mutex::new(1), opt: Mutex::new(opt),
        });
        emit("machine-welcome", format!("{{\"firmware\":\"K40\",\"version\":{},\"raw\":{}}}",
            jstr(&sh.opt.lock().unwrap().board), jstr(&format!("{} · Status {}", usb.describe(), st))));
        let k = K40 { sh };
        let w = k.clone();
        thread::spawn(move || w.run(usb, rx, emit));
        Ok(k)
    }

    pub fn is_alive(&self) -> bool { self.sh.alive.load(Ordering::SeqCst) }
    pub fn shutdown(&self) {
        self.sh.cancel.store(true, Ordering::SeqCst);
        let _ = self.sh.tx.lock().unwrap().send(Cmd::Shutdown);
        self.sh.alive.store(false, Ordering::SeqCst);
    }
    fn post(&self, c: Cmd) -> Result<(), String> {
        if !self.is_alive() { return Err("not connected".into()); }
        self.sh.tx.lock().unwrap().send(c).map_err(|_| "not connected".to_string())
    }
    pub fn set_options(&self, o: K40Options) { *self.sh.opt.lock().unwrap() = o; }
    fn options(&self) -> K40Options { self.sh.opt.lock().unwrap().clone() }

    pub fn send_line(&self, line: &str) -> Result<u64, String> {
        let m = manual_from_line(line)?;
        if self.sh.busy.load(Ordering::SeqCst) && m != Manual::Nothing { return Err("busy".into()); }
        let id = { let mut n = self.sh.next_id.lock().unwrap(); *n += 1; *n };
        self.post(Cmd::Line(id, m))?;
        Ok(id)
    }

    pub fn realtime(&self, byte: u8) -> Result<(), String> {
        match byte {
            b'!' => self.pause_job(),
            b'~' => self.resume_job(),
            0x18 => self.stop_job(),
            _ => Ok(()),
        }
    }

    pub fn start_job(&self, lines: Vec<String>) -> Result<usize, String> {
        if self.sh.busy.load(Ordering::SeqCst) { return Err("busy".into()); }
        let opt = self.options();
        let job = build_egv(&parse_gcode(&lines, opt.s_max), &opt)?;
        if job.outside { return Err("outside".into()); }
        self.sh.busy.store(true, Ordering::SeqCst);
        self.sh.cancel.store(false, Ordering::SeqCst);
        self.post(Cmd::Job(job.egv, job.marks, lines.len()))?;
        Ok(lines.len())
    }

    /// Pause/Weiter/Stopp wirken sofort (am Auftrag vorbei)
    pub fn pause_job(&self) -> Result<(), String> { self.sh.paused.store(true, Ordering::SeqCst); self.post(Cmd::Pause) }
    pub fn resume_job(&self) -> Result<(), String> { self.sh.paused.store(false, Ordering::SeqCst); self.post(Cmd::Resume) }
    pub fn stop_job(&self) -> Result<(), String> { self.sh.cancel.store(true, Ordering::SeqCst); self.post(Cmd::Stop) }

    fn run(self, mut usb: Box<dyn Ch341>, rx: Receiver<Cmd>, emit: Emit) {
        let mut pos = (0i64, 0i64); // geschätzte Position (das Board meldet keine)
        let mut homed = false;
        let status = |emit: &Emit, opt: &K40Options, pos: (i64, i64), st: &str| {
            let (x, y) = opt.to_user(pos.0, pos.1);
            let r = |v: f64| (v * 1000.0).round() / 1000.0;
            emit("machine-status", format!("{{\"state\":{},\"sub\":null,\"mpos\":[{},{},0],\"wpos\":[{},{},0],\"feed\":0,\"spindle\":0,\"ov\":[100,100,100],\"pins\":\"\"}}",
                jstr(st), r(x), r(y), r(x), r(y)));
        };
        let mut queue: VecDeque<Cmd> = VecDeque::new();
        let mut last_status = Instant::now() - Duration::from_secs(10);
        let fail = |emit: &Emit, e: &str| emit("machine-disconnected", format!("{{\"reason\":{}}}", jstr(&format!("k40: {}", e))));
        'outer: loop {
            while let Ok(c) = rx.try_recv() { queue.push_back(c); }
            let Some(c) = queue.pop_front() else {
                if last_status.elapsed() > Duration::from_millis(500) {
                    last_status = Instant::now();
                    match read_status(usb.as_mut()) {
                        Ok(0) | Err(_) => { fail(&emit, "no status"); break; }
                        Ok(s) => status(&emit, &self.options(), pos, if s & 0x02 != 0 && s != STATUS_OK { "Run" } else { "Idle" }),
                    }
                }
                match rx.recv_timeout(Duration::from_millis(100)) { Ok(c) => queue.push_back(c), Err(_) => {} }
                if !self.is_alive() { break; }
                continue;
            };
            let opt = self.options();
            match c {
                Cmd::Shutdown => break,
                Cmd::Pause | Cmd::Resume => {
                    // "PN" schaltet die Pause am Board um
                    let mut d = b"PN".to_vec();
                    d.resize(30, b'F');
                    let _ = send_packet(usb.as_mut(), &d, &AtomicBool::new(false));
                }
                Cmd::Stop => {
                    let mut d = b"I".to_vec();
                    d.resize(30, b'F');
                    let _ = send_packet(usb.as_mut(), &d, &AtomicBool::new(false));
                    self.sh.cancel.store(false, Ordering::SeqCst);
                    self.sh.busy.store(false, Ordering::SeqCst);
                    homed = false; // Position unbekannt
                }
                Cmd::Line(id, m) => {
                    let mut e = Egv::new(&opt.board);
                    e.x = pos.0; e.y = pos.1;
                    match m {
                        Manual::Nothing => {}
                        Manual::Home => { e.home(); }
                        Manual::Unlock => { e.out.push_str("IS2P\n"); }
                        Manual::MoveTo { x, y, rel } => {
                            if !homed && !rel {
                                // ohne Referenzfahrt ist die absolute Position unbekannt
                                e.home();
                            }
                            let (cx, cy) = opt.to_user(e.x, e.y);
                            let tx = match x { Some(v) => if rel { cx + v } else { v }, None => cx }.clamp(0.0, opt.bed_w);
                            let ty = match y { Some(v) => if rel { cy + v } else { v }, None => cy }.clamp(0.0, opt.bed_h);
                            let (nx, ny) = opt.to_native(tx, ty);
                            e.rapid_to(nx, ny);
                        }
                    }
                    let mut res = Ok(());
                    for p in packets(&e.out) {
                        if let Err(er) = send_packet(usb.as_mut(), &p.data, &self.sh.cancel) { res = Err(er); break; }
                    }
                    if res.is_ok() {
                        if e.out.contains("IPP") { homed = true; }
                        pos = (e.x, e.y);
                        let _ = wait_finished(usb.as_mut(), &self.sh.cancel, || {});
                        status(&emit, &opt, pos, "Idle");
                        emit("machine-line", format!("{{\"kind\":\"ok\",\"id\":{}}}", id));
                    } else {
                        emit("machine-line", format!("{{\"kind\":\"timeout\",\"id\":{}}}", id));
                        if res.as_ref().err().map(|s| s.as_str()) != Some("cancelled") { fail(&emit, res.as_ref().err().unwrap()); break; }
                    }
                }
                Cmd::Job(egv, marks, total) => {
                    let pk = packets(&egv);
                    let mut aborted: Option<String> = None;
                    let mut last_prog = Instant::now();
                    let mut line_done = 0usize;
                    for (i, p) in pk.iter().enumerate() {
                        // Pause/Stopp zwischen den Paketen
                        while let Ok(c) = rx.try_recv() {
                            match c {
                                Cmd::Stop => { aborted = Some("stopped".into()); }
                                Cmd::Shutdown => { aborted = Some("shutdown".into()); }
                                Cmd::Pause | Cmd::Resume => {
                                    let mut d = b"PN".to_vec(); d.resize(30, b'F');
                                    let _ = send_packet(usb.as_mut(), &d, &AtomicBool::new(false));
                                }
                                other => queue.push_back(other),
                            }
                        }
                        if aborted.is_some() { break; }
                        while self.sh.paused.load(Ordering::SeqCst) && !self.sh.cancel.load(Ordering::SeqCst) {
                            thread::sleep(Duration::from_millis(50));
                            while let Ok(c) = rx.try_recv() {
                                match c {
                                    Cmd::Stop => { aborted = Some("stopped".into()); }
                                    Cmd::Resume => { let mut d = b"PN".to_vec(); d.resize(30, b'F'); let _ = send_packet(usb.as_mut(), &d, &AtomicBool::new(false)); }
                                    Cmd::Shutdown => { aborted = Some("shutdown".into()); }
                                    other => queue.push_back(other),
                                }
                            }
                            if aborted.is_some() { break; }
                        }
                        if aborted.is_some() || self.sh.cancel.load(Ordering::SeqCst) { aborted.get_or_insert("stopped".into()); break; }
                        if let Err(e) = send_packet(usb.as_mut(), &p.data, &self.sh.cancel) {
                            if e == "cancelled" { aborted = Some("stopped".into()); break; }
                            fail(&emit, &e);
                            emit("machine-job-done", format!("{{\"aborted\":true,\"reason\":\"error\",\"acked\":{},\"sent\":{},\"total\":{},\"errors\":1}}", line_done, line_done, total));
                            break 'outer;
                        }
                        line_done = marks.iter().take_while(|m| m.0 <= p.end).map(|m| m.1).last().unwrap_or(line_done);
                        if p.wait_finish {
                            let _ = wait_finished(usb.as_mut(), &self.sh.cancel, || {});
                        }
                        if last_prog.elapsed() > Duration::from_millis(250) || i + 1 == pk.len() {
                            last_prog = Instant::now();
                            emit("machine-job-progress", format!("{{\"sent\":{},\"acked\":{},\"total\":{},\"paused\":{},\"toolChange\":false,\"stopping\":false,\"buffer\":0}}",
                                line_done, line_done.min(total.saturating_sub(1)), total, self.sh.paused.load(Ordering::SeqCst)));
                            status(&emit, &opt, pos, "Run");
                        }
                    }
                    match aborted {
                        Some(r) => {
                            let mut d = b"I".to_vec(); d.resize(30, b'F');
                            let _ = send_packet(usb.as_mut(), &d, &AtomicBool::new(false));
                            homed = false;
                            emit("machine-job-done", format!("{{\"aborted\":true,\"reason\":{},\"acked\":{},\"sent\":{},\"total\":{},\"errors\":0}}", jstr(&r), line_done, line_done, total));
                            if r == "shutdown" { break; }
                        }
                        None => {
                            let _ = wait_finished(usb.as_mut(), &self.sh.cancel, || {});
                            pos = (0, 0);
                            homed = true;
                            emit("machine-job-done", format!("{{\"aborted\":false,\"reason\":\"done\",\"acked\":{},\"sent\":{},\"total\":{},\"errors\":0}}", total, total, total));
                        }
                    }
                    self.sh.cancel.store(false, Ordering::SeqCst);
                    self.sh.paused.store(false, Ordering::SeqCst);
                    self.sh.busy.store(false, Ordering::SeqCst);
                    status(&emit, &opt, pos, "Idle");
                }
            }
        }
        self.sh.alive.store(false, Ordering::SeqCst);
        self.sh.busy.store(false, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distances() {
        assert_eq!(distance(0), "");
        assert_eq!(distance(1), "a");
        assert_eq!(distance(25), "y");
        assert_eq!(distance(26), "|a");
        assert_eq!(distance(51), "|z");
        assert_eq!(distance(52), "052");
        assert_eq!(distance(255), "z");
        assert_eq!(distance(256), "za");
        assert_eq!(distance(600), "zz090");
    }

    #[test]
    fn speed_codes_match_meerk40t() {
        // Werte erzeugt mit meerk40t/lihuiyu/laserspeed.py (suffix_c=True, fix_limit, fix_lows)
        assert_eq!(speed_code(1.0, "M2"), "CV1551941002013022C");
        assert_eq!(speed_code(10.0, "M2"), "CV2452421011000060C");
        assert_eq!(speed_code(20.0, "M2"), "CV2502451021000015C");
        assert_eq!(speed_code(30.0, "M2"), "CV2521601031000007C");
        assert_eq!(speed_code(100.0, "M2"), "CV2542471101000000C");
        assert_eq!(speed_code(300.0, "M2"), "CV2551621128000000C");
        assert_eq!(speed_code(20.0, "B2"), "CV2422341021000031C");
        assert_eq!(speed_code(50.0, "B2"), "CV2482371051000005C");
        assert_eq!(speed_code(30.0, "M"), "CV2521601C");
        assert_eq!(speed_code(30.0, "A"), "CV2460821C");
    }

    #[test]
    fn crc_and_frame() {
        let mut d = b"IPP".to_vec();
        d.resize(30, b'F');
        let f = frame(&d);
        assert_eq!(f.len(), 34);
        assert_eq!(f[0], 0xA6);
        assert_eq!(f[1], 0x00);
        assert_eq!(f[32], 0xA6);
        assert_eq!(f[33], crc(&d));
    }

    #[test]
    fn packetizing() {
        let p = packets("IPP\nIBzzaS1P\n");
        assert_eq!(p.len(), 2);
        assert_eq!(&p[0].data[..4], b"IPPF");
        assert_eq!(p[0].data.len(), 30);
        let p = packets("FNSE-\n");
        assert!(p[0].wait_finish);
        assert_eq!(&p[0].data[..5], b"FNSEF");
        // lange Programmzeile wird in 30er-Stücke geteilt
        let long = format!("I{}NBRS1E{}FNSE-\n", speed_code(20.0, "M2"), "Da".repeat(40));
        let p = packets(&long);
        assert!(p.len() >= 4);
        assert!(p.iter().all(|x| x.data.len() == 30));
        assert!(p.last().unwrap().wait_finish);
    }

    #[test]
    fn egv_square() {
        let opt = K40Options { bed_w: 300.0, bed_h: 200.0, ..Default::default() };
        let lines: Vec<String> = ["M3 S500", "G0 X10 Y190", "G1 X20 F600", "G1 Y180", "G1 X10", "G1 Y190", "M5"].iter().map(|s| s.to_string()).collect();
        let job = build_egv(&parse_gcode(&lines, 1000.0), &opt).unwrap();
        assert_eq!(job.cuts, 4);
        assert!(job.egv.starts_with("IPP\n"));
        assert!(job.egv.contains("S1E"));
        assert!(job.egv.contains(&speed_code(10.0, "M2")));
        assert!(job.egv.contains("FNSE-\n"));
        // 10 mm ≈ 393 Schritte = "z138"; jeder Achsenwechsel bekommt seinen Richtungs-Code
        assert!(job.egv.contains("BDz138Rz138Tz138Lz138"), "{}", job.egv);
        assert!(job.egv.ends_with("S1P\n"));
    }

    #[test]
    fn diagonal_line_uses_m() {
        let mut e = Egv::new("M2");
        e.program_mode(20.0);
        e.line_to(100, 100, true);
        assert!(e.out.ends_with("MD100"), "{}", e.out);
        assert_eq!((e.x, e.y), (100, 100));
        let mut e = Egv::new("M2");
        e.program_mode(20.0);
        e.line_to(300, 100, true); // flach: abwechselnd gerade und diagonal
        assert_eq!((e.x, e.y), (300, 100));
    }

    // ---------------- Schein-Board ----------------
    struct FakeBoard {
        pub got: Arc<Mutex<Vec<Vec<u8>>>>,
        status_seq: VecDeque<u8>,
        reject_next: bool,
        last_was_packet: bool,
    }
    impl Ch341 for FakeBoard {
        fn bulk_write(&mut self, data: &[u8]) -> Result<(), String> {
            if data == [0xA0] { return Ok(()); }
            assert_eq!(data.len(), 34);
            let payload: Vec<u8> = data[2..32].to_vec();
            assert_eq!(data[33], crc(&payload), "CRC");
            if self.reject_next { self.reject_next = false; self.status_seq.push_back(STATUS_ERROR); return Ok(()); }
            self.got.lock().unwrap().push(payload);
            self.last_was_packet = true;
            self.status_seq.push_back(STATUS_BUSY);
            self.status_seq.push_back(STATUS_OK);
            Ok(())
        }
        fn bulk_read(&mut self, _n: usize) -> Result<Vec<u8>, String> {
            let s = self.status_seq.pop_front().unwrap_or(STATUS_FINISH);
            Ok(vec![0xFF, s, 0, 0, 0, 0])
        }
    }

    #[test]
    fn resend_on_crc_error() {
        let got = Arc::new(Mutex::new(Vec::new()));
        let mut b = FakeBoard { got: got.clone(), status_seq: VecDeque::new(), reject_next: true, last_was_packet: false };
        let mut d = b"IPP".to_vec(); d.resize(30, b'F');
        send_packet(&mut b, &d, &AtomicBool::new(false)).unwrap();
        assert_eq!(got.lock().unwrap().len(), 1);
    }

    #[test]
    fn worker_job_and_manual() {
        let got = Arc::new(Mutex::new(Vec::new()));
        let b = FakeBoard { got: got.clone(), status_seq: VecDeque::new(), reject_next: false, last_was_packet: false };
        let ev: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let e2 = ev.clone();
        let emit: Emit = Arc::new(move |n: &str, j: String| e2.lock().unwrap().push((n.to_string(), j)));
        let k = K40::start(Box::new(b), K40Options::default(), emit).unwrap();
        let n = k.start_job(["M3 S500", "G0 X10 Y10", "G1 X50 F600", "G1 Y50", "M5"].iter().map(|s| s.to_string()).collect()).unwrap();
        assert_eq!(n, 5);
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(5) && !ev.lock().unwrap().iter().any(|(n, _)| n == "machine-job-done") { thread::sleep(Duration::from_millis(20)); }
        assert!(ev.lock().unwrap().iter().any(|(n, j)| n == "machine-job-done" && j.contains("\"aborted\":false")));
        let all: String = got.lock().unwrap().iter().map(|p| String::from_utf8_lossy(p).to_string()).collect();
        assert!(all.starts_with("IPP"), "{}", all);
        assert!(all.contains("S1E"));
        let id = k.send_line("$J=G21 G91 X10 F3000").unwrap();
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(3) && !ev.lock().unwrap().iter().any(|(n, j)| n == "machine-line" && j.contains(&format!("\"id\":{}", id))) { thread::sleep(Duration::from_millis(20)); }
        assert!(ev.lock().unwrap().iter().any(|(n, j)| n == "machine-line" && j.contains(&format!("\"kind\":\"ok\",\"id\":{}", id))));
        assert!(k.send_line("$$").is_err());
        k.shutdown();
    }
}
