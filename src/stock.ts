/**
 * MATERIAL-PLATTE: verbrauchte Fläche merken (auch nach einem Neustart)
 *
 * Die Platte wird als feines Raster gespeichert (0,5–2 mm pro Zelle, je nach Größe).
 * Nach einem Job werden alle Zellen als "verbraucht" markiert,
 *   - über die das Werkzeug / der Laser / der Brenner geschnitten hat, und
 *   - die von Schnitten ganz umschlossen sind (das Teil ist ja herausgefallen).
 * Das funktioniert für jeden G-Code – egal ob aus der Zeichnung oder aus einer Datei.
 *
 * Für jede Maschinenart (Fräse / Laser / Plasma) gibt es eine eigene Platte.
 * Koordinaten: wie im G-Code (mm, Nullpunkt links unten) – der Werkstück-Nullpunkt muss
 * also beim nächsten Mal wieder an derselben Stelle liegen.
 *
 * Außerdem:
 *   - prüfen, ob eine Form auf verbrauchter Fläche liegt (mit Sicherheitsabstand)
 *   - ausgewählte Formen automatisch auf eine freie Stelle schieben
 */
import { MM_TO_PIXEL, shapeToPaths, Pt } from "./shapeTransform";
import { parseGcodeProgram, MOVE_CUT } from "./sim/gcodeParser";
import { getMachineMode, MachineMode } from "./machineMode";
import { toolForShape, getTools } from "./toolLibrary";
import { cutForShape, getCuts } from "./plasmaCuts";

export const STOCK_CHANGED = "cnc-stock-changed";

export interface StockJob { date: string; label: string; percent: number }

export interface Stock {
  w: number; h: number;        // Plattengröße in mm
  cell: number;                // Rastergröße in mm
  cols: number; rows: number;
  used: Uint8Array;            // 1 = verbraucht (Zeile 0 = unten, y = 0)
  jobs: StockJob[];            // Verlauf (neueste zuletzt)
  undo: string | null;         // Stand vor der letzten Markierung (RLE)
  version: number;             // ändert sich bei jeder Änderung (für Zwischenspeicher)
}

export const stockOptions = { margin: 2, show: true };
const KEY_OPTIONS = "cnc_craft_stock_options";
const keyFor = (m: MachineMode) => "cnc_craft_stock_" + m;
const stocks = new Map<MachineMode, Stock>();
let versionCounter = 1;

// ---------------------------------------------------------------------
// Anlegen / Laden / Speichern
// ---------------------------------------------------------------------

function cellFor(w: number, h: number) {
  return Math.max(0.5, Math.ceil((Math.max(w, h) / 1200) * 10) / 10);
}

function blank(w: number, h: number): Stock {
  const cell = cellFor(w, h);
  const cols = Math.max(1, Math.ceil(w / cell)), rows = Math.max(1, Math.ceil(h / cell));
  return { w, h, cell, cols, rows, used: new Uint8Array(cols * rows), jobs: [], undo: null, version: versionCounter++ };
}

function encode(a: Uint8Array): string {
  const runs: number[] = [];
  let cur = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === cur) n++;
    else { runs.push(n); cur = a[i]; n = 1; }
  }
  runs.push(n);
  return runs.join(",");
}

function decode(s: string, len: number): Uint8Array {
  const a = new Uint8Array(len);
  let i = 0, v = 0;
  for (const part of s.split(",")) {
    const n = parseInt(part, 10) || 0;
    if (v) a.fill(1, i, Math.min(len, i + n));
    i += n; v = 1 - v;
  }
  return a;
}

export function initStock() {
  try {
    const raw = localStorage.getItem(KEY_OPTIONS);
    if (raw) {
      const o = JSON.parse(raw);
      if (Number.isFinite(+o.margin) && +o.margin >= 0) stockOptions.margin = +o.margin;
      if (typeof o.show === "boolean") stockOptions.show = o.show;
    }
  } catch { /* Standardwerte */ }
}

export function saveStockOptions() {
  try { localStorage.setItem(KEY_OPTIONS, JSON.stringify(stockOptions)); } catch { /* egal */ }
  window.dispatchEvent(new CustomEvent(STOCK_CHANGED));
  window.dispatchEvent(new Event("cnc-redraw"));
}

function bedMm(): { w: number; h: number } {
  const w = parseFloat((document.getElementById("bed-w") as HTMLInputElement | null)?.value || "300") || 300;
  const h = parseFloat((document.getElementById("bed-h") as HTMLInputElement | null)?.value || "300") || 300;
  return { w, h };
}

/** Platte der aktuellen Maschinenart */
export function getStock(mode: MachineMode = getMachineMode()): Stock {
  let s = stocks.get(mode);
  if (s) return s;
  try {
    const raw = localStorage.getItem(keyFor(mode));
    if (raw) {
      const d = JSON.parse(raw);
      const b = blank(+d.w, +d.h);
      if (b.cell === +d.cell) {
        b.used = decode(String(d.used || ""), b.cols * b.rows);
        b.jobs = Array.isArray(d.jobs) ? d.jobs.slice(-50) : [];
        b.undo = typeof d.undo === "string" ? d.undo : null;
        s = b;
      }
    }
  } catch { /* defekt -> neue Platte */ }
  if (!s) { const bed = bedMm(); s = blank(bed.w, bed.h); }
  stocks.set(mode, s);
  return s;
}

function save(mode: MachineMode = getMachineMode()) {
  const s = getStock(mode);
  s.version = versionCounter++;
  try {
    localStorage.setItem(keyFor(mode), JSON.stringify({
      w: s.w, h: s.h, cell: s.cell, used: encode(s.used), jobs: s.jobs, undo: s.undo
    }));
  } catch { /* zu groß / gesperrt – gilt trotzdem bis zum Neustart */ }
  window.dispatchEvent(new CustomEvent(STOCK_CHANGED));
  window.dispatchEvent(new Event("cnc-redraw"));
}

export function usedPercent(s: Stock = getStock()): number {
  let n = 0;
  for (let i = 0; i < s.used.length; i++) n += s.used[i];
  return s.used.length ? (n / s.used.length) * 100 : 0;
}

export function hasUsedArea(mode: MachineMode = getMachineMode()): boolean {
  const s = getStock(mode);
  for (let i = 0; i < s.used.length; i++) if (s.used[i]) return true;
  return false;
}

/** Neue Platte: alles frei (optional mit neuer Größe) */
export function newPlate(w?: number, h?: number) {
  const mode = getMachineMode();
  const old = getStock(mode);
  const size = w && h ? { w, h } : { w: old.w, h: old.h };
  const s = blank(size.w, size.h);
  stocks.set(mode, s);
  save(mode);
}

/** Letzte Markierung zurücknehmen */
export function undoLastMark(): boolean {
  const s = getStock();
  if (!s.undo) return false;
  s.used = decode(s.undo, s.cols * s.rows);
  s.undo = null;
  s.jobs.pop();
  save();
  return true;
}

// ---------------------------------------------------------------------
// Markieren aus G-Code
// ---------------------------------------------------------------------

/** Schnittbreite für die Markierung (größtes benutztes Werkzeug / Schnittspalt) */
export function cutWidthFor(shapes: any[], mode: MachineMode = getMachineMode()): number {
  if (mode === "laser") return 0.3;
  if (mode === "plasma") {
    let k = 0;
    for (const s of shapes) k = Math.max(k, cutForShape(s)?.kerf || 0);
    if (!k) k = Math.max(0, ...getCuts().map(c => c.kerf));
    return Math.max(0.5, k);
  }
  let d = 0;
  for (const s of shapes) d = Math.max(d, toolForShape(s)?.diameter || 0);
  if (!d) d = Math.max(0, ...getTools().map(t => t.diameter));
  return Math.max(0.5, d || 3);
}

/**
 * Markiert die verbrauchte Fläche eines Jobs.
 * upToLine: nur bis zu dieser Zeile (bei abgebrochenem Job); width: Schnittbreite in mm.
 * Rückgabe: neu verbrauchte Fläche in Prozent der Platte.
 */
export function markFromGcode(lines: string[], label: string, width: number, upToLine = Infinity): number {
  const mode = getMachineMode();
  const s = getStock(mode);
  const before = usedPercent(s);
  const prog = parseGcodeProgram(lines);
  const cut = new Uint8Array(s.cols * s.rows);
  const r = Math.max(width / 2, s.cell * 0.5);
  const disk = diskOffsets(Math.max(0, Math.round(r / s.cell)));

  for (let i = 0; i < prog.n; i++) {
    if (prog.line[i] >= upToLine) break;
    if (prog.type[i] !== MOVE_CUT) continue;
    // Fräse: nur was unter der Oberfläche (Z < 0) passiert, ist ein Schnitt
    if (mode === "mill" && Math.min(prog.z0[i], prog.z1[i]) >= -0.001) continue;
    stampSegment(s, cut, prog.x0[i], prog.y0[i], prog.x1[i], prog.y1[i], disk);
  }

  s.undo = encode(s.used);
  // Wände = alt verbraucht + neu geschnitten; was davon ganz umschlossen ist, ist herausgefallen
  const walls = new Uint8Array(s.used.length);
  for (let i = 0; i < walls.length; i++) walls[i] = s.used[i] | cut[i];
  const enclosed = enclosedCells(s, walls);
  for (let i = 0; i < walls.length; i++) if (walls[i] || enclosed[i]) s.used[i] = 1;

  const after = usedPercent(s);
  s.jobs.push({ date: new Date().toISOString(), label, percent: Math.round(after * 10) / 10 });
  if (s.jobs.length > 50) s.jobs.shift();
  save(mode);
  return after - before;
}

function diskOffsets(rc: number): number[][] {
  const out: number[][] = [];
  for (let dy = -rc; dy <= rc; dy++) for (let dx = -rc; dx <= rc; dx++) if (dx * dx + dy * dy <= rc * rc + rc) out.push([dx, dy]);
  return out;
}

function stampSegment(s: Stock, grid: Uint8Array, x0: number, y0: number, x1: number, y1: number, disk: number[][]) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len / (s.cell * 0.5)));
  let lastC = -1, lastR = -1;
  for (let k = 0; k <= steps; k++) {
    const x = x0 + ((x1 - x0) * k) / steps, y = y0 + ((y1 - y0) * k) / steps;
    const c = Math.floor(x / s.cell), r = Math.floor(y / s.cell);
    if (c === lastC && r === lastR) continue;
    lastC = c; lastR = r;
    for (const [dx, dy] of disk) {
      const cc = c + dx, rr = r + dy;
      if (cc >= 0 && rr >= 0 && cc < s.cols && rr < s.rows) grid[rr * s.cols + cc] = 1;
    }
  }
}

/** Zellen, die von außen (Plattenrand) nicht erreichbar sind */
function enclosedCells(s: Stock, walls: Uint8Array): Uint8Array {
  const { cols, rows } = s;
  const seen = new Uint8Array(cols * rows);
  const queue = new Int32Array(cols * rows);
  let head = 0, tail = 0;
  const push = (i: number) => { if (!walls[i] && !seen[i]) { seen[i] = 1; queue[tail++] = i; } };
  for (let c = 0; c < cols; c++) { push(c); push((rows - 1) * cols + c); }
  for (let r = 0; r < rows; r++) { push(r * cols); push(r * cols + cols - 1); }
  while (head < tail) {
    const i = queue[head++];
    const c = i % cols, r = (i - c) / cols;
    if (c > 0) push(i - 1);
    if (c < cols - 1) push(i + 1);
    if (r > 0) push(i - cols);
    if (r < rows - 1) push(i + cols);
  }
  const out = new Uint8Array(cols * rows);
  for (let i = 0; i < out.length; i++) out[i] = !walls[i] && !seen[i] ? 1 : 0;
  return out;
}

// ---------------------------------------------------------------------
// Fußabdruck von Formen (für Warnung und "freie Stelle")
// ---------------------------------------------------------------------

/** Radius des Werkzeugs/Strahls für eine Form in mm */
function shapeToolRadius(shape: any): number {
  const mode = getMachineMode();
  if (mode === "laser") return 0.15;
  if (mode === "plasma") return (cutForShape(shape)?.kerf || 1.5) / 2;
  return (toolForShape(shape)?.diameter || 3) / 2;
}

interface Footprint { cells: number[]; minC: number; minR: number; maxC: number; maxR: number }

const fpCache = new WeakMap<object, { sig: string; fp: Footprint }>();

function shapeSig(shape: any): string {
  let a = 0, b = 0;
  const pts = shape.points || [];
  for (let i = 0; i < pts.length; i++) { a += pts[i].x * (i % 7 + 1); b += pts[i].y * (i % 5 + 1); }
  return [shape.type, shape.x, shape.y, shape.w, shape.h, shape.midX, shape.midY, pts.length, a.toFixed(2), b.toFixed(2)].join("|");
}

/**
 * Zellen, die eine Form beim Schneiden belegt: geschlossene Konturen samt Innenfläche,
 * plus ein Rand von (2 × Werkzeugradius + Sicherheitsabstand). Zellen als c + r * BIG.
 */
const BIG = 1 << 20;
function footprint(shape: any, s: Stock): Footprint {
  const R = 2 * shapeToolRadius(shape) + stockOptions.margin;
  const sig = shapeSig(shape) + "|" + s.cell + "|" + R + "|" + getMachineMode();
  const c = fpCache.get(shape);
  if (c && c.sig === sig) return c.fp;

  const set = new Set<number>();
  const cell = s.cell;
  const add = (cc: number, rr: number) => set.add((rr + BIG / 2) * BIG + (cc + BIG / 2));
  const disk = diskOffsets(Math.max(0, Math.ceil(R / cell)));
  for (const path of shapeToPaths(shape)) {
    const pts: Pt[] = path.pts.map(p => ({ x: p.x / MM_TO_PIXEL, y: p.y / MM_TO_PIXEL }));
    if (pts.length < 2) continue;
    // Rand
    const segs = path.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < segs; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      const steps = Math.max(1, Math.ceil(len / (cell * 0.5)));
      let lc = NaN, lr = NaN;
      for (let k = 0; k <= steps; k++) {
        const cc = Math.floor((p.x + ((q.x - p.x) * k) / steps) / cell), rr = Math.floor((p.y + ((q.y - p.y) * k) / steps) / cell);
        if (cc === lc && rr === lr) continue;
        lc = cc; lr = rr;
        for (const [dx, dy] of disk) add(cc + dx, rr + dy);
      }
    }
    // Innenfläche (gerade/ungerade je Kontur – Löcher sind beim Teil ohnehin dabei)
    if (path.closed && pts.length > 2) {
      let minY = Infinity, maxY = -Infinity;
      for (const p of pts) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
      for (let rr = Math.floor(minY / cell); rr <= Math.floor(maxY / cell); rr++) {
        const y = (rr + 0.5) * cell;
        const xs: number[] = [];
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
        }
        xs.sort((u, v) => u - v);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          for (let cc = Math.floor(xs[i] / cell); cc <= Math.floor(xs[i + 1] / cell); cc++) add(cc, rr);
        }
      }
    }
  }
  const cells = [...set];
  let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
  const out: number[] = [];
  for (const k of cells) {
    const rr = Math.floor(k / BIG) - BIG / 2, cc = (k % BIG) - BIG / 2;
    out.push(cc, rr);
    if (cc < minC) minC = cc; if (cc > maxC) maxC = cc;
    if (rr < minR) minR = rr; if (rr > maxR) maxR = rr;
  }
  const fp = { cells: out, minC, minR, maxC, maxR };
  fpCache.set(shape, { sig, fp });
  return fp;
}

/** Liegt die Form (mit Sicherheitsabstand) auf verbrauchter Fläche? */
const overlapCache = new WeakMap<object, { key: string; v: boolean }>();
export function shapeOnUsedArea(shape: any): boolean {
  const s = getStock();
  const key = shapeSig(shape) + "|" + s.version + "|" + stockOptions.margin + "|" + getMachineMode();
  const c = overlapCache.get(shape);
  if (c && c.key === key) return c.v;
  const fp = footprint(shape, s);
  let v = false;
  for (let i = 0; i < fp.cells.length && !v; i += 2) {
    const cc = fp.cells[i], rr = fp.cells[i + 1];
    if (cc >= 0 && rr >= 0 && cc < s.cols && rr < s.rows && s.used[rr * s.cols + cc]) v = true;
  }
  overlapCache.set(shape, { key, v });
  return v;
}

/** Warnungen für den G-Code (Formen auf verbrauchter Fläche) */
export function stockWarnings(shapes: any[], msg: (n: number) => string): string[] {
  if (!hasUsedArea()) return [];
  const bad = shapes.filter(sh => shapeOnUsedArea(sh)).length;
  return bad ? [msg(bad)] : [];
}

/**
 * Ausgewählte Formen auf die nächste freie Stelle schieben (von links unten aus gesucht).
 * Hindernisse: verbrauchte Fläche + alle anderen Formen (mit Abstand).
 * Rückgabe: Verschiebung in Welt-Pixeln, oder null wenn kein Platz ist.
 */
export function findFreeSpot(selected: any[], others: any[]): { dx: number; dy: number } | null {
  const s = getStock();
  const { cols, rows } = s;
  const obst = new Uint8Array(s.used);
  for (const o of others) {
    const fp = footprint(o, s);
    for (let i = 0; i < fp.cells.length; i += 2) {
      const cc = fp.cells[i], rr = fp.cells[i + 1];
      if (cc >= 0 && rr >= 0 && cc < cols && rr < rows) obst[rr * cols + cc] = 1;
    }
  }
  // Maske der Auswahl (relativ zur eigenen linken unteren Ecke)
  let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
  const fps = selected.map(sh => footprint(sh, s));
  for (const fp of fps) { minC = Math.min(minC, fp.minC); minR = Math.min(minR, fp.minR); maxC = Math.max(maxC, fp.maxC); maxR = Math.max(maxR, fp.maxR); }
  if (!Number.isFinite(minC)) return null;
  const mw = maxC - minC + 1, mh = maxR - minR + 1;
  if (mw > cols || mh > rows) return null;
  const maskSet = new Set<number>();
  for (const fp of fps) for (let i = 0; i < fp.cells.length; i += 2) maskSet.add((fp.cells[i + 1] - minR) * mw + (fp.cells[i] - minC));
  const mask = [...maskSet].map(k => [k % mw, Math.floor(k / mw)]);

  // Summen-Tabelle für den schnellen "Rechteck ist ganz frei"-Test
  const W = cols + 1;
  const sum = new Int32Array((cols + 1) * (rows + 1));
  for (let r = 0; r < rows; r++) {
    let rowSum = 0;
    for (let c = 0; c < cols; c++) {
      rowSum += obst[r * cols + c];
      sum[(r + 1) * W + c + 1] = sum[r * W + c + 1] + rowSum;
    }
  }
  const rectFree = (c0: number, r0: number) =>
    sum[(r0 + mh) * W + c0 + mw] - sum[r0 * W + c0 + mw] - sum[(r0 + mh) * W + c0] + sum[r0 * W + c0] === 0;

  let budget = 3e7;
  for (let r0 = 0; r0 + mh <= rows; r0++) {
    for (let c0 = 0; c0 + mw <= cols; c0++) {
      if (rectFree(c0, r0)) return shift(c0, r0);
      if (budget <= 0) continue;
      let ok = true;
      for (let i = 0; i < mask.length; i++) {
        if (obst[(r0 + mask[i][1]) * cols + c0 + mask[i][0]]) { ok = false; budget -= i + 1; break; }
      }
      if (ok) return shift(c0, r0);
    }
  }
  return null;

  function shift(c0: number, r0: number) {
    return { dx: (c0 - minC) * s.cell * MM_TO_PIXEL, dy: (r0 - minR) * s.cell * MM_TO_PIXEL };
  }
}

// ---------------------------------------------------------------------
// Zeichnen
// ---------------------------------------------------------------------

let imgCache: { version: number; canvas: HTMLCanvasElement } | null = null;

function usedImage(s: Stock): HTMLCanvasElement {
  if (imgCache && imgCache.version === s.version) return imgCache.canvas;
  const cv = document.createElement("canvas");
  cv.width = s.cols; cv.height = s.rows;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(s.cols, s.rows);
  for (let r = 0; r < s.rows; r++) {
    const yImg = s.rows - 1 - r; // Bild-Zeile 0 = oben
    for (let c = 0; c < s.cols; c++) {
      if (!s.used[r * s.cols + c]) continue;
      const o = (yImg * s.cols + c) * 4;
      const stripe = (c + r) % 8 < 3;
      img.data[o] = 255; img.data[o + 1] = 90; img.data[o + 2] = 60;
      img.data[o + 3] = stripe ? 120 : 50;
    }
  }
  ctx.putImageData(img, 0, 0);
  imgCache = { version: s.version, canvas: cv };
  return cv;
}

/** Verbrauchte Fläche + Plattenumriss auf die Zeichenfläche malen (vor den Formen) */
export function drawStock(ctx: CanvasRenderingContext2D, sx: (x: number) => number, sy: (y: number) => number, scale: number) {
  const s = getStock();
  const bed = bedMm();
  const x0 = sx(0), y1 = sy(s.h * MM_TO_PIXEL);
  const w = s.w * MM_TO_PIXEL * scale, h = s.h * MM_TO_PIXEL * scale;
  if (stockOptions.show && hasUsedArea()) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    // Das Raster ist evtl. etwas größer als die Platte (ganze Zellen) -> oben an der Rasterkante ausrichten
    const yTop = sy(s.rows * s.cell * MM_TO_PIXEL);
    ctx.drawImage(usedImage(s), 0, 0, s.cols, s.rows, x0, yTop, s.cols * s.cell * MM_TO_PIXEL * scale, s.rows * s.cell * MM_TO_PIXEL * scale);
    ctx.restore();
  }
  // Plattenumriss, wenn die Platte kleiner/größer als der Arbeitsraum ist
  if (Math.abs(s.w - bed.w) > 0.01 || Math.abs(s.h - bed.h) > 0.01) {
    ctx.save();
    ctx.strokeStyle = "#ffb020";
    ctx.setLineDash([8, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y1, w, h);
    ctx.restore();
  }
}

/** Kleine Vorschau der Platte (für die Abfrage beim Start) */
export function drawStockPreview(canvas: HTMLCanvasElement, mode: MachineMode) {
  const s = getStock(mode);
  const ctx = canvas.getContext("2d")!;
  const k = Math.min(canvas.width / s.w, canvas.height / s.h);
  const w = s.w * k, h = s.h * k, ox = (canvas.width - w) / 2, oy = (canvas.height - h) / 2;
  ctx.fillStyle = "#16161c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#24242c";
  ctx.fillRect(ox, oy, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(usedImage(s), 0, 0, s.cols, s.rows, ox, oy + h - s.rows * s.cell * k, s.cols * s.cell * k, s.rows * s.cell * k);
  ctx.strokeStyle = "#ffb020";
  ctx.strokeRect(ox + 0.5, oy + 0.5, w - 1, h - 1);
}
