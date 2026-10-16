/**
 * GEMEINSAME HELFER FÜR ALLE DATEI-IMPORTE
 *
 * Alle Importer liefern ihr Ergebnis in Millimetern mit Y nach OBEN
 * (wie an der Maschine). Kurven werden in kurze Geraden zerlegt,
 * Kreise bleiben als echte Kreise erhalten (werden dann mit G2 gefräst).
 */

export interface Pt { x: number; y: number; }
export interface ImpPath { pts: Pt[]; closed: boolean; }
export interface ImpCircle { cx: number; cy: number; r: number; }
export interface ImpText { text: string; x: number; y: number; height: number; rotation: number; font?: string; }

export interface ImportResult {
  paths: ImpPath[];
  circles: ImpCircle[];
  texts: ImpText[];
  warnings: string[];
  info: string;
}

export function emptyResult(): ImportResult {
  return { paths: [], circles: [], texts: [], warnings: [], info: "" };
}

/** Maximale Abweichung beim Zerlegen von Kurven in Geraden (mm) */
export const CURVE_TOL = 0.01;

// =====================================================================
// 2D-MATRIX:  x' = a*x + c*y + e,  y' = b*x + d*y + f   (wie in SVG/PDF)
// =====================================================================

export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function matMul(m: Mat, n: Mat): Mat {
  // Ergebnis: erst n, dann m anwenden
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}

export function matApply(m: Mat, x: number, y: number): Pt {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function matTranslate(tx: number, ty: number): Mat { return [1, 0, 0, 1, tx, ty]; }
export function matScale(sx: number, sy: number): Mat { return [sx, 0, 0, sy, 0, 0]; }
export function matRotate(rad: number): Mat {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}

/** Mittlerer Vergrößerungsfaktor einer Matrix (für Kurven-Genauigkeit) */
export function matScaleFactor(m: Mat): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

/** Ist die Matrix ohne Verzerrung (Kreise bleiben Kreise)? */
export function matIsUniform(m: Mat): boolean {
  const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
  const dot = m[0] * m[2] + m[1] * m[3];
  return Math.abs(sx - sy) < 1e-6 * Math.max(sx, sy) && Math.abs(dot) < 1e-6 * sx * sy;
}

// =====================================================================
// KURVEN ZERLEGEN
// =====================================================================

/** Kubische Bézierkurve (ohne Startpunkt). tol in denselben Einheiten wie die Punkte. */
export function flattenCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, tol: number): Pt[] {
  const ddx = Math.max(Math.abs(p0.x - 2 * p1.x + p2.x), Math.abs(p1.x - 2 * p2.x + p3.x));
  const ddy = Math.max(Math.abs(p0.y - 2 * p1.y + p2.y), Math.abs(p1.y - 2 * p2.y + p3.y));
  const n = Math.min(500, Math.max(1, Math.ceil(Math.sqrt((0.75 * Math.hypot(ddx, ddy)) / tol))));
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
    });
  }
  return out;
}

/** Quadratische Bézierkurve (ohne Startpunkt) */
export function flattenQuad(p0: Pt, p1: Pt, p2: Pt, tol: number): Pt[] {
  const dd = Math.hypot(p0.x - 2 * p1.x + p2.x, p0.y - 2 * p1.y + p2.y);
  const n = Math.min(500, Math.max(1, Math.ceil(Math.sqrt((0.25 * dd) / tol))));
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y });
  }
  return out;
}

/** Anzahl Teilstücke für einen Bogen mit Radius r und Winkel sweep */
export function arcSegments(r: number, sweep: number, tol: number): number {
  if (r <= tol) return Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 4)));
  const step = 2 * Math.acos(Math.max(-1, 1 - tol / r));
  return Math.min(2000, Math.max(2, Math.ceil(Math.abs(sweep) / step)));
}

/** Kreisbogen ab Winkel a0 um "sweep" (Bogenmaß, positiv = gegen Uhrzeigersinn). Mit Startpunkt. */
export function arcPoints(cx: number, cy: number, r: number, a0: number, sweep: number, tol: number): Pt[] {
  const n = arcSegments(r, sweep, tol);
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

/** Ellipsenbogen: Mitte, Hauptachse (Vektor), Verhältnis Nebenachse, Parameter t0..t1 */
export function ellipsePoints(cx: number, cy: number, mx: number, my: number, ratio: number, t0: number, t1: number, tol: number): Pt[] {
  const a = Math.hypot(mx, my), b = a * ratio;
  const rot = Math.atan2(my, mx);
  let sweep = t1 - t0;
  const n = arcSegments(Math.max(a, b), sweep, tol);
  const out: Pt[] = [];
  const cr = Math.cos(rot), sr = Math.sin(rot);
  for (let i = 0; i <= n; i++) {
    const t = t0 + (sweep * i) / n;
    const x = a * Math.cos(t), y = b * Math.sin(t);
    out.push({ x: cx + x * cr - y * sr, y: cy + x * sr + y * cr });
  }
  return out;
}

/**
 * DXF-"Bulge" (Wölbung zwischen zwei Polylinien-Punkten) in Punkte umwandeln.
 * bulge = tan(Winkel/4), positiv = gegen den Uhrzeigersinn. Ohne Startpunkt.
 */
export function bulgePoints(p0: Pt, p1: Pt, bulge: number, tol: number): Pt[] {
  if (Math.abs(bulge) < 1e-9) return [p1];
  const chord = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (chord < 1e-12) return [p1];
  const theta = 4 * Math.atan(bulge);              // Öffnungswinkel mit Vorzeichen
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  // Mittelpunkt: auf der Mittelsenkrechten
  const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
  const d = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
  const nx = -(p1.y - p0.y) / chord, ny = (p1.x - p0.x) / chord; // links der Sehne
  const side = (bulge > 0) === (Math.abs(theta) < Math.PI) ? 1 : -1;
  const cx = mx + nx * d * side, cy = my + ny * d * side;
  const a0 = Math.atan2(p0.y - cy, p0.x - cx);
  const pts = arcPoints(cx, cy, r, a0, theta, tol);
  pts.shift();
  pts[pts.length - 1] = { ...p1 }; // exakt auf dem Endpunkt landen
  return pts;
}

// =====================================================================
// EINZELNE LINIEN ZU KONTUREN VERBINDEN
// (DXF-Dateien bestehen oft aus vielen einzelnen Linien und Bögen)
// =====================================================================

export function joinPaths(paths: ImpPath[], tol: number): ImpPath[] {
  const done: ImpPath[] = [];
  let open: Pt[][] = [];

  for (const p of paths) {
    const pts = dedupe(p.pts, tol * 0.01);
    if (pts.length < 2) continue;
    if (p.closed) { done.push({ pts, closed: true }); continue; }
    // Offene Linie, deren Enden sich treffen -> geschlossen
    if (pts.length > 2 && dist(pts[0], pts[pts.length - 1]) <= tol) {
      pts.pop();
      done.push({ pts, closed: true });
      continue;
    }
    open.push(pts);
  }

  // Raster über die Endpunkte, damit es auch bei tausenden Linien schnell bleibt
  const cell = Math.max(tol * 4, 1e-6);
  const key = (p: Pt) => `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
  const index = new Map<string, Set<number>>();
  const addIdx = (i: number) => {
    for (const p of [open[i][0], open[i][open[i].length - 1]]) {
      const k = key(p);
      if (!index.has(k)) index.set(k, new Set());
      index.get(k)!.add(i);
    }
  };
  const delIdx = (i: number) => {
    for (const p of [open[i][0], open[i][open[i].length - 1]]) index.get(key(p))?.delete(i);
  };
  open.forEach((_, i) => addIdx(i));
  const alive = open.map(() => true);

  const findNear = (p: Pt, self: number): { j: number; atStart: boolean } | null => {
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
    let best: { j: number; atStart: boolean } | null = null;
    let bestD = tol;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const set = index.get(`${cx + dx},${cy + dy}`);
      if (!set) continue;
      for (const j of set) {
        if (j === self || !alive[j]) continue;
        const a = open[j][0], b = open[j][open[j].length - 1];
        const da = dist(p, a), db = dist(p, b);
        if (da <= bestD) { bestD = da; best = { j, atStart: true }; }
        if (db <= bestD) { bestD = db; best = { j, atStart: false }; }
      }
    }
    return best;
  };

  for (let i = 0; i < open.length; i++) {
    if (!alive[i]) continue;
    let chain = open[i];
    delIdx(i);
    alive[i] = false;
    let grew = true;
    while (grew) {
      grew = false;
      // am Ende anhängen
      const e = findNear(chain[chain.length - 1], -1);
      if (e) {
        let seg = open[e.j];
        delIdx(e.j); alive[e.j] = false;
        if (!e.atStart) seg = seg.slice().reverse();
        chain = chain.concat(seg.slice(1));
        grew = true;
        continue;
      }
      // vorne anhängen
      const s = findNear(chain[0], -1);
      if (s) {
        let seg = open[s.j];
        delIdx(s.j); alive[s.j] = false;
        if (s.atStart) seg = seg.slice().reverse();
        chain = seg.slice(0, -1).concat(chain);
        grew = true;
      }
    }
    if (chain.length > 2 && dist(chain[0], chain[chain.length - 1]) <= tol) {
      chain.pop();
      done.push({ pts: chain, closed: true });
    } else {
      done.push({ pts: chain, closed: false });
    }
  }
  return done;
}

function dist(a: Pt, b: Pt) { return Math.hypot(a.x - b.x, a.y - b.y); }

function dedupe(pts: Pt[], eps: number): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const l = out[out.length - 1];
    if (!l || dist(l, p) > eps) out.push({ x: p.x, y: p.y });
  }
  return out;
}

export function resultBounds(r: ImportResult) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const p of r.paths) for (const q of p.pts) add(q.x, q.y);
  for (const c of r.circles) { add(c.cx - c.r, c.cy - c.r); add(c.cx + c.r, c.cy + c.r); }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

/** Text-Datei dekodieren: erst UTF-8, bei Fehlern Windows-1252 (ältere DXF-Dateien) */
export function decodeText(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("windows-1252").decode(bytes); }
}
