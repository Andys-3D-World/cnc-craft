// Verbinden, Auflösen, Strecken, Ortho, Bezugsmaß – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { explodePath, joinOpen, orthoPoint, refFactor, stretchPoints } from "../src/editor/joinExplode.ts";

const P = (x: number, y: number) => ({ x, y });

test("Verbinden: drei Stücke in beliebiger Richtung werden ein offener Zug", () => {
  const r = joinOpen([{ ref: "a", pts: [P(0, 0), P(10, 0)] }, { ref: "c", pts: [P(10, 10), P(20, 10)] }, { ref: "b", pts: [P(10, 10), P(10, 0)] }], 0.01);
  assert.equal(r.length, 1);
  assert.equal(r[0].closed, false);
  assert.deepEqual(r[0].pts, [P(0, 0), P(10, 0), P(10, 10), P(20, 10)]);
  assert.deepEqual(r[0].from.sort(), ["a", "b", "c"]);
});

test("Verbinden: vier Seiten werden ein geschlossenes Viereck (ohne doppelten Endpunkt)", () => {
  const r = joinOpen([{ ref: 1, pts: [P(0, 0), P(10, 0)] }, { ref: 2, pts: [P(10, 0), P(10, 10)] }, { ref: 3, pts: [P(0, 10), P(10, 10)] }, { ref: 4, pts: [P(0, 10), P(0, 0.005)] }], 0.01);
  assert.equal(r.length, 1);
  assert.equal(r[0].closed, true);
  assert.equal(r[0].pts.length, 4);
});

test("Verbinden: was nicht passt, bleibt einzeln", () => {
  const r = joinOpen([{ ref: 1, pts: [P(0, 0), P(10, 0)] }, { ref: 2, pts: [P(50, 50), P(60, 50)] }], 0.01);
  assert.equal(r.length, 2);
});

test("Auflösen: Zug in Strecken, geschlossen mit Schlussstück", () => {
  assert.equal(explodePath([P(0, 0), P(10, 0), P(10, 10)], false).length, 2);
  assert.equal(explodePath([P(0, 0), P(10, 0), P(10, 10), P(0, 10)], true).length, 4);
  assert.equal(explodePath([P(0, 0), P(0, 0), P(5, 0)], false).length, 1);
});

test("Strecken: nur Punkte im Rechteck wandern", () => {
  const r = stretchPoints([P(0, 0), P(10, 0), P(10, 5), P(0, 5)], { x0: 8, y0: -1, x1: 12, y1: 6 }, 20, 0)!;
  assert.deepEqual(r, [P(0, 0), P(30, 0), P(30, 5), P(0, 5)]);
  assert.equal(stretchPoints([P(0, 0)], { x0: 5, y0: 5, x1: 6, y1: 6 }, 1, 1), null);
});

test("Bezugsmaß und Ortho", () => {
  assert.equal(refFactor(50, 100), 2);
  assert.equal(refFactor(0, 100), null);
  assert.deepEqual(orthoPoint(P(0, 0), P(10, 3)), P(10, 0));
  assert.deepEqual(orthoPoint(P(0, 0), P(2, -9)), P(0, -9));
});
