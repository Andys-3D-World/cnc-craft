// Image tracing: TypeScript (src/importers/traceCalc.ts with traceUtil.ts and centerline.ts) and Rust
// (src-tauri/src/imagetrace.rs) must find the same automatic threshold and the same outlines and centre lines.
// This test draws grey images, pins what the TypeScript gives in fixtures/imagetrace-cases.json.gz;
// `cargo test imagetrace` compares the Rust result (numbers to 1e-9, the rest exactly).
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test imagetrace
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { otsu, traceAll, type TraceOpts } from "../src/importers/traceCalc.ts";

const file = new URL("./fixtures/imagetrace-cases.json.gz", import.meta.url);
type Img = { w: number; h: number; g: Float32Array };
const images: Img[] = [];
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
/** picture from a function giving the darkness 0..1 at a pixel centre (1 = black) */
const draw = (w: number, h: number, dark: (x: number, y: number) => number) => {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = 255 * (1 - Math.max(0, Math.min(1, dark(x + 0.5, y + 0.5))));
  images.push({ w, h, g });
  return images.length - 1;
};
const soft = (d: number) => Math.max(0, Math.min(1, 0.5 - d)); // edge one pixel wide
const disc = (cx: number, cy: number, r: number) => (x: number, y: number) => soft(Math.hypot(x - cx, y - cy) - r);
const segDist = (x: number, y: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
};
const strokes = (segs: number[][], width: number) => (x: number, y: number) => Math.max(0, ...segs.map(s => soft(segDist(x, y, s[0], s[1], s[2], s[3]) - width / 2)));

const SQUARE = draw(40, 30, (x, y) => (x > 10 && x < 28 && y > 6 && y < 22 ? 1 : 0));
const DISCS = draw(60, 60, (x, y) => Math.max(disc(18, 20, 10)(x, y), disc(42, 40, 13)(x, y)));
const RING = draw(50, 50, (x, y) => Math.max(0, disc(25, 25, 18)(x, y) - disc(25, 25, 9)(x, y)));
const SPECKLE = draw(50, 50, () => (rnd() < 0.08 ? 0.6 + 0.4 * rnd() : 0.1 * rnd()));
const GRADIENT = draw(64, 16, (x, y) => x / 64 + (y % 3) * 0.01);
const CHECKER = draw(20, 20, (x, y) => ((Math.floor(x / 2) + Math.floor(y / 2)) % 2 ? 1 : 0));
const WRITING = draw(80, 60, strokes([[8, 10, 30, 50], [30, 50, 45, 12], [45, 12, 70, 48], [12, 30, 68, 30], [60, 8, 60, 55]], 3.2));
const LETTERS = draw(90, 40, (x, y) => Math.max(strokes([[5, 5, 25, 35], [25, 5, 5, 35], [35, 5, 55, 5], [45, 5, 45, 35]], 2.5)(x, y), Math.max(0, disc(75, 20, 12)(x, y) - disc(75, 20, 9)(x, y))));
const WIDE = draw(1200, 40, strokes([[10, 20, 1190, 20], [300, 5, 300, 35], [900, 5, 950, 35], [600, 20, 640, 5]], 4));
const TIE = draw(12, 8, (x, y) => ((x * 7 + y * 3) % 5) / 4); // values exactly on common thresholds
const COLOUR = (() => { const w = 30, h = 20, g = new Float32Array(w * h); for (let i = 0; i < w * h; i++) { const r = (i * 37) % 256, gg = (i * 91) % 256, b = (i * 53) % 256; g[i] = 0.299 * r + 0.587 * gg + 0.114 * b; } images.push({ w, h, g }); return images.length - 1; })();
const TINY = draw(1, 1, () => 1);
const LINE1 = draw(5, 1, x => (x > 2 ? 1 : 0));
const WHITE = draw(10, 10, () => 0);
const BLACK = draw(10, 10, () => 1);
const BLOBS = draw(70, 50, (x, y) => Math.max(disc(10, 10, 1.5)(x, y), disc(30, 25, 4)(x, y), disc(55, 35, 9)(x, y), strokes([[5, 45, 65, 45]], 1.2)(x, y)));

// grey values exactly on the thresholds used below (64, 128, 192)
const EXACT = (() => { const w = 24, h = 16, g = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = [255, 192, 128, 64, 0][(Math.floor(x / 3) + Math.floor(y / 4)) % 5]; images.push({ w, h, g }); return images.length - 1; })();
/** random scribbles: many bends, crossings and dead ends for the centre-line walk */
const scribble = (w: number, h: number, n: number, width: number) => {
  const segs: number[][] = [];
  let px = rnd() * w, py = rnd() * h;
  for (let i = 0; i < n; i++) { const nx = 4 + rnd() * (w - 8), ny = 4 + rnd() * (h - 8); segs.push([px, py, nx, ny]); px = nx; py = ny; }
  return draw(w, h, strokes(segs, width));
};
const SCRIBBLES = [scribble(80, 80, 9, 2.2), scribble(80, 80, 12, 3.5), scribble(90, 70, 7, 5.5), scribble(60, 60, 15, 1.6)];

const O = (o: Partial<TraceOpts> = {}): TraceOpts => ({ threshold: 128, invert: false, blur: 1, smooth: 1, minArea: 20, widthMm: 100, center: false, ...o });
const cases: { name: string; image: number; opts: TraceOpts }[] = [];
const add = (name: string, image: number, o: Partial<TraceOpts> = {}) => cases.push({ name, image, opts: O(o) });
add("square, defaults", SQUARE);
add("square, no blur, no area limit", SQUARE, { blur: 0, minArea: 0 });
add("square, inverted", SQUARE, { invert: true });
add("discs, blur 0..4", DISCS, { blur: 0 }); add("discs blur 2", DISCS, { blur: 2 }); add("discs blur 4", DISCS, { blur: 4, smooth: 0.2 });
add("discs, much smoothing", DISCS, { smooth: 4 });
add("discs, centre lines", DISCS, { center: true });
add("ring, hole kept", RING, { blur: 0, smooth: 0.5 });
add("ring, low threshold", RING, { threshold: 40 }); add("ring, high threshold", RING, { threshold: 220 });
add("speckle, small spots", SPECKLE, { blur: 0, minArea: 0 }); add("speckle, spots ignored", SPECKLE, { blur: 0, minArea: 5 });
add("speckle, blurred", SPECKLE, { blur: 1, threshold: 230, minArea: 1 }); add("speckle, inverted", SPECKLE, { invert: true, threshold: 30, blur: 0, minArea: 0 });
add("gradient", GRADIENT, { blur: 0, minArea: 0 }); add("gradient, threshold 64", GRADIENT, { threshold: 64, blur: 3 });
add("checker saddles", CHECKER, { blur: 0, minArea: 0 }); add("checker saddles inverted", CHECKER, { blur: 0, minArea: 0, invert: true }); add("checker blurred", CHECKER, { blur: 1, minArea: 0 });
add("writing, outline", WRITING); add("writing, centre lines", WRITING, { center: true }); add("writing, centre, no blur", WRITING, { center: true, blur: 0, smooth: 0.2, minArea: 0 });
add("writing, centre, long stubs only", WRITING, { center: true, minArea: 500, smooth: 4 }); add("writing, centre, inverted", WRITING, { center: true, invert: true, threshold: 250 });
add("letters, outline", LETTERS, { blur: 0 }); add("letters, centre lines", LETTERS, { center: true, blur: 0 }); add("letters, centre, blurred", LETTERS, { center: true, blur: 2 });
add("wide image, centre lines scaled", WIDE, { center: true }); add("wide image, outline", WIDE, { blur: 0, smooth: 2 });
add("ties on the threshold", TIE, { threshold: 128, blur: 0, minArea: 0 }); add("ties, 64", TIE, { threshold: 64, blur: 0, minArea: 0 }); add("ties, centre", TIE, { threshold: 128, blur: 0, center: true, minArea: 0 });
add("colour photo grey", COLOUR, { blur: 0, minArea: 0, threshold: 120 }); add("colour photo, blurred", COLOUR, { blur: 2, minArea: 3, threshold: 120 });
add("colour photo, centre", COLOUR, { center: true, blur: 0, threshold: 140, minArea: 0 });
add("one pixel", TINY, { blur: 0, minArea: 0 }); add("one pixel, centre", TINY, { center: true, blur: 1 });
add("one row", LINE1, { blur: 0, minArea: 0 }); add("one row, blurred, centre", LINE1, { blur: 3, center: true, minArea: 0 });
add("white", WHITE); add("black", BLACK, { minArea: 0 }); add("black, centre", BLACK, { center: true, minArea: 0 });
add("blobs, area limit 20", BLOBS); add("blobs, area limit 200", BLOBS, { minArea: 200 }); add("blobs, centre", BLOBS, { center: true, minArea: 0 });
for (const t of [64, 128, 192]) for (const invert of [false, true]) {
  add(`exact grey ${t}${invert ? " inverted" : ""}`, EXACT, { threshold: t, invert, blur: 0, minArea: 0 });
  add(`exact grey ${t}${invert ? " inverted" : ""}, centre`, EXACT, { threshold: t, invert, blur: 0, minArea: 0, center: true });
}
SCRIBBLES.forEach((im, k) => {
  add(`scribble ${k}, centre`, im, { center: true, blur: 0, smooth: 0.2, minArea: 0 });
  add(`scribble ${k}, centre blurred`, im, { center: true, blur: 1, minArea: 9 });
  add(`scribble ${k}, outline`, im, { blur: 0, smooth: 0.4, minArea: 0 });
});

test("image tracing: pinned result for Rust (imagetrace-cases.json.gz)", () => {
  const built = cases.map(c => {
    const im = images[c.image];
    const { widthMm: _w, ...opts } = c.opts;
    return { name: c.name, image: c.image, opts: { w: im.w, h: im.h, ...opts }, want: { otsu: otsu(im.g), paths: traceAll(im.g, im.w, im.h, c.opts) } };
  });
  for (const c of built) for (const p of c.want.paths) for (const q of p.pts) assert.ok(Number.isFinite(q.x) && Number.isFinite(q.y), c.name);
  const text = JSON.stringify({ images: images.map(i => Array.from(i.g)), cases: built }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
