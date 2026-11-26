// Getippte Maße beim Zeichnen – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { calc, fieldsFor, lockPoint, typedAngle, typedLen } from "../src/editor/typedValues.ts";

const near = (a: number, b: number, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const P = (x: number, y: number) => ({ x, y });

test("Rechner: Grundrechenarten, Klammern, Komma, Vorzeichen", () => {
  near(calc("100/4"), 25);
  near(calc("2*(40+5)"), 90);
  near(calc("12,5"), 12.5);
  near(calc("-3+10"), 7);
  near(calc(" 1 + 2 * 3 "), 7);
  near(calc(".5"), 0.5);
  near(calc("3x4"), 12);
});

test("Rechner: Unsinn ergibt NaN, kein Code wird ausgeführt", () => {
  assert.ok(Number.isNaN(calc("")));
  assert.ok(Number.isNaN(calc("abc")));
  assert.ok(Number.isNaN(calc("(1+2")));
  assert.ok(Number.isNaN(calc("1/0")));
  assert.ok(Number.isNaN(calc("alert(1)")));
  assert.ok(Number.isNaN(calc("2++")));
});

test("Längen: eingestellte Einheit, Einheit dahinter gewinnt", () => {
  near(typedLen("120", false), 120);
  near(typedLen("2", true), 50.8);
  near(typedLen("2cm", false), 20);
  near(typedLen("10mm", true), 10);
  near(typedLen("1/2\"", false), 12.7);
  near(typedLen("1 1/2", true), 38.1);
  near(typedLen("100/3", false), 100 / 3);
  assert.ok(Number.isNaN(typedLen("", false)));
  assert.ok(Number.isNaN(typedLen("x", false)));
});

test("Winkel: Grad, ° erlaubt, gerechnet", () => {
  near(typedAngle("45"), 45);
  near(typedAngle("30°"), 30);
  near(typedAngle("90/2"), 45);
});

test("Felder je Werkzeug", () => {
  assert.deepEqual(fieldsFor("line")!.map(f => f.kind), ["len", "angle"]);
  assert.deepEqual(fieldsFor("rect")!.map(f => f.key), ["typed.w", "typed.h"]);
  assert.deepEqual(fieldsFor("ring")!.map(f => f.key), ["typed.dia", "typed.angle"]);
  assert.equal(fieldsFor("select"), null);
  assert.equal(fieldsFor("text"), null);
});

test("Linie: Länge getippt, Richtung von der Maus", () => {
  const p = lockPoint("line", P(10, 10), P(20, 10), { a: 120 });
  near(p.x, 130); near(p.y, 10);
});

test("Linie: Länge und Winkel getippt – Maus egal", () => {
  const p = lockPoint("line", P(0, 0), P(-500, 3), { a: 100, b: 90 });
  near(p.x, 0); near(p.y, 100);
});

test("Linie: nur Winkel getippt – Länge = Maus auf die Richtung projiziert", () => {
  const p = lockPoint("line", P(0, 0), P(30, 7), { b: 0 });
  near(p.x, 30); near(p.y, 0);
});

test("Ohne Werte bleibt die Maus", () => {
  assert.deepEqual(lockPoint("line", P(0, 0), P(3, 4), {}), P(3, 4));
});

test("Rechteck: Breite und Höhe, Richtung aus der Maus", () => {
  assert.deepEqual(lockPoint("rect", P(0, 0), P(-5, 5), { a: 200, b: 80 }), P(-200, 80));
  assert.deepEqual(lockPoint("rect", P(0, 0), P(5, -5), { a: 200 }), P(200, -5));
});

test("Rechteck von der Mitte: halbe Maße zur Ecke", () => {
  assert.deepEqual(lockPoint("rect", P(10, 10), P(20, 20), { a: 100, b: 40 }, true), P(60, 30));
});

test("Polygon: Durchmesser und Winkel", () => {
  const p = lockPoint("polygon", P(0, 0), P(1, 1), { a: 50, b: 180 });
  near(p.x, -25); near(p.y, 0);
  const q = lockPoint("ring", P(0, 0), P(0, 3), { a: 20 });
  near(q.x, 0); near(q.y, 10);
});
