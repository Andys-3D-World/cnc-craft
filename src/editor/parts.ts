/**
 * TEILE ERKENNEN: Eine Zeichnung (z.B. aus einer DXF) in einzelne Teile aufteilen.
 *
 * Ein "Teil" = eine Außenkontur + alle Löcher darin + Linien/Gravuren, die darauf liegen.
 * Liegt in einem Loch wieder eine Kontur (Insel), ist das ein eigenes Teil.
 * Jedes Teil bekommt eine eigene Gruppe -> ein Klick wählt genau dieses Teil.
 *
 * Texte (Text-Werkzeug oder Texte aus DXF) bleiben immer als ganzer Text zusammen.
 */
import { newId, shapeToPaths, isClosedShape, pathArea, pointInPath, shapeBounds, Pt } from "../shapeTransform";

interface Info {
  shape: any;
  pts: Pt[];
  area: number;
  box: { minX: number; minY: number; maxX: number; maxY: number };
}

function isTextShape(s: any): boolean {
  return !!(s.textData || s.isText);
}

/**
 * Vergibt neue groupIds pro Teil. Gibt die Anzahl der Teile zurück.
 * Text-Formen werden nicht verändert.
 */
export function assignPartGroups(shapes: any[]): number {
  const work = shapes.filter(s => !isTextShape(s));
  const closed: Info[] = [];
  const open: any[] = [];

  for (const s of work) {
    const b = shapeBounds(s);
    const path = shapeToPaths(s)[0];
    if (!b || !path || path.pts.length < 2) continue;
    if (isClosedShape(s) && path.pts.length >= 3) {
      closed.push({ shape: s, pts: path.pts, area: Math.abs(pathArea(path.pts)), box: b });
    } else {
      open.push(s);
    }
  }

  // Größte zuerst: so findet jede Kontur ihren direkten "Eltern"-Umriss
  closed.sort((a, b) => b.area - a.area);
  const parent = new Map<Info, Info | null>();
  const depth = new Map<Info, number>();

  /** Kleinste Kontur, die größer als minArea ist und den Punkt enthält */
  const containing = (p: Pt, minArea: number, skip?: Info): Info | null => {
    let best: Info | null = null;
    for (const c of closed) {
      if (c === skip || c.area <= minArea) continue;
      if (best && c.area >= best.area) continue;
      if (p.x < c.box.minX || p.x > c.box.maxX || p.y < c.box.minY || p.y > c.box.maxY) continue;
      if (pointInPath(p.x, p.y, c.pts)) best = c;
    }
    return best;
  };

  for (const c of closed) {
    const par = containing(c.pts[0], c.area, c);
    parent.set(c, par);
    depth.set(c, par ? (depth.get(par) ?? 0) + 1 : 0);
  }

  // Teil-Wurzel: gerade Tiefe = Außenkontur, ungerade = Loch -> gehört zum Eltern-Teil
  const rootOf = (c: Info): Info => {
    const d = depth.get(c) ?? 0;
    if (d % 2 === 0) return c;
    return parent.get(c) || c;
  };

  const groupFor = new Map<Info, string>();
  let parts = 0;
  const gid = (root: Info) => {
    let g = groupFor.get(root);
    if (!g) { g = "part-" + newId(); groupFor.set(root, g); parts++; }
    return g;
  };

  for (const c of closed) c.shape.groupId = gid(rootOf(c));

  // Offene Linien gehören zu dem Teil, auf dem sie liegen (z.B. Gravur auf einer Platte)
  for (const s of open) {
    const p = shapeToPaths(s)[0].pts[0];
    const host = containing(p, 0);
    if (host) s.groupId = gid(rootOf(host));
    else { delete s.groupId; parts++; }
  }
  return parts;
}
