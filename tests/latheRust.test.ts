// Lathe (planLathe + latheGcode): TypeScript (src/lathe/turn.ts) and Rust (src-tauri/src/lathe.rs) must give the same
// messages and the same program. This test builds the shared cases, pins what the TypeScript gives in
// fixtures/lathe-cases.json.gz (job for Rust, messages, number of runs, G-code); `cargo test lathe` compares the Rust result.
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test lathe
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import en from "../src/i18n/lang/en.json" with { type: "json" };
import { DEFAULT_LATHE_TOOLS as T, latheGcode, planLathe, type LatheJob, type LatheOp, type LatheOut, type LatheTool, type Pt } from "../src/lathe/turn.ts";
import { latheRustJob } from "../src/lathe/latheRust.ts";

const file = new URL("./fixtures/lathe-cases.json.gz", import.meta.url);
const EN = en as Record<string, string>;
// like ascii() in i18n.ts for the texts used here: no brackets
const asc = (s: string) => s.replace(/[()]/g, "");
const sub = (s: string, v?: Record<string, string | number>) => Object.entries(v || {}).reduce((a, [k, x]) => a.split(`{${k}}`).join(String(x)), s);
const ops = (o: Partial<Record<LatheOp["kind"], Partial<LatheOp>>>): LatheOp[] => ([["face", "l1"], ["rough", "l1"], ["finish", "l2"], ["drill", "l4"], ["groove", "l3"], ["part", "l3"]] as [LatheOp["kind"], string][])
  .map(([kind, tool]) => ({ kind, on: !!o[kind], tool, z: -10, width: 2, d: kind === "part" ? 0 : 10, depth: 10, ...(o[kind] || {}) }));
const JOB = (o: Parameters<typeof ops>[0], x: Partial<LatheJob> = {}): LatheJob => ({ stockD: 30, faceAllow: 1, stickOut: 60, margin: 3, allowX: 0.2, allowZ: 0.05, vc: 90, maxRpm: 1500, safeX: 3, safeZ: 5, clear: 0.5, tailOn: false, tailD: 8, tailZ: 0, ops: ops(o), ...x });
const OUT: LatheOut = { xMode: "radius", xSign: 1, spindle: "auto", dir: "M3" };
const ALL = { face: {}, rough: {}, finish: {} };
const SHAFT: Pt[][] = [[{ z: 0, r: 0 }, { z: 0, r: 6 }, { z: -15, r: 6 }, { z: -15, r: 10 }, { z: -30, r: 10 }, { z: -40, r: 13 }]];
const arc = (z0: number, r0: number, rad: number, n: number, from: number, to: number): Pt[] => Array.from({ length: n + 1 }, (_, i) => { const a = from + (to - from) * i / n; return { z: z0 + rad * Math.cos(a), r: r0 + rad * Math.sin(a) }; });
const BALL: Pt[][] = [[{ z: 0, r: 0 }, ...arc(-8, 0, 8, 24, 0, Math.PI / 2), { z: -8, r: 8 }, { z: -12, r: 5 }, { z: -20, r: 5 }, { z: -20, r: 11 }, { z: -28, r: 11 }]];
const VALLEY: Pt[][] = [[{ z: 0, r: 0 }, { z: 0, r: 10 }, { z: -5, r: 10 }, { z: -10, r: 6 }, { z: -15, r: 10 }, { z: -22, r: 12 }, { z: -26, r: 8 }, { z: -32, r: 12 }]];
const TAPER: Pt[][] = [[{ z: 0, r: 0 }, { z: 0, r: 4 }, { z: -20, r: 9 }, { z: -20, r: 12 }, { z: -35, r: 12 }]];
const tools = (patch: Record<string, Partial<LatheTool>> = {}) => T.map(t => ({ ...t, ...(patch[t.id] || {}) }));
const extra: LatheTool[] = [
  { id: "l5", num: 5, name: "DCMT left (L) 0.8", type: "turn", hand: "L", nose: 0.8, kappa: 93, eps: 55, width: 0, dia: 0, ap: 0.7, feed: 0.12, vcPct: 90 },
  { id: "l6", num: 6, name: "Neutral 35", type: "turn", hand: "N", nose: 0.4, kappa: 90, eps: 35, width: 0, dia: 0, ap: 0.3, feed: 0.06, vcPct: 110 },
  { id: "l7", num: 7, name: "Groove 3 mm", type: "groove", hand: "N", nose: 0, kappa: 90, eps: 0, width: 3, dia: 0, ap: 1, feed: 0.04, vcPct: 50 },
];
type Case = { name: string; job: LatheJob; tools: LatheTool[]; profile: Pt[][]; out: LatheOut };
const cases: Case[] = [];
const add = (name: string, job: LatheJob, profile: Pt[][] = SHAFT, out: Partial<LatheOut> = {}, tl: LatheTool[] = tools()) => cases.push({ name, job, tools: tl, profile, out: { ...OUT, ...out } });
add("shaft: face, rough, finish", JOB(ALL));
add("shaft: rough only", JOB({ rough: {} }));
add("shaft: finish only fails (too much material)", JOB({ finish: {} }));
add("ball and neck: face, rough, finish", JOB(ALL), BALL);
add("valley: the roughing tool goes down the right flank", JOB(ALL), VALLEY);
add("taper", JOB(ALL), TAPER);
add("diameter mode, X mirrored, M4, coolant output switches the motor", JOB(ALL), SHAFT, { xMode: "dia", xSign: -1, dir: "M4", spindle: "m8" });
add("G7 and G8", JOB({ rough: {}, finish: {} }), SHAFT, { xMode: "g7" });
add("G8 radius mode", JOB({ rough: {} }), TAPER, { xMode: "g8" });
add("spindle by hand", JOB(ALL), SHAFT, { spindle: "hand" });
add("groove and part off", JOB({ rough: {}, groove: { z: -25, width: 5, d: 14 }, part: {} }));
add("groove as wide as the tool, part off to a stub", JOB({ groove: { z: -8, width: 2, d: 6 }, part: { d: 4 } }), SHAFT);
add("groove too narrow, groove too deep, groove outside the part", JOB({ groove: { z: -8, width: 1, d: 6 } }));
add("groove too deep", JOB({ groove: { z: -8, width: 3, d: 40 } }));
add("groove outside the part", JOB({ groove: { z: -55, width: 3, d: 6 } }));
add("drill, then rough and finish", JOB({ drill: { depth: 12 }, rough: {}, finish: {} }));
add("drill deeper than the stick-out, drill too big", JOB({ drill: { depth: 80 } }));
add("drill bigger than the stock", JOB({ drill: { depth: 10 } }), SHAFT, {}, tools({ l4: { dia: 40 } }));
add("drill depth zero", JOB({ drill: { depth: 0 } }));
add("tailstock: no facing, no drilling", JOB({ face: {}, rough: {}, finish: {}, drill: {} }, { tailOn: true, tailD: 8, tailZ: 2 }));
add("tailstock in the way of the roughing tool", JOB({ rough: {} }, { tailOn: true, tailD: 20, tailZ: -1 }));
add("slender part without tailstock: soft warning", JOB(ALL, { stockD: 12, stickOut: 60 }), [[{ z: 0, r: 0 }, { z: 0, r: 4 }, { z: -40, r: 4 }, { z: -45, r: 5.5 }]]);
add("part too long for the stick-out", JOB(ALL, { stickOut: 30 }));
add("stock too small, no profile, bad speeds", JOB(ALL, { stockD: 20 }));
add("no profile", JOB(ALL), []);
add("bad speeds", JOB(ALL, { vc: 0 }));
add("unknown tool and wrong tool type", JOB({ rough: { tool: "nope" }, finish: { tool: "l3" } }));
add("tool with no feed", JOB({ rough: {} }), SHAFT, {}, tools({ l1: { feed: 0 } }));
add("left-hand, neutral tools and a wide groove tool", JOB({ face: { tool: "l6" }, rough: { tool: "l5" }, finish: { tool: "l6" }, groove: { tool: "l7", z: -24, width: 8, d: 12 }, part: { tool: "l7" } }), BALL, {}, [...tools(), ...extra]);
add("same tool twice in a row: no tool change in between", JOB({ face: { tool: "l1" }, rough: { tool: "l1" }, finish: { tool: "l1" } }));
add("nothing to face, big allowances, fine steps", JOB(ALL, { faceAllow: 0, allowX: 1, allowZ: 0.5 }), VALLEY, {}, tools({ l1: { ap: 0.25 }, l2: { ap: 0.1 } }));
add("finish leaves rest material in a corner", JOB({ rough: {}, finish: {} }), [[{ z: 0, r: 0 }, { z: 0, r: 8 }, { z: -10, r: 8 }, { z: -10.05, r: 12 }, { z: -20, r: 12 }]], {}, tools({ l2: { nose: 1.2 } }));
add("max rpm limits, large stock", JOB(ALL, { stockD: 80, maxRpm: 600, stickOut: 50 }), [[{ z: 0, r: 0 }, { z: 0, r: 30 }, { z: -20, r: 30 }, { z: -20, r: 38 }, { z: -30, r: 38 }]]);
add("small stock, high speed limit", JOB(ALL, { stockD: 8, maxRpm: 5000, stickOut: 25 }), [[{ z: 0, r: 0 }, { z: 0, r: 2 }, { z: -6, r: 2 }, { z: -6, r: 3.5 }, { z: -12, r: 3.5 }]]);
add("thread-like zigzag profile", JOB(ALL), [[{ z: 0, r: 0 }, { z: 0, r: 9 }, ...Array.from({ length: 16 }, (_, i) => ({ z: -1 - i * 1.5, r: i % 2 ? 9 : 8.2 })), { z: -26, r: 12 }]]);
add("two separate profile lines and a closed shape", JOB(ALL), [[{ z: 0, r: 0 }, { z: 0, r: 7 }, { z: -12, r: 7 }], [{ z: -12, r: 7 }, { z: -12, r: 11 }, { z: -24, r: 11 }, { z: -24, r: 7 }, { z: -12, r: 7 }]]);
add("profile above the axis, closed back to the start", JOB(ALL), [[{ z: 0, r: 2 }, { z: 0, r: 9 }, { z: -18, r: 9 }, { z: -18, r: 2 }, { z: 0, r: 2 }]]);

add("ball and neck: face and rough", JOB({ face: {}, rough: {} }), BALL);
add("valley: rough, groove, part off", JOB({ rough: {}, groove: { z: -18, width: 3, d: 12 }, part: { d: 2 } }), VALLEY);
add("zigzag: rough only, G7", JOB({ rough: {} }), [[{ z: 0, r: 0 }, { z: 0, r: 9 }, ...Array.from({ length: 16 }, (_, i) => ({ z: -1 - i * 1.5, r: i % 2 ? 9 : 8.2 })), { z: -26, r: 12 }]], { xMode: "g7" });
add("drill, then face and rough, by hand", JOB({ drill: { depth: 14 }, face: {}, rough: {} }), SHAFT, { spindle: "hand" });
add("left-hand and neutral tools without finishing", JOB({ face: { tool: "l6" }, rough: { tool: "l5" }, groove: { tool: "l7", z: -24, width: 8, d: 12 } }), BALL, {}, [...tools(), ...extra]);
add("neutral tool roughs the valley, mirrored X in diameter", JOB({ rough: { tool: "l6" } }), VALLEY, { xMode: "dia", xSign: -1 }, [...tools(), ...extra]);
add("roughing with big allowance, then finishing", JOB({ rough: {}, finish: {} }, { allowX: 0.05, allowZ: 0 }), TAPER, {}, tools({ l2: { ap: 0.5 } }));

add("part off near the chuck: the parting tool needs room behind the part", JOB({ rough: {}, part: {} }, { stickOut: 55, margin: 3 }), [[{ z: 0, r: 0 }, { z: 0, r: 8 }, { z: -50, r: 8 }]]);
add("long part close to the chuck margin", JOB({ rough: {}, finish: {} }, { stickOut: 60, margin: 3 }), [[{ z: 0, r: 0 }, { z: 0, r: 8 }, { z: -40, r: 8 }, { z: -56.5, r: 11 }]]);
add("drill after facing with a wide stock in front", JOB({ face: {}, drill: { depth: 6 } }, { faceAllow: 3 }), SHAFT, {}, tools({ l4: { ap: 1.5 } }));

const rustJob = (c: Case) => latheRustJob(c.job, c.tools, c.profile, c.out, k => EN["lathe.gc." + k], asc);
const run = (c: Case) => {
  const plan = planLathe({ job: c.job, tools: c.tools, profile: c.profile });
  const hard = plan.issues.some(i => i.hard);
  const gcode = hard || !plan.runs.length ? null : latheGcode(plan, c.job, c.out, (k, v) => asc(sub(EN["lathe.gc." + k], v)));
  return { name: c.name, job: rustJob(c), issues: plan.issues.map(i => (i.v === undefined ? { code: i.code, op: i.op, hard: i.hard } : { code: i.code, op: i.op, v: i.v, hard: i.hard })), runs: plan.runs.length, gcode };
};

test("TypeScript lathe gives the pinned result for every shared case", () => {
  const now = cases.map(run);
  assert.equal(new Set(now.map(c => c.name)).size, now.length, "case names must be unique");
  const text = "[\n" + now.map(c => JSON.stringify(c)).join(",\n") + "\n]\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  const pinned = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
  assert.deepEqual(pinned.map((c: any) => c.name), now.map(c => c.name));
  for (let i = 0; i < now.length; i++) assert.deepEqual(pinned[i], JSON.parse(JSON.stringify(now[i])), now[i].name);
});

test("the cases make programs, refuse jobs and warn", () => {
  const now = cases.map(run);
  assert.ok(now.filter(c => c.gcode).length >= 20, "programs");
  assert.ok(now.filter(c => !c.gcode).length >= 8, "refused jobs");
  assert.ok(now.some(c => c.issues.some(i => !i.hard) && c.gcode), "soft warnings beside a program");
  assert.ok(now.reduce((a, c) => a + (c.gcode ? c.gcode.split("\n").length : 0), 0) > 3000, "enough lines");
});
