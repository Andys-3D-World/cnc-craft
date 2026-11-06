/**
 * PRALINEN-HALTER: kleine Schichten-Anhänger aus Holz für Pralinen oder Schokolade (Fenster: editor/candyHolderGen.ts)
 *
 * Aufbau von vorn nach hinten: Front (Form mit Motiv/Gravur und Fenster), Mittelschichten (Tasche für die Füllung, ihre Anzahl
 * folgt aus Fülltiefe und Materialstärke), Rückwand (geschlossen). Das Aufhänge-Loch geht durch alle Schichten.
 *
 * Haltesteg (Variante): Die Tasche ist um die Steghöhe nach unten länger als das Fenster in der Front. Die Füllung passt durch
 * das Fenster, rutscht nach unten hinter den stehen gebliebenen Rand der Front und kann vorn nicht mehr herausfallen.
 *
 * Zweite Bauart „Faltstreifen“ (flex): ein einziger Streifen aus Vorderseite, Biegezone, Boden, Biegezone, Rückseite. Er wird zu einem
 * Zelt gefaltet und oben mit dem Band durch beide Löcher zugebunden; zum Nachfüllen Band aufmachen. Die Seiten sind offen, zwei
 * aufgeleimte Seitenstege halten kleine Süßigkeiten. Das Muster der Biegezonen kommt aus livingHinge.ts.
 *
 * Die Formen kommen aus ornament.ts. Alle Prüfungen messen an der echten Kontur, nicht am umgebenden Rechteck.
 * Nur Geometrie, ohne Oberfläche (Tests: `npm test`). Alles in mm, Y nach oben.
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import { bounds, grow, inRegion, outlineLines, clipLines, union, type ScoreLine, type XY } from "./nameConnect.ts";
import { decorate, fitText, ornamentBody, ORNAMENT_DECOS, ORNAMENT_SHAPES, ORNAMENT_TOPPERS, type OrnamentDeco, type OrnamentHanger, type OrnamentOptions,
  type OrnamentShape, type OrnamentText, type OrnamentTopper } from "./ornament.ts";
import { THEMES, type Theme } from "./themes.ts";
import { livingHinge, suggestForThickness } from "./livingHinge.ts";
import { matchDefaults } from "./editor/genRun.ts";

export type CandyFill = "round" | "rect";
export type CandyInner = "engrave" | "score";
export type CandyBuild = "flex" | "layers";
export const CANDY_BUILDS: CandyBuild[] = ["flex", "layers"];
export const CANDY_HANGERS: OrnamentHanger[] = ["hole", "ring", "none"];
export const CANDY_INNERS: CandyInner[] = ["engrave", "score"];
export const CANDY_MAX_COUNT = 6;
export const CANDY_MAX_MIDDLE = 30;

export interface CandyOptions {
  build: CandyBuild;
  bandLen: number;      // Faltstreifen: Länge einer Biegezone
  shape: OrnamentShape;
  points: number;       // Zacken beim Stern
  topper: OrnamentTopper;
  deco: OrnamentDeco;   // kleine Motive auf der Front (graviert)
  size: number;         // Höhe der Form
  thickness: number;    // Materialstärke
  fill: CandyFill;
  diameter: number;     // runde Praline
  fillW: number;        // Riegel: Breite
  fillH: number;        // Riegel: Höhe
  depth: number;        // Fülltiefe
  clearance: number;    // Spiel: kommt einmal auf jedes Maß
  count: number;        // Anzahl Öffnungen
  bar: boolean;         // Haltesteg
  barH: number;         // Höhe des Stegs
  hanger: OrnamentHanger;
  holeD: number;
  inner: CandyInner;
  textSize: number;     // Schrift in % des freien Felds
  router: boolean;      // Fräse: Innenecken brauchen den Radius des Fräsers
}

export interface CandySettings extends CandyOptions { theme: Theme; text: string; line2: string; font: string; bold: boolean }

export const CANDY_DEFAULTS: CandySettings = { build: "flex", bandLen: 14, theme: "christmas", shape: "ball", points: 5, topper: "none", deco: "none", size: 90, thickness: 3, fill: "round", diameter: 30,
  fillW: 40, fillH: 20, depth: 9, clearance: 0.5, count: 1, bar: false, barH: 6, hanger: "hole", holeD: 4, inner: "engrave", textSize: 100, router: false,
  text: "", line2: "", font: "Pacifico", bold: false };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Einstellungen prüfen (können aus einer fremden Projektdatei stammen) */
export function candySettings(raw: any): CandySettings {
  const o: CandySettings = { ...CANDY_DEFAULTS, ...matchDefaults(CANDY_DEFAULTS, raw) };
  o.points = Math.round(clamp(o.points, 5, 12));
  o.size = clamp(o.size, 20, 1000);
  o.thickness = clamp(o.thickness, 0.5, 30);
  o.diameter = clamp(o.diameter, 3, 500);
  o.fillW = clamp(o.fillW, 3, 500);
  o.fillH = clamp(o.fillH, 3, 500);
  o.depth = clamp(o.depth, 0.5, 200);
  o.clearance = clamp(o.clearance, 0, 5);
  o.count = Math.round(clamp(o.count, 1, CANDY_MAX_COUNT));
  o.barH = clamp(o.barH, 1, 100);
  o.bandLen = clamp(o.bandLen, 4, 100);
  if (!CANDY_BUILDS.includes(o.build)) o.build = "flex";
  o.holeD = clamp(o.holeD, 1, 30);
  o.textSize = clamp(o.textSize, 20, 100);
  if (!ORNAMENT_SHAPES.includes(o.shape)) o.shape = CANDY_DEFAULTS.shape;
  if (!ORNAMENT_TOPPERS.includes(o.topper)) o.topper = "none";
  if (!ORNAMENT_DECOS.includes(o.deco)) o.deco = "none";
  if (!THEMES.includes(o.theme)) o.theme = CANDY_DEFAULTS.theme;
  if (o.fill !== "rect") o.fill = "round";
  if (!CANDY_HANGERS.includes(o.hanger)) o.hanger = "hole";
  if (!CANDY_INNERS.includes(o.inner)) o.inner = "engrave";
  for (const k of ["text", "line2", "font"] as const) o[k] = o[k].slice(0, 60);
  return o;
}

/** Anzahl Mittelschichten: Fülltiefe + Spiel, auf ganze Schichten aufgerundet */
export function middleLayers(depth: number, clearance: number, thickness: number): number {
  return Math.max(1, Math.ceil((depth + clearance) / thickness - 1e-9));
}

/** Mindestwand um die Tasche, damit nichts bricht */
export const minWall = (thickness: number) => 2 * thickness;

/** Fenstergröße in der Front (Füllung + Spiel) */
export const windowSize = (o: CandyOptions) => (o.fill === "round"
  ? { w: o.diameter + o.clearance, h: o.diameter + o.clearance }
  : { w: o.fillW + o.clearance, h: o.fillH + o.clearance });

/** Größte Eckenrundung, bei der eine eckige Füllung mit diesem Spiel noch ganz hineinpasst */
export const safeCornerR = (clearance: number) => clearance * (1 + Math.SQRT1_2);
const ROUTER_R = 1.6;
const cornerR = (o: CandyOptions) => (o.router ? ROUTER_R : Math.min(1.5, safeCornerR(o.clearance)));

// ---------- Abstände: eine Öffnung ist ein abgerundetes Rechteck = „Kern“ (Rechteck, auch zu Strecke/Punkt entartet) + Radius ----------
export interface Cell { cx: number; cy: number; hw: number; hh: number; r: number }
type Seg = [XY, XY];

/** Abstand zweier Strecken (0, wenn sie sich kreuzen) */
function segSeg(a: XY, b: XY, c: XY, d: XY): number {
  const cr = (p: XY, q: XY, s: XY) => (q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0]);
  const d1 = cr(a, b, c), d2 = cr(a, b, d), d3 = cr(c, d, a), d4 = cr(c, d, b);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return 0;
  const pt = (p: XY, q: XY, s: XY) => {
    const vx = s[0] - q[0], vy = s[1] - q[1], l = vx * vx + vy * vy;
    const u = l > 0 ? clamp(((p[0] - q[0]) * vx + (p[1] - q[1]) * vy) / l, 0, 1) : 0;
    return Math.hypot(p[0] - q[0] - u * vx, p[1] - q[1] - u * vy);
  };
  return Math.min(pt(a, c, d), pt(b, c, d), pt(c, a, b), pt(d, a, b));
}

/** Abstand einer Strecke zum Rand einer Öffnung; negativ, wenn sie hineinragt */
function cellSegGap(cell: Cell, a: XY, b: XY): number {
  const kx = cell.hw - cell.r, ky = cell.hh - cell.r;
  const inCore = (p: XY) => Math.abs(p[0] - cell.cx) <= kx && Math.abs(p[1] - cell.cy) <= ky;
  if (inCore(a) || inCore(b)) return -cell.r;
  const x0 = cell.cx - kx, x1 = cell.cx + kx, y0 = cell.cy - ky, y1 = cell.cy + ky;
  return Math.min(segSeg(a, b, [x0, y0], [x1, y0]), segSeg(a, b, [x1, y0], [x1, y1]), segSeg(a, b, [x1, y1], [x0, y1]), segSeg(a, b, [x0, y1], [x0, y0])) - cell.r;
}

const segments = (m: MultiPolygon): Seg[] => {
  const out: Seg[] = [];
  for (const p of m) for (const r of p) for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if (r[i][0] !== r[j][0] || r[i][1] !== r[j][1]) out.push([r[j] as XY, r[i] as XY]);
  return out;
};

/** Kleinster Abstand der Öffnungen zur Kontur; negativ = ragt hinaus oder liegt außerhalb. Misst an der echten Kontur */
export function edgeGap(outline: MultiPolygon, cells: Cell[], segs: Seg[] = segments(outline)): number {
  let best = Infinity;
  for (const c of cells) {
    if (!inRegion(outline, c.cx, c.cy)) return -1e6;  // außerhalb ist immer die schlechteste Lage
    for (const [a, b] of segs) { const d = cellSegGap(c, a, b); if (d < best) best = d; }
  }
  return best;
}

/** Abstand der Öffnungen zum Aufhänge-Loch */
export function holeGap(cells: Cell[], at: XY | undefined, r: number): number {
  if (!at) return Infinity;
  return Math.min(...cells.map(c => cellSegGap(c, at, at) - r));
}

// ---------- Anordnung ----------
const GRIDS: Record<number, [number, number][]> = { 1: [[1, 1]], 2: [[2, 1], [1, 2]], 3: [[3, 1], [1, 3], [2, 2]], 4: [[2, 2], [4, 1], [1, 4]],
  5: [[3, 2], [5, 1], [1, 5]], 6: [[3, 2], [2, 3], [6, 1], [1, 6]] };

/** Mittelpunkte um (0, 0): oben stehen bei ungerader Anzahl die wenigeren */
function gridCenters(n: number, cols: number, rows: number, stepX: number, stepY: number): XY[] {
  const out: XY[] = [];
  let left = n;
  for (let r = 0; r < rows; r++) {
    const inRow = Math.floor(left / (rows - r));
    left -= inRow;
    for (let c = 0; c < inRow; c++) out.push([(c - (inRow - 1) / 2) * stepX, ((rows - 1) / 2 - r) * stepY]);
  }
  return cols > 0 ? out : [];
}

export interface CandyLayout { cols: number; rows: number; pockets: Cell[]; gap: number; wall: number; textBox: TextBox | null }
export interface TextBox { x0: number; y0: number; x1: number; y1: number }

interface Body { outline: MultiPolygon; hole: MultiPolygon; holeAt?: XY; holeR: number; segs: Seg[] }

function bodyOf(o: CandyOptions): Body {
  const oo: OrnamentOptions = { shape: o.shape, size: o.size, points: o.points, hanger: o.hanger, holeD: o.holeD, inner: "engrave", textSize: 100, border: false, deco: "none", topper: o.topper };
  const ob = ornamentBody(oo);
  return { outline: ob.body, hole: ob.hole, holeAt: ob.holeAt, holeR: ob.holeR, segs: segments(ob.body) };
}

/** Größtes Textfeld (Seitenverhältnis aspect) auf der Mittellinie, frei von Kontur, Taschen und Loch */
function findTextBox(body: Body, pockets: Cell[], aspect: number, margin: number): TextBox | null {
  const b = bounds(body.outline);
  const fits = (cy: number, h: number) => {
    const w = h * aspect, box: Cell = { cx: 0, cy, hw: w, hh: h, r: 0 };
    if (!inRegion(body.outline, 0, cy)) return false;
    for (const [p, q] of body.segs) if (cellSegGap(box, p, q) < margin) return false;
    for (const c of pockets) {
      if (Math.abs(c.cx) < w + c.hw + margin && Math.abs(c.cy - cy) < h + c.hh + margin) return false;
    }
    return !body.holeAt || cellSegGap(box, body.holeAt, body.holeAt) >= body.holeR + margin;
  };
  let best = { cy: 0, h: 0 };
  for (let k = 1; k < 20; k++) {
    const cy = b.y0 + ((b.y1 - b.y0) * k) / 20;
    if (!fits(cy, 0.25)) continue;
    let lo = 0.25, hi = (b.y1 - b.y0) / 2;
    for (let it = 0; it < 10; it++) { const m = (lo + hi) / 2; if (fits(cy, m)) lo = m; else hi = m; }
    if (lo > best.h) best = { cy, h: lo };
  }
  return best.h > 0 ? { x0: -best.h * aspect, y0: best.cy - best.h, x1: best.h * aspect, y1: best.cy + best.h } : null;
}

/**
 * Taschen an der echten Kontur platzieren. Ohne Text: dort, wo die Wand am dicksten ist. Mit Text: aus den brauchbaren Lagen die
 * mit genug Platz für den Text (aspect = Breite : Höhe des Textes, 0 = kein Text). Passt mittig nichts, wird auch seitlich gesucht.
 */
function placePockets(o: CandyOptions, body: Body, aspect: number): CandyLayout {
  const win = windowSize(o), bar = o.bar ? o.barH : 0, pw = win.w, ph = win.h + bar;
  const r = o.fill === "round" ? win.w / 2 : Math.min(cornerR(o), pw / 2, ph / 2);
  const gap = minWall(o.thickness), target = minWall(o.thickness);
  const b = bounds(body.outline), steps = 48;
  const cellsAt = (centers: XY[], x: number, y: number): Cell[] => centers.map(([cx, cy]) => ({ cx: cx + x, cy: cy + y, hw: pw / 2, hh: ph / 2, r }));
  const wall = (cells: Cell[]) => Math.min(edgeGap(body.outline, cells, body.segs), holeGap(cells, body.holeAt, body.holeR));
  const margin = Math.max(2, o.thickness);
  type Cand = { cols: number; rows: number; cells: Cell[]; wall: number };
  const grids = GRIDS[o.count] || GRIDS[1];
  const usable: Cand[] = [];
  let fallback: Cand | null = null;
  for (const [cols, rows] of grids) {
    const centers = gridCenters(o.count, cols, rows, pw + gap, ph + gap);
    const scan = (x: number) => {
      const list: Cand[] = [];
      for (let k = 1; k < steps; k++) {
        const cells = cellsAt(centers, x, b.y0 + ((b.y1 - b.y0) * k) / steps);
        list.push({ cols, rows, cells, wall: wall(cells) });
      }
      return list;
    };
    let list = scan(0);
    if (!list.some(c => c.wall >= target)) {
      // nur außermittig möglich (unsymmetrische Formen)?
      const W = b.x1 - b.x0;
      for (const f of [0.06, -0.06, 0.12, -0.12, 0.18, -0.18]) {
        const other = scan(f * W);
        if (other.some(c => c.wall >= target)) { list = other; break; }
        for (const c of other) if (!fallback || c.wall > fallback.wall) fallback = c;
      }
    }
    for (const c of list) if (!fallback || c.wall > fallback.wall) fallback = c;
    const good = list.filter(c => c.wall >= target);
    if (!good.length) continue;
    const top = good[good.length - 1], low = good[0], most = good.reduce((p, c) => (c.wall > p.wall ? c : p));
    const between = (p: Cand) => good[Math.round(good.indexOf(p) + (good.indexOf(most) - good.indexOf(p)) / 2)];
    usable.push(most, between(top), between(low), top, low);
    if (!aspect) break; // ohne Text gewinnt die erste passende Anordnung
  }
  const finish = (c: Cand, box: TextBox | null): CandyLayout => ({ cols: c.cols, rows: c.rows, pockets: c.cells, gap, wall: c.wall, textBox: box });
  if (!usable.length) {
    const c = fallback!;
    return finish(c, aspect ? findTextBox(body, c.cells, aspect, margin) : null);
  }
  if (!aspect) return finish(usable[0], null);
  // genug Text reicht – dann zählt eine dicke Wand (zentrierte Lage steht vorn und gewinnt bei Gleichstand)
  const enough = o.size * 0.08;
  let best: Cand | null = null, bestBox: TextBox | null = null, bestScore = -Infinity;
  for (const c of usable) {
    const box = findTextBox(body, c.cells, aspect, margin);
    const h = box ? (box.y1 - box.y0) / 2 : 0;
    const score = Math.min(h, enough) * 10 + Math.min(c.wall, 3 * o.thickness);
    if (score > bestScore + 1e-6) { best = c; bestBox = box; bestScore = score; }
  }
  return finish(best!, bestBox);
}

// ---------- Ringe ----------
const closeRing = (r: XY[]): XY[] => {
  const out: XY[] = [];
  for (const p of r) { const l = out[out.length - 1]; if (!l || Math.hypot(l[0] - p[0], l[1] - p[1]) > 1e-6) out.push(p); }
  if (Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) > 1e-6) out.push(out[0]);
  return out;
};

/** Abgerundetes Rechteck als Fläche */
function cellArea(c: Cell): MultiPolygon {
  const kx = c.hw - c.r, ky = c.hh - c.r, steps = c.r > 0 ? clamp(Math.ceil(c.r * 1.5), 4, 24) : 0, pts: XY[] = [];
  for (const [sx, sy, a0] of [[1, -1, -90], [1, 1, 0], [-1, 1, 90], [-1, -1, 180]] as const) {
    for (let i = 0; i <= steps; i++) {
      const a = ((a0 + (i * 90) / Math.max(1, steps)) * Math.PI) / 180;
      pts.push([c.cx + sx * kx + c.r * Math.cos(a), c.cy + sy * ky + c.r * Math.sin(a)]);
    }
  }
  return [[closeRing(pts)]];
}

/** Fenster der Front zu einer Tasche: oben in der Tasche, darunter bleibt der Steg stehen */
export function windowOf(pocket: Cell, o: CandyOptions): Cell {
  const bar = o.bar ? o.barH : 0;
  const r = o.fill === "round" ? pocket.hw : pocket.r;
  return { ...pocket, cy: pocket.cy + bar / 2, hh: pocket.hh - bar / 2, r };
}

/** Die Füllung selbst (ohne Spiel), so wie sie unten in der Tasche liegt */
function sweetOf(pocket: Cell, o: CandyOptions): Cell {
  const c = o.clearance;
  const hw = pocket.hw - c / 2;
  const hh = o.fill === "round" ? hw : o.fillH / 2;
  return { cx: pocket.cx, cy: pocket.cy - pocket.hh + c / 2 + hh, hw, hh, r: o.fill === "round" ? hw : 0 };
}

const safeDiff = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => (b.length ? polygonClipping.difference(a, b) : a);

// ---------- Ergebnis ----------
export interface CandyMsg { level: "error" | "warn"; key: string; vars?: Record<string, string | number> }
export interface CandyPart { kind: "front" | "middle" | "back" | "strip" | "sideBar"; index: number; cut: MultiPolygon; engrave: MultiPolygon; lines: ScoreLine[]; slits?: ScoreLine[] }

/** Faltstreifen: Maße und das gefaltete Profil (Mittellinie von der Bodenmitte bis zur Spitze; X = Tiefe, Y = Höhe) */
export interface FlexInfo { width: number; innerW: number; floor: number; band: number; panel: number; length: number; angle: number; height: number; profile: XY[]; sweet: XY[]; sweetGap: number }

export interface CandyResult {
  parts: CandyPart[];
  middle: number;       // Anzahl Mittelschichten
  total: number;        // Dicke des fertigen Stapels (mm)
  layout: CandyLayout;
  outline: MultiPolygon;
  windows: Cell[];
  sweets: MultiPolygon; // zum Anzeigen in der Vorschau
  holeAt?: XY; holeR: number;
  w: number; h: number;
  flex?: FlexInfo;
  msgs: CandyMsg[];
  ok: boolean;          // keine Fehler
}

const f1 = (v: number) => Math.round(v * 10) / 10;

/** Alle Prüfungen auf Kontur und Anordnung (ohne die Teile selbst zu rechnen) */
function check(o: CandyOptions, body: Body, layout: CandyLayout, middle: number): CandyMsg[] {
  const msgs: CandyMsg[] = [], t = o.thickness, min = minWall(t);
  const edge = edgeGap(body.outline, layout.pockets, body.segs);
  const hole = holeGap(layout.pockets, body.holeAt, body.holeR);
  if (middle > CANDY_MAX_MIDDLE) msgs.push({ level: "error", key: "ch.msg.tooMany", vars: { n: middle, max: CANDY_MAX_MIDDLE } });
  if (edge < 0) msgs.push({ level: "error", key: "ch.msg.tooLarge" });
  else if (edge < t) msgs.push({ level: "error", key: "ch.msg.edge", vars: { d: f1(edge), min: f1(t) } });
  else if (edge < min - 1e-6) msgs.push({ level: "warn", key: "ch.msg.wall", vars: { d: f1(edge), min: f1(min) } });
  if (hole < t) msgs.push({ level: "error", key: "ch.msg.hole", vars: { d: f1(Math.max(0, hole)), min: f1(t) } });
  if (o.bar) {
    const win = windowSize(o);
    if (o.barH < min) msgs.push({ level: "warn", key: "ch.msg.barThin", vars: { d: f1(o.barH), min: f1(min) } });
    if (o.barH >= win.h) msgs.push({ level: "warn", key: "ch.msg.barTall" });
  }
  if (o.fill === "rect" && o.router && ROUTER_R > safeCornerR(o.clearance) + 1e-6) msgs.push({ level: "warn", key: "ch.msg.corner", vars: { r: ROUTER_R, c: f1((ROUTER_R / safeCornerR(1)) + 0.05) } });
  if (middle > 8 && middle <= CANDY_MAX_MIDDLE) msgs.push({ level: "warn", key: "ch.msg.thick", vars: { n: middle, mm: f1(middle * t) } });
  return msgs;
}

/** Nur Prüfung ohne Text und Teile: passt das mit dieser Größe? */
export function candyFits(o: CandyOptions): boolean {
  if (o.build === "flex") return flexHolder(o).ok;
  const body = bodyOf(o);
  const layout = placePockets(o, body, 0);
  return !check(o, body, layout, Math.min(1, middleLayers(o.depth, o.clearance, o.thickness))).some(m => m.level === "error");
}

/** Kleinste Höhe (auf 5 mm gerundet), mit der die Öffnungen passen; null = auch sehr groß nicht */
export function suggestSize(o: CandyOptions): number | null {
  let lo = o.size, hi = o.size;
  for (let i = 0; i < 14; i++) {
    hi = Math.min(1000, hi * 1.25);
    if (candyFits({ ...o, size: hi })) break;
    lo = hi;
    if (hi >= 1000) return null;
  }
  for (let i = 0; i < 4; i++) { const m = (lo + hi) / 2; if (candyFits({ ...o, size: m })) hi = m; else lo = m; }
  const s = Math.ceil(hi / 5) * 5;
  return s <= 1000 ? s : null;
}

/** Text-Rechteck zum Einpassen */
function textBounds(text: OrnamentText) {
  const b = bounds(text.area);
  for (const l of text.lines) for (const [x, y] of l.pts) { b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x); b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y); }
  return b;
}

/** Fertiger Halter. Bei Fehlern: Teile und Meldungen trotzdem (für die Vorschau), aber ok = false */
export function candyHolder(o: CandyOptions, text: OrnamentText = { area: [], lines: [] }): CandyResult {
  if (o.build === "flex") return flexHolder(o, text);
  const body = bodyOf(o);
  const tb = textBounds(text), tw = tb.x1 - tb.x0, th = tb.y1 - tb.y0;
  const hasText = tw > 0 && th > 0;
  const layout = placePockets(o, body, hasText ? tw / th : 0);
  const middle = middleLayers(o.depth, o.clearance, o.thickness);
  const msgs = check(o, body, layout, middle);
  const windows = layout.pockets.map(p => windowOf(p, o));
  const pocketArea = union(layout.pockets.map(cellArea));
  const windowArea = union(windows.map(cellArea));

  // Gravur auf der Front: Schrift und Motive, beide frei von Fenster und Tasche
  let engrave: MultiPolygon = [], lines: ScoreLine[] = [];
  if (hasText) {
    if (!layout.textBox) msgs.push({ level: "warn", key: "ch.msg.textNoRoom" });
    else {
      const tx = fitText(text, layout.textBox, o.textSize);
      const fitted = textBounds(tx), lineH = (fitted.y1 - fitted.y0);
      if (lineH < 3) msgs.push({ level: "warn", key: "ch.msg.textSmall", vars: { h: f1(lineH) } });
      if (tx.lines.length) lines = tx.lines;
      else if (o.inner === "score") lines = outlineLines(tx.area);
      else engrave = tx.area;
    }
  }
  const base = body.hole.length ? safeDiff(body.outline, body.hole) : body.outline;
  let front: MultiPolygon = base, mid: MultiPolygon = base;
  let ok = !msgs.some(m => m.level === "error");
  try {
    front = safeDiff(base, windowArea);
    mid = safeDiff(base, pocketArea);
  } catch { ok = false; msgs.push({ level: "error", key: "ch.msg.tooLarge" }); }
  if (o.deco !== "none") {
    const keep = union([grow(pocketArea, 1.5), ...(layout.textBox && hasText ? [[[[[layout.textBox.x0, layout.textBox.y0], [layout.textBox.x1, layout.textBox.y0], [layout.textBox.x1, layout.textBox.y1], [layout.textBox.x0, layout.textBox.y1], [layout.textBox.x0, layout.textBox.y0]]]] as MultiPolygon] : [])]);
    const free = safeDiff(body.outline, keep);
    const motifs = decorate({ shape: o.shape, size: o.size, points: o.points, hanger: o.hanger, holeD: o.holeD, inner: "engrave", textSize: 100, border: false, deco: o.deco }, free, null, Math.max(1.5, o.thickness / 2),
      body.holeAt ? { at: body.holeAt, r: body.holeR } : undefined);
    if (motifs.length) engrave = union([engrave, ...motifs]);
  }
  if (lines.length) lines = clipLines(lines, front, 0.2);
  // Zerfällt ein Teil in Stücke, fällt es beim Schneiden auseinander
  if (ok && (front.length > base.length || mid.length > base.length)) { ok = false; msgs.push({ level: "error", key: "ch.msg.tooLarge" }); }

  const parts: CandyPart[] = [{ kind: "front", index: 0, cut: front, engrave, lines }];
  const shown = Math.min(middle, CANDY_MAX_MIDDLE);
  for (let i = 0; i < shown; i++) parts.push({ kind: "middle", index: i, cut: mid, engrave: [], lines: [] });
  parts.push({ kind: "back", index: 0, cut: base, engrave: [], lines: [] });
  const bb = bounds(body.outline);
  const sweets = union(layout.pockets.map(p => cellArea(sweetOf(p, o))));
  return { parts, middle, total: (middle + 2) * o.thickness, layout, outline: body.outline, windows, sweets, holeAt: body.holeAt, holeR: body.holeR,
    w: bb.x1 - bb.x0, h: bb.y1 - bb.y0, msgs, ok };
}

// ---------- Bauart Faltstreifen ----------

/** Waagerechte Sehne durch x = 0 in Höhe y: [links, rechts] oder null */
function chordAt(segs: Seg[], y: number): [number, number] | null {
  const xs: number[] = [];
  for (const [a, b] of segs) if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
  xs.sort((p, q) => p - q);
  for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i] <= 0 && xs[i + 1] >= 0) return [xs[i], xs[i + 1]];
  return null;
}

/**
 * Faltwinkel: Boden (halbe Länge F/2), dann ein Bogen der Länge B mit dem Drehwinkel β, dann gerade die Seite der Länge L.
 * Die Spitzen treffen sich in der Mitte: F/2 + R·sin β + L·cos β = 0. null = die Seiten sind zu kurz, um sich zu treffen.
 */
export function foldAngle(floor: number, band: number, panel: number): number | null {
  const f = (b: number) => floor / 2 + (band / b) * Math.sin(b) + panel * Math.cos(b);
  let lo = Math.PI / 2, hi = Math.PI * 0.98;
  if (f(hi) > 0) return null;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (f(m) > 0) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

/** Mittellinie des gefalteten Streifens (rechte Hälfte) */
export function foldProfile(floor: number, band: number, panel: number, angle: number): XY[] {
  const R = band / angle, pts: XY[] = [[0, 0], [floor / 2, 0]];
  for (let i = 1; i <= 16; i++) { const a = (angle * i) / 16; pts.push([floor / 2 + R * Math.sin(a), R * (1 - Math.cos(a))]); }
  const [x, y] = pts[pts.length - 1];
  pts.push([x + panel * Math.cos(angle), y + panel * Math.sin(angle)]);
  return pts;
}

/** Luft zwischen Punkten (Süßigkeit, Seitensteg) und der Innenseite des Zelts; negativ = stößt an oder liegt außerhalb */
export function tentGap(profile: XY[], thickness: number, pts: XY[]): number {
  let best = Infinity;
  for (const [x, y] of pts) {
    const ax = Math.abs(x);
    // ab Stelle 2: Die Füllung liegt auf dem Boden, das zählt nicht als Anstoßen
    for (let i = 2; i < profile.length; i++) best = Math.min(best, segSeg([ax, y], [ax, y], profile[i - 1], profile[i]) - thickness / 2);
    // Höhe der Seite an dieser Stelle: darüber (außen) ist kein Innenraum
    let inside = false;
    for (let i = 1; i < profile.length; i++) {
      const p = profile[i - 1], q = profile[i];
      if ((p[1] > y) !== (q[1] > y) && ax < p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1])) inside = true;
    }
    if (!inside) return -1;
  }
  return best;
}

function flexHolder(o: CandyOptions, text: OrnamentText = { area: [], lines: [] }): CandyResult {
  const body = bodyOf(o), t = o.thickness, msgs: CandyMsg[] = [], b0 = bounds(body.outline);
  const win = windowSize(o), gap = minWall(t);
  const round = o.fill === "round";
  const sh = round ? o.diameter : o.fillH, sd = round ? o.diameter : o.depth;
  const need = o.count * win.w + (o.count - 1) * gap + 2 * t;   // innen Platz für die Füllungen, außen je ein Seitensteg
  const empty = (key: string): CandyResult => ({ parts: [], middle: 0, total: t, layout: { cols: o.count, rows: 1, pockets: [], gap, wall: 0, textBox: null }, outline: body.outline, windows: [], sweets: [],
    holeAt: body.holeAt, holeR: body.holeR, w: b0.x1 - b0.x0, h: b0.y1 - b0.y0, msgs: [{ level: "error", key }], ok: false });

  // Fußlinie der Seite: die tiefste Stelle, an der die Form breit genug für Füllung + Seitenstege ist (Stamm, Spitze usw. fallen weg)
  let yc = NaN, W = 0;
  const H = b0.y1 - b0.y0;
  const chords = Array.from({ length: 299 }, (_, i) => {
    const y = b0.y0 + (H * (i + 1)) / 300, c = chordAt(body.segs, y);
    return { y, w: c ? Math.min(-c[0], c[1]) * 2 : 0 };
  });
  // nicht zu schmal gegenüber der Form: sonst säße z. B. eine Kugel auf einem dünnen Hals
  const target = Math.max(need, 0.6 * Math.max(...chords.map(c => c.w)));
  const foot = chords.find(c => c.w >= target && c.w >= need);
  if (foot) { yc = foot.y; W = foot.w; }
  if (!Number.isFinite(yc)) return empty("ch.msg.tooLarge");
  const clipped = polygonClipping.intersection(body.outline, [[[[b0.x0 - 1, yc], [b0.x1 + 1, yc], [b0.x1 + 1, b0.y1 + 1], [b0.x0 - 1, b0.y1 + 1], [b0.x0 - 1, yc]]]]);
  const mainPart = clipped.filter(p => inRegion([p], 0, yc + 0.01));
  if (!mainPart.length) return empty("ch.msg.tooLarge");
  const panel: MultiPolygon = mainPart.map(p => p.map(r => r.map(([x, y]) => [x, y - yc] as XY)));
  const L = bounds(panel).y1;
  const holeAt: XY | undefined = body.holeAt ? [body.holeAt[0], body.holeAt[1] - yc] : undefined;
  if (holeAt && (holeAt[1] - body.holeR < t || !inRegion(panel, holeAt[0], holeAt[1]))) msgs.push({ level: "error", key: "ch.msg.hole", vars: { d: 0, min: f1(t) } });
  if (o.hanger === "none") msgs.push({ level: "warn", key: "ch.msg.flexTie" });
  if (o.router) msgs.push({ level: "warn", key: "ch.msg.flexLaser" });

  // Falten: Boden so lang wie die Füllung tief ist
  const F = Math.max(sd + o.clearance, 2 * t), B = o.bandLen;
  const angle = foldAngle(F, B, L);
  let profile: XY[] = [], sweet: XY[] = [], sweetGap = -1, height = 0;
  const sy = t / 2;
  sweet = round
    ? Array.from({ length: 36 }, (_, i) => { const a = (i / 36) * Math.PI * 2; return [(sd / 2) * Math.cos(a), sy + sh / 2 + (sh / 2) * Math.sin(a)] as XY; })
    : [[-sd / 2, sy], [sd / 2, sy], [sd / 2, sy + sh], [-sd / 2, sy + sh]];
  if (angle === null) msgs.push({ level: "error", key: "ch.msg.tentTight" });
  else {
    profile = foldProfile(F, B, L, angle);
    height = profile[profile.length - 1][1];
    sweetGap = tentGap(profile, t, sweet);
    if (sweetGap < 0) msgs.push({ level: "error", key: "ch.msg.tentTight" });
    if (B / angle - t / 2 < t) msgs.push({ level: "warn", key: "ch.msg.bendTight", vars: { min: f1((1.5 * t) * angle) } });
  }

  // Biegezonen: Muster aus dem Flex-Scharnier, Schnitte quer zum Streifen
  const sug = suggestForThickness(t);
  const hinge = livingHinge({ pattern: "lines", width: B, height: W, panel: false, length: B, spacing: sug.spacing, cut: Math.min(sug.cut, Math.max(2 * sug.bridge, (W - 2 * sug.bridge) * 0.6)),
    bridge: sug.bridge, amplitude: 0, slotWidth: 0, thickness: t });
  for (const k of hinge.warnings) msgs.push({ level: "warn", key: k });
  const slits: ScoreLine[] = [];
  for (const l of hinge.lines) {
    slits.push({ closed: false, pts: l.pts.map(([x, y]) => [y - W / 2, F / 2 + x] as XY) });
    slits.push({ closed: false, pts: l.pts.map(([x, y]) => [y - W / 2, -F / 2 - x] as XY) });
  }

  // Streifen: Vorderseite oben, gespiegelte Rückseite unten – gefaltet liegen beide deckungsgleich aufeinander
  const y0 = F / 2 + B, hw = W / 2;
  const front = panel.map(p => p.map(r => r.map(([x, y]) => [x, y + y0] as XY)));
  const back = panel.map(p => p.map(r => r.map(([x, y]) => [x, -y - y0] as XY)));
  const mid: MultiPolygon = [[[[-hw, -y0 - 0.02], [hw, -y0 - 0.02], [hw, y0 + 0.02], [-hw, y0 + 0.02], [-hw, -y0 - 0.02]]]];
  let strip = union([front, mid, back]);
  const shiftHole = (sign: number): MultiPolygon => (holeAt ? cellArea({ cx: holeAt[0], cy: sign * (holeAt[1] + y0), hw: body.holeR, hh: body.holeR, r: body.holeR }) : []);
  if (holeAt) strip = safeDiff(strip, union([shiftHole(1), shiftHole(-1)]));

  // Text und Motive auf der Vorderseite
  let engrave: MultiPolygon = [], lines: ScoreLine[] = [], textBox: TextBox | null = null;
  const tb = textBounds(text), tw = tb.x1 - tb.x0, th = tb.y1 - tb.y0;
  if (tw > 0 && th > 0) {
    const pb: Body = { outline: panel, hole: [], holeAt, holeR: body.holeR, segs: segments(panel) };
    textBox = findTextBox(pb, [], tw / th, Math.max(2, t));
    if (!textBox) msgs.push({ level: "warn", key: "ch.msg.textNoRoom" });
    else {
      const tx = fitText(text, textBox, o.textSize), fit = textBounds(tx);
      if (fit.y1 - fit.y0 < 3) msgs.push({ level: "warn", key: "ch.msg.textSmall", vars: { h: f1(fit.y1 - fit.y0) } });
      const up = (q: number[]): XY => [q[0], q[1] + y0];
      if (tx.lines.length) lines = tx.lines.map(l => ({ closed: l.closed, pts: l.pts.map(up) }));
      else if (o.inner === "score") lines = outlineLines(tx.area).map(l => ({ closed: l.closed, pts: l.pts.map(up) }));
      else engrave = tx.area.map(p => p.map(r => r.map(up)));
    }
  }
  if (o.deco !== "none") {
    const keep: MultiPolygon = textBox ? [[[[textBox.x0, textBox.y0], [textBox.x1, textBox.y0], [textBox.x1, textBox.y1], [textBox.x0, textBox.y1], [textBox.x0, textBox.y0]]]] : [];
    const free = safeDiff(panel, keep);
    const motifs = decorate({ shape: o.shape, size: o.size, points: o.points, hanger: o.hanger, holeD: o.holeD, inner: "engrave", textSize: 100, border: false, deco: o.deco }, free, null, Math.max(1.5, t / 2),
      holeAt ? { at: holeAt, r: body.holeR } : undefined);
    if (motifs.length) engrave = union([engrave, ...motifs.map(m => m.map(p => p.map(r => r.map(([x, y]) => [x, y + y0] as XY))))]);
  }

  // Seitenstege: stehen an den Bodenkanten; Linien auf dem Boden zeigen, wo sie hingehören
  const parts: CandyPart[] = [{ kind: "strip", index: 0, cut: strip, engrave, lines, slits }];
  if (o.bar) {
    for (const sx of [-1, 1]) parts[0].lines.push({ closed: false, pts: [[sx * (hw - t), -F / 2], [sx * (hw - t), F / 2]] });
    const r = Math.min(o.barH, F / 2, 2);
    const area = cellArea({ cx: F / 2, cy: o.barH / 2, hw: F / 2, hh: o.barH / 2, r });
    const flat: MultiPolygon = polygonClipping.union(area, [[[[0, 0], [F, 0], [F, r], [0, r], [0, 0]]]]);
    for (let i = 0; i < 2; i++) parts.push({ kind: "sideBar", index: i, cut: flat, engrave: [], lines: [] });
    if (o.barH < gap) msgs.push({ level: "warn", key: "ch.msg.barThin", vars: { d: f1(o.barH), min: f1(gap) } });
    if (o.barH >= sh) msgs.push({ level: "warn", key: "ch.msg.barTall" });
    if (profile.length && tentGap(profile, t, [[F / 2, sy + o.barH]]) < 0) msgs.push({ level: "warn", key: "ch.msg.sideBarTall" });
  }
  if (strip.length > 1) msgs.push({ level: "error", key: "ch.msg.tooLarge" });
  const length = 2 * (L + B) + F;
  const flex: FlexInfo = { width: W, innerW: W - 2 * t, floor: F, band: B, panel: L, length, angle: angle ?? 0, height, profile, sweet, sweetGap };
  return { parts, middle: 0, total: t, layout: { cols: o.count, rows: 1, pockets: [], gap, wall: 0, textBox }, outline: panel, windows: [], sweets: [], holeAt, holeR: body.holeR,
    w: W, h: length, flex, msgs, ok: !msgs.some(m => m.level === "error") };
}
