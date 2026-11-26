// Werkzeugmagazin – läuft mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanMagazine, cleanOutput, forgetTests, getSteps, lookSteps, MAX_SLOTS, needsSteps, putSteps, rackBlocked, rackBox, rackProblem, runsOn, slotForTool, toolNumbersIn, type Magazine, type Step } from "../src/magazine.ts";

const slot = (n: number, o: any = {}) => ({ n, toolId: "t" + n, x: -100 * n, y: -10, z: -80, set: true, okGet: false, okPut: false, ...o });
const mag = (o: any = {}): Magazine => cleanMagazine({ kind: "rack", entry: "top", dir: "y-", slide: 40, approach: 15, zClear: -5, open: "M64 P0", close: "M65 P0", openS: 1, spinS: 8, inSpindle: 1, slots: [slot(1), slot(2)], ...o });

test("Nur freie Ausgänge dürfen den Spanner schalten", () => {
  assert.equal(cleanOutput("m64 p3"), "M64 P3");
  assert.equal(cleanOutput("M65P0"), "M65 P0");
  for (const bad of ["M8", "M9", "M7", "M3 S100", "M62 P0", "M64", "M64 P0 G0 X5", "M64 P0\nM3", "$X", 5, null, "M64 P123"]) assert.equal(cleanOutput(bad), "", String(bad));
});

test("Reihenfolge: Spanner auf nur bei stehender Höhe, nie Z tiefer als der Platz, zum Schluss hoch", () => {
  for (const entry of ["top", "fork"]) for (const dir of ["x+", "x-", "y+", "y-"]) {
    const m = mag({ entry, dir }), s = m.slots[0];
    for (const steps of [getSteps(m, s), putSteps(m, s), lookSteps(m, s)]) {
      assert.deepEqual(steps[0], { k: "up", z: m.zClear });
      assert.ok(steps.some(x => x.k === "up" && steps.indexOf(x) > 1));
      let z = m.zClear, xy: any = null;
      for (const x of steps) {
        if (x.k === "up") z = x.z;
        if (x.k === "z") { assert.ok(x.z >= s.z - 1e-9 && x.z <= m.zClear); assert.deepEqual(x.at, xy, "nach unten nur dort, wo die Maschine steht"); z = x.z; }
        if (x.k === "xy") {
          if (z < m.zClear) { assert.ok(x.at, "quer unten nur als Einfahrt"); assert.deepEqual([x.at!.x, x.at!.y, x.at!.z], [xy.x, xy.y, z]); assert.equal(x.feed, m.slow); }
          xy = { x: x.x, y: x.y };
        }
      }
      assert.equal(z, m.zClear);
      // nach „auf“ wird immer wieder „zu“ geschaltet
      const outs = steps.filter(x => x.k === "out").map((x: any) => x.what);
      assert.ok(outs.length === 0 || (outs[0] === "open" && outs[outs.length - 1] === "close" && outs.length === 2));
    }
  }
});

test("Holen: Spanner auf über dem Platz, zu erst ganz unten", () => {
  const m = mag(), st = getSteps(m, m.slots[0]).map((x: Step) => x.k === "out" ? x.what : x.k === "z" ? x.z : x.k);
  assert.deepEqual(st, ["up", "xy", "open", -65, -80, "close", -65, "up"]);
  const p = putSteps(m, m.slots[0]).map((x: Step) => x.k === "out" ? x.what : x.k === "z" ? x.z : x.k);
  assert.deepEqual(p, ["up", "xy", -65, -80, "open", -65, "up", "close"]);
});

test("Gabel: Ablegen fährt von der offenen Seite ein, Holen dorthin aus", () => {
  const m = mag({ entry: "fork", dir: "y-" }), s = m.slots[0];
  const p = putSteps(m, s).filter((x): x is any => x.k === "xy");
  assert.deepEqual([p[0].x, p[0].y], [-100, -50]);
  assert.deepEqual([p[1].x, p[1].y], [-100, -10]);
  const g = getSteps(m, s).filter((x): x is any => x.k === "xy");
  assert.deepEqual([g[0].x, g[0].y], [-100, -10]);
  assert.deepEqual([g[1].x, g[1].y], [-100, -50]);
});

test("Prüfung der Einstellungen", () => {
  assert.equal(rackProblem(mag()).why, "");
  assert.equal(rackProblem(mag({ open: "M8" })).why, "outputs");
  assert.equal(rackProblem(mag({ close: "M64 P0" })).why, "same");
  assert.equal(rackProblem(mag({ slots: [] })).why, "noSlot");
  assert.deepEqual(rackProblem(mag({ slots: [slot(1), slot(2, { set: false })] })), { why: "unset", n: 2 });
  assert.equal(rackProblem(mag({ zClear: -70 })).why, "clear");
  assert.equal(rackProblem(mag({ slots: [slot(1), slot(2, { x: -101 })] })).why, "near");
  assert.equal(rackProblem(mag({ slots: [slot(1), slot(2, { toolId: "t1" })] })).why, "double");
});

test("Sperren: Steuerung, Referenzfahrt, Sensor, unbekannte Spindel", () => {
  const ok = { grbl: true, firmware: "grblHAL", homed: true, inches: false, sensor: true };
  assert.equal(rackBlocked(mag(), ok).why, "");
  assert.equal(rackBlocked(mag(), { ...ok, firmware: "FluidNC" }).why, "");
  assert.equal(rackBlocked(mag(), { ...ok, firmware: "GRBL" }).why, "firmware");
  assert.equal(rackBlocked(mag(), { ...ok, grbl: false }).why, "grbl");
  assert.equal(rackBlocked(mag(), { ...ok, homed: false }).why, "home");
  assert.equal(rackBlocked(mag(), { ...ok, inches: true }).why, "inch");
  assert.equal(rackBlocked(mag(), { ...ok, sensor: false }).why, "sensor");
  assert.equal(rackBlocked(mag({ inSpindle: -1 }), ok).why, "spindle");
  assert.equal(rackBlocked(mag({ inSpindle: 0 }), ok).why, "");
});

test("Ungeprüfte Plätze fragen bei jedem Schritt, Änderungen verlangen neue Prüfung", () => {
  const m = mag({ slots: [slot(1, { okGet: true, okPut: true }), slot(2, { okGet: true, okPut: true })] });
  assert.equal(needsSteps(m, m.slots[0], "get"), false);
  assert.equal(needsSteps({ ...m, always: true }, m.slots[0], "put"), true);
  assert.equal(needsSteps(mag(), mag().slots[0], "get"), true);
  const one = forgetTests(m, { ...m, slots: [{ ...m.slots[0], z: -79 }, m.slots[1]] });
  assert.deepEqual(one.slots.map(s => s.okGet), [false, true]);
  assert.deepEqual(forgetTests(m, { ...m, zClear: -4 }).slots.map(s => s.okPut), [false, false]);
  assert.deepEqual(forgetTests(m, { ...m, inSpindle: 2, slots: [{ ...m.slots[0], toolId: "x" }, m.slots[1]] }).slots.map(s => s.okPut), [true, true]);
});

test("Ohne Klick weiter nur auf Wunsch und nur mit geprüften Plätzen", () => {
  const ok = { okGet: true, okPut: true }, m = mag({ auto: true, slots: [slot(1, ok), slot(2, ok)] });
  assert.equal(runsOn(m, m.slots[1]), true);
  assert.equal(runsOn({ ...m, auto: false }, m.slots[1]), false);
  assert.equal(runsOn({ ...m, always: true }, m.slots[1]), false);
  assert.equal(runsOn({ ...m, inSpindle: 0 }, m.slots[1]), false);
  assert.equal(runsOn(mag({ auto: true, slots: [slot(1, ok), slot(2)] }), slot(2) as any), false);
});

test("Gespeichertes wird geprüft", () => {
  assert.equal(cleanMagazine(null).kind, "off");
  assert.equal(cleanMagazine({ kind: "auto" }).kind, "off");
  assert.equal(cleanMagazine({ inSpindle: 7 }).inSpindle, -1);
  const m = cleanMagazine({ kind: "rack", spinS: 0, slots: [{ n: 1.5 }, { n: 2, x: "1", y: 0, z: 0, set: true, okGet: true, toolId: "<b>" }, { n: 2 }, ...Array.from({ length: 60 }, (_, i) => ({ n: i + 3 }))] });
  assert.equal(m.slots.length, MAX_SLOTS);
  assert.deepEqual(m.slots[0], { n: 2, toolId: "", x: 0, y: 0, z: 0, set: false, okGet: false, okPut: false });
  assert.equal(m.spinS, 8, "Wartezeit nach Spindel aus nie unter 3 s");
});

test("Werkzeug → Platz, Nummern im Programm", () => {
  assert.equal(slotForTool(mag(), "t2")!.n, 2);
  assert.equal(slotForTool(mag({ kind: "off" }), "t2"), null);
  assert.equal(slotForTool(mag(), ""), null);
  assert.deepEqual(toolNumbersIn(["G0 X1", "M6 T3 (x)", "T5", "M06", "M6 T3", "(M6 T9)", "M60"]), [3, 5]);
  assert.deepEqual(toolNumbersIn(["M6"]), [0]);
});

test("Reihe in der Zeichnung: Maschine minus Nullpunkt, mit Einfahrt der Gabel", () => {
  const z = { x: -300, y: -50 };
  assert.deepEqual(rackBox(mag({ size: 20 }), z), { x0: 90, y0: 30, x1: 210, y1: 50 });
  assert.deepEqual(rackBox(mag({ size: 20, entry: "fork", dir: "y-" }), z, true), { x0: 90, y0: -10, x1: 210, y1: 50 });
  assert.equal(rackBox(mag({ slots: [slot(1, { set: false })] }), z), null);
  const m = mag({ slots: [slot(1, { okGet: true, okPut: true })] });
  assert.equal(forgetTests(m, { ...m, size: 50, top: 80 }).slots[0].okGet, true, "nur Anzeige: keine neue Prüfung");
});
