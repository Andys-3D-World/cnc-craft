/**
 * FANG (EINRASTEN): Die Maus springt auf Endpunkte, Mittelpunkte, Kreismitten, Viertelpunkte, Schnittpunkte,
 * Lot- und Tangentenpunkte (die beiden nur beim Zeichnen vom letzten Punkt aus) oder auf das Raster.
 * Die Rechnung für Schnitt-, Lot-, Tangenten- und Viertelpunkte steht in snapGeom.ts.
 * Bei gleichem Abstand gewinnt, was zuerst geprüft wird: Punkt, Mitte, Kreismitte, Viertelpunkt, Schnittpunkt, Lot, Tangente.
 */
import { app, options, screenDist } from "./editorState";
import { MM_TO_PIXEL, Pt, shapeBounds, arcGeometry } from "../shapeTransform";
import { allIntersections, perpFeet, primXY, primsNear, quadrants, tangentPts, type Prim } from "./snapGeom";
import { checkImport, importInApp } from "../importers/importRust";

export type SnapKind = "none" | "point" | "mid" | "center" | "quad" | "int" | "perp" | "tan" | "grid";

export interface SnapResult { x: number; y: number; kind: SnapKind; }

const SNAP_PX = 10;          // Fangradius in Bildschirm-Pixeln
const MAX_POINTS_PER_SHAPE = 4000;

/**
 * @param wx, wy      Mausposition in Welt-Pixeln
 * @param exclude     Formen, die ignoriert werden (z.B. die gerade verschobenen)
 * @param extra       zusätzliche Fangpunkte (z.B. bereits gesetzte Punkte der aktuellen Linie)
 * @param from        letzter gesetzter Punkt beim Zeichnen: dann auch Lot- und Tangentenpunkte
 */
export function snapPoint(wx: number, wy: number, exclude?: Set<string>, extra: Pt[] = [], from?: Pt): SnapResult {
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
        consider(s.x + r, s.y, "quad"); consider(s.x - r, s.y, "quad");
        consider(s.x, s.y + r, "quad"); consider(s.x, s.y - r, "quad");
      } else if (s.type === "arc") {
        consider(s.x, s.y, "point");
        consider(s.x + s.w, s.y + s.h, "point");
        const g = arcGeometry(s);
        if (g) consider(g.cx, g.cy, "center");
      }
    }

    // Viertelpunkte von Bögen, Schnittpunkte, Lot und Tangente: nur Bausteine nahe der Maus
    const prims = primsNear(app().shapes, { x: wx, y: wy }, radius, exclude, MAX_POINTS_PER_SHAPE);
    const quads = prims.flatMap(p => p.k === "circ" && p.sweep !== undefined ? quadrants(p) : []);
    const ints = allIntersections(prims);
    const perp = from ? perpFeet(prims, from) : [], tan = from ? tangentPts(prims, from) : [];
    for (const q of quads) consider(q.x, q.y, "quad");
    for (const q of ints) consider(q.x, q.y, "int");
    for (const q of perp) consider(q.x, q.y, "perp");
    for (const q of tan) consider(q.x, q.y, "tan");
    rustCheck(prims, from, { quads, ints, perp, tan });
  }

  if (best.kind === "none" && options.snapGrid) {
    const step = Math.max(0.01, options.gridStep) * MM_TO_PIXEL;
    best = { x: Math.round(wx / step) * step, y: Math.round(wy / step) * step, kind: "grid" };
  }
  return best;
}

/** Richtung auf 15°-Schritte einrasten (für Shift beim Zeichnen) */
// Rust rechnet die Fangpunkte nach (snapgeom.rs) – nur Vergleich. Die Maus bewegt sich oft: höchstens alle 2 s einmal
let lastRust = 0;
function rustCheck(prims: Prim[], from: Pt | undefined, ts: { quads: Pt[]; ints: Pt[]; perp: Pt[]; tan: Pt[] }) {
  if (!importInApp() || !prims.length || prims.length > 2000) return;
  const now = performance.now();
  if (now - lastRust < 2000) return;
  lastRust = now;
  const xy = (ps: Pt[]) => ps.map(q => ({ x: q.x, y: q.y }));
  checkImport("snap_check", { job: { kind: "snap", prims: prims.map(primXY), ...(from ? { from: { x: from.x, y: from.y } } : {}) } },
    { quads: xy(ts.quads), ints: xy(ts.ints), perp: xy(ts.perp), tan: xy(ts.tan) });
}

export function snapAngle(fromX: number, fromY: number, x: number, y: number, stepDeg = 15): Pt {
  const dx = x - fromX, dy = y - fromY;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x, y };
  const step = (stepDeg * Math.PI) / 180;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: fromX + Math.cos(a) * len, y: fromY + Math.sin(a) * len };
}
