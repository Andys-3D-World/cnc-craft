/** SPANNPLÄTZE: Speicher (je Maschinenart und Maschinen-Profil) und der gewählte Platz – Rechnung in places.ts */
import { getMachineMode } from "./machineMode";
import { currentMachine } from "./ui/machineWizard";
import { cleanPlaces, type Place } from "./places";

const KEY = "cnc_craft_places", KEY_ACTIVE = "cnc_craft_place_active_";
export const PLACES_CHANGED = "cnc-places-changed";

let list: Place[] | null = null;
function all(): Place[] {
  if (!list) { try { list = cleanPlaces(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch { list = []; } }
  return list;
}
const changed = () => {
  window.dispatchEvent(new CustomEvent(PLACES_CHANGED));
  window.dispatchEvent(new Event("cnc-redraw"));
};
function write(next: Place[]): boolean {
  const clean = cleanPlaces(next);
  if (clean.length !== next.length) return false; // Liste voll oder Eintrag unbrauchbar
  try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch { return false; }
  list = clean;
  changed();
  return true;
}

/** Maschinen-Koordinaten gelten nur für die eine Maschine */
export function machineKey(): string {
  const m = currentMachine();
  return m ? `${m.id}|${m.name}` : "";
}

export function places(): Place[] {
  const mode = getMachineMode(), key = machineKey();
  return all().filter(p => p.mode === mode && p.machine === key);
}

export function putPlace(p: Place): boolean {
  return write(all().some(o => o.id === p.id) ? all().map(o => (o.id === p.id ? p : o)) : [...all(), p]);
}

export function dropPlace(id: string) { write(all().filter(p => p.id !== id)); }

export function activePlace(): Place | null {
  let id = "";
  try { id = localStorage.getItem(KEY_ACTIVE + getMachineMode()) || ""; } catch { /* egal */ }
  return places().find(p => p.id === id) || null;
}

export function setActivePlace(id: string) {
  try { localStorage.setItem(KEY_ACTIVE + getMachineMode(), id); } catch { /* egal */ }
  changed();
}
