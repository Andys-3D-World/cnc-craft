// Tests für „Reihenfolge optimieren“ (Laser, Plasma) – laufen mit `npm test` (node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { optimizeCutOrder, travelLength, orientPts, type CutItem, type CutStep } from "../src/cutOrder.ts";

type P = { x: number; y: number };
const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }
];
const circle = (cx: number, cy: number, r: number, n = 24): P[] =>
  Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((i / n) * 2 * Math.PI), y: cy + r * Math.sin((i / n) * 2 * Math.PI) }));
/** geschlossene Kontur mit festem Einstieg am ersten Punkt (wie Plasma) */
const fixed = (pts: P[]): CutItem => ({ entry: pts[0], exit: pts[0], pts, closed: true });
const free = (pts: P[]): CutItem => ({ entry: pts[0], exit: pts[0], pts, closed: true, freeStart: true });
const inOrder = (items: CutItem[]): CutStep[] => items.map((_, i) => ({ index: i, reversed: false, start: 0 }));

/** einfacher Zufall mit festem Startwert – Tests sollen immer gleich laufen */
function rng(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
}

test("every item appears exactly once", () => {
  const r = rng(1);
  const items = Array.from({ length: 50 }, () => { const x = r() * 500, y = r() * 300; return fixed(rect(x, y, x + 10, y + 10)); });
  const steps = optimizeCutOrder(items, { x: 0, y: 0 });
  assert.deepEqual(steps.map(s => s.index).sort((a, b) => a - b), items.map((_, i) => i));
});

test("scattered parts: much shorter travel than drawing order", () => {
  const r = rng(7);
  const items = Array.from({ length: 200 }, () => { const x = r() * 1000, y = r() * 600; return fixed(rect(x, y, x + 8, y + 8)); });
  const from = { x: 0, y: 0 };
  const before = travelLength(items, inOrder(items), from);
  const after = travelLength(items, optimizeCutOrder(items, from), from);
  assert.ok(after < before * 0.25, `before ${before.toFixed(0)} mm, after ${after.toFixed(0)} mm`);
});

test("2-opt beats plain nearest neighbour", () => {
  // Gitter: der nächste Nachbar lässt Lücken, die 2-opt schließt
  const r = rng(3);
  const items = Array.from({ length: 120 }, () => { const x = r() * 400, y = r() * 400; return fixed(rect(x, y, x + 2, y + 2)); });
  const from = { x: 0, y: 0 };
  const nnOnly = travelLength(items, optimizeCutOrder(items, from, 0), from);
  const full = travelLength(items, optimizeCutOrder(items, from, 500), from);
  assert.ok(full < nnOnly, `NN ${nnOnly.toFixed(1)} mm, 2-opt ${full.toFixed(1)} mm`);
});

test("holes are always cut before the part that contains them", () => {
  // drei Teile (je mit zwei Löchern) in Zeichen-Reihenfolge: Teil zuerst, dann die Löcher
  const items: CutItem[] = [];
  const outerOf: number[] = [];
  for (let k = 0; k < 3; k++) {
    const x = k * 120;
    const o = items.push(fixed(rect(x, 0, x + 100, 60))) - 1;
    for (const cx of [x + 25, x + 75]) { items.push(fixed(circle(cx, 30, 10))); outerOf.push(o); }
  }
  const steps = optimizeCutOrder(items, { x: 400, y: 0 });
  const pos = new Map(steps.map((s, k) => [s.index, k]));
  let h = 0;
  items.forEach((it, i) => {
    if (it.pts.length === 4) return;
    assert.ok(pos.get(i)! < pos.get(outerOf[h])!, `hole ${i} after its part`);
    h++;
  });
});

test("nested: part in a hole of a frame comes first, then the hole, then the frame", () => {
  const frame = fixed(rect(0, 0, 200, 200));
  const hole = fixed(rect(20, 20, 180, 180));
  const inner = fixed(rect(60, 60, 140, 140));
  const innerHole = fixed(circle(100, 100, 15));
  const items = [frame, hole, inner, innerHole];
  const steps = optimizeCutOrder(items, { x: 0, y: 0 });
  assert.deepEqual(steps.map(s => s.index), [3, 2, 1, 0]);
});

test("open lines inside a part are engraved before the part is cut out", () => {
  const part = free(rect(0, 0, 100, 100));
  const line: CutItem = { entry: { x: 10, y: 50 }, exit: { x: 90, y: 50 }, pts: [{ x: 10, y: 50 }, { x: 90, y: 50 }], closed: false, reversible: true };
  const outsideLine: CutItem = { entry: { x: 150, y: 0 }, exit: { x: 150, y: 100 }, pts: [{ x: 150, y: 0 }, { x: 150, y: 100 }], closed: false, reversible: true };
  const steps = optimizeCutOrder([part, line, outsideLine], { x: 0, y: 0 });
  const pos = new Map(steps.map((s, k) => [s.index, k]));
  assert.ok(pos.get(1)! < pos.get(0)!);
});

test("open lines are driven in the cheaper direction", () => {
  const a: CutItem = { entry: { x: 100, y: 0 }, exit: { x: 0, y: 0 }, pts: [{ x: 100, y: 0 }, { x: 0, y: 0 }], closed: false, reversible: true };
  const steps = optimizeCutOrder([a], { x: 0, y: 0 });
  assert.equal(steps[0].reversed, true);
  assert.deepEqual(orientPts(a, steps[0])[0], { x: 0, y: 0 });
});

test("free start point moves to the closest corner, fixed start stays", () => {
  const sq = rect(100, 100, 150, 150);
  const fr = optimizeCutOrder([free(sq)], { x: 160, y: 160 });
  assert.deepEqual(orientPts(free(sq), fr[0])[0], { x: 150, y: 150 });
  const fx = optimizeCutOrder([fixed(sq)], { x: 160, y: 160 });
  assert.equal(fx[0].start, 0);
});

test("stays fast with many parts (time limit)", () => {
  const r = rng(11);
  const items: CutItem[] = [];
  for (let k = 0; k < 1500; k++) {
    const x = r() * 2000, y = r() * 1200;
    items.push(free(circle(x, y, 6, 32)));
    items.push(fixed(circle(x, y, 2, 16)));   // Loch darin
  }
  const t0 = performance.now();
  const steps = optimizeCutOrder(items, { x: 0, y: 0 }, 150);
  const ms = performance.now() - t0;
  assert.equal(steps.length, items.length);
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
  const pos = new Map(steps.map((s, k) => [s.index, k]));
  for (let k = 0; k < items.length; k += 2) assert.ok(pos.get(k + 1)! < pos.get(k)!, "hole before part");
});
