// X/Y probing: Rust (src-tauri/src/xyprobe.rs) replays the TypeScript flow (src/xyProbe.ts) with the answers the machine
// gave and must send exactly the same jogs, status requests and cancels in the same order and end with the same result
// or error. The machine here is the simulated one of tests/xyProbe.test.ts; every call and answer is recorded with
// src/xyProbeRec.ts, as the window does with the real machine. Pinned in fixtures/xyprobe-cases.json.gz, with the small
// helpers (cleanXY, sidesCentre, zeroLine). After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cargo test xyprobe
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { cleanXY, probeEdge, probeHole, probeInnerCorner, probeOuterCorner, sidesCentre, XY_DEF, XYFail, zeroLine, type XYDir, type XYIO, type XYOpts } from "../src/xyProbe.ts";
import { recordXY, type XYCall } from "../src/xyProbeRec.ts";

const file = new URL("./fixtures/xyprobe-cases.json.gz", import.meta.url);

/** Simulierte Maschine wie in tests/xyProbe.test.ts, dazu Fehler der Verbindung auf Wunsch */
interface Box { x0: number; y0: number; x1: number; y1: number }
class Fake implements XYIO {
  x: number; y: number; t = 0; queue: { dx: number; dy: number; left: number; v: number }[] = [];
  stop = false; jogs = 0; dead = false; alarm = false; busy = false;
  solids: Box[]; hole: Box | null; tip: number; latency: number;
  onStatus: ((f: Fake) => void) | null = null;
  glitchAt: number[] = [];
  n = 0;
  rejectJogAt = -1; throwJogAt = -1; throwStatusAt = -1; throwCancel = false;
  round3 = false;                         // Lage wie GRBL mit 3 Nachkommastellen melden
  pause: [number, number] | null = null;  // in dieser Zeit (ms) steht die Maschine (Vorschub angehalten)
  short = 1;                              // fährt nur diesen Teil jeder Strecke (verlorene Schritte)
  constructor(o: { x: number; y: number; solids?: Box[]; hole?: Box; tip?: number; latency?: number }) {
    this.x = o.x; this.y = o.y; this.solids = o.solids ?? []; this.hole = o.hole ?? null; this.tip = o.tip ?? 3; this.latency = o.latency ?? 30;
  }
  depthIn(): number {
    const r = this.tip / 2; let d = 0;
    for (const b of this.solids) {
      const px = Math.max(b.x0, Math.min(b.x1, this.x)), py = Math.max(b.y0, Math.min(b.y1, this.y));
      const dist = px === this.x && py === this.y ? -Math.min(this.x - b.x0, b.x1 - this.x, this.y - b.y0, b.y1 - this.y) : Math.hypot(px - this.x, py - this.y);
      d = Math.max(d, r - dist);
    }
    if (this.hole) d = Math.max(d, r - Math.min(this.x - this.hole.x0, this.hole.x1 - this.x, this.y - this.hole.y0, this.hole.y1 - this.y));
    return d;
  }
  run(ms: number) {
    const end = this.t + ms;
    while (this.t < end) {
      const dt = Math.min(2, end - this.t); this.t += dt;
      let left = this.pause && this.t > this.pause[0] && this.t <= this.pause[1] ? 0 : dt / 1000;
      while (left > 1e-12 && this.queue.length) {
        const q = this.queue[0], s = Math.min(q.left, q.v * left);
        this.x += q.dx * s; this.y += q.dy * s; q.left -= s; left -= s / q.v;
        if (q.left <= 1e-9) this.queue.shift();
      }
    }
  }
  async jog(dx: number, dy: number, feed: number) {
    this.run(5);
    this.jogs++;
    if (this.jogs === this.throwJogAt) throw new Error("port closed");
    if (this.alarm || this.jogs === this.rejectJogAt) return false;
    const l = Math.hypot(dx, dy);
    this.queue.push({ dx: dx / l, dy: dy / l, left: l * this.short, v: feed / 60 });
    return true;
  }
  async status() {
    this.run(this.latency); this.n++;
    this.onStatus?.(this);
    if (this.n === this.throwStatusAt) throw new Error("port closed");
    if (this.dead) return null;
    const r3 = (v: number) => this.round3 ? Math.round(v * 1000) / 1000 : v;
    return { x: r3(this.x), y: r3(this.y), contact: this.depthIn() > 0 || this.glitchAt.includes(this.n), state: this.alarm ? "Alarm:1" : this.busy ? "Run" : this.queue.length ? "Jog" : "Idle" };
  }
  async cancel() { if (this.throwCancel) throw new Error("port closed"); this.queue = []; }
  aborted() { return this.stop; }
  now() { return this.t; }
}

type Job = { kind: "edge"; dir: XYDir; opts: XYOpts } | { kind: "outer" | "inner"; corner: { cx: -1 | 1; cy: -1 | 1 }; opts: XYOpts } | { kind: "hole"; opts: XYOpts };
const O = { ...XY_DEF };
const part: Box = { x0: 100, y0: 50, x1: 180, y1: 110 };
const hole: Box = { x0: 20, y0: 30, x1: 70, y1: 60 };
const runs: { name: string; make: () => Fake; job: Job }[] = [];
const add = (name: string, make: () => Fake, job: Job) => runs.push({ name, make, job });

for (const [dir, x, y] of [["xp", 92, 80], ["xn", 190, 80], ["yp", 140, 40], ["yn", 140, 120]] as const) add(`edge ${dir}`, () => new Fake({ x, y, solids: [part] }), { kind: "edge", dir, opts: O });
add("edge with plate", () => new Fake({ x: 85, y: 80, solids: [{ x0: 95, y0: 50, x1: 100, y1: 110 }] }), { kind: "edge", dir: "xp", opts: { ...O, side: 5 } });
add("edge big tip", () => new Fake({ x: 88, y: 80, solids: [part], tip: 6 }), { kind: "edge", dir: "xp", opts: { ...O, tip: 6 } });
for (const cx of [-1, 1] as const) for (const cy of [-1, 1] as const) {
  add(`outer ${cx} ${cy}`, () => new Fake({ x: cx < 0 ? 94 : 186, y: cy < 0 ? 44 : 116, solids: [part] }), { kind: "outer", corner: { cx, cy }, opts: O });
  add(`inner ${cx} ${cy}`, () => new Fake({ x: cx < 0 ? 30 : 60, y: cy < 0 ? 38 : 52, hole }), { kind: "inner", corner: { cx, cy }, opts: O });
}
add("hole", () => new Fake({ x: 41, y: 48, hole }), { kind: "hole", opts: { ...O, search: 40 } });
add("hole too small for the search", () => new Fake({ x: 41, y: 48, hole }), { kind: "hole", opts: { ...O, search: 10 } });
add("tiny slot", () => new Fake({ x: 45, y: 45, hole: { x0: 43.4, y0: 30, x1: 46.6, y1: 60 } }), { kind: "hole", opts: { ...O, search: 20 } });
add("nothing found", () => new Fake({ x: 50, y: 80 }), { kind: "edge", dir: "xp", opts: O });
add("nothing found far", () => new Fake({ x: 50, y: 80 }), { kind: "edge", dir: "yn", opts: { ...O, search: 100 } });
add("contact on the way", () => new Fake({ x: 94, y: 44, solids: [part, { x0: 90, y0: 50, x1: 98, y1: 60 }] }), { kind: "outer", corner: { cx: -1, cy: -1 }, opts: O });
for (let k = 3; k < 400; k += 37) add(`stop at report ${k}`, () => { const f = new Fake({ x: 94, y: 44, solids: [part] }); f.onStatus = g => { if (g.n === k) { g.stop = true; g.queue = []; } }; return f; }, { kind: "outer", corner: { cx: -1, cy: -1 }, opts: O });
add("connection lost", () => { const f = new Fake({ x: 50, y: 80 }); f.onStatus = g => { if (g.n === 60) g.dead = true; }; return f; }, { kind: "edge", dir: "xp", opts: { ...O, search: 60 } });
add("alarm", () => { const f = new Fake({ x: 50, y: 80 }); f.onStatus = g => { if (g.n === 60) { g.alarm = true; g.queue = []; } }; return f; }, { kind: "edge", dir: "xp", opts: O });
add("noise pulses", () => { const f = new Fake({ x: 92, y: 80, solids: [part] }); f.glitchAt = [20, 40, 55, 90, 130]; return f; }, { kind: "edge", dir: "xp", opts: O });
add("slow link", () => new Fake({ x: 92, y: 80, solids: [part], latency: 150 }), { kind: "edge", dir: "xp", opts: O });
add("two-report pulse", () => { const f = new Fake({ x: 92, y: 80, solids: [part] }); f.glitchAt = [30, 31]; return f; }, { kind: "edge", dir: "xp", opts: O });
add("stuck probe", () => { const f = new Fake({ x: 92, y: 80, solids: [part] }); let closed = false; f.onStatus = g => { if (g.depthIn() > 0) closed = true; if (closed) g.glitchAt.push(g.n); }; return f; }, { kind: "edge", dir: "xp", opts: O });
add("jog refused", () => { const f = new Fake({ x: 92, y: 80, solids: [part] }); f.rejectJogAt = 7; return f; }, { kind: "edge", dir: "xp", opts: O });
add("jog refused, stop pressed", () => { const f = new Fake({ x: 92, y: 80, solids: [part] }); f.rejectJogAt = 3; const j = f.jog.bind(f); f.jog = async (a, b, c) => { const r = await j(a, b, c); if (!r) f.stop = true; return r; }; return f; }, { kind: "edge", dir: "xp", opts: O });
add("jog throws", () => { const f = new Fake({ x: 92, y: 80, solids: [part] }); f.throwJogAt = 5; return f; }, { kind: "edge", dir: "xp", opts: O });
add("report throws while driving", () => { const f = new Fake({ x: 92, y: 80, solids: [part] }); f.throwStatusAt = 12; return f; }, { kind: "edge", dir: "xp", opts: O });
add("report throws, cancel throws", () => { const f = new Fake({ x: 92, y: 80, solids: [part] }); f.throwStatusAt = 12; f.throwCancel = true; return f; }, { kind: "edge", dir: "xp", opts: O });
add("report throws at the start", () => { const f = new Fake({ x: 92, y: 80, solids: [part] }); f.throwStatusAt = 1; return f; }, { kind: "edge", dir: "xp", opts: O });
add("cancel throws after contact", () => { const f = new Fake({ x: 92, y: 80, solids: [part] }); f.throwCancel = true; return f; }, { kind: "edge", dir: "xp", opts: O });
add("never idle", () => { const f = new Fake({ x: 92, y: 80, solids: [part] }); f.onStatus = g => { if (g.n === 25) g.busy = true; }; return f; }, { kind: "edge", dir: "xp", opts: O });
add("never idle at start", () => { const f = new Fake({ x: 92, y: 80, solids: [part] }); f.busy = true; return f; }, { kind: "hole", opts: O });
add("already touching", () => new Fake({ x: 99, y: 80, solids: [part] }), { kind: "edge", dir: "xp", opts: O });
add("GRBL rounding: edge", () => { const f = new Fake({ x: 92.0004, y: 80, solids: [part] }); f.round3 = true; return f; }, { kind: "edge", dir: "xp", opts: O });
add("GRBL rounding: outer corner", () => { const f = new Fake({ x: 94.0006, y: 43.9997, solids: [part] }); f.round3 = true; return f; }, { kind: "outer", corner: { cx: -1, cy: -1 }, opts: O });
add("GRBL rounding: hole", () => { const f = new Fake({ x: 41.0003, y: 48.0008, hole }); f.round3 = true; return f; }, { kind: "hole", opts: { ...O, search: 40 } });
add("paused 20 s while searching", () => { const f = new Fake({ x: 85, y: 80, solids: [part] }); f.pause = [2000, 22000]; return f; }, { kind: "edge", dir: "xp", opts: O });
add("paused 60 s while searching", () => { const f = new Fake({ x: 85, y: 80, solids: [part] }); f.pause = [2000, 62000]; return f; }, { kind: "edge", dir: "xp", opts: O });
add("moves short", () => { const f = new Fake({ x: 92, y: 80, solids: [part] }); f.short = 0.98; return f; }, { kind: "edge", dir: "xp", opts: O });
add("moves short, outer corner", () => { const f = new Fake({ x: 94, y: 44, solids: [part] }); f.short = 0.99; return f; }, { kind: "outer", corner: { cx: -1, cy: -1 }, opts: O });
add("three-report pulse", () => { const f = new Fake({ x: 92, y: 80, solids: [part] }); f.glitchAt = [30, 31, 32]; return f; }, { kind: "edge", dir: "xp", opts: O });
for (const [name, shift] of [["part pushed away 0.8 mm", 0.8], ["part pushed away 1.5 mm", 1.5], ["part moved toward the probe", -4]] as const)
  add(name, () => {
    const box = { ...part }, f = new Fake({ x: 92, y: 80, solids: [box] });
    let touched = false, moved = false;
    f.onStatus = g => { if (g.depthIn() > 0) touched = true; if (touched && !moved && g.depthIn() <= 0) { moved = true; box.x0 += shift; } };
    return f;
  }, { kind: "edge", dir: "xp", opts: O });
add("lost on the way back", () => { const f = new Fake({ x: 50, y: 80 }); f.onStatus = g => { if (g.n === 140) g.dead = true; }; return f; }, { kind: "edge", dir: "xp", opts: O });

const cleans: unknown[] = [{}, null, undefined, { tip: -1, side: "x", search: 9999, along: NaN }, { tip: "4.5mm", side: " 2", search: "1e1", along: [7] }, { tip: true, side: null, search: [], along: { a: 1 } },
  { tip: "Infinity", side: "-3", search: 50.5, along: "40.0001" }, { tip: [1, 2], side: [[3]], search: ".5", along: "+12" }, [5], "tip"];
const sides = [{ left: 100, right: 180, front: 50 }, { left: 180, right: 100 }, {}, { front: 1, back: 2.5 }, { left: -5, right: -5 }, { left: 0, right: 1e-9, front: -1e6, back: 1e6 }];
const zeros: [{ x: number; y: number }, { x?: number; y?: number }, { x: number; y: number }?][] = [[{ x: 94, y: 44 }, { x: 100, y: 50 }], [{ x: 94, y: 44 }, { x: 100 }, { x: 80, y: 0 }],
  [{ x: 0, y: 0 }, {}], [{ x: -12.3456, y: 7.0005 }, { y: 1.0000004 }, { x: 0, y: -0.0005 }], [{ x: 1e5, y: -1e5 }, { x: 0.125, y: -0.0625 }, { x: 0.0005, y: 0.0015 }]];

test("X/Y probing: pinned replay for Rust (xyprobe-cases.json.gz)", async () => {
  const cases: { name: string; job: Job; log: XYCall[]; want: unknown }[] = [];
  for (const r of runs) {
    const rec = recordXY(r.make());
    let want: unknown;
    try {
      const j = r.job;
      const v = j.kind === "edge" ? await probeEdge(rec.io, j.dir, j.opts) : j.kind === "outer" ? await probeOuterCorner(rec.io, j.corner, j.opts)
        : j.kind === "inner" ? await probeInnerCorner(rec.io, j.corner, j.opts) : await probeHole(rec.io, j.opts);
      want = { ok: v };
    } catch (e) { want = { err: e instanceof XYFail ? e.code : "error" }; }
    cases.push({ name: r.name, job: r.job, log: rec.log, want });
  }
  const codes = new Set(cases.map(c => (c.want as { err?: string }).err ?? "ok"));
  for (const c of ["ok", "aborted", "lost", "alarm", "jog", "noContact", "contactOnWay", "stuck", "timeout", "error"]) assert.ok(codes.has(c), `no case ends with ${c}`);
  const text = JSON.stringify({ cases, cleans: cleans.map(o => ({ o, want: cleanXY(o) })), sides: sides.map(s => ({ s, want: sidesCentre(s) })),
    zeros: zeros.map(([pos, found, val]) => ({ pos, found, val: val ?? { x: 0, y: 0 }, want: zeroLine(pos, found, val) })) }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
