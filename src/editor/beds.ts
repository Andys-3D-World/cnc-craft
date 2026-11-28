/**
 * MEHRERE BETTEN (wie die Druckplatten im Slicer)
 *
 * Ein Projekt kann mehrere Betten haben, auf der Zeichenfläche ist immer nur EIN Bett zu sehen.
 * Seine Formen liegen wie bisher in app().shapes – Zeichnen, Verschachteln, G-Code und Simulation
 * arbeiten also immer nur mit dem aktiven Bett. Die anderen Betten warten in beds[i].shapes.
 * Beim Wechseln wird getauscht (auch der Rückgängig-Verlauf, damit er nur im eigenen Bett wirkt).
 * „Fertig“ (✓) markiert ein Bett, das schon abgearbeitet ist.
 *
 * Ansicht wie in Bambu Studio / OrcaSlicer: alle Betten liegen im Raster, 3 pro Reihe (ab Bett 4 die nächste Reihe darunter).
 * Das aktive Bett liegt immer im Ursprung der Welt-Koordinaten; die anderen werden blass daneben gezeichnet.
 * Beim Wechseln wird die Ansicht mitgeschoben, damit jedes Bett auf dem Bildschirm an seinem Platz bleibt.
 * Klick auf ein anderes Bett = wechseln; Teile auf ein anderes Bett ziehen = dorthin verschieben.
 *
 * Gespeichert wird im Projekt: shapes = alle Formen hintereinander (ältere Versionen sehen so alles),
 * beds = [{ name, done, n }] – n Formen je Bett in dieser Reihenfolge.
 */
import { app, bedSizeMm, toWorld } from "./editorState";
import { isLight } from "../theme";
import { takeHistory, putHistory, checkpoint, checkpointTagged, setTagHook, type HistoryState } from "./history";
import { solveConstraints } from "./dims";
import { markDirty } from "./projectDirty";
import { t } from "../i18n/i18n";
import { MM_TO_PIXEL, groupBounds, shapeBounds, translateShape, type Bounds } from "../shapeTransform";
import { tracePath } from "../render";
import { updateDimensionInputs } from "../uiInputs";
import { setStockBed, removeStockBed, hasUsedArea, newPlate } from "../stock";
import { cleanSetup, type Side, type TwoSidedSetup } from "../twoSided";
import { checkImport, importInApp } from "../importers/importRust";
import { cleanSplit, type SplitSetup } from "../seamSplit";
import { cleanLinks, refreshLinks, shapeIndex, stripLinks } from "../linkedCopies";

/**
 * Zweiseitig fräsen (twoSided.ts): `shapes` ist immer die Seite, die gerade gezeigt wird, `other` die verdeckte.
 * `back` = gezeigt wird die Rückseite. `two` = Einstellungen (Rohteil, Wenderichtung, Stifte) dieses Bettes.
 */
interface Sheet {
  name: string; done: boolean; shapes: any[]; hist?: HistoryState | null;
  other?: any[]; otherHist?: HistoryState | null; back?: boolean; two?: TwoSidedSetup | null;
  /** Großes Teil teilen (seamSplit.ts): dieses Bett trägt das Original und seine Fugen */
  split?: SplitSetup | null;
  /** … oder es ist ein Stück daraus: `of` = Kennung der Aufteilung, `name` = A1, B1 … */
  piece?: BedPiece | null;
}
export interface BedPiece { of: string; name: string }

let beds: Sheet[] = [{ name: "", done: false, shapes: [] }];
let active = 0;
let redraw = () => {};
let fitAll = () => {};
let log: (s: string) => void = () => {};
let bar: HTMLElement | null = null;
let shown = "";

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function bedName(i = active): string { return beds[i]?.name || t("bed.name", { n: i + 1 }); }
export function bedCount(): number { return beds.length; }
export function activeBed(): number { return active; }

/** Formen des aktiven Bettes zurücklegen (app().shapes wird oft neu zugewiesen) */
function stash() { beds[active].shapes = app().shapes; }

// ---------------------------------------------------------------------
// Linked copies (linkedCopies.ts): the original may lie on another bed or on the other side
// ---------------------------------------------------------------------

/** All shape lists of all beds and sides (the active bed live) */
export function linkLists(): any[][] {
  return beds.flatMap((b, i) => [i === active ? app().shapes : b.shapes, b.other ?? []]);
}

/** All lists except the drawing on screen (originals may lie there) */
export function otherLists(): any[][] {
  return beds.flatMap((b, i) => (i === active ? [b.other ?? []] : [b.shapes, b.other ?? []]));
}

// ---------------------------------------------------------------------
// One action over all beds and sides (re-import a drawing): one undo step everywhere
// ---------------------------------------------------------------------

export interface SheetList { bed: number; hidden: boolean; side: Side | null; shapes: any[] }

/** All shape lists with their place; pieces of a split part are left out (they are made from their original) */
export function sheetLists(): SheetList[] {
  return beds.flatMap((b, i) => {
    if (b.piece) return [];
    const two = b.two?.on === true, shown: Side = b.back ? "back" : "front";
    const list: SheetList[] = [{ bed: i, hidden: false, side: two ? shown : null, shapes: i === active ? app().shapes : b.shapes }];
    if (b.other?.length) list.push({ bed: i, hidden: true, side: shown === "back" ? "front" : "back", shapes: b.other });
    return list;
  });
}

/** Put new lists in place (same order as sheetLists()); changed beds lose their "done" mark */
export function replaceSheets(old: SheetList[], next: any[][], dirty: boolean[]) {
  checkpoint();
  const tag = "t" + Math.random().toString(36).slice(2);
  const st = app();
  old.forEach((l, k) => {
    const b = beds[l.bed];
    const visible = !l.hidden && l.bed === active;
    if (!dirty[k]) { if (visible) checkpointTagged(tag); return; } // Ctrl+Z works here too when only other beds changed
    const step = (h: HistoryState | null | undefined): HistoryState => {
      const was = JSON.stringify(l.shapes);
      const undo = h && h.committed === was ? h.undo : [];
      return { committed: JSON.stringify(next[k]), undo: [...undo, { s: was, tag }], redo: [] };
    };
    b.done = false;
    if (l.hidden) { b.otherHist = step(b.otherHist); b.other = next[k]; return; }
    if (!visible) { b.hist = step(b.hist); b.shapes = next[k]; return; }
    st.shapes = next[k];
    b.shapes = next[k];
    const ids = new Set(next[k].map(s => s.id));
    st.selectedShapeIds = st.selectedShapeIds.filter((id: string) => ids.has(id));
    solveConstraints(); // parts that hang on a dimension follow now, not as a step of their own
    checkpointTagged(tag);
  });
  markDirty();
  changed();
}

/** Undo/redo of such an action: the other beds and sides go along, if they were not changed since */
function moveTagged(tag: string, dir: "undo" | "redo") {
  const stuck: string[] = [];
  const go = (list: any[], h: HistoryState | null | undefined, i: number): any[] | null => {
    if (!h) return null;
    const from = dir === "undo" ? h.undo : h.redo, to = dir === "undo" ? h.redo : h.undo;
    const top = from[from.length - 1];
    if (top?.tag !== tag || h.committed !== JSON.stringify(list)) {
      if (from.some(e => e.tag === tag)) stuck.push(bedName(i));
      return null;
    }
    from.pop();
    to.push({ s: h.committed!, tag });
    h.committed = top.s;
    return JSON.parse(top.s);
  };
  beds.forEach((b, i) => {
    if (i !== active) { const l = go(b.shapes, b.hist, i); if (l) b.shapes = l; }
    const o = go(b.other ?? [], b.otherHist, i);
    if (o) b.other = o;
  });
  if (stuck.length) log(t("reimp.undoStuck", { beds: stuck.join(", ") }));
  shown = "";
}

/**
 * A list comes on screen (bed or side switch): rebuild copies whose original changed meanwhile.
 * If the undo history matched the state before, it is carried along (otherwise it would start anew).
 */
function freshLinks(list: any[], hist?: HistoryState | null) {
  if (!list.some((s: any) => s?.link)) return;
  const was = hist ? JSON.stringify(list) : "";
  if (refreshLinks(list, shapeIndex(linkLists())) && hist && hist.committed === was) hist.committed = JSON.stringify(list);
}

// ---------------------------------------------------------------------
// Zweiseitig fräsen: Vorder- und Rückseite des aktiven Bettes
// ---------------------------------------------------------------------

/** Einstellungen des Bettes (null = nie eingerichtet) */
export function bedSetup(i = active): TwoSidedSetup | null { return beds[i]?.two ?? null; }

/** Zweiseitig ist für das aktive Bett eingeschaltet */
export function twoSidedOn(): boolean { return beds[active]?.two?.on === true; }

/** Welche Seite die Zeichenfläche zeigt (ohne Zweiseitig immer die Vorderseite) */
export function viewSide(): Side { return twoSidedOn() && beds[active].back ? "back" : "front"; }

/** Formen der verdeckten Seite des aktiven Bettes */
export function hiddenShapes(): any[] { return beds[active].other ?? []; }

/** Formen einer Seite des aktiven Bettes */
export function sideShapes(side: Side): any[] { return side === viewSide() ? app().shapes : hiddenShapes(); }

/** Verdeckte Seite ersetzen (Kopieren/Verschieben auf die andere Seite); ihr Rückgängig-Verlauf beginnt neu */
export function setHiddenShapes(list: any[]) {
  beds[active].other = list;
  beds[active].otherHist = null;
  markDirty();
  changed();
}

/** Einstellungen des aktiven Bettes setzen. Wird Zweiseitig ausgeschaltet, zeigt die Zeichenfläche wieder die Vorderseite */
export function setBedSetup(two: TwoSidedSetup | null) {
  if (beds[active].back && !(two && two.on)) showSide("front", true);
  beds[active].two = two;
  markDirty();
  changed();
}

/** Zeichenfläche auf die andere Seite umschalten (wie ein Bett-Wechsel: jede Seite hat ihr eigenes Rückgängig) */
export function showSide(side: Side, force = false) {
  const b = beds[active];
  if (!force && !twoSidedOn()) return;
  if ((side === "back") === !!b.back) return;
  const st = app();
  const hist = takeHistory();
  const visible = st.shapes;
  st.shapes = b.other ?? [];
  b.shapes = st.shapes;
  b.other = visible;
  freshLinks(st.shapes, b.otherHist);
  putHistory(b.otherHist);
  b.otherHist = hist;
  b.back = side === "back";
  st.selectedShapeIds = [];
  changed();
}

// ---------------------------------------------------------------------
// Großes Teil teilen: Original-Bett mit Fugen, je Stück ein eigenes Bett
// ---------------------------------------------------------------------

/** Fugen des Bettes (null = dieses Bett ist kein geteiltes Original) */
export function bedSplit(i = active): SplitSetup | null { return beds[i]?.split ?? null; }

/** Stück-Angabe des Bettes (null = kein Stück) */
export function bedPiece(i = active): BedPiece | null { return beds[i]?.piece ?? null; }

/** Bett, das das Original zu dieser Aufteilung trägt (−1 = gibt es nicht mehr) */
export function splitSource(id: string): number { return beds.findIndex(b => b.split?.id === id); }

/** Betten der Stücke einer Aufteilung */
export function pieceBeds(id: string): number[] { return beds.map((b, i) => (b.piece?.of === id ? i : -1)).filter(i => i >= 0); }

/** Fugen des aktiven Bettes setzen (null = Aufteilung entfernen; die Stück-Betten bleiben als normale Betten) */
export function setBedSplit(split: SplitSetup | null) {
  const old = beds[active].split;
  beds[active].split = split;
  if (!split && old) for (const b of beds) if (b.piece?.of === old.id) b.piece = null;
  markDirty();
  changed();
}

/**
 * Stücke des aktiven Bettes (Original) auf ihre Betten legen: vorhandene Stück-Betten bekommen die neuen Formen,
 * fehlende kommen dazu, überzählige (Stück gibt es nicht mehr) werden entfernt. Gibt die Anzahl der Betten zurück.
 */
export function applyPieces(id: string, list: { name: string; shapes: any[] }[]): number {
  stash();
  const prefix = beds[active].name ? beds[active].name.slice(0, 30) + " " : "";
  for (const p of list) {
    let b = beds.find(x => x.piece?.of === id && x.piece.name === p.name);
    if (!b) { b = { name: "", done: false, shapes: [] }; beds.push(b); }
    b.name = prefix + p.name;
    b.piece = { of: id, name: p.name };
    stripLinks(p.shapes); // pieces are shapes of their own, not linked copies
    b.shapes = p.shapes;
    b.done = false;
    b.hist = null;
    b.other = undefined; b.otherHist = null; b.back = false; b.two = null;
  }
  const keep = new Set(list.map(p => p.name));
  for (let i = beds.length - 1; i >= 0; i--) {
    const b = beds[i];
    if (b.piece?.of !== id || keep.has(b.piece.name) || i === active) continue;
    removeStockBed(i, beds.length);
    beds.splice(i, 1);
    if (i < active) active--;
  }
  setStockBed(active);
  markDirty();
  changed();
  fitAll();
  return list.length;
}

/** Vorder- und Rückseite eines Bettes (zum Speichern und für das Einrichteblatt) */
function frontBack(i: number): { front: any[]; back: any[] } {
  const b = beds[i], shown = i === active ? app().shapes : b.shapes, other = b.other ?? [];
  return b.back ? { front: other, back: shown } : { front: shown, back: other };
}

/** Teile zählen: eine Gruppe = ein Teil */
function parts(shapes: any[]): number { return new Set(shapes.map(s => s.groupId || s.id)).size; }

function changed() { shown = ""; refreshBeds(); updateDimensionInputs(null); redraw(); }

const PER_ROW = 3;

/** Platz im Raster: Spalte und Reihe (Reihe 0 oben, weitere darunter) */
function slot(i: number) { return { col: i % PER_ROW, row: Math.floor(i / PER_ROW) }; }

/** Abstand von Bett zu Bett (Welt-Pixel): waagrecht und senkrecht (senkrecht etwas mehr – Platz für Name und Lineal) */
function pitch() {
  const b = bedSizeMm();
  return { x: (b.w + Math.max(20, b.w * 0.12)) * MM_TO_PIXEL, y: (b.h + Math.max(30, b.h * 0.18)) * MM_TO_PIXEL };
}

/** Verschiebung von Bett i gegenüber dem aktiven Bett (Welt-Pixel; Welt-Y zeigt nach oben → spätere Reihen negativ) */
function shiftOf(i: number): { x: number; y: number } {
  const p = pitch(), a = slot(active), q = slot(i);
  return { x: (q.col - a.col) * p.x, y: -(q.row - a.row) * p.y };
}

/** Welches Bett liegt an dieser Welt-Stelle? (-1 = keins) */
function bedAt(x: number, y: number): number {
  const b = bedSizeMm(), w = b.w * MM_TO_PIXEL, h = b.h * MM_TO_PIXEL;
  for (let i = 0; i < beds.length; i++) {
    const o = shiftOf(i);
    if (x >= o.x && x <= o.x + w && y >= o.y && y <= o.y + h) return i;
  }
  return -1;
}

/** Rahmen um alle Betten (für „Alles zeigen“) */
export function allBedsBounds(): Bounds {
  const b = bedSizeMm(), w = b.w * MM_TO_PIXEL, h = b.h * MM_TO_PIXEL;
  const r: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i < beds.length; i++) {
    // Original eines geteilten Teils: die anderen Betten sind dort nicht zu sehen (drawOtherBeds)
    if (beds[active].split && i !== active) continue;
    const o = shiftOf(i);
    r.minX = Math.min(r.minX, o.x); r.maxX = Math.max(r.maxX, o.x + w);
    r.minY = Math.min(r.minY, o.y); r.maxY = Math.max(r.maxY, o.y + h);
  }
  return r;
}

export function switchBed(i: number) {
  if (i === active || i < 0 || i >= beds.length) return;
  stash();
  beds[active].hist = takeHistory();
  const st = app();
  const o = shiftOf(i);                 // Bett i bleibt auf dem Bildschirm, wo es war
  st.offsetX += o.x * st.scale;
  st.offsetY -= o.y * st.scale;
  active = i;
  setStockBed(i);
  st.shapes = beds[i].shapes;
  st.selectedShapeIds = [];
  freshLinks(st.shapes, beds[i].hist);
  putHistory(beds[i].hist);
  beds[i].hist = null;
  changed();
}

export function addBed(): number {
  stash();
  beds.push({ name: "", done: false, shapes: [] });
  markDirty();
  changed();
  return beds.length - 1;
}

export function removeBed(i: number) {
  if (beds.length < 2 || i < 0 || i >= beds.length) return;
  stash();
  const n = parts(beds[i].shapes) + parts(beds[i].other ?? []);
  if (n && !window.confirm(t("bed.confirmDelete", { name: bedName(i), n }))) return;
  removeStockBed(i, beds.length);
  beds.splice(i, 1);
  markDirty();
  if (i === active) {
    active = Math.min(i, beds.length - 1);
    const st = app();
    st.shapes = beds[active].shapes;
    st.selectedShapeIds = [];
    freshLinks(st.shapes, beds[active].hist);
    putHistory(beds[active].hist);
  } else if (i < active) active--;
  setStockBed(active);
  changed();
  fitAll(); // die Betten rücken im Raster nach
}

/**
 * Formen (mit ihren ganzen Gruppen) vom aktiven Bett auf ein anderes legen – Lage bleibt gleich.
 * Danach gibt es in beiden Betten kein Rückgängig über diesen Schritt (sonst wären die Teile doppelt).
 */
export function moveToBed(ids: string[], target: number): number {
  if (target === active || target < 0 || target >= beds.length || !ids.length) return 0;
  const st = app();
  const want = new Set(ids);
  const groups = new Set(st.shapes.filter((s: any) => want.has(s.id) && s.groupId).map((s: any) => s.groupId));
  const moving = st.shapes.filter((s: any) => want.has(s.id) || (s.groupId && groups.has(s.groupId)));
  if (!moving.length) return 0;
  const set = new Set(moving);
  st.shapes = st.shapes.filter((s: any) => !set.has(s));
  st.selectedShapeIds = st.selectedShapeIds.filter((id: string) => !moving.some((s: any) => s.id === id));
  // Zweiseitig: die Teile bleiben auf ihrer Seite. Zeigt das Ziel-Bett die andere Seite, kommen sie in seine verdeckte Liste
  const tb = beds[target];
  if (tb.two?.on && !!tb.back !== (viewSide() === "back")) { tb.other = [...(tb.other ?? []), ...moving]; tb.otherHist = null; }
  else tb.shapes = [...tb.shapes, ...moving];
  beds[target].hist = null;
  beds[target].done = false;
  putHistory(null);
  markDirty();
  changed();
  return parts(moving);
}

/** Formen eines Bettes (das aktive zählt live) */
export function bedShapes(i: number): any[] { return i === active ? app().shapes : beds[i].shapes; }

/** Alle Formen aller Betten (zum Speichern, Werkzeuge/Ebenen im Projekt) */
export function allShapes(): any[] {
  stash();
  // Rückseiten-Formen tragen in der Datei `side: "back"` (als Kopie – die Formen selbst bleiben unverändert)
  return beds.flatMap((_, i) => { const fb = frontBack(i); return fb.back.length ? [...fb.front, ...fb.back.map(s => ({ ...s, side: "back" }))] : fb.front; });
}

export function bedsForSave(): { name: string; done: boolean; n: number; twoSided?: TwoSidedSetup; split?: SplitSetup; piece?: BedPiece }[] {
  stash();
  return beds.map((b, i) => {
    const fb = frontBack(i);
    return {
      name: b.name, done: b.done, n: fb.front.length + fb.back.length, ...(b.two ? { twoSided: b.two } : {}),
      ...(b.split ? { split: b.split } : {}), ...(b.piece ? { piece: b.piece } : {}),
    };
  });
}

/** Projekt geladen: Formen nach den Angaben in `list` auf die Betten verteilen (ohne Angaben: ein Bett) */
export function loadBeds(shapes: any[], list?: any, activeIdx?: any) {
  cleanLinks(shapes);
  const ok = Array.isArray(list) && list.length > 0 && list.every((b: any) => Number.isInteger(b?.n) && b.n >= 0)
    && list.reduce((n: number, b: any) => n + b.n, 0) === shapes.length;
  if (ok) {
    let k = 0;
    beds = list.map((b: any) => {
      const part = shapes.slice(k, k + b.n);
      k += b.n;
      // Zweiseitig: Formen mit side "back" gehören zur Rückseite; geöffnet wird immer mit Blick auf die Vorderseite
      const back = part.filter((s: any) => s?.side === "back");
      const front = back.length ? part.filter((s: any) => s?.side !== "back") : part;
      for (const s of back) delete s.side;
      const sheet: Sheet = { name: typeof b.name === "string" ? b.name.slice(0, 40) : "", done: b.done === true, shapes: front };
      const two = cleanSetup(b.twoSided);
      // the same in Rust (twosided.rs), in the background; the setup in use stays the TypeScript one
      if (importInApp() && b.twoSided !== undefined) checkImport("two_sided_clean", { raw: b.twoSided }, two ? structuredClone(two) : null);
      if (two) sheet.two = two;
      if (back.length) sheet.other = back;
      // Großes Teil teilen: Fugen des Originals bzw. zu welcher Aufteilung ein Stück gehört
      const split = cleanSplit(b.split);
      if (split) sheet.split = split;
      if (b.piece && typeof b.piece.of === "string" && typeof b.piece.name === "string" && /^[A-Z]{1,3}\d{1,3}$/.test(b.piece.name)) sheet.piece = { of: b.piece.of.slice(0, 40), name: b.piece.name };
      return sheet;
    });
  } else beds = [{ name: "", done: false, shapes }];
  active = Number.isInteger(activeIdx) && activeIdx >= 0 && activeIdx < beds.length ? activeIdx : 0;
  setStockBed(active);
  const st = app();
  st.shapes = beds[active].shapes;
  st.selectedShapeIds = [];
  // Linked copies: original changed in an older version → rebuild the copies
  const lists = linkLists(), index = shapeIndex(lists);
  for (const l of lists) refreshLinks(l, index);
  putHistory(null);
  changed();
}

/** Dateiname für G-Code: bei mehreren Betten mit Bett-Namen */
export function gcodeFileName(): string {
  // Zweiseitig: zwei Dateien, eine je Seite
  const side = twoSidedOn() ? `-${viewSide()}` : "";
  if (beds.length < 2) return `cnc-auftrag${side}.gcode`;
  const n = bedName().normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || String(active + 1);
  return `cnc-auftrag-${n}${side}.gcode`;
}

// =====================================================================
// LEISTE über der Zeichenfläche: Reiter je Bett, + neues Bett, Fertig, Auswahl verschieben, Löschen
// =====================================================================

export function initBeds(onRedraw: () => void, onLog: (s: string) => void, onFit: () => void) {
  redraw = onRedraw;
  log = onLog;
  fitAll = onFit;
  setTagHook(moveTagged);
  const canvas = document.getElementById("cnc-canvas") as HTMLCanvasElement | null;
  if (canvas) initCanvasMouse(canvas);
  const holder = document.querySelector(".canvas-panel .canvas-holder");
  if (!holder) return;
  bar = document.createElement("div");
  bar.id = "bed-tabs";
  bar.className = "bed-tabs";
  holder.parentElement!.insertBefore(bar, holder);
  bar.addEventListener("click", e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-bed],[data-act]");
    if (!el) return;
    if (el.dataset.bed !== undefined) { switchBed(Number(el.dataset.bed)); return; }
    const act = el.dataset.act;
    if (act === "add") { switchBed(addBed()); fitAll(); log(t("bed.added", { name: bedName() })); }
    if (act === "done") { beds[active].done = !beds[active].done; changed(); }
    if (act === "front" || act === "back") { showSide(act); log(t(act === "back" ? "two.viewBack" : "two.viewFront")); }
    if (act === "del") removeBed(active);
    if (act === "plate") {
      if (!window.confirm(t("bed.plateConfirm", { name: bedName() }))) return;
      newPlate();
      log(t("bed.plateDone", { name: bedName() }));
    }
  });
  bar.addEventListener("dblclick", e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-bed]");
    if (el && Number(el.dataset.bed) === active) rename(el);
  });
  bar.addEventListener("change", e => {
    const sel = e.target as HTMLSelectElement;
    if (sel.id !== "bed-move" || !sel.value) return;
    const ids = [...app().selectedShapeIds];
    if (!ids.length) { log(t("bed.selectFirst")); sel.value = ""; return; }
    const target = sel.value === "new" ? addBed() : Number(sel.value);
    const n = moveToBed(ids, target);
    log(t("bed.moved", { n, name: bedName(target) }));
  });
  refreshBeds();
}

/** Namen direkt im Reiter ändern (Doppelklick) */
function rename(tab: HTMLElement) {
  const inp = document.createElement("input");
  inp.className = "bed-rename";
  inp.maxLength = 40;
  inp.value = bedName();
  tab.replaceWith(inp);
  inp.focus(); inp.select();
  let finished = false;
  const finish = (keep: boolean) => {
    if (finished) return;
    finished = true;
    if (keep) {
      const v = inp.value.trim();
      beds[active].name = v === t("bed.name", { n: active + 1 }) ? "" : v;
    }
    inp.remove();
    changed();
  };
  inp.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  inp.addEventListener("blur", () => finish(true));
}

/** Leiste neu zeichnen – nur wenn sich etwas geändert hat (wird bei jedem Neuzeichnen aufgerufen) */
export function refreshBeds() {
  if (!bar || bar.querySelector(".bed-rename")) return;
  const counts = beds.map((_, i) => parts(bedShapes(i)));
  const used = hasUsedArea();
  const two = twoSidedOn(), side = viewSide();
  const sig = JSON.stringify([active, counts, beds.map(b => [b.name, b.done, !!b.split, b.piece?.name]), used, two, side, two ? parts(hiddenShapes()) : 0]);
  if (sig === shown) return;
  shown = sig;
  const tabs = beds.map((b, i) =>
    `<button type="button" class="bed-tab${i === active ? " active" : ""}${b.done ? " done" : ""}" data-bed="${i}" title="${esc(t(i === active ? "bed.tabTipActive" : "bed.tabTip"))}">`
    + `${b.done ? "✓ " : ""}${b.split ? "✂ " : ""}${esc(bedName(i))}<span class="bed-n">${counts[i]}</span></button>`).join("");
  const others = beds.map((_, i) => i).filter(i => i !== active)
    .map(i => `<option value="${i}">→ ${esc(bedName(i))}</option>`).join("");
  bar.innerHTML = `${tabs}
    <button type="button" class="bed-btn" data-act="add" title="${esc(t("bed.addTip"))}">＋</button>
    ${two ? `<span class="bed-sides" title="${esc(t("two.sideTip"))}">`
      + (["front", "back"] as const).map(sd => `<button type="button" class="bed-btn bed-side${sd === side ? " on" : ""}" data-act="${sd}">${esc(t(sd === "front" ? "two.front" : "two.back"))}`
        + `<span class="bed-n">${parts(sideShapes(sd))}</span></button>`).join("") + `</span>` : ""}
    <span class="bed-space"></span>
    ${used ? `<button type="button" class="bed-btn" data-act="plate" title="${esc(t("bed.plateTip"))}">🧱 ${esc(t("bed.plate"))}</button>` : ""}
    <button type="button" class="bed-btn${beds[active].done ? " on" : ""}" data-act="done" title="${esc(t("bed.doneTip"))}">✓ ${esc(t("bed.done"))}</button>
    <select id="bed-move" class="bed-move" title="${esc(t("bed.moveTip"))}">
      <option value="">${esc(t("bed.move"))}</option>${others}<option value="new">→ ${esc(t("bed.moveNew"))}</option>
    </select>
    ${beds.length > 1 ? `<button type="button" class="bed-btn bed-del" data-act="del" title="${esc(t("bed.delTip"))}">🗑</button>` : ""}`;
}

/** Sprache gewechselt → Leiste neu */
export function relabelBeds() { shown = ""; refreshBeds(); }

// =====================================================================
// ZEICHENFLÄCHE: andere Betten blass daneben zeichnen, Klick wechselt, Teile hinüberziehen
// =====================================================================

/** Wird nach dem normalen Zeichnen aufgerufen (main.ts) – nur bei mehr als einem Bett */
export function drawOtherBeds(ctx: CanvasRenderingContext2D) {
  if (beds.length < 2) return;
  const st = app(), b = bedSizeMm();
  const bw = b.w * MM_TO_PIXEL, bh = b.h * MM_TO_PIXEL, scale = st.scale;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.font = "600 12px system-ui, sans-serif";
  ctx.textAlign = "left";
  for (let i = 0; i < beds.length; i++) {
    const o = shiftOf(i);
    const sx = (x: number) => (x + o.x) * scale + st.offsetX;
    const sy = (y: number) => (bh - y - o.y) * scale + st.offsetY;
    const x0 = sx(0), x1 = sx(bw), y0 = sy(bh), y1 = sy(0);
    const shapes = bedShapes(i);
    const label = `${beds[i].done ? "✓ " : ""}${bedName(i)} · ${t("bed.parts", { n: parts(shapes) })}`;
    if (i !== active) {
      // Original eines geteilten Teils: größer als das Bett – es würde die Nachbarn überdecken. Ist es selbst aktiv,
      // bleiben die anderen Betten weg; ist ein anderes aktiv, wird von ihm nur der Rahmen gezeigt
      if (beds[active].split) continue;
      if (x1 < 0 || x0 > ctx.canvas.width || y1 < 0 || y0 > ctx.canvas.height) continue;
      const light = isLight();
      ctx.fillStyle = light ? "#f2f2f6" : "#121217";
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = beds[i].done ? "rgba(52,209,123,0.55)" : light ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1.2;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = beds[i].done ? "rgba(52,209,123,0.45)" : light ? "rgba(90,96,110,0.55)" : "rgba(160,170,190,0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (!beds[i].split) for (const s of shapes) tracePath(ctx, s, sx, sy, scale);
      ctx.stroke();
    }
    ctx.fillStyle = i === active ? "#e6e6f0" : beds[i].done ? "#34d17b" : "#8a8a99";
    ctx.fillText(label, x0, y0 - 8);
  }
  ctx.restore();
}

function initCanvasMouse(canvas: HTMLCanvasElement) {
  const world = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return toWorld((e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height));
  };
  // Klick auf ein anderes Bett (dort, wo keine Form des aktiven Bettes liegt) → wechseln.
  // Läuft vor dem normalen Klick (capture), damit dort keine Auswahl-Box startet.
  canvas.addEventListener("mousedown", e => {
    if (e.button !== 0 || beds.length < 2 || app().currentTool !== "select") return;
    if (beds[active].split) return; // die anderen Betten sind hier nicht zu sehen (drawOtherBeds)
    const p = world(e);
    const i = bedAt(p.x, p.y);
    if (i < 0 || i === active) return;
    const tol = 4 / app().scale;
    const onShape = app().shapes.some((s: any) => {
      const b = shapeBounds(s);
      return b && p.x >= b.minX - tol && p.x <= b.maxX + tol && p.y >= b.minY - tol && p.y <= b.maxY + tol;
    });
    if (onShape) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    switchBed(i);
  }, true);
  // Nach dem Loslassen: liegt die Auswahl jetzt mit ihrer Mitte auf einem anderen Bett → dorthin verschieben
  window.addEventListener("mouseup", () => setTimeout(() => {
    const st = app();
    if (beds.length < 2 || !st.selectedShapeIds.length) return;
    if (beds[active].split) return; // ein Teil, das größer als das Bett ist, liegt mit seiner Mitte leicht über einem Nachbarn
    const ids = new Set<string>(st.selectedShapeIds);
    const sel = st.shapes.filter((s: any) => ids.has(s.id));
    const b = groupBounds(sel);
    if (!b) return;
    const target = bedAt((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    if (target < 0 || target === active) return;
    const o = shiftOf(target);
    const groups = new Set(sel.filter((s: any) => s.groupId).map((s: any) => s.groupId));
    for (const s of st.shapes) if (ids.has(s.id) || (s.groupId && groups.has(s.groupId))) translateShape(s, -o.x, -o.y);
    const n = moveToBed([...ids], target);
    log(t("bed.moved", { n, name: bedName(target) }));
  }, 0));
}
