/**
 * FORMEN BEARBEITEN: kombinieren (vereinen, abziehen, Schnittmenge), Ecken abrunden/abschrägen, zerschneiden
 *
 * Kombinieren nutzt die Bibliothek „polygon-clipping“ (MIT). Ein Teil = eine Gruppe (oder eine einzelne Form);
 * seine geschlossenen Konturen bilden zusammen eine Fläche nach der Gerade/Ungerade-Regel – Löcher (z. B. aus
 * einem Import) bleiben so Löcher. Ergebnis: neue Polylinien, Außenkontur „außen“, Löcher „innen“, je Teil eine
 * Gruppe. Werkzeug, Laser-Ebene, Plasma-Schnitt und Tiefe kommen von der Ausgangsform.
 *
 *   vereinen     alle Teile zu einer Fläche
 *   abziehen     vom größten Teil werden alle anderen abgezogen
 *   Schnittmenge nur was in allen Teilen liegt
 *   zerschneiden offene Linien/Bögen in der Auswahl schneiden die geschlossenen Formen (Spalt 0,01 mm),
 *                die Schneidlinien werden danach entfernt
 */
import polygonClipping, { MultiPolygon, Polygon, Ring } from "polygon-clipping";
import { createPolyline, shapeToPaths, convertToPolyline, updatePolylineBounds, MM_TO_PIXEL, Pt } from "../shapeTransform";

export type BoolOp = "union" | "subtract" | "intersect";

/** diese Eigenschaften übernimmt das Ergebnis von der Ausgangsform */
const KEEP = ["toolId", "laserLayerId", "plasmaCutId", "millingDepth", "source"];

const ring = (pts: Pt[]): Ring => pts.map(p => [p.x, p.y] as [number, number]);
const ringArea = (r: Ring) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return a / 2; };
const mpArea = (m: MultiPolygon) => m.reduce((s, poly) => s + poly.reduce((t, r, i) => t + (i ? -1 : 1) * Math.abs(ringArea(r)), 0), 0);

/** Auswahl in Teile aufteilen (Gruppe = ein Teil) */
function units(shapes: any[]): any[][] {
  const map = new Map<string, any[]>();
  for (const s of shapes) {
    const k = s.groupId || s.id;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(s);
  }
  return [...map.values()];
}

/** Fläche eines Teils: alle geschlossenen Konturen nach Gerade/Ungerade (xor) */
function region(members: any[]): MultiPolygon | null {
  const rings: Polygon[] = [];
  for (const s of members) for (const p of shapeToPaths(s)) if (p.closed && p.pts.length >= 3) rings.push([ring(p.pts)]);
  if (!rings.length) return null;
  return rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1));
}

/** Ergebnis-Flächen → neue Polylinien (je Fläche eine Gruppe, wenn sie Löcher hat) */
function toShapes(m: MultiPolygon, like: any): any[] {
  const extra: Record<string, any> = {};
  for (const k of KEEP) if (like?.[k] !== undefined) extra[k] = like[k];
  const out: any[] = [];
  for (const poly of m) {
    const gid = poly.length > 1 ? "grp-" + Math.random().toString(36).slice(2, 10) : undefined;
    poly.forEach((r, i) => {
      const closedTwice = r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1];
      const pts = (closedTwice ? r.slice(0, -1) : r).map(([x, y]) => ({ x, y }));
      if (pts.length < 3) return;
      out.push(createPolyline(pts, true, i === 0 ? "outside" : "inside", gid ? { ...extra, groupId: gid } : { ...extra }));
    });
  }
  return out;
}

export interface OpResult { remove: any[]; add: any[]; error?: string }

export function combine(op: BoolOp, sel: any[]): OpResult {
  const list = units(sel).map(u => ({ u, r: region(u) })).filter(x => x.r && x.r.length) as { u: any[]; r: MultiPolygon }[];
  if (list.length < 2) return { remove: [], add: [], error: "ops.needTwo" };
  let res: MultiPolygon;
  let like = list[0].u[0];
  if (op === "union") res = polygonClipping.union(list[0].r, ...list.slice(1).map(x => x.r));
  else if (op === "intersect") res = polygonClipping.intersection(list[0].r, ...list.slice(1).map(x => x.r));
  else {
    const base = list.reduce((a, b) => (mpArea(b.r) > mpArea(a.r) ? b : a));
    like = base.u[0];
    res = polygonClipping.difference(base.r, ...list.filter(x => x !== base).map(x => x.r));
  }
  if (!res.length) return { remove: [], add: [], error: op === "intersect" ? "ops.noOverlap" : "ops.empty" };
  return { remove: list.flatMap(x => x.u), add: toShapes(res, like) };
}

// ---------------------------------------------------------------------
// Zerschneiden
// ---------------------------------------------------------------------

/** Schmale Fläche entlang einer offenen Linie (Breite w, Welt-Pixel) – je Abschnitt ein Viereck, vereint */
function strip(pts: Pt[], w: number): MultiPolygon {
  const quads: Polygon[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 1e-9) continue;
    // etwas über die Enden hinaus, damit sich die Vierecke an Knicken überlappen
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L, nx = (-uy * w) / 2, ny = (ux * w) / 2, ex = (ux * w) / 2, ey = (uy * w) / 2;
    quads.push([[[a.x - ex + nx, a.y - ey + ny], [b.x + ex + nx, b.y + ey + ny], [b.x + ex - nx, b.y + ey - ny], [a.x - ex - nx, a.y - ey - ny]]]);
  }
  if (!quads.length) return [];
  return quads.length === 1 ? [quads[0]] : polygonClipping.union(quads[0], ...quads.slice(1));
}

export function splitByLines(sel: any[]): OpResult {
  const cutters = sel.filter(s => shapeToPaths(s).some(p => !p.closed));
  const targets = sel.filter(s => !cutters.includes(s));
  if (!cutters.length) return { remove: [], add: [], error: "ops.needCutLine" };
  const list = units(targets).map(u => ({ u, r: region(u) })).filter(x => x.r && x.r.length) as { u: any[]; r: MultiPolygon }[];
  if (!list.length) return { remove: [], add: [], error: "ops.needClosed" };
  const w = 0.01 * MM_TO_PIXEL;
  const knives = cutters.flatMap(s => shapeToPaths(s).filter(p => !p.closed).map(p => strip(p.pts, w))).filter(m => m.length);
  if (!knives.length) return { remove: [], add: [], error: "ops.needCutLine" };
  const knife = knives.length === 1 ? knives[0] : polygonClipping.union(knives[0], ...knives.slice(1));
  const remove: any[] = [], add: any[] = [];
  for (const x of list) {
    const res = polygonClipping.difference(x.r, knife);
    if (res.length < 2) continue; // nicht durchgeschnitten → bleibt wie es ist
    remove.push(...x.u);
    add.push(...toShapes(res, x.u[0]));
  }
  if (!add.length) return { remove: [], add: [], error: "ops.notThrough" };
  return { remove: [...remove, ...cutters], add };
}

// ---------------------------------------------------------------------
// Ecken abrunden / abschrägen
// ---------------------------------------------------------------------

/**
 * Jede „echte“ Ecke (Richtungswechsel über 12°) einer geschlossenen Polylinie bekommt einen Bogen mit Radius r
 * (bzw. eine Fase mit Schenkellänge r). Der Radius wird an kurzen Kanten verkleinert (höchstens halbe Kantenlänge),
 * damit sich benachbarte Rundungen nicht überschneiden. Rundungen aus vielen kleinen Stücken bleiben unverändert.
 * Gibt die Anzahl geänderter Ecken zurück.
 */
export function roundCorners(s: any, r: number, chamfer: boolean): number {
  if (s.type === "rect") convertToPolyline(s);
  if (s.type !== "polyline" || !s.closed || s.points.length < 3) return 0;
  const P: Pt[] = s.points;
  const n = P.length;
  const out: Pt[] = [];
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n];
    const l1 = Math.hypot(a.x - b.x, a.y - b.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
    if (l1 < 1e-9 || l2 < 1e-9) { out.push(b); continue; }
    const u1 = { x: (a.x - b.x) / l1, y: (a.y - b.y) / l1 }, u2 = { x: (c.x - b.x) / l2, y: (c.y - b.y) / l2 };
    const inner = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y))); // π = gerade weiter
    if (Math.PI - inner < (12 * Math.PI) / 180) { out.push(b); continue; }
    const half = inner / 2;
    // Abstand der Berührpunkte von der Ecke
    const d = Math.min(chamfer ? r : r / Math.tan(half), l1 / 2, l2 / 2);
    if (d < 1e-6) { out.push(b); continue; }
    const t1 = { x: b.x + u1.x * d, y: b.y + u1.y * d }, t2 = { x: b.x + u2.x * d, y: b.y + u2.y * d };
    changed++;
    if (chamfer) { out.push(t1, t2); continue; }
    const rr = d * Math.tan(half);                // tatsächlicher Radius (evtl. verkleinert)
    const bis = { x: u1.x + u2.x, y: u1.y + u2.y }, bl = Math.hypot(bis.x, bis.y) || 1;
    const cx = b.x + (bis.x / bl) * (rr / Math.sin(half)), cy = b.y + (bis.y / bl) * (rr / Math.sin(half));
    const a0 = Math.atan2(t1.y - cy, t1.x - cx), a1 = Math.atan2(t2.y - cy, t2.x - cx);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    const tol = 0.01 * MM_TO_PIXEL; // höchstens 0,01 mm Abweichung vom echten Bogen
    const steps = Math.max(3, Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(-1, 1 - tol / Math.max(rr, tol))))));
    for (let k = 0; k <= steps; k++) { const t = a0 + (sweep * k) / steps; out.push({ x: cx + rr * Math.cos(t), y: cy + rr * Math.sin(t) }); }
  }
  if (!changed) return 0;
  s.points = out;
  delete s.tabPts; // selbst gesetzte Stege hängen an der alten Kontur
  if (s.tabMode === "manual") s.tabMode = "auto";
  updatePolylineBounds(s);
  return changed;
}
