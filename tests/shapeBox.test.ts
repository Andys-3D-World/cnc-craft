// Tests für die Formbox (Wand entlang einer beliebigen Kontur) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import polygonClipping from "polygon-clipping";
import { shapeBox, shapeOutline, sizedArea, packArea, unpackArea, SHAPE_KINDS, type ShapeBoxOptions, type ShapeKind } from "../src/shapeBox.ts";
import { pointInPoly } from "../src/polyOffset.ts";
import { bounds } from "../src/nameConnect.ts";

type Pt = { x: number; y: number };
const base = { h: 60, t: 3, kerf: 0, finger: 10, lid: true, rim: 3, bend: 9, tool: 0 };
const opts = (k: ShapeKind, wall: "flex" | "segments", more: Partial<ShapeBoxOptions> = {}): ShapeBoxOptions =>
  ({ ...base, wall, area: sizedArea(shapeOutline(k), 140), ...more });

const perimeter = (l: Pt[]) => l.reduce((s, q, i) => { const n = l[(i + 1) % l.length]; return s + Math.hypot(q.x - n.x, q.y - n.y); }, 0);
const cross = (a: Pt, b: Pt, c: Pt, d: Pt) => {
  const o = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 1e-7 && d2 < -1e-7) || (d1 < -1e-7 && d2 > 1e-7)) && ((d3 > 1e-7 && d4 < -1e-7) || (d3 < -1e-7 && d4 > 1e-7));
};
const selfCross = (p: Pt[]) => {
  for (let i = 0; i < p.length; i++) for (let j = i + 2; j < p.length; j++) {
    if (i === 0 && j === p.length - 1) continue;
    if (cross(p[i], p[(i + 1) % p.length], p[j], p[(j + 1) % p.length])) return true;
  }
  return false;
};

// Alle Formen, die große runde Teile haben, müssen in beiden Bauarten gehen
const FINE: ShapeKind[] = ["circle", "oval", "triangle", "square", "pentagon", "hexagon", "octagon", "heart", "star", "arch", "tree", "bell",
  "mitten", "stocking", "snowman", "house", "egg", "pumpkin", "ghost", "shell", "mushroom"];
for (const k of FINE) for (const wall of ["flex", "segments"] as const) for (const kerf of [0, 0.15]) {
  test(`Formbox ${k} ${wall} kerf ${kerf}: Teile passen zusammen`, () => {
    const r = shapeBox(opts(k, wall, { kerf }));
    assert.equal(r.error, "", k + " " + r.error);
    assert.ok(r.panels.length >= 3);
    for (const p of r.panels) {
      assert.ok(p.pts.length >= 3, "Umriss geschlossen");
      assert.ok(!selfCross(p.pts), p.name + " überkreuzt sich nicht");
      for (const h of p.holes || []) assert.ok(h.length >= 3);
    }
    // Zapfen und Schlitze gleich lang, je Wand gleich viele Schlitze in Boden und Ring
    for (const w of r.walls) {
      assert.equal(w.tabLen.length, w.slotLen.length);
      w.tabLen.forEach((a, i) => assert.ok(Math.abs(a - w.slotLen[i]) < 0.02, `Zapfen ${a} = Schlitz ${w.slotLen[i]}`));
    }
    const slots = r.walls.reduce((a, w) => a + w.tabs, 0);
    const bottom = r.panels.find(p => p.name === "bottom")!;
    assert.equal(bottom.holes!.length, slots, "ein Schlitz je Zapfen im Boden");
    const ring = r.panels.filter(p => p.name === "flexRing").reduce((a, p) => a + (p.holes || []).length, 0);
    assert.ok(ring >= slots, "alle Schlitze auch im Ring");
    // Schlitze liegen im Boden
    for (const h of bottom.holes!) for (const q of h) assert.ok(pointInPoly(q.x, q.y, bottom.pts));
    // Deckel: die kleine Platte passt in die Öffnung
    const inner = r.panels.filter(p => p.name === "lidInner");
    assert.ok(inner.length >= 1);
    for (const p of r.panels.filter(q => q.name === "flexRing" || q.name === "lidOuter")) assert.ok(p.at);
  });
}

test("Pulli: schmale Ärmel gehen nicht heimlich verloren", () => {
  assert.equal(shapeBox(opts("sweater", "flex", { area: sizedArea(shapeOutline("sweater"), 120) })).error, "fbx.err.narrow", "bei großem Biegeradius eine Meldung");
  assert.equal(shapeBox(opts("sweater", "flex", { bend: 5, area: sizedArea(shapeOutline("sweater"), 220) })).error, "");
});

test("Eichel: Stiel zu dünn – Flex meldet es, Wandstücke lassen ihn weg und sagen es", () => {
  assert.equal(shapeBox(opts("acorn", "flex")).error, "fbx.err.narrow");
  const r = shapeBox(opts("acorn", "segments"));
  assert.equal(r.error, "");
  assert.ok(r.dropped >= 1);
});

test("Die Kiste wird so breit und tief wie eingegeben, auch wenn das Runden Spitzen kürzt", () => {
  for (const k of ["star", "triangle", "heart", "tree"] as ShapeKind[]) for (const wall of ["flex", "segments"] as const) {
    const r = shapeBox(opts(k, wall));
    assert.equal(r.error, "");
    const b = bounds(sizedArea(shapeOutline(k), 140));
    assert.ok(Math.abs(r.W - 140) < 1, `${k} ${wall} Breite ${r.W}`);
    assert.ok(Math.abs(r.D - (b.y1 - b.y0)) < 1, `${k} ${wall} Tiefe ${r.D}`);
  }
});

test("Flex-Streifen ist genau so lang wie die Kontur (ohne Verschluss)", () => {
  for (const k of ["heart", "star", "circle", "triangle", "tree"] as ShapeKind[]) {
    const r = shapeBox(opts(k, "flex"));
    assert.equal(r.error, "");
    const w = r.walls[0], strip = r.panels.find(p => p.name === "flexWall")!;
    assert.ok(Math.abs(w.length - perimeter(w.loop)) < 1e-6);
    assert.ok(Math.abs(strip.w - w.length - Math.max(4, 2 * 3)) < 1e-9, `${strip.w} ${w.length}`);
    assert.ok(strip.lines!.length > 4, "Biegescharnier vorhanden");
    assert.ok(Math.abs(strip.h - 60) < 1e-9, "Streifen so hoch wie die Kiste");
  }
});

test("Wandstücke stoßen innen aneinander und sitzen auf der Linie", () => {
  const r = shapeBox(opts("heart", "segments"));
  const walls = r.panels.filter(p => p.name === "hexWall");
  assert.ok(walls.length >= 5);
  for (const p of walls) { assert.ok(p.w >= 3 * 3 - 1e-9, "breit genug: " + p.w); assert.equal(p.h, 60); assert.ok(p.at); }
});

test("Löcher in der Form bekommen eine eigene Wand; der Ring zerfällt in zwei Teile", () => {
  const ringShape = polygonClipping.difference(shapeOutline("circle"), sizedArea(shapeOutline("circle"), 1).map(p => p.map(q => q.map(([x, y]) => [x - 0.5, y - 0.5] as [number, number]))));
  for (const wall of ["flex", "segments"] as const) {
    const r = shapeBox({ ...base, wall, area: sizedArea(ringShape, 180) });
    assert.equal(r.error, "");
    assert.equal(r.walls.length, 2);
    assert.equal(r.panels.filter(p => p.name === "flexRing").length, 2);
    const b = r.panels.find(p => p.name === "bottom")!;
    assert.equal(b.holes!.length, r.walls[0].tabs + r.walls[1].tabs + 1, "Schlitze + das Loch selbst");
    const bx = b.holes!.flatMap(h => h);
    assert.ok(bx.length > 0);
  }
});

test("Klare Meldungen statt kaputter Teile", () => {
  assert.equal(shapeBox({ ...opts("circle", "flex"), area: [] }).error, "fbx.err.noShape");
  assert.equal(shapeBox(opts("circle", "flex", { h: 15 })).error, "fbx.err.height");
  assert.equal(shapeBox(opts("circle", "segments", { h: 10 })).error, "fbx.err.height");
  assert.equal(shapeBox(opts("circle", "flex", { tool: 3 })).error, "fbx.err.flexRouter");
  assert.equal(shapeBox({ ...opts("circle", "flex"), area: sizedArea(shapeOutline("circle"), 12) }).error, "fbx.err.tooSmall");
  // schmale Stelle: ein langer dünner Streifen
  const thin = sizedArea([[[[0, 0], [100, 0], [100, 5], [0, 5], [0, 0]]]], 100, 14);
  assert.notEqual(shapeBox({ ...base, wall: "segments", area: thin }).error, "");
});

test("Fräse: Wandstücke bekommen Dogbones, Flex-Wände nie", () => {
  const plain = shapeBox(opts("hexagon", "segments"));
  const bones = shapeBox(opts("hexagon", "segments", { tool: 2 }));
  assert.equal(bones.error, "");
  const n = (r: typeof plain, name: string) => r.panels.filter(p => p.name === name).reduce((a, p) => a + p.pts.length + (p.holes || []).reduce((b, h) => b + h.length, 0), 0);
  assert.ok(n(bones, "bottom") > n(plain, "bottom"), "Schlitz-Ecken haben Bögen");
  assert.ok(n(bones, "hexWall") > n(plain, "hexWall"), "Zapfen-Ansätze haben Bögen");
});

test("Alle Formen haben eine Kontur; Einstellungen überleben Speichern und Laden", () => {
  for (const k of SHAPE_KINDS) if (k !== "letter" && k !== "custom") assert.ok(shapeOutline(k).length >= 1, k);
  const heart = sizedArea(shapeOutline("heart"), 120);
  const back = unpackArea(JSON.parse(JSON.stringify(packArea(heart))));
  assert.equal(shapeBox({ ...base, wall: "flex", area: back }).error, "");
  assert.ok(JSON.stringify(packArea(heart)).length < 32000);
  assert.deepEqual(unpackArea("kaputt"), []);
  assert.deepEqual(unpackArea([[["a", 1]]]), []);
});
