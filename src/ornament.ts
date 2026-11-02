/**
 * WEIHNACHTSSCHMUCK-GENERATOR: Anhänger mit Namen zum Lasern oder Fräsen (Fenster: editor/ornamentGen.ts)
 *
 * Formen: Kugel (mit Kappe), Stern (5 … 12 Zacken), Tannenbaum, Glocke, Herz, Schneeflocke – alle für CNC Craft
 * gezeichnet. Jede Form hat ein Textfeld (Rechteck, das sicher in der Form liegt); der Name wird hineingesetzt:
 * gravieren, ausschneiden (wie eine Schablone), im Band (Fenster ausgeschnitten, die Buchstaben bleiben stehen und
 * hängen an einem Steg auf der Grundlinie), als Linie gravieren oder als eigenes Teil zum Aufkleben.
 * Aufhänger: Loch (so weit oben, wie es mit Rand hineinpasst), Ring oben oder keiner. Auf Wunsch eine Zierlinie
 * innen am Rand entlang und Verzierung: kleine Motive (Sterne, Schneeflocken, Bäume, Herzen, Punkte), die im freien
 * Platz um den Namen ausgeschnitten werden – mit Steg dazwischen, damit alles ein Teil bleibt.
 *
 * Die Schrift kommt fertig als Fläche (bzw. Linien bei Einzellinien-Schriften) aus dem Fenster – hier ist nur
 * Geometrie, ohne Oberfläche (Tests: `npm test`). Alles in mm, Y nach oben; Form unten bei y = 0, Mitte bei x = 0.
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import { bounds, union, unionMany, grow, inRegion, clipLines, outlineLines, type ScoreLine, type XY } from "./nameConnect.ts";
import { scene, type SceneKind } from "./landscape.ts";

export type OrnamentShape = "ball" | "star" | "tree" | "bell" | "heart" | "snowflake" | "arch";
export const ORNAMENT_SHAPES: OrnamentShape[] = ["ball", "star", "tree", "bell", "heart", "snowflake", "arch"];
export type OrnamentHanger = "hole" | "ring" | "none";
export type OrnamentInner = "engrave" | "cut" | "band" | "score" | "layer";
export type OrnamentTopper = "none" | "antlers" | "bow" | "cap";
export const ORNAMENT_TOPPERS: OrnamentTopper[] = ["none", "antlers", "bow", "cap"];
export type OrnamentDeco = "none" | "stars" | "flakes" | "trees" | "hearts" | "dots" | "mixed";
export const ORNAMENT_DECOS: OrnamentDeco[] = ["none", "stars", "flakes", "trees", "hearts", "dots", "mixed"];

export interface OrnamentOptions {
  shape: OrnamentShape;
  size: number;       // Höhe der Form ohne Ring (mm)
  points: number;     // Zacken beim Stern (5 … 12)
  hanger: OrnamentHanger;
  holeD: number;      // Loch-Ø (mm)
  inner: OrnamentInner;
  textSize: number;   // Schriftgröße in % des Textfelds (20 … 100)
  border: boolean;    // Zierlinie innen am Rand
  deco: OrnamentDeco; // ausgeschnittene Motive um den Namen
  vertical?: boolean; // Name senkrecht (von unten nach oben zu lesen)
  layers?: 1 | 2 | 3; // 2 = Rahmen-Schicht vorn + Grundplatte dahinter, 3 = nur der Rahmen (Scherenschnitt)
  topper?: OrnamentTopper; // Aufsatz oben: Geweih, Schleife, Kappe
  scene?: SceneKind;  // zwei Schichten: Landschaft unten im Rahmen
  seed?: number;      // Zufall der Landschaft
  textLines?: number; // Anzahl Textzeilen (hilft, die Grundlinien zu finden)
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
  dropped: number;       // Name im Band: so viele lose Teilchen fallen weg (z. B. i-Punkte)
  // zwei Schichten: cut/engrave/lines = Rahmen vorn; die Grundplatte dahinter:
  back: MultiPolygon; backEngrave: MultiPolygon; backLines: ScoreLine[];
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
export function capsule(a: XY, b: XY, w: number): MultiPolygon {
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
    case "arch": {
      // Anhänger-Schild: unten gerade, oben ein Halbkreis
      const pts: XY[] = [[-0.36, 0], [0.36, 0]];
      for (let i = 0; i <= 36; i++) { const a = (i / 36) * Math.PI; pts.push([0.36 * Math.cos(a), 0.64 + 0.36 * Math.sin(a)]); }
      return { body: poly(pts), box: { x0: -0.29, y0: 0.07, x1: 0.29, y1: 0.66 } };
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
export function diskFits(m: MultiPolygon, cx: number, cy: number, r: number): boolean {
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

/**
 * Aufsatz oben auf der Form (S = Höhe der Form, top = oberster Punkt in der Mitte):
 *  - Geweih: zwei geschwungene Stangen mit Enden, links und rechts der Mitte, unten in der Form verankert
 *  - Schleife: zwei Schlaufen (mit Loch) und ein Knoten
 *  - Kappe: breite Kappe mit drei kleinen Löchern als Muster
 */
export function topperArea(kind: OrnamentTopper, top: number, S: number): MultiPolygon {
  const P = (x: number, y: number): XY => [x * S, top + y * S];
  const ell = (cx: number, cy: number, rx: number, ry: number, rot: number, n = 40): XY[] => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2, x = rx * Math.cos(a), y = ry * Math.sin(a), c = Math.cos(rot), s2 = Math.sin(rot);
    return [cx + x * c - y * s2, cy + x * s2 + y * c] as XY;
  });
  if (kind === "antlers") {
    const parts: MultiPolygon[] = [], w = S * 0.045;
    for (const sd of [-1, 1]) {
      const q = (x: number, y: number) => P(sd * x, y);
      // Ansatz tief und nah an der Mitte – auch bei spitzen Formen (Stern, Glocke) fest verankert
      const beam = [q(0.03, -0.1), q(0.1, -0.01), q(0.17, 0.08), q(0.28, 0.19), q(0.38, 0.35)];
      for (let i = 1; i < beam.length; i++) parts.push(capsule(beam[i - 1], beam[i], w));
      parts.push(capsule(q(0.17, 0.08), q(0.11, 0.25), w * 0.85), capsule(q(0.28, 0.19), q(0.24, 0.34), w * 0.8), capsule(q(0.28, 0.19), q(0.43, 0.22), w * 0.75));
    }
    return unionMany(parts);
  }
  if (kind === "bow") {
    const loops = [-1, 1].map(sd => diff(poly(ell(sd * 0.17 * S, top + 0.07 * S, 0.17 * S, 0.08 * S, sd * 0.3)), poly(ell(sd * 0.17 * S, top + 0.07 * S, 0.1 * S, 0.042 * S, sd * 0.3))));
    const tails = [-1, 1].map(sd => poly([P(sd * 0.02, 0.04), P(sd * 0.07, 0.04), P(sd * 0.16, -0.12), P(sd * 0.1, -0.13)]));
    return unionMany([...loops, ...tails, poly(ell(0, top + 0.05 * S, 0.055 * S, 0.06 * S, 0))]);
  }
  if (kind === "cap") {
    const cap = roundRect(-0.17 * S, top - 0.03 * S, 0.17 * S, top + 0.1 * S, 0.03 * S);
    return diff(cap, union([-0.09, 0, 0.09].map(x => disk(x * S, top + 0.035 * S, 0.018 * S))));
  }
  return [];
}

/** Abstand vom Loch zum Rand */
export const holeMargin = (r: number) => Math.max(1.5, r * 0.8);

/** Form in der gewünschten Größe, mit Aufhänger und Textfeld */
export function ornamentBody(o: OrnamentOptions): OrnamentBody {
  const raw = rawShape(o), b = bounds(raw.body);
  const k = Math.max(10, o.size) / (b.y1 - b.y0), cx = (b.x0 + b.x1) / 2;
  const tf = ([x, y]: XY): XY => [(x - cx) * k, (y - b.y0) * k];
  let body = mapArea(raw.body, tf);
  if (o.topper && o.topper !== "none") body = unionMany([body, topperArea(o.topper, topAtCenter(body), Math.max(10, o.size))]);
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
const ringArea = (r: XY[] | [number, number][]) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(a / 2); };

/** Rechteck mit runden Ecken */
export function roundRect(x0: number, y0: number, x1: number, y1: number, r: number): MultiPolygon {
  r = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  const pts: XY[] = [];
  for (const [cx, cy, a0] of [[x1 - r, y0 + r, -90], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, 90], [x0 + r, y0 + r, 180]] as const)
    for (let k = 0; k <= 6; k++) { const a = ((a0 + k * 15) * Math.PI) / 180; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return poly(pts);
}

/** Grundlinie der Schrift: Median der Unterkanten der Teile (Unterlängen wie g, y zählen kaum) */
function baselineOf(m: MultiPolygon): number {
  const ys = m.map(p => Math.min(...(p[0] || []).map(q => q[1]))).filter(Number.isFinite).sort((a, b) => a - b);
  return ys.length ? ys[Math.floor(ys.length / 2)] : 0;
}

/**
 * Grundlinien je Textzeile: Teile (Buchstaben bzw. ganze Schreibschrift-Wörter) nach der Höhe ihrer Mitte sortieren;
 * ein großer Sprung (mehr als 40 % der üblichen Höhe) beginnt eine neue Zeile. Grundlinie einer Zeile = Median der
 * tiefsten Punkte aller Bögen (lokale Minima der Kontur) – die meisten Buchstaben stehen auf der Grundlinie, nur
 * wenige Unterlängen (g, y) reichen tiefer.
 */
export function lineBaselines(m: MultiPolygon, count = 0): number[] {
  const items = m.filter(p => p[0]?.length).map(p => {
    const b = bounds([p]), r = p[0], mins: number[] = [];
    for (let i = 0; i < r.length; i++) {
      const y = r[i][1], yp = r[(i - 1 + r.length) % r.length][1], yn = r[(i + 1) % r.length][1];
      if (y <= yp && y < yn) mins.push(y);
    }
    return { c: (b.y0 + b.y1) / 2, h: b.y1 - b.y0, mins: mins.length ? mins : [b.y0] };
  }).sort((a, b) => b.c - a.c);
  if (!items.length) return [];
  const hs = items.map(i => i.h).sort((a, b) => a - b), typical = hs[Math.floor(hs.length / 2)];
  // Zeilenanzahl bekannt: an den (count − 1) größten Sprüngen trennen
  let cuts: Set<number>;
  if (count > 1) cuts = new Set(items.slice(1).map((it, i) => ({ i: i + 1, g: items[i].c - it.c })).sort((a, b) => b.g - a.g).slice(0, count - 1).map(x => x.i));
  else cuts = new Set(items.slice(1).map((it, i) => (items[i].c - it.c > typical * 0.4 ? i + 1 : -1)).filter(i => i > 0));
  const lines: number[][] = [[...items[0].mins]];
  for (let i = 1; i < items.length; i++) {
    if (cuts.has(i)) lines.push([]);
    lines[lines.length - 1].push(...items[i].mins);
  }
  return lines.map(l => { const b = l.sort((p, q) => p - q); return b[Math.floor(b.length / 2)]; });
}

const MIXED: OrnamentDeco[] = ["stars", "flakes", "trees", "hearts"];

/** Kleines Motiv zum Ausschneiden, Mitte (cx, cy), passt in einen Kreis mit Ø s */
export function motif(kind: OrnamentDeco, cx: number, cy: number, s: number): MultiPolygon {
  const at = (pts: XY[]) => poly(pts.map(([x, y]) => [cx + x * s, cy + y * s] as XY));
  switch (kind) {
    case "stars": return at(starPts(0, 0.03, 5, 0.5, 0.21));
    case "flakes": return at(starPts(0, 0, 6, 0.5, 0.15));
    case "trees": return at([[0, 0.5], [0.38, -0.22], [0.09, -0.22], [0.09, -0.47], [-0.09, -0.47], [-0.09, -0.22], [-0.38, -0.22]]);
    case "hearts": return at(Array.from({ length: 48 }, (_, i) => {
      const a = (i / 48) * Math.PI * 2, q = Math.sin(a);
      return [(16 * q * q * q) / 32, (13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a) + 2.5) / 32] as XY;
    }));
    default: return at(circle(0, 0, 0.32, 32));
  }
}

/** Motivgröße und Steg (Material zwischen den Motiven und zum Rand) */
export const decoSize = (o: OrnamentOptions) => ({ s: Math.max(4, o.size * 0.11), web: Math.max(1.5, o.size * 0.025) });

/**
 * Motive im freien Platz verteilen: versetztes Raster, spiegelgleich zur Mitte. Ein Motiv kommt nur dorthin, wo sein
 * Kreis mit Steg ganz in der Form liegt, weg vom Namen (keep) und vom Aufhänge-Loch.
 */
export function decorate(o: OrnamentOptions, shape: MultiPolygon, keep: Box | null, edge: number, hole?: { at: XY; r: number }): MultiPolygon[] {
  if (o.deco === "none") return [];
  const { s, web } = decoSize(o), step = s + web, dy = step * 0.87, b = bounds(shape);
  const cy0 = keep ? (keep.y0 + keep.y1) / 2 : (b.y0 + b.y1) / 2;
  const out: MultiPolygon[] = [];
  for (let j = Math.floor((b.y0 - cy0) / dy); cy0 + j * dy <= b.y1; j++) {
    const y = cy0 + j * dy, off = Math.abs(j) % 2 ? 0.5 : 0;
    for (let k = Math.floor(b.x0 / step) - 1; k * step <= b.x1 + step; k++) {
      const x = (k + off) * step;
      if (keep && x + s / 2 + web > keep.x0 && x - s / 2 - web < keep.x1 && y + s / 2 + web > keep.y0 && y - s / 2 - web < keep.y1) continue;
      if (hole && Math.hypot(x - hole.at[0], y - hole.at[1]) < hole.r + s / 2 + web) continue;
      if (!diskFits(shape, x, y, s / 2 + edge)) continue;
      const kind = o.deco === "mixed" ? MIXED[(Math.abs(j) + Math.abs(Math.round(x / step * 2))) % MIXED.length] : o.deco;
      out.push(motif(kind, x, y, s));
    }
  }
  return out;
}

/** Fertiger Anhänger: Form, Aufhänger, Zierlinie, Verzierung und Name */
export function ornament(o: OrnamentOptions, text: OrnamentText): OrnamentResult {
  if (o.vertical) {
    // senkrecht: um 90° gegen den Uhrzeigersinn drehen (von unten nach oben zu lesen)
    const rot = ([x, y]: XY): XY => [-y, x];
    text = { area: mapArea(text.area, rot), lines: text.lines.map(l => ({ closed: l.closed, pts: l.pts.map(rot) })) };
  }
  if (o.layers === 2 || o.layers === 3) return twoLayers(o, text);
  const ob = ornamentBody(o);
  const shape = diff(ob.body, ob.hole);
  const box = { ...ob.textBox };
  let lines: ScoreLine[] = [], inset = 0;
  if (o.border) {
    // Zierlinie: Form (mit Loch) um d nach innen – die Ränder wachsen von beiden Seiten in die Form hinein
    // (Umgebung = Rahmen minus Form, mit Rand wachsen lassen und von der Form abziehen)
    const d = borderInset(o), b = bounds(shape);
    const around = diff(poly([[b.x0 - 5, b.y0 - 5], [b.x1 + 5, b.y0 - 5], [b.x1 + 5, b.y1 + 5], [b.x0 - 5, b.y1 + 5]]), shape);
    lines = outlineLines(diff(shape, grow(around, d, true)));
    box.x0 += d; box.x1 -= d; box.y0 += d; box.y1 -= d;
    inset = d;
  }
  // Band: um die Schrift bleibt Platz für das Fenster
  const pad = o.inner === "band" ? Math.max(1.2, (box.y1 - box.y0) * 0.13) : 0;
  const tx = fitText(text, { x0: box.x0 + pad, y0: box.y0 + pad, x1: box.x1 - pad, y1: box.y1 - pad }, o.textSize);
  // Einzellinien-Schrift: immer als Linie gravieren
  const open = tx.lines.length > 0;
  let cut = shape, engrave: MultiPolygon = [], top: MultiPolygon = [], textLines: ScoreLine[] = [], dropped = 0;
  let keep: Box | null = null;
  if (open) {
    textLines = tx.lines;
    keep = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const l of tx.lines) for (const [x, y] of l.pts) { keep.x0 = Math.min(keep.x0, x); keep.x1 = Math.max(keep.x1, x); keep.y0 = Math.min(keep.y0, y); keep.y1 = Math.max(keep.y1, y); }
  } else if (tx.area.length) {
    keep = bounds(tx.area);
    if (o.inner === "engrave") engrave = tx.area;
    else if (o.inner === "score") textLines = outlineLines(tx.area);
    else if (o.inner === "layer") top = tx.area;
    else if (o.inner === "band") {
      // Fenster ausschneiden, Buchstaben und Steg auf der Grundlinie bleiben stehen
      const tb = keep, th = tb.y1 - tb.y0, bar = Math.max(1.2, th * 0.08), base = baselineOf(tx.area);
      const win = roundRect(tb.x0 - pad, tb.y0 - pad, tb.x1 + pad, tb.y1 + pad, pad * 0.8);
      const steg: MultiPolygon = poly([[tb.x0 - pad, base - bar * 0.6], [tb.x1 + pad, base - bar * 0.6], [tb.x1 + pad, base + bar * 0.4], [tb.x0 - pad, base + bar * 0.4]]);
      cut = diff(shape, diff(win, union([tx.area, steg])));
      // lose Teilchen (i-Punkte, Innenteil vom o ohne Steg) würden herausfallen – nur das größte Teil bleibt
      if (cut.length > 1) {
        const big = cut.reduce((a, p) => (ringArea(p[0]) > ringArea(a[0]) ? p : a));
        dropped = cut.length - 1;
        cut = [big];
      }
      keep = { x0: tb.x0 - pad, y0: tb.y0 - pad, x1: tb.x1 + pad, y1: tb.y1 + pad };
    }
    else cut = diff(shape, solid(tx.area)); // wie eine Schablone: Innenräume von o, a … fallen mit heraus
  }
  const motifs = decorate(o, shape, keep, decoSize(o).web + inset, ob.holeAt && ob.holeR ? { at: ob.holeAt, r: ob.holeR } : undefined);
  if (motifs.length) cut = polygonClipping.difference(cut, ...motifs);
  lines = [...clipLines(lines, cut, 0.2), ...clipLines(textLines, cut, 0.2)];
  const all = bounds(union([cut, top]));
  return { cut, engrave, top, lines, pieces: countPieces(cut), w: all.x1 - all.x0, h: all.y1 - all.y0, dropped, back: [], backEngrave: [], backLines: [] };
}

/** Breite des Rahmens bei zwei Schichten */
export const frameWidth = (o: OrnamentOptions) => Math.max(2.5, o.size * 0.06);

/** Fläche um d nach innen (Umgebung wachsen lassen und abziehen) */
export function insetArea(m: MultiPolygon, d: number): MultiPolygon {
  const b = bounds(m);
  const around = diff(poly([[b.x0 - 5, b.y0 - 5], [b.x1 + 5, b.y0 - 5], [b.x1 + 5, b.y1 + 5], [b.x0 - 5, b.y1 + 5]]), m);
  return diff(m, grow(around, d, true));
}

/**
 * Zwei Schichten: vorn ein Rahmen (Ring) mit Landschaft unten und dem Namen, der auf einem Steg von Rand zu Rand
 * steht (ausschneiden/Band) – dahinter die volle Grundplatte zum Bemalen/Beizen. Gravieren/als Linie: der Name kommt
 * auf die Grundplatte (durchs Fenster zu sehen), ebenso die Verzierung.
 */
function twoLayers(o: OrnamentOptions, text: OrnamentText): OrnamentResult {
  const ob = ornamentBody(o), H = Math.max(10, o.size), fw = frameWidth(o), frameOnly = o.layers === 3;
  const back = diff(ob.body, ob.hole);
  // Fenster: Form um die Rahmenbreite nach innen, mit Abstand zum Aufhänge-Loch
  let win = insetArea(ornamentBody({ ...o, hanger: "none", topper: "none" }).body, fw);
  if (ob.holeAt) win = diff(win, disk(ob.holeAt[0], ob.holeAt[1], ob.holeR + holeMargin(ob.holeR) + fw * 0.5));
  const wb = bounds(win);
  // Steg und Landschaft reichen bis in die Mitte des Rahmens – nur an der Kante anliegend hielten sie nicht sicher
  const reach = insetArea(ornamentBody({ ...o, hanger: "none", topper: "none" }).body, fw / 2);
  // Landschaft unten im Fenster
  const kind = o.scene || "none";
  const land = kind === "none" ? [] : scene({ x0: wb.x0 - 1, x1: wb.x1 + 1, bottom: wb.y0 - fw, base: wb.y0 + (wb.y1 - wb.y0) * 0.17, hill: H * 0.035,
    item: H * 0.17, kind, seed: o.seed || 1, houses: 0.35 }).area;
  const landIn = land.length ? polygonClipping.intersection(land, reach) : [];
  // Textfeld: im freien Fenster über der Landschaft – so breit, wie das Fenster in dieser Höhe ist
  const box = { ...ob.textBox };
  if (landIn.length) {
    const m = H * 0.025, y0 = bounds(landIn).y1 + m, room = wb.y1 - m - y0;
    const y1 = y0 + Math.min(room, Math.max(H * 0.12, room * (o.vertical ? 0.9 : 0.55)));
    // halbe Breite des Fensters in Höhe y (von der Mitte nach außen abtasten)
    const half = (y: number) => { let w = 0; while (w < wb.x1 && inRegion(win, w + 0.5, y) && inRegion(win, -w - 0.5, y)) w += 0.5; return w; };
    const hw = Math.min(half(y0), half((y0 + y1) / 2), half(y1)) * 0.88;
    if (room > H * 0.06 && hw > 2) { box.x0 = -hw; box.x1 = hw; box.y0 = y0; box.y1 = y1; }
  } else { box.x0 = Math.max(box.x0, wb.x0 + fw * 0.3); box.x1 = Math.min(box.x1, wb.x1 - fw * 0.3); }
  const tx = fitText(text, box, o.textSize);
  // nur Rahmen: der Name steht immer auf dem Steg (es gibt keine Grundplatte zum Gravieren)
  const stand = (frameOnly || o.inner === "cut" || o.inner === "band") && !tx.lines.length && tx.area.length;
  let backEngrave: MultiPolygon = [], backLines: ScoreLine[] = [], top: MultiPolygon = [];
  const parts: MultiPolygon[] = [diff(back, win), landIn];
  let keep: Box | null = null;
  if (tx.area.length || tx.lines.length) {
    const tb = tx.area.length ? bounds(tx.area) : box;
    keep = tb;
    if (stand) {
      // Name steht auf einem Steg von Rand zu Rand (senkrechter Name: Steg senkrecht in der Mitte)
      const th = o.vertical ? tb.x1 - tb.x0 : tb.y1 - tb.y0, bar = Math.max(1.2, th * 0.09);
      const steg: MultiPolygon = o.vertical
        ? poly([[tb.x1 - bar * 0.4, wb.y0 - 1], [tb.x1 + bar * 0.6, wb.y0 - 1], [tb.x1 + bar * 0.6, wb.y1 + 1], [tb.x1 - bar * 0.4, wb.y1 + 1]])
        // je Textzeile ein eigener Steg auf ihrer Grundlinie
        : union(lineBaselines(tx.area, o.textLines || 0).map(base => poly([[wb.x0 - 1, base - bar * 0.6], [wb.x1 + 1, base - bar * 0.6], [wb.x1 + 1, base + bar * 0.4], [wb.x0 - 1, base + bar * 0.4]])));
      parts.push(union([polygonClipping.intersection(tx.area, win), polygonClipping.intersection(steg, reach)]));
    } else if (o.inner === "layer") top = tx.area;
    else if (o.inner === "score" || tx.lines.length) backLines = [...outlineLines(tx.area), ...tx.lines];
    else backEngrave = tx.area;
  }
  let cut = diff(unionMany(parts.filter(m => m.length)), ob.hole);
  let dropped = 0;
  if (cut.length > 1) {
    const big = cut.reduce((a, p) => (ringArea(p[0]) > ringArea(a[0]) ? p : a));
    dropped = cut.length - 1;
    cut = [big];
  }
  // Verzierung: durchs Fenster sichtbar auf die Grundplatte graviert (nicht unter Rahmen, Landschaft oder Name)
  if (o.deco !== "none" && !frameOnly) {
    const free = diff(win, union([landIn, ...(keep ? [poly([[keep.x0, keep.y0], [keep.x1, keep.y0], [keep.x1, keep.y1], [keep.x0, keep.y1]])] : [])]));
    const motifs = decorate(o, free, null, decoSize(o).web * 0.5);
    if (motifs.length) backEngrave = union([backEngrave, ...motifs]);
  }
  // Zierlinie: mitten im Ring
  const lines = o.border ? clipLines(outlineLines(insetArea(ornamentBody({ ...o, hanger: "none", topper: "none" }).body, fw / 2)), cut, 0.2) : [];
  const all = bounds(union([back, top]));
  if (frameOnly) return { cut, engrave: [], top, lines, pieces: countPieces(cut), w: all.x1 - all.x0, h: all.y1 - all.y0, dropped, back: [], backEngrave: [], backLines: [] };
  return { cut, engrave: [], top, lines, pieces: countPieces(cut), w: all.x1 - all.x0, h: all.y1 - all.y0, dropped,
    back, backEngrave, backLines: clipLines(backLines, back, 0.2) };
}
