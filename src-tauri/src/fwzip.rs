//! FIRMWARE AUS EINER ZIP-DATEI (grblHAL Web Builder, FluidNC …)
//!
//! Der grblHAL Web Builder liefert für ESP32-Boards eine ZIP mit mehreren Teilen:
//!   bootloader.bin  -> ESP32: 0x1000, ESP32-S2/S3/C3: 0x0
//!   partitions.bin  -> 0x8000   (Partitionstabelle, beginnt mit AA 50)
//!   firmware.bin    -> Adresse der ersten App-Partition aus der Tabelle (meist 0x10000)
//!   ReadMe.txt      -> wird ignoriert
//! Hier wird die ZIP gelesen (nur „gespeichert“ und „deflate“, wie es alle üblichen Programme schreiben),
//! jeder Teil erkannt und seine Adresse bestimmt. Geflasht wird in flash.rs (flash_esp_parts).
//! Grenzen gegen kaputte oder manipulierte Dateien: höchstens 16 Einträge, je 16 MB, zusammen 32 MB.

use std::io::Read;

const MAX_ENTRIES: usize = 16;
const MAX_PART: usize = 16 << 20;
const MAX_TOTAL: usize = 32 << 20;

#[derive(Debug, Clone)]
pub struct Part {
    pub name: String,
    pub role: &'static str, // "bootloader", "partitions", "app"
    pub offset: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ZipFirmware {
    pub parts: Vec<Part>,      // in Flash-Reihenfolge (Bootloader, Partitionen, App)
    pub chip_id: Option<u16>,  // ESP-Chipkennung aus Bootloader/App
    pub needs_flash: u32,      // Ende der letzten Partition = nötige Flash-Größe
}

fn u16le(b: &[u8], o: usize) -> Option<u16> { b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]])) }
fn u32le(b: &[u8], o: usize) -> Option<u32> { b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])) }

/// Alle Dateien einer ZIP: (Name, Inhalt)
pub fn read_zip(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    // „End of central directory“ suchen (steht am Ende, evtl. mit Kommentar dahinter)
    let start = bytes.len().saturating_sub(22 + 65_535);
    let eocd = (start..bytes.len().saturating_sub(21)).rev()
        .find(|&i| u32le(bytes, i) == Some(0x0605_4b50))
        .ok_or("zip: no directory")?;
    let count = u16le(bytes, eocd + 10).ok_or("zip: bad directory")? as usize;
    let mut pos = u32le(bytes, eocd + 16).ok_or("zip: bad directory")? as usize;
    if count > MAX_ENTRIES { return Err("zip: too many files".into()); }
    let mut out = Vec::new();
    let mut total = 0usize;
    for _ in 0..count {
        if u32le(bytes, pos) != Some(0x0201_4b50) { return Err("zip: bad entry".into()); }
        let flags = u16le(bytes, pos + 8).ok_or("zip: bad entry")?;
        let method = u16le(bytes, pos + 10).ok_or("zip: bad entry")?;
        let csize = u32le(bytes, pos + 20).ok_or("zip: bad entry")? as usize;
        let usize_ = u32le(bytes, pos + 24).ok_or("zip: bad entry")? as usize;
        let nlen = u16le(bytes, pos + 28).ok_or("zip: bad entry")? as usize;
        let xlen = u16le(bytes, pos + 30).ok_or("zip: bad entry")? as usize;
        let clen = u16le(bytes, pos + 32).ok_or("zip: bad entry")? as usize;
        let local = u32le(bytes, pos + 42).ok_or("zip: bad entry")? as usize;
        let name = String::from_utf8_lossy(bytes.get(pos + 46..pos + 46 + nlen).ok_or("zip: bad entry")?).to_string();
        pos += 46 + nlen + xlen + clen;
        if name.ends_with('/') { continue; }
        if flags & 1 != 0 { return Err("zip: encrypted".into()); }
        if usize_ > MAX_PART { return Err(format!("zip: {} too large", name)); }
        total += usize_;
        if total > MAX_TOTAL { return Err("zip: too large".into()); }
        // lokaler Kopf: eigene Längen für Name/Extra
        if u32le(bytes, local) != Some(0x0403_4b50) { return Err("zip: bad local header".into()); }
        let lnlen = u16le(bytes, local + 26).ok_or("zip: bad local header")? as usize;
        let lxlen = u16le(bytes, local + 28).ok_or("zip: bad local header")? as usize;
        let dstart = local + 30 + lnlen + lxlen;
        let raw = bytes.get(dstart..dstart + csize).ok_or("zip: truncated")?;
        let data = match method {
            0 => raw.to_vec(),
            8 => {
                let mut v = Vec::with_capacity(usize_);
                flate2::read::DeflateDecoder::new(raw).take(MAX_PART as u64 + 1).read_to_end(&mut v).map_err(|e| format!("zip: {}", e))?;
                v
            }
            m => return Err(format!("zip: method {} not supported", m)),
        };
        if data.len() != usize_ { return Err(format!("zip: {} size mismatch", name)); }
        out.push((name, data));
    }
    Ok(out)
}

/// Chipkennung aus einem ESP-Abbild-Kopf (E9 …, Byte 12/13)
fn chip_of(data: &[u8]) -> Option<u16> {
    if data.first() == Some(&0xE9) { u16le(data, 12) } else { None }
}

/// Partitionstabelle lesen: (Adresse der ersten App, Ende der letzten Partition)
fn partition_info(table: &[u8]) -> (Option<u32>, u32) {
    let mut app = None;
    let mut end = 0u32;
    for e in table.chunks(32) {
        if e.len() < 32 || e[0] != 0xAA || e[1] != 0x50 { break; }
        let off = u32::from_le_bytes([e[4], e[5], e[6], e[7]]);
        let size = u32::from_le_bytes([e[8], e[9], e[10], e[11]]);
        if e[2] == 0 && app.is_none() { app = Some(off); }
        end = end.max(off.saturating_add(size));
    }
    (app, end)
}

/// ZIP in flashbare Teile zerlegen
pub fn firmware_from_zip(bytes: &[u8]) -> Result<ZipFirmware, String> {
    let files = read_zip(bytes)?;
    let mut boot = None;
    let mut table = None;
    let mut app = None;
    for (name, data) in files {
        let base = name.rsplit('/').next().unwrap_or(&name).to_ascii_lowercase();
        if !base.ends_with(".bin") { continue; } // ReadMe.txt usw.
        if data.len() >= 2 && data[0] == 0xAA && data[1] == 0x50 || base.contains("partition") {
            table = Some((name, data));
        } else if base.contains("boot") && !base.contains("app") {
            boot = Some((name, data));
        } else if data.first() == Some(&0xE9) {
            if app.is_some() { return Err("zip: more than one firmware file".into()); }
            app = Some((name, data));
        } else {
            return Err(format!("zip: unknown part {}", name));
        }
    }
    let (app_name, app_data) = app.ok_or("zip: no firmware file")?;
    let chip_id = chip_of(&app_data).or_else(|| boot.as_ref().and_then(|(_, d)| chip_of(d)));
    if let Some((_, d)) = &boot {
        if let (Some(a), Some(b)) = (chip_of(&app_data), chip_of(d)) {
            if a != b { return Err("zip: bootloader and firmware are for different chips".into()); }
        }
    }
    let (app_off, needs) = table.as_ref().map(|(_, d)| partition_info(d)).unwrap_or((None, 0));
    let mut parts = Vec::new();
    if let Some((name, data)) = boot {
        // ESP32 (Kennung 0): Bootloader bei 0x1000, alle neueren Chips bei 0x0
        let off = if chip_id == Some(0) { 0x1000 } else { 0x0 };
        parts.push(Part { name, role: "bootloader", offset: off, data });
    }
    if let Some((name, data)) = table {
        parts.push(Part { name, role: "partitions", offset: 0x8000, data });
    }
    let app_len = app_data.len() as u32;
    parts.push(Part { name: app_name, role: "app", offset: app_off.unwrap_or(0x10000), data: app_data });
    let needs_flash = needs.max(app_off.unwrap_or(0x10000) + app_len);
    Ok(ZipFirmware { parts, chip_id, needs_flash })
}

/// Lesbare Kennung wie "GrblHAL 1.1f" oder "FluidNC v3.9.1" im Programm finden
pub fn find_version(app: &[u8]) -> String {
    for pat in [&b"GrblHAL "[..], &b"FluidNC v"[..], &b"Grbl "[..]] {
        if let Some(i) = app.windows(pat.len()).position(|w| w == pat) {
            let s: String = app[i..].iter().take(24).take_while(|&&c| (32..127).contains(&c) && c != b'[').map(|&c| c as char).collect();
            return s.trim().to_string();
        }
    }
    String::new()
}

/// Steht der erwartete Board-Name (z. B. "MKS DLC32 MAX") im Programm?
pub fn contains_text(app: &[u8], text: &str) -> bool {
    !text.is_empty() && app.windows(text.len()).any(|w| w == text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// kleine ZIP bauen (gespeichert oder deflate) – wie sie der Web Builder liefert
    fn make_zip(files: &[(&str, &[u8], bool)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data, deflate) in files {
            let comp = if *deflate {
                let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                e.write_all(data).unwrap();
                e.finish().unwrap()
            } else { data.to_vec() };
            let method: u16 = if *deflate { 8 } else { 0 };
            let local = out.len() as u32;
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0]);
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&[0; 8]); // Zeit, Datum, CRC (wird hier nicht geprüft)
            out.extend_from_slice(&(comp.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&comp);
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&[20, 0, 20, 0, 0, 0]);
            central.extend_from_slice(&method.to_le_bytes());
            central.extend_from_slice(&[0; 8]);
            central.extend_from_slice(&(comp.len() as u32).to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0; 12]); // Extra, Kommentar, Disk, Attribute
            central.extend_from_slice(&local.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let cd = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    fn esp_image(chip: u16, len: usize, text: &str) -> Vec<u8> {
        let mut v = vec![0u8; len];
        v[0] = 0xE9;
        v[12..14].copy_from_slice(&chip.to_le_bytes());
        v[100..100 + text.len()].copy_from_slice(text.as_bytes());
        v
    }

    fn table(entries: &[(u8, u32, u32)]) -> Vec<u8> {
        let mut t = Vec::new();
        for (ty, off, size) in entries {
            let mut e = vec![0xAA, 0x50, *ty, 0];
            e.extend_from_slice(&off.to_le_bytes());
            e.extend_from_slice(&size.to_le_bytes());
            e.extend_from_slice(&[0; 20]);
            t.extend_from_slice(&e);
        }
        t.resize(3072, 0xFF);
        t
    }

    #[test]
    fn web_builder_zip_esp32s3() {
        let boot = esp_image(9, 19504, "boot");
        let app = esp_image(9, 200_000, "GrblHAL 1.1f ['$' or '$HELP' for help] MKS DLC32 MAX 1.0");
        let tab = table(&[(1, 0x9000, 0x6000), (0, 0x10000, 0x300000), (1, 0x311000, 0x4ef000)]);
        let zip = make_zip(&[("firmware.bin", &app, true), ("bootloader.bin", &boot, true), ("partitions.bin", &tab, false), ("ReadMe.txt", b"Flash adresses", false)]);
        let fw = firmware_from_zip(&zip).unwrap();
        let o: Vec<(&str, u32)> = fw.parts.iter().map(|p| (p.role, p.offset)).collect();
        assert_eq!(o, vec![("bootloader", 0x0), ("partitions", 0x8000), ("app", 0x10000)]);
        assert_eq!(fw.chip_id, Some(9));
        assert_eq!(fw.needs_flash, 0x800000);
        assert_eq!(fw.parts[2].data, app);
        assert_eq!(find_version(&fw.parts[2].data), "GrblHAL 1.1f");
        assert!(contains_text(&fw.parts[2].data, "MKS DLC32 MAX"));
        assert!(!contains_text(&fw.parts[2].data, "MKS DLC32 2.0"));
    }

    /// Echte Datei prüfen: CNC_FW_ZIP=/pfad/firmware.zip cargo test real_zip -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_zip() {
        let path = std::env::var("CNC_FW_ZIP").expect("CNC_FW_ZIP setzen");
        let fw = firmware_from_zip(&std::fs::read(path).unwrap()).unwrap();
        for p in &fw.parts { println!("{:<16} {:<10} 0x{:06x} {} Bytes", p.name, p.role, p.offset, p.data.len()); }
        let app = &fw.parts.last().unwrap().data;
        println!("chip={:?} needs={} MB version={:?} MAX={}", fw.chip_id, fw.needs_flash >> 20, find_version(app), contains_text(app, "MKS DLC32 MAX"));
    }

    #[test]
    fn esp32_bootloader_at_0x1000() {
        let zip = make_zip(&[("bootloader.bin", &esp_image(0, 4000, "b"), false), ("firmware.bin", &esp_image(0, 5000, "GrblHAL 1.1f"), false)]);
        let fw = firmware_from_zip(&zip).unwrap();
        assert_eq!(fw.parts[0].offset, 0x1000);
        assert_eq!(fw.parts[1].offset, 0x10000);
    }

    #[test]
    fn rejects_mixed_chips_and_missing_app() {
        let zip = make_zip(&[("bootloader.bin", &esp_image(0, 4000, "b"), false), ("firmware.bin", &esp_image(9, 5000, "x"), false)]);
        assert!(firmware_from_zip(&zip).unwrap_err().contains("different chips"));
        let zip = make_zip(&[("ReadMe.txt", b"hi", false)]);
        assert!(firmware_from_zip(&zip).unwrap_err().contains("no firmware"));
        assert!(read_zip(b"not a zip at all, sorry").is_err());
    }
}
