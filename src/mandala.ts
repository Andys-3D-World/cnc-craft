/**
 * MANDALA-GENERATOR – nur die Geometrie (Fenster: editor/mandalaGen.ts)
 *
 * Eine runde Scheibe mit Mustern in Ringen, n-fach drehsymmetrisch. Jeder Ring bekommt eine Musterform
 * (Blatt, Tropfen, Kreis, Raute, Bogen, Spitze), die n- oder 2n-mal im Kreis wiederholt wird.
 * Alle Muster bleiben um die Stegbreite voneinander und vom Rand entfernt – beim Ausschneiden hält das Teil zusammen.
 * Die Form eines Musters entsteht aus einer Breiten-Kurve entlang des Radius: an jedem Radius höchstens so breit,
 * wie das Kreisstück (Sektor) minus Steg erlaubt.
 * Zufall nur über `seed` (gleiche Zahl = gleiches Mandala). Alle Maße in mm, Mittelpunkt (0, 0).
 * Keine Abhängigkeiten (Tests: `npm test`).
 */

export type Pt = { x: number; y: number };
export type MandalaEdge = "round" | "wavy" | "petals";
export type MandalaCenter = "hole" | "flower" | "none";
export type Motif = "petal" | "drop" | "circle" | "diamond" | "arch" | "spike";
export const MOTIFS: Motif[] = ["petal", "drop", "circle", "diamond", "arch", "spike"];

export interface MandalaOptions {
  d: number;            // Durchmesser (mm)
  n: number;            // Symmetrie (Anzahl Wiederholungen im Kreis, 4 … 36)
  rings: number;        // Anzahl Ringe (1 … 8)
  web: number;          // Stegbreite: kleinster Abstand zwischen zwei Löchern und zum Rand (mm)
  edge: MandalaEdge;
  center: MandalaCenter;
  seed: number;
}

export interface Mandala { outer: Pt[]; holes: Pt[][]; motifs: Motif[] }

/** kleinste Musterbreite, die noch Sinn ergibt (mm) – kleiner wird weggelassen */
const MIN_FEATURE = 0.8;
const SAMPLES = 24;

/** einfacher, fester Zufall (mulberry32) */
function rng(seed: number): () => number {
  let a = (Math.floor(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Breite (0 … 1) entlang des Musters, s = 0 innen … 1 außen */
function profile(m: Motif, s: number): number {
  switch (m) {
    case "petal": return Math.sin(Math.PI * s);
    case "drop": return Math.sin(Math.PI * Math.pow(s, 0.6)) * (s < 0.15 ? s / 0.15 : 1);
    case "diamond": return 1 - Math.abs(2 * s - 1);
    case "arch": return Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, 2 * s - 1), 2))) * Math.min(1, s * 12);
    case "spike": return Math.pow(1 - s, 1.3) * Math.min(1, s * 10);
    default: return Math.sqrt(Math.max(0, 1 - Math.pow(2 * s - 1, 2))); // circle (Ellipse, unten angepasst)
  }
}

const rot = (p: Pt, a: number): Pt => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });

/** Ein Muster im Sektor bei Winkel 0, zwischen Radius r0 und r1, je Seite höchstens halber Sektor (Winkel half) */
function motifShape(m: Motif, r0: number, r1: number, half: number, web: number): Pt[] | null {
  const len = r1 - r0;
  if (len < MIN_FEATURE) return null;
  // erlaubte halbe Breite an Radius r: Abstand zur Sektorgrenze minus halber Steg
  const allow = (r: number) => r * Math.sin(half) - web / 2;
  let w: (r: number) => number;
  if (m === "circle") {
    // echter Kreis: Radius so groß, wie Band und Sektor erlauben
    const rc = Math.min(len / 2, allow(r0 + len / 2) * 0.98);
    if (rc < MIN_FEATURE / 2) return null;
    const c = r0 + len / 2, pts: Pt[] = [];
    for (let i = 0; i < SAMPLES * 2; i++) {
      const a = (i / (SAMPLES * 2)) * Math.PI * 2;
      pts.push({ x: c + rc * Math.cos(a), y: rc * Math.sin(a) });
    }
    return pts;
  }
  // Breite der Form = kleinste erlaubte Breite im Band (so bleibt die Form ähnlich), höchstens halbe Länge
  let wMax = Infinity;
  for (let i = 0; i <= SAMPLES; i++) {
    const s = i / SAMPLES, p = profile(m, s);
    if (p > 0.05) wMax = Math.min(wMax, allow(r0 + s * len) / p);
  }
  wMax = Math.min(wMax, len * 0.45);
  if (!(wMax * 2 >= MIN_FEATURE)) return null;
  w = (r: number) => wMax * profile(m, (r - r0) / len);
  const right: Pt[] = [], left: Pt[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const r = r0 + (i / SAMPLES) * len, v = Math.max(0, w(r));
    right.push({ x: r, y: -v });
    left.push({ x: r, y: v });
  }
  // Spitzen ohne doppelte Punkte
  const pts = [...right, ...left.reverse()].filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 1e-6);
  return pts.length >= 3 ? pts : null;
}

/** Außenrand: Radius je Winkel */
function edgeRadius(o: MandalaOptions, a: number): number {
  const R = o.d / 2;
  if (o.edge === "wavy") return R - R * 0.04 * (1 - Math.cos(o.n * a)) / 2;
  if (o.edge === "petals") return R - R * 0.08 * (1 - Math.abs(Math.cos((o.n * a) / 2)));
  return R;
}

export function mandala(o: MandalaOptions): Mandala {
  const n = Math.max(3, Math.min(36, Math.round(o.n)));
  const rings = Math.max(1, Math.min(8, Math.round(o.rings)));
  const R = o.d / 2, web = Math.max(0.3, o.web);
  const rand = rng(o.seed);

  const outer: Pt[] = [];
  const steps = Math.max(120, n * 24);
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const r = edgeRadius({ ...o, n }, a);
    outer.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  // innerster Rand des Außenrands (Wellen/Blätter) – dort endet das letzte Band
  const rEdge = (o.edge === "round" ? R : o.edge === "wavy" ? R * 0.96 : R * 0.92) - web;
  const rCenter = o.center === "none" ? web : Math.max(web * 2, R * 0.12);

  // Bänder: zufällige Breiten (mit Untergrenze), zusammen genau bis zum Rand
  const parts = Array.from({ length: rings }, () => 0.6 + rand());
  const sum = parts.reduce((a, b) => a + b, 0);
  const holes: Pt[][] = [], motifs: Motif[] = [];
  let r = rCenter;
  for (let k = 0; k < rings; k++) {
    const band = ((rEdge - rCenter) * parts[k]) / sum;
    const r0 = r + web / 2, r1 = r + band - web / 2;
    r += band;
    const m = MOTIFS[Math.floor(rand() * MOTIFS.length)];
    motifs.push(m);
    const count = rand() < 0.35 && n <= 18 ? n * 2 : n;      // manchmal doppelt so viele
    const offset = rand() < 0.5 ? Math.PI / count : 0;      // versetzt zum Ring davor
    const shape = motifShape(m, r0, r1, Math.PI / count, web);
    if (!shape) continue;
    for (let i = 0; i < count; i++) holes.push(shape.map(p => rot(p, offset + (i * 2 * Math.PI) / count)));
  }

  // Mitte: Loch oder kleine Blüte aus n Blättern
  if (o.center === "hole") {
    const rc = rCenter - web;
    if (rc >= MIN_FEATURE / 2) {
      const c: Pt[] = [];
      for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; c.push({ x: rc * Math.cos(a), y: rc * Math.sin(a) }); }
      holes.push(c);
    }
  } else if (o.center === "flower") {
    const cnt = Math.min(n, 12);
    const shape = motifShape("petal", web, rCenter - web / 2, Math.PI / cnt, web);
    if (shape) for (let i = 0; i < cnt; i++) holes.push(shape.map(p => rot(p, (i * 2 * Math.PI) / cnt)));
  }
  return { outer, holes, motifs };
}
