/**
 * FILL IN RINGS (laser): closed contours are filled with rings from the inside out instead of straight lines.
 *
 * Even/odd rule like the line fill: a contour inside another one is a hole, one inside the hole is filled again.
 * Ring k lies (k + 0.5) line distances away from the nearest edge – wall or hole, so no spot is burnt twice. The router's
 * pocket rings would cross there: they run around the wall and around the islands over the whole area (pocket.ts).
 * Contours that are too small or too costly for rings are handed back, the caller fills them with lines.
 */
import { pointInPoly, polygonArea, simplifyPolygon, type P } from "./polyOffset.ts";
import { pocketWallPaths } from "./pocket.ts";

export interface RingPath { pts: P[]; closed: boolean }

/** Limit for rings × points² of one contour group – beyond that it would take too long */
const MAX_COST = 1.5e8;

const box = (l: P[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of l) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
};

const open = (l: P[]): P[] => {
  const a = l[0], z = l[l.length - 1];
  return l.length > 1 && Math.hypot(a.x - z.x, a.y - z.y) < 1e-6 ? l.slice(0, -1) : l;
};

/** Contours sorted into areas: outer contour with its direct holes. A contour lies in another one if its first point does */
export function fillGroups(polys: P[][]): { outer: P[]; holes: P[][] }[] {
  const loops = polys.map(open).filter(l => l.length >= 3 && Math.abs(polygonArea(l)) > 1e-9);
  const boxes = loops.map(box), area = loops.map(l => Math.abs(polygonArea(l)));
  const parents = loops.map((l, i) => {
    const out: number[] = [];
    for (let k = 0; k < loops.length; k++) {
      if (k === i || area[k] <= area[i]) continue;
      const b = boxes[k];
      if (l[0].x < b.x0 || l[0].x > b.x1 || l[0].y < b.y0 || l[0].y > b.y1) continue;
      if (pointInPoly(l[0].x, l[0].y, loops[k])) out.push(k);
    }
    return out;
  });
  const groups = new Map<number, { outer: P[]; holes: P[][] }>();
  loops.forEach((l, i) => { if (parents[i].length % 2 === 0) groups.set(i, { outer: l, holes: [] }); });
  loops.forEach((l, i) => {
    if (parents[i].length % 2 === 0) return;
    // direct parent = the smallest contour around it
    const p = parents[i].reduce((a, b) => (area[b] < area[a] ? b : a));
    groups.get(p)?.holes.push(l);
  });
  return [...groups.values()];
}

/** rest = contours (outer + holes) that could not be filled with rings */
export function ringFill(polys: P[][], interval: number): { paths: RingPath[]; rest: P[][] } {
  const paths: RingPath[] = [], rest: P[][] = [];
  if (!(interval > 0)) return { paths, rest: polys };
  for (const raw of fillGroups(polys)) {
    // fewer points = much faster, and far below what a laser can show
    const tol = Math.min(0.01, interval / 5);
    const g = { outer: simplifyPolygon(raw.outer, tol), holes: raw.holes.map(h => simplifyPolygon(h, tol)) };
    const b = box(g.outer), rings = Math.min(b.x1 - b.x0, b.y1 - b.y0) / 2 / interval;
    const pts = g.outer.length + g.holes.reduce((n, h) => n + h.length, 0);
    const levels: RingPath[][] = [];
    if (rings <= 1900 && rings * pts * pts <= MAX_COST) {
      for (let k = 0; k < 2000; k++) {
        const level = pocketWallPaths(g.outer, g.holes, (k + 0.5) * interval).filter(q => q.pts.length >= 2);
        if (!level.length) break;
        levels.push(level.map(q => ({ pts: q.pts, closed: q.closed })));
      }
    }
    if (!levels.length) { rest.push(raw.outer, ...raw.holes); continue; }
    for (const l of levels.reverse()) paths.push(...l); // from the inside out
  }
  return { paths, rest };
}
