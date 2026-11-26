// Eine Ecke verrunden/fasen, Linien verlängern – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { extendTo, filletCorner, nearestCorner } from "../src/editor/cornerOps.ts";
import type { Prim } from "../src/editor/snapGeom.ts";

const P = (x: number, y: number) => ({ x, y });
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const square = [P(0, 0), P(100, 0), P(100, 50), P(0, 50)];

test("Ecke finden: nur in der Nähe, offene Linien ohne Anfang/Ende", () => {
  assert.equal(nearestCorner(square, true, P(98, 2), 5), 1);
  assert.equal(nearestCorner(square, true, P(50, 25), 5), -1);
  const open = [P(0, 0), P(10, 0), P(10, 10)];
  assert.equal(nearestCorner(open, false, P(0, 0), 5), -1);
  assert.equal(nearestCorner(open, false, P(10, 1), 5), 1);
});

test("Rechte Ecke R10: Berührpunkte 10 von der Ecke, Bogen genau Radius 10 um (90,10)", () => {
  const r = filletCorner(square, true, 1, 10, false, 0.001);
  assert.equal(r.error, undefined);
  const arc = r.arc!;
  near(arc[0].x, 90); near(arc[0].y, 0);
  near(arc[arc.length - 1].x, 100); near(arc[arc.length - 1].y, 10);
  for (const p of arc) near(Math.hypot(p.x - 90, p.y - 10), 10);
  // nur diese Ecke ist geändert, die anderen bleiben
  assert.deepEqual(r.pts[0], P(0, 0));
  assert.deepEqual(r.pts.slice(-2), [P(100, 50), P(0, 50)]);
  assert.ok(!r.pts.some(p => p.x === 100 && p.y === 0));
});

test("Fase 5: zwei Punkte statt der Ecke", () => {
  const r = filletCorner(square, true, 2, 5, true);
  assert.deepEqual(r.arc, [P(100, 45), P(95, 50)]);
  assert.deepEqual(r.pts, [P(0, 0), P(100, 0), P(100, 45), P(95, 50), P(0, 50)]);
});

test("Ecke 0 einer geschlossenen Form: Reihenfolge stimmt", () => {
  const r = filletCorner(square, true, 0, 5, true);
  assert.deepEqual(r.pts, [P(0, 5), P(5, 0), P(100, 0), P(100, 50), P(0, 50)]);
});

test("Zu großer Radius: Meldung, nichts geändert", () => {
  const r = filletCorner(square, true, 1, 60, false);
  assert.equal(r.error, "tooBig");
  assert.equal(r.pts, square);
});

test("Radius genau so lang wie die Kante: kein doppelter Punkt", () => {
  const r = filletCorner(square, true, 2, 50, true);
  assert.equal(r.error, undefined);
  for (let i = 0; i < r.pts.length; i++) {
    const a = r.pts[i], b = r.pts[(i + 1) % r.pts.length];
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 1e-9, "doppelter Punkt");
  }
});

test("Gerade weiterlaufende Linie: nichts zu verrunden", () => {
  assert.equal(filletCorner([P(0, 0), P(10, 0), P(20, 0)], false, 1, 2, false).error, "straight");
});

test("Spitzer Winkel: Bogen berührt beide Kanten", () => {
  const pts = [P(0, 0), P(100, 0), P(0, 40)];
  const r = filletCorner(pts, false, 1, 5, false, 0.001);
  assert.equal(r.error, undefined);
  const a = r.arc!, t1 = a[0], t2 = a[a.length - 1];
  near(t1.y, 0); // erster Berührpunkt auf der unteren Kante
  // zweiter Berührpunkt auf der Linie (100,0)-(0,40)
  near((t2.x - 100) * 40 - (t2.y - 0) * -100, 0, 1e-6);
});

const seg = (a: any, b: any, id = "t"): Prim => ({ k: "seg", a, b, id, i: 0 });

test("Verlängern bis zur nächsten Linie, nicht zur weiteren", () => {
  const line = [P(0, 0), P(10, 0)];
  const to = extendTo(line, "end", [seg(P(50, -10), P(50, 10)), seg(P(30, -10), P(30, 10))], 1e6);
  assert.deepEqual(to, P(30, 0));
});

test("Verlängern am Anfang: rückwärts", () => {
  const to = extendTo([P(10, 0), P(20, 0)], "start", [seg(P(-5, -10), P(-5, 10)), seg(P(40, -10), P(40, 10))], 1e6);
  assert.deepEqual(to, P(-5, 0));
});

test("Verlängern bis an einen Kreis", () => {
  const to = extendTo([P(0, 0), P(10, 0)], "end", [{ k: "circ", c: P(50, 0), r: 10, id: "c" }], 1e6)!;
  near(to.x, 40); near(to.y, 0);
});

test("Nichts in der Richtung: null", () => {
  assert.equal(extendTo([P(0, 0), P(10, 0)], "end", [seg(P(-50, -10), P(-50, 10))], 1e6), null);
  assert.equal(extendTo([P(0, 0), P(10, 0)], "end", [seg(P(50, 5), P(60, 5))], 1e6), null);
});
