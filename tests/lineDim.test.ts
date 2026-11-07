// Linie bemaßen: Stück finden und Länge ändern – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { dimSide, pickSegment, setSegmentLength } from "../src/editor/lineDim.ts";

const P = (x: number, y: number) => ({ x, y });
const near = (a: number, b: number, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const rect = [P(0, 0), P(100, 0), P(100, 50), P(0, 50)];

test("Einzelne Linie: Ende näher am Klick wandert, das andere bleibt", () => {
  const line = [P(0, 0), P(30, 40)]; // Länge 50
  const seg = pickSegment(line, false, P(25, 33))!;
  assert.equal(seg.moves, 1);
  near(seg.length, 50);
  const r = setSegmentLength(line, false, seg, 100);
  assert.deepEqual(r[0], P(0, 0));
  near(r[1].x, 60); near(r[1].y, 80);
  const left = pickSegment(line, false, P(3, 4))!;
  assert.equal(left.moves, 0);
  const r2 = setSegmentLength(line, false, left, 25);
  assert.deepEqual(r2[1], P(30, 40));
  near(r2[0].x, 15); near(r2[0].y, 20);
});

test("Schräge Linie behält ihren Winkel, auch beim Kürzen", () => {
  const line = [P(10, 10), P(40, 50)];
  const r = setSegmentLength(line, false, { i: 0, j: 1, moves: 1 }, 10);
  near(Math.hypot(r[1].x - r[0].x, r[1].y - r[0].y), 10);
  near((r[1].y - r[0].y) / (r[1].x - r[0].x), 40 / 30);
});

test("Offener Linienzug: Rest rückt starr mit", () => {
  const z = [P(0, 0), P(50, 0), P(50, 30), P(90, 30)];
  const r = setSegmentLength(z, false, { i: 0, j: 1, moves: 1 }, 70);
  assert.deepEqual(r, [P(0, 0), P(70, 0), P(70, 30), P(110, 30)]);
  const m = setSegmentLength(z, false, { i: 1, j: 2, moves: 2 }, 10);
  assert.deepEqual(m, [P(0, 0), P(50, 0), P(50, 10), P(90, 10)]);
  const b = setSegmentLength(z, false, { i: 1, j: 2, moves: 1 }, 40);
  assert.deepEqual(b[3], P(90, 30));
  assert.deepEqual(b[0], P(0, -10));
});

test("Rechteck bleibt Rechteck: gegenüberliegende Kante geht mit", () => {
  const seg = pickSegment(rect, true, P(90, 0))!;
  assert.equal(seg.moves, 1);
  assert.deepEqual(setSegmentLength(rect, true, seg, 150), [P(0, 0), P(150, 0), P(150, 50), P(0, 50)]);
  const h = pickSegment(rect, true, P(100, 40))!;
  assert.deepEqual(setSegmentLength(rect, true, h, 80), [P(0, 0), P(100, 0), P(100, 80), P(0, 80)]);
});

test("Kante über die Naht und wanderndes Ende vorn", () => {
  const seg = pickSegment(rect, true, P(0, 10))!; // Kante 3→0
  assert.equal(seg.i, 3); assert.equal(seg.j, 0); assert.equal(seg.moves, 0);
  assert.deepEqual(setSegmentLength(rect, true, seg, 80), [P(0, -30), P(100, -30), P(100, 50), P(0, 50)]);
});

test("Dreieck: Spitze dazwischen bleibt, nur das Ende wandert", () => {
  const tri = [P(0, 0), P(100, 0), P(50, 80)];
  const r = setSegmentLength(tri, true, { i: 0, j: 1, moves: 1 }, 120);
  assert.deepEqual(r, [P(0, 0), P(120, 0), P(50, 80)]);
});

test("Zwischenpunkte auf der Geraden zählen zum Stück und behalten ihren Anteil", () => {
  const line = [P(0, 0), P(25, 0), P(100, 0), P(100, 50)];
  const seg = pickSegment(line, false, P(90, 1))!;
  assert.equal(seg.i, 0); assert.equal(seg.j, 2); near(seg.length, 100);
  assert.deepEqual(setSegmentLength(line, false, seg, 200), [P(0, 0), P(50, 0), P(200, 0), P(200, 50)]);
});

test("Geschlossene Form: gerades Stück über die Naht wird als eins erkannt", () => {
  const r = [P(50, 0), P(100, 0), P(100, 50), P(0, 50), P(0, 0)];
  const seg = pickSegment(r, true, P(90, 0))!;
  assert.equal(seg.i, 4); assert.equal(seg.j, 1); near(seg.length, 100);
  assert.deepEqual(setSegmentLength(r, true, seg, 150), [P(75, 0), P(150, 0), P(150, 50), P(0, 50), P(0, 0)]);
});

test("Ungültiges: Länge 0, keine Punkte, Eingabe bleibt unberührt", () => {
  assert.equal(pickSegment([P(1, 1)], false, P(0, 0)), null);
  assert.equal(pickSegment([P(1, 1), P(1, 1)], false, P(0, 0)), null);
  const r = setSegmentLength(rect, true, { i: 0, j: 1, moves: 1 }, 0);
  assert.deepEqual(r, rect);
  assert.notEqual(r, rect);
  const copy = JSON.stringify(rect);
  setSegmentLength(rect, true, { i: 0, j: 1, moves: 1 }, 300);
  assert.equal(JSON.stringify(rect), copy);
});

test("Maßlinie liegt außerhalb: rechts von der Fahrtrichtung bei gegen den Uhrzeigersinn", () => {
  assert.equal(dimSide(rect, true), -1);
  assert.equal(dimSide([...rect].reverse(), true), 1);
  assert.equal(dimSide([P(0, 0), P(1, 0)], false), 1);
});
