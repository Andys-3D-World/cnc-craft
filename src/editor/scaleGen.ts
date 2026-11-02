/**
 * LINEAL / WINKELMESSER / ZIFFERBLATT – Fenster (Generatoren). Vorschau mit Strichen und Zahlen; „Aufs Bett“ setzt die
 * Zahlen in Einzellinien-Schrift (schnell zu gravieren) und legt alles als Gruppe in die Bettmitte:
 * Umriss + Löcher auf der stärksten Linien-Ebene (schneiden), Striche + Zahlen auf der schwächsten (gravieren).
 * Geometrie: scales.ts.
 */
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, newId, createPolyline } from "../shapeTransform";
import { traceSingleLine } from "./singleLine";
import { getLayers } from "../laserLayers";
import { t } from "../i18n/i18n";
import { scale, SCALE_KINDS, NUMERALS, type ScaleOptions, type ScaleResult, type ScaleKind, type Numerals, type XY } from "../scales";

const KEY = "cnc_craft_scale";
const DEF: ScaleOptions = { kind: "ruler", unit: "mm", length: 150, width: 25, holeD: 6, radius: 60, diameter: 200, numerals: "arabic",
  centerHole: 8, textH: 3 };
const NUMS = ["length", "width", "holeD", "radius", "diameter", "centerHole", "textH"] as const;

function load(): ScaleOptions {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: ScaleOptions = { ...DEF };
    for (const k of NUMS) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    if (SCALE_KINDS.includes(s.kind)) o.kind = s.kind;
    if (NUMERALS.includes(s.numerals)) o.numerals = s.numerals;
    if (s.unit === "mm" || s.unit === "inch") o.unit = s.unit;
    return o;
  } catch { return { ...DEF }; }
}

const f = (v: number, n = 1) => String(Number(v.toFixed(n)));

function bounds(r: ScaleResult) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of r.outline) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

function previewSvg(r: ScaleResult): string {
  const b = bounds(r);
  const pad = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.04 + 1;
  const X = (x: number) => (x - b.x0 + pad).toFixed(2), Y = (y: number) => (b.y1 - y + pad).toFixed(2);
  const path = (pts: XY[], close: boolean) => pts.map(([x, y], i) => `${i ? "L" : "M"}${X(x)},${Y(y)}`).join("") + (close ? "Z" : "");
  const sw = Math.max(b.x1 - b.x0, b.y1 - b.y0) / 600;
  // Zahlen nur zur Vorschau als SVG-Text (nur Ziffern/römische Zahlen – kein fremder Text)
  const txt = r.labels.map(l => `<text x="${X(l.x)}" y="${Y(l.y)}" font-size="${(l.h * 1.35).toFixed(2)}" text-anchor="middle" dominant-baseline="central"
    transform="rotate(${(-l.angle * 180 / Math.PI).toFixed(2)} ${X(l.x)} ${Y(l.y)})" fill="#3a2412" font-family="sans-serif">${l.text}</text>`).join("");
  return `<svg viewBox="0 0 ${(b.x1 - b.x0 + 2 * pad).toFixed(2)} ${(b.y1 - b.y0 + 2 * pad).toFixed(2)}" style="width:100%;height:280px;">
    <path d="${path(r.outline, true)}${r.holes.map(h => path(h, true)).join("")}" fill="#c98a4b" fill-rule="evenodd" stroke="#ffd28a" stroke-width="${sw.toFixed(2)}"/>
    <path d="${r.ticks.map(tk => path(tk, false)).join("")}" stroke="#3a2412" stroke-width="${(sw * 1.4).toFixed(2)}" fill="none"/>${txt}</svg>`;
}

export function openScaleDialog(log: (s: string) => void, done: () => void) {
  const init = load();
  document.getElementById("scale-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "scale-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, step: string, min: string, unit = "mm", unitId = "") =>
    `<label class="dlg-row"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="${min}" step="${step}"><em ${unitId ? `id="${unitId}"` : ""}>${unit}</em></span></label>`;
  const sel = (id: string, key: string, opts: [string, string][]) =>
    `<label class="dlg-row"><span>${t(key)}</span><select id="${id}" style="width:auto;max-width:190px;">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(780px, calc(100vw - 32px));">
      <h3>📏 ${t("scale.title")}</h3>
      <div class="dlg-hint">${t("scale.desc")}</div>
      <div style="display:grid;grid-template-columns:300px 1fr;gap:12px;align-items:start;">
        <div class="box-fields">
          ${sel("sc-kind", "scale.kind", SCALE_KINDS.map(k => [k, t("scale.kind." + k)]))}
          <div class="sc-k-ruler">
            ${sel("sc-unit", "scale.unit", [["mm", "mm / cm"], ["inch", t("scale.inch")]])}
            ${num("sc-len", "scale.length", "1", "1", "mm", "sc-len-unit")}
            ${num("sc-w", "scale.width", "1", "8")}
            ${num("sc-hole", "scale.holeD", "0.5", "0")}
          </div>
          <div class="sc-k-protractor">${num("sc-r", "scale.radius", "1", "20")}</div>
          <div class="sc-k-clock">
            ${num("sc-d", "scale.diameter", "1", "40")}
            ${sel("sc-num", "scale.numerals", NUMERALS.map(n => [n, t("scale.numerals." + n)]))}
            ${num("sc-ch", "scale.centerHole", "0.5", "0")}
          </div>
          ${num("sc-th", "scale.textH", "0.5", "1")}
        </div>
        <div class="box-prev" style="min-height:300px;"><div id="sc-svg" style="flex:1;display:flex;align-items:center;"></div>
          <div id="sc-info" class="dlg-hint"></div><div id="sc-warn" class="dlg-hint" style="color:#ffb454;"></div></div>
      </div>
      <div class="dlg-buttons">
        <button id="sc-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="sc-ok" class="btn-primary">✔ ${t("scale.place")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const ids: [string, (typeof NUMS)[number]][] = [["sc-len", "length"], ["sc-w", "width"], ["sc-hole", "holeD"], ["sc-r", "radius"],
    ["sc-d", "diameter"], ["sc-ch", "centerHole"], ["sc-th", "textH"]];
  for (const [id, k] of ids) $(id).value = String(init[k]);
  $<HTMLSelectElement>("sc-kind").value = init.kind;
  $<HTMLSelectElement>("sc-unit").value = init.unit;
  $<HTMLSelectElement>("sc-num").value = init.numerals;

  const read = (): ScaleOptions => {
    const n = (id: string, d: number, min: number, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    const unit = $<HTMLSelectElement>("sc-unit").value === "inch" ? "inch" : "mm";
    return {
      kind: $<HTMLSelectElement>("sc-kind").value as ScaleKind, unit, numerals: $<HTMLSelectElement>("sc-num").value as Numerals,
      length: n("sc-len", DEF.length, 1, unit === "inch" ? 120 : 3000), width: n("sc-w", DEF.width, 8, 300), holeD: n("sc-hole", 0, 0, 50),
      radius: n("sc-r", DEF.radius, 20, 1000), diameter: n("sc-d", DEF.diameter, 40, 2000), centerHole: n("sc-ch", 0, 0, 100),
      textH: n("sc-th", DEF.textH, 1, 200)
    };
  };

  let last: ScaleResult | null = null;
  const update = () => {
    const o = read();
    for (const k of SCALE_KINDS) ov.querySelectorAll<HTMLElement>(".sc-k-" + k).forEach(el => { el.style.display = k === o.kind ? "" : "none"; });
    $<HTMLElement>("sc-len-unit").textContent = o.unit === "inch" ? "in" : "mm";
    const r = scale(o);
    last = r;
    $<HTMLElement>("sc-svg").innerHTML = previewSvg(r);
    $<HTMLElement>("sc-info").textContent = t("scale.info", { w: f(r.w), h: f(r.h), n: r.ticks.length });
    $<HTMLElement>("sc-warn").innerHTML = r.warnings.map(w => `<div>${t(w)}</div>`).join("");
  };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener(i.tagName === "SELECT" ? "change" : "input", update));
  update();

  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("sc-cancel").onclick = close;
  $<HTMLElement>("sc-ok").onclick = async () => {
    update();
    const r = last;
    if (!r) return;
    const o = read();
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* egal */ }
    close();
    await placeScale(r, t("scale.kind." + o.kind));
    log(t("scale.done", { what: t("scale.kind." + o.kind), w: f(r.w), h: f(r.h) }));
    done();
  };
}

async function placeScale(r: ScaleResult, name: string) {
  const st = app();
  const bed = bedSizeMm();
  const b = bounds(r);
  const dx = bed.w / 2 - (b.x0 + b.x1) / 2, dy = bed.h / 2 - (b.y0 + b.y1) / 2;
  const px = (pts: XY[]) => pts.map(([x, y]) => ({ x: (x + dx) * MM_TO_PIXEL, y: (y + dy) * MM_TO_PIXEL }));
  const lines = getLayers().filter(l => l.mode === "line").sort((a, c) => c.power - a.power);
  const cutL = lines[0], markL = lines[lines.length - 1];
  const groupId = "scale-" + newId(), source = name.slice(0, 40);
  const cut = { ...(cutL ? { laserLayerId: cutL.id } : {}), groupId, source };
  const mark = { ...(markL ? { laserLayerId: markL.id } : {}), millingDepth: -0.3, isScore: true, groupId, source };
  const made: any[] = [];
  for (const tk of r.ticks) made.push(createPolyline(px(tk), false, "on-line", mark));
  // Zahlen: jede Zeichenfolge einmal nachzeichnen, dann je Stelle verschieben und drehen
  const cache = new Map<string, Awaited<ReturnType<typeof traceSingleLine>>>();
  for (const l of r.labels) {
    let tr = cache.get(l.text + "|" + l.h);
    if (!tr) {
      tr = await traceSingleLine({ text: l.text, font: "", heightMm: l.h, bold: false, italic: false, align: "left", lineSpacing: 170, letterSpacing: 0 });
      cache.set(l.text + "|" + l.h, tr);
    }
    const c = Math.cos(l.angle), s = Math.sin(l.angle), cw = tr.width / 2, ch = tr.height / 2;
    tr.loops.forEach((loop, i) => {
      const pts = loop.map(q => { const x = q.x - cw, y = q.y - ch; return [l.x + x * c - y * s, l.y + x * s + y * c] as XY; });
      if (pts.length >= 2) made.push(createPolyline(px(pts), tr!.closed?.[i] ?? false, "on-line", mark));
    });
  }
  for (const h of r.holes) made.push(createPolyline(px(h.slice(0, -1)), true, "inside", cut));
  made.push(createPolyline(px(r.outline.slice(0, -1)), true, "outside", cut));
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}
