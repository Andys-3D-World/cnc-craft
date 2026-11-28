/**
 * ENTWURF IN 3D
 *
 * Dieselbe Zeichnung, derselbe Editor – nur schräg betrachtet: Die Maus wird auf die Material-Oberseite (Z = 0) gerechnet
 * und an die normale Maus-Logik (editor/tools.ts) weitergegeben. Deshalb gehen alle Werkzeuge auch hier: zeichnen, auswählen,
 * verschieben, Griffe, Fang, Maße, Punkte. Die Zeichnung liegt als durchsichtiges Bild auf der Oberseite, darunter steht das
 * Material: beim Fräsen mit dem echten Ergebnis aus dem G-Code (wie „Fräsergebnis“), sonst mit Wänden bis zur Tiefe.
 * Nur Anzeige und Bearbeitung der Formen – an die Maschine geht von hier nichts.
 *
 * Kamera und 2D-Ansicht bleiben gleich: wer den Zoom der Zeichenfläche ändert (Alles zeigen …), ändert auch die Kamera.
 * Beim Ausschalten kommt die alte 2D-Ansicht wieder.
 */
import { t } from "../i18n/i18n";
import { app, bedSizeMm, toScreen } from "./editorState";
import { currentTool, live, onDoubleClick, onMouseDown, updateCursor } from "./tools";
import { drawOverlay, drawStatusBar } from "./overlay";
import { checkpoint } from "./history";
import { selectedShapes } from "./selection";
import { drawEverything, modeColor } from "../render";
import { getTools } from "../toolLibrary";
import { drawTwoSided } from "../ui/twoSidedPanel";
import { drawSplit } from "../ui/splitPanel";
import { generateGcodeFull } from "../cam";
import { isLaser, isLathe, isMill, isPlasma, MODE_CHANGED } from "../machineMode";
import { machine } from "../machine";
import { isKeepOut, keepValues } from "../keepOut";
import { rotary } from "../rotary";
import { MM_TO_PIXEL, groupBounds, isClosedShape, shapeToPaths } from "../shapeTransform";
import { getStock, ownStock } from "../stock";
import { isLight } from "../theme";
import { activePlace } from "../placesStore";
import { jaws, type Rect } from "../places";
import { rackParts } from "../rackView";
import { layerForShape } from "../laserLayers";
import { cutForShape } from "../plasmaCuts";

import { MATERIALS, materialView } from "../materialView";
import { carve, type CarveResult } from "../view3d/carveSim";
import { carveScene } from "../view3d/scenes";
import { fmtLenU } from "../units";
import { updateDimensionInputs } from "../uiInputs";
import { setPlaneMouse } from "../mouseEngine";
import { openCanvasMenu } from "../ui/contextMenu";
import { Design3dGl, type Mesh3 } from "./design3dGl";
import { allFeatures, bodyNow } from "../ui/bodyDialog";
import { shellMeshes, shellBounds } from "../view3d/solid";
import { clampCam, cropGrid, distFor, dragDepth, frameRects, matrix, MAX_EL, onPlane, project, pxPerMm, zoomAt, type Box, type Cam, type View } from "./design3dMath";

const KEY = "cnc_craft_design3d";
const BAR = 22;                 // Statuszeile der Zeichenfläche bleibt unten sichtbar
const CARVE_CELLS = 600_000;    // gröber als das Fenster „3D-Ansicht“: hier wird nach jeder Änderung neu gerechnet
const MAX_POINTS = 150_000;     // mehr Wände zeichnet der Entwurf nicht

let redraw = () => {};
let log: (s: string) => void = () => {};
let base: HTMLCanvasElement | null = null;       // normale Zeichenfläche
let el: HTMLCanvasElement | null = null;         // 3D-Bild
let ui: HTMLElement | null = null;
let gl: Design3dGl | null = null;
let cam: Cam = { tx: 150, ty: 150, dist: 500, yaw: -0.45, el: 0.75 };
let saved2d = { scale: 1, offsetX: 0, offsetY: 0 };
let wrote = { scale: 0, offsetX: 0, offsetY: 0 };
let sheetAt = "";                                // Kamera, für die das Zeichnungs-Bild gemalt wurde
let showResult = true;
let lastFar: { x: number; y: number } | null = null;

export function design3dOn(): boolean { return !!el; }

const view = (): View => ({ w: Math.max(1, el!.clientWidth), h: Math.max(1, el!.clientHeight) });
const canShow = () => !isLathe() && !(rotary.on && !isPlasma());

export function initDesign3d(canvas: HTMLCanvasElement, redrawFn: () => void, logFn: (s: string) => void) {
  base = canvas; redraw = redrawFn; log = logFn;
  try { showResult = JSON.parse(localStorage.getItem(KEY) || "{}").result !== false; } catch { /* Standard */ }
  document.getElementById("btn-design3d")?.addEventListener("click", () => toggleDesign3d());
  window.addEventListener(MODE_CHANGED, () => { if (el && !canShow()) close(); });
  for (const e of ["cnc-stock-changed", "cnc-places-changed", "cnc-magazine-changed"])
    window.addEventListener(e, () => { if (!el) return; if (!canShow()) { close(); return; } carveKey = ""; redraw(); });
}

export function toggleDesign3d() {
  if (el) { close(); return; }
  if (!base) return;
  if (!canShow()) { log(t("d3.notHere")); return; }
  open();
}

// ---------------------------------------------------------------------
// Ein / Aus
// ---------------------------------------------------------------------

function open() {
  const holder = base!.parentElement!;
  holder.style.position = "relative";
  const c = document.createElement("canvas");
  c.id = "design3d";
  c.className = "design3d";
  holder.appendChild(c);
  gl = new Design3dGl(c);
  if (!gl.ok) { c.remove(); gl = null; log(t("v3d.noGl")); return; }
  el = c;
  const st = app();
  saved2d = { scale: st.scale, offsetX: st.offsetX, offsetY: st.offsetY };
  ui = document.createElement("div");
  ui.className = "design3d-ui";
  ui.innerHTML = `
    <div class="design3d-bar">
      <button type="button" class="btn-secondary btn-compact" data-v="top"></button>
      <button type="button" class="btn-secondary btn-compact" data-v="3d"></button>
      <button type="button" class="btn-secondary btn-compact" data-v="front"></button>
      <label class="eng-ck only-mill"><input type="checkbox" id="d3-result"> <span></span></label>
      <span class="design3d-info" id="d3-info"></span>
    </div>
    <div class="design3d-hint"></div>
    <button type="button" class="design3d-depth" id="d3-depth" style="display:none;"></button>`;
  holder.appendChild(ui);
  const q = (s: string) => ui!.querySelector<HTMLElement>(s)!;
  q('[data-v="top"]').textContent = t("sim.viewTop");
  q('[data-v="3d"]').textContent = "3D";
  q('[data-v="front"]').textContent = t("sim.viewFront");
  q(".eng-ck span").textContent = t("v3d.modeCarve");
  q(".design3d-hint").textContent = t("d3.hint");
  ui.querySelectorAll<HTMLElement>("[data-v]").forEach(b => b.addEventListener("click", () => {
    const v = b.dataset.v;
    setCam({ ...cam, yaw: v === "3d" ? -0.45 : 0, el: v === "top" ? MAX_EL : v === "front" ? 0.2 : 0.75 });
  }));
  const ck = ui.querySelector<HTMLInputElement>("#d3-result")!;
  ck.checked = showResult;
  ck.addEventListener("change", () => {
    showResult = ck.checked;
    try { localStorage.setItem(KEY, JSON.stringify({ result: showResult })); } catch { /* egal */ }
    carveKey = ""; wallsKey = ""; redraw();
  });
  document.getElementById("btn-design3d")?.classList.add("active");
  wrote = { scale: 0, offsetX: 0, offsetY: 0 };
  cam = { ...cam, yaw: -0.45, el: 0.75 };
  from2d();
  carve3d = null; carveKey = ""; carveGcode = ""; blockKey = ""; wallsKey = ""; bedKey = ""; sheetAt = "";
  bindMouse(c);
  depthHandle(q("#d3-depth"));
  setPlaneMouse(toEditor, c);
  redraw();
}

function close() {
  if (!el) return;
  setPlaneMouse(null, null);
  clearTimeout(carveTimer); clearTimeout(sheetTimer);
  carveRun++;
  gl?.destroy(); gl = null;
  el.remove(); ui?.remove();
  el = null; ui = null;
  document.getElementById("btn-design3d")?.classList.remove("active");
  Object.assign(app(), saved2d);
  redraw();
}

// ---------------------------------------------------------------------
// Kamera ↔ Ansicht der Zeichenfläche
// ---------------------------------------------------------------------

/** 2D-Ansicht → Kamera (beim Einschalten und wenn z. B. „Alles zeigen“ den Zoom geändert hat) */
function from2d() {
  const st = app(), b = base!, bedH = bedSizeMm().h * MM_TO_PIXEL, v = { w: b.width, h: Math.max(1, b.height - BAR) };
  const x = (v.w / 2 - st.offsetX) / st.scale / MM_TO_PIXEL, y = (bedH - (v.h / 2 - st.offsetY) / st.scale) / MM_TO_PIXEL;
  cam = clampCam({ ...cam, tx: x, ty: y, dist: distFor(st.scale * MM_TO_PIXEL, v) });
  to2d();
}
/** Kamera → 2D-Ansicht: gleich viele Pixel je mm, gleiche Mitte. So passen Griffe, Fang und Klick-Abstände */
function to2d() {
  const st = app(), b = base!, bedH = bedSizeMm().h * MM_TO_PIXEL, v = { w: b.width, h: Math.max(1, b.height - BAR) };
  st.scale = pxPerMm(cam, v) / MM_TO_PIXEL;
  st.offsetX = v.w / 2 - cam.tx * MM_TO_PIXEL * st.scale;
  st.offsetY = v.h / 2 - (bedH - cam.ty * MM_TO_PIXEL) * st.scale;
  wrote = { scale: st.scale, offsetX: st.offsetX, offsetY: st.offsetY };
}
function setCam(c: Cam) { cam = clampCam(c); to2d(); redraw(); }

/** Maus im 3D-Bild → Pixel der Zeichenfläche (für die Maus-Logik des Editors) */
function toEditor(e: MouseEvent): { x: number; y: number } {
  const r = el!.getBoundingClientRect();
  const p = onPlane(cam, view(), e.clientX - r.left, e.clientY - r.top) || lastFar;
  if (!p) return { x: 0, y: 0 };
  lastFar = p;
  return toScreen(p.x * MM_TO_PIXEL, p.y * MM_TO_PIXEL);
}

// ---------------------------------------------------------------------
// Maus: rechts/Hand = drehen, Mitte = verschieben, Rad = Zoom, links = Editor
// ---------------------------------------------------------------------

function bindMouse(c: HTMLCanvasElement) {
  let mode: "" | "orbit" | "pan" = "", lx = 0, ly = 0, moved = 0, menu: MouseEvent | null = null;
  const local = (e: MouseEvent) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const move = (e: MouseEvent) => {
    if (!mode || !el) return;
    const dx = e.clientX - lx, dy = e.clientY - ly;
    if (mode === "pan") {
      const r = c.getBoundingClientRect(), v = view();
      const a = onPlane(cam, v, lx - r.left, ly - r.top), b = onPlane(cam, v, e.clientX - r.left, e.clientY - r.top);
      if (a && b) setCam({ ...cam, tx: cam.tx + a.x - b.x, ty: cam.ty + a.y - b.y });
    } else setCam({ ...cam, yaw: cam.yaw + dx * 0.008, el: cam.el + dy * 0.008 });
    moved += Math.abs(dx) + Math.abs(dy);
    lx = e.clientX; ly = e.clientY;
  };
  const up = () => {
    window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
    const was = mode, m = menu;
    mode = ""; menu = null;
    // Rechtsklick ohne Ziehen: wie in 2D (Linie beenden, Abbrechen oder Menü)
    if (was === "orbit" && m && moved < 5 && el) {
      const p = toEditor(m);
      onMouseDown(m, p.x, p.y);
      if (live.menuOk) { live.menuOk = false; const w = onPlane(cam, view(), local(m).x, local(m).y); if (w) openCanvasMenu(m.clientX, m.clientY, p.x, p.y, w.x * MM_TO_PIXEL, w.y * MM_TO_PIXEL); }
    }
  };
  c.addEventListener("contextmenu", e => e.preventDefault());
  // vor der Editor-Maus (mouseEngine hängt am selben Bild): Drehen und Verschieben fangen wir ab
  c.addEventListener("mousedown", e => {
    const hand = e.button === 0 && (currentTool() === "pan" || live.spaceDown);
    if (e.button === 0 && !hand) return;
    e.preventDefault(); e.stopImmediatePropagation();
    (document.activeElement as HTMLElement | null)?.blur?.();
    mode = e.button === 1 || (hand && (live.spaceDown || e.shiftKey)) || (e.button === 2 && e.shiftKey) ? "pan" : "orbit";
    menu = e.button === 2 && !e.shiftKey ? e : null;
    lx = e.clientX; ly = e.clientY; moved = 0;
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  });
  c.addEventListener("wheel", e => {
    e.preventDefault();
    const p = local(e);
    setCam(zoomAt(cam, onPlane(cam, view(), p.x, p.y), e.deltaY < 0 ? 1 / 1.15 : 1.15));
  }, { passive: false });
  c.addEventListener("dblclick", e => { const p = toEditor(e); onDoubleClick(e, p.x, p.y); redraw(); });
  c.addEventListener("mousemove", () => { updateCursor(); c.style.cursor = base!.style.cursor; });
}

/** Griff an der Unterkante der Auswahl: Tiefe mit der Maus ziehen (nur Fräse) */
function depthHandle(h: HTMLElement) {
  let start: { y: number; z: number } | null = null;
  h.addEventListener("pointerdown", e => {
    const s = depthShapes();
    if (!s.length) return;
    e.preventDefault(); e.stopPropagation();
    start = { y: e.clientY, z: Number(s[0].millingDepth) || 0 };
    h.setPointerCapture(e.pointerId);
  });
  h.addEventListener("pointermove", e => {
    if (!start) return;
    const z = dragDepth(cam, view(), start.z, e.clientY - start.y, 300, e.shiftKey ? 0.01 : 0.1);
    depthShapes().forEach((s: any) => { s.millingDepth = z; });
    updateDimensionInputs(null);
    redraw();
  });
  const end = () => { if (!start) return; start = null; checkpoint(); redraw(); };
  h.addEventListener("pointerup", end);
  h.addEventListener("pointercancel", end);
}
const depthShapes = () => isMill() ? selectedShapes().filter((s: any) => !isKeepOut(s) && s.type !== "image") : [];

// ---------------------------------------------------------------------
// Szene
// ---------------------------------------------------------------------

const mm = (v: number) => v / MM_TO_PIXEL;
const rgb = (hex: string): [number, number, number] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/** Dicke des Materials: eingetragen, sonst aus der Zeichnung */
function thickness(): number {
  const s = getStock();
  if (s.thick > 0) return s.thick;
  const list = app().shapes as any[];
  if (isLaser()) return Math.max(0.5, ...list.map(x => layerForShape(x)?.thickness || 0), 3);
  if (isPlasma()) return Math.max(0.5, ...list.map(x => cutForShape(x)?.thickness || 0), 2);
  return Math.max(6, ...list.filter(x => !isKeepOut(x)).map(x => Math.abs(Number(x.millingDepth) || 0)));
}

/** Fläche des Materials: eingetragenes Rohteil, sonst rund um die Zeichnung */
function blockRect(): Box | null {
  const s = ownStock();
  if (s) return { x0: s.x, y0: s.y, x1: s.x + s.w, y1: s.y + s.h };
  const b = groupBounds((app().shapes as any[]).filter(x => !isKeepOut(x)));
  return b ? { x0: mm(b.minX) - 12, y0: mm(b.minY) - 12, x1: mm(b.maxX) + 12, y1: mm(b.maxY) + 12 } : null;
}

function box(r: Box, z0: number, z1: number, color: [number, number, number], alpha = 1): Mesh3 {
  const m: Mesh3 = { pos: [], nrm: [], color, alpha };
  const quad = (p: number[][], n: number[]) => { for (const i of [0, 1, 2, 0, 2, 3]) { m.pos.push(...p[i]); m.nrm.push(...n); } };
  const { x0, y0, x1, y1 } = r;
  quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]);
  quad([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [0, 0, -1]);
  quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
  quad([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0]);
  quad([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], [-1, 0, 0]);
  quad([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0]);
  return m;
}

function cylinder(x: number, y: number, r: number, z0: number, z1: number, color: [number, number, number]): Mesh3 {
  const m: Mesh3 = { pos: [], nrm: [], color }, N = 24;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * 2 * Math.PI, b = ((i + 1) / N) * 2 * Math.PI, c0 = Math.cos(a), s0 = Math.sin(a), c1 = Math.cos(b), s1 = Math.sin(b);
    const p = (c: number, q: number, z: number) => [x + c * r, y + q * r, z];
    m.pos.push(...p(c0, s0, z0), ...p(c1, s1, z0), ...p(c1, s1, z1), ...p(c0, s0, z0), ...p(c1, s1, z1), ...p(c0, s0, z1), x, y, z1, ...p(c0, s0, z1), ...p(c1, s1, z1));
    m.nrm.push(c0, s0, 0, c1, s1, 0, c1, s1, 0, c0, s0, 0, c1, s1, 0, c0, s0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1);
  }
  return m;
}

let bedKey = "";
function buildBed(T: number) {
  const b = bedSizeMm(), key = `${b.w}|${b.h}|${T}|${isLight()}`;
  if (key === bedKey) return;
  bedKey = key;
  const step = Math.max(b.w, b.h) > 2500 ? 100 : Math.max(b.w, b.h) > 800 ? 50 : 10, z = -T - 0.05;
  const grid: Mesh3 = { pos: [], nrm: [], lines: true, color: isLight() ? [0.78, 0.78, 0.82] : [0.2, 0.2, 0.25] };
  const edge: Mesh3 = { pos: [], nrm: [], lines: true, color: [1, 0.3, 0.3] };
  const line = (m: Mesh3, ...p: number[]) => { m.pos.push(...p); m.nrm.push(0, 0, 1, 0, 0, 1); };
  for (let x = step; x < b.w; x += step) line(grid, x, 0, z, x, b.h, z);
  for (let y = step; y < b.h; y += step) line(grid, 0, y, z, b.w, y, z);
  line(edge, 0, 0, z, b.w, 0, z); line(edge, b.w, 0, z, b.w, b.h, z); line(edge, b.w, b.h, z, 0, b.h, z); line(edge, 0, b.h, z, 0, 0, z);
  const plate = box({ x0: 0, y0: 0, x1: b.w, y1: b.h }, z - 1, z - 0.05, isLight() ? [0.93, 0.93, 0.95] : [0.1, 0.1, 0.12]);
  gl!.set("bed", [plate, grid, edge]);
}

/** Ergebnis aus dem G-Code; wird nach Änderungen im Hintergrund neu gerechnet */
let carve3d: CarveResult | null = null;
let carveKey = "", carveGcode = "", carveTimer = 0, carveRun = 0, carveWait = 500;
let blockKey = "";
const wantCarve = () => showResult && isMill() && !machine.job.active && !bodyPreferred();

function scheduleCarve() {
  if (!wantCarve()) { if (carve3d) { carve3d = null; carveGcode = ""; blockKey = ""; wallsKey = ""; redraw(); } return; }
  clearTimeout(carveTimer);
  carveTimer = window.setTimeout(runCarve, carveWait);
}

async function runCarve() {
  if (!el || !wantCarve() || live.mode !== "idle") return;
  const shapes = app().shapes as any[];
  const key = JSON.stringify([shapes, getTools()]);
  if (key === carveKey) return;
  carveKey = key;
  const my = ++carveRun;
  if (!shapes.some(s => !isKeepOut(s))) { carve3d = null; carveGcode = ""; blockKey = ""; info(""); redraw(); return; }
  const t0 = performance.now();
  let g: string | null = null, tools: Awaited<ReturnType<typeof generateGcodeFull>>["sectionTools"] = [];
  try { const made = await generateGcodeFull(shapes, { flat: true, preview: true }); g = made.gcode; tools = made.sectionTools; } catch { g = null; }
  if (my !== carveRun || !el) return;
  const gk = (g || "") + JSON.stringify(tools);
  if (gk === carveGcode) return;
  info(t("v3d.carving", { p: 0 }));
  const res = g ? await carve(g.split("\n"), tools, f => {
    if (my !== carveRun || !el) return false;
    info(t("v3d.carving", { p: Math.round(f * 100) }));
    return true;
  }, CARVE_CELLS) : null;
  if (my !== carveRun || !el) return;
  carve3d = res; carveGcode = gk; blockKey = ""; wallsKey = "";
  carveWait = Math.min(4000, Math.max(500, (performance.now() - t0) * 2)); // große Zeichnung: seltener rechnen
  info("");
  redraw();
}
function info(s: string) { const i = ui?.querySelector("#d3-info"); if (i) i.textContent = s; }

function buildBlock(T: number) {
  const r = blockRect(), mat = materialView() || MATERIALS[0];
  const key = JSON.stringify([r, T, mat.id, carve3d ? carveRun : 0, isLaser(), isPlasma(), bodyShown()]);
  if (key === blockKey) return;
  blockKey = key;
  if (!r) { gl!.set("block", []); return; }
  const c: [number, number, number] = isPlasma() ? [0.55, 0.57, 0.6] : [mat.base[0] / 255, mat.base[1] / 255, mat.base[2] / 255];
  const crop = carve3d ? cropGrid(carve3d, r) : null;
  // 3D-Körper sichtbar: Material nur noch als Hauch, damit man den Körper darin sieht
  if (!crop) { gl!.set("block", [box(r, -T, -0.02, c, bodyShown() ? 0.22 : carve3d || !wantCarve() ? 1 : 0.55)]); return; }
  const inner = { x0: crop.x0 + crop.cell / 2, y0: crop.y0 + crop.cell / 2, x1: crop.x0 + (crop.nx - 0.5) * crop.cell, y1: crop.y0 + (crop.ny - 0.5) * crop.cell };
  gl!.set("block", [
    ...carveScene(crop, mat, T).map(m => ({ ...m, offset: [0, 0, -T] as [number, number, number] })),
    // Rest des Rohteils um das gerechnete Stück; Farbe wie die Oberseite dort (nur angedeutete Maserung)
    ...frameRects(r, inner).map(f => box(f, -T, 0, c))
  ]);
}

/**
 * 3D-KÖRPER (Fenster „3D-Körper“) im Entwurf: Oberkante des Körpers auf Z 0 (Material-Oberseite) – genau so, wie
 * „Fräsformen erzeugen“ ihn fräsen würde. Nicht zusammen mit dem gerechneten Fräsergebnis (das zeigt dann schon das Ergebnis).
 */
let bodyKey = "";
const hasBody = () => isMill() && allFeatures().some(e => !e.f.off);
/** Körper da, aber noch keine Fräsformen daraus: dann ist das Fräsergebnis der Skizze sinnlos – der Körper wird gezeigt */
function bodyPreferred(): boolean { return hasBody() && !app().shapes.some((s: any) => s.from3d); }
const bodyShown = () => hasBody() && (bodyPreferred() || !carve3d);
function buildBody() {
  if (!bodyShown()) { if (bodyKey) { bodyKey = ""; gl!.set("body", []); } return; }
  const st = app();
  const ids = new Set(allFeatures().flatMap(e => e.f.profile));
  const key = JSON.stringify([allFeatures().map(e => e.f), st.shapes.filter((s: any) => ids.has(s.id)).map((s: any) => [s.id, s.x, s.y, s.w, s.h, s.midX, s.midY, s.points?.length, s.points?.[0], s.points?.[s.points.length >> 1]])]);
  if (key === bodyKey) return;
  bodyKey = key;
  const shells = bodyNow(), b = shellBounds(shells);
  if (!b) { gl!.set("body", []); return; }
  gl!.set("body", shellMeshes(shells).map(m => ({ ...m, color: [0.45, 0.66, 0.9] as [number, number, number], offset: [0, 0, -b.z1] as [number, number, number] })));
}

let wallsKey = "";
function buildWalls(T: number) {
  const st = app(), sel = new Set<string>(st.selectedShapeIds), fresh = !!carve3d;
  const key = JSON.stringify([st.shapes.map((s: any) => [s.id, s.x, s.y, s.w, s.h, s.midX, s.midY, s.radius, s.millingDepth, s.millingMode, s.keepOut, s.points?.length, s.points?.[0], s.points?.[s.points.length >> 1]]), st.selectedShapeIds, T, fresh, isLight(), activePlace(), getStock().w, getStock().h, getStock().x, getStock().y, rackParts()]);
  if (key === wallsKey) return;
  wallsKey = key;
  const out: Mesh3[] = [], byColor = new Map<string, Mesh3>();
  let points = 0;
  for (const s of st.shapes as any[]) {
    if (s.type === "image") continue;
    const ko = isKeepOut(s), on = sel.has(s.id);
    // Ergebnis ist zu sehen: Wände nur für die Auswahl und die Sperrzonen, sonst wird es unübersichtlich
    if (fresh && !on && !ko) continue;
    const zTop = ko ? keepValues(s).height : 0, z = ko ? -T : isMill() ? Math.min(0, Number(s.millingDepth) || 0) : -T;
    const color = ko ? "#ff4d4d" : on ? (isLight() ? "#12924f" : "#34d17b") : isLaser() ? layerForShape(s)?.color || "#ff4040" : isPlasma() ? "#ff9f43" : modeColor(s.millingMode);
    let wall = byColor.get(color + ko), lines = byColor.get("L" + color + ko);
    if (!wall) { wall = { pos: [], nrm: [], color: rgb(color), alpha: ko ? 0.3 : 0.28 }; byColor.set(color + ko, wall); out.push(wall); }
    if (!lines) { lines = { pos: [], nrm: [], color: rgb(color), lines: true, alpha: 0.95 }; byColor.set("L" + color + ko, lines); out.push(lines); }
    for (const p of shapeToPaths(s)) {
      if ((points += p.pts.length) > MAX_POINTS) break;
      const n = p.closed ? p.pts.length : p.pts.length - 1;
      for (let i = 0; i < n; i++) {
        const a = p.pts[i], b = p.pts[(i + 1) % p.pts.length];
        const ax = mm(a.x), ay = mm(a.y), bx = mm(b.x), by = mm(b.y), L = Math.hypot(bx - ax, by - ay) || 1, nx = (by - ay) / L, ny = -(bx - ax) / L;
        wall.pos.push(ax, ay, z, bx, by, z, bx, by, zTop, ax, ay, z, bx, by, zTop, ax, ay, zTop);
        for (let k = 0; k < 6; k++) wall.nrm.push(nx, ny, 0);
        lines.pos.push(ax, ay, z, bx, by, z);
        lines.nrm.push(0, 0, 1, 0, 0, 1);
        if (ko) { lines.pos.push(ax, ay, zTop, bx, by, zTop); lines.nrm.push(0, 0, 1, 0, 0, 1); }
      }
      // einzelne Punkte (Bohren): senkrechter Strich, damit man die Tiefe sieht
      if (!isClosedShape(s) || s.millingMode === "drill") { const b = groupBounds([s]); if (b) { const x = mm((b.minX + b.maxX) / 2), y = mm((b.minY + b.maxY) / 2); lines.pos.push(x, y, 0, x, y, z); lines.nrm.push(0, 0, 1, 0, 0, 1); } }
    }
  }
  const pl = activePlace(), j = pl && jaws(pl, getStock());
  if (pl && j) for (const r of [j.fixed, j.moving] as Rect[]) out.push(box({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }, -T, pl.jawZ, [0.5, 0.53, 0.58], 0.8));
  // Werkzeugreihe: Halter bis zur Oberseite, darauf der Werkzeughalter mit einem Ring in der Werkzeugfarbe (Platz leer: nur Halter)
  for (const p of rackParts()) {
    const r = p.size / 2;
    out.push(box({ x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r }, -T, -0.05, [0.36, 0.39, 0.44]));
    if (p.color) out.push(cylinder(p.x, p.y, r * 0.62, 0, p.top * 0.3, rgb(p.color)), cylinder(p.x, p.y, r * 0.45, 0, p.top, [0.66, 0.69, 0.74]));
  }
  gl!.set("walls", out);
}

// ---------------------------------------------------------------------
// Bild
// ---------------------------------------------------------------------

let sheetCv: HTMLCanvasElement | null = null, sheetTimer = 0;
/** Zeichnung mit Griffen, Fang und Vorschau durchsichtig malen und auf die Oberseite legen */
function paintSheet() {
  const st = app(), b = base!;
  const PAD = 0.35, W = Math.min(4096, Math.round(b.width * (1 + 2 * PAD))), H = Math.min(4096, Math.round((b.height - BAR) * (1 + 2 * PAD)));
  const px = Math.round((W - b.width) / 2), py = Math.round((H - (b.height - BAR)) / 2);
  sheetCv ??= document.createElement("canvas");
  if (sheetCv.width !== W || sheetCv.height !== H) { sheetCv.width = W; sheetCv.height = H; }
  const c = sheetCv.getContext("2d")!;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, W, H);
  drawEverything(c, sheetCv, st.shapes, st.selectedShapeIds, st.offsetX + px, st.offsetY + py, st.scale, true);
  c.setTransform(1, 0, 0, 1, px, py);
  drawTwoSided(c); drawSplit(c);
  drawOverlay(c, sheetCv, false);
  const bedH = bedSizeMm().h * MM_TO_PIXEL;
  const wx = (x: number) => (x - px - st.offsetX) / st.scale / MM_TO_PIXEL, wy = (y: number) => (bedH - (y - py - st.offsetY) / st.scale) / MM_TO_PIXEL;
  gl!.sheet(sheetCv, { x0: wx(0), x1: wx(W), y0: wy(H), y1: wy(0) }, 0.03);
}

/** Ein Bild malen (statt der 2D-Zeichnung, aufgerufen aus main.ts) */
export function paintDesign3d(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
  if (!el || !gl) return;
  const st = app();
  if (st.scale !== wrote.scale || st.offsetX !== wrote.offsetX || st.offsetY !== wrote.offsetY) from2d();
  const dpr = Math.min(2, window.devicePixelRatio || 1), v = view();
  const W = Math.round(v.w * dpr), H = Math.round(v.h * dpr);
  if (el.width !== W || el.height !== H) { el.width = W; el.height = H; }
  const T = thickness();
  buildBed(T); buildBlock(T); buildWalls(T); buildBody();
  // Kamera bewegt sich: das alte Bild der Zeichnung behalten und erst beim Stehenbleiben neu malen
  const at = JSON.stringify([cam, v]);
  clearTimeout(sheetTimer);
  if (at === sheetAt || !sheetAt) { paintSheet(); sheetAt = at; }
  else sheetTimer = window.setTimeout(() => { sheetAt = JSON.stringify([cam, el ? view() : v]); redraw(); }, 90);
  const bed = bedSizeMm();
  gl.draw(W, H, matrix(cam, v, Math.max(bed.w, bed.h)), isLight() ? [0.89, 0.89, 0.92] : [0.06, 0.06, 0.08]);
  // Tiefen-Griff
  const h = ui!.querySelector<HTMLElement>("#d3-depth")!, ds = depthShapes(), b = ds.length ? groupBounds(ds) : null;
  const z = ds.length ? Number(ds[0].millingDepth) || 0 : 0;
  const p = b && live.mode === "idle" && cam.el < 1.4 ? project(cam, v, mm((b.minX + b.maxX) / 2), mm((b.minY + b.maxY) / 2), z) : null;
  h.style.display = p ? "" : "none";
  if (p) { h.style.left = `${p.x}px`; h.style.top = `${p.y}px`; h.textContent = `↕ ${fmtLenU(-z)}`; h.title = t("d3.depthTip"); }
  // Statuszeile auf der normalen Zeichenfläche
  ctx.clearRect(0, canvas.height - BAR, canvas.width, BAR);
  drawStatusBar(ctx, canvas, currentTool());
  scheduleCarve();
}
