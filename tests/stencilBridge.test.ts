// Tests für Schablonen-Stege – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeIslands, findIslands, guessOuterIsPart, nesting, inside, type XY } from "../src/stencilBridge.ts";

const rect = (x0: number, y0: number, x1: number, y1: number): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const area = (r: XY[]) => Math.abs(r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
// Blech 100 × 100, darin ein Ausschnitt 20…80 mit einem losen Mittelstück 40…60 (wie ein eckiges O)
const sheet = rect(0, 0, 100, 100), hole = rect(20, 20, 80, 80), mid = rect(40, 40, 60, 60);

test("Verschachtelung und lose Mittelstücke", () => {
  const loops = [mid, sheet, hole];
  assert.deepEqual(nesting(loops).map(n => n.depth), [2, 0, 1]);
  assert.deepEqual(findIslands(loops, true), [{ loop: 0, hole: 2 }]);
  assert.equal(guessOuterIsPart(loops), true);
  // nur Ausschnitt + Mittelstück gewählt (Buchstabe ohne Blech): äußerste Kontur ist schon der Ausschnitt
  assert.equal(guessOuterIsPart([hole, mid]), false);
  assert.deepEqual(findIslands([hole, mid], false), [{ loop: 1, hole: 0 }]);
  assert.deepEqual(findIslands([hole, mid], true), [], "als Teil gelesen: nur ein Loch, nichts fällt heraus");
  assert.deepEqual(findIslands([sheet, hole], true), []);
});

test("ein Steg: der Ausschnitt wird eine einzige Kontur ohne Mittelstück, Fläche = Ring minus Steg", () => {
  const r = bridgeIslands([sheet, hole, mid], { width: 4, count: 1, angle: 90, outerIsPart: true });
  assert.equal(r.bridged, 1); assert.equal(r.loose, 0);
  assert.equal(r.cutouts.length, 1);
  assert.equal(r.cutouts[0].hole, 1); assert.deepEqual(r.cutouts[0].islands, [2]);
  assert.equal(r.cutouts[0].rings.length, 1);
  // Ring 60×60 − 20×20 = 3200, Steg 4 breit über 20 mm Spalt = 80
  assert.ok(Math.abs(area(r.cutouts[0].rings[0]) - (3200 - 80)) < 1e-6);
  // der Steg liegt oben in der Mitte: dort ist jetzt kein Ausschnitt mehr
  assert.equal(inside([50, 70], r.cutouts[0].rings[0]), false);
  assert.equal(inside([50, 30], r.cutouts[0].rings[0]), true);
});

test("zwei Stege teilen den Ausschnitt in zwei Stücke; Richtung automatisch = kürzester Weg", () => {
  const two = bridgeIslands([sheet, hole, mid], { width: 4, count: 2, angle: 0, outerIsPart: true });
  assert.equal(two.cutouts[0].rings.length, 2);
  assert.ok(Math.abs(two.cutouts[0].rings.reduce((s, q) => s + area(q), 0) - (3200 - 160)) < 1e-6);
  // Mittelstück nach rechts gerückt: der kürzeste Weg geht nach rechts (Spalt 5 statt 20)
  const right = rect(55, 40, 75, 60);
  const auto = bridgeIslands([sheet, hole, right], { width: 4, count: 1, angle: null, outerIsPart: true });
  assert.equal(auto.loose, 0);
  assert.ok(Math.abs(area(auto.cutouts[0].rings[0]) - (3200 - 4 * 5)) < 1e-6);
});

test("mehrere Mittelstücke in einem Ausschnitt (wie B oder 8) und nichts zu tun", () => {
  const a = rect(30, 30, 45, 70), b = rect(55, 30, 70, 70);
  const r = bridgeIslands([hole, a, b], { width: 3, count: 1, angle: null, outerIsPart: false });
  assert.equal(r.bridged, 2); assert.equal(r.loose, 0);
  assert.equal(r.cutouts[0].rings.length, 1);
  const none = bridgeIslands([sheet, hole], { width: 3, count: 1, angle: null, outerIsPart: true });
  assert.equal(none.cutouts.length, 0); assert.equal(none.bridged, 0);
  const zero = bridgeIslands([sheet, hole, mid], { width: 0, count: 1, angle: null, outerIsPart: true });
  assert.equal(zero.loose, 1); assert.equal(zero.cutouts.length, 0);
});

test("rundes O: Steg oben, Kontur bleibt geschlossen", () => {
  const circle = (r: number): XY[] => Array.from({ length: 72 }, (_, i) => [50 + r * Math.cos(i * Math.PI / 36), 50 + r * Math.sin(i * Math.PI / 36)] as XY);
  const r = bridgeIslands([circle(30), circle(18)], { width: 3, count: 1, angle: null, outerIsPart: false });
  assert.equal(r.loose, 0); assert.equal(r.cutouts[0].rings.length, 1);
  const ring = Math.PI * 0; void ring;
  const full = area(circle(30)) - area(circle(18));
  const got = area(r.cutouts[0].rings[0]);
  assert.ok(got < full && got > full - 3 * 13, `${got} < ${full}`);
});
