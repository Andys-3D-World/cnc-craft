// Sperrzonen für Spannpratzen
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyKeepOuts, isKeepOut, keepValues, segHitsZone, pointInPoly } from "../src/keepOut.ts";

const rect = (x0: number, y0: number, x1: number, y1: number, height = 10, margin = 5) =>
  ({ pts: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], height, margin });
const run = (lines: string[], zones = [rect(40, -10, 60, 10)], radius = 1.5) =>
  applyKeepOuts(lines.join("\n"), zones, { radius, note: "(keep)" });

test("Eilfahrt durch die Zone hebt Z und senkt danach wieder", () => {
  const r = run(["G21", "G90", "G0 Z5", "G0 X0 Y0", "G0 X100 Y0", "G1 Z-1 F100"]);
  assert.deepEqual(r.gcode.split("\n").slice(3), [
    "G0 Z15.000 (keep)", "G0 X0 Y0", "G0 Z5.000 (keep)", // Lage am Anfang unbekannt
    "G0 Z15.000 (keep)", "G0 X100 Y0", "G0 Z5.000 (keep)",
    "G1 Z-1 F100"
  ]);
  assert.equal(r.raised, 2);
  assert.deepEqual(r.hits, []);
});

test("Fahrt neben der Zone bleibt, wie sie ist", () => {
  const job = ["G0 Z5", "G0 X0 Y0", "G0 X100 Y30"];
  const src = ["G0 Z20", "G0 X0 Y50", "G0 X100 Y50", "G0 Z5", "G0 X120 Y50"];
  const r = run(src);
  assert.equal(r.gcode, src.join("\n"));
  assert.equal(r.raised, 0);
  assert.ok(job);
});

test("Schon hoch genug: kein zusätzlicher Hub", () => {
  const src = ["G0 Z20", "G0 X0 Y0", "G0 X100 Y0"];
  assert.equal(run(src).gcode, src.join("\n"));
});

test("Der Fräser hat eine Breite: knapp vorbei zählt", () => {
  const near = run(["G0 Z20", "G0 X0 Y11", "G0 Z5", "G0 X100 Y11"], [rect(40, -10, 60, 10)], 1.5);
  assert.ok(near.raised === 1, "Radius 1,5 berührt die Zone bei 1 mm Abstand");
  const free = run(["G0 Z20", "G0 X0 Y11", "G0 Z5", "G0 X100 Y11"], [rect(40, -10, 60, 10)], 0.5);
  assert.equal(free.raised, 0);
});

test("Z in derselben Zeile: erst hoch, X/Y für sich, dann auf das Ziel", () => {
  const r = run(["G0 Z20", "G0 X0 Y0", "G0 X100 Y0 Z2"]);
  assert.deepEqual(r.gcode.split("\n").slice(2), ["G0 X100 Y0", "G0 Z2.000 (keep)"]);
});

test("Schnitt in die Zone: Warnung mit Form, G-Code bleibt", () => {
  const src = ["(--- shape 3: RECT outside ---)", "G0 Z20", "G0 X0 Y0", "G1 Z-1 F100", "G1 X100 Y0 F500"];
  const r = run(src);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].kind, "cut");
  assert.match(r.hits[0].label, /shape 3/);
  assert.ok(r.gcode.includes("G1 X100 Y0 F500"));
});

test("Schnitt über der Pratze warnt nicht, Bogen in die Zone schon", () => {
  assert.deepEqual(run(["G0 Z20", "G0 X0 Y0", "G1 Z12 F100", "G1 X100 Y0"]).hits, []);
  const arc = run(["(--- shape 1 ---)", "G0 Z20", "G0 X30 Y20", "G1 Z-1 F100", "G2 X70 Y20 I20 J0"], [rect(45, 38, 55, 45)]);
  assert.equal(arc.hits.length, 1);
  // gegen den Uhrzeigersinn geht derselbe Bogen auf der anderen Seite vorbei
  const other = run(["G0 Z20", "G0 X30 Y20", "G1 Z-1 F100", "G3 X70 Y20 I20 J0"], [rect(45, 38, 55, 45)]);
  assert.deepEqual(other.hits, []);
});

test("Eilfahrt endet tief in der Zone oder taucht dort ein: Warnung", () => {
  const r = run(["(--- shape 2 ---)", "G0 Z20", "G0 X50 Y0", "G0 Z2"]);
  assert.equal(r.hits[0].kind, "rapid");
  const low = run(["G0 Z20", "G0 X0 Y0", "G0 Z2", "G0 X50 Y0"]);
  assert.equal(low.hits.length, 1);
});

test("Nach Werkzeugwechsel und G53 ist die Lage unbekannt: nächste Eilfahrt hebt", () => {
  const r = run(["G0 Z20", "G0 X200 Y0", "G0 Z2", "M0 (tool)", "G0 X200 Y1"]);
  assert.ok(r.gcode.endsWith("G0 Z15.000 (keep)\nG0 X200 Y1"));
  const g = run(["G0 Z20", "G0 X200 Y0", "G53 G0 Z-1", "G0 X200 Y1"]);
  assert.ok(g.gcode.endsWith("G0 Z15.000 (keep)\nG0 X200 Y1"));
});

test("Relative Fahrten werden gemeldet und nicht verändert", () => {
  const src = ["G0 Z20", "G91", "G0 X100", "G90"];
  const r = run(src);
  assert.equal(r.unsure, true);
  assert.equal(r.gcode, src.join("\n"));
});

test("Zoll: Höhe wird umgerechnet", () => {
  const r = run(["G20", "G0 Z0.2", "G0 X0 Y0"], [rect(40, -10, 60, 10, 10, 2.7)]);
  assert.ok(r.gcode.includes("G0 Z0.500 (keep)"));
});

test("Mehrere Zonen: die höchste im Weg zählt; ohne Zonen unverändert", () => {
  const r = run(["G0 Z30", "G0 X0 Y0", "G0 Z2", "G0 X100 Y0"], [rect(20, -5, 30, 5, 5, 2), rect(60, -5, 70, 5, 20, 3)]);
  assert.ok(r.gcode.includes("G0 Z23.000 (keep)"));
  assert.equal(applyKeepOuts("G0 X1", [], { radius: 1, note: "" }).gcode, "G0 X1");
});

test("Hilfen: Innen, Treffer, Datei-Werte", () => {
  const z = rect(0, 0, 10, 10);
  assert.ok(pointInPoly({ x: 5, y: 5 }, z.pts));
  assert.ok(!pointInPoly({ x: 15, y: 5 }, z.pts));
  assert.ok(segHitsZone({ x: -5, y: 5 }, { x: 15, y: 5 }, z, 0));
  assert.ok(!segHitsZone({ x: -5, y: 15 }, { x: 15, y: 15 }, z, 1));
  assert.equal(isKeepOut({ keepOut: {} }), true);
  assert.equal(isKeepOut({}), false);
  assert.deepEqual(keepValues({ keepOut: { height: "abc", margin: -1 } }), { height: 15, margin: 5 });
});
