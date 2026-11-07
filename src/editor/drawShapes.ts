/**
 * ZEICHENFORMEN Stern, Langloch, Ring, Bogen mit Mittelpunkt: Rechnung (Tests in tests/drawShapes.test.ts).
 * Maus und Vorschau liegen in tools.ts und overlay.ts. Alle Maße in Welt-Pixeln, der Ring-Wandwert ebenso.
 */
import { makeRectPoints, type Pt } from "../shapeTransform.ts";

/** Stern: n Zacken, erste Spitze in Richtung startAngle; inner = Innenradius als Anteil von r (0..1) */
export function starPoints(cx: number, cy: number, r: number, n: number, inner: number, startAngle: number): Pt[] {
  const tips = Math.max(3, Math.round(n));
  const ratio = Math.max(0.05, Math.min(0.95, inner));
  const pts: Pt[] = [];
  for (let i = 0; i < tips * 2; i++) {
    const a = startAngle + (i * Math.PI) / tips, q = i % 2 ? r * ratio : r;
    pts.push({ x: cx + q * Math.cos(a), y: cy + q * Math.sin(a) });
  }
  return pts;
}

/** Langloch im gezogenen Rahmen: lange Seiten gerade, kurze Seiten als Halbkreis */
export function slotPoints(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const r = Math.min(Math.abs(x1 - x0), Math.abs(y1 - y0)) / 2;
  const pts = makeRectPoints(x0, y0, x1, y1, r);
  // Die kurze Kante hat bei vollem Radius die Länge 0: doppelte Punkte weg
  return pts.filter((p, i) => {
    const q = pts[(i + 1) % pts.length];
    return Math.hypot(p.x - q.x, p.y - q.y) > 1e-9;
  });
}

/** Ring: Innenradius aus Außenradius und Wandstärke; null = Wand zu dick, kein Loch möglich */
export function ringInner(outer: number, wall: number): number | null {
  const inner = outer - wall;
  return wall > 0 && inner > 1e-6 ? inner : null;
}

export interface CenterArc { start: Pt; end: Pt; mid: Pt; radius: number; sweep: number }

/**
 * Bogen um einen Mittelpunkt: Radius kommt vom Startpunkt, das Ende liegt in Richtung der Maus auf demselben Kreis.
 * ccw = gegen den Uhrzeigersinn vom Start zum Ende. null = Mittelpunkt und Start fallen zusammen oder der Bogen hat keine Länge.
 */
export function centerArc(c: Pt, start: Pt, mouse: Pt, ccw: boolean, snapRad = 0): CenterArc | null {
  const radius = Math.hypot(start.x - c.x, start.y - c.y);
  if (radius < 1e-6) return null;
  const a0 = Math.atan2(start.y - c.y, start.x - c.x);
  let a1 = Math.atan2(mouse.y - c.y, mouse.x - c.x);
  if (snapRad > 0) a1 = a0 + Math.round((a1 - a0) / snapRad) * snapRad;
  const full = Math.PI * 2;
  let sweep = ((a1 - a0) % full + full) % full; // 0 .. 2π gegen den Uhrzeigersinn
  if (!ccw) sweep = sweep > 0 ? sweep - full : 0;
  if (Math.abs(sweep) < 1e-6) return null;
  const at = (a: number): Pt => ({ x: c.x + radius * Math.cos(a), y: c.y + radius * Math.sin(a) });
  return { start: { x: start.x, y: start.y }, end: at(a0 + sweep), mid: at(a0 + sweep / 2), radius, sweep };
}
