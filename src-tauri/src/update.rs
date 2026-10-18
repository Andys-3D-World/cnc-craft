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

/// Lädt und installiert das Update aus `manifest` (…/latest.json). Rückgabe: installierte Version,
/// leer = nichts Neueres gefunden.
#[tauri::command]
pub async fn update_install(app: AppHandle, manifest: String) -> Result<String, String> {
    if !manifest.starts_with(RELEASE_PREFIX) || !manifest.ends_with("/latest.json") || manifest.contains("..") {
        return Err("bad-url".into());
    }
    let url = tauri::Url::parse(&manifest).map_err(|e| e.to_string())?;
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

/// Neu starten nach dem Update – vorher einen laufenden Job sicher anhalten
#[tauri::command]
pub fn update_restart(app: AppHandle) {
    crate::close_current();
    app.restart();
}
