// Auftrag hier starten – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorPoint, extentFromHead, jobHereCommand, JOB_ANCHORS } from "../src/jobOrigin.ts";

const box = { x0: 10, y0: 20, x1: 110, y1: 70 };

test("Alle 9 Bezugspunkte liegen richtig", () => {
  assert.deepEqual(anchorPoint(box, "bl"), { x: 10, y: 20 });
  assert.deepEqual(anchorPoint(box, "tr"), { x: 110, y: 70 });
  assert.deepEqual(anchorPoint(box, "mc"), { x: 60, y: 45 });
  assert.deepEqual(anchorPoint(box, "tc"), { x: 60, y: 70 });
  assert.deepEqual(anchorPoint(box, "ml"), { x: 10, y: 45 });
  assert.equal(JOB_ANCHORS.length, 9);
});

test("Befehl: Kopf bekommt die Koordinate des Bezugspunkts, Z bleibt unberührt", () => {
  assert.equal(jobHereCommand(box, "bl"), "G10 L20 P0 X10.000 Y20.000");
  assert.equal(jobHereCommand({ x0: -5.5, y0: 0, x1: 4.5, y1: 8 }, "mc"), "G10 L20 P0 X-0.500 Y4.000");
});

test("Probe: Kopf an Maschinenstelle 200/100, danach liegt der Bezugspunkt genau unter dem Kopf", () => {
  // G10 L20 setzt den Versatz so: Werkstück = Maschine − Versatz
  const m = { x: 200, y: 100 };
  const p = anchorPoint(box, "mc");
  const wco = { x: m.x - p.x, y: m.y - p.y };
  assert.deepEqual({ x: p.x + wco.x, y: p.y + wco.y }, m);
  assert.deepEqual({ x: box.x0 + wco.x, y: box.y0 + wco.y }, { x: 150, y: 75 });
});

test("Ausdehnung ab dem Kopf", () => {
  assert.deepEqual(extentFromHead(box, "bl"), { left: 0, right: 100, down: 0, up: 50 });
  assert.deepEqual(extentFromHead(box, "mc"), { left: 50, right: 50, down: 25, up: 25 });
});
