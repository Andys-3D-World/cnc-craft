// Tests für den Mandala-Generator – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { mandala, type MandalaOptions, type Pt } from "../src/mandala.ts";

const base: MandalaOptions = { d: 150, n: 12, rings: 4, web: 2, edge: "round", center: "hole", seed: 7 };

/** kleinster Abstand zwischen zwei Polygonen (Punkte zu Kanten) */
function gap(a: Pt[], b: Pt[]): number {
  const seg = (p: Pt, s: Pt, e: Pt) => {
    const dx = e.x - s.x, dy = e.y - s.y, L = dx * dx + dy * dy;
    const u = L ? Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / L)) : 0;
    return Math.hypot(p.x - s.x - u * dx, p.y - s.y - u * dy);
  };
  let m = Infinity;
  for (const [P, Q] of [[a, b], [b, a]])
    for (const p of P) for (let i = 0; i < Q.length; i++) m = Math.min(m, seg(p, Q[i], Q[(i + 1) % Q.length]));
  return m;
}
const bbox = (p: Pt[]) => ({ x0: Math.min(...p.map(q => q.x)), x1: Math.max(...p.map(q => q.x)), y0: Math.min(...p.map(q => q.y)), y1: Math.max(...p.map(q => q.y)) });

for (const seed of [1, 7, 42, 99]) for (const edge of ["round", "wavy", "petals"] as const) {
  test(`Stege bleiben stehen (Seed ${seed}, Rand ${edge})`, () => {
    const o = { ...base, seed, edge };
    const m = mandala(o);
    assert.ok(m.holes.length >= o.n, "es gibt Muster");
    const boxes = m.holes.map(bbox);
    for (let i = 0; i < m.holes.length; i++) {
      for (let j = i + 1; j < m.holes.length; j++) {
        const A = boxes[i], B = boxes[j];
        if (A.x1 + o.web < B.x0 || B.x1 + o.web < A.x0 || A.y1 + o.web < B.y0 || B.y1 + o.web < A.y0) continue;
        assert.ok(gap(m.holes[i], m.holes[j]) >= o.web * 0.85, `Loch ${i} und ${j} zu nah`);
      }
      assert.ok(gap(m.holes[i], m.outer) >= o.web * 0.85, `Loch ${i} zu nah am Rand`);
    }
  });
}

test("gleicher Seed = gleiches Mandala, anderer Seed = anderes", () => {
  assert.deepEqual(mandala(base), mandala(base));
  assert.notDeepEqual(mandala(base).motifs.concat(mandala({ ...base, seed: 8 }).motifs).length, 0);
  const a = JSON.stringify(mandala(base).holes), b = JSON.stringify(mandala({ ...base, seed: 8 }).holes);
  assert.notEqual(a, b);
});

test("Symmetrie: Anzahl Muster je Ring ist ein Vielfaches von n", () => {
  const m = mandala({ ...base, center: "none" });
  assert.equal(m.holes.length % base.n, 0);
});
