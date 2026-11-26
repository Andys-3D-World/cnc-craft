/**
 * VERBINDEN, AUFLÖSEN, STRECKEN – nur Rechnung (mit `npm test` prüfbar). Befehle: commands.ts / cmdLine.ts
 *
 *   Verbinden (Join)   offene Linien, deren Enden sich treffen (Abstand ≤ tol), werden zu einem Linienzug; treffen sich
 *                      Anfang und Ende des Zugs, ist er geschlossen. Was nicht passt, bleibt, wie es ist.
 *   Auflösen (Explode) ein Linienzug wird in seine einzelnen Strecken zerlegt.
 *   Strecken (Stretch) alle Punkte in einem Rechteck wandern um (dx, dy), die anderen bleiben – Formen werden länger/kürzer.
 */
export interface P { x: number; y: number }
export interface Chain<T> { pts: P[]; closed: boolean; from: T[] }

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

/** Offene Wege zu Ketten verbinden (Reihenfolge und Richtung werden passend gedreht) */
export function joinOpen<T>(items: { ref: T; pts: P[] }[], tol: number): Chain<T>[] {
  const left = items.filter(i => i.pts.length >= 2).map(i => ({ ref: i.ref, pts: i.pts.map(p => ({ ...p })) }));
  const out: Chain<T>[] = [];
  while (left.length) {
    const first = left.shift()!;
    let pts = first.pts;
    const from = [first.ref];
    let grew = true;
    while (grew) {
      grew = false;
      if (dist(pts[0], pts[pts.length - 1]) <= tol && pts.length >= 3) break; // schon geschlossen
      for (let k = 0; k < left.length; k++) {
        const q = left[k].pts, head = pts[0], tail = pts[pts.length - 1];
        let add: P[] | null = null, atEnd = true;
        if (dist(tail, q[0]) <= tol) add = q;
        else if (dist(tail, q[q.length - 1]) <= tol) add = [...q].reverse();
        else if (dist(head, q[q.length - 1]) <= tol) { add = q; atEnd = false; }
        else if (dist(head, q[0]) <= tol) { add = [...q].reverse(); atEnd = false; }
        if (!add) continue;
        pts = atEnd ? [...pts, ...add.slice(1)] : [...add.slice(0, -1), ...pts];
        from.push(left[k].ref);
        left.splice(k, 1);
        grew = true;
        break;
      }
    }
    const closed = pts.length >= 3 && dist(pts[0], pts[pts.length - 1]) <= tol;
    out.push({ pts: closed ? pts.slice(0, -1) : pts, closed, from });
  }
  return out;
}

/** Linienzug in einzelne Strecken zerlegen (doppelte Punkte übersprungen) */
export function explodePath(pts: P[], closed: boolean): [P, P][] {
  const out: [P, P][] = [];
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if (dist(a, b) > 1e-9) out.push([{ ...a }, { ...b }]);
  }
  return out;
}

export interface Box { x0: number; y0: number; x1: number; y1: number }
export const inBox = (p: P, b: Box) => p.x >= Math.min(b.x0, b.x1) && p.x <= Math.max(b.x0, b.x1) && p.y >= Math.min(b.y0, b.y1) && p.y <= Math.max(b.y0, b.y1);

/** Punkte im Rechteck um (dx, dy) verschieben; null = kein Punkt im Rechteck */
export function stretchPoints(pts: P[], box: Box, dx: number, dy: number): P[] | null {
  let hit = false;
  const out = pts.map(p => { if (!inBox(p, box)) return { ...p }; hit = true; return { x: p.x + dx, y: p.y + dy }; });
  return hit ? out : null;
}

/** Skalieren mit Bezugsmaß: Faktor aus alter und neuer Länge (null = ungültig) */
export function refFactor(refLen: number, newLen: number): number | null {
  return refLen > 1e-12 && newLen > 0 && Number.isFinite(refLen) && Number.isFinite(newLen) ? newLen / refLen : null;
}

/** Ortho: Punkt waagerecht oder senkrecht zum Bezugspunkt ausrichten (je nachdem, was näher liegt) */
export function orthoPoint(from: P, p: P): P {
  return Math.abs(p.x - from.x) >= Math.abs(p.y - from.y) ? { x: p.x, y: from.y } : { x: from.x, y: p.y };
}
