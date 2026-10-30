/**
 * WEIHNACHTSSCHMUCK-GENERATOR – Fenster (Extras): Form wählen, Name (und zweite Zeile) eingeben, Vorschau mit Größe,
 * „Aufs Bett“ legt den Anhänger als Gruppe in die Bettmitte. Die Geometrie entsteht in ornament.ts.
 */
import type { MultiPolygon, Polygon } from "polygon-clipping";
import polygonClipping from "polygon-clipping";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, newId, createPolyline } from "../shapeTransform";
import { toShapes } from "./shapeOps";
import { traceTextWithFont, TracedText } from "./textTool";
import { createFontPicker } from "./fontPicker";
import { getLayers } from "../laserLayers";
import { t } from "../i18n/i18n";
import { bounds, union, type ScoreLine, type XY } from "../nameConnect";
import { ornament, ORNAMENT_SHAPES, type OrnamentOptions, type OrnamentResult, type OrnamentText, type OrnamentShape,
  type OrnamentHanger, type OrnamentInner } from "../ornament";

const KEY = "cnc_craft_ornament";
interface Opts extends OrnamentOptions { text: string; line2: string; font: string; bold: boolean }
const DEF: Opts = { shape: "ball", size: 80, points: 5, hanger: "hole", holeD: 4, inner: "engrave", textSize: 100, border: false,
  text: "Andreas", line2: "", font: "Pacifico", bold: false };
const HANGERS: OrnamentHanger[] = ["hole", "ring", "none"];
const INNERS: OrnamentInner[] = ["engrave", "cut", "score", "layer"];

function load(): Opts {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: Opts = { ...DEF };
    for (const k of ["size", "points", "holeD", "textSize"] as const) if (Number.isFinite(Number(s[k])) && Number(s[k]) > 0) o[k] = Number(s[k]);
    for (const k of ["text", "line2", "font"] as const) if (typeof s[k] === "string") o[k] = s[k].slice(0, 60);
    for (const k of ["bold", "border"] as const) if (typeof s[k] === "boolean") o[k] = s[k];
    if (ORNAMENT_SHAPES.includes(s.shape)) o.shape = s.shape;
    if (HANGERS.includes(s.hanger)) o.hanger = s.hanger;
    if (INNERS.includes(s.inner)) o.inner = s.inner;
    return o;
  } catch { return { ...DEF }; }
}

/** Schrift nachzeichnen: geschlossene Konturen als Fläche (Gerade/Ungerade), Einzellinien-Schrift als Linien */
async function traceName(o: Opts): Promise<OrnamentText> {
  const text = [o.text, o.line2].map(s => s.trim()).filter(Boolean).join("\n");
  if (!text) return { area: [], lines: [] };
  const tr: TracedText = (await traceTextWithFont({ text, font: o.font, heightMm: 10, bold: o.bold, italic: false, align: "center",
    lineSpacing: 140, letterSpacing: 0 })).traced;
  const loops = tr.loops.map(l => l.map(p => [p.x, p.y] as XY));
  if (tr.closed?.some(c => !c)) return { area: [], lines: loops.filter(l => l.length >= 2).map((pts, i) => ({ pts, closed: tr.closed?.[i] !== false })) };
  const rings: Polygon[] = loops.filter(l => l.length >= 3).map(l => [l]);
  if (!rings.length) return { area: [], lines: [] };
  return { area: rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1)), lines: [] };
}

function previewSvg(r: OrnamentResult): string {
  const b = bounds(union([r.cut, r.top]));
  if (!isFinite(b.x0)) return "";
  const pad = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.04 + 1;
  const xy = ([x, y]: XY | [number, number]) => `${(x - b.x0 + pad).toFixed(2)},${(b.y1 - y + pad).toFixed(2)}`;
  const d = (m: MultiPolygon) => m.map(poly => poly.map(rg => rg.map((q, i) => `${i ? "L" : "M"}${xy(q)}`).join("") + "Z").join("")).join("");
  const ln = (l: ScoreLine) => l.pts.map((q, i) => `${i ? "L" : "M"}${xy(q)}`).join("") + (l.closed ? "Z" : "");
  const sw = Math.max(b.x1 - b.x0, b.y1 - b.y0) / 400;
  return `<svg viewBox="0 0 ${(b.x1 - b.x0 + 2 * pad).toFixed(2)} ${(b.y1 - b.y0 + 2 * pad).toFixed(2)}" style="width:100%;height:260px;">
    <path d="${d(r.cut)}" fill="#c98a4b" fill-rule="evenodd" stroke="#ffd28a" stroke-width="${sw.toFixed(2)}"/>
    <path d="${d(r.engrave)}" fill="#5a3a1c" fill-rule="evenodd"/>
    <path d="${d(r.top)}" fill="#efdcb4" fill-rule="evenodd" stroke="#5a3a1c" stroke-width="${(sw * 1.5).toFixed(2)}"/>
    <path d="${r.lines.map(ln).join("")}" fill="none" stroke="#3ccf4e" stroke-width="${(sw * 1.6).toFixed(2)}" stroke-linecap="round"/></svg>`;
}

export function openOrnamentDialog(log: (s: string) => void, done: () => void) {
  const init = load();
  document.getElementById("orn-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "orn-dialog-overlay";
  ov.className = "dlg-overlay";
  const sel = (id: string, key: string, list: string[], prefix: string) =>
    `<label class="dlg-row"><span>${t(key)}</span><select id="${id}" style="width:auto;max-width:190px;">${list.map(v => `<option value="${v}">${t(prefix + v)}</option>`).join("")}</select></label>`;
  const num = (id: string, key: string, step: string, min: string, unit = "mm") =>
    `<label class="dlg-row"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="${min}" step="${step}"><em>${unit}</em></span></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(760px, calc(100vw - 32px));">
      <h3>🎄 ${t("orn.title")}</h3>
      <div class="dlg-hint">${t("orn.desc")}</div>
      <div style="display:grid;grid-template-columns:290px 1fr;gap:12px;align-items:start;">
        <div class="box-fields">
          ${sel("orn-shape", "orn.shape", ORNAMENT_SHAPES, "orn.shape.")}
          <div class="orn-only-star">${num("orn-pts", "orn.points", "1", "5", "")}</div>
          ${num("orn-size", "orn.size", "1", "20")}
          <label class="dlg-row"><span>${t("orn.text")}</span><input id="orn-text" type="text" maxlength="40" style="width:170px;"></label>
          <label class="dlg-row"><span>${t("orn.line2")}</span><input id="orn-line2" type="text" maxlength="40" style="width:170px;" placeholder="${t("orn.line2Ph")}"></label>
          <label class="dlg-row"><span>${t("text.font")}</span><div id="orn-font" style="width:170px;"></div></label>
          <label class="dlg-row" style="cursor:pointer;"><span>${t("text.bold")}</span><input id="orn-bold" type="checkbox" style="width:auto;"></label>
          ${num("orn-ts", "orn.textSize", "5", "20", "%")}
          ${sel("orn-inner", "orn.inner", INNERS, "orn.inner.")}
          ${sel("orn-hang", "orn.hanger", HANGERS, "orn.hang.")}
          <div class="orn-only-hole">${num("orn-hd", "orn.holeD", "0.5", "1")}</div>
          <label class="dlg-row" style="cursor:pointer;"><span>${t("orn.border")}</span><input id="orn-border" type="checkbox" style="width:auto;"></label>
        </div>
        <div class="box-prev" style="min-height:280px;"><div id="orn-svg" style="flex:1;display:flex;align-items:center;"></div>
          <div id="orn-info" class="dlg-hint"></div><div id="orn-warn" class="dlg-hint" style="color:#ffb454;"></div></div>
      </div>
      <div class="dlg-buttons">
        <button id="orn-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="orn-ok" class="btn-primary">✔ ${t("orn.place")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  let font = init.font;
  createFontPicker($<HTMLElement>("orn-font"), font, f => { font = f; schedule(); });
  // Werte per value setzen (der Name ist fremder Text – nie ins innerHTML)
  $<HTMLSelectElement>("orn-shape").value = init.shape;
  $("orn-pts").value = String(init.points); $("orn-size").value = String(init.size);
  $("orn-text").value = init.text; $("orn-line2").value = init.line2;
  $("orn-bold").checked = init.bold; $("orn-ts").value = String(init.textSize);
  $<HTMLSelectElement>("orn-inner").value = init.inner; $<HTMLSelectElement>("orn-hang").value = init.hanger;
  $("orn-hd").value = String(init.holeD); $("orn-border").checked = init.border;

  const read = (): Opts => {
    const n = (id: string, d: number, min: number, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    const v = (id: string) => $<HTMLSelectElement>(id).value;
    return {
      shape: v("orn-shape") as OrnamentShape, points: Math.round(n("orn-pts", DEF.points, 5, 12)), size: n("orn-size", DEF.size, 20, 1000),
      text: $("orn-text").value, line2: $("orn-line2").value, font, bold: $("orn-bold").checked,
      textSize: n("orn-ts", 100, 20, 100), inner: v("orn-inner") as OrnamentInner, hanger: v("orn-hang") as OrnamentHanger,
      holeD: n("orn-hd", DEF.holeD, 1, 30), border: $("orn-border").checked
    };
  };

  let last: OrnamentResult | null = null, run = 0, timer = 0;
  const update = async () => {
    const o = read(), my = ++run;
    ov.querySelectorAll<HTMLElement>(".orn-only-star").forEach(el => { el.style.display = o.shape === "star" ? "" : "none"; });
    ov.querySelectorAll<HTMLElement>(".orn-only-hole").forEach(el => { el.style.display = o.hanger !== "none" ? "" : "none"; });
    const text = await traceName(o);
    if (my !== run) return; // inzwischen neu eingegeben
    const r = ornament(o, text);
    last = r;
    $<HTMLElement>("orn-svg").innerHTML = previewSvg(r);
    $<HTMLElement>("orn-info").textContent = t("orn.info", { w: r.w.toFixed(1), h: r.h.toFixed(1) });
    $<HTMLElement>("orn-warn").textContent = text.lines.length && o.inner !== "score" ? t("orn.openFont") : r.pieces > 1 ? t("orn.pieces", { n: r.pieces }) : "";
    $<HTMLButtonElement>("orn-ok").disabled = !r.cut.length;
  };
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(update, 160); };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener(i.tagName === "SELECT" || (i as HTMLInputElement).type === "checkbox" ? "change" : "input", schedule));
  update();

  const close = () => { clearTimeout(timer); run++; ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("orn-cancel").onclick = close;
  $<HTMLElement>("orn-ok").onclick = async () => {
    clearTimeout(timer);
    await update();
    const r = last;
    if (!r || !r.cut.length) return;
    const o = read();
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* egal */ }
    close();
    placeOrnament(r, o.text.trim() || t("orn.title"));
    log(t(r.top.length ? "orn.doneLayer" : "orn.done", { w: r.w.toFixed(1), h: r.h.toFixed(1) }));
    done();
  };
  setTimeout(() => { const i = $("orn-text"); i.focus(); i.select(); }, 0);
}

/**
 * Anhänger als Gruppe in die Bettmitte: Schnitt (stärkste Linien-Ebene / außen+innen), Gravur (Füll-Ebene / Tasche),
 * Linien (schwächste Linien-Ebene, an der Fräse flach). „Eigenes Teil“: der Name als zweite Gruppe 8 mm darüber.
 */
function placeOrnament(r: OrnamentResult, name: string) {
  const st = app();
  const bed = bedSizeMm();
  const b = bounds(union([r.cut, r.top]));
  const lift = r.top.length ? (b.y1 - b.y0 + 8) / 2 : 0;
  const dx = bed.w / 2 - (b.x0 + b.x1) / 2, dy = bed.h / 2 - (b.y0 + b.y1) / 2 - lift;
  const px = (m: MultiPolygon, up = 0): MultiPolygon => m.map(p => p.map(rg => rg.map(([x, y]) => [(x + dx) * MM_TO_PIXEL, (y + dy + up) * MM_TO_PIXEL] as [number, number])));
  const layers = getLayers();
  const cutL = layers.filter(l => l.mode === "line").sort((a, c) => c.power - a.power)[0];
  const engL = layers.find(l => l.mode === "fill");
  const mark = layers.filter(l => l.mode === "line").sort((a, c) => a.power - c.power)[0];
  const source = name.slice(0, 40);
  const groupId = "ornament-" + newId(), topId = "ornament-" + newId();
  const cut = toShapes(px(r.cut), cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId, source }));
  const eng = toShapes(px(r.engrave), engL ? { laserLayerId: engL.id } : {}).map(s => ({ ...s, groupId, millingMode: "pocket", millingDepth: -0.5, source }));
  const top = toShapes(px(r.top, 2 * lift), cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId: topId, source }));
  const lines = r.lines.map(l => createPolyline(l.pts.map(([x, y]) => ({ x: (x + dx) * MM_TO_PIXEL, y: (y + dy) * MM_TO_PIXEL })),
    l.closed, "on-line", { ...(mark ? { laserLayerId: mark.id } : {}), millingDepth: -0.3, isScore: true, groupId, source }));
  const made = [...cut, ...eng, ...top, ...lines];
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}
