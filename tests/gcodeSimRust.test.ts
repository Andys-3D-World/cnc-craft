// G-code reader: TypeScript (src/sim/gcodeParser.ts) and Rust (src-tauri/src/gcodesim.rs) must give the same result.
// Both sides read the same cases (fixtures/gcodesim-cases.json). This test pins what the TypeScript gives
// (fixtures/gcodesim-expected.json); `cargo test` compares the Rust result with that file.
// After a wanted change to the reader:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && UPDATE_FIXTURES=1 cargo test gcodesim
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { parseGcodeProgram, type ParseOptions, type SimProgram } from "../src/sim/gcodeParser.ts";
import { decodeProgram, rustParseOpts } from "../src/sim/parseRust.ts";

const dir = new URL("./fixtures/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
interface Case { name: string; lines?: string[]; file?: string; opts: ParseOptions }
const cases: Case[] = JSON.parse(read("gcodesim-cases.json"));
const linesOf = (c: Case) => c.file ? read(c.file).split("\n") : c.lines!;

/** What is compared, as plain JSON (numbers that are not finite become null) */
export function dump(p: SimProgram) {
  const arr = (a?: ArrayLike<number>) => a ? Array.from(a) : null;
  const b = p.bounds;
  return JSON.parse(JSON.stringify({
    n: p.n, type: arr(p.type), line: arr(p.line),
    x0: arr(p.x0), y0: arr(p.y0), z0: arr(p.z0), x1: arr(p.x1), y1: arr(p.y1), z1: arr(p.z1),
    t0: arr(p.t0), dur: arr(p.dur), durPlain: arr(p.durPlain), a0: arr(p.a0), a1: arr(p.a1),
    totalTime: p.totalTime, cutLength: p.cutLength, rapidLength: p.rapidLength,
    bounds: [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ], cutMinZ: p.cutMinZ, cutMaxZ: p.cutMaxZ,
    notes: p.notes ?? []
  }));
}

test("TypeScript reader gives the pinned result for every shared case", () => {
  const now: Record<string, unknown> = {};
  for (const c of cases) now[c.name] = dump(parseGcodeProgram(linesOf(c), c.opts));
  assert.equal(Object.keys(now).length, cases.length, "case names must be unique");
  if (process.env.UPDATE_FIXTURES) writeFileSync(new URL("gcodesim-expected.json", dir), JSON.stringify(now) + "\n");
  const pinned = JSON.parse(read("gcodesim-expected.json"));
  for (const c of cases) assert.deepEqual(now[c.name], pinned[c.name], c.name);
  assert.deepEqual(Object.keys(pinned), cases.map(c => c.name));
});

test("the cases cover lines, arcs, cycles, A axis, notes and ramps", () => {
  const all = cases.map(c => parseGcodeProgram(linesOf(c), c.opts));
  assert.ok(all.reduce((s, p) => s + p.n, 0) > 3000);
  assert.ok(all.some(p => p.a0) && all.some(p => p.durPlain) && all.some(p => (p.notes?.length ?? 0) >= 50));
  for (const kind of [0, 1, 2]) assert.ok(all.some(p => p.type.includes(kind)));
});

test("bytes written by Rust are read back to the same program", () => {
  // gcodesim-sample.bin is gcodesim::encode() of the case "byte layout sample" (cargo test keeps it current)
  const c = cases.find(k => k.name === "byte layout sample")!;
  const bytes = readFileSync(new URL("gcodesim-sample.bin", dir));
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const lines = linesOf(c);
  const fromRust = decodeProgram(buf, lines, c.opts);
  const here = parseGcodeProgram(lines, c.opts);
  // no arcs in this case: only + − × ÷ and square roots, so every number is the same to the last bit
  assert.deepEqual(dump(fromRust), dump(here));
  assert.equal(fromRust.lines, lines);
  assert.deepEqual(fromRust.motion, c.opts.motion);
  assert.ok(fromRust.a0 && fromRust.durPlain && fromRust.notes?.length);
  for (const k of ["x0", "t0", "line", "type", "a0"] as const) assert.equal(fromRust[k]!.constructor, here[k]!.constructor);
});

test("a damaged answer is refused", () => {
  const bytes = readFileSync(new URL("gcodesim-sample.bin", dir));
  const cut = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength - 1) as ArrayBuffer;
  assert.throws(() => decodeProgram(cut, [], {}));
});

test("options for Rust carry only numbers", () => {
  const s = rustParseOpts({ arcTol: 0.1, motion: { accel: [1, 2, 3], maxRate: [4, 5, 6], junctionDev: 0.01, lookahead: 16, source: "saved" } });
  assert.deepEqual(JSON.parse(s), { arcTol: 0.1, motion: { accel: [1, 2, 3], maxRate: [4, 5, 6], junctionDev: 0.01, lookahead: 16 } });
  assert.ok(/^[\x20-\x7e]*$/.test(s));
});

// Big comparison with your own files (not in the repository): put *.gcode into a folder, then
//   GCODESIM_COMPARE=/path/to/folder node --test tests/gcodeSimRust.test.ts
//   cd src-tauri && GCODESIM_COMPARE=/path/to/folder cargo test --release gcodesim -- --ignored --nocapture
test("write the TypeScript result for local files", { skip: !process.env.GCODESIM_COMPARE }, () => {
  const folder = process.env.GCODESIM_COMPARE!;
  const opts: ParseOptions = { motion: { accel: [300, 300, 100], maxRate: [5000, 5000, 1500], junctionDev: 0.01, arcTol: 0.002, lookahead: 16 } };
  for (const f of readdirSync(folder).filter(n => n.endsWith(".gcode"))) {
    const lines = readFileSync(`${folder}/${f}`, "utf8").split("\n");
    const start = performance.now();
    const p = parseGcodeProgram(lines, opts);
    console.log(`${f}: ${lines.length} lines, ${p.n} moves, ${(performance.now() - start).toFixed(1)} ms in TypeScript`);
    writeFileSync(`${folder}/${f.slice(0, -6)}.expected.json`, JSON.stringify({ ...dump(p), opts }));
  }
});
