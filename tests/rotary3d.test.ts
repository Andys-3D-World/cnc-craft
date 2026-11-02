// Tests für Drehachse + 3D-Modell (Rundum-Bahnen, Modell auf die Achse legen) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { meshForRotary, rotateX, roughRotary, finishRotary, chainRotary, fieldPreview, thin3, type RField } from "../src/rotary3d.ts";

/** Feld: überall gleicher Spitzenradius, bei x ≥ cut ein Absatz */
function field(nx: number, nt: number, r: (i: number, j: number) => number): RField {
  const h = new Float32Array(nx * nt);
  for (let j = 0; j < nt; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = r(i, j);
  return { x0: 0, dx: 1, nx, nt, h };
}
const pts = (p: { pts: Float32Array }) => Array.from({ length: p.pts.length / 3 }, (_, k) => [p.pts[k * 3], p.pts[k * 3 + 1], p.pts[k * 3 + 2]]);

test("Modell auf die Achse: Längsachse → X ab 0, Querschnitt mittig, nicht gespiegelt", () => {
  // Dreieck mit Längsachse Z (0…50), Querschnitt um (10, 20)
  const pos = new Float32Array([10, 20, 0, 14, 20, 50, 10, 23, 25]);
  const m = meshForRotary(pos, 2, 100);
  assert.equal(m.scale, 2);
  const xs = [m.tris[0], m.tris[3], m.tris[6]];
  assert.deepEqual(xs, [0, 100, 50]);
  // zyklisch Z→X, X→Y, Y→Z: Mitte des Querschnitts liegt auf der Achse
  assert.ok(Math.abs(m.tris[1] + m.tris[4]) < 1e-6);
  assert.ok(m.maxR > 0);
  // Drehen um 90°: (y, z) = (0, 5) → (−5, 0)
  const r = rotateX(new Float32Array([1, 0, 5]), 90);
  assert.ok(Math.abs(r[1] + 5) < 1e-6 && Math.abs(r[2]) < 1e-6);
});

test("Schruppen: Schichten von außen nach innen, nie tiefer als Modell oder Schicht", () => {
  const R = 20, nt = 24;
  const f = field(11, nt, () => 14); // Modell überall Radius 14
  const paths = roughRotary(f, R, 2.5, 3);
  const layers = [...new Set(paths.map(p => p.layer))];
  assert.equal(layers.length, 3); // 17.5, 15, 14
  for (const p of paths) for (const q of pts(p)) {
    assert.ok(q[2] >= 14 - R - 1e-6, String(q[2]));
    assert.ok(q[2] <= 0);
  }
  // rundum alles zu schruppen → eine Bahn je Schicht, über alle Winkel
  assert.equal(paths.length, 3);
  const ys = pts(paths[0]).map(q => q[1]);
  assert.ok(Math.max(...ys) > 2 * Math.PI * R * (nt - 2) / nt);
});

test("Schruppen: Zeilen ganz in der Luft fallen weg (nur die Hälfte hat Material zu fräsen)", () => {
  const R = 20, nt = 24;
  // Winkel 0…11: Modell bis zum Rand (nichts zu tun), 12…23: Radius 16
  const f = field(5, nt, (_i, j) => (j < 12 ? 20 : 16));
  const paths = roughRotary(f, R, 5, 0);
  assert.equal(paths.length, 1);
  const p = pts(paths[0]);
  const ds = (2 * Math.PI * R) / nt;
  assert.ok(Math.min(...p.map(q => q[1])) >= 12 * ds - 1e-3);
});

test("Kern: tiefer als der Kern geht es nie", () => {
  const f = field(5, 12, () => 0);
  const paths = roughRotary(f, 10, 3, 4);
  for (const p of paths) for (const q of pts(p)) assert.ok(q[2] >= 4 - 10 - 1e-6);
});

test("Schlichten entlang der Achse: Zickzack, folgt dem Feld; Spirale: wandert in X", () => {
  const R = 10;
  const f = field(21, 8, i => (i < 10 ? 8 : 9));
  const [a] = finishRotary(f, R, "x", 1, 0.001);
  const p = pts(a);
  assert.equal(p[0][0], 0);
  assert.ok(p.every(q => q[2] === -2 || q[2] === -1 || Math.abs(q[2] + 1.5) < 1));
  const [s] = finishRotary(f, R, "around", 2, 0.001);
  const sp = pts(s);
  assert.equal(sp[0][0], 0);
  assert.equal(sp[sp.length - 1][0], 20);
  // 20 mm in 2-mm-Schritten = 10 Umdrehungen
  assert.ok(Math.abs(sp[sp.length - 1][1] - 10 * 2 * Math.PI * R) < 1e-3);
  // zwischen zwei Feldpunkten nie tiefer als der höhere
  assert.ok(sp.every(q => q[0] < 9 || q[0] > 10 || q[2] >= -1 - 1e-6 || q[0] === 9));
});

test("Schlichten ohne Schruppen: Stufen von außen, letzte = fertige Fläche", () => {
  const f = field(5, 8, () => 4);
  const lv = finishRotary(f, 10, "x", 1, 0.001, 2.5);
  assert.equal(lv.length, 3); // 7.5, 5, Fläche (4)
  assert.ok(pts(lv[0]).every(q => Math.abs(q[2] + 2.5) < 1e-6));
  assert.ok(pts(lv[2]).every(q => Math.abs(q[2] + 6) < 1e-6));
});

test("Bahnen aneinanderhängen: keine Rückdrehung um ganze Umdrehungen", () => {
  const R = 10, C = 2 * Math.PI * R;
  const mk = (y0: number, y1: number) => ({ kind: 0, layer: 0, top: 0, pts: new Float32Array([0, y0, 0, 1, y1, 0]) });
  const ps = [mk(0, 3 * C + 5), mk(5, 6)];
  chainRotary(ps, R);
  assert.ok(Math.abs(ps[1].pts[1] - (3 * C + 5)) < 1e-3);
});

test("Vorschau: Tiefe ≤ 0, rundherum geschlossen", () => {
  const f = field(4, 16, (_i, j) => (j === 0 ? 7 : 10));
  const r = fieldPreview(f, 10);
  assert.ok(r.minZ < -2 && r.minZ > -3.01);
  assert.ok(Array.from(r.h).every(v => v <= 0));
});

test("Ausdünnen: Gerade wird zu zwei Punkten, Ecke bleibt", () => {
  const line = Array.from({ length: 50 }, (_, i) => [i, 0, 0]);
  assert.equal(thin3(line, 0.01).length, 2);
  const corner = [...line, [49, 10, 0]];
  assert.equal(thin3(corner, 0.01).length, 3);
});
