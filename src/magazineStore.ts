/** WERKZEUGMAGAZIN: Speicher (je Maschinen-Profil) – Rechnung in magazine.ts */
import { machineKey } from "./placesStore";
import { cleanMagazine, slotForTool, type Magazine } from "./magazine";
import { isMill } from "./machineMode";

const KEY = "cnc_craft_magazine";
export const MAGAZINE_CHANGED = "cnc-magazine-changed";
let cache: { key: string; m: Magazine } | null = null;

const readAll = (): Record<string, any> => { try { const o = JSON.parse(localStorage.getItem(KEY) || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { return {}; } };

export function magazine(): Magazine {
  const key = machineKey();
  if (cache?.key !== key) { const all = readAll(); cache = { key, m: cleanMagazine(Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null) }; }
  return cache.m;
}

export function saveMagazine(m: Magazine): void {
  const key = machineKey(), clean = cleanMagazine(m);
  cache = { key, m: clean };
  try { const all = readAll(); all[key] = clean; localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* gilt bis zum Neustart */ }
  window.dispatchEvent(new CustomEvent(MAGAZINE_CHANGED));
}

/** Was steckt in der Spindel? Wird VOR einem Wechsel auf unbekannt gesetzt: bricht er ab, rät danach niemand */
export function setInSpindle(n: number): void { saveMagazine({ ...magazine(), inSpindle: n }); }

export const rackOn = () => isMill() && magazine().kind === "rack";
/** Platznummer eines Werkzeugs (null = keins oder Magazin aus) */
export function slotNumber(toolId: string | undefined): number | null {
  return isMill() && toolId ? slotForTool(magazine(), toolId)?.n ?? null : null;
}
