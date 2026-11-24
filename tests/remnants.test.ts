// Tests für Reststücke (gespeicherte Material-Platten) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanRemnant, cleanRemnants, dropRemnant, freeArea, putRemnant, MAX_REMNANTS, MAX_NAME, type Remnant } from "../src/remnants.ts";

const rem = (name: string, extra: Partial<Remnant> = {}): Remnant => ({ name, mode: "plasma", w: 1000, h: 500, cell: 0.9, used: "100,50,200", percent: 25, date: "2026-11-24T10:00:00.000Z", ...extra });

test("ablegen, ersetzen, löschen – je Maschinenart getrennt", () => {
  let list = putRemnant([], rem("Stahl 3"))!;
  list = putRemnant(list, rem("Alu 2"))!;
  list = putRemnant(list, rem("Stahl 3", { mode: "laser" }))!;
  assert.deepEqual(list.map(r => r.name + "/" + r.mode), ["Alu 2/plasma", "Stahl 3/plasma", "Stahl 3/laser"]);
  list = putRemnant(list, rem("Stahl 3", { percent: 60 }))!;
  assert.equal(list.length, 3);
  assert.equal(list.find(r => r.name === "Stahl 3" && r.mode === "plasma")!.percent, 60);
  list = dropRemnant(list, "Stahl 3", "plasma");
  assert.deepEqual(list.map(r => r.mode).sort(), ["laser", "plasma"]);
  assert.ok(Math.abs(freeArea(rem("x")) - 0.375) < 1e-9);
});

test("kaputte und fremde Daten fallen weg", () => {
  for (const bad of [null, 5, {}, rem(""), rem("x", { mode: "drucker" }), rem("x", { w: -1 }), rem("x", { cell: 0 }), rem("x", { used: "1,<img>" }),
    rem("x", { used: "" }), rem("x", { w: 1e9 }), rem("x", { w: 90000, h: 90000, cell: 0.5 }), { ...rem("x"), w: "1000" }]) {
    assert.equal(cleanRemnant(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
  const c = cleanRemnant({ ...rem("  <b>Blech</b>\n" + "x".repeat(200)), percent: 500, date: "gestern", extra: 1 })!;
  assert.equal(c.name.length, MAX_NAME);
  assert.ok(c.name.startsWith("<b>Blech</b> x"), "Text bleibt Text (die Oberfläche maskiert ihn), Zeilenumbruch wird Leerzeichen");
  assert.equal(c.percent, 0); assert.equal(c.date, ""); assert.equal((c as any).extra, undefined);
  assert.deepEqual(cleanRemnants("x"), []);
  assert.equal(cleanRemnants([rem("a"), rem("a"), null, rem("b")]).length, 2);
});

test("Liste ist begrenzt", () => {
  let list: Remnant[] = [];
  for (let i = 0; i < MAX_REMNANTS; i++) list = putRemnant(list, rem("r" + i))!;
  assert.equal(putRemnant(list, rem("noch eins")), null);
  assert.ok(putRemnant(list, rem("r3", { percent: 1 })), "ersetzen geht weiter");
  assert.equal(cleanRemnants([...list, rem("zu viel")]).length, MAX_REMNANTS);
});
