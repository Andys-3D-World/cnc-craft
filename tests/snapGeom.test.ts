// Fang: Schnitt-, Lot-, Tangenten- und Viertelpunkte – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { allIntersections, intersect, onCirc, perpFeet, primsNear, quadrants, tangentPts, type Circ, type Seg } from "../src/editor/snapGeom.ts";
import { createArc, createCircle, createPolyline } from "../src/shapeTransform.ts";

const P = (x: number, y: number) => ({ x, y });
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const nearPt = (p: { x: number; y: number }, x: number, y: number) => { near(p.x, x); near(p.y, y); };
const seg = (a: any, b: any, id = "s"): Seg => ({ k: "seg", a, b, id, i: 0 });
const circ = (x: number, y: number, r: number, id = "c", a0?: number, sweep?: number): Circ => ({ k: "circ", c: P(x, y), r, id, a0, sweep });

test("Zwei Strecken kreuzen sich", () => {
  const r = intersect(seg(P(0, 0), P(10, 10), "a"), seg(P(0, 10), P(10, 0), "b"));
  assert.equal(r.length, 1); nearPt(r[0], 5, 5);
});

test("Strecken, die sich nicht erreichen, und parallele: kein Schnittpunkt", () => {
  assert.equal(intersect(seg(P(0, 0), P(4, 4)), seg(P(0, 10), P(10, 0))).length, 0);
  assert.equal(intersect(seg(P(0, 0), P(10, 0)), seg(P(0, 1), P(10, 1))).length, 0);
});

test("Strecke durch einen Kreis: zwei exakte Punkte", () => {
  const r = intersect(seg(P(-20, 0), P(20, 0)), circ(0, 0, 10));
  assert.equal(r.length, 2);
  nearPt(r[0], -10, 0); nearPt(r[1], 10, 0);
});

test("Strecke berührt einen Kreis: ein Punkt", () => {
  const r = intersect(seg(P(-20, 10), P(20, 10)), circ(0, 0, 10));
  assert.equal(r.length, 1); nearPt(r[0], 0, 10);
});

test("Zwei Kreise schneiden sich in zwei Punkten", () => {
  const r = intersect(circ(0, 0, 10, "a"), circ(10, 0, 10, "b"));
  assert.equal(r.length, 2);
  for (const p of r) { near(p.x, 5); near(Math.abs(p.y), Math.sqrt(75)); }
});

test("Bogen: nur Punkte auf dem Bogen zählen", () => {
  const upper = circ(0, 0, 10, "a", 0, Math.PI);       // obere Hälfte, gegen den Uhrzeigersinn
  assert.ok(onCirc(upper, P(0, 10)));
  assert.ok(!onCirc(upper, P(0, -10)));
  const r = intersect(seg(P(0, -20), P(0, 20)), upper);
  assert.equal(r.length, 1); nearPt(r[0], 0, 10);
  const cw = circ(0, 0, 10, "b", 0, -Math.PI / 2);      // von 0° im Uhrzeigersinn bis -90°
  assert.ok(onCirc(cw, P(Math.SQRT1_2 * 10, -Math.SQRT1_2 * 10)));
  assert.ok(!onCirc(cw, P(0, 10)));
});

test("Rechteck: Ecken sind keine Schnittpunkte, eine Linie quer schon", () => {
  const rect = createPolyline([P(0, 0), P(20, 0), P(20, 10), P(0, 10)], true, "outside");
  const line = createPolyline([P(5, -5), P(5, 15)], false, "on-line");
  const prims = primsNear([rect, line], P(5, 0), 3);
  const pts = allIntersections(prims);
  assert.equal(pts.length, 1);
  nearPt(pts[0], 5, 0);
  // nur das Rechteck: keine Schnittpunkte an der Ecke
  assert.equal(allIntersections(primsNear([rect], P(0, 0), 3)).length, 0);
});

test("Bausteine: Kreis und Bogen bleiben exakt, weit weg liegende fallen raus", () => {
  const c = createCircle(0, 0, 10);
  const a = createArc(10, 0, -10, 0, 0, 10);
  const far = createPolyline([P(100, 100), P(120, 100)], false, "on-line");
  const prims = primsNear([c, a, far], P(10, 0.5), 2);
  assert.equal(prims.length, 2);
  assert.ok(prims.every(p => p.k === "circ"));
  const arc = prims.find(p => p.id === a.id) as Circ;
  near(arc.r, 10); assert.ok(arc.sweep !== undefined);
});

test("Lot: Fußpunkt auf einer Strecke, nicht außerhalb", () => {
  const f = perpFeet([seg(P(0, 0), P(10, 0))], P(3, 7));
  assert.equal(f.length, 1); nearPt(f[0], 3, 0);
  assert.equal(perpFeet([seg(P(0, 0), P(10, 0))], P(30, 7)).length, 0);
});

test("Lot auf einen Kreis: nächster und gegenüberliegender Punkt", () => {
  const f = perpFeet([circ(0, 0, 10)], P(20, 0));
  assert.equal(f.length, 2);
  nearPt(f[0], 10, 0); nearPt(f[1], -10, 0);
});

test("Tangente von außen an einen Kreis: zwei Punkte, rechter Winkel zum Radius", () => {
  const from = P(20, 0);
  const t = tangentPts([circ(0, 0, 10)], from);
  assert.equal(t.length, 2);
  for (const p of t) {
    near(Math.hypot(p.x, p.y), 10);
    near(p.x * (from.x - p.x) + p.y * (from.y - p.y), 0); // Radius ⟂ Tangente
  }
  assert.equal(tangentPts([circ(0, 0, 10)], P(3, 0)).length, 0); // von innen: keine
});

test("Viertelpunkte: Kreis vier, Halbbogen nur die auf dem Bogen", () => {
  assert.equal(quadrants(circ(0, 0, 5)).length, 4);
  const q = quadrants(circ(0, 0, 5, "a", 0.1, Math.PI - 0.2));
  assert.equal(q.length, 1); nearPt(q[0], 0, 5);
});
