// Tests für die Schattenbox – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { shadowBox, BOX_SHAPES, SLOT_CLEAR, type ShadowBoxOptions } from "../src/shadowBox.ts";
import { bounds, inRegion, grow } from "../src/nameConnect.ts";

const base: ShadowBoxOptions = { shape: "bell", h: 200, layers: 3, frame: 8, scene: "village", seed: 4, sky: "engrave", bow: true, stand: true, t: 3, gap: 6, cable: true };

for (const shape of BOX_SHAPES) test(`${shape}: jede Schicht ein Teil mit Fenster, alle gleich breit, Fuß passt`, () => {
  for (const scene of ["trees", "village", "hills"] as const) {
    const r = shadowBox({ ...base, shape, scene });
    assert.equal(r.layers.length, 3);
    const b0 = bounds(r.layers[0]);
    for (const [i, l] of r.layers.entries()) {
      assert.equal(l.length, 1, `${shape}/${scene}: Schicht ${i} hat ${l.length} Teile`);
      assert.ok(l[0].length >= 2, `${shape}/${scene}: Schicht ${i} ohne Fenster`);
      const b = bounds(l);
      assert.ok(Math.abs(b.x0 - b0.x0) < 0.01 && Math.abs(b.x1 - b0.x1) < 0.01, "Schichten nicht gleich breit");
      assert.ok(Math.abs(b.y0 + 3) < 1e-6, "Zapfen fehlen (unten bei −t)");
    }
    // Grundplatte ist ein Teil und deckt jede Schicht ab
    assert.equal(r.back.length, 1);
    // (Punkte auf dem gemeinsamen Rand liegen genau auf der Kante – deshalb die Grundplatte minimal größer prüfen)
    const backPlus = grow([[r.back[0][0]]], 0.05);
    for (const l of r.layers) for (const [x, y] of l[0][0].filter((_, k) => k % 5 === 0))
      if (y > 0.5) assert.ok(inRegion(backPlus, x, y), `${shape}: Schicht ragt über die Grundplatte bei ${x},${y}`);
    // Fuß: ein Schlitz je Schicht + Grundplatte, Zapfen passen mit Spiel
    assert.equal(r.slots.length, 4);
    for (const s of r.slots) for (const tb of r.tabs) {
      assert.ok(!inRegion(r.foot, tb.x, s.y + 1.5), "Schlitz fehlt");
      assert.ok(!inRegion(r.foot, tb.x - tb.w / 2 + 0.05, s.y + 0.05) && !inRegion(r.foot, tb.x + tb.w / 2 - 0.05, s.y + 3 - 0.05), "Zapfen passt nicht");
      assert.ok(inRegion(r.foot, tb.x - tb.w / 2 - SLOT_CLEAR - 0.3, s.y + 1.5), "Schlitz zu breit");
    }
  }
});

test("Sterne/Mond: graviert auf der Grundplatte oder ausgeschnitten; ohne Fuß keine Zapfen", () => {
  const eng = shadowBox(base), cut = shadowBox({ ...base, sky: "cut" });
  assert.ok(eng.backEngrave.length >= 5);
  assert.ok(cut.back[0].length > eng.back[0].length + 4, "Sterne nicht ausgeschnitten");
  const free = shadowBox({ ...base, stand: false });
  assert.deepEqual(free.foot, []);
  assert.ok(Math.abs(bounds(free.layers[0]).y0) < 1e-6);
});

test("gleicher seed = gleiche Schattenbox", () => {
  assert.deepEqual(shadowBox(base).layers, shadowBox(base).layers);
});
