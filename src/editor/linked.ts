/**
 * LINKED COPIES IN THE EDITOR – the logic is in ../linkedCopies.ts (pure, tested), here only the wiring:
 * sync after every user action (history.ts), commands (duplicate linked, select original, unlink), the guard for
 * the node tool, and the marker on the canvas (chain badge on every linked part, dashed outline of the family).
 */
import { app, toScreen } from "./editorState";
import { setLinkHooks } from "./history";
import { linkLists, otherLists, bedName } from "./beds";
import { t } from "../i18n/i18n";
import { groupBounds, newId, shapeToPaths } from "../shapeTransform";
import { isLinked, linkClones, referencedIds, unlinkShapes, stripLinks } from "../linkedCopies";
import { refreshChecked, relinkChecked, syncChecked } from "./linkRust";

let log: (s: string) => void = () => {};

export function initLinks(appendToConsole: (s: string) => void) {
  log = appendToConsole;
  setLinkHooks(syncAfterAction, refreshShown);
}

/** history.ts → after a user action, before it becomes an undo step */
function syncAfterAction(before: string): boolean {
  const st = app();
  const others = otherLists();
  if (!st.shapes.some((s: any) => s.link || s.linkFrame) && !others.some(l => l.some(isLinked))) return false;
  const r = syncChecked(st.shapes, before, others);
  if (r.blocked) log(t("link.blocked"));
  if (r.orphaned) log(t("link.orphaned", { n: r.orphaned }));
  return r.changed;
}

/** history.ts → after undo/redo: copies follow originals that lie on another bed */
function refreshShown(): boolean {
  const st = app();
  if (!st.shapes.some(isLinked)) return false;
  return refreshChecked(st.shapes, linkLists());
}

/**
 * Linked copies of a selection: loose shapes are first grouped into one part (so holes stay with their outline
 * when only one of them is changed later). Returns the selection to copy.
 */
export function prepareLinkSources(sel: any[]): any[] {
  const loose = sel.filter(s => !s.groupId && !isLinked(s));
  if (sel.length > 1 && loose.length > 1) {
    const gid = "grp-" + newId();
    loose.forEach(s => { s.groupId = gid; });
    log(t("link.grouped"));
  }
  return sel;
}

/** Mark freshly made clones of `sources` as linked copies */
export function markLinked(sources: any[], clones: any[]) {
  linkClones(sources, clones);
}

/** The node tool must not take a linked copy (its shape comes from the original) */
export function guardLinked(s: any): boolean {
  if (!isLinked(s)) return false;
  log(t("link.nodeBlocked"));
  return true;
}

/** Selected linked copies become normal shapes */
export function unlinkSelection(sel: any[]) {
  const n = unlinkShapes(sel);
  log(n ? t("link.unlinked", { n }) : t("link.noneSelected"));
}

/** Ids of the originals of the selection (a selected original counts itself) */
function rootsOf(sel: any[]): Set<string> {
  const roots = new Set<string>();
  for (const s of sel) roots.add(isLinked(s) ? s.link.of : s.id);
  return roots;
}

/** Select the originals of the selected copies (if they are on this bed) */
export function selectOriginal(sel: any[]) {
  const st = app();
  const copies = sel.filter(isLinked);
  if (!copies.length) { log(t("link.noneSelected")); return; }
  const roots = rootsOf(copies);
  const here = st.shapes.filter((s: any) => roots.has(s.id));
  if (!here.length) {
    const where = linkLists().findIndex(l => l.some((s: any) => roots.has(s.id)));
    log(t("link.originalElsewhere", { bed: where >= 0 ? bedName(Math.floor(where / 2)) : "?" }));
    return;
  }
  const groups = new Set(here.map((s: any) => s.groupId).filter(Boolean));
  st.selectedShapeIds = st.shapes.filter((s: any) => roots.has(s.id) || (s.groupId && groups.has(s.groupId))).map((s: any) => s.id);
}

/** Select the original(s) and all linked copies on this bed */
export function selectFamily(sel: any[]) {
  const st = app();
  const roots = rootsOf(sel);
  const fam = st.shapes.filter((s: any) => roots.has(s.id) || (isLinked(s) && roots.has(s.link.of)));
  if (fam.length <= sel.length && !sel.some(isLinked) && !fam.some(isLinked)) { log(t("link.noneSelected")); return; }
  const groups = new Set(fam.map((s: any) => s.groupId).filter(Boolean));
  st.selectedShapeIds = st.shapes.filter((s: any) => fam.includes(s) || (s.groupId && groups.has(s.groupId))).map((s: any) => s.id);
  log(t("link.selected", { n: st.selectedShapeIds.length }));
}

/** Context menu: is anything linked in this selection? */
export function linkState(sel: any[]): { copies: number; originals: number } {
  const refs = referencedIds(linkLists());
  return { copies: sel.filter(isLinked).length, originals: sel.filter(s => refs.has(s.id)).length };
}

/** Generator made again: copies that showed the old parts now show the new ones (all beds) */
export function relinkGenerated(oldParts: any[], made: any[]) {
  if (!linkLists().some(l => l.some(isLinked))) return;
  relinkChecked(linkLists(), oldParts, made, newId);
}

/** Shapes leave the drawing in another form (other side of a two-sided job): no link data on them */
export function dropLinks(list: any[]) { stripLinks(list); }

// =====================================================================
// MARKER ON THE CANVAS
// =====================================================================

const LINK = "#b48cff";

/** Small chain symbol: two rounded links at 45° */
function chain(ctx: CanvasRenderingContext2D, x: number, y: number, filled: boolean) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = filled ? LINK : "rgba(20,20,30,0.85)";
  ctx.strokeStyle = LINK;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(0, 0, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.rotate(-Math.PI / 4);
  ctx.strokeStyle = filled ? "#1b1030" : LINK;
  ctx.lineWidth = 1.6;
  for (const dx of [-2.6, 2.6]) {
    ctx.beginPath();
    ctx.ellipse(dx, 0, 3.6, 2.3, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Chain badge on each linked copy (hollow) and each original with copies (filled); dashed outline of the family */
export function drawLinkMarks(ctx: CanvasRenderingContext2D, selectedIds: string[]) {
  const st = app();
  const shapes: any[] = st.shapes;
  if (!shapes.length) return;
  const refs = referencedIds(linkLists());
  if (!refs.size) return;
  const units = new Map<string, { list: any[]; original: boolean }>();
  for (const s of shapes) {
    const copy = isLinked(s), orig = refs.has(s.id);
    if (!copy && !orig) continue;
    const k = (s.groupId || s.id) + (copy ? "|c" : "|o");
    if (!units.has(k)) units.set(k, { list: [], original: !copy });
    units.get(k)!.list.push(s);
  }
  // family of the selection: dashed outline
  const sel = new Set(selectedIds);
  const roots = new Set<string>();
  for (const s of shapes) if (sel.has(s.id)) roots.add(isLinked(s) ? s.link.of : s.id);
  ctx.save();
  if (roots.size) {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = LINK;
    ctx.lineWidth = 1.6;
    for (const s of shapes) {
      if (sel.has(s.id)) continue;
      if (!(roots.has(s.id) && refs.has(s.id)) && !(isLinked(s) && roots.has(s.link.of))) continue;
      for (const p of shapeToPaths(s)) {
        if (p.pts.length < 2) continue;
        ctx.beginPath();
        p.pts.forEach((q, i) => { const k = toScreen(q.x, q.y); if (i) ctx.lineTo(k.x, k.y); else ctx.moveTo(k.x, k.y); });
        if (p.closed) ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }
  for (const { list, original } of units.values()) {
    const b = groupBounds(list);
    if (!b) continue;
    const p = toScreen(b.minX, b.maxY);
    chain(ctx, p.x - 12, p.y - 12, original); // outside the selection handle at the corner
  }
  ctx.restore();
}
