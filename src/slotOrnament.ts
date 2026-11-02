/**
 * 3D-STECKANHÄNGER: zwei gleiche Teile, über Kreuz ineinander gesteckt (Fenster: editor/slotOrnamentGen.ts)
 *
 * Teil A hat einen Schlitz von oben bis zur Mitte, Teil B von unten bis zur Mitte – zusammengesteckt stehen sie im
 * rechten Winkel und ergeben eine räumliche Figur. Schlitzbreite = Materialstärke + Spiel. Das Loch zum Aufhängen
 * sitzt oben in Teil B (dessen Spitze bleibt ganz). Umrisse aus dem Deko-Anhänger (Schneeflocke, Tanne, Stern, Ei, Kürbis …),
 * Verzierung als ausgeschnittene Motive mit Abstand zum Schlitz, wahlweise eine gravierte Zierlinie am Rand.
 *
 * Nur Geometrie (Tests: `npm test`). Alles in mm, Y nach oben, Mitte bei x = 0.
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import { bounds, clipLines, outlineLines, type ScoreLine } from "./nameConnect.ts";
import { SEASON_SHAPES, type SeasonShape } from "./seasonShapes.ts";
import { ornamentBody, decorate, decoSize, insetArea, borderInset, type OrnamentShape, type OrnamentDeco, type OrnamentHanger, type OrnamentOptions } from "./ornament.ts";

export type SlotShape = "snowflake" | "tree" | "star" | "ball" | "bell" | "heart" | SeasonShape;
export const SLOT_SHAPES: SlotShape[] = ["snowflake", "tree", "star", "ball", "bell", "heart", ...SEASON_SHAPES];

export interface SlotOrnamentOptions {
  shape: SlotShape;
  size: number;      // Höhe (mm)
  points: number;    // Zacken beim Stern
  t: number;         // Materialstärke (mm)
  clear: number;     // Spiel im Schlitz (mm)
  hanger: OrnamentHanger;
  holeD: number;
  deco: OrnamentDeco;
  border: boolean;   // gravierte Zierlinie am Rand
}

export interface SlotPiece { cut: MultiPolygon; lines: ScoreLine[] }
export interface SlotResult { a: SlotPiece; b: SlotPiece; mid: number; slotW: number; w: number; h: number }

const rect = (x0: number, y0: number, x1: number, y1: number): MultiPolygon => [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]];
const diff = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => (a.length && b.length ? polygonClipping.difference(a, b) : a);

export function slotOrnament(o: SlotOrnamentOptions): SlotResult {
  const base: OrnamentOptions = { shape: o.shape as OrnamentShape, size: Math.max(20, o.size), points: o.points, hanger: "none", holeD: o.holeD,
    inner: "engrave", textSize: 100, border: false, deco: o.deco };
  const plain = ornamentBody(base), withHang = ornamentBody({ ...base, hanger: o.hanger });
  const b = bounds(plain.body), mid = (b.y0 + b.y1) / 2;
  const slotW = Math.max(0.5, o.t) + Math.max(0, o.clear);
  // Verzierung: gleiche Motive auf beiden Teilen, mit Abstand zum Schlitz (senkrechtes Band in der Mitte) und zum Loch
  const { web } = decoSize(base);
  const band = { x0: -slotW / 2 - web, x1: slotW / 2 + web, y0: b.y0 - 1000, y1: b.y1 + 1000 };
  const edge = web + (o.border ? borderInset(base) : 0);
  const hole = withHang.holeAt && withHang.holeR ? { at: withHang.holeAt, r: withHang.holeR } : undefined;
  const motifs = decorate(base, withHang.body, band, edge, hole);
  const cutMotifs = (m: MultiPolygon) => (motifs.length ? polygonClipping.difference(m, ...motifs) : m);
  // A: Schlitz von oben bis zur Mitte; B: von unten bis zur Mitte, mit Aufhänger
  const a = cutMotifs(diff(plain.body, rect(-slotW / 2, mid, slotW / 2, b.y1 + 5)));
  const bb = cutMotifs(diff(diff(withHang.body, withHang.hole), rect(-slotW / 2, b.y0 - 5, slotW / 2, mid)));
  // Zierlinie: Umriss etwas nach innen, auf jedem Teil (vom Schlitz unterbrochen)
  const line = (piece: MultiPolygon, body: MultiPolygon): ScoreLine[] => o.border ? clipLines(outlineLines(insetArea(body, borderInset(base))), piece, 0.3) : [];
  const all = bounds(withHang.body);
  return { a: { cut: a, lines: line(a, plain.body) }, b: { cut: bb, lines: line(bb, withHang.body) }, mid, slotW, w: all.x1 - all.x0, h: all.y1 - all.y0 };
}
