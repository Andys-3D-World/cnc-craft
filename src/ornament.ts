/**
 * WEIHNACHTSSCHMUCK-GENERATOR: Anhänger mit Namen zum Lasern oder Fräsen (Fenster: editor/ornamentGen.ts)
 *
 * Formen: Kugel (mit Kappe), Stern (5 … 12 Zacken), Tannenbaum, Glocke, Herz, Schneeflocke – alle für CNC Craft
 * gezeichnet. Jede Form hat ein Textfeld (Rechteck, das sicher in der Form liegt); der Name wird hineingesetzt:
 * gravieren, ausschneiden (wie eine Schablone), als Linie gravieren oder als eigenes Teil zum Aufkleben.
 * Aufhänger: Loch (so weit oben, wie es mit Rand hineinpasst), Ring oben oder keiner. Auf Wunsch eine Zierlinie
 * innen am Rand entlang.
 *
 * Die Schrift kommt fertig als Fläche (bzw. Linien bei Einzellinien-Schriften) aus dem Fenster – hier ist nur
 * Geometrie, ohne Oberfläche (Tests: `npm test`). Alles in mm, Y nach oben; Form unten bei y = 0, Mitte bei x = 0.
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import { bounds, union, unionMany, grow, inRegion, clipLines, outlineLines, type ScoreLine, type XY } from "./nameConnect.ts";

export type OrnamentShape = "ball" | "star" | "tree" | "bell" | "heart" | "snowflake";
export const ORNAMENT_SHAPES: OrnamentShape[] = ["ball", "star", "tree", "bell", "heart", "snowflake"];
export type OrnamentHanger = "hole" | "ring" | "none";
export type OrnamentInner = "engrave" | "cut" | "score" | "layer";

export interface OrnamentOptions {
  shape: OrnamentShape;
  size: number;       // Höhe der Form ohne Ring (mm)
  points: number;     // Zacken beim Stern (5 … 12)
  hanger: OrnamentHanger;
  holeD: number;      // Loch-Ø (mm)
  inner: OrnamentInner;
  textSize: number;   // Schriftgröße in % des Textfelds (20 … 100)
  border: boolean;    // Zierlinie innen am Rand
}

/** Schrift, wie sie aus dem Fenster kommt (beliebige Größe/Lage – wird ins Textfeld eingepasst) */
export interface OrnamentText { area: MultiPolygon; lines: ScoreLine[] }

export interface Box { x0: number; y0: number; x1: number; y1: number }

export interface OrnamentBody { body: MultiPolygon; hole: MultiPolygon; textBox: Box; holeAt?: XY; holeR: number }

export interface OrnamentResult {
  cut: MultiPolygon;     // Außenkontur (+ Loch, + ausgeschnittene Buchstaben)
  engrave: MultiPolygon; // Schrift als Fläche gravieren
  top: MultiPolygon;     // Schrift als eigenes Teil
  lines: ScoreLine[];    // Gravurlinien auf der Form (Zierlinie, Schrift als Linie)
  pieces: number; w: number; h: number;
}

// ---------- kleine Helfer ----------
const close = (r: XY[]): XY[] => [...r, r[0]];
const poly = (r: XY[]): MultiPolygon => [[close(r)]];
const circle = (cx: number, cy: number, r: number, n = 72): XY[] =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * Math.PI * 2), cy + r * Math.sin((i / n) * Math.PI * 2)] as XY);
const disk = (cx: number, cy: number, r: number): MultiPolygon => poly(circle(cx, cy, r));
const diff = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => (a.length && b.length ? polygonClipping.difference(a, b) : a);
const mapArea = (m: MultiPolygon, f: (p: XY) => XY): MultiPolygon => m.map(p => p.map(r => r.map(q => f(q as XY))));

/** Rechte Hälfte (von unten Mitte nach oben Mitte) spiegeln → ganze Kontur */
function mirror(right: XY[]): XY[] {
  const left = right.slice(1, -1).reverse().map(([x, y]) => [-x, y] as XY);
  return [...right, ...left];
}

/** Geschlossene Kontur weich machen (Catmull-Rom, geht durch alle Punkte) */
function smooth(p: XY[], n = 6): XY[] {
  const out: XY[] = [];
  for (let i = 0; i < p.length; i++) {
    const p0 = p[(i - 1 + p.length) % p.length], p1 = p[i], p2 = p[(i + 1) % p.length], p3 = p[(i + 2) % p.length];
    for (let s = 0; s < n; s++) {
      const t = s / n, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

/** Streifen mit runden Enden von a nach b, Breite w */
function capsule(a: XY, b: XY, w: number): MultiPolygon {
  // gleich als ein Umriss (zwei Halbkreise) – eine Vereinigung von Rechteck und Kreisen verschluckt sich leicht
  const dir = Math.atan2(b[1] - a[1], b[0] - a[0]), r = w / 2, n = 12;
  const half = (c: XY, from: number): XY[] => Array.from({ length: n + 1 }, (_, i) => {
    const t = from + (i / n) * Math.PI;
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as XY;
  });
  return poly([...half(b, dir - Math.PI / 2), ...half(a, dir + Math.PI / 2)]);
}

/** Stern-Punkte: Spitze oben, Außenradius ro, Innenradius ri */
function starPts(cx: number, cy: number, n: number, ro: number, ri: number): XY[] {
  return Array.from({ length: 2 * n }, (_, i) => {
    const a = Math.PI / 2 + (i * Math.PI) / n, r = i % 2 ? ri : ro;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as XY;
  });
}

/** Form in Einheiten (beliebige Größe) mit Textfeld – wird danach auf die gewünschte Höhe gebracht */
function rawShape(o: OrnamentOptions): { body: MultiPolygon; box: Box } {
  switch (o.shape) {
    case "star": {
      const n = Math.round(Math.max(5, Math.min(12, o.points || 5)));
      const ri = Math.min(0.7, 0.48 + 0.03 * (n - 5));
      const rin = ri * Math.cos(Math.PI / n); // so weit reicht die Mitte sicher
      // beim 5er-Stern reicht der Name bis in die waagerechten Zacken (dort ist am meisten Platz)
      const box = n === 5 ? { x0: -0.6, y0: 0.02, x1: 0.6, y1: 0.25 } : { x0: -0.85 * rin, y0: -0.32 * rin, x1: 0.85 * rin, y1: 0.32 * rin };
      return { body: poly(starPts(0, 0, n, 1, ri)), box };
    }
    case "tree": {
      // drei Stufen und ein Stamm
      const right: XY[] = [[0, 0], [0.08, 0], [0.08, 0.1], [0.45, 0.1], [0.22, 0.36], [0.36, 0.36], [0.15, 0.6], [0.27, 0.6], [0, 0.92]];
      return { body: poly(mirror(right)), box: { x0: -0.23, y0: 0.13, x1: 0.23, y1: 0.29 } };
    }
    case "bell": {
      // Glocke mit Klöppel unten und Knauf oben
      const right: XY[] = [[0, 0], [0.07, 0.015], [0.11, 0.06], [0.3, 0.06], [0.5, 0.065], [0.5, 0.11], [0.43, 0.17], [0.37, 0.28],
        [0.32, 0.42], [0.28, 0.58], [0.24, 0.71], [0.19, 0.8], [0.11, 0.86], [0.06, 0.88], [0.06, 0.93], [0.03, 0.96], [0, 0.965]];
      return { body: poly(smooth(mirror(right))), box: { x0: -0.27, y0: 0.15, x1: 0.27, y1: 0.4 } };
    }
    case "heart": {
      const pts: XY[] = Array.from({ length: 144 }, (_, i) => {
        const a = (i / 144) * Math.PI * 2, s = Math.sin(a);
        return [16 * s * s * s, 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)] as XY;
      });
      return { body: poly(pts), box: { x0: -9, y0: -5, x1: 9, y1: 3 } };
    }
    case "snowflake": {
      // Sechseck in der Mitte, sechs Arme (einer nach oben) mit je zwei Zweig-Paaren
      const parts: MultiPolygon[] = [poly(Array.from({ length: 6 }, (_, i) => [0.5 * Math.cos(Math.PI / 2 + (i * Math.PI) / 3), 0.5 * Math.sin(Math.PI / 2 + (i * Math.PI) / 3)] as XY))];
      const w = 0.13;
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 2 + (i * Math.PI) / 3, at = (r: number): XY => [r * Math.cos(a), r * Math.sin(a)];
        parts.push(capsule([0, 0], at(0.93), w));
        for (const [r, len] of [[0.6, 0.27], [0.8, 0.14]]) for (const side of [-1, 1]) {
          const b = a + side * (Math.PI / 3.6), p = at(r);
          parts.push(capsule(p, [p[0] + len * Math.cos(b), p[1] + len * Math.sin(b)], w * 0.85));
        }
      }
      return { body: unionMany(parts), box: { x0: -0.36, y0: -0.16, x1: 0.36, y1: 0.16 } };
    }
    default: {
      // Kugel mit Kappe oben
      const capW = 0.42, capH = 0.24;
      const cap: XY[] = [[-capW / 2, 1 - capH * 0.4], [capW / 2, 1 - capH * 0.4], [capW / 2, 1 + capH * 0.6], [-capW / 2, 1 + capH * 0.6]];
      return { body: union([disk(0, 0, 1), poly(cap)]), box: { x0: -0.75, y0: -0.33, x1: 0.75, y1: 0.33 } };
    }
  }
}

/** liegt ein Kreis (mit Rand) ganz in der Fläche? */
function diskFits(m: MultiPolygon, cx: number, cy: number, r: number): boolean {
  if (!inRegion(m, cx, cy)) return false;
  return circle(cx, cy, r, 32).every(([x, y]) => inRegion(m, x, y));
}

/** Höchster Materialpunkt auf der Mittellinie x = 0 */
function topAtCenter(m: MultiPolygon): number {
  const b = bounds(m);
  let best = b.y0;
  for (const p of m) for (const r of p) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [ax, ay] = r[j], [bx, by] = r[i];
    if ((ax > 0) !== (bx > 0)) best = Math.max(best, ay + ((0 - ax) * (by - ay)) / (bx - ax));
  }
  return best;
}

/** Abstand vom Loch zum Rand */
export const holeMargin = (r: number) => Math.max(1.5, r * 0.8);

/** Form in der gewünschten Größe, mit Aufhänger und Textfeld */
export function ornamentBody(o: OrnamentOptions): OrnamentBody {
  const raw = rawShape(o), b = bounds(raw.body);
  const k = Math.max(10, o.size) / (b.y1 - b.y0), cx = (b.x0 + b.x1) / 2;
  const tf = ([x, y]: XY): XY => [(x - cx) * k, (y - b.y0) * k];
  let body = mapArea(raw.body, tf);
  const box: Box = { x0: (raw.box.x0 - cx) * k, y0: (raw.box.y0 - b.y0) * k, x1: (raw.box.x1 - cx) * k, y1: (raw.box.y1 - b.y0) * k };
  let hole: MultiPolygon = [], holeAt: XY | undefined, holeR = 0;
  const rIn = Math.max(0.5, o.holeD / 2);
  if (o.hanger === "hole") {
    // von oben auf der Mittellinie nach unten suchen, bis das Loch mit Rand hineinpasst; notfalls kleiner
    const top = topAtCenter(body);
    for (let r = rIn; r >= 0.5 && !holeAt; r *= 0.8) {
      const m = holeMargin(r);
      for (let y = top - r - m; y > box.y1 + r + 0.5; y -= 0.2) if (diskFits(body, 0, y, r + m)) { holeAt = [0, y]; holeR = r; break; }
    }
    if (holeAt) hole = disk(holeAt[0], holeAt[1], holeR);
  } else if (o.hanger === "ring") {
    // Ring über der Spitze bzw. Kappe; er greift ein Stück in die Form, damit er fest dran ist
    const rOut = rIn + Math.max(1.5, o.size * 0.03), top = topAtCenter(body), cy = top + rOut * 0.25;
    body = union([body, disk(0, cy, rOut)]);
    hole = disk(0, cy, rIn); holeAt = [0, cy]; holeR = rIn;
  }
  // Text bleibt unter dem Loch
  if (holeAt && holeAt[1] - holeR - holeMargin(holeR) < box.y1) box.y1 = Math.max(box.y0 + 1, holeAt[1] - holeR - holeMargin(holeR));
  return { body, hole, textBox: box, holeAt, holeR };
}

/** Breite der Zierlinie vom Rand */
export const borderInset = (o: OrnamentOptions) => Math.max(1.5, o.size * 0.035);

/** Schrift gleichmäßig ins Textfeld einpassen (mittig), Größe in % */
export function fitText(text: OrnamentText, box: Box, pct = 100): OrnamentText {
  const lb = bounds(text.area);
  for (const l of text.lines) for (const [x, y] of l.pts) { lb.x0 = Math.min(lb.x0, x); lb.x1 = Math.max(lb.x1, x); lb.y0 = Math.min(lb.y0, y); lb.y1 = Math.max(lb.y1, y); }
  const lw = lb.x1 - lb.x0, lh = lb.y1 - lb.y0;
  if (!(lw > 0) || !(lh > 0)) return { area: [], lines: [] };
  const k = Math.min((box.x1 - box.x0) / lw, (box.y1 - box.y0) / lh) * Math.max(0.2, Math.min(1, pct / 100));
  const mx = (box.x0 + box.x1) / 2, my = (box.y0 + box.y1) / 2, lx = (lb.x0 + lb.x1) / 2, ly = (lb.y0 + lb.y1) / 2;
  const f = ([x, y]: XY): XY => [mx + (x - lx) * k, my + (y - ly) * k];
  return { area: mapArea(text.area, f), lines: text.lines.map(l => ({ closed: l.closed, pts: l.pts.map(f) })) };
}

/** nur Außenkonturen (Innenräume gefüllt) */
const solid = (m: MultiPolygon): MultiPolygon => union(m.filter(p => p[0]).map(p => [[p[0]]] as MultiPolygon));
const countPieces = (m: MultiPolygon) => m.filter(p => p[0] && p[0].length >= 3).length;

/** Fertiger Anhänger: Form, Aufhänger, Zierlinie und Name */
export function ornament(o: OrnamentOptions, text: OrnamentText): OrnamentResult {
  const ob = ornamentBody(o);
  const shape = diff(ob.body, ob.hole);
  const box = { ...ob.textBox };
  let lines: ScoreLine[] = [];
  if (o.border) {
    // Zierlinie: Form (mit Loch) um d nach innen – die Ränder wachsen von beiden Seiten in die Form hinein
    // (Umgebung = Rahmen minus Form, mit Rand wachsen lassen und von der Form abziehen)
    const d = borderInset(o), b = bounds(shape);
    const around = diff(poly([[b.x0 - 5, b.y0 - 5], [b.x1 + 5, b.y0 - 5], [b.x1 + 5, b.y1 + 5], [b.x0 - 5, b.y1 + 5]]), shape);
    lines = outlineLines(diff(shape, grow(around, d, true)));
    box.x0 += d; box.x1 -= d; box.y0 += d; box.y1 -= d;
  }
  const tx = fitText(text, box, o.textSize);
  // Einzellinien-Schrift: immer als Linie gravieren
  const open = tx.lines.length > 0;
  let cut = shape, engrave: MultiPolygon = [], top: MultiPolygon = [], textLines: ScoreLine[] = [];
  if (open) textLines = tx.lines;
  else if (tx.area.length) {
    if (o.inner === "engrave") engrave = tx.area;
    else if (o.inner === "score") textLines = outlineLines(tx.area);
    else if (o.inner === "layer") top = tx.area;
    else cut = diff(shape, solid(tx.area)); // wie eine Schablone: Innenräume von o, a … fallen mit heraus
  }
  lines = [...lines, ...clipLines(textLines, cut, 0.2)];
  const all = bounds(union([cut, top]));
  return { cut, engrave, top, lines, pieces: countPieces(cut), w: all.x1 - all.x0, h: all.y1 - all.y0 };
}
