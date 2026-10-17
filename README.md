# CNC Craft

Open-Source-Programm für **Laser, CNC-Fräse und Plasma** – Design, CAM und Maschinensteuerung in einem
(Idee: LightBurn + Estlcam + OpenBuilds zusammen). Läuft auf macOS, Windows und Linux.

**Status: 0.2.2 Beta** – bitte testen, Fehler melden, und Maschinen zuerst ohne Werkstück / mit wenig Leistung ausprobieren.

## Was es kann

- Zeichnen, Import (SVG, DXF, PDF, PLT, Bilder, 3D-Modelle als STL, 3MF und STEP), Fräsbahnen mit Werkzeug-Bibliothek wie in Estlcam
- Laser-Ebenen wie in LightBurn, Plasma mit Schnittspalt, Anfahrbahn und Höhenregelung (THC)
- Bibliotheken für Fräswerkzeuge, Laser-Ebenen und Plasma-Schnitte – mit Export/Import und Komplett-Sicherung;
  alle Einstellungen werden zusätzlich als Datei gesichert und überstehen Updates
- Steuerungen: GRBL / grblHAL / FluidNC / Grbl_ESP32 (USB und WLAN), Marlin, Ruida (CO₂), K40 (M2 Nano)
- Spindel, Laser-Testschuss, Overrides 10–200 %, Eingangs-Lämpchen für Endschalter und Taster
- Kamera (USB-Webcam oder IP-Kamera): zuschauen, Foto/Video, entzerrtes Kamerabild unter der Zeichnung, Ausrichten mit 4 Laser-Kreuzen
- Netzwerk-Suche für Maschinen im WLAN/LAN (FluidNC, grblHAL, MKS DLC32 …)
- Board flashen (ESP32/ESP32-S3 inkl. .elf, Arduino UNO/Nano mit mitgeliefertem GRBL 1.1h)
- Anschlusspläne für CNC Shield V3, MKS DLC32 V2.1 und MKS DLC32 MAX
- 7 Sprachen: Deutsch, English, Français, Español, Italiano, Nederlands, Polski

Download: [Releases](https://github.com/Andys-3D-World/cnc-craft/releases) · Was sich geändert hat: [CHANGELOG.md](CHANGELOG.md)

## Selbst bauen

Voraussetzungen: [Node.js](https://nodejs.org) (LTS), [Rust](https://rustup.rs) und die
[Tauri-Voraussetzungen](https://v2.tauri.app/start/prerequisites/) für dein System.

```bash
npm install            # einmalig
npm run tauri dev      # zum Entwickeln (Fenster mit Live-Neuladen)
npm run tauri build    # Installationsdatei bauen
```

Die fertigen Dateien liegen danach in `src-tauri/target/release/bundle/`
(macOS: `dmg/` und `macos/`, Windows: `nsis/` und `msi/`, Linux: `appimage/`, `deb/`, `rpm/`).

Installationsdateien für alle Systeme baut die GitHub-Action `.github/workflows/release.yml`
(Reiter „Actions“ → „Release bauen“ → „Run workflow“). Das Ergebnis landet als Entwurf unter „Releases“.

## Lizenz

Die mitgelieferte GRBL-Firmware (`src-tauri/firmware/`) steht unter GPLv3, siehe dortige README.

Der STEP-Import nutzt [occt-import-js](https://github.com/kovacsv/occt-import-js) mit
[Open CASCADE Technology](https://www.opencascade.com) (beide LGPL 2.1). Die Dateien liegen unverändert in
`public/occt/` und werden zur Laufzeit geladen, siehe `public/occt/README.md`.
