/**
 * FORM VEREINFACHEN: Punkte einsparen, ohne die Form über die Toleranz hinaus zu verändern (Tests in tests/simplify.test.ts).
 *
 * Douglas-Peucker: Ein Punkt fällt nur weg, wenn er näher als die Toleranz an der neuen Geraden liegt. Da die alte Kontur
 * zwischen zwei Punkten immer eine Strecke ist, bleibt die ganze Linie im Toleranz-Schlauch, nicht nur ihre Punkte.
 * Echte Ecken werden immer behalten. Geschlossene Formen bleiben geschlossen und behalten mindestens 3 Punkte.
 * Bögen entstehen hier nicht: das macht auf Wunsch die Bogen-Glättung beim G-Code (arcFit.ts).
 */
export interface P { x: number; y: number }

/** Ab diesem Knick (Grad) gilt ein Punkt als echte Ecke */
export const CORNER_DEG = 30;

function segDistance(q: P, a: P, b: P): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  if (l2 < 1e-18) return Math.hypot(q.x - a.x, q.y - a.y);
  const u = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2));
  return Math.hypot(a.x + u * dx - q.x, a.y + u * dy - q.y);
}

/** Echte Ecke: starker Knick und beide Kanten länger als die Toleranz (kurze Kanten sind nur Rauschen) */
function isCorner(a: P, b: P, c: P, tol: number): boolean {
  const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
  if (lu <= tol || lv <= tol) return false;
  const turn = Math.atan2(Math.abs(ux * vy - uy * vx), ux * vx + uy * vy);
  return (turn * 180) / Math.PI >= CORNER_DEG;
}

/** Douglas-Peucker von Index first bis last (ohne Rekursion: Konturen können sehr lang sein) */
function dpMark(pts: P[], first: number, last: number, tol: number, keep: boolean[]) {
  const stack: [number, number][] = [[first, last]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    if (j <= i + 1) continue;
    let far = -1, farD = tol;
    for (let k = i + 1; k < j; k++) {
      const d = segDistance(pts[k], pts[i], pts[j]);
      if (d > farD) { farD = d; far = k; }
    }
    if (far >= 0) {
      keep[far] = true;
      stack.push([i, far], [far, j]);
    }
  }
}

function simplifyOpen(pts: P[], tol: number): P[] {
  const n = pts.length;
  if (n <= 2) return pts.map(p => ({ ...p }));
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = keep[n - 1] = true;
  for (let i = 1; i < n - 1; i++) if (isCorner(pts[i - 1], pts[i], pts[i + 1], tol)) keep[i] = true;
  const anchors: number[] = [];
  keep.forEach((k, i) => { if (k) anchors.push(i); });
  for (let a = 0; a < anchors.length - 1; a++) dpMark(pts, anchors[a], anchors[a + 1], tol, keep);
  return pts.filter((_, i) => keep[i]).map(p => ({ ...p }));
}

function simplifyClosed(pts: P[], tol: number): P[] {
  const n = pts.length;
  if (n <= 3) return pts.map(p => ({ ...p }));
  const corners: number[] = [];
  for (let i = 0; i < n; i++) if (isCorner(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n], tol)) corners.push(i);
  // Bezugspunkte: die Ecken; ohne Ecken zwei möglichst weit entfernte Punkte
  let anchors = corners;
  if (anchors.length < 2) {
    const a = anchors.length ? anchors[0] : farthest(pts, pts[0]);
    anchors = [a, farthest(pts, pts[a])].sort((x, y) => x - y);
  }
  // Doppelt geführte Liste, so kann der letzte Abschnitt über die Naht laufen
  const twice = [...pts, ...pts];
  const keep = new Array<boolean>(n * 2).fill(false);
  anchors.forEach(i => { keep[i] = true; });
  for (let k = 0; k < anchors.length; k++) {
    const from = anchors[k], to = k + 1 < anchors.length ? anchors[k + 1] : anchors[0] + n;
    dpMark(twice, from, to, tol, keep);
  }
  const marks = new Set<number>();
  keep.forEach((v, i) => { if (v) marks.add(i % n); });
  // Mindestens ein Dreieck: sonst fiele die Form zu einem Strich zusammen
  if (marks.size < 3) {
    const list = [...marks];
    let best = -1, bestD = -1;
    pts.forEach((q, i) => {
      if (marks.has(i)) return;
      const d = list.length >= 2 ? segDistance(q, pts[list[0]], pts[list[1]]) : Math.hypot(q.x - pts[list[0]].x, q.y - pts[list[0]].y);
      if (d > bestD) { bestD = d; best = i; }
    });
    if (best >= 0) marks.add(best);
  }
  return [...marks].sort((x, y) => x - y).map(i => ({ ...pts[i] }));
}

function farthest(pts: P[], from: P): number {
  let best = 0, d = -1;
  pts.forEach((q, i) => { const e = Math.hypot(q.x - from.x, q.y - from.y); if (e > d) { d = e; best = i; } });
  return best;
}

export function simplifyPath(pts: P[], closed: boolean, tol: number): P[] {
  return closed ? simplifyClosed(pts, tol) : simplifyOpen(pts, tol);
}

/** Größter Abstand der alten Kontur zur neuen (zum Prüfen, auch zwischen den Punkten) */
export function maxDeviation(original: P[], simplified: P[], closed: boolean, samples = 8): number {
  const seg = closed ? [...simplified, simplified[0]] : simplified;
  const src = closed ? [...original, original[0]] : original;
  let worst = 0;
  for (let i = 0; i < src.length - 1; i++) {
    for (let k = 0; k <= samples; k++) {
      const u = k / samples;
      const q = { x: src[i].x + (src[i + 1].x - src[i].x) * u, y: src[i].y + (src[i + 1].y - src[i].y) * u };
      let best = Infinity;
      for (let j = 0; j < seg.length - 1; j++) best = Math.min(best, segDistance(q, seg[j], seg[j + 1]));
      worst = Math.max(worst, best);
    }
  }
  return worst;
}
