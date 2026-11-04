// Tests für die Simulation mit Drehachse (A-Achse lesen, Bahnen um das runde Teil wickeln) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGcodeProgram } from "../src/sim/gcodeParser.ts";
import { wrapSimProgram, radialDepth } from "../src/sim/rotarySim.ts";
import { refRadius } from "../src/rotaryStock.ts";

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

// ---- Rohteil-Formen: fertiger G-Code → Lage am Teil, Tiefe unter der echten Oberfläche ----
const rect = { shape: "rect", diameter: 0, width: 20, height: 40, sides: 6, flats: 30, d0: 40, d1: 20, coneLen: 100 } as const;

test("Eckig: Punkt auf Fläche 2 (A 90) liegt auf der Seite, Tiefe zählt ab der Fläche", () => {
  const R = refRadius(rect); // Fläche 1: 20 über der Achse
  // Fläche 2 ist 10 über der Achse → Z −10 berührt sie, Z −11 ist 1 mm tief
  const p = parseGcodeProgram(["G0 X0 Y0 Z25 A0", "G0 A90", "G1 X5 Y2 Z-11 F100"]);
  const w = wrapSimProgram(p, R, "a", { stock: rect });
  const e = w.n - 1;
  near(w.y1[e], 9);             // Abstand Achse 9 Richtung +Y
  near(w.z1[e], -R - 2);        // Quer 2 → unter Achsmitte (Rotation), z um −R versetzt
  near(w.rotary!.depth[e], -1, 0.05);
});

test("Kegel: Zeichnung und fertiger G-Code liegen auf derselben Stelle, Tiefe an der Schräge", () => {
  const cone = { ...rect, shape: "cone" as const };
  const R = refRadius(cone); // 20
  const yc = Math.PI * 40 / 2;
  const d = wrapSimProgram(parseGcodeProgram([`G0 X100 Y${yc + 10} Z-1`]), R, "surface", { stock: cone });
  const lastD = d.n - 1;
  // am Ende: Radius 10, 10 mm neben der Mitte = 1 rad; Schneide 1 mm tief → Radius 9
  near(Math.hypot(d.y1[lastD], d.z1[lastD] + R), 9, 0.01);
  near(Math.atan2(d.y1[lastD], d.z1[lastD] + R), 1, 0.01);
  near(d.rotary!.depth[lastD], -1, 0.01);
  // fertiger G-Code: A = 1 rad in Grad, Z = −1 + (10 − 20)
  const g = wrapSimProgram(parseGcodeProgram(["G0 X0 Y0 Z25 A0", `G1 X100 Z-11 A${180 / Math.PI} F100`]), R, "a", { stock: cone });
  const e = g.n - 1;
  near(g.y1[e], d.y1[lastD], 0.01); near(g.z1[e], d.z1[lastD], 0.01);
});

test("Runde Teile: Tiefe wie bisher", () => {
  const w = wrapSimProgram(parseGcodeProgram(["G0 X0 Y0 Z-2", "G1 A250 F600"]), 20, "a");
  for (let i = 0; i < w.n; i++) near(w.rotary!.depth[i], -2);
});
