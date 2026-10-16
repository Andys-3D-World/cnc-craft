/**
 * AUSWAHL: Anklicken, Auswahlrahmen, Gruppen, Griffe zum Skalieren/Drehen.
 *
 * Wie in LightBurn:
 *   - Klick wählt eine Form (bzw. die ganze Gruppe). Shift+Klick = hinzufügen/entfernen.
 *   - Alt+Klick wählt nur das einzelne Element aus einer Gruppe.
 *   - Rahmen von LINKS nach RECHTS: nur Formen, die ganz im Rahmen liegen.
 *   - Rahmen von RECHTS nach LINKS: alle Formen, die der Rahmen berührt.
 */
import { app, toScreen, screenDist } from "./editorState";
import { Bounds, Pt, distanceToShape, groupBounds, shapeBounds, shapeToPaths } from "../shapeTransform";

const CLICK_PX = 7;

export function selectedShapes(): any[] {
  const st = app();
  const ids = new Set(st.selectedShapeIds);
  return st.shapes.filter((s: any) => ids.has(s.id));
}

export function selectionBounds(): Bounds | null {
  return groupBounds(selectedShapes());
}

/** Liefert die Form unter der Maus (nächste Kontur innerhalb der Klick-Toleranz) */
export function hitTest(wx: number, wy: number, tolPx = CLICK_PX): any | null {
  const tol = screenDist(tolPx);
  let best: any = null;
  let bestD = tol;
  for (const s of app().shapes as any[]) {
    const b = shapeBounds(s);
    if (!b || wx < b.minX - tol || wx > b.maxX + tol || wy < b.minY - tol || wy > b.maxY + tol) continue;
    const d = distanceToShape(wx, wy, s);
    if (d <= bestD) { bestD = d; best = s; }
  }
  return best;
}

/** Erweitert IDs um alle Mitglieder derselben Gruppen */
export function withGroupMembers(ids: string[]): string[] {
  const st = app();
  const groups = new Set<string>();
  for (const s of st.shapes) if (ids.includes(s.id) && s.groupId) groups.add(s.groupId);
  if (groups.size === 0) return [...ids];
  const out = new Set(ids);
  for (const s of st.shapes) if (s.groupId && groups.has(s.groupId)) out.add(s.id);
  return [...out];
}

/** Klick-Auswahl. single = nur dieses Element (Alt), toggle = Shift */
export function clickSelect(shape: any | null, toggle: boolean, single: boolean) {
  const st = app();
  if (!shape) {
    if (!toggle) st.selectedShapeIds = [];
    return;
  }
  const ids = single ? [shape.id] : withGroupMembers([shape.id]);
  if (toggle) {
    const allSelected = ids.every(id => st.selectedShapeIds.includes(id));
    if (allSelected) st.selectedShapeIds = st.selectedShapeIds.filter((id: string) => !ids.includes(id));
    else st.selectedShapeIds = [...new Set([...st.selectedShapeIds, ...ids])];
  } else {
    st.selectedShapeIds = ids;
  }
}

/** Rahmen-Auswahl in Welt-Koordinaten */
export function boxSelect(a: Pt, b: Pt, crossing: boolean, add: boolean) {
  const st = app();
  const box: Bounds = { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  const hits: string[] = [];
  for (const s of st.shapes as any[]) {
    const sb = shapeBounds(s);
    if (!sb) continue;
    const inside = sb.minX >= box.minX && sb.maxX <= box.maxX && sb.minY >= box.minY && sb.maxY <= box.maxY;
    if (inside) { hits.push(s.id); continue; }
    if (!crossing) continue;
    const overlap = sb.maxX >= box.minX && sb.minX <= box.maxX && sb.maxY >= box.minY && sb.minY <= box.maxY;
    if (overlap && shapeTouchesBox(s, box)) hits.push(s.id);
  }
  const ids = withGroupMembers(hits);
  st.selectedShapeIds = add ? [...new Set([...st.selectedShapeIds, ...ids])] : ids;
}

function shapeTouchesBox(s: any, box: Bounds): boolean {
  for (const path of shapeToPaths(s)) {
    const pts = path.pts, n = pts.length;
    const last = path.closed ? n : n - 1;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY) return true;
    }
    for (let i = 0; i < last; i++) if (segmentHitsBox(pts[i], pts[(i + 1) % n], box)) return true;
  }
  return false;
}

/** Liang-Barsky: schneidet die Strecke das Rechteck? */
function segmentHitsBox(a: Pt, b: Pt, box: Bounds): boolean {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const checks: [number, number][] = [
    [-dx, a.x - box.minX], [dx, box.maxX - a.x], [-dy, a.y - box.minY], [dy, box.maxY - a.y]
  ];
  for (const [p, q] of checks) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

// =====================================================================
// GRIFFE (Skalieren an 8 Punkten + Drehen oben)
// =====================================================================

export type HandleName = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate";

export interface Handle { name: HandleName; sx: number; sy: number; }

export const HANDLE_SIZE = 8;
const HANDLE_HIT = 6;
export const ROTATE_OFFSET = 26;

/** Griffe in Bildschirm-Koordinaten für die aktuelle Auswahl */
export function selectionHandles(): Handle[] {
  const b = selectionBounds();
  if (!b) return [];
  const tl = toScreen(b.minX, b.maxY);
  const br = toScreen(b.maxX, b.minY);
  const pad = 10; // Rahmen etwas größer als die Formen, damit Griffe nicht auf den Linien liegen
  const x0 = tl.x - pad, y0 = tl.y - pad, x1 = br.x + pad, y1 = br.y + pad;
  const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
  return [
    { name: "nw", sx: x0, sy: y0 }, { name: "n", sx: xm, sy: y0 }, { name: "ne", sx: x1, sy: y0 },
    { name: "e", sx: x1, sy: ym }, { name: "se", sx: x1, sy: y1 }, { name: "s", sx: xm, sy: y1 },
    { name: "sw", sx: x0, sy: y1 }, { name: "w", sx: x0, sy: ym },
    { name: "rotate", sx: xm, sy: y0 - ROTATE_OFFSET }
  ];
}

export function handleAt(sx: number, sy: number): Handle | null {
  for (const h of selectionHandles()) {
    const r = h.name === "rotate" ? 9 : HANDLE_HIT;
    if (Math.abs(sx - h.sx) <= r && Math.abs(sy - h.sy) <= r) return h;
  }
  return null;
}

/** Liegt der Bildschirmpunkt im Auswahlrahmen? */
export function insideSelectionBox(sx: number, sy: number): boolean {
  const b = selectionBounds();
  if (!b) return false;
  const tl = toScreen(b.minX, b.maxY);
  const br = toScreen(b.maxX, b.minY);
  return sx >= tl.x - 10 && sx <= br.x + 10 && sy >= tl.y - 10 && sy <= br.y + 10;
}

export const HANDLE_CURSORS: Record<HandleName, string> = {
  nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
  n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", rotate: "grab"
};
