/**
 * BOHRDATEIEN LESEN (Excellon / XNC) – reine Rechnung, Tests in tests/pcb.test.ts
 *
 * Ergebnis in mm: Löcher (Mitte, Ø) und Langlöcher (Mittellinie, Breite). Dateien ohne Dezimalpunkt brauchen das richtige
 * Zahlenformat; steht es nicht in der Datei, gilt das übliche (mm 3.3, Zoll 2.4) und guessed ist true.
 */
export interface Hole { x: number; y: number; d: number }
export interface Slot { pts: [number, number][]; d: number }
export interface DrillFile { holes: Hole[]; slots: Slot[]; plated: "" | "plated" | "nonplated"; guessed: boolean; warnings: string[] }

export const looksLikeExcellon = (t: string) => /(^|\n)\s*M48\b/.test(t.slice(0, 20000)) || (/(^|\n)T\d+C[\d.]/.test(t.slice(0, 20000)) && /(^|\n)X[-+\d.]/.test(t));

/** Für mehrdeutige Endungen (.nc, .tap): G-Code kennt M48 auch – hier muss ein Bohr-Kopf mit Einheit oder Werkzeug-Ø stehen */
export const surelyExcellon = (t: string) => { const h = t.slice(0, 4000); return /(^|\n)\s*M48\b/.test(h) && /(^|\n)\s*(METRIC|INCH|M71|M72|T\d+(F\d+)?(S\d+)?C[\d.]+)/.test(h) && !/(^|\n)\s*G2[01]\b/.test(h); };

const MAX = 200_000;

export function parseExcellon(text: string): DrillFile {
  const holes: Hole[] = [], slots: Slot[] = [], warnings = new Set<string>();
  let unit = 25.4, known = false, zeros: "L" | "T" | "" = "", intN = 0, dec = 0, decPoint = false, explicit = false;
  let plated: DrillFile["plated"] = "", typePlated: DrillFile["plated"] = "";
  const tools = new Map<number, number>();
  let dia = 0, x = 0, y = 0, inc = false, route = false, down = false, path: [number, number][] = [], noPointCoord = false, header = false, mode = 0;

  const num = (s: string): number => {
    if (s.includes(".")) { decPoint = true; return parseFloat(s) * unit; }
    noPointCoord = true;
    const neg = s.startsWith("-"), d = s.replace(/^[+-]/, "");
    const i = intN || (unit === 1 ? 3 : 2), f = dec || (unit === 1 ? 3 : 4);
    // LZ = führende Nullen bleiben (hinten abgeschnitten), TZ = hintere bleiben
    const v = zeros === "L" ? parseInt(d.padEnd(i + f, "0"), 10) : parseInt(d, 10);
    return (neg ? -1 : 1) * v / 10 ** f * unit;
  };
  const go = (s: string): boolean => {
    const mx = /X([-+]?[\d.]+)/.exec(s), my = /Y([-+]?[\d.]+)/.exec(s);
    if (!mx && !my) return false;
    const nx = mx ? num(mx[1]) : null, ny = my ? num(my[1]) : null;
    x = nx === null ? x : inc ? x + nx : nx;
    y = ny === null ? y : inc ? y + ny : ny;
    return true;
  };
  const add = () => { if (!(dia > 0)) { warnings.add("tool"); return; } holes.push({ x, y, d: dia }); if (holes.length + slots.length > MAX) throw new Error("too-big"); };
  const endPath = () => { if (path.length > 1) { if (dia > 0) slots.push({ pts: path, d: dia }); else warnings.add("tool"); } path = []; };
  const tool = (s: string): boolean => {
    const m = /^T(\d+)(.*)$/.exec(s);
    if (!m) return false;
    const c = /C([\d.]+)/.exec(m[2]);
    if (c) tools.set(+m[1], parseFloat(c[1]) * unit);
    if (!header || !c) { endPath(); if (+m[1] !== 0) { dia = tools.get(+m[1]) ?? 0; if (!dia) warnings.add("tool"); } }
    return true;
  };

  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(";")) {
      const f = /FILE_FORMAT\s*=\s*(\d)\s*:\s*(\d)/i.exec(line);
      if (f) { intN = +f[1]; dec = +f[2]; explicit = true; }
      if (/TYPE\s*=\s*NON_?PLATED/i.test(line)) typePlated = "nonplated";
      else if (/TYPE\s*=\s*PLATED/i.test(line)) typePlated = "plated";
      const q = /FileFunction,(Plated|NonPlated)/i.exec(line);
      if (q) plated = q[1].toLowerCase() === "plated" ? "plated" : "nonplated";
      continue;
    }
    const s = line.replace(/\s+/g, "").toUpperCase();
    if (s === "M48") { header = true; continue; }
    if (s === "%" || s === "M95") { header = false; continue; }
    const u = /^(METRIC|INCH)(?:,(LZ|TZ))?(?:,(0+)\.(0+))?/.exec(s);
    if (u) {
      unit = u[1] === "METRIC" ? 1 : 25.4; known = true;
      if (u[2]) zeros = u[2][0] as "L" | "T";
      if (u[3]) { intN = u[3].length; dec = u[4].length; explicit = true; }
      continue;
    }
    if (s === "M71") { unit = 1; known = true; continue; }
    if (s === "M72") { unit = 25.4; known = true; continue; }
    if (s === "G90" || s === "ICI,OFF") { inc = false; continue; }
    if (s === "G91" || s === "ICI" || s === "ICI,ON") { inc = true; continue; }
    if (s === "M30" || s === "M00") { endPath(); if (s === "M30") break; continue; }
    if (s === "M15" || s === "Z-1") { down = true; path = [[x, y]]; continue; }
    if (s === "M16" || s === "M17") { down = false; endPath(); continue; }
    if (s === "G05") { route = false; endPath(); continue; }
    if (/^(FMAT|VER|DETECT|ATC|G93|M25|M01|M08|R,|G40|G41|G42|F\d|S\d)/.test(s) || (header && /^T\d+[^C]*$/.test(s))) continue;
    if (tool(s)) continue;
    const g = /^G0*([0123])(?=[XY]|$)/.exec(s);
    if (g) {
      mode = +g[1];
      route = true;
      if (mode === 0) { endPath(); go(s); continue; }
    }
    const slot = /^((?:[XY][-+]?[\d.]+)+)G85((?:[XY][-+]?[\d.]+)+)/.exec(s);
    if (slot) { go(slot[1]); const a: [number, number] = [x, y]; go(slot[2]); if (dia > 0) slots.push({ pts: [a, [x, y]], d: dia }); else warnings.add("tool"); continue; }
    const rep = /^R0*(\d+)((?:[XY][-+]?[\d.]+)+)/.exec(s);
    if (rep) {
      const mx = /X([-+]?[\d.]+)/.exec(rep[2]), my = /Y([-+]?[\d.]+)/.exec(rep[2]), dx = mx ? num(mx[1]) : 0, dy = my ? num(my[1]) : 0;
      for (let k = 0; k < Math.min(+rep[1], 5000); k++) { x += dx; y += dy; add(); }
      continue;
    }
    if (/^(G0*[123])?[XY]/.test(s)) {
      const x0 = x, y0 = y;
      if (!go(s)) continue;
      if (route || down) {
        if (mode === 2 || mode === 3) { arcTo(path, x0, y0, x, y, s, mode === 2, num, warnings); continue; }
        if (down || (route && mode === 1)) { if (!path.length) path.push([x0, y0]); path.push([x, y]); }
      } else add();
      continue;
    }
    if (!/^[A-Z,\d.-]*$/.test(s)) warnings.add("syntax");
    else if (!header) warnings.add("syntax");
  }
  endPath();
  if (!known) warnings.add("units");
  return { holes, slots, plated: plated || typePlated, guessed: noPointCoord && !explicit, warnings: [...warnings].concat(decPoint && noPointCoord ? [] : []) };
}

/** Bogen in einem gefrästen Langloch: Radius A oder Mittelpunkt I/J */
function arcTo(path: [number, number][], x0: number, y0: number, x1: number, y1: number, s: string, cw: boolean, num: (v: string) => number, warnings: Set<string>) {
  if (!path.length) path.push([x0, y0]);
  const a = /A([-+]?[\d.]+)/.exec(s), i = /I([-+]?[\d.]+)/.exec(s), j = /J([-+]?[\d.]+)/.exec(s);
  let cx: number, cy: number;
  const d = Math.hypot(x1 - x0, y1 - y0);
  if (i || j) { cx = x0 + (i ? num(i[1]) : 0); cy = y0 + (j ? num(j[1]) : 0); }
  else if (a && d > 1e-9) {
    const r = Math.max(num(a[1]), d / 2), h = Math.sqrt(Math.max(0, r * r - d * d / 4)), sg = cw ? 1 : -1;
    cx = (x0 + x1) / 2 + sg * h * (y1 - y0) / d; cy = (y0 + y1) / 2 - sg * h * (x1 - x0) / d;
  } else { warnings.add("syntax"); path.push([x1, y1]); return; }
  let sw = Math.atan2(y1 - cy, x1 - cx) - Math.atan2(y0 - cy, x0 - cx);
  if (cw) { while (sw > 1e-12) sw -= 2 * Math.PI; } else while (sw < -1e-12) sw += 2 * Math.PI;
  const a0 = Math.atan2(y0 - cy, x0 - cx), r = Math.hypot(x0 - cx, y0 - cy), n = Math.max(2, Math.min(200, Math.ceil(Math.abs(sw) * Math.sqrt(r) * 8)));
  for (let k = 1; k < n; k++) path.push([cx + r * Math.cos(a0 + sw * k / n), cy + r * Math.sin(a0 + sw * k / n)]);
  path.push([x1, y1]);
}

/** Löcher nach Durchmesser zusammenfassen (auf 0,01 mm) */
export function bySize(holes: Hole[]): { d: number; holes: Hole[] }[] {
  const m = new Map<number, Hole[]>();
  for (const h of holes) { const k = Math.round(h.d * 100) / 100; const l = m.get(k); if (l) l.push(h); else m.set(k, [h]); }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([d, hs]) => ({ d, holes: hs }));
}
