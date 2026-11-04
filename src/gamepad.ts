/**
 * GAMEPAD – Maschine mit Xbox-/PlayStation-/Noname-Controller fahren und bedienen
 *
 * Liest das Gamepad über Rust (gamepad.rs) – das Fenster meldet Controller auf dem Mac oft nicht – und nur ersatzweise
 * über die Gamepad-Schnittstelle des Fensters. Schickt kurze Jog-Schritte ($J=…), solange der Totmann-Knopf gehalten
 * und ein Stick ausgelenkt ist. Die Regeln und Rechnungen stehen in gamepadLogic.ts.
 *
 * Sicherheit – die Maschine stoppt sofort (0x85), wenn:
 *   Totmann los · Stick in der Mitte · Fenster verliert den Fokus · Gamepad weg · Job/Alarm/Fenster/Antasten ·
 *   Maschine wird gewechselt · ein Schritt kommt mit Fehler zurück
 * Geht auch das nicht mehr (Kabel ab), hält sie nach den wenigen Schritten in der Warteschlange von selbst an.
 * 0x85 wird nur geschickt, wenn das Gamepad selbst gefahren ist – sonst würde es z. B. eine Antast-Fahrt abbrechen.
 *
 * Rust liest auch ohne Fokus: Stopp und Pause gehen dann weiter, alles andere sperrt die Fokus-Regel.
 */
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n/i18n";
import { machine, MACHINE_EVENT, RT, send, sendAndWait, realtime, activeMachineId, setBeforeSwitch } from "./machine";
import { streamState, startStreaming, pauseStreaming } from "./machineStream";
import { bedSizeMm } from "./editor/editorState";
import { toolChangeBusy, tcAbort } from "./toolChange";
import { probeRunning, abortProbe } from "./probe";
import { askChoice } from "./ui/unsavedDialog";
import {
  GamepadConfig, GamepadAction, GamepadCommand, GamepadContext, BlockReason, ACTIONS, SPEED_LEVELS, DEFAULT_LEVEL, TICK_MS, STEP_S, MAX_INFLIGHT,
  normalizeConfig, stickValue, updateArmed, velocity, limitToMachine, lookahead, planStep, blockReason, isDriving, canStartDrive, resolveAction,
} from "./gamepadLogic";

const KEY = "cnc_craft_gamepad";

/** Zustand eines Gamepads, egal aus welcher Quelle */
interface PadState { key: string; id: string; standard: boolean; buttons: boolean[]; axes: number[] }

/** Was die Anzeige wissen muss */
export interface GamepadView {
  api: boolean;                // kennt das Fenster die Gamepad-Schnittstelle?
  pad: PadState | null;
  reason: BlockReason | null;  // warum gerade nichts fahren darf
  deadman: boolean;
  driving: boolean;
  level: number;
}

let log: (s: string) => void = () => {};
let cfg: GamepadConfig = normalizeConfig(null);
let listener: ((v: GamepadView) => void) | null = null;
let wanted: () => boolean = () => false;   // Anzeige offen? Dann auch bei „aus“ lesen

let level = DEFAULT_LEVEL;
let prevButtons: boolean[] | null = null;  // für „gerade gedrückt“; null = noch kein Stand bekannt
let armed = [false, false, false];
let confirming = false;
let lastPadKey = "";

// laufende Fahrt
let driving = false;
let generation = 0;     // Antworten auf Schritte einer beendeten Fahrt zählen nicht mehr
let jogEnd: number[] = [0, 0, 0];
let queuedUntil = 0;    // bis wann die geschickten Schritte reichen
let inflight = 0;
let edgeSeen = new Set<number>();
let cancelAt = -Infinity;
let cancelRetries = 0;
let lastRetry = 0;

export function gamepadConfig(): GamepadConfig { return cfg; }

export function setGamepadConfig(next: GamepadConfig) {
  cfg = normalizeConfig(next);
  try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* egal */ }
  if (!cfg.enabled) stopDrive();
}

/** Anzeige anmelden. isOpen: soll auch bei ausgeschaltetem Gamepad gelesen werden (für die Live-Anzeige)? */
export function setGamepadListener(fn: (v: GamepadView) => void, isOpen: () => boolean) { listener = fn; wanted = isOpen; }

const IN_TAURI = "__TAURI_INTERNALS__" in window;
/** Ältere Antworten von Rust gelten nicht mehr: Hängt etwas, zählt das wie „Gamepad weg“ und die Fahrt stoppt */
const RUST_MAX_AGE_MS = 300;
let rustPad: PadState | null = null;
let rustAt = -Infinity;
let rustBusy = false;

/** Rust fragen (nie zwei Anfragen gleichzeitig); die Antwort gilt beim nächsten Lesen */
function pollRust() {
  if (!IN_TAURI || rustBusy) return;
  rustBusy = true;
  invoke<PadState | null>("gamepad_read")
    .then(p => { rustPad = p; rustAt = performance.now(); })
    .catch(() => { rustPad = null; })
    .finally(() => { rustBusy = false; });
}

function readPad(now: number): PadState | null {
  pollRust();
  if (rustPad && now - rustAt <= RUST_MAX_AGE_MS) return rustPad;
  try {
    for (const p of navigator.getGamepads?.() ?? []) {
      if (p && p.connected) return { key: `web:${p.index}`, id: p.id, standard: p.mapping === "standard", buttons: Array.from(p.buttons, b => b.pressed), axes: Array.from(p.axes) };
    }
  } catch { /* Schnittstelle gesperrt */ }
  return null;
}

/** Ist gerade ein Fenster offen? (Das versteckte im DOM zählt nicht.) */
function dialogOpen(): boolean {
  if (confirming) return true;
  for (const el of Array.from(document.querySelectorAll(".dlg-overlay"))) if (el.getClientRects().length) return true;
  return false;
}

function context(): GamepadContext {
  return {
    connected: machine.connected,
    protocol: machine.protocol,
    state: machine.status.state,
    jobActive: machine.job.active || streamState.isRunning,
    jobPaused: machine.job.active ? machine.job.paused : streamState.isPaused,
    jobLoaded: streamState.loadedLines.length > 0,
    busy: toolChangeBusy() || probeRunning(),
    dialog: dialogOpen(),
    focused: document.hasFocus() && !document.hidden,
  };
}

/** Fahrt sofort beenden. Tut nichts, wenn das Gamepad gerade nicht fährt. */
function stopDrive() {
  if (!driving) return;
  driving = false;
  generation++;
  inflight = 0;
  cancelAt = performance.now();
  cancelRetries = 0;
  sendCancel();
}

function sendCancel() {
  lastRetry = performance.now();
  realtime(RT.jogCancel).catch(() => undefined); // Verbindung weg: die Warteschlange läuft von selbst leer
}

/**
 * Ein Schritt, der schon unterwegs war, kann NACH dem 0x85 ankommen und würde dann noch ausgeführt.
 * Deshalb: meldet die Maschine kurz danach weiter „Jog“, den Abbruch wiederholen (höchstens 5-mal).
 */
function retryCancel(now: number) {
  if (driving || cancelRetries >= 5 || cancelAt < 0 || now - lastRetry < 200) return;
  if (machine.connected && machine.status.state === "Jog") { cancelRetries++; sendCancel(); }
  else if (now - cancelAt > 1000) cancelRetries = 5;
}

const setting = (key: string): number | undefined => {
  const v = parseFloat(machine.settings.get(key) ?? "");
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

function drive(stick: number[], now: number) {
  if (!driving) {
    if (!canStartDrive(machine.status.state, now, cancelAt)) return;
    driving = true;
    jogEnd = machine.status.wpos.slice(0, 3);
    queuedUntil = now;
    edgeSeen = new Set();
    cancelRetries = 5;
  }
  const v = limitToMachine(velocity(stick, cfg, level), [setting("$110"), setting("$111"), setting("$112")]);
  const feed = Math.hypot(v[0], v[1], v[2]);
  const moving = [0, 1, 2].filter(i => v[i]);
  const accels = moving.map(i => setting("$12" + i));
  const accel = accels.every(a => a) ? Math.min(...(accels as number[])) : undefined;
  const ahead = lookahead(feed, accel) * 1000;

  // höchstens 3 Schritte je Durchgang, damit nach einer Pause des Fensters nichts auf einmal losgeschickt wird
  for (let n = 0; n < 3 && queuedUntil - now < ahead && inflight < MAX_INFLIGHT; n++) {
    const bed = bedSizeMm();
    const step = planStep(v, jogEnd, bed);
    for (const i of step.clamped) {
      if (edgeSeen.has(i)) continue;
      edgeSeen.add(i);
      log(t(step.delta[i] ? "jog.toEdge" : "jog.atEdge", { axis: "XYZ"[i], b: i ? bed.h : bed.w }));
    }
    if (!step.line) return; // am Bettrand: nichts schicken, Fahrt bleibt „an“, bis der Stick zurückgeht
    jogEnd = step.end;
    queuedUntil = Math.max(queuedUntil, now) + STEP_S * 1000;
    inflight++;
    const gen = generation;
    sendAndWait(step.line, 3000, true).then(ack => {
      if (gen !== generation) return;
      inflight--;
      if (!ack.ok) {
        // Fehler (z. B. Softlimit) oder keine Antwort: anhalten, Stick muss erst zurück in die Mitte
        stopDrive();
        armed = [false, false, false];
        log(t("gp.jogFailed"));
      }
    });
  }
}

function run(cmd: GamepadCommand) {
  const guard = (p: Promise<unknown>) => p.catch(e => log(`${t("log.error")} ${e}`));
  switch (cmd) {
    case "speedUp": case "speedDown":
      level = Math.min(SPEED_LEVELS.length - 1, Math.max(0, level + (cmd === "speedUp" ? 1 : -1)));
      log(t("gp.speedLog", { p: SPEED_LEVELS[level] * 100, f: Math.round(SPEED_LEVELS[level] * cfg.maxFeed) }));
      break;
    case "hold": stopNow(); break;
    case "pause": case "resume":
      if (machine.job.active || streamState.isRunning) void pauseStreaming(log);
      else guard(realtime(RT.resume));
      break;
    case "start": void confirmStart(); break;
    case "home": guard(send("$H")); break;
    case "zeroXY": guard(send("G10 L20 P1 X0 Y0")); break;
    case "zeroZ": guard(send("G10 L20 P1 Z0")); break;
  }
}

/** Stopp-Knopf: was gerade fährt, hält an – egal woher die Fahrt kommt */
function stopNow() {
  stopDrive();
  armed = [false, false, false];
  const guard = (p: Promise<unknown>) => p.catch(e => log(`${t("log.error")} ${e}`));
  if (toolChangeBusy()) { tcAbort(t("tc.why.user"), false); return; }
  if (probeRunning()) { abortProbe(true); return; }
  if (machine.job.active || streamState.isRunning) {
    if (!(machine.job.active ? machine.job.paused : streamState.isPaused)) void pauseStreaming(log);
    return;
  }
  if (machine.status.state === "Jog") guard(realtime(RT.jogCancel));
  else if (machine.status.state === "Run") guard(realtime(RT.hold));
}

/** Job-Start nur nach Bestätigung auf dem Bildschirm (mit Maus oder Tastatur, nicht mit dem Gamepad) */
async function confirmStart() {
  if (confirming) return;
  confirming = true;
  const id = activeMachineId();
  let answer: "start" | "cancel" = "cancel";
  try {
    answer = await askChoice(t("gp.startTitle"), t("gp.startText", { n: streamState.loadedLines.length }), [
      { key: "cancel", label: t("dlg.cancel"), cancel: true },
      { key: "start", label: t("rp.start"), primary: true },
    ]);
  } finally { confirming = false; }
  if (answer !== "start") return;
  // Während das Fenster offen war, kann sich alles geändert haben
  if (id !== activeMachineId() || resolveAction("startPause", context(), true) !== "start") { log(t("gp.startGone")); return; }
  void startStreaming(() => machine.connected, log);
}

function tick() {
  const now = performance.now();
  if (!cfg.enabled && !wanted()) { prevButtons = null; retryCancel(now); return; }
  const pad = readPad(now);
  const api = IN_TAURI || typeof navigator.getGamepads === "function";
  const c = context();
  const reason = blockReason(c);

  if (!pad) {
    stopDrive();
    prevButtons = null;
    armed = [false, false, false];
    retryCancel(now);
    listener?.({ api, pad: null, reason, deadman: false, driving: false, level });
    return;
  }

  // anderes Gamepad oder andere Quelle: nichts vom alten Stand übernehmen (sonst falsche „gerade gedrückt“)
  if (pad.key !== lastPadKey) { lastPadKey = pad.key; stopDrive(); prevButtons = null; armed = [false, false, false]; }
  const buttons = pad.buttons;
  const held = (i: number) => i >= 0 && buttons[i] === true;
  const deadman = cfg.enabled && held(cfg.deadman);

  if (cfg.enabled) {
    // Knöpfe: nur beim Herunterdrücken. Beim ersten Lesen zählt ein schon gedrückter Knopf nicht.
    if (prevButtons) {
      for (const a of ACTIONS as readonly GamepadAction[]) {
        const b = cfg.buttons[a];
        if (b < 0 || !buttons[b] || prevButtons[b]) continue;
        const cmd = resolveAction(a, c, deadman);
        if (cmd) run(cmd);
      }
    }

    // Sticks: Y und Z nach oben = plus (die Schnittstelle meldet oben als -1)
    const zBtn = (held(cfg.buttons.zUp) ? 1 : 0) - (held(cfg.buttons.zDown) ? 1 : 0);
    const raw = [pad.axes[0] ?? 0, -(pad.axes[1] ?? 0), -(pad.axes[3] ?? 0)];
    const values = raw.map(v => stickValue(v, cfg.deadzone));
    if (zBtn) values[2] = zBtn;
    armed = updateArmed(armed, values, deadman);
    const stick = values.map((v, i) => (armed[i] ? v : 0));

    // context() neu: der Knopf eben kann den Zustand geändert haben (z. B. Fenster geöffnet, Stopp)
    if (isDriving(context(), deadman, stick)) drive(stick, now);
    else stopDrive();
  } else {
    stopDrive();
  }
  retryCancel(now);
  prevButtons = buttons;
  listener?.({ api, reason, deadman, driving, level, pad });
}

export function initGamepad(logFn: (s: string) => void) {
  log = logFn;
  try { cfg = normalizeConfig(JSON.parse(localStorage.getItem(KEY) || "null")); } catch { cfg = normalizeConfig(null); }

  const stopAndDisarm = () => { stopDrive(); armed = [false, false, false]; prevButtons = null; };
  window.addEventListener("blur", stopAndDisarm);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopAndDisarm(); });
  window.addEventListener("pagehide", stopAndDisarm);
  window.addEventListener("gamepaddisconnected", stopAndDisarm);
  window.addEventListener(MACHINE_EVENT, e => {
    const type = (e as CustomEvent).detail?.type;
    if (type === "disconnected" || type === "alarm" || type === "job-error") stopAndDisarm();
    else if (type === "job-progress" && machine.job.active) stopDrive();
  });
  // Abbruch muss noch an die bisherige Maschine gehen
  setBeforeSwitch(async () => {
    const was = driving;
    driving = false;
    generation++;
    inflight = 0;
    armed = [false, false, false];
    if (was) { cancelAt = performance.now(); cancelRetries = 5; await realtime(RT.jogCancel).catch(() => undefined); }
  });
  window.setInterval(tick, TICK_MS);
}
