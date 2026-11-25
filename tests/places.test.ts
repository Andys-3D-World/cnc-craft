// Feste Spannplätze – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPlace, cleanPlaces, cornerPoint, jaws, MAX_PLACES, placeFromZero, zeroBlocked, zeroCommandFor, zeroFor, zeroOffset, type Place } from "../src/places.ts";

const base = { id: "a1", name: "Schraubstock", mode: "mill", machine: "", x: -300, y: -100, corner: "tl", wcs: "", kind: "vise", clamp: "y", jawW: 100, jawD: 20, jawOff: 5, jawZ: -3 };
const P = (o: any = {}) => cleanPlace({ ...base, ...o }) as Place;
const stock = { x: 0, y: 0, w: 80, h: 50 };

test("Ecken des Rohteils, auch mit Lage ungleich 0/0", () => {
  const s = { x: 10, y: -5, w: 80, h: 50 };
  assert.deepEqual(cornerPoint(s, "bl"), { x: 10, y: -5 });
  assert.deepEqual(cornerPoint(s, "tr"), { x: 90, y: 45 });
});

test("Feste Ecke hinten links: der Nullpunkt wandert mit der Höhe des Rohteils", () => {
  assert.deepEqual(zeroFor(P(), stock), { x: -300, y: -150 });
  assert.deepEqual(zeroFor(P(), { ...stock, h: 30 }), { x: -300, y: -130 });
  assert.deepEqual(zeroFor(P({ corner: "br" }), stock), { x: -380, y: -100 });
  assert.deepEqual(zeroFor(P({ corner: "bl" }), { ...stock, x: 10, y: 20 }), { x: -310, y: -120 });
});

test("Aus einem gesetzten Nullpunkt gemerkt und wieder gesetzt: derselbe Nullpunkt", () => {
  for (const corner of ["bl", "br", "tl", "tr"] as const) {
    const zero = { x: -123.4, y: -56.7 }, at = placeFromZero(zero, stock, corner), z = zeroFor(P({ ...at, corner }), stock);
    assert.ok(Math.abs(z.x - zero.x) < 1e-9 && Math.abs(z.y - zero.y) < 1e-9);
  }
});

test("Befehl: nur X und Y, aktives System, aus der aktuellen Stelle gerechnet", () => {
  // Maschine steht auf -200/-120, Nullpunkt soll auf -300/-150: dort ist sie 100/30
  assert.equal(zeroCommandFor({ x: -200, y: -120 }, { x: -300, y: -150 }), "G10 L20 P0 X100.000 Y30.000");
  assert.equal(zeroCommandFor({ x: -300.0001, y: -150 }, { x: -300, y: -150 }), "G10 L20 P0 X0.000 Y0.000");
  assert.ok(!/Z|G0|G1 |G53/.test(zeroCommandFor({ x: 1, y: 2 }, { x: 0, y: 0 })));
});

test("Abgleich mit der Maschine", () => {
  assert.equal(zeroOffset({ x: -300.01, y: -150 }, { x: -300, y: -150 }).ok, true);
  const o = zeroOffset({ x: -300, y: -155 }, { x: -300, y: -150 });
  assert.equal(o.ok, false);
  assert.equal(o.dy, -5);
});

test("Backen: feste Backe auf der Seite der festen Ecke, Überstand zählt ab dieser Ecke", () => {
  const j = jaws(P(), stock)!;
  assert.deepEqual(j.fixed, { x: -5, y: 50, w: 100, h: 20 });
  assert.deepEqual(j.moving, { x: -5, y: -20, w: 100, h: 20 });
  const r = jaws(P({ corner: "br" }), stock)!;
  assert.deepEqual(r.fixed, { x: -15, y: -20, w: 100, h: 20 });
  const x = jaws(P({ corner: "br", clamp: "x" }), stock)!;
  assert.deepEqual(x.fixed, { x: 80, y: -5, w: 20, h: 100 });
  assert.deepEqual(x.moving, { x: -20, y: -5, w: 20, h: 100 });
  assert.equal(jaws(P({ kind: "stop" }), stock), null);
});

test("Gespeicherte Plätze: Unbrauchbares fliegt raus, nichts wird geraten", () => {
  for (const bad of [null, 5, {}, { ...base, x: "1" }, { ...base, y: NaN }, { ...base, x: 1e9 }, { ...base, corner: "mm" }, { ...base, name: " " }, { ...base, mode: "lathe" }, { ...base, id: "<b>" }])
    assert.equal(cleanPlace(bad), null);
  assert.equal(P({ name: "A\nB" }).name, "A B");
  assert.equal(P({ wcs: "G59.1; M3" }).wcs, "");
  assert.equal(P({ wcs: "G55" }).wcs, "G55");
  assert.equal(P({ jawW: -4 }).jawW, 100);
  assert.equal(cleanPlaces([base, base]).length, 1);
  assert.equal(cleanPlaces(Array.from({ length: 60 }, (_, i) => ({ ...base, id: "p" + i }))).length, MAX_PLACES);
  assert.deepEqual(cleanPlaces("x"), []);
});

test("Nullpunkt nur, wenn alles stimmt", () => {
  const ok = { connected: true, grbl: true, rotary: false, back: false, locked: false, homed: true, inches: false };
  assert.equal(zeroBlocked(ok), "");
  assert.equal(zeroBlocked({ ...ok, connected: false }), "connect");
  assert.equal(zeroBlocked({ ...ok, grbl: false }), "grbl");
  assert.equal(zeroBlocked({ ...ok, rotary: true }), "rotary");
  assert.equal(zeroBlocked({ ...ok, back: true }), "back");
  assert.equal(zeroBlocked({ ...ok, locked: true }), "busy");
  assert.equal(zeroBlocked({ ...ok, homed: false }), "home");
  assert.equal(zeroBlocked({ ...ok, inches: true }), "inch");
});
