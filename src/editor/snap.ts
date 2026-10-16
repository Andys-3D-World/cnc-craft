/**
 * FANG (EINRASTEN): Die Maus springt auf Endpunkte, Mittelpunkte, Kreismitten
 * oder auf das Raster. Funktioniert wie der Objektfang in LightBurn/CAD-Programmen.
 */
import { app, options, screenDist } from "./editorState";
import { MM_TO_PIXEL, Pt, shapeBounds, arcGeometry } from "../shapeTransform";

export type SnapKind = "none" | "point" | "mid" | "center" | "grid";

export interface SnapResult { x: number; y: number; kind: SnapKind; }

const SNAP_PX = 10;          // Fangradius in Bildschirm-Pixeln
const MAX_POINTS_PER_SHAPE = 4000;

/**
 * @param wx, wy      Mausposition in Welt-Pixeln
 * @param exclude     Formen, die ignoriert werden (z.B. die gerade verschobenen)
 * @param extra       zusätzliche Fangpunkte (z.B. bereits gesetzte Punkte der aktuellen Linie)
 */
export function snapPoint(wx: number, wy: number, exclude?: Set<string>, extra: Pt[] = []): SnapResult {
  const radius = screenDist(SNAP_PX);
  let best: SnapResult = { x: wx, y: wy, kind: "none" };
  let bestD = radius;

  const consider = (x: number, y: number, kind: SnapKind) => {
    const d = Math.hypot(x - wx, y - wy);
    if (d < bestD) { bestD = d; best = { x, y, kind }; }
  };

  if (options.snapObjects) {
    for (const p of extra) consider(p.x, p.y, "point");

    for (const s of app().shapes as any[]) {
      if (exclude && exclude.has(s.id)) continue;
      const b = shapeBounds(s);
      if (!b || wx < b.minX - radius || wx > b.maxX + radius || wy < b.minY - radius || wy > b.maxY + radius) continue;

      if (s.type === "polyline") {
        const pts = s.points as Pt[];
        if (pts.length > MAX_POINTS_PER_SHAPE) continue;
        const n = pts.length;
        for (let i = 0; i < n; i++) {
          consider(pts[i].x, pts[i].y, "point");
          if (n <= 200 && (s.closed || i < n - 1)) {
            const q = pts[(i + 1) % n];
            consider((pts[i].x + q.x) / 2, (pts[i].y + q.y) / 2, "mid");
          }
        }
      } else if (s.type === "line") {
        consider(s.x, s.y, "point");
        consider(s.x + s.w, s.y + s.h, "point");
        consider(s.x + s.w / 2, s.y + s.h / 2, "mid");
      } else if (s.type === "circle") {
        const r = Math.abs(s.w);
        consider(s.x, s.y, "center");
        consider(s.x + r, s.y, "point"); consider(s.x - r, s.y, "point");
        consider(s.x, s.y + r, "point"); consider(s.x, s.y - r, "point");
      } else if (s.type === "arc") {
        consider(s.x, s.y, "point");
        consider(s.x + s.w, s.y + s.h, "point");
        const g = arcGeometry(s);
        if (g) consider(g.cx, g.cy, "center");
      }
    }
  }

  if (best.kind === "none" && options.snapGrid) {
    const step = Math.max(0.01, options.gridStep) * MM_TO_PIXEL;
    best = { x: Math.round(wx / step) * step, y: Math.round(wy / step) * step, kind: "grid" };
  }
  return best;
}

/** Richtung auf 15°-Schritte einrasten (für Shift beim Zeichnen) */
export function snapAngle(fromX: number, fromY: number, x: number, y: number, stepDeg = 15): Pt {
  const dx = x - fromX, dy = y - fromY;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x, y };
  const step = (stepDeg * Math.PI) / 180;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: fromX + Math.cos(a) * len, y: fromY + Math.sin(a) * len };
}
