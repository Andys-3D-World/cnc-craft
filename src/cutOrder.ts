/**
 * SCHNITT-REIHENFOLGE OPTIMIEREN (Laser, Plasma)
 *
 * Ziel: möglichst kurze Leerfahrten (G0) zwischen den Konturen einer Ebene / eines Schnitts.
 *
 *   1. Nächster Nachbar: vom aktuellen Punkt aus immer die Kontur, deren Einstieg am nächsten liegt.
 *   2. 2-opt: Stücke der Reihenfolge umdrehen, solange die Leerfahrten dadurch kürzer werden
 *      (mit Zeitgrenze – bei sehr vielen Teilen wird früher aufgehört, das Ergebnis bleibt gültig).
 *   3. Startpunkte: geschlossene Konturen ohne festen Start (Laser ohne Freischnitt/Haltestege)
 *      beginnen an dem Punkt, der zwischen Vorgänger und Nachfolger am günstigsten liegt.
 *
 * Feste Regeln, die nie gebrochen werden:
 *   - Was in einer geschlossenen Kontur liegt (Loch, Gravur, kleines Teil im Loch), kommt vor ihr –
 *     sonst fällt das Teil heraus, bevor es fertig ist. Gilt über beliebig viele Ebenen.
 *   - Einstiege mit Anfahrbahn / Einstichpunkt (Plasma, Laser-Freischnitt) bleiben, wo sie sind.
 *   - Ebenen- und Schnitt-Reihenfolge: es wird immer nur innerhalb EINER Ebene sortiert.
 *
 * Warum TypeScript und nicht Rust: der ganze CAM-Teil (Konturen, Anfahrbahnen, G-Code) läuft hier.
 * In Rust müssten alle Konturen hin- und zurückgeschickt werden; die Rechnung selbst dauert nur
 * Millisekunden. Bewusst ohne Laufzeit-Importe (nur Typen): Tests laufen direkt mit `node --test`.
 */
import type { Pt } from "./shapeTransform";

export interface CutItem {
  entry: Pt;            // Einstieg (Einstich / erster Punkt)
  exit: Pt;             // wo der Kopf danach steht
  pts: Pt[];            // Kontur (für "liegt in" und als mögliche Startpunkte)
  closed: boolean;      // geschlossen -> umschließt andere Konturen
  freeStart?: boolean;  // geschlossen und Start darf auf jeden Punkt der Kontur wandern
  reversible?: boolean; // offene Linie darf auch rückwärts gefahren werden
}

export interface CutStep {
  index: number;    // Index in der Eingabe-Liste
  reversed: boolean; // offene Linie rückwärts fahren
  start: number;    // freier Start: Index des Startpunkts in pts (sonst 0)
}

const SAMPLE = 16;       // so viele Punkte je Kontur reichen für die grobe Auswahl beim nächsten Nachbarn
const TOL = 1e-6;

/**
 * Reihenfolge für die Konturen einer Ebene. `from` = wo der Kopf vorher steht.
 * `timeMs` begrenzt die Rechenzeit für 2-opt (der nächste Nachbar läuft immer ganz durch).
 */
export function optimizeCutOrder(items: CutItem[], from: Pt, timeMs = 150): CutStep[] {
  const n = items.length;
  if (!n) return [];
  const t0 = now();
  const preds = precedence(items);
  const rev = new Array<boolean>(n).fill(false);
  const start = new Array<number>(n).fill(0);
  const entryOf = (i: number): Pt => items[i].freeStart ? items[i].pts[start[i]] : rev[i] ? items[i].exit : items[i].entry;
  const exitOf = (i: number): Pt => items[i].freeStart ? items[i].pts[start[i]] : rev[i] ? items[i].entry : items[i].exit;

  // ---- 1. nächster Nachbar (nur Konturen, deren "Innenleben" schon fertig ist) ----
  const left = preds.map(p => p.length);
  const succ: number[][] = items.map(() => []);
  preds.forEach((p, b) => p.forEach(a => succ[a].push(b)));
  const avail: number[] = [];
  for (let i = 0; i < n; i++) if (!left[i]) avail.push(i);
  const order: number[] = [];
  let pos = from;
  while (avail.length) {
    let bestK = 0, bestD = Infinity;
    for (let k = 0; k < avail.length; k++) {
      const d = roughDist(items[avail[k]], pos);
      if (d < bestD) { bestD = d; bestK = k; }
    }
    const i = avail[bestK];
    avail[bestK] = avail[avail.length - 1];
    avail.pop();
    const it = items[i];
    if (it.freeStart) start[i] = nearestIdx(it.pts, pos);
    else if (it.reversible) rev[i] = dist(pos, it.exit) < dist(pos, it.entry) - TOL;
    order.push(i);
    pos = exitOf(i);
    for (const b of succ[i]) if (--left[b] === 0) avail.push(b);
  }
  if (order.length < n) return items.map((_, i) => ({ index: i, reversed: false, start: 0 })); // (kann nicht passieren: keine Kreise)

  // ---- 2. 2-opt + 3. Startpunkte, solange Zeit ist ----
  for (let round = 0; round < 4; round++) {
    const better = twoOpt(order, items, preds, rev, entryOf, exitOf, from, t0 + timeMs);
    const moved = placeStarts(order, items, start, entryOf, exitOf, from);
    if (!better && !moved) break;
    if (now() > t0 + timeMs) break;
  }
  return order.map(i => ({ index: i, reversed: rev[i], start: start[i] }));
}

/** Summe der Leerfahrten (gerade Linien) für eine Reihenfolge – für Tests und den G-Code-Kommentar */
export function travelLength(items: CutItem[], steps: CutStep[], from: Pt): number {
  let pos = from, sum = 0;
  for (const s of steps) {
    const it = items[s.index];
    const e = it.freeStart ? it.pts[s.start] : s.reversed ? it.exit : it.entry;
    const x = it.freeStart ? it.pts[s.start] : s.reversed ? it.entry : it.exit;
    sum += dist(pos, e);
    pos = x;
  }
  return sum;
}

/** Konturpunkte ab dem gewählten Start (geschlossen) bzw. rückwärts (offen) */
export function orientPts(it: CutItem, s: CutStep): Pt[] {
  if (it.freeStart && s.start > 0) {
    let loop = it.pts;
    if (loop.length > 1 && dist(loop[0], loop[loop.length - 1]) < TOL) loop = loop.slice(0, -1);
    return loop.slice(s.start).concat(loop.slice(0, s.start));
  }
  return s.reversed ? it.pts.slice().reverse() : it.pts;
}

/**
 * Wer muss vor wem? preds[b] = alle Konturen, die in der geschlossenen Kontur b liegen.
 * "Liegt in": Rahmen ganz innerhalb, kleinere Fläche und erster Punkt in der Kontur.
 */
function precedence(items: CutItem[]): number[][] {
  const n = items.length;
  const box = items.map(it => bbox(it.pts));
  const area = items.map(it => it.closed ? Math.abs(polyArea(it.pts)) : 0);
  const preds: number[][] = items.map(() => []);
  for (let b = 0; b < n; b++) {
    if (!items[b].closed || items[b].pts.length < 3) continue;
    const B = box[b];
    for (let a = 0; a < n; a++) {
      if (a === b || !(area[a] < area[b] - TOL)) continue;
      const A = box[a];
      if (A[0] < B[0] - TOL || A[1] < B[1] - TOL || A[2] > B[2] + TOL || A[3] > B[3] + TOL) continue;
      if (anyInside(items[a].pts, items[b].pts)) preds[b].push(a);
    }
  }
  return preds;
}

/** Liegt die Kontur a in b? Ein paar Punkte von a prüfen (einer kann genau auf dem Rand liegen) */
function anyInside(a: Pt[], b: Pt[]): boolean {
  const step = Math.max(1, Math.floor(a.length / 3));
  for (let i = 0; i < a.length; i += step) if (pointInPoly(a[i].x, a[i].y, b)) return true;
  return false;
}

/**
 * 2-opt: Abschnitt i..j umdrehen, wenn die Leerfahrten kürzer werden. Offene Linien werden im
 * umgedrehten Abschnitt mit umgedreht, feste Einstiege bleiben. Verboten, wenn im Abschnitt eine
 * Kontur und etwas darin liegen (das Innere käme sonst nach der Kontur).
 */
function twoOpt(order: number[], items: CutItem[], preds: number[][], rev: boolean[],
  entryOf: (i: number) => Pt, exitOf: (i: number) => Pt, from: Pt, deadline: number): boolean {
  const n = order.length;
  if (n < 3) return false;
  const posOf = new Array<number>(n);
  const F = new Float64Array(n), R = new Float64Array(n), maxPred = new Int32Array(n);
  const flipped = (i: number, e: boolean): Pt => {
    const it = items[i];
    if (!it.reversible || it.freeStart) return e ? entryOf(i) : exitOf(i);
    return e ? exitOf(i) : entryOf(i);
  };
  const rebuild = () => {
    order.forEach((it, k) => posOf[it] = k);
    for (let k = 0; k < n; k++) {
      let m = -1;
      for (const p of preds[order[k]]) if (posOf[p] > m) m = posOf[p];
      maxPred[k] = m;
      if (k > 0) {
        F[k] = F[k - 1] + dist(exitOf(order[k - 1]), entryOf(order[k]));
        R[k] = R[k - 1] + dist(flipped(order[k], false), flipped(order[k - 1], true));
      }
    }
  };
  rebuild();
  let any = false, improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      if (now() > deadline) return any;
      const before = i > 0 ? exitOf(order[i - 1]) : from;
      const oldIn = dist(before, entryOf(order[i]));
      for (let j = i + 1; j < n; j++) {
        if (maxPred[j] >= i) break; // ab hier läge eine Kontur samt Innerem im Abschnitt
        const after = j + 1 < n ? entryOf(order[j + 1]) : null;
        const oldD = oldIn + (F[j] - F[i]) + (after ? dist(exitOf(order[j]), after) : 0);
        const newD = dist(before, flipped(order[j], true)) + (R[j] - R[i]) + (after ? dist(flipped(order[i], false), after) : 0);
        if (newD < oldD - 1e-6) {
          for (let k = i; k <= j; k++) { const it = items[order[k]]; if (it.reversible && !it.freeStart) rev[order[k]] = !rev[order[k]]; }
          for (let a = i, b = j; a < b; a++, b--) { const tmp = order[a]; order[a] = order[b]; order[b] = tmp; }
          rebuild();
          improved = any = true;
          break;
        }
      }
    }
  }
  return any;
}

/** Freie Startpunkte: der Punkt, der Anfahrt + Weiterfahrt am kürzesten macht */
function placeStarts(order: number[], items: CutItem[], start: number[],
  entryOf: (i: number) => Pt, exitOf: (i: number) => Pt, from: Pt): boolean {
  let moved = false;
  for (let k = 0; k < order.length; k++) {
    const it = items[order[k]];
    if (!it.freeStart) continue;
    const a = k > 0 ? exitOf(order[k - 1]) : from;
    const b = k + 1 < order.length ? entryOf(order[k + 1]) : null;
    let best = start[order[k]], bestD = Infinity;
    for (let i = 0; i < it.pts.length; i++) {
      const d = dist(a, it.pts[i]) + (b ? dist(it.pts[i], b) : 0);
      if (d < bestD - TOL) { bestD = d; best = i; }
    }
    if (best !== start[order[k]]) { start[order[k]] = best; moved = true; }
  }
  return moved;
}

/** grober Abstand für die Auswahl beim nächsten Nachbarn */
function roughDist(it: CutItem, p: Pt): number {
  if (it.freeStart) {
    const step = Math.max(1, Math.floor(it.pts.length / SAMPLE));
    let d = Infinity;
    for (let i = 0; i < it.pts.length; i += step) d = Math.min(d, dist(p, it.pts[i]));
    return d;
  }
  const d = dist(p, it.entry);
  return it.reversible ? Math.min(d, dist(p, it.exit)) : d;
}

function nearestIdx(pts: Pt[], p: Pt): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < pts.length; i++) { const d = dist(p, pts[i]); if (d < bd) { bd = d; best = i; } }
  return best;
}

function bbox(pts: Pt[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return [x0, y0, x1, y1];
}

function polyArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x * pts[i].y - pts[i].x * pts[j].y);
  return a / 2;
}

function pointInPoly(px: number, py: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
