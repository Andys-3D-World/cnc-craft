// Fräsergebnis in der 3D-Ansicht: genauer Abdruck des Fräsers und Netz ohne Sägezähne – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { carve } from "../src/view3d/carveSim.ts";
import { carveSurface, diagonal00to11 } from "../src/view3d/carveMesh.ts";
import { parseGcodeProgram } from "../src/sim/gcodeParser.ts";
import { LiveCarve } from "../src/sim/simCarve.ts";
import { ChunkGrid, CHUNK } from "../src/sim/carveChunks.ts";
import type { ToolGeom } from "../src/toolGraphics.ts";

const tool = (type: string, d: number): ToolGeom => ({ type, diameter: d, shankDia: d, fluteLen: 20, length: 40, flutes: 2, helix: "up", angle: 0, tipDia: 0, cornerR: 0 } as ToolGeom);

test("Bohrung: rund, richtige Größe, Mitte nicht aufs Raster gerundet", async () => {
  const r = (await carve(["G21", "G90", "G0 X10.013 Y20.037", "G1 Z-2 F100", "G0 Z5"], [tool("endmill", 6)], () => true))!;
  let cut = 0, sx = 0, sy = 0;
  for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++) {
    const x = r.x0 + (i + 0.5) * r.cell, y = r.y0 + (j + 0.5) * r.cell;
    const inside = Math.hypot(x - 10.013, y - 20.037) <= 3;
    assert.equal(r.h[j * r.nx + i] < 0, inside, `${x},${y}`);
    if (inside) { assert.ok(Math.abs(r.h[j * r.nx + i] + 2) < 1e-4); cut++; sx += x; sy += y; }
  }
  assert.ok(Math.abs((cut * r.cell * r.cell) / (Math.PI * 9) - 1) < 0.01);
  assert.ok(Math.abs(sx / cut - 10.013) < r.cell / 4 && Math.abs(sy / cut - 20.037) < r.cell / 4);
});

test("Kugelfräser: Mitte tief, außen flacher", async () => {
  const r = (await carve(["G21", "G90", "G0 X0 Y0", "G1 Z-3 F100", "G0 Z5"], [tool("ball", 6)], () => true))!;
  const at = (x: number, y: number) => r.h[Math.floor((y - r.y0) / r.cell) * r.nx + Math.floor((x - r.x0) / r.cell)];
  assert.ok(Math.abs(at(0, 0) + 3) < 0.01);
  assert.ok(Math.abs(at(2, 0) + (3 - (3 - Math.sqrt(9 - 4)))) < 0.05);
});

test("Diagonale verbindet die ähnlich hohen Ecken", () => {
  assert.equal(diagonal00to11(0, -5, -5, 0), true);    // Grat von 00 nach 11 bleibt
  assert.equal(diagonal00to11(-5, 0, 0, -5), true);    // Tal von 00 nach 11
  assert.equal(diagonal00to11(0, 0, -5, 0), true);     // Ecke 01 tief: Diagonale bleibt oben, nur die Ecke fällt ab
  assert.equal(diagonal00to11(-5, 0, 0, 0), false);    // Ecke 00 tief: Diagonale 10–01 bleibt oben
});

test("Netz: schräge Wand ohne Sägezahn, Durchbruch offen, alle Dreiecke zeigen nach oben", () => {
  const nx = 6, ny = 6, T = 8, H = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (i + j >= 5) H[j * nx + i] = -T;  // diagonale Kante, rechts durch
  const s = carveSurface(H, nx, ny, 10, 20, 0.5, T);
  assert.ok(s.data.length <= nx * ny * 8);
  assert.deepEqual(Array.from(s.data.slice(0, 3)), [10, 20, T]);
  const heights = (a: number) => s.data[a * 8 + 2];
  let wall = 0;
  for (let k = 0; k < s.index.length; k += 3) {
    const [a, b, c] = [s.index[k], s.index[k + 1], s.index[k + 2]];
    const ux = s.data[b * 8] - s.data[a * 8], uy = s.data[b * 8 + 1] - s.data[a * 8 + 1], vx = s.data[c * 8] - s.data[a * 8], vy = s.data[c * 8 + 1] - s.data[a * 8 + 1];
    assert.ok(ux * vy - uy * vx > 0);
    assert.ok(!(heights(a) === 0 && heights(b) === 0 && heights(c) === 0), "Dreieck im Durchbruch");
    if (new Set([heights(a), heights(b), heights(c)]).size > 1) wall++;
  }
  // Kante 45°: durchgehende, ebene Wand aus 9 Dreiecken statt Stufen; nichts im Durchbruch
  assert.equal(wall, 9);
  assert.ok(s.index.length < (nx - 1) * (ny - 1) * 6);
});

test("Simulation: Bohrung rund und an der echten Stelle, nicht aufs Raster gerundet", () => {
  const p = parseGcodeProgram(["G21", "G90", "M3 S10000", "G0 Z5", "G0 X10.013 Y20.037", "G1 Z-2 F100", "G0 Z5", "M5"]);
  const c = LiveCarve.create(p, { tools: [tool("endmill", 6)], thickness: 10 })!;
  c.setTarget(p.n, 0);
  for (let k = 0; c.busy && k < 10000; k++) c.advance(50);
  let cut = 0;
  for (let j = 0; j < c.ny; j++) for (let i = 0; i < c.nx; i++) {
    const inside = Math.hypot(c.x0 + (i + 0.5) * c.cell - 10.013, c.y0 + (j + 0.5) * c.cell - 20.037) <= 3;
    assert.equal(c.h[j * c.nx + i] < 0, inside);
    if (inside) cut++;
  }
  assert.ok(Math.abs((cut * c.cell * c.cell) / (Math.PI * 9) - 1) < 0.02);
});

test("Ansicht: ebene Flächen werden zusammengefasst, die Fläche bleibt lückenlos", () => {
  const nx = 400, ny = 300, T = 8, H = new Float32Array(nx * ny);
  for (let j = 100; j < 200; j++) for (let i = 100; i < 300; i++) H[j * nx + i] = -3;     // Tasche
  const s = carveSurface(H, nx, ny, 0, 0, 1, T);
  assert.ok(s.index.length / 3 < 6000, `zu viele Dreiecke: ${s.index.length / 3}`);       // voll wären es 238.602
  // überdeckte Fläche = ganze Fläche (Grundriss)
  let area = 0;
  for (let k = 0; k < s.index.length; k += 3) {
    const [a, b, c] = [s.index[k] * 8, s.index[k + 1] * 8, s.index[k + 2] * 8];
    const ar = ((s.data[b] - s.data[a]) * (s.data[c + 1] - s.data[a + 1]) - (s.data[b + 1] - s.data[a + 1]) * (s.data[c] - s.data[a])) / 2;
    assert.ok(ar > 0);
    area += ar;
  }
  assert.ok(Math.abs(area - 399 * 299) < 1e-3, String(area));
});

test("Kacheln: eben = 2 Dreiecke, durch = keine, geändert = volles Raster; Fläche bleibt lückenlos", () => {
  const nx = 3 * CHUNK + 1, ny = 2 * CHUNK + 1, h = new Float32Array(nx * ny);
  const g = new ChunkGrid(nx, ny, false, true, -8);
  const out = new Uint32Array(CHUNK * CHUNK * 6);
  assert.equal(g.count.length, 6);
  for (let k = 0; k < 6; k++) assert.equal(g.build(k, h, out), 6);
  assert.deepEqual(g.ranges().length, 12);   // kleine Kacheln: einzelne Abschnitte
  h[CHUNK + 10 + (CHUNK + 10) * nx] = -2;    // Kachel 4 (Mitte oben)
  assert.equal(g.build(4, h, out), CHUNK * CHUNK * 6);
  assert.equal(g.build(0, h, out), 6);
  // Ring: Punkt direkt neben der Kachel macht auch sie uneben (Normale am Rand)
  h.fill(0); h[CHUNK + 1 + 5 * nx] = -2;
  assert.equal(g.build(0, h, out), CHUNK * CHUNK * 6);
  // ganz durch
  h.fill(-9);
  assert.equal(g.build(5, h, out), 0);
  assert.equal(g.count[5], 0);
  // volle Kacheln liegen hintereinander: ein Abschnitt
  const r = new ChunkGrid(nx, ny, false, false, -8), h2 = new Float32Array(nx * ny);
  for (let k = 0; k < 6; k++) r.build(k, h2, out);
  assert.deepEqual(r.ranges(), [0, r.total]);
  assert.equal(r.total, (nx - 1) * (ny - 1) * 6);
});

test("Kacheln: Diagonale folgt der Kante, rundherum schließt sich das Raster", () => {
  const nx = 5, ny = 4, h = new Float32Array(nx * ny);
  h[0] = -5;                                 // Ecke 00 tief: Diagonale 10–01
  const g = new ChunkGrid(nx, ny, false, false, -8), out = new Uint32Array(CHUNK * CHUNK * 6);
  g.build(0, h, out);
  assert.deepEqual(Array.from(out.slice(0, 6)), [0, 1, 5, 1, 6, 5]);
  const w = new ChunkGrid(nx, ny, true, false, -8);
  assert.equal(w.rows, ny);
  const n = w.build(0, h, out);
  assert.equal(n, (nx - 1) * ny * 6);
  assert.equal(Math.max(...out.slice(0, n)), ny * nx + nx - 1);   // Zeile ny (= Zeile 0, eine Runde weiter)
});
