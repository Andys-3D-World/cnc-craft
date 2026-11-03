// Tests für den Materialabtrag in der Simulation (sim/simCarve.ts) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGcodeProgram, positionAt, firstMoveOfLine } from "../src/sim/gcodeParser.ts";
import { LiveCarve, holderFor, toolSections } from "../src/sim/simCarve.ts";
import type { ToolGeom } from "../src/toolGraphics.ts";

const mill = (d: number, extra: Partial<ToolGeom> = {}): ToolGeom =>
  ({ type: "endmill", diameter: d, shankDia: d, fluteLen: 12, length: 38, flutes: 2, helix: "up", angle: 0, tipDia: 0, cornerR: 0, ...extra });

/** Höhe in der Mitte der Zelle bei (x, y) */
const heightAt = (c: LiveCarve, x: number, y: number) =>
  c.h[Math.floor((y - c.y0) / c.cell) * c.nx + Math.floor((x - c.x0) / c.cell)];

const run = (c: LiveCarve) => { let k = 0; while (c.busy && k++ < 10000) c.advance(50); };

const slot = [
  "G21 G90", "M3 S10000", "G0 Z5", "G0 X10 Y10", "G1 Z-2 F300", "G1 X50 F1000", "G0 Z5", "M5"
];

test("slot is cut to depth with the cutter width", () => {
  const p = parseGcodeProgram(slot);
  const c = LiveCarve.create(p, { tools: [mill(6)], thickness: 10 })!;
  assert.ok(c);
  c.setTarget(p.n, 0);
  run(c);
  assert.ok(Math.abs(heightAt(c, 30, 10) + 2) < 1e-4);
  assert.ok(Math.abs(heightAt(c, 30, 12.5) + 2) < 1e-4);   // innerhalb des Radius
  assert.equal(heightAt(c, 30, 14), 0);                      // außerhalb
  assert.equal(heightAt(c, 55, 10), 0);                      // hinter dem Ende
  assert.equal(c.warnings.length, 0);
});

test("partial position cuts only up to there, jumping back restores", () => {
  const p = parseGcodeProgram(slot);
  const c = LiveCarve.create(p, { tools: [mill(6)], thickness: 10 })!;
  const m = firstMoveOfLine(p, 5), half = positionAt(p, p.t0[m] + p.dur[m] / 2);
  c.setTarget(half.i, half.frac);
  run(c);
  assert.ok(heightAt(c, 20, 10) < -1.9);
  assert.equal(heightAt(c, 40, 10), 0);
  c.setTarget(p.n, 0);
  run(c);
  assert.ok(heightAt(c, 40, 10) < -1.9);
  c.setTarget(firstMoveOfLine(p, 4), 0);                    // vor dem Eintauchen
  run(c);
  assert.equal(heightAt(c, 20, 10), 0);
  assert.equal(heightAt(c, 10, 10), 0);
});

test("rapid into material and holder collision are reported with the line", () => {
  const p = parseGcodeProgram(["G21 G90", "M3 S10000", "G0 X0 Y0 Z5", "G1 Z-1 F300", "G0 X20", "G1 Z-30", "G0 Z5"]);
  const c = LiveCarve.create(p, { tools: [mill(3, { fluteLen: 8, length: 30 })], thickness: 40 })!;
  c.setTarget(p.n, 0);
  run(c);
  const kinds = c.warnings.map(w => `${w.line}:${w.kind}`);
  assert.ok(kinds.includes("4:rapid"), kinds.join());
  assert.ok(kinds.includes("5:holder"), kinds.join());
});

test("tool change starts a new section", () => {
  const s = toolSections(["G0 X0", "M6 T2", "G1 X1", "M0 (change)", "G1 X2"]);
  assert.deepEqual([...s.slice(0, 5)], [0, 0, 1, 1, 2]);
  const hd = holderFor(mill(3, { fluteLen: 12, length: 38 }));
  assert.ok(hd.stickout > hd.fluteLen && hd.holderR > hd.shankR);
});

test("laser: engraving darkens, slow full power cuts through", () => {
  const p = parseGcodeProgram(["G21 G90", "M4 S0", "G0 X10 Y10", "G1 X50 S300 F3000", "G0 X10 Y20", "G1 X50 S1000 F300", "M5"]);
  const c = LiveCarve.create(p, { kind: "laser", tools: [], thickness: 3, sMax: 1000 })!;
  c.setTarget(p.n, 0);
  run(c);
  const engr = heightAt(c, 30, 10), cut = heightAt(c, 30, 20);
  assert.ok(engr > 0.05 && engr < c.cutDose, `engrave ${engr}`);
  assert.ok(cut >= c.cutDose, `cut ${cut}`);
  assert.equal(heightAt(c, 30, 15), 0);
});

test("plasma: kerf is cut through, heat tint next to it", () => {
  const p = parseGcodeProgram(["G21 G90", "G0 X10 Y10 Z3", "M3 S1000", "G1 Z1.5 F500", "G1 X50 F2000", "M5"]);
  const c = LiveCarve.create(p, { kind: "plasma", tools: [], thickness: 2, kerf: 1.6 })!;
  c.setTarget(p.n, 0);
  run(c);
  assert.ok(heightAt(c, 30, 10) >= 100);
  const side = heightAt(c, 30, 11.2);
  assert.ok(side > 0 && side < 100, `side ${side}`);
});

test("rotary: grid is the unrolled surface and wraps around", async () => {
  const { wrapSimProgram } = await import("../src/sim/rotarySim.ts");
  const flat = parseGcodeProgram(["G21 G90", "M3 S10000", "G0 X10 Y0 Z2", "G1 Z-1 F300", "G1 Y94.25 F1000", "G0 Z5"]);
  const p = wrapSimProgram(flat, 15, "surface");   // Y 0 … 94,25 mm = einmal rundherum (Ø 30)
  const c = LiveCarve.create(p, { tools: [mill(3)], thickness: 5 })!;
  assert.ok(c.cyl);
  assert.ok(Math.abs(c.ny * c.cell - 2 * Math.PI * 15) < 1e-6);
  c.setTarget(p.n, 0);
  run(c);
  for (const v of [-40, -10, 0, 10, 40]) assert.ok(heightAt(c, 10, v) < -0.9, `v ${v}: ${heightAt(c, 10, v)}`);
  assert.equal(heightAt(c, 20, 0), 0);
});
