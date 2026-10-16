/**
 * WERKZEUG-EDITOR – wie der Werkzeug-Dialog in Estlcam
 *
 *   - Art per Bild wählen: Schaftfräser, Kugelfräser, Torusfräser, V-Stichel, Fasenfräser,
 *     Senker, Bohrer, Planfräser
 *   - Schneidenzahl (1, 2, 3, 4, 6 …) mit Ansicht von unten, Spiral-Richtung
 *     (aufwärts / abwärts / Kompression / gerade), Schneidstoff (Hartmetall / HSS)
 *   - Maße passend zur Art (Winkel nur bei Kegel-Werkzeugen, Eckenradius nur beim Torusfräser …)
 *   - große Zeichnung mit Bemaßung, die sich beim Tippen mitändert
 *   - Schnittdaten (Drehzahl, Vorschub, Eintauchen, Zustellung) + Rechner nach Material
 *
 * Benutzt an zwei Stellen:
 *   openToolDialog()  – Fenster (aus dem CAM-Bereich: ＋ / ✎), Feld-IDs "tl-…"
 *   renderToolPage()  – Reiter "Werkzeuge": Liste links, Editor rechts, Einstellungen, IDs "tp-…"
 */
import { t } from "../i18n/i18n";
import {
  MillingTool, ToolType, Helix, TOOL_TYPES, CONE_TYPES, TYPE_DEFAULTS, typeGeom, MATERIALS,
  calcCutData, toolSettings, setToolSettings, getTools, getTool, addTool, updateTool, removeTool,
  duplicateTool, moveTool, activeTool, setActiveTool, toolNumber, toolColor, toolTypeName, fmt,
  sanitize, DEFAULT_PLUNGE, TOOLS_CHANGED
} from "../toolLibrary";
import { toolSideSvg, toolEndSvg, toolIconSvg, coneHeight } from "../toolGraphics";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

const FLUTE_CHOICES = [1, 2, 3, 4, 6];

/** Vorschlag für den Namen, z. B. "3 mm Schaftfräser 2-schneidig" oder "V-Stichel 60° Ø6" */
export function autoToolName(x: { type: ToolType; diameter: number; flutes: number; angle: number }): string {
  const typ = toolTypeName(x);
  if (x.type === "vbit" || x.type === "chamfer" || x.type === "countersink") return t("tl.autoNameAngle", { type: typ, a: fmt(x.angle), d: fmt(x.diameter) });
  return t("tl.autoName", { d: fmt(x.diameter), type: typ, z: x.flutes });
}

// ---------------------------------------------------------------------
// Editor (HTML + Logik)
// ---------------------------------------------------------------------

interface EditorHandlers {
  onSave: (data: Partial<MillingTool>) => void;
  onCancel?: () => void;
  onDelete?: () => void;
  compact?: boolean;
}

function editorHtml(p: string, src: MillingTool, isNew: boolean, h: EditorHandlers): string {
  const num = (key: string, id: string, value: number, step: string, unit: string, cls = "", tipKey = "") => `
    <label class="te-row ${cls}" ${tipKey ? `data-tip="${esc(t(tipKey))}"` : ""}><span>${esc(t(key))}</span>
      <span class="dlg-num"><input id="${p}${id}" type="number" value="${value}" min="0" step="${step}"><em>${unit}</em></span></label>`;
  const typeBtns = TOOL_TYPES.map(ty => `
    <button type="button" class="te-type${ty === src.type ? " active" : ""}" data-type="${ty}" data-tip="${esc(t("tl.typeTip." + ty))}">
      ${toolIconSvg(typeGeom(ty), 30, 46)}<span>${esc(t("tl.type." + ty))}</span></button>`).join("");
  const fluteBtns = FLUTE_CHOICES.map(z => `<button type="button" class="te-flute${z === src.flutes ? " active" : ""}" data-z="${z}">${z}</button>`).join("");
  const matOpts = MATERIALS.map(m => `<option value="${m.id}"${m.id === toolSettings.material ? " selected" : ""}>${esc(t("tl.mat." + m.id))}</option>`).join("");
  return `
    <div class="te${h.compact ? " te-compact" : ""}">
      <label class="te-row te-name"><span>${esc(t("tool.name"))}</span>
        <input id="${p}name" type="text" value="${esc(src.name)}" placeholder="${esc(t("lib.namePh"))}"></label>
      <div class="te-types" id="${p}types">${typeBtns}</div>
      <div class="te-main">
        <div class="te-preview">
          <div class="te-side" id="${p}side"></div>
          <div class="te-endbox">
            <div id="${p}end"></div>
            <div class="te-end-label" id="${p}endlabel"></div>
          </div>
        </div>
        <div class="te-fields">
          <fieldset><legend>${esc(t("tl.geometry"))}</legend>
            ${num("tool.dia", "dia", src.diameter, "0.1", "mm", "", "tl.diaTip")}
            ${num("tl.g.shank", "shank", src.shankDia, "0.1", "mm")}
            ${num("tl.g.fluteLen", "flutelen", src.fluteLen, "0.5", "mm", "", "tl.fluteLenTip")}
            ${num("tl.g.length", "len", src.length, "1", "mm", "", "tl.lengthTip")}
            ${num("tl.g.angle", "angle", src.angle, "1", "°", "te-cone")}
            ${num("tl.g.tip", "tip", src.tipDia, "0.05", "mm", "te-tip", "tl.tipTip")}
            ${num("tl.g.corner", "corner", src.cornerR, "0.1", "mm", "te-corner")}
            <div class="te-row"><span>${esc(t("tl.g.flutes"))}</span>
              <span class="te-flutes">${fluteBtns}<input id="${p}flutes" type="number" min="1" max="12" step="1" value="${src.flutes}"></span></div>
            <label class="te-row te-helix-row" data-tip="${esc(t("tl.helixTip"))}"><span>${esc(t("tl.g.helix"))}</span>
              <select id="${p}helix">
                ${(["up", "down", "compression", "straight"] as Helix[]).map(x => `<option value="${x}"${x === src.helix ? " selected" : ""}>${esc(t("tl.helix." + x))}</option>`).join("")}
              </select></label>
            <label class="te-row"><span>${esc(t("tl.g.toolMat"))}</span>
              <select id="${p}tmat">
                <option value="carbide"${src.toolMat !== "hss" ? " selected" : ""}>${esc(t("tl.tmat.carbide"))}</option>
                <option value="hss"${src.toolMat === "hss" ? " selected" : ""}>${esc(t("tl.tmat.hss"))}</option>
              </select></label>
          </fieldset>
          <fieldset><legend>${esc(t("tl.cutting"))}</legend>
            ${num("tool.rpm", "rpm", src.rpm, "500", esc(t("unit.rpm")))}
            ${num("tool.feed", "feed", src.feedrate, "50", "mm/min")}
            ${num("tool.plunge", "plunge", src.plungeFeed ?? DEFAULT_PLUNGE, "50", "mm/min")}
            ${num("tool.stepz", "stepz", src.stepZ, "0.1", "mm")}
            <div class="te-calc" data-tip="${esc(t("tl.calcTip"))}">
              <select id="${p}mat">${matOpts}</select>
              <button type="button" id="${p}calc" class="btn-secondary">🧮 ${esc(t("tl.calc"))}</button>
            </div>
            <div class="te-calc-res" id="${p}calcres"></div>
          </fieldset>
          <label class="te-row te-notes"><span>${esc(t("tl.notes"))}</span>
            <textarea id="${p}notes" rows="2" placeholder="${esc(t("tl.notesPh"))}">${esc(src.notes || "")}</textarea></label>
        </div>
      </div>
      <div class="dlg-buttons">
        ${h.onDelete ? `<button id="${p}del" class="btn-secondary dlg-danger" data-tip="${esc(t("tool.deleteTip"))}">🗑</button>` : ""}
        ${h.onCancel ? `<button id="${p}cancel" class="btn-secondary" style="flex:1;">${esc(t("dlg.cancel"))}</button>` : ""}
        <button id="${p}ok" class="btn-primary" style="flex:2;">✔ ${esc(t(isNew ? "tool.create" : "tool.save"))}</button>
      </div>
    </div>`;
}

/** Editor in `root` aufbauen. Gibt eine Funktion zurück, die die aktuellen Werte liefert. */
function mountEditor(root: HTMLElement, p: string, tool: MillingTool | null, h: EditorHandlers) {
  const isNew = !tool;
  const src: MillingTool = tool ? { ...tool } : sanitize({
    id: "", name: "", type: "endmill", ...TYPE_DEFAULTS.endmill, stepZ: 1.5, feedrate: 1000, rpm: 15000, plungeFeed: DEFAULT_PLUNGE
  });
  if (isNew) src.name = ""; // sanitize setzt "?" – neues Werkzeug bekommt einen Namensvorschlag
  root.innerHTML = editorHtml(p, src, isNew, h);
  const q = <T extends HTMLElement = HTMLInputElement>(id: string) => root.querySelector("#" + p + id) as T;
  let type: ToolType = src.type;
  // Name automatisch vorschlagen, solange man ihn nicht selbst geändert hat
  let lastAuto = isNew ? "" : (src.name === autoToolName(src) ? src.name : null);

  const val = (id: string) => parseFloat(q(id).value);
  const read = (): MillingTool => sanitize({
    id: src.id || "x", name: q("name").value.trim() || "?", type,
    diameter: val("dia"), shankDia: val("shank"), fluteLen: val("flutelen"), length: val("len"),
    angle: val("angle"), tipDia: val("tip"), cornerR: val("corner"), flutes: val("flutes"),
    helix: q<HTMLSelectElement>("helix").value, toolMat: q<HTMLSelectElement>("tmat").value,
    rpm: val("rpm"), feedrate: val("feed"), plungeFeed: val("plunge"), stepZ: val("stepz"),
    notes: q<HTMLTextAreaElement>("notes").value
  });

  const refresh = () => {
    const g = read();
    root.querySelectorAll<HTMLElement>(".te-type").forEach(b => b.classList.toggle("active", b.dataset.type === type));
    const cone = CONE_TYPES.includes(type);
    root.querySelectorAll<HTMLElement>(".te-cone").forEach(e => { e.style.display = cone ? "" : "none"; });
    root.querySelectorAll<HTMLElement>(".te-tip").forEach(e => { e.style.display = type === "vbit" || type === "chamfer" ? "" : "none"; });
    root.querySelectorAll<HTMLElement>(".te-corner").forEach(e => { e.style.display = type === "bullnose" ? "" : "none"; });
    root.querySelectorAll<HTMLElement>(".te-helix-row").forEach(e => { e.style.display = cone && type !== "drill" ? "none" : ""; });
    // Schneidenlänge 0 = automatisch (Kegelhöhe)
    const fl = q("flutelen");
    fl.placeholder = cone ? fmt(coneHeight(g)) : "";
    root.querySelectorAll<HTMLElement>(".te-flute").forEach(b => b.classList.toggle("active", +b.dataset.z! === g.flutes));
    const w = h.compact ? 210 : 250, hh = h.compact ? 250 : 300;
    q<HTMLElement>("side").innerHTML = toolSideSvg(g, { w, h: hh, dims: true, t });
    q<HTMLElement>("end").innerHTML = toolEndSvg(g, h.compact ? 70 : 84);
    q<HTMLElement>("endlabel").textContent = t("tl.flutesN", { n: g.flutes });
    if (lastAuto !== null && (q("name").value === lastAuto || q("name").value === "")) {
      lastAuto = autoToolName(g);
      q("name").value = lastAuto;
    }
  };

  // Art wählen: Winkel/Spitze/Radius/Spirale/Schneiden auf typische Werte, bei neuem Werkzeug alle Maße
  q<HTMLElement>("types").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest(".te-type") as HTMLElement | null;
    if (!b) return;
    type = b.dataset.type as ToolType;
    const d = TYPE_DEFAULTS[type];
    const set = (id: string, v: number | string) => { q(id).value = String(v); };
    set("angle", d.angle); set("tip", d.tipDia); set("corner", d.cornerR); set("flutes", d.flutes);
    q<HTMLSelectElement>("helix").value = d.helix;
    if (isNew) { set("dia", d.diameter); set("shank", d.shankDia); set("len", d.length); prevDia = d.shankDia === d.diameter ? d.diameter : NaN; }
    set("flutelen", d.fluteLen);
    refresh();
  });
  root.querySelectorAll<HTMLElement>(".te-flute").forEach(b => b.addEventListener("click", () => { q("flutes").value = b.dataset.z!; refresh(); }));
  // Schaft-Ø zieht beim Ändern des Durchmessers mit, solange er gleich groß war
  let prevDia = src.diameter;
  root.querySelectorAll("input, select, textarea").forEach(el => el.addEventListener("input", () => {
    const id = (el as HTMLElement).id;
    if (id === p + "name") { lastAuto = null; return; }
    if (id === p + "dia") {
      const d = val("dia");
      const cone = type === "vbit" || type === "chamfer" || type === "countersink" || type === "facemill";
      if (!cone && d > 0 && Math.abs(val("shank") - prevDia) < 1e-6) q("shank").value = String(d);
      if (d > 0) prevDia = d;
    }
    refresh();
  }));

  // Rechner
  q<HTMLButtonElement>("calc").addEventListener("click", () => {
    const mat = q<HTMLSelectElement>("mat").value;
    const r = calcCutData(read(), mat);
    q("rpm").value = String(r.rpm); q("feed").value = String(r.feedrate);
    q("plunge").value = String(r.plungeFeed); q("stepz").value = String(r.stepZ);
    q<HTMLElement>("calcres").textContent = t("tl.calcRes", { fz: r.fz, z: read().flutes, mat: t("tl.mat." + mat) })
      + (r.limited ? " " + t("tl.calcLimited") : "");
    if (toolSettings.material !== mat) setToolSettings({ material: mat });
    refresh();
  });

  const ok = () => {
    const name = q("name").value.trim();
    if (!name) { q("name").focus(); q("name").classList.add("dlg-invalid"); return; }
    const dia = val("dia");
    if (!(dia > 0)) { q("dia").focus(); q("dia").classList.add("dlg-invalid"); return; }
    const g = read();
    if ((type === "vbit" || type === "chamfer") && !(g.tipDia < g.diameter)) { q("tip").focus(); q("tip").classList.add("dlg-invalid"); return; }
    if (CONE_TYPES.includes(type) && !(val("angle") >= 10 && val("angle") <= 170)) { q("angle").focus(); q("angle").classList.add("dlg-invalid"); return; }
    const data: Partial<MillingTool> = { ...g, name };
    delete (data as any).id;
    h.onSave(data);
  };
  q<HTMLButtonElement>("ok").onclick = ok;
  if (h.onCancel) q<HTMLButtonElement>("cancel").onclick = h.onCancel;
  if (h.onDelete) q<HTMLButtonElement>("del").onclick = h.onDelete;
  root.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA") { e.preventDefault(); ok(); }
  });
  refresh();
  return { read, focusName: () => { const n = q("name"); n.focus(); n.select(); } };
}

// ---------------------------------------------------------------------
// Dialog (aus dem CAM-Bereich)
// ---------------------------------------------------------------------

/**
 * Öffnet den Werkzeug-Dialog. Ohne Werkzeug = neues Werkzeug anlegen.
 * onDone bekommt das gespeicherte Werkzeug (oder null bei Abbruch/Löschen).
 */
export function openToolDialog(tool: MillingTool | null, onDone?: (tool: MillingTool | null) => void) {
  document.getElementById("tool-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "tool-dialog-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `<div class="dlg-box te-dlg" role="dialog"><h3>🛠️ ${esc(t(tool ? "tool.editTitle" : "tool.newTitle"))}</h3><div class="te-host"></div></div>`;
  document.body.appendChild(ov);
  const close = (r: MillingTool | null) => { ov.remove(); onDone?.(r); };
  const ed = mountEditor(ov.querySelector(".te-host") as HTMLElement, "tl-", tool, {
    compact: true,
    onSave: (data) => {
      if (tool) { updateTool(tool.id, data); close(getTool(tool.id)); }
      else close(addTool(data));
    },
    onCancel: () => close(null),
    onDelete: tool && getTools().length > 1 ? () => {
      if (!window.confirm(t("tool.confirmDelete", { name: tool.name }))) return;
      removeTool(tool.id);
      close(null);
    } : undefined
  });
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(null); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(null); });
  setTimeout(() => ed.focusName(), 0);
}

// ---------------------------------------------------------------------
// Seite "Werkzeuge"
// ---------------------------------------------------------------------

let pageSel: string | null = null;   // gerade bearbeitetes Werkzeug (null = neues)
let pageNew = false;

/** Sprache gewechselt: Seite komplett neu aufbauen */
export function renderToolTable() {
  const page = document.getElementById("tool-page");
  if (page) page.innerHTML = "";
  renderToolPage();
}

export function initToolPage() {
  window.addEventListener(TOOLS_CHANGED, () => renderToolPage(false));
  renderToolPage();
}

/** Seite neu zeichnen. withEditor=false: nur Liste/Einstellungen (Editor-Eingaben bleiben stehen) */
export function renderToolPage(withEditor = true) {
  const page = document.getElementById("tool-page");
  if (!page) return;
  const tools = getTools();
  if (!pageNew && (!pageSel || !getTool(pageSel))) pageSel = activeTool?.id || tools[0]?.id || null;

  if (!page.querySelector(".tlp")) {
    page.innerHTML = `
      <div class="tlp">
        <div class="tlp-left">
          <div class="tlp-head">
            <button id="tp-new" class="btn-primary">＋ ${esc(t("tl.new"))}</button>
            <button id="tp-dup" class="btn-secondary" data-tip="${esc(t("tl.dupTip"))}">⧉</button>
            <button id="tp-up" class="btn-secondary" data-tip="${esc(t("tl.upTip"))}">▲</button>
            <button id="tp-down" class="btn-secondary" data-tip="${esc(t("tl.downTip"))}">▼</button>
          </div>
          <div id="tp-list" class="tlp-list"></div>
          <div class="tlp-settings">
            <h4>⚙️ ${esc(t("tl.settings"))}</h4>
            <label class="te-row" data-tip="${esc(t("tl.set.maxRpmTip"))}"><span>${esc(t("tl.set.maxRpm"))}</span><span class="dlg-num"><input id="tps-maxrpm" type="number" min="100" step="1000"><em>${esc(t("unit.rpm"))}</em></span></label>
            <label class="te-row" data-tip="${esc(t("tl.set.minRpmTip"))}"><span>${esc(t("tl.set.minRpm"))}</span><span class="dlg-num"><input id="tps-minrpm" type="number" min="0" step="1000"><em>${esc(t("unit.rpm"))}</em></span></label>
            <label class="te-row" data-tip="${esc(t("tl.set.maxFeedTip"))}"><span>${esc(t("tl.set.maxFeed"))}</span><span class="dlg-num"><input id="tps-maxfeed" type="number" min="10" step="100"><em>mm/min</em></span></label>
            <label class="te-row"><span>${esc(t("tl.set.material"))}</span><select id="tps-mat">${MATERIALS.map(m => `<option value="${m.id}">${esc(t("tl.mat." + m.id))}</option>`).join("")}</select></label>
            <button id="tps-all" class="btn-secondary" data-tip="${esc(t("tl.set.allTip"))}">🧮 ${esc(t("tl.set.all"))}</button>
            <div class="tool-scope">${esc(t("tl.set.hint"))}</div>
          </div>
        </div>
        <div class="tlp-right">
          <div class="tlp-edit-head" id="tp-edit-head"></div>
          <div id="tp-editor"></div>
        </div>
      </div>`;
    bindPage(page);
  }

  // Liste
  const list = page.querySelector("#tp-list") as HTMLElement;
  list.innerHTML = tools.map(tl => {
    const sel = !pageNew && tl.id === pageSel;
    const def = activeTool?.id === tl.id;
    return `
      <div class="tlp-item${sel ? " sel" : ""}" data-id="${tl.id}">
        <div class="tlp-ico">${toolIconSvg(tl, 22, 44, toolColor(tl))}</div>
        <div class="tlp-txt">
          <div class="tlp-name"><b style="color:${toolColor(tl)}">T${toolNumber(tl)}</b> ${esc(tl.name)}</div>
          <div class="tlp-info">${esc(toolTypeName(tl))} · Ø${fmt(tl.diameter)} · ${esc(t("tl.flutesN", { n: tl.flutes }))} · S${tl.rpm} · F${tl.feedrate}</div>
        </div>
        <button class="tlp-star${def ? " on" : ""}" data-act="default" data-tip="${esc(t(def ? "tl.isDefault" : "tl.makeDefault"))}">${def ? "★" : "☆"}</button>
      </div>`;
  }).join("") + (pageNew ? `<div class="tlp-item sel tlp-newitem"><div class="tlp-txt"><div class="tlp-name">＋ ${esc(t("tool.newTitle"))}</div></div></div>` : "");

  // Einstellungen
  const setv = (id: string, v: string) => { const e = page.querySelector("#" + id) as HTMLInputElement; if (e && document.activeElement !== e) e.value = v; };
  setv("tps-maxrpm", String(toolSettings.maxRpm)); setv("tps-minrpm", String(toolSettings.minRpm));
  setv("tps-maxfeed", String(toolSettings.maxFeed)); setv("tps-mat", toolSettings.material);
  (page.querySelector("#tp-dup") as HTMLButtonElement).disabled = pageNew || !pageSel;
  (page.querySelector("#tp-up") as HTMLButtonElement).disabled = pageNew || tools[0]?.id === pageSel;
  (page.querySelector("#tp-down") as HTMLButtonElement).disabled = pageNew || tools[tools.length - 1]?.id === pageSel;

  if (!withEditor) return;
  const tool = pageNew ? null : getTool(pageSel);
  const head = page.querySelector("#tp-edit-head") as HTMLElement;
  head.innerHTML = tool
    ? `<h3>🛠️ <b style="color:${toolColor(tool)}">T${toolNumber(tool)}</b> ${esc(tool.name)}</h3>`
    : `<h3>🛠️ ${esc(t("tool.newTitle"))}</h3>`;
  const ed = mountEditor(page.querySelector("#tp-editor") as HTMLElement, "tp-", tool, {
    onSave: (data) => {
      if (tool) { updateTool(tool.id, data); pageSel = tool.id; }
      else { const n = addTool(data); pageSel = n.id; pageNew = false; }
      renderToolPage();
    },
    onCancel: pageNew ? () => { pageNew = false; renderToolPage(); } : undefined,
    onDelete: tool && getTools().length > 1 ? () => {
      if (!window.confirm(t("tool.confirmDelete", { name: tool.name }))) return;
      removeTool(tool.id);
      pageSel = null;
      renderToolPage();
    } : undefined
  });
  if (pageNew) setTimeout(() => ed.focusName(), 0);
}

function bindPage(page: HTMLElement) {
  page.querySelector("#tp-list")!.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest(".tlp-item[data-id]") as HTMLElement | null;
    if (!item) return;
    const id = item.dataset.id!;
    if ((e.target as HTMLElement).closest("[data-act=default]")) { setActiveTool(id); return; }
    pageSel = id; pageNew = false;
    renderToolPage();
  });
  page.querySelector("#tp-new")!.addEventListener("click", () => { pageNew = true; renderToolPage(); });
  page.querySelector("#tp-dup")!.addEventListener("click", () => {
    if (!pageSel) return;
    const c = duplicateTool(pageSel);
    if (c) { pageSel = c.id; renderToolPage(); }
  });
  page.querySelector("#tp-up")!.addEventListener("click", () => { if (pageSel) moveTool(pageSel, -1); renderToolPage(); });
  page.querySelector("#tp-down")!.addEventListener("click", () => { if (pageSel) moveTool(pageSel, 1); renderToolPage(); });
  const bind = (id: string, key: "maxRpm" | "minRpm" | "maxFeed" | "material") => {
    const el = page.querySelector("#" + id) as HTMLInputElement;
    el.addEventListener("change", () => setToolSettings({ [key]: key === "material" ? el.value : parseFloat(el.value) } as any));
  };
  bind("tps-maxrpm", "maxRpm"); bind("tps-minrpm", "minRpm"); bind("tps-maxfeed", "maxFeed"); bind("tps-mat", "material");
  // Alle Werkzeuge für das gewählte Material neu berechnen
  page.querySelector("#tps-all")!.addEventListener("click", () => {
    const mat = toolSettings.material;
    if (!window.confirm(t("tl.set.allConfirm", { mat: t("tl.mat." + mat), n: getTools().length }))) return;
    for (const tl of getTools().slice()) {
      const r = calcCutData(tl, mat);
      updateTool(tl.id, { rpm: r.rpm, feedrate: r.feedrate, plungeFeed: r.plungeFeed, stepZ: r.stepZ });
    }
    renderToolPage();
  });
}
