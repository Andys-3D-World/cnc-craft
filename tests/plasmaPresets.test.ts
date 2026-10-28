// Tests für die Plasma-Material-Vorlagen – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { PLASMA_PRESETS, PLASMA_AMPS } from "../src/plasmaPresets.ts";

test("Kennungen eindeutig, alle Werte sinnvoll", () => {
  assert.equal(new Set(PLASMA_PRESETS.map(p => p.id)).size, PLASMA_PRESETS.length);
  for (const p of PLASMA_PRESETS) {
    assert.ok(PLASMA_AMPS.includes(p.amps), p.id);
    assert.ok(p.speed >= 100 && p.speed <= 10000, p.id);
    assert.ok(p.kerf > 0.5 && p.kerf < 4, p.id);
    assert.ok(p.pierceHeight > p.cutHeight, p.id + ": Einstechen höher als Schneiden");
    assert.ok(p.pierceDelay > 0 && p.pierceDelay < 5, p.id);
  }
});

test("dickeres Blech: langsamer, länger einstechen; mehr Strom: schneller", () => {
  const groups = new Map<string, typeof PLASMA_PRESETS>();
  for (const p of PLASMA_PRESETS) groups.set(p.mat + p.amps, [...(groups.get(p.mat + p.amps) || []), p]);
  for (const g of groups.values()) {
    const s = [...g].sort((a, b) => a.thick - b.thick);
    for (let i = 1; i < s.length; i++) {
      assert.ok(s[i].speed < s[i - 1].speed, s[i].id);
      assert.ok(s[i].pierceDelay >= s[i - 1].pierceDelay, s[i].id);
    }
  }
  for (const p of PLASMA_PRESETS.filter(x => x.amps === 40)) {
    const q = PLASMA_PRESETS.find(x => x.amps === 60 && x.mat === p.mat && x.thick === p.thick);
    if (q) assert.ok(q.speed > p.speed, q.id);
  }
});
