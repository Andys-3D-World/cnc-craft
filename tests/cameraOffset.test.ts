// Tests für Kamera-Offset und Fadenkreuz – laufen mit `npm test`
// Der wichtigste Teil ist das Vorzeichen: Ein falsches Vorzeichen setzt den Nullpunkt auf die falsche Seite.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseOffsetValue, offsetProblem, zeroAtCrosshairCommand, measureOffset, measureIsPlausible, drivePlan, hasArrived,
  topZFromSettings, zeroBlockReason, clampCentre, flipCentre, fittedRect, crosshairToPixel, pixelToCrosshair
} from "../src/camera/cameraOffset.ts";

// ---- kleine Nachbildung von GRBL: nur das Nötigste, damit die Tests die WIRKUNG prüfen und nicht nur den Text ----

/** Werkstück-Position = Maschinen-Position − Versatz des aktiven Systems */
const work = (mpos: number[], wco: number[]) => [mpos[0] - wco[0], mpos[1] - wco[1]];

/** G10 L20 P0: Versatz so setzen, dass die aktuelle Position die angegebene Koordinate hat. Achsen ohne Angabe bleiben */
function applyG10L20(cmd: string, mpos: number[], wco: number[]): number[] {
  const m = cmd.match(/^G10 L20 P0((?: [XYZ]-?\d+(?:\.\d+)?)+)$/);
  assert.ok(m, "kein gültiger G10-Befehl: " + cmd);
  const out = wco.slice();
  for (const part of m![1].trim().split(" ")) {
    const i = "XYZ".indexOf(part[0]);
    out[i] = mpos[i] - parseFloat(part.slice(1));
  }
  return out;
}

const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} statt ${b}`);

// ---- Vorzeichen ----

test("Beispiel von Hand gerechnet: Kamera 40 mm rechts, 10 mm vorne", () => {
  // Fadenkreuz = Werkzeug + Offset → Offset X = +40, Y = −10. Die aktuelle Position muss X−40 Y10 werden.
  assert.equal(zeroAtCrosshairCommand({ x: 40, y: -10 }), "G10 L20 P0 X-40.000 Y10.000");
});

test("WIRKUNG ohne Fahrt: Der Punkt unter dem Fadenkreuz wird wirklich 0/0", () => {
  for (const off of [{ x: 40, y: -10 }, { x: -25.5, y: 33.25 }, { x: 0, y: 12 }, { x: -7, y: 0 }]) {
    for (const wco of [[0, 0, 0], [-300, -200, -50], [120.5, -33.25, 0]]) {
      const mpos = [-150, -80, -20];
      const crosshair = [mpos[0] + off.x, mpos[1] + off.y]; // dieser Punkt soll der Nullpunkt werden
      const after = applyG10L20(zeroAtCrosshairCommand(off), mpos, wco);
      const [wx, wy] = work(crosshair, after);
      near(wx, 0, "X am Fadenkreuz"); near(wy, 0, "Y am Fadenkreuz");
      // und wer jetzt G0 X0 Y0 fährt, landet mit dem Werkzeug genau dort, wo das Fadenkreuz war
      near(after[0], crosshair[0], "Werkzeug bei X0"); near(after[1], crosshair[1], "Werkzeug bei Y0");
    }
  }
});

test("WIRKUNG mit Fahrt: gleicher Nullpunkt wie ohne Fahrt", () => {
  const off = { x: 40, y: -10 }, mpos = [-150, -80, -20], wco = [-300, -200, -30];
  const wpos = [mpos[0] - wco[0], mpos[1] - wco[1], mpos[2] - wco[2]];
  const plan = drivePlan(off, mpos, wpos, 5, null, { w: 400, h: 400 }, 1500);
  assert.deepEqual(plan.target, [-110, -90]);
  assert.equal(plan.zeroCmd, "G10 L20 P0 X0 Y0");
  const withDrive = applyG10L20(plan.zeroCmd, [plan.target[0], plan.target[1], mpos[2]], wco);
  const noDrive = applyG10L20(zeroAtCrosshairCommand(off), mpos, wco);
  near(withDrive[0], noDrive[0], "X"); near(withDrive[1], noDrive[1], "Y");
});

test("Messen und Setzen passen zusammen (ganze Kette)", () => {
  const realOffset = { x: 37.5, y: -12.25 };           // wie die Kamera wirklich sitzt
  const mark = [-200, -150, -10];                     // Werkzeug macht hier die Marke
  const cross = [mark[0] - realOffset.x, mark[1] - realOffset.y, -10]; // dort steht der Kopf, wenn das Fadenkreuz auf der Marke ist
  const measured = measureOffset(mark, cross);
  assert.deepEqual(measured, realOffset);
  // Nullpunkt aus dieser Stellung: Die Marke selbst wird 0/0
  const wco = applyG10L20(zeroAtCrosshairCommand(measured), cross, [0, 0, 0]);
  assert.deepEqual(work(mark, wco), [0, 0]);
});

test("Der Befehl fasst Z nie an und benutzt nie G92 oder ein festes System", () => {
  for (const off of [{ x: 1, y: 2 }, { x: 0, y: 0 }, { x: -1.5, y: 1000 }]) {
    const c = zeroAtCrosshairCommand(off);
    assert.ok(c.startsWith("G10 L20 P0 "), c);
    assert.ok(!/Z|G92|P[1-9]/.test(c), c);
    const p = drivePlan(off, [0, 0, 0], [0, 0, 0], 5, null, { w: 3000, h: 3000 }, 1000);
    assert.ok(!/Z|G92|P[1-9]/.test(p.zeroCmd), p.zeroCmd);
    assert.ok(!/Z/.test(p.moveCmd), p.moveCmd);
  }
});

test("keine „-0.000“ im Befehl", () => {
  assert.equal(zeroAtCrosshairCommand({ x: 0, y: 0 }), "G10 L20 P0 X0.000 Y0.000");
  assert.equal(zeroAtCrosshairCommand({ x: 0.0001, y: -0.0001 }), "G10 L20 P0 X0.000 Y0.000");
});

// ---- Eingabe und Warnungen ----

test("Eingabe: Komma, leer, Unsinn, zu groß", () => {
  assert.equal(parseOffsetValue("12,5"), 12.5);
  assert.equal(parseOffsetValue(" -3.25 "), -3.25);
  assert.equal(parseOffsetValue(7), 7);
  assert.equal(parseOffsetValue("-0"), 0);
  for (const bad of ["", null, undefined, "abc", "1e9", NaN, Infinity]) assert.equal(parseOffsetValue(bad), null, String(bad));
});

test("Warnung bei fehlendem oder 0-Offset", () => {
  assert.equal(offsetProblem(null, 3), "unset");
  assert.equal(offsetProblem(3, null), "unset");
  assert.equal(offsetProblem(0, 0), "zero");
  assert.equal(offsetProblem(0, 3), "");
  assert.equal(offsetProblem(-3, 0), "");
});

test("Messung ohne Bewegung zählt nicht", () => {
  assert.equal(measureIsPlausible(measureOffset([10, 10], [10, 10])), false);
  assert.equal(measureIsPlausible(measureOffset([10, 10], [10.01, 10])), false);
  assert.equal(measureIsPlausible(measureOffset([10, 10], [30, 5])), true);
  assert.equal(measureIsPlausible(measureOffset([5000, 0], [0, 0])), false);
});

// ---- Fahrt ----

const bed = { w: 400, h: 400 };

test("Fahrplan: Abstand und Befehle stimmen", () => {
  const p = drivePlan({ x: 30, y: -40 }, [-100, -100, -10], [100, 100, 2], 5, null, bed, 1500);
  assert.equal(p.dist, 50);
  assert.equal(p.lift, 3);
  assert.equal(p.liftTo, -7);
  assert.equal(p.liftCmd, "$J=G53 G21 Z-7.000 F1500");
  assert.equal(p.moveCmd, "$J=G91 G21 X30.000 Y-40.000 F1500");
  assert.deepEqual(p.outside, []);
});

test("Z fährt nur hoch, nie runter", () => {
  const high = drivePlan({ x: 1, y: 1 }, [0, 0, -5], [0, 0, 50], 5, null, bed, 1000);
  assert.equal(high.lift, 0);
  assert.equal(high.liftCmd, "");
  assert.equal(high.liftTo, -5);
});

test("Z bleibt unter dem Endschalter", () => {
  const p = drivePlan({ x: 1, y: 1 }, [0, 0, -3], [0, 0, 0], 5, -1, bed, 1000);
  assert.equal(p.liftTo, -1);
  assert.equal(p.lift, 2);
  // steht schon höher als die oberste Stelle: nicht runterfahren
  const q = drivePlan({ x: 1, y: 1 }, [0, 0, -0.5], [0, 0, 0], 5, -1, bed, 1000);
  assert.equal(q.lift, 0);
  assert.equal(q.liftCmd, "");
});

test("Ziel außerhalb des Betts wird gemeldet", () => {
  assert.deepEqual(drivePlan({ x: 50, y: 0 }, [0, 0, 0], [380, 10, 0], 5, null, bed, 1000).outside, [0]);
  assert.deepEqual(drivePlan({ x: 0, y: -50 }, [0, 0, 0], [10, 10, 0], 5, null, bed, 1000).outside, [1]);
  assert.deepEqual(drivePlan({ x: 10, y: 10 }, [0, 0, 0], [10, 10, 0], 5, null, bed, 1000).outside, []);
});

test("Ankunft: abgebrochene Fahrt zählt nicht", () => {
  assert.equal(hasArrived([10, 20], [10.01, 19.99]), true);
  assert.equal(hasArrived([9, 20], [10, 20]), false);
  assert.equal(hasArrived([10, 20.5], [10, 20]), false);
});

test("oberste Z-Höhe nur mit Referenzfahrt nach oben", () => {
  const set = (o: Record<string, string>) => new Map(Object.entries(o));
  assert.equal(topZFromSettings(set({ $22: "1", $23: "0", $27: "2.000" })), -2);
  assert.equal(topZFromSettings(set({ $22: "0", $23: "0" })), null);
  assert.equal(topZFromSettings(set({ $22: "1", $23: "4" })), null);
  assert.equal(topZFromSettings(set({})), null);
});

// ---- Sperren ----

test("gesperrt: nicht verbunden, andere Steuerung, Job, Alarm, beschäftigt, in Bewegung", () => {
  const ok = { connected: true, protocol: "grbl", jobActive: false, state: "Idle", otherBusy: false };
  assert.equal(zeroBlockReason(ok), "");
  assert.equal(zeroBlockReason({ ...ok, connected: false }), "notConnected");
  for (const p of ["marlin", "ruida", "k40"]) assert.equal(zeroBlockReason({ ...ok, protocol: p }), "notGrbl");
  assert.equal(zeroBlockReason({ ...ok, jobActive: true }), "job");
  assert.equal(zeroBlockReason({ ...ok, state: "Alarm" }), "alarm");
  assert.equal(zeroBlockReason({ ...ok, otherBusy: true }), "busy");
  for (const s of ["Run", "Hold", "Jog", "Home", "Door", "Check", "Sleep", ""]) assert.equal(zeroBlockReason({ ...ok, state: s }), "notIdle", s);
});

// ---- Fadenkreuz ----

test("Mitte: Unsinn wird 0, Rand begrenzt", () => {
  assert.equal(clampCentre("x"), 0);
  assert.equal(clampCentre(undefined), 0);
  assert.equal(clampCentre(0.9), 0.5);
  assert.equal(clampCentre(-3), -0.5);
  assert.equal(clampCentre(0.1), 0.1);
});

test("Drehen/Spiegeln: passt zum CSS im Kamerafenster", () => {
  // rotate(180deg) = X und Y umdrehen, scaleX(-1) = X umdrehen
  assert.deepEqual(flipCentre(0.1, 0.2, false, false), { x: 0.1, y: 0.2 });
  assert.deepEqual(flipCentre(0.1, 0.2, true, false), { x: -0.1, y: -0.2 });
  assert.deepEqual(flipCentre(0.1, 0.2, false, true), { x: -0.1, y: 0.2 });
  assert.deepEqual(flipCentre(0.1, 0.2, true, true), { x: 0.1, y: -0.2 });
});

test("Rand-Balken: Bild breiter/schmaler als die Anzeige", () => {
  assert.deepEqual(fittedRect(400, 400, 1600, 800), { x: 0, y: 100, w: 400, h: 200 });
  assert.deepEqual(fittedRect(400, 400, 800, 1600), { x: 100, y: 0, w: 200, h: 400 });
  assert.deepEqual(fittedRect(400, 300, 0, 0), { x: 0, y: 0, w: 400, h: 300 });
});

test("Fadenkreuz in der Mitte bleibt bei jeder Drehung in der Mitte", () => {
  for (const [r, m] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    assert.deepEqual(crosshairToPixel(0, 0, 400, 300, 1920, 1080, r, m), { x: 200, y: 150 });
  }
});

test("Klick und Anzeige sind genaue Umkehrungen, in jeder Stellung", () => {
  for (const [r, m] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    const px = crosshairToPixel(0.1, -0.2, 400, 400, 1600, 800, r, m);
    const back = pixelToCrosshair(px.x, px.y, 400, 400, 1600, 800, r, m);
    near(back.x, 0.1, "x"); near(back.y, -0.2, "y");
  }
});

test("Klick neben das Bild landet am Bildrand", () => {
  // Bild liegt bei y = 100…300; Klick bei y = 10 (schwarzer Balken)
  assert.deepEqual(pixelToCrosshair(200, 10, 400, 400, 1600, 800, false, false), { x: 0, y: -0.5 });
});

test("Dieselbe Bildstelle: gedrehte Anzeige zeigt das Fadenkreuz gegenüber", () => {
  const a = crosshairToPixel(0.25, 0, 400, 200, 400, 200, false, false);
  const b = crosshairToPixel(0.25, 0, 400, 200, 400, 200, true, false);
  assert.equal(a.x, 300);
  assert.equal(b.x, 100);
});
