/**
 * Makro ausführen: Zeile für Zeile, jede wartet auf die Antwort der Steuerung; beim ersten Fehler ist Schluss.
 * Abbrechen: Vorschub-Halt, dann Reset (wie beim Trennen während eines Jobs).
 */
import { t } from "./i18n/i18n";
import { machine, RT, sendAndWait, realtime, activeMachineId } from "./machine";
import { macroLines, type Macro } from "./macros";
import { noteManualLine } from "./wcsSync";

const LINE_TIMEOUT = 120000; // $H und lange Fahrten antworten spät

let running: string | null = null;
let cancelled = false;

export function macroRunning(): boolean { return running !== null; }
export function runningMacroId(): string | null { return running; }

export async function runMacro(m: Macro, log: (s: string) => void, changed: () => void): Promise<void> {
  if (running) return;
  const lines = macroLines(m.gcode);
  const conn = activeMachineId();
  running = m.id;
  cancelled = false;
  changed();
  log(t("macro.start", { name: m.name, n: lines.length }));
  let done = 0;
  try {
    for (const line of lines) {
      if (cancelled) return;
      if (!machine.connected || activeMachineId() !== conn || machine.job.active || machine.status.state === "Alarm") {
        log(t("macro.stopped", { n: done, total: lines.length }));
        return;
      }
      noteManualLine(line);
      const a = await sendAndWait(line, LINE_TIMEOUT);
      if (cancelled) return;
      if (!a.ok) { log(t("macro.stopped", { n: done, total: lines.length })); return; }
      done++;
    }
    log(t("macro.done", { name: m.name }));
  } catch (e) {
    log(`${t("log.error")} ${e}`);
  } finally {
    running = null;
    changed();
  }
}

/** Laufendes Makro abbrechen: was schon im Puffer der Steuerung liegt, wird mit angehalten */
export async function cancelMacro(log: (s: string) => void): Promise<void> {
  if (!running || cancelled) return;
  cancelled = true;
  log(t("macro.cancelled"));
  if (machine.protocol !== "grbl") return;
  try {
    await realtime(RT.hold);
    await new Promise(r => setTimeout(r, 150));
    await realtime(RT.reset);
  } catch { /* Verbindung weg: die Maschine hält von selbst */ }
}
