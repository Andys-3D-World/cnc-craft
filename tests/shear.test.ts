// Scheren – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { createArc, createCircle, createPolyline, pathArea, shapeToPaths, shearShape } from "../src/shapeTransform.ts";

const P = (x: number, y: number) => ({ x, y });
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);

test("Waagerecht scheren: Unterkante bleibt am Bezug, Oberkante rückt", () => {
  const s = createPolyline([P(0, 0), P(10, 0), P(10, 10), P(0, 10)], true, "outside");
  shearShape(s, 0, 0, 0.5, 0);
  assert.deepEqual(s.points, [P(0, 0), P(10, 0), P(15, 10), P(5, 10)]);
  assert.equal(s.w, 15);
  near(Math.abs(pathArea(s.points)), 100); // Fläche bleibt gleich
});

test("Senkrecht scheren um eine Mitte", () => {
  const s = createPolyline([P(0, 0), P(10, 0)], false, "on-line");
  shearShape(s, 5, 0, 0, 1);
  assert.deepEqual(s.points, [P(0, -5), P(10, 5)]);
});

test("Kreis wird Linienzug (Ellipse), Bogen und Linie ebenfalls", () => {
  const c = createCircle(0, 0, 10);
  shearShape(c, 0, 0, 1, 0);
  assert.equal(c.type, "polyline");
  assert.equal(c.closed, true);
  near(Math.abs(pathArea(c.points)), Math.abs(pathArea(shapeToPaths(createCircle(0, 0, 10))[0].pts)), 1e-3);
  const a = createArc(10, 0, -10, 0, 0, 10);
  shearShape(a, 0, 0, 0.2, 0);
  assert.equal(a.type, "polyline");
  assert.equal(a.closed, false);
});

test("Kurvengriffe und gemerkte Text-Kurve gehen mit", () => {
  const s: any = createPolyline([P(0, 0), P(0, 10)], false, "on-line");
  s.bez = [{ x: 0, y: 0, ho: P(0, 5) }, { x: 0, y: 10 }];
  s.textPath = { pts: [P(0, 10)], closed: false };
  shearShape(s, 0, 0, 1, 0);
  assert.deepEqual(s.bez[0].ho, P(5, 5));
  assert.deepEqual(s.textPath.pts[0], P(10, 10));
});

test("Null-Scherung ändert nichts", () => {
  const s = createPolyline([P(1, 2), P(3, 4)], false, "on-line");
  shearShape(s, 7, 7, 0, 0);
  assert.deepEqual(s.points, [P(1, 2), P(3, 4)]);
});
