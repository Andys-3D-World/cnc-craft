// Offene Pfade zu geschlossenen verbinden
import { test } from "node:test";
import assert from "node:assert/strict";
import { joinChains } from "../src/joinPaths.ts";

const L = (ref: string, ...p: number[][]) => ({ ref, pts: p.map(([x, y]) => ({ x, y })) });

test("Eine Form mit kleiner Lücke wird geschlossen, die Punkte bleiben", () => {
  const r = joinChains([L("a", [0, 0], [10, 0], [10, 10], [0, 10], [0, 0.05])], 0.1, true);
  assert.equal(r.closed.length, 1);
  assert.equal(r.closed[0].pts.length, 5);
  assert.deepEqual(r.closed[0].pts[4], { x: 0, y: 0.05 });
  assert.deepEqual(r.left, []);
});

test("Schon getroffene Enden: doppelter Punkt fällt weg", () => {
  const r = joinChains([L("a", [0, 0], [10, 0], [10, 10], [0, 0])], 0.1, true);
  assert.equal(r.closed[0].pts.length, 3);
});

test("Mehrere Teile, auch umgedreht, ergeben eine Kontur", () => {
  const r = joinChains([L("a", [0, 0], [10, 0]), L("b", [10, 10.05], [10.05, 0]), L("c", [10, 10], [0, 10]), L("d", [0, 10], [0, 0.02])], 0.1, true);
  assert.equal(r.closed.length, 1);
  assert.deepEqual(r.closed[0].from.sort(), ["a", "b", "c", "d"]);
  // Keine Ecke verschoben: alle Original-Punkte sind noch da
  for (const p of [[0, 0], [10, 0], [10.05, 0], [10, 10.05], [10, 10], [0, 10], [0, 0.02]]) {
    assert.ok(r.closed[0].pts.some(q => q.x === p[0] && q.y === p[1]), String(p));
  }
});

test("Zu große Lücke: bleibt offen und unverändert, Lücke wird gemeldet", () => {
  const r = joinChains([L("a", [0, 0], [10, 0], [10, 10], [0, 10], [0, 3])], 0.1, true);
  assert.deepEqual(r.closed, []);
  assert.equal(r.left.length, 1);
  assert.deepEqual(r.left[0].from, ["a"]);
  assert.ok(Math.abs(r.left[0].gap - 3) < 1e-9);
});

test("Ketten, die sich nicht schließen, bleiben getrennt offen", () => {
  const r = joinChains([L("a", [0, 0], [10, 0]), L("b", [10, 0], [20, 0])], 0.1, true);
  assert.deepEqual(r.closed, []);
  assert.deepEqual(r.left[0].from, ["a", "b"]);
});

test("Linie hin und zurück schließt keine Fläche ein", () => {
  const r = joinChains([L("a", [0, 0], [10, 0]), L("b", [10, 0], [0, 0])], 0.1, true);
  assert.deepEqual(r.closed, []);
  const old = joinChains([L("a", [0, 0], [10, 0]), L("b", [10, 0], [0, 0])], 0.1);
  assert.deepEqual(old.closed, []);
});

test("Bei zwei möglichen Enden gewinnt das nähere", () => {
  const r = joinChains([L("a", [0, 0], [10, 0], [10, 10]), L("far", [10.09, 10], [50, 50]), L("near", [10.01, 10], [0, 10], [0, 0])], 0.1, true);
  assert.equal(r.closed.length, 1);
  assert.deepEqual(r.closed[0].from, ["a", "near"]);
  assert.deepEqual(r.left[0].from, ["far"]);
});

test("Ohne keepGaps (Wählen von Außen/Innen) wie bisher: Endpunkt fällt weg", () => {
  const r = joinChains([L("a", [0, 0], [10, 0], [10, 10], [0, 0.01])], 0.05);
  assert.equal(r.closed[0].pts.length, 3);
});
