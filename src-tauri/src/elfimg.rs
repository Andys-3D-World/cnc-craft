//! ELF → ESP-Firmware-Abbild (wie „esptool elf2image“)
//!
//! Manche Firmware gibt es nur als .elf (das fertig übersetzte Programm, z. B. eigene
//! FluidNC-Builds). Der ESP32 startet aber nur Programme im „App-Image“-Format von Espressif:
//!
//!   Kopf (24 Byte):  0xE9, Anzahl Segmente, SPI-Modus, Flash-Größe/Takt, Startadresse,
//!                    0xEE, SPI-Treiber, Chip-Kennung, min./max. Chip-Revision, …, Hash-Flag
//!   Segmente:        Ladeadresse, Länge, Daten (je auf 4 Byte aufgefüllt)
//!   Ende:            auf 16 Byte auffüllen, Prüfbyte (XOR aller Segmentdaten mit 0xEF),
//!                    danach SHA-256 über alles
//!
//! Besonderheit: Programmteile, die direkt aus dem Flash laufen (IROM/DROM), müssen in der
//! Datei so liegen, dass Datei-Position und Adresse in der 64-KB-Seite übereinstimmen.
//! Lücken davor werden mit Stücken der RAM-Segmente (oder Nullen) gefüllt.
//!
//! Format nach der Espressif-Dokumentation („App Image Format“); geprüft Byte für Byte gegen
//! die Ausgabe von esptool (siehe Tests).

use std::collections::BTreeMap;

const IMAGE_MAGIC: u8 = 0xE9;
const CHECKSUM_MAGIC: u8 = 0xEF;
const SEG_HDR: usize = 8;
const PAGE: usize = 0x10000; // MMU-Seite 64 KB
const APP_DESC_MAGIC: u32 = 0xABCD_5432;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EspChip { Esp32, Esp32S2, Esp32S3, Esp32C3 }

impl EspChip {
    pub fn name(&self) -> &'static str {
        match self { EspChip::Esp32 => "ESP32", EspChip::Esp32S2 => "ESP32-S2", EspChip::Esp32S3 => "ESP32-S3", EspChip::Esp32C3 => "ESP32-C3" }
    }
    pub fn image_id(&self) -> u16 {
        match self { EspChip::Esp32 => 0, EspChip::Esp32S2 => 2, EspChip::Esp32S3 => 9, EspChip::Esp32C3 => 5 }
    }
    /// Adressbereiche, die direkt aus dem Flash gelesen werden (IROM, DROM)
    fn flash_ranges(&self) -> [(u32, u32); 2] {
        match self {
            EspChip::Esp32 => [(0x400D_0000, 0x4040_0000), (0x3F40_0000, 0x3F80_0000)],
            EspChip::Esp32S2 => [(0x4008_0000, 0x40B8_0000), (0x3F00_0000, 0x3F3F_0000)],
            EspChip::Esp32S3 => [(0x4200_0000, 0x4400_0000), (0x3C00_0000, 0x3E00_0000)],
            EspChip::Esp32C3 => [(0x4200_0000, 0x4280_0000), (0x3C00_0000, 0x3C80_0000)],
        }
    }
    fn is_flash(&self, addr: u32) -> bool {
        self.flash_ranges().iter().any(|&(a, b)| addr >= a && addr < b)
    }
    /// Speicherart einer Adresse (benachbarte Teile werden nur bei gleicher Art zusammengelegt)
    fn memory_class(&self, addr: u32) -> u32 {
        let map: &[(u32, u32)] = match self {
            EspChip::Esp32 => &[(0x3F40_0000, 0x3F80_0000), (0x3F80_0000, 0x3FC0_0000), (0x3FF8_0000, 0x3FF8_2000), (0x3FF9_0000, 0x4000_0000),
                (0x3FFA_E000, 0x4000_0000), (0x3FFE_0000, 0x3FFF_FFFC), (0x4000_0000, 0x4007_0000), (0x4007_0000, 0x4007_8000), (0x4007_8000, 0x4008_0000),
                (0x4008_0000, 0x400A_0000), (0x400A_0000, 0x400B_FFFC), (0x400C_0000, 0x400C_2000), (0x400D_0000, 0x4040_0000), (0x5000_0000, 0x5000_2000)],
            EspChip::Esp32S3 => &[(0x3C00_0000, 0x3D00_0000), (0x3D00_0000, 0x3E00_0000), (0x600F_E000, 0x6010_0000), (0x3FC8_8000, 0x3FD0_0000),
                (0x3FC8_8000, 0x403E_2000), (0x4000_0000, 0x4001_A100), (0x4037_0000, 0x403E_0000), (0x4200_0000, 0x4280_0000), (0x5000_0000, 0x5000_2000)],
            _ => &[],
        };
        // Bitmaske aller Bereiche, die die Adresse enthalten (wie „Liste der Speicherarten“)
        let mut m = 0u32;
        for (i, &(a, b)) in map.iter().enumerate() { if addr >= a && addr < b { m |= 1 << i; } }
        if map.is_empty() { addr >> 24 } else { m }
    }
}

#[derive(Clone, Debug)]
struct Seg { addr: u32, data: Vec<u8>, name: String }

impl Seg {
    fn pad4(&mut self) { while self.data.len() % 4 != 0 { self.data.push(0); } }
}

/// Programm-Infos aus dem eingebauten „esp_app_desc“
#[derive(Clone, Debug, Default)]
pub struct AppDesc { pub project: String, pub version: String, pub idf: String, pub date: String }

#[derive(Debug)]
pub struct ElfImage {
    pub image: Vec<u8>,
    pub chip: EspChip,
    pub segments: usize,
    #[allow(dead_code)] // Startadresse – nur zur Anzeige/Diagnose
    pub entry: u32,
    pub app: Option<AppDesc>,
}

fn u16le(b: &[u8], o: usize) -> Result<u16, String> { b.get(o..o + 2).map(|x| u16::from_le_bytes([x[0], x[1]])).ok_or_else(|| "elf: truncated".into()) }
fn u32le(b: &[u8], o: usize) -> Result<u32, String> { b.get(o..o + 4).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]])).ok_or_else(|| "elf: truncated".into()) }

fn cstr(b: &[u8]) -> String {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..end]).trim().to_string()
}

fn parse_app_desc(d: &[u8]) -> Option<AppDesc> {
    if d.len() < 0x90 || u32::from_le_bytes([d[0], d[1], d[2], d[3]]) != APP_DESC_MAGIC { return None; }
    Some(AppDesc { version: cstr(&d[16..48]), project: cstr(&d[48..80]), date: format!("{} {}", cstr(&d[96..112]), cstr(&d[80..96])).trim().to_string(), idf: cstr(&d[112..144]) })
}

/// Welcher Chip? Aus Prozessor-Art (Xtensa / RISC-V) und den benutzten Adressen
fn detect_chip(machine: u16, secs: &[Seg]) -> Result<EspChip, String> {
    let has = |a: u32, b: u32| secs.iter().any(|s| s.addr >= a && s.addr < b);
    match machine {
        0x5E => {
            if has(0x4200_0000, 0x4400_0000) || has(0x3C00_0000, 0x3E00_0000) || has(0x4037_0000, 0x403E_0000) { Ok(EspChip::Esp32S3) }
            else if has(0x400D_0000, 0x4040_0000) || has(0x3F40_0000, 0x3F80_0000) || has(0x4008_0000, 0x400A_0000) { Ok(EspChip::Esp32) }
            else if has(0x3F00_0000, 0x3F3F_0000) || has(0x4002_0000, 0x4007_0000) { Ok(EspChip::Esp32S2) }
            else { Err("elf: unknown chip".into()) }
        }
        0xF3 => {
            if has(0x4200_0000, 0x4280_0000) || has(0x3C00_0000, 0x3C80_0000) { Ok(EspChip::Esp32C3) } else { Err("elf: unknown chip".into()) }
        }
        _ => Err("elf: not an ESP program".into()),
    }
}

/// Teile (Sections) des Programms lesen: nur echte Daten mit Adresse (kein .bss, keine Kommentare)
fn read_sections(elf: &[u8]) -> Result<(u16, u32, Vec<Seg>), String> {
    if elf.len() < 52 || &elf[..4] != b"\x7fELF" { return Err("elf: not an ELF file".into()); }
    if elf[4] != 1 || elf[5] != 1 { return Err("elf: only 32-bit little-endian".into()); }
    let machine = u16le(elf, 18)?;
    let entry = u32le(elf, 24)?;
    let shoff = u32le(elf, 32)? as usize;
    let shentsize = u16le(elf, 46)? as usize;
    let shnum = u16le(elf, 48)? as usize;
    let shstrndx = u16le(elf, 50)? as usize;
    if shentsize != 40 || shnum == 0 { return Err("elf: no sections".into()); }
    let sh = |i: usize| -> Result<(u32, u32, u32, usize, usize), String> {
        let o = shoff + i * 40;
        Ok((u32le(elf, o)?, u32le(elf, o + 4)?, u32le(elf, o + 12)?, u32le(elf, o + 16)? as usize, u32le(elf, o + 20)? as usize))
    };
    let (_, _, _, str_off, str_size) = sh(shstrndx)?;
    let strtab = elf.get(str_off..str_off + str_size).ok_or("elf: bad string table")?;
    let mut out = Vec::new();
    for i in 0..shnum {
        let (name_off, typ, addr, off, size) = sh(i)?;
        if addr == 0 || size == 0 { continue; }
        // PROGBITS, INIT_ARRAY, FINI_ARRAY, PREINIT_ARRAY
        if !matches!(typ, 1 | 14 | 15 | 16) { continue; }
        let data = elf.get(off..off + size).ok_or("elf: section outside file")?.to_vec();
        let name = cstr(strtab.get(name_off as usize..).unwrap_or(&[]));
        let mut s = Seg { addr, data, name };
        s.pad4();
        out.push(s);
    }
    if out.is_empty() { return Err("elf: no program data".into()); }
    Ok((machine, entry, out))
}

/// flash_size_code: 0x00 = 1 MB, 0x10 = 2 MB, 0x20 = 4 MB, 0x30 = 8 MB, 0x40 = 16 MB …
pub fn elf_to_image(elf: &[u8], flash_size_code: u8) -> Result<ElfImage, String> {
    let (machine, entry, mut secs) = read_sections(elf)?;
    let chip = detect_chip(machine, &secs)?;
    secs.sort_by_key(|s| s.addr);

    // aneinander anschließende Teile gleicher Speicherart zusammenlegen
    let mut merged: Vec<Seg> = Vec::new();
    for s in secs {
        if let Some(last) = merged.last_mut() {
            if last.addr as usize + last.data.len() == s.addr as usize && chip.memory_class(last.addr) == chip.memory_class(s.addr) {
                last.data.extend_from_slice(&s.data);
                continue;
            }
        }
        merged.push(s);
    }
    let app = merged.iter().find(|s| s.name == ".flash.appdesc" || s.data.starts_with(&APP_DESC_MAGIC.to_le_bytes())).and_then(|s| parse_app_desc(&s.data));

    let mut flash: Vec<Seg> = merged.iter().filter(|s| chip.is_flash(s.addr)).cloned().collect();
    let mut ram: VecDequeLike = VecDequeLike(merged.iter().filter(|s| !chip.is_flash(s.addr)).cloned().collect());
    // App-Beschreibung muss das erste Flash-Segment sein
    if let Some(i) = flash.iter().position(|s| s.name == ".flash.appdesc") {
        let s = flash.remove(i);
        flash.insert(0, s);
    }
    for w in flash.windows(2) {
        if (w[0].addr as usize) / PAGE == (w[1].addr as usize) / PAGE {
            return Err(format!("elf: two flash parts in one 64 KB page (0x{:08x}, 0x{:08x})", w[0].addr, w[1].addr));
        }
    }

    let mut f: Vec<u8> = Vec::with_capacity(elf.len());
    // Kopf (Anzahl Segmente wird am Ende eingetragen)
    let flash_freq = 0x0F; // 80 MHz
    f.extend_from_slice(&[IMAGE_MAGIC, 0, 0x02 /* DIO */, (flash_size_code & 0xF0) | flash_freq]);
    f.extend_from_slice(&entry.to_le_bytes());
    f.push(0xEE); // WP-Pin aus
    f.extend_from_slice(&[0, 0, 0]); // SPI-Treiber
    f.extend_from_slice(&chip.image_id().to_le_bytes());
    f.push(0); // min. Revision (alt)
    f.extend_from_slice(&0u16.to_le_bytes()); // min. Revision
    f.extend_from_slice(&0xFFFFu16.to_le_bytes()); // max. Revision: alle
    f.extend_from_slice(&[0, 0, 0, 0]);
    f.push(1); // SHA-256 angehängt

    let mut checksum = CHECKSUM_MAGIC;
    let mut count = 0u8;
    let write_seg = |f: &mut Vec<u8>, addr: u32, data: &[u8], checksum: &mut u8, count: &mut u8| {
        f.extend_from_slice(&addr.to_le_bytes());
        f.extend_from_slice(&(data.len() as u32).to_le_bytes());
        f.extend_from_slice(data);
        for &b in data { *checksum ^= b; }
        *count = count.wrapping_add(1);
    };

    let mut fi = 0;
    while fi < flash.len() {
        let seg = &flash[fi];
        // Füllbedarf, damit nach dem 8-Byte-Kopf: Dateiposition ≡ Adresse (mod 64 KB)
        let align_past = (seg.addr as i64 % PAGE as i64) - SEG_HDR as i64;
        let mut pad = (PAGE as i64 - (f.len() as i64 % PAGE as i64)) + align_past;
        if pad == 0 || pad == PAGE as i64 {
            let mut data = seg.data.clone();
            if chip == EspChip::Esp32 {
                // ältere ESP32-Bootloader bilden die letzte Seite nur ab, wenn sie > 0x24 Byte hineinragt
                let end = f.len() + data.len() + SEG_HDR;
                let rem = end % PAGE;
                if rem < 0x24 { data.extend(std::iter::repeat(0).take(0x24 - rem)); }
            }
            let addr = seg.addr;
            write_seg(&mut f, addr, &data, &mut checksum, &mut count);
            fi += 1;
            continue;
        }
        pad -= SEG_HDR as i64;
        if pad < 0 { pad += PAGE as i64; }
        let pad = pad as usize;
        if let Some(r) = ram.front_mut().filter(|_| pad > SEG_HDR) {
            // Lücke mit dem Anfang eines RAM-Segments füllen
            let take = pad.min(r.data.len());
            let piece: Vec<u8> = r.data.drain(..take).collect();
            let addr = r.addr;
            r.addr += take as u32;
            if r.data.is_empty() { ram.pop_front(); }
            write_seg(&mut f, addr, &piece, &mut checksum, &mut count);
        } else {
            write_seg(&mut f, 0, &vec![0u8; pad], &mut checksum, &mut count);
        }
    }
    for r in ram.0.drain(..) {
        write_seg(&mut f, r.addr, &r.data, &mut checksum, &mut count);
    }
    // Prüfbyte an Position ≡ 15 (mod 16)
    while f.len() % 16 != 15 { f.push(0); }
    f.push(checksum);
    f[1] = count;

    // SHA-256 der ELF-Datei in die App-Beschreibung (Datei-Offset 0xB0), falls dort Nullen stehen
    if app.is_some() && f.len() > 0xB0 + 32 && f[0xB0..0xB0 + 32].iter().all(|&b| b == 0) {
        // nur sinnvoll, wenn das erste Segment die App-Beschreibung ist
        let first_addr = u32::from_le_bytes([f[24], f[25], f[26], f[27]]);
        if chip.is_flash(first_addr) {
            let h = sha256(elf);
            f[0xB0..0xB0 + 32].copy_from_slice(&h);
            // Prüfbyte neu berechnen (die Hash-Bytes gehören zu den Segmentdaten)
            let mut c = f[f.len() - 1];
            for &b in &h { c ^= b; }
            let n = f.len();
            f[n - 1] = c;
        }
    }
    let digest = sha256(&f);
    f.extend_from_slice(&digest);
    Ok(ElfImage { image: f, chip, segments: count as usize, entry, app })
}

/// Hilfsliste mit „vorne wegnehmen“ (ohne extra Abhängigkeit)
struct VecDequeLike(Vec<Seg>);
impl VecDequeLike {
    fn front_mut(&mut self) -> Option<&mut Seg> { self.0.first_mut() }
    fn pop_front(&mut self) { if !self.0.is_empty() { self.0.remove(0); } }
}

// ---------------------------------------------------------------------
// SHA-256 (kurz, ohne Abhängigkeit)
// ---------------------------------------------------------------------

pub fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let mut msg = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 { msg.push(0); }
    msg.extend_from_slice(&bits.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 { w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]); }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7].wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [t1.wrapping_add(t2), v[0], v[1], v[2], v[3].wrapping_add(t1), v[4], v[5], v[6]];
        }
        for i in 0..8 { h[i] = h[i].wrapping_add(v[i]); }
    }
    let mut out = [0u8; 32];
    for i in 0..8 { out[4 * i..4 * i + 4].copy_from_slice(&h[i].to_be_bytes()); }
    out
}

/// Kurze Zusammenfassung eines (umgewandelten) Abbilds: Segment-Adressen und -Längen (für Tests/Diagnose)
#[allow(dead_code)]
pub fn segment_table(image: &[u8]) -> BTreeMap<usize, (u32, usize)> {
    let mut m = BTreeMap::new();
    if image.len() < 24 || image[0] != IMAGE_MAGIC { return m; }
    let n = image[1] as usize;
    let mut p = 24;
    for i in 0..n {
        if p + 8 > image.len() { break; }
        let addr = u32::from_le_bytes([image[p], image[p + 1], image[p + 2], image[p + 3]]);
        let len = u32::from_le_bytes([image[p + 4], image[p + 5], image[p + 6], image[p + 7]]) as usize;
        m.insert(i, (addr, len));
        p += 8 + len;
    }
    m
}

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    fn sha256_known() {
        let h = sha256(b"abc");
        assert_eq!(h[..4], [0xba, 0x78, 0x16, 0xbf]);
        let h = sha256(b"");
        assert_eq!(h[..4], [0xe3, 0xb0, 0xc4, 0x42]);
    }

    /// kleine ELF-Datei bauen (wie ein ESP-IDF-Programm für den ESP32-S3)
    pub fn tiny_elf() -> Vec<u8> {
        let mut desc = APP_DESC_MAGIC.to_le_bytes().to_vec();
        desc.resize(16, 0);
        let mut v = b"v1.0".to_vec(); v.resize(32, 0); desc.extend(v);
        let mut p = b"Test".to_vec(); p.resize(32, 0); desc.extend(p);
        desc.resize(256, 0);
        let secs: Vec<(&str, u32, u32, Vec<u8>)> = vec![
            (".flash.appdesc", 1, 0x3C00_0020, desc),
            (".flash.text", 1, 0x4201_0020, vec![0x11; 4000]),
            (".iram0.text", 1, 0x4037_8000, vec![0x22; 400]),
            (".dram0.bss", 8, 0x3FC9_0000, vec![]),
        ];
        let mut names = b"\0.shstrtab\0".to_vec();
        let mut body = Vec::new();
        let mut hdrs = Vec::new();
        for (n, t, a, d) in &secs {
            let no = names.len() as u32; names.extend(n.as_bytes()); names.push(0);
            let off = 52 + body.len() as u32;
            hdrs.push((no, *t, *a, off, if *t == 8 { 100 } else { d.len() as u32 }));
            if *t != 8 { body.extend(d); }
        }
        let str_off = 52 + body.len() as u32;
        body.extend(&names);
        while body.len() % 4 != 0 { body.push(0); }
        let shoff = 52 + body.len() as u32;
        let mut e = b"\x7fELF\x01\x01\x01".to_vec(); e.resize(16, 0);
        for v in [2u16, 0x5E] { e.extend(v.to_le_bytes()); }
        e.extend(1u32.to_le_bytes()); e.extend(0x4037_8000u32.to_le_bytes()); e.extend(0u32.to_le_bytes()); e.extend(shoff.to_le_bytes()); e.extend(0u32.to_le_bytes());
        for v in [52u16, 0, 0, 40, (hdrs.len() + 2) as u16, (hdrs.len() + 1) as u16] { e.extend(v.to_le_bytes()); }
        e.extend(&body);
        e.extend([0u8; 40]);
        for (no, t, a, off, size) in hdrs { for v in [no, t, 6, a, off, size, 0, 0, 4, 0] { e.extend(v.to_le_bytes()); } }
        for v in [1u32, 3, 0, 0, str_off, names.len() as u32, 0, 0, 1, 0] { e.extend(v.to_le_bytes()); }
        e
    }

    #[test]
    fn converts_and_aligns() {
        let elf = tiny_elf();
        let img = elf_to_image(&elf, 0x30).unwrap();
        assert_eq!(img.chip, EspChip::Esp32S3);
        assert_eq!(img.app.as_ref().unwrap().project, "Test");
        let b = &img.image;
        assert_eq!(b[0], 0xE9);
        assert_eq!(u16::from_le_bytes([b[12], b[13]]), 9);
        // Flash-Segmente stehen an der richtigen Stelle in der 64-KB-Seite
        let mut p = 24;
        for _ in 0..b[1] {
            let addr = u32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]);
            let len = u32::from_le_bytes([b[p + 4], b[p + 5], b[p + 6], b[p + 7]]) as usize;
            if EspChip::Esp32S3.is_flash(addr) { assert_eq!((p + 8) % PAGE, addr as usize % PAGE, "0x{:x}", addr); }
            p += 8 + len;
        }
        // Prüfbyte und SHA-256
        let n = b.len();
        assert_eq!((n - 32) % 16, 0);
        assert_eq!(sha256(&b[..n - 32]), b[n - 32..]);
        let mut c = CHECKSUM_MAGIC;
        let mut p = 24;
        for _ in 0..b[1] {
            let len = u32::from_le_bytes([b[p + 4], b[p + 5], b[p + 6], b[p + 7]]) as usize;
            for &x in &b[p + 8..p + 8 + len] { c ^= x; }
            p += 8 + len;
        }
        assert_eq!(c, b[n - 33]);
    }

    #[test]
    fn rejects_non_elf() {
        assert!(elf_to_image(b"hello world, no elf here at all ............................", 0x30).is_err());
        let mut e = tiny_elf();
        e[18] = 0x28; // ARM
        assert!(elf_to_image(&e, 0x30).is_err());
    }
}
