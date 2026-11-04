// Tests für das An- und Wegfahren beim Fräsen – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { planLead, leadAtPoint, leadOptions, distToPath, type LeadOpts } from "../src/millLead.ts";
import { pointInPoly } from "../src/polyOffset.ts";

const free = () => true;
const arc: LeadOpts = { in: true, out: true, type: "arc", len: 3 };
const line: LeadOpts = { in: true, out: true, type: "line", len: 3 };
const ccw = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 0, y: 20 }];
const cw = [ccw[0], ccw[3], ccw[2], ccw[1]];

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);

test("Standard aus: ohne Häkchen keine Einstellungen", () => {
  assert.equal(leadOptions({}), null);
  assert.equal(leadOptions({ leadType: "arc", leadLen: 5 }), null);
  assert.equal(leadOptions(null), null);
});

test("Einstellungen aus Projektdateien werden begrenzt", () => {
  const o = leadOptions({ leadIn: true, leadLen: 9999, leadType: "<x>" })!;
  assert.equal(o.len, 50);
  assert.equal(o.type, "arc");
  assert.equal(o.out, false);
  assert.equal(leadOptions({ leadOut: true, leadLen: -1 })!.len, 3);
});

test("Außen: alles liegt außerhalb der Bahn, Innen: alles innerhalb", () => {
  for (const loop of [ccw, cw]) for (const o of [arc, line]) {
    for (const side of ["outside", "inside"] as const) {
      const p = planLead(loop, side, o, free)!;
      assert.ok(p, `${side} ${o.type}`);
      for (const m of [p.in!, p.out!]) {
        const far = m.pts.filter(q => Math.hypot(q.x - p.start.x, q.y - p.start.y) > 0.5);
        assert.ok(far.length > 0);
        for (const q of far) assert.equal(pointInPoly(q.x, q.y, loop), side === "inside");
      }
    }
  }
});

test("Fängt auf der längsten Geraden an, Bahn bleibt vollständig", () => {
  const p = planLead(ccw, "outside", arc, free)!;
  near(p.start.x, 20); near(p.start.y, 0);
  assert.equal(p.loop.length, 5);
  assert.deepEqual(p.loop[0], p.start);
  assert.deepEqual(p.loop[1], ccw[1]);
  assert.deepEqual(p.loop[4], ccw[0]);
});

test("Bogen trifft die Bahn tangential und endet genau am Startpunkt", () => {
  // gegen den Uhrzeigersinn außen, Unterkante bei y=0, Fahrt nach +X, Abfall unten (rechts der Fahrt)
  const p = planLead(ccw, "outside", arc, free)!;
  const i = p.in!, o = p.out!;
  assert.equal(i.arc!.cmd, "G2");
  assert.equal(o.arc!.cmd, "G2", "gleiche Drehrichtung beim Weg- wie beim Anfahren");
  near(i.from.x, 17); near(i.from.y, -3);
  near(o.to.x, 23); near(o.to.y, -3);
  // Mittelpunkt liegt senkrecht unter dem Startpunkt: Tangente in Fahrtrichtung
  near(i.from.x + i.arc!.i, 20); near(i.from.y + i.arc!.j, -3);
  near(o.from.x + o.arc!.i, 20); near(o.from.y + o.arc!.j, -3);
  // Radius an beiden Enden gleich (sonst lehnt GRBL den Bogen ab)
  const c = { x: 20, y: -3 };
  near(Math.hypot(i.from.x - c.x, i.from.y - c.y), Math.hypot(i.to.x - c.x, i.to.y - c.y));
});

test("Drehrichtung des Bogens folgt der Fahrtrichtung", () => {
  assert.equal(planLead(cw, "outside", arc, free)!.in!.arc!.cmd, "G3");
  assert.equal(planLead(ccw, "inside", arc, free)!.in!.arc!.cmd, "G3");
  assert.equal(planLead(cw, "inside", arc, free)!.in!.arc!.cmd, "G2");
});

test("Linie: Länge stimmt, kein Bogen-Befehl", () => {
  const p = planLead(ccw, "outside", line, free)!;
  assert.equal(p.in!.arc, undefined);
  near(Math.hypot(p.in!.from.x - p.start.x, p.in!.from.y - p.start.y), 3);
  assert.ok(p.in!.from.y < 0, "von der Abfall-Seite");
});

test("Nur Anfahren oder nur Wegfahren", () => {
  const a = planLead(ccw, "outside", { ...arc, out: false }, free)!;
  assert.ok(a.in); assert.equal(a.out, null);
  const b = planLead(ccw, "outside", { ...arc, in: false }, free)!;
  assert.equal(b.in, null); assert.ok(b.out);
});

test("Zu kleines Loch: erst halbe Länge, dann gar nichts", () => {
  const tiny = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
  const half = planLead(tiny, "inside", { ...arc, len: 3 }, free)!;
  assert.ok(half);
  assert.ok(Math.hypot(half.in!.from.x - half.start.x, half.in!.from.y - half.start.y) < 3);
  assert.equal(planLead(tiny, "inside", { ...arc, len: 20 }, free), null);
});

test("Andere Form im Weg: andere Stelle oder Rückfall", () => {
  const notBelow = (pts: { x: number; y: number }[]) => pts.every(q => q.y >= -0.01);
  const p = planLead(ccw, "outside", arc, notBelow)!;
  near(p.start.y, 20);
  assert.equal(planLead(ccw, "outside", arc, () => false), null);
});

test("Runde Bahn ohne lange Geraden findet eine Stelle", () => {
  const ring = Array.from({ length: 200 }, (_, i) => ({ x: 5 * Math.cos(i / 200 * 2 * Math.PI), y: 5 * Math.sin(i / 200 * 2 * Math.PI) }));
  const p = planLead(ring, "inside", arc, free)!;
  assert.ok(p);
  assert.equal(p.loop.length, 200);
  for (const q of p.in!.pts.slice(0, 10)) assert.ok(Math.hypot(q.x, q.y) < 5);
});

test("Feste Stelle: Haltestege/Kreise", () => {
  const ring = Array.from({ length: 72 }, (_, i) => ({ x: 10 * Math.cos(i / 72 * 2 * Math.PI), y: 10 * Math.sin(i / 72 * 2 * Math.PI) }));
  const p = leadAtPoint({ x: 0, y: 10 }, { x: 1, y: 0 }, { x: 1, y: 0 }, ring, false, "outside", arc, free)!;
  assert.ok(p.in!.from.y > 10);
  assert.equal(p.in!.arc!.cmd, "G3", "Abfall liegt links der Fahrt");
  assert.equal(leadAtPoint({ x: 0, y: 10 }, { x: 1, y: 0 }, { x: 1, y: 0 }, ring, false, "inside", { ...arc, len: 50 }, free), null);
});

test("Abstand zum Linienzug", () => {
  near(distToPath({ x: 5, y: 3 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }], false), 3);
  near(distToPath({ x: 13, y: 4 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }], false), 5);
});
