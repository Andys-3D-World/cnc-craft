/**
 * Kleine Helfer, die alle Knoten brauchen (nodeDefs.ts und moreNodes.ts).
 */
import { MM_TO_PIXEL, cloneShape, newId, createPolyline, groupBounds, translateShape } from "../shapeTransform";

export const PX = MM_TO_PIXEL;

export const num = (v: any, d = 0) => (Number.isFinite(+v) ? +v : d);
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Kopien mit neuen IDs; Gruppen bleiben zusammen, bekommen aber eigene Kennungen */
export function fresh(list: any[]): any[] {
  const gmap = new Map<string, string>();
  return list.map(s => {
    const c = s.type === "image" ? cloneImage(s) : cloneShape(s);
    c.id = newId();
    delete c.gen; // Kopie ist kein Generator-Lauf mehr
    delete c.link; delete c.linkFrame; // und keine verknüpfte Kopie
    if (c.groupId) {
      if (!gmap.has(c.groupId)) gmap.set(c.groupId, "grp-" + newId());
      c.groupId = gmap.get(c.groupId);
    }
    return c;
  });
}

/** Bild-Form kopieren, ohne die (große) Bild-Adresse durch JSON zu schicken */
export function cloneImage(s: any): any {
  const src = s.img?.src || "";
  const c = JSON.parse(JSON.stringify({ ...s, img: { ...s.img, src: "" } }));
  c.img.src = src;
  return c;
}

/** Linienzug in mm (Y nach oben) als Form */
export function mmShape(pts: [number, number][], closed: boolean, mode: string, extra: Record<string, any> = {}): any {
  const n = pts.length;
  const cut = closed && n > 1 && pts[0][0] === pts[n - 1][0] && pts[0][1] === pts[n - 1][1] ? pts.slice(0, -1) : pts;
  return createPolyline(cut.map(([x, y]) => ({ x: x * PX, y: y * PX })), closed, mode, extra);
}

/** Linke untere Ecke auf den Nullpunkt schieben (wie Rechteck und Kreis) */
export function toOrigin(list: any[]): any[] {
  const b = groupBounds(list);
  if (b) for (const s of list) translateShape(s, -b.minX, -b.minY);
  return list;
}
