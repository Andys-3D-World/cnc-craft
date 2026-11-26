// Versatz für offene Linien – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { offsetOpenPath, sideOf } from "../src/editor/offsetOpen.ts";

const P = (x: number, y: number) => ({ x, y });
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const nearPts = (a: { x: number; y: number }[], b: { x: number; y: number }[]) => {
  assert.equal(a.length, b.length, JSON.stringify(a));
  a.forEach((p, i) => { near(p.x, b[i].x); near(p.y, b[i].y); });
};
/** genau eine Linie als Ergebnis */
const one = (r: { x: number; y: number }[][]) => { assert.equal(r.length, 1, `${r.length} Linien`); return r[0]; };
/** kleinster Abstand eines Punkts zur Linie */
const distTo = (pts: { x: number; y: number }[], q: { x: number; y: number }) => {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(q.x - a.x - dx * t, q.y - a.y - dy * t));
  }
  return best;
};

test("Gerade Linie: links und rechts parallel", () => {
  nearPts(one(offsetOpenPath([P(0, 0), P(100, 0)], 5)), [P(0, 5), P(100, 5)]);
  nearPts(one(offsetOpenPath([P(0, 0), P(100, 0)], -5)), [P(0, -5), P(100, -5)]);
});

test("Winkel nach links: innen gekürzt, außen spitz", () => {
  const L = [P(0, 0), P(100, 0), P(100, 50)];
  nearPts(one(offsetOpenPath(L, 5)), [P(0, 5), P(95, 5), P(95, 50)]);     // links = innen
  nearPts(one(offsetOpenPath(L, -5)), [P(0, -5), P(105, -5), P(105, 50)]); // rechts = außen, spitz
});

test("Sehr spitze Ecke außen: Bogen um die alte Ecke statt langer Spitze", () => {
  const V = [P(0, 0), P(100, 0), P(0, 10)];
  const r = one(offsetOpenPath(V, -5, 0.01));
  const far = Math.max(...r.map(q => q.x));
  near(far, 105, 1e-3); // der Bogen reicht genau 5 über die Ecke hinaus
  // jeder Punkt des Ergebnisses liegt genau 5 von der Linie entfernt
  for (const q of r) near(distTo(V, q), 5, 0.02);
});

test("Bucht, Abstand kleiner als die halbe Breite: Linie innen herum", () => {
  const U = [P(0, 0), P(50, 0), P(50, 10), P(0, 10)];
  nearPts(one(offsetOpenPath(U, 3)), [P(0, 3), P(47, 3), P(47, 7), P(0, 7)]);
});

test("Schmale Bucht, Abstand größer als die halbe Breite: nichts bleibt übrig, keine Schleife", () => {
  const U = [P(0, 0), P(50, 0), P(50, 4), P(0, 4)]; // 4 breit, offen nach links
  assert.deepEqual(offsetOpenPath(U, 3), []);         // links = in die Bucht hinein
});

test("Kerbe in einer langen Linie: der Versatz läuft gerade darüber hinweg", () => {
  const notch = [P(0, 0), P(40, 0), P(40, -2), P(45, -2), P(45, 0), P(100, 0)];
  const r = offsetOpenPath(notch, 5);
  // eine einzige gerade Linie auf y = 5 von 0 bis 100
  const l = one(r);
  for (const q of l) near(q.y, 5);
  near(l[0].x, 0); near(l[l.length - 1].x, 100);
});

test("Viertelkreis als Vieleck: innen genau kleinerer Radius", () => {
  const arc = Array.from({ length: 91 }, (_, i) => P(50 * Math.cos((i * Math.PI) / 180), 50 * Math.sin((i * Math.PI) / 180)));
  const r = one(offsetOpenPath(arc, 10)); // gegen den Uhrzeigersinn, links = zur Mitte
  for (const q of r) near(Math.hypot(q.x, q.y), 40, 0.01);
  const out = one(offsetOpenPath(arc, -10));
  for (const q of out) near(Math.hypot(q.x, q.y), 60, 0.02);
});

test("Kreisbogen enger als der Abstand: Linie wird kürzer, aber nie zu nah", () => {
  const arc = Array.from({ length: 181 }, (_, i) => P(5 * Math.cos((i * Math.PI) / 180), 5 * Math.sin((i * Math.PI) / 180)));
  const r = offsetOpenPath(arc, 8);
  for (const pc of r) for (const q of pc) assert.ok(distTo(arc, q) > 8 - 1e-3);
});

test("Doppelte Punkte und zu kurze Linien", () => {
  nearPts(one(offsetOpenPath([P(0, 0), P(0, 0), P(10, 0)], 1)), [P(0, 1), P(10, 1)]);
  assert.deepEqual(offsetOpenPath([P(1, 1)], 2), []);
});

test("Seite der Maus erkennen", () => {
  const line = [P(0, 0), P(100, 0)];
  assert.equal(sideOf(line, P(50, 10)), 1);
  assert.equal(sideOf(line, P(50, -10)), -1);
  const L = [P(0, 0), P(100, 0), P(100, 100)];
  assert.equal(sideOf(L, P(90, 50)), 1);  // innen beim senkrechten Stück = links
  assert.equal(sideOf(L, P(110, 50)), -1);
});

test("Zickzack: jeder Punkt des Versatzes liegt mindestens im Abstand, auf beiden Seiten", () => {
  const z = Array.from({ length: 21 }, (_, i) => P(i * 10, i % 2 ? 8 : 0));
  for (const d of [3, -3, 12, -12]) {
    const r = offsetOpenPath(z, d);
    assert.ok(r.length >= 1, `d=${d}: nichts übrig`);
    for (const pc of r) for (const q of pc) assert.ok(distTo(z, q) > Math.abs(d) - 0.05, `d=${d}: ${JSON.stringify(q)} zu nah`);
  }
});

test("2000 Punkte gehen schnell", () => {
  const wave = Array.from({ length: 2000 }, (_, i) => P(i * 0.5, 20 * Math.sin(i / 40)));
  const t0 = Date.now();
  const r = offsetOpenPath(wave, 5);
  assert.ok(r.length >= 1);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});
