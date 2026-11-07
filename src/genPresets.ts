/**
 * VORLAGEN FÜR GENERATOREN: häufige Maße unter einem Namen speichern. Nur Logik, ohne Oberfläche.
 * Bewusst eine Liste statt eines Objekts: Namen tippt der Nutzer ein, "__proto__" wäre als Schlüssel gefährlich.
 */
export type PresetValue = string | boolean;
export interface GenPreset { name: string; values: Record<string, PresetValue> }

export const MAX_PRESETS = 30;
export const MAX_NAME = 40;

export const cleanName = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);

/** Gleicher Name ersetzt die alte Vorlage (Groß/klein egal). Liste wird nach Namen sortiert */
export function addPreset(list: GenPreset[], name: string, values: Record<string, PresetValue>): GenPreset[] {
  const n = cleanName(name);
  if (!n) return list;
  const rest = list.filter(p => p.name.toLowerCase() !== n.toLowerCase());
  if (rest.length >= MAX_PRESETS) return list;
  return [...rest, { name: n, values }].sort((a, b) => a.name.localeCompare(b.name));
}

export const removePreset = (list: GenPreset[], name: string) => list.filter(p => p.name !== name);

/** Eingelesene Liste prüfen: Einstellungen können von Hand geändert worden sein */
export function sanitizePresets(raw: unknown): GenPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: GenPreset[] = [];
  for (const p of raw) {
    if (!p || typeof p.name !== "string" || !p.values || typeof p.values !== "object") continue;
    const values: Record<string, PresetValue> = Object.create(null);
    for (const [k, v] of Object.entries(p.values)) if (typeof v === "string" || typeof v === "boolean") values[k] = v;
    const name = cleanName(p.name);
    if (name) out.push({ name, values });
  }
  return out.slice(0, MAX_PRESETS);
}
