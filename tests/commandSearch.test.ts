// Befehlssuche – läuft mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldText, scoreItem, searchItems } from "../src/commandSearch.ts";

test("Umlaute und Akzente spielen keine Rolle", () => {
  assert.equal(foldText("Fräsen"), "frasen");
  assert.equal(foldText("Größe"), "grosse");
  assert.equal(foldText("Łuk"), "luk");
  assert.equal(foldText("Décalage"), "decalage");
  assert.ok(scoreItem({ name: "Fräser" }, "fraser") > 0);
});

test("Anfang des Namens schlägt Mitte, Mitte schlägt den Hinweis-Text", () => {
  const items = [{ name: "Text auf Pfad" }, { name: "Kontext" }, { name: "Linie", more: "text" }, { name: "Mein Text" }];
  assert.deepEqual(searchItems(items, "text").map(i => i.name), ["Text auf Pfad", "Mein Text", "Kontext", "Linie"]);
});

test("alle Suchwörter müssen vorkommen, in beliebiger Reihenfolge", () => {
  assert.ok(scoreItem({ name: "Doppelte Linien entfernen" }, "linien doppelte") > 0);
  assert.equal(scoreItem({ name: "Doppelte Linien entfernen" }, "linien kreis"), 0);
});

test("leere Suche zeigt alles nach Namen", () => {
  const r = searchItems([{ name: "B" }, { name: "A" }], "  ");
  assert.deepEqual(r.map(i => i.name), ["A", "B"]);
});

test("Sonderzeichen in der Suche stören nicht", () => {
  assert.equal(scoreItem({ name: "Array" }, "(["), 0);
  assert.ok(scoreItem({ name: "Print & Cut" }, "&") > 0);
});
