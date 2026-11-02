// Tests für Lüftungsgitter / Lochmuster – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import polygonClipping from "polygon-clipping";
import { vent, VENT_PATTERNS, VENT_SHAPES, type VentOptions, type XY } from "../src/vent.ts";

const base: VentOptions = { shape: "rect", width: 120, height: 80, radius: 6, margin: 6, pattern: "hex", size: 6, web: 1.5, slotLength: 20,
  plate: true, mountD: 4, mountInset: 6 };
/** kleinster Abstand zwischen zwei Konturen (Punkte gegen Kanten) */
function dist(a: XY[], b: XY[]): number {
  let m = Infinity;
  const seg = (p: XY, q: XY, r: XY) => {
    const dx = r[0] - q[0], dy = r[1] - q[1], l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p[0] - q[0]) * dx + (p[1] - q[1]) * dy) / l)) : 0;
    return Math.hypot(p[0] - q[0] - t * dx, p[1] - q[1] - t * dy);
  };
  for (const p of a) for (let i = 1; i < b.length; i++) m = Math.min(m, seg(p, b[i - 1], b[i]));
  for (const p of b) for (let i = 1; i < a.length; i++) m = Math.min(m, seg(p, a[i - 1], a[i]));
  return m;
}

test("alle Muster und Formen: Löcher im Lochfeld, Steg zwischen Nachbarn eingehalten", () => {
  for (const shape of VENT_SHAPES) for (const pattern of VENT_PATTERNS) {
    const o = { ...base, shape, pattern, mountD: 0 };
    const r = vent(o);
    assert.ok(r.holes.length > 5, `${shape}/${pattern}: ${r.holes.length} Löcher`);
    for (const h of r.holes) for (const [x, y] of h) {
      if (shape === "rect") assert.ok(Math.abs(x) <= 54 + 1e-6 && Math.abs(y) <= 34 + 1e-6, `${shape}/${pattern} außerhalb`);
      else assert.ok(Math.hypot(x, y) <= 54 + 1e-6);
      assert.deepEqual(h[0], h[h.length - 1]);
    }
    // Nachbarn: Mindestabstand = Steg (rund: Kreis-Näherung, deshalb etwas Toleranz)
    const cs = r.holes.map(h => h.slice(0, -1).reduce((s, p) => [s[0] + p[0] / (h.length - 1), s[1] + p[1] / (h.length - 1)] as XY, [0, 0] as XY));
    let minD = Infinity;
    for (let i = 0; i < r.holes.length; i++) for (let j = i + 1; j < r.holes.length; j++)
      if (Math.hypot(cs[i][0] - cs[j][0], cs[i][1] - cs[j][1]) < 30) minD = Math.min(minD, dist(r.holes[i], r.holes[j]));
    assert.ok(minD >= 1.5 - 0.05 && minD <= 1.5 + 0.2, `${shape}/${pattern}: Steg ${minD}`);
    // keine Überlappung
    const u = polygonClipping.union(...r.holes.map(h => [h] as [XY[]]) as [[XY[]]]);
    assert.equal(u.length, r.holes.length);
  }
});

test("Platte, Befestigungslöcher, offene Fläche", () => {
  const r = vent(base);
  assert.ok(r.outline && r.outline.length > 4);
  assert.equal(r.mounts.length, 4);
  // Befestigungsloch links unten bei (−54, −34)
  const c = r.mounts[0].slice(0, -1).reduce((s, p, _, a) => [s[0] + p[0] / a.length, s[1] + p[1] / a.length] as XY, [0, 0] as XY);
  assert.ok(Math.abs(c[0] + 54) < 1e-6 && Math.abs(c[1] + 34) < 1e-6);
  for (const h of r.holes) for (const [x, y] of h) assert.ok(Math.hypot(x + 54, y + 34) >= 2 + 1.5 - 1e-6);
  assert.ok(r.openArea > 40 && r.openArea < 80, `offen ${r.openArea}`);
  assert.equal(vent({ ...base, plate: false }).outline, null);
});

test("Hinweise", () => {
  assert.ok(vent({ ...base, size: 200 }).warnings.includes("vent.warnNone"));
  assert.ok(vent({ ...base, web: 0.5 }).warnings.includes("vent.warnWeb"));
});
