/**
 * TRIM-WERKZEUG: Maus-Teil (Rechnung in trim.ts).
 * Begrenzt wird durch die Auswahl, wenn etwas ausgewählt ist, sonst durch alle Formen auf dem Bett.
 * Unter der Maus erscheint gelb, was wegfällt. Jeder Klick ist ein Rückgängig-Schritt (history.ts merkt die Änderung).
 */
import { app } from "./editorState";
import { hitTest } from "./selection";
import { intersections, nearestStation, pathLength, remainingSpans, slicePath, trimSpan, trimTargetPath, piecesFromSpans } from "./trim";
import { Path, Pt, shapeToPaths } from "../shapeTransform";
import { t } from "../i18n/i18n";

let log: (s: string) => void = () => {};
export function setTrimLog(fn: (s: string) => void) { log = fn; }
/** Meldung in die Konsole, auch für die anderen Zeichenwerkzeuge in tools.ts */
export const toolLog = (s: string) => log(s);

export const trimHover = { removed: null as Pt[] | null };

let cache: { id: string; shapes: any; sel: string; path: Path; cuts: number[] } | null = null;

function target(shape: any) {
  const st = app();
  const sel = st.selectedShapeIds.join(",");
  if (cache && cache.id === shape.id && cache.shapes === st.shapes && cache.sel === sel) return cache;
  const path = trimTargetPath(shape);
  if (!path) return null;
  const others = st.selectedShapeIds.length ? st.shapes.filter((s: any) => st.selectedShapeIds.includes(s.id)) : st.shapes;
  const cutters = others.filter((s: any) => s.id !== shape.id).flatMap((s: any) => shapeToPaths(s));
  cache = { id: shape.id, shapes: st.shapes, sel, path, cuts: intersections(path, cutters) };
  return cache;
}

export function trimMouseMove(world: Pt) {
  trimHover.removed = null;
  const hit = hitTest(world.x, world.y);
  if (!hit || hit.type === "image") return;
  const c = target(hit);
  if (!c) return;
  const span = trimSpan(pathLength(c.path), c.path.closed, c.cuts, nearestStation(c.path, world).s);
  if (span) trimHover.removed = slicePath(c.path, span);
}

/** true = es wurde etwas geändert */
export function trimClick(world: Pt): boolean {
  const hit = hitTest(world.x, world.y);
  if (!hit) return false;
  if (hit.type === "image") { log(t("trim.noImage")); return false; }
  const c = target(hit);
  if (!c) return false;
  const len = pathLength(c.path);
  const span = trimSpan(len, c.path.closed, c.cuts, nearestStation(c.path, world).s);
  if (!span) { log(t("trim.noCut")); return false; }
  const pieces = piecesFromSpans(hit, c.path, remainingSpans(len, c.path.closed, span));
  const st = app();
  const at = st.shapes.indexOf(hit);
  const next = [...st.shapes];
  next.splice(at, 1, ...pieces); // Teilstücke bleiben in der Reihenfolge an der alten Stelle
  st.shapes = next;
  st.selectedShapeIds = st.selectedShapeIds.filter((id: string) => id !== hit.id);
  cache = null;
  trimHover.removed = null;
  log(t("trim.done", { n: pieces.length }));
  return true;
}
