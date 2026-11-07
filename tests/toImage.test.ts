// In Bild umwandeln: Bildgröße und Umrechnung – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { rasterPlan } from "../src/editor/toImage.ts";

const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const box = (wMm: number, hMm: number) => ({ minX: 20, minY: 40, maxX: 20 + wMm * 2, maxY: 40 + hMm * 2 });

test("254 DPI = 10 Punkte je mm = 0,1 mm Linienabstand", () => {
  const p = rasterPlan(box(100, 50), 254);
  assert.equal(p.pw, 1000);
  assert.equal(p.ph, 500);
  near(p.intervalMm, 0.1);
  assert.equal(p.limited, false);
});

test("Ecken der Zeichnung landen auf den Bildecken, Y gedreht", () => {
  const b = box(100, 50), p = rasterPlan(b, 254);
  assert.deepEqual(p.toPixel(b.minX, b.maxY), { x: 0, y: 0 });
  const c = p.toPixel(b.maxX, b.minY);
  near(c.x, 1000); near(c.y, 500);
});

test("Riesige Zeichnung wird begrenzt, Seitenverhältnis bleibt", () => {
  const p = rasterPlan(box(2000, 1000), 1000);
  assert.equal(p.limited, true);
  assert.equal(p.pw, 8000);
  assert.equal(p.ph, 4000);
  near(p.intervalMm, 0.25);
});

test("Winzige Maße ergeben mindestens einen Bildpunkt", () => {
  const p = rasterPlan({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, 10);
  assert.ok(p.pw >= 1 && p.ph >= 1);
});
