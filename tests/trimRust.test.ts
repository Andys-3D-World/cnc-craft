// Trim: TypeScript (src/editor/trim.ts) and Rust (src-tauri/src/trim.rs) must find the same cut stations, the same piece
// around a click and the same remaining pieces. Pinned in fixtures/trim-cases.json.gz; `cargo test trim` compares.
// After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test trim
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { intersections, nearestStation, normalizePath, pathLength, remainingSpans, slicePath, trimSpan } from "../src/editor/trim.ts";
import type { Path, Pt } from "../src/shapeTransform.ts";

const file = new URL("./fixtures/trim-cases.json.gz", import.meta.url);
let seed = 31;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const line = (a: Pt, b: Pt): Path => ({ pts: [a, b], closed: false });
const rect = (x: number, y: number, w: number, h: number): Path => ({ pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], closed: true });
const ring = (cx: number, cy: number, r: number, n = 64): Path => ({ pts: Array.from({ length: n }, (_, k) => ({ x: cx + r * Math.cos((k / n) * 2 * Math.PI), y: cy + r * Math.sin((k / n) * 2 * Math.PI) })), closed: true });
const scenes: { name: string; target: Path; cutters: Path[]; clicks: Pt[] }[] = [
  { name: "line across a rectangle", target: line({ x: -10, y: 20 }, { x: 110, y: 20 }), cutters: [rect(0, 0, 100, 50)], clicks: [{ x: -5, y: 20 }, { x: 50, y: 21 }, { x: 105, y: 19 }] },
  { name: "rectangle cut by two lines", target: rect(0, 0, 100, 50), cutters: [line({ x: 30, y: -10 }, { x: 30, y: 60 }), line({ x: 70, y: -10 }, { x: 70, y: 60 })], clicks: [{ x: 50, y: 0 }, { x: 0, y: 25 }, { x: 50, y: 50 }, { x: 100, y: 25 }] },
  { name: "circle and a line, one crossing", target: ring(50, 50, 30), cutters: [line({ x: 50, y: 50 }, { x: 120, y: 50 })], clicks: [{ x: 50, y: 20 }] },
  { name: "circle and a line, two crossings", target: ring(50, 50, 30), cutters: [line({ x: 0, y: 50 }, { x: 120, y: 50 })], clicks: [{ x: 50, y: 20 }, { x: 50, y: 80 }, { x: 80, y: 51 }] },
  { name: "lines touching only at the ends (DXF)", target: line({ x: 0, y: 0 }, { x: 50, y: 0 }), cutters: [line({ x: 50, y: 0 }, { x: 50, y: 40 }), line({ x: 0, y: 0 }, { x: 0, y: 40 })], clicks: [{ x: 25, y: 0 }] },
  { name: "self crossing figure eight", target: { pts: [{ x: 0, y: 0 }, { x: 40, y: 40 }, { x: 80, y: 0 }, { x: 80, y: 40 }, { x: 40, y: 0 }, { x: 0, y: 40 }], closed: true }, cutters: [], clicks: [{ x: 0, y: 20 }, { x: 60, y: 20 }, { x: 40, y: 39 }] },
  { name: "open line closing on itself", target: normalizePath({ pts: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 30 }, { x: 0, y: 30 }, { x: 0.01, y: 0 }], closed: false }), cutters: [line({ x: 25, y: -5 }, { x: 25, y: 35 })], clicks: [{ x: 10, y: 0 }, { x: 0, y: 15 }] },
  { name: "nearly parallel and touching lines", target: line({ x: 0, y: 0 }, { x: 100, y: 0 }), cutters: [line({ x: 10, y: 0.005 }, { x: 90, y: 0.0051 }), line({ x: 50, y: 0.019 }, { x: 50, y: 20 })], clicks: [{ x: 30, y: 0 }, { x: 70, y: 0 }] },
  { name: "long contour in many chunks", target: { pts: Array.from({ length: 200 }, (_, k) => ({ x: k * 2, y: 20 * Math.sin(k / 8) })), closed: false }, cutters: [line({ x: -10, y: 5 }, { x: 410, y: 5 }), ring(200, 0, 15)], clicks: [{ x: 100, y: 0 }, { x: 205, y: 2 }] },
];
for (let k = 0; k < 8; k++) {
  const n = 4 + Math.floor(rnd() * 10);
  const target: Path = { pts: Array.from({ length: n }, () => ({ x: rnd() * 100, y: rnd() * 100 })), closed: rnd() > 0.5 };
  const cutters: Path[] = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => line({ x: rnd() * 100, y: rnd() * 100 }, { x: rnd() * 100, y: rnd() * 100 }));
  scenes.push({ name: `random ${k + 1}`, target, cutters, clicks: Array.from({ length: 3 }, () => ({ x: rnd() * 100, y: rnd() * 100 })) });
}

test("trim: pinned result for Rust (trim-cases.json.gz)", () => {
  const cases = scenes.flatMap(sc => sc.clicks.map((at, ci) => {
    const p = sc.target, cuts = intersections(p, sc.cutters), len = pathLength(p), s = nearestStation(p, at).s, span = trimSpan(len, p.closed, cuts, s);
    const rem = span ? remainingSpans(len, p.closed, span) : null;
    return { name: `${sc.name} / click ${ci + 1}`, path: p, cutters: sc.cutters, at, want: { cuts, s, span, removed: span ? slicePath(p, span) : null, remaining: rem, pieces: rem ? rem.map(sp => slicePath(p, sp)) : null } };
  }));
  const norm = [{ pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.01, y: 0.01 }], closed: false }, { pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }], closed: false }, { pts: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 1, y: 0 }], closed: false }]
    .map(p => ({ p, want: normalizePath(p) }));
  assert.ok(cases.some(c => c.want.span === null) && cases.some(c => (c.want.pieces?.length ?? 0) === 2));
  const text = JSON.stringify({ cases, norm }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
