/**
 * VOM ENTWURF ZUR MASCHINE
 *
 * „Zur Maschine“ macht aus der Zeichnung den Job und zeigt ihn in der Simulation. Gestartet wird nie von selbst:
 * Start bleibt immer ein eigener Klick. Vor dem Start wird geprüft, ob der Job noch zur Zeichnung passt.
 */
import { generateGcode, lastGcodeWarnings, lastGcodeNotes, noGcodeMessage } from "./cam";
import { loadGcodeFromText, streamState } from "./machineStream";
import { t } from "./i18n/i18n";
import { askChoice } from "./ui/unsavedDialog";
import { lintGcode, type LintKind } from "./gcodeLint";
import { getMachineMode } from "./machineMode";
import { laserSettings } from "./laserLayers";
import { rotary } from "./rotary";
import { activeSetup, twoSidedFingerprint } from "./twoSidedJob";
import { viewSide } from "./editor/beds";
import type { Side } from "./twoSided";

type Log = (s: string) => void;

/** Zeilen des Jobs und G-Code, aus dem er gebaut wurde. Job aus einer Datei oder von Hand geändert: kein Vergleich */
let builtLines: string[] | null = null;
let builtGcode: string | null = null;
let builtPrint: string | null = null;
/** Zweiseitig: für welche Seite der Job gebaut wurde (sonst null) */
let builtSide: Side | null = null;
let building = false;
let lastLog: Log | null = null;

/** Zweiseitig: Seite des geladenen Jobs, wenn er aus der Zeichnung gebaut wurde (sonst null) */
export function loadedJobSide(): Side | null {
  return builtLines && streamState.loadedLines === builtLines ? builtSide : null;
}

/**
 * Fingerabdruck von allem, was den G-Code beeinflusst: Zeichnung, gespeicherte Einstellungen, Felder rechts.
 * Gleich = kein neues Berechnen nötig. Anders heißt noch nicht geändert: Dann entscheidet der echte Vergleich.
 */
function fingerprint(shapes: any): string {
  const stored: string[] = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i) || ""; if (k.startsWith("cnc_craft_")) stored.push(k + "=" + localStorage.getItem(k)); } } catch { /* egal */ }
  const fields = Array.from(document.querySelectorAll<HTMLInputElement>("#dynamic-right-panel input, #dynamic-right-panel select")).map(e => e.type === "checkbox" || e.type === "radio" ? e.checked : e.value);
  // Zweiseitig: Rohteil, Stifte und gezeigte Seite gehören dazu (ohne Zweiseitig ein leerer Text)
  return JSON.stringify([shapes, stored.sort(), fields, twoSidedFingerprint()]);
}

window.addEventListener("cnc-job-loaded", () => {
  if (!building) { builtLines = null; builtGcode = null; builtPrint = null; builtSide = null; }
});

// Zweiseitig: Vorderseite fertig → sagen, was als Nächstes kommt. Mehr passiert nicht: das Programm der Rückseite
// wird erst nach Wenden, Umschalten auf „Rückseite“, „Zur Maschine“ und der Rückfrage geladen – und nie von selbst gestartet
window.addEventListener("cnc-job-done", (e: Event) => {
  const d = (e as CustomEvent).detail || {};
  const two = activeSetup();
  if (!two || d.aborted || builtSide !== "front" || !builtLines || d.lines !== builtLines) return;
  lastLog?.(t("two.frontDone", { turn: t(two.flip === "lr" ? "two.turnLr" : "two.turnFb") }));
});

/** Sicherheitsnetz: fertigen G-Code noch einmal lesen. Nur Hinweis, gestartet wird weiter nur von Hand */
function warnIfSuspicious(gcode: string, log: Log) {
  if (rotary.on) return; // Drehachse: Z und Bahnen bedeuten dort etwas anderes
  const list = lintGcode(gcode, { kind: getMachineMode() as LintKind, sMax: laserSettings.sMax });
  if (list.length) log(t("job.lintWarn", { n: list.length, line: list[0].line, text: list[0].text, rule: list[0].rule }));
}

/** Name des Programms aus der Zeichnung – bei „Zweiseitig fräsen“ mit der gezeigten Seite */
export function designLabel(): string {
  return activeSetup() ? `${t("sim.currentDesign")} – ${t(viewSide() === "front" ? "two.front" : "two.back")}` : t("sim.currentDesign");
}

/** Zeichnung als Job bereitlegen. true = Job liegt bereit */
export function buildJob(shapes: any, log: Log): boolean {
  // Zweiseitig: immer nur das Programm der gezeigten Seite – jede Seite wird für sich gebaut, geprüft und gestartet
  const two = activeSetup(), side = two ? viewSide() : null;
  const gcode = generateGcode(shapes);
  if (!gcode) { log(noGcodeMessage()); return false; }
  lastGcodeWarnings.forEach(w => log(`${t("log.warning")} ${w}`));
  lastGcodeNotes.forEach(n => log(n));
  warnIfSuspicious(gcode, log);
  building = true;
  const ok = loadGcodeFromText(gcode, designLabel(), log);
  building = false;
  if (ok) { builtLines = streamState.loadedLines; builtGcode = gcode; builtPrint = fingerprint(shapes); builtSide = side; }
  lastLog = log;
  if (ok && two && side) log(t(side === "front" ? "two.builtFront" : "two.builtBack", { turn: t(two.flip === "lr" ? "two.turnLr" : "two.turnFb") }));
  return ok;
}

/**
 * Zweiseitig, Rückseite: vor dem Bauen fragen, ob das Rohteil gewendet auf den Stiften liegt. Ohne Ja kein Job.
 * Auch danach startet nichts von selbst – Start bleibt ein eigener Klick.
 */
export async function okToBuild(): Promise<boolean> {
  const two = activeSetup();
  if (!two || viewSide() !== "back") return true;
  const text = [
    t("two.ask.step1"),
    t("two.ask.step2", { turn: t(two.flip === "lr" ? "two.turnLr" : "two.turnFb") }),
    t(two.pinsOn ? "two.ask.step3" : "two.ask.step3NoPins", { n: two.pins.length, d: two.pinDia }),
    t("two.ask.step4"),
    t(two.zRef === "spoil" ? "two.ask.zSpoil" : "two.ask.zTop", { t: two.thickness }),
    "",
    t("two.ask.noStart"),
  ].join("\n");
  const r = await askChoice(t("two.ask.title"), text, [
    { key: "cancel", label: t("dlg.cancel"), cancel: true },
    { key: "ok", label: t("two.ask.ok"), primary: true }
  ]);
  return r === "ok";
}

/**
 * Vor dem Start: Passt der Job noch zur Zeichnung? Sonst fragen.
 * false = nicht starten. Neu erstellen startet ebenfalls nicht: den neuen Job soll man sich erst ansehen.
 */
export async function okToStart(shapes: any, log: Log, onRebuilt: () => void): Promise<boolean> {
  if (streamState.isRunning || !builtGcode || streamState.loadedLines !== builtLines) return true;
  // Zweiseitig: mit der Seite vergleichen, für die gebaut wurde – auch wenn inzwischen die andere gezeigt wird
  if (fingerprint(shapes) === builtPrint || generateGcode(shapes, builtSide ? { side: builtSide } : {}) === builtGcode) return true;
  const r = await askChoice(t("job.staleTitle"), t("job.staleText"), [
    { key: "old", label: t("job.staleOld") },
    { key: "cancel", label: t("dlg.cancel"), cancel: true },
    { key: "rebuild", label: t("job.staleRebuild"), primary: true }
  ]);
  // Neu erstellen baut die gezeigte Seite – bei der Rückseite erst nach der Frage, ob gewendet wurde
  if (r === "rebuild" && (await okToBuild()) && buildJob(shapes, log)) onRebuilt();
  return r === "old";
}
