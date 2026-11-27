// V-carve and inlay paths: TypeScript (src/vcarve.ts) and Rust (src-tauri/src/vcarve.rs) must give the same paths.
// Both sides read the same cases (fixtures/vcarve-cases.json). This test pins what the TypeScript gives
// (fixtures/vcarve-expected.json); `cargo test` compares the Rust result with it.
// sin, cos and tan can differ in the last digit between JavaScript engines and processors – so numbers are compared
// with a tolerance of 1e-9 mm; number of paths, of points and closed/open must be exactly the same.
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test vcarve
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { vcarvePaths, mirrorX, type VOptions, type VPath } from "../src/vcarve.ts";

const dir = new URL("./fixtures/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
interface Case { name: string; loops: [number, number][][]; o: VOptions }
const cases: Case[] = JSON.parse(read("vcarve-cases.json"));
const TOL = 1e-9;

const run = (c: Case) => vcarvePaths(c.loops.map(l => l.map(p => ({ x: p[0], y: p[1] }))), c.o);
/** per path: z, then x, y of every point */
const numbersOf = (paths: VPath[]) => new Float64Array(paths.flatMap(p => [p.z, ...p.pts.flatMap(q => [q.x, q.y])]));
interface Dump { flat: boolean; paths: [number, number][]; data: string }
const dump = (r: { paths: VPath[]; flat: boolean }): Dump => ({
  flat: r.flat, paths: r.paths.map(p => [p.pts.length, p.closed ? 1 : 0]),
  // exact 64-bit numbers, zlib-packed (rings repeat a lot)
  data: deflateSync(Buffer.from(numbersOf(r.paths).buffer), { level: 9 }).toString("base64")
});
const unpack = (data: string) => { const b = inflateSync(Buffer.from(data, "base64")); return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

test("TypeScript V-carve gives the pinned result for every shared case", () => {
  const now = new Map(cases.map(c => [c.name, run(c)]));
  assert.equal(now.size, cases.length, "case names must be unique");
  if (process.env.UPDATE_FIXTURES) writeFileSync(new URL("vcarve-expected.json", dir), JSON.stringify(Object.fromEntries([...now].map(([k, v]) => [k, dump(v)]))).replace(/},"/g, "},\n\"") + "\n");
  const pinned: Record<string, Dump> = JSON.parse(read("vcarve-expected.json"));
  assert.deepEqual(Object.keys(pinned), cases.map(c => c.name));
  for (const c of cases) {
    const a = now.get(c.name)!, b = pinned[c.name];
    assert.equal(a.flat, b.flat, c.name);
    assert.deepEqual(a.paths.map(p => [p.pts.length, p.closed ? 1 : 0]), b.paths, c.name);
    const x = numbersOf(a.paths), y = unpack(b.data);
    assert.equal(x.length, y.length, c.name);
    for (let i = 0; i < x.length; i++) assert.ok(Math.abs(x[i] - y[i]) <= TOL, `${c.name}: number ${i}`);
  }
});

test("the cases cover: pockets, plugs, flat floors, holes, open and closed paths, nothing to carve", () => {
  const all = cases.map(c => ({ c, r: run(c) }));
  assert.ok(all.some(x => x.r.flat) && all.some(x => !x.r.flat && x.r.paths.length > 10));
  assert.ok(all.some(x => x.c.o.outside && x.r.paths.length > 3) && all.some(x => x.r.paths.length === 0));
  assert.ok(all.some(x => x.r.paths.some(p => !p.closed)) && all.some(x => x.r.paths.every(p => p.closed) && x.r.paths.length > 0));
  assert.ok(all.reduce((s, x) => s + x.r.paths.length, 0) > 400);
});

test("paths go from shallow to deep and never below the allowed depth", () => {
  for (const c of cases) {
    const { paths } = run(c);
    for (let i = 1; i < paths.length; i++) assert.ok(paths[i].z <= paths[i - 1].z + 1e-12, c.name);
    for (const p of paths) assert.ok(p.z <= 0 && -p.z <= c.o.maxDepth + 1e-9, `${c.name}: z ${p.z}`);
  }
});

test("mirror for the inlay plug", () => {
  assert.deepEqual(mirrorX([{ x: 1, y: 0 }, { x: 3, y: 5 }], 10), [{ x: 17, y: 5 }, { x: 19, y: 0 }]);
});
