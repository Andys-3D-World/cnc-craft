// Vector export: TypeScript (src/vectorExport.ts) and Rust (src-tauri/src/vexport.rs) must write the same SVG, DXF, PDF
// and PLT files, character for character, after the same curveItems step (circles and arcs fitted into polylines).
// This test builds drawings with every kind of element (paths with and without bulges, circles, arcs, images, groups,
// names and layer names that need escaping or cleaning) and pins the four files in fixtures/vexport-cases.json.gz;
// `cargo test vexport` compares. After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test vexport
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { curveItems, toDxf, toHpgl, toPdf, toSvg, type ExpItem, type XY } from "../src/vectorExport.ts";

const file = new URL("./fixtures/vexport-cases.json.gz", import.meta.url);
let seed = 3;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const ring = (cx: number, cy: number, r: number, n: number, a0 = 0): XY[] => Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(a0 + (i / n) * Math.PI * 2), y: cy + r * Math.sin(a0 + (i / n) * Math.PI * 2) }));
const rounded = (x: number, y: number, w: number, h: number, r: number, n = 8): XY[] => {
  const out: XY[] = [];
  const corner = (cx: number, cy: number, a: number) => { for (let i = 0; i <= n; i++) out.push({ x: cx + r * Math.cos(a + (i / n) * Math.PI / 2), y: cy + r * Math.sin(a + (i / n) * Math.PI / 2) }); };
  corner(x + w - r, y + r, -Math.PI / 2); corner(x + w - r, y + h - r, 0); corner(x + r, y + h - r, Math.PI / 2); corner(x + r, y + r, Math.PI);
  return out;
};
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const L = (layer: string, color: string) => ({ layer, color });

const drawings: { name: string; items: ExpItem[] }[] = [];
drawings.push({ name: "empty", items: [] });
drawings.push({ name: "one line", items: [{ ...L("Cut", "#ff0000"), kind: "path", pts: [{ x: 0, y: 0 }, { x: 10, y: 5 }], closed: false }] });
drawings.push({ name: "shapes of every kind", items: [
  { ...L("Cut", "#ff0000"), kind: "path", pts: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 0, y: 20 }, { x: 0, y: 0 }], closed: true, name: "rect <1>" },
  { ...L("Cut", "#ff0000"), kind: "path", pts: [{ x: 50, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 10 }], closed: false, bulges: [0.414, -0.2] },
  { ...L("Cut", "#ff0000"), kind: "path", pts: [{ x: 70, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 10 }], closed: true, bulges: [0, 0.5, 1] },
  { ...L("Engrave", "#00ff00"), kind: "circle", cx: 20, cy: 40, r: 7.5 },
  { ...L("Engrave", "#00ff00"), kind: "arc", cx: 50, cy: 40, r: 5, start: 0.3, sweep: 2.5 },
  { ...L("Engrave", "#00ff00"), kind: "arc", cx: 70, cy: 40, r: 6, start: 1, sweep: -4 },
  { ...L("Engrave", "#00ff00"), kind: "arc", cx: 90, cy: 40, r: 3, start: 0, sweep: Math.PI * 2 },
  { ...L("Bild", "#123"), kind: "image", corners: [{ x: 0, y: 50 }, { x: 30, y: 50 }, { x: 30, y: 70 }, { x: 0, y: 70 }], src: PNG },
  { ...L("Bild", "#123"), kind: "image", corners: [{ x: 40, y: 50 }, { x: 60, y: 55 }, { x: 55, y: 75 }, { x: 35, y: 70 }], src: "https://example.com/x.png" },
] });
drawings.push({ name: "groups and odd names", items: [
  { ...L("Fräsen außen", "#0000ff"), kind: "path", pts: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], closed: true, group: "g1", name: "a&b" },
  { ...L("Fräsen außen", "#0000ff"), kind: "circle", cx: 10, cy: 10, r: 2, group: "g1" },
  { ...L("Fräsen außen", "#0000ff"), kind: "circle", cx: 20, cy: 10, r: 2, group: "g2", name: "q\"'" },
  { ...L("Fräsen außen", "#0000ff"), kind: "circle", cx: 30, cy: 10, r: 2 },
  { ...L("Fräsen außen", "#0000ff"), kind: "circle", cx: 40, cy: 10, r: 2, group: "g1" },
  { ...L("Gravur  über\tzwei", "not a colour"), kind: "path", pts: [{ x: 0, y: 20 }, { x: 9, y: 25 }], closed: false, group: "" },
  { ...L("fraesen-aussen", "#ABCDEF"), kind: "path", pts: [{ x: 0, y: 30 }, { x: 9, y: 35 }], closed: false },
  { ...L("___", "#fff"), kind: "path", pts: [{ x: 1, y: 1 }], closed: false },
  { ...L("ﬁligran ½ Ω 😀 Ångström", "#808080"), kind: "path", pts: [{ x: 3, y: 3 }, { x: 4, y: 4 }], closed: false },
  { ...L("A very long layer name that goes on beyond thirty-one characters", "#ff8000"), kind: "path", pts: [{ x: -5, y: -5 }, { x: -1, y: -2 }], closed: false },
  { ...L("0", "#000"), kind: "circle", cx: -3, cy: 3, r: 1 },
] });
drawings.push({ name: "polylines that become circles and arcs", items: [
  { ...L("Holes", "#ff0000"), kind: "path", pts: ring(10, 10, 3, 48), closed: true },
  { ...L("Holes", "#ff0000"), kind: "path", pts: [...ring(30, 10, 4, 64), ring(30, 10, 4, 64)[0]], closed: true },
  { ...L("Holes", "#ff0000"), kind: "path", pts: ring(50, 10, 2, 12), closed: true },
  { ...L("Outline", "#00aaff"), kind: "path", pts: rounded(0, 20, 60, 30, 5), closed: true },
  { ...L("Outline", "#00aaff"), kind: "path", pts: rounded(0, 20, 60, 30, 5, 24), closed: true },
  { ...L("Outline", "#00aaff"), kind: "path", pts: rounded(70, 20, 30, 30, 12, 40), closed: true },
  { ...L("Outline", "#00aaff"), kind: "path", pts: ring(0, 0, 30, 200).slice(0, 90), closed: false },
  { ...L("Outline", "#00aaff"), kind: "path", pts: Array.from({ length: 40 }, (_, i) => ({ x: i, y: 60 + 5 * Math.sin(i / 4) })), closed: false },
] });
drawings.push({ name: "edge cases: rounding at ...5, tiny circles, odd colours and pictures", items: [
  { ...L("Round", "#11223344"), kind: "path", pts: [{ x: 1.00005, y: 2.00005 }, { x: 3.0000005, y: 1.2345650 }, { x: 12.34565, y: 0.0000005 }, { x: 7.00015, y: 4.99995 }], closed: false },
  { ...L("Round", "#11223344"), kind: "path", pts: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0.0000005, y: 0 }], closed: true },
  { ...L("Round", "#11223344"), kind: "path", pts: [{ x: 10, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 5 }], closed: false, bulges: [NaN, 0.3, NaN] },
  { ...L("Tiny", "#1234"), kind: "circle", cx: 30, cy: 3, r: 0.005 },
  { ...L("Tiny", "#1234"), kind: "arc", cx: 32, cy: 3, r: 0.008, start: 0, sweep: 3 },
  { ...L("Tiny", "#1234"), kind: "path", pts: [{ x: 34, y: 3 }, { x: 34.004, y: 3 }], closed: false, bulges: [0.9, 0] },
  { ...L("Grey", "#202020"), kind: "circle", cx: 40, cy: 3, r: 1 },
  { ...L("Silver tie", "#a0a0a0"), kind: "circle", cx: 43, cy: 3, r: 1 },
  { ...L("Short", "#f80"), kind: "circle", cx: 46, cy: 3, r: 1 },
  { ...L("Too long", "#123456789"), kind: "circle", cx: 49, cy: 3, r: 1 },
  { ...L("Two  spaces\there", "#00ff80"), kind: "circle", cx: 52, cy: 3, r: 1, group: "g 1" },
  { ...L("Two  spaces\there", "#00ff80"), kind: "circle", cx: 55, cy: 3, r: 1, group: "g 1" },
  { ...L("Pics", "#000000"), kind: "image", corners: [{ x: 60.123456, y: 0.654321 }, { x: 70.000015, y: 0.5 }, { x: 70.25, y: 9.999995 }, { x: 60, y: 10.00004 }], src: PNG },
  { ...L("Pics", "#000000"), kind: "image", corners: [{ x: 60, y: 20 }, { x: 70, y: 20 }, { x: 70, y: 30 }, { x: 60, y: 30 }], src: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" },
  { ...L("Pics", "#000000"), kind: "image", corners: [{ x: 60, y: 40 }, { x: 70, y: 40 }, { x: 70, y: 50 }, { x: 60, y: 50 }], src: "data:image/png;base64,abc\"onload=x" },
  { ...L("Pics", "#000000"), kind: "image", corners: [{ x: 60, y: 60 }, { x: 70, y: 60 }, { x: 70, y: 70 }, { x: 60, y: 70 }], src: "data:image/jpeg;base64,AAAA BBBB\n==" },
] });
drawings.push({ name: "only a vertical line", items: [{ ...L("V", "#ff0000"), kind: "path", pts: [{ x: 5, y: 0 }, { x: 5, y: 40 }], closed: false }] });
drawings.push({ name: "only a dot", items: [{ ...L("P", "#ff0000"), kind: "path", pts: [{ x: 5, y: 5 }, { x: 5, y: 5 }], closed: false }] });
{
  const items: ExpItem[] = [];
  const layers = [L("A", "#e6194b"), L("B", "#3cb44b"), L("C", "#ffe119"), L("D", "#4363d8"), L("E", "#f58231"), L("F", "#911eb4"), L("G", "#46f0f0"), L("H", "#f032e6"), L("I", "#bcf60c")];
  for (let k = 0; k < 60; k++) {
    const l = layers[Math.floor(rnd() * layers.length)], x = (rnd() - 0.3) * 400, y = (rnd() - 0.3) * 300;
    const kind = rnd();
    if (kind < 0.3) items.push({ ...l, kind: "circle", cx: x, cy: y, r: 0.5 + rnd() * 30 });
    else if (kind < 0.5) items.push({ ...l, kind: "arc", cx: x, cy: y, r: 0.2 + rnd() * 40, start: rnd() * 7 - 3, sweep: (rnd() - 0.5) * 13 });
    else if (kind < 0.8) {
      const n = 2 + Math.floor(rnd() * 9);
      const pts = Array.from({ length: n }, () => ({ x: x + rnd() * 50, y: y + rnd() * 50 }));
      items.push({ ...l, kind: "path", pts, closed: rnd() > 0.5, ...(rnd() > 0.5 ? { bulges: pts.map(() => (rnd() > 0.5 ? (rnd() - 0.5) * 3 : 0)) } : {}), ...(rnd() > 0.7 ? { group: "grp" + Math.floor(rnd() * 3) } : {}) });
    } else items.push({ ...l, kind: "path", pts: ring(x, y, 1 + rnd() * 20, 20 + Math.floor(rnd() * 60), rnd()), closed: true });
  }
  drawings.push({ name: "60 random elements on 9 layers", items });
}

test("vector export: pinned result for Rust (vexport-cases.json.gz)", () => {
  const cases = drawings.map(d => {
    const items = curveItems(d.items);
    return { name: d.name, items: d.items, want: { svg: toSvg(items), dxf: toDxf(items), pdf: toPdf(items), plt: toHpgl(items) } };
  });
  // the fitted drawing really has circles and bulged paths, and images were skipped where they must be
  const fitted = curveItems(drawings[4].items);
  assert.ok(fitted.filter(i => i.kind === "circle").length >= 2 && fitted.some(i => i.kind === "path" && i.bulges?.some(b => b)));
  assert.equal(cases[2].want.svg.skippedImages, 1);
  assert.equal(cases[2].want.dxf.skippedImages, 2);
  const text = JSON.stringify(cases) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
