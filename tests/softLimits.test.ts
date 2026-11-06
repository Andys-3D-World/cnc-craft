// Maschinengrenzen vor dem Jobstart
import { test } from "node:test";
import assert from "node:assert/strict";
import { arcExtents, axisRange, checkLimits, scanJobExtents } from "../src/softLimits.ts";

const start = { wpos: [0, 0, 0], wco: [0, 0, 0], activeWcs: "G54" };
const env = (o: any = {}) => ({ travel: [300, 200, 80], homeDirMask: 0, pulloff: 1, homed: true, mpos: [-150, -100, -10], wpos: [0, 0, 0], ...o });

test("Grenzen über alle Achsen, auch Eilgang", () => {
  const e = scanJobExtents(["G21 G90", "G0 X10 Y-5 Z5", "G1 Z-3 F100", "X50"], start);
  assert.deepEqual(e.min, [10, -5, -3]);
  assert.deepEqual(e.max, [50, -5, 5]);
  assert.deepEqual(e.used, [true, true, true]);
  assert.deepEqual(e.notes, []);
});

test("Zoll und relative Fahrt ab der aktuellen Position", () => {
  const e = scanJobExtents(["G20", "G91", "G0 X1", "G0 X1"], { wpos: [100, 0, 0] });
  assert.ok(Math.abs(e.max[0] - 150.8) < 1e-9);
  assert.equal(e.used[1], false);
});

test("Bogen ragt über Start und Ziel hinaus (auch R-Schreibweise und G18)", () => {
  // Halbkreis im Uhrzeigersinn von (0,0) nach (20,0) um (10,0): oben bis Y=10
  let e = scanJobExtents(["G0 X0 Y0", "G2 X20 Y0 I10 J0"], start);
  assert.ok(Math.abs(e.max[1] - 10) < 1e-9);
  assert.ok(Math.abs(e.min[1]) < 1e-9);
  e = scanJobExtents(["G0 X0 Y0", "G3 X20 Y0 I10 J0"], start);
  assert.ok(Math.abs(e.min[1] + 10) < 1e-9);
  e = scanJobExtents(["G0 X0 Y0", "G2 X20 Y0 R10"], start);
  assert.ok(Math.abs(e.max[1] - 10) < 1e-6);
  // Vollkreis
  assert.deepEqual(arcExtents(10, 0, 10, 0, 0, 0, true), [-10, 10, -10, 10]);
  // G18: Bogen in Z/X reicht in Z, nicht in Y
  e = scanJobExtents(["G18", "G0 X0 Y0 Z0", "G2 X20 Z0 I10 K0"], start);
  assert.equal(e.max[1], 0);
  assert.ok(Math.abs(e.max[2]) > 9.99 || Math.abs(e.min[2]) > 9.99);
});

test("G53 zählt als Maschinen-Koordinate, nicht als Werkstück", () => {
  const e = scanJobExtents(["G0 X10", "G53 G0 Z-2", "G0 X20"], { wpos: [0, 0, 0], wco: [-100, 0, -50], activeWcs: "G54" });
  assert.equal(e.used[2], false);
  assert.deepEqual([e.machMin[2], e.machMax[2]], [-2, -2]);
  assert.equal(e.max[0], 20);
  // relative Fahrt danach geht vom umgerechneten Punkt aus
  const r = scanJobExtents(["G53 G0 Z-2", "G91", "G0 Z1"], { wpos: [0, 0, 0], wco: [0, 0, -50], activeWcs: "G54" });
  assert.equal(r.max[2], 49);
});

test("Was nicht berechenbar ist, wird gemeldet und nicht falsch gezählt", () => {
  let e = scanJobExtents(["G0 X10", "G92 X0", "G0 X500"], start);
  assert.ok(e.notes.includes("offsets"));
  assert.equal(e.max[0], 10);
  e = scanJobExtents(["G10 L20 P0 X0", "G0 X500"], start);
  assert.ok(e.notes.includes("offsets"));
  assert.equal(e.used[0], false);
  e = scanJobExtents(["G55", "G0 X500"], start);
  assert.ok(e.notes.includes("wcs"));
  assert.equal(e.used[0], false);
  e = scanJobExtents(["G54", "G0 X500"], start);
  assert.deepEqual(e.notes, []);
  assert.equal(e.max[0], 500);
  e = scanJobExtents(["G28", "G91", "G0 X5"], start);
  assert.ok(e.notes.includes("homeMove") && e.notes.includes("relative"));
  assert.equal(e.used[0], false);
  e = scanJobExtents(["G38.2 Z-50 F100", "G91", "G0 Z5"], start);
  assert.ok(e.notes.includes("probe") && e.notes.includes("relative"));
  assert.equal(e.used[2], false);
  e = scanJobExtents(["G81 X1 Y1 Z-5 R2 F100"], start);
  assert.ok(e.notes.includes("cycle"));
  assert.equal(e.used[0], false);
});

test("Kommentare, $-Zeilen und G10-Z-Wörter zählen nicht", () => {
  const e = scanJobExtents(["(G0 X999)", "$J=G91 X999", "G0 X1 ; X999", "G4 P5"], start);
  assert.equal(e.max[0], 1);
});

test("Z nach Werkzeugwechsel läuft getrennt und sperrt nicht", () => {
  const e = scanJobExtents(["G0 Z5", "G1 Z-1 F100", "M0 (tool)", "G0 Z50"], start);
  assert.deepEqual([e.min[2], e.max[2]], [-1, 5]);
  assert.deepEqual(e.zLater, { min: 50, max: 50 });
  const r = checkLimits(e, env({ mpos: [-150, -100, -10], wpos: [0, 0, 0] }));
  assert.deepEqual(r.over, []);
  assert.deepEqual(r.zLaterOver.map(o => [o.axis, o.kind]), [["Z", "+"]]);
});

test("Bereich: normaler GRBL negativ, auch mit $23", () => {
  assert.deepEqual(axisRange(300, -150, false), [-300, 0]);
  assert.deepEqual(axisRange(300, -150, true), [-300, 0]);   // $23 ändert hier nur die Referenz-Seite
  assert.deepEqual(axisRange(300, -1, false), [-300, 0]);    // direkt nach der Referenz
  assert.equal(axisRange(300, 0, true), null);               // nahe 0 + umgekehrt: beide Lagen möglich
  assert.deepEqual(axisRange(300, 150, true), [0, 300]);     // Nullpunkt an der Referenz
  assert.equal(axisRange(300, 150, false), null);            // positiv ohne $23: passt zu nichts → nicht raten
  assert.equal(axisRange(300, -500, false), null);           // außerhalb: nicht referenziert
  assert.equal(axisRange(0, -10, false), null);
  assert.equal(axisRange(NaN, -10, false), null);
});

test("WCO wird eingerechnet: Nullpunkt im Maschinen-Raum", () => {
  // Werkstück-Null bei Maschine −250/−150/−20: Job X0…X100 → −250…−150, alles frei
  const ok = scanJobExtents(["G0 X0 Y0 Z2", "G1 X100 Y50 Z-5 F100"], { wpos: [10, 0, 5], activeWcs: "G54" });
  const base = { mpos: [-240, -150, -15], wpos: [10, 0, 5] };
  assert.deepEqual(checkLimits(ok, env(base)).over, []);
  // X300: Maschine +50 → 50 mm zu weit in +
  const far = scanJobExtents(["G0 X300 Y0"], { wpos: [10, 0, 5], activeWcs: "G54" });
  const r = checkLimits(far, env(base));
  assert.deepEqual(r.over.map(o => [o.axis, o.kind, Math.round(o.by)]), [["X", "+", 50]]);
  // X−60: Maschine −310 → 10 mm zu weit in −
  const low = scanJobExtents(["G0 X-60"], { wpos: [10, 0, 5], activeWcs: "G54" });
  assert.deepEqual(checkLimits(low, env(base)).over.map(o => [o.axis, o.kind, Math.round(o.by)]), [["X", "-", 10]]);
});

test("Z über dem Nullpunkt, wenn Z oben referenziert ist", () => {
  // Z-Null 2 mm unter der Referenz: Sicherheitshöhe 5 fährt 3 mm in den Endschalter
  const e = scanJobExtents(["G0 Z5", "G1 Z-1 F100"], { wpos: [0, 0, 0], activeWcs: "G54" });
  const r = checkLimits(e, env({ mpos: [-150, -100, -2], wpos: [0, 0, 0] }));
  assert.deepEqual(r.over.map(o => [o.axis, o.kind, Math.round(o.by)]), [["Z", "+", 3]]);
});

test("Positiver Maschinen-Raum mit $23: gleiche Rechnung, andere Grenzen", () => {
  const e = scanJobExtents(["G0 X100", "G0 X200"], { wpos: [50, 0, 0], activeWcs: "G54" });
  const r = checkLimits(e, env({ homeDirMask: 1, mpos: [150, -100, -10], wpos: [50, 0, 0] }));
  assert.deepEqual(r.over.map(o => [o.axis, o.kind, Math.round(o.by)]), [["X", "+", 0]].slice(1)); // 300 = genau die Grenze
  const r2 = checkLimits(scanJobExtents(["G0 X250"], { wpos: [50, 0, 0], activeWcs: "G54" }), env({ homeDirMask: 1, mpos: [150, -100, -10], wpos: [50, 0, 0] }));
  assert.deepEqual(r2.over.map(o => [o.axis, o.kind, Math.round(o.by)]), [["X", "+", 50]]);
  const r3 = checkLimits(scanJobExtents(["G0 X-150"], { wpos: [50, 0, 0], activeWcs: "G54" }), env({ homeDirMask: 1, mpos: [150, -100, -10], wpos: [50, 0, 0] }));
  assert.deepEqual(r3.over.map(o => [o.axis, o.kind, Math.round(o.by)]), [["X", "-", 50]]);
});

test("Nicht referenziert: nur Warnung – außer der Job ist breiter als der Weg", () => {
  const near = scanJobExtents(["G0 X500", "G0 X600"], start);
  let r = checkLimits(near, env({ homed: false, mpos: [0, 0, 0] }));
  assert.equal(r.notHomed, true);
  assert.deepEqual(r.over, []);
  const wide = scanJobExtents(["G0 X0", "G0 X310"], start);
  r = checkLimits(wide, env({ homed: false, mpos: [0, 0, 0] }));
  assert.deepEqual(r.over.map(o => [o.axis, o.kind, Math.round(o.by)]), [["X", "span", 10]]);
});

test("Fehlende Einstellungen und unklare Lage: warnen, nicht sperren", () => {
  const e = scanJobExtents(["G0 X9999"], start);
  let r = checkLimits(e, env({ travel: [NaN, NaN, NaN] }));
  assert.deepEqual(r.over, []);
  assert.deepEqual(r.noSettings, ["X"]);
  r = checkLimits(e, env({ homeDirMask: 1, mpos: [0, -100, -10] }));
  assert.deepEqual(r.over.filter(o => o.kind !== "span").length, 0);
  assert.deepEqual(r.unknownAxes, ["X"]);
});

test("G53 außerhalb wird erkannt; ungenutzte Achsen und Drehachse bleiben außen vor", () => {
  const e = scanJobExtents(["G53 G0 Z5", "G0 Y9999"], start);
  const r = checkLimits(e, env({ skip: [1] }));
  assert.deepEqual(r.over.map(o => [o.axis, o.kind, o.by]), [["Z", "+", 5]]);
});

test("Geschwindigkeit: eine Million Zeilen unter 3 s", () => {
  const lines = Array.from({ length: 1_000_000 }, (_, i) => `G1 X${(i % 100).toFixed(3)} Y${(i % 77).toFixed(3)} Z-1.000 F1200`);
  const t0 = Date.now();
  scanJobExtents(lines, start);
  assert.ok(Date.now() - t0 < 3000);
});
