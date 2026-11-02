/**
 * PROJEKT NICHT VERLIEREN
 *
 *  - Fenstertitel zeigt "● " vor dem Namen, solange es ungespeicherte Änderungen gibt
 *  - Fenster schließen (roter Knopf, Cmd+W, Cmd+Q, Alt+F4): bei Änderungen fragen
 *    "Speichern / Nicht speichern / Abbrechen". Den laufenden Job hält Rust danach sicher an
 *    (lib.rs: close_all bei WindowEvent::Destroyed)
 *  - Automatische Sicherung: alle 90 s (nur wenn sich seitdem etwas geändert hat) in den App-Datenordner
 *    (store.rs, recovery.json). Bei normalem Schließen/Speichern wird sie gelöscht – liegt sie beim Start
 *    noch da, ist das Programm abgestürzt -> "Wiederherstellen?"
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t, currentLanguage } from "./i18n/i18n";
import { isDirty, changeCount, onDirtyChange, markClean, clearRecovery } from "./editor/projectDirty";
import { guardUnsaved, projectName, recoveryText, restoreRecovered } from "./importers/importManager";
import { askChoice } from "./ui/unsavedDialog";
import { flushSettings } from "./settingsStore";

const AUTOSAVE_MS = 90_000;

let baseTitle = "CNC Craft";
let savedSeq = -1;   // Stand der letzten automatischen Sicherung
let writing = false;

function updateTitle() {
  const name = projectName();
  const title = !name && !isDirty() ? baseTitle : `${isDirty() ? "● " : ""}${name || t("proj.untitled")} – ${baseTitle}`;
  void getCurrentWindow().setTitle(title).catch(() => {});
}

async function autosave() {
  if (writing || !isDirty() || changeCount() === savedSeq) return;
  writing = true;
  const seq = changeCount();
  try {
    await invoke("recovery_write", { data: recoveryText() });
    savedSeq = seq;
  } catch (e) {
    console.warn("[Recovery]", e);
  } finally {
    writing = false;
  }
}

async function offerRestore(log: (s: string) => void) {
  let rec: { data: string; saved: number } | null = null;
  try { rec = await invoke("recovery_read"); } catch { return; }
  if (!rec) return;
  const when = new Date(rec.saved * 1000).toLocaleString(currentLanguage());
  const r = await askChoice(t("recover.title"), t("recover.text", { time: when }), [
    { key: "discard", label: t("recover.discard"), cancel: true },
    { key: "restore", label: t("recover.restore"), primary: true }
  ]);
  if (r === "restore") {
    await restoreRecovered(rec.data);
    log(t("recover.done"));
  } else {
    await clearRecovery();
  }
}

export async function initProjectSafety(log: (s: string) => void) {
  const win = getCurrentWindow();
  try { baseTitle = (await win.title()) || baseTitle; } catch { /* Standardtitel */ }
  onDirtyChange(updateTitle);
  updateTitle();

  let closing = false;
  await win.onCloseRequested(async e => {
    e.preventDefault(); // selbst schließen (nach der Frage) – sonst schließt Tauri sofort
    if (closing) return;
    closing = true;
    let go = true;
    try {
      go = await guardUnsaved(); // Abbrechen (oder Speichern abgebrochen): Programm bleibt offen
      if (go) {
        markClean();
        await clearRecovery();
        await flushSettings().catch(() => {});
      }
    } catch (err) {
      console.error(err); // im Zweifel trotzdem schließen – nie ein Fenster, das nicht zugeht
      go = true;
    } finally {
      closing = false;
    }
    if (go) await win.destroy();
  });

  window.setInterval(() => { void autosave(); }, AUTOSAVE_MS);
  await offerRestore(log);
}
