// Tests für verbundene Namen (Ritzlinien an Überlappungen) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MultiPolygon } from "polygon-clipping";
import { overlapScores, grow, union, inRegion, clipLines, outlineLines, bounds, scaleArea, type ScoreLine } from "../src/nameConnect.ts";

const rect = (x0: number, y0: number, x1: number, y1: number): MultiPolygon => [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]];
/** „o“: Quadrat mit Loch */
const ring = (x0: number, y0: number, s: number, w: number): MultiPolygon =>
  [[[[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]], [[x0 + w, y0 + w], [x0 + w, y0 + s - w], [x0 + s - w, y0 + s - w], [x0 + s - w, y0 + w], [x0 + w, y0 + w]]]];
const len = (l: ScoreLine) => l.pts.reduce((s, q, i) => (i ? s + Math.hypot(q[0] - l.pts[i - 1][0], q[1] - l.pts[i - 1][1]) : 0), 0);

/** jede Linie liegt ganz in der Fläche, nicht auf ihrem Rand */
function allInside(lines: ScoreLine[], area: MultiPolygon) {
  for (const l of lines) for (const [x, y] of l.pts) assert.ok(inRegion(area, x, y), `Punkt ${x},${y} liegt außerhalb`);
}

test("zwei überlappende Buchstaben: eine Ritzlinie, die Kante des oberen", () => {
  const a = rect(0, 0, 10, 20), b = rect(8, 0, 18, 20);
  const s = overlapScores([a, b], 0.3);
  assert.equal(s.length, 1);
  const l = s[0];
  assert.ok(l.pts.every(([x]) => Math.abs(x - 8) < 1e-6), "Linie liegt auf der linken Kante von b (x = 8)");
  assert.ok(Math.abs(len(l) - (20 - 0.6)) < 0.25, "fast über die ganze Höhe, mit Abstand zur Schnittkante: " + len(l));
  allInside(s, union([a, b]));
});

test("ohne Überlappung keine Ritzlinien, das Ergebnis bleibt zwei Teile", () => {
  assert.equal(overlapScores([rect(0, 0, 10, 10), rect(12, 0, 20, 10)]).length, 0);
  assert.equal(overlapScores([rect(0, 0, 10, 10)]).length, 0);
});

test("verdeckte Kante: ein drittes Teil darüber verschluckt die Linie", () => {
  const a = rect(0, 0, 10, 10), b = rect(5, 0, 15, 10), c = rect(3, -1, 7, 11);
  const s = overlapScores([a, b, c]);
  // Kante von b bei x = 5 liegt ganz unter c → keine Linie dort
  assert.ok(!s.some(l => l.pts.every(([x]) => Math.abs(x - 5) < 1e-6)), "Kante x = 5 ist verdeckt");
  allInside(s, union([a, b, c]));
});

test("Buchstabe mit Innenraum: Linie nur über Material, nicht über dem Loch", () => {
  const o = ring(0, 0, 20, 4), b = rect(10, 2, 30, 18);
  const s = overlapScores([o, b], 0.2);
  const area = union([o, b]);
  allInside(s, area);
  // b liegt über dem Loch des o – dort darf keine Linie entstehen
  for (const l of s) for (const [x, y] of l.pts) assert.ok(!(x > 4.2 && x < 15.8 && y > 4.2 && y < 15.8 && x > 10.01), "keine Linie im Loch");
  assert.ok(s.length >= 1);
});

test("Umriss wächst nach außen und füllt Innenräume, Fettung behält sie", () => {
  const o = ring(0, 0, 20, 5);
  const out = grow(o, 2);
  const b = bounds(out);
  assert.ok(Math.abs(b.x0 + 2) < 0.1 && Math.abs(b.x1 - 22) < 0.1, "2 mm Rand");
  assert.ok(out.every(p => p.length === 1), "Umriss ohne Löcher");
  assert.ok(inRegion(out, 10, 10), "Innenraum gefüllt");
  const bold = grow(o, 1, true);
  assert.ok(!inRegion(bold, 10, 10), "Fettung: das o bleibt offen");
  assert.ok(inRegion(bold, 5.8, 10) && !inRegion(bold, 6.2, 10), "Loch um 1 mm kleiner");
});

test("Linien beschneiden (Loch des Aufhängers) und Konturen als geschlossene Linien", () => {
  const area = rect(0, 0, 20, 10);
  const lines: ScoreLine[] = [{ pts: [[1, 5], [19, 5]], closed: false }];
  const withHole: MultiPolygon = [[area[0][0], [[8, 3], [8, 7], [12, 7], [12, 3], [8, 3]]]];
  const c = clipLines(lines, withHole, 0.2);
  assert.equal(c.length, 2, "Linie durch das Loch wird zweigeteilt");
  allInside(c, withHole);
  // ganz drin: geschlossene Kontur bleibt erhalten (früher fiel sie beim Vereinfachen weg)
  const inner = clipLines([{ pts: [[2, 2], [6, 2], [6, 6], [2, 6]], closed: true }], withHole, 0.2);
  assert.equal(inner.length, 1);
  assert.ok(inner[0].closed);
  const ol = outlineLines(withHole);
  assert.equal(ol.length, 2);
  assert.ok(ol.every(l => l.closed && l.pts.length === 4));
});

test("Skalieren für die fertige Breite", () => {
  const b = bounds(scaleArea(rect(0, 0, 50, 10), 1.5));
  assert.equal(b.x1 - b.x0, 75);
});
