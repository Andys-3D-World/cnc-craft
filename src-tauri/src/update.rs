//! UPDATE AUS DER APP HERAUS (tauri-plugin-updater)
//!
//! Die Oberfläche sucht das passende Release selbst (update/updater.ts, auch Beta-Versionen) und
//! gibt hier die Adresse der Datei latest.json aus diesem Release weiter. Das Plugin lädt das Update,
//! prüft die Unterschrift (öffentlicher Schlüssel in tauri.conf.json → plugins.updater.pubkey) und
//! installiert es:
//!   - macOS: ersetzt CNC Craft.app (ohne „aus dem Internet“-Markierung → kein „Trotzdem öffnen“)
//!   - Windows: startet das Setup ohne Rückfragen und beendet die App
//!   - Linux: ersetzt die .AppImage – vorher bleibt die bisherige Version als Kopie daneben liegen
//!     („CNC.Craft_<alte Version>_previous.AppImage“), damit man zur funktionierenden Version zurück kann.
//!     Es bleibt nur die letzte Kopie, ältere eigene Kopien werden nach dem Update entfernt.
//!
//! Danach startet update_restart die App neu.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Name der Kopie: Präfix + alte Version + Endung. Nur eigene Dateien mit diesem Muster werden je entfernt.
const COPY_PREFIX: &str = "CNC.Craft_";
const COPY_SUFFIX: &str = "_previous.AppImage";

/// Ergebnis für die Oberfläche: installierte Version (leer = nichts Neueres) und Name der Kopie (leer = keine)
#[derive(Serialize)]
pub struct Installed {
    version: String,
    kept: String,
}

/// Nur Dateien aus den Releases des eigenen Repositorys (die Unterschrift wird zusätzlich geprüft)
const RELEASE_PREFIX: &str = "https://github.com/Andys-3D-World/cnc-craft/releases/download/";

#[derive(Clone, Serialize)]
struct Progress {
    done: u64,
    total: Option<u64>,
}

/// Prüft die Adresse erst NACH dem Zerlegen: „%2e%2e“ wird dabei zu „..“ aufgelöst und darf nicht aus den Releases führen
fn manifest_url(manifest: &str) -> Option<tauri::Url> {
    if !manifest.starts_with(RELEASE_PREFIX) || manifest.contains("..") || manifest.contains('%') {
        return None;
    }
    let url = tauri::Url::parse(manifest).ok()?;
    let ok = url.as_str().starts_with(RELEASE_PREFIX)
        && url.path().ends_with("/latest.json")
        && url.query().is_none()
        && url.fragment().is_none();
    ok.then_some(url)
}

/// Name der Kopie für Version `version` (nur Buchstaben, Ziffern, Punkt und Minus – kein Pfad möglich)
fn copy_name(version: &str) -> String {
    let v: String = version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
        .collect();
    format!("{COPY_PREFIX}{v}{COPY_SUFFIX}")
}

/// Gleiche Datei? (über den echten Pfad; lässt sich einer nicht auflösen, gilt „gleich“ – dann wird nichts angefasst)
fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b || a.file_name() == b.file_name(),
    }
}

/// Legt eine Kopie von `current` (die laufende .AppImage) als „CNC.Craft_<version>_previous.AppImage“
/// daneben. Erst unter einem versteckten Namen kopieren, dann umbenennen – eine halbe Kopie sieht nie
/// wie eine fertige aus. `None`: läuft gerade selbst als Kopie, dann nichts tun (sonst Kopie auf sich selbst).
fn keep_copy(current: &Path, version: &str) -> std::io::Result<Option<PathBuf>> {
    let dir = current
        .parent()
        .ok_or_else(|| std::io::Error::other("no folder"))?;
    let name = copy_name(version);
    let dst = dir.join(&name);
    if dst.exists() && same_file(&dst, current) {
        return Ok(None);
    }
    let part = dir.join(format!(".{name}.part"));
    if let Err(e) = std::fs::copy(current, &part).and_then(|_| std::fs::rename(&part, &dst)) {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    Ok(Some(dst))
}

/// Entfernt ältere eigene Kopien im Ordner – nie `keep`, nie die laufende Datei, nie fremde Dateien oder Links
fn remove_older_copies(dir: &Path, keep: &Path, running: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
        if !name.starts_with(COPY_PREFIX) || !name.ends_with(COPY_SUFFIX) {
            continue;
        }
        if !e.file_type().map(|t| t.is_file()).unwrap_or(false) || same_file(&p, keep) || same_file(&p, running) {
            continue;
        }
        let _ = std::fs::remove_file(&p);
    }
}

/// Pfad der laufenden .AppImage (wie beim Updater-Plugin aus `APPIMAGE`). `None`: keine AppImage
/// (.deb/.rpm, macOS, Windows) – dann gibt es keine Kopie.
#[cfg(target_os = "linux")]
fn running_appimage(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.env().appimage.map(PathBuf::from)
}

#[cfg(not(target_os = "linux"))]
fn running_appimage(_app: &AppHandle) -> Option<PathBuf> {
    None
}

/// Kopie der laufenden AppImage anlegen. Rückgabe: (Kopie, laufende Datei), `None` = keine Kopie nötig
fn keep_running_appimage(app: &AppHandle) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let Some(running) = running_appimage(app) else { return Ok(None) };
    let old = app.package_info().version.to_string();
    let kept = keep_copy(&running, &old).map_err(|e| format!("keep-copy: {e}"))?;
    Ok(kept.map(|k| (k, running)))
}

/// Lädt und installiert das Update aus `manifest` (…/latest.json). Bei einer AppImage bleibt die
/// bisherige Version als Kopie daneben. Klappt die Kopie nicht, wird nichts installiert.
#[tauri::command]
pub async fn update_install(app: AppHandle, manifest: String) -> Result<Installed, String> {
    let url = manifest_url(&manifest).ok_or_else(|| "bad-url".to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(Installed { version: String::new(), kept: String::new() });
    };
    let version = update.version.clone();
    let h = app.clone();
    let mut done = 0u64;
    let bytes = update
        .download(
            move |chunk, total| {
                done += chunk as u64;
                let _ = h.emit("update-progress", Progress { done, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // erst nach dem Download sichern: ein abgebrochener Download lässt alles wie es war
    let kept = keep_running_appimage(&app)?;
    if let Err(e) = update.install(&bytes) {
        // nichts installiert (das Plugin stellt die alte Datei wieder her) → die frische Kopie ist überflüssig.
        // Fehlt die laufende Datei trotzdem, bleibt die Kopie – sie ist dann die einzige funktionierende Version.
        if let Some((k, running)) = &kept {
            if running.is_file() {
                let _ = std::fs::remove_file(k);
            }
        }
        return Err(e.to_string());
    }
    let mut kept_name = String::new();
    if let Some((k, running)) = &kept {
        if let Some(dir) = k.parent() {
            remove_older_copies(dir, k, running);
        }
        kept_name = k.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    }
    Ok(Installed { version, kept: kept_name })
}

/// Neu starten nach dem Update – vorher laufende Jobs aller Maschinen sicher anhalten
#[tauri::command]
pub fn update_restart(app: AppHandle) {
    crate::close_all();
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_only_from_own_releases() {
        let ok = "https://github.com/Andys-3D-World/cnc-craft/releases/download/v0.4.3/latest.json";
        assert!(manifest_url(ok).is_some());
        assert!(manifest_url("https://github.com/Andys-3D-World/cnc-craft/releases/download/v1/../../../other/latest.json").is_none());
        assert!(manifest_url("https://github.com/Andys-3D-World/cnc-craft/releases/download/%2e%2e/%2e%2e/x/latest.json").is_none());
        assert!(manifest_url("https://github.com/Andys-3D-World/cnc-craft/releases/download/v1/latest.json?x=1").is_none());
        assert!(manifest_url("https://evil.example/Andys-3D-World/cnc-craft/releases/download/v1/latest.json").is_none());
        assert!(manifest_url("https://github.com/Andys-3D-World/cnc-craft/releases/download/v1/other.json").is_none());
    }

    /// Eigener leerer Ordner je Test (ohne Zusatz-Bibliothek)
    fn test_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cnc-craft-update-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn copy_name_has_version_and_no_path() {
        assert_eq!(copy_name("0.4.4"), "CNC.Craft_0.4.4_previous.AppImage");
        assert_eq!(copy_name("0.5.0-beta.1"), "CNC.Craft_0.5.0-beta.1_previous.AppImage");
        assert!(!copy_name("1/../../x").contains('/'));
    }

    #[test]
    fn keeps_a_runnable_copy_next_to_the_appimage() {
        let d = test_dir("keep");
        let running = d.join("CNC.Craft_0.4.4_amd64.AppImage");
        std::fs::write(&running, b"old version").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&running, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let kept = keep_copy(&running, "0.4.4").unwrap().unwrap();
        assert_eq!(kept, d.join("CNC.Craft_0.4.4_previous.AppImage"));
        assert_eq!(std::fs::read(&kept).unwrap(), b"old version");
        assert_eq!(std::fs::read(&running).unwrap(), b"old version"); // Original unverändert
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&kept).unwrap().permissions().mode() & 0o111, 0o111, "copy must stay executable");
        }
        assert!(!d.join(".CNC.Craft_0.4.4_previous.AppImage.part").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn never_copies_the_running_copy_onto_itself() {
        let d = test_dir("self");
        // gestartet wurde die Kopie selbst – sie darf nicht leer überschrieben werden
        let running = d.join("CNC.Craft_0.4.4_previous.AppImage");
        std::fs::write(&running, b"still here").unwrap();
        assert!(keep_copy(&running, "0.4.4").unwrap().is_none());
        assert_eq!(std::fs::read(&running).unwrap(), b"still here");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn removes_only_older_own_copies() {
        let d = test_dir("clean");
        let running = d.join("CNC.Craft_0.4.4_amd64.AppImage");
        let keep = d.join("CNC.Craft_0.4.4_previous.AppImage");
        let older = d.join("CNC.Craft_0.4.2_previous.AppImage");
        let other = d.join("Other_1.0_previous.AppImage");
        let notes = d.join("notes.txt");
        for f in [&running, &keep, &older, &other, &notes] {
            std::fs::write(f, b"x").unwrap();
        }
        remove_older_copies(&d, &keep, &running);
        assert!(!older.exists());
        for f in [&running, &keep, &other, &notes] {
            assert!(f.exists(), "{} must stay", f.display());
        }
        // läuft eine ältere Kopie gerade selbst, bleibt sie
        let running_old = d.join("CNC.Craft_0.4.3_previous.AppImage");
        std::fs::write(&running_old, b"x").unwrap();
        remove_older_copies(&d, &keep, &running_old);
        assert!(running_old.exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}
