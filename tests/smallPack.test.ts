import test from "node:test";
import assert from "node:assert/strict";
import { CBORE_SCREWS, expandOps, extraOps } from "../src/ops.ts";
import { measured, rayAt, surfaceHit, type Camera } from "../src/sim/simMeasure.ts";
import { dialFor, DIALS, dialTable, parseDial, rigidK } from "../src/routerDial.ts";

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

// ---------- Stufenbohrung ----------
test("counterbore: becomes a round pocket of its own size round the hole, other shapes are left alone", () => {
  const hole = { id: "h", type: "circle", x: 40, y: 60, w: 6.6, h: 6.6, millingMode: "drill", millingDepth: -10, toolId: "d", ops: [{ kind: "cbore", toolId: "e", depth: -6.4, cboreD: 11 }] };
  const [a, b] = expandOps([hole]);
  assert.equal(a, hole);
  assert.deepEqual([b.type, b.millingMode, b.x, b.y, b.w, b.millingDepth, b.toolId, b.cbore, b.opOf === hole], ["circle", "pocket", 40, 60, 11, -6.4, "e", true, true]);
  const poly = expandOps([{ id: "p", type: "polyline", closed: true, points: [], ops: [{ kind: "cbore", depth: -5 }] }])[1];
  assert.equal(poly.millingMode, "cbore"); assert.equal(poly.cbore, true);
  // andere Bearbeitungen bekommen nichts davon
  assert.equal("cbore" in expandOps([{ ...hole, ops: [{ kind: "chamfer", depth: -1 }] }])[1], false);
  assert.deepEqual(extraOps({ ops: [{ kind: "cbore", depth: 5, cboreD: -3 }] })[0], { kind: "cbore", toolId: undefined, depth: 0, chamferW: 1, finishAllow: 0, millDir: undefined, cboreD: 0.5 });
  for (const s of CBORE_SCREWS) assert.ok(s.d > s.hole && s.depth > Number(s.id.slice(1)), s.id);
});

// ---------- Messen ----------
const cam = (yaw: number, pitch: number): Camera => ({ yaw, pitch, scale: 10, ox: 400, oy: 300, cx: 20, cy: 15, cz: -2 });
/** wie SimView.projection() */
const project = (c: Camera, x: number, y: number, z: number) => [c.ox + ((x - c.cx) * Math.cos(c.yaw) - (y - c.cy) * Math.sin(c.yaw)) * c.scale,
  c.oy - (((x - c.cx) * Math.sin(c.yaw) + (y - c.cy) * Math.cos(c.yaw)) * Math.cos(c.pitch) + (z - c.cz) * Math.sin(c.pitch)) * c.scale];
// Platte 40 × 30 × 10, Tasche x 10–20, y 10–20, 4 tief; Loch x 30–35, y 10–15 durch
const grid = (() => { const cell = 0.1, nx = 400, ny = 300, h = new Float32Array(nx * ny); for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = (i + 0.5) * cell, y = (j + 0.5) * cell; h[j * nx + i] = x > 10 && x < 20 && y > 10 && y < 20 ? -4 : x > 30 && x < 35 && y > 10 && y < 15 ? -10 : 0; } return { nx, ny, x0: 0, y0: 0, cell, T: 10, h }; })();

test("measuring: a point that is projected and picked again comes back, from every view", () => {
  for (const [yaw, pitch] of [[0, 0], [-0.6, 0.95], [0.4, 0.5], [2.5, 1.1]]) {
    const c = cam(yaw, pitch);
    for (const [x, y, z] of [[5, 5, 0], [38, 28, 0], [25, 17, 0]]) {
      const [sx, sy] = project(c, x, y, z), r = rayAt(sx, sy, z, c)!, hit = surfaceHit(sx, sy, c, grid)!;
      near(r.x, x, 1e-6); near(r.y, y, 1e-6);
      near(hit.x, x, 0.12); near(hit.y, y, 0.12); near(hit.z, 0, 0.05);
    }
  }
  // Taschenboden (von oben und schräg, wo er zu sehen ist)
  for (const [yaw, pitch] of [[0, 0], [0, 0.4], [-0.3, 0.3]]) { const c = cam(yaw, pitch), [sx, sy] = project(c, 15, 15, -4), hit = surfaceHit(sx, sy, c, grid)!; near(hit.z, -4, 0.06); near(hit.x, 15, 0.15); near(hit.y, 15, 0.15); }
  const top = cam(0, 0), m = measured(surfaceHit(...project(top, 25, 15, 0) as [number, number], top, grid)!, surfaceHit(...project(top, 15, 15, -4) as [number, number], top, grid)!);
  near(m.dz, -4, 1e-6); near(m.xy, 10, 1e-6); near(m.d3, Math.hypot(10, 4), 1e-6); near(Math.abs(m.angle), 180, 1e-6);
});

test("measuring: beside the part, through a hole and in the exact front view there is nothing", () => {
  const top = cam(0, 0);
  assert.equal(surfaceHit(...project(top, 60, 15, 0) as [number, number], top, grid), null);
  assert.equal(surfaceHit(...project(top, 32, 12, 0) as [number, number], top, grid), null);
  assert.equal(surfaceHit(400, 300, cam(0, Math.PI / 2), grid), null);
  assert.equal(rayAt(1, 1, 0, cam(0, Math.PI / 2)), null);
  // Wand der Tasche: Höhe zwischen Boden und Oberkante
  const c = cam(0, 0.95), [sx, sy] = project(c, 15, 20, -2), w = surfaceHit(sx, sy, c, grid)!;
  near(w.z, -2, 0.2); near(w.y, 20, 0.2);
});

// ---------- Wählrad und Steifigkeit ----------
test("router dial: steps, half steps, range and own table", () => {
  assert.deepEqual(dialFor(17000, DIALS.makita), { pos: 3, rpm: 17000, out: "" });
  assert.deepEqual(dialFor(14500, DIALS.makita), { pos: 2.5, rpm: 14500, out: "" });
  assert.deepEqual(dialFor(8000, DIALS.makita), { pos: 1, rpm: 10000, out: "low" });
  assert.deepEqual(dialFor(40000, DIALS.makita), { pos: 6, rpm: 30000, out: "high" });
  assert.deepEqual(dialFor(30000, DIALS.makita), { pos: 6, rpm: 30000, out: "" });
  assert.deepEqual(dialFor(26900, DIALS.dewalt), { pos: 6, rpm: 27000, out: "" });
  for (const tb of [DIALS.makita, DIALS.dewalt]) for (let r = 9000; r < 32000; r += 137) { const d = dialFor(r, tb); assert.ok(d.pos >= 1 && d.pos <= 6 && Number.isInteger(d.pos * 2)); if (!d.out) assert.ok(Math.abs(d.rpm - r) <= 1400, `${r} → ${d.rpm}`); }
  assert.deepEqual(parseDial("10000, 12000; 17000"), [10000, 12000, 17000]);
  for (const bad of ["", "10000", "20000 10000", "abc", "1,2", "10000 10000"]) assert.equal(parseDial(bad), null);
  assert.equal(dialTable("none", "10000 20000"), null); assert.equal(dialTable("<b>", ""), null);
  assert.deepEqual(dialTable("own", "8000 16000 24000"), [8000, 16000, 24000]);
  assert.deepEqual(rigidK("normal"), { ap: 1, fz: 1 }); assert.deepEqual(rigidK("???"), { ap: 1, fz: 1 }); assert.equal(rigidK("weak").ap, 0.5);
});
