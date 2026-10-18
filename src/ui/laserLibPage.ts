/**
 * REITER "LASER-BIBLIOTHEK" (im Laser-Modus anstelle der Fräswerkzeuge)
 *
 * Aufbau wie die Werkzeug-Bibliothek der Fräse:
 *   links  – Liste der Laser-Ebenen (Farbe, Name, Kurzinfo, ★ = Standard-Ebene),
 *            ＋ neu, ⧉ kopieren, ▲▼ Reihenfolge (= Laser-Reihenfolge), Laser-Einstellungen
 *   rechts – Editor mit Vorschau (Linie / Füllen mit Linienabstand und Winkel),
 *            Leistung, Geschwindigkeit, Durchgänge, Luft, Material + Dicke, Notiz
 * Die Daten liegen in laserLayers.ts – dieselben Ebenen wie rechts im CAM-Bereich.
 */
import { t } from "../i18n/i18n";
import {
  LaserLayer, LaserMode, LAYER_COLORS, LAYERS_CHANGED, getLayers, getLayer, addLayer, updateLayer, removeLayer,
  duplicateLayer, moveLayer, activeLayer, setActiveLayer, layerInfo, laserSettings, setLaserSettings
} from "../laserLayers";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
const f2 = (v: number) => String(Math.round(v * 100) / 100);

/** Vorschläge für das Material-Feld (frei überschreibbar) */
const MAT_SUGGEST = ["plywood", "hardwood", "mdf", "acrylic", "cardboard", "paper", "leather", "cork", "felt", "slate", "glass", "anodized", "steel"];

const MODES: LaserMode[] = ["line", "fill", "fill+line"];

// ---------------------------------------------------------------------
// Vorschau-Bild
// ---------------------------------------------------------------------

/** Kleines Bild: Form mit Loch, je nach Art umrandet und/oder schraffiert */
export function laserPreviewSvg(l: Pick<LaserLayer, "color" | "mode" | "interval" | "angle" | "power" | "passes" | "air">, size = 200): string {
  const fill = l.mode !== "line", line = l.mode !== "fill";
  // Linienabstand übertrieben groß zeigen, sonst sieht man nichts
  const gap = Math.max(3.5, Math.min(16, l.interval * 45));
  const op = (0.35 + 0.65 * Math.max(0, Math.min(100, l.power)) / 100).toFixed(2);
  const path = "M40 45 h120 a14 14 0 0 1 14 14 v82 a14 14 0 0 1 -14 14 h-120 a14 14 0 0 1 -14 -14 v-82 a14 14 0 0 1 14 -14 z M100 74 a26 26 0 1 0 0.01 0 z";
  let hatch = "";
  if (fill) {
    const lines: string[] = [];
    for (let y = -150; y <= 150; y += gap) lines.push(`<line x1="-150" y1="${y.toFixed(2)}" x2="150" y2="${y.toFixed(2)}"/>`);
    hatch = `<g clip-path="url(#llp-clip)"><g transform="translate(100 100) rotate(${-l.angle})" stroke="${l.color}" stroke-width="1.6" opacity="${op}">${lines.join("")}</g></g>`;
  }
  const outline = line ? `<path d="${path}" fill="none" fill-rule="evenodd" stroke="${l.color}" stroke-width="2.4" opacity="${op}"/>` : "";
  const badges = [
    l.passes > 1 ? `<g transform="translate(150 12)"><rect width="40" height="20" rx="10" fill="rgba(255,255,255,0.12)"/><text x="20" y="14.5" text-anchor="middle">${l.passes}×</text></g>` : "",
    l.air ? `<g transform="translate(10 12)"><rect width="40" height="20" rx="10" fill="rgba(80,170,255,0.18)"/><text x="20" y="14.5" text-anchor="middle">💨</text></g>` : ""
  ].join("");
  return `<svg class="llp-svg" viewBox="0 0 200 200" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs><clipPath id="llp-clip"><path d="${path}" clip-rule="evenodd"/></clipPath></defs>
    <rect x="1" y="1" width="198" height="198" rx="12" fill="#121218" stroke="rgba(255,255,255,0.08)"/>
    ${hatch}${outline}
    <g class="llp-badge" font-size="11" fill="#ddd">${badges}</g>
  </svg>`;
}

/** Kleines Symbol für die Liste */
function swatch(l: LaserLayer): string {
  return `<span class="llp-swatch" style="background:${l.color}">${l.mode === "line" ? "" : l.mode === "fill" ? "▦" : "▣"}</span>`;
}

function infoLine(l: LaserLayer): string {
  const mat = [l.thickness > 0 ? `${f2(l.thickness)} mm` : "", l.material].filter(Boolean).join(" ");
  return layerInfo(l) + (mat ? ` · ${mat}` : "");
}

// ---------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------

let sel: string | null = null;
let isNew = false;

export function initLaserLibPage() {
  window.addEventListener(LAYERS_CHANGED, () => renderLaserLibPage(false));
  renderLaserLibPage();
}

/** Sprache gewechselt: komplett neu aufbauen */
export function rebuildLaserLibPage() {
  const page = document.getElementById("laser-lib-page");
  if (page) page.innerHTML = "";
  renderLaserLibPage();
}

export function renderLaserLibPage(withEditor = true) {
  const page = document.getElementById("laser-lib-page");
  if (!page) return;
  const layers = getLayers();
  if (!isNew && (!sel || !getLayer(sel))) sel = activeLayer?.id || layers[0]?.id || null;

  if (!page.querySelector(".tlp")) {
    page.innerHTML = `
      <div class="tlp">
        <div class="tlp-left">
          <div class="tlp-head">
            <button id="lp-new" class="btn-primary">＋ ${esc(t("llib.new"))}</button>
            <button id="lp-dup" class="btn-secondary" data-tip="${esc(t("llib.dupTip"))}">⧉</button>
            <button id="lp-up" class="btn-secondary" data-tip="${esc(t("llib.upTip"))}">▲</button>
            <button id="lp-down" class="btn-secondary" data-tip="${esc(t("llib.downTip"))}">▼</button>
          </div>
          <div id="lp-list" class="tlp-list"></div>
          <div class="tlp-settings">
            <h4>⚙️ ${esc(t("laser.settings"))}</h4>
            <label class="te-row" data-tip="${esc(t("laser.sMaxTip"))}"><span>${esc(t("laser.sMax"))}</span><span class="dlg-num"><input id="lps-smax" type="number" min="1" step="1"><em>S</em></span></label>
            <label class="te-row" data-tip="${esc(t("laser.dynamicTip"))}"><span>${esc(t("laser.dynamic"))}</span><input id="lps-dyn" type="checkbox" style="width:auto;"></label>
            <div class="tool-scope">${esc(t("llib.orderHint"))}</div>
          </div>
        </div>
        <div class="tlp-right">
          <div class="tlp-edit-head" id="lp-edit-head"></div>
          <div id="lp-editor"></div>
        </div>
      </div>`;
    bindPage(page);
  }

  const list = page.querySelector("#lp-list") as HTMLElement;
  list.innerHTML = layers.map((l, i) => {
    const s = !isNew && l.id === sel;
    const def = activeLayer?.id === l.id;
    return `
      <div class="tlp-item${s ? " sel" : ""}" data-id="${l.id}">
        <div class="tlp-ico">${swatch(l)}</div>
        <div class="tlp-txt">
          <div class="tlp-name"><b class="llp-no">${i + 1}</b> ${esc(l.name)}</div>
          <div class="tlp-info">${esc(infoLine(l))}</div>
        </div>
        <button class="tlp-star${def ? " on" : ""}" data-act="default" data-tip="${esc(t(def ? "llib.isDefault" : "llib.makeDefault"))}">${def ? "★" : "☆"}</button>
      </div>`;
  }).join("") + (isNew ? `<div class="tlp-item sel tlp-newitem"><div class="tlp-txt"><div class="tlp-name">＋ ${esc(t("laser.newTitle"))}</div></div></div>` : "");

  const setv = (id: string, v: string) => { const e = page.querySelector("#" + id) as HTMLInputElement; if (e && document.activeElement !== e) e.value = v; };
  setv("lps-smax", String(laserSettings.sMax));
  (page.querySelector("#lps-dyn") as HTMLInputElement).checked = laserSettings.dynamic;
  (page.querySelector("#lp-dup") as HTMLButtonElement).disabled = isNew || !sel;
  (page.querySelector("#lp-up") as HTMLButtonElement).disabled = isNew || layers[0]?.id === sel;
  (page.querySelector("#lp-down") as HTMLButtonElement).disabled = isNew || layers[layers.length - 1]?.id === sel;

  if (!withEditor) return;
  const layer = isNew ? null : getLayer(sel);
  const head = page.querySelector("#lp-edit-head") as HTMLElement;
  head.innerHTML = layer
    ? `<h3>🔦 ${swatch(layer)} ${esc(layer.name)}</h3>`
    : `<h3>🔦 ${esc(t("laser.newTitle"))}</h3>`;
  mountEditor(page.querySelector("#lp-editor") as HTMLElement, layer);
}

function bindPage(page: HTMLElement) {
  page.querySelector("#lp-list")!.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest(".tlp-item[data-id]") as HTMLElement | null;
    if (!item) return;
    const id = item.dataset.id!;
    if ((e.target as HTMLElement).closest("[data-act=default]")) { setActiveLayer(id); return; }
    sel = id; isNew = false;
    renderLaserLibPage();
  });
  page.querySelector("#lp-new")!.addEventListener("click", () => { isNew = true; renderLaserLibPage(); });
  page.querySelector("#lp-dup")!.addEventListener("click", () => {
    if (!sel) return;
    const c = duplicateLayer(sel);
    if (c) { sel = c.id; renderLaserLibPage(); }
  });
  page.querySelector("#lp-up")!.addEventListener("click", () => { if (sel) moveLayer(sel, -1); });
  page.querySelector("#lp-down")!.addEventListener("click", () => { if (sel) moveLayer(sel, 1); });
  const smax = page.querySelector("#lps-smax") as HTMLInputElement;
  smax.addEventListener("change", () => { setLaserSettings({ sMax: parseFloat(smax.value) }); smax.value = String(laserSettings.sMax); });
  const dyn = page.querySelector("#lps-dyn") as HTMLInputElement;
  dyn.addEventListener("change", () => setLaserSettings({ dynamic: dyn.checked }));
}

// ---------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------

function mountEditor(root: HTMLElement, layer: LaserLayer | null) {
  const used = new Set(getLayers().map(l => l.color));
  const src: LaserLayer = layer ? { ...layer } : {
    id: "", name: "", color: LAYER_COLORS.find(c => !used.has(c)) || LAYER_COLORS[0], mode: "line",
    power: 50, speed: 1000, passes: 1, interval: 0.1, angle: 0, air: false, leadIn: 0, material: "", thickness: 0, notes: ""
  };
  const num = (key: string, id: string, value: number, step: string, unit: string, cls = "", tipKey = "", min = "0") => `
    <label class="te-row ${cls}" ${tipKey ? `data-tip="${esc(t(tipKey))}"` : ""}><span>${esc(t(key))}</span>
      <span class="dlg-num"><input id="lp-${id}" type="number" value="${value}" min="${min}" step="${step}"><em>${unit}</em></span></label>`;
  const modeBtns = MODES.map(m => `
    <button type="button" class="te-type llp-mode${m === src.mode ? " active" : ""}" data-mode="${m}" data-tip="${esc(t("llib.modeTip." + m))}">
      ${laserPreviewSvg({ color: "#c9c9d6", mode: m, interval: 0.22, angle: 45, power: 100, passes: 1, air: false }, 40)}<span>${esc(t("laser.mode." + m))}</span></button>`).join("");
  root.innerHTML = `
    <div class="te">
      <label class="te-row te-name"><span>${esc(t("laser.name"))}</span>
        <input id="lp-name" type="text" value="${esc(src.name)}" placeholder="${esc(t("llib.namePh"))}"></label>
      <div class="te-main">
        <div class="te-preview">
          <div id="lp-preview"></div>
          <div class="te-end-label" id="lp-prevlabel"></div>
        </div>
        <div class="te-fields">
          <fieldset><legend>${esc(t("llib.layer"))}</legend>
            <div class="te-row"><span>${esc(t("laser.color"))}</span>
              <span class="ll-colors llp-colors">${LAYER_COLORS.map(c => `<button type="button" class="ll-color${c === src.color ? " active" : ""}" data-color="${c}" style="background:${c}"></button>`).join("")}</span></div>
            <div class="llp-modes">${modeBtns}</div>
          </fieldset>
          <fieldset><legend>${esc(t("llib.laser"))}</legend>
            ${num("laser.power", "power", src.power, "1", "%", "", "llib.powerTip")}
            <input id="lp-power-range" class="llp-range" type="range" min="0" max="100" step="1" value="${src.power}">
            ${num("laser.speed", "speed", src.speed, "100", "mm/min")}
            ${num("laser.passes", "passes", src.passes, "1", "×", "", "llib.passesTip", "1")}
            <label class="te-row"><span>${esc(t("laser.air"))}</span><input id="lp-air" type="checkbox" ${src.air ? "checked" : ""} style="width:auto;"></label>
            ${num("laser.leadIn", "leadin", src.leadIn, "0.5", "mm", "llp-line", "laser.leadInTip")}
          </fieldset>
          <fieldset class="llp-fill"><legend>${esc(t("llib.fill"))}</legend>
            ${num("laser.interval", "interval", src.interval, "0.01", "mm", "", "llib.intervalTip")}
            <div class="te-calc-res" id="lp-dpi"></div>
            ${num("laser.angle", "angle", src.angle, "15", "°", "", "", "-180")}
          </fieldset>
          <fieldset><legend>${esc(t("llib.material"))}</legend>
            <label class="te-row"><span>${esc(t("llib.matName"))}</span>
              <input id="lp-material" type="text" list="lp-matlist" value="${esc(src.material)}" placeholder="${esc(t("llib.matPh"))}" style="width:180px;"></label>
            <datalist id="lp-matlist">${MAT_SUGGEST.map(m => `<option value="${esc(t("llib.mat." + m))}">`).join("")}</datalist>
            ${num("llib.thickness", "thick", src.thickness, "0.5", "mm", "", "llib.thicknessTip")}
          </fieldset>
          <label class="te-row te-notes"><span>${esc(t("tl.notes"))}</span>
            <textarea id="lp-notes" rows="2" placeholder="${esc(t("llib.notesPh"))}">${esc(src.notes || "")}</textarea></label>
        </div>
      </div>
      <div class="dlg-hint">${esc(t("laser.dlgHint"))}</div>
      <div class="dlg-buttons">
        ${layer && getLayers().length > 1 ? `<button id="lp-del" class="btn-secondary dlg-danger" data-tip="${esc(t("llib.deleteTip"))}">🗑</button>` : ""}
        ${!layer ? `<button id="lp-cancel" class="btn-secondary" style="flex:1;">${esc(t("dlg.cancel"))}</button>` : ""}
        <button id="lp-ok" class="btn-primary" style="flex:2;">✔ ${esc(t(layer ? "tool.save" : "tool.create"))}</button>
      </div>
    </div>`;

  const q = <T extends HTMLElement = HTMLInputElement>(id: string) => root.querySelector("#lp-" + id) as T;
  let color = src.color;
  let mode: LaserMode = src.mode;
  const val = (id: string) => parseFloat(q(id).value);

  const refresh = () => {
    const fill = mode !== "line";
    root.querySelectorAll<HTMLElement>(".llp-fill").forEach(e => { e.style.display = fill ? "" : "none"; });
    root.querySelectorAll<HTMLElement>(".llp-line").forEach(e => { e.style.display = mode !== "fill" ? "" : "none"; });
    root.querySelectorAll<HTMLElement>(".llp-mode").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
    const prev = { color, mode, interval: val("interval") || 0.1, angle: val("angle") || 0, power: val("power") || 0, passes: Math.max(1, Math.round(val("passes") || 1)), air: q("air").checked };
    q<HTMLElement>("preview").innerHTML = laserPreviewSvg(prev, 210);
    q<HTMLElement>("prevlabel").textContent = t("laser.info", { mode: t("laser.mode." + mode), p: f2(prev.power), f: f2(val("speed") || 0) })
      + (prev.passes > 1 ? ` · ${prev.passes}×` : "");
    const iv = val("interval");
    q<HTMLElement>("dpi").textContent = iv > 0 ? t("llib.dpi", { dpi: Math.round(25.4 / iv) }) : "";
  };

  root.querySelectorAll<HTMLButtonElement>(".ll-color").forEach(b => b.addEventListener("click", () => {
    color = b.dataset.color!;
    root.querySelectorAll(".ll-color").forEach(x => x.classList.toggle("active", x === b));
    refresh();
  }));
  root.querySelectorAll<HTMLButtonElement>(".llp-mode").forEach(b => b.addEventListener("click", () => { mode = b.dataset.mode as LaserMode; refresh(); }));
  const range = q("power-range");
  range.addEventListener("input", () => { q("power").value = range.value; refresh(); });
  q("power").addEventListener("input", () => { range.value = q("power").value; });
  root.querySelectorAll("input, textarea").forEach(el => el.addEventListener("input", refresh));

  const ok = () => {
    const name = q("name").value.trim();
    if (!name) { q("name").focus(); q("name").classList.add("dlg-invalid"); return; }
    if (!(val("speed") > 0)) { q("speed").focus(); q("speed").classList.add("dlg-invalid"); return; }
    const data: Partial<LaserLayer> = {
      name, color, mode,
      power: val("power"), speed: val("speed"), passes: val("passes"),
      interval: val("interval"), angle: val("angle"), air: q("air").checked, leadIn: val("leadin") || 0,
      material: q("material").value.trim(), thickness: val("thick") || 0,
      notes: q<HTMLTextAreaElement>("notes").value
    };
    if (layer) { updateLayer(layer.id, data); sel = layer.id; }
    else { const n = addLayer(data); sel = n.id; isNew = false; }
    renderLaserLibPage();
  };
  q<HTMLButtonElement>("ok").onclick = ok;
  const cancel = root.querySelector("#lp-cancel") as HTMLButtonElement | null;
  if (cancel) cancel.onclick = () => { isNew = false; renderLaserLibPage(); };
  const del = root.querySelector("#lp-del") as HTMLButtonElement | null;
  if (del && layer) del.onclick = () => {
    if (!window.confirm(t("laser.confirmDelete", { name: layer.name }))) return;
    sel = null;
    removeLayer(layer.id);
    renderLaserLibPage();
  };
  root.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA") { e.preventDefault(); ok(); }
  });
  refresh();
  if (!layer) setTimeout(() => q("name").focus(), 0);
}
