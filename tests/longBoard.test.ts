import test from "node:test";
import assert from "node:assert/strict";
import { checkLong, cutBounds, holeLines, pinHits, sections, splitProgram, unsupported, type LongOpts } from "../src/longBoard.ts";
import { parseGcodeProgram } from "../src/sim/gcodeParser.ts";
import { lintGcode } from "../src/gcodeLint.ts";

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);
const O: LongOpts = { axis: "y", bed: 300, start: 20, shift: 250, overlap: 5, pins: [{ x: 20, y: 30 }, { x: 180, y: 30 }], pinD: 6 };

test("sections cover everything, overlap and fit the bed", () => {
  const s = sections(O, 700);
  assert.deepEqual(s.map(x => [x.n, x.lo, x.hi, x.shift]), [[1, -Infinity, 275, 0], [2, 265, 525, 250], [3, 515, Infinity, 500]]);
  assert.deepEqual(checkLong(O, 10, 700), []);
  assert.deepEqual(checkLong({ ...O, shift: 290 }, 10, 700), ["window", "holeOut"]);
  assert.deepEqual(checkLong(O, -3, 700), ["minOut"]);
  assert.ok(checkLong({ ...O, pins: [{ x: 1, y: 60 }, { x: 2, y: 60 }] }, 0, 700).includes("holeOut"));
  assert.ok(checkLong({ ...O, pins: [{ x: 1, y: 30 }, { x: 2, y: 30 }] }, 0, 700).includes("pinsSame"));
  assert.ok(checkLong({ ...O, shift: 5 }, 0, 700).includes("shift"));
});

const HEAD = ["G21 (mm)", "G90 (abs)", "G0 Z5.00 (safe)", "(Werkzeuge in diesem Programm: 2)", "(  1. Bohrer)", ""];
const T1 = ["(Werkzeug: Fraeser 6, Durchmesser 6.0 mm)", "M3 S12000 (Spindel)", "F1000 (Vorschub)"];
const T2 = ["G0 Z5.00", "M5 (aus)", "M0 (WERKZEUGWECHSEL 2: Fraeser 3)", "", "(Werkzeug: Fraeser 3, Durchmesser 3.0 mm)", "M3 S18000", "G4 P2", "F800"];
const rect = (x0: number, y0: number, x1: number, y1: number, zs: number[]) => ["(--- Form ---)", "G0 Z5.00", `G0 X${x0} Y${y0}`, ...zs.flatMap(z => [`G1 Z${z} F300`, `G1 X${x1} Y${y0} F1000`, `G1 X${x1} Y${y1}`, `G1 X${x0} Y${y1}`, `G1 X${x0} Y${y0}`]), "G0 Z5.00"];
const END = ["M5 (aus)", "G0 X0 Y0 (park)", "M30 (Ende)"];

/** Alle Schnittpunkte (dicht) aus einem Programm */
function cuts(lines: string[]): { x: number; y: number; z: number }[] {
  const p = parseGcodeProgram(lines), out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < p.n; i++) {
    if (p.type[i] !== 0 && p.z1[i] >= 0 && p.z0[i] >= 0) continue;
    if (Math.min(p.z0[i], p.z1[i]) >= 0) continue;
    const L = Math.hypot(p.x1[i] - p.x0[i], p.y1[i] - p.y0[i]), n = Math.max(1, Math.ceil(L / 2));
    for (let k = 0; k <= n; k++) out.push({ x: p.x0[i] + (p.x1[i] - p.x0[i]) * k / n, y: p.y0[i] + (p.y1[i] - p.y0[i]) * k / n, z: p.z0[i] + (p.z1[i] - p.z0[i]) * k / n });
  }
  return out;
}
const wrap = (l: string[]) => ["G21", "G90", "G17", "G0 Z5.000", ...l, "M5", "G0 X0 Y0", "M30"];

test("every cut of the whole program is done by a section at the right place and depth, nothing else is cut", () => {
  const arc = ["G0 X120 Y400", "G1 Z-2 F300", "G3 X120 Y400 I0 J-140 F1000", "G2 X180 Y340 Z-4 I0 J-60", "G0 Z5.00"];
  const prog = [...HEAD, ...T1, ...rect(50, 60, 150, 640, [-2, -4, -6]), ...arc, ...T2, ...rect(70, 280, 130, 300, [-3]), ...END];
  const all = cuts(prog);
  for (const axis of ["y"] as const) {
    const b = cutBounds(prog)!, secs = sections({ ...O, axis }, b.y1);
    assert.equal(secs.length, 3);
    const done: { x: number; y: number; z: number }[] = [];
    for (const s of secs) {
      const r = splitProgram(prog, axis, s, 5);
      assert.deepEqual(lintGcode(wrap(r.lines).join("\n"), { kind: "mill" }), [], `section ${s.n}`);
      for (const c of cuts(wrap(r.lines))) {
        assert.ok(c.y >= 0 - 1e-6 && c.y <= O.bed + 1e-6, `section ${s.n} leaves the bed: ${c.y}`);
        done.push({ x: c.x, y: c.y + s.shift, z: c.z });
      }
    }
    // jeder Punkt des Ganzen ist geschnitten …
    const grid = new Map<string, number[]>();
    done.forEach((p, i) => { const k = `${Math.round(p.x / 3)},${Math.round(p.y / 3)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); });
    const close = (p: { x: number; y: number; z: number }, list: { x: number; y: number; z: number }[], g: Map<string, number[]>) => { const cx = Math.round(p.x / 3), cy = Math.round(p.y / 3); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of g.get(`${cx + i},${cy + j}`) ?? []) if (Math.hypot(list[q].x - p.x, list[q].y - p.y) < 2.2 && Math.abs(list[q].z - p.z) < 0.4) return true; return false; };
    for (const p of all) if (p.z < -0.5) assert.ok(close(p, done, grid), `missing ${JSON.stringify(p)}`);
    // … und nichts anderes
    const ga = new Map<string, number[]>();
    all.forEach((p, i) => { const k = `${Math.round(p.x / 3)},${Math.round(p.y / 3)}`; (ga.get(k) ?? ga.set(k, []).get(k)!).push(i); });
    for (const p of done) if (p.z < -0.5) assert.ok([...ga.keys()].length && (() => { const cx = Math.round(p.x / 3), cy = Math.round(p.y / 3); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of ga.get(`${cx + i},${cy + j}`) ?? []) if (Math.hypot(all[q].x - p.x, all[q].y - p.y) < 2.2 && all[q].z <= p.z + 0.4) return true; return false; })(), `extra ${JSON.stringify(p)}`);
  }
});

test("tools: only what a section needs, the first one without a change, spindle always on before cutting", () => {
  const prog = [...HEAD, ...T1, ...rect(50, 60, 150, 100, [-2]), ...T2, ...rect(50, 560, 150, 600, [-3]), ...END];
  const [a, b, c] = sections(O, 600).concat(sections(O, 600).length < 3 ? [{ n: 3, lo: 0, hi: 0, shift: 0 }] : []).map(s => splitProgram(prog, "y", s, 5));
  assert.equal(a.firstTool, "Werkzeug: Fraeser 6, Durchmesser 6.0 mm");
  assert.ok(a.lines.some(l => l.startsWith("M3 S12000")) && !a.lines.some(l => /M0|S18000/.test(l)));
  assert.equal(b.cuts, 0);
  assert.equal(c.firstTool, "Werkzeug: Fraeser 3, Durchmesser 3.0 mm");
  assert.ok(c.lines.some(l => l.startsWith("M3 S18000")) && !c.lines.some(l => /^M0|S12000/.test(l)));
  // beide Werkzeuge im selben Abschnitt: der Wechsel bleibt
  const both = splitProgram([...HEAD, ...T1, ...rect(50, 60, 150, 100, [-2]), ...T2, ...rect(50, 120, 150, 140, [-3]), ...END], "y", sections(O, 600)[0], 5);
  assert.equal(both.lines.filter(l => /^M0/.test(l)).length, 1);
  const iM0 = both.lines.findIndex(l => /^M0/.test(l)), iM3 = both.lines.findIndex(l => /^M3 S18000/.test(l));
  assert.ok(both.lines.slice(0, iM0).some(l => /^M5/.test(l)) && iM3 > iM0);
});

test("whole programs inside one window stay as they are (shifted), drilling keeps its pecks", () => {
  const drill = ["G0 Z5.00", "G0 X100.000 Y120.000", "G0 Z0.50", "G1 Z-2.000 F200", "G0 Z0.50", "G0 Z-1.700", "G1 Z-4.000 F200", "G0 Z5.00"];
  const r = splitProgram([...HEAD, ...T1, ...drill, ...END], "y", sections(O, 130)[0], 5);
  assert.deepEqual(r.lines.filter(l => /^G1 Z/.test(l)).map(l => /Z(-[\d.]+)/.exec(l)![1]), ["-2.000", "-4.000"]);
  assert.deepEqual(lintGcode(wrap(r.lines).join("\n"), { kind: "mill" }), []);
  const s = { n: 2, lo: 265, hi: 525, shift: 250 };
  const m = splitProgram([...HEAD, ...T1, ...rect(10, 300, 40, 330, [-2]), ...END], "y", s, 5);
  assert.ok(m.lines.includes("G0 X10.000 Y50.000")); assert.ok(m.lines.some(l => /^G1 X40\.000/.test(l))); assert.equal(m.entries, 0 + m.entries);
  near(m.box!.min, 50); near(m.box!.max, 80);
  // andere Achse
  const x = splitProgram([...HEAD, ...T1, ...rect(300, 10, 330, 40, [-2]), ...END], "x", s, 5);
  assert.ok(x.lines.includes("G0 X50.000 Y10.000"));
});

test("pins: cuts that come too close are found; holes are drilled or milled round", () => {
  assert.deepEqual(pinHits([{ x: 0, y: 0, z: -1 }, { x: 100, y: 0, z: -1 }], [{ x: 50, y: 4 }, { x: 50, y: 30 }], 6), [0]);
  assert.deepEqual(pinHits([{ x: 0, y: 0, z: 5 }, { x: 100, y: 0, z: 5 }], [{ x: 50, y: 0 }], 6), []);
  const d = holeLines([{ x: 10, y: 20 }], 6, 5, { drill: true, diameter: 6, feed: 800, plunge: 200, stepZ: 2 }, 5);
  assert.deepEqual(d.filter(l => /^G1/.test(l)), ["G1 Z-2.000 F200", "G1 Z-4.000 F200", "G1 Z-5.000 F200"]);
  const m = holeLines([{ x: 10, y: 20 }], 6, 5, { drill: false, diameter: 3, feed: 800, plunge: 200, stepZ: 1 }, 5);
  assert.ok(m.some(l => /^G3 X11\.500 Y20\.000 Z-5\.000 I-1\.500/.test(l)));
  for (const l of [d, m]) assert.deepEqual(lintGcode(wrap(["M3 S12000", ...l]).join("\n"), { kind: "mill" }), []);
});

test("programs with commands the splitter can't follow are refused", () => {
  assert.equal(unsupported(["G21", "G90", "G0 X1", "G2 X1 Y1 I1 J0"]), null);
  for (const [l, want] of [["G91", "G91"], ["G55", "G55"], ["G20", "G20"], ["G81 X1 Y1 Z-1 R1", "G81"], ["G1 A90", "A/B"], ["G92 X0", "G92"]] as const) assert.equal(unsupported([l]), want);
});

test("arcs keep the trace in pairs, so a distant pin is never reported and a near one always is", () => {
  const lines = ["G90", "(Werkzeug: Fraeser 6, Durchmesser 6.0 mm)", "M3 S12000", "G0 Z5", "G0 X20 Y50", "G1 Z-2 F300", "G2 X40 Y50 I10 J0 F900", "G0 Z5", "G0 X20 Y200", "G1 Z-2 F300", "G1 X40 Y200 F900", "G0 Z5"];
  const p = splitProgram(lines, "y", { n: 1, lo: -Infinity, hi: Infinity, shift: 0 }, 5);
  assert.equal(p.trace.length % 2, 0);
  assert.deepEqual(pinHits(p.trace, [{ x: 30, y: 130 }], 8), []);   // zwischen den Teilen: dort wird nur gefahren
  assert.deepEqual(pinHits(p.trace, [{ x: 30, y: 66 }], 8), [0]);   // Bogenscheitel (30|60) ist 6 mm entfernt
  assert.deepEqual(pinHits(p.trace, [{ x: 30, y: 202 }], 8), [0]);
});

test("controllers with a tool table: the first tool of a section keeps its M6, others drop it", () => {
  const lines = ["G90", "M6 T7 (WERKZEUG 1: Fraeser 6)", "", "(Werkzeug: Fraeser 6, Durchmesser 6.0 mm)", "M3 S12000", "G0 Z5", "G0 X20 Y50", "G1 Z-2 F300", "G1 X40 Y50 F900", "G0 Z5"];
  const sec = { n: 1, lo: -Infinity, hi: Infinity, shift: 0 };
  const a = splitProgram(lines, "y", sec, 5, "Werkzeug:", true).lines, b = splitProgram(lines, "y", sec, 5).lines;
  assert.ok(a.findIndex(l => /^M6 T7/.test(l)) >= 0 && a.findIndex(l => /^M6 T7/.test(l)) < a.findIndex(l => /^M3/.test(l)));
  assert.ok(!a.some(l => /^G90/.test(l)));
  assert.ok(!b.some(l => /^M6/.test(l)));
});
