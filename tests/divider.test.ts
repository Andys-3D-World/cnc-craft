// Tests für den Fachteiler – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MultiPolygon } from "polygon-clipping";
import { divider, parseSizes, resolveSizes, linePositions, innerSize, fromBox, type DividerOptions } from "../src/divider.ts";
import type { BoxOptions } from "../src/box.ts";

const base: DividerOptions = { width: 200, depth: 150, height: 60, outside: false, wall: 3, thickness: 3, cols: 4, rows: 3, colSizes: "", rowSizes: "",
  clearance: 0.2, gap: 0.5, kerf: 0, tool: 0, relief: "dogbone", dividerHeight: 0, outer: "none" };

const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} ≠ ${b}`);
const area = (m: MultiPolygon) => m.reduce((s, poly) => s + poly.reduce((t, r, i) => {
  let a = 0; for (let k = 0, j = r.length - 1; k < r.length; j = k++) a += r[j][0] * r[k][1] - r[k][0] * r[j][1];
  return t + (i ? -1 : 1) * Math.abs(a / 2);
}, 0), 0);
const inside = (m: MultiPolygon, x: number, y: number) => m.some(poly => poly.some((r, ri) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  }
  return ri === 0 ? c : false;
}));

test("Anzahl: Fächer − 1 Stege je Richtung, mit Rahmen 4 mehr, mit Boden 5 mehr", () => {
  const count = (o: Partial<DividerOptions>, kind: string) => divider({ ...base, ...o }).parts.filter(p => p.kind === kind).length;
  assert.equal(divider(base).parts.length, 2 + 3);
  assert.equal(count({}, "long"), 2);
  assert.equal(count({}, "cross"), 3);
  assert.equal(divider({ ...base, outer: "frame" }).parts.length, 2 + 3 + 4);
  assert.equal(divider({ ...base, outer: "tray" }).parts.length, 2 + 3 + 5);
  assert.equal(count({ outer: "tray" }, "base"), 1);
  assert.equal(count({ outer: "frame" }, "wallLong"), 2);
  assert.equal(count({ outer: "frame" }, "wallCross"), 2);
});

test("Fächer + Stege füllen genau den Platz, die Schlitze sitzen an den Stegen", () => {
  const r = divider(base);
  near(r.colSizes.reduce((a, b) => a + b) + 3 * 3, 200);
  near(r.rowSizes.reduce((a, b) => a + b) + 2 * 3, 150);
  const long = r.parts.find(p => p.kind === "long")!, cross = r.parts.find(p => p.kind === "cross")!;
  assert.equal(long.slots.length, 3);
  assert.equal(cross.slots.length, 2);
  r.xLines.forEach((x, i) => near(long.slots[i], x - base.gap));
  r.yLines.forEach((y, i) => near(cross.slots[i], y - base.gap));
  near(long.w, 200 - 2 * base.gap);
  near(cross.w, 150 - 2 * base.gap);
});

test("Schlitztiefe = halbe Höhe: Längsstege von oben, Querstege von unten, Oberkanten bündig", () => {
  const r = divider(base);
  near(r.slotDepth, 30);
  const long = r.parts.find(p => p.kind === "long")!, cross = r.parts.find(p => p.kind === "cross")!;
  assert.equal(long.from, "top");
  assert.equal(cross.from, "bottom");
  const x = long.slots[0], y = cross.slots[0];
  // Längssteg: oberhalb der Mitte offen, darunter Material
  assert.equal(inside(long.area, x, 30.01), false);
  assert.equal(inside(long.area, x, 29.99), true);
  // Quersteg: unterhalb der Mitte offen, darüber Material
  assert.equal(inside(cross.area, y, 29.99), false);
  assert.equal(inside(cross.area, y, 30.01), true);
  // Beide Stege sind gleich hoch, die Schlitze treffen sich genau in der Mitte
  near(long.h, cross.h);
});

test("Teile passen mit dem Spiel: Schlitz ist je Seite Spiel/2 breiter als das Material", () => {
  const r = divider(base);
  near(r.slotW, 3.2);
  const long = r.parts.find(p => p.kind === "long")!;
  const x = long.slots[0];
  // Das Material (x ± 1,5) liegt ganz im Schlitz, an den Rändern bleiben je 0,1 mm Luft
  assert.equal(inside(long.area, x - 1.5, 45), false);
  assert.equal(inside(long.area, x + 1.5, 45), false);
  assert.equal(inside(long.area, x - 1.61, 45), true);
  assert.equal(inside(long.area, x + 1.61, 45), true);
  // Fläche: Rechteck minus Schlitze
  near(area(long.area), long.w * 60 - 3 * 3.2 * 30);
});

test("Rahmen: Ecken überblattet, Länge mit zwei Dicken, Außenmaß stimmt", () => {
  const r = divider({ ...base, outer: "frame" });
  const wall = r.parts.find(p => p.kind === "wallLong")!, wallX = r.parts.find(p => p.kind === "wallCross")!;
  near(wall.w, 200 + 6);
  near(wallX.w, 150 + 6);
  assert.equal(wall.slots.length, 5);
  near(wall.slots[0], 1.5);
  near(wall.slots[4], 206 - 1.5);
  // Ende: oben ausgeschnitten bis Dicke + Spiel/2, unten voll
  assert.equal(inside(wall.area, 0.5, 45), false);
  assert.equal(inside(wall.area, 3.05, 45), false);
  assert.equal(inside(wall.area, 3.15, 45), true);
  assert.equal(inside(wall.area, 0.5, 15), true);
  // Ende beim Quersteg umgekehrt
  assert.equal(inside(wallX.area, 0.5, 15), false);
  assert.equal(inside(wallX.area, 0.5, 45), true);
  near(area(wall.area), 206 * 60 - 3 * 3.2 * 30 - 2 * 3.1 * 30);
  assert.deepEqual(r.outerSize, { w: 206, d: 156, h: 60 });
});

test("Boden: Rechteck in Außenmaß des Rahmens, Einsatz wird eine Dicke höher", () => {
  const r = divider({ ...base, outer: "tray" });
  const b = r.parts.find(p => p.kind === "base")!;
  near(area(b.area), 206 * 156);
  near(r.outerSize.h, 63);
});

test("Außenmaße: Wände und Boden kommen ab", () => {
  assert.deepEqual(innerSize({ ...base, outside: true, wall: 5 }), { w: 190, d: 140, h: 55 });
  assert.deepEqual(innerSize({ ...base, outside: true, wall: 5, outer: "frame" }), { w: 194, d: 144, h: 60 });
  assert.deepEqual(innerSize({ ...base, outside: true, wall: 5, outer: "tray" }), { w: 194, d: 144, h: 57 });
});

test("Eigene Steghöhe: Schlitz bleibt die Hälfte, zu hohe gibt eine Warnung", () => {
  const r = divider({ ...base, dividerHeight: 40 });
  near(r.slotDepth, 20);
  assert.equal(r.parts[0].h, 40);
  const tall = divider({ ...base, dividerHeight: 80 });
  assert.ok(tall.warnings.some(w => w.key === "div.warnTall"));
});

test("Eigene Fachgrößen: Stern teilt den Rest, Tippfehler werden gemeldet, falsche Summe gestreckt", () => {
  assert.deepEqual(parseSizes(""), []);
  assert.deepEqual(parseSizes("40; 60,5 *"), [40, 60.5, null]);
  assert.equal(parseSizes("40,60,80"), null);
  assert.equal(parseSizes("abc"), null);
  assert.equal(parseSizes("0; 10"), null);
  const s = resolveSizes("40; *; *", 3, 200, 3);
  near(s.sizes[1], (200 - 6 - 40) / 2);
  const st = resolveSizes("50; 50", 2, 200, 3);
  near(st.sizes[0] + st.sizes[1] + 3, 200);
  near(st.given!, 103);
  assert.deepEqual(linePositions([40, 60, 100], 3), [41.5, 104.5]);
  const r = divider({ ...base, colSizes: "40; *" });
  assert.equal(r.parts.filter(p => p.kind === "cross").length, 1);
  near(r.colSizes[0], 40);
  assert.ok(divider({ ...base, colSizes: "x" }).errors.some(e => e.key === "div.errSizes"));
  assert.ok(divider({ ...base, colSizes: "50; 50" }).warnings.some(w => w.key === "div.warnStretchW"));
});

test("Prüfungen: zu viele Fächer, Maße, keine Teile, Fräser, Dogbones", () => {
  const err = (o: Partial<DividerOptions>, key: string) => assert.ok(divider({ ...base, ...o }).errors.some(e => e.key === key), key);
  const warn = (o: Partial<DividerOptions>, key: string) => assert.ok(divider({ ...base, ...o }).warnings.some(e => e.key === key), key);
  err({ cols: 100 }, "div.errTooMany");
  err({ colSizes: "300; *" }, "div.errTooMany");
  err({ width: 0 }, "div.errSize");
  err({ outside: true, wall: 200 }, "div.errSize");
  err({ cols: 1, rows: 1 }, "div.errNoParts");
  err({ width: 4, cols: 1, rows: 2 }, "div.errSlotWide");
  assert.equal(divider({ ...base, cols: 100 }).parts.length, 0);
  warn({ tool: 6 }, "div.warnTool");
  warn({ tool: 2, relief: "none" }, "div.warnNoRelief");
  warn({ cols: 40 }, "div.warnThin");
  warn({ cols: 1 }, "div.warnOneWay");
  warn({ kerf: 2 }, "div.warnKerf");
  assert.deepEqual(divider(base).errors, []);
  assert.deepEqual(divider(base).warnings, []);
});

test("Fräse: Dogbones nehmen in den Schlitz-Gründen Material weg, Oberkanten bleiben", () => {
  const plain = divider({ ...base, tool: 3, relief: "none" }).parts.find(p => p.kind === "long")!;
  const bone = divider({ ...base, tool: 3, relief: "dogbone" }).parts.find(p => p.kind === "long")!;
  assert.ok(area(bone.area) < area(plain.area));
  const x = bone.slots[0];
  // Der Kreis geht durch die Ecke und schneidet in Wand und Grund des Schlitzes: dort fehlt jetzt Material
  assert.equal(inside(plain.area, x + 1.9, 31.07), true);
  assert.equal(inside(bone.area, x + 1.9, 31.07), false);
  assert.equal(inside(plain.area, x + 0.6, 29.7), true);
  assert.equal(inside(bone.area, x + 0.6, 29.7), false);
  assert.equal(inside(bone.area, 1, 59), true);
});

test("Laser: Teil rundum kerf/2 größer, Schlitz um kerf enger – Schlitz sitzt in der Mitte", () => {
  const r = divider({ ...base, kerf: 0.2 });
  const long = r.parts.find(p => p.kind === "long")!;
  near(long.w, 199 + 0.2);
  near(long.h, 60.2);
  const clean = divider(base).parts.find(p => p.kind === "long")!;
  near(long.slots[0], clean.slots[0] + 0.1);
  // Gezeichnete Schlitzbreite 3,2 − 0,2 = 3,0; Schlitz-Boden liegt beim Zeichnen bei 30,2 von 60,2 Höhe, also 30 mm tief
  near(area(long.area), 199.2 * 60.2 - 3 * 3.0 * 30);
});

test("Maße aus dem Box-Generator", () => {
  const b: BoxOptions = { w: 100, d: 80, h: 50, inner: false, t: 3, finger: 9, lid: false, kerf: 0.1, type: "open" };
  assert.deepEqual(fromBox(b), { width: 94, depth: 74, height: 47, outside: false, thickness: 3 });
  assert.deepEqual(fromBox({ ...b, type: "closed" }), { width: 94, depth: 74, height: 44, outside: false, thickness: 3 });
  assert.deepEqual(fromBox({ ...b, inner: true, type: "drawer" }), { width: 100, depth: 80, height: 50, outside: false, thickness: 3 });
  assert.equal(fromBox({ ...b, type: "hex" }), null);
  assert.equal(fromBox({ ...b, type: "tray" }), null);
});
