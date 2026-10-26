// Tests für die Umfahrung ausgeschnittener Teile – laufen mit `npm test` (node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { RapidPlanner } from "../src/rapidAvoid.ts";

type P = { x: number; y: number };
const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }
];
const circle = (cx: number, cy: number, r: number, n = 48): P[] =>
  Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((i / n) * 2 * Math.PI), y: cy + r * Math.sin((i / n) * 2 * Math.PI) }));

/** Geht die ganze Fahrt a -> via -> b irgendwo durch das Rechteck (Innenraum)? */
function hitsRect(a: P, via: P[], b: P, r: [number, number, number, number]): boolean {
  const pts = [a, ...via, b];
  for (let i = 1; i < pts.length; i++) {
    for (let k = 1; k < 200; k++) {
      const t = k / 200;
      const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
      if (x > r[0] + 0.01 && x < r[2] - 0.01 && y > r[1] + 0.01 && y < r[3] - 0.01) return true;
    }
  }
  return false;
}

test("rapid across a cut piece is routed around its frame", () => {
  const rp = new RapidPlanner(3);
  rp.addCut(rect(40, 40, 60, 60));
  const a = { x: 0, y: 50 }, b = { x: 100, y: 50 };
  const via = rp.route(a, b);
  assert.ok(via.length >= 2, "detour expected");
  assert.equal(hitsRect(a, via, b, [40, 40, 60, 60]), false);
  // über die Rahmen-Ecken mit 3 mm Abstand
  for (const p of via) {
    assert.ok([37, 63].includes(+p.x.toFixed(6)), `x ${p.x}`);
    assert.ok([37, 63].includes(+p.y.toFixed(6)), `y ${p.y}`);
  }
});

test("clear path stays straight", () => {
  const rp = new RapidPlanner(3);
  rp.addCut(rect(40, 40, 60, 60));
  assert.deepEqual(rp.route({ x: 0, y: 0 }, { x: 100, y: 10 }), []);
  // nur am Rahmen vorbei (nicht durch die Kontur): auch gerade
  assert.deepEqual(rp.route({ x: 0, y: 39 }, { x: 100, y: 39 }), []);
  // ohne Hindernisse sowieso gerade
  assert.deepEqual(new RapidPlanner(3).route({ x: 0, y: 50 }, { x: 100, y: 50 }), []);
});

test("start and end of the rapid are not changed", () => {
  const rp = new RapidPlanner(2);
  rp.addCut(circle(50, 50, 10));
  const a = { x: 10, y: 52 }, b = { x: 90, y: 47 };
  const via = rp.route(a, b);
  assert.ok(via.length > 0);
  for (const p of via) {
    assert.notDeepEqual(p, a);
    assert.notDeepEqual(p, b);
  }
  assert.deepEqual(a, { x: 10, y: 52 });
  assert.deepEqual(b, { x: 90, y: 47 });
});

test("leaving a just-cut contour across it goes around it", () => {
  // Rapid starts on the contour that was just cut (end of cut), target on the far side
  const rp = new RapidPlanner(3);
  rp.addCut(rect(40, 40, 60, 60));
  const a = { x: 60, y: 50 }, b = { x: 0, y: 50 };
  const via = rp.route(a, b);
  assert.ok(via.length >= 2);
  assert.equal(hitsRect(a, via, b, [40, 40, 60, 60]), false);
  // leaving outward needs no detour
  assert.deepEqual(rp.route(a, { x: 100, y: 50 }), []);
});

test("nested part inside a cut-out hole", () => {
  // Plate with hole H (20..80); small part B (45..55) was cut inside the hole first, then the hole.
  const rp = new RapidPlanner(2);
  rp.addCut(rect(45, 45, 55, 55));   // B
  // inside the hole, before the hole is cut: going from B's corner across B is rerouted around B only
  const inHole = rp.route({ x: 30, y: 50 }, { x: 70, y: 50 });
  assert.ok(inHole.length >= 2);
  for (const p of inHole) assert.ok(p.x >= 43 - 1e-9 && p.x <= 57 + 1e-9 && p.y >= 43 - 1e-9 && p.y <= 57 + 1e-9);

  rp.addCut(rect(20, 20, 80, 80));   // H (hole slug, contains B)
  // after the hole: a rapid across the plate goes around the whole hole frame
  const a = { x: 0, y: 50 }, b = { x: 100, y: 50 };
  const via = rp.route(a, b);
  assert.ok(via.length >= 2);
  assert.equal(hitsRect(a, via, b, [20, 20, 80, 80]), false);
  for (const p of via) assert.ok(p.y <= 18 + 1e-9 || p.y >= 82 - 1e-9);

  // target inside the hole (e.g. second pass): the hole can't be avoided, but B still is
  const into = rp.route({ x: 0, y: 50 }, { x: 70, y: 50 });
  assert.equal(hitsRect({ x: 0, y: 50 }, into, { x: 70, y: 50 }, [45, 45, 55, 55]), false);
});

test("several pieces in a row: detour avoids all of them", () => {
  const rp = new RapidPlanner(2);
  rp.addCut(rect(20, 40, 30, 60));
  rp.addCut(rect(50, 30, 60, 70));
  const a = { x: 0, y: 50 }, b = { x: 100, y: 50 };
  const via = rp.route(a, b);
  assert.ok(via.length >= 2);
  assert.equal(hitsRect(a, via, b, [20, 40, 30, 60]), false);
  assert.equal(hitsRect(a, via, b, [50, 30, 60, 70]), false);
});
