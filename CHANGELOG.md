# Changelog

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
