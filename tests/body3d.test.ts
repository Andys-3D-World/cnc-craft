// 3D-Körper aus Extrudieren/Ausschneiden – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MultiPolygon } from "polygon-clipping";
import { bodyShells, slabs, topOf, volume, zRange, type EvalFeat } from "../src/editor/body3d.ts";
import { stlBinary } from "../src/view3d/solid.ts";

const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const rect = (x0: number, y0: number, x1: number, y1: number): MultiPolygon => [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]];
const join = (region: MultiPolygon, z0: number, z1: number): EvalFeat => ({ op: "join", z0, z1, region });
const cut = (region: MultiPolygon, z0: number, z1: number): EvalFeat => ({ op: "cut", z0, z1, region });

test("Von–bis: Höhe nach oben und nach unten", () => {
  assert.deepEqual(zRange({ z0: 0, h: 10 }), [0, 10]);
  assert.deepEqual(zRange({ z0: 10, h: -4 }), [6, 10]);
});

test("Platte: Rauminhalt und eine Scheibe", () => {
  const f = [join(rect(0, 0, 100, 50), 0, 10)];
  assert.equal(slabs(f).length, 1);
  near(volume(f), 100 * 50 * 10);
  near(topOf(f), 10);
});

test("Tasche: 20×20 und 4 tief von oben", () => {
  const f = [join(rect(0, 0, 100, 50), 0, 10), cut(rect(40, 15, 60, 35), 6, 10)];
  near(volume(f), 100 * 50 * 10 - 20 * 20 * 4);
  const s = slabs(f);
  assert.equal(s.length, 2);
  near(s[0].z1, 6); near(s[1].z0, 6);
});

test("Durchgangsloch: Ausschneiden über die ganze Höhe", () => {
  const f = [join(rect(0, 0, 100, 50), 0, 10), cut(rect(10, 10, 20, 20), -1, 11)];
  near(volume(f), 100 * 50 * 10 - 10 * 10 * 10);
  assert.equal(slabs(f).length, 1); // gleiche Scheiben zusammengefasst
});

test("Reihenfolge zählt: erst Loch, dann wieder auffüllen", () => {
  const plate = join(rect(0, 0, 100, 50), 0, 10), hole = cut(rect(10, 10, 20, 20), 0, 10), fill = join(rect(10, 10, 20, 20), 0, 10);
  near(volume([plate, hole, fill]), 100 * 50 * 10);
  near(volume([plate, fill, hole]), 100 * 50 * 10 - 1000);
});

test("Zapfen obendrauf und Absatz nach unten", () => {
  const f = [join(rect(0, 0, 100, 50), 0, 10), join(rect(40, 15, 60, 35), 10, 25)];
  near(volume(f), 50000 + 20 * 20 * 15);
  near(topOf(f), 25);
});

test("Ausschneiden ohne Körper ergibt nichts", () => {
  assert.equal(slabs([cut(rect(0, 0, 10, 10), 0, 5)]).length, 0);
  assert.deepEqual(bodyShells([cut(rect(0, 0, 10, 10), 0, 5)]), []);
});

test("Netz ist wasserdicht: jede Kante gehört zu genau zwei Dreiecken, STL hat passende Größe", () => {
  const f = [join(rect(0, 0, 100, 50), 0, 10), cut(rect(40, 15, 60, 35), 6, 10)];
  const shells = bodyShells(f);
  assert.equal(shells.length, 1);
  const t = shells[0].tris;
  const key = (i: number) => `${t[i].toFixed(6)},${t[i + 1].toFixed(6)},${t[i + 2].toFixed(6)}`;
  // Volumen aus den Dreiecken (Divergenzsatz) = Rauminhalt → geschlossen und nach außen gerichtet
  let v = 0;
  for (let i = 0; i < t.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t.slice(i, i + 9);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  near(v, volume(f), 1e-3);
  assert.ok(key(0).length > 0);
  const stl = stlBinary(shells);
  assert.equal(stl.length, 84 + (t.length / 9) * 50);
});

// ---- Fräsen aus dem Körper ----
import { millPlan } from "../src/editor/body3d.ts";

test("Platte: nur die Außenkontur in voller Höhe", () => {
  const p = millPlan([join(rect(0, 0, 100, 50), 0, 12)]);
  assert.equal(p.ops.length, 1);
  assert.equal(p.ops[0].mode, "outside"); near(p.ops[0].depth, 12); near(p.height, 12);
  assert.equal(p.ops[0].ring.length, 4); // ohne doppelten Endpunkt
});

test("Platte mit Tasche und Durchbruch", () => {
  const p = millPlan([join(rect(0, 0, 100, 50), 0, 10), cut(rect(10, 10, 30, 30), 6, 10), cut(rect(60, 10, 80, 30), -1, 11)]);
  const modes = p.ops.map(o => `${o.mode}:${o.depth}`).sort();
  assert.deepEqual(modes, ["inside:10", "outside:10", "pocket:4"]);
});

test("Tasche ragt über den Rand: nur der Teil im Körper", () => {
  const p = millPlan([join(rect(0, 0, 100, 50), 0, 10), cut(rect(90, 10, 120, 30), 5, 10)]);
  const pk = p.ops.find(o => o.mode === "pocket")!;
  const xs = pk.ring.map(q => q[0]);
  near(Math.max(...xs), 100); near(Math.min(...xs), 90);
});

test("Ring-Tasche um einen stehenbleibenden Zapfen: Insel als Außenkontur mit gleicher Tiefe", () => {
  const ring: MultiPolygon = [[[[20, 10], [80, 10], [80, 40], [20, 40], [20, 10]], [[40, 20], [40, 30], [60, 30], [60, 20], [40, 20]]]];
  const p = millPlan([join(rect(0, 0, 100, 50), 0, 10), cut(ring, 7, 10)]);
  const pockets = p.ops.filter(o => o.depth === 3);
  assert.deepEqual(pockets.map(o => o.mode).sort(), ["outside", "pocket"]);
});

test("Tasche in der Tasche: zwei Tiefen", () => {
  const p = millPlan([join(rect(0, 0, 100, 50), 0, 10), cut(rect(10, 10, 60, 40), 7, 10), cut(rect(20, 20, 30, 30), 4, 10)]);
  assert.deepEqual(p.ops.filter(o => o.mode === "pocket").map(o => o.depth).sort(), [3, 6]);
});

test("Hinweise: Hohlraum unter Material und Erhebung oben", () => {
  const p = millPlan([join(rect(0, 0, 100, 50), 0, 10), cut(rect(10, 10, 20, 20), 2, 5), join(rect(40, 10, 60, 30), 10, 15)]);
  assert.equal(p.inner, 1);
  assert.equal(p.raised, 1);
});

// ---- Nachrechnen: welche Höhe bleibt nach dem Fräsen an jedem Punkt? (ohne Fräser-Radius) ----
type Op = ReturnType<typeof millPlan>["ops"][number];
const inRing = (r: [number, number][], x: number, y: number) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
/** Höhe nach dem Fräsen: Tasche wirkt, außer auf ihren eigenen Inseln; Durchbruch = ganz weg */
function milledHeight(ops: Op[], top: number, x: number, y: number): number {
  if (ops.some(o => o.mode === "inside" && inRing(o.ring, x, y))) return -Infinity;
  let h = top;
  for (const p of ops) {
    if (p.mode !== "pocket" || !inRing(p.ring, x, y)) continue;
    if (ops.some(i => i.islandOf === p.key && inRing(i.ring, x, y))) continue;
    h = Math.min(h, top - p.depth);
  }
  return h;
}
/** Oberkante der Körper-Säule an diesem Punkt */
function bodyHeight(f: EvalFeat[], x: number, y: number): number {
  let h = -Infinity;
  for (const s of slabs(f)) if (s.region.some(poly => inRing(poly[0] as [number, number][], x, y) && !poly.slice(1).some(r => inRing(r as [number, number][], x, y)))) h = Math.max(h, s.z1);
  return h;
}
function checkMilled(f: EvalFeat[], w: number, d: number) {
  const plan = millPlan(f);
  const top = plan.bottom + plan.height;
  let n = 0;
  for (let x = 0.5; x < w; x += 1.7) for (let y = 0.5; y < d; y += 1.3) {
    const want = bodyHeight(f, x, y);
    if (want === -Infinity) continue;
    near(milledHeight(plan.ops, top, x, y), want, 1e-6);
    n++;
  }
  assert.ok(n > 100);
  return plan;
}

test("Erhebung: Zapfen auf der Platte – drumherum eine Tasche, der Zapfen ist ihre Insel", () => {
  const f = [join(rect(0, 0, 100, 50), 0, 10), join(rect(40, 15, 60, 35), 10, 25)];
  const p = checkMilled(f, 100, 50);
  const pk = p.ops.filter(o => o.mode === "pocket");
  assert.equal(pk.length, 1); near(pk[0].depth, 15);
  assert.equal(p.ops.filter(o => o.islandOf === pk[0].key).length, 1);
  near(p.height, 25);
});

test("Gestufter Zapfen (Hochzeitstorte): Inseln gelten nur für ihre Tasche", () => {
  const f = [join(rect(0, 0, 100, 60), 0, 10), join(rect(20, 10, 80, 50), 10, 20), join(rect(40, 20, 60, 40), 20, 30)];
  const p = checkMilled(f, 100, 60);
  assert.deepEqual(p.ops.filter(o => o.mode === "pocket").map(o => o.depth).sort((a, b) => a - b), [10, 20]);
});

test("Zapfen mit Loch, Tasche daneben, Durchbruch: alles stimmt an jedem Punkt", () => {
  const ring: MultiPolygon = [[[[30, 10], [70, 10], [70, 40], [30, 40], [30, 10]], [[45, 20], [45, 30], [55, 30], [55, 20], [45, 20]]]];
  const f = [join(rect(0, 0, 100, 50), 0, 8), join(ring, 8, 20), cut(rect(5, 5, 20, 20), 4, 8), cut(rect(80, 10, 95, 40), -1, 30)];
  checkMilled(f, 100, 50);
});

test("Nur Ausschnitte (wie bisher): Tasche in der Tasche und Ring-Tasche stimmen", () => {
  const ring: MultiPolygon = [[[[20, 10], [80, 10], [80, 40], [20, 40], [20, 10]], [[40, 20], [40, 30], [60, 30], [60, 20], [40, 20]]]];
  checkMilled([join(rect(0, 0, 100, 50), 0, 10), cut(ring, 7, 10), cut(rect(5, 5, 15, 45), 3, 10)], 100, 50);
});

test("Ohne Körper: nichts zu fräsen", () => {
  assert.equal(millPlan([cut(rect(0, 0, 10, 10), 0, 5)]).ops.length, 0);
});

// ---- Kanten: Fase und Rundung ----
import { edgeInset, expandEdges, offsetRegion, regionArea } from "../src/editor/body3d.ts";

test("Fläche verschieben: kleiner und größer, Löcher gegenläufig", () => {
  near(regionArea(offsetRegion(rect(0, 0, 100, 50), -5)), 90 * 40, 1e-6);
  const frame: MultiPolygon = [[[[0, 0], [100, 0], [100, 50], [0, 50], [0, 0]], [[40, 15], [40, 35], [60, 35], [60, 15], [40, 15]]]];
  // das Loch wächst mit runden Ecken (Radius 2), wie ein Fräser es macht
  near(regionArea(offsetRegion(frame, -2)), 96 * 46 - (20 * 20 + 4 * 20 * 2 + Math.PI * 4), 0.15);
});

test("Kantenverlauf: Fase linear, Rundung als Viertelkreis", () => {
  near(edgeInset({ kind: "chamfer", size: 3 }, 1), 1);
  near(edgeInset({ kind: "round", size: 3 }, 3), 3);
  near(edgeInset({ kind: "round", size: 3 }, 0), 0);
  near(edgeInset({ kind: "round", size: 3 }, 1.5), 3 - Math.sqrt(9 - 2.25));
});

test("Platte mit Fase 2 oben: Rauminhalt fast genau (feine Stufen)", () => {
  const plain = 100 * 50 * 10;
  // Fase entfernt ein Dreiecksprisma 2×2/2 entlang des Umfangs (Ecken: Pyramiden-Korrektur)
  const exact = plain - 0.5 * 4 * 2 * (100 + 50) + (4 / 3) * 4 * 2;
  const v = volume([{ ...join(rect(0, 0, 100, 50), 0, 10), edge: { kind: "chamfer", size: 2 } }]);
  assert.ok(Math.abs(v - exact) / exact < 0.003, `${v} vs ${exact}`);
});

test("Rundung: Oberkante kleiner, Höhe bleibt", () => {
  const f = [{ ...join(rect(0, 0, 100, 50), 0, 10), edge: { kind: "round" as const, size: 3 } }];
  near(topOf(f), 10);
  const s = slabs(f);
  assert.ok(regionArea(s[s.length - 1].region) < 100 * 50 - 10);
  assert.ok(expandEdges(f).length > 3);
});

test("Fräsen: Fase oben an der Platte (außen) und am Rand einer Tasche und eines Durchbruchs (innen)", () => {
  const f = [
    { ...join(rect(0, 0, 100, 50), 0, 10), edge: { kind: "chamfer" as const, size: 1 } },
    { ...cut(rect(10, 10, 30, 30), 5, 10), edge: { kind: "chamfer" as const, size: 0.5 } },
    { ...cut(rect(60, 10, 80, 30), -1, 11), edge: { kind: "chamfer" as const, size: 0.5 } }
  ];
  const p = millPlan(f);
  const ch = p.ops.filter(o => o.mode === "chamfer");
  assert.deepEqual(ch.map(o => `${o.side}:${o.width}`).sort(), ["-1:0.5", "-1:0.5", "1:1"]);
  // die Taschen-Tiefe bleibt 5 (die Fase ändert die Fräsformen sonst nicht)
  assert.deepEqual(p.ops.filter(o => o.mode === "pocket").map(o => o.depth), [5]);
});

test("Fräsen: Rundungen und tiefe Fasen werden nur gemeldet", () => {
  const p = millPlan([
    { ...join(rect(0, 0, 100, 50), 0, 10), edge: { kind: "round" as const, size: 2 } },
    { ...join(rect(40, 15, 60, 35), 10, 20), edge: { kind: "chamfer" as const, size: 1 } },
    { ...join(rect(0, 0, 100, 50), 0, 10), edge: { kind: "chamfer" as const, size: 1 } }
  ]);
  assert.equal(p.rounds, 1);
  assert.equal(p.edgeLow, 1);
});

test("Fase am Rand eines Durchbruchs, der über den Körper hinausreicht: sitzt an der Oberkante", () => {
  const plate = join(rect(0, 0, 100, 50), 0, 10);
  const hole = { ...cut(rect(40, 15, 60, 35), -1, 11), edge: { kind: "chamfer" as const, size: 1 } };
  const without = volume([plate, cut(rect(40, 15, 60, 35), -1, 11)]);
  assert.ok(volume([plate, hole]) < without - 10, "Fase nimmt Material weg");
  near(topOf([plate, hole]), 10);
});

test("Fase an einem Loch in der Platte neben einem höheren Zapfen: liegt auf der Platte, wird nicht bei Z 0 gefräst", () => {
  const plate = join(rect(0, 0, 100, 50), 0, 10), boss = join(rect(60, 10, 90, 40), 10, 16);
  const hole = { ...cut(rect(10, 10, 20, 20), -1, 20), edge: { kind: "chamfer" as const, size: 1 } };
  const p = millPlan([plate, boss, hole]);
  assert.equal(p.ops.filter(o => o.mode === "chamfer").length, 0);
  assert.equal(p.edgeLow, 1);
  // im Körper sitzt die Fase auf Höhe der Platte (10): dort fehlt Material gegenüber ohne Fase
  const without = volume([plate, boss, cut(rect(10, 10, 20, 20), -1, 20)]);
  assert.ok(volume([plate, boss, hole]) < without - 5);
});
