/**
 * GEOMETRIE-GRUNDLAGE FÜR ALLE FORMEN
 *
 * Koordinaten im Speicher: "Welt-Pixel" (1 mm = 2 Pixel), Y zeigt nach OBEN
 * (wie an der Maschine). Das Umrechnen auf den Bildschirm macht render.ts.
 *
 * Formen-Typen:
 *   polyline  { points: [{x,y}], closed }        Linien, Rechtecke, Ellipsen, Polygone, Text, STL
 *   circle    { x, y = Mitte, w = Radius }        echter Kreis (wird als G2 gefräst)
 *   arc       { x,y = Start, x+w,y+h = Ende, midX,midY = Punkt auf dem Bogen }
 *   line      { x,y = Start, x+w,y+h = Ende }     (alte Einzellinien, werden weiter unterstützt)
 *
 * Gemeinsame Felder: id, millingMode ("outside" | "inside" | "on-line" | "pocket"),
 *   millingDepth, groupId (Formen mit gleicher groupId gehören zusammen)
 */
import { berechne3PunktBogen } from "./arcEngine";

export const MM_TO_PIXEL = 2;

export interface Pt { x: number; y: number; }
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number; }
export interface Path { pts: Pt[]; closed: boolean; }

/** Genauigkeit beim Zerlegen von Bögen in kleine Geraden (in Welt-Pixeln = 0,01 mm) */
const ARC_TOL = 0.02;

export function newId(): string {
  return Math.random().toString(36).substring(2, 11);
}

// =====================================================================
// FORMEN ERZEUGEN
// =====================================================================

export function createPolyline(
  points: Pt[],
  closed: boolean,
  millingMode: string,
  extra: Record<string, any> = {}
): any {
  const shape = {
    id: newId(),
    type: "polyline",
    points,
    closed,
    x: 0, y: 0, w: 0, h: 0,
    rotation: 0,
    millingMode,
    millingDepth: -2.0,
    ...extra
  };
  updatePolylineBounds(shape);
  return shape;
}

export function createCircle(cx: number, cy: number, r: number, millingMode = "outside"): any {
  return { id: newId(), type: "circle", x: cx, y: cy, w: r, h: r, rotation: 0, millingMode, millingDepth: -2.0 };
}

export function createArc(sx: number, sy: number, ex: number, ey: number, mx: number, my: number, millingMode = "on-line"): any {
  return {
    id: newId(), type: "arc", x: sx, y: sy, w: ex - sx, h: ey - sy, midX: mx, midY: my,
    rotation: 0, millingMode, millingDepth: -2.0
  };
}

/** Rechteck von (x0,y0) bis (x1,y1), optional mit runden Ecken. Gegen den Uhrzeigersinn. */
export function makeRectPoints(x0: number, y0: number, x1: number, y1: number, radius = 0): Pt[] {
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  const r = Math.max(0, Math.min(radius, (maxX - minX) / 2, (maxY - minY) / 2));
  if (r <= 1e-6) {
    return [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
  }
  const pts: Pt[] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    const steps = arcSteps(r, Math.PI / 2);
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (Math.PI / 2) * (i / steps);
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  };
  corner(maxX - r, minY + r, -Math.PI / 2);  // unten rechts
  corner(maxX - r, maxY - r, 0);             // oben rechts
  corner(minX + r, maxY - r, Math.PI / 2);   // oben links
  corner(minX + r, minY + r, Math.PI);       // unten links
  return pts;
}

/** Ellipse mit Mittelpunkt und Halbachsen. Gegen den Uhrzeigersinn. */
export function makeEllipsePoints(cx: number, cy: number, rx: number, ry: number): Pt[] {
  const steps = Math.max(24, arcSteps(Math.max(Math.abs(rx), Math.abs(ry)), Math.PI * 2));
  const pts: Pt[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pts.push({ x: cx + Math.abs(rx) * Math.cos(a), y: cy + Math.abs(ry) * Math.sin(a) });
  }
  return pts;
}

/** Regelmäßiges Vieleck: Mittelpunkt, Radius (zu den Ecken), Anzahl Ecken, Drehung der ersten Ecke */
export function makePolygonPoints(cx: number, cy: number, r: number, sides: number, startAngle: number): Pt[] {
  const n = Math.max(3, Math.round(sides));
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = startAngle + (i / n) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function arcSteps(r: number, sweep: number): number {
  if (r <= ARC_TOL) return 4;
  const maxStep = 2 * Math.acos(Math.max(-1, 1 - ARC_TOL / r));
  return Math.max(4, Math.ceil(Math.abs(sweep) / maxStep));
}

// =====================================================================
// FORM -> PUNKTEZÜGE (für Anklicken, Fang, Auswahlrahmen, Versatz)
// =====================================================================

/** Bogen-Daten: Mittelpunkt, Radius, Start-/Endwinkel und Drehrichtung */
export function arcGeometry(s: any) {
  const ex = s.x + s.w, ey = s.y + s.h;
  const b = berechne3PunktBogen(s.x, s.y, ex, ey, s.midX, s.midY);
  if (!b) return null;
  // Liegt der Mittelpunkt LINKS der Sehne Start->Ende, läuft der Bogen im Uhrzeigersinn
  const cross = (s.w * (s.midY - s.y)) - (s.h * (s.midX - s.x));
  const clockwise = cross > 0;
  let sweep = b.end - b.start;
  if (clockwise) { while (sweep > 0) sweep -= Math.PI * 2; }
  else { while (sweep < 0) sweep += Math.PI * 2; }
  return { cx: b.cx, cy: b.cy, r: b.r, start: b.start, sweep, clockwise };
}

export function shapeToPaths(s: any): Path[] {
  switch (s.type) {
    case "polyline":
      return [{ pts: s.points, closed: !!s.closed }];
    case "line":
      return [{ pts: [{ x: s.x, y: s.y }, { x: s.x + s.w, y: s.y + s.h }], closed: false }];
    case "circle": {
      const r = Math.abs(s.w);
      return [{ pts: makeEllipsePoints(s.x, s.y, r, r), closed: true }];
    }
    case "arc": {
      const g = arcGeometry(s);
      if (!g) return [{ pts: [{ x: s.x, y: s.y }, { x: s.x + s.w, y: s.y + s.h }], closed: false }];
      const steps = arcSteps(g.r, g.sweep);
      const pts: Pt[] = [];
      for (let i = 0; i <= steps; i++) {
        const a = g.start + g.sweep * (i / steps);
        pts.push({ x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) });
      }
      return [{ pts, closed: false }];
    }
    case "rect":
      return [{ pts: makeRectPoints(s.x, s.y, s.x + s.w, s.y + s.h), closed: true }];
    default:
      return [];
  }
}

export function isClosedShape(s: any): boolean {
  return s.type === "circle" || s.type === "rect" || (s.type === "polyline" && !!s.closed);
}

// =====================================================================
// UMRISS-BOX
// =====================================================================

export function updatePolylineBounds(shape: any) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of shape.points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  shape.x = minX; shape.y = minY;
  shape.w = maxX - minX; shape.h = maxY - minY;
}

export function shapeBounds(s: any): Bounds | null {
  switch (s.type) {
    case "polyline":
    case "image":
      return { minX: s.x, minY: s.y, maxX: s.x + s.w, maxY: s.y + s.h };
    case "circle": {
      const r = Math.abs(s.w);
      return { minX: s.x - r, minY: s.y - r, maxX: s.x + r, maxY: s.y + r };
    }
    case "arc":
      return pathsBounds(shapeToPaths(s));
    case "line":
    case "rect":
    case "path":
      return {
        minX: Math.min(s.x, s.x + s.w), minY: Math.min(s.y, s.y + s.h),
        maxX: Math.max(s.x, s.x + s.w), maxY: Math.max(s.y, s.y + s.h)
      };
    default:
      return null;
  }
}

function pathsBounds(paths: Path[]): Bounds | null {
  let b: Bounds | null = null;
  for (const p of paths) for (const q of p.pts) {
    if (!b) b = { minX: q.x, minY: q.y, maxX: q.x, maxY: q.y };
    else {
      if (q.x < b.minX) b.minX = q.x; if (q.x > b.maxX) b.maxX = q.x;
      if (q.y < b.minY) b.minY = q.y; if (q.y > b.maxY) b.maxY = q.y;
    }
  }
  return b;
}

export function groupBounds(shapes: any[]): Bounds | null {
  let b: Bounds | null = null;
  for (const s of shapes) {
    const sb = shapeBounds(s);
    if (!sb) continue;
    if (!b) b = { ...sb };
    else {
      b.minX = Math.min(b.minX, sb.minX); b.minY = Math.min(b.minY, sb.minY);
      b.maxX = Math.max(b.maxX, sb.maxX); b.maxY = Math.max(b.maxY, sb.maxY);
    }
  }
  return b;
}

// =====================================================================
// VERÄNDERN: verschieben, skalieren, drehen, spiegeln
// =====================================================================

/** Bézier-Knoten (siehe editor/bezier.ts) samt Tangenten mitbewegen */
function mapBezNodes(s: any, f: (p: Pt) => Pt) {
  if (!s.bez) return;
  s.bez = s.bez.map((n: any) => {
    const p = f(n);
    return { x: p.x, y: p.y, ...(n.hi ? { hi: f(n.hi) } : {}), ...(n.ho ? { ho: f(n.ho) } : {}), ...(n.smooth ? { smooth: true } : {}) };
  });
}

export function translateShape(s: any, dx: number, dy: number) {
  if (s.type === "polyline" || s.type === "image") {
    mapBezNodes(s, p => ({ x: p.x + dx, y: p.y + dy }));
    for (const p of s.points) { p.x += dx; p.y += dy; }
    updatePolylineBounds(s);
    return;
  }
  s.x += dx; s.y += dy;
  if (s.type === "arc") { s.midX += dx; s.midY += dy; }
}

/** Wandelt eine Form in eine Polylinie um (z.B. vor dem Drehen eines Rechtecks aus SVG) */
export function convertToPolyline(s: any) {
  const paths = shapeToPaths(s);
  if (paths.length === 0) return;
  const p = paths[0];
  s.type = "polyline";
  s.points = p.pts.map(q => ({ x: q.x, y: q.y }));
  s.closed = p.closed;
  delete s.midX; delete s.midY;
  updatePolylineBounds(s);
}

/** Skaliert eine Form um den Punkt (ox, oy). Negative Faktoren = spiegeln. */
export function scaleShape(s: any, ox: number, oy: number, sx: number, sy: number) {
  const fx = (x: number) => ox + (x - ox) * sx;
  const fy = (y: number) => oy + (y - oy) * sy;

  if (s.type === "circle" && Math.abs(Math.abs(sx) - Math.abs(sy)) > 1e-9) {
    // Kreis wird ungleichmäßig gezogen -> wird zur Ellipse
    const r = Math.abs(s.w);
    s.type = "polyline";
    s.points = makeEllipsePoints(s.x, s.y, r, r);
    s.closed = true;
  }
  if (s.type === "rect") convertToPolyline(s);

  if (s.type === "polyline" || s.type === "image") {
    mapBezNodes(s, p => ({ x: fx(p.x), y: fy(p.y) }));
    for (const p of s.points) { p.x = fx(p.x); p.y = fy(p.y); }
    updatePolylineBounds(s);
  } else if (s.type === "circle") {
    s.x = fx(s.x); s.y = fy(s.y);
    s.w = Math.abs(s.w * sx);
    s.h = s.w;
  } else if (s.type === "arc") {
    const ex = fx(s.x + s.w), ey = fy(s.y + s.h);
    s.x = fx(s.x); s.y = fy(s.y);
    s.w = ex - s.x; s.h = ey - s.y;
    s.midX = fx(s.midX); s.midY = fy(s.midY);
  } else {
    const ex = fx(s.x + s.w), ey = fy(s.y + s.h);
    s.x = fx(s.x); s.y = fy(s.y);
    s.w = ex - s.x; s.h = ey - s.y;
  }
}

/** Dreht eine Form um (cx, cy). Winkel im Bogenmaß, positiv = gegen den Uhrzeigersinn. */
export function rotateShape(s: any, cx: number, cy: number, angle: number) {
  const c = Math.cos(angle), sn = Math.sin(angle);
  const rot = (x: number, y: number): Pt => ({
    x: cx + (x - cx) * c - (y - cy) * sn,
    y: cy + (x - cx) * sn + (y - cy) * c
  });

  if (s.type === "rect") convertToPolyline(s);

  if (s.type === "polyline" || s.type === "image") {
    mapBezNodes(s, p => rot(p.x, p.y));
    s.points = s.points.map((p: Pt) => rot(p.x, p.y));
    updatePolylineBounds(s);
  } else if (s.type === "circle") {
    const p = rot(s.x, s.y); s.x = p.x; s.y = p.y;
  } else if (s.type === "arc") {
    const a = rot(s.x, s.y), e = rot(s.x + s.w, s.y + s.h), m = rot(s.midX, s.midY);
    s.x = a.x; s.y = a.y; s.w = e.x - a.x; s.h = e.y - a.y; s.midX = m.x; s.midY = m.y;
  } else if (s.type === "line") {
    const a = rot(s.x, s.y), e = rot(s.x + s.w, s.y + s.h);
    s.x = a.x; s.y = a.y; s.w = e.x - a.x; s.h = e.y - a.y;
  }
  s.rotation = 0;
}

export function cloneShape(s: any): any {
  return JSON.parse(JSON.stringify(s));
}

// =====================================================================
// ABSTÄNDE (zum Anklicken)
// =====================================================================

export function segDist(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

export function distanceToShape(px: number, py: number, s: any): number {
  if (s.type === "circle") return Math.abs(Math.hypot(px - s.x, py - s.y) - Math.abs(s.w));
  // Bild: irgendwo draufklicken genügt
  if (s.type === "image") {
    if (pointInPath(px, py, s.points)) return 0;
    let d = Infinity;
    for (let i = 0; i < 4; i++) d = Math.min(d, segDist(px, py, s.points[i], s.points[(i + 1) % 4]));
    return d;
  }
  let best = Infinity;
  for (const path of shapeToPaths(s)) {
    const pts = path.pts, n = pts.length;
    const last = path.closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const d = segDist(px, py, pts[i], pts[(i + 1) % n]);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Für ältere Aufrufe */
export function distanceToPolyline(px: number, py: number, s: any): number {
  return distanceToShape(px, py, s);
}

export function pointInPath(px: number, py: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

export function pathArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return a / 2;
}
