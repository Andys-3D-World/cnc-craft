// Tests für Fingerzinken und Schwalbenschwanz – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import { joint, concaveCorners, type JointOptions, type XY } from "../src/joints.ts";

const area = (m: MultiPolygon) => m.reduce((s, poly) => s + poly.reduce((t, r, i) => {
  let a = 0; for (let k = 0, j = r.length - 1; k < r.length; j = k++) a += r[j][0] * r[k][1] - r[k][0] * r[j][1];
  return t + (i ? -1 : 1) * Math.abs(a / 2);
}, 0), 0);
const base: JointOptions = { kind: "finger", width: 100, thickness: 12, count: 5, lengthA: 80, lengthB: 80, tool: 6, clearance: 0.1,
  relief: "dogbone", angle: 10, depth: 15 };

test("Fingerzinken: ungerade Abschnitte, Teile überlappen nicht, füllen ohne Spiel die Fläche", () => {
  const r = joint({ ...base, tool: 0, clearance: 0, relief: "none" });
  assert.equal(r.segments, 5);
  assert.equal(joint({ ...base, count: 4 }).segments, 5);
  assert.ok(area(polygonClipping.intersection(r.a, r.b)) < 1e-6);
  // A + B = Rechteck 160 × 100 (A bis −80, B bis +80)
  assert.ok(Math.abs(area(polygonClipping.union(r.a, r.b)) - 160 * 100) < 1e-6);
  // Teil A: 3 Finger (Abschnitte 0, 2, 4) reichen bis x = 0
  const xs = r.a[0][0].filter(p => Math.abs(p[0]) < 1e-9);
  assert.equal(xs.length, 6);
});

test("Fingerzinken: Spiel macht die Fuge um das Spiel breiter", () => {
  const r = joint({ ...base, tool: 0, clearance: 0.2, relief: "none" });
  assert.ok(area(polygonClipping.intersection(r.a, r.b)) < 1e-6);
  // Spalt zwischen Finger von A (Abschnitt 0, y 0 … 20) und Finger von B (Abschnitt 1, y 20 … 40): 0,2 mm
  const topA = Math.max(...r.a[0][0].filter(p => p[0] > -6 && p[1] < 30).map(p => p[1]));
  const botB = Math.min(...r.b[0][0].filter(p => p[0] < -6 && p[1] > 10).map(p => p[1]));
  assert.ok(Math.abs(botB - topA - 0.2) < 0.01, `Spalt ${botB - topA}`);
});

test("Dogbones an jeder Innenecke, Ecke liegt auf dem Kreis", () => {
  const r = joint(base);
  // Teil A: 2 Schlitze × 2 Ecken, Teil B: 2 Finger × 2 Ecken am Fuß
  assert.equal(r.bones, 8);
  const plain = joint({ ...base, relief: "none" });
  assert.ok(area(r.a) < area(plain.a) - 1);
  assert.ok(r.warnings.length === 0);
  assert.ok(joint({ ...base, relief: "none" }).warnings.includes("joint.warnNoRelief"));
  assert.ok(joint({ ...base, count: 21 }).warnings.includes("joint.warnTool"));
});

test("T-Bones: Kreis in der Schlitz-Tiefe", () => {
  const r = joint({ ...base, relief: "tbone" });
  assert.equal(r.bones, 8);
  // A ist links bis −80: die T-Bones reichen nicht über die Fuge in Y hinaus
  for (const [, y] of r.a[0][0]) assert.ok(y >= -0.06 && y <= 100.06);
});

test("Schwalbenschwanz: Teile greifen ohne Überlappung, Außenecken gerundet, ein Teil je Platte", () => {
  for (const tool of [0, 3, 6]) {
    const r = joint({ ...base, kind: "dovetail", count: 3, tool });
    assert.equal(r.a.length, 1);
    assert.equal(r.b.length, 1);
    assert.ok(area(polygonClipping.intersection(r.a, r.b)) < 1e-3, `tool ${tool}`);
    // die Schwalbenschwänze ragen in B hinein
    assert.ok(Math.max(...r.a[0][0].map(p => p[0])) > 10);
  }
  // mit Fräser: keine spitze Außenecke mehr (Innenecken des Gegenstücks rundet der Fräser)
  const r = joint({ ...base, kind: "dovetail", count: 3, tool: 6 });
  assert.ok(concaveCorners(r.a[0][0] as XY[]).length > 0);
});

test("Schwalbenschwanz zu schmal → Hinweis", () => {
  assert.ok(joint({ ...base, kind: "dovetail", count: 12, depth: 20, angle: 15 }).warnings.includes("joint.warnNarrow"));
});
