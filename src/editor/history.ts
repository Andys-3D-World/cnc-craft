/**
 * RÜCKGÄNGIG / WIEDERHOLEN
 *
 * Nach jeder Benutzer-Aktion (Maus loslassen, Taste loslassen, Feld geändert)
 * wird geprüft, ob sich die Formen geändert haben. Wenn ja, wird der vorherige
 * Stand gespeichert. So funktioniert Rückgängig automatisch für ALLE Funktionen,
 * auch für STL-Import, Innen/Außen usw., ohne dass jede Funktion daran denken muss.
 */
import { app } from "./editorState";

const MAX_STEPS = 100;
const MAX_CHARS = 60_000_000; // ca. 120 MB Speicher für die gesamte Historie

let committed: string | null = null;
const undoStack: string[] = [];
const redoStack: string[] = [];

export function initHistory() {
  committed = JSON.stringify(app().shapes);
  const later = () => setTimeout(checkpoint, 0);
  ["mouseup", "keyup", "change", "click"].forEach(ev => window.addEventListener(ev, later, true));
}

/** Aktuellen Stand übernehmen (wird auch automatisch aufgerufen) */
export function checkpoint() {
  const st = app();
  if (!st) return;
  const now = JSON.stringify(st.shapes);
  if (now === committed) return;
  if (committed !== null) {
    undoStack.push(committed);
    trim();
  }
  redoStack.length = 0;
  committed = now;
}

function trim() {
  while (undoStack.length > MAX_STEPS) undoStack.shift();
  let total = undoStack.reduce((n, s) => n + s.length, 0);
  while (undoStack.length > 1 && total > MAX_CHARS) total -= undoStack.shift()!.length;
}

function restore(snapshot: string) {
  const st = app();
  st.shapes = JSON.parse(snapshot);
  const ids = new Set(st.shapes.map((s: any) => s.id));
  st.selectedShapeIds = st.selectedShapeIds.filter((id: string) => ids.has(id));
}

export function undo(): boolean {
  checkpoint();
  if (undoStack.length === 0 || committed === null) return false;
  redoStack.push(committed);
  committed = undoStack.pop()!;
  restore(committed);
  return true;
}

export function redo(): boolean {
  checkpoint();
  if (redoStack.length === 0 || committed === null) return false;
  undoStack.push(committed);
  committed = redoStack.pop()!;
  restore(committed);
  return true;
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

/** Verlauf eines Bettes (beim Wechseln mitnehmen, damit Rückgängig nur im eigenen Bett wirkt) */
export interface HistoryState { committed: string | null; undo: string[]; redo: string[] }

export function takeHistory(): HistoryState {
  checkpoint();
  return { committed, undo: undoStack.splice(0), redo: redoStack.splice(0) };
}

/** Verlauf übernehmen – ohne (oder wenn er nicht mehr zum Stand passt) neu beginnen */
export function putHistory(h?: HistoryState | null) {
  const now = JSON.stringify(app().shapes);
  undoStack.length = 0; redoStack.length = 0;
  if (h && h.committed === now) { undoStack.push(...h.undo); redoStack.push(...h.redo); }
  committed = now;
}
