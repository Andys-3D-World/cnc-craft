/**
 * ETIKETT, SCHLÜSSELANHÄNGER, FOTORAHMEN: ein gemeinsames Fenster, die Felder kommen je Teil aus einer Liste.
 * Geometrie: smallParts.ts. Text wird wie bei den anderen Generatoren nachgezeichnet und graviert.
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Polygon } from "polygon-clipping";
import { icon } from "../ui/icons";
import { loadSettings, saveSettings } from "./genRun";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, newId, createPolyline } from "../shapeTransform";
import { toShapes } from "./shapeOps";
import { traceTextWithFont } from "./textTool";
import { createFontPicker } from "./fontPicker";
import { getLayers } from "../laserLayers";
import { t } from "../i18n/i18n";
import { bounds, type XY } from "../nameConnect";
import { fitText, type OrnamentText } from "../ornament";
import { labelPart, keychainPart, framePart, KEY_SHAPES, FRAME_STYLES, type SmallResult, type LabelOptions, type KeychainOptions, type FrameOptions } from "../smallParts";

type Kind = "label" | "keychain" | "frame";
type Field = { id: string; key: string; type: "num" | "sel" | "check"; def: number | string | boolean; min?: number; max?: number; step?: string; opts?: [string, string][] };

const FIELDS: Record<Kind, Field[]> = {
  label: [
    { id: "width", key: "part.width", type: "num", def: 80, min: 10, max: 1000, step: "1" },
    { id: "height", key: "part.height", type: "num", def: 30, min: 5, max: 1000, step: "1" },
    { id: "radius", key: "part.radius", type: "num", def: 4, min: 0, max: 200, step: "0.5" },
    { id: "holes", key: "part.holes", type: "sel", def: "1", opts: [["0", "0"], ["1", "1"], ["2", "2"]] },
    { id: "holeD", key: "part.holeD", type: "num", def: 4, min: 0.5, max: 50, step: "0.5" }
  ],
  keychain: [
    { id: "shape", key: "part.shape", type: "sel", def: "pill" },
    { id: "width", key: "part.width", type: "num", def: 60, min: 15, max: 300, step: "1" },
    { id: "height", key: "part.height", type: "num", def: 22, min: 8, max: 200, step: "1" },
    { id: "holeD", key: "part.holeD", type: "num", def: 5, min: 2, max: 30, step: "0.5" },
    { id: "ring", key: "part.ring", type: "num", def: 3, min: 1, max: 20, step: "0.5" }
  ],
  frame: [
    { id: "photoW", key: "part.photoW", type: "num", def: 100, min: 20, max: 1000, step: "1" },
    { id: "photoH", key: "part.photoH", type: "num", def: 150, min: 20, max: 1000, step: "1" },
    { id: "border", key: "part.border", type: "num", def: 20, min: 5, max: 200, step: "1" },
    { id: "overlap", key: "part.overlap", type: "num", def: 4, min: 1, max: 30, step: "0.5" },
    { id: "clear", key: "part.clear", type: "num", def: 0.5, min: 0, max: 5, step: "0.1" },
    { id: "style", key: "part.style", type: "sel", def: "rounded" },
    { id: "hanger", key: "part.hanger", type: "check", def: true }
  ]
};

const f1 = (v: number) => String(Number(v.toFixed(1)));

function build(kind: Kind, v: Record<string, any>): SmallResult {
  if (kind === "label") return labelPart({ ...(v as unknown as LabelOptions), holes: Number(v.holes) as 0 | 1 | 2 });
  if (kind === "keychain") return keychainPart(v as unknown as KeychainOptions);
  return framePart(v as unknown as FrameOptions);
}

const dPath = (m: MultiPolygon, dx: number) => m.map(p => p.map(r => r.map(([x, y], i) => `${i ? "L" : "M"}${(x + dx).toFixed(2)},${(-y).toFixed(2)}`).join("") + "Z").join("")).join("");

function preview(r: SmallResult, engrave: MultiPolygon[]): string {
  let x = 0, html = "", y0 = Infinity, y1 = -Infinity;
  r.parts.forEach((p, i) => {
    const b = bounds(p.cut), dx = x - b.x0;
    html += `<path d="${dPath(p.cut, dx)}" fill="#d8a56a" fill-rule="evenodd" stroke="#3a2412" stroke-width="0.3"/>`;
    if (engrave[i]?.length) html += `<path d="${dPath(engrave[i], dx)}" fill="#5a3a1c" fill-rule="evenodd"/>`;
    y0 = Math.min(y0, -b.y1); y1 = Math.max(y1, -b.y0);
    x += b.x1 - b.x0 + 6;
  });
  return `<svg viewBox="-2 ${y0 - 2} ${x - 2} ${y1 - y0 + 4}" style="width:100%;height:280px;">${html}</svg>`;
}

const cache = new Map<string, OrnamentText>();
async function traceFor(s: string, font: string): Promise<OrnamentText> {
  if (!s.trim()) return { area: [], lines: [] };
  const k = font + "|" + s;
  const hit = cache.get(k);
  if (hit) return hit;
  const tr = (await traceTextWithFont({ text: s, font, heightMm: 10, bold: false, italic: false, align: "center", lineSpacing: 140, letterSpacing: 0 })).traced;
  const loops = tr.loops.map(l => l.map(p => [p.x, p.y] as XY));
  let res: OrnamentText;
  if (tr.closed?.some(c => !c)) res = { area: [], lines: loops.filter(l => l.length >= 2).map((pts, i) => ({ pts, closed: tr.closed?.[i] !== false })) };
  else {
    const rings: Polygon[] = loops.filter(l => l.length >= 3).map(l => [l]);
    res = { area: !rings.length ? [] : rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1)), lines: [] };
  }
  cache.set(k, res);
  return res;
}

function openPart(kind: Kind, log: (s: string) => void, done: () => void) {
  const KEY = "cnc_craft_part_" + kind;
  let saved: Record<string, any> = {};
  try { saved = JSON.parse(loadSettings(KEY) || "{}") || {}; } catch { /* egal */ }
  const fields = FIELDS[kind], hasText = kind !== "frame";
  const opts = (fd: Field): [string, string][] => fd.opts || (fd.id === "shape" ? KEY_SHAPES.map(k => [k, t("part.shape." + k)]) : FRAME_STYLES.map(k => [k, t("part.style." + k)]));
  const row = (fd: Field) => fd.type === "num"
    ? `<label class="dlg-row"><span>${t(fd.key)}</span><span class="dlg-num"><input id="sp-${fd.id}" type="number" min="${fd.min}" max="${fd.max}" step="${fd.step}"><em>mm</em></span></label>`
    : fd.type === "sel" ? `<label class="dlg-row"><span>${t(fd.key)}</span><select id="sp-${fd.id}">${opts(fd).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>`
    : `<label class="dlg-row" style="cursor:pointer;"><span>${t(fd.key)}</span><input id="sp-${fd.id}" type="checkbox" style="width:auto;"></label>`;
  document.getElementById("part-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "part-dialog-overlay";
  ov.dataset.preset = kind;
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog">
      <h3>${icon(kind, 20)}${t("part." + kind + ".title")}</h3>
      <div class="dlg-hint">${t("part." + kind + ".desc")}</div>
      <div class="box-grid">
        <div class="box-fields">
          ${fields.map(row).join("")}
          ${hasText ? `<label class="dlg-row"><span>${t("part.text")}</span><input id="sp-text" type="text" maxlength="40"></label>
          <div class="dlg-row"><span>${t("text.font")}</span><div id="sp-font" style="width:170px;"></div></div>` : ""}
        </div>
        <div class="box-prev"><div id="sp-svg"></div><div id="sp-info" class="dlg-hint"></div><div id="sp-warn" class="dlg-hint" style="color:var(--lt-amber, #ffb454);"></div></div>
      </div>
      <div class="dlg-buttons">
        <button id="sp-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="sp-ok" class="btn-primary">✔</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  for (const fd of fields) {
    const el = $("sp-" + fd.id), v = saved[fd.id] ?? fd.def;
    if (fd.type === "check") el.checked = v === true; else el.value = String(v);
  }
  let font = typeof saved.font === "string" ? saved.font : "Open Sans";
  if (hasText) {
    $("sp-text").value = typeof saved.text === "string" ? saved.text : kind === "keychain" ? "Andreas" : "";
    createFontPicker($<HTMLElement>("sp-font"), font, f => { font = f; void update(); });
  }
  const read = () => {
    const v: Record<string, any> = {};
    for (const fd of fields) {
      const el = $("sp-" + fd.id);
      if (fd.type === "check") v[fd.id] = el.checked;
      else if (fd.type === "sel") v[fd.id] = el.value;
      else { const n = parseFloat(el.value); v[fd.id] = Number.isFinite(n) ? Math.min(fd.max!, Math.max(fd.min!, n)) : fd.def; }
    }
    return v;
  };
  let last: SmallResult | null = null, lastEngrave: OrnamentText[] = [], run = 0;
  const update = async () => {
    const mine = ++run, v = read(), r = build(kind, v);
    const txt = hasText ? await traceFor($("sp-text").value, font) : { area: [], lines: [] };
    if (mine !== run) return;
    const eng = r.parts.map(p => (p.textBox && (txt.area.length || txt.lines.length) ? fitText(txt, p.textBox) : { area: [], lines: [] }));
    last = r; lastEngrave = eng;
    $<HTMLElement>("sp-svg").innerHTML = preview(r, eng.map(e => e.area));
    const bs = r.parts.map(p => bounds(p.cut));
    $<HTMLElement>("sp-info").textContent = t("part.info", { n: r.parts.length, w: f1(Math.max(...bs.map(b => b.x1 - b.x0))), h: f1(Math.max(...bs.map(b => b.y1 - b.y0))) });
    $<HTMLElement>("sp-warn").textContent = r.warnings.map(w => t(w)).join(" ");
  };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener("input", () => { void update(); }));
  ov.querySelectorAll("select, input[type=checkbox]").forEach(i => i.addEventListener("change", () => { void update(); }));
  void update();
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  $<HTMLElement>("sp-cancel").onclick = close;
  $<HTMLElement>("sp-ok").onclick = async () => {
    await update();
    if (!last) return;
    saveSettings(KEY, { ...read(), ...(hasText ? { text: $("sp-text").value, font } : {}) });
    const r = last, eng = lastEngrave;
    close();
    place(r, eng, t("part." + kind + ".title"));
    log(t("part.done", { n: r.parts.length }));
    done();
  };
}

function place(r: SmallResult, eng: OrnamentText[], source: string) {
  const st = app(), bed = bedSizeMm(), layers = getLayers();
  const lineL = layers.filter(l => l.mode === "line").sort((a, c) => c.power - a.power);
  const cutL = lineL[0], markL = lineL[lineL.length - 1], engL = layers.find(l => l.mode === "fill");
  const made: any[] = [];
  const W = r.parts.reduce((s, p) => { const b = bounds(p.cut); return s + b.x1 - b.x0 + 5; }, -5);
  let x = Math.max(5, (bed.w - W) / 2);
  r.parts.forEach((p, i) => {
    const b = bounds(p.cut), dx = x - b.x0, dy = Math.max(5, (bed.h - (b.y1 - b.y0)) / 2) - b.y0, groupId = "part-" + newId();
    const px = (m: MultiPolygon): MultiPolygon => m.map(q => q.map(rg => rg.map(([qx, qy]) => [(qx + dx) * MM_TO_PIXEL, (qy + dy) * MM_TO_PIXEL] as [number, number])));
    made.push(...toShapes(px(p.cut), cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId, source })));
    const e = eng[i];
    if (e?.area.length) made.push(...toShapes(px(e.area), engL ? { laserLayerId: engL.id } : {}).map(s => ({ ...s, groupId, source, millingMode: "pocket", millingDepth: -0.5 })));
    for (const l of e?.lines || []) made.push(createPolyline(l.pts.map(([qx, qy]) => ({ x: (qx + dx) * MM_TO_PIXEL, y: (qy + dy) * MM_TO_PIXEL })), l.closed, "on-line",
      { ...(markL ? { laserLayerId: markL.id } : {}), millingDepth: -0.3, isScore: true, groupId, source }));
    x += b.x1 - b.x0 + 5;
  });
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}

export const openLabelDialog = (log: (s: string) => void, done: () => void) => openPart("label", log, done);
export const openKeychainDialog = (log: (s: string) => void, done: () => void) => openPart("keychain", log, done);
export const openFrameDialog = (log: (s: string) => void, done: () => void) => openPart("frame", log, done);
