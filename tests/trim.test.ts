// Trim: Linienstück bis zum nächsten Schnittpunkt entfernen – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { intersections, nearestStation, normalizePath, pathLength, remainingSpans, slicePath, trimShape, trimSpan } from "../src/editor/trim.ts";
import { createArc, createCircle, createPolyline, shapeToPaths } from "../src/shapeTransform.ts";

const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const P = (x: number, y: number) => ({ x, y });
const open = (...p: [number, number][]) => ({ pts: p.map(([x, y]) => P(x, y)), closed: false });
const line = (x0: number, y0: number, x1: number, y1: number) => ({ id: "l", type: "line", x: x0, y: y0, w: x1 - x0, h: y1 - y0, millingMode: "on-line" });

test("Kreuzende Linie: Mittelstück zwischen zwei Schnitten fällt weg, zwei Enden bleiben", () => {
  const cutters = [open([20, -5], [20, 5]), open([60, -5], [60, 5])];
  const r = trimShape(line(0, 0, 100, 0), cutters, P(40, 0))!;
  assert.equal(r.pieces.length, 2);
  assert.deepEqual(shapeToPaths(r.pieces[0])[0].pts, [P(0, 0), P(20, 0)]);
  assert.deepEqual(shapeToPaths(r.pieces[1])[0].pts, [P(60, 0), P(100, 0)]);
  near(pathLength({ pts: r.removed, closed: false }), 40);
});

test("Endstück: bis zum Linienende, ein Teil bleibt", () => {
  const r = trimShape(line(0, 0, 100, 0), [open([20, -5], [20, 5])], P(5, 0))!;
  assert.equal(r.pieces.length, 1);
  assert.deepEqual(shapeToPaths(r.pieces[0])[0].pts, [P(20, 0), P(100, 0)]);
});

test("Ohne Schnittpunkt bleibt alles stehen", () => {
  assert.equal(trimShape(line(0, 0, 100, 0), [open([20, 5], [20, 15])], P(5, 0)), null);
});

test("DXF: Linien, die sich nur an den Enden treffen, zählen nicht als Schnitt", () => {
  const p = open([0, 0], [100, 0]);
  assert.deepEqual(intersections(p, [open([100, 0], [100, 50]), open([0, 0], [0, 50])]), []);
  // aber eine Linie, die in der Mitte anstößt (T-Stoß), mit kleinem Rundungsfehler
  assert.deepEqual(intersections(p, [open([40, 0.005], [40, 50])]).map(Math.round), [40]);
});

test("Polylinie: Stück über Ecken hinweg bleibt in der Form", () => {
  const s = createPolyline([P(0, 0), P(50, 0), P(50, 50), P(100, 50)], false, "on-line");
  const r = trimShape(s, [open([25, -5], [25, 5]), open([45, 45], [55, 45]), open([75, 45], [75, 55])], P(50, 20))!;
  assert.equal(r.pieces.length, 2);
  assert.deepEqual(shapeToPaths(r.pieces[0])[0].pts, [P(0, 0), P(25, 0)]);
  assert.deepEqual(r.removed, [P(25, 0), P(50, 0), P(50, 45)]);
  assert.deepEqual(shapeToPaths(r.pieces[1])[0].pts[0], P(50, 45));
});

test("Selbstkreuzung zählt als Schnittpunkt, Nachbar-Segmente nicht", () => {
  const p = open([0, 0], [100, 0], [100, 50], [50, 50], [50, -50]);
  const c = intersections(p, []);
  assert.equal(c.length, 2); // einmal beim Hinweg, einmal beim Rückweg
  near(c[0], 50);
  assert.deepEqual(intersections(open([0, 0], [10, 0], [10, 10]), []), []);
});

test("Geschlossenes Rechteck: Stück fällt weg, Rest wird eine offene Kontur über die Naht", () => {
  const s = createPolyline([P(0, 0), P(100, 0), P(100, 50), P(0, 50)], true, "outside");
  const r = trimShape(s, [open([30, -5], [30, 5]), open([70, -5], [70, 5])], P(50, 0))!;
  assert.equal(r.pieces.length, 1);
  const pts = shapeToPaths(r.pieces[0])[0];
  assert.equal(pts.closed, false);
  assert.deepEqual(pts.pts, [P(70, 0), P(100, 0), P(100, 50), P(0, 50), P(0, 0), P(30, 0)]);
  assert.equal(r.pieces[0].millingMode, "on-line");
  near(pathLength({ pts: r.removed, closed: false }), 40);
});

test("Geschlossen: Stück über die Naht und einzelner Schnitt", () => {
  const rect = { pts: [P(0, 0), P(100, 0), P(100, 100), P(0, 100)], closed: true };
  const sp = trimSpan(400, true, [50, 350], 10)!;
  assert.deepEqual(sp, { from: 350, to: 450 });
  assert.deepEqual(slicePath(rect, sp), [P(0, 50), P(0, 0), P(50, 0)]);
  assert.deepEqual(remainingSpans(400, true, sp), [{ from: 450, to: 750 }]);
  assert.deepEqual(slicePath(rect, { from: 450, to: 750 }), [P(50, 0), P(100, 0), P(100, 100), P(0, 100), P(0, 50)]);
  assert.equal(trimSpan(400, true, [50], 10), null);
});

test("Bogen bleibt Bogen und liegt auf demselben Kreis", () => {
  const a = createArc(10, 0, -10, 0, 0, 10); // Halbkreis oben, Radius 10
  const r = trimShape(a, [open([0, 5], [0, 15])], P(9, 4))!;
  assert.equal(r.pieces.length, 1);
  const b = r.pieces[0];
  assert.equal(b.type, "arc");
  for (const q of shapeToPaths(b)[0].pts) near(Math.hypot(q.x, q.y), 10, 0.02);
  near(b.x, 0, 0.05); near(b.y, 10, 0.05);
  near(b.x + b.w, -10, 0.001);
});

test("Kreis wird zum Bogen: das andere Stück bleibt", () => {
  const c = createCircle(0, 0, 10);
  const r = trimShape(c, [open([-20, 0], [20, 0])], P(0, 10))!;
  assert.equal(r.pieces.length, 1);
  const b = r.pieces[0];
  assert.equal(b.type, "arc");
  near(b.midY, -10, 0.05);
  for (const q of shapeToPaths(b)[0].pts) { near(Math.hypot(q.x, q.y), 10, 0.02); assert.ok(q.y <= 0.05); }
});

test("Offene Kontur mit gleichem Anfang und Ende gilt als geschlossen", () => {
  const n = normalizePath(open([0, 0], [10, 0], [10, 10], [0, 0]));
  assert.equal(n.closed, true);
  assert.equal(n.pts.length, 3);
});

test("Station: nächster Punkt und Eigenschaften werden übernommen", () => {
  near(nearestStation(open([0, 0], [10, 0], [10, 10]), P(12, 5)).s, 15);
  const s = { ...line(0, 0, 100, 0), laserLayerId: "L1", groupId: "g", textData: { text: "x" } };
  const r = trimShape(s, [open([20, -5], [20, 5])], P(5, 0))!;
  assert.equal(r.pieces[0].laserLayerId, "L1");
  assert.equal(r.pieces[0].groupId, "g");
  assert.equal(r.pieces[0].textData, undefined);
});

test("Lange Kontur bleibt schnell", () => {
  const pts = Array.from({ length: 20000 }, (_, i) => P(i * 0.1, Math.sin(i * 0.01) * 20));
  const t0 = Date.now();
  assert.ok(intersections({ pts, closed: false }, [open([500, -50], [500, 50])]).length >= 1);
  assert.ok(Date.now() - t0 < 2000);
});
