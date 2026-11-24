// Tests: Belastung, G-Code nachschlagen/einfärben, Anhalten in der Simulation, Beispiele – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { cutLoad } from "../src/cutLoad.ts";
import { GCODE_REF, lineHtml, refFor, tokenize } from "../src/gcodeRef.ts";
import { haltLines, nextStop, scaledTime, stepLine } from "../src/sim/simStops.ts";
import { EXAMPLES, SNIPPETS } from "../src/sim/examples.ts";
import { parseGcodeProgram } from "../src/sim/gcodeParser.ts";
import { lintGcode } from "../src/gcodeLint.ts";
import { readFileSync } from "node:fs";
import { coneHeight } from "../src/toolGraphics.ts";
import { profile } from "../src/view3d/carveSim.ts";

const mill = { type: "endmill" as const, diameter: 4, flutes: 1, fluteLen: 12, rpm: 12000, feedrate: 840, stepZ: 1.5 };

test("Belastung: von Hand gerechnet (Alu, 4 mm, volle Nut)", () => {
  const r = cutLoad(mill, "alu", { fz: 0.024, stepZ: 0.8 }, 500, 24000)!;
  assert.ok(Math.abs(r.fz - 0.07) < 1e-9);
  assert.ok(Math.abs(r.q - 5.04) < 1e-9);                     // 1,5 × 4 × 840 = 5040 mm³/min
  const f = Math.pow(0.07 * 2 / Math.PI, -0.25);              // ≈ 2,177
  assert.ok(Math.abs(r.watt![0] - 5040 * 350 * f / 60000) < 1e-6);
  assert.ok(r.watt![0] > 60 && r.watt![0] < 68);
  assert.equal(r.avail, 250);                                 // halbe Drehzahl = halbe Leistung
  assert.deepEqual(r.warn, ["fast"]);                         // fz 0,07 > 2 × 0,024; 1,5 < 2 × 0,8
});

test("Belastung: Warnungen und wo es keine Aussage gibt", () => {
  assert.deepEqual(cutLoad({ ...mill, feedrate: 60 }, "alu", { fz: 0.024, stepZ: 1.5 })!.warn, ["rub"]);
  assert.deepEqual(cutLoad({ ...mill, stepZ: 13 }, "softwood", { fz: 0.07, stepZ: 4 })!.warn, ["deep", "flute"]);
  assert.deepEqual(cutLoad(mill, "alu", { fz: 0.07, stepZ: 1.5 }, 100, 24000)!.warn, ["power"]);
  assert.equal(cutLoad(mill, "softwood", { fz: 0.07, stepZ: 4 }, 100)!.watt, null);
  assert.equal(cutLoad(mill, "constructor", { fz: 0.07, stepZ: 4 })!.watt, null);
  assert.equal(cutLoad({ ...mill, type: "drill" }, "alu", { fz: 0.07, stepZ: 4 }), null);
  assert.equal(cutLoad({ ...mill, rpm: 0 }, "alu", { fz: 0.07, stepZ: 4 }), null);
});

test("Nachschlagen: Schreibweisen und Gruppen", () => {
  assert.equal(refFor("g", "01")!.id, "G1");
  assert.equal(refFor("G", "55")!.id, "G54");
  assert.equal(refFor("G", "38.4")!.id, "G38_2");
  assert.equal(refFor("G", "92.1")!.id, "G92_1");
  assert.equal(refFor("X", "-3")!.id, "X");
  assert.equal(refFor("G", "187"), null);
  assert.equal(new Set(GCODE_REF.map(r => r.id)).size, GCODE_REF.length);
});

test("Nachschlagen: jeder Eintrag hat in jeder Sprache einen Text", () => {
  for (const l of ["de", "en", "es", "fr", "it", "nl", "pl"]) {
    const d = JSON.parse(readFileSync(new URL(`../src/i18n/lang/${l}.json`, import.meta.url), "utf8"));
    for (const r of GCODE_REF) assert.ok(d["gref." + r.id], `${l} gref.${r.id}`);
    for (const x of EXAMPLES) assert.ok(d["sim.ex." + x.id], `${l} ${x.id}`);
    for (const x of SNIPPETS) assert.ok(d["sim.sn." + x.id], `${l} ${x.id}`);
  }
});

test("Einfärben: Stücke ergeben wieder die Zeile, fremder Text wird maskiert", () => {
  for (const l of ["G01X1.5Y-2 (a <b>) F200", "N10 G0 Z5 ; x", "$H", "%", "", "G1 X#1 [2+3]", "(offen G0", "abc <img src=x onerror=1> \"'&", "T1M6"]) {
    assert.equal(tokenize(l).map(k => k.text).join(""), l);
  }
  const h = lineHtml(`G1 X5 (<script>"x") <img>`, r => `"${r.id}<`);
  assert.ok(!h.includes("<script") && !h.includes("<img"));
  assert.ok(h.includes(`data-tip="&quot;G1&lt;"`));
  assert.deepEqual(tokenize("G0 G1 M3 X1 I2 F3 T4 P5").filter(k => k.letter).map(k => k.kind), ["g0", "g", "m", "axis", "arc", "feed", "tool", "word"]);
});

const src = ["G21 G90", "M3 S1", "G1 X10 F600", "G1 X20", "M0 (wechseln)", "G1 X30", "G2 X40 Y0 I5 J0", "M5"];
const p = parseGcodeProgram(src);
const none = { single: false, breaks: new Set<number>(), halts: [] as number[] };

test("M0/M1 erkennen, nicht M10 oder Kommentar", () => {
  assert.deepEqual(haltLines(["M0", "M00 (x)", "m1", "M 01", "M10", "M100", "(M0)", "G0 X1 ; M1", "G4 P1 M0", "M0.5"]), [0, 1, 2, 3, 8]);
});

test("Haltepunkt hält vor der Zeile, M0 an seiner Stelle, danach geht es weiter", () => {
  const t3 = p.t0[1];
  assert.deepEqual(nextStop(p, 0, p.totalTime, { ...none, breaks: new Set([3]) }), { time: t3, line: 3, why: "break" });
  assert.equal(nextStop(p, t3, p.totalTime, { ...none, breaks: new Set([3]) }), null);
  assert.equal(nextStop(p, t3 - 1e-6, p.totalTime, { ...none, breaks: new Set([3]) }), null);
  assert.deepEqual(nextStop(p, 0, p.totalTime, { ...none, halts: haltLines(src) }), { time: p.t0[2], line: 4, why: "halt" });
  assert.equal(nextStop(p, 0, t3 / 2, { ...none, breaks: new Set([3]) }), null);
  assert.equal(nextStop(p, 0, p.totalTime, { ...none, breaks: new Set([2, 99, -1]) }), null); // erste Zeile: schon dort
  assert.equal(nextStop(p, 0, p.totalTime, { single: false, breaks: new Set([5, 3]), halts: [4] })!.line, 3);
});

test("Einzelsatz: jede Zeile einzeln, ein Bogen ist eine Zeile, Ende ist das Ende", () => {
  let now = 0; const seen: number[] = [];
  for (let k = 0; k < 10; k++) {
    const s = nextStop(p, now, p.totalTime, { ...none, single: true });
    if (!s) break;
    seen.push(s.line); now = s.time;
  }
  assert.deepEqual(seen, [3, 5, 6, 6]);
  assert.equal(now, p.totalTime);
});

test("Zeile vor und zurück", () => {
  const at = (t: number) => { let i = 0; while (i + 1 < p.n && p.t0[i + 1] <= t) i++; return p.line[i]; };
  let t = 0; const fwd: number[] = [];
  for (let k = 0; k < 4; k++) { t = stepLine(p, t, 1); fwd.push(at(t)); }
  assert.deepEqual(fwd, [2, 3, 5, 6]);
  t = stepLine(p, t, -1); assert.equal(at(t), 5);
  t = stepLine(p, t, -1); assert.equal(at(t), 3);
  assert.equal(stepLine(p, 0, -1), 0);
  assert.equal(stepLine(parseGcodeProgram(["M5"]), 0, 1), 0);
});

test("Vorschub-Regler: Eilgänge bleiben", () => {
  const q = parseGcodeProgram(["M3 S1", "G0 X100", "G1 X200 F600"], { rapidRate: 6000 });
  assert.ok(Math.abs(q.totalTime - 11) < 1e-4);
  assert.ok(Math.abs(scaledTime(q, 0.5) - 21) < 1e-4);
  assert.ok(Math.abs(scaledTime(q, 1) - q.totalTime) < 1e-9);
});

test("Beispiele sind sauber: Prüfung ohne Meldung, nichts Unbekanntes, bleiben im Material", () => {
  for (const x of EXAMPLES) {
    const q = parseGcodeProgram(x.lines);
    assert.deepEqual(lintGcode(x.lines.join("\n"), { kind: "mill" }).filter(i => !(x.id === "drilling")), [], x.id);
    assert.equal(q.notes, undefined, x.id);
    const b = q.bounds;
    assert.ok(b.minX >= 0 && b.maxX <= 60 && b.minY >= 0 && b.maxY <= 40 && b.minZ >= -8.001 && b.maxZ <= 5, `${x.id} ${JSON.stringify(b)}`);
    assert.ok(q.n > 8);
    assert.equal(x.lines[x.lines.length - 1], "M30");
  }
});

test("Anbohrer hat einen Kegel, Reibahle ist gerade", () => {
  const g = { diameter: 6, shankDia: 6, fluteLen: 10, length: 50, flutes: 2, helix: "straight" as const, angle: 90, tipDia: 0, cornerR: 0 };
  assert.ok(Math.abs(coneHeight({ ...g, type: "spotdrill" }) - 3) < 1e-9);
  assert.equal(coneHeight({ ...g, type: "reamer" }), 0);
  assert.ok(Math.abs(profile({ ...g, type: "spotdrill" })(2) - 2) < 1e-9);
  assert.equal(profile({ ...g, type: "reamer" })(2), 0);
});
