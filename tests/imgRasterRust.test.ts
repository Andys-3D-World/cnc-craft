// Image engraving (resample, adjust, raster methods): TypeScript (src/raster/dither.ts) and Rust (src-tauri/src/imgraster.rs)
// must give the same pixels. Both sides build the same test image and read the same cases (fixtures/imgraster-cases.json).
// This test pins what the TypeScript gives (fixtures/imgraster-expected.json, checksums of the exact 32-bit numbers);
// `cargo test` compares the Rust result with it. Methods that use sin/cos/atan2 per pixel (spiral, waves, crosshatch,
// rotated dot and line screens) may differ in single edge pixels between engines – for those the pixels themselves are
// stored and the differences are counted (at most 1 in 2000).
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test imgraster
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resample, applyAdjustCpu, rasterize, toGray, type Adjust, type RasterSettings } from "../src/raster/dither.ts";
import { decodeBurn, rasterJob } from "../src/raster/rasterRust.ts";

const dir = new URL("./fixtures/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
interface Job { sw: number; sh: number; gw: number; gh: number; adjust: Adjust; raster: RasterSettings }
interface Case { name: string; seed: number; job: Job }
const cases: Case[] = JSON.parse(read("imgraster-cases.json"));

/** Test image: gradient, rectangles, a disc and noise – only + − × ÷ and whole-number random, the same in Rust */
function testImage(w: number, h: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / w, v = y / h;
    let val = 0.15 + 0.7 * u * (1 - 0.5 * v);
    if (u > 0.2 && u < 0.45 && v > 0.3 && v < 0.7) val = 0.05;
    if (u > 0.6 && u < 0.9 && v > 0.1 && v < 0.35) val = 0.95;
    const dx = u - 0.7, dy = v - 0.7;
    if (dx * dx + dy * dy < 0.03) val = 0.5 + 0.4 * (dx + dy) * 4;
    val += (rnd() - 0.5) * 0.08;
    g[y * w + x] = val < 0 ? 0 : val > 1 ? 1 : val;
  }
  return g;
}
/** FNV-1a over the bytes of the 32-bit numbers */
function fnv(v: Float32Array): number {
  const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619);
  return h >>> 0;
}
const usesAngles = (r: RasterSettings) => ["spiral", "waves", "crosshatch"].includes(r.method) || ((r.method === "halftone" || r.method === "lines") && r.angle !== 0);

function steps(base: Float32Array, j: Job) {
  const small = resample(base, j.sw, j.sh, j.gw, j.gh);
  const g = applyAdjustCpu(small, j.gw, j.gh, j.adjust);
  return { small, g, burn: rasterize(g, j.gw, j.gh, j.raster) };
}
function result(c: Case) {
  const base = testImage(c.job.sw, c.job.sh, c.seed);
  const { small, g, burn } = steps(base, c.job);
  const on = burn.reduce((s, b) => s + (b >= 0.5 ? 1 : 0), 0);
  return {
    burn,
    dump: {
      image: fnv(base), resampled: fnv(small), adjusted: fnv(g), on,
      ...(usesAngles(c.job.raster) ? { bits: Array.from(burn, b => (b >= 0.5 ? "1" : "0")).join("") } : { burn: fnv(burn) })
    }
  };
}

test("TypeScript image engraving gives the pinned result for every shared case", () => {
  const now: Record<string, ReturnType<typeof result>["dump"]> = {};
  for (const c of cases) now[c.name] = result(c).dump;
  assert.equal(Object.keys(now).length, cases.length, "case names must be unique");
  if (process.env.UPDATE_FIXTURES) writeFileSync(new URL("imgraster-expected.json", dir), JSON.stringify(now).replace(/},"/g, "},\n\"") + "\n");
  const pinned: typeof now = JSON.parse(read("imgraster-expected.json"));
  assert.deepEqual(Object.keys(pinned), cases.map(c => c.name));
  for (const c of cases) {
    const a = now[c.name], b = pinned[c.name];
    if (a.bits === undefined) { assert.deepEqual(a, b, c.name); continue; }
    // sin/cos per pixel: another processor may flip single edge pixels
    assert.deepEqual({ ...a, bits: 0, on: 0, adjusted: 0 }, { ...b, bits: 0, on: 0, adjusted: 0 }, c.name);
    let d = 0;
    for (let i = 0; i < a.bits.length; i++) if (a.bits[i] !== b.bits![i]) d++;
    assert.ok(a.bits.length === b.bits!.length && d * 2000 <= a.bits.length, `${c.name}: ${d} pixels differ`);
  }
});

test("the cases cover every raster method, growing and shrinking, and every adjustment", () => {
  const methods = new Set(cases.map(c => c.job.raster.method));
  for (const m of ["threshold", "floyd", "jarvis", "stucki", "atkinson", "sierra", "bayer", "halftone", "lines", "gray", "stipple", "spiral", "waves", "crosshatch"]) assert.ok(methods.has(m as never), m);
  assert.ok(cases.some(c => c.job.gw > c.job.sw) && cases.some(c => c.job.gw < c.job.sw));
  for (const k of ["gamma", "brightness", "contrast", "sharpen", "denoise", "local"] as const) assert.ok(cases.some(c => (c.job.adjust[k] ?? 0) !== (k === "gamma" ? 1 : 0)), k);
  assert.ok(cases.some(c => c.job.adjust.invert) && cases.some(c => c.job.adjust.curve));
  // every case burns something, and not everything
  for (const c of cases) {
    if (c.name.startsWith("exactly half grey, threshold")) continue; // all off: half grey is not below one half
    const { burn } = result(c); const on = burn.reduce((s, b) => s + b, 0); assert.ok(on > 0 && on < burn.length, c.name);
  }
});

test("answer from Rust: one byte per pixel or one 32-bit number per pixel", () => {
  const head = (kind: number, n: number) => { const b = new ArrayBuffer(16 + n); new Uint32Array(b, 0, 4).set([2, 2, kind, 0]); return b; };
  const bin = head(0, 4); new Uint8Array(bin, 16).set([0, 1, 1, 0]);
  assert.deepEqual(Array.from(decodeBurn(bin, 2, 2)), [0, 1, 1, 0]);
  const gray = head(1, 16); new Float32Array(gray, 16).set([0, 0.25, 1, 0.5]);
  assert.deepEqual(Array.from(decodeBurn(gray, 2, 2)), [0, 0.25, 1, 0.5]);
  assert.ok(decodeBurn(gray, 2, 2) instanceof Float32Array);
  assert.throws(() => decodeBurn(bin, 3, 2));
  assert.throws(() => decodeBurn(bin.slice(0, 18), 2, 2));
});

test("job for Rust: only numbers and names, nothing that JSON would change", () => {
  const adjust: Adjust = { black: 0.02, white: 1, gamma: 0.55, brightness: 0, contrast: 5, sharpen: 35, denoise: 0, invert: false, local: 35, curve: [[0, 0], [0.4, 0.6], [1, 1]] };
  const raster: RasterSettings = { method: "jarvis", threshold: 0.5, cell: 6, angle: 0 };
  assert.deepEqual(JSON.parse(rasterJob(10, 8, 20, 16, adjust, raster)!), { sw: 10, sh: 8, gw: 20, gh: 16, adjust, raster });
  assert.equal(rasterJob(10, 8, 20, 16, { ...adjust, gamma: NaN }, raster), null);
  assert.equal(rasterJob(10, 8, 20, 16, adjust, { ...raster, method: "jarvis ä" as never }), null);
  assert.equal(rasterJob(10, 8, 20, 16, { ...adjust, curve: [[0, 0], [Infinity, 1]] }, raster), null);
  assert.equal(rasterJob(10.5, 8, 20, 16, adjust, raster), null);
});

// Big comparison with your own picture (not in the repository): a folder with <name>.bmp (24 bit, uncompressed) and
// <name>.json = { gw, gh, adjust, raster }, then
//   IMGRASTER_COMPARE=/path/to/folder node --test tests/imgRasterRust.test.ts
//   cd src-tauri && IMGRASTER_COMPARE=/path/to/folder cargo test --release imgraster -- --ignored --nocapture
test("write the TypeScript result for a local picture", { skip: !process.env.IMGRASTER_COMPARE }, () => {
  const folder = process.env.IMGRASTER_COMPARE!;
  for (const f of readdirSync(folder).filter(n => n.endsWith(".bmp"))) {
    const name = f.slice(0, -4), b = readFileSync(`${folder}/${f}`);
    const off = b.readUInt32LE(10), sw = b.readInt32LE(18), shRaw = b.readInt32LE(22), bpp = b.readUInt16LE(28), sh = Math.abs(shRaw);
    assert.ok(bpp === 24 || bpp === 32, "24 or 32 bit BMP");
    const rgba = new Uint8ClampedArray(sw * sh * 4), stride = Math.ceil((sw * bpp) / 32) * 4, bytes = bpp / 8;
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const p = off + (shRaw > 0 ? sh - 1 - y : y) * stride + x * bytes, q = (y * sw + x) * 4;
      rgba[q] = b[p + 2]; rgba[q + 1] = b[p + 1]; rgba[q + 2] = b[p]; rgba[q + 3] = 255;
    }
    const base = toGray(rgba, sw * sh);
    const set = JSON.parse(readFileSync(`${folder}/${name}.json`, "utf8"));
    const job: Job = { sw, sh, gw: set.gw, gh: set.gh, adjust: set.adjust, raster: set.raster };
    writeFileSync(`${folder}/${name}.gray`, Buffer.from(base.buffer));
    const t0 = performance.now();
    const small = resample(base, sw, sh, job.gw, job.gh);
    const t1 = performance.now();
    const g = applyAdjustCpu(small, job.gw, job.gh, job.adjust);
    const t2 = performance.now();
    const burn = rasterize(g, job.gw, job.gh, job.raster);
    const t3 = performance.now();
    let on = 0;
    for (let i = 0; i < burn.length; i++) if (burn[i] >= 0.5) on++;
    console.log(`${name}: ${sw} x ${sh} to ${job.gw} x ${job.gh} – resample ${(t1 - t0).toFixed(0)} ms, adjust ${(t2 - t1).toFixed(0)} ms, raster ${(t3 - t2).toFixed(0)} ms, total ${(t3 - t0).toFixed(0)} ms in TypeScript`);
    writeFileSync(`${folder}/${name}.expected.json`, JSON.stringify({ job, gray: `${name}.gray`, resampled: fnv(small), adjusted: fnv(g), burn: fnv(burn), on }));
  }
});
