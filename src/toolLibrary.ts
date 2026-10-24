/**
 * WERKZEUG-BIBLIOTHEK (nur Fräsen – Laser und Plasma haben eigene Ebenen/Schnitte)
 *
 * Alle Fräser/Werkzeuge werden lokal gespeichert (localStorage). Jede Form kann ein eigenes
 * Werkzeug bekommen (shape.toolId) – wie in Estlcam. Formen ohne eigenes Werkzeug nutzen das
 * "Standard-Werkzeug" (activeTool).
 *
 * Ein Werkzeug hat wie in Estlcam eine Art (Schaftfräser, Kugelfräser, Torusfräser,
 * V-Stichel, Fasenfräser, Senker, Bohrer, Planfräser), Schneidenzahl, Spiral-Richtung,
 * Maße (Ø, Schaft, Schneidenlänge, Gesamtlänge, Winkel, Spitze, Eckenradius) und
 * Schnittdaten. Der Schnittdaten-Rechner schlägt Drehzahl, Vorschub und Zustellung vor
 * (Material + Werkzeug + Grenzen der Maschine aus den Werkzeug-Einstellungen).
 * Bedienung (Seite "Werkzeuge" und Dialog): ui/toolEditor.ts, Zeichnung: toolGraphics.ts
 *
 * Bei jeder Änderung wird das Ereignis "cnc-tools-changed" ausgelöst. Darauf hören:
 *   - die Seite "Werkzeuge"
 *   - die Werkzeug-Auswahl im CAM-Bereich (rechte Seite)
 */
import { t } from "./i18n/i18n";
import { ToolType, Helix, ToolGeom } from "./toolGraphics";

export type { ToolType, Helix } from "./toolGraphics";
export type ToolMat = "carbide" | "hss";

export interface MillingTool extends ToolGeom {
  id: string;
  name: string;
  stepZ: number;       // Zustellung pro Durchgang in mm
  feedrate: number;    // Vorschub in mm/min
  rpm: number;         // Drehzahl
  plungeFeed?: number; // Eintauch-Vorschub in mm/min (Standard 300)
  rampAngle?: number;  // Eintauchwinkel in ° (Rampe/Schraube), 0 = senkrecht eintauchen
  toolMat: ToolMat;    // Schneidstoff: Hartmetall oder HSS
  notes: string;       // Notiz (Bezugsquelle, Material, …)
}

export const TOOL_TYPES: ToolType[] = ["endmill", "ball", "bullnose", "vbit", "chamfer", "countersink", "drill", "facemill"];
/** Arten mit Kegel-Spitze (Winkel zählt) */
export const CONE_TYPES: ToolType[] = ["vbit", "chamfer", "countersink", "drill"];

/** Typische Maße je Art – für neue Werkzeuge und die Bilder auf den Art-Knöpfen */
export const TYPE_DEFAULTS: Record<ToolType, Omit<ToolGeom, "type">> = {
  endmill:     { diameter: 3,  shankDia: 3.175, fluteLen: 12, length: 38, flutes: 2, helix: "up",       angle: 0,   tipDia: 0,   cornerR: 0 },
  ball:        { diameter: 3,  shankDia: 3.175, fluteLen: 12, length: 38, flutes: 2, helix: "up",       angle: 0,   tipDia: 0,   cornerR: 0 },
  bullnose:    { diameter: 6,  shankDia: 6,     fluteLen: 15, length: 50, flutes: 4, helix: "up",       angle: 0,   tipDia: 0,   cornerR: 1 },
  vbit:        { diameter: 6,  shankDia: 6,     fluteLen: 0,  length: 40, flutes: 2, helix: "straight", angle: 60,  tipDia: 0.2, cornerR: 0 },
  chamfer:     { diameter: 12, shankDia: 6,     fluteLen: 0,  length: 50, flutes: 2, helix: "straight", angle: 90,  tipDia: 1,   cornerR: 0 },
  countersink: { diameter: 12, shankDia: 6,     fluteLen: 0,  length: 45, flutes: 3, helix: "straight", angle: 90,  tipDia: 0,   cornerR: 0 },
  drill:       { diameter: 3,  shankDia: 3,     fluteLen: 20, length: 61, flutes: 2, helix: "up",       angle: 118, tipDia: 0,   cornerR: 0 },
  facemill:    { diameter: 25, shankDia: 8,     fluteLen: 3,  length: 45, flutes: 2, helix: "straight", angle: 0,   tipDia: 0,   cornerR: 0 }
};

export function typeGeom(type: ToolType): ToolGeom {
  return { type, ...TYPE_DEFAULTS[type] };
}

// ---------------------------------------------------------------------
// Werkzeug-Einstellungen + Schnittdaten-Rechner
// ---------------------------------------------------------------------

export interface ToolSettings {
  minRpm: number;    // kleinste Drehzahl der Spindel (0 = egal)
  maxRpm: number;    // größte Drehzahl der Spindel
  maxFeed: number;   // größter sinnvoller Vorschub der Maschine (mm/min)
  material: string;  // Material, das der Rechner vorschlägt
}
const KEY_SETTINGS = "cnc_craft_tool_settings";
export const toolSettings: ToolSettings = { minRpm: 0, maxRpm: 24000, maxFeed: 3000, material: "softwood" };

/**
 * Material-Tabelle für den Rechner (Hartmetall-Fräser, Hobby-/Portalfräsen):
 *   vc   Schnittgeschwindigkeit m/min
 *   fzK  Zahnvorschub = fzK × Ø (mm/Zahn), begrenzt auf fzMax
 *   ap   Zustellung = ap × Ø
 * Bewusst vorsichtig – lieber erst langsam und an einem Reststück testen.
 */
export const MATERIALS: { id: string; vc: number; fzK: number; fzMax: number; ap: number }[] = [
  { id: "softwood", vc: 600, fzK: 0.025, fzMax: 0.25, ap: 1.0 },
  { id: "hardwood", vc: 500, fzK: 0.018, fzMax: 0.2, ap: 0.5 },
  { id: "mdf", vc: 600, fzK: 0.022, fzMax: 0.22, ap: 0.75 },
  { id: "plywood", vc: 500, fzK: 0.02, fzMax: 0.2, ap: 0.6 },
  { id: "acrylic", vc: 300, fzK: 0.015, fzMax: 0.15, ap: 0.5 },
  { id: "softplastic", vc: 400, fzK: 0.02, fzMax: 0.2, ap: 0.75 },
  { id: "pcb", vc: 200, fzK: 0.008, fzMax: 0.05, ap: 0.3 },
  { id: "alu", vc: 250, fzK: 0.006, fzMax: 0.06, ap: 0.2 },
  { id: "brass", vc: 150, fzK: 0.005, fzMax: 0.05, ap: 0.15 },
  { id: "steel", vc: 80, fzK: 0.003, fzMax: 0.04, ap: 0.1 }
];

export interface CutData { rpm: number; feedrate: number; plungeFeed: number; stepZ: number; fz: number; limited: boolean }

/** Schnittdaten-Vorschlag für ein Werkzeug in einem Material */
export function calcCutData(tool: ToolGeom & { toolMat?: ToolMat }, materialId: string, st: ToolSettings = toolSettings): CutData {
  const m = MATERIALS.find(x => x.id === materialId) || MATERIALS[0];
  const hss = tool.toolMat === "hss";
  const conical = tool.type === "vbit" || tool.type === "chamfer" || tool.type === "countersink";
  // V-Stichel & Co. schneiden im Mittel mit ungefähr dem halben Durchmesser
  const dEff = Math.max(0.2, conical ? Math.max(tool.tipDia, tool.diameter * 0.5) : tool.diameter);
  const vc = m.vc * (hss ? 0.35 : 1);
  let rpm = vc * 1000 / (Math.PI * dEff);
  const maxRpm = st.maxRpm > 0 ? st.maxRpm : 24000;
  let limited = false;
  if (rpm > maxRpm) { rpm = maxRpm; limited = true; }
  if (st.minRpm > 0 && rpm < st.minRpm) { rpm = st.minRpm; limited = true; }
  const fz = Math.min(m.fzMax, Math.max(0.005, m.fzK * dEff)) * (hss ? 0.8 : 1);
  const z = Math.max(1, Math.round(tool.flutes || 1));
  let feed = rpm * z * fz;
  const maxFeed = st.maxFeed > 0 ? st.maxFeed : 3000;
  if (feed > maxFeed) { feed = maxFeed; limited = true; }
  let stepZ = m.ap * dEff * (conical ? 0.5 : 1);
  if (tool.type === "drill") stepZ = Math.max(0.5, dEff * (m.ap >= 0.5 ? 1 : 0.5)); // Spanbrech-Tiefe
  if (tool.fluteLen > 0 && !conical) stepZ = Math.min(stepZ, tool.fluteLen);
  stepZ = Math.max(0.05, stepZ);
  const plunge = tool.type === "drill" ? feed * 0.5 : feed * 0.3;
  const r = (v: number, s: number) => Math.round(v / s) * s;
  return {
    rpm: r(rpm, 100), feedrate: Math.max(10, r(feed, 10)), plungeFeed: Math.max(20, r(plunge, 10)),
    stepZ: Math.round(stepZ * 20) / 20 || 0.05, fz: Math.round(fz * 10000) / 10000, limited
  };
}

export function setToolSettings(s: Partial<ToolSettings>) {
  const num = (v: any, d: number, min: number, max: number) => (Number.isFinite(+v) ? Math.min(max, Math.max(min, +v)) : d);
  if (s.minRpm !== undefined) toolSettings.minRpm = num(s.minRpm, toolSettings.minRpm, 0, 100000);
  if (s.maxRpm !== undefined) toolSettings.maxRpm = num(s.maxRpm, toolSettings.maxRpm, 100, 100000);
  if (s.maxFeed !== undefined) toolSettings.maxFeed = num(s.maxFeed, toolSettings.maxFeed, 10, 100000);
  if (s.material !== undefined && MATERIALS.some(m => m.id === s.material)) toolSettings.material = s.material;
  try { localStorage.setItem(KEY_SETTINGS, JSON.stringify(toolSettings)); } catch { /* egal */ }
  window.dispatchEvent(new CustomEvent(TOOLS_CHANGED));
}

export const TOOLS_CHANGED = "cnc-tools-changed";
const KEY_TOOLS = "cnc_craft_tool_library";
const KEY_ACTIVE = "cnc_craft_active_tool_id";
export const DEFAULT_PLUNGE = 300;
/** Eintauchwinkel für neue Werkzeuge (°) – schont kleine Fräser; bestehende Werkzeuge ohne Angabe tauchen senkrecht ein */
export const DEFAULT_RAMP = 3;

export let activeTool: MillingTool | null = null;
let tools: MillingTool[] = [];

// ---------------------------------------------------------------------
// Laden / Speichern
// ---------------------------------------------------------------------

export function initToolLibrary() {
  try {
    const raw = localStorage.getItem(KEY_SETTINGS);
    if (raw) Object.assign(toolSettings, JSON.parse(raw));
  } catch { /* Standardwerte */ }
  try {
    const saved = localStorage.getItem(KEY_TOOLS);
    if (saved) tools = sanitizeList(JSON.parse(saved));
  } catch { tools = []; }

  if (tools.length === 0) {
    tools = [
      sanitize({ id: "t1", name: t("lib.default1"), type: "endmill", diameter: 3.0, shankDia: 3.175, flutes: 1, stepZ: 1.5, feedrate: 1200, rpm: 18000, plungeFeed: 300, rampAngle: DEFAULT_RAMP }),
      sanitize({ id: "t2", name: t("lib.default2"), type: "endmill", diameter: 6.0, shankDia: 6, flutes: 2, fluteLen: 22, length: 50, stepZ: 2.0, feedrate: 1500, rpm: 12000, plungeFeed: 400, rampAngle: DEFAULT_RAMP })
    ];
    saveToStorage();
  }

  let savedActiveId: string | null = null;
  try { savedActiveId = localStorage.getItem(KEY_ACTIVE); } catch { /* egal */ }
  activeTool = tools.find(x => x.id === savedActiveId) || tools[0];
}

function sanitizeList(list: any): MillingTool[] {
  if (!Array.isArray(list)) return [];
  return list.filter(x => x && typeof x.id === "string").map(sanitize);
}

export function sanitize(x: any): MillingTool {
  const num = (v: any, d: number) => (Number.isFinite(+v) && +v > 0 ? +v : d);
  const num0 = (v: any, d: number) => (Number.isFinite(+v) && +v >= 0 ? +v : d);
  // ältere Bibliotheken kennen nur Ø/Zustellung/Vorschub/Drehzahl -> Schaftfräser
  const type: ToolType = TOOL_TYPES.includes(x.type) ? x.type : "endmill";
  const d = TYPE_DEFAULTS[type];
  const diameter = num(x.diameter, d.diameter);
  const helix: Helix = (["up", "down", "compression", "straight"] as Helix[]).includes(x.helix) ? x.helix : d.helix;
  return {
    // aus importierten Dateien: nur harmlose Zeichen (die ID landet in HTML-Attributen)
    id: String(x.id).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "x" + Date.now().toString(36),
    name: String(x.name || "?").slice(0, 120),
    type,
    diameter,
    shankDia: num(x.shankDia, x.type ? d.shankDia : diameter),
    fluteLen: num0(x.fluteLen, d.fluteLen),
    length: num(x.length, d.length),
    flutes: Math.max(1, Math.min(12, Math.round(num(x.flutes, d.flutes)))),
    helix,
    angle: Math.max(0, Math.min(179, num0(x.angle, d.angle))),
    tipDia: Math.min(num0(x.tipDia, d.tipDia), diameter),
    cornerR: Math.min(num0(x.cornerR, d.cornerR), diameter / 2),
    stepZ: Math.abs(num(x.stepZ, 1.5)),
    feedrate: num(x.feedrate, 1000),
    rpm: Number.isFinite(+x.rpm) && +x.rpm >= 0 ? +x.rpm : 12000,
    plungeFeed: num(x.plungeFeed, DEFAULT_PLUNGE),
    rampAngle: Math.min(45, num0(x.rampAngle, 0)),
    toolMat: x.toolMat === "hss" ? "hss" : "carbide",
    notes: typeof x.notes === "string" ? x.notes.slice(0, 500) : ""
  };
}

function saveToStorage() {
  try {
    localStorage.setItem(KEY_TOOLS, JSON.stringify(tools));
    if (activeTool) localStorage.setItem(KEY_ACTIVE, activeTool.id);
  } catch { /* Speicher voll/gesperrt – Werkzeuge gelten trotzdem bis zum Neustart */ }
}

function changed() {
  saveToStorage();
  window.dispatchEvent(new CustomEvent(TOOLS_CHANGED));
}

// ---------------------------------------------------------------------
// Öffentliche Funktionen (für CAM-Bereich, G-Code, Projekte)
// ---------------------------------------------------------------------

export function getTools(): MillingTool[] {
  return tools;
}

export function getTool(id: string | undefined | null): MillingTool | null {
  if (!id) return null;
  return tools.find(x => x.id === id) || null;
}

/** Werkzeug für eine Form: eigenes Werkzeug, sonst das Standard-Werkzeug */
export function toolForShape(shape: any): MillingTool | null {
  return getTool(shape?.toolId) || activeTool || tools[0] || null;
}

export function setActiveTool(id: string) {
  const tool = getTool(id);
  if (!tool) return;
  activeTool = tool;
  changed();
}

export function addTool(data: Partial<MillingTool>): MillingTool {
  const tool = sanitize({ ...data, id: newToolId() });
  tools.push(tool);
  changed();
  return tool;
}

export function updateTool(id: string, data: Partial<MillingTool>) {
  const i = tools.findIndex(x => x.id === id);
  if (i < 0) return;
  tools[i] = sanitize({ ...tools[i], ...data, id });
  if (activeTool && activeTool.id === id) activeTool = tools[i];
  changed();
}

export function removeTool(id: string) {
  if (tools.length <= 1) return; // mindestens ein Werkzeug muss bleiben
  tools = tools.filter(x => x.id !== id);
  if (!activeTool || activeTool.id === id) activeTool = tools[0];
  changed();
}

/**
 * Projekt öffnen: Werkzeuge aus der Projektdatei, die hier noch fehlen, in die Bibliothek
 * übernehmen (gleiche ID mit anderen Werten -> neue ID, die Formen werden umgehängt).
 * Gibt die Anzahl neu übernommener Werkzeuge zurück.
 */
export function mergeProjectTools(list: any, shapes: any[]): number {
  const incoming = sanitizeList(list);
  let added = 0;
  for (const tool of incoming) {
    const same = tools.find(x => sameTool(x, tool));
    let newId = tool.id;
    if (same) newId = same.id;
    else {
      if (getTool(tool.id)) newId = newToolId();
      tools.push({ ...tool, id: newId });
      added++;
    }
    if (newId !== tool.id) shapes.forEach(s => { if (s.toolId === tool.id) s.toolId = newId; });
  }
  if (added) changed();
  return added;
}

/** Werkzeuge, die von den Formen benutzt werden (für die Projektdatei) */
export function toolsUsedBy(shapes: any[]): MillingTool[] {
  const ids = new Set<string>();
  shapes.forEach(s => { const tl = toolForShape(s); if (tl) ids.add(tl.id); });
  return tools.filter(x => ids.has(x.id));
}

function sameTool(a: MillingTool, b: MillingTool) {
  return a.name === b.name && a.type === b.type && a.flutes === b.flutes && Math.abs(a.diameter - b.diameter) < 1e-6
    && Math.abs(a.stepZ - b.stepZ) < 1e-6 && a.feedrate === b.feedrate && a.rpm === b.rpm;
}

/** Werkzeug kopieren (gleiche Werte, neuer Name "… (Kopie)") */
export function duplicateTool(id: string): MillingTool | null {
  const src = getTool(id);
  if (!src) return null;
  const copy = sanitize({ ...src, id: newToolId(), name: t("lib.copyName", { name: src.name }) });
  tools.splice(tools.indexOf(src) + 1, 0, copy);
  changed();
  return copy;
}

/** Werkzeug in der Liste verschieben (ändert die Nummer T1, T2 …) */
export function moveTool(id: string, dir: -1 | 1) {
  const i = tools.findIndex(x => x.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= tools.length) return;
  [tools[i], tools[j]] = [tools[j], tools[i]];
  changed();
}

function newToolId() {
  let id = "";
  do { id = "t" + Math.random().toString(36).substring(2, 9); } while (getTool(id));
  return id;
}

/** Nummer des Werkzeugs (Platz in der Bibliothek, ab 1) – wie die Marke "T2" auf der Zeichenfläche */
export function toolNumber(tool: MillingTool): number {
  const i = tools.findIndex(x => x.id === tool.id);
  return i < 0 ? 0 : i + 1;
}

/**
 * Farbe des Werkzeugs (nach Nummer). Bewusst andere Farben als die Fräs-Modi
 * (Blau/Gelb/Cyan/Rot) und die Auswahl (Grün), damit nichts verwechselt wird.
 */
const TOOL_COLORS = ["#ff9f43", "#c084fc", "#f472b6", "#a3e635", "#e2b882", "#94a3b8", "#818cf8", "#fda4af"];
export function toolColor(tool: MillingTool): string {
  const n = toolNumber(tool);
  return TOOL_COLORS[(Math.max(1, n) - 1) % TOOL_COLORS.length];
}

/** Kurzer Text für Auswahllisten: "T1 · Ø3 · 3 mm Schaftfräser" */
export function toolLabel(tool: MillingTool): string {
  return `T${toolNumber(tool)} · Ø${fmt(tool.diameter)} · ${tool.name}`;
}

/** Kurzinfo: "Schaftfräser · 2 Schneiden · Ø 3 mm · 1.5 mm/Durchgang · F1200 · S18000" */
export function toolInfo(tool: MillingTool): string {
  return `${toolTypeName(tool)} · ${t("tl.flutesN", { n: tool.flutes })}${CONE_TYPES.includes(tool.type) ? ` · ${fmt(tool.angle)}°` : ""} · `
    + t("tool.info", { d: fmt(tool.diameter), z: fmt(tool.stepZ), f: tool.feedrate, s: tool.rpm });
}

export function toolTypeName(tool: { type: ToolType }): string {
  return t("tl.type." + tool.type);
}

export function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}

// ---------------------------------------------------------------------
// Sicherung (Export / Import, siehe libraryBackup.ts)
// ---------------------------------------------------------------------

/** Ganze Bibliothek für die Sicherungsdatei */
export function exportToolLibrary() {
  return { tools: tools.map(x => ({ ...x })), settings: { ...toolSettings }, active: activeTool?.id || null };
}

/**
 * Bibliothek aus einer Sicherung übernehmen.
 *   replace = true:  Liste, Einstellungen und Standard-Werkzeug werden ersetzt
 *   replace = false: fehlende Werkzeuge kommen dazu (gleiche werden übersprungen)
 * Gibt die Anzahl übernommener Werkzeuge zurück.
 */
export function importToolLibrary(data: any, replace: boolean): number {
  const list = sanitizeList(data?.tools);
  if (!list.length) return 0;
  if (!replace) return mergeProjectTools(list, []);
  // doppelte IDs in der Datei abfangen
  const seen = new Set<string>();
  tools = list.map(x => { const id = seen.has(x.id) ? newToolId() : x.id; seen.add(id); return { ...x, id }; });
  activeTool = tools.find(x => x.id === data?.active) || tools[0];
  if (data?.settings && typeof data.settings === "object") {
    const s = data.settings;
    setToolSettings({ minRpm: s.minRpm, maxRpm: s.maxRpm, maxFeed: s.maxFeed, material: s.material });
  }
  changed();
  return tools.length;
}

// Bearbeiten-Dialog, Seite "Werkzeuge" und Schnittdaten-Rechner-Bedienung: ui/toolEditor.ts
