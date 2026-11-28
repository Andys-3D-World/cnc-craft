// Per-shape planning for laser and plasma: TypeScript (computePlan in src/plasmaCam.ts, withLeadIn in src/laserCam.ts,
// tabRuns in src/tabs.ts, applyCut in src/cutSetting.ts) and Rust (src-tauri/src/cutplan.rs) must plan the same:
// direction, start point, lead-in, holding tabs, overcut, lead-out. This test runs the real G-code generators on many
// drawings, takes what they planned (setPlanSink in src/planRust.ts) and pins it in fixtures/cutplan-cases.json.gz;
// `cargo test cutplan` plans the same inputs in Rust and compares (numbers to 1e-9, the rest exactly).
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test cutplan
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import ts from "typescript";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// the generators import without file endings and JSON without attribute (as under Vite) – same hooks as rapidAvoidBed.test.ts
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
const g = globalThis as any, store = new Map<string, string>();
g.localStorage ??= { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
g.window ??= { dispatchEvent() {}, addEventListener() {} };
g.CustomEvent ??= class { type: string; constructor(type: string) { this.type = type; } };
g.Event ??= class { type: string; constructor(type: string) { this.type = type; } };

const LL = await import("../src/laserLayers.ts");
const PC = await import("../src/plasmaCuts.ts");
const LC = await import("../src/laserCam.ts");
const PCam = await import("../src/plasmaCam.ts");
const { setPlanSink } = await import("../src/planRust.ts");
const { createPolyline, MM_TO_PIXEL: PX } = await import("../src/shapeTransform.ts");

const file = new URL("./fixtures/cutplan-cases.json.gz", import.meta.url);
type P = { x: number; y: number };
let uid = 0;
const poly = (pts: P[], closed: boolean, mode: string, extra: Record<string, unknown> = {}) => {
  const s = createPolyline(pts.map(p => ({ x: p.x * PX, y: p.y * PX })), closed, mode, {}) as any;
  Object.assign(s, extra, { id: "cp" + ++uid });
  return s;
};
const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const ngon = (cx: number, cy: number, r: number, n: number, a0 = 0.3): P[] => Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(a0 + (2 * Math.PI * i) / n), y: cy + r * Math.sin(a0 + (2 * Math.PI * i) / n) }));
const star = (cx: number, cy: number, r1: number, r2: number, n: number): P[] => Array.from({ length: 2 * n }, (_, i) => { const r = i % 2 ? r2 : r1, a = (Math.PI * i) / n; return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; });
const circle = (cx: number, cy: number, r: number, extra: Record<string, unknown> = {}) => Object.assign({ id: "cp" + ++uid, type: "circle", x: cx * PX, y: cy * PX, w: r * PX, h: r * PX, rotation: 0, millingMode: "outside" }, extra);
const L: P[] = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 }, { x: 12, y: 10 }, { x: 12, y: 30 }, { x: 0, y: 30 }];
const spiky: P[] = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 0.02 }, { x: 30.5, y: 10 }, { x: 30, y: 10.01 }, { x: 30, y: 20 }, { x: 0, y: 20 }, { x: 0.03, y: 10 }];

const names: { plasma: string[]; laser: string[] } = { plasma: [], laser: [] };
const job: { plasma: unknown[]; laser: unknown[] } = { plasma: [], laser: [] };
const want: { plasma: unknown[]; laser: unknown[] } = { plasma: [], laser: [] };
setPlanSink(r => {
  for (const x of r.plasma) { job.plasma.push(x.input); want.plasma.push(x.plan); names.plasma.push(current); }
  for (const x of r.laser) { job.laser.push(x.input); want.laser.push(x.out); names.laser.push(current); }
});
let current = "";

const plasma = (name: string, shapes: any[], cut: Record<string, number> = {}, settings: Record<string, number> = {}) => {
  current = name;
  PC.initPlasmaCuts();
  PC.updateCut("P1", { kerf: 1.5, leadIn: 3, leadOut: 0, ...cut } as any);
  PC.setPlasmaSettings({ overcut: 0, smallHole: 0, avoidCut: false, ...settings } as any, false);
  for (const s of shapes) s.plasmaCutId = "P1";
  PCam.generatePlasmaGcode(shapes);
};
const laser = (name: string, shapes: any[], layer: Record<string, unknown> = {}) => {
  current = name;
  LL.initLaserLayers();
  const id = "L1"; // the cut layer (line)
  LL.updateLayer(id, { leadIn: 0, ...layer } as any);
  for (const s of shapes) s.laserLayerId = id;
  LC.generateLaserGcode(shapes);
};

// ---- plasma ----
plasma("rectangle outside", [poly(rect(10, 10, 60, 40), true, "outside")]);
plasma("rectangle inside", [poly(rect(10, 10, 60, 40), true, "inside")]);
plasma("no kerf", [poly(rect(10, 10, 60, 40), true, "outside")], { kerf: 0 });
plasma("regular polygons", [5, 6, 8, 12].map((n, k) => poly(ngon(30 + k * 50, 30, 18, n, 0.1 * k + 0.3), true, k % 2 ? "inside" : "outside")));
plasma("star", [poly(star(40, 40, 25, 10, 5), true, "outside")]);
plasma("L shape and circle", [poly(L, true, "outside"), circle(80, 20, 12)]);
plasma("plate with holes", [poly(rect(0, 0, 100, 60), true, "outside"), circle(25, 30, 8, { millingMode: "inside" }), poly(ngon(70, 30, 10, 6), true, "inside")]);
plasma("long lead-in in a small hole", [poly(ngon(30, 30, 3, 8), true, "inside")], { leadIn: 8 });
plasma("lead-in does not fit at all", [poly(rect(0, 0, 2.2, 2.2), true, "inside")], { leadIn: 5 });
plasma("too small for the kerf", [poly(rect(0, 0, 1, 1), true, "inside")], { kerf: 2 });
plasma("lead-out and overcut", [poly(rect(10, 10, 60, 40), true, "outside"), poly(ngon(35, 25, 6, 10), true, "inside")], { leadOut: 4 }, { overcut: 2 });
plasma("lead-out but small hole", [poly(ngon(30, 30, 4, 12), true, "inside"), poly(ngon(60, 30, 12, 12), true, "inside")], { leadOut: 3 }, { smallHole: 10 });
plasma("long overcut over corners", [poly(rect(0, 0, 10, 5), true, "outside")], {}, { overcut: 18 });
plasma("open lines and on-line", [poly([{ x: 0, y: 0 }, { x: 30, y: 10 }, { x: 60, y: 0 }], false, "on-line"), poly(rect(70, 0, 90, 20), true, "on-line"), poly([{ x: 0, y: 30 }, { x: 40, y: 30 }], false, "on-line", { cutDir: "reverse" })]);
plasma("spikes and tiny steps", [poly(spiky, true, "outside")]);
plasma("hand direction cw/ccw", [poly(rect(0, 0, 30, 20), true, "outside", { cutDir: "ccw" }), poly(rect(40, 0, 70, 20), true, "inside", { cutDir: "cw" }), poly(rect(80, 0, 110, 20), true, "outside", { cutDir: "cw" })]);
plasma("hand start point", [poly(rect(0, 0, 30, 20), true, "outside", { cutStart: 0.3 }), poly(L.map(p => ({ x: p.x + 40, y: p.y })), true, "outside", { cutStart: 0 }), circle(100, 15, 10, { cutStart: 0.62 }), poly(rect(0, 30, 30, 50), true, "inside", { cutStart: 0.999999, cutDir: "ccw" })]);
plasma("bad hand values", [poly(rect(0, 0, 30, 20), true, "outside", { cutStart: 1.5, cutDir: "sideways" }), poly(rect(40, 0, 70, 20), true, "outside", { cutStart: "0.5" })]);
plasma("tabs automatic", [poly(rect(0, 0, 80, 50), true, "outside", { tabMode: "auto", tabN: 4, tabLen: 5 }), circle(120, 25, 20, { tabMode: "auto", tabN: 3, tabLen: 4 })]);
plasma("tabs manual", [poly(rect(0, 0, 80, 50), true, "outside", { tabMode: "manual", tabPts: [0, 0.1, 0.5, "0.75", null, 2], tabLen: 4 }), circle(120, 25, 20, { tabMode: "manual", tabPts: [0.25, 0.9], tabLen: 3 })]);
plasma("tab at the start", [poly(rect(0, 0, 40, 40), true, "outside", { tabMode: "manual", tabPts: [0], tabLen: 6, cutStart: 0 }), poly(rect(50, 0, 90, 40), true, "outside", { tabMode: "auto", tabN: 4, tabLen: 6 })]);
plasma("too many tabs", [poly(rect(0, 0, 20, 10), true, "outside", { tabMode: "auto", tabN: 30, tabLen: 3 })]);
plasma("tabs off: length 0 or no list", [poly(rect(0, 0, 40, 20), true, "outside", { tabMode: "auto", tabN: 3, tabLen: 0 }), poly(rect(50, 0, 90, 20), true, "outside", { tabMode: "manual", tabPts: "0.5", tabLen: 3 }), poly(rect(100, 0, 140, 20), true, "outside", { tabMode: "auto", tabN: 2.4, tabLen: 3 })]);
plasma("tabs with overcut and lead-out (both left out)", [poly(rect(0, 0, 60, 40), true, "outside", { tabMode: "auto", tabN: 2, tabLen: 4 })], { leadOut: 3 }, { overcut: 3 });
plasma("big kerf rounds corners", [poly(star(40, 40, 30, 12, 6), true, "outside"), poly(star(40, 40, 30, 12, 6), true, "inside")], { kerf: 4, leadIn: 6 });
plasma("many points (circle-like)", [poly(ngon(50, 50, 30, 90, 0.05), true, "outside")]);
plasma("turned square", [poly(ngon(40, 40, 20, 4, Math.PI / 7), true, "outside"), poly(ngon(90, 40, 20, 4, 1.1), true, "inside")]);

plasma("no lead-in", [poly(rect(0, 0, 30, 20), true, "outside"), poly(ngon(60, 15, 8, 6), true, "inside")], { leadIn: 0 });
plasma("corners of only 33 degrees, start on an edge", [poly([{ x: 50 + 20 * Math.cos(0.3 + Math.PI / 11) * Math.cos(Math.PI / 11), y: 50 + 20 * Math.sin(0.3 + Math.PI / 11) * Math.cos(Math.PI / 11) }, ...ngon(50, 50, 20, 11, 0.3).slice(1), ngon(50, 50, 20, 11, 0.3)[0]], true, "outside"), poly((v => [{ x: (v[10].x + v[0].x) / 2, y: (v[10].y + v[0].y) / 2 }, ...v])(ngon(110, 50, 20, 11, 0.1)), true, "inside")], { kerf: 0 });
plasma("comb of spikes", [poly([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }, { x: 20, y: 1.5 }, { x: 30, y: 3 }, { x: 20, y: 4.5 }, { x: 30, y: 6 }, { x: 20, y: 7.5 }, { x: 20, y: 10 }, { x: 0, y: 10 }], true, "outside")], { kerf: 0 });
plasma("spikes without kerf, end close to start", [poly([...spiky, { x: 0.02, y: 0.01 }], true, "outside")], { kerf: 0 });
// slot 1 mm wide next to a 1 mm arm: a lead-in from the slot wall must not run through the arm
const slot: P[] = [{ x: 0, y: 0 }, { x: 16, y: 0 }, { x: 16, y: 10 }, { x: 15, y: 10 }, { x: 15, y: 2 }, { x: 14, y: 2 }, { x: 14, y: 10 }, { x: 0, y: 10 }];
plasma("lead-in must not cross a thin arm", [poly(slot, true, "outside", { cutStart: 40 / 68 })], { kerf: 0, leadIn: 3 });
plasma("tabs: 0.4 rounds to none, overlapping by hand, short last piece", [poly(rect(0, 0, 40, 20), true, "outside", { tabMode: "auto", tabN: 0.4, tabLen: 3 }), poly(rect(50, 0, 90, 20), true, "outside", { tabMode: "manual", tabPts: [0.5, 0.505, 0.2], tabLen: 3 }), poly(rect(100, 0, 120, 10), true, "outside", { tabMode: "auto", tabN: 3, tabLen: 3 })], { kerf: 0 });

// ---- laser ----
laser("laser: rectangles, no lead-in", [poly(rect(0, 0, 30, 20), true, "on-line"), poly(rect(40, 0, 70, 20), true, "on-line")]);
laser("laser: lead-in, nested", [poly(rect(0, 0, 100, 60), true, "on-line"), poly(ngon(30, 30, 10, 6), true, "on-line"), poly(rect(60, 10, 90, 50), true, "on-line"), poly(ngon(75, 30, 6, 5), true, "on-line")], { leadIn: 2 });
laser("laser: regular polygons with lead-in", [5, 6, 8, 12].map((n, k) => poly(ngon(30 + k * 50, 30, 18, n, 0.2 * k + 0.1), true, "on-line")), { leadIn: 1.5 });
laser("laser: star and L", [poly(star(40, 40, 25, 10, 5), true, "on-line"), poly(L.map(p => ({ x: p.x + 80, y: p.y })), true, "on-line")], { leadIn: 3 });
laser("laser: hand direction and start", [poly(rect(0, 0, 30, 20), true, "on-line", { cutDir: "cw", cutStart: 0.4 }), poly(ngon(60, 15, 10, 6), true, "on-line", { cutStart: 0.1 }), circle(100, 15, 10, { cutDir: "ccw", millingMode: "on-line" })], { leadIn: 2 });
laser("laser: open lines", [poly([{ x: 0, y: 0 }, { x: 20, y: 5 }, { x: 40, y: 0 }], false, "on-line"), poly([{ x: 0, y: 10 }, { x: 40, y: 10 }], false, "on-line", { cutDir: "reverse" }), poly([{ x: 0, y: 20 }, { x: 40, y: 20 }], false, "on-line", { cutDir: "forward" })]);
laser("laser: tabs", [poly(rect(0, 0, 80, 50), true, "on-line", { tabMode: "auto", tabN: 4, tabLen: 2 }), circle(120, 25, 20, { tabMode: "manual", tabPts: [0, 0.5], tabLen: 2, millingMode: "on-line" }), poly(rect(0, 60, 40, 90), true, "on-line", { tabMode: "manual", tabPts: [0.01], tabLen: 3, cutStart: 0 })], { leadIn: 2 });
laser("laser: closed path with doubled end point", [poly([...rect(0, 0, 30, 20), { x: 0, y: 0 }], true, "on-line")], { leadIn: 2 });
laser("laser: lead-in too long for a small hole", [poly(rect(0, 0, 60, 60), true, "on-line"), poly(ngon(30, 30, 1.5, 8), true, "on-line")], { leadIn: 10 });
laser("laser: tiny shapes", [poly(rect(0, 0, 0.3, 0.3), true, "on-line"), poly(ngon(5, 5, 0.2, 6), true, "on-line"), poly(rect(10, 0, 30, 20), true, "on-line")], { leadIn: 1 });
laser("laser: start exactly on a corner, doubled end", [poly(rect(0, 0, 30, 30), true, "on-line", { cutStart: 0.25 }), poly([...rect(40, 0, 70, 30), { x: 40, y: 0 }], true, "on-line", { cutStart: 0.5 })], { leadIn: 2 });
laser("laser: short last piece between tabs", [poly(rect(0, 0, 20, 10), true, "on-line", { tabMode: "auto", tabN: 3, tabLen: 3 })]);
laser("laser: two equal squares on top of each other", [poly(rect(0, 0, 20, 20), true, "on-line"), poly(rect(0, 0, 20, 20), true, "on-line")], { leadIn: 2 });

test("per-shape planning: pinned result for Rust (cutplan-cases.json.gz)", () => {
  assert.ok(job.plasma.length >= 30 && job.laser.length >= 10, `${job.plasma.length} plasma, ${job.laser.length} laser`);
  const text = JSON.stringify({ job, want, names }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
