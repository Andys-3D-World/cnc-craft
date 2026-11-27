// Cut order: TypeScript (src/cutOrder.ts) and Rust (src-tauri/src/cutorder.rs) must give the same order.
// Both sides build the same contours from fixtures/cutorder-cases.json (written out, or "random" with a seed).
// This test pins what the TypeScript gives (fixtures/cutorder-expected.json); `cargo test` compares the Rust result with it.
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test cutorder
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { optimizeCutOrder, precedence, travelLength, WORK_PER_MS, type CutItem } from "../src/cutOrder.ts";

const dir = new URL("./fixtures/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
type Pair = [number, number];
interface Case {
  name: string; from: Pair; timeMs?: number;
  items?: { entry: Pair; exit: Pair; pts: Pair[]; closed: boolean; freeStart?: boolean; reversible?: boolean }[];
  random?: { seed: number; n: number; w: number; h: number; kind: "mix" | "lines" | "nested" | "lattice"; depth?: number };
}
const cases: Case[] = JSON.parse(read("cutorder-cases.json"));

/** Random numbers from whole-number steps only (xorshift): the same bits in JavaScript and Rust */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
/** Octagon directions (no sin/cos, so both sides get the same numbers) */
const DIRS: Pair[] = [[1, 0], [0.7, 0.7], [0, 1], [-0.7, 0.7], [-1, 0], [-0.7, -0.7], [0, -1], [0.7, -0.7]];
type P = { x: number; y: number };
function poly(cx: number, cy: number, r: number, level: number): P[] {
  let pts: P[] = DIRS.map(d => ({ x: cx + r * d[0], y: cy + r * d[1] }));
  for (let l = 0; l < level; l++) {
    const out: P[] = [];
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; out.push(a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); }
    pts = out;
  }
  return pts;
}

/** Contours of a case – must match make_items() in src-tauri/src/cutorder.rs line by line */
function makeItems(c: Case): CutItem[] {
  const pt = (p: Pair): P => ({ x: p[0], y: p[1] });
  if (c.items) return c.items.map(v => ({ entry: pt(v.entry), exit: pt(v.exit), pts: v.pts.map(pt), closed: v.closed, freeStart: !!v.freeStart, reversible: !!v.reversible }));
  const g = c.random!, r = rng(g.seed), list: CutItem[] = [];
  if (g.kind === "nested") {
    for (let d = 0; d < g.depth!; d++) {
      const m = d * 12, pts = [{ x: m, y: m }, { x: g.w - m, y: m }, { x: g.w - m, y: g.h - m }, { x: m, y: g.h - m }];
      list.push({ entry: pts[0], exit: pts[0], pts, closed: true });
    }
  }
  if (g.kind === "lattice") {
    // short lines on a regular grid, 40 per row: many exactly equal distances
    for (let i = 0; i < g.n; i++) {
      const at = (i * 37) % g.n; // not in drawing order, so that "lowest number wins" is not the same as "found first"
      const a = { x: (at % 40) * 10, y: Math.floor(at / 40) * 10 }, b = { x: a.x + 1, y: a.y };
      list.push({ entry: a, exit: b, pts: [a, b], closed: false, reversible: i % 3 === 0 });
    }
  }
  while (list.length < g.n) {
    const k = r(), x = r() * g.w, y = r() * g.h;
    if (g.kind === "lines" || k >= 0.55) {
      const a = { x, y }, bx = x + (r() - 0.5) * 60, by = y + (r() - 0.5) * 60, b = { x: bx, y: by };
      const pts = [a];
      if (r() < 0.3) pts.push({ x: (a.x + b.x) / 2 + 3, y: (a.y + b.y) / 2 - 2 });
      pts.push(b);
      const reversible = r() < 0.7;
      list.push({ entry: a, exit: b, pts, closed: false, reversible });
    } else if (k < 0.3) {
      const rad = 3 + r() * 20, level = Math.floor(r() * 3), pts = poly(x, y, rad, level);
      list.push({ entry: pts[0], exit: pts[0], pts, closed: true, freeStart: true });
      if (r() < 0.6) {
        const hole = poly(x, y, rad * 0.3, 0), freeStart = r() < 0.5;
        list.push({ entry: hole[0], exit: hole[0], pts: hole, closed: true, freeStart });
      }
    } else if (k < 0.45) {
      // with a lead-in: entry beside the contour, afterwards the head stands at the first point
      const pts = poly(x, y, 3 + r() * 20, 1), lx = x + r(), ly = y + r();
      list.push({ entry: { x: lx, y: ly }, exit: pts[0], pts, closed: true });
    } else {
      // with tabs: entry and end at different points
      const pts = poly(x, y, 2 + r() * 10, 0);
      list.push({ entry: pts[0], exit: pts[4], pts, closed: true });
    }
  }
  return list;
}

function result(c: Case) {
  const items = makeItems(c), from = { x: c.from[0], y: c.from[1] };
  const steps = optimizeCutOrder(items, from, c.timeMs);
  const preds = precedence(items);
  return {
    items, steps, preds,
    dump: {
      count: items.length,
      // makes sure both sides built the same contours before the order is compared.
      // Exact numbers are written as text: Rust's JSON reader may be one last digit off on long numbers
      inputSum: String(items.reduce((s, it) => s + it.pts.reduce((q, p) => q + (p.x + 2 * p.y), 0) + it.entry.x + it.exit.y, 0)),
      steps: steps.map(s => [s.index, s.reversed ? 1 : 0, s.start]),
      insidePairs: preds.reduce((s, p) => s + p.length, 0),
      ...(items.length <= 60 ? { preds } : {}),
      travel: String(travelLength(items, steps, from))
    }
  };
}

test("TypeScript cut order gives the pinned result for every shared case", () => {
  const now: Record<string, unknown> = {};
  for (const c of cases) now[c.name] = result(c).dump;
  assert.equal(Object.keys(now).length, cases.length, "case names must be unique");
  if (process.env.UPDATE_FIXTURES) writeFileSync(new URL("cutorder-expected.json", dir), JSON.stringify(now).replace(/},"/g, "},\n\"") + "\n");
  const pinned = JSON.parse(read("cutorder-expected.json"));
  for (const c of cases) assert.deepEqual(JSON.parse(JSON.stringify(now[c.name])), pinned[c.name], c.name);
  assert.deepEqual(Object.keys(pinned), cases.map(c => c.name));
});

test("in every case: each contour once, and what lies inside a contour comes before it", () => {
  for (const c of cases) {
    const { items, steps, preds } = result(c);
    const at = new Map(steps.map((s, k) => [s.index, k]));
    assert.equal(at.size, items.length, c.name);
    preds.forEach((inside, outer) => inside.forEach(i => assert.ok(at.get(i)! < at.get(outer)!, `${c.name}: ${i} lies in ${outer}`)));
    for (const s of steps) {
      const it = items[s.index];
      assert.ok(!s.reversed || (it.reversible && !it.freeStart), `${c.name}: only reversible lines are turned`);
      assert.ok(s.start === 0 || it.freeStart, `${c.name}: a fixed start stays`);
    }
  }
});

test("the cases cover the grid search, the work limit and every kind of contour", () => {
  const all = cases.map(c => ({ c, ...result(c) }));
  assert.ok(all.some(r => r.items.length > 1500 && r.preds.some(p => p.length > 0)));
  assert.ok(all.some(r => r.steps.some(s => s.reversed)) && all.some(r => r.steps.some(s => s.start > 0)));
  // limit reached: more work allowed gives another (shorter) order
  const cut = all.filter(r => r.c.timeMs === undefined && JSON.stringify(optimizeCutOrder(r.items, { x: r.c.from[0], y: r.c.from[1] }, 1e7)) !== JSON.stringify(r.steps));
  assert.ok(cut.length >= 2, "at least two cases reach the default limit");
});

test("the work limit counts steps, not time: the same order on every run", () => {
  const c = cases.find(k => k.name === "lines only, limit reached")!;
  const a = result(c).dump.steps, b = result(c).dump.steps;
  assert.deepEqual(a, b);
  assert.equal(WORK_PER_MS, 25_000, "cutorder.rs has the same number");
});
