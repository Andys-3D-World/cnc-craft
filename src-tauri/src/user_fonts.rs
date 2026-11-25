//! Eigene Schriften des Nutzers (dauerhaft)
//!
//! Liegen im App-Datenordner unter „fonts/“: je Schrift eine Datei <Kennung>.font und dazu ein Eintrag in index.json.
//! Die Kennung ist eine Prüfsumme des Inhalts – Dateinamen aus fremden Dateien kommen nie auf die Platte,
//! und gelesen oder gelöscht wird nur, was im Verzeichnis steht.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const MAX_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_FONTS: usize = 500;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct UserFont {
    pub id: String,
    pub name: String,
    pub alias: String,
    pub size: usize,
}

fn dir_of(base: &Path) -> PathBuf { base.join("fonts") }
fn file_of(base: &Path, id: &str) -> PathBuf { dir_of(base).join(format!("{id}.font")) }

/// 64-Bit-Prüfsumme (FNV-1a) plus Länge – reicht, um gleiche Dateien zu erkennen
pub fn id_for(data: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in data { h ^= *b as u64; h = h.wrapping_mul(0x0100_0000_01b3); }
    format!("{h:016x}{:x}", data.len())
}

/// Schrift erkennen: TrueType/OpenType wird wirklich gelesen, WOFF an der Kennung
pub fn looks_like_font(data: &[u8]) -> bool {
    if data.len() < 100 { return false; }
    if &data[..4] == b"wOFF" || &data[..4] == b"wOF2" { return true; }
    ttf_parser::Face::parse(data, 0).is_ok()
}

fn clean(s: &str) -> String { s.chars().filter(|c| !c.is_control()).take(80).collect::<String>().trim().to_string() }

pub fn list(base: &Path) -> Vec<UserFont> {
    let v: Vec<UserFont> = fs::read(dir_of(base).join("index.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    v.into_iter().filter(|f| f.id.len() < 64 && f.id.chars().all(|c| c.is_ascii_hexdigit()) && file_of(base, &f.id).is_file()).collect()
}

fn write_index(base: &Path, v: &[UserFont]) -> Result<(), String> {
    let p = dir_of(base).join("index.json");
    let tmp = dir_of(base).join("index.json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if p.exists() { let _ = fs::remove_file(&p); }
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Schrift speichern. Dieselbe Datei noch einmal: der vorhandene Eintrag kommt zurück
pub fn add(base: &Path, name: &str, alias: &str, data: &[u8]) -> Result<UserFont, String> {
    if data.len() > MAX_BYTES { return Err("too-big".into()); }
    if !looks_like_font(data) { return Err("no-font".into()); }
    let id = id_for(data);
    let mut v = list(base);
    if let Some(f) = v.iter().find(|f| f.id == id) { return Ok(f.clone()); }
    if v.len() >= MAX_FONTS { return Err("too-many".into()); }
    fs::create_dir_all(dir_of(base)).map_err(|e| e.to_string())?;
    let mut name = clean(name);
    if name.is_empty() { name = "Font".into(); }
    // gleicher Name, andere Datei: durchzählen
    let first = name.clone();
    let mut n = 2;
    while v.iter().any(|f| f.name.eq_ignore_ascii_case(&name)) { name = format!("{first} {n}"); n += 1; }
    fs::write(file_of(base, &id), data).map_err(|e| e.to_string())?;
    let f = UserFont { id, name, alias: clean(alias), size: data.len() };
    v.push(f.clone());
    write_index(base, &v)?;
    Ok(f)
}

pub fn read(base: &Path, id: &str) -> Result<Vec<u8>, String> {
    if !list(base).iter().any(|f| f.id == id) { return Err("unknown".into()); }
    fs::read(file_of(base, id)).map_err(|e| e.to_string())
}

pub fn remove(base: &Path, id: &str) -> Result<(), String> {
    let mut v = list(base);
    let n = v.len();
    v.retain(|f| f.id != id);
    if v.len() == n { return Err("unknown".into()); }
    write_index(base, &v)?;
    let _ = fs::remove_file(file_of(base, id));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cncc-userfonts-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn lobster() -> Vec<u8> { fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/fonts/lobster/Lobster-Regular.ttf")).unwrap() }

    #[test]
    fn keeps_reads_and_removes_a_font() {
        let d = tmp("keep");
        let data = lobster();
        let f = add(&d, "Lobster", "Lobster-Regular", &data).unwrap();
        assert_eq!(list(&d), vec![f.clone()]);
        assert_eq!(read(&d, &f.id).unwrap(), data);
        // dieselbe Datei kommt nicht doppelt
        assert_eq!(add(&d, "Anders", "x", &data).unwrap(), f);
        assert_eq!(list(&d).len(), 1);
        remove(&d, &f.id).unwrap();
        assert!(list(&d).is_empty());
        assert!(read(&d, &f.id).is_err());
        assert!(remove(&d, &f.id).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn refuses_files_that_are_not_fonts_and_foreign_ids() {
        let d = tmp("bad");
        assert_eq!(add(&d, "x", "x", &vec![0u8; 500]).unwrap_err(), "no-font");
        assert_eq!(add(&d, "x", "x", b"short").unwrap_err(), "no-font");
        assert_eq!(add(&d, "x", "x", &vec![0u8; MAX_BYTES + 1]).unwrap_err(), "too-big");
        fs::write(d.join("secret.font"), b"geheim").unwrap();
        for id in ["../secret", "secret", "", "..", "/etc/passwd"] { assert!(read(&d, id).is_err(), "{id}"); assert!(remove(&d, id).is_err(), "{id}"); }
        assert!(d.join("secret.font").is_file());
        // gefälschtes Verzeichnis: fremde Kennungen fallen heraus
        fs::create_dir_all(dir_of(&d)).unwrap();
        fs::write(dir_of(&d).join("index.json"), r#"[{"id":"../../secret","name":"a","alias":"b","size":1}]"#).unwrap();
        assert!(list(&d).is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn same_name_is_counted_and_control_characters_are_dropped() {
        let d = tmp("name");
        let a = lobster();
        let b = fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/fonts/anton/Anton-Regular.ttf")).unwrap();
        assert_eq!(add(&d, "My\nFont", "a", &a).unwrap().name, "MyFont");
        assert_eq!(add(&d, "myfont", "b", &b).unwrap().name, "myfont 2");
        let _ = fs::remove_dir_all(&d);
    }
}
