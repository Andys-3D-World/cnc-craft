// Keep-out zones for clamps (applyKeepOuts): TypeScript (src/keepOut.ts) and Rust (src-tauri/src/keepout.rs) must give
// the same program, the same number of lifts and the same reports. Both sides read the same cases
// (fixtures/keepout-cases.json, written by fixtures/keepout-make.py). This test pins what the TypeScript gives
// (fixtures/keepout-expected.json); `cargo test keepout` compares the Rust result with it, line by line and exactly:
// this is text that goes to the machine.
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test keepout
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { applyKeepOuts, type KeepZone } from "../src/keepOut.ts";

const dir = new URL("./fixtures/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
interface Case { name: string; gcode: string[]; zones: KeepZone[]; radius: number; note: string }
interface Pinned { gcode: string[]; raised: number; hits: unknown[]; unsure: boolean }
const cases: Case[] = JSON.parse(read("keepout-cases.json"));
const run = (c: Case): Pinned => {
  const r = applyKeepOuts(c.gcode.join("\n"), c.zones, { radius: c.radius, note: c.note });
  return { gcode: r.gcode.split("\n"), raised: r.raised, hits: r.hits, unsure: r.unsure };
};

test("TypeScript keep-out zones give the pinned result for every shared case", () => {
  const now: Record<string, Pinned> = {};
  for (const c of cases) now[c.name] = run(c);
  assert.equal(Object.keys(now).length, cases.length, "case names must be unique");
  if (process.env.UPDATE_FIXTURES) writeFileSync(new URL("keepout-expected.json", dir), JSON.stringify(now).replace(/},"/g, "},\n\"") + "\n");
  const pinned = JSON.parse(read("keepout-expected.json"));
  assert.deepEqual(Object.keys(pinned), cases.map(c => c.name));
  for (const c of cases) assert.deepEqual(now[c.name], pinned[c.name], c.name);
});

test("the cases do something: lifts, reports of both kinds, unsure programs, untouched programs", () => {
  const pinned: Record<string, Pinned> = JSON.parse(read("keepout-expected.json"));
  const all = cases.map(c => ({ c, p: pinned[c.name] }));
  const kinds = (k: string) => all.filter(({ p }) => (p.hits as { kind: string }[]).some(h => h.kind === k)).length;
  assert.ok(all.filter(({ p }) => p.raised > 0).length >= 40, "lifts");
  assert.ok(kinds("cut") >= 25 && kinds("rapid") >= 10, `cut ${kinds("cut")}, rapid ${kinds("rapid")}`);
  assert.ok(all.filter(({ p }) => p.unsure).length >= 3, "unsure");
  assert.ok(all.filter(({ c, p }) => p.gcode.join("\n") === c.gcode.join("\n")).length >= 8, "untouched");
});

test("the program only gains lifts and split rapids – every source line is still there, in order", () => {
  // every line of the result is either a line of the source (in order) or an inserted "G0 Z… note" / split "G0 X… Y…"
  for (const c of cases) {
    const out = run(c).gcode;
    let i = 0;
    for (const line of out) {
      if (i < c.gcode.length && line === c.gcode[i]) { i++; continue; }
      const lift = /^G0 Z-?\d+\.\d{3} /.test(line + " ") && line.endsWith(c.note);
      const split = /^G0( X-?[\d.e+]+)?( Y-?[\d.e+]+)?$/.test(line);
      assert.ok(lift || split, `${c.name}: unexpected line "${line}"`);
      if (split) i++; // stands for the source line with X, Y and Z
    }
    assert.equal(i, c.gcode.length, `${c.name}: every source line is still there`);
  }
});
