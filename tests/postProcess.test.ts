// Post-Prozessoren (src/post) – läuft mit `npm test`
// Erwartete Zeilen sind von Hand aus den Handbüchern geschrieben (Quellen: Kopf von src/post/posts.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POSTS, postById, type PostDef } from "../src/post/posts.ts";
import { postProcess, fixed } from "../src/post/postProcess.ts";
import { samePath } from "../src/post/pathCompare.ts";
import { lintGcode } from "../src/gcodeLint.ts";
import { parseGcodeProgram } from "../src/sim/gcodeParser.ts";

const grbl = postById("grbl"), linuxcnc = postById("linuxcnc"), mach3 = postById("mach3"), mach4 = postById("mach4");

/** kleines Programm in der neutralen Form (so schreibt es cam.ts): zwei Werkzeuge, Bogen, Vollkreis, Rampe */
const small = (firstTool: boolean) => [
  "G21 (units mm)",
  "G90 (absolute positioning)",
  "G0 Z5.00 (safe height)",
  ...(firstTool ? ["M6 T2 (TOOL 1: Drill 3, diameter 3.0 mm)"] : []),
  "",
  "(tool: Drill 3, diameter 3.0 mm)",
  "M3 S12000 (spindle on, 12000 RPM)",
  "F300 (feed 300 mm/min)",
  "G0 Z5.00",
  "G0 X10.000 Y10.000",
  "G0 Z0.500",
  "G1 Z-3.000 F120",
  "G0 Z5.00",
  "",
  "G0 Z5.00",
  "M5 (spindle off)",
  "M6 T1 (TOOL 2: End mill 6, diameter 6.0 mm)",
  "",
  "(tool: End mill 6, diameter 6.0 mm)",
  "M3 S18000 (spindle on, 18000 RPM)",
  "G4 P2 (let the spindle spin up)",
  "F800 (feed 800 mm/min)",
  "G0 X20.000 Y20.000",
  "G1 Z-1.500 F200",
  "G1 F800",
  "G1 X40.000 Y20.000",
  "G3 X50.000 Y30.000 I0.000 J10.000",
  "G1 X50.000 Y40.000",
  "G2 X40.000 Y50.000 I-10.000 J0.000",
  "G1 X20.000 Y50.000",
  "G1 X20.000 Y20.000",
  "G0 Z5.00",
  "G0 X70.000 Y30.000",
  "G1 Z-1.000 F200",
  "G2 X70.000 Y30.000 I5.000 J0.000 F800",
  "",
  "G0 Z5.00",
  "M5 (spindle off)",
  "G0 X0 Y0 (park position)",
  "M30 (program end)",
  ""
].join("\n");

const opts = (inch: boolean, toolTable: boolean) => ({ inch, toolTable, info: ["CNC Craft test"], inchNote: "units inch" });
const post = (def: PostDef, inch: boolean, table = true, code = small(table && def.hasToolTable)) => {
  const r = postProcess(code, def, opts(inch, table));
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.gcode;
};
const code = (g: string) => g.split("\n").map(l => l.replace(/\([^)]*\)/g, "").trim()).filter(Boolean);

test("GRBL in mm: the program comes back unchanged, character for character", () => {
  for (const first of [false, true]) {
    const src = small(first);
    assert.equal(postProcess(src, grbl, opts(false, true)).gcode, src);
    assert.equal(postProcess(src, grbl, opts(false, false)).gcode, src);
  }
});

test("LinuxCNC, mm, tool table: start, tool changes and end as in the LinuxCNC documentation", () => {
  const c = code(post(linuxcnc, false));
  // % … %, preamble "G17 G20 G40 G49 G54 G80 G90 G94" with the unit of the file, G91.1, G64 P, first tool before any move
  assert.deepEqual(c.slice(0, 7), [
    "%",
    "G17 G21 G40 G49 G54 G80 G90 G94",
    "G91.1",
    "G64 P0.01",
    "T2 M6",
    "G43 H2",
    "G0 Z5.00",
  ]);
  // spindle: the program has no wait after the first start → 2 s are added (G4 P is seconds in LinuxCNC)
  assert.deepEqual(c.slice(7, 10), ["M3 S12000", "G4 P2", "F300"]);
  // tool change: T… M6, length from the tool table, then back to the height with the new length before anything else
  const i = c.indexOf("T1 M6");
  assert.deepEqual(c.slice(i - 2, i + 6), ["G0 Z5.00", "M5", "T1 M6", "G43 H1", "G0 Z5.00", "M3 S18000", "G4 P2", "F800"]);
  assert.deepEqual(c.slice(-4), ["M5", "G0 X0 Y0", "M2", "%"]);
  assert.ok(!c.includes("M30") && !c.includes("M0"));
  // one wait per spindle start, not two
  assert.equal(c.filter(l => /^G4 /.test(l)).length, 2);
});

test("LinuxCNC, inch: G20, four decimals, feed in inch per minute, path tolerance in inch", () => {
  const c = code(post(linuxcnc, true));
  assert.deepEqual(c.slice(0, 7), ["%", "G17 G20 G40 G49 G54 G80 G90 G94", "G91.1", "G64 P0.0004", "T2 M6", "G43 H2", "G0 Z0.1969"]);
  assert.ok(c.includes("F11.81"));          // 300 mm/min
  assert.ok(c.includes("G0 X0.3937 Y0.3937")); // 10 mm
  assert.ok(c.includes("G1 Z-0.1181 F4.72"));  // 3 mm, 120 mm/min
  assert.ok(c.includes("M3 S12000") && c.includes("M3 S18000")); // speeds stay
  assert.ok(c.includes("G4 P2"));              // seconds stay
  assert.ok(c.includes("G0 X0.0000 Y0.0000"));
  assert.ok(!c.some(l => /G21/.test(l)));
});

test("Mach3: no %, M30, G4 P in seconds", () => {
  const c = code(post(mach3, false));
  assert.deepEqual(c.slice(0, 5), ["G17 G21 G40 G49 G54 G80 G90 G94", "G91.1", "T2 M6", "G43 H2", "G0 Z5.00"]);
  assert.deepEqual(c.slice(-3), ["M5", "G0 X0 Y0", "M30"]);
  assert.ok(c.includes("G4 P2"));
  assert.ok(!c.includes("%") && !c.some(l => l.startsWith("G64")));
  assert.deepEqual(code(post(mach3, true)).slice(0, 2), ["G17 G20 G40 G49 G54 G80 G90 G94", "G91.1"]);
});

test("Mach4: safe start line of the guide, dwell with a decimal point (= seconds), M30 and %", () => {
  const c = code(post(mach4, false));
  assert.deepEqual(c.slice(0, 5), ["G0 G90 G17 G54 G40 G49 G80", "G21 G94 G91.1", "T2 M6", "G43 H2", "G0 Z5.00"]);
  assert.deepEqual(c.filter(l => /^G4 /.test(l)), ["G4 P2.0", "G4 P2.0"]);
  assert.deepEqual(c.slice(-2), ["M30", "%"]);
  assert.deepEqual(code(post(mach4, true)).slice(0, 2), ["G0 G90 G17 G54 G40 G49 G80", "G20 G94 G91.1"]);
});

test("without tool table: no T, M6, G43 or G49 anywhere – the tool change is a pause", () => {
  for (const def of [linuxcnc, mach3, mach4]) {
    for (const inch of [false, true]) {
      // also when the program carries tool numbers (setting „M6 T“ of CNC Craft's own sender)
      const g = post(def, inch, false, small(false));
      const c = code(g);
      assert.ok(!c.some(l => /\b(T\d|M6|G43|G49)\b/.test(l)), def.id);
      assert.equal(c.filter(l => l === "M0").length, 1, def.id);
      assert.ok(g.includes("M0 (TOOL 2: End mill 6, diameter 6.0 mm)"));
    }
  }
  assert.equal(code(post(linuxcnc, false, false))[1], "G17 G21 G40 G54 G80 G90 G94");
  assert.equal(code(post(mach4, false, false))[0], "G0 G90 G17 G54 G40 G80");
});

test("tool table: nothing moves before the first tool is loaded and its length is on", () => {
  for (const def of [linuxcnc, mach3, mach4]) {
    const c = code(post(def, true));
    const firstMove = c.findIndex(l => /[XYZ]-?\d/.test(l));
    const g43 = c.indexOf("G43 H2");
    assert.ok(g43 > 0 && g43 < firstMove, def.id);
    assert.equal(c[g43 - 1], "T2 M6");
  }
  // a program without a tool number cannot use the tool table
  assert.equal(postProcess(small(false), linuxcnc, opts(false, true)).error?.code, "noTool");
  assert.equal(postProcess(small(true).replace("M6 T2", "M6 T0"), mach3, opts(false, true)).error?.code, "noTool");
});

test("GRBL in inch: the program keeps its form, only unit and sizes change", () => {
  const g = post(grbl, true, false, small(false));
  const lines = g.split("\n");
  assert.equal(lines[0], "(CNC Craft test)");
  assert.equal(lines[1], "G20 (units inch)");
  assert.equal(lines[2], "G90 (absolute positioning)");
  assert.equal(lines[3], "G0 Z0.1969 (safe height)");
  assert.ok(g.includes("M6 T1 (TOOL 2: End mill 6, diameter 6.0 mm)")); // tool line untouched
  assert.ok(g.endsWith("M30 (program end)\n"));
  assert.equal(lines.length, small(false).split("\n").length + 1);
});

test("the posted file describes the same path – read back with the simulation's reader, mm and inch", () => {
  for (const def of POSTS) {
    for (const inch of [false, true]) {
      for (const table of [true, false]) {
        const src = small(table && def.hasToolTable);
        const g = post(def, inch, table, src);
        const chk = samePath(src, g, inch);
        assert.ok(chk.ok, `${def.id} inch=${inch} table=${table}: ${JSON.stringify(chk)}`);
        // mm: the same numbers; inch: rounding to 0.0001 inch = 0.0025 mm
        assert.ok(chk.maxDev < (inch ? 0.004 : 0.0015), `${def.id} ${inch}: ${chk.maxDev}`);
        // and the G-code check finds nothing in it (it reads G20 files)
        assert.deepEqual(lintGcode(g, { kind: "mill" }), [], def.id);
      }
    }
  }
});

test("the comparison notices a wrong file", () => {
  const src = small(false), g = post(grbl, true, false, src);
  assert.ok(samePath(src, g, true).ok);
  // forgotten unit: every size 25.4 times too small
  assert.equal(samePath(src, g.replace("G20", "G21"), true).why, "unit");
  assert.equal(samePath(src, g, false).why, "unit");
  // a feed left in mm/min in an inch file
  assert.equal(samePath(src, g.replace("F31.5", "F800"), true).why, "feed");
  // one move too short, a lost move, a rapid instead of a cut, an arc the other way round
  assert.equal(samePath(src, g.replace("G1 X1.5748 Y0.7874", "G1 X1.5700 Y0.7874"), true).why, "path");
  assert.equal(samePath(src, g.replace("G1 X1.9685 Y1.5748\n", ""), true).why, "path");
  assert.equal(samePath(src, g.replace("G1 X0.7874 Y1.9685", "G0 X0.7874 Y1.9685"), true).why, "path");
  assert.equal(samePath(src, g.replace("G3 X1.9685", "G2 X1.9685"), true).why, "path");
  assert.equal(samePath(src, g.replace("S18000", "S1800"), true).why, "speed");
  // a full circle that got lost
  assert.equal(samePath(src, g.replace(/G2 X2\.7559 Y1\.1811 I[^\n]*\n/, ""), true).why, "feed"); // its F went with it
  assert.equal(samePath(src, g.replace(/G2 X2\.7559 Y1\.1811 (I\S+ J\S+) F\S+/, "G1 F31.5"), true).why, "path");
});

test("the comparison follows a path that doubles back in very short moves (ramps, tight corners)", () => {
  const rows = ["G21", "G90", "G0 Z5.00", "M3 S10000", "G0 X10.000 Y10.000", "G1 Z0.000 F100"];
  // ramp: forward and back over the same 0.03 mm, a little deeper each time, then tiny zigzags
  for (let k = 1; k <= 40; k++) rows.push(`G1 X${(10 + (k % 2) * 0.03).toFixed(3)} Y10.000 Z${(-k * 0.01).toFixed(3)}`);
  for (let k = 0; k < 60; k++) rows.push(`G1 X${(10 + k * 0.004).toFixed(3)} Y${(10 + (k % 3) * 0.012).toFixed(3)}`);
  rows.push("G0 Z5.00", "M5", "M30", "");
  const src = rows.join("\n");
  for (const def of [grbl, linuxcnc]) {
    const g = post(def, true, false, src);
    const chk = samePath(src, g, true);
    assert.ok(chk.ok, JSON.stringify(chk));
    assert.ok(chk.maxDev < 0.004, String(chk.maxDev));
  }
});

test("arcs close after rounding: both radii agree far better than Mach3 asks for (0.0002 inch / 0.002 mm)", () => {
  // arcs with awkward numbers, many sizes and directions
  const rows = ["G21", "G90", "G0 Z5.00", "M3 S10000", "G0 X0.000 Y0.000", "G1 Z-1.000 F100"];
  let x = 0, y = 0, seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 400; k++) {
    const r = 0.3 + rnd() * 80, a0 = rnd() * Math.PI * 2, sweep = (0.02 + rnd() * 1.9) * Math.PI, ccw = rnd() > 0.5;
    const cx = x - r * Math.cos(a0), cy = y - r * Math.sin(a0);
    const a1 = a0 + (ccw ? sweep : -sweep);
    const ex = cx + r * Math.cos(a1), ey = cy + r * Math.sin(a1);
    // like cam.ts: end rounded to 3 decimals, I/J from the exact start
    rows.push(`${ccw ? "G3" : "G2"} X${ex.toFixed(3)} Y${ey.toFixed(3)} I${(cx - x).toFixed(3)} J${(cy - y).toFixed(3)}`);
    x = ex; y = ey;
  }
  rows.push("G0 Z5.00", "M5", "M30", "");
  const src = rows.join("\n");
  for (const def of [grbl, linuxcnc, mach3]) {
    for (const inch of [false, true]) {
      if (def === grbl && !inch) continue;
      const g = post(def, inch, false, src);
      let px = 0, py = 0, worst = 0, arcs = 0;
      for (const l of g.split("\n")) {
        const m = /^(G[0-3]) X(-?[\d.]+) Y(-?[\d.]+)(?: I(-?[\d.]+) J(-?[\d.]+))?/.exec(l);
        if (!m) continue;
        const ex = +m[2], ey = +m[3];
        if (m[4] !== undefined) {
          const ci = +m[4], cj = +m[5];
          worst = Math.max(worst, Math.abs(Math.hypot(ci, cj) - Math.hypot(px + ci - ex, py + cj - ey)));
          arcs++;
        }
        px = ex; py = ey;
      }
      assert.equal(arcs, 400);
      // a tenth of what Mach3 allows
      assert.ok(worst < (inch ? 0.00002 : 0.0002), `${def.id} inch=${inch}: ${worst}`);
      assert.ok(samePath(src, g, inch).ok, def.id);
    }
  }
});

test("an arc too short for the last decimal becomes a straight line, never a full circle", () => {
  const src = ["G21", "G90", "G0 Z5.00", "M3 S10000", "G0 X10.000 Y10.000", "G1 Z-1.000 F100",
    "G2 X10.001 Y10.000 I0.000 J-5.000",   // 0.001 mm long: start and end are the same in inches
    "X20.000 Y10.000 I5.000 J0.000",        // no G word: G2 still applies (half circle)
    "G0 Z5.00", "M5", "M30", ""].join("\n");
  const g = post(linuxcnc, true, false, src);
  const c = code(g);
  assert.ok(c.includes("G1 X0.3937 Y0.3937"));
  assert.ok(!c.some(l => /^G2 X0\.3937 Y0\.3937/.test(l)));
  // half circle from 0.3937 to 0.7874: the centre sits exactly in the middle (I = 0.19685), with one decimal more than X
  assert.ok(c.includes("G2 X0.7874 Y0.3937 I0.19685 J0.00000"), c.join("|"));
  assert.ok(samePath(src, g, true).ok);
  // a real full circle stays one
  const full = post(mach3, true, false, small(false));
  // (the centre stays where it was: 75 mm = 2.95276 inch, minus the rounded start 2.7559)
  assert.ok(full.includes("G2 X2.7559 Y1.1811 I0.19686 J0.00000 F31.5"));
});

test("what the post does not know stops the translation instead of being passed on", () => {
  const wrap = (l: string) => `G21\nG90\nG0 Z5.00\nM3 S1000\n${l}\nM5\nM30\n`;
  const err = (l: string, def = linuxcnc, inch = false) => postProcess(wrap(l), def, opts(inch, false)).error?.code;
  assert.equal(err("G0 X1 A90"), "rotary");
  assert.equal(err("G0 X1 A90", grbl, true), "rotary");     // GRBL would read the angle as inches
  assert.equal(err("G91"), "relative");
  assert.equal(err("G20"), "inchInput");
  assert.equal(err("G38.2 Z-10 F50"), "unknown");
  assert.equal(err("G43.1 Z2"), "unknown");
  assert.equal(err("G53 G0 Z0"), "unknown");
  assert.equal(err("M64 P2"), "unknown");
  assert.equal(err("G2 X5 Y5 R5"), "unknown");
  assert.equal(err("G1 X5 I2"), "arc");
  assert.equal(err("G1 X5 $H"), "unknown");
  assert.equal(postProcess("G21\nG90\nG0 Z5\n", linuxcnc, opts(false, false)).error?.code, "noEnd");
  assert.equal(postProcess("G21\nM30\nG0 X5\n", linuxcnc, opts(false, false)).error?.code, "afterEnd");
  const e = postProcess(wrap("G0 X1 A90"), mach3, opts(false, false)).error!;
  assert.equal(e.line, 5);
  assert.equal(e.text, "G0 X1 A90");
});

test("comments: no command comments by accident, semicolon style, line numbers – for posts people write themselves", () => {
  const src = "G21\nG90\n(MSG, hello)\nG0 Z5.00 (msg , x)\nM3 S1000\nG1 Z-1.000 F100 (cut)\nM5\nM30 (end)\n";
  const g = post(linuxcnc, false, false, src);
  assert.ok(g.includes("(- MSG, hello)") && g.includes("G0 Z5.00 (- msg , x)"));
  const own: PostDef = { ...mach3, id: "own", comment: "semicolon", lineNumbers: 10, start: ["{info}", "{units} G90"], end: ["M30"] };
  const o = post(own, false, false, src).split("\n");
  assert.deepEqual(o, [
    "; CNC Craft test",
    "N10 G21 G90",
    "; - MSG, hello",
    "N20 G0 Z5.00 ; - msg , x",
    "N30 M3 S1000",
    "N40 G4 P2",
    "N50 G1 Z-1.000 F100 ; cut",
    "N60 M5",
    "N70 M30 ; end",
    ""
  ]);
  assert.ok(samePath(src, o.join("\n"), false).ok);
  // Mach3 reads at most N99999
  const long = "G21\nG90\nM3 S1000\n" + "G1 X1.000 F100\nG1 X2.000\n".repeat(6000) + "M5\nM30\n";
  const nums = post({ ...own, lineNumbers: 10 }, false, false, long).split("\n").map(l => /^N(\d+)/.exec(l)).filter(Boolean).map(m => +m![1]);
  assert.ok(Math.max(...nums) <= 99999 && nums.length > 12000);
});

test("milliseconds for controllers that want them", () => {
  const ms: PostDef = { ...mach3, id: "ms", dwell: "ms" };
  const c = code(post(ms, false, false, small(false)));
  assert.deepEqual(c.filter(l => /^G4 /.test(l)), ["G4 P2000", "G4 P2000"]);
  assert.equal(fixed(-0.00001, 4), "0.0000");
});

test("G-code check: an inch file is checked like a millimetre file", () => {
  const rules = (c: string) => lintGcode(c, { kind: "mill", bedW: 100, bedH: 100 }).map(i => i.rule);
  // 0.5 inch deep without spindle, rapid sideways in the material, rapid into the material
  assert.deepEqual(rules("G20\nG90\nG1 Z-0.5 F10\nM30"), ["cut-spindle-off"]);
  assert.ok(rules("G20\nG90\nM3 S1000\nG1 Z-0.1 F10\nG0 X1\nM5\nM30").includes("rapid-in-material"));
  assert.ok(rules("G20\nG90\nG0 Z-0.1\nM30").includes("rapid-into-material"));
  // 5 inch = 127 mm: off a 100 mm bed; 3 inch = 76 mm is on it
  assert.ok(rules("G20\nG90\nG0 Z0.2\nG0 X5 Y1\nM30").includes("off-bed"));
  assert.deepEqual(rules("G20\nG90\nG0 Z0.2\nG0 X3 Y1\nM30"), []);
});

// ---- the test drawing: pocket, outline with tabs, drilled holes, a tool change, an arc ----
// Written by cam.ts in the running app (tests/fixtures/README.md says how). "-table" is the same job generated for a
// controller with a tool table (the first tool carries its number too).
for (const name of ["post-drawing", "post-drawing-table"]) {
  let src = "";
  try { src = readFileSync(new URL(`./fixtures/${name}.gcode`, import.meta.url), "utf8"); } catch { /* fixture missing */ }
  test(`test drawing (${name}): every post, mm and inch, gives the same path`, { skip: !src }, () => {
    const table = name.endsWith("-table");
    const n = parseGcodeProgram(src.split("\n"));
    assert.ok(n.n > 200 && n.cutLength > 500);
    assert.ok(/\nG[23] /.test(src), "has an arc");
    for (const def of POSTS) {
      if (table && !def.hasToolTable) continue;
      for (const inch of [false, true]) {
        const r = postProcess(src, def, opts(inch, table));
        assert.equal(r.error, undefined, `${def.id}: ${JSON.stringify(r.error)}`);
        if (def === grbl && !inch) { assert.equal(r.gcode, src); continue; }
        const chk = samePath(src, r.gcode, inch);
        assert.ok(chk.ok, `${def.id} inch=${inch}: ${JSON.stringify(chk)}`);
        assert.ok(chk.maxDev < 0.004, `${def.id} inch=${inch}: ${chk.maxDev}`);
        // the G-code check sees the same in the posted file as in the neutral program (nothing)
        assert.deepEqual(lintGcode(r.gcode, { kind: "mill" }).map(i => i.rule), lintGcode(src, { kind: "mill" }).map(i => i.rule), def.id);
        const p = parseGcodeProgram(r.gcode.split("\n"));
        assert.ok(Math.abs(p.cutLength - n.cutLength) < 0.5 && Math.abs(p.rapidLength - n.rapidLength) < 0.5, def.id);
        assert.ok(Math.abs(p.bounds.minZ - n.bounds.minZ) < 0.002 && Math.abs(p.bounds.maxX - n.bounds.maxX) < 0.002, def.id);
        if (def.rewrite) {
          const c = code(r.gcode);
          const tools = c.filter(l => /^T\d+ M6$/.test(l)).length;
          assert.equal(tools, table ? 2 : 0, def.id);
          assert.equal(c.filter(l => /^G43 H\d+$/.test(l)).length, tools, def.id);
          assert.equal(c.filter(l => l === "M0").length, table ? 0 : 1, def.id);
        }
      }
    }
  });
}

test("texts: every text the post-processor uses exists in all 7 languages, with the same placeholders", () => {
  const load = (l: string) => JSON.parse(readFileSync(new URL(`../src/i18n/lang/${l}.json`, import.meta.url), "utf8"));
  const en = load("en");
  const keys = Object.keys(en).filter(k => k.startsWith("post.") || k === "gc.toolLoad");
  // everything the code asks for is there: notes of the posts, error codes, file comments
  const used = ["gc.toolLoad", "post.label", "post.unit", "post.tools", "post.done", "post.verifyFail", "post.warnUntested", "post.warnInch",
    ...POSTS.flatMap(p => [...p.notes, ...p.fileNotes]),
    ...["rotary", "unknown", "relative", "inchInput", "noTool", "arc", "afterEnd", "noEnd"].map(c => "post.err." + c)];
  for (const k of used) assert.ok(keys.includes(k), k);
  const holes = (s: string) => (s.match(/\{\w+\}/g) || []).sort().join(",");
  for (const l of ["de", "fr", "es", "it", "nl", "pl"]) {
    const d = load(l);
    for (const k of keys) {
      assert.equal(typeof d[k], "string", `${l}: ${k}`);
      assert.equal(holes(d[k]), holes(en[k]), `${l}: ${k}`);
    }
  }
  // the untested warning is next to the choice for every controller that is not GRBL
  for (const p of POSTS) assert.equal(p.notes.includes("post.note.untested"), p.rewrite, p.id);
});
