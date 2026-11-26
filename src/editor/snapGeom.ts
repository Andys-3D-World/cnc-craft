/**
 * FANG-GEOMETRIE: Schnittpunkte, Lotfußpunkte, Tangentenpunkte und Viertelpunkte – nur Rechnung (mit `npm test` prüfbar).
 * snap.ts holt sich hier die Punkte nahe der Maus.
 *
 * Alles wird in „Bausteine“ zerlegt: gerade Stücke (Linien, Polylinien, Rechtecke, geglättete Kurven) und echte
 * Kreise/Bögen (Kreis, Bogen) – die rechnen exakt, nicht über ihre Näherung als Vieleck.
 *
 *   Schnittpunkt   wo sich zwei Bausteine kreuzen (auch zwei Stücke derselben Form, nur nicht zwei Nachbarn)
 *   Lot            der Punkt auf einer Linie/einem Kreis, an dem die neue Linie (vom letzten Punkt aus) senkrecht steht
 *   Tangente       der Punkt auf einem Kreis/Bogen, an dem die neue Linie ihn berührt
 *   Viertelpunkt   0°, 90°, 180°, 270° auf Kreis und Bogen
 */
import { arcGeometry, shapeBounds, shapeToPaths, type Pt } from "../shapeTransform.ts";

export interface Seg { k: "seg"; a: Pt; b: Pt; id: string; i: number }
/** a0/sweep nur bei Bögen (Bogenmaß, sweep < 0 = im Uhrzeigersinn) */
export interface Circ { k: "circ"; c: Pt; r: number; a0?: number; sweep?: number; id: string }
export type Prim = Seg | Circ;

const EPS = 1e-9;

/** Abstand Punkt–Strecke */
export function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Bausteine aller Formen, die der Maus (at) näher als radius kommen. maxPts: zu große Formen auslassen */
export function primsNear(shapes: any[], at: Pt, radius: number, exclude?: Set<string>, maxPts = 4000): Prim[] {
  const out: Prim[] = [];
  for (const s of shapes) {
    if (exclude && exclude.has(s.id)) continue;
    if (s.type === "image" || s.type === "text") continue;
    const b = shapeBounds(s);
    if (!b || at.x < b.minX - radius || at.x > b.maxX + radius || at.y < b.minY - radius || at.y > b.maxY + radius) continue;
    if (s.type === "circle") {
      const r = Math.abs(s.w);
      if (Math.abs(Math.hypot(at.x - s.x, at.y - s.y) - r) <= radius) out.push({ k: "circ", c: { x: s.x, y: s.y }, r, id: s.id });
      continue;
    }
    if (s.type === "arc") {
      const g = arcGeometry(s);
      if (g) {
        if (Math.abs(Math.hypot(at.x - g.cx, at.y - g.cy) - g.r) <= radius) out.push({ k: "circ", c: { x: g.cx, y: g.cy }, r: g.r, a0: g.start, sweep: g.sweep, id: s.id });
        continue;
      }
    }
    let i = 0;
    for (const p of shapeToPaths(s)) {
      const pts = p.pts, n = pts.length;
      if (n > maxPts) { i += n; continue; }
      const m = p.closed ? n : n - 1;
      for (let j = 0; j < m; j++, i++) {
        const a = pts[j], q = pts[(j + 1) % n];
        if (segDist(at, a, q) <= radius) out.push({ k: "seg", a, b: q, id: s.id, i });
      }
      i++;
    }
  }
  return out;
}

/** Liegt der Winkel-Punkt pt auf dem Bogen? (volle Kreise: immer) */
export function onCirc(c: Circ, pt: Pt, tol = 1e-6): boolean {
  if (c.sweep === undefined || c.a0 === undefined || Math.abs(c.sweep) >= Math.PI * 2 - 1e-9) return true;
  const a = Math.atan2(pt.y - c.c.y, pt.x - c.c.x);
  const s = Math.sign(c.sweep) || 1;
  let d = (a - c.a0) * s;
  d = ((d % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const tolA = c.r > 0 ? tol / c.r + 1e-9 : tol;
  return d <= Math.abs(c.sweep) + tolA || d >= Math.PI * 2 - tolA;
}

function segSeg(p: Seg, q: Seg): Pt[] {
  const rx = p.b.x - p.a.x, ry = p.b.y - p.a.y, sx = q.b.x - q.a.x, sy = q.b.y - q.a.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < EPS) return []; // parallel (auch übereinander liegend: kein einzelner Punkt)
  const qx = q.a.x - p.a.x, qy = q.a.y - p.a.y;
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  const e = 1e-9;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return [];
  return [{ x: p.a.x + t * rx, y: p.a.y + t * ry }];
}

function segCirc(p: Seg, c: Circ): Pt[] {
  const dx = p.b.x - p.a.x, dy = p.b.y - p.a.y;
  const fx = p.a.x - c.c.x, fy = p.a.y - c.c.y;
  const A = dx * dx + dy * dy;
  if (A < EPS) return [];
  const B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - c.r * c.r;
  let disc = B * B - 4 * A * C;
  if (disc < -EPS * A) return [];
  disc = Math.max(0, disc);
  const sq = Math.sqrt(disc);
  const ts = disc === 0 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  const out: Pt[] = [];
  for (const t of ts) {
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    const pt = { x: p.a.x + t * dx, y: p.a.y + t * dy };
    if (onCirc(c, pt)) out.push(pt);
  }
  return out;
}

function circCirc(a: Circ, b: Circ): Pt[] {
  const dx = b.c.x - a.c.x, dy = b.c.y - a.c.y, d = Math.hypot(dx, dy);
  if (d < EPS || d > a.r + b.r + 1e-9 || d < Math.abs(a.r - b.r) - 1e-9) return [];
  const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.r * a.r - x * x));
  const mx = a.c.x + (dx * x) / d, my = a.c.y + (dy * x) / d;
  const pts = h < 1e-9 ? [{ x: mx, y: my }] : [{ x: mx - (dy * h) / d, y: my + (dx * h) / d }, { x: mx + (dy * h) / d, y: my - (dx * h) / d }];
  return pts.filter(p => onCirc(a, p) && onCirc(b, p));
}

/** Schnittpunkte zweier Bausteine */
export function intersect(p: Prim, q: Prim): Pt[] {
  if (p.k === "seg" && q.k === "seg") return segSeg(p, q);
  if (p.k === "seg" && q.k === "circ") return segCirc(p, q);
  if (p.k === "circ" && q.k === "seg") return segCirc(q, p);
  return circCirc(p as Circ, q as Circ);
}

const same = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

/** Alle Schnittpunkte zwischen den Bausteinen. Nachbarstücke derselben Form (gemeinsamer Eckpunkt) zählen nicht */
export function allIntersections(prims: Prim[], max = 400): Pt[] {
  const list = prims.length > max ? prims.slice(0, max) : prims;
  const out: Pt[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const p = list[i], q = list[j];
      if (p.id === q.id && p.k === "seg" && q.k === "seg" && (same(p.a, q.a) || same(p.a, q.b) || same(p.b, q.a) || same(p.b, q.b))) continue;
      if (p.id === q.id && (p.k === "circ" || q.k === "circ")) continue;
      for (const pt of intersect(p, q)) out.push(pt);
    }
  }
  return out;
}

/** Lotfußpunkte vom Punkt from auf die Bausteine (nur innerhalb der Strecke bzw. des Bogens) */
export function perpFeet(prims: Prim[], from: Pt): Pt[] {
  const out: Pt[] = [];
  for (const p of prims) {
    if (p.k === "seg") {
      const dx = p.b.x - p.a.x, dy = p.b.y - p.a.y, l2 = dx * dx + dy * dy;
      if (l2 < EPS) continue;
      const t = ((from.x - p.a.x) * dx + (from.y - p.a.y) * dy) / l2;
      if (t < -1e-9 || t > 1 + 1e-9) continue;
      const f = { x: p.a.x + t * dx, y: p.a.y + t * dy };
      if (Math.hypot(f.x - from.x, f.y - from.y) > 1e-6) out.push(f);
    } else {
      const dx = from.x - p.c.x, dy = from.y - p.c.y, d = Math.hypot(dx, dy);
      if (d < 1e-9) continue;
      for (const k of [1, -1]) {
        const f = { x: p.c.x + (k * p.r * dx) / d, y: p.c.y + (k * p.r * dy) / d };
        if (Math.hypot(f.x - from.x, f.y - from.y) > 1e-6 && onCirc(p, f)) out.push(f);
      }
    }
  }
  return out;
}

/** Tangentenpunkte vom Punkt from an Kreise und Bögen (from muss außerhalb liegen) */
export function tangentPts(prims: Prim[], from: Pt): Pt[] {
  const out: Pt[] = [];
  for (const p of prims) {
    if (p.k !== "circ") continue;
    const dx = from.x - p.c.x, dy = from.y - p.c.y, d = Math.hypot(dx, dy);
    if (d <= p.r + 1e-9) continue;
    const base = Math.atan2(dy, dx), alpha = Math.acos(p.r / d);
    for (const a of [base + alpha, base - alpha]) {
      const t = { x: p.c.x + p.r * Math.cos(a), y: p.c.y + p.r * Math.sin(a) };
      if (onCirc(p, t)) out.push(t);
    }
  }
  return out;
}

/** Viertelpunkte (0°, 90°, 180°, 270°) eines Kreises oder Bogens */
export function quadrants(c: Circ): Pt[] {
  return [[1, 0], [0, 1], [-1, 0], [0, -1]]
    .map(([x, y]) => ({ x: c.c.x + x * c.r, y: c.c.y + y * c.r }))
    .filter(p => onCirc(c, p));
}
