/**
 * WERTE FÜR DIE LAUFZEIT: $110–$112, $120–$122, $11 der verbundenen Maschine.
 * Offline gelten die zuletzt gelesenen Werte; sonst Standardwerte, und die Anzeige sagt das.
 */
import { machine } from "../machine";
import type { MotionLimits } from "./motionPlan";

const KEY = "cnc_craft_motion_limits";
const DEFAULTS: MotionLimits = { accel: [300, 300, 100], maxRate: [5000, 5000, 1500], junctionDev: 0.01, lookahead: 16, source: "default" };

export function motionLimits(): MotionLimits {
  const lookahead = machine.firmware === "grblHAL" ? 35 : 16;
  if (machine.connected && machine.protocol === "grbl") {
    const num = (k: string) => parseFloat(machine.settings.get(k) ?? "");
    const a = [num("$120"), num("$121"), num("$122")], r = [num("$110"), num("$111"), num("$112")], j = num("$11");
    if (a.every(v => v > 0) && r.every(v => v > 0)) {
      const lim: MotionLimits = { accel: a, maxRate: r, junctionDev: j >= 0 ? j : DEFAULTS.junctionDev, arcTol: num("$12") > 0 ? num("$12") : 0.002, lookahead, source: "machine" };
      try { localStorage.setItem(KEY, JSON.stringify(lim)); } catch { /* nur Komfort */ }
      return lim;
    }
  }
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    const ok = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number" && x > 0);
    if (s && ok(s.accel) && ok(s.maxRate) && typeof s.junctionDev === "number" && s.junctionDev >= 0) {
      return { accel: s.accel, maxRate: s.maxRate, junctionDev: s.junctionDev, arcTol: s.arcTol > 0 ? s.arcTol : 0.002, lookahead: s.lookahead > 0 ? s.lookahead : 16, source: "saved" };
    }
  } catch { /* Standardwerte */ }
  return { ...DEFAULTS, lookahead };
}
