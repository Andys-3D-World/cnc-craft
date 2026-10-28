// Tests für die Ecken-Leistung (Laser mit M3) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { cornerPowerPath, junctionSpeed } from "../src/cornerPower.ts";

const o = { accel: 1000, deviation: 0.02, minPct: 20 };

test("Kurvengeschwindigkeit: geradeaus voll, rechter Winkel langsamer, Umkehr fast 0", () => {
  const v = 50;
  assert.equal(junctionSpeed({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, v, o), v);
  const right = junctionSpeed({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, v, o);
  assert.ok(right > 1 && right < 10, String(right));
  const back = junctionSpeed({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0.0001 }, v, o);
  assert.ok(back < 0.5, String(back));
});

test("Quadrat: an den Ecken weniger Leistung, auf der Geraden volle, nie unter dem Minimum", () => {
  const sq = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }];
  const m = cornerPowerPath(sq, true, 3000, 1000, o);
  const s = m.map(p => p.s);
  assert.equal(Math.max(...s), 1000);
  assert.ok(Math.min(...s) < 500, "an den Ecken deutlich weniger");
  assert.ok(Math.min(...s) >= 200, "nicht unter 20 %");
  // endet wieder am Start, alle Ecken werden getroffen
  const last = m[m.length - 1];
  assert.deepEqual([last.x, last.y], [0, 0]);
  for (const c of [[50, 0], [50, 50], [0, 50]]) assert.ok(m.some(p => Math.abs(p.x - c[0]) < 1e-6 && Math.abs(p.y - c[1]) < 1e-6), String(c));
});

test("langsamer Vorschub: Bremsweg winzig – keine Teilung, volle Leistung", () => {
  const m = cornerPowerPath([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }], false, 60, 800, o);
  assert.equal(m.length, 2);
  assert.ok(m.every(p => p.s === 800));
});

test("kurze Strecke: Beschleunigen und Bremsen treffen sich (keine Stücke außerhalb)", () => {
  const m = cornerPowerPath([{ x: 0, y: 0 }, { x: 2, y: 0 }], false, 6000, 1000, o);
  assert.ok(m.every(p => p.x > 0 && p.x <= 2 + 1e-9));
  assert.equal(m[m.length - 1].x, 2);
  assert.ok(Math.max(...m.map(p => p.s)) < 1000, "volle Geschwindigkeit wird nie erreicht");
});
