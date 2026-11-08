//! UPDATE AUS DER APP HERAUS (tauri-plugin-updater)
//!
//! Die Oberfläche sucht das passende Release selbst (update/updater.ts, auch Beta-Versionen) und
//! gibt hier die Adresse der Datei latest.json aus diesem Release weiter. Das Plugin lädt das Update,
//! prüft die Unterschrift (öffentlicher Schlüssel in tauri.conf.json → plugins.updater.pubkey) und
//! installiert es:
//!   - macOS: ersetzt CNC Craft.app (ohne „aus dem Internet“-Markierung → kein „Trotzdem öffnen“)
//!   - Windows: startet das Setup ohne Rückfragen und beendet die App
//!   - Linux: ersetzt die .AppImage
//! Danach startet update_restart die App neu.

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

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

/// Lädt und installiert das Update aus `manifest` (…/latest.json). Rückgabe: installierte Version,
/// leer = nichts Neueres gefunden.
#[tauri::command]
pub async fn update_install(app: AppHandle, manifest: String) -> Result<String, String> {
    let url = manifest_url(&manifest).ok_or_else(|| "bad-url".to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(String::new());
    };
    let version = update.version.clone();
    let h = app.clone();
    let mut done = 0u64;
    update
        .download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                let _ = h.emit("update-progress", Progress { done, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(version)
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
}
