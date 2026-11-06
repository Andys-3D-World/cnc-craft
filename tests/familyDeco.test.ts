// Tests für die Familien-Deko – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MultiPolygon } from "polygon-clipping";
import { familyDeco, FAMILY_MOTIFS, type FamilyOptions } from "../src/familyDeco.ts";
import { bounds, inRegion } from "../src/nameConnect.ts";

const rect = (x0: number, y0: number, x1: number, y1: number): MultiPolygon => [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]];
/** Ersatz-Schrift: n breite „Buchstaben“ */
const word = (n: number) => ({ area: Array.from({ length: n }, (_, i) => rect(i * 7, 0, i * 7 + 6, 10)[0]) as MultiPolygon, lines: [] });
const base: FamilyOptions = { layout: "branch", motif: "ball", bar: "plain", size: 60, holeD: 4, inner: "engrave" };
const names = [word(4), word(3), word(6), word(5)];

for (const motif of FAMILY_MOTIFS) for (const bar of ["plain", "branch"] as const) {
  test(`Zweig: ${motif}/${bar}: ein Anhänger je Name, Loch unter Loch, nichts überlappt`, () => {
    const r = familyDeco({ ...base, motif, bar }, word(8), names);
    assert.equal(r.error, "");
    assert.equal(r.parts.length, names.length + 1);
    assert.equal(r.threads.length, names.length);
    const barPart = r.parts[0];
    r.threads.forEach(([top, low], i) => {
      assert.ok(!inRegion(barPart.cut, top[0], top[1]), "Loch in der Leiste");
      assert.ok(inRegion(barPart.cut, top[0], top[1] + 4), "Material über dem Loch");
      const tag = r.parts[i + 1];
      assert.ok(!inRegion(tag.cut, low[0], low[1]), "Loch im Anhänger");
    });
    const tags = r.parts.slice(1).map(p => bounds(p.cut));
    tags.forEach((a, i) => { if (i) assert.ok(a.x0 > tags[i - 1].x1, "Anhänger berühren sich nicht"); });
    assert.ok(tags.every(a => a.y1 < bounds(barPart.cut).y0), "Anhänger hängen unter der Leiste");
    for (const p of r.parts) assert.ok(p.engrave.length, "Name graviert");
  });
  test(`Am Stück: ${motif}/${bar}: Leiste und Motive sind ein Teil`, () => {
    const r = familyDeco({ ...base, layout: "joined", motif, bar }, word(8), names);
    assert.equal(r.error, "");
    assert.equal(r.parts.length, 1);
    assert.equal(r.parts[0].cut.length, 1, "ein zusammenhängendes Teil");
    assert.ok(r.parts[0].engrave.length >= 8 + 3);
  });
}

test("Familienname bleibt in der Leiste, zwei Löcher zum Aufhängen", () => {
  const r = familyDeco(base, word(8), names), bar = r.parts[0];
  for (const p of bar.engrave) for (const [x, y] of p[0]) assert.ok(inRegion(bar.cut, x, y), `${x},${y}`);
  const holes = bar.cut.reduce((a, p) => a + p.length - 1, 0);
  assert.equal(holes, 2 + names.length);
});

test("Baum: alle Namen stehen im Baum, Familienname unten, kurze Namen oben", () => {
  const r = familyDeco({ ...base, layout: "tree", size: 220 }, word(8), names);
  assert.equal(r.error, "");
  assert.equal(r.parts.length, 1);
  const tree = r.parts[0];
  for (const p of tree.engrave) for (const [x, y] of p[0]) assert.ok(inRegion(tree.cut, x, y), `außerhalb: ${x},${y}`);
  assert.equal(tree.engrave.length, 8 + 4 + 3 + 6 + 5);
  assert.ok(Math.abs(r.h - 220) < 1);
});

test("Gravieren als Linie und Einzellinien-Schrift", () => {
  const r = familyDeco({ ...base, inner: "score" }, word(8), names);
  assert.ok(r.parts.every(p => p.lines.length && !p.engrave.length));
  const single = { area: [], lines: [{ closed: false, pts: [[0, 0], [20, 0], [20, 8]] as [number, number][] }] };
  const s = familyDeco({ ...base, layout: "tree", size: 200 }, single, [single, single]);
  assert.equal(s.error, ""); assert.ok(s.parts[0].lines.length >= 3);
});

test("Klare Meldungen", () => {
  assert.equal(familyDeco(base, word(3), []).error, "fam.err.noNames");
  assert.equal(familyDeco({ ...base, size: 5 }, word(3), names).error, "fam.err.tooSmall");
  assert.equal(familyDeco({ ...base, layout: "tree", size: 70 }, word(8), Array(12).fill(word(9))).error, "fam.err.tooSmall");
});
