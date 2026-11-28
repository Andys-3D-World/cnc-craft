// Rotary axis (wrapGcode): TypeScript (src/rotaryWrap.ts) and Rust (src-tauri/src/rotarywrap.rs) must give the same
// program or refuse it with the same error at the same line. Both sides read the same cases
// (fixtures/rotarywrap-cases.json.gz, written by fixtures/rotarywrap-make.py). This test pins what the TypeScript gives
// and the job the Rust side gets for it (fixtures/rotarywrap-expected.json.gz); `cargo test rotarywrap` compares.
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test rotarywrap
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { wrapGcode, type WrapOptions } from "../src/rotaryWrap.ts";
import { wrapJob } from "../src/rotaryRust.ts";

const dir = new URL("./fixtures/", import.meta.url);
// both files are packed (gzip): arcs become many short lines
const read = (name: string) => gunzipSync(readFileSync(new URL(name + ".gz", dir))).toString("utf8");
interface Case { name: string; gcode: string[]; options: WrapOptions; labels: boolean }
const cases: Case[] = JSON.parse(read("rotarywrap-cases.json"));
const optionsOf = (c: Case): WrapOptions => ({ ...c.options, ...(c.labels ? { faceLabel: (k: number) => `face ${k + 1}` } : {}) });
const run = (c: Case) => ({ job: wrapJob(optionsOf(c)), ...wrapGcode(c.gcode, optionsOf(c)) });

test("TypeScript rotary conversion gives the pinned result for every shared case", () => {
  const now: Record<string, unknown> = {};
  for (const c of cases) now[c.name] = JSON.parse(JSON.stringify(run(c)));
  assert.equal(Object.keys(now).length, cases.length, "case names must be unique");
  if (process.env.UPDATE_FIXTURES) writeFileSync(new URL("rotarywrap-expected.json.gz", dir), gzipSync(JSON.stringify(now).replace(/},"/g, "},\n\"") + "\n", { level: 9 }));
  const pinned = JSON.parse(read("rotarywrap-expected.json"));
  assert.deepEqual(Object.keys(pinned), cases.map(c => c.name));
  for (const c of cases) assert.deepEqual(now[c.name], pinned[c.name], c.name);
});

test("the cases cover every stock shape, both ports, both layouts, and every reason to refuse", () => {
  const pinned: Record<string, { ok: boolean; error?: string; lines?: string[] }> = JSON.parse(read("rotarywrap-expected.json"));
  const ok = cases.filter(c => pinned[c.name].ok), errors = new Set(cases.map(c => pinned[c.name].error).filter(Boolean));
  for (const e of ["relative", "inch", "offset", "plane", "arc", "crossing", "cycle"]) assert.ok(errors.has(e), `no case is refused with "${e}"`);
  const shape = (c: Case) => c.options.stock?.shape ?? "round";
  for (const s of ["round", "cone", "rect", "poly"]) assert.ok(ok.filter(c => shape(c) === s).length >= 4, `too few converted cases for ${s}`);
  assert.ok(ok.some(c => c.options.axis === "y") && ok.some(c => c.options.along === "y") && ok.some(c => c.options.reverse));
  assert.ok(ok.reduce((a, c) => a + pinned[c.name].lines!.length, 0) > 50000, "arcs must have been split into many lines");
});
