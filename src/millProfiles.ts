/**
 * FRÄS-PROFILE (Material + Schnittwerte) und Schnittwerte je Form
 *
 * Profil: gespeicherte Werte (Name, Vorschub, Drehzahl, Zustellung, optional Eintauch-Vorschub, Werkzeug und Ø).
 * Liste unter cnc_craft_mill_profiles – settingsStore.ts spiegelt sie in die Datei im App-Datenordner;
 * in Sicherungsdateien steht sie im Teil „tools“ (libraryBackup.ts).
 *
 * Anwenden (ui/millProfilePicker.ts): Die Form bekommt eine KOPIE der Werte (shape.cutData). Das Werkzeug bleibt
 * unverändert, andere Formen mit demselben Werkzeug merken also nichts. Fehlt cutData, gilt alles wie bisher.
 * cutData gilt nur für das Werkzeug (Kennung + Ø), für das es angewendet wurde: Wird das Werkzeug der Form getauscht
 * oder sein Ø geändert, nimmt cam.ts wieder die Werkzeug-Werte und warnt. Falsche Werte können einen Fräser zerstören,
 * deshalb hier lieber ablehnen als raten; beim G-Code werden die Maschinen-Grenzen erneut angewendet (auch für
 * Werte aus fremden Projektdateien).
 *
 * Reine Logik ohne Oberfläche – Tests: tests/millProfiles.test.ts
 */

export const MILL_PROFILES_CHANGED = "cnc-mill-profiles-changed";
const KEY = "cnc_craft_mill_profiles";
const MAX_PROFILES = 200;

export interface MillProfile {
  id: string;
  name: string;
  feedrate: number;     // Vorschub mm/min
  rpm: number;          // Drehzahl
  stepZ: number;        // Zustellung je Durchgang in mm
  plungeFeed?: number;  // Eintauch-Vorschub mm/min (fehlt = aus dem Vorschub abgeleitet)
  toolId?: string;      // Werkzeug, für das die Werte gedacht sind
  diameter?: number;    // Ø, für den die Werte gedacht sind (Warnung bei anderem Fräser)
}

export interface CutValues { feedrate: number; rpm: number; stepZ: number; plungeFeed?: number }

/** Grenzen der Maschine (Werkzeug-Einstellungen) – 0 oder fehlend wie in calcCutData */
export interface CutLimits { minRpm: number; maxRpm: number; maxFeed: number }

/** Was vom Werkzeug für die Begrenzung gebraucht wird */
export interface CutTool {
  id: string; type: string; diameter: number; fluteLen: number; plungeFeed?: number;
  feedrate: number; rpm: number; stepZ: number;
}

/** Schnittwerte an einer Form */
export interface CutData extends CutValues {
  toolId: string;  // gilt nur für dieses Werkzeug …
  d: number;       // … mit diesem Ø
  label: string;   // Name des Profils / Materials
  src: string;     // Herkunft für die Auswahlliste: "p:<Profil>" oder "m:<Material>"
}

/** Zahl > 0 in Grenzen, sonst null (nie raten: fehlende Werte machen den Eintrag ungültig) */
function pos(v: unknown, max: number): number | null {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, n) : null;
}

function cleanId(v: unknown): string {
  return String(v ?? "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
}

/** Profil aus Speicher/Datei prüfen: nur bekannte Felder; Pflichtwert kaputt = null */
export function sanitizeProfile(x: any): MillProfile | null {
  if (!x || typeof x !== "object") return null;
  const feedrate = pos(x.feedrate, 100000), rpm = pos(x.rpm, 100000), stepZ = pos(x.stepZ, 100);
  if (feedrate === null || rpm === null || stepZ === null) return null;
  const id = cleanId(x.id);
  if (!id) return null;
  const plungeFeed = pos(x.plungeFeed, 100000), diameter = pos(x.diameter, 1000);
  const toolId = typeof x.toolId === "string" ? cleanId(x.toolId) : "";
  const name = String(x.name ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 60) || "?";
  return {
    id, name, feedrate, rpm, stepZ,
    ...(plungeFeed !== null ? { plungeFeed } : {}),
    ...(toolId ? { toolId } : {}),
    ...(diameter !== null ? { diameter } : {})
  };
}

export function sanitizeProfiles(list: unknown): MillProfile[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>(), out: MillProfile[] = [];
  for (const x of list.slice(0, MAX_PROFILES * 2)) {
    const p = sanitizeProfile(x);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
    if (out.length >= MAX_PROFILES) break;
  }
  return out;
}

/**
 * Werte an Maschine und Werkzeug anpassen: Drehzahl und Vorschub in die Grenzen der Maschine, Zustellung höchstens die
 * Schneidenlänge (außer Kegel-Werkzeuge). Ohne eigenen Eintauch-Vorschub: wie im Schnittdaten-Rechner 30 % vom Vorschub
 * (Bohrer 50 %), aber nie schneller als das, was am Werkzeug steht.
 */
export function clampCut(v: CutValues, tool: CutTool, st: CutLimits): CutValues & { plungeFeed: number; limited: boolean } {
  const maxRpm = st.maxRpm > 0 ? st.maxRpm : 24000, maxFeed = st.maxFeed > 0 ? st.maxFeed : 3000;
  let limited = false;
  let rpm = v.rpm;
  if (rpm > maxRpm) { rpm = maxRpm; limited = true; }
  if (st.minRpm > 0 && rpm < st.minRpm) { rpm = st.minRpm; limited = true; }
  let feedrate = v.feedrate;
  if (feedrate > maxFeed) { feedrate = maxFeed; limited = true; }
  let stepZ = Math.max(0.05, v.stepZ);
  const conical = tool.type === "vbit" || tool.type === "chamfer" || tool.type === "countersink";
  if (tool.fluteLen > 0 && !conical && stepZ > tool.fluteLen) { stepZ = tool.fluteLen; limited = true; }
  let plungeFeed: number;
  if (v.plungeFeed && v.plungeFeed > 0) {
    plungeFeed = v.plungeFeed;
    if (plungeFeed > maxFeed) { plungeFeed = maxFeed; limited = true; }
  } else {
    const share = Math.max(10, Math.round((feedrate * (tool.type === "drill" ? 0.5 : 0.3)) / 10) * 10);
    plungeFeed = tool.plungeFeed && tool.plungeFeed > 0 ? Math.min(tool.plungeFeed, share) : share;
  }
  return { feedrate, rpm, stepZ, plungeFeed, limited };
}

/** Schnittwerte für die Form bauen (Werte schon begrenzt) */
export function makeCutData(tool: CutTool, v: CutValues, label: string, src: string, st: CutLimits): CutData & { limited: boolean } {
  const r = clampCut(v, tool, st);
  return { toolId: tool.id, d: tool.diameter, label: String(label).slice(0, 60), src: String(src).slice(0, 80),
    feedrate: r.feedrate, rpm: r.rpm, stepZ: r.stepZ, plungeFeed: r.plungeFeed, limited: r.limited };
}

/** cutData von der Form prüfen (kann aus einer Projektdatei kommen); null = keine brauchbaren Werte */
export function cleanCutData(x: any): CutData | null {
  if (!x || typeof x !== "object" || typeof x.toolId !== "string") return null;
  const feedrate = pos(x.feedrate, 100000), rpm = pos(x.rpm, 100000), stepZ = pos(x.stepZ, 100), d = pos(x.d, 1000);
  if (feedrate === null || rpm === null || stepZ === null || d === null) return null;
  const plungeFeed = pos(x.plungeFeed, 100000);
  return {
    toolId: x.toolId, d, feedrate, rpm, stepZ, ...(plungeFeed !== null ? { plungeFeed } : {}),
    label: String(x.label ?? "?").slice(0, 60), src: String(x.src ?? "").slice(0, 80)
  };
}

/** Gilt das cutData für dieses Werkzeug? (gleiche Kennung und gleicher Ø) */
export function cutDataFits(cd: CutData, tool: Pick<CutTool, "id" | "diameter"> | null): boolean {
  return !!tool && cd.toolId === tool.id && Math.abs(cd.d - tool.diameter) < 1e-3;
}

export type ResolvedCut = { feedrate: number; rpm: number; stepZ: number; plungeFeed: number; label: string };

/**
 * Für den G-Code: die Werte, mit denen diese Form gefräst wird, oder null = Werkzeug-Werte (kein cutData, kaputt oder
 * für ein anderes Werkzeug). Grenzen werden hier noch einmal angewendet: sie können sich seit dem Anwenden geändert
 * haben, und Projektdateien können alles enthalten.
 */
export function resolveCut(raw: unknown, tool: CutTool | null, st: CutLimits): ResolvedCut | null {
  const cd = cleanCutData(raw);
  if (!cd || !tool || !cutDataFits(cd, tool)) return null;
  const r = clampCut(cd, tool, st);
  return { feedrate: r.feedrate, rpm: r.rpm, stepZ: r.stepZ, plungeFeed: r.plungeFeed, label: cd.label };
}

/** Passt das Profil zum Fräser? false = Profil für einen anderen Ø (ohne Ø-Angabe im Profil: keine Warnung) */
export function profileFitsDiameter(p: Pick<MillProfile, "diameter">, diameter: number): boolean {
  return !p.diameter || Math.abs(p.diameter - diameter) < 1e-3;
}

// ---------------------------------------------------------------------
// Speicher
// ---------------------------------------------------------------------

let cache: MillProfile[] | null = null;

export function getMillProfiles(): MillProfile[] {
  if (cache) return cache;
  let list: unknown = [];
  try { list = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { /* leer lassen */ }
  cache = sanitizeProfiles(list);
  return cache;
}

function changed() {
  try { localStorage.setItem(KEY, JSON.stringify(getMillProfiles())); } catch { /* Speicher voll – bleibt bis zum Neustart */ }
  try { window.dispatchEvent(new CustomEvent(MILL_PROFILES_CHANGED)); } catch { /* ohne Fenster (Tests) */ }
}

function newId(): string {
  let id = "";
  do { id = "mp" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); } while (getMillProfiles().some(p => p.id === id));
  return id;
}

/** Neues Profil; null = Werte ungültig */
export function addMillProfile(values: Omit<MillProfile, "id">): MillProfile | null {
  const p = sanitizeProfile({ ...values, id: newId() });
  if (!p || getMillProfiles().length >= MAX_PROFILES) return null;
  getMillProfiles().push(p);
  changed();
  return p;
}

/**
 * Profil ändern. Ungültige Pflichtwerte werden nicht übernommen (false). Optionale Felder löschen: Wert undefined übergeben.
 * Formen behalten ihre Kopie der Werte – Änderungen gelten erst nach erneutem Anwenden.
 */
export function updateMillProfile(id: string, patch: Partial<Omit<MillProfile, "id">>): boolean {
  const list = getMillProfiles(), i = list.findIndex(p => p.id === id);
  if (i < 0) return false;
  const p = sanitizeProfile({ ...list[i], ...patch, id });
  if (!p) return false;
  list[i] = p;
  changed();
  return true;
}

export function removeMillProfile(id: string) {
  const list = getMillProfiles(), i = list.findIndex(p => p.id === id);
  if (i >= 0) { list.splice(i, 1); changed(); }
}

/** Für die Sicherungsdatei */
export function exportMillProfiles(): MillProfile[] {
  return getMillProfiles().map(p => ({ ...p }));
}

function sameValues(a: MillProfile, b: MillProfile) {
  return a.name === b.name && a.feedrate === b.feedrate && a.rpm === b.rpm && a.stepZ === b.stepZ
    && (a.plungeFeed || 0) === (b.plungeFeed || 0) && (a.diameter || 0) === (b.diameter || 0);
}

/**
 * Aus einer Sicherung übernehmen (alles wird geprüft). replace: Liste ersetzen – aber nur, wenn die Datei überhaupt eine
 * Profil-Liste hat (ältere Sicherungen kennen keine und dürfen nichts löschen). Sonst: fehlende kommen dazu.
 * Rückgabe: Anzahl übernommener Profile.
 */
export function importMillProfiles(data: unknown, replace: boolean): number {
  if (!Array.isArray(data)) return 0;
  const incoming = sanitizeProfiles(data);
  const list = getMillProfiles();
  if (replace) {
    list.splice(0, list.length, ...incoming);
    changed();
    return incoming.length;
  }
  let added = 0;
  for (const p of incoming) {
    if (list.some(x => sameValues(x, p)) || list.length >= MAX_PROFILES) continue;
    list.push(list.some(x => x.id === p.id) ? { ...p, id: newId() } : p);
    added++;
  }
  if (added) changed();
  return added;
}
