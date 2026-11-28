// Two-sided milling: TypeScript (src/twoSided.ts) and Rust (src-tauri/src/twosided.rs) must clean a stored setup the same
// way (JavaScript's Number() included), mirror points the same, suggest the same pins, find the same pin issues and the
// same problems of both sides' depths, and give the same "cut through" depths. Pinned in fixtures/twosided-cases.json.gz;
// `cargo test twosided` compares (numbers to 1e-9). After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cargo test twosided
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { cleanSetup, defaultPins, depthIssues, mirrorPoint, otherSideDepth, pinCut, pinIssues, throughDepth, type PinObstacle, type Removal, type TwoSidedSetup } from "../src/twoSided.ts";

const file = new URL("./fixtures/twosided-cases.json.gz", import.meta.url);
const raws: unknown[] = [
  null, 0, "x", [], {}, { on: true },
  { on: true, flip: "fb", stock: { x: 10, y: 15, w: 300, h: 200 }, thickness: 19, zRef: "top", pinsOn: true, pinDia: 8, pinDepth: 10, pins: [{ x: 160, y: 20 }, { x: 160, y: 195 }], pinsAuto: true, pinToolId: "drill-8" },
  { on: "yes", flip: "lr", stock: { x: "12.5", y: " 7 ", w: "0x20", h: "1e2" }, thickness: "", pinDia: [6], pinDepth: [1, 2], pins: [null, 0, 5, "p", { x: "1", y: 2 }, { x: true, y: false }, { x: [], y: [3] }, { x: "a", y: 1 }, { y: 1 }, { x: "Infinity", y: 0 }, { x: "-Infinity", y: 0 }, { x: "1_000", y: 0 }, { x: "0b101", y: "0o17" }, { x: ".5", y: "5." }, { x: "+3e2", y: "-.5e-1" }, { x: "1e", y: 0 }] },
  { stock: 5, thickness: 0.01, pinDia: 99, pinDepth: -5, pinsOn: false, pins: Array.from({ length: 20 }, (_, i) => ({ x: i, y: i })), pinToolId: "x".repeat(100) },
  { stock: { x: -1e9, y: 1e9, w: 0, h: -3 }, thickness: 1000, flip: "FB", zRef: "TOP", pinsOn: 0, pins: "none" },
  { stock: { x: null, y: false, w: true, h: {} }, thickness: null, pinDia: "  ", pinDepth: "\t12\n", pins: [{ x: null, y: null }] },
];

const setups = raws.map(cleanSetup).filter((s): s is TwoSidedSetup => !!s);
const square = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const ring = (cx: number, cy: number, r: number, n = 24) => Array.from({ length: n }, (_, k) => ({ x: cx + r * Math.cos((k / n) * 2 * Math.PI), y: cy + r * Math.sin((k / n) * 2 * Math.PI) }));
const rem = (o: Partial<Removal> & Pick<Removal, "side" | "kind" | "pts" | "depth">): Removal => ({ n: 0, closed: true, width: 0, outline: false, tabH: 0, ...o });

test("two-sided milling: pinned result for Rust (twosided-cases.json.gz)", () => {
  const clean = raws.map(raw => ({ raw, want: cleanSetup(raw) }));
  const jobs = [];
  for (const [si, s0] of setups.entries()) {
    for (const variant of [0, 1, 2]) {
      const s: TwoSidedSetup = { ...s0, flip: variant === 1 ? (s0.flip === "lr" ? "fb" : "lr") : s0.flip, pins: variant === 2 ? defaultPins(s0, []) : s0.pins };
      const { x, y, w, h } = s.stock, T = s.thickness;
      const obstacles: PinObstacle[] = [
        { pts: square(x + w * 0.2, y + h * 0.3, w * 0.25, h * 0.4), closed: true, grow: 3 },
        { pts: [{ x: x + w / 2 - 1, y }, { x: x + w / 2 + 1, y: y + h }], closed: false, grow: 1.5 },
        { pts: [{ x: x + 5, y: y + 5 }], closed: false, grow: 2 },
        { pts: ring(x + w * 0.8, y + h * 0.7, Math.min(w, h) * 0.1), closed: true, grow: 6 },
      ];
      const all: Removal[] = [
        rem({ side: "front", kind: "groove", pts: square(x + 20, y + 20, w / 3, h / 3), depth: T * 0.6, width: 6, outline: true, tabH: 2 }),
        rem({ side: "back", kind: "groove", pts: square(x + 20, y + 20, w / 3, h / 3), depth: T * 0.6, width: 6, outline: true, tabH: variant === 0 ? 1 : 0 }),
        rem({ side: "front", kind: "area", pts: square(x + w / 2, y + 10, 30, 20), depth: T * 0.5 }),
        rem({ side: "back", kind: "area", pts: square(x + w / 2 + 5, y + 12, 30, 20), depth: T * 0.49 + variant * 0.2 }),
        rem({ side: "front", kind: "groove", pts: [{ x: x + 5, y: y + h - 10 }, { x: x + w - 5, y: y + h - 10 }], closed: false, depth: T, width: 3, outline: false }),
        rem({ side: "back", kind: "groove", pts: [{ x: x + 5, y: y + h - 10 }, { x: x + w - 5, y: y + h - 10 }], closed: false, depth: 0.4, width: 3 }),
        rem({ side: "front", kind: "groove", pts: square(x + w - 60, y + 10, 40, 40), depth: T, width: 4, outline: true }),
        rem({ side: "back", kind: "area", pts: ring(x + 50, y + h - 50, 10), depth: T - 0.3, skin: variant === 2 ? 0.3 : undefined }),
        rem({ side: "front", kind: "area", pts: ring(x + 50, y + h - 50, 12), depth: 0.2 }),
        rem({ side: "front", kind: "groove", pts: [], closed: false, depth: 1, width: 0 }),
      ].map((r, i) => ({ ...r, n: i + 1 }));
      const removals = all.filter((_, i) => i !== 9 || variant !== 1);
      const parts = [{ minX: x + w / 2 - 20, minY: y, maxX: x + w / 2 + 20, maxY: y + h * 0.2 }];
      const bed = variant === 1 ? null : { w: x + w + 10, h: y + h - 5 };
      const tool = [{ d: s.pinDia, drill: true }, { d: s.pinDia / 3, drill: false }, { d: s.pinDia / 2 - 0.1, drill: false }][variant];
      const other = all.map(r => otherSideDepth(r, all));
      jobs.push({
        name: `setup ${si} / variant ${variant}`, job: { setup: s, obstacles, bed, removals, all, parts, toolDia: tool.d, toolDrill: tool.drill },
        want: { pins: pinIssues(s, obstacles, bed), depth: depthIssues(removals, T), other, through: other.map(o => throughDepth(T, o)), defaults: defaultPins(s, parts),
          pinCut: pinCut(s.pinDia, tool.d, tool.drill), mirrored: s.pins.map(p => mirrorPoint(p, s)) },
      });
    }
  }
  const codes = new Set(jobs.flatMap(j => [...j.want.pins.map(p => p.code), ...j.want.depth.map(d => d.code)]));
  assert.ok(["asym", "inPart", "offStock", "offBed", "few", "close", "looseFront", "thin", "through"].every(c => codes.has(c)), [...codes].join(","));
  const text = JSON.stringify({ clean, jobs }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
