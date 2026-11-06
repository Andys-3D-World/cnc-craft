// Tests für die Laser-Testkarte und den Versatz hin/zurück – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildCard, DEFAULT_CARD, focusAllowed, kerfFromFit, kerfSlots, KERF_TAB, orderByStage, packPanels, PANEL_IDS, presetFromCell,
  presetName, readCells, STAGE, withKerf, wrapText, type Item, type TestCardOptions
} from "../src/testCard.ts";
import { cleanScanPoints, formatScanText, parseScanText, scanOffsetAt, shiftSeg } from "../src/scanOffset.ts";
import { layoutTest, step } from "../src/materialGrid.ts";
import { addOwnPreset, ownPresets } from "../src/ownPresets.ts";

const tr = (k: string) => (k.startsWith("tcard.read.") ? "Lesehilfe mit ein paar Worten zum Ablesen" : k.split(".").pop()!);
const card = (over: Partial<TestCardOptions> = {}): TestCardOptions => ({ ...DEFAULT_CARD, ...over });
const points = (it: Item) => it.kind === "poly" ? it.pts : [{ x: it.x, y: it.y }];

test("Standardkarte: alle Felder passen auf die Karte, nichts ragt heraus, keine Überlappung", () => {
  const o = card(), c = buildCard(o, tr);
  assert.deepEqual(c.left, []);
  assert.equal(c.placed.length, o.panels.length);
  for (const it of c.items) for (const p of points(it)) {
    assert.ok(p.x >= -1e-6 && p.x <= o.cardW + 1e-6, `x ${p.x}`);
    assert.ok(p.y >= -1e-6 && p.y <= o.cardH + 1e-6, `y ${p.y}`);
  }
  for (const a of c.placed) for (const b of c.placed) {
    if (a === b) continue;
    const apart = a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6 || a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6;
    assert.ok(apart, `${a.id} / ${b.id}`);
  }
});

test("Layout ordnet sich neu: Feld aus = kleiner Rest rückt auf, zu kleine Karte meldet, was fehlt", () => {
  const few = buildCard(card({ panels: ["ruler", "repeat"], cardW: 80, cardH: 60 }), tr);
  assert.deepEqual(few.left, []);
  const small = buildCard(card({ cardW: 80, cardH: 60 }), tr);
  assert.ok(small.left.length > 0);
  assert.ok(small.placed.length + small.left.length === card().panels.length);
  for (const p of small.placed) { assert.ok(p.x >= 0 && p.x + p.w <= 74 + 1e-6); assert.ok(p.y >= 0 && p.y + p.h <= 54 + 1e-6); }
  // knappe Karte: Felder werden kleiner, statt wegzufallen
  const tight = buildCard(card({ panels: ["engrave", "cut"], cardW: 120, cardH: 55 }), tr);
  assert.deepEqual(tight.left, []);
  assert.ok(tight.scale < 1);
});

test("packPanels: Reihen von oben nach unten", () => {
  const r = packPanels([{ id: "ruler", w: 50, h: 10 }, { id: "text", w: 50, h: 20 }, { id: "air", w: 50, h: 5 }], 110, 40, 2);
  assert.deepEqual(r.left, []);
  const text = r.placed.find(p => p.id === "text")!;
  assert.equal(text.y, 20);
  assert.equal(r.placed.find(p => p.id === "air")!.y + 5, 18);
});

test("Werte je Feld: Raster wie im Material-Test, Karten-Feld stimmt mit Rasterwerten überein", () => {
  const o = card(), c = buildCard(o, tr);
  const engrave = c.items.filter(i => i.kind === "poly" && i.cell?.p === "engrave") as any[];
  assert.equal(engrave.length, o.eCols * o.eRows);
  for (const it of engrave) {
    assert.equal(it.ov.power, step(o.ePMin, o.ePMax, it.cell.c, o.eCols, 1));
    assert.equal(it.ov.speed, step(o.eSMin, o.eSMax, it.cell.r, o.eRows, 0));
    assert.equal(it.ov.interval, o.interval);
  }
  const L = layoutTest({ mode: "line", rowVar: "speed", cols: o.cCols, pMin: o.cPMin, pMax: o.cPMax, rows: o.cRows, rMin: o.cSMin, rMax: o.cSMax,
    speed: 0, interval: o.interval, passes: 1, cell: 6, gap: 1, labels: false, textH: 2, labelPower: 0, labelSpeed: 1 });
  const cut = c.items.filter(i => i.kind === "poly" && i.cell?.p === "cut") as any[];
  assert.deepEqual(cut.map(i => i.ov.power), L.cells.map(x => x.power));
  assert.deepEqual(cut.map(i => i.ov.speed), L.cells.map(x => x.speed));
  // beide Felder des Wiederhol-Paars haben dieselben Werte, laufen aber getrennt
  const [a, b] = c.items.filter(i => i.kind === "poly" && i.cell?.p === "repeat") as any[];
  assert.deepEqual({ ...a.ov, stage: 0 }, { ...b.ov, stage: 0 });
  assert.notEqual(a.ov.stage, b.ov.stage);
  // Luft-Paar: nur die Luft unterscheidet sich
  const air = c.items.filter(i => i.kind === "poly" && i.cell?.p === "air") as any[];
  assert.deepEqual(air.map(i => i.ov.air), [true, false]);
});

test("Reihenfolge: alles Gravierte vor Schnitten, Umriss zuletzt", () => {
  const c = buildCard(card(), tr);
  const stages = c.items.map(i => i.ov.stage);
  assert.deepEqual(stages, [...stages].sort((a, b) => a - b));
  const polys = c.items.filter(i => i.kind === "poly") as any[];
  const firstCut = c.items.findIndex(i => i.kind === "poly" && i.role === "cut");
  const lastMark = c.items.reduce((m, i, k) => (i.kind === "text" || i.role !== "cut" ? k : m), -1);
  assert.ok(lastMark < firstCut, "keine Gravur nach dem ersten Schnitt");
  assert.equal(polys[polys.length - 1].ov.stage, STAGE.outline);
  assert.equal(polys.filter(p => p.ov.stage === STAGE.outline).length, 1);
});

test("orderByStage: ohne Karte unverändert, mit Karte nach Stufen hinter den anderen Formen", () => {
  const plain = [{ id: 1 }, { id: 2 }];
  assert.equal(orderByStage(plain as any), plain);
  const mixed = [{ id: "cut", cardStage: 5 }, { id: "other" }, { id: "eng", cardStage: 2 }];
  assert.deepEqual(orderByStage(mixed).map(b => b.id), ["other", "eng", "cut"]);
});

test("Kerf: passender Schlitz ergibt seinen Wert, Rechnung hin und zurück", () => {
  assert.equal(kerfFromFit(4, 3.8), 0.1);
  assert.equal(kerfFromFit(4, 4), 0);
  for (const s of kerfSlots(0.3)) {
    assert.equal(s.width, +(KERF_TAB - 2 * s.k).toFixed(3));
    assert.equal(kerfFromFit(KERF_TAB, s.width), s.k);
    // der Schlitz wird um k breiter, der Steg um k schmaler: passen genau dann
    assert.ok(Math.abs((s.width + s.k) - (KERF_TAB - s.k)) < 1e-9);
  }
  // Karte: Schlitz-Breite = Wert auf dem Feld
  const c = buildCard(card(), tr);
  for (const it of c.items) {
    if (it.kind !== "poly" || it.cell?.p !== "kerf") continue;
    const w = Math.abs(it.pts[1].x - it.pts[0].x);
    assert.ok(Math.abs(kerfFromFit(KERF_TAB, w) - it.cell.v!) < 1e-6);
  }
});

test("Fokus-Leiter: aus, außer Z bestätigt; nur aufwärts, kleine Schritte, begrenzt", () => {
  assert.ok(!DEFAULT_CARD.panels.includes("focus"));
  const refused = buildCard(card({ panels: ["focus"] }), tr);
  assert.ok(refused.focusRefused);
  assert.equal(refused.placed.length, 0);
  assert.ok(!focusAllowed(card({ zConfirmed: true, focusStep: 2 })));
  assert.ok(!focusAllowed(card({ zConfirmed: true, focusStep: 1, focusSteps: 9 })));
  const c = buildCard(card({ panels: ["focus"], zConfirmed: true }), tr);
  const z = c.items.filter(i => i.kind === "poly" && i.cell?.p === "focus").map(i => (i as any).ov.zOff ?? 0);
  assert.deepEqual(z, [0, 0.5, 1, 1.5, 2]);
});

test("Versatz: Stützstellen, Rechnung, Text", () => {
  assert.equal(scanOffsetAt([], 1000), 0);
  assert.equal(scanOffsetAt(undefined, 1000), 0);
  const pts = cleanScanPoints([{ speed: 3000, mm: 0.2 }, { speed: 1000, mm: 0.1 }, { speed: "x", mm: 1 }]);
  assert.deepEqual(pts, [{ speed: 1000, mm: 0.1 }, { speed: 3000, mm: 0.2 }]);
  assert.equal(scanOffsetAt(pts, 500), 0.1);
  assert.equal(scanOffsetAt(pts, 2000), 0.15000000000000002);
  assert.equal(scanOffsetAt(pts, 9000), 0.2);
  assert.deepEqual(parseScanText(formatScanText(pts)), pts);
  assert.deepEqual(parseScanText("Unsinn, 1000:abc"), []);
  // 0 ändert nichts (dieselbe Strecke), sonst rücken beide Richtungen um den Versatz zusammen
  const seg = [0, 0, 10, 0];
  assert.equal(shiftSeg(seg, 0), seg);
  assert.deepEqual(shiftSeg(seg, 0.2), [-0.1, 0, 9.9, 0]);
  assert.deepEqual(shiftSeg([10, 1, 0, 1], 0.2), [10.1, 1, 0.1, 1]);
});

// ---- Ablesen ----
const shapesOf = (c: ReturnType<typeof buildCard>) => JSON.parse(JSON.stringify(
  c.items.filter(i => i.kind === "poly").map((i: any) => ({ laserOverride: i.ov, cardCell: i.cell }))));

test("Ablesen: Felder kommen aus den Formen, kaputte Daten fallen weg, gespeicherte Vorlage = angeklicktes Feld", () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  const o = card({ material: "Pappel <b>", thickness: 4 });
  const shapes = shapesOf(buildCard(o, tr));
  const cells = readCells(shapes, "engrave");
  assert.equal(cells.length, o.eCols * o.eRows);
  const pick = cells.find(c => c.r === 2 && c.c === 3)!;
  assert.equal(pick.power, step(o.ePMin, o.ePMax, 3, o.eCols, 1));
  assert.equal(pick.speed, step(o.eSMin, o.eSMax, 2, o.eRows, 0));
  const iv = readCells(shapes, "interval")[2];
  const name = presetName(o.material, o.thickness, "Gravur", pick);
  const saved = addOwnPreset("laser", name, presetFromCell(pick, "engrave", o, name, "note", iv));
  const back = ownPresets("laser").find(p => p.id === saved.id)!;
  assert.equal(back.data.power, pick.power);
  assert.equal(back.data.speed, pick.speed);
  assert.equal(back.data.interval, iv.v);
  assert.equal(back.data.mode, "fill");
  assert.equal(back.data.material, "Pappel <b>");
  assert.equal(back.data.thickness, 4);
  const cut = readCells(shapes, "cut")[0];
  const data = presetFromCell(cut, "cut", o, "x", "note");
  assert.equal(data.mode, "line");
  assert.equal(data.air, true);
  assert.equal(data.interval, cut.interval);
  // Scan: 3 Striche je Feld ergeben nur ein Feld
  const scan = readCells(shapes, "scan");
  assert.equal(scan.length, 3 * 7);
  assert.equal(scan[1].scanMm, 0.05);
  // fremde Datei: Unsinn fällt weg
  assert.deepEqual(readCells([{ cardCell: { p: "cut", r: 0, c: 0 }, laserOverride: { power: "<img>", speed: 1, interval: 1 } }, { cardCell: { p: "cut" } }, null], "cut"), []);
});

test("Gemessene Schnittbreite: in gespeicherte Generator-Werte, andere Werte bleiben", () => {
  assert.deepEqual(JSON.parse(withKerf('{"w":5,"kerf":0.1}', 0.15)), { w: 5, kerf: 0.15 });
  assert.deepEqual(JSON.parse(withKerf(null, 0.15)), { kerf: 0.15 });
  assert.deepEqual(JSON.parse(withKerf("kaputt", 0.15)), { kerf: 0.15 });
  assert.deepEqual(JSON.parse(withKerf('{"nest":{"w":1}}', 0.2, ["nest", "ornament"])), { nest: { w: 1, kerf: 0.2 }, ornament: { kerf: 0.2 } });
});

test("wrapText bricht nach Breite um", () => {
  const lines = wrapText("eins zwei drei vier fünf", 12, 1.5);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(" "), "eins zwei drei vier fünf");
});

test("alle Bereichsnamen bekannt", () => assert.equal(new Set(PANEL_IDS).size, PANEL_IDS.length));

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
    // Typen, die ohne „type“ importiert werden (wie unter Vite erlaubt), muss der Übersetzer entfernen
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
  const ll = await import("../src/laserLayers.ts");
  const lc = await import("../src/laserCam.ts");
  const st = await import("../src/shapeTransform.ts");
  ll.initLaserLayers();
  ll.setLaserSettings({ scanOffsets: [], dynamic: true });
  return { ...ll, ...lc, ...st };
}

test("G-Code: Versatz 0 lässt den G-Code exakt gleich, mit Versatz rücken nur die Scan-Linien", async () => {
  const c = await cam();
  const L = c.addLayer({ name: "E", mode: "fill", power: 50, speed: 1000, interval: 1 });
  const k = c.MM_TO_PIXEL;
  const sq = (x: number, y: number, w: number, h: number) => c.createPolyline(
    [{ x: x * k, y: y * k }, { x: (x + w) * k, y: y * k }, { x: (x + w) * k, y: (y + h) * k }, { x: x * k, y: (y + h) * k }], true, "on-line", { laserLayerId: L.id });
  const shapes = [sq(10, 10, 5, 4)];
  const a = c.generateLaserGcode(shapes).gcode!;
  // festgehaltener Stand von vor dem Versatz: nur die Bewegungen
  const moves = (g: string) => g.split("\n").filter(l => /^G[01] /.test(l));
  assert.deepEqual(moves(a).slice(0, 8), [
    "G0 X10 Y10.5 S0", "G1 X15 Y10.5 S500", "G0 X15 Y11.5 S0", "G1 X10 Y11.5 S500",
    "G0 X10 Y12.5 S0", "G1 X15 Y12.5 S500", "G0 X15 Y13.5 S0", "G1 X10 Y13.5 S500"
  ]);
  c.setLaserSettings({ scanOffsets: [{ speed: 1000, mm: 0 }] });
  assert.equal(c.generateLaserGcode(shapes).gcode, a, "Versatz 0 = gleicher G-Code");
  c.setLaserSettings({ scanOffsets: [{ speed: 1000, mm: 0.2 }] });
  assert.deepEqual(moves(c.generateLaserGcode(shapes).gcode!).slice(0, 4), ["G0 X9.9 Y10.5 S0", "G1 X14.9 Y10.5 S500", "G0 X15.1 Y11.5 S0", "G1 X10.1 Y11.5 S500"]);
  c.setLaserSettings({ scanOffsets: [] });
});

test("G-Code: Karte läuft in Stufen, auch wenn die Schnitt-Ebene oben in der Liste steht; Luft und Z kommen zurück", async () => {
  const c = await cam();
  const cutL = c.addLayer({ name: "cut", mode: "line" }), engL = c.addLayer({ name: "eng", mode: "fill" });
  const k = c.MM_TO_PIXEL;
  const o = card({ panels: ["engrave", "cut", "air", "focus", "ruler"], zConfirmed: true, eCols: 2, eRows: 2, cCols: 2, cRows: 2 });
  const built = buildCard(o, tr);
  const shapes = built.items.filter(i => i.kind === "poly").map((it: any) => c.createPolyline(it.pts.map((p: any) => ({ x: p.x * k, y: p.y * k })), it.closed, "on-line",
    { laserLayerId: it.role === "cut" || it.role === "text" || it.role === "line" ? cutL.id : engL.id, laserOverride: it.ov, cardCell: it.cell }));
  const { gcode, warnings } = c.generateLaserGcode(shapes);
  const lines = gcode!.split("\n");
  assert.equal(warnings.length, 1, "Warnung: Job fährt Z");
  // Z: jeder Aufwärtsschritt kommt zurück, S0 und nur relativ, danach wieder G90
  let z = 0;
  lines.forEach((l, i) => {
    const m = /^G0 Z(-?[\d.]+) S0$/.exec(l);
    if (!m) return;
    assert.equal(lines[i - 1], "G91");
    assert.equal(lines[i + 1], "G90");
    z += parseFloat(m[1]);
    assert.ok(z >= 0 && z <= 5 + 1e-9);
    if (parseFloat(m[1]) > 0) assert.equal(z, parseFloat(m[1]), "jeder Schritt fährt von der Starthöhe los");
  });
  assert.ok(Math.abs(z) < 1e-9, "Z steht am Ende wieder am Start");
  // Luft: M8 nur in Blöcken mit Luft und immer wieder M9
  assert.equal(lines.filter(l => l.startsWith("M8")).length, lines.filter(l => l.startsWith("M9")).length);
  // Gravur (S bei Füll-Blöcken) kommt vor dem Umriss, Umriss als letzter Schnitt vor dem Parken
  const lastG1 = lines.map((l, i) => (l.startsWith("G1") ? i : -1)).filter(i => i >= 0).pop()!;
  const outlineX = `X${o.cardW}`;
  assert.ok(lines.slice(lastG1 - 4, lastG1 + 1).some(l => l.includes(outlineX)), "Umriss zuletzt");
});

test("G-Code: Karte ohne Fokus-Leiter hat keine Z-Bewegung", async () => {
  const c = await cam();
  const L = c.addLayer({ name: "x", mode: "line" });
  const built = buildCard(card(), tr);
  const shapes = built.items.filter(i => i.kind === "poly").map((it: any) => c.createPolyline(it.pts, it.closed, "on-line", { laserLayerId: L.id, laserOverride: it.ov }));
  const g = c.generateLaserGcode(shapes).gcode!;
  assert.ok(!/\bZ-?\d/.test(g));
  assert.ok(!g.includes("G91"));
});

test("alle Sprachen haben dieselben Testkarten-Texte", () => {
  const load = (l: string) => JSON.parse(readFileSync(new URL(`../src/i18n/lang/${l}.json`, import.meta.url), "utf8"));
  const en = Object.keys(load("en")).filter(k => k.startsWith("tcard."));
  assert.ok(en.length > 100);
  for (const l of ["de", "fr", "es", "it", "nl", "pl"]) {
    const d = load(l);
    for (const k of en) assert.equal(typeof d[k], "string", `${l} ${k}`);
  }
  for (const id of PANEL_IDS) assert.ok(en.includes("tcard.p." + id) && en.includes("tcard.read." + id), id);
});

test("Standardkarte passt in allen Sprachen", () => {
  for (const l of ["de", "en", "fr", "es", "it", "nl", "pl"]) {
    const d = JSON.parse(readFileSync(new URL(`../src/i18n/lang/${l}.json`, import.meta.url), "utf8"));
    const c = buildCard(card(), k => d[k] ?? k);
    assert.deepEqual(c.left, [], l);
  }
});
