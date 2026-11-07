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

type Log = (s: string) => void;

/** Zeilen des Jobs und G-Code, aus dem er gebaut wurde. Job aus einer Datei oder von Hand geändert: kein Vergleich */
let builtLines: string[] | null = null;
let builtGcode: string | null = null;
let builtPrint: string | null = null;
let building = false;

/**
 * Fingerabdruck von allem, was den G-Code beeinflusst: Zeichnung, gespeicherte Einstellungen, Felder rechts.
 * Gleich = kein neues Berechnen nötig. Anders heißt noch nicht geändert: Dann entscheidet der echte Vergleich.
 */
function fingerprint(shapes: any): string {
  const stored: string[] = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i) || ""; if (k.startsWith("cnc_craft_")) stored.push(k + "=" + localStorage.getItem(k)); } } catch { /* egal */ }
  const fields = Array.from(document.querySelectorAll<HTMLInputElement>("#dynamic-right-panel input, #dynamic-right-panel select")).map(e => e.type === "checkbox" || e.type === "radio" ? e.checked : e.value);
  return JSON.stringify([shapes, stored.sort(), fields]);
}

window.addEventListener("cnc-job-loaded", () => {
  if (!building) { builtLines = null; builtGcode = null; builtPrint = null; }
});

/** Zeichnung als Job bereitlegen. true = Job liegt bereit */
export function buildJob(shapes: any, log: Log): boolean {
  const gcode = generateGcode(shapes);
  if (!gcode) { log(noGcodeMessage()); return false; }
  lastGcodeWarnings.forEach(w => log(`${t("log.warning")} ${w}`));
  lastGcodeNotes.forEach(n => log(n));
  building = true;
  const ok = loadGcodeFromText(gcode, t("sim.currentDesign"), log);
  building = false;
  if (ok) { builtLines = streamState.loadedLines; builtGcode = gcode; builtPrint = fingerprint(shapes); }
  return ok;
}

/**
 * Vor dem Start: Passt der Job noch zur Zeichnung? Sonst fragen.
 * false = nicht starten. Neu erstellen startet ebenfalls nicht: den neuen Job soll man sich erst ansehen.
 */
export async function okToStart(shapes: any, log: Log, onRebuilt: () => void): Promise<boolean> {
  if (streamState.isRunning || !builtGcode || streamState.loadedLines !== builtLines) return true;
  if (fingerprint(shapes) === builtPrint || generateGcode(shapes) === builtGcode) return true;
  const r = await askChoice(t("job.staleTitle"), t("job.staleText"), [
    { key: "old", label: t("job.staleOld") },
    { key: "cancel", label: t("dlg.cancel"), cancel: true },
    { key: "rebuild", label: t("job.staleRebuild"), primary: true }
  ]);
  if (r === "rebuild" && buildJob(shapes, log)) onRebuilt();
  return r === "old";
}
