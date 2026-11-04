// Tests für „Mit Generator bearbeiten“ – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { carrySettings, checkRun, imageOfShape, loadSettings, matchDefaults, readGen, replaceRun, roleOf, sanitizeSettings, saveSettings, tagRun, takeSettings, withSettings } from "../src/editor/genRun.ts";
import { createCircle, createPolyline, groupBounds, rotateShape, translateShape } from "../src/shapeTransform.ts";

const rect = (x: number, y: number, w: number, h: number, mode = "outside", extra: any = {}) =>
  createPolyline([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], true, mode, extra);
const run = () => {
  const made = [rect(0, 0, 100, 50), rect(10, 10, 20, 20, "inside", { groupId: "g" }), rect(150, 0, 40, 40, "outside", { groupId: "g" }), createCircle(300, 30, 10)];
  tagRun(made, "box", { w: 100, name: "x" });
  return made;
};
const snapshot = (s: any[]) => JSON.parse(JSON.stringify(s));

test("Einstellungen überleben Speichern und Öffnen des Projekts", () => {
  const reopened = snapshot(run());
  const g = readGen(reopened[2])!;
  assert.equal(g.type, "box");
  assert.deepEqual(g.s, { w: 100, name: "x" });
  assert.equal(g.n, 4);
  assert.equal(new Set(reopened.map(s => readGen(s)!.id)).size, 1, "ein Lauf");
});

test("alte Projekte ohne gen und kaputte Daten: keine Bearbeitung, kein Absturz", () => {
  assert.equal(readGen(rect(0, 0, 1, 1)), null);
  for (const gen of [1, "x", {}, { id: 3, type: "box", i: 0, n: 1, s: {} }, { id: "a", type: "box", i: -1, n: 1, s: {} }, { id: "a", type: "box", i: 0, n: 1, s: [] }, { id: "a", type: "box", i: 0, n: 1 }])
    assert.equal(readGen({ gen }), null, JSON.stringify(gen));
  const fremd = { gen: { id: "a", type: "gibtsnicht", i: 0, n: 1, s: {}, f: "x", p: null } };
  assert.equal(readGen(fremd)!.type, "gibtsnicht");   // ob der Generator bekannt ist, prüft genEdit
  assert.equal(checkRun([fremd]).edited, 1);
});

test("Einstellungen aus fremden Dateien werden bereinigt", () => {
  const s = sanitizeSettings(JSON.parse('{"__proto__":{"x":1},"constructor":2,"a":1,"b":"t","c":[1,"2",null],"d":{"e":true},"f":null}'))!;
  assert.deepEqual(s, { a: 1, b: "t", c: [1, "2"], d: { e: true } });
  assert.equal(({} as any).x, undefined);
  assert.equal(sanitizeSettings([1]), null);
  assert.equal(sanitizeSettings("x"), null);
  assert.equal(sanitizeSettings({ a: "y".repeat(4000), b: "y".repeat(4000), c: "y".repeat(4000), d: "y".repeat(4000), e: "y".repeat(4000), f: "y".repeat(4000), g: "y".repeat(4000), h: "y".repeat(4000), i: "y".repeat(4000) }), null);
  const def = { size: 30, text: "a", on: true, list: [1], skip: null as any };
  assert.deepEqual(matchDefaults(def, { size: '"><img>', text: "b", on: 1, list: [2], other: 1 }), { text: "b", list: [2] });
});

test("unveränderter Lauf ist sauber, auch verschoben", () => {
  const parts = run();
  assert.equal(checkRun(parts).clean, true);
  parts.forEach(s => translateShape(s, 33, -12));
  const c = checkRun(parts);
  assert.equal(c.clean, true);
  assert.equal(c.angle, 0);
});

test("ganzer Lauf gedreht: Winkel wird erkannt und ist keine Handänderung", () => {
  const parts = run();
  parts.forEach(s => rotateShape(s, 50, 50, Math.PI / 2));
  const c = checkRun(parts);
  assert.equal(c.clean, true);
  assert.ok(Math.abs(c.angle - Math.PI / 2) < 1e-3);
});

test("Handänderungen werden gemeldet", () => {
  let p = run();
  p[0].points[1].x += 20;
  assert.equal(checkRun(p).edited, 1);
  p = run();
  assert.equal(checkRun(p.slice(1)).missing, 1);
  p = run();
  translateShape(p[2], 40, 0);
  assert.equal(checkRun(p).moved, true);
  p = run();
  delete p[1].groupId;
  assert.equal(checkRun(p).ungrouped, 1);
  p = run();
  assert.equal(checkRun([...p, snapshot(p[0])]).extra, 1);
  assert.equal(checkRun(p).clean, true);
});

test("Ersetzen: Stelle, Reihenfolge, nichts bleibt doppelt, alter Stand unverändert (Rückgängig)", () => {
  const before = rect(-500, 0, 5, 5), after = rect(-400, 0, 5, 5);
  const old = run();
  old.forEach(s => translateShape(s, 77, 88));
  const all = [before, ...old, after];
  const oldB = groupBounds(old)!;
  const undo = JSON.stringify(all);
  const made = [rect(1000, 1000, 200, 60), rect(1300, 1000, 10, 10)];
  const out = replaceRun([...all, ...made], new Set(old.map(s => s.id)), made);
  assert.equal(JSON.stringify(all), undo, "alte Formen dürfen nicht verändert werden");
  assert.deepEqual(out.map(s => s.id), [before.id, made[0].id, made[1].id, after.id]);
  const b = groupBounds(made)!;
  assert.ok(Math.abs(b.minX - oldB.minX) < 1e-6 && Math.abs(b.minY - oldB.minY) < 1e-6);
});

test("Ersetzen dreht die neuen Teile mit", () => {
  const old = [rect(0, 0, 100, 50)];
  const made = [rect(1000, 1000, 200, 20)];
  replaceRun([old[0], made[0]], new Set([old[0].id]), made, Math.PI / 2);
  const b = groupBounds(made)!;
  assert.ok(Math.abs(b.maxX - b.minX - 20) < 1e-6 && Math.abs(b.maxY - b.minY - 200) < 1e-6);
  assert.ok(Math.abs(b.minX) < 1e-6 && Math.abs(b.minY) < 1e-6);
});

test("Einstellungen bleiben: gleicher Aufbau Form für Form", () => {
  const old = run();
  old[0].millingDepth = -7; old[0].toolId = "t1";
  old[1].millingMode = "pocket"; old[1].laserLayerId = "L2";
  const made = [rect(0, 0, 200, 50), rect(10, 10, 20, 20, "inside"), rect(250, 0, 40, 40), createCircle(0, 0, 5)];
  carrySettings(old, made);
  assert.equal(made[0].millingDepth, -7);
  assert.equal(made[0].toolId, "t1");
  assert.equal(made[1].millingMode, "pocket");
  assert.equal(made[1].laserLayerId, "L2");
  assert.equal(made[2].toolId, undefined);
});

test("Einstellungen bleiben: anderer Aufbau je Rolle, nur wenn einheitlich", () => {
  const old = run();
  old[0].millingDepth = -7; old[2].millingDepth = -7;
  old[0].toolId = "a"; old[2].toolId = "b";
  const made = [rect(0, 0, 1, 1), rect(2, 0, 1, 1), rect(4, 0, 1, 1), rect(6, 0, 1, 1, "inside"), rect(8, 0, 1, 1, "on-line")];
  carrySettings(old, made);
  assert.equal(made[1].millingDepth, -7);
  assert.equal(made[1].toolId, undefined, "verschiedene Werkzeuge: keins übernehmen");
  assert.equal(made[3].millingDepth, -2);
  assert.equal(made[4].millingDepth, -2);
});

test("Rolle stammt vom Generator, auch wenn die Bearbeitung von Hand geändert wurde", () => {
  const old = run();
  const made = [rect(0, 0, 200, 50), rect(10, 10, 20, 20, "inside"), rect(250, 0, 40, 40), createCircle(0, 0, 5)];
  const roles = made.map(roleOf);
  old[0].millingMode = "pocket";
  carrySettings(old, made);
  tagRun(made, "box", { w: 1 }, roles);
  assert.equal(made[0].millingMode, "pocket");
  assert.equal(readGen(made[0])!.r, "polyline|outside|0|1");
});

test("Fenster bekommen beim Bearbeiten die gespeicherten Werte, danach wieder die normalen", () => {
  let inside: string | null = null;
  withSettings({ w: 5 }, [], () => { inside = loadSettings("nokey"); });
  assert.equal(inside, '{"w":5}');
  assert.equal(loadSettings("nokey"), null);
  saveSettings("nokey", { w: 9 });
  assert.deepEqual(takeSettings(), { w: 9 });
  assert.equal(takeSettings(), null, "Abbrechen hinterlässt keine alten Werte");
});

test("Bilder nur aus sauberen eingebetteten Daten", () => {
  const src = "data:image/png;base64,iVBORw0KGgo=";
  const im = imageOfShape({ source: "foto.jpg", img: { src, pw: 100, ph: 50 } })!;
  assert.equal(im.name, "foto.png");
  assert.equal(im.ratio, 0.5);
  assert.equal(im.bytes[1], 0x50);
  assert.equal(imageOfShape({ img: { src: 'data:text/html,<script>', pw: 1, ph: 1 } }), null);
  assert.equal(imageOfShape({ img: { src: 'data:image/png;base64,"><x>', pw: 1, ph: 1 } }), null);
});
