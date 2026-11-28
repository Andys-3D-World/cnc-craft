// Box generator: TypeScript (src/box.ts) and Rust (src-tauri/src/boxgen.rs) must make the same panels (names, sizes,
// outlines, holes, bend lines, places) for every box type, with and without kerf and dogbones, and the same small
// helpers (outerSize, diceMinHeight, diceAngle, cabinetDrawer, hingeHoleD). Pinned in fixtures/boxgen-cases.json.gz
// (long point lists as count and hash, rounded to 6 decimals); `cargo test boxgen` compares.
// After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test boxgen
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { BOX_TYPES, boxPanels, cabinetDrawer, diceAngle, diceMinHeight, hingeHoleD, outerSize, type BoxOptions } from "../src/box.ts";

const file = new URL("./fixtures/boxgen-cases.json.gz", import.meta.url);
const fnv = (t: string) => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193) >>> 0; return h; };
const flat = (v: unknown): number[] | null => {
  if (typeof v === "number") return [v];
  if (Array.isArray(v)) { const out: number[] = []; for (const e of v) { const f = flat(e); if (!f) return null; out.push(...f); } return out; }
  if (v && typeof v === "object") { const out: number[] = []; for (const k of Object.keys(v).sort()) { const f = flat((v as Record<string, unknown>)[k]); if (!f) return null; out.push(...f); } return out; }
  return null;
};
const digest = (v: unknown): unknown => {
  if (Array.isArray(v)) { const f = flat(v); return f && f.length > 64 ? { n: f.length, h: fnv(f.map(x => x.toFixed(6)).join(",")) } : v.map(digest); }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, digest(x)]));
  return v;
};
const B: BoxOptions = { w: 120, d: 80, h: 60, inner: false, t: 3, finger: 10, lid: true, kerf: 0, nx: 2, ny: 1, overhang: 5, shelves: 2, radius: 15, sides: 6, tool: 0 };
const variants: Partial<BoxOptions>[] = [{}, { inner: true, kerf: 0.15 }, { t: 6, finger: 20, tool: 3.175 }, { w: 300, d: 200, h: 150, t: 4, finger: 12, kerf: 0.1, tool: 6 }];
const extra: Partial<BoxOptions>[] = [{ type: undefined, lid: false }, { type: "nonsense" }, { type: "tray", nx: 0, ny: 3 }, { type: "tray", nx: 25.4, ny: 0.4 }, { type: "hex", sides: 3 }, { type: "hex", sides: 12.6, inner: true },
  { type: "flex", radius: 100 }, { type: "flexcup", radius: 2, t: 1.5 }, { type: "cabinet", shelves: 0 }, { type: "cabinet", shelves: 4, inner: true }, { type: "dice", h: 40 }, { type: "dice", h: 400, d: 120 },
  { type: "drawer", overhang: 0 }, { type: "slidebook", overhang: 0.2 }, { type: "money", inner: true }, { type: "closed", w: 20, d: 15, h: 10 }, { type: "lantern", w: 40, d: 40, h: 40 }];

test("box generator: pinned result for Rust (boxgen-cases.json.gz)", () => {
  const cases: { o: BoxOptions; want: unknown }[] = [];
  for (const type of BOX_TYPES) for (const v of variants) { const o = { ...B, type, ...v }; cases.push({ o, want: digest(boxPanels(o)) }); }
  for (const v of extra) { const o = { ...B, ...v }; cases.push({ o, want: digest(boxPanels(o)) }); }
  const helpers = cases.map(c => ({ o: c.o, size: outerSize(c.o), diceMin: diceMinHeight(c.o), diceDeg: diceAngle(c.o), drawer: cabinetDrawer(c.o), hole: hingeHoleD(c.o.t, c.o.kerf) }));
  assert.ok(cases.length >= 100);
  const text = JSON.stringify({ cases, helpers }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
