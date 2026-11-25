/**
 * FESTE SPANNPLÄTZE – Bedienung (Rechnung: places.ts, Speicher: placesStore.ts)
 *
 * Ein Platz merkt sich, wo an der Maschine das Rohteil immer anliegt. „Nullpunkt hierher“ setzt daraus X/Y, es FÄHRT NICHTS,
 * und Z bleibt immer, wie es ist. Nur GRBL-Familie und nur nach der Referenzfahrt: sonst stimmen Maschinen-Koordinaten nicht.
 * Texte (Namen) gehen durch esc().
 */
import { t, T, tip } from "../i18n/i18n";
import { machine, MACHINE_EVENT, sendAndWait } from "../machine";
import { app } from "../editor/editorState";
import { checkpoint } from "../editor/history";
import { viewSide } from "../editor/beds";
import { activeSetup } from "../twoSidedJob";
import { getMachineMode, isLathe, isPlasma, MODE_CHANGED } from "../machineMode";
import { KEEP_MARGIN } from "../keepOut";
import { rotary } from "../rotary";
import { esc } from "../setupSheet";
import { createPolyline, makeRectPoints, MM_TO_PIXEL, newId } from "../shapeTransform";
import { getStock, STOCK_CHANGED } from "../stock";
import { fmtLenU, reportsInches } from "../units";
import { WCS_LIST, type Wcs } from "../wcs";
import { selectWcs, wcsAvailable, wcsLocked } from "../wcsSync";
import { streamState } from "../machineStream";
import { loadedJobSide } from "../jobFlow";
import {
  CORNERS, JAW_DEFAULTS, MAX_PLACE_NAME, jaws, placeFromZero, zeroBlocked, zeroCommandFor, zeroFor, zeroOffset,
  type Corner, type Place, type XY,
} from "../places";
import { activePlace, dropPlace, machineKey, places, PLACES_CHANGED, putPlace, setActivePlace } from "../placesStore";
import { askChoice } from "./unsavedDialog";

let log: (s: string) => void = () => {};
let redraw = () => {};
let busy = false;

export function placesSectionHtml(): string {
  return `
    <div class="menu-section-unified not-lathe not-ruida not-k40 not-marlin">
      <h3 class="menu-trigger">${T("place.title")}</h3>
      <div class="menu-body rp-box">
        <div class="tool-scope">${T("place.hint")}</div>
        <select id="place-list" class="prop-input" style="width:100%;"></select>
        <div id="place-info" class="tool-info" style="line-height:1.45;"></div>
        <button id="place-zero" class="btn-primary btn-compact" ${tip("place.zeroTip")}>🎯 ${T("place.zero")}</button>
        <div class="rp-grid2">
          <button id="place-new" class="btn-secondary btn-compact">➕ ${T("place.new")}</button>
          <button id="place-edit" class="btn-secondary btn-compact">${T("place.edit")}</button>
          <button id="place-jaws" class="btn-secondary btn-compact only-mill" ${tip("place.jawsTip")}>${T("place.jaws")}</button>
          <button id="place-del" class="btn-secondary btn-compact">${T("rem.delete")}</button>
        </div>
      </div>
    </div>`;
}

const num = (k: string) => parseFloat(machine.settings.get(k) ?? "");
/** wie in limitGuard.ts: Referenzfahrt eingeschaltet und seither kein Alarm */
const homed = () => ((num("$22") | 0) & 1) === 1 && machine.homeState !== "lost" && machine.homeState !== "pending";
const currentZero = (): XY => ({ x: machine.status.mpos[0] - machine.status.wpos[0], y: machine.status.mpos[1] - machine.status.wpos[1] });

function blocked() {
  const back = !!activeSetup() && (streamState.loadedLines.length ? loadedJobSide() : viewSide()) === "back";
  return zeroBlocked({
    connected: machine.connected, grbl: wcsAvailable(), rotary: rotary.on && !isPlasma(), back,
    locked: busy || wcsLocked(), homed: homed(), inches: reportsInches(machine.settings.get("$13"))
  });
}
/** $$ holen, falls noch unbekannt – ohne $22 wüssten wir nicht, ob die Maschine referenziert */
async function needSettings() {
  if (machine.settings.has("$22") || wcsLocked()) return;
  try { await sendAndWait("$$", 5000, true); } catch { /* dann gilt „nicht referenziert“ */ }
}

export function initPlacesPanel(redrawFn: () => void, logFn: (s: string) => void) {
  redraw = redrawFn; log = logFn;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const sel = $<HTMLSelectElement>("place-list");
  if (!sel) return;

  let shown = "";
  const fillList = () => {
    const a = activePlace();
    sel.innerHTML = `<option value="">${esc(t(places().length ? "place.none" : "place.empty"))}</option>`
      + places().map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
    sel.value = a?.id || "";
    shown = "";
    refresh();
  };
  const refresh = () => {
    const a = activePlace(), s = getStock(), b = blocked();
    const lines: string[] = [];
    if (a) {
      lines.push(esc(t("place.info", { corner: t("place.c." + a.corner), x: fmtLenU(a.x), y: fmtLenU(a.y), w: fmtLenU(s.w), h: fmtLenU(s.h) })));
      if (machine.connected && wcsAvailable() && homed() && (!a.wcs || a.wcs === machine.wcs)) {
        const o = zeroOffset(currentZero(), zeroFor(a, s));
        lines.push(o.ok ? `<span style="color:var(--color-success,#34d17b);">✔ ${esc(t("place.match"))}</span>`
          : `<span style="color:var(--color-warning);">⚠ ${esc(t("place.differs", { dx: fmtLenU(o.dx), dy: fmtLenU(o.dy) }))}</span>`);
      }
      if (b) lines.push(esc(t("place.why." + b)));
    }
    const html = lines.join("<br>");
    if (html !== shown) { shown = html; $("place-info")!.innerHTML = html; }
    $<HTMLButtonElement>("place-zero")!.disabled = !a || (b !== "" && b !== "home"); // „home“: beim Klick erst $$ lesen, dann sagen, warum
    $<HTMLButtonElement>("place-edit")!.disabled = !a;
    $<HTMLButtonElement>("place-del")!.disabled = !a;
    $<HTMLButtonElement>("place-jaws")!.disabled = a?.kind !== "vise";
  };

  sel.addEventListener("change", () => { setActivePlace(sel.value); sel.blur(); });
  $("place-zero")!.addEventListener("click", () => { void zeroHere(); });
  $("place-new")!.addEventListener("click", () => openPlaceDialog(null));
  $("place-edit")!.addEventListener("click", () => { const a = activePlace(); if (a) openPlaceDialog(a); });
  $("place-del")!.addEventListener("click", () => {
    const a = activePlace();
    if (!a || !window.confirm(t("place.confirmDelete", { name: a.name }))) return;
    dropPlace(a.id);
    log(t("place.deleted", { name: a.name }));
  });
  $("place-jaws")!.addEventListener("click", insertJaws);

  for (const e of [PLACES_CHANGED, MODE_CHANGED, "cnc-language-changed", "cnc-machine-profile-changed"]) window.addEventListener(e, fillList);
  for (const e of [STOCK_CHANGED, MACHINE_EVENT]) window.addEventListener(e, refresh);
  fillList();
}

/** X/Y-Nullpunkt auf den Platz setzen. Es fährt nichts; vor dem Senden wird alles noch einmal geprüft */
async function zeroHere() {
  const p = activePlace();
  if (!p || busy || isLathe()) return;
  await needSettings();
  let why = blocked();
  if (why) { log(t("place.why." + why)); return; }
  const s = getStock(), z = zeroFor(p, s), conn = machine.port;
  const go = await askChoice(t("place.zero"), t("place.ask", {
    name: p.name, corner: t("place.c." + p.corner), w: fmtLenU(s.w), h: fmtLenU(s.h), x: fmtLenU(z.x), y: fmtLenU(z.y),
    wcs: p.wcs || machine.wcs || "G54"
  }), [{ key: "yes", label: t("place.askYes"), primary: true }, { key: "no", label: t("ko.cancel"), cancel: true }]);
  if (go !== "yes") return;
  // während des Fensters kann sich alles geändert haben (andere Maschine, Job, Alarm, Rohteil)
  const q = activePlace(), z2 = q && zeroFor(q, getStock());
  if (!q || !z2 || q.id !== p.id || machine.port !== conn || z2.x !== z.x || z2.y !== z.y) { log(t("place.changed")); return; }
  why = blocked();
  if (why) { log(t("place.why." + why)); return; }
  if (p.wcs && machine.wcs !== p.wcs) {
    await selectWcs(p.wcs as Wcs);
    if (machine.wcs !== p.wcs) return; // selectWcs hat gemeldet, warum
  }
  why = blocked();
  if (why || machine.port !== conn) { log(t("place.why." + (why || "connect"))); return; }
  busy = true;
  try {
    const a = await sendAndWait(zeroCommandFor({ x: machine.status.mpos[0], y: machine.status.mpos[1] }, z), 4000, true);
    log(a.ok ? t("place.done", { name: p.name }) : t("place.failed"));
  } catch { log(t("place.failed")); }
  finally { busy = false; }
}

/** Backen als Sperrzonen in die Zeichnung: Eilfahrten darüber werden angehoben. Früher eingefügte Backen werden ersetzt */
function insertJaws() {
  const p = activePlace();
  const j = p && jaws(p, getStock());
  if (!p || !j) return;
  const made = [j.fixed, j.moving].map(r => {
    const sh: any = createPolyline(makeRectPoints(r.x * MM_TO_PIXEL, r.y * MM_TO_PIXEL, (r.x + r.w) * MM_TO_PIXEL, (r.y + r.h) * MM_TO_PIXEL), true, "outside");
    sh.keepOut = { height: p.jawZ, margin: KEEP_MARGIN };
    sh.placeJaw = true;
    return sh;
  });
  const st = app();
  st.shapes = [...st.shapes.filter((s: any) => !s.placeJaw), ...made];
  st.selectedShapeIds = [];
  checkpoint(); redraw();
  log(t("place.jawsDone", { z: fmtLenU(p.jawZ + KEEP_MARGIN) }));
}

function openPlaceDialog(edit: Place | null) {
  document.getElementById("place-overlay")?.remove();
  const s0 = getStock();
  let corner: Corner = edit?.corner || "bl";
  const n = (id: string, label: string, v: number | string, extra = "") =>
    `<label class="dlg-row" ${extra}><span>${esc(label)}</span><span class="dlg-num"><input id="${id}" type="number" step="0.1" value="${esc(String(v))}"><em>mm</em></span></label>`;
  const e = edit || { ...JAW_DEFAULTS, name: "", x: "", y: "", wcs: "", kind: "stop" };
  const ov = document.createElement("div");
  ov.id = "place-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:470px;max-height:92vh;overflow:auto;">
      <h3>${esc(t(edit ? "place.editTitle" : "place.newTitle"))}</h3>
      <div class="dlg-hint">${esc(t("place.dlgHint"))}</div>
      <label class="dlg-row"><span>${esc(t("place.name"))}</span><input id="pl-name" type="text" maxlength="${MAX_PLACE_NAME}" value="${esc(e.name)}" style="width:220px;"></label>
      <label class="dlg-row"><span>${esc(t("place.kind"))}</span><select id="pl-kind">
        <option value="stop">${esc(t("place.kind.stop"))}</option><option value="vise">${esc(t("place.kind.vise"))}</option></select></label>
      <div class="dlg-row"><span>${esc(t("place.corner"))}</span>
        <span style="display:grid;grid-template-columns:repeat(2,34px);gap:14px 30px;padding:6px;border:1px dashed var(--border-color);border-radius:6px;">
          ${CORNERS.map(c => `<button type="button" class="pl-corner" data-c="${c}" aria-label="${esc(t("place.c." + c))}" title="${esc(t("place.c." + c))}" style="width:34px;height:26px;padding:0;border-radius:5px;cursor:pointer;">●</button>`).join("")}
        </span></div>
      <div class="dlg-hint">${esc(t("place.where", { w: fmtLenU(s0.w), h: fmtLenU(s0.h) }))}</div>
      <div class="dlg-buttons" style="justify-content:flex-start;flex-wrap:wrap;">
        <button type="button" class="btn-secondary" id="pl-from-zero">${esc(t("place.fromZero"))}</button>
        <button type="button" class="btn-secondary" id="pl-from-pos">${esc(t("place.fromPos"))}</button>
      </div>
      ${n("pl-x", t("place.x"), e.x)}
      ${n("pl-y", t("place.y"), e.y)}
      <label class="dlg-row"><span>${esc(t("place.wcs"))}</span><select id="pl-wcs"><option value="">${esc(t("place.wcsActive"))}</option>${WCS_LIST.map(w => `<option value="${w}">${w}</option>`).join("")}</select></label>
      <div id="pl-vise" style="display:flex;flex-direction:column;gap:8px;">
        <label class="dlg-row"><span>${esc(t("place.clamp"))}</span><select id="pl-clamp"><option value="y">${esc(t("place.clamp.y"))}</option><option value="x">${esc(t("place.clamp.x"))}</option></select></label>
        ${n("pl-jawW", t("place.jawW"), e.jawW)}
        ${n("pl-jawD", t("place.jawD"), e.jawD)}
        ${n("pl-jawOff", t("place.jawOff"), e.jawOff)}
        ${n("pl-jawZ", t("place.jawZ"), e.jawZ)}
      </div>
      <div class="dlg-hint" id="pl-msg" style="color:var(--color-warning);min-height:1.2em;"></div>
      <div class="dlg-buttons">
        <button type="button" class="btn-secondary" id="pl-cancel">${esc(t("ko.cancel"))}</button>
        <button type="button" class="btn-primary" id="pl-ok">${esc(t("tool.save"))}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const q = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector<E>("#" + id)!;
  const val = (id: string) => parseFloat(q(id).value);
  const msg = (m: string) => { q("pl-msg").textContent = m; };
  const kind = q<HTMLSelectElement>("pl-kind"), wcs = q<HTMLSelectElement>("pl-wcs"), clamp = q<HTMLSelectElement>("pl-clamp");
  kind.value = e.kind; wcs.value = e.wcs; clamp.value = e.clamp;
  const paint = () => {
    q("pl-vise").style.display = kind.value === "vise" ? "flex" : "none";
    ov.querySelectorAll<HTMLButtonElement>(".pl-corner").forEach(b => {
      const on = b.dataset.c === corner;
      b.setAttribute("aria-pressed", String(on));
      b.style.border = `1px solid ${on ? "var(--accent-color)" : "var(--border-color)"}`;
      b.style.background = on ? "var(--accent-color)" : "transparent";
      b.style.color = on ? "#fff" : "var(--text-muted)";
    });
  };
  kind.onchange = paint;
  ov.querySelectorAll<HTMLButtonElement>(".pl-corner").forEach(b => { b.onclick = () => { corner = b.dataset.c as Corner; paint(); }; });
  paint();

  // Stelle von der Maschine übernehmen: nur lesen, nichts senden (außer $$ für „referenziert?“)
  const take = async (from: "zero" | "pos") => {
    await needSettings();
    const why = blocked();
    if (why && why !== "back") { msg(t("place.why." + why)); return; }
    const pos = from === "pos" ? { x: machine.status.mpos[0], y: machine.status.mpos[1] } : placeFromZero(currentZero(), getStock(), corner);
    q("pl-x").value = pos.x.toFixed(3); q("pl-y").value = pos.y.toFixed(3);
    msg(t(from === "pos" ? "place.tookPos" : "place.tookZero", { corner: t("place.c." + corner) }));
  };
  q("pl-from-zero").onclick = () => { void take("zero"); };
  q("pl-from-pos").onclick = () => { void take("pos"); };

  const close = () => ov.remove();
  ov.addEventListener("keydown", ev => { ev.stopPropagation(); if (ev.key === "Escape") close(); });
  ov.addEventListener("mousedown", ev => { if (ev.target === ov) close(); });
  q("pl-cancel").onclick = close;
  q("pl-ok").onclick = () => {
    const name = q("pl-name").value.trim();
    if (!name) { msg(t("rem.needName")); q("pl-name").focus(); return; }
    if (!Number.isFinite(val("pl-x")) || !Number.isFinite(val("pl-y"))) { msg(t("place.needPos")); return; }
    const p: Place = {
      id: edit?.id || newId(), name, mode: edit?.mode || getMachineMode(), machine: edit ? edit.machine : machineKey(),
      x: val("pl-x"), y: val("pl-y"), corner, wcs: wcs.value, kind: kind.value === "vise" ? "vise" : "stop",
      clamp: clamp.value === "x" ? "x" : "y", jawW: val("pl-jawW"), jawD: val("pl-jawD"), jawOff: val("pl-jawOff"), jawZ: val("pl-jawZ")
    };
    if (!putPlace(p)) { msg(t("place.full")); return; }
    setActivePlace(p.id);
    log(t("place.saved", { name }));
    close();
  };
  setTimeout(() => q("pl-name").focus(), 0);
}
