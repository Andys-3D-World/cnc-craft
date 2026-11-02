// Tests für das Flex-Scharnier – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { livingHinge, columnSegments, suggestForThickness, HINGE_PATTERNS, type HingeOptions } from "../src/livingHinge.ts";

const base: HingeOptions = { pattern: "lines", width: 200, height: 100, panel: true, length: 60, spacing: 2, cut: 20, bridge: 3,
  amplitude: 0.6, slotWidth: 0.8, thickness: 3 };

test("Spalten: Anzahl, Abstand, alles in der Zone", () => {
  const r = livingHinge(base);
  assert.equal(r.columns, 31);
  assert.equal(r.x0, 70);
  assert.equal(r.x1, 130);
  const xs = [...new Set(r.lines.map(l => l.pts[0][0].toFixed(6)))].map(Number).sort((a, b) => a - b);
  assert.equal(xs.length, 31);
  for (let i = 1; i < xs.length; i++) assert.ok(Math.abs(xs[i] - xs[i - 1] - 2) < 1e-9);
});

test("Schnitte: Länge, Steg, Rand oben/unten, Spalten versetzt", () => {
  const A = columnSegments(100, 20, 3, false, 3), B = columnSegments(100, 20, 3, true, 3);
  for (const segs of [A, B]) {
    for (const [a, b] of segs) { assert.ok(a >= 3 - 1e-9 && b <= 97 + 1e-9); assert.ok(b - a <= 20 + 1e-9); }
    for (let i = 1; i < segs.length; i++) assert.ok(segs[i][0] - segs[i - 1][1] >= 3 - 1e-9, "Steg");
    // innere Schnitte voll lang, Abstand genau = Steg
    for (let i = 1; i < segs.length - 1; i++) assert.ok(Math.abs(segs[i][1] - segs[i][0] - 20) < 1e-9);
  }
  // Spalte A hat einen Schnitt genau in der Mitte, Spalte B dort einen Steg
  assert.ok(A.some(([a, b]) => Math.abs((a + b) / 2 - 50) < 1e-9));
  assert.ok(!B.some(([a, b]) => a < 50 && b > 50));
  // Stege einer Spalte liegen mitten in den Schnitten der Nachbarspalte
  for (let i = 1; i < A.length; i++) {
    const mid = (A[i - 1][1] + A[i][0]) / 2;
    if (mid > 15 && mid < 85) assert.ok(B.some(([a, b]) => a < mid && b > mid));
  }
});

test("keine Linie berührt eine andere (alle Muster)", () => {
  for (const pattern of HINGE_PATTERNS) {
    const r = livingHinge({ ...base, pattern, amplitude: 5 }); // zu großer Ausschlag wird begrenzt
    const cols = new Map<number, number[]>();
    for (const l of r.lines) {
      const xs = l.pts.map(p => p[0]);
      const c = Math.round(((Math.min(...xs) + Math.max(...xs)) / 2 - r.x0) / 2);
      cols.set(c, [Math.min(...xs, cols.get(c)?.[0] ?? Infinity), Math.max(...xs, cols.get(c)?.[1] ?? -Infinity)]);
    }
    const keys = [...cols.keys()].sort((a, b) => a - b);
    for (let i = 1; i < keys.length; i++) assert.ok(cols.get(keys[i])![0] > cols.get(keys[i - 1])![1] + 0.1, `${pattern}: Spalten ${i - 1}/${i} zu nah`);
  }
});

test("Langlöcher sind geschlossen und so breit wie eingestellt", () => {
  const r = livingHinge({ ...base, pattern: "slots", slotWidth: 1 });
  for (const l of r.lines) {
    assert.ok(l.closed);
    assert.deepEqual(l.pts[0], l.pts[l.pts.length - 1]);
    const xs = l.pts.map(p => p[0]);
    assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 1) < 1e-9);
  }
});

test("Platte: Umriss geschlossen, ohne Platte nur Muster", () => {
  const r = livingHinge(base);
  assert.deepEqual(r.outline, [[0, 0], [200, 0], [200, 100], [0, 100], [0, 0]]);
  assert.equal(livingHinge({ ...base, panel: false }).outline, null);
});

test("Biegeradius aus Zonenbreite und Dicke", () => {
  const r = livingHinge(base);
  assert.ok(Math.abs(r.radius90 - (60 / (Math.PI / 2) - 1.5)) < 1e-9);
  assert.ok(Math.abs(r.radius180 - (60 / Math.PI - 1.5)) < 1e-9);
});

test("Hinweise bei schlechten Werten", () => {
  assert.deepEqual(livingHinge(base).warnings, []);
  assert.ok(livingHinge({ ...base, spacing: 0.5 }).warnings.includes("hinge.warnStrip"));
  assert.ok(livingHinge({ ...base, bridge: 0.5 }).warnings.includes("hinge.warnBridge"));
  assert.ok(livingHinge({ ...base, cut: 4 }).warnings.includes("hinge.warnStiff"));
  assert.ok(livingHinge({ ...base, length: 300 }).warnings.includes("hinge.warnLength"));
  assert.ok(livingHinge({ ...base, height: 20 }).warnings.includes("hinge.warnShort"));
});

test("Vorschlag aus der Materialdicke", () => {
  assert.deepEqual(suggestForThickness(3), { spacing: 1.8, cut: 18, bridge: 3, amplitude: 0.9, slotWidth: 0.8 });
  const r = livingHinge({ ...base, ...suggestForThickness(6), thickness: 6 });
  assert.deepEqual(r.warnings, []);
});
