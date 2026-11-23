// Tests for splitting an oversized part into pieces with joints (seams) – run with `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Polygon } from "polygon-clipping";
import {
  splitDrawing, seamProfile, seamPath, defaultSeam, cleanSplit, pieceName, gridSeams, fitGrid, splitFingerprint, minCurveRadius,
  clipLine, areaOf, inArea, type Seam, type SplitOptions, type SplitSetup, type Feature, type Piece,
} from "../src/seamSplit.ts";
import { offsetArea, type XY } from "../src/joints.ts";
import { offsetPolygon, pointInPoly, polygonArea } from "../src/polyOffset.ts";
import { pocketWallPaths } from "../src/pocket.ts";
import { assemblySvg } from "../src/splitSheet.ts";
import { sheetHtml, SHEET_CSS } from "../src/setupSheet.ts";
import { createPolyline, createCircle, MM_TO_PIXEL as PX } from "../src/shapeTransform.ts";

const near = (a: number, b: number, tol: number, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≠ ${b} (±${tol})`);
const px = (pts: [number, number][]) => pts.map(([x, y]) => ({ x: x * PX, y: y * PX }));
const rectShape = (x0: number, y0: number, x1: number, y1: number, mode: string, extra: Record<string, any> = {}) =>
  createPolyline(px([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]), true, mode, extra);
const circle = (x: number, y: number, r: number, mode: string, extra: Record<string, any> = {}) => ({ ...createCircle(x * PX, y * PX, r * PX, mode), ...extra });

/** 6 mm end mill for everything */
const opts = (bedW = 250, bedH = 200, dia = 6): SplitOptions => ({ bed: { w: bedW, h: bedH }, radiusOf: () => dia / 2 });
const seam = (pos: number, over: Partial<Seam> = {}): Seam => ({ ...defaultSeam("x", pos), ...over });
const setup = (...seams: Seam[]): SplitSetup => ({ id: "t", seams });

/** shape (world pixels) → polygon in mm */
const poly = (s: any): Polygon => [[...s.points.map((p: any) => [p.x / PX, p.y / PX] as [number, number]), [s.points[0].x / PX, s.points[0].y / PX]]];
const outline = (p: Piece) => p.shapes.find(s => s.millingMode === "outside" && s.noIsland);
const piece = (r: { pieces: Piece[] }, name: string) => r.pieces.find(p => p.name === name)!;

/**
 * The "done" drawing: plate 400 × 150 mm (twice as wide as a 250 mm bed can take with the cutter path),
 * cut out 12 mm deep, a pocket 60…340 × 55…95 (5 mm deep) across the middle and four 8 mm holes.
 */
function plate() {
  return [
    rectShape(0, 0, 400, 150, "outside", { millingDepth: -12 }),
    rectShape(60, 55, 340, 95, "pocket", { millingDepth: -5 }),
    circle(30, 30, 4, "inside", { millingDepth: -12 }),
    circle(370, 30, 4, "inside", { millingDepth: -12 }),
    circle(30, 120, 4, "inside", { millingDepth: -12 }),
    circle(370, 120, 4, "inside", { millingDepth: -12 }),
  ];
}

// ---------------------------------------------------------------------
// Names and stored data
// ---------------------------------------------------------------------

test("piece names: column letter from the left, row number from the top", () => {
  assert.equal(pieceName(0, 0), "A1");
  assert.equal(pieceName(1, 0), "B1");
  assert.equal(pieceName(0, 1), "A2");
  assert.equal(pieceName(25, 2), "Z3");
  assert.equal(pieceName(26, 0), "AA1");
});

test("stored setup is cleaned: unknown joints fall back, numbers are clamped, broken seams are dropped", () => {
  const s = cleanSplit({ id: "ab-1", seams: [{ axis: "x", pos: 10, joint: "nonsense", size: -5, clearance: 99 }, { axis: "z", pos: 1 }, { axis: "y", pos: "x" }] })!;
  assert.equal(s.seams.length, 1);
  assert.equal(s.seams[0].joint, "puzzle");
  assert.equal(s.seams[0].size, 1);
  assert.equal(s.seams[0].clearance, 5);
  assert.equal(cleanSplit(null), null);
  assert.equal(cleanSplit({ seams: "no" }), null);
});

// ---------------------------------------------------------------------
// Joint shape and cutter radius – numbers worked out by hand
// ---------------------------------------------------------------------

test("no curve of a joint is tighter than the cutter: 6 mm cutter → 3.5 mm", () => {
  near(minCurveRadius(6), 3.5, 1e-12);
  near(minCurveRadius(0), 0.2, 1e-12);
});

test("puzzle knob 24 mm, 6 mm cutter: neck 13.44 mm, fillets 3.84 mm, reaches 24.3 mm over the seam", () => {
  const p = seamProfile(seam(200), 6);
  assert.equal(p.errors.length, 0);
  near(p.R, 12, 1e-12);
  near(p.rho, 3.84, 1e-12);            // 16 % of the head, more than the 3.5 mm the cutter needs
  near(p.w, 6.72 + 3.84, 1e-12);       // half neck 6.72 + fillet
  // head centre: fillet (10.56 | 3.84) and head (0 | h) touch → h = 3.84 + √(15.84² − 10.56²) = 3.84 + 11.806
  near(p.h, 3.84 + Math.sqrt(15.84 ** 2 - 10.56 ** 2), 1e-12);
  near(p.reach, 27.646, 0.001);
});

test("a knob the cutter cannot get into is refused with the smallest size that works", () => {
  // opening = 0.56 × 10 + 2 × 0.1 = 5.8 mm < 6.2 mm → smallest head (6.2 − 0.2) / 0.56 = 10.72 → 10.8
  const p = seamProfile(seam(200, { size: 10 }), 6);
  assert.deepEqual(p.errors.map(e => [e.code, e.v]), [["knobSmall", 10.8]]);
  // with the same knob a 3 mm cutter is fine
  assert.equal(seamProfile(seam(200, { size: 10 }), 3).errors.length, 0);
});

test("fingers narrower than two curve radii are refused: 6 mm cutter → 7 mm", () => {
  const p = seamProfile(seam(200, { joint: "finger", size: 6, depth: 10 }), 6);
  assert.deepEqual(p.errors.map(e => [e.code, e.v]), [["fingerSmall", 7]]);
  assert.equal(seamProfile(seam(200, { joint: "finger", size: 20, depth: 10 }), 6).errors.length, 0);
});

test("clearance too large for the joint is refused", () => {
  // knob 24: the head must stay wider than the opening → (1 − 0.56) × 24 / 4 − 0.05 = 2.59
  const p = seamProfile(seam(200, { clearance: 3 }), 6);
  assert.deepEqual(p.errors.map(e => [e.code, e.v]), [["clearBig", 2.59]]);
});

/** smallest radius of curvature along a polyline of the dividing curve (three-point circle), ignoring straight runs */
function tightest(pts: XY[]): number {
  let best = Infinity;
  for (let i = 1; i + 1 < pts.length; i++) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    // only inside an arc: both chords short and about equal (a straight piece next to an arc is not a curve)
    if (cross < 1e-9 || ab > 1.2 || bc > 1.2 || Math.abs(ab - bc) > 0.02 * ab) continue;
    best = Math.min(best, (ab * bc * ca) / (2 * cross));
  }
  return best;
}

test("dividing curve: both edges are true parallels – tightest curve is radius − clearance, never below the cutter radius on the hollow side", () => {
  for (const s of [seam(0), seam(0, { joint: "finger", size: 20, depth: 12 })]) {
    const p = seamProfile(s, 6);
    const feats: Feature[] = s.joint === "puzzle" ? [{ kind: "knob", m: 50, dir: 1 }, { kind: "knob", m: 120, dir: -1 }] : [{ kind: "run", s: 40, n: 4 }];
    const mid = seamPath(p, feats, 0, 0, 200), a = seamPath(p, feats, -0.1, 0, 200), b = seamPath(p, feats, 0.1, 0, 200);
    // centre curve: tightest arc = the fillet radius
    near(tightest(mid), p.rho, 0.02, s.joint);
    // each edge: the arcs become 0.1 smaller on the bulging side and 0.1 larger on the hollow side
    near(tightest(a), p.rho - 0.1, 0.02, s.joint + " A");
    near(tightest(b), p.rho - 0.1, 0.02, s.joint + " B");
    assert.ok(p.rho - 0.1 > 0, "bulging arcs keep a radius");
    // every point of edge A is exactly 0.2 mm from edge B (gap = 2 × clearance), all along the joint
    for (const q of a.filter((_, i) => i % 3 === 0)) {
      let d = Infinity;
      for (let i = 1; i < b.length; i++) {
        const ax = b[i - 1][0], ay = b[i - 1][1], dx = b[i][0] - ax, dy = b[i][1] - ay, l2 = dx * dx + dy * dy;
        const t = Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - ay) * dy) / l2));
        d = Math.min(d, Math.hypot(q[0] - ax - t * dx, q[1] - ay - t * dy));
      }
      near(d, 0.2, 0.012, s.joint + " gap");
    }
  }
});

test("a finger run ends on the seam line again and alternates +D/2 and −D/2", () => {
  const p = seamProfile(seam(0, { joint: "finger", size: 20, depth: 12 }), 6);
  const pts = seamPath(p, [{ kind: "run", s: 40, n: 3 }], 0, 0, 200);
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts[pts.length - 1], [200, 0]);
  const at = (u: number) => pts.reduce((best, q) => (Math.abs(q[0] - u) < Math.abs(best[0] - u) ? q : best))[1];
  near(at(50), 6, 1e-9);    // first finger belongs to A: +6
  near(at(70), -6, 1e-9);   // second to B: −6
  near(at(90), 6, 1e-9);
  near(at(20), 0, 1e-9);
  near(at(120), 0, 1e-9);
});

// ---------------------------------------------------------------------
// The whole job: plate 400 × 150, one seam with a puzzle joint
// ---------------------------------------------------------------------

test("plate twice as wide as the bed: two pieces A1 and B1, both fit, nothing is refused", () => {
  const r = splitDrawing(plate(), setup(seam(200)), opts());
  assert.equal(r.ok, true);
  assert.deepEqual(r.pieces.map(p => p.name), ["A1", "B1"]);
  assert.deepEqual(r.issues, []);
  assert.equal(r.toolDia, 6);
  for (const p of r.pieces) assert.equal(p.fits, true, p.name);
  // 150 mm of material, default spacing 120 → one knob, in the middle
  assert.deepEqual(r.seams[0].feats, [{ kind: "knob", m: 75, dir: 1 }]);
  // A1 carries the knob: 200 + 27.646 − 0.1 clearance, plus the 6 mm cutter path all round
  const a = piece(r, "A1").extent!, b = piece(r, "B1").extent!;
  near(a.minX, -6, 1e-6); near(a.maxX, 200 + 27.646 - 0.1 + 6, 0.01);
  near(a.minY, -6, 1e-6); near(a.maxY, 156, 1e-6);
  near(b.minX, 200 + 0.1 - 6, 0.01); near(b.maxX, 406, 1e-6);
});

test("without the split the plate does not fit the bed, and the helper finds 2 × 1", () => {
  const whole = splitDrawing(plate(), setup(), opts());
  assert.deepEqual(whole.pieces.map(p => [p.name, p.fits]), [["A1", false]]);
  assert.deepEqual(whole.issues.map(i => [i.code, i.piece, i.w, i.h]), [["noFit", "A1", 412, 162]]);
  const g = fitGrid(plate(), defaultSeam(), opts())!;
  assert.deepEqual([g.cols, g.rows], [2, 1]);
  assert.deepEqual(g.seams.map(s => [s.axis, s.pos]), [["x", 200]]);
  // a bed of 150 × 100 needs more: every piece must fit with its knobs and the cutter path
  const small = fitGrid(plate(), defaultSeam(), opts(150, 100))!;
  const r = splitDrawing(plate(), setup(...small.seams), opts(150, 100));
  assert.ok(r.pieces.length >= 6);
  assert.ok(r.pieces.every(p => p.fits));
});

test("the pieces together are the plate minus a gap of 2 × clearance along the joint", () => {
  const r = splitDrawing(plate(), setup(seam(200)), opts());
  const a = piece(r, "A1").region, b = piece(r, "B1").region;
  near(areaOf(polygonClipping.intersection(a, b)), 0, 1e-9, "overlap");
  // length of the dividing curve inside the plate, by hand: 150 mm minus the knob's foot (2 × 10.56), plus the two
  // fillets (radius 3.84, angle α + 90°) and the head (radius 12, angle 180° + 2α), α = atan(11.806 / 10.56) = 48.19°
  const al = Math.atan2(Math.sqrt(15.84 ** 2 - 10.56 ** 2), 10.56);
  const len = 150 - 2 * 10.56 + 2 * 3.84 * (al + Math.PI / 2) + 12 * (Math.PI + 2 * al);
  near(len, 205.28, 0.01, "length");
  // gap = length × 2 × clearance (the edges are true parallels of the curve)
  near(areaOf(a) + areaOf(b), areaOf(r.part) - len * 0.2, 0.05, "area");
});

test("fit: each piece grown by the clearance meets the other exactly – no overlap, no gap wider than the clearance", () => {
  for (const s of [seam(200), seam(200, { joint: "finger", size: 20, depth: 12 }), seam(200, { clearance: 0.25, alternate: false, count: 2, size: 20 })]) {
    const c = s.clearance;
    const r = splitDrawing(plate(), setup(s), opts());
    assert.equal(r.ok, true, s.joint);
    const a = piece(r, "A1").region, b = piece(r, "B1").region;
    const ga = offsetArea(a, c), gb = offsetArea(b, c);
    // band around the joint, well inside the plate (the outer edge grows too, that is not the joint)
    const band: Polygon = [[[150, 10], [250, 10], [250, 140], [150, 140], [150, 10]]];
    const over = areaOf(polygonClipping.intersection(ga, gb, band));
    const gap = areaOf(polygonClipping.difference(band, ga, gb));
    const len = 130 + 60; // rough joint length in the band: 130 mm plus the detour round the knobs/fingers
    // both are slivers from turning arcs into short lines: far below a strip of 0.02 mm along the joint
    assert.ok(over < 0.02 * len, `${s.joint}: overlap ${over}`);
    assert.ok(gap < 0.02 * len, `${s.joint}: gap ${gap}`);
    // and without growing there is a real gap of about 2 × clearance × length
    const open = areaOf(polygonClipping.difference(band, a, b));
    assert.ok(open > 2 * c * 130 * 0.95, `${s.joint}: open ${open}`);
    // grown by a little less than the clearance the pieces must not touch anywhere
    near(areaOf(polygonClipping.intersection(offsetArea(a, c - 0.03), offsetArea(b, c - 0.03), band)), 0, 1e-9, "touch");
  }
});

/** farthest any outline point is from the path of the cutter centre (outline moved out by the cutter radius, as cam.ts does) */
function farthestFromCutter(ring: { x: number; y: number }[], r: number): number {
  const path = offsetPolygon(ring, r, 0.002);
  let worst = 0;
  for (const q of ring) {
    let d = Infinity;
    for (const loop of path) for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const ax = loop[j].x, ay = loop[j].y, dx = loop[i].x - ax, dy = loop[i].y - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((q.x - ax) * dx + (q.y - ay) * dy) / l2)) : 0;
      d = Math.min(d, Math.hypot(q.x - ax - t * dx, q.y - ay - t * dy));
    }
    worst = Math.max(worst, d);
  }
  return worst;
}

test("cutter radius: a 6 mm cutter reaches every point of every piece outline (nothing is left standing in a corner)", () => {
  for (const s of [seam(200), seam(200, { joint: "finger", size: 20, depth: 12 }), seam(200, { size: 11, count: 3 })]) {
    const r = splitDrawing(plate(), setup(s), opts());
    assert.equal(r.ok, true);
    for (const p of r.pieces) {
      const ring = outline(p).points.map((q: any) => ({ x: q.x / PX, y: q.y / PX }));
      // the cutter centre runs 3 mm outside: every outline point must be exactly one radius from that path
      near(farthestFromCutter(ring, 3), 3, 0.01, `${s.joint} ${p.name}`);
    }
  }
  // the check itself: in a sharp inside corner the cutter stays 3 × √2 = 4.24 mm away
  near(farthestFromCutter([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 40 }, { x: 0, y: 40 }], 3), 3 * Math.SQRT2, 0.01);
});

// ---------------------------------------------------------------------
// Operations at a seam
// ---------------------------------------------------------------------

test("holes that no seam touches stay circles in the piece they lie in", () => {
  const r = splitDrawing(plate(), setup(seam(200)), opts());
  const circles = (p: Piece) => p.shapes.filter(s => s.type === "circle").map(s => [s.x / PX, s.y / PX, s.w / PX, s.millingMode]);
  assert.deepEqual(circles(piece(r, "A1")), [[30, 30, 4, "inside"], [30, 120, 4, "inside"]]);
  assert.deepEqual(circles(piece(r, "B1")), [[370, 30, 4, "inside"], [370, 120, 4, "inside"]]);
  // and they are not emitted a second time as new outlines
  for (const p of r.pieces) assert.equal(p.shapes.filter(s => s.millingMode === "inside").length, 2, p.name);
  // new objects: the original drawing is untouched and ids are new
  const src = plate();
  const again = splitDrawing(src, setup(seam(200)), opts());
  assert.equal(src.length, 6);
  assert.ok(again.pieces.flatMap(p => p.shapes).every(s => !src.some(o => o.id === s.id)));
});

test("a pocket across the seam is cut in both pieces, a cutter diameter past the piece → centre one radius past the joint", () => {
  const r = splitDrawing(plate(), setup(seam(200)), opts());
  const pocket = (p: Piece) => p.shapes.filter(s => s.millingMode === "pocket");
  const a = pocket(piece(r, "A1")), b = pocket(piece(r, "B1"));
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  for (const s of [...a, ...b]) { assert.equal(s.millingDepth, -5); assert.equal(s.closed, true); }
  const xs = (s: any) => s.points.map((q: any) => q.x / PX), ys = (s: any) => s.points.map((q: any) => q.y / PX);
  // left piece: from the pocket's own wall at 60 to 6 mm past the knob tip (227.546 + 6)
  near(Math.min(...xs(a[0])), 60, 1e-9);
  near(Math.max(...xs(a[0])), 200 + 27.646 - 0.1 + 6, 0.02);
  // right piece: from 6 mm before its edge (200.1 − 6) to the wall at 340
  near(Math.min(...xs(b[0])), 200.1 - 6, 0.02);
  near(Math.max(...xs(b[0])), 340, 1e-9);
  for (const s of [...a, ...b]) { near(Math.min(...ys(s)), 55, 1e-9); near(Math.max(...ys(s)), 95, 1e-9); }
  // what a 6 mm cutter really clears (pocket opened with the cutter radius) covers the pocket inside each piece
  const want: Polygon = [[[60, 55], [340, 55], [340, 95], [60, 95], [60, 55]]];
  for (const [p, s] of [[piece(r, "A1"), a[0]], [piece(r, "B1"), b[0]]] as [Piece, any][]) {
    const cleared = offsetArea(offsetArea([poly(s)], -3), 3);
    const inPiece = polygonClipping.intersection([want], p.region);
    // only the pocket's own four corners keep their radius, as in the unsplit drawing: 2 per piece × 1.93 mm²
    const missed = areaOf(polygonClipping.difference(inPiece, cleared));
    near(missed, 2 * (1 - Math.PI / 4) * 9, 0.1, p.name + " missed");
    // nothing is missed at the joint: within 20 mm of the seam the pocket is cleared completely
    const atJoint: Polygon = [[[180, 50], [240, 50], [240, 100], [180, 100], [180, 50]]];
    near(areaOf(polygonClipping.difference(polygonClipping.intersection(inPiece, atJoint), cleared)), 0, 1e-6, p.name + " at joint");
  }
  // the outline of a piece is marked so the pocket never takes it for an island
  for (const p of r.pieces) assert.equal(outline(p).noIsland, true);
});

test("an engraved line across the seam ends one cutter radius behind the joint in both pieces", () => {
  const line = createPolyline(px([[100, 20], [300, 20]]), false, "on-line", { millingDepth: -1 });
  const r = splitDrawing([...plate(), line], setup(seam(200)), opts());
  const part = (p: Piece) => p.shapes.filter(s => s.millingMode === "on-line").map(s => s.points.map((q: any) => +(q.x / PX).toFixed(3)));
  // at y = 20 the joint is straight: piece edges at 199.9 and 200.1, each line runs 3 mm further
  assert.deepEqual(part(piece(r, "A1")), [[100, 202.9]]);
  assert.deepEqual(part(piece(r, "B1")), [[197.1, 300]]);
});

test("a closed engraved contour across the seam becomes open lines, not a contour along the joint", () => {
  const ring = rectShape(150, 100, 250, 140, "on-line", { millingDepth: -1 });
  const r = splitDrawing([...plate(), ring], setup(seam(200, { joint: "butt" })), opts());
  for (const p of r.pieces) {
    const lines = p.shapes.filter(s => s.millingMode === "on-line");
    assert.equal(lines.length, 1, p.name);
    assert.equal(lines[0].closed, false);
    // no point of it runs along the joint: every x is on the original rectangle or 3 mm behind the seam
    for (const q of lines[0].points) assert.ok([150, 250, 203, 197].some(x => Math.abs(q.x / PX - x) < 1e-6), `${p.name}: x ${q.x / PX}`);
  }
});

test("a drilled hole on the seam is in neither piece and is reported with its place; one beside it stays", () => {
  const onSeam = circle(200, 20, 3, "drill", { millingDepth: -12 }), beside = circle(190, 130, 3, "drill", { millingDepth: -12 });
  const r = splitDrawing([...plate(), onSeam, beside], setup(seam(200, { joint: "butt" })), opts());
  assert.deepEqual(r.issues, [{ code: "drill", level: "warn", n: 1, x: 200, y: 20 }]);
  const drills = (p: Piece) => p.shapes.filter(s => s.millingMode === "drill").map(s => [s.x / PX, s.y / PX]);
  assert.deepEqual(drills(piece(r, "A1")), [[190, 130]]);
  assert.deepEqual(drills(piece(r, "B1")), []);
});

test("a hole 3.4 mm from the joint edge is still whole; cut by the joint it is left out", () => {
  // 6 mm drill needs 3 + 0.5 mm: centre at 196.4 → 3.6 mm from the edge at 200 → stays in A1
  const ok = splitDrawing([...plate(), circle(196.4, 20, 3, "drill")], setup(seam(200, { joint: "butt" })), opts());
  assert.equal(ok.issues.length, 0);
  const cut = splitDrawing([...plate(), circle(196.6, 20, 3, "drill")], setup(seam(200, { joint: "butt" })), opts());
  assert.deepEqual(cut.issues.map(i => i.code), ["drill"]);
});

test("further operations: a whole shape keeps them, a split contour loses its chamfer with a warning", () => {
  const whole = rectShape(20, 60, 50, 90, "pocket", { millingDepth: -3, ops: [{ kind: "chamfer", depth: 0, chamferW: 1 }] });
  const split = rectShape(150, 100, 250, 140, "pocket", { millingDepth: -3, ops: [{ kind: "chamfer", depth: 0, chamferW: 1 }] });
  const r = splitDrawing([rectShape(0, 0, 400, 150, "outside", { millingDepth: -12 }), whole, split], setup(seam(200, { joint: "butt" })), opts());
  assert.deepEqual(r.issues, [{ code: "chamfer", level: "warn", n: 1 }]);
  const a = piece(r, "A1").shapes.filter(s => s.millingMode === "pocket");
  assert.equal(a.length, 2);
  assert.equal(a.filter(s => Array.isArray(s.ops) && s.ops.length === 1).length, 1);
});

test("a through cut-out across the seam becomes a notch in both outlines and is reported", () => {
  const win = rectShape(170, 100, 230, 130, "inside", { millingDepth: -12 });
  const r = splitDrawing([rectShape(0, 0, 400, 150, "outside", { millingDepth: -12 }), win], setup(seam(200, { joint: "butt" })), opts());
  assert.deepEqual(r.issues, [{ code: "hole", level: "warn", seam: 0, n: 1 }]);
  for (const p of r.pieces) {
    assert.equal(p.shapes.length, 1, p.name);       // one outline, no separate hole
    near(areaOf(p.region), 200 * 150 - 30 * 30, 1e-6, p.name);
  }
});

test("a contour that is not cut through (shallower than the outline) is not a hole: the plate stays in one piece there", () => {
  // raised field: contour 'outside' only 3 mm deep inside a 12 mm plate
  const boss = rectShape(170, 100, 230, 130, "outside", { millingDepth: -3 });
  const r = splitDrawing([rectShape(0, 0, 400, 150, "outside", { millingDepth: -12 }), boss], setup(seam(200, { joint: "butt" })), opts());
  assert.deepEqual(r.issues, []);
  for (const p of r.pieces) {
    near(areaOf(p.region), 200 * 150, 1e-6, p.name);
    const shallow = p.shapes.filter(s => s.millingDepth === -3);
    assert.equal(shallow.length, 1);
    assert.equal(shallow[0].millingMode, "outside");
    assert.equal(shallow[0].closed, true);
  }
});

test("an island inside a pocket that lies on the seam is still an island in both pieces, with the pocket's pass along it", () => {
  // pocket 60…340 × 30…120, raised field 170…230 × 50…100 (contour 'outside', as deep as the pocket) right on the seam
  const src = [
    rectShape(0, 0, 400, 150, "outside", { millingDepth: -12 }),
    rectShape(60, 30, 340, 120, "pocket", { millingDepth: -4 }),
    rectShape(170, 50, 230, 100, "outside", { millingDepth: -4 }),
  ];
  const r = splitDrawing(src, setup(seam(200, { joint: "finger", size: 20, depth: 12 })), opts(250, 200, 3));
  assert.deepEqual(r.issues, []);
  for (const p of r.pieces) {
    const pocket = p.shapes.find(s => s.millingMode === "pocket"), boss = p.shapes.find(s => s.millingMode === "outside" && s.millingDepth === -4);
    const mm = (s: any) => s.points.map((q: any) => ({ x: q.x / PX, y: q.y / PX }));
    const P = mm(pocket), Bo = mm(boss);
    // cam.ts: island = smaller closed shape whose first point lies in the pocket
    assert.ok(pointInPoly(Bo[0].x, Bo[0].y, P), `${p.name}: first point of the field lies in the pocket`);
    assert.ok(Math.abs(polygonArea(Bo)) < Math.abs(polygonArea(P)));
    // the pocket's finishing pass runs along the field's own edges at the cutter radius (1.5 mm): above its top edge
    // (y = 100) there must be a path at y = 101.5, on the side of the seam this piece lies on
    const x = p.name === "A1" ? 180 : 220;
    const paths = pocketWallPaths(P, [Bo], 1.5);
    const hit = paths.some(w => w.pts.some((q, i) => i > 0 && Math.abs(q.y - 101.5) < 1e-6 && Math.abs(w.pts[i - 1].y - 101.5) < 1e-6 && Math.min(q.x, w.pts[i - 1].x) <= x && Math.max(q.x, w.pts[i - 1].x) >= x));
    assert.ok(hit, `${p.name}: pass along the field at X${x} Y101.5`);
  }
});

// ---------------------------------------------------------------------
// Where joints may sit
// ---------------------------------------------------------------------

test("joints keep away from holes: a knob that would hit a cut-out moves aside or is left out with a warning", () => {
  // window right where the single knob would sit (y = 75)
  const win = rectShape(205, 60, 225, 90, "inside", { millingDepth: -12 });
  const base = rectShape(0, 0, 400, 150, "outside", { millingDepth: -12 });
  const r = splitDrawing([base, win], setup(seam(200)), opts());
  const k = r.seams[0].feats;
  assert.equal(k.length, 1);
  assert.ok(k[0].kind === "knob" && Math.abs(k[0].m - 75) > 25, "moved away from the window");
  // the knob with its 6 mm rim does not touch the window
  const a = piece(r, "A1").region;
  assert.equal(inArea(a, 215, 75), false);
  // no place at all: window along the whole joint
  const long = rectShape(205, 10, 225, 140, "inside", { millingDepth: -12 });
  const none = splitDrawing([base, long], setup(seam(200, { alternate: false })), opts());
  assert.deepEqual(none.seams[0].feats, []);
  assert.deepEqual(none.issues.map(i => [i.code, i.n ?? null]), [["noRoom", 1], ["plain", null]]);
});

test("thin part: a 20 mm bridge across the seam gets no joint and is reported with its width", () => {
  // H-shaped part: two blocks joined by a 20 mm bridge at the seam
  const h = createPolyline(px([[0, 0], [150, 0], [150, 65], [250, 65], [250, 0], [400, 0], [400, 150], [250, 150], [250, 85], [150, 85], [150, 150], [0, 150]]), true, "outside", { millingDepth: -12 });
  const r = splitDrawing([h], setup(seam(200)), opts());
  assert.deepEqual(r.seams[0].feats, []);
  assert.deepEqual(r.issues, [{ code: "shortSpan", level: "warn", seam: 0, n: 1, v: 20 }, { code: "plain", level: "warn", seam: 0 }]);
});

test("crossing seams: four pieces, no joint within reach of the crossing, names by column and row", () => {
  const r = splitDrawing([rectShape(0, 0, 400, 300, "outside", { millingDepth: -12 })], setup(seam(200), { ...defaultSeam("y", 150) }), opts());
  assert.equal(r.ok, true);
  // top row is 1: A1 is top left (y > 150), A2 bottom left
  assert.deepEqual(r.pieces.map(p => p.name), ["A1", "B1", "A2", "B2"]);
  assert.ok(inArea(piece(r, "A1").region, 50, 250));
  assert.ok(inArea(piece(r, "B2").region, 350, 50));
  // every knob keeps its whole width plus the other joint's reach away from the crossing
  for (const l of r.seams) {
    const cross = l.seam.axis === "x" ? 150 : 200;
    for (const f of l.feats) assert.ok(f.kind === "knob" && Math.abs(f.m - cross) > l.profile.halfW + l.profile.reach, `${l.seam.axis}: ${JSON.stringify(f)}`);
  }
  // pieces do not overlap and lose only the gaps
  let sum = 0;
  for (const p of r.pieces) sum += areaOf(p.region);
  assert.ok(sum < 400 * 300 && sum > 400 * 300 - 200, `area ${sum}`);
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) near(areaOf(polygonClipping.intersection(r.pieces[i].region, r.pieces[j].region)), 0, 1e-9);
});

test("two seams too close for their joints are refused with the distance needed", () => {
  const r = splitDrawing(plate(), setup(seam(180), seam(220)), opts());
  assert.equal(r.ok, false);
  // 27.646 + 0.1 on each seam plus 6 mm between → 61.5 → 62
  assert.deepEqual(r.issues.filter(i => i.level === "error"), [{ code: "close", level: "error", seam: 1, v: 62 }]);
});

test("a drawing without a cut-out outline cannot be split", () => {
  const r = splitDrawing([rectShape(0, 0, 400, 150, "pocket")], setup(seam(200)), opts());
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues, [{ code: "noOutline", level: "error" }]);
});

test("butt joint: straight cut exactly on the seam, no clearance", () => {
  const r = splitDrawing(plate(), setup(seam(200, { joint: "butt", clearance: 0.3 })), opts());
  near(areaOf(piece(r, "A1").region) + areaOf(piece(r, "B1").region), areaOf(r.part), 1e-6);
  const a = outline(piece(r, "A1"));
  near(Math.max(...a.points.map((q: any) => q.x / PX)), 200, 1e-9);
});

test("outline settings are inherited: tool, depth, holding tabs and onion skin", () => {
  const src = plate();
  Object.assign(src[0], { toolId: "t9", tabN: 4, tabLen: 6, tabH: 2, skinH: 0.4, tabMode: "manual", tabPts: [0.1] });
  const r = splitDrawing(src, setup(seam(200)), opts());
  for (const p of r.pieces) {
    const s = outline(p);
    assert.deepEqual([s.toolId, s.millingDepth, s.tabN, s.tabLen, s.tabH, s.skinH], ["t9", -12, 4, 6, 2, 0.4], p.name);
    // hand-placed tabs belonged to the old outline: the piece places them automatically
    assert.equal(s.tabMode, undefined);
    assert.equal(s.tabPts, undefined);
  }
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

test("even seams: 3 columns and 2 rows over 400 × 150", () => {
  const s = gridSeams({ minX: 0, minY: 0, maxX: 400, maxY: 150 }, 3, 2, defaultSeam());
  assert.deepEqual(s.map(x => [x.axis, x.pos]), [["x", 133.33], ["x", 266.67], ["y", 75]]);
});

test("clipLine keeps exactly the parts inside the area", () => {
  const sq: MultiPolygon = [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]];
  assert.deepEqual(clipLine([[-5, 5], [15, 5]], sq), [[[0, 5], [10, 5]]]);
  assert.deepEqual(clipLine([[2, 2], [8, 2], [8, 8]], sq), [[[2, 2], [8, 2], [8, 8]]]);
  assert.deepEqual(clipLine([[-5, -5], [-1, -1]], sq), []);
  // in, out, in again
  assert.deepEqual(clipLine([[5, 5], [5, 15], [8, 15], [8, 5]], sq), [[[5, 5], [5, 10]], [[8, 10], [8, 5]]]);
});

test("fingerprint changes with the drawing and the seams, not with ids", () => {
  const a = plate(), b = plate();
  const s = setup(seam(200));
  assert.equal(splitFingerprint(a, s), splitFingerprint(b, s));
  assert.notEqual(splitFingerprint(a, s), splitFingerprint(a, setup(seam(201))));
  b[1].millingDepth = -6;
  assert.notEqual(splitFingerprint(a, s), splitFingerprint(b, s));
  assert.notEqual(splitFingerprint(a, s, "6"), splitFingerprint(a, s, "8"));
});

// ---------------------------------------------------------------------
// Setup sheet: assembly page
// ---------------------------------------------------------------------

test("assembly picture: every piece with its name, the piece of this sheet highlighted, Y flipped for the page", () => {
  const r = splitDrawing(plate(), setup(seam(200)), opts());
  const svg = assemblySvg(r.pieces, "B1");
  assert.equal((svg.match(/<path /g) || []).length, 2);
  assert.deepEqual([...svg.matchAll(/<text [^>]*font-weight="(\w+)"[^>]*>([A-Z0-9]+)<\/text>/g)].map(m => [m[2], m[1]]), [["A1", "normal"], ["B1", "bold"]]);
  assert.equal((svg.match(/#ffd58a/g) || []).length, 1);
  // plate 400 × 150 with 3 % (12 mm) rim → view box −12 −12 424 174
  assert.ok(svg.includes('viewBox="-12 -12 424 174"'), svg.slice(0, 120));
  // the lower left corner of the plate (0|0) is drawn at the bottom: y = 150
  assert.ok(/M0 150L/.test(svg) || /L0 150[LZ]/.test(svg));
  assert.equal(assemblySvg([], null), "");
});

test("assembly page in the sheet: texts are escaped, the picture is kept, the page starts on a new sheet", () => {
  const evil = `<img src=x onerror=alert(1)>`;
  const base = { title: "T", date: "D", tools: [], toolsNote: "", stock: "", partSize: "", time: "", timeBasis: "", zero: "", zeroZ: "", wcs: "", ops: [], changes: [], warnings: [], zones: [], svg: "" };
  const html = sheetHtml({ ...base, assembly: { title: "Assembly " + evil, intro: evil, svg: "<svg id=\"asm\"></svg>", head: ["Piece", "Size", "Joint"], rows: [["A1", "200 × 150", evil]], steps: ["one", evil], notes: [evil] } }, k => k);
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes('<svg id="asm"></svg>'));
  assert.ok(html.includes('<div class="asm">'));
  assert.ok(SHEET_CSS.includes(".setup-sheet .asm{break-before:page"));
  assert.ok(!sheetHtml(base, k => k).includes("asm"));
});
