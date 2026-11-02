/**
 * WORTPLÄTTCHEN-ANHÄNGER: Namen als Buchstaben-Plättchen, wie ein kleines Kreuzworträtsel ineinander gelegt
 * (Fenster: editor/wordTilesGen.ts)
 *
 * Aufbau (drei Teile zum Aufeinanderkleben):
 *  - Grundplatte (rund oder eckig) mit Öse und Loch – hier liegen die Plättchen drauf
 *  - Rahmen: Ring am Rand + Fußteil mit welliger Oberkante, darin Familienname und Jahr (graviert)
 *  - Plättchen: Quadrate mit Buchstabe und kleiner Punktzahl – einzeln ausgeschnitten (Hilfslinien auf der
 *    Grundplatte zeigen, wo sie hinkommen) oder direkt auf die Grundplatte graviert
 *
 * Anordnung: das längste Wort waagerecht, dann immer das Wort an der Stelle, die das Ganze am kompaktesten hält.
 * Regeln wie beim Kreuzworträtsel: Wörter kreuzen sich nur an gleichen Buchstaben, sonst berühren sie sich nicht.
 * Mit „seed“ ≠ 0 wird unter gleich guten Stellen zufällig gewählt (andere Anordnung).
 *
 * Nur Geometrie, ohne Oberfläche (Tests: `npm test`). Alles in mm, Y nach oben, Mitte der Platte bei (0, 0).
 * Raster der Plättchen: x nach rechts, y nach UNTEN (Zeilen wie beim Lesen).
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import { bounds, union, grow, inRegion, type XY } from "./nameConnect.ts";
import { roundRect } from "./ornament.ts";

export type Dir = "h" | "v";
export interface Placed { word: string; x: number; y: number; dir: Dir }
export interface TileLayout {
  cells: Map<string, string>;   // "x,y" → Zeichen
  placed: Placed[];
  unplaced: string[];           // Wörter ohne gemeinsamen Buchstaben – passen nicht ins Rätsel
  x0: number; y0: number; x1: number; y1: number; // belegte Zellen (einschließlich)
}

/** Punktwerte (wie bei den bekannten Brettspielen); ♥ und unbekannte Zeichen: keine Zahl */
export const POINTS: Record<"de" | "en", Record<string, number>> = {
  de: { A: 1, B: 3, C: 4, D: 1, E: 1, F: 4, G: 2, H: 2, I: 1, J: 6, K: 4, L: 2, M: 3, N: 1, O: 2, P: 4, Q: 10, R: 1, S: 1, T: 1,
    U: 1, V: 6, W: 3, X: 8, Y: 10, Z: 3, Ä: 6, Ö: 8, Ü: 6 },
  en: { A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
    U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10 },
};
export const HEART = "♥";

/** Eingabe → Wörter: je Zeile (oder durch Komma/Semikolon getrennt) ein Wort; Großbuchstaben, Ziffern, ♥ („<3“ wird zu ♥) */
export function parseWords(text: string): string[] {
  return text.replace(/<3/g, HEART).toUpperCase().replace(/ß/g, "SS").split(/[\n,;]+/)
    .map(w => w.replace(/[^A-ZÄÖÜ0-9♥]/gu, "")).filter(w => w.length >= 2).slice(0, 12);
}

const key = (x: number, y: number) => `${x},${y}`;

/** Kann das Wort hier liegen? Ergebnis: Anzahl Kreuzungen (−1 = geht nicht) */
function fits(cells: Map<string, string>, dirs: Map<string, Set<Dir>>, w: string, x: number, y: number, d: Dir): number {
  const dx = d === "h" ? 1 : 0, dy = d === "v" ? 1 : 0;
  // vor dem ersten und nach dem letzten Buchstaben muss frei sein
  if (cells.has(key(x - dx, y - dy)) || cells.has(key(x + dx * w.length, y + dy * w.length))) return -1;
  let cross = 0;
  for (let i = 0; i < w.length; i++) {
    const cx = x + dx * i, cy = y + dy * i, k = key(cx, cy), have = cells.get(k);
    if (have !== undefined) {
      if (have !== w[i] || dirs.get(k)?.has(d)) return -1;
      cross++;
    } else if (cells.has(key(cx + dy, cy + dx)) || cells.has(key(cx - dy, cy - dx))) return -1; // seitlich nichts anlehnen
  }
  return cross;
}

function put(cells: Map<string, string>, dirs: Map<string, Set<Dir>>, w: string, x: number, y: number, d: Dir) {
  for (let i = 0; i < w.length; i++) {
    const k = key(x + (d === "h" ? i : 0), y + (d === "v" ? i : 0));
    cells.set(k, w[i]);
    if (!dirs.has(k)) dirs.set(k, new Set());
    dirs.get(k)!.add(d);
  }
}

function rng(seed: number) {
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Wörter wie ein Kreuzworträtsel anordnen; aspect = gewünschtes Verhältnis Breite/Höhe des Rätsels */
export function layoutWords(words: string[], seed = 0, aspect = 1): TileLayout {
  const cells = new Map<string, string>(), dirs = new Map<string, Set<Dir>>(), placed: Placed[] = [];
  const rest = [...words];
  const r = rng(seed);
  if (rest.length) {
    // längstes Wort zuerst (bei seed zufällig senkrecht)
    rest.sort((a, b) => b.length - a.length);
    const first = rest.shift()!, d: Dir = seed && r() < 0.5 ? "v" : "h";
    put(cells, dirs, first, 0, 0, d);
    placed.push({ word: first, x: 0, y: 0, dir: d });
  }
  let progress = true;
  while (rest.length && progress) {
    progress = false;
    let best: { i: number; x: number; y: number; d: Dir; score: number } | null = null;
    const b = bbox(cells);
    rest.forEach((w, i) => {
      for (const [k, ch] of cells) {
        const [cx, cy] = k.split(",").map(Number);
        for (let j = 0; j < w.length; j++) {
          if (w[j] !== ch) continue;
          for (const d of ["h", "v"] as Dir[]) {
            const x = d === "h" ? cx - j : cx, y = d === "v" ? cy - j : cy;
            const c = fits(cells, dirs, w, x, y, d);
            if (c < 1) continue;
            // je kompakter (größte Seite, Seitenverhältnis), desto besser; mehr Kreuzungen leicht bevorzugt
            const nx0 = Math.min(b.x0, x), ny0 = Math.min(b.y0, y);
            const nx1 = Math.max(b.x1, x + (d === "h" ? w.length - 1 : 0)), ny1 = Math.max(b.y1, y + (d === "v" ? w.length - 1 : 0));
            const W = nx1 - nx0 + 1, H = ny1 - ny0 + 1;
            const score = Math.max(W / aspect, H) * 10 + Math.abs(Math.log(W / H / aspect)) * 3 - c * 2 + (seed ? r() * 4 : 0);
            if (!best || score < best.score) best = { i, x, y, d, score };
          }
        }
      }
    });
    if (best) {
      const { i, x, y, d } = best as { i: number; x: number; y: number; d: Dir };
      put(cells, dirs, rest[i], x, y, d);
      placed.push({ word: rest[i], x, y, dir: d });
      rest.splice(i, 1);
      progress = true;
    }
  }
  const b = bbox(cells);
  return { cells, placed, unplaced: rest, ...b };
}

function bbox(cells: Map<string, string>) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of cells.keys()) { const [x, y] = k.split(",").map(Number); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return cells.size ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: -1, y1: -1 };
}

/**
 * Beste Anordnung: viele Versuche (seed 0 … tries−1), die kompakteste fürs gewünschte Seitenverhältnis gewinnt
 * (zuerst: möglichst alle Wörter untergebracht)
 */
export function bestLayout(words: string[], aspect = 1, tries = 40): TileLayout {
  let best: TileLayout | null = null, bestScore = Infinity;
  for (let seed = 0; seed < tries; seed++) {
    const l = layoutWords(words, seed, aspect);
    const W = l.x1 - l.x0 + 1, H = l.y1 - l.y0 + 1;
    const score = l.unplaced.length * 1000 + Math.max(W / aspect, H);
    if (score < bestScore - 1e-9) { best = l; bestScore = score; }
  }
  return best || layoutWords(words, 0, aspect);
}

// =====================================================================
// PLATTEN
// =====================================================================

export type TileShape = "round" | "rect";
export interface WordTileOptions {
  shape: TileShape;
  d: number;        // Durchmesser bzw. Breite (mm)
  frame: number;    // Breite des Rings (mm)
  footer: number;   // Höhe des Fußteils in % der Innenhöhe (15 … 40)
  holeD: number;    // Loch-Ø der Öse
}
export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface Tile { ch: string; cx: number; cy: number; s: number }
export interface WordTileResult {
  back: MultiPolygon;   // Grundplatte mit Loch
  front: MultiPolygon;  // Rahmen: Ring + Fußteil, mit Loch
  textBox: Box;         // Platz für Familienname und Jahr im Fußteil
  tiles: Tile[];        // Mitte und Seitenlänge jedes Plättchens (auf der Grundplatte)
  holeAt: XY; holeR: number;
}

const close = (r: XY[]): XY[] => [...r, r[0]];
const poly = (r: XY[]): MultiPolygon => [[close(r)]];
const circle = (cx: number, cy: number, r: number, n = 120): XY[] =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * Math.PI * 2), cy + r * Math.sin((i / n) * Math.PI * 2)] as XY);
const diff = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => (a.length && b.length ? polygonClipping.difference(a, b) : a);

/** Lücke zwischen den Plättchen in Teilen der Seitenlänge */
export const TILE_GAP = 0.1;

/** Seitenverhältnis (Breite/Höhe) des Platzes für die Plättchen – für die Anordnung */
export function roomAspect(o: WordTileOptions): number {
  const R = Math.max(30, o.d) / 2, fw = Math.max(1.5, Math.min(o.frame, R / 4)), ri = R - fw;
  const hF = 2 * ri * Math.max(0.12, Math.min(0.45, o.footer / 100)), yMin = -ri + hF * 1.12, ym = (yMin + ri) / 2;
  const w = o.shape === "rect" ? 2 * ri : 2 * Math.sqrt(Math.max(0, ri * ri - ym * ym));
  return Math.max(0.5, Math.min(3, w / Math.max(1, ri - yMin)));
}

export function wordTileOrnament(o: WordTileOptions, lay: TileLayout): WordTileResult {
  const D = Math.max(30, o.d), R = D / 2, fw = Math.max(1.5, Math.min(o.frame, D / 8));
  const outer = o.shape === "rect" ? roundRect(-R, -R, R, R, D * 0.08) : poly(circle(0, 0, R));
  const inner = o.shape === "rect" ? roundRect(-R + fw, -R + fw, R - fw, R - fw, Math.max(0.5, D * 0.08 - fw)) : poly(circle(0, 0, R - fw));
  const ri = R - fw;
  // Öse oben mit Loch
  const holeR = Math.max(0.75, o.holeD / 2), rOut = holeR + Math.max(1.8, holeR * 0.9), ear: XY = [0, R + rOut * 0.35];
  const earA = poly(circle(ear[0], ear[1], rOut, 48)), hole = poly(circle(ear[0], ear[1], holeR, 32));
  // Fußteil: wellige Oberkante (sanfter Hügel), unten bis zum Rand
  const hF = (2 * ri) * Math.max(0.12, Math.min(0.45, o.footer / 100)), yF = -ri + hF, amp = hF * 0.12;
  const wave: XY[] = [];
  for (let i = 0; i <= 48; i++) { const x = -R - 1 + ((2 * R + 2) * i) / 48; wave.push([x, yF + amp * Math.sin((x / R) * Math.PI * 0.9 + 0.5)]); }
  const footerArea = polygonClipping.intersection(poly([...wave, [R + 1, -R - 1], [-R - 1, -R - 1]]), outer);
  const ring = diff(outer, inner);
  const back = diff(union([outer, earA]), hole);
  const front = diff(union([ring, footerArea, earA]), hole);
  // Textfeld im Fußteil: unter der niedrigsten Stelle der Welle, so breit wie es der Rand erlaubt
  const ty1 = yF - amp - hF * 0.08, ty0 = -ri + hF * 0.14;
  const half = (y: number) => (o.shape === "rect" ? ri : Math.sqrt(Math.max(0, ri * ri - y * y)));
  const tw = Math.max(1, Math.min(half(ty0), half(ty1)) * 0.9);
  const textBox: Box = { x0: -tw, y0: ty0, x1: tw, y1: Math.max(ty0 + 1, ty1) };
  // Plättchen: so groß wie möglich im Innenraum über dem Fußteil (Abstand m zu Ring und Welle)
  const tiles: Tile[] = [];
  const cols = lay.x1 - lay.x0 + 1, rows = lay.y1 - lay.y0 + 1;
  if (lay.cells.size) {
    const m = Math.max(1.5, fw * 0.6), yMin = yF + amp + m;
    const free = grow(diff(poly([[-R - 5, -R - 5], [R + 5, -R - 5], [R + 5, R + 5], [-R - 5, R + 5]]), inner), m, true);
    const room = diff(inner, free);
    const yTop = bounds(room).y1;
    const ok = (s: number, yc: number) => {
      const step = s * (1 + TILE_GAP), w = cols * step - s * TILE_GAP, h = rows * step - s * TILE_GAP;
      if (yc - h / 2 < yMin - 1e-9 || yc + h / 2 > yTop + 1e-9) return false;
      for (const k of lay.cells.keys()) {
        const [gx, gy] = k.split(",").map(Number);
        const x = -w / 2 + (gx - lay.x0) * step, y = yc + h / 2 - (gy - lay.y0) * step;
        for (const [px, py] of [[x, y], [x + s, y], [x, y - s], [x + s, y - s]]) if (!inRegion(room, px, py)) return false;
      }
      return true;
    };
    // beste Größe für ein paar Höhenlagen ausprobieren
    let bestS = 0, bestY = (yMin + yTop) / 2;
    for (let k = 0; k <= 10; k++) {
      const yc = yMin + ((yTop - yMin) * k) / 10;
      let lo = 0, hi = D;
      for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2; if (ok(mid, yc)) lo = mid; else hi = mid; }
      if (lo > bestS + 1e-6) { bestS = lo; bestY = yc; }
    }
    const s = bestS * 0.995, step = s * (1 + TILE_GAP), w = cols * step - s * TILE_GAP, h = rows * step - s * TILE_GAP;
    for (const [k, ch] of lay.cells) {
      const [gx, gy] = k.split(",").map(Number);
      tiles.push({ ch, s, cx: -w / 2 + (gx - lay.x0) * step + s / 2, cy: bestY + h / 2 - (gy - lay.y0) * step - s / 2 });
    }
  }
  return { back, front, textBox, tiles, holeAt: ear, holeR };
}

/** Umriss eines Plättchens (Quadrat mit leicht runden Ecken) */
export const tileOutline = (t: Tile): XY[] => roundRect(t.cx - t.s / 2, t.cy - t.s / 2, t.cx + t.s / 2, t.cy + t.s / 2, t.s * 0.08)[0][0].slice(0, -1) as XY[];
