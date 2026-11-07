// Ähnliches auswählen – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOpenShape, sameSize, shapesWithSameKey, unitsOfSameSize } from "../src/editor/selectSimilar.ts";

test("Offene Formen", () => {
  assert.equal(isOpenShape({ type: "line" }), true);
  assert.equal(isOpenShape({ type: "arc" }), true);
  assert.equal(isOpenShape({ type: "polyline", closed: false }), true);
  assert.equal(isOpenShape({ type: "polyline", closed: true }), false);
  assert.equal(isOpenShape({ type: "circle" }), false);
  assert.equal(isOpenShape({ type: "image" }), false);
});

test("Gleiche Größe: mit Toleranz und um 90° gedreht", () => {
  const a = { key: "a", w: 10, h: 20 };
  assert.equal(sameSize(a, { key: "b", w: 10.05, h: 19.95 }, 0.1), true);
  assert.equal(sameSize(a, { key: "b", w: 20, h: 10 }, 0.1), true);
  assert.equal(sameSize(a, { key: "b", w: 10.5, h: 20 }, 0.1), false);
});

test("Teile gleicher Größe, mehrere Bezüge", () => {
  const all = [{ key: "a", w: 10, h: 10 }, { key: "b", w: 10, h: 10 }, { key: "c", w: 5, h: 5 }, { key: "d", w: 5, h: 5 }, { key: "e", w: 7, h: 7 }];
  assert.deepEqual([...unitsOfSameSize(all, new Set(["a"]), 0.1)], ["a", "b"]);
  assert.deepEqual([...unitsOfSameSize(all, new Set(["a", "c"]), 0.1)], ["a", "b", "c", "d"]);
});

test("Gleiche Ebene: alle mit demselben Schlüssel", () => {
  const all = [{ l: "1" }, { l: "2" }, { l: "1" }, { l: "3" }];
  assert.deepEqual(shapesWithSameKey(all, [all[0]], s => s.l), [all[0], all[2]]);
});
