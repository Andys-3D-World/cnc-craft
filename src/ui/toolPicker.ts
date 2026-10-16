/**
 * WERKZEUG-AUSWAHL IM CAM-BEREICH (wie in Estlcam)
 *
 * Rechte Seite, Reiter "Objekt":
 *   - Formen ausgewählt  -> das gewählte Werkzeug gilt für diese Formen (shape.toolId)
 *   - nichts ausgewählt  -> das gewählte Werkzeug wird Standard-Werkzeug
 *                           (gilt für alle Formen ohne eigenes Werkzeug)
 *   - ＋ neues Werkzeug, ✎ Werkzeug bearbeiten – ohne den Reiter "Werkzeuge" zu öffnen
 *
 * Rechte Seite, Reiter "Fräsen":
 *   - Liste der Werkzeuge, die im Auftrag benutzt werden, in Fräs-Reihenfolge
 *     (Klick = alle Formen mit diesem Werkzeug auswählen)
 */
import { t, T, tip } from "../i18n/i18n";
import {
  getTools, getTool, activeTool, setActiveTool, toolForShape, toolLabel, toolInfo, toolColor,
  TOOLS_CHANGED, MillingTool
} from "../toolLibrary";
import { openToolDialog } from "./toolEditor";
import { orderToolGroups } from "../cam";

const DEFAULT = "__default__";
const MIXED = "__mixed__";

function state(): any {
  return (window as any).cncState;
}

function selectedShapes(): any[] {
  const st = state();
  if (!st) return [];
  const ids = new Set(st.selectedShapeIds);
  return st.shapes.filter((s: any) => ids.has(s.id));
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

/** HTML für den Abschnitt im Reiter "Objekt" */
export function toolPickerHtml(): string {
  return `
    <div class="menu-section-unified only-mill">
      <h3 class="menu-trigger">${T("tool.section")}</h3>
      <div class="menu-body rp-box tool-picker">
        <div class="tool-pick-row">
          <span id="cam-tool-swatch" class="tool-dot tool-dot-lg"></span>
          <select id="cam-tool-select" class="prop-input" ${tip("tool.selectTip")}></select>
          <button id="cam-tool-edit" class="btn-secondary btn-icon" ${tip("tool.editTip")}>✎</button>
          <button id="cam-tool-new" class="btn-secondary btn-icon" ${tip("tool.newTip")}>＋</button>
        </div>
        <div id="cam-tool-info" class="tool-info"></div>
        <div id="cam-tool-scope" class="tool-scope"></div>
      </div>
    </div>`;
}

/** HTML für den Abschnitt im Reiter "Fräsen" */
export function toolSummaryHtml(): string {
  return `
    <div class="menu-section-unified only-mill">
      <h3 class="menu-trigger">${T("tool.jobTools")}</h3>
      <div class="menu-body">
        <div id="cam-tool-summary" class="tool-summary"></div>
      </div>
    </div>`;
}

let lastSig = "";

/** Einmal beim Start aufrufen (nachdem das rechte Panel gezeichnet ist) */
export function initToolPicker(redraw: () => void) {
  const sel = document.getElementById("cam-tool-select") as HTMLSelectElement | null;
  if (!sel) return;

  sel.addEventListener("change", () => {
    const v = sel.value;
    const shapes = selectedShapes();
    if (shapes.length) {
      if (v === MIXED) return;
      shapes.forEach(s => {
        if (v === DEFAULT) delete s.toolId;
        else s.toolId = v;
      });
      redraw();
    } else if (v !== DEFAULT && v !== MIXED) {
      setActiveTool(v);
    }
    sel.blur();
    refreshToolPicker(true);
  });

  document.getElementById("cam-tool-edit")?.addEventListener("click", () => {
    const tool = currentShownTool();
    if (tool) openToolDialog(tool, () => { refreshToolPicker(true); redraw(); });
  });

  document.getElementById("cam-tool-new")?.addEventListener("click", () => {
    openToolDialog(null, (tool) => {
      if (!tool) return;
      // Neues Werkzeug gleich benutzen: für die Auswahl, sonst als Standard
      const shapes = selectedShapes();
      if (shapes.length) shapes.forEach(s => { s.toolId = tool.id; });
      else setActiveTool(tool.id);
      refreshToolPicker(true);
      redraw();
    });
  });

  document.getElementById("cam-tool-summary")?.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest("[data-tool-id]") as HTMLElement | null;
    if (!row || !row.dataset.toolId) return;
    const id = row.dataset.toolId;
    const st = state();
    st.selectedShapeIds = st.shapes.filter((s: any) => toolForShape(s)?.id === id).map((s: any) => s.id);
    // zum Reiter "Objekt" wechseln, dort sieht man die Auswahl
    (document.querySelector('.rp-tab[data-rp="rp-object"]') as HTMLElement | null)?.click();
    redraw();
  });

  window.addEventListener(TOOLS_CHANGED, () => { refreshToolPicker(true); redraw(); });
  window.addEventListener("cnc-language-changed", () => refreshToolPicker(true));
  refreshToolPicker(true);
}

/** Werkzeug, das gerade im Feld steht (für ✎) */
function currentShownTool(): MillingTool | null {
  const shapes = selectedShapes();
  if (!shapes.length) return activeTool;
  const ids = new Set(shapes.map(s => toolForShape(s)?.id));
  if (ids.size !== 1) return null;
  return getTool([...ids][0] as string);
}

/**
 * Aktualisiert Auswahlfeld, Info und Auftragsliste. Wird aus der Zeichenschleife aufgerufen
 * und macht nur etwas, wenn sich Auswahl/Werkzeuge geändert haben.
 */
export function refreshToolPicker(force = false) {
  const st = state();
  const sel = document.getElementById("cam-tool-select") as HTMLSelectElement | null;
  if (!st || !sel) return;
  const shapes = selectedShapes();
  const sig = st.selectedShapeIds.join(",") + "|" + st.shapes.length + "|"
    + st.shapes.map((s: any) => (s.toolId || "") + (s.millingMode || "")).join(",") + "|" + (activeTool?.id || "");
  if (!force && sig === lastSig) return;
  lastSig = sig;

  const tools = getTools();
  const def = activeTool;

  // ---- Auswahlfeld ----
  let value: string;
  let shown: MillingTool | null;
  const opts: string[] = [];
  if (shapes.length) {
    const own = new Set(shapes.map(s => (getTool(s.toolId) ? s.toolId : "")));
    if (own.size > 1) { value = MIXED; shown = null; }
    else { const only = [...own][0] as string; value = only || DEFAULT; shown = only ? getTool(only) : def; }
    if (value === MIXED) opts.push(`<option value="${MIXED}" disabled>${esc(t("tool.mixed"))}</option>`);
    opts.push(`<option value="${DEFAULT}">${esc(t("tool.useDefault", { name: def ? toolLabel(def) : "–" }))}</option>`);
  } else {
    value = def?.id || "";
    shown = def;
  }
  tools.forEach(tl => opts.push(`<option value="${tl.id}">${esc(toolLabel(tl))}</option>`));
  sel.innerHTML = opts.join("");
  sel.value = value;

  // ---- Info + Geltungsbereich ----
  const info = document.getElementById("cam-tool-info");
  if (info) info.textContent = shown ? toolInfo(shown) : t("tool.mixedInfo");
  const scope = document.getElementById("cam-tool-scope");
  if (scope) {
    scope.textContent = shapes.length
      ? t("tool.scopeSelection", { n: shapes.length })
      : t("tool.scopeDefault");
  }
  const sw = document.getElementById("cam-tool-swatch");
  if (sw) sw.style.background = shown ? toolColor(shown) : "conic-gradient(#ff9f43 0 33%, #c084fc 0 66%, #a3e635 0)";
  const edit = document.getElementById("cam-tool-edit") as HTMLButtonElement | null;
  if (edit) edit.disabled = !shown;

  renderSummary();
}

/** Werkzeuge im Auftrag (Reiter "Fräsen") */
function renderSummary() {
  const box = document.getElementById("cam-tool-summary");
  const st = state();
  if (!box || !st) return;
  const groups = orderToolGroups(st.shapes);
  if (!groups.length) { box.innerHTML = `<div class="tool-scope">${esc(t("tool.noShapes"))}</div>`; return; }
  box.innerHTML = groups.map((g, i) => `
    <div class="tool-sum-row" data-tool-id="${g.tool ? g.tool.id : ""}" ${g.tool ? `data-tip="${esc(t("tool.selectByTool"))}"` : ""}>
      <span class="tool-sum-n" style="background:${g.tool ? toolColor(g.tool) : "var(--accent-color)"}">${i + 1}</span>
      <span class="tool-sum-name">${esc(g.tool ? toolLabel(g.tool) : "–")}</span>
      <span class="tool-sum-count">${esc(t("tool.shapeCount", { n: g.shapes.length }))}</span>
    </div>`).join("")
    + (groups.length > 1 ? `<div class="tool-scope">⏸ ${esc(t("tool.changesHint", { n: groups.length - 1 }))}</div>` : "");
}
