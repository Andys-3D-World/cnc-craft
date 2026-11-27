// Material removal for the 3D view: TypeScript (src/view3d/carveSim.ts) and Rust (src-tauri/src/carvesim.rs) must give the same result.
// Both sides read the same cases (fixtures/carvesim-cases.json). This test pins what the TypeScript gives
// (fixtures/carvesim-expected.json, heights as the exact 32-bit numbers, zlib-packed, base64); `cargo test` compares the Rust result with it.
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && UPDATE_FIXTURES=1 cargo test carvesim
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { carve, carveHere, type CarveResult } from "../src/view3d/carveSim.ts";
import { carveJob, decodeCarve } from "../src/view3d/carveRust.ts";
import type { ToolGeom } from "../src/toolGraphics.ts";

const dir = new URL("./fixtures/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
interface Case { name: string; lines?: string[]; file?: string; job: { tools: (ToolGeom | null)[]; maxCells: number } }
const cases: Case[] = JSON.parse(read("carvesim-cases.json"));
const linesOf = (c: Case) => c.file ? read(c.file).split("\n") : c.lines!;
/** Result as plain JSON; the heights as base64 of their bytes */
const dump = (r: CarveResult | null) => r && {
  nx: r.nx, ny: r.ny, x0: r.x0, y0: r.y0, cell: r.cell, minZ: r.minZ, moves: r.moves,
  h: Buffer.from(r.h.buffer, r.h.byteOffset, r.h.byteLength).toString("base64")
};
type Dump = ReturnType<typeof dump>;
/** In the files the heights are zlib-packed (mostly zeros). Compared is always the unpacked content. */
const pack = (d: Dump) => d && { ...d, h: deflateSync(Buffer.from(d.h, "base64"), { level: 9 }).toString("base64") };
const unpack = (d: Dump) => d && { ...d, h: inflateSync(Buffer.from(d.h, "base64")).toString("base64") };
const run = (c: Case) => carveHere(linesOf(c), c.job.tools, () => true, c.job.maxCells);

test("TypeScript carve gives the pinned result for every shared case", async () => {
  const now: Record<string, Dump> = {};
  for (const c of cases) now[c.name] = dump(await run(c));
  assert.equal(Object.keys(now).length, cases.length, "case names must be unique");
  if (process.env.UPDATE_FIXTURES) {
    const packed = Object.fromEntries(Object.entries(now).map(([k, v]) => [k, pack(v)]));
    writeFileSync(new URL("carvesim-expected.json", dir), JSON.stringify(packed).replace(/},"/g, "},\n\"") + "\n");
  }
  const pinned = JSON.parse(read("carvesim-expected.json"));
  for (const c of cases) assert.deepEqual(now[c.name], unpack(pinned[c.name]), c.name);
  assert.deepEqual(Object.keys(pinned), cases.map(c => c.name));
});

test("the cases really cut, with every tool shape", async () => {
  const types = new Set(cases.flatMap(c => c.job.tools.map(t => t?.type)));
  for (const t of ["endmill", "ball", "bullnose", "vbit", "chamfer", "countersink", "drill", "spotdrill", "taper", undefined]) assert.ok(types.has(t as never), String(t));
  let cut = 0;
  for (const c of cases) { const r = await run(c); if (r) cut += r.h.reduce((s, v) => s + (v < 0 ? 1 : 0), 0); }
  assert.ok(cut > 20000);
});

test("without the app, carve() is the TypeScript calculation", async () => {
  const c = cases.find(k => k.name === "ball")!;
  assert.deepEqual(dump(await carve(linesOf(c), c.job.tools, () => true, c.job.maxCells)), dump(await run(c)));
});

test("bytes written by Rust are read back to the same result", async () => {
  // carvesim-sample.bin is carvesim::encode() of the case "byte layout sample" (cargo test keeps it current)
  const c = cases.find(k => k.name === "byte layout sample")!;
  const bytes = readFileSync(new URL("carvesim-sample.bin", dir));
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  // end mills only: + − × ÷ and square roots, so every number is the same to the last bit
  assert.deepEqual(dump(decodeCarve(buf)), dump(await run(c)));
  assert.equal(decodeCarve(new ArrayBuffer(0)), null);
  assert.throws(() => decodeCarve(buf.slice(0, buf.byteLength - 4)));
});

test("job for Rust: only the shape of the tools, nothing that JSON would change", () => {
  const tl = { type: "vbit", diameter: 6, angle: 90, tipDia: 0.2, cornerR: 0, name: "Stichel (privat)", notes: "x" } as unknown as ToolGeom;
  assert.deepEqual(JSON.parse(carveJob([tl, null], 5000)!), { tools: [{ type: "vbit", diameter: 6, angle: 90, tipDia: 0.2, cornerR: 0 }, null], maxCells: 5000 });
  assert.equal(carveJob([{ ...tl, diameter: NaN }], 5000), null);
  assert.equal(carveJob([{ ...tl, angle: "90" } as unknown as ToolGeom], 5000), null);
  assert.equal(carveJob([{ ...tl, type: "v-bit ä" } as unknown as ToolGeom], 5000), null);
  assert.equal(carveJob([tl], Infinity), null);
});

// Big comparison with your own files in full resolution (not in the repository): put *.gcode into a folder, then
//   CARVESIM_COMPARE=/path/to/folder node --test tests/carveSimRust.test.ts
//   cd src-tauri && CARVESIM_COMPARE=/path/to/folder cargo test --release carvesim -- --ignored --nocapture
test("write the TypeScript result for local files", { skip: !process.env.CARVESIM_COMPARE }, async () => {
  const folder = process.env.CARVESIM_COMPARE!;
  const tl = (type: string, diameter: number, angle = 0) => ({ type, diameter, angle, tipDia: 0, cornerR: 0 }) as unknown as ToolGeom;
  const job = { tools: [tl("endmill", 3), tl("vbit", 6, 60), tl("ball", 6)], maxCells: 5_000_000 };
  for (const f of readdirSync(folder).filter(n => n.endsWith(".gcode"))) {
    const lines = readFileSync(`${folder}/${f}`, "utf8").split("\n");
    const start = performance.now();
    const r = await carveHere(lines, job.tools, () => true, job.maxCells);
    console.log(`${f}: ${r ? r.nx * r.ny : 0} cells, ${(performance.now() - start).toFixed(0)} ms in TypeScript`);
    writeFileSync(`${folder}/${f.slice(0, -6)}.carve.json`, JSON.stringify({ job, result: pack(dump(r)) }));
  }
});
