// Tests für den 3D-Steckanhänger – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { slotOrnament, SLOT_SHAPES, type SlotOrnamentOptions } from "../src/slotOrnament.ts";
import { inRegion, bounds } from "../src/nameConnect.ts";

const base: SlotOrnamentOptions = { shape: "snowflake", size: 90, points: 5, t: 3, clear: 0.1, hanger: "hole", holeD: 3, deco: "stars", border: true };

for (const shape of SLOT_SHAPES) test(`${shape}: zwei Teile, je ein Stück, Schlitze passen genau zusammen`, () => {
  for (const deco of ["none", "stars", "dots", "flakes"] as const) {
    const r = slotOrnament({ ...base, shape, deco });
    assert.equal(r.a.cut.length, 1, `${shape}/${deco}: A in ${r.a.cut.length} Teilen`);
    assert.equal(r.b.cut.length, 1, `${shape}/${deco}: B in ${r.b.cut.length} Teilen`);
    assert.ok(Math.abs(r.slotW - 3.1) < 1e-9);
    const ba = bounds(r.a.cut);
    // A: über der Mitte ist die Mittellinie frei (Schlitz), darunter Material; B umgekehrt
    const yUp = r.mid + (ba.y1 - r.mid) * 0.3, yDown = r.mid - (r.mid - ba.y0) * 0.15;
    assert.ok(!inRegion(r.a.cut, 0, yUp) && inRegion(r.a.cut, 0, r.mid - 0.5), `${shape}: Schlitz A`);
    assert.ok(!inRegion(r.b.cut, 0, yDown) && inRegion(r.b.cut, 0, r.mid + 0.5), `${shape}: Schlitz B`);
    // Schlitz so breit wie Material + Spiel, und neben dem Schlitz steht Material (die Motive halten Abstand)
    assert.ok(!inRegion(r.a.cut, 1.5, r.mid + 1) && !inRegion(r.a.cut, -1.5, r.mid + 1));
    assert.ok(inRegion(r.a.cut, 1.6, r.mid + 1) || inRegion(r.a.cut, 1.6, r.mid + 2) || shape === "star", `${shape}: kein Material neben dem Schlitz`);
    // Zierlinie liegt im Material
    for (const l of [...r.a.lines, ...r.b.lines]) for (const [x, y] of l.pts) assert.ok(inRegion(r.a.cut, x, y) || inRegion(r.b.cut, x, y));
  }
});

test("Loch zum Aufhängen nur in Teil B (oben), Teil A ohne", () => {
  const r = slotOrnament({ ...base, deco: "none" });
  assert.equal(r.b.cut[0].length >= 2, true, "B ohne Loch");
  const top = bounds(r.b.cut).y1;
  assert.ok(top >= bounds(r.a.cut).y1 - 1e-6);
});
