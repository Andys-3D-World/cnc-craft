/**
 * EIGENE MATERIAL-VORLAGEN (Laser und Plasma)
 *
 * Eine getestete Laser-Ebene oder ein Plasma-Schnitt lässt sich als „meine Vorlage“ merken und später mit einem Klick
 * wieder als neue Ebene / neuen Schnitt anlegen – auch wenn die Ebene in der Bibliothek längst geändert oder gelöscht ist.
 * Gespeichert wird eine Kopie der Werte (ohne Kennung und Sync-Felder); beim Anlegen prüft addLayer/addCut alles wie
 * bei einem Import. Eine Liste je Art unter cnc_craft_own_presets_<kind>.
 */

export type OwnKind = "laser" | "plasma";
export interface OwnPreset { id: string; label: string; data: Record<string, unknown> }

const key = (k: OwnKind) => "cnc_craft_own_presets_" + k;
const SKIP = new Set(["id", "updated", "device", "color"]);

export function ownPresets(kind: OwnKind): OwnPreset[] {
  try {
    const list = JSON.parse(localStorage.getItem(key(kind)) || "[]");
    if (!Array.isArray(list)) return [];
    return list.filter(p => p && typeof p.id === "string" && p.data && typeof p.data === "object").slice(0, 200)
      .map(p => ({ id: String(p.id).slice(0, 40), label: String(p.label || "?").slice(0, 120), data: p.data }));
  } catch { return []; }
}

function save(kind: OwnKind, list: OwnPreset[]) {
  try { localStorage.setItem(key(kind), JSON.stringify(list)); } catch { /* Speicher voll – bleibt bis zum Neustart */ }
}

/** Werte einer Ebene / eines Schnitts als Vorlage merken (gleicher Name = ersetzen) */
export function addOwnPreset(kind: OwnKind, label: string, values: object): OwnPreset {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (!SKIP.has(k) && (typeof v !== "object" || v === null)) data[k] = v;
  const list = ownPresets(kind);
  const name = label.trim().slice(0, 120) || "?";
  const old = list.findIndex(p => p.label === name);
  const p: OwnPreset = { id: old >= 0 ? list[old].id : "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), label: name, data };
  if (old >= 0) list[old] = p; else list.push(p);
  save(kind, list);
  return p;
}

export function removeOwnPreset(kind: OwnKind, id: string) {
  save(kind, ownPresets(kind).filter(p => p.id !== id));
}
