/**
 * WO LIEGT DER NULLPUNKT DER ZEICHNUNG AUF DER MASCHINE? (Maschinen-Koordinaten X/Y, nur zum Zeichnen fester Dinge)
 * Verbunden und referenziert: der wirkliche Nullpunkt. Sonst der gewählte Spannplatz, sonst der zuletzt gesehene. null = unbekannt
 */
import { machine, MACHINE_EVENT } from "./machine";
import { activePlace, machineKey } from "./placesStore";
import { zeroFor } from "./places";
import { getStock } from "./stock";
import { reportsInches } from "./units";

const KEY = "cnc_craft_last_zero";
type XY = { x: number; y: number };

function live(): XY | null {
  const m = machine;
  if (!m.connected || m.protocol !== "grbl" || !m.status.state || m.status.state === "Alarm" || reportsInches(m.settings.get("$13"))) return null;
  if (((parseFloat(m.settings.get("$22") ?? "") | 0) & 1) !== 1 || m.homeState === "lost" || m.homeState === "pending") return null;
  return { x: m.status.mpos[0] - m.status.wpos[0], y: m.status.mpos[1] - m.status.wpos[1] };
}

const readAll = (): Record<string, any> => { try { const o = JSON.parse(localStorage.getItem(KEY) || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { return {}; } };
let last: { key: string; z: XY | null } | null = null;
function remembered(): XY | null {
  const key = machineKey();
  if (last?.key !== key) { const v = readAll()[key]; last = { key, z: v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : null }; }
  return last.z;
}

export function drawingZero(): XY | null {
  const l = live();
  if (l) return l;
  const p = activePlace();
  return p ? zeroFor(p, getStock()) : remembered();
}

/** Beobachtet den Nullpunkt der Maschine: merken und neu zeichnen, wenn er sich geändert hat */
export function initDrawingZero() {
  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    if ((e as CustomEvent).detail?.type !== "status") return;
    const l = live(), o = remembered();
    if (!l || (o && Math.abs(o.x - l.x) < 0.02 && Math.abs(o.y - l.y) < 0.02)) return;
    last = { key: machineKey(), z: l };
    try { const all = readAll(); all[last.key] = { x: +l.x.toFixed(3), y: +l.y.toFixed(3) }; localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* gilt bis zum Neustart */ }
    window.dispatchEvent(new Event("cnc-redraw"));
  });
}
