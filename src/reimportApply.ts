/**
 * RE-IMPORT A DRAWING – carrying out the plan of reimportMatch.ts (no UI, no DOM; tests in tests/reimport.test.ts)
 *
 * Geometry comes from the file, everything set on a shape stays: milling mode, depth, tool, tabs, further operations,
 * laser layer, plasma cut, profile, group, bed and place. New shapes come in like a normal import, without settings
 * of their neighbours. Linked copies are rebuilt from their originals (copies of removed originals go, new shapes of a
 * part that has copies are copied too).
 *
 * The lists given are not changed; the result holds new lists for what changed.
 */
import { compose, IDENT, invert, isLinked, materialize, refreshLinks, shapeIndex, type Mat } from "./linkedCopies.ts";
import { cloneShape, isClosedShape, newId, shapeToPaths } from "./shapeTransform.ts";
import { fractionAt, pointAtFraction } from "./cutSetting.ts";
import { applySimilar, cleanImp, scaleMat, stampImport, type ImpData, type Item, type Plan } from "./reimportMatch.ts";

export interface Choices {
  /** which kinds are carried out */
  changed: boolean;
  added: boolean;
  gone: boolean;
  /** clusters that are left alone */
  skip: Set<number>;
  /** single entries that are left alone */
  off: Set<number>;
  /** "unclear" items: file shape to use (index), "gone" = remove; not in the map = leave as it is */
  unclear: Map<number, number | "gone">;
  /** file shapes that were only candidates and are still unused: insert as new */
  openNew: boolean;
}

/**
 * Gone shapes are only removed by default when it is certain that they came from the file as they are.
 * A file that has next to nothing in common with the drawing adds and removes nothing by default.
 */
export function defaultChoices(plan: Plan): Choices {
  return { changed: !plan.different, added: !plan.different, gone: !plan.different && plan.items.every(i => i.kind !== "gone" || plan.clusters[i.cluster]?.exact), skip: new Set(), off: new Set(), unclear: new Map(), openNew: false };
}

/** Where the geometry of the file lands for a cluster (grow: the file's larger unit was accepted) */
export function placeMat(plan: Plan, cluster: number): Mat {
  const m = plan.clusters[cluster]?.m ?? IDENT;
  return plan.grow === 1 ? m : compose(m, scaleMat(plan.grow));
}

/** File shape placed on the bed, without id/group/record */
export function placedShape(plan: Plan, cluster: number, nu: number): any {
  const s = cloneShape(plan.fresh[nu]);
  applySimilar(s, placeMat(plan, cluster));
  return s;
}

const GEOMETRY = ["type", "points", "closed", "x", "y", "w", "h", "midX", "midY", "rotation", "bez", "textPath"];

/** Geometry of `nu` (already placed) into a copy of `old`; tabs and start point set by hand keep their place */
function withGeometry(old: any, nu: any): any {
  const s = cloneShape(old);
  const before = shapeToPaths(old)[0];
  for (const k of GEOMETRY) delete s[k];
  for (const k of GEOMETRY) if (nu[k] !== undefined) s[k] = cloneShape(nu[k]);
  const after = shapeToPaths(s)[0];
  if (before && after) {
    const move = (f: number) => fractionAt(after.pts, after.closed, pointAtFraction(before.pts, before.closed, f));
    if (Array.isArray(s.tabPts)) s.tabPts = s.tabPts.map((f: any) => move(Number(f) || 0)).sort((a: number, b: number) => a - b);
    if (typeof s.cutStart === "number" && isClosedShape(s)) s.cutStart = move(s.cutStart);
  }
  loosen(s);
  return s;
}

/** Distance dimensions: the shape keeps the place from the file, the number adapts (editor/dims.ts) */
function loosen(s: any) {
  if (Array.isArray(s.cons)) s.cons = s.cons.map((c: any) => { const k = { ...c, force: false }; delete k.lastRef; return k; });
}

export interface ApplyResult {
  /** new lists, same order as given */
  lists: any[][];
  changed: boolean[];
  /** ids of changed and new shapes (to select) */
  touched: string[];
  done: { changed: number; added: number; removed: number; copies: number };
}

export function applyPlan(lists: any[][], plan: Plan, ch: Choices, source: string): ApplyResult {
  const out = lists.map(l => [...l]);
  const done = { changed: 0, added: 0, removed: 0, copies: 0 };
  const touched: string[] = [];
  const run = (i: Item) => plan.clusters[i.cluster] && !ch.skip.has(i.cluster) && !ch.off.has(i.id);
  const at = (list: number, id?: string) => out[list].findIndex(s => s.id === id);

  // ---- which file shape goes where ----
  const take: { item: Item; nu: number; geometry: boolean }[] = [];
  const remove: Item[] = [];
  const usedNew = new Set<string>();       // cluster|index
  for (const i of plan.items) {
    if (!run(i)) continue;
    if (i.kind === "same") take.push({ item: i, nu: i.nu!, geometry: false });
    if (i.kind === "changed" && ch.changed) take.push({ item: i, nu: i.nu!, geometry: true });
    if (i.kind === "gone" && ch.gone) remove.push(i);
    if (i.kind === "unclear") {
      const c = ch.unclear.get(i.id);
      if (c === "gone") remove.push(i);
      else if (c !== undefined && i.cands?.includes(c) && !usedNew.has(i.cluster + "|" + c)) { usedNew.add(i.cluster + "|" + c); take.push({ item: i, nu: c, geometry: true }); }
    }
  }

  const record = (s: any, cluster: number, nu: number) => {
    const f = cleanImp(plan.fresh[nu].imp), was = cleanImp(s.imp);
    stampImport(s, invert(placeMat(plan, cluster)), recordMeta(f, was, plan.clusters[cluster].ids));
  };
  // shapes of older projects: one run name per cluster
  const runName = new Map<string, string>();
  function recordMeta(f: ImpData | null, was: ImpData | null, ids: string[]) {
    const key = ids.join();
    if (!was && !runName.has(key)) runName.set(key, newId());
    return { f: was?.f ?? runName.get(key)!, k: f?.k, l: f?.l, d: f?.d ?? was?.d, m: f?.m ?? was?.m };
  }

  // ---- unchanged and changed shapes ----
  const pairOf = new Map<string, string>(); // cluster|file shape → id in the project
  for (const { item, nu, geometry } of take) {
    const k = at(item.list, item.oldId);
    if (k < 0) continue;
    const old = out[item.list][k];
    const s = geometry && !item.depthOnly ? withGeometry(old, placedShape(plan, item.cluster, nu)) : cloneShape(old);
    if (item.depth) s.millingDepth = item.depth[1];
    record(s, item.cluster, nu);
    if (JSON.stringify(s) !== JSON.stringify(old)) out[item.list][k] = s;
    pairOf.set(item.cluster + "|" + nu, s.id);
    if (geometry) { done.changed++; touched.push(s.id); }
  }

  // ---- removed shapes and their linked copies ----
  const gone = new Set(remove.map(i => i.oldId!));
  if (gone.size) out.forEach((l, li) => {
    const left = l.filter(s => {
      if (gone.has(s.id)) { done.removed++; return false; }
      if (isLinked(s) && gone.has(s.link.of)) { done.copies++; return false; }
      return true;
    });
    if (left.length !== l.length) out[li] = left;
  });

  // ---- new shapes ----
  const adds = plan.items.filter(i => i.kind === "new" && run(i) && ch.added).map(i => ({ cluster: i.cluster, list: i.list, nu: i.nu!, part: !!i.part }));
  if (ch.openNew) for (const o of plan.openNew) if (plan.clusters[o.cluster] && !ch.skip.has(o.cluster) && !usedNew.has(o.cluster + "|" + o.nu)) adds.push({ ...o, part: false });
  const partOf = (nu: number) => plan.fresh[nu].groupId || "s:" + plan.fresh[nu].id;
  const newGroups = new Map<string, string>();
  for (const a of adds) {
    const s = placedShape(plan, a.cluster, a.nu);
    s.id = newId();
    s.source = source;
    delete s.groupId;
    const list = out[a.list];
    // the shapes of the same part that are already there
    const mates = plan.fresh.map((_, j) => j).filter(j => partOf(j) === partOf(a.nu)).map(j => pairOf.get(a.cluster + "|" + j)).filter(Boolean)
      .map(id => list.find(x => x.id === id)).filter(Boolean);
    const groups = new Map<string, number>();
    for (const m of mates) if (m.groupId) groups.set(m.groupId, (groups.get(m.groupId) ?? 0) + 1);
    const g = [...groups].sort((x, y) => y[1] - x[1])[0]?.[0];
    if (g) s.groupId = g;
    else if (!mates.length && plan.fresh[a.nu].groupId) {
      const key = a.cluster + "|" + plan.fresh[a.nu].groupId;
      if (!newGroups.has(key)) newGroups.set(key, "part-" + newId());
      s.groupId = newGroups.get(key);
    }
    const mate = mates.find(m => m.groupId === s.groupId) ?? mates[0];
    if (mate?.linkFrame) s.linkFrame = cloneShape(mate.linkFrame);
    const meta = cleanImp(mate?.imp), f = cleanImp(plan.fresh[a.nu].imp);
    const any = plan.clusters[a.cluster].ids.map(id => cleanImp(list.find(x => x.id === id)?.imp)).find(Boolean);
    stampImport(s, invert(placeMat(plan, a.cluster)), { f: (meta ?? any)?.f ?? newId(), k: f?.k, l: f?.l, d: f?.d, m: f?.m });
    // same place in the order as in the file: before the next shape of the file that is already there
    let pos = -1;
    for (let j = a.nu + 1; j < plan.fresh.length && pos < 0; j++) { const id = pairOf.get(a.cluster + "|" + j); if (id) pos = list.findIndex(x => x.id === id); }
    for (let j = a.nu - 1; j >= 0 && pos < 0; j--) { const id = pairOf.get(a.cluster + "|" + j); if (id) { pos = list.findIndex(x => x.id === id); if (pos >= 0) pos++; } }
    list.splice(pos < 0 ? list.length : pos, 0, s);
    pairOf.set(a.cluster + "|" + a.nu, s.id);
    done.added++;
    touched.push(s.id);
    // the part has linked copies: they get the new shape too (one per placed copy)
    if (mate) done.copies += copyInto(out, mate, s);
  }

  // ---- linked copies follow ----
  const index = shapeIndex(out);
  out.forEach((l, li) => {
    if (!l.some(isLinked)) return;
    const fresh = l.map(s => (isLinked(s) ? cloneShape(s) : s));
    if (refreshLinks(fresh, index)) out[li] = fresh;
  });

  const changed = out.map((l, li) => l.length !== lists[li].length || l.some((s, i) => s !== lists[li][i]));
  return { lists: out, changed, touched, done };
}

/** New shape `s` belongs to the part of `mate`: add it to every linked copy of that part */
function copyInto(out: any[][], mate: any, s: any): number {
  let n = 0;
  for (const l of out) for (const c of l.filter(x => isLinked(x) && x.link.of === mate.id && Array.isArray(x.link.m))) {
    const k: any = { id: newId(), ...(c.groupId ? { groupId: c.groupId } : {}) };
    l.splice(l.indexOf(c) + 1, 0, materialize(s, k, c.link.m));
    n++;
  }
  return n;
}
