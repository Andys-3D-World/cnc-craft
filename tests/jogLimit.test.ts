// Tests für die Grenze beim manuellen Fahren – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampJog } from "../src/jogLimit.ts";

const bed = { w: 205, h: 300 };

test("Schritt über den Bettrand wird bis zum Rand gekürzt", () => {
  const r = clampJog([150, 10, 0], [100, 0, 0], bed);
  assert.deepEqual(r.delta, [55, 0, 0]);
  assert.deepEqual(r.clamped, [0]);
  assert.deepEqual(clampJog([5, 10, 0], [0, -100, 0], bed).delta, [0, -10, 0]);
});

test("innerhalb des Betts und Z bleiben unverändert", () => {
  const r = clampJog([100, 100, 0], [10, -10, -50], bed);
  assert.deepEqual(r.delta, [10, -10, -50]);
  assert.deepEqual(r.clamped, []);
});

test("am Rand geht es nicht weiter, außerhalb nur zurück Richtung Bett", () => {
  assert.deepEqual(clampJog([205, 0, 0], [10, 0, 0], bed).delta, [0, 0, 0]);
  assert.deepEqual(clampJog([250, 0, 0], [10, 0, 0], bed).delta, [0, 0, 0]);
  assert.deepEqual(clampJog([250, 0, 0], [-10, 0, 0], bed).delta, [-10, 0, 0]);
  assert.deepEqual(clampJog([-20, 0, 0], [-10, 0, 0], bed).delta, [0, 0, 0]);
});
