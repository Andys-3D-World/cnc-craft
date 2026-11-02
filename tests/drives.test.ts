// Tests für Zahnstange, Zahnriemenscheibe und Kettenrad – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import { rackOutline, rackPinion, pulleyOD, pulleyArea, sprocketDims, sprocketArea, BELTS, BELT_PROFILES, CHAINS } from "../src/drives.ts";
import { circle, type XY } from "../src/gear.ts";

const area = (m: MultiPolygon) => m.reduce((s, poly) => s + poly.reduce((t, r, i) => {
  let a = 0; for (let k = 0, j = r.length - 1; k < r.length; j = k++) a += r[j][0] * r[k][1] - r[k][0] * r[j][1];
  return t + (i ? -1 : 1) * Math.abs(a / 2);
}, 0), 0);
function cross(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}
function selfIntersects(p: XY[]): boolean {
  const n = p.length - 1;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (cross(p[i], p[i + 1], p[j], p[j + 1])) return true;
  }
  return false;
}

const rack = { module: 2, pressureAngle: 20, backlash: 0.1, teeth: 12, back: 6 };

test("Zahnstange: geschlossen, Zähnezahl, Teilung π·m, Zahndicke auf der Teillinie", () => {
  const r = rackOutline(rack);
  assert.deepEqual(r.pts[0], r.pts[r.pts.length - 1]);
  assert.ok(!selfIntersects(r.pts));
  const tips = r.pts.filter(p => Math.abs(p[1] - 2) < 1e-9);
  assert.equal(tips.length, 24); // 2 Punkte je Zahn
  assert.ok(Math.abs(r.length - 12 * Math.PI * 2) < 1e-9);
  assert.ok(Math.abs(r.height - (2 + 2.5 + 6)) < 1e-9);
  // Zahn 0: Breite auf der Teillinie (y = 0) = p/2 − Spiel/2
  const s = Math.PI - 0.05, ta = Math.tan(20 * Math.PI / 180);
  const tip = tips.filter(p => Math.abs(p[0]) < 3).map(p => p[0]);
  assert.ok(Math.abs(Math.max(...tip) - (s / 2 - 2 * ta)) < 1e-9);
});

test("Zahnstange und Ritzel greifen ohne Überlappung ineinander", () => {
  const z = 15, m = 2, r = rackOutline(rack), pin = rackPinion(rack, z);
  for (let step = 0; step < 8; step++) {
    const dx = step / 8 * Math.PI * m;   // Stange schiebt …
    const ang = dx / (m * z / 2);        // … Ritzel dreht mit (abrollen auf dem Teilkreis)
    const c = Math.cos(ang), s = Math.sin(ang);
    const g = pin.pts.map(([x, y]) => [x * c - y * s + pin.at[0], x * s + y * c + pin.at[1]] as XY);
    const st = r.pts.map(([x, y]) => [x + dx, y] as XY);
    const ov = area(polygonClipping.intersection([[g]], [[st]]));
    assert.ok(ov < 1e-3, `Überlappung ${ov} bei Schritt ${step}`);
    const near = r.pts.map(([x, y]) => [x + dx, y + 0.3] as XY);
    assert.ok(area(polygonClipping.intersection([[g]], [[near]])) > 1e-4, `kein Eingriff bei Schritt ${step}`);
  }
});

test("Riemenscheibe: Außen-Ø, Anzahl und Tiefe der Rillen", () => {
  assert.ok(Math.abs(pulleyOD("gt2", 20) - (40 / Math.PI - 0.508)) < 1e-9);
  assert.ok(Math.abs(pulleyOD("gt2", 20) - 12.224) < 0.01); // GT2 20 Zähne: 12,22 mm
  for (const pr of BELT_PROFILES) {
    const z = 24, a = pulleyArea(pr, z);
    assert.equal(a.length, 1);
    const ring = a[0][0];
    assert.ok(!selfIntersects(ring), pr);
    const R = pulleyOD(pr, z) / 2;
    const rr = ring.map(([x, y]) => Math.hypot(x, y));
    assert.ok(Math.abs(Math.max(...rr) - R) < 1e-6, pr + " Außen");
    assert.ok(Math.abs(Math.min(...rr) - (R - BELTS[pr].depth)) < 0.02, pr + " Rillentiefe");
    // Rillen zählen: Wechsel von außen nach innen
    const inside = ring.slice(0, -1).map(([x, y]) => Math.hypot(x, y) < R - BELTS[pr].depth / 2);
    let n = 0; for (let i = 0; i < inside.length; i++) if (inside[i] && !inside[(i - 1 + inside.length) % inside.length]) n++;
    assert.equal(n, z, pr + " Rillen");
  }
});

test("Kettenrad: Teilkreis, Rollen sitzen frei im Rollenbett, Zähnezahl", () => {
  for (const ch of CHAINS) for (const z of [9, 15, 32]) {
    const d = sprocketDims(ch.p, ch.d1, z);
    assert.ok(Math.abs(d.D - ch.p / Math.sin(Math.PI / z)) < 1e-9);
    assert.ok(d.ri > ch.d1 / 2);
    const a = sprocketArea(ch.p, ch.d1, z);
    assert.equal(a.length, 1, `${ch.id} z=${z} ein Teil`);
    assert.ok(!selfIntersects(a[0][0]), `${ch.id} z=${z}`);
    // Rolle auf jedem Teilkreis-Punkt: keine Überlappung mit dem Rad; Nachbar-Rollen haben Abstand p
    for (let k = 0; k < z; k++) {
      const ang = 2 * Math.PI * k / z;
      const roll = circle(d.D / 2 * Math.cos(ang), d.D / 2 * Math.sin(ang), ch.d1 / 2);
      assert.ok(area(polygonClipping.intersection(a, [roll])) < 1e-3, `${ch.id} z=${z} Rolle ${k}`);
    }
    const rr = a[0][0].map(([x, y]) => Math.hypot(x, y));
    assert.ok(Math.max(...rr) <= d.da / 2 + 1e-6);
    assert.ok(Math.abs(Math.min(...rr) - d.df / 2) < 0.05);
  }
});
