// Tests für die Koordinatensysteme G54–G59 – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseActiveWcs, zeroCommand, wcsInLine, lineResetsWcs, resumeWcs } from "../src/wcs.ts";

test("$G-Antwort: aktives System wird gelesen", () => {
  assert.equal(parseActiveWcs("[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]"), "G54");
  assert.equal(parseActiveWcs("[GC:G1 G57 G17 G21 G90 G94 M3 M8 T1 F600 S12000]"), "G57");
  assert.equal(parseActiveWcs("  [GC:G0 G59 G17]  "), "G59");
});

test("Andere Zeilen sind kein $G", () => {
  assert.equal(parseActiveWcs("[MSG:G55 ist nur Text]"), "");
  assert.equal(parseActiveWcs("<Idle|MPos:0,0,0>"), "");
  assert.equal(parseActiveWcs("[GC:G0 G17 G21]"), "");
});

test("Nullpunkt: immer P0 (aktives System), nie P1", () => {
  assert.equal(zeroCommand("XY"), "G10 L20 P0 X0 Y0");
  assert.equal(zeroCommand("Z"), "G10 L20 P0 Z0");
  assert.equal(zeroCommand("XYZ"), "G10 L20 P0 X0 Y0 Z0");
});

test("Von Hand gewähltes System erkennen", () => {
  assert.equal(wcsInLine("G55"), "G55");
  assert.equal(wcsInLine("g21 g90 G56 G0 X1"), "G56");
  assert.equal(wcsInLine("G54 G55"), "G55");
  assert.equal(wcsInLine("G53 G0 Z0"), "");
  assert.equal(wcsInLine("G54.1 P2"), "");
  assert.equal(wcsInLine("G0 X54 (G55) ; G56"), "");
});

test("M2/M30 setzen das System zurück, M3 nicht", () => {
  assert.equal(lineResetsWcs("M30"), true);
  assert.equal(lineResetsWcs("M2"), true);
  assert.equal(lineResetsWcs("M02"), true);
  assert.equal(lineResetsWcs("M3 S1000"), false);
  assert.equal(lineResetsWcs("(M30)"), false);
});

test("Fortsetzen: Job-Wahl geht vor, sonst aktives System, sonst gar keins – nie stillschweigend G54", () => {
  assert.equal(resumeWcs(56, "G55"), "G56");
  assert.equal(resumeWcs(null, "G55"), "G55");
  assert.equal(resumeWcs(null, ""), "");
});
