// Long board in sections: TypeScript (src/longBoard.ts) and Rust (src-tauri/src/longboard.rs) must find the same
// sections, errors and bounds and write the same section programs (lines character for character, cuts, entries, first
// tool, box, trace), pin hits and pin hole lines. Programs: the test drawing as cam.ts writes it (with and without tool
// table), hand-made programs with tool changes and arcs across the borders. Pinned in fixtures/longboard-cases.json.gz;
// `cargo test longboard` compares (numbers to 1e-9, the rest exactly).
// After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test longboard
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { checkLong, cutBounds, holeLines, pinHits, sections, splitProgram, unsupported, type HoleTool, type LongOpts } from "../src/longBoard.ts";

const file = new URL("./fixtures/longboard-cases.json.gz", import.meta.url);
const HEAD = ["G21 (mm)", "G90 (abs)", "G0 Z5.00 (safe)", "(Werkzeuge in diesem Programm: 2)", "(  1. Bohrer)", ""];
const T1 = ["(Werkzeug: Fraeser 6, Durchmesser 6.0 mm)", "M3 S12000 (Spindel)", "F1000 (Vorschub)"];
const T2 = ["G0 Z5.00", "M5 (aus)", "M0 (WERKZEUGWECHSEL 2: Fraeser 3)", "", "(Werkzeug: Fraeser 3, Durchmesser 3.0 mm)", "M3 S18000", "G4 P2", "F800"];
const T2M6 = ["G0 Z5.00", "M5 (aus)", "M6 T2 (TOOL 2: Fraeser 3)", "", "(Werkzeug: Fraeser 3, Durchmesser 3.0 mm)", "M3 S18000", "G4 P2", "F800"];
const rect = (x0: number, y0: number, x1: number, y1: number, zs: number[]) => ["(--- Form ---)", "G0 Z5.00", `G0 X${x0} Y${y0}`, ...zs.flatMap(z => [`G1 Z${z} F300`, `G1 X${x1} Y${y0} F1000`, `G1 X${x1} Y${y1}`, `G1 X${x0} Y${y1}`, `G1 X${x0} Y${y0}`]), "G0 Z5.00"];
const END = ["M5 (aus)", "G0 X0 Y0 (park)", "M30 (Ende)"];
const arc = ["G0 X120 Y400", "G1 Z-2 F300", "G3 X120 Y400 I0 J-140 F1000", "G2 X180 Y340 Z-4 I0 J-60", "G0 Z5.00"];

const programs: { name: string; lines: string[]; prefix: string; along: "x" | "y" }[] = [
  { name: "rectangles, arcs and a tool change", lines: [...HEAD, ...T1, ...rect(50, 60, 150, 640, [-2, -4, -6]), ...arc, ...T2, ...rect(70, 280, 130, 300, [-3]), ...END], prefix: "Werkzeug:", along: "y" },
  { name: "tool change with M6 (tool table)", lines: [...HEAD, "M6 T1 (TOOL 1: Fraeser 6)", ...T1, ...rect(40, 30, 600, 90, [-1.5, -3]), ...T2M6, ...rect(80, 40, 560, 80, [-2]), ...END], prefix: "Werkzeug:", along: "x" },
  { name: "odd spellings", lines: ["g21", "g90", "G00 z5", "(Werkzeug: Bohrer 3)", "M03 S1000", "f500", "G0X10Y20", "G01Z-1", "G1 X10 Y480 ; long cut", "G4 P0.5", "G1 X30.5Y480.25 F750", "G02 X40 Y470 I0 J-10", "G0 Z5", "M05", "M30"], prefix: "Werkzeug:", along: "y" },
  { name: "drilling and dwell", lines: [...HEAD, ...T1, ...[100, 260, 420].flatMap(y => ["G0 X40 Y" + y, "G0 Z0.5", "G1 Z-3 F200", "G4 P1", "G0 Z5.00"]), ...END], prefix: "Werkzeug:", along: "y" },
];
for (const name of ["post-drawing", "post-drawing-table"]) programs.push({ name, lines: readFileSync(new URL(`./fixtures/${name}.gcode`, import.meta.url), "utf8").split("\n"), prefix: "tool: ", along: "x" });

const optsFor = (along: "x" | "y", b: { x0: number; y0: number; x1: number; y1: number }): LongOpts[] => {
  const len = along === "x" ? b.x1 : b.y1;
  const pins = (pa: number, c: number[]) => c.map(v => (along === "x" ? { x: pa, y: v } : { x: v, y: pa }));
  const base: LongOpts = { axis: along, bed: Math.max(60, len * 0.6), start: 20, shift: Math.max(20, Math.floor(len * 0.35)), overlap: 5, pins: pins(10, [20, 80]), pinD: 6 };
  return [
    base,
    { ...base, overlap: 0.5, start: 10 },
    { ...base, shift: Math.max(20, Math.floor(len * 0.2)), overlap: 12 },
    { ...base, shift: 10 },                                    // too small: no sections
    { ...base, bed: base.shift, pins: pins(2, [1, 2]) },       // errors: window, pins
    { ...base, axis: along === "x" ? "y" : "x" },              // the other axis
  ];
};
const tools: HoleTool[] = [{ drill: true, diameter: 6, feed: 800, plunge: 300, stepZ: 2 }, { drill: false, diameter: 3, feed: 1200, plunge: 250.6, stepZ: 1.5 }, { drill: false, diameter: 5.95, feed: 900, plunge: 200, stepZ: 0.05 }];

test("long board: pinned result for Rust (longboard-cases.json.gz)", () => {
  const cases = [];
  for (const p of programs) {
    const bad = unsupported(p.lines), bounds = cutBounds(p.lines);
    assert.equal(bad, null, p.name);
    for (const [oi, o] of optsFor(p.along, bounds!).entries()) for (const keepM6 of [false, true]) {
      if (keepM6 && oi > 1) continue;
      const min = o.axis === "x" ? bounds!.x0 : bounds!.y0, max = o.axis === "x" ? bounds!.x1 : bounds!.y1;
      const errs = checkLong(o, min, max), secs = errs.includes("shift") ? [] : sections(o, max);
      const parts = secs.map(s => splitProgram(p.lines, o.axis, s, 5, p.prefix, keepM6));
      const keep = o.pinD / 2 + 3 + 1, holes = o.pins.map(q => (o.axis === "x" ? { x: q.x + o.shift, y: q.y } : { x: q.x, y: q.y + o.shift }));
      const hits = parts.map(s => ({ pins: pinHits(s.trace, o.pins, keep), holes: pinHits(s.trace, holes, keep) }));
      const holeTool = tools[(oi + (keepM6 ? 1 : 0)) % tools.length];
      const job = { text: p.lines.join("\n"), opts: o, min, max, safeZ: 5, toolPrefix: p.prefix, keepM6, keep, holes, holeTool, holeDepth: 18.5 };
      cases.push({ name: `${p.name} / options ${oi}${keepM6 ? " / M6 kept" : ""}`, job, want: { bad, bounds, errs, secs, parts, hits, holeLines: holeLines(holes, o.pinD, 18.5, holeTool, 5) } });
    }
  }
  // there are cuts across borders, several sections, pin hits and errors among the cases
  assert.ok(cases.some(c => c.want.parts.length >= 3) && cases.some(c => c.want.parts.some(s => s.entries > 1)));
  assert.ok(cases.some(c => c.want.errs.length) && cases.some(c => c.want.hits.some(h => h.pins.length || h.holes.length)));
  assert.equal(unsupported(["G0 X1", "G91 G0 X5"]), "G91");
  const text = JSON.stringify(cases) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
