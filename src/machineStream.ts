/**
 * JOB: G-Code laden, starten, pausieren, stoppen
 *
 * Mit Maschine:  der Rust-Teil sendet den Job (Puffer-Zählung, Werkzeugwechsel, Fehler-Pause),
 *                hier werden nur seine Fortschritts-Ereignisse angezeigt (siehe machine.ts).
 * Ohne Maschine: Demo-Ablauf – die Zeilen werden nur "abgehakt" (für Simulation und Tests).
 *
 * Ereignisse für andere Teile:
 *   "cnc-job-loaded"   – neuer Job (Simulation zeigt ihn an)
 *   "cnc-job-progress" – Fortschritt (Simulation läuft live mit)
 *   "cnc-job-done"     – Job fertig/abgebrochen (Material-Platte wird markiert)
 */
import { aAxisRefused } from "./rotary";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { t } from "./i18n/i18n";
import { machine, MACHINE_EVENT, jobStart, jobPause, jobResume, jobStop } from "./machine";
import { getMachineMode, MachineMode } from "./machineMode";
import { stockBed } from "./stock";
import { compensate, getHeightMap, heightMapEnabled, heightRange } from "./heightMap";
import { buildResume, resumeMarks, ResumeMark } from "./jobResume";

// Zustand des aktuellen Jobs
export const streamState = {
  isRunning: false,
  isPaused: false,
  shouldStop: false,
  currentLine: 0,
  totalLines: 0,
  loadedLines: [] as string[],
  label: "",                // Name des Jobs (Dateiname oder "aktuelle Zeichnung")
  bed: 0,                   // Bett, dessen Material-Platte der Job verbraucht
  onMachine: false,         // läuft gerade an der echten Maschine?
  sentOrigin: null as number[] | null, // je gesendeter Zeile die Original-Zeile (Höhenkarte, Fortsetzen; sonst 1:1)
  marks: [] as ResumeMark[],  // Formen/Ebenen im Job (zum Fortsetzen)
  abortLine: -1               // nach einem Abbruch: so viele Zeilen hatte die Maschine bestätigt (-1 = kein Abbruch)
};

/** gesendete Zeilen (Rust zählt diese) -> fertige Original-Zeilen (= Original-Zeile der nächsten offenen gesendeten Zeile) */
function origDone(acked: number, st: typeof streamState = streamState): number {
  const o = st.sentOrigin;
  if (!o) return acked;
  return acked >= o.length ? st.totalLines : o[Math.max(0, acked)];
}

let logFn: (s: string) => void = () => {};

/**
 * Öffnet eine G-Code-Datei und legt sie im Stream-Speicher bereit.
 */
export async function loadGcodeFromFile(appendToConsole: (t: string) => void): Promise<boolean> {
  try {
    const selectedFile = await open({
      multiple: false,
      directory: false,
      title: t("stream.dlgTitle"),
      filters: [{ name: t("stream.dlgFilter"), extensions: ["gcode", "nc", "tap", "txt", "ngc", "gc"] }]
    });
    if (!selectedFile) return false;
    appendToConsole(t("stream.reading"));
    const filePath = typeof selectedFile === "object" && selectedFile !== null ? (selectedFile as any).path : selectedFile;
    const content = await readTextFile(filePath);
    return loadGcodeFromText(content, String(filePath).split(/[\\/]/).pop() || "G-Code", appendToConsole);
  } catch (err) {
    appendToConsole(t("stream.loadError", { e: String(err) }));
    return false;
  }
}

/**
 * G-Code-Text als Job bereitlegen (aus Datei oder direkt aus der Zeichnung / Simulation).
 */
export function loadGcodeFromText(content: string, label: string, appendToConsole: (t: string) => void): boolean {
  if (streamState.isRunning) { appendToConsole(t("stream.alreadyRunning")); return false; }
  // Leerzeilen und reine Kommentarzeilen raus (Werkzeugwechsel "M0 (…)" bleibt drin)
  streamState.loadedLines = content
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("(") && !l.startsWith("%") && !l.startsWith(";"));
  streamState.totalLines = streamState.loadedLines.length;
  streamState.currentLine = 0;
  streamState.sentOrigin = null;
  streamState.marks = resumeMarks(content).filter(m => m.line < streamState.totalLines);
  streamState.abortLine = -1;
  streamState.label = label;
  streamState.bed = stockBed();
  appendToConsole(t("stream.loaded", { n: streamState.totalLines }));
  updateJobDisplay();
  window.dispatchEvent(new CustomEvent("cnc-job-loaded", { detail: { lines: streamState.loadedLines, label } }));
  return true;
}

function emitProgress() {
  window.dispatchEvent(new CustomEvent("cnc-job-progress", {
    detail: { line: streamState.currentLine, total: streamState.totalLines, running: streamState.isRunning, paused: streamState.isPaused }
  }));
  updateJobDisplay();
}

function emitDone(aborted: boolean, simulated: boolean, s: typeof streamState = streamState, mode: MachineMode = getMachineMode()) {
  s.abortLine = aborted ? s.currentLine : -1;
  window.dispatchEvent(new CustomEvent("cnc-job-done", {
    detail: {
      aborted, line: s.currentLine, lines: s.loadedLines,
      label: s.label, simulated, mode, bed: s.bed
    }
  }));
}

// Mehrere Maschinen: Job-Zustand je Maschine (die ausgewählte steht in streamState)
const parked = new Map<string, typeof streamState>();

/** Ereignisse der echten Maschine an den Job-Zustand anbinden (einmal beim Start) */
export function initStreamEvents(appendToConsole: (t: string) => void) {
  logFn = appendToConsole;
  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    const { type, data } = (e as CustomEvent).detail || {};
    if (type === "switched") {
      // Job-Zustand der alten Maschine wegpacken, den der neuen holen
      if (data.from) parked.set(data.from, { ...streamState });
      const next = parked.get(data.id);
      parked.delete(data.id);
      if (next) Object.assign(streamState, next);
      else Object.assign(streamState, { isRunning: false, isPaused: false, shouldStop: false, currentLine: 0, onMachine: false });
      if (streamState.onMachine && machine.job.active) streamState.currentLine = origDone(machine.job.acked);
      if (streamState.onMachine && !machine.job.active) { streamState.isRunning = false; streamState.onMachine = false; }
      emitProgress();
      return;
    }
    if (type === "bg-job-done") {
      // Job einer Maschine im Hintergrund ist fertig: Platte für DEREN Maschinenart markieren
      const s = parked.get(data.conn);
      if (!s || !s.onMachine) return;
      s.currentLine = data.data?.aborted ? origDone(data.data.acked ?? 0, s) : s.totalLines;
      s.isRunning = false; s.isPaused = false; s.onMachine = false;
      emitDone(!!data.data?.aborted, false, s, data.mode || getMachineMode());
      if (data.gone) parked.delete(data.conn);
      return;
    }
    if (!streamState.onMachine) return;
    if (type === "job-progress") {
      streamState.currentLine = origDone(data.acked);
      streamState.isPaused = !!data.paused;
      emitProgress();
    } else if (type === "job-done") {
      streamState.currentLine = data.aborted ? origDone(data.acked) : streamState.totalLines;
      streamState.isRunning = false;
      streamState.isPaused = false;
      streamState.onMachine = false;
      emitProgress();
      emitDone(!!data.aborted, false);
    } else if (type === "disconnected") {
      streamState.isRunning = false;
      streamState.isPaused = false;
      streamState.onMachine = false;
      emitProgress();
      emitDone(true, false);
    }
  });
}

/**
 * Startet den Job: an der Maschine (wenn verbunden) oder als Demo.
 */
export async function startStreaming(_isConnected: () => boolean, appendToConsole: (t: string) => void, resumeFrom = -1) {
  logFn = appendToConsole;
  if (streamState.isRunning) { appendToConsole(t("stream.alreadyRunning")); return; }
  if (streamState.loadedLines.length === 0) { appendToConsole(t("stream.noGcode")); return; }

  // Fertiger Job wird von vorne gestartet
  if (streamState.currentLine >= streamState.totalLines) streamState.currentLine = 0;

  // Fortsetzen: Vorspann (Zustand herstellen) + Job ab der Zeile; jede Zeile merkt sich ihre Original-Nummer
  let base = streamState.loadedLines;
  let baseOrigin: number[] | null = null;
  if (resumeFrom > 0) {
    try {
      const plan = buildResume(streamState.loadedLines, resumeFrom, getMachineMode());
      base = [...plan.pre, ...plan.rest];
      baseOrigin = [...plan.pre.map(() => resumeFrom), ...plan.rest.map((_, i) => resumeFrom + i)];
      appendToConsole(t("res.started", { n: resumeFrom + 1, pre: plan.pre.length }));
    } catch (e) {
      appendToConsole(t("res.refused", { e: (e as Error).message || String(e) }));
      return;
    }
  }

  if (machine.connected) {
    if (machine.status.state === "Alarm") { appendToConsole(t("m.unlockFirst")); return; }
    const refused = aAxisRefused(streamState.loadedLines);
    if (refused) { appendToConsole(refused); return; }
    // Höhenkarte: Z an die gemessene Oberfläche anpassen (nur Fräse mit GRBL)
    let send = base;
    streamState.sentOrigin = baseOrigin;
    const hm = getHeightMap();
    if (heightMapEnabled() && hm && getMachineMode() === "mill" && machine.protocol === "grbl") {
      try {
        const c = compensate(base, hm);
        send = c.lines;
        streamState.sentOrigin = baseOrigin ? c.origin.map(i => baseOrigin![i]) : c.origin;
        const r = heightRange(hm);
        appendToConsole(t("hm.applied", { min: r.min.toFixed(2), max: r.max.toFixed(2), n: c.lines.length }));
        if (c.outside) appendToConsole(t("hm.outside", { n: c.outside }));
      } catch (e) {
        appendToConsole(t("hm.refused", { e: (e as Error).message || String(e) }));
        return;
      }
    }
    try {
      streamState.currentLine = Math.max(0, resumeFrom);
      streamState.isRunning = true;
      streamState.isPaused = false;
      streamState.onMachine = true;
      const n = await jobStart(send);
      appendToConsole(t("m.jobStarted", { n }));
      emitProgress();
    } catch (e) {
      streamState.isRunning = false;
      streamState.onMachine = false;
      appendToConsole(t("m.jobStartFailed", { e: t("m.why." + String(e)) !== "m.why." + String(e) ? t("m.why." + String(e)) : String(e) }));
      emitProgress();
    }
    return;
  }

  // ---- DEMO ohne Maschine ----
  appendToConsole(t("stream.simulated"));
  if (resumeFrom > 0) streamState.currentLine = resumeFrom;
  streamState.isRunning = true;
  streamState.shouldStop = false;
  emitProgress();
  appendToConsole(t("stream.started"));
  while (streamState.currentLine < streamState.totalLines && !streamState.shouldStop) {
    while (streamState.isPaused && !streamState.shouldStop) await sleep(200);
    if (streamState.shouldStop) break;
    const line = streamState.loadedLines[streamState.currentLine];
    const code = line.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").trim().toUpperCase();
    streamState.currentLine++;
    if (/^M0?[01]$/.test(code)) {
      // Werkzeugwechsel auch im Demo zeigen
      streamState.isPaused = true;
      appendToConsole(t("stream.toolChange", { note: (line.match(/\(([^)]*)\)/) || [])[1] || "" }));
    }
    emitProgress();
    await sleep(30);
  }
  appendToConsole(streamState.shouldStop ? t("stream.aborted") : t("stream.finished"));
  const aborted = streamState.shouldStop;
  streamState.isRunning = false;
  streamState.isPaused = false;
  emitProgress();
  emitDone(aborted, true);
}

export async function pauseStreaming(appendToConsole: (t: string) => void) {
  if (!streamState.isRunning) return;
  if (streamState.onMachine) {
    try {
      if (machine.job.paused) { await jobResume(); appendToConsole(t("stream.resumed")); }
      else { await jobPause(); appendToConsole(t("stream.paused")); }
    } catch (e) { appendToConsole(`${t("log.error")} ${e}`); }
    return;
  }
  streamState.isPaused = !streamState.isPaused;
  appendToConsole(streamState.isPaused ? t("stream.paused") : t("stream.resumed"));
  emitProgress();
}

export async function stopStreaming() {
  if (!streamState.isRunning) return;
  if (streamState.onMachine) {
    try { await jobStop(); logFn(t("m.stopping")); } catch (e) { logFn(`${t("log.error")} ${e}`); }
    return;
  }
  streamState.shouldStop = true;
  streamState.isPaused = false;
}

function updateJobDisplay() {
  const prozent = streamState.totalLines > 0 ? Math.round((streamState.currentLine / streamState.totalLines) * 100) : 0;
  const bar = document.getElementById("job-progress-bar");
  const label = document.getElementById("job-progress-label");
  if (bar) (bar as HTMLElement).style.width = `${prozent}%`;
  if (label) {
    label.textContent = streamState.totalLines
      ? `${streamState.currentLine} / ${streamState.totalLines} (${prozent}%)` + (streamState.isPaused ? " · " + t("rp.pause") : "")
      : t("rp.noJob");
  }
  const pauseBtn = document.getElementById("btn-job-pause");
  if (pauseBtn) pauseBtn.classList.toggle("active", streamState.isPaused);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
