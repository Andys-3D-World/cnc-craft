// Tests für den Zahnrad-Generator – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import { gear, gearDims, gearOutline, toothHalfAngle, boreArea, keyFor, noUndercutShift, type GearOptions, type XY } from "../src/gear.ts";

const base: GearOptions = { teeth: 20, module: 2, pressureAngle: 20, backlash: 0.1, shift: 0, bore: "round", boreD: 8,
  keyAuto: true, keyW: 3, keyDepth: 1.4, flat: 4.5, holes: 0, pair: false, teeth2: 30 };

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
const area = (m: MultiPolygon) => m.reduce((s, poly) => s + poly.reduce((t, r, i) => {
  let a = 0; for (let k = 0, j = r.length - 1; k < r.length; j = k++) a += r[j][0] * r[k][1] - r[k][0] * r[j][1];
  return t + (i ? -1 : 1) * Math.abs(a / 2);
}, 0), 0);
/** Zähne zählen: Punkte auf dem Kopfkreis bilden je Zahn eine zusammenhängende Gruppe */
function countTeeth(p: XY[], ra: number): number {
  const on = p.slice(0, -1).map(([x, y]) => Math.hypot(x, y) > ra - 1e-6);
  let n = 0;
  for (let i = 0; i < on.length; i++) if (on[i] && !on[(i - 1 + on.length) % on.length]) n++;
  return n;
}

for (const [z, m, a] of [[6, 1, 20], [12, 1.5, 20], [20, 2, 20], [37, 0.8, 14.5], [80, 1, 25], [150, 0.5, 20]] as const) {
  test(`Zahnrad z=${z} m=${m} α=${a}°: geschlossen, ohne Selbstüberschneidung, richtige Zähnezahl`, () => {
    const o = gearOutline(z, m, a, 0.1, 0);
    const p = o.pts;
    assert.deepEqual(p[0], p[p.length - 1]);
    assert.ok(!selfIntersects(p), "Kontur schneidet sich selbst");
    const dm = gearDims(z, m, a);
    const ra = Math.max(...p.map(([x, y]) => Math.hypot(x, y)));
    const rf = Math.min(...p.map(([x, y]) => Math.hypot(x, y)));
    assert.equal(countTeeth(p, ra), z);
    if (!o.pointed) assert.ok(Math.abs(ra - dm.da / 2) < 1e-6, "Kopfkreis");
    assert.ok(Math.abs(rf - dm.df / 2) < 1e-6, "Fußkreis");
  });
}

test("Teilkreis d = m·z, Kopf- und Fußkreis", () => {
  const d = gearDims(24, 1.5, 20);
  assert.equal(d.d, 36);
  assert.equal(d.da, 39);
  assert.equal(d.df, 32.25);
  assert.ok(Math.abs(d.db - 36 * Math.cos(20 * Math.PI / 180)) < 1e-9);
  assert.ok(Math.abs(d.p - Math.PI * 1.5) < 1e-9);
});

test("Zahndicke auf dem Teilkreis = π·m/2 − Spiel/2", () => {
  const z = 20, m = 2, j = 0.2;
  const s = 2 * toothHalfAngle(z, m, 20, j, 0, m * z / 2) * (m * z / 2);
  assert.ok(Math.abs(s - (Math.PI * m / 2 - j / 2)) < 1e-9);
});

test("Zahnradpaar greift ohne Überlappung ineinander (mehrere Drehstellungen)", () => {
  const z1 = 18, z2 = 31, m = 2, aDist = m * (z1 + z2) / 2;
  for (let step = 0; step < 8; step++) {
    const d1 = step / 8 * 2 * Math.PI / z1;            // Rad 1 dreht weiter …
    const d2 = Math.PI + Math.PI / z2 - d1 * z1 / z2;   // … Rad 2 dreht entgegen
    const g1 = gearOutline(z1, m, 20, 0.1, 0, d1).pts;
    const g2 = gearOutline(z2, m, 20, 0.1, 0, d2).pts.map(([x, y]) => [x + aDist, y] as XY);
    const ov = area(polygonClipping.intersection([[g1]], [[g2]]));
    assert.ok(ov < 1e-3, `Überlappung ${ov} mm² bei Schritt ${step}`);
    // und sie berühren sich fast (Spiel 0,1 mm): wenig Rad 2 nach links geschoben → Überlappung
    const g2n = g2.map(([x, y]) => [x - 0.2, y] as XY);
    assert.ok(area(polygonClipping.intersection([[g1]], [[g2n]])) > 1e-4, `kein Eingriff bei Schritt ${step}`);
  }
});

test("Gegenrad: Achsabstand m·(z1+z2)/2 und Profilverschiebung −x", () => {
  const r = gear({ ...base, pair: true, teeth: 12, teeth2: 40, shift: 0.3 });
  assert.equal(r.gears.length, 2);
  assert.equal(r.centerDist, 52);
  assert.equal(r.gears[1].dims.x, -0.3);
  assert.equal(r.gears[1].dims.d, 80);
});

test("runde Bohrung: Loch mit richtigem Durchmesser", () => {
  const r = gear({ ...base, boreD: 10 });
  const part = r.gears[0].area;
  assert.equal(part.length, 1);
  assert.equal(part[0].length, 2, "Außenkontur + Bohrung");
  const hole = part[0][1];
  const rr = hole.map(([x, y]) => Math.hypot(x, y));
  assert.ok(Math.abs(Math.max(...rr) - 5) < 1e-6 && Math.min(...rr) > 4.99);
});

test("Passfedernut nach DIN 6885: Breite und Tiefe", () => {
  assert.deepEqual([keyFor(8)?.b, keyFor(8)?.t2], [2, 1.0]);
  assert.deepEqual([keyFor(12)?.b, keyFor(20)?.b, keyFor(25)?.b, keyFor(25)?.t2], [4, 6, 8, 3.3]);
  assert.equal(keyFor(5), null);
  const r = gear({ ...base, bore: "key", boreD: 20, keyAuto: true, module: 2, teeth: 40 });
  const hole = r.gears[0].area[0][1];
  const xs = hole.map(p => p[0]), ys = hole.map(p => p[1]);
  assert.ok(Math.abs(Math.max(...ys) - (10 + 2.8)) < 1e-6, "Nutgrund bei d/2 + t2");
  assert.ok(Math.abs(Math.min(...ys) + 10) < 1e-6);
  // Breite der Nut oben = 6 mm
  const top = hole.filter(p => p[1] > 10.5).map(p => p[0]);
  assert.ok(Math.abs(Math.max(...top) - 3) < 1e-6 && Math.abs(Math.min(...top) + 3) < 1e-6);
  assert.ok(Math.max(...xs) <= 10 + 1e-6);
  // eigene Maße
  const own = boreArea({ bore: "key", boreD: 20, keyAuto: false, keyW: 5, keyDepth: 2, flat: 0 });
  assert.equal(own.key?.b, 5);
  assert.ok(Math.abs(Math.max(...own.area[0][0].map(p => p[1])) - 12) < 1e-6);
});

test("D-Welle: Abflachung auf dem eingestellten Maß", () => {
  const b = boreArea({ bore: "dflat", boreD: 5, keyAuto: false, keyW: 0, keyDepth: 0, flat: 4.5 });
  const ys = b.area[0][0].map(p => p[1]);
  assert.ok(Math.abs(Math.max(...ys) - 2) < 1e-6);   // 4,5 − 2,5
  assert.ok(Math.abs(Math.min(...ys) + 2.5) < 1e-6);
});

test("Erleichterungslöcher: Anzahl, nur wenn Platz", () => {
  const r = gear({ ...base, teeth: 60, module: 2, holes: 5, boreD: 10 });
  assert.equal(r.gears[0].holes, 5);
  assert.equal(r.gears[0].area[0].length, 1 + 1 + 5);
  const small = gear({ ...base, teeth: 12, module: 1, holes: 6, boreD: 5 });
  assert.equal(small.gears[0].holes, 0);
  assert.ok(small.warnings.includes("gear.warnHoles"));
});

test("Unterschnitt-Hinweis bei wenigen Zähnen", () => {
  assert.ok(gear({ ...base, teeth: 10 }).warnings.includes("gear.warnUndercut"));
  assert.ok(!gear({ ...base, teeth: 20 }).warnings.includes("gear.warnUndercut"));
  assert.ok(!gear({ ...base, teeth: 10, shift: noUndercutShift(10, 20) }).warnings.includes("gear.warnUndercut"));
});

test("ohne Bohrung: nur die Zahnkontur", () => {
  const r = gear({ ...base, bore: "none" });
  assert.equal(r.gears[0].area.length, 1);
  assert.equal(r.gears[0].area[0].length, 1);
});
