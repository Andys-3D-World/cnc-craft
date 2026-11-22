/**
 * TWO-SIDED MILLING – the maths (no UI, no DOM; tests in tests/twoSided.test.ts)
 *
 * Mill one side, turn the stock over, mill the other side. Dowel pins in the spoilboard line both sides up.
 *
 * How it fits together:
 *  - The stock is a rectangle (lower-left corner x/y, size w/h, thickness) in job coordinates (mm, Y up).
 *  - It is turned over about its own centre line: "lr" = left edge goes right (like a book page, the line runs
 *    along Y), "fb" = front edge goes back (the line runs along X). The stock lands on the same footprint.
 *  - Front shapes are stored as the machine sees them with the front up, back shapes as the machine sees them
 *    after turning. So the G-code of a side never mirrors anything. A point of the real part that sits at p with
 *    the front up sits at mirrorPoint(p) with the back up. That is used to show the other side as a ghost,
 *    to copy shapes to the other side and to compare depths.
 *  - Pin holes are drilled by the front program through the stock into the spoilboard. After turning, a hole
 *    drilled at p lies at mirrorPoint(p). The stock only fits back on the pins when every pin has a partner
 *    there: on the turning line, or in mirrored pairs.
 *  - X/Y zero never changes between the sides (the pins sit in the spoilboard). Z zero is the stock's nominal
 *    top on both sides: with zRef "spoil" the user touches the spoilboard and sets Z to −thickness.
 */
import { scaleShape, MM_TO_PIXEL } from "./shapeTransform.ts";

export type Side = "front" | "back";
export type Flip = "lr" | "fb";
export type ZRef = "spoil" | "top";
export interface Pt { x: number; y: number }
export interface StockRect { x: number; y: number; w: number; h: number }

export interface TwoSidedSetup {
  on: boolean;
  flip: Flip;
  stock: StockRect;      // mm, lower-left corner and size
  thickness: number;     // mm
  zRef: ZRef;
  pinsOn: boolean;       // front program drills the pin holes
  pinDia: number;        // mm
  pinDepth: number;      // mm into the spoilboard
  pins: Pt[];            // mm, as seen with the front up
  pinsAuto: boolean;     // positions follow the stock until the user edits them
  pinToolId?: string;
}

const num = (v: unknown, d: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

export const MAX_PINS = 12;

export function defaultSetup(): TwoSidedSetup {
  const s: TwoSidedSetup = {
    on: false, flip: "lr", stock: { x: 20, y: 20, w: 200, h: 150 }, thickness: 18, zRef: "spoil",
    pinsOn: true, pinDia: 6, pinDepth: 8, pins: [], pinsAuto: true,
  };
  s.pins = defaultPins(s, []);
  return s;
}

/** Setup from a project file: only known fields, numbers in sane ranges */
export function cleanSetup(raw: any): TwoSidedSetup | null {
  if (!raw || typeof raw !== "object") return null;
  const d = defaultSetup(), st = raw.stock || {};
  const s: TwoSidedSetup = {
    on: raw.on === true,
    flip: raw.flip === "fb" ? "fb" : "lr",
    stock: { x: num(st.x, d.stock.x, -1e5, 1e5), y: num(st.y, d.stock.y, -1e5, 1e5), w: num(st.w, d.stock.w, 1, 1e5), h: num(st.h, d.stock.h, 1, 1e5) },
    thickness: num(raw.thickness, d.thickness, 0.1, 500),
    zRef: raw.zRef === "top" ? "top" : "spoil",
    pinsOn: raw.pinsOn !== false,
    pinDia: num(raw.pinDia, d.pinDia, 0.5, 50),
    pinDepth: num(raw.pinDepth, d.pinDepth, 0, 100),
    pins: Array.isArray(raw.pins)
      ? raw.pins.filter((p: any) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))).slice(0, MAX_PINS).map((p: any) => ({ x: Number(p.x), y: Number(p.y) }))
      : [],
    pinsAuto: raw.pinsAuto === true,
    pinToolId: typeof raw.pinToolId === "string" ? raw.pinToolId.slice(0, 80) : undefined,
  };
  return s;
}

export const cloneSetup = (s: TwoSidedSetup): TwoSidedSetup => ({ ...s, stock: { ...s.stock }, pins: s.pins.map(p => ({ ...p })) });

/** The line the stock is turned about: "lr" → x = at (runs along Y), "fb" → y = at (runs along X) */
export function flipLine(s: Pick<TwoSidedSetup, "flip" | "stock">): { along: "x" | "y"; at: number } {
  return s.flip === "lr" ? { along: "y", at: s.stock.x + s.stock.w / 2 } : { along: "x", at: s.stock.y + s.stock.h / 2 };
}

/** Where a point of the part lies once the stock is turned over (mm). Applying it twice gives the point back. */
export function mirrorPoint(p: Pt, s: Pick<TwoSidedSetup, "flip" | "stock">): Pt {
  const l = flipLine(s);
  return l.along === "y" ? { x: 2 * l.at - p.x, y: p.y } : { x: p.x, y: 2 * l.at - p.y };
}

/** Mirror a drawing shape (world pixels) in place – the same routine as the editor's own mirror command */
export function mirrorShape(shape: any, s: Pick<TwoSidedSetup, "flip" | "stock">): any {
  const l = flipLine(s), at = l.at * MM_TO_PIXEL;
  if (l.along === "y") scaleShape(shape, at, 0, -1, 1); else scaleShape(shape, 0, at, 1, -1);
  return shape;
}

/**
 * Move back shapes from one setup to another so they stay at the same place on the real part
 * (turn back with the old line, turn over with the new one). Front shapes never move.
 */
export function remapBackShape(shape: any, from: Pick<TwoSidedSetup, "flip" | "stock">, to: Pick<TwoSidedSetup, "flip" | "stock">): any {
  const a = flipLine(from), b = flipLine(to);
  if (a.along === b.along && Math.abs(a.at - b.at) < 1e-9) return shape;
  return mirrorShape(mirrorShape(shape, from), to);
}

// ---------------------------------------------------------------------
// Dowel pins
// ---------------------------------------------------------------------

export interface Box { minX: number; minY: number; maxX: number; maxY: number }

/** Distance of the pin centres from the stock edge for the automatic layout */
export const pinMargin = (dia: number) => Math.max(8, dia * 1.5);

/**
 * Sensible positions: two pins on the turning line near both ends of the stock. If one of them would sit in a
 * part (boxes in mm, front frame), four pins in the corners instead (two mirrored pairs).
 */
export function defaultPins(s: Pick<TwoSidedSetup, "flip" | "stock" | "pinDia">, parts: Box[]): Pt[] {
  const { x, y, w, h } = s.stock, m = Math.min(pinMargin(s.pinDia), w / 2, h / 2), l = flipLine(s);
  const onLine: Pt[] = l.along === "y" ? [{ x: l.at, y: y + m }, { x: l.at, y: y + h - m }] : [{ x: x + m, y: l.at }, { x: x + w - m, y: l.at }];
  const r = s.pinDia / 2 + 1;
  const hit = (p: Pt) => parts.some(b => p.x + r > b.minX && p.x - r < b.maxX && p.y + r > b.minY && p.y - r < b.maxY);
  if (!onLine.some(hit)) return onLine;
  const corners: Pt[] = [{ x: x + m, y: y + m }, { x: x + w - m, y: y + m }, { x: x + w - m, y: y + h - m }, { x: x + m, y: y + h - m }];
  return corners.some(hit) ? onLine : corners;
}

/** A cut path of either side, in mm, already in the front frame. grow = how far the cut reaches beyond the line */
export interface PinObstacle { pts: Pt[]; closed: boolean; grow: number }

export type PinIssueCode = "few" | "asym" | "inPart" | "offStock" | "offBed" | "close";
export interface PinIssue { code: PinIssueCode; pin: number }  // pin = 1-based number, 0 = all

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const f = l2 > 1e-18 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(a.x + dx * f - p.x, a.y + dy * f - p.y);
}
function pathDist(p: Pt, pts: Pt[], closed: boolean): number {
  let d = Infinity;
  const n = pts.length;
  if (n === 1) return Math.hypot(pts[0].x - p.x, pts[0].y - p.y);
  for (let i = 0; i < (closed ? n : n - 1); i++) d = Math.min(d, segDist(p, pts[i], pts[(i + 1) % n]));
  return d;
}
function inside(p: Pt, poly: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/** Tolerance for "mirrored partner": a hundredth of a millimetre */
export const PIN_SYM_TOL = 0.01;

export function pinIssues(s: TwoSidedSetup, obstacles: PinObstacle[], bed: { w: number; h: number } | null): PinIssue[] {
  const out: PinIssue[] = [];
  if (!s.pinsOn) return out;
  const pins = s.pins, r = s.pinDia / 2;
  if (pins.length < 2) out.push({ code: "few", pin: 0 });
  pins.forEach((p, i) => {
    const n = i + 1;
    const m = mirrorPoint(p, s);
    if (!pins.some(q => Math.hypot(q.x - m.x, q.y - m.y) <= PIN_SYM_TOL)) out.push({ code: "asym", pin: n });
    const st = s.stock;
    if (p.x - r < st.x - 1e-9 || p.x + r > st.x + st.w + 1e-9 || p.y - r < st.y - 1e-9 || p.y + r > st.y + st.h + 1e-9) out.push({ code: "offStock", pin: n });
    if (bed && (p.x - r < 0 || p.x + r > bed.w || p.y - r < 0 || p.y + r > bed.h)) out.push({ code: "offBed", pin: n });
    // the hole also exists at the mirrored place once the stock is turned: check both
    const spots = [p, m];
    if (obstacles.some(o => spots.some(q => (o.closed && o.pts.length >= 3 && inside(q, o.pts)) || pathDist(q, o.pts, o.closed) < r + o.grow))) out.push({ code: "inPart", pin: n });
  });
  // all pins nearly at one spot: the stock could still turn around them
  if (pins.length >= 2) {
    let far = 0;
    for (const a of pins) for (const b of pins) far = Math.max(far, Math.hypot(a.x - b.x, a.y - b.y));
    if (far < Math.max(20, 4 * s.pinDia)) out.push({ code: "close", pin: 0 });
  }
  return out;
}

export type PinCut = "drill" | "inside" | "pocket" | "tooBig";

/** How the pin hole is made with a given tool: drilled with a matching Ø, milled as a circle with a smaller one */
export function pinCut(pinDia: number, toolDia: number, toolIsDrill: boolean): PinCut {
  if (Math.abs(toolDia - pinDia) <= 0.05) return "drill";
  if (toolDia > pinDia) return "tooBig";
  if (toolIsDrill) return "tooBig";              // a smaller drill cannot widen the hole
  // a circle path leaves a core once the hole is wider than two cutters: clear it as a pocket
  return pinDia > 2 * toolDia + 0.01 ? "pocket" : "inside";
}

// ---------------------------------------------------------------------
// Depths of both sides together
// ---------------------------------------------------------------------

/**
 * One cut of one side, in mm, in the FRONT frame (back cuts mirrored back by the caller).
 * area = everything inside pts is removed (pocket, facing, drilled hole), groove = a slot of `width` along pts.
 */
export interface Removal {
  side: Side;
  n: number;               // shape number for messages (1-based, per side)
  kind: "area" | "groove";
  pts: Pt[];
  closed: boolean;
  depth: number;           // mm, positive
  width: number;           // groove: cutter Ø
  outline: boolean;        // cut around a part (mode "outside", closed): cutting it through sets the part free
  tabH: number;            // height of holding tabs above the bottom of this cut, 0 = none
  skin?: number;           // onion skin this cut leaves on purpose (mm, onionSkin.ts) – depth already ends above it
}

export type DepthIssueCode = "looseFront" | "loose" | "tabsThin" | "through" | "thin";
export interface DepthIssue { code: DepthIssueCode; front: number; back: number; left: number }

/** A web thinner than this counts as "almost through" */
export const MIN_WEB = 0.5;
/** Holding tabs thinner than this no longer hold */
export const MIN_TAB = 0.3;

function sample(pts: Pt[], closed: boolean, step: number): Pt[] {
  const out: Pt[] = [];
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n], k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = 0; j < k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k });
  }
  if (!closed && n) out.push(pts[n - 1]);
  return out;
}
const reach = (r: Removal) => (r.kind === "groove" ? r.width / 2 : 0);
/** Does the point lie in what this cut removes? extra = half width of the cut the point belongs to */
function removes(r: Removal, p: Pt, extra: number): boolean {
  if (r.kind === "area") return (r.pts.length >= 3 && inside(p, r.pts)) || pathDist(p, r.pts, true) <= extra + 1e-6;
  return pathDist(p, r.pts, r.closed) <= r.width / 2 + extra + 1e-6;
}
/** Share (0…1) of a's own line that b removes as well */
function sharedShare(a: Removal, b: Removal): number {
  const pts = sample(a.pts, a.kind === "area" ? true : a.closed, Math.max(0.5, Math.min(2, (a.width || 2) / 2)));
  if (!pts.length) return 0;
  return pts.filter(p => removes(b, p, reach(a))).length / pts.length;
}

/**
 * What front and back do together. T = stock thickness.
 *  looseFront: the front alone cuts a part free without tabs – after turning nothing lines it up
 *  loose:      front and back together cut a part free and neither leaves tabs
 *  tabsThin:   the two cuts overlap so far that less than MIN_TAB of the tabs is left
 *  through:    two cuts that each stop inside the material meet – a hole appears
 *  thin:       less than MIN_WEB is left between them
 * Tabs: where one side leaves a tab of height h and the cuts overlap by `over`, h − over of it is left.
 * Onion skin: a cut that leaves a skin on purpose is not "thin" as long as the whole skin is still there.
 */
export function depthIssues(list: Removal[], T: number): DepthIssue[] {
  const out: DepthIssue[] = [];
  const fronts = list.filter(r => r.side === "front"), backs = list.filter(r => r.side === "back");
  const EPS = 1e-6;
  for (const f of fronts) {
    if (f.outline && f.depth >= T - EPS && !(f.tabH > 0)) out.push({ code: "looseFront", front: f.n, back: 0, left: 0 });
  }
  for (const f of fronts) {
    for (const b of backs) {
      const left = T - f.depth - b.depth;
      if (left >= MIN_WEB) continue;
      const fThrough = f.depth >= T - EPS, bThrough = b.depth >= T - EPS;
      const fb = sharedShare(f, b), bf = sharedShare(b, f);
      if (fb <= 0 && bf <= 0) continue;
      if ([f, b].some(r => (r.skin ?? 0) > 0 && left >= r.skin! - 1e-6)) continue;   // the wanted skin, untouched
      if (f.outline && b.outline && Math.min(fb, bf) > 0.95) {
        // the same outline from both sides
        if (fThrough && !(f.tabH > 0)) continue;   // already reported as looseFront
        if (left > EPS) { out.push({ code: "thin", front: f.n, back: b.n, left }); continue; }
        const over = -left;
        const tab = Math.max(f.tabH > 0 ? f.tabH - over : -Infinity, b.tabH > 0 ? b.tabH - over : -Infinity);
        if (tab === -Infinity) out.push({ code: "loose", front: f.n, back: b.n, left: 0 });
        else if (tab < MIN_TAB) out.push({ code: "tabsThin", front: f.n, back: b.n, left: Math.max(0, tab) });
        continue;
      }
      if (fThrough || bThrough) continue;          // one of them goes through on purpose
      out.push({ code: left > EPS ? "thin" : "through", front: f.n, back: b.n, left: Math.max(0, left) });
    }
  }
  return out;
}

/** Deepest cut of the other side at this shape (0 = none) – what a through cut may subtract */
export function otherSideDepth(shape: Removal, others: Removal[]): number {
  let d = 0;
  for (const o of others) {
    if (o.side === shape.side) continue;
    if (sharedShare(shape, o) > 0.95) d = Math.max(d, o.depth);
  }
  return d;
}

/** Overcut of a through cut: a little more than needed so no skin stays */
export const THROUGH_EXTRA = 0.2;

/** Depth (positive mm) that just cuts through when the other side already removed `otherDepth` at the same place */
export function throughDepth(T: number, otherDepth: number, extra = THROUGH_EXTRA): number {
  return Math.max(0, T - Math.max(0, otherDepth)) + extra;
}
