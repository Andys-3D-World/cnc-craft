/**
 * PLASMA: what happens to one shape – cut it, only spot its centre, or leave it out.
 *
 * Spotting = the torch fires for a moment over the centre of a hole without moving. That leaves a small mark to
 * drill the hole afterwards (holes much smaller than the sheet is thick do not come out round with plasma).
 *
 *   shape.plasmaOp  "cut" | "spot" | "skip" – missing or anything else = automatic
 *   automatic:      closed holes (cut on the inside) up to `spotMax` mm are spotted, everything else is cut.
 *                   spotMax 0 = automatic spotting off, so drawings without these settings give the same G-code as before.
 *
 * No machine code in here – plasmaCam.ts writes the G-code.
 */
export type PlasmaOp = "auto" | "cut" | "spot" | "skip";
export const PLASMA_OPS: PlasmaOp[] = ["auto", "cut", "spot", "skip"];
export interface XY { x: number; y: number }

/** Spot time: at least 20 ms (shorter and no arc starts), at most 2 s (longer burns a hole) */
export const SPOT_MS_MIN = 20, SPOT_MS_MAX = 2000;

/** Setting of the shape, cleaned (it can come from a project file) */
export function plasmaOpOf(shape: any): PlasmaOp {
  const v = shape?.plasmaOp;
  return v === "cut" || v === "spot" || v === "skip" ? v : "auto";
}

/** Box of a set of paths: centre and larger side. null = no points */
export function boxOf(paths: { pts: XY[] }[]): { centre: XY; size: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths) for (const q of p.pts) {
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) continue;
    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
  }
  if (x0 > x1) return null;
  return { centre: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, size: Math.max(x1 - x0, y1 - y0) };
}

/**
 * What to do with a shape. paths = its paths (any unit), size limit `spotMax` in the same unit.
 * Automatic spotting only for one closed contour that is cut on the inside (a hole).
 */
export function resolveOp(shape: any, paths: { pts: XY[]; closed: boolean }[], spotMax: number): "cut" | "spot" | "skip" {
  const op = plasmaOpOf(shape);
  if (op !== "auto") return op === "spot" && !boxOf(paths) ? "cut" : op;
  if (!(spotMax > 0) || shape?.millingMode !== "inside" || paths.length !== 1 || !paths[0].closed) return "cut";
  const b = boxOf(paths);
  return b && b.size <= spotMax + 1e-9 ? "spot" : "cut";
}

/** Order of the spots with short travel: always the nearest one next */
export function nearestOrder(points: XY[], from: XY): XY[] {
  const left = points.slice(), out: XY[] = [];
  let at = from;
  while (left.length) {
    let best = 0, bd = Infinity;
    left.forEach((p, i) => { const d = Math.hypot(p.x - at.x, p.y - at.y); if (d < bd) { bd = d; best = i; } });
    at = left.splice(best, 1)[0];
    out.push(at);
  }
  return out;
}
