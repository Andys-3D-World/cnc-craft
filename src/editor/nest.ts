/**
 * VERSCHACHTELN (Nesting, wie „Nest“ in LightBurn)
 *
 * Schiebt die Teile (Auswahl, sonst alles) möglichst eng aufs Bett – mit einstellbarem Abstand
 * zwischen den Teilen und zum Rand. Teile werden nach ihrer echten Form gesetzt (nicht nur als Kasten),
 * auf Wunsch gedreht (90° oder 45°) und auf Wunsch in Löcher großer Teile gelegt.
 *
 * So geht es: Jedes Teil wird auf ein Raster gezeichnet, dabei um den halben Abstand „dicker“ gemacht.
 * Zwei dicke Teile, die sich nicht überlappen, haben also mindestens den ganzen Abstand.
 * Dann wird jedes Teil (größtes zuerst) an die unterste, dann linkeste freie Stelle gesetzt.
 * Formen, die nicht verschachtelt werden, bleiben liegen und sind Hindernisse.
 */
import { app, bedSizeMm } from "./editorState";
import {
  MM_TO_PIXEL, Bounds, Pt, groupBounds, translateShape, rotateShape, shapeToPaths, shapeBounds, pointInPath, pathArea
} from "../shapeTransform";

export interface NestOptions {
  gapMm: number;       // Abstand zwischen den Teilen
  marginMm: number;    // Abstand zum Rand des Bettes
  rotate: "none" | "90" | "45";
  holes: boolean;      // kleine Teile dürfen in Löcher großer Teile
}

export interface NestResult { placed: number; failed: number; total: number }

/** Diese Formen lassen sich ohne Verlust drehen (Bilder z. B. nicht) */
const ROTATABLE = new Set(["polyline", "circle", "arc", "line", "rect"]);

interface Mask { cols: number; rows: number; runs: [number, number][][]; ox: number; oy: number; cells: number }
interface Unit { members: any[]; canRotate: boolean }
type Paths = { pts: Pt[]; closed: boolean }[];

// ---------------------------------------------------------------------
// Teile bilden: Gruppen bleiben zusammen, Formen in Löchern gehören zum Teil drumherum
// ---------------------------------------------------------------------

function closedPaths(members: any[]): Pt[][] {
  const out: Pt[][] = [];
  for (const s of members) for (const p of shapeToPaths(s)) if (p.closed && p.pts.length >= 3) out.push(p.pts);
  return out;
}

function inside(a: Bounds, b: Bounds) {
  return a.minX >= b.minX && a.maxX <= b.maxX && a.minY >= b.minY && a.maxY <= b.maxY;
}

function buildUnits(list: any[]): Unit[] {
  const byKey = new Map<string, any[]>();
  for (const s of list) {
    const k = s.groupId || s.id;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(s);
  }
  const units: { members: any[]; b: Bounds; area: number }[] = [];
  byKey.forEach(members => {
    const b = groupBounds(members);
    if (b) units.push({ members, b, area: (b.maxX - b.minX) * (b.maxY - b.minY) });
  });

  // Kleines Teil liegt ganz in einer geschlossenen Kontur eines größeren → gehört dazu (Loch, Gravur …)
  units.sort((a, b) => a.area - b.area);
  const merged = new Set<number>();
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const probe = shapeToPaths(u.members[0])[0]?.pts[0] || { x: u.b.minX, y: u.b.minY };
    for (let j = i + 1; j < units.length; j++) {
      const v = units[j];
      if (merged.has(j) || !inside(u.b, v.b) || pathAreaMax(v.members) <= 0) continue;
      if (closedPaths(v.members).some(pts => pointInPath(probe.x, probe.y, pts))) {
        v.members.push(...u.members);
        merged.add(i);
        break;
      }
    }
  }
  return units.filter((_, i) => !merged.has(i)).map(u => ({
    members: u.members,
    canRotate: u.members.every(s => ROTATABLE.has(s.type))
  }));
}

function pathAreaMax(members: any[]): number {
  return closedPaths(members).reduce((m, pts) => Math.max(m, Math.abs(pathArea(pts))), 0);
}

// ---------------------------------------------------------------------
// Raster
// ---------------------------------------------------------------------

let rc: HTMLCanvasElement | null = null;

/** Zeichnet Formen (Welt-Pixel, schon gedreht) als Maske – um halfGap dicker */
function rasterize(paths: Paths, boxes: Bounds[], cell: number, halfGap: number, holes: boolean): Mask | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  paths.forEach(p => p.pts.forEach(q => grow(q.x, q.y)));
  boxes.forEach(b => { grow(b.minX, b.minY); grow(b.maxX, b.maxY); });
  if (!isFinite(minX)) return null;

  const pad = halfGap + 2 * cell; // Luft, damit der dicke Rand nicht abgeschnitten wird
  const ox = minX - pad, oy = minY - pad;
  const cols = Math.max(1, Math.ceil((maxX - minX + 2 * pad) / cell));
  const rows = Math.max(1, Math.ceil((maxY - minY + 2 * pad) / cell));

  if (!rc) rc = document.createElement("canvas");
  rc.width = cols; rc.height = rows;
  const ctx = rc.getContext("2d", { willReadFrequently: true })!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cols, rows);
  // Welt → Raster: x nach rechts, y nach oben (im Bild ist Zeile 0 oben)
  const X = (x: number) => (x - ox) / cell;
  const Y = (y: number) => rows - (y - oy) / cell;
  ctx.fillStyle = "#000"; ctx.strokeStyle = "#000";
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1, (2 * halfGap) / cell);

  const trace = (p: { pts: Pt[]; closed: boolean }) => {
    p.pts.forEach((q, i) => i ? ctx.lineTo(X(q.x), Y(q.y)) : ctx.moveTo(X(q.x), Y(q.y)));
    if (p.closed) ctx.closePath();
  };
  const closed = paths.filter(p => p.closed && p.pts.length >= 3);
  if (holes) {
    // Löcher bleiben frei (gerade/ungerade-Regel)
    ctx.beginPath(); closed.forEach(trace); ctx.fill("evenodd");
  } else {
    closed.forEach(p => { ctx.beginPath(); trace(p); ctx.fill(); });
  }
  boxes.forEach(b => ctx.fillRect(X(b.minX), Y(b.maxY), (b.maxX - b.minX) / cell, (b.maxY - b.minY) / cell));
  ctx.beginPath(); paths.forEach(trace); ctx.stroke();
  boxes.forEach(b => ctx.strokeRect(X(b.minX), Y(b.maxY), (b.maxX - b.minX) / cell, (b.maxY - b.minY) / cell));

  const data = ctx.getImageData(0, 0, cols, rows).data;
  const runs: [number, number][][] = [];
  let cells = 0;
  for (let r = 0; r < rows; r++) {
    const ir = rows - 1 - r; // Bildzeile von oben → Rasterzeile von unten
    const row: [number, number][] = [];
    let start = -1;
    for (let c = 0; c <= cols; c++) {
      const on = c < cols && data[(ir * cols + c) * 4 + 3] > 0;
      if (on && start < 0) start = c;
      if (!on && start >= 0) { row.push([start, c - 1]); cells += c - start; start = -1; }
    }
    runs.push(row);
  }
  return { cols, rows, runs, ox, oy, cells };
}

function unitGeometry(members: any[]): { paths: Paths; boxes: Bounds[] } {
  const paths: Paths = [];
  const boxes: Bounds[] = [];
  for (const s of members) {
    const ps = shapeToPaths(s);
    if (ps.length) paths.push(...ps.map(p => ({ pts: p.pts.map(q => ({ x: q.x, y: q.y })), closed: p.closed })));
    else { const b = shapeBounds(s); if (b) boxes.push(b); }
  }
  return { paths, boxes };
}

function rotatePaths(paths: Paths, cx: number, cy: number, a: number): Paths {
  if (!a) return paths;
  const c = Math.cos(a), s = Math.sin(a);
  return paths.map(p => ({
    closed: p.closed,
    pts: p.pts.map(q => ({ x: cx + (q.x - cx) * c - (q.y - cy) * s, y: cy + (q.x - cx) * s + (q.y - cy) * c }))
  }));
}

/** Belegtes Bett: je Zeile Summen (schnelle Prüfung) und „letzte belegte Zelle“ (schnell weiterspringen) */
class Bed {
  occ: Uint8Array; pre: Int32Array[] = []; last: Int32Array[] = [];
  constructor(public cols: number, public rows: number) {
    this.occ = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) { this.pre.push(new Int32Array(cols + 1)); this.last.push(new Int32Array(cols).fill(-1)); }
  }
  private rebuild(r: number) {
    const pre = this.pre[r], last = this.last[r], base = r * this.cols;
    let lastOn = -1;
    for (let c = 0; c < this.cols; c++) {
      const on = this.occ[base + c];
      pre[c + 1] = pre[c] + on;
      if (on) lastOn = c;
      last[c] = lastOn;
    }
  }
  /** Maske an Rasterstelle (x,y) eintragen; was außerhalb liegt, wird abgeschnitten */
  mark(m: Mask, x: number, y: number) {
    for (let r = 0; r < m.rows; r++) {
      const row = y + r;
      if (row < 0 || row >= this.rows || !m.runs[r].length) continue;
      for (const [a, b] of m.runs[r]) {
        for (let c = Math.max(0, x + a); c <= Math.min(this.cols - 1, x + b); c++) this.occ[row * this.cols + c] = 1;
      }
      this.rebuild(row);
    }
  }
  /** Unterste, dann linkeste freie Stelle im Bereich lo … hi */
  find(m: Mask, lo: number, hiX: number, hiY: number): { x: number; y: number } | null {
    for (let y = lo; y + m.rows <= hiY; y++) {
      let x = lo;
      while (x + m.cols <= hiX) {
        let jump = -1;
        for (let r = 0; r < m.rows && jump < 0; r++) {
          const pre = this.pre[y + r], last = this.last[y + r];
          for (const [a, b] of m.runs[r]) {
            if (pre[x + b + 1] - pre[x + a] > 0) { jump = last[x + b] - a + 1; break; }
          }
        }
        if (jump < 0) return { x, y };
        x = jump;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------
// Hauptfunktion
// ---------------------------------------------------------------------

export function nestShapes(opts: NestOptions): NestResult {
  const st = app();
  const selIds = new Set<string>(st.selectedShapeIds);
  const list = selIds.size ? st.shapes.filter((s: any) => selIds.has(s.id)) : st.shapes;
  const units = buildUnits(list);
  if (!units.length) return { placed: 0, failed: 0, total: 0 };

  const bed = bedSizeMm();
  // Raster: höchstens ca. 600 Zellen je Seite, aber nicht feiner als 0,25 mm
  const cell = Math.max(0.25, Math.max(bed.w, bed.h) / 600) * MM_TO_PIXEL;
  // + 0,05 mm je Seite: Rundung im Raster, damit der Abstand nie kleiner als eingestellt wird
  const half = (Math.max(0, opts.gapMm) / 2 + 0.05) * MM_TO_PIXEL;
  const grid = new Bed(Math.floor((bed.w * MM_TO_PIXEL) / cell), Math.floor((bed.h * MM_TO_PIXEL) / cell));
  // Die Maske ist schon um den halben Abstand dicker → Rand entsprechend kleiner
  const lo = Math.max(0, Math.ceil((Math.max(0, opts.marginMm) * MM_TO_PIXEL - half) / cell));
  const hiX = grid.cols - lo, hiY = grid.rows - lo;

  // Formen, die liegen bleiben, sind Hindernisse
  const moving = new Set(units.flatMap(u => u.members.map(s => s.id)));
  for (const s of st.shapes as any[]) {
    if (moving.has(s.id)) continue;
    const g = unitGeometry([s]);
    const m = rasterize(g.paths, g.boxes, cell, half, opts.holes);
    if (!m) continue;
    // liegt nicht genau auf dem Raster → auf beiden Nachbarzellen eintragen (lieber etwas zu viel Abstand)
    const gx = Math.floor(m.ox / cell), gy = Math.floor(m.oy / cell);
    for (const [ax, ay] of [[0, 0], [1, 0], [0, 1], [1, 1]]) grid.mark(m, gx + ax, gy + ay);
  }

  const steps = opts.rotate === "45" ? 8 : opts.rotate === "90" ? 4 : 1;
  const prepared = units.map(u => {
    const g = unitGeometry(u.members);
    const b = groupBounds(u.members)!;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const masks: { a: number; m: Mask }[] = [];
    for (let i = 0; i < (u.canRotate ? steps : 1); i++) {
      const a = (i * 2 * Math.PI) / steps;
      const m = rasterize(rotatePaths(g.paths, cx, cy, a), g.boxes, cell, half, opts.holes);
      if (m) masks.push({ a, m });
    }
    return { u, cx, cy, masks, size: masks[0]?.m.cells || 0 };
  }).sort((a, b) => b.size - a.size); // größte Teile zuerst

  let placed = 0, failed = 0;
  for (const p of prepared) {
    let best: { a: number; m: Mask; x: number; y: number } | null = null;
    for (const { a, m } of p.masks) {
      const pos = grid.find(m, lo, hiX, hiY);
      if (!pos) continue;
      // Unten bleiben ist wichtiger als links – so wird das Bett von vorne her gefüllt
      const top = pos.y + m.rows, bestTop = best ? best.y + best.m.rows : Infinity;
      if (top < bestTop || (best && top === bestTop && pos.x + m.cols < best.x + best.m.cols)) best = { a, m, ...pos };
    }
    if (!best) { failed++; continue; }
    const { a, m, x, y } = best;
    if (a) p.u.members.forEach(s => rotateShape(s, p.cx, p.cy, a));
    const dx = x * cell - m.ox, dy = y * cell - m.oy;
    p.u.members.forEach(s => translateShape(s, dx, dy));
    grid.mark(m, x, y);
    placed++;
  }
  return { placed, failed, total: units.length };
}
