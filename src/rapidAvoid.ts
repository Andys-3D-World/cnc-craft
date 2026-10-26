/**
 * LEERFAHRTEN UM AUSGESCHNITTENE TEILE HERUM (Plasma, Laser)
 *
 * Ausgeschnittene Teile und Lochbutzen können kippen oder hochstehen. Fährt der Kopf danach
 * im Eilgang (G0) gerade darüber, bleibt er hängen. Deshalb: jede geschlossene Kontur, die in
 * diesem Job schon fertig geschnitten ist, wird ein Hindernis. Kreuzt eine Leerfahrt ein
 * Hindernis, geht sie über die Ecken seines Rahmens (umgebendes Rechteck + Abstand) herum.
 * Liegt nichts im Weg, bleibt die Fahrt gerade wie bisher. Start- und Zielpunkt bleiben gleich.
 *
 * Suche: kürzester Weg über die Rahmen-Ecken (A*). Ein Wegstück ist erlaubt, wenn es durch
 * keine fertige Kontur hindurchgeht. Konturen, in denen Start oder Ziel liegt (z. B. Einstich
 * in einem Loch, das im 2. Durchgang noch einmal geschnitten wird), lassen sich nicht umfahren
 * und werden für diese Fahrt übergangen. Findet sich kein Weg, bleibt die Fahrt gerade.
 *
 * Bewusst ohne Laufzeit-Importe (nur Typen): so laufen die Tests direkt mit `node --test`.
 */
import type { Pt } from "./shapeTransform";

const EPS = 1e-9;
const INSIDE_TOL = 0.2;   // so viel mm muss eine Fahrt durch eine Kontur gehen, damit sie zählt
const EDGE_TOL = 0.02;    // näher am Rand gilt ein Punkt als "auf der Kontur" (nicht darin)
const MAX_NODES = 400;    // Schutz vor sehr langen Suchen bei riesigen Jobs

interface Obstacle {
  poly: Pt[];
  x0: number; y0: number; x1: number; y1: number;  // Rahmen der Kontur (ohne Abstand)
}

export class RapidPlanner {
  private obs: Obstacle[] = [];
  private margin: number;

  /** @param margin Abstand des Umwegs zum Rahmen der Kontur in mm */
  constructor(margin: number) { this.margin = margin; }

  /** Geschlossene Kontur ist fertig geschnitten -> ab jetzt Hindernis */
  addCut(loop: Pt[]) {
    let poly = loop;
    if (poly.length > 1 && dist(poly[0], poly[poly.length - 1]) < EPS) poly = poly.slice(0, -1);
    if (poly.length < 3) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of poly) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    this.obs.push({ poly, x0, y0, x1, y1 });
  }

  /**
   * Zwischenpunkte für die Leerfahrt von a nach b (ohne a und b selbst).
   * Leer = gerade fahren.
   */
  route(a: Pt, b: Pt): Pt[] {
    if (!this.obs.length || dist(a, b) < INSIDE_TOL) return [];
    // Konturen, in denen Start oder Ziel liegt, kann man nicht umfahren
    const active = this.obs.filter(o => !strictlyInside(a, o) && !strictlyInside(b, o));
    if (!active.some(o => crosses(a, b, o))) return [];

    const m = this.margin;
    const nodes: Pt[] = [a, b];
    for (const o of active) {
      for (const c of [{ x: o.x0 - m, y: o.y0 - m }, { x: o.x1 + m, y: o.y0 - m }, { x: o.x1 + m, y: o.y1 + m }, { x: o.x0 - m, y: o.y1 + m }]) {
        // Ecken, die selbst in einem Teil liegen, taugen nicht als Umweg
        if (!active.some(q => inBox(c, q) && pointInPoly(c.x, c.y, q.poly))) nodes.push(c);
      }
      if (nodes.length > MAX_NODES) break;
    }
    const free = (p: Pt, q: Pt) => !active.some(o => crosses(p, q, o));
    const path = aStar(nodes, free);
    return path ? path.slice(1, -1) : [];
  }
}

/** A* über die Knoten (0 = Start, 1 = Ziel); Wegstücke werden erst beim Ausprobieren geprüft */
function aStar(nodes: Pt[], free: (p: Pt, q: Pt) => boolean): Pt[] | null {
  const n = nodes.length, goal = nodes[1];
  const g = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  g[0] = 0;
  for (;;) {
    let cur = -1, best = Infinity;
    for (let i = 0; i < n; i++) {
      if (done[i] || g[i] === Infinity) continue;
      const f = g[i] + dist(nodes[i], goal);
      if (f < best) { best = f; cur = i; }
    }
    if (cur < 0) return null;
    if (cur === 1) break;
    done[cur] = true;
    for (let j = 0; j < n; j++) {
      if (done[j] || j === cur) continue;
      const d = g[cur] + dist(nodes[cur], nodes[j]);
      if (d >= g[j] - EPS) continue;
      if (!free(nodes[cur], nodes[j])) continue;
      g[j] = d;
      prev[j] = cur;
    }
  }
  const out: Pt[] = [];
  for (let i = 1; i >= 0; i = prev[i]) out.unshift(nodes[i]);
  return out;
}

/** Geht die Strecke p-q durch das Innere der Kontur (mehr als INSIDE_TOL)? */
function crosses(p: Pt, q: Pt, o: Obstacle): boolean {
  if (Math.max(p.x, q.x) < o.x0 || Math.min(p.x, q.x) > o.x1 || Math.max(p.y, q.y) < o.y0 || Math.min(p.y, q.y) > o.y1) return false;
  const len = dist(p, q);
  if (len < INSIDE_TOL) return false;
  // Schnittpunkte mit allen Kanten als Anteil t auf p-q, dann jedes Stück dazwischen prüfen
  const ts = [0, 1];
  const dx = q.x - p.x, dy = q.y - p.y;
  const poly = o.poly;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    const ex = b.x - a.x, ey = b.y - a.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < EPS) continue;  // parallel: berührt höchstens, geht nicht hindurch
    const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / den;
    const u = ((a.x - p.x) * dy - (a.y - p.y) * dx) / den;
    if (t > 0 && t < 1 && u >= -EPS && u <= 1 + EPS) ts.push(t);
  }
  ts.sort((s, t) => s - t);
  let inside = 0;
  for (let k = 1; k < ts.length; k++) {
    const seg = (ts[k] - ts[k - 1]) * len;
    if (seg < EPS) continue;
    const tm = (ts[k] + ts[k - 1]) / 2;
    if (pointInPoly(p.x + dx * tm, p.y + dy * tm, poly)) {
      inside += seg;
      if (inside > INSIDE_TOL) return true;
    }
  }
  return false;
}

/** Liegt der Punkt wirklich in der Kontur (nicht nur auf dem Rand)? */
function strictlyInside(p: Pt, o: Obstacle): boolean {
  if (!inBox(p, o) || !pointInPoly(p.x, p.y, o.poly)) return false;
  const poly = o.poly;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segDist(p, poly[j], poly[i]) < EDGE_TOL) return false;
  }
  return true;
}

function inBox(p: Pt, o: Obstacle): boolean {
  return p.x >= o.x0 && p.x <= o.x1 && p.y >= o.y0 && p.y <= o.y1;
}

function pointInPoly(px: number, py: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const ex = b.x - a.x, ey = b.y - a.y;
  const l2 = ex * ex + ey * ey;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / l2)) : 0;
  return Math.hypot(p.x - a.x - ex * t, p.y - a.y - ey * t);
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
