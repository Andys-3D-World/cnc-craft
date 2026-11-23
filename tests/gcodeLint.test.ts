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

test("kaputte Werte: Wörter im Kommentar („Z neu nullen“) sind kein Fehler", () => {
  const ok = "G21\nG90\nG0 Z5\nM3 S10000\nM0 (WERKZEUGWECHSEL 2: 6 mm einsetzen, Z neu nullen)\nG0 X10 Y10\nM5\nM30";
  assert.deepEqual(rules(ok, "mill"), {});
  assert.ok(rules("G21\nG90\nG0 Xnull Y5\nM30", "mill")["broken-value"]);
  assert.ok(rules("G21\nG90\nG0 X5 YNaN\nM30", "mill")["broken-value"]);
  assert.ok(rules("G21\nG90\n(Form undefined)\nM30", "mill")["broken-value"]);
  assert.ok(rules("G21\nG90\n(tool [object Object])\nM30", "mill")["broken-value"]);
});

// ---- Laser: Bildgravur fährt mit Absicht mit S0, eine Kontur mit Leistung 0 ist ein Fehler ----
const laserJob = (body: string) => `G21\nG90\nM4 S0\nF3000\n${body}\nS0\nM5\nG0 X0 Y0 S0\nM30`;
const zeroLines = (c: string, extra = {}) => lintGcode(c, { kind: "laser", ...extra }).filter(i => i.rule === "cut-power-zero").map(i => i.line);

test("Laser: Bildzeile mit Überfahren und weißer Stelle ergibt keine Meldung (hin und zurück)", () => {
  // Bild von X10 bis X30, 2 mm Überfahren, weiß von X18 bis X22; zweite Zeile von rechts nach links
  const rows = [
    "G0 X8 Y10 S0", "G1 X10 S0", "G1 X18 S800", "G1 X22 S0", "G1 X30 S800", "G1 X32 S0",
    "G0 Y10.1 S0", "G1 X30 S0", "G1 X22 S800", "G1 X18 S0", "G1 X10 S800", "G1 X8 S0",
  ].join("\n");
  assert.deepEqual(rules(laserJob(rows), "laser"), {});
  // Graustufen: Leistung wechselt in der Zeile, dazwischen weiß
  const gray = ["G0 X8 Y10 S0", "G1 X10 S0", "G1 X10.1 S120", "G1 X10.2 S640", "G1 X14 S0", "G1 X14.1 S15", "G1 X30 S1000", "G1 X32 S0"].join("\n");
  assert.deepEqual(rules(laserJob(gray), "laser"), {});
  // ohne Überfahren (0 mm): „G1 S0“ ohne Weg, die Zeile beginnt mit einem Bildpunkt von 0,1 mm
  assert.deepEqual(rules(laserJob("G0 X10 Y10 S0\nG1 S0\nG1 X10.1 S800\nG1 X25 S0\nG1 X30 S800\nG1 S0"), "laser"), {});
  // mit M3 (feste Leistung) genauso
  assert.deepEqual(rules(laserJob(rows).replace("M4 S0", "M3 S0"), "laser"), {});
});

test("Laser: Bildzeile eines gedrehten Bildes (schräg, auf 0,001 mm gerundet) ergibt keine Meldung", () => {
  // Richtung 30°: (0,866025 | 0,5). Start (10 | 10), erster Bildpunkt nur 0,1 mm lang, weiß bis 100 mm, dann wieder ein Punkt
  const up = "G0 X10 Y10 S0\nG1 S0\nG1 X10.087 Y10.05 S500\nG1 X96.603 Y60 S0\nG1 X96.689 Y60.05 S500\nG1 X98.421 Y61.05 S0";
  // Rückweg, eine Zeile weiter (0,1 mm quer zur Zeile: −0,05 | +0,087)
  const back = "G0 X98.371 Y61.137 S0\nG1 X96.639 Y60.137 S0\nG1 X96.553 Y60.087 S500\nG1 X10.037 Y10.137 S0\nG1 X9.95 Y10.087 S500\nG1 X8.218 Y9.087 S0";
  assert.deepEqual(rules(laserJob(up + "\n" + back), "laser"), {});
});

test("Laser: Bildzeile in Zoll (G20) ergibt keine Meldung", () => {
  const c = "G20\nG90\nM4 S0\nF100\nG0 X0.3 Y0.4 S0\nG1 X0.4 S0\nG1 X0.7 S800\nG1 X0.9 S0\nG1 X1.2 S800\nG1 X1.3 S0\nS0\nM5\nM30";
  assert.deepEqual(rules(c, "laser"), {});
});

test("Laser: Kontur mit Leistung 0 wird weiter gemeldet", () => {
  // Ebene auf 0 %: Quadrat, S0 steht nur an der ersten Fahrt und gilt für alle vier (Zeilen 6 bis 9)
  assert.deepEqual(zeroLines(laserJob("G0 X10 Y10 S0\nG1 X30 Y10 S0\nG1 X30 Y30\nG1 X10 Y30\nG1 X10 Y10")), [6, 7, 8, 9]);
  // offene gerade Linie mit 0 %: gerade, aber nirgends Leistung
  assert.deepEqual(zeroLines(laserJob("G0 X10 Y10 S0\nG1 X30 Y10 S0\nG1 X50 Y10")), [6, 7]);
  // Füllen mit 0 %: jede Linie ist gerade, aber ohne Leistung
  assert.deepEqual(zeroLines(laserJob("G0 X10 Y10 S0\nG1 X30 Y10 S0\nG0 X30 Y10.1 S0\nG1 X10 Y10.1 S0")), [6, 8]);
  // Kontur mit Haltesteg bei 0 %: beide Stücke
  assert.deepEqual(zeroLines(laserJob("G0 X10 Y10 S0\nG1 X20 Y10 S0\nG1 X20 Y20\nG0 X20 Y22 S0\nG1 X20 Y30 S0\nG1 X10 Y30")), [6, 7, 9, 10]);
  // Bogen mit Leistung 0
  assert.deepEqual(zeroLines(laserJob("G0 X10 Y10 S0\nG2 X20 Y10 I5 J0 S0")), [6]);
});

test("Laser: S0 zählt nur in einer geraden Zeile mit Leistung als gewollt", () => {
  // Kontur mit Leistung, eine Seite mit S0: keine Gerade -> diese Seite wird gemeldet
  assert.deepEqual(zeroLines(laserJob("G0 X10 Y10 S0\nG1 X30 Y10 S800\nG1 X30 Y30 S0\nG1 X10 Y30 S800\nG1 X10 Y10")), [7]);
  // Überfahren, dann knickt die Bahn ab (kein Bildzeilen-Muster)
  assert.deepEqual(zeroLines(laserJob("G0 X8 Y10 S0\nG1 X10 S0\nG1 X30 Y30 S800")), [6]);
  // S0 hin, mit Leistung auf derselben Linie zurück: keine Zeile in einer Richtung
  assert.deepEqual(zeroLines(laserJob("G0 X0 Y10 S0\nG1 X20 S0\nG1 X10 S800")), [6]);
  // Leistung erst nach einer Eilfahrt, einem M-Befehl oder einer Z-Fahrt: gehört nicht mehr zur selben Zeile
  assert.deepEqual(zeroLines(laserJob("G0 X8 Y10 S0\nG1 X10 S0\nG0 X10 Y10\nG1 X30 S800")), [6]);
  assert.deepEqual(zeroLines(laserJob("G0 X8 Y10 S0\nG1 X10 S0\nM8\nG1 X30 S800")), [6]);
  assert.deepEqual(zeroLines(laserJob("G0 X8 Y10 Z0 S0\nG1 X10 S0\nG1 Z-1\nG1 X30 S800")), [6]);
  // Bild richtig, die Kontur danach mit 0 %: nur die Kontur
  const img = "G0 X8 Y10 S0\nG1 X10 S0\nG1 X30 S800\nG1 X32 S0";
  assert.deepEqual(zeroLines(laserJob(img + "\nG0 X10 Y40 S0\nG1 X30 Y40 S0\nG1 X30 Y60\nG1 X10 Y40")), [10, 11, 12]);
});

test("Laser: Meldungen bleiben nach Zeilen geordnet (die erste nennt „Zur Maschine“)", () => {
  // Zeile 6 (S0) wird erst am Ende des Zugs gemeldet, Zeile 7 (außerhalb des Betts) sofort
  const list = lintGcode(laserJob("G0 X8 Y10 S0\nG1 X10 S0\nG1 X30 Y30 S800"), { kind: "laser", bedW: 20, bedH: 100 });
  assert.deepEqual(list.map(i => [i.rule, i.line]), [["cut-power-zero", 6], ["off-bed", 7]]);
});
