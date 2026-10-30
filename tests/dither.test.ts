// Tests für das Bild-Verbessern in der Bildgravur (CPU und Beschleuniger-Haken) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAdjust, applyAdjustCpu, setAdjustAccelerator, rasterize, NO_ADJUST } from "../src/raster/dither.ts";

const img = (w: number, h: number) => {
  const g = new Float32Array(w * h);
  let x = 7;
  for (let i = 0; i < g.length; i++) { x = (x * 1103515245 + 12345) >>> 0; g[i] = ((x >>> 8) % 1000) / 1000; }
  return g;
};
const adj = { ...NO_ADJUST, black: 0.1, white: 0.9, gamma: 0.8, sharpen: 35, local: 15, denoise: 1 };

test("Beschleuniger nur für große Bilder, null = CPU rechnet", () => {
  let calls = 0;
  setAdjustAccelerator(() => { calls++; return null; });
  try {
    const small = img(100, 100), big = img(600, 500);
    assert.deepEqual(applyAdjust(small, 100, 100, adj), applyAdjustCpu(small, 100, 100, adj));
    assert.equal(calls, 0, "kleines Bild: nicht gefragt");
    assert.deepEqual(applyAdjust(big, 600, 500, adj), applyAdjustCpu(big, 600, 500, adj));
    assert.equal(calls, 1, "großes Bild: gefragt, Ergebnis kommt von der CPU");
  } finally { setAdjustAccelerator(null); }
});

test("Fehlerverteilung: Ergebnis nur 0/1 und mittlere Helligkeit bleibt erhalten", () => {
  const w = 200, h = 150, g = new Float32Array(w * h).fill(0.25);
  for (const method of ["jarvis", "floyd", "stucki", "atkinson", "sierra"] as const) {
    const out = rasterize(g, w, h, { method, threshold: 0.5, cell: 6, angle: 0 });
    assert.ok(out.every(v => v === 0 || v === 1), method);
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    assert.ok(Math.abs(mean - 0.75) < (method === "atkinson" ? 0.1 : 0.02), `${method}: ${mean}`);
  }
});
