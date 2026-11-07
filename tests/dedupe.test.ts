// Doppelte Linien entfernen – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicates, type DedupeItem } from "../src/editor/dedupe.ts";

const P = (x: number, y: number) => ({ x, y });
const open = (ref: string, ...p: [number, number][]): DedupeItem<string> => ({ ref, path: { pts: p.map(([x, y]) => P(x, y)), closed: false } });
const closed = (ref: string, ...p: [number, number][]): DedupeItem<string> => ({ ref, path: { pts: p.map(([x, y]) => P(x, y)), closed: true } });
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const TOL = 0.02;

test("Gleiche Linie zweimal: eine bleibt, auch rückwärts gezeichnet", () => {
  const r = findDuplicates([open("a", [0, 0], [100, 0]), open("b", [100, 0], [0, 0])], TOL);
  assert.equal(r.removeWhole.length, 1);
  assert.deepEqual(r.trims, []);
});

test("Kleiner Rundungsfehler unter der Toleranz zählt als gleich, darüber nicht", () => {
  assert.equal(findDuplicates([open("a", [0, 0], [100, 0]), open("b", [0, 0.01], [100, 0.01])], TOL).removeWhole.length, 1);
  assert.equal(findDuplicates([open("a", [0, 0], [100, 0]), open("b", [0, 0.5], [100, 0.5])], TOL).removeWhole.length, 0);
});

test("Teilstück liegt auf längerer Linie: kürzere fällt ganz weg, längere bleibt", () => {
  const r = findDuplicates([open("kurz", [20, 0], [40, 0]), open("lang", [0, 0], [100, 0])], TOL);
  assert.deepEqual(r.removeWhole, ["kurz"]);
  assert.deepEqual(r.trims, []);
});

test("Teilweise Überlappung: nur der doppelte Teil fällt weg", () => {
  const r = findDuplicates([open("a", [0, 0], [100, 0]), open("b", [60, 0], [150, 0])], TOL);
  assert.deepEqual(r.removeWhole, []);
  assert.equal(r.trims.length, 1);
  assert.equal(r.trims[0].ref, "b");
  assert.equal(r.trims[0].keep.length, 1);
  near(r.trims[0].keep[0].to - r.trims[0].keep[0].from, 50);
});

test("Kreuzende, anstoßende und nur berührende Linien bleiben ganz", () => {
  const list = [open("a", [0, 0], [100, 0]), open("kreuz", [50, -50], [50, 50]), open("t", [20, 0], [20, 40]), open("kette", [100, 0], [200, 0]), open("spitz", [100, 0], [200, 5])];
  const r = findDuplicates(list, TOL);
  assert.deepEqual(r.removeWhole, []);
  assert.deepEqual(r.trims, []);
});

test("Geschlossene Form: gleiche Form mit anderem Start und andersherum wird entfernt", () => {
  const a = closed("a", [0, 0], [50, 0], [50, 30], [0, 30]);
  const b = closed("b", [50, 30], [50, 0], [0, 0], [0, 30]);
  assert.equal(findDuplicates([a, b], TOL).removeWhole.length, 1);
});

test("Zwei Rechtecke mit gemeinsamer Kante bleiben ganz", () => {
  const a = closed("a", [0, 0], [50, 0], [50, 30], [0, 30]);
  const b = closed("b", [50, 0], [100, 0], [100, 30], [50, 30]);
  const r = findDuplicates([a, b], TOL);
  assert.deepEqual(r.removeWhole, []);
  assert.deepEqual(r.trims, []);
});

test("Kleineres Rechteck in größerem ist kein Duplikat", () => {
  const a = closed("a", [0, 0], [50, 0], [50, 30], [0, 30]);
  const b = closed("b", [0, 0], [50, 0], [50, 15], [0, 15]);
  assert.deepEqual(findDuplicates([a, b], TOL).removeWhole, []);
});

test("Offene Linie auf der Kante einer geschlossenen Form fällt weg, die Form bleibt", () => {
  const a = closed("a", [0, 0], [50, 0], [50, 30], [0, 30]);
  const r = findDuplicates([open("l", [10, 0], [40, 0]), a], TOL);
  assert.deepEqual(r.removeWhole, ["l"]);
});

test("Linie aus DXF-Stücken auf durchgehender Linie: alle Stücke fallen weg", () => {
  const list = [open("lang", [0, 0], [100, 0]), open("s1", [0, 0], [40, 0]), open("s2", [40, 0], [100, 0])];
  assert.deepEqual(findDuplicates(list, TOL).removeWhole.sort(), ["s1", "s2"]);
});

test("Gleicher Bogen als Vieleck mit anderen Punkten wird erkannt", () => {
  const arc = (n: number, ref: string): DedupeItem<string> => ({ ref, path: { closed: false, pts: Array.from({ length: n + 1 }, (_, i) => P(100 * Math.cos((i / n) * Math.PI), 100 * Math.sin((i / n) * Math.PI))) } });
  assert.equal(findDuplicates([arc(400, "a"), arc(333, "b")], TOL).removeWhole.length, 1);
});

test("Viele Linien bleiben schnell", () => {
  const list = Array.from({ length: 3000 }, (_, i) => open("l" + i, [i, 0], [i, 100]));
  const t0 = Date.now();
  assert.deepEqual(findDuplicates(list, TOL).removeWhole, []);
  assert.ok(Date.now() - t0 < 3000);
});
