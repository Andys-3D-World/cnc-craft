/**
 * MASCHINEN-PROFILE für den Maschinen-Assistenten
 *
 * Jedes Profil stellt ein: Maschinenart (Fräse/Laser/Plasma), Arbeitsfläche, Z-Hub,
 * Baudrate, S-Max ($30), M4 dynamisch und den Nullpunkt.
 *
 * support:
 *   "ok"    – GRBL, läuft direkt
 *   "check" – GRBL bzw. GRBL-ähnlich, sollte laufen; Werte sind Herstellerangaben → bitte prüfen
 *   "later" – eigenes Protokoll, Unterstützung geplant (entwerfen + G-Code speichern geht)
 *
 * protocol: "grbl" (Standard) oder "ruida" (CO₂-Steuerung, Netzwerk/USB, siehe src-tauri/src/ruida.rs)
 *   "no"    – kann (noch) nicht angesteuert werden
 *
 * Maße sind Herstellerangaben. Wer Endschalter hat, holt die echten Werte
 * mit „Bett von Maschine übernehmen“ ($130/$131).
 */
import type { MachineMode } from "../machineMode";

export type Support = "ok" | "check" | "later" | "no";
export type Origin = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface MachineProfile {
  id: string;
  brand: string;          // Schlüssel in BRANDS
  model?: string;         // Modellname (wird nicht übersetzt)
  modelKey?: string;      // … oder Übersetzungs-Schlüssel
  kind: MachineMode;
  w: number; h: number;   // Arbeitsfläche in mm
  z?: number;             // Z-Hub in mm (nur Fräse)
  baud: number;
  sMax: number;           // $30
  dynamic: boolean;       // M4 (Laser)
  origin: Origin;
  support: Support;
  grbl: boolean;          // $$-Werte dürfen geschrieben werden
  protocol?: "grbl" | "marlin" | "ruida" | "k40";
  net?: string;           // Standard-Adresse fürs Netzwerk (z. B. xTool F1: 172.25.3.1:8780)
  action?: "flash-grbl";  // Knopf im Assistenten: GRBL aufspielen (z. B. Estlcam-Arduino)
  board?: string;         // K40: Board-Typ für die Geschwindigkeits-Codes (M2, M3, B2 …)
  notes?: string[];       // Übersetzungs-Schlüssel
  src?: string;           // Quelle der Maße
}

export interface Brand { id: string; name?: string; nameKey?: string; icon: string }

export const BRANDS: Brand[] = [
  { id: "custom", nameKey: "mw.brand.custom", icon: "🧩" },
  { id: "xtool", name: "xTool", icon: "🔦" },
  { id: "sculpfun", name: "Sculpfun", icon: "🔦" },
  { id: "atomstack", name: "Atomstack", icon: "🔦" },
  { id: "ortur", name: "Ortur", icon: "🔦" },
  { id: "creality", name: "Creality Falcon", icon: "🔦" },
  { id: "twotrees", name: "Two Trees", icon: "🔦" },
  { id: "co2", nameKey: "mw.brand.co2", icon: "🔥" },
  { id: "creality3d", nameKey: "mw.brand.creality3d", icon: "🖨️" },
  { id: "anycubic", nameKey: "mw.brand.anycubic", icon: "🖨️" },
  { id: "v1e", name: "V1 Engineering (MPCNC / LowRider)", icon: "🛠️" },
  { id: "genmitsu", name: "Genmitsu (SainSmart)", icon: "🛠️" },
  { id: "china", nameKey: "mw.brand.china", icon: "🛠️" },
  { id: "proxxon", nameKey: "mw.brand.proxxon", icon: "🛠️" },
  { id: "estlcam", nameKey: "mw.brand.estlcam", icon: "🔁" },
  // (Plasma: bisher nur „Eigene“ – fertige Tische mit offenem Protokoll kommen dazu, sobald es welche gibt)
];

const L = { baud: 115200, sMax: 1000, dynamic: true, origin: "bottom-left" as Origin };
// Ruida: Maschinen-Nullpunkt meist hinten rechts; M3 (Ruida regelt Ecken selbst über die Min-Leistung)
const R = { baud: 115200, sMax: 1000, dynamic: false, origin: "top-right" as Origin };
// Marlin: Laser-Leistung meist S 0–255 (LASER_FEATURE), konstante Leistung (M3)
const MA = { baud: 115200, sMax: 255, dynamic: false, origin: "bottom-left" as Origin };
// K40 Original-Board: Nullpunkt oben links, Leistung am Poti (S wird nicht benutzt)
const K = { baud: 115200, sMax: 1000, dynamic: false, origin: "top-left" as Origin };
const M = { baud: 115200, sMax: 1000, dynamic: false, origin: "bottom-left" as Origin };

const SRC_XTOOL_D1 = "https://www.atomm.com/blog/2535-what-is-xtool-d1";
const SRC_XTOOL_F1 = "https://forum.lightburnsoftware.com/t/xtool-f1-usb-connection-waiting-for-connection-port-8780-refused-detailed-diagnostics-included/189713";
const SRC_XTOOL_S1 = "https://uk.xtool.com/products/xtool-s1-laser-cutter";
const SRC_LASER_TEST = "https://www.generation-nt.com/actualites/graveur-laser-ortur-master-3-creality-falcon2-22w-sculpfun-s30-pro-max-2036686/amp";
const SRC_MF70 = "https://www.flume.de/en/craft-creative/tools-machines/proxxon/micro-milling-machine-mf-70-proxxon/335844";
const SRC_A10 = "https://atomstack.com/products/atomstack-a5-pro";

export const PROFILES: MachineProfile[] = [
  // ---------------- Eigene ----------------
  { id: "custom-laser", brand: "custom", modelKey: "mw.m.customLaser", kind: "laser", w: 400, h: 400, ...L, support: "ok", grbl: true, notes: ["mw.note.custom"] },
  { id: "custom-mill", brand: "custom", modelKey: "mw.m.customMill", kind: "mill", w: 300, h: 300, z: 50, ...M, support: "ok", grbl: true, notes: ["mw.note.custom"] },
  { id: "custom-plasma", brand: "custom", modelKey: "mw.m.customPlasma", kind: "plasma", w: 1250, h: 1250, z: 80, ...M, support: "ok", grbl: true, notes: ["mw.note.plasma", "mw.note.custom"] },
  { id: "mks-dlc32", brand: "custom", modelKey: "mw.m.dlc32", kind: "laser", w: 400, h: 400, ...L, support: "ok", grbl: true, notes: ["mw.note.dlc32", "mw.note.custom"] },

  // ---------------- xTool ----------------
  { id: "xtool-d1", brand: "xtool", model: "D1 (5 W / 10 W)", kind: "laser", w: 432, h: 406, ...L, support: "check", grbl: false, notes: ["mw.note.xtoolUsb"], src: SRC_XTOOL_D1 },
  { id: "xtool-d1pro", brand: "xtool", model: "D1 Pro (5 / 10 / 20 / 40 W)", kind: "laser", w: 430, h: 400, ...L, support: "check", grbl: false, notes: ["mw.note.xtoolUsb"], src: SRC_XTOOL_D1 },
  { id: "xtool-s1-40", brand: "xtool", model: "S1 40 W", kind: "laser", w: 498, h: 319, ...L, support: "check", grbl: false, notes: ["mw.note.xtoolS1", "mw.note.xtoolUsb"], src: SRC_XTOOL_S1 },
  { id: "xtool-s1", brand: "xtool", model: "S1 10 W / 20 W / 2 W IR", kind: "laser", w: 498, h: 330, ...L, support: "check", grbl: false, notes: ["mw.note.xtoolS1", "mw.note.xtoolUsb"], src: SRC_XTOOL_S1 },
  { id: "xtool-f1", brand: "xtool", model: "F1 / F1 Lite / F1 Ultra (USB-Netzwerk)", kind: "laser", w: 115, h: 115, ...L, support: "check", grbl: false, net: "172.25.3.1:8780", notes: ["mw.note.xtoolF1"], src: SRC_XTOOL_F1 },
  { id: "xtool-net", brand: "xtool", modelKey: "mw.m.xtoolNet", kind: "laser", w: 400, h: 400, ...L, support: "no", grbl: false, notes: ["mw.note.xtoolNet"] },

  // ---------------- Sculpfun ----------------
  { id: "sculpfun-s9", brand: "sculpfun", model: "S9", kind: "laser", w: 410, h: 420, ...L, support: "check", grbl: true },
  { id: "sculpfun-s10", brand: "sculpfun", model: "S10", kind: "laser", w: 410, h: 400, ...L, support: "check", grbl: true },
  { id: "sculpfun-s30", brand: "sculpfun", model: "S30 / S30 Pro / S30 Pro Max", kind: "laser", w: 410, h: 400, ...L, support: "check", grbl: true, src: SRC_LASER_TEST },

  // ---------------- Atomstack ----------------
  { id: "atomstack-a5pro", brand: "atomstack", model: "A5 Pro / X7 Pro", kind: "laser", w: 410, h: 400, ...L, support: "check", grbl: true },
  { id: "atomstack-a10pro-v2", brand: "atomstack", model: "A10 Pro V2", kind: "laser", w: 400, h: 365, ...L, support: "check", grbl: true, src: SRC_A10 },
  { id: "atomstack-x20pro", brand: "atomstack", model: "A20 Pro / X20 Pro / S20 Pro", kind: "laser", w: 400, h: 400, ...L, support: "check", grbl: true },

  // ---------------- Ortur ----------------
  { id: "ortur-lm2pro", brand: "ortur", model: "Laser Master 2 / 2 Pro (S2)", kind: "laser", w: 400, h: 430, ...L, support: "check", grbl: true },
  { id: "ortur-lm3", brand: "ortur", model: "Laser Master 3", kind: "laser", w: 400, h: 400, ...L, support: "check", grbl: true, src: SRC_LASER_TEST },

  // ---------------- Creality ----------------
  { id: "falcon", brand: "creality", model: "Falcon 5 W / 10 W", kind: "laser", w: 400, h: 415, ...L, support: "check", grbl: true },
  { id: "falcon2", brand: "creality", model: "Falcon2 12 / 22 / 40 W", kind: "laser", w: 400, h: 415, ...L, support: "check", grbl: true, src: SRC_LASER_TEST },

  // ---------------- Two Trees ----------------
  { id: "tts55", brand: "twotrees", model: "TTS-55 / TTS-10", kind: "laser", w: 300, h: 300, ...L, support: "check", grbl: true },

  // ---------------- CO₂ ----------------
  { id: "k40-grbl", brand: "co2", modelKey: "mw.m.k40grbl", kind: "laser", w: 300, h: 200, ...L, support: "ok", grbl: true, notes: ["mw.note.k40grbl"] },
  { id: "co2-ruida", brand: "co2", modelKey: "mw.m.ruida", kind: "laser", w: 600, h: 400, ...R, support: "check", grbl: false, protocol: "ruida", notes: ["mw.note.ruida"] },
  { id: "co2-ruida-6040", brand: "co2", model: "6040 · Ruida", kind: "laser", w: 600, h: 400, ...R, support: "check", grbl: false, protocol: "ruida", notes: ["mw.note.ruida"] },
  { id: "co2-ruida-9060", brand: "co2", model: "9060 · Ruida", kind: "laser", w: 900, h: 600, ...R, support: "check", grbl: false, protocol: "ruida", notes: ["mw.note.ruida"] },
  { id: "co2-ruida-1390", brand: "co2", model: "1390 · Ruida", kind: "laser", w: 1300, h: 900, ...R, support: "check", grbl: false, protocol: "ruida", notes: ["mw.note.ruida"] },
  { id: "k40-m2nano", brand: "co2", modelKey: "mw.m.k40", kind: "laser", w: 300, h: 200, ...K, support: "check", grbl: false, protocol: "k40", board: "M2", notes: ["mw.note.k40", "mw.note.k40driver"] },
  { id: "co2-trocen", brand: "co2", modelKey: "mw.m.trocen", kind: "laser", w: 600, h: 400, ...L, support: "no", grbl: false, notes: ["mw.note.trocen"] },

  // ---------------- 3D-Drucker mit Marlin (Laser-Modul) ----------------
  { id: "ender3", brand: "creality3d", model: "Ender-3 / Ender-3 Pro / V2", kind: "laser", w: 220, h: 220, ...MA, support: "check", grbl: false, protocol: "marlin", notes: ["mw.note.marlinLaser", "mw.note.marlin"] },
  { id: "ender3s1", brand: "creality3d", model: "Ender-3 S1 / S1 Pro", kind: "laser", w: 220, h: 220, ...MA, support: "check", grbl: false, protocol: "marlin", notes: ["mw.note.marlinLaser", "mw.note.marlin"] },
  { id: "ender5", brand: "creality3d", model: "Ender-5 / Ender-5 Pro", kind: "laser", w: 220, h: 220, ...MA, support: "check", grbl: false, protocol: "marlin", notes: ["mw.note.marlinLaser", "mw.note.marlin"] },
  { id: "cr10", brand: "creality3d", model: "CR-10 / CR-10 V2", kind: "laser", w: 300, h: 300, ...MA, support: "check", grbl: false, protocol: "marlin", notes: ["mw.note.marlinLaser", "mw.note.marlin"] },
  { id: "i3mega", brand: "anycubic", model: "i3 Mega / Mega S", kind: "laser", w: 210, h: 210, ...MA, baud: 250000, support: "check", grbl: false, protocol: "marlin", notes: ["mw.note.marlinLaser", "mw.note.marlinBaud", "mw.note.marlin"] },
  { id: "kobra", brand: "anycubic", model: "Kobra / Kobra Neo", kind: "laser", w: 220, h: 220, ...MA, support: "check", grbl: false, protocol: "marlin", notes: ["mw.note.marlinLaser", "mw.note.marlin"] },
  { id: "mpcnc", brand: "v1e", model: "MPCNC (Marlin)", kind: "mill", w: 600, h: 600, z: 80, ...MA, sMax: 255, baud: 250000, support: "check", grbl: false, protocol: "marlin", notes: ["mw.note.v1e", "mw.note.marlin"] },
  { id: "lowrider", brand: "v1e", model: "LowRider (Marlin)", kind: "mill", w: 1220, h: 2440, z: 80, ...MA, sMax: 255, baud: 250000, support: "check", grbl: false, protocol: "marlin", notes: ["mw.note.v1e", "mw.note.marlin"] },
  { id: "custom-marlin", brand: "custom", modelKey: "mw.m.customMarlin", kind: "laser", w: 220, h: 220, ...MA, support: "ok", grbl: false, protocol: "marlin", notes: ["mw.note.marlin", "mw.note.custom"] },

  // ---------------- Estlcam-Steuerungen (Arduino) -> GRBL ----------------
  { id: "estlcam-uno", brand: "estlcam", modelKey: "mw.m.estlcamUno", kind: "mill", w: 300, h: 300, z: 60, ...M, support: "ok", grbl: true, action: "flash-grbl", notes: ["mw.note.estlcam", "mw.note.estlcamPins"] },
  { id: "estlcam-nano", brand: "estlcam", modelKey: "mw.m.estlcamNano", kind: "mill", w: 300, h: 300, z: 60, ...M, support: "ok", grbl: true, action: "flash-grbl", notes: ["mw.note.estlcam", "mw.note.estlcamPins"] },
  { id: "estlcam-uno-laser", brand: "estlcam", modelKey: "mw.m.estlcamUno", kind: "laser", w: 300, h: 300, ...L, support: "ok", grbl: true, action: "flash-grbl", notes: ["mw.note.estlcam", "mw.note.estlcamPins"] },

  // ---------------- Genmitsu ----------------
  { id: "genmitsu-3018pro", brand: "genmitsu", model: "3018-PRO", kind: "mill", w: 300, h: 180, z: 45, ...M, support: "ok", grbl: true, notes: ["mw.note.3018"] },
  { id: "genmitsu-3018prover", brand: "genmitsu", model: "3018-PROVer", kind: "mill", w: 300, h: 180, z: 45, ...M, support: "check", grbl: true, notes: ["mw.note.3018"] },

  // ---------------- China-Fräsen ----------------
  { id: "cnc3018", brand: "china", model: "CNC 3018", kind: "mill", w: 300, h: 180, z: 45, ...M, support: "check", grbl: true, notes: ["mw.note.3018"] },
  { id: "cnc2418", brand: "china", model: "CNC 2418", kind: "mill", w: 240, h: 180, z: 45, ...M, support: "check", grbl: true, notes: ["mw.note.3018"] },
  { id: "cnc1610", brand: "china", model: "CNC 1610", kind: "mill", w: 160, h: 100, z: 40, ...M, support: "check", grbl: true, notes: ["mw.note.3018"] },

  // ---------------- Proxxon ----------------
  { id: "proxxon-mf70", brand: "proxxon", modelKey: "mw.m.mf70", kind: "mill", w: 134, h: 46, z: 80, ...M, support: "ok", grbl: true, notes: ["mw.note.proxxon"], src: SRC_MF70 },
  { id: "proxxon-ff500", brand: "proxxon", modelKey: "mw.m.ff500", kind: "mill", w: 290, h: 100, z: 220, ...M, support: "check", grbl: true, notes: ["mw.note.proxxon"] },

];

export function profileById(id: string | null | undefined): MachineProfile | null {
  return PROFILES.find(p => p.id === id) || null;
}

export function profilesOf(brand: string): MachineProfile[] {
  return PROFILES.filter(p => p.brand === brand);
}
