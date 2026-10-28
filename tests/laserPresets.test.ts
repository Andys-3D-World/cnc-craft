// Tests für die Laser-Material-Vorlagen (auch Faserlaser) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, LASER_KINDS, presetValues } from "../src/laserPresets.ts";

test("jede Vorlage passt zu mindestens einer Laserart, Kennungen eindeutig", () => {
  assert.equal(new Set(PRESETS.map(p => p.id)).size, PRESETS.length);
  for (const p of PRESETS) assert.ok(LASER_KINDS.some(k => p[k]), p.id);
  assert.ok(PRESETS.filter(p => p.fiber).length >= 8, "Metall-Vorlagen für Faserlaser");
});

test("Faserlaser: Umrechnung auf 20 / 30 / 50 W bleibt in sinnvollen Grenzen", () => {
  for (const p of PRESETS.filter(x => x.fiber)) {
    for (const w of [20, 30, 50, 100]) {
      const v = presetValues(p, "fiber", w)!;
      assert.ok(v.power >= 10 && v.power <= 100, `${p.id} ${w} W Leistung ${v.power}`);
      assert.ok(v.speed >= 3000 && v.speed <= 600000, `${p.id} ${w} W Geschwindigkeit ${v.speed}`);
    }
    // stärkere Quelle graviert bei gleicher Geschwindigkeit mit weniger Leistung
    const a = presetValues(p, "fiber", 20)!, b = presetValues(p, "fiber", 50)!;
    assert.ok(b.power <= a.power, p.id);
  }
});

test("Holz & Co. gibt es nicht für den Faserlaser", () => {
  assert.equal(presetValues(PRESETS.find(p => p.id === "ply3c")!, "fiber", 30), null);
});
