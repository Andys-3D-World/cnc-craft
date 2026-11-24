/**
 * RÜCKGÄNGIG / WIEDERHOLEN
 *
 * Nach jeder Benutzer-Aktion (Maus loslassen, Taste loslassen, Feld geändert)
 * wird geprüft, ob sich die Formen geändert haben. Wenn ja, wird der vorherige
 * Stand gespeichert. So funktioniert Rückgängig automatisch für ALLE Funktionen,
 * auch für STL-Import, Innen/Außen usw., ohne dass jede Funktion daran denken muss.
 */
import { app } from "./editorState";
import { markDirty } from "./projectDirty";

const MAX_STEPS = 100;
const MAX_CHARS = 60_000_000; // ca. 120 MB Speicher für die gesamte Historie

/** A step: the drawing before it (undo) or after it (redo). `tag`: the same action also changed other beds/sides */
export interface Step { s: string; tag?: string }

let committed: string | null = null;
const undoStack: Step[] = [];
const redoStack: Step[] = [];

/** Beds (beds.ts): take the other beds' part of a tagged step back / do it again */
let tagHook: ((tag: string, dir: "undo" | "redo") => void) | null = null;
export function setTagHook(f: (tag: string, dir: "undo" | "redo") => void) { tagHook = f; }

/** Linked copies (editor/linked.ts): sync after a user action (true = shapes changed), refresh after undo/redo */
let linkSync: ((before: string) => boolean) | null = null;
let linkRefresh: (() => boolean) | null = null;
export function setLinkHooks(sync: (before: string) => boolean, refresh: () => boolean) {
  linkSync = sync;
  linkRefresh = refresh;
}

export function initHistory() {
  committed = JSON.stringify(app().shapes);
  const later = () => setTimeout(checkpoint, 0);
  ["mouseup", "keyup", "change", "click"].forEach(ev => window.addEventListener(ev, later, true));
}

/** Aktuellen Stand übernehmen (wird auch automatisch aufgerufen) */
export function checkpoint() {
  const st = app();
  if (!st) return;
  let now = JSON.stringify(st.shapes);
  if (now === committed) return;
  if (committed !== null && linkSync && linkSync(committed)) now = JSON.stringify(st.shapes);
  if (committed !== null) {
    undoStack.push({ s: committed });
    trim();
  }
  redoStack.length = 0;
  committed = now;
  markDirty();
}

/** An action that changed several beds at once: one undo step, without the link sync (the action did that itself) */
export function checkpointTagged(tag: string) {
  const now = JSON.stringify(app().shapes);
  if (committed !== null) { undoStack.push({ s: committed, tag }); trim(); }
  redoStack.length = 0;
  committed = now;
  markDirty();
}

function trim() {
  while (undoStack.length > MAX_STEPS) undoStack.shift();
  let total = undoStack.reduce((n, e) => n + e.s.length, 0);
  while (undoStack.length > 1 && total > MAX_CHARS) total -= undoStack.shift()!.s.length;
}

function restore(snapshot: string) {
  const st = app();
  st.shapes = JSON.parse(snapshot);
  const ids = new Set(st.shapes.map((s: any) => s.id));
  st.selectedShapeIds = st.selectedShapeIds.filter((id: string) => ids.has(id));
  // copies whose original lies on another bed may have to follow it
  if (linkRefresh && linkRefresh()) committed = JSON.stringify(st.shapes);
}

export function undo(): boolean {
  checkpoint();
  if (undoStack.length === 0 || committed === null) return false;
  const step = undoStack.pop()!;
  redoStack.push({ s: committed, tag: step.tag });
  committed = step.s;
  if (step.tag) tagHook?.(step.tag, "undo");
  restore(committed);
  markDirty();
  return true;
}

export function redo(): boolean {
  checkpoint();
  if (redoStack.length === 0 || committed === null) return false;
  const step = redoStack.pop()!;
  undoStack.push({ s: committed, tag: step.tag });
  committed = step.s;
  if (step.tag) tagHook?.(step.tag, "redo");
  restore(committed);
  markDirty();
  return true;
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

/** Verlauf eines Bettes (beim Wechseln mitnehmen, damit Rückgängig nur im eigenen Bett wirkt) */
export interface HistoryState { committed: string | null; undo: Step[]; redo: Step[] }

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
