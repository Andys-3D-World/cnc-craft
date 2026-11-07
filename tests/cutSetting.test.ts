// Startpunkt und Richtung einer Kontur – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCut, applyCutClosed, applyCutOpen, cutMark, effectiveDirection, fractionAt, hasCutSetting, isClimb, orientClosed, overridesMillDir, pointAtFraction, rotateLoopTo } from "../src/cutSetting.ts";
import { createPolyline, createCircle, scaleShape, MM_TO_PIXEL } from "../src/shapeTransform.ts";

const P = (x: number, y: number) => ({ x, y });
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const square = [P(0, 0), P(100, 0), P(100, 100), P(0, 100)]; // gegen den Uhrzeigersinn
const area = (pts: { x: number; y: number }[]) => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y; return a / 2; };
const perim = (pts: { x: number; y: number }[]) => pts.reduce((n, q, i) => { const r = pts[(i + 1) % pts.length]; return n + Math.hypot(r.x - q.x, r.y - q.y); }, 0);
const shape = (extra = {}) => createPolyline(square.map(q => P(q.x * MM_TO_PIXEL, q.y * MM_TO_PIXEL)), true, "outside", extra);

test("Start auf einem Punkt: Reihenfolge rundum, Form bleibt gleich", () => {
  const r = rotateLoopTo(square, P(100, 100));
  assert.deepEqual(r, [P(100, 100), P(0, 100), P(0, 0), P(100, 0)]);
  near(area(r), area(square));
});

test("Start auf einer Kante: ein Punkt kommt dazu, Fläche und Umfang bleiben", () => {
  const r = rotateLoopTo(square, P(40, -3));
  assert.deepEqual(r[0], P(40, 0));
  assert.equal(r.length, 5);
  near(area(r), area(square));
  near(perim(r), perim(square));
});

test("Doppelter Schlusspunkt wird dabei nicht zur Doppelkante", () => {
  const r = rotateLoopTo([...square, P(0, 0)], P(100, 0));
  assert.equal(r.length, 4);
});

test("Richtung drehen: Start bleibt, Fläche wechselt das Vorzeichen, Umfang gleich", () => {
  const r = orientClosed(square, "cw");
  assert.deepEqual(r[0], P(0, 0));
  near(area(r), -area(square));
  near(perim(r), perim(square));
  assert.equal(orientClosed(square, "ccw"), square);
});

test("Ohne Einstellung: genau dieselbe Liste (G-Code bleibt gleich)", () => {
  const s = shape();
  assert.equal(hasCutSetting(s), false);
  assert.equal(applyCutClosed(square, s), square);
  assert.equal(applyCutOpen(square, s), square);
  assert.equal(applyCut(square, true, s), square);
  assert.equal(hasCutSetting({ cutStart: "x", cutDir: "quer" }), false);
});

test("Start und Richtung auf einer versetzten Bahn: Start ist der nächste Punkt zur gewählten Stelle", () => {
  const s = shape({ cutStart: 0.125, cutDir: "cw" }); // 1/8 des Umfangs = Mitte der Unterkante = (50, 0)
  const off = [P(-5, -5), P(105, -5), P(105, 105), P(-5, 105)]; // versetzte Bahn in mm
  const r = applyCutClosed(off, s);
  assert.deepEqual(r[0], P(50, -5));
  assert.ok(area(r) < 0);
  near(Math.abs(area(r)), Math.abs(area(off)));
});

test("Offene Linie: rückwärts, sonst unverändert", () => {
  const line = [P(0, 0), P(10, 0), P(20, 5)];
  assert.deepEqual(applyCutOpen(line, { cutDir: "reverse" }), [P(20, 5), P(10, 0), P(0, 0)]);
  assert.equal(applyCutOpen(line, { cutDir: "forward" }), line);
});

test("Anteil und Punkt passen zueinander, auch um die Naht", () => {
  for (const f of [0, 0.1, 0.25, 0.5, 0.8]) {
    near(fractionAt(square, true, pointAtFraction(square, true, f)), f);
  }
  assert.deepEqual(pointAtFraction(square, true, 0.5), P(100, 100));
});

test("Automatische Richtung je Maschine", () => {
  const out = shape();
  assert.equal(effectiveDirection(out, "laser").ccw, true); // wie gezeichnet
  assert.equal(effectiveDirection(out, "plasma").ccw, false); // außen im Uhrzeigersinn
  assert.equal(effectiveDirection({ ...out, millingMode: "inside" }, "plasma").ccw, true);
  assert.equal(effectiveDirection(out, "mill").ccw, true); // außen gegen den Uhrzeigersinn (Standard)
  assert.equal(effectiveDirection({ ...out, millDir: "climb" }, "mill").ccw, false);
  assert.equal(effectiveDirection(createCircle(0, 0, 5), "mill").ccw, false); // G2
});

test("Von Hand gewinnt über Gleich-/Gegenlauf und wird gemeldet", () => {
  const s = { ...shape(), millDir: "climb", cutDir: "ccw" }; // außen und gegen den Uhrzeigersinn = Gegenlauf
  assert.equal(effectiveDirection(s, "mill").ccw, true);
  assert.equal(effectiveDirection(s, "mill").auto, false);
  assert.equal(overridesMillDir(s), true);
  assert.equal(overridesMillDir({ ...s, cutDir: "cw" }), false);
  assert.equal(overridesMillDir({ ...s, millDir: "" }), false);
});

test("Gleichlauf: außen im Uhrzeigersinn, innen gegen", () => {
  assert.equal(isClimb("outside", false), true);
  assert.equal(isClimb("inside", true), true);
  assert.equal(isClimb("outside", true), false);
  assert.equal(isClimb("on-line", true), null);
});

test("Spiegeln dreht die gesetzte Richtung mit, die offene bleibt", () => {
  const s = shape({ cutDir: "cw" });
  scaleShape(s, 0, 0, -1, 1);
  assert.equal(s.cutDir, "ccw");
  scaleShape(s, 0, 0, -1, -1);
  assert.equal(s.cutDir, "ccw");
  const o = createPolyline([P(0, 0), P(5, 5)], false, "on-line", { cutDir: "reverse" });
  scaleShape(o, 0, 0, -1, 1);
  assert.equal(o.cutDir, "reverse");
});

test("Marke: Pfeil am Start in Fahrtrichtung", () => {
  const m = cutMark(shape({ cutStart: 0.125, cutDir: "cw" }), "laser")!;
  assert.deepEqual(m.at, P(100, 0)); // Mitte der Unterkante (in Welt-Pixeln)
  near(m.dir.x, -1); near(m.dir.y, 0); // im Uhrzeigersinn läuft die Unterkante nach links
  assert.equal(m.fixedStart, true);
  const o = cutMark(createPolyline([P(0, 0), P(10, 0)], false, "on-line", { cutDir: "reverse" }), "laser")!;
  assert.deepEqual(o.at, P(10, 0));
  near(o.dir.x, -1);
});
