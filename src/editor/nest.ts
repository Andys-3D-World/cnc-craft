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
  rotate: "none" | "90" | "45" | "auto"; // auto = alle 15° + Winkel mit kleinstem Kasten
  holes: boolean;      // kleine Teile dürfen in Löcher großer Teile
  anchor: NestAnchor;  // wo das erste Teil hinkommt
  dir: NestDir;        // in welche Richtung es weitergeht
}

/** t/m/b = oben/Mitte/unten, l/c/r = links/Mitte/rechts */
export type NestAnchor = "tl" | "tc" | "tr" | "ml" | "mc" | "mr" | "bl" | "bc" | "br";
export type NestDir = "right" | "left" | "up" | "down";
export const NEST_ANCHORS: NestAnchor[] = ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"];

/** Richtung, die von diesem Startpunkt aus in die Wand zeigen würde, ist nicht erlaubt */
export function nestDirAllowed(a: NestAnchor, d: NestDir): boolean {
  return !((a[1] === "l" && d === "left") || (a[1] === "r" && d === "right") || (a[0] === "t" && d === "up") || (a[0] === "b" && d === "down"));
}

/** failedIds: Formen der Teile, die nicht mehr aufs Bett gepasst haben (sie bleiben, wo sie waren) */
export interface NestResult { placed: number; failed: number; total: number; failedIds: string[] }

/** Diese Formen lassen sich ohne Verlust drehen (Bilder z. B. nicht) */
const ROTATABLE = new Set(["polyline", "circle", "arc", "line", "rect"]);

/** hint: letzte Fundstelle beim Suchen – gleiche Teile (Kopien) teilen sich das, das spart viel Zeit */
interface Mask {
  cols: number; rows: number; runs: [number, number][][]; ox: number; oy: number; cells: number;
  hint: { x: number; y: number; none: boolean };
}
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
      // gleich große Teile (z. B. Kopien übereinander) gehören nicht ineinander
      if (merged.has(j) || u.area >= v.area * 0.999 || !inside(u.b, v.b) || pathAreaMax(v.members) <= 0) continue;
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
  return { cols, rows, runs, ox, oy, cells, hint: { x: 0, y: 0, none: false } };
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

/** Drehwinkel, bei dem das Teil den kleinsten Kasten braucht (eine Kante der konvexen Hülle liegt dann waagerecht) */
function minBoxAngle(paths: Paths): number {
  const pts = paths.flatMap(p => p.pts).slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return 0;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let bestA = 0, bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length];
    const a = -Math.atan2(q.y - p.y, q.x - p.x);
    const c = Math.cos(a), s = Math.sin(a);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const h of hull) {
      const x = h.x * c - h.y * s, y = h.x * s + h.y * c;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area < bestArea - 1e-6) { bestArea = area; bestA = a; }
  }
  return bestA;
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
  /** Stößt die Maske an (x,y) an etwas Belegtes? */
  hits(m: Mask, x: number, y: number): boolean {
    for (let r = 0; r < m.rows; r++) {
      const row = y + r;
      if (row < 0 || row >= this.rows) { if (m.runs[r].length) return true; continue; }
      for (const [a, b] of m.runs[r]) {
        if (x + a < 0 || x + b >= this.cols) return true;
        if (this.pre[row][x + b + 1] - this.pre[row][x + a] > 0) return true;
      }
    }
    return false;
  }
  /** Unterste, dann linkeste freie Stelle im Bereich lo … hi */
  find(m: Mask, lo: number, hiX: number, hiY: number): { x: number; y: number } | null {
    // Das Bett wird nur voller: vor der letzten Fundstelle derselben Maske kann nichts mehr frei sein
    const h = m.hint;
    if (h.none) return null;
    for (let y = Math.max(lo, h.y); y + m.rows <= hiY; y++) {
      let x = y === h.y ? Math.max(lo, h.x) : lo;
      while (x + m.cols <= hiX) {
        let jump = -1;
        for (let r = 0; r < m.rows && jump < 0; r++) {
          const pre = this.pre[y + r], last = this.last[y + r];
          for (const [a, b] of m.runs[r]) {
            if (pre[x + b + 1] - pre[x + a] > 0) { jump = last[x + b] - a + 1; break; }
          }
        }
        if (jump < 0) { h.x = x; h.y = y; return { x, y }; }
        x = jump;
      }
    }
    h.none = true;
    return null;
  }
}

// ---------------------------------------------------------------------
// Hauptfunktion
// ---------------------------------------------------------------------

/** only: diese Formen verschachteln (sonst Auswahl, sonst alles) */
/**
 * only: diese Formen verschachteln (sonst Auswahl, sonst alles).
 * sets: mehrere Sätze (z. B. Original + Kopien, die noch übereinander liegen) – Teile werden je Satz gebildet,
 * sonst würde ein Loch aus Kopie 5 dem Teil aus Kopie 1 zugeordnet.
 */
export function nestShapes(opts: NestOptions, only?: any[], sets?: any[][]): NestResult {
  const st = app();
  const selIds = new Set<string>(st.selectedShapeIds);
  const list = only || (selIds.size ? st.shapes.filter((s: any) => selIds.has(s.id)) : st.shapes);
  const units = sets ? sets.flatMap(buildUnits) : buildUnits(list);
  if (!units.length) return { placed: 0, failed: 0, total: 0, failedIds: [] };

  const bed = bedSizeMm();
  const BW = bed.w * MM_TO_PIXEL, BH = bed.h * MM_TO_PIXEL;

  // Gerechnet wird immer „ab unten links, nach rechts“ in einem gedachten Bett. Für andere Startpunkte und
  // Richtungen wird das Bett dafür gespiegelt (mx, my) bzw. über Eck gedreht (tr = erst nach oben/unten).
  // „Mitte“: von einer Seite aus legen, danach den fertigen Block mittig schieben.
  const anchor: NestAnchor = NEST_ANCHORS.includes(opts.anchor) ? opts.anchor : "bl";
  const dir: NestDir = nestDirAllowed(anchor, opts.dir) ? opts.dir : (anchor[1] === "r" ? "left" : "right");
  const tr = dir === "up" || dir === "down";
  const mx = anchor[1] === "r" || (anchor[1] === "c" && dir === "left");
  const my = anchor[0] === "t" || (anchor[0] === "m" && dir === "down");
  const centerX = anchor[1] === "c", centerY = anchor[0] === "m";
  const tp = (q: Pt): Pt => {
    const x = mx ? BW - q.x : q.x, y = my ? BH - q.y : q.y;
    return tr ? { x: y, y: x } : { x, y };
  };
  const tPaths = (ps: Paths): Paths => ps.map(p => ({ closed: p.closed, pts: p.pts.map(tp) }));
  const tBoxes = (bs: Bounds[]): Bounds[] => bs.map(b => {
    const a = tp({ x: b.minX, y: b.minY }), c = tp({ x: b.maxX, y: b.maxY });
    return { minX: Math.min(a.x, c.x), minY: Math.min(a.y, c.y), maxX: Math.max(a.x, c.x), maxY: Math.max(a.y, c.y) };
  });
  /** Verschiebung im gedachten Bett → echte Verschiebung */
  const back = (dx: number, dy: number) => {
    const [x, y] = tr ? [dy, dx] : [dx, dy];
    return { x: mx ? -x : x, y: my ? -y : y };
  };

  // Raster: höchstens ca. 600 Zellen je Seite, aber nicht feiner als 0,25 mm
  const cell = Math.max(0.25, Math.max(bed.w, bed.h) / 600) * MM_TO_PIXEL;
  // + 0,05 mm je Seite: Rundung im Raster, damit der Abstand nie kleiner als eingestellt wird
  const half = (Math.max(0, opts.gapMm) / 2 + 0.05) * MM_TO_PIXEL;
  const VW = tr ? BH : BW, VH = tr ? BW : BH;
  const grid = new Bed(Math.floor(VW / cell), Math.floor(VH / cell));
  const obst = new Bed(grid.cols, grid.rows); // nur die Hindernisse – fürs mittige Schieben
  // Die Maske ist schon um den halben Abstand dicker → Rand entsprechend kleiner
  const lo = Math.max(0, Math.ceil((Math.max(0, opts.marginMm) * MM_TO_PIXEL - half) / cell));
  const hiX = grid.cols - lo, hiY = grid.rows - lo;

  // Formen, die liegen bleiben, sind Hindernisse
  const moving = new Set(units.flatMap(u => u.members.map(s => s.id)));
  for (const s of st.shapes as any[]) {
    if (moving.has(s.id)) continue;
    const g = unitGeometry([s]);
    const m = rasterize(tPaths(g.paths), tBoxes(g.boxes), cell, half, opts.holes);
    if (!m) continue;
    // liegt nicht genau auf dem Raster → auf beiden Nachbarzellen eintragen (lieber etwas zu viel Abstand)
    const gx = Math.floor(m.ox / cell), gy = Math.floor(m.oy / cell);
    for (const [ax, ay] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { grid.mark(m, gx + ax, gy + ay); obst.mark(m, gx + ax, gy + ay); }
  }

  const steps = opts.rotate === "auto" ? 24 : opts.rotate === "45" ? 8 : opts.rotate === "90" ? 4 : 1;
  // Gleiche Teile (z. B. Kopien vom Duplizieren) nur einmal rastern: Schlüssel = Form relativ zur Box-Ecke
  const cache = new Map<string, { b: Bounds; masks: { a: number; m: Mask }[] }>();
  const vShift = (dx: number, dy: number) => {
    const x = mx ? -dx : dx, y = my ? -dy : dy;
    return tr ? { x: y, y: x } : { x, y };
  };
  const prepared = units.map(u => {
    const g = unitGeometry(u.members);
    const b = groupBounds(u.members)!;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const r3 = (v: number) => Math.round(v * 1000);
    const key = u.members.map(s => s.type).join(",") + "|" + g.boxes.map(q => [q.minX - b.minX, q.minY - b.minY, q.maxX - b.minX, q.maxY - b.minY].map(r3).join(",")).join(";")
      + "|" + g.paths.map(p => (p.closed ? "c" : "o") + p.pts.map(q => r3(q.x - b.minX) + "," + r3(q.y - b.minY)).join(" ")).join(";");
    const hit = cache.get(key);
    if (hit) {
      const v = vShift(b.minX - hit.b.minX, b.minY - hit.b.minY);
      const masks = hit.masks.map(({ a, m }) => ({ a, m: { ...m, ox: m.ox + v.x, oy: m.oy + v.y } }));
      return { u, cx, cy, masks, size: masks[0]?.m.cells || 0 };
    }
    const masks: { a: number; m: Mask }[] = [];
    const angles: number[] = [];
    for (let i = 0; i < (u.canRotate ? steps : 1); i++) angles.push((i * 2 * Math.PI) / steps);
    if (u.canRotate && opts.rotate === "auto") {
      const best = minBoxAngle(g.paths);
      for (let k = 0; k < 4; k++) {
        const a = ((best + (k * Math.PI) / 2) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        if (angles.every(b => Math.abs(b - a) > 0.01)) angles.push(a);
      }
    }
    // ein einzelner Kreis sieht gedreht genauso aus
    if (u.members.length === 1 && u.members[0].type === "circle") angles.length = 1;
    for (const a of angles) {
      const m = rasterize(tPaths(rotatePaths(g.paths, cx, cy, a)), tBoxes(g.boxes), cell, half, opts.holes);
      if (m) masks.push({ a, m });
    }
    cache.set(key, { b, masks });
    return { u, cx, cy, masks, size: masks[0]?.m.cells || 0 };
  }).sort((a, b) => b.size - a.size); // größte Teile zuerst

  const failedIds: string[] = [];
  let failed = 0;
  const done: { members: any[]; m: Mask; x: number; y: number }[] = [];
  for (const p of prepared) {
    let best: { a: number; m: Mask; x: number; y: number } | null = null;
    for (const { a, m } of p.masks) {
      const pos = grid.find(m, lo, hiX, hiY);
      if (!pos) continue;
      // Unten bleiben ist wichtiger als links – so wird das Bett von vorne her gefüllt
      const top = pos.y + m.rows, bestTop = best ? best.y + best.m.rows : Infinity;
      if (top < bestTop || (best && top === bestTop && pos.x + m.cols < best.x + best.m.cols)) best = { a, m, ...pos };
    }
    if (!best) { failed++; failedIds.push(...p.u.members.map(s => s.id)); continue; }
    const { a, m, x, y } = best;
    if (a) p.u.members.forEach(s => rotateShape(s, p.cx, p.cy, a));
    const d = back(x * cell - m.ox, y * cell - m.oy);
    p.u.members.forEach(s => translateShape(s, d.x, d.y));
    grid.mark(m, x, y);
    done.push({ members: p.u.members, m, x, y });
  }

  // Startpunkt „Mitte“: fertigen Block mittig schieben – aber nur, wenn er dabei nirgends aneckt
  const cx = tr ? centerY : centerX, cy = tr ? centerX : centerY; // Achsen im gedachten Bett
  if (done.length && (cx || cy)) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of done) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x + q.m.cols); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y + q.m.rows); }
    const sx = cx ? Math.round((lo + hiX - x0 - x1) / 2) : 0;
    const sy = cy ? Math.round((lo + hiY - y0 - y1) / 2) : 0;
    if ((sx || sy) && !done.some(q => obst.hits(q.m, q.x + sx, q.y + sy))) {
      const d = back(sx * cell, sy * cell);
      done.forEach(q => q.members.forEach(s => translateShape(s, d.x, d.y)));
    }
  }
  return { placed: done.length, failed, total: units.length, failedIds };
}
