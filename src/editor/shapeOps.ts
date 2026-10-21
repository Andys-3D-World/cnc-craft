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
 *   Musterfüllung  die größte ausgewählte geschlossene Form wird mit Kopien der übrigen Auswahl (Motiv) gefüllt
 *   verbinden + anritzen  überlappende Teile (z. B. Schreibschrift) werden zu einer Schnittkontur vereint;
 *                sichtbare Übergänge (Kanten eines oberen Teils über einem unteren) bleiben als Ritzlinien
 */
import polygonClipping, { MultiPolygon, Polygon, Ring } from "polygon-clipping";
import { createPolyline, shapeToPaths, convertToPolyline, updatePolylineBounds, MM_TO_PIXEL, Pt, cloneShape, newId, translateShape, groupBounds } from "../shapeTransform";

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

export interface OpResult { remove: any[]; add: any[]; error?: string; scores?: number }

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

// ---------------------------------------------------------------------
// Musterfüllung
// ---------------------------------------------------------------------

export interface PatternOptions { gapX: number; gapY: number; brick: boolean; clip: boolean } // Abstände in mm

/** Liegt der Punkt in der Fläche (Gerade/Ungerade über alle Ringe)? */
function inRegion(m: MultiPolygon, x: number, y: number): boolean {
  let n = 0;
  for (const poly of m) for (const r of poly) {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) n++;
  }
  return n % 2 === 1;
}

/**
 * Die größte ausgewählte geschlossene Form (mit ihrer Gruppe) ist die Fläche, der Rest ist das Motiv.
 * Kopien im Raster (Motiv-Größe + Abstand, auf Wunsch jede zweite Reihe um eine halbe Breite versetzt), mittig.
 * clip = false: nur Kopien, die ganz drin liegen; clip = true: geschlossene Motiv-Teile am Rand abschneiden.
 */
export function patternFill(sel: any[], o: PatternOptions): OpResult {
  const us = units(sel).map(u => ({ u, r: region(u) }));
  const closed = us.filter(x => x.r && x.r.length) as { u: any[]; r: MultiPolygon }[];
  if (us.length < 2 || !closed.length) return { remove: [], add: [], error: "pat.select" };
  const area = closed.reduce((a, b) => (mpArea(b.r) > mpArea(a.r) ? b : a));
  const motif = us.filter(x => x !== area).flatMap(x => x.u);
  const mb = groupBounds(motif), ab = groupBounds(area.u);
  if (!mb || !ab) return { remove: [], add: [], error: "pat.select" };
  const mw = mb.maxX - mb.minX, mh = mb.maxY - mb.minY;
  const sx = mw + Math.max(0, o.gapX) * MM_TO_PIXEL, sy = mh + Math.max(0, o.gapY) * MM_TO_PIXEL;
  if (sx < 0.5 || sy < 0.5) return { remove: [], add: [], error: "pat.tooSmall" };
  const aw = ab.maxX - ab.minX, ah = ab.maxY - ab.minY;
  const cols = Math.ceil(aw / sx) + 2, rows = Math.ceil(ah / sy) + 2;
  if (cols * rows > 5000) return { remove: [], add: [], error: "pat.tooMany" };
  // Raster mittig über der Fläche
  const x0 = (ab.minX + ab.maxX) / 2 - (cols * sx) / 2 + (sx - mw) / 2, y0 = (ab.minY + ab.maxY) / 2 - (rows * sy) / 2 + (sy - mh) / 2;
  const motifRegion = region(motif);
  const add: any[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const dx = x0 + c * sx + (o.brick && r % 2 ? sx / 2 : 0) - mb.minX, dy = y0 + r * sy - mb.minY;
    const pts = motif.flatMap(m => shapeToPaths(m).flatMap(p => p.pts)).map(q => ({ x: q.x + dx, y: q.y + dy }));
    const allIn = pts.every(q => inRegion(area.r, q.x, q.y));
    const anyIn = allIn || pts.some(q => inRegion(area.r, q.x, q.y));
    if (allIn) {
      // ganze Kopie: neue IDs, alle Teile einer Kopie in eine Gruppe
      const gid = "pat-" + newId();
      for (const m of motif) { const k = cloneShape(m); k.id = newId(); k.groupId = gid; translateShape(k, dx, dy); add.push(k); }
    } else if (o.clip && anyIn && motifRegion) {
      // am Rand: geschlossene Teile mit der Fläche schneiden
      const moved: MultiPolygon = motifRegion.map(poly => poly.map(rg => rg.map(([x, y]) => [x + dx, y + dy] as [number, number])));
      const cut = polygonClipping.intersection(moved, area.r);
      if (cut.length) add.push(...toShapes(cut, motif[0]));
    }
  }
  if (!add.length) return { remove: [], add: [], error: "pat.none" };
  return { remove: [], add };
}

// ---------------------------------------------------------------------
// Verbinden und Anritzen
// ---------------------------------------------------------------------

/** Kontur in Stücke teilen (Schritt ≈ 0,1 mm) und nur die Stücke behalten, deren Mitte keep() erfüllt */
function keepRuns(pts: Pt[], closed: boolean, keep: (x: number, y: number) => boolean): Pt[][] {
  const step = 0.1 * MM_TO_PIXEL;
  const seq = closed ? [...pts, pts[0]] : pts;
  const runs: Pt[][] = [];
  let cur: Pt[] | null = null;
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1], b = seq[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) {
      const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
      const q = { x: a.x + ((b.x - a.x) * (k + 1)) / n, y: a.y + ((b.y - a.y) * (k + 1)) / n };
      if (keep((p.x + q.x) / 2, (p.y + q.y) / 2)) {
        if (!cur) { cur = [p]; runs.push(cur); }
        cur.push(q);
      } else cur = null;
    }
  }
  // geschlossene Kontur: letztes und erstes Stück gehören zusammen
  if (closed && runs.length > 1) {
    const f = runs[0], l = runs[runs.length - 1];
    if (Math.hypot(f[0].x - l[l.length - 1].x, f[0].y - l[l.length - 1].y) < 1e-6) { runs[0] = [...l, ...f.slice(1)]; runs.pop(); }
  }
  return runs.map(simplifyRun).filter(r => r.length >= 2);
}

/** Punkte auf einer Geraden zusammenfassen (die 0,1-mm-Schritte sollen nicht im G-Code landen) */
function simplifyRun(r: Pt[]): Pt[] {
  if (r.length < 3) return r;
  const out = [r[0]];
  for (let i = 1; i < r.length - 1; i++) {
    const a = out[out.length - 1], b = r[i], c = r[i + 1];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) / (Math.hypot(c.x - a.x, c.y - a.y) || 1) > 0.002 * MM_TO_PIXEL) out.push(b);
  }
  out.push(r[r.length - 1]);
  return out;
}

/**
 * Teile in Zeichen-Reihenfolge (später = oben). Ergebnis: vereinte Außenkontur (Schnitt) + Ritzlinien:
 * die Kanten eines Teils, die über einem darunterliegenden Teil liegen und nicht von einem höheren verdeckt sind.
 * scoreExtra: Eigenschaften der Ritzlinien (z. B. Laser-Ebene „Linien markieren“)
 */
export function weldAndScore(sel: any[], scoreExtra: Record<string, any>): OpResult {
  const list = units(sel).map(u => ({ u, r: region(u) })).filter(x => x.r && x.r.length) as { u: any[]; r: MultiPolygon }[];
  if (list.length < 2) return { remove: [], add: [], error: "ops.needTwo" };
  const union = polygonClipping.union(list[0].r, ...list.slice(1).map(x => x.r));
  const add = toShapes(union, list[0].u[0]);
  let scores = 0;
  list.forEach((x, i) => {
    const below = list.slice(0, i).map(y => y.r), above = list.slice(i + 1).map(y => y.r);
    if (!below.length) return;
    const under = below.length === 1 ? below[0] : polygonClipping.union(below[0], ...below.slice(1));
    const over = above.length ? (above.length === 1 ? above[0] : polygonClipping.union(above[0], ...above.slice(1))) : null;
    for (const poly of x.r) for (const rg of poly) {
      const pts = rg.map(([px, py]) => ({ x: px, y: py }));
      for (const run of keepRuns(pts, true, (px, py) => inRegion(under, px, py) && !(over && inRegion(over, px, py)))) {
        add.push(createPolyline(run, false, "on-line", { ...scoreExtra, isScore: true }));
        scores++;
      }
    }
  });
  return { remove: list.flatMap(x => x.u), add, scores };
}
