# CNC Craft

Open-Source-Programm für **Laser, CNC-Fräse und Plasma** – Design, CAM und Maschinensteuerung in einem
(Idee: LightBurn + Estlcam + OpenBuilds zusammen). Läuft auf macOS, Windows und Linux.

**Status: 0.2.3 Beta** – bitte testen, Fehler melden, und Maschinen zuerst ohne Werkstück / mit wenig Leistung ausprobieren.

## Was es kann

- Zeichnen, Import (SVG, DXF, PDF, PLT, Bilder, 3D-Modelle als STL, 3MF und STEP), Fräsbahnen mit Werkzeug-Bibliothek wie in Estlcam
- Laser-Ebenen wie in LightBurn, Plasma mit Schnittspalt, Anfahrbahn und Höhenregelung (THC)
- Bibliotheken für Fräswerkzeuge, Laser-Ebenen und Plasma-Schnitte – mit Export/Import und Komplett-Sicherung;
  alle Einstellungen werden zusätzlich als Datei gesichert und überstehen Updates
- Steuerungen: GRBL / grblHAL / FluidNC / Grbl_ESP32 (USB und WLAN), Marlin, Ruida (CO₂), K40 (M2 Nano)
- Spindel, Laser-Testschuss, Overrides 10–200 %, Eingangs-Lämpchen für Endschalter und Taster
- Kamera (USB-Webcam oder IP-Kamera): zuschauen, Foto/Video, entzerrtes Kamerabild unter der Zeichnung, Ausrichten mit 4 Laser-Kreuzen
- Netzwerk-Suche für Maschinen im WLAN/LAN (FluidNC, grblHAL, MKS DLC32 …)
- WLAN einrichten direkt aus der App – Netze in der Nähe auswählen, Sonderzeichen im Passwort, Erst-Einrichtung über das WLAN des Boards (inkl. MKS DLC32 MAX)
- Maschinen-Einstellungen ($$) verständlich erklärt, mit Sichern/Laden und Werkseinstellung
- Board flashen (ESP32/ESP32-S3 inkl. .elf, Arduino UNO/Nano mit mitgeliefertem GRBL 1.1h)
- Anschlusspläne für CNC Shield V3, MKS DLC32 V2.1 und MKS DLC32 MAX
- 7 Sprachen: Deutsch, English, Français, Español, Italiano, Nederlands, Polski

Download (Windows-Version signiert über die [SignPath Foundation](https://signpath.org), siehe [Code Signing Policy](#code-signing-policy)): [Releases](https://github.com/Andys-3D-World/cnc-craft/releases) · Was sich geändert hat: [CHANGELOG.md](CHANGELOG.md)

## ❤️ CNC Craft unterstützen

CNC Craft ist kostenlos und bleibt es auch. Wenn dir das Programm hilft und du die Weiterentwicklung
unterstützen möchtest, freue ich mich über einen Kaffee:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-CNC%20Craft%20unterst%C3%BCtzen-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/andys3dworld)
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-Andys--3D--World-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Andys-3D-World)

Genauso hilfreich und kostenlos: ⭐ Stern auf GitHub vergeben, Fehler melden ([Issues](https://github.com/Andys-3D-World/cnc-craft/issues))
und das Programm weitererzählen – z. B. über meine Videos auf YouTube, TikTok und Instagram („Andys 3D World“).

Unterstützung ist freiwillig – alle Funktionen sind für alle frei, es gibt keine Bezahl-Version.

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

CNC Craft ist freie Software: Du darfst es benutzen, weitergeben und verändern – unter den Bedingungen der
**GNU General Public License Version 3** (oder einer späteren Version), siehe [LICENSE](LICENSE).
Copyright © 2026 Andys 3D World.

Mitgelieferte Teile anderer Projekte (alle Open Source) stehen in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md):
die GRBL-Firmware (`src-tauri/firmware/`, GPLv3) und der STEP-Import mit
[occt-import-js](https://github.com/kovacsv/occt-import-js) und [Open CASCADE Technology](https://www.opencascade.com)
(`public/occt/`, LGPL 2.1).

Genannte Produkt- und Firmennamen (z. B. LightBurn, Estlcam, OpenBuilds, MKS, xTool, Ruida) gehören ihren
jeweiligen Inhabern und dienen nur zur Beschreibung, mit welchen Programmen und Maschinen CNC Craft vergleichbar
bzw. kompatibel ist. CNC Craft ist mit keinem dieser Hersteller verbunden.

## Datenschutz

CNC Craft sammelt keine Daten und hat keine Telemetrie. Es gibt nur diese Netzwerk-Verbindungen:

- **Update-Prüfung:** einmal am Tag eine Anfrage an die GitHub-API (`api.github.com`), welche Version die neueste
  ist. Dabei werden keine Daten über dich, deine Zeichnungen oder Maschinen gesendet – GitHub sieht nur die
  üblichen Verbindungsdaten (IP-Adresse). Abschalten: ⓘ oben rechts → „Automatisch nach Updates suchen“.
- **Deine eigenen Geräte im Heimnetz:** Maschinen (Telnet/WLAN), Kameras und die 📡-Suche verbinden sich nur mit
  Geräten in deinem lokalen Netzwerk und nur, wenn du das auslöst.
- **Links** (Firmware-Downloads, Hilfe) öffnen sich nur auf Klick in deinem Browser.

Einstellungen und Bibliotheken bleiben auf deinem Rechner (App-Datenordner, siehe ⓘ).

Ausführlich (Deutsch/English): [PRIVACY.md](PRIVACY.md)

## Code Signing Policy

Die Windows-Installationsdateien werden signiert.

*Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org).*

- **Committers and reviewers:** [Andys-3D-World](https://github.com/Andys-3D-World) (Andreas Piaszek)
- **Approvers:** [Andys-3D-World](https://github.com/Andys-3D-World) (Andreas Piaszek)
- Signiert werden nur Programme, die automatisch aus dem Quellcode dieses Repositorys gebaut wurden
  (GitHub Actions, `.github/workflows/release.yml`). Jede Veröffentlichung wird vorher von Hand freigegeben.
- Alle Beteiligten nutzen Zwei-Faktor-Anmeldung bei GitHub und SignPath.

**Privacy policy (English):** This program will not transfer any information to other networked systems unless
specifically requested by the user or the person installing or operating it. The only automatic connection is a
daily update check against the public GitHub API, which can be turned off in the app (ⓘ → “Automatically check
for updates”). Connections to machines, cameras and the 📡 network search only go to devices in the user's local
network and only when the user starts them.
