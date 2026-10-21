# Fremde Bestandteile / Third-party notices

CNC Craft selbst steht unter der GNU General Public License v3.0 oder später (siehe [LICENSE](LICENSE)).
Mitgeliefert bzw. eingebunden werden diese Open-Source-Bestandteile anderer Projekte:

## Mitgelieferte Dateien

| Bestandteil | Wo | Lizenz | Quelle |
|---|---|---|---|
| GRBL 1.1h (Firmware für Arduino UNO/Nano, unverändert) | `src-tauri/firmware/grbl_v1.1h.20190825.hex` | GPL-3.0 | https://github.com/gnea/grbl |
| occt-import-js 0.0.24 (unverändert) | `public/occt/occt-import-js.js`, `.wasm` | LGPL-2.1 | https://github.com/kovacsv/occt-import-js |
| Open CASCADE Technology (in occt-import-js enthalten) | `public/occt/occt-import-js.wasm` | LGPL-2.1 mit Ausnahme | https://dev.opencascade.org |

Die vollständigen Lizenztexte liegen neben den Dateien (`public/occt/license.*.txt`, `src-tauri/firmware/README.md`).

Quellcode der mitgelieferten Teile (unverändert übernommen):
- GRBL 1.1h: https://github.com/gnea/grbl/tree/v1.1h.20190825 – auf Anfrage schicken wir den Quellcode
  auch direkt zu (Issue im Repository genügt).
- occt-import-js 0.0.24: https://github.com/kovacsv/occt-import-js/tree/v0.0.24

## Bibliotheken (werden beim Bauen geladen)

| Bibliothek | Lizenz |
|---|---|
| Tauri (inkl. Plugins dialog, fs, opener) | MIT oder Apache-2.0 |
| serde, serde_json | MIT oder Apache-2.0 |
| serialport | MPL-2.0 |
| rusb | MIT |
| libusb (über rusb „vendored“ mitgebaut) | LGPL-2.1 |
| polygon-clipping 0.15.7 (Formen kombinieren / zerschneiden), mit splaytree und robust-predicates | MIT / MIT / Unlicense |
| Vite, TypeScript (nur zum Bauen) | MIT / Apache-2.0 |

Alle weiteren, indirekt verwendeten Rust- und npm-Pakete stehen unter freien Lizenzen (überwiegend MIT/Apache-2.0)
und sind in `src-tauri/Cargo.lock` bzw. `package-lock.json` aufgeführt.

## Marken

LightBurn, Estlcam, OpenBuilds, Makerbase/MKS, xTool, Ruida, FluidNC, grblHAL und weitere genannte Namen sind
Marken bzw. Namen ihrer jeweiligen Inhaber. Sie werden nur zur Beschreibung von Kompatibilität und Vergleich
genannt; CNC Craft ist mit diesen Herstellern nicht verbunden.
