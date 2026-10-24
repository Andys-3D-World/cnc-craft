/**
 * MATERIAL-TESTRASTER (Laser, wie der "Material Test" in LightBurn)
 *
 * Ein Raster aus kleinen Feldern: von links nach rechts steigt die Leistung, von oben nach unten
 * die Geschwindigkeit (oder der Linienabstand beim Füllen). Jedes Feld bekommt seine Werte über
 * shape.laserOverride (siehe laserLayers.effectiveLayer) – so entstehen keine Dutzend neuen Ebenen.
 * Beschriftet wird mit der Einzellinien-Schrift (singleLine.ts) auf einer eigenen, schwachen Ebene.
 */
import { app } from "./editorState";
import { createPolyline, newId, MM_TO_PIXEL, Pt } from "../shapeTransform";
import { getLayers, addLayer, updateLayer, LaserLayer, LaserMode } from "../laserLayers";
import { traceSingleLine } from "./singleLine";
import { isLaser } from "../machineMode";
import { t } from "../i18n/i18n";

export type RowVar = "speed" | "interval";

export interface MaterialTestOptions {
  mode: "fill" | "line";
  rowVar: RowVar;       // was sich von oben nach unten ändert
  cols: number;         // Spalten = Leistungsstufen
  pMin: number; pMax: number;
  rows: number;         // Zeilen = Geschwindigkeits- bzw. Abstandsstufen
  rMin: number; rMax: number;
  speed: number;        // feste Geschwindigkeit, wenn die Zeilen den Linienabstand ändern
  interval: number;     // fester Linienabstand, wenn die Zeilen die Geschwindigkeit ändern
  passes: number;
  cell: number;         // Feldgröße in mm
  gap: number;          // Abstand zwischen den Feldern in mm
  labels: boolean;
  textH: number;        // Schrifthöhe der Beschriftung in mm
  labelPower: number;
  labelSpeed: number;
}

const KEY = "cnc_craft_material_test";
const DEF: MaterialTestOptions = {
  mode: "fill", rowVar: "speed", cols: 10, pMin: 10, pMax: 100, rows: 8, rMin: 1000, rMax: 6000,
  speed: 3000, interval: 0.1, passes: 1, cell: 10, gap: 2, labels: true, textH: 3, labelPower: 20, labelSpeed: 2000
};

function load(): MaterialTestOptions {
  try { return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...DEF }; }
}

/** Werte einer Stufe i von n zwischen a und b (gleichmäßig) */
export function step(a: number, b: number, i: number, n: number, digits: number): number {
  const v = n <= 1 ? a : a + ((b - a) * i) / (n - 1);
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

function valid(o: MaterialTestOptions): boolean {
  const ok = (v: number, min: number, max: number) => Number.isFinite(v) && v >= min && v <= max;
  return ok(o.cols, 1, 30) && ok(o.rows, 1, 30) && ok(o.pMin, 0, 100) && ok(o.pMax, 0, 100) && ok(o.cell, 1, 200)
    && ok(o.gap, 0, 100) && ok(o.passes, 1, 100) && ok(o.textH, 0.5, 50) && ok(o.labelPower, 0, 100) && ok(o.labelSpeed, 1, 100000)
    && (o.rowVar === "speed" ? ok(o.rMin, 1, 100000) && ok(o.rMax, 1, 100000) && ok(o.interval, 0.01, 10)
      : ok(o.rMin, 0.01, 10) && ok(o.rMax, 0.01, 10) && ok(o.speed, 1, 100000));
}

interface Cell { x: number; y: number; power: number; speed: number; interval: number }
interface Label { text: string; x: number; y: number; align: "right" | "center" | "left"; rot?: boolean }

/** Raster in mm (Y nach oben, linke untere Ecke des Feld-Blocks = 0,0) */
export function layoutTest(o: MaterialTestOptions): { cells: Cell[]; labels: Label[]; w: number; h: number } {
  const pitch = o.cell + o.gap;
  const h = o.rows * pitch - o.gap, w = o.cols * pitch - o.gap;
  const cells: Cell[] = [];
  const labels: Label[] = [];
  const rd = o.rowVar === "speed" ? 0 : 2;
  for (let r = 0; r < o.rows; r++) {
    const rv = step(o.rMin, o.rMax, r, o.rows, rd);
    const y = h - r * pitch - o.cell;
    for (let c = 0; c < o.cols; c++) {
      const p = step(o.pMin, o.pMax, c, o.cols, 1);
      cells.push({ x: c * pitch, y, power: p, speed: o.rowVar === "speed" ? rv : o.speed, interval: o.rowVar === "speed" ? o.interval : rv });
    }
    labels.push({ text: String(rv), x: -o.textH * 0.6, y: y + (o.cell - o.textH) / 2, align: "right" });
  }
  for (let c = 0; c < o.cols; c++)
    labels.push({ text: String(step(o.pMin, o.pMax, c, o.cols, 1)), x: c * pitch + o.cell / 2, y: h + o.textH * 0.6, align: "center", rot: o.cell < o.textH * 2.6 });
  // Achsen-Titel: oben links "%", darunter die Einheit der Zeilen
  labels.push({ text: o.rowVar === "speed" ? "mm/min" : "mm", x: -o.textH * 0.6, y: h + o.textH * 0.6, align: "right" });
  labels.push({ text: o.mode === "fill" && o.rowVar === "speed" ? `% ${o.interval}mm` : o.rowVar === "speed" ? "%" : `% ${o.speed}mm/min`,
    x: 0, y: h + o.textH * 2.2 + (o.cell < o.textH * 2.6 ? o.textH * 1.5 : 0), align: "left" });
  return { cells, labels, w, h };
}

/** Ebene mit diesem Namen holen oder anlegen und auf die Werte setzen */
function ensureLayer(name: string, data: Partial<LaserLayer>): LaserLayer {
  const ex = getLayers().find(l => l.name === name);
  if (ex) { updateLayer(ex.id, data); return getLayers().find(l => l.id === ex.id)!; }
  return addLayer({ name, ...data });
}

async function insertTest(o: MaterialTestOptions): Promise<number> {
  const L = layoutTest(o);
  // Platz links für die Beschriftung
  const ox = 10 + (o.labels ? o.textH * 4.5 : 0), oy = 10;
  const toW = (pts: Pt[]) => pts.map(q => ({ x: (ox + q.x) * MM_TO_PIXEL, y: (oy + q.y) * MM_TO_PIXEL }));
  const mode: LaserMode = o.mode;
  const testLayer = ensureLayer(t("mt.layer." + mode), { mode, passes: o.passes, interval: o.interval, speed: o.speed, power: o.pMax });
  const gid = "mtest-" + newId();
  const src = t("mt.title");
  const made: any[] = [];
  for (const c of L.cells) {
    const pts = [{ x: c.x, y: c.y }, { x: c.x + o.cell, y: c.y }, { x: c.x + o.cell, y: c.y + o.cell }, { x: c.x, y: c.y + o.cell }];
    made.push(createPolyline(toW(pts), true, "on-line", {
      groupId: gid, source: src, laserLayerId: testLayer.id,
      laserOverride: { power: c.power, speed: c.speed, interval: c.interval }
    }));
  }
  if (o.labels) {
    const labLayer = ensureLayer(t("mt.labelLayer"), { mode: "line", power: o.labelPower, speed: o.labelSpeed, passes: 1 });
    for (const lb of L.labels) {
      const tr = await traceSingleLine({ text: lb.text, font: "", heightMm: o.textH, bold: false, italic: false, align: "left", lineSpacing: 170, letterSpacing: 0 });
      if (!tr.loops.length) continue;
      // senkrecht (bei schmalen Feldern) = 90° gedreht, von unten nach oben lesbar
      const w = lb.rot ? tr.height : tr.width;
      const x0 = lb.align === "right" ? lb.x - w : lb.align === "center" ? lb.x - w / 2 : lb.x;
      tr.loops.forEach((loop, i) => {
        const pts = loop.map(q => lb.rot ? { x: x0 + tr.height - q.y, y: lb.y + q.x } : { x: x0 + q.x, y: lb.y + q.y });
        made.push(createPolyline(toW(pts), tr.closed?.[i] ?? false, "on-line", { groupId: gid, source: src, laserLayerId: labLayer.id }));
      });
    }
  }
  const st = app();
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
  return L.cells.length;
}

export function openMaterialTestDialog(log: (s: string) => void, done: () => void) {
  const o = load();
  document.getElementById("mt-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "mt-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, v: number, step: string, unit: string, extra = "") => `
      <label class="dlg-row" ${extra}><span>${t(key)}</span>
        <span class="dlg-num"><input id="${id}" type="number" value="${v}" step="${step}"><em>${unit}</em></span></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:600px;">
      <h3>🧪 ${t("mt.title")}</h3>
      <div class="dlg-hint">${t("mt.desc")}</div>
      ${isLaser() ? "" : `<div class="dlg-hint" style="color:#ffb454;">${t("mt.notLaser")}</div>`}
      <div class="box-grid">
        <div class="box-fields">
          <label class="dlg-row"><span>${t("mt.mode")}</span>
            <select id="mt-mode" style="width:150px;">
              <option value="fill">${t("laser.mode.fill")}</option>
              <option value="line">${t("laser.mode.line")}</option>
            </select></label>
          <label class="dlg-row" data-fill="1"><span>${t("mt.rowVar")}</span>
            <select id="mt-rowvar" style="width:150px;">
              <option value="speed">${t("laser.speed")}</option>
              <option value="interval">${t("laser.interval")}</option>
            </select></label>
          ${num("mt-cols", "mt.cols", o.cols, "1", "")}
          ${num("mt-pmin", "mt.pMin", o.pMin, "1", "%")}
          ${num("mt-pmax", "mt.pMax", o.pMax, "1", "%")}
          ${num("mt-rows", "mt.rows", o.rows, "1", "")}
          ${num("mt-rmin", "mt.rMin", o.rMin, "any", `<span id="mt-u1"></span>`)}
          ${num("mt-rmax", "mt.rMax", o.rMax, "any", `<span id="mt-u2"></span>`)}
          ${num("mt-speed", "laser.speed", o.speed, "100", "mm/min", 'data-iv="1"')}
          ${num("mt-interval", "laser.interval", o.interval, "0.01", "mm", 'data-sp="1"')}
          ${num("mt-passes", "laser.passes", o.passes, "1", "×")}
          ${num("mt-cell", "mt.cell", o.cell, "1", "mm")}
          ${num("mt-gap", "mt.gap", o.gap, "0.5", "mm")}
          <label class="dlg-row" style="cursor:pointer;"><span>${t("mt.labels")}</span><input id="mt-labels" type="checkbox" ${o.labels ? "checked" : ""} style="width:auto;"></label>
          ${num("mt-texth", "mt.textH", o.textH, "0.5", "mm", 'data-lab="1"')}
          ${num("mt-lpower", "mt.labelPower", o.labelPower, "1", "%", 'data-lab="1"')}
          ${num("mt-lspeed", "mt.labelSpeed", o.labelSpeed, "100", "mm/min", 'data-lab="1"')}
        </div>
        <div class="box-prev"><svg id="mt-svg" viewBox="0 0 100 100"></svg><div id="mt-info" class="dlg-hint"></div></div>
      </div>
      <div class="dlg-hint">${t("mt.hint")}</div>
      <div class="dlg-buttons">
        <button id="mt-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="mt-ok" class="btn-primary">✔ ${t("mt.create")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  $<HTMLSelectElement>("mt-mode").value = o.mode;
  $<HTMLSelectElement>("mt-rowvar").value = o.rowVar;
  let lastRowVar = o.rowVar;

  const read = (): MaterialTestOptions => {
    const n = (id: string) => parseFloat($(id).value);
    const mode = $<HTMLSelectElement>("mt-mode").value === "line" ? "line" : "fill";
    return {
      mode, rowVar: mode === "fill" && $<HTMLSelectElement>("mt-rowvar").value === "interval" ? "interval" : "speed",
      cols: Math.round(n("mt-cols")), pMin: n("mt-pmin"), pMax: n("mt-pmax"),
      rows: Math.round(n("mt-rows")), rMin: n("mt-rmin"), rMax: n("mt-rmax"),
      speed: n("mt-speed"), interval: n("mt-interval"), passes: Math.round(n("mt-passes")),
      cell: n("mt-cell"), gap: n("mt-gap"), labels: $("mt-labels").checked,
      textH: n("mt-texth"), labelPower: n("mt-lpower"), labelSpeed: n("mt-lspeed")
    };
  };

  const preview = () => {
    let m = read();
    // Zeilen-Größe gewechselt: passende Standardwerte (mm/min <-> mm)
    if (m.rowVar !== lastRowVar) {
      const d = m.rowVar === "speed" ? [DEF.rMin, DEF.rMax] : [0.05, 0.3];
      $("mt-rmin").value = String(d[0]); $("mt-rmax").value = String(d[1]);
      lastRowVar = m.rowVar;
      m = read();
    }
    const show = (sel: string, on: boolean) => ov.querySelectorAll<HTMLElement>(sel).forEach(el => { el.style.display = on ? "" : "none"; });
    show("[data-fill]", m.mode === "fill");
    show("[data-iv]", m.rowVar === "interval");
    show("[data-sp]", m.mode === "fill" && m.rowVar === "speed");
    show("[data-lab]", m.labels);
    const unit = m.rowVar === "speed" ? "mm/min" : "mm";
    $<HTMLElement>("mt-u1").textContent = unit; $<HTMLElement>("mt-u2").textContent = unit;
    const svg = $<HTMLElement>("mt-svg") as unknown as SVGSVGElement;
    const info = $<HTMLElement>("mt-info");
    const ok = valid(m);
    $<HTMLButtonElement>("mt-ok").disabled = !ok;
    if (!ok) { svg.innerHTML = ""; info.textContent = t("mt.invalid"); return; }
    const L = layoutTest(m);
    const lm = m.labels ? m.textH * 4.5 : 0, tm = m.labels ? m.textH * 4 : 0;
    svg.setAttribute("viewBox", `${-lm - 1} ${-tm - 1} ${L.w + lm + 2} ${L.h + tm + 2}`);
    const sy = (y: number) => L.h - y;
    const fs = m.textH;
    svg.innerHTML = L.cells.map(c => {
      const a = (0.1 + 0.85 * c.power / 100).toFixed(2);
      return m.mode === "fill"
        ? `<rect x="${c.x}" y="${sy(c.y + m.cell)}" width="${m.cell}" height="${m.cell}" fill="#8a5a2b" fill-opacity="${a}" stroke="#555" stroke-width="0.2"/>`
        : `<rect x="${c.x}" y="${sy(c.y + m.cell)}" width="${m.cell}" height="${m.cell}" fill="none" stroke="#8a5a2b" stroke-opacity="${a}" stroke-width="${Math.max(0.3, m.cell / 15)}"/>`;
    }).join("") + (m.labels ? L.labels.map(lb => {
      const anchor = lb.rot ? "start" : lb.align === "right" ? "end" : lb.align === "center" ? "middle" : "start";
      const tr = lb.rot ? ` transform="rotate(-90 ${lb.x + fs * 0.35} ${sy(lb.y)})"` : "";
      const x = lb.rot ? lb.x + fs * 0.35 : lb.x, y = sy(lb.y);
      return `<text x="${x}" y="${y}" font-size="${fs}" fill="currentColor" text-anchor="${anchor}"${tr}>${lb.text.replace(/[<&]/g, "")}</text>`;
    }).join("") : "");
    const pitch = m.cell + m.gap;
    info.textContent = t("mt.info", { n: L.cells.length, w: (L.w + lm).toFixed(0), h: (L.h + tm).toFixed(0),
      dp: step(m.pMin, m.pMax, 1, m.cols, 1) - m.pMin, pitch: pitch.toFixed(1) });
  };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener("input", preview));
  preview();
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") $<HTMLElement>("mt-ok").click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("mt-cancel").onclick = close;
  $<HTMLElement>("mt-ok").onclick = async () => {
    const m = read();
    if (!valid(m)) return;
    try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* egal */ }
    close();
    try {
      const n = await insertTest(m);
      log(t("mt.done", { n }));
    } catch {
      log(t("mt.fontError"));
    }
    done();
  };
}
