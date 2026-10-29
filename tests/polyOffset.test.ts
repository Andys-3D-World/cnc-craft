import { test } from "node:test";
import assert from "node:assert/strict";
import { offsetPolygon } from "../src/polyOffset.ts";

/** Langloch: zwei fein unterteilte Halbkreise (Radius 4) mit 20 mm Abstand */
function slot(n: number) {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) { const a = Math.PI + Math.PI * i / n; pts.push({ x: 4 * Math.cos(a), y: 4 * Math.sin(a) }); }
  for (let i = 0; i <= n; i++) { const a = Math.PI * i / n; pts.push({ x: 4 * Math.cos(a), y: 20 + 4 * Math.sin(a) }); }
  return pts;
}

test("inside offset of a finely divided slot has no tiny back-and-forth loops", () => {
  const res = offsetPolygon(slot(200), -2, 0.01);
  assert.equal(res.length, 1);
  const l = res[0];
  assert.ok(l.length <= 2 * 201 + 4, `too many points: ${l.length}`);
  for (let i = 0; i < l.length; i++) {
    const a = l[i], b = l[(i + 1) % l.length], c = l[(i + 2) % l.length];
    assert.ok((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) >= 0, `path reverses at point ${i + 1}`);
  }
});
