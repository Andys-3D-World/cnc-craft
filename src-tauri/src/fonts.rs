//! Systemschriften für das Text-Werkzeug
//!
//! Durchsucht die üblichen Schriftordner (macOS, Windows, Linux) nach .ttf/.otf/.ttc/.otc,
//! liest Familie, Schnitt, Gewicht und Kursiv aus der Schrift (ttf-parser) und gibt eine Liste
//! an die Oberfläche. Die Oberfläche lädt eine gewählte Schrift dann mit `font_data`.
//!
//! Sicherheit: `data` liefert nur Dateien, die vorher beim Durchsuchen gefunden wurden –
//! beliebige Pfade lassen sich darüber nicht lesen.
//! Schriftsammlungen (.ttc) kann der Browser nicht laden: daraus wird die gewünschte Schrift
//! als einzelne Schriftdatei herausgelöst.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Serialize, Clone, Debug)]
pub struct SysFont {
    pub family: String,
    pub style: String,
    pub weight: u16,
    pub italic: bool,
    pub path: String,
    pub index: u32,
}

/// Beim Durchsuchen gefundene Dateien (Pfad, Index in der Sammlung) – nur diese gibt `data` heraus
static ALLOWED: Mutex<Option<HashSet<(String, u32)>>> = Mutex::new(None);

/// Schriftordner des Betriebssystems (nur vorhandene)
pub fn font_dirs() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    if cfg!(target_os = "macos") {
        v.push("/System/Library/Fonts".into());
        v.push("/Library/Fonts".into());
        if let Some(h) = &home { v.push(h.join("Library/Fonts")); }
    } else if cfg!(target_os = "windows") {
        let win = std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| "C:\\Windows".into());
        v.push(win.join("Fonts"));
        if let Some(l) = std::env::var_os("LOCALAPPDATA") { v.push(PathBuf::from(l).join("Microsoft\\Windows\\Fonts")); }
    } else {
        v.push("/usr/share/fonts".into());
        v.push("/usr/local/share/fonts".into());
        if let Some(h) = &home {
            v.push(h.join(".local/share/fonts"));
            v.push(h.join(".fonts"));
        }
        if let Some(d) = std::env::var_os("XDG_DATA_HOME") { v.push(PathBuf::from(d).join("fonts")); }
    }
    v.into_iter().filter(|p| p.is_dir()).collect()
}

fn is_font_file(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("ttf" | "otf" | "ttc" | "otc")
    )
}

fn collect_files(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 6 { return; }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        // Ordner-Verknüpfungen nicht folgen (keine Endlosschleifen)
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() { collect_files(&p, depth + 1, out); }
        else if is_font_file(&p) { out.push(p); }
    }
}

/// Namen aus der name-Tabelle lesen, Englisch bevorzugt
fn name_of(face: &ttf_parser::Face, id: u16) -> Option<String> {
    let mut fallback = None;
    for n in face.names() {
        if n.name_id != id { continue; }
        let Some(s) = n.to_string() else { continue };
        let s = s.trim().to_string();
        if s.is_empty() { continue; }
        let english = (n.platform_id == ttf_parser::PlatformId::Windows && n.language_id == 0x0409)
            || (n.platform_id == ttf_parser::PlatformId::Macintosh && n.language_id == 0);
        if english { return Some(s); }
        if fallback.is_none() { fallback = Some(s); }
    }
    fallback
}

fn describe(data: &[u8], index: u32, path: &str) -> Option<SysFont> {
    let face = ttf_parser::Face::parse(data, index).ok()?;
    // 16/17 = typografische Familie/Schnitt (z. B. "Roboto" / "Light"), sonst 1/2
    let family = name_of(&face, 16).or_else(|| name_of(&face, 1))?;
    // Versteckte Systemschriften (macOS ".SF NS …") und Symbolschriften ohne Buchstaben weglassen
    if family.starts_with('.') || face.glyph_index('A').is_none() { return None; }
    let style = name_of(&face, 17).or_else(|| name_of(&face, 2)).unwrap_or_else(|| "Regular".into());
    Some(SysFont {
        family,
        style,
        weight: face.weight().to_number(),
        italic: face.is_italic() || face.is_oblique(),
        path: path.to_string(),
        index,
    })
}

/// Alle Systemschriften auflisten (sortiert nach Familie, dann Gewicht)
pub fn list() -> Vec<SysFont> {
    let mut files = Vec::new();
    for d in font_dirs() { collect_files(&d, 0, &mut files); }
    let mut out: Vec<SysFont> = Vec::new();
    let mut seen = HashSet::new();
    for f in files {
        let Ok(data) = std::fs::read(&f) else { continue };
        let path = f.to_string_lossy().to_string();
        let count = ttf_parser::fonts_in_collection(&data).unwrap_or(1).min(64);
        for i in 0..count {
            if let Some(sf) = describe(&data, i, &path) {
                // Gleiche Schrift in mehreren Ordnern nur einmal
                if seen.insert((sf.family.to_lowercase(), sf.style.to_lowercase())) { out.push(sf); }
            }
        }
    }
    out.sort_by(|a, b| {
        a.family.to_lowercase().cmp(&b.family.to_lowercase())
            .then(a.italic.cmp(&b.italic))
            .then(a.weight.cmp(&b.weight))
    });
    *ALLOWED.lock().unwrap() = Some(out.iter().map(|f| (f.path.clone(), f.index)).collect());
    out
}

/// Schriftdatei lesen – nur wenn sie vorher von `list` gefunden wurde. Sammlungen werden aufgeteilt.
pub fn data(path: &str, index: u32) -> Result<Vec<u8>, String> {
    let ok = ALLOWED.lock().unwrap().as_ref().is_some_and(|s| s.contains(&(path.to_string(), index)));
    if !ok { return Err("font not in system list".into()); }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.starts_with(b"ttcf") {
        return extract_from_collection(&bytes, index).ok_or_else(|| "broken font collection".into());
    }
    Ok(bytes)
}

fn be_u16(d: &[u8], o: usize) -> Option<u16> { Some(u16::from_be_bytes(d.get(o..o + 2)?.try_into().ok()?)) }
fn be_u32(d: &[u8], o: usize) -> Option<u32> { Some(u32::from_be_bytes(d.get(o..o + 4)?.try_into().ok()?)) }

/// Eine Schrift aus einer .ttc/.otc als eigenständige Schriftdatei herauslösen.
/// Kopf + Tabellenverzeichnis neu schreiben, die Tabellen selbst bleiben unverändert.
pub fn extract_from_collection(d: &[u8], index: u32) -> Option<Vec<u8>> {
    let num = be_u32(d, 8)?;
    if index >= num { return None; }
    let off = be_u32(d, 12 + 4 * index as usize)? as usize;
    let num_tables = be_u16(d, off + 4)? as usize;
    let header = d.get(off..off + 12)?;
    let dir_len = 12 + 16 * num_tables;
    let mut out = Vec::with_capacity(d.len().min(16 << 20));
    out.extend_from_slice(header);
    out.resize(dir_len, 0);
    for t in 0..num_tables {
        let rec = off + 12 + 16 * t;
        let tag = d.get(rec..rec + 4)?;
        let sum = be_u32(d, rec + 4)?;
        let toff = be_u32(d, rec + 8)? as usize;
        let tlen = be_u32(d, rec + 12)? as usize;
        let table = d.get(toff..toff.checked_add(tlen)?)?;
        let new_off = out.len() as u32;
        let r = 12 + 16 * t;
        out[r..r + 4].copy_from_slice(tag);
        out[r + 4..r + 8].copy_from_slice(&sum.to_be_bytes());
        out[r + 8..r + 12].copy_from_slice(&new_off.to_be_bytes());
        out[r + 12..r + 16].copy_from_slice(&(tlen as u32).to_be_bytes());
        out.extend_from_slice(table);
        while out.len() % 4 != 0 { out.push(0); }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Kleine Schriftdatei mit Tabellen (Inhalt egal, nur der Aufbau zählt), beginnt bei `base`
    fn sfnt(tables: &[(&[u8; 4], &[u8])], base: usize) -> Vec<u8> {
        let mut v = vec![0, 1, 0, 0];
        v.extend_from_slice(&(tables.len() as u16).to_be_bytes());
        v.extend_from_slice(&[0; 6]);
        let mut data = Vec::new();
        let start = base + 12 + 16 * tables.len();
        for (tag, body) in tables {
            v.extend_from_slice(*tag);
            v.extend_from_slice(&7u32.to_be_bytes());
            v.extend_from_slice(&((start + data.len()) as u32).to_be_bytes());
            v.extend_from_slice(&(body.len() as u32).to_be_bytes());
            data.extend_from_slice(body);
            while data.len() % 4 != 0 { data.push(0); }
        }
        v.extend_from_slice(&data);
        v
    }

    #[test]
    fn extracts_font_from_collection() {
        // Sammlung mit einer Schrift, die hinter dem 16-Byte-Kopf beginnt
        let font = sfnt(&[(b"head", b"HEADDATA"), (b"name", b"abc")], 16);
        let mut ttc = b"ttcf".to_vec();
        ttc.extend_from_slice(&[0, 1, 0, 0]);
        ttc.extend_from_slice(&1u32.to_be_bytes());
        ttc.extend_from_slice(&16u32.to_be_bytes());
        ttc.extend_from_slice(&font);

        let out = extract_from_collection(&ttc, 0).unwrap();
        assert_eq!(&out[0..4], &[0, 1, 0, 0]);
        assert_eq!(be_u16(&out, 4), Some(2));
        // Tabellen stehen jetzt direkt hinter dem Verzeichnis
        let first = be_u32(&out, 12 + 8).unwrap() as usize;
        assert_eq!(first, 12 + 32);
        assert_eq!(&out[first..first + 8], b"HEADDATA");
        let second = be_u32(&out, 28 + 8).unwrap() as usize;
        assert_eq!(&out[second..second + 3], b"abc");
        assert_eq!(second % 4, 0);
        // Index außerhalb / kaputte Daten
        assert!(extract_from_collection(&ttc, 1).is_none());
        assert!(extract_from_collection(&ttc[..30], 0).is_none());
    }

    #[test]
    fn only_listed_fonts_can_be_read() {
        assert!(data("/etc/passwd", 0).is_err());
    }

    #[test]
    fn font_extensions() {
        assert!(is_font_file(Path::new("/a/B.TTF")));
        assert!(is_font_file(Path::new("x.otc")));
        assert!(!is_font_file(Path::new("x.woff2")));
        assert!(!is_font_file(Path::new("fonts.dir")));
    }

    #[test]
    fn lists_system_fonts_when_present() {
        // Auf Rechnern mit Schriften: gefundene Schriften (auch aus Sammlungen) sind lesbar und gültig
        let all = list();
        let mut picks: Vec<&SysFont> = all.iter().take(1).collect();
        picks.extend(all.iter().find(|f| f.index > 0));
        for f in picks {
            let bytes = data(&f.path, f.index).unwrap();
            assert!(ttf_parser::Face::parse(&bytes, 0).is_ok(), "{} {}", f.path, f.index);
            assert!(!f.family.starts_with('.'));
        }
    }
}
