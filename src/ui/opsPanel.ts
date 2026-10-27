/**
 * BEARBEITUNGEN DER AUSWAHL (rechte Seite, Reiter „Objekt“, nur Fräse)
 *
 *   1. erste Bearbeitung = die Form selbst (Bahn-Korrektur, Werkzeug, Frästiefe wie bisher – nur angezeigt)
 *   2. … weitere Bearbeitungen (shape.ops): Art, Werkzeug, Tiefe bzw. Fasenbreite, ✕ entfernen
 *   ＋ Bearbeitung hinzufügen
 * Änderungen gelten für alle ausgewählten Formen (sie bekommen dieselbe Liste) – oder mit „Gilt für“ nur für die
 * Formen einer Art, z. B. nur die Löcher eines Teils (Fase an den Löchern, nicht am Umriss).
 * Außerdem „Werkzeuge zuweisen“: je Bearbeitungsart ein Werkzeug für die ganze Zeichnung bzw. Auswahl.
 */
import { t, T, tip } from "../i18n/i18n";
import { getTools, getTool, toolForShape, toolLabel } from "../toolLibrary";
import { OP_KINDS, OpKind, ShapeOp, extraOps } from "../ops";

const KEEP = "__keep__";

function state(): any { return (window as any).cncState; }
function selectedShapes(): any[] {
  const st = state();
  if (!st) return [];
  const ids = new Set(st.selectedShapeIds);
  return st.shapes.filter((s: any) => ids.has(s.id) && s.type !== "image");
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
const kindLabel = (k: string) => t("ops.kind." + k);
const modeOf = (s: any) => s.millingMode || "outside";

/** „Gilt für“: alle ausgewählten Formen oder nur die mit dieser ersten Bearbeitung */
let forKind = "all";
function targets(): any[] {
  const sel = selectedShapes();
  const only = sel.filter(s => modeOf(s) === forKind);
  return forKind !== "all" && only.length ? only : sel;
}

/** HTML für den Abschnitt im Reiter „Objekt“ */
export function opsPanelHtml(): string {
  return `
    <div class="menu-section-unified only-mill needs-sel">
      <h3 class="menu-trigger">${T("ops.title")}</h3>
      <div class="menu-body rp-box">
        <label class="prop-row" id="ops-for-row" style="display:none;" ${tip("ops.forTip")}>${T("ops.for")}
          <select id="ops-for" class="prop-input" style="width:170px;"></select></label>
        <div id="ops-list"></div>
        <button id="ops-add" class="btn-secondary" style="width:100%;margin-top:4px;" ${tip("ops.addTip")}>＋ ${T("ops.add")}</button>
        <div id="ops-scope" class="tool-scope"></div>
      </div>
    </div>`;
}

let lastSig = "";
let redrawFn: () => void = () => {};
let logFn: (s: string) => void = () => {};

export function initOpsPanel(redraw: () => void, log: (s: string) => void) {
  redrawFn = redraw;
  logFn = log;
  const list = document.getElementById("ops-list");
  if (!list) return;
  const apply = (ops: ShapeOp[]) => {
    for (const s of targets()) { if (ops.length) s.ops = ops.map(o => ({ ...o })); else delete s.ops; }
    refreshOps(true);
    redrawFn();
  };
  const readRows = (): ShapeOp[] => [...list.querySelectorAll<HTMLElement>(".ops-row[data-i]")].map(r => {
    const q = (c: string) => r.querySelector("." + c) as HTMLInputElement | null;
    // Felder, die bei dieser Art nicht zu sehen sind, behalten ihren bisherigen Wert
    const prev = extraOps(targets()[0])[Number(r.dataset.i)];
    const kind = (q("ops-kind")?.value || "chamfer") as OpKind;
    const tool = q("ops-tool")?.value || "";
    const depth = parseFloat(q("ops-depth")?.value || "");
    const cw = parseFloat(q("ops-cw")?.value || "");
    const td = parseFloat(q("ops-td")?.value || "");
    const tp = parseFloat(q("ops-tp")?.value || "");
    const tn = parseFloat(q("ops-tn")?.value || "");
    const left = q("ops-left"), spring = q("ops-spring");
    return {
      kind, toolId: tool || undefined,
      depth: Number.isFinite(depth) ? Math.min(0, depth) : prev?.depth ?? -1,
      chamferW: Number.isFinite(cw) && cw > 0 ? cw : prev?.chamferW ?? 1,
      ...(kind === "thread" ? {
        threadD: Number.isFinite(td) && td >= 0 ? td : prev?.threadD ?? 0,
        threadLeft: left ? left.checked : prev?.threadLeft ?? false,
        threadPitch: Number.isFinite(tp) && tp >= 0 ? tp : prev?.threadPitch ?? 0,
        threadPasses: Number.isFinite(tn) && tn >= 1 ? Math.min(10, Math.round(tn)) : prev?.threadPasses ?? 1,
        threadSpring: spring ? spring.checked : prev?.threadSpring ?? false
      } : {})
    };
  });
  list.addEventListener("change", () => apply(readRows()));
  list.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest("[data-del]") as HTMLElement | null;
    if (!b) return;
    const ops = readRows();
    ops.splice(Number(b.dataset.del), 1);
    apply(ops);
  });
  document.getElementById("ops-add")?.addEventListener("click", () => {
    const s0 = targets()[0];
    if (!s0) return;
    const ops = readRows();
    // Vorschlag: Fase an der Kante, Tiefe wie die Form
    ops.push({ kind: "chamfer", depth: typeof s0.millingDepth === "number" ? s0.millingDepth : -2, chamferW: 1 });
    apply(ops);
  });
  const forSel = document.getElementById("ops-for") as HTMLSelectElement | null;
  forSel?.addEventListener("change", () => { forKind = forSel.value; forSel.blur(); refreshOps(true); });
  document.getElementById("cam-assign-tools")?.addEventListener("click", () => openAssignTools());
  window.addEventListener("cnc-tools-changed", () => refreshOps(true));
  window.addEventListener("cnc-language-changed", () => refreshOps(true));
}

/** Liste an die Auswahl anpassen (aus der Zeichenschleife – macht nur bei Änderungen etwas) */
export function refreshOps(force = false) {
  const list = document.getElementById("ops-list");
  if (!list) return;
  const sel = selectedShapes();
  // Arten in der Auswahl (z. B. 1 außen + 2 innen) → Auswahl „Gilt für“
  const kinds = new Map<string, number>();
  for (const s of sel) kinds.set(modeOf(s), (kinds.get(modeOf(s)) || 0) + 1);
  if (!kinds.has(forKind)) forKind = "all";
  const tg = targets();
  const s0 = tg[0];
  const sig = sel.map(s => s.id).join(",") + "|" + forKind + "|" + (s0 ? JSON.stringify([s0.millingMode, s0.toolId, s0.millingDepth, s0.ops]) : "") + "|" + getTools().length;
  if (!force && sig === lastSig) return;
  if (!force && list.contains(document.activeElement)) return; // nicht unter den Fingern neu zeichnen
  lastSig = sig;
  const forRow = document.getElementById("ops-for-row") as HTMLElement | null;
  const forSel = document.getElementById("ops-for") as HTMLSelectElement | null;
  if (forRow && forSel) {
    forRow.style.display = kinds.size > 1 ? "" : "none";
    forSel.innerHTML = `<option value="all">${esc(t("ops.forAll", { n: sel.length }))}</option>`
      + [...kinds.entries()].map(([k, n]) => `<option value="${k}">${esc(t("ops.forKind", { k: kindLabel(k), n }))}</option>`).join("");
    forSel.value = forKind;
  }
  if (!s0) { list.innerHTML = ""; return; }
  const tools = getTools();
  const toolOpts = (id?: string) => `<option value="">${esc(t("ops.toolDefault"))}</option>`
    + tools.map(tl => `<option value="${tl.id}"${tl.id === id ? " selected" : ""}>${esc(toolLabel(tl))}</option>`).join("");
  const main = toolForShape(s0);
  const depth0 = typeof s0.millingDepth === "number" ? s0.millingDepth : -2;
  const first = `
    <div class="ops-row ops-first" style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);" ${tip("ops.firstTip")}>
      <b>1.</b> ${esc(kindLabel(s0.millingMode || "outside"))} · ${esc(main ? toolLabel(main) : "–")} · ${depth0} mm
    </div>`;
  const rows = extraOps(s0).map((o, i) => `
    <div class="ops-row" data-i="${i}" style="padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;flex-direction:column;gap:3px;">
      <div style="display:flex;gap:4px;align-items:center;">
        <b>${i + 2}.</b>
        <select class="prop-input ops-kind" style="flex:1;min-width:0;">${OP_KINDS.map(k => `<option value="${k}"${k === o.kind ? " selected" : ""}>${esc(kindLabel(k))}</option>`).join("")}</select>
        <button type="button" class="btn-secondary btn-icon" data-del="${i}" ${tip("ops.delTip")}>✕</button>
      </div>
      <select class="prop-input ops-tool" style="width:100%;">${toolOpts(o.toolId)}</select>
      ${o.kind === "chamfer"
        ? `<div class="prop-row" ${tip("ops.cwTip")}>${T("ops.cw")}<input type="number" class="prop-input ops-cw" min="0.05" step="0.1" value="${o.chamferW}"></div>`
        : o.kind === "thread"
        ? `<div class="prop-row" ${tip("ops.threadLenTip")}>${T("ops.threadLen")}<input type="number" class="prop-input ops-depth" step="0.5" value="${o.depth}"></div>
           <div class="prop-row" ${tip("ops.threadDTip")}>${T("ops.threadD")}<input type="number" class="prop-input ops-td" min="0" step="0.5" value="${o.threadD || 0}"></div>
           <div class="prop-row" ${tip("ops.threadPitchTip")}>${T("ops.threadPitch")}<input type="number" class="prop-input ops-tp" min="0" step="0.05" value="${o.threadPitch || 0}"></div>
           <div class="prop-row" ${tip("ops.threadPassesTip")}>${T("ops.threadPasses")}<input type="number" class="prop-input ops-tn" min="1" max="10" step="1" value="${o.threadPasses || 1}"></div>
           <label class="prop-row" style="cursor:pointer;" ${tip("ops.threadSpringTip")}>${T("ops.threadSpring")}<input type="checkbox" class="ops-spring" style="width:auto;"${o.threadSpring ? " checked" : ""}></label>
           <label class="prop-row" style="cursor:pointer;" ${tip("ops.threadLeftTip")}>${T("ops.threadLeft")}<input type="checkbox" class="ops-left" style="width:auto;"${o.threadLeft ? " checked" : ""}></label>`
        : `<div class="prop-row">${T("rp.depth")}<input type="number" class="prop-input ops-depth" step="0.5" value="${o.depth}"></div>`}
    </div>`).join("");
  list.innerHTML = first + rows;
  const scope = document.getElementById("ops-scope");
  if (scope) scope.textContent = tg.length > 1 ? t("ops.scope", { n: tg.length }) : "";
}

// ---------------------------------------------------------------------
// WERKZEUGE ZUWEISEN (je Bearbeitungsart)
// ---------------------------------------------------------------------

export function openAssignTools() {
  const st = state();
  if (!st) return;
  const sel = selectedShapes();
  const scope = (sel.length ? sel : st.shapes).filter((s: any) => s.type !== "image");
  // wie oft kommt jede Art vor (erste Bearbeitung + weitere)
  const count = new Map<string, number>();
  for (const s of scope) {
    const m = s.millingMode || "outside";
    count.set(m, (count.get(m) || 0) + 1);
    for (const o of extraOps(s)) count.set(o.kind, (count.get(o.kind) || 0) + 1);
  }
  const kinds = OP_KINDS.filter(k => count.has(k));
  document.getElementById("assign-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "assign-overlay";
  ov.className = "dlg-overlay";
  const tools = getTools();
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:460px;">
      <h3>🔧 ${esc(t("ops.assignTitle"))}</h3>
      <div class="dlg-hint">${esc(t(sel.length ? "ops.assignDescSel" : "ops.assignDescAll", { n: scope.length }))}</div>
      ${kinds.length ? kinds.map(k => `
        <label class="dlg-row"><span>${esc(kindLabel(k))} <span class="tool-scope">(${count.get(k)})</span></span>
          <select class="prop-input" data-kind="${k}" style="width:210px;">
            <option value="${KEEP}">${esc(t("ops.keep"))}</option>
            <option value="">${esc(t("ops.toolDefault"))}</option>
            ${tools.map(tl => `<option value="${tl.id}">${esc(toolLabel(tl))}</option>`).join("")}
          </select></label>`).join("") : `<div class="dlg-hint">${esc(t("ops.assignNone"))}</div>`}
      <div class="dlg-buttons">
        <button id="as-cancel" class="btn-secondary">${esc(t("dlg.cancel"))}</button>
        <button id="as-ok" class="btn-primary">✔ ${esc(t("ops.assignApply"))}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  (ov.querySelector("#as-cancel") as HTMLElement).onclick = close;
  (ov.querySelector("#as-ok") as HTMLElement).onclick = () => {
    const pick = new Map<string, string>();
    ov.querySelectorAll<HTMLSelectElement>("select[data-kind]").forEach(s => { if (s.value !== KEEP) pick.set(s.dataset.kind!, s.value); });
    let n = 0;
    const setTool = (o: any, id: string) => { if (id && getTool(id)) o.toolId = id; else delete o.toolId; n++; };
    for (const s of scope) {
      const m = s.millingMode || "outside";
      if (pick.has(m)) setTool(s, pick.get(m)!);
      if (Array.isArray(s.ops)) for (const o of s.ops) if (o && pick.has(o.kind)) setTool(o, pick.get(o.kind)!);
    }
    close();
    logFn(t("ops.assignDone", { n }));
    refreshOps(true);
    redrawFn();
  };
}
