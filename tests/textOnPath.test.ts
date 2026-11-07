// Text auf Pfad – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutOnPath, orientPath, pathWalker, type Glyph, type OnPathOptions } from "../src/editor/textOnPath.ts";

const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
/** Kästchen-Buchstabe: Breite 8, Höhe 10, ab x */
const box = (x: number): Glyph => ({ loops: [[{ x, y: 0 }, { x: x + 8, y: 0 }, { x: x + 8, y: 10 }, { x, y: 10 }]] });
const base: OnPathOptions = { offset: 0, side: "above", anchor: "start", spacing: 0, distance: 0, capHeight: 10, baseline: 0 };
const circle = (r: number, n = 720) => Array.from({ length: n }, (_, i) => ({ x: r * Math.cos((i / n) * 2 * Math.PI), y: r * Math.sin((i / n) * 2 * Math.PI) }));

test("Gerade Linie: Buchstaben liegen wie gesetzt, Versatz schiebt sie", () => {
  const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const r = layoutOnPath([box(0), box(10)], line, false, { ...base, offset: 5 });
  assert.equal(r.textLength, 18);
  assert.equal(r.overflow, false);
  near(r.loops[0].pts[0].x, 5); near(r.loops[0].pts[0].y, 0);
  near(r.loops[1].pts[2].x, 23); near(r.loops[1].pts[2].y, 10);
});

test("Buchstabenabstand: 3 mehr pro Zeichen, auch über Leerzeichen", () => {
  const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const r = layoutOnPath([box(0), { loops: [] }, box(20)], line, false, { ...base, spacing: 3 });
  assert.equal(r.textLength, 28 + 6);
  near(r.loops[1].pts[0].x, 26);
});

test("Darunter: die Oberkante liegt auf dem Pfad, Abstand schiebt weg", () => {
  const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const r = layoutOnPath([box(0)], line, false, { ...base, side: "below", distance: 2 });
  near(Math.max(...r.loops[0].pts.map(p => p.y)), -2);
  near(Math.min(...r.loops[0].pts.map(p => p.y)), -12);
});

test("Grundlinie: Unterlängen hängen unter den Pfad", () => {
  const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const r = layoutOnPath([box(0)], line, false, { ...base, baseline: 3 });
  near(r.loops[0].pts[0].y, -3);
});

test("Mitte als Bezug: Text liegt mittig um den Pfad-Anfang plus Versatz", () => {
  const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const r = layoutOnPath([box(0), box(10)], line, false, { ...base, anchor: "center", offset: 50 });
  near(r.loops[0].pts[0].x, 41); near(r.loops[1].pts[1].x, 59);
});

test("Kreis: Buchstabenmitte sitzt auf dem Radius und steht radial", () => {
  const path = orientPath(circle(50), true, false);
  const r = layoutOnPath([box(-4)], path, true, { ...base, anchor: "center" });
  // oben auf dem Kreis, im Uhrzeigersinn: Buchstabe steht aufrecht nach außen
  const p = r.loops[0].pts;
  near((p[0].x + p[1].x) / 2, 0, 0.01);
  near((p[0].y + p[1].y) / 2, 50, 0.01);
  near((p[2].y + p[3].y) / 2, 60, 0.01);
  assert.ok(p[1].x > p[0].x, "liest von links nach rechts");
});

test("Kreis: umgedrehte Richtung setzt den Text innen", () => {
  const path = orientPath(circle(50), true, true);
  const p = layoutOnPath([box(-4)], path, true, { ...base, anchor: "center" }).loops[0].pts;
  near((p[2].y + p[3].y) / 2, 40, 0.01);
});

test("Rechteck: Start in der Mitte der Oberkante", () => {
  const rect = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 40 }];
  const o = orientPath(rect, true, false);
  assert.deepEqual(o[0], { x: 50, y: 40 });
  near(pathWalker(o, true).length, 280);
});

test("Offener Pfad von rechts nach links wird umgedreht, flip dreht zurück", () => {
  const rtl = [{ x: 100, y: 0 }, { x: 0, y: 0 }];
  assert.equal(orientPath(rtl, false, false)[0].x, 0);
  assert.equal(orientPath(rtl, false, true)[0].x, 100);
});

test("Zu langer Text wird gemeldet, ist aber trotzdem da", () => {
  const short = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
  const r = layoutOnPath([box(0), box(10)], short, false, base);
  assert.equal(r.overflow, true);
  assert.equal(r.loops.length, 2);
  const c = layoutOnPath(Array.from({ length: 40 }, (_, i) => box(i * 10)), circle(10), true, base);
  assert.equal(c.overflow, true);
});

test("Offene Linien einer Einzellinien-Schrift bleiben offen, ohne Glyphen kein Ergebnis", () => {
  const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const r = layoutOnPath([{ loops: [[{ x: 0, y: 0 }, { x: 5, y: 5 }]], closed: [false] }], line, false, base);
  assert.equal(r.loops[0].closed, false);
  assert.equal(layoutOnPath([{ loops: [] }], line, false, base).loops.length, 0);
});

test("Walker: Punkt am Ende und im Kreis herum", () => {
  const w = pathWalker([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], true);
  assert.equal(w.length, 40);
  assert.deepEqual(w.at(45), { x: 5, y: 0 });
  assert.deepEqual(w.at(-5), { x: 0, y: 5 });
});
