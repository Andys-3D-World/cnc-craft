import test from "node:test";
import assert from "node:assert/strict";
import { LATHE_PRESETS } from "../src/lathe/lathePresets.ts";
import { DEFAULT_LATHE_TOOLS as T, dilate, heightLine, latheGcode, makeGrid, planLathe, powerW, refDz, rpmFor, shapeOf, sweep, toolEdge, type LatheJob, type LatheOp, type LatheTool, type Pt } from "../src/lathe/turn.ts";

const near = (a: number, b: number, tol = 1e-6, m = "") => assert.ok(Math.abs(a - b) <= tol, `${m} ${a} ≠ ${b}`);
const ops = (o: Partial<Record<LatheOp["kind"], Partial<LatheOp>>>): LatheOp[] => ([["face", "l1"], ["rough", "l1"], ["finish", "l2"], ["drill", "l4"], ["groove", "l3"], ["part", "l3"]] as [LatheOp["kind"], string][])
  .map(([kind, tool]) => ({ kind, tool, on: kind in o, ...(o[kind] || {}) }));
const JOB = (o: Parameters<typeof ops>[0], x: Partial<LatheJob> = {}): LatheJob => ({ stockD: 30, faceAllow: 1, stickOut: 60, margin: 3, allowX: 0.2, allowZ: 0.05, vc: 90, maxRpm: 1500, safeX: 3, safeZ: 5, clear: 0.5, tailOn: false, tailD: 8, tailZ: 0, ops: ops(o), ...x });
// Welle: Ø12 bis z-15, Schulter, Ø20 bis z-30, Kegel auf Ø26 bei z-40
const SHAFT: Pt[][] = [[{ z: 0, r: 0 }, { z: 0, r: 6 }, { z: -15, r: 6 }, { z: -15, r: 10 }, { z: -30, r: 10 }, { z: -40, r: 13 }]];
const codes = (p: ReturnType<typeof planLathe>) => p.issues.filter(i => i.hard).map(i => i.code);
const at = (p: ReturnType<typeof planLathe>, z: number) => p.left[Math.round((z - p.grid.z0) / p.grid.h)];

test("tool edge: nose arc, back edge, vertical front; grooving tool is flat", () => {
  const s = shapeOf(T[0]); // 95°/80° rechts -> hinten 5°
  assert.deepEqual([s.aL, s.aR], [90, 5]);
  near(toolEdge(s, 0), 0); near(toolEdge(s, -0.4), 0.4, 1e-6); assert.ok(toolEdge(s, -0.41) > 1e6);
  near(toolEdge(s, 5), 0.4 * (1 - Math.cos(5 * Math.PI / 180)) + (5 - 0.4 * Math.sin(5 * Math.PI / 180)) * Math.tan(5 * Math.PI / 180), 1e-9);
  const l = shapeOf({ ...T[0], hand: "L" }); assert.deepEqual([l.aL, l.aR], [5, 90]);
  near(shapeOf({ ...T[1], hand: "N" }).aL, 72.5); near(toolEdge(shapeOf(T[2]), 0.9), 0); assert.ok(toolEdge(shapeOf(T[2]), 1.1) > 1e6);
  assert.deepEqual([refDz(T[0]), refDz({ ...T[0], hand: "L" }), refDz(T[2])], [-0.4, 0.4, -1]);
});

test("dilate equals the brute-force result, sweep leaves exactly the tool shape", () => {
  const g = makeGrid(-5, 5, 0.05), p = new Float64Array(g.n).map((_, i) => 3 + Math.sin(i / 7) + (i % 50 === 0 ? 1 : 0));
  for (const t of [T[0], T[1], { ...T[1], hand: "L" as const }, { ...T[1], hand: "N" as const }, T[2]]) {
    const s = shapeOf(t), F = dilate(p, g, s);
    for (let c = 0; c < g.n; c += 3) {
      let m = -1e9;
      for (let i = 0; i < g.n; i++) { const e = toolEdge(s, (i - c) * g.h); if (e < 1e6) m = Math.max(m, p[i] - e); }
      near(F[c], m, 1e-6, t.name);
    }
    const S = new Float64Array(g.n).fill(8), z0 = g.z0 + 100 * g.h;
    sweep(S, g, s, z0, 9, z0, 2);
    for (let i = 0; i < g.n; i += 2) { const e = toolEdge(s, (i - 100) * g.h); near(S[i], e > 1e6 ? 8 : Math.min(8, 2 + e), 1e-6, t.name); }
  }
});

test("height line takes the larger radius and ignores the direction of drawing", () => {
  const g = makeGrid(-20, 5, 0.01), a = heightLine(SHAFT, g, 15), b = heightLine([SHAFT[0].slice().reverse()], g, 15);
  const v = (p: Float64Array, z: number) => p[Math.round((z - g.z0) / g.h)];
  near(v(a, -7), 6); near(v(a, -16), 10); near(v(a, -15), 10); near(v(a, -14.98), 6); assert.ok(v(a, 0.1) < -1e6);
  for (let i = 0; i < g.n; i++) near(a[i], b[i], 1e-9);
});

test("shaft: facing, roughing and finishing give the contour, never below it, without a rapid into material", () => {
  const job = JOB({ face: {}, rough: {}, finish: {} }), p = planLathe({ job, tools: T, profile: SHAFT });
  assert.deepEqual(codes(p), []);
  assert.deepEqual(p.runs.map(r => r.op.kind), ["face", "rough", "finish"]);
  for (let i = 0; i < p.grid.n; i++) {
    const z = p.grid.z0 + i * p.grid.h;
    if (z < -39.9 || z > -0.05) continue;
    assert.ok(p.left[i] >= p.profile[i] - 5e-3, `gouge at ${z}: ${p.left[i]} < ${p.profile[i]}`);
  }
  for (const [z, r] of [[-7, 6], [-14, 6], [-16, 10], [-29, 10], [-35, 11.5]]) near(at(p, z), r, 0.01, `z ${z}`);
  // in der Ecke bleibt genau der Schneidenradius stehen
  near(at(p, -14.9), 6 + (0.2 - Math.sqrt(0.2 ** 2 - 0.1 ** 2)), 0.02);
  assert.ok(at(p, 0.1) <= 0.01, "Planfläche bei 0");
  assert.ok(p.issues.some(i => i.code === "rest" && !i.hard) === false || (p.issues.find(i => i.code === "rest")!.v ?? 0) <= 0.21);
});

test("roughing leaves the allowance and respects the depth per pass", () => {
  const job = JOB({ face: {}, rough: {} }), p = planLathe({ job, tools: T, profile: SHAFT });
  assert.deepEqual(codes(p), []);
  for (let i = 0; i < p.grid.n; i++) { const z = p.grid.z0 + i * p.grid.h; if (z > -39 && z < -0.5) assert.ok(p.left[i] >= p.profile[i] + 0.2 - 3e-3, `z ${z}`); }
  near(at(p, -7), 6.2, 0.02); near(at(p, -20), 10.2, 0.02);
  const r = [...new Set(p.runs[1].moves.filter(m => !m.rapid).map(m => m.r.toFixed(3)))].map(Number).sort((a, b) => b - a);
  assert.ok(r[0] < 15.6 && r[r.length - 1] >= 6.2 - 1e-6);
});

test("a valley is entered along the back edge and cut with both tools, no collisions", () => {
  const prof: Pt[][] = [[{ z: 0, r: 0 }, { z: 0, r: 10 }, { z: -10, r: 10 }, { z: -20, r: 7 }, { z: -30, r: 10 }, { z: -40, r: 10 }]];
  const job = JOB({ face: {}, rough: { tool: "l2" }, finish: {} }), p = planLathe({ job, tools: T, profile: prof });
  assert.deepEqual(codes(p), []);
  near(at(p, -20), 7, 0.05); near(at(p, -35), 10, 0.01); near(at(p, -15), 8.5, 0.02); near(at(p, -25), 8.5, 0.02);
  for (let i = 0; i < p.grid.n; i++) { const z = p.grid.z0 + i * p.grid.h; if (z > -39.9 && z < -0.05) assert.ok(p.left[i] >= p.profile[i] - 3e-3, `z ${z}`); }
});

test("a steep valley stays for the 80° tool and is reported; finishing it in one go is refused", () => {
  const prof: Pt[][] = [[{ z: 0, r: 0 }, { z: 0, r: 10 }, { z: -15, r: 10 }, { z: -15, r: 6 }, { z: -25, r: 6 }, { z: -25, r: 10 }, { z: -40, r: 10 }]];
  const a = planLathe({ job: JOB({ face: {}, rough: {}, finish: { tool: "l1" } }), tools: T, profile: prof });
  assert.deepEqual(codes(a), []);
  assert.ok(a.issues.some(i => i.code === "rest"));
  const b = planLathe({ job: JOB({ face: {}, rough: {}, finish: {} }), tools: T, profile: prof });
  assert.ok(codes(b).includes("finishDeep"));
  assert.ok(codes(planLathe({ job: JOB({ face: {}, finish: {} }), tools: T, profile: SHAFT })).includes("finishDeep"));
});

test("grooves, parting and drilling", () => {
  const job = JOB({ face: {}, rough: {}, finish: {}, drill: { depth: 12 }, groove: { z: -28, width: 5, d: 14 }, part: {} }), p = planLathe({ job, tools: T, profile: SHAFT });
  assert.deepEqual(codes(p), []);
  near(at(p, -25.5), 7, 0.01); near(at(p, -27.9), 7, 0.06); near(at(p, -23.2), 7, 0.06); near(at(p, -22.5), 10, 0.02); near(at(p, -28.5), 10, 0.02);
  assert.ok(at(p, -41) <= 0.01); near(at(p, -39.9), 12.97, 0.1);
  const d = p.runs.find(r => r.op.kind === "drill")!;
  near(Math.min(...d.moves.map(m => m.z)), -12); assert.ok(d.moves.filter(m => !m.rapid).every(m => m.r === 0));
  assert.ok(p.issues.some(i => i.code === "falls" && !i.hard));
  const pt = p.runs.find(r => r.op.kind === "part")!;
  near(Math.min(...pt.moves.map(m => m.z)), -42); // linke Ecke, 2 mm breit
});

test("refused: too long for the chuck, stock too small, wrong tool, tailstock in the way, no contour", () => {
  const c = (j: LatheJob, prof = SHAFT, tools: LatheTool[] = T) => codes(planLathe({ job: j, tools, profile: prof }));
  assert.ok(c(JOB({ face: {} }, { stickOut: 41 })).includes("stickOut"));
  assert.ok(c(JOB({ face: {} }, { stockD: 25 })).includes("stockSmall"));
  assert.ok(c(JOB({ rough: { tool: "l3" } })).includes("wrongTool"));
  assert.ok(c(JOB({ rough: { tool: "nix" } })).includes("noTool"));
  assert.ok(c(JOB({ face: {} }, { tailOn: true })).includes("tailFace"));
  assert.ok(c(JOB({ drill: { depth: 5 } }, { tailOn: true })).includes("tailDrill"));
  assert.ok(c(JOB({ face: {} }), []).includes("noProfile"));
  assert.ok(c(JOB({ groove: { z: -10, width: 1, d: 8 } })).includes("grooveNarrow"));
  assert.ok(c(JOB({ rough: {} }), SHAFT, [{ ...T[0], feed: 0 }]).includes("toolBad"));
  assert.ok(planLathe({ job: JOB({ face: {} }, { stickOut: 130 }), tools: T, profile: SHAFT }).issues.some(i => i.code === "slender" && !i.hard));
});

const OUT = { xMode: "radius" as const, xSign: 1 as const, spindle: "auto" as const, dir: "M3" as const }, TXT = (k: string, v?: any) => k + (v ? " " + Object.values(v).join(" ") : "");
test("G-code: safe start, speed before cutting, feed from speed, tool change without spindle, X as radius or diameter", () => {
  const job = JOB({ face: {}, rough: {}, finish: {}, part: {} }), p = planLathe({ job, tools: T, profile: SHAFT });
  const g = latheGcode(p, job, OUT, TXT).trim().split("\n");
  assert.ok(g.every(l => !/NaN|undefined|Infinity|Y/.test(l.replace(/\(.*?\)/g, ""))));
  const first = g.findIndex(l => /^G0/.test(l));
  assert.match(g[first], /^G0 Z6\.000/); assert.match(g[first + 1], /^G0 X18\.000/);
  assert.ok(!g.some(l => /^G0 X0(\.000)?\b/.test(l)), "nie im Eilgang zur Mitte");
  const m0 = g.map((l, i) => /^M0 /.test(l) ? i : -1).filter(i => i >= 0);
  assert.equal(m0.length, 2);
  for (const i of m0) { assert.match(g[i - 1], /^M5/); const z = g.slice(i + 1).findIndex(l => /^G0/.test(l)); assert.match(g[i + 1 + z], /^G0 Z6\.000/); assert.match(g[i + 2 + z], /^G0 X18\.000/); }
  let on = false;
  for (const l of g) { if (/^M3/.test(l)) on = true; if (/^M5/.test(l)) on = false; if (/^G1/.test(l)) assert.ok(on, l); }
  assert.match(g[g.length - 1], /^M30/); assert.match(g[g.length - 2], /^M5/);
  const s = Number(/S(\d+)/.exec(g.find(l => /^M3/.test(l))!)![1]); assert.equal(s, rpmFor(90, 30, 1500));
  assert.ok(g.filter(l => /^M3 /.test(l)).every(l => Number(/S(\d+)/.exec(l)![1]) <= 1500));
  assert.ok(g.some(l => l.startsWith("G1") && l.endsWith(`F${Math.round(0.1 * s)}`)));
  const d = latheGcode(p, job, { ...OUT, xMode: "g7", xSign: -1 }, TXT).trim().split("\n");
  assert.ok(d.some(l => /^G7/.test(l)) && d.some(l => /^G0 X-36\.000/.test(l)));
  const h = latheGcode(p, job, { ...OUT, spindle: "hand" }, TXT).trim().split("\n");
  assert.ok(!h.some(l => /^M[345]\b/.test(l)) && h.some(l => /^M0 \(hand \d+\)/.test(l)));
});

test("every rapid of the finished program stays out of the remaining stock (replayed from the text)", () => {
  const prof: Pt[][] = [[{ z: 0, r: 0 }, { z: 0, r: 5 }, { z: -1, r: 6 }, { z: -12, r: 6 }, { z: -14, r: 12 }, { z: -20, r: 9 }, { z: -30, r: 12 }, { z: -38, r: 12 }]];
  const job = JOB({ face: {}, rough: { tool: "l2" }, finish: {}, groove: { z: -10, width: 3, d: 9 }, part: {} }), p = planLathe({ job, tools: T, profile: prof });
  assert.deepEqual(codes(p), []);
  const gc = latheGcode(p, job, OUT, TXT).split("\n"), g = makeGrid(-70, 20, 0.02), S = new Float64Array(g.n).map((_, i) => (g.z0 + i * g.h <= 1 ? 15 : -1e9));
  let z = 100, r = 100, run = -1, n = 0;
  for (const l of gc) {
    if (/\(op\./.test(l)) run++;
    const m = /^G([01]) /.exec(l); if (!m || run < 0) continue;
    const tl = p.runs[run].tool, dz = refDz(tl), sh = shapeOf(tl), nz = /Z(-?[\d.]+)/.exec(l), nr = /X(-?[\d.]+)/.exec(l);
    const tz = nz ? +nz[1] : z, tr = nr ? +nr[1] : r;
    if (m[1] === "0") {
      if (z < 90) { const F = dilate(S, g, sh); for (let t = 0; t <= 1; t += 0.02) { const c = Math.round((z + (tz - z) * t - dz - g.z0) / g.h); if (c >= 0 && c < g.n) assert.ok(r + (tr - r) * t >= F[c] - 0.03, `${l}: ${r + (tr - r) * t} < ${F[c]}`); } n++; }
    } else sweep(S, g, sh, z - dz, r, tz - dz, tr);
    z = tz; r = tr;
  }
  assert.ok(n > 20);
});

test("numbers", () => { assert.equal(rpmFor(100, 31.831, 3000), 1000); assert.equal(rpmFor(100, 0, 2000), 2000); near(powerW(90, 0.5, 0.1, 2000), 150); });

test("M8 mode: the relay closes only after the speed is set and opens before the spindle signal goes off", () => {
  const job = JOB({ face: {}, rough: {}, finish: {} }), p = planLathe({ job, tools: T, profile: SHAFT });
  const g = latheGcode(p, job, { ...OUT, spindle: "m8" }, TXT).trim().split("\n");
  let m3 = false, m8 = false;
  for (const l of g) {
    if (/^M3 /.test(l)) m3 = true;
    if (/^M8 /.test(l)) { assert.ok(m3, "M8 vor M3"); m8 = true; }
    if (/^M9 /.test(l)) m8 = false;
    if (/^M5 /.test(l)) { assert.ok(!m8, "M5 vor M9"); m3 = false; }
    if (/^M0 /.test(l)) assert.ok(!m3 && !m8, "Pause mit laufender Spindel");
    if (/^G1/.test(l)) assert.ok(m3 && m8, l);
  }
  assert.ok(!m3 && !m8);
});

test("every ready-made tool is valid and usable", () => {
  assert.ok(LATHE_PRESETS.length >= 30);
  for (const p of LATHE_PRESETS) {
    const x = p.tool, s = shapeOf({ ...x, id: "a", num: 1, name: p.name });
    assert.ok(x.ap > 0 && x.feed > 0 && x.vcPct > 0, p.name);
    if (x.type === "turn") assert.ok(s.aL >= 1 && s.aL <= 90 && s.aR >= 1 && s.aR <= 90 && x.kappa + x.eps < 180, p.name);
    if (x.type === "groove") assert.ok(s.flat > 0); if (x.type === "drill") assert.ok(x.dia > 0);
  }
  for (const p of LATHE_PRESETS.filter(q => q.group === "rough" || q.name === "HSS 80°")) {
    const tl = { ...p.tool, id: "x", num: 9, name: p.name }, plan = planLathe({ job: JOB({ face: { tool: "x" }, rough: { tool: "x" } }), tools: [...T, tl], profile: SHAFT });
    assert.deepEqual(codes(plan), [], p.name);
  }
});
