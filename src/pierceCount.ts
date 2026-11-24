/**
 * PIERCE COUNTER (plasma): how often the torch was fired since the nozzle/electrode was changed.
 * Counts the torch-on lines of jobs that ran on the machine. Stopped jobs count up to the last line the machine took,
 * which can be a few lines more than it really carried out (they wait in its buffer) – so it is a guide value.
 */
const KEY = "cnc_craft_plasma_pierces";
export const PIERCES_CHANGED = "cnc-plasma-pierces";

export interface PierceState { count: number; limit: number; since: string }

/** Torch-on commands in lines[from … to-1] (M3/M4 with power, not in comments) */
export function countPierces(lines: string[], from = 0, to = lines.length): number {
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(lines.length, to); i++) {
    const l = lines[i].replace(/\([^)]*(?:\)|$)/g, "").replace(/;.*$/, "").toUpperCase();
    if (!/M\s*0*[34](?![\d.])/.test(l)) continue;
    const s = /S\s*(\d*\.?\d+)/.exec(l);
    if (!s || parseFloat(s[1]) > 0) n++;
  }
  return n;
}

const int = (v: unknown, max: number) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0; };

export function loadPierces(): PierceState {
  let d: any = {};
  try { d = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { /* starts at 0 */ }
  return { count: int(d.count, 1e9), limit: int(d.limit, 1e6), since: typeof d.since === "string" && !isNaN(Date.parse(d.since)) ? d.since : "" };
}

function savePierces(s: PierceState) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* only a comfort value */ }
  window.dispatchEvent(new CustomEvent(PIERCES_CHANGED));
}

/** true = the limit was reached with this job */
export function addPierces(n: number): boolean {
  if (!(n > 0)) return false;
  const s = loadPierces(), before = s.count;
  savePierces({ ...s, count: before + n, since: s.since || new Date().toISOString() });
  return s.limit > 0 && before < s.limit && before + n >= s.limit;
}
export function resetPierces() { savePierces({ ...loadPierces(), count: 0, since: new Date().toISOString() }); }
export function setPierceLimit(limit: number) { savePierces({ ...loadPierces(), limit: int(limit, 1e6) }); }
