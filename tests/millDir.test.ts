// Tests für die Fräsrichtung (Gleichlauf/Gegenlauf) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsCcw, orientLoop, circleCmd, arcNeedsReverse, cleanMillDir } from "../src/millDir.ts";
import { pocketPaths, pocketWallPaths } from "../src/pocket.ts";
import { polygonArea } from "../src/polyOffset.ts";

const ccwSquare = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

/** Liegt das Material rechts von der Fahrtrichtung? Das ist die Definition von Gleichlauf bei M3 */
function materialRight(from: { x: number; y: number }, to: { x: number; y: number }, material: { x: number; y: number }) {
  return (to.x - from.x) * (material.y - from.y) - (to.y - from.y) * (material.x - from.x) < 0;
}

test("Gleichlauf: außen im, innen gegen den Uhrzeigersinn; Gegenlauf umgekehrt; Standard gibt nichts vor", () => {
  assert.equal(wantsCcw("outside", "climb"), false);
  assert.equal(wantsCcw("inside", "climb"), true);
  assert.equal(wantsCcw("outside", "conventional"), true);
  assert.equal(wantsCcw("inside", "conventional"), false);
  assert.equal(wantsCcw("outside", ""), null);
});

test("Geometrie: außen im Uhrzeigersinn hat das Teil rechts", () => {
  // rechte Kante des Teils (0..10), Fräser läuft bei x=12 nach unten: Teil liegt rechts von der Fahrtrichtung
  assert.equal(materialRight({ x: 12, y: 10 }, { x: 12, y: 0 }, { x: 5, y: 5 }), true);
  const l = orientLoop(ccwSquare, "outside", "climb");
  assert.ok(polygonArea(l) < 0);
});

test("Innen: gegen den Uhrzeigersinn hat das Restmaterial rechts", () => {
  // Loch (0..10): rechte Wand, Fräser läuft bei x=8 nach oben, Material liegt rechts (x>10)
  assert.equal(materialRight({ x: 8, y: 0 }, { x: 8, y: 10 }, { x: 20, y: 5 }), true);
  assert.ok(polygonArea(orientLoop(ccwSquare, "inside", "climb")) > 0);
});

test("Drehen behält den Startpunkt, Standard lässt die Bahn in Ruhe", () => {
  const l = orientLoop(ccwSquare, "outside", "climb");
  assert.deepEqual(l[0], ccwSquare[0]);
  assert.equal(orientLoop(ccwSquare, "outside", ""), ccwSquare);
  assert.equal(orientLoop(ccwSquare, "outside", "conventional"), ccwSquare, "ist schon richtig");
});

test("Vollkreis-Befehl", () => {
  assert.equal(circleCmd("outside", "climb"), "G2");
  assert.equal(circleCmd("inside", "climb"), "G3");
  assert.equal(circleCmd("outside", "conventional"), "G3");
  assert.equal(circleCmd("inside", "conventional"), "G2");
  assert.equal(circleCmd("inside", ""), "G2", "Standard wie bisher");
});

test("Bogen wird nur gedreht, wenn er falsch herum läuft", () => {
  assert.equal(arcNeedsReverse(true, "outside", "climb"), false);
  assert.equal(arcNeedsReverse(false, "outside", "climb"), true);
  assert.equal(arcNeedsReverse(true, "inside", "climb"), true);
  assert.equal(arcNeedsReverse(true, "outside", ""), false);
});

test("Unbekannte Werte aus Projektdateien gelten als Standard", () => {
  assert.equal(cleanMillDir("climb"), "climb");
  assert.equal(cleanMillDir("quatsch"), "");
  assert.equal(cleanMillDir(undefined), "");
});

const big = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }];
const island = [{ x: 15, y: 15 }, { x: 25, y: 15 }, { x: 25, y: 25 }, { x: 15, y: 25 }];
const closedAreas = (paths: { pts: any[]; closed: boolean }[]) => paths.filter(p => p.closed).map(p => polygonArea(p.pts));

test("Tasche Kontur: alle Ringe ohne Insel in der gewählten Richtung", () => {
  const climb = pocketPaths(big, [], 1.5, 1.2, "spiral", "climb").paths;
  assert.ok(closedAreas(climb).length > 3);
  assert.ok(closedAreas(climb).every(a => a > 0));
  const conv = pocketPaths(big, [], 1.5, 1.2, "spiral", "conventional").paths;
  assert.ok(closedAreas(conv).every(a => a < 0));
});

test("Tasche: Wand und Insel laufen entgegengesetzt, das Material liegt bei beiden rechts", () => {
  const w = pocketWallPaths(big, [island], 1.5, "climb");
  const a = closedAreas(w);
  assert.ok(a.some(x => x > 0), "Wand gegen den Uhrzeigersinn");
  assert.ok(a.some(x => x < 0), "Insel im Uhrzeigersinn");
});

test("Tasche ohne Vorgabe ändert nichts an den Bahnen", () => {
  assert.deepEqual(pocketPaths(big, [island], 1.5, 1.2, "spiral").paths, pocketPaths(big, [island], 1.5, 1.2, "spiral", "").paths);
});
