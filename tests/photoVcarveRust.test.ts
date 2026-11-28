// Photo with the V-bit: TypeScript (src/photoVcarve.ts + the bilinear sampler of src/ui/photoVcarveDialog.ts) and Rust
// (src-tauri/src/photovcarve.rs) must make the same plan and the same G-code lines, character for character.
// Grids are Float32 like in the dialog. Pinned in fixtures/photovcarve-cases.json.gz (grid as base64 f32);
// `cargo test photovcarve` compares. After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cargo test photovcarve
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { photoLines, photoPlan, widthAtDepth, type PhotoOpts } from "../src/photoVcarve.ts";

const file = new URL("./fixtures/photovcarve-cases.json.gz", import.meta.url);
let seed = 37;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const grids: { name: string; nx: number; ny: number; f: (i: number, j: number, nx: number, ny: number) => number }[] = [
  { name: "gradient", nx: 60, ny: 40, f: (i, _j, nx) => i / (nx - 1) },
  { name: "dark disc", nx: 50, ny: 50, f: (i, j) => (Math.hypot(i - 25, j - 25) < 15 ? 0.9 : 0.05) },
  { name: "stripes and noise", nx: 80, ny: 30, f: (i, j) => ((Math.floor(i / 6) + Math.floor(j / 5)) % 2 ? 0.8 : 0.2) * (0.8 + 0.4 * rnd()) },
  { name: "all white", nx: 10, ny: 10, f: () => 0 },
  { name: "all black", nx: 12, ny: 8, f: () => 1 },
  { name: "tiny", nx: 2, ny: 2, f: (i, j) => (i + j) / 2 },
];
const tools = [{ angle: 60, tipDia: 0.2, toolDia: 6 }, { angle: 90, tipDia: 0, toolDia: 3.175 }, { angle: 30, tipDia: 0.5, toolDia: 8 }];

/** FNV-1a, 32 bit */
const fnv = (t: string) => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193) >>> 0; return h; };

test("photo V-carve: pinned result for Rust (photovcarve-cases.json.gz)", () => {
  const cases = [];
  const made = grids.map(gr => {
    const g = new Float32Array(gr.nx * gr.ny);
    for (let j = 0; j < gr.ny; j++) for (let i = 0; i < gr.nx; i++) g[j * gr.nx + i] = Math.max(0, Math.min(1, gr.f(i, j, gr.nx, gr.ny)));
    return g;
  });
  const runs: { gi: number; k: number; tool?: Partial<PhotoOpts> }[] = [];
  for (let gi = 0; gi < grids.length; gi++) for (let k = 0; k < 4; k++) runs.push({ gi, k });
  // V-bit angles outside 10°–170° are taken as 10° or 170°
  for (const angle of [5, 175, 0, 180]) runs.push({ gi: 0, k: 2, tool: { angle } });
  for (const { gi, k, tool } of runs) {
    const gr = grids[gi], g = made[gi], lines = [0, 45, 90, 30][k];
    {
      const tl = tools[k % tools.length];
      const opts: PhotoOpts = { x0: 10 + k, y0: 5, w: 40 + k * 7, h: 25 + k * 3, spacing: [1, 0.6, 1.5, 0.8][k], ...tl, ...tool, maxDepth: [2, 0.3, 5, 1][k], stepDown: [0.5, 0.1, 2, 0.05][k], lines };
      const { nx, ny } = gr, o = opts;
      // the sampler of photoVcarveDialog.ts
      const at = (u: number, v: number) => {
        const fx = Math.max(0, Math.min(nx - 1, u / o.w * (nx - 1))), fy = Math.max(0, Math.min(ny - 1, (1 - v / o.h) * (ny - 1)));
        const i = Math.min(nx - 2, Math.floor(fx)), j = Math.min(ny - 2, Math.floor(fy)), a = fx - i, b = fy - j;
        return (g[j * nx + i] * (1 - a) + g[j * nx + i + 1] * a) * (1 - b) + (g[(j + 1) * nx + i] * (1 - a) + g[(j + 1) * nx + i + 1] * a) * b;
      };
      const plan = photoPlan(at, opts);
      const feed = [800, 1234.5, 600, 1000][k], plunge = [300, 250, 120.25, 400][k];
      const r = photoLines(plan, opts, feed, plunge, 5);
      // long results as count and hash (points rounded to 6 decimals; G-code lines exactly)
      const pts = plan.segs.flat().flatMap(q => [q.x, q.y, q.d]);
      const segs = { n: plan.segs.length, pts: pts.length, h: fnv(pts.map(v => v.toFixed(6)).join(",")) };
      const gl = r.lines.length > 300 ? { n: r.lines.length, h: fnv(r.lines.join("\n")) } : r.lines;
      cases.push({ name: `${gr.name} / ${lines}°${tool ? ` / V-bit ${tool.angle}°` : ""}`, head: { opts, nx, ny, feed, plunge, safeZ: 5 }, grid: Buffer.from(g.buffer).toString("base64"),
        want: { plan: { ...plan, segs }, lines: gl, cut: r.cut, air: r.air, width: widthAtDepth(plan.deepest, opts) } });
    }
  }
  assert.ok(cases.some(c => !Array.isArray(c.want.lines)) && cases.some(c => c.want.plan.segs.n === 0));
  const text = JSON.stringify(cases) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
