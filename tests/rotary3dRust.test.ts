// Rotary axis with a 3D model: TypeScript (src/rotary3d.ts) and Rust (src-tauri/src/rotary3d.rs) must put the model on
// the axis the same way (meshForRotary), turn it for each side (rotateX), make the same roughing and finishing paths from
// a height field and chain them (roughRotary, finishRotary, thin3, chainRotary), and the same preview (fieldPreview) –
// Float32 bit for bit. Models and fields as base64 f32 in fixtures/rotary3d-cases.json.gz, results as counts and FNV hashes
// over the f32 bits (src/rotary3dRust.ts). After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cargo test rotary3d
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { chainRotary, fieldPreview, finishRotary, meshForRotary, roughRotary, rotateX, thin3, type RField } from "../src/rotary3d.ts";
import { meshSummary, pathSummary, previewSummary } from "../src/rotary3dRust.ts";
import { f32Hash } from "../src/relief/reliefRust.ts";

const file = new URL("./fixtures/rotary3d-cases.json.gz", import.meta.url);
let seed = 1234;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const R = (a: number, b: number) => a + rnd() * (b - a);
const b64 = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");

// models: a turned vase (surface of revolution, tilted onto each axis), random triangles, a flat plate, one triangle
function vase(seg: number, rings: number, axis: 0 | 1 | 2): Float32Array {
  const out: number[] = [];
  const P = (k: number, a: number) => { const t = k / rings, r = 8 + 5 * Math.sin(t * 5) + 2 * t, x = t * 60 - 10; const v = [x, r * Math.cos(a), r * Math.sin(a)]; return axis === 0 ? v : axis === 1 ? [v[2], v[0], v[1]] : [v[1], v[2], v[0]]; };
  for (let k = 0; k < rings; k++) for (let s = 0; s < seg; s++) {
    const a0 = (s / seg) * 2 * Math.PI, a1 = ((s + 1) / seg) * 2 * Math.PI;
    out.push(...P(k, a0), ...P(k + 1, a0), ...P(k + 1, a1), ...P(k, a0), ...P(k + 1, a1), ...P(k, a1));
  }
  return new Float32Array(out);
}
const models: { name: string; pos: Float32Array }[] = [
  { name: "vase x", pos: vase(16, 10, 0) }, { name: "vase y", pos: vase(12, 8, 1) }, { name: "vase z", pos: vase(10, 6, 2) },
  { name: "random", pos: new Float32Array(Array.from({ length: 9 * 60 }, () => R(-30, 40))) },
  { name: "plate", pos: new Float32Array([0, 0, 0, 50, 0, 0, 50, 20, 0, 0, 0, 0, 50, 20, 0, 0, 20, 0]) },
  { name: "one", pos: new Float32Array([1.5, -2.25, 3.125, 4, 5, -6, 7.75, 8, 9.5]) },
  { name: "empty", pos: new Float32Array(0) },
  { name: "ragged", pos: new Float32Array([1, 2, 3, 4, 5, 6, 7]) },
];

// height fields: tip radius per angle row and x column (air above R, model below, a core)
function makeField(name: string, nx: number, nt: number, Rs: number, f: (i: number, j: number) => number): { name: string; R: number; f: RField } {
  const h = new Float32Array(nx * nt);
  for (let j = 0; j < nt; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = f(i, j);
  return { name, R: Rs, f: { x0: name === "shifted" ? 3.5 : 0, dx: name === "coarse" ? 1.25 : 0.5, nx, nt, h } };
}
const fields = [
  makeField("bump", 40, 36, 15, (i, j) => 15 - 6 * Math.exp(-((i - 20) ** 2) / 60) * (0.6 + 0.4 * Math.cos((j / 36) * 2 * Math.PI))),
  makeField("groove", 30, 48, 12, (i, j) => (i > 8 && i < 20 && (j < 10 || j > 40) ? 7 : 12.5)),
  makeField("noise", 25, 40, 10, () => R(4, 11)),
  makeField("air", 20, 36, 10, () => 10.5),
  makeField("deep", 20, 36, 10, (i) => (i % 5 === 0 ? 1 : 9.95)),
  makeField("shifted", 16, 37, 8, (i, j) => 8 - (((i + j) % 7) / 2)),
  makeField("coarse", 9, 36, 20, (i, j) => 20 - ((i * 3 + j) % 11)),
];

test("rotary 3D: pinned result for Rust (rotary3d-cases.json.gz)", () => {
  const meshes = models.flatMap(m => ([0, 1, 2, 5] as const).flatMap(axis => [60, 0.1, 333.3].map(length => {
    const r = meshForRotary(m.pos, axis as 0 | 1 | 2, length);
    return { name: m.name, axis, length, pos: b64(m.pos), want: meshSummary(r) };
  })));
  const degs = [0, 90, 120, 240, 45, -30, 360, 1e-3, 72.5, 180];
  const rotates = models.map(m => {
    const base = meshForRotary(m.pos, 0, 60).tris;
    return { name: m.name, degs, pos: b64(base), want: degs.map(d => f32Hash(rotateX(base, d))) };
  });

  const wraps: unknown[] = [], previews: unknown[] = [];
  const rough = [{ stepDown: 1, core: 0, tol: 0.01 }, { stepDown: 2.5, core: 3, tol: 0.01 }, { stepDown: 0.02, core: 9, tol: 0.05 }, { stepDown: 4, core: 0, tol: 0 }];
  const finish = [{ dir: "x", stepOver: 0.5, tol: 0.01, levelStep: 0 }, { dir: "around", stepOver: 0.5, tol: 0.01, levelStep: 0 },
    { dir: "around", stepOver: 1.7, tol: 0.02, levelStep: 2 }, { dir: "x", stepOver: 0.3, tol: 0.005, levelStep: 1.5 }, { dir: "around", stepOver: 0.001, tol: 0.1, levelStep: -1 }];
  for (const fd of fields) {
    const head = (f: RField) => ({ x0: f.x0, dx: f.dx, nx: f.nx, nt: f.nt });
    for (let k = 0; k < 5; k++) {
      const ro = k < 4 ? rough[k] : null, fi = k > 0 ? finish[k % finish.length] : null;
      const out = [];
      if (ro) out.push(...roughRotary(fd.f, fd.R, ro.stepDown, ro.core, ro.tol));
      if (fi) out.push(...finishRotary(fd.f, fd.R, fi.dir as "x" | "around", fi.stepOver, fi.tol, fi.levelStep));
      chainRotary(out, fd.R);
      wraps.push({ name: fd.name, head: { kind: "wrap", r: fd.R, ...(ro ? { rough: { ...head(fd.f), ...ro } } : {}), ...(fi ? { finish: { ...head(fd.f), ...fi } } : {}) },
        h: b64(fd.f.h), twice: !!(ro && fi), want: pathSummary(out) });
    }
    for (const Rp of [fd.R, 3, 50]) previews.push({ name: fd.name, head: { kind: "preview", r: Rp, x0: fd.f.x0, dx: fd.f.dx, nx: fd.f.nx, nt: fd.f.nt }, h: b64(fd.f.h), want: previewSummary(fieldPreview(fd.f, Rp)) });
  }

  const thins: { pts: number[][]; tol: number; out: number[][] }[] = [];
  for (let k = 0; k < 40; k++) {
    const n = Math.floor(rnd() * 30), pts: number[][] = [];
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < n; i++) { x += R(0, 2); y += rnd() < 0.5 ? 0 : R(-0.02, 0.02); z += rnd() < 0.3 ? R(-1, 1) : 0; pts.push([x, y, z]); }
    if (k % 7 === 0 && n) pts.push([...pts[n - 1]]);
    const tol = [0.01, 0.001, 0.5, 0][k % 4];
    thins.push({ pts, tol, out: thin3(pts, tol) });
  }
  const long = Array.from({ length: 1000 }, (_, i) => [i * 0.1, 0, 0]);
  thins.push({ pts: long, tol: 0.01, out: thin3(long, 0.01) });   // more than 400 in a row: a point is kept anyway

  assert.ok(wraps.length >= 30 && (wraps as any[]).some(w => w.want.length > 5) && (wraps as any[]).some(w => w.want.length === 0));
  const text = JSON.stringify({ meshes, rotates, wraps, previews, thins }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
