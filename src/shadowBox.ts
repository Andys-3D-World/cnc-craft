/**
 * SCHATTENBOX / LICHTBOGEN: mehrere Schichten mit Landschaft hintereinander, Licht (LED) dahinter
 * (Fenster: editor/shadowBoxGen.ts)
 *
 * Aufbau von vorn nach hinten:
 *  - n Landschafts-Schichten: Rahmen (gleicher Umriss) + Landschaft unten im Fenster. Vorn große Bäume/Häuser tief
 *    unten, nach hinten kleiner und höher – so entsteht Tiefe. Fenster und Türen sind ausgeschnitten (Licht).
 *  - Grundplatte: voller Umriss, Himmel mit Sternen und Mond (graviert oder ausgeschnitten), optional Schleife oben
 *    und ein Loch fürs LED-Kabel.
 *  - Text (optional): vorn stehend – die Buchstaben stehen in der vordersten Schicht auf einem Steg von Rand zu Rand
 *    (je Zeile einer), im Himmel über der Landschaft – oder hinten auf die Grundplatte graviert.
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
import { thinnestWeb } from "./genCheck.ts";
import { ornamentBody, motif, fitText, lineBaselines, type OrnamentShape, type OrnamentText } from "./ornament.ts";
import { inRegion, type ScoreLine } from "./nameConnect.ts";
import { scene, rng, type SceneKind } from "./landscape.ts";
import { themeSky, type Theme } from "./themes.ts";

export type BoxShape = "arch" | "bell" | "ball" | "heart" | "tree" | "egg" | "pumpkin" | "ghost";
export const BOX_SHAPES: BoxShape[] = ["arch", "bell", "ball", "heart", "tree", "egg", "pumpkin", "ghost"];
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
  textPos?: "none" | "front" | "back"; // Text vorn stehend oder hinten graviert
  textLines?: number; // Anzahl Textzeilen (für die Stege)
  theme?: Theme;      // Himmel: Weihnachten = Sterne + Mondsichel, Halloween = Fledermäuse + Vollmond, Ostern = Schmetterlinge + Sonne …
}

export interface ShadowBoxResult {
  layers: MultiPolygon[];   // vorn → hinten, je ein Teil
  back: MultiPolygon;       // Grundplatte (Schnitt)
  backEngrave: MultiPolygon;
  foot: MultiPolygon;       // Standfuß von oben (leer ohne Fuß)
  tabs: { x: number; w: number }[]; // Zapfen (Mitte x, Breite) – gleich für alle Schichten
  slots: { y: number }[];   // Schlitze im Fuß: Vorderkante je Schicht (inkl. Grundplatte)
  w: number; h: number;     // Größe einer Schicht (ohne Zapfen/Schleife)
  backLines: ScoreLine[];   // Text in Einzellinien-Schrift (graviert)
  dropped: number;          // Text vorn: lose Teilchen (z. B. i-Punkte), die wegfallen
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

/** Schmalste Stelle zwischen zwei Ausschnitten einer Schicht (mm) */
const MIN_WEB = 1;
/** Kleinere Ausschnitte (mm²) würden nur als Krümel herausfallen */
const MIN_HOLE = 2;

/**
 * Kleine Ausschnitte, die zu nah an einem anderen liegen, füllen: Dazwischen stünde ein Steg, der bricht.
 * Füllen statt Wegschneiden: So bleibt die Schicht aus einem Stück und nichts fällt ab.
 */
export function fillCloseHoles(layer: MultiPolygon): MultiPolygon {
  const asPath = (r: XY[]) => ({ closed: true, pts: r.slice(0, -1).map(([x, y]) => ({ x, y })) });
  const size = (r: XY[]) => { let a = 0; for (let i = 0; i + 1 < r.length; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return Math.abs(a) / 2; };
  return layer.map(poly => {
    const [outer, ...holes] = poly;
    let kept = [...holes].sort((a, b) => size(a) - size(b));
    for (const h of [...kept]) {
      const others = kept.filter(o => o !== h);
      const close = [outer, ...others].some(o => thinnestWeb([asPath(h), asPath(o)], MIN_WEB) !== null);
      // der größte Ausschnitt ist das Fenster selbst: der bleibt immer
      if (others.length && (size(h) < MIN_HOLE || close)) kept = others;
    }
    return [outer, ...kept];
  });
}

/** Spiel im Schlitz (mm) */
export const SLOT_CLEAR = 0.15;

export function shadowBox(o: ShadowBoxOptions, text: OrnamentText = { area: [], lines: [] }): ShadowBoxResult {
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
  // Himmel: Mond/Sonne oben rechts (auch für das Textfeld wichtig)
  const th = themeSky(o.theme || "christmas");
  const moonR = wh * (th.body === "crescent" ? 0.07 : 0.085), mx = wb.x1 - (wb.x1 - wb.x0) * 0.24, my = wb.y1 - wh * 0.16;
  // Text: im Himmel über der Landschaft, unter dem Mond, so breit wie das Fenster dort ist
  const pos = o.textPos || "none";
  let tx: OrnamentText = { area: [], lines: [] }, textBox: { x0: number; y0: number; x1: number; y1: number } | null = null;
  if (pos !== "none" && (text.area.length || text.lines.length)) {
    const y0 = wb.y0 + wh * 0.5, yTop = o.sky === "none" ? wb.y1 - wh * 0.08 : my - moonR - wh * 0.03;
    let y1 = Math.min(yTop, y0 + wh * 0.3);
    const half = (y: number) => { let w = 0; while (w < wb.x1 && inRegion(win, w + 0.5, y) && inRegion(win, -w - 0.5, y)) w += 0.5; return w; };
    // oben zu schmal (z. B. die Kerbe beim Herz): Oberkante nach unten rücken
    while (y1 > y0 + wh * 0.12 && half(y1) < half(y0) * 0.6) y1 -= wh * 0.02;
    const hw = Math.min(half(y0), half((y0 + y1) / 2), half(y1)) * 0.86;
    if (y1 - y0 > wh * 0.05 && hw > 3) {
      textBox = { x0: -hw, y0, x1: hw, y1 };
      tx = fitText(text, textBox);
    }
  }
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
    layers.push(fillCloseHoles(layer));
  }
  // Text vorn: Buchstaben im Fenster der vordersten Schicht, je Zeile ein Steg bis in die Mitte des Rahmens
  let dropped = 0, backLines: ScoreLine[] = [];
  if (pos === "front" && tx.area.length) {
    const tb = bounds(tx.area), bar = Math.max(1.5, ((tb.y1 - tb.y0) / Math.max(1, o.textLines || 1)) * 0.09);
    const reach = inset(outline, fw / 2);
    const stege = union(lineBaselines(tx.area, o.textLines || 0).map(base => rect(wb.x0 - 1, base - bar * 0.6, wb.x1 + 1, base + bar * 0.4)));
    let front = unionMany([layers[0], polygonClipping.intersection(tx.area, win), polygonClipping.intersection(stege, reach)]);
    if (front.length > 1) {
      const area = (p: MultiPolygon[number]) => { const q = p[0]; let a = 0; for (let i = 0, j = q.length - 1; i < q.length; j = i++) a += q[j][0] * q[i][1] - q[i][0] * q[j][1]; return Math.abs(a); };
      dropped = front.length - 1;
      front = [front.reduce((a, p) => (area(p) > area(a) ? p : a))];
    }
    layers[0] = front;
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
    // Motive verstreut im oberen Teil des Fensters (je nach Thema), oben rechts Mondsichel, Vollmond oder Sonne
    const parts: MultiPolygon[] = [];
    const sky = rng((o.seed || 1) * 7 + 3), y0 = wb.y0 + wh * 0.5;
    const full = poly(ellipse(mx, my, moonR, moonR));
    parts.push(th.body === "crescent" ? diff(full, poly(ellipse(mx + moonR * 0.45, my + moonR * 0.25, moonR * 0.9, moonR * 0.9)))
      : th.body === "sun" ? union([full, motif("suns", mx, my, moonR * 2.6)]) : full);
    for (let i = 0; i < 40 && parts.length < 14; i++) {
      const x = wb.x0 + (wb.x1 - wb.x0) * (0.08 + sky() * 0.84), y = y0 + (wb.y1 - y0) * sky(), s = wh * (0.035 + sky() * 0.035);
      const star = motif(th.motifs[Math.floor(sky() * th.motifs.length) % th.motifs.length], x, y, s * (th.motifs[0] === "stars" ? 1 : 1.4));
      // nur ganz im Fenster und mit Abstand zueinander und zum Mond
      if (polygonClipping.difference(star, inset(win, 2)).length) continue;
      if (Math.hypot(x - mx, y - my) < moonR * (th.body === "sun" ? 1.4 : 1) + s) continue;
      // nicht in den Text
      const tb2 = tx.area.length || tx.lines.length ? textBox : null;
      if (tb2 && x + s > tb2.x0 && x - s < tb2.x1 && y + s > tb2.y0 && y - s < tb2.y1) continue;
      if (parts.slice(1).some(p => { const b = bounds(p); return Math.hypot((b.x0 + b.x1) / 2 - x, (b.y0 + b.y1) / 2 - y) < s * 1.3; })) continue;
      parts.push(star);
    }
    if (o.sky === "cut") back = diff(back, union(parts));
    else backEngrave = union(parts);
  }
  // Text hinten (oder Einzellinien-Schrift): auf die Grundplatte graviert
  if (pos === "back" && tx.area.length) backEngrave = union([backEngrave, tx.area]);
  if (pos !== "none" && tx.lines.length) backLines = tx.lines;
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
  return { layers, back, backEngrave, foot, tabs, slots, w: W, h: H, backLines, dropped };
}
