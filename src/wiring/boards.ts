/**
 * ANSCHLUSSPLÄNE – Daten der Boards und was wohin kommt
 *
 * Quellen:
 *   - Arduino UNO + CNC Shield V3 mit GRBL 1.1h: Pin-Belegung aus GRBL cpu_map (ATmega328p,
 *     VARIABLE_SPINDLE an): Endschalter X=D9, Y=D10, Z=D12 (!), Spindel-PWM=D11, Richtung=D13,
 *     Abort=A0, Hold=A1, Resume=A2, Kühlung=A3, Nebel=A4, Taster=A5.
 *     Auf dem Shield heißt D12 noch „SpnEn“ und D11 „Z+/Z−“ (Beschriftung aus GRBL 0.9).
 *   - MKS DLC32 V2.1: Makerbase-Pinplan „MKS DLC32 V2.1_003 PIN“ + MKS-Firmware
 *     (i2s_out_xyz_mks_dlc32.h): Endschalter X=IO36, Y=IO35, Z=IO34, Taster=IO22,
 *     Laser/Spindel=IO32, Kühlung=IO4 (I2C-SCL).
 *   - MKS DLC32 MAX V1.0: Makerbase-Pinplan „MKS DLC32 MAX V1.0_002 PIN“.
 *   - PiBot FluidNC V4.96 Pro: PiBot-Wiki „Pin Definition Overview“ (wiki.pibot.com) + Test-YAML des Herstellers.
 *   - PiBot Controller V5.88 Ultra: PiBot-Wiki „Pinout Reference“ (Bild „V588 diagram V1“) + Test-YAML des Herstellers.
 *   - Ruida RDC6445G/S: Ruida „RDC6445G Control System manual V1.2“, Bild der Hauptplatine (3.1) und
 *     Kapitel 4 (CN0 Strom, CN1 Ausgänge, CN2 Eingänge, CN3/CN4 Endschalter, AXIS_X…U, CN5/CN6 Laser).
 *
 * Koordinaten: Board-Fläche w × h je Board (Zeichnung in ui/wiringPage.ts).
 *
 * NEUES BOARD HINZUFÜGEN
 *   1. Ein Objekt `const meinBoard: Board = { … }` anlegen (Vorlage: dlcMax unten):
 *        id, name, maker (Hersteller = Gruppe in der Auswahlliste), mcu, volt, w/h,
 *        conns  = Stecker mit Pins (Beschriftung wie auf der Platine, mcu = Controller-Pin, fn = Funktion),
 *        deco   = Treiber-Steckplätze, Chip, USB … (nur Optik)
 *        Damit es wie das echte Board aussieht: pcb (Platinenfarbe), holes (Befestigungslöcher),
 *        je Stecker body (Gehäusefarbe) / style (Schraubklemme, Hohlstecker …). Lage aus dem Pinplan
 *        des Herstellers abmessen (Board 640 Einheiten breit, Höhe im gleichen Verhältnis)
 *        fw / source = i18n-Schlüssel für Firmware und Herkunft der Zeichnung
 *   2. In hookupsFor() steht, welches Bauteil an welchen Stecker kommt. Neue Boards brauchen dort
 *      einen eigenen Zweig (wie isShield / isMax) – Stecker-IDs wie "lx", "probe", "ttl", "spin", "pwr"
 *      wiederzuverwenden spart Arbeit.
 *   3. Unten in BOARDS eintragen. Die Auswahlliste sortiert sich selbst.
 * Stecker: x/y = erster Pin, dir = Reihe (h) oder Spalte (v), Pins im Abstand von 13.
 */

export type CompId = "psu" | "motors" | "extdrv" | "limits" | "probe" | "laser" | "spindle" | "plasma" | "air" | "estop" | "door" | "io";
/** "io" (weitere Ein-/Ausgänge) gibt es nur bei Boards, die es eintragen – sonst erscheint der Knopf nicht */
export const COMPS: CompId[] = ["psu", "motors", "extdrv", "limits", "probe", "laser", "spindle", "plasma", "air", "estop", "door", "io"];

export interface BPin { k: string; label: string; mcu?: string; fn?: string }
/**
 * body  = Farbe des Steckergehäuses wie auf dem echten Board (z. B. farbige XH-Stecker beim MKS MAX)
 * style = Bauform: Schraubklemme, Hohlstecker-Buchse, XT30, Lötaugen (Schalter), Stiftleiste
 * pinLbl = false: keine Pin-Beschriftung (steht dann z. B. als Aufdruck daneben), Pins im Tooltip
 * rot = Stecker-Name senkrecht am Platinenrand (wie der Aufdruck „-VIN+“ auf dem Board)
 */
export interface BConn {
  id: string; label: string; x: number; y: number; dir: "h" | "v"; pins: BPin[]; labelPos?: "above" | "below" | "left" | "right";
  body?: string; style?: "screw" | "barrel" | "xt" | "pads" | "header"; pinLbl?: boolean; rot?: boolean;
  pitch?: number;              // Pin-Abstand (Standard 13); echte 2,54-mm-Leisten auf dem Shield sind breiter
  pinSide?: "left" | "right";  // senkrechte Stecker: Seite der Pin-Beschriftung (sonst nach labelPos)
  pinRot?: boolean;            // waagerechte Stecker: Pin-Namen senkrecht (lange Namen, wie auf Ruida-Platinen)
}

/** Bauteil, das gezeichnet und verdrahtet wird */
export type PartKind = "psu" | "motor" | "switch" | "probe" | "wls" | "laser" | "relay" | "vfd" | "plasma" | "thc" | "pump" | "estop" | "door" | "extdrv" | "lpsu" | "flow" | "foot" | "button" | "lamp" | "inv" | "prox" | "opto";
export interface Wire { from: string; to: string; color: string }   // to = "conn.pin" oder "@teil.pin"
/** outer: Pins auf der vom Board abgewandten Seite (für Verbindungen zu anderen Bauteilen, z. B. Relais-Kontakt) */
export interface Part {
  id: string; kind: PartKind; name: string; side: "left" | "right" | "top" | "bottom"; pins: string[]; wires: Wire[]; outer?: boolean;
  outerPins?: string[];   // eigene Außenklemmen (z. B. Eingänge des Optokoppler-Moduls)
}

export interface Step { k: string; p?: Record<string, string> }
export interface Hookup {
  comp: CompId;
  parts: Part[];
  steps: Step[];        // Einsteiger: Schritt für Schritt
  notes: Step[];        // Board-eigene Hinweise (Warnung)
  pro: Step[];          // Profi-Hinweise
  settings: string[];   // $-Einstellungen
  unavailable?: string; // Schlüssel: gibt es auf diesem Board nicht
}

/**
 * Optik auf der Platine (ohne Funktion):
 *   driver = einfacher Treiber-Steckplatz, socket = MKS-Treibersockel (grüne Leiste, rote DIP-Schalter),
 *   chip, esp = Funkmodul (silbern), usb, sd, barrel = Hohlstecker-Buchse, fuse = Sicherung,
 *   exp = Wannenstecker (Display), rj = Display-Buchse, text = Aufdruck (label, size = Schriftgröße)
 */
export interface Deco {
  x: number; y: number; w: number; h: number; label: string;
  kind: "driver" | "socket" | "shsock" | "chip" | "esp" | "usb" | "sd" | "barrel" | "fuse" | "exp" | "rj" | "hole" | "text" | "pins" | "button";
  size?: number;
  /** pins: Raster ab (x, y) = erster Pin, cols × rows im Abstand gap; oval = Lötaugen der Arduino-Leisten */
  cols?: number; rows?: number; gap?: number; oval?: boolean;
  /** text: Ausrichtung (Standard Mitte) und senkrecht */
  align?: "start" | "end"; rot?: boolean;
}

export interface Board {
  id: string;
  name: string;
  maker: string;       // Hersteller – Gruppe in der Auswahlliste
  mcu: string;
  fw: string;          // i18n-Schlüssel
  source: string;      // i18n-Schlüssel (Herkunft der Zeichnung)
  volt: string;
  w: number; h: number;  // Größe der Board-Fläche in der Zeichnung
  conns: BConn[];
  deco: Deco[];
  /** Aussehen wie das echte Board: Platinenfarbe, Befestigungslöcher */
  pcb?: { fill: string; edge: string; light?: boolean };   // light: helles Gehäuse → dunkle Schrift
  outline?: [number, number][];   // Umriss der Platine (sonst Rechteck), z. B. Arduino-Form
  holes?: { x: number; y: number; r: number }[];
  /**
   * Art der Eingänge (Endschalter/Taster) – für induktive Sensoren:
   *   avr5  = direkt am ATmega (5 V, kein Optokoppler)      esp33 = direkt am ESP32 (3,3 V, kein Optokoppler im Pinplan)
   *   pb496 / pb588 = PiBot mit SW-VCC-Brücke (5 V oder Vmot, nur NPN)   ruida = Ruida (5/12/24 V, NPN laut Handbuch)
   */
  inputs: InputKind;
  hookups: Partial<Record<CompId, Hookup>>;
}
export type InputKind = "avr5" | "esp33" | "pb496" | "pb588" | "ruida";

// Kabelfarben
const RED = "#e5484d", BLACK = "#2b2b2b", YEL = "#f5c518", GRN = "#30a46c", BLU = "#3e7bfa", WHT = "#d9d9d9", ORG = "#f08c00", VIO = "#9b5de5";

/** 3-polig 5V / GND / S (MKS) */
const vgs = (id: string, label: string, x: number, y: number, mcu: string, fn: string): BConn => ({
  id, label, x, y, dir: "v", labelPos: "above",
  pins: [{ k: "5V", label: "5V" }, { k: "G", label: "GND" }, { k: "S", label: "S", mcu, fn }]
});
const motorPart = (axis: string, conn: string, side: Part["side"] = "top"): Part => ({
  id: "m" + axis, kind: "motor", name: axis, side, pins: ["1A", "1B", "2A", "2B"],
  wires: [{ from: "2B", to: conn + ".2B", color: BLU }, { from: "2A", to: conn + ".2A", color: RED }, { from: "1A", to: conn + ".1A", color: BLACK }, { from: "1B", to: conn + ".1B", color: GRN }]
});
const switchPart = (axis: string, conn: string, sig = "S", gnd = "G", side: Part["side"] = "right"): Part => ({
  id: "sw" + axis, kind: "switch", name: axis, side, pins: ["NO", "C"],
  wires: [{ from: "NO", to: `${conn}.${sig}`, color: YEL }, { from: "C", to: `${conn}.${gnd}`, color: BLACK }]
});

// =====================================================================
// Arduino UNO + CNC Shield V3 (GRBL 1.1h)
// Lage wie Protoneer „CNC Shield V3.00“ (die verbreiteten roten Nachbauten, z. B. Osoyoo), echte 2,54-mm-Abstände
// =====================================================================
const SP = 23.7;   // 2,54 mm in Zeichnungs-Einheiten (Shield 68,6 mm = 640)
/** Zweier-Stiftleiste Signal + GND waagerecht, Name links wie auf dem Shield */
const sgRow = (id: string, label: string, y: number, mcu: string, fn: string): BConn => ({
  id, label, x: 592, y, dir: "h", labelPos: "left", pitch: SP, pinLbl: false, style: "header", body: "#1b1b1d",
  pins: [{ k: "S", label: "S", mcu, fn }, { k: "G", label: "GND" }]
});
/** STEP/DIR-Paar der linken Leiste (STEP links, DIR rechts) */
const sdRow = (id: string, axis: string, y: number, step: string, dir: string): BConn => ({
  id, label: axis + ".STEP/DIR", x: 105, y, dir: "h", labelPos: "left", pitch: SP, pinLbl: false, style: "header", body: "#1b1b1d",
  pins: [{ k: "S", label: "STEP", mcu: step, fn: "Step" }, { k: "D", label: "DIR", mcu: dir, fn: "Dir" }]
});
/** Motorstecker senkrecht rechts neben dem Treiber (B2 B1 A1 A2 wie aufgedruckt) */
const shMot = (id: string, label: string, x: number, y: number): BConn => ({
  id, label, x, y, dir: "v", labelPos: "below", pinSide: "left", pitch: SP, style: "header", body: "#1b1b1d",
  pins: [{ k: "2B", label: "B2" }, { k: "2A", label: "B1" }, { k: "1A", label: "A1" }, { k: "1B", label: "A2" }]
});
const shield: Board = {
  id: "cnc-shield-v3",
  inputs: "avr5",
  maker: "Arduino",
  name: "Arduino UNO + CNC Shield V3",
  mcu: "ATmega328P",
  fw: "wr.fw.shield",
  source: "wr.src.shield",
  volt: "12–36 V",
  w: 640, h: 497,
  pcb: { fill: "#c3161d", edge: "#7a0b10" },
  outline: [[0, 0], [607, 0], [617, 10], [617, 138], [640, 161], [640, 455], [617, 478], [617, 497], [0, 497]],
  holes: [{ x: 137, y: 23, r: 12 }, { x: 130, y: 474, r: 12 }],
  conns: [
    { id: "pwr", label: "12-36V", x: 30, y: 373, dir: "h", labelPos: "below", pitch: 48, style: "screw", body: "#2f7fd6",
      pins: [{ k: "-", label: "−" }, { k: "+", label: "+" }] },
    shMot("mx", "X", 308, 102), shMot("my", "Y", 502, 102), shMot("mz", "Z", 308, 329), shMot("ma", "A", 502, 329),
    // Z+ und Z− sind auf dem Shield beide D11 (GRBL 1.1: Spindel-/Laser-PWM)
    sgRow("lzp", "Z+", 155, "D11", "Spindel/Laser PWM (GRBL 1.1)"),
    sgRow("lz", "Z−", 179, "D11", "Spindel/Laser PWM (GRBL 1.1)"),
    sgRow("ly", "Y−", 226, "D10", "Y-Limit"),
    sgRow("lx", "X−", 274, "D9", "X-Limit"),
    sgRow("spe", "SpnEn", 298, "D12", "Z-Limit (GRBL 1.1)"),
    sgRow("spd", "SpnDir", 321, "D13", "Spindel-Richtung"),
    sgRow("cool", "CoolEn", 344, "A3", "Kühlung M8"),
    sgRow("abort", "Abort", 368, "A0", "Reset/Abbruch"),
    sgRow("hold", "Hold", 392, "A1", "Feed Hold"),
    sgRow("resume", "Resume", 415, "A2", "Cycle Start"),
    { ...sgRow("estop", "E-STOP", 440, "RESET", "Arduino-Reset"), pins: [{ k: "1", label: "RST", mcu: "RESET", fn: "Arduino-Reset" }, { k: "2", label: "GND" }] },
    { id: "scl", label: "", x: 580, y: 61, dir: "v", pinSide: "right", pitch: SP, style: "header", body: "#1b1b1d",
      pins: [{ k: "S", label: "SCL", mcu: "A5", fn: "Taster (Probe)" }, { k: "SDA", label: "SDA", mcu: "A4", fn: "Nebel M7 (Option)" }, { k: "G", label: "GND" }, { k: "RST", label: "RST", mcu: "RESET" }] },
    { id: "v5", label: "5V/GND", x: 105, y: 211, dir: "h", labelPos: "left", pitch: SP, pinLbl: false, style: "header", body: "#1b1b1d",
      pins: [{ k: "5V", label: "5V" }, { k: "G", label: "GND" }] },
    // STEP/DIR-Leiste links (für externe Treiber wie TB6600/DM542)
    { id: "eng", label: "EN/GND", x: 105, y: 93, dir: "h", labelPos: "left", pitch: SP, pinLbl: false, style: "header", body: "#1b1b1d",
      pins: [{ k: "E", label: "EN", mcu: "D8", fn: "Enable" }, { k: "G", label: "GND" }] },
    sdRow("xsd", "X", 117, "D2", "D5"), sdRow("ysd", "Y", 140, "D3", "D6"), sdRow("zsd", "Z", 164, "D4", "D7"), sdRow("asd", "A", 187, "", "")
  ],
  deco: [
    { x: 7, y: 6, w: 94, h: 71, label: "RST", kind: "button" },
    // Arduino-Leisten (Lötaugen oben und unten)
    { x: 226, y: 23, w: 0, h: 0, label: "", kind: "pins", cols: 8, rows: 1, gap: SP, oval: true },
    { x: 427, y: 23, w: 0, h: 0, label: "", kind: "pins", cols: 8, rows: 1, gap: SP, oval: true },
    { x: 310, y: 478, w: 0, h: 0, label: "", kind: "pins", cols: 6, rows: 1, gap: SP, oval: true },
    { x: 475, y: 478, w: 0, h: 0, label: "", kind: "pins", cols: 6, rows: 1, gap: SP, oval: true },
    // Treiber-Sockel
    { x: 143, y: 42, w: 142, h: 190, label: "", kind: "shsock" }, { x: 337, y: 42, w: 142, h: 190, label: "", kind: "shsock" },
    { x: 143, y: 267, w: 142, h: 190, label: "", kind: "shsock" }, { x: 337, y: 267, w: 142, h: 190, label: "", kind: "shsock" },
    // Brücken für die A-Achse (klont X, Y oder Z – oder D12/D13)
    { x: 37, y: 238, w: 0, h: 0, label: "", kind: "pins", cols: 4, rows: 4, gap: SP },
    { x: 4, y: 232, w: 20, h: 12, label: "X", kind: "text", size: 10 }, { x: 4, y: 256, w: 20, h: 12, label: "Y", kind: "text", size: 10 },
    { x: 4, y: 279, w: 20, h: 12, label: "Z", kind: "text", size: 10 }, { x: 4, y: 303, w: 20, h: 12, label: "D12", kind: "text", size: 8 },
    { x: 118, y: 303, w: 24, h: 12, label: "D13", kind: "text", size: 8 },
    { x: 8, y: 323, w: 40, h: 12, label: "A.STP", kind: "text", size: 9 }, { x: 98, y: 323, w: 40, h: 12, label: "A.DIR", kind: "text", size: 9 },
    { x: 170, y: 238, w: 134, h: 23, label: "FUSE", kind: "chip" },
    { x: 333, y: 242, w: 167, h: 14, label: "VER 3.00", kind: "text", size: 10 },
    // UART/I2C-Leiste oben rechts (linke Reihe), Endschalter-Plus-Reihen, Beschriftung
    { x: 556, y: 61, w: 0, h: 0, label: "", kind: "pins", cols: 1, rows: 4, gap: SP },
    { x: 500, y: 55, w: 46, h: 12, label: "RX", kind: "text", size: 9, align: "end" },
    { x: 500, y: 78, w: 46, h: 12, label: "TX", kind: "text", size: 9, align: "end" },
    { x: 500, y: 101, w: 46, h: 12, label: "5V", kind: "text", size: 9, align: "end" },
    { x: 500, y: 125, w: 46, h: 12, label: "3V3", kind: "text", size: 9, align: "end" },
    { x: 592, y: 203, w: 0, h: 0, label: "", kind: "pins", cols: 2, rows: 1, gap: SP },
    { x: 592, y: 250, w: 0, h: 0, label: "", kind: "pins", cols: 2, rows: 1, gap: SP },
    { x: 550, y: 197, w: 30, h: 12, label: "Y+", kind: "text", size: 10, align: "end" },
    { x: 550, y: 244, w: 30, h: 12, label: "X+", kind: "text", size: 10, align: "end" },
    { x: 548, y: 160, w: 0, h: 100, label: "END STOPS", kind: "text", size: 9, rot: true },
    { x: 580, y: 140, w: 24, h: 10, label: "S", kind: "text", size: 8 }, { x: 604, y: 140, w: 24, h: 10, label: "GND", kind: "text", size: 7 },
    { x: 140, y: 470, w: 180, h: 18, label: "CNC SHIELD", kind: "text", size: 15 }
  ],
  hookups: {}
};

// =====================================================================
// MKS-Boards: Lage und Farben wie auf dem echten Board
// (Makerbase-Pinpläne „… PIN.pdf“ und Fotos aus den Handbüchern; Board 640 Einheiten breit)
// =====================================================================
const MKS_PCB = { fill: "#141619", edge: "#2d3137" };
const XH_BLACK = "#202226";
/** XH-Motorstecker (4-polig), Beschriftung wie auf dem Board darüber */
const xhMot = (id: string, label: string, x: number, y: number, body: string, mcu = ""): BConn => ({
  id, label, x, y, dir: "h", labelPos: "above", body,
  pins: [{ k: "2B", label: "2B", fn: mcu }, { k: "2A", label: "2A", fn: mcu }, { k: "1A", label: "1A", fn: mcu }, { k: "1B", label: "1B", fn: mcu }]
});
/** 3-polig 5V / GND / S (MKS-Endschalter, Taster …) */
const xh3 = (id: string, label: string, x: number, y: number, mcu: string, fn: string, body: string, labelPos: BConn["labelPos"] = "above"): BConn => ({
  ...vgs(id, label, x, y, mcu, fn), body, labelPos
});
/** Treiber-Anschluss E S D G unter dem Sockel (nur Optik + Tooltip) */
const esdRow = (axis: string, x: number, y: number, mcu = ""): BConn => ({
  ...esd(axis, x, mcu), y, label: "E S D G", pinLbl: false, style: "header", body: XH_BLACK
});
const esd = (axis: string, x: number, mcu = ""): BConn => ({
  id: "esd_" + axis.toLowerCase(), label: axis + ": E S D G", x, y: 186, dir: "h", labelPos: "below",
  pins: [{ k: "E", label: "E", mcu, fn: "Enable" }, { k: "S", label: "S", fn: "Step" }, { k: "D", label: "D", fn: "Dir" }, { k: "G", label: "G" }]
});

// ---------------------------------------------------------------------
// MKS DLC32 V2.1 (ESP32, MKS-Firmware / Grbl_ESP32) – schwarze Platine, schwarze Stecker
// ---------------------------------------------------------------------
const dlc21: Board = {
  id: "mks-dlc32-v21",
  inputs: "esp33",
  maker: "Makerbase (MKS)",
  name: "MKS DLC32 V2.1",
  mcu: "ESP32",
  fw: "wr.fw.dlc32",
  source: "wr.src.dlc21",
  volt: "12–24 V",
  w: 640, h: 497,
  pcb: MKS_PCB,
  holes: [{ x: 28, y: 26, r: 22 }, { x: 612, y: 26, r: 22 }, { x: 28, y: 469, r: 22 }, { x: 612, y: 469, r: 22 }],
  conns: [
    xhMot("mx", "X-Motor", 83, 30, XH_BLACK), xhMot("my1", "Y1-Motor", 180, 30, XH_BLACK),
    xhMot("my2", "Y2-Motor", 277, 30, XH_BLACK), xhMot("mz", "Z-Motor", 374, 30, XH_BLACK),
    { id: "out", label: "+12/24V−", x: 466, y: 30, dir: "h", labelPos: "above", body: XH_BLACK, pins: [{ k: "+", label: "+" }, { k: "-", label: "−" }] },
    { id: "ttl", label: "S-TTL-V", x: 529, y: 30, dir: "h", labelPos: "above", body: XH_BLACK, pins: [{ k: "S", label: "S", mcu: "IO32", fn: "Laser PWM" }, { k: "G", label: "G" }, { k: "V", label: "V", fn: "12/24V" }] },
    { id: "i2c", label: "I2C", x: 437, y: 68, dir: "v", labelPos: "below", style: "header", body: XH_BLACK, pins: [{ k: "3V3", label: "3V3" }, { k: "G", label: "GND" }, { k: "SDA", label: "SDA", mcu: "IO0" }, { k: "SCL", label: "SCL", mcu: "IO4", fn: "Kühlung M8" }] },
    xh3("probe", "Probe", 478, 79, "IO22", "Taster", XH_BLACK, "below"),
    xh3("lz", "Z", 524, 79, "IO34", "Z-Limit", XH_BLACK, "below"),
    xh3("ly", "Y", 569, 79, "IO35", "Y-Limit", XH_BLACK, "below"),
    xh3("lx", "X", 615, 79, "IO36", "X-Limit", XH_BLACK, "below"),
    { id: "vout", label: "-12/24V+", x: 33, y: 120, dir: "v", labelPos: "right", rot: true, body: XH_BLACK, pins: [{ k: "-", label: "−", fn: "GND" }, { k: "+", label: "+", fn: "12/24V" }] },
    { id: "beep", label: "-BEEPER+", x: 33, y: 178, dir: "v", labelPos: "right", rot: true, body: XH_BLACK, pins: [{ k: "-", label: "−", fn: "S" }, { k: "+", label: "+", fn: "12/24V" }] },
    { id: "spin", label: "-SPINDLE+", x: 40, y: 250, dir: "v", labelPos: "right", rot: true, style: "screw", pins: [{ k: "-", label: "−", mcu: "IO32", fn: "Spindel (MOSFET)" }, { k: "+", label: "+", fn: "12/24V" }] },
    { id: "sw", label: "SWITCH", x: 35, y: 401, dir: "v", labelPos: "right", rot: true, style: "pads", pins: [{ k: "1", label: "1" }, { k: "2", label: "2" }] },
    { id: "pwr", label: "POWER 12-24V", x: 138, y: 466, dir: "h", labelPos: "above", style: "barrel", pinLbl: false, pins: [{ k: "+", label: "+" }, { k: "-", label: "−" }] },
    { id: "rst", label: "RESET", x: 536, y: 468, dir: "h", labelPos: "above", body: XH_BLACK, pins: [{ k: "G", label: "G" }, { k: "S", label: "S", mcu: "EN", fn: "Reset" }] },
    esdRow("X", 95, 217), esdRow("Y", 209, 217), esdRow("Z", 324, 217)
  ],
  deco: [
    { x: 63, y: 61, w: 97, h: 143, label: "X", kind: "socket" }, { x: 177, y: 61, w: 97, h: 143, label: "Y", kind: "socket" },
    { x: 292, y: 61, w: 97, h: 143, label: "Z", kind: "socket" },
    { x: 498, y: 156, w: 135, h: 135, label: "ESP32", kind: "esp" },
    { x: 495, y: 307, w: 141, h: 63, label: "EXP1", kind: "exp" }, { x: 495, y: 374, w: 141, h: 63, label: "EXP2", kind: "exp" },
    { x: 360, y: 290, w: 130, h: 22, label: "Makerbase", kind: "text", size: 17 },
    { x: 360, y: 312, w: 130, h: 18, label: "MKS DLC32 V2.1", kind: "text", size: 11 },
    { x: 68, y: 392, w: 30, h: 98, label: "", kind: "fuse" },
    { x: 212, y: 400, w: 86, h: 97, label: "USB", kind: "usb" }, { x: 387, y: 404, w: 106, h: 93, label: "TF", kind: "sd" }
  ],
  hookups: {}
};

// ---------------------------------------------------------------------
// MKS DLC32 MAX V1.0 (ESP32-S3) – schwarze Platine, farbige Stecker
// ---------------------------------------------------------------------
const C_RED = "#d9452f", C_BLUE = "#2f6fd1", C_GREEN = "#2f9e57", C_PURPLE = "#94307f", C_WHITE = "#e6e6e3", C_YEL = "#e8be2a";
const dlcMax: Board = {
  id: "mks-dlc32-max",
  inputs: "esp33",
  maker: "Makerbase (MKS)",
  name: "MKS DLC32 MAX V1.0",
  mcu: "ESP32-S3",
  fw: "wr.fw.dlcmax",
  source: "wr.src.dlcmax",
  volt: "12–24 V",
  w: 640, h: 450,
  pcb: MKS_PCB,
  holes: [{ x: 24, y: 25, r: 20 }, { x: 614, y: 25, r: 20 }, { x: 24, y: 424, r: 20 }, { x: 614, y: 424, r: 20 }],
  conns: [
    xhMot("mx", "X-Motor", 73, 28, C_RED, "STEP IO16 · DIR IO15"), xhMot("my1", "Y1-Motor", 156, 28, C_BLUE, "STEP IO7 · DIR IO6"),
    xhMot("my2", "Y2-Motor", 239, 28, C_BLUE, "STEP IO7 · DIR IO6"), xhMot("mz", "Z-Motor", 322, 28, C_GREEN, "STEP IO5 · DIR IO4"),
    xhMot("ma", "A-Motor", 405, 28, C_PURPLE, "STEP IO20 · DIR IO19"),
    { id: "air", label: "+AIR−", x: 485, y: 28, dir: "h", labelPos: "above", body: XH_BLACK, pins: [{ k: "+", label: "+" }, { k: "-", label: "−", mcu: "IO1", fn: "Air (MOSFET)" }] },
    { id: "beep", label: "+BEEPER−", x: 559, y: 28, dir: "h", labelPos: "above", body: XH_BLACK, pins: [{ k: "+", label: "+" }, { k: "-", label: "−", mcu: "IO42" }] },
    xh3("lz", "Z−", 537, 84, "IO41", "Z-Limit", C_GREEN), xh3("ly", "Y−", 578, 84, "IO40", "Y-Limit", C_BLUE), xh3("lx", "X−", 618, 84, "IO39", "X-Limit", C_RED),
    xh3("door", "Door", 495, 162, "IO38", "Tür", C_WHITE), xh3("flame", "Flame", 536, 162, "IO36", "Flammen-Sensor", C_WHITE),
    xh3("probe", "Probe", 577, 162, "IO37", "Taster", C_WHITE), xh3("la", "A−", 618, 162, "IO48", "A-Limit", C_PURPLE),
    { id: "vout", label: "-VIN+", x: 26, y: 90, dir: "v", labelPos: "right", rot: true, body: C_RED, pins: [{ k: "-", label: "−", fn: "GND" }, { k: "+", label: "+", fn: "12-24V" }] },
    { id: "ttl", label: "Laser", x: 26, y: 140, dir: "v", labelPos: "right", rot: true, body: C_YEL, pins: [{ k: "S", label: "TTL", mcu: "IO2", fn: "Laser PWM" }, { k: "G", label: "GND" }, { k: "V", label: "VIN" }] },
    { id: "ttl2", label: "Laser 2", x: 26, y: 215, dir: "v", labelPos: "right", rot: true, style: "xt", pins: [{ k: "S", label: "TTL", mcu: "IO2", fn: "Laser PWM" }, { k: "G", label: "GND" }, { k: "V", label: "VIN" }] },
    { id: "spin", label: "-SPINDLE+", x: 30, y: 296, dir: "v", labelPos: "right", rot: true, style: "screw", pins: [{ k: "-", label: "−", mcu: "IO35", fn: "Spindel (MOSFET)" }, { k: "+", label: "+" }] },
    { id: "sw", label: "SWITCH", x: 27, y: 362, dir: "v", labelPos: "right", rot: true, style: "pads", pins: [{ k: "1", label: "1" }, { k: "2", label: "2" }] },
    { id: "pwr", label: "POWER 12-24V", x: 120, y: 418, dir: "h", labelPos: "above", style: "barrel", pinLbl: false, pins: [{ k: "+", label: "+" }, { k: "-", label: "−" }] },
    { id: "rst", label: "RESET", x: 600, y: 378, dir: "h", labelPos: "above", body: C_RED, pins: [{ k: "G", label: "G", fn: "GND" }, { k: "S", label: "RST", fn: "Reset" }] },
    esdRow("X", 84, 196, "IO8"), esdRow("Y", 187, 196, "IO8"), esdRow("Z", 290, 196, "IO8"), esdRow("A", 393, 196, "IO8")
  ],
  deco: [
    { x: 62, y: 56, w: 88, h: 129, label: "X", kind: "socket" }, { x: 165, y: 56, w: 88, h: 129, label: "Y", kind: "socket" },
    { x: 268, y: 56, w: 88, h: 129, label: "Z", kind: "socket" }, { x: 371, y: 56, w: 88, h: 129, label: "A", kind: "socket" },
    { x: 514, y: 233, w: 120, h: 120, label: "ESP32-S3", kind: "esp" },
    { x: 330, y: 238, w: 170, h: 24, label: "Makerbase", kind: "text", size: 17 },
    { x: 330, y: 305, w: 170, h: 18, label: "MKS DLC32 MAX V1.0", kind: "text", size: 11 },
    { x: 60, y: 354, w: 28, h: 92, label: "", kind: "fuse" },
    { x: 191, y: 362, w: 77, h: 88, label: "USB", kind: "usb" }, { x: 346, y: 367, w: 101, h: 83, label: "TF", kind: "sd" },
    { x: 514, y: 380, w: 64, h: 70, label: "LCD", kind: "rj" }
  ],
  hookups: {}
};

// ---------------------------------------------------------------------
// PiBot FluidNC V4.96 Pro (ESP32, FluidNC vorinstalliert) – schwarze Platine, weiße Eingangs-Stecker,
// grüne Schraubklemmen oben (Ausgänge) und unten (Motoren / externe Treiber), helle Klemmen rechts.
// Lage nach dem PiBot-Pinplan „V4.96 Pro Diagram Overview“ (wiki.pibot.com), Pins nach der Test-YAML
// des Herstellers (FluidNC legt Pins in der config.yaml fest – andere YAML = andere Belegung möglich).
// Unten je Achse EINE Klemme: ohne Brücken 2B 2A 1A 1B (Treiber auf dem Board), mit Brücken EN STP DIR GND.
// ---------------------------------------------------------------------
const PB_WHITE = "#e8e8e4", PB_GREEN = "#2f9e57", PB_CREAM = "#e6d9a8";
/** 3-polige Eingänge oben: GPIO / GND / SW-VCC */
const pbIn = (id: string, label: string, x: number, gpio: string, fn: string): BConn => ({
  id, label, x, y: 22, dir: "h", labelPos: "below", body: PB_WHITE, pinRot: true,
  pins: [{ k: "S", label: gpio.replace("GPIO", "IO"), mcu: gpio, fn }, { k: "G", label: "GND" }, { k: "V", label: "SW", fn: "SW-VCC (5V / Vmot-main)" }]
});
/** Achs-Klemme unten: Motor (2B 2A 1A 1B) oder externer Treiber (EN STP DIR GND) */
const pbAxis = (axis: string, x: number, en: string, stp: string, dir: string): BConn => ({
  id: "m" + axis.toLowerCase(), label: axis, x, y: 393, dir: "h", labelPos: "above", pitch: 16, style: "screw", body: PB_GREEN,
  pins: [{ k: "2B", label: "2B", mcu: en, fn: "EN (ext.)" }, { k: "2A", label: "2A", mcu: stp, fn: "STP (ext.)" },
    { k: "1A", label: "1A", mcu: dir, fn: "DIR (ext.)" }, { k: "1B", label: "1B", fn: "GND (ext.)" }]
});
/** Klemmen am rechten Rand */
const pbRight = (id: string, label: string, y: number, pins: BPin[]): BConn => ({
  id, label, x: 610, y, dir: "v", labelPos: "left", rot: true, pitch: 19, style: "screw", body: PB_CREAM, pinSide: "right", pins
});
const pibot: Board = {
  id: "pibot-v496-pro",
  inputs: "pb496",
  maker: "PiBot",
  name: "PiBot FluidNC V4.96 Pro",
  mcu: "ESP32",
  fw: "wr.fw.pibot",
  source: "wr.src.pibot",
  volt: "12–24 V",
  w: 640, h: 410,
  pcb: { fill: "#111215", edge: "#2d3137" },
  holes: [{ x: 16, y: 16, r: 13 }, { x: 624, y: 16, r: 13 }, { x: 16, y: 394, r: 13 }, { x: 624, y: 394, r: 13 }],
  conns: [
    // Eingänge oben (weiße XH-Stecker)
    { id: "probe", label: "Probe / IO26", x: 63, y: 22, dir: "h", labelPos: "below", body: PB_WHITE, pinRot: true,
      pins: [{ k: "S", label: "IO2", mcu: "GPIO2", fn: "Taster" }, { k: "G", label: "GND" },
        { k: "S2", label: "IO26", mcu: "GPIO26", fn: "Eingang oder Relais (Brücke)" }, { k: "G2", label: "GND" }] },
    pbIn("lx", "X", 122, "GPIO33", "X-Limit"), pbIn("ly", "Y", 167, "GPIO32", "Y-Limit"), pbIn("lz", "Z", 211, "GPIO35", "Z-Limit"),
    pbIn("la", "A", 257, "GPIO34", "A-Limit"), pbIn("lb", "B", 303, "GPIO39", "B-Limit"), pbIn("lc", "C", 348, "GPIO36", "C-Limit"),
    // Ausgänge oben (grüne Schraubklemmen)
    { id: "out", label: "Outputs 5V", x: 386, y: 20, dir: "h", labelPos: "below", pitch: 15, style: "screw", body: PB_GREEN, pinRot: true,
      pins: [{ k: "4", label: "IO4", mcu: "GPIO4", fn: "PWM 5V" }, { k: "12", label: "IO12", mcu: "GPIO12", fn: "Laser PWM" },
        { k: "14", label: "IO14", mcu: "GPIO14" }, { k: "13", label: "IO13", mcu: "GPIO13" }] },
    { id: "gnd", label: "", x: 452, y: 20, dir: "h", labelPos: "below", style: "screw", body: PB_GREEN, pinRot: true, pins: [{ k: "G", label: "GND" }] },
    { id: "rs485", label: "RS485", x: 474, y: 20, dir: "h", labelPos: "below", style: "screw", body: PB_GREEN, pinRot: true,
      pins: [{ k: "A", label: "A", mcu: "GPIO15/16/14", fn: "Modbus (VFD)" }, { k: "B", label: "B" }] },
    { id: "v10", label: "0-10V", x: 509, y: 20, dir: "h", labelPos: "below", pitch: 14, style: "screw", body: PB_GREEN, pinRot: true,
      pins: [{ k: "F", label: "O14", mcu: "GPIO14", fn: "Optokoppler (Vorwärts)" }, { k: "R", label: "O15", mcu: "GPIO15", fn: "Optokoppler (Rückwärts)" },
        { k: "C", label: "COM", fn: "OPT-Common" }, { k: "V", label: "10V", mcu: "GPIO13", fn: "0–10 V" }, { k: "G", label: "GND" }] },
    // rechts: Relais, MOSFET, zwei Stromeingänge
    pbRight("relay", "RELAY", 60, [{ k: "NC", label: "NC" }, { k: "COM", label: "COM" }, { k: "NO", label: "NO", mcu: "GPIO26", fn: "Relais (Brücke ⑬)" }]),
    pbRight("mos", "MOSFET", 123, [{ k: "12", label: "io12−", mcu: "GPIO12", fn: "MOSFET 1,5 A" }, { k: "V", label: "Vmot", fn: "Vmot-main +" },
      { k: "4", label: "io4−", mcu: "GPIO4", fn: "MOSFET 1,5 A" }]),
    pbRight("pwr", "VIN", 182, [{ k: "-", label: "GND" }, { k: "+", label: "+ Vmot-main" }]),
    pbRight("vdrv", "DRV", 223, [{ k: "-", label: "GND" }, { k: "+", label: "+ Vmot-Driver" }]),
    // unten: SPI für externe TMC-Treiber und die sechs Achs-Klemmen
    { id: "spi", label: "SPI", x: 112, y: 393, dir: "h", labelPos: "above", pitch: 16, pinLbl: false, style: "screw", body: PB_GREEN,
      pins: [{ k: "MOSI", label: "MOSI", mcu: "GPIO23" }, { k: "SCK", label: "SCK", mcu: "GPIO18" }, { k: "MISO", label: "MISO", mcu: "GPIO19" }, { k: "CS", label: "CS", mcu: "I2SO.3" }] },
    pbAxis("X", 180, "I2SO.0", "I2SO.2", "I2SO.1"), pbAxis("Y", 251, "I2SO.7", "I2SO.5", "I2SO.4"), pbAxis("Z", 321, "I2SO.8", "I2SO.10", "I2SO.9"),
    pbAxis("A", 392, "I2SO.15", "I2SO.13", "I2SO.12"), pbAxis("B", 462, "I2SO.16", "I2SO.18", "I2SO.17"), pbAxis("C", 533, "I2SO.23", "I2SO.21", "I2SO.20"),
    // Stiftleisten: Display (OLED) und Handrad / I/O-Erweiterung (teilen sich IO25/IO27)
    { id: "oled", label: "OLED", x: 337, y: 121, dir: "h", labelPos: "above", style: "header", body: XH_BLACK, pinRot: true,
      pins: [{ k: "G", label: "GND" }, { k: "3V3", label: "3V3" }, { k: "25", label: "25", mcu: "GPIO25", fn: "I2C SCL" }, { k: "27", label: "27", mcu: "GPIO27", fn: "I2C SDA" }] },
    { id: "uart", label: "UART", x: 156, y: 283, dir: "v", labelPos: "above", pinSide: "right", style: "header", body: XH_BLACK,
      pins: [{ k: "G", label: "GND" }, { k: "VM", label: "Vmot" }, { k: "5V", label: "5V" }, { k: "25", label: "IO25", mcu: "GPIO25" }, { k: "27", label: "IO27", mcu: "GPIO27" }] }
  ],
  deco: [
    { x: 172, y: 271, w: 58, h: 86, label: "X", kind: "driver" }, { x: 243, y: 271, w: 58, h: 86, label: "Y", kind: "driver" },
    { x: 313, y: 271, w: 58, h: 86, label: "Z", kind: "driver" }, { x: 384, y: 271, w: 58, h: 86, label: "A", kind: "driver" },
    { x: 454, y: 271, w: 58, h: 86, label: "B", kind: "driver" }, { x: 525, y: 271, w: 58, h: 86, label: "C", kind: "driver" },
    { x: 24, y: 210, w: 89, h: 118, label: "ESP32", kind: "esp" },
    { x: 10, y: 112, w: 57, h: 72, label: "TF", kind: "sd" },
    { x: 56, y: 372, w: 42, h: 36, label: "USB", kind: "usb" },
    { x: 503, y: 66, w: 84, h: 58, label: "RELAY", kind: "chip" },
    { x: 147, y: 158, w: 16, h: 16, label: "", kind: "button" }, { x: 147, y: 186, w: 16, h: 16, label: "", kind: "button" },
    { x: 118, y: 160, w: 28, h: 12, label: "RST", kind: "text", size: 8, align: "end" }, { x: 118, y: 188, w: 28, h: 12, label: "BOOT", kind: "text", size: 8, align: "end" },
    // Brücken: SW-VCC, Treiber-Logik (VDD), MS1/MS2 für alle Treiber auf dem Board
    { x: 508, y: 150, w: 0, h: 0, label: "", kind: "pins", cols: 3, rows: 1, gap: 12 },
    { x: 508, y: 172, w: 0, h: 0, label: "", kind: "pins", cols: 3, rows: 1, gap: 12 },
    { x: 440, y: 144, w: 58, h: 12, label: "SW-VCC", kind: "text", size: 8, align: "end" },
    { x: 440, y: 166, w: 58, h: 12, label: "VDD 5V/3V3", kind: "text", size: 8, align: "end" },
    { x: 594, y: 280, w: 0, h: 0, label: "", kind: "pins", cols: 2, rows: 5, gap: 13 },
    { x: 560, y: 266, w: 60, h: 10, label: "MS1 MS2 · IO26", kind: "text", size: 7 },
    { x: 200, y: 196, w: 150, h: 24, label: "PiBot", kind: "text", size: 20 },
    { x: 200, y: 222, w: 150, h: 14, label: "FluidNC GRBLHAL V4.96 Pro", kind: "text", size: 9 }
  ],
  hookups: {}
};

// ---------------------------------------------------------------------
// PiBot Controller V5.88 Ultra (ESP32-S3, FluidNC vorinstalliert) – Lage nach dem PiBot-Pinplan
// „V588 diagram V1“ (wiki.pibot.com, Pinout Reference), Pins nach der Test-YAML des Herstellers.
// 10 Eingänge in zwei Reihen oben, je Achse eine weiße Klemme EN STP DIR GND (externe Treiber, ohne Brücken)
// über dem Sockel und eine grüne Motorklemme unten. Kein Relais; zwei MOSFET-Ausgänge (500 mA).
// ---------------------------------------------------------------------
const PU_BLUE = "#bfe3ee";
const puIn = (id: string, label: string, x: number, y: number, gpio: string, fn: string, body: string): BConn => ({
  ...pbIn(id, label, x, gpio, fn), y, body, pinRot: true
});
const puMot = (axis: string, x: number): BConn => ({
  id: "m" + axis.toLowerCase(), label: axis, x, y: 395, dir: "h", labelPos: "above", pitch: 14, style: "screw", body: PB_GREEN,
  pins: [{ k: "2B", label: "2B" }, { k: "2A", label: "2A" }, { k: "1A", label: "1A" }, { k: "1B", label: "1B" }]
});
const puExt = (axis: string, x: number, en: string, stp: string, dir: string): BConn => ({
  id: "e" + axis.toLowerCase(), label: "", x, y: 266, dir: "h", labelPos: "below", pitch: 14, style: "screw", body: PU_BLUE, pinRot: true,
  pins: [{ k: "EN", label: "EN", mcu: en, fn: "Enable" }, { k: "STP", label: "STP", mcu: stp, fn: "Step" }, { k: "DIR", label: "DIR", mcu: dir, fn: "Dir" }, { k: "G", label: "GND" }]
});
const puRight = (id: string, label: string, y: number, pins: BPin[]): BConn => ({
  id, label, x: 604, y, dir: "v", labelPos: "left", rot: true, pitch: 17, style: "screw", body: PB_CREAM, pinSide: "right", pins
});
const pibotUltra: Board = {
  id: "pibot-v588-ultra",
  inputs: "pb588",
  maker: "PiBot",
  name: "PiBot Controller V5.88 Ultra",
  mcu: "ESP32-S3",
  fw: "wr.fw.pibot588",
  source: "wr.src.pibot588",
  volt: "12–24 V",
  w: 640, h: 410,
  pcb: { fill: "#111215", edge: "#2d3137" },
  holes: [{ x: 14, y: 14, r: 12 }, { x: 626, y: 14, r: 12 }, { x: 14, y: 396, r: 12 }, { x: 626, y: 396, r: 12 }],
  conns: [
    // Eingänge: obere Reihe (grün) und zweite Reihe (hellblau), je GPIO / GND / SW-VCC
    puIn("lx", "X−", 114, 17, "GPIO42", "X-Limit −", PB_GREEN), puIn("lxp", "X+", 164, 17, "GPIO41", "X-Limit +", PB_GREEN),
    puIn("ly", "Y−", 215, 17, "GPIO40", "Y-Limit −", PB_GREEN), puIn("lyp", "Y+", 265, 17, "GPIO39", "Y-Limit +", PB_GREEN),
    puIn("lz", "Z−", 315, 17, "GPIO38", "Z-Limit −", PB_GREEN),
    puIn("la", "A−", 114, 86, "GPIO37", "A-Limit", PU_BLUE), puIn("lb", "B−", 164, 86, "GPIO36", "B-Limit", PU_BLUE),
    puIn("lc", "C−", 215, 86, "GPIO48", "C-Limit", PU_BLUE), puIn("lp", "Probe", 265, 86, "GPIO47", "Taster", PU_BLUE),
    puIn("lts", "Tool", 315, 86, "GPIO3", "Längensensor (Brücke ⑩)", PU_BLUE),
    // Ausgänge oben
    { id: "pwm", label: "PWM 5V", x: 365, y: 17, dir: "h", labelPos: "below", pitch: 14, style: "screw", body: PB_GREEN, pinRot: true,
      pins: [{ k: "4", label: "IO4", mcu: "GPIO4", fn: "Nebel M7 / MOSFET" }, { k: "5", label: "IO5", mcu: "GPIO5", fn: "Kühlung M8 / MOSFET" },
        { k: "45", label: "IO45", mcu: "GPIO45", fn: "Spindel PWM" }, { k: "46", label: "IO46", mcu: "GPIO46", fn: "Laser PWM" }, { k: "G", label: "GND" }] },
    { id: "rs485", label: "RS485", x: 435, y: 17, dir: "h", labelPos: "below", pitch: 14, style: "screw", body: PB_GREEN, pinRot: true,
      pins: [{ k: "3V3", label: "3V3" }, { k: "5V", label: "5V" }, { k: "A", label: "A", mcu: "GPIO12/11", fn: "Modbus (VFD)" }, { k: "B", label: "B" }, { k: "G", label: "GND" }] },
    { id: "v10", label: "0-10V", x: 506, y: 17, dir: "h", labelPos: "below", pitch: 14, style: "screw", body: PB_GREEN, pinRot: true,
      pins: [{ k: "R", label: "O2", mcu: "GPIO8", fn: "Optokoppler (Rückwärts)" }, { k: "F", label: "O1", mcu: "GPIO7", fn: "Optokoppler (Vorwärts)" },
        { k: "C", label: "COM", fn: "OUT-Common" }, { k: "V", label: "10V", mcu: "GPIO6", fn: "0–10 V" }, { k: "G", label: "GND" }] },
    // rechts: zwei MOSFET-Ausgänge und zwei Stromeingänge
    puRight("m4", "MOS4", 132, [{ k: "4", label: "io4−", mcu: "GPIO4", fn: "MOSFET 500 mA" }, { k: "V", label: "Vmot" }]),
    puRight("m5", "MOS5", 172, [{ k: "5", label: "io5−", mcu: "GPIO5", fn: "MOSFET 500 mA" }, { k: "V", label: "Vmot" }]),
    puRight("pwr", "VIN", 210, [{ k: "-", label: "GND" }, { k: "+", label: "+ VIN" }]),
    puRight("vdrv", "DRV", 251, [{ k: "-", label: "GND" }, { k: "+", label: "+ Vmot-Driver" }]),
    // externe Treiber (weiß, über den Sockeln) und Motoren (grün, unten)
    puExt("X", 182, "I2SO.0", "I2SO.2", "I2SO.1"), puExt("Y", 250, "I2SO.7", "I2SO.5", "I2SO.4"), puExt("Z", 322, "I2SO.8", "I2SO.10", "I2SO.9"),
    puExt("A", 390, "I2SO.15", "I2SO.13", "I2SO.12"), puExt("B", 461, "I2SO.16", "I2SO.18", "I2SO.17"), puExt("C", 529, "I2SO.23", "I2SO.21", "I2SO.20"),
    puMot("X", 180), puMot("Y", 248), puMot("Z", 320), puMot("A", 390), puMot("B", 461), puMot("C", 529),
    { id: "extra", label: "EXTRA IO", x: 106, y: 266, dir: "h", labelPos: "below", pitch: 14, style: "screw", body: PU_BLUE, pinRot: true,
      pins: [{ k: "3", label: "IO3", mcu: "GPIO3" }, { k: "10", label: "IO10", mcu: "GPIO10", fn: "M64/M65 P0" }, { k: "15", label: "IO15", mcu: "GPIO15", fn: "M64/M65 P1" }, { k: "G", label: "GND" }] },
    { id: "spi", label: "SPI", x: 113, y: 392, dir: "h", labelPos: "above", pitch: 14, pinLbl: false, style: "screw", body: PB_GREEN,
      pins: [{ k: "MOSI", label: "MOSI", mcu: "GPIO1" }, { k: "SCK", label: "SCK", mcu: "GPIO21" }, { k: "MISO", label: "MISO", mcu: "GPIO2" }, { k: "CS", label: "CS", mcu: "I2SO.3" }] },
    { id: "oled", label: "OLED", x: 393, y: 95, dir: "h", labelPos: "above", style: "header", body: XH_BLACK, pinRot: true,
      pins: [{ k: "G", label: "GND" }, { k: "3V3", label: "3V3" }, { k: "13", label: "13", mcu: "GPIO13", fn: "I2C SCL" }, { k: "14", label: "14", mcu: "GPIO14", fn: "I2C SDA" }] }
  ],
  deco: [
    { x: 175, y: 290, w: 56, h: 82, label: "X", kind: "driver" }, { x: 245, y: 290, w: 56, h: 82, label: "Y", kind: "driver" },
    { x: 315, y: 290, w: 56, h: 82, label: "Z", kind: "driver" }, { x: 385, y: 290, w: 56, h: 82, label: "A", kind: "driver" },
    { x: 455, y: 290, w: 56, h: 82, label: "B", kind: "driver" }, { x: 525, y: 290, w: 56, h: 82, label: "C", kind: "driver" },
    { x: 7, y: 205, w: 82, h: 84, label: "ESP32-S3", kind: "esp" },
    { x: 7, y: 96, w: 62, h: 70, label: "TF", kind: "sd" },
    { x: 54, y: 2, w: 40, h: 32, label: "USB 2", kind: "usb" }, { x: 54, y: 380, w: 40, h: 30, label: "USB", kind: "usb" },
    { x: 572, y: 56, w: 57, h: 54, label: "RJ12", kind: "rj" },
    { x: 576, y: 10, w: 12, h: 12, label: "", kind: "button" },
    { x: 120, y: 168, w: 14, h: 14, label: "", kind: "button" }, { x: 120, y: 198, w: 14, h: 14, label: "", kind: "button" },
    { x: 90, y: 170, w: 28, h: 12, label: "RST", kind: "text", size: 8, align: "end" }, { x: 90, y: 200, w: 28, h: 12, label: "BOOT", kind: "text", size: 8, align: "end" },
    { x: 498, y: 152, w: 0, h: 0, label: "", kind: "pins", cols: 3, rows: 1, gap: 11 },
    { x: 498, y: 174, w: 0, h: 0, label: "", kind: "pins", cols: 3, rows: 1, gap: 11 },
    { x: 432, y: 146, w: 58, h: 12, label: "SW-VCC", kind: "text", size: 8, align: "end" },
    { x: 432, y: 168, w: 58, h: 12, label: "VDD 5V/3V3", kind: "text", size: 8, align: "end" },
    { x: 592, y: 296, w: 0, h: 0, label: "", kind: "pins", cols: 2, rows: 6, gap: 12 },
    { x: 560, y: 280, w: 64, h: 10, label: "IO3 · MS · RST · SLP", kind: "text", size: 7 },
    { x: 150, y: 150, w: 110, h: 24, label: "PiBot", kind: "text", size: 20 },
    { x: 150, y: 176, w: 110, h: 14, label: "ULTRA · Controller V5.88", kind: "text", size: 9 }
  ],
  hookups: {}
};

// =====================================================================
// Ruida RDC6445G / RDC6445S (CO2-Laser-Steuerung, eigene Firmware)
// Lage wie auf dem Bild der Hauptplatine im Ruida-Handbuch: oben CN6/CN5 (Laser 2/1) und AXIS_U…X,
// links CN0 (24 V), unten CN1 (Ausgänge), CN2 (Eingänge), CN3/CN4 (Endschalter), rechts Ethernet/USB.
// Pin 1 liegt oben rechts bzw. unten links (wie aufgedruckt).
// =====================================================================
const RD_GREEN = "#2f7d3c";
const rdTop = (id: string, label: string, x: number, pins: BPin[]): BConn => ({
  id, label, x, y: 24, dir: "h", labelPos: "above", pitch: 18, style: "screw", body: RD_GREEN, pinRot: true, pins
});
const rdBottom = (id: string, label: string, x: number, pins: BPin[]): BConn => ({
  id, label, x, y: 366, dir: "h", labelPos: "below", pitch: 18.5, style: "screw", body: RD_GREEN, pinRot: true, pins
});
const rdAxis = (id: string, label: string, x: number): BConn => rdTop(id, label, x, [
  { k: "5V", label: "+5V" }, { k: "PUL", label: "PUL−", fn: "Puls (OC)" }, { k: "DIR", label: "DIR−", fn: "Richtung (OC)" }
]);
const rdLaser = (id: string, label: string, x: number, i: number): BConn => rdTop(id, label, x, [
  { k: "AN", label: "L-AN" + i, fn: "Laserleistung analog" }, { k: "WP", label: "WP" + i, fn: "Wasserschutz (24 V)" },
  { k: "PWM", label: "LPWM" + i, fn: "Laserleistung PWM" }, { k: "ON", label: "L-ON" + i, fn: "Laser ein (aktiv low)" }, { k: "G", label: "GND" }
]);
const ruida6445: Board = {
  id: "ruida-rdc6445g",
  inputs: "ruida",
  maker: "Ruida",
  name: "Ruida RDC6445G / RDC6445S",
  mcu: "Ruida RDC644XG",
  fw: "wr.fw.ruida",
  source: "wr.src.ruida",
  volt: "24 V",
  w: 640, h: 392,
  pcb: { fill: "#c9ced6", edge: "#7d848e", light: true },
  holes: [{ x: 14, y: 14, r: 6 }, { x: 626, y: 14, r: 6 }, { x: 14, y: 378, r: 6 }, { x: 626, y: 378, r: 6 }],
  conns: [
    rdLaser("cn6", "CN6", 98, 2), rdLaser("cn5", "CN5", 205, 1),
    rdAxis("axu", "AXIS_U", 315), rdAxis("axz", "AXIS_Z", 384), rdAxis("axy", "AXIS_Y", 453), rdAxis("axx", "AXIS_X", 522),
    { id: "cn0", label: "CN0", x: 32, y: 172, dir: "v", labelPos: "below", pitch: 18, style: "screw", body: RD_GREEN, pinSide: "right",
      pins: [{ k: "G", label: "GND" }, { k: "24", label: "+24V" }] },
    rdBottom("cn1", "CN1", 91, [{ k: "G", label: "GND" }, { k: "O2", label: "Out2" }, { k: "O1", label: "Out1" },
      { k: "ST", label: "Status", fn: "Läuft (OC)" }, { k: "W", label: "Wind", fn: "Luft/Gebläse (OC)" }, { k: "24", label: "+24V" }]),
    rdBottom("cn2", "CN2", 212, [{ k: "G", label: "GND" }, { k: "FS", label: "FootSW", fn: "Fußschalter Start/Pause" },
      { k: "DR", label: "DrProt", fn: "Tür-Schutz" }, { k: "SH", label: "Shot", fn: "Laser von Hand" }, { k: "I1", label: "IN1" }, { k: "24", label: "+24V" }]),
    rdBottom("cn3", "CN3", 338, [{ k: "G", label: "GND" }, { k: "U-", label: "LmtU−" }, { k: "U+", label: "LmtU+" },
      { k: "Z-", label: "LmtZ−" }, { k: "Z+", label: "LmtZ+" }, { k: "5V", label: "Puzu" }]),
    rdBottom("cn4", "CN4", 459, [{ k: "G", label: "GND" }, { k: "Y-", label: "LmtY−" }, { k: "Y+", label: "LmtY+" },
      { k: "X-", label: "LmtX−" }, { k: "X+", label: "LmtX+" }, { k: "5V", label: "Puxy" }])
  ],
  deco: [
    { x: 290, y: 100, w: 0, h: 0, label: "", kind: "pins", cols: 15, rows: 1, gap: 19.6, oval: true },
    { x: 268, y: 168, w: 170, h: 52, label: "RDC644XG", kind: "chip" },
    { x: 34, y: 236, w: 60, h: 14, label: "HMI", kind: "text", size: 11 },
    { x: 590, y: 140, w: 44, h: 34, label: "", kind: "rj" }, { x: 548, y: 178, w: 86, h: 12, label: "Ethernet", kind: "text", size: 10 },
    { x: 596, y: 196, w: 38, h: 22, label: "", kind: "usb" }, { x: 548, y: 222, w: 86, h: 12, label: "Udisk", kind: "text", size: 10 },
    { x: 596, y: 240, w: 38, h: 22, label: "", kind: "usb" }, { x: 548, y: 266, w: 86, h: 12, label: "PC-USB", kind: "text", size: 10 }
  ],
  hookups: {}
};

/** Verdrahtung Ruida: externe Treiber (gemeinsame Anode), Endschalter an GND, CO2-Laser-Netzteil an CN5 */
function ruidaHookups(): Partial<Record<CompId, Hookup>> {
  const h: Partial<Record<CompId, Hookup>> = {};
  const drv = (axis: string, conn: string): Part => ({
    id: "drv" + axis, kind: "extdrv", name: axis, side: "top", pins: ["PUL+", "PUL−", "DIR+", "DIR−"],
    wires: [{ from: "PUL+", to: conn + ".5V", color: RED }, { from: "PUL−", to: conn + ".PUL", color: YEL },
      { from: "DIR+", to: conn + ".5V", color: RED }, { from: "DIR−", to: conn + ".DIR", color: GRN }]
  });
  h.psu = {
    comp: "psu",
    parts: [{ id: "psu", kind: "psu", name: "", side: "left", pins: ["+", "-"],
      wires: [{ from: "+", to: "cn0.24", color: RED }, { from: "-", to: "cn0.G", color: BLACK }] }],
    steps: [{ k: "wr.s.rd.psu.1" }, { k: "wr.s.rd.psu.2" }],
    notes: [{ k: "wr.n.rd.psu" }], pro: [{ k: "wr.p.rd.psu" }], settings: []
  };
  h.motors = {
    comp: "motors",
    parts: [drv("X", "axx"), drv("Y", "axy")],
    steps: [1, 2, 3, 4].map(i => ({ k: "wr.s.rd.mot." + i })),
    notes: [{ k: "wr.n.rd.mot" }], pro: [{ k: "wr.p.rd.mot" }], settings: []
  };
  h.extdrv = {
    comp: "extdrv",
    parts: [
      { ...drv("X", "axx"), side: "top" },
      { id: "mX", kind: "motor", name: "X", side: "top", outer: true, pins: ["1A", "1B", "2A", "2B"],
        wires: [{ from: "1A", to: "@drvX.A+", color: BLACK }, { from: "1B", to: "@drvX.A−", color: GRN }, { from: "2A", to: "@drvX.B+", color: RED }, { from: "2B", to: "@drvX.B−", color: BLU }] },
      { id: "psuD", kind: "psu", name: "", side: "top", outer: true, pins: ["+", "-"],
        wires: [{ from: "+", to: "@drvX.VCC", color: RED }, { from: "-", to: "@drvX.GND", color: BLACK }] }
    ],
    steps: [1, 2, 3, 4].map(i => ({ k: "wr.s.rd.mot." + i })),
    notes: [{ k: "wr.n.rd.mot" }], pro: [{ k: "wr.p.rd.mot" }], settings: []
  };
  h.limits = {
    comp: "limits",
    parts: [switchPart("X", "cn4", "X-", "G", "bottom"), switchPart("Y", "cn4", "Y-", "G", "bottom"), switchPart("Z", "cn3", "Z-", "G", "bottom")],
    steps: [1, 2, 3].map(i => ({ k: "wr.s.rd.lim." + i })),
    notes: [{ k: "wr.n.rd.lim" }], pro: [{ k: "wr.p.rd.lim" }], settings: []
  };
  h.laser = {
    comp: "laser",
    parts: [
      { id: "lpsu", kind: "lpsu", name: "", side: "top", pins: ["L", "IN", "G"],
        wires: [{ from: "L", to: "cn5.ON", color: GRN }, { from: "IN", to: "cn5.PWM", color: YEL }, { from: "G", to: "cn5.G", color: BLACK }] },
      { id: "flow", kind: "flow", name: "", side: "top", pins: ["NO", "C"],
        wires: [{ from: "NO", to: "cn5.WP", color: BLU }, { from: "C", to: "cn5.G", color: BLACK }] }
    ],
    steps: [1, 2, 3, 4, 5].map(i => ({ k: "wr.s.rd.las." + i })),
    notes: [{ k: "wr.n.rd.laser" }], pro: [{ k: "wr.p.rd.laser" }], settings: []
  };
  // ---- weitere Ein-/Ausgänge (wie im Gesamt-Schaltplan des Handbuchs, Bild 3.3-1) ----
  h.io = {
    comp: "io",
    parts: [
      { id: "foot", kind: "foot", name: "", side: "bottom", pins: ["NO", "C"],
        wires: [{ from: "NO", to: "cn2.FS", color: YEL }, { from: "C", to: "cn2.G", color: BLACK }] },
      { id: "shot", kind: "button", name: "", side: "bottom", pins: ["NO", "C"],
        wires: [{ from: "NO", to: "cn2.SH", color: VIO }, { from: "C", to: "cn2.G", color: BLACK }] },
      { id: "lamp", kind: "lamp", name: "", side: "bottom", pins: ["+", "-"],
        wires: [{ from: "+", to: "cn1.24", color: RED }, { from: "-", to: "cn1.ST", color: ORG }] }
    ],
    steps: [1, 2, 3].map(i => ({ k: "wr.s.rd.io." + i })),
    notes: [{ k: "wr.n.rd.io" }], pro: [], settings: []
  };
  h.air = {
    comp: "air",
    parts: [{ id: "relay", kind: "relay", name: "", side: "bottom", pins: ["+", "-"],
      wires: [{ from: "+", to: "cn1.24", color: RED }, { from: "-", to: "cn1.W", color: ORG }] },
      { id: "pump", kind: "pump", name: "", side: "bottom", outer: true, pins: ["+", "-"], wires: [{ from: "+", to: "@relay.NO", color: RED }] }],
    steps: [{ k: "wr.s.rd.air.1" }, { k: "wr.s.rd.air.2" }],
    notes: [{ k: "wr.n.rd.air" }], pro: [], settings: []
  };
  h.door = {
    comp: "door",
    parts: [{ id: "door", kind: "door", name: "", side: "bottom", pins: ["NO", "C"],
      wires: [{ from: "NO", to: "cn2.DR", color: YEL }, { from: "C", to: "cn2.G", color: BLACK }] }],
    steps: [{ k: "wr.s.rd.door.1" }, { k: "wr.s.rd.door.2" }],
    notes: [], pro: [], settings: []
  };
  h.estop = {
    comp: "estop",
    parts: [
      { id: "psu", kind: "psu", name: "", side: "left", pins: ["+", "-"], wires: [{ from: "-", to: "cn0.G", color: BLACK }] },
      { id: "estop", kind: "estop", name: "", side: "left", pins: ["1", "2"],
        wires: [{ from: "1", to: "@psu.+", color: RED }, { from: "2", to: "cn0.24", color: RED }] }
    ],
    steps: [{ k: "wr.s.estop.1" }, { k: "wr.s.rd.estop.2" }],
    notes: [{ k: "wr.n.rd.estop" }], pro: [{ k: "wr.p.estop" }], settings: []
  };
  const none = (comp: CompId): Hookup => ({ comp, parts: [], steps: [], notes: [], pro: [], settings: [], unavailable: "wr.u.rd" });
  h.probe = none("probe"); h.spindle = none("spindle"); h.plasma = none("plasma");
  return h;
}

// =====================================================================
// Verdrahtung je Board
// =====================================================================

/**
 * PiBot V4.96 Pro mit FluidNC: Pins stehen in der config.yaml – „Einstellungen“ zeigt deshalb YAML-Einträge
 * (Belegung wie in der Test-YAML von PiBot). Die Funktionen teilen sich einige Pins (IO4, IO12, IO14/15, IO26),
 * die Hinweise sagen jeweils, was dann nicht gleichzeitig geht.
 */
function pibotHookups(): Partial<Record<CompId, Hookup>> {
  const h: Partial<Record<CompId, Hookup>> = {};
  h.psu = {
    comp: "psu",
    parts: [{ id: "psu", kind: "psu", name: "", side: "right", pins: ["+", "-"],
      wires: [{ from: "+", to: "pwr.+", color: RED }, { from: "-", to: "pwr.-", color: BLACK }, { from: "+", to: "vdrv.+", color: RED }, { from: "-", to: "vdrv.-", color: BLACK }] }],
    steps: [{ k: "wr.s.psu.1" }, { k: "wr.s.pb.psu" }, { k: "wr.s.psu.3", p: { volt: "24 V (12–24 V)" } }],
    notes: [{ k: "wr.n.pb.psu" }],
    pro: [{ k: "wr.p.vref" }],
    settings: []
  };
  const motors = ["X", "Y", "Z", "A", "B", "C"].map(a => motorPart(a, "m" + a.toLowerCase(), "bottom"));
  h.motors = {
    comp: "motors",
    parts: motors,
    steps: [{ k: "wr.s.mot.1" }, { k: "wr.s.mot.2", p: { conns: "X, Y, Z, A, B, C" } }, { k: "wr.s.pb.mot.jmp" }, { k: "wr.s.mot.3" }, { k: "wr.s.pb.mot.4" }],
    notes: [{ k: "wr.n.pb.mot" }],
    pro: [{ k: "wr.p.pb.micro" }],
    settings: ["axes/x/steps_per_mm", "axes/x/motor0/stepstick:", "step_pin: I2SO.2", "direction_pin: I2SO.1", "disable_pin: I2SO.0"]
  };
  // Externer Treiber: dieselbe Klemme wie der Motor, mit Brücken liegen dort EN STP DIR GND
  h.extdrv = {
    comp: "extdrv",
    parts: [
      { id: "drv", kind: "extdrv", name: "X", side: "bottom", pins: ["PUL+", "PUL−", "DIR+", "DIR−", "ENA+", "ENA−"],
        wires: [{ from: "PUL+", to: "mx.2A", color: YEL }, { from: "PUL−", to: "mx.1B", color: BLACK }, { from: "DIR+", to: "mx.1A", color: GRN },
          { from: "DIR−", to: "mx.1B", color: BLACK }, { from: "ENA+", to: "mx.2B", color: VIO }, { from: "ENA−", to: "mx.1B", color: BLACK }] },
      { id: "mX", kind: "motor", name: "X", side: "left", outer: true, pins: ["1A", "1B", "2A", "2B"],
        wires: [{ from: "1A", to: "@drv.A+", color: BLACK }, { from: "1B", to: "@drv.A−", color: GRN }, { from: "2A", to: "@drv.B+", color: RED }, { from: "2B", to: "@drv.B−", color: BLU }] },
      { id: "psu", kind: "psu", name: "", side: "left", outer: true, pins: ["+", "-"],
        wires: [{ from: "+", to: "@drv.VCC", color: RED }, { from: "-", to: "@drv.GND", color: BLACK }] }
    ],
    steps: [{ k: "wr.s.ext.1" }, { k: "wr.s.pb.ext.2" }, { k: "wr.s.ext.3" }, { k: "wr.s.ext.4" }, { k: "wr.s.pb.ext.5" }, { k: "wr.s.pb.ext.6" }],
    notes: [{ k: "wr.n.pb.ext" }],
    pro: [{ k: "wr.p.pb.ext" }],
    settings: ["axes/x/motor0/standard_stepper:", "step_pin: I2SO.2", "direction_pin: I2SO.1", "disable_pin: I2SO.0", "stepping/pulse_us: 5"]
  };
  h.limits = {
    comp: "limits",
    parts: [switchPart("X", "lx"), switchPart("Y", "ly"), switchPart("Z", "lz")],
    steps: [{ k: "wr.s.lim.1", p: { sig: "IO33 / IO32 / IO35", gnd: "GND" } }, { k: "wr.s.lim.2" }, { k: "wr.s.pb.lim.3" }],
    notes: [{ k: "wr.n.pb.lim" }],
    pro: [{ k: "wr.p.pb.nc" }],
    settings: ["x/motor0/limit_neg_pin: gpio.33:low", "y/motor0/limit_neg_pin: gpio.32:low", "z/motor0/limit_neg_pin: gpio.35:low", "hard_limits: true", "homing/cycle"]
  };
  h.probe = {
    comp: "probe",
    parts: [
      { id: "probe", kind: "probe", name: "", side: "top", pins: ["S", "G"],
        wires: [{ from: "S", to: "probe.S", color: YEL }, { from: "G", to: "probe.G", color: BLACK }] },
      { id: "wls", kind: "wls", name: "", side: "top", pins: ["S", "G"],
        wires: [{ from: "S", to: "probe.S2", color: ORG }, { from: "G", to: "probe.G2", color: BLACK }] }
    ],
    steps: [{ k: "wr.s.probe.1", p: { sig: "IO2", gnd: "GND" } }, { k: "wr.s.pb.probe.2" }, { k: "wr.s.probe.3" }],
    notes: [{ k: "wr.n.pb.probe" }],
    pro: [{ k: "wr.p.pb.probe" }],
    settings: ["probe/pin: gpio.2:pu:low", "probe/toolsetter_pin: gpio.26:low"]
  };
  h.laser = {
    comp: "laser",
    parts: [
      { id: "laser", kind: "laser", name: "", side: "top", pins: ["PWM", "GND", "VCC"],
        wires: [{ from: "PWM", to: "out.12", color: YEL }, { from: "GND", to: "gnd.G", color: BLACK }, { from: "VCC", to: "@psu.+", color: RED }] },
      { id: "psu", kind: "psu", name: "", side: "top", pins: ["+", "-"], wires: [{ from: "-", to: "gnd.G", color: BLACK }] }
    ],
    steps: [{ k: "wr.s.laser.1", p: { sig: "Outputs 5V IO12", gnd: "GND", vcc: "12/24 V" } }, { k: "wr.s.laser.2" }, { k: "wr.s.pb.laser.3" }],
    notes: [{ k: "wr.n.pb.laser" }],
    pro: [{ k: "wr.p.pb.laser" }],
    settings: ["Laser:", "output_pin: gpio.12", "speed_map: 0=0% 1000=100%", "tool_num: 0"]
  };
  h.spindle = {
    comp: "spindle",
    parts: [{ id: "vfd", kind: "inv", name: "", side: "top", pins: ["FOR", "DCM", "AVI", "ACM"],
      wires: [{ from: "FOR", to: "v10.F", color: GRN }, { from: "DCM", to: "v10.C", color: BLACK }, { from: "AVI", to: "v10.V", color: VIO }, { from: "ACM", to: "v10.G", color: BLACK }] }],
    steps: [{ k: "wr.s.pb.sp.1" }, { k: "wr.s.pb.sp.2" }, { k: "wr.s.pb.sp.3" }, { k: "wr.s.sp.2" }, { k: "wr.s.pb.sp.4" }],
    notes: [{ k: "wr.n.pb.sp" }],
    pro: [{ k: "wr.p.pb.vfd" }],
    settings: ["10V:", "output_pin: gpio.13", "forward_pin: gpio.14", "reverse_pin: gpio.15", "speed_map: 0=0% 24000=100%"]
  };
  h.plasma = {
    comp: "plasma",
    parts: [{ id: "plasma", kind: "plasma", name: "", side: "right", pins: ["T1", "T2"],
      wires: [{ from: "T1", to: "relay.NO", color: WHT }, { from: "T2", to: "relay.COM", color: WHT }] }],
    steps: [{ k: "wr.s.pb.pl.1" }, { k: "wr.s.pl.2" }, { k: "wr.s.pl.4" }],
    notes: [{ k: "wr.n.plasma.hf" }, { k: "wr.n.pb.relay" }],
    pro: [{ k: "wr.p.arcok" }],
    settings: ["relay:", "output_pin: gpio.26", "tool_num: 0"]
  };
  h.air = {
    comp: "air",
    parts: [{ id: "pump", kind: "pump", name: "", side: "right", pins: ["+", "-"],
      wires: [{ from: "+", to: "mos.V", color: RED }, { from: "-", to: "mos.4", color: BLACK }] }],
    steps: [{ k: "wr.s.pb.air" }, { k: "wr.s.air.2" }],
    notes: [{ k: "wr.n.pb.air" }], pro: [], settings: ["coolant/flood_pin: gpio.4"]
  };
  h.estop = {
    comp: "estop",
    parts: [
      { id: "psu", kind: "psu", name: "", side: "right", pins: ["+", "-"], wires: [{ from: "-", to: "pwr.-", color: BLACK }, { from: "-", to: "vdrv.-", color: BLACK }] },
      { id: "estop", kind: "estop", name: "", side: "right", pins: ["1", "2"],
        wires: [{ from: "1", to: "@psu.+", color: RED }, { from: "2", to: "pwr.+", color: RED }, { from: "2", to: "vdrv.+", color: RED }] }
    ],
    steps: [{ k: "wr.s.estop.1" }, { k: "wr.s.estop.2" }],
    notes: [{ k: "wr.n.pb.estop" }],
    pro: [{ k: "wr.p.estop" }],
    settings: []
  };
  h.door = {
    comp: "door",
    parts: [{ id: "door", kind: "door", name: "", side: "top", pins: ["NO", "C"], wires: [{ from: "NO", to: "probe.S2", color: YEL }, { from: "C", to: "probe.G2", color: BLACK }] }],
    steps: [{ k: "wr.s.door.1", p: { sig: "IO26", gnd: "GND" } }, { k: "wr.s.pb.door" }],
    notes: [], pro: [], settings: ["control/safety_door_pin: gpio.26:low"]
  };
  return h;
}

/** PiBot V5.88 Ultra mit FluidNC – Belegung wie in der Test-YAML von PiBot (Einstellungen = YAML-Einträge) */
function pibotUltraHookups(): Partial<Record<CompId, Hookup>> {
  const h: Partial<Record<CompId, Hookup>> = {};
  h.psu = {
    comp: "psu",
    parts: [{ id: "psu", kind: "psu", name: "", side: "right", pins: ["+", "-"],
      wires: [{ from: "+", to: "pwr.+", color: RED }, { from: "-", to: "pwr.-", color: BLACK }, { from: "+", to: "vdrv.+", color: RED }, { from: "-", to: "vdrv.-", color: BLACK }] }],
    steps: [{ k: "wr.s.psu.1" }, { k: "wr.s.pu.psu" }, { k: "wr.s.psu.3", p: { volt: "24 V (12–24 V)" } }],
    notes: [{ k: "wr.n.pu.psu" }],
    pro: [{ k: "wr.p.vref" }],
    settings: []
  };
  const motors = ["X", "Y", "Z", "A", "B", "C"].map(a => motorPart(a, "m" + a.toLowerCase(), "bottom"));
  h.motors = {
    comp: "motors",
    parts: motors,
    steps: [{ k: "wr.s.mot.1" }, { k: "wr.s.mot.2", p: { conns: "X, Y, Z, A, B, C" } }, { k: "wr.s.pu.mot" }, { k: "wr.s.mot.3" }, { k: "wr.s.pb.mot.4" }],
    notes: [{ k: "wr.n.pu.mot" }],
    pro: [{ k: "wr.p.pu.micro" }],
    settings: ["axes/x/steps_per_mm", "axes/x/motor0/standard_stepper:", "step_pin: I2SO.2", "direction_pin: I2SO.1", "disable_pin: I2SO.0"]
  };
  h.extdrv = {
    comp: "extdrv",
    parts: [
      { id: "drv", kind: "extdrv", name: "X", side: "left", pins: ["PUL+", "PUL−", "DIR+", "DIR−", "ENA+", "ENA−"],
        wires: [{ from: "PUL+", to: "ex.STP", color: YEL }, { from: "PUL−", to: "ex.G", color: BLACK }, { from: "DIR+", to: "ex.DIR", color: GRN },
          { from: "DIR−", to: "ex.G", color: BLACK }, { from: "ENA+", to: "ex.EN", color: VIO }, { from: "ENA−", to: "ex.G", color: BLACK }] },
      { id: "mX", kind: "motor", name: "X", side: "left", outer: true, pins: ["1A", "1B", "2A", "2B"],
        wires: [{ from: "1A", to: "@drv.A+", color: BLACK }, { from: "1B", to: "@drv.A−", color: GRN }, { from: "2A", to: "@drv.B+", color: RED }, { from: "2B", to: "@drv.B−", color: BLU }] },
      { id: "psu", kind: "psu", name: "", side: "left", outer: true, pins: ["+", "-"],
        wires: [{ from: "+", to: "@drv.VCC", color: RED }, { from: "-", to: "@drv.GND", color: BLACK }] }
    ],
    steps: [{ k: "wr.s.ext.1" }, { k: "wr.s.pu.ext.2" }, { k: "wr.s.ext.3" }, { k: "wr.s.ext.4" }, { k: "wr.s.pu.ext.5" }, { k: "wr.s.pu.ext.6" }],
    notes: [{ k: "wr.n.pb.ext" }],
    pro: [{ k: "wr.p.pu.ext" }],
    settings: ["axes/x/motor0/standard_stepper:", "step_pin: I2SO.2", "direction_pin: I2SO.1", "disable_pin: I2SO.0", "stepping/pulse_us: 5"]
  };
  h.limits = {
    comp: "limits",
    parts: [switchPart("X", "lx"), switchPart("Y", "ly"), switchPart("Z", "lz")],
    steps: [{ k: "wr.s.lim.1", p: { sig: "IO42 / IO40 / IO38", gnd: "GND" } }, { k: "wr.s.lim.2" }, { k: "wr.s.pu.lim.3" }],
    notes: [{ k: "wr.n.pu.lim" }],
    pro: [{ k: "wr.p.pb.nc" }],
    settings: ["x/motor0/limit_neg_pin: gpio.42:low", "x/motor0/limit_pos_pin: gpio.41:low", "y/motor0/limit_neg_pin: gpio.40:low",
      "y/motor0/limit_pos_pin: gpio.39:low", "z/motor0/limit_neg_pin: gpio.38:low", "hard_limits: true"]
  };
  h.probe = {
    comp: "probe",
    parts: [
      { id: "probe", kind: "probe", name: "", side: "left", pins: ["S", "G"],
        wires: [{ from: "S", to: "lp.S", color: YEL }, { from: "G", to: "lp.G", color: BLACK }] },
      { id: "wls", kind: "wls", name: "", side: "top", pins: ["S", "G"],
        wires: [{ from: "S", to: "lts.S", color: ORG }, { from: "G", to: "lts.G", color: BLACK }] }
    ],
    steps: [{ k: "wr.s.probe.1", p: { sig: "Probe IO47", gnd: "GND" } }, { k: "wr.s.pu.probe.2" }, { k: "wr.s.probe.3" }],
    notes: [{ k: "wr.n.pu.probe" }],
    pro: [{ k: "wr.p.pb.probe" }],
    settings: ["probe/pin: gpio.47:low", "probe/toolsetter_pin: gpio.3:low"]
  };
  h.laser = {
    comp: "laser",
    parts: [
      { id: "laser", kind: "laser", name: "", side: "top", pins: ["PWM", "GND", "VCC"],
        wires: [{ from: "PWM", to: "pwm.46", color: YEL }, { from: "GND", to: "pwm.G", color: BLACK }, { from: "VCC", to: "@psu.+", color: RED }] },
      { id: "psu", kind: "psu", name: "", side: "top", pins: ["+", "-"], wires: [{ from: "-", to: "pwm.G", color: BLACK }] }
    ],
    steps: [{ k: "wr.s.laser.1", p: { sig: "PWM 5V IO46", gnd: "GND", vcc: "12/24 V" } }, { k: "wr.s.laser.2" }, { k: "wr.s.pu.laser.3" }],
    notes: [{ k: "wr.n.pu.laser" }],
    pro: [{ k: "wr.p.pb.laser" }],
    settings: ["Laser:", "output_pin: gpio.46", "speed_map: 0=0% 1000=100%", "tool_num: 1"]
  };
  h.spindle = {
    comp: "spindle",
    parts: [{ id: "vfd", kind: "inv", name: "", side: "top", pins: ["REV", "FOR", "DCM", "AVI", "ACM"],
      wires: [{ from: "REV", to: "v10.R", color: ORG }, { from: "FOR", to: "v10.F", color: GRN }, { from: "DCM", to: "v10.C", color: BLACK },
        { from: "AVI", to: "v10.V", color: VIO }, { from: "ACM", to: "v10.G", color: BLACK }] }],
    steps: [{ k: "wr.s.pu.sp.1" }, { k: "wr.s.pu.sp.2" }, { k: "wr.s.pu.sp.3" }, { k: "wr.s.sp.2" }, { k: "wr.s.pu.sp.4" }],
    notes: [{ k: "wr.n.pu.sp" }],
    pro: [{ k: "wr.p.pu.vfd" }],
    settings: ["10V:", "output_pin: gpio.6", "forward_pin: gpio.7", "reverse_pin: gpio.8", "speed_map: 0=0% 24000=100%"]
  };
  h.plasma = {
    comp: "plasma",
    parts: [
      { id: "relay", kind: "relay", name: "24 V", side: "right", pins: ["+", "-"],
        wires: [{ from: "+", to: "m4.V", color: RED }, { from: "-", to: "m4.4", color: BLACK }] },
      { id: "plasma", kind: "plasma", name: "", side: "right", outer: true, pins: ["T1", "T2"],
        wires: [{ from: "T1", to: "@relay.NO", color: WHT }, { from: "T2", to: "@relay.COM", color: WHT }] }
    ],
    steps: [{ k: "wr.s.pu.pl.1" }, { k: "wr.s.pl.2" }, { k: "wr.s.pl.4" }],
    notes: [{ k: "wr.n.plasma.hf" }, { k: "wr.n.pu.pl" }],
    pro: [{ k: "wr.p.arcok" }],
    settings: ["relay:", "output_pin: gpio.4", "coolant/mist_pin: NO_PIN"]
  };
  h.air = {
    comp: "air",
    parts: [{ id: "pump", kind: "pump", name: "", side: "right", pins: ["+", "-"],
      wires: [{ from: "+", to: "m5.V", color: RED }, { from: "-", to: "m5.5", color: BLACK }] }],
    steps: [{ k: "wr.s.pu.air" }, { k: "wr.s.air.2" }],
    notes: [{ k: "wr.n.pu.air" }], pro: [], settings: ["coolant/flood_pin: gpio.5"]
  };
  h.estop = {
    comp: "estop",
    parts: [
      { id: "psu", kind: "psu", name: "", side: "right", pins: ["+", "-"], wires: [{ from: "-", to: "pwr.-", color: BLACK }, { from: "-", to: "vdrv.-", color: BLACK }] },
      { id: "estop", kind: "estop", name: "", side: "right", pins: ["1", "2"],
        wires: [{ from: "1", to: "@psu.+", color: RED }, { from: "2", to: "pwr.+", color: RED }, { from: "2", to: "vdrv.+", color: RED }] }
    ],
    steps: [{ k: "wr.s.estop.1" }, { k: "wr.s.estop.2" }],
    notes: [{ k: "wr.n.pb.estop" }],
    pro: [{ k: "wr.p.estop" }],
    settings: []
  };
  h.door = {
    comp: "door",
    parts: [{ id: "door", kind: "door", name: "", side: "left", pins: ["NO", "C"], wires: [{ from: "NO", to: "lc.S", color: YEL }, { from: "C", to: "lc.G", color: BLACK }] }],
    steps: [{ k: "wr.s.door.1", p: { sig: "C− IO48", gnd: "GND" } }, { k: "wr.s.pu.door" }],
    notes: [], pro: [], settings: ["control/safety_door_pin: gpio.48:low"]
  };
  return h;
}

function hookupsFor(b: Board): Partial<Record<CompId, Hookup>> {
  if (b.maker === "Ruida") return ruidaHookups();
  if (b.id === "pibot-v588-ultra") return pibotUltraHookups();
  if (b.maker === "PiBot") return pibotHookups();
  const isShield = b.id === "cnc-shield-v3";
  const isMax = b.id === "mks-dlc32-max";
  const h: Partial<Record<CompId, Hookup>> = {};
  const P = (c: string, p: string) => `${b.conns.find(x => x.id === c)?.label} ${p}`.trim();

  // ---- Netzteil ----
  h.psu = {
    comp: "psu",
    parts: [{ id: "psu", kind: "psu", name: "", side: isShield ? "left" : "bottom", pins: ["+", "-"],
      wires: [{ from: "+", to: "pwr.+", color: RED }, { from: "-", to: "pwr.-", color: BLACK }] }],
    steps: [{ k: "wr.s.psu.1" }, { k: "wr.s.psu.2", p: { plus: P("pwr", "+"), minus: P("pwr", "−") } }, { k: "wr.s.psu.3", p: { volt: b.volt } }],
    notes: isShield ? [{ k: "wr.n.shield.psu" }] : [{ k: "wr.n.dlc.psu" }],
    pro: [{ k: "wr.p.vref" }],
    settings: []
  };

  // ---- Motoren ----
  const motors: Part[] = isShield
    ? [motorPart("X", "mx"), motorPart("Y", "my"), motorPart("Z", "mz", "bottom"), motorPart("A", "ma", "bottom")]
    : isMax
      ? [motorPart("X", "mx"), motorPart("Y1", "my1"), motorPart("Y2", "my2"), motorPart("Z", "mz"), motorPart("A", "ma")]
      : [motorPart("X", "mx"), motorPart("Y1", "my1"), motorPart("Y2", "my2"), motorPart("Z", "mz")];
  const motorPro: Step[] = [{ k: "wr.p.micro" }];
  if (!isShield) motorPro.push({ k: "wr.p.extdrv" });
  h.motors = {
    comp: "motors",
    parts: motors,
    steps: [{ k: "wr.s.mot.1" }, { k: "wr.s.mot.2", p: { conns: motors.map(m => b.conns.find(c => c.id === m.wires[0].to.split(".")[0])!.label).join(", ") } }, { k: "wr.s.mot.3" }, { k: "wr.s.mot.4" },
      // Motor A als zweiter Motor einer Achse (X, Y oder Z)
      ...(isShield ? [1, 2, 3, 4].map(i => ({ k: "wr.s.motA.sh." + i }))
        : isMax ? [1, 2, 3, 4].map(i => ({ k: "wr.s.motA.max." + i })) : [])],
    notes: isShield ? [{ k: "wr.n.shield.motA" }, { k: "wr.n.shield.motA2" }]
      : isMax ? [{ k: "wr.n.dlc.y12" }, { k: "wr.n.max.grblhal" }] : [{ k: "wr.n.dlc.y12" }],
    pro: isShield ? [...motorPro, { k: "wr.p.shield.square" }] : motorPro,
    settings: isMax ? ["$3", "$100 / $101 / $102", "$110 / $111 / $112", "$8 (grblHAL)"] : ["$3", "$100 / $101 / $102", "$110 / $111 / $112"]
  };

  // ---- Externe Treiber (TB6600, DM542 …) – Beispiel X-Achse, gemeinsame Masse (PUL−/DIR−/ENA− an GND) ----
  // Shield: Leiste links (X.STEP/DIR, EN/GND), MKS: Leiste „E S D G“ unter dem Treiber-Steckplatz
  const ex = isShield ? { pul: "xsd.S", dir: "xsd.D", ena: "eng.E", gnd: "eng.G" } : { pul: "esd_x.S", dir: "esd_x.D", ena: "esd_x.E", gnd: "esd_x.G" };
  h.extdrv = {
    comp: "extdrv",
    parts: [
      { id: "drv", kind: "extdrv", name: "X", side: "left", pins: ["PUL+", "PUL−", "DIR+", "DIR−", "ENA+", "ENA−"],
        wires: [{ from: "PUL+", to: ex.pul, color: YEL }, { from: "PUL−", to: ex.gnd, color: BLACK }, { from: "DIR+", to: ex.dir, color: GRN },
          { from: "DIR−", to: ex.gnd, color: BLACK }, { from: "ENA+", to: ex.ena, color: VIO }, { from: "ENA−", to: ex.gnd, color: BLACK }] },
      { id: "mX", kind: "motor", name: "X", side: "left", outer: true, pins: ["1A", "1B", "2A", "2B"],
        wires: [{ from: "1A", to: "@drv.A+", color: BLACK }, { from: "1B", to: "@drv.A−", color: GRN }, { from: "2A", to: "@drv.B+", color: RED }, { from: "2B", to: "@drv.B−", color: BLU }] },
      { id: "psu", kind: "psu", name: "", side: "left", outer: true, pins: ["+", "-"],
        wires: [{ from: "+", to: "@drv.VCC", color: RED }, { from: "-", to: "@drv.GND", color: BLACK }] }
    ],
    steps: [
      { k: "wr.s.ext.1" },
      { k: isShield ? "wr.s.ext.2.sh" : "wr.s.ext.2.mks" },
      { k: "wr.s.ext.3" }, { k: "wr.s.ext.4" }, { k: "wr.s.ext.5" }, { k: "wr.s.ext.6" }
    ],
    notes: isShield ? [{ k: "wr.n.ext.sh" }] : [{ k: "wr.n.ext.mks" }],
    pro: [{ k: isShield ? "wr.p.ext.sh" : "wr.p.ext.mks" }, { k: "wr.p.ext.anode" }],
    settings: ["$0=10", "$100 / $101 / $102", "$4"]
  };

  // ---- Endschalter ----
  const lim: Part[] = isShield
    ? [switchPart("X", "lx"), switchPart("Y", "ly"), switchPart("Z", "spe")]
    : isMax
      ? [switchPart("X", "lx"), switchPart("Y", "ly"), switchPart("Z", "lz"), switchPart("A", "la")]
      : [switchPart("X", "lx"), switchPart("Y", "ly"), switchPart("Z", "lz")];
  h.limits = {
    comp: "limits",
    parts: lim,
    steps: [{ k: "wr.s.lim.1", p: { sig: "S", gnd: "GND" } }, { k: "wr.s.lim.2" }, { k: "wr.s.lim.3" }],
    notes: isShield ? [{ k: "wr.n.shield.zlim" }] : [{ k: "wr.n.dlc.3pin" }],
    pro: [{ k: "wr.p.nc" }],
    settings: ["$5", "$21=1", "$22=1", "$23", "$130 / $131 / $132"]
  };

  // ---- Taster / Werkzeuglängensensor ----
  const pc = isShield ? "scl" : "probe";
  h.probe = {
    comp: "probe",
    parts: [
      { id: "probe", kind: "probe", name: "", side: "right", pins: ["S", "G"],
        wires: [{ from: "S", to: `${pc}.S`, color: YEL }, { from: "G", to: `${pc}.G`, color: BLACK }] },
      { id: "wls", kind: "wls", name: "", side: "right", pins: ["S", "G"],
        wires: [{ from: "S", to: `${pc}.S`, color: ORG }, { from: "G", to: `${pc}.G`, color: BLACK }] }
    ],
    steps: [{ k: "wr.s.probe.1", p: isShield ? { sig: "SCL (A5)", gnd: "GND" } : { sig: P(pc, "S"), gnd: P(pc, "GND") } }, { k: "wr.s.probe.2" }, { k: "wr.s.probe.3" }],
    notes: isShield ? [{ k: "wr.n.shield.probe" }] : [{ k: "wr.n.dlc.3pin" }],
    pro: [{ k: "wr.p.probe" }],
    settings: ["$6"]
  };

  // ---- Laser ----
  const laserWires: Wire[] = isShield
    ? [{ from: "PWM", to: "lz.S", color: YEL }, { from: "GND", to: "lz.G", color: BLACK }, { from: "VCC", to: "@psu.+", color: RED }]
    : [{ from: "PWM", to: "ttl.S", color: YEL }, { from: "GND", to: "ttl.G", color: BLACK }, { from: "VCC", to: "ttl.V", color: RED }];
  const laserParts: Part[] = [{ id: "laser", kind: "laser", name: "", side: isShield ? "right" : (isMax ? "left" : "top"), pins: ["PWM", "GND", "VCC"], wires: laserWires }];
  if (isShield) laserParts.push({ id: "psu", kind: "psu", name: "", side: "right", pins: ["+", "-"], wires: [{ from: "-", to: "lz.G", color: BLACK }] });
  h.laser = {
    comp: "laser",
    parts: laserParts,
    steps: [{ k: "wr.s.laser.1", p: { sig: isShield ? P("lz", "S (D11)") : P("ttl", b.conns.find(c => c.id === "ttl")!.pins[0].label), gnd: "GND", vcc: isShield ? "12/24 V" : P("ttl", b.conns.find(c => c.id === "ttl")!.pins[2].label) } },
      { k: "wr.s.laser.2" }, { k: "wr.s.laser.3" }],
    notes: isShield ? [{ k: "wr.n.shield.laser" }] : [{ k: "wr.n.dlc.laser" }],
    pro: [{ k: "wr.p.laser" }],
    settings: ["$32=1", "$30=1000", "$31=0"]
  };

  // ---- Spindel ----
  const spParts: Part[] = isShield
    ? [{ id: "relay", kind: "relay", name: "", side: "right", pins: ["IN", "GND", "VCC"],
        wires: [{ from: "IN", to: "lz.S", color: YEL }, { from: "GND", to: "lz.G", color: BLACK }, { from: "VCC", to: "v5.5V", color: RED }] },
       // Wandler an Z+ (auch D11) – so liegt er nicht auf demselben Stift wie das Relais
       { id: "vfd", kind: "vfd", name: "", side: "right", pins: ["PWM", "GND"],
        wires: [{ from: "PWM", to: "lzp.S", color: VIO }, { from: "GND", to: "lzp.G", color: BLACK }] }]
    : [{ id: "relay", kind: "relay", name: "", side: "left", pins: ["+", "-"],
        wires: [{ from: "+", to: "spin.+", color: RED }, { from: "-", to: "spin.-", color: BLACK }] }];
  h.spindle = {
    comp: "spindle",
    parts: spParts,
    steps: isShield
      ? [{ k: "wr.s.sp.1", p: { sig: P("lz", "S (D11)"), gnd: "GND", vcc: "5V" } }, { k: "wr.s.sp.2" }, { k: "wr.s.sp.3", p: { sig: P("lzp", "S (D11)"), gnd: "GND" } }, { k: "wr.s.sp.4" }]
      : [{ k: "wr.s.sp.dlc", p: { conn: P("spin", "") } }, { k: "wr.s.sp.2" }, { k: "wr.s.sp.4" }],
    notes: isShield ? [{ k: "wr.n.shield.spindle" }] : [{ k: "wr.n.dlc.spindle" }],
    pro: [{ k: "wr.p.vfd" }],
    settings: ["$32=0", "$30", "$31"]
  };

  // ---- Plasma ----
  const plParts: Part[] = isShield
    ? [{ id: "relay", kind: "relay", name: "", side: "right", pins: ["IN", "GND", "VCC"],
        wires: [{ from: "IN", to: "lz.S", color: YEL }, { from: "GND", to: "lz.G", color: BLACK }, { from: "VCC", to: "v5.5V", color: RED }] },
       { id: "plasma", kind: "plasma", name: "", side: "right", outer: true, pins: ["T1", "T2"],
        wires: [{ from: "T1", to: "@relay.NO", color: WHT }, { from: "T2", to: "@relay.COM", color: WHT }] },
       { id: "thc", kind: "thc", name: "", side: "bottom", pins: ["EN", "GND"],
        wires: [{ from: "EN", to: "cool.S", color: GRN }, { from: "GND", to: "cool.G", color: BLACK }] }]
    : [{ id: "relay", kind: "relay", name: "", side: "left", pins: ["+", "-"],
        wires: [{ from: "+", to: "spin.+", color: RED }, { from: "-", to: "spin.-", color: BLACK }] },
       { id: "plasma", kind: "plasma", name: "", side: "left", outer: true, pins: ["T1", "T2"],
        wires: [{ from: "T1", to: "@relay.NO", color: WHT }, { from: "T2", to: "@relay.COM", color: WHT }] }];
  const thcTarget = isShield ? P("cool", "S (A3)") : isMax ? P("air", "") : P("i2c", "SCL");
  h.plasma = {
    comp: "plasma",
    parts: plParts,
    steps: [{ k: "wr.s.pl.1", p: { sig: isShield ? P("lz", "S (D11)") : P("spin", "") } }, { k: "wr.s.pl.2" }, { k: "wr.s.pl.3", p: { thc: thcTarget } }, { k: "wr.s.pl.4" }],
    notes: [{ k: "wr.n.plasma.hf" }],
    pro: [{ k: "wr.p.arcok" }],
    settings: []
  };

  // ---- Luft / Kühlung ----
  h.air = isShield ? {
    comp: "air",
    parts: [{ id: "relay", kind: "relay", name: "", side: "bottom", pins: ["IN", "GND", "VCC"],
      wires: [{ from: "IN", to: "cool.S", color: GRN }, { from: "GND", to: "cool.G", color: BLACK }, { from: "VCC", to: "v5.5V", color: RED }] },
      { id: "pump", kind: "pump", name: "", side: "bottom", outer: true, pins: ["+", "-"], wires: [{ from: "+", to: "@relay.NO", color: RED }] }],
    steps: [{ k: "wr.s.air.1", p: { sig: P("cool", "S (A3)"), gnd: "GND" } }, { k: "wr.s.air.2" }],
    notes: [{ k: "wr.n.shield.air" }], pro: [], settings: []
  } : isMax ? {
    comp: "air",
    parts: [{ id: "pump", kind: "pump", name: "", side: "top", pins: ["+", "-"], wires: [{ from: "+", to: "air.+", color: RED }, { from: "-", to: "air.-", color: BLACK }] }],
    steps: [{ k: "wr.s.air.max", p: { conn: "+AIR−" } }, { k: "wr.s.air.2" }],
    notes: [{ k: "wr.n.max.air" }], pro: [], settings: []
  } : {
    comp: "air",
    parts: [{ id: "relay", kind: "relay", name: "", side: "right", pins: ["IN", "GND", "VCC"],
      wires: [{ from: "IN", to: "i2c.SCL", color: GRN }, { from: "GND", to: "i2c.G", color: BLACK }, { from: "VCC", to: "i2c.3V3", color: RED }] }],
    steps: [{ k: "wr.s.air.1", p: { sig: P("i2c", "SCL"), gnd: "GND" } }, { k: "wr.s.air.2" }],
    notes: [{ k: "wr.n.dlc.air" }], pro: [], settings: []
  };

  // ---- Not-Aus ----
  h.estop = {
    comp: "estop",
    parts: [
      { id: "psu", kind: "psu", name: "", side: isShield ? "left" : "bottom", pins: ["+", "-"], wires: [{ from: "-", to: "pwr.-", color: BLACK }] },
      { id: "estop", kind: "estop", name: "", side: isShield ? "left" : "bottom", pins: ["1", "2"],
        wires: [{ from: "1", to: "@psu.+", color: RED }, { from: "2", to: "pwr.+", color: RED }] }
    ],
    steps: [{ k: "wr.s.estop.1" }, { k: "wr.s.estop.2" }],
    notes: isShield ? [{ k: "wr.n.shield.estop" }] : [{ k: "wr.n.dlc.estop" }],
    pro: [{ k: "wr.p.estop" }],
    settings: []
  };

  // ---- Tür ----
  h.door = isMax ? {
    comp: "door",
    parts: [{ id: "door", kind: "door", name: "", side: "right", pins: ["NO", "C"], wires: [{ from: "NO", to: "door.S", color: YEL }, { from: "C", to: "door.G", color: BLACK }] }],
    steps: [{ k: "wr.s.door.1", p: { sig: "Door S (IO38)", gnd: "Door GND" } }],
    notes: [], pro: [], settings: []
  } : { comp: "door", parts: [], steps: [], notes: [], pro: [], settings: [], unavailable: isShield ? "wr.u.door.shield" : "wr.u.door.dlc21" };

  return h;
}


export const BOARDS: Board[] = [shield, dlc21, dlcMax, pibot, pibotUltra, ruida6445];
for (const b of BOARDS) b.hookups = hookupsFor(b);

export function getBoard(id: string): Board {
  return BOARDS.find(b => b.id === id) || BOARDS[0];
}

// =====================================================================
// Induktive Sensoren (NPN/PNP, 3 Drähte) statt Schalter bzw. Längensensor
// =====================================================================

export type SensorType = "mech" | "npn" | "pnp";
export type SensorVolt = 5 | 12 | 24;
const BRN = "#8b5a2b";

/**
 * Baut aus der normalen Verdrahtung (erster Draht = Signal, zweiter = GND) die Verdrahtung mit induktiven Sensoren:
 *   - direkt: Sensor an den Stecker – PiBot (SW-VCC), Ruida (eigenes Netzteil) oder 5-V-NPN an 5V/GND/S
 *   - Modul: Optokoppler-/Pegelmodul (12/24 V → Board) dazwischen; der Ausgang schaltet nach GND,
 *     ans Board kommen nur OUT und GND (der Pull-up des Boards liefert HIGH – nie 5 V auf einen ESP32-Pin)
 * Bei Endschaltern ersetzt der Sensor die Schalter, beim Taster den Werkzeuglängensensor (Tastplatte bleibt).
 */
export function sensorHookup(b: Board, base: Hookup, type: "npn" | "pnp", volt: SensorVolt): Hookup {
  const repl: PartKind = base.comp === "limits" ? "switch" : "wls";
  const src = base.parts.filter(p => p.kind === repl);
  if (!src.length) return base;
  const inp = b.inputs;
  const pb = inp === "pb496" || inp === "pb588";
  if (type === "pnp" && inp === "ruida") return { ...base, parts: [], unavailable: "wr.sen.u.rdpnp" };

  const conn = (ref: string) => b.conns.find(c => c.id === ref.split(".")[0]);
  const fiveFallback = b.conns.some(c => c.id === "v5") ? "v5.5V" : b.conns.some(c => c.id === "uart") ? "uart.5V" : "";
  const ch = src.map(p => {
    const sig = p.wires[0].to, gnd = p.wires[1].to, c = conn(sig);
    const sw = pb && !!c?.pins.some(x => x.k === "V") ? `${c!.id}.V` : "";
    const five = c?.pins.some(x => x.k === "5V") ? `${c!.id}.5V` : fiveFallback;
    return { n: p.name || "T", side: p.side, sig, gnd, sw, five };
  });
  const side = src[0].side;
  const swDirect = type === "npn" && pb && ch.every(c => c.sw);
  const fiveDirect = type === "npn" && volt === 5 && !swDirect && inp !== "ruida" && ch.every(c => c.five);
  const direct = type === "npn" && (inp === "ruida" || swDirect || fiveDirect);
  const prox = (c: typeof ch[number], wires: Wire[], outer = false): Part =>
    ({ id: "px" + c.n, kind: "prox", name: c.n === "T" ? "" : c.n, side: c.side, pins: ["BN", "BU", "BK"], wires, outer });

  const parts: Part[] = base.parts.filter(p => p.kind !== repl);
  if (direct && inp === "ruida") {
    parts.push(...ch.map(c => prox(c, [{ from: "BK", to: c.sig, color: BLACK }, { from: "BU", to: c.gnd, color: BLU }, { from: "BN", to: "@psu.+", color: BRN }])));
    parts.push({ id: "psu", kind: "psu", name: `${volt} V`, side, pins: ["+", "-"], wires: [{ from: "-", to: ch[0].gnd, color: BLACK }] });
  } else if (direct) {
    parts.push(...ch.map(c => prox(c, [{ from: "BK", to: c.sig, color: BLACK }, { from: "BU", to: c.gnd, color: BLU }, { from: "BN", to: swDirect ? c.sw : c.five, color: BRN }])));
  } else {
    parts.push({
      id: "mod", kind: "opto", name: type.toUpperCase(), side, pins: [...ch.map(c => "OUT " + c.n), "GND"], outerPins: [...ch.map(c => "IN " + c.n), "+V", "0V"],
      wires: [...ch.map(c => ({ from: "OUT " + c.n, to: c.sig, color: YEL })), { from: "GND", to: ch[0].gnd, color: BLACK }]
    });
    parts.push(...ch.map(c => prox(c, [{ from: "BK", to: `@mod.IN ${c.n}`, color: BLACK }, { from: "BN", to: "@psu.+", color: BRN }, { from: "BU", to: "@psu.-", color: BLU }], true)));
    parts.push({ id: "psu", kind: "psu", name: `${volt} V`, side, outer: true, pins: ["+", "-"],
      wires: [{ from: "+", to: "@mod.+V", color: RED }, { from: "-", to: "@mod.0V", color: BLACK }] });
  }

  const steps: Step[] = [{ k: "wr.sen.s.colors" }];
  if (direct && inp === "ruida") steps.push({ k: "wr.s.rd.lim.3" }, { k: "wr.sen.s.gnd" });
  else if (swDirect) steps.push({ k: "wr.sen.s.pb", p: { pos: volt === 5 ? "5 V" : "Vmot", jumper: inp === "pb588" ? "④" : "⑦" } });
  else if (fiveDirect) steps.push({ k: "wr.sen.s.d5", p: { vcc: `${conn(ch[0].five)?.label || ""} 5V`.trim() } });
  else steps.push({ k: "wr.sen.s.mod.1", p: { volt: String(volt) } }, { k: "wr.sen.s.mod.2" }, { k: "wr.sen.s.mod.3", p: { type: type.toUpperCase() } });
  steps.push({ k: "wr.sen.s.test" });
  if (base.steps.length) steps.push(base.steps[base.steps.length - 1]);

  const notes: Step[] = [];
  if (inp === "avr5") notes.push({ k: "wr.sen.n.avr" });
  if (inp === "esp33") notes.push({ k: "wr.sen.n.esp" });
  if (type === "pnp") notes.push({ k: "wr.sen.n.pnp" });
  if (direct && volt === 5) notes.push({ k: "wr.sen.n.v5" });
  if (swDirect && volt !== 5) notes.push({ k: "wr.sen.n.vmot", p: { volt: String(volt) } });
  notes.push(...base.notes.filter(s => s.k !== "wr.n.dlc.3pin"));

  const pro: Step[] = [...base.pro, { k: "wr.sen.p.nc" }, { k: "wr.sen.p.dist" }];
  if (!direct && type === "npn" && (inp === "avr5" || inp === "esp33")) pro.push({ k: "wr.sen.p.diode" });
  return { ...base, parts, steps, notes, pro };
}
