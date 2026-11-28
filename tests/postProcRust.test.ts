// Post-processor: TypeScript (postProcess in src/post/postProcess.ts) and Rust (src-tauri/src/postproc.rs) must write
// the same file, character for character, or stop with the same error. This test runs many neutral programs through
// every post (and a few made-up ones) in mm and inch, with and without tool table, and pins the result in
// fixtures/postproc-cases.json.gz; `cargo test postproc` compares. The second test reads every translated file back with
// samePath (src/post/pathCompare.ts, Rust: pathcheck.rs), plus files spoilt on purpose → postcheck-cases.json.gz.
// After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test postproc pathcheck
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { POSTS, postById, type PostDef } from "../src/post/posts.ts";
import { postProcess, type PostOptions, type PostResult } from "../src/post/postProcess.ts";
import { samePath } from "../src/post/pathCompare.ts";

const file = new URL("./fixtures/postproc-cases.json.gz", import.meta.url);
const checkFile = new URL("./fixtures/postcheck-cases.json.gz", import.meta.url);
const programs: Record<string, string> = {};
const big = new Set<string>();
const prog = (name: string, text: string, isBig = false) => { programs[name] = text; if (isBig) big.add(name); };

// ---- programs as cam.ts writes them ----
const small = (firstTool: boolean) => [
  "G21 (units mm)", "G90 (absolute positioning)", "G0 Z5.00 (safe height)",
  ...(firstTool ? ["M6 T2 (TOOL 1: Drill 3, diameter 3.0 mm)"] : []),
  "", "(tool: Drill 3, diameter 3.0 mm)", "M3 S12000 (spindle on, 12000 RPM)", "F300 (feed 300 mm/min)",
  "G0 Z5.00", "G0 X10.000 Y10.000", "G0 Z0.500", "G1 Z-3.000 F120", "G0 Z5.00", "", "G0 Z5.00", "M5 (spindle off)",
  "M6 T1 (TOOL 2: End mill 6, diameter 6.0 mm)", "", "(tool: End mill 6, diameter 6.0 mm)", "M3 S18000 (spindle on, 18000 RPM)",
  "G4 P2 (let the spindle spin up)", "F800 (feed 800 mm/min)", "G0 X20.000 Y20.000", "G1 Z-1.500 F200", "G1 F800",
  "G1 X40.000 Y20.000", "G3 X50.000 Y30.000 I0.000 J10.000", "G1 X50.000 Y40.000", "G2 X40.000 Y50.000 I-10.000 J0.000",
  "G1 X20.000 Y50.000", "G1 X20.000 Y20.000", "G0 Z5.00", "G0 X70.000 Y30.000", "G1 Z-1.000 F200",
  "G2 X70.000 Y30.000 I5.000 J0.000 F800", "", "G0 Z5.00", "M5 (spindle off)", "G0 X0 Y0 (park position)", "M30 (program end)", ""
].join("\n");
prog("small", small(false));
prog("small, first tool numbered", small(true));
prog("small, CRLF", small(true).replace(/\n/g, "\r\n"));
for (const name of ["post-drawing", "post-drawing-table"]) prog(name, readFileSync(new URL(`./fixtures/${name}.gcode`, import.meta.url), "utf8"), true);

let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
{
  const rows = ["G21", "G90", "G0 Z5.00", "M3 S10000", "G0 X10.000 Y10.000", "G1 Z0.000 F100"];
  for (let k = 1; k <= 40; k++) rows.push(`G1 X${(10 + (k % 2) * 0.03).toFixed(3)} Y10.000 Z${(-k * 0.01).toFixed(3)}`);
  for (let k = 0; k < 60; k++) rows.push(`G1 X${(10 + k * 0.004).toFixed(3)} Y${(10 + (k % 3) * 0.012).toFixed(3)}`);
  rows.push("G0 Z5.00", "M5", "M30", "");
  prog("ramp and tiny zigzags", rows.join("\n"), true);
}
let ax = 0, ay = 0;
const arcRows = (n: number, rMin: number, rMax: number, sweepMin: number, sweepMax: number) => {
  const rows: string[] = [];
  for (let k = 0; k < n; k++) {
    const r = rMin + rnd() * (rMax - rMin), a0 = rnd() * Math.PI * 2, sweep = (sweepMin + rnd() * (sweepMax - sweepMin)) * Math.PI, ccw = rnd() > 0.5;
    const cx = ax - r * Math.cos(a0), cy = ay - r * Math.sin(a0);
    const a1 = a0 + (ccw ? sweep : -sweep);
    const ex = cx + r * Math.cos(a1), ey = cy + r * Math.sin(a1);
    rows.push(`${ccw ? "G3" : "G2"} X${ex.toFixed(3)} Y${ey.toFixed(3)} I${(cx - ax).toFixed(3)} J${(cy - ay).toFixed(3)}`);
    ax = ex; ay = ey;
  }
  return rows;
};
const arcProgram = (rows: string[]) => ["G21", "G90", "G0 Z5.00", "M3 S10000", "G0 X0.000 Y0.000", "G1 Z-1.000 F100", ...rows, "G0 Z5.00", "M5", "M30", ""].join("\n");
ax = ay = 0;
prog("400 arcs", arcProgram(arcRows(400, 0.3, 80, 0.02, 1.9)), true);
// chords of a few thousandths: in inches start and end can fall together (straight line or full circle)
ax = ay = 0;
prog("tiny arcs", arcProgram([...arcRows(150, 0.002, 0.6, 0.001, 0.02), ...arcRows(60, 0.0005, 0.003, 1.9, 1.99999), ...arcRows(60, 0.0003, 0.001, 0.5, 0.99)]), true);
prog("arc too short, then half circle without G", ["G21", "G90", "G0 Z5.00", "M3 S10000", "G0 X10.000 Y10.000", "G1 Z-1.000 F100",
  "G2 X10.001 Y10.000 I0.000 J-5.000", "X20.000 Y10.000 I5.000 J0.000", "G0 Z5.00", "M5", "M30", ""].join("\n"));
prog("comments", "G21\nG90\n(MSG, hello)\nG0 Z5.00 (msg , x)\nM3 S1000\nG1 Z-1.000 F100 (cut)\nM5\nM30 (end)\n");
prog("long (line numbers wrap)", "G21\nG90\nM3 S1000\n" + "G1 X1.000 F100\nG1 X2.000\n".repeat(5200) + "M5\nM30\n", true);

// ---- hand-written oddities: everything the reader accepts, in unusual spellings ----
prog("lower case, spaces, signs", "g21\ng90\ng0 z5\nm3 s1000\ng1 x 1.5 y-.5 z+.25 f 100\nx2\ny3.\ng2 x4 y3 i1 j0\nG03X2Y3I-1J0\nm5\nm30\n");
prog("unicode spaces and comments", "G21\nG90\nG0 Z5\nM3 S1000\nG1 X　1.5 F100\t(Ümlaut ✓ – Zoll)\n \nG1 Y2 ; tail é\nM5\nM30\n");
prog("semicolon comments", "G21 ; units\nG90\n; only a comment\n;\nG0 Z5 ; a (b)\nM3 S100 (x) ; y\nG1 X1 F50 ;   \nM5\nM30 ; end\n\n\n");
prog("active comments", "G21\nG90\n(MSG,x)\n( debug , y)\n(LOGOPEN,f)\n(LOGX, no)\n(msgs, no)\n(  PyRun ,z)\nG0 Z5 (abort,now)\nM3 S1\nM5\nM30\n");
prog("dwells", "G21\nG90\nG0 Z5\nM3 S1000\nG4 P0.5\nM4 S500\nG4 P.25\nM3 S10\nG4 P2. (two)\nG4 P0\nG4 P0.0015\nG4 P1.23456\nM5\nM30\n");
prog("spin-up before the end and after comments", "G21\nG90\nG0 Z5\nM3 S1000\n\n(c)\nG1 Z-1 F10\nM3 S2000 M8\n\nM30\n");
prog("full circle without axis words", "G21\nG90\nG0 Z5\nM3 S1000\nG0 X10 Y10\nG1 Z-1 F100\nG2 I5 J0\nG3 J-2.5\nG2 I0.0001 J0\nM5\nM30\n");
prog("double words", "G21\nG90\nG0 Z5\nM3 S1000\nG0 X1 X2 Y1\nG1 Z1 Z-2 F10 F20\nG2 X5 Y5 I1 I2 J3\nG2 X6 Y6 J3\nG0 G2 X8 Y5 I1 J1\nM5\nM30\n");
prog("modal and setup words", "G21\nG90\nG17 G94 G40 G80 G54\nG0 Z5\nM3 S1000 M7\nG55 X0 Y0\nX10\nY10 Z-1\nG1 X20 F100 S1200\nM9 M5\nM0\nM1\nG59\nM2\n");
prog("feeds and zeros for inch", "G21\nG90\nG0 Z5\nM3 S1000\nG1 X-0.000 Y-0.0001 F0.1\nG1 X0 F0\nG1 X25.4 F25.4\nG1 X99999.999 F2540\nG1 Y-123.4567 F123456\nG1 Z-0.00001 F1.27\nM5\nM30\n");
prog("tool changes with heights", "G21\nG90\nM6 T4 (first)\nG0 Z12.5\nM3 S1000\nG1 Z-1 F100\nG0 Z7.25\nM5\nM6 T7 (second)\nM3 S2000\nG1 Z-2\nM5\nM6 T9\nM30\n");
prog("M4 before the first tool", "G21\nG90\nG0 Z5\nM4 S100\nM6 T1\nG1 Z-1 F10\nM5\nM30\n");
prog("short moves", "G21\nG90\nG0 Z5\nM3 S1000\nG0 X0 Y0\nG1 Z-1 F100\nG1 X0.5\nG1 X1 Y0.3\nG1 X1 Y0.3\nG0 Z5\nG0 X0.4\nG1 Z-0.5\nM5\nM30\n");
prog("tool change before any Z", "G21\nG90\nM6 T3 (a)\nM6 T5 (b)\nG0 Z5\nM3 S1\nM5\nM30\n");
prog("blank and spaces only", "G21\nG90\n   \t  \n\nG0 Z5\nM3 S1\nM5\nM30\n\n   \n");
prog("M2 end, then empty lines", "G21\nG90\nG0 Z5\nM3 S1\nM5\nM2\n\n\n");
prog("only the end", "M30\n");
prog("no newline at the end", "G21\nG90\nG0 Z5\nM30");

// ---- programs that must stop, with the line and text ----
const wrap = (l: string) => `G21\nG90\nG0 Z5.00\nM3 S1000\n${l}\nM5\nM30\n`;
const bad: Record<string, string> = {
  rotary: "G0 X1 A90", rotaryW: "G1 W2", relative: "G91", inchInput: "G20", probe: "G38.2 Z-10 F50", toolLength: "G43.1 Z2",
  machine: "G53 G0 Z0", output: "M64 P2", radius: "G2 X5 Y5 R5", ijOnLine: "G1 X5 I2", dollar: "G1 X5 $H", percent: "%",
  lineNo: "N10 G1 X1", dwellNeg: "G4 P-1", dwellMore: "G4 P2 X1", dwellNone: "G4", dwellExp: "G4 P1e3", pWord: "G1 X1 P3",
  tWord: "G0 X1 T2", openParen: "G0 X1 (open", nested: "G0 X1 ((a)b)", endWords: "M30 X1", toolExtra: "M6 T1 S5",
  toolHalf: "M6 T1.5", toolNone: "M6", toolZero: "M6 T0", g28: "G28", motionFirst: "X5",
  parenSplitsNumber: "G1 X1(c)5", unitWithOthers: "G21 G90", long: "G38.2 (" + "a".repeat(90) + ")", longUnicode: "G38.2 (" + "é".repeat(90) + ")"
};
for (const [k, l] of Object.entries(bad)) prog("error: " + k, wrap(l));
prog("error: arc before any position", "G21\nG90\nG0 Z5\nM3 S1\nG2 I5 J0\nM5\nM30\n");
prog("error: move before any motion", "G21\nG90\nX5\nM30\n");
prog("error: no end", "G21\nG90\nG0 Z5\n");
prog("error: words after the end", "G21\nM30\nG0 X5\n");
prog("error: comment after the end", "G21\nM30\n\n(late)\n");
prog("error: empty", "");

// ---- posts: the real ones and made-up ones that use every field ----
const [grbl, linuxcnc, mach3, mach4] = ["grbl", "linuxcnc", "mach3", "mach4"].map(postById);
const defs: Record<string, PostDef> = { grbl, linuxcnc, mach3, mach4 };
defs["semicolon, N10"] = { ...mach3, id: "own1", comment: "semicolon", lineNumbers: 10, start: ["{info}", "{units} G90"], end: ["M30"] };
defs["ms, odd start, N7"] = { ...linuxcnc, id: "own2", dwell: "ms", spinUp: 1.5, end: null, blend: 0.0254, lineNumbers: 7,
  start: ["%", "{info}", "  G17\t{units}   {g49} G64 P{blend}  ", "", "{info}", "{g49}"] };
defs["no tool table template"] = { ...mach4, id: "own3", toolTable: null, toolPause: ["M5", "M0", "G0 Z{z}"] };
defs["pause with height, s."] = { ...mach3, id: "own4", hasToolTable: false, toolTable: ["T{t} M6"], toolPause: ["(pause {t})", "M0", "G0 Z{z}", "G0 Z{z} (again {t})"],
  spinUp: 0, dwell: "s.", comment: "semicolon", lineNumbers: 5, blend: 0.1, start: ["{blend}", "G64 P{blend}", "{units}"] };
defs["N wraps fast, keeps end"] = { ...linuxcnc, id: "own5", lineNumbers: 33333, end: null, spinUp: 0.25, dwell: "s.", blend: 1 };
defs["grbl rewritten"] = { ...grbl, id: "own6", rewrite: true, spinUp: 3 };

const optSets: PostOptions[] = [];
for (const inch of [false, true]) for (const toolTable of [false, true]) optSets.push({ inch, toolTable, info: ["CNC Craft test", "MSG, look"], inchNote: "units inch" });
optSets.push({ inch: true, toolTable: false }, { inch: false, toolTable: true, info: [], inchNote: "" }, { inch: true, toolTable: true, info: ["x"], inchNote: "" });

const cases: { p: string; d: string; o: number; want: PostResult }[] = [];
for (const p of Object.keys(programs)) {
  for (const d of Object.keys(defs)) {
    // long programs and errors: fewer combinations (an error hardly depends on the post)
    const few = big.has(p) || p.startsWith("error: ");
    if (few && !(d in (p.startsWith("error: ") ? { grbl: 1, linuxcnc: 1, "semicolon, N10": 1 } : { grbl: 1, linuxcnc: 1, mach3: 1, mach4: 1, "semicolon, N10": 1 }))) continue;
    for (let o = 0; o < optSets.length; o++) {
      if (few && o >= 4) continue;
      cases.push({ p, d, o, want: postProcess(programs[p], defs[d], optSets[o]) });
    }
  }
}

test("post-processor: pinned result for Rust (postproc-cases.json.gz)", () => {
  assert.equal(POSTS.length, 4, "a new post: add it here");
  // every kind of error shows up, and most programs go through
  const codes = new Set(cases.map(c => c.want.error?.code ?? "ok"));
  assert.deepEqual([...codes].sort(), ["afterEnd", "arc", "inchInput", "noEnd", "noTool", "ok", "relative", "rotary", "unknown"]);
  const ok = cases.filter(c => !c.want.error).length;
  assert.ok(ok > cases.length / 2, `${ok} of ${cases.length}`);
  const text = JSON.stringify({ programs, defs, opts: optSets, cases }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});

test("same path: pinned result for Rust (postcheck-cases.json.gz)", () => {
  // every file of the cases above read back (Rust posts it again from postproc-cases.json.gz)
  const checks = cases.flatMap((c, i) => c.want.error ? [] : [{ c: i, want: samePath(programs[c.p], c.want.gcode, optSets[c.o].inch) }]);
  // the odd hand-written programs (a word twice, feed 0 in inches, no unit) are refused here – that is what the check is for
  const refused = new Set(checks.filter(k => !k.want.ok).map(k => cases[k.c].p));
  assert.deepEqual([...refused].sort(), ["double words", "error: empty", "feeds and zeros for inch", "only the end"]);
  assert.ok(checks.filter(k => k.want.ok).length > 1000);
  // files spoilt on purpose: each must be noticed (or, for tiny changes, pass with the right distance)
  const wrong: { p: string; posted: string; inch: boolean; tol: number; want: unknown }[] = [];
  const spoil: [string, (g: string) => string][] = [
    ["unit G20→G21", g => g.replace("G20", "G21")],
    ["unit G21→G20", g => g.replace("G21", "G20")],
    ["unit gone", g => g.replace(/G2[01]/g, "")],
    ["feed changed", g => g.replace(/F(\d+(?:\.\d+)?)/, (_m, v) => "F" + (+v * 1.5).toFixed(2))],
    ["feed a little off", g => g.replace(/F(\d+(?:\.\d+)?)/, (_m, v) => "F" + (+v + 0.1).toFixed(2))],
    ["feed lost", g => g.replace(/ F\d+(?:\.\d+)?/, "")],
    ["extra feed", g => g.replace(/\nM5/, "\nG1 F77\nM5")],
    ["speed changed", g => g.replace(/S(\d+)/, (_m, v) => "S" + (+v + 1))],
    ["speed lost", g => g.replace(/ S\d+/, "")],
    ["rapid instead of cut", g => g.replace(/\nG1 X/, "\nG0 X")],
    ["arc the other way", g => g.replace(/\nG3 /, "\nG2 ")],
    ["a move lost", g => { const l = g.split("\n"); const k = l.findIndex((x, i) => i > l.length / 2 && /^(N\d+ )?G1 X/.test(x)); if (k >= 0) l.splice(k, 1); return l.join("\n"); }],
    ["a move added", g => g.replace(/\nM5/, "\nG1 X1.5 Y1.5\nM5")],
    ["last digit changed", g => g.replace(/(\nG1 X-?\d+\.\d*)(\d)/, (_m, a, d) => a + ((+d + 1) % 10))],
    ["Z shifted", g => g.replace(/Z-(\d)/, (_m, d) => "Z-" + ((+d + 1) % 10))],
    ["comments removed", g => g.replace(/\([^)]*\)/g, "")],
    ["comment inside a feed", g => g.replace(/F(\d)(\d+)/, "F$1(x)$2")],
    ["line doubled", g => g.replace(/\n((?:N\d+ )?G1 X[^\n]*)\n/, "\n$1\n$1\n")],
    ["empty", () => ""],
  ];
  const picks = ["small", "small, first tool numbered", "small, CRLF", "arc too short, then half circle without G", "comments", "lower case, spaces, signs",
    "dwells", "modal and setup words", "short moves", "feeds and zeros for inch", "tool changes with heights", "400 arcs", "ramp and tiny zigzags"];
  for (const p of picks) {
    for (const d of ["grbl", "linuxcnc", "mach4", "semicolon, N10"]) {
      for (const o of [0, 2, 4]) {
        const r = postProcess(programs[p], defs[d], optSets[o]);
        if (r.error) continue;
        const inch = optSets[o].inch;
        for (const [, f] of spoil) wrong.push({ p, posted: f(r.gcode), inch, tol: 0.02, want: undefined });
        // the right file with a much smaller tolerance, and against the other unit
        wrong.push({ p, posted: r.gcode, inch, tol: 0.0005, want: undefined }, { p, posted: r.gcode, inch: !inch, tol: 0.02, want: undefined });
      }
    }
  }
  for (const w of wrong) w.want = samePath(programs[w.p], w.posted, w.inch, w.tol);
  const whys = new Set(wrong.map(w => (w.want as { why: string }).why));
  assert.deepEqual([...whys].sort(), ["", "feed", "path", "speed", "unit"]);
  const text = JSON.stringify({ checks, wrong }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(checkFile, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(checkFile)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
