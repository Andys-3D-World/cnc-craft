// Zeichenformen: Stern, Langloch, Ring, Bogen mit Mittelpunkt – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { centerArc, ringInner, slotPoints, starPoints } from "../src/editor/drawShapes.ts";
import { arcGeometry, createArc, pathArea } from "../src/shapeTransform.ts";

const P = (x: number, y: number) => ({ x, y });
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);

test("Stern: doppelt so viele Punkte wie Zacken, Radien wechseln, erste Spitze zeigt zur Maus", () => {
  const s = starPoints(10, 20, 50, 5, 0.4, Math.PI / 2);
  assert.equal(s.length, 10);
  near(s[0].x, 10); near(s[0].y, 70);
  s.forEach((p, i) => near(Math.hypot(p.x - 10, p.y - 20), i % 2 ? 20 : 50));
});

test("Stern: Werte außerhalb werden begrenzt", () => {
  assert.equal(starPoints(0, 0, 10, 1, 0.5, 0).length, 6);
  near(Math.hypot(starPoints(0, 0, 10, 5, 2, 0)[1].x, starPoints(0, 0, 10, 5, 2, 0)[1].y), 9.5);
});

test("Langloch waagerecht: Maße und Fläche stimmen, keine doppelten Punkte", () => {
  const s = slotPoints(0, 0, 100, 20);
  const xs = s.map(p => p.x), ys = s.map(p => p.y);
  near(Math.min(...xs), 0); near(Math.max(...xs), 100);
  near(Math.min(...ys), 0); near(Math.max(...ys), 20);
  near(Math.abs(pathArea(s)), 80 * 20 + Math.PI * 100, 1); // Rechteck + zwei Halbkreise
  s.forEach((p, i) => { const q = s[(i + 1) % s.length]; assert.ok(Math.hypot(p.x - q.x, p.y - q.y) > 1e-9); });
});

test("Langloch senkrecht und rückwärts gezogen", () => {
  const s = slotPoints(30, 100, 10, 0);
  near(Math.min(...s.map(p => p.x)), 10); near(Math.max(...s.map(p => p.x)), 30);
  near(Math.abs(pathArea(s)), 80 * 20 + Math.PI * 100, 1);
});

test("Ring: Innenradius, zu dicke Wand ergibt kein Loch", () => {
  assert.equal(ringInner(20, 5), 15);
  assert.equal(ringInner(5, 5), null);
  assert.equal(ringInner(5, 9), null);
  assert.equal(ringInner(5, 0), null);
});

test("Bogen mit Mittelpunkt: Viertelkreis gegen den Uhrzeigersinn", () => {
  const a = centerArc(P(0, 0), P(10, 0), P(0, 25), true)!;
  near(a.radius, 10); near(a.sweep, Math.PI / 2);
  near(a.end.x, 0); near(a.end.y, 10);
  near(a.mid.x, 10 * Math.SQRT1_2); near(a.mid.y, 10 * Math.SQRT1_2);
});

test("Andere Richtung läuft um die andere Seite", () => {
  const a = centerArc(P(0, 0), P(10, 0), P(0, 25), false)!;
  near(a.sweep, -1.5 * Math.PI);
  near(a.mid.x, -10 * Math.SQRT1_2); near(a.mid.y, -10 * Math.SQRT1_2);
});

test("Ergibt einen echten Bogen über 180° mit demselben Mittelpunkt", () => {
  const a = centerArc(P(5, 5), P(15, 5), P(5, -20), true)!;
  const g = arcGeometry(createArc(a.start.x, a.start.y, a.end.x, a.end.y, a.mid.x, a.mid.y))!;
  near(g.cx, 5, 1e-6); near(g.cy, 5, 1e-6); near(g.r, 10, 1e-6);
  near(Math.abs(g.sweep), 1.5 * Math.PI, 1e-6);
});

test("Winkelraster und ungültige Eingaben", () => {
  const a = centerArc(P(0, 0), P(10, 0), P(10, 10.5), true, Math.PI / 12)!;
  near(a.sweep, Math.PI / 4);
  assert.equal(centerArc(P(0, 0), P(0, 0), P(5, 5), true), null);
  assert.equal(centerArc(P(0, 0), P(10, 0), P(20, 0), true), null);
});
