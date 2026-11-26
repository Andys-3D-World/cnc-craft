// 3D-Körper aus Extrudieren/Ausschneiden – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MultiPolygon } from "polygon-clipping";
import { bodyShells, slabs, topOf, volume, zRange, type EvalFeat } from "../src/editor/body3d.ts";
import { stlBinary } from "../src/view3d/solid.ts";

const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const rect = (x0: number, y0: number, x1: number, y1: number): MultiPolygon => [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]];
const join = (region: MultiPolygon, z0: number, z1: number): EvalFeat => ({ op: "join", z0, z1, region });
const cut = (region: MultiPolygon, z0: number, z1: number): EvalFeat => ({ op: "cut", z0, z1, region });

test("Von–bis: Höhe nach oben und nach unten", () => {
  assert.deepEqual(zRange({ z0: 0, h: 10 }), [0, 10]);
  assert.deepEqual(zRange({ z0: 10, h: -4 }), [6, 10]);
});

test("Platte: Rauminhalt und eine Scheibe", () => {
  const f = [join(rect(0, 0, 100, 50), 0, 10)];
  assert.equal(slabs(f).length, 1);
  near(volume(f), 100 * 50 * 10);
  near(topOf(f), 10);
});

test("Tasche: 20×20 und 4 tief von oben", () => {
  const f = [join(rect(0, 0, 100, 50), 0, 10), cut(rect(40, 15, 60, 35), 6, 10)];
  near(volume(f), 100 * 50 * 10 - 20 * 20 * 4);
  const s = slabs(f);
  assert.equal(s.length, 2);
  near(s[0].z1, 6); near(s[1].z0, 6);
});

test("Durchgangsloch: Ausschneiden über die ganze Höhe", () => {
  const f = [join(rect(0, 0, 100, 50), 0, 10), cut(rect(10, 10, 20, 20), -1, 11)];
  near(volume(f), 100 * 50 * 10 - 10 * 10 * 10);
  assert.equal(slabs(f).length, 1); // gleiche Scheiben zusammengefasst
});

test("Reihenfolge zählt: erst Loch, dann wieder auffüllen", () => {
  const plate = join(rect(0, 0, 100, 50), 0, 10), hole = cut(rect(10, 10, 20, 20), 0, 10), fill = join(rect(10, 10, 20, 20), 0, 10);
  near(volume([plate, hole, fill]), 100 * 50 * 10);
  near(volume([plate, fill, hole]), 100 * 50 * 10 - 1000);
});

test("Zapfen obendrauf und Absatz nach unten", () => {
  const f = [join(rect(0, 0, 100, 50), 0, 10), join(rect(40, 15, 60, 35), 10, 25)];
  near(volume(f), 50000 + 20 * 20 * 15);
  near(topOf(f), 25);
});

test("Ausschneiden ohne Körper ergibt nichts", () => {
  assert.equal(slabs([cut(rect(0, 0, 10, 10), 0, 5)]).length, 0);
  assert.deepEqual(bodyShells([cut(rect(0, 0, 10, 10), 0, 5)]), []);
});

test("Netz ist wasserdicht: jede Kante gehört zu genau zwei Dreiecken, STL hat passende Größe", () => {
  const f = [join(rect(0, 0, 100, 50), 0, 10), cut(rect(40, 15, 60, 35), 6, 10)];
  const shells = bodyShells(f);
  assert.equal(shells.length, 1);
  const t = shells[0].tris;
  const key = (i: number) => `${t[i].toFixed(6)},${t[i + 1].toFixed(6)},${t[i + 2].toFixed(6)}`;
  // Volumen aus den Dreiecken (Divergenzsatz) = Rauminhalt → geschlossen und nach außen gerichtet
  let v = 0;
  for (let i = 0; i < t.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t.slice(i, i + 9);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  near(v, volume(f), 1e-3);
  assert.ok(key(0).length > 0);
  const stl = stlBinary(shells);
  assert.equal(stl.length, 84 + (t.length / 9) * 50);
});
