# Changelog

## Next version (unreleased)

**New**
- **6 Pack CNC Controller (FluidNC) in *Wiring*:** Bart Dring's modular board, drawn after the 6-Pack wiki with a
  common module set – two 4x opto input modules (limits, probe, tool setter, door), 4x 5V output (laser PWM on IO26,
  air via SSR), relay module (router on/off, plasma torch) and six driver sockets with motor terminals. Every part has
  steps and the FluidNC *config.yaml* lines; inductive NPN sensors work with 5 V or their own supply. Notes on
  jumpers (MS/SPI, Vcc, TMC5160), GPIO2 at boot, socket #5 (no PWM, random state at power-on), RS485 in socket #4
  and external drivers.
- **Inductive sensors (NPN/PNP) in *Wiring*:** for limit switches and the tool length sensor you can now choose
  *Mechanical switch*, *Inductive NPN* or *Inductive PNP* and the sensor supply (5 / 12 / 24 V) – on every board.
  The drawing shows the 3 wires (brown +V, blue GND, black signal) the way the board needs them: directly where the
  inputs allow it (PiBot with the SW-VCC jumper, Ruida, 5 V NPN sensors on 5V/GND/S), otherwise through an
  optocoupler/level module that switches to GND. Each board shows its input type (logic voltage, optocoupler,
  sensor supply), with clear warnings where 12–24 V would destroy the input (Arduino CNC Shield, MKS DLC32), notes
  on PNP and 5 V sensors and how to invert the input ($5/$6 or *:low* in FluidNC).
- **More parts in *Wiring*:** Arduino CNC Shield – push buttons for Hold, Resume and Abort (A1, A2, A0);
  MKS DLC32 MAX – flame sensor (Flame, IO36) and buzzer (+BEEPER−);
  PiBot V4.96 Pro and V5.88 Ultra – new view *VFD (RS485)*: Modbus wiring A/B, example VFD parameters (Huanyang)
  and the FluidNC *config.yaml* sections, with a note on pins shared with the 0–10 V outputs.
- **Rotary in *Wiring*:** new view for every board – on the Y connector instead of the Y motor (CNC Shield,
  MKS DLC32; MKS: unplug Y2 too), on the A axis for PiBot (FluidNC) and with its own driver on AXIS_U for Ruida.
  Steps link to the *Rotary* panel in the Laser tab (Y travel per rotation, A in degrees).
- **PiBot V5.88 Ultra:** limit switches X+ and Y+ on their own inputs, and EXTRA IO (IO10/IO15) with a relay
  module, switched with M64/M65 via *user_outputs* in the YAML.
- **Display in *Wiring*:** MKS DLC32 V2.1 – TS24/TS35 touch screen on EXP1/EXP2 (with the matching board firmware);
  MKS DLC32 MAX – 3.5" touch screen on the RJ11 “LCD” socket, switched on with $47=1; PiBot boards – SSD1306 OLED
  on the OLED header with the FluidNC *i2c0* / *oled* sections.
- **Computer stays awake during a job:** while a job runs on any connected machine, CNC Craft keeps the computer
  from going to sleep (macOS `caffeinate`, Windows power request, Linux `systemd-inhibit`) – like a video player.
  The screen may still turn off. Sleep is allowed again as soon as the job ends or stops.
- **On connect: read bed size and home:** two new ticks under *Connect*. *Read bed size on connect* (on by default)
  takes the X/Y travel from the board ($130/$131) as bed size, so the bed limit for jogging and spoilboard
  surfacing matches the machine. *Home on connect* (off by default) runs homing ($H) right after connecting –
  only once per connection, not again after a board reset.
- **PiBot Controller V5.88 Ultra board:** new in *Wiring* (ESP32-S3) – drawn after PiBot's pin map and test YAML:
  10 opto-isolated inputs in two rows (limits ±, probe, tool setter), white EN STP DIR GND terminals for external
  drivers and green motor terminals for all six axes, PWM 5 V outputs (spindle IO45, laser IO46), 0–10 V with
  forward/reverse, isolated RS485, two MOSFET outputs (500 mA) and both power inputs, with FluidNC *config.yaml*
  hints for every part. Also listed in *Flash board* with a link to PiBot's YAML templates.
- **PiBot FluidNC V4.96 Pro board:** new in *Wiring* – drawn like the real board (PiBot pin map and test YAML):
  six axes with one terminal each for motors or external drivers (EN STP DIR GND with jumpers), limit inputs,
  probe and tool setter, laser PWM, 0–10 V with forward/reverse, RS485, relay, MOSFET outputs and both power
  inputs. Every part has step-by-step help with the matching FluidNC *config.yaml* entries and jumper hints
  (SW-VCC, VDD, GPIO26 relay/input). The board is also listed in *Flash board* with a link to PiBot's YAML templates.
- **Centerline trace:** *Trace image* has a new option *Centerline* – instead of outlines, one single line in the
  middle of each stroke (handwriting, sketches, line drawings), ideal for engraving as a line or with a V-bit.
  The image is thinned to 1 pixel, followed along strokes and crossings, short stubs are dropped.
- **Lower power in corners (lasers without M4, e.g. Marlin):** new option in the laser settings. CNC Craft works
  out where the machine brakes before corners and accelerates when starting (acceleration in mm/s², junction model
  like GRBL) and lowers the S value there in the G-code, never below a set minimum – against burnt corners and dark
  start points. Only shown when M4 is off.
- **Surface the spoilboard:** new command in the extras menu (router). Mills the whole bed (or any area) flat in one
  pass set – the same facing path as *Face both sides*, without the flip steps.
- **Material database (router):** 📚 next to the material in the tool settings opens a table of all materials of the
  cutting data calculator – cutting speed, feed per tooth (factor × Ø and maximum) and step down, with an example
  for a 6 mm cutter. Built-in materials can be adjusted to your machine and reset, own materials can be added,
  renamed and deleted. New built-in materials: POM (Delrin), HDPE and rigid foam. The Fusion 360 import also
  recognises them in cutting data presets.
- **Material presets for plasma:** 📋 *Material presets* in the plasma library – starting values for mild steel,
  stainless steel and aluminium from 1 to 12 mm for 40 A and 60 A air plasma (speed, kerf, pierce height and delay,
  cut height, lead-in). One click creates a cut.
- **My presets (laser and plasma):** in the material presets, a tested laser layer or plasma cut can be saved as an
  own preset and later added again with one click – even after the layer has been changed or deleted.
- **Fibre laser presets:** the laser material presets now also offer *Fibre laser* (reference 30 W) with presets
  for metal: stainless steel (dark marking and deep engraving), steel, bare and anodised aluminium, brass, copper,
  titanium, slate and ABS – converted to your source power, with frequency hints and a 0.03 mm line interval. Only
  for fibre lasers that CNC Craft controls via GRBL (e.g. xTool F1 Ultra, gantry machines); galvo machines with an
  EZCAD controller are not supported, which the dialog says.
- **Mandala generator:** new command next to the box generator. A round disc with patterns in rings (petal, drop,
  circle, diamond, arch, spike), the same all around – diameter, symmetry, number of rings, bridge width, edge
  (round, wavy, petals) and centre can be chosen, every click on *New pattern* gives a different mandala. All
  holes keep the bridge width to each other and to the edge, so the part stays in one piece. Created as a group:
  outer contour *outside*, patterns as holes – or only engraved.
- **Tool wear compensation (router):** each tool has a new field *Wear compensation* (mm). Toolpaths are calculated
  with the nominal Ø minus this value, so a worn cutter can be corrected without changing its real Ø – part too big
  or hole too small: increase the value; negative if the cutter cuts bigger (e.g. runout). Used for contours,
  pockets, rest machining, thread milling and 3D milling; not for V-bits, chamfer mills, countersinks and drills.
  The tool list shows the corrected Ø (“cuts Ø2.95”). Instead of the offset you can also enter the *Measured Ø*
  (calipers or test cut – a 4 mm cutter is rarely exactly 4.00 mm); both fields update each other.
- **Tool coating:** tools have a *Coating* field (uncoated, TiN, TiAlN, AlTiN, AlCrN, CrN, ZrN, DLC), shown in the
  tool list. For information only – cutting data are not changed. The Fusion 360 import detects the coating from
  the tool name.
- **Face stock on both sides (against warping):** new button *Face both sides …* in 3D milling. Wood, plastics
  and aluminium have internal stresses – if a 3D job removes a lot of material from one side only, the part warps.
  The wizard makes a facing job (zigzag rows over the area, several depths, plunging next to the stock): mill side 1,
  flip the plate, zero Z again, mill the same job for side 2. The material thickness in 3D milling is reduced
  automatically, with a warning if the stock would become thinner than the model.
- **Facing as a milling operation:** new button *Facing* under *Path correction* (and as an extra operation per
  shape). The bounding rectangle of the shape is milled flat in rows down to the milling depth – e.g. to face stock
  or a spoilboard. Rows run past the edge, plunging happens next to the area; facing runs first within its tool.
- **Re-measure tool during long jobs (thermal drift):** new option in the tool change section, **off by default**.
  When on, newly generated G-code gets measuring points at safe places (between shapes, cutter up) – the first one
  at the start of the job is the reference, then one every set number of minutes (estimated run time). There the job
  stops the spindle, measures the tool and shifts Z zero by the difference to the reference. With a fixed sensor
  it runs by itself; with a normal hand probe plate it measures at the tool change position (plate on a surface that
  is not milled) and asks to remove the plate before continuing. Differences above 0.3 mm are not applied without
  asking. No guessed drift formula – only measured values are used. GRBL/grblHAL only.

**Improved**
- **MKS boards in *Wiring* checked against the Makerbase manuals:** the limit/probe inputs use a 5 V signal (texts
  no longer say 3.3 V); the MAX now lists its MKS special settings – flame $43, buzzer $41, door $48, air assist $44,
  tilt sensor $42 on “Probe”, roller mode $45 (Z connector) – and the laser power limits (up to 20 W on “Laser”,
  20–90 W on “Laser 2” MR30, above 50 W own power supply). On the V2.1 “Probe” is the flame input with laser firmware.
- **Wiring data is checked by tests:** every drawn wire must end at a pin that exists on the board, and every text
  of the wiring diagrams must exist in all 7 languages with the same placeholders.
- **Shorter travel moves when milling:** within each kind of operation (drilling, inside, pocket, outside …) the
  shapes are now ordered for the shortest rapid moves, like laser and plasma already were. Inside still comes
  before outside, and anything inside a closed shape is milled before that shape. Example job with 48 holes:
  4.3 m → 1.3 m of travel.
- **Adaptive feed in curves is now off by default:** milling jobs with many curves ran too slowly. Turn it on
  under *Milling parameters* → *Adapt feed in curves* and set the minimum feed (%) when needed.
- **Thread mills in the tool list** now show *single-tooth* or the pitch next to the number of flutes.
- **Resume from a line in the G-code editor:** click a line in the Simulation tab's G-code list (or a toolpath),
  then *Resume from here* starts the resume dialog at exactly that line.

**Fixed**
- **Spindle stopping on every rapid move:** a milling job no longer starts while the board is in laser mode
  ($32=1) – GRBL would switch the spindle off on each G0 and back on for cutting without spin-up time. The console
  explains how to set $32=0.
- **Slots and round contours no longer mill in tiny back-and-forth steps:** the inside/outside offset of finely
  divided arcs (slots, imported circles, rounded corners) left tiny loops at every arc point, so the cutter jerked
  forward and back and the path had up to four times as many points. Those loops are now removed.
- **Manual jogging could drive past the bed:** a 100 mm step at X 150 on a 205 mm bed went to 300 mm – into the
  limit switch or the frame. Jog steps in X/Y are now shortened to the bed edge (bed size from the top bar, origin
  bottom left); an axis already outside the bed may only move back towards it.
- **Surface the spoilboard drove past the bed:** the passes ran a cutter radius + 1 mm beyond the bed on both
  sides (with a 30 mm cutter 16 mm past the limit switches). Now the cutter centre stays on the bed – the radius
  still reaches the edge.
- **Plasma height probing stopped too early (only down to Z −60):** probing now moves relative to the current
  height with the new setting *Probe distance* (default 100 mm, counted from the safe height), so it also finds
  the sheet when work Z0 is far above it.
- **Dozens of “Error 9” lines after an alarm:** the board rejects every job line still in its receive buffer;
  these identical messages are now collapsed into one line (“… ×38”).
- **grblHAL alarms 11–18 were shown as “unknown alarm”:** they now have their own texts in all languages – e.g.
  alarm 15 (dual-axis homing with auto-squaring could not find the second limit switch). Only used with grblHAL,
  since FluidNC numbers these alarms differently.
- **Inch jobs (G20):** jogging and *Frame job* now always send `G21`. Before, an inch job could leave the machine in
  inch mode, and the next jog or frame (calculated in mm) would have travelled 25.4 times as far.

## 0.3.3 Beta

**New**
- **Licences in the app:** ⓘ (top right) → *Licences* shows the GPL, the bundled parts (firmware, fonts, STEP
  importer) and the licence texts of all 321 libraries compiled into CNC Craft. The list is generated by
  `tools/licenses/generate.py` (also in the release workflow) into `public/licenses/`.
- **Import Fusion 360 tool libraries:** *Import tools* in the tool library now also reads Fusion 360 tool
  libraries (.tools = ZIP with tools.json, or .json) as many tool dealers offer them for download. Flat, ball and
  bull nose end mills, chamfer mills, face mills, drills, countersinks and thread mills (also single-tooth with neck
  Ø and shoulder length) are taken over with their dimensions, flutes and pitch, inch libraries are converted, and
  the cutting data preset that fits the selected material is used (all presets are kept in the note). Holders,
  probes, taps and other types are skipped. Only the open file format is read – no third-party libraries are
  shipped with CNC Craft.
- **Drilling cycles for GRBL (G81, G82, G83, G73, G84, G74, G85, G89):** G-code from Fusion 360 and other CAM
  programs often contains canned drilling cycles, which GRBL does not know (error:20 in the middle of the job).
  CNC Craft now converts them into plain G0/G1/G4 moves just before the job is sent: simple drilling, dwell, peck
  drilling with full retract (G83) or chip breaking (G73), boring (G85/G89) and tapping (G84/G74: spindle reverses
  at the bottom – only with a floating tap holder, GRBL cannot sync the spindle). R/Z/Q/P stay valid for the
  following holes, G98 returns to the start height, G99 to R. Progress, *Resume from line* and the height map keep
  working on the loaded file. Programs with G91 cycles, missing R/Z/Q/F or a dwell that looks like milliseconds
  are refused with a clear message instead of guessing. The simulation, the 3D material view and the time
  estimate show the drilling moves of these cycles too.
- **Thread mill as a tool type:** new type *Thread mill* in the tool library with pitch and flank angle (metric 60°),
  drawn with its teeth, named e.g. *Thread mill P1.25 Ø6*. The cutting data calculator uses half the feed and one
  pitch as step-down. CNC Craft warns when a thread mill is used for normal contours.
- **Thread milling like in Fusion 360:** single-tooth thread mills (one tooth, any pitch – e.g. solid carbide
  single-profile thread mills) with neck Ø and shoulder length; the pitch then comes from the ISO coarse thread
  table (M8 → 1.25) unless you enter one (fine threads). The tool path now enters and leaves on a tangent arc that
  already follows the thread (half circle from the hole centre inside, quarter circle from outside for studs), can
  run several radial passes from the first contact to full depth and an optional spring pass. CNC Craft warns when
  the thread is longer than the neck reaches. The 3D view (*Milling result*) now shows the thread flanks in the
  hole or on the stud.
- **Thread milling (internal and external threads):** new operation *Thread milling* in *Operations* for circles,
  e.g. drill or mill the core hole first, then add *Thread milling* with the thread mill. Holes get an internal
  thread, studs (outside) an external thread. Settings: thread length, thread Ø (0 = automatic: core hole + pitch,
  so 6.8 mm becomes M8) and left-hand thread. The tool runs a helix with G2/G3 and one pitch per turn, always
  climb milling, entering and leaving radially at plunge feed; the feed is corrected for the tool centre. Metric
  ISO profile (60°): internal threads reach the nominal Ø, external threads the minor Ø. Thread operations always
  run after all other tools, so the hole or stud is finished first. The core hole does not have to be drilled: it can
  be milled with an end mill as *Inside* or *Pocket* (CNC Craft warns when an *Inside* contour would leave a core
  in the middle). Circles drawn with the ellipse tool or imported as polygons count as circles when they are round.
  Clear warnings when the tool is not a thread mill, the shape is not round, or the tool does not fit into the core
  hole.
- **Spindle inverter (VFD) over Modbus:** CNC Craft can now talk to a spindle inverter directly over
  Modbus RTU (RS-485 adapter) or Modbus TCP: set the speed, run forward / reverse / stop, and read the actual speed
  and the fault code. Small built-in Modbus engine (no extra libraries) with timeouts, retries after timeouts or
  line noise (CRC errors) and CRC16 checking. The registers come from profiles (data, not code): *Delta-style*
  (Delta VFD-E/M, MS300, GS20 …) and *Huanyang GT / P2A, Inovance-style*; custom profiles can be passed as JSON.
  The register maps are assumptions from common manuals – always check your own inverter manual first (the old
  Huanyang HY protocol is not supported). The spindle is stopped on disconnect and when the program closes.
  New section *Spindle inverter (Modbus)* in the *Machine* tab (milling): connection (RS-485 USB adapter with port,
  baud rate and parity, or IP address), device address, profile, max. speed and frequency, the register map of the
  profile to compare with the manual (*Custom profile* lets you enter every register yourself, *Use as custom
  profile* copies a built-in one), then speed, forward / reverse / stop and a live display of actual speed and
  fault code.
- **Laser and plasma: optimized cut order (shortest rapids):** new switch *Optimize cut order* in the laser and
  plasma settings (on by default). Until now the contours of a layer / cut were cut open lines first, then from small
  to large, so the head often jumped back and forth across the sheet. CNC Craft now picks the order with the shortest
  rapid moves: nearest neighbour first, then improved with 2-opt (with a time limit, so jobs with thousands of parts
  stay fast). Holes – and everything else that lies inside a closed contour, also a part inside the hole of a frame –
  are still always cut before that contour, the layer and cut order you set stays, and plasma pierce points and
  lead-ins are not moved. On the laser, open lines may be driven in the cheaper direction and closed contours without
  lead-in or tabs start at the point that is closest to the previous and the next contour. The G-code shows the rapid
  length before and after as a comment. Rapid detours around cut parts still work on top of the new order.
- **Milling: slow down in curves and inside corners (adaptive feed rate):** new switch *Slow down in curves* with a
  *Minimum feed (%)* in *Milling parameters* (on by default, minimum 50 %). In tight curves and inside corners the
  cutter wraps around more material, which made it chatter or break at the full feed. CNC Craft now measures how
  sharply the tool path turns within one cutter diameter (corners, G2/G3 arcs and arcs made of many short lines) and
  lowers F by the inner-arc rule *R / (R + cutter radius)* in 10 % steps, never below the minimum; straights keep the
  normal feed. The slowdown starts one cutter radius before the corner and ends one cutter radius after it (long lines
  and arcs are split for that), and F is only written when it changes. Plunges, ramps and helices keep their feed.
  Applies to contours, pockets and rest machining, not to drilling, V-carve, chamfers and adaptive pockets; G-code in
  inches, relative mode or another plane is left unchanged. Simulation and time estimate use the adapted feed.
- **Workshop sync: keep the libraries the same on two computers:** new button *🔄 Workshop sync* in the backup bar
  of the *Tools / Laser library / Plasma library* tab. Choose the same shared folder on both computers (NAS or network
  drive, Dropbox, USB stick) and CNC Craft keeps milling tools, laser layers and plasma cuts in sync through one file
  per library in `cnc-craft-sync/` – no network discovery and no open port. Every entry now carries a change time and
  the computer that changed it: the newer change wins per entry, deleted entries stay deleted (tombstones, cleaned up
  after 90 days), the list order is synced too, and old entries with the same ID but different content on both
  computers are both kept (one as a copy). Automatic sync when the window gets focus, shortly after a change and every
  minute (can be switched off), or *Sync now*. The files are written safely (temporary file + rename) with a lock
  against both computers writing at once; a damaged file in the folder is moved aside and ignored, and everything read
  from the folder goes through the libraries' normal checks. Before the first sync and before every sync that changes
  something locally a backup is written to `backups/library-sync-….json` in the app data folder (library backup
  format, last 20 kept). The console shows a short summary ("Milling tools: 3 changed, 1 new"). Machine settings
  (laser/plasma settings, spindle limits) and the default entry are not synced; the laser material presets are
  built in and need no sync, and box/nesting have no saved templates yet.
- **Smart workshop: switch the dust extractor, compressor … with the job:** new section *Workshop* in the *Machine*
  tab. Add devices on smart plugs (templates for Shelly Gen 1, Shelly Plus/Pro, Tasmota via HTTP or MQTT, Home
  Assistant webhook, or any HTTP/MQTT device): HTTP GET/POST/PUT with an optional body and bearer token, or an MQTT
  message (broker, port, optional user/password, topic, on/off payload). When a job starts on any machine (GRBL,
  Marlin, Ruida, K40) every enabled device is switched on; when the job ends (done, stopped, aborted or disconnected)
  and no other machine is still running a job, each device is switched off after its own run-on time (e.g. 30 s). A
  new job during the run-on time keeps the devices on. The requests run in their own threads with short timeouts in
  the Rust part (`workshop.rs`, no new dependencies) – a device that does not answer never affects the job, the result
  is only shown in the console (without addresses, passwords or tokens). *Test on/Test off* buttons per device. Only
  plain `http://` and MQTT without TLS (devices in the local network).
- **G-code editor in the Simulation tab:** click *Edit* above the G-code list to change lines (double-click or
  Enter), delete them (Del) or insert new ones after the selected line (empty line, `M0` pause, `F` feed rate, `G4 P1`
  wait), with undo/redo (Ctrl+Z / Ctrl+Shift+Z). The 3D view is re-read and redrawn after every change; *Apply* makes
  the edited text the job. While a job is running (GRBL) only lines the machine has not received yet can be changed:
  everything already sent plus a safety margin of 5 lines is locked (🔒), the change needs a confirmation and is
  checked again by the sender (new command `machine_job_patch`); progress and the resume mapping stay correct. For
  speed changes the editor offers the feed and spindle overrides instead of rewriting lines. Not available with an
  active height map.
- **Click a toolpath to find its G-code line:** clicking a path in the simulation view jumps to the matching line in
  the G-code list and highlights it; clicking a line highlights its path in yellow.
- **Plasma and laser: rapids go around parts that are already cut (tip-up / collision avoidance):** cut-out parts
  and hole slugs can tip up. When a rapid move (G0) between two cuts – or the final move to the park position – would
  cross a closed contour that has already been cut in this job, it now goes around that contour's bounding box with a
  margin (plasma 5 mm, laser 3 mm), via the shortest way past all cut pieces. If nothing is in the way, the move stays
  straight as before; start and end points never change. Contours with holding tabs stay in place and are not avoided.
  Detour lines are marked with a comment in the G-code and show up in the simulation. New setting *Avoid cut-out
  parts*: on by default for plasma (*Plasma settings*), off by default for laser (*Laser settings*, line cuts only).
  Written in TypeScript (`rapidAvoid.ts`) because the plasma and laser CAM run entirely in TypeScript; tests run with
  the new `npm test` (`node --test`).

**Improved**
- **Tool library with many tools:** above the list in the *Tools* tab there is now a row of filter buttons – *All*
  plus one per tool type in the library, with icon and count (e.g. *End mill 4 · Thread mill 6*) – and a search
  field (name, Ø, note, T number). With *All* the list is grouped by type; groups can be collapsed. The filter is
  remembered, a new tool starts with the type of the active filter, and ▲▼ swap the tool with its visible neighbour
  of the same type.
- **Licence and legal clean-up:** `THIRD_PARTY_NOTICES.md` is now in English and complete (updater, flate2, rayon,
  tokio, MPL-2.0 and Unicode-3.0 crates, libusb). The website names other programs only to describe similar
  workflows (no more “LightBurn + Estlcam + OpenBuilds = CNC Craft”) and has its own privacy policy page.
  `PRIVACY.md` now also covers the smart workshop devices, the workshop sync folder and the update download.
  Unused template logos (Tauri, Vite, TypeScript) were removed, `promo/` is ignored by git.
- **Ruida over USB is easier to find:** in the port list of a Ruida laser the USB ports are now marked
  *🔌 USB* (an FTDI port is picked automatically), and when no cable is plugged in the list still shows a USB entry
  with a hint (plug in the cable, switch the laser on, then 🔄) instead of only *Network*.
- **Tool change: choose how far Z lifts – also in “Manual” mode:** new setting *Lift Z at the change* (section
  *Probing* → *Tool change*): *height above work zero* (e.g. 40 mm – works on every machine), *all the way up* (to just
  below the limit switch: the homing position, `-$27` – needs homing upwards via `$22`, otherwise the height above work
  zero is used; the settings are read with `$$` first if needed), *safe height* (machine Z, as before) or *don't lift*.
  With homing no height goes above the homing position. Until now “Manual” did not lift at all, so the tool stayed at
  the program's own safe height (e.g. Z 5 – too low for a 19 mm touch plate). Now it lifts first and, after *Resume
  job*, moves back to the old XY position and height before the job continues (like the automatic modes).

**Fixed**
- **Live simulation follows the real machine:** during a job the simulation used the lines GRBL had confirmed – but
  "ok" only means "in the buffer", and grblHAL buffers many lines ahead. The tool was shown ahead of the real machine
  and jumped 4 times per second. Now the tool follows the position from the status reports (nearest path in program
  order, never past the buffered lines). Between two reports it moves on with the measured speed (the time estimate
  knows no acceleration, so short segments run slower on the machine) and glides to the target instead of jumping,
  at full frame rate (lower automatically for very large programs).

## 0.3.2 Beta

**New**
- **Tool change with tool length measurement (router, GRBL/grblHAL):** when a job reaches a tool change (`M6 T<n>`
  or CNC Craft's own `M0` with the tool change comment) the job stops, the spindle turns off, Z moves up to a safe
  height (machine Z, only upwards) and a small window shows the new tool (number, name and diameter from the tool
  list). The window floats at the bottom right, so you can still jog. New setting *Tool change* in the section
  *Probing*: *Manual* (just the notice, as before – with a button to probe with the touch plate), *Fixed sensor* or
  *Mobile touch plate*. Fixed sensor: if there is no reference yet, the old tool is measured on the sensor first; then
  move to the change position, you swap the tool and click *Measure tool*, CNC Craft measures it on the sensor and
  shifts the Z zero of the active coordinate system by the length difference (`G10 L20 P0`). Mobile touch plate: you
  insert the tool, place the plate and clamp, click *Probe*, Z is set to the plate thickness, then you confirm that
  the plate is removed. Afterwards the machine moves back to the position before the change and the job only
  continues after you click *Resume job* (the spindle turns on again if it was on). Uses the same software probing
  as the probing section (jog with debouncing instead of G38.2) with the existing plate thickness, sensor position and
  probing speeds; new: safe height, max. probing distance (no contact → nothing is set), start height above the
  sensor, change position and travel feed, plus *Measure reference now*. Safety: alarm, reset/E-stop, lost connection
  or Stop end the probing immediately and the job does not continue; switching machines is blocked meanwhile. All
  moves are jogs, so the program's modal state stays the same (inch and incremental mode are restored). Option
  *G-code: tool change as "M6 T…"* writes `M6 T<n>` instead of `M0` (also in 3D milling)
- **3D milling from STL models (router):** new button *3D milling* in the 3D import window (STL, 3MF, STEP) for
  reliefs, signs with a raised relief, bowls and other freeform shapes. Set the position and size on the bed, the model
  height and the material thickness (top of the model = top of the material, Z 0), then pick one cutter for roughing
  and one for finishing from the tool list. *Roughing* clears the material in Z layers (step down) with rings at the
  step-over distance and leaves a stock allowance; ramp entry when the tool has a ramp angle. *Finishing* follows the
  surface in lines along X, Y or both with drop-cutter geometry: ball end mills (sphere against faces, edges and
  corners) and flat end mills (flat disk) are calculated exactly, other types like a flat end mill (never too deep).
  Points on straight stretches are thinned out within the tolerance. Without roughing the finishing pass works in
  layers from the top. The calculation runs in the app core on all CPU cores, shows its progress and can be
  cancelled. The G-code follows the normal format (safe height, spindle, feed, plunge feed, tool change with M0) and
  can be loaded as a job or saved; the dialog shows the milled result from this G-code in 3D (same material removal
  simulation as the 3D view) together with path lengths and an estimated time
- **Split 3D models automatically (router):** new option *Split automatically* in the 3D import window (STL, 3MF,
  STEP). Instead of one slice height the whole part is analysed (milled from the view direction): the outline becomes
  a cut-out, through holes become inside cuts (both full thickness), and recesses become pockets with the depth of
  their floor – also stepped pockets one inside the other. Floors are found from the flat, upward-facing faces of the
  model. The window shows the counts, the thickness and the pocket depths; then choose the cutters with *Assign
  tools*. Not recognised yet: slopes and roundings (chamfers, radii), steps at the outer edge (reported) and holes only
  from below (reported)
- **Several operations per shape (router):** new section *Operations* for the selected shapes, like in Fusion: the
  first operation is the shape itself (cut side, tool, depth as before), further ones are added with ＋ – e.g. pocket
  with the 6 mm cutter, then chamfer with the 90° chamfer bit, then cut out with the 3 mm cutter, each with its own
  tool and depth. In the G-code every operation is milled like its own shape, so the order and tool changes follow
  automatically (holes and pockets first, then chamfers, cutting out last). Old projects stay as they are. When the
  selection has different types (e.g. outline and holes of an imported part), *Applies to* chooses which ones get the
  operations – e.g. only the holes get a chamfer
- **Chamfer operation:** new operation type *Chamfer* with a chamfer width. With a chamfer or V-bit the depth is
  calculated from the bit angle (width ÷ tan(angle/2)) and the tip runs half the tip diameter beside the edge –
  outside on outer contours, inside on holes, pockets and drill holes (countersink), on the line otherwise. Warnings
  when the bit has no angle or the chamfer is wider than the bit
- **Assign tools:** new button *Assign tools* in the tool section: one tool per operation type (cut out, holes,
  pockets, engraving, V-carve, drilling, chamfer) for the whole design or the selection, with a count per type
- **Cost calculator:** new button *Calculate costs* next to *Simulate*. For the current design it shows what the part
  costs and what it should cost: machine time from the G-code (same estimate as the simulation) × machine rate,
  material (outline of the parts + 5 mm margin, or the whole sheet) × price per m² plus waste %, labour (setup once per
  job + finishing per piece) × your hourly rate, extras per piece, quantity and markup %. Result: cost in total and per
  piece, sale price per piece and in total, and the profit. Rates and currency are remembered; *Copy as text* puts the
  calculation on the clipboard, e.g. for a quote. Prices without VAT. Also in the left toolbar (€ button below G-code
  and simulation). Extras:
  - *Material price list:* save prices per m² under a name (e.g. *Poplar 4 mm*) and pick them again; with the laser
    the entry matching the material and thickness of the layers in use is chosen automatically
  - *Quantity discount:* up to three tiers „from n pieces → markup %“, the result shows which markup was used
  - *Save as CSV:* the calculation as a table for Excel or an invoicing program (semicolon-separated with decimal
    comma in languages that use it)
- **Laser material presets:** new button *Material presets* in the laser library. Choose diode or CO₂ laser and its
  power in watts, then one click creates a layer with start values for e.g. *Poplar plywood 3 mm cut* (power, speed,
  passes, air, material and thickness) – 19 presets for plywood, hardwood, MDF, acrylic, cardboard, paper, leather,
  cork, felt, slate, glass and anodized aluminium. The values are given for a 10 W diode / 50 W CO₂ laser and are
  converted to your power: cutting keeps the power and changes passes and speed (same energy per mm), engraving keeps
  the speed and changes the power. Presets that would need too many passes are marked as too weak, unsuitable ones
  (e.g. glass with a diode) are disabled, with notes for acrylic, leather and glass. Engraving layers are put before
  the cutting layers. A clear note says these are cautious start values to check with the material test grid first
- **Rest machining (router):** new field *Rest material with* in the tool section of the selected shapes. Pockets
  and holes (inside) can get a second, smaller tool: after the shape's own tool has cleared everything quickly, the
  small tool mills only the spots the big one could not reach – inside corners and narrow places – so the corners
  get sharp without milling the whole shape with the small tool. A spot counts as cleared when the small cutter fits
  completely inside the big one's path there; each remaining piece is extended a little so it starts in cleared
  space. The small tool comes in its own block with a tool change; if the big tool also cuts parts out, the order is
  inside → rest material → cut out, so the part is not loose yet. Shapes where it cannot work (outside contours, rest
  tool not smaller) are reported
- **Drilling (router):** new path type *Drill* next to outside/inside/pocket. Selected circles and other closed shapes
  are drilled straight down in their centre, with chip breaking (peck drilling): after every depth per pass of the
  tool it comes fully out and goes back in rapidly to just above the last depth. Written as plain moves, because GRBL
  does not know G81/G83. Holes are drilled first within each tool and on the shortest route from hole to hole. A
  warning shows when the hole size does not match the tool diameter. On the work area the drill spot is shown as a
  dot of the tool size
- **Finishing pass (router):** new field *Finishing allowance* in the milling parameters of the selected shapes
  (0 = off). The roughing passes leave that much material at the wall (e.g. 0.2 mm), then the cutter goes around once
  more at full depth exactly on size – cleaner edges and more accurate fits. Works for outside and inside contours,
  circles, pockets (walls and islands) and with holding tabs (the finishing pass lifts over the tabs too). The cutter
  goes down on the roughing path, where everything is already cleared, and then moves sideways onto the final path, so
  it never plunges into the remaining material. If the cutter no longer fits with the allowance, the shape is milled
  without finishing pass and a warning is shown
- **Ramp entry (router):** new field *Ramp angle* per tool in the tool library. Instead of plunging straight down, the
  cutter goes into the material at that angle, back and forth along the start of its path (several times if the path
  is short), and ends exactly where the path starts – for contours, pockets, lines and contours with holding tabs (the
  ramp stops before the first tab). Circles go in as a helix. New tools get 3°, existing tools keep 0° (= plunge
  straight as before). Drills, V-bits, chamfer and countersink bits always plunge straight; paths too short for a
  ramp also plunge straight
- **Dogbones:** new entry *Dogbones* in the *Edit* group of the toolbar. Inside corners (seen from the material) of
  closed outlines get a circle with the cutter radius so square tabs and parts fit into milled pockets and slots:
  holes, cut-outs and pockets get them in their corners, outer contours (and islands in a pocket) in their re-entrant
  corners. Two types: classic dogbone (circle along the angle bisector) and T-bone (circle along the longer or shorter
  edge). The radius is suggested from the shape's tool in the tool library, plus an adjustable allowance (default
  0.05 mm); only corners up to an angle limit (default 100°) with edges of a minimum length are changed, so roundings
  stay. Preview with the circles highlighted and a count; corners whose edges are too short for the circle are
  skipped and reported. Rectangles become polylines, the arcs are split finely into points
- **Adjust material thickness:** new entry *Adjust material thickness* in the *Edit* group of the toolbar. A
  slot-together model drawn for e.g. 3 mm is converted to the measured sheet thickness (e.g. 3.6 mm): slots and tabs
  (rectangular notches and protrusions as wide as the drawn thickness, within a tolerance) and rectangular holes get
  the new width, both walls move apart by half the difference so the centre stays put. All other sizes stay the same;
  optionally the whole model can be scaled first and a kerf allowance is added like in the box generator. The dialog
  suggests the drawn thickness (most common slot width), shows a preview with the changed spots highlighted (slots,
  tabs, holes in their own colour) and counts them; slots without enough room to widen are skipped and reported
- **STL for 3D printing:** new entry *STL for 3D printing* in the *Extras* group. The selection (or everything) becomes
  a 3D solid and is saved as binary STL. The shapes are grouped (laser: per layer, router: cut-outs / pocket / …,
  plasma: one group) and every group is a *base body* (height), *recess* (depth), *relief* (height) or left out.
  Cut-outs and holes stay open (even-odd like the cut), laser layers with *Fill* default to a recess, router pockets
  to a recess with their milling depth. Live 3D preview in the existing viewer with size and triangle count; the
  solids are closed (watertight) with outward normals, triangulated with earcut
- **Name generator:** new entry *Name generator* in the *Extras* group. A name becomes one connected lettering that
  can be cut out in one piece: letters (any font of the font system, letter spacing may be negative to overlap) are
  merged and connected by overlapping only, a baseline bar or an outline around everything (counters filled; the
  letters can be engraved on top, cut out, or become a separate part glued onto a backing plate – layered
  two-colour signs; *Place on bed* then inserts backing and lettering as two groups). Symbols from the shape library (heart, star, moon, paw …) in front
  and/or behind, hanger as ring (left or on top at the highest letter) or hole. Templates *Christmas bauble* and
  *Christmas star* with the name engraved or cut out. Live preview with size and a warning when the result falls
  apart into several pieces; tiny gaps where round letters meet the baseline are filled. *Place on bed* inserts it as
  one group in the middle of the bed (cut on the strongest line layer, engraving on the fill layer / as pocket)
- **3D milling result (router):** the 3D view (*Extras → 3D view*) now shows the real milling result for the router
  (new default view *Milling result (from G-code)*). The material is a fine height grid; every move of the G-code
  presses in the shape of its cutter – flat end mill, ball nose, bull nose, V-bit, chamfer, countersink and drill
  (the cutter per section follows the tool changes). Pockets, V-carving with sloped walls, grooves, holes, cut-outs
  (deeper than the thickness = open) and material left in inside corners become visible. Calm material surface
  (fine, faint grain), darker with depth relative to the deepest cut; the result is cached while only material or
  thickness change
- **Material test grid (laser):** new entry *Material test grid* in the *Extras* group of the left toolbar. It creates
  a grid of squares with rising power (columns) and rising speed or line interval (rows), as fill or line. Every square
  is lasered with its own values (no extra layers per square), the values are written next to the grid with the
  single-line font on a separate low-power layer. The material preview shows squares with more power darker
- **QR codes:** new entry *QR code* in the *Extras* group. Links or text (UTF-8, umlauts) become a QR code made of
  closed areas (touching dots are merged into one outline, holes included) – fill it with the laser or pocket it with
  the router. Size and error correction (L/M/Q/H) are adjustable, the dialog shows a preview, the version and the dot
  size and warns about dots that are too small. Double-click a QR code to edit it. Own small encoder, no extra library
- **Serial numbers and variable text:** new entry *Serial numbers / CSV* in the *Extras* group. Texts and QR codes in
  the selection can contain placeholders: `{n}` for a running number (start, step, leading zeros) and `{column name}`
  or `{1}`, `{2}` … for values from a CSV file (separator `;`, `,` or tab, detected automatically; one copy per row).
  The copies are arranged in a grid that is sized by the largest copy, frames and other shapes are copied along.
  The dialog shows the first and last values before creating anything
- **Adaptive clearing (router):** new pocket strategy *Adaptive* next to *Parallel* and *Contour*. The cutter keeps an
  even engagement: rings from the inside out, a material map checks before every step how much of the cutter is in
  the material, and where it would be too much (first cut, corners, narrow spots) it switches to small trochoidal
  loops (climb). New material is entered with a helix instead of plunging straight down. Loops and helix are sized so
  they never come closer than the tool radius to walls or islands. In tests the engagement mostly stays around 65–70°
  (max. about 135°) instead of 180° full-width cuts, the path is about as long as with *Contour*
- **Probe surface / height map (router, GRBL):** new part *Probe surface* in the probing section of the *Machine*
  tab. Starting at the current position (front left corner) a grid of up to 20 × 20 points is probed with the same
  debounced two-step software probing as the touch plate (no G38.2, all moves relative, Z goes up after every point,
  the guard stops the machine if the probe triggers while travelling). Optionally Z = 0 is set at the first point.
  Before the way back the bit goes above the highest measured point. A small colour map shows the result.
  With *Compensate when sending* every job gets Z adjusted to the surface: long lines are split, arcs (G2/G3, I/J or R)
  become short lines, the job progress still counts the original lines. G-code that cannot be converted safely
  (G91, G20, G92/G10, G38, drilling cycles, rotary axis, other planes, invalid arcs) is refused instead of milled wrong
- **Resume a job:** new button *Resume from …* below the job buttons and *Resume from here* in the simulation. Pick a
  line, a shape/layer from the list or *shortly before the abort* (a few lines earlier, because GRBL acknowledges lines
  while they are still in its buffer). CNC Craft reads the G-code up to that point and sends a preamble that restores
  the state: units, G90, plane, coordinate system, safe Z, spindle (M3/M4 with speed and spin-up time), coolant,
  moving to the position, slowly down to the depth and the feed rate. The laser stays at S0 until the first cutting
  line, which gets its power back. Plasma can only resume where the torch is off. The dialog shows the preamble,
  warns about an earlier tool change and moves the simulation to the spot; the job progress keeps the original line
  numbers (also together with the height map)
- **V-carve (router):** new path mode *V-Carve* – the V-bit follows rings inside the area that get deeper the
  further they are from the edge (depth = distance / tan(half angle), tip diameter included), giving sharp top edges
  and pointed corners like Vectric. Letters with holes and nearby shapes are carved as one area. The depth field is the
  maximum depth; wider parts get a flat bottom. Deep carvings are cut in layers (step-down of the tool). Needs a V-bit
  with an angle in the tool library
- **V-carve inlay:** new button *Inlay* makes a pocket from the selection (flat bottom at the pocket depth) and places a
  mirrored plug next to it. The plug is carved around the outside with a start depth of pocket depth minus glue gap,
  so it fits upside down into the pocket; the dialog shows all depths
- **More fonts in the text tool:** 26 free fonts are now included (SIL Open Font License / Apache 2.0, licence texts
  in `public/fonts/`): sans serif (Open Sans, Oswald, Josefin Sans, Nunito), serif (Lora, Libre Baskerville,
  Roboto Slab, Cinzel), script (Dancing Script, Great Vibes, Pacifico, Lobster, Caveat, Permanent Marker),
  stencil (Allerta Stencil, Stardos Stencil, Saira Stencil One), display (Bebas Neue, Anton, Bungee, Black Ops One,
  Righteous, Abril Fatface) and monospace (Roboto Mono, Special Elite). They work the same on every computer
- **Single-line font for engraving:** *Relief SingleLine* draws letters from simple open lines – the laser or
  engraver runs every stroke only once instead of going around the outline
- **System fonts:** every font installed on the computer (macOS, Windows, Linux) can be chosen in the text tool.
  Need another font? Install it in the system and reload the list with ↻. A .ttf/.otf file can also be loaded
  directly (valid until the app is restarted)
- **New font picker:** search field, every font name shown in its own font, groups *Included*, *Own files* and
  *System*, style tags (serif, script, stencil …)

**Improved**
- **Font picker:** its styles moved from the text dialog into the main stylesheet, so other dialogs (name generator)
  can use it too
- **Auto enhance with two profiles and local contrast:** the engraving window now offers *Gentle* (natural look) and
  *Strong* (more contrast and detail – fur, hair, fine structures). New slider *Local contrast* boosts detail against
  the surroundings; bright edges are held back much more than dark ones and almost white areas are left alone, so no
  bright halos appear around hard edges. Flat pictures automatically get more local contrast. The before/after rating
  shows the effect
- Projects remember the font of each text. If it is missing on another computer, the text tool shows a clear
  hint and uses Open Sans instead; the existing shapes in the project stay unchanged
- Bold/italic of system fonts use the real bold/italic files when the font has them

**Fixed**
- The 3D import window was titled *STL for 3D printing* and the node graph window *Name generator* – the new STL
  export and name generator had reused their text keys. Each window has its own title again

## 0.3.1 Beta

**New**
- **Rotary (laser engraving on round items):** new section *Rotary* in the Laser tab – connection (rotary on the Y
  connector, like xTool RA2 / Creality / LaserPecker roller rotaries, or its own A axis on grblHAL/FluidNC), type
  (roller or chuck), item diameter, roller diameter and Y travel per rotation. You draw on the unrolled surface:
  X = along the item, Y = around it; a blue band on the bed shows the circumference. When the G-code is made, Y is
  converted (roller: by the roller diameter, chuck: by the item diameter; A axis: in degrees). Warning when parts lie
  outside the circumference. The simulation shows the unrolled surface; framing moves only along X on an A axis
- **3D view (new button in the left toolbar):** see the result from all sides – drag to turn freely in every
  direction (also upside down), right-drag/Shift to move, wheel to zoom, double-click to reset. *Cut-out parts:*
  everything that is cut through (laser: line layers from 70 % power, router: outside/inside, plasma: all closed
  shapes) becomes a solid part with the chosen thickness, the top shows the material with the engraving (like the
  material view), laser-cut edges on wood/leather/cardboard are charred dark; optionally the remaining sheet with
  its holes and the parts lifted out of it. *Round item:* with the rotary switched on, the design is wrapped around
  a cylinder with the set diameter. Small WebGL viewer, polygons are triangulated with earcut (ISC)
- **Shape library:** new button in the left toolbar – 42 ready-made shapes in four groups (basic shapes, stars &
  badges, symbols, maker parts such as tag, keychain, coaster, puzzle piece, plate and bracket with holes). Click a
  shape to place it in the centre of the bed at the chosen width; holes are recognised as inside contours
- **Tone curve for image engraving:** new section *Tone curve* in the engraving window – click to add a point, drag
  to bend the brightness, double-click to remove a point; the brightness distribution of the picture is shown behind
  the curve. Quick buttons: S-curve (more contrast), lighter midtones, straight. Smooth curve without overshoot
  (monotone cubic); saved with the image
- **Split into tiles:** new button in the shape tools – a design larger than the machine is cut into tiles of a chosen
  size (or the bed size). Areas are cut at the tile borders and stay areas, lines become line pieces, parts that fit
  completely into one tile stay unchanged, images are split (not rotated ones). Each tile can go onto its own bed at
  the origin, with small registration marks in the corners (weakest line layer / 0.3 mm deep) for lining the pieces
  up
- **Node graph (first version, new button in the left toolbar):** build a workflow from blocks instead of clicking
  step by step – drag an output onto an input, every node shows a small live preview and its result, settings of the
  selected node on the right. 24 nodes in five groups: *sources* (shapes/image taken from the bed as a copy,
  rectangle, circle, polygon), *shapes* (move/rotate/scale/mirror, position, offset, union/subtract/intersect/exclude,
  round corners, grid copies, pattern fill, nesting, tiles, laser layer/cut side/depth, merge), *image* (remove
  background, tone curve, brightness/contrast/gamma/sharpen/invert, engraving method and line interval, size and
  position, mask with closed shapes), *numbers* (number, calculate – green inputs let one number drive several
  settings) and *output*. "Place on bed" puts the result on the bed and replaces the previous result of the same
  output; tiles can go onto their own beds. Only changed nodes are recalculated; connections that would form a loop
  are refused. The graph is saved in the project file (`nodeGraph`, including the shapes taken from the bed) and
  remembered between sessions. *Live* option on the source node: follows changes of those shapes on the bed and
  recalculates at once. *Templates:* six included workflows (coaster set, sign with two holes, photo on slate, round
  photo with cut-out, nest parts, large design in tiles), own templates saved by name, and templates as `.cncgraph`
  files to share. Templates keep only the workflow, not the taken shapes – loading one keeps the shapes already
  taken, so the same motif can be tried with different workflows

**Improved**
- **Rotary checks the connected controller:** the A-axis mode is refused for Ruida, K40 and Marlin (their
  translators drop A values, everything would be engraved on one line) – both when the G-code is made and when a job
  is started; the panel explains that the A axis needs grblHAL, FluidNC or Grbl_ESP32 with a 4th axis. Warning when
  a GRBL board reports no 4th-axis settings ($103 missing, plain GRBL would stop with error 20), and on Ruida a
  reminder to switch the controller's own rotary function off so Y is not converted twice
- **Tidier toolbars:** related buttons now sit in groups that open when you move the mouse over them (or click),
  with icon, name and shortcut. Top bar in one row: *Combine* (union, subtract, intersect, split, weld & score),
  *Edit* (offset, round corners, pattern fill, fix centred, tiles, split into parts), *Image* (mask, split),
  *Rotate/mirror* and *Align*; file, undo, copy/paste/duplicate/delete, group and view stay single buttons. Left bar
  from 20 to 10 buttons: *Shapes* (line, rectangle, ellipse, polygon, arc), *Curves* (draw curve, edit points),
  *Measure* (measure, dimension) and *Extras* (nesting, box generator, shape library, 3D view, node graph). A tool
  group shows the last used tool and selects it with one click; keyboard shortcuts work as before and switch the
  group icon too. Corner radius and number of corners in the top bar only appear while that tool is active
- **Tidier right side:** sections remember whether they are open or closed; rarely used ones (origin, work area,
  rotary, material plate, probing) start closed. *Object* tab without a selection shows only the layers and a short
  hint instead of empty fields. *Machine* tab: a fixed bar at the top always shows state, position, job progress and
  Start/Pause/Stop while you scroll; *Connection* closes by itself once connected (opens again after disconnecting)
  and manual jogging moved up. The console remembers when it is folded, counts new messages in its header and opens
  by itself on errors or alarms
- **Round box is much easier to assemble:** a ring with tabs now sits on top (like the bottom), so the bent wall
  holds its shape by itself – no more holding the curve while the glue dries. The seam moved from the front corner
  to the middle of the longer straight side and locks like a puzzle (dovetail knobs into matching sockets, placed
  between two tabs); the living hinge reaches a little into the straight parts so the curves bend evenly. The lid's
  inner plate fits into the ring
- **Four new box types:** *sorting box with lid* (dividers one material thickness lower so the two-part lid fits),
  *round cup* (round box without lid – pens, brushes), *lantern / tea-light house* (arched windows in all four
  walls, vent hole in the lid) and *money box* (coin slot up to a 2-euro coin, round hole in the bottom with a
  two-disc plug)
- **Four more box types:** *tissue box* (long opening with round ends in the lid), *birdhouse / nest box*
  (entrance hole up to 32 mm high in the front, vent holes in the sides, drain holes in the bottom), *planter*
  (6 mm drain holes in the bottom) and *index box / tray* (half-round finger notch at the top of the front)

**Fixed**
- Open sections in the right panel were cut off at 500 px – long sections now show completely
- **Probing could move up instead of down:** the target was calculated from the work position, but GRBL sends the
  work offset (WCO) only now and then – with an outdated value the target lay above the bit. Probing and lifting now
  move relative (G91 G38.2 Z−…, always back to G90 afterwards), so the direction no longer depends on reported
  positions
- **Probing safety guard:** while probing runs, the status is polled faster and checked on every report – if the probe
  reports contact but the machine keeps moving (e.g. during the fast lift/travel to the tool sensor, or when the
  board does not evaluate the probe input), or Z rises during a downward probe, the machine is stopped at once
  (feed hold + reset) with a clear message. Each phase is logged (search, measure, lift, travel). The tool sensor
  only runs after its position was set. New live line in the probing section shows "Probe: open / contact" so you
  can test the clamp before probing
- **Tool sensor measurement:** the guard switches itself on again as soon as the probe opens after a measurement (it
  ignored the probe for the whole lift before, so pressing it did not stop the move); after lifting before the
  sensor travel the search distance grows by the same amount (it searched only the normal distance and never reached
  the sensor); lift is limited to 30 mm (100 mm ran into the Z limit switch). Before travelling to the sensor Z only
  goes up as far as just below the top (machine Z −1 mm) – when it is already up there it goes straight to the
  sensor and probes downwards
- **Probing works with interference on the probe input (like Estlcam):** on the Arduino CNC Shield the probe input
  picks up a pulse from the stepper signals about every 0.3 mm while moving; GRBL's G38.2 stops at every one and a
  pulse right at the start gives alarm 4. Probing is now done by CNC Craft itself: Z moves down as a jog, the status
  is polled quickly and only a contact that is closed in two reports in a row counts; then the jog is cancelled
  cleanly (no reset, no alarm) and the position after stopping is the contact height. If the probe is open again
  after stopping, the search continues with the rest of the distance. Fast search at most 150 mm/min, the result
  comes from the slow measurement. After the fast contact Z goes up 2 mm (more, up to 8 mm, while the probe is still
  closed); if the slow contact lies more than 0.5 mm BELOW the fast one, the fast one was interference and Z is not
  set. After measuring Z always goes up (at least 2 mm, 5 mm when nothing is set). The guard only stops a move after
  two reports in a row and stays quiet until the machine has stopped after a contact (it used to reset while the jog
  was still braking → alarm 3)

## 0.3.0 Beta

**New**
- **Release the machine with one key (F11, like Estlcam):** the 🔓 button now does a reset first and then clears the
  alarm ($X). After a limit switch alarm GRBL only accepts $X after a reset, so “Unlock” alone often did not work and
  the board had to be restarted. If a limit switch is still pressed, hard limits ($21) are switched off briefly so
  you can jog away; they turn back on by themselves as soon as all switches are free (also restored on the next
  connect if the connection drops)
- **Dimensions and constraints:** new *Dimension* tool (D) – click shape A, then shape B (corner, edge middle or
  centre snaps; clicking inside a hole picks the hole), then place the dimension line (mouse beside = vertical,
  above/below = horizontal). The dimension stays on the canvas: when the reference shape is moved or resized, the
  other shape (with its group) follows; moving the dependent shape itself just updates the value. Double-click the
  number to type a new distance. Clicking the same shape twice gives a size dimension (width/height) – double-click
  to set a new size. Click a number and press Del to remove it. New toolbar button *Fix centred*: the selected parts
  always stay centred on the largest selected shape (e.g. a hole in a plate), shown with ⊕. Dimensions are saved
  in the project and are part of undo
- **Curves with points and handles (Bézier):** two new tools in the left toolbar. *Draw curve* (B): click = corner,
  click and drag = smooth point with handles, click the first point = close, double-click/Enter = finish open,
  Esc = cancel. *Edit points* (N): click any contour (lines, rectangles, circles and polylines are converted) –
  drag nodes, drag handles (smooth points keep both sides in line, Alt = only one side), drag a line between two
  nodes to bend it, double-click a line to insert a node, double-click a node to switch corner ↔ smooth, Del deletes
  the selected node. Curves stay editable after moving, scaling, rotating and mirroring and are saved in the project;
  G-code, nesting and offsets use the smooth contour (max. 0.02 mm deviation)
- **Material view:** new selector in the toolbar (🪵) – light wood (birch), dark wood (walnut), black and clear
  acrylic, leather, slate, cardboard, anodized aluminium. The bed shows the material surface at real scale,
  engravings appear in the burn colour of the material (dark on wood/leather, light on acrylic/slate/aluminium),
  cuts as a gap; images too. Laser: fill layers = engraved area, line layers = engraved line, strong line layers
  (from 70 %) = cut; mill: pockets recessed, other paths as gaps. Display only – the G-code does not change
- **Image effects** (engraving window, new row of buttons): stippled dots (jittered), spiral (one continuous spiral
  from the centre, thicker where dark), wavy lines and crosshatch (more layers the darker it is). Screen size and
  angle adjustable; also in the expert method list
- **Pattern fill:** select a closed area (e.g. a coaster) together with a motif – the area is filled with copies of
  the motif in a grid (horizontal/vertical spacing, every 2nd row offset, centred). Only whole motifs, or clipped at
  the edge for closed motifs. Each copy is its own group
- **Weld and score:** overlapping parts (e.g. script lettering, overlapping shapes) become one cut contour; the
  visible transitions – edges of an upper part that lie on a lower one – stay as score lines (laser: the weakest line
  layer, mill: 0.3 mm deep). Drawing order decides what is on top
- **Split image:** select an image and one or two straight lines – nearly vertical lines split left/right, nearly
  horizontal ones top/bottom. Each piece becomes its own image with the same engraving settings (mask carried over);
  the lines are removed
- **Nest inside your own contour (offcut):** select a closed shape (e.g. an offcut or a round disc) together with the
  parts and tick “Nest inside the largest selected contour” – the parts are placed only inside it, “margin” is the
  distance to its edge, holes inside the contour are avoided
- **Image: remove background** (engraving window): the colour of the image border counts as background; everything
  connected to the border within the tolerance is not engraved – good for product photos and logos on a plain
  background. Areas enclosed by the motif stay
- **Image mask:** select an image and a closed contour, click the new mask button – the image is engraved only inside
  the contour (moves, scales and rotates with the image). The contour stays so it can be cut out; select only the
  image and click again (or “Remove mask” in the engraving window) to remove the mask
- **Shape tools (new group in the toolbar):** *Union* merges the selected shapes into one area, *Subtract* removes
  all other selected shapes from the largest one (holes, cut-outs), *Intersect* keeps only the overlap. A group
  counts as one part, so holes of imported parts stay holes; the result gets outside/inside and keeps tool, laser
  layer, plasma cut and depth. *Split* cuts closed shapes with an open line, polyline or arc (selected together; the
  cutting line is removed). *Round corners* gives every real corner of rectangles and closed polylines an arc or a
  chamfer with the chosen radius (smaller on short edges, curves stay as they are). Uses the library
  polygon-clipping (MIT)
- **Image engraving (laser):** when you import a photo or picture (PNG, JPG, BMP, GIF, WEBP) you now choose
  “Engrave” or “Trace” (as before). Engrave inserts the picture as an image on the canvas – move, scale, rotate and
  mirror it like any other shape; it shows exactly what will be burned. The engraving window (double-click the image)
  has a before/after preview with a draggable divider (whole image or 100/200/400 %), six **engraving types** –
  photo (Jarvis), graphic (Atkinson), black & white, line engraving, dot screen and newspaper (45° halftone) –
  **auto enhance** (stretches the tones, balances the midtones, sharpens a little) with a **rating** before → after
  (contrast, detail, brightness, pure black/white), sliders for brightness, contrast, gamma, sharpness, denoise,
  black/white point and invert (acrylic, slate), and an expert section with all **dithering methods**
  (Jarvis, Floyd-Steinberg, Stucki, Atkinson, Sierra, Bayer, halftone, line screen, threshold, grayscale with power
  modulation). Line interval (with DPI), minimum power for grayscale and overscan are adjustable; estimated time
  shown. G-code: line by line, alternating direction, empty margins skipped, laser on only where it burns, works for
  rotated images too. New images go to the engraving layer (power/speed from the layer). In mill and plasma mode
  images are skipped with a note

**Fixed**
- **Used material area was shared by all beds:** every bed now has its own material plate. A job marks the used
  area only on the bed it was started from, and bed 2, 3 … no longer show the hatching of bed 1. New *Clear plate*
  button (🧱) in the bed bar frees the used area of the active bed without restarting the app
- **Job aborted with an unclear reason:** when the board restarts by itself in the middle of a job, the console now
  says so (“the board restarted by itself – usually interference from the spindle or a weak power supply”)
  instead of just “reset”
- **Trace image did not open in some web views:** the picture is now loaded with `onload` instead of `decode()`,
  which could hang when the image was not part of the page
- **Message when no G-code was made:** shows the actual reason (e.g. “images are only engraved with the laser”)
  instead of “no objects”
- **Wiring diagram – terminal labels on top of the part name:** the outer terminals of the CO2 laser power supply
  (AC L, AC N, Anode, Cathode) were labelled inside the box, right over its name. Outer terminals are now labelled
  outside the box

## 0.2.9 Beta

**New**
- **Nesting (like “Nest” in LightBurn):** new icon on the left below “Measure” – packs the parts (selection, otherwise
  everything) tightly on the bed. Settings: spacing between parts, distance to the bed edge, rotation (off / 90° / 45° /
  automatic – tries every 15° step and the angle with the smallest bounding box, but only rotates when it saves space),
  small parts inside holes of large parts, **start point** (top/middle/bottom × left/center/right) and **direction**
  (right, left, up or down – for “center” the finished block is moved to the middle). Parts are placed by their real
  shape, groups and holes stay with their part, unselected shapes stay in place and are avoided. Undo with Ctrl+Z
- **Duplicate with a count or “fill the bed”:** the duplicate button in the toolbar now opens a dialog – enter the number
  of copies or choose “As many as fit on the bed”, optionally nested right away (spacing and edge distance in the dialog,
  rotation, start point and direction as in Nesting). Copies that no longer fit are left out. Ctrl+D still makes one
  quick copy

- **Pocket milling:** “Pocket” now really clears the area (before, the shape was skipped with a warning). Both
  modes from “Pocket mode”: *Parallel* = zigzag passes, *Contour* = rings from the inside out; each finished with a
  clean pass along the wall. Shapes inside the pocket (e.g. text, circles) stay standing as islands. Works for closed
  polylines and circles; stepover 40 % of the bit diameter. The canvas shows the pocket area filled in tool colour

- **Holding tabs (like Estlcam):** under “Milling parameters” set the number of tabs, tab length and tab height for the
  selected shapes. When cutting out (Outside/Inside, closed contours and circles) the tabs are spread evenly; only the
  passes deeper than the tab top move up to tab height over the tab (not all the way up). Tabs are shown as yellow
  marks on the canvas. **Automatic or placed by hand:** “Tabs: Automatic” spreads the count evenly; with “Place tabs”
  you click on a contour to add a tab and on a yellow tab to remove it (automatic tabs are taken over first). Tabs
  placed by hand stay on the contour when the part is moved, rotated or scaled; cutting always starts in the largest
  gap between tabs, never on a tab. **Laser and plasma too:** there the tab has no height – the laser switches off
  (S0) and jumps over the tab; the plasma torch switches off and pierces again after the tab (full pierce sequence,
  no overcut into a tab). The gap on the path is tab length + kerf. Tab settings now have their own panel section
  in all three modes (height only for the mill).
  Warnings if the tabs are higher than the cut depth or do not fit on the contour. The old
  “Holding tabs (mm)” field only worked for single lines and lifted to safe height

- **Detect material with the camera (beta):** new button “🧱 Material (beta)” in the camera window. Works with a
  normal USB webcam once the camera is aligned (🎯): capture the empty bed, put the material on, detect. The sheet
  (also rotated) and its holes/offcuts are found by comparing with the empty bed (fallback without empty-bed image:
  brightness). Preview with green = material, red = holes; drag the four corners to correct by hand; sensitivity and
  minimum hole size adjustable. “Apply” marks everything without material as used in the material sheet. Clearly
  marked as beta with step-by-step guide and tips (light, move the head out of the picture …). It only detects where
  material lies, not which material – that stays the user’s choice (safety, e.g. PVC). Tested with synthetic camera
  images, not yet with a real camera

- **Box generator (like boxes.py):** new box icon in the left toolbar. Width, depth, height (outside or inside),
  material thickness, finger width, with/without lid and kerf; live preview of the panels. Creates 5 or 6 finger-jointed
  panels on the bed (selected, ready to nest). The joints are checked: the panels fill the box walls exactly – no
  overlaps, no gaps (corners belong to front/back). Box types: box with lid, open box, divider tray (dividers across/
  lengthwise with tabs in wall slots, half-lapped where they cross), carrying box (handle holes), drawer (larger front
  plate with finger hole) and box with lift-off lid (two-layer lid). Slots and holes are grouped with their panel.
  **Three more types:** *box with sliding lid* (lower front, liner strips inside carry the lid, retaining strips guide
  it; finger grip in the lid – joints checked like the other boxes), *shelf* (open front, shelf boards with tabs in
  slots of the side walls) and *round box* (corner radius adjustable; the wall is one strip with a living hinge in the
  curves, laser only – the bottom has tabs on the straight sides that sit in notches of the strip; two-layer lid)
- **Several beds in one project (like build plates in Bambu Studio / OrcaSlicer):** all beds lie on the canvas in a grid,
  three per row (from bed 4 on a new row below), with name and part count above each; the active bed is shown normally, the others dimmed. Click an empty spot
  of another bed to switch to it (the view stays put), drag parts onto another bed to move them there. Tab bar above
  the canvas as well – one tab per bed, “＋” adds a bed, double-click the active tab to rename it. Drawing, nesting,
  G-code, simulation and the job always use the active bed, so you work through the beds one by one.
  “✓ Done” marks a finished bed, “Move selection …” puts selected parts (whole groups) on another or a new bed,
  🗑 deletes a bed. Undo works per bed. Nesting has a new option “What doesn't fit → onto more beds”: parts that no
  longer fit go to the next bed (created if needed) and are nested there, until everything is placed. The project file
  (.cncc) keeps all beds in one file (older versions simply see all parts on one bed); the G-code file name contains
  the bed name when there are several beds
- **Wiring diagram for Ruida RDC6445G/S (CO2 laser controller):** board drawn after the Ruida manual (CN0 power,
  CN1 outputs, CN2 inputs, CN3/CN4 limits, AXIS_X…U, CN5/CN6 laser) with plans for power, external drivers (common
  anode), limit switches/NPN sensors, CO2 laser PSU + water flow switch, air relay, door and E-stop, plus a new
  “Inputs/outputs” plan (foot switch, manual laser button, status lamp) as in the manual’s overall wiring diagram;
  the laser PSU shows its mains (AC L/N) and tube (anode/cathode) terminals. Pin names are
  printed vertically like on the board; light housings get dark labels
- **Probing / tool length (mill, GRBL/grblHAL):** new section in the “Machine” tab. *Touch plate*: enter the plate
  thickness, Z probes down until contact and sets Z = plate thickness. *Tool length sensor*: sensor position (machine
  coordinates, “use current position”), height of the trigger point above the bed and material thickness – the tool is
  measured at the sensor and Z is set so that Z = 0 is on the workpiece top (Z at trigger = trigger height − material
  thickness). Two-step probing (fast search, back off 2 mm, slow measure), adjustable search travel, feeds and lift;
  aborts if the probe is already triggered or no contact is made
- **Test limit switches (GRBL):** with hard limits ($21=1) every press of a limit switch causes alarm 1 – even when
  standing still. “🧪 Test limit switches” at the input lights switches $21 off for the test and back on afterwards; if
  the connection drops during the test, $21=1 is restored on the next connect. The alarm 1 message now points to it
- **Reverse spindle direction:** if the spindle turns the wrong way (wiring), a tick in the spindle control swaps
  M3/M4 for the manual control and the generated mill G-code; the status shows the real direction

**Improved**
- **Nesting uses only free material:** used area of the material sheet (from jobs or the camera) and everything
  outside the sheet is avoided, with the same clearance as “lies on used area” (tool width + safety distance)
- **Single arcs outside/inside:** an arc on its own can now be milled outside (away from its centre) or inside
  (towards its centre) – still as a true G2/G3 arc. The tool band on the canvas follows
- **Outside/Inside/Pocket for lines and arcs:** separate lines and arcs whose ends meet are now joined into one closed
  contour when you choose Outside, Inside or Pocket – so a shape drawn from single arcs and lines can be milled outside
  or inside. Segments that do not close stay “on the line”, and the console says so (before, the console said
  “Outside” but they were silently cut on the line)
- **Faster website:** images as WebP in three sizes (phone 480 px, 960 px, large only when zoomed), hero image loads
  first, the video only when scrolled into view, CSS inlined, small logo – hero image 58 KB instead of 262 KB, 8 KB on
  phones. Links in text underlined, subtitle track for the video (accessibility).
  The site is generated with `tools/website/build.py`

**Fixed**
- **Wiring diagram CNC Shield V3 – spindle:** the 0–10 V converter and the relay were both drawn on the same pin
  (Z−). The converter is now on Z+ (also D11 on the shield), shows its own supply (+24V/0V) and its output to the
  VFD (AVI/ACM); the note says that usually only one of the two is needed (router via relay OR VFD via converter)
- **Inside offset failed on curved shapes:** for shapes made of many short segments (arcs, circles from polylines)
  the inside offset sometimes returned nothing at certain tool radii (e.g. exactly 1.5 mm = 3 mm bit), so “Inside”
  or a pocket was skipped with “tool does not fit”. Also removed occasional duplicate contours

## 0.2.8 Beta

**Neu**
- **Anschlussplan – Mikroschritte:** in „Schrittmotoren“ Treiber (A4988, DRV8825, TMC2208, TMC2209) und Mikroschritte wählen –
  die Zeichnung zeigt die Jumper M0/M1/M2 unter jedem Treiber (CNC Shield) bzw. die DIP-Schalter (MKS DLC32 / MAX),
  dazu die passenden Schritte pro mm für Zahnriemen und T8-Spindel
- **Anschlussplan – A-Achse klonen (CNC Shield):** „A-Achse klont X/Y/Z“ zeigt, wo die zwei Jumper für einen zweiten
  Motor (X2, Y2, Z2) hingehören (links A.STP, rechts A.DIR)
- **Anschlussplan – Externe Treiber:** neuer Bereich für TB6600/DM542 an allen Boards – Steuerleitungen (PUL/DIR/ENA mit
  gemeinsamer Masse) an die STEP/DIR-Leiste des Shields bzw. „E S D G“ der MKS-Boards, Motor und eigenes Netzteil am
  Treiber, DIP-Schalter, $0 und Schritte pro mm
- **Webseite** (GitHub Pages, Ordner `docs/`): Englisch und Deutsch, Download-Knopf mit der passenden Datei für
  Mac, Windows oder Linux, Funktionen, Bilder und häufige Fragen; ohne Tracking und ohne Cookies
- **grblHAL flashen:** im Reiter „Board flashen“ kann jetzt direkt die **.zip vom grblHAL Web Builder** gewählt werden.
  CNC Craft erkennt Bootloader, Partitionstabelle und Firmware mit ihren Adressen (ESP32: 0x1000, ESP32-S3: 0x0 /
  0x8000 / 0x10000) und flasht alles in einem Durchgang mit MD5-Prüfung. Gesperrt wird, wenn die Firmware für ein
  anderes Board gebaut ist (z. B. MAX-Firmware auf normalem DLC32), der Chip nicht passt oder der Flash zu klein ist.
  Neue Hilfe „grblHAL zusammenstellen“ mit dem genauen Board-Namen für den Web Builder (z. B. „MKS DLC32 MAX v1,
  8MB+ flash“)
- **grblHAL-Anleitung für die MKS DLC32 MAX im Reiter „Board flashen“** (jedes Board bekommt seine eigene, sie erscheint
  nur beim passenden Board): was im Web Builder auf welchem Reiter anzuhaken ist (General,
  Network/WebUI mit dem Hinweis, dass „Telnet server“ selbst angehakt werden muss, Plugins), was nach dem Flashen zu
  tun ist (USB, WLAN, Verbinden über Port 23) und wie die Weboberfläche aufs Board kommt (index.html.gz hochladen –
  nach jedem Flashen neu) – inkl. Login admin/admin bzw. user/user und Passwort ändern mit $330/$331
- **Zurück zur Original-Firmware der MKS DLC32 MAX:** eigener Abschnitt im Reiter „Board flashen“ – wo die Firmware
  bei Makerbase liegt (.rar erst auspacken), was danach zu tun ist (WLAN mit $50–$54 oder eigenes WLAN der MAX,
  Verbinden über Port 8080). Beide Anleitungen sind eingeklappt und werden nur bei Bedarf aufgeklappt
- **$$-Einstellungen für grblHAL:** die Seite fragt grblHAL nach seinen Einstellungen ($EG/$ES/$ESG) und zeigt sie
  nach den Gruppen des Boards (Spindel, Referenzfahrt, WLAN …) – mit passenden Feldern: Ja/Nein, Achsen-Masken,
  Optionen einzeln abhakbar, Auswahllisten, Passwörter verdeckt, Wertebereich und Hinweis „wirkt erst nach Neustart“.
  Wichtige Werte ($8 Doppelmotoren, Pull-ups, Spindel-PWM, $37, Referenzfahrt $43–$49, WLAN, $300, Werkzeugwechsel,
  Auto-Squaring …) sind in allen 7 Sprachen erklärt, die übrigen mit dem englischen Text von grblHAL. Wichtig:
  Werte wie $4, $21, $22 sind bei grblHAL Masken – die Seite schreibt sie jetzt richtig. Noch nicht an echten
  grblHAL-Boards getestet – Rückmeldungen willkommen
- **Anschlussplan – Motor A als X, Y oder Z:** beim CNC Shield V3 Schritt für Schritt, wie die zwei Jumper neben dem
  A-Steckplatz gesetzt werden (inkl. Warnung: „D12/D13“ nicht mit GRBL 1.1, kein Auto-Squaring). Bei der MKS DLC32 MAX:
  mit der MKS-Firmware ist A eine eigene Achse – für einen eigenen zweiten Motor (z. B. doppeltes X, Y mit
  Auto-Squaring) grblHAL über den grblHAL Web Builder (Board „MKS DLC32 MAX v1“, noch experimentell), Richtung mit $8

**Verbessert**
- **Anschlussplan:** MKS DLC32 V2.1 und MKS DLC32 MAX sehen jetzt aus wie das echte Board – schwarze Platine,
  Stecker an derselben Stelle wie im Makerbase-Pinplan, beim MAX in den Original-Farben (X rot, Y blau, Z grün,
  A lila …), Treibersockel mit DIP-Schaltern, Funkmodul, USB, SD und Hohlstecker. Die Farbmarkierung je Bauteil
  liegt als Rahmen außen herum, damit die Steckerfarbe erkennbar bleibt
- **Anschlussplan:** Maus über ein Kabel oder einen Pin hebt das Kabel hervor (dick und leuchtend, die anderen werden
  blass) – der Tooltip zeigt, von wo nach wo es geht (z. B. „Motor Y2 · 2B → Y2-Motor · 2B“)
- **Anschlussplan CNC Shield V3:** sieht jetzt aus wie das echte Shield (Plan „CNC Shield V3.00“, rote Nachbauten wie
  Osoyoo) – Arduino-Form, blaue Schraubklemme, gelbe Treiber-Sockel mit M0/M1/M2, Endschalter-Leiste rechts, SCL oben
  rechts, echte Pin-Abstände. Motoren Z und A werden unten angeschlossen gezeigt (weniger Kabelsalat)
- README jetzt auf Englisch (Startseite bei GitHub, besser über Google zu finden), deutsche Fassung in `README.de.md`;
  englische README mit englischen Screenshots (`docs/screenshots/en/`);
  GitHub-Projekt mit Beschreibung, Themen (Topics) und Discussions
- README: neuer Abschnitt „Mitwirken“ – wie man helfen kann und offener Hinweis, dass beim Programmieren das
  KI-Werkzeug Claude Code hilft
- **Laser „Füllen + Linie“ mit getrennter Leistung:** die Fläche hat jetzt eigene Werte „Leistung (Füllen)“ und
  „Geschwindigkeit (Füllen)“ – z. B. leicht gravieren mit 30 % und schnell, danach kräftig schneiden mit 100 % und
  langsam. Leistung/Geschwindigkeit oben gelten dann für die Linie. Bestehende Ebenen behalten ihre bisherigen Werte

**Behoben**
- WLAN einrichten mit grblHAL: 📡 WLANs in der Nähe werden jetzt über die Weboberfläche des Boards geholt
  (über USB/Telnet kennt grblHAL das nicht, es kam „Fehler 1“). Geht es nicht, steht der genaue Grund da
- WLAN einrichten mit grblHAL: der Name der Maschine wird jetzt in $320 geschrieben (Name im Heimnetz bei ESP32-Boards) –
  vorher in $300, das nur für Kabel-Netzwerk gilt
- **$$-Seite:** Ja/Nein-Felder zeigten „Spindel an/aus“ statt „Ein/Aus“. Neben Haken-Feldern (Achsen-Masken,
  grblHAL-Optionen) steht jetzt zusätzlich der Gesamtwert als Zahl – zum Ansehen und direkt Eintippen
- **$$-Seite:** WLAN-Passwörter von grblHAL ($75/$77) wurden in der einfachen Ansicht offen angezeigt – jetzt in jeder
  Ansicht verdeckt. Außerdem bleiben die grblHAL-Beschreibungen beim Umschalten zwischen Maschinen erhalten (fehlen sie,
  werden sie einmal automatisch nachgeladen)
- **WLAN einrichten mit grblHAL:** schaltet jetzt auch Telnet ein ($70), falls es aus ist – ohne Telnet konnte CNC Craft
  die Maschine per WLAN nicht finden (grblHAL nutzt Port 23 statt 8080 wie die MKS-Firmware). Danach startet das Board
  mit $REBOOT neu
- grblHAL auf MKS-Boards: CNC Craft schickt kein `[ESP800]` mehr (gab „Fehler 1“ in der Konsole)
- Einstellungen nach dem Flashen zurückspielen: nach einem Firmware-Wechsel (z. B. MKS → grblHAL) werden nur noch die
  Werte geschrieben, die bei beiden dasselbe bedeuten – vorher konnten z. B. $40–$54 falsch belegt werden
- Flashen trennt nur noch die Verbindung, die genau diesen Port benutzt – andere Maschinen bleiben verbunden
- **📡-Suche trennte eine verbundene WLAN-Maschine:** ESP32-Boards (z. B. MKS DLC32) erlauben nur eine Verbindung –
  die Suche nach einer weiteren Maschine hat die bestehende rausgeworfen. Jetzt lässt die Suche verbundene Maschinen
  in Ruhe und zeigt sie als „verbunden als Maschine 1“ an
- Dieselbe Netzwerk-Maschine kann nicht mehr doppelt verbunden werden, auch nicht einmal per Name und einmal per IP
- Mehrere Maschinen: beim Umschalten zeigt das Port-Feld jetzt den Anschluss der ausgewählten Maschine
  (WLAN: „Netzwerk“ mit ihrer IP) – vorher stand dort noch der Port der zuletzt verbundenen

## 0.2.7 Beta

**Neu**
- **Mehrere Maschinen gleichzeitig:** im Reiter „Maschine“ mit „➕ Weitere Maschine“ eine zweite (dritte …)
  Maschine verbinden – z. B. Laser per USB und Fräse per WLAN. Die Liste zeigt alle Maschinen mit Status und
  Job-Fortschritt; anklicken = auswählen. Befehle, Joggen, Konsole, $$ und Jobs gehen immer an die ausgewählte
  Maschine, die anderen arbeiten im Hintergrund weiter. Beim Umschalten wechseln Maschinenart (Fräse/Laser/Plasma),
  Zeichenfläche und Profil automatisch mit. Meldungen aus dem Hintergrund stehen mit „[Maschine 2]“ in der Konsole,
  die Restplatte wird auch nach Hintergrund-Jobs eingetragen – bei der richtigen Maschinenart
- **⛔ Alle stoppen:** hält laufende Jobs auf allen verbundenen Maschinen sofort an (Laser/Spindel aus).
  Beim Schließen des Programms werden alle Maschinen sicher angehalten
- Ein Anschluss kann nicht zweimal verbunden werden (Meldung statt Durcheinander)

## 0.2.6 Beta

**Neu**
- **Update direkt aus der App:** im ⓘ-Fenster gibt es bei einer neuen Version „Jetzt aktualisieren“. CNC Craft lädt
  das Update selbst, prüft die Unterschrift, installiert es und startet neu – kein Deinstallieren, kein Herunterladen
  im Browser mehr. Auf dem Mac entfällt dabei das „Trotzdem öffnen“. Während ein Job läuft, ist es gesperrt.
  Wirkt ab dieser Version: auf diese Version bitte noch ein letztes Mal von Hand aktualisieren
- **G-Code-Icons in der linken Werkzeugleiste:** unten in der Leiste gibt es jetzt drei Icons für
  „G-Code erzeugen“, „G-Code speichern“ und „Simulation“ – gleiche Funktion wie die Knöpfe im rechten Panel
- **Verbrauchte Fläche wird nicht mehr geschnitten:** Formen, die auf schon verbrauchter Fläche der Platte liegen
  (rot markiert), kommen nicht mehr in den G-Code – auch nicht in Simulation, Rahmen-Fahrt und Job. Die Konsole sagt,
  wie viele weggelassen wurden. Bei Gruppen fällt die ganze Gruppe weg. Abschaltbar in „Material-Platte“ mit
  „Formen auf verbrauchter Fläche nicht schneiden“
- **Freischnitt beim Laser:** neue Einstellung „Freischnitt (Anfahrlänge)“ je Laser-Ebene (Linie). Bei geschlossenen
  Konturen startet der Laser so viele mm daneben im Abfall – außen vor dem Teil, bei Löchern im Loch – und fährt
  dann an einer Ecke auf die Kontur. So gibt es keinen Einbrandpunkt an der Kante. Standard 0 = aus.
  (Beim Plasma gibt es das schon: „Anfahrlänge (Lead-in)“ je Schnitt)

**Behoben**
- **Plasma mit „Blechhöhe abtasten“:** am Jobende wird die Z-Verschiebung vom Abtasten (G92) mit G92.1 wieder
  aufgehoben. Vorher blieb sie nach dem Job aktiv, und Z stimmte beim nächsten Job oder beim Fahren von Hand nicht

**Sicherheit**
- **Content-Security-Policy eingeschaltet:** die Oberfläche führt nur noch Programmcode aus, der zur App gehört.
  Selbst wenn einmal fremder Text (z. B. von einem Board oder aus einer Datei) als HTML landen sollte, kann er
  keinen Code mehr starten. Verbindungen ins Internet nur noch zur Update-Prüfung (GitHub); Kamerabilder aus dem
  Netz und der STEP-Import funktionieren weiter

**Projekt**
- README mit Bildern der App (Design, Simulation, Laser, Plasma, Anschlussplan)

## 0.2.5 Beta

**Sicherheit**
- **Dateirechte enger:** die App darf nur noch Dateien lesen und schreiben, die du selbst im Öffnen- oder
  Speichern-Dialog ausgewählt hast (vorher: jede Datei auf dem Rechner). Ziehen aufs Fenster geht weiter wie bisher
- Projekt speichern hängt „.cncc“ nicht mehr selbst an – die Endung kommt vom Speichern-Dialog

## 0.2.4 Beta

**Sicherheit (bitte updaten)**
- **Trennen oder Programm schließen während eines Jobs:** die Maschine wird jetzt vorher sicher angehalten
  (GRBL: Vorschub-Halt, dann Reset – Laser/Spindel aus). Bisher fuhr sie den gepufferten G-Code noch zu Ende,
  und Laser/Spindel konnten danach eingeschaltet bleiben
- Texte von außen werden nicht mehr als HTML ausgeführt: USB-Gerätenamen, Firmware-Antworten von Boards,
  importierte Bibliotheken (Werkzeuge, Laser-Ebenen, Plasma-Schnitte) und eigene Sprachpakete können keinen
  Code mehr in die Oberfläche einschleusen
- `withGlobalTauri` ausgeschaltet (wurde nicht gebraucht)

**Neu**
- **Name der Maschine** im WLAN-Dialog (z. B. „laser-garage“): wird als Netzwerk-Name aufs Board geschrieben
  (Grbl_ESP32/MKS: [ESP112], FluidNC: $Hostname, grblHAL: $300) – auch ohne WLAN-Daten, nur zum Umbenennen.
  Die Maschine ist dann auch als laser-garage.local erreichbar
- **📡-Suche zeigt den Namen** jeder Maschine; Hinweis, wenn mehrere gleiche Boards nicht zu unterscheiden sind
- Verbindungs-Info zeigt den Namen im Netz
- **❤️ Unterstützen:** ❤️-Knopf oben rechts (Ko-fi und GitHub Sponsors), Abschnitt im ⓘ-Fenster und im README,
  „Sponsor“-Knopf auf GitHub; kleiner Hinweis nur nach dem 5., 25. und 100. fertigen Job, mit „Nicht mehr
  anzeigen“ – freiwillig, alle Funktionen bleiben für alle frei

**Verbessert**
- Neue IP automatisch finden: hat die Maschine einen eigenen Namen, wird nur die Maschine mit genau diesem Namen
  genommen – bei mehreren gleichen Boards verbindet sich die App nicht mehr versehentlich mit der falschen

**Projekt**
- CNC Craft steht offiziell unter **GPLv3** (LICENSE); THIRD_PARTY_NOTICES.md mit allen fremden Bestandteilen
  und ihren Quellen; PRIVACY.md (Datenschutz: keine Telemetrie, nur die abschaltbare Update-Prüfung)
- ⓘ-Fenster zeigt Lizenz und Datenschutz-Hinweis
- README: Abschnitte „Sicherheit und Haftung“, „Datenschutz“, „Code Signing Policy“ (Windows-Signierung über die
  SignPath Foundation ist beantragt)

## 0.2.3 Beta

**Neu**
- **📶 WLAN einrichten** (Reiter „Maschine“, bei Boards mit WLAN): Heimnetz oder eigenes WLAN des Boards setzen –
  auch mit Sonderzeichen, die GRBL unterwegs abfängt (! ? ~, Umlaute) oder als Kommentar liest (( ) ;):
  FluidNC bekommt sie %-kodiert, grblHAL schaltet sie kurz mit $39=0 frei, Grbl_ESP32/MKS DLC32 bekommen sie über
  die Weboberfläche des Boards. Das Passwort erscheint nie in der Konsole
- **Board-Auswahl im WLAN-Dialog:** Automatisch (erkannt), MKS DLC32 MAX / neuere MKS-Firmware ($50–$54),
  älteres MKS DLC32 / Grbl_ESP32 ([ESP100]), FluidNC, grblHAL – falls die Erkennung danebenliegt; wird gemerkt
- **MKS DLC32 MAX:** WLAN über die eigenen MKS-Einstellungen $50–$54 (per USB) bzw. [ESP401] über die
  Weboberfläche; die MAX wechselt sofort ins neue WLAN – danach prüft die App per USB, ob das Board angekommen
  ist, und zeigt seine neue IP (kein Neustart nötig)
- **WLANs in der Nähe auswählen:** das Board sucht selbst ([ESP410]) und zeigt die Netze mit Signalstärke und 🔒 –
  Namen anklicken statt abtippen
- **Erst-Einrichtung ohne IP:** Anleitung im Dialog über das eigene WLAN des Boards (MKS: „MKS_DLC…“,
  Passwort 12345678, 192.168.4.1), Knopf „WLAN des Boards einschalten“, 🔎 prüft vor dem Senden, ob das Board
  antwortet. Der Dialog liest per USB aus, ob das Board schon in einem WLAN hängt (dann wird dessen IP
  eingetragen) oder sein eigenes WLAN an hat, und prüft die Adresse alle paar Sekunden selbst
- **🏭 Werkseinstellung** im Reiter „Einstellungen ($$)“: Maschinen-Einstellungen ($RST=$), Nullpunkte ($RST=#)
  oder alles ($RST=*) zurücksetzen – vorher automatisch in eine Datei sichern, danach werden die Werte neu gelesen;
  Warnung, wenn „Alles“ bei ESP32-Boards die WLAN-Zugangsdaten löscht

**Verbessert**
- **WLAN-Suche 📡 zuverlässiger:** zuletzt benutzte/gefundene Adressen, Geräte aus der ARP-Tabelle und Namen wie
  fluidnc.local werden zuerst und mit langer Wartezeit geprüft (für „verschlafene“ ESP32-Boards); zu langsame
  Geräte werden ein zweites Mal gefragt; nur noch EINE Verbindung pro Port (ESP32-Telnet nimmt oft nur einen Client an)
- **Neue IP automatisch finden:** ist die Maschine unter der gespeicherten Adresse nicht erreichbar, sucht das
  Programm sie im Netz und verbindet sich mit der neuen Adresse (gleiche Firmware/gleicher Name wird bevorzugt)
- WLAN-Passwörter werden verdeckt: in der Konsole (z. B. bei $S) und im Einstellungs-Reiter ($52/$54)
- Fehlermeldungen beim WLAN-Senden zeigen die Antwort des Boards
- Konsole warnt bei Einstellungen mit Zeichen, die GRBL abfängt, statt ein verstümmeltes Passwort zu schicken

**Behoben**
- MKS DLC32 MAX: „Invalid $ statement“ beim WLAN-Senden ([ESP100]/[ESP101] gibt es dort nicht) und
  „Fehler 3 – Unbekannter $-Befehl“ beim Öffnen des WLAN-Dialogs ($AP/SSID)
- „Keine Antwort“ beim Umschalten des WLANs wurde als Fehler gemeldet, obwohl es geklappt hatte
- Einstellungen ($…) und ESP-Befehle ([ESP…]) werden unverändert gesendet – bisher wurden ( ) ; % und doppelte
  Leerzeichen entfernt (wie bei G-Code-Kommentaren)

## 0.2.2 Beta

**Neu**
- **Kamera 📷** (wie in LightBurn): frei verschiebbares Kamera-Fenster mit USB-Webcam oder IP-Kamera
  (ESP32-CAM, mjpg-streamer, Handy-App) – zuschauen, Foto speichern, Video aufnehmen, 180° drehen, spiegeln
- **Kamerabild auf der Arbeitsfläche:** entzerrt (Linse + Perspektive) unter der Zeichnung, live oder als
  Standbild – Teile genau aufs Material oder Reststück legen
- **Kamera ausrichten:** Assistent – Linse entzerren, dann 4 Punkte anklicken; der Laser kann dafür 4 Kreuze
  brennen (oder eigene Punkte wie die Bettecken), Lupe zum genauen Treffen, Prüfansicht mit 50-mm-Raster
- **Netzwerk-Suche 📡** (wie der IP-Finder in OpenBuilds): findet FluidNC, grblHAL, Grbl_ESP32 und
  MKS DLC32 im eigenen WLAN/LAN (Ports 23 und 8080, dazu 192.168.4.1 und xTool F1) – mit Firmware und
  Namen aus der Weboberfläche; Klick übernimmt die Adresse
- Ohne Port-Angabe wird beim Verbinden erst Port 23, dann 8080 (MKS-Original-Firmware) probiert
- macOS: Hinweistexte für die Erlaubnisse „Kamera“ und „Lokales Netzwerk“ (Info.plist, Entitlements)

**Behoben**
- Klick auf ⓘ (Info) oben rechts hat den aktuellen Reiter ausgeblendet

## 0.2.1 Beta

**Neu**
- **Bibliotheken sichern:** Fräswerkzeuge, Laser-Ebenen und Plasma-Schnitte als Datei exportieren
  und wieder importieren (Hinzufügen oder Ersetzen) – plus **Komplett-Sicherung** aller drei in einer
  Datei, z. B. vor einer Neuinstallation oder für einen zweiten Rechner
- **Laser-Bibliothek** und **Plasma-Bibliothek** als eigene Seite im Reiter „Werkzeuge“ (wechselt mit dem
  Modus), aufgebaut wie die Werkzeug-Bibliothek der Fräse: Liste, Kopieren, Reihenfolge, Standard (★),
  großer Editor mit Vorschau (Laser: Linie/Füllen mit Abstand und Winkel, DPI-Anzeige;
  Plasma: Seitenansicht mit Einstech- und Schneidhöhe, Anfahrt und Schnittspalt)
- Im Reiter oben **Fräse / Laser / Plasma umschalten** – zeigt jede Bibliothek, ohne den Maschinen-Modus zu ändern
- **Einstellungen überstehen Updates sicher:** alles wird zusätzlich als Datei im App-Datenordner
  gespeichert (eine Sicherung pro Tag, 14 Tage) und beim Start automatisch zurückgeholt, falls es fehlt.
  Der Ordner steht im Info-Fenster (ⓘ)
- Laser-Ebenen bekommen Material, Dicke und Notiz; Plasma-Schnitte Material, Blechdicke, Stromstärke und Notiz

## 0.2.0 Beta

**Neu**
- **3D-Modelle: STEP und 3MF** zusätzlich zu STL laden und als 2D-Kontur übernehmen
  (STEP über OpenCascade/occt-import-js, läuft im Hintergrund, ohne das Programm zu blockieren)
- **Anschlusspläne: Board-Auswahl** wie beim Board-Flasher (Liste nach Hersteller sortiert),
  neue Boards lassen sich einfach ergänzen
- **Update-Prüfung** über GitHub Releases (Info-Fenster ⓘ oben rechts): zeigt neue Versionen
  mit Änderungen und lädt die passende Datei für das eigene System herunter
- **Rechtes Panel in der Breite verstellbar** (Griff am linken Rand ziehen, Doppelklick = Standard),
  im CAM-Bereich und in der Simulation; die Breite wird gemerkt
- **Konsole in der Höhe verstellbar** (Oberkante ziehen, Doppelklick = Standard)

**Verbessert**
- Rechtes Panel ist standardmäßig breiter, die Konsole etwas kleiner – mehr Platz für die Einstellungen
- Anschlussplan-Seite lässt sich im Fenstermodus scrollen

**Bauen**
- Release-Workflow für macOS (Apple Silicon + Intel), Windows und Linux (GitHub Actions)

## 0.1.0 Beta

Erste öffentliche Beta: Design und CAM für Laser, Fräse und Plasma, Simulation, Maschinensteuerung
(GRBL/grblHAL/FluidNC, Marlin, Ruida, K40), Spindel/Laser/Plasma mit Overrides 10–200 % und THC,
Werkzeug-Bibliothek wie in Estlcam, Eingangs-Lämpchen für Endschalter und Taster,
Anschlusspläne, Board flashen, 7 Sprachen.
