/**
 * PUZZLE-GENERATOR: Schnittlinien für ein Puzzle – z. B. über ein graviertes Bild (Fenster: editor/puzzleGen.ts)
 *
 * Raster aus Spalten × Reihen; jede innere Kante bekommt eine Nase (Hals + runder Kopf), zufällig nach der einen
 * oder anderen Seite, etwas verschoben und verschieden groß, die Rasterpunkte leicht verrückt – so sieht jedes Teil
 * anders aus. Nachbarteile teilen sich dieselbe Kante, also passen sie immer genau. Die Form der Nase ist für
 * CNC Craft gezeichnet (Bézier-Kurven), Zufall mit Startwert (seed) – dasselbe seed gibt dasselbe Puzzle.
 * Umriss: Rechteck, Rechteck mit runden Ecken, Oval oder Herz; bei Oval/Herz enden die Linien knapp hinter dem Rand.
 *
 * Ergebnis: geschlossener Umriss + offene Linien (je eine pro Reihe/Spalte). Nur Geometrie (Tests: `npm test`).
 * Alles in mm, Y nach oben, unten links bei (0, 0).
 */
import type { MultiPolygon } from "polygon-clipping";
import { grow, clipLines, type ScoreLine, type XY } from "./nameConnect.ts";
import { roundRect } from "./ornament.ts";

export type PuzzleShape = "rect" | "rounded" | "oval" | "heart";
export const PUZZLE_SHAPES: PuzzleShape[] = ["rect", "rounded", "oval", "heart"];

export interface PuzzleOptions {
  w: number; h: number;   // Größe (mm)
  cols: number; rows: number;
  shape: PuzzleShape;
  tab: number;            // Nasengröße in % (60 … 140)
  jitter: number;         // Unregelmäßigkeit in % (0 … 100)
  seed: number;
}

export interface PuzzleResult { outline: XY[]; lines: ScoreLine[]; pieceW: number; pieceH: number }

/** kleiner Zufallsgenerator mit Startwert (mulberry32) */
function rng(seed: number) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Nase im Einheits-Maß: Kante von (0,0) nach (1,0), Kopf zeigt nach +y. Kubische Bézier-Stücke:
 * leichte Mulde, Hals nach innen geneigt, runder Kopf, Hals, Mulde.
 */
const TAB: [XY, XY, XY][] = [
  [[0.18, 0], [0.34, -0.02], [0.38, 0.03]],
  [[0.42, 0.07], [0.4, 0.11], [0.36, 0.16]],
  [[0.3, 0.22], [0.4, 0.27], [0.5, 0.27]],
  [[0.6, 0.27], [0.7, 0.22], [0.64, 0.16]],
  [[0.6, 0.11], [0.58, 0.07], [0.62, 0.03]],
  [[0.66, -0.02], [0.82, 0], [1, 0]],
];

/** Punkte einer Kante von a nach b (ohne a), Nase nach links (side = 1) oder rechts (−1) */
function edge(a: XY, b: XY, side: number, size: number, shift: number, n = 10): XY[] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  // Nase leicht verschoben: Mitte wandert, Enden bleiben
  const map = ([u, v]: XY): XY => {
    const t = u + shift * Math.sin(Math.PI * u), s = v * size * side;
    return [a[0] + dx * t - dy * s, a[1] + dy * t + dx * s];
  };
  const out: XY[] = [];
  let p0: XY = [0, 0];
  for (const [c1, c2, p3] of TAB) {
    for (let k = 1; k <= n; k++) {
      const t = k / n, m = 1 - t;
      const q: XY = [m * m * m * p0[0] + 3 * m * m * t * c1[0] + 3 * m * t * t * c2[0] + t * t * t * p3[0],
        m * m * m * p0[1] + 3 * m * m * t * c1[1] + 3 * m * t * t * c2[1] + t * t * t * p3[1]];
      out.push(map(q));
    }
    p0 = p3;
  }
  return out;
}

/** Umriss (geschlossen, ohne doppelten Endpunkt) */
function outlineOf(o: PuzzleOptions): XY[] {
  const { w, h } = o;
  switch (o.shape) {
    case "rounded": return roundRect(0, 0, w, h, Math.min(w, h) * 0.08)[0][0].slice(0, -1) as XY[];
    case "oval": return Array.from({ length: 144 }, (_, i) => [w / 2 + (w / 2) * Math.cos((i / 144) * Math.PI * 2), h / 2 + (h / 2) * Math.sin((i / 144) * Math.PI * 2)] as XY);
    case "heart": {
      const pts: XY[] = Array.from({ length: 180 }, (_, i) => {
        const a = (i / 180) * Math.PI * 2, s = Math.sin(a);
        return [16 * s * s * s, 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)] as XY;
      });
      const ys = pts.map(p => p[1]), y0 = Math.min(...ys), y1 = Math.max(...ys);
      return pts.map(([x, y]) => [w / 2 + (x / 32) * w, ((y - y0) / (y1 - y0)) * h] as XY);
    }
    default: return [[0, 0], [w, 0], [w, h], [0, h]];
  }
}

export function puzzle(o: PuzzleOptions): PuzzleResult {
  const cols = Math.max(1, Math.round(o.cols)), rows = Math.max(1, Math.round(o.rows));
  const cw = o.w / cols, ch = o.h / rows, cell = Math.min(cw, ch);
  const r = rng(o.seed), jit = Math.max(0, Math.min(1, o.jitter / 100)), tab = Math.max(0.6, Math.min(1.4, o.tab / 100));
  // Rasterpunkte: innen leicht verrückt (höchstens 8 % der Zelle), am Rand nur entlang des Rands
  const P: XY[][] = [];
  for (let i = 0; i <= cols; i++) {
    P.push([]);
    for (let j = 0; j <= rows; j++) {
      const jx = i > 0 && i < cols ? (r() - 0.5) * 0.16 * jit * cw : 0, jy = j > 0 && j < rows ? (r() - 0.5) * 0.16 * jit * ch : 0;
      P[i].push([i * cw + jx, j * ch + jy]);
    }
  }
  // Nase: Seite zufällig, Größe ±15 %, Verschiebung ±8 % (mit Unregelmäßigkeit); Höhe nie über 30 % der kürzeren Zelle
  const knob = (a: XY, b: XY) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const size = Math.min(tab * (1 + (r() - 0.5) * 0.3 * jit), (0.3 * cell) / (0.27 * len) );
    return edge(a, b, r() < 0.5 ? 1 : -1, size, (r() - 0.5) * 0.16 * jit);
  };
  const lines: ScoreLine[] = [];
  for (let j = 1; j < rows; j++) {
    const pts: XY[] = [P[0][j]];
    for (let i = 0; i < cols; i++) pts.push(...knob(P[i][j], P[i + 1][j]));
    lines.push({ pts, closed: false });
  }
  for (let i = 1; i < cols; i++) {
    const pts: XY[] = [P[i][0]];
    for (let j = 0; j < rows; j++) pts.push(...knob(P[i][j], P[i][j + 1]));
    lines.push({ pts, closed: false });
  }
  const outline = outlineOf(o);
  let out = lines;
  if (o.shape !== "rect") {
    // nur innerhalb des Umrisses; knapp darüber hinaus, damit die Teile sicher getrennt sind
    const region: MultiPolygon = grow([[[...outline, outline[0]]]], 0.4);
    out = clipLines(lines, region);
  }
  return { outline, lines: out, pieceW: cw, pieceH: ch };
}
