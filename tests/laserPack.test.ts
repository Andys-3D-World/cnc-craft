// Tests fürs Laser-Paket: Ringe, Z je Durchgang, Barcodes – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fillGroups, ringFill } from "../src/ringFill.ts";
import { pointInPoly } from "../src/polyOffset.ts";
import { cleanZStep, zDepths } from "../src/zPerPass.ts";
import { CODE128, code128, code128Values, ean13, eanCheck } from "../src/editor/barcode.ts";

const sq = (x: number, y: number, r: number) => [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]].map(([a, b]) => ({ x: a, y: b }));
const circle = (x: number, y: number, r: number, n = 64) => Array.from({ length: n }, (_, i) => ({ x: x + r * Math.cos(i * 2 * Math.PI / n), y: y + r * Math.sin(i * 2 * Math.PI / n) }));

test("Flächen: Loch gehört zur Wand, Insel im Loch ist wieder Fläche, einzelne bleiben einzeln", () => {
  const g = fillGroups([sq(0, 0, 20), sq(0, 0, 15), sq(0, 0, 10), sq(100, 0, 5), sq(0, 0, 4)]);
  assert.equal(g.length, 3);
  assert.deepEqual(g.map(x => x.holes.length).sort(), [0, 1, 1]);
  // Anfangspunkt doppelt am Ende stört nicht
  assert.equal(fillGroups([[...sq(0, 0, 5), sq(0, 0, 5)[0]]])[0].outer.length, 4);
  assert.deepEqual(fillGroups([[{ x: 0, y: 0 }, { x: 1, y: 0 }]]), []);
});

test("Ringe: bleiben in der Fläche, Abstand stimmt, nichts bleibt ungefüllt", () => {
  const polys = [sq(0, 0, 10), circle(0, 0, 4)], step = 0.5;
  const { paths, rest } = ringFill(polys, step);
  assert.deepEqual(rest, []);
  const dense: { x: number; y: number }[] = [];
  for (const p of paths) {
    const seq = p.closed ? [...p.pts, p.pts[0]] : p.pts;
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1], b = seq[i], k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.1));
      for (let s = 0; s < k; s++) dense.push({ x: a.x + (b.x - a.x) * s / k, y: a.y + (b.y - a.y) * s / k });
    }
  }
  for (const q of dense) {
    assert.ok(Math.abs(q.x) <= 10 - step / 2 + 0.02 && Math.abs(q.y) <= 10 - step / 2 + 0.02, JSON.stringify(q));
    assert.ok(Math.hypot(q.x, q.y) >= 4 + step / 2 - 0.05, JSON.stringify(q));
  }
  // nichts wird doppelt gebrannt: Bahnlänge = Fläche ÷ Abstand
  let len = 0;
  for (const p of paths) { const seq = p.closed ? [...p.pts, p.pts[0]] : p.pts; for (let i = 1; i < seq.length; i++) len += Math.hypot(seq[i].x - seq[i - 1].x, seq[i].y - seq[i - 1].y); }
  const want = (400 - Math.PI * 16) / step;
  assert.ok(Math.abs(len / want - 1) < 0.06, `${len} statt ${want}`);
  // jeder Punkt der Fläche hat eine Bahn in höchstens einem Linienabstand
  for (let x = -9.9; x < 10; x += 0.7) for (let y = -9.9; y < 10; y += 0.7) {
    if (Math.hypot(x, y) < 4.1 || !pointInPoly(x, y, polys[0])) continue;
    assert.ok(dense.some(q => Math.hypot(q.x - x, q.y - y) <= step), `${x} ${y}`);
  }
});

test("Ringe: zu schmale oder zu aufwendige Flächen gehen zurück an die Linien-Füllung", () => {
  const thin = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0.2 }, { x: 0, y: 0.2 }];
  assert.equal(ringFill([thin], 0.5).rest.length, 1);
  assert.equal(ringFill([circle(0, 0, 200, 3000)], 0.05).rest.length, 1);
  assert.equal(ringFill([sq(0, 0, 5)], 0).rest.length, 1);
});

test("Z je Durchgang: kleine Schritte, harte Grenzen", () => {
  assert.deepEqual(zDepths(4, 0), [0, 0, 0, 0]);
  assert.deepEqual(zDepths(4, 0.5), [0, 0.5, 1, 1.5]);
  assert.deepEqual(zDepths(5, 1, 3), [0, 1, 2, 3, 3]);
  assert.deepEqual(zDepths(5, 2), [0, 2, 4, 5, 5]);
  assert.deepEqual(zDepths(1, 2), [0]);
  assert.equal(cleanZStep(99), 2); assert.equal(cleanZStep(-1), 0); assert.equal(cleanZStep("x"), 0); assert.equal(cleanZStep(undefined), 0);
});

test("Code 128: Tabelle stimmt in sich, Prüfsumme von Hand", () => {
  assert.equal(CODE128.length, 107);
  assert.equal(new Set(CODE128).size, 107);
  CODE128.forEach((c, i) => {
    const w = [...c].map(Number);
    assert.equal(w.length, i === 106 ? 7 : 6);
    assert.equal(w.reduce((a, b) => a + b), i === 106 ? 13 : 11);
    if (i < 106) assert.equal((w[0] + w[2] + w[4]) % 2, 0);
  });
  assert.deepEqual(code128Values("PJJ123C"), [104, 48, 42, 42, 17, 18, 19, 35, 55]); // Start B: 879 mod 103 = 55
  assert.deepEqual(code128Values("123456")!.slice(0, 4), [105, 12, 34, 56]);
  assert.deepEqual(code128Values("A123456")!.slice(0, -1), [104, 33, 99, 12, 34, 56]);
  assert.deepEqual(code128Values("A12345")!.slice(0, -1), [104, 33, 17, 99, 23, 45]);
  assert.deepEqual(code128Values("1234A")!.slice(0, -1), [105, 12, 34, 100, 33]);
  assert.equal(code128Values(""), null); assert.equal(code128Values("ä"), null); assert.equal(code128Values("x".repeat(61)), null);
  const b = code128("AB")!;
  assert.equal(b.width, 11 * 4 + 13);
  assert.equal(b.bars[0].x, 0);
  assert.equal(b.bars[b.bars.length - 1].x + b.bars[b.bars.length - 1].w, b.width);
});

test("EAN-13: Prüfziffer, Breite 95, falsche Eingaben", () => {
  assert.equal(eanCheck("400638133393"), 1);
  const b = ean13("4006381333931")!;
  assert.equal(b.width, 95); assert.equal(b.bars.length, 30);
  assert.equal(ean13("400638133393")!.text, "4006381333931");
  assert.equal(ean13("4006381333932"), null);
  assert.equal(ean13("123"), null); assert.equal(ean13("40063813339x"), null);
});

// ---- echter G-Code: laserCam.ts läuft hier mit (Pfade ohne Endung, JSON ohne Attribut wie unter Vite) ----
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
  const L = await import("../src/laserLayers.ts");
  const { generateLaserGcode } = await import("../src/laserCam.ts");
  const { lintGcode } = await import("../src/gcodeLint.ts");
  const { createPolyline, createCircle, MM_TO_PIXEL: PX } = await import("../src/shapeTransform.ts");
  L.initLaserLayers();
  const plate = (id: string) => Object.assign(createPolyline([[10, 10], [50, 10], [50, 40], [10, 40]].map(([x, y]) => ({ x: x * PX, y: y * PX })), true, "outside", {}), { laserLayerId: id });
  const hole = (id: string) => Object.assign(createCircle(30 * PX, 25 * PX, 8 * PX, "inside"), { laserLayerId: id });
  const set = (id: string, d: any) => L.updateLayer(id, { fillKind: "lines", overcut: 0, zStep: 0, passes: 1, thickness: 0, ...d });
  const gen = (shapes: any[]) => generateLaserGcode(shapes);
  const lint = (code: string) => lintGcode(code, { kind: "laser", sMax: 1000, bedW: 300, bedH: 300 });
  return { L, gen, lint, plate, hole, set, code: (x: string) => x.split("\n").map(l => l.replace(/\(.*?\)/g, "").trim()).filter(Boolean) };
}
/** gebrannte Strecken (S > 0) */
function burnt(lines: string[]) {
  let x = 0, y = 0, s = 0; const out: number[][] = [];
  for (const l of lines) {
    const m = /^G([01]) X(-?[\d.]+) Y(-?[\d.]+)(?: S(\d+))?/.exec(l);
    if (!m) continue;
    if (m[4] !== undefined) s = +m[4];
    if (m[1] === "1" && s > 0) out.push([x, y, +m[2], +m[3]]);
    x = +m[2]; y = +m[3];
  }
  return out;
}

test("G-Code Füllen: über Kreuz = beide Richtungen, Ringe bleiben in der Fläche", async () => {
  const c = await cam();
  const shapes = () => [c.plate("L2"), c.hole("L2")];
  c.set("L2", { mode: "fill", interval: 1, angle: 0 });
  const lines = burnt(c.code(c.gen(shapes()).gcode!));
  c.set("L2", { mode: "fill", interval: 1, angle: 0, fillKind: "cross" });
  const x = c.gen(shapes()), cross = burnt(c.code(x.gcode!));
  assert.deepEqual(cross.slice(0, lines.length), lines);
  const rest = cross.slice(lines.length);
  assert.ok(rest.length >= 40 && rest.every(([a, , b]) => Math.abs(a - b) < 1e-6), "zweites Mal senkrecht");
  assert.ok(lines.every(([, a, , b]) => Math.abs(a - b) < 1e-6));
  assert.deepEqual(c.lint(x.gcode!), []);
  c.set("L2", { mode: "fill", interval: 1, fillKind: "rings" });
  const r = c.gen(shapes()), ring = burnt(c.code(r.gcode!));
  assert.deepEqual(c.lint(r.gcode!), []);
  assert.equal(r.warnings.length, 0);
  for (const q of ring) for (const [px, py] of [[q[0], q[1]], [q[2], q[3]]]) {
    assert.ok(px >= 10.4 && px <= 49.6 && py >= 10.4 && py <= 39.6, `${px} ${py}`);
    assert.ok(Math.hypot(px - 30, py - 25) >= 8.4, `${px} ${py}`);
  }
  // zu schmal für Ringe: Linien und ein Hinweis
  c.set("L2", { mode: "fill", interval: 5, fillKind: "rings" });
  const w = c.gen([Object.assign(c.hole("L2"), { w: 3, h: 3 })]);
  assert.equal(w.warnings.length, 1);
  c.set("L2", { mode: "fill", interval: 0.1 });
});

test("G-Code Überlauf: gleiche Bahn, danach genau so viel weiter", async () => {
  const c = await cam();
  c.set("L1", { mode: "line" });
  const a = c.code(c.gen([c.plate("L1")]).gcode!);
  c.set("L1", { mode: "line", overcut: 7 });
  const r = c.gen([c.plate("L1")]), b = c.code(r.gcode!);
  const A = burnt(a), B = burnt(b);
  assert.deepEqual(B.slice(0, A.length), A);
  const extra = B.slice(A.length).reduce((s, q) => s + Math.hypot(q[2] - q[0], q[3] - q[1]), 0);
  assert.ok(Math.abs(extra - 7) < 0.01, String(extra));
  assert.deepEqual(c.lint(r.gcode!), []);
  c.set("L1", { mode: "line" });
});

test("G-Code Z je Durchgang: nur relativ, nur mit S0, am Ende wieder auf Starthöhe", async () => {
  const c = await cam();
  c.set("L1", { mode: "line", passes: 4 });
  const base = c.gen([c.plate("L1"), c.hole("L1")]).gcode!;
  c.set("L1", { mode: "line", passes: 4, zStep: 0.5, thickness: 1.2 });
  const r = c.gen([c.plate("L1"), c.hole("L1")]), l = c.code(r.gcode!);
  assert.equal(r.warnings.length, 1);
  const z = l.map((x, i) => ({ x, i })).filter(q => /Z/.test(q.x));
  assert.deepEqual(z.map(q => q.x), ["G0 Z-0.5 S0", "G0 Z-0.5 S0", "G0 Z-0.2 S0", "G0 Z1.2 S0"]);
  for (const q of z) { assert.equal(l[q.i - 1], "G91"); assert.equal(l[q.i + 1], "G90"); }
  assert.ok(Math.abs(z.reduce((s, q) => s + parseFloat(q.x.slice(4)), 0)) < 1e-9);
  // ohne die Z-Zeilen dasselbe Programm
  const strip = (a: string[]) => a.filter((x, i) => !(/Z/.test(x) || (x === "G91") || (x === "G90" && /Z/.test(a[i - 1] ?? ""))));
  assert.deepEqual(strip(l), c.code(base));
  assert.deepEqual(c.lint(r.gcode!), []);
  // ein Durchgang oder Füllen: kein Z
  c.set("L1", { mode: "line", passes: 1, zStep: 1 });
  assert.ok(!/Z/.test(c.code(c.gen([c.plate("L1")]).gcode!).join("")));
  c.set("L1", { mode: "fill", passes: 3, zStep: 1, interval: 1 });
  assert.ok(!/Z/.test(c.code(c.gen([c.plate("L1")]).gcode!).join("")));
  // Testfelder fahren nie tiefer
  c.set("L1", { mode: "line", passes: 3, zStep: 1 });
  const t = Object.assign(c.plate("L1"), { laserOverride: { power: 40, speed: 900, interval: 0.1 } });
  assert.ok(!/Z/.test(c.code(c.gen([t]).gcode!).join("")));
  c.set("L1", { mode: "line" });
});

test("Ebenen aus fremden Dateien: neue Felder werden geprüft", async () => {
  const c = await cam();
  const l = c.L.addLayer({ name: "x", mode: "line", fillKind: "<img>" as any, overcut: -5, zStep: 99 });
  assert.equal(l.fillKind, "lines"); assert.equal(l.overcut, 0); assert.equal(l.zStep, 2);
  c.L.removeLayer(l.id);
});
