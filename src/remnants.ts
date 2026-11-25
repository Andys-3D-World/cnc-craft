/**
 * REMNANTS: saved material sheets with what is already cut out of them.
 *
 * The material sheet (stock.ts) remembers the used area of the sheet that lies on the machine now. A remnant is a
 * copy of that state under a name – "steel 3 mm, half sheet" – so the sheet can be taken off the machine and put
 * back weeks later: load the remnant and nesting, "Place on free spot" and the used-area check work on it again.
 *
 * Only the list is handled here (no page, no storage) – tests in tests/remnants.test.ts.
 */
export interface Remnant {
  name: string;
  mode: string;    // machine type the sheet belongs to: "mill" | "laser" | "plasma"
  w: number; h: number; cell: number;   // sheet size and grid size in mm
  used: string;    // used cells, run-length coded as in stock.ts (free, used, free …)
  percent: number; // used area in %
  thick?: number;  // sheet thickness in mm, if entered
  date: string;    // ISO date of saving
}

export const MAX_REMNANTS = 60;
export const MAX_NAME = 60;
const MODES = ["mill", "laser", "plasma"];
/** biggest grid a remnant may have (cells) – a sheet of 2.4 × 1.2 m at the finest grid is far below */
const MAX_CELLS = 8_000_000;

const fin = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

/** One entry from storage or a file, cleaned. null = not usable */
export function cleanRemnant(raw: any): Remnant | null {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, MAX_NAME) : "";
  const w = fin(raw.w), h = fin(raw.h), cell = fin(raw.cell);
  if (!name || !MODES.includes(raw.mode) || !(w > 0) || !(h > 0) || !(cell > 0) || w > 100000 || h > 100000) return null;
  if (Math.ceil(w / cell) * Math.ceil(h / cell) > MAX_CELLS) return null;
  if (typeof raw.used !== "string" || !/^\d+(,\d+)*$/.test(raw.used)) return null;
  const percent = fin(raw.percent);
  const thick = fin(raw.thick);
  return { name, mode: raw.mode, w, h, ...(thick > 0 && thick <= 1000 ? { thick } : {}), cell, used: raw.used, percent: percent >= 0 && percent <= 100 ? percent : 0,
    date: typeof raw.date === "string" && !isNaN(Date.parse(raw.date)) ? raw.date : "" };
}

export function cleanRemnants(raw: any): Remnant[] {
  if (!Array.isArray(raw)) return [];
  const out: Remnant[] = [];
  for (const r of raw) {
    const c = cleanRemnant(r);
    if (c && !out.some(o => o.name === c.name && o.mode === c.mode)) out.push(c);
    if (out.length >= MAX_REMNANTS) break;
  }
  return out;
}

/** Add or replace (same name and machine type). Sorted by name. null = list is full */
export function putRemnant(list: Remnant[], r: Remnant): Remnant[] | null {
  const c = cleanRemnant(r);
  if (!c) return null;
  const rest = list.filter(o => !(o.name === c.name && o.mode === c.mode));
  if (rest.length >= MAX_REMNANTS) return null;
  return [...rest, c].sort((a, b) => a.name.localeCompare(b.name));
}

export function dropRemnant(list: Remnant[], name: string, mode: string): Remnant[] {
  return list.filter(o => !(o.name === name && o.mode === mode));
}

/** Free area of a remnant in m² (for the list) */
export function freeArea(r: Remnant): number {
  return (r.w * r.h * (100 - r.percent)) / 100 / 1e6;
}
