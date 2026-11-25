/**
 * ZIER-FRÄSEN: Flächenmuster, erhabene Schrift mit Grat, Profilleiste entlang einer Bahn. Gerechnet wird in src/deco/.
 * Muster und Grat fügen normale Formen ein bzw. stellen sie ein; die Profilleiste baut einen Auftrag. Gestartet wird nichts.
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { t, ascii, tMm } from "../i18n/i18n";
import { state } from "../main";
import { isMill, isPlasma } from "../machineMode";
import { getTools, getTool, MillingTool, DEFAULT_PLUNGE, cutDiameter, stepDia, isBallTip } from "../toolLibrary";
import { createCircle, createPolyline, isClosedShape, makeRectPoints, MM_TO_PIXEL, newId, shapeToPaths } from "../shapeTransform";
import { updateDimensionInputs } from "../uiInputs";
import { checkpoint } from "../editor/history";
import { spindleCode } from "../spindleDir";
import { loadGcodeFromText } from "../machineStream";
import { withPost, postedText, postFileName, postExtensions } from "../post/postExport";
import { profile } from "../view3d/carveSim";
import { cutWidth } from "../pcb/field";
import { makeTexture, TEXTURE_KINDS, TextureKind, Texture } from "../deco/texture";
import { inradius, nesting, ridgeDepth, ridgeHeight } from "../deco/ridge";
import { leftover, MOULD_KINDS, MouldKind, mouldLines, MouldOpts, profileZ } from "../deco/moulding";

const SAFE_Z = 5.0;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
type Pt = { x: number; y: number };

interface Sel { shape: any; pts: Pt[]; closed: boolean }
/** Ausgewählte Formen als Linien in mm */
function selection(): Sel[] {
  const ids = new Set(state.selectedShapeIds), out: Sel[] = [];
  for (const s of state.shapes as any[]) {
    if (!ids.has(s.id) || s.type === "image" || s.keepOut) continue;
    for (const p of shapeToPaths(s)) if (p.pts.length > 1) out.push({ shape: s, pts: p.pts.map(q => ({ x: q.x / MM_TO_PIXEL, y: q.y / MM_TO_PIXEL })), closed: p.closed && isClosedShape(s) });
  }
  return out;
}

const num = (id: string, label: string, unit = "mm", step = "0.1", tipKey = "") =>
  `<div class="dlg-row" id="${id}-row"${tipKey ? ` data-tip="${esc(t(tipKey))}"` : ""}><span>${esc(t(label))}</span><span class="dlg-num"><input id="${id}" type="number" step="${step}" class="prop-input"><em>${unit}</em></span></div>`;
const sel = (id: string, label: string, opts: [string, string][]) =>
  `<div class="dlg-row" id="${id}-row"><span>${esc(t(label))}</span><select id="${id}" class="prop-input" style="width:170px;">${opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}</select></div>`;
const toolOpts = (l: MillingTool[]): [string, string][] => l.map(x => [x.id, `${x.name} · Ø${x.diameter}`]);

interface Dlg<O> { ov: HTMLElement; $: <E extends HTMLElement = HTMLInputElement>(id: string) => E; close(): void; fill(): void; o: O }
/** Rahmen: Felder links, Zeichnung rechts; Werte werden je Dialog gemerkt */
function dialog<O extends Record<string, any>>(key: string, title: string, icon: string, form: string, buttons: string, o: O, fields: [string, keyof O, number, number][], selects: [string, keyof O][], checks: [string, keyof O][], changed: () => void): Dlg<O> {
  document.getElementById("deco-overlay")?.remove();
  try { const s = JSON.parse(localStorage.getItem(key) || "{}"); for (const k of Object.keys(o) as (keyof O)[]) if (typeof s[k] === typeof o[k] && (typeof s[k] !== "number" || Number.isFinite(s[k]))) o[k] = s[k]; } catch { /* Standard */ }
  const ov = document.createElement("div");
  ov.id = "deco-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(940px, calc(100vw - 32px));">
      <h3>${icon} ${esc(t(title))}</h3>
      <div class="c3d-grid"><div class="c3d-form">${form}<div class="dlg-hint" id="deco-info"></div><div class="dlg-hint" id="deco-warn" style="color:var(--lt-amber, #ffb454);white-space:pre-line;"></div></div>
        <canvas id="deco-cv" width="900" height="640" style="width:100%;border-radius:6px;display:block;background:#16161c;"></canvas></div>
      <div class="dlg-buttons">${buttons}<button id="deco-close" class="btn-secondary" style="margin-left:auto;">${esc(t("dlg.cancel"))}</button></div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const fill = () => {
    for (const [id, k] of fields) if (document.activeElement !== $(id)) $(id).value = String(o[k]);
    for (const [id, k] of selects) $<HTMLSelectElement>(id).value = String(o[k]);
    for (const [id, k] of checks) $(id).checked = !!o[k];
  };
  const keep = () => { try { localStorage.setItem(key, JSON.stringify(o)); } catch { /* egal */ } };
  let timer = 0;
  const later = () => { keep(); clearTimeout(timer); timer = window.setTimeout(() => { if (ov.isConnected) changed(); }, 120); };
  for (const [id, k, lo, hi] of fields) {
    $(id).addEventListener("input", () => { const v = parseFloat($(id).value); if (!Number.isFinite(v) || v < lo || v > hi) return; (o as any)[k] = v; later(); });
    $(id).addEventListener("change", () => { $(id).blur(); fill(); });
  }
  for (const [id, k] of selects) $<HTMLSelectElement>(id).addEventListener("change", () => { (o as any)[k] = $<HTMLSelectElement>(id).value; later(); });
  for (const [id, k] of checks) $(id).addEventListener("change", () => { (o as any)[k] = $(id).checked; later(); });
  const close = () => { clearTimeout(timer); ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  $<HTMLButtonElement>("deco-close").onclick = close;
  return { ov, $, close, fill, o };
}

/** Zeichnung einpassen: liefert Umrechnung mm → Canvas */
function fitter(cv: HTMLCanvasElement, pts: Pt[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const k = Math.min((cv.width - 40) / Math.max(1e-6, x1 - x0), (cv.height - 40) / Math.max(1e-6, y1 - y0));
  return { k, X: (x: number) => cv.width / 2 + (x - (x0 + x1) / 2) * k, Y: (y: number) => cv.height / 2 - (y - (y0 + y1) / 2) * k };
}
const path = (ctx: CanvasRenderingContext2D, f: ReturnType<typeof fitter>, pts: Pt[], closed: boolean) => { pts.forEach((p, i) => (i ? ctx.lineTo(f.X(p.x), f.Y(p.y)) : ctx.moveTo(f.X(p.x), f.Y(p.y)))); if (closed) ctx.closePath(); };

function insert(shapes: any[], redraw: () => void) {
  state.shapes = [...state.shapes, ...shapes];
  state.selectedShapeIds = shapes.map(s => s.id);
  updateDimensionInputs(null);
  checkpoint();
  redraw();
}

// =====================================================================
// FLÄCHENMUSTER
// =====================================================================
export function openTexture(log: (s: string) => void, redraw: () => void) {
  const loops = selection().filter(s => s.closed).map(s => s.pts);
  if (!loops.length) { log(t("deco.needClosed")); return; }
  const mill = isMill();
  if (isPlasma()) { log(t("deco.notPlasma")); return; }
  const tools = getTools().filter(x => ["vbit", "ball", "endmill", "bullnose", "taper", "chamfer"].includes(x.type));
  if (mill && !tools.length) { log(t("face.noTool")); return; }
  const o = { kind: "lines" as string, spacing: 4, angle: 45, inset: 2, depth: 1, tool: (tools.find(x => x.type === "vbit") || tools[0])?.id ?? "", soft: false, seed: 1 };
  let tex: Texture = { lines: [], dots: [], tooMany: false };
  const isDots = () => o.kind === "dots" || o.kind === "hammer";
  const d = dialog("cnc_craft_texture", "deco.texture", "🪵", `
    ${sel("tx-kind", "deco.pattern", TEXTURE_KINDS.map(k => [k, t("deco.tx." + k)]))}
    ${num("tx-spacing", "deco.spacing")}${num("tx-angle", "deco.angle", "°", "5")}${num("tx-inset", "deco.inset", "mm", "0.5", "deco.insetTip")}
    ${mill ? sel("tx-tool", "pcb.tool", toolOpts(tools)) + num("tx-depth", "deco.depth") + `<label class="eng-ck" id="tx-soft-row" data-tip="${esc(t("deco.softTip"))}"><input type="checkbox" id="tx-soft"> ${esc(t("deco.soft"))}</label>` : ""}
    <button id="tx-seed" class="btn-secondary btn-compact">🎲 ${esc(t("deco.seed"))}</button>`,
    `<button id="tx-ok" class="btn-primary">${esc(t("deco.insert"))}</button>`, o,
    [["tx-spacing", "spacing", 0.2, 200], ["tx-angle", "angle", -360, 360], ["tx-inset", "inset", 0, 100], ...(mill ? [["tx-depth", "depth", 0.02, 30] as [string, "depth", number, number]] : [])],
    [["tx-kind", "kind"], ...(mill ? [["tx-tool", "tool"] as [string, "tool"]] : [])], mill ? [["tx-soft", "soft"]] : [], () => refresh());
  if (!TEXTURE_KINDS.includes(o.kind as TextureKind)) o.kind = "lines";
  if (mill && !tools.some(x => x.id === o.tool)) o.tool = tools[0].id;
  const tool = () => getTool(o.tool);
  const width = () => { const x = tool(); return mill && x ? (x.type === "ball" ? 2 * Math.sqrt(Math.max(0, o.depth * (x.diameter - Math.min(o.depth, x.diameter / 2)))) : x.type === "taper" ? Math.max(0.1, x.tipDia) : cutWidth(x, o.depth)) : 0.3; };
  const refresh = () => {
    tex = makeTexture(loops, { kind: o.kind as TextureKind, spacing: o.spacing, angle: o.angle, inset: o.inset, seed: o.seed });
    d.$<HTMLElement>("tx-seed").style.display = o.kind === "hammer" ? "" : "none";
    const soft = d.ov.querySelector("#tx-soft-row") as HTMLElement | null;
    if (soft) soft.style.display = isDots() || o.kind === "rings" ? "none" : "";
    const cv = d.$<HTMLCanvasElement>("deco-cv"), ctx = cv.getContext("2d")!, f = fitter(cv, loops.flat()), w = width();
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.beginPath(); for (const l of loops) path(ctx, f, l, true); ctx.fillStyle = "#e6d2b0"; ctx.fill("evenodd");
    ctx.lineCap = ctx.lineJoin = "round"; ctx.strokeStyle = ctx.fillStyle = "#4a3320"; ctx.lineWidth = Math.max(1, w * f.k);
    ctx.beginPath(); for (const l of tex.lines) path(ctx, f, l.pts, l.closed); ctx.stroke();
    for (const p of tex.dots) { ctx.beginPath(); ctx.arc(f.X(p.x), f.Y(p.y), Math.max(1.5, w / 2 * f.k), 0, 7); ctx.fill(); }
    const warn: string[] = [];
    if (tex.tooMany) warn.push(t("deco.tooMany"));
    if (mill && o.inset < w / 2 - 1e-6) warn.push(t("deco.warnInset", { w: (w / 2).toFixed(2) }));
    if (mill && w > o.spacing * 0.95) warn.push(t("deco.warnOverlap", { w: w.toFixed(2) }));
    d.$<HTMLElement>("deco-info").textContent = t("deco.txInfo", { n: tex.lines.length + tex.dots.length });
    d.$<HTMLElement>("deco-warn").textContent = warn.map(x => "⚠ " + x).join("\n");
    d.$<HTMLButtonElement>("tx-ok").disabled = !(tex.lines.length + tex.dots.length) || tex.tooMany;
  };
  d.$<HTMLButtonElement>("tx-seed").onclick = () => { o.seed = 1 + Math.floor(Math.random() * 1e6); refresh(); };
  d.$<HTMLButtonElement>("tx-ok").onclick = () => {
    refresh();
    if (tex.tooMany) return;
    const group = "tex-" + newId(), tl = tool(), px = (p: Pt) => ({ x: p.x * MM_TO_PIXEL, y: p.y * MM_TO_PIXEL });
    const shapes = [
      ...tex.lines.map(l => createPolyline(l.pts.map(px), l.closed, "on-line")),
      ...tex.dots.map(p => { const q = px(p); return createCircle(q.x, q.y, (mill && tl ? tl.diameter / 2 : o.spacing * 0.15) * MM_TO_PIXEL, mill ? "drill" : "on-line"); }),
    ];
    for (const s of shapes) {
      s.groupId = group;
      if (!mill) continue;
      s.millingDepth = -o.depth;
      if (tl) s.toolId = tl.id;
      if (o.soft && s.type === "polyline" && !s.closed) { let L = 0; const p = s.points; for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y); L /= MM_TO_PIXEL; s.flute = true; s.fluteIn = s.fluteOut = +Math.min(L / 2, o.spacing * 2).toFixed(2); s.fluteStart = s.fluteEnd = 0; }
    }
    insert(shapes, redraw);
    log(t("deco.txDone", { n: shapes.length }));
    d.close();
  };
  d.fill(); refresh();
}

// =====================================================================
// ERHABENE SCHRIFT MIT GRAT
// =====================================================================
export function openRidge(log: (s: string) => void, redraw: () => void) {
  if (!isMill()) { log(t("deco.onlyMill")); return; }
  const items = selection().filter(s => s.closed);
  if (!items.length) { log(t("deco.needClosed")); return; }
  const vs = getTools().filter(x => x.type === "vbit" && x.angle > 0), es = getTools().filter(x => x.type === "endmill" || x.type === "bullnose");
  if (!vs.length || !es.length) { log(t("deco.ridgeTools")); return; }
  const loops = items.map(s => s.pts), nest = nesting(loops), inr = inradius(loops);
  const o = { v: vs[0].id, e: es[0].id, max: 8, ground: true, margin: 8, radius: 5 };
  const d = dialog("cnc_craft_ridge", "deco.ridge", "🏔", `
    <div class="dlg-hint">${esc(t("deco.ridgeHint"))}</div>
    ${sel("rg-v", "deco.vbit", toolOpts(vs))}${num("rg-max", "deco.maxDepth")}
    <label class="eng-ck"><input type="checkbox" id="rg-ground"> ${esc(t("deco.ground"))}</label>
    ${sel("rg-e", "deco.groundTool", toolOpts(es))}${num("rg-margin", "deco.margin", "mm", "1")}${num("rg-radius", "deco.corner", "mm", "1")}`,
    `<button id="rg-ok" class="btn-primary">${esc(t("deco.apply"))}</button>`, o,
    [["rg-max", "max", 0.2, 60], ["rg-margin", "margin", 0, 200], ["rg-radius", "radius", 0, 100]], [["rg-v", "v"], ["rg-e", "e"]], [["rg-ground", "ground"]], () => refresh());
  if (!vs.some(x => x.id === o.v)) o.v = vs[0].id;
  if (!es.some(x => x.id === o.e)) o.e = es[0].id;
  const plan = () => { const v = getTool(o.v)!; return ridgeDepth(inr, { angle: v.angle, tipDia: v.tipDia, toolDia: v.diameter, maxDepth: o.max }); };
  const refresh = () => {
    const v = getTool(o.v)!, e = getTool(o.e)!, p = plan();
    for (const id of ["rg-e", "rg-margin", "rg-radius"]) d.$<HTMLElement>(id + "-row").style.display = o.ground ? "" : "none";
    const cv = d.$<HTMLCanvasElement>("deco-cv"), ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    // oben: Umrisse; unten: Schnitt durch die dickste Stelle
    const half = { width: cv.width, height: cv.height * 0.6 } as HTMLCanvasElement, f = fitter(half, loops.flat());
    ctx.beginPath(); for (const l of loops) path(ctx, f, l, true); ctx.fillStyle = "#c9a36a"; ctx.fill("evenodd"); ctx.lineWidth = 2; ctx.strokeStyle = "#ffd23c"; ctx.stroke();
    const span = inr + Math.max(2, inr * 0.6), k = Math.min((cv.width - 80) / (2 * span), cv.height * 0.3 / Math.max(1, p.depth * 1.3)), x0 = cv.width / 2, yTop = cv.height * 0.68, Z = (z: number) => yTop - z * k;
    ctx.beginPath(); ctx.moveTo(x0 - span * k, Z(-p.depth));
    for (let i = 0; i <= 200; i++) { const x = -span + 2 * span * i / 200, dd = inr - Math.abs(x); ctx.lineTo(x0 + x * k, Z(dd <= 0 ? -p.depth : ridgeHeight(dd, p.depth, v))); }
    ctx.lineTo(x0 + span * k, cv.height - 10); ctx.lineTo(x0 - span * k, cv.height - 10); ctx.closePath(); ctx.fillStyle = "#8a6238"; ctx.fill();
    const warn: string[] = [];
    if (p.flat > 0.05) warn.push(t(p.coneLimit ? "deco.warnCone" : "deco.warnFlat", { f: p.flat.toFixed(2), d: p.full.toFixed(2) }));
    if (!o.ground) warn.push(t("deco.warnNoGround"));
    else if (o.margin < e.diameter) warn.push(t("deco.warnMargin", { d: e.diameter }));
    d.$<HTMLElement>("deco-info").textContent = t("deco.ridgeInfo", { d: p.depth.toFixed(2), w: (2 * inr).toFixed(2) });
    d.$<HTMLElement>("deco-warn").textContent = warn.map(x => "⚠ " + x).join("\n");
    d.$<HTMLButtonElement>("rg-ok").disabled = !(p.depth > 0.05);
  };
  d.$<HTMLButtonElement>("rg-ok").onclick = () => {
    const p = plan(), z = -+p.depth.toFixed(3);
    items.forEach((it, i) => {
      const s = it.shape;
      s.millingMode = "on-line"; s.millingDepth = z; s.toolId = o.v;
      delete s.flute; delete s.tro;
      // Loch im Buchstaben (o, e, a …): auch dort muss der Grund geräumt werden
      const rest = (Array.isArray(s.ops) ? s.ops : []).filter((x: any) => x?.ridge !== true);
      if (o.ground && nest[i] % 2 === 1) s.ops = [...rest, { kind: "pocket", toolId: o.e, depth: z, ridge: true }]; else if (rest.length) s.ops = rest; else delete s.ops;
    });
    const added: any[] = [];
    if (o.ground) {
      const all = loops.flat(), x0 = Math.min(...all.map(q => q.x)) - o.margin, y0 = Math.min(...all.map(q => q.y)) - o.margin, x1 = Math.max(...all.map(q => q.x)) + o.margin, y1 = Math.max(...all.map(q => q.y)) + o.margin;
      const bg = createPolyline(makeRectPoints(x0 * MM_TO_PIXEL, y0 * MM_TO_PIXEL, x1 * MM_TO_PIXEL, y1 * MM_TO_PIXEL, Math.min(o.radius, (x1 - x0) / 2, (y1 - y0) / 2) * MM_TO_PIXEL), true, "pocket");
      bg.millingDepth = z; bg.toolId = o.e;
      added.push(bg);
    }
    state.shapes = [...added, ...state.shapes];
    state.selectedShapeIds = [...added.map(s => s.id), ...new Set(items.map(i => i.shape.id))];
    updateDimensionInputs(null); checkpoint(); redraw();
    log(t("deco.ridgeDone", { d: p.depth.toFixed(2) }));
    d.close();
  };
  d.fill(); refresh();
}

// =====================================================================
// PROFILLEISTE
// =====================================================================
export function openMoulding(log: (s: string) => void) {
  if (!isMill()) { log(t("deco.onlyMill")); return; }
  const paths = selection().map(s => ({ pts: s.pts, closed: s.closed }));
  if (!paths.length) { log(t("deco.needLine")); return; }
  const tools = getTools().filter(x => ["ball", "taper", "endmill", "bullnose"].includes(x.type));
  if (!tools.length) { log(t("face.noTool")); return; }
  const anyOpen = paths.some(p => !p.closed);
  const o = { kind: "ogee" as string, side: "1", width: 15, height: 8, tool: (tools.find(x => x.type === "ball") || tools[0]).id, over: 0, rough: 0, down: 0, allow: 0.3 };
  const d = dialog("cnc_craft_moulding", "deco.moulding", "〰", `
    ${sel("md-kind", "deco.section", MOULD_KINDS.map(k => [k, t("deco.md." + k)]))}
    ${sel("md-side", "deco.side", anyOpen ? [["1", t("deco.left")], ["-1", t("deco.right")]] : [["1", t("deco.outside")], ["-1", t("deco.inside")]])}
    ${num("md-width", "deco.width")}${num("md-height", "deco.depth")}
    ${sel("md-tool", "pcb.tool", toolOpts(tools))}
    ${num("md-down", "c3d.stepDown")}${num("md-rough", "deco.roughOver", "mm", "0.1")}${num("md-over", "deco.finishOver", "mm", "0.05", "deco.finishOverTip")}${num("md-allow", "deco.allow", "mm", "0.1")}
    <div class="dlg-hint">${esc(t("deco.mouldHint"))}</div>`,
    `<button id="md-load" class="btn-primary">${esc(t("c3d.load"))}</button><button id="md-save" class="btn-secondary">💾 ${esc(t("c3d.save"))}</button>`, o,
    [["md-width", "width", 0.5, 200], ["md-height", "height", 0.2, 100], ["md-over", "over", 0.02, 20], ["md-rough", "rough", 0.05, 50], ["md-down", "down", 0.05, 50], ["md-allow", "allow", 0, 5]],
    [["md-kind", "kind"], ["md-side", "side"], ["md-tool", "tool"]], [], () => refresh());
  if (!MOULD_KINDS.includes(o.kind as MouldKind)) o.kind = "ogee";
  if (o.side !== "-1") o.side = "1";
  if (!tools.some(x => x.id === o.tool)) o.tool = tools[0].id;
  const tool = () => getTool(o.tool)!;
  const defaults = () => { const x = tool(); o.over = +(stepDia(x) * (isBallTip(x) ? 0.1 : 0.3)).toFixed(2); o.rough = +(stepDia(x) * 0.4).toFixed(2); o.down = +(x.stepZ || 1).toFixed(2); };
  if (!(o.over > 0) || !(o.rough > 0) || !(o.down > 0)) defaults();
  d.$<HTMLSelectElement>("md-tool").addEventListener("change", () => { defaults(); d.fill(); });
  const opts = (): MouldOpts => { const x = tool(); return { kind: o.kind as MouldKind, width: o.width, height: o.height, R: cutDiameter(x) / 2, shape: profile(x), roughOver: o.rough, finishOver: o.over, stepDown: o.down, allowance: o.allow }; };
  const build = () => {
    const x = tool(), feed = x.feedrate || 800, plunge = x.plungeFeed ?? DEFAULT_PLUNGE, rpm = Math.round(x.rpm || 12000);
    const r = mouldLines({ paths, side: o.side === "-1" ? -1 : 1, opts: opts(), feed, plunge, safeZ: SAFE_Z });
    const c = (k: string, v?: Record<string, string | number>) => `(${ascii(tMm(k, v))})`;
    const gcode = [c("deco.gcMould", { w: o.width, h: o.height }), c("gc.tool", { name: x.name, d: x.diameter.toFixed(1) }), `G21 ${c("gc.unitMm")}`, `G90 ${c("gc.absolute")}`, "G17", `G0 Z${SAFE_Z.toFixed(2)} ${c("gc.safeZ")}`,
      `${spindleCode("M3")} S${rpm} ${c("gc.spindleOn", { rpm })}`, `G4 P3 ${c("gc.spinUp")}`, ...r.lines, `M5 ${c("gc.spindleOff")}`, `G0 X0 Y0 ${c("gc.park")}`, `M30 ${c("gc.end")}`].join("\n") + "\n";
    return { gcode, ...r, minutes: r.cut / feed + r.air / 3000 };
  };
  let cuts = 0;
  const refresh = () => {
    const op = opts(), cv = d.$<HTMLCanvasElement>("deco-cv"), ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const u0 = -op.R - 4, u1 = o.width + op.R + 6, k = Math.min((cv.width - 60) / (u1 - u0), (cv.height - 120) / (o.height + 6)), X = (u: number) => 30 + (u - u0) * k, Z = (z: number) => 60 - z * k, left = leftover(op);
    const area = (f: (u: number) => number, color: string) => { ctx.beginPath(); ctx.moveTo(X(u0), Z(f(u0))); for (let i = 0; i <= 500; i++) { const u = u0 + (u1 - u0) * i / 500; ctx.lineTo(X(u), Z(f(u))); } ctx.lineTo(X(u1), Z(-o.height - 5)); ctx.lineTo(X(u0), Z(-o.height - 5)); ctx.closePath(); ctx.fillStyle = color; ctx.fill(); };
    area(left, "#d0643c");                                              // bleibt stehen (der Fräser kommt nicht hin)
    area(u => Math.min(left(u), profileZ(op.kind, u, o.width, o.height)), "#c9a36a"); // gewünschtes Profil
    ctx.setLineDash([6, 5]); ctx.strokeStyle = "#ffd23c"; ctx.beginPath(); ctx.moveTo(X(0), Z(3)); ctx.lineTo(X(0), Z(-o.height - 5)); ctx.stroke(); ctx.setLineDash([]);
    const b = build(), warn: string[] = [];
    cuts = b.lines.length;
    if (tool().fluteLen > 0 && o.height > tool().fluteLen) warn.push(t("deco.warnFlute", { l: tool().fluteLen }));
    if (b.lost) warn.push(t("deco.warnLost", { n: b.lost }));
    if (b.lines.length > 500_000) warn.push(t("deco.tooMany"));
    d.$<HTMLElement>("deco-info").textContent = b.cut > 0 ? t("deco.mouldInfo", { l: (b.cut / 1000).toFixed(1), m: Math.max(1, Math.round(b.minutes)) }) : t("deco.empty");
    d.$<HTMLElement>("deco-warn").textContent = warn.map(x => "⚠ " + x).join("\n");
    for (const id of ["md-load", "md-save"]) d.$<HTMLButtonElement>(id).disabled = !(b.cut > 0) || b.lines.length > 500_000;
  };
  d.$<HTMLButtonElement>("md-load").onclick = () => { if (cuts && loadGcodeFromText(build().gcode, t("deco.moulding"), log)) { log(t("deco.mouldLoaded")); d.close(); } };
  d.$<HTMLButtonElement>("md-save").onclick = async () => {
    const text = postedText(withPost(() => build().gcode), log);
    if (text === null) return;
    try {
      const p = await save({ title: t("rp.saveGcode"), defaultPath: postFileName("moulding.gcode"), filters: [{ name: t("stream.dlgFilter"), extensions: postExtensions() }] });
      if (p) { await writeFile(p, new TextEncoder().encode(text)); log(t("gcw.saved", { p })); }
    } catch (err) { log(t("gcw.saveError", { e: String(err) })); }
  };
  d.fill(); refresh();
}
