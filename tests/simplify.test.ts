// Form vereinfachen – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { maxDeviation, simplifyPath } from "../src/editor/simplify.ts";

const P = (x: number, y: number) => ({ x, y });
const circle = (r: number, n: number) => Array.from({ length: n }, (_, i) => P(r * Math.cos((i / n) * 2 * Math.PI), r * Math.sin((i / n) * 2 * Math.PI)));

test("Kreis: viel weniger Punkte, Abweichung unter der Toleranz, bleibt geschlossen", () => {
  const c = circle(50, 2000);
  for (const tol of [0.01, 0.05, 0.2, 1, 5]) {
    const s = simplifyPath(c, true, tol);
    assert.ok(s.length < c.length, `tol ${tol}`);
    assert.ok(s.length >= 3);
    assert.ok(maxDeviation(c, s, true) <= tol + 1e-9, `tol ${tol}: ${maxDeviation(c, s, true)}`);
    assert.ok(maxDeviation(s, c, true) <= tol + 1e-3, `zurück, tol ${tol}`);
  }
});

test("Größere Toleranz ergibt nie mehr Punkte", () => {
  const c = circle(40, 800);
  let prev = Infinity;
  for (const tol of [0.01, 0.1, 0.5, 2]) {
    const n = simplifyPath(c, true, tol).length;
    assert.ok(n <= prev);
    prev = n;
  }
});

test("Rechteck mit überflüssigen Punkten: genau die 4 Ecken bleiben", () => {
  const pts: { x: number; y: number }[] = [];
  for (let x = 0; x < 100; x += 5) pts.push(P(x, 0));
  for (let y = 0; y < 50; y += 5) pts.push(P(100, y));
  for (let x = 100; x > 0; x -= 5) pts.push(P(x, 50));
  for (let y = 50; y > 0; y -= 5) pts.push(P(0, y));
  const s = simplifyPath(pts, true, 0.1);
  assert.deepEqual(s.map(q => `${q.x},${q.y}`).sort(), ["0,0", "0,50", "100,0", "100,50"].sort());
});

test("Ecke bleibt scharf, auch wenn der Knick kleiner als die Toleranz wäre", () => {
  // kleiner Zacken: 3 hoch auf 40 lang, Toleranz 5 würde ihn wegbügeln, Winkel ~ 32°
  const pts = [P(0, 0), P(5, 0), P(10, 3.2), P(15, 0), P(20, 0)];
  const s = simplifyPath(pts, false, 1);
  assert.ok(s.some(q => q.x === 10));
});

test("Rauschen auf einer Geraden verschwindet, Enden bleiben genau", () => {
  const pts = Array.from({ length: 1001 }, (_, i) => P(i * 0.1, i % 2 ? 0.01 : -0.01));
  const s = simplifyPath(pts, false, 0.05);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0], pts[0]);
  assert.deepEqual(s[1], pts[1000]);
  assert.ok(maxDeviation(pts, s, false) <= 0.05);
});

test("Riesige Toleranz: geschlossene Form bleibt mindestens ein Dreieck", () => {
  const s = simplifyPath(circle(5, 100), true, 1000);
  assert.equal(s.length, 3);
});

test("Kurze Listen und Eingabe bleiben unberührt", () => {
  const two = [P(0, 0), P(10, 0)];
  assert.deepEqual(simplifyPath(two, false, 1), two);
  const c = circle(10, 50);
  const copy = JSON.stringify(c);
  simplifyPath(c, true, 1);
  assert.equal(JSON.stringify(c), copy);
});

test("Zufällige Kontur: Toleranz wird immer eingehalten", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let run = 0; run < 20; run++) {
    const pts = Array.from({ length: 300 }, (_, i) => {
      const a = (i / 300) * 2 * Math.PI, r = 40 + 8 * Math.sin(a * 5) + rnd();
      return P(r * Math.cos(a), r * Math.sin(a));
    });
    const tol = 0.2 + rnd();
    assert.ok(maxDeviation(pts, simplifyPath(pts, true, tol), true) <= tol + 1e-9);
  }
});
