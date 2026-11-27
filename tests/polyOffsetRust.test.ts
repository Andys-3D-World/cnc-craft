// Polygon offset (tool radius), area, point-in-contour, simplify: TypeScript (src/polyOffset.ts) and Rust
// (src-tauri/src/polyoffset.rs) must give the same result. Both sides read the same cases (fixtures/polyoffset-cases.json).
// This test pins what the TypeScript gives (fixtures/polyoffset-expected.json); `cargo test` compares the Rust result with it.
// The corner arcs need sin and cos, which can differ in the last digit between JavaScript engines and processors – so
// coordinates are compared with a tolerance of 1e-9 mm; number of contours and of points must be exactly the same.
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test polyoffset
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { offsetPolygon, pointInPoly, polygonArea, simplifyPolygon, simplifyPolyline, type P } from "../src/polyOffset.ts";

const dir = new URL("./fixtures/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
type Pair = [number, number];
interface Case { name: string; pts: Pair[]; d?: number; arcTol?: number; probes?: Pair[]; simplify?: number; closed?: boolean }
const cases: Case[] = JSON.parse(read("polyoffset-cases.json"));
const TOL = 1e-9;

interface Dump { keep?: number[]; loops?: number[]; xy?: string; area?: number; inside?: boolean[] }
function result(c: Case): { dump: Dump; loops: P[][] } {
  const pts: P[] = c.pts.map(p => ({ x: p[0], y: p[1] }));
  if (c.simplify !== undefined) {
    const out = c.closed ? simplifyPolygon(pts, c.simplify) : simplifyPolyline(pts, c.simplify);
    return { dump: { keep: out.map(p => pts.indexOf(p)) }, loops: [out] };
  }
  const loops = c.arcTol === undefined ? offsetPolygon(pts, c.d!) : offsetPolygon(pts, c.d!, c.arcTol);
  const xy = new Float64Array(loops.flatMap(l => l.flatMap(p => [p.x, p.y])));
  return {
    loops,
    dump: {
      loops: loops.map(l => l.length),
      // the coordinates as their exact 64-bit numbers
      xy: Buffer.from(xy.buffer).toString("base64"),
      area: polygonArea(pts),
      inside: (c.probes ?? []).map(q => pointInPoly(q[0], q[1], pts))
    }
  };
}
const numbers = (b64: string) => { const b = Buffer.from(b64, "base64"); return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

test("TypeScript polygon offset gives the pinned result for every shared case", () => {
  const now: Record<string, Dump> = {};
  for (const c of cases) now[c.name] = result(c).dump;
  assert.equal(Object.keys(now).length, cases.length, "case names must be unique");
  if (process.env.UPDATE_FIXTURES) writeFileSync(new URL("polyoffset-expected.json", dir), JSON.stringify(now).replace(/},"/g, "},\n\"") + "\n");
  const pinned: Record<string, Dump> = JSON.parse(read("polyoffset-expected.json"));
  assert.deepEqual(Object.keys(pinned), cases.map(c => c.name));
  for (const c of cases) {
    const a = now[c.name], b = pinned[c.name];
    assert.deepEqual({ ...a, xy: undefined, area: undefined }, { ...b, xy: undefined, area: undefined }, c.name);
    if (a.xy === undefined) continue;
    const x = numbers(a.xy), y = numbers(b.xy!);
    assert.equal(x.length, y.length, c.name);
    for (let i = 0; i < x.length; i++) assert.ok(Math.abs(x[i] - y[i]) <= TOL, `${c.name}: coordinate ${i}`);
    assert.ok(Math.abs(a.area! - b.area!) <= TOL * Math.max(1, Math.abs(b.area!)), c.name);
  }
});

test("the cases cover: nothing left, one contour, several contours, rounded corners, retry with a slightly different distance", () => {
  const all = cases.filter(c => c.simplify === undefined).map(c => ({ c, loops: result(c).loops }));
  assert.ok(all.some(r => r.loops.length === 0) && all.some(r => r.loops.length === 1) && all.some(r => r.loops.length >= 2));
  assert.ok(all.some(r => r.c.d! > 0 && r.loops[0]?.length > r.c.pts.length * 3), "outside offsets have arcs");
  assert.ok(all.reduce((s, r) => s + r.loops.reduce((q, l) => q + l.length, 0), 0) > 5000);
  const simp = cases.filter(c => c.simplify !== undefined).map(c => result(c).dump.keep!.length / c.pts.length);
  assert.ok(simp.some(f => f === 1) && simp.some(f => f < 0.2));
});

test("every offset contour keeps its distance from the original (corner arcs may be up to twice the arc tolerance nearer)", () => {
  const dist = (p: P, a: P, b: P) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); };
  let nearest = 0;
  for (const c of cases) {
    if (c.simplify !== undefined || Math.abs(c.d!) < 1e-6) continue;
    const pts: P[] = c.pts.map(p => ({ x: p[0], y: p[1] })), tol = c.arcTol ?? 0.01, d = Math.abs(c.d!);
    for (const l of result(c).loops) for (const p of l) {
      let near = Infinity;
      for (let i = 0; i < pts.length; i++) near = Math.min(near, dist(p, pts[i], pts[(i + 1) % pts.length]));
      assert.ok(near <= d * (1 + 2e-6) + 1e-6, `${c.name}: point is ${near} away, more than ${d}`);
      assert.ok(near >= d - 2 * tol - 2e-6, `${c.name}: point is ${near} away, wanted ${d} (arc tolerance ${tol})`);
      nearest = Math.max(nearest, (d - near) / tol);
    }
  }
  // this is how close it really gets in these cases, in arc tolerances (0 = never nearer than the tool radius)
  assert.ok(nearest <= 2.01, String(nearest));
});
