/**
 * DOPPELTE LINIEN ENTFERNEN (Rechnung, Tests in tests/dedupe.test.ts)
 *
 * Geschlossene Formen werden nur ganz entfernt, wenn eine andere dieselbe Form hat (auch andersherum gezeichnet oder mit
 * anderem Startpunkt). Sie werden nie aufgebrochen: Zwei Rechtecke mit gemeinsamer Kante bleiben Teile mit außen/innen.
 * Offene Linien verlieren die Stücke, die schon auf einer anderen Linie liegen; was übrig bleibt, bleibt als Teilstück.
 * Längere Linien bleiben stehen, kürzere fallen weg; bei gleicher Länge bleibt die zuerst gezeichnete.
 */
import type { Path, Pt } from "../shapeTransform.ts";
import { pathLength, slicePath, type Span } from "./trim.ts";

export interface DedupeItem<T> { ref: T; path: Path }
export interface DedupeResult<T> {
  removeWhole: T[];
  trims: { ref: T; keep: Span[]; path: Path }[];
  removed: Path[]; // was wegfällt, für die Vorschau
}

type Seg = [Pt, Pt];

function bboxOf(p: Path) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of p.pts) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); }
  return { minX, minY, maxX, maxY };
}

function area(pts: Pt[]) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return Math.abs(a) / 2;
}

function segsOf(p: Path): Seg[] {
  const v = p.closed ? [...p.pts, p.pts[0]] : p.pts;
  const out: Seg[] = [];
  for (let i = 1; i < v.length; i++) out.push([v[i - 1], v[i]]);
  return out;
}

function distToSeg(q: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(a.x + u * dx - q.x, a.y + u * dy - q.y);
}

/** Raster über die schon behaltenen Strecken: schnelle Frage „was liegt hier in der Nähe?“ */
class SegGrid {
  private cells = new Map<string, Seg[]>();
  private cell: number;
  constructor(size: number) { this.cell = Math.max(1, size / 200); }
  private each(a: Pt, b: Pt, pad: number, fn: (k: string) => void) {
    const c = this.cell;
    const x0 = Math.floor((Math.min(a.x, b.x) - pad) / c), x1 = Math.floor((Math.max(a.x, b.x) + pad) / c);
    const y0 = Math.floor((Math.min(a.y, b.y) - pad) / c), y1 = Math.floor((Math.max(a.y, b.y) + pad) / c);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) fn(x + "," + y);
  }
  add(s: Seg) { this.each(s[0], s[1], 0, k => { const l = this.cells.get(k); if (l) l.push(s); else this.cells.set(k, [s]); }); }
  near(a: Pt, b: Pt, pad: number): Set<Seg> {
    const out = new Set<Seg>();
    this.each(a, b, pad, k => this.cells.get(k)?.forEach(s => out.add(s)));
    return out;
  }
}

/** Liegt jeder Punkt von a auf der Kontur b? */
function pointsOn(a: Path, bSegs: Seg[], tol: number): boolean {
  return a.pts.every(q => bSegs.some(s => distToSeg(q, s[0], s[1]) <= tol));
}

/** Stücke der Kontur (als Stationen), die auf schon behaltenen Strecken liegen; zusammengefasst und sortiert */
function coveredSpans(p: Path, grid: SegGrid, tol: number): Span[] {
  const spans: Span[] = [];
  let run = 0;
  for (const [a, b] of segsOf(p)) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    for (const [c, d] of grid.near(a, b, tol)) {
      const uc = ((c.x - a.x) * dx + (c.y - a.y) * dy) / (len * len), ud = ((d.x - a.x) * dx + (d.y - a.y) * dy) / (len * len);
      const lo = Math.max(0, Math.min(uc, ud)), hi = Math.min(1, Math.max(uc, ud));
      if (hi <= lo) continue;
      const pLo = { x: a.x + dx * lo, y: a.y + dy * lo }, pHi = { x: a.x + dx * hi, y: a.y + dy * hi };
      if (distToSeg(pLo, c, d) <= tol && distToSeg(pHi, c, d) <= tol) spans.push({ from: run + lo * len, to: run + hi * len });
    }
    run += len;
  }
  spans.sort((x, y) => x.from - y.from);
  const merged: Span[] = [];
  // Kleine Lücken zwischen zwei Treffern schließen: Vielecke treffen sich nicht auf den hundertstel Millimeter
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.from <= last.to + tol) last.to = Math.max(last.to, s.to);
    else merged.push({ ...s });
  }
  // Winzige Treffer sind nur Berührungen an einem Kreuzungspunkt
  return merged.filter(s => s.to - s.from > 4 * tol);
}

export function findDuplicates<T>(items: DedupeItem<T>[], tol: number): DedupeResult<T> {
  const result: DedupeResult<T> = { removeWhole: [], trims: [], removed: [] };
  const usable = items.filter(i => i.path.pts.length >= 2);
  if (!usable.length) return result;
  let size = 1;
  for (const i of usable) { const b = bboxOf(i.path); size = Math.max(size, b.maxX - b.minX, b.maxY - b.minY); }
  const grid = new SegGrid(size);

  // Reihenfolge: geschlossene zuerst (größte zuerst), dann offene (längste zuerst); gleiche behalten ihre Reihenfolge
  const closed = usable.filter(i => i.path.closed).map(i => ({ i, a: area(i.path.pts), len: pathLength(i.path), box: bboxOf(i.path), segs: segsOf(i.path) }));
  closed.sort((x, y) => y.a - x.a);
  const keptClosed: typeof closed = [];
  for (const c of closed) {
    const same = keptClosed.some(k =>
      Math.abs(k.len - c.len) <= 4 * tol * Math.max(1, c.segs.length / 8)
      && Math.abs(k.box.minX - c.box.minX) <= tol && Math.abs(k.box.maxX - c.box.maxX) <= tol
      && Math.abs(k.box.minY - c.box.minY) <= tol && Math.abs(k.box.maxY - c.box.maxY) <= tol
      && pointsOn(c.i.path, k.segs, tol) && pointsOn(k.i.path, c.segs, tol));
    if (same) { result.removeWhole.push(c.i.ref); result.removed.push(c.i.path); continue; }
    keptClosed.push(c);
    c.segs.forEach(s => grid.add(s));
  }

  const open = usable.filter(i => !i.path.closed).map(i => ({ i, len: pathLength(i.path) })).sort((x, y) => y.len - x.len);
  for (const { i, len } of open) {
    const covered = coveredSpans(i.path, grid, tol);
    if (!covered.length) { segsOf(i.path).forEach(s => grid.add(s)); continue; }
    const keep: Span[] = [];
    let at = 0;
    for (const s of covered) { if (s.from - at > 4 * tol) keep.push({ from: at, to: s.from }); at = Math.max(at, s.to); }
    if (len - at > 4 * tol) keep.push({ from: at, to: len });
    covered.forEach(s => result.removed.push({ pts: slicePath(i.path, s), closed: false }));
    if (!keep.length) { result.removeWhole.push(i.ref); continue; }
    result.trims.push({ ref: i.ref, keep, path: i.path });
    keep.forEach(s => { const pts = slicePath(i.path, s); for (let k = 1; k < pts.length; k++) grid.add([pts[k - 1], pts[k]]); });
  }
  return result;
}
