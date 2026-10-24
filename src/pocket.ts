/**
 * TASCHE FRÄSEN: Bahnen, die die ganze Fläche innerhalb einer Kontur abtragen.
 *
 *  - „Parallel“ (linear): Zickzack-Bahnen quer durch die Tasche, danach eine Schlichtbahn an der Wand
 *  - „Kontur“ (spiral):   Ringe im Abstand der Zustellung von innen nach außen, zuletzt die Wand
 *  - „Adaptiv“ (adaptive): gleichmäßige Umschlingung mit Schleifen und Helix-Einstieg (adaptive.ts)
 *
 * Inseln (Formen innerhalb der Tasche, z. B. Text) bleiben stehen: um sie herum wird nur gefräst.
 * Alles in mm. Der Fräsermittelpunkt bleibt immer mindestens den Werkzeugradius von Wand und Inseln weg.
 */
import { offsetPolygon, pointInPoly, P } from "./polyOffset";
import { adaptivePaths } from "./adaptive";

/** helix: schraubenförmig um (x, y) mit Radius r eintauchen statt senkrecht (nur „Adaptiv“) */
export interface PocketPath { pts: P[]; closed: boolean; helix?: { x: number; y: number; r: number } }
export type PocketStrategy = "linear" | "spiral" | "adaptive";

type Edge = [P, P];

function edgesOf(loops: P[][]): Edge[] {
  const out: Edge[] = [];
  for (const l of loops) for (let i = 0; i < l.length; i++) out.push([l[i], l[(i + 1) % l.length]]);
  return out;
}

/** Schnittpunkt-Anteil t auf Strecke a→b mit Strecke c→d (nur echte Kreuzungen) */
function crossT(a: P, b: P, c: P, d: P): number | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  return t > 1e-9 && t < 1 - 1e-9 && u >= 0 && u <= 1 ? t : null;
}

/** Linie an allen Kreuzungen mit den Kanten teilen, nur Stücke behalten, deren Mitte erlaubt ist */
function clip(pts: P[], closed: boolean, edges: Edge[], keep: (p: P) => boolean): PocketPath[] {
  const seq = closed ? [...pts, pts[0]] : pts;
  const pieces: P[][] = [];
  let cur: P[] = [seq[0]];
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1], b = seq[i];
    const ts: number[] = [];
    for (const [c, d] of edges) { const t = crossT(a, b, c, d); if (t !== null) ts.push(t); }
    ts.sort((x, y) => x - y);
    for (const t of ts) {
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      cur.push(p);
      pieces.push(cur);
      cur = [p];
    }
    cur.push(b);
  }
  pieces.push(cur);
  // ein geschlossener Ring ohne Kreuzung bleibt geschlossen
  if (closed && pieces.length === 1) return keep(mid(pieces[0])) ? [{ pts: pts.slice(), closed: true }] : [];
  // bei einem Ring gehören das letzte und das erste Stück zusammen
  if (closed && pieces.length > 1) { const last = pieces.pop()!; pieces[0] = last.concat(pieces[0].slice(1)); }
  return pieces.filter(p => p.length >= 2 && keep(mid(p))).map(p => ({ pts: p, closed: false }));
}

/** Punkt in der Mitte der Linie (nach Länge) */
function mid(p: P[]): P {
  let len = 0;
  for (let i = 1; i < p.length; i++) len += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  let half = len / 2;
  for (let i = 1; i < p.length; i++) {
    const l = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    if (l >= half && l > 0) { const t = half / l; return { x: p[i - 1].x + (p[i].x - p[i - 1].x) * t, y: p[i - 1].y + (p[i].y - p[i - 1].y) * t }; }
    half -= l;
  }
  return p[0];
}

/**
 * @param outer     Wand der Tasche (geschlossen, mm)
 * @param islands   Inseln, die stehen bleiben (geschlossen, mm)
 * @param r         Werkzeugradius
 * @param step      seitliche Zustellung (Abstand der Bahnen)
 * @returns Bahnen in Fräs-Reihenfolge; tooBig = Werkzeug passt nicht in die Tasche
 */
/** Nur die Wand-Bahnen (Wand + Inseln, Fräsermittelpunkt im Abstand r) – für den Schlichtgang */
export function pocketWallPaths(outer: P[], islands: P[][], r: number): PocketPath[] {
  const wall = offsetPolygon(outer, -r, 0.01);
  const isl = islands.flatMap(i => offsetPolygon(i, r, 0.01));
  const inWall = (p: P) => wall.some(w => pointInPoly(p.x, p.y, w));
  const inIsl = (p: P, skip?: P[]) => isl.some(i => i !== skip && pointInPoly(p.x, p.y, i));
  return [
    ...wall.flatMap(w => clip(w, true, edgesOf(isl), p => !inIsl(p))),
    ...isl.flatMap(i => clip(i, true, edgesOf([...wall, ...isl.filter(o => o !== i)]), p => inWall(p) && !inIsl(p, i)))
  ];
}

export function pocketPaths(outer: P[], islands: P[][], r: number, step: number, strategy: PocketStrategy): { paths: PocketPath[]; tooBig: boolean } {
  const wall = offsetPolygon(outer, -r, 0.01);              // Grenze für den Fräsermittelpunkt
  if (!wall.length) return { paths: [], tooBig: true };
  const isl = islands.flatMap(i => offsetPolygon(i, r, 0.01)); // Inseln + Werkzeugradius
  const edges = edgesOf([...wall, ...isl]);
  const inWall = (p: P) => wall.some(w => pointInPoly(p.x, p.y, w));
  const inIsl = (p: P, skip?: P[]) => isl.some(i => i !== skip && pointInPoly(p.x, p.y, i));
  const allowed = (p: P) => inWall(p) && !inIsl(p);

  // Schlichtbahn: Wand ohne die Stücke in Inseln, dann die Inseln ohne Stücke außerhalb der Wand
  const finish: PocketPath[] = [
    ...wall.flatMap(w => clip(w, true, edgesOf(isl), p => !inIsl(p))),
    ...isl.flatMap(i => clip(i, true, edgesOf([...wall, ...isl.filter(o => o !== i)]), p => inWall(p) && !inIsl(p, i)))
  ];

  const rough: PocketPath[] = [];
  if (strategy === "adaptive") {
    rough.push(...adaptivePaths(outer, islands, r, wall, isl, clip));
  } else if (strategy === "spiral") {
    // Ringe immer weiter nach innen (bzw. um die Inseln nach außen), bis nichts mehr übrig ist
    const levels: PocketPath[][] = [];
    for (let k = 1; k < 2000; k++) {
      const d = r + k * step;
      const rings = [...offsetPolygon(outer, -d, 0.01), ...islands.flatMap(i => offsetPolygon(i, d, 0.01))];
      const kept = rings.flatMap(g => clip(g, true, edges, allowed));
      if (!kept.length) break;
      levels.push(kept);
    }
    levels.reverse().forEach(l => rough.push(...l)); // von innen nach außen
  } else {
    // Zickzack: waagerechte Bahnen, Verbindung zur nächsten Bahn ohne Absetzen, wenn der Weg frei ist
    let y0 = Infinity, y1 = -Infinity;
    for (const w of wall) for (const p of w) { y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    const n = Math.max(1, Math.ceil((y1 - y0) / step));
    const dy = (y1 - y0) / n;
    let cur: P[] | null = null, flip = false;
    for (let k = 0; k <= n; k++) {
      const y = Math.min(y1, y0 + k * dy) + (k === 0 ? 1e-6 : k === n ? -1e-6 : 0);
      const xs: number[] = [];
      for (const [a, b] of edges) {
        if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
      xs.sort((a, b) => a - b);
      const spans: [number, number][] = [];
      for (let i = 0; i + 1 < xs.length; i++) {
        if (xs[i + 1] - xs[i] > 1e-6 && allowed({ x: (xs[i] + xs[i + 1]) / 2, y })) spans.push([xs[i], xs[i + 1]]);
      }
      if (flip) spans.reverse();
      for (const [a, b] of spans) {
        const s = flip ? { x: b, y } : { x: a, y }, e = flip ? { x: a, y } : { x: b, y };
        const last = cur ? cur[cur.length - 1] : null;
        const free = last && Math.abs(last.y - y) > 1e-9 && Math.abs(last.y - y) <= dy * 1.01
          && !edges.some(([c, d]) => crossT(last, s, c, d) !== null) && allowed({ x: (last.x + s.x) / 2, y: (last.y + s.y) / 2 });
        if (cur && free) cur.push(s, e);
        else { if (cur) rough.push({ pts: cur, closed: false }); cur = [s, e]; }
      }
      if (spans.length) flip = !flip;
    }
    if (cur) rough.push({ pts: cur, closed: false });
  }
  return { paths: [...rough, ...finish], tooBig: false };
}
