// Snap geometry and corner tools: TypeScript (src/editor/snapGeom.ts + src/editor/cornerOps.ts) and Rust
// (src-tauri/src/snapgeom.rs) must find the same corner, round or chamfer it the same way (or refuse it for the same
// reason), extend a line to the same point and give the same quadrant, intersection, perpendicular and tangent points.
// The jobs look like the ones the window sends (cornerTool.ts, snap.ts). Pinned in fixtures/snapgeom-cases.json.gz;
// `cargo test snapgeom` compares (numbers to 1e-9). After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cargo test snapgeom
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { allIntersections, perpFeet, quadrants, tangentPts, type Prim } from "../src/editor/snapGeom.ts";
import { extendTo, filletCorner, nearestCorner, type P } from "../src/editor/cornerOps.ts";

const file = new URL("./fixtures/snapgeom-cases.json.gz", import.meta.url);
let seed = 4711;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const R = (a: number, b: number) => a + rnd() * (b - a);
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const P = (x: number, y: number): P => ({ x, y });
const xy = (ps: P[]) => ps.map(q => ({ x: q.x, y: q.y }));

// --- the same steps as cornerTool.ts and snap.ts ---
type Corner = { kind: "corner"; pts: P[]; closed: boolean; at: P; tol: number; r: number; chamfer: boolean; arcTol: number };
type Extend = { kind: "extend"; pts: P[]; end: "start" | "end"; targets: Prim[]; maxLen: number };
type Snap = { kind: "snap"; prims: Prim[]; from?: P };
type Job = Corner | Extend | Snap;
function run(j: Job): unknown {
  if (j.kind === "corner") {
    const i = nearestCorner(j.pts, j.closed, j.at, j.tol);
    if (i < 0) return { i };
    const res = filletCorner(j.pts, j.closed, i, j.r, j.chamfer, j.arcTol);
    return { i, res: { ...res, pts: xy(res.pts), ...(res.arc ? { arc: xy(res.arc) } : {}) } };
  }
  if (j.kind === "extend") return extendTo(j.pts, j.end, j.targets, j.maxLen);
  const quads = j.prims.flatMap(p => p.k === "circ" && p.sweep !== undefined ? quadrants(p) : []);
  return { quads, ints: allIntersections(j.prims), perp: j.from ? perpFeet(j.prims, j.from) : [], tan: j.from ? tangentPts(j.prims, j.from) : [] };
}

const jobs: Job[] = [];
const MM = 2;
const corner = (pts: P[], closed: boolean, at: P, r: number, chamfer: boolean, tol = 14 / 3) => jobs.push({ kind: "corner", pts, closed, at, tol, r, chamfer, arcTol: 0.01 * MM });

// hand-made corners: square, triangle, spikes, straight, doubled points, open lines, too big, tiny radius
const sq = [P(0, 0), P(100, 0), P(100, 60), P(0, 60)];
for (const chamfer of [false, true]) for (const r of [5 * MM, 0.1, 50, 60, 60.0000001, 100, 0, -3, NaN]) for (const at of [P(1, 1), P(99, 2), P(100, 60), P(-2, 59), P(50, 30)]) corner(sq, true, at, r, chamfer);
const spike = [P(0, 0), P(50, 0.001), P(100, 0), P(50, 80)];
for (const at of [P(50, 0), P(100, 0), P(50, 80), P(0, 0)]) for (const r of [1, 10, 200]) corner(spike, true, at, r, false), corner(spike, true, at, r, true);
corner([P(0, 0), P(50, 0), P(100, 0), P(100, 50)], true, P(50, 0), 5, false);          // straight on
corner([P(0, 0), P(50, 0), P(50, 0), P(50, 50)], false, P(50, 0), 5, false);           // doubled point
corner([P(0, 0), P(50, 0), P(50, 50)], false, P(0, 0), 5, false);                      // open start is no corner
corner([P(0, 0), P(50, 0), P(50, 50)], false, P(50, 50), 5, false);                    // open end is no corner
corner([P(0, 0), P(50, 0), P(50, 50)], false, P(51, 1), 50, false);                    // radius as long as the legs
corner([P(0, 0), P(50, 0), P(50, 50)], false, P(51, 1), 50, true);                     // chamfer as long as the legs
corner([P(0, 0), P(50, 0)], false, P(50, 0), 5, false);                                // too few points
corner([P(0, 0), P(50, 0), P(0, 1e-7)], true, P(50, 0), 5, false);                     // almost back on itself
corner([P(0, 0), P(10, 0), P(10, 10)], true, P(100, 100), 2, false);                   // nothing near
corner([P(0, 0), P(10, 0), P(10, 10)], true, P(10, 0), 2, false, 1e9);
corner([P(0, 0), P(10, 0), P(10, 10)], true, P(10, 0), 2000, false, 1e9);
corner([P(0, 0), P(1e4, 0), P(1e4, 1e4)], true, P(1e4, 0), 2000, false, 10);            // big radius: many points
corner([P(0, 0), P(10, 0), P(NaN, 5), P(10, 10)], true, P(10, 0), 2, false);
jobs.push({ kind: "corner", pts: [P(0, 0), P(10, 0), P(10, 10)], closed: true, at: P(10, 0), tol: 5, r: 2, chamfer: false, arcTol: NaN }); // no arc steps: only the second touch point is left
for (let k = 0; k < 120; k++) {
  const n = 3 + Math.floor(rnd() * 7), closed = rnd() < 0.6, pts: P[] = [];
  for (let i = 0; i < n; i++) pts.push(P(+R(-200, 200).toFixed(rnd() < 0.5 ? 0 : 3), +R(-200, 200).toFixed(rnd() < 0.5 ? 0 : 3)));
  const c = pts[Math.floor(rnd() * n)];
  corner(pts, closed, P(c.x + R(-3, 3), c.y + R(-3, 3)), pick([0.5, 2, 10, 40, 150, R(0.01, 80)]), rnd() < 0.35, pick([4, 14 / 3, 20, 1e9]));
}

// extend: rays onto segments, circles, arcs (both ways), parallel and missing targets
const seg = (a: P, b: P, id = "t", i = 0): Prim => ({ k: "seg", a, b, id, i });
const circ = (c: P, r: number, a0?: number, sweep?: number, id = "c"): Prim => ({ k: "circ", c, r, ...(a0 !== undefined ? { a0 } : {}), ...(sweep !== undefined ? { sweep } : {}), id });
const fixedTargets: Prim[] = [seg(P(100, -50), P(100, 50)), seg(P(150, -50), P(150, 50), "u"), circ(P(250, 0), 30), circ(P(60, 0), 10, 0, Math.PI, "arc"),
  circ(P(60, 0), 10, Math.PI, -Math.PI / 2, "arc2"), seg(P(0, 10), P(300, 10), "par"), circ(P(400, 0), 50, 1, 2 * Math.PI, "full")];
for (const end of ["start", "end"] as const) for (const pts of [[P(0, 0), P(10, 0)], [P(20, 0), P(10, 0)], [P(0, 0), P(10, 0), P(30, 0)], [P(0, 0), P(10, 1)], [P(5, 5), P(5, 5)], [P(0, 0)], [P(0, 0), P(10, 0), P(10, 0)]])
  for (const maxLen of [1e6, 95, 5]) jobs.push({ kind: "extend", pts, end, targets: fixedTargets, maxLen });
jobs.push({ kind: "extend", pts: [P(0, 0), P(10, 0)], end: "end", targets: [], maxLen: 1e6 });
jobs.push({ kind: "extend", pts: [P(0, 0), P(10, 0)], end: "end", targets: [seg(P(10, -5), P(10, 5)), seg(P(10.000001, -5), P(10.000001, 5))], maxLen: 1e6 });
const randPrim = (id: string): Prim => {
  const t = rnd();
  if (t < 0.55) return seg(P(R(-100, 100), R(-100, 100)), P(R(-100, 100), R(-100, 100)), id, Math.floor(rnd() * 5));
  if (t < 0.75) return circ(P(R(-80, 80), R(-80, 80)), R(1, 60), undefined, undefined, id);
  return circ(P(R(-80, 80), R(-80, 80)), R(1, 60), R(-Math.PI, Math.PI), pick([R(-6, 6), Math.PI / 2, -Math.PI, 2 * Math.PI, 0]), id);
};
for (let k = 0; k < 60; k++) {
  const pts = [P(R(-100, 100), R(-100, 100)), P(R(-100, 100), R(-100, 100))];
  if (rnd() < 0.4) pts.push(P(R(-100, 100), R(-100, 100)));
  jobs.push({ kind: "extend", pts, end: rnd() < 0.5 ? "start" : "end", targets: Array.from({ length: 1 + Math.floor(rnd() * 12) }, (_, i) => randPrim("s" + (i % 4))), maxLen: pick([1e6, 50, 200]) });
}

// snap: crossings, touching circles, tangents, neighbours of the same shape, arcs, near misses, the 400 limit
const square = (id: string, x: number, y: number, s: number): Prim[] => [seg(P(x, y), P(x + s, y), id, 0), seg(P(x + s, y), P(x + s, y + s), id, 1), seg(P(x + s, y + s), P(x, y + s), id, 2), seg(P(x, y + s), P(x, y), id, 3)];
const fixedSnaps: Prim[][] = [
  [...square("a", 0, 0, 50), ...square("b", 25, 25, 50)],
  [...square("a", 0, 0, 50), seg(P(-10, 25), P(60, 25), "a", 9)],
  [circ(P(0, 0), 10), circ(P(20, 0), 10, undefined, undefined, "d")],                      // touching
  [circ(P(0, 0), 10), circ(P(5, 0), 10, undefined, undefined, "d")],
  [circ(P(0, 0), 10), circ(P(0, 0), 5, undefined, undefined, "d")],                         // same centre
  [circ(P(0, 0), 10), circ(P(3, 0), 5, undefined, undefined, "d")],                         // inside
  [circ(P(0, 0), 10, 0, Math.PI / 2), seg(P(-20, 5), P(20, 5), "s")],
  [circ(P(0, 0), 10, Math.PI / 2, -Math.PI), seg(P(-20, 5), P(20, 5), "s"), seg(P(0, -20), P(0, 20), "v")],
  [circ(P(0, 0), 10, 0, 2 * Math.PI), seg(P(-20, 10), P(20, 10), "t")],                    // tangent line
  [seg(P(0, 0), P(10, 0), "p"), seg(P(5, 0), P(15, 0), "q")],                              // overlapping, parallel
  [seg(P(0, 0), P(10, 0), "p"), seg(P(10, 0), P(10, 10), "q")],                            // end on end, other shapes
  [seg(P(0, 0), P(10, 0), "p"), seg(P(10 + 1e-10, 0), P(10, 10), "p")],                    // neighbours within 1e-9
  [circ(P(0, 0), 10, 0, NaN), seg(P(-20, 5), P(20, 5), "s")],
  [circ(P(0, 0), 0), seg(P(-5, 0), P(5, 0), "s")],
  [seg(P(0, 0), P(0, 0), "z"), seg(P(-1, 0), P(1, 0), "s")],
  [seg(P(NaN, 0), P(10, 10), "n"), seg(P(0, 10), P(10, 0), "s"), circ(P(5, 5), 3)],
  [],
  [circ(P(0, 0), 10, 0, Math.PI / 2), seg(P(-20, -5e-6), P(20, -5e-6), "s")],             // just below the arc start: outside
  [circ(P(0, 0), 10, 0, Math.PI / 2), seg(P(-20, -5e-8), P(20, -5e-8), "s")],             // within the angle tolerance: on it
  [circ(P(0, 0), 0.5, 0, Math.PI / 2), seg(P(-2, -1.5e-6), P(2, -1.5e-6), "s")],          // small radius: wider angle
  [circ(P(0, 0), 10), circ(P(20.5, 0), 10, undefined, undefined, "d")],                     // half a mm apart: no point
  [circ(P(0, 0), 10), circ(P(20 + 2e-10, 0), 10, undefined, undefined, "d")],               // within 1e-9: touching
  [seg(P(0, 0), P(10, 0), "w", 0), seg(P(0, 0), P(0, 10), "w", 1), seg(P(10, 0), P(10, 10), "w", 2), seg(P(0, 10), P(10, 10), "w", 3)], // same shape, ends meet both ways
  [circ(P(-0.43, -3.78), 4.43), seg(P(-9.29, 0.6499999999999999), P(12.86, 0.6499999999999999), "t")],     // tangent, discriminant just below 0
];
for (const prims of fixedSnaps) for (const from of [undefined, P(30, 40), P(0, 0), P(-15, 2), P(0, 30)]) jobs.push({ kind: "snap", prims, ...(from ? { from } : {}) });
for (let k = 0; k < 80; k++) {
  const prims = Array.from({ length: 1 + Math.floor(rnd() * 14) }, (_, i) => randPrim("s" + (i % 3)));
  jobs.push({ kind: "snap", prims, ...(rnd() < 0.75 ? { from: P(R(-120, 120), R(-120, 120)) } : {}) });
}
const many: Prim[] = [];
for (let i = 0; i < 430; i++) many.push(seg(P(i, -10), P(i + 0.5, 10), "m" + i));
many.push(seg(P(-5, 0), P(500, 0), "h"));
jobs.push({ kind: "snap", prims: many, from: P(3, 30) });

test("snap geometry and corners: pinned result for Rust (snapgeom-cases.json.gz)", () => {
  const cases = jobs.map(job => ({ job, want: run(job) }));
  const has = (f: (w: any) => boolean) => cases.some(c => f(c.want));
  assert.ok(has(w => w?.res?.error === "tooBig") && has(w => w?.res?.error === "straight") && has(w => w?.res?.error === "none") && has(w => w?.res?.arc?.length > 50));
  assert.ok(has(w => w === null) && has(w => w?.x !== undefined) && has(w => w?.ints?.length > 3) && has(w => w?.tan?.length > 0) && has(w => w?.quads?.length > 0));
  const text = JSON.stringify(cases) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
