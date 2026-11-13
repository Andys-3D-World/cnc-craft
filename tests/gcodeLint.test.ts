// G-Code-Prüfer – läuft mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { lintGcode, lintSummary } from "../src/gcodeLint.ts";

const rules = (c: string, kind: "mill" | "laser" | "plasma", extra = {}) => lintSummary(lintGcode(c, { kind, ...extra }));

const goodMill = "G21\nG90\nG0 Z5\nM3 S10000\nG0 X10 Y10\nG1 Z-2 F300\nG1 X20 F1000\nG0 Z5\nM5\nM30";
const goodLaser = "G21\nG90\nM4 S0\nG0 X5 Y5\nG1 X20 S800 F1500\nM5\nM30";
const goodPlasma = "G21\nG90\nG0 X5 Y5\nM3\nG1 X20 F2000\nM5\nG0 X0 Y0\nM30";

test("sauberer G-Code ergibt keine Meldung", () => {
  assert.deepEqual(rules(goodMill, "mill"), {});
  assert.deepEqual(rules(goodLaser, "laser"), {});
  assert.deepEqual(rules(goodPlasma, "plasma"), {});
});

test("Fräse: Eilfahrt im Material, Spindel aus, kein Vorschub", () => {
  assert.ok(rules("G21\nM3\nG1 Z-2 F100\nG0 X10\nM5\nM30", "mill")["rapid-in-material"]);
  assert.ok(rules("G21\nG0 Z-1\nM30", "mill")["rapid-into-material"]);
  // Bohren in Stufen: zurück ins schon gebohrte Loch ist erlaubt, tiefer als gebohrt nicht
  assert.equal(rules("G21\nM3\nG0 X5 Y5\nG1 Z-2 F100\nG0 Z1\nG0 Z-1.5\nG1 Z-3 F100\nG0 Z5\nM5\nM30", "mill")["rapid-into-material"], undefined);
  assert.ok(rules("G21\nM3\nG0 X5 Y5\nG1 Z-2 F100\nG0 Z1\nG0 Z-3\nM5\nM30", "mill")["rapid-into-material"]);
  assert.ok(rules("G21\nG1 Z-2 F100\nM30", "mill")["cut-spindle-off"]);
  assert.ok(rules("G21\nM3\nG1 X5\nM5\nM30", "mill")["cut-without-feed"]);
});

test("Laser: Schneiden ohne Strahl, S zu groß, am Ende noch an", () => {
  assert.ok(rules("G21\nG1 X5 S100 F100\nM30", "laser")["cut-tool-off"]);
  assert.ok(rules("G21\nM4 S0\nG1 X5 F100\nM5\nM30", "laser")["cut-power-zero"]);
  assert.ok(rules("G21\nM4 S2000\nG1 X5 F100\nM5\nM30", "laser")["s-out-of-range"]);
  assert.ok(rules("G21\nM4 S100\nG1 X5 F100\nM30", "laser")["end-tool-on"]);
});

test("Plasma: Eilfahrt mit brennendem Brenner", () => {
  assert.ok(rules("G21\nG0 X1\nM3\nG1 X2 F100\nG0 X50\nM5\nM30", "plasma")["rapid-torch-on"]);
});

test("Text: kaputte Zahlen, Umlaute, Klammern, lange Zeilen, kein Ende", () => {
  assert.ok(rules("G1 X NaN\nM30", "mill")["broken-value"]);
  assert.ok(rules("(Größe)\nM30", "mill")["not-ascii"]);
  assert.ok(rules("(a(b))\nM30", "mill")["bad-comment"]);
  assert.equal(rules("(a) (b)\nM30", "mill")["bad-comment"], undefined);
  assert.equal(rules("(" + "x".repeat(120) + ")\nM30", "mill")["line-too-long"], undefined);
  assert.ok(rules("G0 X" + "1".repeat(90) + "\nM30", "mill")["line-too-long"]);
  assert.ok(rules("G0 X1", "mill")["no-end"]);
  assert.ok(rules("M30\nG0 X1", "mill")["after-end"]);
});

test("Bett: außerhalb wird gemeldet, Nullpunkt-Befehl G10 nicht", () => {
  assert.ok(rules("G21\nG0 X400 Y0\nM30", "mill", { bedW: 300, bedH: 300 })["off-bed"]);
  assert.deepEqual(rules("G21\nG10 L20 P0 X400 Y0\nG0 X0 Y0\nM30", "mill", { bedW: 300, bedH: 300 }), {});
});

test("Lesen der Zeile: mehrere G-Befehle, Kommentar mit Semikolon, Kleinbuchstaben", () => {
  // mehrere Bewegungsarten in einer Zeile: die höchste Nummer gilt (G1), also Schneiden mit ausgeschaltetem Laser
  assert.ok(rules("G21\nG0 G1 X5 Y5 F1000\nM30", "laser")["cut-tool-off"]);
  // ";" im Kommentar und dahinter ein Befehl: der Befehl zählt, der Kommentar nicht
  assert.deepEqual(rules("G21\nG90\nM3 S1000\n(a;b) G0 X5 Y5\nG1 Z-1 F100\nG0 Z5\nM5\nM30", "mill"), {});
  // Kleinbuchstaben werden wie Großbuchstaben gelesen
  assert.ok(rules("g21\nm3\ng1 z-2 f100\ng0 x10\nm5\nm30", "mill")["rapid-in-material"]);
  // Eintauchen ohne X/Y-Angabe gilt am letzten Punkt: zurück ins gebohrte Loch ist erlaubt
  assert.equal(rules("G21\nM3\nG0 X5 Y5\nG1 Z-2 F100\nG0 Z1\nG0 X9\nG0 X5\nG0 Z-1.5\nG0 Z5\nM5\nM30", "mill")["rapid-into-material"], undefined);
  assert.ok(rules("G21\nM3\nG0 X5 Y5\nG1 Z-2 F100\nG0 Z1\nG0 X9\nG0 Z-1.5\nM5\nM30", "mill")["rapid-into-material"]);
});
