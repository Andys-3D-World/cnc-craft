/**
 * FALTSCHACHTEL AUS EINEM STÜCK (dünner Karton, Laser) – reine Geometrie, ohne Fenster, damit sie getestet werden kann.
 *
 * Zwei Bauarten, beide ohne Kleber:
 *  - "tuck": Steckschachtel. Vier Wände in einer Reihe, Deckel und Boden an der Rückwand mit Einsteckklappe,
 *    Staubklappen an den Seitenwänden. Die Naht schließt eine Klappe mit Laschen, die durch Schlitze in der Vorderwand gehen.
 *  - "tray": Schale mit Klappdeckel. Boden in der Mitte, vier Wände außen. Die Ecklaschen der Vorder-/Rückwand liegen
 *    in den doppelten Seitenwänden; deren Rückschlag steckt mit Laschen in Schlitzen im Boden.
 *
 * Maße: Faltlinien liegen in der Mitte des Materials. Zwischen zwei Faltlinien ist eine Wand also „Innenmaß + t“.
 * Was aufeinander liegt, kostet zusätzlich eine Dicke (z. B. Staubklappen unter dem Deckel, Klappe hinter der Wand).
 *
 * Koordinaten: mm, y nach oben, linke untere Ecke des Ganzen bei 0,0.
 */
import polygonClipping from "polygon-clipping";
import type { Polygon } from "polygon-clipping";

export type XY = [number, number];
export type FoldStyle = "tuck" | "tray";
export type FoldOutput = "score" | "perforate";
export const FOLD_STYLES: FoldStyle[] = ["tuck", "tray"];
export const FOLD_OUTPUTS: FoldOutput[] = ["score", "perforate"];

export interface FoldBoxOptions {
  style: FoldStyle;
  width: number; depth: number; height: number;
  outside: boolean;    // Maße sind Außenmaße
  thickness: number;
  flap: number;        // gewünschte Klappenlänge
  clearance: number;   // Spiel je Seite
  lock: boolean;       // Einsteckklappe mit Lasche + Schlitz
  windowW: number; windowH: number;  // Fenster (0 = keines): Vorderwand bzw. Deckel
  hangD: number;       // Aufhängeloch in der Rückwand (0 = keines)
  foldOut: FoldOutput;
}

export interface FoldMsg { key: string; vars?: Record<string, string | number> }
export interface FoldPanel { name: string; x: number; y: number; w: number; h: number }
export interface FoldFlap { name: string; hinge: [XY, XY]; len: number }
export interface FoldLock {
  kind: "seam" | "tuck" | "return";
  at: XY;              // Mitte der Lasche an der Klappenkante
  neck: number;        // Länge bis zum Widerhaken
  tabW: number;        // Breite des Halses
  headW: number;       // breiteste Stelle
  slot: { x0: number; y0: number; x1: number; y1: number };
}
export interface FoldBoxResult {
  outline: XY[];       // Außenkontur, geschlossen (letzter Punkt ≠ erster)
  holes: XY[][];       // Schlitze, Fenster, Loch (geschlossen)
  folds: [XY, XY][];   // Faltlinien (offen, enden kurz vor der Kontur)
  dashes: [XY, XY][];  // dieselben Linien als Perforation
  panels: FoldPanel[];
  flaps: FoldFlap[];
  locks: FoldLock[];
  w: number; h: number;
  inner: { w: number; d: number; h: number };
  outer: { w: number; d: number; h: number };
  lengths: { tuck: number; side: number };  // tatsächliche Längen: Einsteckklappe, Staubklappe/Ecklasche
  errors: FoldMsg[];
  warnings: FoldMsg[];
}

export const FOLD_END_GAP = 0.5;  // Faltlinie endet so weit vor der Kontur (Laser fährt nie auf der Schnittkante)
export const MAX_THICKNESS = 3;
export const THIN_LIMIT = 1.5;
export const PERF_CUT = 4;
export const PERF_BRIDGE = 2;
const MIN_SIZE = 15;
const MIN_FLAP = 3;
const SNAP = 1000;

const snap = (v: number) => Math.round(v * SNAP) / SNAP;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const fmt = (v: number) => String(Number(v.toFixed(1)));

/** Innenmaße aus den eingegebenen Maßen */
export function innerSizes(o: FoldBoxOptions): { w: number; d: number; h: number } {
  const t = o.thickness;
  if (!o.outside) return { w: o.width, d: o.depth, h: o.height };
  return o.style === "tuck"
    ? { w: o.width - 2 * t, d: o.depth - 2 * t, h: o.height - 4 * t }
    : { w: o.width - 6 * t, d: o.depth - 2 * t, h: o.height - 2 * t };
}

/** Klappe an der Linie a–b, n = Richtung nach außen (Einheitsvektor), mit abgeschrägten freien Ecken */
function flapPoly(a: XY, b: XY, n: XY, len: number): XY[] {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const u: XY = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  const ch = Math.min(len / 2, L / 4, 6);
  const at = (p: XY, s: number, d: number): XY => [p[0] + u[0] * s + n[0] * d, p[1] + u[1] * s + n[1] * d];
  return [a, b, at(b, 0, len - ch), at(b, -ch, len), at(a, ch, len), at(a, 0, len - ch)];
}

/** Laschenbreite aus dem verfügbaren Platz */
const tabWidth = (span: number) => clamp(span * 0.25, 6, 20);
/** Widerhaken: immer breiter als der Schlitz, damit die Lasche nicht von selbst herausrutscht */
const barbOf = (c: number) => Math.max(0.8, c + 0.5);
const neckOf = (t: number, c: number) => t + c + 0.3;
const headOf = (tw: number) => Math.min(4, tw / 2);

function tabPoly(at: XY, n: XY, tw: number, t: number, c: number): XY[] {
  const u: XY = [-n[1], n[0]];
  const neck = neckOf(t, c), head = headOf(tw), barb = barbOf(c);
  const p = (s: number, d: number): XY => [at[0] + u[0] * s + n[0] * d, at[1] + u[1] * s + n[1] * d];
  return [p(-tw / 2, 0), p(-tw / 2, neck), p(-tw / 2 - barb, neck), p(-tw / 2 + 1, neck + head), p(tw / 2 - 1, neck + head), p(tw / 2 + barb, neck), p(tw / 2, neck), p(tw / 2, 0)];
}

const rect = (x0: number, y0: number, x1: number, y1: number): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
function roundHole(cx: number, cy: number, d: number): XY[] {
  const pts: XY[] = [];
  for (let i = 0; i < 32; i++) { const a = i * Math.PI / 16; pts.push([cx + Math.cos(a) * d / 2, cy + Math.sin(a) * d / 2]); }
  return pts;
}
function windowHole(cx: number, cy: number, w: number, h: number): XY[] {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, r = Math.min(1, w / 4, h / 4);
  return [[x0 + r, y0], [x1 - r, y0], [x1, y0 + r], [x1, y1 - r], [x1 - r, y1], [x0 + r, y1], [x0, y1 - r], [x0, y0 + r]];
}

/** Punkte auf einer Geraden entfernen */
function cleanRing(ring: XY[]): XY[] {
  const r = ring.slice();
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  const out: XY[] = [];
  for (let i = 0; i < r.length; i++) {
    const a = r[(i + r.length - 1) % r.length], b = r[i], c = r[(i + 1) % r.length];
    if (Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > 1e-6) out.push(b);
  }
  return out;
}

/** Faltlinie an beiden Enden kürzen; zu kurze Linien fallen weg */
function fold(list: [XY, XY][], a: XY, b: XY) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L <= 2 * FOLD_END_GAP + 1) return;
  const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  list.push([[a[0] + ux * FOLD_END_GAP, a[1] + uy * FOLD_END_GAP], [b[0] - ux * FOLD_END_GAP, b[1] - uy * FOLD_END_GAP]]);
}

/** Faltlinie als Perforation: Schnitte mit Stegen dazwischen, an beiden Enden immer ein Steg */
export function perforate(line: [XY, XY], cut = PERF_CUT, bridge = PERF_BRIDGE): [XY, XY][] {
  const [a, b] = line;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const at = (s: number): XY => [a[0] + (b[0] - a[0]) * s / L, a[1] + (b[1] - a[1]) * s / L];
  const n = Math.floor((L - bridge) / (cut + bridge));
  if (n < 1) return L > 2 * bridge + 1 ? [[at(bridge), at(L - bridge)]] : [];
  const start = (L - (n * cut + (n - 1) * bridge)) / 2;
  const out: [XY, XY][] = [];
  for (let i = 0; i < n; i++) { const s = start + i * (cut + bridge); out.push([at(s), at(s + cut)]); }
  return out;
}

/** Ebenen mit Faltlinien nach vorn, sonst bleibt die Reihenfolge: gefaltet wird, solange das Teil noch festliegt */
export function foldLayersFirst<T>(ordered: T[], isFold: (x: T) => boolean): T[] {
  return [...ordered.filter(isFold), ...ordered.filter(x => !isFold(x))];
}

interface Build {
  polys: XY[][]; holes: XY[][]; folds: [XY, XY][]; panels: FoldPanel[]; flaps: FoldFlap[]; locks: FoldLock[];
  tuck: number; side: number; outer: { w: number; d: number; h: number };
}

function slotRect(cx: number, cy: number, w: number, h: number) { return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 }; }
const slotHole = (s: FoldLock["slot"]) => rect(s.x0, s.y0, s.x1, s.y1);

/** Lasche an die Klappe, Schlitz in die Wand */
function addLock(b: Build, kind: FoldLock["kind"], at: XY, n: XY, tw: number, t: number, c: number, slotCenter: XY, slotAlongX: boolean) {
  const long = tw + 2 * c, thin = t + c;
  const slot = slotAlongX ? slotRect(slotCenter[0], slotCenter[1], long, thin) : slotRect(slotCenter[0], slotCenter[1], thin, long);
  b.polys.push(tabPoly(at, n, tw, t, c));
  b.holes.push(slotHole(slot));
  b.locks.push({ kind, at, neck: neckOf(t, c), tabW: tw, headW: tw + 2 * barbOf(c), slot });
}

function checkFlap(wanted: number, max: number, key: string, warnings: FoldMsg[]): number {
  if (wanted <= max) return wanted;
  warnings.push({ key, vars: { want: fmt(wanted), max: fmt(Math.max(0, max)) } });
  return Math.max(MIN_FLAP, max);
}

function windowErr(errors: FoldMsg[], o: FoldBoxOptions, maxW: number, maxH: number) {
  if (o.windowW > maxW || o.windowH > maxH) errors.push({ key: "fold.err.window", vars: { w: fmt(Math.max(0, maxW)), h: fmt(Math.max(0, maxH)) } });
}

function hangErr(errors: FoldMsg[], o: FoldBoxOptions, maxD: number) {
  if (o.hangD > maxD) errors.push({ key: "fold.err.hang", vars: { max: fmt(Math.max(0, maxD)) } });
}

function buildTuck(o: FoldBoxOptions, W: number, D: number, H: number, errors: FoldMsg[], warnings: FoldMsg[]): Build {
  const t = o.thickness, c = o.clearance;
  const WF = W + t, DF = D + t;                 // Wand von Faltlinie zu Faltlinie
  const Hm = H + 3 * t;                         // Vorder-/Rückwand: Staubklappen oben und unten kosten je eine Dicke
  const frontW = WF + t / 2;                    // freie Kante reicht bis zur Außenseite der rechten Seitenwand
  const x1 = frontW, x2 = x1 + DF, x3 = x2 + WF, x4 = x3 + DF;
  const lidL = D - c;                           // Einsteckklappe liegt innen an der Vorderwand
  const m = t + c;                              // Klappen schmaler als die Öffnung (innen liegt noch die Nahtklappe)
  const tuckW = WF - 2 * m;
  const thin = t + c;

  const tuck = checkFlap(o.flap, H / 2 - c - (o.lock ? thin : 0), "fold.warn.tuckLong", warnings);
  const side = checkFlap(o.flap, WF / 2 - c, "fold.warn.dustLong", warnings);
  const lockW = tabWidth(tuckW);
  const seamMax = (o.lock ? WF / 2 - lockW / 2 - c - 2 : W - 3) - thin - t / 2;
  if (seamMax < MIN_FLAP) errors.push({ key: "fold.err.narrow" });
  const seam = Math.max(MIN_FLAP, Math.min(o.flap, seamMax));

  const b: Build = { polys: [], holes: [], folds: [], panels: [], flaps: [], locks: [], tuck, side,
    outer: { w: W + 2 * t, d: D + 2 * t, h: H + 4 * t } };
  const panel = (name: string, x0: number, y0: number, x1b: number, y1: number) => {
    b.panels.push({ name, x: x0, y: y0, w: x1b - x0, h: y1 - y0 });
    b.polys.push(rect(x0, y0, x1b, y1));
  };
  panel("front", 0, 0, x1, Hm);
  panel("sideL", x1, t, x2, Hm - t);
  panel("back", x2, 0, x3, Hm);
  panel("sideR", x3, t, x4, Hm - t);
  panel("lid", x2, Hm, x3, Hm + lidL);
  panel("floor", x2, -lidL, x3, 0);
  fold(b.folds, [x1, t], [x1, Hm - t]);
  fold(b.folds, [x2, t], [x2, Hm - t]);
  fold(b.folds, [x3, t], [x3, Hm - t]);
  fold(b.folds, [x2, Hm], [x3, Hm]);
  fold(b.folds, [x2, 0], [x3, 0]);

  const addFlap = (name: string, a: XY, e: XY, n: XY, len: number) => {
    b.polys.push(flapPoly(a, e, n, len));
    b.flaps.push({ name, hinge: [a, e], len });
    fold(b.folds, a, e);
  };
  // Einsteckklappen an Deckel und Boden
  addFlap("tuckTop", [x2 + m, Hm + lidL], [x3 - m, Hm + lidL], [0, 1], tuck);
  addFlap("tuckBottom", [x2 + m, -lidL], [x3 - m, -lidL], [0, -1], tuck);
  // Staubklappen an den Seitenwänden
  for (const [nm, xa, xb] of [["dustL", x1, x2], ["dustR", x3, x4]] as [string, number, number][]) {
    addFlap(nm + "Top", [xa + m, Hm - t], [xb - m, Hm - t], [0, 1], side);
    addFlap(nm + "Bottom", [xa + m, t], [xb - m, t], [0, -1], side);
  }
  // Nahtklappe: geht innen hinter die Vorderwand, Laschen durch die Schlitze
  const sy0 = t + c, sy1 = Hm - t - c;
  addFlap("seam", [x4, sy0], [x4, sy1], [1, 0], seam);
  const seamTabW = tabWidth((sy1 - sy0) / 2);
  const seamYs = sy1 - sy0 >= 40 ? [sy0 + (sy1 - sy0) / 4, sy0 + 3 * (sy1 - sy0) / 4] : [(sy0 + sy1) / 2];
  // zusammengefaltet: rechte Seitenwand liegt bei x = t/2 auf der Vorderwand
  const seamEdge = t / 2 + seam;
  for (const y of seamYs) addLock(b, "seam", [x4 + seam, y], [1, 0], seamTabW, t, c, [seamEdge + thin / 2, y], false);

  // Mitte der Vorderwand im gefalteten Zustand (nicht die Mitte des Zuschnitts, die freie Kante steht t/2 über)
  const cx = x1 - WF / 2, backCx = (x2 + x3) / 2;
  if (o.lock) {
    addLock(b, "tuck", [backCx, Hm + lidL + tuck], [0, 1], lockW, t, c, [cx, Hm - tuck - thin / 2], true);
    addLock(b, "tuck", [backCx, -lidL - tuck], [0, -1], lockW, t, c, [cx, tuck + thin / 2], true);
  }
  // Fenster in der Vorderwand: frei von Naht, Schlitzen und Klappen
  if (o.windowW > 0 && o.windowH > 0) {
    const reserve = tuck + (o.lock ? thin : 0) + 2;
    windowErr(errors, o, 2 * Math.min(cx - (seamEdge + thin + 2), x1 - 2 - cx), Hm - 2 * reserve);
    b.holes.push(windowHole(cx, Hm / 2, o.windowW, o.windowH));
  }
  if (o.hangD > 0) {
    hangErr(errors, o, Math.min(WF - 6, Hm - 8));
    b.holes.push(roundHole(backCx, Hm - 4 - o.hangD / 2, o.hangD));
  }
  return b;
}

function buildTray(o: FoldBoxOptions, W: number, D: number, H: number, errors: FoldMsg[], warnings: FoldMsg[]): Build {
  const t = o.thickness, c = o.clearance;
  const FW = W + 5 * t, FD = D + t;             // Seitenwand ist doppelt und hat die Ecklasche dazwischen (je 2,5 t)
  const backH = H + t, frontH = H + t / 2, sideH = H;  // Seitenwände enden unter dem Deckel
  const lidL = D - c, m = 2.5 * t + c, thin = t + c;
  const retL = H - t / 2 - c;                   // Rückschlag reicht bis auf den Boden
  const retM = t / 2 + c;                       // Rückschlag passt zwischen Vorder- und Rückwand
  const tuckW = FW - 2 * m;

  const tuck = checkFlap(o.flap, H - c - 2, "fold.warn.tuckLong", warnings);
  const side = checkFlap(o.flap, FD / 2 - c, "fold.warn.dustLong", warnings);
  const b: Build = { polys: [], holes: [], folds: [], panels: [], flaps: [], locks: [], tuck, side,
    outer: { w: W + 6 * t, d: D + 2 * t, h: H + 2 * t } };
  const panel = (name: string, x0: number, y0: number, x1: number, y1: number) => {
    b.panels.push({ name, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    b.polys.push(rect(x0, y0, x1, y1));
  };
  const addFlap = (name: string, a: XY, e: XY, n: XY, len: number) => {
    b.polys.push(flapPoly(a, e, n, len));
    b.flaps.push({ name, hinge: [a, e], len });
    fold(b.folds, a, e);
  };
  const lidY = FD + backH;
  panel("floor", 0, 0, FW, FD);
  panel("front", 0, -frontH, FW, 0);
  panel("back", 0, FD, FW, lidY);
  panel("lid", 0, lidY, FW, lidY + lidL);
  panel("sideL", -sideH, 0, 0, FD);
  panel("sideR", FW, 0, FW + sideH, FD);
  fold(b.folds, [0, 0], [FW, 0]);
  fold(b.folds, [0, FD], [FW, FD]);
  fold(b.folds, [0, lidY], [FW, lidY]);
  fold(b.folds, [0, 0], [0, FD]);
  fold(b.folds, [FW, 0], [FW, FD]);
  addFlap("tuckTop", [m, lidY + lidL], [FW - m, lidY + lidL], [0, 1], tuck);

  // Ecklaschen: oben/unten Luft, damit Boden und Deckel frei bleiben; Abstand zur Seitenwand = eigener Schnitt
  const z0 = t + c, z1 = H - c;
  for (const [nm, x, nx] of [["earL", 0, -1], ["earR", FW, 1]] as [string, number, number][]) {
    addFlap(nm + "Front", [x, -z1], [x, -z0], [nx, 0], side);
    addFlap(nm + "Back", [x, FD + z0], [x, FD + z1], [nx, 0], side);
  }
  // Rückschlag der doppelten Seitenwand, Laschen in den Boden
  const retSpan = FD - 2 * retM;
  const retTab = tabWidth(retSpan / 2);
  const retYs = retSpan >= 40 ? [retM + retSpan / 4, retM + 3 * retSpan / 4] : [FD / 2];
  for (const [nm, hx, nx, slotX] of [["returnL", -sideH, -1, 2 * t], ["returnR", FW + sideH, 1, FW - 2 * t]] as [string, number, number, number][]) {
    addFlap(nm, [hx, retM], [hx, FD - retM], [nx, 0], retL);
    for (const y of retYs) addLock(b, "return", [hx + nx * retL, y], [nx, 0], retTab, t, c, [slotX, y], false);
  }
  const cx = FW / 2;
  if (o.lock) {
    const lockW = tabWidth(tuckW);
    // Klappe endet tuck unter dem Deckel; der Schlitz sitzt direkt darunter in der Vorderwand
    addLock(b, "tuck", [cx, lidY + lidL + tuck], [0, 1], lockW, t, c, [cx, -(backH - tuck - thin / 2)], true);
  }
  if (o.windowW > 0 && o.windowH > 0) {
    windowErr(errors, o, FW - 6, lidL - 6);
    b.holes.push(windowHole(cx, lidY + lidL / 2, o.windowW, o.windowH));
  }
  if (o.hangD > 0) {
    hangErr(errors, o, Math.min(FW - 6, backH - 8));
    b.holes.push(roundHole(cx, lidY - 4 - o.hangD / 2, o.hangD));
  }
  return b;
}

const EMPTY = (inner: FoldBoxResult["inner"], errors: FoldMsg[], warnings: FoldMsg[]): FoldBoxResult => ({
  outline: [], holes: [], folds: [], dashes: [], panels: [], flaps: [], locks: [], w: 0, h: 0, inner, outer: { w: 0, d: 0, h: 0 },
  lengths: { tuck: 0, side: 0 }, errors, warnings
});

export function foldBox(o: FoldBoxOptions): FoldBoxResult {
  const errors: FoldMsg[] = [], warnings: FoldMsg[] = [];
  const t = o.thickness;
  const inner = innerSizes(o);
  if (!(t > 0)) errors.push({ key: "fold.err.thickness" });
  else if (t > MAX_THICKNESS) errors.push({ key: "fold.err.tooThick", vars: { max: MAX_THICKNESS } });
  else if (t > THIN_LIMIT) warnings.push({ key: "fold.warn.thick", vars: { t: fmt(t) } });
  if (!(Math.min(inner.w, inner.d, inner.h) >= MIN_SIZE)) errors.push({ key: "fold.err.small", vars: { min: MIN_SIZE } });
  else if (t > 0 && t <= MAX_THICKNESS && Math.min(inner.w, inner.d, inner.h) < 10 * t) errors.push({ key: "fold.err.thickForSize", vars: { min: fmt(10 * t) } });
  if (!(o.flap >= MIN_FLAP)) errors.push({ key: "fold.err.flapShort", vars: { min: MIN_FLAP } });
  if (errors.length) return EMPTY(inner, errors, warnings);
  if (o.flap < 8) warnings.push({ key: "fold.warn.flapShort" });
  if ((o.windowW > 0) !== (o.windowH > 0)) warnings.push({ key: "fold.warn.windowHalf" });

  const b = (o.style === "tray" ? buildTray : buildTuck)(o, inner.w, inner.d, inner.h, errors, warnings);
  if (errors.length) return EMPTY(inner, errors, warnings);

  // Zu einem Umriss vereinen. Klappen, die nicht zusammengehören, haben immer Abstand – bleibt mehr als ein Ring, stimmt etwas nicht
  const toPoly = (p: XY[]): Polygon => [[...p, p[0]].map(([x, y]) => [snap(x), snap(y)] as XY)];
  const [first, ...rest] = b.polys.map(toPoly);
  const union = polygonClipping.union(first, ...rest);
  if (union.length !== 1 || union[0].length !== 1) return EMPTY(inner, [{ key: "fold.err.geometry" }], warnings);
  let outline = cleanRing(union[0][0] as XY[]);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of outline) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const mv = ([x, y]: XY): XY => [x - minX, y - minY];
  outline = outline.map(mv);
  const folds = b.folds.map(([p, q]): [XY, XY] => [mv(p), mv(q)]);
  return {
    outline,
    holes: b.holes.map(h => h.map(mv)),
    folds,
    dashes: folds.flatMap(l => perforate(l)),
    panels: b.panels.map(p => ({ ...p, x: p.x - minX, y: p.y - minY })),
    flaps: b.flaps.map(f => ({ ...f, hinge: [mv(f.hinge[0]), mv(f.hinge[1])] as [XY, XY] })),
    locks: b.locks.map(l => ({ ...l, at: mv(l.at), slot: { x0: l.slot.x0 - minX, x1: l.slot.x1 - minX, y0: l.slot.y0 - minY, y1: l.slot.y1 - minY } })),
    w: maxX - minX, h: maxY - minY,
    inner, outer: b.outer,
    lengths: { tuck: b.tuck, side: b.side },
    errors, warnings
  };
}
