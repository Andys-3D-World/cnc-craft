// Tests für Bohrzyklen in der Simulation (gleiche Bewegungen wie cycles.rs) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGcodeProgram, MOVE_RAPID, MOVE_CUT } from "../src/sim/gcodeParser.ts";

/** Bewegungen als Liste [Typ, x, y, z] (Endpunkte) */
function moves(src: string): [number, number, number, number][] {
  const p = parseGcodeProgram(src.split("\n"));
  return Array.from({ length: p.n }, (_, i) => [p.type[i], +p.x1[i].toFixed(3), +p.y1[i].toFixed(3), +p.z1[i].toFixed(3)]);
}

test("G81 mit G98: hinein mit Vorschub, zurück auf Starthöhe", () => {
  assert.deepEqual(moves("G0 Z10\nG98 G81 X5 Y6 Z-3 R2 F100\nX15\nG80"), [
    [MOVE_RAPID, 0, 0, 10],
    [MOVE_RAPID, 5, 6, 10], [MOVE_RAPID, 5, 6, 2], [MOVE_CUT, 5, 6, -3], [MOVE_RAPID, 5, 6, 10],
    [MOVE_RAPID, 15, 6, 10], [MOVE_RAPID, 15, 6, 2], [MOVE_CUT, 15, 6, -3], [MOVE_RAPID, 15, 6, 10],
  ]);
});

test("G99 bleibt auf R, Werte von einer Zeile ohne Loch gelten weiter", () => {
  const m = moves("G0 Z5\nG99 G83 R1 Q2 F50\nX0 Y0 Z-5");
  assert.deepEqual(m.at(-1), [MOVE_RAPID, 0, 0, 1]);
  // Zustellungen bis -1, -3, -5, dazwischen ganz heraus
  assert.deepEqual(m.filter(x => x[0] === MOVE_CUT).map(x => x[3]), [-1, -3, -5]);
});

test("G73 bricht nur den Span (kurz zurück)", () => {
  const m = moves("G0 Z5\nG73 X0 Y0 Z-4 R0 Q2 F100");
  assert.deepEqual(m.map(x => x[3]), [5, 0, -2, -1.75, -4, 5]);
});

test("G84 fährt mit Vorschub heraus und verweilt mit P", () => {
  const p = parseGcodeProgram("M3 S500\nG0 Z5\nG84 X0 Y0 Z-6 R2 P1 F600".split("\n"));
  const last = p.n - 1;
  assert.equal(p.type[last - 1], MOVE_CUT);
  assert.equal(+p.z1[last - 1].toFixed(3), 2);
  // 8 mm hinauf mit 600 mm/min = 0,8 s + 1 s Verweilen
  assert.ok(Math.abs(p.dur[last - 1] - 1.8) < 1e-6);
});

test("nach G0 ist der Zyklus vorbei", () => {
  const m = moves("G0 Z5\nG81 X0 Y0 Z-1 R1 F10\nG0 X50\nY20");
  assert.deepEqual(m.slice(-2), [[MOVE_RAPID, 50, 0, 5], [MOVE_RAPID, 50, 20, 5]]);
});
