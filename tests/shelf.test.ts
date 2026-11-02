// Tests für das Steckregal – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MultiPolygon } from "polygon-clipping";
import { shelf, shelfLevels, layoutParts, type ShelfOptions } from "../src/shelf.ts";

const area = (m: MultiPolygon) => m.reduce((s, poly) => s + poly.reduce((t, r, i) => {
  let a = 0; for (let k = 0, j = r.length - 1; k < r.length; j = k++) a += r[j][0] * r[k][1] - r[k][0] * r[j][1];
  return t + (i ? -1 : 1) * Math.abs(a / 2);
}, 0), 0);
const base: ShelfOptions = { width: 600, height: 800, depth: 250, shelves: 4, thickness: 18, bottom: 80, top: 30, overhang: 20,
  clearance: 0.3, tool: 0, relief: "dogbone", feet: false };

test("Teile: 2 Seitenwände + 1 Boden je Ebene, Ebenen gleichmäßig", () => {
  const r = shelf(base);
  assert.equal(r.parts.filter(p => p.kind === "side").length, 2);
  assert.equal(r.parts.filter(p => p.kind === "shelf").length, 4);
  assert.deepEqual(shelfLevels(base), [80, 310, 540, 770]);
  assert.equal(r.slotW, 18.3);
  assert.deepEqual(r.slotX, [29, 571]);
  assert.deepEqual(r.warnings, []);
});

test("Seitenwand: Schlitze von hinten bis zur Mitte, so breit wie Material + Spiel", () => {
  const r = shelf(base);
  const side = r.parts[0].area;
  // Fläche = Rechteck minus 4 Schlitze (halbe Tiefe × Schlitzbreite)
  assert.ok(Math.abs(area(side) - (250 * 800 - 4 * 125 * 18.3)) < 1e-6);
  // Schlitzgrund liegt bei x = 125
  const ring = side[0][0];
  assert.ok(ring.some(([x, y]) => Math.abs(x - 125) < 1e-9 && Math.abs(y - (80 - 9.15)) < 1e-9));
});

test("Boden: Schlitze von vorne bis zur Mitte an beiden Enden – greifen in die Seitenwand", () => {
  const r = shelf(base);
  const board = r.parts[2].area;
  assert.ok(Math.abs(area(board) - (600 * 250 - 2 * 125 * 18.3)) < 1e-6);
  const ring = board[0][0];
  for (const x of [29 - 9.15, 29 + 9.15, 571 - 9.15, 571 + 9.15]) assert.ok(ring.some(([px, py]) => Math.abs(px - x) < 1e-9 && Math.abs(py - 125) < 1e-9));
  // Seitenwand-Schlitz (hinten) + Boden-Schlitz (vorne) = volle Tiefe
  assert.equal(125 + 125, base.depth);
});

test("Dogbones an den Schlitz-Gründen (Fräse), Fuß-Bogen ohne Dogbones", () => {
  const plain = shelf({ ...base, tool: 6, relief: "none" });
  const bones = shelf({ ...base, tool: 6, feet: true });
  // Seitenwand: 4 Schlitze × 2 Ecken = 8 Kreise → weniger Fläche; Fuß-Bogen dazu
  assert.ok(area(bones.parts[0].area) < area(plain.parts[0].area) - 8 * 3);
  const feetOnly = shelf({ ...base, feet: true });
  assert.ok(area(feetOnly.parts[0].area) < area(shelf(base).parts[0].area) - 100);
  assert.ok(plain.warnings.includes("shelf.warnNoRelief"));
});

test("Hinweise und Anordnung", () => {
  assert.ok(shelf({ ...base, shelves: 10, height: 300 }).warnings.includes("shelf.warnSpacing"));
  assert.ok(shelf({ ...base, tool: 25 }).warnings.includes("shelf.warnTool"));
  const l = layoutParts([{ w: 100, h: 50 }, { w: 100, h: 60 }, { w: 100, h: 40 }], 250, 10);
  assert.deepEqual(l.at, [[0, 0], [110, 0], [0, 70]]);
  assert.equal(l.h, 110);
});
