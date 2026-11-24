/**
 * RE-IMPORT A DRAWING – window and canvas (matching: reimportMatch.ts, applying: reimportApply.ts, reading: importManager.ts)
 *
 *  - which file: the one of the selection, else a list of the drawings in the project
 *  - window next to the canvas with what would happen: changed, new, gone, unclear, unchanged; every entry can be
 *    clicked (bed and shape are shown), kinds and placed parts can be switched off, unclear ones are assigned by hand
 *  - canvas: changed = orange (old dashed), new = green, gone = red, unclear = violet with numbered candidates
 *  - nothing is changed before "Update drawing"; that is one undo step on all beds
 *
 * File and layer names are foreign text: always esc() or textContent. Nothing here goes to the machine.
 */
import { t } from "../i18n/i18n";
import { app, toScreen } from "../editor/editorState";
import { activeBed, bedCount, bedName, bedSplit, pieceBeds, replaceSheets, sheetLists, showSide, switchBed, viewSide, type SheetList } from "../editor/beds";
import { selectedShapes } from "../editor/selection";
import { groupBounds, isClosedShape, shapeBounds, shapeToPaths, MM_TO_PIXEL } from "../shapeTransform";
import { updateDimensionInputs } from "../uiInputs";
import { isLinked } from "../linkedCopies";
import { fmtLenShort, fmtLenU, unitName } from "../units";
import { candidates, cleanImp, countKinds, planReimport, type Item, type Plan } from "../reimportMatch";
import { applyPlan, defaultChoices, placedShape, type Choices } from "../reimportApply";
import { reimportWithDialog, REIMPORT_EXTENSIONS } from "../importers/importManager";
import { openToolPanel, type ToolPanel } from "./toolPanel";
import { icon } from "./icons";

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const extOf = (n: string) => (n.split(".").pop() || "").toLowerCase();

const COLOR = { changed: "#ffa53a", new: "#34d17b", gone: "#ff5a5a", unclear: "#b48cff" } as const;
/** 3D models are cut into other triangles after every change (0.05 mm instead of 0.02 mm) */
const MESH_TOL = 0.1;
const MAX_ROWS = 80;
const linkCss = "background:none;border:none;padding:0;color:inherit;font:inherit;text-align:left;cursor:pointer;";

// =====================================================================
// WHICH DRAWING
// =====================================================================

/** Can this shape be updated from its file? */
export function canReimport(s: any): boolean {
  return !!s && typeof s.source === "string" && REIMPORT_EXTENSIONS.includes(extOf(s.source)) && candidates([s], s.source).length === 1;
}

/** Imported drawings of the project (file name, number of shapes, beds) */
export function knownSources(): { name: string; n: number; beds: number[] }[] {
  const m = new Map<string, { name: string; n: number; beds: number[] }>();
  for (const l of sheetLists()) for (const s of l.shapes) {
    if (!canReimport(s)) continue;
    let e = m.get(s.source);
    if (!e) { e = { name: s.source, n: 0, beds: [] }; m.set(s.source, e); }
    e.n++;
    if (!e.beds.includes(l.bed)) e.beds.push(l.bed);
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** All shapes of a drawing (all beds and sides) */
export function shapesOf(source: string): any[] {
  return sheetLists().flatMap(l => candidates(l.shapes, source));
}

/** Command: choose the drawing (or take the one of the selection), then its file */
export function openReimport(log: (s: string) => void) {
  const all = knownSources();
  if (!all.length) { log(t("reimp.none")); return; }
  const sel = new Set(selectedShapes().filter(canReimport).map(s => s.source));
  if (sel.size === 1) { void reimportWithDialog([...sel][0]); return; }
  if (all.length === 1) { void reimportWithDialog(all[0].name); return; }
  document.getElementById("reimp-overlay")?.remove();
  const list = sel.size ? all.filter(s => sel.has(s.name)) : all;
  const ov = document.createElement("div");
  ov.id = "reimp-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:440px;">
      <h3>${icon("reimport", 18)}${t("reimp.title")}</h3>
      <div class="dlg-hint">${t("reimp.which")}</div>
      ${list.map((s, i) => `<button type="button" class="imguse-btn" data-i="${i}"><b>${esc(s.name)}</b><span>${esc(t("reimp.sourceInfo", { n: s.n, beds: s.beds.map(b => bedName(b)).join(", ") }))}</span></button>`).join("")}
      <div class="dlg-buttons"><button type="button" class="btn-secondary" data-i="">${t("dlg.cancel")}</button></div>
    </div>`;
  document.body.appendChild(ov);
  const done = (name: string | null) => { ov.remove(); if (name) void reimportWithDialog(name); };
  ov.querySelectorAll<HTMLElement>("[data-i]").forEach(b => b.addEventListener("click", () => done(b.dataset.i ? list[Number(b.dataset.i)].name : null)));
  ov.addEventListener("mousedown", e => { if (e.target === ov) done(null); });
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") done(null); });
  (ov.querySelector(".imguse-btn") as HTMLElement).focus();
}

// =====================================================================
// WINDOW
// =====================================================================

export interface ReimportInput {
  source: string;               // name the shapes carry
  name: string;                 // file that was chosen
  shapes: any[];                // shapes of the file in the file frame
  mesh: boolean;
  warnings: string[];
  log: (s: string) => void;
  redraw: () => void;
  asNew: () => void;            // import normally instead
}

let inp: ReimportInput | null = null;
let panel: ToolPanel | null = null;
let plan: Plan | null = null;
let ch: Choices | null = null;
let sheets: SheetList[] = [];
let sig = "";
let unit: "before" | "file" = "before";
let hot = -1;                                    // item under the mouse / clicked
let placed = new Map<string, any>();             // cluster|file shape → placed shape
let candNo = new Map<string, number>();          // cluster|file shape → number on the canvas

const signature = (l: SheetList[]) => JSON.stringify(l.map(x => [x.bed, x.hidden, x.shapes]));

function place(cluster: number, nu: number): any {
  const k = cluster + "|" + nu;
  let s = placed.get(k);
  if (!s) { s = placedShape(plan!, cluster, nu); placed.set(k, s); }
  return s;
}

function compute(keep: boolean) {
  const oldPlan = plan, oldCh = ch, oldSheets = sheets;
  const clusterKey = (p: Plan, l: SheetList[], i: number) => { const c = p.clusters[i], x = c && l[c.list]; return x ? [x.bed, x.side, ...c.ids].join("|") : ""; };
  sheets = sheetLists();
  sig = signature(sheets);
  plan = planReimport(sheets, inp!.shapes, { source: inp!.source, unit, ...(inp!.mesh ? { tol: MESH_TOL } : {}) });
  ch = defaultChoices(plan);
  if (keep && oldPlan && oldCh) {
    // what the user chose stays as far as it still exists
    ch.changed = oldCh.changed; ch.added = oldCh.added; ch.gone = oldCh.gone; ch.openNew = oldCh.openNew;
    const itemKey = (p: Plan, l: SheetList[], i: Item) => `${i.kind}|${i.oldId ?? clusterKey(p, l, i.cluster)}|${i.oldId ? "" : i.nu}`;
    const off = new Set(oldPlan.items.filter(i => oldCh.off.has(i.id)).map(i => itemKey(oldPlan, oldSheets, i)));
    for (const i of plan.items) if (off.has(itemKey(plan, sheets, i))) ch.off.add(i.id);
    const skipped = new Set([...oldCh.skip].map(i => clusterKey(oldPlan, oldSheets, i)));
    plan.clusters.forEach((_, i) => { if (skipped.has(clusterKey(plan!, sheets, i))) ch!.skip.add(i); });
    for (const i of plan.items) if (i.kind === "unclear") {
      const was = oldPlan.items.find(x => x.kind === "unclear" && x.oldId === i.oldId), v = was && oldCh.unclear.get(was.id);
      if (v === "gone" || (v !== undefined && i.cands?.includes(v))) ch.unclear.set(i.id, v);
    }
  }
  placed = new Map();
  candNo = new Map();
  for (const i of plan.items) if (i.kind === "unclear") for (const c of i.cands ?? []) { const k = i.cluster + "|" + c; if (!candNo.has(k)) candNo.set(k, candNo.size + 1); }
  hot = -1;
}

/** Was the drawing changed since the plan was made? Then make it again */
function refreshIfStale(): boolean {
  if (!inp || !panel) return false;
  if (signature(sheetLists()) === sig) return false;
  compute(true);
  if (!plan!.items.some(i => i.oldId)) { panel.close(); return true; }
  render();
  return true;
}
const later = () => { if (panel) setTimeout(() => { if (refreshIfStale()) inp?.redraw(); }, 0); };

const oldOf = (i: Item) => sheets[i.list]?.shapes.find(s => s.id === i.oldId);

/** "Circle Ø 5 mm", "Contour 40 × 20 mm" */
function nameOf(s: any, i?: Item): string {
  if (!s) return "";
  if (i?.box && s.type !== "circle") return t(isClosedShape(s) ? "reimp.s.closed" : "reimp.s.open", { w: fmtLenShort(i.box[0], 2), h: fmtLenShort(i.box[1], 2), u: unitName() });
  if (s.type === "circle") return t("reimp.s.circle", { d: fmtLenShort((2 * Math.abs(s.w)) / MM_TO_PIXEL, 2), u: unitName() });
  const b = shapeBounds(s);
  const w = b ? fmtLenShort((b.maxX - b.minX) / MM_TO_PIXEL, 2) : "", h = b ? fmtLenShort((b.maxY - b.minY) / MM_TO_PIXEL, 2) : "";
  return t(isClosedShape(s) ? "reimp.s.closed" : "reimp.s.open", { w, h, u: unitName() });
}
function posOf(s: any): string {
  const b = s && shapeBounds(s);
  return b ? t("reimp.at", { x: fmtLenShort((b.minX + b.maxX) / 2 / MM_TO_PIXEL, 1), y: fmtLenShort((b.minY + b.maxY) / 2 / MM_TO_PIXEL, 1) }) : "";
}
function whatOf(i: Item): string {
  const a: string[] = [];
  const pair = (w: number, h: number) => `${fmtLenShort(w, 2)} × ${fmtLenShort(h, 2)}`;
  const round = oldOf(i)?.type === "circle", resized = !round && !!i.size && !!i.box;
  if (resized) a.push(t("reimp.w.size", { a: pair(i.box![0], i.box![1]), b: pair(i.box![2], i.box![3]), u: unitName() }));
  else if (i.size) a.push(t("reimp.w.size", { a: fmtLenShort(i.size[0], 2), b: fmtLenShort(i.size[1], 2), u: unitName() }));
  // a contour that grew on one side has another centre: that is no move
  if (i.moved !== undefined && !resized) a.push(t("reimp.w.moved", { d: fmtLenU(i.moved, 2) }));
  if (i.depth) a.push(t("reimp.w.depth", { a: fmtLenShort(i.depth[0], 2), b: fmtLenShort(i.depth[1], 2), u: unitName() }));
  if (i.kind === "changed" && !a.length) a.push(t("reimp.w.form"));
  if (i.kind === "new" && i.part) a.push(t("reimp.w.part"));
  return a.join(", ");
}
function placeName(l: SheetList): string {
  return bedName(l.bed) + (l.side ? " · " + t(l.side === "front" ? "two.front" : "two.back") : "");
}

export function openReimportPanel(o: ReimportInput) {
  panel?.close();
  inp = o;
  unit = "before";
  ch = null;
  compute(false);
  if (!plan!.items.some(i => i.oldId)) { o.log(t("reimp.none")); inp = null; return; }
  const p = openToolPanel({
    id: "reimport-panel", ico: "reimport", title: t("reimp.title"), ok: "✔ " + t("reimp.apply"), redraw: o.redraw,
    body: `<div id="ri-body" style="display:flex;flex-direction:column;gap:9px;font-size:0.82rem;"></div>`,
    onChange: () => {},
    onOk: () => apply(),
    onClose: () => {
      panel = null; inp = null; plan = null; ch = null; sheets = []; placed = new Map();
      ["mouseup", "keyup", "click"].forEach(e => window.removeEventListener(e, later, true));
    }
  });
  panel = p;
  ["mouseup", "keyup", "click"].forEach(e => window.addEventListener(e, later, true));
  const body = p.$<HTMLElement>("#ri-body");
  body.addEventListener("change", e => {
    const el = e.target as HTMLInputElement;
    if (!ch || !plan) return;
    const d = el.dataset;
    if (d.kind === "changed") ch.changed = el.checked;
    if (d.kind === "new") ch.added = el.checked;
    if (d.kind === "gone") ch.gone = el.checked;
    if (d.open !== undefined) ch.openNew = el.checked;
    if (d.cluster !== undefined) { if (el.checked) ch.skip.delete(Number(d.cluster)); else ch.skip.add(Number(d.cluster)); }
    if (d.one !== undefined) { if (el.checked) ch.off.delete(Number(d.one)); else ch.off.add(Number(d.one)); }
    if (d.item !== undefined) {
      const id = Number(d.item);
      if (el.value === "") ch.unclear.delete(id); else ch.unclear.set(id, el.value === "gone" ? "gone" : Number(el.value));
      show(plan.items.find(i => i.id === id));
    }
    if (d.unit !== undefined) { unit = el.value === "file" ? "file" : "before"; compute(true); }
    render();
    inp?.redraw();
  });
  body.addEventListener("click", e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-show],[data-cshow],[data-new]");
    if (!el || !plan) return;
    if (el.dataset.new !== undefined) { const f = inp?.asNew; panel?.close(); f?.(); return; }
    if (el.dataset.show !== undefined) show(plan.items.find(i => i.id === Number(el.dataset.show)));
    if (el.dataset.cshow !== undefined) showCluster(Number(el.dataset.cshow));
    inp?.redraw();
  });
  render();
  o.redraw();
}

function goTo(l: SheetList) {
  if (l.bed !== activeBed()) switchBed(l.bed);
  if (l.side && viewSide() !== l.side) showSide(l.side);
  // the lists were swapped, not changed
  if (inp) { sheets = sheetLists(); sig = signature(sheets); }
}

/** Show an entry: its bed, its shape selected */
function show(i?: Item) {
  if (!i) return;
  const bed = sheets[i.list].bed, side = sheets[i.list].side;
  const before = sheets;
  goTo(sheets[i.list]);
  // the order of the lists may differ after a switch (shown side first): plan again when it does
  if (before.some((l, k) => l.bed !== sheets[k]?.bed || l.side !== sheets[k]?.side)) {
    const id = i.oldId, nu = i.nu;
    compute(true);
    render();
    i = plan!.items.find(x => (id ? x.oldId === id : x.nu === nu && sheets[x.list].bed === bed && sheets[x.list].side === side));
    if (!i) return;
  }
  hot = i.id;
  app().selectedShapeIds = i.oldId ? [i.oldId] : [];
  updateDimensionInputs(null);
}

function showCluster(c: number) {
  const cl = plan!.clusters[c];
  if (!cl) return;
  const ids = cl.ids;
  goTo(sheets[cl.list]);
  compute(true);
  render();
  app().selectedShapeIds = app().shapes.filter((s: any) => ids.includes(s.id)).map((s: any) => s.id);
  updateDimensionInputs(null);
}

function render() {
  if (!panel || !plan || !ch || !inp) return;
  const p = plan, c = ch, body = panel.$<HTMLElement>("#ri-body");
  const on = (i: Item) => !c.skip.has(i.cluster);
  const n = countKinds(p);
  const chip = (col: string) => `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${col};flex:none;"></span>`;
  const warn = (s: string) => `<div style="color:var(--lt-amber, #ffb454);">⚠ ${s}</div>`;
  const note = (s: string) => `<div style="color:var(--text-muted);">${s}</div>`;
  const html: string[] = [];
  html.push(`<div><b>${esc(inp.name)}</b>${inp.name !== inp.source ? `<br>${esc(t("reimp.otherName", { name: inp.source }))}` : ""}</div>`);
  if (p.unitFactor) {
    const f = p.unitFactor >= 1 ? "× " + fmtNum(p.unitFactor) : "÷ " + fmtNum(1 / p.unitFactor);
    html.push(warn(esc(t("reimp.unit", { f }))) + `<select data-unit="1" style="width:100%;">
      <option value="before"${unit === "before" ? " selected" : ""}>${esc(t("reimp.unitBefore"))}</option>
      <option value="file"${unit === "file" ? " selected" : ""}>${esc(t("reimp.unitFile", { f }))}</option></select>`);
  }
  if (p.different) html.push(`<div style="border:1px solid var(--lt-amber, #ffb454);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:7px;">
      <div>⚠ ${esc(t("reimp.different"))}</div><button type="button" class="btn-secondary" data-new="1">${esc(t("reimp.asNew"))}</button></div>`);
  // summary
  const row = (kind: "changed" | "new" | "gone", checked: boolean) => n[kind] ? `<label style="display:flex;gap:7px;align-items:center;"><input type="checkbox" data-kind="${kind}"${checked ? " checked" : ""}>${chip(COLOR[kind])}<span style="flex:1;">${t("reimp.k." + kind)}</span><b>${n[kind]}</b></label>` : "";
  const line = (col: string, key: string, v: number) => v ? `<div style="display:flex;gap:7px;align-items:center;padding-left:21px;">${chip(col)}<span style="flex:1;">${t(key)}</span><b>${v}</b></div>` : "";
  html.push(`<div style="display:flex;flex-direction:column;gap:4px;">${row("changed", c.changed)}${row("new", c.added)}${row("gone", c.gone)}
    ${line(COLOR.unclear, "reimp.k.unclear", n.unclear)}${line("#8a8a99", "reimp.k.edited", n.edited)}${line("transparent;border:1px solid #8a8a99;box-sizing:border-box", "reimp.k.same", n.same)}</div>`);
  if (!n.changed && !n.new && !n.gone && !n.unclear) html.push(note(esc(t("reimp.nothing"))));
  // placed parts
  if (p.clusters.length > 1) {
    html.push(`<details${p.clusters.length <= 6 ? " open" : ""}><summary style="cursor:pointer;">${t("reimp.places", { n: p.clusters.length })}</summary><div style="display:flex;flex-direction:column;gap:3px;max-height:130px;overflow:auto;margin-top:4px;">`
      + p.clusters.map((cl, i) => {
        const k = countKinds(p, x => x.cluster === i);
        const what = [k.changed ? t("reimp.n.changed", { n: k.changed }) : "", k.new ? t("reimp.n.new", { n: k.new }) : "", k.gone ? t("reimp.n.gone", { n: k.gone }) : "", k.unclear ? t("reimp.n.unclear", { n: k.unclear }) : ""].filter(Boolean).join(", ") || t("reimp.n.same");
        return `<div style="display:flex;gap:6px;align-items:center;"><input type="checkbox" data-cluster="${i}"${c.skip.has(i) ? "" : " checked"}>
          <button type="button" data-cshow="${i}" style="${linkCss}flex:1;text-decoration:underline;">${esc(placeName(sheets[cl.list]))} · ${esc(t("reimp.n.shapes", { n: cl.ids.length }))}</button><span style="color:var(--text-muted);">${esc(what)}</span></div>`;
      }).join("") + `</div></details>`);
  }
  // unclear ones: choose
  const unclear = p.items.filter(i => i.kind === "unclear" && on(i));
  if (unclear.length) {
    html.push(`<div style="border-left:3px solid ${COLOR.unclear};padding-left:8px;display:flex;flex-direction:column;gap:5px;max-height:200px;overflow:auto;">
      <div>${esc(t("reimp.unclearHint"))}</div>` + unclear.slice(0, MAX_ROWS).map(i => {
      const s = oldOf(i), v = c.unclear.get(i.id);
      return `<div><button type="button" data-show="${i.id}" style="${linkCss}text-decoration:underline;">${esc(nameOf(s))} ${esc(posOf(s))}</button>${i.conflict ? ` <span style="color:var(--text-muted);">${esc(t("reimp.conflict"))}</span>` : ""}
        <select data-item="${i.id}" style="width:100%;"><option value="">${esc(t("reimp.leave"))}</option>
        ${(i.cands ?? []).map(k => { const f = place(i.cluster, k); return `<option value="${k}"${v === k ? " selected" : ""}>${candNo.get(i.cluster + "|" + k)}: ${esc(nameOf(f))} ${esc(posOf(f))}</option>`; }).join("")}
        ${i.cluster >= 0 ? `<option value="gone"${v === "gone" ? " selected" : ""}>${esc(t("reimp.remove"))}</option>` : ""}</select></div>`;
    }).join("") + `</div>`);
  }
  if (p.openNew.length) html.push(`<label style="display:flex;gap:7px;align-items:center;"><input type="checkbox" data-open="1"${c.openNew ? " checked" : ""}><span>${esc(t("reimp.openNew", { n: p.openNew.length }))}</span></label>`);
  // list of changes
  const list = p.items.filter(i => (i.kind === "changed" || i.kind === "new" || i.kind === "gone" || i.kind === "edited") && on(i));
  if (list.length) {
    const layers = new Set([...p.fresh, ...list.map(oldOf)].map(s => cleanImp(s?.imp)?.l).filter(Boolean));
    const order = { changed: 0, new: 1, gone: 2, edited: 3 } as Record<string, number>;
    list.sort((a, b) => order[a.kind] - order[b.kind] || a.list - b.list);
    html.push(`<div style="max-height:180px;overflow:auto;display:flex;flex-direction:column;gap:2px;border:1px solid var(--border-color);border-radius:8px;padding:5px 7px;">`
      + list.slice(0, MAX_ROWS).map(i => {
        const s = i.oldId ? oldOf(i) : place(i.cluster, i.nu!);
        const col = i.kind === "edited" ? "#8a8a99" : COLOR[i.kind as keyof typeof COLOR];
        const layer = layers.size > 1 ? cleanImp(i.nu !== undefined ? p.fresh[i.nu].imp : s?.imp)?.l : "";
        const more = [whatOf(i), layer ? t("reimp.layer", { name: layer }) : "", bedCount() > 1 || sheets[i.list].side ? placeName(sheets[i.list]) : ""].filter(Boolean).join(" · ");
        const kindOn = i.kind === "changed" ? c.changed : i.kind === "new" ? c.added : c.gone;
        const box = i.kind === "edited" ? `<span style="width:13px;flex:none;"></span>` : `<input type="checkbox" data-one="${i.id}" style="flex:none;margin:2px 0 0;"${kindOn && !c.off.has(i.id) ? " checked" : ""}${kindOn ? "" : " disabled"}>`;
        return `<div style="display:flex;gap:6px;align-items:flex-start;">${box}<button type="button" data-show="${i.id}" style="${linkCss}display:flex;gap:7px;align-items:baseline;${hot === i.id ? "font-weight:700;" : ""}">${chip(col)}<span>${esc(nameOf(s, i))}${more ? `<span style="color:var(--text-muted);"> – ${esc(more)}</span>` : ""}</span></button></div>`;
      }).join("") + (list.length > MAX_ROWS ? note(esc(t("reimp.more", { n: list.length - MAX_ROWS }))) : "") + `</div>`);
  }
  // notes
  if (n.gone && !p.items.every(i => i.kind !== "gone" || p.clusters[i.cluster]?.exact)) html.push(warn(esc(t("reimp.goneOld"))));
  const moved = p.clusters.filter(x => x.movedInFile).length;
  if (moved) html.push(note(esc(t("reimp.movedInFile", { n: moved }))));
  if (p.clusters.some(x => x.ambiguous) && (n.unclear || p.openNew.length)) html.push(warn(esc(t("reimp.ambiguous"))));
  if (p.items.some(i => i.cluster < 0)) html.push(warn(esc(t("reimp.lost"))));
  const splits = new Set(p.clusters.map(x => sheets[x.list].bed).filter(b => { const sp = bedSplit(b); return sp && pieceBeds(sp.id).length > 0; }));
  if (splits.size && n.changed + n.new + n.gone) html.push(warn(esc(t("reimp.pieces", { beds: [...splits].map(b => bedName(b)).join(", ") }))));
  const ids = new Set(p.clusters.flatMap(x => x.ids));
  if (sheets.some(l => l.shapes.some(s => isLinked(s) && ids.has(s.link.of)))) html.push(note(esc(t("reimp.links"))));
  for (const w of inp.warnings) html.push(note(esc(`${t("log.note")} ${w}`)));
  const top = [...body.querySelectorAll<HTMLElement>("div")].map(d => d.scrollTop);
  body.innerHTML = html.join("");
  [...body.querySelectorAll<HTMLElement>("div")].forEach((d, i) => { if (top[i]) d.scrollTop = top[i]; });
  const work = todo();
  const ok = panel.el.querySelector<HTMLButtonElement>(".tp-ok")!;
  ok.disabled = p.different && !work;
  panel.info(work ? t("reimp.will", { n: work }) : t("reimp.willNone"));
}

const fmtNum = (v: number) => String(Math.round(v * 1000) / 1000);

/** How many shapes the button would change */
function todo(): number {
  if (!plan || !ch) return 0;
  const c = ch;
  return plan.items.filter(i => !c.skip.has(i.cluster) && !c.off.has(i.id) && i.cluster >= 0
    && ((i.kind === "changed" && c.changed) || (i.kind === "new" && c.added) || (i.kind === "gone" && c.gone) || (i.kind === "unclear" && c.unclear.has(i.id)))).length
    + (c.openNew ? plan.openNew.filter(o => !c.skip.has(o.cluster) && !plan!.items.some(i => i.cluster === o.cluster && c.unclear.get(i.id) === o.nu)).length : 0);
}

/** Button: carry out (false = window stays open) */
function apply(): boolean {
  if (!inp || !plan || !ch || !panel) return true;
  if (refreshIfStale()) { panel?.info(t("reimp.stale"), true); return false; }
  const { log, source } = inp;
  if (plan.different && !window.confirm(t("reimp.differentConfirm"))) return false;
  const lists = sheets.map(l => l.shapes);
  const r = applyPlan(lists, plan, ch, source);
  if (!r.changed.some(Boolean)) { log(t("reimp.doneNone")); return true; }
  const any = r.done.changed + r.done.added + r.done.removed > 0; // otherwise only the origin records are written
  const split = sheets.filter((l, k) => r.changed[k] && any && !!bedSplit(l.bed) && pieceBeds(bedSplit(l.bed)!.id).length > 0).map(l => bedName(l.bed));
  replaceSheets(sheets, r.lists, r.changed);
  const here = new Set(r.touched);
  app().selectedShapeIds = app().shapes.filter((s: any) => here.has(s.id)).map((s: any) => s.id);
  updateDimensionInputs(null);
  log(!any ? t("reimp.doneNone") : t("reimp.done", { name: inp.name, c: r.done.changed, a: r.done.added, g: r.done.removed }));
  if (split.length) log(t("reimp.pieces", { beds: [...new Set(split)].join(", ") }));
  return true;
}

// =====================================================================
// CANVAS
// =====================================================================

/** Called after the normal drawing (main.ts); without an open window nothing happens */
export function drawReimport(ctx: CanvasRenderingContext2D) {
  if (!panel || !plan || !ch) return;
  const c = ch;
  const li = sheets.findIndex(l => l.bed === activeBed() && !l.hidden);
  if (li < 0) return;
  const now = new Map<string, any>(app().shapes.map((s: any) => [s.id, s]));
  const trace = (s: any) => {
    for (const p of shapeToPaths(s)) {
      if (p.pts.length < 2) continue;
      ctx.beginPath();
      p.pts.forEach((q, i) => { const k = toScreen(q.x, q.y); if (i) ctx.lineTo(k.x, k.y); else ctx.moveTo(k.x, k.y); });
      if (p.closed) ctx.closePath();
      ctx.stroke();
    }
  };
  ctx.save();
  ctx.lineJoin = "round";
  const pen = (col: string, w: number, dash: number[] = []) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash); };
  for (const i of plan.items) {
    if (i.list !== li || c.skip.has(i.cluster) || c.off.has(i.id)) continue;
    const s = i.oldId ? now.get(i.oldId) : null, thick = hot === i.id ? 4 : 2.4;
    if (i.kind === "changed" && c.changed) {
      if (i.depthOnly) { if (s) { pen(COLOR.changed, thick); trace(s); } continue; }
      if (s) { pen(COLOR.changed, 1.3, [5, 4]); trace(s); }
      pen(COLOR.changed, thick); trace(place(i.cluster, i.nu!));
    } else if (i.kind === "new" && c.added) { pen(COLOR.new, thick); trace(place(i.cluster, i.nu!)); }
    else if (i.kind === "gone" && s) {
      pen(COLOR.gone, thick, c.gone ? [] : [3, 4]); trace(s);
      if (c.gone) cross(ctx, s);
    } else if (i.kind === "unclear" && s) {
      pen(COLOR.unclear, thick); trace(s);
      const v = c.unclear.get(i.id);
      for (const k of i.cands ?? []) { pen(COLOR.unclear, v === k ? 3 : 1.4, v === k ? [] : [4, 4]); trace(place(i.cluster, k)); }
    }
  }
  ctx.setLineDash([]);
  ctx.font = "600 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [k, no] of candNo) {
    const [cl, nu] = k.split("|").map(Number);
    if (plan.clusters[cl]?.list !== li || c.skip.has(cl)) continue;
    const b = groupBounds([place(cl, nu)]);
    if (!b) continue;
    const q = toScreen((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    ctx.fillStyle = COLOR.unclear;
    ctx.beginPath(); ctx.arc(q.x, q.y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#1b1030";
    ctx.fillText(String(no), q.x, q.y + 0.5);
  }
  ctx.restore();
}

/** Red cross over a shape that goes */
function cross(ctx: CanvasRenderingContext2D, s: any) {
  const b = shapeBounds(s);
  if (!b) return;
  const a = toScreen(b.minX, b.minY), z = toScreen(b.maxX, b.maxY);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y); ctx.lineTo(z.x, z.y);
  ctx.moveTo(a.x, z.y); ctx.lineTo(z.x, a.y);
  ctx.globalAlpha = 0.55;
  ctx.stroke();
  ctx.globalAlpha = 1;
}
