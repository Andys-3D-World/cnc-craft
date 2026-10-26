/**
 * WERKZEUGWECHSEL MIT WERKZEUGLÄNGEN-MESSUNG (nur Fräse mit GRBL/grblHAL)
 *
 * Der Job läuft im Rust-Teil (machine.rs): bei „M0“/„M1“ und „M6 T<n>“ schickt er die Zeile NICHT, wartet, bis die
 * Maschine steht und der Puffer leer ist, und meldet „machine-job-toolchange“ ({ note, tool, m6 }). Der Job ist dann
 * angehalten (paused) – Handbefehle gehen durch, erst jobResume() schickt den Rest.
 * Hier läuft der Ablauf als Zustandsmaschine (TcState) mit der Antast-Routine aus probe.ts (kein G38.2, siehe dort):
 *
 *   Fester Sensor:   M5 → Z hoch (nur hoch, Maschinen-Z) → [noch keine Referenz: altes Werkzeug am Sensor messen]
 *                    → Wechselposition → Nutzer wechselt, klickt → am Sensor messen → Z-Nullpunkt um den
 *                    Längenunterschied verschieben (G10 L20 P0, aktives Koordinatensystem) → zurück → Nutzer bestätigt → weiter
 *   Mobile Platte:   M5 → Z hoch → [Wechselposition] → Nutzer wechselt, legt Platte unter, Klemme dran, klickt „Antasten“
 *                    → antasten → Z = Plattendicke → hoch → „Platte entfernen“ bestätigen → zurück → bestätigen → weiter
 *   Von Hand:        Z hoch (Einstellung tcLift) → Hinweis mit dem neuen Werkzeug, der Nutzer nullt selbst und
 *                    klickt „Weiter“ → zurück wie unten → weiter
 *
 * Referenz (fester Sensor): Maschinen-Z beim Kontakt des Werkzeugs, das gerade in der Spindel steckt. Nach jedem
 * Wechsel ist das neue Werkzeug die Referenz. Gelöscht bei Alarm, Reset, Trennen und Job-Ende.
 * Z neu:  aktuelles Werkstück-Z − (Kontakt neu − Kontakt alt). Ein längeres Werkzeug berührt höher → Nullpunkt wandert mit.
 *
 * Sicherheit: höchste Antast-Distanz (tcTravel) – ohne Kontakt kein Z setzen. Alarm, Reset/Not-Aus, Trennen, Stopp
 * → Fahrt sofort abbrechen, Job NICHT fortsetzen (bei Alarm/Stopp wird er beendet). Weiter geht es nur nach Klick.
 * Alle Fahrten als Jog ($J=…): die ändern den Zustand des G-Code-Programms nicht (sonst wäre danach z. B. G0 aktiv).
 * Zoll (G20) und relative Maße (G91) des Programms werden vorher gelesen ($G) und danach wiederhergestellt.
 */
import { t, allBuiltinTexts, ascii } from "./i18n/i18n";
import { machine, MACHINE_EVENT, sendAndWait, jobResume, jobStop, setSwitchGuard } from "./machine";
import { probeSettings as s, setProbeLog, step, settled, startGuard, stopGuard, freshStatus, touchAt, liftUp, abortProbe,
  guard, sleep } from "./probe";
import { getTools } from "./toolLibrary";

export enum TcState {
  Idle = "idle",
  Manual = "manual",               // von Hand: nur Hinweis, Nutzer klickt „Weiter“
  Parking = "parking",             // Spindel aus, Z hoch
  MeasureRef = "measureRef",       // altes Werkzeug am Sensor messen (Referenz)
  Travel = "travel",               // fährt zur Wechselposition
  WaitSwap = "waitSwap",           // fester Sensor: Nutzer wechselt das Werkzeug
  WaitPlate = "waitPlate",         // mobile Platte: Nutzer wechselt, legt Platte unter, klickt „Antasten“
  Probing = "probing",             // misst das neue Werkzeug
  Failed = "failed",               // Messung ging nicht – Z NICHT verändert; nochmal / von Hand / abbrechen
  WaitRemovePlate = "waitRemove",  // Platte + Klemme entfernen
  Returning = "returning",         // zurück zur Position vor dem Wechsel
  WaitResume = "waitResume",       // fertig – Nutzer bestätigt das Weitermachen
  Aborted = "aborted"              // abgebrochen, Job geht nicht weiter
}

/** Werkzeugwechsel im G-Code: „M6 T<n> (…)“ (Einstellung) oder wie bisher „M0 (…)“ */
export function toolChangeGcode(num: number, comment: string): string {
  return s.tcM6 && num > 0 ? `M6 T${num} ${comment}` : `M0 ${comment}`;
}

export interface TcTool { num: number | null; name: string; d: number | null }

export const tc = {
  state: TcState.Idle,
  tool: { num: null, name: "", d: null } as TcTool,
  note: "",
  msg: "",                 // letzter Fehler / Abbruchgrund (für den Dialog)
  delta: null as number | null,   // gemessener Längenunterschied (mm)
  zSet: null as number | null,    // gesetzter Z-Wert (Platte)
  spindle: "",             // wird beim Weitermachen wieder eingeschaltet (z. B. "M3 S12000"), "" = nichts
  ref: null as number | null,     // Referenz: Maschinen-Z beim Sensor-Kontakt des aktuellen Werkzeugs
  refBusy: false
};

type Answer = "go" | "skip" | "cancel";
let pending: ((a: Answer) => void) | null = null;
let cancelled = false;
let log: (s: string) => void = () => {};
const listeners: (() => void)[] = [];
export function onToolChange(fn: () => void) { listeners.push(fn); }

function set(st: TcState, msg = "") {
  tc.state = st;
  tc.msg = msg;
  listeners.forEach(f => f());
}

/** Läuft gerade ein Ablauf, der die Maschine bewegt oder auf eine Antwort wartet? (Fortsetzen/Wechseln/Antasten gesperrt) */
export function toolChangeBusy(): boolean {
  return tc.refBusy || ![TcState.Idle, TcState.Manual, TcState.Aborted].includes(tc.state);
}
/** Wartet der Ablauf gerade auf einen Klick (dann dürfen die Knöpfe im Dialog etwas tun)? */
export const tcWaiting = () => pending !== null;

/** Antwort aus dem Dialog */
export function tcAnswer(a: "go" | "skip") {
  const p = pending;
  pending = null;
  p?.(a);
}

function waitUser(st: TcState, msg = ""): Promise<Answer> {
  return new Promise(res => { pending = res; set(st, msg); });
}

class Cancel extends Error {}
/** Schritt-Ergebnis prüfen: false → Abbruch (Grund im Log) */
const must = (ok: boolean, why: string) => { if (cancelled || guard.tripped) throw new Cancel(); if (!ok) throw new Error(why); };

// ---------------------------------------------------------------------
// Werkzeug aus der Meldung erkennen
// ---------------------------------------------------------------------

/** Kommentar „WERKZEUGWECHSEL {i}: {name}, Durchmesser {d} mm …“ in irgendeiner Sprache → Name/Ø; null = kein Werkzeugwechsel */
export function parseToolNote(note: string): { name: string; d: number | null } | null {
  for (const tpl of allBuiltinTexts("gc.toolChange")) {
    const parts = ascii(tpl).split(/(\{i\}|\{name\}|\{d\})/);
    const keys: string[] = [];
    const re = parts.map(p => {
      if (p === "{i}") { keys.push("i"); return "(\\d+)"; }
      if (p === "{d}") { keys.push("d"); return "([\\d.]+)"; }
      if (p === "{name}") { keys.push("name"); return "(.+?)"; }
      return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("");
    const m = note.match(new RegExp("^" + re + "$", "i"));
    if (m) {
      const g = (k: string) => m[keys.indexOf(k) + 1];
      const d = parseFloat(g("d"));
      return { name: g("name") || "", d: Number.isFinite(d) ? d : null };
    }
  }
  return null;
}

function toolInfo(note: string, num: number | null): TcTool {
  if (num !== null && num > 0) {
    const tl = getTools()[num - 1];
    if (tl) return { num, name: tl.name, d: tl.diameter };
  }
  const p = parseToolNote(note);
  return { num, name: p?.name || note, d: p?.d ?? null };
}

// ---------------------------------------------------------------------
// Fahrten (alle als Jog in Maschinenkoordinaten)
// ---------------------------------------------------------------------

const f3 = (v: number) => v.toFixed(3);
const feed = () => Math.max(100, Math.min(10000, s.tcFeed || 1500));

/**
 * Zielhöhe beim Anheben (Maschinen-Z).
 * „Ganz nach oben“ geht nur mit Referenzfahrt nach oben ($22 an, Z nicht umgekehrt in $23): dann liegt die
 * Endschalter-Stelle bei Maschinen-Z 0 und die Referenzfahrt endet um den Abzug ($27) darunter – genau dorthin
 * (höher würde den Endschalter auslösen). Ohne Referenzfahrt: Höhe über dem Werkstück-Nullpunkt (tcWorkZ).
 * Mit Referenzfahrt wird jede Höhe auf diese oberste Stelle begrenzt.
 */
let noTopLogged = false;
async function liftZ(): Promise<number> {
  // Einstellungen noch nicht gelesen ($$)? Dann jetzt – sonst wüssten wir nichts über die Referenzfahrt
  if (!machine.settings.has("$22")) await sendAndWait("$$", 5000, true).catch(() => undefined);
  const num = (k: string) => parseFloat(machine.settings.get(k) || "");
  const homing = (num("$22") | 0) & 1, zDown = (num("$23") | 0) & 4;
  const top = homing && !zDown ? -Math.max(1, Number.isFinite(num("$27")) ? num("$27") : 1) : null;
  if (s.tcLift === 1 && top !== null) return top;
  if (s.tcLift === 1 && !noTopLogged) { noTopLogged = true; log(t("tc.log.noTop", { z: s.tcWorkZ })); }
  // Werkstück-Höhe -> Maschinen-Z (Versatz aus dem letzten Statusbericht)
  const z = s.tcLift === 1 || s.tcLift === 3 ? s.tcWorkZ + (machine.status.mpos[2] - machine.status.wpos[2]) : s.tcSafe;
  return top !== null ? Math.min(z, top) : z;
}

/** Z auf die sichere Höhe – nur nach oben, nie runter (ohne Referenzfahrt kann Maschinen-Z irgendwo liegen) */
async function goSafe(): Promise<boolean> {
  await freshStatus();
  const z = await liftZ();
  if (machine.status.mpos[2] >= z - 0.01) return true;
  log(t("tc.log.safe", { z: z.toFixed(2) }));
  return await step(`$J=G53 G21 Z${f3(z)} F${feed()}`) && await settled();
}
async function moveXY(x: number, y: number): Promise<boolean> {
  await freshStatus();
  if (Math.abs(machine.status.mpos[0] - x) < 0.005 && Math.abs(machine.status.mpos[1] - y) < 0.005) return true;
  return await step(`$J=G53 G21 X${f3(x)} Y${f3(y)} F${feed()}`, 10000) && await settled(120000);
}

/** Werkzeug am festen Sensor messen. Rückgabe: Maschinen-Z beim Kontakt oder null (Z dabei nicht verändert) */
async function measureAtSensor(): Promise<number | null> {
  if (!s.sensorSet) { log(t("pr.sensorNotSet")); return null; }
  if (!await goSafe()) return null;
  log(t("pr.phaseTravel", { x: s.sx, y: s.sy }));
  if (!await moveXY(s.sx, s.sy)) return null;
  // zügig bis zur Start-Höhe über dem Sensor (nur wenn tiefer als jetzt; der Wächter hält bei Kontakt an)
  if (s.tcSz < machine.status.mpos[2] - 0.05) {
    if (!await step(`$J=G53 G21 Z${f3(s.tcSz)} F${Math.min(feed(), 1000)}`) || !await settled()) return null;
  }
  if ((machine.status.pins || "").includes("P")) { log(t("pr.alreadyTriggered")); return null; }
  const z = await touchAt(Math.max(1, s.tcTravel));
  if (z === null) return null;
  if (!await liftUp(true)) return null;
  if (!await goSafe()) return null;
  return z;
}

/** Zustand des G-Code-Programms ($G): Zoll/mm, absolut/relativ, Spindel */
function parserState(): Promise<string> {
  return new Promise(res => {
    let got = "";
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail;
      const m = d?.type === "text" && String(d.data?.text || "").match(/^\[GC:(.*)\]$/);
      if (m) got = m[1];
    };
    window.addEventListener(MACHINE_EVENT, on);
    sendAndWait("$G", 3000, true).finally(() => { window.removeEventListener(MACHINE_EVENT, on); res(got); });
  });
}

// ---------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------

/** Neuer Werkzeugwechsel vom Job (nur die ausgewählte Maschine) */
function onJobToolChange(p: { note?: string; tool?: number | null; m6?: boolean }) {
  const note = String(p?.note || "");
  const m6 = !!p?.m6;
  // M0 ohne Werkzeugwechsel-Kommentar = gewöhnliche Pause wie bisher (Fortsetzen-Knopf)
  if (!m6 && !parseToolNote(note)) return;
  if (toolChangeBusy()) return;
  tc.tool = toolInfo(note, p?.tool ?? null);
  tc.note = note;
  tc.delta = null; tc.zSet = null; tc.spindle = "";
  manualStart = null;
  noTopLogged = false;
  const auto = machine.protocol === "grbl" && (s.tcMode === 1 || s.tcMode === 2);
  if (!auto) {
    if (machine.protocol === "grbl" && s.tcLift !== 2) manualLift();
    else set(TcState.Manual);
    return;
  }
  run(s.tcMode === 1 ? "sensor" : "plate");
}

/** Lage vor dem Wechsel (Maschinen-XY, Werkstück-Z) und Programm-Zustand ($G) */
interface TcStart { x: number; y: number; wz: number; gc: string }
/** Von Hand: hier stand die Maschine vor dem Anheben (null = nicht angehoben) */
let manualStart: TcStart | null = null;

async function readStart(): Promise<TcStart> {
  // zwei frische Berichte, damit der Versatz sicher stimmt
  await freshStatus(); await freshStatus();
  const pos = { x: machine.status.mpos[0], y: machine.status.mpos[1], wz: machine.status.wpos[2] };
  return { ...pos, gc: await parserState() };
}

/** Von Hand: erst Z hoch, dann den Hinweis zeigen. Geht das Anheben nicht, bleibt es beim Hinweis (wie früher). */
async function manualLift() {
  cancelled = false;
  set(TcState.Parking);
  startGuard();
  try {
    const st = await readStart();
    must(await goSafe(), "safe");
    manualStart = st;
    stopGuard();
    set(TcState.Manual);
  } catch (e) {
    stopGuard();
    if (cancelled) return;
    if (guard.tripped) { tcAbort(t("tc.why.guard"), true); return; }
    log(t("tc.err.lift", { e: (e as Error).message || String(e) }));
    set(TcState.Manual);
  }
}

/** Von Hand: doch mit der Tastplatte messen (Knopf im Dialog) */
export function tcManualPlate() {
  if (tc.state !== TcState.Manual || machine.protocol !== "grbl") return;
  const st = manualStart;
  manualStart = null;
  run("plate", st);
}
/** Von Hand: Weiter (Nutzer hat selbst genullt) – war angehoben, erst zurück an die alte Stelle */
export async function tcManualResume() {
  if (tc.state !== TcState.Manual) return;
  const st = manualStart;
  manualStart = null;
  if (st && machine.protocol === "grbl") {
    cancelled = false;
    set(TcState.Returning);
    startGuard();
    try {
      await returnTo(st);
    } catch (e) {
      if (!(e instanceof Cancel) && !cancelled) tcAbort(t("tc.err.step", { e: (e as Error).message || String(e) }), true);
      else if (guard.tripped && (tc.state as TcState) !== TcState.Aborted) tcAbort(t("tc.why.guard"), true);
      return;
    } finally {
      stopGuard();
    }
  }
  set(TcState.Idle);
  try { await jobResume(); } catch (e) { log(`${t("log.error")} ${e}`); }
}

/** Zurück: erst sicher hoch, dann XY, dann auf die alte Werkstück-Höhe (mit dem neuen Nullpunkt, nie höher als jetzt) */
async function returnTo(start: TcStart) {
  const gc = start.gc;
  must(await goSafe(), "safe");
  must(await moveXY(start.x, start.y), "back");
  await freshStatus(); await freshStatus();
  const wco = machine.status.mpos[2] - machine.status.wpos[2];
  const target = Math.min(start.wz + wco, machine.status.mpos[2]);
  // Stand der Fräser beim Wechsel IM Material (Wechsel ohne Hochfahren, z. B. fremde Datei mit M6), nicht wieder
  // runter – ein dickerer Fräser stieße in die schmale Nut. Oben bleiben, das Programm fährt selbst runter.
  // Ausnahme relative Maße (G91): da zählt die genaue Lage.
  const g91 = /\bG91\b/.test(gc);
  if (start.wz < 0 && !g91) log(t("tc.log.stayHigh", { z: start.wz.toFixed(2) }));
  else if (target < machine.status.mpos[2] - 0.05) must(await step(`$J=G53 G21 Z${f3(target)} F${feed()}`) && await settled(), "z");
  // Programm-Zustand wieder herstellen (die Antast-Routine endet mit G90, G10 brauchte G21)
  if (g91) must(await step("G91"), "G91");
  if (/\bG20\b/.test(gc)) must(await step("G20"), "G20");
}

async function run(mode: "sensor" | "plate", from: TcStart | null = null) {
  cancelled = false;
  set(TcState.Parking);
  startGuard();
  try {
    // Lage vor dem Wechsel (von Hand schon angehoben: die Lage von davor)
    const start = from ?? await readStart();
    const gc = start.gc;
    const sp = gc.match(/\b(M[34])\b/), sv = gc.match(/\bS([\d.]+)/);
    tc.spindle = sp ? `${sp[1]} S${sv ? sv[1] : "0"}` : "";
    log(t("tc.log.start", { tool: toolLabel() }));
    must(await step("M5"), "M5");
    if (tc.spindle) await sleep(3000); // auslaufen lassen
    must(await goSafe(), "safe");

    const swapPos = async () => {
      set(TcState.Travel);
      must(await moveXY(s.tcPos ? s.tcX : start.x, s.tcPos ? s.tcY : start.y), "travel");
    };

    if (mode === "sensor") {
      if (tc.ref === null) {
        set(TcState.MeasureRef);
        log(t("tc.log.ref"));
        const z = await measureAtSensor();
        must(z !== null, t("tc.err.ref"));
        tc.ref = z;
      }
      await swapPos();
      let a = await waitUser(TcState.WaitSwap);
      for (;;) {
        if (a === "cancel") throw new Cancel();
        if (a === "skip") { tc.ref = null; break; } // Nutzer hat selbst genullt – alte Referenz passt nicht mehr
        set(TcState.Probing);
        const z = await measureAtSensor();
        if (cancelled || guard.tripped) throw new Cancel();
        if (z !== null) {
          const delta = z - tc.ref!;
          await freshStatus(); await freshStatus();
          const v = machine.status.wpos[2] - delta;
          must(await step("G21") && await step(`G10 L20 P0 Z${f3(v)}`), "G10");
          tc.ref = z; tc.delta = delta;
          log(t("tc.log.delta", { d: delta.toFixed(3) }));
          break;
        }
        a = await waitUser(TcState.Failed, t("tc.err.measure"));
      }
    } else {
      await swapPos();
      let a = await waitUser(TcState.WaitPlate);
      for (;;) {
        if (a === "cancel") throw new Cancel();
        if (a === "skip") { tc.ref = null; break; } // Nutzer hat selbst genullt – alte Referenz passt nicht mehr
        if ((machine.status.pins || "").includes("P")) { a = await waitUser(TcState.WaitPlate, t("pr.alreadyTriggered")); continue; }
        set(TcState.Probing);
        const z = await touchAt(Math.max(1, s.tcTravel));
        if (cancelled || guard.tripped) throw new Cancel();
        if (z !== null) {
          must(await step("G21") && await step(`G10 L20 P0 Z${f3(s.plate)}`), "G10");
          tc.zSet = s.plate;
          tc.ref = null; // Sensor-Referenz gehört zum alten Werkzeug
          log(t("pr.plateDone", { d: s.plate }));
          must(await liftUp(true), "lift");
          if ((await waitUser(TcState.WaitRemovePlate)) === "cancel") throw new Cancel();
          break;
        }
        a = await waitUser(TcState.Failed, t("tc.err.measure"));
      }
    }

    set(TcState.Returning);
    await returnTo(start);
    stopGuard();

    if ((await waitUser(TcState.WaitResume)) !== "go") throw new Cancel();
    if (tc.spindle) {
      log(t("tc.log.spindle", { s: tc.spindle }));
      must(await step(tc.spindle) && await step("G4 P2"), "spindle");
    }
    set(TcState.Idle);
    await jobResume();
    log(t("tc.log.resumed"));
  } catch (e) {
    if (!(e instanceof Cancel) && !cancelled) {
      // Fehler unterwegs (Fahrt abgelehnt, Antast-Fehler …): Job beenden – nichts halb gemacht weiterlaufen lassen
      tcAbort(t("tc.err.step", { e: (e as Error).message || String(e) }), true);
    } else if (guard.tripped && tc.state !== TcState.Aborted) {
      tcAbort(t("tc.why.guard"), true);
    }
  } finally {
    stopGuard();
    pending = null;
  }
}

/**
 * Sofort abbrechen: Fahrt stoppen, kein Fortsetzen. stopJob = den angehaltenen Job auch beenden
 * (bei Alarm/Reset/Trennen ist er schon weg).
 */
export function tcAbort(reason: string, stopJob: boolean, sendCancel = true) {
  if (tc.state === TcState.Idle && !tc.refBusy) return;
  if (tc.state === TcState.Aborted) return;
  cancelled = true;
  manualStart = null;
  abortProbe(sendCancel);
  stopGuard();
  const p = pending; pending = null; p?.("cancel");
  tc.refBusy = false;
  set(TcState.Aborted, reason);
  log(t("tc.log.aborted", { why: reason }));
  if (stopJob && machine.connected && machine.job.active) jobStop().catch(() => undefined);
}
/** Dialog nach einem Abbruch schließen */
export function tcClose() { if (tc.state === TcState.Aborted) set(TcState.Idle); }

/** Knopf „Referenz messen“ (ohne Job): aktuelles Werkzeug am Sensor messen */
export async function measureReference(): Promise<void> {
  if (!machine.connected) { log(t("conn.connectFirst")); return; }
  if (machine.protocol !== "grbl") { log(t("pr.grblOnly")); return; }
  if (toolChangeBusy() || machine.job.active || guard.on) { log(t("sp.jobRunning")); return; }
  if (machine.status.state !== "Idle") { log(t("m.jogNotIdle", { s: machine.status.state })); return; }
  if (!s.sensorSet) { log(t("pr.sensorNotSet")); return; }
  if (!window.confirm(t("tc.refConfirm", { x: s.sx, y: s.sy }))) return;
  tc.refBusy = true; cancelled = false; listeners.forEach(f => f());
  startGuard();
  try {
    const z = await measureAtSensor();
    if (z !== null) { tc.ref = z; log(t("tc.log.refDone", { z: z.toFixed(3) })); }
  } finally {
    stopGuard();
    if (machine.connected && !guard.tripped) await sendAndWait("G90", 3000, true).catch(() => undefined);
    if (guard.tripped) log(t("pr.unlockHint"));
    tc.refBusy = false; listeners.forEach(f => f());
  }
}

export function toolLabel(): string {
  const w = tc.tool;
  return (w.num ? `T${w.num} · ` : "") + (w.name || "?") + (w.d !== null ? ` · Ø ${w.d} mm` : "");
}

export function initToolChange(logFn: (s: string) => void) {
  log = logFn;
  setProbeLog(logFn);
  setSwitchGuard(() => toolChangeBusy());
  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    const { type, data } = (e as CustomEvent).detail || {};
    if (type === "job-toolchange") onJobToolChange(data);
    else if (type === "alarm") { tc.ref = null; tcAbort(t("tc.why.alarm", { code: data?.code ?? "" }), true); }
    else if (type === "disconnected") { tc.ref = null; tcAbort(t("tc.why.lost"), false, false); }
    else if (type === "welcome") { tc.ref = null; tcAbort(t("tc.why.reset"), false, false); }
    else if (type === "switched") tcAbort(t("tc.why.switched"), false, false);
    else if (type === "job-done") {
      tc.ref = null;
      if (tc.state === TcState.Manual) set(TcState.Idle);
      else tcAbort(t("tc.why.stopped"), false);
    } else if (type === "job-progress" && tc.state === TcState.Manual && !machine.job.toolChange) set(TcState.Idle);
  });
}
