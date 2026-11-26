/**
 * ZEICHEN- UND BEARBEITUNGS-WERKZEUGE (Maus-Logik)
 *
 *  Auswahl (V)   klicken, Rahmen ziehen, Formen verschieben, an den Griffen skalieren/drehen
 *  Hand (H)      Ansicht verschieben (auch: mittlere Maustaste oder Leertaste gedrückt halten)
 *  Linie (L)     Punkt für Punkt, Shift = 15°-Schritte, Doppelklick/Enter = fertig
 *  Rechteck (R)  ziehen, Shift = Quadrat, Strg/Alt = von der Mitte
 *  Kreis (C)     erster Punkt = Mitte, dann Radius ziehen/klicken oder Ø tippen (echter Kreis)
 *  Ellipse (E)   von der Mitte aus ziehen, Shift = Kreis, Strg/Alt = von der Ecke
 *  Polygon (P)   von der Mitte ziehen, Ecken-Anzahl in den Werkzeug-Optionen
 *  Stern         von der Mitte ziehen, Zacken und Innenradius in den Werkzeug-Optionen
 *  Langloch      Rahmen ziehen, die kurzen Seiten werden Halbkreise
 *  Ring          von der Mitte ziehen, Wandstärke in den Werkzeug-Optionen
 *  Bogen (A)     Start, Ende, Wölbung
 *  Bogen Mitte   Mittelpunkt, Start, Ende; Strg/Alt = andere Richtung
 *  Text (T)      klicken -> Text-Dialog
 *  Messen (M)    ziehen -> Abstand und Winkel
 *  Stege setzen  Klick auf eine Kontur setzt einen Haltesteg, Klick auf einen Steg entfernt ihn
 *  Punkte (N)    Knoten und Tangenten bearbeiten, Kurve zeichnen (B) – siehe bezier.ts
 *  Bemaßung (D)  Abstands- und Größenmaße, die beim Verschieben mitgehen – siehe dims.ts
 */
import { isLinked } from "../linkedCopies";
import { app, options, ToolName, toWorld, screenDist, fmtMm } from "./editorState";
import { snapPoint, snapAngle, SnapResult } from "./snap";
import {
  hitTest, clickSelect, boxSelect, selectedShapes, selectionBounds,
  handleAt, insideSelectionBox, HandleName, HANDLE_CURSORS
} from "./selection";
import {
  Pt, Bounds, MM_TO_PIXEL, cloneShape, translateShape, scaleShape, rotateShape,
  createPolyline, createCircle, createArc, makeRectPoints, makeEllipsePoints, makePolygonPoints, newId
} from "../shapeTransform";
import { updateDimensionInputs } from "../uiInputs";
import { openTextDialog, editTextGroup } from "./textTool";
import { openQrDialog } from "./qrTool";
import { openEngraveDialog } from "../raster/engraveDialog";
import { addLineDim, addSize, dimAt, dimSel, dimClick, dimCancel, dimTool, deleteDim, editDimValue, lastLineDimCrossed, lineDimPick } from "./dims";
import { nodeEdit, nodeDown, nodeMove, nodeUp, nodeDblClick, nodeDelete, ensureBez, penDown, penMove, penUp, penFinish, penCancel, pen, nodeTarget } from "./bezier";
import { t } from "../i18n/i18n";
import { unitName } from "../units";
import { outline, outlineFraction, autoFractions, cumulative } from "../tabs";
import { toolLog, trimClick, trimMouseMove } from "./trimTool";
import { cornerClick, cornerHover, cornerMove, extendClick, extendMove } from "./cornerTool";
import { conAfterMove, conAfterNodeMove, conAt, conClick, conDeleteSelected, conEdit, conMove, conPrompt, conReset, conSnapshot, conTool, valueInput } from "./constrainTool";
import { centerArc, CenterArc, ringInner, slotPoints, starPoints } from "./drawShapes";
import { fieldsFor, lockPoint } from "./typedValues";
import { orthoPoint } from "./joinExplode";
import { closeTypedBox, openTypedBox, typedLock, typedOpen } from "./typedBox";

type Mode =
  | "idle" | "panning" | "pressSelect" | "moving" | "scaling" | "rotating" | "boxselect"
  | "dragDraw";

export const live = {
  mode: "idle" as Mode,
  screen: { x: 0, y: 0 },
  world: { x: 0, y: 0 },          // Cursor nach Fang (für Zeichenwerkzeuge)
  raw: { x: 0, y: 0 },            // Cursor ohne Fang
  snap: null as SnapResult | null,
  downScreen: { x: 0, y: 0 },
  downWorld: { x: 0, y: 0 },
  shift: false, alt: false, ctrl: false,
  spaceDown: false,

  // Auswahl-Aktionen
  originals: new Map<string, any>(),
  pressHit: null as any,
  moveDelta: { x: 0, y: 0 },
  handle: null as HandleName | null,
  anchor: { x: 0, y: 0 },
  handlePoint: { x: 0, y: 0 },
  startBounds: null as Bounds | null,
  center: { x: 0, y: 0 },
  angle: 0,
  boxStart: { x: 0, y: 0 },
  grabPoint: { x: 0, y: 0 },     // Punkt, der beim Verschieben einrastet

  // Zeichnen
  points: [] as Pt[],            // Linie: gesetzte Punkte / Bogen: Start & Ende
  dragStart: null as Pt | null,  // Rechteck/Ellipse/Polygon/Messen
  clickDraw: false,              // Rechteck & Co. mit Klick, Klick statt Ziehen (zweiter Klick setzt)
  measure: null as { a: Pt; b: Pt } | null,

  hover: null as any,
  label: "" as string,           // Info-Text an der Maus (Länge, Größe, Winkel)
  menuOk: false                  // Rechtsklick ohne laufende Zeichnung: Menü zeigen
};

/**
 * Punkt abholen (Befehlszeile: Verschieben, Kopieren, Drehen, Kreis): solange hook gesetzt ist, liefert ein Linksklick
 * den gefangenen Punkt an hook statt an das Werkzeug. from: Bezugspunkt (Gummiband in der Vorschau, Lot/Tangente)
 */
export const pick = {
  hook: null as null | ((p: Pt) => void),
  from: null as Pt | null,
  move: null as null | ((p: Pt) => void),  // Maus bewegt (z. B. Vorschau beim Versatz)
  lines: null as null | Pt[][],             // Vorschau-Linien (gelb gestrichelt)
  cancel: null as null | (() => void)       // Esc / anderes Werkzeug
};
let pickClick = false;

let redrawFn: () => void = () => {};
let canvasEl: HTMLCanvasElement | null = null;
let panStart = { x: 0, y: 0 };

/** Hinweis in der Statuszeile für jedes Werkzeug (übersetzt) */
export function toolHint(name: ToolName): string {
  if (name === "constrain") return `${conPrompt()} · ${t("hint.constrain")}`;
  return fieldsFor(name) ? `${t(`hint.${name}`)} · ${t("hint.typed")}` : t(`hint.${name}`);
}

export function initTools(canvas: HTMLCanvasElement, redraw: () => void) {
  canvasEl = canvas;
  redrawFn = redraw;
}

export function currentTool(): ToolName {
  return (app().currentTool || "select") as ToolName;
}

export function setTool(name: ToolName) {
  cancelCurrent();
  cornerHover.corner = null; cornerHover.piece = null; cornerHover.ext = null;
  conReset(); conTool.sel = null;
  app().currentTool = name;
  // Punkte bearbeiten: eine einzeln ausgewählte Form gleich übernehmen
  if (name === "node") {
    const sel = selectedShapes();
    nodeEdit.targetId = sel.length === 1 && !isLinked(sel[0]) && ensureBez(sel[0]) ? sel[0].id : null;
    nodeEdit.sel = -1;
  }
  document.querySelectorAll(".btn-tool-icon[data-tool]").forEach(b =>
    b.classList.toggle("active", (b as HTMLElement).dataset.tool === name));
  window.dispatchEvent(new CustomEvent("cnc-tool-changed", { detail: name }));
  updateCursor();
  redrawFn();
}

/** Bricht laufende Aktionen ab (Linie, Bogen, Ziehen) */
export function cancelCurrent() {
  if ((live.mode === "moving" || live.mode === "scaling" || live.mode === "rotating") && live.originals.size) {
    const st = app();
    st.shapes = st.shapes.map((s: any) => live.originals.has(s.id) ? cloneShape(live.originals.get(s.id)) : s);
  }
  live.mode = "idle";
  live.points = [];
  live.dragStart = null;
  live.clickDraw = false;
  live.measure = null;
  live.originals.clear();
  live.label = "";
  closeTypedBox();
  if (pick.cancel) pick.cancel();
  penCancel();
  nodeEdit.grab = null;
  dimCancel();
}

function readModifiers(e: MouseEvent | KeyboardEvent) {
  live.shift = e.shiftKey;
  live.alt = e.altKey;
  live.ctrl = e.ctrlKey || e.metaKey;
}

function selectedSet(): Set<string> {
  return new Set(app().selectedShapeIds);
}

function finishChange() {
  updateDimensionInputs(null);
  redrawFn();
}

export function addShapes(shapes: any[]) {
  const st = app();
  st.shapes = [...st.shapes, ...shapes];
  st.selectedShapeIds = shapes.map(s => s.id);
  finishChange();
}

// =====================================================================
// MAUS GEDRÜCKT
// =====================================================================

export function onMouseDown(e: MouseEvent, sx: number, sy: number) {
  readModifiers(e);
  live.screen = { x: sx, y: sy };
  live.raw = toWorld(sx, sy);
  live.downScreen = { x: sx, y: sy };
  live.downWorld = { ...live.raw };
  const tool = currentTool();

  // Ansicht verschieben: mittlere Maustaste, Hand-Werkzeug oder Leertaste
  if (e.button === 1 || (e.button === 0 && (tool === "pan" || live.spaceDown))) {
    e.preventDefault();
    live.mode = "panning";
    panStart = { x: sx - app().offsetX, y: sy - app().offsetY };
    updateCursor();
    return;
  }

  // Rechtsklick: Linie fertigstellen bzw. Zeichnen abbrechen – wird gerade nichts gezeichnet: Menü (mouseEngine.ts)
  if (e.button === 2) {
    const busy = live.mode !== "idle" || live.points.length > 0 || !!live.dragStart || pen.nodes.length > 0 || tool === "dim";
    if (tool === "line" && live.points.length >= 2) finishLine(false);
    else if (busy) cancelCurrent();
    else live.menuOk = true;
    redrawFn();
    return;
  }
  if (e.button !== 0) return;

  updateSnap();
  if (pick.hook) { const h = pick.hook; pickClick = true; h({ ...live.world }); redrawFn(); return; }
  live.measure = tool === "measure" ? null : live.measure;

  // Maßzahl angeklickt (Auswahl- oder Bemaßungs-Werkzeug): Maß auswählen (Entf löscht, Doppelklick ändert)
  if (tool === "select" || tool === "dim" || tool === "lineDim") {
    const d = dimAt(sx, sy);
    dimSel.cur = d;
    if (d) { conTool.sel = null; redrawFn(); return; }
  }
  // Zeichen einer Bedingung angeklickt: auswählen (Entf löscht, Doppelklick ändert)
  if (tool === "select" || tool === "constrain") {
    conTool.sel = conAt(sx, sy);
    if (conTool.sel) { redrawFn(); return; }
  }

  switch (tool) {
    case "select": {
      const handle = selectedShapes().length ? handleAt(sx, sy) : null;
      if (handle) { startHandleDrag(handle.name); return; }

      const hit = hitTest(live.raw.x, live.raw.y);
      live.pressHit = hit;
      const sel = selectedSet();
      if (hit && !sel.has(hit.id)) {
        clickSelect(hit, live.shift, live.alt);
        updateDimensionInputs(null);
        live.mode = live.shift ? "idle" : "pressSelect";
      } else if (hit || insideSelectionBox(sx, sy)) {
        live.mode = "pressSelect";
      } else {
        live.mode = "boxselect";
        live.boxStart = { x: sx, y: sy };
      }
      break;
    }
    case "line":
      if (live.points.length === 0) live.points = [{ ...live.world }];
      break;
    case "rect":
    case "ellipse":
    case "circle":
    case "polygon":
    case "star":
    case "slot":
    case "ring":
    case "measure":
      if (!(live.clickDraw && live.dragStart)) live.dragStart = { ...live.world };
      live.mode = "dragDraw";
      break;
    case "tab":
      placeTab();
      break;
    case "trim":
      if (trimClick(live.raw)) finishChange();
      break;
    case "corner":
      if (cornerClick(live.raw)) finishChange();
      break;
    case "extend":
      if (extendClick(live.raw)) finishChange();
      break;
    case "constrain":
      if (conClick(live.raw, openValue)) finishChange();
      break;
    case "lineDim":
      lineDimClick(live.raw);
      break;
    case "node":
      nodeDown(live.raw, sx, sy, hitTest(live.raw.x, live.raw.y));
      updateDimensionInputs(null);
      break;
    case "pen": {
      const done = penDown(live.world, sx, sy);
      if (done) addShapes([done]);
      break;
    }
    case "dim":
      if (dimClick(live.raw, hitTest(live.raw.x, live.raw.y))) finishChange();
      break;
    default:
      break;
  }
  redrawFn();
}

/**
 * Haltesteg setzen/entfernen: Klick auf eine geschlossene Kontur. Hatte die Form automatische Stege,
 * werden die zuerst als selbst gesetzte übernommen – dann kann man sie einzeln wegklicken oder ergänzen.
 */
function placeTab() {
  const hit = hitTest(live.raw.x, live.raw.y, 10);
  const ring = hit ? outline(hit) : null;
  if (!hit || !ring) return;
  const num = (id: string, d: number) => { const v = parseFloat((document.getElementById(id) as HTMLInputElement | null)?.value || ""); return Number.isFinite(v) && v > 0 ? v : d; };
  if (!(Number(hit.tabLen) > 0)) hit.tabLen = num("dim-tab-w", 5);
  if (!(Number(hit.tabH) > 0)) hit.tabH = num("dim-tab-h", 1.5);
  if (hit.tabMode !== "manual") {
    hit.tabPts = autoFractions(Math.round(Number(hit.tabN) || 0));
    hit.tabMode = "manual";
  }
  const fr = outlineFraction(hit, live.raw);
  if (!fr) return;
  const cum = cumulative(ring);
  const L = cum[cum.length - 1];
  // Klick auf einen vorhandenen Steg (halbe Steglänge + etwas Luft) entfernt ihn
  const tol = (hit.tabLen * MM_TO_PIXEL / 2 + screenDist(8)) / L;
  const pts: number[] = hit.tabPts || [];
  const near = pts.findIndex(f => { const d = Math.abs(f - fr.f); return Math.min(d, 1 - d) <= tol; });
  if (near >= 0) pts.splice(near, 1); else pts.push(fr.f);
  hit.tabPts = pts;
  app().selectedShapeIds = [hit.id];
  finishChange();
}

function startHandleDrag(name: HandleName) {
  const b = selectionBounds();
  if (!b) return;
  live.startBounds = b;
  live.originals = new Map(selectedShapes().map(s => [s.id, cloneShape(s)]));
  live.center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  live.handle = name;
  if (name === "rotate") {
    live.mode = "rotating";
    live.angle = 0;
  } else {
    live.mode = "scaling";
    const px = name.includes("w") ? b.minX : name.includes("e") ? b.maxX : live.center.x;
    const py = name.includes("s") ? b.minY : name.includes("n") ? b.maxY : live.center.y;
    live.handlePoint = { x: px, y: py };
    const ax = name.includes("w") ? b.maxX : name.includes("e") ? b.minX : live.center.x;
    const ay = name.includes("s") ? b.maxY : name.includes("n") ? b.minY : live.center.y;
    live.anchor = { x: ax, y: ay };
  }
  redrawFn();
}

// =====================================================================
// MAUS BEWEGT
// =====================================================================

export function onMouseMove(e: MouseEvent, sx: number, sy: number) {
  readModifiers(e);
  live.screen = { x: sx, y: sy };
  live.raw = toWorld(sx, sy);
  const st = app();
  const tool = currentTool();

  if (live.mode === "panning") {
    st.offsetX = sx - panStart.x;
    st.offsetY = sy - panStart.y;
    redrawFn();
    return;
  }
  if (pick.move) { updateSnap(); pick.move({ ...live.world }); redrawFn(); return; }
  if (tool === "node" && nodeEdit.grab) {
    // Bedingungen: nach dem Ziehen eines Knotens nachrechnen (gezogener Punkt bleibt bei der Maus)
    const g = nodeEdit.grab, target = nodeTarget();
    const prev = g.kind === "node" && target?.points ? conSnapshot(target) : null;
    nodeMove(live.raw, live.alt);
    if (prev && target && g.kind === "node") conAfterNodeMove(target.id, g.i, prev);
    redrawFn();
    return;
  }
  if (tool === "pen") { updateSnap(); penMove(pen.dragging ? live.raw : live.world); redrawFn(); return; }
  if (tool === "trim") { trimMouseMove(live.raw); redrawFn(); return; }
  if (tool === "corner") { cornerMove(live.raw); redrawFn(); return; }
  if (tool === "extend") { extendMove(live.raw); redrawFn(); return; }
  if (tool === "constrain") { conMove(live.raw); redrawFn(); return; }
  if (tool === "lineDim") {
    const hit = hitTest(live.raw.x, live.raw.y), pick = hit ? lineDimPick(hit, live.raw) : null;
    lineDimHover.pick = pick && "seg" in pick ? pick : null;
    redrawFn();
    return;
  }
  if (tool === "dim") { dimTool.mouse = { ...live.raw }; live.hover = hitTest(live.raw.x, live.raw.y); redrawFn(); return; }

  switch (live.mode) {
    case "pressSelect":
      if (Math.hypot(sx - live.downScreen.x, sy - live.downScreen.y) > 3) {
        live.mode = "moving";
        live.moveDelta = { x: 0, y: 0 };
        live.grabPoint = findGrabPoint();
        live.originals = new Map(selectedShapes().map(s => [s.id, cloneShape(s)]));
      }
      break;
    case "moving":
      doMove();
      break;
    case "scaling":
      doScale();
      break;
    case "rotating":
      doRotate();
      break;
    default:
      break;
  }

  if ((tool !== "select" && tool !== "pan") || pick.hook) updateSnap();
  else live.snap = null;

  if (live.mode === "idle" && tool === "select") {
    live.hover = hitTest(live.raw.x, live.raw.y);
  } else if (tool !== "select") {
    live.hover = null;
  }

  updateLabel();
  updateCursor();
  redrawFn();
}

function updateSnap() {
  const tool = currentTool();
  const extra = tool === "line" ? live.points : [];
  // Lot und Tangente gibt es nur, wenn von einem gesetzten Punkt aus gezeichnet bzw. gemessen wird
  const snapFrom = pick.hook ? pick.from ?? undefined
    : tool === "line" && live.points.length ? live.points[live.points.length - 1]
    : tool === "measure" && live.mode === "dragDraw" && live.dragStart ? live.dragStart : undefined;
  let s = snapPoint(live.raw.x, live.raw.y, undefined, extra, snapFrom);

  // Shift beim Linien- und Bogenzeichnen: Winkel auf 15° einrasten
  if (live.shift && tool === "line" && live.points.length > 0) {
    const last = live.points[live.points.length - 1];
    const p = snapAngle(last.x, last.y, live.raw.x, live.raw.y);
    s = { x: p.x, y: p.y, kind: "none" };
  }
  live.snap = s.kind === "none" ? null : s;
  live.world = { x: s.x, y: s.y };

  // Ortho (F8): vom letzten Punkt aus nur waagerecht/senkrecht – ein Objektfang geht vor (wie in CAD-Programmen)
  if (options.ortho && snapFrom && (!live.snap || live.snap.kind === "grid")) {
    live.world = orthoPoint(snapFrom, live.world);
    live.snap = null;
  }

  // getippte Maße (typedBox.ts) gelten statt der Maus
  const from = drawFrom();
  if (typedOpen() && from) {
    const lock = typedLock();
    if (lock.a !== undefined || lock.b !== undefined) {
      live.world = lockPoint(tool, from, live.world, lock, fromCenter());
      live.snap = null;
    }
  }
}

/** Bezugspunkt der laufenden Zeichnung (letzter Linienpunkt bzw. Startpunkt), null = es wird nichts gezeichnet */
function drawFrom(): Pt | null {
  const tool = currentTool();
  if (!fieldsFor(tool)) return null;
  if (tool === "line") return live.points.length ? live.points[live.points.length - 1] : null;
  return live.mode === "dragDraw" && live.dragStart ? live.dragStart : null;
}

/** Zahl getippt während des Zeichnens: Felder an der Maus öffnen */
function startTyping(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || typedOpen() || !drawFrom()) return false;
  const tab = e.key === "Tab";
  if (!tab && !/^[0-9.,+\-(]$/.test(e.key)) return false;
  const tool = currentTool();
  return openTypedBox(tool, tab ? "" : e.key, {
    change: () => { updateSnap(); updateLabel(); redrawFn(); },
    commit: () => commitTyped(),
    empty: () => { if (tool === "line" && live.points.length >= 2) finishLine(false); redrawFn(); }
  }, tab && !e.shiftKey ? 1 : 0); // Tab = gleich ins zweite Feld (Winkel/Höhe)
}

/** Enter in den Feldern: Punkt bzw. Form mit den getippten Werten setzen */
function commitTyped() {
  const tool = currentTool();
  updateSnap();
  if (tool === "line") handleLineClick();
  else if (live.mode === "dragDraw" && live.dragStart) {
    live.clickDraw = false; // auch eine winzige getippte Form ist gewollt
    finishDragDraw(tool);
  }
  closeTypedBox();
  updateSnap();
  updateLabel();
  redrawFn();
}

function doMove() {
  let dx = live.raw.x - live.downWorld.x;
  let dy = live.raw.y - live.downWorld.y;
  if (live.shift || options.ortho) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }

  // Greifpunkt einrasten lassen (an anderen Formen bzw. am Raster)
  const grab = live.grabPoint;
  const s = snapPoint(grab.x + dx, grab.y + dy, selectedSet());
  if (s.kind !== "none" && !live.shift) { dx = s.x - grab.x; dy = s.y - grab.y; }
  live.snap = s.kind === "none" ? null : s;

  const ddx = dx - live.moveDelta.x, ddy = dy - live.moveDelta.y;
  if (ddx === 0 && ddy === 0) return;
  for (const shape of selectedShapes()) translateShape(shape, ddx, ddy);
  live.moveDelta = { x: dx, y: dy };
}

/**
 * Welcher Punkt der Auswahl soll beim Verschieben einrasten?
 * Ein Eckpunkt / Mittelpunkt nahe der Maus, sonst bei Raster-Fang die linke untere Ecke.
 */
function findGrabPoint(): Pt {
  const d0 = live.downWorld;
  let best: Pt | null = null;
  let bestD = screenDist(15);
  const consider = (x: number, y: number) => {
    const d = Math.hypot(x - d0.x, y - d0.y);
    if (d < bestD) { bestD = d; best = { x, y }; }
  };
  for (const s of selectedShapes()) {
    if (s.type === "polyline" && s.points.length <= 4000) for (const p of s.points) consider(p.x, p.y);
    else if (s.type === "circle") consider(s.x, s.y);
    else if (s.type === "line" || s.type === "arc") { consider(s.x, s.y); consider(s.x + s.w, s.y + s.h); }
  }
  if (best) return best;
  if (options.snapGrid) {
    const b = selectionBounds();
    if (b) return { x: b.minX, y: b.minY };
  }
  return { ...d0 };
}

function applyFromOriginals(fn: (s: any) => void) {
  const st = app();
  st.shapes = st.shapes.map((s: any) => {
    const o = live.originals.get(s.id);
    if (!o) return s;
    const c = cloneShape(o);
    fn(c);
    return c;
  });
}

function doScale() {
  const name = live.handle!;
  const fromCenter = live.ctrl || live.alt;
  const anchor = fromCenter ? live.center : live.anchor;
  const hp = live.handlePoint;
  const cur = live.raw;
  const MIN = 0.001;

  let sx = 1, sy = 1;
  const corner = name.length === 2;
  if (corner) {
    const hx = hp.x - anchor.x, hy = hp.y - anchor.y;
    if (live.shift) {
      sx = hx !== 0 ? (cur.x - anchor.x) / hx : 1;
      sy = hy !== 0 ? (cur.y - anchor.y) / hy : 1;
    } else {
      // Seitenverhältnis bleibt: Projektion der Maus auf die Diagonale
      const len2 = hx * hx + hy * hy;
      const s = len2 > 0 ? ((cur.x - anchor.x) * hx + (cur.y - anchor.y) * hy) / len2 : 1;
      sx = sy = s;
    }
  } else if (name === "e" || name === "w") {
    const hx = hp.x - anchor.x;
    sx = hx !== 0 ? (cur.x - anchor.x) / hx : 1;
  } else {
    const hy = hp.y - anchor.y;
    sy = hy !== 0 ? (cur.y - anchor.y) / hy : 1;
  }
  sx = Math.max(MIN, sx);
  sy = Math.max(MIN, sy);
  applyFromOriginals(s => scaleShape(s, anchor.x, anchor.y, sx, sy));

  const b = live.startBounds!;
  live.label = `${fmtMm((b.maxX - b.minX) * sx)} × ${fmtMm((b.maxY - b.minY) * sy)} ${unitName()}`;
}

function doRotate() {
  const c = live.center;
  const a0 = Math.atan2(live.downWorld.y - c.y, live.downWorld.x - c.x);
  const a1 = Math.atan2(live.raw.y - c.y, live.raw.x - c.x);
  let angle = a1 - a0;
  if (live.shift) {
    const step = (15 * Math.PI) / 180;
    angle = Math.round(angle / step) * step;
  }
  live.angle = angle;
  applyFromOriginals(s => rotateShape(s, c.x, c.y, angle));
  let deg = (angle * 180) / Math.PI; // positiv = gegen den Uhrzeigersinn
  deg = ((deg % 360) + 540) % 360 - 180;
  live.label = `${deg.toFixed(1)}°`;
}

function updateLabel() {
  const tool = currentTool();
  const w = live.world;
  if (live.mode === "scaling" || live.mode === "rotating") return;
  live.label = "";
  if (tool === "line" && live.points.length > 0) {
    const last = live.points[live.points.length - 1];
    const len = Math.hypot(w.x - last.x, w.y - last.y);
    const ang = (Math.atan2(w.y - last.y, w.x - last.x) * 180) / Math.PI;
    live.label = `${fmtMm(len)} ${unitName()}  ${ang.toFixed(1)}°`;
  } else if (live.mode === "dragDraw" && live.dragStart) {
    const r = dragRect();
    if (tool === "circle") {
      const rad = Math.hypot(w.x - live.dragStart.x, w.y - live.dragStart.y);
      live.label = `Ø ${fmtMm(rad * 2)} ${unitName()}`;
    } else if (tool === "rect" || tool === "ellipse" || tool === "slot") {
      live.label = `${fmtMm(Math.abs(r.x1 - r.x0))} × ${fmtMm(Math.abs(r.y1 - r.y0))} ${unitName()}`;
    } else if (tool === "polygon") {
      const rad = Math.hypot(w.x - live.dragStart.x, w.y - live.dragStart.y);
      live.label = `Ø ${fmtMm(rad * 2)} ${unitName()} · ${t("label.corners", { n: options.polygonSides })}`;
    } else if (tool === "star") {
      const rad = Math.hypot(w.x - live.dragStart.x, w.y - live.dragStart.y);
      live.label = `Ø ${fmtMm(rad * 2)} ${unitName()} · ${t("label.tips", { n: options.starTips })}`;
    } else if (tool === "ring") {
      const rad = Math.hypot(w.x - live.dragStart.x, w.y - live.dragStart.y);
      live.label = `Ø ${fmtMm(rad * 2)} ${unitName()} · ${ringInner(rad, options.ringWall * MM_TO_PIXEL) === null ? t("ring.wallTooThick") : `Ø ${fmtMm((rad - options.ringWall * MM_TO_PIXEL) * 2)} ${unitName()}`}`;
    } else if (tool === "measure") {
      live.label = measureText(live.dragStart, w);
    }
  } else if (tool === "arcCenter" && live.points.length === 1) {
    live.label = `R ${fmtMm(Math.hypot(w.x - live.points[0].x, w.y - live.points[0].y))} ${unitName()}`;
  } else if (tool === "arcCenter" && live.points.length === 2) {
    const a = previewCenterArc();
    live.label = a ? `R ${fmtMm(a.radius)} ${unitName()} · ${Math.abs((a.sweep * 180) / Math.PI).toFixed(1)}°` : "";
  } else if (live.mode === "moving") {
    live.label = `Δ ${fmtMm(live.moveDelta.x)} / ${fmtMm(live.moveDelta.y)} ${unitName()}`;
  }
}

export function measureText(a: Pt, b: Pt): string {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  return `${fmtMm(len)} ${unitName()} · ${ang.toFixed(1)}° · ΔX ${fmtMm(dx)} · ΔY ${fmtMm(dy)}`;
}

/** Von der Mitte aus? Ellipse: immer, außer mit Strg/Alt (dann von der Ecke). Rechteck & Co.: nur mit Strg/Alt */
function fromCenter(): boolean {
  const mod = live.ctrl || live.alt;
  return currentTool() === "ellipse" ? !mod : mod;
}

/** Rechteck aus Ziehpunkt und Maus, mit Shift (quadratisch) und Strg/Alt (von der Mitte, bei der Ellipse von der Ecke) */
export function dragRect(): { x0: number; y0: number; x1: number; y1: number } {
  const a = live.dragStart!, b = live.world;
  let dx = b.x - a.x, dy = b.y - a.y;
  if (live.shift) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  if (fromCenter()) return { x0: a.x - dx, y0: a.y - dy, x1: a.x + dx, y1: a.y + dy };
  return { x0: a.x, y0: a.y, x1: a.x + dx, y1: a.y + dy };
}

/** Stern-Vorschau/-Erzeugung: wie beim Polygon zeigt die erste Spitze zur Maus */
export function dragStarPoints(): Pt[] {
  const c = live.dragStart!, w = live.world;
  const r = Math.hypot(w.x - c.x, w.y - c.y);
  let a = Math.atan2(w.y - c.y, w.x - c.x);
  if (live.shift) { const step = Math.PI / 12; a = Math.round(a / step) * step; }
  return starPoints(c.x, c.y, r, options.starTips, options.starInner / 100, a);
}

export function dragSlotPoints(): Pt[] {
  const r = dragRect();
  return slotPoints(r.x0, r.y0, r.x1, r.y1);
}

/** Bogen mit Mittelpunkt: nach Mitte und Start gesetzt, das Ende folgt der Maus. Strg/Alt = andere Richtung, Shift = 15°-Schritte */
export function previewCenterArc(): CenterArc | null {
  if (live.points.length !== 2) return null;
  return centerArc(live.points[0], live.points[1], live.world, !(live.ctrl || live.alt), live.shift ? Math.PI / 12 : 0);
}

/** Polygon-Vorschau/-Erzeugung aus Ziehpunkt und Maus */
export function dragPolygonPoints(): Pt[] {
  const c = live.dragStart!, w = live.world;
  const r = Math.hypot(w.x - c.x, w.y - c.y);
  let a = Math.atan2(w.y - c.y, w.x - c.x);
  if (live.shift) { const step = Math.PI / 12; a = Math.round(a / step) * step; }
  return makePolygonPoints(c.x, c.y, r, options.polygonSides, a);
}

// =====================================================================
// MAUS LOSGELASSEN
// =====================================================================

export function onMouseUp(e: MouseEvent, sx: number, sy: number) {
  readModifiers(e);
  live.screen = { x: sx, y: sy };
  live.raw = toWorld(sx, sy);
  const tool = currentTool();
  const st = app();

  if (live.mode === "panning") { live.mode = "idle"; updateCursor(); return; }
  if (e.button !== 0) return;
  if (pickClick) { pickClick = false; redrawFn(); return; } // der Klick ging an die Befehlszeile
  if (tool === "node") { nodeUp(); finishChange(); return; }
  if (tool === "pen") { penUp(); redrawFn(); return; }

  switch (live.mode) {
    case "pressSelect": {
      // Klick ohne Ziehen: Auswahl neu setzen
      const hit = live.pressHit;
      if (hit) clickSelect(hit, live.shift, live.alt);
      else if (!live.shift) st.selectedShapeIds = [];
      live.mode = "idle";
      finishChange();
      return;
    }
    case "moving":
    case "scaling":
    case "rotating":
      if (live.mode === "moving") conAfterMove(selectedShapes().map(s => s.id)); // verbundene Formen folgen
      live.mode = "idle";
      live.originals.clear();
      live.label = "";
      live.snap = null;
      finishChange();
      return;
    case "boxselect": {
      live.mode = "idle";
      const dragged = Math.hypot(sx - live.boxStart.x, sy - live.boxStart.y) > 4;
      if (!dragged) {
        if (!live.shift) st.selectedShapeIds = [];
      } else {
        const a = toWorld(live.boxStart.x, live.boxStart.y);
        boxSelect(a, live.raw, sx < live.boxStart.x, live.shift);
      }
      finishChange();
      return;
    }
    default:
      break;
  }

  updateSnap();

  if (tool === "line") {
    handleLineClick();
  } else if (tool === "arcCenter") {
    handleCenterArcClick();
  } else if (tool === "arc") {
    handleArcClick();
  } else if (tool === "text") {
    openTextDialog({ ...live.world });
  } else if (live.mode === "dragDraw" && live.dragStart) {
    finishDragDraw(tool);
  }
  // Klick mit getippten Werten: Werte verbraucht. Rechteck & Co. warten ggf. noch auf den zweiten Klick
  if (typedOpen() && !(live.mode === "dragDraw" && live.dragStart)) closeTypedBox();
  redrawFn();
}

function handleLineClick() {
  const p = { ...live.world };
  const pts = live.points;
  if (pts.length === 0) { live.points = [p]; return; }
  const last = pts[pts.length - 1];
  if (Math.hypot(p.x - last.x, p.y - last.y) < screenDist(3)) return; // gleicher Punkt
  const first = pts[0];
  if (pts.length >= 3 && Math.hypot(p.x - first.x, p.y - first.y) < screenDist(8)) {
    finishLine(true);
    return;
  }
  pts.push(p);
}

export function finishLine(close: boolean) {
  const pts = live.points;
  if (pts.length >= 2) {
    const closed = close && pts.length >= 3;
    addShapes([createPolyline(pts.map(p => ({ ...p })), closed, closed ? "outside" : "on-line")]);
  }
  live.points = [];
  live.label = "";
  redrawFn();
}

/** Wert-Eingabe für das Werkzeug „Bedingung“ an der Maus – erst nach dem Loslassen, sonst nimmt die Maus den Fokus */
let lastClient = { x: 0, y: 0 };
if (typeof window !== "undefined") window.addEventListener("mousemove", e => { lastClient = { x: e.clientX, y: e.clientY }; }, true);
function openValue(initial: string, done: (text: string | null) => void) {
  const at = { ...lastClient };
  setTimeout(() => valueInput(at.x, at.y, initial, txt => { done(txt); finishChange(); }), 60);
}

export const lineDimHover = { pick: null as null | { a: Pt; b: Pt; moved: Pt } };

/** Linie bemaßen: Maß setzen und gleich das Eingabefeld öffnen. Kreis: Durchmesser wie beim Größenmaß */
function lineDimClick(world: Pt) {
  const hit = hitTest(world.x, world.y);
  if (!hit) return;
  lineDimHover.pick = null;
  const off = screenDist(26);
  let ref: ReturnType<typeof addLineDim> = null;
  if (hit.type === "circle") {
    addSize(hit, "x", hit.y + Math.abs(hit.w) + off);
    ref = { kind: "size", shapeId: hit.id, idx: hit.dims.length - 1 };
  } else {
    const pick = lineDimPick(hit, world);
    if (pick && "why" in pick) { toolLog(t("linedim.no." + pick.why)); return; }
    ref = addLineDim(hit, world, off);
  }
  if (!ref) return;
  finishChange();
  // Erst nach dem Loslassen: sonst nimmt die Maus dem Feld gleich wieder den Fokus
  const open = ref;
  setTimeout(() => {
    if (!canvasEl) return;
    editDimValue(open, canvasEl, () => {
      if (open.kind === "line" && lastLineDimCrossed) toolLog(t("linedim.crossed"));
      finishChange();
      window.dispatchEvent(new Event("cnc-dims-changed"));
    });
  }, 60);
}

function handleCenterArcClick() {
  const p = { ...live.world };
  const pts = live.points;
  if (pts.length === 0) { live.points = [p]; return; }
  if (pts.length === 1) {
    if (Math.hypot(p.x - pts[0].x, p.y - pts[0].y) < screenDist(3)) return;
    pts.push(p);
    return;
  }
  const a = previewCenterArc();
  if (!a) return;
  live.points = [];
  live.label = "";
  addShapes([createArc(a.start.x, a.start.y, a.end.x, a.end.y, a.mid.x, a.mid.y)]);
}

function handleArcClick() {
  const p = { ...live.world };
  const pts = live.points;
  if (pts.length === 0) { live.points = [p]; return; }
  if (pts.length === 1) {
    if (Math.hypot(p.x - pts[0].x, p.y - pts[0].y) < screenDist(3)) return;
    pts.push(p);
    return;
  }
  // 3. Klick: Wölbung
  const arc = createArc(pts[0].x, pts[0].y, pts[1].x, pts[1].y, p.x, p.y);
  live.points = [];
  addShapes([arc]);
}

/** Bezugspunkt für „@“ in der Befehlszeile: letzter Punkt der laufenden Zeichnung, null = es wird nichts gezeichnet */
export function drawingBase(): Pt | null {
  const tool = currentTool();
  if ((tool === "line" || tool === "arc" || tool === "arcCenter") && live.points.length) return live.points[live.points.length - 1];
  return live.mode === "dragDraw" && live.dragStart ? live.dragStart : null;
}

/** Wie ein Klick an Stelle p (Welt-Pixel) mit dem aktuellen Zeichenwerkzeug – für getippte Punkte. false = Werkzeug zeichnet nicht */
export function placePoint(p: Pt): boolean {
  const tool = currentTool();
  closeTypedBox();
  const mouse = { ...live.raw };
  live.world = { ...p };
  live.raw = { ...p };
  live.snap = null;
  if (tool === "line") handleLineClick();
  else if (tool === "arc") handleArcClick();
  else if (tool === "arcCenter") handleCenterArcClick();
  else if (tool === "text") openTextDialog({ ...p });
  else if (["rect", "ellipse", "circle", "polygon", "star", "slot", "ring", "measure"].includes(tool)) {
    if (live.mode === "dragDraw" && live.dragStart) finishDragDraw(tool);
    else { live.dragStart = { ...p }; live.mode = "dragDraw"; live.clickDraw = true; }
  } else return false;
  // die Vorschau läuft danach wieder zur Maus
  live.raw = mouse;
  updateSnap();
  updateLabel();
  redrawFn();
  return true;
}

function finishDragDraw(tool: ToolName) {
  const start = live.dragStart!;
  live.mode = "idle";
  const w = live.world;
  const size = Math.hypot(w.x - start.x, w.y - start.y);
  const minSize = screenDist(3);

  if (tool === "measure") {
    if (size <= minSize && !live.clickDraw) { live.clickDraw = true; live.mode = "dragDraw"; return; }
    live.clickDraw = false;
    live.measure = size > minSize ? { a: start, b: { ...w } } : null;
    live.dragStart = null;
    live.label = "";
    return;
  }
  live.dragStart = start;
  if (size < minSize) {
    // Klick ohne Ziehen: Startpunkt bleibt, der nächste Klick (oder getippte Maße + Enter) setzt die Form
    if (!live.clickDraw) { live.clickDraw = true; live.mode = "dragDraw"; return; }
    live.dragStart = null; live.clickDraw = false; return;
  }
  live.clickDraw = false;

  if (tool === "rect") {
    const r = dragRect();
    if (Math.abs(r.x1 - r.x0) > 0 && Math.abs(r.y1 - r.y0) > 0) {
      addShapes([createPolyline(makeRectPoints(r.x0, r.y0, r.x1, r.y1, options.rectRadius * MM_TO_PIXEL), true, "outside")]);
    }
  } else if (tool === "circle") {
    // echter Kreis um den ersten Punkt (wird mit G2/G3 gefräst)
    addShapes([createCircle(start.x, start.y, size)]);
  } else if (tool === "ellipse") {
    const r = dragRect();
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    const rx = Math.abs(r.x1 - r.x0) / 2, ry = Math.abs(r.y1 - r.y0) / 2;
    if (rx > 0 && ry > 0) {
      if (Math.abs(rx - ry) < 1e-9) addShapes([createCircle(cx, cy, rx)]);
      else addShapes([createPolyline(makeEllipsePoints(cx, cy, rx, ry), true, "outside")]);
    }
  } else if (tool === "polygon") {
    addShapes([createPolyline(dragPolygonPoints(), true, "outside")]);
  } else if (tool === "star") {
    addShapes([createPolyline(dragStarPoints(), true, "outside")]);
  } else if (tool === "slot") {
    const r = dragRect();
    if (Math.abs(r.x1 - r.x0) > 0 && Math.abs(r.y1 - r.y0) > 0) addShapes([createPolyline(dragSlotPoints(), true, "outside")]);
  } else if (tool === "ring") {
    const inner = ringInner(size, options.ringWall * MM_TO_PIXEL);
    if (inner === null) toolLog(t("ring.tooThickLog"));
    else {
      // Außen und Loch gehören zusammen und bleiben echte Kreise (G2)
      const groupId = "grp-" + newId();
      addShapes([Object.assign(createCircle(start.x, start.y, size), { groupId }), Object.assign(createCircle(start.x, start.y, inner, "inside"), { groupId })]);
    }
  }
  live.dragStart = null;
  live.label = "";
}

// =====================================================================
// DOPPELKLICK, TASTEN, CURSOR
// =====================================================================

export function onDoubleClick(_e: MouseEvent, sx: number, sy: number) {
  const tool = currentTool();
  // Doppelklick auf eine Maßzahl: Wert eingeben
  const d = dimAt(sx, sy);
  if (d && canvasEl) { dimCancel(); editDimValue(d, canvasEl, () => { finishChange(); window.dispatchEvent(new Event("cnc-dims-changed")); }); return; }
  const gc = conAt(sx, sy);
  if (gc) { conEdit(gc, openValue, () => finishChange()); return; }
  if (tool === "line") { finishLine(false); return; }
  if (tool === "node") { if (nodeDblClick(toWorld(sx, sy), sx, sy)) finishChange(); return; }
  if (tool === "pen") { const s = penFinish(false); if (s) addShapes([s]); return; }
  if (tool === "select") {
    const w = toWorld(sx, sy);
    const hit = hitTest(w.x, w.y);
    if (hit && hit.textData) editTextGroup(hit);
    if (hit && hit.qrData) openQrDialog(() => {}, () => finishChange(), hit);
    if (hit && hit.type === "image") openEngraveDialog(hit, undefined, () => finishChange());
  }
}

/** Gibt true zurück, wenn die Taste verarbeitet wurde */
export function onToolKey(e: KeyboardEvent): boolean {
  readModifiers(e);
  const tool = currentTool();
  if (startTyping(e)) return true;
  if (e.key === "Escape") {
    const busy = live.points.length > 0 || live.mode !== "idle" || live.measure || pen.nodes.length > 0 || !!dimTool.a || live.clickDraw || !!pick.cancel;
    dimSel.cur = null;
    if (busy) cancelCurrent();
    else if (tool !== "select") setTool("select");
    else app().selectedShapeIds = [];
    finishChange();
    return true;
  }
  if (e.key === "Enter" && tool === "line" && live.points.length >= 2) {
    finishLine(false);
    return true;
  }
  if (e.key === "Enter" && tool === "pen" && pen.nodes.length) {
    const s = penFinish(false);
    if (s) addShapes([s]);
    redrawFn();
    return true;
  }
  // gewählte Bedingung löschen (nicht die Form)
  if ((e.key === "Delete" || e.key === "Backspace") && conTool.sel) {
    conDeleteSelected();
    finishChange();
    return true;
  }
  // gewähltes Maß löschen (nicht die Form)
  if ((e.key === "Delete" || e.key === "Backspace") && dimSel.cur) {
    deleteDim(dimSel.cur);
    dimSel.cur = null;
    finishChange();
    return true;
  }
  // Punkte bearbeiten: Entf löscht nur den gewählten Knoten, nicht die ganze Form
  if ((e.key === "Delete" || e.key === "Backspace") && tool === "node" && nodeEdit.sel >= 0) {
    nodeDelete();
    finishChange();
    return true;
  }
  return false;
}

export function updateCursor() {
  if (!canvasEl) return;
  const tool = currentTool();
  let c = "default";
  if (live.mode === "panning") c = "grabbing";
  else if (tool === "pan" || live.spaceDown) c = "grab";
  else if (tool === "select") {
    if (live.mode === "rotating") c = "grabbing";
    else if (live.mode === "moving") c = "move";
    else {
      const h = selectedShapes().length ? handleAt(live.screen.x, live.screen.y) : null;
      if (h) c = HANDLE_CURSORS[h.name];
      else if (live.hover || insideSelectionBox(live.screen.x, live.screen.y)) c = "move";
    }
  } else if (tool === "text") c = "text";
  else c = "crosshair";
  canvasEl.style.cursor = c;
}
