//! EINSTELLUNGEN ALS DATEI SICHERN (zusätzlich zum Speicher der Oberfläche)
//!
//! Die Oberfläche speichert alles (Werkzeuge, Laser-Ebenen, Plasma-Schnitte, Maschine, Sprache …)
//! im localStorage des Webview. Der bleibt bei Updates normalerweise erhalten – aber nicht, wenn
//! sich die "Herkunft" der Seite ändert (z. B. anderes Tauri-Schema, `tauri dev` gegen fertige App)
//! oder der Webview-Speicher gelöscht wird. Darum spiegelt die Oberfläche alle Einstellungen
//! zusätzlich in eine Datei im App-Datenordner (bleibt bei Updates erhalten):
//!
//!   macOS:   ~/Library/Application Support/com.andys3dworld.cnc-craft/
//!   Windows: %APPDATA%\com.andys3dworld.cnc-craft\
//!   Linux:   ~/.local/share/com.andys3dworld.cnc-craft/
//!
//!   settings.json                     – aktueller Stand (wird sicher geschrieben: erst .tmp, dann umbenannt)
//!   backups/settings-JJJJ-MM-TT.json  – eine Sicherung pro Tag, die letzten 14 Tage
//!
//! Dieses Modul kennt nur Dateien (kein Tauri), damit es sich einfach testen lässt.
//! Die Befehle für die Oberfläche stehen in lib.rs (settings_store_read / settings_store_write).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAIN_FILE: &str = "settings.json";
pub const BACKUP_DIR: &str = "backups";
pub const KEEP_BACKUPS: usize = 14;
/// Schutz vor Unsinn: so groß wird eine Einstellungsdatei nie
pub const MAX_BYTES: usize = 32 * 1024 * 1024;

/// Datum (UTC) als "JJJJ-MM-TT" – ohne zusätzliche Bibliothek
pub fn date_string(secs: u64) -> String {
    // Tage seit 1970-01-01 -> Kalenderdatum (Algorithmus von Howard Hinnant)
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Datei sicher schreiben: erst daneben als .tmp, dann umbenennen (kein halber Stand bei Absturz)
fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data)?;
    // Windows: rename überschreibt keine vorhandene Datei in jedem Fall zuverlässig
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path)
}

/// Aktuellen Stand speichern + Tages-Sicherung anlegen + alte Sicherungen aufräumen
pub fn write_settings(dir: &Path, data: &str) -> io::Result<()> {
    write_settings_at(dir, data, now_secs())
}

pub fn write_settings_at(dir: &Path, data: &str, secs: u64) -> io::Result<()> {
    if data.len() > MAX_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "settings too large"));
    }
    if data.trim().is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "settings empty"));
    }
    fs::create_dir_all(dir)?;
    write_atomic(&dir.join(MAIN_FILE), data.as_bytes())?;

    // eine Sicherung pro Tag (die erste des Tages bleibt – das ist der Stand vom Tagesanfang)
    let bdir = dir.join(BACKUP_DIR);
    fs::create_dir_all(&bdir)?;
    let today = bdir.join(format!("settings-{}.json", date_string(secs)));
    if !today.exists() {
        write_atomic(&today, data.as_bytes())?;
    }
    prune_backups(&bdir, KEEP_BACKUPS)?;
    Ok(())
}

/// Sicherungen, neueste zuerst
pub fn list_backups(bdir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = match fs::read_dir(bdir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("settings-") && n.ends_with(".json"))
                    .unwrap_or(false)
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    // Name enthält das Datum JJJJ-MM-TT -> Textsortierung = Datumssortierung
    v.sort();
    v.reverse();
    v
}

fn prune_backups(bdir: &Path, keep: usize) -> io::Result<()> {
    for old in list_backups(bdir).into_iter().skip(keep) {
        let _ = fs::remove_file(old);
    }
    Ok(())
}

fn read_limited(p: &Path) -> Option<String> {
    let meta = fs::metadata(p).ok()?;
    if meta.len() as usize > MAX_BYTES {
        return None;
    }
    fs::read_to_string(p).ok().filter(|s| !s.trim().is_empty())
}

/// Gespeicherten Stand lesen: (Hauptdatei, neueste Sicherungen – falls die Hauptdatei kaputt ist)
pub struct Stored {
    pub main: Option<String>,
    pub backups: Vec<String>,
}

pub fn read_settings(dir: &Path) -> Stored {
    let main = read_limited(&dir.join(MAIN_FILE));
    let backups = list_backups(&dir.join(BACKUP_DIR))
        .iter()
        .take(3)
        .filter_map(|p| read_limited(p))
        .collect();
    Stored { main, backups }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cnc-store-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn dates() {
        assert_eq!(date_string(0), "1970-01-01");
        assert_eq!(date_string(951_782_400), "2000-02-29");
        assert_eq!(date_string(1_792_108_800), "2026-10-16");
        assert_eq!(date_string(1_792_108_800 + 86_399), "2026-10-16");
    }

    #[test]
    fn write_read_and_backups() {
        let d = tmpdir("wr");
        assert!(read_settings(&d).main.is_none());
        write_settings_at(&d, "{\"a\":1}", 1_792_108_800).unwrap();
        write_settings_at(&d, "{\"a\":2}", 1_792_108_800 + 100).unwrap();
        let s = read_settings(&d);
        assert_eq!(s.main.as_deref(), Some("{\"a\":2}"));
        // Tages-Sicherung behält den ersten Stand des Tages
        assert_eq!(s.backups, vec!["{\"a\":1}".to_string()]);
        // 20 Tage -> nur 14 Sicherungen bleiben, neueste zuerst
        for i in 1..20u64 {
            write_settings_at(&d, &format!("{{\"day\":{}}}", i), 1_792_108_800 + i * 86_400).unwrap();
        }
        let b = list_backups(&d.join(BACKUP_DIR));
        assert_eq!(b.len(), KEEP_BACKUPS);
        assert!(b[0].to_string_lossy().ends_with("settings-2026-11-04.json"));
        assert_eq!(read_settings(&d).backups[0], "{\"day\":19}");
        assert!(!d.join("settings.json.tmp").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn rejects_empty() {
        let d = tmpdir("empty");
        assert!(write_settings_at(&d, "  ", 0).is_err());
        assert!(!d.join(MAIN_FILE).exists());
    }
}
