/**
 * MASCHINE – Verbindung zur Steuerung (GRBL, grblHAL, Grbl_ESP32, FluidNC, MKS DLC32 …)
 *
 * Die eigentliche Arbeit macht der Rust-Teil (src-tauri/src/machine.rs): Port lesen,
 * Status abfragen, Jobs mit Puffer-Zählung senden. Hier kommen nur dessen Ereignisse an:
 *   machine-welcome, machine-status, machine-line, machine-alarm, machine-disconnected,
 *   machine-job-progress, machine-job-error, machine-job-toolchange, machine-job-done
 * Sie werden in `machine` gespeichert und als Fenster-Ereignis "cnc-machine" weitergegeben
 * ({ type, data }), damit Anzeige, Job-Steuerung und $$-Seite darauf reagieren können.
 *
 * Marlin-Maschinen (src-tauri/src/marlin.rs – Creality, Anycubic, MPCNC …) und
 * CO₂-Laser mit Ruida-Steuerung (src-tauri/src/ruida.rs) melden dieselben Ereignisse.
 * Dann ist machine.protocol = "ruida": kein $$, kein $I, Aufträge werden als RD-Datei geschickt.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n/i18n";
import { getMachineMode, setMachineMode, MachineMode } from "./machineMode";
import { parseHalLine } from "./grblhalInfo";

export interface MachineStatus {
  state: string;          // Idle, Run, Hold, Jog, Alarm, Door, Check, Home, Sleep
  sub: number | null;
  mpos: number[];
  wpos: number[];
  feed: number;
  spindle: number;
  ov: number[];
  pins: string;
  /** Zubehör aus "A:" – S/C = Spindel rechts/links an, F = Kühlung M8, M = M7; null = unbekannt */
  acc: string | null;
}

export interface PortInfo { name: string; vid: number | null; pid: number | null; chip: string; product: string; manufacturer: string }

/** Was das Board über sich verrät ($I und bei ESP32-Boards [ESP800]) */
export interface BoardInfo {
  name: string;      // z. B. "MKS DLC32 MAX"
  version: string;   // z. B. "1.0.10" (MKS) oder "1.1h" (GRBL)
  date: string;      // Build-Datum, z. B. "20250113"
  options: string;   // GRBL-Optionen aus [OPT:…], z. B. "VNMZL"
  rx: number;        // Empfangspuffer in Zeichen
  fw: string;        // ESP-Firmware-Text aus [ESP800]
  host: string;      // Name im Netzwerk (Hostname), z. B. "laser-garage" – aus [ESP800] / $System/Hostname
  raw: string[];     // alle Info-Zeilen
}
const INFO_KEY = "cnc_craft_board_info";

export type Protocol = "grbl" | "marlin" | "ruida" | "k40";

/** Werte, die die Ruida-Steuerung zum Umrechnen braucht (kommen aus der gewählten Maschine) */
export interface RuidaOptions { bedW: number; bedH: number; origin: string; sMax: number; magic: number; minPower: number; board?: string }
let ruidaOptions: () => RuidaOptions = () => ({ bedW: 600, bedH: 400, origin: "top-right", sMax: 1000, magic: 0x88, minPower: 0 });
export function setRuidaOptionsProvider(fn: () => RuidaOptions) { ruidaOptions = fn; }

export const machine = {
  protocol: "grbl" as Protocol,
  ruidaBed: null as null | { w: number; h: number },
  connected: false,
  port: "",
  firmware: "",
  version: "",
  status: { state: "", sub: null, mpos: [0, 0, 0], wpos: [0, 0, 0], feed: 0, spindle: 0, ov: [100, 100, 100], pins: "", acc: null } as MachineStatus,
  job: { active: false, sent: 0, acked: 0, total: 0, paused: false, toolChange: false, stopping: false },
  settings: new Map<string, string>(),  // "$110" -> "5000.000"
  lastAlarm: 0,
  info: { name: "", version: "", date: "", options: "", rx: 0, fw: "", host: "", raw: [] } as BoardInfo
};

let infoRequested = false;
let espInfoRequested = false;

function resetInfo() {
  machine.info = { name: "", version: "", date: "", options: "", rx: 0, fw: "", host: "", raw: [] };
  infoRequested = false;
  espInfoRequested = false;
}

/** Board-Infos anfragen ($I) – einmal pro Verbindung */
function requestInfo() {
  if (infoRequested || !machine.connected || machine.protocol !== "grbl") return;
  infoRequested = true;
  send("$I", true).catch(() => { infoRequested = false; });
}

/** "20250113" -> lokales Datum */
export function fmtBuildDate(d: string): string {
  const m = d.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return d;
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString();
}

/** Zuletzt gesehene Board-Infos (auch ohne Verbindung, z. B. für "Board flashen") */
export function lastBoardInfo(): (BoardInfo & { firmware: string; port: string; seen: string }) | null {
  try { const r = localStorage.getItem(INFO_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}

/** Info-Zeilen des Boards auswerten. true = etwas Neues erkannt */
function parseInfoLine(text: string): boolean {
  const info = machine.info;
  let hit = false;
  const ver = text.match(/^\[VER:(.*)\]$/);
  if (ver) {
    const parts = ver[1].split(":");
    const first = parts[0].trim();
    const rest = parts.slice(1).join(":").trim();
    if (first.includes(",")) {
      // MKS: "1.0.10,20250113"
      const [v, d] = first.split(",");
      info.version = v.trim(); info.date = (d || "").trim();
    } else {
      // GRBL: "1.1h.20190825"
      const m = first.match(/^(.*)\.(\d{8})$/);
      if (m) { info.version = m[1]; info.date = m[2]; } else info.version = first;
    }
    if (rest) info.name = rest;
    hit = true;
  }
  const opt = text.match(/^\[OPT:(.*)\]$/);
  if (opt) {
    const p = opt[1].split(",");
    info.options = p[0] || "";
    if (p[2]) info.rx = parseInt(p[2], 10) || 0;
    hit = true;
  }
  const mks = text.match(/MKS[ _]DLC32[ A-Za-z0-9_]*/);
  if (mks && !info.name) { info.name = mks[0].replace(/_/g, " ").trim(); hit = true; }
  const fw = text.match(/FW version:\s*([^,#\]]+)/i);
  if (fw) { info.fw = fw[1].trim(); hit = true; }
  const host = text.match(/hostname:\s*([A-Za-z0-9_.-]+)/i) || text.match(/^\$(?:System\/Hostname|ESP112|Hostname|300|320)=([A-Za-z0-9_.-]+)\s*$/);
  if (host) { info.host = host[1]; hit = true; }
  if (hit || /^\[(VER|OPT|ESP|MSG:.*(MKS|Version))/i.test(text) || /FW (version|target|HW)/i.test(text)) {
    if (!info.raw.includes(text) && info.raw.length < 40) info.raw.push(text);
  }
  if (hit) {
    try {
      localStorage.setItem(INFO_KEY, JSON.stringify({ ...info, firmware: `${machine.firmware} ${machine.version}`.trim(), port: machine.port, seen: new Date().toISOString() }));
    } catch { /* egal */ }
    // ESP32-Boards (MKS, Grbl_ESP32, FluidNC) kennen zusätzlich [ESP800] mit Firmware-Details
    // (nicht grblHAL: auch mit grblHAL heißt eine MKS-Platine noch „MKS DLC32 …“ – [ESP800] gäbe dort Fehler 1)
    const esp = machine.firmware !== "grblHAL" && (/MKS/i.test(info.name) || machine.firmware === "Grbl_ESP32" || machine.firmware === "FluidNC");
    if (esp && !espInfoRequested && machine.connected) {
      espInfoRequested = true;
      setTimeout(() => send("[ESP800]", true).catch(() => {}), 100);
    }
    fire("info", info);
  }
  return hit;
}

export const MACHINE_EVENT = "cnc-machine";

/** Echtzeit-Befehle (ein Byte) */
export const RT = {
  status: 0x3f, hold: 0x21, resume: 0x7e, reset: 0x18, jogCancel: 0x85,
  feed100: 0x90, feedPlus10: 0x91, feedMinus10: 0x92,
  rapid100: 0x95, rapid50: 0x96, rapid25: 0x97,
  feedPlus1: 0x93, feedMinus1: 0x94,
  spindle100: 0x99, spindlePlus10: 0x9a, spindleMinus10: 0x9b, spindlePlus1: 0x9c, spindleMinus1: 0x9d,
  spindleStop: 0x9e
};

/** Override-Grenzen von GRBL (unter 10 % geht nicht – "aus" ist M5 bzw. Spindel-Stopp) */
export const OV_MIN = 10, OV_MAX = 200;

/**
 * Echtzeit-Bytes, um einen Override von `cur` auf `target` % zu bringen.
 * GRBL kennt nur "100 %", ±10 % und ±1 % und schneidet bei 10 / 200 % ab.
 * Gesucht wird die kürzeste Folge (Breitensuche über die 191 möglichen Werte,
 * mit genau diesem Verhalten – auch das Abschneiden an den Grenzen wird genutzt).
 */
export function overrideBytes(kind: "feed" | "spindle", cur: number, target: number): number[] {
  const c = kind === "feed"
    ? [RT.feed100, RT.feedPlus10, RT.feedMinus10, RT.feedPlus1, RT.feedMinus1]
    : [RT.spindle100, RT.spindlePlus10, RT.spindleMinus10, RT.spindlePlus1, RT.spindleMinus1];
  const clamp = (v: number) => Math.max(OV_MIN, Math.min(OV_MAX, Math.round(v)));
  const from = clamp(cur), tgt = clamp(target);
  if (from === tgt) return [];
  const step = [(_: number) => 100, (v: number) => clamp(v + 10), (v: number) => clamp(v - 10), (v: number) => clamp(v + 1), (v: number) => clamp(v - 1)];
  const prev = new Map<number, [number, number]>(); // Wert -> [Vorgänger, Byte-Index]
  prev.set(from, [from, -1]);
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    const v = q[i];
    for (let k = 0; k < step.length; k++) {
      const n = step[k](v);
      if (prev.has(n)) continue;
      prev.set(n, [v, k]);
      if (n === tgt) {
        const out: number[] = [];
        for (let x = n; x !== from; x = prev.get(x)![0]) out.unshift(c[prev.get(x)![1]]);
        return out;
      }
      q.push(n);
    }
  }
  return [];
}

let ovChain: Promise<void> = Promise.resolve();
/** Override auf einen Wert setzen (Schieberegler). Nacheinander, nie überlappend. */
export function setOverride(kind: "feed" | "spindle", target: number): Promise<void> {
  ovChain = ovChain.catch(() => {}).then(async () => {
    if (!machine.connected) return;
    const i = kind === "feed" ? 0 : 2;
    const bytes = overrideBytes(kind, machine.status.ov[i], target);
    for (const b of bytes) await invoke("machine_realtime", { code: b });
    // bis der nächste Statusbericht kommt, gilt der neue Wert
    machine.status.ov[i] = Math.max(OV_MIN, Math.min(OV_MAX, Math.round(target)));
  });
  return ovChain;
}

type Ack = { ok: boolean; code?: number };
// Wartende Zeilen: Nummer (vom Rust-Teil) -> wer auf die Antwort wartet.
// Jede Antwort trägt die Nummer ihrer Zeile – so kann sich die Zuordnung nie verschieben,
// auch wenn eine Antwort verloren geht (z. B. Board startet beim Verbinden neu).
const waiting = new Map<number, (a: Ack) => void>();
const early = new Map<number, Ack>(); // Antwort kam schneller als die Nummer

let log: (s: string) => void = () => {};

function fire(type: string, data?: any) {
  window.dispatchEvent(new CustomEvent(MACHINE_EVENT, { detail: { type, data } }));
}

// ---------------------------------------------------------------------
// MEHRERE MASCHINEN
// Jede Verbindung hat eine Kennung ("m1", "m2" …), die die Oberfläche schon vor dem Verbinden
// vergibt – so landet auch die allererste Meldung des Boards richtig. `machine` zeigt immer die
// ausgewählte Maschine (dorthin gehen Befehle und Jobs); die anderen liegen in `others` und
// laufen im Hintergrund weiter (Status, Job-Fortschritt, Alarme werden dort mitgeschrieben).
// ---------------------------------------------------------------------

type MachineState = Pick<typeof machine, "protocol" | "ruidaBed" | "connected" | "port" | "firmware" | "version" | "status" | "job" | "settings" | "lastAlarm" | "info">;
interface Slot { id: string; mode: MachineMode; state: MachineState; infoRequested: boolean; espInfoRequested: boolean }

/** Kurzinfo für die Maschinen-Liste */
export interface SlotInfo {
  id: string; active: boolean; mode: MachineMode; connected: boolean; port: string; firmware: string;
  state: string; job: { active: boolean; acked: number; total: number; paused: boolean }; info: BoardInfo;
}

let activeId = "m1";
let activeMode: MachineMode = "mill";
let idCounter = 1;
const others = new Map<string, Slot>();

export function activeMachineId(): string { return activeId; }

function emptyState(): MachineState {
  return {
    protocol: "grbl", ruidaBed: null, connected: false, port: "", firmware: "", version: "",
    status: { state: "", sub: null, mpos: [0, 0, 0], wpos: [0, 0, 0], feed: 0, spindle: 0, ov: [100, 100, 100], pins: "", acc: null },
    job: { active: false, sent: 0, acked: 0, total: 0, paused: false, toolChange: false, stopping: false },
    settings: new Map(), lastAlarm: 0,
    info: { name: "", version: "", date: "", options: "", rx: 0, fw: "", host: "", raw: [] }
  };
}
function takeState(): MachineState {
  const { protocol, ruidaBed, connected, port, firmware, version, status, job, settings, lastAlarm, info } = machine;
  return { protocol, ruidaBed, connected, port, firmware, version, status, job, settings, lastAlarm, info };
}

/** Alle Maschinen (ausgewählte zuerst nicht nötig – Reihenfolge nach Kennung) */
export function machineSlots(): SlotInfo[] {
  const row = (id: string, mode: MachineMode, s: MachineState, active: boolean): SlotInfo => ({
    id, active, mode, connected: s.connected, port: s.port, firmware: s.firmware, state: s.status.state,
    job: { active: s.job.active, acked: s.job.acked, total: s.job.total, paused: s.job.paused }, info: s.info
  });
  const list = [row(activeId, activeMode, takeState(), true)];
  for (const o of others.values()) list.push(row(o.id, o.mode, o.state, false));
  return list.sort((a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10));
}

/** Zahl der verbundenen Maschinen */
export function connectedCount(): number {
  return (machine.connected ? 1 : 0) + [...others.values()].filter(o => o.state.connected).length;
}

/** Ausgewählte Maschine wegpacken (nur wenn verbunden – leere Plätze verschwinden) */
function parkActive() {
  if (machine.connected) others.set(activeId, { id: activeId, mode: getMachineMode(), state: takeState(), infoRequested, espInfoRequested });
}

async function activate(id: string, s: MachineState, mode: MachineMode | null, flags = { infoRequested: false, espInfoRequested: false }) {
  flushAcks(false); // Antworten der alten Maschine nicht mehr abwarten
  const from = activeId;
  Object.assign(machine, s);
  infoRequested = flags.infoRequested;
  espInfoRequested = flags.espInfoRequested;
  activeId = id;
  try { await invoke("machine_select", { conn: id }); } catch { /* im Browser-Test ohne Tauri */ }
  // gleiche Maschinenart (Fräse/Laser/Plasma) wie beim Verbinden -> Bett, Profil und Werkzeuge passen
  if (mode && mode !== getMachineMode()) setMachineMode(mode);
  activeMode = getMachineMode();
  fire("switched", { id, from });
  fire(machine.connected ? "connected" : "disconnected", { port: machine.port });
  if (machine.connected) { fire("status", machine.status); fire("info", machine.info); }
  fire("slots");
}

/** Andere (verbundene) Maschine auswählen */
/** Darf gerade nicht gewechselt werden? (Werkzeugwechsel läuft – Befehle gingen sonst an die andere Maschine) */
let switchGuard: () => boolean = () => false;
export function setSwitchGuard(fn: () => boolean) { switchGuard = fn; }

export async function selectMachine(id: string): Promise<void> {
  if (id === activeId) return;
  if (switchGuard()) { log(t("tc.noSwitch")); return; }
  const o = others.get(id);
  if (!o) return;
  others.delete(id);
  parkActive();
  await activate(o.id, o.state, o.mode, o);
}

/** Leeren Platz für eine weitere Verbindung anlegen und auswählen */
export async function newMachineSlot(): Promise<void> {
  if (!machine.connected) return; // der ausgewählte Platz ist schon frei
  if (switchGuard()) { log(t("tc.noSwitch")); return; }
  parkActive();
  let n = idCounter;
  do n++; while (others.has("m" + n));
  idCounter = n;
  await activate("m" + n, emptyState(), null);
}

/** Not-Halt für alle Maschinen: laufende Jobs anhalten (Laser/Spindel aus). Rückgabe: Anzahl */
export async function stopAllMachines(): Promise<number> {
  try { return await invoke<number>("machine_stop_all"); } catch { return 0; }
}

/** Zustand, zu dem ein Ereignis gehört: die ausgewählte Maschine oder eine im Hintergrund */
function route(p: any): { m: MachineState; own: boolean; tag: string } | null {
  const c = p && typeof p.conn === "string" ? p.conn : activeId;
  if (c === activeId) return { m: machine, own: true, tag: "" };
  const o = others.get(c);
  if (!o) return null;
  const n = machineSlots().findIndex(x => x.id === c) + 1;
  return { m: o.state, own: false, tag: `[${t("ms.machineN", { n })}] ` };
}

function flushAcks(ok: boolean) {
  for (const r of waiting.values()) r({ ok, code: -4 });
  waiting.clear();
  early.clear();
}

function resolveAck(id: number | null | undefined, a: Ack) {
  if (typeof id !== "number" || id <= 0) return;
  const r = waiting.get(id);
  if (r) { waiting.delete(id); r(a); }
  else { early.set(id, a); if (early.size > 200) early.delete(early.keys().next().value as number); }
}

/**
 * Fehler ins Protokoll. Antworten ohne gesendete Zeile (id null) kommen nach einem Alarm oft dutzendfach: das Board
 * hatte schon viele Job-Zeilen im Empfangspuffer und lehnt jede mit „Fehler 9“ ab. Gleiche solche Fehler kurz
 * hintereinander werden zu einer Zeile „… ×N“ zusammengefasst.
 */
let strayErr: { code: number; count: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
const errLine = (code: number, n: number) => t("m.error", { code, text: errorText(code) }) + (n > 1 ? ` ×${n}` : "");
function flushStray() {
  if (!strayErr) return;
  if (strayErr.timer) clearTimeout(strayErr.timer);
  log(errLine(strayErr.code, strayErr.count));
  strayErr = null;
}
function logError(code: number, stray: boolean) {
  if (!stray) { log(errLine(code, 1)); return; }
  if (strayErr && strayErr.code === code) strayErr.count++;
  else { flushStray(); strayErr = { code, count: 1, timer: null }; }
  if (strayErr.timer) clearTimeout(strayErr.timer);
  strayErr.timer = setTimeout(flushStray, 400);
}

/** Text zu einem GRBL-Fehlercode */
export function errorText(code: number): string {
  const k = `grbl.err.${code}`;
  const s = t(k);
  return s === k ? t("grbl.errUnknown") : s;
}

/**
 * Text zu einem GRBL-Alarm. Ab 11 sind die Nummern je Firmware verschieden (FluidNC: 14 = nicht referenziert …) –
 * die Texte 11–18 gelten nur für grblHAL.
 */
export function alarmText(code: number, firmware = machine.firmware): string {
  if (code > 10 && !/grblhal/i.test(firmware)) return t("grbl.alarmUnknown");
  const k = `grbl.alarm.${code}`;
  const s = t(k);
  return s === k ? t("grbl.alarmUnknown") : s;
}

export async function initMachine(logFn: (s: string) => void) {
  log = logFn;
  const on = async (name: string, fn: (p: any) => void) => {
    try { await listen(name, (e: any) => fn(e.payload)); } catch { /* im Browser-Test ohne Tauri */ }
  };

  await on("machine-welcome", (p) => {
    const r = route(p); if (!r) return;
    const { m, own, tag } = r;
    m.firmware = p.firmware || "";
    m.version = p.version || "";
    if (m.firmware === "K40") m.protocol = "k40";
    if (m.firmware === "Ruida") {
      m.protocol = "ruida";
      m.ruidaBed = p.bedX > 0 && p.bedY > 0 ? { w: p.bedX, h: p.bedY } : null;
    }
    fire("slots");
    if (!own) { log(tag + t("m.welcome", { fw: m.firmware, v: m.version })); return; }
    flushAcks(false);
    resetInfo();
    if (machine.firmware === "Marlin" && machine.protocol === "marlin") {
      log(t("m.marlinWelcome", { v: p.version || "?" }));
      fire("welcome", p);
      return;
    }
    if (machine.firmware === "K40") {
      log(t("m.k40Welcome", { board: p.version || "M2", raw: p.raw || "" }));
      fire("welcome", p);
      return;
    }
    if (machine.firmware === "Ruida") {
      log(t("m.ruidaWelcome", { card: p.version || "?", raw: p.raw || "" }));
      fire("welcome", p);
      return;
    }
    log(t("m.welcome", { fw: machine.firmware, v: machine.version }));
    if (machine.firmware === "Marlin" || machine.firmware === "Smoothieware") log(t("m.notGrbl", { fw: machine.firmware }));
    fire("welcome", p);
    // Puffergröße und Board-Infos abfragen
    setTimeout(requestInfo, 150);
  });

  await on("machine-status", (p) => {
    const r = route(p); if (!r) return;
    const { m, own } = r;
    const s = m.status;
    const prev = s.state;
    s.state = p.state || "";
    s.sub = p.sub ?? null;
    if (Array.isArray(p.mpos)) s.mpos = p.mpos;
    if (Array.isArray(p.wpos)) s.wpos = p.wpos;
    if (typeof p.feed === "number") s.feed = p.feed;
    if (typeof p.spindle === "number") s.spindle = p.spindle;
    if (Array.isArray(p.ov)) s.ov = p.ov;
    if (typeof p.acc === "string") s.acc = p.acc;
    s.pins = p.pins || "";
    if (prev !== s.state) fire("slots");
    if (!own) return;
    if (!machine.firmware && s.state && machine.protocol === "grbl") {
      // Board lief schon (keine Startmeldung) – trotzdem Infos holen
      machine.firmware = "GRBL";
      fire("welcome", { firmware: "GRBL", version: "" });
      setTimeout(requestInfo, 150);
    }
    fire("status", s);
    if (prev !== s.state) fire("state", { from: prev, to: s.state });
  });

  await on("machine-line", (p) => {
    const r = route(p); if (!r) return;
    const { m, own, tag } = r;
    if (!own) {
      // Hintergrund: nur Einstellungen mitschreiben und Fehler melden
      if (p.kind === "setting") m.settings.set(p.key, p.value);
      else if (p.kind === "error") log(tag + t("m.error", { code: p.code, text: errorText(p.code) }));
      return;
    }
    switch (p.kind) {
      case "ok":
        resolveAck(p.id, { ok: true });
        break;
      case "error":
        resolveAck(p.id, { ok: false, code: p.code });
        logError(p.code, p.id == null);
        break;
      case "timeout":
        // Antwort verloren gegangen – der Befehl kam evtl. trotzdem an
        resolveAck(p.id, { ok: false, code: -3 });
        break;
      case "setting":
        machine.settings.set(p.key, p.value);
        fire("setting", p);
        break;
      default:
        // grblHAL-Einstellungsbeschreibungen ($ES/$ESG/$EG): über 100 Zeilen – nicht in die Konsole
        if (parseHalLine(String(p.text || ""))) { fire("text", p); break; }
        parseInfoLine(String(p.text || ""));
        log(`[${t("m.board")}] ${maskSecrets(String(p.text || ""))}`);
        fire("text", p);
    }
  });

  await on("machine-alarm", (p) => {
    const r = route(p); if (!r) return;
    const { m, own, tag } = r;
    m.lastAlarm = p.code;
    log(tag + t("m.alarm", { code: p.code, text: alarmText(p.code, m.firmware) }));
    fire("slots");
    if (own) fire("alarm", p);
  });

  await on("machine-disconnected", (p) => {
    const r = route(p); if (!r) return;
    const { m, own, tag } = r;
    m.connected = false;
    m.job.active = false;
    log(tag + t("m.lost", { e: p.reason || "" }));
    if (!own) {
      const mode = others.get(p.conn)?.mode;
      others.delete(p.conn);
      fire("bg-job-done", { conn: p.conn, mode, data: { aborted: true, acked: m.job.acked, reason: "disconnected" }, gone: true });
      fire("slots");
      return;
    }
    flushAcks(false);
    fire("disconnected", p);
    fire("slots");
  });

  await on("machine-job-progress", (p) => {
    const r = route(p); if (!r) return;
    const { m, own } = r;
    const was = m.job.active;
    Object.assign(m.job, { active: true, sent: p.sent, acked: p.acked, total: p.total, paused: p.paused, toolChange: p.toolChange, stopping: p.stopping });
    if (!was || !own) fire("slots");
    if (own) fire("job-progress", machine.job);
  });

  await on("machine-job-error", (p) => {
    const r = route(p); if (!r) return;
    const { m, own, tag } = r;
    m.job.paused = true;
    log(tag + t("m.jobError", { n: (p.index ?? 0) + 1, line: p.line || "", code: p.code, text: errorText(p.code) }));
    fire("slots");
    if (own) fire("job-error", p);
  });

  await on("machine-job-toolchange", (p) => {
    const r = route(p); if (!r) return;
    const { m, own, tag } = r;
    m.job.paused = true;
    m.job.toolChange = true;
    log(tag + t("stream.toolChange", { note: p.note || "" }));
    fire("slots");
    if (own) fire("job-toolchange", p);
  });

  await on("machine-job-done", (p) => {
    const r = route(p); if (!r) return;
    const { m, own, tag } = r;
    m.job.active = false;
    m.job.paused = false;
    m.job.toolChange = false;
    if (p.aborted) log(tag + t("m.jobAborted", { reason: t("m.reason." + (p.reason || "stopped")), n: p.acked, total: p.total }));
    else log(tag + t("m.jobDone", { total: p.total, errors: p.errors }));
    fire("slots");
    if (own) fire("job-done", p);
    else fire("bg-job-done", { conn: p.conn, mode: others.get(p.conn)?.mode, data: p });
  });
}

// ---------------------------------------------------------------------
// Befehle
// ---------------------------------------------------------------------

/** Gerät aus der Netzwerk-Suche (Rust: netscan.rs) */
export interface NetDevice {
  ip: string;
  port: number;
  kind: "grbl" | "open" | string; // grbl = antwortet wie GRBL, open = Port offen, Antwort unklar
  firmware: string;               // z. B. "Grbl 1.1h", "FluidNC v3.9.1"
  name: string;                   // Titel der Weboberfläche, z. B. "MKS DLC32"
  host?: string;                  // Name im Netzwerk (Hostname), z. B. "laser-garage"
}

/** Eigenes Netz nach GRBL-Maschinen absuchen (dauert ein paar Sekunden).
 *  hints = zuletzt benutzte/gefundene Adressen – werden zuerst und gründlich geprüft */
export async function netScan(hints: string[] = []): Promise<{ own: string; devices: NetDevice[] }> {
  return await invoke<{ own: string; devices: NetDevice[] }>("net_scan", { hints });
}

export async function listPorts(): Promise<PortInfo[]> {
  try { return await invoke<PortInfo[]>("list_ports"); } catch { return []; }
}

export async function connect(port: string, baud: number): Promise<void> {
  machine.protocol = "grbl";
  machine.firmware = "";
  machine.version = "";
  machine.settings.clear();
  flushAcks(false);
  resetInfo();
  await invoke("machine_connect", { port, baud, conn: activeId });
  machine.connected = true;
  machine.port = port;
  machine.status.ov = [100, 100, 100]; machine.status.acc = null;
  activeMode = getMachineMode();
  fire("connected", { port });
  fire("slots");
  // Manche Boards melden sich nicht von selbst (oder liefen schon) -> nachfragen
  setTimeout(() => { if (machine.connected && machine.protocol === "grbl") requestInfo(); }, 2500);
}

export async function disconnect(): Promise<void> {
  try { await invoke("machine_disconnect", { conn: activeId }); } catch { /* egal */ }
  machine.connected = false;
  machine.job.active = false;
  flushAcks(false);
  fire("disconnected", {});
  // noch andere Maschinen verbunden? Dann die nächste auswählen
  const next = [...others.values()].find(o => o.state.connected);
  if (next) { others.delete(next.id); await activate(next.id, next.state, next.mode, next); }
  else fire("slots");
}

/**
 * Ruida-Steuerung verbinden. target = IP-Adresse (Netzwerk) oder USB-Port.
 * Prüft vorher, ob die Steuerung antwortet (und welcher Schlüssel passt).
 */
export async function connectRuida(target: string): Promise<void> {
  machine.protocol = "ruida";
  machine.firmware = "";
  machine.version = "";
  machine.settings.clear();
  flushAcks(false);
  resetInfo();
  const o = ruidaOptions();
  try {
    await invoke("ruida_connect", { target, bedW: o.bedW, bedH: o.bedH, origin: o.origin, sMax: o.sMax, magic: o.magic, minPower: o.minPower, conn: activeId });
  } catch (e) {
    machine.protocol = "grbl";
    throw e;
  }
  machine.connected = true;
  machine.port = target;
  machine.status.ov = [100, 100, 100]; machine.status.acc = null;
  activeMode = getMachineMode();
  fire("connected", { port: target });
  fire("slots");
}

/** Marlin-Maschine verbinden (Creality, Anycubic, MPCNC …). laser: bei Pause wird der Laser ausgeschaltet */
export async function connectMarlin(port: string, baud: number, laser: boolean): Promise<void> {
  machine.protocol = "marlin";
  machine.firmware = "";
  machine.version = "";
  machine.settings.clear();
  flushAcks(false);
  resetInfo();
  try {
    await invoke("marlin_connect", { port, baud, laser, conn: activeId });
  } catch (e) {
    machine.protocol = "grbl";
    throw e;
  }
  machine.connected = true;
  machine.port = port;
  machine.status.ov = [100, 100, 100]; machine.status.acc = null;
  activeMode = getMachineMode();
  fire("connected", { port });
  fire("slots");
}

/** K40 mit Original-Board (USB, kein serieller Port) verbinden */
export async function connectK40(index: number): Promise<void> {
  machine.protocol = "k40";
  machine.firmware = "";
  machine.version = "";
  machine.settings.clear();
  flushAcks(false);
  resetInfo();
  const o = ruidaOptions();
  try {
    await invoke("k40_connect", { index, bedW: o.bedW, bedH: o.bedH, board: o.board || "M2", sMax: o.sMax, conn: activeId });
  } catch (e) {
    machine.protocol = "grbl";
    throw e;
  }
  machine.connected = true;
  machine.port = "K40 USB";
  machine.status.ov = [100, 100, 100]; machine.status.acc = null;
  activeMode = getMachineMode();
  fire("connected", { port: machine.port });
  fire("slots");
}

/** Wie viele K40-Boards hängen am USB? */
export async function k40Count(): Promise<number> {
  try { return await invoke<number>("k40_count"); } catch { return 0; }
}

/** Ruida: aktuelle Bettgröße / Nullpunkt / S-Max an den Rust-Teil geben */
export async function syncRuidaOptions(): Promise<void> {
  if (!machine.connected) return;
  const o = ruidaOptions();
  if (machine.protocol === "k40") {
    try { await invoke("k40_set_options", { bedW: o.bedW, bedH: o.bedH, board: o.board || "M2", sMax: o.sMax }); } catch { /* egal */ }
    return;
  }
  if (machine.protocol !== "ruida") return;
  try { await invoke("ruida_set_options", { bedW: o.bedW, bedH: o.bedH, origin: o.origin, sMax: o.sMax, minPower: o.minPower }); } catch { /* egal */ }
}

/** G-Code als Ruida-.rd-Datei speichern (geht auch ohne Verbindung) */
export async function exportRd(lines: string[], path: string): Promise<{ bytes: number; parts: number; cuts: number; w: number; h: number }> {
  const o = ruidaOptions();
  return await invoke("ruida_export", { lines, path, bedW: o.bedW, bedH: o.bedH, origin: o.origin, sMax: o.sMax, magic: o.magic, minPower: o.minPower });
}

/** Zeile senden (ohne auf die Antwort zu warten). Fehler der Maschine erscheinen in der Konsole. */
export async function send(line: string, quiet = false): Promise<void> {
  if (!quiet) log(`> ${line}`);
  await invoke<number>("machine_send", { line });
}

/** Zeile senden und auf genau ihre Antwort ("ok"/"error") warten */
/**
 * WLAN-Passwörter in Board-Antworten verdecken (z. B. „$Wifi STA PWD=…“ aus $S, „$Sta/Password=…“),
 * damit sie nicht offen in der Konsole oder auf Screenshots stehen
 */
export function maskSecrets(line: string): string {
  return line.replace(/^(\s*\$?[^=]*(?:PWD|Password|Passwort|Pass)\s*=\s*)(\S.*)$/i, (_m, a: string) => a + "••••••••");
}

export async function sendAndWait(line: string, timeoutMs = 6000, quiet = false): Promise<Ack> {
  if (!quiet) log(`> ${line}`);
  let id: number;
  try { id = await invoke<number>("machine_send", { line }); }
  catch { return { ok: false, code: -1 }; }
  if (!id) return { ok: true };
  const got = early.get(id);
  if (got) { early.delete(id); return got; }
  return new Promise((resolve) => {
    let done = false;
    const finish = (a: Ack) => { if (!done) { done = true; waiting.delete(id); resolve(a); } };
    waiting.set(id, finish);
    setTimeout(() => finish({ ok: false, code: -3 }), timeoutMs);
  });
}

export async function realtime(code: number): Promise<void> {
  if (code === RT.reset) flushAcks(false);
  await invoke("machine_realtime", { code });
}

export async function jobStart(lines: string[]): Promise<number> {
  await syncRuidaOptions();
  const n = await invoke<number>("machine_job_start", { lines });
  Object.assign(machine.job, { active: true, sent: 0, acked: 0, total: n, paused: false, toolChange: false, stopping: false });
  fire("job-progress", machine.job);
  return n;
}
/** Laufenden Job ändern: gesendete Zeilen [from, from+del) durch insert ersetzen (nur noch nicht gesendete, nur GRBL) */
export async function jobPatch(from: number, del: number, insert: string[], expectTotal: number): Promise<number> {
  const n = await invoke<number>("machine_job_patch", { from, delete: del, insert, expectTotal });
  machine.job.total = n;
  return n;
}
export async function jobPause() { await invoke("machine_job_pause"); }
export async function jobResume() { await invoke("machine_job_resume"); }
export async function jobStop() { await invoke("machine_job_stop"); }

/** Darf man gerade von Hand fahren / Befehle schicken? */
export function canCommand(): boolean {
  return machine.connected && (!machine.job.active || machine.job.paused);
}
