// Tests für den Weihnachtsschmuck-Generator – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MultiPolygon } from "polygon-clipping";
import { ornament, ornamentBody, fitText, holeMargin, ORNAMENT_SHAPES, type OrnamentOptions } from "../src/ornament.ts";
import { inRegion, bounds } from "../src/nameConnect.ts";

type XY = [number, number];
const base: OrnamentOptions = { shape: "ball", size: 80, points: 5, hanger: "hole", holeD: 4, inner: "engrave", textSize: 100, border: false };
const rect = (x0: number, y0: number, x1: number, y1: number): MultiPolygon => [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]];
/** Ersatz-Schrift: drei „Buchstaben“, einer mit Loch (wie ein o) */
const word: MultiPolygon = [...rect(0, 0, 6, 10), [[[8, 0], [14, 0], [14, 10], [8, 10], [8, 0]], [[10, 3], [12, 3], [12, 7], [10, 7], [10, 3]]], ...rect(16, 0, 22, 10)];

function cross(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}
function selfIntersects(p: XY[]): boolean {
  const n = p.length - 1; // letzter Punkt = erster
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (cross(p[i], p[i + 1], p[j], p[j + 1])) return true;
  }
  return false;
}

const variants: [string, Partial<OrnamentOptions>][] = [
  ...ORNAMENT_SHAPES.map(s => [s, { shape: s }] as [string, Partial<OrnamentOptions>]),
  ...ORNAMENT_SHAPES.map(s => [s + " mit Ring", { shape: s, hanger: "ring" }] as [string, Partial<OrnamentOptions>]),
  ["Stern 8 Zacken", { shape: "star", points: 8 }], ["Stern 12 Zacken", { shape: "star", points: 12 }],
  ["kleine Kugel, großes Loch", { size: 40, holeD: 8 }], ["großes Herz", { shape: "heart", size: 150 }]
];

for (const [name, v] of variants) {
  const o = { ...base, ...v };
  test(`${name}: geschlossene Kontur, ein Teil, ohne Selbstüberschneidung`, () => {
    const r = ornament(o, { area: word, lines: [] });
    assert.equal(r.pieces, 1);
    for (const p of r.cut) for (const ring of p) {
      assert.ok(ring.length >= 4);
      assert.deepEqual(ring[0], ring[ring.length - 1]);
      assert.ok(!selfIntersects(ring as XY[]), "Kontur überschneidet sich");
    }
    // ohne Ring genau so hoch wie gewünscht
    if (o.hanger !== "ring") assert.ok(Math.abs(r.h - o.size) < 0.01, `Höhe ${r.h}`);
  });

  test(`${name}: Loch liegt mit Rand in der Form, Textfeld liegt in der Form und unter dem Loch`, () => {
    const ob = ornamentBody(o);
    assert.ok(ob.holeAt, "kein Loch gefunden");
    const [hx, hy] = ob.holeAt!;
    const m = o.hanger === "hole" ? holeMargin(ob.holeR) : 1.5;
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      assert.ok(inRegion(ob.body, hx + (ob.holeR + m * 0.99) * Math.cos(a), hy + (ob.holeR + m * 0.99) * Math.sin(a)), "Loch zu nah am Rand");
    }
    const b = ob.textBox;
    assert.ok(b.x1 > b.x0 && b.y1 > b.y0);
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++)
      assert.ok(inRegion(ob.body, b.x0 + ((b.x1 - b.x0) * i) / 10, b.y0 + ((b.y1 - b.y0) * j) / 10), "Textfeld ragt aus der Form");
    assert.ok(b.y1 <= hy - ob.holeR, "Text läge im Loch");
  });

  test(`${name}: Name liegt ganz in der Form`, () => {
    const r = ornament(o, { area: word, lines: [] });
    for (const p of r.engrave) for (const ring of p) for (const [x, y] of ring) assert.ok(inRegion(r.cut, x, y), `Punkt ${x},${y} außerhalb`);
    assert.ok(r.engrave.length > 0);
  });
}

test("ausgeschnittener Name: Löcher in der Form, Innenraum vom o fällt mit heraus, immer noch ein Teil", () => {
  const r = ornament({ ...base, inner: "cut" }, { area: word, lines: [] });
  assert.equal(r.pieces, 1);
  assert.equal(r.engrave.length, 0);
  // Loch + 3 Buchstaben = 4 Löcher, das Innere des o ist kein eigenes Teil
  assert.equal(r.cut[0].length - 1, 4);
});

test("Name als Linie, als eigenes Teil, Einzellinien-Schrift", () => {
  const s = ornament({ ...base, inner: "score" }, { area: word, lines: [] });
  assert.equal(s.lines.length, 4); // 3 Außenkonturen + Innenraum vom o
  for (const l of s.lines) for (const [x, y] of l.pts) assert.ok(inRegion(s.cut, x, y));
  const t = ornament({ ...base, inner: "layer" }, { area: word, lines: [] });
  assert.equal(t.top.length, 3);
  const open = ornament({ ...base, inner: "cut" }, { area: [], lines: [{ pts: [[0, 0], [5, 10], [10, 0]], closed: false }] });
  assert.equal(open.lines.length, 1);
  assert.equal(open.cut[0].length, 2); // nur das Aufhängeloch
});

test("Zierlinie liegt innen am Rand", () => {
  for (const shape of ORNAMENT_SHAPES) {
    const r = ornament({ ...base, shape, border: true }, { area: [], lines: [] });
    assert.ok(r.lines.length >= 1, `${shape}: keine Zierlinie`);
    for (const l of r.lines) for (const [x, y] of l.pts) assert.ok(inRegion(r.cut, x, y), `${shape}: Zierlinie außerhalb`);
  }
});

test("Text wird gleichmäßig eingepasst und mittig gesetzt; Schriftgröße in %", () => {
  const box = { x0: -20, y0: -5, x1: 20, y1: 5 };
  const full = bounds(fitText({ area: word, lines: [] }, box).area);
  assert.ok(Math.abs(full.y1 - full.y0 - 10) < 1e-9); // Höhe begrenzt (22 × 10 → 22 × 10)
  assert.ok(Math.abs((full.x0 + full.x1) / 2) < 1e-9);
  const half = bounds(fitText({ area: word, lines: [] }, box, 50).area);
  assert.ok(Math.abs(half.x1 - half.x0 - 11) < 1e-9);
  assert.deepEqual(fitText({ area: [], lines: [] }, box), { area: [], lines: [] });
});

test("ohne Aufhänger: kein Loch", () => {
  const r = ornament({ ...base, hanger: "none" }, { area: [], lines: [] });
  assert.equal(r.cut.length, 1);
  assert.equal(r.cut[0].length, 1);
});
