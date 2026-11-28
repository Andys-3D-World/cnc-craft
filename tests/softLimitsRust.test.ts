// Machine limits before the job start: TypeScript (src/softLimits.ts) and Rust (src-tauri/src/softlimits.rs) must find
// the same extents, notes and over-travel. This test runs many jobs (real CNC Craft G-code, arcs in all planes, R arcs,
// inches, relative moves, G53, offsets, probing, cycles, tool changes) against several machine states and pins the
// result in fixtures/softlimits-cases.json.gz; `cargo test softlimits` compares (numbers to 1e-9, the rest exactly).
// NaN goes into the file as null (as JSON writes it) and Rust reads null as NaN.
// After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test softlimits
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { checkLimits, scanJobExtents, type LimitEnv, type ScanStart } from "../src/softLimits.ts";

const file = new URL("./fixtures/softlimits-cases.json.gz", import.meta.url);
const jobs: { name: string; lines: string[]; start: ScanStart }[] = [];
const S0: ScanStart = { wpos: [0, 0, 0], wco: [0, 0, 0], activeWcs: "G54" };
const job = (name: string, text: string | string[], start: ScanStart = S0) => jobs.push({ name, lines: Array.isArray(text) ? text : text.split("\n"), start });

// ---- from tests/softLimits.test.ts ----
job("all axes, rapids too", ["G21 G90", "G0 X10 Y-5 Z5", "G1 Z-3 F100", "X50"]);
job("inch, relative from the position", ["G20", "G91", "G0 X1", "G0 X1"], { wpos: [100, 0, 0] });
job("half circle cw", ["G0 X0 Y0", "G2 X20 Y0 I10 J0"]);
job("half circle ccw", ["G0 X0 Y0", "G3 X20 Y0 I10 J0"]);
job("R arc", ["G0 X0 Y0", "G2 X20 Y0 R10"]);
job("G18 arc", ["G18", "G0 X0 Y0 Z0", "G2 X20 Z0 I10 K0"]);
job("G53 machine move", ["G0 X10", "G53 G0 Z-2", "G0 X20"], { wpos: [0, 0, 0], wco: [-100, 0, -50], activeWcs: "G54" });
job("relative after G53", ["G53 G0 Z-2", "G91", "G0 Z1"], { wpos: [0, 0, 0], wco: [0, 0, -50], activeWcs: "G54" });
job("G92", ["G0 X10", "G92 X0", "G0 X500"]);
job("G10", ["G10 L20 P0 X0", "G0 X500"]);
job("other WCS", ["G55", "G0 X500"]);
job("same WCS", ["G54", "G0 X500"]);
job("G28 then relative", ["G28", "G91", "G0 X5"]);
job("probe then relative", ["G38.2 Z-50 F100", "G91", "G0 Z5"]);
job("drill cycle", ["G81 X1 Y1 Z-5 R2 F100"]);
job("comments and $ lines", ["(G0 X999)", "$J=G91 X999", "G0 X1 ; X999", "G4 P5"]);
job("Z after tool change", ["G0 Z5", "G1 Z-1 F100", "M0 (tool)", "G0 Z50"]);
job("job in machine space", ["G0 X0 Y0 Z2", "G1 X100 Y50 Z-5 F100"], { wpos: [10, 0, 5], activeWcs: "G54" });
job("far +X", ["G0 X300 Y0"], { wpos: [10, 0, 5], activeWcs: "G54" });
job("far -X", ["G0 X-60"], { wpos: [10, 0, 5], activeWcs: "G54" });
job("safe height above zero", ["G0 Z5", "G1 Z-1 F100"], { wpos: [0, 0, 0], activeWcs: "G54" });
job("wide job", ["G0 X0", "G0 X310"]);
job("G53 out, Y far", ["G53 G0 Z5", "G0 Y9999"]);

// ---- real programs as CNC Craft writes them ----
for (const name of ["post-drawing", "post-drawing-table"]) job(name, readFileSync(new URL(`./fixtures/${name}.gcode`, import.meta.url), "utf8").split(/\r?\n/), { wpos: [12.5, -3, 4], wco: [-200, -150, -30], activeWcs: "G54" });

// ---- odd spellings and every G word the scan knows ----
job("numbers", ["g0 x.5 y-.5 z+3", "G1 X1. Y 2 Z\t-1 F100", "G1 X1.2.3 Y4", "N10 G1 X7 Y8", "%", "G1 X-0", "  ", "", "G0X3Y4Z5"]);
job("unknown start position, relative", ["G91", "G0 X5", "G90", "G0 Y3", "G91", "G0 Y2 X1"], {});
job("G91 arcs", ["G0 X0 Y0", "G91", "G2 X10 Y0 I5 J0", "G3 X-10 Y0 I-5 J0", "G90"]);
job("arcs in G19 and G18 with R", ["G19", "G0 X0 Y0 Z0", "G2 Y20 Z0 R10", "G3 Y0 Z0 R-10", "G18", "G2 X20 Z0 R10", "G3 X0 Z0 R-15", "G2 X0 Z0 R5"]);
job("R too small, zero length", ["G0 X0 Y0", "G2 X20 Y0 R5", "G2 X20 Y0 R5", "G3 X0 Y0 I0 J0"]);
job("full circles", ["G0 X10 Y0", "G2 X10 Y0 I-10 J0", "G3 I-10 J0", "G17 G2 X10 Y0 I-10.000001 J0"]);
job("modal arc without G", ["G0 X0 Y0", "G2 X10 Y10 I10 J0", "X20 Y0 I0 J-10", "G80", "X999", "G0 X1"]);
job("tool length, G43.1, G49", ["G0 Z5", "G43.1 Z2", "G0 Z9", "G49", "G0 Z10", "G0 X5"]);
job("G28.1, G30.1, G4, G40", ["G28.1", "G30.1", "G4 P1", "G40", "G0 X5 Y5", "G30", "G0 X6"]);
job("G92.1 and G92.3", ["G0 X1", "G92.1", "G0 X2", "G92.3", "G0 X3"]);
job("cycles", ["G73 X1 Y1 Z-3 R1 Q1 F50", "G0 X5", "G74 X1", "G85 X2", "G89 X3"]);
job("G59.1, unknown WCS name", ["G59.1", "G0 X3", "G56", "G0 X4", "G56", "G0 X5"], { wpos: [0, 0, 0], activeWcs: "" });
job("no active WCS", ["G54", "G0 X3", "G0 X4"], { wpos: [0, 0, 0] });
job("M1 and M6 make Z later", ["G0 Z5", "M1", "G0 Z9 X1", "G1 Z-4", "M6 T2", "G0 Z12"]);
job("inch arcs and G21 back", ["G20", "G0 X0 Y0", "G2 X1 Y0 I0.5 J0", "G21", "G0 X10", "G20", "G3 X2 Y0 R0.5"]);
job("G53 without WCO", ["G53 G0 X-5 Y-5", "G91", "G0 X1"], { wpos: [0, 0, 0] });
job("G53 after blind", ["G92 X0", "G53 G0 X-5", "G91", "G0 X1"], { wpos: [0, 0, 0], wco: [-10, -10, -10] });
job("probe with axes", ["G0 X1 Y1", "G38.3 X10 F50", "G0 Y5", "G91", "G0 X1 Y1"]);
job("start position with NaN", ["G91", "G0 X1 Y1 Z1"], { wpos: [NaN, 5, 0], wco: [0, 0, 0] });
job("short start position", ["G91", "G0 X1 Y1 Z1"], { wpos: [1] });
job("empty", []);
job("only comments", ["(a)", "; b", "( G0 X5 )"]);
job("nearly closed circle", ["G0 X10 Y0", "G3 X10 Y0.0000000005 I-10 J0"]);
job("shallow arcs", ["G0 X0 Y0", "G2 X10 Y0 R26", "G3 X0 Y0 R26", "G0 X0 Y5", "G2 X10 Y5 I5 J-24.5", "G3 X0 Y5 I-5 J-24.5"]);
job("paren inside a number", ["G0 X1(c)5 Y2"]);
job("G4 with an axis word", ["G4 P1 X77", "G0 X3"]);
job("a word twice", ["G0 X1 X5 Y2 Y-3"]);
job("G53 in inches", ["G20", "G53 G0 X-1 Z-0.5", "G21", "G91", "G0 X1"], { wpos: [0, 0, 0], wco: [-10, -10, -10], activeWcs: "G54" });
job("G19 arc with J and K", ["G19", "G0 X0 Y0 Z0", "G2 Y10 Z0 J5 K0", "G3 Y0 Z0 J-5 K2", "G18", "G2 X10 Z0 I5 K-3"]);
job("R together with an offset", ["G0 X0 Y0", "G2 X10 Y0 R5 J3", "G3 X0 Y0 R5 I-2"]);
job("R arc of almost no length", ["G0 X0 Y0", "G2 X0.0000000005 Y0 R5", "G3 X0 Y0.0000000002 R-5"]);
job("just over the limits", ["G0 X150.02 Y0", "G0 X-149.98 Y-100.03"]);
job("span just over the travel", ["G0 X0", "G0 X300.02"]);
job("only Z after a tool change", ["M6 T1", "G0 Z50", "G0 Z-75"]);
job("semicolon before paren", ["G0 X1 ; (G0 X99)", "G0 (c) X2 ;d", "G0 X3 (open"]);
let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
{
  const rows: string[] = ["G21", "G90", "G0 Z5"];
  let x = 0, y = 0;
  for (let k = 0; k < 300; k++) {
    const kind = rnd();
    if (kind < 0.15) rows.push(`G${["17", "18", "19"][Math.floor(rnd() * 3)]}`);
    const ex = (rnd() - 0.5) * 300, ey = (rnd() - 0.5) * 200, ez = (rnd() - 0.8) * 20;
    if (kind < 0.4) rows.push(`G1 X${ex.toFixed(3)} Y${ey.toFixed(3)} Z${ez.toFixed(3)} F800`);
    else if (kind < 0.7) rows.push(`G${rnd() > 0.5 ? 2 : 3} X${ex.toFixed(3)} Y${ey.toFixed(3)} I${((rnd() - 0.5) * 80).toFixed(3)} J${((rnd() - 0.5) * 80).toFixed(3)} K${((rnd() - 0.5) * 20).toFixed(3)}`);
    else if (kind < 0.85) rows.push(`G${rnd() > 0.5 ? 2 : 3} X${ex.toFixed(3)} Z${ez.toFixed(3)} R${((rnd() - 0.4) * 150).toFixed(3)}`);
    else rows.push(`G0 X${ex.toFixed(3)} Y${ey.toFixed(3)}`);
    x = ex; y = ey;
  }
  void x; void y;
  job("300 random moves and arcs", rows, { wpos: [3, 4, 5], wco: [-150, -100, -40], activeWcs: "G54" });
}

// ---- machine states ----
const E = (o: Partial<LimitEnv> = {}): LimitEnv => ({ travel: [300, 200, 80], homeDirMask: 0, pulloff: 1, homed: true, mpos: [-150, -100, -10], wpos: [0, 0, 0], ...o });
const envs: LimitEnv[] = [
  E(),
  E({ homeDirMask: 1, mpos: [150, -100, -10] }),
  E({ homeDirMask: 7, mpos: [150, 100, 10], wpos: [50, 0, 0] }),
  E({ homed: false, mpos: [0, 0, 0] }),
  E({ travel: [NaN, 200, 0] }),
  E({ skip: [1], pulloff: NaN, mpos: [-1.2, -0.4, -2.6] }),
  E({ mpos: [-240, -150, -15, 90], wpos: [10, 0, 5, 90], pulloff: 3 }),
  E({ mpos: [-500, NaN, -10], travel: [300, 200, 80] }),
  E({ travel: [30, 20, 8], mpos: [-15, -10, -4] }),
  E({ homeDirMask: 7, mpos: [-1.2, 1.2, -1.4] }),
  E({ homeDirMask: 4, pulloff: NaN, mpos: [-150, -100, -2.6] }),
  E({ homeDirMask: 1, mpos: [400, -100, -10] }),
  E({ homeDirMask: 2, mpos: [-150, 100, -10] }),
  E({ pulloff: 4, homeDirMask: 1, mpos: [3.5, -100, -10], wpos: [3.5, 0, 0] }),
];

test("machine limits: pinned result for Rust (softlimits-cases.json.gz)", () => {
  const cases = jobs.map(j => {
    const ext = scanJobExtents(j.lines, j.start);
    return { name: j.name, text: j.lines.join("\n"), start: j.start, ext, res: envs.map(e => checkLimits(ext, e)) };
  });
  // the cases reach every note, every kind of over-travel and every warning
  const notes = new Set(cases.flatMap(c => c.ext.notes));
  assert.deepEqual([...notes].sort(), ["cycle", "homeMove", "offsets", "probe", "relative", "tlo", "wcs"]);
  const kinds = new Set(cases.flatMap(c => c.res.flatMap(r => [...r.over, ...r.zLaterOver].map(o => o.kind))));
  assert.deepEqual([...kinds].sort(), ["+", "-", "span"]);
  assert.ok(cases.some(c => c.res.some(r => r.unknownAxes.length)) && cases.some(c => c.res.some(r => r.noSettings.length)) && cases.some(c => c.ext.zLater));
  const text = JSON.stringify({ envs, cases }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
