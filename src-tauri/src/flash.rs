//! FIRMWARE FLASHEN – ohne Zusatzprogramm (kein esptool, kein avrdude nötig)
//!
//! ESP32 / ESP32-S2 / ESP32-S3 / ESP32-C3 (MKS DLC32, DLC32 MAX, viele Laser):
//!   Bootloader im ROM des Chips ("serial protocol" von Espressif): SLIP-Pakete,
//!   Daten komprimiert (zlib) -> 8 MB in wenigen Minuten statt 12+ Minuten.
//!   Ablauf: Reset in den Bootloader (DTR/RTS) -> SYNC -> Chip erkennen -> schneller Takt
//!   -> SPI anmelden -> komprimiert schreiben -> MD5 prüfen -> Neustart
//!
//! Arduino Uno / Nano / Mega328 (China-3018 & Co. mit GRBL 1.1):
//!   STK500v1 (Optiboot 115200 Baud bzw. alter Bootloader 57600 Baud), Intel-HEX-Datei,
//!   Seite für Seite schreiben und zurücklesen.
//!
//! Alles ist hier ohne Hardware testbar (siehe Tests ganz unten: simulierte Boards).

use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

/// Was der Flasher vom Port braucht (echter Port: serial.rs, Tests: simuliert)
pub trait FlashPort: Read + Write + Send {
    fn set_dtr(&mut self, on: bool);
    fn set_rts(&mut self, on: bool);
    fn set_baud(&mut self, baud: u32) -> Result<(), String>;
    fn clear_input(&mut self);
}

/// Fortschritt/Meldungen an die Oberfläche: (Ereignisname, JSON)
pub type Progress<'a> = &'a dyn Fn(&str, String);

fn sleep_ms(ms: u64) { thread::sleep(Duration::from_millis(ms)); }

fn jstr(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            c if (c as u32) < 0x20 => o.push(' '),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn report(p: Progress, stage: &str, done: usize, total: usize, msg: &str) {
    p("flash-progress", format!("{{\"stage\":{},\"done\":{},\"total\":{},\"msg\":{}}}", jstr(stage), done, total, jstr(msg)));
}

/// Ein Byte lesen, bis zur Frist
fn read_byte(port: &mut dyn FlashPort, deadline: Instant) -> Option<u8> {
    let mut b = [0u8; 1];
    while Instant::now() < deadline {
        match port.read(&mut b) {
            Ok(1) => return Some(b[0]),
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::Interrupted => {}
            Err(_) => return None,
        }
    }
    None
}

// =====================================================================
// ZLIB-KOMPRESSION (Deflate mit festen Huffman-Codes + LZ77)
// Der ROM-Bootloader der ESP32 entpackt das selbst.
// =====================================================================

struct BitWriter { out: Vec<u8>, acc: u64, n: u32 }
impl BitWriter {
    fn new() -> Self { BitWriter { out: Vec::new(), acc: 0, n: 0 } }
    /// Bits LSB-zuerst anhängen
    fn put(&mut self, value: u32, bits: u32) {
        self.acc |= (value as u64) << self.n;
        self.n += bits;
        while self.n >= 8 { self.out.push(self.acc as u8); self.acc >>= 8; self.n -= 8; }
    }
    /// Huffman-Code (MSB-zuerst definiert) -> umgedreht schreiben
    fn put_code(&mut self, code: u32, bits: u32) {
        let mut r = 0u32;
        for i in 0..bits { if code & (1 << i) != 0 { r |= 1 << (bits - 1 - i); } }
        self.put(r, bits);
    }
    fn finish(mut self) -> Vec<u8> { if self.n > 0 { self.out.push(self.acc as u8); } self.out }
}

fn put_literal(w: &mut BitWriter, v: u32) {
    match v {
        0..=143 => w.put_code(0x30 + v, 8),
        144..=255 => w.put_code(0x190 + (v - 144), 9),
        256..=279 => w.put_code(v - 256, 7),
        _ => w.put_code(0xC0 + (v - 280), 8),
    }
}

const LEN_BASE: [u16; 29] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA: [u8; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE: [u16; 30] = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA: [u8; 30] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

fn put_match(w: &mut BitWriter, len: usize, dist: usize) {
    let mut li = 28;
    while LEN_BASE[li] as usize > len { li -= 1; }
    put_literal(w, 257 + li as u32);
    if LEN_EXTRA[li] > 0 { w.put((len - LEN_BASE[li] as usize) as u32, LEN_EXTRA[li] as u32); }
    let mut di = 29;
    while DIST_BASE[di] as usize > dist { di -= 1; }
    w.put_code(di as u32, 5);
    if DIST_EXTRA[di] > 0 { w.put((dist - DIST_BASE[di] as usize) as u32, DIST_EXTRA[di] as u32); }
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for chunk in data.chunks(5552) {
        for &x in chunk { a += x as u32; b += a; }
        a %= 65521; b %= 65521;
    }
    (b << 16) | a
}

/// zlib-Datenstrom (RFC 1950/1951), ein Block mit festen Codes
pub fn zlib_compress(data: &[u8]) -> Vec<u8> {
    const WINDOW: usize = 32768;
    const HBITS: usize = 15;
    const MAX_CHAIN: usize = 24;
    let mut w = BitWriter::new();
    w.put(1, 1); // letzter Block
    w.put(1, 2); // feste Huffman-Codes
    let n = data.len();
    let mut head = vec![usize::MAX; 1 << HBITS];
    let mut prev = vec![usize::MAX; WINDOW];
    let hash = |i: usize| -> usize {
        let v = (data[i] as u32) << 16 | (data[i + 1] as u32) << 8 | data[i + 2] as u32;
        (v.wrapping_mul(2654435761) >> (32 - HBITS)) as usize
    };
    let insert = |i: usize, head: &mut Vec<usize>, prev: &mut Vec<usize>| {
        if i + 2 < n { let h = hash(i); prev[i % WINDOW] = head[h]; head[h] = i; }
    };
    let mut i = 0;
    while i < n {
        let mut best_len = 0;
        let mut best_dist = 0;
        if i + 2 < n {
            let h = hash(i);
            let mut cand = head[h];
            let mut chain = 0;
            while cand != usize::MAX && chain < MAX_CHAIN && i - cand <= WINDOW && cand < i {
                let max = (n - i).min(258);
                let mut l = 0;
                while l < max && data[cand + l] == data[i + l] { l += 1; }
                if l > best_len { best_len = l; best_dist = i - cand; if l == max { break; } }
                let nxt = prev[cand % WINDOW];
                if nxt == usize::MAX || nxt >= cand { break; }
                cand = nxt;
                chain += 1;
            }
        }
        if best_len >= 3 {
            put_match(&mut w, best_len, best_dist);
            for k in 0..best_len { insert(i + k, &mut head, &mut prev); }
            i += best_len;
        } else {
            put_literal(&mut w, data[i] as u32);
            insert(i, &mut head, &mut prev);
            i += 1;
        }
    }
    put_literal(&mut w, 256); // Blockende
    let mut out = vec![0x78, 0x01];
    out.extend(w.finish());
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

// =====================================================================
// MD5 (zum Prüfen, ob richtig geschrieben wurde)
// =====================================================================

pub fn md5_hex(data: &[u8]) -> String {
    const S: [u32; 64] = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    let k: Vec<u32> = (0..64).map(|i| ((i as f64 + 1.0).sin().abs() * 4294967296.0) as u32).collect();
    let (mut a0, mut b0, mut c0, mut d0) = (0x67452301u32, 0xefcdab89u32, 0x98badcfeu32, 0x10325476u32);
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 { msg.push(0); }
    msg.extend_from_slice(&bit_len.to_le_bytes());
    for chunk in msg.chunks(64) {
        let m: Vec<u32> = (0..16).map(|i| u32::from_le_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]])).collect();
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | (!b & d), i),
                16..=31 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let f2 = f.wrapping_add(a).wrapping_add(k[i]).wrapping_add(m[g]);
            a = d; d = c; c = b;
            b = b.wrapping_add(f2.rotate_left(S[i]));
        }
        a0 = a0.wrapping_add(a); b0 = b0.wrapping_add(b); c0 = c0.wrapping_add(c); d0 = d0.wrapping_add(d);
    }
    let mut out = String::new();
    for v in [a0, b0, c0, d0] { for byte in v.to_le_bytes() { out.push_str(&format!("{:02x}", byte)); } }
    out
}

// =====================================================================
// ESP32-BOOTLOADER (ROM)
// =====================================================================

const ESP_SYNC: u8 = 0x08;
const ESP_READ_REG: u8 = 0x0a;
const ESP_SPI_SET_PARAMS: u8 = 0x0b;
const ESP_SPI_ATTACH: u8 = 0x0d;
const ESP_CHANGE_BAUD: u8 = 0x0f;
const ESP_DEFL_BEGIN: u8 = 0x10;
const ESP_DEFL_DATA: u8 = 0x11;
const ESP_DEFL_END: u8 = 0x12;
const ESP_MD5: u8 = 0x13;
const ROM_BLOCK: usize = 0x400;
const CHIP_MAGIC_REG: u32 = 0x4000_1000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Chip { Esp32, Esp32S2, Esp32S3, Esp32C3, Unknown(u32) }

impl Chip {
    pub fn name(&self) -> String {
        match self {
            Chip::Esp32 => "ESP32".into(),
            Chip::Esp32S2 => "ESP32-S2".into(),
            Chip::Esp32S3 => "ESP32-S3".into(),
            Chip::Esp32C3 => "ESP32-C3".into(),
            Chip::Unknown(m) => format!("ESP (0x{:08x})", m),
        }
    }
    fn from_magic(m: u32) -> Chip {
        match m {
            0x00f0_1d83 => Chip::Esp32,
            0x0000_07c6 => Chip::Esp32S2,
            0x0000_0009 => Chip::Esp32S3,
            0x6921_506f | 0x1b31_506f | 0x4881_606f | 0x4361_606f => Chip::Esp32C3,
            x => Chip::Unknown(x),
        }
    }
    /// Kennung im Kopf der Firmware-Datei
    fn image_id(&self) -> Option<u16> {
        match self { Chip::Esp32 => Some(0), Chip::Esp32S2 => Some(2), Chip::Esp32S3 => Some(9), Chip::Esp32C3 => Some(5), Chip::Unknown(_) => None }
    }
    /// Ab ESP32-S2 hat FLASH_BEGIN ein fünftes Wort (Verschlüsselung)
    fn begin_has_encrypt_word(&self) -> bool { !matches!(self, Chip::Esp32) }
}

pub fn chip_name_from_image_id(id: u16) -> &'static str {
    match id { 0 => "ESP32", 2 => "ESP32-S2", 9 => "ESP32-S3", 5 => "ESP32-C3", 0xc => "ESP32-C2", 0xd => "ESP32-C6", 0x10 => "ESP32-H2", _ => "?" }
}

fn slip_send(port: &mut dyn FlashPort, payload: &[u8]) -> Result<(), String> {
    let mut out = Vec::with_capacity(payload.len() + 16);
    out.push(0xC0);
    for &b in payload {
        match b { 0xC0 => out.extend_from_slice(&[0xDB, 0xDC]), 0xDB => out.extend_from_slice(&[0xDB, 0xDD]), x => out.push(x) }
    }
    out.push(0xC0);
    port.write_all(&out).map_err(|e| e.to_string())?;
    port.flush().map_err(|e| e.to_string())
}

fn slip_recv(port: &mut dyn FlashPort, deadline: Instant) -> Option<Vec<u8>> {
    // bis zum Rahmenanfang
    loop {
        if read_byte(port, deadline)? == 0xC0 { break; }
    }
    let mut frame = Vec::new();
    loop {
        match read_byte(port, deadline)? {
            0xC0 => { if frame.is_empty() { continue; } return Some(frame); }
            0xDB => match read_byte(port, deadline)? { 0xDC => frame.push(0xC0), 0xDD => frame.push(0xDB), x => frame.push(x) },
            x => frame.push(x),
        }
    }
}

struct Esp<'a> { port: &'a mut dyn FlashPort }

impl<'a> Esp<'a> {
    fn command(&mut self, op: u8, data: &[u8], checksum: u32, timeout: Duration) -> Result<(u32, Vec<u8>), String> {
        let mut pkt = Vec::with_capacity(8 + data.len());
        pkt.push(0x00);
        pkt.push(op);
        pkt.extend_from_slice(&(data.len() as u16).to_le_bytes());
        pkt.extend_from_slice(&checksum.to_le_bytes());
        pkt.extend_from_slice(data);
        slip_send(self.port, &pkt)?;
        let deadline = Instant::now() + timeout;
        loop {
            let frame = slip_recv(self.port, deadline).ok_or_else(|| format!("timeout (cmd 0x{:02x})", op))?;
            if frame.len() < 8 || frame[0] != 0x01 || frame[1] != op { continue; }
            let value = u32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]);
            let body = &frame[8..];
            // ROM der ESP32-Familie: 4 Statusbytes am Ende (Status, Fehler, 2× reserviert)
            let st = if body.len() >= 4 { 4 } else { body.len().min(2) };
            if st >= 2 {
                let status = body[body.len() - st];
                let err = body[body.len() - st + 1];
                if status != 0 { return Err(format!("bootloader error 0x{:02x} (cmd 0x{:02x})", err, op)); }
            }
            return Ok((value, body[..body.len() - st].to_vec()));
        }
    }

    fn sync(&mut self) -> bool {
        let mut data = vec![0x07, 0x07, 0x12, 0x20];
        data.extend(std::iter::repeat(0x55).take(32));
        for _ in 0..5 {
            if self.command(ESP_SYNC, &data, 0, Duration::from_millis(120)).is_ok() {
                // der ROM antwortet mehrfach – Rest abwarten und verwerfen
                sleep_ms(60);
                self.port.clear_input();
                return true;
            }
        }
        false
    }

    fn read_reg(&mut self, addr: u32) -> Result<u32, String> {
        Ok(self.command(ESP_READ_REG, &addr.to_le_bytes(), 0, Duration::from_secs(1))?.0)
    }
}

fn words(ws: &[u32]) -> Vec<u8> {
    ws.iter().flat_map(|w| w.to_le_bytes()).collect()
}

/// Reset-Arten, um den Chip in den Bootloader zu bringen
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ResetKind { Classic, UsbJtag, None }

fn reset_into_bootloader(port: &mut dyn FlashPort, kind: ResetKind) {
    match kind {
        // USB-Seriell-Wandler (CH340, CP210x …) mit Auto-Reset-Schaltung: RTS -> EN, DTR -> IO0
        ResetKind::Classic => {
            port.set_dtr(false);
            port.set_rts(true);  // EN low = Reset
            sleep_ms(100);
            port.set_dtr(true);  // IO0 low = Bootloader
            port.set_rts(false); // EN high = Start
            sleep_ms(60);
            port.set_dtr(false);
        }
        // Eingebautes USB des ESP32-S3/C3 ("USB JTAG/serial")
        ResetKind::UsbJtag => {
            port.set_rts(false); port.set_dtr(false);
            sleep_ms(100);
            port.set_dtr(true); port.set_rts(false);
            sleep_ms(100);
            port.set_rts(true); port.set_dtr(false); port.set_rts(true);
            sleep_ms(100);
            port.set_rts(false); port.set_dtr(false);
        }
        ResetKind::None => {}
    }
    sleep_ms(50);
    port.clear_input();
}

fn hard_reset(port: &mut dyn FlashPort) {
    port.set_dtr(false);
    port.set_rts(true);
    sleep_ms(150);
    port.set_rts(false);
}

pub struct EspOptions {
    pub offset: u32,
    pub baud: u32,          // Ziel-Baudrate fürs Schreiben (z. B. 921600)
    pub usb_jtag: bool,     // eingebautes USB (ESP32-S3) -> andere Reset-Folge, Baudrate egal
    pub flash_size: u32,    // Bytes (aus dem Datei-Kopf, sonst 4 MB)
}

/// ESP32 flashen (eine Datei an opt.offset). Gibt eine Zusammenfassung zurück.
pub fn flash_esp(port: &mut dyn FlashPort, image: &[u8], opt: &EspOptions, p: Progress, cancel: &AtomicBool) -> Result<String, String> {
    flash_esp_parts(port, &[(opt.offset, image)], opt, p, cancel)
}

/// ESP32 flashen: mehrere Teile (Adresse, Inhalt) in EINER Sitzung – z. B. Bootloader, Partitionstabelle
/// und Firmware aus einer ZIP vom grblHAL Web Builder (fwzip.rs). opt.offset wird hier nicht benutzt.
pub fn flash_esp_parts(port: &mut dyn FlashPort, parts: &[(u32, &[u8])], opt: &EspOptions, p: Progress, cancel: &AtomicBool) -> Result<String, String> {
    if parts.is_empty() || parts.iter().any(|(_, d)| d.is_empty()) { return Err("empty file".into()); }
    let total: usize = parts.iter().map(|(_, d)| d.len()).sum();
    report(p, "connect", 0, 1, "");

    // ---- 1. Bootloader erreichen ----
    let order = if opt.usb_jtag { [ResetKind::UsbJtag, ResetKind::Classic, ResetKind::None] } else { [ResetKind::Classic, ResetKind::UsbJtag, ResetKind::None] };
    let mut synced = false;
    'outer: for _round in 0..2 {
        for kind in order {
            if cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
            reset_into_bootloader(port, kind);
            let mut esp = Esp { port: &mut *port };
            if esp.sync() { synced = true; break 'outer; }
        }
    }
    if !synced { return Err("no bootloader".into()); }

    let mut esp = Esp { port: &mut *port };
    let chip = Chip::from_magic(esp.read_reg(CHIP_MAGIC_REG)?);
    report(p, "chip", 0, 1, &chip.name());

    // ---- 2. Passen die Dateien zum Chip? (vor dem ersten Schreiben – nichts wird halb geflasht) ----
    for (_, image) in parts {
        if let Some(img_id) = image_chip_id(image) {
            if let Some(cid) = chip.image_id() {
                if img_id != cid {
                    return Err(format!("wrong chip: file is for {}, board has {}", chip_name_from_image_id(img_id), chip.name()));
                }
            }
        }
    }

    // ---- 3. schneller Takt (nur bei USB-Seriell-Wandlern sinnvoll) ----
    if !opt.usb_jtag && opt.baud > 115_200 {
        esp.command(ESP_CHANGE_BAUD, &words(&[opt.baud, 0]), 0, Duration::from_secs(1))?;
        esp.port.set_baud(opt.baud)?;
        sleep_ms(60);
        esp.port.clear_input();
        if esp.read_reg(CHIP_MAGIC_REG).is_err() {
            return Err(format!("baud {} not working – try a lower speed", opt.baud));
        }
    }

    // ---- 4. SPI-Flash anmelden ----
    esp.command(ESP_SPI_ATTACH, &words(&[0, 0]), 0, Duration::from_secs(3))?;
    esp.command(ESP_SPI_SET_PARAMS, &words(&[0, opt.flash_size, 64 * 1024, 4 * 1024, 256, 0xffff]), 0, Duration::from_secs(3))?;

    // ---- 5./6. jeden Teil komprimiert schreiben und prüfen ----
    let t0 = Instant::now();
    let mut done_before = 0usize;
    let mut comp_total = 0usize;
    let mut md5s = Vec::new();
    for (offset, image) in parts {
        let (offset, image) = (*offset, *image);
        report(p, "compress", 0, 1, "");
        let comp = zlib_compress(image);
        comp_total += comp.len();
        let blocks = (comp.len() + ROM_BLOCK - 1) / ROM_BLOCK;
        let write_size = ((image.len() + ROM_BLOCK - 1) / ROM_BLOCK * ROM_BLOCK) as u32;
        let mb = (write_size as f64 / 1_048_576.0).max(1.0);
        report(p, "erase", done_before, total, "");
        let mut begin = vec![write_size, blocks as u32, ROM_BLOCK as u32, offset];
        if chip.begin_has_encrypt_word() { begin.push(0); }
        esp.command(ESP_DEFL_BEGIN, &words(&begin), 0, Duration::from_secs_f64(10.0 + 30.0 * mb))?;

        let mut last = Instant::now() - Duration::from_secs(1);
        for (seq, chunk) in comp.chunks(ROM_BLOCK).enumerate() {
            if cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
            let mut data = words(&[chunk.len() as u32, seq as u32, 0, 0]);
            data.extend_from_slice(chunk);
            let checksum = chunk.iter().fold(0xEFu8, |a, &b| a ^ b) as u32;
            // der ROM entpackt und schreibt – bei großen leeren Bereichen kann das dauern
            esp.command(ESP_DEFL_DATA, &data, checksum, Duration::from_secs(20))?;
            if last.elapsed() > Duration::from_millis(150) || seq + 1 == blocks {
                last = Instant::now();
                let done = done_before + ((seq + 1) as f64 / blocks as f64 * image.len() as f64) as usize;
                report(p, "write", done, total, "");
            }
        }

        // prüfen
        report(p, "verify", 0, 1, "");
        let (_, md5_raw) = esp.command(ESP_MD5, &words(&[offset, image.len() as u32, 0, 0]), 0, Duration::from_secs_f64(10.0 + 8.0 * mb))?;
        let got = if md5_raw.len() >= 32 { String::from_utf8_lossy(&md5_raw[..32]).to_lowercase() }
                  else { md5_raw.iter().map(|b| format!("{:02x}", b)).collect() };
        let want = md5_hex(image);
        if got != want { return Err(format!("verify failed at 0x{:x} (md5 {} != {})", offset, got, want)); }
        md5s.push(want);
        done_before += image.len();
    }
    let secs = t0.elapsed().as_secs_f64();

    // ---- 7. fertig, Neustart ----
    let _ = esp.command(ESP_DEFL_END, &words(&[1]), 0, Duration::from_secs(2));
    esp.port.set_baud(115_200).ok();
    hard_reset(esp.port);
    report(p, "done", total, total, "");
    Ok(format!("{{\"chip\":{},\"bytes\":{},\"compressed\":{},\"seconds\":{:.1},\"parts\":{},\"md5\":{}}}",
        jstr(&chip.name()), total, comp_total, secs, parts.len(), jstr(&md5s.join(","))))
}

/// Chip-Kennung aus dem Kopf einer ESP-Firmware-Datei (App bei 0, Komplettdatei mit Bootloader bei 0 bzw. 0x1000)
pub fn image_chip_id(image: &[u8]) -> Option<u16> {
    for off in [0usize, 0x1000] {
        if image.len() > off + 16 && image[off] == 0xE9 {
            return Some(u16::from_le_bytes([image[off + 12], image[off + 13]]));
        }
    }
    None
}

// =====================================================================
// ARDUINO (STK500v1)
// =====================================================================

const STK_OK: u8 = 0x10;
const STK_INSYNC: u8 = 0x14;
const CRC_EOP: u8 = 0x20;
const STK_GET_SYNC: u8 = 0x30;
const STK_ENTER: u8 = 0x50;
const STK_LEAVE: u8 = 0x51;
const STK_LOAD_ADDR: u8 = 0x55;
const STK_PROG_PAGE: u8 = 0x64;
const STK_READ_PAGE: u8 = 0x74;
const STK_READ_SIGN: u8 = 0x75;

/// Intel-HEX -> Speicherabbild ab Adresse 0
pub fn parse_ihex(text: &str) -> Result<Vec<u8>, String> {
    let mut mem: Vec<u8> = Vec::new();
    let mut base: u32 = 0;
    let mut eof = false;
    for (ln, raw) in text.lines().enumerate() {
        let l = raw.trim();
        if l.is_empty() { continue; }
        if !l.starts_with(':') { return Err(format!("line {}: no ':'", ln + 1)); }
        let hex = &l[1..];
        if hex.len() % 2 != 0 { return Err(format!("line {}: odd length", ln + 1)); }
        let bytes: Result<Vec<u8>, _> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16)).collect();
        let b = bytes.map_err(|_| format!("line {}: not hex", ln + 1))?;
        if b.len() < 5 { return Err(format!("line {}: too short", ln + 1)); }
        let count = b[0] as usize;
        if b.len() != count + 5 { return Err(format!("line {}: wrong length", ln + 1)); }
        let sum = b.iter().fold(0u8, |a, &x| a.wrapping_add(x));
        if sum != 0 { return Err(format!("line {}: checksum", ln + 1)); }
        let addr = ((b[1] as u32) << 8) | b[2] as u32;
        match b[3] {
            0x00 => {
                let start = (base + addr) as usize;
                if start + count > 1 << 20 { return Err("address too high".into()); }
                if mem.len() < start + count { mem.resize(start + count, 0xFF); }
                mem[start..start + count].copy_from_slice(&b[4..4 + count]);
            }
            0x01 => { eof = true; break; }
            0x02 => base = (((b[4] as u32) << 8) | b[5] as u32) << 4,
            0x04 => base = (((b[4] as u32) << 8) | b[5] as u32) << 16,
            0x03 | 0x05 => {}
            t => return Err(format!("line {}: record type {}", ln + 1, t)),
        }
    }
    if !eof { return Err("no end record".into()); }
    if mem.is_empty() { return Err("no data".into()); }
    Ok(mem)
}

fn avr_cmd(port: &mut dyn FlashPort, cmd: &[u8], answer_len: usize, timeout: Duration) -> Result<Vec<u8>, String> {
    port.write_all(cmd).map_err(|e| e.to_string())?;
    port.flush().map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    let first = read_byte(port, deadline).ok_or("timeout")?;
    if first != STK_INSYNC { return Err(format!("not in sync (0x{:02x})", first)); }
    let mut out = Vec::with_capacity(answer_len);
    for _ in 0..answer_len { out.push(read_byte(port, deadline).ok_or("timeout")?); }
    let ok = read_byte(port, deadline).ok_or("timeout")?;
    if ok != STK_OK { return Err(format!("no OK (0x{:02x})", ok)); }
    Ok(out)
}

fn avr_reset(port: &mut dyn FlashPort) {
    // wie avrdude "arduino": DTR/RTS aus, kurz warten, wieder an -> Reset über Kondensator
    port.set_dtr(false);
    port.set_rts(false);
    sleep_ms(250);
    port.set_dtr(true);
    port.set_rts(true);
    sleep_ms(60);
    port.clear_input();
}

fn avr_sync(port: &mut dyn FlashPort) -> bool {
    for _ in 0..8 {
        if avr_cmd(port, &[STK_GET_SYNC, CRC_EOP], 0, Duration::from_millis(200)).is_ok() {
            sleep_ms(20);
            port.clear_input();
            // noch einmal sauber
            return avr_cmd(port, &[STK_GET_SYNC, CRC_EOP], 0, Duration::from_millis(300)).is_ok();
        }
    }
    false
}

/// (Signatur, Name, Seitengröße, nutzbarer Flash ohne Bootloader)
fn avr_part(sig: [u8; 3]) -> Option<(&'static str, usize, usize)> {
    match sig {
        [0x1E, 0x95, 0x0F] => Some(("ATmega328P", 128, 32 * 1024 - 512)),
        [0x1E, 0x95, 0x14] => Some(("ATmega328", 128, 32 * 1024 - 512)),
        [0x1E, 0x95, 0x16] => Some(("ATmega328PB", 128, 32 * 1024 - 512)),
        [0x1E, 0x94, 0x06] => Some(("ATmega168", 128, 16 * 1024 - 512)),
        [0x1E, 0x94, 0x0B] => Some(("ATmega168P", 128, 16 * 1024 - 512)),
        _ => None,
    }
}

/// Arduino flashen (GRBL-.hex). Gibt eine Zusammenfassung zurück.
pub fn flash_avr(port: &mut dyn FlashPort, hex_text: &str, p: Progress, cancel: &AtomicBool) -> Result<String, String> {
    let image = parse_ihex(hex_text)?;
    report(p, "connect", 0, 1, "");
    let mut baud_used = 0;
    for baud in [115_200u32, 57_600] {
        if cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
        port.set_baud(baud)?;
        avr_reset(port);
        if avr_sync(port) { baud_used = baud; break; }
    }
    if baud_used == 0 { return Err("no bootloader".into()); }

    let sig = avr_cmd(port, &[STK_READ_SIGN, CRC_EOP], 3, Duration::from_secs(1))?;
    let sig = [sig[0], sig[1], sig[2]];
    let (name, page, max) = avr_part(sig).ok_or_else(|| format!("unknown chip {:02X} {:02X} {:02X}", sig[0], sig[1], sig[2]))?;
    // alter Bootloader (57600) belegt 2 KB statt 512 Byte
    let max = if baud_used == 57_600 { max + 512 - 2048 } else { max };
    report(p, "chip", 0, 1, name);
    if image.len() > max { return Err(format!("file too large for {} ({} > {} bytes)", name, image.len(), max)); }

    avr_cmd(port, &[STK_ENTER, CRC_EOP], 0, Duration::from_secs(1))?;
    let pages = (image.len() + page - 1) / page;
    let mut padded = image.clone();
    padded.resize(pages * page, 0xFF);

    for i in 0..pages {
        if cancel.load(Ordering::SeqCst) { let _ = avr_cmd(port, &[STK_LEAVE, CRC_EOP], 0, Duration::from_secs(1)); return Err("cancelled".into()); }
        let addr = (i * page / 2) as u16; // Wortadresse
        avr_cmd(port, &[STK_LOAD_ADDR, addr as u8, (addr >> 8) as u8, CRC_EOP], 0, Duration::from_secs(1))?;
        let mut cmd = vec![STK_PROG_PAGE, (page >> 8) as u8, page as u8, b'F'];
        cmd.extend_from_slice(&padded[i * page..(i + 1) * page]);
        cmd.push(CRC_EOP);
        avr_cmd(port, &cmd, 0, Duration::from_secs(2))?;
        report(p, "write", (i + 1) * page, pages * page, "");
    }
    report(p, "verify", 0, 1, "");
    for i in 0..pages {
        let addr = (i * page / 2) as u16;
        avr_cmd(port, &[STK_LOAD_ADDR, addr as u8, (addr >> 8) as u8, CRC_EOP], 0, Duration::from_secs(1))?;
        let got = avr_cmd(port, &[STK_READ_PAGE, (page >> 8) as u8, page as u8, b'F', CRC_EOP], page, Duration::from_secs(2))?;
        if got[..] != padded[i * page..(i + 1) * page] { return Err(format!("verify failed at 0x{:04x}", i * page)); }
    }
    avr_cmd(port, &[STK_LEAVE, CRC_EOP], 0, Duration::from_secs(1))?;
    report(p, "done", image.len(), image.len(), "");
    Ok(format!("{{\"chip\":{},\"bytes\":{},\"baud\":{}}}", jstr(name), image.len(), baud_used))
}

// =====================================================================
// TESTS mit simulierten Boards
// =====================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::process::Command;
    use std::sync::{Arc, Mutex};

    fn python_inflate(data: &[u8]) -> Vec<u8> {
        let path = std::env::temp_dir().join(format!("cnc_defl_{}_{}.bin", std::process::id(), data.len()));
        std::fs::write(&path, data).unwrap();
        let out = Command::new("python3").arg("-c")
            .arg(format!("import zlib,sys;sys.stdout.buffer.write(zlib.decompress(open(r'{}','rb').read()))", path.display()))
            .output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        out.stdout
    }

    fn test_image(n: usize) -> Vec<u8> {
        let mut v = Vec::with_capacity(n);
        let mut x: u32 = 12345;
        for i in 0..n {
            if (i / 4096) % 3 == 2 { v.push(0xFF); continue; } // leere Bereiche wie in echten Images
            x = x.wrapping_mul(1103515245).wrapping_add(12345);
            v.push(if i % 7 == 0 { (x >> 16) as u8 } else { b"GRBL ESP32 firmware "[(i / 3) % 20] });
        }
        v
    }

    #[test]
    fn deflate_roundtrip() {
        for n in [0usize, 1, 2, 3, 100, 5000, 70_000, 300_000] {
            let data = test_image(n);
            let c = zlib_compress(&data);
            assert_eq!(python_inflate(&c), data, "n={}", n);
        }
        let ff = vec![0xFFu8; 1 << 20];
        let c = zlib_compress(&ff);
        assert!(c.len() < 8000, "1 MB 0xFF -> {} bytes", c.len());
        assert_eq!(python_inflate(&c), ff);
    }

    #[test]
    fn md5_vectors() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(md5_hex(b"The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6");
        let big = test_image(100_000);
        let py = Command::new("python3").arg("-c").arg("import hashlib,sys;print(hashlib.md5(sys.stdin.buffer.read()).hexdigest())")
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
        py.stdin.as_ref().unwrap().write_all(&big).unwrap();
        let out = py.wait_with_output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), md5_hex(&big));
    }

    #[test]
    fn ihex_parse() {
        let hex = ":100000000C9434000C9446000C9446000C9446006A\n:0400100001020304E2\n:00000001FF\n";
        let m = parse_ihex(hex).unwrap();
        assert_eq!(m.len(), 20);
        assert_eq!(&m[..4], &[0x0C, 0x94, 0x34, 0x00]);
        assert_eq!(&m[16..], &[1, 2, 3, 4]);
        assert!(parse_ihex(":0400100001020304E3\n:00000001FF\n").is_err(), "bad checksum");
        assert!(parse_ihex(":0400100001020304E2\n").is_err(), "no EOF");
    }

    // ---------- simuliertes Port-Paar ----------
    #[derive(Clone)]
    struct Shared { to_dev: Arc<Mutex<VecDeque<u8>>>, to_host: Arc<Mutex<VecDeque<u8>>>, dtr: Arc<Mutex<bool>>, rts: Arc<Mutex<bool>>, baud: Arc<Mutex<u32>>, log: Arc<Mutex<Vec<String>>> }
    impl Shared {
        fn new() -> Self { Shared { to_dev: Default::default(), to_host: Default::default(), dtr: Default::default(), rts: Default::default(), baud: Arc::new(Mutex::new(115200)), log: Default::default() } }
    }
    struct HostPort(Shared);
    impl Read for HostPort {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let t0 = Instant::now();
            loop {
                { let mut q = self.0.to_host.lock().unwrap(); if let Some(b) = q.pop_front() { buf[0] = b; return Ok(1); } }
                if t0.elapsed() > Duration::from_millis(5) { return Err(std::io::Error::new(ErrorKind::TimedOut, "t")); }
                thread::sleep(Duration::from_micros(200));
            }
        }
    }
    impl Write for HostPort {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> { self.0.to_dev.lock().unwrap().extend(buf.iter()); Ok(buf.len()) }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    impl FlashPort for HostPort {
        fn set_dtr(&mut self, on: bool) { *self.0.dtr.lock().unwrap() = on; self.0.log.lock().unwrap().push(format!("dtr={}", on)); }
        fn set_rts(&mut self, on: bool) { *self.0.rts.lock().unwrap() = on; self.0.log.lock().unwrap().push(format!("rts={}", on)); }
        fn set_baud(&mut self, b: u32) -> Result<(), String> { *self.0.baud.lock().unwrap() = b; Ok(()) }
        fn clear_input(&mut self) { self.0.to_host.lock().unwrap().clear(); }
    }

    // ---------- simulierter ESP32-S3-ROM ----------
    fn spawn_esp(sh: Shared, magic: u32, stop: Arc<AtomicBool>) -> Arc<Mutex<Vec<u8>>> {
        let flash = Arc::new(Mutex::new(vec![0u8; 8 << 20]));
        let fl = flash.clone();
        thread::spawn(move || {
            let mut in_boot = false;
            let mut last_rts = false;
            let mut buf: Vec<u8> = Vec::new();
            let mut frame: Vec<u8> = Vec::new();
            let mut in_frame = false;
            let mut esc = false;
            let mut comp: Vec<u8> = Vec::new();
            let mut defl_off = 0usize;
            let mut rom_baud = 115200u32;
            let send = |sh: &Shared, op: u8, value: u32, data: &[u8]| {
                let mut body = vec![1u8, op];
                body.extend_from_slice(&((data.len() + 4) as u16).to_le_bytes());
                body.extend_from_slice(&value.to_le_bytes());
                body.extend_from_slice(data);
                body.extend_from_slice(&[0, 0, 0, 0]);
                let mut out = vec![0xC0];
                for b in body { match b { 0xC0 => out.extend([0xDB, 0xDC]), 0xDB => out.extend([0xDB, 0xDD]), x => out.push(x) } }
                out.push(0xC0);
                sh.to_host.lock().unwrap().extend(out);
            };
            while !stop.load(Ordering::SeqCst) {
                // Reset-Erkennung: steigende Flanke an EN (RTS fällt) bei IO0 low (DTR an)
                let rts = *sh.rts.lock().unwrap();
                let dtr = *sh.dtr.lock().unwrap();
                if last_rts && !rts { in_boot = dtr; if !in_boot { sh.to_host.lock().unwrap().extend(b"Grbl 1.1h ['$' for help]\r\n"); } }
                last_rts = rts;
                {
                    let mut q = sh.to_dev.lock().unwrap();
                    buf.extend(q.drain(..));
                }
                if buf.is_empty() { thread::sleep(Duration::from_micros(300)); continue; }
                if *sh.baud.lock().unwrap() != rom_baud { buf.clear(); continue; } // falsche Baudrate = Datenmüll
                for b in std::mem::take(&mut buf) {
                    if !in_boot { continue; }
                    if b == 0xC0 {
                        if in_frame && !frame.is_empty() {
                            let f = std::mem::take(&mut frame);
                            let op = f[1];
                            let data = &f[8..];
                            match op {
                                ESP_SYNC => for _ in 0..8 { send(&sh, op, 0, &[]) },
                                ESP_READ_REG => send(&sh, op, magic, &[]),
                                ESP_SPI_ATTACH | ESP_SPI_SET_PARAMS => send(&sh, op, 0, &[]),
                                ESP_CHANGE_BAUD => { send(&sh, op, 0, &[]); thread::sleep(Duration::from_millis(5)); rom_baud = u32::from_le_bytes([data[0], data[1], data[2], data[3]]); }
                                ESP_DEFL_BEGIN => {
                                    let w: Vec<u32> = data.chunks(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
                                    assert_eq!(w.len(), 5, "S3 needs 5 words");
                                    defl_off = w[3] as usize; comp.clear(); send(&sh, op, 0, &[]);
                                }
                                ESP_DEFL_DATA => {
                                    let len = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
                                    let chunk = &data[16..16 + len];
                                    let chk = chunk.iter().fold(0xEFu8, |a, &b| a ^ b) as u32;
                                    let want = u32::from_le_bytes([f[4], f[5], f[6], f[7]]);
                                    if chk != want { let mut e = vec![1u8, op, 4, 0, 0, 0, 0, 0, 1, 0x07, 0, 0]; let mut out = vec![0xC0]; out.append(&mut e); out.push(0xC0); sh.to_host.lock().unwrap().extend(out); continue; }
                                    comp.extend_from_slice(chunk); send(&sh, op, 0, &[]);
                                }
                                ESP_MD5 => {
                                    let w: Vec<u32> = data.chunks(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
                                    let raw = python_inflate(&comp);
                                    let mut fl = fl.lock().unwrap();
                                    fl[defl_off..defl_off + raw.len()].copy_from_slice(&raw);
                                    let hex = md5_hex(&fl[w[0] as usize..(w[0] + w[1]) as usize]);
                                    send(&sh, op, 0, hex.as_bytes());
                                }
                                ESP_DEFL_END => send(&sh, op, 0, &[]),
                                _ => {}
                            }
                        }
                        in_frame = true; frame.clear(); esc = false;
                    } else if in_frame {
                        if esc { frame.push(if b == 0xDC { 0xC0 } else { 0xDB }); esc = false; }
                        else if b == 0xDB { esc = true; } else { frame.push(b); }
                    }
                }
            }
        });
        flash
    }

    fn quiet() -> impl Fn(&str, String) { |_n: &str, _j: String| {} }

    #[test]
    fn esp32s3_flash_end_to_end() {
        let sh = Shared::new();
        let stop = Arc::new(AtomicBool::new(false));
        let flash = spawn_esp(sh.clone(), 0x9, stop.clone());
        // Komplettdatei wie von MKS: Kopf mit Chip-ID 9 (S3)
        let mut image = test_image(600_000);
        image[0] = 0xE9; image[12] = 9; image[13] = 0;
        let mut port = HostPort(sh.clone());
        let events: Arc<Mutex<Vec<String>>> = Default::default();
        let ev2 = events.clone();
        let prog = move |n: &str, j: String| ev2.lock().unwrap().push(format!("{} {}", n, j));
        let res = flash_esp(&mut port, &image, &EspOptions { offset: 0, baud: 921600, usb_jtag: false, flash_size: 8 << 20 }, &prog, &AtomicBool::new(false)).unwrap();
        assert!(res.contains("ESP32-S3"), "{}", res);
        assert_eq!(&flash.lock().unwrap()[..image.len()], &image[..]);
        assert!(events.lock().unwrap().iter().any(|e| e.contains("\"stage\":\"write\"")));
        // nach dem Flashen: normaler Neustart (EN-Puls ohne IO0)
        let log = sh.log.lock().unwrap().join(",");
        assert!(log.ends_with("dtr=false,rts=true,rts=false"), "{}", log);
        stop.store(true, Ordering::SeqCst);
    }

    /// grblHAL-ZIP (Bootloader 0x0, Partitionen 0x8000, Firmware 0x10000) in EINER Sitzung flashen –
    /// jeder Teil landet an seiner Adresse; ein Teil für den falschen Chip stoppt VOR dem ersten Schreiben
    #[test]
    fn esp32s3_flash_three_parts() {
        let sh = Shared::new();
        let stop = Arc::new(AtomicBool::new(false));
        let flash = spawn_esp(sh.clone(), 0x9, stop.clone());
        let mut boot = test_image(19_504); boot[0] = 0xE9; boot[12] = 9; boot[13] = 0;
        let table: Vec<u8> = (0..3072).map(|i| if i == 0 { 0xAA } else if i == 1 { 0x50 } else { (i % 251) as u8 }).collect();
        let mut app = test_image(300_000); app[0] = 0xE9; app[12] = 9; app[13] = 0;
        let mut port = HostPort(sh.clone());
        let opt = EspOptions { offset: 0, baud: 921600, usb_jtag: false, flash_size: 8 << 20 };
        let res = flash_esp_parts(&mut port, &[(0x0, &boot[..]), (0x8000, &table[..]), (0x10000, &app[..])], &opt, &quiet(), &AtomicBool::new(false)).unwrap();
        assert!(res.contains("\"parts\":3"), "{}", res);
        let fl = flash.lock().unwrap();
        assert_eq!(&fl[..boot.len()], &boot[..]);
        assert_eq!(&fl[0x8000..0x8000 + table.len()], &table[..]);
        assert_eq!(&fl[0x10000..0x10000 + app.len()], &app[..]);
        drop(fl);
        stop.store(true, Ordering::SeqCst);

        // falscher Chip in einem Teil: Abbruch, bevor irgendetwas geschrieben wird
        let sh = Shared::new();
        let stop = Arc::new(AtomicBool::new(false));
        let flash = spawn_esp(sh.clone(), 0x9, stop.clone());
        let mut wrong = app.clone(); wrong[12] = 0; // ESP32 statt S3
        let mut port = HostPort(sh.clone());
        let err = flash_esp_parts(&mut port, &[(0x0, &boot[..]), (0x10000, &wrong[..])], &opt, &quiet(), &AtomicBool::new(false)).unwrap_err();
        assert!(err.starts_with("wrong chip"), "{}", err);
        assert!(flash.lock().unwrap()[..64].iter().all(|&b| b == 0), "nichts darf geschrieben sein");
        stop.store(true, Ordering::SeqCst);
    }

    /// .elf umwandeln und auf ein (simuliertes) ESP32-S3-Board an 0x10000 flashen;
    /// auf einem klassischen ESP32 wird dieselbe Datei abgelehnt
    #[test]
    fn esp_elf_converted_and_chip_checked() {
        let elf = crate::elfimg::tests::tiny_elf();
        let img = crate::elfimg::elf_to_image(&elf, 0x30).unwrap();
        let sh = Shared::new();
        let stop = Arc::new(AtomicBool::new(false));
        let flash = spawn_esp(sh.clone(), 0x9, stop.clone());
        let mut port = HostPort(sh.clone());
        flash_esp(&mut port, &img.image, &EspOptions { offset: 0x10000, baud: 115200, usb_jtag: false, flash_size: 8 << 20 }, &quiet(), &AtomicBool::new(false)).unwrap();
        assert_eq!(&flash.lock().unwrap()[0x10000..0x10000 + img.image.len()], &img.image[..]);
        stop.store(true, Ordering::SeqCst);

        let sh = Shared::new();
        let stop = Arc::new(AtomicBool::new(false));
        spawn_esp(sh.clone(), 0x00f0_1d83, stop.clone());
        let mut port = HostPort(sh.clone());
        let err = flash_esp(&mut port, &img.image, &EspOptions { offset: 0x10000, baud: 115200, usb_jtag: false, flash_size: 4 << 20 }, &quiet(), &AtomicBool::new(false)).unwrap_err();
        assert!(err.contains("wrong chip"), "{}", err);
        stop.store(true, Ordering::SeqCst);
    }

    #[test]
    fn esp_wrong_chip_is_refused() {
        let sh = Shared::new();
        let stop = Arc::new(AtomicBool::new(false));
        spawn_esp(sh.clone(), 0x00f0_1d83, stop.clone()); // klassischer ESP32
        let mut image = test_image(10_000);
        image[0] = 0xE9; image[12] = 9; // Datei für S3
        let mut port = HostPort(sh.clone());
        let err = flash_esp(&mut port, &image, &EspOptions { offset: 0, baud: 115200, usb_jtag: false, flash_size: 4 << 20 }, &quiet(), &AtomicBool::new(false)).unwrap_err();
        assert!(err.contains("wrong chip"), "{}", err);
        stop.store(true, Ordering::SeqCst);
    }

    #[test]
    fn esp_no_bootloader() {
        let sh = Shared::new(); // kein Board
        let mut port = HostPort(sh);
        let err = flash_esp(&mut port, &[0xE9; 100], &EspOptions { offset: 0, baud: 115200, usb_jtag: true, flash_size: 4 << 20 }, &quiet(), &AtomicBool::new(false)).unwrap_err();
        assert_eq!(err, "no bootloader");
    }

    // ---------- simulierter Arduino (Optiboot) ----------
    fn spawn_avr(sh: Shared, boot_baud: u32, stop: Arc<AtomicBool>) -> Arc<Mutex<Vec<u8>>> {
        let flash = Arc::new(Mutex::new(vec![0xFFu8; 32768]));
        let fl = flash.clone();
        thread::spawn(move || {
            let mut addr = 0usize;
            let mut q: VecDeque<u8> = VecDeque::new();
            let mut last_dtr = false;
            let mut boot = false;
            let reply = |sh: &Shared, data: &[u8]| { let mut o = vec![STK_INSYNC]; o.extend_from_slice(data); o.push(STK_OK); sh.to_host.lock().unwrap().extend(o); };
            while !stop.load(Ordering::SeqCst) {
                let dtr = *sh.dtr.lock().unwrap();
                if dtr && !last_dtr { boot = true; q.clear(); }
                last_dtr = dtr;
                { let mut d = sh.to_dev.lock().unwrap(); q.extend(d.drain(..)); }
                if !boot || *sh.baud.lock().unwrap() != boot_baud { q.clear(); thread::sleep(Duration::from_micros(300)); continue; }
                let need = match q.front() {
                    None => { thread::sleep(Duration::from_micros(300)); continue; }
                    Some(&STK_LOAD_ADDR) => 4,
                    Some(&STK_PROG_PAGE) => if q.len() >= 3 { 5 + (((q[1] as usize) << 8) | q[2] as usize) } else { 3 },
                    Some(&STK_READ_PAGE) => 5,
                    Some(_) => 2,
                };
                if q.len() < need { thread::sleep(Duration::from_micros(300)); continue; }
                let c: Vec<u8> = q.drain(..need).collect();
                match c[0] {
                    STK_GET_SYNC | STK_ENTER | STK_LEAVE => reply(&sh, &[]),
                    STK_READ_SIGN => reply(&sh, &[0x1E, 0x95, 0x0F]),
                    STK_LOAD_ADDR => { addr = (((c[2] as usize) << 8) | c[1] as usize) * 2; reply(&sh, &[]); }
                    STK_PROG_PAGE => { let n = ((c[1] as usize) << 8) | c[2] as usize; fl.lock().unwrap()[addr..addr + n].copy_from_slice(&c[4..4 + n]); reply(&sh, &[]); }
                    STK_READ_PAGE => { let n = ((c[1] as usize) << 8) | c[2] as usize; let d = fl.lock().unwrap()[addr..addr + n].to_vec(); reply(&sh, &d); }
                    _ => {}
                }
            }
        });
        flash
    }

    fn to_ihex(data: &[u8]) -> String {
        let mut s = String::new();
        for (i, ch) in data.chunks(16).enumerate() {
            let addr = i * 16;
            let mut rec = vec![ch.len() as u8, (addr >> 8) as u8, addr as u8, 0];
            rec.extend_from_slice(ch);
            let sum = rec.iter().fold(0u8, |a, &b| a.wrapping_add(b));
            rec.push(0u8.wrapping_sub(sum));
            s.push(':');
            for b in rec { s.push_str(&format!("{:02X}", b)); }
            s.push('\n');
        }
        s + ":00000001FF\n"
    }

    #[test]
    fn avr_optiboot_and_old_bootloader() {
        for boot_baud in [115_200u32, 57_600] {
            let sh = Shared::new();
            let stop = Arc::new(AtomicBool::new(false));
            let flash = spawn_avr(sh.clone(), boot_baud, stop.clone());
            let image = test_image(29_000); // so groß wie GRBL 1.1
            let mut port = HostPort(sh.clone());
            let res = flash_avr(&mut port, &to_ihex(&image), &quiet(), &AtomicBool::new(false)).unwrap();
            assert!(res.contains("ATmega328P") && res.contains(&boot_baud.to_string()), "{}", res);
            assert_eq!(&flash.lock().unwrap()[..image.len()], &image[..]);
            stop.store(true, Ordering::SeqCst);
        }
    }

    /// Die mitgelieferte, echte GRBL-1.1h-Datei aufs simulierte Arduino spielen
    #[test]
    fn avr_bundled_grbl() {
        let text = include_str!("../firmware/grbl_v1.1h.20190825.hex");
        let image = parse_ihex(text).unwrap();
        assert_eq!(image.len(), 29_920);
        let sh = Shared::new();
        let stop = Arc::new(AtomicBool::new(false));
        let flash = spawn_avr(sh.clone(), 115_200, stop.clone());
        let mut port = HostPort(sh.clone());
        flash_avr(&mut port, text, &quiet(), &AtomicBool::new(false)).unwrap();
        assert_eq!(&flash.lock().unwrap()[..image.len()], &image[..]);
        stop.store(true, Ordering::SeqCst);
    }

    #[test]
    fn avr_too_big() {
        let sh = Shared::new();
        let stop = Arc::new(AtomicBool::new(false));
        spawn_avr(sh.clone(), 115_200, stop.clone());
        let mut port = HostPort(sh);
        let err = flash_avr(&mut port, &to_ihex(&vec![0u8; 33_000]), &quiet(), &AtomicBool::new(false)).unwrap_err();
        assert!(err.contains("too large"), "{}", err);
        stop.store(true, Ordering::SeqCst);
    }
}
