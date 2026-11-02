/**
 * UNGESPEICHERTE ÄNDERUNGEN
 *
 * Merkt sich, ob das Projekt seit dem letzten Speichern/Öffnen geändert wurde.
 * Gesetzt wird das vom Rückgängig-Verlauf (history.ts) – der sieht jede Änderung an den Formen.
 * Dazu die Sicherungsdatei für "Wiederherstellen nach Absturz" (liegt im App-Datenordner, store.rs).
 */
import { invoke } from "@tauri-apps/api/core";

let dirty = false;
let seq = 0; // zählt jede Änderung (für die automatische Sicherung: "seit dem letzten Mal geändert?")
const listeners: (() => void)[] = [];

export function isDirty() { return dirty; }
export function changeCount() { return seq; }

export function markDirty() {
  seq++;
  if (dirty) return;
  dirty = true;
  listeners.forEach(f => f());
}

/** Nach Speichern oder Öffnen */
export function markClean() {
  dirty = false;
  listeners.forEach(f => f());
}

export function onDirtyChange(f: () => void) { listeners.push(f); }

/** Sicherung löschen (nach Speichern, normalem Schließen oder "Verwerfen") */
export function clearRecovery(): Promise<void> {
  return invoke<void>("recovery_clear").catch(() => {});
}
