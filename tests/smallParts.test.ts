// Etikett, Schlüsselanhänger, Fotorahmen, Perforation, Vorlagen – läuft mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { labelPart, keychainPart, framePart, roundedRect, rowLayout } from "../src/smallParts.ts";
import { bounds } from "../src/nameConnect.ts";
import { thinnestWeb } from "../src/genCheck.ts";
import { perforate, spotsOnPath } from "../src/editor/perforate.ts";
import { addPreset, removePreset, sanitizePresets, cleanName, MAX_PRESETS, MAX_NAME } from "../src/genPresets.ts";

const web = (m: any, limit: number) => thinnestWeb(m.flat().map((r: any) => ({ closed: true, pts: r.slice(0, -1).map(([x, y]: number[]) => ({ x, y })) })), limit);

test("Etikett: Maß von Hand, zwei Löcher, Löcher mit Abstand zum Rand", () => {
  const r = labelPart({ width: 80, height: 30, radius: 4, holeD: 4, holes: 2 });
  const b = bounds(r.parts[0].cut);
  assert.equal(b.x1 - b.x0, 80);
  assert.equal(b.y1 - b.y0, 30);
  assert.equal(r.parts[0].cut[0].length, 3);
  assert.equal(web(r.parts[0].cut, 1.5), null);
  assert.equal(labelPart({ width: 80, height: 30, radius: 0, holeD: 4, holes: 0 }).parts[0].cut[0].length, 1);
});

test("Schlüsselanhänger: ein Teil mit Loch, Rand um das Loch entspricht der Vorgabe, dünner Rand warnt", () => {
  for (const shape of ["pill", "round", "rect"] as const) {
    const r = keychainPart({ shape, width: 60, height: 22, holeD: 5, ring: 3 });
    assert.equal(r.parts[0].cut.length, 1, shape);
    assert.ok(r.parts[0].cut[0].length >= 2, shape + ": Loch fehlt");
    assert.equal(web(r.parts[0].cut, 2.9), null, shape);
    assert.ok(r.parts[0].textBox!.x1 > r.parts[0].textBox!.x0, shape);
  }
  assert.ok(keychainPart({ shape: "pill", width: 60, height: 22, holeD: 5, ring: 1 }).warnings.length);
});

test("Fotorahmen: drei gleich große Lagen, Fenster kleiner als das Foto, Tasche größer", () => {
  const r = framePart({ photoW: 100, photoH: 150, border: 20, overlap: 4, clear: 0.5, style: "plain", hanger: true });
  assert.equal(r.parts.length, 3);
  for (const p of r.parts) { const b = bounds(p.cut); assert.equal(b.x1 - b.x0, 140); }
  const win = bounds([[r.parts[0].cut[0][1]]]);
  assert.equal(win.x1 - win.x0, 92); // 100 - 2 × 4
  assert.equal(win.y1 - win.y0, 142);
  // Mittellage: U-Form, oben offen: nur ein äußerer Ring, Breite der Stege = Rand - Spiel
  assert.equal(r.parts[1].cut.length, 1);
  assert.equal(r.parts[1].cut[0].length, 1);
  assert.equal(r.parts[2].cut[0].length, 3, "Rückwand mit zwei Aufhänge-Löchern");
  for (const style of ["rounded", "scallop"] as const) assert.equal(framePart({ photoW: 100, photoH: 150, border: 20, overlap: 4, clear: 0.5, style, hanger: false }).parts.length, 3);
});

test("runde Ecken: große Ecke hat mehr Punkte, Radius 0 bleibt ein Rechteck", () => {
  assert.equal(roundedRect(0, 0, 10, 10, 0).length, 4);
  assert.ok(roundedRect(0, 0, 100, 100, 30).length > roundedRect(0, 0, 100, 100, 2).length);
});

test("Perforation offen: von Hand 100 mm, Schnitt 10, Lücke 5: beide Enden geschnitten, gleiche Lücken", () => {
  const out = perforate([{ x: 0, y: 0 }, { x: 100, y: 0 }], false, 10, 5);
  assert.equal(out.length, 7);
  assert.equal(out[0][0].x, 0);
  assert.equal(out[6][out[6].length - 1].x, 100);
  const gap = out[1][0].x - out[0][out[0].length - 1].x;
  assert.ok(Math.abs(gap - 5) < 1e-9, String(gap));
  for (const p of out) assert.ok(Math.abs(p[p.length - 1].x - p[0].x - 10) < 1e-9);
});

test("Perforation geschlossen: Muster geht auf, Ecken bleiben erhalten", () => {
  const sq = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }];
  const out = perforate(sq, true, 8, 2);
  assert.equal(out.length, 16);
  assert.ok(out.some(p => p.some(q => q.x === 40 && q.y === 0)), "Ecke fehlt");
  const len = out.flatMap(p => p.slice(1).map((q, i) => Math.hypot(q.x - p[i].x, q.y - p[i].y))).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(len - 128) < 1e-9, String(len)); // 160 × 8/10
});

test("Perforation: unsinnige Werte lassen den Pfad ganz", () => {
  assert.equal(perforate([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, 0, 5).length, 1);
  assert.equal(perforate([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, 50, 5).length, 1);
});

test("Verteilen: offen Anfang bis Ende, geschlossen ohne Doppelung, Richtung stimmt", () => {
  const line = spotsOnPath([{ x: 0, y: 0 }, { x: 100, y: 0 }], false, 5);
  assert.deepEqual(line.map(s => s.x), [0, 25, 50, 75, 100]);
  assert.equal(line[0].angle, 0);
  const sq = spotsOnPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], true, 4);
  assert.deepEqual(sq.map(s => [s.x, s.y]), [[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.ok(Math.abs(sq[1].angle - Math.PI / 2) < 1e-9);
  assert.deepEqual(spotsOnPath([{ x: 0, y: 0 }, { x: 0, y: 0 }], false, 3), []);
});

test("Vorlagen: gleicher Name ersetzt, sortiert, Grenze, kaputte Daten fallen weg", () => {
  let l = addPreset([], "Box klein", { w: "10" });
  l = addPreset(l, "Anhänger", { w: "20" });
  l = addPreset(l, "box KLEIN", { w: "30" });
  assert.deepEqual(l.map(p => p.name), ["Anhänger", "box KLEIN"]);
  assert.equal(addPreset(l, "   ", {}).length, 2);
  assert.equal(removePreset(l, "Anhänger").length, 1);
  assert.equal(cleanName("x".repeat(99)).length, MAX_NAME);
  let many: any[] = [];
  for (let i = 0; i < MAX_PRESETS + 5; i++) many = addPreset(many, "n" + i, {});
  assert.equal(many.length, MAX_PRESETS);
  const s = sanitizePresets([{ name: "ok", values: { a: "1", b: true, c: { x: 1 } } }, { name: 5 }, null, "x"]);
  assert.equal(s.length, 1);
  assert.equal(s[0].values.c, undefined);
  assert.deepEqual(sanitizePresets("kaputt"), []);
});

test("Teile aufs Bett: eine Reihe mittig wie bisher, zu breit -> neue Reihe, nichts überlappt", () => {
  const box = (w: number, h: number) => ({ x0: 0, y0: 0, x1: w, y1: h });
  // passt in eine Reihe: mittig, jedes Teil mittig in der Höhe
  const one = rowLayout([box(80, 30), box(40, 20)], 300, 300);
  assert.deepEqual(one, [{ x: 87.5, y: 135 }, { x: 172.5, y: 140 }]);
  // drei Rahmenteile je 140 mm auf 300 mm: zwei oben, eins darunter, alles auf dem Bett
  const three = rowLayout([box(140, 190), box(140, 190), box(140, 190)].map(b => ({ ...b, y1: 100 })), 300, 300);
  assert.equal(three[0].y, three[1].y);
  assert.ok(three[2].y < three[0].y - 100 + 1e-9, "dritte Reihe liegt darunter");
  for (const p of three) { assert.ok(p.x >= 5 && p.x + 140 <= 295); assert.ok(p.y >= 5 && p.y + 100 <= 295); }
  // ein Teil breiter als das Bett: eigene Reihe, links am Rand
  assert.deepEqual(rowLayout([box(400, 50)], 300, 300)[0], { x: 5, y: 125 });
});
