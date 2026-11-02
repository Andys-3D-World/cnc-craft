/**
 * STECKREGAL: Regal aus Platten, das ohne Leim und Schrauben zusammengesteckt wird (Fenster: editor/shelfGen.ts)
 *
 * Zwei Seitenwände (Tiefe × Höhe) und mehrere Böden (Breite × Tiefe). Kreuzschlitze, je halb so tief wie das Regal:
 *   Seitenwand: Schlitze von hinten bis zur Mitte, je Boden einer
 *   Boden:      Schlitze von vorne bis zur Mitte, an beiden Enden (um den Überstand nach innen versetzt)
 * Schlitzbreite = Materialdicke + Spiel. An der Fräse bekommen die Schlitz-Gründe Dogbones (sonst bleibt der
 * Fräser-Radius stehen und die Platten rutschen nicht ganz hinein). Auf Wunsch ein Bogen unten in den Seitenwänden,
 * dann steht das Regal auf zwei Füßen.
 *
 * Nur Geometrie (Tests: `npm test`). Alles in mm, Y nach oben. Seitenwand: x = Tiefe (0 vorne), y = Höhe.
 * Boden: x = Breite, y = Tiefe (0 vorne).
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Polygon } from "polygon-clipping";
import { addBones, type Relief, type XY } from "./joints.ts";

export interface ShelfOptions {
  width: number;       // Breite der Böden (mm)
  height: number;      // Höhe der Seitenwände (mm)
  depth: number;       // Tiefe (mm)
  shelves: number;     // Anzahl Böden (2 … 10)
  thickness: number;   // Materialdicke (mm)
  bottom: number;      // Höhe des untersten Bodens (Schlitz-Mitte über dem Boden, mm)
  top: number;         // Abstand oberster Boden bis Oberkante (Schlitz-Mitte, mm)
  overhang: number;    // so weit stehen die Böden seitlich über (mm)
  clearance: number;   // Spiel im Schlitz (mm)
  tool: number;        // Fräser-Ø (0 = Laser)
  relief: Relief;      // Dogbones an den Schlitz-Gründen
  feet: boolean;       // Bogen unten in den Seitenwänden
}

export interface ShelfPart { kind: "side" | "shelf"; area: MultiPolygon; w: number; h: number }
export interface ShelfResult { parts: ShelfPart[]; levels: number[]; slotX: number[]; slotW: number; spacing: number; warnings: string[] }

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];

export function shelfLevels(o: ShelfOptions): number[] {
  const n = Math.max(2, Math.round(o.shelves));
  const a = o.bottom, b = o.height - o.top;
  return Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));
}

export function shelf(o: ShelfOptions): ShelfResult {
  const warnings: string[] = [];
  const W = o.width, H = o.height, D = o.depth, t = o.thickness;
  const sw = t + o.clearance, half = D / 2;
  const levels = shelfLevels(o);
  const r = o.tool / 2 + 0.02;
  // Seitenwand
  let side: MultiPolygon = [rect(0, 0, D, H)];
  const sideSlots = levels.map(y => rect(half, y - sw / 2, D + 1, y + sw / 2));
  side = polygonClipping.difference(side, ...sideSlots);
  if (o.feet) {
    // Bogen (halbe Ellipse) zwischen zwei Füßen: 60 % der Tiefe breit, höchstens bis 10 mm unter den untersten Schlitz
    const fh = Math.min(D * 0.25, levels[0] - sw / 2 - 10);
    if (fh >= 3) {
      const pts: XY[] = [];
      for (let i = 0; i <= 32; i++) { const a = Math.PI * i / 32; pts.push([D / 2 + D * 0.3 * Math.cos(a), fh * Math.sin(a)]); }
      pts.push([D * 0.2, -1], [D * 0.8, -1], [pts[0][0], pts[0][1]]);
      side = polygonClipping.difference(side, [pts]);
    } else warnings.push("shelf.warnFeet");
  }
  // Boden: Schlitze von vorne, Mitte um Überstand + t/2 vom Ende
  const sx = [o.overhang + t / 2, W - o.overhang - t / 2];
  let board: MultiPolygon = [rect(0, 0, W, D)];
  board = polygonClipping.difference(board, ...sx.map(x => rect(x - sw / 2, -1, x + sw / 2, half)));
  if (o.tool > 0) {
    side = addBones(side, r, o.relief).area;
    board = addBones(board, r, o.relief).area;
  }
  const parts: ShelfPart[] = [
    { kind: "side", area: side, w: D, h: H }, { kind: "side", area: side, w: D, h: H },
    ...levels.map(() => ({ kind: "shelf" as const, area: board, w: W, h: D })),
  ];
  const spacing = levels.length > 1 ? levels[1] - levels[0] : 0;
  if (spacing < sw + 20) warnings.push("shelf.warnSpacing");
  if (levels[0] - sw / 2 < 5 || H - levels[levels.length - 1] - sw / 2 < 5) warnings.push("shelf.warnEdge");
  if (o.overhang < 0 || sx[1] - sx[0] < 2 * sw) warnings.push("shelf.warnOverhang");
  if (o.tool > 0 && o.tool > sw) warnings.push("shelf.warnTool");
  if (o.tool > 0 && o.relief === "none") warnings.push("shelf.warnNoRelief");
  return { parts, levels, slotX: sx, slotW: sw, spacing, warnings };
}

/** Teile in Reihen auf eine Fläche legen (links nach rechts, dann nächste Reihe) – gibt die linke untere Ecke je Teil */
export function layoutParts(sizes: { w: number; h: number }[], maxW: number, gap = 6): { at: XY[]; w: number; h: number } {
  const at: XY[] = [];
  let x = 0, y = 0, rowH = 0, w = 0;
  for (const s of sizes) {
    if (x > 0 && x + s.w > maxW) { x = 0; y += rowH + gap; rowH = 0; }
    at.push([x, y]);
    x += s.w + gap; rowH = Math.max(rowH, s.h); w = Math.max(w, x - gap);
  }
  return { at, w, h: y + rowH };
}
