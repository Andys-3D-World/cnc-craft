/**
 * STECKREGAL – Fenster (Generatoren): Maße, Anzahl Böden, Materialdicke, Spiel, Fräser + Dogbones, Füße.
 * Vorschau zeigt das Regal von vorne und alle Teile so, wie sie aufs Bett kommen (Reihen in Bettbreite).
 * Geometrie: shelf.ts.
 */
import { loadSettings, saveSettings } from "./genRun";
import type { MultiPolygon } from "polygon-clipping";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, newId } from "../shapeTransform";
import { toShapes } from "./shapeOps";
import { getLayers } from "../laserLayers";
import { getMachineMode } from "../machineMode";
import { toolForShape } from "../toolLibrary";
import { t } from "../i18n/i18n";
import { shelf, layoutParts, type ShelfOptions, type ShelfResult } from "../shelf";
import { RELIEFS, type Relief, type XY } from "../joints";

const KEY = "cnc_craft_shelf";
const DEF: ShelfOptions = { width: 600, height: 800, depth: 250, shelves: 4, thickness: 18, bottom: 80, top: 30, overhang: 20,
  clearance: 0.3, tool: 6, relief: "dogbone", feet: true };
const NUMS = ["width", "height", "depth", "shelves", "thickness", "bottom", "top", "overhang", "clearance"] as const;

function load(): ShelfOptions {
  try {
    const s = JSON.parse(loadSettings(KEY) || "{}");
    const o: ShelfOptions = { ...DEF };
    for (const k of NUMS) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    if (RELIEFS.includes(s.relief)) o.relief = s.relief;
    if (typeof s.feet === "boolean") o.feet = s.feet;
    return o;
  } catch { return { ...DEF }; }
}

const f = (v: number, n = 1) => String(Number(v.toFixed(n)));

function previewSvg(r: ShelfResult, o: ShelfOptions, bedW: number): string {
  // links: Regal von vorne; rechts: Teile wie auf dem Bett
  const L = layoutParts(r.parts, bedW);
  const fw = o.width, fh = o.height, gap = Math.max(fw, fh) * 0.15;
  const W = fw + gap + L.w, H = Math.max(fh, L.h), pad = Math.max(W, H) * 0.03 + 1;
  const sw = Math.max(W, H) / 500;
  const X = (x: number) => (x + pad).toFixed(2), Y = (y: number) => (H - y + pad).toFixed(2);
  const rc = (x: number, y: number, w: number, h: number, fill: string) =>
    `<rect x="${X(x)}" y="${Y(y + h)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}" stroke="#ffd28a" stroke-width="${sw.toFixed(2)}"/>`;
  const front = [rc(o.overhang, 0, o.thickness, fh, "#a8743f"), rc(fw - o.overhang - o.thickness, 0, o.thickness, fh, "#a8743f"),
    ...r.levels.map(y => rc(0, y - o.thickness / 2, fw, o.thickness, "#c98a4b"))].join("");
  const d = (m: MultiPolygon, at: XY) => m.map(poly => poly.map(rg => rg.map(([x, y], i) => `${i ? "L" : "M"}${X(x + at[0] + fw + gap)},${Y(y + at[1])}`).join("") + "Z").join("")).join("");
  const parts = r.parts.map((p, i) => `<path d="${d(p.area, L.at[i])}" fill="${p.kind === "side" ? "#a8743f" : "#c98a4b"}" fill-rule="evenodd" stroke="#ffd28a" stroke-width="${sw.toFixed(2)}"/>`).join("");
  return `<svg viewBox="0 0 ${(W + 2 * pad).toFixed(2)} ${(H + 2 * pad).toFixed(2)}" style="width:100%;height:280px;">${front}${parts}</svg>`;
}

export function openShelfDialog(log: (s: string) => void, done: () => void) {
  const init = load();
  const tool = getMachineMode() === "mill" ? toolForShape(null) : null;
  init.tool = tool && tool.diameter > 0 ? tool.diameter : 0;
  document.getElementById("shelf-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "shelf-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, step: string, min: string, unit = "mm") =>
    `<label class="dlg-row"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="${min}" step="${step}"><em>${unit}</em></span></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(820px, calc(100vw - 32px));">
      <h3>🗄 ${t("shelf.title")}</h3>
      <div class="dlg-hint">${t("shelf.desc")}</div>
      <div style="display:grid;grid-template-columns:300px 1fr;gap:12px;align-items:start;">
        <div class="box-fields">
          ${num("sh-w", "shelf.width", "1", "100")}
          ${num("sh-h", "shelf.height", "1", "100")}
          ${num("sh-d", "shelf.depth", "1", "50")}
          ${num("sh-n", "shelf.shelves", "1", "2", "")}
          ${num("sh-t", "shelf.thickness", "0.5", "3")}
          ${num("sh-b", "shelf.bottom", "1", "10")}
          ${num("sh-top", "shelf.top", "1", "10")}
          ${num("sh-o", "shelf.overhang", "1", "0")}
          ${num("sh-c", "shelf.clearance", "0.05", "0")}
          ${num("sh-tool", "joint.tool", "0.1", "0")}
          <label class="dlg-row"><span>${t("joint.relief")}</span><select id="sh-rel" style="width:auto;">${(["dogbone", "none"] as Relief[]).map(k => `<option value="${k}">${t("joint.relief." + k)}</option>`).join("")}</select></label>
          <label class="dlg-row" style="cursor:pointer;"><span>${t("shelf.feet")}</span><input id="sh-feet" type="checkbox" style="width:auto;"></label>
        </div>
        <div class="box-prev" style="min-height:300px;"><div id="sh-svg" style="flex:1;display:flex;align-items:center;"></div>
          <div id="sh-info" class="dlg-hint"></div><div id="sh-warn" class="dlg-hint" style="color:var(--lt-amber, #ffb454);"></div></div>
      </div>
      <div class="dlg-buttons">
        <button id="sh-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="sh-ok" class="btn-primary">✔ ${t("shelf.place")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const ids: [string, keyof ShelfOptions][] = [["sh-w", "width"], ["sh-h", "height"], ["sh-d", "depth"], ["sh-n", "shelves"], ["sh-t", "thickness"],
    ["sh-b", "bottom"], ["sh-top", "top"], ["sh-o", "overhang"], ["sh-c", "clearance"], ["sh-tool", "tool"]];
  for (const [id, k] of ids) $(id).value = String(init[k]);
  $<HTMLSelectElement>("sh-rel").value = init.relief === "tbone" ? "dogbone" : init.relief;
  $("sh-feet").checked = init.feet;

  const read = (): ShelfOptions => {
    const n = (id: string, d: number, min: number, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    return {
      width: n("sh-w", DEF.width, 100, 5000), height: n("sh-h", DEF.height, 100, 5000), depth: n("sh-d", DEF.depth, 50, 2000),
      shelves: Math.round(n("sh-n", DEF.shelves, 2, 10)), thickness: n("sh-t", DEF.thickness, 3, 60), bottom: n("sh-b", DEF.bottom, 10, 2000),
      top: n("sh-top", DEF.top, 10, 2000), overhang: n("sh-o", DEF.overhang, 0, 500), clearance: n("sh-c", DEF.clearance, 0, 5),
      tool: n("sh-tool", 0, 0, 50), relief: $<HTMLSelectElement>("sh-rel").value as Relief, feet: $("sh-feet").checked
    };
  };

  let last: ShelfResult | null = null;
  const update = () => {
    const o = read();
    const r = shelf(o);
    last = r;
    const bed = bedSizeMm();
    $<HTMLElement>("sh-svg").innerHTML = previewSvg(r, o, bed.w);
    const L = layoutParts(r.parts, bed.w);
    $<HTMLElement>("sh-info").innerHTML = `<div>${t("shelf.info", { n: r.parts.length, s: f(r.spacing - o.thickness), w: f(L.w, 0), h: f(L.h, 0) })}</div><div>${t("shelf.how")}</div>`;
    const warn = r.warnings.map(w => t(w));
    if (L.w > bed.w + 1e-6 || L.h > bed.h + 1e-6) warn.push(t("shelf.warnBed", { w: f(bed.w, 0), h: f(bed.h, 0) }));
    $<HTMLElement>("sh-warn").innerHTML = warn.map(s => `<div>${s}</div>`).join("");
  };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener(i.tagName === "SELECT" || (i as HTMLInputElement).type === "checkbox" ? "change" : "input", update));
  update();

  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("sh-cancel").onclick = close;
  $<HTMLElement>("sh-ok").onclick = () => {
    update();
    const r = last;
    if (!r) return;
    const o = read();
    saveSettings(KEY, o);
    close();
    placeShelf(r);
    log(t("shelf.done", { n: r.parts.length }));
    done();
  };
}

/** Teile in Reihen (Bettbreite), zusammen mittig – passt es nicht, ab der linken unteren Ecke */
function placeShelf(r: ShelfResult) {
  const st = app();
  const bed = bedSizeMm();
  const L = layoutParts(r.parts, bed.w);
  const ox = Math.max(0, (bed.w - L.w) / 2), oy = Math.max(0, (bed.h - L.h) / 2);
  const cutL = getLayers().filter(l => l.mode === "line").sort((a, c) => c.power - a.power)[0];
  const made: any[] = [];
  r.parts.forEach((p, i) => {
    const [ax, ay] = L.at[i];
    const px: MultiPolygon = p.area.map(poly => poly.map(rg => rg.map(([x, y]) => [(x + ax + ox) * MM_TO_PIXEL, (y + ay + oy) * MM_TO_PIXEL] as [number, number])));
    const groupId = "shelf-" + newId(), source = t(p.kind === "side" ? "shelf.side" : "shelf.board").slice(0, 40);
    made.push(...toShapes(px, cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId, source })));
  });
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}
