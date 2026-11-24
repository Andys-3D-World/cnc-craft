// Tests für Plasma: schneiden / ankörnen / auslassen – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boxOf, nearestOrder, plasmaOpOf, resolveOp } from "../src/plasmaSpot.ts";

const ring = (cx: number, cy: number, r: number, n = 24) => Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(i * 2 * Math.PI / n), y: cy + r * Math.sin(i * 2 * Math.PI / n) }));

test("Einstellung der Form: nur bekannte Werte, sonst automatisch", () => {
  assert.equal(plasmaOpOf({}), "auto");
  assert.equal(plasmaOpOf(null), "auto");
  for (const v of ["cut", "spot", "skip"]) assert.equal(plasmaOpOf({ plasmaOp: v }), v);
  for (const v of ["auto", "SPOT", 1, "<img>", {}]) assert.equal(plasmaOpOf({ plasmaOp: v }), "auto");
});

test("automatisch: nur geschlossene Löcher bis zur Grenze werden angekörnt; Grenze 0 = aus", () => {
  const hole = [{ pts: ring(50, 50, 3), closed: true }];
  assert.equal(resolveOp({ millingMode: "inside" }, hole, 0), "cut", "aus = wie bisher");
  assert.equal(resolveOp({ millingMode: "inside" }, hole, 6), "spot");
  assert.equal(resolveOp({ millingMode: "inside" }, hole, 5.9), "cut");
  assert.equal(resolveOp({ millingMode: "outside" }, hole, 6), "cut", "ein kleines Teil wird nicht angekörnt");
  assert.equal(resolveOp({ millingMode: "inside" }, [{ pts: ring(50, 50, 3), closed: false }], 6), "cut");
  assert.equal(resolveOp({ millingMode: "inside", plasmaOp: "cut" }, hole, 6), "cut");
  assert.equal(resolveOp({ millingMode: "outside", plasmaOp: "spot" }, hole, 0), "spot");
  assert.equal(resolveOp({ plasmaOp: "skip" }, hole, 6), "skip");
  assert.equal(resolveOp({ plasmaOp: "spot" }, [], 6), "cut", "ohne Punkte gibt es keine Mitte");
  const b = boxOf(hole)!;
  assert.ok(Math.abs(b.centre.x - 50) < 1e-9 && Math.abs(b.centre.y - 50) < 1e-9 && Math.abs(b.size - 6) < 1e-9);
  assert.deepEqual(nearestOrder([{ x: 90, y: 0 }, { x: 10, y: 0 }, { x: 50, y: 0 }], { x: 0, y: 0 }).map(p => p.x), [10, 50, 90]);
});

// ---- echter G-Code: plasmaCam.ts läuft hier mit (Pfade ohne Endung, JSON ohne Attribut wie unter Vite) ----
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith(".") && ctx.parentURL?.includes("/src/") && !/\.\w+$/.test(spec)) {
      const p = pathResolve(dirname(fileURLToPath(ctx.parentURL)), spec);
      if (existsSync(p + ".ts")) return { url: pathToFileURL(p + ".ts").href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.endsWith(".json")) return { format: "module", source: "export default " + readFileSync(fileURLToPath(url), "utf8"), shortCircuit: true };
    if (url.endsWith(".ts") && url.includes("/src/")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText
    };
    return next(url, ctx);
  }
});

async function cam() {
  const store = new Map<string, string>();
  const g = globalThis as any;
  g.localStorage ??= { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
  g.window ??= { dispatchEvent() {}, addEventListener() {} };
  g.CustomEvent ??= class { type: string; constructor(type: string) { this.type = type; } };
  g.Event ??= class { type: string; constructor(type: string) { this.type = type; } };
  const PC = await import("../src/plasmaCuts.ts");
  const PCam = await import("../src/plasmaCam.ts");
  const { lintGcode } = await import("../src/gcodeLint.ts");
  const { createPolyline, createCircle, MM_TO_PIXEL: PX } = await import("../src/shapeTransform.ts");
  PC.initPlasmaCuts();
  const plate = () => createPolyline([[10, 10], [110, 10], [110, 70], [10, 70]].map(([x, y]) => ({ x: x * PX, y: y * PX })), true, "outside", {});
  const hole = (x: number, y: number, r: number) => createCircle(x * PX, y * PX, r * PX, "inside");
  return { PC, PCam, lintGcode, plate, hole };
}
const code = (g: string) => g.split("\n").map(l => l.replace(/\(.*?\)/g, "").trim()).filter(Boolean);

test("G-Code: ohne die neuen Einstellungen exakt wie vorher; Ankörnen = Brenner kurz an, ohne Bewegung", async () => {
  const c = await cam();
  const S = { useZ: true, probe: false, thc: "none" as const, avoidCut: false, optimizeOrder: false };
  c.PC.setPlasmaSettings({ ...S, spotMax: 0, spotTime: 100 }, false);
  const shapes = () => [c.plate(), c.hole(30, 40, 2.5), c.hole(90, 40, 2.5), c.hole(60, 40, 10)];
  const base = c.PCam.generatePlasmaGcode(shapes()).gcode!;
  assert.ok(base.includes("M3 S1000"));
  assert.equal((base.match(/M3 S1000/g) || []).length, 4);
  // gleiche Zeichnung, Einstellung „schneiden“ ausdrücklich: gleicher G-Code
  const explicit = shapes(); explicit.forEach(s => { (s as any).plasmaOp = "cut"; });
  assert.equal(c.PCam.generatePlasmaGcode(explicit).gcode, base);

  // Löcher bis 6 mm ankörnen
  c.PC.setPlasmaSettings({ spotMax: 6, spotTime: 150 }, false);
  const res = c.PCam.generatePlasmaGcode(shapes());
  const lines = code(res.gcode!);
  assert.equal(lines.filter(l => /^M3 /.test(l)).length, 4, "2 Ankörn-Punkte + großes Loch + Platte");
  // jeder Ankörn-Punkt: hinfahren, Einstechhöhe, an, warten, aus, hoch – dazwischen keine Bewegung in X/Y
  const idx = lines.map((l, i) => (l === "G4 P0.15" ? i : -1)).filter(i => i >= 0);
  assert.equal(idx.length, 2);
  for (const i of idx) {
    assert.ok(lines[i - 1].startsWith("M3"), lines[i - 1]);
    assert.equal(lines[i + 1], "M5");
    assert.match(lines[i - 3], /^G0 X(30|90) Y40$/);
    assert.match(lines[i - 2], /^G0 Z/);
    assert.match(lines[i + 2], /^G0 Z/);
  }
  // die Ankörn-Punkte kommen vor den Schnitten
  assert.ok(Math.max(...idx) < lines.findIndex(l => /^G1 X/.test(l)));
  assert.deepEqual(c.lintGcode(res.gcode!, { kind: "plasma", bedW: 300, bedH: 300 }), [], "Prüfung findet nichts");
  assert.deepEqual(c.lintGcode(base, { kind: "plasma", bedW: 300, bedH: 300 }), []);

  // ohne Z-Achse: nur an – warten – aus
  c.PC.setPlasmaSettings({ useZ: false }, false);
  const noZ = code(c.PCam.generatePlasmaGcode(shapes()).gcode!);
  const j = noZ.indexOf("G4 P0.15");
  assert.match(noZ[j - 2], /^G0 X/); assert.ok(noZ[j - 1].startsWith("M3")); assert.equal(noZ[j + 1], "M5");
  assert.ok(!noZ.some(l => /Z/.test(l)));
  c.PC.setPlasmaSettings({ useZ: true, spotMax: 0 }, false);
});

test("G-Code: auslassen nimmt die Form heraus und meldet es; alles ausgelassen = kein Programm", async () => {
  const c = await cam();
  c.PC.setPlasmaSettings({ spotMax: 0, avoidCut: false, optimizeOrder: false }, false);
  const a = [c.plate(), c.hole(60, 40, 10)];
  const without = c.PCam.generatePlasmaGcode([a[0]]).gcode!;
  (a[1] as any).plasmaOp = "skip";
  const res = c.PCam.generatePlasmaGcode(a);
  assert.equal(res.warnings.length, 1);
  assert.deepEqual(code(res.gcode!), code(without), "wie ohne die Form");
  (a[0] as any).plasmaOp = "skip";
  assert.equal(c.PCam.generatePlasmaGcode(a).gcode, null);
  // von Hand ankörnen, auch wenn die Automatik aus ist – Zeit bleibt in den Grenzen
  c.PC.setPlasmaSettings({ spotTime: 5 }, false);
  assert.equal(c.PC.plasmaSettings.spotTime, 20);
  const s = [c.plate(), c.hole(60, 40, 10)]; (s[1] as any).plasmaOp = "spot";
  const g = code(c.PCam.generatePlasmaGcode(s).gcode!);
  assert.ok(g.includes("G4 P0.02"));
  assert.equal(g.filter(l => /^M3 /.test(l)).length, 2);
  c.PC.setPlasmaSettings({ spotTime: 100 }, false);
});
