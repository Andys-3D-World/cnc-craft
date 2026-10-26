// Tests für „Vorschub in Kurven anpassen“ – laufen mit `npm test` (node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { adaptFeed } from "../src/feedAdapt.ts";

/** Vorschub je Bewegungszeile (modal) – wie ihn die Maschine fahren würde */
function feeds(g: string): { line: string; f: number }[] {
  let f = NaN;
  const out: { line: string; f: number }[] = [];
  for (const l of g.split("\n")) {
    const code = l.replace(/\([^)]*\)/g, "");
    const m = /F([\d.]+)/.exec(code);
    if (m) f = +m[1];
    if (/^G[123]\b/.test(code) && /[XY]/.test(code)) out.push({ line: l, f });
  }
  return out;
}
const end = (l: string) => { const x = /X(-?[\d.]+)/.exec(l), y = /Y(-?[\d.]+)/.exec(l); return { x: +x![1], y: +y![1] }; };

const square = [
  "G21", "G90", "G0 Z5", "G0 X0 Y0", "G1 Z-1 F300", "G1 F1000",
  "G1 X50 Y0", "G1 X50 Y50", "G1 X0 Y50", "G1 X0 Y0", "G0 Z5", ""
].join("\n");

test("Geraden bleiben schnell, Ecken werden langsamer", () => {
  const out = adaptFeed(square, 1.5, 50);
  const fs = feeds(out);
  assert.ok(fs.some(x => x.f === 1000), "auf der Geraden voller Vorschub");
  assert.ok(fs.some(x => x.f === 500), "in der Ecke auf das Minimum (90° → Faktor ~0,56 → 0,5)");
  assert.ok(fs.every(x => x.f >= 500), "nie unter dem Minimum");
  // Endpunkt der Bahn bleibt gleich
  const last = fs[fs.length - 1].line;
  assert.deepEqual(end(last), { x: 0, y: 0 });
});

test("lange Geraden werden vor und nach der Ecke geteilt (kurze Strecke langsam)", () => {
  const fs = feeds(adaptFeed(square, 1.5, 50));
  // erste Ecke bei X50: bis kurz davor schnell, ab dort langsam, nach der Ecke kurz noch langsam
  const i = fs.findIndex(x => end(x.line).x === 50 && end(x.line).y === 0);
  assert.equal(fs[i].f, 500);
  const before = end(fs[i - 1].line);
  assert.ok(before.x > 45 && before.x < 50 && fs[i - 1].f === 1000, "schnell bis kurz vor der Ecke: " + fs[i - 1].line);
  const after = end(fs[i + 1].line);
  assert.ok(after.y > 0 && after.y < 5 && fs[i + 1].f === 500, "kurz nach der Ecke noch langsam: " + fs[i + 1].line);
});

test("F wird nur bei Änderung geschrieben", () => {
  const out = adaptFeed(square, 1.5, 50);
  const lines = out.split("\n").filter(l => /^G1 X/.test(l));
  let prev = NaN, written = 0;
  for (const l of lines) {
    const m = /F(\d+)/.exec(l);
    if (m) { assert.notEqual(+m[1], prev, "doppeltes F: " + l); prev = +m[1]; written++; }
  }
  assert.ok(written <= 9, "nur ein F je Wechsel: " + written);
});

test("Minimum 100 % oder Zoll/relativ: G-Code bleibt unverändert", () => {
  assert.equal(adaptFeed(square, 1.5, 100), square);
  assert.equal(adaptFeed(square.replace("G90", "G91"), 1.5, 50), square.replace("G90", "G91"));
  assert.equal(adaptFeed(square.replace("G21", "G20"), 1.5, 50), square.replace("G21", "G20"));
});

test("kleiner Kreis (G2) langsamer, großer Kreis nicht", () => {
  const circle = (r: number) => ["G90", "G0 Z5", `G0 X0 Y${r}`, "G1 Z-1 F300", "G1 F1000", `G2 X0 Y${r} I0 J${-r}`, "G0 Z5"].join("\n");
  // Radius 3 mm, Fräser 3 mm (r 1,5): Faktor 3 / 4,5 = 0,67 → 0,6
  assert.equal(feeds(adaptFeed(circle(3), 1.5, 30))[0].f, 600);
  // Radius 50 mm: über 90 % → bleibt
  assert.equal(adaptFeed(circle(50), 1.5, 30), circle(50));
});

test("Polygon-Kreis aus kurzen Geraden wird wie ein Bogen erkannt", () => {
  const n = 64, R = 3;
  const pts = Array.from({ length: n + 1 }, (_, i) => `G1 X${(R * Math.cos(2 * Math.PI * i / n)).toFixed(3)} Y${(R * Math.sin(2 * Math.PI * i / n)).toFixed(3)}`);
  const g = ["G90", "G0 Z5", `G0 X${R} Y0`, "G1 Z-1 F300", "G1 F1000", ...pts.slice(1), "G0 Z5"].join("\n");
  const fs = feeds(adaptFeed(g, 1.5, 30));
  assert.ok(fs.every(x => x.f === 600), "überall wie beim echten Bogen: " + [...new Set(fs.map(x => x.f))]);
});

test("Eintauchen und Rampen behalten ihren Vorschub, danach wieder normal", () => {
  const g = [
    "G90", "G0 Z5", "G0 X0 Y0", "G1 Z-1 F300", "G1 F1000",
    "G1 X10 Y0", "G1 X10 Y2",             // Ecke kurz vor dem Ende → langsam
    "G1 X10 Y10 Z-2",                      // Rampe ohne F: muss wieder 1000 fahren
    "G1 X20 Y10", "G0 Z5", ""
  ].join("\n");
  const out = adaptFeed(g, 1.5, 50);
  const ramp = out.split("\n").find(l => l.includes("Z-2"))!;
  assert.match(ramp, /F1000/);
  assert.match(out, /G1 Z-1 F300/);
});

test("Zeilen mit Kommentar (z. B. Haltesteg) bleiben, F kommt vor den Kommentar", () => {
  const g = ["G90", "G0 Z5", "G0 X0 Y0", "G1 Z-1 F300", "G1 F1000", "G1 X10 Y0", "G1 X10 Y2", "G1 Z-0.5 (Steg)", "G1 X10 Y20", ""].join("\n");
  const out = adaptFeed(g, 1.5, 50);
  assert.match(out, /G1 Z-0\.5 F1000 \(Steg\)/);
});

test("F aus dem vorigen Ausschnitt (startFeed) wird übernommen", () => {
  const g = ["G0 Z5", "G0 X0 Y0", "G1 Z-1 F300", "F1000", "G1 X20 Y0", "G1 X20 Y20", "G1 X0 Y20", "G0 Z5", ""].join("\n");
  const out = adaptFeed(g, 1.5, 50, 1000);
  assert.ok(feeds(out).some(x => x.f === 500));
  // am Ende gilt wieder der ursprüngliche Vorschub
  const fLines = out.split("\n").filter(l => /F\d/.test(l));
  assert.match(fLines[fLines.length - 1], /F1000/);
});
