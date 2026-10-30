/**
 * BUCHSTABEN-STECKER-GENERATOR – Fenster (Extras): Zeichen eingeben (jedes Zeichen ein Stecker oder alles auf einem),
 * Rahmen, Rand und Halterung wählen, Vorschau aller Stecker, „Aufs Bett“ legt sie in Reihen aufs Bett (jeder eine Gruppe).
 * Die Geometrie entsteht in letterTopper.ts.
 */
import type { MultiPolygon, Polygon } from "polygon-clipping";
import polygonClipping from "polygon-clipping";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, newId, createPolyline } from "../shapeTransform";
import { toShapes } from "./shapeOps";
import { traceTextWithFont } from "./textTool";
import { createFontPicker } from "./fontPicker";
import { getLayers } from "../laserLayers";
import { t } from "../i18n/i18n";
import { bounds, type ScoreLine, type XY } from "../nameConnect";
import type { OrnamentText } from "../ornament";
import { topper, topperFrame, TOPPER_SHAPES, TOPPER_EDGES, TOPPER_MOUNTS, type TopperOptions, type TopperResult,
  type TopperShape, type TopperEdge, type TopperMount } from "../letterTopper";

const KEY = "cnc_craft_lettertopper";
interface Opts extends TopperOptions { text: string; single: boolean; font: string; bold: boolean }
const DEF: Opts = { shape: "oval", edge: "scallop", w: 48, h: 60, ring: 4, mount: "stick", stickW: 5, stickL: 60, holeD: 4, thicken: 0,
  text: "ABC", single: false, font: "Pacifico", bold: false };
const GAP = 5; // Abstand der Stecker auf dem Bett (mm)

function load(): Opts {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: Opts = { ...DEF };
    for (const k of ["w", "h", "ring", "stickW", "stickL", "holeD", "thicken"] as const) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    for (const k of ["text", "font"] as const) if (typeof s[k] === "string") o[k] = s[k].slice(0, 80);
    for (const k of ["single", "bold"] as const) if (typeof s[k] === "boolean") o[k] = s[k];
    if (TOPPER_SHAPES.includes(s.shape)) o.shape = s.shape;
    if (TOPPER_EDGES.includes(s.edge)) o.edge = s.edge;
    if (TOPPER_MOUNTS.includes(s.mount)) o.mount = s.mount;
    return o;
  } catch { return { ...DEF }; }
}

/** Die Stecker: jedes Zeichen einzeln (Leerzeichen zählen nicht) oder der ganze Text auf einem */
const items = (o: Opts): string[] => (o.single ? [o.text.trim()].filter(Boolean) : [...o.text.replace(/\s+/g, "")]).slice(0, 80);

const traceCache = new Map<string, OrnamentText>();
/** Zeichen nachzeichnen: geschlossene Konturen als Fläche (Gerade/Ungerade), Einzellinien-Schrift als Linien */
async function trace(s: string, o: Opts): Promise<OrnamentText> {
  const key = JSON.stringify([s, o.font, o.bold]);
  const hit = traceCache.get(key);
  if (hit) return hit;
  const tr = (await traceTextWithFont({ text: s, font: o.font, heightMm: 10, bold: o.bold, italic: false, align: "center", lineSpacing: 140, letterSpacing: 0 })).traced;
  const loops = tr.loops.map(l => l.map(p => [p.x, p.y] as XY));
  let res: OrnamentText;
  if (tr.closed?.some(c => !c)) res = { area: [], lines: loops.filter(l => l.length >= 2).map((pts, i) => ({ pts, closed: tr.closed?.[i] !== false })) };
  else {
    const rings: Polygon[] = loops.filter(l => l.length >= 3).map(l => [l]);
    res = { area: !rings.length ? [] : rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1)), lines: [] };
  }
  traceCache.set(key, res);
  if (traceCache.size > 200) traceCache.delete(traceCache.keys().next().value!);
  return res;
}

function previewSvg(list: TopperResult[]): string {
  if (!list.length) return "";
  const cols = Math.min(list.length, 6), bs = list.map(r => bounds(r.cut));
  const cw = Math.max(...bs.map(b => b.x1 - b.x0)) + GAP, ch = Math.max(...bs.map(b => b.y1 - b.y0)) + GAP;
  const rows = Math.ceil(list.length / cols), sw = Math.max(cw, ch) / 250;
  return `<svg viewBox="${-GAP / 2} ${-GAP / 2} ${cols * cw} ${rows * ch}" style="width:100%;max-height:300px;">${list.map((r, i) => {
    const b = bs[i], ox = (i % cols) * cw + (cw - GAP - (b.x1 - b.x0)) / 2 - b.x0, oy = Math.floor(i / cols) * ch + b.y1;
    const xy = ([x, y]: [number, number] | XY) => `${(x + ox).toFixed(2)},${(oy - y).toFixed(2)}`;
    const d = r.cut.map(p => p.map(rg => rg.map((q, k) => `${k ? "L" : "M"}${xy(q)}`).join("") + "Z").join("")).join("");
    const ln = (l: ScoreLine) => l.pts.map((q, k) => `${k ? "L" : "M"}${xy(q)}`).join("") + (l.closed ? "Z" : "");
    return `<path d="${d}" fill="#c98a4b" fill-rule="evenodd" stroke="#ffd28a" stroke-width="${sw.toFixed(2)}"/>`
      + `<path d="${r.lines.map(ln).join("")}" fill="none" stroke="#3ccf4e" stroke-width="${(sw * 1.4).toFixed(2)}"/>`;
  }).join("")}</svg>`;
}

export function openLetterTopperDialog(log: (s: string) => void, done: () => void) {
  const init = load();
  document.getElementById("lt-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "lt-dialog-overlay";
  ov.className = "dlg-overlay";
  const sel = (id: string, key: string, list: string[], prefix: string) =>
    `<label class="dlg-row"><span>${t(key)}</span><select id="${id}" style="width:auto;max-width:190px;">${list.map(v => `<option value="${v}">${t(prefix + v)}</option>`).join("")}</select></label>`;
  const num = (id: string, key: string, step: string, min: string) =>
    `<label class="dlg-row"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="${min}" step="${step}"><em>mm</em></span></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(820px, calc(100vw - 32px));">
      <h3>🔤 ${t("lt.title")}</h3>
      <div class="dlg-hint">${t("lt.desc")}</div>
      <div style="display:grid;grid-template-columns:300px 1fr;gap:12px;align-items:start;">
        <div class="box-fields">
          <input id="lt-text" type="text" maxlength="80" style="width:100%;box-sizing:border-box;font-size:1rem;">
          <div style="display:flex;gap:4px;margin:4px 0;">
            <button type="button" class="btn-secondary" data-fill="ABCDEFGHIJKLMNOPQRSTUVWXYZ">A–Z</button>
            <button type="button" class="btn-secondary" data-fill="abcdefghijklmnopqrstuvwxyz">a–z</button>
            <button type="button" class="btn-secondary" data-fill="0123456789">0–9</button>
          </div>
          <label class="dlg-row" style="cursor:pointer;"><span>${t("lt.single")}</span><input id="lt-single" type="checkbox" style="width:auto;"></label>
          <label class="dlg-row"><span>${t("text.font")}</span><div id="lt-font" style="width:170px;"></div></label>
          <label class="dlg-row" style="cursor:pointer;"><span>${t("text.bold")}</span><input id="lt-bold" type="checkbox" style="width:auto;"></label>
          ${num("lt-thick", "lt.thicken", "0.1", "0")}
          ${sel("lt-shape", "lt.shape", TOPPER_SHAPES, "lt.shape.")}
          ${sel("lt-edge", "lt.edge", TOPPER_EDGES, "lt.edge.")}
          ${num("lt-h", "lt.h", "1", "20")}
          <div class="lt-only-w">${num("lt-w", "lt.w", "1", "20")}</div>
          ${num("lt-ring", "lt.ring", "0.5", "1.5")}
          ${sel("lt-mount", "lt.mount", TOPPER_MOUNTS, "lt.mount.")}
          <div class="lt-only-stick">${num("lt-sw", "lt.stickW", "0.5", "2")}${num("lt-sl", "lt.stickL", "5", "5")}</div>
          <div class="lt-only-hole">${num("lt-hd", "lt.holeD", "0.5", "1")}</div>
        </div>
        <div class="box-prev" style="min-height:280px;"><div id="lt-svg" style="flex:1;display:flex;align-items:center;"></div>
          <div id="lt-info" class="dlg-hint"></div><div id="lt-warn" class="dlg-hint" style="color:#ffb454;"></div></div>
      </div>
      <div class="dlg-buttons">
        <button id="lt-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="lt-ok" class="btn-primary">✔ ${t("lt.place")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  let font = init.font;
  createFontPicker($<HTMLElement>("lt-font"), font, f => { font = f; schedule(); });
  // Werte per value setzen (der Text ist fremder Text – nie ins innerHTML)
  $("lt-text").value = init.text; $("lt-single").checked = init.single; $("lt-bold").checked = init.bold;
  $("lt-thick").value = String(init.thicken);
  $<HTMLSelectElement>("lt-shape").value = init.shape; $<HTMLSelectElement>("lt-edge").value = init.edge;
  $("lt-h").value = String(init.h); $("lt-w").value = String(init.w); $("lt-ring").value = String(init.ring);
  $<HTMLSelectElement>("lt-mount").value = init.mount;
  $("lt-sw").value = String(init.stickW); $("lt-sl").value = String(init.stickL); $("lt-hd").value = String(init.holeD);

  const read = (): Opts => {
    const n = (id: string, d: number, min: number, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    const v = (id: string) => $<HTMLSelectElement>(id).value;
    return {
      text: $("lt-text").value, single: $("lt-single").checked, font, bold: $("lt-bold").checked, thicken: n("lt-thick", 0, 0, 5),
      shape: v("lt-shape") as TopperShape, edge: v("lt-edge") as TopperEdge, h: n("lt-h", DEF.h, 20, 1000), w: n("lt-w", DEF.w, 20, 1000),
      ring: n("lt-ring", DEF.ring, 1.5, 100), mount: v("lt-mount") as TopperMount, stickW: n("lt-sw", DEF.stickW, 2, 50),
      stickL: n("lt-sl", DEF.stickL, 5, 1000), holeD: n("lt-hd", DEF.holeD, 1, 30)
    };
  };

  let last: { o: Opts; list: TopperResult[]; chars: string[] } | null = null, run = 0, timer = 0;
  const update = async () => {
    const o = read(), my = ++run;
    const show = (cls: string, on: boolean) => ov.querySelectorAll<HTMLElement>("." + cls).forEach(el => { el.style.display = on ? "" : "none"; });
    show("lt-only-w", o.shape === "oval" || o.shape === "square");
    show("lt-only-stick", o.mount === "stick");
    show("lt-only-hole", o.mount === "hole" || o.mount === "garland");
    const chars = items(o);
    const texts: OrnamentText[] = [];
    for (const c of chars) { texts.push(await trace(c, o)); if (my !== run) return; } // inzwischen neu eingegeben
    const f = topperFrame(o);
    const list = texts.map(tx => topper(f, o, tx));
    last = { o, list, chars };
    $<HTMLElement>("lt-svg").innerHTML = previewSvg(list);
    const r = list[0];
    $<HTMLElement>("lt-info").textContent = r ? t("lt.info", { n: list.length, w: r.w.toFixed(1), h: r.h.toFixed(1) }) : t("lt.empty");
    const loose = chars.filter((_, i) => list[i].dropped);
    // die Zeichen sind fremder Text – nur über textContent
    $<HTMLElement>("lt-warn").textContent = loose.length ? t("lt.dropped", { c: loose.join(" ") }) : "";
    $<HTMLButtonElement>("lt-ok").disabled = !list.length;
  };
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(update, 200); };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener(i.tagName === "SELECT" || (i as HTMLInputElement).type === "checkbox" ? "change" : "input", schedule));
  ov.querySelectorAll<HTMLElement>("[data-fill]").forEach(b => b.addEventListener("click", () => { $("lt-text").value = b.dataset.fill!; schedule(); }));
  update();

  const close = () => { clearTimeout(timer); run++; ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("lt-cancel").onclick = close;
  $<HTMLElement>("lt-ok").onclick = async () => {
    clearTimeout(timer);
    await update();
    if (!last || !last.list.length) return;
    try { localStorage.setItem(KEY, JSON.stringify(last.o)); } catch { /* egal */ }
    close();
    placeToppers(last.list, last.chars);
    log(t("lt.done", { n: last.list.length }));
    done();
  };
  setTimeout(() => { const i = $("lt-text"); i.focus(); i.select(); }, 0);
}

/** Stecker in Reihen aufs Bett (links unten, 10 mm Rand), jeder eine Gruppe; Schnitt stärkste, Linien schwächste Linien-Ebene */
function placeToppers(list: TopperResult[], chars: string[]) {
  const st = app();
  const bed = bedSizeMm();
  const layers = getLayers();
  const cutL = layers.filter(l => l.mode === "line").sort((a, c) => c.power - a.power)[0];
  const mark = layers.filter(l => l.mode === "line").sort((a, c) => a.power - c.power)[0];
  const made: any[] = [];
  let x = 10, y = 10, rowH = 0;
  list.forEach((r, i) => {
    const b = bounds(r.cut), w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (x > 10 && x + w > bed.w - 10) { x = 10; y += rowH + GAP; rowH = 0; }
    const dx = x - b.x0, dy = y - b.y0;
    const px = (m: MultiPolygon): MultiPolygon => m.map(p => p.map(rg => rg.map(([qx, qy]) => [(qx + dx) * MM_TO_PIXEL, (qy + dy) * MM_TO_PIXEL] as [number, number])));
    const groupId = "topper-" + newId(), source = chars[i].slice(0, 40);
    made.push(...toShapes(px(r.cut), cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId, source })));
    for (const l of r.lines) made.push(createPolyline(l.pts.map(([qx, qy]) => ({ x: (qx + dx) * MM_TO_PIXEL, y: (qy + dy) * MM_TO_PIXEL })), l.closed, "on-line",
      { ...(mark ? { laserLayerId: mark.id } : {}), millingDepth: -0.3, isScore: true, groupId, source }));
    x += w + GAP; rowH = Math.max(rowH, h);
  });
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}
