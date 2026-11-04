// Tests für den Vektor-Export (SVG, DXF, PDF, PLT) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { toSvg, toDxf, toPdf, toHpgl, aciColor, dxfLayerName, exportBounds, curveItems, type ExpItem } from "../src/vectorExport.ts";

/** Rechteck 100 × 50 mm, unten links bei (10, 20) */
const rect = (layer = "Schnitt", color = "#ff0000", group?: string): ExpItem => ({
  kind: "path", layer, color, group, closed: true,
  pts: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 70 }, { x: 10, y: 70 }, { x: 10, y: 20 }]
});
const circle: ExpItem = { kind: "circle", layer: "Gravur", color: "#0000ff", cx: 60, cy: 45, r: 10 };
/** Viertelbogen im Uhrzeigersinn von 90° nach 0° um (60, 45) */
const arcCw: ExpItem = { kind: "arc", layer: "Schnitt", color: "#ff0000", cx: 60, cy: 45, r: 20, start: Math.PI / 2, sweep: -Math.PI / 2 };
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

/** DXF in Paare (Code, Wert) zerlegen */
function pairs(dxf: string): [number, string][] {
  const l = dxf.split("\r\n");
  const out: [number, string][] = [];
  for (let i = 0; i + 1 < l.length; i += 2) out.push([parseInt(l[i], 10), l[i + 1]]);
  return out;
}
/** Elemente aus dem ENTITIES-Abschnitt */
function entities(dxf: string): { type: string; v: Map<number, string[]> }[] {
  const p = pairs(dxf);
  const start = p.findIndex(([c, v], i) => c === 2 && v === "ENTITIES" && p[i - 1][1] === "SECTION");
  const out: { type: string; v: Map<number, string[]> }[] = [];
  for (let i = start + 1; i < p.length && !(p[i][0] === 0 && p[i][1] === "ENDSEC"); i++) {
    if (p[i][0] === 0) out.push({ type: p[i][1], v: new Map() });
    else { const m = out[out.length - 1].v; m.set(p[i][0], [...(m.get(p[i][0]) || []), p[i][1]]); }
  }
  return out;
}
const num = (e: { v: Map<number, string[]> }, c: number) => parseFloat(e.v.get(c)![0]);

test("Grenzen: Bögen zählen nur ihren Teil, Kreise ganz", () => {
  const b = exportBounds([arcCw])!;
  assert.ok(near(b.minX, 60, 1e-3) && near(b.maxX, 80, 1e-3) && near(b.minY, 45, 1e-3) && near(b.maxY, 65, 1e-3));
  const c = exportBounds([circle])!;
  assert.deepEqual(c, { minX: 50, minY: 35, maxX: 70, maxY: 55 });
});

test("SVG: Größe in mm, Y umgedreht, geschlossen mit Z, ohne doppelten Endpunkt", () => {
  const { data } = toSvg([rect()]);
  assert.match(data, /width="100mm" height="50mm" viewBox="0 0 100 50"/);
  // oben links der Zeichnung (10, 70) wird SVG (0, 0)
  const d = /<path d="([^"]+)"/.exec(data)![1];
  assert.equal(d, "M0 50 L100 50 L100 0 L0 0 Z");
});

test("SVG: Ebenen als Inkscape-Ebenen, Namen sicher, Gruppen bleiben zusammen", () => {
  const { data } = toSvg([rect("A<b>&\"", "#ff0000", "g1"), circle, { ...rect("A<b>&\"", "#ff0000", "g1"), pts: [{ x: 0, y: 0 }, { x: 5, y: 5 }], closed: false }]);
  const layers = [...data.matchAll(/inkscape:groupmode="layer" inkscape:label="([^"]*)"[^>]*stroke="([^"]+)"/g)];
  assert.equal(layers.length, 2);
  assert.equal(layers[0][1], "A&lt;b&gt;&amp;&quot;");
  assert.equal(layers[0][2], "#ff0000");
  assert.equal(layers[1][1], "Gravur");
  assert.ok(!data.includes("<b>"));
  // beide Formen der Gruppe stecken in einem <g>
  const grp = /<g id="[^"]*-g1">([\s\S]*?)<\/g>/.exec(data)![1];
  assert.equal((grp.match(/<path /g) || []).length, 2);
});

test("SVG: Kreis bleibt Kreis, Bogen mit richtiger Richtung", () => {
  const { data } = toSvg([circle, arcCw]);
  // Grenzen: x 50…80, y 35…65 -> Kreis-Mitte (60, 45) = SVG (10, 20)
  assert.match(data, /<circle cx="10" cy="20" r="10"\/>/);
  // Bogen von (60, 65) nach (80, 45): SVG (10, 0) -> (30, 20), im Uhrzeigersinn (Y oben) = sweep-flag 1 in SVG
  assert.match(data, /d="M10 0 A20 20 0 0 1 30 20"/);
});

test("SVG: Bilder werden eingebettet, fremde Adressen nicht", () => {
  const src = "data:image/png;base64,iVBORw0KGgo=";
  const img: ExpItem = { kind: "image", layer: "Bild", color: "#000000", src, corners: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 0, y: 20 }] };
  const ok = toSvg([img]);
  assert.equal(ok.skippedImages, 0);
  assert.match(ok.data, /<image [^>]*transform="matrix\(40 0 0 20 0 0\)"[^>]*href="data:image\/png;base64,iVBORw0KGgo="/);
  const bad = toSvg([{ ...img, src: "https://example.com/x.png\" onload=\"alert(1)" }]);
  assert.equal(bad.skippedImages, 1);
  assert.ok(!bad.data.includes("example.com"));
});

test("DXF: R12 in mm, Ebenen-Tabelle mit Farben", () => {
  const { data } = toDxf([rect("Schnitt"), circle]);
  const p = pairs(data);
  const after = (name: string) => p[p.findIndex(([c, v]) => c === 9 && v === name) + 1][1];
  assert.equal(after("$ACADVER"), "AC1009");
  assert.equal(after("$INSUNITS"), "4");
  const layerNames = p.filter(([c], i) => c === 2 && p[i - 1][1] === "LAYER").map(([, v]) => v);
  assert.deepEqual(layerNames, ["0", "SCHNITT", "GRAVUR"]);
  const colorOf = (n: string) => { const i = p.findIndex(([c, v], k) => c === 2 && v === n && p[k - 1][1] === "LAYER"); return p.slice(i).find(([c]) => c === 62)![1]; };
  assert.equal(colorOf("SCHNITT"), "1");
  assert.equal(colorOf("GRAVUR"), "5");
  assert.ok(data.endsWith("0\r\nEOF\r\n"));
});

test("DXF: geschlossene Polylinie, Linie, Kreis, Bogen gegen den Uhrzeigersinn", () => {
  const line: ExpItem = { kind: "path", layer: "Schnitt", color: "#ff0000", closed: false, pts: [{ x: 0, y: 0 }, { x: 30, y: 40 }] };
  const img: ExpItem = { kind: "image", layer: "Bild", color: "#000", src: "data:image/png;base64,AA==", corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] };
  const r = toDxf([rect(), line, circle, arcCw, img]);
  assert.equal(r.skippedImages, 1);
  const e = entities(r.data);
  const poly = e.find(x => x.type === "POLYLINE")!;
  assert.equal(poly.v.get(70)![0], "1");
  const iPoly = e.indexOf(poly);
  const verts = e.slice(iPoly + 1, e.findIndex(x => x.type === "SEQEND"));
  assert.equal(verts.length, 4, "Endpunkt = Anfang nicht doppelt");
  assert.deepEqual(verts.map(v => [num(v, 10), num(v, 20)]), [[10, 20], [110, 20], [110, 70], [10, 70]]);
  const ln = e.find(x => x.type === "LINE")!;
  assert.deepEqual([num(ln, 10), num(ln, 20), num(ln, 11), num(ln, 21)], [0, 0, 30, 40]);
  const c = e.find(x => x.type === "CIRCLE")!;
  assert.equal(num(c, 40), 10);
  assert.equal(c.v.get(8)![0], "GRAVUR");
  // im Uhrzeigersinn 90° -> 0° wird gegen den Uhrzeigersinn 0° -> 90°
  const a = e.find(x => x.type === "ARC")!;
  assert.ok(near(num(a, 50), 0) && near(num(a, 51), 90));
  assert.equal(num(a, 40), 20);
});

test("DXF: Ebenennamen und Farben", () => {
  assert.equal(dxfLayerName("Gravur fein (Ä)"), "GRAVUR_FEIN_A");
  assert.equal(dxfLayerName("   "), "0");
  assert.equal(dxfLayerName("x".repeat(50)).length, 31);
  assert.equal(aciColor("#ff0000"), 1);
  assert.equal(aciColor("#00ff00"), 3);
  assert.equal(aciColor("#ffffff"), 7);
  assert.equal(aciColor("#ff8000"), 30);
  assert.equal(aciColor("kaputt"), 7);
});

test("PDF: Seite in Zeichnungsgröße (Punkt), Verweise stimmen", () => {
  const { data } = toPdf([rect()]);
  assert.ok(data.startsWith("%PDF-1.4"));
  const box = /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(data)!;
  assert.ok(near(+box[1], 100 * 72 / 25.4, 1e-3) && near(+box[2], 50 * 72 / 25.4, 1e-3));
  // xref-Tabelle zeigt genau auf "n 0 obj"
  const xref = data.slice(data.indexOf("xref\n")).split("\n").slice(3, 8);
  xref.forEach((l, i) => assert.equal(data.slice(parseInt(l, 10), parseInt(l, 10) + 7), `${i + 1} 0 obj`));
  const start = +/startxref\n(\d+)/.exec(data)![1];
  assert.equal(data.slice(start, start + 4), "xref");
  assert.match(data, /0 0 m 283\.465 0 l 283\.465 141\.732 l 0 141\.732 l s/);
});

test("PLT: 40 Einheiten je mm, an 0/0, geschlossen zurück zum Anfang, Stift je Ebene", () => {
  const { data } = toHpgl([rect(), circle]);
  assert.match(data, /^IN;\nPA;\nSP1;\nPU0,0;\nPD4000,0,4000,2000,0,2000,0,0;\n/);
  assert.ok(data.includes("SP2;"));
  // Kreis r = 10 mm um (60, 45) -> erster Punkt (70, 45) = (60 mm, 25 mm) vom Ursprung
  assert.ok(data.includes("PU2400,1000;"));
});

// ---- Linienzüge aus vielen Punkten ----
const ringPts = (cx: number, cy: number, r: number, n: number) => Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(i / n * 2 * Math.PI), y: cy + r * Math.sin(i / n * 2 * Math.PI) }));
const base = { layer: "L", color: "#000000" };
/** Rechteck 40 × 20 mit Ecken-Radius 5, Ecken aus je k Punkten */
function rounded(k: number) {
  const out: { x: number; y: number }[] = [];
  const corner = (cx: number, cy: number, a0: number) => { for (let i = 0; i <= k; i++) { const a = a0 + (i / k) * Math.PI / 2; out.push({ x: cx + 5 * Math.cos(a), y: cy + 5 * Math.sin(a) }); } };
  corner(35, 5, -Math.PI / 2); corner(35, 15, 0); corner(5, 15, Math.PI / 2); corner(5, 5, Math.PI);
  return out;
}

test("Loch aus vielen Punkten wird ein einziger Kreis", () => {
  const [it] = curveItems([{ ...base, kind: "path", closed: true, pts: ringPts(20, 30, 4, 2000) }]);
  assert.equal(it.kind, "circle");
  if (it.kind === "circle") { assert.ok(near(it.cx, 20, 1e-3)); assert.ok(near(it.cy, 30, 1e-3)); assert.ok(near(it.r, 4, 1e-3)); }
  assert.equal(entities(toDxf([it]).data).map(e => e.type).join(), "CIRCLE");
  assert.match(toSvg([it]).data, /<circle /);
});

test("Grob aufgelöster Kreis (24 Ecken) ist auch ein Kreis, Vielecke mit wenigen Ecken nicht", () => {
  assert.equal(curveItems([{ ...base, kind: "path", closed: true, pts: ringPts(0, 0, 25, 24) }])[0].kind, "circle");
  assert.equal(curveItems([{ ...base, kind: "path", closed: true, pts: ringPts(0, 0, 25, 8) }])[0].kind, "path");
});

test("Rundes Rechteck: ein Pfad mit echten Bögen statt hunderter Punkte", () => {
  const src = rounded(100);
  const [it] = curveItems([{ ...base, kind: "path", closed: true, pts: src }]);
  assert.equal(it.kind, "path");
  if (it.kind !== "path") return;
  assert.ok(it.pts.length <= 10, `${it.pts.length} Punkte`);
  assert.equal(it.bulges!.filter(b => b !== 0).length, 4);
  // Viertelkreis: Wölbung tan(90°/4)
  for (const b of it.bulges!) if (b) assert.ok(near(b, Math.tan(Math.PI / 8), 0.01));
  const e = entities(toDxf([it]).data);
  assert.equal(e.filter(x => x.type === "POLYLINE").length, 1, "bleibt ein Element");
  assert.equal(e.filter(x => x.type === "VERTEX").length, it.pts.length);
  assert.match(toSvg([it]).data, / A5 5 0 0 0 /);
});

test("Bögen bleiben in Grenzen, PDF und PLT an der richtigen Stelle", () => {
  const src = rounded(100);
  const [it] = curveItems([{ ...base, kind: "path", closed: true, pts: src }]);
  const b = exportBounds([it])!;
  assert.ok(near(b.minX, 0, 0.02) && near(b.maxX, 40, 0.02) && near(b.minY, 0, 0.02) && near(b.maxY, 20, 0.02), JSON.stringify(b));
  const plt = toHpgl([it]).data;
  const nums = [...plt.matchAll(/(-?\d+),(-?\d+)/g)].map(m => [+m[1] / 40, +m[2] / 40]);
  // jeder Punkt liegt auf der Original-Form (Ecken-Kreise oder Kanten)
  for (const [x, y] of nums) {
    const px = Math.min(x, 40 - x), py = Math.min(y, 20 - y);
    const d = px < 5 && py < 5 ? Math.abs(Math.hypot(5 - px, 5 - py) - 5) : Math.min(px, py);
    assert.ok(d < 0.1, `${x} ${y}: ${d}`);
  }
  assert.ok(toPdf([it]).data.includes(" l "));
});

test("Bogen über 180° im Pfad zeigt in die richtige Richtung", () => {
  // Dreiviertelkreis gegen den Uhrzeigersinn um (0,0), r 10: von (10,0) bis (0,-10), dann Gerade zurück
  const arc = Array.from({ length: 200 }, (_, i) => { const a = (i / 199) * 1.5 * Math.PI; return { x: 10 * Math.cos(a), y: 10 * Math.sin(a) }; });
  const [it] = curveItems([{ ...base, kind: "path", closed: false, pts: arc }]);
  const b = exportBounds([it])!;
  assert.ok(near(b.minX, -10, 0.05) && near(b.maxX, 10, 0.05) && near(b.maxY, 10, 0.05) && near(b.minY, -10, 0.05), JSON.stringify(b));
});

test("Zickzack und gerade Linien bleiben unverändert genau, Punkte auf einer Geraden fallen weg", () => {
  const zig = Array.from({ length: 30 }, (_, i) => ({ x: i * 5, y: i % 2 ? 5 : 0 }));
  const [z] = curveItems([{ ...base, kind: "path", closed: false, pts: zig }]);
  if (z.kind === "path") assert.deepEqual(z.pts, zig);
  const straight = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 2 * i }));
  const [s] = curveItems([{ ...base, kind: "path", closed: false, pts: straight }]);
  if (s.kind === "path") assert.equal(s.pts.length, 2);
});
