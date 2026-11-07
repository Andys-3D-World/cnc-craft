/**
 * LINIE BEMASSEN: Klick auf eine Linie setzt ihr Längenmaß, die Zahl ändert die Länge (Rechnung, Tests in tests/lineDim.test.ts).
 *
 * Ein „Stück“ ist eine gerade Strecke; Zwischenpunkte auf derselben Geraden gehören dazu. Das Ende näher am Klick wandert,
 * das andere bleibt fest. Offene Linienzüge: alles hinter dem wandernden Ende rückt starr mit, die Winkel bleiben.
 * Geschlossene Formen: Alle Punkte auf Höhe des wandernden Endes oder dahinter rücken mit (Strecken), so bleibt aus einem
 * Rechteck ein Rechteck. Punkte dazwischen bleiben liegen.
 */
export interface P { x: number; y: number }

/** von i nach j in Zeichenrichtung; moves = Index des wandernden Endes */
export interface Segment { i: number; j: number; moves: number; length: number }

const COLLINEAR = 1e-3; // Abweichung (Sinus des Winkels), bis zu der zwei Strecken als eine Gerade gelten

function collinear(a: P, b: P, c: P): boolean {
  const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
  if (lu < 1e-9 || lv < 1e-9) return true;
  return Math.abs(ux * vy - uy * vx) / (lu * lv) < COLLINEAR && ux * vx + uy * vy > 0;
}

/** Gerades Stück der Kontur am nächsten zum Punkt; null bei weniger als 2 Punkten oder Länge 0 */
export function pickSegment(pts: P[], closed: boolean, at: P): Segment | null {
  const n = pts.length;
  if (n < 2) return null;
  const edges = closed ? n : n - 1;
  let best = -1, bestD = Infinity;
  for (let e = 0; e < edges; e++) {
    const a = pts[e], b = pts[(e + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(a.x + u * dx - at.x, a.y + u * dy - at.y);
    if (d < bestD) { bestD = d; best = e; }
  }
  // nach beiden Seiten erweitern, solange es gerade weitergeht
  let i = best, j = (best + 1) % n, steps = 0;
  while (steps < n && (closed || i > 0) && collinear(pts[(i - 1 + n) % n], pts[i], pts[j])) { i = (i - 1 + n) % n; steps++; }
  while (steps < n && (closed || j < n - 1) && collinear(pts[i], pts[j], pts[(j + 1) % n])) { j = (j + 1) % n; steps++; }
  const length = Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
  if (length < 1e-9) return null;
  const moves = Math.hypot(pts[i].x - at.x, pts[i].y - at.y) < Math.hypot(pts[j].x - at.x, pts[j].y - at.y) ? i : j;
  return { i, j, moves, length };
}

/** Indizes von i bis j in Zeichenrichtung (auch über die Naht) */
function run(n: number, i: number, j: number): number[] {
  const out = [i];
  for (let k = i; k !== j; k = (k + 1) % n) out.push((k + 1) % n);
  return out;
}

/** Neue Punktliste mit neuer Länge des Stücks; die Eingabe bleibt unberührt */
export function setSegmentLength(pts: P[], closed: boolean, seg: { i: number; j: number; moves: number }, length: number): P[] {
  const n = pts.length;
  const fixedIdx = seg.moves === seg.i ? seg.j : seg.i;
  const fixed = pts[fixedIdx], moved = pts[seg.moves];
  const old = Math.hypot(moved.x - fixed.x, moved.y - fixed.y);
  if (old < 1e-9 || !(length > 0)) return pts.map(p => ({ ...p }));
  const ux = (moved.x - fixed.x) / old, uy = (moved.y - fixed.y) / old;
  const d = length - old;
  const out = pts.map(p => ({ ...p }));
  const shift = (k: number, by: number) => { out[k].x += ux * by; out[k].y += uy * by; };
  const inside = run(n, seg.i, seg.j);
  // Zwischenpunkte auf dem Stück behalten ihren Anteil
  for (const k of inside) {
    if (k === fixedIdx || k === seg.moves) continue;
    const at = (pts[k].x - fixed.x) * ux + (pts[k].y - fixed.y) * uy;
    shift(k, (at / old) * d);
  }
  shift(seg.moves, d);
  const onSeg = new Set(inside);
  if (closed) {
    for (let k = 0; k < n; k++) {
      if (onSeg.has(k)) continue;
      const at = (pts[k].x - fixed.x) * ux + (pts[k].y - fixed.y) * uy;
      if (at >= old - 1e-6) shift(k, d);
    }
  } else {
    // offen: i < j, alles hinter dem wandernden Ende rückt mit
    if (seg.moves === seg.j) for (let k = seg.j + 1; k < n; k++) shift(k, d);
    else for (let k = 0; k < seg.i; k++) shift(k, d);
  }
  return out;
}

/** Abstand der Maßlinie: auf der Seite außerhalb der Form (Vorzeichen zur Links-Normalen von i nach j) */
export function dimSide(pts: P[], closed: boolean): number {
  if (!closed) return 1;
  let area = 0;
  for (let k = 0, m = pts.length - 1; k < pts.length; m = k++) area += pts[m].x * pts[k].y - pts[k].x * pts[m].y;
  // gegen den Uhrzeigersinn liegt das Innere links, außen also rechts
  return area > 0 ? -1 : 1;
}
