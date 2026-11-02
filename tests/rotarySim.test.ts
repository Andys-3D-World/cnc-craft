// Tests für die Simulation mit Drehachse (A-Achse lesen, Bahnen um das runde Teil wickeln) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGcodeProgram } from "../src/sim/gcodeParser.ts";
import { wrapSimProgram, radialDepth } from "../src/sim/rotarySim.ts";

const near = (a: number, b: number, e = 1e-3) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);

test("G-Code-Leser: A wird gemerkt, reine Drehung ist eine Bewegung", () => {
  const p = parseGcodeProgram(["G90 G0 X0 Y0 Z0 A0", "G1 A90 F600", "G1 X10 A180"]);
  assert.ok(p.a0 && p.a1);
  assert.equal(p.n, 2);
  assert.equal(p.a1![0], 90);
  assert.equal(p.a0![1], 90);
  assert.equal(p.a1![1], 180);
  // Länge = nur X/Y/Z (die Drehung zählt nur für die Zeit)
  near(p.cutLength, 10);
  assert.ok(p.dur[0] > 0);
});

test("ohne A: nichts extra", () => {
  const p = parseGcodeProgram(["G0 X1 Y1", "G1 X5 F100"]);
  assert.equal(p.a0, undefined);
});

test("Zeichnung (Y = Umfang): Umfang einmal herum ist ein geschlossener Ring", () => {
  const R = 10, C = 2 * Math.PI * R;
  const p = parseGcodeProgram(["G0 X5 Y0 Z0", `G1 Y${C} F600`]);
  const w = wrapSimProgram(p, R, "surface");
  assert.equal(w.n, 1 + 180); // Eilgang + 360° in 2°-Stücken
  near(w.x0[1], 5); near(w.y0[1], 0); near(w.z0[1], 0);       // Start oben
  near(w.y1[45], R); near(w.z1[45], -R);                      // nach 90°: seitlich, auf Achshöhe
  near(w.y1[w.n - 1], 0); near(w.z1[w.n - 1], 0);             // wieder oben
  for (let i = 0; i < w.n; i++) near(radialDepth(w.y1[i], w.z1[i], R), 0);
  // Zeit bleibt gleich, Zeilen bleiben zugeordnet
  near(w.totalTime, p.totalTime);
  near(w.t0[w.n - 1] + w.dur[w.n - 1], p.totalTime);
  assert.ok(Array.from(w.line).slice(1).every(l => l === 1));
  assert.ok(w.rotary && Math.abs(w.rotary.aMax - 360) < 1e-3);
});

test("Tiefe: Z −2 liegt 2 mm unter der Oberfläche, egal wo herum", () => {
  const R = 20;
  const p = parseGcodeProgram(["G0 X0 Y0 Z-2", "G1 A250 F600"]);
  const w = wrapSimProgram(p, R, "a");
  for (let i = 0; i < w.n; i++) near(radialDepth(w.y1[i], w.z1[i], R), -2);
});

test("mehrere Seiten: bei A = 180 liegt eine Querfahrt (Y) gespiegelt unten", () => {
  const R = 15;
  const p = parseGcodeProgram(["G0 X0 Y0 Z0 A180", "G1 Y5 F600"]);
  const w = wrapSimProgram(p, R, "a");
  const last = w.n - 1;
  near(w.y1[last], -5);
  near(w.z1[last], -2 * R);
});

test("Rollen-Drehachse: A dreht die Rolle, das Teil nur im Verhältnis", () => {
  const p = parseGcodeProgram(["G0 X0 Y0 Z0 A0", "G1 A360 F600"]);
  const w = wrapSimProgram(p, 40, "a", { aScale: 0.5 });
  near(w.rotary!.aMax, 180);
});

test("Achse entlang Y: Zeichnung (X = rundherum) und fertiger G-Code mit A ergeben dasselbe Bild", () => {
  const R = 10, C = 2 * Math.PI * R;
  const design = wrapSimProgram(parseGcodeProgram(["G0 X0 Y7 Z0", `G1 X${C / 4} F600`]), R, "surface", { along: "y" });
  // gleiche Bahn als Maschinen-G-Code: Y entlang, A = −X/R (in Grad)
  const job = wrapSimProgram(parseGcodeProgram(["G0 Y7 Z0 A0", "G1 A-90 F600"]), R, "a", { along: "y" });
  const e1 = design.n - 1, e2 = job.n - 1;
  near(design.x1[e1], job.x1[e2]); near(design.y1[e1], job.y1[e2]); near(design.z1[e1], job.z1[e2]);
  // Achse entlang Y: das Teil liegt quer – Y bleibt 7, die Bahn geht um die Y-Achse herum
  near(job.y1[e2], 7);
  near(Math.abs(job.x1[e2]), R); near(job.z1[e2], -R);
  assert.equal(job.rotary!.along, "y");
});

test("Drehrichtung umkehren: A −90 umgekehrt = A 90 normal", () => {
  const a = wrapSimProgram(parseGcodeProgram(["G0 X0 Y0 Z0 A0", "G1 A90 F600"]), 10, "a");
  const b = wrapSimProgram(parseGcodeProgram(["G0 X0 Y0 Z0 A0", "G1 A-90 F600"]), 10, "a", { reverse: true });
  near(a.y1[a.n - 1], b.y1[b.n - 1]); near(a.z1[a.n - 1], b.z1[b.n - 1]);
});
