// Tests für den Geburtsbuchstaben – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MultiPolygon } from "polygon-clipping";
import { makeGrid, boxFits, placeBox, widestBand, layoutBirth, iconLines, fitLines, dividerLines, ICON_KINDS, MOTIF_KINDS, type Box, type XY } from "../src/birthLetter.ts";

/** Buchstabe L: Stamm 60 breit, Fuß 140 × 60, Höhe 200 */
const L: MultiPolygon = [[[[0, 0], [140, 0], [140, 60], [60, 60], [60, 200], [0, 200], [0, 0]]]];
/** Buchstabe O mit Loch */
const O: MultiPolygon = [[[[0, 0], [160, 0], [160, 200], [0, 200], [0, 0]], [[50, 50], [110, 50], [110, 150], [50, 150], [50, 50]]]];
const inL = (b: Box) => [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].every(([x, y]) =>
  x >= -1e-9 && y >= -1e-9 && x <= 140 + 1e-9 && y <= 200 + 1e-9 && !(x > 60 + 1e-9 && y > 60 + 1e-9));
const overlap = (a: Box, b: Box) => a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;

test("Raster: Rechtecke passen nur in die Fläche, Loch zählt als außen", () => {
  const g = makeGrid(L, 1);
  assert.ok(boxFits(g, { x: 5, y: 5, w: 120, h: 40 }));
  assert.ok(!boxFits(g, { x: 50, y: 70, w: 30, h: 30 }));
  assert.ok(!boxFits(g, { x: 5, y: 5, w: 120, h: 40 }, 10));
  const go = makeGrid(O, 1);
  assert.ok(!boxFits(go, { x: 40, y: 40, w: 30, h: 30 }));
  assert.ok(boxFits(go, { x: 5, y: 5, w: 30, h: 190 }));
});

test("breitester Streifen: langer Name im Fuß des L, Höhe begrenzt", () => {
  const g = makeGrid(L, 1);
  const b = widestBand(g, 5, 30, 4, 100)!;
  assert.ok(b.y + b.h <= 60 + 1e-6, "im Fuß");
  assert.ok(b.w <= 132 + 1e-6 && Math.abs(b.w / b.h - 5) < 1e-6);
  // kurzer Name: höchste Höhe, lieber näher an preferY (im Stamm)
  const c = widestBand(g, 1.5, 30, 4, 130)!;
  assert.ok(Math.abs(c.h - 30) < 1e-6 && c.y > 60);
});

test("placeBox: hält Abstand zu Belegtem, null wenn nichts passt", () => {
  const g = makeGrid(L, 1);
  const a = placeBox(g, [], 30, 30, 2, 0)!;
  assert.ok(inL(a));
  const b = placeBox(g, [a], 30, 30, 2, 5)!;
  assert.ok(inL(b) && !overlap(a, b));
  assert.equal(placeBox(g, [], 100, 100, 0, 0), null);
});

test("Aufteilung: alles im Buchstaben, nichts überlappt, Datum unter dem Namen", () => {
  const r = layoutBirth({ letter: L, height: 200, margin: 4, nameRatio: 3, nameSize: 14, dateRatio: 8, dateSize: 4,
    infos: [{ w: 22, h: 16 }, { w: 22, h: 16 }, { w: 22, h: 16 }], images: [1, 0.8], imageMax: 40, motifs: 12, motifSize: 7 });
  const all = [r.name, r.date, r.divider, ...r.infos, ...r.images, ...r.motifs].filter(Boolean) as Box[];
  for (const b of all) assert.ok(inL(b), JSON.stringify(b));
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(!overlap(all[i], all[j]), `${i}/${j}`);
  assert.ok(r.name && r.date && r.date.y + r.date.h <= r.name.y);
  assert.ok(Math.abs((r.date.x + r.date.w / 2) - (r.name.x + r.name.w / 2)) < 1e-6);
  assert.ok(r.infos.every(Boolean));
  assert.ok(r.images.some(Boolean));
  assert.ok(r.motifs.length > 0);
});

test("zu kleiner Buchstabe → Hinweise statt Absturz", () => {
  const tiny: MultiPolygon = [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]];
  const r = layoutBirth({ letter: tiny, height: 10, margin: 4, nameRatio: 3, nameSize: 14, dateRatio: 8, dateSize: 4,
    infos: [{ w: 22, h: 16 }], images: [1], imageMax: 40, motifs: 5, motifSize: 7 });
  assert.ok(r.warnings.includes("birth.warnName") && r.warnings.includes("birth.warnInfo") && r.warnings.includes("birth.warnImage"));
});

test("Symbole und Motive: Linien im Feld 0 … 1, ins Kästchen eingepasst", () => {
  for (const k of [...ICON_KINDS, ...MOTIF_KINDS]) {
    const lines = iconLines(k);
    assert.ok(lines.length > 0, k);
    for (const l of lines) for (const [x, y] of l.pts) assert.ok(x >= -0.02 && x <= 1.02 && y >= -0.02 && y <= 1.02, `${k}: ${x},${y}`);
    for (const l of fitLines(lines, { x: 10, y: 20, w: 8, h: 8 })) for (const [x, y] of l.pts) assert.ok(x >= 9.8 && x <= 18.2 && y >= 19.8 && y <= 28.2);
  }
  const d = dividerLines(40, 4);
  for (const l of d) for (const [x, y] of l.pts as XY[]) assert.ok(x >= -1e-9 && x <= 40 + 1e-9 && y >= -0.2 && y <= 4.2);
});
