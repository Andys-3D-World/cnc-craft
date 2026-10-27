// Tests für „Werkzeug nachmessen bei langen Jobs“ – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeDriftPoints, DRIFT_SLOT } from "../src/driftPoints.ts";

const M = "M0 (Werkzeug nachmessen)";

test("erste sichere Stelle = Referenz, danach erst nach der eingestellten Zeit", () => {
  // Plätze bei 0, 10, 40, 61, 70, 125 Minuten
  const mins = [0, 10, 40, 61, 70, 125];
  const lines: string[] = [], times: number[] = [];
  mins.forEach((m, i) => { lines.push(DRIFT_SLOT); times.push(m * 60); lines.push(`G1 X${i}`); times.push(m * 60); });
  const r = placeDriftPoints(lines, times, 60, M);
  assert.equal(r.points, 3); // 0, 61, 125
  assert.ok(!r.lines.includes(DRIFT_SLOT));
  const at = r.lines.map((l, i) => (l === M ? r.lines[i + 1] : null)).filter(Boolean);
  assert.deepEqual(at, ["G1 X0", "G1 X3", "G1 X5"]);
});

test("ohne Platzhalter bleibt alles gleich", () => {
  const lines = ["G21", "G0 Z5", "G1 X1"];
  const r = placeDriftPoints(lines, [0, 0, 0], 30, M);
  assert.deepEqual(r.lines, lines);
  assert.equal(r.points, 0);
});
