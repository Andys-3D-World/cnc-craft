// Sketch constraints: TypeScript (src/editor/sketchSolve.ts) and Rust (src-tauri/src/sketchsolve.rs) must solve the same
// constraint sets to the same points (numbers to 1e-9), report the same success and iteration count, and count the same
// remaining freedoms. Pinned in fixtures/sketchsolve-cases.json.gz; `cargo test sketchsolve` compares.
// After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test sketchsolve
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { freedom, satisfied, solve, type GCon, type P, type Shapes } from "../src/editor/sketchSolve.ts";

const file = new URL("./fixtures/sketchsolve-cases.json.gz", import.meta.url);
let seed = 23;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const jit = (p: P, k = 3): P => ({ x: p.x + (rnd() - 0.5) * k, y: p.y + (rnd() - 0.5) * k });
const S = (a: string, i: number, j: number) => ({ id: a, i, j });
const Pt = (a: string, i: number) => ({ id: a, i });

type Case = { name: string; shapes: [string, P[]][]; cons: GCon[]; weights: Record<string, number[]>; circles: string[] };
const cases: Case[] = [];
const add = (name: string, shapes: [string, P[]][], cons: GCon[], weights: Record<string, number[]> = {}, circles: string[] = []) => cases.push({ name, shapes, cons, weights, circles });

const quad = (): P[] => [{ x: 0, y: 0 }, { x: 50, y: 2 }, { x: 52, y: 31 }, { x: -1, y: 29 }].map(p => jit(p));
add("rectangle from a rough quad", [["r", quad()]], [{ k: "h", a: S("r", 0, 1) }, { k: "v", a: S("r", 1, 2) }, { k: "h", a: S("r", 2, 3) }, { k: "v", a: S("r", 3, 0) }]);
add("rectangle with sizes and a fixed corner", [["r", quad()]], [{ k: "h", a: S("r", 0, 1) }, { k: "v", a: S("r", 1, 2) }, { k: "par", a: S("r", 2, 3), b: S("r", 0, 1) }, { k: "perp", a: S("r", 3, 0), b: S("r", 0, 1) }, { k: "len", a: S("r", 0, 1), v: 60 }, { k: "len", a: S("r", 1, 2), v: 25 }, { k: "fix", p: Pt("r", 0), at: { x: 5, y: 5 } }]);
add("weights: the first line moves less", [["a", [{ x: 0, y: 0 }, { x: 40, y: 10 }]], ["b", [{ x: 5, y: 20 }, { x: 45, y: 22 }]]], [{ k: "par", a: S("a", 0, 1), b: S("b", 0, 1) }, { k: "eq", a: S("a", 0, 1), b: S("b", 0, 1) }], { a: [100, 100], b: [1, 1] });
add("angle 30° and 150°", [["a", [{ x: 0, y: 0 }, { x: 40, y: 3 }]], ["b", [{ x: 0, y: 0 }, { x: 30, y: 25 }]], ["c", [{ x: 10, y: 0 }, { x: -20, y: 15 }]]], [{ k: "ang", a: S("a", 0, 1), b: S("b", 0, 1), v: 30 }, { k: "ang", a: S("a", 0, 1), b: S("c", 0, 1), v: 150 }, { k: "coin", p: Pt("a", 0), q: Pt("b", 0) }]);
add("point on line and coincident ends", [["a", [{ x: 0, y: 0 }, { x: 50, y: 0 }]], ["b", [{ x: 20, y: 3 }, { x: 30, y: 40 }]], ["c", [{ x: 31, y: 41 }, { x: 60, y: 40 }]]], [{ k: "onLine", p: Pt("b", 0), a: S("a", 0, 1) }, { k: "coin", p: Pt("b", 1), q: Pt("c", 0) }, { k: "h", a: S("c", 0, 1) }]);
add("circles: radius, concentric, equal, tangent", [["k1", [{ x: 10, y: 10 }, { x: 8, y: 0 }]], ["k2", [{ x: 11, y: 9 }, { x: 4, y: 0 }]], ["k3", [{ x: 40, y: 12 }, { x: 5, y: 0 }]], ["k4", [{ x: 70, y: 10 }, { x: 6, y: 0 }]]],
  [{ k: "rad", c: { id: "k1" }, v: 9 }, { k: "conc", c: { id: "k1" }, d: { id: "k2" } }, { k: "eqR", c: { id: "k3" }, d: { id: "k4" } }, { k: "tanC", c: { id: "k1" }, d: { id: "k3" }, inner: false }, { k: "tanC", c: { id: "k3" }, d: { id: "k4" }, inner: false }],
  { k1: [1, 1e4], k2: [1, 1e4], k3: [1, 1e4], k4: [1, 1e4] }, ["k1", "k2", "k3", "k4"]);
add("line tangent to a circle, point on circle, inner tangent", [["l", [{ x: 0, y: 22 }, { x: 60, y: 18 }]], ["k", [{ x: 30, y: 5 }, { x: 10, y: 0 }]], ["m", [{ x: 33, y: 6 }, { x: 3, y: 0 }]], ["p", [{ x: 45, y: 9 }, { x: 80, y: 9 }]]],
  [{ k: "tanL", a: S("l", 0, 1), c: { id: "k" } }, { k: "tanC", c: { id: "k" }, d: { id: "m" }, inner: true }, { k: "onCirc", p: Pt("p", 0), c: { id: "k" } }], { k: [1, 1e4], m: [1, 1e4] }, ["k", "m"]);
add("arcs (three points)", [["a", [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 8 }]], ["b", [{ x: 30, y: 0 }, { x: 50, y: 1 }, { x: 40, y: 9 }]], ["l", [{ x: 0, y: 15 }, { x: 60, y: 16 }]]],
  [{ k: "rad", c: { id: "a", arc: true }, v: 12 }, { k: "eqR", c: { id: "a", arc: true }, d: { id: "b", arc: true } }, { k: "tanL", a: S("l", 0, 1), c: { id: "b", arc: true } }]);
add("straight arc (no circle)", [["a", [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 0 }]]], [{ k: "rad", c: { id: "a", arc: true }, v: 15 }]);
add("contradiction: horizontal and vertical", [["l", [{ x: 0, y: 0 }, { x: 10, y: 10 }]]], [{ k: "h", a: S("l", 0, 1) }, { k: "v", a: S("l", 0, 1) }]);
add("contradiction: two fixes", [["l", [{ x: 0, y: 0 }, { x: 10, y: 10 }]]], [{ k: "fix", p: Pt("l", 0), at: { x: 0, y: 0 } }, { k: "fix", p: Pt("l", 0), at: { x: 5, y: 0 } }]);
add("invalid references are skipped", [["l", [{ x: 0, y: 0 }, { x: 10, y: 10 }]]], [{ k: "h", a: S("l", 0, 5) }, { k: "len", a: S("nope", 0, 1), v: 3 }, { k: "len", a: S("l", 0, 1), v: 20 }]);
add("nothing to do", [["l", [{ x: 0, y: 0 }, { x: 10, y: 0 }]]], [{ k: "h", a: S("l", 0, 1) }]);
add("big coordinates", [["r", [{ x: 1000, y: 2000 }, { x: 1600, y: 2010 }, { x: 1610, y: 2400 }, { x: 990, y: 2390 }]]], [{ k: "h", a: S("r", 0, 1) }, { k: "v", a: S("r", 1, 2) }, { k: "h", a: S("r", 2, 3) }, { k: "v", a: S("r", 3, 0) }, { k: "len", a: S("r", 0, 1), v: 600 }]);
for (let k = 0; k < 12; k++) {
  // random polygons with a random mix of constraints
  const n = 3 + Math.floor(rnd() * 4), pts = Array.from({ length: n }, (_, i) => ({ x: Math.cos((i / n) * 2 * Math.PI) * 40 + rnd() * 6, y: Math.sin((i / n) * 2 * Math.PI) * 40 + rnd() * 6 }));
  const cons: GCon[] = [];
  for (let i = 0; i < n; i++) {
    const a = S("p", i, (i + 1) % n), b = S("p", (i + 1) % n, (i + 2) % n), r = rnd();
    if (r < 0.2) cons.push({ k: "h", a }); else if (r < 0.35) cons.push({ k: "len", a, v: 20 + rnd() * 40 }); else if (r < 0.5) cons.push({ k: "eq", a, b });
    else if (r < 0.6) cons.push({ k: "perp", a, b }); else if (r < 0.7) cons.push({ k: "ang", a, b, v: Math.round(rnd() * 180) });
  }
  if (rnd() < 0.5) cons.push({ k: "fix", p: Pt("p", 0), at: pts[0] });
  add(`random polygon ${k + 1}`, [["p", pts]], cons, { p: pts.map((_, i) => (i === 0 ? 10 : 1)) });
}

test("sketch constraints: pinned result for Rust (sketchsolve-cases.json.gz)", () => {
  const out = cases.map(c => {
    const shapes: Shapes = new Map(c.shapes.map(([id, pts]) => [id, pts.map(p => ({ ...p }))]));
    const r = solve(shapes, c.cons, (id, i) => c.weights[id]?.[i] ?? 1);
    return { ...c, want: { ok: r.ok, shapes: [...r.shapes], iterations: r.iterations, free: freedom(shapes, c.cons, new Set(c.circles)), sat: c.cons.map(k => { try { return satisfied(k, r.shapes); } catch { return null; } }) } };
  });
  assert.ok(out.some(c => c.want.ok && c.want.iterations > 2) && out.some(c => !c.want.ok));
  const text = JSON.stringify(out) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
