//! RUIDA – CO₂-Laser mit Ruida-Steuerung (RDC6442, RDC6445, RDC6332, RDLC320 …)
//!
//! Ruida-Steuerungen sprechen kein GRBL. Sie bekommen einen kompletten Auftrag im
//! RD-Format (dasselbe wie die .rd-Dateien von RDWorks/LightBurn) und arbeiten ihn selbst ab.
//!
//! Dieser Teil
//!   - übersetzt unseren Laser-G-Code in RD-Befehle (Bewegen/Schneiden, Geschwindigkeit, Leistung,
//!     ein „Part“ (Ebene) pro Kombination aus Geschwindigkeit und Leistung)
//!   - verschlüsselt („swizzle“) die Bytes – Schlüssel 0x88 (RDC644x), 0x11 (634x), 0x38
//!   - spricht mit der Steuerung über Netzwerk (UDP 50200/40200, mit Prüfsumme und ACK)
//!     oder USB (FTDI, ohne Prüfsumme/ACK)
//!   - fragt Status und Position ab, fährt von Hand, Referenzfahrt, Pause/Weiter/Stopp
//!   - meldet dieselben Ereignisse wie die GRBL-Verbindung (machine-status, machine-job-… ),
//!     damit die Oberfläche fast nichts Neues braucht
//!
//! Protokoll-Wissen nach dem MIT-lizenzierten MeerK40t (meerk40t/ruida/rdjob.py,
//! ruidasession.py, udp_transport.py, usb_transport.py) und der RDWorks-Analyse von
//! jnweiger/ruida-laser.
//!
//! Koordinaten: Die Steuerung rechnet in Mikrometern ab ihrem Maschinen-Nullpunkt
//! (meist hinten rechts). Unser Programm rechnet in mm ab unten links (Y nach oben).
//! `RdOptions::origin` sagt, in welcher Ecke der Maschinen-Nullpunkt liegt.

use crate::machine::{jstr, Emit};
use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------

pub const ACK: u8 = 0xCC;
pub const NAK: u8 = 0xCF;
pub const ENQ: u8 = 0xCE;

pub const MEM_STATUS: [u8; 2] = [0x04, 0x00];
pub const MEM_X: [u8; 2] = [0x04, 0x21];
pub const MEM_Y: [u8; 2] = [0x04, 0x31];
pub const MEM_Z: [u8; 2] = [0x04, 0x41];
pub const MEM_BED_X: [u8; 2] = [0x00, 0x26];
pub const MEM_BED_Y: [u8; 2] = [0x00, 0x36];
pub const MEM_CARD_ID: [u8; 2] = [0x05, 0x7E];

pub const ST_JOB_RUNNING: i64 = 0x0000_0001;
// 0x0000_0002 = „Part end“ (wird hier nicht gebraucht)
pub const ST_MOVING: i64 = 0x0100_0000;

pub const MAGICS: [u8; 3] = [0x88, 0x11, 0x38];

/// UDP: Steuerung hört auf 50200 und antwortet an 40200
pub const UDP_PORT: u16 = 50200;
pub const UDP_LISTEN: u16 = 40200;

/// Größe eines Datenpakets beim Senden eines Auftrags (MeerK40t: ~1000)
const CHUNK: usize = 1000;

// ---------------------------------------------------------------------
// Verschlüsselung („swizzle“) und Zahlen
// ---------------------------------------------------------------------

pub fn swizzle_byte(b: u8, magic: u8) -> u8 {
    let mut b = b as u32;
    b ^= (b >> 7) & 0xFF;
    b ^= (b << 7) & 0xFF;
    b ^= (b >> 7) & 0xFF;
    b ^= magic as u32;
    ((b + 1) & 0xFF) as u8
}

pub fn unswizzle_byte(b: u8, magic: u8) -> u8 {
    let mut b = (b as u32 + 255) & 0xFF; // b - 1
    b ^= magic as u32;
    b ^= (b >> 7) & 0xFF;
    b ^= (b << 7) & 0xFF;
    b ^= (b >> 7) & 0xFF;
    b as u8
}

#[derive(Clone)]
pub struct Lut {
    sw: [u8; 256],
    un: [u8; 256],
}

impl Lut {
    pub fn new(magic: u8) -> Lut {
        let mut sw = [0u8; 256];
        let mut un = [0u8; 256];
        for i in 0..256 {
            sw[i] = swizzle_byte(i as u8, magic);
            un[i] = unswizzle_byte(i as u8, magic);
        }
        Lut { sw, un }
    }
    pub fn swizzle(&self, d: &[u8]) -> Vec<u8> { d.iter().map(|&b| self.sw[b as usize]).collect() }
    pub fn unswizzle(&self, d: &[u8]) -> Vec<u8> { d.iter().map(|&b| self.un[b as usize]).collect() }
}

/// 35-Bit-Zahl in 5 Bytes à 7 Bit (höchstes zuerst)
pub fn enc35(v: i64) -> [u8; 5] {
    [((v >> 28) & 0x7F) as u8, ((v >> 21) & 0x7F) as u8, ((v >> 14) & 0x7F) as u8, ((v >> 7) & 0x7F) as u8, (v & 0x7F) as u8]
}

/// 14-Bit-Zahl in 2 Bytes à 7 Bit
pub fn enc14(v: i64) -> [u8; 2] {
    [((v >> 7) & 0x7F) as u8, (v & 0x7F) as u8]
}

pub fn dec35(d: &[u8]) -> i64 {
    let mut v: i64 = 0;
    for &b in d.iter().take(5) { v = (v << 7) | (b & 0x7F) as i64; }
    v &= 0x7_FFFF_FFFF;
    if v > 0x3_FFFF_FFFF { v - 0x8_0000_0000 } else { v }
}

/// Leistung in % -> 14 Bit (16383 = 100 %)
pub fn enc_power(percent: f64) -> [u8; 2] {
    enc14((percent.clamp(0.0, 100.0) * 16383.0 / 100.0) as i64)
}

/// Geschwindigkeit in mm/s -> µm/s (35 Bit)
pub fn enc_speed(mm_s: f64) -> [u8; 5] {
    enc35((mm_s * 1000.0) as i64)
}

fn cmd(parts: &[&[u8]]) -> Vec<u8> {
    let mut v = Vec::new();
    for p in parts { v.extend_from_slice(p); }
    v
}

// ---------------------------------------------------------------------
// Koordinaten
// ---------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Origin { TopLeft, TopRight, BottomLeft, BottomRight }

impl Origin {
    pub fn parse(s: &str) -> Origin {
        match s {
            "top-left" => Origin::TopLeft,
            "bottom-left" => Origin::BottomLeft,
            "bottom-right" => Origin::BottomRight,
            _ => Origin::TopRight, // die meisten Ruida-Maschinen: hinten rechts
        }
    }
}

#[derive(Clone, Debug)]
pub struct RdOptions {
    pub bed_w: f64,   // mm
    pub bed_h: f64,   // mm
    pub origin: Origin,
    pub s_max: f64,   // S-Wert für 100 % im G-Code
    pub magic: u8,
    pub min_power: f64, // % – Ruida-„Min-Leistung“ (Ecken); 0 = wie Max
}

impl Default for RdOptions {
    fn default() -> Self {
        RdOptions { bed_w: 600.0, bed_h: 400.0, origin: Origin::TopRight, s_max: 1000.0, magic: 0x88, min_power: 0.0 }
    }
}

impl RdOptions {
    /// Programm-mm (unten links, Y nach oben) -> Maschinen-µm
    pub fn to_native(&self, x: f64, y: f64) -> (i64, i64) {
        let nx = match self.origin { Origin::TopRight | Origin::BottomRight => self.bed_w - x, _ => x };
        let ny = match self.origin { Origin::TopLeft | Origin::TopRight => self.bed_h - y, _ => y };
        ((nx * 1000.0).round() as i64, (ny * 1000.0).round() as i64)
    }
    /// Maschinen-µm -> Programm-mm
    pub fn to_user(&self, nx: i64, ny: i64) -> (f64, f64) {
        let fx = nx as f64 / 1000.0;
        let fy = ny as f64 / 1000.0;
        let x = match self.origin { Origin::TopRight | Origin::BottomRight => self.bed_w - fx, _ => fx };
        let y = match self.origin { Origin::TopLeft | Origin::TopRight => self.bed_h - fy, _ => fy };
        (x, y)
    }
}

// ---------------------------------------------------------------------
// G-Code lesen (nur was der Laser braucht)
// ---------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub enum Seg {
    Move { x: f64, y: f64 },
    Cut { x: f64, y: f64, speed: f64, power: f64 }, // speed mm/s, power %
}

/// Wörter einer Zeile: [('G', 1.0), ('X', 10.0) …] ohne Kommentare
pub fn words(line: &str) -> Vec<(char, f64)> {
    let mut s = String::with_capacity(line.len());
    let mut depth = 0;
    for c in line.chars() {
        if c == ';' && depth == 0 { break; }
        if c == '(' { depth += 1; continue; }
        if c == ')' { if depth > 0 { depth -= 1; } continue; }
        if depth == 0 { s.push(c.to_ascii_uppercase()); }
    }
    let b: Vec<char> = s.chars().filter(|c| !c.is_whitespace()).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_alphabetic() {
            let mut j = i + 1;
            while j < b.len() && (b[j].is_ascii_digit() || b[j] == '.' || b[j] == '-' || b[j] == '+') { j += 1; }
            let num: String = b[i + 1..j].iter().collect();
            if let Ok(v) = num.parse::<f64>() { out.push((c, v)); }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// Laser-G-Code -> Strecken (mit Zeilennummer). Bögen werden in kurze Stücke zerlegt.
pub fn parse_gcode(lines: &[String], s_max: f64) -> Vec<(Seg, usize)> {
    let mut out = Vec::new();
    let (mut x, mut y) = (0.0f64, 0.0f64);
    let mut motion = 0;
    let mut abs = true;
    let mut scale = 1.0; // mm
    let mut laser_on = false;
    let mut s = 0.0f64;
    let mut f = 600.0f64; // mm/min
    let s_max = if s_max > 0.0 { s_max } else { 1000.0 };
    for (idx, raw) in lines.iter().enumerate() {
        let t = raw.trim();
        if t.is_empty() || t.starts_with('$') || t.starts_with('%') { continue; }
        let w = words(t);
        let mut nx: Option<f64> = None;
        let mut ny: Option<f64> = None;
        let (mut i_, mut j_, mut r_) = (None, None, None);
        let mut has_motion_word = false;
        for &(c, v) in &w {
            match c {
                'G' => {
                    let g = (v * 10.0).round() as i32;
                    match g {
                        0 => { motion = 0; has_motion_word = true; }
                        10 => { motion = 1; has_motion_word = true; }
                        20 => { motion = 2; has_motion_word = true; }
                        30 => { motion = 3; has_motion_word = true; }
                        200 => scale = 25.4,
                        210 => scale = 1.0,
                        900 => abs = true,
                        910 => abs = false,
                        _ => {}
                    }
                }
                'M' => match v as i32 { 3 | 4 => laser_on = true, 5 => laser_on = false, 2 | 30 => laser_on = false, _ => {} },
                'S' => s = v,
                'F' => f = v * scale,
                'X' => nx = Some(v * scale),
                'Y' => ny = Some(v * scale),
                'I' => i_ = Some(v * scale),
                'J' => j_ = Some(v * scale),
                'R' => r_ = Some(v * scale),
                _ => {}
            }
        }
        // G4, G10, G92 … : Achswerte gehören nicht zu einer Bewegung
        if w.iter().any(|&(c, v)| c == 'G' && matches!((v * 10.0).round() as i32, 40 | 100 | 920 | 280 | 300 | 530 | 540)) { continue; }
        if nx.is_none() && ny.is_none() && !(motion >= 2 && (i_.is_some() || j_.is_some())) { let _ = has_motion_word; continue; }
        let tx = match nx { Some(v) => if abs { v } else { x + v }, None => x };
        let ty = match ny { Some(v) => if abs { v } else { y + v }, None => y };
        let cutting = motion != 0 && laser_on && s > 0.0;
        let power = (s / s_max * 100.0).clamp(0.0, 100.0);
        let speed = (f / 60.0).max(0.1);
        let mk = |px: f64, py: f64| if cutting { Seg::Cut { x: px, y: py, speed, power } } else { Seg::Move { x: px, y: py } };
        if motion >= 2 {
            // Mittelpunkt bestimmen
            let (cx, cy) = if let Some(r) = r_ {
                let (dx, dy) = (tx - x, ty - y);
                let d = (dx * dx + dy * dy).sqrt();
                if d < 1e-9 { out.push((mk(tx, ty), idx)); x = tx; y = ty; continue; }
                let h = ((r * r) - (d * d / 4.0)).max(0.0).sqrt();
                let (mx, my) = (x + dx / 2.0, y + dy / 2.0);
                // G2 (im Uhrzeigersinn) mit positivem R: Mittelpunkt rechts der Sehne
                let sign = if (motion == 2) == (r > 0.0) { -1.0 } else { 1.0 };
                (mx - sign * h * dy / d, my + sign * h * dx / d)
            } else {
                (x + i_.unwrap_or(0.0), y + j_.unwrap_or(0.0))
            };
            let rad = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
            let a0 = (y - cy).atan2(x - cx);
            let a1 = (ty - cy).atan2(tx - cx);
            let mut sweep = a1 - a0;
            if motion == 2 { if sweep >= -1e-9 { sweep -= 2.0 * std::f64::consts::PI; } } else if sweep <= 1e-9 { sweep += 2.0 * std::f64::consts::PI; }
            let len = sweep.abs() * rad;
            let n = ((len / 0.5).ceil() as usize).clamp(2, 720);
            for k in 1..=n {
                let a = a0 + sweep * (k as f64 / n as f64);
                let (px, py) = if k == n { (tx, ty) } else { (cx + rad * a.cos(), cy + rad * a.sin()) };
                out.push((mk(px, py), idx));
            }
        } else {
            out.push((mk(tx, ty), idx));
        }
        x = tx;
        y = ty;
    }
    out
}

// ---------------------------------------------------------------------
// RD-Auftrag bauen
// ---------------------------------------------------------------------

/// Fertiger Auftrag: Befehle (unverschlüsselt) mit G-Code-Zeile, für Fortschritt und Pakete
pub struct RdJob {
    pub commands: Vec<(Vec<u8>, usize)>,
    pub min: (i64, i64),
    pub max: (i64, i64),
    pub parts: usize,
    pub cuts: usize,
    pub outside: bool, // Teile liegen außerhalb des Betts
}

impl RdJob {
    /// Alle Bytes (unverschlüsselt)
    pub fn bytes(&self) -> Vec<u8> {
        let mut v = Vec::new();
        for (c, _) in &self.commands { v.extend_from_slice(c); }
        v
    }
    /// Verschlüsselte .rd-Datei
    pub fn file(&self, magic: u8) -> Vec<u8> { Lut::new(magic).swizzle(&self.bytes()) }
    /// Pakete zum Senden (je ≤ ~1000 Bytes, nur an Befehlsgrenzen geteilt) mit letzter G-Code-Zeile
    pub fn packets(&self) -> Vec<(Vec<u8>, usize)> {
        let mut out = Vec::new();
        let mut cur: Vec<u8> = Vec::new();
        let mut line = 0;
        for (c, l) in &self.commands {
            if !cur.is_empty() && cur.len() + c.len() > CHUNK {
                out.push((std::mem::take(&mut cur), line));
            }
            cur.extend_from_slice(c);
            line = line.max(*l);
        }
        if !cur.is_empty() { out.push((cur, line)); }
        out
    }
}

const PALETTE: [i64; 8] = [0x0000FF, 0xFF0000, 0x00A000, 0xFF8000, 0x8000FF, 0x00A0A0, 0xA0A000, 0x808080];

pub fn build_rd(segs: &[(Seg, usize)], opt: &RdOptions) -> Result<RdJob, String> {
    // Parts: eine pro (Geschwindigkeit, Leistung)
    let key = |sp: f64, pw: f64| ((sp * 10.0).round() as i64, (pw * 10.0).round() as i64);
    let mut part_of: HashMap<(i64, i64), usize> = HashMap::new();
    let mut part_list: Vec<(f64, f64)> = Vec::new();
    let mut part_bounds: Vec<[i64; 4]> = Vec::new();
    let (mut gx0, mut gy0, mut gx1, mut gy1) = (i64::MAX, i64::MAX, i64::MIN, i64::MIN);
    let mut cuts = 0;
    let mut outside = false;
    {
        let (mut cx, mut cy) = (0.0f64, 0.0f64);
        for (s, _) in segs {
            match *s {
                Seg::Move { x, y } => { cx = x; cy = y; }
                Seg::Cut { x, y, speed, power } => {
                    cuts += 1;
                    let k = key(speed, power);
                    let p = match part_of.get(&k) {
                        Some(&p) => p,
                        None if part_list.len() < 256 => {
                            part_list.push((speed, power));
                            part_bounds.push([i64::MAX, i64::MAX, i64::MIN, i64::MIN]);
                            part_of.insert(k, part_list.len() - 1);
                            part_list.len() - 1
                        }
                        None => part_list.len() - 1,
                    };
                    for &(px, py) in &[(cx, cy), (x, y)] {
                        if px < -0.01 || py < -0.01 || px > opt.bed_w + 0.01 || py > opt.bed_h + 0.01 { outside = true; }
                        let (nx, ny) = opt.to_native(px, py);
                        let b = &mut part_bounds[p];
                        b[0] = b[0].min(nx); b[1] = b[1].min(ny); b[2] = b[2].max(nx); b[3] = b[3].max(ny);
                        gx0 = gx0.min(nx); gy0 = gy0.min(ny); gx1 = gx1.max(nx); gy1 = gy1.max(ny);
                    }
                    cx = x; cy = y;
                }
            }
        }
    }
    if cuts == 0 { return Err("no cuts".into()); }

    let mut c: Vec<(Vec<u8>, usize)> = Vec::new();
    let push = |c: &mut Vec<(Vec<u8>, usize)>, v: Vec<u8>, l: usize| c.push((v, l));

    // ---------------- Kopf ----------------
    push(&mut c, vec![0xD8, 0x10], 0);           // Bezug: Maschinen-Nullpunkt (absolut)
    push(&mut c, vec![0xE6, 0x01], 0);           // absolute Koordinaten
    push(&mut c, vec![0xF0], 0);                 // Bezugspunkt setzen
    push(&mut c, vec![0xF1, 0x02, 0x00], 0);     // Block-Schneiden aus
    push(&mut c, vec![0xD8, 0x00], 0);           // Start
    push(&mut c, cmd(&[&[0xE7, 0x06], &enc35(0), &enc35(0)]), 0);
    push(&mut c, vec![0xE7, 0x38, 0x00], 0);
    push(&mut c, cmd(&[&[0xE7, 0x03], &enc35(gx1), &enc35(gy0)]), 0);
    push(&mut c, cmd(&[&[0xE7, 0x07], &enc35(gx0), &enc35(gy1)]), 0);
    push(&mut c, cmd(&[&[0xE7, 0x50], &enc35(gx1), &enc35(gy0)]), 0);
    push(&mut c, cmd(&[&[0xE7, 0x51], &enc35(gx0), &enc35(gy1)]), 0);
    push(&mut c, cmd(&[&[0xE7, 0x04], &enc14(1), &enc14(1), &enc14(0), &enc14(0), &enc14(0), &enc14(0), &enc14(0)]), 0);
    push(&mut c, vec![0xE7, 0x05, 0x00], 0);
    let minp = |p: f64| if opt.min_power > 0.0 { opt.min_power.min(p) } else { p };
    for (i, &(sp, pw)) in part_list.iter().enumerate() {
        let p = i as u8;
        let b = part_bounds[i];
        push(&mut c, cmd(&[&[0xC9, 0x04, p], &enc_speed(sp)]), 0);
        push(&mut c, cmd(&[&[0xC6, 0x31, p], &enc_power(minp(pw))]), 0);
        push(&mut c, cmd(&[&[0xC6, 0x32, p], &enc_power(pw)]), 0);
        push(&mut c, cmd(&[&[0xC6, 0x41, p], &enc_power(minp(pw))]), 0);
        push(&mut c, cmd(&[&[0xC6, 0x42, p], &enc_power(pw)]), 0);
        push(&mut c, cmd(&[&[0xCA, 0x06, p], &enc35(PALETTE[i % PALETTE.len()])]), 0);
        push(&mut c, vec![0xCA, 0x41, p, 0x00], 0);
        push(&mut c, cmd(&[&[0xE7, 0x52, p], &enc35(b[0]), &enc35(b[1])]), 0);
        push(&mut c, cmd(&[&[0xE7, 0x53, p], &enc35(b[2]), &enc35(b[3])]), 0);
        push(&mut c, cmd(&[&[0xE7, 0x61, p], &enc35(b[0]), &enc35(b[1])]), 0);
        push(&mut c, cmd(&[&[0xE7, 0x62, p], &enc35(b[2]), &enc35(b[3])]), 0);
    }
    push(&mut c, vec![0xCA, 0x22, (part_list.len() - 1) as u8], 0);
    push(&mut c, cmd(&[&[0xE7, 0x54, 0x00], &enc35(0)]), 0);
    push(&mut c, cmd(&[&[0xE7, 0x54, 0x01], &enc35(0)]), 0);
    push(&mut c, cmd(&[&[0xE7, 0x55, 0x00], &enc35(0)]), 0);
    push(&mut c, cmd(&[&[0xE7, 0x55, 0x01], &enc35(0)]), 0);
    push(&mut c, cmd(&[&[0xF1, 0x03], &enc35(0), &enc35(0)]), 0);
    push(&mut c, cmd(&[&[0xE7, 0x0A], &enc35(0)]), 0);
    push(&mut c, vec![0xEA, 0x00], 0);
    push(&mut c, vec![0xE7, 0x60, 0x00], 0);
    push(&mut c, vec![0xE7, 0x0B, 0x00], 0);
    push(&mut c, cmd(&[&[0xE7, 0x13], &enc35(gx0), &enc35(gy0)]), 0);
    push(&mut c, cmd(&[&[0xE7, 0x17], &enc35(gx1), &enc35(gy1)]), 0);
    push(&mut c, cmd(&[&[0xE7, 0x23], &enc35(0), &enc35(0)]), 0);
    push(&mut c, vec![0xE7, 0x24, 0x00], 0);
    push(&mut c, cmd(&[&[0xE7, 0x08], &enc14(1), &enc14(1), &enc14(0), &enc14(1123), &enc14(-3328), &enc14(4), &enc14(3480)]), 0);

    // ---------------- Bahnen ----------------
    let layer_end = |c: &mut Vec<(Vec<u8>, usize)>, l: usize| {
        c.push((vec![0xE7, 0x00], l));
        c.push((vec![0xCA, 0x01, 0x00], l));
        c.push((vec![0xCA, 0x01, 0x30], l));
    };
    let mut cur_part: Option<usize> = None;
    let mut cur_sp_pw: (f64, f64) = (-1.0, -1.0);
    let (mut nx, mut ny) = (0i64, 0i64);
    let mut first_move = true;
    let mut pending: Option<(f64, f64, usize)> = None;
    let mut last_user = (0.0f64, 0.0f64);
    let lim = 8191;
    for (s, l) in segs {
        match *s {
            Seg::Move { x, y } => { pending = Some((x, y, *l)); last_user = (x, y); }
            Seg::Cut { x, y, speed, power } => {
                let p = part_of.get(&key(speed, power)).copied().unwrap_or(part_list.len() - 1);
                if cur_part != Some(p) {
                    if cur_part.is_some() { layer_end(&mut c, *l); }
                    c.push((vec![0xCA, 0x02, p as u8], *l));
                    c.push((vec![0xCA, 0x01, 0x10], *l));
                    c.push((cmd(&[&[0xC9, 0x02], &enc_speed(speed)]), *l));
                    c.push((cmd(&[&[0xC6, 0x12], &enc35(0)]), *l));
                    c.push((cmd(&[&[0xC6, 0x13], &enc35(0)]), *l));
                    c.push((cmd(&[&[0xC6, 0x01], &enc_power(minp(power))]), *l));
                    c.push((cmd(&[&[0xC6, 0x02], &enc_power(power)]), *l));
                    c.push((cmd(&[&[0xC6, 0x21], &enc_power(minp(power))]), *l));
                    c.push((cmd(&[&[0xC6, 0x22], &enc_power(power)]), *l));
                    c.push((vec![0xCA, 0x03, 0x01], *l));
                    cur_part = Some(p);
                    cur_sp_pw = (speed, power);
                } else if cur_sp_pw != (speed, power) {
                    // mehr als 256 Kombinationen: im selben Part umstellen
                    if cur_sp_pw.0 != speed { c.push((cmd(&[&[0xC9, 0x02], &enc_speed(speed)]), *l)); }
                    if cur_sp_pw.1 != power {
                        c.push((cmd(&[&[0xC6, 0x02], &enc_power(power)]), *l));
                        c.push((cmd(&[&[0xC6, 0x01], &enc_power(minp(power))]), *l));
                    }
                    cur_sp_pw = (speed, power);
                }
                // Anfahren (Laser aus)
                let start = pending.take().map(|(px, py, pl)| (px, py, pl)).or(if first_move { Some((last_user.0, last_user.1, *l)) } else { None });
                if let Some((px, py, pl)) = start {
                    let (tx, ty) = opt.to_native(px, py);
                    let (dx, dy) = (tx - nx, ty - ny);
                    if first_move || dx.abs() > lim || dy.abs() > lim { c.push((cmd(&[&[0x88], &enc35(tx), &enc35(ty)]), pl)); first_move = false; }
                    else if dx == 0 && dy != 0 { c.push((cmd(&[&[0x8B], &enc14(dy)]), pl)); }
                    else if dy == 0 && dx != 0 { c.push((cmd(&[&[0x8A], &enc14(dx)]), pl)); }
                    else if dx != 0 || dy != 0 { c.push((cmd(&[&[0x89], &enc14(dx), &enc14(dy)]), pl)); }
                    nx = tx; ny = ty;
                }
                // Schneiden
                let (tx, ty) = opt.to_native(x, y);
                let (dx, dy) = (tx - nx, ty - ny);
                if dx.abs() > lim || dy.abs() > lim { c.push((cmd(&[&[0xA8], &enc35(tx), &enc35(ty)]), *l)); }
                else if dx == 0 && dy != 0 { c.push((cmd(&[&[0xAB], &enc14(dy)]), *l)); }
                else if dy == 0 && dx != 0 { c.push((cmd(&[&[0xAA], &enc14(dx)]), *l)); }
                else if dx != 0 || dy != 0 { c.push((cmd(&[&[0xA9], &enc14(dx), &enc14(dy)]), *l)); }
                nx = tx; ny = ty;
                last_user = (x, y);
            }
        }
    }

    // ---------------- Ende ----------------
    let last_line = segs.last().map(|s| s.1).unwrap_or(0);
    layer_end(&mut c, last_line);
    let sum: u64 = c.iter().map(|(v, _)| v.iter().map(|&b| b as u64).sum::<u64>()).sum();
    c.push((cmd(&[&[0xE5, 0x05], &enc35((sum + 0xD7) as i64)]), last_line));
    c.push((vec![0xD7], last_line));

    Ok(RdJob { commands: c, min: (gx0, gy0), max: (gx1, gy1), parts: part_list.len(), cuts, outside })
}

// ---------------------------------------------------------------------
// Verbindung (Netzwerk oder USB)
// ---------------------------------------------------------------------

pub trait Link: Send {
    fn send(&mut self, data: &[u8]) -> io::Result<()>;
    /// UDP: ein Paket (want wird ignoriert). USB: genau `want` Bytes. Ok(None) = Zeitüberschreitung
    fn recv(&mut self, want: usize, timeout: Duration) -> io::Result<Option<Vec<u8>>>;
    fn is_udp(&self) -> bool;
    fn purge(&mut self) {}
    fn describe(&self) -> String;
}

pub struct UdpLink {
    sock: UdpSocket,
    addr: SocketAddr,
}

impl UdpLink {
    pub fn open(host: &str) -> Result<UdpLink, String> {
        let addr = (host.trim(), UDP_PORT).to_socket_addrs().map_err(|e| e.to_string())?
            .next().ok_or_else(|| "bad address".to_string())?;
        let sock = UdpSocket::bind(("0.0.0.0", UDP_LISTEN)).map_err(|e| format!("udp {}: {}", UDP_LISTEN, e))?;
        Ok(UdpLink { sock, addr })
    }
}

impl Link for UdpLink {
    fn send(&mut self, data: &[u8]) -> io::Result<()> { self.sock.send_to(data, self.addr).map(|_| ()) }
    fn recv(&mut self, _want: usize, timeout: Duration) -> io::Result<Option<Vec<u8>>> {
        let deadline = Instant::now() + timeout;
        let mut buf = [0u8; 2048];
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() { return Ok(None); }
            self.sock.set_read_timeout(Some(left.max(Duration::from_millis(1))))?;
            match self.sock.recv_from(&mut buf) {
                Ok((n, from)) => {
                    if from.ip() != self.addr.ip() { continue; }
                    return Ok(Some(buf[..n].to_vec()));
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::TimedOut => return Ok(None),
                Err(e) => return Err(e),
            }
        }
    }
    fn is_udp(&self) -> bool { true }
    fn purge(&mut self) {
        let mut buf = [0u8; 2048];
        let _ = self.sock.set_read_timeout(Some(Duration::from_millis(20)));
        while self.sock.recv_from(&mut buf).is_ok() {}
    }
    fn describe(&self) -> String { self.addr.ip().to_string() }
}

/// Sitzung: verschlüsselt, Prüfsumme (UDP), wartet auf ACK, holt Antworten
pub struct Session {
    pub link: Box<dyn Link>,
    pub lut: Lut,
}

impl Session {
    pub fn new(link: Box<dyn Link>, magic: u8) -> Session { Session { link, lut: Lut::new(magic) } }

    pub fn set_magic(&mut self, magic: u8) { self.lut = Lut::new(magic); }

    pub fn packet(&self, data: &[u8]) -> Vec<u8> {
        let sw = self.lut.swizzle(data);
        if self.link.is_udp() {
            let sum: u32 = sw.iter().map(|&b| b as u32).sum();
            let mut p = vec![((sum >> 8) & 0xFF) as u8, (sum & 0xFF) as u8];
            p.extend_from_slice(&sw);
            p
        } else {
            sw
        }
    }

    /// Senden; bei UDP auf ACK warten (NAK = nochmal). want_reply: Antwortdaten zurückgeben
    pub fn transact(&mut self, data: &[u8], want_reply: bool) -> Result<Option<Vec<u8>>, String> {
        let pkt = self.packet(data);
        self.link.send(&pkt).map_err(|e| e.to_string())?;
        let step = Duration::from_millis(250);
        if !self.link.is_udp() {
            if !want_reply { return Ok(None); }
            return match self.link.recv(9, Duration::from_millis(1000)).map_err(|e| e.to_string())? {
                Some(d) => Ok(Some(self.lut.unswizzle(&d))),
                None => Err("timeout".into()),
            };
        }
        let mut reply: Option<Vec<u8>> = None;
        let mut tries = 4;
        let mut naks = 0;
        loop {
            match self.link.recv(1, step).map_err(|e| e.to_string())? {
                Some(d) => {
                    let u = self.lut.unswizzle(&d);
                    if u.len() == 1 {
                        match u[0] {
                            ACK => break,
                            NAK => {
                                naks += 1;
                                if naks > 5 { return Err("nak".into()); }
                                self.link.send(&pkt).map_err(|e| e.to_string())?;
                            }
                            _ => {}
                        }
                    } else if !u.is_empty() {
                        reply = Some(u); // Antwort vor dem ACK
                    }
                }
                None => {
                    tries -= 1;
                    if tries == 0 { return Err("timeout".into()); }
                }
            }
        }
        if want_reply && reply.is_none() {
            let mut tries = 4;
            while tries > 0 {
                match self.link.recv(9, step).map_err(|e| e.to_string())? {
                    Some(d) => {
                        let u = self.lut.unswizzle(&d);
                        if u.len() > 1 { reply = Some(u); break; }
                    }
                    None => tries -= 1,
                }
            }
            if reply.is_none() { return Err("timeout".into()); }
        }
        Ok(reply)
    }

    /// Speicherwert lesen (Status, Position, Bettgröße …)
    pub fn get_mem(&mut self, mem: [u8; 2]) -> Result<i64, String> {
        let r = self.transact(&[0xDA, 0x00, mem[0], mem[1]], true)?.ok_or_else(|| "no reply".to_string())?;
        if r.len() >= 9 && r[0] == 0xDA && r[1] == 0x01 && r[2] == mem[0] && r[3] == mem[1] {
            Ok(dec35(&r[4..9]))
        } else {
            Err("bad reply".into())
        }
    }

    /// Antwortet die Steuerung? Probiert bei Bedarf die bekannten Schlüssel durch.
    pub fn probe(&mut self, preferred: u8) -> Result<u8, String> {
        let mut order = vec![preferred];
        for m in MAGICS { if m != preferred { order.push(m); } }
        let mut last = String::from("no answer");
        for m in order {
            self.set_magic(m);
            self.link.purge();
            let res = if self.link.is_udp() {
                self.transact(&[ENQ], false).and_then(|_| self.get_mem(MEM_STATUS).map(|_| ()))
            } else {
                self.get_mem(MEM_STATUS).map(|_| ())
            };
            match res {
                Ok(()) => return Ok(m),
                Err(e) => last = e,
            }
        }
        Err(last)
    }
}

// ---------------------------------------------------------------------
// Handbefehle (aus den Knöpfen der Oberfläche, die GRBL-Zeilen schicken)
// ---------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum Manual {
    Nothing,
    Home,
    MoveTo { x: Option<f64>, y: Option<f64>, rel: bool, speed: Option<f64> },
}

/// GRBL-Zeile -> Ruida-Handbefehl. Err = gibt es bei Ruida nicht
pub fn manual_from_line(line: &str) -> Result<Manual, String> {
    let t = line.trim().to_ascii_uppercase();
    if t.is_empty() { return Ok(Manual::Nothing); }
    if t == "$H" { return Ok(Manual::Home); }
    if t == "$X" || t == "?" { return Ok(Manual::Nothing); }
    let body = if let Some(rest) = t.strip_prefix("$J=") { rest.to_string() } else if t.starts_with('$') { return Err("ruida-unsupported".into()); } else { t.clone() };
    let w = words(&body);
    if w.iter().any(|&(c, v)| c == 'G' && matches!((v * 10.0).round() as i32, 100 | 920 | 280 | 300 | 380 | 382 | 383 | 384 | 385)) {
        return Err("ruida-unsupported".into());
    }
    let mut rel = false;
    let mut inch = false;
    let (mut x, mut y, mut f) = (None, None, None);
    for &(c, v) in &w {
        match c {
            'G' => match (v * 10.0).round() as i32 { 910 => rel = true, 900 => rel = false, 200 => inch = true, 210 => inch = false, _ => {} },
            'X' => x = Some(v),
            'Y' => y = Some(v),
            'F' => f = Some(v),
            _ => {}
        }
    }
    let k = if inch { 25.4 } else { 1.0 };
    if x.is_none() && y.is_none() { return Ok(Manual::Nothing); }
    Ok(Manual::MoveTo { x: x.map(|v| v * k), y: y.map(|v| v * k), rel, speed: f.map(|v| v * k / 60.0) })
}

// ---------------------------------------------------------------------
// Laufende Verbindung (Hintergrund-Thread)
// ---------------------------------------------------------------------

enum Cmd {
    Line(u64, Manual),
    Job(Vec<(Vec<u8>, usize)>, usize),
    Pause,
    Resume,
    Stop,
    Shutdown,
}

struct JobState {
    packets: VecDeque<(Vec<u8>, usize)>,
    total: usize,
    sent_line: usize,
    upload_done: Option<Instant>,
    paused: bool,
    seen_running: bool,
    idle_reads: u32,
}

struct Shared {
    tx: Mutex<Sender<Cmd>>,
    alive: AtomicBool,
    next_id: AtomicU64,
    opt: Mutex<RdOptions>,
    busy: AtomicBool, // Job läuft
}

#[derive(Clone)]
pub struct Ruida {
    sh: Arc<Shared>,
}

impl Ruida {
    /// Verbindung herstellen (prüft vorher, ob die Steuerung antwortet)
    pub fn start(link: Box<dyn Link>, opt: RdOptions, emit: Emit) -> Result<Ruida, String> {
        let mut session = Session::new(link, opt.magic);
        let magic = session.probe(opt.magic).map_err(|e| format!("ruida: {}", e))?;
        let mut opt = opt;
        opt.magic = magic;
        let (tx, rx) = channel();
        let sh = Arc::new(Shared { tx: Mutex::new(tx), alive: AtomicBool::new(true), next_id: AtomicU64::new(1), opt: Mutex::new(opt.clone()), busy: AtomicBool::new(false) });
        let card = session.get_mem(MEM_CARD_ID).ok();
        let bed_x = session.get_mem(MEM_BED_X).ok();
        let bed_y = session.get_mem(MEM_BED_Y).ok();
        let desc = session.link.describe();
        emit("machine-welcome", format!(
            "{{\"firmware\":\"Ruida\",\"version\":{},\"raw\":{},\"magic\":{},\"bedX\":{},\"bedY\":{}}}",
            jstr(&card.map(|c| format!("{:08X}", c)).unwrap_or_default()),
            jstr(&format!("Ruida {} (0x{:02X})", desc, magic)),
            magic,
            bed_x.map(|v| format!("{}", v as f64 / 1000.0)).unwrap_or_else(|| "null".into()),
            bed_y.map(|v| format!("{}", v as f64 / 1000.0)).unwrap_or_else(|| "null".into())
        ));
        let r = Ruida { sh: sh.clone() };
        let worker = r.clone();
        thread::spawn(move || worker.run(session, rx, emit));
        Ok(r)
    }

    pub fn is_alive(&self) -> bool { self.sh.alive.load(Ordering::SeqCst) }

    pub fn shutdown(&self) {
        let _ = self.sh.tx.lock().unwrap().send(Cmd::Shutdown);
        self.sh.alive.store(false, Ordering::SeqCst);
    }

    fn post(&self, c: Cmd) -> Result<(), String> {
        if !self.is_alive() { return Err("not connected".into()); }
        self.sh.tx.lock().unwrap().send(c).map_err(|_| "not connected".to_string())
    }

    pub fn set_options(&self, o: RdOptions) {
        let mut cur = self.sh.opt.lock().unwrap();
        let magic = cur.magic;
        *cur = RdOptions { magic, ..o };
    }

    pub fn options(&self) -> RdOptions { self.sh.opt.lock().unwrap().clone() }

    /// GRBL-Zeile aus der Oberfläche. Rückgabe: Nummer (Antwort kommt als machine-line)
    pub fn send_line(&self, line: &str) -> Result<u64, String> {
        let m = manual_from_line(line)?;
        if self.sh.busy.load(Ordering::SeqCst) && m != Manual::Nothing { return Err("busy".into()); }
        let id = self.sh.next_id.fetch_add(1, Ordering::SeqCst);
        self.post(Cmd::Line(id, m))?;
        Ok(id)
    }

    pub fn realtime(&self, byte: u8) -> Result<(), String> {
        match byte {
            b'!' => self.post(Cmd::Pause),
            b'~' => self.post(Cmd::Resume),
            0x18 => self.post(Cmd::Stop),
            _ => Ok(()), // Overrides / Status gibt es so bei Ruida nicht
        }
    }

    pub fn start_job(&self, lines: Vec<String>) -> Result<usize, String> {
        if self.sh.busy.load(Ordering::SeqCst) { return Err("busy".into()); }
        let opt = self.options();
        let segs = parse_gcode(&lines, opt.s_max);
        let job = build_rd(&segs, &opt)?;
        if job.outside { return Err("outside".into()); }
        self.sh.busy.store(true, Ordering::SeqCst);
        self.post(Cmd::Job(job.packets(), lines.len()))?;
        Ok(lines.len())
    }

    pub fn pause_job(&self) -> Result<(), String> { self.post(Cmd::Pause) }
    pub fn resume_job(&self) -> Result<(), String> { self.post(Cmd::Resume) }
    pub fn stop_job(&self) -> Result<(), String> { self.post(Cmd::Stop) }

    // ------------------------------------------------------------------

    fn run(self, mut s: Session, rx: Receiver<Cmd>, emit: Emit) {
        let mut job: Option<JobState> = None;
        let (mut nx, mut ny, mut nz) = (0i64, 0i64, 0i64);
        let mut status: i64 = 0;
        let mut poll = 0usize;
        let mut fails = 0u32;
        let mut last_progress = Instant::now();
        let fail = |fails: &mut u32, e: &str, emit: &Emit| -> bool {
            *fails += 1;
            if *fails >= 12 {
                emit("machine-disconnected", format!("{{\"reason\":{}}}", jstr(&format!("ruida: {}", e))));
                return true;
            }
            false
        };
        let status_json = |opt: &RdOptions, nx: i64, ny: i64, nz: i64, st: &str| {
            let (x, y) = opt.to_user(nx, ny);
            let z = nz as f64 / 1000.0;
            let r = |v: f64| (v * 1000.0).round() / 1000.0;
            format!("{{\"state\":{},\"sub\":null,\"mpos\":[{},{},{}],\"wpos\":[{},{},{}],\"feed\":0,\"spindle\":0,\"ov\":[100,100,100],\"pins\":\"\"}}",
                jstr(st), r(x), r(y), r(z), r(x), r(y), r(z))
        };
        'outer: loop {
            if !self.is_alive() { break; }
            // ---- Befehle ----
            loop {
                let c = match rx.try_recv() { Ok(c) => c, Err(_) => break };
                match c {
                    Cmd::Shutdown => break 'outer,
                    Cmd::Pause => {
                        if s.transact(&[0xD8, 0x02], false).is_ok() {
                            if let Some(j) = job.as_mut() { j.paused = true; }
                        }
                    }
                    Cmd::Resume => {
                        if s.transact(&[0xD8, 0x03], false).is_ok() {
                            if let Some(j) = job.as_mut() { j.paused = false; j.idle_reads = 0; }
                        }
                    }
                    Cmd::Stop => {
                        let _ = s.transact(&[0xD8, 0x01], false);
                        if let Some(j) = job.take() {
                            emit("machine-job-done", format!("{{\"aborted\":true,\"reason\":\"stopped\",\"acked\":{},\"sent\":{},\"total\":{},\"errors\":0}}", j.sent_line, j.sent_line, j.total));
                        }
                        self.sh.busy.store(false, Ordering::SeqCst);
                    }
                    Cmd::Job(packets, total) => {
                        job = Some(JobState { packets: packets.into(), total, sent_line: 0, upload_done: None, paused: false, seen_running: false, idle_reads: 0 });
                    }
                    Cmd::Line(id, m) => {
                        let res: Result<(), String> = match m {
                            Manual::Nothing => Ok(()),
                            Manual::Home => s.transact(&[0xD8, 0x2A], false).map(|_| ()),
                            Manual::MoveTo { x, y, rel, speed } => {
                                let opt = self.options();
                                let (cx, cy) = opt.to_user(nx, ny);
                                let tx = match x { Some(v) => if rel { cx + v } else { v }, None => cx };
                                let ty = match y { Some(v) => if rel { cy + v } else { v }, None => cy };
                                let tx = tx.clamp(0.0, opt.bed_w);
                                let ty = ty.clamp(0.0, opt.bed_h);
                                let (gx, gy) = opt.to_native(tx, ty);
                                let sp = speed.unwrap_or(100.0).clamp(5.0, 400.0);
                                let r = s.transact(&cmd(&[&[0xC9, 0x02], &enc_speed(sp)]), false)
                                    .and_then(|_| s.transact(&cmd(&[&[0xD9, 0x10, 0x00], &enc35(gx), &enc35(gy)]), false).map(|_| ()));
                                // warten, bis die Fahrt fertig ist (damit Folgefahrten, z. B. Rahmen, nacheinander laufen)
                                if r.is_ok() {
                                    let t0 = Instant::now();
                                    let mut still = 0;
                                    while t0.elapsed() < Duration::from_secs(30) {
                                        thread::sleep(Duration::from_millis(80));
                                        let mut near = false;
                                        if let (Ok(a), Ok(b)) = (s.get_mem(MEM_X), s.get_mem(MEM_Y)) {
                                            nx = a; ny = b;
                                            emit("machine-status", status_json(&opt, nx, ny, nz, "Jog"));
                                            near = (nx - gx).abs() < 600 && (ny - gy).abs() < 600;
                                        }
                                        match s.get_mem(MEM_STATUS) {
                                            Ok(st) => { status = st; if st & ST_MOVING == 0 { still += 1; } else { still = 0; } }
                                            Err(_) => still += 1,
                                        }
                                        if near && still >= 1 { break; }
                                        if still >= 3 && t0.elapsed() > Duration::from_millis(400) { break; }
                                    }
                                }
                                r
                            }
                        };
                        match res {
                            Ok(()) => { fails = 0; emit("machine-line", format!("{{\"kind\":\"ok\",\"id\":{}}}", id)); }
                            Err(e) => {
                                emit("machine-line", format!("{{\"kind\":\"timeout\",\"id\":{}}}", id));
                                if fail(&mut fails, &e, &emit) { break 'outer; }
                            }
                        }
                    }
                }
            }

            // ---- Auftrag hochladen ----
            let mut uploading = false;
            if let Some(j) = job.as_mut() {
                if let Some((pkt, line)) = j.packets.front().cloned() {
                    uploading = true;
                    match s.transact(&pkt, false) {
                        Ok(_) => {
                            fails = 0;
                            j.packets.pop_front();
                            j.sent_line = line.min(j.total);
                            if j.packets.is_empty() { j.upload_done = Some(Instant::now()); }
                        }
                        Err(e) => {
                            if fail(&mut fails, &e, &emit) { break 'outer; }
                        }
                    }
                    if last_progress.elapsed() > Duration::from_millis(250) || j.packets.is_empty() {
                        last_progress = Instant::now();
                        emit("machine-job-progress", format!("{{\"sent\":{},\"acked\":{},\"total\":{},\"paused\":{},\"toolChange\":false,\"stopping\":false,\"buffer\":0}}",
                            j.sent_line, j.sent_line, j.total, j.paused));
                    }
                }
            }
            if uploading { continue; }

            // ---- Status abfragen ----
            let which = [MEM_STATUS, MEM_X, MEM_Y, MEM_STATUS, MEM_X, MEM_Y, MEM_Z][poll % 7];
            poll += 1;
            match s.get_mem(which) {
                Ok(v) => {
                    fails = 0;
                    if which == MEM_STATUS { status = v; }
                    else if which == MEM_X { nx = v; }
                    else if which == MEM_Y { ny = v; }
                    else { nz = v; }
                }
                Err(e) => {
                    if fail(&mut fails, &e, &emit) { break 'outer; }
                }
            }
            if which == MEM_Y {
                let running = status & (ST_MOVING | ST_JOB_RUNNING) != 0;
                let st = match job.as_ref() {
                    Some(j) if j.paused => "Hold",
                    _ if running => "Run",
                    _ => "Idle",
                };
                emit("machine-status", status_json(&self.options(), nx, ny, nz, st));
            }
            // ---- Auftrag fertig? ----
            if which == MEM_STATUS {
                let mut finished: Option<usize> = None;
                if let Some(j) = job.as_mut() {
                    if let Some(t0) = j.upload_done {
                        let running = status & (ST_MOVING | ST_JOB_RUNNING) != 0;
                        if running { j.seen_running = true; j.idle_reads = 0; }
                        else if !j.paused { j.idle_reads += 1; }
                        if !j.paused && j.idle_reads >= 3 && (j.seen_running || t0.elapsed() > Duration::from_secs(4)) {
                            finished = Some(j.total);
                        }
                    }
                }
                if let Some(total) = finished {
                    job = None;
                    self.sh.busy.store(false, Ordering::SeqCst);
                    emit("machine-job-done", format!("{{\"aborted\":false,\"reason\":\"done\",\"acked\":{},\"sent\":{},\"total\":{},\"errors\":0}}", total, total, total));
                }
            }
            thread::sleep(Duration::from_millis(60));
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
    fn swizzle_roundtrip() {
        for &m in &MAGICS {
            let l = Lut::new(m);
            for b in 0..=255u8 {
                assert_eq!(l.unswizzle(&l.swizzle(&[b]))[0], b);
            }
        }
        // 0 wird zu magic+1 (Grundlage der Schlüssel-Erkennung bei .rd-Dateien)
        assert_eq!(swizzle_byte(0, 0x88), 0x89);
    }

    #[test]
    fn numbers() {
        assert_eq!(enc35(0), [0, 0, 0, 0, 0]);
        assert_eq!(dec35(&enc35(123_456_789)), 123_456_789);
        assert_eq!(dec35(&enc35(-5000)), -5000);
        assert_eq!(enc14(-1), [0x7F, 0x7F]);
        assert_eq!(enc_power(100.0), enc14(16383));
        assert_eq!(enc_speed(10.0), enc35(10_000));
    }

    #[test]
    fn coords() {
        let o = RdOptions { bed_w: 600.0, bed_h: 400.0, ..Default::default() };
        assert_eq!(o.to_native(0.0, 0.0), (600_000, 400_000)); // unten links = weit weg vom Nullpunkt hinten rechts
        assert_eq!(o.to_native(600.0, 400.0), (0, 0));
        let (x, y) = o.to_user(100_000, 50_000);
        assert!((x - 500.0).abs() < 1e-9 && (y - 350.0).abs() < 1e-9);
        let bl = RdOptions { origin: Origin::BottomLeft, ..o.clone() };
        assert_eq!(bl.to_native(10.0, 20.0), (10_000, 20_000));
    }

    fn g(lines: &[&str]) -> Vec<String> { lines.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn gcode_parse() {
        let segs = parse_gcode(&g(&["G21 G90", "M4 S0", "G0 X10 Y10", "G1 X20 F600 S500", "G1 Y20 S0", "M5", "G0 X0 Y0"]), 1000.0);
        assert_eq!(segs.len(), 4);
        assert_eq!(segs[0].0, Seg::Move { x: 10.0, y: 10.0 });
        assert_eq!(segs[1].0, Seg::Cut { x: 20.0, y: 10.0, speed: 10.0, power: 50.0 });
        assert!(matches!(segs[2].0, Seg::Move { .. })); // S0 = aus
        // Bogen: voller Kreis
        let c = parse_gcode(&g(&["M3 S1000", "G0 X10 Y0", "G2 X10 Y0 I-10 J0 F1200"]), 1000.0);
        let n = c.len() - 1;
        assert!(n > 100);
        if let Seg::Cut { x, y, .. } = c[n / 2].0 { assert!((x + 10.0).abs() < 0.2 && y.abs() < 0.2, "{} {}", x, y); } else { panic!() }
        // Kommentare und relative Angaben
        let r = parse_gcode(&g(&["G91 (rel)", "G0 X5 ; hin", "G0 X5"]), 1000.0);
        assert_eq!(r[1].0, Seg::Move { x: 10.0, y: 0.0 });
    }

    #[test]
    fn rd_job() {
        let opt = RdOptions { bed_w: 600.0, bed_h: 400.0, ..Default::default() };
        let segs = parse_gcode(&g(&["M4", "G0 X10 Y10", "G1 X110 F1200 S300", "G1 Y110", "G1 X10 S800 F600", "G1 Y10"]), 1000.0);
        let job = build_rd(&segs, &opt).unwrap();
        assert_eq!(job.parts, 2);
        assert_eq!(job.cuts, 4);
        let b = job.bytes();
        assert_eq!(&b[..2], &[0xD8, 0x10]);
        assert_eq!(*b.last().unwrap(), 0xD7);
        // Prüfsumme vor EOF stimmt
        let sum_cmd = &job.commands[job.commands.len() - 2].0;
        assert_eq!(&sum_cmd[..2], &[0xE5, 0x05]);
        let before: u64 = job.commands[..job.commands.len() - 2].iter().map(|(v, _)| v.iter().map(|&x| x as u64).sum::<u64>()).sum();
        assert_eq!(dec35(&sum_cmd[2..7]) as u64, before + 0xD7);
        // erster Weg absolut (0x88) zu (590000, 390000)
        let first_move = job.commands.iter().find(|(c, _)| c[0] == 0x88).unwrap();
        assert_eq!(dec35(&first_move.0[1..6]), 590_000);
        assert_eq!(dec35(&first_move.0[6..11]), 390_000);
        // 100 mm Schnitt in X: zu lang für relativ (>8,191 mm) -> absolut 0xA8
        assert!(job.commands.iter().any(|(c, _)| c[0] == 0xA8));
        // alle Befehle beginnen mit Byte >= 0x80, Daten < 0x80
        for (c, _) in &job.commands {
            assert!(c[0] >= 0x80);
            for &d in &c[1..] { assert!(d < 0x80, "{:02X?}", c); }
        }
        // Pakete ≤ 1000 Bytes, zusammen = alles
        let p = job.packets();
        assert!(p.iter().all(|(d, _)| d.len() <= CHUNK));
        assert_eq!(p.iter().map(|(d, _)| d.len()).sum::<usize>(), b.len());
        // Datei = verschlüsselt
        assert_eq!(Lut::new(0x88).unswizzle(&job.file(0x88)), b);
    }

    #[test]
    fn outside_bed() {
        let opt = RdOptions { bed_w: 100.0, bed_h: 100.0, ..Default::default() };
        let segs = parse_gcode(&g(&["M3 S500", "G1 X150 Y10 F600"]), 1000.0);
        assert!(build_rd(&segs, &opt).unwrap().outside);
        assert!(build_rd(&parse_gcode(&g(&["G0 X10"]), 1000.0), &opt).is_err());
    }

    #[test]
    fn manual_lines() {
        assert_eq!(manual_from_line("$H").unwrap(), Manual::Home);
        assert_eq!(manual_from_line("$J=G21 G91 X10 F3000").unwrap(), Manual::MoveTo { x: Some(10.0), y: None, rel: true, speed: Some(50.0) });
        assert_eq!(manual_from_line("G21 G90 G0 X0 Y0").unwrap(), Manual::MoveTo { x: Some(0.0), y: Some(0.0), rel: false, speed: None });
        assert_eq!(manual_from_line("G21 G90 G0 Z5").unwrap(), Manual::Nothing);
        assert!(manual_from_line("$$").is_err());
        assert!(manual_from_line("G10 L20 P1 X0 Y0").is_err());
    }

    // ---------------- Schein-Steuerung für Verbindungstests ----------------

    struct FakeCtl {
        magic: u8,
        udp: bool,
        inbox: VecDeque<Vec<u8>>,
        pub received: Arc<Mutex<Vec<Vec<u8>>>>,
        drop_next_ack: bool,
        status: i64,
    }

    impl Link for FakeCtl {
        fn send(&mut self, data: &[u8]) -> io::Result<()> {
            let l = Lut::new(self.magic);
            let body = if self.udp {
                let sum: u32 = data[2..].iter().map(|&b| b as u32).sum();
                if ((sum >> 8) & 0xFF) as u8 != data[0] || (sum & 0xFF) as u8 != data[1] {
                    self.inbox.push_back(l.swizzle(&[NAK]));
                    return Ok(());
                }
                l.unswizzle(&data[2..])
            } else {
                l.unswizzle(data)
            };
            self.received.lock().unwrap().push(body.clone());
            if self.udp {
                if self.drop_next_ack { self.drop_next_ack = false; self.inbox.push_back(l.swizzle(&[NAK])); return Ok(()); }
                self.inbox.push_back(l.swizzle(&[ACK]));
            }
            if body.len() >= 4 && body[0] == 0xDA && body[1] == 0x00 {
                let v = match [body[2], body[3]] {
                    MEM_STATUS => self.status,
                    MEM_X => 100_000,
                    MEM_Y => 50_000,
                    MEM_CARD_ID => 0x6510_6510,
                    _ => 0,
                };
                let mut r = vec![0xDA, 0x01, body[2], body[3]];
                r.extend_from_slice(&enc35(v));
                r.extend_from_slice(&enc35(v));
                self.inbox.push_back(l.swizzle(&r));
            }
            Ok(())
        }
        fn recv(&mut self, want: usize, _t: Duration) -> io::Result<Option<Vec<u8>>> {
            match self.inbox.pop_front() {
                Some(mut d) => { if !self.udp && d.len() > want { d.truncate(want); } Ok(Some(d)) }
                None => Ok(None),
            }
        }
        fn is_udp(&self) -> bool { self.udp }
        fn describe(&self) -> String { "fake".into() }
    }

    fn fake(magic: u8, udp: bool) -> (FakeCtl, Arc<Mutex<Vec<Vec<u8>>>>) {
        let rec = Arc::new(Mutex::new(Vec::new()));
        (FakeCtl { magic, udp, inbox: VecDeque::new(), received: rec.clone(), drop_next_ack: false, status: 0 }, rec)
    }

    #[test]
    fn session_udp_and_magic_detection() {
        let (f, rec) = fake(0x11, true);
        let mut s = Session::new(Box::new(f), 0x88);
        assert_eq!(s.probe(0x88).unwrap(), 0x11);
        assert_eq!(s.get_mem(MEM_X).unwrap(), 100_000);
        assert!(rec.lock().unwrap().iter().any(|b| b == &vec![ENQ]));
    }

    #[test]
    fn session_resends_on_nak() {
        let (mut f, rec) = fake(0x88, true);
        f.drop_next_ack = true;
        let mut s = Session::new(Box::new(f), 0x88);
        s.transact(&[0xD8, 0x00], false).unwrap();
        assert_eq!(rec.lock().unwrap().len(), 2);
    }

    #[test]
    fn session_usb() {
        let (f, _) = fake(0x88, false);
        let mut s = Session::new(Box::new(f), 0x88);
        assert_eq!(s.probe(0x88).unwrap(), 0x88);
        assert_eq!(s.get_mem(MEM_Y).unwrap(), 50_000);
    }

    #[test]
    fn worker_runs_job() {
        let (f, rec) = fake(0x88, true);
        let events: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let ev = events.clone();
        let emit: Emit = Arc::new(move |n: &str, j: String| ev.lock().unwrap().push((n.to_string(), j)));
        let r = Ruida::start(Box::new(f), RdOptions::default(), emit).unwrap();
        let n = r.start_job(g(&["M4", "G0 X10 Y10", "G1 X50 F1200 S500", "G1 Y50"])).unwrap();
        assert_eq!(n, 4);
        let until = Instant::now() + Duration::from_secs(8);
        while Instant::now() < until && !events.lock().unwrap().iter().any(|(n, _)| n == "machine-job-done") {
            thread::sleep(Duration::from_millis(50));
        }
        let evs = events.lock().unwrap().clone();
        assert!(evs.iter().any(|(n, j)| n == "machine-welcome" && j.contains("65106510")));
        assert!(evs.iter().any(|(n, _)| n == "machine-status"));
        assert!(evs.iter().any(|(n, j)| n == "machine-job-done" && j.contains("\"aborted\":false")), "{:?}", evs);
        // der hochgeladene Auftrag endet mit EOF
        let all: Vec<u8> = rec.lock().unwrap().iter().filter(|b| b.len() > 12).flat_map(|b| b.clone()).collect();
        assert_eq!(*all.last().unwrap(), 0xD7);
        // Handfahrt
        let id = r.send_line("$J=G91 X10 F3000").unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until && !events.lock().unwrap().iter().any(|(n, j)| n == "machine-line" && j.contains(&format!("\"id\":{}", id))) {
            thread::sleep(Duration::from_millis(30));
        }
        assert!(rec.lock().unwrap().iter().any(|b| b.len() == 13 && b[0] == 0xD9 && b[1] == 0x10));
        r.shutdown();
    }
}
