// Befehlszeile: Befehle und getippte Punkte – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { aliasesOf, parseCommand, parsePoint } from "../src/editor/cmdParse.ts";

const near = (a: number, b: number, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const at = (p: { x: number; y: number } | null, x: number, y: number) => { assert.ok(p, "kein Punkt"); near(p!.x, x); near(p!.y, y); };

test("Befehle: Kurzformen, Groß/klein, Unterstrich", () => {
  assert.equal(parseCommand("L"), "line");
  assert.equal(parseCommand("line"), "line");
  assert.equal(parseCommand("_LINE"), "line");
  assert.equal(parseCommand("rec"), "rect");
  assert.equal(parseCommand("C"), "circle");
  assert.equal(parseCommand("co"), "copy");
  assert.equal(parseCommand("m"), "move");
  assert.equal(parseCommand("?"), "help");
  assert.equal(parseCommand("quatsch"), null);
  assert.equal(parseCommand(""), null);
  assert.ok(aliasesOf("line").includes("L"));
});

test("Absolute Punkte: Komma, Semikolon, Leerzeichen", () => {
  at(parsePoint("100,50", null, null, false), 100, 50);
  at(parsePoint("12,5;7,5", null, null, false), 12.5, 7.5);
  at(parsePoint("100 50", null, null, false), 100, 50);
  at(parsePoint("-10,-20", null, null, false), -10, -20);
  at(parsePoint("100/4, 2*10", null, null, false), 25, 20);
});

test("Relative Punkte mit @", () => {
  const last = { x: 10, y: 10 };
  at(parsePoint("@30,0", last, null, false), 40, 10);
  at(parsePoint("@0,-5", last, null, false), 10, 5);
  at(parsePoint("@", last, null, false), 10, 10);
  assert.equal(parsePoint("@30,0", null, null, false), null); // ohne letzten Punkt geht @ nicht
});

test("Polar: Länge<Winkel, relativ und absolut", () => {
  at(parsePoint("@100<90", { x: 5, y: 5 }, null, false), 5, 105);
  at(parsePoint("@10<180", { x: 0, y: 0 }, null, false), -10, 0);
  at(parsePoint("20<0", { x: 50, y: 50 }, null, false), 20, 0);
  const p = parsePoint("@100<45", { x: 0, y: 0 }, null, false)!;
  near(p.x, 100 * Math.SQRT1_2); near(p.y, 100 * Math.SQRT1_2);
});

test("Eine Zahl: so weit Richtung Maus, nur mit letztem Punkt", () => {
  at(parsePoint("80", { x: 0, y: 0 }, Math.PI / 2, false), 0, 80);
  at(parsePoint("100/2", { x: 10, y: 0 }, 0, false), 60, 0);
  assert.equal(parsePoint("80", null, null, false), null);
});

test("Einheiten: Zoll eingestellt, Einheit dahinter gewinnt", () => {
  at(parsePoint("1,2", null, null, true), 25.4, 50.8);
  at(parsePoint("10mm,1in", null, null, false), 10, 25.4);
  at(parsePoint("@2cm<0", { x: 0, y: 0 }, null, false), 20, 0);
});

test("Unsinn ergibt keinen Punkt", () => {
  assert.equal(parsePoint("", null, null, false), null);
  assert.equal(parsePoint("abc", { x: 0, y: 0 }, 0, false), null);
  assert.equal(parsePoint("1,2,3", null, null, false), null);
  assert.equal(parsePoint("@x<45", { x: 0, y: 0 }, null, false), null);
  assert.equal(parsePoint("10<", { x: 0, y: 0 }, null, false), null);
});

test("Bedingungs-Wörter", async () => {
  const { parseConKind } = await import("../src/editor/cmdParse.ts");
  assert.equal(parseConKind("HOR"), "h");
  assert.equal(parseConKind("perp"), "perp");
  assert.equal(parseConKind("Coin"), "coin");
  assert.equal(parseConKind("L"), null);
});
