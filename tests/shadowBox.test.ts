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

test("Text vorn: steht in der vordersten Schicht (ein Teil), Sterne halten Abstand; hinten: graviert", () => {
  const word: any = [[[[0, 0], [6, 0], [6, 10], [0, 10], [0, 0]]], [[[8, 0], [14, 0], [14, 10], [8, 10], [8, 0]]], [[[16, 0], [22, 0], [22, 10], [16, 10], [16, 0]]]];
  for (const shape of BOX_SHAPES) {
    const plain = shadowBox({ ...base, shape });
    const front = shadowBox({ ...base, shape, textPos: "front", textLines: 1 }, { area: word, lines: [] });
    assert.equal(front.layers[0].length, 1, `${shape}: vorderste Schicht nicht aus einem Stück`);
    assert.equal(front.dropped, 0, `${shape}: Buchstaben fallen weg`);
    // Material in der vordersten Schicht ist mehr geworden (Buchstaben + Steg), die anderen Schichten unverändert
    const area = (m: any) => m.reduce((s: number, p: any) => s + p.reduce((t: number, r: any, k: number) => {
      let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
      return t + (k ? -1 : 1) * Math.abs(a / 2); }, 0), 0);
    assert.ok(area(front.layers[0]) > area(plain.layers[0]) + 50, `${shape}: kein Text in der vordersten Schicht`);
    assert.deepEqual(front.layers[1], plain.layers[1]);
    const back = shadowBox({ ...base, shape, textPos: "back" }, { area: word, lines: [] });
    assert.ok(area(back.backEngrave) > area(plain.backEngrave), `${shape}: Text hinten fehlt`);
    assert.deepEqual(back.layers[0], plain.layers[0]);
  }
});

test("Text in Einzellinien-Schrift: wird als Linie auf die Grundplatte graviert", () => {
  const r = shadowBox({ ...base, textPos: "front" }, { area: [], lines: [{ pts: [[0, 0], [10, 10], [20, 0]], closed: false }] });
  assert.equal(r.backLines.length, 1);
});
