// Small generators: TypeScript (src/livingHinge.ts, src/vent.ts, src/scales.ts, src/mandala.ts) and Rust
// (src-tauri/src/generators.rs) must give the same geometry, numbers and warnings. Pinned in
// fixtures/generators-cases.json.gz (long point lists as count and hash); `cargo test generators` compares (numbers to 1e-9).
// After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test generators
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { livingHinge, suggestForThickness, HINGE_PATTERNS, type HingeOptions } from "../src/livingHinge.ts";
import { vent, VENT_PATTERNS, VENT_SHAPES, type VentOptions } from "../src/vent.ts";
import { scale, type ScaleOptions } from "../src/scales.ts";
import { mandala, MANDALA_CENTERS, MANDALA_EDGES, MOTIFS, type MandalaOptions } from "../src/mandala.ts";

const file = new URL("./fixtures/generators-cases.json.gz", import.meta.url);
type Job = { kind: "hinge"; hinge: HingeOptions } | { kind: "vent"; vent: VentOptions } | { kind: "scale"; scale: ScaleOptions } | { kind: "mandala"; mandala: MandalaOptions };
const jobs: Job[] = [];
const H0: HingeOptions = { pattern: "lines", width: 120, height: 80, panel: true, length: 60, spacing: 1.8, cut: 18, bridge: 3, amplitude: 1, slotWidth: 1, thickness: 3 };
for (const pattern of HINGE_PATTERNS) for (const v of [{}, { panel: false, length: 200 }, { spacing: 0.2, bridge: 0.5, cut: 0.8, amplitude: 3 }, { height: 10, cut: 30 }, { ...suggestForThickness(6), thickness: 6 }])
  jobs.push({ kind: "hinge", hinge: { ...H0, pattern, ...v } });
const V0: VentOptions = { shape: "rect", width: 100, height: 70, radius: 8, margin: 5, pattern: "hex", size: 6, web: 2, slotLength: 20, plate: true, mountD: 4, mountInset: 6 };
for (const shape of VENT_SHAPES) for (const pattern of VENT_PATTERNS) for (const v of [{}, { mountD: 0, plate: false }, { web: 0.5, size: 2.5, radius: 40 }, { margin: 60 }, { mountInset: 2 }])
  jobs.push({ kind: "vent", vent: { ...V0, shape, pattern, ...v } });
const S0: ScaleOptions = { kind: "ruler", unit: "mm", length: 150, width: 25, holeD: 6, radius: 60, diameter: 120, numerals: "arabic", centerHole: 8, textH: 3 };
for (const v of [{}, { unit: "inch" as const, length: 6 }, { width: 6, holeD: 10 }, { holeD: 0, length: 12.5 }, { kind: "protractor" as const }, { kind: "protractor" as const, radius: 10, textH: 6 },
  { kind: "clock" as const }, { kind: "clock" as const, numerals: "roman" as const, centerHole: 0 }, { kind: "clock" as const, numerals: "none" as const, diameter: 30, textH: 8 }])
  jobs.push({ kind: "scale", scale: { ...S0, ...v } });
let seed = 3;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (const edge of MANDALA_EDGES) for (const center of MANDALA_CENTERS)
  jobs.push({ kind: "mandala", mandala: { d: 80 + rnd() * 120, n: 4 + Math.floor(rnd() * 20), rings: 1 + Math.floor(rnd() * 8), web: 0.8 + rnd() * 2, edge, center, seed: Math.floor(rnd() * 1e6) } });
for (const motif of [...MOTIFS, "mixed" as const]) jobs.push({ kind: "mandala", mandala: { d: 150, n: 12, rings: 5, web: 1.5, edge: "round", center: "dots", seed: 42, motif } });
for (const v of [{ seed: -7.5 }, { seed: 2 ** 33 + 5 }, { seed: 0 }, { n: 2.4, rings: 0 }, { n: 99, rings: 20, web: 0.1 }, { d: 10 }])
  jobs.push({ kind: "mandala", mandala: { d: 120, n: 8, rings: 4, web: 1.2, edge: "petals", center: "star", seed: 7, ...v } });

/** FNV-1a, 32 bit */
const fnv = (t: string) => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193) >>> 0; return h; };
/** all numbers of pure geometry (numbers, arrays, objects of numbers), keys sorted; null = not pure geometry */
const flat = (v: unknown): number[] | null => {
  if (typeof v === "number") return [v];
  if (Array.isArray(v)) { const out: number[] = []; for (const e of v) { const f = flat(e); if (!f) return null; out.push(...f); } return out; }
  if (v && typeof v === "object") { const out: number[] = []; for (const k of Object.keys(v).sort()) { const f = flat((v as Record<string, unknown>)[k]); if (!f) return null; out.push(...f); } return out; }
  return null;
};
/** long point lists as count and hash (6 decimals: sine and cosine may differ in the last bit), the rest as it is */
const digest = (v: unknown): unknown => {
  if (Array.isArray(v)) { const f = flat(v); return f && f.length > 64 ? { n: f.length, h: fnv(f.map(x => x.toFixed(6)).join(",")) } : v.map(digest); }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, digest(x)]));
  return v;
};
const run = (j: Job): unknown => j.kind === "hinge" ? livingHinge(j.hinge) : j.kind === "vent" ? vent(j.vent) : j.kind === "scale" ? scale(j.scale) : mandala(j.mandala);

test("small generators: pinned result for Rust (generators-cases.json.gz)", () => {
  const full = jobs.map(job => ({ job, want: run(job) }));
  const cases = full.map(c => ({ job: c.job, want: digest(c.want) }));
  const suggest = [0, 0.3, 1, 3, 6.25, 12].map(t => ({ t, want: suggestForThickness(t) }));
  const warn = new Set(full.flatMap(c => (c.want as { warnings?: string[] }).warnings ?? []));
  assert.ok(warn.size >= 8, [...warn].join(","));
  const text = JSON.stringify({ cases, suggest }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
