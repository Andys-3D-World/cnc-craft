/**
 * REITER "PLASMA-BIBLIOTHEK" (im Plasma-Modus anstelle der Fräswerkzeuge)
 *
 * Aufbau wie die Werkzeug-Bibliothek der Fräse:
 *   links  – Liste der Plasma-Schnitte (Farbe, Name, Kurzinfo, ★ = Standard-Schnitt),
 *            ＋ neu, ⧉ kopieren, ▲▼ Reihenfolge, wichtigste Maschinen-Einstellungen
 *   rechts – Editor mit Seitenansicht (Einstechhöhe, Schneidhöhe, Anfahrt, Schnittspalt),
 *            Material, Blechdicke, Stromstärke, Geschwindigkeit, Höhen, Notiz
 * Die Daten liegen in plasmaCuts.ts – dieselben Schnitte wie rechts im CAM-Bereich.
 */
import { t } from "../i18n/i18n";
import {
  PlasmaCut, PLASMA_CHANGED, getCuts, getCut, addCut, updateCut, removeCut, duplicateCut, moveCut,
  activeCut, setActiveCut, cutInfo, plasmaSettings, setPlasmaSettings
} from "../plasmaCuts";
import { LAYER_COLORS } from "../laserLayers";
import { openPlasmaPresetDialog } from "./plasmaPresetDialog";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
const f2 = (v: number) => String(Math.round(v * 100) / 100);

const MAT_SUGGEST = ["mild", "stainless", "alu", "galv", "copper", "brass"];

// ---------------------------------------------------------------------
// Seitenansicht: Brenner beim Einstechen und beim Schneiden
// ---------------------------------------------------------------------

export function plasmaPreviewSvg(c: Pick<PlasmaCut, "color" | "pierceHeight" | "cutHeight" | "pierceDelay" | "leadIn" | "kerf" | "thickness">, labels = true): string {
  const W = 260, H = 210;
  const plateTop = 150;
  const plateH = Math.max(6, Math.min(26, (c.thickness || 3) * 3));
  const sc = 9; // px je mm Höhe (begrenzt)
  const ph = Math.min(60, Math.max(4, c.pierceHeight * sc));
  const ch = Math.min(60, Math.max(3, c.cutHeight * sc));
  const xP = 70, xC = 190;
  const kerf = Math.max(3, Math.min(18, c.kerf * 5));
  const torch = (x: number, gap: number, dashed: boolean) => {
    const y = plateTop - gap;
    return `<g ${dashed ? 'opacity="0.55"' : ""}>
      <path d="M${x - 15} ${y - 62} h30 v40 l-8 16 h-14 l-8 -16 z" fill="#3a3a48" stroke="#8a8aa0" stroke-width="1.2" ${dashed ? 'stroke-dasharray="3 2"' : ""}/>
      <rect x="${x - 4}" y="${y - 7}" width="8" height="7" fill="#b07a3a"/>
    </g>`;
  };
  const dim = (x: number, y1: number, y2: number, text: string, left: boolean) => {
    const tx = left ? x - 26 : x + 26;
    return `<g class="plp-dim">
      <line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/>
      <path d="M${x - 3} ${y1 + 5} L${x} ${y1} L${x + 3} ${y1 + 5} M${x - 3} ${y2 - 5} L${x} ${y2} L${x + 3} ${y2 - 5}"/>
      ${labels ? `<text x="${tx}" y="${(y1 + y2) / 2 + 4}" text-anchor="middle">${text}</text>` : ""}
    </g>`;
  };
  return `<svg class="plp-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="12" fill="#121218" stroke="rgba(255,255,255,0.08)"/>
    <!-- Blech mit Schnittspalt unter dem Brenner -->
    <rect x="14" y="${plateTop}" width="${xC - kerf / 2 - 14}" height="${plateH}" fill="#6d727c"/>
    <rect x="${xC + kerf / 2}" y="${plateTop}" width="${W - 14 - xC - kerf / 2}" height="${plateH}" fill="#6d727c"/>
    <!-- Anfahrt -->
    <path d="M${xP} ${plateTop - 3} H${xC - 8}" stroke="${c.color}" stroke-width="2" stroke-dasharray="5 3" fill="none"/>
    <path d="M${xC - 14} ${plateTop - 7} L${xC - 6} ${plateTop - 3} L${xC - 14} ${plateTop + 1}" fill="none" stroke="${c.color}" stroke-width="2"/>
    ${torch(xP, ph, true)}
    ${torch(xC, ch, false)}
    <!-- Lichtbogen -->
    <path d="M${xC} ${plateTop - ch} L${xC - 2} ${plateTop - ch * 0.6} L${xC + 2} ${plateTop - ch * 0.35} L${xC} ${plateTop + plateH}" stroke="#7fd8ff" stroke-width="2.4" fill="none"/>
    ${dim(xP - 28, plateTop - ph, plateTop, f2(c.pierceHeight), true)}
    ${dim(xC + 28, plateTop - ch, plateTop, f2(c.cutHeight), false)}
    ${labels ? `
    <g class="plp-lbl">
      <text x="${xP}" y="22" text-anchor="middle">${esc(t("plib.pv.pierce"))}</text>
      <text x="${xP}" y="36" text-anchor="middle" class="plp-sub">${f2(c.pierceDelay)} s</text>
      <text x="${xC}" y="22" text-anchor="middle">${esc(t("plib.pv.cut"))}</text>
      <text x="${(xP + xC) / 2}" y="${plateTop + plateH + 20}" text-anchor="middle" class="plp-sub">${esc(t("plib.pv.lead", { v: f2(c.leadIn) }))}</text>
      <text x="${xC}" y="${plateTop + plateH + 20}" text-anchor="start" dx="${kerf / 2 + 6}" class="plp-sub">${esc(t("plib.pv.kerf", { v: f2(c.kerf) }))}</text>
    </g>` : ""}
  </svg>`;
}

function infoLine(c: PlasmaCut): string {
  const mat = [c.thickness > 0 ? `${f2(c.thickness)} mm` : "", c.material, c.amps > 0 ? `${f2(c.amps)} A` : ""].filter(Boolean).join(" ");
  return (mat ? mat + " · " : "") + cutInfo(c);
}

// ---------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------

let sel: string | null = null;
let isNew = false;

export function initPlasmaLibPage() {
  window.addEventListener(PLASMA_CHANGED, () => renderPlasmaLibPage(false));
  renderPlasmaLibPage();
}

export function rebuildPlasmaLibPage() {
  const page = document.getElementById("plasma-lib-page");
  if (page) page.innerHTML = "";
  renderPlasmaLibPage();
}

export function renderPlasmaLibPage(withEditor = true) {
  const page = document.getElementById("plasma-lib-page");
  if (!page) return;
  const cuts = getCuts();
  if (!isNew && (!sel || !getCut(sel))) sel = activeCut?.id || cuts[0]?.id || null;

  if (!page.querySelector(".tlp")) {
    page.innerHTML = `
      <div class="tlp">
        <div class="tlp-left">
          <div class="tlp-head">
            <button id="pp-new" class="btn-primary">＋ ${esc(t("plib.new"))}</button>
            <button id="pp-dup" class="btn-secondary" data-tip="${esc(t("plib.dupTip"))}">⧉</button>
            <button id="pp-up" class="btn-secondary" data-tip="${esc(t("plib.upTip"))}">▲</button>
            <button id="pp-down" class="btn-secondary" data-tip="${esc(t("plib.downTip"))}">▼</button>
          </div>
          <button id="pp-presets" class="btn-secondary" style="width:100%;margin:4px 0;" data-tip="${esc(t("ppre.tip"))}">📋 ${esc(t("llib.pre.button"))}</button>
          <div id="pp-list" class="tlp-list"></div>
          <div class="tlp-settings">
            <h4>⚙️ ${esc(t("plasma.settings"))}</h4>
            <label class="te-row" data-tip="${esc(t("plasma.useZTip"))}"><span>${esc(t("plasma.useZ"))}</span><input id="pps-usez" type="checkbox" style="width:auto;"></label>
            <label class="te-row"><span>${esc(t("plasma.safeZ"))}</span><span class="dlg-num"><input id="pps-safez" type="number" min="0" step="1"><em>mm</em></span></label>
            <label class="te-row" data-tip="${esc(t("plasma.overcutTip"))}"><span>${esc(t("plasma.overcut"))}</span><span class="dlg-num"><input id="pps-overcut" type="number" min="0" step="0.5"><em>mm</em></span></label>
            <div class="tool-scope">${esc(t("plib.settingsHint"))}</div>
          </div>
        </div>
        <div class="tlp-right">
          <div class="tlp-edit-head" id="pp-edit-head"></div>
          <div id="pp-editor"></div>
        </div>
      </div>`;
    bindPage(page);
  }

  const list = page.querySelector("#pp-list") as HTMLElement;
  list.innerHTML = cuts.map(c => {
    const s = !isNew && c.id === sel;
    const def = activeCut?.id === c.id;
    return `
      <div class="tlp-item${s ? " sel" : ""}" data-id="${c.id}">
        <div class="tlp-ico"><span class="llp-swatch" style="background:${c.color}"></span></div>
        <div class="tlp-txt">
          <div class="tlp-name">${esc(c.name)}</div>
          <div class="tlp-info">${esc(infoLine(c))}</div>
        </div>
        <button class="tlp-star${def ? " on" : ""}" data-act="default" data-tip="${esc(t(def ? "plib.isDefault" : "plib.makeDefault"))}">${def ? "★" : "☆"}</button>
      </div>`;
  }).join("") + (isNew ? `<div class="tlp-item sel tlp-newitem"><div class="tlp-txt"><div class="tlp-name">＋ ${esc(t("plasma.newTitle"))}</div></div></div>` : "");

  const setv = (id: string, v: string) => { const e = page.querySelector("#" + id) as HTMLInputElement; if (e && document.activeElement !== e) e.value = v; };
  setv("pps-safez", String(plasmaSettings.safeZ));
  setv("pps-overcut", String(plasmaSettings.overcut));
  const uz = page.querySelector("#pps-usez") as HTMLInputElement;
  uz.checked = plasmaSettings.useZ;
  (page.querySelector("#pps-safez") as HTMLInputElement).disabled = !plasmaSettings.useZ;
  (page.querySelector("#pp-dup") as HTMLButtonElement).disabled = isNew || !sel;
  (page.querySelector("#pp-up") as HTMLButtonElement).disabled = isNew || cuts[0]?.id === sel;
  (page.querySelector("#pp-down") as HTMLButtonElement).disabled = isNew || cuts[cuts.length - 1]?.id === sel;

  if (!withEditor) return;
  const cut = isNew ? null : getCut(sel);
  const head = page.querySelector("#pp-edit-head") as HTMLElement;
  head.innerHTML = cut
    ? `<h3>🔥 <span class="llp-swatch" style="background:${cut.color}"></span> ${esc(cut.name)}</h3>`
    : `<h3>🔥 ${esc(t("plasma.newTitle"))}</h3>`;
  mountEditor(page.querySelector("#pp-editor") as HTMLElement, cut);
}

function bindPage(page: HTMLElement) {
  page.querySelector("#pp-list")!.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest(".tlp-item[data-id]") as HTMLElement | null;
    if (!item) return;
    const id = item.dataset.id!;
    if ((e.target as HTMLElement).closest("[data-act=default]")) { setActiveCut(id); return; }
    sel = id; isNew = false;
    renderPlasmaLibPage();
  });
  page.querySelector("#pp-new")!.addEventListener("click", () => { isNew = true; renderPlasmaLibPage(); });
  page.querySelector("#pp-presets")!.addEventListener("click", () => openPlasmaPresetDialog(id => { sel = id; isNew = false; renderPlasmaLibPage(); }));
  page.querySelector("#pp-dup")!.addEventListener("click", () => {
    if (!sel) return;
    const c = duplicateCut(sel);
    if (c) { sel = c.id; renderPlasmaLibPage(); }
  });
  page.querySelector("#pp-up")!.addEventListener("click", () => { if (sel) moveCut(sel, -1); });
  page.querySelector("#pp-down")!.addEventListener("click", () => { if (sel) moveCut(sel, 1); });
  const num = (id: string, key: "safeZ" | "overcut") => {
    const el = page.querySelector("#" + id) as HTMLInputElement;
    el.addEventListener("change", () => { setPlasmaSettings({ [key]: parseFloat(el.value) }); el.value = String(plasmaSettings[key]); });
  };
  num("pps-safez", "safeZ");
  num("pps-overcut", "overcut");
  const uz = page.querySelector("#pps-usez") as HTMLInputElement;
  uz.addEventListener("change", () => setPlasmaSettings({ useZ: uz.checked }));
}

// ---------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------

function mountEditor(root: HTMLElement, cut: PlasmaCut | null) {
  const used = new Set(getCuts().map(c => c.color));
  const src: PlasmaCut = cut ? { ...cut } : {
    id: "", name: "", color: LAYER_COLORS.find(c => !used.has(c)) || LAYER_COLORS[0],
    speed: 1500, kerf: 1.5, pierceHeight: 3.8, pierceDelay: 0.5, cutHeight: 1.5, leadIn: 3,
    material: "", thickness: 0, amps: 0, notes: ""
  };
  const num = (key: string, id: string, value: number, step: string, unit: string, tipKey = "") => `
    <label class="te-row" ${tipKey ? `data-tip="${esc(t(tipKey))}"` : ""}><span>${esc(t(key))}</span>
      <span class="dlg-num"><input id="pp-${id}" type="number" value="${value}" min="0" step="${step}"><em>${unit}</em></span></label>`;
  root.innerHTML = `
    <div class="te">
      <label class="te-row te-name"><span>${esc(t("laser.name"))}</span>
        <input id="pp-name" type="text" value="${esc(src.name)}" placeholder="${esc(t("plasma.namePh"))}"></label>
      <div class="te-main">
        <div class="te-preview">
          <div id="pp-preview"></div>
          <div class="te-end-label" id="pp-prevlabel"></div>
        </div>
        <div class="te-fields">
          <fieldset><legend>${esc(t("plib.material"))}</legend>
            <div class="te-row"><span>${esc(t("laser.color"))}</span>
              <span class="ll-colors llp-colors">${LAYER_COLORS.map(c => `<button type="button" class="ll-color${c === src.color ? " active" : ""}" data-color="${c}" style="background:${c}"></button>`).join("")}</span></div>
            <label class="te-row"><span>${esc(t("llib.matName"))}</span>
              <input id="pp-material" type="text" list="pp-matlist" value="${esc(src.material)}" placeholder="${esc(t("plib.matPh"))}" style="width:180px;"></label>
            <datalist id="pp-matlist">${MAT_SUGGEST.map(m => `<option value="${esc(t("plib.mat." + m))}">`).join("")}</datalist>
            ${num("plib.thickness", "thick", src.thickness, "0.5", "mm")}
            ${num("plib.amps", "amps", src.amps, "5", "A", "plib.ampsTip")}
          </fieldset>
          <fieldset><legend>${esc(t("plib.cutting"))}</legend>
            ${num("laser.speed", "speed", src.speed, "100", "mm/min")}
            ${num("plasma.kerf", "kerf", src.kerf, "0.1", "mm", "plib.kerfTip")}
            ${num("plasma.leadIn", "lead", src.leadIn, "0.5", "mm", "plib.leadTip")}
          </fieldset>
          <fieldset><legend>${esc(t("plib.heights"))}</legend>
            ${num("plasma.pierceHeight", "ph", src.pierceHeight, "0.1", "mm", "plib.phTip")}
            ${num("plasma.pierceDelay", "pd", src.pierceDelay, "0.1", "s", "plib.pdTip")}
            ${num("plasma.cutHeight", "ch", src.cutHeight, "0.1", "mm", "plib.chTip")}
          </fieldset>
          <label class="te-row te-notes"><span>${esc(t("tl.notes"))}</span>
            <textarea id="pp-notes" rows="2" placeholder="${esc(t("plib.notesPh"))}">${esc(src.notes || "")}</textarea></label>
        </div>
      </div>
      <div class="dlg-hint">${esc(t("plasma.dlgHint"))}</div>
      <div class="dlg-buttons">
        ${cut && getCuts().length > 1 ? `<button id="pp-del" class="btn-secondary dlg-danger" data-tip="${esc(t("plib.deleteTip"))}">🗑</button>` : ""}
        ${!cut ? `<button id="pp-cancel" class="btn-secondary" style="flex:1;">${esc(t("dlg.cancel"))}</button>` : ""}
        <button id="pp-ok" class="btn-primary" style="flex:2;">✔ ${esc(t(cut ? "tool.save" : "tool.create"))}</button>
      </div>
    </div>`;

  const q = <T extends HTMLElement = HTMLInputElement>(id: string) => root.querySelector("#pp-" + id) as T;
  let color = src.color;
  const val = (id: string) => parseFloat(q(id).value);
  const nz = (v: number) => (Number.isFinite(v) && v >= 0 ? v : 0);

  const refresh = () => {
    const c = {
      color, pierceHeight: nz(val("ph")), cutHeight: nz(val("ch")), pierceDelay: nz(val("pd")),
      leadIn: nz(val("lead")), kerf: nz(val("kerf")), thickness: nz(val("thick"))
    };
    q<HTMLElement>("preview").innerHTML = plasmaPreviewSvg(c);
    q<HTMLElement>("prevlabel").textContent = t("plasma.info", { f: f2(nz(val("speed"))), k: f2(c.kerf), d: f2(c.pierceDelay) });
  };
  root.querySelectorAll<HTMLButtonElement>(".ll-color").forEach(b => b.addEventListener("click", () => {
    color = b.dataset.color!;
    root.querySelectorAll(".ll-color").forEach(x => x.classList.toggle("active", x === b));
    refresh();
  }));
  root.querySelectorAll("input, textarea").forEach(el => el.addEventListener("input", refresh));

  const ok = () => {
    const name = q("name").value.trim();
    if (!name) { q("name").focus(); q("name").classList.add("dlg-invalid"); return; }
    if (!(val("speed") > 0)) { q("speed").focus(); q("speed").classList.add("dlg-invalid"); return; }
    const data: Partial<PlasmaCut> = {
      name, color,
      speed: val("speed"), kerf: val("kerf"), leadIn: val("lead"),
      pierceHeight: val("ph"), pierceDelay: val("pd"), cutHeight: val("ch"),
      material: q("material").value.trim(), thickness: val("thick") || 0, amps: val("amps") || 0,
      notes: q<HTMLTextAreaElement>("notes").value
    };
    if (cut) { updateCut(cut.id, data); sel = cut.id; }
    else { const n = addCut(data); sel = n.id; isNew = false; }
    renderPlasmaLibPage();
  };
  q<HTMLButtonElement>("ok").onclick = ok;
  const cancel = root.querySelector("#pp-cancel") as HTMLButtonElement | null;
  if (cancel) cancel.onclick = () => { isNew = false; renderPlasmaLibPage(); };
  const del = root.querySelector("#pp-del") as HTMLButtonElement | null;
  if (del && cut) del.onclick = () => {
    if (!window.confirm(t("laser.confirmDelete", { name: cut.name }))) return;
    sel = null;
    removeCut(cut.id);
    renderPlasmaLibPage();
  };
  root.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA") { e.preventDefault(); ok(); }
  });
  refresh();
  if (!cut) setTimeout(() => q("name").focus(), 0);
}
