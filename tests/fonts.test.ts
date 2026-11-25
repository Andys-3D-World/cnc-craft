import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { distance2, largestTool, minHeight, reachable } from "../src/editor/fontFit.ts";
import { isFontBytes, pickFromZip, readFontInfo } from "../src/editor/fontFile.ts";
import { unzipFiles } from "../src/zipRead.ts";

const near = (a: number, b: number, t: number) => assert.ok(Math.abs(a - b) <= t, `${a} ≠ ${b}`);
const src = readFileSync(new URL("../src/editor/fonts.ts", import.meta.url), "utf8");
const BUNDLED = [...src.matchAll(/^ {2}\{ family: (?:"([^"]+)"|SINGLE_LINE_FONT), cat: "(\w+)", file: "([^"]+)"([^}]*)\}/gm)].map(m => ({ family: m[1] ?? "Relief SingleLine", cat: m[2], file: m[3], rest: m[4] }));

test("every bundled font exists, is readable, has a licence file and German letters", () => {
  assert.ok(BUNDLED.length >= 110, String(BUNDLED.length));
  assert.equal(new Set(BUNDLED.map(b => b.family.toLowerCase())).size, BUNDLED.length);
  let total = 0;
  for (const b of BUNDLED) {
    const dir = new URL(`../public/fonts/${b.file.split("/")[0]}/`, import.meta.url), apache = /apache: true/.test(b.rest);
    const files = [b.file, ...(/bold: "([^"]+)"/.exec(b.rest)?.slice(1) ?? [])];
    for (const f of files) {
      const u = new URL(`../public/fonts/${f}`, import.meta.url);
      assert.ok(existsSync(u), f);
      total += statSync(u).size;
      const data = readFileSync(u);
      assert.ok(isFontBytes(data), f);
      const i = readFontInfo(data);
      if (!/woff2$/.test(f)) { assert.ok(i && i.family, f); assert.ok(i!.de, "ohne äöüß: " + f); assert.equal(i!.pl, !/noPl: true/.test(b.rest), "pl: " + f); }
    }
    const lic = readFileSync(new URL(apache ? "LICENSE.txt" : "OFL.txt", dir), "utf8");
    assert.match(lic, apache ? /Apache License/ : /SIL OPEN FONT LICENSE/i, b.family);
  }
  assert.ok(total < 20 * 1024 * 1024, "zu groß: " + total);
});

test("font info: name, licence; damaged files give null and never throw", () => {
  const d = readFileSync(new URL("../public/fonts/lobster/Lobster-Regular.ttf", import.meta.url)), i = readFontInfo(d)!;
  assert.equal(i.family, "Lobster"); assert.equal(i.style, "Regular"); assert.match(i.license, /SIL|OFL/);
  for (const n of [0, 3, 20, 120, 4000]) readFontInfo(new Uint8Array(d.subarray(0, n)));
  const x = new Uint8Array(d); for (let k = 0; k < x.length; k += 7) x[k] ^= 0x5a;
  readFontInfo(x);
  assert.ok(!isFontBytes(new Uint8Array(200))); assert.ok(!isFontBytes(new Uint8Array(3)));
});

test("ZIP: the variable font is preferred, hidden and foreign files are left out", () => {
  assert.deepEqual(pickFromZip(["OFL.txt", "Jost-VariableFont_wght.ttf", "Jost-Italic-VariableFont_wght.ttf", "static/Jost-Bold.ttf"]), ["Jost-VariableFont_wght.ttf", "Jost-Italic-VariableFont_wght.ttf"]);
  assert.deepEqual(pickFromZip(["a/Foo-Regular.otf", "a/Foo-Bold.otf", "__MACOSX/a/._Foo-Regular.otf", "readme.txt", "x.exe"]), ["a/Foo-Regular.otf", "a/Foo-Bold.otf"]);
  assert.deepEqual(pickFromZip(["static/A.ttf"]), ["static/A.ttf"]);
});

test("unzip reads stored files, skips encrypted ones and refuses rubbish", async () => {
  const enc = new TextEncoder(), name = enc.encode("a.ttf"), body = enc.encode("hello"), u16 = (v: number) => [v & 255, v >> 8], u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  const zip = (flags: number) => {
    const local = [...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(0), ...u32(0), ...u32(0), ...u32(5), ...u32(5), ...u16(5), ...u16(0), ...name, ...body];
    const cen = [...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(flags), ...u16(0), ...u32(0), ...u32(0), ...u32(5), ...u32(5), ...u16(5), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...name];
    return new Uint8Array([...local, ...cen, ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1), ...u32(cen.length), ...u32(local.length), ...u16(0)]);
  };
  const r = await unzipFiles(zip(0), n => n.endsWith(".ttf"));
  assert.equal(new TextDecoder().decode(r[0].data), "hello");
  assert.equal((await unzipFiles(zip(1), () => true)).length, 0);
  assert.equal((await unzipFiles(zip(0), () => false)).length, 0);
  await assert.rejects(() => unzipFiles(new Uint8Array(50), () => true));
});

test("tool fit: a bar of 10 px lets a 10 px tool through, a thin hairline does not", () => {
  const W = 120, H = 60, bar = new Uint8Array(W * H);
  for (let y = 20; y < 30; y++) for (let x = 10; x < 110; x++) bar[y * W + x] = 1;
  near(largestTool(bar, W, H), 10, 1.2);
  const d = distance2(bar, W, H); near(Math.sqrt(d[25 * W + 60]), 5, 1.01);
  assert.ok(reachable(bar, W, H, 4) > 0.95); assert.equal(reachable(bar, W, H, 8), 0);
  // halb dick, halb Haarlinie: die Haarlinie entscheidet
  const mix = bar.slice(); for (let x = 10; x < 110; x++) for (let y = 40; y < 42; y++) mix[y * W + x] = 1;
  assert.ok(largestTool(mix, W, H) < 3, String(largestTool(mix, W, H)));
  near(minHeight(3, 10, 100), 30, 1e-9); assert.equal(minHeight(3, 0, 100), Infinity);
  assert.equal(largestTool(new Uint8Array(W * H), W, H), 0);
});
