// Tests for "Split a large part" in laser and plasma mode (kerf instead of a cutter radius) – run with `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Polygon } from "polygon-clipping";

// laserCam.ts / plasmaCam.ts run here for real (paths without extension, JSON without attribute, as under Vite)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith(".") && ctx.parentURL?.includes("/src/") && !/\.\w+$/.test(spec)) {
      const p = pathResolve(dirname(fileURLToPath(ctx.parentURL)), spec);
      if (existsSync(p + ".ts")) return { url: pathToFileURL(p + ".ts").href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.endsWith(".json")) return { format: "module", source: "export default " + readFileSync(fileURLToPath(url), "utf8"), shortCircuit: true };
    if (url.endsWith(".ts") && url.includes("/src/")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText
    };
    return next(url, ctx);
  }
});

const store = new Map<string, string>();
const g = globalThis as any;
g.localStorage ??= { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
g.window ??= { dispatchEvent() {}, addEventListener() {} };
g.CustomEvent ??= class { type: string; constructor(type: string) { this.type = type; } };
g.Event ??= class { type: string; constructor(type: string) { this.type = type; } };

const S = await import("../src/seamSplit.ts");
const B = await import("../src/splitBeam.ts");
const LL = await import("../src/laserLayers.ts");
const PC = await import("../src/plasmaCuts.ts");
const LC = await import("../src/laserCam.ts");
const PCam = await import("../src/plasmaCam.ts");
const { offsetArea } = await import("../src/joints.ts");
const { lintGcode } = await import("../src/gcodeLint.ts");
const { createPolyline, createCircle, MM_TO_PIXEL: PX } = await import("../src/shapeTransform.ts");
type Seam = import("../src/seamSplit.ts").Seam;
type Piece = import("../src/seamSplit.ts").Piece;
type SplitResult = import("../src/seamSplit.ts").SplitResult;

LL.initLaserLayers();   // L2 engrave (fill 50 %), L3 mark (line 30 % @ 1500), L1 cut (line 100 % @ 300) – L1 is the default layer
PC.initPlasmaCuts();    // P1: kerf 1.5 mm, lead-in 3 mm (default cut)

const near = (a: number, b: number, tol: number, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≠ ${b} (±${tol})`);
const px = (pts: [number, number][]) => pts.map(([x, y]) => ({ x: x * PX, y: y * PX }));
const rect = (x0: number, y0: number, x1: number, y1: number, extra: Record<string, any> = {}, mode = "outside") =>
  createPolyline(px([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]), true, mode, extra);
const line = (pts: [number, number][], extra: Record<string, any> = {}) => createPolyline(px(pts), false, "on-line", extra);
const circle = (x: number, y: number, r: number, extra: Record<string, any> = {}, mode = "inside") => ({ ...createCircle(x * PX, y * PX, r * PX, mode), ...extra });
const BED = { w: 250, h: 200 };
const seam = (pos: number, kind: "laser" | "plasma", over: Partial<Seam> = {}): Seam => ({ ...S.defaultSeam("x", pos, kind), ...over });
const piece = (r: { pieces: Piece[] }, name: string) => r.pieces.find(p => p.name === name)!;
const areaOf = S.areaOf;
const BAND: Polygon = [[[150, 10], [250, 10], [250, 140], [150, 140], [150, 10]]]; // around the joint, away from the outer edge
const shapeBox = (s: any) => ({ minX: s.x / PX, minY: s.y / PX, maxX: (s.x + s.w) / PX, maxY: (s.y + s.h) / PX });
const mmPoly = (s: any): Polygon => [[...s.points.map((p: any) => [p.x / PX, p.y / PX] as [number, number]), [s.points[0].x / PX, s.points[0].y / PX]]];

/** The pieces after cutting must meet exactly when each is grown by the clearance, and must not touch grown by a little less */
function assertFit(a: MultiPolygon, b: MultiPolygon, c: number, what: string) {
  const len = 130 + 60; // rough joint length in the band
  const ga = offsetArea(a, c), gb = offsetArea(b, c);
  const over = areaOf(polygonClipping.intersection(ga, gb, BAND)), gap = areaOf(polygonClipping.difference(BAND, ga, gb));
  assert.ok(over < 0.02 * len, `${what}: overlap ${over}`);
  assert.ok(gap < 0.02 * len, `${what}: gap ${gap}`);
  if (c > 0.04) near(areaOf(polygonClipping.intersection(offsetArea(a, c - 0.03), offsetArea(b, c - 0.03), BAND)), 0, 1e-9, `${what}: touch`);
  // and the real gap is about 2 × clearance along the joint
  const open = areaOf(polygonClipping.difference(BAND, a, b));
  assert.ok(open > 2 * c * 130 * 0.95 && open < 2 * c * 230 + 0.5, `${what}: open ${open}`);
}

/** every X/Y of the program lies on the bed */
function onBed(code: string) {
  for (const m of code.matchAll(/^G[0-3][^\n(]*?X(-?[\d.]+)[^\n(]*?Y(-?[\d.]+)/gm)) {
    const x = +m[1], y = +m[2];
    assert.ok(x >= -1e-6 && x <= BED.w + 1e-6 && y >= -1e-6 && y <= BED.h + 1e-6, `off the bed: ${m[0]}`);
  }
}

// =====================================================================
// LASER
// =====================================================================

/**
 * Plate 400 × 150 on the cut layer (default layer L1), four holes, an engraved area 60…340 × 55…95 with a blank window
 * 150…250 × 65…85 in it (fill layer L2, even-odd), a marked line at y = 30 and a marked frame (line layer L3).
 */
function laserPlate() {
  return [
    rect(0, 0, 400, 150),
    circle(30, 30, 4), circle(370, 30, 4), circle(30, 120, 4), circle(370, 120, 4),
    rect(60, 55, 340, 95, { laserLayerId: "L2" }),
    rect(150, 65, 250, 85, { laserLayerId: "L2" }),
    line([[20, 30], [380, 30]], { laserLayerId: "L3" }),
    rect(10, 10, 390, 140, { laserLayerId: "L3" }),
  ];
}
const laserSplit = (shapes: any[], seams: Seam[], kerf: number, cutLayers?: string[]) => {
  LL.setLaserSettings({ kerf });
  const setup = { id: "t", seams, ...(cutLayers ? { cutLayers } : {}) };
  return S.splitDrawing(shapes, setup, B.laserSplitOptions(shapes, setup, BED));
};

test("laser: the outline is the strongest line layer with a closed shape; ticking layers by hand overrides it", () => {
  const shapes = laserPlate();
  const auto = B.laserCutLayers(shapes, null);
  assert.equal(auto.auto, true);
  // the fill layer L2 cannot cut an outline; L3 (30 % at 1500) is weaker than L1 (100 % at 300)
  assert.deepEqual(auto.list.map(c => [c.id, c.on]), [["L3", false], ["L1", true]]);
  const hand = B.laserCutLayers(shapes, { cutLayers: ["L3"] });
  assert.equal(hand.auto, false);
  assert.deepEqual(hand.list.filter(c => c.on).map(c => c.id), ["L3"]);
  // a stored layer that no longer has a closed shape falls back to automatic
  assert.equal(B.laserCutLayers(shapes, { cutLayers: ["gone"] }).auto, true);
  // with the frame as outline the part is 380 × 130
  const r = laserSplit(shapes, [seam(200, "laser")], 0.2, ["L3"]);
  near(r.bounds!.maxX - r.bounds!.minX, 380, 1e-9);
  near(r.bounds!.maxY - r.bounds!.minY, 130, 1e-9);
});

test("laser: plate wider than the bed gives two pieces that fit, kerf 0.2 mm moves each joint edge 0.1 mm", () => {
  const whole = laserSplit(laserPlate(), [], 0.2);
  assert.equal(whole.pieces[0].fits, false, "400 mm does not fit a 250 mm bed");
  const r = laserSplit(laserPlate(), [seam(200, "laser")], 0.2);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.kind, "laser");
  near(r.toolDia, 0.2, 1e-12, "kerf");
  near(r.kerfShift, 0.1, 1e-12, "shift");
  assert.deepEqual(r.pieces.map(p => [p.name, p.fits]), [["A1", true], ["B1", true]]);
  assert.equal(r.issues.some(i => i.code === "kerf0"), false);
  // default clearance for a laser is 0.05 mm per side
  assert.equal(S.DEFAULT_CLEARANCE.laser, 0.05);
});

test("laser: after the beam took half a kerf off every edge the pieces are exactly 2 × clearance apart", () => {
  for (const [kerf, s] of [
    [0.2, seam(200, "laser")],                                              // clearance 0.05 < kerf/2: the drawings overlap
    [0.2, seam(200, "laser", { clearance: 0.2 })],                          // clearance > kerf/2: the drawings keep apart
    [0.15, seam(200, "laser", { joint: "finger", size: 20, depth: 12 })],
    [0.3, seam(200, "laser", { clearance: 0.1, alternate: false, count: 2, size: 20 })],
  ] as [number, Seam][]) {
    const r = laserSplit(laserPlate(), [s], kerf);
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    const a = piece(r, "A1").region, b = piece(r, "B1").region;
    // what is drawn: overlap when the clearance is smaller than half the kerf, never a gap wider than 2c − kerf
    const drawn = areaOf(polygonClipping.intersection(a, b, BAND));
    if (s.clearance < kerf / 2) assert.ok(drawn > (kerf - 2 * s.clearance) * 130 * 0.95, `drawn overlap ${drawn}`);
    else near(drawn, 0, 1e-9, "drawn overlap");
    // what is left after cutting: the beam runs on the line and removes half a kerf of each piece
    assertFit(offsetArea(a, -kerf / 2), offsetArea(b, -kerf / 2), s.clearance, `${s.joint} kerf ${kerf}`);
  }
});

test("laser: butt joint – each piece is drawn half a kerf past the seam, the cut edges meet on the seam", () => {
  const r = laserSplit(laserPlate(), [seam(200, "laser", { joint: "butt" })], 0.2);
  near(Math.max(...piece(r, "A1").region.flatMap(p => p[0].map(q => q[0]))), 200.1, 1e-9, "A1 right edge");
  near(Math.min(...piece(r, "B1").region.flatMap(p => p[0].map(q => q[0]))), 199.9, 1e-9, "B1 left edge");
});

test("laser: kerf not measured → no shift, edges at ± clearance, and a warning says the gap gets one kerf wider", () => {
  const r = laserSplit(laserPlate(), [seam(200, "laser", { joint: "butt" }), seam(100, "laser", { clearance: 0.05, axis: "y", joint: "butt" })], 0);
  assert.equal(r.kerfShift, 0);
  assert.equal(r.issues.filter(i => i.code === "kerf0").length, 1);
  assert.equal(r.ok, true);
  near(Math.max(...piece(r, "A1").region.flatMap(p => p[0].map(q => q[0]))), 200, 1e-9);
});

test("laser: engraved areas are clipped at the piece edge, the blank window stays blank (even-odd)", () => {
  const r = laserSplit(laserPlate(), [seam(200, "laser", { joint: "butt" })], 0.2);
  for (const [name, x0, x1] of [["A1", 60, 200.1], ["B1", 199.9, 340]] as [string, number, number][]) {
    const fills = piece(r, name).shapes.filter(s => s.laserLayerId === "L2");
    assert.equal(fills.length, 2, name);
    const big = fills.find(s => Math.abs(s.h / PX - 40) < 1e-6)!, win = fills.find(s => Math.abs(s.h / PX - 20) < 1e-6)!;
    near(shapeBox(big).minX, x0, 1e-9, name); near(shapeBox(big).maxX, x1, 1e-9, name);
    near(shapeBox(win).minX, Math.max(150, x0), 1e-9, name); near(shapeBox(win).maxX, Math.min(250, x1), 1e-9, name);
    assert.equal(big.closed && win.closed, true);
  }
});

test("laser: an engraved area follows a puzzle knob – nothing is engraved outside its piece", () => {
  const r = laserSplit(laserPlate(), [seam(200, "laser")], 0.2);
  for (const p of r.pieces) {
    const outer: MultiPolygon = p.region.map(poly => [poly[0]] as Polygon);
    for (const s of p.shapes.filter(s => s.laserLayerId === "L2")) near(areaOf(polygonClipping.difference(mmPoly(s), offsetArea(outer, 0.01))), 0, 1e-6, p.name);
  }
  // both halves together are the whole engraving (plus the 0.1 mm strip where the drawings overlap)
  const sum = (h: number) => r.pieces.reduce((t, p) => t + p.shapes.filter(s => s.laserLayerId === "L2" && Math.abs(s.h / PX - h) < 1e-6).reduce((u, s) => u + areaOf([mmPoly(s)]), 0), 0);
  // (the dividing curve inside the engraving is longer than its 40 mm height: it runs round the knob)
  assert.ok(sum(40) >= 280 * 40 && sum(40) < 280 * 40 + 0.1 * 120, `area ${sum(40)}`);
});

test("laser: marked lines end at the piece edge; a closed marked frame becomes open lines, not a line along the joint", () => {
  const r = laserSplit(laserPlate(), [seam(200, "laser", { joint: "butt" })], 0.2);
  const lines = (name: string) => piece(r, name).shapes.filter(s => s.laserLayerId === "L3");
  for (const [name, x0, x1] of [["A1", 20, 200.1], ["B1", 199.9, 380]] as [string, number, number][]) {
    const open = lines(name);
    assert.equal(open.every(s => !s.closed), true, name);
    const straight = open.find(s => s.points.length === 2)!;
    near(straight.points[0].x / PX, x0, 1e-9, name); near(straight.points[1].x / PX, x1, 1e-9, name);
    // the frame: no segment runs along the seam at x = 200
    for (const s of open) for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1], b = s.points[i];
      assert.ok(!(Math.abs(a.x / PX - 200) < 0.2 && Math.abs(b.x / PX - 200) < 0.2), `${name}: segment on the seam`);
    }
  }
});

test("laser: outlines keep their layer; holes that no seam touches stay circles", () => {
  const cutB = LL.addLayer({ name: "second cut", mode: "line", power: 90, speed: 200, leadIn: 2 });
  const shapes = [rect(0, 0, 400, 150, { laserLayerId: cutB.id, tabN: 3, tabLen: 1 }), circle(30, 30, 4, { laserLayerId: cutB.id })];
  const r = laserSplit(shapes, [seam(200, "laser")], 0.2);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  const outA = piece(r, "A1").shapes.find(s => s.type === "polyline" && s.closed)!;
  assert.equal(outA.laserLayerId, cutB.id);
  assert.equal(outA.tabN, 3);
  assert.equal(piece(r, "A1").shapes.filter(s => s.type === "circle").length, 1);
  // the lead-in of 2 mm needs room: space on the bed is the outline plus 2 mm all round
  near(piece(r, "A1").extent!.minX, -2, 1e-9);
  near(piece(r, "A1").extent!.minY, -2, 1e-9);
  // with detours round cut-out parts switched on, the detour (3 mm round the frame) needs the room
  LL.setLaserSettings({ avoidCut: true });
  near(piece(laserSplit(shapes, [seam(200, "laser")], 0.2), "A1").extent!.minX, -3, 1e-9);
  LL.setLaserSettings({ avoidCut: false });
  LL.removeLayer(cutB.id);
});

test("laser: each piece's program passes the G-code check and stays on the bed", () => {
  const r = laserSplit(laserPlate(), [seam(200, "laser")], 0.2);
  for (const p of r.pieces) {
    S.placeAtCorner(p, BED);
    const { gcode } = LC.generateLaserGcode(p.shapes);
    assert.ok(gcode && gcode.length > 500, p.name);
    assert.deepEqual(lintGcode(gcode!, { kind: "laser", bedW: BED.w, bedH: BED.h, sMax: LL.laserSettings.sMax }), [], p.name);
    onBed(gcode!);
    // engraving (S500 = 50 %), marking (S300) and cutting (S1000) are all there
    for (const sv of ["S500", "S300", "S1000"]) assert.ok(gcode!.includes(sv), `${p.name}: ${sv}`);
  }
});

test("laser: a plate twice as wide as the bed is split so that every piece fits (three columns)", () => {
  LL.setLaserSettings({ kerf: 0.2 });
  const shapes = [rect(0, 0, 500, 150)];
  const o = B.laserSplitOptions(shapes, null, BED);
  const fit = S.fitGrid(shapes, S.defaultSeam("x", 0, "laser"), o)!;
  // two halves of 250 mm plus a knob do not fit 250 mm, so it takes three
  assert.deepEqual([fit.cols, fit.rows], [3, 1]);
  const r = S.splitDrawing(shapes, { id: "t", seams: fit.seams }, o);
  assert.equal(r.ok && r.pieces.every(p => p.fits), true);
});

test("laser: a drawing with only engraving has no outline to split", () => {
  const r = laserSplit([rect(0, 0, 400, 150, { laserLayerId: "L2" })], [seam(200, "laser")], 0.2);
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues.map(i => i.code), ["noOutlineLaser"]);
});

test("laser: a shape filled and outlined across a seam is split as an area and reported", () => {
  const both = LL.addLayer({ name: "both", mode: "fill+line", power: 20, speed: 2000 });
  const r = laserSplit([rect(0, 0, 400, 150), rect(150, 40, 250, 60, { laserLayerId: both.id })], [seam(200, "laser", { joint: "butt" })], 0.2);
  assert.equal(r.issues.find(i => i.code === "fillLine")?.n, 1);
  assert.equal(piece(r, "A1").shapes.filter(s => s.laserLayerId === both.id && s.closed).length, 1);
  LL.removeLayer(both.id);
});

test("laser: an image across a seam is cut at each piece's frame; a rotated image stays whole and is reported", () => {
  const img = (pts: [number, number][]) => { const s: any = { id: "i", type: "image", points: px(pts), x: 0, y: 0, w: 0, h: 0, img: { src: "", overscan: 2 } }; const xs = s.points.map((p: any) => p.x), ys = s.points.map((p: any) => p.y); s.x = Math.min(...xs); s.y = Math.min(...ys); s.w = Math.max(...xs) - s.x; s.h = Math.max(...ys) - s.y; return s; };
  const straight = img([[150, 100], [250, 100], [250, 140], [150, 140]]);
  const r = laserSplit([rect(0, 0, 400, 150), straight], [seam(200, "laser", { joint: "butt" })], 0.2);
  assert.equal(r.issues.find(i => i.code === "imageCut")?.n, 1);
  assert.equal(r.issues.some(i => i.code === "image"), false);
  const ia = piece(r, "A1").shapes.find(s => s.type === "image")!, ib = piece(r, "B1").shapes.find(s => s.type === "image")!;
  assert.deepEqual([ia.cropMm.minX, ia.cropMm.maxX], [150, 200.1]);
  assert.deepEqual([ib.cropMm.minX, ib.cropMm.maxX], [199.9, 250]);
  assert.notEqual(ia.id, ib.id);
  // the image rows run 2 mm past the image with the laser off (overscan): B1 needs that room left of its edge
  near(piece(r, "B1").extent!.minX, 197.9, 1e-9, "B1 room with overscan");
  // the crop moves with the piece when it is placed at the bed corner (room starts at x = 197.9 → 1 mm rim)
  S.placeAtCorner(piece(r, "B1"), BED);
  near(ib.cropMm.minX, 3, 1e-9); near(ib.cropMm.maxX, 53.1, 1e-9);
  // rotated by a few degrees: not cut, whole in the piece of its centre
  const turned = img([[150, 100], [250, 104], [248, 144], [148, 140]]);
  const r2 = laserSplit([rect(0, 0, 400, 150), turned], [seam(205, "laser", { joint: "butt" })], 0.2);
  assert.equal(r2.issues.find(i => i.code === "image")?.n, 1);
  assert.equal(r2.pieces.flatMap(p => p.shapes).filter(s => s.type === "image").length, 1);
  assert.equal(r2.pieces.flatMap(p => p.shapes).some(s => s.cropMm), false);
});

test("stored setup keeps the cut layers (harmless characters only); the fingerprint follows layers and kerf", () => {
  const s = S.cleanSplit({ id: "a", seams: [], cutLayers: ["L1", "L1", "x\"><b>", 5, "Lab.c-1_2"] })!;
  assert.deepEqual(s.cutLayers, ["L1", "Lab.c-1_2"]);
  assert.equal(S.cleanSplit({ id: "a", seams: [] })!.cutLayers, undefined);
  assert.deepEqual(S.cloneSplit(s).cutLayers, s.cutLayers);
  const shapes = laserPlate();
  const base = { id: "t", seams: [seam(200, "laser")] };
  // without chosen layers the fingerprint is the one older versions made
  assert.equal(S.splitFingerprint(shapes, base, "x"), S.splitFingerprint(shapes, { ...base, cutLayers: [] }, "x"));
  assert.notEqual(S.splitFingerprint(shapes, base, "x"), S.splitFingerprint(shapes, { ...base, cutLayers: ["L3"] }, "x"));
  LL.setLaserSettings({ kerf: 0.2 });
  const f1 = B.beamFingerprint("laser", shapes, base);
  LL.setLaserSettings({ kerf: 0.25 });
  assert.notEqual(B.beamFingerprint("laser", shapes, base), f1);
  assert.notEqual(B.beamFingerprint("laser", shapes, { cutLayers: ["L3"] }), B.beamFingerprint("laser", shapes, base));
  assert.notEqual(B.beamFingerprint("plasma", shapes, base), B.beamFingerprint("laser", shapes, base));
});

// =====================================================================
// PLASMA
// =====================================================================

/** Plate 400 × 150 with four 20 mm holes, a slit set to "on line" across the middle and an open line – all with cut P1 (kerf 1.5) */
function plasmaPlate() {
  return [
    rect(0, 0, 400, 150),
    circle(40, 40, 10), circle(360, 40, 10), circle(40, 110, 10), circle(360, 110, 10),
    rect(150, 20, 250, 30, {}, "on-line"),
    line([[100, 130], [300, 130]]),
  ];
}
const plasmaSplit = (shapes: any[], seams: Seam[]) => S.splitDrawing(shapes, { id: "t", seams }, B.plasmaSplitOptions(BED));

test("plasma: curves are at least 2 mm and 1.5 × kerf; the default clearance is larger than for a laser", () => {
  near(S.minCurveRadius(1.5, "plasma"), 2.25, 1e-12);
  near(S.minCurveRadius(1, "plasma"), 2, 1e-12);
  near(S.minCurveRadius(3, "plasma"), 4.5, 1e-12);
  near(S.minCurveRadius(0.2, "laser"), 0.31, 1e-12);
  assert.equal(S.DEFAULT_CLEARANCE.plasma, 0.3);
  // fingers: rounded with 2.25 mm, so 4 mm fingers are refused with the smallest width 4.5
  const p = S.seamProfile(seam(200, "plasma", { joint: "finger", size: 4, depth: 12 }), 1.5, 0, "plasma");
  near(p.rho, 2.25, 1e-12);
  assert.deepEqual(p.errors.map(e => [e.code, e.v]), [["fingerSmall", 4.5]]);
});

test("plasma: every closed shape set to outside/inside is the outline; pieces fit the bed with kerf and lead-in", () => {
  const r = plasmaSplit(plasmaPlate(), [seam(200, "plasma")]);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.kind, "plasma");
  near(r.toolDia, 1.5, 1e-12, "kerf");
  assert.equal(r.kerfShift, 0, "the program compensates the kerf itself");
  assert.deepEqual(r.pieces.map(p => [p.name, p.fits]), [["A1", true], ["B1", true]]);
  // room on the bed: outline plus half the kerf (0.75) plus the detour round a cut-out part (5) all round …
  near(piece(r, "A1").extent!.minX, -5.75, 1e-9);
  near(piece(r, "A1").extent!.minY, -5.75, 1e-9);
  // … without those detours the lead-in (3) decides
  PC.setPlasmaSettings({ avoidCut: false }, false);
  near(piece(plasmaSplit(plasmaPlate(), [seam(200, "plasma")]), "A1").extent!.minX, -3.75, 1e-9);
  PC.setPlasmaSettings({ avoidCut: true }, false);
  // outline and holes keep their operation, so the kerf goes to the right side
  const a = piece(r, "A1").shapes;
  assert.equal(a.filter(s => s.type === "polyline" && s.closed && s.millingMode === "outside").length, 1);
  assert.equal(a.filter(s => s.type === "circle" && s.millingMode === "inside").length, 2);
  // the slit "on line" and the open line end at the piece edge: open lines only, 0.3 mm before the seam
  const open = a.filter(s => s.type === "polyline" && !s.closed);
  assert.equal(open.length, 2);
  assert.equal(open.every(s => s.millingMode === "on-line"), true);
  near(Math.max(...open.flatMap(s => s.points.map((q: any) => q.x / PX))), 199.7, 1e-9);
});

test("plasma: the pieces as drawn are 2 × clearance apart, and the torch path cuts exactly that outline", () => {
  const cut = PC.getCut("P1")!;
  for (const s of [seam(200, "plasma"), seam(200, "plasma", { joint: "finger", size: 20, depth: 12 }), seam(200, "plasma", { clearance: 0.5, alternate: false, count: 2, size: 20 })]) {
    const r = plasmaSplit([rect(0, 0, 400, 150)], [s]);
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    const made: MultiPolygon[] = [];
    for (const p of r.pieces) {
      const out = p.shapes.find(x => x.type === "polyline" && x.closed && x.millingMode === "outside")!;
      // what plasmaCam.ts really cuts: the torch centre runs half a kerf outside, the arc removes half a kerf again
      const plans = PCam.planShape(out, cut).plans;
      assert.equal(plans.length, 1, `${p.name}: one torch path`);
      const torch: MultiPolygon = [[[...plans[0].pts.map(q => [q.x, q.y] as [number, number]), [plans[0].pts[0].x, plans[0].pts[0].y]]]];
      const left = offsetArea(torch, -cut.kerf / 2);
      // nothing is left standing in a socket and nothing extra is burnt away: the cut piece and the drawn piece
      // each lie inside the other grown by 0.03 mm
      near(areaOf(polygonClipping.difference(left, offsetArea(p.region, 0.03))), 0, 1e-6, `${s.joint} ${p.name}: left standing`);
      near(areaOf(polygonClipping.difference(p.region, offsetArea(left, 0.03))), 0, 1e-6, `${s.joint} ${p.name}: burnt away`);
      made.push(left);
    }
    assertFit(piece(r, "A1").region, piece(r, "B1").region, s.clearance, `${s.joint} drawn`);
    // the cut pieces: same fit within what turning arcs into short lines costs
    const c = s.clearance, ga = offsetArea(made[0], c), gb = offsetArea(made[1], c);
    assert.ok(areaOf(polygonClipping.intersection(ga, gb, BAND)) < 0.05 * 190, `${s.joint}: cut pieces overlap`);
    assert.ok(areaOf(polygonClipping.difference(BAND, ga, gb)) < 0.05 * 190, `${s.joint}: cut pieces gap`);
  }
});

test("plasma: a knob the kerf cannot get into is refused with the smallest size that works", () => {
  // neck 0.56 × 3 = 1.68 mm plus 2 × 0.3 clearance = 2.28 ≥ kerf 1.5 + 0.2 → fits; head 2 mm: 1.12 + 0.6 = 1.72 ≥ 1.7 too,
  // but then the clearance is too large for so small a knob → refused either way
  const small = plasmaSplit([rect(0, 0, 400, 150)], [seam(200, "plasma", { size: 2 })]);
  assert.equal(small.ok, false);
  // clearance 0: neck must be ≥ 1.7 mm → head ≥ 1.7 / 0.56 = 3.04 → reported as 3.1
  const tight = plasmaSplit([rect(0, 0, 400, 150)], [seam(200, "plasma", { size: 2.5, clearance: 0 })]);
  assert.deepEqual(tight.issues.filter(i => i.level === "error").map(i => [i.code, i.v]), [["knobSmall", 3.1]]);
});

test("plasma: each piece's program passes the G-code check and stays on the bed, pierce points included", () => {
  const r = plasmaSplit(plasmaPlate(), [seam(200, "plasma")]);
  for (const p of r.pieces) {
    S.placeAtCorner(p, BED);
    const { gcode, warnings } = PCam.generatePlasmaGcode(p.shapes);
    assert.ok(gcode && gcode.length > 500, p.name);
    assert.deepEqual(warnings, [], p.name);
    assert.deepEqual(lintGcode(gcode!, { kind: "plasma", bedW: BED.w, bedH: BED.h }), [], p.name);
    onBed(gcode!);
    // outline, two holes, the slit (two open runs become… lines) and the line: every cut switches the torch off again
    assert.equal((gcode!.match(/^M3 /gm) || []).length, (gcode!.match(/^M5 \(/gm) || []).length - 1, `${p.name}: M3/M5`);
  }
});

test("plasma: a drawing with only shapes \"on line\" has no outline to split", () => {
  const r = plasmaSplit([rect(0, 0, 400, 150, {}, "on-line")], [seam(200, "plasma")]);
  assert.deepEqual(r.issues.map(i => i.code), ["noOutlinePlasma"]);
});

test("router: nothing changes – kind and shift are reported as mill and 0", () => {
  const shapes = [rect(0, 0, 400, 150, { millingDepth: -12 })];
  const r: SplitResult = S.splitDrawing(shapes, { id: "t", seams: [S.defaultSeam("x", 200)] }, { bed: BED, radiusOf: () => 3 });
  assert.equal(r.kind, "mill");
  assert.equal(r.kerfShift, 0);
  near(r.toolDia, 6, 1e-12);
  assert.equal(S.defaultSeam("x", 200).clearance, 0.1);
});
