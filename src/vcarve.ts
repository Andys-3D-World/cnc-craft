/**
 * V-CARVE und INLAY (Fräse, V-Stichel)
 *
 * V-Carve: Der V-Stichel fährt Ringe im Abstand d vom Rand der Fläche ab. Je weiter der Ring vom Rand weg ist,
 * desto tiefer fährt er: Tiefe = (d − Spitzenradius) / tan(halber Spitzenwinkel). So entstehen scharfe Kanten
 * oben und spitze Ecken – wie bei Vectric. Ist die erlaubte Tiefe erreicht, bleibt der Boden flach (Ringe auf
 * gleicher Tiefe, bis die Fläche leer ist).
 *
 * Fläche = Inneres der geschlossenen Konturen nach der gerade/ungerade-Regel (Buchstaben mit Löchern, Inseln).
 * Ringe für einen Abstand d: jede Kontur um d nach innen in die Fläche verschoben; Stücke, die näher als d an
 * einer anderen Kontur liegen oder außerhalb der Fläche, fallen weg.
 *
 * Inlay: Die Tasche ist ein V-Carve mit flachem Boden (Tiefe P). Der Stecker ist die gespiegelte Form, um die
 * herum außen V-gecarvt wird – mit Start-Tiefe S (= P − Leimspalt): Am Rand fährt der Stichel schon S tief,
 * dadurch wird der Stecker oben breiter und passt umgedreht genau in die Tasche. Wände bis Tiefe S + P.
 * Alles in mm.
 */
import { offsetPolygon, polygonArea, P } from "./polyOffset";

export interface VPath { pts: P[]; closed: boolean; z: number }
export interface VOptions {
  angle: number;      // Spitzenwinkel in Grad (z. B. 60, 90)
  tipDia: number;     // Spitzen-Ø in mm (meist 0,1–0,3)
  toolDia: number;    // größter Schneiden-Ø – begrenzt die Tiefe (Kegelhöhe)
  maxDepth: number;   // größte Tiefe ab Oberfläche (positiv); darunter flacher Boden
  start: number;      // Start-Tiefe (positiv): Stecker beim Inlay, sonst 0
  step: number;       // Ring-Abstand (mm)
  outside: boolean;   // true = um die Form herum carven (Stecker), false = innen (Tasche / Schrift)
  outsideLimit?: number; // nur outside: so weit (mm) ab der Kontur wird gecarvt
}

type Seg = [P, P];

function segsOf(loops: P[][]): Seg[] {
  const out: Seg[] = [];
  for (const l of loops) for (let i = 0; i < l.length; i++) out.push([l[i], l[(i + 1) % l.length]]);
  return out;
}

/** gerade/ungerade-Regel über alle Konturen */
function insideAll(x: number, y: number, loops: P[][]): boolean {
  let c = false;
  for (const l of loops) for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
    const a = l[i], b = l[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

function distSeg(p: P, a: P, b: P): number {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Raster über die Kanten, damit Abstands- und Schnitt-Tests nicht jede Kante prüfen müssen */
class Grid {
  cell: number; map = new Map<string, Seg[]>();
  constructor(segs: Seg[], cell: number) {
    this.cell = Math.max(0.2, cell);
    for (const s of segs) this.cells(s[0], s[1], 0).forEach(k => { let a = this.map.get(k); if (!a) this.map.set(k, a = []); a.push(s); });
  }
  cells(a: P, b: P, pad: number): string[] {
    const c = this.cell, out: string[] = [];
    const x0 = Math.floor((Math.min(a.x, b.x) - pad) / c), x1 = Math.floor((Math.max(a.x, b.x) + pad) / c);
    const y0 = Math.floor((Math.min(a.y, b.y) - pad) / c), y1 = Math.floor((Math.max(a.y, b.y) + pad) / c);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(x + "," + y);
    return out;
  }
  near(a: P, b: P, pad: number): Seg[] {
    const set = new Set<Seg>();
    for (const k of this.cells(a, b, pad)) for (const s of this.map.get(k) || []) set.add(s);
    return [...set];
  }
}

function crossT(a: P, b: P, c: P, d: P): number | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  return t > 1e-9 && t < 1 - 1e-9 && u >= 0 && u <= 1 ? t : null;
}

/** Ring an allen Kreuzungen mit anderen Ringen teilen und nur Stücke behalten, deren Mitte gültig ist */
function clipRing(ring: P[], others: Grid, keep: (p: P) => boolean): { pts: P[]; closed: boolean }[] {
  const seq = [...ring, ring[0]];
  const pieces: P[][] = [];
  let cur: P[] = [seq[0]];
  let cut = false;
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1], b = seq[i];
    const ts: number[] = [];
    for (const [c, d] of others.near(a, b, 0)) {
      if ((c === a && d === b)) continue;
      const t = crossT(a, b, c, d);
      if (t !== null) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    for (const t of ts) {
      const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      cur.push(q); pieces.push(cur); cur = [q]; cut = true;
    }
    cur.push(b);
  }
  pieces.push(cur);
  if (!cut) {
    const mid = { x: (ring[0].x + ring[1].x) / 2, y: (ring[0].y + ring[1].y) / 2 };
    return keep(mid) ? [{ pts: ring, closed: true }] : [];
  }
  // erstes und letztes Stück hängen am Startpunkt zusammen
  if (pieces.length > 1) { const last = pieces.pop()!; pieces[0] = last.concat(pieces[0].slice(1)); }
  const out: { pts: P[]; closed: boolean }[] = [];
  for (const p of pieces) {
    if (p.length < 2) continue;
    const k = Math.floor((p.length - 1) / 2);
    const mid = { x: (p[k].x + p[k + 1].x) / 2, y: (p[k].y + p[k + 1].y) / 2 };
    if (keep(mid)) out.push({ pts: p, closed: false });
  }
  return out;
}

/** Ringe einer Ebene zu wenigen langen Zügen verbinden (Enden, die sich berühren) */
function chain(pieces: { pts: P[]; closed: boolean }[]): { pts: P[]; closed: boolean }[] {
  const open = pieces.filter(p => !p.closed).map(p => p.pts.slice());
  const out = pieces.filter(p => p.closed);
  const close = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-4;
  while (open.length) {
    let cur = open.pop()!, grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const q = open[i];
        if (close(cur[cur.length - 1], q[0])) cur = cur.concat(q.slice(1));
        else if (close(cur[cur.length - 1], q[q.length - 1])) cur = cur.concat(q.slice(0, -1).reverse());
        else continue;
        open.splice(i, 1); grew = true; break;
      }
    }
    const closed = cur.length > 3 && close(cur[0], cur[cur.length - 1]);
    out.push({ pts: closed ? cur.slice(0, -1) : cur, closed });
  }
  return out;
}

/**
 * Bahnen für V-Carve bzw. Inlay-Stecker. loops = alle geschlossenen Konturen der Fläche (Löcher eingeschlossen).
 * Rückgabe: Bahnen mit ihrer Tiefe (z negativ), von außen (flach) nach innen (tief) sortiert.
 */
export function vcarvePaths(loops: P[][], o: VOptions): { paths: VPath[]; flat: boolean } {
  const half = (Math.max(10, Math.min(170, o.angle)) / 2) * Math.PI / 180, tan = Math.tan(half);
  const tipR = Math.max(0, o.tipDia) / 2;
  const coneH = Math.max(0.1, (Math.max(o.toolDia, o.tipDia + 0.1) / 2 - tipR) / tan);
  const maxD = Math.min(o.maxDepth, o.start + coneH);
  const step = Math.max(0.03, o.step);
  const clean = loops.filter(l => l.length >= 3 && Math.abs(polygonArea(l)) > 1e-6);
  if (!clean.length) return { paths: [], flat: false };
  const base = segsOf(clean);
  let ext = 0;
  for (const l of clean) for (const p of l) ext = Math.max(ext, Math.abs(p.x), Math.abs(p.y));
  const baseGrid = new Grid(base, 2);
  /** kleinster Abstand zu allen Konturen (nur Kanten in der Nähe; weiter weg ist sicher > lim) */
  const dist = (p: P, lim: number) => {
    let m = Infinity;
    for (const [a, b] of baseGrid.near(p, p, lim + 0.01)) m = Math.min(m, distSeg(p, a, b));
    return m;
  };
  const depthAt = (d: number) => o.start + Math.max(0, d - tipR) / tan;
  // Abstand, ab dem die Tiefe begrenzt ist; danach flacher Boden (Tasche) bzw. Ende (Stecker)
  const dFlat = tipR + Math.max(0, maxD - o.start) * tan;
  const floorStep = Math.max(step, 0.4 * tan);
  const paths: VPath[] = [];
  let flat = false;
  let d = tipR + step * 0.5;
  const dEnd = o.outside ? Math.min(dFlat, o.outsideLimit ?? dFlat) : Infinity;
  for (let guard = 0; guard < 4000 && d <= dEnd + 1e-9; guard++) {
    // Konturen in die Fläche hinein verschieben: Innen = mit der Orientierung, außen = dagegen
    const rings: P[][] = [];
    for (const l of clean) {
      const ccw = polygonArea(l) > 0;
      // Liegt der Punkt gleich links neben der Kante in der Fläche? Dann zeigt „innen“ dorthin.
      const a = l[0], b = l[1], len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const probe = { x: (a.x + b.x) / 2 - ((b.y - a.y) / len) * 1e-3, y: (a.y + b.y) / 2 + ((b.x - a.x) / len) * 1e-3 };
      const leftIn = insideAll(probe.x, probe.y, clean) !== o.outside;
      // offsetPolygon: d > 0 = nach außen (bezogen auf die Kontur selbst)
      const towardLeft = ccw ? -d : d;
      rings.push(...offsetPolygon(l, leftIn ? towardLeft : -towardLeft, 0.01));
    }
    if (!rings.length) break;
    const ringGrid = new Grid(segsOf(rings), Math.max(0.5, d));
    const tol = Math.min(step * 0.3, 0.05);
    const keep = (p: P) => insideAll(p.x, p.y, clean) !== o.outside && dist(p, d) >= d - tol;
    const kept = chain(rings.flatMap(r => clipRing(r, ringGrid, keep)));
    if (!kept.length) break;
    const depth = Math.min(maxD, depthAt(d));
    if (depth >= maxD - 1e-6 && d > dFlat + 1e-6) flat = true;
    for (const k of kept) if (k.pts.length >= 2) paths.push({ pts: k.pts, closed: k.closed, z: -depth });
    d += d >= dFlat ? floorStep : step;
    if (d > ext * 4 + 1000) break;
  }
  return { paths, flat };
}

/** Konturen spiegeln (an der senkrechten Achse durch x0) – für den Inlay-Stecker */
export function mirrorX<T extends { x: number }>(pts: T[], x0: number): T[] {
  return pts.map(p => ({ ...p, x: 2 * x0 - p.x })).reverse();
}
