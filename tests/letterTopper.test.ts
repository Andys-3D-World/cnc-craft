// Tests für den Buchstaben-Stecker-Generator – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MultiPolygon } from "polygon-clipping";
import { topper, topperFrame, holeWeb, TOPPER_SHAPES, TOPPER_EDGES, TOPPER_MOUNTS, type TopperOptions } from "../src/letterTopper.ts";
import { inRegion, bounds } from "../src/nameConnect.ts";

type XY = [number, number];
const base: TopperOptions = { shape: "oval", edge: "plain", w: 48, h: 60, ring: 4, mount: "stick", stickW: 5, stickL: 60, holeD: 4, thicken: 0 };
const rect = (x0: number, y0: number, x1: number, y1: number): MultiPolygon => [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]];

// Ersatz-Zeichen (Größe egal, sie werden eingepasst)
const I = rect(0, 0, 2, 10);
const O: MultiPolygon = [[[[0, 0], [8, 0], [8, 10], [0, 10], [0, 0]], [[2, 2], [2, 8], [6, 8], [6, 2], [2, 2]]]];
const A: MultiPolygon = [[[[0, 0], [2, 0], [3, 4], [5, 4], [6, 0], [8, 0], [5, 10], [3, 10], [0, 0]]]];
const T: MultiPolygon = [[[[3, 0], [5, 0], [5, 8], [8, 8], [8, 10], [0, 10], [0, 8], [3, 8], [3, 0]]]];
const minus = rect(0, 0, 10, 2);
const fifty: MultiPolygon = [...rect(0, 0, 6, 10), ...O.map(p => p.map(r => r.map(([x, y]) => [x + 8, y] as [number, number])))];

function cross(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}
function selfIntersects(p: XY[]): boolean {
  const n = p.length - 1;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (cross(p[i], p[i + 1], p[j], p[j + 1])) return true;
  }
  return false;
}

for (const shape of TOPPER_SHAPES) for (const edge of TOPPER_EDGES) for (const mount of TOPPER_MOUNTS) {
  test(`${shape} / ${edge} / ${mount}: jedes Zeichen hängt am Rahmen, ein Teil, saubere Konturen`, () => {
    const o = { ...base, shape, edge, mount };
    const f = topperFrame(o);
    for (const [name, ch] of [["I", I], ["O", O], ["A", A], ["T", T], ["-", minus], ["50", fifty]] as [string, MultiPolygon][]) {
      const r = topper(f, o, { area: ch, lines: [] });
      assert.equal(r.dropped, 0, `${name}: lose Teile`);
      assert.equal(r.pieces, 1, name);
      for (const p of r.cut) for (const ring of p) {
        assert.deepEqual(ring[0], ring[ring.length - 1]);
        assert.ok(!selfIntersects(ring as XY[]), `${name}: Kontur überschneidet sich`);
      }
    }
    // Löcher (Aufhänger/Girlande) liegen mit Rand im Material
    const r = topper(f, o, { area: I, lines: [] });
    for (const [hx, hy] of f.holeAt) for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, d = f.holeR + holeWeb(f.holeR) * 0.95;
      assert.ok(inRegion(r.cut, hx + d * Math.cos(a), hy + d * Math.sin(a)), "Loch zu nah am Rand");
    }
    assert.equal(f.holeAt.length, mount === "hole" ? 1 : mount === "garland" ? 2 : 0);
  });
}

test("Maße: Rahmen so hoch wie gewünscht, Stab darunter, Oval so breit wie gewünscht", () => {
  const plain = topper(topperFrame({ ...base, mount: "none" }), base, { area: I, lines: [] });
  assert.ok(Math.abs(plain.h - 60) < 0.01 && Math.abs(plain.w - 48) < 0.01, `${plain.w} × ${plain.h}`);
  const stick = topper(topperFrame(base), base, { area: I, lines: [] });
  assert.ok(Math.abs(stick.h - 120) < 0.01, `${stick.h}`);
  const circle = topper(topperFrame({ ...base, shape: "circle", mount: "none" }), base, { area: I, lines: [] });
  assert.ok(Math.abs(circle.w - 60) < 0.01);
});

test("Zeichen bleibt im Rahmen und reicht in den Ring", () => {
  const o = { ...base, mount: "none" as const };
  const f = topperFrame(o), r = topper(f, o, { area: I, lines: [] });
  const b = bounds(r.cut);
  // senkrechter Strich: oben und unten verbunden – die Mitte der Öffnung ist Material
  assert.ok(inRegion(r.cut, 0, 0));
  assert.ok(inRegion(r.cut, 0, f.open.y1 - 0.5) && inRegion(r.cut, 0, f.open.y0 + 0.5));
  assert.ok(!inRegion(r.cut, f.open.x0 + 1, 0)); // daneben ist die Öffnung frei
  assert.ok(b.y1 <= 30 + 1e-9 && b.y0 >= -30 - 1e-9);
});

test("loses Teilchen fällt weg und wird gezählt", () => {
  const dot: MultiPolygon = [...I, ...rect(4, 4, 5, 5), ...I.map(p => p.map(r => r.map(([x, y]) => [x + 7, y] as [number, number])))];
  const r = topper(topperFrame(base), base, { area: dot, lines: [] });
  assert.equal(r.dropped, 1);
  assert.equal(r.pieces, 1);
});

test("Einzellinien-Schrift wird zu Stegen und hängt am Rahmen; Fettung", () => {
  const r = topper(topperFrame(base), base, { area: [], lines: [{ pts: [[0, 0], [5, 10], [10, 0]], closed: false }, { pts: [[2, 4], [8, 4]], closed: false }] });
  assert.equal(r.pieces, 1);
  assert.equal(r.dropped, 0);
  const thin = topper(topperFrame(base), base, { area: T, lines: [] });
  const fat = topper(topperFrame(base), { ...base, thicken: 1 }, { area: T, lines: [] });
  assert.ok(!inRegion(thin.cut, 3, 0) || inRegion(fat.cut, 3, 0));
});

test("doppelter Rand: Gravurlinie im Ring, nicht unter dem Zeichen", () => {
  const o = { ...base, edge: "double" as const, mount: "none" as const };
  const r = topper(topperFrame(o), o, { area: I, lines: [] });
  assert.ok(r.lines.length >= 2); // vom Strich oben und unten unterbrochen
  for (const l of r.lines) for (const [x, y] of l.pts) assert.ok(inRegion(r.cut, x, y));
});
