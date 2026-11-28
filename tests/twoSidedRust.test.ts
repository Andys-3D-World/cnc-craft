// Two-sided milling: TypeScript (src/twoSided.ts) and Rust (src-tauri/src/twosided.rs) must clean a stored setup the same
// way (JavaScript's Number() included), mirror points the same, suggest the same pins, find the same pin issues and the
// same problems of both sides' depths, and give the same "cut through" depths. Pinned in fixtures/twosided-cases.json.gz;
// `cargo test twosided` compares (numbers to 1e-9). After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cargo test twosided
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { cleanSetup, defaultPins, depthIssues, mirrorPoint, otherSideDepth, pinCut, pinIssues, throughDepth, type PinObstacle, type Pt, type Removal, type TwoSidedSetup } from "../src/twoSided.ts";

const file = new URL("./fixtures/twosided-cases.json.gz", import.meta.url);
const raws: unknown[] = [
  null, 0, "x", [], {}, { on: true },
  { on: true, flip: "fb", stock: { x: 10, y: 15, w: 300, h: 200 }, thickness: 19, zRef: "top", pinsOn: true, pinDia: 8, pinDepth: 10, pins: [{ x: 160, y: 20 }, { x: 160, y: 195 }], pinsAuto: true, pinToolId: "drill-8" },
  { on: "yes", flip: "lr", stock: { x: "12.5", y: " 7 ", w: "0x20", h: "1e2" }, thickness: "", pinDia: [6], pinDepth: [1, 2], pins: [null, 0, 5, "p", { x: "1", y: 2 }, { x: true, y: false }, { x: [], y: [3] }, { x: "a", y: 1 }, { y: 1 }, { x: "Infinity", y: 0 }, { x: "-Infinity", y: 0 }, { x: "1_000", y: 0 }, { x: "0b101", y: "0o17" }, { x: ".5", y: "5." }, { x: "+3e2", y: "-.5e-1" }, { x: "1e", y: 0 }] },
  { stock: 5, thickness: 0.01, pinDia: 99, pinDepth: -5, pinsOn: false, pins: Array.from({ length: 20 }, (_, i) => ({ x: i, y: i })), pinToolId: "x".repeat(100) },
  { stock: { x: -1e9, y: 1e9, w: 0, h: -3 }, thickness: 1000, flip: "FB", zRef: "TOP", pinsOn: 0, pins: "none" },
  { stock: { x: null, y: false, w: true, h: {} }, thickness: null, pinDia: "  ", pinDepth: "\t12\n", pins: [{ x: null, y: null }] },
  { stock: { x: "0X1F", y: "0B11", w: "0o17", h: "0x" }, thickness: "+7", pinDia: "-3", pins: [{ x: "0XAb", y: "1e+2" }] },
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
  // random jobs: many cuts of both sides with random depths, tabs, skins and partial overlaps; pins near edges and parts
  let seed = 41;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  for (let k = 0; k < 16; k++) {
    const T = pick([6, 12, 18.5]), st = { x: 10, y: 10, w: 200 + rnd() * 100, h: 150 + rnd() * 60 }, pinDia = pick([4, 6, 8]);
    const s: TwoSidedSetup = { on: true, flip: k % 2 ? "fb" : "lr", stock: st, thickness: T, zRef: "spoil", pinsOn: k % 5 !== 4, pinDia, pinDepth: 6, pinsAuto: false,
      pins: Array.from({ length: k % 3 === 0 ? 1 : 2 + (k % 3) }, () => ({ x: st.x + pick([pinDia / 2 - 0.5, pinDia / 2 + 0.01, st.w / 2, st.w - pinDia / 2, rnd() * st.w]), y: st.y + pick([pinDia / 2, 12, st.h / 2, st.h - 3, rnd() * st.h]) })) };
    if (k % 4 === 1 && s.pins.length >= 2) s.pins[1] = { x: s.pins[0].x + 25, y: s.pins[0].y };
    const shape = (): { pts: Pt[]; closed: boolean } => {
      const cx = st.x + rnd() * st.w, cy = st.y + rnd() * st.h, r = 2 + rnd() * 30;
      return pick([{ pts: square(cx - r, cy - r, 2 * r, r * (0.5 + rnd())), closed: true }, { pts: ring(cx, cy, r, 12 + Math.floor(rnd() * 20)), closed: true },
        { pts: [{ x: cx, y: cy }, { x: cx + r, y: cy + r * (rnd() - 0.5) }], closed: false }, { pts: [{ x: cx, y: cy }, { x: cx + 0.3, y: cy + 0.4 }, { x: cx + 0.6, y: cy }], closed: false }]);
    };
    const all: Removal[] = [];
    for (let i = 0; i < 24; i++) {
      const base = i % 3 === 2 && all.length ? all[all.length - 1] : null, sh = base ? { pts: base.pts.map(q => ({ x: q.x + pick([0, 0.2, 3]), y: q.y })), closed: base.closed } : shape();
      const kind = sh.closed && rnd() < 0.4 ? "area" : "groove";
      all.push(rem({ side: base ? (base.side === "front" ? "back" : "front") : pick(["front", "back"]), kind, pts: sh.pts, closed: sh.closed, depth: T * pick([0.2, 0.5, 0.49, 0.51, 0.75, 0.97, 1, 1.02]),
        width: kind === "groove" ? pick([0, 2, 3, 6]) : 0, outline: sh.closed && kind === "groove" && rnd() < 0.6, tabH: pick([0, 0, 0.2, 1, 3]), skin: rnd() < 0.2 ? pick([0.3, 1]) : undefined, n: i + 1 }));
    }
    const obstacles: PinObstacle[] = [...all.slice(0, 8).map(r => ({ pts: r.pts, closed: r.closed, grow: pick([1.5, 3, 6]) })), { pts: [{ x: s.pins[0].x + 3, y: s.pins[0].y }], closed: false, grow: 1 },
      { pts: [{ x: s.pins[0].x - 0.2, y: s.pins[0].y + 2 }, { x: s.pins[0].x + 0.3, y: s.pins[0].y + 2.1 }], closed: false, grow: 0.5 }, { pts: square(mirrorPoint(s.pins[0], s).x - 2, mirrorPoint(s.pins[0], s).y - 2, 4, 4), closed: true, grow: 0 }];
    const parts = [{ minX: s.pins[0].x + pinDia / 2 + 0.5, minY: s.pins[0].y - 1, maxX: s.pins[0].x + 20, maxY: s.pins[0].y + 1 }, { minX: st.x + st.w / 2 - 3, minY: st.y + 5, maxX: st.x + st.w / 2 + 3, maxY: st.y + 30 }];
    const bed = { w: st.x + st.w + pick([0, 5]), h: st.y + st.h };
    const tool = pick([{ d: pinDia + 0.03, drill: true }, { d: pinDia + 0.01, drill: false }, { d: pinDia - 1, drill: true }, { d: pinDia / 2 - 0.004, drill: false }, { d: pinDia / 2 + 0.2, drill: false }]);
    const other = all.map(r => otherSideDepth(r, all));
    jobs.push({
      name: `random ${k + 1}`, job: { setup: s, obstacles, bed, removals: all, all, parts, toolDia: tool.d, toolDrill: tool.drill },
      want: { pins: pinIssues(s, obstacles, bed), depth: depthIssues(all, T), other, through: other.map(o => throughDepth(T, o)), defaults: defaultPins(s, parts),
        pinCut: pinCut(s.pinDia, tool.d, tool.drill), mirrored: s.pins.map(p => mirrorPoint(p, s)) },
    });
  }
  const codes = new Set(jobs.flatMap(j => [...j.want.pins.map(p => p.code), ...j.want.depth.map(d => d.code)]));
  assert.ok(["asym", "inPart", "offStock", "offBed", "few", "close", "looseFront", "thin", "through"].every(c => codes.has(c)), [...codes].join(","));
  const text = JSON.stringify({ clean, jobs }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
