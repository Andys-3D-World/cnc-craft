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
 *
 * Koordinaten: Board-Fläche w × h je Board (Zeichnung in ui/wiringPage.ts).
 *
 * NEUES BOARD HINZUFÜGEN
 *   1. Ein Objekt `const meinBoard: Board = { … }` anlegen (Vorlage: dlcMax unten):
 *        id, name, maker (Hersteller = Gruppe in der Auswahlliste), mcu, volt, w/h,
 *        conns  = Stecker mit Pins (Beschriftung wie auf der Platine, mcu = Controller-Pin, fn = Funktion),
 *        deco   = Treiber-Steckplätze, Chip, USB … (nur Optik)
 *        fw / source = i18n-Schlüssel für Firmware und Herkunft der Zeichnung
 *   2. In hookupsFor() steht, welches Bauteil an welchen Stecker kommt. Neue Boards brauchen dort
 *      einen eigenen Zweig (wie isShield / isMax) – Stecker-IDs wie "lx", "probe", "ttl", "spin", "pwr"
 *      wiederzuverwenden spart Arbeit.
 *   3. Unten in BOARDS eintragen (und ggf. shiftRight aufrufen). Die Auswahlliste sortiert sich selbst.
 * Stecker: x/y = erster Pin, dir = Reihe (h) oder Spalte (v), Pins im Abstand von 13.
 */

export type CompId = "psu" | "motors" | "limits" | "probe" | "laser" | "spindle" | "plasma" | "air" | "estop" | "door";
export const COMPS: CompId[] = ["psu", "motors", "limits", "probe", "laser", "spindle", "plasma", "air", "estop", "door"];

export interface BPin { k: string; label: string; mcu?: string; fn?: string }
export interface BConn { id: string; label: string; x: number; y: number; dir: "h" | "v"; pins: BPin[]; labelPos?: "above" | "below" | "left" | "right" }

/** Bauteil, das gezeichnet und verdrahtet wird */
export type PartKind = "psu" | "motor" | "switch" | "probe" | "wls" | "laser" | "relay" | "vfd" | "plasma" | "thc" | "pump" | "estop" | "door" | "extdrv";
export interface Wire { from: string; to: string; color: string }   // to = "conn.pin" oder "@teil.pin"
/** outer: Pins auf der vom Board abgewandten Seite (für Verbindungen zu anderen Bauteilen, z. B. Relais-Kontakt) */
export interface Part { id: string; kind: PartKind; name: string; side: "left" | "right" | "top" | "bottom"; pins: string[]; wires: Wire[]; outer?: boolean }

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
  deco: { x: number; y: number; w: number; h: number; label: string; kind: "driver" | "chip" | "usb" | "sd" | "hole" }[];
  hookups: Partial<Record<CompId, Hookup>>;
}

// Kabelfarben
const RED = "#e5484d", BLACK = "#2b2b2b", YEL = "#f5c518", GRN = "#30a46c", BLU = "#3e7bfa", WHT = "#d9d9d9", ORG = "#f08c00", VIO = "#9b5de5";

const mot = (id: string, label: string, x: number, mcu = ""): BConn => ({
  id, label, x, y: 16, dir: "h", labelPos: "below",
  pins: [{ k: "2B", label: "2B", fn: mcu }, { k: "2A", label: "2A", fn: mcu }, { k: "1A", label: "1A", fn: mcu }, { k: "1B", label: "1B", fn: mcu }]
});
/** 2-polig Signal + GND (CNC Shield) */
const sg = (id: string, label: string, x: number, y: number, mcu: string, fn: string, dir: "h" | "v" = "v", labelPos: BConn["labelPos"] = "left"): BConn => ({
  id, label, x, y, dir, labelPos, pins: [{ k: "S", label: "S", mcu, fn }, { k: "G", label: "GND" }]
});
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
// =====================================================================
const shield: Board = {
  id: "cnc-shield-v3",
  maker: "Arduino",
  name: "Arduino UNO + CNC Shield V3",
  mcu: "ATmega328P",
  fw: "wr.fw.shield",
  source: "wr.src.shield",
  volt: "12–36 V",
  w: 560, h: 400,
  conns: [
    { id: "pwr", label: "12-36V", x: 16, y: 50, dir: "v", labelPos: "right", pins: [{ k: "+", label: "+" }, { k: "-", label: "−" }] },
    mot("mx", "X", 90), mot("my", "Y", 190), mot("mz", "Z", 290), mot("ma", "A", 390),
    sg("lx", "X−/X+", 544, 110, "D9", "X-Limit"),
    sg("ly", "Y−/Y+", 544, 150, "D10", "Y-Limit"),
    sg("lz", "Z−/Z+", 544, 190, "D11", "Spindel/Laser PWM (GRBL 1.1)"),
    sg("spe", "SpnEn", 544, 230, "D12", "Z-Limit (GRBL 1.1)"),
    sg("spd", "SpnDir", 544, 270, "D13", "Spindel-Richtung"),
    sg("abort", "Abort", 90, 372, "A0", "Reset/Abbruch", "h", "below"),
    sg("hold", "Hold", 150, 372, "A1", "Feed Hold", "h", "below"),
    sg("resume", "Resume", 210, 372, "A2", "Cycle Start", "h", "below"),
    sg("cool", "CoolEn", 270, 372, "A3", "Kühlung M8", "h", "below"),
    sg("sda", "SDA", 330, 372, "A4", "Nebel M7 (Option)", "h", "below"),
    sg("scl", "SCL", 390, 372, "A5", "Taster (Probe)", "h", "below"),
    { id: "v5", label: "5V/GND", x: 460, y: 372, dir: "h", labelPos: "below", pins: [{ k: "5V", label: "5V" }, { k: "G", label: "GND" }] },
    { id: "estop", label: "E-STOP", x: 16, y: 300, dir: "v", labelPos: "right", pins: [{ k: "1", label: "RST", mcu: "RESET", fn: "Arduino-Reset" }, { k: "2", label: "GND" }] }
  ],
  deco: [
    { x: 76, y: 52, w: 68, h: 96, label: "X", kind: "driver" }, { x: 176, y: 52, w: 68, h: 96, label: "Y", kind: "driver" },
    { x: 276, y: 52, w: 68, h: 96, label: "Z", kind: "driver" }, { x: 376, y: 52, w: 68, h: 96, label: "A", kind: "driver" },
    { x: 150, y: 196, w: 240, h: 110, label: "Arduino UNO", kind: "chip" }
  ],
  hookups: {}
};

// =====================================================================
// MKS DLC32 V2.1 (ESP32, MKS-Firmware / Grbl_ESP32)
// =====================================================================
const esd = (axis: string, x: number, mcu = ""): BConn => ({
  id: "esd_" + axis.toLowerCase(), label: axis + ": E S D G", x, y: 186, dir: "h", labelPos: "below",
  pins: [{ k: "E", label: "E", mcu, fn: "Enable" }, { k: "S", label: "S", fn: "Step" }, { k: "D", label: "D", fn: "Dir" }, { k: "G", label: "G" }]
});
const dlc21: Board = {
  id: "mks-dlc32-v21",
  maker: "Makerbase (MKS)",
  name: "MKS DLC32 V2.1",
  mcu: "ESP32",
  fw: "wr.fw.dlc32",
  source: "wr.src.dlc21",
  volt: "12–24 V",
  w: 640, h: 420,
  conns: [
    mot("mx", "X-Motor", 50), mot("my1", "Y1-Motor", 130), mot("my2", "Y2-Motor", 210), mot("mz", "Z-Motor", 290),
    { id: "out", label: "+12/24V−", x: 380, y: 16, dir: "h", labelPos: "below", pins: [{ k: "+", label: "+" }, { k: "-", label: "−" }] },
    { id: "ttl", label: "Laser (S-TTL-V)", x: 466, y: 16, dir: "h", labelPos: "below", pins: [{ k: "S", label: "S", mcu: "IO32", fn: "Laser PWM" }, { k: "G", label: "G" }, { k: "V", label: "V", fn: "12/24V" }] },
    { id: "i2c", label: "I2C", x: 390, y: 90, dir: "v", labelPos: "above", pins: [{ k: "3V3", label: "3V3" }, { k: "G", label: "GND" }, { k: "SDA", label: "SDA", mcu: "IO0" }, { k: "SCL", label: "SCL", mcu: "IO4", fn: "Kühlung M8" }] },
    vgs("probe", "Probe", 456, 90, "IO22", "Taster"),
    vgs("lz", "Z", 514, 90, "IO34", "Z-Limit"),
    vgs("ly", "Y", 572, 90, "IO35", "Y-Limit"),
    vgs("lx", "X", 628, 90, "IO36", "X-Limit"),
    { id: "vout", label: "-12/24V+", x: 16, y: 80, dir: "v", labelPos: "right", pins: [{ k: "-", label: "GND" }, { k: "+", label: "12/24V" }] },
    { id: "beep", label: "-BEEPER+", x: 16, y: 140, dir: "v", labelPos: "right", pins: [{ k: "-", label: "S" }, { k: "+", label: "12/24V" }] },
    { id: "spin", label: "-SPINDLE+", x: 16, y: 230, dir: "v", labelPos: "right", pins: [{ k: "-", label: "−", mcu: "IO32", fn: "Spindel (MOSFET)" }, { k: "+", label: "+12/24V" }] },
    { id: "sw", label: "SWITCH", x: 16, y: 300, dir: "v", labelPos: "right", pins: [{ k: "1", label: "1" }, { k: "2", label: "2" }] },
    { id: "pwr", label: "POWER 12-24V", x: 90, y: 404, dir: "h", labelPos: "above", pins: [{ k: "+", label: "+" }, { k: "-", label: "−" }] },
    { id: "rst", label: "RESET", x: 540, y: 404, dir: "h", labelPos: "above", pins: [{ k: "G", label: "G" }, { k: "S", label: "S", mcu: "EN", fn: "Reset" }] },
    esd("X", 46), esd("Y", 126), esd("Z", 206)
  ],
  deco: [
    { x: 40, y: 56, w: 64, h: 100, label: "X", kind: "driver" }, { x: 120, y: 56, w: 64, h: 100, label: "Y", kind: "driver" },
    { x: 200, y: 56, w: 64, h: 100, label: "Z", kind: "driver" },
    { x: 400, y: 240, w: 150, h: 90, label: "ESP32", kind: "chip" },
    { x: 190, y: 300, w: 70, h: 56, label: "USB", kind: "usb" }, { x: 280, y: 300, w: 70, h: 56, label: "SD", kind: "sd" }
  ],
  hookups: {}
};

// =====================================================================
// MKS DLC32 MAX V1.0 (ESP32-S3)
// =====================================================================
const dlcMax: Board = {
  id: "mks-dlc32-max",
  maker: "Makerbase (MKS)",
  name: "MKS DLC32 MAX V1.0",
  mcu: "ESP32-S3",
  fw: "wr.fw.dlcmax",
  source: "wr.src.dlcmax",
  volt: "12–24 V",
  w: 640, h: 440,
  conns: [
    mot("mx", "X-Motor", 50, "STEP IO16 · DIR IO15"), mot("my1", "Y1-Motor", 130, "STEP IO7 · DIR IO6"), mot("my2", "Y2-Motor", 210, "STEP IO7 · DIR IO6"),
    mot("mz", "Z-Motor", 290, "STEP IO5 · DIR IO4"), mot("ma", "A-Motor", 370, "STEP IO20 · DIR IO19"),
    { id: "air", label: "+AIR−", x: 460, y: 16, dir: "h", labelPos: "below", pins: [{ k: "+", label: "+" }, { k: "-", label: "−", mcu: "IO1", fn: "Air (MOSFET)" }] },
    { id: "beep", label: "+BEEPER−", x: 530, y: 16, dir: "h", labelPos: "below", pins: [{ k: "+", label: "+" }, { k: "-", label: "−", mcu: "IO42" }] },
    vgs("lz", "Z−", 494, 84, "IO41", "Z-Limit"), vgs("ly", "Y−", 554, 84, "IO40", "Y-Limit"), vgs("lx", "X−", 614, 84, "IO39", "X-Limit"),
    vgs("door", "Door", 434, 196, "IO38", "Tür"), vgs("flame", "Flame", 494, 196, "IO36", "Flammen-Sensor"),
    vgs("probe", "Probe", 554, 196, "IO37", "Taster"), vgs("la", "A−", 614, 196, "IO48", "A-Limit"),
    { id: "vout", label: "-VIN+", x: 16, y: 74, dir: "v", labelPos: "right", pins: [{ k: "-", label: "GND" }, { k: "+", label: "12-24V" }] },
    { id: "ttl", label: "Laser", x: 16, y: 140, dir: "v", labelPos: "right", pins: [{ k: "S", label: "TTL", mcu: "IO2", fn: "Laser PWM" }, { k: "G", label: "GND" }, { k: "V", label: "VIN" }] },
    { id: "ttl2", label: "Laser 2", x: 16, y: 210, dir: "v", labelPos: "right", pins: [{ k: "S", label: "TTL", mcu: "IO2", fn: "Laser PWM" }, { k: "G", label: "GND" }, { k: "V", label: "VIN" }] },
    { id: "spin", label: "-SPINDLE+", x: 16, y: 284, dir: "v", labelPos: "right", pins: [{ k: "-", label: "−", mcu: "IO35", fn: "Spindel (MOSFET)" }, { k: "+", label: "+" }] },
    { id: "sw", label: "SWITCH", x: 16, y: 344, dir: "v", labelPos: "right", pins: [{ k: "1", label: "1" }, { k: "2", label: "2" }] },
    { id: "pwr", label: "POWER DC12V/24V", x: 110, y: 424, dir: "h", labelPos: "above", pins: [{ k: "+", label: "+" }, { k: "-", label: "−" }] },
    { id: "rst", label: "RESET", x: 560, y: 424, dir: "h", labelPos: "above", pins: [{ k: "G", label: "GND" }, { k: "S", label: "RESET", fn: "Reset" }] },
    esd("X", 46, "IO8"), esd("Y", 126, "IO8"), esd("Z", 206, "IO8"), esd("A", 286, "IO8")
  ],
  deco: [
    { x: 40, y: 56, w: 64, h: 100, label: "X", kind: "driver" }, { x: 120, y: 56, w: 64, h: 100, label: "Y", kind: "driver" },
    { x: 200, y: 56, w: 64, h: 100, label: "Z", kind: "driver" }, { x: 280, y: 56, w: 64, h: 100, label: "A", kind: "driver" },
    { x: 430, y: 290, w: 150, h: 90, label: "ESP32-S3", kind: "chip" },
    { x: 200, y: 320, w: 70, h: 56, label: "USB", kind: "usb" }, { x: 290, y: 320, w: 70, h: 56, label: "SD", kind: "sd" }
  ],
  hookups: {}
};

// =====================================================================
// Verdrahtung je Board
// =====================================================================

function hookupsFor(b: Board): Partial<Record<CompId, Hookup>> {
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
    ? [motorPart("X", "mx"), motorPart("Y", "my"), motorPart("Z", "mz"), motorPart("A", "ma")]
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
      { id: "probe", kind: "probe", name: "", side: isShield ? "bottom" : "right", pins: ["S", "G"],
        wires: [{ from: "S", to: `${pc}.S`, color: YEL }, { from: "G", to: `${pc}.G`, color: BLACK }] },
      { id: "wls", kind: "wls", name: "", side: isShield ? "bottom" : "right", pins: ["S", "G"],
        wires: [{ from: "S", to: `${pc}.S`, color: ORG }, { from: "G", to: `${pc}.G`, color: BLACK }] }
    ],
    steps: [{ k: "wr.s.probe.1", p: { sig: P(pc, "S"), gnd: P(pc, "GND") } }, { k: "wr.s.probe.2" }, { k: "wr.s.probe.3" }],
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
       { id: "vfd", kind: "vfd", name: "", side: "right", pins: ["PWM", "GND"],
        wires: [{ from: "PWM", to: "lz.S", color: VIO }, { from: "GND", to: "lz.G", color: BLACK }] }]
    : [{ id: "relay", kind: "relay", name: "", side: "left", pins: ["+", "-"],
        wires: [{ from: "+", to: "spin.+", color: RED }, { from: "-", to: "spin.-", color: BLACK }] }];
  h.spindle = {
    comp: "spindle",
    parts: spParts,
    steps: isShield
      ? [{ k: "wr.s.sp.1", p: { sig: P("lz", "S (D11)"), gnd: "GND", vcc: "5V" } }, { k: "wr.s.sp.2" }, { k: "wr.s.sp.3", p: { sig: P("lz", "S (D11)"), gnd: "GND" } }, { k: "wr.s.sp.4" }]
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

/** Board-Inhalt rechts neben der linken Stecker-Spalte nach rechts schieben (Platz für deren Beschriftung) */
function shiftRight(b: Board, dx: number) {
  for (const c of b.conns) if (c.x > 30) c.x += dx;
  for (const d of b.deco) d.x += dx;
  b.w += dx;
}
shiftRight(shield, 50);
shiftRight(dlc21, 100);
shiftRight(dlcMax, 80);

export const BOARDS: Board[] = [shield, dlc21, dlcMax];
for (const b of BOARDS) b.hookups = hookupsFor(b);

export function getBoard(id: string): Board {
  return BOARDS.find(b => b.id === id) || BOARDS[0];
}
