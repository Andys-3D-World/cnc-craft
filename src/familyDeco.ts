/**
 * FAMILIEN-DEKO: mehrere Namen auf einem Stück Deko (Fenster: editor/familyGen.ts). Alle Motive sind für CNC Craft gezeichnet.
 *
 *   branch  Leiste oder Zweig mit dem Familiennamen, darunter je Person ein eigener Anhänger am Faden (Loch über Loch)
 *   joined  Leiste und Motive sind EIN Teil – die Motive hängen fest an der Leiste
 *   tree    ein großer Baum: unten der Familienname, darüber die Namen, kurze Namen oben (dort ist der Baum schmal)
 *
 * Die Anhänger entstehen mit ornament(), die Schrift kommt fertig nachgezeichnet aus dem Fenster.
 * Nur Geometrie (Tests: tests/familyDeco.test.ts). Alles in mm, Y nach oben, Teile liegen schon an ihrem Platz.
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import { ornament, ornamentBody, fitText, roundRect, holeMargin, type Box, type OrnamentOptions, type OrnamentShape, type OrnamentText } from "./ornament.ts";
import { bounds, inRegion, outlineLines, union, unionMany, type ScoreLine, type XY } from "./nameConnect.ts";
import { ellipse, poly, stroke } from "./seasonShapes.ts";
import { shapeOutline, type ShapeKind } from "./shapeBox.ts";

export type FamilyLayout = "branch" | "joined" | "tree";
export const FAMILY_LAYOUTS: FamilyLayout[] = ["branch", "joined", "tree"];
export type FamilyBar = "plain" | "branch";
export const FAMILY_BARS: FamilyBar[] = ["plain", "branch"];
export type FamilyInner = "engrave" | "score";
export const FAMILY_INNERS: FamilyInner[] = ["engrave", "score"];
export type FamilyMotif = "ball" | "star" | "heart" | "bell" | "tree" | "arch" | "egg" | "flower" | "mitten" | "stocking" | "hat" | "snowman";
export const FAMILY_MOTIFS: FamilyMotif[] = ["ball", "star", "heart", "bell", "tree", "arch", "egg", "flower", "mitten", "stocking", "hat", "snowman"];
export const MAX_FAMILY_NAMES = 12;

/** Text-Schlüssel des Motivs */
export const motifKey = (m: FamilyMotif) => (m === "hat" ? "fam.motif.hat" : m === "mitten" || m === "stocking" || m === "snowman" ? "fbx.shape." + m : "orn.shape." + m);

export interface FamilyOptions {
  layout: FamilyLayout;
  motif: FamilyMotif;
  bar: FamilyBar;
  size: number;      // Höhe eines Motivs; beim Baum die Höhe des Baums
  holeD: number;
  inner: FamilyInner;
}

export interface FamilyPart { cut: MultiPolygon; engrave: MultiPolygon; lines: ScoreLine[] }
export interface FamilyResult {
  parts: FamilyPart[];
  threads: [XY, XY][];  // nur Vorschau: Fäden zwischen den Löchern
  error: string;        // Text-Schlüssel, leer = passt
  w: number; h: number;
}

const FAIL = (error: string): FamilyResult => ({ parts: [], threads: [], error, w: 0, h: 0 });
const diff = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => (a.length && b.length ? polygonClipping.difference(a, b) : a);
const shift = (m: MultiPolygon, dx: number, dy: number): MultiPolygon => m.map(p => p.map(r => r.map(([x, y]) => [x + dx, y + dy] as XY)));
const disk = (cx: number, cy: number, r: number): MultiPolygon => poly(ellipse(cx, cy, r, r, 0, 48));

/** Winter-Mütze, unsere eigene einfache Form: Krempe, Zipfel, Bommel */
function hatOutline(): MultiPolygon {
  return unionMany([poly([[-0.42, 0.14], [0.42, 0.14], [0.2, 0.62], [0.42, 0.82], [0.1, 0.78], [-0.2, 0.62]]),
    roundRect(-0.5, 0, 0.5, 0.2, 0.08), disk(0.46, 0.84, 0.11)]);
}

/** Einstellungen eines Anhängers */
function tagOptions(o: FamilyOptions, hanger: "hole" | "none"): OrnamentOptions {
  const own = o.motif === "hat" ? hatOutline() : o.motif === "mitten" || o.motif === "stocking" || o.motif === "snowman" ? shapeOutline(o.motif as ShapeKind) : undefined;
  return { shape: (own ? "ball" : o.motif) as OrnamentShape, customArea: own, size: o.size, points: 5, hanger, holeD: o.holeD, inner: o.inner, textSize: 100, border: false, deco: "none", topper: "none" };
}

/** Schrift in ein Feld: Flächen gravieren oder als Linie, Einzellinien-Schrift immer als Linie */
function textInto(text: OrnamentText, box: Box, inner: FamilyInner): { engrave: MultiPolygon; lines: ScoreLine[] } {
  const tx = fitText(text, box);
  if (tx.lines.length) return { engrave: [], lines: tx.lines };
  return inner === "engrave" ? { engrave: tx.area, lines: [] } : { engrave: [], lines: outlineLines(tx.area) };
}

/** Leiste mit Mitte (0, cy), Breite W: glatt oder als Zweig mit kleinen Trieben */
function barShape(kind: FamilyBar, W: number, y0: number, h: number): MultiPolygon {
  if (kind === "plain") return roundRect(-W / 2, y0, W / 2, y0 + h, h * 0.25);
  const cy = y0 + h / 2, top = y0 + h, parts: MultiPolygon[] = [stroke([-W / 2 + h / 2, cy], [W / 2 - h / 2, cy], h)];
  // Triebe oben am Rand, außerhalb des Schriftfelds (das liegt zwischen den Aufhänge-Löchern)
  for (const [x, dx] of [[-0.46, -1], [-0.32, 1], [0.32, -1], [0.46, 1]] as const) {
    const a: XY = [x * W, top - h * 0.1], b: XY = [x * W + dx * h * 0.45, top + h * 0.5];
    parts.push(stroke(a, b, Math.max(1.6, h * 0.12)));
    // am Ende zwei Blätter, schräg zur Seite
    const dir = Math.atan2(b[1] - a[1], b[0] - a[0]), len = h * 0.3;
    for (const side of [-0.7, 0.7]) {
      const an = dir + side;
      parts.push(poly(ellipse(b[0] + Math.cos(an) * len, b[1] + Math.sin(an) * len, len * 1.05, len * 0.42, an)));
    }
  }
  return unionMany(parts);
}

/** Leiste + darunterhängende oder angewachsene Motive */
function withBar(o: FamilyOptions, family: OrnamentText, names: OrnamentText[]): FamilyResult {
  const n = names.length, joined = o.layout === "joined", hanger = joined ? "none" : "hole";
  const bodies = ornamentBody(tagOptions(o, hanger)), bb = bounds(bodies.body);
  const tagW = bb.x1 - bb.x0;
  const gap = Math.max(3, o.size * 0.06), pitch = tagW + gap;
  const r = Math.max(0.5, o.holeD / 2), m = holeMargin(r);
  const textH = Math.max(9, o.size * 0.3), rowH = joined ? o.size * 0.12 + m : 2 * r + 2 * m;  // unten: Löcher bzw. Überlappung
  const barH = textH + rowH + m;
  const W = Math.max(n * pitch + 2 * barH, 60);
  const y0 = 0;  // Unterkante Leiste
  let bar = barShape(o.bar, W, y0, barH);
  // zwei Löcher zum Aufhängen an den Enden, je eines pro Anhänger unten
  const endX = W / 2 - barH * 0.55, endY = y0 + barH / 2;
  const holes: MultiPolygon[] = [disk(-endX, endY, r), disk(endX, endY, r)];
  const xs = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * pitch);
  if (!joined) for (const x of xs) holes.push(disk(x, y0 + m + r, r));
  const thread = joined ? 0 : Math.max(10, o.size * 0.35);
  const parts: FamilyPart[] = [], threads: [XY, XY][] = [];
  const tagTop = joined ? y0 + o.size * 0.12 : y0 + m + r - thread;  // Oberkante des Motivs bzw. Höhe des Tag-Lochs
  const engraves: MultiPolygon[] = [], lines: ScoreLine[] = [], bodiesJoined: MultiPolygon[] = [];
  names.forEach((name, i) => {
    const res = ornament(tagOptions(o, hanger), name);
    const holeY = bodies.holeAt?.[1] ?? bb.y1;
    const dy = joined ? tagTop - bb.y1 : tagTop - holeY, dx = xs[i];
    if (joined) {
      bodiesJoined.push(shift(res.cut, dx, dy)); engraves.push(shift(res.engrave, dx, dy));
      lines.push(...res.lines.map(l => ({ closed: l.closed, pts: l.pts.map(([x, y]) => [x + dx, y + dy] as XY) })));
    } else {
      parts.push({ cut: shift(res.cut, dx, dy), engrave: shift(res.engrave, dx, dy), lines: res.lines.map(l => ({ closed: l.closed, pts: l.pts.map(([x, y]) => [x + dx, y + dy] as XY) })) });
      threads.push([[dx, y0 + m + r], [dx, y0 + m + r - thread]]);
    }
  });
  if (joined) bar = unionMany([bar, ...bodiesJoined]);
  bar = diff(bar, unionMany(holes));
  const tx = textInto(family, { x0: -endX + r + m, y0: y0 + rowH, x1: endX - r - m, y1: y0 + barH - m * 0.7 }, o.inner);
  const barPart: FamilyPart = { cut: bar, engrave: union([tx.engrave, ...engraves]), lines: [...tx.lines, ...lines] };
  const out = [barPart, ...parts];
  if (joined && bar.length > 1) return FAIL("fam.err.tooSmall");
  const all = bounds(union(out.map(p => p.cut)));
  return { parts: out, threads, error: "", w: all.x1 - all.x0, h: all.y1 - all.y0 };
}

/** Halbe Breite der Fläche auf Höhe y (von der Mitte nach außen) */
function halfWidth(m: MultiPolygon, y: number): number {
  let x = 0;
  while (x < 2000 && inRegion(m, x + 0.5, y) && inRegion(m, -x - 0.5, y)) x += 0.5;
  return x;
}

/** Ein Baum mit allen Namen */
function nameTree(o: FamilyOptions, family: OrnamentText, names: OrnamentText[]): FamilyResult {
  const ob = ornamentBody({ ...tagOptions({ ...o, motif: "tree" }, "hole") }), S = o.size, edge = Math.max(2, S * 0.02);
  const cut = diff(ob.body, ob.hole);
  // kurze Namen nach oben, dort ist der Baum schmal
  const width = (x: OrnamentText) => { const b = bounds(x.area.length ? x.area : [[x.lines.flatMap(l => l.pts)]] as MultiPolygon); return b.x1 - b.x0; };
  const sorted = [...names].sort((a, b) => width(a) - width(b));
  // oben nur so weit, wie der Baum noch breit genug für lesbare Namen ist
  const yLo = S * 0.13;
  let yHi = (ob.holeAt ? ob.holeAt[1] - ob.holeR - holeMargin(ob.holeR) : S * 0.75) - edge;
  while (yHi > yLo && halfWidth(ob.body, yHi) < S * 0.14) yHi -= 1;
  const weights = [...sorted.map(() => 1), 1.5], total = weights.reduce((a, b) => a + b, 0);
  const unit = (yHi - yLo) / total;
  if (unit < 5) return FAIL("fam.err.tooSmall");
  const engrave: MultiPolygon[] = [], lines: ScoreLine[] = [];
  let y = yLo;
  // von unten: Familienname, dann die längsten Namen
  for (const [row, text] of [family, ...[...sorted].reverse()].entries()) {
    const h = unit * (row === 0 ? 1.5 : 1);
    const half = Math.min(...[0, 0.5, 1].map(f => halfWidth(ob.body, y + 0.5 + (h - 1) * f))) - edge;
    if (half < 7) return FAIL("fam.err.tooSmall");
    const tx = textInto(text, { x0: -half, y0: y + h * 0.1, x1: half, y1: y + h * 0.9 }, o.inner);
    engrave.push(tx.engrave); lines.push(...tx.lines);
    y += h;
  }
  const b = bounds(cut);
  return { parts: [{ cut, engrave: union(engrave), lines }], threads: [], error: "", w: b.x1 - b.x0, h: b.y1 - b.y0 };
}

export function familyDeco(o: FamilyOptions, family: OrnamentText, names: OrnamentText[]): FamilyResult {
  const list = names.filter(x => x.area.length || x.lines.length).slice(0, MAX_FAMILY_NAMES);
  if (!list.length) return FAIL("fam.err.noNames");
  if (!(o.size >= 20) || o.size > 2000 || !(o.holeD > 0)) return FAIL("fam.err.tooSmall");
  if (o.layout === "tree" && o.size < 60) return FAIL("fam.err.tooSmall");
  return o.layout === "tree" ? nameTree(o, family, list) : withBar(o, family, list);
}
