// SVG paths: TypeScript (src/importers/svgPath.ts) and Rust (src-tauri/src/importsvg.rs) must turn the same path data
// ("d") and transform attributes into the same polylines and matrices. This test pins what the TypeScript gives in
// fixtures/importsvg-cases.json; `cargo test importsvg` compares the Rust result (numbers to 1e-9, the rest exactly).
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test importsvg
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { parsePathData, parseTransform } from "../src/importers/svgPath.ts";

const file = new URL("./fixtures/importsvg-cases.json", import.meta.url);
const D = [
  "M0 0 L10 0 L10 10 Z", "m0 0 l10 0 0 10 -10 0z", "M0,0H10V10H0Z", "m5 5 h10 v10 h-10 v-10", "M 1 2 3 4 5 6", "m1 2 3 4 5 6",
  "M0 0 C 10 0 10 10 0 10", "M0 0 c10 0 10 10 0 10 s -10 10 0 20", "M0 0 S 10 10 20 0", "M0 0 C1 2 3 4 5 6 S 7 8 9 10 C 1 1 1 1 1 1",
  "M0 0 Q 5 10 10 0 T 20 0 T 30 0", "m0 0 q5 10 10 0 t10 0", "M0 0 T 10 10", "M0 0 L 5 5 T 10 0", "M0 0 Q 5 5 10 0 S 15 5 20 0",
  "M0 0 A 10 10 0 0 1 20 0", "M0 0 A 10 10 0 1 0 20 0", "M0 0 a10 5 30 1 1 15 8", "M0 0 A 1 1 0 0 1 20 0", "M0 0 A 0 5 0 0 1 10 0",
  "M3 3 A 5 5 0 0 1 3 3", "M0 0 a10 10 0 0110 20", "M0 0 a10 10 0 1010 0", "M0 0 a10 10 0 1 1.5 10 0", "M0 0 A10 10 0 0,1 10,10 10 10 0 0 0 20 0",
  "M0 0 A -10 -10 45 0 1 20 0", "M0 0 A 10 10 0 2 1 20 0", "M10 0 A 10 10 0 1 1 9.999 0", "M0 0 A 100000 100000 0 0 1 1 0",
  "M0 0 L1e1 0 l-.5-.5 .5e1.5", "M0-5L3-5-3 5", "M.5.5L1.5 1.5", "M0 0 L +5 +5 L-5 -5", "M 0 0 L 5 5e L 6 6", "M1.2.3.4L5 5",
  "M0 0 L10 0 Z L 5 5", "M0 0 L10 0 Z 5 5", "M0 0 Z", "Z M0 0 L 1 1", "L 5 5 M 0 0 L 1 1", "10 20 M0 0 L1 1", "M0 0 M5 5 L6 6",
  "M0 0 L 10 0 L 10 10 Z m 2 2 l 3 0 l 0 3 z", "M0 0 l5 0 z m0 10 l5 0 z", "M L 1 2 3 4", "M0 0 L", "M0 0 C 1 2", "M0 0 Q 1",
  "M0 0 H", "M 0 0 A 5 5", "", "   ", "x y z", "M0 0 L10 0 L10 10\n\tL0 10z", "M 0 0 C 0 0 0 0 0 0", "M0 0 c 1000 0 1000 1000 0 1000",
  "M0 0 L1 1 L2 2 L3 3 L4 4 L5 5 L6 6 L7 7 L8 8 L9 9", "M0 0 Q 0 0 0 0", "M-1e-7 0 L1e-7 0",
];
const TOL = [0.01, 0.001, 0.5, 2, 1e-4];
const paths: [string, number][] = D.map((d, i) => [d, TOL[i % TOL.length]]);
paths.push(["M1.e2 0 L 3 3", 0.01], ["M0 0 A 5 0 0 0 1 10 0 L 20 0", 0.01], ["M0 0 A 15 15 0 2 1 20 0", 0.01], ["M10 10 L 20 20 m 5 5 l 1 1", 0.01],
  ["M C 1 2 3 4 5 6", 0.01], ["M0 0 L1 1 M5 5 L6 6", 0.01], ["M0 0 C 1 2 3 4 5 6 S 7 8 9 10 S 11 12 13 14", 0.01], ["M0 0 Q 1 5 2 0 T 4 0 Q 5 5 6 0 T 8 0", 0.01]);
paths.push(["M0 0 A 50 50 0 1 1 100 0 C 0 50 50 100 100 100", 0.0001], ["M0 0 C 0 1000 1000 1000 1000 0", 1e-6], ["M0 0 A 5 5 0 0 1 10 0", 0]);
const transforms = [
  "translate(10 20)", "translate(5)", "translate(,5)", "translate(5,)", "scale(2)", "scale(2 3)", "scale(-1,1)", "scale()",
  "rotate(45)", "rotate(30 10 10)", "rotate(90,5)", "rotate()", "skewX(30)", "skewY(-15)", "matrix(1 0 0 1 5 6)",
  "matrix(0.5,0.866,-0.866,0.5,1,2)", "matrix(1 2 3)", "translate(1,2) rotate(30) scale(2)", "TRANSLATE(3 4) Scale(2)",
  "translate (1 2)", "translateX(5) translate(1)", "rotate(45", "foo(1) scale(3)", "  matrix( 1 , 0 , 0 , -1 , 0 , 297 )  ",
  "scale(1e1 .5)", "rotate(x)", "translate(1px 2px)", "skewx(45)", "", "translate(1\n2)", "rotate(1e400)", "rotate(scale(2))",
];
// Broken path data where JavaScript adds a command letter to a number ("0" + "L" = "0L") are left out: Rust goes on with
// "no number" there, and in the drawing such a point is no number either way.
const textPoint = (subs: ReturnType<typeof parsePathData>) => subs.some(s => s.pts.some(p => typeof p.x !== "number" || typeof p.y !== "number"));
const keep = paths.filter(([d, tol]) => !textPoint(parsePathData(d, tol)));
const want = { paths: keep.map(([d, tol]) => parsePathData(d, tol)), transforms: transforms.map(parseTransform) };

test("SVG paths: pinned result for Rust (importsvg-cases.json)", () => {
  // every number must be finite (JSON would turn NaN into null)
  const finite = (v: unknown, at: string): void => {
    if (typeof v === "number") assert.ok(Number.isFinite(v), at);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) finite(x, `${at}.${k}`);
  };
  assert.equal(paths.length - keep.length, 1, "left out: only M1.2.3.4L5 5");
  want.paths.forEach((p, i) => finite(p, `path ${keep[i][0]}`));
  const text = JSON.stringify({ job: { paths: keep, transforms: transforms.filter((_, i) => want.transforms[i].every(Number.isFinite)) }, want: { paths: want.paths, transforms: want.transforms.filter(m => m.every(Number.isFinite)) } }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, text);
  assert.equal(readFileSync(file, "utf8"), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
