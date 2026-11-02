/**
 * LÜFTUNGSGITTER / LOCHMUSTER – Fenster (Generatoren): Form, Muster, Lochgröße, Steg, Rand, Platte und
 * Befestigungslöcher. „Aufs Bett“ legt Löcher und Umriss als eine Gruppe in die Bettmitte (stärkste Linien-Ebene).
 * Geometrie: vent.ts.
 */
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, newId, createPolyline } from "../shapeTransform";
import { getLayers } from "../laserLayers";
import { getMachineMode } from "../machineMode";
import { toolForShape } from "../toolLibrary";
import { t } from "../i18n/i18n";
import { vent, VENT_SHAPES, VENT_PATTERNS, type VentOptions, type VentResult, type VentShape, type VentPattern, type XY } from "../vent";

const KEY = "cnc_craft_vent";
const DEF: VentOptions = { shape: "rect", width: 120, height: 80, radius: 6, margin: 6, pattern: "hex", size: 6, web: 1.5, slotLength: 20,
  plate: true, mountD: 4, mountInset: 6 };
const NUMS = ["width", "height", "radius", "margin", "size", "web", "slotLength", "mountD", "mountInset"] as const;

function load(): VentOptions {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: VentOptions = { ...DEF };
    for (const k of NUMS) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    if (VENT_SHAPES.includes(s.shape)) o.shape = s.shape;
    if (VENT_PATTERNS.includes(s.pattern)) o.pattern = s.pattern;
    if (typeof s.plate === "boolean") o.plate = s.plate;
    return o;
  } catch { return { ...DEF }; }
}

const f = (v: number, n = 1) => String(Number(v.toFixed(n)));

function previewSvg(r: VentResult, o: VentOptions): string {
  const W = o.width, H = o.shape === "circle" ? o.width : o.height, pad = Math.max(W, H) * 0.04 + 1;
  const path = (pts: XY[]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${(x + W / 2 + pad).toFixed(2)},${(H / 2 - y + pad).toFixed(2)}`).join("") + "Z";
  const sw = Math.max(W, H) / 500;
  const outline = r.outline;
  const body = outline ? `<path d="${path(outline)}${[...r.holes, ...r.mounts].map(path).join("")}" fill="#8a8f9c" fill-rule="evenodd" stroke="#d0d4dc" stroke-width="${sw.toFixed(2)}"/>`
    : `<path d="${[...r.holes, ...r.mounts].map(path).join("")}" fill="none" stroke="#d0d4dc" stroke-width="${sw.toFixed(2)}"/>`;
  return `<svg viewBox="0 0 ${(W + 2 * pad).toFixed(2)} ${(H + 2 * pad).toFixed(2)}" style="width:100%;height:280px;">${body}</svg>`;
}

export function openVentDialog(log: (s: string) => void, done: () => void) {
  const init = load();
  document.getElementById("vent-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "vent-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, step: string, min: string, unit = "mm") =>
    `<label class="dlg-row"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="${min}" step="${step}"><em>${unit}</em></span></label>`;
  const sel = (id: string, key: string, opts: [string, string][]) =>
    `<label class="dlg-row"><span>${t(key)}</span><select id="${id}" style="width:auto;max-width:190px;">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(780px, calc(100vw - 32px));">
      <h3>⬢ ${t("vent.title")}</h3>
      <div class="dlg-hint">${t("vent.desc")}</div>
      <div style="display:grid;grid-template-columns:300px 1fr;gap:12px;align-items:start;">
        <div class="box-fields">
          ${sel("vt-shape", "vent.shape", VENT_SHAPES.map(k => [k, t("vent.shape." + k)]))}
          ${num("vt-w", "vent.width", "1", "10")}
          <div class="vt-rect">
            ${num("vt-h", "vent.height", "1", "10")}
            ${num("vt-r", "vent.radius", "0.5", "0")}
          </div>
          ${num("vt-m", "vent.margin", "0.5", "0")}
          ${sel("vt-pat", "vent.pattern", VENT_PATTERNS.map(k => [k, t("vent.pattern." + k)]))}
          ${num("vt-s", "vent.size", "0.1", "0.3")}
          ${num("vt-web", "vent.web", "0.1", "0.3")}
          <div class="vt-slot">${num("vt-sl", "vent.slotLength", "0.5", "1")}</div>
          <label class="dlg-row" style="cursor:pointer;"><span>${t("vent.plate")}</span><input id="vt-plate" type="checkbox" style="width:auto;"></label>
          ${num("vt-md", "vent.mountD", "0.1", "0")}
          <div class="vt-mount">${num("vt-mi", "vent.mountInset", "0.5", "1")}</div>
        </div>
        <div class="box-prev" style="min-height:300px;"><div id="vt-svg" style="flex:1;display:flex;align-items:center;"></div>
          <div id="vt-info" class="dlg-hint"></div><div id="vt-warn" class="dlg-hint" style="color:#ffb454;"></div></div>
      </div>
      <div class="dlg-buttons">
        <button id="vt-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="vt-ok" class="btn-primary">✔ ${t("vent.place")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const ids: [string, (typeof NUMS)[number]][] = [["vt-w", "width"], ["vt-h", "height"], ["vt-r", "radius"], ["vt-m", "margin"], ["vt-s", "size"],
    ["vt-web", "web"], ["vt-sl", "slotLength"], ["vt-md", "mountD"], ["vt-mi", "mountInset"]];
  for (const [id, k] of ids) $(id).value = String(init[k]);
  $<HTMLSelectElement>("vt-shape").value = init.shape;
  $<HTMLSelectElement>("vt-pat").value = init.pattern;
  $("vt-plate").checked = init.plate;

  const read = (): VentOptions => {
    const n = (id: string, d: number, min: number, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    return {
      shape: $<HTMLSelectElement>("vt-shape").value as VentShape, pattern: $<HTMLSelectElement>("vt-pat").value as VentPattern, plate: $("vt-plate").checked,
      width: n("vt-w", DEF.width, 10, 3000), height: n("vt-h", DEF.height, 10, 3000), radius: n("vt-r", 0, 0, 1000), margin: n("vt-m", DEF.margin, 0, 500),
      size: n("vt-s", DEF.size, 0.3, 500), web: n("vt-web", DEF.web, 0.3, 100), slotLength: n("vt-sl", DEF.slotLength, 1, 1000),
      mountD: n("vt-md", 0, 0, 50), mountInset: n("vt-mi", DEF.mountInset, 1, 500)
    };
  };

  let last: VentResult | null = null;
  const update = () => {
    const o = read();
    ov.querySelectorAll<HTMLElement>(".vt-rect").forEach(el => { el.style.display = o.shape === "rect" ? "" : "none"; });
    ov.querySelectorAll<HTMLElement>(".vt-slot").forEach(el => { el.style.display = o.pattern === "slot" ? "" : "none"; });
    ov.querySelectorAll<HTMLElement>(".vt-mount").forEach(el => { el.style.display = o.mountD > 0 ? "" : "none"; });
    const r = vent(o);
    last = r;
    $<HTMLElement>("vt-svg").innerHTML = previewSvg(r, o);
    $<HTMLElement>("vt-info").textContent = t("vent.info", { n: r.holes.length, p: f(r.openArea, 0) });
    const warn = r.warnings.map(w => t(w));
    if (getMachineMode() === "mill") {
      const tool = toolForShape(null);
      if (tool && tool.diameter > o.size) warn.push(t("vent.warnTool", { tool: f(tool.diameter, 2), s: f(o.size) }));
    }
    $<HTMLElement>("vt-warn").innerHTML = warn.map(s => `<div>${s}</div>`).join("");
    $<HTMLButtonElement>("vt-ok").disabled = !r.holes.length && !r.mounts.length;
  };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener(i.tagName === "SELECT" || (i as HTMLInputElement).type === "checkbox" ? "change" : "input", update));
  update();

  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("vt-cancel").onclick = close;
  $<HTMLElement>("vt-ok").onclick = () => {
    update();
    const r = last;
    if (!r) return;
    const o = read();
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* egal */ }
    close();
    placeVent(r);
    log(t("vent.done", { n: r.holes.length }));
    done();
  };
}

/** Löcher (innen) und Umriss (außen) als eine Gruppe in die Bettmitte – erst die Löcher, dann der Umriss */
function placeVent(r: VentResult) {
  const st = app();
  const bed = bedSizeMm();
  const px = (pts: XY[]) => pts.slice(0, -1).map(([x, y]) => ({ x: (x + bed.w / 2) * MM_TO_PIXEL, y: (y + bed.h / 2) * MM_TO_PIXEL }));
  const cutL = getLayers().filter(l => l.mode === "line").sort((a, c) => c.power - a.power)[0];
  const extra = { ...(cutL ? { laserLayerId: cutL.id } : {}), groupId: "vent-" + newId(), source: t("vent.title").slice(0, 40) };
  const made: any[] = [...r.holes, ...r.mounts].map(h => createPolyline(px(h), true, "inside", extra));
  if (r.outline) made.push(createPolyline(px(r.outline), true, "outside", extra));
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}
