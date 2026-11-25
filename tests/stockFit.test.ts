// Passt der Auftrag ins Rohteil? – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { countOutside, deepestZ } from "../src/stockFit.ts";

test("Umrisse über den Rand hinaus", () => {
  const s = { x: 10, y: 0, w: 100, h: 50 };
  assert.equal(countOutside([{ x0: 10, y0: 0, x1: 110, y1: 50 }], s), 0);
  assert.equal(countOutside([{ x0: 5, y0: 5, x1: 20, y1: 20 }, { x0: 20, y0: 20, x1: 30, y1: 30 }, { x0: 20, y0: 40, x1: 30, y1: 51 }], s), 2);
});

test("Tiefste Stelle: Antasten, Maschinen-Koordinaten, Nullpunkte, relative Wege und Kommentare zählen nicht", () => {
  assert.equal(deepestZ("G0 Z5\nG1 Z-3.5 F100\nG1 X10\nG1 Z-2"), -3.5);
  assert.equal(deepestZ("G38.2 Z-25 F50\nG53 G0 Z-90\nG10 L2 P1 Z-40\nG92 Z-10\nG1 Z-1 (Z-99)"), -1);
  assert.equal(deepestZ("G91\nG1 Z-20\nG90\nG1 Z-2\n; Z-50"), -2);
  assert.equal(deepestZ("G17 G21 G90 G94\nG1 X1 Y1 Z-4.25"), -4.25);
  assert.equal(deepestZ("G0 X1"), 0);
});
