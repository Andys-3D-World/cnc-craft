/**
 * BEARBEITUNGS-WERKZEUGE MIT EIGENEM FENSTER: Array, …
 * Die Rechnung liegt jeweils in einem eigenen Modul mit Tests; hier nur Oberfläche und Übernahme in die Zeichnung.
 * Vorschau über livePreview (nicht in app().shapes), daher ergibt jede Übernahme genau einen Rückgängig-Schritt.
 */
import { app, bedSizeMm, screenDist, toWorld } from "./editorState";
import { checkpoint } from "./history";
import { selectedShapes } from "./selection";
import { snapPoint } from "./snap";
import { makeCopies } from "./commands";
import { livePreview } from "./livePreview";
import { gridOffsets, gridStep, polarPlacements } from "./arrayGeom";
import { simplifyPath } from "./simplify";
import { findDuplicates } from "./dedupe";
import { normalizePath, piecesFromSpans } from "./trim";
import { machineKind } from "./overlay";
import { createImageShape } from "../raster/imageShape";
import { NO_ADJUST, presetSettings } from "../raster/dither";
import { getLayers } from "../laserLayers";
import { rasterPlan } from "./toImage";
import { applyFit, fitProblem, orderMarks, twoPointFit } from "./printCut";
import { machine } from "../machine";
import { isLaser } from "../machineMode";
import { CutDir, cutDirOf, cutMark, cutStartOf, effectiveDirection, fractionAt, isClimb } from "../cutSetting";
import { MM_TO_PIXEL, Path, Pt, distanceToShape, groupBounds, rotateShape, shapeBounds, shapeToPaths, shearShape, translateShape, updatePolylineBounds } from "../shapeTransform";
import { updateDimensionInputs } from "../uiInputs";
import { t } from "../i18n/i18n";
import { openToolPanel, rowCss, checkCss, ToolPanel } from "../ui/toolPanel";
import { icon } from "../ui/icons";
import { esc } from "../setupSheet";

let redrawFn: () => void = () => {};
let log: (s: string) => void = () => {};
let canvasEl: HTMLCanvasElement | null = null;

export function initEditTools(canvas: HTMLCanvasElement, redraw: () => void, appendToConsole: (s: string) => void) {
  canvasEl = canvas;
  redrawFn = redraw;
  log = appendToConsole;
}

function commit() {
  updateDimensionInputs(null);
  redrawFn();
  checkpoint();
}

/** Umrisse einer Form für die Vorschau; Bilder haben keine Linien, von ihnen zeigen wir den Rahmen */
function outlineOf(s: any): Path[] {
  const paths = shapeToPaths(s);
  if (paths.length) return paths;
  const b = shapeBounds(s);
  return b ? [{ closed: true, pts: [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }] }] : [];
}

/** Nächster Klick auf die Zeichenfläche liefert einen Punkt (mit Fang) und wählt nichts aus */
function pickPoint(onPick: (p: Pt) => void) {
  const c = canvasEl;
  if (!c) return;
  const cancel = () => { window.removeEventListener("mousedown", down, true); window.removeEventListener("keydown", key, true); c.style.cursor = ""; };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } };
  const down = (e: MouseEvent) => {
    if (e.target !== c) { cancel(); return; }
    e.stopPropagation(); e.preventDefault();
    cancel();
    const r = c.getBoundingClientRect();
    const w = toWorld((e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height));
    const sn = snapPoint(w.x, w.y);
    onPick({ x: sn.x, y: sn.y });
  };
  c.style.cursor = "crosshair";
  window.addEventListener("mousedown", down, true);
  window.addEventListener("keydown", key, true);
}

// =====================================================================
// ARRAY: Raster und Kreis
// =====================================================================

const ARRAY_KEY = "cnc_craft_array";
const MAX_SETS = 2500;
const MAX_PREVIEW_POINTS = 300_000;

interface ArrayOptions {
  kind: "grid" | "polar";
  cols: number; rows: number; spacing: "gap" | "pitch"; gapX: number; gapY: number;
  count: number; total: number; rotate: boolean;
}

function loadArrayOptions(): ArrayOptions {
  const def: ArrayOptions = { kind: "grid", cols: 3, rows: 2, spacing: "gap", gapX: 5, gapY: 5, count: 6, total: 360, rotate: true };
  try { return { ...def, ...JSON.parse(localStorage.getItem(ARRAY_KEY) || "{}") }; } catch { return def; }
}

type Placement = (s: any) => void;

/** Eine Anordnung: Liste der Kopien (je eine Funktion, die eine geklonte Form an ihren Platz bringt) */
function arrayPlacements(p: ToolPanel, sel: any[]): { list: Placement[]; opts: ArrayOptions; center: Pt | null } {
  const b = groupBounds(sel)!;
  const kind = p.$<HTMLSelectElement>("#arr-kind").value as "grid" | "polar";
  const old = loadArrayOptions();
  if (kind === "grid") {
    const cols = Math.max(1, Math.round(p.num("#arr-cols", 1))), rows = Math.max(1, Math.round(p.num("#arr-rows", 1)));
    const spacing = p.$<HTMLSelectElement>("#arr-spacing").value as "gap" | "pitch";
    const gapX = p.num("#arr-gapx"), gapY = p.num("#arr-gapy");
    const stepX = gridStep(spacing, b.maxX - b.minX, gapX * MM_TO_PIXEL), stepY = gridStep(spacing, b.maxY - b.minY, gapY * MM_TO_PIXEL);
    const list = gridOffsets(cols, rows, stepX, stepY).map(o => (s: any) => translateShape(s, o.dx, o.dy));
    return { list, center: null, opts: { ...old, kind, cols, rows, spacing, gapX, gapY } };
  }
  const count = Math.max(1, Math.round(p.num("#arr-count", 1)));
  const total = p.num("#arr-total", 360), rotate = p.check("#arr-rotate");
  const center = { x: p.num("#arr-cx") * MM_TO_PIXEL, y: p.num("#arr-cy") * MM_TO_PIXEL };
  const from = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  const list = polarPlacements(count, center.x, center.y, from, (total * Math.PI) / 180)
    .map(q => (s: any) => { if (rotate) rotateShape(s, center.x, center.y, q.angle); else translateShape(s, q.dx, q.dy); });
  return { list, center, opts: { ...old, kind, count, total, rotate } };
}

export function openArrayDialog() {
  const sel = selectedShapes();
  if (!sel.length) { log(t("array.selectFirst")); return; }
  const b = groupBounds(sel);
  if (!b) { log(t("array.selectFirst")); return; }
  const o = loadArrayOptions();
  // Mittelpunkt vorbelegen: unter der Auswahl, so bleibt die Auswahl oben im Kreis
  const cxMm = (b.minX + b.maxX) / 2 / MM_TO_PIXEL;
  const cyMm = (b.minY - Math.max(b.maxY - b.minY, 20 * MM_TO_PIXEL)) / MM_TO_PIXEL;
  const fmt = (v: number) => String(Math.round(v * 100) / 100);
  const input = (id: string, val: number, step: string, extra = "") => `<input id="${id}" type="number" value="${val}" step="${step}" ${extra} style="width:90px;">`;
  const body = `
    <div style="font-size:0.8rem;color:var(--text-muted);">${t("array.scope", { n: sel.length })}</div>
    <label style="${rowCss}">${t("array.kind")}
      <select id="arr-kind" style="width:150px;">
        <option value="grid">${t("array.grid")}</option>
        <option value="polar">${t("array.polar")}</option>
      </select></label>
    <div id="arr-grid" style="display:flex;flex-direction:column;gap:8px;">
      <label style="${rowCss}">${t("array.cols")}${input("arr-cols", o.cols, "1", 'min="1" max="500"')}</label>
      <label style="${rowCss}">${t("array.rows")}${input("arr-rows", o.rows, "1", 'min="1" max="500"')}</label>
      <label style="${rowCss}">${t("array.spacing")}
        <select id="arr-spacing" style="width:150px;">
          <option value="gap">${t("array.gap")}</option>
          <option value="pitch">${t("array.pitch")}</option>
        </select></label>
      <label style="${rowCss}">${t("array.gapX")}${input("arr-gapx", o.gapX, "0.5")}</label>
      <label style="${rowCss}">${t("array.gapY")}${input("arr-gapy", o.gapY, "0.5")}</label>
    </div>
    <div id="arr-polar" style="display:flex;flex-direction:column;gap:8px;">
      <label style="${rowCss}">${t("array.count")}${input("arr-count", o.count, "1", 'min="1" max="999"')}</label>
      <label style="${rowCss}">${t("array.total")}${input("arr-total", o.total, "15")}</label>
      <label style="${rowCss}">${t("array.centerX")}${input("arr-cx", Number(fmt(cxMm)), "1")}</label>
      <label style="${rowCss}">${t("array.centerY")}${input("arr-cy", Number(fmt(cyMm)), "1")}</label>
      <button id="arr-pick" type="button" class="btn-secondary" style="display:flex;gap:6px;align-items:center;justify-content:center;">${icon("measure", 14)}${t("array.pick")}</button>
      <label style="${checkCss}"><input id="arr-rotate" type="checkbox" ${o.rotate ? "checked" : ""}> ${t("array.rotate")}</label>
    </div>`;
  openToolPanel({
    id: "array-panel", ico: "array", title: t("array.title"), body, ok: "✔ " + t("array.run"), redraw: redrawFn,
    onChange: p => {
      const kind = p.$<HTMLSelectElement>("#arr-kind").value;
      p.$("#arr-grid").style.display = kind === "grid" ? "flex" : "none";
      p.$("#arr-polar").style.display = kind === "polar" ? "flex" : "none";
      const { list, center } = arrayPlacements(p, sel);
      const sets = list.length + 1;
      const tooMany = sets > MAX_SETS;
      // Vorschau: Umrisse; wird es zu viel, nur die Rahmen
      const base = sel.flatMap(outlineOf);
      const pts = base.reduce((n, q) => n + q.pts.length, 0);
      const outlines: Path[] = pts * sets <= MAX_PREVIEW_POINTS ? base : sel.flatMap(s => { const r = outlineOf(s); return r.length ? [boxOf(r)] : []; });
      const carrier = { type: "polyline", points: [] as Pt[], closed: false, x: 0, y: 0, w: 0, h: 0 };
      const out: Path[] = [];
      if (!tooMany) for (const place of list) for (const q of outlines) {
        carrier.points = q.pts.map(k => ({ ...k }));
        place(carrier);
        out.push({ pts: carrier.points, closed: q.closed });
      }
      livePreview.paths = out;
      livePreview.dots = center ? [center] : [];
      if (tooMany) { p.info(t("array.tooMany", { max: MAX_SETS }), true); return; }
      const all = [...out, ...base];
      const bed = bedSizeMm();
      let off = false;
      for (const q of all) for (const k of q.pts) if (k.x < -0.01 || k.y < -0.01 || k.x > bed.w * MM_TO_PIXEL + 0.01 || k.y > bed.h * MM_TO_PIXEL + 0.01) { off = true; break; }
      p.info(off ? t("array.offBed", { n: list.length }) : t("array.info", { n: list.length }), off);
    },
    onOk: p => {
      const { list, opts } = arrayPlacements(p, sel);
      if (list.length + 1 > MAX_SETS) return false;
      if (!list.length) { log(t("array.nothing")); return; }
      try { localStorage.setItem(ARRAY_KEY, JSON.stringify(opts)); } catch { /* egal */ }
      const st = app();
      const copies: any[] = [];
      for (const place of list) {
        const set = makeCopies(sel, 0);
        set.forEach(place);
        copies.push(...set);
      }
      st.shapes = [...st.shapes, ...copies];
      st.selectedShapeIds = [...sel.map((s: any) => s.id), ...copies.map(c => c.id)];
      log(t("array.done", { n: list.length }));
      commit();
    }
  });
  const panel = document.getElementById("array-panel")!;
  (panel.querySelector("#arr-kind") as HTMLSelectElement).value = o.kind;
  (panel.querySelector("#arr-spacing") as HTMLSelectElement).value = o.spacing;
  panel.dispatchEvent(new Event("change"));
  panel.querySelector("#arr-pick")!.addEventListener("click", () => {
    log(t("array.pickHint"));
    pickPoint(q => {
      (panel.querySelector("#arr-cx") as HTMLInputElement).value = fmt(q.x / MM_TO_PIXEL);
      (panel.querySelector("#arr-cy") as HTMLInputElement).value = fmt(q.y / MM_TO_PIXEL);
      panel.dispatchEvent(new Event("change"));
    });
  });
}

function boxOf(paths: Path[]): Path {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of paths) for (const k of q.pts) { minX = Math.min(minX, k.x); maxX = Math.max(maxX, k.x); minY = Math.min(minY, k.y); maxY = Math.max(maxY, k.y); }
  return { closed: true, pts: [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }] };
}

// =====================================================================
// FORM VEREINFACHEN: Punkte sparen mit einstellbarer Toleranz
// =====================================================================

const SIMPLIFY_KEY = "cnc_craft_simplify_tol";
const MAX_PREVIEW_DOTS = 4000;

export function openSimplifyDialog() {
  const list = selectedShapes().filter((s: any) => s.type === "polyline" && s.points.length > 2);
  if (!list.length) { log(t("simplify.select")); return; }
  let start = 0.05;
  try { start = Number(localStorage.getItem(SIMPLIFY_KEY)) || start; } catch { /* egal */ }
  const before = list.reduce((n: number, s: any) => n + s.points.length, 0);
  const result = (p: ToolPanel) => {
    const tol = Math.max(0.001, p.num("#sim-tol", start)) * MM_TO_PIXEL;
    return list.map((s: any) => simplifyPath(s.points, !!s.closed, tol));
  };
  openToolPanel({
    id: "simplify-panel", ico: "simplify", title: t("simplify.title"), ok: "✔ " + t("simplify.run"), redraw: redrawFn,
    body: `
      <div style="font-size:0.8rem;color:var(--text-muted);">${t("simplify.scope", { n: list.length })}</div>
      <label style="${rowCss}">${t("simplify.tol")}<input id="sim-tol" type="number" value="${start}" min="0.001" step="0.01" style="width:90px;"></label>
      <input id="sim-range" type="range" min="-3" max="0.7" step="0.01" value="${Math.log10(start)}">
      <div style="font-size:0.78rem;color:var(--text-muted);">${t("simplify.hint")}</div>`,
    onChange: p => {
      const res = result(p);
      const after = res.reduce((n, q) => n + q.length, 0);
      livePreview.ghost = list.map((s: any) => ({ pts: s.points, closed: !!s.closed }));
      livePreview.paths = res.map((pts, i) => ({ pts, closed: !!list[i].closed }));
      livePreview.dots = after <= MAX_PREVIEW_DOTS ? res.flat() : [];
      p.info(t("simplify.info", { before, after, pct: before ? Math.round((1 - after / before) * 100) : 0 }));
    },
    onOk: p => {
      const res = result(p);
      const tolMm = Math.max(0.001, p.num("#sim-tol", start));
      try { localStorage.setItem(SIMPLIFY_KEY, String(tolMm)); } catch { /* egal */ }
      const after = res.reduce((n, q) => n + q.length, 0);
      list.forEach((s: any, i: number) => {
        if (res[i].length === s.points.length) return;
        s.points = res[i];
        delete s.bez; // die Griffe passen nicht mehr zu den neuen Punkten
        updatePolylineBounds(s);
      });
      log(t("simplify.done", { before, after }));
      commit();
    }
  });
  const panel = document.getElementById("simplify-panel")!;
  const num = panel.querySelector("#sim-tol") as HTMLInputElement, range = panel.querySelector("#sim-range") as HTMLInputElement;
  range.addEventListener("input", () => { num.value = String(Number(Math.pow(10, Number(range.value)).toPrecision(2))); });
  num.addEventListener("input", () => { const v = parseFloat(num.value); if (v > 0) range.value = String(Math.log10(v)); });
}

// =====================================================================
// STARTPUNKT UND RICHTUNG (Rechnung und Regeln: cutSetting.ts)
// =====================================================================

const contourOf = (s: any) => s.type !== "image" && shapeToPaths(s).some(q => q.pts.length >= 2);

/** Richtung umdrehen: gegenüber dem, was gerade gilt, und ab dann fest */
export function reverseDirection() {
  const list = selectedShapes().filter(contourOf);
  if (!list.length) { log(t("cut.select")); return; }
  const kind = machineKind();
  list.forEach((s: any) => {
    const e = effectiveDirection(s, kind);
    s.cutDir = e.closed ? (e.ccw ? "cw" : "ccw") : (e.forward ? "reverse" : "forward");
  });
  log(t("cut.reversed", { n: list.length }));
  commit();
}

export function openCutStartDialog() {
  const list = selectedShapes().filter(contourOf);
  if (!list.length) { log(t("cut.select")); return; }
  const kind = machineKind();
  const anyClosed = list.some((s: any) => shapeToPaths(s)[0].closed), anyOpen = list.some((s: any) => !shapeToPaths(s)[0].closed);
  // Stand im Fenster; erst OK schreibt in die Formen
  const starts = new Map<string, number | null>(list.map((s: any) => [s.id, cutStartOf(s)]));
  const dirs = new Map<string, CutDir | null>(list.map((s: any) => [s.id, cutDirOf(s)]));
  const first = (open: boolean) => { const s = list.find((q: any) => shapeToPaths(q)[0].closed !== open); return s ? cutDirOf(s) || "" : ""; };
  const select = (id: string, label: string, opts: [string, string][], val: string) => `
    <label style="${rowCss}">${label}
      <select id="${id}" style="width:160px;">${opts.map(([v, l]) => `<option value="${v}"${v === val ? " selected" : ""}>${l}</option>`).join("")}</select></label>`;
  const body = `
    <div style="font-size:0.8rem;color:var(--text-muted);">${t("cut.hint", { n: list.length })}</div>
    ${anyClosed ? select("cut-closed", t("cut.dirClosed"), [["", t("cut.auto")], ["cw", t("cut.cw")], ["ccw", t("cut.ccw")]], first(false)) : ""}
    ${anyOpen ? select("cut-open", t("cut.dirOpen"), [["", t("cut.auto")], ["forward", t("cut.forward")], ["reverse", t("cut.reverse")]], first(true)) : ""}
    <button id="cut-reset" type="button" class="btn-secondary">${t("cut.reset")}</button>
    <div style="font-size:0.78rem;color:var(--text-muted);">${t("cut.rule." + kind)}</div>`;
  /** Zustand aus dem Fenster auf einen Klon rechnen (für Pfeil und Anzeige) */
  const preview = (s: any) => {
    const copy = { ...s };
    const d = dirs.get(s.id), f = starts.get(s.id);
    if (d) copy.cutDir = d; else delete copy.cutDir;
    if (f !== null && f !== undefined) copy.cutStart = f; else delete copy.cutStart;
    return copy;
  };
  const clickHandler = (e: MouseEvent) => {
    const c = canvasEl;
    if (!c || e.target !== c || e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    const r = c.getBoundingClientRect();
    const w = toWorld((e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height));
    const sn = snapPoint(w.x, w.y);
    const at = { x: sn.x, y: sn.y };
    // nächste ausgewählte Kontur
    let best: any = null, bestD = Infinity;
    for (const s of list) { const d = distanceToShape(at.x, at.y, s); if (d < bestD) { bestD = d; best = s; } }
    if (!best || bestD > screenDist(14)) { log(t("cut.missed")); return; }
    const p = shapeToPaths(best)[0];
    if (p.closed) starts.set(best.id, fractionAt(p.pts, true, at));
    else {
      // offene Linie: Start = das nähere Ende, daraus folgt die Richtung
      const a = p.pts[0], b = p.pts[p.pts.length - 1];
      dirs.set(best.id, Math.hypot(a.x - at.x, a.y - at.y) <= Math.hypot(b.x - at.x, b.y - at.y) ? "forward" : "reverse");
      const sel = document.querySelector("#cut-open") as HTMLSelectElement | null;
      if (sel && list.length === 1) sel.value = dirs.get(best.id)!;
    }
    panel.el.dispatchEvent(new Event("change"));
  };
  const panel = openToolPanel({
    id: "cut-start-panel", ico: "cutStart", title: t("cut.title"), body, ok: "✔ " + t("topath.run"), redraw: redrawFn,
    onChange: p => {
      livePreview.hideMarksOf = new Set(list.map((s: any) => s.id));
      livePreview.marks = list.flatMap((s: any) => { const m = cutMark(preview(s), kind); return m ? [m] : []; });
      if (kind === "mill" && list.length === 1 && shapeToPaths(list[0])[0].closed) {
        const copy = preview(list[0]);
        const climb = isClimb(copy.millingMode || "outside", effectiveDirection(copy, "mill").ccw);
        p.info(climb === null ? "" : t(climb ? "cut.runsClimb" : "cut.runsConv"));
      }
    },
    onOk: () => {
      list.forEach((s: any) => {
        const copy = preview(s);
        if (copy.cutDir) s.cutDir = copy.cutDir; else delete s.cutDir;
        if (copy.cutStart !== undefined) s.cutStart = copy.cutStart; else delete s.cutStart;
      });
      log(t("cut.done", { n: list.length }));
      commit();
    },
    onClose: () => window.removeEventListener("mousedown", clickHandler, true)
  });
  window.addEventListener("mousedown", clickHandler, true);
  // Die Auswahlfelder gelten für alle Konturen der Art, sobald man sie ändert (vorher behält jede ihre eigene Richtung)
  const onSelect = (id: string, closed: boolean) => panel.el.querySelector(id)?.addEventListener("change", e => {
    const v = (e.target as HTMLSelectElement).value as CutDir | "";
    for (const s of list as any[]) if (shapeToPaths(s)[0].closed === closed) dirs.set(s.id, v || null);
  }, true);
  onSelect("#cut-closed", true);
  onSelect("#cut-open", false);
  panel.el.querySelector("#cut-reset")!.addEventListener("click", () => {
    list.forEach((s: any) => { starts.set(s.id, null); dirs.set(s.id, null); });
    if (panel.el.querySelector("#cut-closed")) (panel.el.querySelector("#cut-closed") as HTMLSelectElement).value = "";
    if (panel.el.querySelector("#cut-open")) (panel.el.querySelector("#cut-open") as HTMLSelectElement).value = "";
    panel.el.dispatchEvent(new Event("change"));
  });
}

// =====================================================================
// SCHEREN
// =====================================================================

const SHEAR_MAX_DEG = 75;

export function openShearDialog() {
  const list = selectedShapes().filter((s: any) => s.type !== "image" && shapeToPaths(s).length);
  if (!list.length) { log(t("shear.select")); return; }
  const skippedImages = selectedShapes().length - list.length;
  const b = groupBounds(list)!;
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const clampDeg = (v: number) => Math.max(-SHEAR_MAX_DEG, Math.min(SHEAR_MAX_DEG, v));
  const read = (p: ToolPanel) => ({
    shx: Math.tan((clampDeg(p.num("#sh-x")) * Math.PI) / 180),
    shy: Math.tan((clampDeg(p.num("#sh-y")) * Math.PI) / 180)
  });
  openToolPanel({
    id: "shear-panel", ico: "shear", title: t("shear.title"), ok: "✔ " + t("topath.run"), redraw: redrawFn,
    body: `
      <label style="${rowCss}">${t("shear.x")}<input id="sh-x" type="number" value="15" min="-${SHEAR_MAX_DEG}" max="${SHEAR_MAX_DEG}" step="1" style="width:90px;"></label>
      <label style="${rowCss}">${t("shear.y")}<input id="sh-y" type="number" value="0" min="-${SHEAR_MAX_DEG}" max="${SHEAR_MAX_DEG}" step="1" style="width:90px;"></label>
      <div style="font-size:0.78rem;color:var(--text-muted);">${t("shear.hint")}</div>`,
    onChange: p => {
      const { shx, shy } = read(p);
      const f = (q: Pt): Pt => ({ x: q.x + shx * (q.y - cy), y: q.y + shy * (q.x - cx) });
      livePreview.paths = list.flatMap((s: any) => shapeToPaths(s).map(q => ({ closed: q.closed, pts: q.pts.map(f) })));
      p.info(skippedImages ? t("shear.imagesSkipped", { n: skippedImages }) : "");
    },
    onOk: p => {
      const { shx, shy } = read(p);
      if (!shx && !shy) return;
      list.forEach((s: any) => shearShape(s, cx, cy, shx, shy));
      log(t("shear.done", { n: list.length }));
      commit();
    }
  });
}

// =====================================================================
// IN BILD UMWANDELN (Rechnung: toImage.ts)
// =====================================================================

const TOIMAGE_KEY = "cnc_craft_to_image";

/** Vektoren auf eine Leinwand malen: geschlossene Konturen gefüllt (Gerade/Ungerade, Löcher bleiben frei), offene als Strich */
function paintVectors(list: any[], plan: ReturnType<typeof rasterPlan>, fill: boolean, strokePx: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = plan.pw;
  c.height = plan.ph;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, plan.pw, plan.ph);
  ctx.fillStyle = "#000";
  ctx.strokeStyle = "#000";
  ctx.lineWidth = strokePx;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const trace = (q: Path) => {
    q.pts.forEach((k, i) => {
      const px = plan.toPixel(k.x, k.y);
      if (i === 0) ctx.moveTo(px.x, px.y); else ctx.lineTo(px.x, px.y);
    });
    if (q.closed) ctx.closePath();
  };
  const paths = list.flatMap((s: any) => shapeToPaths(s)).filter(q => q.pts.length >= 2);
  if (fill) {
    ctx.beginPath();
    paths.filter(q => q.closed).forEach(trace);
    ctx.fill("evenodd");
  }
  ctx.beginPath();
  paths.filter(q => !fill || !q.closed).forEach(trace);
  ctx.stroke();
  return c;
}

export function openToImageDialog() {
  const list = selectedShapes().filter((s: any) => s.type !== "image" && shapeToPaths(s).some(q => q.pts.length >= 2));
  if (!list.length) { log(t("toimg.select")); return; }
  const b = groupBounds(list)!;
  let saved: { dpi?: number; fill?: boolean; stroke?: number; keep?: boolean } = {};
  try { saved = JSON.parse(localStorage.getItem(TOIMAGE_KEY) || "{}"); } catch { /* egal */ }
  const read = (p: ToolPanel) => ({
    dpi: Math.max(10, p.num("#ti-dpi", 254)), fill: p.check("#ti-fill"), stroke: Math.max(0.01, p.num("#ti-stroke", 0.2)), keep: p.check("#ti-keep")
  });
  let previewTimer = 0;
  openToolPanel({
    id: "to-image-panel", ico: "toImage", title: t("toimg.title"), ok: "✔ " + t("toimg.run"), redraw: redrawFn,
    body: `
      <label style="${rowCss}">${t("toimg.dpi")}<input id="ti-dpi" type="number" value="${saved.dpi ?? 254}" min="10" step="10" style="width:90px;"></label>
      <label style="${rowCss}">${t("toimg.stroke")}<input id="ti-stroke" type="number" value="${saved.stroke ?? 0.2}" min="0.01" step="0.05" style="width:90px;"></label>
      <label style="${checkCss}"><input id="ti-fill" type="checkbox" ${saved.fill === false ? "" : "checked"}> ${t("toimg.fill")}</label>
      <label style="${checkCss}"><input id="ti-keep" type="checkbox" ${saved.keep ? "checked" : ""}> ${t("toimg.keep")}</label>
      <canvas id="ti-preview" width="288" height="120" style="width:100%;background:#fff;border:1px solid var(--border-color);border-radius:6px;"></canvas>`,
    onChange: p => {
      const o = read(p);
      const plan = rasterPlan(b, o.dpi);
      if (plan.limited) p.info(t("toimg.limited", { w: plan.pw, h: plan.ph, dpi: Math.round(plan.dpi) }), true);
      else p.info(t("toimg.info", { w: plan.pw, h: plan.ph, step: plan.intervalMm.toFixed(3) }));
      clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => {
        if (!document.getElementById("to-image-panel")) return;
        // Vorschau klein rechnen, Bild in die Leinwand einpassen
        const small = rasterPlan(b, 60);
        const src = paintVectors(list, small, o.fill, Math.max(1, (o.stroke * small.dpi) / 25.4));
        const pv = p.$<HTMLCanvasElement>("#ti-preview"), ctx = pv.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, pv.width, pv.height);
        const k = Math.min(pv.width / src.width, pv.height / src.height);
        ctx.drawImage(src, (pv.width - src.width * k) / 2, (pv.height - src.height * k) / 2, src.width * k, src.height * k);
      }, 120);
    },
    onOk: async p => {
      const o = read(p);
      const plan = rasterPlan(b, o.dpi);
      try { localStorage.setItem(TOIMAGE_KEY, JSON.stringify(o)); } catch { /* egal */ }
      const canvas = paintVectors(list, plan, o.fill, Math.max(1, (o.stroke * plan.dpi) / 25.4));
      const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, "image/png"));
      if (!blob) { p.info(t("toimg.failed"), true); return false; }
      const widthMm = (b.maxX - b.minX) / MM_TO_PIXEL;
      const shape = await createImageShape("vectors.png", new Uint8Array(await blob.arrayBuffer()), widthMm, b.minX / MM_TO_PIXEL, b.minY / MM_TO_PIXEL, plan.pw);
      shape.source = t("toimg.source");
      // Vektorgrafik: harte Kanten statt Foto-Raster; im Gravur-Fenster lässt sich das wie bei jedem Bild ändern
      shape.img = { ...shape.img, preset: "bw", raster: presetSettings("bw").raster, adjust: { ...NO_ADJUST }, interval: plan.intervalMm };
      const engrave = getLayers().find(l => l.mode === "fill");
      if (engrave) shape.laserLayerId = engrave.id;
      const st = app();
      const gone = new Set(o.keep ? [] : list);
      st.shapes = [...st.shapes.filter((s: any) => !gone.has(s)), shape];
      st.selectedShapeIds = [shape.id];
      log(t("toimg.done", { w: plan.pw, h: plan.ph }));
      commit();
    },
    onClose: () => clearTimeout(previewTimer)
  });
}

// =====================================================================
// PRINT & CUT: Zeichnung an zwei Passmarken ausrichten (Rechnung: printCut.ts)
// =====================================================================
// Dieses Fenster schickt nichts an die Maschine: es liest nur die Position. Zum Anpeilen dient der vorhandene Testschuss
// (Laser-Bereich, spindlePanel.ts: nur solange gedrückt, mit Zeitgrenze), gefahren wird mit den normalen Jog-Knöpfen.

export function openPrintCutDialog() {
  if (!isLaser()) { log(t("pc.laserOnly")); return; }
  const marks = selectedShapes().filter((s: any) => s.type !== "image");
  if (marks.length !== 2) { log(t("pc.select")); return; }
  const centerOf = (s: any): Pt => { const b = shapeBounds(s)!; return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; };
  const [m1, m2] = orderMarks({ ...centerOf(marks[0]), shape: marks[0] }, { ...centerOf(marks[1]), shape: marks[1] });
  const mm = (v: number) => (v / MM_TO_PIXEL).toFixed(2);
  const pair = (n: 1 | 2, q: Pt) => `
    <div style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--border-color);border-radius:8px;">
      <div style="font-size:0.85rem;font-weight:600;">${t("pc.mark", { n })} <span style="font-weight:400;color:var(--text-muted);">${t("pc.inDrawing", { x: mm(q.x), y: mm(q.y) })}</span></div>
      <div style="display:flex;gap:6px;align-items:center;">
        <label style="font-size:0.8rem;">X <input id="pc-x${n}" type="number" step="0.05" style="width:72px;"></label>
        <label style="font-size:0.8rem;">Y <input id="pc-y${n}" type="number" step="0.05" style="width:72px;"></label>
        <button id="pc-read${n}" type="button" class="btn-secondary" style="flex:1;">${t("pc.read")}</button>
      </div>
    </div>`;
  const read = (p: ToolPanel) => {
    const val = (id: string) => parseFloat(p.$(id).value);
    const b1 = { x: val("#pc-x1") * MM_TO_PIXEL, y: val("#pc-y1") * MM_TO_PIXEL }, b2 = { x: val("#pc-x2") * MM_TO_PIXEL, y: val("#pc-y2") * MM_TO_PIXEL };
    if (![b1.x, b1.y, b2.x, b2.y].every(Number.isFinite)) return null;
    return twoPointFit(m1, m2, b1, b2);
  };
  const body = `
    <div style="font-size:0.8rem;color:var(--text-muted);">${t("pc.steps")}</div>
    <div style="font-size:0.8rem;padding:8px;border-radius:8px;border:1px solid var(--lt-amber,#ffb454);color:var(--lt-amber,#ffb454);">${t("pc.lowPower")}</div>
    ${pair(1, m1)}
    ${pair(2, m2)}
    <label style="${checkCss}"><input id="pc-del" type="checkbox" checked> ${t("pc.deleteMarks")}</label>`;
  const panel = openToolPanel({
    id: "print-cut-panel", ico: "printCut", title: t("pc.title"), body, ok: "✔ " + t("pc.run"), redraw: redrawFn,
    onChange: p => {
      livePreview.dots = [m1, m2];
      const f = read(p);
      if (!f) { livePreview.paths = []; p.info(t("pc.waiting")); return; }
      const others = app().shapes.filter((s: any) => s !== m1.shape && s !== m2.shape);
      livePreview.paths = others.flatMap(outlineOf).map((q: Path) => ({ closed: q.closed, pts: q.pts.map(k => applyFit(f, k)) }));
      const problem = fitProblem(f, MM_TO_PIXEL);
      const deg = ((f.angle * 180) / Math.PI).toFixed(2);
      const info = t("pc.info", { deg, dx: mm(f.dx), dy: mm(f.dy), err: mm(Math.abs(f.lengthError)) });
      if (problem === "tooClose") p.info(t("pc.tooClose"), true);
      else if (problem === "lengthOff") p.info(t("pc.lengthOff", { err: mm(Math.abs(f.lengthError)) }), true);
      else p.info(info, Math.abs(f.lengthError) > 2 * MM_TO_PIXEL);
    },
    onOk: p => {
      const f = read(p);
      if (!f) { p.info(t("pc.waiting"), true); return false; }
      if (fitProblem(f, MM_TO_PIXEL)) return false;
      const st = app();
      const gone = new Set(p.check("#pc-del") ? [m1.shape, m2.shape] : []);
      st.shapes = st.shapes.filter((s: any) => !gone.has(s));
      st.shapes.forEach((s: any) => { rotateShape(s, f.center.x, f.center.y, f.angle); translateShape(s, f.dx, f.dy); });
      st.selectedShapeIds = [];
      log(t("pc.done", { deg: ((f.angle * 180) / Math.PI).toFixed(2) }));
      commit();
    }
  });
  ([1, 2] as const).forEach(n => panel.$<HTMLButtonElement>(`#pc-read${n}`).addEventListener("click", () => {
    if (!machine.connected) { log(t("conn.connectFirst")); return; }
    if (machine.job.active || (machine.status.state && machine.status.state !== "Idle")) { log(t("pc.notIdle", { s: esc(machine.status.state || "") })); return; }
    panel.$(`#pc-x${n}`).value = machine.status.wpos[0].toFixed(3);
    panel.$(`#pc-y${n}`).value = machine.status.wpos[1].toFixed(3);
    panel.el.dispatchEvent(new Event("change"));
  }));
}

// =====================================================================
// DOPPELTE LINIEN ENTFERNEN (Rechnung: dedupe.ts)
// =====================================================================

const DEDUPE_KEY = "cnc_craft_dedupe_tol";

export function openDedupeDialog() {
  const sel = selectedShapes();
  const base: any[] = sel.length ? sel : app().shapes;
  const list = base.filter((s: any) => s.type !== "image" && shapeToPaths(s).some(q => q.pts.length >= 2));
  if (list.length < 2) { log(t("dedupe.needTwo")); return; }
  let start = 0.01;
  try { start = Number(localStorage.getItem(DEDUPE_KEY)) || start; } catch { /* egal */ }
  const items = list.map((s: any) => ({ ref: s, path: normalizePath(shapeToPaths(s)[0]) }));
  const calc = (p: ToolPanel) => findDuplicates(items, Math.max(0.001, p.num("#dd-tol", start)) * MM_TO_PIXEL);
  openToolPanel({
    id: "dedupe-panel", ico: "dedupe", title: t("dedupe.title"), ok: "✔ " + t("dedupe.run"), redraw: redrawFn,
    body: `
      <div style="font-size:0.8rem;color:var(--text-muted);">${sel.length ? t("dedupe.scopeSel", { n: list.length }) : t("dedupe.scopeAll", { n: list.length })}</div>
      <label style="${rowCss}">${t("dedupe.tol")}<input id="dd-tol" type="number" value="${start}" min="0.001" step="0.01" style="width:90px;"></label>
      <div style="font-size:0.78rem;color:var(--text-muted);">${t("dedupe.hint")}</div>`,
    onChange: p => {
      const r = calc(p);
      livePreview.ghost = r.removed;
      const pieces = r.trims.length;
      p.info(r.removeWhole.length || pieces ? t("dedupe.info", { n: r.removeWhole.length, m: pieces }) : t("dedupe.none"));
    },
    onOk: p => {
      const r = calc(p);
      if (!r.removeWhole.length && !r.trims.length) { log(t("dedupe.none")); return; }
      try { localStorage.setItem(DEDUPE_KEY, String(Math.max(0.001, p.num("#dd-tol", start)))); } catch { /* egal */ }
      const st = app();
      const gone = new Set(r.removeWhole);
      const swap = new Map(r.trims.map(x => [x.ref, piecesFromSpans(x.ref, x.path, x.keep)]));
      st.shapes = st.shapes.flatMap((s: any) => gone.has(s) ? [] : swap.get(s) ?? [s]);
      const left = new Set(st.shapes.map((s: any) => s.id));
      st.selectedShapeIds = st.selectedShapeIds.filter((id: string) => left.has(id));
      log(t("dedupe.done", { n: r.removeWhole.length, m: r.trims.length }));
      commit();
    }
  });
}
