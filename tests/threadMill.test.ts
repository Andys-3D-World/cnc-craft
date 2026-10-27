// Tests für „Gewinde fräsen“ – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { threadPath, threadDiameter, resolveThread, type ThreadParams } from "../src/threadMill.ts";

const base: ThreadParams = {
  cx: 10, cy: 20, holeD: 6.8, internal: true, D: 0, pitch: 0, toolPitch: 1.25, toolD: 6, length: 10,
  left: false, feed: 400, plunge: 100, safeZ: 5,
};
const arcs = (lines: string[], g: string) => lines.filter(l => l.startsWith(g));
const zOf = (l: string) => Number(/Z(-?[\d.]+)/.exec(l)![1]);

test("Nenn-Ø aus dem Kernloch: M8 aus 6,8 mm", () => {
  assert.equal(threadDiameter({ ...base, pitch: 1.25 }), 8);
  assert.equal(threadDiameter({ ...base, holeD: 10.2, pitch: 1.75 }), 12);
  assert.equal(threadDiameter({ ...base, D: 8.2, pitch: 1.25 }), 8.2);
  assert.equal(threadDiameter({ ...base, internal: false, holeD: 8, pitch: 1.25 }), 8);
});

test("Einzahn-Fräser: Gewinde und Steigung aus der ISO-Tabelle", () => {
  assert.deepEqual(resolveThread({ ...base, toolPitch: 0 }), { D: 8, P: 1.25 });          // Kernloch 6,8
  assert.deepEqual(resolveThread({ ...base, toolPitch: 0, holeD: 5 }), { D: 6, P: 1 });   // Kernloch 5
  assert.deepEqual(resolveThread({ ...base, toolPitch: 0, internal: false, holeD: 10 }), { D: 10, P: 1.5 });
  assert.deepEqual(resolveThread({ ...base, toolPitch: 0, D: 12 }), { D: 12, P: 1.75 });
  // Feingewinde: Steigung eingegeben
  assert.deepEqual(resolveThread({ ...base, toolPitch: 0, D: 10, pitch: 1 }), { D: 10, P: 1 });
});

test("Innen-Rechtsgewinde: Halbkreis hinein, G3 aufwärts, Halbkreis zur Mitte", () => {
  const r = threadPath(base);
  if (!r.ok) return assert.fail();
  const g3 = arcs(r.lines, "G3");
  // Einfahrbogen: von der Lochmitte (Bogenmitte bei R/2 = 0,5) auf X11, halbe Steigung höher
  assert.ok(r.lines.includes("G1 Z-10.000 F100"));
  assert.match(g3[0], /^G3 X11\.000 Y20\.000 Z-9\.375 I0\.500 J0 F100$/);
  // dann volle Umdrehungen mit I = −R
  assert.match(g3[1], /^G3 X11\.000 Y20\.000 Z-8\.125 I-1\.000 J0$/);
  // Ausfahrbogen zurück zur Mitte, oberhalb der Oberkante
  assert.match(g3.at(-1)!, /^G3 X10\.000 Y20\.000 Z[\d.]+ I-0\.500 J0$/);
  assert.ok(zOf(g3.at(-2)!) >= 0 - 0.625 && zOf(g3.at(-1)!) >= 0);
  assert.ok(!r.lines.some(l => l.startsWith("G2")));
});

test("Innen-Linksgewinde: von oben nach unten, endet genau bei −Länge", () => {
  const r = threadPath({ ...base, left: true, length: 9 });
  if (!r.ok) return assert.fail();
  const g3 = arcs(r.lines, "G3");
  assert.equal(zOf(g3.at(-1)!), -9);
  assert.ok(zOf(r.lines.find(l => l.startsWith("G1 Z"))!) >= 0);
});

test("Mehrere Durchgänge vom Kernloch bis zur vollen Tiefe, plus Leerdurchgang", () => {
  const r = threadPath({ ...base, toolD: 4, passes: 3, springPass: true });
  if (!r.ok) return assert.fail();
  // Einfahrbögen (I = R/2): erster Kontakt R0 = 3,4 − 2 = 1,4, voll R = 4 − 2 = 2
  const entries = arcs(r.lines, "G3").filter(l => /X10\.000/.test(l) === false && / I\d/.test(l));
  assert.deepEqual(entries.map(l => Number(/I([\d.]+)/.exec(l)![1]) * 2), [1.6, 1.8, 2, 2]);
});

test("Vorschub an der Fräsermitte innen kleiner", () => {
  const r = threadPath(base);
  if (!r.ok) return assert.fail();
  // 400 · 1 / 4 = 100
  assert.match(arcs(r.lines, "G3")[0], /F100$/);
});

test("Außen-Rechtsgewinde: Viertelbogen von außen, G2 abwärts bis −Länge", () => {
  const r = threadPath({ ...base, internal: false, holeD: 8 });
  if (!r.ok) return assert.fail();
  const g2 = arcs(r.lines, "G2");
  assert.ok(g2.length >= 8);
  // R = (8 − 1,22687·1,25)/2 + 3 = 6,2333
  assert.match(g2[0], /^G2 X16\.233 Y20\.000 Z[-\d.]+ I-6\.233 J0$/);
  assert.ok(r.lines.includes("G0 X19.233 Y23.000")); // Anfahrpunkt R + 3 / +3
  assert.equal(zOf(r.lines.filter(l => l.startsWith("G3")).at(-1)!), -10);
  assert.equal(r.info.minorD.toFixed(3), "6.466");
});

test("Fehler: Fräser zu groß / passt nicht ins Kernloch / keine Länge", () => {
  assert.deepEqual(threadPath({ ...base, toolD: 8 }), { ok: false, why: "toolTooBig" });
  assert.deepEqual(threadPath({ ...base, toolD: 7 }), { ok: false, why: "toolNoFit" });
  assert.deepEqual(threadPath({ ...base, length: 0 }), { ok: false, why: "length" });
});

test("3D-Gewindefläche: innen zwischen Kernloch und Nenn-Ø, Gang steigt mit dem Winkel", async () => {
  const { threadRadius } = await import("../src/view3d/threadMesh.ts");
  const r = threadPath(base);
  if (!r.ok) return assert.fail();
  const t = r.info;
  const rs = Array.from({ length: 200 }, (_, i) => threadRadius(t, -i * 0.05, 0));
  assert.ok(Math.min(...rs) >= 3.4 - 1e-9 && Math.max(...rs) <= 4 + 1e-9);
  assert.ok(rs.some(v => Math.abs(v - 4) < 1e-6) && rs.some(v => Math.abs(v - 3.4) < 1e-6));
  // eine Viertelumdrehung weiter liegt derselbe Gang P/4 höher (Rechtsgewinde)
  assert.ok(Math.abs(threadRadius(t, -5, 0) - threadRadius(t, -5 + t.P / 4, Math.PI / 2)) < 1e-9);
});
