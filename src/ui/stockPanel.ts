/**
 * MATERIAL-PLATTE – Bedienung
 *
 *  - Abschnitt "Material-Platte" im Reiter Fräsen/Lasern/Plasma: Größe, Abstand, Anzeige,
 *    "Zeichnung als geschnitten markieren", "Letzte Markierung zurück", "Neue Platte"
 *  - Knopf "Auf freie Stelle" in der Werkzeugleiste: Auswahl automatisch in freien Bereich schieben
 *  - Abfrage beim Start / beim Wechsel der Maschinenart: "Liegt die Platte noch drauf?"
 *  - Nach einem Job an der Maschine: verbrauchte Fläche automatisch markieren
 */
import { t, T, tip, ph } from "../i18n/i18n";
import {
  getStock, hasUsedArea, usedPercent, newPlate, undoLastMark, markFromGcode, cutWidthFor,
  setStockPose, newOwnPlate, resetPlate, findFreeSpot, stockOptions, saveStockOptions, drawStockPreview, STOCK_CHANGED, plateSnapshot, loadPlateSnapshot
} from "../stock";
import { cleanRemnants, dropRemnant, freeArea, putRemnant, MAX_NAME, type Remnant } from "../remnants";
import { getMachineMode, MODE_CHANGED, MachineMode } from "../machineMode";
import { translateShape, groupBounds, MM_TO_PIXEL } from "../shapeTransform";
import { updateDimensionInputs } from "../uiInputs";
import { checkpoint } from "../editor/history";
import { generateGcodeFull } from "../cam";
import { icon } from "./icons";

function state(): any { return (window as any).cncState; }
function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

export function stockSectionHtml(): string {
  return `
    <div class="menu-section-unified not-lathe">
      <h3 class="menu-trigger">${T("stock.title")}</h3>
      <div class="menu-body rp-box">
        <div id="stock-status" class="tool-info"></div>
        <label class="prop-row" style="cursor:pointer;"><span>${T("stock.show")}</span><input type="checkbox" id="stock-show" style="width:auto;"></label>
        <label class="prop-row" style="cursor:pointer;" ${tip("stock.skipUsedTip")}><span>${T("stock.skipUsed")}</span><input type="checkbox" id="stock-skip-used" style="width:auto;"></label>
        <div class="prop-row">${T("stock.w")}<input type="number" id="stock-w" min="1" step="10" class="prop-input"></div>
        <div class="prop-row">${T("stock.h")}<input type="number" id="stock-h" min="1" step="10" class="prop-input"></div>
        <div class="prop-row" ${tip("stock.thickTip")}>${T("stock.thick")}<input type="number" id="stock-thick" min="0" max="1000" step="0.5" class="prop-input"></div>
        <div class="prop-row" ${tip("stock.posTip")}>${T("stock.x")}<input type="number" id="stock-x" step="1" class="prop-input"></div>
        <div class="prop-row" ${tip("stock.posTip")}>${T("stock.y")}<input type="number" id="stock-y" step="1" class="prop-input"></div>
        <div class="rp-grid2">
          <button id="stock-fit" class="btn-secondary btn-compact" ${tip("stock.fitTip")}>${T("stock.fit")}</button>
          <button id="stock-reset" class="btn-secondary btn-compact" ${tip("stock.resetTip")}>${T("stock.reset")}</button>
        </div>
        <button id="stock-through" class="btn-secondary btn-compact only-mill" ${tip("stock.throughTip")}>${T("stock.through")}</button>
        <div class="prop-row" ${tip("stock.marginTip")}>${T("stock.margin")}<input type="number" id="stock-margin" min="0" step="0.5" class="prop-input"></div>
        <button id="stock-mark" class="btn-secondary btn-compact" ${tip("stock.markTip")}>✔ ${T("stock.mark")}</button>
        <div class="rp-grid2">
          <button id="stock-undo" class="btn-secondary btn-compact" ${tip("stock.undoTip")}>↶ ${T("stock.undo")}</button>
          <button id="stock-new" class="btn-secondary btn-compact" ${tip("stock.newTip")}>🆕 ${T("stock.new")}</button>
        </div>
        <div class="tool-scope">${T("stock.hint")}</div>
        <div class="prop-row" ${tip("rem.tip")}><span>${T("rem.title")}</span>
          <select id="rem-list" class="prop-input" style="width: 150px;"></select></div>
        <div class="rp-grid2">
          <button id="rem-load" class="btn-secondary btn-compact" ${tip("rem.loadTip")}>${T("rem.load")}</button>
          <button id="rem-delete" class="btn-secondary btn-compact">${T("rem.delete")}</button>
        </div>
        <div class="prop-row"><input type="text" id="rem-name" class="prop-input" maxlength="${MAX_NAME}" style="flex:1;min-width:0;width:auto;" ${ph("rem.namePh")}>
          <button id="rem-save" class="btn-secondary btn-compact" style="flex:none;width:auto;" ${tip("rem.saveTip")}>${T("rem.save")}</button></div>
      </div>
    </div>`;
}

/** Knopf für die Werkzeugleiste */
export function placeButtonHtml(): string {
  return `<button id="btn-place-free" class="btn-cmd" ${tip("stock.placeTip")}>${icon("placeFree")}</button>`;
}

const asked = new Set<MachineMode>();

export function initStockPanel(redraw: () => void, log: (s: string) => void) {
  const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;

  const refresh = () => {
    const s = getStock();
    const st = $("stock-status");
    if (st) {
      const last = s.jobs[s.jobs.length - 1];
      st.textContent = hasUsedArea()
        ? t("stock.status", { w: s.w, h: s.h, p: usedPercent(s).toFixed(1), n: s.jobs.length }) + (last ? " · " + fmtDate(last.date) : "")
        : t("stock.statusFree", { w: s.w, h: s.h });
    }
    if ($("stock-w") && document.activeElement !== $("stock-w")) $("stock-w")!.value = String(s.w);
    if ($("stock-h") && document.activeElement !== $("stock-h")) $("stock-h")!.value = String(s.h);
    for (const [id, v] of [["stock-thick", s.thick || ""], ["stock-x", s.x], ["stock-y", s.y]] as const)
      if ($(id) && document.activeElement !== $(id)) $(id)!.value = String(v);
    const through = $("stock-through") as HTMLButtonElement | null;
    if (through) through.disabled = !(s.thick > 0);
    if ($("stock-margin")) $("stock-margin")!.value = String(stockOptions.margin);
    if ($("stock-show")) $("stock-show")!.checked = stockOptions.show;
    if ($("stock-skip-used")) $("stock-skip-used")!.checked = stockOptions.skipUsed;
    const undo = $("stock-undo") as HTMLButtonElement | null;
    if (undo) undo.disabled = !s.undo;
    refreshRemnants();
  };

  // ---- Reststücke: Platte unter einem Namen ablegen und später wieder auflegen ----
  const REM_KEY = "cnc_craft_remnants";
  const remnants = (): Remnant[] => { try { return cleanRemnants(JSON.parse(localStorage.getItem(REM_KEY) || "[]")); } catch { return []; } };
  const mine = () => remnants().filter(r => r.mode === getMachineMode());
  const refreshRemnants = () => {
    const sel = document.getElementById("rem-list") as HTMLSelectElement | null;
    if (!sel) return;
    const keep = sel.value, list = mine();
    sel.innerHTML = list.length
      ? list.map(r => `<option value="${esc(r.name)}">${esc(r.name)} · ${esc(t("rem.item", { w: r.w, h: r.h, a: freeArea(r).toFixed(2) }))}</option>`).join("")
      : `<option value="">${esc(t("rem.none"))}</option>`;
    if (list.some(r => r.name === keep)) sel.value = keep;
    for (const id of ["rem-load", "rem-delete"]) { const b = document.getElementById(id) as HTMLButtonElement | null; if (b) b.disabled = !list.length; }
  };
  const picked = () => mine().find(r => r.name === (document.getElementById("rem-list") as HTMLSelectElement | null)?.value);
  document.getElementById("rem-save")?.addEventListener("click", () => {
    const name = ($("rem-name")?.value || "").trim();
    if (!name) { log(t("rem.needName")); $("rem-name")?.focus(); return; }
    const all = remnants();
    if (all.some(r => r.name === name && r.mode === getMachineMode()) && !window.confirm(t("rem.confirmReplace", { name }))) return;
    const next = putRemnant(all, { name, mode: getMachineMode(), ...plateSnapshot(), date: new Date().toISOString() });
    if (!next) { log(t("rem.full")); return; }
    try { localStorage.setItem(REM_KEY, JSON.stringify(next)); } catch { log(t("rem.full")); return; }
    $("rem-name")!.value = "";
    refreshRemnants();
    (document.getElementById("rem-list") as HTMLSelectElement).value = name;
    log(t("rem.saved", { name }));
  });
  document.getElementById("rem-load")?.addEventListener("click", () => {
    const r = picked();
    if (!r) return;
    if (hasUsedArea() && !window.confirm(t("rem.confirmLoad", { name: r.name }))) return;
    if (!loadPlateSnapshot(r, r.name)) { log(t("rem.bad", { name: r.name })); return; }
    log(t("rem.loaded", { name: r.name, w: r.w, h: r.h, p: r.percent.toFixed(1) }));
  });
  document.getElementById("rem-delete")?.addEventListener("click", () => {
    const r = picked();
    if (!r || !window.confirm(t("rem.confirmDelete", { name: r.name }))) return;
    try { localStorage.setItem(REM_KEY, JSON.stringify(dropRemnant(remnants(), r.name, r.mode))); } catch { /* egal */ }
    refreshRemnants();
    log(t("rem.deleted", { name: r.name }));
  });

  // ---- Größe ----
  const resize = () => {
    const w = parseFloat($("stock-w")!.value), h = parseFloat($("stock-h")!.value);
    const s = getStock();
    if (!(w > 0 && h > 0) || (w === s.w && h === s.h)) { refresh(); return; }
    if (hasUsedArea() && !window.confirm(t("stock.confirmResize"))) { refresh(); return; }
    newOwnPlate(w, h);
    log(t("stock.resized", { w, h }));
  };
  // ---- Dicke und Lage (die verbrauchte Fläche bleibt) ----
  const pose = (id: string, key: "x" | "y" | "thick") => $(id)?.addEventListener("change", () => {
    const raw = $(id)!.value.trim(), v = raw === "" ? 0 : parseFloat(raw);
    if (Number.isFinite(v)) setStockPose({ [key]: key === "thick" ? Math.max(0, v) : v });
    refresh();
  });
  pose("stock-thick", "thick"); pose("stock-x", "x"); pose("stock-y", "y");
  document.getElementById("stock-fit")?.addEventListener("click", () => {
    const b = groupBounds((state().shapes as any[]).filter(sh => !sh.keepOut));
    if (!b) { log(t("gcw.noObjects")); return; }
    if (hasUsedArea() && !window.confirm(t("stock.confirmResize"))) return;
    const mm = (v: number) => Math.round((v / MM_TO_PIXEL) * 100) / 100, x = mm(b.minX), y = mm(b.minY), w = mm(b.maxX) - x, h = mm(b.maxY) - y;
    if (!(w > 0 && h > 0)) return;
    newOwnPlate(Math.round(w * 100) / 100, Math.round(h * 100) / 100);
    setStockPose({ x, y });
    log(t("stock.resized", { w: getStock().w, h: getStock().h }));
  });
  document.getElementById("stock-reset")?.addEventListener("click", () => {
    if (hasUsedArea() && !window.confirm(t("stock.confirmNew"))) return;
    resetPlate();
    log(t("stock.resized", { w: getStock().w, h: getStock().h }));
  });
  document.getElementById("stock-through")?.addEventListener("click", () => {
    const st = state(), s = getStock();
    const sel = st.shapes.filter((sh: any) => st.selectedShapeIds.includes(sh.id) && !sh.keepOut && sh.type !== "image");
    if (!sel.length) { log(t("stock.throughSelect")); return; }
    if (!(s.thick > 0)) return;
    sel.forEach((sh: any) => { sh.millingDepth = -s.thick; });
    updateDimensionInputs(null); checkpoint(); redraw();
    log(t("stock.throughDone", { n: sel.length, t: s.thick }));
  });
  $("stock-w")?.addEventListener("change", resize);
  $("stock-h")?.addEventListener("change", resize);
  $("stock-margin")?.addEventListener("change", () => {
    const v = parseFloat($("stock-margin")!.value);
    stockOptions.margin = Number.isFinite(v) && v >= 0 ? v : stockOptions.margin;
    saveStockOptions();
  });
  $("stock-show")?.addEventListener("change", () => { stockOptions.show = $("stock-show")!.checked; saveStockOptions(); });
  $("stock-skip-used")?.addEventListener("change", () => { stockOptions.skipUsed = $("stock-skip-used")!.checked; saveStockOptions(); });

  // ---- Knöpfe ----
  document.getElementById("stock-mark")?.addEventListener("click", async () => {
    const st = state();
    if (!st.shapes.length) { log(t("gcw.noObjects")); return; }
    const res = await generateGcodeFull(st.shapes), g = res.gcode;
    if (!g) { log(res.none); return; }
    const added = markFromGcode(g.split("\n"), t("stock.designLabel"), cutWidthFor(st.shapes));
    log(t("stock.marked", { p: added.toFixed(1), total: usedPercent().toFixed(1) }));
  });
  document.getElementById("stock-undo")?.addEventListener("click", () => {
    if (undoLastMark()) log(t("stock.undone"));
  });
  document.getElementById("stock-new")?.addEventListener("click", () => {
    if (hasUsedArea() && !window.confirm(t("stock.confirmNew"))) return;
    newPlate();
    log(t("stock.newDone"));
  });
  document.getElementById("btn-place-free")?.addEventListener("click", () => placeSelection(redraw, log));

  // ---- Job an der Maschine fertig -> Fläche markieren ----
  window.addEventListener("cnc-job-done", (e: Event) => {
    const d = (e as CustomEvent).detail || {};
    if (!d.lines || !d.lines.length) return;
    if (d.simulated) { log(t("stock.demoNotMarked")); return; }
    const width = cutWidthFor(state()?.shapes || []);
    if (d.aborted) {
      if (d.line > 0 && window.confirm(t("stock.confirmPartial", { n: d.line, total: d.lines.length }))) {
        const added = markFromGcode(d.lines, (d.label || "Job") + " (" + t("stock.partial") + ")", width, d.line, d.mode, d.bed);
        log(t("stock.marked", { p: added.toFixed(1), total: usedPercent(getStock(d.mode, d.bed)).toFixed(1) }));
      }
      return;
    }
    const added = markFromGcode(d.lines, d.label || "Job", width, Infinity, d.mode, d.bed);
    log(t("stock.markedJob", { p: added.toFixed(1), total: usedPercent(getStock(d.mode, d.bed)).toFixed(1) }));
  });

  window.addEventListener(STOCK_CHANGED, refresh);
  window.addEventListener(MODE_CHANGED, () => { refresh(); askIfNeeded(); });
  window.addEventListener("cnc-language-changed", refresh);
  refresh();

  // Beim Start fragen (kurz warten, bis alles gezeichnet ist)
  setTimeout(askIfNeeded, 400);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Einmal pro Programmstart und Maschinenart: liegt die Platte noch drauf? */
function askIfNeeded() {
  const mode = getMachineMode();
  if (asked.has(mode)) return;
  asked.add(mode);
  if (!hasUsedArea(mode)) return;
  openPlateQuestion(mode);
}

export function openPlateQuestion(mode: MachineMode) {
  document.getElementById("stock-dialog-overlay")?.remove();
  const s = getStock(mode);
  const last = s.jobs[s.jobs.length - 1];
  const ov = document.createElement("div");
  ov.id = "stock-dialog-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:400px;">
      <h3>🧱 ${t("stock.askTitle")}</h3>
      <canvas id="stock-preview" width="360" height="200" class="stock-preview"></canvas>
      <div style="font-size:0.84rem;line-height:1.45;">${t("stock.askText", {
        mode: t("mode." + mode), w: s.w, h: s.h, p: usedPercent(s).toFixed(1),
        date: last ? fmtDate(last.date) : "–", label: last ? esc(last.label) : "–"
      })}</div>
      <div class="dlg-hint">${t("stock.askHint")}</div>
      <div class="dlg-buttons" style="flex-direction:column;">
        <button id="stock-keep" class="btn-primary">✔ ${t("stock.keep")}</button>
        <button id="stock-fresh" class="btn-secondary">🆕 ${t("stock.fresh")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  drawStockPreview(ov.querySelector("#stock-preview") as HTMLCanvasElement, mode);
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  (ov.querySelector("#stock-keep") as HTMLElement).onclick = () => { close(); window.dispatchEvent(new Event("cnc-redraw")); };
  (ov.querySelector("#stock-fresh") as HTMLElement).onclick = () => { newPlate(); close(); };
  setTimeout(() => (ov.querySelector("#stock-keep") as HTMLElement).focus(), 0);
}

/** Auswahl auf die nächste freie Stelle schieben */
function placeSelection(redraw: () => void, log: (s: string) => void) {
  const st = state();
  const ids = new Set(st.selectedShapeIds);
  const sel = st.shapes.filter((s: any) => ids.has(s.id));
  if (!sel.length) { log(t("stock.placeSelectFirst")); return; }
  const others = st.shapes.filter((s: any) => !ids.has(s.id));
  const res = findFreeSpot(sel, others);
  if (!res) { log(t("stock.placeNoRoom")); return; }
  sel.forEach((s: any) => translateShape(s, res.dx, res.dy));
  log(t("stock.placed", { n: sel.length }));
  redraw();
}
