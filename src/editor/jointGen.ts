/**
 * HOLZVERBINDUNGEN – Fenster (Generatoren): Fingerzinken (Ecke) oder Schwalbenschwanz (Platten Stoß an Stoß).
 * Fräser-Ø kommt vom aktiven Werkzeug (Fräse) bzw. 0 (Laser). Vorschau zeigt beide Teile ineinander, „Aufs Bett“ legt
 * sie mit 10 mm Abstand nebeneinander (je eine Gruppe). Geometrie: joints.ts.
 */
import type { MultiPolygon } from "polygon-clipping";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, newId } from "../shapeTransform";
import { toShapes } from "./shapeOps";
import { getLayers } from "../laserLayers";
import { getMachineMode } from "../machineMode";
import { toolForShape } from "../toolLibrary";
import { t } from "../i18n/i18n";
import { joint, JOINT_KINDS, RELIEFS, type JointOptions, type JointResult, type JointKind, type Relief } from "../joints";

const KEY = "cnc_craft_joint";
const DEF: JointOptions = { kind: "finger", width: 100, thickness: 12, count: 5, lengthA: 80, lengthB: 80, tool: 6, clearance: 0.1,
  relief: "dogbone", angle: 10, depth: 15 };
const NUMS = ["width", "thickness", "count", "lengthA", "lengthB", "clearance", "angle", "depth"] as const;

function load(): JointOptions {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: JointOptions = { ...DEF };
    for (const k of NUMS) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    if (JOINT_KINDS.includes(s.kind)) o.kind = s.kind;
    if (RELIEFS.includes(s.relief)) o.relief = s.relief;
    return o;
  } catch { return { ...DEF }; }
}

const f = (v: number, n = 2) => String(Number(v.toFixed(n)));
const bbox = (m: MultiPolygon) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of m) for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
};

function previewSvg(r: JointResult): string {
  const ba = bbox(r.a), bb = bbox(r.b);
  const x0 = Math.min(ba.x0, bb.x0), x1 = Math.max(ba.x1, bb.x1), y0 = Math.min(ba.y0, bb.y0), y1 = Math.max(ba.y1, bb.y1);
  if (!isFinite(x0)) return "";
  const pad = Math.max(x1 - x0, y1 - y0) * 0.04 + 1;
  const xy = (x: number, y: number) => `${(x - x0 + pad).toFixed(2)},${(y1 - y + pad).toFixed(2)}`;
  const d = (m: MultiPolygon) => m.map(poly => poly.map(rg => rg.map(([x, y], i) => `${i ? "L" : "M"}${xy(x, y)}`).join("") + "Z").join("")).join("");
  const sw = Math.max(x1 - x0, y1 - y0) / 400;
  return `<svg viewBox="0 0 ${(x1 - x0 + 2 * pad).toFixed(2)} ${(y1 - y0 + 2 * pad).toFixed(2)}" style="width:100%;height:280px;">
    <path d="${d(r.a)}" fill="#c98a4b" fill-rule="evenodd" stroke="#ffd28a" stroke-width="${sw.toFixed(2)}"/>
    <path d="${d(r.b)}" fill="#6f9fd8" fill-rule="evenodd" stroke="#bcd8ff" stroke-width="${sw.toFixed(2)}"/></svg>`;
}

export function openJointDialog(log: (s: string) => void, done: () => void) {
  const init = load();
  const mill = getMachineMode() === "mill";
  const tool = mill ? toolForShape(null) : null;
  init.tool = tool && tool.diameter > 0 ? tool.diameter : 0;
  document.getElementById("joint-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "joint-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, step: string, min: string, unit = "mm") =>
    `<label class="dlg-row"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="${min}" step="${step}"><em>${unit}</em></span></label>`;
  const sel = (id: string, key: string, opts: [string, string][]) =>
    `<label class="dlg-row"><span>${t(key)}</span><select id="${id}" style="width:auto;max-width:190px;">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(780px, calc(100vw - 32px));">
      <h3>🪵 ${t("joint.title")}</h3>
      <div class="dlg-hint">${t("joint.desc")}</div>
      <div style="display:grid;grid-template-columns:300px 1fr;gap:12px;align-items:start;">
        <div class="box-fields">
          ${sel("jt-kind", "joint.kind", JOINT_KINDS.map(k => [k, t("joint.kind." + k)]))}
          ${num("jt-w", "joint.width", "1", "10")}
          ${num("jt-t", "joint.thickness", "0.5", "1")}
          ${num("jt-n", "joint.count", "1", "1", "")}
          ${num("jt-la", "joint.lengthA", "1", "5")}
          ${num("jt-lb", "joint.lengthB", "1", "5")}
          ${num("jt-tool", "joint.tool", "0.1", "0")}
          ${num("jt-cl", "joint.clearance", "0.05", "0")}
          <div class="jt-k-finger">${sel("jt-rel", "joint.relief", RELIEFS.map(k => [k, t("joint.relief." + k)]))}</div>
          <div class="jt-k-dovetail">
            ${num("jt-ang", "joint.angle", "0.5", "3", "°")}
            ${num("jt-dep", "joint.depth", "0.5", "2")}
          </div>
        </div>
        <div class="box-prev" style="min-height:300px;"><div id="jt-svg" style="flex:1;display:flex;align-items:center;"></div>
          <div id="jt-info" class="dlg-hint"></div><div id="jt-warn" class="dlg-hint" style="color:var(--lt-amber, #ffb454);"></div></div>
      </div>
      <div class="dlg-buttons">
        <button id="jt-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="jt-ok" class="btn-primary">✔ ${t("joint.place")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const ids: [string, keyof JointOptions][] = [["jt-w", "width"], ["jt-t", "thickness"], ["jt-n", "count"], ["jt-la", "lengthA"], ["jt-lb", "lengthB"],
    ["jt-tool", "tool"], ["jt-cl", "clearance"], ["jt-ang", "angle"], ["jt-dep", "depth"]];
  for (const [id, k] of ids) $(id).value = String(init[k]);
  $<HTMLSelectElement>("jt-kind").value = init.kind;
  $<HTMLSelectElement>("jt-rel").value = init.relief;

  const read = (): JointOptions => {
    const n = (id: string, d: number, min: number, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    return {
      kind: $<HTMLSelectElement>("jt-kind").value as JointKind, relief: $<HTMLSelectElement>("jt-rel").value as Relief,
      width: n("jt-w", DEF.width, 10, 3000), thickness: n("jt-t", DEF.thickness, 1, 200), count: Math.round(n("jt-n", DEF.count, 1, 101)),
      lengthA: n("jt-la", DEF.lengthA, 5, 3000), lengthB: n("jt-lb", DEF.lengthB, 5, 3000), tool: n("jt-tool", 0, 0, 50),
      clearance: n("jt-cl", DEF.clearance, 0, 5), angle: n("jt-ang", DEF.angle, 3, 30), depth: n("jt-dep", DEF.depth, 2, 500)
    };
  };

  let last: JointResult | null = null;
  const update = () => {
    const o = read();
    for (const k of JOINT_KINDS) ov.querySelectorAll<HTMLElement>(".jt-k-" + k).forEach(el => { el.style.display = k === o.kind ? "" : "none"; });
    const r = joint(o);
    last = r;
    $<HTMLElement>("jt-svg").innerHTML = previewSvg(r);
    const info = o.kind === "finger"
      ? t("joint.infoFinger", { n: r.segments, s: f(o.width / r.segments), b: r.bones })
      : t("joint.infoDove", { n: r.segments });
    $<HTMLElement>("jt-info").innerHTML = `<div>${info}</div><div>${t(o.kind === "finger" ? "joint.howFinger" : "joint.howDove")}</div>`;
    $<HTMLElement>("jt-warn").innerHTML = r.warnings.map(w => `<div>${t(w)}</div>`).join("");
    $<HTMLButtonElement>("jt-ok").disabled = !r.a.length || !r.b.length;
  };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener(i.tagName === "SELECT" ? "change" : "input", update));
  update();

  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("jt-cancel").onclick = close;
  $<HTMLElement>("jt-ok").onclick = () => {
    update();
    const r = last;
    if (!r || !r.a.length || !r.b.length) return;
    const o = read();
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* egal */ }
    close();
    placeJoint(r, t("joint.kind." + o.kind));
    log(t("joint.done", { what: t("joint.kind." + o.kind) }));
    done();
  };
}

/** Teil A links, Teil B rechts mit 10 mm Abstand, zusammen in der Bettmitte */
function placeJoint(r: JointResult, name: string) {
  const st = app();
  const bed = bedSizeMm();
  const ba = bbox(r.a), bb = bbox(r.b), gap = 10;
  const shiftB = ba.x1 + gap - bb.x0;
  const total = ba.x1 - ba.x0 + gap + bb.x1 - bb.x0;
  const dx = bed.w / 2 - total / 2 - ba.x0, dy = bed.h / 2 - (Math.min(ba.y0, bb.y0) + Math.max(ba.y1, bb.y1)) / 2;
  const cutL = getLayers().filter(l => l.mode === "line").sort((a, c) => c.power - a.power)[0];
  const made: any[] = [];
  for (const [m, sx, tag] of [[r.a, 0, "A"], [r.b, shiftB, "B"]] as const) {
    const px: MultiPolygon = m.map(poly => poly.map(rg => rg.map(([x, y]) => [(x + sx + dx) * MM_TO_PIXEL, (y + dy) * MM_TO_PIXEL] as [number, number])));
    const groupId = "joint-" + newId(), source = `${name} ${tag}`.slice(0, 40);
    made.push(...toShapes(px, cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId, source })));
  }
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}
