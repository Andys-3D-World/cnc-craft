/**
 * PUZZLE-GENERATOR – Fenster (Generatoren): Größe, Form, Spalten × Reihen, Nasengröße, Unregelmäßigkeit, 🎲 neues Muster.
 * Ist etwas ausgewählt (z. B. ein Bild zum Gravieren), legt sich das Puzzle genau darüber; sonst in die Bettmitte.
 * Die Linien kommen auf die stärkste Linien-Ebene (Schnitt). Geometrie: puzzle.ts.
 */
import { app, bedSizeMm } from "./editorState";
import { createPolyline, MM_TO_PIXEL } from "../shapeTransform";
import { selectedShapes, selectionBounds } from "./selection";
import { getLayers } from "../laserLayers";
import { t } from "../i18n/i18n";
import { puzzle, PUZZLE_SHAPES, type PuzzleOptions, type PuzzleShape } from "../puzzle";
import type { XY } from "../nameConnect";

const KEY = "cnc_craft_puzzle";
interface Opts extends PuzzleOptions { over: boolean }
const DEF: Opts = { w: 200, h: 150, cols: 8, rows: 6, shape: "rect", tab: 100, jitter: 50, seed: 1, over: true };

function load(): Opts {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: Opts = { ...DEF };
    for (const k of ["w", "h", "cols", "rows", "tab", "jitter", "seed"] as const) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    if (PUZZLE_SHAPES.includes(s.shape)) o.shape = s.shape;
    if (typeof s.over === "boolean") o.over = s.over;
    return o;
  } catch { return { ...DEF }; }
}

export function openPuzzleDialog(log: (s: string) => void, done: () => void) {
  const o = load();
  // Auswahl (in mm, Y nach oben): das Puzzle bekommt deren Größe und Lage
  const sb = selectionBounds();
  const sel = sb && sb.maxX - sb.minX > 2 && sb.maxY - sb.minY > 2
    ? { x: sb.minX / MM_TO_PIXEL, y: sb.minY / MM_TO_PIXEL, w: (sb.maxX - sb.minX) / MM_TO_PIXEL, h: (sb.maxY - sb.minY) / MM_TO_PIXEL } : null;
  // ein einzelnes, ungedrehtes Bild zeigen wir in der Vorschau unter den Linien
  const shapes = selectedShapes();
  const img = shapes.length === 1 && shapes[0].type === "image" && shapes[0].img?.src && Math.abs(shapes[0].points[0].y - shapes[0].points[1].y) < 1e-6 ? shapes[0] : null;
  if (sel && o.over) { o.w = Math.round(sel.w * 10) / 10; o.h = Math.round(sel.h * 10) / 10; }

  document.getElementById("puzzle-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "puzzle-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, v: number, step = "1", min = "0") =>
    `<label class="prop-row">${t(key)}<input id="${id}" type="number" step="${step}" min="${min}" value="${v}" class="prop-input"></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:620px;">
      <h3>🧩 ${t("pz.title")}</h3>
      <div class="dlg-hint">${t("pz.desc")}</div>
      <div class="box-grid">
        <div class="box-fields">
          <label class="prop-row" style="cursor:pointer;"><span>${t("pz.over")}</span><input id="pz-over" type="checkbox" style="width:auto;" ${sel ? "" : "disabled"}></label>
          ${num("pz-w", "pz.w", o.w, "1", "10")}
          ${num("pz-h", "pz.h", o.h, "1", "10")}
          <label class="prop-row">${t("pz.shape")}<select id="pz-shape" class="prop-input" style="width:auto;">${PUZZLE_SHAPES.map(k => `<option value="${k}">${t("pz.shape." + k)}</option>`).join("")}</select></label>
          ${num("pz-cols", "pz.cols", o.cols, "1", "1")}
          ${num("pz-rows", "pz.rows", o.rows, "1", "1")}
          ${num("pz-tab", "pz.tab", o.tab, "5", "60")}
          ${num("pz-jit", "pz.jitter", o.jitter, "5", "0")}
          <button id="pz-dice" class="btn-secondary" type="button" style="width:100%;margin-top:6px;">🎲 ${t("pz.dice")}</button>
        </div>
        <div class="box-prev"><svg id="pz-svg" viewBox="0 0 100 100"></svg><div id="pz-info" class="dlg-hint"></div></div>
      </div>
      <div class="dlg-hint">${t(sel ? "pz.hintSel" : "pz.hint")}</div>
      <div class="dlg-buttons">
        <button id="pz-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="pz-ok" class="btn-primary">✔ ${t("pz.create")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  $<HTMLSelectElement>("pz-shape").value = o.shape;
  $("pz-over").checked = !!sel && o.over;

  const read = (): Opts => {
    const n = (id: string, d: number, min: number, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    return { w: n("pz-w", o.w, 10, 5000), h: n("pz-h", o.h, 10, 5000), cols: Math.round(n("pz-cols", o.cols, 1, 60)), rows: Math.round(n("pz-rows", o.rows, 1, 60)),
      shape: $<HTMLSelectElement>("pz-shape").value as PuzzleShape, tab: n("pz-tab", o.tab, 60, 140), jitter: n("pz-jit", o.jitter, 0, 100),
      seed: o.seed, over: $("pz-over").checked };
  };
  const preview = () => {
    const p = read();
    // „über die Auswahl“: Größe kommt von der Auswahl
    $<HTMLInputElement>("pz-w").disabled = $<HTMLInputElement>("pz-h").disabled = p.over;
    if (p.over && sel) { $("pz-w").value = String(Math.round(sel.w * 10) / 10); $("pz-h").value = String(Math.round(sel.h * 10) / 10); p.w = sel.w; p.h = sel.h; }
    const r = puzzle(p);
    const svg = $<HTMLElement>("pz-svg") as unknown as SVGSVGElement;
    const d = (pts: XY[], close: boolean) => pts.map((q, k) => `${k ? "L" : "M"}${q[0].toFixed(2)},${(p.h - q[1]).toFixed(2)}`).join("") + (close ? "Z" : "");
    svg.setAttribute("viewBox", `-2 -2 ${p.w + 4} ${p.h + 4}`);
    svg.innerHTML = `<path d="${d(r.outline, true)}" class="box-panel"/><path d="${r.lines.map(l => d(l.pts, false)).join("")}" fill="none" stroke="#5a3a1c" stroke-width="${(Math.max(p.w, p.h) / 300).toFixed(2)}"/>`;
    if (img && p.over) {
      // Bild unter die Linien (über DOM-Attribute, nicht als Text ins innerHTML)
      const im = document.createElementNS("http://www.w3.org/2000/svg", "image");
      im.setAttribute("href", img.img.src);
      im.setAttribute("x", "0"); im.setAttribute("y", "0"); im.setAttribute("width", String(p.w)); im.setAttribute("height", String(p.h));
      im.setAttribute("preserveAspectRatio", "none");
      im.setAttribute("opacity", "0.85");
      svg.insertBefore(im, svg.children[1]);
    }
    $<HTMLElement>("pz-info").textContent = t("pz.info", { n: p.cols * p.rows, w: r.pieceW.toFixed(1), h: r.pieceH.toFixed(1), W: p.w.toFixed(0), H: p.h.toFixed(0) });
  };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener(i.tagName === "SELECT" || (i as HTMLInputElement).type === "checkbox" ? "change" : "input", preview));
  $<HTMLElement>("pz-dice").onclick = () => { o.seed = 1 + Math.floor(Math.random() * 99999); preview(); };
  preview();

  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") $<HTMLElement>("pz-ok").click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("pz-cancel").onclick = close;
  $<HTMLElement>("pz-ok").onclick = () => {
    const p = read();
    if (p.over && sel) { p.w = sel.w; p.h = sel.h; }
    try { localStorage.setItem(KEY, JSON.stringify({ ...p, w: p.over && sel ? o.w : p.w, h: p.over && sel ? o.h : p.h })); } catch { /* egal */ }
    close();
    const r = puzzle(p);
    const bed = bedSizeMm();
    const x0 = p.over && sel ? sel.x : (bed.w - p.w) / 2, y0 = p.over && sel ? sel.y : (bed.h - p.h) / 2;
    const toW = (pts: XY[]) => pts.map(([x, y]) => ({ x: (x0 + x) * MM_TO_PIXEL, y: (y0 + y) * MM_TO_PIXEL }));
    // alles auf die Schnitt-Ebene (stärkste Linien-Ebene), an der Fräse auf der Linie
    const cutL = getLayers().filter(l => l.mode === "line").sort((a, c) => c.power - a.power)[0];
    const extra = { source: t("pz.title"), groupId: "puzzle-" + Math.random().toString(36).slice(2, 10), ...(cutL ? { laserLayerId: cutL.id } : {}) };
    const made: any[] = [createPolyline(toW(r.outline), true, "on-line", extra), ...r.lines.map(l => createPolyline(toW(l.pts), false, "on-line", extra))];
    const st = app();
    st.shapes = [...st.shapes, ...made];
    st.selectedShapeIds = made.map(s => s.id);
    log(t("pz.done", { n: p.cols * p.rows }));
    done();
  };
}
