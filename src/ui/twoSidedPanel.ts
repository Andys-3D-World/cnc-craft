/**
 * ZWEISEITIG FRÄSEN – Bedienung (Rechnung: twoSided.ts, Programme: twoSidedJob.ts, Seiten je Bett: editor/beds.ts)
 *
 *  - Abschnitt „Zweiseitig fräsen“ im Reiter Fräsen: Einrichten, Seite zeigen, Auswahl auf die andere Seite
 *    kopieren/verschieben, Tiefe „durchfräsen“, beide Seiten prüfen
 *  - Fenster „Einrichten“: Rohteil, Wenderichtung, Z-Nullpunkt, Passstifte – mit Live-Vorschau auf der Zeichenfläche
 *  - Zeichenfläche: Rohteil, Wendelinie, Stifte und die andere Seite blass und gespiegelt
 *
 * Hier wird nichts an die Maschine geschickt. Texte aus Werkzeug-Namen gehen durch esc().
 */
import { dropLinks } from "../editor/linked";
import { isLinked, unlinkShapes } from "../linkedCopies";
import { t, T, tip } from "../i18n/i18n";
import { app, bedSizeMm } from "../editor/editorState";
import { bedSetup, hiddenShapes, setBedSetup, setHiddenShapes, showSide, sideShapes, twoSidedOn, viewSide } from "../editor/beds";
import { putHistory } from "../editor/history";
import { selectedShapes } from "../editor/selection";
import { makeCopies } from "../editor/commands";
import { isLight } from "../theme";
import { tracePath } from "../render";
import { MM_TO_PIXEL, cloneShape, groupBounds } from "../shapeTransform";
import { getTools, activeTool, cutDiameter } from "../toolLibrary";
import { updateDimensionInputs } from "../uiInputs";
import { fmtLenShort, unitName } from "../units";
import { esc } from "../setupSheet";
import { openToolPanel, rowCss, checkCss, type ToolPanel } from "./toolPanel";
import {
  cloneSetup, defaultPins, defaultSetup, flipLine, mirrorPoint, mirrorShape, remapBackShape, MAX_PINS,
  type Side, type TwoSidedSetup,
} from "../twoSided";
import { activeSetup, depthWarnings, partBoxes, pinWarnings, setThroughDepth } from "../twoSidedJob";

let redraw = () => {};
let log: (s: string) => void = () => {};

export function twoSidedSectionHtml(): string {
  return `
    <div class="menu-section-unified only-mill">
      <h3 class="menu-trigger">${T("two.title")}</h3>
      <div class="menu-body rp-box">
        <div id="two-status" class="tool-info"></div>
        <button id="two-setup" class="btn-secondary btn-compact" ${tip("two.setupTip")}>⇄ ${T("two.setup")}</button>
        <div id="two-tools" style="display:none;flex-direction:column;gap:6px;">
          <div class="rp-grid2">
            <button id="two-show-front" class="btn-secondary btn-compact" ${tip("two.sideTip")}>${T("two.front")}</button>
            <button id="two-show-back" class="btn-secondary btn-compact" ${tip("two.sideTip")}>${T("two.back")}</button>
          </div>
          <button id="two-copy" class="btn-secondary btn-compact" ${tip("two.copyTip")}>⧉ ${T("two.copy")}</button>
          <button id="two-move" class="btn-secondary btn-compact" ${tip("two.moveTip")}>➜ ${T("two.move")}</button>
          <button id="two-through" class="btn-secondary btn-compact" ${tip("two.throughTip")}>⤓ ${T("two.through")}</button>
          <button id="two-check" class="btn-secondary btn-compact" ${tip("two.checkTip")}>✔ ${T("two.check")}</button>
        </div>
        <div class="tool-scope">${T("two.hint")}</div>
      </div>
    </div>`;
}

const sideName = (s: Side) => t(s === "front" ? "two.front" : "two.back");
const turnName = (s: TwoSidedSetup) => t(s.flip === "lr" ? "two.turnLr" : "two.turnFb");
const partCount = (list: any[]) => new Set(list.map(s => s.groupId || s.id)).size;

/** Einstellungen übernehmen. Ändert sich die Wendelinie, wandern die Rückseiten-Formen mit (gleiche Stelle am Teil) */
function applySetup(next: TwoSidedSetup | null) {
  const old = bedSetup();
  if (old && next) {
    const a = flipLine(old), b = flipLine(next);
    if (a.along !== b.along || Math.abs(a.at - b.at) > 1e-9) {
      const back = sideShapes("back");
      for (const s of back) remapBackShape(s, old, next);
      // Rückgängig würde die Formen ohne die Einstellung zurückdrehen – der Verlauf der Rückseite beginnt neu
      if (back.length) { if (viewSide() === "back") putHistory(null); else setHiddenShapes(back); }
    }
  }
  setBedSetup(next);
}

/** Erstes Einrichten: Rohteil um die Zeichnung (20 mm Rand), innerhalb des Betts */
function firstSetup(): TwoSidedSetup {
  const s = defaultSetup();
  s.on = true;
  fitStock(s);
  s.pins = defaultPins(s, partBoxes(s));
  return s;
}

function fitStock(s: TwoSidedSetup) {
  const bed = bedSizeMm(), b = groupBounds(app().shapes);
  if (!b || ![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite)) { s.stock = { x: 20, y: 20, w: Math.max(10, Math.min(200, bed.w - 40)), h: Math.max(10, Math.min(150, bed.h - 40)) }; return; }
  const m = 20, r = (v: number) => Math.round(v * 10) / 10;
  const x0 = Math.max(0, b.minX / MM_TO_PIXEL - m), y0 = Math.max(0, b.minY / MM_TO_PIXEL - m);
  const x1 = Math.min(bed.w, b.maxX / MM_TO_PIXEL + m), y1 = Math.min(bed.h, b.maxY / MM_TO_PIXEL + m);
  s.stock = { x: r(x0), y: r(y0), w: r(Math.max(10, x1 - x0)), h: r(Math.max(10, y1 - y0)) };
}

// =====================================================================
// FENSTER „EINRICHTEN“
// =====================================================================

function pinRowsHtml(s: TwoSidedSetup): string {
  return s.pins.map((p, i) => `
    <div class="two-pin" style="display:flex;gap:6px;align-items:center;font-size:0.82rem;">
      <span style="width:18px;color:var(--text-muted);">${i + 1}</span>
      X <input type="number" data-unit="mm" class="prop-input two-px" data-i="${i}" value="${+p.x.toFixed(3)}" step="1" style="width:74px;">
      Y <input type="number" data-unit="mm" class="prop-input two-py" data-i="${i}" value="${+p.y.toFixed(3)}" step="1" style="width:74px;">
      <button type="button" class="btn-secondary two-pin-del" data-i="${i}" style="padding:1px 7px;" title="${esc(t("two.pinDel"))}">×</button>
    </div>`).join("");
}

export function openTwoSidedDialog() {
  const before = bedSetup() ? cloneSetup(bedSetup()!) : null;
  let cur: TwoSidedSetup = before ? cloneSetup(before) : firstSetup();
  if (!before) applySetup(cloneSetup(cur));
  let kept = false;
  const num = (label: string, id: string, v: number, min: number, step = 1) =>
    `<label style="${rowCss}">${label}<input type="number" id="${id}" data-unit="mm" class="prop-input" value="${+v.toFixed(3)}" min="${min}" step="${step}" style="width:84px;"></label>`;
  const tools = getTools();
  const toolOpts = `<option value="">${esc(t("two.pinToolStd", { name: activeTool ? activeTool.name : "–" }))}</option>`
    + tools.map(tl => `<option value="${esc(tl.id)}"${tl.id === cur.pinToolId ? " selected" : ""}>${esc(tl.name)} (Ø ${cutDiameter(tl)})</option>`).join("");

  const readPins = (p: ToolPanel) => {
    const xs = p.el.querySelectorAll<HTMLInputElement>(".two-px"), ys = p.el.querySelectorAll<HTMLInputElement>(".two-py");
    return Array.from(xs).map((x, i) => ({ x: parseFloat(x.value), y: parseFloat(ys[i].value) })).filter(q => Number.isFinite(q.x) && Number.isFinite(q.y));
  };
  const showPins = (p: ToolPanel) => { p.$<HTMLElement>("#two-pins").innerHTML = pinRowsHtml(cur); };

  const panel = openToolPanel({
    id: "two-sided-panel", ico: "mirrorH", title: t("two.title"), ok: "✔ " + t("two.apply"), redraw: () => redraw(),
    body: `
      <label style="${checkCss}"><input type="checkbox" id="two-on" ${cur.on ? "checked" : ""}> ${t("two.on")}</label>
      <label style="${rowCss}">${t("two.flip")}
        <select id="two-flip" class="prop-input" style="width:170px;">
          <option value="lr"${cur.flip === "lr" ? " selected" : ""}>${t("two.turnLr")}</option>
          <option value="fb"${cur.flip === "fb" ? " selected" : ""}>${t("two.turnFb")}</option>
        </select></label>
      <div style="font-size:0.78rem;color:var(--text-muted);" id="two-flip-note"></div>
      <b style="font-size:0.85rem;">${t("two.stock")}</b>
      ${num(t("two.stockX"), "two-sx", cur.stock.x, -100000)}
      ${num(t("two.stockY"), "two-sy", cur.stock.y, -100000)}
      ${num(t("two.stockW"), "two-sw", cur.stock.w, 1)}
      ${num(t("two.stockH"), "two-sh", cur.stock.h, 1)}
      ${num(t("two.thickness"), "two-t", cur.thickness, 0.1, 0.5)}
      <button type="button" class="btn-secondary btn-compact" id="two-fit">${t("two.fit")}</button>
      <label style="${rowCss}">${t("two.zRef")}
        <select id="two-zref" class="prop-input" style="width:170px;">
          <option value="spoil"${cur.zRef === "spoil" ? " selected" : ""}>${t("two.zRef.spoil")}</option>
          <option value="top"${cur.zRef === "top" ? " selected" : ""}>${t("two.zRef.top")}</option>
        </select></label>
      <div style="font-size:0.78rem;color:var(--text-muted);" id="two-z-note"></div>
      <b style="font-size:0.85rem;">${t("two.pins")}</b>
      <label style="${checkCss}"><input type="checkbox" id="two-pins-on" ${cur.pinsOn ? "checked" : ""}> ${t("two.pinsOn")}</label>
      ${num(t("two.pinDia"), "two-pd", cur.pinDia, 0.5, 0.5)}
      ${num(t("two.pinDepth"), "two-pz", cur.pinDepth, 0, 0.5)}
      <label style="${rowCss}">${t("two.pinTool")}<select id="two-ptool" class="prop-input" style="width:170px;">${toolOpts}</select></label>
      <div id="two-pins" style="display:flex;flex-direction:column;gap:4px;">${pinRowsHtml(cur)}</div>
      <div style="display:flex;gap:6px;">
        <button type="button" class="btn-secondary btn-compact" id="two-pin-add" style="flex:1;">＋ ${t("two.pinAdd")}</button>
        <button type="button" class="btn-secondary btn-compact" id="two-pin-auto" style="flex:1;">${t("two.pinAuto")}</button>
      </div>
      <div id="two-warn" style="font-size:0.78rem;color:var(--lt-amber, #ffb454);white-space:pre-line;"></div>`,
    onChange: p => {
      const lineBefore = flipLine(cur), diaBefore = cur.pinDia;
      cur.on = p.check("#two-on");
      cur.flip = p.$<HTMLSelectElement>("#two-flip").value === "fb" ? "fb" : "lr";
      cur.stock = { x: p.num("#two-sx", cur.stock.x), y: p.num("#two-sy", cur.stock.y), w: Math.max(1, p.num("#two-sw", cur.stock.w)), h: Math.max(1, p.num("#two-sh", cur.stock.h)) };
      cur.thickness = Math.max(0.1, p.num("#two-t", cur.thickness));
      cur.zRef = p.$<HTMLSelectElement>("#two-zref").value === "top" ? "top" : "spoil";
      cur.pinsOn = p.check("#two-pins-on");
      cur.pinDia = Math.max(0.5, p.num("#two-pd", cur.pinDia));
      cur.pinDepth = Math.max(0, p.num("#two-pz", cur.pinDepth));
      cur.pinToolId = p.$<HTMLSelectElement>("#two-ptool").value || undefined;
      const typed = readPins(p);
      if (JSON.stringify(typed) !== JSON.stringify(cur.pins.map(q => ({ x: +q.x.toFixed(3), y: +q.y.toFixed(3) })))) { cur.pins = typed; cur.pinsAuto = false; }
      const line = flipLine(cur);
      const moved = line.along !== lineBefore.along || Math.abs(line.at - lineBefore.at) > 1e-9 || cur.pinDia !== diaBefore;
      applySetup(cloneSetup(cur));
      // Stifte folgen dem Rohteil, solange sie niemand von Hand gesetzt hat
      if (cur.pinsAuto && moved) { cur.pins = defaultPins(cur, partBoxes(cur)); showPins(p); applySetup(cloneSetup(cur)); }
      p.$<HTMLElement>("#two-flip-note").textContent = t(cur.flip === "lr" ? "two.flipNote.lr" : "two.flipNote.fb");
      p.$<HTMLElement>("#two-z-note").textContent = t(cur.zRef === "spoil" ? "two.zNote.spoil" : "two.zNote.top", { t: cur.thickness });
      const bed = bedSizeMm(), st = cur.stock;
      const warn = cur.on ? [...pinWarnings(cur), ...depthWarnings(cur)] : [];
      if (cur.on && (st.x < 0 || st.y < 0 || st.x + st.w > bed.w || st.y + st.h > bed.h)) warn.unshift(t("two.w.stockOffBed"));
      p.$<HTMLElement>("#two-warn").textContent = warn.join("\n");
      p.info(cur.on ? t("two.info", { turn: turnName(cur) }) : t("two.infoOff"));
    },
    onOk: () => {
      kept = true;
      applySetup(cloneSetup(cur));
      log(cur.on ? t("two.applied", { w: cur.stock.w, h: cur.stock.h, t: cur.thickness, turn: turnName(cur), n: cur.pinsOn ? cur.pins.length : 0 }) : t("two.off"));
    },
    onClose: () => { if (!kept) applySetup(before); refreshTwoSided(true); },
  });

  const el = panel.el, fire = () => el.dispatchEvent(new Event("change", { bubbles: true }));
  el.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!b) return;
    if (b.id === "two-fit") {
      fitStock(cur);
      (["sx", "sy", "sw", "sh"] as const).forEach((k, i) => { panel.$("#two-" + k).value = String([cur.stock.x, cur.stock.y, cur.stock.w, cur.stock.h][i]); });
      fire();
    } else if (b.id === "two-pin-auto") {
      cur.pinsAuto = true;
      cur.pins = defaultPins(cur, partBoxes(cur));
      showPins(panel); applySetup(cloneSetup(cur)); fire();
    } else if (b.id === "two-pin-add") {
      if (cur.pins.length >= MAX_PINS) return;
      // neuer Stift mit seinem gespiegelten Partner beginnt in der Mitte der Wendelinie – dort passt er immer
      const l = flipLine(cur), st = cur.stock;
      cur.pins.push(l.along === "y" ? { x: l.at, y: st.y + st.h / 2 } : { x: st.x + st.w / 2, y: l.at });
      cur.pinsAuto = false;
      showPins(panel); applySetup(cloneSetup(cur)); fire();
    } else if (b.classList.contains("two-pin-del")) {
      cur.pins.splice(Number(b.dataset.i), 1);
      cur.pinsAuto = false;
      showPins(panel); applySetup(cloneSetup(cur)); fire();
    }
  });
}

// =====================================================================
// ABSCHNITT IM REITER FRÄSEN
// =====================================================================

let shown = "";

/** Abschnitt auffrischen – wird bei jedem Neuzeichnen aufgerufen, tut nur etwas, wenn sich etwas geändert hat */
export function refreshTwoSided(force = false) {
  const st = document.getElementById("two-status");
  if (!st) return;
  const s = bedSetup(), on = twoSidedOn(), side = viewSide();
  const sig = JSON.stringify([s, side, on ? partCount(sideShapes("front")) : 0, partCount(sideShapes("back")), unitName()]);
  if (!force && sig === shown) return;
  shown = sig;
  const tools = document.getElementById("two-tools");
  if (tools) tools.style.display = on ? "flex" : "none";
  if (!s || !on) {
    // ausgeschaltet: Formen der Rückseite gehen nicht verloren – sagen, dass sie noch da sind
    const kept = partCount(hiddenShapes());
    st.textContent = kept ? t("two.statusOffKept", { n: kept }) : t("two.statusOff");
    return;
  }
  st.textContent = t("two.status", {
    w: fmtLenShort(s.stock.w, 1), h: fmtLenShort(s.stock.h, 1), t: fmtLenShort(s.thickness, 2), u: unitName(), turn: turnName(s),
    pins: s.pinsOn ? s.pins.length : 0, f: partCount(sideShapes("front")), b: partCount(sideShapes("back")), side: sideName(side),
  });
  document.getElementById("two-show-front")?.classList.toggle("btn-primary", side === "front");
  document.getElementById("two-show-front")?.classList.toggle("btn-secondary", side !== "front");
  document.getElementById("two-show-back")?.classList.toggle("btn-primary", side === "back");
  document.getElementById("two-show-back")?.classList.toggle("btn-secondary", side !== "back");
}

/** Auswahl gespiegelt auf die andere Seite legen (kopieren oder verschieben) */
function toOtherSide(move: boolean) {
  const s = activeSetup();
  if (!s) return;
  const sel = selectedShapes();
  if (!sel.length) { log(t("two.selectFirst")); return; }
  const st = app();
  // Gruppen bleiben zusammen
  const groups = new Set(sel.filter((x: any) => x.groupId).map((x: any) => x.groupId));
  const all = st.shapes.filter((x: any) => sel.includes(x) || (x.groupId && groups.has(x.groupId)));
  const copies = (move ? all.map(cloneShape) : makeCopies(all, 0)).map((c: any) => mirrorShape(c, s));
  // mirrored onto the other side: no linked copies there, and copies of a moved original become normal shapes
  dropLinks(copies);
  if (move) {
    const ids = new Set(all.map((x: any) => x.id));
    unlinkShapes(st.shapes.filter((x: any) => isLinked(x) && ids.has(x.link.of)));
    const gone = new Set(all);
    st.shapes = st.shapes.filter((x: any) => !gone.has(x));
    st.selectedShapeIds = [];
  }
  const other: Side = viewSide() === "front" ? "back" : "front";
  setHiddenShapes([...hiddenShapes(), ...copies]);
  log(t(move ? "two.moved" : "two.copied", { n: partCount(copies), side: sideName(other) }));
  redraw();
}

export function initTwoSidedPanel(onRedraw: () => void, onLog: (s: string) => void) {
  redraw = onRedraw;
  log = onLog;
  const on = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener("click", fn);
  on("two-setup", openTwoSidedDialog);
  on("two-show-front", () => { showSide("front"); log(t("two.viewFront")); });
  on("two-show-back", () => { showSide("back"); log(t("two.viewBack")); });
  on("two-copy", () => toOtherSide(false));
  on("two-move", () => toOtherSide(true));
  on("two-through", () => {
    const s = activeSetup();
    if (!s) return;
    const sel = selectedShapes();
    if (!sel.length) { log(t("two.selectFirst")); return; }
    const n = setThroughDepth(sel);
    updateDimensionInputs(null);
    log(t("two.throughDone", { n, d: Math.abs(sel[0].millingDepth), t: s.thickness }));
    redraw();
  });
  on("two-check", () => {
    const s = activeSetup();
    if (!s) return;
    const list = [...pinWarnings(s), ...depthWarnings(s)];
    if (!list.length) log(t("two.checkOk"));
    list.forEach(w => log(`${t("log.warning")} ${w}`));
  });
  window.addEventListener("cnc-language-changed", () => refreshTwoSided(true));
  refreshTwoSided(true);
}

// =====================================================================
// ZEICHENFLÄCHE: Rohteil, Wendelinie, Stifte, andere Seite blass
// =====================================================================

let ghost: { src: any[]; key: string; shapes: any[] } | null = null;

/** Die verdeckte Seite, gespiegelt in die gezeigte (nur neu gerechnet, wenn sich Liste oder Wendelinie ändern) */
function ghostShapes(s: TwoSidedSetup): any[] {
  const src = hiddenShapes(), l = flipLine(s), key = `${l.along}:${l.at}:${src.length}`;
  if (!ghost || ghost.src !== src || ghost.key !== key) ghost = { src, key, shapes: src.map(x => mirrorShape(cloneShape(x), s)) };
  return ghost.shapes;
}

/** Wird nach dem normalen Zeichnen aufgerufen (main.ts) – ohne Zweiseitig passiert nichts */
export function drawTwoSided(ctx: CanvasRenderingContext2D) {
  const s = activeSetup();
  if (!s) return;
  const st = app(), scale = st.scale, bh = bedSizeMm().h * MM_TO_PIXEL, K = MM_TO_PIXEL;
  const sx = (x: number) => x * scale + st.offsetX, sy = (y: number) => (bh - y) * scale + st.offsetY;
  const side = viewSide(), light = isLight();
  ctx.save();
  ctx.lineJoin = "round";
  // andere Seite: blass und gestrichelt (liegt unter dem Teil – nur zum Ausrichten)
  const other = ghostShapes(s);
  if (other.length) {
    ctx.strokeStyle = light ? "rgba(60,90,160,0.45)" : "rgba(130,170,255,0.4)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    for (const x of other) tracePath(ctx, x, sx, sy, scale);
    ctx.stroke();
  }
  // Rohteil
  const x0 = sx(s.stock.x * K), x1 = sx((s.stock.x + s.stock.w) * K), y0 = sy((s.stock.y + s.stock.h) * K), y1 = sy(s.stock.y * K);
  ctx.setLineDash([8, 4]);
  ctx.strokeStyle = light ? "rgba(120,80,20,0.75)" : "rgba(230,180,110,0.75)";
  ctx.lineWidth = 1.4;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  // Wendelinie (Strich-Punkt), ein Stück über das Rohteil hinaus
  const l = flipLine(s), over = 14;
  ctx.setLineDash([12, 4, 2, 4]);
  ctx.strokeStyle = "#ffb454";
  ctx.beginPath();
  if (l.along === "y") { ctx.moveTo(sx(l.at * K), y0 - over); ctx.lineTo(sx(l.at * K), y1 + over); }
  else { ctx.moveTo(x0 - over, sy(l.at * K)); ctx.lineTo(x1 + over, sy(l.at * K)); }
  ctx.stroke();
  ctx.setLineDash([]);
  // Stifte: in der Rückseiten-Ansicht dort, wo die Löcher des gewendeten Rohteils liegen
  if (s.pinsOn) {
    const r = Math.max(3, (s.pinDia / 2) * K * scale);
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.textAlign = "left";
    s.pins.forEach((p, i) => {
      const q = side === "back" ? mirrorPoint(p, s) : p, cx = sx(q.x * K), cy = sy(q.y * K);
      ctx.fillStyle = "rgba(255,180,84,0.25)";
      ctx.strokeStyle = "#ffb454";
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - r - 3, cy); ctx.lineTo(cx + r + 3, cy); ctx.moveTo(cx, cy - r - 3); ctx.lineTo(cx, cy + r + 3); ctx.stroke();
      ctx.fillStyle = "#ffb454";
      ctx.fillText(String(i + 1), cx + r + 5, cy - r - 2);
    });
  }
  // Beschriftung: welche Seite oben liegt
  ctx.font = "600 12px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = side === "back" ? "#ffb454" : light ? "#5a4a2a" : "#e6c9a0";
  ctx.fillText(t(side === "back" ? "two.canvasBack" : "two.canvasFront", { turn: turnName(s) }), x0, y1 + 16);
  ctx.restore();
}
