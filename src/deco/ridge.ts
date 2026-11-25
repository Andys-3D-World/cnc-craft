/**
 * ERHABENE SCHRIFT MIT GRAT – reine Rechnung (Tests: tests/deco.test.ts)
 *
 * Der V-Stichel fährt mit der Spitze genau auf dem Umriss, auf der Tiefe des Grundes. Seine Flanke schneidet dabei ein
 * „Dach“: Im Abstand d vom Rand steht das Material um d / tan(halber Winkel) höher, in der Mitte treffen sich die Flächen
 * zum Grat. Der Grund ringsum wird vorher mit einem Schaftfräser auf dieselbe Tiefe geräumt.
 */
export interface Pt { x: number; y: number }
import { pointInPoly } from "../polyOffset.ts";

/** Verschachtelung je Kontur: gerade = Buchstabe, ungerade = Loch darin */
export function nesting(loops: Pt[][]): number[] {
  return loops.map((l, i) => loops.reduce((n, o, j) => n + (j !== i && pointInPoly(l[0].x, l[0].y, o) ? 1 : 0), 0));
}

/** Größter Abstand eines Punktes in der Fläche zum Rand (halbe Strichbreite an der dicksten Stelle), auf ~1 % genau */
export function inradius(loops: Pt[][]): number {
  const segs: [number, number, number, number][] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of loops) for (let i = 0; i < l.length; i++) { const a = l[i], b = l[(i + 1) % l.length]; segs.push([a.x, a.y, b.x, b.y]); x0 = Math.min(x0, a.x); x1 = Math.max(x1, a.x); y0 = Math.min(y0, a.y); y1 = Math.max(y1, a.y); }
  if (!segs.length) return 0;
  /** Abstand zum Rand, innen positiv */
  const dist = (x: number, y: number): number => {
    let d2 = Infinity, inside = false;
    for (const [ax, ay, bx, by] of segs) {
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const ex = x - ax - t * dx, ey = y - ay - t * dy; d2 = Math.min(d2, ex * ex + ey * ey);
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    return inside ? Math.sqrt(d2) : -Math.sqrt(d2);
  };
  // Vierteilung: nur Felder weiter zerlegen, in denen noch ein größerer Wert liegen kann
  const size = Math.max(x1 - x0, y1 - y0), n = Math.max(2, Math.min(24, Math.ceil(size / Math.max(1e-6, Math.min(x1 - x0, y1 - y0) || size) * 4)));
  const h = size / n / 2;
  type C = { x: number; y: number; h: number; d: number };
  const list: C[] = [];
  let best = 0;
  const push = (x: number, y: number, hh: number) => { const d = dist(x, y); best = Math.max(best, d); if (d + hh * Math.SQRT2 > best * 1.01 + 1e-4) list.push({ x, y, h: hh, d }); };
  for (let i = 0; i * 2 * h < x1 - x0; i++) for (let j = 0; j * 2 * h < y1 - y0; j++) push(x0 + (2 * i + 1) * h, y0 + (2 * j + 1) * h, h);
  for (let guard = 0; list.length && guard < 60000; guard++) {
    const c = list.pop()!;
    if (c.d + c.h * Math.SQRT2 <= best * 1.01 + 1e-4) continue;
    const q = c.h / 2;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) push(c.x + sx * q, c.y + sy * q, q);
  }
  return best;
}

export interface RidgeOpts { angle: number; tipDia: number; toolDia: number; maxDepth: number }
export interface RidgePlan { depth: number; full: number; flat: number; coneLimit: boolean }
/**
 * Tiefe, bei der die Flächen sich in der Mitte treffen (full). depth = wirklich gefräst; flat = Breite, die oben flach bleibt,
 * wenn die Tiefe dafür nicht reicht. coneLimit = der Kegel des Stichels ist zu kurz.
 */
export function ridgeDepth(inr: number, o: RidgeOpts): RidgePlan {
  const tan = Math.tan(Math.max(10, Math.min(170, o.angle)) / 2 * Math.PI / 180), tip = Math.max(0, o.tipDia) / 2;
  const full = Math.max(0, inr - tip) / tan, cone = Math.max(0, o.toolDia / 2 - tip) / tan;
  const depth = Math.min(full, o.maxDepth, cone);
  return { depth, full, flat: 2 * Math.max(0, inr - tip - depth * tan), coneLimit: cone < Math.min(full, o.maxDepth) - 1e-6 };
}

/** Höhe der Fläche im Abstand d vom Rand (0 = Oberseite) */
export function ridgeHeight(d: number, depth: number, o: Pick<RidgeOpts, "angle" | "tipDia">): number {
  const tan = Math.tan(Math.max(10, Math.min(170, o.angle)) / 2 * Math.PI / 180);
  return Math.min(0, -depth + Math.max(0, d - Math.max(0, o.tipDia) / 2) / tan);
}
