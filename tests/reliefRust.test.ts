// Relief: TypeScript (src/relief/*.ts) and Rust (src-tauri/src/relief.rs) must build the same height field from a picture
// or from closed contours – bit for bit in Float32 – and the same triangle surface. Pinned in fixtures/relief-cases.json.gz
// (as sizes, flags and hashes over the f32 bits, like the comparison in the app); `cargo test relief` compares.
// After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test relief
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildRelief, type ReliefJob } from "../src/relief/reliefBuild.ts";
import { reliefSummary, f32Hash } from "../src/relief/reliefRust.ts";
import { detailLoss, gridFor } from "../src/relief/heightField.ts";
import { DEFAULT_IMAGE_RELIEF } from "../src/relief/imageRelief.ts";
import type { VPt } from "../src/relief/vectorRelief.ts";

const file = new URL("./fixtures/relief-cases.json.gz", import.meta.url);
let seed = 43;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const img = (sw: number, sh: number, f: (x: number, y: number) => number) => { const g = new Float32Array(sw * sh); for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) g[y * sw + x] = f(x, y); return g; };
const ring = (cx: number, cy: number, r: number, n = 40): VPt[] => Array.from({ length: n }, (_, k) => ({ x: cx + r * Math.cos((k / n) * 2 * Math.PI), y: cy + r * Math.sin((k / n) * 2 * Math.PI) }));
const rect = (x: number, y: number, w: number, h: number): VPt[] => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const jobs: { name: string; job: ReliefJob }[] = [];
const I = { ...DEFAULT_IMAGE_RELIEF, w: 40, h: 30, nx: 41, ny: 31 };
const pics: [string, number, number, Float32Array][] = [
  ["gradient", 32, 24, img(32, 24, x => x / 31)],
  ["disc", 50, 50, img(50, 50, (x, y) => (Math.hypot(x - 25, y - 25) < 15 ? 0.9 : 0.1))],
  ["noise", 20, 16, img(20, 16, () => rnd())],
  ["flat grey", 10, 10, img(10, 10, () => 0.5)],
  ["big picture, small grid", 120, 80, img(120, 80, (x, y) => 0.5 + 0.5 * Math.sin(x / 9) * Math.cos(y / 7))],
];
const picOf = new Map<Float32Array, string>(pics.map(([name, , , g]) => [g, name]));
for (const [name, sw, sh, gray] of pics) for (const [k, v] of [{}, { invert: true, smooth: 1.2, contrast: 2.5, gamma: 0.6 }, { border: 3, fade: 4 }, { border: 2, fade: 0, fadeTo: "bottom" as const, depth: 0 }, { nx: 121, ny: 7, smooth: 0, gamma: 3, contrast: 0.4 }].entries())
  jobs.push({ name: `image ${name} / ${k}`, job: { kind: "image", gray, sw, sh, opts: { ...I, ...v } } });
const V = { height: 3, profile: "round" as const, width: 2, pad: 4, smooth: 0, long: 120 };
const shapes: [string, VPt[][]][] = [
  ["ring with a hole", [ring(20, 20, 15), ring(20, 20, 6)]],
  ["two rectangles", [rect(0, 0, 30, 10), rect(40, -5, 10, 30)]],
  ["star", [Array.from({ length: 10 }, (_, k) => { const r = k % 2 ? 6 : 15, a = (k / 10) * 2 * Math.PI; return { x: r * Math.cos(a), y: r * Math.sin(a) }; })]],
  ["thin line and a dot", [[{ x: 0, y: 0 }, { x: 50, y: 0.2 }, { x: 50, y: 1 }], [{ x: 3, y: 3 }, { x: 3.1, y: 3 }]]],
  ["nothing usable", [[{ x: 0, y: 0 }, { x: 5, y: 5 }]]],
];
for (const [name, loops] of shapes) for (const [k, v] of [{}, { profile: "slope" as const, smooth: 0.8 }, { profile: "dome" as const, width: 0 }, { profile: "dome" as const, width: 5, pad: 0, long: 40 }, { height: 0, long: 2 }].entries())
  jobs.push({ name: `vector ${name} / ${k}`, job: { kind: "vector", loops, opts: { ...V, ...v } } });

test("relief: pinned result for Rust (relief-cases.json.gz)", () => {
  const cases = jobs.map(({ name, job }) => {
    const r = buildRelief(job);
    const head = job.kind === "image" ? { kind: "image", sw: job.sw, sh: job.sh, image: job.opts } : { kind: "vector", loops: job.loops, vector: job.opts };
    const pic = job.kind === "image" ? picOf.get(job.gray)! : "";
    const loss = r && !r.flat ? [detailLoss(r.field, r.field.w, r.field.h, 5, 1), detailLoss(r.field, 2 * r.field.w, r.field.h, 2, 3)] : null;
    return { name, head, pic, want: r ? reliefSummary(r) : null, loss };
  });
  const grids = [[100, 50, 200], [1e5, 2, 1e6], [0.01, 0.01, 10], [3000, 2000, 2000]].map(([w, h, l]) => ({ w, h, l, want: gridFor(w, h, l) }));
  assert.ok(cases.some(c => c.want?.flat) && cases.some(c => c.want && !c.want.flat) && cases.some(c => c.want === null));
  assert.equal(f32Hash(new Float32Array([1])), f32Hash(new Float32Array([1])));
  const pictures = Object.fromEntries(pics.map(([name, , , g]) => [name, Buffer.from(g.buffer, g.byteOffset, g.byteLength).toString("base64")]));
  const text = JSON.stringify({ pictures, cases, grids }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
