// Tool magazine: TypeScript (src/magazine.ts) and Rust (src-tauri/src/magazine.rs) must clean stored magazines the same
// way and give the same steps for fetching, putting back and looking, the same checks (rackProblem, rackBlocked,
// needsSteps, runsOn), boxes, forgetTests and tool numbers of programs. Pinned in fixtures/magazine-cases.json.gz;
// `cargo test magazine` compares. After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test magazine
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { cleanMagazine, forgetTests, getSteps, lookSteps, needsSteps, putSteps, rackBlocked, rackBox, rackProblem, runsOn, slotForTool, toolNumbersIn } from "../src/magazine.ts";

const file = new URL("./fixtures/magazine-cases.json.gz", import.meta.url);
const slot = (n: unknown, x: unknown, y: unknown, z: unknown, extra: Record<string, unknown> = {}) => ({ n, x, y, z, set: true, okGet: true, okPut: false, toolId: "t" + n, ...extra });
const raws: unknown[] = [
  null, 7, "x", [], {},
  { kind: "rack", entry: "top", open: "M64 P0", close: "M65 P0", zClear: -5, slots: [slot(1, 100, 50, -60), slot(2, 140, 50, -60), slot(3, 180, 50, -61.5, { okPut: true })], inSpindle: 2 },
  { kind: "rack", entry: "fork", dir: "x+", slide: 35, open: " m64 p3 ", close: "M65P3", zClear: -2, feedXY: 3000, feedZ: 600, slow: 120, openS: 0.5, spinS: 5, auto: true,
    slots: [slot(4, 300, 20, -70, { okPut: true }), slot(2, 300, 60, -70, { okPut: true }), slot(9, 300, 100, -70.25)], inSpindle: 4 },
  { kind: "rack", entry: "fork", dir: "y-", open: "M64 P1", close: "M64 P1", slots: [slot(1, 10, 10, -40)], inSpindle: 0 },
  { kind: "rack", entry: "fork", dir: "y+", open: "M64 P1", close: "M65 P1", slots: [slot(1, 10, 10, -40), slot(2, 14, 12, -40)], inSpindle: 0 },
  { kind: "rack", open: "M64 P7", close: "M65 P7", zClear: -50, approach: 10, slots: [slot(1, 0, 0, -60), slot(5, 50, 0, -40, { toolId: "t1" })] },
  { kind: "rack", open: "M64 P2", close: "M65 P2", slots: [slot(1, 0, 0, -60, { set: false }), slot(2, 30, 0, -60)], inSpindle: 3 },
  { kind: "hand", entry: "sideways", dir: "z+", slide: 500, approach: 1, zClear: 9999, feedXY: 10, feedZ: 1e9, slow: -3, open: "M3", close: "M65 P123", openS: 100, spinS: 1, always: true, size: 2, top: 1000,
    slots: [slot(0, 1, 1, 1), slot(2.5, 1, 1, 1), slot(3, 1, 1, 1), slot(3, 2, 2, 2), slot(4, "1", 2, 3), slot(5, 1, 2, 30000), slot(6, NaN, 0, 0), { n: 7, x: 1, y: 2, z: 3, set: "yes", toolId: "bad id!" },
      { n: 8, x: 1, y: 2, z: 3, set: true, okGet: "true", toolId: "x".repeat(61) }, null, 12, slot(99, -20000, 20000, 0), slot(100, 0, 0, 0)], inSpindle: 2.7 },
  { kind: "rack", open: "M64 P0", close: "M65 P1", slots: Array.from({ length: 30 }, (_, i) => slot(30 - i, i * 40, 0, -50)), inSpindle: 25 },
  { kind: "off", slots: [slot(1, 1, 1, 1)], inSpindle: -1 },
];
const envs = [
  { grbl: true, firmware: "grblHAL", homed: true, inches: false, sensor: true },
  { grbl: true, firmware: "FluidNC", homed: true, inches: false, sensor: false },
  { grbl: true, firmware: "GRBL 1.1h", homed: true, inches: false, sensor: true },
  { grbl: false, firmware: "grblHAL", homed: true, inches: false, sensor: true },
  { grbl: true, firmware: "grblHAL", homed: false, inches: false, sensor: true },
  { grbl: true, firmware: "grblHAL", homed: true, inches: true, sensor: true },
];
const programs = [
  ["G21", "M6 T2 (TOOL 2)", "G0 X1", "T5", "M6", "M06 T7", "M6 T2", "(M6 T9)", "M60", "M600", "; M6 T3", "T 12 M6", "M006", "M6T4"],
  ["G0 X1", "M6 (no number)", "TOOL T3 M6", "t8 m6", "M16", "M6 T99999999999999999999"],
];

test("tool magazine: pinned result for Rust (magazine-cases.json.gz)", () => {
  const cases = raws.map(raw => {
    const m = cleanMagazine(raw);
    return {
      raw, want: {
        m, problem: rackProblem(m), blocked: envs.map(e => rackBlocked(m, e)),
        box: [rackBox(m, { x: 0, y: 0 }), rackBox(m, { x: 50.5, y: -10 }, true)],
        slots: m.slots.map(s => ({ get: getSteps(m, s), put: putSteps(m, s), look: lookSteps(m, s), needGet: needsSteps(m, s, "get"), needPut: needsSteps(m, s, "put"), runs: runsOn(m, s), forTool: slotForTool(m, s.toolId)?.n ?? null })),
      }
    };
  });
  // forgetTests between neighbours and with small changes
  const clean = raws.map(cleanMagazine);
  const forget = clean.flatMap((a, i) => [
    { prev: a, next: clean[(i + 1) % clean.length] },
    { prev: a, next: { ...a, slots: a.slots.map((s, k) => (k === 0 ? { ...s, x: s.x + 0.5 } : s)) } },
    { prev: a, next: { ...a, slide: a.slide + 1 } },
    { prev: a, next: { ...a } },
  ]).map(p => ({ ...p, want: forgetTests(p.prev, p.next) }));
  const tools = programs.map(lines => ({ lines, want: toolNumbersIn(lines) }));
  assert.ok(cases.some(c => c.want.problem.why === "") && cases.some(c => c.want.problem.why === "near") && cases.some(c => c.want.slots.some(s => s.runs)));
  const text = JSON.stringify({ envs, cases, forget, tools }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
