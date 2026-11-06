/**
 * FACHTEILER – Fenster (Generatoren): Kistenmaße, Fächer, Material, Spiel, Laser/Fräse.
 * Vorschau zeigt den Einsatz von oben und alle Teile so, wie sie aufs Bett kommen. Geometrie: divider.ts.
 */
import { icon } from "../ui/icons";
import { loadSettings, saveSettings } from "./genRun";
import type { MultiPolygon } from "polygon-clipping";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, newId } from "../shapeTransform";
import { toShapes } from "./shapeOps";
import { getLayers } from "../laserLayers";
import { getMachineMode } from "../machineMode";
import { toolForShape } from "../toolLibrary";
import { t } from "../i18n/i18n";
import { divider, fromBox, DIVIDER_OUTERS, type DividerOptions, type DividerOuter, type DividerResult, type DividerMsg } from "../divider";
import { layoutParts } from "../shelf";
import { RELIEFS, type Relief, type XY } from "../joints";

const KEY = "cnc_craft_divider";
const BOX_KEY = "cnc_craft_box";
const DEF: DividerOptions = { width: 200, depth: 150, height: 50, outside: false, wall: 3, thickness: 3, cols: 4, rows: 3, colSizes: "", rowSizes: "",
  clearance: 0.2, gap: 0.5, kerf: 0.1, tool: 0, relief: "dogbone", dividerHeight: 0, outer: "none" };
const NUMS = ["width", "depth", "height", "wall", "thickness", "cols", "rows", "clearance", "gap", "kerf", "dividerHeight"] as const;

function load(): DividerOptions {
  try {
    const s = JSON.parse(loadSettings(KEY) || "{}");
    const o: DividerOptions = { ...DEF };
    for (const k of NUMS) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    if (typeof s.outside === "boolean") o.outside = s.outside;
    if (typeof s.colSizes === "string") o.colSizes = s.colSizes.slice(0, 200);
    if (typeof s.rowSizes === "string") o.rowSizes = s.rowSizes.slice(0, 200);
    if (RELIEFS.includes(s.relief)) o.relief = s.relief;
    if (DIVIDER_OUTERS.includes(s.outer)) o.outer = s.outer;
    return o;
  } catch { return { ...DEF }; }
}

/** Letzte Box aus dem Box-Generator (wird dort beim Erstellen gespeichert) */
function lastBox() {
  try { const s = JSON.parse(localStorage.getItem(BOX_KEY) || "null"); return s ? fromBox(s) : null; } catch { return null; }
}

const f = (v: number, n = 1) => String(Number(v.toFixed(n)));
const msg = (m: DividerMsg) => t(m.key, m.vars);
/** Abstand der Teile auf dem Bett: der Fräser muss zwischen ihnen durchpassen */
const gapFor = (o: DividerOptions) => Math.max(6, 2 * o.tool + 1);

function previewSvg(r: DividerResult, o: DividerOptions, bedW: number): string {
  // links: Einsatz von oben (mit Fachmaßen); rechts: Teile wie auf dem Bett
  const L = layoutParts(r.parts, bedW, gapFor(o));
  const framed = o.outer !== "none", th = o.thickness;
  const fw = r.inner.w + (framed ? 2 * th : 0), fh = r.inner.d + (framed ? 2 * th : 0);
  const gap = Math.max(fw, fh) * 0.12;
  const W = fw + gap + L.w, H = Math.max(fh, L.h), pad = Math.max(W, H) * 0.03 + 1;
  const sw = Math.max(W, H) / 500;
  const X = (x: number) => (x + pad).toFixed(2), Y = (y: number) => (H - y + pad).toFixed(2);
  const rc = (x: number, y: number, w: number, h: number, fill: string, stroke = "#ffd28a") =>
    `<rect x="${X(x)}" y="${Y(y + h)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw.toFixed(2)}"/>`;
  const off = framed ? th : 0;
  const plan = [rc(0, 0, fw, fh, "rgba(168,116,63,0.14)", framed ? "#ffd28a" : "#8a7a60")];
  if (framed) plan.push(rc(0, 0, fw, th, "#a8743f"), rc(0, fh - th, fw, th, "#a8743f"), rc(0, 0, th, fh, "#a8743f"), rc(fw - th, 0, th, fh, "#a8743f"));
  for (const y of r.yLines) plan.push(rc(off, off + y - th / 2, r.inner.w, th, "#c98a4b"));
  for (const x of r.xLines) plan.push(rc(off + x - th / 2, off, th, r.inner.d, "#a8743f"));
  // Fachmaße: oben quer, links hoch – nur wenn die Zahl hineinpasst
  const fs = Math.min(fw, fh) / 18;
  const label = (x: number, y: number, s: string) => `<text x="${X(x)}" y="${Y(y)}" fill="#e8e0d0" font-size="${fs.toFixed(2)}" text-anchor="middle" dominant-baseline="middle">${s}</text>`;
  let cx = 0;
  r.colSizes.forEach(c => { if (c > fs * 2.2) plan.push(label(off + cx + c / 2, off + r.inner.d - Math.min(r.rowSizes[r.rowSizes.length - 1], fs), f(c))); cx += c + th; });
  let cy = 0;
  r.rowSizes.forEach(c => { if (c > fs * 1.5 && r.colSizes[0] > fs * 2.2) plan.push(label(off + r.colSizes[0] / 2, off + cy + c / 2, f(c))); cy += c + th; });
  const d = (m: MultiPolygon, at: XY) => m.map(poly => poly.map(rg => rg.map(([x, y], i) => `${i ? "L" : "M"}${X(x + at[0] + fw + gap)},${Y(y + at[1])}`).join("") + "Z").join("")).join("");
  const color = (k: string) => k === "long" ? "#c98a4b" : k === "cross" ? "#a8743f" : k === "base" ? "#7d6a4e" : "#b5803f";
  const parts = r.parts.map((p, i) => `<path d="${d(p.area, L.at[i])}" fill="${color(p.kind)}" fill-rule="evenodd" stroke="#ffd28a" stroke-width="${sw.toFixed(2)}"/>`).join("");
  return `<svg viewBox="0 0 ${(W + 2 * pad).toFixed(2)} ${(H + 2 * pad).toFixed(2)}" style="width:100%;height:280px;">${plan.join("")}${parts}</svg>`;
}

export function openDividerDialog(log: (s: string) => void, done: () => void) {
  const init = load();
  const mill = getMachineMode() === "mill";
  const tool = mill ? toolForShape(null) : null;
  const toolD = tool && tool.diameter > 0 ? tool.diameter : 6;
  document.getElementById("divider-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "divider-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, step: string, min: string, unit = "mm", cls = "") =>
    `<label class="dlg-row${cls ? " " + cls : ""}"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="${min}" step="${step}"><em>${unit}</em></span></label>`;
  const txt = (id: string, key: string) =>
    `<label class="dlg-row"><span>${t(key)}</span><input id="${id}" type="text" maxlength="200" placeholder="40; 60; *" style="width:110px;"></label>`;
  const sel = (id: string, key: string, opts: string, cls = "") =>
    `<label class="dlg-row${cls ? " " + cls : ""}"><span>${t(key)}</span><select id="${id}" style="width:auto;max-width:190px;">${opts}</select></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(860px, calc(100vw - 32px));">
      <h3>${icon("divider", 20)}${t("div.title")}</h3>
      <div class="dlg-hint">${t("div.desc")}</div>
      <div style="display:grid;grid-template-columns:340px 1fr;gap:12px;align-items:start;">
        <div class="box-fields" style="max-height:62vh;overflow:auto;">
          ${sel("dv-size", "div.sizeMode", `<option value="in">${t("div.inside")}</option><option value="out">${t("div.outside")}</option>`)}
          ${num("dv-w", "div.width", "1", "1")}
          ${num("dv-d", "div.depth", "1", "1")}
          ${num("dv-h", "div.height", "1", "1")}
          ${num("dv-wall", "div.wall", "0.5", "0", "mm", "dv-wall-row")}
          <button id="dv-frombox" type="button" class="btn-secondary" style="width:100%;margin:2px 0 6px;">📦 ${t("div.fromBox")}</button>
          ${num("dv-t", "div.thickness", "0.1", "0.5")}
          ${num("dv-c", "div.cols", "1", "1", "")}
          ${txt("dv-cs", "div.colSizes")}
          ${num("dv-r", "div.rows", "1", "1", "")}
          ${txt("dv-rs", "div.rowSizes")}
          ${num("dv-dh", "div.dividerHeight", "1", "0")}
          ${sel("dv-outer", "div.outer", DIVIDER_OUTERS.map(k => `<option value="${k}">${t("div.outer." + k)}</option>`).join(""))}
          ${num("dv-cl", "div.clearance", "0.05", "0")}
          ${num("dv-gap", "div.gap", "0.1", "0", "mm", "dv-gap-row")}
          ${sel("dv-by", "div.cutBy", `<option value="laser">${t("div.cutBy.laser")}</option><option value="mill">${t("div.cutBy.mill")}</option>`)}
          ${num("dv-k", "div.kerf", "0.01", "0", "mm", "dv-laser")}
          ${num("dv-tool", "div.tool", "0.1", "0.1", "mm", "dv-mill")}
          ${sel("dv-rel", "joint.relief", (["dogbone", "tbone", "none"] as Relief[]).map(k => `<option value="${k}">${t("joint.relief." + k)}</option>`).join(""), "dv-mill")}
        </div>
        <div class="box-prev" style="min-height:300px;"><div id="dv-svg" style="flex:1;display:flex;align-items:center;"></div>
          <div id="dv-info" class="dlg-hint"></div><div id="dv-warn" class="dlg-hint" style="color:var(--lt-amber, #ffb454);"></div></div>
      </div>
      <div class="dlg-buttons">
        <button id="dv-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="dv-ok" class="btn-primary">✔ ${t("div.place")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const ids: [string, typeof NUMS[number]][] = [["dv-w", "width"], ["dv-d", "depth"], ["dv-h", "height"], ["dv-wall", "wall"], ["dv-t", "thickness"], ["dv-c", "cols"],
    ["dv-r", "rows"], ["dv-dh", "dividerHeight"], ["dv-cl", "clearance"], ["dv-gap", "gap"], ["dv-k", "kerf"]];
  for (const [id, k] of ids) $(id).value = String(init[k]);
  $("dv-cs").value = init.colSizes;
  $("dv-rs").value = init.rowSizes;
  $("dv-tool").value = String(toolD);
  $<HTMLSelectElement>("dv-size").value = init.outside ? "out" : "in";
  $<HTMLSelectElement>("dv-outer").value = init.outer;
  $<HTMLSelectElement>("dv-by").value = mill ? "mill" : "laser";
  $<HTMLSelectElement>("dv-rel").value = init.relief;

  const boxSize = lastBox();
  const fromBoxBtn = $<HTMLButtonElement>("dv-frombox");
  fromBoxBtn.disabled = !boxSize;
  fromBoxBtn.title = t(boxSize ? "div.fromBoxTip" : "div.fromBoxNone");

  const read = (): DividerOptions => {
    const n = (id: string, d: number, min: number, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    const milling = $<HTMLSelectElement>("dv-by").value === "mill";
    return {
      width: n("dv-w", 0, 0, 5000), depth: n("dv-d", 0, 0, 5000), height: n("dv-h", 0, 0, 2000),
      outside: $<HTMLSelectElement>("dv-size").value === "out", wall: n("dv-wall", 0, 0, 200), thickness: n("dv-t", 0, 0, 100),
      cols: Math.round(n("dv-c", 1, 1, 100)), rows: Math.round(n("dv-r", 1, 1, 100)), colSizes: $("dv-cs").value, rowSizes: $("dv-rs").value,
      clearance: n("dv-cl", 0, 0, 5), gap: n("dv-gap", 0, 0, 20), kerf: milling ? 0 : n("dv-k", 0, 0, 5), tool: milling ? n("dv-tool", 0, 0, 50) : 0,
      relief: $<HTMLSelectElement>("dv-rel").value as Relief, dividerHeight: n("dv-dh", 0, 0, 2000), outer: $<HTMLSelectElement>("dv-outer").value as DividerOuter,
    };
  };
  const show = (sel: string, on: boolean) => ov.querySelectorAll<HTMLElement>(sel).forEach(el => { el.style.display = on ? "" : "none"; });

  let last: DividerResult | null = null;
  const update = () => {
    const o = read();
    show(".dv-wall-row", o.outside && o.outer === "none");
    show(".dv-gap-row", o.outer === "none");
    const milling = $<HTMLSelectElement>("dv-by").value === "mill";
    show(".dv-laser", !milling);
    show(".dv-mill", milling);
    $("dv-c").disabled = o.colSizes.trim() !== "";
    $("dv-r").disabled = o.rowSizes.trim() !== "";
    const r = divider(o);
    last = r;
    const bed = bedSizeMm();
    const blocked = r.errors.length > 0;
    $<HTMLButtonElement>("dv-ok").disabled = blocked;
    const svg = $<HTMLElement>("dv-svg"), info = $<HTMLElement>("dv-info"), warnEl = $<HTMLElement>("dv-warn");
    if (blocked) {
      svg.innerHTML = "";
      info.innerHTML = "";
      warnEl.innerHTML = r.errors.map(e => `<div>${msg(e)}</div>`).join("");
      return;
    }
    svg.innerHTML = previewSvg(r, o, bed.w);
    const L = layoutParts(r.parts, bed.w, gapFor(o));
    const uniform = o.colSizes.trim() === "" && o.rowSizes.trim() === "";
    const cells = uniform ? t("div.infoCell", { w: f(r.colSizes[0]), d: f(r.rowSizes[0]) }) : t("div.infoCells", { n: r.colSizes.length * r.rowSizes.length });
    info.innerHTML = `<div>${t("div.info", { n: r.parts.length, h: f(r.partH), s: f(r.slotDepth), w: f(L.w, 0), d: f(L.h, 0) })} · ${cells}</div>`
      + `<div>${t("div.how")}</div>`;
    const warn = r.warnings.map(msg);
    if (L.w > bed.w + 1e-6 || L.h > bed.h + 1e-6) warn.push(t("div.warnBed", { w: f(bed.w, 0), h: f(bed.h, 0) }));
    warnEl.innerHTML = warn.map(s => `<div>${s}</div>`).join("");
  };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener(i.tagName === "SELECT" ? "change" : "input", update));
  fromBoxBtn.onclick = () => {
    if (!boxSize) return;
    $("dv-w").value = f(boxSize.width, 2);
    $("dv-d").value = f(boxSize.depth, 2);
    $("dv-h").value = f(boxSize.height, 2);
    $("dv-t").value = f(boxSize.thickness, 2);
    $<HTMLSelectElement>("dv-size").value = "in";
    update();
  };
  update();

  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("dv-cancel").onclick = close;
  $<HTMLElement>("dv-ok").onclick = () => {
    update();
    const r = last;
    if (!r || r.errors.length) return;
    const o = read();
    saveSettings(KEY, o);
    close();
    placeParts(r, o);
    log(t("div.done", { n: r.parts.length }));
    done();
  };
}

/** Teile in Reihen (Bettbreite), zusammen mittig – passt es nicht, ab der linken unteren Ecke */
function placeParts(r: DividerResult, o: DividerOptions) {
  const st = app();
  const bed = bedSizeMm();
  const L = layoutParts(r.parts, bed.w, gapFor(o));
  const ox = Math.max(0, (bed.w - L.w) / 2), oy = Math.max(0, (bed.h - L.h) / 2);
  const cutL = getLayers().filter(l => l.mode === "line").sort((a, c) => c.power - a.power)[0];
  const made: any[] = [];
  r.parts.forEach((p, i) => {
    const [ax, ay] = L.at[i];
    const px: MultiPolygon = p.area.map(poly => poly.map(rg => rg.map(([x, y]) => [(x + ax + ox) * MM_TO_PIXEL, (y + ay + oy) * MM_TO_PIXEL] as [number, number])));
    const groupId = "divider-" + newId(), source = t("div.part." + p.kind).slice(0, 40);
    made.push(...toShapes(px, cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId, source })));
  });
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}
