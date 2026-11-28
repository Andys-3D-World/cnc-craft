// Offset of open lines: TypeScript (src/editor/offsetOpen.ts) and Rust (src-tauri/src/offsetopen.rs) must give the same
// lines (numbers to 1e-9) and the same side. Pinned in fixtures/offsetopen-cases.json.gz; `cargo test offsetopen` compares.
// After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test offsetopen
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { offsetOpenPath, sideOf, type P } from "../src/editor/offsetOpen.ts";

const file = new URL("./fixtures/offsetopen-cases.json.gz", import.meta.url);
let seed = 29;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const paths: { name: string; pts: P[] }[] = [
  { name: "straight", pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
  { name: "L", pts: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }] },
  { name: "zigzag", pts: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 20, y: 0 }, { x: 30, y: 20 }, { x: 40, y: 0 }] },
  { name: "very sharp turn", pts: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 0, y: 3 }] },
  { name: "U turn", pts: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 8 }, { x: 0, y: 8 }] },
  { name: "narrow bay", pts: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 43, y: 30 }, { x: 43, y: 0 }, { x: 90, y: 0 }] },
  { name: "duplicate points and a straight run", pts: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 0.0000000001 }, { x: 60, y: 10 }] },
  { name: "single point", pts: [{ x: 3, y: 3 }, { x: 3, y: 3 }] },
  { name: "circle-like", pts: Array.from({ length: 40 }, (_, i) => ({ x: 30 * Math.cos(i * 0.15), y: 30 * Math.sin(i * 0.15) })) },
  { name: "spiral", pts: Array.from({ length: 80 }, (_, i) => ({ x: (5 + i * 0.4) * Math.cos(i * 0.3), y: (5 + i * 0.4) * Math.sin(i * 0.3) })) },
];
for (let k = 0; k < 10; k++) paths.push({ name: `random ${k + 1}`, pts: Array.from({ length: 3 + Math.floor(rnd() * 12) }, () => ({ x: rnd() * 100, y: rnd() * 60 })) });

test("offset of open lines: pinned result for Rust (offsetopen-cases.json.gz)", () => {
  const cases = paths.flatMap(p => [8, 3, 0.5, -0.5, -3, -8, 0, 25].map(d => {
    const tol = d === 25 ? 0.2 : 0.02, at = { x: p.pts[0].x + 1, y: p.pts[0].y + 5 };
    return { name: `${p.name} / d ${d}`, pts: p.pts, d, tol, at, want: { lines: offsetOpenPath(p.pts, d, tol), side: sideOf(p.pts, at) } };
  }));
  assert.ok(cases.some(c => c.want.lines.length > 1) && cases.some(c => c.want.lines.length === 0));
  const text = JSON.stringify(cases) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
