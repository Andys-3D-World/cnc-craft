/**
 * LASER-TESTKARTE – Fenster mit Vorschau. Rechnung: testCard.ts, Ablesen nach dem Lasern: testCardRead.ts.
 */
import { loadSettings, matchDefaults, saveSettings } from "./genRun";
import { app, bedSizeMm } from "./editorState";
import { createPolyline, MM_TO_PIXEL, newId, type Pt } from "../shapeTransform";
import type { LaserLayer } from "../laserLayers";
import { ensureLayer } from "./materialTest";
import { labelLoops } from "../materialGrid";
import { traceSingleLine } from "./singleLine";
import { isLaser } from "../machineMode";
import { machine } from "../machine";
import { t } from "../i18n/i18n";
import { buildCard, DEFAULT_CARD, LASER_TYPES, PANEL_IDS, type CardResult, type Role, type TestCardOptions } from "../testCard";
import { helpHtml, openTestCardRead, latestCardOnBed } from "./testCardRead";

const KEY = "cnc_craft_test_card";

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function cleanCard(raw: any): TestCardOptions {
  const o: TestCardOptions = { ...DEFAULT_CARD, ...matchDefaults(DEFAULT_CARD, raw) };
  o.panels = (Array.isArray(o.panels) ? o.panels : DEFAULT_CARD.panels).filter(p => (PANEL_IDS as readonly string[]).includes(p));
  if (!(LASER_TYPES as readonly string[]).includes(o.laserType)) o.laserType = "other";
  o.material = String(o.material).slice(0, 60);
  o.machine = String(o.machine).slice(0, 60);
  return o;
}

function load(): TestCardOptions {
  try { return cleanCard(JSON.parse(loadSettings(KEY) || "{}")); } catch { return { ...DEFAULT_CARD }; }
}

export function validCard(o: TestCardOptions): boolean {
  const ok = (v: number, min: number, max: number) => Number.isFinite(v) && v >= min && v <= max;
  const pw = (v: number) => ok(v, 0, 100), sp = (v: number) => ok(v, 1, 100000);
  return ok(o.cardW, 30, 2000) && ok(o.cardH, 30, 2000) && ok(o.thickness, 0, 50) && ok(o.laserW, 0, 100000)
    && pw(o.ePMin) && pw(o.ePMax) && ok(o.eCols, 1, 15) && sp(o.eSMin) && sp(o.eSMax) && ok(o.eRows, 1, 15) && ok(o.interval, 0.01, 10)
    && pw(o.cPMin) && pw(o.cPMax) && ok(o.cCols, 1, 15) && sp(o.cSMin) && sp(o.cSMax) && ok(o.cRows, 1, 15)
    && pw(o.refPower) && sp(o.refSpeed) && pw(o.cutPower) && sp(o.cutSpeed) && ok(o.iMin, 0.01, 10) && ok(o.iMax, 0.01, 10)
    && ok(o.scanMax, 0.01, 2) && ok(o.kerfMax, 0.05, 1) && pw(o.textPower) && sp(o.textSpeed) && ok(o.cell, 3, 40);
}

const LAYER_DATA = (o: TestCardOptions): Record<Role, Partial<LaserLayer>> => ({
  text: { mode: "line", power: o.textPower, speed: o.textSpeed, passes: 1 },
  engrave: { mode: "fill", power: o.refPower, speed: o.refSpeed, interval: o.interval, passes: 1, air: false },
  line: { mode: "line", power: o.refPower, speed: o.refSpeed, passes: 1, air: false },
  cut: { mode: "line", power: o.cutPower, speed: o.cutSpeed, passes: 1, air: o.cutAir }
});

async function insertCard(o: TestCardOptions, card: CardResult): Promise<number> {
  const ox = 10, oy = 10;
  const toW = (pts: { x: number; y: number }[]): Pt[] => pts.map(q => ({ x: (ox + q.x) * MM_TO_PIXEL, y: (oy + q.y) * MM_TO_PIXEL }));
  const data = LAYER_DATA(o);
  const layerId = (role: Role) => ensureLayer(t("tcard.layer." + role), data[role]).id;
  const ids: Partial<Record<Role, string>> = {};
  const id = (r: Role) => (ids[r] ??= layerId(r));
  const gid = "tcard-" + newId(), src = t("tcard.title");
  const made: any[] = [];
  for (const it of card.items) {
    if (it.kind === "poly") {
      made.push(createPolyline(toW(it.pts), it.closed, "on-line", { groupId: gid, source: src, laserLayerId: id(it.role), laserOverride: it.ov, ...(it.cell ? { cardCell: it.cell } : {}) }));
      continue;
    }
    const tr = await traceSingleLine({ text: it.text, font: "", heightMm: it.h, bold: false, italic: false, align: "left", lineSpacing: 170, letterSpacing: 0 });
    if (!tr.loops.length) continue;
    labelLoops({ text: it.text, x: it.x, y: it.y, align: it.align, rot: it.rot }, tr).forEach((pts, i) => {
      made.push(createPolyline(toW(pts), tr.closed?.[i] ?? false, "on-line", { groupId: gid, source: src, laserLayerId: id("text"), laserOverride: it.ov }));
    });
  }
  const st = app();
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
  return made.length;
}

function previewSvg(o: TestCardOptions, card: CardResult): string {
  const sy = (y: number) => o.cardH - y;
  const pathOf = (pts: { x: number; y: number }[], closed: boolean) => pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)} ${sy(p.y).toFixed(2)}`).join("") + (closed ? "Z" : "");
  const out = [`<rect x="0" y="0" width="${o.cardW}" height="${o.cardH}" fill="#c98a4b"/>`];
  for (const it of card.items) {
    if (it.kind === "poly") {
      const a = (0.15 + 0.8 * it.ov.power / 100).toFixed(2);
      out.push(it.role === "engrave"
        ? `<path d="${pathOf(it.pts, it.closed)}" fill="#2a1a0c" fill-opacity="${a}"/>`
        : `<path d="${pathOf(it.pts, it.closed)}" fill="none" stroke="${it.role === "cut" ? "#e02020" : "#2a1a0c"}" stroke-width="0.25"/>`);
    } else {
      const x0 = it.rot ? it.x + it.h * 0.35 : it.x, y0 = sy(it.y);
      const anchor = it.rot ? "start" : it.align === "right" ? "end" : it.align === "center" ? "middle" : "start";
      out.push(`<text x="${x0.toFixed(2)}" y="${y0.toFixed(2)}" font-size="${it.h * 1.3}" fill="#2a1a0c" text-anchor="${anchor}"${it.rot ? ` transform="rotate(-90 ${x0.toFixed(2)} ${y0.toFixed(2)})"` : ""}>${esc(it.text)}</text>`);
    }
  }
  return out.join("");
}

export function openTestCardDialog(log: (s: string) => void, done: () => void) {
  const o = load();
  document.getElementById("tc-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "tc-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: keyof TestCardOptions, key: string, step: string, unit: string) => `
    <label class="dlg-row"><span>${esc(t(key))}</span><span class="dlg-num"><input id="tc-${id}" type="number" value="${o[id] as number}" step="${step}"><em>${unit}</em></span></label>`;
  const sect = (key: string, body: string) => `<div class="tc-sect">${esc(t(key))}</div>${body}`;
  const hasOld = !!latestCardOnBed();
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:860px;">
      <h3>🧾 ${esc(t("tcard.title"))}</h3>
      <div class="dlg-hint">${esc(t("tcard.desc"))}</div>
      ${isLaser() ? "" : `<div class="dlg-hint" style="color:var(--lt-amber, #ffb454);">${esc(t("tcard.notLaser"))}</div>`}
      <div class="box-grid" style="grid-template-columns:300px 1fr;">
        <div class="box-fields tc-fields">
          ${sect("tcard.s.card", `
          <label class="dlg-row"><span>${esc(t("tcard.laserType"))}</span><select id="tc-laserType" style="width:120px;">${LASER_TYPES.map(k => `<option value="${k}">${esc(t("tcard.type." + k))}</option>`).join("")}</select></label>
          ${num("laserW", "tcard.laserW", "1", "W")}
          ${num("cardW", "tcard.cardW", "5", "mm")}
          ${num("cardH", "tcard.cardH", "5", "mm")}
          <label class="dlg-row"><span>${esc(t("tcard.material"))}</span><input id="tc-material" type="text" maxlength="60" value="${esc(o.material)}" style="width:120px;"></label>
          ${num("thickness", "tcard.thickness", "0.5", "mm")}
          <label class="dlg-row"><span>${esc(t("tcard.machine"))}</span><input id="tc-machine" type="text" maxlength="60" value="${esc(o.machine)}" style="width:120px;"></label>
          <label class="dlg-row" style="cursor:pointer;" data-tip="${esc(t("tcard.headerTip"))}"><span>${esc(t("tcard.header"))}</span><input id="tc-header" type="checkbox" ${o.header ? "checked" : ""} style="width:auto;"></label>
          <label class="dlg-row" style="cursor:pointer;"><span>${esc(t("tcard.outline"))}</span><input id="tc-outline" type="checkbox" ${o.outline ? "checked" : ""} style="width:auto;"></label>
          ${num("cell", "mt.cell", "0.5", "mm")}`)}
          ${sect("tcard.s.engrave", `
          ${num("ePMin", "mt.pMin", "5", "%")}${num("ePMax", "mt.pMax", "5", "%")}${num("eCols", "mt.cols", "1", "")}
          ${num("eSMin", "tcard.sMin", "100", "mm/min")}${num("eSMax", "tcard.sMax", "100", "mm/min")}${num("eRows", "mt.rows", "1", "")}
          ${num("interval", "laser.interval", "0.01", "mm")}${num("iMin", "tcard.iMin", "0.01", "mm")}${num("iMax", "tcard.iMax", "0.01", "mm")}
          ${num("refPower", "tcard.refPower", "1", "%")}${num("refSpeed", "tcard.refSpeed", "100", "mm/min")}${num("scanMax", "tcard.scanMax", "0.05", "mm")}`)}
          ${sect("tcard.s.cut", `
          ${num("cPMin", "mt.pMin", "5", "%")}${num("cPMax", "mt.pMax", "5", "%")}${num("cCols", "mt.cols", "1", "")}
          ${num("cSMin", "tcard.sMin", "10", "mm/min")}${num("cSMax", "tcard.sMax", "10", "mm/min")}${num("cRows", "mt.rows", "1", "")}
          ${num("cutPower", "tcard.cutPower", "1", "%")}${num("cutSpeed", "tcard.cutSpeed", "10", "mm/min")}${num("kerfMax", "tcard.kerfMax", "0.05", "mm")}
          <label class="dlg-row" style="cursor:pointer;"><span>${esc(t("tcard.cutAir"))}</span><input id="tc-cutAir" type="checkbox" ${o.cutAir ? "checked" : ""} style="width:auto;"></label>`)}
          ${sect("tcard.s.text", `${num("textPower", "mt.labelPower", "1", "%")}${num("textSpeed", "mt.labelSpeed", "100", "mm/min")}`)}
        </div>
        <div>
          <div class="box-prev"><svg id="tc-svg" viewBox="0 0 100 100" style="height:320px;"></svg><div id="tc-info" class="dlg-hint"></div></div>
          <div id="tc-warn" class="dlg-hint" style="color:var(--lt-amber, #ffb454);"></div>
          <div class="tc-sect">${esc(t("tcard.s.panels"))}</div>
          <div class="tc-panels">${PANEL_IDS.map(p => `<label data-tip="${esc(t("tcard.read." + p))}"><input type="checkbox" data-panel="${p}" ${o.panels.includes(p) ? "checked" : ""}> ${esc(t("tcard.p." + p))}</label>`).join("")}</div>
          <div id="tc-focus-box" class="tc-focus">
            <div class="dlg-hint" style="color:var(--lt-amber, #ffb454);">⚠ ${esc(t("tcard.focusWarn"))}</div>
            ${num("focusStep", "tcard.focusStep", "0.1", "mm")}${num("focusSteps", "tcard.focusSteps", "1", "")}
            <label class="dlg-row" style="cursor:pointer;"><span>${esc(t("tcard.zConfirm"))}</span><input id="tc-zConfirmed" type="checkbox" ${o.zConfirmed ? "checked" : ""} style="width:auto;"></label>
            <div id="tc-focus-info" class="dlg-hint"></div>
          </div>
          <details class="tc-help"><summary>${esc(t("tcard.helpTitle"))}</summary>${helpHtml()}</details>
        </div>
      </div>
      <div class="dlg-hint">${esc(t("tcard.hint"))}</div>
      <div class="dlg-buttons">
        ${hasOld ? `<button id="tc-read" class="btn-secondary">🔍 ${esc(t("tcard.readButton"))}</button>` : ""}
        <button id="tc-cancel" class="btn-secondary">${esc(t("dlg.cancel"))}</button>
        <button id="tc-ok" class="btn-primary">✔ ${esc(t("tcard.create"))}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  $<HTMLSelectElement>("tc-laserType").value = o.laserType;

  const read = (): TestCardOptions => {
    const out: any = { ...o };
    for (const [k, d] of Object.entries(DEFAULT_CARD)) {
      const el = ov.querySelector(`#tc-${k}`) as HTMLInputElement | null;
      if (!el) continue;
      out[k] = typeof d === "number" ? parseFloat(el.value) : typeof d === "boolean" ? el.checked : el.value;
    }
    for (const k of ["eCols", "eRows", "cCols", "cRows", "focusSteps"]) out[k] = Math.round(out[k]);
    out.panels = PANEL_IDS.filter(p => (ov.querySelector(`[data-panel="${p}"]`) as HTMLInputElement).checked);
    return out;
  };

  /** Z-Achse: verbundenes Board sagt keine Z-Strecke -> keine Fokus-Leiter */
  const noZ = () => machine.connected && !(parseFloat(machine.settings.get("$132") ?? "1") > 0);

  const preview = () => {
    const m = read();
    const focusOn = m.panels.includes("focus");
    $<HTMLElement>("tc-focus-box").style.display = focusOn ? "" : "none";
    if (noZ()) { $("tc-zConfirmed").checked = false; $("tc-zConfirmed").disabled = true; m.zConfirmed = false; }
    const svg = $<HTMLElement>("tc-svg") as unknown as SVGSVGElement;
    const ok = validCard(m);
    $<HTMLButtonElement>("tc-ok").disabled = !ok;
    const info = $<HTMLElement>("tc-info"), warn = $<HTMLElement>("tc-warn");
    if (!ok) { svg.innerHTML = ""; info.textContent = t("tcard.invalid"); warn.textContent = ""; return; }
    const card = buildCard(m, t);
    svg.setAttribute("viewBox", `-2 -2 ${m.cardW + 4} ${m.cardH + 4}`);
    svg.innerHTML = previewSvg(m, card);
    const fields = card.items.filter(i => i.kind === "poly" && i.cell).length;
    info.textContent = t("tcard.info", { w: m.cardW, h: m.cardH, n: card.placed.length, f: fields, s: Math.round(card.scale * 100) });
    const lines: string[] = [];
    if (card.left.length) lines.push(t("tcard.w.left", { list: card.left.map(p => t("tcard.p." + p)).join(", ") }));
    if (card.focusRefused) lines.push(noZ() ? t("tcard.w.noZ") : t("tcard.w.focus"));
    const bed = bedSizeMm();
    if (m.cardW + 10 > bed.w || m.cardH + 10 > bed.h) lines.push(t("tcard.w.bed", { w: bed.w, h: bed.h }));
    warn.textContent = lines.join(" ");
    const fi = $<HTMLElement>("tc-focus-info");
    if (focusOn && Number.isFinite(m.focusStep) && Number.isFinite(m.focusSteps))
      fi.textContent = t("tcard.focusInfo", { up: +(m.focusStep * (m.focusSteps - 1)).toFixed(2), n: m.focusSteps, s: m.focusStep });
  };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener("input", preview));
  preview();
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("tc-cancel").onclick = close;
  const readBtn = ov.querySelector("#tc-read") as HTMLElement | null;
  if (readBtn) readBtn.onclick = () => { const c = latestCardOnBed(); if (c) { close(); openTestCardRead(c.shapes, c.settings, log); } };
  $<HTMLElement>("tc-ok").onclick = async () => {
    const m = read();
    if (!validCard(m)) return;
    const card = buildCard(m, t);
    saveSettings(KEY, m);
    close();
    try {
      const n = await insertCard(m, card);
      log(t("tcard.done", { n, p: card.placed.length }));
      if (card.left.length) log("⚠ " + t("tcard.w.left", { list: card.left.map(p => t("tcard.p." + p)).join(", ") }));
    } catch {
      log(t("mt.fontError"));
    }
    done();
  };
}
