// Pocket paths (zigzag, contour rings, adaptive, wall pass): TypeScript (src/pocket.ts, src/adaptive.ts) and Rust
// (src-tauri/src/pocket.rs) must give the same paths. Both sides read the same cases (fixtures/pocket-cases.json).
// This test pins what the TypeScript gives (fixtures/pocket-expected.json); `cargo test` compares the Rust result with it.
// sin, cos and atan2 can differ in the last digit between JavaScript engines and processors – so numbers are compared
// with a tolerance of 1e-9 mm; number of paths, of points, closed/open and helix must be exactly the same.
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test pocket
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { pocketPaths, pocketWallPaths, type PocketPath, type PocketStrategy } from "../src/pocket.ts";
import type { MillDir } from "../src/millDir.ts";

const dir = new URL("./fixtures/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
type Pair = [number, number];
interface Case { name: string; outer: Pair[]; islands: Pair[][]; r: number; step: number; strategy: PocketStrategy | "wall"; dir: MillDir }
const cases: Case[] = JSON.parse(read("pocket-cases.json"));
const TOL = 1e-9;
const P = (l: Pair[]) => l.map(p => ({ x: p[0], y: p[1] }));

function run(c: Case): { paths: PocketPath[]; tooBig: boolean } {
  if (c.strategy === "wall") return { paths: pocketWallPaths(P(c.outer), c.islands.map(P), c.r, c.dir), tooBig: false };
  return pocketPaths(P(c.outer), c.islands.map(P), c.r, c.step, c.strategy, c.dir);
}
/** per path: helix x, y, r (if any), then x, y of every point */
const numbersOf = (paths: PocketPath[]) => new Float64Array(paths.flatMap(p => [...(p.helix ? [p.helix.x, p.helix.y, p.helix.r] : []), ...p.pts.flatMap(q => [q.x, q.y])]));
const shapeOf = (paths: PocketPath[]) => paths.map(p => [p.pts.length, p.closed ? 1 : 0, p.helix ? 1 : 0]);
interface Dump { tooBig: boolean; paths: number[][]; data: string }
const dump = (r: { paths: PocketPath[]; tooBig: boolean }): Dump => ({ tooBig: r.tooBig, paths: shapeOf(r.paths), data: deflateSync(Buffer.from(numbersOf(r.paths).buffer), { level: 9 }).toString("base64") });
const unpack = (data: string) => { const b = inflateSync(Buffer.from(data, "base64")); return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

test("TypeScript pockets give the pinned result for every shared case", () => {
  const now = new Map(cases.map(c => [c.name, run(c)]));
  assert.equal(now.size, cases.length, "case names must be unique");
  if (process.env.UPDATE_FIXTURES) writeFileSync(new URL("pocket-expected.json", dir), JSON.stringify(Object.fromEntries([...now].map(([k, v]) => [k, dump(v)]))).replace(/},"/g, "},\n\"") + "\n");
  const pinned: Record<string, Dump> = JSON.parse(read("pocket-expected.json"));
  assert.deepEqual(Object.keys(pinned), cases.map(c => c.name));
  for (const c of cases) {
    const a = now.get(c.name)!, b = pinned[c.name];
    assert.equal(a.tooBig, b.tooBig, c.name);
    assert.deepEqual(shapeOf(a.paths), b.paths, c.name);
    const x = numbersOf(a.paths), y = unpack(b.data);
    assert.equal(x.length, y.length, c.name);
    for (let i = 0; i < x.length; i++) assert.ok(Math.abs(x[i] - y[i]) <= TOL, `${c.name}: number ${i}`);
  }
});

test("the cases cover every strategy, islands, both directions, helix entries and a tool that does not fit", () => {
  const all = cases.map(c => ({ c, r: run(c) }));
  for (const s of ["linear", "spiral", "adaptive", "wall"]) assert.ok(all.some(x => x.c.strategy === s && x.r.paths.length > 1), s);
  assert.ok(all.some(x => x.r.tooBig) && all.some(x => x.r.paths.some(p => p.helix)) && all.some(x => x.r.paths.some(p => p.closed)) && all.some(x => x.r.paths.some(p => !p.closed)));
  assert.ok(all.some(x => x.c.dir === "climb") && all.some(x => x.c.dir === "conventional") && all.some(x => x.c.islands.length > 1));
  assert.ok(all.reduce((s, x) => s + x.r.paths.reduce((q, p) => q + p.pts.length, 0), 0) > 10000);
});

test("no path point comes nearer than the tool radius to the wall or an island", () => {
  const dist = (p: { x: number; y: number }, a: Pair, b: Pair) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; let t = l2 > 0 ? ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p.x - a[0] - t * dx, p.y - a[1] - t * dy); };
  for (const c of cases) {
    const loops = [c.outer, ...c.islands];
    let nearest = Infinity;
    for (const path of run(c).paths) for (const p of path.pts) for (const l of loops) for (let i = 0; i < l.length; i++) nearest = Math.min(nearest, dist(p, l[i], l[(i + 1) % l.length]));
    // corner arcs of the offset may be up to twice the arc tolerance (0.01) nearer, see tests/polyOffsetRust.test.ts
    assert.ok(nearest >= c.r - 0.0201, `${c.name}: ${nearest} < ${c.r}`);
  }
});
