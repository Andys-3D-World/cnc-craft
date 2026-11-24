/**
 * RE-IMPORT A DRAWING – matching (no UI, no DOM; tests in tests/reimport.test.ts, applying: reimportApply.ts)
 *
 * A drawing was changed in the CAD program and is read again. Which shape of the project belongs to which shape of
 * the new file? Only geometry comes from the file, everything set on a shape in CNC Craft stays.
 *
 * Frames: "file" = the drawing as the file has it, in drawing pixels (mm × 2, Y up). Every placed part has its own
 * transform M (file → bed): move, turn, mirror, uniform scale.
 *
 * 1. Where does each part lie? Shapes imported since this exists carry `imp` (origin record): three points of the
 *    shape in the file frame, so M comes out exactly, however the part was moved. Shapes of older projects have only
 *    `source` (file name): M is found by laying the new drawing over the part (`alignPool`). Shapes that share one M
 *    form a "cluster" (one placed drawing or part); copies, a second import and other beds are clusters of their own.
 * 2. Was the whole drawing moved in the file (new origin)? Then the parts stay where they lie on the bed.
 * 3. In each cluster: same curve at the same place = unchanged. The rest by handle/id – but only if handles have
 *    proven stable (many programs number them anew on every export) – and then by layer, size and place.
 * 4. Two equally good candidates are never guessed: "unclear", the shape stays as it is unless the user chooses.
 *
 * Layer names and handles are text from a foreign file: only compared here, never put into HTML.
 */
import { compose, invert, applyPt, controlPoints, fitRigid, isLinked, applyRigid, IDENT, type Mat } from "./linkedCopies.ts";
import { cloneShape, isClosedShape, scaleShape, shapeToPaths, MM_TO_PIXEL, type Pt } from "./shapeTransform.ts";

// =====================================================================
// ORIGIN RECORD ("imp")
// =====================================================================

/** How a contour was cut from a 3D model (to offer the same settings again) */
export interface MeshCut { v: string; h: number; p: number; holes: boolean; feat: boolean }

export interface ImpData {
  f: string;        // import run: two imports of the same file are told apart
  k?: string[];     // handles/ids of the file's elements this contour was made of
  l?: string;       // layer
  r: number[];      // reference points x,y … in the file frame (circle: centre)
  i: number[];      // their point numbers
  n: number;        // number of points (circle 0)
  len: number;      // length of the curve and
  area: number;     // enclosed area, in the file frame
  d?: number;       // milling depth that came from the file (3D model with detected pockets)
  m?: MeshCut;
}

export interface ImpMeta { f: string; k?: string[]; l?: string; d?: number; m?: MeshCut }

const r4 = (v: number) => { const n = Math.round(v * 1e4) / 1e4; return n === 0 ? 0 : n; };
const MAX_KEYS = 12;
const cutText = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : "");

/** Keys/layer from a foreign file: short strings only */
export function cleanKeys(k: unknown): string[] | undefined {
  if (!Array.isArray(k)) return undefined;
  const out = [...new Set(k.map(x => cutText(x, 60)).filter(Boolean))].sort().slice(0, MAX_KEYS);
  return out.length ? out : undefined;
}

function cleanMesh(m: any): MeshCut | undefined {
  if (!m || typeof m !== "object" || !["top", "front", "left", "bottom", "back", "right"].includes(m.v)) return undefined;
  const h = Number(m.h), p = Number(m.p);
  if (!Number.isFinite(h) || !Number.isFinite(p) || p <= 0) return undefined;
  return { v: m.v, h, p, holes: m.holes !== false, feat: m.feat === true };
}

/** Origin record from a project file (untrusted): complete and sane, else null */
export function cleanImp(v: any): ImpData | null {
  if (!v || typeof v !== "object" || typeof v.f !== "string" || !v.f || v.f.length > 40) return null;
  if (!Array.isArray(v.r) || !Array.isArray(v.i) || v.r.length !== v.i.length * 2 || v.i.length < 1 || v.i.length > 3) return null;
  if (!v.r.every((x: any) => typeof x === "number" && Number.isFinite(x)) || !v.i.every((x: any) => Number.isInteger(x) && x >= 0)) return null;
  if (!Number.isInteger(v.n) || v.n < 0 || !Number.isFinite(v.len) || !Number.isFinite(v.area)) return null;
  const k = cleanKeys(v.k), l = cutText(v.l, 120), m = cleanMesh(v.m);
  return { f: v.f, r: v.r, i: v.i, n: v.n, len: v.len, area: v.area, ...(k ? { k } : {}), ...(l ? { l } : {}), ...(Number.isFinite(v.d) ? { d: v.d } : {}), ...(m ? { m } : {}) };
}

/** Write the origin record of a shape. `toFile` = transform bed → file (null: the shape already is in the file frame) */
export function stampImport(shape: any, toFile: Mat | null, meta: ImpMeta): void {
  const g = geoOf(shape, toFile);
  if (!g) { delete shape.imp; return; }
  const pts = g.circle ? [{ x: g.circle.x, y: g.circle.y }] : controlPoints(shape).map(p => (toFile ? applyPt(toFile, p) : p));
  if (!pts.length) { delete shape.imp; return; }
  // first point, the one farthest from it, and the one farthest from the line between them
  const idx = [0];
  let best = 1e-6, at = -1;
  pts.forEach((p, i) => { const d = Math.hypot(p.x - pts[0].x, p.y - pts[0].y); if (d > best) { best = d; at = i; } });
  if (at > 0) {
    idx.push(at);
    const a = pts[0], b = pts[at], len = best;
    let b2 = 1e-3, at2 = -1;
    pts.forEach((p, i) => { const d = Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len; if (d > b2) { b2 = d; at2 = i; } });
    if (at2 > 0) idx.push(at2);
  }
  const k = cleanKeys(meta.k), l = cutText(meta.l, 120);
  shape.imp = {
    f: meta.f, ...(k ? { k } : {}), ...(l ? { l } : {}),
    r: idx.flatMap(i => [r4(pts[i].x), r4(pts[i].y)]), i: idx, n: g.circle ? 0 : pts.length, len: r4(g.len), area: r4(g.area),
    ...(meta.d !== undefined ? { d: meta.d } : {}), ...(meta.m ? { m: meta.m } : {})
  } satisfies ImpData;
}

// =====================================================================
// GEOMETRY OF ONE SHAPE
// =====================================================================

export interface Geo {
  circle: { x: number; y: number; r: number } | null;
  pts: Pt[];
  closed: boolean;
  len: number; area: number;
  cx: number; cy: number;      // centre of the box
  size: number;                // diagonal of the box
  box: [number, number, number, number];
}

const scaleOf = (m: Mat) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

/** Geometry of a shape, seen through `m` (null = as it is) */
export function geoOf(s: any, m: Mat | null): Geo | null {
  const path = shapeToPaths(s)[0];
  if (!path || path.pts.length < 2) return null;
  const pts = m ? path.pts.map(p => applyPt(m, p)) : path.pts;
  let len = 0, area = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    if (i < n - 1 || path.closed) len += Math.hypot(q.x - p.x, q.y - p.y);
    area += p.x * q.y - q.x * p.y;
  }
  if (!Number.isFinite(x0 + x1 + y0 + y1)) return null;
  const g: Geo = {
    circle: null, pts, closed: path.closed, len, area: path.closed ? Math.abs(area / 2) : 0,
    cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, size: Math.hypot(x1 - x0, y1 - y0), box: [x0, y0, x1, y1]
  };
  if (s.type === "circle") {
    const c = m ? applyPt(m, { x: s.x, y: s.y }) : { x: s.x, y: s.y };
    const r = Math.abs(s.w) * (m ? scaleOf(m) : 1);
    g.circle = { ...c, r };
    g.cx = c.x; g.cy = c.y; g.len = 2 * Math.PI * r; g.area = Math.PI * r * r; g.size = 2 * r * Math.SQRT2;
    g.box = [c.x - r, c.y - r, c.x + r, c.y + r];
  }
  return g;
}

/** Same curve at the same place (0.02 mm) */
export const CURVE_TOL = 0.04;

function distToCurve(p: Pt, g: Geo): number {
  if (g.circle) return Math.abs(Math.hypot(p.x - g.circle.x, p.y - g.circle.y) - g.circle.r);
  let best = Infinity;
  const n = g.pts.length, last = g.closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = g.pts[i], b = g.pts[(i + 1) % n], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const ex = a.x + dx * u - p.x, ey = a.y + dy * u - p.y, d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Cheap: can these be the same curve (same kind, length, area), wherever they lie? */
export function sameForm(a: Geo, b: Geo, tol = CURVE_TOL): boolean {
  if (a.closed !== b.closed) return false;
  const lt = Math.max(6 * tol, 0.004 * Math.max(a.len, b.len));
  if (Math.abs(a.len - b.len) > lt) return false;
  return Math.abs(a.area - b.area) <= Math.max(4 * tol * tol, tol * Math.max(a.len, b.len));
}

export function sameCurve(a: Geo, b: Geo, tol = CURVE_TOL): boolean {
  if (a.closed !== b.closed) return false;
  for (let i = 0; i < 4; i++) if (Math.abs(a.box[i] - b.box[i]) > tol * 1.5) return false;
  if (a.circle && b.circle) return Math.hypot(a.circle.x - b.circle.x, a.circle.y - b.circle.y) <= tol && Math.abs(a.circle.r - b.circle.r) <= tol;
  if (!sameForm(a, b, tol)) return false;
  if (a.pts.length === b.pts.length && a.pts.every((p, i) => Math.abs(p.x - b.pts[i].x) <= tol && Math.abs(p.y - b.pts[i].y) <= tol)) return true;
  const near = (x: Geo, y: Geo) => {
    const step = Math.max(1, Math.floor(x.pts.length / 160));
    for (let i = 0; i < x.pts.length; i += step) if (distToCurve(x.pts[i], y) > tol) return false;
    return true;
  };
  return near(a, b) && near(b, a);
}

/** Does this curve of the file still look like the shape did when it was imported? */
function likeImported(imp: ImpData, g: Geo, tol: number): boolean {
  if (Math.abs(imp.len - g.len) > Math.max(6 * tol, 0.004 * g.len) || Math.abs(imp.area - g.area) > Math.max(1, tol * g.len)) return false;
  if (!imp.n) return !!g.circle && Math.hypot(imp.r[0] - g.circle.x, imp.r[1] - g.circle.y) <= tol;
  for (let i = 0; i < imp.i.length; i++) if (distToCurve({ x: imp.r[2 * i], y: imp.r[2 * i + 1] }, g) > tol) return false;
  return true;
}

// =====================================================================
// TRANSFORMS
// =====================================================================

/** Turn + move + mirror + uniform scale that carries `from` onto `to`, point by point (null = none) */
export function fitSimilar(from: Pt[], to: Pt[], tol: number): Mat | null {
  const n = from.length;
  if (!n || n !== to.length) return null;
  let fx = 0, fy = 0, tx = 0, ty = 0;
  for (let i = 0; i < n; i++) { fx += from[i].x; fy += from[i].y; tx += to[i].x; ty += to[i].y; }
  fx /= n; fy /= n; tx /= n; ty /= n;
  const go = (sg: number): Mat | null => {
    let sxx = 0, sxy = 0, suu = 0;
    for (let i = 0; i < n; i++) {
      const ux = sg * (from[i].x - fx), uy = from[i].y - fy, vx = to[i].x - tx, vy = to[i].y - ty;
      sxx += ux * vx + uy * vy; sxy += ux * vy - uy * vx; suu += ux * ux + uy * uy;
    }
    let k = suu > 1e-9 ? Math.hypot(sxx, sxy) / suu : 1;
    if (!(k > 1e-6)) return null;
    if (Math.abs(k - 1) < 1e-5) k = 1; // rounding of the reference points, not a scale
    let ang = suu > 1e-9 ? Math.atan2(sxy, sxx) : 0;
    const q = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(ang - q) < 1e-6) ang = q;
    const clean = (v: number) => (Math.abs(v) < 1e-12 ? 0 : Math.abs(v - 1) < 1e-12 ? 1 : Math.abs(v + 1) < 1e-12 ? -1 : v);
    const c = clean(Math.cos(ang)) * k, s = clean(Math.sin(ang)) * k;
    const m: Mat = [sg * c, sg * s, -s, c, 0, 0];
    m[4] = tx - (m[0] * fx + m[2] * fy); m[5] = ty - (m[1] * fx + m[3] * fy);
    for (let i = 0; i < n; i++) {
      const p = applyPt(m, from[i]);
      if (Math.hypot(p.x - to[i].x, p.y - to[i].y) > tol) return null;
    }
    return m;
  };
  return go(1) ?? go(-1);
}

export const scaleMat = (k: number): Mat => [k, 0, 0, k, 0, 0];

/** Place a shape of the file with M (in place, with the editor's own functions) */
export function applySimilar(s: any, m: Mat): any {
  const k = scaleOf(m);
  if (Math.abs(k - 1) > 1e-9) scaleShape(s, 0, 0, k, k);
  applyRigid(s, [m[0] / k, m[1] / k, m[2] / k, m[3] / k, m[4], m[5]]);
  return s;
}

const matKey = (m: Mat) => [0, 1, 2, 3].map(i => Math.round(m[i] * 2000)).join(",") + "|" + [4, 5].map(i => Math.round(m[i] * 10)).join(",");
const sameMat = (a: Mat, b: Mat) => a.every((v, i) => Math.abs(v - b[i]) < (i < 4 ? 1e-3 : 0.2));

// =====================================================================
// INPUT AND RESULT
// =====================================================================

/** One list of shapes of the project (a bed, or the hidden side of a bed). Pieces of a split part are not given */
export interface ReList { shapes: any[] }

/** Shapes of the new file in the file frame: like a normal import, `groupId` = part, `imp` = key/layer (stampImport) */
export interface PlanOptions {
  source: string;
  /** curve tolerance in pixels (3D models are cut into new triangles every time) */
  tol?: number;
  /** factor of the new file against the old one (unit in the file changed) and what to do about it */
  unit?: "before" | "file";
}

export type ItemKind = "same" | "changed" | "new" | "gone" | "edited" | "unclear";

export interface Item {
  id: number;
  kind: ItemKind;
  cluster: number;
  list: number;
  /** shape of the project (not for "new") */
  oldId?: string;
  /** index of the shape in the new file (not for "gone"/"unclear") */
  nu?: number;
  /** "unclear": indices of possible shapes of the file */
  cands?: number[];
  /** the candidate belongs to a shape that was edited in CNC Craft and changed in the file */
  conflict?: boolean;
  /** what differs: distance moved, size before/after, depth (all in mm) */
  moved?: number;
  size?: [number, number];
  /** width and height before and after, as drawn in the file (mm) */
  box?: [number, number, number, number];
  depth?: [number, number];
  /** only the depth changed, the contour is the same */
  depthOnly?: boolean;
  /** "new": a whole part that no placed part shows */
  part?: boolean;
}

export interface Cluster {
  list: number;
  /** file → bed */
  m: Mat;
  ids: string[];
  /** all shapes have an origin record */
  exact: boolean;
  /** several placements fit equally well: nothing is changed unless it matches exactly */
  ambiguous: boolean;
  /** the part lies elsewhere in the new file, it stays on the bed */
  movedInFile: boolean;
}

export interface Plan {
  clusters: Cluster[];
  items: Item[];
  /** indices of file shapes that are only candidates of unclear ones */
  openNew: { cluster: number; list: number; nu: number }[];
  /** nothing (or next to nothing) of the drawing was found in the file */
  different: boolean;
  /** the file is this many times larger than before (unit changed), 0 = no */
  unitFactor: number;
  /** placement factor (unit "file"): geometry of the file is placed this many times larger */
  grow: number;
  /** file shapes the plan refers to (scaled when the unit changed) */
  fresh: any[];
  keysUsed: boolean;
}

/** Shapes that take part: from this file, not a linked copy (it follows its original), not an image */
export function candidates(list: any[], source: string): any[] {
  return list.filter(s => s && s.source === source && !isLinked(s) && s.type !== "image" && !s.gen && shapeToPaths(s).length === 1);
}

const pushTo = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

interface Old { s: any; list: number; imp: ImpData | null; edited: boolean }
interface Clu { list: number; m: Mat; olds: Old[]; exact: boolean; ambiguous: boolean; movedInFile: boolean }
interface Fresh { s: any; g: Geo; imp: ImpData | null; part: string }

// =====================================================================
// 1. WHERE DO THE PARTS LIE?
// =====================================================================

const REF_TOL = 0.02; // px – the reference points are rounded to 1e-4

const refsOf = (o: Old): Pt[] => o.imp!.i.map((_, j) => ({ x: o.imp!.r[2 * j], y: o.imp!.r[2 * j + 1] }));

/** The same points on the shape as it lies now; null when it was changed in CNC Craft */
function refsNow(o: Old): Pt[] | null {
  const imp = o.imp!;
  if (!imp.n) return o.s.type === "circle" ? [{ x: o.s.x, y: o.s.y }] : null;
  const pts = controlPoints(o.s);
  if (o.s.type === "circle" || pts.length !== imp.n || imp.i.some(i => i >= pts.length)) return null;
  return imp.i.map(i => pts[i]);
}

/** Is the shape, placed with m, still exactly what was imported? */
function fits(o: Old, m: Mat): boolean {
  const now = refsNow(o);
  if (!now) return false;
  const k = scaleOf(m), refs = refsOf(o);
  if (!refs.every((p, i) => { const q = applyPt(m, p); return Math.hypot(q.x - now[i].x, q.y - now[i].y) <= REF_TOL * Math.max(1, k); })) return false;
  const g = geoOf(o.s, null);
  return !!g && Math.abs(g.len - o.imp!.len * k) <= 0.02 + 1e-4 * g.len && Math.abs(g.area - o.imp!.area * k * k) <= 0.05 + 1e-4 * g.area;
}

/** Own transform of one shape (needs at least two reference points) */
function ownFit(o: Old): Mat | null {
  const now = refsNow(o);
  if (!now || now.length < 2) return null;
  const m = fitSimilar(refsOf(o), now, REF_TOL);
  return m && fits(o, m) ? m : null;
}

/** Best common transform of shapes with an origin record; `given` = transforms already found nearby */
function commonFit(list: Old[], given: Mat[]): { m: Mat; hit: Old[] } | null {
  let best: { m: Mat; hit: Old[] } | null = null;
  const take = (m: Mat | null) => {
    if (!m) return;
    const hit = list.filter(o => fits(o, m));
    if (hit.length > (best?.hit.length ?? 0)) best = { m, hit };
  };
  // all together (exact when nothing was changed)
  const sound = list.filter(o => refsNow(o));
  if (sound.length) take(fitSimilar(sound.flatMap(refsOf), sound.flatMap(o => refsNow(o)!), REF_TOL));
  if ((best as any)?.hit.length === list.length) return best;
  for (const m of given) take(m);
  for (const o of sound.filter(x => x.imp!.i.length > 2).slice(0, 24)) take(ownFit(o));
  if (!best || (best as any).hit.length < Math.min(3, list.length)) {
    // only circles and straight lines: pairs
    const few = sound.slice(0, 10);
    for (let i = 0; i < few.length; i++) for (let j = i + 1; j < few.length; j++) {
      const f = [...refsOf(few[i]), ...refsOf(few[j])], n = [...refsNow(few[i])!, ...refsNow(few[j])!];
      const m = fitSimilar(f, n, REF_TOL);
      if (!m) continue;
      take(m);
      if (f.length === 2) { // two points: the mirrored variant fits as well
        const mir = fitSimilar([...f.map(p => ({ x: -p.x, y: p.y }))], n, REF_TOL);
        if (mir) take(compose(mir, [-1, 0, 0, 1, 0, 0]));
      }
    }
  }
  return best;
}

/** Clusters of shapes that carry an origin record */
function clustersFromRecords(olds: Old[]): Clu[] {
  const out: Clu[] = [];
  const byRun = new Map<string, Old[]>();
  for (const o of olds) pushTo(byRun, o.list + "|" + o.imp!.f, o);
  for (const run of byRun.values()) {
    const given: Mat[] = [];
    const placed: { o: Old; m: Mat }[] = [];
    const units = new Map<string, Old[]>();
    for (const o of run) pushTo(units, o.s.groupId ? "g" + o.s.groupId : "s" + o.s.id, o);
    const loose: Old[] = [];
    for (const unit of units.values()) {
      if (unit.length === 1 && unit[0].imp!.i.length < 3) { loose.push(unit[0]); continue; }
      const c = commonFit(unit, given);
      if (!c) { loose.push(...unit); continue; }
      if (!given.some(m => sameMat(m, c.m))) given.push(c.m);
      const hit = new Set(c.hit);
      for (const o of unit) {
        if (hit.has(o)) { placed.push({ o, m: c.m }); continue; }
        // moved by hand within its part: turn/mirror as the part, its own place
        const own = ownFit(o);
        if (own && o.imp!.i.length > 2) { placed.push({ o, m: own }); continue; }
        const now = refsNow(o);
        if (now) {
          const p = applyPt(c.m, refsOf(o)[0]);
          const m: Mat = [c.m[0], c.m[1], c.m[2], c.m[3], c.m[4] + now[0].x - p.x, c.m[5] + now[0].y - p.y];
          if (fits(o, m)) { placed.push({ o, m }); continue; }
        }
        o.edited = true;
        placed.push({ o, m: c.m });
      }
    }
    // circles and straight lines without a part: they have no direction of their own – look for a common place
    let rest = loose;
    while (rest.length) {
      const c = commonFit(rest, given);
      // one lone circle gives no direction and no scale: keep the turn of the other parts only if it fits there
      const ok = c && (c.hit.length > 1 || given.some(m => sameMat(m, c.m)));
      if (!ok) break;
      const hit = new Set(c!.hit);
      if (!given.some(m => sameMat(m, c!.m))) given.push(c!.m);
      for (const o of rest) if (hit.has(o)) placed.push({ o, m: c!.m });
      rest = rest.filter(o => !hit.has(o));
    }
    for (const o of rest) {
      const now = refsNow(o);
      const m: Mat = now ? [1, 0, 0, 1, now[0].x - refsOf(o)[0].x, now[0].y - refsOf(o)[0].y] : given[0] ?? IDENT;
      const own = ownFit(o);
      if (own) placed.push({ o, m: own });
      else { o.edited = !fits(o, m); placed.push({ o, m }); }
    }
    // same transform → same cluster; a second shape with the same origin at the same place is a copy on top of it
    const map = new Map<string, Clu>();
    const seen = new Map<string, number>();
    for (const { o, m } of placed) {
      let base = matKey(m);
      for (const c of map.values()) if (sameMat(c.m, m)) { base = matKey(c.m); break; }
      const sig = base + "§" + o.imp!.r.join(",") + "|" + (o.imp!.k ?? []).join(",") + "|" + o.imp!.len;
      const nth = seen.get(sig) ?? 0;
      seen.set(sig, nth + 1);
      const key = base + "#" + nth;
      if (!map.has(key)) map.set(key, { list: o.list, m, olds: [], exact: true, ambiguous: false, movedInFile: false });
      map.get(key)!.olds.push(o);
    }
    out.push(...map.values());
  }
  return out;
}

/** Old shape as seen from the file (m⁻¹) */
const seenFrom = (o: Old, m: Mat) => geoOf(o.s, invert(m));

/** Grid over the centres of the file shapes, to find the same curve quickly */
class Finder {
  private cells = new Map<string, number[]>();
  private list: Fresh[];
  private step: number;
  constructor(list: Fresh[], step = 8) {
    this.list = list;
    this.step = step;
    list.forEach((f, i) => pushTo(this.cells, this.key(f.g.cx, f.g.cy), i));
  }
  private key(x: number, y: number) { return Math.round(x / this.step) + "," + Math.round(y / this.step); }
  /** Indices of shapes whose centre lies within about `tol` */
  near(x: number, y: number, tol: number): number[] {
    const a = Math.round(x / this.step), b = Math.round(y / this.step), out: number[] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const k of this.cells.get(a + i + "," + (b + j)) ?? []) {
      const g = this.list[k].g;
      if (Math.abs(g.cx - x) <= tol && Math.abs(g.cy - y) <= tol) out.push(k);
    }
    return out.sort((p, q) => p - q);
  }
}

/** How many old shapes lie on a file shape when the drawing is placed with m; `order` counts pairs in file order */
function score(olds: Old[], geos: Geo[], m: Mat, fresh: Fresh[], find: Finder, tol: number): { n: number; order: number; hit: Map<Old, number> } {
  const inv = invert(m), used = new Set<number>(), hit = new Map<Old, number>();
  let order = 0, last = -1;
  olds.forEach((o, i) => {
    const g = geos[i];
    const c = applyPt(inv, { x: g.cx, y: g.cy });
    // the box centre moves with a turn unless the turn is by 90°: take the exact geometry then
    const square = Math.abs(m[0] * m[1]) < 1e-9;
    const gi = square ? { cx: c.x, cy: c.y } : geoOf(o.s, inv)!;
    const k = find.near(gi.cx, gi.cy, 3 * tol).find(j => !used.has(j) && sameForm(g, fresh[j].g, tol) && Math.abs(scaleOf(m) - 1) < 1e-6 && sameCurve(square ? geoOf(o.s, inv)! : gi as Geo, fresh[j].g, tol));
    if (k === undefined) return;
    used.add(k);
    hit.set(o, k);
    if (k > last) order++;
    last = k;
  });
  return { n: hit.size, order, hit };
}

/** Placements (file → here) that could fit: from equal polylines point by point, and from pairs of equal shapes */
function guesses(olds: Old[], geos: Geo[], fresh: Fresh[], tol: number): Mat[] {
  const out: Mat[] = [], keys = new Set<string>();
  const max = olds.length > 800 ? 80 : 400;
  const add = (m: Mat | null) => { if (!m || out.length >= max) return; const k = matKey(m); if (!keys.has(k)) { keys.add(k); out.push(m); } };
  const partners = geos.map(g => fresh.map((f, j) => (sameForm(g, f.g, tol) ? j : -1)).filter(j => j >= 0));
  // rare and large shapes say most
  const rank = olds.map((_, i) => i).filter(i => partners[i].length).sort((a, b) => partners[a].length - partners[b].length || geos[b].size - geos[a].size);
  for (const i of rank.slice(0, 40)) {
    if (geos[i].circle) continue;
    for (const j of partners[i].slice(0, 12)) {
      if (fresh[j].g.circle) continue;
      const a = controlPoints(fresh[j].s), b = controlPoints(olds[i].s);
      if (a.length === b.length && a.length > 2) add(fitRigid(a, b, tol));
    }
  }
  // pairs of centres far apart
  const top = rank.slice(0, 14);
  const pairs: [number, number][] = [];
  for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++) pairs.push([top[a], top[b]]);
  pairs.sort((p, q) => partners[p[0]].length * partners[p[1]].length - partners[q[0]].length * partners[q[1]].length);
  for (const [a, b] of pairs.slice(0, 30)) {
    const d = Math.hypot(geos[a].cx - geos[b].cx, geos[a].cy - geos[b].cy);
    if (d < 1) continue;
    // a box centre only moves along exactly for circles; other shapes: turns by 90° are found this way too
    for (const p of partners[a].slice(0, 16)) for (const q of partners[b].slice(0, 16)) {
      if (p === q) continue;
      const fp = fresh[p].g, fq = fresh[q].g;
      if (Math.abs(Math.hypot(fp.cx - fq.cx, fp.cy - fq.cy) - d) > 2 * tol) continue;
      const from = [{ x: fp.cx, y: fp.cy }, { x: fq.cx, y: fq.cy }], to = [{ x: geos[a].cx, y: geos[a].cy }, { x: geos[b].cx, y: geos[b].cy }];
      add(fitRigid(from, to, 2 * tol));
      const mir = fitRigid(from.map(v => ({ x: -v.x, y: v.y })), to, 2 * tol);
      if (mir) add(compose(mir, [-1, 0, 0, 1, 0, 0]));
    }
  }
  // only moved
  for (const i of top) for (const j of partners[i].slice(0, 12)) add([1, 0, 0, 1, geos[i].cx - fresh[j].g.cx, geos[i].cy - fresh[j].g.cy]);
  return out;
}

/** Frame around the file (corner points) – to see how far apart two placements put it */
function corners(fresh: Fresh[]): Pt[] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of fresh) { x0 = Math.min(x0, f.g.box[0]); y0 = Math.min(y0, f.g.box[1]); x1 = Math.max(x1, f.g.box[2]); y1 = Math.max(y1, f.g.box[3]); }
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x0, y: y1 }];
}

/** Two placements that explain the same shapes but put the drawing somewhere else (half a millimetre or more) */
function rivals(a: { m: Mat; hit: Map<Old, number> }, b: { m: Mat; hit: Map<Old, number> }, frame: Pt[]): boolean {
  if (![...a.hit.keys()].some(o => b.hit.has(o))) return false;
  return frame.some(p => { const u = applyPt(a.m, p), v = applyPt(b.m, p); return Math.hypot(u.x - v.x, u.y - v.y) > 1; });
}

interface Placed { m: Mat; n: number; order: number; hit: Map<Old, number>; tie: boolean }

/** Best placement of the file over these shapes; `claimed` = file shapes already shown elsewhere (only breaks ties) */
function bestPlacement(olds: Old[], geos: Geo[], known: Mat[], tries: Mat[], fresh: Fresh[], find: Finder, tol: number, claimed = new Set<number>()): Placed | null {
  let best: (Placed & { free: number; known: number }) | null = null;
  const frame = corners(fresh);
  for (const [m, kn] of [...known.map(m => [m, 1] as const), ...tries.map(m => [m, 0] as const)]) {
    const r = score(olds, geos, m, fresh, find, tol);
    if (!r.n) continue;
    const free = [...r.hit.values()].filter(j => !claimed.has(j)).length;
    const d: number = best ? r.n - best.n || kn - best.known || r.order - best.order || free - best.free : 1;
    if (d > 0) best = { m, ...r, free, known: kn, tie: false };
    else if (d === 0 && !best!.tie && rivals({ m, hit: r.hit }, best!, frame)) best!.tie = true;
    if (best && best.n === olds.length && best.order === olds.length && best.free === olds.length) break; // every shape, in file order
  }
  if (best && !best.tie && !best.known) {
    // only circles round one centre: the placement's turn is unknown
    const cs = [...best.hit.keys()].map(o => geoOf(o.s, null)!);
    if (cs.every(g => g.circle && Math.hypot(g.cx - cs[0].cx, g.cy - cs[0].cy) < 1e-3)) best.tie = true;
  }
  return best;
}

/** Clusters of shapes without an origin record: lay the drawing over them */
function alignPool(olds: Old[], fresh: Fresh[], find: Finder, tol: number): { clusters: Clu[]; left: Old[] } {
  const clusters: Clu[] = [];
  let rest = olds;
  const claimed = new Set<number>();
  const groupKey = (o: Old) => o.s.groupId || o.s.id;
  while (rest.length) {
    const geos = rest.map(o => geoOf(o.s, null)!);
    const best = bestPlacement(rest, geos, clusters.map(c => c.m), guesses(rest, geos, fresh, tol), fresh, find, tol, claimed);
    if (!best) break;
    const inGroup = new Set([...best.hit.keys()].map(groupKey));
    const members = rest.filter(o => inGroup.has(groupKey(o)));
    if (best.n === 1 && members.length === 1) {
      // one shape alone lies on any shape of its form: that only counts when there is a single one of it
      const g = geoOf(members[0].s, null)!;
      const one = fresh.filter(f => sameForm(g, f.g, tol)).length === 1 && rest.filter(o => sameForm(g, geoOf(o.s, null)!, tol)).length === 1;
      if (!one || (clusters.length && (g.circle || claimed.has([...best.hit.values()][0])))) break;
    }
    for (const j of best.hit.values()) claimed.add(j);
    clusters.push({ list: rest[0].list, m: best.m, olds: members, exact: false, ambiguous: best.tie, movedInFile: false });
    rest = rest.filter(o => !inGroup.has(groupKey(o)));
  }
  // nothing in common left: with exactly one placement known they belong to it
  if (rest.length && clusters.length === 1 && !clusters[0].ambiguous) { clusters[0].olds.push(...rest); rest = []; }
  return { clusters, left: rest };
}

// =====================================================================
// 2. THE PLAN
// =====================================================================

const layerOf = (f: ImpData | null) => f?.l ?? "";
function sharedKeys(a?: string[], b?: string[]): boolean {
  if (!a?.length || !b?.length) return false;
  const set = new Set(b);
  return a.filter(k => set.has(k)).length * 2 >= Math.max(1, Math.min(a.length, b.length)) && a.some(k => set.has(k));
}

function buildFresh(shapes: any[], k: number): { list: Fresh[]; shapes: any[] } {
  const scaled = k === 1 ? shapes : shapes.map(s => {
    const c = cloneShape(s);
    scaleShape(c, 0, 0, k, k);
    if (c.imp) stampImport(c, null, { f: c.imp.f, k: c.imp.k, l: c.imp.l, d: c.imp.d, m: c.imp.m });
    return c;
  });
  const list: Fresh[] = [];
  scaled.forEach(s => {
    const g = geoOf(s, null);
    if (g) list.push({ s, g, imp: cleanImp(s.imp), part: s.groupId || "s:" + s.id });
  });
  return { list, shapes: list.map(f => f.s) };
}

/** Units that programs mix up: inch, cm, m, foot */
const UNIT_FACTORS = [25.4, 1 / 25.4, 10, 0.1, 1000, 0.001, 304.8, 1 / 304.8];

/**
 * Compare the project with the file read again. `lists` = all shape lists that may hold shapes of this file,
 * `file` = shapes of the new file in the file frame.
 */
export function planReimport(lists: ReList[], file: any[], opt: PlanOptions): Plan {
  const tol = opt.tol ?? CURVE_TOL;
  const base = planWith(lists, buildFresh(file, 1), tol, opt.source);
  const sameOf = (p: Plan) => p.items.filter(i => i.kind === "same" || i.kind === "edited").length;
  const total = new Set(base.items.map(i => i.oldId).filter(Boolean)).size;
  if (total && sameOf(base) < 0.2 * total) {
    for (const k of UNIT_FACTORS) {
      const p = planWith(lists, buildFresh(file, 1 / k), tol, opt.source);
      if (p.different || sameOf(p) < Math.max(1, 0.5 * total)) continue;
      // a single shape may be 10× larger for good reasons – two shapes of the same factor are a unit
      if (total < 2 && file.length < 2) continue;
      p.unitFactor = k;
      if (opt.unit === "file") {
        p.grow = k;
        for (const i of p.items) if (i.kind === "same") {
          const o = lists[i.list].shapes.find(s => s.id === i.oldId), g = o && geoOf(o, null);
          i.kind = "changed";
          delete i.depthOnly;
          delete i.box;
          const d = g && (g.circle ? 2 * g.circle.r : g.size) / MM_TO_PIXEL;
          if (d) i.size = [d, d * k];
        }
      }
      return p;
    }
  }
  return base;
}

function planWith(lists: ReList[], built: { list: Fresh[]; shapes: any[] }, tol: number, source: string): Plan {
  const fresh = built.list, find = new Finder(fresh);
  const plan: Plan = { clusters: [], items: [], openNew: [], different: false, unitFactor: 0, grow: 1, fresh: built.shapes, keysUsed: false };
  let nextId = 0;
  const add = (i: Omit<Item, "id">) => { plan.items.push({ id: nextId++, ...i }); };

  // ---- clusters ----
  const clus: Clu[] = [], lost: Old[] = [];
  lists.forEach((l, li) => {
    const olds: Old[] = candidates(l.shapes, source).filter(s => geoOf(s, null)).map(s => ({ s, list: li, imp: cleanImp(s.imp), edited: false }));
    clus.push(...clustersFromRecords(olds.filter(o => o.imp)));
    const p = alignPool(olds.filter(o => !o.imp), fresh, find, tol);
    clus.push(...p.clusters);
    lost.push(...p.left);
  });

  // ---- exact matches, and: was the drawing moved in the file? ----
  type Work = { c: Clu; ci: number; inv: Mat; geo: Map<Old, Geo>; pair: Map<Old, number>; used: Set<number>; kept: Set<Old> };
  const exactPairs = (c: Clu, m: Mat): { pair: Map<Old, number>; kept: Set<Old>; geo: Map<Old, Geo> } => {
    const pair = new Map<Old, number>(), kept = new Set<Old>(), used = new Set<number>(), geo = new Map<Old, Geo>();
    const pick = (o: Old, list: number[]) => {
      const free = list.filter(j => !used.has(j));
      const j = free.find(x => sharedKeys(o.imp?.k, fresh[x].imp?.k)) ?? free.find(x => layerOf(o.imp) === layerOf(fresh[x].imp)) ?? free[0];
      if (j === undefined) return false;
      used.add(j); pair.set(o, j);
      return true;
    };
    for (const o of c.olds) {
      const g = seenFrom(o, m);
      if (!g) continue;
      geo.set(o, g);
      pick(o, find.near(g.cx, g.cy, 3 * tol).filter(j => sameCurve(g, fresh[j].g, tol)));
    }
    // edited in CNC Craft, but the file still has it as it was imported
    for (const o of c.olds) if (o.edited && !pair.has(o) && !c.movedInFile) {
      if (pick(o, fresh.map((_, j) => j).filter(j => !used.has(j) && likeImported(o.imp!, fresh[j].g, tol)))) kept.add(o);
    }
    return { pair, kept, geo };
  };

  const work: Work[] = clus.map((c, ci) => {
    let ex = exactPairs(c, c.m);
    if (c.exact && ex.pair.size < 0.5 * c.olds.length) {
      // the shapes as they were in the old file, against the new file
      const inv = invert(c.m);
      const back: Old[] = c.olds.filter(o => !o.edited).map(o => { const s = cloneShape(o.s); applySimilar(s, inv); return { ...o, s }; });
      const geos = back.map(o => geoOf(o.s, null)!);
      const best = back.length ? bestPlacement(back, geos, [], guesses(back, geos, fresh, tol), fresh, find, tol) : null;
      if (best && !best.tie && best.n > ex.pair.size && best.n >= 0.5 * c.olds.length) {
        c.m = compose(c.m, best.m);
        c.movedInFile = !sameMat(best.m, IDENT);
        ex = exactPairs(c, c.m);
      }
    }
    return { c, ci, inv: invert(c.m), geo: ex.geo, pair: ex.pair, used: new Set(ex.pair.values()), kept: ex.kept };
  });
  plan.clusters = clus.map(c => ({ list: c.list, m: c.m, ids: c.olds.map(o => o.s.id), exact: c.exact, ambiguous: c.ambiguous, movedInFile: c.movedInFile }));

  // ---- are handles stable? judged by the shapes that are certainly the same ----
  let both = 0, equal = 0;
  for (const w of work) for (const [o, j] of w.pair) if (o.imp?.k && fresh[j].imp?.k) { both++; if (sharedKeys(o.imp.k, fresh[j].imp!.k)) equal++; }
  plan.keysUsed = both >= 2 && equal >= 0.9 * both;
  const keyIndex = new Map<string, number[]>();
  fresh.forEach((f, j) => { for (const k of f.imp?.k ?? []) pushTo(keyIndex, k, j); });

  const moved = new Map<Work, Map<Old, number>>();
  for (const w of work) {
    const map = new Map<Old, number>();
    moved.set(w, map);
    if (!plan.keysUsed || w.c.ambiguous) continue;
    for (const o of w.c.olds) {
      if (w.pair.has(o) || !o.imp?.k) continue;
      const list = [...new Set(o.imp.k.flatMap(k => keyIndex.get(k) ?? []))].filter(j => !w.used.has(j) && sharedKeys(o.imp!.k, fresh[j].imp?.k) && fresh[j].g.closed === isClosedShape(o.s));
      if (list.length !== 1) continue;
      // numbers given in file order match by chance when something was replaced: on another layer it must lie near by
      const g = w.geo.get(o), n = fresh[list[0]].g;
      if (layerOf(o.imp) !== layerOf(fresh[list[0]].imp) && g && Math.hypot(g.cx - n.cx, g.cy - n.cy) > 0.35 * Math.max(g.size, n.size)) continue;
      w.used.add(list[0]);
      map.set(o, list[0]);
    }
  }

  // ---- the rest by layer, size and place ----
  const partsOf = (w: Work) => new Set([...w.pair.values(), ...moved.get(w)!.values()].map(j => fresh[j].part));
  const shownParts = work.map(partsOf);
  const anywhere = new Set(shownParts.flatMap(s => [...s]));
  const layersNow = new Set(fresh.map(f => layerOf(f.imp)));
  const unclearNew = work.map(() => new Set<number>());
  // a hole moved by hand in CNC Craft is a cluster of its own, but still belongs to its part: same group on the same bed
  const siblings = work.map(w => {
    const groups = new Set(w.c.olds.map(o => o.s.groupId).filter(Boolean));
    return work.filter(x => x !== w && x.c.list === w.c.list && x.c.olds.some(o => o.s.groupId && groups.has(o.s.groupId)));
  });
  const usedNear = (wi: number, j: number) => work[wi].used.has(j) || siblings[wi].some(x => x.used.has(j));

  work.forEach((w, wi) => {
    const { c } = w;
    const map = moved.get(w)!;
    const O = c.olds.filter(o => !w.pair.has(o) && !map.has(o));
    const N = fresh.map((_, j) => j).filter(j => !usedNear(wi, j) && (shownParts[wi].has(fresh[j].part) || !anywhere.has(fresh[j].part)));
    let diag = 1, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const g of w.geo.values()) { x0 = Math.min(x0, g.box[0]); y0 = Math.min(y0, g.box[1]); x1 = Math.max(x1, g.box[2]); y1 = Math.max(y1, g.box[3]); }
    if (x1 > x0 || y1 > y0) diag = Math.hypot(x1 - x0, y1 - y0);
    // a part that no placed part shows yet: only what lies within this drawing can have come from it
    const reach = (n: Geo) => n.cx >= x0 - 0.2 * diag && n.cx <= x1 + 0.2 * diag && n.cy >= y0 - 0.2 * diag && n.cy <= y1 + 0.2 * diag;
    const cost = (o: Old, j: number): number => {
      const g = w.geo.get(o), n = fresh[j].g;
      if (!g || g.closed !== n.closed || (!shownParts[wi].has(fresh[j].part) && !reach(n))) return Infinity;
      const lo = layerOf(o.imp), ln = layerOf(fresh[j].imp);
      if (o.imp && lo !== ln && layersNow.has(lo)) return Infinity;
      const dist = Math.hypot(g.cx - n.cx, g.cy - n.cy) / diag;
      if (o.imp && lo !== ln && dist > 0.12) return Infinity;
      if (sameForm(g, n, tol)) return dist;
      const sizeRel = Math.abs(Math.log(Math.max(n.size, 1e-6) / Math.max(g.size, 1e-6)));
      const lenRel = Math.abs(Math.log(Math.max(n.len, 1e-6) / Math.max(g.len, 1e-6)));
      if (sizeRel > Math.log(3) || lenRel > Math.log(4)) return Infinity;
      // moved and resized at once: only near by, and only when the size is not far off
      const far = Math.hypot(g.cx - n.cx, g.cy - n.cy) > 0.35 * Math.max(g.size, n.size);
      if (far && (dist > 0.12 || sizeRel > Math.log(1.6))) return Infinity;
      return dist + 0.15 * (sizeRel + lenRel) + (far ? 0.05 : 0);
    };
    let o2 = O;
    const n2 = new Set(N);
    const table = new Map<Old, Map<number, number>>();
    for (const o of O) {
      const row = new Map<number, number>();
      for (const j of N) { const v = cost(o, j); if (v < Infinity) row.set(j, v); }
      table.set(o, row.size > 24 ? new Map([...row].sort((a, b) => a[1] - b[1]).slice(0, 24)) : row);
    }
    if (!c.ambiguous) for (let changed = true; changed;) {
      changed = false;
      for (const o of o2) {
        const row = [...table.get(o)!].filter(([j]) => n2.has(j)).sort((a, b) => a[1] - b[1]);
        if (!row.length) continue;
        const [j, v] = row[0];
        const clear = (second: number | undefined) => second === undefined || second >= 1.6 * v + 0.004;
        if (!clear(row[1]?.[1])) continue;
        const col = o2.filter(x => x !== o).map(x => table.get(x)!.get(j) ?? Infinity);
        if (!clear(col.length ? Math.min(...col) : undefined)) continue;
        map.set(o, j);
        w.used.add(j);
        o2 = o2.filter(x => x !== o);
        n2.delete(j);
        changed = true;
      }
    }
    for (const o of o2) {
      const row = [...table.get(o)!].filter(([j]) => n2.has(j)).sort((a, b) => a[1] - b[1]).slice(0, 8).map(([j]) => j);
      if (row.length || (c.ambiguous && n2.size)) {
        row.forEach(j => unclearNew[wi].add(j));
        add({ kind: "unclear", cluster: wi, list: c.list, oldId: o.s.id, cands: row });
      } else if (o.edited) add({ kind: "edited", cluster: wi, list: c.list, oldId: o.s.id });
      else if (c.ambiguous) add({ kind: "unclear", cluster: wi, list: c.list, oldId: o.s.id, cands: [] });
      else add({ kind: "gone", cluster: wi, list: c.list, oldId: o.s.id });
    }
  });

  // ---- results ----
  const describe = (o: Old, g: Geo | undefined, j: number, k: number): Partial<Item> => {
    const n = fresh[j].g;
    if (!g) return {};
    const d = (Math.hypot(g.cx - n.cx, g.cy - n.cy) * k) / MM_TO_PIXEL;
    const a = g.circle && n.circle ? 2 * g.circle.r : g.size, b = g.circle && n.circle ? 2 * n.circle.r : n.size;
    return { ...(d > 0.01 ? { moved: d } : {}), ...(Math.abs(a - b) * k > 0.02 ? { size: [(a * k) / MM_TO_PIXEL, (b * k) / MM_TO_PIXEL] as [number, number] } : {}), ...depthOf(o, j),
      box: [g.box[2] - g.box[0], g.box[3] - g.box[1], n.box[2] - n.box[0], n.box[3] - n.box[1]].map(v => (v * k) / MM_TO_PIXEL) as [number, number, number, number] };
  };
  /** Depth that came from the model: follows the file as long as nobody set another one */
  const depthOf = (o: Old, j: number): Partial<Item> => {
    const was = o.imp?.d, now = fresh[j].imp?.d;
    if (was === undefined || now === undefined || Math.abs(was - now) < 1e-6 || Math.abs(Number(o.s.millingDepth) - was) > 1e-6) return {};
    return { depth: [was, now] };
  };
  work.forEach((w, wi) => {
    const map = moved.get(w)!, k = scaleOf(w.c.m);
    for (const [o, j] of w.pair) {
      if (w.kept.has(o)) { add({ kind: "edited", cluster: wi, list: w.c.list, oldId: o.s.id, nu: j }); continue; }
      const dep = depthOf(o, j);
      add({ kind: dep.depth ? "changed" : "same", cluster: wi, list: w.c.list, oldId: o.s.id, nu: j, ...dep, ...(dep.depth ? { depthOnly: true } : {}) });
    }
    for (const [o, j] of map) {
      // changed on both sides: never overwrite the user's own edit without asking
      if (o.edited) { unclearNew[wi].add(j); add({ kind: "unclear", cluster: wi, list: w.c.list, oldId: o.s.id, cands: [j], conflict: true }); continue; }
      add({ kind: "changed", cluster: wi, list: w.c.list, oldId: o.s.id, nu: j, ...describe(o, w.geo.get(o), j, k) });
    }
  });
  // drawings that could not be laid over the file at all stay as they are
  lost.forEach(o => add({ kind: "unclear", cluster: -1, list: o.list, oldId: o.s.id, cands: [] }));

  // new shapes: in every placed part that shows this part of the file; whole new parts once (or in every full copy)
  const finalParts = work.map(partsOf);
  const count = (wi: number, part: string) => { let n = 0; for (const j of [...work[wi].pair.values(), ...moved.get(work[wi])!.values()]) if (fresh[j].part === part) n++; return n; };
  // who shows this part (a single hole moved by hand does not)
  const owners = new Map<string, number[]>();
  for (const part of new Set(finalParts.flatMap(x => [...x]))) {
    const n = work.map((_, wi) => count(wi, part)), top = Math.max(...n);
    owners.set(part, work.map((_, wi) => wi).filter(wi => {
      if (!n[wi] || 2 * n[wi] < top) return false;
      return !siblings[wi].some(x => { const k = work.indexOf(x); return n[k] > n[wi] || (n[k] === n[wi] && k < wi); });
    }));
  }
  const shown = new Set(finalParts.flatMap(s => [...s]));
  const allParts = new Set(fresh.map(f => f.part));
  const oldParts = [...allParts].filter(p => shown.has(p));
  const matchedAnywhere = new Set(work.flatMap(w => [...w.pair.values(), ...moved.get(w)!.values()]));
  const main = work.map((w, i) => ({ i, n: w.pair.size + moved.get(w)!.size, l: w.c.list })).filter(x => !work[x.i].c.ambiguous).sort((a, b) => b.n - a.n || a.l - b.l)[0]?.i ?? -1;
  fresh.forEach((f, j) => {
    if (shown.has(f.part)) {
      work.forEach((w, wi) => {
        if (!owners.get(f.part)!.includes(wi) || usedNear(wi, j)) return;
        if (unclearNew[wi].has(j) || w.c.ambiguous) { plan.openNew.push({ cluster: wi, list: w.c.list, nu: j }); return; }
        add({ kind: "new", cluster: wi, list: w.c.list, nu: j });
      });
      return;
    }
    const open = work.findIndex((_, wi) => unclearNew[wi].has(j));
    if (open >= 0) { plan.openNew.push({ cluster: open, list: work[open].c.list, nu: j }); return; }
    if (matchedAnywhere.has(j) || main < 0) return;
    const full = oldParts.length > 1 ? work.map((_, i) => i).filter(i => !work[i].c.ambiguous && finalParts[i].size > 0.5 * oldParts.length) : [];
    for (const i of full.length ? full : [main]) add({ kind: "new", cluster: i, list: work[i].c.list, nu: j, part: true });
  });

  const oldN = plan.items.filter(i => i.oldId).length;
  const same = plan.items.filter(i => i.kind === "same" || (i.kind === "edited" && i.nu !== undefined)).length;
  const chg = plan.items.filter(i => i.kind === "changed").length;
  plan.different = oldN > 0 && !same && (chg < 0.5 * oldN || chg < 0.4 * fresh.length);
  return plan;
}

export function countKinds(p: Plan, only?: (i: Item) => boolean): Record<ItemKind, number> {
  const n: Record<ItemKind, number> = { same: 0, changed: 0, new: 0, gone: 0, edited: 0, unclear: 0 };
  for (const i of p.items) if (!only || only(i)) n[i.kind]++;
  return n;
}
