# Fremde Bestandteile / Third-party notices

CNC Craft selbst steht unter der GNU General Public License v3.0 oder später (siehe [LICENSE](LICENSE)).
Mitgeliefert bzw. eingebunden werden diese Open-Source-Bestandteile anderer Projekte:

## Mitgelieferte Dateien

| Bestandteil | Wo | Lizenz | Quelle |
|---|---|---|---|
| GRBL 1.1h (Firmware für Arduino UNO/Nano, unverändert) | `src-tauri/firmware/grbl_v1.1h.20190825.hex` | GPL-3.0 | https://github.com/gnea/grbl |
| occt-import-js 0.0.24 (unverändert) | `public/occt/occt-import-js.js`, `.wasm` | LGPL-2.1 | https://github.com/kovacsv/occt-import-js |
| Open CASCADE Technology (in occt-import-js enthalten) | `public/occt/occt-import-js.wasm` | LGPL-2.1 mit Ausnahme | https://dev.opencascade.org |
| Schrift Open Sans (unverändert) | `public/fonts/opensans/` | OFL-1.1 | https://github.com/googlefonts/opensans |
| Schrift Oswald (unverändert) | `public/fonts/oswald/` | OFL-1.1 | https://github.com/googlefonts/OswaldFont |
| Schrift Josefin Sans (unverändert) | `public/fonts/josefinsans/` | OFL-1.1 | https://github.com/ThomasJockin/JosefinSansFont-master |
| Schrift Nunito (unverändert) | `public/fonts/nunito/` | OFL-1.1 | https://github.com/googlefonts/nunito |
| Schrift Lora (unverändert) | `public/fonts/lora/` | OFL-1.1 | https://github.com/cyrealtype/Lora-Cyrillic |
| Schrift Libre Baskerville (unverändert) | `public/fonts/librebaskerville/` | OFL-1.1 | https://github.com/impallari/Libre-Baskerville |
| Schrift Roboto Slab (unverändert) | `public/fonts/robotoslab/` | Apache-2.0 | https://github.com/googlefonts/robotoslab |
| Schrift Cinzel (unverändert) | `public/fonts/cinzel/` | OFL-1.1 | https://github.com/NDISCOVER/Cinzel |
| Schrift Dancing Script (unverändert) | `public/fonts/dancingscript/` | OFL-1.1 | https://github.com/googlefonts/DancingScript |
| Schrift Great Vibes (unverändert) | `public/fonts/greatvibes/` | OFL-1.1 | https://github.com/googlefonts/great-vibes |
| Schrift Pacifico (unverändert) | `public/fonts/pacifico/` | OFL-1.1 | https://github.com/googlefonts/Pacifico |
| Schrift Lobster (unverändert) | `public/fonts/lobster/` | OFL-1.1 | https://github.com/impallari/The-Lobster-Font |
| Schrift Caveat (unverändert) | `public/fonts/caveat/` | OFL-1.1 | https://github.com/googlefonts/caveat |
| Schrift Permanent Marker (unverändert) | `public/fonts/permanentmarker/` | Apache-2.0 | https://fonts.google.com/specimen/Permanent+Marker |
| Schrift Allerta Stencil (unverändert) | `public/fonts/allertastencil/` | OFL-1.1 | https://fonts.google.com/specimen/Allerta+Stencil |
| Schrift Stardos Stencil (unverändert) | `public/fonts/stardosstencil/` | OFL-1.1 | https://fonts.google.com/specimen/Stardos+Stencil |
| Schrift Saira Stencil One (unverändert) | `public/fonts/sairastencilone/` | OFL-1.1 | https://github.com/Omnibus-Type/Saira |
| Schrift Bebas Neue (unverändert) | `public/fonts/bebasneue/` | OFL-1.1 | https://fonts.google.com/specimen/Bebas+Neue |
| Schrift Anton (unverändert) | `public/fonts/anton/` | OFL-1.1 | https://github.com/googlefonts/AntonFont |
| Schrift Bungee (unverändert) | `public/fonts/bungee/` | OFL-1.1 | https://github.com/djrrb/Bungee |
| Schrift Black Ops One (unverändert) | `public/fonts/blackopsone/` | OFL-1.1 | https://fonts.google.com/specimen/Black+Ops+One |
| Schrift Righteous (unverändert) | `public/fonts/righteous/` | OFL-1.1 | https://fonts.google.com/specimen/Righteous |
| Schrift Abril Fatface (unverändert) | `public/fonts/abrilfatface/` | OFL-1.1 | https://fonts.google.com/specimen/Abril+Fatface |
| Schrift Roboto Mono (unverändert) | `public/fonts/robotomono/` | OFL-1.1 | https://github.com/googlefonts/robotomono |
| Schrift Special Elite (unverändert) | `public/fonts/specialelite/` | Apache-2.0 | https://fonts.google.com/specimen/Special+Elite |
| Schrift Relief SingleLine (Einzellinien-Schrift, SVG + Umriss-WOFF2) (unverändert) | `public/fonts/reliefsingleline/` | OFL-1.1 | https://github.com/isdat-type/Relief-SingleLine |

Die vollständigen Lizenztexte liegen neben den Dateien (`public/occt/license.*.txt`, `src-tauri/firmware/README.md`,
`public/fonts/*/OFL.txt` bzw. `LICENSE.txt`). Die Schriften stammen aus https://github.com/google/fonts
(Relief SingleLine direkt aus dem oben genannten Repository); nur die Dateinamen wurden vereinfacht.

Quellcode der mitgelieferten Teile (unverändert übernommen):
- GRBL 1.1h: https://github.com/gnea/grbl/tree/v1.1h.20190825 – auf Anfrage schicken wir den Quellcode
  auch direkt zu (Issue im Repository genügt).
- occt-import-js 0.0.24: https://github.com/kovacsv/occt-import-js/tree/v0.0.24

## Bibliotheken (werden beim Bauen geladen)

| Bibliothek | Lizenz |
|---|---|
| Tauri (inkl. Plugins dialog, fs, opener) | MIT oder Apache-2.0 |
| serde, serde_json | MIT oder Apache-2.0 |
| ttf-parser (Systemschriften lesen) | MIT oder Apache-2.0 |
| serialport | MPL-2.0 |
| rusb | MIT |
| libusb (über rusb „vendored“ mitgebaut) | LGPL-2.1 |
| polygon-clipping 0.15.7 (Formen kombinieren / zerschneiden), mit splaytree und robust-predicates | MIT / MIT / Unlicense |
| earcut 3.0.2 (Flächen in Dreiecke zerlegen für die 3D-Ansicht) | ISC |
| Vite, TypeScript (nur zum Bauen) | MIT / Apache-2.0 |

Alle weiteren, indirekt verwendeten Rust- und npm-Pakete stehen unter freien Lizenzen (überwiegend MIT/Apache-2.0)
und sind in `src-tauri/Cargo.lock` bzw. `package-lock.json` aufgeführt.

## Marken

LightBurn, Estlcam, OpenBuilds, Makerbase/MKS, xTool, Ruida, FluidNC, grblHAL und weitere genannte Namen sind
Marken bzw. Namen ihrer jeweiligen Inhaber. Sie werden nur zur Beschreibung von Kompatibilität und Vergleich
genannt; CNC Craft ist mit diesen Herstellern nicht verbunden.
