// Array: Raster und Kreis – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridOffsets, gridStep, polarPlacements, polarStep } from "../src/editor/arrayGeom.ts";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test("Raster: 3 × 2 ergibt 5 Kopien ohne das Original", () => {
  const o = gridOffsets(3, 2, 10, 20);
  assert.equal(o.length, 5);
  assert.ok(!o.some(p => p.dx === 0 && p.dy === 0));
  assert.deepEqual(o[o.length - 1], { col: 2, row: 1, dx: 20, dy: 20 });
});

test("Raster: 1 × 1 ergibt keine Kopie, negative Schritte gehen nach links/unten", () => {
  assert.equal(gridOffsets(1, 1, 10, 10).length, 0);
  assert.deepEqual(gridOffsets(2, 1, -7, 0)[0], { col: 1, row: 0, dx: -7, dy: 0 });
});

test("Abstand: frei zwischen den Teilen oder Mitte zu Mitte", () => {
  assert.equal(gridStep("gap", 30, 5), 35);
  assert.equal(gridStep("pitch", 30, 50), 50);
});

test("Kreis: voller Kreis legt die letzte Kopie nicht auf das Original", () => {
  near(polarStep(4, Math.PI * 2), Math.PI / 2);
  const p = polarPlacements(4, 0, 0, { x: 10, y: 0 }, Math.PI * 2);
  assert.equal(p.length, 3);
  near(p[0].dx, -10); near(p[0].dy, 10);   // 90°: (10,0) → (0,10)
  near(p[1].dx, -20); near(p[1].dy, 0);    // 180°
  near(p[2].dx, -10); near(p[2].dy, -10);  // 270°
});

test("Kreis: Teilkreis trifft den Endwinkel genau", () => {
  near(polarStep(3, Math.PI), Math.PI / 2);
  const p = polarPlacements(3, 5, 5, { x: 15, y: 5 }, Math.PI);
  near(p[1].angle, Math.PI);
  near(p[1].dx, -20); near(p[1].dy, 0);
});

test("Kreis: alle Kopien bleiben auf dem Radius, auch mit Mittelpunkt außerhalb", () => {
  const from = { x: 12, y: -3 }, cx = 40, cy = 25;
  const r = Math.hypot(from.x - cx, from.y - cy);
  for (const q of polarPlacements(7, cx, cy, from, Math.PI * 2)) {
    near(Math.hypot(from.x + q.dx - cx, from.y + q.dy - cy), r);
  }
});

test("Kreis: negativer Winkel läuft im Uhrzeigersinn, 1 Stück ergibt nichts", () => {
  assert.equal(polarPlacements(1, 0, 0, { x: 1, y: 0 }, Math.PI * 2).length, 0);
  const p = polarPlacements(2, 0, 0, { x: 10, y: 0 }, -Math.PI);
  near(p[0].angle, -Math.PI);
});
