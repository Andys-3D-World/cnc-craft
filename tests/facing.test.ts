// Tests für „Rohteil beidseitig planen“ – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { facingPath, type FacingParams } from "../src/facing.ts";

const base: FacingParams = {
  x0: 0, y0: 0, w: 100, h: 50, depth: 1, stepZ: 0.5, toolD: 20, stepOver: 0.5,
  feed: 1000, plunge: 200, safeZ: 5, dir: "x",
};
const num = (l: string, a: string) => { const m = new RegExp(a + "(-?[\\d.]+)").exec(l); return m ? Number(m[1]) : undefined; };

test("Tiefen: 1 mm in 0,5er Schritten = 2 Tiefen, letzte genau -1", () => {
  const r = facingPath(base);
  assert.equal(r.passes, 2);
  const zs = r.lines.filter(l => l.startsWith("G1 Z")).map(l => num(l, "Z"));
  assert.deepEqual(zs, [-0.5, -1]);
  // ungerade Teilung: nie tiefer als der Abtrag
  const r2 = facingPath({ ...base, depth: 0.7 });
  assert.deepEqual(r2.lines.filter(l => l.startsWith("G1 Z")).map(l => num(l, "Z")), [-0.5, -0.7]);
});

test("Eintauchen neben dem Rohteil, Zeilen über den Rand hinaus", () => {
  const r = facingPath(base);
  const i = r.lines.findIndex(l => l.startsWith("G1 Z"));
  const start = r.lines[i - 1];
  assert.ok(num(start, "X")! < -10, "Eintauchen links außerhalb (Radius + 1 mm)");
  const xs = r.lines.filter(l => l.startsWith("G1") && l.includes("X")).map(l => num(l, "X")!);
  assert.equal(Math.min(...xs), -11);
  assert.equal(Math.max(...xs), 111);
});

test("Zeilen von Kante zu Kante, Abstand höchstens die Zustellung", () => {
  const r = facingPath(base);
  const ys = [...new Set(r.lines.filter(l => l.startsWith("G1") && l.includes("Y")).map(l => num(l, "Y")!))].sort((a, b) => a - b);
  assert.equal(ys[0], 0);
  assert.equal(ys[ys.length - 1], 50);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] <= 10 + 1e-9);
  assert.equal(r.rows, ys.length);
});

test("Zeilen entlang Y und unsinnige Werte", () => {
  const r = facingPath({ ...base, dir: "y" });
  const ys = r.lines.filter(l => l.startsWith("G1") && l.includes("Y")).map(l => num(l, "Y")!);
  assert.equal(Math.min(...ys), -11);
  assert.equal(Math.max(...ys), 61);
  assert.equal(facingPath({ ...base, depth: 0 }).lines.length, 0);
  assert.equal(facingPath({ ...base, w: 0 }).lines.length, 0);
  assert.equal(r.lines[r.lines.length - 1], "G0 Z5");
});
