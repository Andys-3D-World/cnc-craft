/**
 * FLEX-SCHARNIER – Fenster (Generatoren): Muster, Platte, Scharnier-Zone, Abstand/Schnitt/Steg, Vorschlag aus der
 * Materialdicke. „Aufs Bett“ legt Platte und Schnitte als eine Gruppe in die Bettmitte. Geometrie: livingHinge.ts.
 */
import { loadSettings, saveSettings } from "./genRun";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, newId, createPolyline } from "../shapeTransform";
import { getLayers } from "../laserLayers";
import { getMachineMode } from "../machineMode";
import { toolForShape } from "../toolLibrary";
import { t } from "../i18n/i18n";
import { livingHinge, suggestForThickness, HINGE_PATTERNS, type HingeOptions, type HingeResult, type HingePattern, type XY } from "../livingHinge";

const KEY = "cnc_craft_hinge";
const DEF: HingeOptions = { pattern: "lines", width: 200, height: 100, panel: true, length: 60, spacing: 1.8, cut: 18, bridge: 3,
  amplitude: 0.9, slotWidth: 0.8, thickness: 3 };
const NUMS = ["width", "height", "length", "spacing", "cut", "bridge", "amplitude", "slotWidth", "thickness"] as const;

function load(): HingeOptions {
  try {
    const s = JSON.parse(loadSettings(KEY) || "{}");
    const o: HingeOptions = { ...DEF };
    for (const k of NUMS) if (Number.isFinite(Number(s[k])) && Number(s[k]) > 0) o[k] = Number(s[k]);
    if (typeof s.panel === "boolean") o.panel = s.panel;
    if (HINGE_PATTERNS.includes(s.pattern)) o.pattern = s.pattern;
    return o;
  } catch { return { ...DEF }; }
}

const f = (v: number, n = 1) => String(Number(v.toFixed(n)));

function previewSvg(r: HingeResult, o: HingeOptions): string {
  const W = o.width, H = o.height, pad = Math.max(W, H) * 0.04 + 1;
  const xy = ([x, y]: XY) => `${(x + pad).toFixed(2)},${(H - y + pad).toFixed(2)}`;
  const sw = Math.max(W, H) / 500;
  const lines = r.lines.map(l => l.pts.map((p, i) => `${i ? "L" : "M"}${xy(p)}`).join("") + (l.closed ? "Z" : "")).join("");
  const zone = `<rect x="${(r.x0 + pad).toFixed(2)}" y="${pad.toFixed(2)}" width="${(r.x1 - r.x0).toFixed(2)}" height="${H.toFixed(2)}" fill="#ffffff10"/>`;
  const panel = r.outline ? `<path d="${r.outline.map((p, i) => `${i ? "L" : "M"}${xy(p)}`).join("")}Z" fill="#c98a4b" stroke="#ffd28a" stroke-width="${sw.toFixed(2)}"/>`
    : `<rect x="${pad.toFixed(2)}" y="${pad.toFixed(2)}" width="${W.toFixed(2)}" height="${H.toFixed(2)}" fill="none" stroke="#ffffff44" stroke-width="${sw.toFixed(2)}" stroke-dasharray="${(sw * 6).toFixed(2)}"/>`;
  return `<svg viewBox="0 0 ${(W + 2 * pad).toFixed(2)} ${(H + 2 * pad).toFixed(2)}" style="width:100%;height:280px;">${panel}${zone}
    <path d="${lines}" fill="none" stroke="#3a2412" stroke-width="${(sw * 1.2).toFixed(2)}" stroke-linecap="round"/></svg>`;
}

export function openHingeDialog(log: (s: string) => void, done: () => void) {
  const init = load();
  document.getElementById("hinge-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "hinge-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, step: string, min: string, unit = "mm") =>
    `<label class="dlg-row"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="${min}" step="${step}"><em>${unit}</em></span></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(780px, calc(100vw - 32px));">
      <h3>〰 ${t("hinge.title")}</h3>
      <div class="dlg-hint">${t("hinge.desc")}</div>
      <div style="display:grid;grid-template-columns:300px 1fr;gap:12px;align-items:start;">
        <div class="box-fields">
          <label class="dlg-row"><span>${t("hinge.pattern")}</span><select id="hg-pat" style="width:auto;max-width:190px;">${HINGE_PATTERNS.map(v => `<option value="${v}">${t("hinge.pattern." + v)}</option>`).join("")}</select></label>
          <label class="dlg-row" style="cursor:pointer;"><span>${t("hinge.panel")}</span><input id="hg-panel" type="checkbox" style="width:auto;"></label>
          ${num("hg-w", "hinge.width", "1", "10")}
          ${num("hg-h", "hinge.height", "1", "10")}
          ${num("hg-len", "hinge.length", "1", "2")}
          ${num("hg-t", "hinge.thickness", "0.1", "0.3")}
          <div class="dlg-row"><span></span><button id="hg-suggest" class="btn-secondary" style="width:auto;">${t("hinge.suggest")}</button></div>
          ${num("hg-s", "hinge.spacing", "0.1", "0.3")}
          ${num("hg-c", "hinge.cut", "0.5", "2")}
          ${num("hg-b", "hinge.bridge", "0.1", "0.3")}
          <div class="hg-only-wave">${num("hg-a", "hinge.amplitude", "0.1", "0.1")}</div>
          <div class="hg-only-slots">${num("hg-sw", "hinge.slotWidth", "0.05", "0.1")}</div>
        </div>
        <div class="box-prev" style="min-height:300px;"><div id="hg-svg" style="flex:1;display:flex;align-items:center;"></div>
          <div id="hg-info" class="dlg-hint"></div><div id="hg-warn" class="dlg-hint" style="color:var(--lt-amber, #ffb454);"></div></div>
      </div>
      <div class="dlg-buttons">
        <button id="hg-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="hg-ok" class="btn-primary">✔ ${t("hinge.place")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const ids: [string, (typeof NUMS)[number]][] = [["hg-w", "width"], ["hg-h", "height"], ["hg-len", "length"], ["hg-s", "spacing"],
    ["hg-c", "cut"], ["hg-b", "bridge"], ["hg-a", "amplitude"], ["hg-sw", "slotWidth"], ["hg-t", "thickness"]];
  for (const [id, k] of ids) $(id).value = String(init[k]);
  $<HTMLSelectElement>("hg-pat").value = init.pattern;
  $("hg-panel").checked = init.panel;

  const read = (): HingeOptions => {
    const n = (id: string, d: number, min: number, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    return {
      pattern: $<HTMLSelectElement>("hg-pat").value as HingePattern, panel: $("hg-panel").checked,
      width: n("hg-w", DEF.width, 10, 3000), height: n("hg-h", DEF.height, 10, 3000), length: n("hg-len", DEF.length, 2, 3000),
      spacing: n("hg-s", DEF.spacing, 0.3, 50), cut: n("hg-c", DEF.cut, 2, 1000), bridge: n("hg-b", DEF.bridge, 0.3, 100),
      amplitude: n("hg-a", DEF.amplitude, 0.1, 20), slotWidth: n("hg-sw", DEF.slotWidth, 0.1, 20), thickness: n("hg-t", DEF.thickness, 0.3, 50)
    };
  };

  let last: HingeResult | null = null;
  const update = () => {
    const o = read();
    ov.querySelectorAll<HTMLElement>(".hg-only-wave").forEach(el => { el.style.display = o.pattern === "wave" ? "" : "none"; });
    ov.querySelectorAll<HTMLElement>(".hg-only-slots").forEach(el => { el.style.display = o.pattern === "slots" ? "" : "none"; });
    const r = livingHinge(o);
    last = r;
    $<HTMLElement>("hg-svg").innerHTML = previewSvg(r, o);
    $<HTMLElement>("hg-info").innerHTML = [
      t("hinge.info", { n: r.columns, cuts: r.lines.length, len: f(r.cutLength / 1000, 2) }),
      t("hinge.bend", { r90: f(r.radius90), r180: f(r.radius180) })
    ].map(s => `<div>${s}</div>`).join("");
    const warn = r.warnings.map(w => t(w));
    if (getMachineMode() === "mill") {
      const tool = toolForShape(null);
      warn.push(t("hinge.millNote"));
      if (tool && o.spacing - tool.diameter < 1) warn.push(t("hinge.warnTool", { tool: f(tool.diameter, 2), s: f(o.spacing) }));
    }
    $<HTMLElement>("hg-warn").innerHTML = warn.map(s => `<div>${s}</div>`).join("");
    $<HTMLButtonElement>("hg-ok").disabled = !r.lines.length;
  };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener(i.tagName === "SELECT" || (i as HTMLInputElement).type === "checkbox" ? "change" : "input", update));
  $<HTMLElement>("hg-suggest").onclick = () => {
    const sg = suggestForThickness(read().thickness);
    $("hg-s").value = String(sg.spacing); $("hg-c").value = String(sg.cut); $("hg-b").value = String(sg.bridge);
    $("hg-a").value = String(sg.amplitude); $("hg-sw").value = String(sg.slotWidth);
    update();
  };
  update();

  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("hg-cancel").onclick = close;
  $<HTMLElement>("hg-ok").onclick = () => {
    update();
    const r = last;
    if (!r || !r.lines.length) return;
    const o = read();
    saveSettings(KEY, o);
    close();
    placeHinge(r, o);
    log(t("hinge.done", { n: r.lines.length, w: f(o.width), h: f(o.height) }));
    done();
  };
}

/** Platte + Schnitte als eine Gruppe in die Bettmitte, alles auf der stärksten Linien-Ebene (durchschneiden) */
function placeHinge(r: HingeResult, o: HingeOptions) {
  const st = app();
  const bed = bedSizeMm();
  const dx = bed.w / 2 - o.width / 2, dy = bed.h / 2 - o.height / 2;
  const px = (pts: XY[]) => pts.map(([x, y]) => ({ x: (x + dx) * MM_TO_PIXEL, y: (y + dy) * MM_TO_PIXEL }));
  const cutL = getLayers().filter(l => l.mode === "line").sort((a, c) => c.power - a.power)[0];
  const groupId = "hinge-" + newId(), source = t("hinge.title");
  const extra = { ...(cutL ? { laserLayerId: cutL.id } : {}), groupId, source };
  const made: any[] = [];
  // erst die Schnitte, dann der Umriss – das Teil fällt zuletzt heraus
  for (const l of r.lines) made.push(createPolyline(px(l.closed ? l.pts.slice(0, -1) : l.pts), l.closed, l.closed ? "inside" : "on-line", extra));
  if (r.outline) made.push(createPolyline(px(r.outline.slice(0, -1)), true, "outside", extra));
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}
