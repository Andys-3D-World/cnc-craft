// Tests für den Puzzle-Generator – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { puzzle, PUZZLE_SHAPES, type PuzzleOptions } from "../src/puzzle.ts";
import { inRegion, grow } from "../src/nameConnect.ts";

type XY = [number, number];
const base: PuzzleOptions = { w: 200, h: 150, cols: 8, rows: 6, shape: "rect", tab: 100, jitter: 60, seed: 7 };

function cross(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

test("Rechteck: eine Linie je innerer Reihe/Spalte, von Rand zu Rand, im Rechteck", () => {
  const r = puzzle(base);
  assert.equal(r.lines.length, 5 + 7);
  for (const l of r.lines) {
    assert.ok(!l.closed);
    for (const [x, y] of l.pts) assert.ok(x >= -1e-9 && x <= 200 + 1e-9 && y >= -1e-9 && y <= 150 + 1e-9, `${x},${y}`);
  }
  const rows = r.lines.slice(0, 5), cols = r.lines.slice(5);
  for (const l of rows) { assert.ok(Math.abs(l.pts[0][0]) < 1e-9); assert.ok(Math.abs(l.pts[l.pts.length - 1][0] - 200) < 1e-9); }
  for (const l of cols) { assert.ok(Math.abs(l.pts[0][1]) < 1e-9); assert.ok(Math.abs(l.pts[l.pts.length - 1][1] - 150) < 1e-9); }
  assert.equal(r.pieceW, 25); assert.equal(r.pieceH, 25);
});

test("Nasen kommen sich nicht in die Quere: keine Linie kreuzt eine andere außer an den Rasterpunkten", () => {
  for (const seed of [1, 2, 3, 42, 999]) for (const [cols, rows, w, h] of [[8, 6, 200, 150], [4, 10, 100, 300], [12, 3, 300, 60]]) {
    const r = puzzle({ ...base, seed, cols, rows, w, h, tab: 140, jitter: 100 });
    const cell = Math.min(w / cols, h / rows);
    // Rasterpunkte = Anfangspunkte der Kanten; Kreuzungen in deren Nähe sind die gewollten Ecken
    const grid: XY[] = [];
    for (const l of r.lines) for (let k = 0; k < l.pts.length; k += 60) grid.push(l.pts[k]);
    const nearGrid = (p: XY) => grid.some(g => Math.hypot(p[0] - g[0], p[1] - g[1]) < cell * 0.12);
    for (let i = 0; i < r.lines.length; i++) for (let j = i + 1; j < r.lines.length; j++) {
      const p = r.lines[i].pts, q = r.lines[j].pts;
      for (let a = 1; a < p.length; a++) for (let b = 1; b < q.length; b++)
        if (cross(p[a - 1], p[a], q[b - 1], q[b])) assert.ok(nearGrid(p[a]), `seed ${seed}: Linien ${i}/${j} kreuzen sich bei ${p[a]}`);
    }
  }
});

test("gleicher Startwert = gleiches Puzzle, anderer Startwert = anderes", () => {
  assert.deepEqual(puzzle(base), puzzle(base));
  assert.notDeepEqual(puzzle(base).lines, puzzle({ ...base, seed: 8 }).lines);
});

test("ohne Unregelmäßigkeit: Raster genau, Nasen gleich groß", () => {
  const r = puzzle({ ...base, jitter: 0 });
  const ys = r.lines[0].pts.map(p => p[1]);
  const dev = Math.max(...ys.map(y => Math.abs(y - 25)));
  assert.ok(Math.abs(dev - 25 * 0.27) < 0.05, `Nasenhöhe ${dev}`);
});

test("Oval und Herz: Linien enden am Umriss (knapp dahinter), Umriss so groß wie gewünscht", () => {
  for (const shape of PUZZLE_SHAPES) {
    const r = puzzle({ ...base, shape });
    const xs = r.outline.map(p => p[0]), ys = r.outline.map(p => p[1]);
    assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 200) < 0.5, `${shape} Breite`);
    assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 150) < 0.5, `${shape} Höhe`);
    assert.ok(r.lines.length >= 12, `${shape}: ${r.lines.length} Linien`);
    const grown = grow([[[...r.outline, r.outline[0]]]], 0.6);
    for (const l of r.lines) for (const [x, y] of l.pts) assert.ok(inRegion(grown, x, y), `${shape}: Linie außerhalb`);
  }
});
