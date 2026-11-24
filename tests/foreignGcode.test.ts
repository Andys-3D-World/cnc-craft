// Tests für G-Code aus anderen Programmen: Ebenen, G92, Hinweise, Datei-Prüfung, Job-Zeilen – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGcodeProgram } from "../src/sim/gcodeParser.ts";
import { checkFileLines } from "../src/fileCheck.ts";
import { jobLines } from "../src/jobLines.ts";
import { scanJobExtents } from "../src/softLimits.ts";

const run = (src: string) => parseGcodeProgram(src.split("\n"));
const end = (p: ReturnType<typeof run>) => [p.x1[p.n - 1], p.y1[p.n - 1], p.z1[p.n - 1]].map(v => +v.toFixed(3));
const near = (a: number, b: number, tol = 0.03) => assert.ok(Math.abs(a - b) <= tol, `${a} statt ${b}`);
const kinds = (src: string) => (run(src).notes ?? []).map(n => `${n.kind}:${n.code}:${n.line}`);

test("G18: Halbkreis steht senkrecht – von +Y gesehen im Uhrzeigersinn, also unten herum", () => {
  const p = run("M3 S1\nG0 X0 Y7 Z0\nG18 G2 X20 Z0 I10 K0 F500");
  near(p.bounds.minZ, -10); near(p.bounds.maxZ, 0); near(p.bounds.maxX, 20); near(p.bounds.maxY, 7);
  assert.deepEqual(end(p), [20, 7, 0]);
  near(run("G18 G3 X20 Z0 I10 K0 F500").bounds.maxZ, 10);
});

test("G19: Halbkreis in Y/Z, dritte Achse X läuft mit", () => {
  const p = run("G19 G2 X5 Y20 Z0 J10 K0 F500");   // Y -> Z ist die positive Richtung, G2 läuft von Y0 oben herum
  near(p.bounds.maxZ, 10); near(p.bounds.minZ, 0); near(p.bounds.maxX, 5);
  assert.deepEqual(end(p), [5, 20, 0]);
});

test("gleiche Grenzen wie die Prüfung der Maschinengrenzen, auch in R-Schreibweise", () => {
  for (const l of ["G17 G2 X10 Y10 I10 J0 F100", "G18 G3 X10 Z10 I10 K0 F100", "G19 G2 Y10 Z10 J10 K0 F100", "G18 G2 X10 Z-4 R12 F100", "G19 G3 Y10 Z5 R-9 F100"]) {
    const b = run(l).bounds, e = scanJobExtents([l], { wpos: [0, 0, 0] });
    const lo = [b.minX, b.minY, b.minZ], hi = [b.maxX, b.maxY, b.maxZ];
    for (let i = 0; i < 3; i++) if (e.used[i]) { near(Math.min(0, e.min[i]), lo[i]); near(Math.max(0, e.max[i]), hi[i]); }
  }
});

test("G90.1: Mittelpunkt absolut, G91.1 wieder relativ", () => {
  const p = run("G0 X10 Y0\nG90.1 G3 X0 Y10 I0 J0 F100");
  near(Math.hypot(p.x1[5], p.y1[5]), 10);
  const q = run("G0 X10 Y0\nG90.1\nG91.1 G3 X0 Y10 I-10 J0 F100");
  near(Math.hypot(q.x1[5], q.y1[5]), 10);
});

test("G92 verschiebt, G92.1 hebt auf", () => {
  assert.deepEqual(end(run("G1 X50 F100\nG92 X0\nG1 X10")), [60, 0, 0]);
  assert.deepEqual(end(run("G1 X50 F100\nG92 X0\nG1 X10\nG92.1\nG1 X10")), [10, 0, 0]);
  assert.deepEqual(end(run("G1 X50 F100\nG92 X0\nG92.2\nG1 X10\nG92.3\nG1 X10")), [60, 0, 0]);
  assert.deepEqual(end(run("G20\nG1 X2 F10\nG92 X1\nG1 X2")), [76.2, 0, 0]);
});

test("G92 an unbekannter Stelle setzt nur den Wert: Programmanfang und nach dem Antasten (Plasma)", () => {
  assert.deepEqual(end(run("G92 X0 Y0 Z5\nG0 Z1")), [0, 0, 1]);
  const src = "G0 Z20\nG0 X10\nG91 G38.2 Z-50 F200\nG90\nG92 Z3\nG0 Z4\nG1 X20 F100\nG92.1\nG0 Z20";
  const p = run(src);
  assert.equal(+p.z1[p.n - 2].toFixed(3), 4);
  assert.equal(p.notes, undefined);
});

test("eigener und üblicher G-Code gibt keinen Hinweis", () => {
  assert.deepEqual(kinds("%\nO1001 (PART)\nG17 G21 G40 G49 G54 G80 G90 G94\nG91.1\nG64 P0.02\nT1 M6\nG43 H1\nS1000 M3\nG0 Z5\nG1 Z-1 F100\nG2 X1 Y1 I1 J0\nG98 G81 X5 Y5 Z-2 R1\nG80\nG4 P1\nG55\nM5\nM30\n%").filter(k => !k.startsWith("wcs")), []);
  assert.deepEqual(kinds("G55\nG0 X1\nG55\nG1 X2 F1"), []);
  assert.deepEqual(kinds("$H\n$J=G91 X10 F100\nG0 X1"), []);
});

test("was nicht nachgebildet wird, steht mit seiner Zeile da", () => {
  assert.deepEqual(kinds("G0 X1\nG41 D1 G1 X10 F100\nG1 Y10\nG40"), ["code:G41:1"]);
  assert.deepEqual(kinds("G68 X0 Y0 R90"), ["code:G68:0"]);
  assert.deepEqual(kinds("G0 X1\nM98 P100\nG65 P200 A1"), ["sub:M98:1", "sub:G65:2"]);
  assert.deepEqual(kinds("#100=50\nG1 X#100 F100\nWHILE [#1 LT 5] DO1"), ["expr::0"]);
  assert.deepEqual(kinds("G54 G0 X1\nG55 X2\nG55 X3"), ["wcs:G55:1"]);
  assert.deepEqual(kinds("G0 X1\nG28 Z0\nG53 G0 Z0"), ["move:G28:1", "move:G53:2"]);
  assert.deepEqual(kinds("G93 G1 X1 F2"), ["time:G93:0"]);
  assert.deepEqual(kinds("G1 X1 B45 F2"), ["axis:B:0"]);
  assert.deepEqual(kinds("G91 G81 X1 Z-1 R1 F2"), ["code:G81 (G91):0"]);
  assert.deepEqual(kinds("G187 P1\nG12 I5 F100"), ["code:G187:0", "code:G12:1"]);
  assert.equal(run("G41\nG41\nG41").notes![0].count, 3);
});

test("Kommentare zählen nicht, auch nicht nach offener Klammer", () => {
  assert.deepEqual(kinds("(G41 #1 [x])\nG0 X1 ; G68\nG1 X2 F1 (offen G41 X99"), []);
  assert.deepEqual(end(run("G1 X2 F1 (offen X99")), [2, 0, 0]);
});

test("Job-Zeilen: Befehl nach einem Kommentar bleibt, reine Kommentare fallen weg", () => {
  assert.deepEqual(jobLines(["%", "", "(nur Text)", "(a) (b)", "; x", " (hoch) G0 Z5 ", "(a) ; G1 X1", "(offen G0 X1", "M0 (Werkzeug)", "(--- Form 1 ---)"]),
    ["(hoch) G0 Z5", "M0 (Werkzeug)"]);
});

const rules = (src: string, kind: "mill" | "laser" | "plasma" = "mill", sMax = 1000) => checkFileLines(src.split("\n"), { kind, sMax }).map(i => `${i.rule}:${i.line}`);

test("Datei-Prüfung: richtiger fremder G-Code fällt nicht auf", () => {
  // Spindel von Hand, Z0 oben, Bohrzyklus, Leerfahrt in G1, Umlaut und „Infinity“ im Kommentar, kein M30
  assert.deepEqual(rules("G21 G90\nG0 Z5\nG0 X0 Y0\nG1 Z-1 F300 (Infinity größer)\nG1 X50\nG0 Z5\nG81 X5 Y5 Z-3 R1 F50\nG80"), []);
  assert.deepEqual(rules("G21\nM4 S0\nG0 X5\nG1 X10 S500 F1000\nG1 X20 Y5 S0\nG1 X30 Y0 S300\nM30", "laser"), []);
  assert.deepEqual(rules("G21\nM3 S1000\nG1 X1 F100\nM30"), []);
});

test("Datei-Prüfung: echte Fehler fallen auf", () => {
  assert.deepEqual(rules("G21 M3\nG1 X10\nM5"), ["cut-without-feed:2"]);
  assert.deepEqual(rules("G21 M3\nG1 X10 F100\nG1 XNaN\nM5"), ["broken-value:3"]);
  assert.deepEqual(rules("G21 M4\nG1 X10 F100 S5000\nM5", "laser"), ["s-out-of-range:2"]);
  assert.deepEqual(rules("G21 M3\nG1 X10 F100\nG0 X20\nM5", "plasma"), ["rapid-torch-on:3"]);
  assert.deepEqual(rules("G21 M3\nG1 X10 F100"), ["end-tool-on:2"]);
});
