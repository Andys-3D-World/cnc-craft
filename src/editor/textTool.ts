/**
 * TEXT-WERKZEUG: Text in fräsbare Konturen umwandeln.
 *
 * Funktioniert mit JEDER auf dem Rechner installierten Schrift:
 *   1. Text wird sehr groß in ein unsichtbares Bild geschrieben.
 *   2. Die Buchstabenkanten werden mit "Marching Squares" sub-pixel-genau abgetastet.
 *   3. Überflüssige Punkte werden entfernt, Löcher (z.B. im "o") erkannt.
 *   4. Ergebnis: geschlossene Konturen in mm, als Gruppe eingefügt.
 *
 * Doppelklick auf einen Text (Auswahl-Werkzeug) öffnet ihn wieder zum Bearbeiten.
 */
import { app } from "./editorState";
import { Pt, createPolyline, groupBounds, newId, MM_TO_PIXEL, pathArea, pointInPath } from "../shapeTransform";
import { updateDimensionInputs } from "../uiInputs";
import { marchingSquares, simplifyClosed } from "../traceUtil";
import { t } from "../i18n/i18n";

export interface TextParams {
  text: string;
  font: string;
  heightMm: number;      // Höhe der Großbuchstaben in mm
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  lineSpacing: number;   // Zeilenabstand in % der Großbuchstaben-Höhe
  letterSpacing: number; // zusätzlicher Buchstabenabstand in mm
}

const DEFAULTS: TextParams = {
  text: "CNC Craft",
  font: "Arial",
  heightMm: 20,
  bold: false,
  italic: false,
  align: "left",
  lineSpacing: 170,
  letterSpacing: 0
};

const FONT_SUGGESTIONS = [
  "Arial", "Arial Black", "Helvetica", "Verdana", "Tahoma", "Trebuchet MS", "Segoe UI", "Calibri",
  "Times New Roman", "Georgia", "Garamond", "Courier New", "Consolas", "Impact", "Comic Sans MS",
  "DejaVu Sans", "DejaVu Serif", "Liberation Sans", "Liberation Serif", "Ubuntu", "Noto Sans",
  "sans-serif", "serif", "monospace", "cursive", "fantasy"
];

let lastParams: TextParams = { ...DEFAULTS };
let redrawHook: () => void = () => {};

export function setTextRedraw(fn: () => void) { redrawHook = fn; }

// =====================================================================
// TEXT -> KONTUREN
// =====================================================================

export interface TracedText { loops: Pt[][]; holes: boolean[]; width: number; height: number; }

/**
 * Wandelt Text in Konturen um. Ergebnis in mm, Y nach oben,
 * Nullpunkt = linke untere Ecke der Umriss-Box.
 */
export function traceText(p: TextParams): TracedText {
  const lines = p.text.replace(/\r/g, "").split("\n");
  const fontCss = (px: number) => `${p.italic ? "italic " : ""}${p.bold ? "bold " : ""}${px}px "${p.font.replace(/"/g, "")}", sans-serif`;

  // Verhältnis Großbuchstaben-Höhe zu Schriftgröße bestimmen
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = fontCss(100);
  const capRatio = (probe.measureText("H").actualBoundingBoxAscent || 72) / 100;

  // Auflösung: ca. 220 px Schriftgröße -> sehr glatte Kanten
  let fontPx = 220;
  const measureLines = (px: number) => {
    probe.font = fontCss(px);
    const ls = p.letterSpacing * (px * capRatio) / p.heightMm; // mm -> px
    return lines.map(l => {
      if (!ls) return probe.measureText(l).width;
      let w = 0;
      for (const ch of l) w += probe.measureText(ch).width + ls;
      return w;
    });
  };
  let widths = measureLines(fontPx);
  const maxCanvas = 12000;
  const maxW = Math.max(...widths, 1);
  if (maxW + fontPx > maxCanvas) {
    fontPx = Math.max(40, Math.floor((fontPx * (maxCanvas - fontPx)) / maxW));
    widths = measureLines(fontPx);
  }

  const lineH = fontPx * capRatio * (p.lineSpacing / 100); // Abstand der Grundlinien
  const pad = Math.ceil(fontPx * 0.5);
  const textW = Math.max(...widths, 1);
  const W = Math.ceil(textW + pad * 2 + fontPx * 0.3);
  const H = Math.ceil(lineH * (lines.length - 1) + fontPx * 1.3 + pad * 2);

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#fff";
  ctx.font = fontCss(fontPx);
  ctx.textBaseline = "alphabetic";
  const lsPx = p.letterSpacing * (fontPx * capRatio) / p.heightMm;

  lines.forEach((line, i) => {
    let x = pad;
    if (p.align === "center") x = pad + (textW - widths[i]) / 2;
    if (p.align === "right") x = pad + (textW - widths[i]);
    const y = pad + fontPx + i * lineH;
    if (!lsPx) ctx.fillText(line, x, y);
    else for (const ch of line) { ctx.fillText(ch, x, y); x += ctx.measureText(ch).width + lsPx; }
  });

  const img = ctx.getImageData(0, 0, W, H).data;
  const val = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) val[i] = img[i * 4]; // Rot-Kanal reicht (weiß auf schwarz)

  const rawLoops = marchingSquares(val, W, H, 127.5);

  // Pixel -> mm (Großbuchstaben-Höhe = heightMm)
  const mmPerPx = p.heightMm / (fontPx * capRatio);
  let loops = rawLoops
    .map(l => simplifyClosed(l, 0.25))
    .filter(l => l.length >= 3 && Math.abs(pathArea(l)) > 2)
    .map(l => l.map(q => ({ x: q.x * mmPerPx, y: (H - q.y) * mmPerPx })));

  // Löcher erkennen und Drehrichtung vereinheitlichen
  const areas = loops.map(l => pathArea(l));
  const holes = loops.map((l, i) => {
    let depth = 0;
    for (let j = 0; j < loops.length; j++) {
      if (j === i || Math.abs(areas[j]) <= Math.abs(areas[i])) continue;
      if (pointInPath(l[0].x, l[0].y, loops[j])) depth++;
    }
    return depth % 2 === 1;
  });
  loops = loops.map((l, i) => ((areas[i] > 0) === !holes[i] ? l : l.slice().reverse()));

  // Auf linke untere Ecke = (0,0) verschieben
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of loops) for (const q of l) {
    if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
  }
  if (!loops.length) return { loops: [], holes: [], width: 0, height: 0 };
  loops = loops.map(l => l.map(q => ({ x: q.x - minX, y: q.y - minY })));
  return { loops, holes, width: maxX - minX, height: maxY - minY };
}

// =====================================================================
// DIALOG
// =====================================================================

/** Neuer Text an der Stelle "at" (Welt-Pixel, linke untere Ecke) */
export function openTextDialog(at: Pt) {
  showDialog({ ...lastParams }, (params, traced) => {
    insertText(params, traced, at.x, at.y, null);
  });
}

/** Vorhandenen Text bearbeiten (Doppelklick) */
export function editTextGroup(shape: any) {
  const st = app();
  const members = shape.groupId ? st.shapes.filter((s: any) => s.groupId === shape.groupId) : [shape];
  const b = groupBounds(members);
  const params: TextParams = { ...DEFAULTS, ...shape.textData };
  showDialog(params, (p, traced) => {
    const ids = new Set(members.map((m: any) => m.id));
    st.shapes = st.shapes.filter((s: any) => !ids.has(s.id));
    insertText(p, traced, b ? b.minX : 0, b ? b.minY : 0, shape.millingMode);
  });
}

function insertText(p: TextParams, traced: TracedText, x0: number, y0: number, mode: string | null) {
  lastParams = { ...p };
  if (!traced.loops.length) return;
  const st = app();
  const groupId = "text-" + newId();
  const shapes = traced.loops.map(loop =>
    createPolyline(
      loop.map(q => ({ x: x0 + q.x * MM_TO_PIXEL, y: y0 + q.y * MM_TO_PIXEL })),
      true,
      mode || "on-line",
      { groupId, textData: { ...p } }
    )
  );
  st.shapes = [...st.shapes, ...shapes];
  st.selectedShapeIds = shapes.map(s => s.id);
  updateDimensionInputs(null);
  redrawHook();
}

function showDialog(initial: TextParams, onOk: (p: TextParams, t: TracedText) => void) {
  document.getElementById("text-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "text-dialog-overlay";
  ov.innerHTML = `
    <div class="txt-dlg">
      <h3>🔤 ${t("text.title")}</h3>
      <textarea id="txt-text" rows="3" placeholder="${t("text.placeholder")}">${escapeHtml(initial.text)}</textarea>
      <div class="txt-grid">
        <label>${t("text.font")}
          <input id="txt-font" list="txt-font-list" value="${escapeHtml(initial.font)}">
          <datalist id="txt-font-list">${FONT_SUGGESTIONS.map(f => `<option value="${f}">`).join("")}</datalist>
        </label>
        <label>${t("text.height")}
          <input id="txt-height" type="number" min="0.5" step="0.5" value="${initial.heightMm}">
        </label>
        <label>${t("text.lineSpacing")}
          <input id="txt-line" type="number" min="50" step="5" value="${initial.lineSpacing}">
        </label>
        <label>${t("text.letterSpacing")}
          <input id="txt-letter" type="number" step="0.1" value="${initial.letterSpacing}">
        </label>
      </div>
      <div class="txt-row">
        <label class="txt-check"><input id="txt-bold" type="checkbox" ${initial.bold ? "checked" : ""}> <b>${t("text.bold")}</b></label>
        <label class="txt-check"><input id="txt-italic" type="checkbox" ${initial.italic ? "checked" : ""}> <i>${t("text.italic")}</i></label>
        <span style="flex:1"></span>
        <select id="txt-align">
          <option value="left" ${initial.align === "left" ? "selected" : ""}>${t("text.alignLeft")}</option>
          <option value="center" ${initial.align === "center" ? "selected" : ""}>${t("text.alignCenter")}</option>
          <option value="right" ${initial.align === "right" ? "selected" : ""}>${t("text.alignRight")}</option>
        </select>
      </div>
      <canvas id="txt-preview" width="520" height="150"></canvas>
      <div id="txt-info" class="txt-info"></div>
      <div class="txt-row">
        <button id="txt-cancel" class="txt-btn-cancel">${t("dlg.cancel")}</button>
        <button id="txt-ok" class="txt-btn-ok">✔ ${t("dlg.insert")}</button>
      </div>
    </div>
    <style>
      #text-dialog-overlay { position: fixed; inset: 0; z-index: 5000; background: rgba(0,0,0,0.7);
        display: flex; align-items: center; justify-content: center; font-family: var(--font-ui, sans-serif); }
      .txt-dlg { background: var(--bg-panel, #1f1f26); border: 1px solid var(--border-color, #35353f); border-radius: 12px;
        padding: 18px; width: 560px; max-width: 96vw; color: var(--text-main, #e6e6ee); box-shadow: 0 20px 60px rgba(0,0,0,0.7);
        display: flex; flex-direction: column; gap: 10px; }
      .txt-dlg h3 { margin: 0; font-size: 1.05rem; }
      .txt-dlg textarea { width: 100%; box-sizing: border-box; background: var(--bg-input, #191920); color: var(--text-main, #e6e6ee);
        border: 1px solid var(--border-color, #35353f); border-radius: 6px; padding: 8px; font-size: 1rem; resize: vertical; }
      .txt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .txt-grid label { display: flex; flex-direction: column; gap: 3px; font-size: 0.75rem; color: var(--text-muted, #8d8d9c); }
      .txt-grid input { width: 100%; box-sizing: border-box; }
      .txt-row { display: flex; gap: 10px; align-items: center; }
      .txt-check { display: flex; gap: 5px; align-items: center; font-size: 0.85rem; cursor: pointer; }
      #txt-preview { width: 100%; height: auto; background: #121216; border: 1px solid var(--border-color, #35353f); border-radius: 8px; }
      .txt-info { font-size: 0.78rem; color: var(--text-muted, #8d8d9c); font-family: monospace; min-height: 1em; }
      .txt-btn-cancel { flex: 1; padding: 9px; border-radius: 6px; border: 1px solid var(--border-color, #35353f); background: transparent;
        color: var(--text-muted, #8d8d9c); cursor: pointer; }
      .txt-btn-ok { flex: 2; padding: 9px; border-radius: 6px; border: none; font-weight: 700; cursor: pointer;
        background: var(--accent-color, #6d4aff); color: #fff; }
    </style>
  `;
  document.body.appendChild(ov);
  const $ = <T extends HTMLElement>(id: string) => ov.querySelector("#" + id) as T;

  const read = (): TextParams => ({
    text: $<HTMLTextAreaElement>("txt-text").value,
    font: $<HTMLInputElement>("txt-font").value.trim() || "Arial",
    heightMm: Math.max(0.5, parseFloat($<HTMLInputElement>("txt-height").value) || DEFAULTS.heightMm),
    bold: $<HTMLInputElement>("txt-bold").checked,
    italic: $<HTMLInputElement>("txt-italic").checked,
    align: $<HTMLSelectElement>("txt-align").value as TextParams["align"],
    lineSpacing: Math.max(50, parseFloat($<HTMLInputElement>("txt-line").value) || DEFAULTS.lineSpacing),
    letterSpacing: parseFloat($<HTMLInputElement>("txt-letter").value) || 0
  });

  let traced: TracedText = { loops: [], holes: [], width: 0, height: 0 };
  let timer = 0;
  const update = () => {
    const p = read();
    traced = p.text.trim() ? traceText(p) : { loops: [], holes: [], width: 0, height: 0 };
    drawPreview($<HTMLCanvasElement>("txt-preview"), traced);
    $<HTMLDivElement>("txt-info").textContent = traced.loops.length
      ? `${traced.width.toFixed(1)} × ${traced.height.toFixed(1)} mm · ${t("text.contours", { n: traced.loops.length })}`
      : t("text.empty");
  };
  const later = () => { clearTimeout(timer); timer = window.setTimeout(update, 120); };
  ov.querySelectorAll("input, textarea, select").forEach(el => {
    el.addEventListener("input", later);
    el.addEventListener("change", later);
  });

  const close = () => ov.remove();
  $("txt-cancel").addEventListener("click", close);
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  ov.addEventListener("keydown", e => {
    e.stopPropagation(); // Tastenkürzel des Editors nicht auslösen
    if (e.key === "Escape") close();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("txt-ok").click();
  });
  $("txt-ok").addEventListener("click", () => {
    update();
    const p = read();
    close();
    onOk(p, traced);
  });

  update();
  setTimeout(() => { const t = $<HTMLTextAreaElement>("txt-text"); t.focus(); t.select(); }, 0);
}

function drawPreview(canvas: HTMLCanvasElement, t: TracedText) {
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#121216";
  ctx.fillRect(0, 0, W, H);
  if (!t.loops.length) return;
  const pad = 14;
  const s = Math.min((W - pad * 2) / Math.max(t.width, 1e-6), (H - pad * 2) / Math.max(t.height, 1e-6));
  const ox = (W - t.width * s) / 2, oy = (H + t.height * s) / 2;
  ctx.beginPath();
  for (const l of t.loops) {
    l.forEach((q, i) => (i === 0 ? ctx.moveTo(ox + q.x * s, oy - q.y * s) : ctx.lineTo(ox + q.x * s, oy - q.y * s)));
    ctx.closePath();
  }
  ctx.fillStyle = "rgba(0, 255, 204, 0.12)";
  ctx.fill("evenodd");
  ctx.strokeStyle = "#00ffcc";
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

