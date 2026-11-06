/**
 * FORMBOX: Kiste in beliebiger Form (Herz, Stern, Buchstabe, Ziffer, eigene Form …). Fenster: editor/shapeBoxGen.ts
 *
 * Herzstück ist eine Wand entlang einer beliebigen geschlossenen Mittellinie – in zwei Bauarten:
 *   flex      ein Streifen je Kontur, in den Biegungen mit Biegescharnier (nur Laser). Stoß mit Puzzle-Verschluss.
 *   segments  gerade Wandstücke, die innen an den Knicken aneinanderstoßen (Laser und Fräse, mit Dogbones).
 * Beide stecken mit Zapfen in Schlitzen von Boden und Ring. Löcher in der Form (A, O, 8 …) bekommen eine eigene innere Wand.
 *
 * Aufbau von außen nach innen: Plattenrand – Rand (rim) – Wand (t, Mittellinie in der Mitte) – Ring – Öffnung.
 * Alle Platten haben dasselbe Koordinatensystem; die Schlitze in Boden und Ring liegen deckungsgleich.
 *
 * Flex-Streifen: Die Seite, die auf dem Bett oben liegt, zeigt nach außen, die Oberkante bleibt oben.
 *
 * Nur Geometrie (Tests: tests/shapeBox.test.ts). Alles in mm, Y nach oben.
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Polygon } from "polygon-clipping";
import { simplifyPolygon, pointInPoly, polygonArea } from "./polyOffset.ts";
import { offsetArea, type XY } from "./joints.ts";
import { finishPanels, flexCuts, flat, tabsOn, type Panel, type V3 } from "./box.ts";
import { ornamentBody, type OrnamentShape } from "./ornament.ts";
import { ellipse, poly, starPoints, stroke } from "./seasonShapes.ts";
import { bounds, unionMany } from "./nameConnect.ts";

type P = { x: number; y: number };

export type WallKind = "flex" | "segments";
export const WALL_KINDS: WallKind[] = ["flex", "segments"];

export interface ShapeBoxOptions {
  area: MultiPolygon;  // Form (Maßstab mm), Außenkante der Platte ungefähr hier
  h: number;           // Gesamthöhe außen (Boden bis Oberkante Ring)
  t: number;           // Materialstärke
  kerf: number;        // Schnittspalt
  finger: number;      // gewünschte Zapfenlänge
  wall: WallKind;
  lid: boolean;        // Stülpdeckel aus zwei Platten
  rim: number;         // Plattenrand außerhalb der Wand
  bend: number;        // Flex: kleinster Biegeradius der Wand-Mittellinie
  tool: number;        // Wandstücke: Fräser Ø für Dogbones (0 = Laser)
}

/** Eine Wand (eine Kontur) – für Prüfungen und Anzeige */
export interface WallInfo { loop: P[]; length: number; tabs: number; tabLen: number[]; slotLen: number[] }

export interface ShapeBoxResult {
  panels: Panel[];
  walls: WallInfo[];
  error: string;       // Text-Schlüssel, leer = passt
  dropped: number;     // Teile der Form, die wegfallen (z. B. i-Punkt)
  W: number; D: number; H: number;
  longest: number;     // längstes Teil (Flex-Streifen können länger als das Bett werden)
}

// ---------- Formen ----------

export type ShapeKind = "circle" | "oval" | "triangle" | "square" | "pentagon" | "hexagon" | "octagon" | "heart" | "star" | "arch"
  | "tree" | "bell" | "ball" | "mitten" | "stocking" | "sweater" | "snowman" | "house"
  | "egg" | "bunny" | "pumpkin" | "ghost" | "flower" | "sun" | "shell" | "leaf" | "acorn" | "mushroom" | "letter" | "custom";
export const SHAPE_GROUPS: Record<string, ShapeKind[]> = {
  basic: ["circle", "oval", "triangle", "square", "pentagon", "hexagon", "octagon", "heart", "star", "arch"],
  christmas: ["tree", "bell", "ball", "mitten", "stocking", "sweater", "snowman", "house"],
  seasons: ["egg", "bunny", "pumpkin", "ghost", "flower", "sun", "shell", "leaf", "acorn", "mushroom"],
  own: ["letter", "custom"],
};
export const SHAPE_KINDS: ShapeKind[] = Object.values(SHAPE_GROUPS).flat();
/** Formen, deren Name schon beim Deko-Anhänger steht */
const ORNAMENT_NAMED: ShapeKind[] = ["heart", "star", "arch", "tree", "bell", "ball", "egg", "bunny", "pumpkin", "ghost", "flower", "sun", "shell", "leaf", "acorn", "mushroom"];
export const shapeLabelKey = (k: ShapeKind) => (ORNAMENT_NAMED.includes(k) ? "orn.shape." : "fbx.shape.") + k;

function regular(n: number): MultiPolygon {
  return poly(Array.from({ length: n }, (_, i) => { const a = Math.PI / 2 + ((2 * i + 1 + (n % 2 ? 1 : 0) * -1) * Math.PI) / n; return [Math.cos(a), Math.sin(a)] as XY; }));
}

/** Eigene, einfache Umrisse (für CNC Craft gezeichnet) */
function ownShape(k: ShapeKind): MultiPolygon {
  const rect = (x0: number, y0: number, x1: number, y1: number): MultiPolygon => poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  switch (k) {
    case "mitten": return unionMany([rect(-0.3, 0, 0.3, 0.3), poly(ellipse(0, 0.68, 0.36, 0.48)), stroke([0.2, 0.52], [0.55, 0.82], 0.26)]);
    case "stocking": return unionMany([rect(-0.2, 0.3, 0.2, 1.05), rect(-0.27, 0.86, 0.27, 1.1), stroke([0, 0.22], [0.5, 0.2], 0.42)]);
    case "sweater": {
      const body = unionMany([rect(-0.42, 0, 0.42, 0.9), stroke([0.3, 0.76], [0.74, 0.22], 0.28), stroke([-0.3, 0.76], [-0.74, 0.22], 0.28)]);
      return polygonClipping.difference(body, poly(ellipse(0, 0.92, 0.17, 0.11)));
    }
    case "snowman": return unionMany([poly(ellipse(0, 0.38, 0.38, 0.38)), poly(ellipse(0, 0.92, 0.28, 0.28)), poly(ellipse(0, 1.32, 0.2, 0.2))]);
    case "house": return poly([[-0.5, 0], [0.5, 0], [0.5, 0.6], [0, 1.05], [-0.5, 0.6]]);
    default: return poly(ellipse(0, 0, 1, 1));
  }
}

/** Rohform (beliebiger Maßstab). letter und custom kommen von außen */
export function shapeOutline(k: ShapeKind, points = 5): MultiPolygon {
  switch (k) {
    case "circle": return poly(ellipse(0, 0, 1, 1, 0, 96));
    case "oval": return poly(ellipse(0, 0, 1, 0.65, 0, 96));
    case "triangle": return regular(3);
    case "square": return poly([[0, 0], [1, 0], [1, 1], [0, 1]]);
    case "pentagon": return regular(5);
    case "hexagon": return regular(6);
    case "octagon": return regular(8);
    case "mitten": case "stocking": case "sweater": case "snowman": case "house": return ownShape(k);
    case "star": { const n = Math.round(Math.max(4, Math.min(12, points))); return poly(starPoints(0, 0, n, 1, Math.min(0.72, 0.5 + 0.03 * (n - 5)))); }
    default:
      return ornamentBody({ shape: k as OrnamentShape, size: 100, points: 5, hanger: "none", holeD: 1, topper: "none" } as any).body;
  }
}

/** Form auf Breite w (und Tiefe d; d = 0: Seitenverhältnis behalten) bringen, unten links auf (0, 0) */
export function sizedArea(m: MultiPolygon, w: number, d = 0): MultiPolygon {
  const b = bounds(m);
  const kx = w / Math.max(1e-6, b.x1 - b.x0), ky = d > 0 ? d / Math.max(1e-6, b.y1 - b.y0) : kx;
  return m.map(p => p.map(r => r.map(([x, y]) => [(x - b.x0) * kx, (y - b.y0) * ky] as XY)));
}

// ---------- Hilfen ----------

const ringPts = (r: number[][]): P[] => {
  const q = r.map(([x, y]) => ({ x, y })), a = q[0], z = q[q.length - 1];
  return q.length > 1 && Math.hypot(a.x - z.x, a.y - z.y) < 1e-9 ? q.slice(0, -1) : q;
};
const ringOf = (l: P[]): XY[] => { const q = l.map(p => [p.x, p.y] as XY); return [...q, q[0]]; };
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

/** Wie weit ragte die Form über die gerundete Form hinaus? Eine Spitze wenig, ein abgefallener Ärmel viel */
function lostDepth(before: MultiPolygon, after: MultiPolygon): number {
  const ends = after.flatMap(p => p.flatMap(r => simplifyPolygon(ringPts(r), 0.1)));
  if (!ends.length) return 0;  // nichts mehr übrig: das meldet später „zu klein“
  let far = 0;
  for (const p of before) for (const q of simplifyPolygon(ringPts(p[0]), 0.3)) {
    let near = Infinity;
    for (const e of ends) near = Math.min(near, dist(q, e));
    far = Math.max(far, near);
  }
  return far;
}

/** größtes Teil einer Fläche und die Zahl der übrigen */
function largest(m: MultiPolygon): { poly: Polygon | null; others: number } {
  let best: Polygon | null = null, bestA = 0;
  for (const p of m) { const a = Math.abs(polygonArea(ringPts(p[0]))); if (a > bestA) { bestA = a; best = p; } }
  return { poly: best, others: Math.max(0, m.filter(p => Math.abs(polygonArea(ringPts(p[0]))) > bestA * 0.01).length - 1) };
}

/** Bogenlängen einer geschlossenen Linie */
class Arc {
  pts: P[]; cum: number[] = [0]; L = 0;
  constructor(pts: P[]) {
    this.pts = pts;
    for (let i = 0; i < pts.length; i++) { this.L += dist(pts[i], pts[(i + 1) % pts.length]); this.cum.push(this.L); }
  }
  at(s: number): P {
    s = ((s % this.L) + this.L) % this.L;
    let lo = 0, hi = this.pts.length;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= s) lo = m; else hi = m; }
    const a = this.pts[lo], b = this.pts[(lo + 1) % this.pts.length], d = this.cum[lo + 1] - this.cum[lo] || 1, f = (s - this.cum[lo]) / d;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }
  /** dieselbe Linie, beginnend bei s */
  from(s: number): Arc {
    const start = this.at(s), pts: P[] = [start];
    let i = 0;
    while (i < this.pts.length && this.cum[i + 1] <= s + 1e-9) i++;
    for (let k = 1; k <= this.pts.length; k++) {
      const q = this.pts[(i + k) % this.pts.length];
      if (dist(q, pts[pts.length - 1]) > 1e-6) pts.push(q);
    }
    if (dist(pts[pts.length - 1], start) < 1e-6) pts.pop();
    return new Arc(pts);
  }
}

/** Rechteck-Schlitz um die Strecke a–b, Breite w, um off zur Seite geschoben */
function slotRect(a: P, b: P, w: number, off = 0): P[] {
  const l = dist(a, b) || 1, ux = (b.x - a.x) / l, uy = (b.y - a.y) / l, nx = -uy, ny = ux, r = w / 2;
  const c = (p: P, d: number): P => ({ x: p.x + nx * (d + off), y: p.y + ny * (d + off) });
  return [c(a, -r), c(b, -r), c(b, r), c(a, r)];
}

/** Wo biegt sich die Linie? Abschnitte [von, bis] in Bogenlänge */
function bendSections(arc: Arc, t: number): { flags: boolean[]; ds: number; sections: [number, number][] } {
  const n = Math.min(1600, Math.max(16, Math.ceil(arc.L / 0.5))), ds = arc.L / n, win = Math.max(1.5, t);
  const flags: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const s = i * ds, a = arc.at(s - win), m = arc.at(s), b = arc.at(s + win);
    let d = Math.atan2(b.y - m.y, b.x - m.x) - Math.atan2(m.y - a.y, m.x - a.x);
    d = Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
    flags.push(d > (3 * Math.PI) / 180);
  }
  const sections: [number, number][] = [];
  for (let i = 0; i < n; i++) if (flags[i]) {
    let j = i; while (j + 1 < n && flags[j + 1]) j++;
    sections.push([i * ds, (j + 1) * ds]); i = j;
  }
  return { flags, ds, sections };
}

/**
 * Flex-Wand entlang einer Linie: EIN Streifen. Der Stoß kommt mitten auf die längste gerade Strecke.
 * Zapfen werden in Biegungen kürzer, damit sie gerade in ihrem geraden Schlitz stecken können.
 */
export function flexWall(loop: P[], Hw: number, t: number, finger: number, ring: number): { panel: Panel; slots: P[][]; info: WallInfo } | null {
  let arc = new Arc(loop);
  const first = bendSections(arc, t);
  // längste gerade Strecke suchen (auch über das Ende hinweg)
  let best = -1, bestS = 0, n = first.flags.length, run = 0;
  for (let i = 0; i < 2 * n; i++) {
    if (first.flags[i % n]) run = 0;
    else { run++; if (run > best && run <= n) { best = run; bestS = (i + 1 - run / 2) * first.ds; } }
  }
  arc = arc.from(bestS);
  const L = arc.L, kd = Math.max(4, 2 * t);
  const start = kd + 2, usable = L - kd - 4, f = Math.max(2 * t, finger);
  const N = Math.floor(usable / (2 * f));
  if (N < 3) return null;
  const tabs: [number, number][] = [], slots: P[][] = [], slotLen: number[] = [];
  for (let i = 0; i < N; i++) {
    const c = start + ((i + 0.5) * usable) / N;
    let len = Math.min(f, (usable / N) * 0.6), sag = 0, mid = arc.at(c), s0 = 0, s1 = 0, A = mid, B = mid;
    for (let k = 0; k < 8; k++) {
      s0 = c - len / 2; s1 = c + len / 2; A = arc.at(s0); B = arc.at(s1);
      const l = dist(A, B) || 1;
      sag = Math.abs(((B.x - A.x) * (mid.y - A.y) - (B.y - A.y) * (mid.x - A.x)) / l);
      if (sag <= 0.25) break;
      len = Math.max(2.5, len * Math.sqrt(0.25 / sag) * 0.98);
      if (len <= 2.5 && k > 2) break;
    }
    if (sag > 0.6) continue;  // scharfer Knick – dort kein Zapfen
    // Schlitz: gerade, so lang wie der Zapfen, Breite + Bogenhöhe (die gerade Sehne liegt etwas neben der Bogenmitte)
    const l = dist(A, B) || 1, off = ((B.x - A.x) * (mid.y - A.y) - (B.y - A.y) * (mid.x - A.x)) / l / 2;
    const k = (s1 - s0) / l, ax = (A.x + B.x) / 2, ay = (A.y + B.y) / 2;
    const a2 = { x: ax + (A.x - ax) * k, y: ay + (A.y - ay) * k }, b2 = { x: ax + (B.x - ax) * k, y: ay + (B.y - ay) * k };
    slots.push(slotRect(a2, b2, t + sag, off));
    slotLen.push(dist(a2, b2));
    tabs.push([s0, s1]);
  }
  if (tabs.length < 3) return null;

  const y0 = t, y1 = t + Hw, H = y1 + (ring ? t : 0);
  // Biegescharnier: etwas breiter als die Biegung; nie in den Verschluss
  const { sections } = bendSections(arc, t);
  const merged: [number, number][] = [];
  for (const [a, b] of sections) {
    const lo = Math.max(kd + 1, a - t), hi = Math.min(L - 1, b + t);
    if (hi - lo < 1) continue;
    const last = merged[merged.length - 1];
    if (last && lo - last[1] < 2 * t) last[1] = hi; else merged.push([lo, hi]);
  }
  const lines = merged.flatMap(([a, b]) => flexCuts(a, b - a, y0, Hw, t));

  // Puzzle-Verschluss wie bei der runden Kiste
  const hw = kd * 1.3, nw = kd * 0.75, free = Hw - 4;
  const nK = Math.max(1, Math.min(4, Math.floor(free / (2.6 * hw))));
  const knobs = Array.from({ length: nK }, (_, i) => y0 + 2 + (free * (i + 0.5)) / nK);
  const pts: P[] = [{ x: 0, y: y0 }];
  for (const [a, b] of tabs) pts.push({ x: a, y: y0 }, { x: a, y: 0 }, { x: b, y: 0 }, { x: b, y: y0 });
  pts.push({ x: L, y: y0 });
  for (const yc of knobs) pts.push({ x: L, y: yc - nw / 2 }, { x: L + kd, y: yc - hw / 2 }, { x: L + kd, y: yc + hw / 2 }, { x: L, y: yc + nw / 2 });
  pts.push({ x: L, y: y1 });
  if (ring) for (const [a, b] of [...tabs].reverse()) pts.push({ x: b, y: y1 }, { x: b, y: H }, { x: a, y: H }, { x: a, y: y1 });
  pts.push({ x: 0, y: y1 });
  for (const yc of [...knobs].reverse()) pts.push({ x: 0, y: yc + nw / 2 }, { x: kd, y: yc + hw / 2 }, { x: kd, y: yc - hw / 2 }, { x: 0, y: yc - nw / 2 });
  const panel: Panel = { name: "flexWall", w: L + kd, h: H, pts, lines, wrap: { loop: arc.pts, z0: 0, z1: H } };
  return { panel, slots, info: { loop: arc.pts, length: L, tabs: tabs.length, tabLen: tabs.map(([a, b]) => b - a), slotLen } };
}

/** Knick an jeder Ecke einer geschlossenen Linie (Bogenmaß, Betrag) */
const turns = (v: P[]) => v.map((p, i) => {
  const a = v[(i - 1 + v.length) % v.length], b = v[(i + 1) % v.length];
  const d = Math.atan2(b.y - p.y, b.x - p.x) - Math.atan2(p.y - a.y, p.x - a.x);
  return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
});

/** Linie zu geraden Wandstücken vereinfachen. Jedes Stück bleibt mindestens minW breit (dort, wo die Wand steht) */
export function wallChords(loop: P[], t: number, minW: number): P[] {
  let v = simplifyPolygon(loop, Math.max(0.4, t * 0.2));
  const retreat = (turn: number) => (t / 2) * Math.tan(Math.min(turn, 2.6) / 2);
  while (v.length > 3) {
    const tr = turns(v);
    let worst = -1, worstW = minW;
    for (let i = 0; i < v.length; i++) {
      const j = (i + 1) % v.length, w = dist(v[i], v[j]) - retreat(tr[i]) - retreat(tr[j]);
      if (w < worstW) { worstW = w; worst = i; }
    }
    if (worst < 0) break;
    // von den beiden Enden die flachere Ecke weglassen
    const j = (worst + 1) % v.length;
    v = v.filter((_, k) => k !== (tr[worst] < tr[j] ? worst : j));
  }
  return v;
}

/** Wand aus geraden Stücken: Zapfen unten (und oben), Enden so zurückgesetzt, dass sich die Stücke innen gerade berühren */
export function segmentWall(loop: P[], /* schon aus wallChords */ Hw: number, t: number, finger: number, ring: boolean): { panels: Panel[]; slots: P[][]; info: WallInfo } | null {
  const v = loop;
  if (v.length < 3) return null;
  const tr = turns(v), H = t + Hw + (ring ? t : 0), panels: Panel[] = [], slots: P[][] = [];
  const tabLen: number[] = [], slotLen: number[] = [];
  let length = 0;
  const retreat = (turn: number) => (t / 2) * Math.tan(Math.min(turn, 2.6) / 2);
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length], j = (i + 1) % v.length, l = dist(a, b);
    const da = retreat(tr[i]), db = retreat(tr[j]), w = l - da - db;
    if (w < 2 * t) return null;
    length += l;
    const ux = (b.x - a.x) / l, uy = (b.y - a.y) / l, tabs = tabsOn(w, t, finger);
    if (!tabs.length) return null;
    for (const [s0, s1] of tabs) {
      const A = { x: a.x + ux * (da + s0), y: a.y + uy * (da + s0) }, B = { x: a.x + ux * (da + s1), y: a.y + uy * (da + s1) };
      slots.push(slotRect(A, B, t));
      tabLen.push(s1 - s0); slotLen.push(dist(A, B));
    }
    const y0 = t, y1 = t + Hw, pts: P[] = [{ x: 0, y: y0 }];
    for (const [s0, s1] of tabs) pts.push({ x: s0, y: y0 }, { x: s0, y: 0 }, { x: s1, y: 0 }, { x: s1, y: y0 });
    pts.push({ x: w, y: y0 }, { x: w, y: y1 });
    if (ring) for (const [s0, s1] of [...tabs].reverse()) pts.push({ x: s1, y: y1 }, { x: s1, y: H }, { x: s0, y: H }, { x: s0, y: y1 });
    pts.push({ x: 0, y: y1 });
    // Lage: x entlang der Sehne, Dicke quer zur Linie mittig darauf
    const nx = uy, ny = -ux;
    const o: V3 = [a.x + ux * da - nx * t / 2, a.y + uy * da - ny * t / 2, 0];
    panels.push({ name: "hexWall", w, h: H, pts, at: { o, u: [ux, uy, 0], v: [0, 0, 1], n: [nx, ny, 0] } });
  }
  return { panels, slots, info: { loop: v, length, tabs: tabLen.length, tabLen, slotLen } };
}

/** Berühren sich zwei Wand-Stellen (nicht direkte Nachbarn auf derselben Kontur)? */
function wallsTooClose(rings: P[][], t: number): boolean {
  const pts: { p: P; r: number; s: number }[] = [];
  const lens: number[] = [];
  rings.forEach((rg, r) => {
    const a = new Arc(rg), n = Math.min(400, Math.max(8, Math.ceil(a.L / 2)));
    lens[r] = a.L;
    for (let i = 0; i < n; i++) pts.push({ p: a.at((i * a.L) / n), r, s: (i * a.L) / n });
  });
  const lim = t + 0.5, near = 4 * t + 3;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const A = pts[i], B = pts[j];
    if (Math.abs(A.p.x - B.p.x) > lim || Math.abs(A.p.y - B.p.y) > lim) continue;
    if (A.r === B.r) { const d = Math.abs(A.s - B.s); if (Math.min(d, lens[A.r] - d) < near) continue; }
    if (dist(A.p, B.p) < lim) return true;
  }
  return false;
}

/** Überkreuzt sich eine geschlossene Linie? */
function crosses(p: P[]): boolean {
  const o = (a: P, b: P, c: P) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const n = p.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    const a = p[i], b = p[(i + 1) % n], c = p[j], d = p[(j + 1) % n];
    if (o(c, d, a) * o(c, d, b) < 0 && o(a, b, c) * o(a, b, d) < 0) return true;
  }
  return false;
}

const inPlate = (q: P, plate: Polygon) => pointInPoly(q.x, q.y, ringPts(plate[0])) && !plate.slice(1).some(h => pointInPoly(q.x, q.y, ringPts(h)));

/** Teil einer Fläche als Platte: eigene Koordinaten ab (0, 0), Lage in der Kiste auf Höhe z; Schlitze, die hineinfallen, werden Löcher */
function plateFrom(name: Panel["name"], p: Polygon, z: number, slots: P[][] = []): Panel {
  const o = ringPts(p[0]), x0 = Math.min(...o.map(q => q.x)), y0 = Math.min(...o.map(q => q.y));
  const mv = (l: P[]) => l.map(q => ({ x: q.x - x0, y: q.y - y0 }));
  const own = slots.filter(s => {
    const c = { x: s.reduce((a, q) => a + q.x, 0) / s.length, y: s.reduce((a, q) => a + q.y, 0) / s.length };
    return inPlate(c, p);
  });
  return { name, w: Math.max(...o.map(q => q.x)) - x0, h: Math.max(...o.map(q => q.y)) - y0, pts: mv(o),
    holes: [...p.slice(1).map(h => mv(ringPts(h))), ...own.map(mv)], at: flat(x0, y0, z) };
}

const FAIL = (error: string, dropped = 0): ShapeBoxResult => ({ panels: [], walls: [], error, dropped, W: 0, D: 0, H: 0, longest: 0 });

/**
 * Das Runden der Ecken macht Spitzen kürzer (ein Stern wird schmaler). Damit die Kiste trotzdem so breit und tief wird wie
 * eingegeben, wird die Form danach passend vergrößert und noch einmal gerechnet.
 */
export function shapeBox(o: ShapeBoxOptions): ShapeBoxResult {
  if (!o.area.length) return FAIL("fbx.err.noShape");
  const b = bounds(o.area), wantW = b.x1 - b.x0, wantD = b.y1 - b.y0;
  if (!(wantW > 1) || !(wantD > 1) || wantW > 5000 || wantD > 5000 || !(o.h > 0) || o.h > 5000) return FAIL("fbx.err.tooSmall");
  // Fremde oder sehr verwinkelte Umrisse können die Flächen-Rechnung überfordern: dann eine Meldung statt eines Absturzes
  try {
    let area = o.area, r = buildAny(o);
    for (let i = 0; i < 4 && !r.error; i++) {
      const kx = wantW / r.W, ky = wantD / r.D;
      if (Math.abs(kx - 1) < 0.003 && Math.abs(ky - 1) < 0.003) break;
      area = area.map(p => p.map(q => q.map(([x, y]) => [x * kx, y * ky] as XY)));
      const next = buildAny({ ...o, area });
      if (next.error) break;
      r = next;
    }
    return r;
  } catch { return FAIL("fbx.err.tight"); }
}

function buildAny(o: ShapeBoxOptions): ShapeBoxResult {
  const first = buildBox(o, 0);
  // Wandstücke: scharfe Ecken bleiben; nur wenn die Form zu schmal ist, schmale Spitzen (Stiel …) abrunden und nochmal
  if (o.wall === "segments" && first.error === "fbx.err.narrow") {
    const again = buildBox(o, Math.max(o.t, 0.5) + 1);
    if (!again.error) return again;
  }
  return first;
}

function buildBox(o: ShapeBoxOptions, soften: number): ShapeBoxResult {
  const t = Math.max(0.5, o.t), rim = Math.max(1, o.rim), H = o.h, clear = 0.2;
  if (!o.area.length) return FAIL("fbx.err.noShape");
  const Hw = H - 2 * t;
  if (o.wall === "flex" ? H < 6 * Math.max(2, t) + 8 : Hw < 2 * t + 2) return FAIL("fbx.err.height");
  if (o.wall === "flex" && o.tool > 0) return FAIL("fbx.err.flexRouter");
  if (o.tool > 0.67 * t) return FAIL("fbx.err.toolThick");

  const main = largest(o.area);
  if (!main.poly) return FAIL("fbx.err.tooSmall");
  // Mittellinie der Wand: Form nach innen; bei Flex alle Knicke auf den Biegeradius runden (innen und außen)
  const clean: Polygon = main.poly.map(r => ringOf(simplifyPolygon(ringPts(r), 0.03)));
  let mid = offsetArea([clean], -(rim + t / 2));
  let lost = 0;
  const r = o.wall === "flex" ? Math.max(o.bend, t + 1) : soften;
  if (r > 0 && mid.length) {
    const before = mid;
    mid = offsetArea(offsetArea(mid, -r), r);   // spitze Ecken außen rund, zu schmale Stellen fallen weg
    // Fällt mehr weg als eine Spitze (ein Ärmel, ein Ohr …), lieber melden als heimlich eine andere Form schneiden
    if (lostDepth(before, mid) > 2.5 * r) { if (o.wall === "flex") return FAIL("fbx.err.narrow", main.others); lost = 1; }
    mid = offsetArea(offsetArea(mid, r), -r);   // Innenecken rund
  }
  const pick = largest(mid);
  if (!pick.poly) return FAIL("fbx.err.tooSmall", main.others);
  if (pick.others > 0) return FAIL("fbx.err.narrow", main.others);
  let rings = pick.poly.map(r => simplifyPolygon(ringPts(r), 0.02));
  // Wandstücke: Platten und Öffnung richten sich nach den wirklichen Sehnen, nicht nach der Kurve
  if (o.wall === "segments") {
    rings = rings.map(r => wallChords(r, t, Math.max(3 * t, 8)));
    if (rings.some(r => r.length < 3 || crosses(r))) return FAIL("fbx.err.tight", main.others);
    try { pick.poly = polygonClipping.union([rings.map(r => [...r.map(q => [q.x, q.y] as XY), [r[0].x, r[0].y] as XY])])[0]; } catch { return FAIL("fbx.err.tight", main.others); }
    if (!pick.poly) return FAIL("fbx.err.tight", main.others);
  }
  if (wallsTooClose(rings, t)) return FAIL("fbx.err.narrow", main.others);

  // Innenöffnung im Ring
  const ringW = Math.max(3, t);
  const opening = offsetArea([pick.poly], -(t / 2 + ringW));
  if (!opening.length) return FAIL("fbx.err.narrow", main.others);

  // Wände. Äußere Kontur gegen den Uhrzeigersinn, Löcher im Uhrzeigersinn: so zeigt die Oberseite des Streifens immer nach außen
  const walls: WallInfo[] = [], wallPanels: Panel[] = [], slots: P[][] = [];
  for (let i = 0; i < rings.length; i++) {
    const ccw = polygonArea(rings[i]) > 0;
    const loop = ccw === (i === 0) ? rings[i] : [...rings[i]].reverse();
    if (o.wall === "flex") {
      const w = flexWall(loop, Hw, t, o.finger, 1);
      if (!w) return FAIL("fbx.err.tight", main.others);
      wallPanels.push(w.panel); slots.push(...w.slots); walls.push(w.info);
    } else {
      const w = segmentWall(loop, Hw, t, o.finger, true);
      if (!w) return FAIL("fbx.err.tight", main.others);
      wallPanels.push(...w.panels); slots.push(...w.slots); walls.push(w.info);
    }
  }

  // Platten: Wandlinie nach außen. Alle Schlitze müssen im Boden liegen
  const plate = largest(offsetArea([pick.poly], t / 2 + rim)).poly;
  if (!plate) return FAIL("fbx.err.tooSmall", main.others);
  for (const s of slots) if (s.some(q => !inPlate(q, plate))) return FAIL("fbx.err.tight", main.others);

  const panels: Panel[] = [plateFrom("bottom", plate, 0, slots)];
  const ringArea = polygonClipping.difference([plate], opening);
  for (const piece of ringArea) panels.push(plateFrom("flexRing", piece, H - t, slots));
  panels.push(...wallPanels);
  if (o.lid) {
    panels.push(plateFrom("lidOuter", plate, H));
    for (const piece of offsetArea(opening, -clear)) panels.push(plateFrom("lidInner", piece, H - t));
  }

  const done = finishPanels(panels, o.kerf, o.wall === "flex" ? 0 : o.tool);
  const b = bounds([plate]);
  return { panels: done, walls, error: "", dropped: main.others + lost, W: b.x1 - b.x0, D: b.y1 - b.y0, H: H + (o.lid ? t : 0),
    longest: Math.max(...done.map(p => Math.max(p.w, p.h))) };
}

/** Umrisse in Einstellungen speichern (Edit with generator) – gerundet und vereinfacht, damit es klein bleibt */
export function packArea(m: MultiPolygon, maxPts = 700): number[][][] {
  const rings = m.flatMap(p => p.map(ringPts));
  const total = rings.reduce((a, r) => a + r.length, 0);
  let tol = 0.02;
  let out = rings;
  for (let k = 0; k < 12 && out.reduce((a, r) => a + r.length, 0) > maxPts && total > maxPts; k++) { tol *= 1.8; out = rings.map(r => simplifyPolygon(r, tol)); }
  return out.map(r => r.map(q => [Math.round(q.x * 100) / 100, Math.round(q.y * 100) / 100]));
}

/** Gespeicherten Umriss prüfen und wieder zu einer Fläche machen (kann aus einer fremden Projektdatei stammen) */
export function unpackArea(raw: unknown): MultiPolygon {
  if (!Array.isArray(raw)) return [];
  const rings: Polygon[] = [];
  for (const r of raw.slice(0, 60)) {
    if (!Array.isArray(r)) continue;
    const pts = r.filter(q => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])).slice(0, 2000).map(q => [q[0], q[1]] as XY);
    if (pts.length >= 3) rings.push([[...pts, pts[0]]]);
  }
  if (!rings.length) return [];
  try { return rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1)); } catch { return []; }
}
