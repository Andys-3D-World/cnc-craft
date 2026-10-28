// Tests für die Mittellinie (Centerline) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { centerlines } from "../src/centerline.ts";

/** Maske zeichnen: Rechtecke füllen */
function mask(W: number, H: number, rects: [number, number, number, number][]): Uint8Array {
  const m = new Uint8Array(W * H);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 1;
  return m;
}
const len = (p: { x: number; y: number }[]) => p.reduce((s, q, i) => (i ? s + Math.hypot(q.x - p[i - 1].x, q.y - p[i - 1].y) : 0), 0);

test("dicker waagerechter Strich wird EINE Linie in der Mitte", () => {
  const W = 80, H = 30;
  const r = centerlines(mask(W, H, [[10, 10, 70, 18]]), W, H, 5, 1);
  assert.equal(r.length, 1);
  const p = r[0].pts;
  assert.ok(p.every(q => q.y > 12 && q.y < 16), "liegt mittig");
  assert.ok(len(p) > 45, "fast so lang wie der Strich");
});

test("Kreuz: Linien treffen sich in der Mitte, keine Konturen doppelt", () => {
  const W = 60, H = 60;
  const r = centerlines(mask(W, H, [[5, 27, 55, 33], [27, 5, 33, 55]]), W, H, 6, 1);
  assert.ok(r.length >= 2 && r.length <= 5, String(r.length));
  const total = r.reduce((s, p) => s + len(p.pts), 0);
  assert.ok(total > 80 && total < 120, "etwa zwei Striche à 50 px, nicht vier Konturen: " + total);
});

test("Ring wird eine geschlossene Linie", () => {
  const W = 60, H = 60, m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d = Math.hypot(x - 30, y - 30); if (d > 16 && d < 21) m[y * W + x] = 1; }
  const r = centerlines(m, W, H, 10, 0.7);
  assert.equal(r.length, 1);
  const p = r[0].pts;
  assert.ok(p.length >= 8, "der Ring bleibt rund: " + p.length);
  assert.ok(p.every(q => Math.abs(Math.hypot(q.x - 30, q.y - 30) - 18.5) < 2.5), "auf dem Mittelkreis");
  assert.ok(r[0].closed || Math.hypot(p[0].x - p[p.length - 1].x, p[0].y - p[p.length - 1].y) < 3, "geschlossen");
});

test("Fleck kleiner als Mindestlänge fällt weg", () => {
  const W = 40, H = 40;
  assert.equal(centerlines(mask(W, H, [[10, 10, 13, 13]]), W, H, 8, 1).length, 0);
});

test("Vereinfachen: ein Ring (Anfang = Ende) bleibt ein Ring", async () => {
  const { simplifyOpen } = await import("../src/centerline.ts");
  const ring = Array.from({ length: 41 }, (_, i) => ({ x: 10 * Math.cos((i / 40) * Math.PI * 2), y: 10 * Math.sin((i / 40) * Math.PI * 2) }));
  const s = simplifyOpen(ring, 0.5);
  assert.ok(s.length >= 8, String(s.length));
});
