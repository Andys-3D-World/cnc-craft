/**
 * LASER-EBENEN (wie die "Cuts / Layers" in LightBurn)
 *
 * Jede Ebene hat eine Farbe und eigene Einstellungen: Linie oder Füllen, Leistung in %,
 * Geschwindigkeit, Durchgänge, Linienabstand/Winkel beim Füllen, Luftunterstützung.
 * Jede Form kann einer Ebene zugeordnet werden (shape.laserLayerId). Formen ohne Ebene
 * gehören zur Standard-Ebene (activeLayer).
 *
 * Für die Bibliothek (Reiter "Laser-Bibliothek", ui/laserLibPage.ts) zusätzlich Material, Dicke und Notiz.
 *
 * Außerdem die Laser-Maschineneinstellungen: höchster S-Wert ($30) und M4 (dynamische Leistung).
 * Änderungen lösen "cnc-laser-layers-changed" aus.
 */
import { t } from "./i18n/i18n";

export type LaserMode = "line" | "fill" | "fill+line";

export interface LaserLayer {
  id: string;
  name: string;
  color: string;
  mode: LaserMode;
  power: number;      // Leistung in % (0–100) – bei „Füllen + Linie“ für die Linie
  speed: number;      // mm/min – bei „Füllen + Linie“ für die Linie
  fillPower: number;  // nur „Füllen + Linie“: Leistung % für die Fläche (meist weniger als für die Linie)
  fillSpeed: number;  // nur „Füllen + Linie“: Geschwindigkeit mm/min für die Fläche
  passes: number;     // Durchgänge
  interval: number;   // Linienabstand beim Füllen in mm
  angle: number;      // Winkel der Füll-Linien in Grad
  air: boolean;       // Luftunterstützung (M8)
  leadIn: number;     // Freischnitt: Anfahrlänge in mm bei geschlossenen Konturen (0 = aus)
  material: string;   // Material (frei, z. B. "Pappel-Sperrholz") – nur zur Übersicht
  thickness: number;  // Materialdicke in mm (0 = keine Angabe)
  notes: string;      // Notiz
}

export interface LaserSettings {
  sMax: number;       // S-Wert für 100 % (GRBL: $30, meist 1000)
  dynamic: boolean;   // M4 = Leistung passt sich der Geschwindigkeit an (empfohlen)
}

export const LAYERS_CHANGED = "cnc-laser-layers-changed";
const KEY_LAYERS = "cnc_craft_laser_layers";
const KEY_ACTIVE = "cnc_craft_active_laser_layer";
const KEY_SETTINGS = "cnc_craft_laser_settings";

/** Farben wie in LightBurn – gut zu unterscheiden auf dunklem Grund */
export const LAYER_COLORS = [
  "#ff4040", "#3d8bff", "#2ecc71", "#ffb020", "#c06bff", "#00d0e0",
  "#ff6ec7", "#a0d911", "#ff8a3d", "#8a8fff", "#e0e0e0", "#b08960"
];

export let activeLayer: LaserLayer | null = null;
let layers: LaserLayer[] = [];
export const laserSettings: LaserSettings = { sMax: 1000, dynamic: true };

// ---------------------------------------------------------------------
// Laden / Speichern
// ---------------------------------------------------------------------

export function initLaserLayers() {
  try {
    const raw = localStorage.getItem(KEY_LAYERS);
    if (raw) layers = sanitizeList(JSON.parse(raw));
  } catch { layers = []; }
  if (layers.length === 0) {
    // Reihenfolge = Laser-Reihenfolge: erst gravieren, zuletzt ausschneiden
    layers = [
      sanitize({ id: "L2", name: t("laser.defEngrave"), color: LAYER_COLORS[1], mode: "fill", power: 50, speed: 3000, passes: 1, interval: 0.1 }),
      sanitize({ id: "L3", name: t("laser.defMark"), color: LAYER_COLORS[2], mode: "line", power: 30, speed: 1500, passes: 1 }),
      sanitize({ id: "L1", name: t("laser.defCut"), color: LAYER_COLORS[0], mode: "line", power: 100, speed: 300, passes: 1, air: true })
    ];
    save();
  }
  let activeId: string | null = null;
  try { activeId = localStorage.getItem(KEY_ACTIVE); } catch { /* egal */ }
  activeLayer = layers.find(l => l.id === activeId) || layers.find(l => l.id === "L1") || layers[0];

  try {
    const raw = localStorage.getItem(KEY_SETTINGS);
    if (raw) {
      const s = JSON.parse(raw);
      if (Number.isFinite(+s.sMax) && +s.sMax > 0) laserSettings.sMax = +s.sMax;
      if (typeof s.dynamic === "boolean") laserSettings.dynamic = s.dynamic;
    }
  } catch { /* Standardwerte */ }
}

function sanitizeList(list: any): LaserLayer[] {
  if (!Array.isArray(list)) return [];
  return list.filter(x => x && typeof x.id === "string").map(sanitize);
}

function sanitize(x: any): LaserLayer {
  const num = (v: any, d: number, min: number, max: number) => {
    const n = +v;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  const mode: LaserMode = x.mode === "fill" || x.mode === "fill+line" ? x.mode : "line";
  return {
    // aus importierten Dateien: nur harmlose Zeichen (die ID landet in HTML-Attributen)
    id: String(x.id).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "x" + Date.now().toString(36),
    name: String(x.name || "?").slice(0, 120),
    color: /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : LAYER_COLORS[0],
    mode,
    power: num(x.power, 50, 0, 100),
    speed: num(x.speed, 1000, 1, 100000),
    // ältere Ebenen kennen das noch nicht -> wie bisher dieselben Werte wie die Linie
    fillPower: num(x.fillPower, num(x.power, 50, 0, 100), 0, 100),
    fillSpeed: num(x.fillSpeed, num(x.speed, 1000, 1, 100000), 1, 100000),
    passes: Math.round(num(x.passes, 1, 1, 100)),
    interval: num(x.interval, 0.1, 0.01, 10),
    angle: num(x.angle, 0, -180, 180),
    air: !!x.air,
    leadIn: num(x.leadIn, 0, 0, 20),
    material: typeof x.material === "string" ? x.material.slice(0, 60) : "",
    thickness: num(x.thickness, 0, 0, 200),
    notes: typeof x.notes === "string" ? x.notes.slice(0, 500) : ""
  };
}

function save() {
  try {
    localStorage.setItem(KEY_LAYERS, JSON.stringify(layers));
    if (activeLayer) localStorage.setItem(KEY_ACTIVE, activeLayer.id);
    localStorage.setItem(KEY_SETTINGS, JSON.stringify(laserSettings));
  } catch { /* egal */ }
}

function changed() {
  save();
  window.dispatchEvent(new CustomEvent(LAYERS_CHANGED));
  window.dispatchEvent(new Event("cnc-redraw"));
}

// ---------------------------------------------------------------------
// Öffentliche Funktionen
// ---------------------------------------------------------------------

export function getLayers(): LaserLayer[] {
  return layers;
}

export function getLayer(id: string | undefined | null): LaserLayer | null {
  if (!id) return null;
  return layers.find(l => l.id === id) || null;
}

/** Ebene einer Form: eigene Ebene, sonst Standard-Ebene */
export function layerForShape(shape: any): LaserLayer | null {
  return getLayer(shape?.laserLayerId) || activeLayer || layers[0] || null;
}

/**
 * Ebene mit eigenen Werten der Form (shape.laserOverride, z. B. Felder des Material-Testrasters).
 * Ohne eigene Werte = layerForShape. Die ID bekommt "~…" angehängt -> jede Wertekombination wird
 * im G-Code ein eigener Block (Ebenen-IDs selbst enthalten nie "~", siehe sanitize).
 */
export function effectiveLayer(shape: any): LaserLayer | null {
  const l = layerForShape(shape);
  const o = shape?.laserOverride;
  if (!l || !o || typeof o !== "object") return l;
  const num = (v: any, d: number, min: number, max: number) => {
    const n = +v;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  const power = num(o.power, l.power, 0, 100);
  const speed = num(o.speed, l.speed, 1, 100000);
  const interval = num(o.interval, l.interval, 0.01, 10);
  return {
    ...l, power, speed, fillPower: power, fillSpeed: speed, interval,
    id: `${l.id}~${power}_${speed}_${interval}`,
    name: layerHasFill(l) ? `${l.name} ${interval} mm` : l.name
  };
}

export function setActiveLayer(id: string) {
  const l = getLayer(id);
  if (!l) return;
  activeLayer = l;
  changed();
}

export function addLayer(data: Partial<LaserLayer>): LaserLayer {
  const used = new Set(layers.map(l => l.color));
  const color = data.color || LAYER_COLORS.find(c => !used.has(c)) || LAYER_COLORS[layers.length % LAYER_COLORS.length];
  const l = sanitize({ ...data, color, id: newLayerId() });
  layers.push(l);
  changed();
  return l;
}

export function updateLayer(id: string, data: Partial<LaserLayer>) {
  const i = layers.findIndex(l => l.id === id);
  if (i < 0) return;
  layers[i] = sanitize({ ...layers[i], ...data, id });
  if (activeLayer && activeLayer.id === id) activeLayer = layers[i];
  changed();
}

export function removeLayer(id: string) {
  if (layers.length <= 1) return;
  layers = layers.filter(l => l.id !== id);
  if (!activeLayer || activeLayer.id === id) activeLayer = layers[0];
  changed();
}

/** Ebene in der Liste nach oben/unten schieben (Reihenfolge = Laser-Reihenfolge) */
export function moveLayer(id: string, dir: -1 | 1) {
  const i = layers.findIndex(l => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= layers.length) return;
  [layers[i], layers[j]] = [layers[j], layers[i]];
  changed();
}

/** Ebene kopieren (gleiche Werte, freie Farbe, Name "… (Kopie)"), steht direkt dahinter */
export function duplicateLayer(id: string): LaserLayer | null {
  const src = getLayer(id);
  if (!src) return null;
  const used = new Set(layers.map(l => l.color));
  const color = LAYER_COLORS.find(c => !used.has(c)) || src.color;
  const copy = sanitize({ ...src, id: newLayerId(), color, name: t("lib.copyName", { name: src.name }) });
  layers.splice(layers.indexOf(src) + 1, 0, copy);
  changed();
  return copy;
}

/** Ganze Bibliothek für die Sicherungsdatei */
export function exportLaserLibrary() {
  return { layers: layers.map(l => ({ ...l })), settings: { ...laserSettings }, active: activeLayer?.id || null };
}

/** Aus einer Sicherung übernehmen (replace: alles ersetzen, sonst fehlende dazu). Anzahl übernommener Ebenen. */
export function importLaserLibrary(data: any, replace: boolean): number {
  const list = sanitizeList(data?.layers);
  if (!list.length) return 0;
  if (!replace) return mergeProjectLayers(list, []);
  const seen = new Set<string>();
  layers = list.map(l => { const id = seen.has(l.id) ? newLayerId() : l.id; seen.add(id); return { ...l, id }; });
  activeLayer = layers.find(l => l.id === data?.active) || layers[0];
  if (data?.settings && typeof data.settings === "object") setLaserSettings({ sMax: data.settings.sMax, dynamic: data.settings.dynamic });
  changed();
  return layers.length;
}

export function setLaserSettings(s: Partial<LaserSettings>) {
  if (s.sMax !== undefined && Number.isFinite(+s.sMax) && +s.sMax > 0) laserSettings.sMax = Math.round(+s.sMax);
  if (s.dynamic !== undefined) laserSettings.dynamic = !!s.dynamic;
  save();
  window.dispatchEvent(new CustomEvent(LAYERS_CHANGED));
}

/** Projekt öffnen: fehlende Ebenen übernehmen (wie bei den Fräswerkzeugen) */
export function mergeProjectLayers(list: any, shapes: any[]): number {
  const incoming = sanitizeList(list);
  let added = 0;
  for (const l of incoming) {
    const same = layers.find(x => x.name === l.name && x.mode === l.mode && x.power === l.power && x.speed === l.speed && x.passes === l.passes);
    let newId = l.id;
    if (same) newId = same.id;
    else {
      if (getLayer(l.id)) newId = newLayerId();
      layers.push({ ...l, id: newId });
      added++;
    }
    if (newId !== l.id) shapes.forEach(s => { if (s.laserLayerId === l.id) s.laserLayerId = newId; });
  }
  if (added) changed();
  return added;
}

export function layersUsedBy(shapes: any[]): LaserLayer[] {
  const ids = new Set<string>();
  shapes.forEach(s => { const l = layerForShape(s); if (l) ids.add(l.id); });
  return layers.filter(l => ids.has(l.id));
}

function newLayerId() {
  let id = "";
  do { id = "L" + Math.random().toString(36).substring(2, 8); } while (getLayer(id));
  return id;
}

export function layerHasFill(l: LaserLayer) {
  return l.mode === "fill" || l.mode === "fill+line";
}
export function layerHasLine(l: LaserLayer) {
  return l.mode === "line" || l.mode === "fill+line";
}

/** Kurzinfo: "Füllen · 50 % · 3000 mm/min" */
export function layerInfo(l: LaserLayer): string {
  if (l.mode === "fill+line" && (l.fillPower !== l.power || l.fillSpeed !== l.speed))
    return t("laser.infoBoth", { mode: t("laser.mode." + l.mode), pf: l.fillPower, ff: l.fillSpeed, p: l.power, f: l.speed })
      + (l.passes > 1 ? ` · ${l.passes}×` : "");
  return t("laser.info", { mode: t("laser.mode." + l.mode), p: l.power, f: l.speed })
    + (l.passes > 1 ? ` · ${l.passes}×` : "");
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

// ---------------------------------------------------------------------
// Dialog: Ebene anlegen / bearbeiten
// ---------------------------------------------------------------------

export function openLayerDialog(layer: LaserLayer | null, onDone?: (l: LaserLayer | null) => void) {
  document.getElementById("tool-dialog-overlay")?.remove();
  const isNew = !layer;
  const used = new Set(layers.map(l => l.color));
  const src: LaserLayer = layer || sanitize({
    id: "", name: "", color: LAYER_COLORS.find(c => !used.has(c)) || LAYER_COLORS[0],
    mode: "line", power: 50, speed: 1000, passes: 1, interval: 0.1, angle: 0
  });

  const ov = document.createElement("div");
  ov.id = "tool-dialog-overlay"; // gleiche ID wie der Werkzeug-Dialog -> Tastenkürzel ruhen
  ov.className = "dlg-overlay";
  const row = (key: string, id: string, value: number, step: string, unit: string, extra = "") => `
      <label class="dlg-row" ${extra}><span>${t(key)}</span>
        <span class="dlg-num"><input id="${id}" type="number" value="${value}" step="${step}"><em>${unit}</em></span></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog">
      <h3>🔦 ${t(isNew ? "laser.newTitle" : "laser.editTitle")}</h3>
      <label class="dlg-row"><span>${t("laser.name")}</span>
        <input id="ll-name" type="text" value="${esc(src.name)}" style="width:180px;"></label>
      <div class="dlg-row"><span>${t("laser.color")}</span>
        <span class="ll-colors">${LAYER_COLORS.map(c => `<button type="button" class="ll-color${c === src.color ? " active" : ""}" data-color="${c}" style="background:${c}"></button>`).join("")}</span></div>
      <label class="dlg-row"><span>${t("laser.modeLabel")}</span>
        <select id="ll-mode" style="width:150px;">
          <option value="line" ${src.mode === "line" ? "selected" : ""}>${t("laser.mode.line")}</option>
          <option value="fill" ${src.mode === "fill" ? "selected" : ""}>${t("laser.mode.fill")}</option>
          <option value="fill+line" ${src.mode === "fill+line" ? "selected" : ""}>${t("laser.mode.fill+line")}</option>
        </select></label>
      ${row("laser.power", "ll-power", src.power, "1", "%")}
      ${row("laser.speed", "ll-speed", src.speed, "100", "mm/min")}
      ${row("laser.passes", "ll-passes", src.passes, "1", "×")}
      ${row("laser.interval", "ll-interval", src.interval, "0.01", "mm", 'data-fill="1"')}
      ${row("laser.angle", "ll-angle", src.angle, "15", "°", 'data-fill="1"')}
      ${row("laser.fillPower", "ll-fill-power", src.fillPower, "1", "%", 'data-both="1"')}
      ${row("laser.fillSpeed", "ll-fill-speed", src.fillSpeed, "100", "mm/min", 'data-both="1"')}
      ${row("laser.leadIn", "ll-leadin", src.leadIn, "0.5", "mm", `data-line="1" data-tip="${esc(t("laser.leadInTip"))}"`)}
      <label class="dlg-row"><span>${t("laser.air")}</span><input id="ll-air" type="checkbox" ${src.air ? "checked" : ""} style="width:auto;"></label>
      <div class="dlg-hint">${t("laser.dlgHint")}</div>
      <div class="dlg-buttons">
        ${!isNew && layers.length > 1 ? `<button id="ll-del" class="btn-secondary dlg-danger">🗑</button>` : ""}
        <button id="ll-cancel" class="btn-secondary" style="flex:1;">${t("dlg.cancel")}</button>
        <button id="ll-ok" class="btn-primary" style="flex:2;">✔ ${t(isNew ? "tool.create" : "tool.save")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const q = (id: string) => ov.querySelector("#" + id) as HTMLInputElement;
  let color = src.color;
  const close = (r: LaserLayer | null) => { ov.remove(); onDone?.(r); };

  const syncFill = () => {
    const fill = q("ll-mode").value !== "line", line = q("ll-mode").value !== "fill";
    ov.querySelectorAll<HTMLElement>("[data-fill]").forEach(el => { el.style.display = fill ? "" : "none"; });
    ov.querySelectorAll<HTMLElement>("[data-line]").forEach(el => { el.style.display = line ? "" : "none"; });
    ov.querySelectorAll<HTMLElement>("[data-both]").forEach(el => { el.style.display = fill && line ? "" : "none"; });
  };
  q("ll-mode").addEventListener("change", syncFill);
  syncFill();

  ov.querySelectorAll<HTMLButtonElement>(".ll-color").forEach(b => b.addEventListener("click", () => {
    color = b.dataset.color!;
    ov.querySelectorAll(".ll-color").forEach(x => x.classList.toggle("active", x === b));
  }));

  ov.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape") close(null);
    if (e.key === "Enter") q("ll-ok").click();
  });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(null); });
  q("ll-cancel").onclick = () => close(null);
  const del = ov.querySelector("#ll-del") as HTMLElement | null;
  if (del && layer) del.onclick = () => {
    if (!window.confirm(t("laser.confirmDelete", { name: layer.name }))) return;
    removeLayer(layer.id);
    close(null);
  };
  q("ll-ok").onclick = () => {
    const name = q("ll-name").value.trim();
    if (!name) { q("ll-name").focus(); q("ll-name").classList.add("dlg-invalid"); return; }
    const data: Partial<LaserLayer> = {
      name, color,
      mode: q("ll-mode").value as LaserMode,
      power: parseFloat(q("ll-power").value),
      speed: parseFloat(q("ll-speed").value),
      passes: parseFloat(q("ll-passes").value),
      interval: parseFloat(q("ll-interval").value),
      angle: parseFloat(q("ll-angle").value),
      leadIn: parseFloat(q("ll-leadin").value) || 0,
      fillPower: parseFloat(q("ll-fill-power").value),
      fillSpeed: parseFloat(q("ll-fill-speed").value),
      air: (q("ll-air") as HTMLInputElement).checked
    };
    if (layer) { updateLayer(layer.id, data); close(getLayer(layer.id)); }
    else close(addLayer(data));
  };
  setTimeout(() => { const n = q("ll-name"); n.focus(); n.select(); }, 0);
}
