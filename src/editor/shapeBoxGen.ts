/**
 * FORMBOX – Fenster (Generatoren): Form wählen (Grundform, Saison, Buchstabe/Ziffer, eigene Form aus der Auswahl), Größe, Höhe, Wandart.
 * Vorschau 2D (alle Teile) und 3D (fertige Kiste). „Aufs Bett“ wie beim Box-Generator. Geometrie und Prüfungen: shapeBox.ts.
 */
import { icon } from "../ui/icons";
import type { MultiPolygon, Polygon } from "polygon-clipping";
import polygonClipping from "polygon-clipping";
import { loadSettings, saveSettings, matchDefaults } from "./genRun";
import { bedSizeMm } from "./editorState";
import { selectedShapes } from "./selection";
import { MM_TO_PIXEL, shapeToPaths } from "../shapeTransform";
import { traceTextWithFont } from "./textTool";
import { createFontPicker } from "./fontPicker";
import { getMachineMode } from "../machineMode";
import { t } from "../i18n/i18n";
import { Box3DView } from "./box3d";
import { panelsPreview, panelsToBed } from "./boxGen";
import { shapeBox, shapeOutline, sizedArea, packArea, unpackArea, shapeLabelKey, SHAPE_GROUPS, SHAPE_KINDS, WALL_KINDS, type ShapeBoxResult, type ShapeKind, type WallKind } from "../shapeBox";
import type { XY } from "../joints";

const KEY = "cnc_craft_shape_box";
const VIEW_KEY = "cnc_craft_box_view";
const DEF = { kind: "heart", w: 120, d: 100, keep: true, h: 60, t: 3, kerf: 0.1, finger: 10, rim: 3, bend: 9, tool: 0, wall: "flex", lid: true, points: 5,
  text: "A", font: "Open Sans", bold: true, custom: [] as number[][][] };
type Opts = typeof DEF;

function load(): Opts {
  let raw: any = {};
  try { raw = JSON.parse(loadSettings(KEY) || "{}"); } catch { /* egal */ }
  const o: Opts = { ...DEF, ...(getMachineMode() === "mill" ? { wall: "segments" } : {}), ...matchDefaults(DEF, raw) };
  if (!SHAPE_KINDS.includes(o.kind as ShapeKind)) o.kind = DEF.kind;
  if (!WALL_KINDS.includes(o.wall as WallKind)) o.wall = DEF.wall;
  for (const k of ["w", "d", "h", "t", "finger", "rim", "bend"] as const) if (!(o[k] > 0)) o[k] = DEF[k];
  for (const k of ["kerf", "tool"] as const) if (!(o[k] >= 0)) o[k] = DEF[k];
  o.text = o.text.slice(0, 2);
  return o;
}

/** Geschlossene Konturen der Auswahl als Fläche (gerade/ungerade) */
export function selectionArea(): MultiPolygon {
  const rings: Polygon[] = [];
  for (const s of selectedShapes()) for (const p of shapeToPaths(s)) {
    if (!p.closed || p.pts.length < 3) continue;
    const r = p.pts.map(q => [q.x / MM_TO_PIXEL, q.y / MM_TO_PIXEL] as XY);
    rings.push([[...r, r[0]]]);
  }
  if (!rings.length) return [];
  try { return rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1)); } catch { return []; }
}

export function openShapeBoxDialog(log: (s: string) => void, done: () => void) {
  const o = load();
  const fromSel = selectionArea();  // Beim Bearbeiten ist die Auswahl leer – dann gilt die gespeicherte eigene Form
  let font = o.font;
  document.getElementById("fbx-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "fbx-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, v: number, step = "1", min = "0", wrap = "") =>
    `<label class="prop-row ${wrap}">${t(key)}<input id="${id}" type="number" step="${step}" min="${min}" value="${v}" class="prop-input"></label>`;
  const groups = Object.entries(SHAPE_GROUPS).map(([g, list]) =>
    `<optgroup label="${t("fbx.group." + g)}">${list.map(k => `<option value="${k}">${t(shapeLabelKey(k))}</option>`).join("")}</optgroup>`).join("");
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:600px;">
      <h3>${icon("shapeBox", 20)}${t("fbx.title")}</h3>
      <div class="dlg-hint">${t("fbx.desc")}</div>
      <div class="box-grid">
        <div class="box-fields">
          <label class="prop-row">${t("fbx.shape")}<select id="fbx-kind" class="prop-input" style="width:auto;max-width:130px;">${groups}</select></label>
          <div class="fbx-x" data-for="star">${num("fbx-pts", "fbx.points", o.points, "1", "4")}</div>
          <div class="fbx-x" data-for="letter">
            <label class="prop-row">${t("fbx.letter")}<input id="fbx-text" maxlength="2" class="prop-input"></label>
            <div class="dlg-row"><div id="fbx-font"></div></div>
            <label class="prop-row" style="cursor:pointer;"><span>${t("text.bold")}</span><input id="fbx-bold" type="checkbox" ${o.bold ? "checked" : ""} style="width:auto;"></label>
          </div>
          <div class="fbx-x" data-for="custom">
            <button type="button" id="fbx-take" class="btn-secondary" ${fromSel.length ? "" : "disabled"}>${t("fbx.take")}</button>
            <div id="fbx-cinfo" class="dlg-hint"></div>
          </div>
          ${num("fbx-w", "fbx.w", o.w)}
          <label class="prop-row" style="cursor:pointer;"><span>${t("fbx.keep")}</span><input id="fbx-keep" type="checkbox" ${o.keep ? "checked" : ""} style="width:auto;"></label>
          <div id="fbx-dwrap">${num("fbx-d", "fbx.d", o.d)}</div>
          ${num("fbx-h", "fbx.h", o.h)}
          ${num("fbx-t", "box.t", o.t, "0.1", "0.5")}
          <label class="prop-row">${t("fbx.wall")}<select id="fbx-wall" class="prop-input" style="width:auto;">${WALL_KINDS.map(k => `<option value="${k}">${t("fbx.wall." + k)}</option>`).join("")}</select></label>
          <div class="fbx-w" data-for="flex">${num("fbx-bend", "fbx.bend", o.bend, "0.5", "2")}</div>
          <div class="fbx-w" data-for="segments">${num("fbx-tool", "box.tool", o.tool, "0.5", "0")}</div>
          <label class="prop-row" style="cursor:pointer;"><span>${t("fbx.lid")}</span><input id="fbx-lid" type="checkbox" ${o.lid ? "checked" : ""} style="width:auto;"></label>
          ${num("fbx-f", "fbx.finger", o.finger, "0.5", "1")}
          ${num("fbx-rim", "fbx.rim", o.rim, "0.5", "1")}
          ${num("fbx-kerf", "box.kerf", o.kerf, "0.01", "0")}
        </div>
        <div class="box-prev">
          <div class="box-view">
            <button type="button" class="btn-secondary" data-view="2d">${t("box.view.flat")}</button>
            <button type="button" class="btn-secondary" data-view="3d">🧊 ${t("box.view.3d")}</button>
          </div>
          <svg id="fbx-svg" viewBox="0 0 100 100"></svg>
          <canvas id="fbx-3d" class="box-3d" title="${t("box.view.hint")}"></canvas>
          <label class="prop-row box-3d-only">${t("box.view.explode")}<input id="fbx-explode" type="range" min="0" max="1" step="0.05" value="0" style="width:110px;"></label>
          <div id="fbx-info" class="dlg-hint"></div>
        </div>
      </div>
      <div id="fbx-note" class="dlg-hint"></div>
      <div class="dlg-buttons">
        <button id="fbx-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="fbx-ok" class="btn-primary">✔ ${t("box.create")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const view3d = new Box3DView($<HTMLCanvasElement>("fbx-3d"));
  let mode: "2d" | "3d" = "2d";
  try { if (localStorage.getItem(VIEW_KEY) === "3d") mode = "3d"; } catch { /* egal */ }
  $<HTMLSelectElement>("fbx-kind").value = o.kind;
  $<HTMLSelectElement>("fbx-wall").value = o.wall;
  $("fbx-text").value = o.text;
  let custom = o.custom;

  const read = (): Opts => {
    const n = (id: string, d: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v >= 0 ? v : d; };
    return { kind: $<HTMLSelectElement>("fbx-kind").value, w: n("fbx-w", o.w), d: n("fbx-d", o.d), keep: $("fbx-keep").checked, h: n("fbx-h", o.h), t: n("fbx-t", o.t),
      kerf: n("fbx-kerf", o.kerf), finger: n("fbx-f", o.finger), rim: n("fbx-rim", o.rim), bend: n("fbx-bend", o.bend), tool: n("fbx-tool", o.tool),
      wall: $<HTMLSelectElement>("fbx-wall").value, lid: $("fbx-lid").checked, points: Math.round(n("fbx-pts", o.points)),
      text: $("fbx-text").value.slice(0, 2), font, bold: $("fbx-bold").checked, custom };
  };

  /** Rohform der Eingabe (Buchstaben werden nachgezeichnet) */
  async function rawArea(b: Opts): Promise<MultiPolygon> {
    if (b.kind === "custom") return unpackArea(b.custom);
    if (b.kind !== "letter") return shapeOutline(b.kind as ShapeKind, b.points);
    const text = b.text.trim();
    if (!text) return [];
    const tr = (await traceTextWithFont({ text, font: b.font, heightMm: 100, bold: b.bold, italic: false, align: "center", lineSpacing: 140, letterSpacing: 0 })).traced;
    if (tr.closed?.some(c => !c)) return [];  // Einzellinien-Schrift hat keine Fläche
    const rings: Polygon[] = tr.loops.filter(l => l.length >= 3).map(l => { const r = l.map(p => [p.x, p.y] as XY); return [[...r, r[0]]]; });
    if (!rings.length) return [];
    return rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1));
  }

  let last: ShapeBoxResult | null = null, lastOpts: Opts = o, token = 0;
  async function preview() {
    const b = read(), my = ++token;
    ov.querySelectorAll<HTMLElement>(".fbx-x").forEach(el => { el.style.display = el.dataset.for === b.kind ? "" : "none"; });
    ov.querySelectorAll<HTMLElement>(".fbx-w").forEach(el => { el.style.display = el.dataset.for === b.wall ? "" : "none"; });
    $<HTMLElement>("fbx-dwrap").style.display = b.keep ? "none" : "";
    $<HTMLElement>("fbx-note").textContent = t("fbx.note." + b.wall) + " " + t("fbx.note.fit");
    if (b.kind === "custom") $<HTMLElement>("fbx-cinfo").textContent = b.custom.length ? t("fbx.customSet") : t("fbx.customNone");
    ov.querySelectorAll<HTMLElement>("[data-view]").forEach(el => el.classList.toggle("active", el.dataset.view === mode));
    const svg = $<HTMLElement>("fbx-svg") as unknown as SVGSVGElement, info = $<HTMLElement>("fbx-info"), okBtn = $<HTMLButtonElement>("fbx-ok");
    svg.style.display = mode === "2d" ? "" : "none";
    ov.querySelectorAll<HTMLElement>(".box-3d, .box-3d-only").forEach(el => { el.style.display = mode === "3d" ? "" : "none"; });
    let raw: MultiPolygon = [];
    try { raw = await rawArea(b); } catch { raw = []; }
    if (my !== token) return;  // inzwischen neue Eingabe
    const opt = { h: b.h, t: b.t, kerf: b.kerf, finger: b.finger, wall: b.wall as WallKind, lid: b.lid, rim: b.rim, bend: b.bend, tool: b.wall === "flex" ? 0 : b.tool };
    const area = raw.length ? sizedArea(raw, b.w, b.keep ? 0 : b.d) : [];
    const r = shapeBox({ ...opt, area });
    last = r; lastOpts = b;
    okBtn.disabled = !!r.error;
    if (r.error) { svg.innerHTML = ""; view3d.setPanels([], b.t, 0); info.textContent = t(r.error, { t: b.t }); return; }
    panelsPreview(svg, r.panels, Math.max(r.W, r.D) * 2.4);
    if (mode === "3d") view3d.setPanels(shapeBox({ ...opt, area, kerf: 0 }).panels, b.t, parseFloat($("fbx-explode").value) || 0);
    let txt = t("fbx.info", { n: r.panels.length, w: r.W.toFixed(1), d: r.D.toFixed(1), h: r.H.toFixed(1) });
    if (b.wall === "flex") txt += " · " + t("fbx.stripLen", { l: r.walls.map(w => w.length.toFixed(0)).join(" + ") });
    if (r.dropped) txt += " · " + t("fbx.warn.dropped", { n: r.dropped });
    const bed = bedSizeMm();
    if (r.longest > Math.max(bed.w, bed.h)) txt += " · ⚠ " + t("fbx.warn.bed", { l: r.longest.toFixed(0) });
    info.textContent = txt;
  }
  let tm = 0;
  const schedule = () => { clearTimeout(tm); tm = window.setTimeout(preview, 150); };
  createFontPicker($<HTMLElement>("fbx-font"), font, f => { font = f; schedule(); });
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener("input", schedule));
  $<HTMLElement>("fbx-take").onclick = () => { custom = packArea(sizedArea(fromSel, 100)); schedule(); };
  $<HTMLSelectElement>("fbx-kind").addEventListener("input", () => {
    if ($<HTMLSelectElement>("fbx-kind").value === "custom" && !custom.length && fromSel.length) custom = packArea(sizedArea(fromSel, 100));
  });
  ov.querySelectorAll<HTMLElement>("[data-view]").forEach(el => el.addEventListener("click", () => {
    mode = el.dataset.view === "3d" ? "3d" : "2d";
    try { localStorage.setItem(VIEW_KEY, mode); } catch { /* egal */ }
    schedule();
  }));
  preview();
  const close = () => { clearTimeout(tm); token++; ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("fbx-cancel").onclick = close;
  $<HTMLElement>("fbx-ok").onclick = () => {
    const r = last, b = lastOpts;
    if (!r || r.error) return;
    saveSettings(KEY, b);
    close();
    panelsToBed(r.panels, t("fbx.title"));
    log(t("box.done", { n: r.panels.length }));
    done();
  };
}
