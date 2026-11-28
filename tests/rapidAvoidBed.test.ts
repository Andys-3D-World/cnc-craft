// Tests: detours round cut-out parts stay inside the work area – run with `npm test` (node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RapidPlanner } from "../src/rapidAvoid.ts";

type P = { x: number; y: number };
const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }
];
const BED = { w: 300, h: 200 };
const onBed = (via: P[], bed = BED) => via.every(p => p.x >= 0 && p.y >= 0 && p.x <= bed.w && p.y <= bed.h);

// ---- part 2 mm from the lower bed edge, rapid from right to left across it ----
// Part 100…200 × 2…62, rapid (250,30) -> (50,30).
// Laser margin 3: frame corners at x 97 / 203, y -1 / 65.
//   below: 2·√(47² + 31²) + 106 = 2·56.30 + 106 = 218.6   <- shorter, but Y-1 is off the bed
//   above: 2·√(47² + 35²) + 106 = 2·58.60 + 106 = 223.2
//   On the bed the lower corners move to Y0: 2 mm are left to the part, at least half the margin (1.5) -> allowed.
//   below at Y0: 2·√(47² + 30²) + 106 = 2·55.76 + 106 = 217.5 -> (203,0), (97,0)
test("laser, part 2 mm from the bed edge: the detour runs along the bed edge, not outside", () => {
  const a = { x: 250, y: 30 }, b = { x: 50, y: 30 }, part = rect(100, 2, 200, 62);
  const old = new RapidPlanner(3);
  old.addCut(part);
  assert.deepEqual(old.route(a, b), [{ x: 203, y: -1 }, { x: 97, y: -1 }], "without a bed size: as before");

  const rp = new RapidPlanner(3, BED);
  rp.addCut(part);
  const via = rp.route(a, b);
  assert.deepEqual(via, [{ x: 203, y: 0 }, { x: 97, y: 0 }]);
  assert.ok(onBed(via));
});

// Plasma margin 5: frame corners at x 95 / 205, y -3 / 67.
//   below: 2·√(45² + 33²) + 110 = 2·55.80 + 110 = 221.6   <- shorter, but Y-3 is off the bed
//   above: 2·√(45² + 37²) + 110 = 2·58.26 + 110 = 226.5
//   At Y0 only 2 mm would be left, less than half the margin (2.5): those corners are dropped -> above: (205,67), (95,67)
test("plasma, part 2 mm from the bed edge: too little room below, the detour goes round the other side", () => {
  const a = { x: 250, y: 30 }, b = { x: 50, y: 30 }, part = rect(100, 2, 200, 62);
  const old = new RapidPlanner(5);
  old.addCut(part);
  assert.deepEqual(old.route(a, b), [{ x: 205, y: -3 }, { x: 95, y: -3 }], "without a bed size: as before");

  const rp = new RapidPlanner(5, BED);
  rp.addCut(part);
  const via = rp.route(a, b);
  assert.deepEqual(via, [{ x: 205, y: 67 }, { x: 95, y: 67 }]);
  assert.ok(onBed(via));
});

// ---- the case that was found: plate 4 mm from the lower edge, torch parks at X0 Y0 ----
// Plate 20…230 × 4…150, margin 5, rapid (240,80) -> (0,0). The straight line (y = x/3) enters the plate at x = 230.
//   before: over the corner (235,-1): √(5² + 81²) + √(235² + 1²) = 81.15 + 235.00 = 316.2
//   now: the corner moves to (235,0), 4 mm are left (≥ 2.5): √(5² + 80²) + 235 = 80.16 + 235 = 315.2
//   (the lower left corner (15,0) lies on that last leg and adds nothing)
test("plasma, parking at X0 Y0 past a plate near the lower edge: no negative Y", () => {
  const a = { x: 240, y: 80 }, b = { x: 0, y: 0 }, plate = rect(20, 4, 230, 150);
  const old = new RapidPlanner(5);
  old.addCut(plate);
  assert.deepEqual(old.route(a, b), [{ x: 235, y: -1 }]);

  const rp = new RapidPlanner(5, BED);
  rp.addCut(plate);
  assert.deepEqual(rp.route(a, b), [{ x: 235, y: 0 }]);
});

// ---- upper limits: part 2 mm from the right bed edge ----
// Part 238…298 × 100…160, margin 3, rapid (270,60) -> (270,190). Corners at x 235 / 301, y 97 / 163.
//   right: √(31² + 37²) + 66 + √(31² + 27²) = 48.27 + 66 + 41.11 = 155.4   <- X301 is off a 300 mm bed
//   left:  √(35² + 37²) + 66 + √(35² + 27²) = 50.93 + 66 + 44.20 = 161.1
//   right at X300 (2 mm left, ≥ 1.5): √(30² + 37²) + 66 + √(30² + 27²) = 47.63 + 66 + 40.36 = 154.0
test("part 2 mm from the right bed edge: the detour stays at X ≤ bed width", () => {
  const a = { x: 270, y: 60 }, b = { x: 270, y: 190 }, part = rect(238, 100, 298, 160);
  const old = new RapidPlanner(3);
  old.addCut(part);
  assert.deepEqual(old.route(a, b), [{ x: 301, y: 97 }, { x: 301, y: 163 }]);

  const rp = new RapidPlanner(3, BED);
  rp.addCut(part);
  const via = rp.route(a, b);
  assert.deepEqual(via, [{ x: 300, y: 97 }, { x: 300, y: 163 }]);
  assert.ok(onBed(via));
});

// ---- a detour that was on the bed already is not touched ----
// Part 100…200 × 4…64, margin 5, rapid (250,34.25) -> (50,34.25). Corners at x 95 / 205, y -1 / 69.
//   above: 2·√(45² + 34.75²) + 110 = 2·56.86 + 110 = 223.7   <- shortest, on the bed
//   below: 2·√(45² + 35.25²) + 110 = 2·57.16 + 110 = 224.3
//   Pulled back to Y0 the way below would be shorter (2·56.55 + 110 = 223.1), but the first result
//   is on the bed and is kept: same G-code as before this change.
test("a detour that was inside the bed stays exactly the same", () => {
  const a = { x: 250, y: 34.25 }, b = { x: 50, y: 34.25 }, part = rect(100, 4, 200, 64);
  const old = new RapidPlanner(5);
  old.addCut(part);
  const rp = new RapidPlanner(5, BED);
  rp.addCut(part);
  assert.deepEqual(old.route(a, b), [{ x: 205, y: 69 }, { x: 95, y: 69 }]);
  assert.deepEqual(rp.route(a, b), [{ x: 205, y: 69 }, { x: 95, y: 69 }]);
});

// ---- no way round on the bed -> straight, as when no path is found ----
// Bed 300 × 100, part 100…200 × 1…99, margin 5: 1 mm below and above, less than 2.5 -> no corner is left.
test("no room on either side: the move stays straight instead of leaving the bed", () => {
  const a = { x: 50, y: 50 }, b = { x: 250, y: 50 }, part = rect(100, 1, 200, 99);
  const old = new RapidPlanner(5);
  old.addCut(part);
  assert.deepEqual(old.route(a, b), [{ x: 95, y: -4 }, { x: 205, y: -4 }], "before: outside the bed");

  const rp = new RapidPlanner(5, { w: 300, h: 100 });
  rp.addCut(part);
  assert.deepEqual(rp.route(a, b), []);
});

// ---- a job that lies off the bed itself: that bed edge does not limit, the others still do ----
// Bed 300 × 200. Part 100…200 × 400…460 lies above the bed, rapid (250,425) -> (50,425), margin 5.
// Corners at x 95 / 205, y 395 / 465.
//   below: 2·√(45² + 30²) + 110 = 2·54.08 + 110 = 218.2   <- as before
//   above: 2·√(45² + 40²) + 110 = 2·60.21 + 110 = 230.4
// Pulling the corners back to Y200 would mean a trip of 2 × 225 mm for a job that cannot run on this bed anyway.
test("a job beyond the bed edge keeps its detour there", () => {
  const a = { x: 250, y: 425 }, b = { x: 50, y: 425 }, part = rect(100, 400, 200, 460);
  const old = new RapidPlanner(5);
  old.addCut(part);
  const rp = new RapidPlanner(5, BED);
  rp.addCut(part);
  assert.deepEqual(old.route(a, b), [{ x: 205, y: 395 }, { x: 95, y: 395 }]);
  assert.deepEqual(rp.route(a, b), old.route(a, b));
});

// Same bed, a second part 100…200 × 2…62 near the lower edge is cut as well. The job reaches past the upper
// edge only, so the lower edge still limits: rapid (250,30) -> (50,30) with margin 3 runs at Y0 (see the first test).
test("a job beyond the upper edge is still kept inside at the lower edge", () => {
  const rp = new RapidPlanner(3, BED);
  rp.addCut(rect(100, 400, 200, 460));
  rp.addCut(rect(100, 2, 200, 62));
  assert.deepEqual(rp.route({ x: 250, y: 30 }, { x: 50, y: 30 }), [{ x: 203, y: 0 }, { x: 97, y: 0 }]);
});

// A part that hangs over the lower edge itself (100…200 × -1…59): the lower edge does not limit, as before.
// Rapid (250,25) -> (50,25), margin 3, corners at x 97 / 203, y -4 / 62.
//   below: 2·√(47² + 29²) + 106 = 2·55.23 + 106 = 216.5   <- as before, at Y-4
//   above: 2·√(47² + 37²) + 106 = 2·59.82 + 106 = 225.6
test("a part that hangs over the bed edge itself is passed as before", () => {
  const old = new RapidPlanner(3), rp = new RapidPlanner(3, BED);
  for (const p of [old, rp]) p.addCut(rect(100, -1, 200, 59));
  const a = { x: 250, y: 25 }, b = { x: 50, y: 25 };
  assert.deepEqual(old.route(a, b), [{ x: 203, y: -4 }, { x: 97, y: -4 }]);
  assert.deepEqual(rp.route(a, b), old.route(a, b));
});

test("a bed size that is no positive number limits nothing", () => {
  const a = { x: 250, y: 30 }, b = { x: 50, y: 30 }, part = rect(100, 2, 200, 62);
  for (const bed of [null, undefined, { w: 0, h: 200 }, { w: NaN, h: NaN }]) {
    const rp = new RapidPlanner(3, bed);
    rp.addCut(part);
    assert.deepEqual(rp.route(a, b), [{ x: 203, y: -1 }, { x: 97, y: -1 }]);
  }
});

// ---- many random jobs: never off the bed, and unchanged wherever the old detour was on the bed ----
test("random parts: with a bed no detour point is outside, and detours that were inside are identical", () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let same = 0, changed = 0, straight = 0;
  for (let run = 0; run < 400; run++) {
    const margin = run % 2 ? 5 : 3;
    const old = new RapidPlanner(margin), rp = new RapidPlanner(margin, BED);
    for (let k = 0; k < 6; k++) {
      const w = 10 + rnd() * 80, h = 10 + rnd() * 60, x = rnd() * (BED.w - w), y = rnd() * (BED.h - h);
      old.addCut(rect(x, y, x + w, y + h));
      rp.addCut(rect(x, y, x + w, y + h));
    }
    for (let k = 0; k < 10; k++) {
      const a = { x: rnd() * BED.w, y: rnd() * BED.h }, b = k === 0 ? { x: 0, y: 0 } : { x: rnd() * BED.w, y: rnd() * BED.h };
      const before = old.route(a, b), now = rp.route(a, b);
      assert.ok(onBed(now), `run ${run}: ${JSON.stringify(now)}`);
      if (onBed(before)) { assert.deepEqual(now, before); same++; }
      else if (now.length) changed++;
      else straight++;
    }
  }
  // the test must really have seen all three outcomes
  assert.ok(same > 100 && changed > 5, `same ${same}, changed ${changed}, straight ${straight}`);
});

// ---- real G-code: plasmaCam.ts and laserCam.ts run here (paths without extension, JSON without attribute, as under Vite) ----
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

/** The two bed size fields of the page, as bedSizeMm() reads them */
function setBed(bed: { w: number; h: number } | null) {
  const g = globalThis as any;
  if (!bed) { delete g.document; return; }
  g.document = { getElementById: (id: string) => id === "bed-w" ? { value: String(bed.w) } : id === "bed-h" ? { value: String(bed.h) } : null };
}

async function cam() {
  const store = new Map<string, string>();
  const g = globalThis as any;
  g.localStorage ??= { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
  g.window ??= { dispatchEvent() {}, addEventListener() {} };
  g.CustomEvent ??= class { type: string; constructor(type: string) { this.type = type; } };
  g.Event ??= class { type: string; constructor(type: string) { this.type = type; } };
  const LL = await import("../src/laserLayers.ts");
  const PC = await import("../src/plasmaCuts.ts");
  const LC = await import("../src/laserCam.ts");
  const PCam = await import("../src/plasmaCam.ts");
  const { lintGcode } = await import("../src/gcodeLint.ts");
  const { createPolyline, MM_TO_PIXEL: PX } = await import("../src/shapeTransform.ts");
  /** rot: the rectangle's points start that many corners later (the cut starts at the first of equally sharp corners) */
  const box = (x0: number, y0: number, x1: number, y1: number, mode: string, rot = 0) => {
    const r = rect(x0, y0, x1, y1), pts = [...r.slice(rot), ...r.slice(0, rot)];
    return createPolyline(pts.map(p => ({ x: p.x * PX, y: p.y * PX })), true, mode, {});
  };
  return { LL, PC, LC, PCam, lintGcode, box };
}

// Plate 6…230 × 4…100 cut "outside" with the default cut (kerf 1.5 mm): the torch runs 0.75 mm outside,
// so its path is 5.25…230.75 × 3.25…100.75. Detour corners (margin 5): x 0.25 / 235.75, y -1.75 / 105.75.
// All four corners are equally sharp, so the cut starts at the first one: the points are given from the upper left,
// which makes the cut start and end at the upper right corner, at about (230.75, 99.6); then the torch parks at X0 Y0:
//   over the top: 7.9 + 235.5 + 105.75 = 349.2
//   below:        √(5² + 101.3²) + √(235.75² + 1.75²) = 101.5 + 235.8 = 337.2   <- before: G0 X235.75 Y-1.75
// On a 300 × 200 bed that corner moves to Y0 (3.25 mm left to the torch path, ≥ 2.5): G0 X235.75 Y0
test("plasma G-code: a plate near the lower bed edge gives no move outside the bed", async () => {
  const c = await cam();
  c.PC.initPlasmaCuts();
  c.PC.setPlasmaSettings({ avoidCut: true }, false);
  const shapes = [c.box(6, 4, 230, 100, "outside", 3)];
  const off = (gcode: string) => c.lintGcode(gcode, { kind: "plasma", bedW: BED.w, bedH: BED.h }).filter(i => i.rule === "off-bed");

  setBed(null);   // no page, no bed size: the planner is not limited (as before this change)
  const before = c.PCam.generatePlasmaGcode(shapes).gcode!;
  setBed(BED);
  const now = c.PCam.generatePlasmaGcode(shapes).gcode!;
  setBed(null);

  const A = before.split("\n"), B = now.split("\n");
  assert.equal(A.length, B.length, "same number of lines");
  const diff = A.map((_, i) => i).filter(i => A[i] !== B[i]);
  assert.equal(diff.length, 1, "exactly the one detour line differs");
  assert.match(A[diff[0]], /^G0 X235\.75 Y-1\.75 \(/);
  assert.match(B[diff[0]], /^G0 X235\.75 Y0 \(/);
  assert.equal(B[diff[0]], A[diff[0]].replace("Y-1.75", "Y0"));
  assert.match(B[diff[0] + 1], /^G0 X0 Y0 /, "then straight to the parking position");
  assert.equal(off(before).length, 1, "before: the check reports the move");
  assert.deepEqual(off(now), []);
});

// Laser: three squares on the default cut layer, the large one 100…200 × 2…62 lies 2 mm from the lower edge.
// It ends at (100,2); the next square starts at (260,20) and the straight way there crosses the cut part
// (y = 13.25 at x = 200). Margin 3 -> over the corner (203,-1) before, (203,0) now (2 mm left, ≥ 1.5).
// The way to the parking position X0 Y0 at the end takes the same corner.
test("laser G-code: detours past a part 2 mm from the bed edge stay on the bed", async () => {
  const c = await cam();
  c.LL.initLaserLayers();
  c.LL.setLaserSettings({ avoidCut: true });
  const shapes = [c.box(100, 2, 200, 62, "on-line"), c.box(20, 20, 40, 40, "on-line"), c.box(260, 20, 280, 40, "on-line")];
  const off = (gcode: string) => c.lintGcode(gcode, { kind: "laser", sMax: 1000, bedW: BED.w, bedH: BED.h }).filter(i => i.rule === "off-bed");

  setBed(null);
  const before = c.LC.generateLaserGcode(shapes).gcode!;
  setBed(BED);
  const now = c.LC.generateLaserGcode(shapes).gcode!;
  setBed(null);
  c.LL.setLaserSettings({ avoidCut: false });

  const A = before.split("\n"), B = now.split("\n");
  assert.equal(A.length, B.length, "same number of lines");
  const diff = A.map((_, i) => i).filter(i => A[i] !== B[i]);
  assert.equal(diff.length, 2, "the two detour lines differ, nothing else");
  for (const i of diff) {
    assert.match(A[i], /^G0 X203 Y-1 S0 \(/);
    assert.match(B[i], /^G0 X203 Y0 S0 \(/);
  }
  assert.equal(off(before).length, 2, "before: the check reports both moves");
  assert.deepEqual(off(now), []);
  // no move of the whole program leaves the bed
  for (const line of B) {
    if (!/^G[01] /.test(line)) continue;
    const x = /X(-?[\d.]+)/.exec(line), y = /Y(-?[\d.]+)/.exec(line);
    if (x) assert.ok(Number(x[1]) >= 0 && Number(x[1]) <= BED.w, line);
    if (y) assert.ok(Number(y[1]) >= 0 && Number(y[1]) <= BED.h, line);
  }
});
