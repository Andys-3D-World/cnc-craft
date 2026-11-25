//! ZULETZT BENUTZTE PROJEKTE (Startseite)
//!
//! Die Oberfläche darf nur Dateien lesen und schreiben, die im Dialog gewählt wurden. Damit ein Projekt beim nächsten
//! Start wieder aufgeht, merkt sich das Programm HIER (nicht die Oberfläche) die Pfade:
//!   - hinein kommt nur ein Pfad auf eine .cncc-Datei, die in dieser Sitzung freigegeben ist (also im Dialog gewählt wurde)
//!   - wieder freigegeben wird nur ein Pfad, der in dieser Liste steht, und nur diese eine Datei
//! Dieses Modul kennt nur Dateien (kein Tauri), damit es sich testen lässt; die Befehle stehen in lib.rs.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

pub const FILE: &str = "recent.json";
pub const KEEP: usize = 12;
/// Vorschaubild: höchstens so viele Zeichen (data:image/…;base64,…)
pub const MAX_THUMB: usize = 80_000;
const MAX_FILE: u64 = 4 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Recent {
    pub path: String,
    pub used: u64,
    #[serde(default)]
    pub thumb: String,
}

/// Nur absolute Pfade auf .cncc-Dateien
pub fn valid_path(p: &str) -> bool {
    let path = Path::new(p);
    !p.is_empty()
        && p.len() < 4096
        && !p.contains('\0')
        && path.is_absolute()
        && path.extension().map(|e| e.eq_ignore_ascii_case("cncc")).unwrap_or(false)
}

/// Nur ein eingebettetes JPEG/PNG – alles andere wird verworfen
pub fn clean_thumb(t: &str) -> String {
    let ok = ["data:image/jpeg;base64,", "data:image/png;base64,"]
        .iter()
        .any(|h| t.strip_prefix(h).map(|b| b.bytes().all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c))).unwrap_or(false));
    if ok && t.len() <= MAX_THUMB { t.to_string() } else { String::new() }
}

pub fn read(dir: &Path) -> Vec<Recent> {
    let p = dir.join(FILE);
    if fs::metadata(&p).map(|m| m.len() > MAX_FILE).unwrap_or(true) {
        return Vec::new();
    }
    let list: Vec<Recent> = fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    list.into_iter()
        .filter(|r| valid_path(&r.path))
        .map(|r| Recent { thumb: clean_thumb(&r.thumb), ..r })
        .take(KEEP)
        .collect()
}

fn write(dir: &Path, list: &[Recent]) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let tmp = dir.join("recent.json.tmp");
    fs::write(&tmp, serde_json::to_string(list).unwrap_or_else(|_| "[]".into()))?;
    let p = dir.join(FILE);
    if p.exists() {
        let _ = fs::remove_file(&p);
    }
    fs::rename(tmp, p)
}

/// Projekt nach vorn (neu oder wieder benutzt)
pub fn add(dir: &Path, path: &str, used: u64, thumb: &str) -> Result<(), String> {
    if !valid_path(path) {
        return Err("invalid path".into());
    }
    let mut list = read(dir);
    let thumb = clean_thumb(thumb);
    let old = list.iter().find(|r| r.path == path).map(|r| r.thumb.clone()).unwrap_or_default();
    list.retain(|r| r.path != path);
    list.insert(0, Recent { path: path.to_string(), used, thumb: if thumb.is_empty() { old } else { thumb } });
    list.truncate(KEEP);
    write(dir, &list).map_err(|e| e.to_string())
}

pub fn contains(dir: &Path, path: &str) -> bool {
    valid_path(path) && read(dir).iter().any(|r| r.path == path)
}

/// Aus der Liste nehmen (die Datei selbst bleibt); None = ganze Liste leeren
pub fn remove(dir: &Path, path: Option<&str>) -> Result<(), String> {
    let mut list = read(dir);
    match path {
        Some(p) => list.retain(|r| r.path != p),
        None => list.clear(),
    }
    write(dir, &list).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_rules() {
        let d = std::env::temp_dir().join(format!("cnc-recent-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        let base = std::env::temp_dir();
        let f = |n: &str| base.join(n).to_string_lossy().to_string();
        assert!(read(&d).is_empty());
        for k in 0..15 {
            add(&d, &f(&format!("p{k}.cncc")), k, "data:image/jpeg;base64,QUJD").unwrap();
        }
        let l = read(&d);
        assert_eq!(l.len(), KEEP);
        assert_eq!(l[0].path, f("p14.cncc"));
        assert!(contains(&d, &f("p14.cncc")) && !contains(&d, &f("p0.cncc")));
        // noch einmal benutzt: nach vorn, Bild bleibt, wenn keins mitkommt
        add(&d, &f("p5.cncc"), 99, "").unwrap();
        let l = read(&d);
        assert_eq!((l[0].path.as_str(), l[0].used, l[0].thumb.as_str()), (f("p5.cncc").as_str(), 99, "data:image/jpeg;base64,QUJD"));
        assert_eq!(l.len(), KEEP);
        remove(&d, Some(&f("p5.cncc"))).unwrap();
        assert!(!contains(&d, &f("p5.cncc")));
        // nur .cncc mit vollem Pfad, nur echte Bilder
        for bad in ["", "x.cncc", "/etc/passwd", "/tmp/a.cncc\0b", "relative/p.cncc"] {
            assert!(add(&d, bad, 1, "").is_err(), "{bad:?}");
        }
        assert_eq!(clean_thumb("javascript:alert(1)"), "");
        assert_eq!(clean_thumb("data:image/png;base64,AA\"onerror=x"), "");
        assert_eq!(clean_thumb(&format!("data:image/png;base64,{}", "A".repeat(MAX_THUMB))), "");
        // kaputte oder fremde Einträge in der Datei werden nicht übernommen
        fs::write(d.join(FILE), r#"[{"path":"/etc/passwd","used":1},{"path":"nope"}]"#).unwrap();
        assert!(read(&d).is_empty());
        fs::write(d.join(FILE), "kaputt").unwrap();
        assert!(read(&d).is_empty());
        remove(&d, None).unwrap();
        let _ = fs::remove_dir_all(&d);
    }
}
