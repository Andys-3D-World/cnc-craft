// Tests für die Formen des Rohteils – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { faces, perimeter, cornerRadius, refRadius, minRadius, faceAt, sectionAt, surfaceRadius, coneRadius, coneCenter, type RotaryStock } from "../src/rotaryStock.ts";

const base: RotaryStock = { shape: "round", diameter: 40, width: 20, height: 40, sides: 6, flats: 30, d0: 40, d1: 20, coneLen: 100 };
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);

test("rund: Umfang, Radius, keine Flächen", () => {
  near(perimeter(base), Math.PI * 40); near(cornerRadius(base), 20);
  assert.equal(faces(base).length, 0);
  near(surfaceRadius(base, 0, 1), 20);
});

test("rechteckig: vier Flächen mit Breite und Abstand zur Achse", () => {
  const s = { ...base, shape: "rect" as const };
  const f = faces(s);
  assert.deepEqual(f.map(q => q.width), [20, 40, 20, 40]);
  assert.deepEqual(f.map(q => q.apothem), [20, 10, 20, 10]);
  assert.deepEqual(f.map(q => q.angle), [0, 90, 180, 270]);
  near(perimeter(s), 120); near(cornerRadius(s), Math.hypot(10, 20));
  near(refRadius(s), 20); near(minRadius(s), 10);
  assert.equal(faceAt(f, 25).face.k, 1);
  assert.equal(faceAt(f, 25).center, 40);
  // über den Umfang hinaus: wieder Fläche 1, Mitte um den Umfang versetzt
  assert.equal(faceAt(f, 125).face.k, 0);
  assert.equal(faceAt(f, 125).center, 130);
});

test("Vieleck: Sechskant aus Schlüsselweite", () => {
  const s = { ...base, shape: "poly" as const };
  const f = faces(s);
  assert.equal(f.length, 6);
  near(f[0].width, 30 * Math.tan(Math.PI / 6));
  near(cornerRadius(s), 15 / Math.cos(Math.PI / 6));
  near(perimeter(s), 6 * f[0].width);
  // Ecke des Querschnitts liegt auf dem Eckradius, Fläche 1 waagerecht oben
  const sec = sectionAt(s, 0);
  assert.equal(sec.length, 6);
  near(sec[0][1], sec[1][1]); near(sec[0][1], 15);
  near(Math.hypot(...sec[2]), cornerRadius(s));
  near(surfaceRadius(s, 0, 0), 15);
  near(surfaceRadius(s, 0, Math.PI / 6), cornerRadius(s));
});

test("Kegel: Radius läuft mit, außerhalb bleibt das Endmaß", () => {
  const s = { ...base, shape: "cone" as const };
  near(coneRadius(s, 0), 20); near(coneRadius(s, 50), 15); near(coneRadius(s, 100), 10); near(coneRadius(s, 200), 10);
  near(perimeter(s), Math.PI * 40); near(coneCenter(s), Math.PI * 20);
  near(refRadius(s), 20); near(minRadius(s), 10);
});
