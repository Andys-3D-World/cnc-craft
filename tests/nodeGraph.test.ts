// Tests für den Knotengraph: Rechen-Kern, neue Knoten, alte Vorlagen – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Die Knoten laufen hier mit wie unter Vite (Pfade ohne Endung, JSON ohne Attribut)
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

const store = new Map<string, string>();
const G = globalThis as any;
G.localStorage ??= { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
G.window ??= { dispatchEvent() {}, addEventListener() {}, cncState: { shapes: [] } };
G.window.cncState ??= { shapes: [] };
G.CustomEvent ??= class { type: string; constructor(type: string) { this.type = type; } };
G.Event ??= class { type: string; constructor(type: string) { this.type = type; } };

const gr = await import("../src/nodes/graph.ts");
const { registerAllNodes, NODE_CATS } = await import("../src/nodes/nodeDefs.ts");
const { RECIPES } = await import("../src/nodes/recipes.ts");
const store2 = await import("../src/nodes/graphStore.ts");
const { groupBounds, shapeToPaths, MM_TO_PIXEL: PX } = await import("../src/shapeTransform.ts");
registerAllNodes();

const here = dirname(fileURLToPath(import.meta.url));
const langs = ["de", "en", "fr", "es", "it", "nl", "pl"].map(l => JSON.parse(readFileSync(pathResolve(here, `../src/i18n/lang/${l}.json`), "utf8")));

type Graph = { nodes: any[]; links: any[] };
/** Kette aus Knoten bauen: [typ, einstellungen] – jeder hängt am vorigen (Ausgang/Eingang „shapes“) */
function chain(...steps: [string, Record<string, any>?][]): { g: Graph; ids: string[] } {
  const g: Graph = { nodes: [], links: [] };
  const ids: string[] = [];
  steps.forEach(([type, params], i) => {
    const n = gr.createNode(type, i * 260, 0)!;
    assert.ok(n, "Knoten " + type);
    Object.assign(n.params, params || {});
    g.nodes.push(n);
    if (i) assert.ok(gr.attachAfter(g, ids[i - 1], n), `${steps[i - 1][0]} → ${type}`);
    ids.push(n.id);
  });
  return { g, ids };
}
async function run(g: Graph) { return gr.evaluate(g, new Map()); }
async function last(...steps: [string, Record<string, any>?][]) {
  const { g, ids } = chain(...steps);
  const r = (await run(g)).get(ids[ids.length - 1])!;
  assert.equal(r.error, undefined, r.error);
  return r;
}
const sizeMm = (shapes: any[]) => { const b = groupBounds(shapes)!; return { w: (b.maxX - b.minX) / PX, h: (b.maxY - b.minY) / PX, x: b.minX / PX, y: b.minY / PX }; };
const near = (a: number, b: number, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);

// ---- alte Vorlagen ----

test("Vorlagen-Datei aus 0.4.8: alle Knoten, Einstellungen und Leitungen bleiben", () => {
  const text = readFileSync(pathResolve(here, "fixtures/nodegraph-0.4.8.cncgraph"), "utf8");
  const raw = JSON.parse(text);
  const rec = store2.parseRecipeFile(text)!;
  assert.ok(rec);
  assert.equal(rec.name, "Alles aus 0.4.8");
  assert.equal(rec.graph.nodes.length, raw.graph.nodes.length);
  assert.equal(rec.graph.links.length, raw.graph.links.length);
  for (const old of raw.graph.nodes) {
    const n = rec.graph.nodes.find((x: any) => x.id === old.id)!;
    assert.equal(n.type, old.type);
    for (const [k, v] of Object.entries(old.params)) assert.deepEqual(n.params[k], v, `${old.type}.${k}`);
  }
});

test("Vorlage aus 0.4.8 rechnet ohne Fehler und wie bisher", async () => {
  const rec = store2.parseRecipeFile(readFileSync(pathResolve(here, "fixtures/nodegraph-0.4.8.cncgraph"), "utf8"))!;
  const res = await run(rec.graph);
  for (const n of rec.graph.nodes) assert.equal(res.get(n.id)!.error, undefined, n.type + ": " + res.get(n.id)!.error);
  // Rechteck 120 × 60 minus Loch, Ecken rund, 3 × 2 Kopien mit Abstand 10 ÷ 2 = 5 (Zahl am Eingang) und 5
  const s = sizeMm(res.get("ar")!.out.shapes);
  near(s.w, 3 * 120 + 2 * 5); near(s.h, 2 * 60 + 5);
  assert.equal(res.get("ma")!.out.value, 5);
});

test("unbekannte Knoten und kaputte Daten fallen weg, ohne Absturz", () => {
  const g = gr.sanitizeGraph({ nodes: [{ id: "a", type: "rect", params: { w: "<img>", h: null } }, { id: "b", type: "gibtsnicht" }, { id: "a", type: "circle" },
    { id: "t", type: "text", params: { text: "x".repeat(5000), font: 3 } }, null, 7],
    links: [{ from: "a", out: "shapes", to: "b", inp: "shapes" }, { from: "a", out: "shapes", to: "a", inp: "w" }, "x"] });
  assert.deepEqual(g.nodes.map((n: any) => n.id), ["a", "t"]);
  assert.equal(g.nodes[0].params.w, 80);
  assert.equal(g.nodes[1].params.text.length, gr.MAX_TEXT);
  assert.equal(g.nodes[1].params.font, "Open Sans");
  assert.equal(g.links.length, 0);
  assert.equal(store2.parseRecipeFile("kaputt"), null);
  assert.equal(store2.parseRecipeFile('{"format":"anders","graph":{}}'), null);
});

test("mitgelieferte Vorlagen: laufen ohne Fehler, die ohne Quelle liefern Formen", async () => {
  for (const r of RECIPES) {
    const g = r.make();
    const res = await run(g);
    for (const n of g.nodes) {
      if (n.type === "text") continue; // Text braucht die Zeichenfläche der Oberfläche
      assert.equal(res.get(n.id)!.error, undefined, `${r.id}/${n.type}: ${res.get(n.id)!.error}`);
    }
    if (g.nodes.some((n: any) => n.type === "source" || n.type === "text")) continue;
    const out = g.nodes.find((n: any) => n.type === "output")!;
    assert.ok(res.get(out.id)!.out.shapes.length > 0, r.id);
    // Vorlage speichern und wieder laden: gleich
    assert.deepEqual(gr.sanitizeGraph(JSON.parse(JSON.stringify(g))), g, r.id);
  }
});

// ---- Texte ----

test("jeder Knoten hat Name, Beschreibung und Beschriftungen in allen 7 Sprachen", () => {
  const need = new Set<string>();
  for (const c of NODE_CATS) need.add("ng.cat." + c);
  for (const d of gr.allNodeDefs()) {
    need.add("ng.n." + d.type); need.add("ng.d." + d.type);
    for (const p of [...d.inputs, ...d.outputs]) need.add("ng.port." + p.name);
    for (const p of d.params) {
      if (p.kind === "data") continue;
      need.add(p.label || "ng.p." + p.key);
      if (p.kind === "select" && Array.isArray(p.options)) for (const o of p.options) need.add(`ng.p.${p.key}.${o}`);
    }
  }
  for (const r of RECIPES) { need.add("ng.tpl." + r.id); need.add("ng.tpl." + r.id + ".d"); }
  for (const k of need) langs.forEach((l, i) => assert.equal(typeof l[k], "string", `${k} fehlt in Sprache ${i}`));
});

// ---- Bedienung: anhängen, fehlende Leitung, Rückgängig ----

test("attachAfter: neuer Knoten kommt zwischen Quelle und Ausgabe", () => {
  const g = store2.defaultGraph();
  const [src, out] = g.nodes;
  const off = gr.createNode("offset", 0, 0)!;
  g.nodes.push(off);
  assert.deepEqual(gr.attachAfter(g, src.id, off), { moved: out.id });
  assert.ok(g.links.some((l: any) => l.from === src.id && l.to === off.id && l.inp === "shapes"));
  assert.ok(g.links.some((l: any) => l.from === off.id && l.to === out.id && l.inp === "shapes"));
  assert.ok(g.links.some((l: any) => l.from === src.id && l.to === out.id && l.inp === "image"), "Bild-Leitung bleibt");
  // Bild-Knoten kommt auf die Bild-Leitung
  const eng = gr.createNode("engrave", 0, 0)!;
  g.nodes.push(eng);
  assert.deepEqual(gr.attachAfter(g, src.id, eng), { moved: out.id });
  assert.ok(g.links.some((l: any) => l.from === eng.id && l.to === out.id && l.inp === "image"));
  // passt nicht: Quelle hinter Quelle
  const rect = gr.createNode("rect", 0, 0)!;
  g.nodes.push(rect);
  assert.equal(gr.attachAfter(g, src.id, rect), null);
  assert.deepEqual([...gr.downstream(g, off.id)].sort(), [off.id, out.id].sort());
});

test("attachBefore und fittingInput: freier passender Eingang", () => {
  const g: Graph = { nodes: [gr.createNode("merge", 0, 0)!, gr.createNode("rect", 0, 0)!, gr.createNode("circle", 0, 0)!], links: [] };
  const [m, r, c] = g.nodes;
  assert.ok(gr.attachBefore(g, m.id, r));
  assert.equal(gr.fittingInput(g, c.id, "shapes", m.id), "b");
  assert.ok(gr.attachBefore(g, m.id, c));
  assert.deepEqual(g.links.map((l: any) => l.inp), ["a", "b"]);
  assert.equal(gr.fittingInput(g, m.id, "shapes", r.id), null, "Rechteck hat keinen Formen-Eingang");
  assert.equal(gr.connect(g, m.id, "shapes", m.id, "c"), false, "kein Kreis");
});

test("missingInputs: sagt, welcher Eingang fehlt", () => {
  const { g, ids } = chain(["circle"], ["onPath"]);
  const op = g.nodes[1];
  assert.deepEqual(gr.missingInputs(g, op), ["path"]);
  assert.deepEqual(gr.missingInputs(g, g.nodes[0]), []);
  const lone = gr.createNode("boolean", 0, 0)!;
  g.nodes.push(lone);
  assert.deepEqual(gr.missingInputs(g, lone), ["a"]);
  gr.connect(g, ids[0], "shapes", lone.id, "a");
  assert.deepEqual(gr.missingInputs(g, lone), []);
});

test("Rückgängig / Wiederholen: Knoten, Leitungen und Einstellungen", () => {
  const { g } = chain(["rect"], ["offset"]);
  const h = new gr.GraphHistory();
  assert.equal(h.undo(g), false);
  h.mark(g);
  const out = gr.createNode("output", 0, 0)!;
  g.nodes.push(out);
  gr.attachAfter(g, g.nodes[1].id, out);
  // Tippen in einem Feld: viele Änderungen, ein Schritt
  for (const v of [1, 12, 120]) { h.mark(g, "p:w", 1000 + v); g.nodes[0].params.w = v; }
  assert.equal(g.nodes[0].params.w, 120);
  assert.ok(h.undo(g));
  assert.equal(g.nodes[0].params.w, 80);
  assert.equal(g.nodes.length, 3);
  assert.ok(h.undo(g));
  assert.equal(g.nodes.length, 2); assert.equal(g.links.length, 1);
  assert.equal(h.undo(g), false);
  assert.ok(h.redo(g)); assert.ok(h.redo(g));
  assert.equal(g.nodes[0].params.w, 120); assert.equal(g.links.length, 2);
  // neue Änderung löscht „Wiederholen“; übernommene Formen bleiben dieselbe Liste (kein Kopieren großer Bilder)
  const src = gr.createNode("source", 0, 0)!;
  const big = [{ id: "x" }];
  src.params.shapes = big;
  h.undo(g); h.mark(g); g.nodes.push(src);
  assert.equal(h.canRedo(), false);
  h.mark(g); g.nodes.pop(); h.undo(g);
  assert.equal(g.nodes[g.nodes.length - 1].params.shapes, big);
  const copy = gr.cloneNode(g.nodes[0]);
  assert.notEqual(copy.id, g.nodes[0].id); assert.deepEqual(copy.params, g.nodes[0].params);
});

// ---- neue Knoten ----

test("Stern, Zahnrad, Mandala, Puzzle, Lüftungsgitter, Biegemuster: Größe stimmt, Ecke unten links am Nullpunkt", async () => {
  const star = (await last(["star", { points: 6, d: 60, inner: 50 }])).out.shapes;
  assert.equal(star.length, 1); assert.equal(shapeToPaths(star[0])[0].pts.length, 12);
  near(sizeMm(star).h, 60);
  const gear = (await last(["gear", { teeth: 20, module: 2, bore: 6 }])).out.shapes;
  assert.equal(gear.length, 2, "Zahnkontur + Bohrung");
  near(sizeMm(gear).w, 44, 0.3); // Kopfkreis = m × (z + 2)
  assert.deepEqual(gear.map((s: any) => s.millingMode).sort(), ["inside", "outside"]);
  const man = (await last(["mandala", { d: 100, seed: 3 }])).out.shapes;
  near(sizeMm(man).w, 100, 0.5); assert.ok(man.length > 5);
  assert.equal(man[man.length - 1].millingMode, "outside", "Umriss zuletzt");
  const pz = (await last(["puzzle", { w: 120, h: 80, cols: 4, rows: 3 }])).out.shapes;
  near(sizeMm(pz).w, 120, 0.2); near(sizeMm(pz).h, 80, 0.2);
  const vent = (await last(["vent", { w: 100, h: 60 }])).out.shapes;
  near(sizeMm(vent).w, 100); assert.ok(vent.length > 10);
  const noPlate = (await last(["vent", { w: 100, h: 60, plate: false }])).out.shapes;
  assert.equal(noPlate.length, vent.length - 1);
  const hinge = (await last(["hinge", { w: 150, h: 80 }])).out.shapes;
  near(sizeMm(hinge).w, 150); assert.ok(hinge.some((s: any) => !s.closed));
  for (const list of [star, gear, man, pz, vent, hinge]) { near(sizeMm(list).x, 0, 0.01); near(sizeMm(list).y, 0, 0.01); }
  // gleiche Muster-Nr. = gleiches Mandala, andere = anderes
  const a = JSON.stringify((await last(["mandala", { seed: 3, d: 100 }])).out.shapes.map((s: any) => s.points));
  assert.equal(a, JSON.stringify(man.map((s: any) => s.points)));
  assert.notEqual(a, JSON.stringify((await last(["mandala", { seed: 4, d: 100 }])).out.shapes.map((s: any) => s.points)));
});

test("Kopien im Kreis: Anzahl, Radius, Teilkreis", async () => {
  const r = (await last(["circle", { d: 10 }], ["polar", { count: 6, radius: 40 }])).out.shapes;
  assert.equal(r.length, 6);
  assert.equal(new Set(r.map((s: any) => s.id)).size, 6, "eigene Kennungen");
  near(sizeMm(r).h, 90); // 2 × 40 + 10
  const half = (await last(["circle", { d: 10 }], ["polar", { count: 3, radius: 40, total: 180 }])).out.shapes;
  near(sizeMm(half).h, 90); near(sizeMm(half).w, 50);
  const many = await last(["mandala"], ["polar", { count: 360 }]);
  assert.equal(many.warn?.key, "ng.w.tooMany");
});

test("Kopien auf Pfad: gleichmäßig verteilt, Pfad auf Wunsch dabei", async () => {
  const g: Graph = { nodes: [gr.createNode("circle", 0, 0)!, gr.createNode("rect", 0, 0)!, gr.createNode("onPath", 0, 0)!], links: [] };
  const [c, r, p] = g.nodes;
  Object.assign(c.params, { d: 4 }); Object.assign(r.params, { w: 100, h: 50 }); Object.assign(p.params, { count: 6, keepPath: true });
  gr.connect(g, c.id, "shapes", p.id, "shapes"); gr.connect(g, r.id, "shapes", p.id, "path");
  const out = (await run(g)).get(p.id)!.out.shapes;
  assert.equal(out.length, 7);
  near(sizeMm(out).w, 104); near(sizeMm(out).h, 54);
  p.params.keepPath = false;
  assert.equal((await run(g)).get(p.id)!.out.shapes.length, 6);
});

test("Perforieren: kurze offene Schnitte, Einstellungen der Form bleiben", async () => {
  const r = (await last(["rect", { w: 100, h: 50 }], ["layer", { depth: 3 }], ["perforate", { cut: 5, bridge: 1 }])).out.shapes;
  assert.equal(r.length, 50); // Umfang 300 ÷ (5 + 1)
  assert.ok(r.every((s: any) => !s.closed && s.millingMode === "on-line" && s.millingDepth === -3));
  assert.equal(new Set(r.map((s: any) => s.groupId)).size, 1);
});

test("Vereinfachen, Rahmen, Filter, Größe messen, Rechnen min/max", async () => {
  const circlePts = (await last(["polygon", { sides: 64, d: 50 }])).out.shapes[0].points.length;
  const simp = (await last(["polygon", { sides: 64, d: 50 }], ["simplify", { tolerance: 1 }])).out.shapes[0];
  assert.ok(simp.points.length < circlePts);
  const fr = (await last(["rect", { w: 80, h: 40 }], ["frame", { margin: 10, r: 0 }])).out.shapes;
  assert.equal(fr.length, 2); near(sizeMm(fr).w, 100); near(sizeMm(fr).h, 60);
  assert.equal(fr[1].millingMode, "outside", "Rahmen zuletzt");
  const only = (await last(["rect", { w: 80, h: 40 }], ["frame", { margin: 10, keepIn: false, frameShape: "oval" }])).out.shapes;
  assert.equal(only.length, 1); near(sizeMm(only).w, 100 * Math.SQRT2, 0.2);
  const big = (await last(["hinge", { w: 150, h: 80 }], ["filter", { pick: "closed" }])).out.shapes;
  assert.equal(big.length, 1, "nur die Platte ist geschlossen");
  const none = await last(["rect"], ["filter", { minSize: 500 }]);
  assert.equal(none.out.shapes.length, 0); assert.equal(none.warn?.key, "ng.w.filterEmpty");
  const m = (await last(["rect", { w: 80, h: 40 }], ["measure"])).out;
  near(m.width, 80); near(m.height, 40);
  assert.equal((await last(["math", { a: 3, b: 7, op: "min" }])).out.value, 3);
  assert.equal((await last(["math", { a: 3, b: 7, op: "max" }])).out.value, 7);
});

test("Größe messen steuert eine Einstellung: Zahl-Leitung ersetzt den Wert", async () => {
  const g: Graph = { nodes: [gr.createNode("rect", 0, 0)!, gr.createNode("measure", 0, 0)!, gr.createNode("circle", 0, 0)!], links: [] };
  const [r, m, c] = g.nodes;
  Object.assign(r.params, { w: 33, h: 20 });
  gr.connect(g, r.id, "shapes", m.id, "shapes");
  assert.ok(gr.connect(g, m.id, "width", c.id, "d"));
  near(sizeMm((await run(g)).get(c.id)!.out.shapes).w, 33);
});

test("kein neuer Knoten verändert seine Eingänge", async () => {
  for (const [type, params] of [["polar", {}], ["perforate", {}], ["simplify", { tolerance: 2 }], ["frame", {}], ["filter", {}]] as [string, any][]) {
    const { g, ids } = chain(["mandala", { d: 60 }], [type, params]);
    const res = await run(g);
    const before = JSON.stringify(res.get(ids[0])!.out.shapes);
    const again = await gr.evaluate(g, new Map());
    assert.equal(JSON.stringify(again.get(ids[0])!.out.shapes.map((s: any) => s.points)), JSON.stringify(JSON.parse(before).map((s: any) => s.points)), type);
    assert.equal(JSON.stringify(res.get(ids[0])!.out.shapes), before, type);
  }
});
