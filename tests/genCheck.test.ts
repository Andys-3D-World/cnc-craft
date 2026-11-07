// Prüfung von Generator-Ergebnissen – läuft mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPoints, thinnestWeb, outsideBed, minWebFor } from "../src/genCheck.ts";

const square = (x: number, y: number, s: number) => ({ closed: true, pts: [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }] });

test("Punkte fast aufeinander fallen weg, der Rest bleibt gleich", () => {
  const p = [{ x: 0, y: 0 }, { x: 0.001, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }];
  assert.deepEqual(cleanPoints(p, false, 0.01), [p[0], p[2], p[3]]);
});

test("geschlossener Pfad: letzter Punkt auf dem ersten fällt weg", () => {
  const p = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 0 }];
  assert.equal(cleanPoints(p, true, 0.01).length, 3);
});

test("winzige Form bleibt unverändert, statt zum Punkt zu werden", () => {
  const p = [{ x: 0, y: 0 }, { x: 0.001, y: 0 }, { x: 0, y: 0.001 }];
  assert.equal(cleanPoints(p, true, 0.01), p);
});

test("Steg: von Hand gerechnet 0,5 mm zwischen zwei Quadraten", () => {
  const w = thinnestWeb([square(0, 0, 10), square(10.5, 2, 5)], 1);
  assert.ok(Math.abs(w! - 0.5) < 1e-9);
});

test("Steg: Loch im Teil zählt auch, weiter weg als die Grenze = null", () => {
  assert.ok(Math.abs(thinnestWeb([square(0, 0, 20), square(0.3, 5, 5)], 1)! - 0.3) < 1e-9);
  assert.equal(thinnestWeb([square(0, 0, 10), square(13, 0, 5)], 1), null);
});

test("derselbe Pfad zählt nicht als Steg, auch nicht in schmalen Stellen", () => {
  assert.equal(thinnestWeb([{ closed: true, pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0.2 }, { x: 0, y: 0.2 }] }], 1), null);
});

test("Bett: passt genau, ragt rechts drüber, ragt links drüber", () => {
  assert.equal(outsideBed([square(0, 0, 300)], 300, 300), null);
  assert.deepEqual(outsideBed([square(0, 0, 301)], 300, 300), { w: 301, h: 301 });
  assert.ok(outsideBed([square(-1, 0, 10)], 300, 300));
});

test("Grenze je Maschinenart", () => {
  assert.ok(minWebFor("laser") < minWebFor("mill") && minWebFor("mill") < minWebFor("plasma"));
});
