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
// random programs with every kind of line the splitter has to sort: moves above and below the safe height, arcs (also
// full circles) across the borders, tool and spindle groups, coolant, pauses, comments, feeds alone, ends
let seed = 17;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const f = (v: number) => v.toFixed(3);
for (let k = 0; k < 14; k++) {
  const along = k % 2 ? "x" : "y", L = 300 + rnd() * 700, W = 40 + rnd() * 200;
  const P = (t: number, c: number) => (along === "x" ? `X${f(t)} Y${f(c)}` : `X${f(c)} Y${f(t)}`);
  const lines = ["G21 (mm)", "G90", "G17", "G0 Z5.000", "(Werkzeug: Fraeser 6, Durchmesser 6.0 mm)", pick(["M3 S12000", "M03 S9000", "M4 S8000 (left)"]), "F1000"];
  let t = rnd() * 50, c = rnd() * W;
  for (let i = 0; i < 70; i++) {
    const r = rnd();
    if (r < 0.06) lines.push(...pick([["G0 Z5.000", "M5", "M0 (WERKZEUGWECHSEL 2)", "", "(Werkzeug: Fraeser 3, Durchmesser 3.0 mm)", "M3 S18000", "G4 P2", "F800"],
      ["G0 Z5.000", "M5 (aus)", "M6 T3 (TOOL 3)", "(Werkzeug: Bohrer 4)", "M3 S10000"], ["M8 (coolant)"], ["M9"], ["M7", "M8"], ["M1 (stop)"], ["(--- Form ---)"], ["(a)", "(b)"], ["F1500"], ["F 750.5"], ["G4 P0.5"], ["; note"], [""]]));
    else if (r < 0.22) { t = rnd() * L; c = rnd() * W; lines.push(`G0 ${P(t, c)}`, pick(["G0 Z0.500", "G0 Z5.000", "G0 Z2", "G0 Z-0.5"])); }
    else if (r < 0.32) lines.push(`G1 Z${f(-rnd() * 6)} F${pick(["300", "250.555", "123.456"])}`);
    else if (r < 0.37) lines.push(pick(["G0 Z5.000", "G0 Z10", "G1 Z5.000"]));
    else if (r < 0.75) { t = Math.max(0, t + (rnd() - 0.45) * 250); c = Math.max(0, Math.min(W, c + (rnd() - 0.5) * 40)); lines.push(`${pick(["G1", "", "G01"])} ${P(t, c)}${rnd() < 0.2 ? ` Z${f(-rnd() * 6)}` : ""}${rnd() < 0.2 ? " F" + pick(["900", "1200.25", "650.004"]) : ""}${rnd() < 0.05 ? " M8" : ""}`.trim()); }
    else {
      const rr = 5 + rnd() * 120, full = rnd() < 0.15, g = rnd() < 0.5 ? "G2" : "G3";
      const a0 = rnd() * Math.PI * 2, ct = t - rr * Math.cos(a0), cc = c - rr * Math.sin(a0), a1 = a0 + (g === "G3" ? 1 : -1) * (0.3 + rnd() * 2.5);
      const et = full ? t : ct + rr * Math.cos(a1), ec = full ? c : cc + rr * Math.sin(a1);
      const off = along === "x" ? `I${f(ct - t)} J${f(cc - c)}` : `I${f(cc - c)} J${f(ct - t)}`;
      lines.push(`${g} ${P(et, ec)}${rnd() < 0.2 ? ` Z${f(-rnd() * 6)}` : ""} ${off}${rnd() < 0.3 ? " F777" : ""}`);
      t = et; c = ec;
    }
  }
  lines.push("G0 Z5.000", "M5", "G0 X0 Y0", pick(["M30", "M2", "M02 (end)", "M30 ; end"]));
  programs.push({ name: `random ${k + 1}`, lines, prefix: "Werkzeug:", along });
}
// one program made for the rare paths of the splitter (section borders at X 275 / 265 with the options below)
const targeted = [
  "G21", "G90", "G0 Z5.000", "(Werkzeug: Fraeser 6)", "M3 S12000", "F600",
  "G0 X10 Y10", "G1 Z-1 F200", "G1 X300 Y10 F500", "G1 X200 Y10",            // leaves the window and comes back at the border
  "G1 X10(c)5 Y12", "G1 AX5 Y14", "G0.5 X40 Y14", "G4 P0.2 X44", "G0 G1 X50 Y16",  // spellings the reader must not misread
  "G2 X50.0000001 Y16 I5 J0",                                                   // nearly a full circle
  "N5M8", "G1 X70 Y16",
  "G0 Z5.000", "M1 (check)", "G0 X60 Y60", "M8", "G1 Z-1 F100", "G1 X80 Y60",   // two groups before the next cut
  "G0 Z5.000", "M6 T4 (next)", "G0 X10 Y30", "(about to start)", "G0 X12 Y30", "M3 S9000", "G1 Z-1 F150", "G1 X30 Y30",
  "G0 Z5.000", "(old note)", "(Werkzeug: Fraeser 3)", "M3 S18000", "G1 Z-2 F150", "G1 X40 Y30",   // comments only, then a spindle group
  "G0 Z5.000", "G0 X900 Y10", "G0 X40 Y30", "G0 Z0.5", "G1 Z-1", "G1 X50 Y30",  // a rapid out of the window and back
  "G1 Z-1 F100", "G1 X40 Y40", "G0 X900 Y40", "G0 X40 Y40", "G1 X50 Y40",          // rapid out at depth and back to the same point
  "G0 Z5.000", "G0 X200 Y50", "G1 Z-1", "G1 X275 Y50", "G1 X300 Y50", "G1 X250 Y50",  // a cut ends right on the border, out and back in
  "M02", "G1 X60 Y30", "G1 X260 Y30", "G1 X290 Y30", "G1 X600 Y30",
  "G0 Z5.000", "M5", "M30",
];
programs.push({ name: "targeted", lines: targeted, prefix: "Werkzeug:", along: "x" });
// the first cut of a section after a tool group with G90/G17/G21 behind the tool comment
programs.push({ name: "targeted 2", lines: ["G21", "G90", "G0 Z5", "M6 T1", "(Werkzeug: A)", "G90", "G17", "G21", "M3 S1000", "G0 X10 Y10", "G1 Z-1 F100", "G1 X20 Y10", "G0 Z5", "M5", "M30"], prefix: "Werkzeug:", along: "x" });
for (const name of ["post-drawing", "post-drawing-table"]) programs.push({ name, lines: readFileSync(new URL(`./fixtures/${name}.gcode`, import.meta.url), "utf8").split("\n"), prefix: "tool: ", along: "x" });

const targetedOpts = (max: number): LongOpts[] => {
  const base: LongOpts = { axis: "x", bed: 300, start: 20, shift: 250, overlap: 5, pins: [{ x: 10, y: 20 }, { x: 10, y: 80 }], pinD: 6 };
  return [
    base,
    { ...base, shift: (max - 20) / 2 },                          // the last window ends exactly at the end of the cuts
    { ...base, bed: 20 + 250 + 2.5 },                            // window: only the overlap sticks out
    { ...base, bed: max - 500 + 20 },                            // the last section reaches just past the bed
    { ...base, pins: [{ x: 10, y: 20 }, { x: 10, y: 29 }] },     // pins 1.5 Ø apart
    { ...base, start: 4.9 },                                     // overlap reaches below 0
  ];
};
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

/** FNV-1a, 32 bit, over the characters (all ASCII here) */
const fnv = (t: string) => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193) >>> 0; return h; };
const oddLines = ["G0 X1", "G91 G0 X5", "G091 X1", "G0091", "G910", "G9.1", "XG91", "G 20", "G20.5", "G21", "G18", "G190", "G38.2 Z-1", "G380", "G43 H1", "G43.1 Z2", "G53 G0 Z0", "G5", "G59.1", "G540", "G68 R5",
  "G73 X1", "G80", "G81 X1", "G89", "G90", "G28", "G28.1", "G30", "G10 L2", "G100", "G92.1", "M3 A5", "B-1", "A.5", "XA1", " B+2", "TAB 1", "(G91) G0 X1", "G0 X1 ; G91", "G41 D1", "G42", "G 91", "1G91", "g91"];

test("long board: pinned result for Rust (longboard-cases.json.gz)", () => {
  const cases = [];
  for (const p of programs) {
    const bad = unsupported(p.lines), bounds = cutBounds(p.lines);
    assert.equal(bad, null, p.name);
    if (!bounds) continue;
    for (const [oi, o] of (p.name === "targeted" ? targetedOpts(bounds.x1) : optsFor(p.along, bounds)).entries()) for (const keepM6 of [false, true]) {
      if ((keepM6 && oi > 1) || (p.name.startsWith("random") && oi > 2)) continue;
      const min = o.axis === "x" ? bounds!.x0 : bounds!.y0, max = o.axis === "x" ? bounds!.x1 : bounds!.y1;
      const errs = checkLong(o, min, max), secs = errs.includes("shift") ? [] : sections(o, max);
      const parts = secs.map(s => splitProgram(p.lines, o.axis, s, 5, p.prefix, keepM6));
      const keep = o.pinD / 2 + 3 + 1, holes = o.pins.map(q => (o.axis === "x" ? { x: q.x + o.shift, y: q.y } : { x: q.x, y: q.y + o.shift }));
      const hits = parts.map(s => ({ pins: pinHits(s.trace, o.pins, keep), holes: pinHits(s.trace, holes, keep) }));
      const holeTool = tools[(oi + (keepM6 ? 1 : 0)) % tools.length];
      const job = { opts: o, min, max, safeZ: 5, toolPrefix: p.prefix, keepM6, keep, holes, holeTool, holeDepth: 18.5 };
      // the trace (every point of every cut) as length and hash: arcs make it long. Rounded to 6 decimals first: sine and
      // cosine may differ in the last bit between the window and Rust
      const r6 = (v: number) => v.toFixed(6);
      // random programs: the section lines as length and hash too (cuts across borders make thousands of them)
      const short = p.name.startsWith("random");
      const slim = parts.map(sp => ({ ...sp, lines: short ? { n: sp.lines.length, hash: fnv(sp.lines.join("\n")) } : sp.lines, trace: { n: sp.trace.length, hash: fnv(sp.trace.map(q => `${r6(q.x)},${r6(q.y)},${r6(q.z)}`).join(";")) } }));
      cases.push({ name: `${p.name} / options ${oi}${keepM6 ? " / M6 kept" : ""}`, program: p.name, job, want: { bad, bounds, errs, secs, parts: slim, hits, holeLines: holeLines(holes, o.pinD, 18.5, holeTool, 5) } });
    }
  }
  // there are cuts across borders, several sections, pin hits and errors among the cases
  assert.ok(cases.some(c => c.want.parts.length >= 3) && cases.some(c => c.want.parts.some(s => s.entries > 1)) && cases.some(c => c.want.parts.some(s => s.trace.n > 1000)));
  assert.ok(cases.some(c => c.want.errs.length) && cases.some(c => c.want.hits.some(h => h.pins.length || h.holes.length)));
  assert.equal(unsupported(["G0 X1", "G91 G0 X5"]), "G91");
  const odd = oddLines.map(l => ({ line: l, want: unsupported([l]) }));
  assert.ok(odd.some(o => o.want === null) && odd.some(o => o.want === "A/B"));
  const texts = Object.fromEntries(programs.map(p => [p.name, p.lines.join("\n")]));
  const text = JSON.stringify({ programs: texts, cases, odd }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
