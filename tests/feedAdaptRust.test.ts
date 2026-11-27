// Feed adaption in tight curves (adaptFeed): TypeScript (src/feedAdapt.ts) and Rust (src-tauri/src/feedadapt.rs) must
// give the same G-code. Both sides read the same cases (fixtures/feedadapt-cases.json). This test pins what the
// TypeScript gives (fixtures/feedadapt-expected.json); `cargo test feedadapt` compares the Rust result with it,
// line by line and exactly: this is text that goes to the machine.
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test feedadapt
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { adaptFeed } from "../src/feedAdapt.ts";

const dir = new URL("./fixtures/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
interface Case { name: string; gcode: string[]; r: number; pct: number }
const cases: Case[] = JSON.parse(read("feedadapt-cases.json"));

test("TypeScript feed adaption gives the pinned result for every shared case", () => {
  const now: Record<string, string[]> = {};
  for (const c of cases) now[c.name] = adaptFeed(c.gcode.join("\n"), c.r, c.pct).split("\n");
  assert.equal(Object.keys(now).length, cases.length, "case names must be unique");
  if (process.env.UPDATE_FIXTURES) writeFileSync(new URL("feedadapt-expected.json", dir), JSON.stringify(now).replace(/],"/g, "],\n\"") + "\n");
  const pinned = JSON.parse(read("feedadapt-expected.json"));
  assert.deepEqual(Object.keys(pinned), cases.map(c => c.name));
  for (const c of cases) assert.deepEqual(now[c.name], pinned[c.name], c.name);
});

test("the cases do change something: slower feeds, split moves, untouched programs", () => {
  const pinned: Record<string, string[]> = JSON.parse(read("feedadapt-expected.json"));
  const changed = cases.filter(c => pinned[c.name].join("\n") !== c.gcode.join("\n")).length;
  const split = cases.filter(c => pinned[c.name].length > c.gcode.length + 1).length;
  assert.ok(changed >= 15, `only ${changed} cases are changed`);
  assert.ok(split >= 5, `only ${split} cases have split moves`);
  assert.ok(cases.length - changed >= 5, "some cases must stay untouched");
});
