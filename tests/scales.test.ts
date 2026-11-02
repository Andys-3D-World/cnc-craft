// Tests für Lineal, Winkelmesser und Zifferblatt – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { scale, rulerTicks, type ScaleOptions } from "../src/scales.ts";

const base: ScaleOptions = { kind: "ruler", unit: "mm", length: 150, width: 25, holeD: 6, radius: 60, diameter: 200, numerals: "arabic",
  centerHole: 8, textH: 3 };
const inside = (p: [number, number], w: number, h: number) => p[0] >= -1e-9 && p[0] <= w + 1e-9 && p[1] >= -1e-9 && p[1] <= h + 1e-9;

test("Lineal mm: 151 Striche je 1 mm, lange Striche je 10 mm, Zahlen in cm", () => {
  const r = scale(base);
  assert.equal(r.ticks.length, 151);
  for (let i = 1; i < r.ticks.length; i++) assert.ok(Math.abs(r.ticks[i][0][0] - r.ticks[i - 1][0][0] - 1) < 1e-9);
  const len = r.ticks.map(t => t[0][1] - t[1][1]);
  assert.ok(len[10] > len[5] && len[5] > len[1]);
  assert.deepEqual(r.labels.map(l => l.text), ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"]);
  // Striche beginnen an der Messkante (Oberkante)
  for (const t of r.ticks) assert.equal(t[0][1], 25);
  for (const t of r.ticks) for (const p of t) assert.ok(inside(p, r.w, r.h));
  assert.equal(r.holes.length, 1);
  assert.deepEqual(r.warnings, []);
});

test("Lineal Zoll: Striche je 1/16\", Zahlen je Zoll", () => {
  const t = rulerTicks("inch", 6);
  assert.equal(t.length, 97);
  assert.ok(Math.abs(t[16].pos - 25.4) < 1e-9);
  assert.deepEqual(t.filter(x => x.label).map(x => x.label), ["0", "1", "2", "3", "4", "5", "6"]);
  assert.equal(t[8].level, 3);
  assert.equal(t[4].level, 2);
});

test("Winkelmesser: 181 Striche + Kreuz, Zahlen 0 … 180, alles im Umriss", () => {
  const r = scale({ ...base, kind: "protractor", radius: 80 });
  assert.equal(r.ticks.length, 183);
  assert.equal(r.labels.length, 19);
  assert.equal(r.labels[9].text, "90");
  assert.ok(Math.abs(r.labels[9].x) < 1e-9 && r.labels[9].y > 0);
  for (const t of r.ticks.slice(0, 181)) for (const [x, y] of t) assert.ok(Math.hypot(x, y) <= 80 + 1e-9 && y >= -1e-9);
  assert.deepEqual(r.outline[0], r.outline[r.outline.length - 1]);
});

test("Zifferblatt: 60 Striche, 12 Zahlen, 12 oben, Loch für das Uhrwerk", () => {
  const r = scale({ ...base, kind: "clock", diameter: 200, textH: 14 });
  assert.equal(r.ticks.length, 60);
  assert.equal(r.labels.length, 12);
  assert.equal(r.labels[0].text, "12");
  assert.ok(Math.abs(r.labels[0].x) < 1e-9 && r.labels[0].y > 0);
  assert.ok(Math.abs(r.labels[3].y) < 1e-9 && r.labels[3].x > 0); // 3 rechts
  const hr = r.holes[0].map(([x, y]) => Math.hypot(x, y));
  assert.ok(Math.abs(Math.max(...hr) - 4) < 1e-9);
  assert.deepEqual(scale({ ...base, kind: "clock", numerals: "roman" }).labels.map(l => l.text).slice(0, 5), ["XII", "I", "II", "III", "IIII"]);
  assert.equal(scale({ ...base, kind: "clock", numerals: "none" }).labels.length, 0);
});

test("Hinweise: Lineal zu schmal, Zahlen zu groß", () => {
  assert.ok(scale({ ...base, width: 10, textH: 5 }).warnings.includes("scale.warnNarrow"));
  assert.ok(scale({ ...base, kind: "clock", diameter: 60, textH: 12 }).warnings.includes("scale.warnBig"));
});
