import test from "node:test";
import assert from "node:assert/strict";
import { bedMesh, carriageMesh, clampMesh, gantryMesh, rollers, rotaryChuck, rotaryFixed } from "../src/sim/machineMesh.ts";

const check = (m: Float32Array, name: string) => {
  assert.ok(m.length % 30 === 0 && m.every(Number.isFinite), name);
  for (let i = 0; i < m.length; i += 10) { const n = Math.hypot(m[i + 3], m[i + 4], m[i + 5]); assert.ok(Math.abs(n - 1) < 1e-4, `${name} Normale ${n}`); assert.ok(m[i + 9] > 0 && m[i + 9] <= 1); }
};
const range = (m: Float32Array, k: number) => { let a = Infinity, b = -Infinity; for (let i = k; i < m.length; i += 10) { a = Math.min(a, m[i]); b = Math.max(b, m[i]); } return [a, b]; };

test("beds lie under the stock, also for very large machines", () => {
  for (const k of ["mill", "laser", "plasma"] as const) for (const [w, h] of [[300, 180], [3000, 1500], [40, 40]]) {
    const m = bedMesh(k, w, h, 12);
    check(m, k);
    assert.ok(range(m, 2)[1] < -11.9, k + " " + range(m, 2)[1]);
    assert.ok(m.length < 400000, k + " zu groß " + m.length);
  }
});
test("gantry and carriage stay behind the tool and above the stock's middle", () => {
  for (const k of ["mill", "laser", "plasma"] as const) { const g = gantryMesh(k, 300, 10, 60), c = carriageMesh(k, 60); check(g, k); check(c, k); assert.ok(range(g, 1)[0] > 10 && range(c, 1)[0] > 10); assert.ok(range(c, 2)[0] > 0); }
});
test("clamps: height, winding and degenerate outlines", () => {
  const sq = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }];
  for (const pts of [sq, sq.slice().reverse(), [...sq, sq[0]]]) {
    const m = clampMesh([{ pts, height: 15 }], 8);
    check(m, "clamp"); assert.deepEqual(range(m, 2), [-8, 15]); assert.deepEqual(range(m, 0), [0, 20]);
    // Seitenflächen zeigen nach außen
    for (let i = 0; i < m.length; i += 10) if (m[i + 5] === 0) assert.ok((m[i] - 10) * m[i + 3] + (m[i + 1] - 5) * m[i + 4] > 0);
  }
  assert.equal(clampMesh([{ pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }], height: 3 }], 5).length, 0);
  assert.equal(clampMesh([], 5).length, 0);
});
test("rotary: the chuck holds outside the stock, the rollers touch it from below", () => {
  for (const R of [3, 25, 120]) {
    const c = rotaryChuck(0, R); check(c, "chuck"); assert.ok(range(c, 0)[1] <= 0);
    check(rotaryFixed(0, 100, R), "fixed");
    const r = rollers(0, 100, R, 30); check(r, "rollers");
    let min = Infinity; for (let i = 0; i < r.length; i += 10) { const d = Math.hypot(r[i + 1], r[i + 2]); if (r[i] > 0 === r[i] < 100) min = Math.min(min, d); min = Math.min(min, d); }
    assert.ok(min >= R - 0.3, `Rolle im Teil: ${min} < ${R}`); assert.ok(min <= R + 1.5, `Rolle berührt nicht: ${min} > ${R}`);
  }
});
