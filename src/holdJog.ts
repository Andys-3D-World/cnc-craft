/**
 * GEDRÜCKT HALTEN ZUM FAHREN – Schritte schicken und anhalten (Regeln und Rechnungen: holdJogLogic.ts)
 *
 * Die Pfeil-Knöpfe (connection.ts) melden nur „gedrückt“ und „losgelassen“. Hier laufen die kurzen `$J=`-Schritte,
 * solange gedrückt ist, und der Jog-Abbruch (0x85) beim Loslassen.
 *
 * Die Maschine hält sofort an, wenn:
 *   Knopf los · Maus verlässt den Knopf · Fenster verliert den Fokus oder wird versteckt · Verbindung weg · Alarm ·
 *   Job startet · Stopp-Knopf (oben, ■ in der Mitte, Gamepad) · Maschine wird gewechselt · ein Fenster geht auf ·
 *   Antasten/Werkzeugwechsel/Makro beginnt · ein Schritt kommt mit Fehler oder gar nicht zurück.
 * Danach muss der Knopf neu gedrückt werden – eine unterbrochene Fahrt geht nie von selbst weiter.
 * Geht auch 0x85 nicht mehr hinaus (Kabel ab), bleibt die Maschine nach den wenigen Schritten in der Warteschlange stehen.
 * 0x85 geht nur an die GRBL-Familie und nur, wenn diese Fahrt selbst gefahren ist.
 */
import { t } from "./i18n/i18n";
import { machine, MACHINE_EVENT, RT, sendAndWait, realtime, addBeforeSwitch } from "./machine";
import { streamState } from "./machineStream";
import { bedSizeMm } from "./editor/editorState";
import { toolChangeBusy } from "./toolChange";
import { probeRunning } from "./probe";
import { macroRunning } from "./macroRun";
import {
  TICK_MS, STEP_S, MAX_INFLIGHT, HoldBlock, HoldContext, holdBlock, holdAction, holdSupported, shouldRetryCancel,
  holdVelocity, aheadMs, travelBox, planHoldStep,
} from "./holdJogLogic";

interface Held { dir: number[]; feed: () => number; onEnd: () => void }

let log: (s: string) => void = () => {};
let held: Held | null = null;

// laufende Fahrt
let driving = false;
let generation = 0;     // Antworten auf Schritte einer beendeten Fahrt zählen nicht mehr
let jogEnd = [0, 0, 0]; // Ziel des zuletzt geschickten Schritts
let queuedUntil = 0;    // bis wann die geschickten Schritte reichen
let inflight = 0;
let edgeSeen = new Set<string>();
let cancelAt = -Infinity;
let cancelRetries = 5;
let lastSent = 0;
let timer: number | null = null;

const setting = (key: string): number | undefined => {
  const v = parseFloat(machine.settings.get(key) ?? "");
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

/** Ist gerade ein Fenster offen? (Das versteckte im DOM zählt nicht.) */
function dialogOpen(): boolean {
  for (const el of Array.from(document.querySelectorAll(".dlg-overlay"))) if (el.getClientRects().length) return true;
  return false;
}

function context(): HoldContext {
  return {
    connected: machine.connected,
    protocol: machine.protocol,
    firmware: machine.firmware,
    state: machine.status.state,
    jobActive: machine.job.active || streamState.isRunning,
    busy: toolChangeBusy() || probeRunning() || macroRunning(),
    dialog: dialogOpen(),
    focused: document.hasFocus() && !document.hidden,
  };
}

/** Wie bei der Startprüfung (ui/limitGuard.ts): $22 an und seit dem Verbinden kein Alarm */
function travelEnv() {
  const num = (k: string) => parseFloat(machine.settings.get(k) ?? "");
  const { mpos, wpos } = machine.status;
  return {
    travel: [num("$130"), num("$131"), num("$132")],
    homeDirMask: num("$23") | 0,
    pulloff: num("$27"),
    homed: ((num("$22") | 0) & 1) === 1 && machine.homeState !== "lost",
    mpos, wpos,
  };
}

function sendCancel() {
  lastSent = performance.now();
  // nie GRBL-Bytes an Marlin, Ruida oder K40
  if (!machine.connected || !holdSupported(machine.protocol, machine.firmware)) return;
  realtime(RT.jogCancel).catch(() => undefined); // Verbindung weg: die Warteschlange läuft von selbst leer
}

/** Fahrt sofort beenden (0x85). Tut nichts, wenn gerade nicht gefahren wird. */
function stopDrive() {
  if (!driving) return;
  driving = false;
  generation++;
  // Nur ein Schritt, der beim Abbruch noch unterwegs war, kann danach ankommen – dann den Abbruch wiederholen
  cancelRetries = inflight > 0 ? 0 : 5;
  inflight = 0;
  cancelAt = performance.now();
  sendCancel();
}

/** Gedrückt-Halten beenden: anhalten und den Knopf wieder freigeben. why = Meldung, warum (nicht beim normalen Loslassen) */
function endHold(why?: HoldBlock | "failed") {
  const h = held;
  held = null;
  stopDrive();
  if (h) h.onEnd();
  if (why === "failed") log(t("hj.failed"));
  else if (why) log(t("hj.stopped", { why: t("hj.why." + why) }));
}

function ensureTimer() {
  if (timer === null) timer = window.setInterval(tick, TICK_MS);
}

function tick() {
  const now = performance.now();
  const block = held ? holdBlock(context()) : null;
  const action = holdAction(!!held, block, driving, machine.status.state, now, cancelAt);
  if (action === "stop" || (held && block)) { endHold(block ?? undefined); return; }
  if (action === "start") {
    driving = true;
    jogEnd = machine.status.wpos.slice(0, 3);
    queuedUntil = now;
    inflight = 0;
    edgeSeen = new Set();
    cancelRetries = 5;
  }
  if (driving && held) { drive(held, now); return; }
  if (!held && !driving) {
    if (shouldRetryCancel({ driving, connected: machine.connected, state: machine.status.state, retries: cancelRetries, now, lastSent, cancelAt })) {
      cancelRetries++;
      sendCancel();
    }
    // nichts mehr zu tun: Takt aus
    if (cancelRetries >= 5 || now - cancelAt > 1000) { if (timer !== null) { clearInterval(timer); timer = null; } }
  }
}

function drive(h: Held, now: number) {
  const v = holdVelocity(h.dir, h.feed(), [setting("$110"), setting("$111"), setting("$112")]);
  const ahead = aheadMs(v, [setting("$120"), setting("$121"), setting("$122")]);
  // höchstens 3 Schritte je Takt, damit nach einer Pause des Fensters nichts auf einmal losgeschickt wird
  for (let n = 0; n < 3 && queuedUntil - now < ahead && inflight < MAX_INFLIGHT; n++) {
    const bed = bedSizeMm();
    const step = planHoldStep(v, jogEnd, bed, travelBox(travelEnv()));
    for (const e of step.edges) {
      const key = `${e.axis}${e.why}${e.reached}`;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      const axis = "XYZ"[e.axis];
      if (e.why === "travel") log(t("hj.travelEdge", { axis }));
      else log(t(e.reached ? "jog.atEdge" : "jog.toEdge", { axis, b: e.axis ? bed.h : bed.w }));
    }
    if (!step.line) return; // an der Grenze: nichts schicken, bis losgelassen wird
    jogEnd = step.end;
    queuedUntil = Math.max(queuedUntil, now) + STEP_S * 1000;
    inflight++;
    const gen = generation;
    sendAndWait(step.line, 3000, true).then(ack => {
      if (gen !== generation) return;
      inflight--;
      // Fehler (z. B. Softlimit, „nicht im Leerlauf“) oder keine Antwort: anhalten, neu drücken nötig
      if (!ack.ok) endHold("failed");
    });
  }
}

/**
 * Knopf gedrückt. Rückgabe: true = die Fahrt läuft an (onEnd kommt, wenn sie endet – auch ohne Loslassen).
 * false = geht gerade nicht, die Meldung steht schon in der Konsole.
 */
export function holdPress(dir: number[], feed: () => number, onEnd: () => void): boolean {
  if (held) return false; // ein zweiter Finger/Knopf fährt nicht zusätzlich
  if (!dir.some(d => d)) return false;
  const c = context();
  const block = holdBlock(c);
  if (block === "notConnected") { log(t("hj.demo")); return false; }
  if (block === "protocol") { log(t("hj.noProtocol")); return false; }
  if (block === "alarm") { log(t("m.unlockFirst")); return false; }
  if (block === "job") { log(t("m.why.job running")); return false; }
  if (block === "state") { log(t("m.jogNotIdle", { s: c.state })); return false; }
  if (block) { log(t("hj.blocked", { why: t("hj.why." + block) })); return false; }
  held = { dir: dir.slice(0, 3), feed, onEnd };
  ensureTimer();
  tick(); // ohne auf den nächsten Takt zu warten
  return held !== null;
}

/** Knopf losgelassen (oder Maus raus, Fokus weg …): sofort anhalten */
export function holdRelease() {
  if (!held && !driving) return;
  endHold();
  ensureTimer(); // für die Wiederholung des Abbruchs
}

/** Stopp-Knöpfe: läuft gerade ein Halte-Fahren, sofort beenden. true = es lief eines. */
export function holdJogStop(): boolean {
  const was = !!held || driving;
  if (was) holdRelease();
  return was;
}

export function holdJogActive(): boolean { return !!held; }

export function initHoldJog(logFn: (s: string) => void) {
  log = logFn;
  window.addEventListener("blur", () => holdRelease());
  // Maustaste irgendwo losgelassen (auch wenn der Knopf es nicht mitbekommt)
  window.addEventListener("pointerup", () => holdRelease(), true);
  window.addEventListener("pointercancel", () => holdRelease(), true);
  document.addEventListener("visibilitychange", () => { if (document.hidden) holdRelease(); });
  window.addEventListener("pagehide", () => holdRelease());
  window.addEventListener(MACHINE_EVENT, e => {
    const type = (e as CustomEvent).detail?.type;
    if (!held && !driving) return;
    if (type === "disconnected") endHold("notConnected");
    else if (type === "alarm") endHold("alarm");
    else if (type === "job-error" || (type === "job-progress" && machine.job.active)) endHold("job");
  });
  // Abbruch muss noch an die bisherige Maschine gehen
  addBeforeSwitch(async () => {
    const h = held;
    held = null;
    const was = driving;
    driving = false;
    generation++;
    inflight = 0;
    cancelRetries = 5;
    if (h) h.onEnd();
    if (was && holdSupported(machine.protocol, machine.firmware)) { cancelAt = performance.now(); await realtime(RT.jogCancel).catch(() => undefined); }
  });
}
