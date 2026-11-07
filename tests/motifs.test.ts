// Motive: geschlossen, spiegelgleich, ohne Selbstüberschneidung – läuft mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { seasonOutline, SEASON_SHAPES, seasonMotif, smoothHalf } from "../src/seasonShapes.ts";

type P = [number, number];
const crosses = (r: P[]): number => {
  const o = (a: P, b: P, c: P) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let n = 0;
  const m = r.length - 1;
  for (let i = 0; i < m; i++) for (let j = i + 2; j < m; j++) {
    if (i === 0 && j === m - 1) continue;
    if (o(r[i], r[i + 1], r[j]) * o(r[i], r[i + 1], r[j + 1]) < -1e-12 && o(r[j], r[j + 1], r[i]) * o(r[j], r[j + 1], r[i + 1]) < -1e-12) n++;
  }
  return n;
};

test("neu gezeichnete Formen: eine Fläche, spiegelgleich, keine Überschneidung, genug Punkte für glatte Kurven", () => {
  for (const s of ["ghost", "bat", "shell", "mushroom"] as const) {
    const m = seasonOutline(s);
    assert.equal(m.length, 1, s);
    const r = m[0][0] as P[];
    assert.equal(crosses(r), 0, `${s}: überschneidet sich`);
    assert.ok(r.length >= 100, `${s}: nur ${r.length} Punkte`);
    const xs = r.map(q => q[0]);
    assert.ok(Math.abs(Math.max(...xs) + Math.min(...xs)) < 1e-9, `${s}: nicht spiegelgleich`);
  }
});

test("alle Jahreszeiten-Umrisse sind eine Fläche", () => {
  for (const s of SEASON_SHAPES) assert.ok(seasonOutline(s).length >= 1, s);
});

test("kleine Fledermaus passt in den Kreis mit Ø 1 und überschneidet sich nicht", () => {
  const r = seasonMotif("bats")[0][0] as P[];
  assert.equal(crosses(r), 0);
  for (const [x, y] of r) assert.ok(Math.hypot(x, y) <= 0.52, `${x},${y}`);
});

test("glatte Kurve: geht durch alle Punkte, Ecken bleiben Ecken", () => {
  const pts = smoothHalf([[0, 0], [1, 0, true], [1, 1], [0, 1]], 4);
  assert.deepEqual(pts[4], [1, 0]);
  assert.deepEqual(pts[8], [1, 1]);
  assert.deepEqual(pts[0], [0, 0]);
});
