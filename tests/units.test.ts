// Tests für mm/Zoll (Anzeigen, Lesen, Texte) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLen, fmtLen, fmtLenU, fmtLenShort, fmtFeed, fmtSpeed, unitName, toDisplay, fromDisplay, mmToField, fieldToMm, mmText,
  inchStep, unitTemplate, unitLabel, labelKind, convertNumberText, setUnit, getUnit, isInch, onUnitChange, inchDecimals,
  jogStepsMm, jogStepLabels, jogStepIndex, reportsInches, fmtDia, fmtLong, asLength
} from "../src/units.ts";

test("Standard ist mm, und in mm wird nichts verändert", () => {
  assert.equal(getUnit(), "mm");
  assert.equal(fmtLen(12.7), "12.70");
  assert.equal(fmtLenU(12.7, 1), "12.7 mm");
  assert.equal(fmtFeed(1000), "1000 mm/min");
  assert.equal(mmToField("12.50"), "12.50");
  assert.equal(parseLen("12.5"), 12.5);
  assert.equal(unitTemplate("{w} × {h} mm", { w: 600, h: 400 }), "{w} × {h} mm");
  assert.equal(unitLabel("Breite (mm)"), "Breite (mm)");
});

test("Zoll zeigen: zwei Stellen mehr als mm", () => {
  assert.equal(fmtLen(25.4, 2, "in"), "1.0000");
  assert.equal(fmtLen(12.7, 1, "in"), "0.500");
  assert.equal(fmtLenShort(12.7, 2, "in"), "0.5");
  assert.equal(fmtLenU(300, 0, "in"), "11.81 in");
  assert.equal(fmtFeed(1000, 0, "in"), "39.37 in/min");
  assert.equal(fmtSpeed(100, 0, "in"), "3.94 in/s");
  assert.equal(inchDecimals(3), 5);
  assert.equal(inchDecimals(9), 5);
  assert.equal(unitName("mm", "in"), "in");
  assert.equal(unitName("mm/min", "in"), "in/min");
  assert.equal(unitName("mm/s", "in"), "in/s");
  assert.equal(unitName("mm/min", "mm"), "mm/min");
  assert.equal(toDisplay(50.8, "in"), 2);
});

test("Zoll lesen ergibt genaue Millimeter ohne Rechen-Rauschen", () => {
  assert.equal(parseLen("1", "in"), 25.4);
  assert.equal(parseLen("0.1", "in"), 2.54);
  assert.equal(parseLen("0.25", "in"), 6.35);
  assert.equal(parseLen("0,5", "in"), 12.7);
  assert.equal(parseLen(".5", "in"), 12.7);
  assert.equal(parseLen("-2", "in"), -50.8);
  assert.equal(parseLen("0.001", "in"), 0.0254);
  assert.equal(fromDisplay(0.3, "in"), 7.62);
});

test("Brüche und Einheit hinter der Zahl", () => {
  assert.equal(parseLen("1/4", "in"), 6.35);
  assert.equal(parseLen("1 1/2", "in"), 38.1);
  assert.equal(parseLen("1-1/2", "in"), 38.1);
  assert.equal(parseLen("-3/8", "in"), -9.525);
  assert.equal(parseLen("1/4", "mm"), 0.25);
  assert.equal(parseLen("6mm", "in"), 6);
  assert.equal(parseLen("6 mm", "in"), 6);
  assert.equal(parseLen("2cm", "in"), 20);
  assert.equal(parseLen("0.25in", "mm"), 6.35);
  assert.equal(parseLen('0.25"', "mm"), 6.35);
  assert.equal(parseLen("1/4 inch", "mm"), 6.35);
  assert.equal(parseLen("3 Zoll", "mm"), 76.2);
});

test("Unsinn ist keine Zahl (nie still eine falsche Länge)", () => {
  for (const bad of ["", " ", "abc", "1/0", "1/", "1..2", "1,2,3", "1.234,5", "12 13", "mm", "in", "1e3", "--1", "1/2/3", "5 ft"])
    assert.ok(Number.isNaN(parseLen(bad, "in")), bad);
  assert.equal(fieldToMm("abc", "in"), "");
  assert.equal(fieldToMm("", "in"), "");
});

test("Felder: mm -> Zoll-Anzeige -> mm", () => {
  assert.equal(mmToField("25.4", "in"), "1");
  assert.equal(mmToField("12.70", "in"), "0.5");
  assert.equal(mmToField("3", "in"), "0.1181");
  assert.equal(mmToField("-2.0", "in"), "-0.0787");
  assert.equal(mmToField("", "in"), "");
  assert.equal(mmToField("0", "in"), "0");
  assert.equal(fieldToMm("0.5", "in"), "12.7");
  assert.equal(fieldToMm("1/8", "in"), "3.175");
  assert.equal(fieldToMm("6mm", "in"), "6");
  assert.equal(mmText(0.1 + 0.2), "0.3");
  assert.equal(mmText(-0), "0");
  assert.equal(mmText(NaN), "");
});

test("Getippte Zoll-Werte wandern nicht: tippen, zeigen, wieder lesen", () => {
  for (const typed of ["0.5", "0.125", "1", "2.75", "0.0625", "10", "0.001", "23.622"]) {
    const mm = fieldToMm(typed, "in");
    assert.equal(mmToField(mm, "in"), typed, typed);
    // und noch einmal im Kreis: bleibt gleich
    assert.equal(fieldToMm(mmToField(mm, "in"), "in"), mm, typed);
  }
});

test("Schrittweite der Pfeiltasten in Zoll ist rund", () => {
  assert.equal(inchStep(1), 0.05);
  assert.equal(inchStep(0.5), 0.025);
  assert.equal(inchStep(0.1), 0.005);
  assert.equal(inchStep(0.05), 0.0025);
  assert.equal(inchStep(0.01), 0.0005);
  assert.equal(inchStep(10), 0.5);
  assert.equal(inchStep(100), 5);
  assert.equal(inchStep(0), 0.05);
  assert.equal(inchStep(NaN), 0.05);
});

test("Meldungen: Platzhalter direkt vor der Einheit werden zusammen mit ihr umgestellt", () => {
  const u = (tpl: string, p: Record<string, string | number>) => unitTemplate(tpl, p, "in");
  assert.equal(u("Bett {b} mm", { b: 300 }), "Bett 11.81 in");
  assert.equal(u("{n} Teile · außen {w} × {d} × {h} mm", { n: 6, w: 100, d: 50.8, h: 25.4 }), "{n} Teile · außen 3.94 × 2 × 1 in");
  assert.equal(u("Größe X {x} × Y {y} × Z {z} mm", { x: "254.0", y: "127.0", z: "12.7" }), "Größe X 10 × Y 5 × Z 0.5 in");
  assert.equal(u("Vorschub {f} mm/min", { f: 1000 }), "Vorschub 39.37 in/min");
  assert.equal(u("{v} mm/s", { v: 100 }), "3.94 in/s");
  assert.equal(u("(Ø {d} mm)", { d: 6.35 }), "(Ø 0.25 in)");
  assert.equal(u("(Ø{d} mm)", { d: 6.35 }), "(Ø0.25 in)");
  assert.equal(u("Z ({min} … {max} mm)", { min: "-0.25", max: "0.51" }), "Z (-0.00984 … 0.0201 in)");
  assert.equal(u("{a}–{b} mm", { a: 1, b: 2 }), "0.0394–0.0787 in");
  assert.equal(u("{v} mm", { v: "12,7" }), "0,5 in");
  assert.equal(u("{v}mm breit", { v: 25.4 }), "1in breit");
  assert.equal(u("Ø {d} mm · {z} mm/Durchgang · F{f}", { d: 3, z: 1.5, f: 1200 }), "Ø 0.118 in · 0.0591 in/Durchgang · F{f}");
  assert.equal(u("{fz} mm/Zahn", { fz: "0.05" }), "0.00197 in/Zahn");
});

test("Meldungen: im Zweifel bleibt die ganze Stelle in mm", () => {
  const u = (tpl: string, p: Record<string, string | number>) => unitTemplate(tpl, p, "in");
  // kein schlichter Zahlenwert
  assert.equal(u("{v} mm", { v: "3–5" }), "{v} mm");
  assert.equal(u("{w} × {h} mm", { w: 100, h: "?" }), "{w} × {h} mm");
  assert.equal(u("{v} mm", {}), "{v} mm");
  // feste Zahlen im Text bleiben mm
  assert.equal(u("z. B. 0,2 mm, Form {n}", { n: 3 }), "z. B. 0,2 mm, Form {n}");
  // andere Einheiten
  assert.equal(u("{a} mm²", { a: 100 }), "{a} mm²");
  assert.equal(u("{a} mm/s²", { a: 100 }), "{a} mm/s²");
  assert.equal(u("{a} mmHg", { a: 100 }), "{a} mmHg");
  // Kette geht links mit etwas Unbekanntem weiter: nichts anfassen (sonst stünde eine mm-Zahl neben „in“)
  assert.equal(u("{n} Stück à 3 × {h} mm", { n: 2, h: 10 }), "{n} Stück à 3 × {h} mm");
  assert.equal(u("5–{b} mm", { b: 10 }), "5–{b} mm");
  // Platzhalter ohne Einheit bleibt für t()
  assert.equal(u("Form {n}: Steg ({h} mm)", { n: 2, h: 1.5 }), "Form {n}: Steg (0.0591 in)");
});

test("Zahlen-Text umrechnen", () => {
  assert.equal(convertNumberText(600), "23.62");
  assert.equal(convertNumberText("0.3"), "0.0118");
  assert.equal(convertNumberText(3), "0.118");
  assert.equal(convertNumberText(0), "0");
  assert.equal(convertNumberText("12,70"), "0,5");
  assert.equal(convertNumberText("−25.4"), "-1");
  assert.equal(convertNumberText("1e3"), null);
  assert.equal(convertNumberText("3-5"), null);
  assert.equal(convertNumberText(""), null);
});

test("Beschriftungen: nur Einheiten ohne Zahl", () => {
  assert.equal(unitLabel("Breite (mm)", "in"), "Breite (in)");
  assert.equal(unitLabel("Vorschub (mm/min)", "in"), "Vorschub (in/min)");
  assert.equal(unitLabel("Tempo (mm/s)", "in"), "Tempo (in/s)");
  assert.equal(unitLabel("Höhe (mm, Großbuchstaben)", "in"), "Höhe (in, Großbuchstaben)");
  assert.equal(unitLabel("mm", "in"), "in");
  assert.equal(unitLabel(" mm", "in"), " in");
  assert.equal(unitLabel("mm/min", "in"), "in/min");
  assert.equal(unitLabel("Schritte pro mm", "in"), null);
  assert.equal(unitLabel("Fase 2 mm", "in"), null);
  assert.equal(unitLabel("Linien/mm", "in"), null);
  assert.equal(unitLabel("(mm²)", "in"), null);
  assert.equal(labelKind("Breite (mm)"), "mm");
  assert.equal(labelKind("mm/min"), "mm/min");
  assert.equal(labelKind("Tempo (mm/s)"), "mm/s");
  assert.equal(labelKind("Weg (mm) bei (mm/min)"), null);
  assert.equal(labelKind("Anzahl"), null);
});

test("Jog-Schritte: zur Maschine gehen immer Millimeter", () => {
  assert.deepEqual(jogStepsMm("mm"), [0.1, 1, 10, 100]);
  assert.deepEqual(jogStepLabels("mm"), ["0.1", "1mm", "10mm", "100"]);
  // 0.001 / 0.01 / 0.1 / 1 Zoll, als Millimeter
  assert.deepEqual(jogStepsMm("in"), [0.0254, 0.254, 2.54, 25.4]);
  assert.deepEqual(jogStepLabels("in"), ["0.001", "0.01", "0.1in", "1in"]);
  // Beschriftung und Wert gehören zusammen: die Zahl auf dem Knopf mal 25,4 ist der Schritt in mm
  jogStepLabels("in").forEach((name, i) => assert.equal(parseLen(name.replace("in", ""), "in"), jogStepsMm("in")[i]));
  jogStepLabels("mm").forEach((name, i) => assert.equal(parseLen(name.replace("mm", ""), "mm"), jogStepsMm("mm")[i]));
  // Umschalten: gewählt wird der größte Schritt, der nicht größer ist als der bisherige
  assert.equal(jogStepsMm("mm")[jogStepIndex(25.4, "mm")], 10);    // 1 in -> 10 mm (nicht 100)
  assert.equal(jogStepsMm("mm")[jogStepIndex(2.54, "mm")], 1);     // 0.1 in -> 1 mm
  assert.equal(jogStepsMm("mm")[jogStepIndex(0.254, "mm")], 0.1);  // 0.01 in -> 0,1 mm
  assert.equal(jogStepsMm("mm")[jogStepIndex(0.0254, "mm")], 0.1); // kleiner geht nicht: kleinster Knopf
  assert.equal(jogStepsMm("in")[jogStepIndex(100, "in")], 25.4);   // 100 mm -> 1 in
  assert.equal(jogStepsMm("in")[jogStepIndex(10, "in")], 2.54);    // 10 mm -> 0.1 in
  assert.equal(jogStepsMm("in")[jogStepIndex(1, "in")], 0.254);    // 1 mm -> 0.01 in
  assert.equal(jogStepsMm("in")[jogStepIndex(0.1, "in")], 0.0254); // 0,1 mm -> 0.001 in
  for (const u of ["mm", "in"] as const) for (const prev of [0.0254, 0.1, 0.254, 1, 2.54, 10, 25.4, 100]) {
    const next = jogStepsMm(u)[jogStepIndex(prev, u)];
    assert.ok(next <= prev || next === jogStepsMm(u)[0], `${prev} -> ${next}`);
  }
  // der größte Zoll-Schritt ist kleiner als der größte mm-Schritt: Umschalten macht nie einen größeren Sprung möglich
  assert.ok(Math.max(...jogStepsMm("in")) < Math.max(...jogStepsMm("mm")));
});

test("$13: nur der Wert 1 heißt, dass die Steuerung in Zoll meldet", () => {
  for (const v of ["1", "1.000", " 1 "]) assert.equal(reportsInches(v), true, v);
  for (const v of ["0", "0.000", "", "2", "abc", undefined, null]) assert.equal(reportsInches(v as any), false, String(v));
});

test("Listen: Durchmesser, lange Strecken, markierte Vorlagen", () => {
  assert.equal(fmtDia(3, "mm"), "Ø3");
  assert.equal(fmtDia(3.175, "mm"), "Ø3.18");
  assert.equal(fmtDia(3.175, "in"), "Ø0.125 in");
  assert.equal(fmtLong(12340, "mm"), "12.34 m");
  assert.equal(fmtLong(3048, "in"), "10.00 ft");
  assert.equal(asLength('<label>Ø<input id="a" type="number"></label>'), '<label>Ø<input data-unit="mm" id="a" type="number"></label>');
  assert.equal(asLength("<input x>", "mm/min"), '<input data-unit="mm/min" x>');
});

test("Umschalten meldet sich und lässt sich zurückstellen", () => {
  const seen: string[] = [];
  const off = onUnitChange(u => seen.push(u));
  setUnit("in");
  assert.equal(isInch(), true);
  assert.equal(fmtLenU(25.4), "1.0000 in");
  assert.equal(parseLen("1"), 25.4);
  setUnit("in");
  setUnit("mm");
  off();
  setUnit("in");
  setUnit("mm");
  assert.deepEqual(seen, ["in", "mm"]);
  assert.equal(fmtLenU(25.4), "25.40 mm");
});
