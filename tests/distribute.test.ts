// Gleichmäßig verteilen – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { distributeDeltas } from "../src/editor/distribute.ts";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
const after = (items: { min: number; max: number }[], deltas: number[]) => items.map((e, i) => ({ min: e.min + deltas[i], max: e.max + deltas[i] }));

test("Gleiche Lücken, unterschiedliche Breiten", () => {
  const items = [{ min: 0, max: 10 }, { min: 12, max: 40 }, { min: 90, max: 100 }];
  const r = distributeDeltas(items)!;
  const a = after(items, r.deltas);
  near(r.gap, (100 - 48) / 2);
  near(a[1].min - a[0].max, r.gap);
  near(a[2].min - a[1].max, r.gap);
  assert.equal(r.deltas[0], 0);
  assert.equal(r.deltas[2], 0);
});

test("Reihenfolge der Eingabe ist egal", () => {
  const items = [{ min: 90, max: 100 }, { min: 0, max: 10 }, { min: 12, max: 22 }, { min: 30, max: 40 }];
  const r = distributeDeltas(items)!;
  const a = after(items, r.deltas).sort((p, q) => p.min - q.min);
  for (let i = 1; i < a.length; i++) near(a[i].min - a[i - 1].max, r.gap);
  near(a[0].min, 0); near(a[3].max, 100);
});

test("Weniger als 3 Teile: nichts zu tun", () => {
  assert.equal(distributeDeltas([{ min: 0, max: 1 }, { min: 5, max: 6 }]), null);
});

test("Teile breiter als der Platz: Lücke wird negativ (Überlappung wird gemeldet)", () => {
  const r = distributeDeltas([{ min: 0, max: 50 }, { min: 5, max: 45 }, { min: 40, max: 60 }])!;
  assert.ok(r.gap < 0);
});

test("Schon gleichmäßig: nichts bewegt sich", () => {
  const r = distributeDeltas([{ min: 0, max: 10 }, { min: 20, max: 30 }, { min: 40, max: 50 }])!;
  for (const d of r.deltas) near(d, 0);
  near(r.gap, 10);
});

test("Ein langes Teil reicht am weitesten: es bleibt am Ende, nichts ragt darüber hinaus", () => {
  const items = [{ min: 0, max: 200 }, { min: 10, max: 20 }, { min: 30, max: 40 }];
  const a = after(items, distributeDeltas(items)!.deltas);
  assert.ok(Math.max(...a.map(e => e.max)) <= 200 + 1e-9);
});
