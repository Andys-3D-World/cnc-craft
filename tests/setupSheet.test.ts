// Einrichteblatt
import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, jobSvg, sheetDocument, sheetHtml, summarizeJob, zeroPosition } from "../src/setupSheet.ts";

test("Bearbeitungen: Tiefe und Vorschub je Form, Werkzeugwechsel", () => {
  const { ops, changes } = summarizeJob([
    "G21", "G90", "G0 Z5", "(--- shape 1: RECT ---)", "G0 X1 Y1", "G1 Z-1 F300", "G1 X10 F1200", "G1 Z-2 F300", "G1 Y10 F1200",
    "T2 M6 (Change to 6 mm)", "(--- shape 2 ---)", "G0 X50", "G1 Z-5 F200", "X60"
  ]);
  assert.deepEqual(ops.map(o => [o.label, o.depth, o.feed]), [["shape 1: RECT", -2, 1200], ["shape 2", -5, 200]]);
  assert.deepEqual(changes.map(c => [c.code, c.note]), [["M6", "Change to 6 mm"]]);
});

test("Datei ohne Markierungen: ein Eintrag; Zoll umgerechnet", () => {
  const { ops } = summarizeJob(["G20", "G0 Z1", "G1 Z-0.1 F10", "G1 X1 F20"]);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].label, "");
  assert.ok(Math.abs(ops[0].depth! + 2.54) < 1e-9);
  assert.ok(Math.abs(ops[0].feed! - 508) < 1e-9);
});

test("Nullpunkt erkennen", () => {
  assert.equal(zeroPosition({ minX: 0, minY: 0, maxX: 50, maxY: 40 }), "bl");
  assert.equal(zeroPosition({ minX: -50, minY: 0, maxX: 0, maxY: 40 }), "br");
  assert.equal(zeroPosition({ minX: 0, minY: -40, maxX: 50, maxY: 0 }), "tl");
  assert.equal(zeroPosition({ minX: -50, minY: -40, maxX: 0, maxY: 0 }), "tr");
  assert.equal(zeroPosition({ minX: -25, minY: -20, maxX: 25, maxY: 20 }), "center");
  assert.equal(zeroPosition({ minX: 30, minY: 30, maxX: 50, maxY: 40 }), "other");
});

test("Fremde Namen werden entschärft", () => {
  assert.equal(esc(`<b a="1">&'`), "&lt;b a=&quot;1&quot;&gt;&amp;&#39;");
  const evil = "<img src=x onerror=alert(1)>";
  const html = sheetHtml({
    title: evil, date: evil, tools: [{ no: evil, name: evil, dia: evil, type: evil, len: evil }], toolsNote: evil,
    stock: evil, partSize: evil, time: evil, timeBasis: evil, zero: evil, zeroZ: evil, wcs: evil,
    ops: [{ label: evil, depth: -1, feed: 100, line: 0 }], changes: [{ line: 0, code: "M0", note: evil }],
    warnings: [evil], zones: [evil], svg: ""
  }, k => k);
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(!sheetDocument(html, evil).includes("<title><img"));
});

test("Bild: nur Schnitte, begrenzte Größe, leer ohne Schnitte", () => {
  const n = 20000, a = new Array(n).fill(0).map((_, i) => i / 100);
  const svg = jobSvg({ n, x0: a, y0: a, x1: a, y1: a.map(v => v + 1), cut: i => i % 2 === 0 });
  assert.ok(svg.startsWith("<svg"));
  assert.ok((svg.match(/M/g) || []).length <= 6100);
  assert.equal(jobSvg({ n: 1, x0: [0], y0: [0], x1: [1], y1: [1], cut: () => false }), "");
});

test("Two-sided: both sides, pins and steps on the sheet; foreign names stay harmless", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const side = (name: string) => ({ name, time: evil, partSize: evil, tools: [{ no: "T1", name: evil, dia: "3 mm", type: evil, len: "–" }],
    ops: [{ label: evil, depth: -5, feed: 800, line: 0 }], changes: [{ line: 3, code: "M0", note: evil }], warnings: [evil], svg: "" });
  const base = {
    title: "t", date: "d", tools: [], toolsNote: "", stock: "160 × 110", partSize: "", time: "", timeBasis: "", zero: "", zeroZ: "", wcs: "",
    ops: [], changes: [], warnings: ["both sides"], zones: [], svg: ""
  };
  const html = sheetHtml({ ...base, two: { rows: [["Turn over", evil]], pins: [{ no: "1", x: "100", y: "29" }, { no: "2", x: "100", y: evil }], steps: ["one", evil], sides: [side("FRONT-1"), side("BACK-2")] } }, k => k);
  assert.ok(!html.includes("<img"));
  assert.ok(html.indexOf("FRONT-1") > 0 && html.indexOf("BACK-2") > html.indexOf("FRONT-1"));
  assert.ok(html.includes("<td>100</td><td>29</td>"));
  assert.ok(html.includes("<ol><li>one</li>"));
  assert.ok(html.includes("both sides"));
  // without `two` the sheet is the single-sided one
  assert.ok(!sheetHtml(base, k => k).includes("<ol>"));
});

test("Two-sided: the picture shows stock, turning line and pins even without cuts", () => {
  const marks = { rect: { x: 20, y: 20, w: 160, h: 110 }, line: { along: "y" as const, at: 100 }, pins: [{ x: 100, y: 29, r: 3 }, { x: 100, y: 121, r: 3 }] };
  const svg = jobSvg({ n: 1, x0: [50], y0: [50], x1: [90], y1: [50], cut: () => true }, [], 6000, marks);
  assert.ok(svg.includes(`<rect x="20" y="0" width="160" height="110"`));   // y is flipped: top edge of the stock (Y130) is 0
  assert.equal((svg.match(/<circle/g) || []).length, 2);
  assert.ok(svg.includes(`<line x1="100"`));
  assert.ok(jobSvg({ n: 0, x0: [], y0: [], x1: [], y1: [], cut: () => false }, [], 6000, marks).startsWith("<svg"));
  // unchanged without marks
  assert.ok(!jobSvg({ n: 1, x0: [50], y0: [50], x1: [90], y1: [50], cut: () => true }).includes("<rect"));
});
