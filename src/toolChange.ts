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
 *
 * NACHMESSEN bei langen Jobs (Wärmegang, Einstellung „Werkzeug nachmessen“, Standard aus): cam.ts setzt
 * „M0 (gc.remeasure)“ an sichere Stellen (driftPoints.ts). Dort: Spindel aus → Z hoch → messen → Z-Nullpunkt um die
 * Abweichung zur ersten Messung verschieben → zurück → Spindel an → weiter. Die erste Messung im Job ist die Referenz.
 *   Fester Sensor: läuft allein durch (nur bei großer Abweichung fragt es nach).
 *   Handtaster:    an der Wechselposition – Platte dort hinlegen (auf eine Stelle, die nicht gefräst wird),
 *                  antasten, Platte weg, bestätigen. Gemessen wird relativ (gleiche Platte, gleiche Stelle).
 */
import { isLathe } from "./machineMode";
import { t, allBuiltinTexts, ascii } from "./i18n/i18n";
import { machine, MACHINE_EVENT, sendAndWait, jobResume, jobStop, setSwitchGuard } from "./machine";
import { probeSettings as s, setProbeLog, step, settled, startGuard, stopGuard, freshStatus, touchAt, liftUp, abortProbe,
  guard, sleep } from "./probe";
import { getTools } from "./toolLibrary";
import { fmtLenShort, unitName } from "./units";
import { postCtx } from "./post/postContext";
import { reportsInches } from "./units";
import { getSteps, lookSteps, needsSteps, putSteps, rackBlocked, runsOn, slotForTool, slotOf, type Magazine, type RackBlock, type Slot, type Step } from "./magazine";
import { checkImport, importInApp } from "./importers/importRust";
import { magazine, rackOn, saveMagazine, setInSpindle, slotNumber } from "./magazineStore";

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
  Atc = "atc",                     // Magazin: legt ab / holt (magazine.ts)
  AtcStep = "atcStep",             // Magazin: wartet auf das Ja zum nächsten Schritt
  Returning = "returning",         // zurück zur Position vor dem Wechsel
  WaitResume = "waitResume",       // fertig – Nutzer bestätigt das Weitermachen
  Aborted = "aborted"              // abgebrochen, Job geht nicht weiter
}

/** Werkzeugwechsel im G-Code: „M6 T<n> (…)“ (Einstellung) oder wie bisher „M0 (…)“ */
export function toolChangeGcode(num: number, comment: string): string {
  // file for a controller with a tool table (post/postContext.ts): always with the number – a tool without one stops the export
  if (postCtx.toolTable) return `M6 T${num} ${comment}`;
  // automatisches Magazin: immer mit Nummer, sonst weiß es nicht, welches Werkzeug (nur eigene Programme, nicht Dateien für andere)
  return (s.tcM6 || (rackOn() && !postCtx.foreign)) && num > 0 ? `M6 T${num} ${comment}` : `M0 ${comment}`;
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
  refBusy: false,
  kind: "change" as "change" | "drift" | "fetch",   // Werkzeugwechsel, Nachmessen (Wärmegang) oder Holen/Ablegen ohne Job
  stepText: "",                          // Magazin: der nächste Schritt in Worten
  driftRef: null as number | null,       // Nachmessen mit Handtaster: Maschinen-Z beim ersten Kontakt
  driftAt: 0                             // Zeitpunkt der letzten Messung (ms)
};

/** Größere Abweichung beim Nachmessen wird nicht ohne Nachfrage übernommen (mm) */
const DRIFT_MAX = 0.3;

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

/** Ist das der Mess-Punkt „Werkzeug nachmessen“ aus cam.ts (in irgendeiner Sprache)? */
export function isDriftNote(note: string): boolean {
  return allBuiltinTexts("gc.remeasure").some(tpl => ascii(tpl) === note);
}

/** Neuer Werkzeugwechsel vom Job (nur die ausgewählte Maschine) */
function onJobToolChange(p: { note?: string; tool?: number | null; m6?: boolean }) {
  const note = String(p?.note || "");
  const m6 = !!p?.m6;
  if (!m6 && isDriftNote(note)) { onDriftPoint(); return; }
  tc.kind = "change";
  // M0 ohne Werkzeugwechsel-Kommentar = gewöhnliche Pause wie bisher (Fortsetzen-Knopf)
  if (!m6 && !parseToolNote(note)) return;
  if (toolChangeBusy()) return;
  // Drehbank: keine Fahrten von selbst (Z hoch, Sensor, Platte) – nur der Hinweis, weiter nach dem Klick
  if (isLathe()) { tc.tool = toolInfo(note, p?.tool ?? null); tc.note = note; tc.delta = null; tc.zSet = null; tc.spindle = ""; manualStart = null; set(TcState.Manual); return; }
  tc.tool = toolInfo(note, p?.tool ?? null);
  tc.note = note;
  tc.delta = null; tc.zSet = null; tc.spindle = "";
  manualStart = null;
  noTopLogged = false;
  // automatisches Magazin: nur wenn alles stimmt, sonst wie bisher von Hand (mit dem Grund im Protokoll)
  if (rackOn() && m6) {
    const tl = p?.tool ? getTools()[p.tool - 1] : undefined, slot = tl ? slotForTool(magazine(), tl.id) : null;
    if (slot && slot.n === magazine().inSpindle) { log(t("mag.log.same", { n: slot.n })); jobResume().catch(e => log(`${t("log.error")} ${e}`)); return; }
    const b = atcBlocked();
    if (slot && !b.why) { run("sensor", null, slot); return; }
    log(t("mag.log.byHand", { why: b.why ? t("mag.why." + b.why, { n: b.n }) : t("mag.noSlotFor", { tool: toolLabel() }) }));
    setInSpindle(-1); // von Hand gewechselt: danach sagt der Nutzer, was drin ist
  } else if (rackOn()) setInSpindle(-1);
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
  if (tc.state !== TcState.Manual || machine.protocol !== "grbl" || isLathe()) return;
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

async function run(mode: "sensor" | "plate", from: TcStart | null = null, slot: Slot | null = null) {
  cancelled = false;
  let onward = false;
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
      if (slot) { onward = runsOn(magazine(), slot); await atcSwap(slot); set(TcState.Probing); }
      else await swapPos();
      let a: Answer = slot ? "go" : await waitUser(TcState.WaitSwap);
      for (;;) {
        if (a === "cancel") throw new Cancel();
        if (a === "skip") { tc.ref = null; tc.driftRef = null; break; } // Nutzer hat selbst genullt – alte Referenz passt nicht mehr
        set(TcState.Probing);
        const z = await measureAtSensor();
        if (cancelled || guard.tripped) throw new Cancel();
        if (z !== null) {
          const delta = z - tc.ref!;
          await freshStatus(); await freshStatus();
          const v = machine.status.wpos[2] - delta;
          must(await step("G21") && await step(`G10 L20 P0 Z${f3(v)}`), "G10");
          tc.ref = z; tc.delta = delta; tc.driftRef = null;
          log(t("tc.log.delta", { d: delta.toFixed(3) }));
          break;
        }
        onward = false; // etwas war nicht in Ordnung: vor dem Weitermachen fragen
        a = await waitUser(TcState.Failed, t("tc.err.measure"));
      }
    } else {
      await swapPos();
      let a = await waitUser(TcState.WaitPlate);
      for (;;) {
        if (a === "cancel") throw new Cancel();
        if (a === "skip") { tc.ref = null; tc.driftRef = null; break; } // Nutzer hat selbst genullt – alte Referenz passt nicht mehr
        if ((machine.status.pins || "").includes("P")) { a = await waitUser(TcState.WaitPlate, t("pr.alreadyTriggered")); continue; }
        set(TcState.Probing);
        const z = await touchAt(Math.max(1, s.tcTravel));
        if (cancelled || guard.tripped) throw new Cancel();
        if (z !== null) {
          must(await step("G21") && await step(`G10 L20 P0 Z${f3(s.plate)}`), "G10");
          tc.zSet = s.plate;
          tc.ref = null; // Sensor-Referenz gehört zum alten Werkzeug
          tc.driftRef = null;
          log(t("pr.plateDone", { d: s.plate }));
          must(await liftUp(true), "lift");
          if ((await waitUser(TcState.WaitRemovePlate)) === "cancel") throw new Cancel();
          break;
        }
        a = await waitUser(TcState.Failed, t("tc.err.measure"));
      }
    }

    set(TcState.Returning);
    if (slot) must(await upTo(magazine().zClear), "up"); // nicht auf Sensor-Höhe quer über die Werkzeugreihe
    await returnTo(start);
    stopGuard();

    if (!onward && (await waitUser(TcState.WaitResume)) !== "go") throw new Cancel();
    if (cancelled || guard.tripped) throw new Cancel();
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

/** Mess-Punkt erreicht: messen (wenn fällig) oder gleich weiter */
function onDriftPoint() {
  if (toolChangeBusy()) return;
  const resume = () => jobResume().catch(e => log(`${t("log.error")} ${e}`));
  if (machine.protocol !== "grbl") { log(t("dr.log.grblOnly")); resume(); return; }
  const sensor = s.tcMode === 1;
  if (!sensor && !s.tcPos) { log(t("dr.log.noSpot")); resume(); return; }
  if (sensor && !s.sensorSet) { log(t("pr.sensorNotSet")); resume(); return; }
  // Laufzeit-Schätzung im G-Code war zu kurz (z. B. Overrides) – noch nicht fällig, wenn eine Referenz da ist
  const ref = sensor ? tc.ref : tc.driftRef;
  if (ref !== null && Date.now() - tc.driftAt < s.drMin * 30_000) { resume(); return; }
  tc.kind = "drift";
  tc.tool = { num: null, name: "", d: null };
  tc.note = ""; tc.delta = null; tc.zSet = null; tc.spindle = "";
  noTopLogged = false;
  runDrift(sensor);
}

/** Nachmessen: Referenz beim ersten Mal, danach Z-Nullpunkt um die Abweichung verschieben */
async function runDrift(sensor: boolean) {
  cancelled = false;
  set(TcState.Parking);
  startGuard();
  try {
    const start = await readStart();
    const sp = start.gc.match(/\b(M[34])\b/), sv = start.gc.match(/\bS([\d.]+)/);
    tc.spindle = sp ? `${sp[1]} S${sv ? sv[1] : "0"}` : "";
    must(await step("M5"), "M5");
    if (tc.spindle) await sleep(3000); // auslaufen lassen
    must(await goSafe(), "safe");
    const ref = sensor ? tc.ref : tc.driftRef;
    let a: Answer = "go";
    if (!sensor) {
      set(TcState.Travel);
      must(await moveXY(s.tcX, s.tcY), "travel");
      a = await waitUser(TcState.WaitPlate);
    }
    for (;;) {
      if (a === "cancel") throw new Cancel();
      if (a === "skip") { log(t("dr.log.skipped")); break; } // Z bleibt, wie es ist
      if (!sensor && (machine.status.pins || "").includes("P")) { a = await waitUser(TcState.WaitPlate, t("pr.alreadyTriggered")); continue; }
      set(TcState.Probing);
      let z: number | null;
      if (sensor) z = await measureAtSensor();
      else {
        z = await touchAt(Math.max(1, s.tcTravel));
        if (z !== null) must(await liftUp(true), "lift");
      }
      if (cancelled || guard.tripped) throw new Cancel();
      if (z === null) { a = await waitUser(TcState.Failed, t("tc.err.measure")); continue; }
      tc.driftAt = Date.now();
      if (ref === null) {
        if (sensor) tc.ref = z; else tc.driftRef = z;
        log(t("dr.log.ref", { z: z.toFixed(3) }));
        break;
      }
      const delta = z - ref;
      tc.delta = delta;
      // ungewöhnlich viel: nicht einfach übernehmen (falsche Stelle, Span auf dem Sensor …)
      if (Math.abs(delta) > DRIFT_MAX) {
        a = await waitUser(TcState.Failed, t("dr.tooBig", { d: delta.toFixed(3), max: DRIFT_MAX }));
        continue;
      }
      await freshStatus(); await freshStatus();
      const v = machine.status.wpos[2] - delta;
      must(await step("G21") && await step(`G10 L20 P0 Z${f3(v)}`), "G10");
      if (sensor) tc.ref = z; else tc.driftRef = z;
      log(t("dr.log.delta", { d: delta.toFixed(3) }));
      break;
    }
    if (!sensor && (await waitUser(TcState.WaitRemovePlate)) === "cancel") throw new Cancel();

    set(TcState.Returning);
    await returnTo(start);
    stopGuard();
    // Handtaster: man steht ohnehin an der Maschine – erst nach Bestätigung weiter; Sensor: läuft allein weiter
    if (!sensor && (await waitUser(TcState.WaitResume)) !== "go") throw new Cancel();
    if (tc.spindle) must(await step(tc.spindle) && await step("G4 P3"), "spindle");
    set(TcState.Idle);
    await jobResume();
    log(t("dr.log.resumed"));
  } catch (e) {
    if (!(e instanceof Cancel) && !cancelled) tcAbort(t("tc.err.step", { e: (e as Error).message || String(e) }), true);
    else if (guard.tripped && tc.state !== TcState.Aborted) tcAbort(t("tc.why.guard"), true);
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
  if (tc.state === TcState.Atc || tc.state === TcState.AtcStep) log(t("mag.log.check"));
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

// ---------------------------------------------------------------------
// Magazin (magazine.ts): ablegen und holen
// ---------------------------------------------------------------------

/** Warum die Reihe gerade nicht fahren darf ("" = darf) */
export function atcBlocked(): { why: RackBlock; n: number } {
  return rackBlocked(magazine(), atcEnv());
}
function atcEnv() {
  const n = (k: string) => parseFloat(machine.settings.get(k) ?? "");
  return {
    grbl: machine.connected && machine.protocol === "grbl", firmware: machine.firmware,
    homed: ((n("$22") | 0) & 1) === 1 && machine.homeState !== "lost" && machine.homeState !== "pending",
    inches: reportsInches(machine.settings.get("$13")), sensor: s.tcMode === 1 && s.sensorSet === 1
  };
}
/** The same in Rust (magazine.rs), in the background. The steps that run are always the TypeScript ones handed back */
function rustCheck(m: Magazine, slot: Slot, what: "get" | "put" | "look", steps: Step[]): Step[] {
  if (importInApp()) {
    const env = atcEnv();
    checkImport("magazine_check", { m, slot, what, env }, { steps: structuredClone(steps), blocked: rackBlocked(m, env), need: needsSteps(m, slot, what === "put" ? "put" : "get"), runs: runsOn(m, slot) });
  }
  return steps;
}

/** Z nach oben auf diese Maschinen-Höhe – nie nach unten */
async function upTo(z: number): Promise<boolean> {
  await freshStatus();
  if (machine.status.mpos[2] >= z - 0.01) return true;
  return await step(`$J=G53 G21 Z${f3(z)} F${Math.round(magazine().feedZ)}`) && await settled();
}

function stepText(x: Step): string {
  if (x.k === "up") return t("mag.step.up", { z: f3(x.z) });
  if (x.k === "xy") return t(x.at ? "mag.step.slide" : "mag.step.xy", { x: f3(x.x), y: f3(x.y) });
  if (x.k === "z") return t("mag.step.z", { z: f3(x.z), f: x.feed });
  return t("mag.step." + x.what, { cmd: x.cmd });
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.1;
/** Warten mit Abbruch */
async function pause(seconds: number) {
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) { if (cancelled || guard.tripped) throw new Cancel(); await sleep(50); }
}

async function atcRun(steps: Step[], ask: boolean) {
  for (const x of steps) {
    if (ask) {
      tc.stepText = stepText(x);
      if ((await waitUser(TcState.AtcStep)) !== "go") throw new Cancel();
    }
    if (cancelled || guard.tripped) throw new Cancel();
    set(TcState.Atc);
    log(`[${t("mag.title")}] ${stepText(x)}`);
    if (x.k === "up") { must(await upTo(x.z), "up"); continue; }
    if (x.k === "out") { must(await step(x.cmd), x.cmd); await pause(x.wait); continue; }
    await freshStatus(); await freshStatus();
    const p = machine.status.mpos;
    if (x.k === "xy") {
      // quer nur auf der freien Höhe – oder als Einfahrt genau von der vorgesehenen Stelle aus
      if (x.at) must(near(p[0], x.at.x) && near(p[1], x.at.y) && near(p[2], x.at.z), t("mag.err.place"));
      else must(p[2] >= magazine().zClear - 0.1, t("mag.err.place"));
      must(await step(`$J=G53 G21 X${f3(x.x)} Y${f3(x.y)} F${Math.round(x.feed)}`) && await settled(120000), "xy");
    } else {
      must(near(p[0], x.at.x) && near(p[1], x.at.y), t("mag.err.place"));
      must(await step(`$J=G53 G21 Z${f3(x.z)} F${Math.round(x.feed)}`) && await settled(), "z");
    }
  }
}

/** Werkzeug in der Spindel ablegen (falls eins drin ist) und das neue holen. Spindel ist schon aus */
async function atcSwap(want: Slot | null) {
  const m = magazine();
  await pause(Math.max(0, m.spinS));
  await freshStatus();
  must(!(machine.status.spindle > 0), t("mag.err.spindle"));
  const old = m.inSpindle > 0 ? slotOf(m, m.inSpindle) : null;
  must(m.inSpindle === 0 || !!old, t("mag.why.spindle"));
  if (old) {
    setInSpindle(-1);
    await atcRun(rustCheck(m, old, "put", putSteps(m, old)), needsSteps(m, old, "put"));
    setInSpindle(0);
    mark(old.n, "okPut");
  }
  if (want) {
    setInSpindle(-1);
    await atcRun(rustCheck(m, want, "get", getSteps(m, want)), needsSteps(m, want, "get"));
    setInSpindle(want.n);
    mark(want.n, "okGet");
  }
}
/** Ein Vorgang ist ganz durchgelaufen (beim ersten Mal Schritt für Schritt bestätigt) */
function mark(n: number, what: "okGet" | "okPut") {
  const m = magazine();
  saveMagazine({ ...m, slots: m.slots.map(x => x.n === n ? { ...x, [what]: true } : x) });
}

export type AtcJob = "look" | "get" | "put";
/** Ohne Job: Platz anfahren, Werkzeug holen oder ablegen. Danach startet nichts von selbst. true = fertig */
export async function atcManual(what: AtcJob, n: number): Promise<boolean> {
  if (!rackOn()) return false;
  if (toolChangeBusy() || machine.job.active || guard.on) { log(t("sp.jobRunning")); return false; }
  if (!machine.settings.has("$22")) await sendAndWait("$$", 5000, true).catch(() => undefined);
  const b = atcBlocked(), slot = slotOf(magazine(), n);
  // zum Anfahren muss niemand wissen, was in der Spindel steckt
  if (b.why && !(what === "look" && (b.why === "spindle" || b.why === "sensor" || b.why === "outputs"))) { log(t("mag.why." + b.why, { n: b.n })); return false; }
  if (machine.status.state !== "Idle") { log(t("m.jogNotIdle", { s: machine.status.state })); return false; }
  if (what !== "put" && !slot?.set) return false;
  if (what === "get" && magazine().inSpindle === n) { log(t("mag.log.same", { n })); return false; }
  if (what === "put" && magazine().inSpindle <= 0) { log(t("mag.log.empty")); return false; }
  tc.kind = "fetch"; tc.note = ""; tc.delta = null; tc.zSet = null; tc.spindle = ""; cancelled = false; noTopLogged = false;
  const tl = slot ? getTools().find(x => x.id === slot.toolId) : undefined;
  tc.tool = { num: null, name: t("mag.slotN", { n }) + (tl && what !== "put" ? " · " + tl.name : ""), d: what !== "put" ? tl?.diameter ?? null : null };
  set(TcState.Parking);
  startGuard();
  let done = false;
  try {
    const gc = (await readStart()).gc;
    must(await step("M5"), "M5");
    must(await goSafe(), "safe");
    if (what === "look") await atcRun(rustCheck(magazine(), slot!, "look", lookSteps(magazine(), slot!)), true);
    else if (what === "put") { await atcSwap(null); tc.ref = null; tc.driftRef = null; }
    else {
      const had = magazine().inSpindle > 0;
      // Z-Nullpunkt gehört zum Werkzeug, das noch drin ist: erst messen, dann den Unterschied übernehmen
      if (had && tc.ref === null) { set(TcState.MeasureRef); const z0 = await measureAtSensor(); must(z0 !== null, t("tc.err.ref")); tc.ref = z0; }
      const ref = had ? tc.ref : null;
      await atcSwap(slot);
      set(TcState.Probing);
      tc.ref = null; tc.driftRef = null;
      const z = await measureAtSensor();
      must(z !== null, t("tc.err.measure"));
      if (ref !== null) {
        const delta = z! - ref;
        await freshStatus(); await freshStatus();
        must(await step("G21") && await step(`G10 L20 P0 Z${f3(machine.status.wpos[2] - delta)}`), "G10");
        tc.delta = delta;
        log(t("tc.log.delta", { d: delta.toFixed(3) }));
      } else log(t("mag.log.setZ"));
      tc.ref = z;
      must(await upTo(magazine().zClear), "up");
    }
    if (/\bG91\b/.test(gc)) must(await step("G91"), "G91");
    if (/\bG20\b/.test(gc)) must(await step("G20"), "G20");
    done = true;
    set(TcState.Idle);
    log(t("mag.log.done"));
  } catch (e) {
    if (!(e instanceof Cancel) && !cancelled) tcAbort(t("tc.err.step", { e: (e as Error).message || String(e) }), false);
    else if (guard.tripped && (tc.state as TcState) !== TcState.Aborted) tcAbort(t("tc.why.guard"), false);
    else if (!cancelled) tcAbort(t("tc.why.user"), false);
  } finally {
    stopGuard();
    pending = null;
  }
  return done;
}

export function toolLabel(): string {
  const w = tc.tool;
  const at = w.num ? slotNumber(getTools()[w.num - 1]?.id) : null;
  return (at !== null ? t("mag.slotN", { n: at }) + " · " : "") + (w.num ? `T${w.num} · ` : "") + (w.name || "?") + (w.d !== null ? ` · Ø ${fmtLenShort(w.d, 3)} ${unitName()}` : "");
}

export function initToolChange(logFn: (s: string) => void) {
  log = logFn;
  setProbeLog(logFn);
  setSwitchGuard(() => toolChangeBusy());
  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    const { type, data } = (e as CustomEvent).detail || {};
    if (type === "job-toolchange") onJobToolChange(data);
    else if (type === "alarm") { tc.ref = null; tc.driftRef = null; tcAbort(t("tc.why.alarm", { code: data?.code ?? "" }), true); }
    else if (type === "disconnected") { tc.ref = null; tc.driftRef = null; tcAbort(t("tc.why.lost"), false, false); }
    else if (type === "welcome") { tc.ref = null; tc.driftRef = null; tcAbort(t("tc.why.reset"), false, false); }
    else if (type === "switched") tcAbort(t("tc.why.switched"), false, false);
    else if (type === "job-done") {
      tc.ref = null; tc.driftRef = null;
      if (tc.state === TcState.Manual) set(TcState.Idle);
      else tcAbort(t("tc.why.stopped"), false);
    } else if (type === "job-progress" && tc.state === TcState.Manual && !machine.job.toolChange) set(TcState.Idle);
  });
}
