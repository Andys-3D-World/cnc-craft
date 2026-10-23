/**
 * TEXT-WERKZEUG: Text in fräsbare Konturen umwandeln.
 *
 * Schriften: mitgelieferte freie Schriften, jede Systemschrift oder eine eigene Datei (fonts.ts).
 * Einzellinien-Schrift: eigener Weg über offene Linien (singleLine.ts).
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
import { FALLBACK_FONT, resolveFont } from "./fonts";
import { createFontPicker } from "./fontPicker";
import { traceSingleLine } from "./singleLine";

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
  font: FALLBACK_FONT,
  heightMm: 20,
  bold: false,
  italic: false,
  align: "left",
  lineSpacing: 170,
  letterSpacing: 0
};

let lastParams: TextParams = { ...DEFAULTS };
let redrawHook: () => void = () => {};

export function setTextRedraw(fn: () => void) { redrawHook = fn; }

// =====================================================================
// TEXT -> KONTUREN
// =====================================================================

export interface TracedText {
  loops: Pt[][]; holes: boolean[]; width: number; height: number;
  closed?: boolean[]; // nur Einzellinien-Schrift: offene Linien (fehlt = alle geschlossen)
}

/** Ergebnis inkl. Hinweis, ob die gewünschte Schrift fehlte (dann Ersatzschrift) */
export interface TextResult { traced: TracedText; missing: boolean; }

/** Schrift laden (mitgeliefert/System/Datei) und Text in Konturen umwandeln */
export async function traceTextWithFont(p: TextParams): Promise<TextResult> {
  const rf = await resolveFont(p.font, p.bold, p.italic);
  if (rf.singleLine) return { traced: await traceSingleLine(p), missing: false };
  return { traced: traceText(p, rf.css), missing: rf.missing };
}

/**
 * Wandelt Text in Konturen um. Ergebnis in mm, Y nach oben,
 * Nullpunkt = linke untere Ecke der Umriss-Box.
 */
export function traceText(p: TextParams, cssFamily = p.font): TracedText {
  const lines = p.text.replace(/\r/g, "").split("\n");
  const fontCss = (px: number) => `${p.italic ? "italic " : ""}${p.bold ? "bold " : ""}${px}px "${cssFamily.replace(/"/g, "")}", sans-serif`;

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
  const shapes = traced.loops.map((loop, i) =>
    createPolyline(
      loop.map(q => ({ x: x0 + q.x * MM_TO_PIXEL, y: y0 + q.y * MM_TO_PIXEL })),
      traced.closed?.[i] ?? true,
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
          <div id="txt-font"></div>
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
      <div id="txt-warn" class="txt-warn" hidden></div>
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
      .txt-warn { font-size: 0.78rem; color: #ffb454; background: rgba(255,180,84,0.08); border: 1px solid rgba(255,180,84,0.35);
        border-radius: 6px; padding: 6px 8px; }
      .fp { position: relative; }
      .fp-btn { width: 100%; display: flex; align-items: center; gap: 6px; text-align: left; background: var(--bg-input, #191920);
        color: var(--text-main, #e6e6ee); border: 1px solid var(--border-color, #35353f); border-radius: 4px; padding: 4px 8px;
        cursor: pointer; font-size: 1rem; min-height: 30px; box-sizing: border-box; }
      .fp-btn.fp-missing { border-color: #ffb454; }
      .fp-btn.fp-missing .fp-name::after { content: " ⚠"; font-family: var(--font-ui, sans-serif); color: #ffb454; }
      .fp-name { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .fp-arrow { color: var(--text-muted, #8d8d9c); font-size: 0.75rem; }
      .fp-panel { position: absolute; z-index: 10; left: 0; top: calc(100% + 4px); width: 340px; max-width: 90vw;
        background: var(--bg-panel, #1f1f26); border: 1px solid var(--border-color, #35353f); border-radius: 8px;
        box-shadow: 0 12px 36px rgba(0,0,0,0.6); display: flex; flex-direction: column; color: var(--text-main, #e6e6ee); }
      .fp-panel[hidden] { display: none; }
      .fp-top { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--border-color, #35353f); }
      .fp-search { flex: 1; min-width: 0; }
      .fp-refresh { background: transparent; border: 1px solid var(--border-color, #35353f); color: var(--text-muted, #8d8d9c);
        border-radius: 4px; cursor: pointer; padding: 0 8px; }
      .fp-list { max-height: 300px; overflow-y: auto; padding: 4px 0; }
      .fp-group { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted, #8d8d9c);
        padding: 8px 10px 3px; position: sticky; top: -4px; background: var(--bg-panel, #1f1f26); }
      .fp-item { display: flex; align-items: center; gap: 8px; padding: 4px 10px; cursor: pointer; font-size: 1.05rem; color: var(--text-main, #e6e6ee); }
      .fp-item:hover { background: rgba(255,255,255,0.06); }
      .fp-item.fp-sel { background: rgba(109,74,255,0.25); }
      .fp-iname { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .fp-tag { font-size: 0.65rem; color: var(--text-muted, #8d8d9c); font-family: var(--font-ui, sans-serif); white-space: nowrap; }
      .fp-empty { padding: 6px 10px; font-size: 0.78rem; color: var(--text-muted, #8d8d9c); }
      .fp-foot { border-top: 1px solid var(--border-color, #35353f); padding: 8px; display: flex; flex-direction: column; gap: 5px; }
      .fp-file { background: transparent; border: 1px solid var(--border-color, #35353f); color: var(--text-main, #e6e6ee);
        border-radius: 5px; padding: 5px; cursor: pointer; font-size: 0.8rem; }
      .fp-hint { font-size: 0.7rem; color: var(--text-muted, #8d8d9c); line-height: 1.35; }
      .txt-info { font-size: 0.78rem; color: var(--text-muted, #8d8d9c); font-family: monospace; min-height: 1em; }
      .txt-btn-cancel { flex: 1; padding: 9px; border-radius: 6px; border: 1px solid var(--border-color, #35353f); background: transparent;
        color: var(--text-muted, #8d8d9c); cursor: pointer; }
      .txt-btn-ok { flex: 2; padding: 9px; border-radius: 6px; border: none; font-weight: 700; cursor: pointer;
        background: var(--accent-color, #6d4aff); color: #fff; }
    </style>
  `;
  document.body.appendChild(ov);
  const $ = <T extends HTMLElement>(id: string) => ov.querySelector("#" + id) as T;

  let timer = 0;
  const later = () => { clearTimeout(timer); timer = window.setTimeout(update, 120); };
  const picker = createFontPicker($<HTMLDivElement>("txt-font"), initial.font, later);

  const read = (): TextParams => ({
    text: $<HTMLTextAreaElement>("txt-text").value,
    font: picker.get() || FALLBACK_FONT,
    heightMm: Math.max(0.5, parseFloat($<HTMLInputElement>("txt-height").value) || DEFAULTS.heightMm),
    bold: $<HTMLInputElement>("txt-bold").checked,
    italic: $<HTMLInputElement>("txt-italic").checked,
    align: $<HTMLSelectElement>("txt-align").value as TextParams["align"],
    lineSpacing: Math.max(50, parseFloat($<HTMLInputElement>("txt-line").value) || DEFAULTS.lineSpacing),
    letterSpacing: parseFloat($<HTMLInputElement>("txt-letter").value) || 0
  });

  let traced: TracedText = { loops: [], holes: [], width: 0, height: 0 };
  let run = 0;
  async function update() {
    const p = read();
    const my = ++run;
    let res: TextResult = { traced: { loops: [], holes: [], width: 0, height: 0 }, missing: false };
    try {
      res = await traceTextWithFont(p);
    } catch { /* Schrift nicht lesbar -> leere Vorschau */ }
    if (my !== run) return; // inzwischen neuere Eingabe
    traced = p.text.trim() ? res.traced : { loops: [], holes: [], width: 0, height: 0 };
    picker.setMissing(res.missing);
    const warn = $<HTMLDivElement>("txt-warn");
    warn.hidden = !res.missing;
    warn.textContent = res.missing ? t("text.fontMissing", { font: p.font, fallback: FALLBACK_FONT }) : "";
    drawPreview($<HTMLCanvasElement>("txt-preview"), traced);
    $<HTMLDivElement>("txt-info").textContent = traced.loops.length
      ? `${traced.width.toFixed(1)} × ${traced.height.toFixed(1)} mm · ${t("text.contours", { n: traced.loops.length })}`
      : t("text.empty");
  }
  ov.querySelectorAll("input:not(.fp-search), textarea, select").forEach(el => {
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
  $("txt-ok").addEventListener("click", async () => {
    clearTimeout(timer);
    await update();
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
  t.loops.forEach((l, k) => {
    l.forEach((q, i) => (i === 0 ? ctx.moveTo(ox + q.x * s, oy - q.y * s) : ctx.lineTo(ox + q.x * s, oy - q.y * s)));
    if (t.closed?.[k] ?? true) ctx.closePath();
  });
  ctx.fillStyle = "rgba(0, 255, 204, 0.12)";
  if (!t.closed) ctx.fill("evenodd"); // Einzellinien nicht füllen
  ctx.strokeStyle = "#00ffcc";
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

