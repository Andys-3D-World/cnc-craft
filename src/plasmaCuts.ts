/**
 * PLASMA-SCHNITTE (wie die Laser-Ebenen, aber mit Plasma-Werten)
 *
 * Jeder Schnitt hat eine Farbe und: Geschwindigkeit, Schnittspalt (Kerf), Einstechhöhe,
 * Einstechzeit, Schneidhöhe, Anfahrlänge. Formen bekommen ihn über shape.plasmaCutId,
 * Formen ohne Schnitt nutzen den Standard-Schnitt.
 *
 * Maschinen-Einstellungen (für alle Schnitte): Sicherheitshöhe, Z-Achse benutzen,
 * Blechhöhe vor jedem Einstich abtasten (G38.2) + Schalter-Versatz, Überlauf am Konturende.
 * Änderungen lösen "cnc-plasma-changed" aus.
 */
import { t } from "./i18n/i18n";
import { LAYER_COLORS } from "./laserLayers";

export interface PlasmaCut {
  id: string;
  name: string;
  color: string;
  speed: number;        // mm/min
  kerf: number;         // Schnittspalt in mm
  pierceHeight: number; // mm
  pierceDelay: number;  // s
  cutHeight: number;    // mm
  leadIn: number;       // Anfahrlänge in mm (0 = direkt auf der Kontur einstechen)
}

export interface PlasmaSettings {
  safeZ: number;        // Sicherheitshöhe für Leerfahrten
  useZ: boolean;        // Z-Achse fahren (aus = fester Brenner oder Höhenregelung übernimmt)
  probe: boolean;       // vor jedem Einstich Blechhöhe abtasten (G38.2)
  probeOffset: number;  // Schalter-Versatz: so viel mm über dem Blech löst der Taster aus
  overcut: number;      // Überlauf am Ende geschlossener Konturen in mm
  /**
   * Höhenregelung (THC):
   *  none     – keine
   *  external – eigene THC-Box (z. B. Proma), wird über einen Ausgang (M8 / M7) freigegeben
   *  grblhal  – grblHAL mit Plasma-Plugin: M63/M62 P2 schaltet die THC bewegungs-synchron
   */
  thc: ThcMode;
  thcOut: "M8" | "M7";  // Freigabe-Ausgang der externen Box
  antiDive: number;     // THC so viele mm vor Konturende sperren (nur grblHAL – ohne Anhalten möglich)
  smallHole: number;    // Löcher bis zu diesem Durchmesser: ohne THC und langsamer (0 = aus)
  holeSpeed: number;    // Geschwindigkeit für kleine Löcher in % der Schnittgeschwindigkeit
}

export type ThcMode = "none" | "external" | "grblhal";

export const PLASMA_CHANGED = "cnc-plasma-changed";
const KEY_CUTS = "cnc_craft_plasma_cuts";
const KEY_ACTIVE = "cnc_craft_active_plasma_cut";
const KEY_SETTINGS = "cnc_craft_plasma_settings";

export let activeCut: PlasmaCut | null = null;
let cuts: PlasmaCut[] = [];
export const plasmaSettings: PlasmaSettings = {
  safeZ: 10, useZ: true, probe: false, probeOffset: 0, overcut: 1,
  thc: "none", thcOut: "M8", antiDive: 5, smallHole: 25, holeSpeed: 60
};

export function initPlasmaCuts() {
  try {
    const raw = localStorage.getItem(KEY_CUTS);
    if (raw) cuts = sanitizeList(JSON.parse(raw));
  } catch { cuts = []; }
  if (cuts.length === 0) {
    // Richtwerte für ein 40-A-Gerät, Baustahl – bitte an Gerät/Tabelle anpassen
    cuts = [
      sanitize({ id: "P1", name: t("plasma.def2"), color: LAYER_COLORS[0], speed: 2500, kerf: 1.5, pierceHeight: 3.8, pierceDelay: 0.3, cutHeight: 1.5, leadIn: 3 }),
      sanitize({ id: "P2", name: t("plasma.def4"), color: LAYER_COLORS[1], speed: 1500, kerf: 1.7, pierceHeight: 3.8, pierceDelay: 0.6, cutHeight: 1.5, leadIn: 4 }),
      sanitize({ id: "P3", name: t("plasma.def6"), color: LAYER_COLORS[2], speed: 900, kerf: 1.9, pierceHeight: 4.0, pierceDelay: 1.0, cutHeight: 1.5, leadIn: 5 })
    ];
    save();
  }
  let activeId: string | null = null;
  try { activeId = localStorage.getItem(KEY_ACTIVE); } catch { /* egal */ }
  activeCut = cuts.find(c => c.id === activeId) || cuts[0];
  try {
    const raw = localStorage.getItem(KEY_SETTINGS);
    if (raw) setPlasmaSettings(JSON.parse(raw), false);
  } catch { /* Standardwerte */ }
}

function sanitizeList(list: any): PlasmaCut[] {
  if (!Array.isArray(list)) return [];
  return list.filter(x => x && typeof x.id === "string").map(sanitize);
}

function num(v: any, d: number, min: number, max: number) {
  const n = +v;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
}

function sanitize(x: any): PlasmaCut {
  return {
    id: String(x.id),
    name: String(x.name || "?"),
    color: /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : LAYER_COLORS[0],
    speed: num(x.speed, 1500, 1, 50000),
    kerf: num(x.kerf, 1.5, 0, 20),
    pierceHeight: num(x.pierceHeight, 3.8, 0, 50),
    pierceDelay: num(x.pierceDelay, 0.5, 0, 30),
    cutHeight: num(x.cutHeight, 1.5, 0, 50),
    leadIn: num(x.leadIn, 3, 0, 50)
  };
}

function save() {
  try {
    localStorage.setItem(KEY_CUTS, JSON.stringify(cuts));
    if (activeCut) localStorage.setItem(KEY_ACTIVE, activeCut.id);
    localStorage.setItem(KEY_SETTINGS, JSON.stringify(plasmaSettings));
  } catch { /* egal */ }
}

function changed() {
  save();
  window.dispatchEvent(new CustomEvent(PLASMA_CHANGED));
  window.dispatchEvent(new Event("cnc-redraw"));
}

export function getCuts(): PlasmaCut[] { return cuts; }

export function getCut(id: string | undefined | null): PlasmaCut | null {
  if (!id) return null;
  return cuts.find(c => c.id === id) || null;
}

export function cutForShape(shape: any): PlasmaCut | null {
  return getCut(shape?.plasmaCutId) || activeCut || cuts[0] || null;
}

export function setActiveCut(id: string) {
  const c = getCut(id);
  if (!c) return;
  activeCut = c;
  changed();
}

export function addCut(data: Partial<PlasmaCut>): PlasmaCut {
  const used = new Set(cuts.map(c => c.color));
  const color = data.color || LAYER_COLORS.find(c => !used.has(c)) || LAYER_COLORS[cuts.length % LAYER_COLORS.length];
  const c = sanitize({ ...data, color, id: newCutId() });
  cuts.push(c);
  changed();
  return c;
}

export function updateCut(id: string, data: Partial<PlasmaCut>) {
  const i = cuts.findIndex(c => c.id === id);
  if (i < 0) return;
  cuts[i] = sanitize({ ...cuts[i], ...data, id });
  if (activeCut && activeCut.id === id) activeCut = cuts[i];
  changed();
}

export function removeCut(id: string) {
  if (cuts.length <= 1) return;
  cuts = cuts.filter(c => c.id !== id);
  if (!activeCut || activeCut.id === id) activeCut = cuts[0];
  changed();
}

export function moveCut(id: string, dir: -1 | 1) {
  const i = cuts.findIndex(c => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cuts.length) return;
  [cuts[i], cuts[j]] = [cuts[j], cuts[i]];
  changed();
}

export function setPlasmaSettings(s: Partial<PlasmaSettings>, notify = true) {
  if (s.safeZ !== undefined) plasmaSettings.safeZ = num(s.safeZ, plasmaSettings.safeZ, 0, 200);
  if (s.useZ !== undefined) plasmaSettings.useZ = !!s.useZ;
  if (s.probe !== undefined) plasmaSettings.probe = !!s.probe;
  if (s.probeOffset !== undefined) plasmaSettings.probeOffset = num(s.probeOffset, plasmaSettings.probeOffset, -20, 20);
  if (s.overcut !== undefined) plasmaSettings.overcut = num(s.overcut, plasmaSettings.overcut, 0, 20);
  if (s.thc !== undefined) plasmaSettings.thc = (["none", "external", "grblhal"] as const).includes(s.thc as ThcMode) ? s.thc as ThcMode : plasmaSettings.thc;
  if (s.thcOut !== undefined) plasmaSettings.thcOut = s.thcOut === "M7" ? "M7" : "M8";
  if (s.antiDive !== undefined) plasmaSettings.antiDive = num(s.antiDive, plasmaSettings.antiDive, 0, 100);
  if (s.smallHole !== undefined) plasmaSettings.smallHole = num(s.smallHole, plasmaSettings.smallHole, 0, 500);
  if (s.holeSpeed !== undefined) plasmaSettings.holeSpeed = num(s.holeSpeed, plasmaSettings.holeSpeed, 10, 100);
  if (notify) changed();
}

export function mergeProjectCuts(list: any, shapes: any[]): number {
  const incoming = sanitizeList(list);
  let added = 0;
  for (const c of incoming) {
    const same = cuts.find(x => x.name === c.name && x.speed === c.speed && x.kerf === c.kerf && x.pierceDelay === c.pierceDelay);
    let newId = c.id;
    if (same) newId = same.id;
    else {
      if (getCut(c.id)) newId = newCutId();
      cuts.push({ ...c, id: newId });
      added++;
    }
    if (newId !== c.id) shapes.forEach(s => { if (s.plasmaCutId === c.id) s.plasmaCutId = newId; });
  }
  if (added) changed();
  return added;
}

export function cutsUsedBy(shapes: any[]): PlasmaCut[] {
  const ids = new Set<string>();
  shapes.forEach(s => { const c = cutForShape(s); if (c) ids.add(c.id); });
  return cuts.filter(c => ids.has(c.id));
}

function newCutId() {
  let id = "";
  do { id = "P" + Math.random().toString(36).substring(2, 8); } while (getCut(id));
  return id;
}

/** Kurzinfo: "2500 mm/min · Spalt 1.5 mm · 0.3 s" */
export function cutInfo(c: PlasmaCut): string {
  return t("plasma.info", { f: c.speed, k: c.kerf, d: c.pierceDelay });
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch] as string));
}

// ---------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------

export function openCutDialog(cut: PlasmaCut | null, onDone?: (c: PlasmaCut | null) => void) {
  document.getElementById("tool-dialog-overlay")?.remove();
  const isNew = !cut;
  const used = new Set(cuts.map(c => c.color));
  const src: PlasmaCut = cut || sanitize({ id: "", name: "", color: LAYER_COLORS.find(c => !used.has(c)) || LAYER_COLORS[0] });

  const ov = document.createElement("div");
  ov.id = "tool-dialog-overlay";
  ov.className = "dlg-overlay";
  const row = (key: string, id: string, value: number, step: string, unit: string) => `
      <label class="dlg-row"><span>${t(key)}</span>
        <span class="dlg-num"><input id="${id}" type="number" value="${value}" min="0" step="${step}"><em>${unit}</em></span></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog">
      <h3>🔥 ${t(isNew ? "plasma.newTitle" : "plasma.editTitle")}</h3>
      <label class="dlg-row"><span>${t("laser.name")}</span>
        <input id="pc-name" type="text" value="${esc(src.name)}" placeholder="${esc(t("plasma.namePh"))}" style="width:180px;"></label>
      <div class="dlg-row"><span>${t("laser.color")}</span>
        <span class="ll-colors">${LAYER_COLORS.map(c => `<button type="button" class="ll-color${c === src.color ? " active" : ""}" data-color="${c}" style="background:${c}"></button>`).join("")}</span></div>
      ${row("laser.speed", "pc-speed", src.speed, "100", "mm/min")}
      ${row("plasma.kerf", "pc-kerf", src.kerf, "0.1", "mm")}
      ${row("plasma.pierceHeight", "pc-ph", src.pierceHeight, "0.1", "mm")}
      ${row("plasma.pierceDelay", "pc-pd", src.pierceDelay, "0.1", "s")}
      ${row("plasma.cutHeight", "pc-ch", src.cutHeight, "0.1", "mm")}
      ${row("plasma.leadIn", "pc-lead", src.leadIn, "0.5", "mm")}
      <div class="dlg-hint">${t("plasma.dlgHint")}</div>
      <div class="dlg-buttons">
        ${!isNew && cuts.length > 1 ? `<button id="pc-del" class="btn-secondary dlg-danger">🗑</button>` : ""}
        <button id="pc-cancel" class="btn-secondary" style="flex:1;">${t("dlg.cancel")}</button>
        <button id="pc-ok" class="btn-primary" style="flex:2;">✔ ${t(isNew ? "tool.create" : "tool.save")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const q = (id: string) => ov.querySelector("#" + id) as HTMLInputElement;
  let color = src.color;
  const close = (r: PlasmaCut | null) => { ov.remove(); onDone?.(r); };
  ov.querySelectorAll<HTMLButtonElement>(".ll-color").forEach(b => b.addEventListener("click", () => {
    color = b.dataset.color!;
    ov.querySelectorAll(".ll-color").forEach(x => x.classList.toggle("active", x === b));
  }));
  ov.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape") close(null);
    if (e.key === "Enter") q("pc-ok").click();
  });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(null); });
  q("pc-cancel").onclick = () => close(null);
  const del = ov.querySelector("#pc-del") as HTMLElement | null;
  if (del && cut) del.onclick = () => {
    if (!window.confirm(t("laser.confirmDelete", { name: cut.name }))) return;
    removeCut(cut.id);
    close(null);
  };
  q("pc-ok").onclick = () => {
    const name = q("pc-name").value.trim();
    if (!name) { q("pc-name").focus(); q("pc-name").classList.add("dlg-invalid"); return; }
    const data: Partial<PlasmaCut> = {
      name, color,
      speed: parseFloat(q("pc-speed").value),
      kerf: parseFloat(q("pc-kerf").value),
      pierceHeight: parseFloat(q("pc-ph").value),
      pierceDelay: parseFloat(q("pc-pd").value),
      cutHeight: parseFloat(q("pc-ch").value),
      leadIn: parseFloat(q("pc-lead").value)
    };
    if (cut) { updateCut(cut.id, data); close(getCut(cut.id)); }
    else close(addCut(data));
  };
  setTimeout(() => { const n = q("pc-name"); n.focus(); n.select(); }, 0);
}
