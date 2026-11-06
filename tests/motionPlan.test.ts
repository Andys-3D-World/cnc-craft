// Laufzeit mit Beschleunigung
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGcodeProgram } from "../src/sim/gcodeParser.ts";

const lim = { accel: [100, 100, 50], maxRate: [6000, 6000, 600], junctionDev: 0.01, lookahead: 1000 };
const time = (lines: string[], motion: any = lim) => parseGcodeProgram(lines, { motion }).totalTime;
const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

test("Ohne Angabe bleibt alles wie bisher", () => {
  const p = parseGcodeProgram(["G1 X100 F600"]);
  near(p.totalTime, 10);
  assert.equal(p.durPlain, undefined);
});

test("Lange Strecke: Rampe + Reisefahrt", () => {
  // 100 mm bei 1000 mm/min (16,67 mm/s), a = 100: je 0,1667 s Rampe, 1,389 mm je Rampe
  const v = 1000 / 60, ramp = v / 100, d = v * v / 200;
  near(time(["G1 X100 F1000"]), 2 * ramp + (100 - 2 * d) / v);
});

test("Kurze Strecke erreicht den Vorschub nicht", () => {
  // 1 mm, a = 100: Spitze sqrt(100) = 10 mm/s, Zeit 2 × 0,1 s
  near(time(["G1 X1 F6000"]), 0.2);
});

test("Gerade Stücke fahren durch, wie eine Strecke", () => {
  const one = time(["G1 X10 F1000"]);
  const many = time(["G1 X2 F1000", "X4", "X6", "X8", "X10"]);
  near(one, many, 1e-9);
});

test("Ecke und Umkehr kosten Zeit", () => {
  const straight = time(["G1 X20 F3000"]);
  const corner = time(["G1 X10 F3000", "Y10"]);
  const reverse = time(["G1 X10 F3000", "X0"]);
  assert.ok(corner > straight * 1.1);
  assert.ok(reverse >= corner);
});

test("Größere Kurvenabweichung fährt die Ecke schneller", () => {
  const job = ["G1 X10 F3000", "Y10", "X0", "Y0"];
  assert.ok(time(job, { ...lim, junctionDev: 0.1 }) < time(job, { ...lim, junctionDev: 0.001 }));
});

test("Achsen-Grenzen begrenzen Eilgang, Vorschub und Beschleunigung", () => {
  // Z allein: 600 mm/min, a = 50 → 10 mm/s
  near(time(["G0 Z100"]), 2 * (10 / 50) + (100 - 2) / 10);
  // F über $110 wird gekappt
  near(time(["G1 X1000 F99999"]), time(["G1 X1000 F6000"]));
  // diagonal in XY darf schneller als eine Achse (je Achse 100 mm/s)
  const lin = 1000 * Math.SQRT2;
  const diag = time([`G0 X1000 Y1000`]);
  const v = 100 * Math.SQRT2, a = 100 * Math.SQRT2;
  near(diag, 2 * (v / a) + (lin - v * v / a) / v, 1e-6);
});

test("Wartezeit zählt, Spindelbefehl stoppt die Fahrt", () => {
  near(time(["G1 X100 F1000", "G4 P2", "G1 X200"]), 2 * time(["G1 X100 F1000"]) + 2);
  near(time(["G1 X100 F1000", "M5", "G1 X200"]), 2 * time(["G1 X100 F1000"]));
});

test("Bogen: Geschwindigkeit fällt auf ungefähr √(a·R), egal wie fein unterteilt", () => {
  // Kreis R = 5: Umfang 31,4 mm, √(100·5) = 22 mm/s → ca. 1,4 s (ohne Rampen wären es 0,63 s bei 50 mm/s)
  const job = ["G0 X5 Y0", "G1 X5.0001 F3000", "G2 X5.0001 Y0 I-5.0001 J0"];
  // $11 = 0,01 und $12 = 0,01: v² = a·R·($11/$12)
  const motion = { ...lim, arcTol: 0.01 };
  const coarse = parseGcodeProgram(job, { motion, arcTol: 0.05 });
  const fine = parseGcodeProgram(job, { motion, arcTol: 0.002 });
  const circle = (p: any) => p.totalTime - p.t0[1];
  assert.ok(circle(fine) > 1.2 && circle(fine) < 1.8, String(circle(fine)));
  assert.ok(Math.abs(circle(coarse) - circle(fine)) < 0.1);
});

test("Kleiner Puffer bremst viele kurze Stücke", () => {
  const job = ["G1 X0.1 F6000", ...Array.from({ length: 2000 }, (_, i) => `X${(0.2 + i * 0.1).toFixed(1)}`)];
  const big = time(job);
  const small = time(job, { ...lim, lookahead: 16 });
  assert.ok(small > big * 1.5, `${small} / ${big}`);
});

test("Rampen ändern die Vorschub-Dauer der Laser-Vorschau nicht", () => {
  const p = parseGcodeProgram(["G1 X100 F1000"], { motion: lim });
  near(p.durPlain![0], 6, 1e-5);
  assert.ok(p.dur[0] > 6);
});

test("Summe bleibt stimmig: t0 + dur = Gesamtzeit", () => {
  const p = parseGcodeProgram(["G0 X10", "G1 Y10 F500", "G2 X20 Y20 I10", "G0 X0 Y0"], { motion: lim });
  near(p.t0[p.n - 1] + p.dur[p.n - 1], p.totalTime, 1e-4);
});

test("Eine Million Bewegungen in vertretbarer Zeit", () => {
  const lines = Array.from({ length: 1_000_000 }, (_, i) => `G1 X${(i % 100).toFixed(3)} Y${(i % 77).toFixed(3)} F1200`);
  const t0 = Date.now();
  parseGcodeProgram(lines);
  const plain = Date.now() - t0;
  const t1 = Date.now();
  parseGcodeProgram(lines, { motion: lim });
  assert.ok(Date.now() - t1 < plain + 2500);
});
