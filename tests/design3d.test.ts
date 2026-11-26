// Entwurf in 3D: Rechnung – läuft mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampCam, cropGrid, distFor, dragDepth, frameRects, matrix, MAX_EL, MIN_EL, onPlane, project, pxPerMm, zoomAt, type Cam } from "../src/editor/design3dMath.ts";

const v = { w: 800, h: 600 };
const cams: Cam[] = [
  { tx: 150, ty: 100, dist: 400, yaw: 0, el: MAX_EL }, { tx: 10, ty: -20, dist: 300, yaw: -0.45, el: 0.75 }, { tx: 0, ty: 0, dist: 900, yaw: 2.2, el: 0.3 },
];
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

test("Bildschirm → Ebene → Bildschirm kommt am selben Pixel an (auch auf anderer Höhe)", () => {
  for (const c of cams) for (const [x, y] of [[400, 300], [120, 520], [700, 420]]) for (const z of [0, -12]) {
    const p = onPlane(c, v, x, y, z);
    if (!p) continue;
    const q = project(c, v, p.x, p.y, z)!;
    near(q.x, x, 1e-4); near(q.y, y, 1e-4);
  }
});

test("Matrix und project stimmen überein", () => {
  for (const c of cams) {
    const m = matrix(c, v, 500), P = [c.tx + 37, c.ty - 21, -8, 1];
    const o = [0, 1, 2, 3].map(r => [0, 1, 2, 3].reduce((s, k) => s + m[k * 4 + r] * P[k], 0));
    const q = project(c, v, P[0], P[1], P[2])!;
    near((o[0] / o[3] + 1) / 2 * v.w, q.x, 0.01); near((1 - o[1] / o[3]) / 2 * v.h, q.y, 0.01);
  }
});

test("Von oben: rechts ist +X, oben ist +Y, Maßstab wie angegeben", () => {
  const c = cams[0], k = pxPerMm(c, v);
  const q = project(c, v, c.tx + 10, c.ty + 20, 0)!;
  near(q.x, 400 + 10 * k, 1e-3); near(q.y, 300 - 20 * k, 1e-3);
  near(distFor(k, v), c.dist);
});

test("Schräg: Tiefer liegt weiter unten im Bild, über dem Horizont trifft nichts", () => {
  const c = cams[1];
  assert.ok(project(c, v, c.tx, c.ty, -20)!.y > project(c, v, c.tx, c.ty, 0)!.y);
  assert.equal(onPlane({ ...c, el: MIN_EL }, v, 400, 0), null);
});

test("Zoom hält den Punkt unter der Maus, Grenzen der Kamera", () => {
  for (const c of cams) {
    const p = onPlane(c, v, 500, 450)!;
    const n = zoomAt(c, p, 0.5), q = project(n, v, p.x, p.y, 0)!;
    near(q.x, 500, 1e-3); near(q.y, 450, 1e-3);
  }
  assert.equal(clampCam({ ...cams[0], el: 9 }).el, MAX_EL);
  assert.equal(clampCam({ ...cams[0], el: -9 }).el, MIN_EL);
});

test("Tiefe ziehen: nach unten = tiefer, nie über 0, gerundet", () => {
  const c = cams[1], k = pxPerMm(c, v) * Math.cos(c.el);
  near(dragDepth(c, v, -2, 3 * k, 300, 0.1), -5, 0.051);
  assert.equal(dragDepth(c, v, -2, -50 * k, 300, 0.1), 0);
  assert.equal(dragDepth(c, v, -2, 1e6, 300, 0.1), -300);
  assert.ok(Number.isFinite(dragDepth(cams[0], v, -2, 10, 300, 0.1)));
});

test("Rand um das gerechnete Stück: Fläche geht auf", () => {
  const o = { x0: 0, y0: 0, x1: 100, y1: 60 }, i = { x0: 20, y0: 10, x1: 50, y1: 40 };
  const A = (r: any) => (r.x1 - r.x0) * (r.y1 - r.y0);
  near(frameRects(o, i).reduce((s, r) => s + A(r), 0), A(o) - A(i));
  assert.deepEqual(frameRects(o, { x0: 200, y0: 0, x1: 300, y1: 10 }), [o]);
  assert.equal(frameRects(o, { x0: -5, y0: -5, x1: 105, y1: 65 }).length, 0);
});

test("Raster zuschneiden", () => {
  const g = { nx: 4, ny: 3, x0: 0, y0: 0, cell: 1, h: Float32Array.from({ length: 12 }, (_, i) => i) };
  const c = cropGrid(g, { x0: 1, y0: 1, x1: 3, y1: 3 })!;
  assert.deepEqual([c.nx, c.ny, c.x0, c.y0, [...c.h]], [2, 2, 1, 1, [5, 6, 9, 10]]);
  assert.equal(cropGrid(g, { x0: 50, y0: 0, x1: 60, y1: 3 }), null);
  assert.equal(cropGrid(g, { x0: -9, y0: -9, x1: 9, y1: 9 }), g);
});
