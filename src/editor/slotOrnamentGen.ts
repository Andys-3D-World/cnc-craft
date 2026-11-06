/**
 * 3D-STECKANHÄNGER – Fenster (Generatoren): Form, Größe, Materialstärke (Schlitz), Verzierung, Zierlinie.
 * Vorschau beider Teile; „Aufs Bett“ legt sie nebeneinander (jedes eine Gruppe). Geometrie: slotOrnament.ts.
 */
import { icon } from "../ui/icons";
import { loadSettings, saveSettings } from "./genRun";
import type { MultiPolygon } from "polygon-clipping";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, newId, createPolyline } from "../shapeTransform";
import { toShapes } from "./shapeOps";
import { getLayers } from "../laserLayers";
import { t } from "../i18n/i18n";
import { bounds, type ScoreLine } from "../nameConnect";
import { ORNAMENT_DECOS, type OrnamentDeco, type OrnamentHanger } from "../ornament";
import { themeList, type Theme } from "../themes";
import { themeSelectHtml, fillSelect, isTheme } from "./themePicker";
import { slotOrnament, SLOT_SHAPES, type SlotOrnamentOptions, type SlotResult, type SlotShape } from "../slotOrnament";

const KEY = "cnc_craft_slotornament";
type Opts = SlotOrnamentOptions & { theme: Theme };
const DEF: Opts = { theme: "christmas", shape: "snowflake", size: 90, points: 6, t: 3, clear: 0.1, hanger: "hole", holeD: 3, deco: "stars", border: true };
const HANGERS: OrnamentHanger[] = ["hole", "ring"];

/** Formen eines Themas, die sich stecken lassen (sonst alle) */
const shapesOf = (th: Theme) => { const l = themeList(th, "shapes").filter(s => (SLOT_SHAPES as string[]).includes(s)); return l.length ? l : SLOT_SHAPES; };

function load(): Opts {
  try {
    const s = JSON.parse(loadSettings(KEY) || "{}");
    const o: Opts = { ...DEF };
    if (isTheme(s.theme)) o.theme = s.theme;
    for (const k of ["size", "points", "t", "clear", "holeD"] as const) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    if (typeof s.border === "boolean") o.border = s.border;
    if (SLOT_SHAPES.includes(s.shape)) o.shape = s.shape;
    if (HANGERS.includes(s.hanger)) o.hanger = s.hanger;
    if (ORNAMENT_DECOS.includes(s.deco)) o.deco = s.deco;
    return o;
  } catch { return { ...DEF }; }
}

/** Vorschau: Teil A links, Teil B rechts */
function previewSvg(r: SlotResult): string {
  const ba = bounds(r.a.cut), bb = bounds(r.b.cut), gap = r.w * 0.12;
  const dxB = ba.x1 + gap - bb.x0, y1 = Math.max(ba.y1, bb.y1), y0 = Math.min(ba.y0, bb.y0);
  const W = ba.x1 - ba.x0 + gap + (bb.x1 - bb.x0), H = y1 - y0, sw = (Math.max(W, H) / 350).toFixed(2);
  const tf = (x: number, y: number) => `${(x - ba.x0 + 2).toFixed(2)},${(y1 - y + 2).toFixed(2)}`;
  const d = (m: MultiPolygon, dx: number) => m.map(p => p.map(rg => rg.map(([x, y], i) => `${i ? "L" : "M"}${tf(x + dx, y)}`).join("") + "Z").join("")).join("");
  const ln = (ls: ScoreLine[], dx: number) => ls.map(l => l.pts.map(([x, y], i) => `${i ? "L" : "M"}${tf(x + dx, y)}`).join("") + (l.closed ? "Z" : "")).join("");
  const part = (c: MultiPolygon, ls: ScoreLine[], dx: number) =>
    `<path d="${d(c, dx)}" fill="#c98a4b" fill-rule="evenodd" stroke="#ffd28a" stroke-width="${sw}"/><path d="${ln(ls, dx)}" fill="none" stroke="#5a3a1c" stroke-width="${sw}"/>`;
  return `<svg viewBox="0 0 ${(W + 4).toFixed(1)} ${(H + 4).toFixed(1)}" style="width:100%;max-height:300px;">${part(r.a.cut, r.a.lines, 0)}${part(r.b.cut, r.b.lines, dxB)}</svg>`;
}

export function openSlotOrnamentDialog(log: (s: string) => void, done: () => void) {
  const o = load();
  document.getElementById("slot-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "slot-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, v: number, step = "1", min = "0") =>
    `<label class="prop-row">${t(key)}<input id="${id}" type="number" step="${step}" min="${min}" value="${v}" class="prop-input"></label>`;
  const sel = (id: string, key: string, list: string[], prefix: string) =>
    `<label class="prop-row">${t(key)}<select id="${id}" class="prop-input" style="width:auto;">${list.map(k => `<option value="${k}">${t(prefix + k)}</option>`).join("")}</select></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:620px;">
      <h3>${icon("slotOrnament", 20)}${t("so.title")}</h3>
      <div class="dlg-hint">${t("so.desc")}</div>
      <div class="box-grid">
        <div class="box-fields">
          ${themeSelectHtml("so-theme", "prop-row")}
          ${sel("so-shape", "orn.shape", SLOT_SHAPES, "orn.shape.")}
          <div class="so-only-star">${num("so-pts", "orn.points", o.points, "1", "5")}</div>
          ${num("so-size", "so.size", o.size, "1", "20")}
          ${num("so-t", "box.t", o.t, "0.1", "0.5")}
          ${num("so-clear", "so.clear", o.clear, "0.05", "0")}
          ${sel("so-hang", "orn.hanger", HANGERS, "orn.hang.")}
          ${num("so-hd", "orn.holeD", o.holeD, "0.5", "1")}
          ${sel("so-deco", "orn.deco", ORNAMENT_DECOS, "orn.deco.")}
          <label class="prop-row" style="cursor:pointer;"><span>${t("orn.border")}</span><input id="so-border" type="checkbox" ${o.border ? "checked" : ""} style="width:auto;"></label>
        </div>
        <div class="box-prev"><div id="so-svg" style="flex:1;display:flex;align-items:center;"></div><div id="so-info" class="dlg-hint"></div></div>
      </div>
      <div class="dlg-hint">${t("so.hint")}</div>
      <div class="dlg-buttons">
        <button id="so-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="so-ok" class="btn-primary">✔ ${t("so.create")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  $<HTMLSelectElement>("so-hang").value = o.hanger;
  const applyTheme = (th: Theme, keep: Partial<Opts> = {}) => {
    fillSelect($<HTMLSelectElement>("so-shape"), shapesOf(th), "orn.shape.", keep.shape);
    fillSelect($<HTMLSelectElement>("so-deco"), ["none", ...themeList(th, "decos")], "orn.deco.", keep.deco);
  };
  $<HTMLSelectElement>("so-theme").value = o.theme;
  applyTheme(o.theme, o);
  $<HTMLSelectElement>("so-theme").addEventListener("change", () => applyTheme($<HTMLSelectElement>("so-theme").value as Theme));

  const read = (): Opts => {
    const n = (id: string, d: number, min: number, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    return { theme: $<HTMLSelectElement>("so-theme").value as Theme, shape: $<HTMLSelectElement>("so-shape").value as SlotShape, points: Math.round(n("so-pts", o.points, 5, 12)), size: n("so-size", o.size, 20, 1000),
      t: n("so-t", o.t, 0.5, 20), clear: n("so-clear", o.clear, 0, 2), hanger: $<HTMLSelectElement>("so-hang").value as OrnamentHanger,
      holeD: n("so-hd", o.holeD, 1, 20), deco: $<HTMLSelectElement>("so-deco").value as OrnamentDeco, border: $("so-border").checked };
  };
  let timer = 0;
  const preview = () => {
    const p = read();
    ov.querySelectorAll<HTMLElement>(".so-only-star").forEach(el => { el.style.display = p.shape === "star" ? "" : "none"; });
    const r = slotOrnament(p);
    $<HTMLElement>("so-svg").innerHTML = previewSvg(r);
    $<HTMLElement>("so-info").textContent = t("so.info", { w: r.w.toFixed(1), h: r.h.toFixed(1), s: r.slotW.toFixed(2) });
    $<HTMLButtonElement>("so-ok").disabled = r.a.cut.length !== 1 || r.b.cut.length !== 1;
  };
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(preview, 150); };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener(i.tagName === "SELECT" || (i as HTMLInputElement).type === "checkbox" ? "change" : "input", schedule));
  preview();

  const close = () => { clearTimeout(timer); ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") $<HTMLElement>("so-ok").click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("so-cancel").onclick = close;
  $<HTMLElement>("so-ok").onclick = () => {
    const p = read();
    saveSettings(KEY, p);
    close();
    place(slotOrnament(p));
    log(t("so.done"));
    done();
  };
}

/** Beide Teile nebeneinander in die Bettmitte; Schnitt stärkste, Zierlinie schwächste Linien-Ebene */
function place(r: SlotResult) {
  const st = app(), bed = bedSizeMm(), layers = getLayers();
  const cutL = layers.filter(l => l.mode === "line").sort((a, c) => c.power - a.power)[0];
  const markL = layers.filter(l => l.mode === "line").sort((a, c) => a.power - c.power)[0];
  const source = t("so.title"), made: any[] = [];
  const ba = bounds(r.a.cut), bb = bounds(r.b.cut), gap = 6;
  const total = ba.x1 - ba.x0 + gap + (bb.x1 - bb.x0), x0 = bed.w / 2 - total / 2;
  const put = (pc: { cut: MultiPolygon; lines: ScoreLine[] }, dx: number, dy: number) => {
    const groupId = "slotorn-" + newId();
    made.push(...toShapes(pc.cut.map(p => p.map(rg => rg.map(([x, y]) => [(x + dx) * MM_TO_PIXEL, (y + dy) * MM_TO_PIXEL] as [number, number]))),
      cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId, source })));
    for (const l of pc.lines) made.push(createPolyline(l.pts.map(([x, y]) => ({ x: (x + dx) * MM_TO_PIXEL, y: (y + dy) * MM_TO_PIXEL })), l.closed, "on-line",
      { ...(markL ? { laserLayerId: markL.id } : {}), millingDepth: -0.3, isScore: true, groupId, source }));
  };
  put(r.a, x0 - ba.x0, bed.h / 2 - (ba.y0 + ba.y1) / 2);
  put(r.b, x0 + (ba.x1 - ba.x0) + gap - bb.x0, bed.h / 2 - (ba.y0 + ba.y1) / 2);
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}
