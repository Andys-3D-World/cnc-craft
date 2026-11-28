// Cutter picture for the simulation: must stay true to scale (diameter, flute length) and small enough for old computers
import test from "node:test";
import assert from "node:assert/strict";
import { cutterLook, cutterMesh, fluteSection, millToolMesh, sweep } from "../src/sim/toolMesh.ts";
import type { ToolGeom } from "../src/toolGraphics.ts";

const tool = (over: Partial<ToolGeom>): ToolGeom => ({
  type: "endmill", diameter: 6, shankDia: 6, fluteLen: 22, length: 50, flutes: 2, helix: "up", angle: 90, tipDia: 0, cornerR: 0, ...over
});
const holder = { R: 3, shankR: 3, fluteLen: 22, stickout: 30, holderR: 9.5, holderH: 18, spindleR: 26, spindleH: 70 };
const flat: [number, number][] = [[0, 0], [3, 0], [3, 22]];

function stats(a: ArrayLike<number>) {
  let r = 0, z0 = Infinity, z1 = -Infinity, badN = 0;
  for (let i = 0; i < a.length; i += 10) {
    r = Math.max(r, Math.hypot(a[i], a[i + 1]));
    z0 = Math.min(z0, a[i + 2]); z1 = Math.max(z1, a[i + 2]);
    if (Math.abs(Math.hypot(a[i + 3], a[i + 4], a[i + 5]) - 1) > 1e-6) badN++;
  }
  return { r, z0, z1, badN, verts: a.length / 10 };
}

test("flute section: cutting edge on the full radius, never below the core", () => {
  assert.equal(fluteSection(0, 0.55), 1);
  for (let u = 0; u < 1; u += 0.01) {
    const v = fluteSection(u, 0.55);
    assert.ok(v >= 0.55 - 1e-9 && v <= 1 + 1e-9);
  }
  assert.ok(Math.abs(fluteSection(0.999, 0.55) - 1) < 0.02, "rake face comes back up to the edge");
});

test("cutter keeps diameter and flute length, normals have length 1", () => {
  const out: number[] = [];
  cutterMesh(out, flat, cutterLook(tool({}), 3, 22), [1, 1, 1], 2);
  const s = stats(out);
  assert.ok(Math.abs(s.r - 3) < 1e-6, `largest radius ${s.r}`);
  assert.equal(s.z0, 0);
  assert.ok(Math.abs(s.z1 - 22) < 1e-9);
  assert.equal(s.badN, 0);
  // the same numbers are checked in src-tauri/src/toolmesh.rs: Rust (in the app) and TypeScript (browser) must stay equal
  assert.equal(s.verts, 7488);
  let sum = 0;
  const f = new Float32Array(out);
  for (let i = 0; i < f.length; i += 10) sum += Math.abs(f[i]) + Math.abs(f[i + 1]) + f[i + 2];
  assert.ok(Math.abs(sum - 100366.57) < 0.5, `sum ${sum}`);
});

test("flutes run out at the top: the last ring is a full circle", () => {
  const out: number[] = [];
  cutterMesh(out, flat, cutterLook(tool({ flutes: 3 }), 3, 22), [1, 1, 1], 2);
  for (let i = 0; i < out.length; i += 10) if (Math.abs(out[i + 2] - 22) < 1e-9) assert.ok(Math.abs(Math.hypot(out[i], out[i + 1]) - 3) < 1e-6);
});

test("look per tool type: helix direction, straight flutes, compression", () => {
  assert.ok(cutterLook(tool({}), 3, 22).rate > 0);
  assert.ok(cutterLook(tool({ helix: "down" }), 3, 22).rate < 0);
  assert.equal(cutterLook(tool({ helix: "straight" }), 3, 22).rate, 0);
  assert.equal(cutterLook(tool({ type: "vbit" }), 3, 22).rate, 0);
  assert.ok(Number.isFinite(cutterLook(tool({ helix: "compression" }), 3, 22).split));
  assert.equal(cutterLook(tool({ type: "drill", flutes: 1 }), 3, 22).flutes, 2);
  assert.equal(cutterLook(tool({ flutes: 40 }), 3, 22).flutes, 8);
  assert.equal(cutterLook(null, 1.5, 12).flutes, 2);
});

test("whole tool: shank and collet nut at the given sizes, small enough for old graphics cards", () => {
  for (const tl of [tool({}), tool({ flutes: 4 }), tool({ diameter: 1, shankDia: 3.175, fluteLen: 12 }), tool({ type: "drill", angle: 118 }), null]) {
    const R = (tl?.diameter ?? 3) / 2, hd = { ...holder, R, shankR: (tl?.shankDia ?? 3) / 2, fluteLen: tl?.fluteLen ?? 12 };
    const m = millToolMesh(tl, hd, [[0, 0], [R, 0], [R, hd.fluteLen]]);
    const s = stats(m.solid), g = stats(m.ghost);
    assert.ok(Math.abs(s.r - Math.max(R, hd.shankR)) < 1e-4);
    assert.equal(s.badN + g.badN, 0);
    assert.ok(Math.abs(g.r - hd.spindleR) < 1e-4);
    assert.ok(s.verts + g.verts < 120000, `${s.verts + g.verts} points`);
  }
});

test("sweep without flutes is a plain body of revolution", () => {
  const out: number[] = [];
  sweep(out, [[2, 0], [2, 5]], { seg: 12, col: [1, 1, 1], alpha: 1 });
  assert.equal(out.length, 12 * 6 * 10);
  for (let i = 0; i < out.length; i += 10) {
    assert.ok(Math.abs(Math.hypot(out[i], out[i + 1]) - 2) < 1e-9);
    assert.ok(Math.abs(out[i + 5]) < 1e-9, "wall normal is level");
    assert.ok(out[i] * out[i + 3] + out[i + 1] * out[i + 4] > 1.99, "normal points outwards");
  }
});
