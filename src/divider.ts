/**
 * FACHTEILER: Einsatz aus gesteckten Stegen, der eine Kiste oder Schublade in Fächer teilt (Fenster: editor/dividerGen.ts)
 *
 * Jede Kreuzung ist halb/halb eingeschnitten, deshalb enden alle Oberkanten bündig:
 *   Längsstege (laufen in der Breite): Schlitze von oben bis zur halben Höhe
 *   Querstege (laufen in der Tiefe):   Schlitze von unten bis zur halben Höhe – werden von oben aufgesteckt
 * Schlitzbreite = Materialdicke + Spiel. Mit Rahmen sind die vier Außenwände einfach weitere Stege: alle Teile sind dann
 * Breite/Tiefe + 2 Dicken lang, und die Ecken sind ebenfalls halb/halb überblattet (Schlitz läuft am Ende aus).
 *
 * Laser: Schnittspalt wie in box.ts – das Teil wird rundum um kerf/2 größer gezeichnet, die Schlitze dadurch enger.
 * Fräse: der CAM versetzt den Weg selbst; hier kommen nur Dogbones an die Schlitz-Gründe.
 *
 * Nur Geometrie (Tests: `npm test`). Alles in mm, Y nach oben. Teil: x = Länge, y = Höhe.
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Polygon } from "polygon-clipping";
import { addBones, type Relief } from "./joints.ts";
import { outerSize, type BoxOptions, type BoxType } from "./box.ts";

export type DividerOuter = "none" | "frame" | "tray"; // nur Stege / mit Rahmen / Rahmen + Boden
export const DIVIDER_OUTERS: DividerOuter[] = ["none", "frame", "tray"];

export interface DividerOptions {
  width: number;         // Breite der Kiste (mm)
  depth: number;         // Tiefe der Kiste (mm)
  height: number;        // Höhe der Kiste (mm)
  outside: boolean;      // Maße sind Außenmaße
  wall: number;          // Wandstärke der Kiste (nur Außenmaße ohne Rahmen; Rahmen: Materialdicke)
  thickness: number;     // Materialdicke (mm)
  cols: number;          // Fächer in der Breite
  rows: number;          // Fächer in der Tiefe
  colSizes: string;      // eigene Fachbreiten, z. B. "40; 60; *" (leer = alle gleich)
  rowSizes: string;      // eigene Fachtiefen
  clearance: number;     // Spiel im Schlitz (mm)
  gap: number;           // Luft je Seite zwischen Steg und Kistenwand (mm, nur ohne Rahmen)
  kerf: number;          // Schnittspalt (Laser, mm)
  tool: number;          // Fräser-Ø (0 = Laser)
  relief: Relief;        // Dogbones an den Schlitz-Gründen
  dividerHeight: number; // eigene Steghöhe (0 = so hoch wie die Kiste innen)
  outer: DividerOuter;
}

export type DividerKind = "long" | "cross" | "wallLong" | "wallCross" | "base";

export interface DividerPart {
  kind: DividerKind;
  area: MultiPolygon;
  w: number;
  h: number;
  slots: number[];        // Schlitz-Mitten, von der linken Kante des Teils gemessen
  from: "top" | "bottom" | null; // Schlitze von oben oder unten
}

/** Meldung: Schlüssel für t() + Werte */
export interface DividerMsg { key: string; vars?: Record<string, number> }

export interface DividerResult {
  parts: DividerPart[];
  inner: { w: number; d: number; h: number }; // Platz in der Kiste
  outerSize: { w: number; d: number; h: number }; // Einsatz fertig zusammengesteckt
  colSizes: number[];  // Fachbreiten
  rowSizes: number[];  // Fachtiefen
  xLines: number[];    // Mitten der Querstege in der Breite, von der Innenwand gemessen
  yLines: number[];    // Mitten der Längsstege in der Tiefe, von der Innenwand gemessen
  slotW: number;       // Schlitzbreite am fertigen Teil
  slotDepth: number;   // Schlitztiefe am fertigen Teil (halbe Höhe)
  partH: number;       // Höhe der Stege
  errors: DividerMsg[];   // damit geht es nicht – nichts aufs Bett legen
  warnings: DividerMsg[]; // geht, aber bitte prüfen
}

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];

/**
 * "40; 60; *" lesen: Trennzeichen ist ; oder Leerzeichen, Komma ist das Dezimalzeichen, * = teilt sich den Rest.
 * null bei Tippfehlern oder Werten ≤ 0, [] bei leerem Text.
 */
export function parseSizes(s: string): (number | null)[] | null {
  const parts = s.trim().split(/[;\s]+/).filter(Boolean);
  const out: (number | null)[] = [];
  for (const p of parts) {
    if (p === "*") { out.push(null); continue; }
    if (!/^\d*[.,]?\d+$/.test(p)) return null;
    const v = parseFloat(p.replace(",", "."));
    if (!(v > 0)) return null;
    out.push(v);
  }
  return out;
}

/**
 * Fachgrößen bestimmen, sodass Fächer + Stege genau den Platz füllen.
 * Feste Größen ohne * und mit anderer Summe werden gleichmäßig gestreckt (dazu kommt eine Warnung).
 */
export function resolveSizes(text: string, count: number, space: number, t: number): { sizes: number[]; bad: boolean; given: number | null } {
  const n = Math.max(1, Math.round(count));
  const equal = (k: number) => { const c = (space - (k - 1) * t) / k; return Array.from({ length: k }, () => c); };
  const parsed = parseSizes(text);
  if (parsed === null) return { sizes: equal(n), bad: true, given: null };
  if (parsed.length === 0) return { sizes: equal(n), bad: false, given: null };
  const k = parsed.length;
  const room = space - (k - 1) * t;
  const fixed = parsed.reduce<number>((a, v) => a + (v ?? 0), 0);
  const stars = parsed.filter(v => v === null).length;
  if (stars > 0) {
    const rest = (room - fixed) / stars;
    return { sizes: parsed.map(v => v ?? rest), bad: false, given: null };
  }
  if (Math.abs(fixed - room) < 0.01) return { sizes: parsed as number[], bad: false, given: null };
  return { sizes: (parsed as number[]).map(v => v * room / fixed), bad: false, given: fixed + (k - 1) * t };
}

/** Mitten der Stege zwischen den Fächern, von der Innenwand gemessen */
export function linePositions(sizes: number[], t: number): number[] {
  const out: number[] = [];
  let p = 0;
  for (let i = 0; i < sizes.length - 1; i++) { p += sizes[i]; out.push(p + t / 2); p += t; }
  return out;
}

/** Platz in der Kiste aus den eingegebenen Maßen */
export function innerSize(o: DividerOptions): { w: number; d: number; h: number } {
  if (!o.outside) return { w: o.width, d: o.depth, h: o.height };
  const wall = o.outer === "none" ? o.wall : o.thickness;
  const floor = o.outer === "frame" ? 0 : wall;
  return { w: o.width - 2 * wall, d: o.depth - 2 * wall, h: o.height - floor };
}

function makePart(kind: DividerKind, len: number, H: number, slots: number[], from: "top" | "bottom", throughEnds: boolean, o: DividerOptions): DividerPart {
  const k = Math.max(0, o.kerf) / 2;
  const sw = o.thickness + o.clearance - 2 * k;
  const cuts = slots.map((x, i): Polygon => {
    const lo = throughEnds && i === 0 ? -k - 1 : x - sw / 2;
    const hi = throughEnds && i === slots.length - 1 ? len + k + 1 : x + sw / 2;
    return from === "top" ? rect(lo, H / 2 + k, hi, H + k + 1) : rect(lo, -k - 1, hi, H / 2 - k);
  });
  // Linke untere Ecke auf (0, 0), damit das Teil beim Legen genau w × h belegt
  const body = rect(-k, -k, len + k, H + k);
  const cutOut: MultiPolygon = cuts.length ? polygonClipping.difference([body], ...cuts) : [body];
  const moved: MultiPolygon = cutOut.map(poly => poly.map(ring => ring.map(([x, y]) => [x + k, y + k] as [number, number])));
  const area = o.tool > 0 ? addBones(moved, o.tool / 2 + 0.02, o.relief).area : moved;
  return { kind, area, w: len + 2 * k, h: H + 2 * k, slots: slots.map(x => x + k), from };
}

export function divider(o: DividerOptions): DividerResult {
  const errors: DividerMsg[] = [], warnings: DividerMsg[] = [];
  const t = o.thickness, framed = o.outer !== "none";
  const inner = innerSize(o);
  const partH = o.dividerHeight > 0 ? o.dividerHeight : inner.h;
  const empty = (): DividerResult => ({ parts: [], inner, outerSize: { w: 0, d: 0, h: 0 }, colSizes: [], rowSizes: [], xLines: [], yLines: [],
    slotW: t + o.clearance, slotDepth: partH / 2, partH, errors, warnings });

  if (!(t > 0) || !(inner.w > 0) || !(inner.d > 0) || !(partH > 0)) { errors.push({ key: "div.errSize" }); return empty(); }

  const col = resolveSizes(o.colSizes, o.cols, inner.w, t), row = resolveSizes(o.rowSizes, o.rows, inner.d, t);
  if (col.bad || row.bad) { errors.push({ key: "div.errSizes" }); return empty(); }
  if (col.sizes.length === 1 && row.sizes.length === 1 && !framed) { errors.push({ key: "div.errNoParts" }); return empty(); }

  const smallest = Math.min(...col.sizes, ...row.sizes);
  if (!(smallest > 0)) { errors.push({ key: "div.errTooMany" }); return empty(); }

  const xLines = linePositions(col.sizes, t), yLines = linePositions(row.sizes, t);
  const sw = t + o.clearance;
  const lenX = framed ? inner.w + 2 * t : inner.w - 2 * o.gap;
  const lenY = framed ? inner.d + 2 * t : inner.d - 2 * o.gap;
  if (!(lenX > sw) || !(lenY > sw)) { errors.push({ key: "div.errSlotWide" }); return empty(); }

  // Schlitz-Mitten im Teil: ohne Rahmen um die Luft zur Wand verschoben, mit Rahmen kommen die beiden Ecken dazu
  const slotsOf = (lines: number[], len: number) => framed ? [t / 2, ...lines.map(x => x + t), len - t / 2] : lines.map(x => x - o.gap);
  const slotsX = slotsOf(xLines, lenX), slotsY = slotsOf(yLines, lenY);

  const parts: DividerPart[] = [];
  const long = () => makePart("long", lenX, partH, slotsX, "top", framed, o);
  const cross = () => makePart("cross", lenY, partH, slotsY, "bottom", framed, o);
  if (framed) {
    for (let i = 0; i < 2; i++) parts.push({ ...long(), kind: "wallLong" });
    for (let i = 0; i < 2; i++) parts.push({ ...cross(), kind: "wallCross" });
  }
  yLines.forEach(() => parts.push(long()));
  xLines.forEach(() => parts.push(cross()));
  if (o.outer === "tray") {
    const k = Math.max(0, o.kerf) / 2;
    const w = lenX + 2 * k, h = lenY + 2 * k;
    parts.push({ kind: "base", area: [rect(0, 0, w, h)], w, h, slots: [], from: null });
  }

  // Prüfen
  if (col.given !== null) warnings.push({ key: "div.warnStretchW", vars: { a: round1(col.given), b: round1(inner.w) } });
  if (row.given !== null) warnings.push({ key: "div.warnStretchD", vars: { a: round1(row.given), b: round1(inner.d) } });
  if (partH > inner.h + 1e-6) warnings.push({ key: "div.warnTall", vars: { a: round1(partH), b: round1(inner.h) } });
  if (partH < 2 * t) warnings.push({ key: "div.warnLow" });
  if (!framed && (xLines.length === 0 || yLines.length === 0)) warnings.push({ key: "div.warnOneWay" });
  if (smallest - o.clearance < Math.max(3, o.tool)) warnings.push({ key: "div.warnThin", vars: { a: round1(smallest) } });
  if (o.tool > 0 && o.tool > sw) warnings.push({ key: "div.warnTool", vars: { a: round1(o.tool), b: round1(sw) } });
  if (o.tool > 0 && o.relief === "none") warnings.push({ key: "div.warnNoRelief" });
  if (o.tool <= 0 && o.kerf > t / 2) warnings.push({ key: "div.warnKerf" });
  if (o.outer === "tray") warnings.push({ key: "div.warnBase" });

  const outerSz = { w: lenX, d: lenY, h: partH + (o.outer === "tray" ? t : 0) };
  return { parts, inner, outerSize: outerSz, colSizes: col.sizes, rowSizes: row.sizes, xLines, yLines, slotW: sw, slotDepth: partH / 2, partH, errors, warnings };
}

const round1 = (v: number) => Number(v.toFixed(1));

/** Box-Arten mit rechteckigem, oben offenem oder ganz normalem Innenraum – die anderen haben Einbauten oder andere Formen */
const BOX_OK: BoxType[] = ["closed", "open", "handle", "drawer", "lidbox", "planter", "scoop", "coin", "tissue", "lantern"];

/** Maße aus dem Box-Generator übernehmen (immer als Innenmaße) */
export function fromBox(b: BoxOptions): Pick<DividerOptions, "width" | "depth" | "height" | "outside" | "thickness"> | null {
  const type = b.type || (b.lid ? "closed" : "open");
  if (!BOX_OK.includes(type) || !(b.t > 0)) return null;
  const { W, D, H } = outerSize(b);
  const lidded = type === "closed" || type === "lantern" || type === "coin" || type === "tissue";
  const w = W - 2 * b.t, d = D - 2 * b.t, h = H - (lidded ? 2 : 1) * b.t;
  if (!(w > 0) || !(d > 0) || !(h > 0)) return null;
  return { width: w, depth: d, height: h, outside: false, thickness: b.t };
}
