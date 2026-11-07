/**
 * PRÜFUNG VON GENERATOR-ERGEBNISSEN (ohne Oberfläche, alle Maße in mm)
 *
 * cleanPoints: Punkte, die fast aufeinander liegen, entfernen (machen nur winzige Fahrbefehle).
 * thinnestWeb: dünnster Steg zwischen zwei Schnittlinien; dort kann das Teil beim Schneiden oder danach brechen.
 * outsideBed:  ragt etwas über das Bett?
 */
export interface GcPt { x: number; y: number }
export interface GcPath { pts: GcPt[]; closed: boolean }

export function cleanPoints<P extends GcPt>(pts: P[], closed: boolean, tol: number): P[] {
  if (pts.length < 2) return pts;
  const out: P[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1];
    if (Math.hypot(pts[i].x - a.x, pts[i].y - a.y) >= tol) out.push(pts[i]);
  }
  while (closed && out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < tol) out.pop();
  // zu wenig übrig: lieber nichts ändern, als aus einer kleinen Form einen Punkt zu machen
  return out.length >= (closed ? 3 : 2) ? out : pts;
}

function segDist(p: GcPt, a: GcPt, b: GcPt): number {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Kleinster Abstand zwischen verschiedenen Pfaden, gesucht bis `limit` mm. null = nichts Näheres gefunden */
export function thinnestWeb(paths: GcPath[], limit: number): number | null {
  const cell = Math.max(limit, 0.5);
  const grid = new Map<string, [number, GcPt, GcPt][]>();
  paths.forEach((path, pi) => {
    const n = path.pts.length, count = path.closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const a = path.pts[i], b = path.pts[(i + 1) % n];
      const x0 = Math.floor((Math.min(a.x, b.x) - limit) / cell), x1 = Math.floor((Math.max(a.x, b.x) + limit) / cell);
      const y0 = Math.floor((Math.min(a.y, b.y) - limit) / cell), y1 = Math.floor((Math.max(a.y, b.y) + limit) / cell);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = x + "," + y;
        let list = grid.get(k);
        if (!list) grid.set(k, list = []);
        list.push([pi, a, b]);
      }
    }
  });
  let min = Infinity;
  paths.forEach((path, pi) => {
    for (const q of path.pts) {
      for (const [pj, a, b] of grid.get(Math.floor(q.x / cell) + "," + Math.floor(q.y / cell)) || []) {
        if (pj !== pi) min = Math.min(min, segDist(q, a, b));
      }
    }
  });
  return min <= limit ? min : null;
}

/** Gesamtgröße, wenn sie nicht ins Bett (0…w, 0…h) passt, sonst null */
export function outsideBed(paths: GcPath[], w: number, h: number, tol = 0.01): { w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths) for (const q of p.pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  if (x0 === Infinity) return null;
  return x0 < -tol || y0 < -tol || x1 > w + tol || y1 > h + tol ? { w: x1 - x0, h: y1 - y0 } : null;
}

/** Ab wann ein Steg als zu dünn gilt (mm): Richtwerte je Maschinenart */
export function minWebFor(mode: string): number {
  return mode === "plasma" ? 3 : mode === "mill" ? 1.5 : 0.8;
}
