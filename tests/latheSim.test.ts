import test from "node:test";
import assert from "node:assert/strict";
import { chuckMeshes, insertOutline, LatheReplay, movesFromProgram, partMeshes, tailMesh, toolMeshes, type Tri, type TurnMove } from "../src/lathe/latheSim.ts";
import { DEFAULT_LATHE_TOOLS as T, latheGcode, planLathe, shapeOf, toolEdge, refDz, type LatheJob, type LatheOp, type Pt } from "../src/lathe/turn.ts";
import { parseGcodeProgram } from "../src/sim/gcodeParser.ts";
import { LATHE_PRESETS } from "../src/lathe/lathePresets.ts";
import * as GP from "../src/sim/gcodeParser.ts";

const near = (a: number, b: number, t = 1e-6, m = "") => assert.ok(Math.abs(a - b) <= t, `${m} ${a} ≠ ${b}`);
const OPS: LatheOp[] = [{ kind: "face", on: true, tool: "l1" }, { kind: "rough", on: true, tool: "l1" }, { kind: "finish", on: true, tool: "l2" }, { kind: "drill", on: true, tool: "l4", depth: 12 }, { kind: "groove", on: true, tool: "l3", z: -28, width: 4, d: 14 }];
const JOB: LatheJob = { stockD: 30, faceAllow: 1, stickOut: 60, margin: 3, allowX: 0.2, allowZ: 0.05, vc: 90, maxRpm: 1500, safeX: 3, safeZ: 5, clear: 0.5, tailOn: false, tailD: 8, tailZ: 0, ops: OPS };
const PROF: Pt[][] = [[{ z: 0, r: 0 }, { z: 0, r: 6 }, { z: -15, r: 6 }, { z: -15, r: 10 }, { z: -30, r: 10 }, { z: -40, r: 13 }]];
const plan = planLathe({ job: JOB, tools: T, profile: PROF });
const build = (xMode: "radius" | "g7", xSign: 1 | -1) => parseGcodeProgram(latheGcode(plan, JOB, { xMode, xSign, spindle: "auto", dir: "M3" }, (k, v) => k + (v?.n ? ` mit T${v.n} ${v.name}` : "")).split("\n"));
const STOCK = { R: 15, front: 1, stickOut: 60 };
const at = (r: LatheReplay, a: Float64Array, z: number) => a[Math.round((z - r.g.z0) / r.g.h)];

test("the program replayed from its text gives the planned part, in every X mode, with the right tools and no warnings", () => {
  assert.deepEqual(plan.issues.filter(i => i.hard), []);
  for (const [mode, sign, k] of [["radius", 1, 1], ["radius", -1, -1], ["g7", 1, 2], ["g7", -1, -2]] as const) {
    const p = build(mode, sign), mv = movesFromProgram(p, k, T, GP.MOVE_RAPID), r = new LatheReplay(mv, STOCK);
    assert.deepEqual(r.warnings, [], `${mode} ${sign}`);
    assert.deepEqual([...new Set(mv.filter(m => !m.rapid).map(m => m.tool!.id))], ["l1", "l2", "l4", "l3"]);
    for (const [z, v] of [[-7, 6], [-20, 10], [-26, 7], [-35, 11.5]]) near(at(r, r.S, z), v, 0.06, `${mode}${sign} z ${z}`);
    near(at(r, r.bore, -5), 2.5, 0.01); near(at(r, r.bore, -14), 0, 1e-9);
  }
});

test("jumping back and forth gives exactly the same material as playing straight through", () => {
  const p = build("radius", 1), mv = movesFromProgram(p, 1, T, GP.MOVE_RAPID), r = new LatheReplay(mv, STOCK), n = mv.length;
  const snap = (i: number, f: number) => { r.setTarget(i, f); return [Float64Array.from(r.S), Float64Array.from(r.bore)]; };
  const pos = [0, 5, 50, 119, 120, 121, 240, n - 1, n], straight = pos.map(i => snap(i, 0.4));
  for (const k of [8, 0, 5, 2, 7, 1, 6, 3, 4]) assert.deepEqual(snap(pos[k], 0.4), straight[k], `Stelle ${pos[k]}`);
  // am Anfang ist noch alles da, es wird nie wieder mehr
  r.setTarget(0, 0); near(at(r, r.S, -20), 15);
  let last = Infinity;
  for (let i = 0; i <= n; i += 7) { r.setTarget(i, 0); let v = 0; for (const x of r.S) if (x > 0) v += x * x; assert.ok(v <= last + 1e-6); last = v; }
});

test("a foreign program with a rapid through the part is reported with its line", () => {
  const lines = ["G21", "G90", "M3 S500", "G0 Z5 (T1)", "G0 X20", "G0 Z-10", "G0 X5", "G1 Z-20 F50", "M30"], p = parseGcodeProgram(lines);
  const r = new LatheReplay(movesFromProgram(p, 1, T, GP.MOVE_RAPID), STOCK);
  assert.deepEqual([...new Set(r.warnings)], [6]);
});

const valid = (t: Tri, name: string) => { assert.ok(t.index.length % 3 === 0, name); const n = t.data.length / 8; for (const i of t.index) assert.ok(i < n, name); for (const v of t.data) assert.ok(Number.isFinite(v), name); };
/** Rauminhalt eines geschlossenen Netzes */
const volume = (ts: Tri[]) => { let v = 0; for (const t of ts) for (let i = 0; i < t.index.length; i += 3) { const q = [0, 1, 2].map(k => t.index[i + k] * 8), P = (k: number, a: number) => t.data[q[k] + a]; v += (P(0, 0) * (P(1, 1) * P(2, 2) - P(1, 2) * P(2, 1)) - P(0, 1) * (P(1, 0) * P(2, 2) - P(1, 2) * P(2, 0)) + P(0, 2) * (P(1, 0) * P(2, 1) - P(1, 1) * P(2, 0))) / 6; } return Math.abs(v); };

test("meshes: valid, closed, the volume matches the profile, the cut view leaves a quarter out", () => {
  const mv = movesFromProgram(build("radius", 1), 1, T, GP.MOVE_RAPID), r = new LatheReplay(mv, STOCK);
  const m = partMeshes(r, 15, false, 180);
  for (const [k, t] of Object.entries(m)) valid(t, k);
  let want = 0;
  for (let i = 0; i < r.g.n; i++) if (r.S[i] > 0) want += Math.PI * (r.S[i] ** 2 - Math.min(r.S[i], r.bore[i]) ** 2) * r.g.h;
  near(volume([m.raw, m.done]) / want, 1, 0.02);
  const c = partMeshes(r, 15, true, 180);
  for (const [k, t] of Object.entries(c)) valid(t, "cut " + k);
  assert.ok(c.face.index.length > 0 && m.face.index.length === 0);
  // vorne oben (y < 0, z > 0) ist offen
  for (const t of [c.raw, c.done]) for (let i = 0; i < t.data.length; i += 8) assert.ok(!(t.data[i + 1] < -0.5 && t.data[i + 2] > 0.5));
  const ch = chuckMeshes(-60, 15); valid(ch.body, "chuck"); valid(ch.jaws, "jaws"); valid(tailMesh(0, 12), "tail");
  for (let i = 0; i < ch.jaws.data.length; i += 8) assert.ok(ch.jaws.data[i] <= -60 + 1e-4 && Math.hypot(ch.jaws.data[i + 1], ch.jaws.data[i + 2]) >= 15 - 0.01);
});

test("the drawn cutting edge is the edge that is calculated with", () => {
  for (const p of [...LATHE_PRESETS.map((q, i) => ({ ...q.tool, id: "p" + i, num: i, name: q.name })), ...T]) {
    for (const side of [-1, 1] as const) { const q = toolMeshes(p, side); valid(q.insert, p.name); valid(q.holder, p.name); }
    if (p.type !== "turn") continue;
    const s = shapeOf(p), dz = refDz(p);
    let low = Infinity;
    for (const [z, r] of insertOutline(p)) { low = Math.min(low, r); const e = toolEdge(s, z + dz); if (e < 1e6) assert.ok(r >= e - 0.02, `${p.name}: ${z} ${r} < ${e}`); }
    near(low, 0, 0.03, p.name);
  }
});
