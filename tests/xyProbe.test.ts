import test from "node:test";
import assert from "node:assert/strict";
import { AHEAD_S, cleanXY, probeEdge, probeHole, probeInnerCorner, probeOuterCorner, sidesCentre, TRAVEL, XY_DEF, XYFail, zeroLine, type XYIO } from "../src/xyProbe.ts";

/** Simulierte Maschine: fährt die Warteschlange mit echtem Tempo ab; der Taster meldet, wenn der Kreis der Spitze das Teil berührt */
interface Box { x0: number; y0: number; x1: number; y1: number }
class Fake implements XYIO {
  x: number; y: number; t = 0; queue: { dx: number; dy: number; left: number; v: number }[] = [];
  stop = false; jogs: string[] = []; maxQueue = 0; deepest = 0; dead = false; alarm = false;
  solids: Box[]; hole: Box | null; tip: number; latency: number;
  onStatus: ((f: Fake) => void) | null = null;
  glitchAt: number[] = [];
  n = 0;
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
      let left = dt / 1000;
      while (left > 1e-12 && this.queue.length) {
        const q = this.queue[0], s = Math.min(q.left, q.v * left);
        this.x += q.dx * s; this.y += q.dy * s; q.left -= s; left -= s / q.v;
        if (q.left <= 1e-9) this.queue.shift();
      }
      this.deepest = Math.max(this.deepest, this.depthIn());
    }
  }
  async jog(dx: number, dy: number, feed: number) {
    assert.ok(!this.stop, "jog after abort");
    this.run(5);
    if (this.alarm) return false;
    const l = Math.hypot(dx, dy);
    this.queue.push({ dx: dx / l, dy: dy / l, left: l, v: feed / 60 });
    this.jogs.push(`${dx.toFixed(3)} ${dy.toFixed(3)} ${feed}`);
    this.maxQueue = Math.max(this.maxQueue, this.queue.reduce((a, q) => a + q.left / q.v, 0));
    return true;
  }
  async status() {
    this.run(this.latency); this.n++;
    this.onStatus?.(this);
    if (this.dead) return null;
    return { x: this.x, y: this.y, contact: this.depthIn() > 0 || this.glitchAt.includes(this.n), state: this.alarm ? "Alarm" : this.queue.length ? "Jog" : "Idle" };
  }
  async cancel() { this.queue = []; }
  aborted() { return this.stop; }
  now() { return this.t; }
}
const near = (a: number, b: number, tol = 0.06) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);
const part: Box = { x0: 100, y0: 50, x1: 180, y1: 110 };
const O = { ...XY_DEF };
const fails = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: any) => e instanceof XYFail && e.code === code, code); };

test("edge: all four directions, tip radius and plate thickness counted", async () => {
  for (const [dir, x, y, want] of [["xp", 92, 80, 100], ["xn", 190, 80, 180], ["yp", 140, 40, 50], ["yn", 140, 120, 110]] as const) {
    const f = new Fake({ x, y, solids: [part] });
    near(await probeEdge(f, dir, O), want);
    near(f.x, x, 0.01); near(f.y, y, 0.01); // wieder am Anfang
    assert.ok(f.deepest < 0.4, `pressed ${f.deepest}`);
  }
  // Platte 5 mm vor dem Teil: die Kante des TEILS kommt heraus
  const f = new Fake({ x: 85, y: 80, solids: [{ x0: 95, y0: 50, x1: 100, y1: 110 }] });
  near(await probeEdge(f, "xp", { ...O, side: 5 }), 100);
});

test("outer corner: all four corners, never over the part, back at the start", async () => {
  for (const cx of [-1, 1] as const) for (const cy of [-1, 1] as const) {
    const x = cx < 0 ? 94 : 186, y = cy < 0 ? 44 : 116;
    const f = new Fake({ x, y, solids: [part] });
    const r = await probeOuterCorner(f, { cx, cy }, O);
    near(r.x, cx < 0 ? 100 : 180); near(r.y, cy < 0 ? 50 : 110);
    near(f.x, x, 0.01); near(f.y, y, 0.01);
    assert.ok(f.deepest < 0.4);
  }
});

test("inner corner and hole centre", async () => {
  const hole: Box = { x0: 20, y0: 30, x1: 70, y1: 60 };
  for (const cx of [-1, 1] as const) for (const cy of [-1, 1] as const) {
    const f = new Fake({ x: cx < 0 ? 30 : 60, y: cy < 0 ? 38 : 52, hole });
    const r = await probeInnerCorner(f, { cx, cy }, O);
    near(r.x, cx < 0 ? 20 : 70); near(r.y, cy < 0 ? 30 : 60);
  }
  const f = new Fake({ x: 41, y: 48, hole });
  const r = await probeHole(f, { ...O, search: 40 });
  near(r.x, 45); near(r.y, 45); near(r.w, 50, 0.12); near(r.h, 30, 0.12);
  near(f.x, 45); near(f.y, 45); // steht in der Mitte
  assert.ok(f.deepest < 0.4);
});

test("nothing found: never further than the search distance, back to the start, no result", async () => {
  const f = new Fake({ x: 50, y: 80 });
  let far = 0; f.onStatus = g => { far = Math.max(far, g.x); };
  await fails(probeEdge(f, "xp", O), "noContact");
  assert.ok(far <= 50 + O.search + 0.01);
  near(f.x, 50, 0.01);
});

test("contact on the way (wrong start): stops at once and stays there", async () => {
  // Spitze steht zu nah: beim Fahren am Teil entlang liegt ein Klotz im Weg
  const f = new Fake({ x: 94, y: 44, solids: [part, { x0: 90, y0: 50, x1: 98, y1: 60 }] });
  await fails(probeOuterCorner(f, { cx: -1, cy: -1 }, O), "contactOnWay");
  assert.ok(f.deepest < 0.6, `pressed ${f.deepest}`);
  assert.equal(f.queue.length, 0);
});

test("stop: at any moment no further move is sent", async () => {
  for (let k = 3; k < 400; k += 13) {
    const f = new Fake({ x: 94, y: 44, solids: [part] });
    f.onStatus = g => { if (g.n === k) { g.stop = true; g.queue = []; } };
    const before = () => f.jogs.length;
    try { await probeOuterCorner(f, { cx: -1, cy: -1 }, O); assert.ok(f.n < k); }
    catch (e: any) {
      assert.equal(e.code, "aborted");
      const n = before(); f.run(2000); assert.equal(before(), n); assert.equal(f.queue.length, 0);
    }
  }
});

test("connection lost or alarm: at most a small rest is in the machine", async () => {
  const f = new Fake({ x: 50, y: 80 });
  f.onStatus = g => { if (g.n === 60) g.dead = true; };
  const p0 = () => f.x;
  await fails(probeEdge(f, "xp", { ...O, search: 60 }), "lost");
  const at = p0(); f.run(5000);
  assert.ok(f.x - at <= AHEAD_S * TRAVEL / 60 + 0.01);
  const a = new Fake({ x: 50, y: 80 });
  a.onStatus = g => { if (g.n === 60) { g.alarm = true; g.queue = []; } };
  await fails(probeEdge(a, "xp", O), "alarm");
  for (const m of [f, a]) assert.ok(m.maxQueue <= AHEAD_S + 0.05, `queued ${m.maxQueue} s`);
});

test("single noise pulses are ignored, a slow link still works, a stuck probe is reported", async () => {
  const f = new Fake({ x: 92, y: 80, solids: [part] });
  f.glitchAt = [20, 40, 55, 90, 130];
  near(await probeEdge(f, "xp", O), 100);
  const slow = new Fake({ x: 92, y: 80, solids: [part], latency: 150 });
  near(await probeEdge(slow, "xp", O), 100, 0.2);
  assert.ok(slow.deepest < 1, `pressed ${slow.deepest}`);
  // ein längerer Impuls (zwei Berichte): angehalten, Taster offen, weitersuchen
  const two = new Fake({ x: 92, y: 80, solids: [part] });
  two.glitchAt = [30, 31];
  near(await probeEdge(two, "xp", O), 100);
  const stuck = new Fake({ x: 92, y: 80, solids: [part] });
  let closed = false;
  stuck.onStatus = g => { if (g.depthIn() > 0) closed = true; if (closed) g.glitchAt.push(g.n); };
  await fails(probeEdge(stuck, "xp", O), "stuck");
});

test("centre from single sides, zero line, cleaned settings", () => {
  assert.deepEqual(sidesCentre({ left: 100, right: 180, front: 50 }), { x: 140, w: 80 });
  assert.deepEqual(sidesCentre({ left: 180, right: 100 }), {});
  assert.equal(zeroLine({ x: 94, y: 44 }, { x: 100, y: 50 }), "G10 L20 P0 X-6.000 Y-6.000");
  assert.equal(zeroLine({ x: 94, y: 44 }, { x: 100 }, { x: 80, y: 0 }), "G10 L20 P0 X74.000");
  assert.equal(zeroLine({ x: 0, y: 0 }, {}), null);
  assert.deepEqual(cleanXY({ tip: -1, side: "x", search: 9999, along: NaN }), { tip: 0, side: 0, search: 100, along: 10 });
});
