/**
 * KONTUR-VERSATZ (Werkzeugradius-Korrektur) für geschlossene Konturen.
 *
 * Außen fräsen  = Kontur um den Werkzeugradius nach außen schieben
 * Innen fräsen  = Kontur um den Werkzeugradius nach innen schieben
 *
 * Verfahren:
 *   1. Jede Kante um "d" verschieben. An Ecken, wo eine Lücke entsteht,
 *      wird ein Bogen eingefügt (runde Ecken, wie es der Fräser auch macht).
 *   2. Dabei entstehen an engen Stellen Schlaufen, die sich überkreuzen.
 *      Alle Kreuzungspunkte werden gesucht und die Linie dort aufgeteilt.
 *   3. Nur die Stücke, die überall mindestens |d| von der Originalkontur
 *      entfernt sind, bleiben übrig. Das ist genau die Bahn des Fräsers.
 *
 * Ergebnis: eine oder mehrere Konturen (z.B. zerfällt eine Engstelle in zwei),
 * oder gar keine, wenn das Werkzeug zu dick für die Form ist.
 */

export interface P { x: number; y: number; }

export function polygonArea(pts: P[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return a / 2;
}

export function pointInPoly(px: number, py: number, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/**
 * @param polygon  geschlossene Kontur in mm (letzter Punkt != erster Punkt)
 * @param d        > 0 nach außen, < 0 nach innen, 0 = unverändert
 * @param arcTol   maximale Abweichung der Bögen in mm
 * @returns Konturen, gegen den Uhrzeigersinn orientiert
 */
export function offsetPolygon(polygon: P[], d: number, arcTol = 0.01): P[][] {
  const res = offsetOnce(polygon, d, arcTol);
  if (res.length || Math.abs(d) < 1e-9) return res;
  // Sonderfall: liegt ein Kreuzungspunkt genau auf einem Streckenende, wird er übersehen und die Kontur
  // schließt sich nicht (z. B. Halbkreis mit genau 1,5 mm nach innen). Mit winzig anderem Abstand nochmal.
  for (const f of [1 + 1e-6, 1 - 1e-6]) {
    const again = offsetOnce(polygon, d * f, arcTol);
    if (again.length) return again;
  }
  return res;
}

function offsetOnce(polygon: P[], d: number, arcTol: number): P[][] {
  let pts = cleanPolygon(polygon);
  if (pts.length < 3) return [];
  if (polygonArea(pts) < 0) pts = pts.slice().reverse();
  if (Math.abs(d) < 1e-9) return [pts];

  const { raw, arc } = buildRawOffset(pts, d, arcTol);
  const pieces = splitAtIntersections(raw, arc);

  // Nur Stücke behalten, die weit genug weg und auf der richtigen Seite liegen.
  // Eingefügte Bögen sind nur Sehnen (bis arcTol zu nah), verschobene Kanten liegen genau auf |d| –
  // für sie gilt die enge Grenze, sonst bleiben an fein unterteilten Bögen winzige Schlaufen übrig
  const arcMin = Math.abs(d) - (arcTol * 2 + 1e-6);
  const edgeMin = Math.abs(d) * (1 - 1e-9) - 1e-9;
  const grid = new SegmentGrid(pts);
  const kept = pieces.filter(pc => {
    const mx = (pc.a.x + pc.b.x) / 2, my = (pc.a.y + pc.b.y) / 2;
    return !grid.nearerThan(mx, my, pc.arc ? arcMin : edgeMin);
  });

  // Eine fertige Kontur liegt komplett auf einer Seite -> ein Test pro Kontur reicht
  const loops = chainPieces(kept, Math.max(arcTol * 4, Math.abs(d) * 0.05)).filter(loop => {
    if (loop.length < 3 || polygonArea(loop) <= 1e-6) return false;
    const mx = (loop[0].x + loop[1].x) / 2, my = (loop[0].y + loop[1].y) / 2;
    const inside = pointInPoly(mx, my, pts);
    return d > 0 ? !inside : inside;
  });
  // Der Versatz EINER Kontur liefert nie ineinanderliegende Konturen – liegt eine in einer anderen,
  // ist sie eine (fast) doppelte Kopie und fliegt raus
  loops.sort((a, b) => polygonArea(b) - polygonArea(a));
  const centre = (l: P[]) => ({ x: l.reduce((s, p) => s + p.x, 0) / l.length, y: l.reduce((s, p) => s + p.y, 0) / l.length });
  return loops.filter((l, i) => { const c = centre(l); return !loops.some((o, j) => j < i && pointInPoly(c.x, c.y, o)); });
}

/**
 * Geschlossene Kontur vereinfachen (Douglas-Peucker): Punkte, die weniger als tol von der Verbindungslinie
 * ihrer Nachbarn abweichen, fallen weg. Für die Anzeige der Fräserbreite – spart bei sehr vielen Punkten viel Zeit.
 */
export function simplifyPolygon(pts: P[], tol: number): P[] {
  if (pts.length < 8) return pts;
  // am weitesten vom ersten Punkt entfernten Punkt teilen, beide Hälften vereinfachen
  let far = 0, farD = -1;
  for (let i = 1; i < pts.length; i++) {
    const dd = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
    if (dd > farD) { farD = dd; far = i; }
  }
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[far] = 1;
  const tol2 = tol * tol, n = pts.length;
  const stack: [number, number][] = [[0, far], [far, n]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const a = pts[s], b = pts[e % n];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const p = pts[i];
      let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = p.x - a.x - t * dx, ey = p.y - a.y - t * dy;
      const d2 = ex * ex + ey * ey;
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    if (idx >= 0 && maxD > tol2) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  const out = pts.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : pts;
}

// ---------------------------------------------------------------------

function cleanPolygon(input: P[]): P[] {
  const out: P[] = [];
  for (const p of input) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-7) out.push({ x: p.x, y: p.y });
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= 1e-7) out.pop();
  return out;
}

/** raw: verschobener Linienzug; arc[k]: Strecke raw[k] → raw[k+1] gehört zu einem eingefügten Eckbogen */
function buildRawOffset(pts: P[], d: number, arcTol: number): { raw: P[]; arc: boolean[] } {
  const n = pts.length;
  // Normale nach außen (rechts der Fahrtrichtung bei gegen-Uhrzeigersinn-Kontur)
  const normals: P[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    normals.push({ x: (b.y - a.y) / len, y: -(b.x - a.x) / len });
  }

  const r = Math.abs(d);
  const maxStep = r > arcTol ? 2 * Math.acos(1 - arcTol / r) : Math.PI / 4;

  const raw: P[] = [], arc: boolean[] = [];
  const add = (q: P, isArc: boolean) => {
    const last = raw[raw.length - 1];
    if (last && Math.hypot(q.x - last.x, q.y - last.y) <= 1e-7) arc[arc.length - 1] = isArc;
    else { raw.push(q); arc.push(isArc); }
  };
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const p = pts[i];
    const n0 = normals[prev], n1 = normals[i];
    const v0 = { x: n0.x * d, y: n0.y * d };
    const v1 = { x: n1.x * d, y: n1.y * d };

    const e0 = { x: p.x - pts[prev].x, y: p.y - pts[prev].y };
    const e1 = { x: pts[(i + 1) % n].x - p.x, y: pts[(i + 1) % n].y - p.y };
    const turn = e0.x * e1.y - e0.y * e1.x; // > 0 = Linkskurve (konvexe Ecke)

    const gap = turn * d > 1e-12;
    add({ x: p.x + v0.x, y: p.y + v0.y }, gap);
    if (gap) {
      // Lücke an der Ecke -> mit Bogen um den Eckpunkt füllen
      const ang = Math.atan2(v0.x * v1.y - v0.y * v1.x, v0.x * v1.x + v0.y * v1.y);
      const steps = Math.ceil(Math.abs(ang) / maxStep);
      for (let s = 1; s < steps; s++) {
        const t = ang * s / steps;
        const c = Math.cos(t), sn = Math.sin(t);
        add({ x: p.x + v0.x * c - v0.y * sn, y: p.y + v0.x * sn + v0.y * c }, true);
      }
    }
    add({ x: p.x + v1.x, y: p.y + v1.y }, false);
  }
  while (raw.length > 1 && Math.hypot(raw[0].x - raw[raw.length - 1].x, raw[0].y - raw[raw.length - 1].y) <= 1e-7) { raw.pop(); arc.pop(); }
  return { raw, arc };
}

interface Piece { a: P; b: P; aId: number; bId: number; arc: boolean; }

/** Zerlegt den geschlossenen Linienzug an allen Selbst-Kreuzungen */
function splitAtIntersections(raw: P[], arc: boolean[]): Piece[] {
  const n = raw.length;
  const cuts: { t: number; id: number; p: P }[][] = raw.map(() => []);
  let nextId = n; // 0..n-1 = Original-Punkte, ab n = Kreuzungspunkte

  const grid = new SegmentGrid(raw);
  for (let i = 0; i < n; i++) {
    const a = raw[i], b = raw[(i + 1) % n];
    for (const j of grid.candidates(a, b)) {
      if (j <= i) continue;
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // Nachbarn teilen nur einen Punkt
      const c = raw[j], dd = raw[(j + 1) % n];
      const hit = segIntersect(a, b, c, dd);
      if (!hit) continue;
      const id = nextId++;
      cuts[i].push({ t: hit.t, id, p: hit.p });
      cuts[j].push({ t: hit.u, id, p: hit.p });
    }
  }

  const pieces: Piece[] = [];
  for (let i = 0; i < n; i++) {
    const list = cuts[i].sort((x, y) => x.t - y.t);
    let curP = raw[i], curId = i;
    for (const c of list) {
      pieces.push({ a: curP, b: c.p, aId: curId, bId: c.id, arc: arc[i] });
      curP = c.p; curId = c.id;
    }
    const endIdx = (i + 1) % n;
    pieces.push({ a: curP, b: raw[endIdx], aId: curId, bId: endIdx, arc: arc[i] });
  }
  return pieces;
}

function segIntersect(a: P, b: P, c: P, d: P): { t: number; u: number; p: P } | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-14) return null; // parallel
  const qx = c.x - a.x, qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  const eps = 1e-9;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
  return { t, u, p: { x: a.x + t * rx, y: a.y + t * ry } };
}

/**
 * Behaltene Stücke wieder zu geschlossenen Konturen verbinden.
 * tol: liegen zwei Kreuzungspunkte fast aufeinander (z. B. an der Ecke Bogen/Gerade), fällt das winzige
 * Stück dazwischen weg – dann darf am nächsten Stück weitergemacht werden, das höchstens tol entfernt beginnt.
 */
function chainPieces(pieces: Piece[], tol = 0): P[][] {
  const byStart = new Map<number, number[]>();
  pieces.forEach((pc, i) => {
    const l = byStart.get(pc.aId);
    if (l) l.push(i); else byStart.set(pc.aId, [i]);
  });
  const used = new Uint8Array(pieces.length);
  const loops: P[][] = [];

  for (let s = 0; s < pieces.length; s++) {
    if (used[s]) continue;
    const loop: P[] = [];
    let cur = s;
    const startId = pieces[s].aId;
    let ok = false;
    while (cur >= 0 && !used[cur]) {
      used[cur] = 1;
      loop.push(pieces[cur].a);
      const endId = pieces[cur].bId, endP = pieces[cur].b;
      if (endId === startId) { ok = true; break; }
      const next = byStart.get(endId);
      cur = -1;
      if (next) for (const k of next) if (!used[k]) { cur = k; break; }
      if (cur < 0 && tol > 0) {
        if (loop.length > 2 && Math.hypot(endP.x - pieces[s].a.x, endP.y - pieces[s].a.y) <= tol) { ok = true; break; }
        let best = tol;
        for (let k = 0; k < pieces.length; k++) {
          if (used[k]) continue;
          const dd = Math.hypot(pieces[k].a.x - endP.x, pieces[k].a.y - endP.y);
          if (dd <= best) { best = dd; cur = k; }
        }
      }
    }
    if (ok) loops.push(cleanPolygon(loop));
  }
  return loops;
}

/** Einfaches Raster, damit die Suche auch bei vielen Punkten schnell bleibt */
class SegmentGrid {
  private cells = new Map<number, number[]>();
  private size: number;
  private pts: P[];
  constructor(pts: P[]) {
    this.pts = pts;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const span = Math.max(maxX - minX, maxY - minY, 1e-6);
    this.size = Math.max(span / Math.max(4, Math.sqrt(pts.length) * 2), 1e-4);
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      for (const k of this.keysFor(pts[i], pts[(i + 1) % n])) {
        const l = this.cells.get(k);
        if (l) l.push(i); else this.cells.set(k, [i]);
      }
    }
  }
  private keysFor(a: P, b: P, pad = 0): number[] {
    const s = this.size;
    const x0 = Math.floor((Math.min(a.x, b.x) - pad) / s), x1 = Math.floor((Math.max(a.x, b.x) + pad) / s);
    const y0 = Math.floor((Math.min(a.y, b.y) - pad) / s), y1 = Math.floor((Math.max(a.y, b.y) + pad) / s);
    const keys: number[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(x * 1048576 + y);
    return keys;
  }
  candidates(a: P, b: P): Set<number> {
    const set = new Set<number>();
    for (const k of this.keysFor(a, b)) { const l = this.cells.get(k); if (l) for (const i of l) set.add(i); }
    return set;
  }
  /** Liegt irgendein Teil der Kontur näher als "limit" am Punkt? */
  nearerThan(px: number, py: number, limit: number): boolean {
    const n = this.pts.length;
    const keys = this.keysFor({ x: px, y: py }, { x: px, y: py }, limit);
    for (const k of keys) {
      const l = this.cells.get(k);
      if (!l) continue;
      for (const i of l) {
        if (segDist(px, py, this.pts[i], this.pts[(i + 1) % n]) < limit) return true;
      }
    }
    return false;
  }
}

function segDist(px: number, py: number, a: P, b: P): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
