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
import { takeHistory, putHistory, type HistoryState } from "./history";
import { t } from "../i18n/i18n";
import { MM_TO_PIXEL, groupBounds, shapeBounds, translateShape, type Bounds } from "../shapeTransform";
import { tracePath } from "../render";
import { updateDimensionInputs } from "../uiInputs";

interface Sheet { name: string; done: boolean; shapes: any[]; hist?: HistoryState | null }

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
  st.shapes = beds[i].shapes;
  st.selectedShapeIds = [];
  putHistory(beds[i].hist);
  beds[i].hist = null;
  changed();
}

export function addBed(): number {
  stash();
  beds.push({ name: "", done: false, shapes: [] });
  changed();
  return beds.length - 1;
}

export function removeBed(i: number) {
  if (beds.length < 2 || i < 0 || i >= beds.length) return;
  stash();
  const n = parts(beds[i].shapes);
  if (n && !window.confirm(t("bed.confirmDelete", { name: bedName(i), n }))) return;
  beds.splice(i, 1);
  if (i === active) {
    active = Math.min(i, beds.length - 1);
    const st = app();
    st.shapes = beds[active].shapes;
    st.selectedShapeIds = [];
    putHistory(beds[active].hist);
  } else if (i < active) active--;
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
  beds[target].shapes = [...beds[target].shapes, ...moving];
  beds[target].hist = null;
  beds[target].done = false;
  putHistory(null);
  changed();
  return parts(moving);
}

/** Formen eines Bettes (das aktive zählt live) */
export function bedShapes(i: number): any[] { return i === active ? app().shapes : beds[i].shapes; }

/** Alle Formen aller Betten (zum Speichern, Werkzeuge/Ebenen im Projekt) */
export function allShapes(): any[] { stash(); return beds.flatMap(b => b.shapes); }

export function bedsForSave(): { name: string; done: boolean; n: number }[] {
  stash();
  return beds.map(b => ({ name: b.name, done: b.done, n: b.shapes.length }));
}

/** Projekt geladen: Formen nach den Angaben in `list` auf die Betten verteilen (ohne Angaben: ein Bett) */
export function loadBeds(shapes: any[], list?: any, activeIdx?: any) {
  const ok = Array.isArray(list) && list.length > 0 && list.every((b: any) => Number.isInteger(b?.n) && b.n >= 0)
    && list.reduce((n: number, b: any) => n + b.n, 0) === shapes.length;
  if (ok) {
    let k = 0;
    beds = list.map((b: any) => {
      const part = shapes.slice(k, k + b.n);
      k += b.n;
      return { name: typeof b.name === "string" ? b.name.slice(0, 40) : "", done: b.done === true, shapes: part };
    });
  } else beds = [{ name: "", done: false, shapes }];
  active = Number.isInteger(activeIdx) && activeIdx >= 0 && activeIdx < beds.length ? activeIdx : 0;
  const st = app();
  st.shapes = beds[active].shapes;
  st.selectedShapeIds = [];
  putHistory(null);
  changed();
}

/** Dateiname für G-Code: bei mehreren Betten mit Bett-Namen */
export function gcodeFileName(): string {
  if (beds.length < 2) return "cnc-auftrag.gcode";
  const n = bedName().normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || String(active + 1);
  return `cnc-auftrag-${n}.gcode`;
}

// =====================================================================
// LEISTE über der Zeichenfläche: Reiter je Bett, + neues Bett, Fertig, Auswahl verschieben, Löschen
// =====================================================================

export function initBeds(onRedraw: () => void, onLog: (s: string) => void, onFit: () => void) {
  redraw = onRedraw;
  log = onLog;
  fitAll = onFit;
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
    if (act === "del") removeBed(active);
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
  const sig = JSON.stringify([active, counts, beds.map(b => [b.name, b.done])]);
  if (sig === shown) return;
  shown = sig;
  const tabs = beds.map((b, i) =>
    `<button type="button" class="bed-tab${i === active ? " active" : ""}${b.done ? " done" : ""}" data-bed="${i}" title="${esc(t(i === active ? "bed.tabTipActive" : "bed.tabTip"))}">`
    + `${b.done ? "✓ " : ""}${esc(bedName(i))}<span class="bed-n">${counts[i]}</span></button>`).join("");
  const others = beds.map((_, i) => i).filter(i => i !== active)
    .map(i => `<option value="${i}">→ ${esc(bedName(i))}</option>`).join("");
  bar.innerHTML = `${tabs}
    <button type="button" class="bed-btn" data-act="add" title="${esc(t("bed.addTip"))}">＋</button>
    <span class="bed-space"></span>
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
      if (x1 < 0 || x0 > ctx.canvas.width || y1 < 0 || y0 > ctx.canvas.height) continue;
      ctx.fillStyle = "#121217";
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = beds[i].done ? "rgba(52,209,123,0.55)" : "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1.2;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = beds[i].done ? "rgba(52,209,123,0.45)" : "rgba(160,170,190,0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const s of shapes) tracePath(ctx, s, sx, sy, scale);
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
