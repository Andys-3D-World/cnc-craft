/**
 * BUCHSTABEN-STECKER-GENERATOR: Buchstaben, Zahlen oder kurze Texte in einem Zierrahmen – mit Stab zum Reinstecken
 * (Torte, Blumentopf), Loch zum Aufhängen oder zwei Löchern für eine Girlande (Fenster: editor/letterTopperGen.ts)
 *
 * Rahmen: Oval, Kreis, Rechteck (runde Ecken), Sechseck, Herz – Rand glatt, gewellt, mit Perlen (Wellen mit kleinen
 * Löchern) oder doppelt (Gravurlinie in der Mitte des Rings). Alles für CNC Craft gezeichnet.
 * Das Zeichen wird so groß gesetzt, dass es oben/unten (bzw. links/rechts) ein Stück in den Ring hineinragt – so hängt
 * es fest am Rahmen und alles ist ein Teil. Was trotzdem lose bliebe, fällt weg (dropped, das Fenster sagt es).
 * Einzellinien-Schriften werden zu Stegen mit runden Enden verdickt.
 *
 * Nur Geometrie, ohne Oberfläche (Tests: `npm test`). Alles in mm, Y nach oben; Rahmen-Mitte bei x = 0.
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import { bounds, union, unionMany, grow, inRegion, outlineLines, clipLines, type ScoreLine, type XY } from "./nameConnect.ts";
import { capsule, roundRect, type OrnamentText } from "./ornament.ts";

export type TopperShape = "oval" | "circle" | "square" | "hexagon" | "heart";
export const TOPPER_SHAPES: TopperShape[] = ["oval", "circle", "square", "hexagon", "heart"];
export type TopperEdge = "plain" | "scallop" | "beads" | "double";
export const TOPPER_EDGES: TopperEdge[] = ["plain", "scallop", "beads", "double"];
export type TopperMount = "stick" | "hole" | "garland" | "none";
export const TOPPER_MOUNTS: TopperMount[] = ["stick", "hole", "garland", "none"];

export interface TopperOptions {
  shape: TopperShape;
  edge: TopperEdge;
  w: number; h: number; // Rahmen außen (mm); Kreis/Sechseck/Herz nehmen nur die Höhe
  ring: number;         // Breite des Rings (mm)
  mount: TopperMount;
  stickW: number; stickL: number; // Stab: Breite und Länge unter dem Rahmen
  holeD: number;        // Loch-Ø (Aufhänger, Girlande)
  thicken: number;      // Fettung des Zeichens (mm)
}

/** Rahmen – für alle Zeichen gleich, deshalb einmal rechnen */
export interface TopperFrame {
  ring: MultiPolygon;    // Ring mit Rand-Verzierung und Halterung, ohne Löcher
  holes: MultiPolygon;   // Löcher (Aufhänger, Perlen)
  reach: MultiPolygon;   // so weit darf das Zeichen reichen (Öffnung + ein Stück in den Ring)
  open: { x0: number; y0: number; x1: number; y1: number }; // Öffnung (Umriss-Rechteck)
  lines: ScoreLine[];    // Gravurlinien (doppelter Rand)
  holeAt: XY[]; holeR: number;
}

export interface TopperResult { cut: MultiPolygon; lines: ScoreLine[]; pieces: number; dropped: number; w: number; h: number }

// ---------- kleine Helfer ----------
const close = (r: XY[]): XY[] => [...r, r[0]];
const poly = (r: XY[]): MultiPolygon => [[close(r)]];
const circle = (cx: number, cy: number, r: number, n = 72): XY[] =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * Math.PI * 2), cy + r * Math.sin((i / n) * Math.PI * 2)] as XY);
const disk = (cx: number, cy: number, r: number, n = 48): MultiPolygon => poly(circle(cx, cy, r, n));
const diff = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => (a.length && b.length ? polygonClipping.difference(a, b) : a);
const ringArea = (r: [number, number][]) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(a / 2); };

/** Fläche um d nach innen (Umgebung wachsen lassen und abziehen) */
function inset(m: MultiPolygon, d: number): MultiPolygon {
  if (!(d > 0)) return m;
  const b = bounds(m);
  const around = diff(poly([[b.x0 - 5, b.y0 - 5], [b.x1 + 5, b.y0 - 5], [b.x1 + 5, b.y1 + 5], [b.x0 - 5, b.y1 + 5]]), m);
  return diff(m, grow(around, d, true));
}

/** Außenform des Rahmens, Mitte (0, 0) */
function outerShape(o: TopperOptions): XY[] {
  const H = o.h, W = o.shape === "oval" || o.shape === "square" ? o.w : H;
  switch (o.shape) {
    case "square": return roundRect(-W / 2, -H / 2, W / 2, H / 2, Math.min(W, H) * 0.12)[0][0].slice(0, -1) as XY[];
    case "hexagon": {
      // Spitze oben und unten, Höhe H
      return Array.from({ length: 6 }, (_, i) => [(H / 2) * Math.cos(Math.PI / 2 + (i * Math.PI) / 3), (H / 2) * Math.sin(Math.PI / 2 + (i * Math.PI) / 3)] as XY);
    }
    case "heart": {
      const pts: XY[] = Array.from({ length: 144 }, (_, i) => {
        const a = (i / 144) * Math.PI * 2, s = Math.sin(a);
        return [16 * s * s * s, 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)] as XY;
      });
      const b = bounds(poly(pts)), k = H / (b.y1 - b.y0), cy = (b.y0 + b.y1) / 2;
      return pts.map(([x, y]) => [x * k, (y - cy) * k] as XY);
    }
    case "circle": return circle(0, 0, H / 2, 120);
    default: return Array.from({ length: 120 }, (_, i) => [(W / 2) * Math.cos((i / 120) * Math.PI * 2), (H / 2) * Math.sin((i / 120) * Math.PI * 2)] as XY);
  }
}

/** Gleichmäßig verteilte Punkte auf einer geschlossenen Kontur (Abstand ≈ step) */
function along(r: XY[], step: number): XY[] {
  const L: number[] = [0];
  for (let i = 1; i <= r.length; i++) L.push(L[i - 1] + Math.hypot(r[i % r.length][0] - r[i - 1][0], r[i % r.length][1] - r[i - 1][1]));
  const total = L[r.length], n = Math.max(6, Math.round(total / step)), out: XY[] = [];
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const s = (k / n) * total;
    while (L[seg + 1] < s) seg++;
    const a = r[seg], b = r[(seg + 1) % r.length], t = (s - L[seg]) / Math.max(1e-9, L[seg + 1] - L[seg]);
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Weitester Schnittpunkt eines Strahls von (0, 0) in Richtung (dx, dy) mit der Kontur */
function rayHit(r: XY[], dx: number, dy: number): XY {
  let best = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [ax, ay] = r[j], [bx, by] = r[i], ex = bx - ax, ey = by - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (ax * ey - ay * ex) / den, u = (ax * dy - ay * dx) / den;
    if (t > 0 && u >= 0 && u <= 1) best = Math.max(best, t);
  }
  return [dx * best, dy * best];
}

/** Abstand zwischen Loch und Rand */
export const holeWeb = (r: number) => Math.max(1.5, r * 0.8);

export function topperFrame(o: TopperOptions): TopperFrame {
  const ringW = Math.max(1.5, Math.min(o.ring, o.h / 4));
  const base = outerShape(o), outer = poly(base);
  const opening = inset(outer, ringW);
  const parts: MultiPolygon[] = [diff(outer, opening)];
  let holes: MultiPolygon[] = [], lines: ScoreLine[] = [];
  const holeAt: XY[] = [];
  const holeR = Math.max(0.5, o.holeD / 2), rOut = holeR + holeWeb(holeR);
  // Halterung
  if (o.mount === "stick") {
    const sw = Math.max(2, o.stickW) / 2, bot = rayHit(base, 0, -1)[1], L = Math.max(5, o.stickL), tip = Math.min(L * 0.4, sw * 3);
    parts.push(poly([[-sw, bot + ringW * 0.6], [-sw, bot - L + tip], [0, bot - L], [sw, bot - L + tip], [sw, bot + ringW * 0.6]]));
  } else if (o.mount === "hole" || o.mount === "garland") {
    // Ohr mit Loch über dem Rand – oben in der Mitte bzw. links und rechts oben (für eine Schnur)
    const dirs: XY[] = o.mount === "hole" ? [[0, 1]] : [[-Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, Math.SQRT1_2]];
    for (const [dx, dy] of dirs) {
      const p = rayHit(base, dx, dy), c: XY = [p[0] + dx * rOut * 0.25, p[1] + dy * rOut * 0.25];
      parts.push(disk(c[0], c[1], rOut));
      holes.push(disk(c[0], c[1], holeR));
      holeAt.push(c);
    }
  }
  // Rand-Verzierung: kleine Bögen außen auf der Kante
  if (o.edge === "scallop" || o.edge === "beads") {
    const rb = Math.max(o.edge === "beads" ? 2.2 : 1.4, ringW * 0.55);
    for (const [x, y] of along(base, rb * 2.05)) {
      const l = Math.hypot(x, y) || 1, cx = x + (x / l) * rb * 0.2, cy = y + (y / l) * rb * 0.2;
      parts.push(disk(cx, cy, rb, 24));
      // Perlen-Loch nicht neben dem Aufhänge-Loch (dort ist das Ohr)
      if (o.edge === "beads" && holeAt.every(([hx, hy]) => Math.hypot(cx - hx, cy - hy) > rOut + rb)) holes.push(disk(cx, cy, rb * 0.36, 16));
    }
  } else if (o.edge === "double") lines = outlineLines(inset(outer, ringW / 2));
  const ring = unionMany(parts);
  const ob = bounds(opening);
  return { ring, holes: union(holes), reach: inset(outer, ringW * 0.55), open: ob, lines, holeAt, holeR };
}

/** Linien (Einzellinien-Schrift) zu Stegen mit runden Enden verdicken */
function strokes(lines: ScoreLine[], w: number): MultiPolygon {
  const parts: MultiPolygon[] = [];
  for (const l of lines) for (let i = 1; i < l.pts.length + (l.closed ? 1 : 0); i++) {
    const a = l.pts[i - 1], b = l.pts[i % l.pts.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) parts.push(capsule(a, b, w));
  }
  return unionMany(parts);
}

/**
 * Ein Stecker: Rahmen + Zeichen (Schrift beliebig groß/gelegen – wird eingepasst).
 * Größe: so groß, dass das Zeichen gerade noch ganz in „reach“ liegt – dann berührt es den Ring und ragt dort ein
 * Stück hinein. Hängt so noch ein Teil lose (i: nur der Punkt berührt), wird es schrittweise größer, bis alles hält
 * (überstehende Teile werden am Ring abgeschnitten).
 */
export function topper(f: TopperFrame, o: TopperOptions, text: OrnamentText): TopperResult {
  const ringW = Math.max(1.5, Math.min(o.ring, o.h / 4)), ov = ringW * 0.45;
  const lb = bounds(text.area);
  for (const l of text.lines) for (const [x, y] of l.pts) { lb.x0 = Math.min(lb.x0, x); lb.x1 = Math.max(lb.x1, x); lb.y0 = Math.min(lb.y0, y); lb.y1 = Math.max(lb.y1, y); }
  const mx = (f.open.x0 + f.open.x1) / 2, my = (f.open.y0 + f.open.y1) / 2, lx = (lb.x0 + lb.x1) / 2, ly = (lb.y0 + lb.y1) / 2;
  const tf = (k: number) => ([x, y]: [number, number] | XY): XY => [mx + (x - lx) * k, my + (y - ly) * k];
  const sw = Math.max(1.5, o.h * 0.045); // Strichbreite bei Einzellinien-Schrift

  const build = (k: number) => {
    let letter: MultiPolygon = [];
    if (k > 0) {
      letter = text.area.map(p => p.map(r => r.map(tf(k))));
      if (text.lines.length) letter = union([letter, strokes(text.lines.map(l => ({ closed: l.closed, pts: l.pts.map(tf(k)) })), sw)]);
      if (o.thicken > 0) letter = grow(letter, o.thicken, true);
      // nicht über den Ring hinaus
      letter = letter.length ? polygonClipping.intersection(letter, f.reach) : [];
    }
    let cut = diff(union([f.ring, letter]), f.holes);
    let dropped = 0;
    if (cut.length > 1) {
      // lose Teile würden herausfallen – nur das größte bleibt
      const big = cut.reduce((a, p) => (ringArea(p[0]) > ringArea(a[0]) ? p : a));
      dropped = cut.length - 1;
      cut = [big];
    }
    return { cut, dropped, letter };
  };

  let best = build(0);
  if (lb.x1 > lb.x0 || lb.y1 > lb.y0) {
    // höchstens: Umriss-Rechteck reicht oben/unten bzw. links/rechts um ov in den Ring
    const ow = f.open.x1 - f.open.x0 + 2 * ov, oh = f.open.y1 - f.open.y0 + 2 * ov;
    const kMax = Math.min(lb.y1 > lb.y0 ? oh / (lb.y1 - lb.y0) : Infinity, lb.x1 > lb.x0 ? ow / (lb.x1 - lb.x0) : Infinity);
    // größtes k, bei dem alle Punkte (plus Fettung/halber Strich) in reach liegen
    const pad = o.thicken + (text.lines.length ? sw / 2 : 0);
    const pts: [number, number][] = [...text.area.flatMap(p => p.flat()), ...text.lines.flatMap(l => l.pts)] as [number, number][];
    const step = Math.max(1, Math.floor(pts.length / 400)), sample = pts.filter((_, i) => i % step === 0);
    const fits = (k: number) => sample.every(q => {
      const [x, y] = tf(k)(q);
      return pad ? [[0, 0], [pad, 0], [-pad, 0], [0, pad], [0, -pad]].every(([a, b]) => inRegion(f.reach, x + a, y + b)) : inRegion(f.reach, x, y);
    });
    let lo = 0, hi = kMax;
    if (fits(hi)) lo = hi;
    else for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (fits(m)) lo = m; else hi = m; }
    best = build(lo * 1.02 || kMax);
    for (let k = lo * 1.08; best.dropped && k < kMax; k *= 1.06) best = build(k);
    if (best.dropped) { const r = build(kMax); if (r.dropped <= best.dropped) best = r; }
  }
  const { cut, dropped, letter } = best;
  // doppelter Rand: Linie nur, wo kein Zeichen darüber liegt
  const lines = f.lines.length ? clipLines(f.lines, diff(cut, grow(letter, 0.6)), 0.2) : [];
  const b = bounds(cut);
  return { cut, lines, pieces: cut.length, dropped, w: b.x1 - b.x0, h: b.y1 - b.y0 };
}
