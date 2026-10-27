// Tests für „Gewinde fräsen“ – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { threadPath, threadDiameter, type ThreadParams } from "../src/threadMill.ts";

const base: ThreadParams = {
  cx: 10, cy: 20, holeD: 6.8, internal: true, D: 0, pitch: 1.25, toolD: 6, length: 10,
  left: false, feed: 400, plunge: 100, safeZ: 5,
};

test("Nenn-Ø aus dem Kernloch: M8 aus 6,8 mm", () => {
  assert.equal(threadDiameter(base), 8);
  assert.equal(threadDiameter({ ...base, holeD: 10.2, pitch: 1.75 }), 12);
  assert.equal(threadDiameter({ ...base, D: 8.2 }), 8.2);
  assert.equal(threadDiameter({ ...base, internal: false, holeD: 8 }), 8);
});

test("Innen-Rechtsgewinde: G3 von unten nach oben, eine Steigung je Umdrehung", () => {
  const r = threadPath(base);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.turns, 8); // 10 / 1,25
  const arcs = r.lines.filter(l => l.startsWith("G3"));
  assert.equal(arcs.length, 8);
  // Bahnradius = D/2 − Fräserradius = 1 → Start bei X11
  assert.match(arcs[0], /^G3 X11\.000 Y20\.000 Z-8\.750 I-1\.000 J0 F\d+$/);
  assert.match(arcs.at(-1)!, /Z0\.000/);
  // Start unten bei −10
  assert.ok(r.lines.includes("G1 Z-10.000 F100"));
  assert.ok(!r.lines.some(l => l.includes("G2 ")));
});

test("Vorschub an der Fräsermitte innen kleiner", () => {
  const r = threadPath(base);
  if (!r.ok) return assert.fail();
  // 400 · 1 / 4 = 100
  assert.match(r.lines.find(l => l.startsWith("G3"))!, /F100$/);
});

test("Innen-Linksgewinde: G3 von oben nach unten, endet genau bei −Länge", () => {
  const r = threadPath({ ...base, left: true, length: 9 });
  if (!r.ok) return assert.fail();
  assert.equal(r.turns, 8); // 9 / 1,25 = 7,2 → 8 Umdrehungen, Start etwas über Z0
  assert.ok(r.lines.includes("G1 Z1.000 F100"));
  assert.match(r.lines.filter(l => l.startsWith("G3")).at(-1)!, /Z-9\.000/);
});

test("Außen-Rechtsgewinde: G2 von oben nach unten, Kern-Ø, Anfahren von außen", () => {
  const r = threadPath({ ...base, internal: false, holeD: 8 });
  if (!r.ok) return assert.fail();
  const arcs = r.lines.filter(l => l.startsWith("G2"));
  assert.equal(arcs.length, 8);
  // R = (8 − 1,22687·1,25)/2 + 3 = 6,2333
  assert.match(arcs[0], /^G2 X16\.233 Y20\.000 Z-1\.250 I-6\.233 J0/);
  assert.match(arcs.at(-1)!, /Z-10\.000/);
  assert.ok(r.lines.includes("G0 X21.233 Y20.000")); // R + Fräserradius + 2 mm
});

test("Fehler: Fräser zu groß / passt nicht ins Kernloch / keine Steigung", () => {
  assert.deepEqual(threadPath({ ...base, toolD: 8 }), { ok: false, why: "toolTooBig" });
  assert.deepEqual(threadPath({ ...base, toolD: 7 }), { ok: false, why: "toolNoFit" });
  assert.deepEqual(threadPath({ ...base, pitch: 0 }), { ok: false, why: "pitch" });
  assert.deepEqual(threadPath({ ...base, length: 0 }), { ok: false, why: "length" });
});
