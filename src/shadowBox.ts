/**
 * SCHATTENBOX / LICHTBOGEN: mehrere Schichten mit Landschaft hintereinander, Licht (LED) dahinter
 * (Fenster: editor/shadowBoxGen.ts)
 *
 * Aufbau von vorn nach hinten:
 *  - n Landschafts-Schichten: Rahmen (gleicher Umriss) + Landschaft unten im Fenster. Vorn große Bäume/Häuser tief
 *    unten, nach hinten kleiner und höher – so entsteht Tiefe. Fenster und Türen sind ausgeschnitten (Licht).
 *  - Grundplatte: voller Umriss, Himmel mit Sternen und Mond (graviert oder ausgeschnitten), optional Schleife oben
 *    und ein Loch fürs LED-Kabel.
 *  - Standfuß (optional): Platte mit Schlitzen; jede Schicht hat unten zwei Zapfen, die genau hineinpassen.
 *    Ohne Fuß werden die Schichten mit Abstandshaltern aufeinandergeklebt.
 * Umriss aus dem Weihnachtsschmuck (Glocke, Kugel, Bogen, Herz, Tannenbaum). Alles für CNC Craft gezeichnet.
 *
 * Nur Geometrie (Tests: `npm test`). Alles in mm, Y nach oben; Umriss unten bei y = 0, Mitte bei x = 0.
 * Der Fuß wird von oben gesehen gezeichnet: x = Breite, y = Tiefe (0 = vorn).
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import { bounds, union, unionMany, grow, type XY } from "./nameConnect.ts";
import { ornamentBody, motif, type OrnamentShape } from "./ornament.ts";
import { scene, rng, type SceneKind } from "./landscape.ts";

export type BoxShape = "arch" | "bell" | "ball" | "heart" | "tree";
export const BOX_SHAPES: BoxShape[] = ["arch", "bell", "ball", "heart", "tree"];
export type Sky = "engrave" | "cut" | "none";

export interface ShadowBoxOptions {
  shape: BoxShape;
  h: number;          // Höhe des Umrisses (mm)
  layers: number;     // Landschafts-Schichten (2 … 5)
  frame: number;      // Rahmenbreite (mm)
  scene: SceneKind;   // trees / village / hills
  seed: number;
  sky: Sky;           // Sterne und Mond auf der Grundplatte
  bow: boolean;       // Schleife oben auf der Grundplatte
  stand: boolean;     // Standfuß mit Schlitzen
  t: number;          // Materialstärke (mm)
  gap: number;        // Abstand zwischen den Schichten im Fuß (mm)
  cable: boolean;     // Loch fürs LED-Kabel in der Grundplatte
}

export interface ShadowBoxResult {
  layers: MultiPolygon[];   // vorn → hinten, je ein Teil
  back: MultiPolygon;       // Grundplatte (Schnitt)
  backEngrave: MultiPolygon;
  foot: MultiPolygon;       // Standfuß von oben (leer ohne Fuß)
  tabs: { x: number; w: number }[]; // Zapfen (Mitte x, Breite) – gleich für alle Schichten
  slots: { y: number }[];   // Schlitze im Fuß: Vorderkante je Schicht (inkl. Grundplatte)
  w: number; h: number;     // Größe einer Schicht (ohne Zapfen/Schleife)
}

const close = (r: XY[]): XY[] => [...r, r[0]];
const poly = (r: XY[]): MultiPolygon => [[close(r)]];
const rect = (x0: number, y0: number, x1: number, y1: number): MultiPolygon => poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
const diff = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => (a.length && b.length ? polygonClipping.difference(a, b) : a);
const ellipse = (cx: number, cy: number, rx: number, ry: number, rot = 0, n = 48): XY[] => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2, x = rx * Math.cos(a), y = ry * Math.sin(a), c = Math.cos(rot), s = Math.sin(rot);
  return [cx + x * c - y * s, cy + x * s + y * c] as XY;
});

/** Fläche um d nach innen */
function inset(m: MultiPolygon, d: number): MultiPolygon {
  const b = bounds(m);
  return diff(m, grow(diff(rect(b.x0 - 5, b.y0 - 5, b.x1 + 5, b.y1 + 5), m), d, true));
}

/** Spiel im Schlitz (mm) */
export const SLOT_CLEAR = 0.15;

export function shadowBox(o: ShadowBoxOptions): ShadowBoxResult {
  const H = Math.max(60, o.h), n = Math.round(Math.max(1, Math.min(6, o.layers))), fw = Math.max(3, Math.min(o.frame, H / 8));
  const t = Math.max(1, o.t);
  // Umriss aus dem Weihnachtsschmuck (ohne Aufhänger)
  const outline = ornamentBody({ shape: o.shape as OrnamentShape, size: H, points: 5, hanger: "none", holeD: 4, inner: "engrave", textSize: 100, border: false, deco: "none" }).body;
  const ob = bounds(outline), W = ob.x1 - ob.x0;
  // flacher Sockel unten (für runde Umrisse) – darunter die Zapfen
  const wB = Math.min(W * 0.62, Math.max(30, W * 0.5));
  const sockel = rect(-wB / 2, 0, wB / 2, fw * 1.4);
  // (unionMany rundet auf 1/1000 mm – die Herzspitze liegt sonst genau auf der Sockelkante und verwirrt polygon-clipping)
  const shape = unionMany([outline, polygonClipping.intersection(sockel, rect(ob.x0, 0, ob.x1, H))]);
  const win = diff(inset(outline, fw), rect(-wB / 2 - 1, -1, wB / 2 + 1, fw * 1.4 + fw));
  const ring = diff(shape, win);
  const wb = bounds(win), wh = wb.y1 - wb.y0;
  // Zapfen: zwei, symmetrisch
  const tw = Math.max(6, wB * 0.18), tabs = o.stand ? [{ x: -wB * 0.3, w: tw }, { x: wB * 0.3, w: tw }] : [];
  const tabArea = unionMany(tabs.map(tb => rect(tb.x - tb.w / 2, -t, tb.x + tb.w / 2, 0.5)));
  const r = rng(o.seed || 1);
  const layers: MultiPolygon[] = [];
  for (let i = 0; i < n; i++) {
    // vorn (i = 0): Hügel tief, große Dinge; hinten höher und kleiner
    const k = n > 1 ? i / (n - 1) : 0;
    const land = scene({ x0: wb.x0 - 2, x1: wb.x1 + 2, bottom: wb.y0 - fw, base: wb.y0 + wh * (0.1 + 0.2 * k), hill: wh * (0.03 + 0.03 * k),
      item: wh * (0.26 - 0.1 * k), kind: o.scene, seed: Math.floor(r() * 1e6) + 1, houses: i === 0 ? 0.25 : 0.45 }).area;
    // unionMany: rundet auf 1/1000 mm – sonst verschluckt sich polygon-clipping manchmal an fast gleichen Kanten
    let layer = unionMany([ring, land.length ? polygonClipping.intersection(land, win) : [], tabArea]);
    // falls die Landschaft irgendwo frei schwebt (sehr schmale Formen): nur das größte Teil behalten
    if (layer.length > 1) layer = [layer.reduce((a, p) => (bounds([p]).y1 - bounds([p]).y0 > bounds([a]).y1 - bounds([a]).y0 ? p : a))];
    layers.push(layer);
  }
  // Grundplatte: voller Umriss, Schleife oben, Himmel, Kabelloch
  let back = unionMany([shape, tabArea]);
  if (o.bow) {
    const top = ob.y1, lw = W * 0.2, lh = H * 0.075;
    const loops = [-1, 1].map(sd => {
      const outer = poly(ellipse(sd * lw * 0.95, top + lh * 0.55, lw, lh, sd * 0.35)), inner = poly(ellipse(sd * lw * 0.95, top + lh * 0.55, lw * 0.6, lh * 0.45, sd * 0.35));
      return diff(outer, inner);
    });
    const knot = poly(ellipse(0, top + lh * 0.45, lw * 0.28, lh * 0.55, 0, 32));
    back = union([back, ...loops, knot, rect(-lw * 0.2, top - lh * 0.6, lw * 0.2, top + lh * 0.3)]);
  }
  if (o.cable) back = diff(back, poly(ellipse(0, fw * 1.4 + 6, 3.5, 3.5, 0, 32)));
  let backEngrave: MultiPolygon = [];
  if (o.sky !== "none") {
    // Sterne verstreut im oberen Teil des Fensters, ein Mond (Sichel) oben rechts
    const parts: MultiPolygon[] = [];
    const sky = rng((o.seed || 1) * 7 + 3), y0 = wb.y0 + wh * 0.5;
    const moonR = wh * 0.07, mx = wb.x1 - (wb.x1 - wb.x0) * 0.24, my = wb.y1 - wh * 0.16;
    parts.push(diff(poly(ellipse(mx, my, moonR, moonR)), poly(ellipse(mx + moonR * 0.45, my + moonR * 0.25, moonR * 0.9, moonR * 0.9))));
    for (let i = 0; i < 40 && parts.length < 14; i++) {
      const x = wb.x0 + (wb.x1 - wb.x0) * (0.08 + sky() * 0.84), y = y0 + (wb.y1 - y0) * sky(), s = wh * (0.035 + sky() * 0.035);
      const star = motif(sky() < 0.3 ? "flakes" : "stars", x, y, s);
      // nur ganz im Fenster und mit Abstand zueinander und zum Mond
      if (polygonClipping.difference(star, inset(win, 2)).length) continue;
      if (Math.hypot(x - mx, y - my) < moonR + s) continue;
      if (parts.slice(1).some(p => { const b = bounds(p); return Math.hypot((b.x0 + b.x1) / 2 - x, (b.y0 + b.y1) / 2 - y) < s * 1.3; })) continue;
      parts.push(star);
    }
    if (o.sky === "cut") back = diff(back, union(parts));
    else backEngrave = union(parts);
  }
  // Standfuß: Platte von oben, Schlitze für alle Schichten und die Grundplatte (vorn → hinten)
  let foot: MultiPolygon = [];
  const slots: { y: number }[] = [];
  if (o.stand) {
    const m = Math.max(8, t * 3), depth = 2 * m + (n + 1) * t + n * Math.max(0, o.gap);
    foot = rect(-wB / 2 - m, 0, wB / 2 + m, depth);
    const cuts: MultiPolygon[] = [];
    for (let i = 0; i <= n; i++) {
      const y = m + i * (t + Math.max(0, o.gap));
      slots.push({ y });
      for (const tb of tabs) cuts.push(rect(tb.x - tb.w / 2 - SLOT_CLEAR, y - SLOT_CLEAR, tb.x + tb.w / 2 + SLOT_CLEAR, y + t + SLOT_CLEAR));
    }
    foot = diff(foot, union(cuts));
  }
  return { layers, back, backEngrave, foot, tabs, slots, w: W, h: H };
}
