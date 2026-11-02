/**
 * JAHRESZEITEN-MOTIVE für die Deko-Generatoren (Anhänger, Steckanhänger, Schattenbox) – alles für CNC Craft gezeichnet
 *
 *  - Umrisse: Ei, Hase, Kürbis, Gespenst, Fledermaus, Blume, Schmetterling, Sonne, Muschel, Blatt, Eichel, Pilz
 *  - kleine Motive zum Ausschneiden: Eier, Blumen, Fledermäuse, Kürbisse, Blätter, Sonnen, Schmetterlinge
 *  - Aufsätze: Hasenohren, Hexenhut, Katzenohren, Blätter, Blume
 *  - Landschafts-Teile: Tulpe, Blume, Osterei, runder Baum, Pilz, Palme, Grabstein, kahler Baum, Kürbis mit Gesicht
 *
 * Nur Geometrie (Tests über ornament/landscape/shadowBox). Alles in mm bzw. Einheiten, Y nach oben.
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import { unionMany, type XY } from "./nameConnect.ts";

const close = (r: XY[]): XY[] => [...r, r[0]];
export const poly = (r: XY[]): MultiPolygon => [[close(r)]];
const diff = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => (a.length && b.length ? polygonClipping.difference(a, b) : a);

/** Ellipse um (cx, cy), gedreht um rot (Bogenmaß) */
export function ellipse(cx: number, cy: number, rx: number, ry: number, rot = 0, n = 48): XY[] {
  const c = Math.cos(rot), s = Math.sin(rot);
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2, x = rx * Math.cos(a), y = ry * Math.sin(a);
    return [cx + x * c - y * s, cy + x * s + y * c] as XY;
  });
}

/** Streifen mit runden Enden (ein Umriss, ohne Vereinigung) */
export function stroke(a: XY, b: XY, w: number): MultiPolygon {
  const dir = Math.atan2(b[1] - a[1], b[0] - a[0]), r = w / 2, n = 10;
  const half = (c: XY, from: number): XY[] => Array.from({ length: n + 1 }, (_, i) => {
    const t = from + (i / n) * Math.PI;
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as XY;
  });
  return poly([...half(b, dir - Math.PI / 2), ...half(a, dir + Math.PI / 2)]);
}

/** Stern-Punkte, Spitze oben */
export function starPoints(cx: number, cy: number, n: number, ro: number, ri: number): XY[] {
  return Array.from({ length: 2 * n }, (_, i) => {
    const a = Math.PI / 2 + (i * Math.PI) / n, r = i % 2 ? ri : ro;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as XY;
  });
}

/** Rechte Hälfte (unten Mitte → oben Mitte) spiegeln */
function mirror(right: XY[]): XY[] {
  return [...right, ...right.slice(1, -1).reverse().map(([x, y]) => [-x, y] as XY)];
}

/** Blüte: n runde Blätter (Kreise) um eine Mitte, Gesamtradius r – sieht nach Blume aus, nicht nach Stern */
export function petals(cx: number, cy: number, r: number, n: number, seg = 40): MultiPolygon {
  const pr = r * 0.36, d = r - pr;
  const parts = Array.from({ length: n }, (_, i) => { const a = Math.PI / 2 + (i * 2 * Math.PI) / n; return poly(ellipse(cx + d * Math.cos(a), cy + d * Math.sin(a), pr, pr, 0, seg)); });
  return unionMany([...parts, poly(ellipse(cx, cy, d * 0.85, d * 0.85, 0, seg))]);
}

/** Umriss in Polarform r(θ) um (cx, cy) */
function polar(cx: number, cy: number, r: (a: number) => number, n = 120): XY[] {
  return Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [cx + r(a) * Math.cos(a), cy + r(a) * Math.sin(a)] as XY; });
}

// =====================================================================
// UMRISSE (Einheiten, etwa 1 hoch)
// =====================================================================

export type SeasonShape = "egg" | "bunny" | "pumpkin" | "ghost" | "bat" | "flower" | "butterfly" | "sun" | "shell" | "leaf" | "acorn" | "mushroom";
export const SEASON_SHAPES: SeasonShape[] = ["egg", "bunny", "pumpkin", "ghost", "bat", "flower", "butterfly", "sun", "shell", "leaf", "acorn", "mushroom"];

export function seasonOutline(s: SeasonShape): MultiPolygon {
  switch (s) {
    case "egg": // unten breiter
      return poly(Array.from({ length: 120 }, (_, i) => { const t = (i / 120) * Math.PI * 2; return [0.38 * Math.sin(t) * (1 + 0.16 * Math.cos(t)), -0.5 * Math.cos(t)] as XY; }));
    case "bunny": // Kopf mit zwei langen Ohren und Wangen
      return unionMany([poly(ellipse(0, -0.12, 0.34, 0.3)), poly(ellipse(-0.13, 0.3, 0.095, 0.3, 0.16)), poly(ellipse(0.13, 0.3, 0.095, 0.3, -0.16)),
        poly(ellipse(-0.17, -0.25, 0.2, 0.15)), poly(ellipse(0.17, -0.25, 0.2, 0.15))]);
    case "pumpkin": // fünf Rippen und Stiel
      return unionMany([poly(ellipse(0, 0, 0.26, 0.36)), poly(ellipse(-0.2, -0.01, 0.25, 0.34)), poly(ellipse(0.2, -0.01, 0.25, 0.34)),
        poly(ellipse(-0.36, -0.03, 0.17, 0.29)), poly(ellipse(0.36, -0.03, 0.17, 0.29)), poly([[-0.04, 0.3], [0.05, 0.3], [0.1, 0.5], [0.03, 0.52]])]);
    case "ghost": { // runder Kopf, Körper, gewellter Saum (Bögen nach unten), kleine Arme
      const parts: MultiPolygon[] = [poly(ellipse(0, 0.16, 0.32, 0.32, 0, 72)), poly([[-0.32, 0.16], [0.32, 0.16], [0.36, -0.36], [-0.36, -0.36]])];
      for (let i = 0; i < 4; i++) parts.push(poly(ellipse(-0.27 + i * 0.18, -0.36, 0.09, 0.08, 0, 24)));
      parts.push(poly(ellipse(-0.37, -0.02, 0.1, 0.05, 0.5, 24)), poly(ellipse(0.37, -0.02, 0.1, 0.05, -0.5, 24)));
      return unionMany(parts);
    }
    case "bat": { // Flügel mit gezacktem Unterrand, Ohren
      const right: XY[] = [[0, -0.14], [0.06, -0.12], [0.14, -0.2], [0.22, -0.1], [0.32, -0.2], [0.4, -0.06], [0.52, -0.12], [0.5, 0.14],
        [0.36, 0.22], [0.2, 0.12], [0.1, 0.12], [0.08, 0.24], [0.04, 0.16], [0, 0.16]];
      return poly(mirror(right));
    }
    case "flower": // fünf runde Blütenblätter um eine Mitte
      return petals(0, 0, 0.5, 5);
    case "butterfly": { // vier Flügel, Körper
      return unionMany([poly(ellipse(-0.22, 0.12, 0.24, 0.2, 0.5)), poly(ellipse(0.22, 0.12, 0.24, 0.2, -0.5)), poly(ellipse(-0.17, -0.18, 0.16, 0.13, -0.5)),
        poly(ellipse(0.17, -0.18, 0.16, 0.13, 0.5)), poly(ellipse(0, -0.02, 0.05, 0.3)), stroke([0, 0.24], [-0.1, 0.42], 0.03), stroke([0, 0.24], [0.1, 0.42], 0.03)]);
    }
    case "sun": return unionMany([poly(starPoints(0, 0, 12, 0.5, 0.33)), poly(ellipse(0, 0, 0.36, 0.36, 0, 72))]);
    case "shell": { // Fächer mit Rippen-Rand, unten zwei Ecken
      const pts: XY[] = [[-0.08, -0.42], [-0.2, -0.36], [-0.12, -0.3]];
      for (let i = 0; i <= 90; i++) { const a = Math.PI * (0.92 - (0.84 * i) / 90), r = 0.6 + 0.03 * Math.cos(i * Math.PI * 2 / 10); pts.push([r * Math.cos(a), -0.36 + r * Math.sin(a)]); }
      pts.push([0.12, -0.3], [0.2, -0.36], [0.08, -0.42]);
      return poly(pts.reverse());
    }
    case "leaf": { // Ahornblatt mit Stiel
      const right: XY[] = [[0, -0.5], [0.025, -0.5], [0.025, -0.3], [0.12, -0.27], [0.38, -0.2], [0.3, -0.1], [0.5, 0.08], [0.32, 0.12], [0.36, 0.3], [0.2, 0.2], [0.16, 0.36], [0.08, 0.3], [0, 0.5]];
      return poly(mirror(right));
    }
    case "acorn": // Nuss, Hütchen, Stiel
      return unionMany([poly(Array.from({ length: 80 }, (_, i) => { const t = (i / 80) * Math.PI * 2; const y = Math.sin(t); return [0.27 * Math.cos(t), -0.08 + 0.32 * y * (y < 0 ? 1.15 : 1)] as XY; })),
        poly(ellipse(0, 0.16, 0.34, 0.16)), poly([[-0.03, 0.28], [0.04, 0.28], [0.06, 0.44], [0, 0.45]])]);
    case "mushroom": { // Hut und Stiel
      const cap: XY[] = [];
      for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI; cap.push([0.5 * Math.cos(a), 0.02 + 0.36 * Math.sin(a)]); }
      cap.push([-0.5, -0.02], [-0.3, -0.06], [0.3, -0.06], [0.5, -0.02]);
      return unionMany([poly(cap), poly([[-0.14, -0.04], [0.14, -0.04], [0.17, -0.42], [0.1, -0.48], [-0.1, -0.48], [-0.17, -0.42]])]);
    }
  }
}

// =====================================================================
// KLEINE MOTIVE (passen in einen Kreis mit Ø 1 um (0, 0))
// =====================================================================

export type SeasonMotif = "eggs" | "flowers" | "bats" | "pumpkins" | "leaves" | "suns" | "butterflies";
export const SEASON_MOTIFS: SeasonMotif[] = ["eggs", "flowers", "bats", "pumpkins", "leaves", "suns", "butterflies"];

export function seasonMotif(kind: SeasonMotif): MultiPolygon {
  switch (kind) {
    case "eggs": return poly(Array.from({ length: 40 }, (_, i) => { const t = (i / 40) * Math.PI * 2; return [0.32 * Math.sin(t) * (1 + 0.15 * Math.cos(t)), -0.45 * Math.cos(t)] as XY; }));
    case "flowers": return petals(0, 0, 0.5, 5, 24);
    case "bats": return poly(mirror([[0, -0.1], [0.08, -0.08], [0.16, -0.16], [0.24, -0.06], [0.36, -0.12], [0.48, 0.08], [0.32, 0.16], [0.14, 0.08], [0.08, 0.18], [0, 0.1]]));
    case "pumpkins": return unionMany([poly(ellipse(0, -0.04, 0.2, 0.3, 0, 32)), poly(ellipse(-0.18, -0.05, 0.2, 0.27, 0, 32)), poly(ellipse(0.18, -0.05, 0.2, 0.27, 0, 32)),
      poly([[-0.03, 0.2], [0.04, 0.2], [0.07, 0.45], [0.01, 0.46]])]);
    case "leaves": return poly(Array.from({ length: 40 }, (_, i) => { const t = (i / 40) * Math.PI * 2; return [0.24 * Math.sin(t) * Math.abs(Math.sin(t)) ** 0.3, 0.48 * Math.cos(t)] as XY; }));
    case "suns": return unionMany([poly(starPoints(0, 0, 10, 0.5, 0.32)), poly(ellipse(0, 0, 0.33, 0.33, 0, 40))]);
    case "butterflies": return unionMany([poly(ellipse(-0.2, 0.12, 0.22, 0.18, 0.5, 28)), poly(ellipse(0.2, 0.12, 0.22, 0.18, -0.5, 28)),
      poly(ellipse(-0.15, -0.18, 0.15, 0.12, -0.5, 24)), poly(ellipse(0.15, -0.18, 0.15, 0.12, 0.5, 24)), poly(ellipse(0, -0.02, 0.06, 0.3, 0, 20))]);
  }
}

// =====================================================================
// AUFSÄTZE (S = Höhe der Form, top = oberster Punkt in der Mitte)
// =====================================================================

export type SeasonTopper = "bunny" | "witch" | "cat" | "leaves" | "flower";
export const SEASON_TOPPERS: SeasonTopper[] = ["bunny", "witch", "cat", "leaves", "flower"];

export function seasonTopper(kind: SeasonTopper, top: number, S: number): MultiPolygon {
  const P = (x: number, y: number): XY => [x * S, top + y * S];
  switch (kind) {
    case "bunny": // zwei lange Ohren, leicht nach außen, unten in der Form verankert
      // (Stege von der Mitte zu den Ohren halten sie auch auf spitzen Formen wie dem Stern fest)
      return unionMany([...[-1, 1].map(sd => poly(ellipse(sd * 0.1 * S, top + 0.2 * S, 0.075 * S, 0.27 * S, -sd * 0.22))),
        ...[-1, 1].map(sd => stroke(P(0, -0.12), P(sd * 0.09, 0), 0.06 * S))]);
    case "cat": // zwei Dreiecksohren
      return unionMany([...[-1, 1].map(sd => poly([P(sd * 0.04, -0.08), P(sd * 0.3, -0.08), P(sd * 0.24, 0.24)])),
        poly([P(-0.06, -0.14), P(0.06, -0.14), P(0.06, -0.04), P(-0.06, -0.04)])]); // Steg in der Mitte: hält auch auf spitzen Formen
    case "witch": { // Spitzhut mit Krempe und Band, schief
      const brim = poly(ellipse(0, top + 0.02 * S, 0.34 * S, 0.06 * S));
      const cone = poly([P(-0.2, 0.02), P(0.2, 0.02), P(0.12, 0.2), P(0.24, 0.42), P(-0.02, 0.24)]);
      return diff(unionMany([brim, cone]), poly([P(-0.15, 0.06), P(0.16, 0.06), P(0.15, 0.1), P(-0.14, 0.1)]));
    }
    case "leaves": // zwei Blätter schräg nach oben
      return unionMany([-1, 1].map(sd => poly(Array.from({ length: 36 }, (_, i) => {
        const t = (i / 36) * Math.PI * 2, x = 0.07 * Math.sin(t) * Math.abs(Math.sin(t)) ** 0.3, y = 0.17 * Math.cos(t);
        const rot = -sd * 0.8, cx = sd * 0.1, cy = 0.08;
        return [(cx + x * Math.cos(rot) - y * Math.sin(rot)) * S, top + (cy + x * Math.sin(rot) + y * Math.cos(rot)) * S] as XY;
      }))).concat([stroke(P(0, -0.12), P(0, 0.08), 0.05 * S)]));
    case "flower": // Blüte mit Mitte (Loch) auf kurzem Stiel
      return diff(unionMany([poly(polar(0, top + 0.17 * S, a => (0.13 + 0.06 * Math.cos(5 * (a - Math.PI / 2))) * S, 60)), stroke(P(0, -0.08), P(0, 0.1), 0.05 * S)]),
        poly(ellipse(0, top + 0.17 * S, 0.035 * S, 0.035 * S, 0, 24)));
  }
}

// =====================================================================
// LANDSCHAFTS-TEILE (unten Mitte bei (x, y), Höhe h; Ergebnis: Fläche + Lichter = Löcher)
// =====================================================================

export interface Item { area: MultiPolygon; lights: MultiPolygon }

export function tulip(x: number, y: number, h: number): Item {
  const cup = poly([[x - h * 0.12, y + h * 0.7], [x - h * 0.13, y + h * 0.9], [x - h * 0.06, y + h * 0.84], [x, y + h], [x + h * 0.06, y + h * 0.84],
    [x + h * 0.13, y + h * 0.9], [x + h * 0.12, y + h * 0.7], [x, y + h * 0.62]]);
  const leaf = poly(ellipse(x + h * 0.08, y + h * 0.28, h * 0.05, h * 0.2, -0.5, 24));
  return { area: unionMany([stroke([x, y - h * 0.08], [x, y + h * 0.72], h * 0.05), cup, leaf]), lights: [] };
}

export function flowerItem(x: number, y: number, h: number): Item {
  const head = poly(polar(x, y + h * 0.8, a => h * (0.14 + 0.07 * Math.cos(5 * a)), 50));
  return { area: unionMany([stroke([x, y - h * 0.08], [x, y + h * 0.8], h * 0.045), head, poly(ellipse(x - h * 0.08, y + h * 0.3, h * 0.04, h * 0.14, 0.6, 20))]),
    lights: poly(ellipse(x, y + h * 0.8, h * 0.04, h * 0.04, 0, 16)) };
}

export function eggItem(x: number, y: number, w: number): Item {
  const h = w * 1.3;
  const egg = poly(Array.from({ length: 48 }, (_, i) => { const t = (i / 48) * Math.PI * 2; return [x + (w / 2) * Math.sin(t) * (1 + 0.15 * Math.cos(t)), y - w * 0.1 + h / 2 - (h / 2) * Math.cos(t)] as XY; }));
  // Zickzack-Band als Licht (nicht ganz durch, sonst zerfiele das Ei)
  const yz = y - w * 0.1 + h * 0.5, band: XY[] = [];
  for (let i = 0; i <= 6; i++) band.push([x - w * 0.3 + (w * 0.6 * i) / 6, yz + (i % 2 ? w * 0.08 : -w * 0.02)]);
  for (let i = 6; i >= 0; i--) band.push([x - w * 0.3 + (w * 0.6 * i) / 6, yz + (i % 2 ? w * 0.14 : w * 0.04)]);
  return { area: egg, lights: poly(band) };
}

export function roundTree(x: number, y: number, h: number): Item {
  const c = y + h * 0.66, r = h * 0.2;
  return { area: unionMany([stroke([x, y - h * 0.08], [x, y + h * 0.5], h * 0.08), poly(ellipse(x, c, r * 1.3, r * 1.2)), poly(ellipse(x - r * 0.9, c - r * 0.3, r * 0.9, r * 0.8)),
    poly(ellipse(x + r * 0.9, c - r * 0.3, r * 0.9, r * 0.8)), poly(ellipse(x, c + r * 0.8, r, r * 0.8))]), lights: [] };
}

export function mushroomItem(x: number, y: number, h: number): Item {
  const cap: XY[] = [];
  for (let i = 0; i <= 24; i++) { const a = (i / 24) * Math.PI; cap.push([x + h * 0.32 * Math.cos(a), y + h * 0.55 + h * 0.4 * Math.sin(a)]); }
  return { area: unionMany([poly(cap), poly([[x - h * 0.1, y - h * 0.08], [x + h * 0.1, y - h * 0.08], [x + h * 0.08, y + h * 0.56], [x - h * 0.08, y + h * 0.56]])]),
    lights: unionMany([poly(ellipse(x - h * 0.12, y + h * 0.72, h * 0.045, h * 0.04, 0, 16)), poly(ellipse(x + h * 0.1, y + h * 0.8, h * 0.05, h * 0.045, 0, 16))]) };
}

export function palm(x: number, y: number, h: number): Item {
  const parts: MultiPolygon[] = [];
  const pts: XY[] = Array.from({ length: 6 }, (_, i) => [x + h * 0.12 * Math.sin((i / 5) * 1.4), y - h * 0.08 + (h * 0.85 * i) / 5] as XY);
  for (let i = 1; i < pts.length; i++) parts.push(stroke(pts[i - 1], pts[i], h * (0.07 - i * 0.006)));
  const top = pts[pts.length - 1];
  for (const a of [0.3, 0.9, 1.6, 2.3, 2.85]) parts.push(poly(ellipse(top[0] + Math.cos(a) * h * 0.17, top[1] + Math.sin(a) * h * 0.08 - h * 0.04, h * 0.2, h * 0.045, a > 1.57 ? a - Math.PI - 0.4 : a + 0.4, 24)));
  return { area: unionMany(parts), lights: [] };
}

export function tombstone(x: number, y: number, w: number): Item {
  const h = w * 1.3, pts: XY[] = [[x - w / 2, y - w * 0.12], [x + w / 2, y - w * 0.12]];
  for (let i = 0; i <= 16; i++) { const a = (i / 16) * Math.PI; pts.push([x + (w / 2) * Math.cos(a), y + h - w / 2 + (w / 2) * Math.sin(a)]); }
  const cx = x, cy = y + h * 0.58, s = w * 0.08;
  const cross = unionMany([poly([[cx - s, cy - w * 0.28], [cx + s, cy - w * 0.28], [cx + s, cy + w * 0.2], [cx - s, cy + w * 0.2]]),
    poly([[cx - w * 0.2, cy - s], [cx + w * 0.2, cy - s], [cx + w * 0.2, cy + s], [cx - w * 0.2, cy + s]])]);
  return { area: poly(pts), lights: cross };
}

export function bareTree(x: number, y: number, h: number): Item {
  const w = h * 0.06, parts: MultiPolygon[] = [stroke([x, y - h * 0.08], [x + h * 0.03, y + h * 0.75], w * 1.4)];
  const br: [XY, XY, number][] = [[[x + h * 0.01, y + h * 0.35], [x - h * 0.26, y + h * 0.6], 1], [[x + h * 0.02, y + h * 0.5], [x + h * 0.28, y + h * 0.72], 0.9],
    [[x + h * 0.03, y + h * 0.7], [x - h * 0.12, y + h * 0.95], 0.7], [[x - h * 0.15, y + h * 0.48], [x - h * 0.22, y + h * 0.78], 0.6], [[x + h * 0.18, y + h * 0.62], [x + h * 0.15, y + h * 0.92], 0.6]];
  for (const [a, b, k] of br) parts.push(stroke(a, b, w * k));
  return { area: unionMany(parts), lights: [] };
}

export function jackLantern(x: number, y: number, w: number): Item {
  const cy = y + w * 0.36;
  const area = unionMany([poly(ellipse(x, cy, w * 0.26, w * 0.36)), poly(ellipse(x - w * 0.2, cy, w * 0.24, w * 0.33)), poly(ellipse(x + w * 0.2, cy, w * 0.24, w * 0.33)),
    poly([[x - w * 0.04, cy + w * 0.3], [x + w * 0.05, cy + w * 0.3], [x + w * 0.1, cy + w * 0.5], [x + w * 0.02, cy + w * 0.52]])]);
  // Gesicht leuchtet: zwei Dreiecksaugen und ein Zackenmund
  const eye = (sd: number) => poly([[x + sd * w * 0.2, cy + w * 0.04], [x + sd * w * 0.06, cy + w * 0.04], [x + sd * w * 0.13, cy + w * 0.17]]);
  const mouth = poly([[x - w * 0.24, cy - w * 0.08], [x - w * 0.12, cy - w * 0.14], [x - w * 0.06, cy - w * 0.08], [x, cy - w * 0.15], [x + w * 0.06, cy - w * 0.08],
    [x + w * 0.12, cy - w * 0.14], [x + w * 0.24, cy - w * 0.08], [x + w * 0.12, cy - w * 0.22], [x - w * 0.12, cy - w * 0.22]]);
  return { area, lights: unionMany([eye(-1), eye(1), mouth]) };
}
