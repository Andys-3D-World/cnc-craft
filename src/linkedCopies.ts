/**
 * LINKED COPIES (series production: 20 identical parts on a sheet – change one hole in the original, all 20 follow)
 *
 * Data (all in the project file, older versions simply see normal shapes):
 *   copy:     `link = { of, m, h }`  of = id of the original shape (on any bed or side),
 *             m = rigid transform (move, turn, mirror) from the original's own frame to the copy,
 *             h = stamp of the original at the time the copy was last built (refresh only rebuilds when it changed).
 *   original: `linkFrame` (only when it was moved/turned/mirrored after copies were made) – its own frame,
 *             so moving the original does NOT move the copies.
 * Every copy is a complete, normal shape (points in world coordinates). CAM, nesting, simulation, split and the
 * G-code check therefore work on copies without knowing about links. Copies are rebuilt from the original:
 *   copy geometry = m ∘ frame⁻¹ ∘ original.
 *
 * Rules:
 *   - Move / turn / mirror a copy: free (the copy keeps its own place). Detected by fitting a rigid transform.
 *   - Any other change on a copy (nodes, size, settings): not allowed – the copy is rebuilt from the original and
 *     `blocked` is counted, so the editor can say "edit the original or unlink".
 *   - Change the original: every copy follows (geometry and all settings).
 *   - Original deleted (or missing): the copies become normal shapes (link removed).
 *   - A new shape that carries a link but is not a rigid image of the original (e.g. the result of offset or a
 *     boolean operation on a copy) loses the link.
 * Pure functions only (no DOM) – tests in tests/linkedCopies.test.ts.
 */
import { cloneShape, makeRectPoints, rotateShape, scaleShape, translateShape, type Pt } from "./shapeTransform.ts";

/** Affine 2D transform: x' = a·x + c·y + e, y' = b·x + d·y + f (rigid: [[a,c],[b,d]] is a rotation or a reflection) */
export type Mat = [number, number, number, number, number, number];

export const IDENT: Mat = [1, 0, 0, 1, 0, 0];

/** Tolerance in world pixels (1 mm = 2 px) for "this is the same shape, only moved" */
export const FIT_TOL = 0.002;

const tidy = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);

/** p ∘ q (first q, then p) */
export function compose(p: Mat, q: Mat): Mat {
  return [
    tidy(p[0] * q[0] + p[2] * q[1]), tidy(p[1] * q[0] + p[3] * q[1]),
    tidy(p[0] * q[2] + p[2] * q[3]), tidy(p[1] * q[2] + p[3] * q[3]),
    p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]
  ];
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [tidy(a), tidy(b), tidy(c), tidy(d), -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function applyPt(m: Mat, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function isIdent(m: Mat): boolean {
  return m.every((v, i) => Math.abs(v - IDENT[i]) < 1e-12);
}

/** Read a transform from untrusted data (project file): six finite numbers, rigid (orthonormal) – else null */
export function cleanMat(v: any): Mat | null {
  if (!Array.isArray(v) || v.length !== 6 || !v.every(x => typeof x === "number" && Number.isFinite(x))) return null;
  const [a, b, c, d, e, f] = v;
  if (Math.abs(a * a + b * b - 1) > 1e-6 || Math.abs(c * c + d * d - 1) > 1e-6 || Math.abs(a * c + b * d) > 1e-6) return null;
  if (Math.abs(e) > 1e7 || Math.abs(f) > 1e7) return null;
  return [a, b, c, d, e, f];
}

/** Own frame of an original (identity when it never moved after copies were made) */
export function frameOf(s: any): Mat {
  return cleanMat(s?.linkFrame) ?? IDENT;
}

/** Is this shape a linked copy? */
export function isLinked(s: any): boolean {
  return !!s && !!s.link && typeof s.link.of === "string";
}

/** Points that pin down where a shape lies, in a fixed order (same order before and after move/turn/mirror) */
export function controlPoints(s: any): Pt[] {
  switch (s?.type) {
    case "polyline":
    case "image":
      return Array.isArray(s.points) ? s.points : [];
    case "circle":
      return [{ x: s.x, y: s.y }];
    case "arc":
      return [{ x: s.x, y: s.y }, { x: s.x + s.w, y: s.y + s.h }, { x: s.midX, y: s.midY }];
    case "rect":
      return makeRectPoints(s.x, s.y, s.x + s.w, s.y + s.h);
    default:
      return [{ x: s?.x ?? 0, y: s?.y ?? 0 }, { x: (s?.x ?? 0) + (s?.w ?? 0), y: (s?.y ?? 0) + (s?.h ?? 0) }];
  }
}

/**
 * Rigid transform (turn + move, or mirror + turn + move) that carries the points `from` onto `to`, point by point.
 * null = there is none (different count, or the shape was changed in another way).
 */
export function fitRigid(from: Pt[], to: Pt[], tol = FIT_TOL): Mat | null {
  const n = from.length;
  if (!n || n !== to.length) return null;
  let fx = 0, fy = 0, tx = 0, ty = 0;
  for (let i = 0; i < n; i++) { fx += from[i].x; fy += from[i].y; tx += to[i].x; ty += to[i].y; }
  fx /= n; fy /= n; tx /= n; ty /= n;
  const tryFit = (mirror: boolean): Mat | null => {
    const sg = mirror ? -1 : 1;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const ux = sg * (from[i].x - fx), uy = from[i].y - fy, vx = to[i].x - tx, vy = to[i].y - ty;
      sxx += ux * vx + uy * vy;
      sxy += ux * vy - uy * vx;
    }
    let ang = Math.abs(sxx) + Math.abs(sxy) < 1e-12 ? 0 : Math.atan2(sxy, sxx);
    if (Math.abs(ang) < 1e-10) ang = 0;
    const c = tidy(Math.cos(ang)), s = tidy(Math.sin(ang));
    // R ∘ F with F = mirror x (x → −x)
    const a = sg * c, b = sg * s, cc = -s, d = c;
    const e = tx - (a * fx + cc * fy), f = ty - (b * fx + d * fy);
    const m: Mat = [a, b, cc, d, e, f];
    for (let i = 0; i < n; i++) {
      const p = applyPt(m, from[i]);
      if (Math.abs(p.x - to[i].x) > tol || Math.abs(p.y - to[i].y) > tol) return null;
    }
    return m;
  };
  return tryFit(false) ?? tryFit(true);
}

/** Move/turn/mirror a shape in place with a rigid transform – with the same functions the editor uses */
export function applyRigid(s: any, m: Mat) {
  const mirror = m[0] * m[3] - m[1] * m[2] < 0;
  const ang = mirror ? Math.atan2(-m[1], -m[0]) : Math.atan2(m[1], m[0]);
  if (mirror) scaleShape(s, 0, 0, -1, 1);
  if (Math.abs(ang) > 1e-12) rotateShape(s, 0, 0, ang);
  if (m[4] || m[5]) translateShape(s, m[4], m[5]);
}

/** Fields that belong to the copy itself, never taken from the original */
const OWN = new Set(["id", "groupId", "link", "linkFrame", "gen", "ngOut"]);
/** Fields that only describe where the shape lies (they follow the transform) */
const GEOM = new Set(["type", "points", "closed", "x", "y", "w", "h", "midX", "midY", "bez", "textPath", "rotation", "cutDir"]);

/** All settings of a shape (tool, depth, layer, tabs, text …) as one comparable text */
export function settingsKey(s: any): string {
  const keys = Object.keys(s).filter(k => !OWN.has(k) && !GEOM.has(k)).sort().map(k => [k, s[k]]);
  // a circle's radius is its shape, not its place (its control point is only the centre)
  if (s.type === "circle") keys.push(["~r", Math.abs(Number(s.w) || 0)]);
  return JSON.stringify(keys);
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Stamp of an original: its settings and its shape in its own frame (moving the original keeps the stamp) */
export function sourceStamp(src: any): string {
  const inv = invert(frameOf(src));
  const pts = controlPoints(src).map(p => applyPt(inv, p)).map(p => `${r4(p.x)},${r4(p.y)}`).join(";");
  const text = `${src.type}|${src.closed ? 1 : 0}|${pts}|${settingsKey(src)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + text.length.toString(36);
}

/**
 * Build a copy from its original: geometry and settings from `src`, id/group from `copy`, placed with `m`
 * (relative to the original's frame). Changes `copy` in place (keeps object references valid) and returns it.
 */
export function materialize(src: any, copy: any, m: Mat): any {
  const n = cloneShape(src);
  for (const k of OWN) delete n[k];
  n.id = copy.id;
  if (copy.groupId) n.groupId = copy.groupId;
  applyRigid(n, compose(m, invert(frameOf(src))));
  n.link = { of: src.id, m, h: sourceStamp(src) };
  for (const k of Object.keys(copy)) delete copy[k];
  Object.assign(copy, n);
  return copy;
}

/** Transform (relative to the original's frame) that places `src` exactly onto `copy` – null if it isn't a moved copy */
export function placementOf(src: any, copy: any): Mat | null {
  const A = fitRigid(controlPoints(src), controlPoints(copy));
  return A ? compose(A, frameOf(src)) : null;
}

/** Mark freshly made copies (clones of `sources`, same order) as linked: a copy of a copy links to the same original */
export function linkClones(sources: any[], clones: any[]) {
  clones.forEach((c, i) => {
    const s = sources[i];
    if (!s) return;
    delete c.linkFrame; delete c.gen; delete c.ngOut;
    c.link = { of: isLinked(s) ? s.link.of : s.id };
  });
}

/** Remove links (copies become normal shapes). Returns how many */
export function unlinkShapes(list: any[]): number {
  let n = 0;
  for (const s of list) if (s && s.link) { delete s.link; n++; }
  return n;
}

/** Remove link data from shapes that leave the drawing in another form (split pieces, other side …) */
export function stripLinks(list: any[]) {
  for (const s of list) if (s) { delete s.link; delete s.linkFrame; }
}

/** Project file: keep only clean link data (ids are strings, transforms rigid) */
export function cleanLinks(list: any[]) {
  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    if (s.link !== undefined) {
      const l = s.link, m = cleanMat(l?.m);
      if (!l || typeof l.of !== "string" || !l.of || l.of.length > 60 || l.of === s.id) delete s.link;
      else s.link = { of: l.of, ...(m ? { m } : {}), ...(typeof l.h === "string" && l.h.length <= 40 ? { h: l.h } : {}) };
    }
    if (s.linkFrame !== undefined && !cleanMat(s.linkFrame)) delete s.linkFrame;
  }
}

/** Ids of originals that copies in these lists refer to */
export function referencedIds(lists: any[][]): Set<string> {
  const out = new Set<string>();
  for (const l of lists) for (const s of l) if (isLinked(s)) out.add(s.link.of);
  return out;
}

export interface SyncResult {
  /** a copy was changed in a way that is not allowed (it was rebuilt from the original) */
  blocked: number;
  /** copies that became normal shapes because their original is gone */
  orphaned: number;
  /** something in `shapes` changed */
  changed: boolean;
}

const json = (s: any) => JSON.stringify(s);

/**
 * After a user action: bring copies and originals in `shapes` (the visible drawing) up to date.
 * before = the drawing before the action (history), others = shapes of the other beds/sides (originals may lie there).
 * Changes `shapes` in place.
 */
export function syncLinks(shapes: any[], before: any[], others: any[][] = []): SyncResult {
  const res: SyncResult = { blocked: 0, orphaned: 0, changed: false };
  const was = new Map<string, any>();
  for (const s of before) if (s && typeof s.id === "string") was.set(s.id, s);
  const lookup = new Map<string, any>();
  for (const l of others) for (const s of l) if (s) lookup.set(s.id, s);
  for (const s of shapes) lookup.set(s.id, s);
  const referenced = referencedIds([shapes, ...others]);

  // A "part" is a group (or a single shape): moving the whole part is a move, moving one hole of it is an edit.
  const unitOf = (s: any) => s.groupId || s.id;
  const canonical = (s: any) => { const inv = invert(frameOf(s)); return controlPoints(s).map(p => applyPt(inv, p)); };

  // 1. Originals that were moved/turned/mirrored as a whole part: their frame goes along (the copies stay put)
  const srcUnits = new Map<string, any[]>();
  for (const s of shapes) {
    if (isLinked(s) || !referenced.has(s.id) || !was.has(s.id)) continue;
    const k = unitOf(s);
    if (!srcUnits.has(k)) srcUnits.set(k, []);
    srcUnits.get(k)!.push(s);
  }
  for (const members of srcUnits.values()) {
    if (members.every(s => json(was.get(s.id)) === json(s))) continue;
    const R = fitRigid(members.flatMap(s => controlPoints(was.get(s.id))), members.flatMap(controlPoints));
    for (const s of members) {
      const old = was.get(s.id);
      const F = R ? compose(R, frameOf(old)) : frameOf(old);
      const prev = json(s.linkFrame);
      if (isIdent(F)) delete s.linkFrame; else s.linkFrame = F;
      if (json(s.linkFrame) !== prev) res.changed = true;
    }
  }

  // 2. Copies, per placed part: own move/turn/mirror is kept, everything else comes from the original
  const copyUnits = new Map<string, { c: any; src: any }[]>();
  for (const c of shapes) {
    if (!isLinked(c)) continue;
    const src = lookup.get(c.link.of);
    if (!src || src === c || isLinked(src)) { delete c.link; res.orphaned++; res.changed = true; continue; }
    const k = unitOf(c) + "|" + unitOf(src);
    if (!copyUnits.has(k)) copyUnits.set(k, []);
    copyUnits.get(k)!.push({ c, src });
  }
  for (const unit of copyUnits.values()) {
    const touched = unit.some(({ c }) => !was.has(c.id) || json(was.get(c.id)) !== json(c));
    const stored = unit.map(({ c }) => cleanMat(c.link.m));
    let m: Mat | null = null;
    if (touched || stored.some(x => !x)) {
      m = fitRigid(unit.flatMap(({ src }) => canonical(was.get(src.id) ?? src)), unit.flatMap(({ c }) => controlPoints(c)));
      if (m) {
        for (const { c, src } of unit) {
          const cOld = was.get(c.id);
          if (cOld && settingsKey(c) !== settingsKey(cOld) && settingsKey(c) !== settingsKey(src)) { res.blocked++; break; }
        }
      } else if (unit.some(({ c }) => was.has(c.id))) res.blocked++;
    }
    unit.forEach(({ c, src }, i) => {
      const mi = m ?? (was.has(c.id) ? stored[i] : null);
      if (!mi) { delete c.link; res.changed = true; return; } // new shape that is no copy of the original
      const sOld = was.get(src.id) ?? src;
      if (!m && !touched && json(sOld) === json(src)) return;
      const old = json(c);
      materialize(src, c, mi);
      if (json(c) !== old) res.changed = true;
    });
  }
  return res;
}

/** Comparable text of a value: keys sorted, numbers rounded to 1e-6 (float noise from turning back and forth) */
function canon(v: any): string {
  if (typeof v === "number") return String(Math.round(v * 1e6) / 1e6);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v) ?? "null";
}

/**
 * Without a "before" (project opened, bed switched, undo): rebuild only copies whose original changed since they
 * were last built (stamp `h`), remove links to missing originals. lookup = all shapes of all beds and sides.
 * Returns true if something in `list` changed.
 */
export function refreshLinks(list: any[], lookup: Map<string, any>): boolean {
  let changed = false;
  for (const c of list) {
    if (!isLinked(c)) continue;
    const src = lookup.get(c.link.of);
    if (!src || src === c || isLinked(src)) { delete c.link; changed = true; continue; }
    const stamp = sourceStamp(src);
    if (c.link.h === stamp) continue;
    const m = cleanMat(c.link.m) ?? placementOf(src, c);
    if (!m) { delete c.link; changed = true; continue; }
    const keep = cloneShape(c);
    const old = canon({ ...keep, link: undefined });
    materialize(src, c, m);
    // rounding noise only: keep the old numbers (no "unsaved changes" just from opening a project)
    if (canon({ ...c, link: undefined }) === old) { for (const k of Object.keys(c)) delete c[k]; Object.assign(c, keep, { link: { of: src.id, m, h: stamp } }); }
    changed = true;
  }
  return changed;
}

/** Map of all shapes by id (for refreshLinks) */
export function shapeIndex(lists: any[][]): Map<string, any> {
  const m = new Map<string, any>();
  for (const l of lists) for (const s of l) if (s && typeof s.id === "string") m.set(s.id, s);
  return m;
}

/** The original and all its copies in this list, for a shape that is either */
export function familyOf(list: any[], s: any): any[] {
  const root = isLinked(s) ? s.link.of : s?.id;
  if (!root) return [];
  return list.filter(q => q.id === root || (isLinked(q) && q.link.of === root));
}

/**
 * A generator run was made again (new shapes, new ids): copies that pointed at the old parts point at the new ones.
 * Same number of parts: part i → new part i (copies keep their ids). Otherwise every placed copy of the run is
 * rebuilt from all new parts (new ids). `lists` = every list that may hold copies (all beds/sides); changed in place.
 */
export function relinkRun(lists: any[][], oldParts: any[], made: any[], newId: () => string): void {
  const oldIds = new Map<string, any>(oldParts.map(s => [s.id, s]));
  const sameShape = oldParts.length === made.length && oldParts.every(s => Number.isInteger(s.gen?.i) && made.some(m => m.gen?.i === s.gen.i));
  const byIndex = new Map<number, any>(made.map(m => [m.gen?.i, m]));
  for (const list of lists) {
    const copies = list.filter(c => isLinked(c) && oldIds.has(c.link.of));
    if (!copies.length) continue;
    if (sameShape) {
      for (const c of copies) {
        const old = oldIds.get(c.link.of), nu = byIndex.get(old.gen.i);
        const m = cleanMat(c.link.m) ?? placementOf(old, c) ?? IDENT;
        materialize(nu, c, compose(m, invert(frameOf(old))));
      }
      continue;
    }
    // placed instances: copies that share one placement (raw transform old original → copy)
    const inst = new Map<string, { A: Mat; members: any[]; group: string | undefined }>();
    for (const c of copies) {
      const old = oldIds.get(c.link.of);
      const m = cleanMat(c.link.m) ?? placementOf(old, c) ?? IDENT;
      const A = compose(m, invert(frameOf(old)));
      const key = A.map(v => Math.round(v * 1000)).join(",");
      if (!inst.has(key)) inst.set(key, { A, members: [], group: c.groupId });
      inst.get(key)!.members.push(c);
    }
    for (const { A, members } of inst.values()) {
      const gone = new Set(members);
      const at = list.indexOf(members[0]);
      const groups = new Map<string, string>();
      const fresh = made.map(p => {
        const c: any = { id: newId() };
        if (p.groupId) { if (!groups.has(p.groupId)) groups.set(p.groupId, "grp-" + newId()); c.groupId = groups.get(p.groupId); }
        return materialize(p, c, A);
      });
      const rest = list.filter(s => !gone.has(s));
      rest.splice(Math.min(at, rest.length), 0, ...fresh);
      list.length = 0;
      list.push(...rest);
    }
  }
}
