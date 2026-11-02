// Tests für die Landschaft (Hügel, Tannen, Häuschen) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { scene, SCENE_KINDS, type SceneOptions } from "../src/landscape.ts";
import { bounds, inRegion } from "../src/nameConnect.ts";

const base: SceneOptions = { x0: -40, x1: 40, bottom: -30, base: -15, hill: 4, item: 14, kind: "village", seed: 3 };

test("jede Landschaft ist ein Stück, bleibt in der Breite und reicht bis unten", () => {
  for (const kind of SCENE_KINDS.filter(k => k !== "none")) for (const seed of [1, 2, 3, 4, 5, 77]) {
    const s = scene({ ...base, kind, seed });
    assert.equal(s.area.length, 1, `${kind}/${seed}: ${s.area.length} Teile`);
    const b = bounds(s.area);
    assert.ok(b.x0 >= -40 - 1e-6 && b.x1 <= 40 + 1e-6, `${kind}: zu breit`);
    assert.ok(Math.abs(b.y0 + 30) < 1e-6);
    if (kind !== "hills") assert.ok(b.y1 > -15 + 4, `${kind}: keine Bäume/Häuser`);
  }
});

test("Dorf: Fenster und Türen sind Löcher im Material", () => {
  const s = scene({ ...base, houses: 1 });
  assert.ok(s.lights.length > 0);
  for (const p of s.lights) { const b = bounds([p]); assert.ok(!inRegion(s.area, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)); }
  assert.ok(s.area[0].length > 1, "keine Löcher");
});

test("gleicher seed = gleiche Landschaft; keine Landschaft = leer", () => {
  assert.deepEqual(scene(base), scene(base));
  assert.notDeepEqual(scene(base).area, scene({ ...base, seed: 4 }).area);
  assert.deepEqual(scene({ ...base, kind: "none" }).area, []);
});
