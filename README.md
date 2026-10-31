# CNC Craft

🇬🇧 **English** · 🇩🇪 [Deutsch](README.de.md) · 🌐 **Website: [andys-3d-world.github.io/cnc-craft](https://andys-3d-world.github.io/cnc-craft/)**

Free, open-source software for **laser engravers, CNC routers and plasma cutters** – design, CAM and machine control
in one app, so you no longer switch between three programs. Runs on macOS, Windows and Linux.

**Status: 0.3.4 Beta** – please test, report bugs, and try machines without a workpiece / at low power first.

![CNC Craft – drawing and toolpaths](docs/screenshots/en/01-design-router.png)

## Features

**Design & import**
- Drawing tools with Bézier curves and node editing, text with 26+ fonts, single-line fonts and all system fonts,
  dimensions and constraints, booleans (weld, score), patterns, duplicate / “fill the bed”, nesting (also into offcuts)
- Shape library, QR codes, serial numbers and variable text, several beds per project (like build plates in a slicer)
- **Generators:** boxes with finger joints (20 types, with 3D view), jigsaw puzzles, Christmas ornaments, letter
  toppers, birdhouses, mandalas and one-piece names with symbols
- Import SVG, DXF, PDF, PLT and images (trace outlines or centerlines), 3D models as STL, 3MF and STEP – big files
  are read in background threads
- 3D view of the finished parts, node graph for reusable workflows

**Router (CAM)**
- Tool library like in Estlcam (end mills, ball, V-bits, chamfer, drills, thread mills …), Fusion 360 tool import,
  material database with cutting data, tool wear compensation, tool coating
- Outside / inside / on-line, pockets, adaptive clearing, finishing pass, ramp entry, holding tabs, dogbones,
  drilling, chamfers, facing and spoilboard surfacing, V-carve & inlay, rest machining, thread milling
  (internal/external), several operations per shape
- 3D milling from STL models (roughing and finishing), automatic split into cut-outs, holes and pockets,
  face stock on both sides
- Tool change with tool length measurement, re-measure during long jobs, probing, height map, drilling cycles
  G81–G89 on GRBL, slower feed in tight curves

**Laser**
- Layers like in LightBurn (fill, line, cut, fill + line) with cut order and lead-ins, holding tabs
- Image engraving with 14 styles, tone curve, auto enhance and before/after preview – adjusted on the graphics card
- Material view (see the result on wood, slate or acrylic), material presets incl. fibre laser, test grid,
  your own presets, lower power in corners for lasers without M4
- Rotary for tumblers and bottles, camera alignment and material detection

**Plasma**
- Kerf compensation, lead-ins, pierce points, material presets (40 A / 60 A air plasma), sheet height probing,
  torch height control (THC)
- Shortest cut order, rapids go around parts already cut, remnant sheet management (used areas are not cut again)

**Simulation**
- 3D simulation on the graphics card – smooth even with millions of moves – with time, distance, cost calculator
- G-code editor (also while a job runs), click a toolpath to jump to its line, resume a job from any line

**Machine control**
- GRBL / grblHAL / FluidNC / Grbl_ESP32 (USB and Wi-Fi), Marlin, Ruida (CO₂), K40 (M2 Nano)
- Several machines at once (e.g. laser via USB and router via Wi-Fi), jobs keep running in the background,
  “Stop all” stops every machine
- Jogging limited to the bed, spindle, laser test fire, overrides 10–200 %, input indicators for limit switches and probes
- Spindle inverter (VFD) over Modbus RTU/TCP, smart workshop (dust extractor, compressor … switch with the job),
  the computer stays awake during a job
- Camera (USB webcam or IP camera): watch, photo/video, camera image under the drawing

**Setup help**
- Network search for machines on Wi-Fi/LAN, Wi-Fi setup right from the app (incl. the board's own Wi-Fi)
- Machine settings ($$) explained in plain words, with backup/restore and factory reset
- Flash boards (ESP32/ESP32-S3 incl. grblHAL Web Builder .zip, Arduino UNO/Nano with GRBL 1.1h)
- **Wiring diagrams for 10 boards** – Arduino CNC Shield V3, MKS DLC32 V2.1 and MAX, PiBot V4.96 Pro and V5.88 Ultra,
  6 Pack, Jackpot, BTT SKR Pro, Arduino Mega + RAMPS, Ruida – drawn like the real boards, with external drivers,
  inductive NPN/PNP sensors, rotary, displays and VFD wiring

**Everything else**
- Libraries for tools, laser layers and plasma cuts with export/import, full backup and workshop sync between two computers
- All settings are also saved to a file and survive updates; update right from the app (signed)
- 7 languages: Deutsch, English, Français, Español, Italiano, Nederlands, Polski

## Screenshots

| | |
|---|---|
| ![3D simulation](docs/screenshots/en/02-simulation.png) <br> **Simulation** – toolpaths in 3D, time and G-code | ![Laser](docs/screenshots/en/03-laser.png) <br> **Laser** – layers: engrave (fill) and cut |
| ![Plasma](docs/screenshots/en/04-plasma.png) <br> **Plasma** – cuts, pierce points and lead-ins | ![Wiring diagram](docs/screenshots/en/05-wiring.png) <br> **Wiring diagram** – jumpers for microsteps and a second Y motor |
| ![MKS DLC32 MAX](docs/screenshots/en/06-mks-max.png) <br> **MKS DLC32 MAX** – drawn like the real board | ![External drivers](docs/screenshots/en/07-external-drivers.png) <br> **External drivers** – TB6600 / DM542, hover a wire to highlight it |
| ![Image engraving](docs/screenshots/en/08-image-engraving.png) <br> **Image engraving** – photos with before/after preview | ![Material view](docs/screenshots/en/09-material-view.png) <br> **Material view** – see the result on wood, slate or acrylic |
| ![Shape tools](docs/screenshots/en/10-shape-tools.png) <br> **Shape tools** – booleans, dimensions, Bézier curves | ![Several beds](docs/screenshots/en/11-beds.png) <br> **Several beds** – one project, several plates |

Download (Windows version signed via the [SignPath Foundation](https://signpath.org), see [Code Signing Policy](#code-signing-policy)): [Releases](https://github.com/Andys-3D-World/cnc-craft/releases) · What changed: [CHANGELOG.md](CHANGELOG.md)

## ⚠️ Safety and liability

CNC machines, lasers and plasma cutters can cause serious injuries, fires and property damage.

- **Never leave a laser running unattended**, wear suitable laser safety glasses, keep a fire extinguisher at hand,
  ventilate well (fumes from plastics can be toxic – never laser PVC/vinyl).
- Every machine needs a **real emergency stop switch** (hardware). The stop buttons in the software do not replace it –
  a USB or Wi-Fi connection can drop at any time.
- Test new jobs **without a workpiece or at low power** first, use the simulation and the frame run.
- Check the controller settings (steps/mm, limit switches, power) before the first job.

CNC Craft is beta software and is provided **without any warranty**, to the extent permitted by law
(see sections 15 and 16 of the [GPLv3](LICENSE)). The operator is responsible for running the machine safely.

## ❤️ Support CNC Craft

CNC Craft is free and will stay free. If the software helps you and you'd like to support its development,
I'd be happy about a coffee:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20CNC%20Craft-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/andys3dworld)
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-Andys--3D--World-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Andys-3D-World)

Just as helpful and free: give it a ⭐ on GitHub, report bugs ([Issues](https://github.com/Andys-3D-World/cnc-craft/issues))
and tell others about it – e.g. through my videos on YouTube, TikTok and Instagram (“Andys 3D World”).

Support is voluntary – all features are free for everyone, there is no paid version.

## 🤝 Contributing

Any help is welcome: report bugs and suggest ideas in [Issues](https://github.com/Andys-3D-World/cnc-craft/issues)
or [Discussions](https://github.com/Andys-3D-World/cnc-craft/discussions), improve translations
(`src/i18n/lang/*.json`) or test new boards and machines.

**Developed with AI:** CNC Craft is developed by Andreas Piaszek (Andys 3D World). The AI tool
[Claude Code](https://claude.com/claude-code) by Anthropic helps with the programming – CNC Craft wouldn't be this far
without it. Ideas, planning and decisions are mine. Every change is reviewed by me and tested on real machines and
boards. Commits co-written by the AI are marked with “Co-Authored-By: Claude”.

## Building from source

Requirements: [Node.js](https://nodejs.org) (LTS), [Rust](https://rustup.rs) and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your system.

```bash
npm install            # once
npm run tauri dev      # for development (window with live reload)
npm run tauri build    # build the installer
```

The finished files end up in `src-tauri/target/release/bundle/`
(macOS: `dmg/` and `macos/`, Windows: `nsis/` and `msi/`, Linux: `appimage/`, `deb/`, `rpm/`).

Installers for all systems are built by the GitHub Action `.github/workflows/release.yml`
(“Actions” tab → “Release bauen” → “Run workflow”). The result appears as a draft under “Releases”.

## License

CNC Craft is free software: you may use, share and modify it under the terms of the
**GNU General Public License version 3** (or any later version), see [LICENSE](LICENSE).
Copyright © 2026 Andys 3D World.

Bundled parts of other projects (all open source) are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md):
the GRBL firmware (`src-tauri/firmware/`, GPLv3) and the STEP import with
[occt-import-js](https://github.com/kovacsv/occt-import-js) and [Open CASCADE Technology](https://www.opencascade.com)
(`public/occt/`, LGPL 2.1), plus 26 free fonts for the text tool (`public/fonts/`, SIL Open Font License 1.1 or
Apache 2.0, licence texts next to the files). The text tool can also use every font installed on your computer.

Product and company names mentioned (e.g. LightBurn, Estlcam, OpenBuilds, MKS, xTool, Ruida) belong to their
respective owners and are only used to describe which programs and machines CNC Craft is comparable or compatible
with. CNC Craft is not affiliated with any of these manufacturers.

## Privacy

CNC Craft collects no data and has no telemetry. These are the only network connections:

- **Update check:** once a day a request to the GitHub API (`api.github.com`) asking which version is the newest.
  No data about you, your drawings or machines is sent – GitHub only sees the usual connection data (IP address).
  Turn off: ⓘ top right → “Automatically check for updates”.
- **Your own devices on your home network:** machines (Telnet/Wi-Fi), cameras and the 📡 search only connect to
  devices on your local network and only when you start it.
- **Links** (firmware downloads, help) only open in your browser when you click them.

Settings and libraries stay on your computer (app data folder, see ⓘ).

Details (German/English): [PRIVACY.md](PRIVACY.md)

## Code Signing Policy

The Windows installers are signed.

*Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org).*

- **Committers and reviewers:** [Andys-3D-World](https://github.com/Andys-3D-World) (Andreas Piaszek)
- **Approvers:** [Andys-3D-World](https://github.com/Andys-3D-World) (Andreas Piaszek)
- Only programs built automatically from the source code of this repository are signed
  (GitHub Actions, `.github/workflows/release.yml`). Every release is approved by hand beforehand.
- Everyone involved uses two-factor authentication on GitHub and SignPath.

**Privacy policy:** This program will not transfer any information to other networked systems unless
specifically requested by the user or the person installing or operating it. The only automatic connection is a
daily update check against the public GitHub API, which can be turned off in the app (ⓘ → “Automatically check
for updates”). Connections to machines, cameras and the 📡 network search only go to devices in the user's local
network and only when the user starts them.
