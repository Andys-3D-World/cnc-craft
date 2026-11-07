// Print & Cut: zwei Passmarken – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFit, fitProblem, orderMarks, twoPointFit } from "../src/editor/printCut.ts";

const P = (x: number, y: number) => ({ x, y });
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);

test("Nur verschoben: Marken landen genau auf den Messpunkten", () => {
  const f = twoPointFit(P(10, 10), P(110, 10), P(25, 40), P(125, 40));
  near(f.angle, 0);
  near(applyFit(f, P(10, 10)).x, 25);
  near(applyFit(f, P(110, 10)).y, 40);
  assert.equal(fitProblem(f), "");
});

test("Verdreht um 3°: beide Marken treffen, auch ein Punkt daneben dreht mit", () => {
  const rad = (3 * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const rot = (p: { x: number; y: number }) => P(5 + p.x * c - p.y * s, 7 + p.x * s + p.y * c);
  const a1 = P(0, 0), a2 = P(200, 100), q = P(50, 150);
  const f = twoPointFit(a1, a2, rot(a1), rot(a2));
  near(f.angle, rad);
  for (const p of [a1, a2, q]) {
    near(applyFit(f, p).x, rot(p).x);
    near(applyFit(f, p).y, rot(p).y);
  }
  near(f.lengthError, 0);
});

test("Längenfehler verteilt sich auf beide Marken und wird gemeldet", () => {
  const f = twoPointFit(P(0, 0), P(100, 0), P(-0.5, 0), P(100.5, 0));
  near(f.lengthError, 1);
  near(applyFit(f, P(0, 0)).x, -0, 1e-9);
  near(applyFit(f, P(100, 0)).x, 100);
  assert.equal(fitProblem(f), "");
});

test("Zu nah beieinander oder falsche Marke: wird abgelehnt", () => {
  assert.equal(fitProblem(twoPointFit(P(0, 0), P(5, 0), P(0, 0), P(5, 0))), "tooClose");
  assert.equal(fitProblem(twoPointFit(P(0, 0), P(100, 0), P(0, 0), P(120, 0))), "lengthOff");
  // in Welt-Pixeln (2 je mm): 15 Pixel sind nur 7,5 mm
  assert.equal(fitProblem(twoPointFit(P(0, 0), P(15, 0), P(0, 0), P(15, 0)), 2), "tooClose");
  assert.equal(fitProblem(twoPointFit(P(0, 0), P(25, 0), P(0, 0), P(25, 0)), 2), "");
});

test("Drehung über die halbe Runde bleibt im Bereich", () => {
  const f = twoPointFit(P(0, 0), P(100, 0), P(100, 0), P(0, 0));
  near(Math.abs(f.angle), Math.PI);
  near(applyFit(f, P(0, 0)).x, 100);
});

test("Marken-Reihenfolge: links zuerst, sonst unten", () => {
  assert.deepEqual(orderMarks(P(50, 0), P(10, 90)), [P(10, 90), P(50, 0)]);
  assert.deepEqual(orderMarks(P(10, 90), P(10, 5)), [P(10, 5), P(10, 90)]);
});
