/**
 * PLATINEN-FENSTER (Fräse): Gerber- und Bohrdateien (einzeln oder als ZIP) → Isolationsbahnen, Löcher, Kontur als Formen.
 * Gerechnet wird in src/pcb/ (Isolation im Hintergrund-Thread). Das Fenster fügt nur Formen ein; gestartet wird nichts.
 */
import { t } from "../i18n/i18n";
import { state } from "../main";
import { addTool, getTools, MillingTool } from "../toolLibrary";
import { bedSizeMm } from "../editor/editorState";
import { checkpoint } from "../editor/history";
import { createCircle, createPolyline, newId, MM_TO_PIXEL } from "../shapeTransform";
import { updateDimensionInputs } from "../uiInputs";
import { inflateLimited } from "../importers/inflateLimit";
import { readZipDirectory, readZipEntry } from "../importers/meshImport";
import { decodeText } from "../importers/common";
import { boardOf, buildDescs, holeMode, holesOff, PcbFile, pickHoleTool, placer, readPcbFile, Role, Board } from "../pcb/pcbJob";
import { bySize } from "../pcb/excellon";
import { gerberBox } from "../pcb/gerber";
import { cutWidth, isolate, IsoJob, IsoResult } from "../pcb/field";

const KEY = "cnc_craft_pcb";
const ZIP_MAX = 32 * 1024 * 1024, TEXT_MAX = 60 * 1024 * 1024;
const ROLES: Role[] = ["top", "bottom", "outline", "drill", "ignore"];

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Gehört die Datei ins Platinen-Fenster? (Endung; bei mehrdeutigen Endungen der Inhalt) */
export const PCB_EXTENSIONS = ["gbr", "ger", "gtl", "gbl", "gko", "gm1", "gm3", "gml", "cmp", "sol", "pho", "drl", "xln", "exc", "drd", "zip"];

async function filesFrom(name: string, bytes: Uint8Array): Promise<PcbFile[]> {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const out: PcbFile[] = [];
    let total = 0;
    for (const e of readZipDirectory(bytes).slice(0, 300)) {
      if (e.name.endsWith("/") || /__MACOSX|\.(pdf|png|jpe?g|csv|step|stp|wrl|gbrjob)$/i.test(e.name)) continue;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
      let data: Uint8Array;
      if (e.method === 8) data = await inflateLimited(bytes.subarray(start, start + e.compSize), "deflate-raw", ZIP_MAX).catch(err => { if (String(err).includes("too-big") || e.size > ZIP_MAX) throw err; return readZipEntry(bytes, e); });
      else data = await readZipEntry(bytes, e);
      total += data.length;
      if (total > TEXT_MAX) throw new Error("too-big");
      const f = readPcbFile(e.name, decodeText(data));
      if (f) out.push(f);
    }
    return out;
  }
  if (bytes.length > TEXT_MAX) throw new Error("too-big");
  const f = readPcbFile(name, decodeText(bytes));
  return f ? [f] : [];
}

/** Offenes Fenster: weitere Dateien kommen dazu */
let current: ((files: PcbFile[]) => void) | null = null;

export async function openPcb(name: string, bytes: Uint8Array, log: (s: string) => void, redraw: () => void): Promise<void> {
  const files = await filesFrom(name, bytes);
  if (!files.length) { log(t("pcb.notPcb", { name })); return; }
  if (current && document.getElementById("pcb-overlay")) { current(files); return; }
  show(files, log, redraw);
}

function show(first: PcbFile[], log: (s: string) => void, redraw: () => void) {
  document.getElementById("pcb-overlay")?.remove();
  const files = first.slice();
  const vbits = () => getTools().filter(x => x.type === "vbit" || x.type === "chamfer" || x.type === "endmill");
  const mills = () => getTools().filter(x => x.type === "endmill" || x.type === "bullnose");
  const o = { side: "top" as "top" | "bottom", x: 10, y: 10, thick: 1.6, isoOn: true, isoTool: "", isoDepth: 0.1, passes: 2, overlap: 40, drillOn: true, drillMore: 0.3, outOn: true, outTool: "", outMore: 0.2, tabs: true };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    for (const k of Object.keys(o) as (keyof typeof o)[]) if (typeof s[k] === typeof o[k] && (typeof s[k] !== "number" || Number.isFinite(s[k]))) (o as any)[k] = s[k];
  } catch { /* Standard */ }
  if (o.side !== "bottom") o.side = "top";
  const pick = (id: string, list: MillingTool[], want: (x: MillingTool) => boolean) => (list.some(x => x.id === id) ? id : (list.find(want) || list[0])?.id || "");
  // V-Stichel, sonst der kleinste Fräser
  const finest = Math.min(...vbits().map(x => x.diameter));
  o.isoTool = pick(o.isoTool, vbits(), vbits().some(x => x.type === "vbit") ? x => x.type === "vbit" : x => x.diameter === finest);
  o.outTool = pick(o.outTool, mills(), x => x.diameter >= 1 && x.diameter <= 2.5);
  const tool = (id: string) => getTools().find(x => x.id === id) || null;
  /** Loch-Ø → Werkzeug-ID, "new" = Bohrer anlegen, "" = auslassen */
  const holeTool = new Map<number, string>();
  const key = (d: number) => Math.round(d * 100) / 100;

  const num = (id: string, label: string, unit = "mm", step = "0.1", tipKey = "") =>
    `<div class="dlg-row"${tipKey ? ` data-tip="${esc(t(tipKey))}"` : ""}><span>${esc(t(label))}</span><span class="dlg-num"><input id="${id}" type="number" step="${step}" class="prop-input"><em>${unit}</em></span></div>`;
  const opts = (list: MillingTool[], sel: string) => list.map(x => `<option value="${esc(x.id)}"${x.id === sel ? " selected" : ""}>${esc(x.name)} · Ø${x.diameter}</option>`).join("");
  const ov = document.createElement("div");
  ov.id = "pcb-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(1080px, calc(100vw - 32px));">
      <h3>🔌 ${esc(t("pcb.title"))}</h3>
      <div class="c3d-grid">
        <div class="c3d-form">
          <div class="c3d-sec">${esc(t("pcb.files"))}</div>
          <div id="pcb-files"></div>
          <div class="dlg-hint">${esc(t("pcb.filesHint"))}</div>
          <div class="dlg-row"><span>${esc(t("pcb.side"))}</span><select id="pcb-side" class="prop-input" style="width:auto;">
            <option value="top">${esc(t("pcb.side.top"))}</option><option value="bottom">${esc(t("pcb.side.bottom"))}</option></select></div>
          ${num("pcb-x", "c3d.posX")}${num("pcb-y", "c3d.posY")}${num("pcb-thick", "pcb.thick")}
          <div class="c3d-sec"><label class="eng-ck"><input type="checkbox" id="pcb-iso-on"> ${esc(t("pcb.iso"))}</label></div>
          <div class="dlg-row"><span>${esc(t("pcb.tool"))}</span><select id="pcb-iso-tool" class="prop-input" style="width:170px;">${opts(vbits(), o.isoTool)}</select></div>
          ${num("pcb-iso-depth", "pcb.isoDepth", "mm", "0.01", "pcb.isoDepthTip")}${num("pcb-passes", "pcb.passes", "", "1", "pcb.passesTip")}${num("pcb-overlap", "pcb.overlap", "%", "5")}
          <div class="dlg-hint" id="pcb-width"></div>
          <div class="c3d-sec"><label class="eng-ck"><input type="checkbox" id="pcb-drill-on"> ${esc(t("pcb.drill"))}</label></div>
          ${num("pcb-drill-more", "pcb.more", "mm", "0.1", "pcb.moreTip")}
          <div id="pcb-holes"></div>
          <div class="c3d-sec"><label class="eng-ck"><input type="checkbox" id="pcb-out-on"> ${esc(t("pcb.outline"))}</label></div>
          <div class="dlg-row"><span>${esc(t("pcb.tool"))}</span><select id="pcb-out-tool" class="prop-input" style="width:170px;">${opts(mills(), o.outTool)}</select></div>
          ${num("pcb-out-more", "pcb.more", "mm", "0.1", "pcb.moreTip")}
          <label class="eng-ck"><input type="checkbox" id="pcb-tabs"> ${esc(t("pcb.tabs"))}</label>
        </div>
        <div>
          <canvas id="pcb-cv" style="width:100%;height:min(56vh,560px);display:block;border-radius:6px;cursor:grab;touch-action:none;"></canvas>
          <div class="dlg-hint" id="pcb-info"></div>
          <div class="dlg-hint" id="pcb-warn" style="color:var(--lt-amber, #ffb454);white-space:pre-line;"></div>
        </div>
      </div>
      <div class="dlg-buttons">
        <button id="pcb-ok" class="btn-primary">${esc(t("pcb.insert"))}</button>
        <button id="pcb-close" class="btn-secondary" style="margin-left:auto;">${esc(t("dlg.cancel"))}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;

  const nums: [string, "x" | "y" | "thick" | "isoDepth" | "passes" | "overlap" | "drillMore" | "outMore", number, number][] = [
    ["pcb-x", "x", -5000, 5000], ["pcb-y", "y", -5000, 5000], ["pcb-thick", "thick", 0.1, 20], ["pcb-iso-depth", "isoDepth", 0.01, 2], ["pcb-passes", "passes", 1, 40],
    ["pcb-overlap", "overlap", 0, 90], ["pcb-drill-more", "drillMore", 0, 5], ["pcb-out-more", "outMore", 0, 5]];
  const checks: [string, "isoOn" | "drillOn" | "outOn" | "tabs"][] = [["pcb-iso-on", "isoOn"], ["pcb-drill-on", "drillOn"], ["pcb-out-on", "outOn"], ["pcb-tabs", "tabs"]];
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* egal */ } };

  let board: Board | null = null, iso: IsoResult | null = null, isoErr = "", busy = false, worker: Worker | null = null, run = 0;
  const copperFile = () => files.filter(f => f.role === o.side && f.gerber);
  const copperObjs = () => copperFile().flatMap(f => f.gerber!.objs);

  // ---- Listen ----
  const drawFiles = () => {
    $<HTMLElement>("pcb-files").innerHTML = files.map((f, i) => `<div class="dlg-row"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px;" data-tip="${esc(f.name)}">${esc(f.name.replace(/^.*[\\/]/, ""))}</span>
      <select class="prop-input" data-file="${i}" style="width:118px;">${ROLES.filter(r => (f.drill ? r === "drill" || r === "ignore" : r !== "drill")).map(r => `<option value="${r}"${r === f.role ? " selected" : ""}>${esc(t("pcb.role." + r))}</option>`).join("")}</select></div>`).join("");
  };
  const sizes = () => {
    const m = new Map<number, number>();
    for (const s of bySize([...(board?.holes ?? []), ...(board?.slots ?? []).map(s => ({ x: 0, y: 0, d: s.d }))])) m.set(s.d, s.holes.length);
    return m;
  };
  const drawHoles = () => {
    const tools = getTools();
    $<HTMLElement>("pcb-holes").innerHTML = [...sizes()].map(([d, n]) => {
      if (!holeTool.has(d)) holeTool.set(d, pickHoleTool(d, tools)?.id ?? (d <= 3.2 ? "new" : ""));
      const sel = holeTool.get(d)!, fit = tools.filter(x => holeMode(d, x) !== "no");
      return `<div class="dlg-row"><span>${n} × Ø ${d.toFixed(2)}</span><select class="prop-input" data-hole="${d}" style="width:170px;">
        ${fit.map(x => `<option value="${esc(x.id)}"${x.id === sel ? " selected" : ""}>${esc(t(holeMode(d, x) === "drill" ? "pcb.hole.drill" : "pcb.hole.mill"))}: ${esc(x.name)}</option>`).join("")}
        <option value="new"${sel === "new" ? " selected" : ""}>${esc(t("pcb.hole.new", { d: d.toFixed(2) }))}</option>
        <option value=""${sel === "" ? " selected" : ""}>${esc(t("pcb.hole.skip"))}</option></select></div>`;
    }).join("");
  };

  // ---- Rechnen ----
  const stopWorker = () => { worker?.terminate(); worker = null; };
  const compute = () => {
    board = boardOf(files);
    if (!copperFile().length && files.some(f => f.role === (o.side === "top" ? "bottom" : "top"))) { /* andere Seite gewählt: nur Hinweis */ }
    drawHoles();
    iso = null; isoErr = "";
    const my = ++run;
    stopWorker();
    const it = tool(o.isoTool), objs = copperObjs();
    const w = it ? cutWidth(it, o.isoDepth) : 0;
    $<HTMLElement>("pcb-width").textContent = it ? t("pcb.width", { w: w.toFixed(3) }) : t("pcb.noIsoTool");
    if (!o.isoOn || !it || !objs.length || !board || !(w > 0.01)) { busy = false; refresh(); return; }
    // Kupfer kann über die Platine hinausragen – das Raster deckt beides ab
    const cb = gerberBox(objs)!, b = board.box;
    const box = { x0: Math.min(b.x0, cb.x0), y0: Math.min(b.y0, cb.y0), x1: Math.max(b.x1, cb.x1), y1: Math.max(b.y1, cb.y1) };
    if ((box.x1 - box.x0) > 1200 || (box.y1 - box.y0) > 1200) { isoErr = t("pcb.tooBig"); busy = false; refresh(); return; }
    const job: IsoJob = { objs, box, width: w, passes: o.passes, overlap: o.overlap / 100 };
    busy = true; refresh();
    const done = (r: IsoResult | null, err = "") => { if (my !== run || !ov.isConnected) return; stopWorker(); iso = r; isoErr = err; busy = false; refresh(); };
    try {
      worker = new Worker(new URL("../pcb/pcbWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ev => (ev.data.ok ? done(ev.data.r) : done(null, ev.data.error));
      worker.onerror = e => done(null, e.message || "worker");
      worker.postMessage(job);
    } catch {
      setTimeout(() => { try { done(isolate(job)); } catch (e) { done(null, String(e)); } }, 20);
    }
  };
  let timer = 0;
  const later = () => { clearTimeout(timer); timer = window.setTimeout(() => { if (ov.isConnected) compute(); }, 250); };

  // ---- Anzeige ----
  const view = { k: 1, x: 0, y: 0, set: false };
  const cv = $<HTMLCanvasElement>("pcb-cv");
  const fit = () => {
    const b = board?.box;
    const W = cv.clientWidth || 600, H = cv.clientHeight || 400;
    if (!b) return;
    view.k = Math.min((W - 30) / Math.max(1, b.x1 - b.x0), (H - 30) / Math.max(1, b.y1 - b.y0));
    view.x = W / 2 - (b.x0 + b.x1) / 2 * view.k; view.y = H / 2 + (b.y0 + b.y1) / 2 * view.k; view.set = true;
  };
  const draw = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#14171b"; ctx.fillRect(0, 0, W, H);
    if (!board) return;
    if (!view.set) fit();
    const b = board.box, mir = o.side === "bottom";
    // Rückseite: so gezeigt, wie sie auf der Maschine liegt (gespiegelt)
    const X = (x: number) => (mir ? b.x0 + b.x1 - x : x) * view.k + view.x, Y = (y: number) => view.y - y * view.k;
    const path = (pts: { x: number; y: number }[], closed: boolean) => { pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y)))); if (closed) ctx.closePath(); };
    ctx.beginPath();
    if (board.loops.length) { for (const l of board.loops) path(l, true); } else ctx.rect(Math.min(X(b.x0), X(b.x1)), Y(b.y1), (b.x1 - b.x0) * view.k, (b.y1 - b.y0) * view.k);
    ctx.fillStyle = "#1d4d33"; ctx.fill("evenodd");
    if (iso) { ctx.beginPath(); for (const l of iso.copper) path(l, true); ctx.fillStyle = "#c98a4b"; ctx.fill("evenodd"); }
    else { // noch nicht gerechnet: grob aus den Grundformen
      ctx.fillStyle = "#8a6238"; ctx.strokeStyle = "#8a6238"; ctx.lineCap = "round";
      for (const q of copperObjs()) {
        if (!q.dark) continue;
        if (q.k === "stroke") { ctx.beginPath(); ctx.lineWidth = Math.max(0.5, 2 * q.r * view.k); ctx.moveTo(X(q.a[0]), Y(q.a[1])); ctx.lineTo(X(q.b[0]), Y(q.b[1])); ctx.stroke(); }
        else if (q.k === "poly") { ctx.beginPath(); path(q.p.map(([x, y]) => ({ x, y })), true); ctx.fill(); }
        else for (const p of q.parts) if (p.on) { ctx.beginPath(); if ("c" in p) ctx.arc(X(p.c[0]), Y(p.c[1]), p.c[2] * view.k, 0, 7); else path(p.p.map(([x, y]) => ({ x, y })), true); ctx.fill(); }
      }
    }
    if (iso && o.isoOn) {
      const it = tool(o.isoTool), w = it ? cutWidth(it, o.isoDepth) : 0.1;
      ctx.lineCap = ctx.lineJoin = "round"; ctx.lineWidth = Math.max(0.7, w * view.k); ctx.strokeStyle = "rgba(120,200,255,0.75)";
      ctx.beginPath(); for (const l of iso.lines) path(l.pts, l.closed); ctx.stroke();
    }
    if (o.drillOn) {
      for (const h of board.holes) { const skip = !holeTool.get(key(h.d)); ctx.beginPath(); ctx.arc(X(h.x), Y(h.y), Math.max(1, h.d / 2 * view.k), 0, 7); ctx.fillStyle = skip ? "rgba(255,90,90,0.85)" : "#0b0d10"; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.stroke(); }
      for (const s of board.slots) { ctx.beginPath(); path(s.pts.map(([x, y]) => ({ x, y })), false); ctx.lineCap = "round"; ctx.lineWidth = Math.max(1, s.d * view.k); ctx.strokeStyle = holeTool.get(key(s.d)) ? "#0b0d10" : "rgba(255,90,90,0.85)"; ctx.stroke(); }
    }
    if (o.outOn) { ctx.beginPath(); for (const l of board.loops) path(l, true); ctx.lineWidth = 1.5; ctx.strokeStyle = "#ffe08a"; ctx.stroke(); }
    if (iso) for (const q of iso.bridges.slice(0, 400)) { ctx.beginPath(); ctx.arc(X(q.x), Y(q.y), 7, 0, 7); ctx.lineWidth = 2; ctx.strokeStyle = "#ff4d4d"; ctx.stroke(); }
  };

  const refresh = () => {
    for (const [id, k] of nums) if (document.activeElement !== $(id)) $(id).value = String(o[k]);
    for (const [id, k] of checks) $(id).checked = o[k];
    $<HTMLSelectElement>("pcb-side").value = o.side;
    const b = board?.box, warn: string[] = [];
    $<HTMLElement>("pcb-info").textContent = !b ? t("pcb.nothing")
      : t("pcb.info", { w: (b.x1 - b.x0).toFixed(2), h: (b.y1 - b.y0).toFixed(2), n: board!.holes.length + board!.slots.length }) + " "
        + (busy ? t("pcb.busy") : iso ? t("pcb.infoIso", { n: iso.lines.length, nets: iso.nets }) : "");
    if (b) {
      if (o.isoOn && !copperFile().length) warn.push(t("pcb.warnNoCopper", { side: t("pcb.side." + o.side) }));
      if (isoErr) warn.push(isoErr);
      const iw = tool(o.isoTool) ? cutWidth(tool(o.isoTool)!, o.isoDepth) : 0;
      if (o.isoOn && iw > 0.6) warn.push(t("pcb.warnWide", { w: iw.toFixed(2) }));
      if (iso?.bridges.length) warn.push(t("pcb.warnBridges", { n: iso.bridges.length, g: iso.minGap < iso.h ? "< " + iso.h.toFixed(2) : iso.minGap.toFixed(2) }));
      if (iso && iso.h > 0.06) warn.push(t("pcb.warnCoarse", { h: iso.h.toFixed(2) }));
      if (o.outOn && !board!.loops.length) warn.push(t("pcb.warnNoOutline"));
      if (o.outOn && board!.open) warn.push(t("pcb.warnOpen", { n: board!.open }));
      const off = holesOff(board!);
      if (off) warn.push(t("pcb.warnHolesOff", { n: off }));
      if (files.some(f => f.role === "drill" && f.drill?.guessed)) warn.push(t("pcb.warnFormat"));
      const skip = [...sizes()].filter(([d]) => !holeTool.get(d)).reduce((a, [, n]) => a + n, 0);
      if (o.drillOn && skip) warn.push(t("pcb.warnSkip", { n: skip }));
      const bad = new Set(files.filter(f => f.role !== "ignore").flatMap(f => [...(f.gerber?.warnings ?? []), ...(f.drill?.warnings ?? [])]));
      if (bad.size) warn.push(t("pcb.warnRead", { list: [...bad].map(x => t("pcb.read." + x)).join(", ") }));
      const bed = bedSizeMm();
      if (o.x < 0 || o.y < 0 || o.x + b.x1 - b.x0 > bed.w || o.y + b.y1 - b.y0 > bed.h) warn.push(t("pcb.warnBed", { w: bed.w, h: bed.h }));
    }
    $<HTMLElement>("pcb-warn").textContent = warn.map(x => "⚠ " + x).join("\n");
    $<HTMLButtonElement>("pcb-ok").disabled = !board || busy || !((o.isoOn && iso?.lines.length) || (o.drillOn && (board.holes.length || board.slots.length)) || (o.outOn && board.loops.length));
    draw();
  };

  // ---- Bedienung ----
  for (const [id, k, lo, hi] of nums) {
    $(id).addEventListener("input", () => {
      const v = parseFloat($(id).value);
      if (!Number.isFinite(v) || v < lo || v > hi) return;
      o[k] = k === "passes" ? Math.round(v) : v;
      if (k === "isoDepth" || k === "passes" || k === "overlap") later(); else refresh();
    });
    $(id).addEventListener("change", () => { $(id).blur(); refresh(); });
  }
  for (const [id, k] of checks) $(id).addEventListener("change", () => { o[k] = $(id).checked; if (k === "isoOn") compute(); else refresh(); });
  $<HTMLSelectElement>("pcb-side").addEventListener("change", () => { o.side = $<HTMLSelectElement>("pcb-side").value === "bottom" ? "bottom" : "top"; compute(); });
  $<HTMLSelectElement>("pcb-iso-tool").addEventListener("change", () => { o.isoTool = $<HTMLSelectElement>("pcb-iso-tool").value; compute(); });
  $<HTMLSelectElement>("pcb-out-tool").addEventListener("change", () => { o.outTool = $<HTMLSelectElement>("pcb-out-tool").value; refresh(); });
  ov.addEventListener("change", e => {
    const el = e.target as HTMLSelectElement;
    if (el.dataset.file !== undefined) { files[+el.dataset.file].role = el.value as Role; view.set = false; compute(); }
    if (el.dataset.hole !== undefined) { holeTool.set(+el.dataset.hole, el.value); refresh(); }
  });
  let drag: { x: number; y: number } | null = null;
  cv.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); cv.style.cursor = "grabbing"; });
  cv.addEventListener("pointermove", e => { if (!drag) return; view.x += e.clientX - drag.x; view.y += e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY }; draw(); });
  const drop = () => { drag = null; cv.style.cursor = "grab"; };
  cv.addEventListener("pointerup", drop); cv.addEventListener("pointercancel", drop);
  cv.addEventListener("dblclick", () => { fit(); draw(); });
  cv.addEventListener("wheel", e => {
    e.preventDefault();
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, f = Math.exp(-e.deltaY * 0.0015), k = Math.max(0.2, Math.min(2000, view.k * f));
    view.x = mx - (mx - view.x) * k / view.k; view.y = my - (my - view.y) * k / view.k; view.k = k;
    draw();
  }, { passive: false });
  const onResize = () => draw();
  window.addEventListener("resize", onResize);
  const close = () => { run++; stopWorker(); clearTimeout(timer); current = null; window.removeEventListener("resize", onResize); ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  $<HTMLButtonElement>("pcb-close").onclick = close;

  $<HTMLButtonElement>("pcb-ok").onclick = () => {
    if (!board || busy) return;
    save();
    // fehlende Bohrer anlegen (Schnittwerte vorsichtig: Platine, Hartmetall)
    const made = new Map<number, MillingTool>();
    const need = new Set(o.drillOn ? [...sizes().keys()] : []);
    for (const d of need) if (holeTool.get(d) === "new") made.set(d, addTool({ name: t("pcb.drillName", { d: d.toFixed(2) }), type: "drill", diameter: d, shankDia: 3.175, fluteLen: Math.max(8, d * 8), length: 38, flutes: 2, angle: 130, stepZ: Math.max(0.2, Math.min(1, d)), feedrate: 120, plungeFeed: 120, rpm: 20000 }));
    const holeFor = (d: number) => { const k = key(d); return made.get(k) ?? tool(holeTool.get(k) || ""); };
    const mirror = o.side === "bottom", place = placer(board.box, { x: o.x, y: o.y }, mirror);
    const it = tool(o.isoTool), ot = tool(o.outTool);
    const { descs, skipped } = buildDescs(board, {
      place, mirror,
      iso: o.isoOn && iso && it ? { lines: iso.lines, toolId: it.id, depth: o.isoDepth } : null,
      drill: o.drillOn ? { tool: holeFor, depth: o.thick + o.drillMore } : null,
      outline: o.outOn && ot ? { tool: ot, depth: o.thick + o.outMore, tabs: o.tabs } : null,
    });
    if (!descs.length) { log(t("pcb.nothing")); return; }
    const group: Record<string, string> = { iso: "pcb-" + newId(), hole: "pcb-" + newId(), slot: "", outline: "" };
    group.slot = group.hole; group.outline = "pcb-" + newId();
    const shapes = descs.map(d => {
      const px = d.pts.map(p => ({ x: p.x * MM_TO_PIXEL, y: p.y * MM_TO_PIXEL }));
      const s = d.type === "circle" ? createCircle(px[0].x, px[0].y, d.r * MM_TO_PIXEL, d.mode) : createPolyline(px, d.closed, d.mode);
      s.millingDepth = +d.depth.toFixed(3);
      s.toolId = d.toolId;
      s.groupId = group[d.kind];
      if (d.tabs) { s.tabN = 4; s.tabLen = 3; s.tabH = Math.min(0.8, o.thick / 2); }
      return s;
    });
    state.shapes = [...state.shapes, ...shapes];
    state.selectedShapeIds = shapes.map(s => s.id);
    updateDimensionInputs(null);
    checkpoint();
    redraw();
    log(t("pcb.inserted", { iso: descs.filter(d => d.kind === "iso").length, holes: descs.filter(d => d.kind === "hole" || d.kind === "slot").length, out: descs.filter(d => d.kind === "outline").length }));
    if (made.size) log(t("pcb.madeDrills", { n: made.size }));
    if (skipped) log(t("pcb.warnSkip", { n: skipped }));
    if (iso?.bridges.length && o.isoOn) log(t("pcb.warnBridges", { n: iso.bridges.length, g: iso.minGap < iso.h ? "< " + iso.h.toFixed(2) : iso.minGap.toFixed(2) }));
    log(t("pcb.hint"));
    close();
  };

  current = more => { files.push(...more.filter(m => !files.some(f => f.name === m.name))); drawFiles(); view.set = false; later(); };
  // nur eine Kupferlage da: diese Seite zeigen
  const autoSide = () => { const has = (r: Role) => files.some(f => f.role === r); if (!has(o.side)) { if (has("top")) o.side = "top"; else if (has("bottom")) o.side = "bottom"; } };
  autoSide();
  drawFiles();
  refresh();
  // etwas warten: beim Öffnen mehrerer Dateien kommen die nächsten gleich hinterher
  timer = window.setTimeout(() => { if (ov.isConnected) { autoSide(); view.set = false; compute(); } }, 150);
}
