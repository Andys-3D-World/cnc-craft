// Tests für Plasma: Ausfahrbahn, Abtasten auslassen, Wärme verteilen, Einstiche zählen, schiefe Platte – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spreadOrder } from "../src/heatSpread.ts";
import { optimizeCutOrder, travelLength, precedence } from "../src/cutOrder.ts";
import { countPierces } from "../src/pierceCount.ts";
import { applyFit, plateFit, plateProblem } from "../src/editor/printCut.ts";

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


const off = { useZ: true, probe: false, thc: "none" as const, avoidCut: false, optimizeOrder: false, spread: false, probeSkip: 0, spotMax: 0, overcut: 1, smallHole: 25 };
type C = Awaited<ReturnType<typeof cam>>;
const setLead = (c: C, leadOut: number) => c.PC.getCuts().forEach((k: any) => c.PC.updateCut(k.id, { leadOut }));
/** Strecken G1 X… Y… je Kontur (zwischen M3 und M5) als Punktlisten, mit dem Einstich davor */
function cuts(g: string): { x: number; y: number }[][] {
  const out: { x: number; y: number }[][] = []; let cur: { x: number; y: number }[] | null = null, pos = { x: 0, y: 0 };
  for (const l of code(g)) {
    const m = /^G[01] X(-?[\d.]+) Y(-?[\d.]+)/.exec(l);
    if (m) { pos = { x: +m[1], y: +m[2] }; cur?.push(pos); }
    if (l.startsWith("M3")) { cur = [pos]; } else if (l === "M5" && cur) { out.push(cur); cur = null; }
  }
  return out;
}
const inside = (p: { x: number; y: number }, b: number[]) => p.x > b[0] && p.x < b[1] && p.y > b[2] && p.y < b[3];

test("Ausfahrbahn: aus = wie vorher; an = nur ein Punkt mehr, außen draußen, im Loch drinnen", async () => {
  const c = await cam();
  c.PC.setPlasmaSettings(off, false);
  const shapes = () => [c.plate(), c.hole(60, 40, 20)];
  setLead(c, 0);
  const base = c.PCam.generatePlasmaGcode(shapes()).gcode!;
  setLead(c, 4);
  const a = cuts(base), b = cuts(c.PCam.generatePlasmaGcode(shapes()).gcode!);
  assert.equal(a.length, 2); assert.equal(b.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(b[i].length, a[i].length + 1);
    assert.deepEqual(b[i].slice(0, -1), a[i]);
    const e = b[i][b[i].length - 2], o = b[i][b[i].length - 1];
    const d = Math.hypot(o.x - e.x, o.y - e.y);
    assert.ok(d <= 4.001 && d >= 0.49, String(d));
  }
  const hole = b[0][b[0].length - 1], plate = b[1][b[1].length - 1];
  assert.ok(Math.hypot(hole.x - 60, hole.y - 40) < 19, "im Loch bleibt die Bahn im Loch");
  assert.ok(!inside(plate, [10, 110, 10, 70]), "außen liegt das Ende im Abfall");
  assert.deepEqual(c.lintGcode(c.PCam.generatePlasmaGcode(shapes()).gcode!, { kind: "plasma", bedW: 300, bedH: 300 }), []);
  // kleine Löcher und Konturen mit Stegen: keine Ausfahrbahn
  const small = [c.hole(60, 40, 5)];
  const s1 = c.PCam.generatePlasmaGcode(small).gcode!;
  setLead(c, 0);
  assert.equal(c.PCam.generatePlasmaGcode([c.hole(60, 40, 5)]).gcode!, s1);
  const tabs = () => [Object.assign(c.plate(), { tabMode: "auto", tabN: 4, tabLen: 4 })];
  const t0 = c.PCam.generatePlasmaGcode(tabs()).gcode!;
  setLead(c, 4);
  assert.equal(c.PCam.generatePlasmaGcode(tabs()).gcode!, t0);
  // Überlauf länger als eine Seite und ohne Überlauf: Ende bleibt im Abfall
  for (const overcut of [0, 20]) {
    c.PC.setPlasmaSettings({ overcut }, false);
    const p = cuts(c.PCam.generatePlasmaGcode([c.plate()]).gcode!)[0];
    assert.ok(!inside(p[p.length - 1], [9.5, 110.5, 9.5, 70.5]), JSON.stringify(p[p.length - 1]));
  }
  c.PC.setPlasmaSettings({ overcut: 1 }, false);
  setLead(c, 0);
});

test("Abtasten auslassen: nur nah am letzten Messpunkt, nie nach einem Schnitt mit Höhenregelung", async () => {
  const c = await cam();
  const shapes = () => [c.hole(30, 40, 5), c.hole(50, 40, 5), c.hole(250, 40, 5)];
  const probes = (g: string) => code(g).filter(l => l.includes("G38.2")).length;
  c.PC.setPlasmaSettings({ ...off, probe: true, smallHole: 0 }, false);
  const all = c.PCam.generatePlasmaGcode(shapes()).gcode!;
  assert.equal(probes(all), 3);
  c.PC.setPlasmaSettings({ probeSkip: 30 }, false);
  const r = c.PCam.generatePlasmaGcode(shapes());
  assert.equal(probes(r.gcode!), 2);
  // sonst gleich: ohne die Abtast-Zeilen dasselbe Programm
  const rest = (g: string) => code(g).filter(l => !/G38\.2|^G92 Z|^G90$/.test(l));
  assert.deepEqual(rest(r.gcode!), rest(all));
  // die Höhe wird immer erst nach dem ersten Abtasten benutzt
  const l = code(r.gcode!);
  assert.ok(l.findIndex(x => x.includes("G38.2")) < l.findIndex(x => /^M3 S1000/.test(x)));
  c.PC.setPlasmaSettings({ thc: "external" }, false);
  const thc = c.PCam.generatePlasmaGcode(shapes());
  assert.equal(probes(thc.gcode!), 3, "nach THC immer neu");
  assert.ok(thc.warnings.length >= 1);
  // kleine Löcher laufen ohne THC: danach darf ausgelassen werden; nach dem großen Schnitt mit THC nicht mehr
  c.PC.setPlasmaSettings({ smallHole: 25 }, false);
  assert.equal(probes(c.PCam.generatePlasmaGcode(shapes()).gcode!), 2);
  const mixed = [c.hole(60, 40, 3), c.hole(66, 40, 14), c.plate()];
  assert.equal(probes(c.PCam.generatePlasmaGcode(mixed).gcode!), 2, "kleines Loch, dann großes (Höhe gilt noch), nach dessen THC neu");
  c.PC.setPlasmaSettings({ ...off }, false);
});

test("Wärme verteilen: Löcher vor dem Teil, aufeinanderfolgende Schnitte weit auseinander", () => {
  const sq = (x: number, y: number, r: number) => [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]].map(([a, b]) => ({ x: a, y: b }));
  const items: any[] = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) for (const r of [8, 3]) { const pts = sq(30 * i + 20, 30 * j + 20, r); items.push({ entry: pts[0], exit: pts[0], pts, closed: true }); }
  const from = { x: 0, y: 0 }, o = spreadOrder(items, from);
  assert.deepEqual(o.slice().sort((a, b) => a - b), items.map((_, i) => i));
  const pre = precedence(items), at = new Map(o.map((v, k) => [v, k]));
  pre.forEach((ps, b) => ps.forEach(a => assert.ok(at.get(a)! < at.get(b)!)));
  const mid = (i: number) => ({ x: items[i].pts[0].x, y: items[i].pts[0].y });
  let near = 0;
  for (let k = 1; k < o.length; k++) { const a = mid(o[k - 1]), b = mid(o[k]); if (Math.hypot(a.x - b.x, a.y - b.y) < 35) near++; }
  assert.ok(near <= 2, `${near} Nachbarn direkt nacheinander`);
  const short = optimizeCutOrder(items, from);
  assert.ok(travelLength(items, o.map(index => ({ index, reversed: false, start: 0 })), from) > travelLength(items, short, from));
  assert.deepEqual(spreadOrder([], from), []);
  assert.deepEqual(spreadOrder(items.slice(0, 1), from), [0]);
});

test("Wärme verteilen im G-Code: gleiche Schnitte, andere Reihenfolge", async () => {
  const c = await cam();
  c.PC.setPlasmaSettings(off, false);
  const shapes = () => [20, 60, 100, 140, 180].map(x => c.hole(x, 40, 15));
  const a = cuts(c.PCam.generatePlasmaGcode(shapes()).gcode!);
  c.PC.setPlasmaSettings({ spread: true }, false);
  const b = cuts(c.PCam.generatePlasmaGcode(shapes()).gcode!);
  const key = (l: { x: number; y: number }[]) => JSON.stringify(l);
  assert.deepEqual(b.map(key).sort(), a.map(key).sort());
  assert.notDeepEqual(b.map(key), a.map(key));
  c.PC.setPlasmaSettings(off, false);
});

test("Einstiche zählen", () => {
  const l = ["M5", "M3 S1000 (an)", "G1 X1", "M5", "(M3 S1000)", "m03 s500", "M30", "M3 S0", "M4", "M3"];
  assert.equal(countPierces(l), 4);
  assert.equal(countPierces(l, 2), 3);
  assert.equal(countPierces(l, 0, 2), 1);
  assert.equal(countPierces(l, 0, 999), 4);
});

test("schiefe Platte: Nullpunkt auf die Ecke, X an die Kante; falsche Punkte werden abgelehnt", () => {
  const deg = Math.PI / 180, c = { x: 12, y: 34 }, e = { x: 12 + 500 * Math.cos(3 * deg), y: 34 + 500 * Math.sin(3 * deg) };
  const f = plateFit(c, e);
  assert.ok(Math.abs(f.angle - 3 * deg) < 1e-12);
  const o = applyFit(f, { x: 0, y: 0 }), x = applyFit(f, { x: 100, y: 0 }), y = applyFit(f, { x: 0, y: 100 });
  assert.ok(Math.hypot(o.x - 12, o.y - 34) < 1e-9);
  assert.ok(Math.hypot(x.x - (12 + 100 * Math.cos(3 * deg)), x.y - (34 + 100 * Math.sin(3 * deg))) < 1e-9);
  assert.ok(Math.hypot(y.x - (12 - 100 * Math.sin(3 * deg)), y.y - (34 + 100 * Math.cos(3 * deg))) < 1e-9);
  assert.equal(plateProblem(f), "");
  assert.equal(plateProblem(plateFit(c, { x: 15, y: 34 })), "tooClose");
  assert.equal(plateProblem(plateFit(e, c)), "angle");
  assert.equal(plateProblem(plateFit(c, { x: 12, y: 300 })), "angle");
});
