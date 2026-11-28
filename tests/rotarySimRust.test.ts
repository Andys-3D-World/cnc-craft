// Simulation with the rotary axis: TypeScript (src/sim/rotarySim.ts + src/rotaryStock.ts) and Rust (src-tauri/src/rotarysim.rs
// + rotarystock.rs) must wrap the same moves around the part – pieces of at most 2°, positions, depth, the raster for
// material removal, faces of square and polygon stock, the cone, axis along Y, reversed direction, roller scale – Float32,
// Uint32 and Int16 bit for bit. Programs come from the simulation's own G-code reader; body and summary as in the app
// (src/sim/rotarySimRust.ts). Pinned in fixtures/rotarysim-cases.json.gz, with the stock helpers.
// After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cargo test rotarysim
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { parseGcodeProgram } from "../src/sim/gcodeParser.ts";
import { wrapSimProgram, radialDepth, type WrapSimOpts } from "../src/sim/rotarySim.ts";
import { rotarySimBody, rotarySimSummary } from "../src/sim/rotarySimRust.ts";
import { coneCenter, coneRadius, cornerRadius, faceAt, faces, minRadius, perimeter, refRadius, sectionAt, surfaceRadius, type RotaryStock } from "../src/rotaryStock.ts";

const file = new URL("./fixtures/rotarysim-cases.json.gz", import.meta.url);
const ROUND: RotaryStock = { shape: "round", diameter: 30, width: 0, height: 0, sides: 4, flats: 0, d0: 0, d1: 0, coneLen: 1 };
const stocks: RotaryStock[] = [
  ROUND,
  { ...ROUND, shape: "rect", width: 40, height: 24 },
  { ...ROUND, shape: "rect", width: 20, height: 20 },
  { ...ROUND, shape: "poly", sides: 6, flats: 26 },
  { ...ROUND, shape: "poly", sides: 7.4, flats: 30 },
  { ...ROUND, shape: "poly", sides: 2, flats: 10 },
  { ...ROUND, shape: "cone", d0: 30, d1: 18, coneLen: 80 },
  { ...ROUND, shape: "cone", d0: 10, d1: 40, coneLen: 0 },
];
const motion = { accel: [800, 800, 300], maxRate: [6000, 6000, 1500], junctionDev: 0.01, lookahead: 16 };

const C = 2 * Math.PI * 15;
const programs: { name: string; lines: string[]; motion?: boolean }[] = [
  { name: "ring on the surface", lines: ["G0 X5 Y0 Z0", `G1 Y${C} F600`, "G1 X20", `G1 Y0`, "G0 Z5"] },
  { name: "drawing with depth", lines: ["G21 G90", "G0 X0 Y0 Z2", "G1 Z-1 F200", "G1 X40 Y30 F800", "G2 X60 Y50 I10 J10", "G1 X10 Y80 Z-2", "G0 Z5", "G0 X0 Y-20", "G1 Z-0.5", "G1 X70 Y-5"], motion: true },
  { name: "A axis", lines: ["G90 G0 X0 Y0 Z0 A0", "G1 A90 F600", "G1 X10 A180", "G1 Z-1", "G1 X30 A-45 F300", "G0 Z3", "G0 A720", "G1 X50 Y2 A721 Z-0.4 F500"] },
  { name: "A axis, side moves", lines: ["G90 G0 X0 Y5 Z0 A0", "G1 Y-5 Z-1 F400", "G0 Z2 A90", "G1 Z-1", "G1 Y5", "G0 Z2 A180", "G1 Z-1 Y-5", "G0 Z5 A270", "G1 Z-0.5 X40"], motion: true },
  { name: "indexing faces", lines: ["G90 G0 X0 Y-10 Z1 A0", "G1 Z-0.5 F300", "G1 X60", "G0 Z5", "G0 A60", "G1 Z-0.5", "G1 X0", "G0 Z5 A120", "G1 Z-0.5", "G1 X60", "G0 A90", "G1 Z-1 X30"] },
  { name: "A steps", lines: ["G90 G0 X0 Y0 Z0 A0", ...Array.from({ length: 40 }, (_, k) => `G1 A${(k + 1) * (k + 2) / 2} X${k} F900`)] },
  { name: "A near a face", lines: ["G90 G0 X0 Y-5 Z0 A0", "G1 Z-0.5 F300", "G0 A60.005", "G1 X20", "G0 A119.996", "G1 X0", "G0 A180.02", "G1 X10", "G0 A239.9995", "G1 X30"] },
  { name: "spindle off moves", lines: ["G90 G0 X0 Y0 Z1", "M3 S1000", "G1 Z-1 F200", "G1 X30 Y20 F600", "M5", "G1 X40 Y40", "G1 X0 Y60", "M3", "G1 X10 Y10"] },
  { name: "empty", lines: ["G21", "G90"] },
  { name: "rapids only", lines: ["G0 X10 Y10", "G0 X20 Y40 Z3", "G0 X0 Y0"] },
];
const optsList: { o: WrapSimOpts; name: string }[] = [
  { o: {}, name: "plain" }, { o: { along: "y" }, name: "along y" }, { o: { reverse: true }, name: "reverse" },
  { o: { aScale: 30 / 60, along: "y", reverse: true }, name: "roller, y, reverse" }, { o: { aScale: NaN }, name: "roller NaN" },
];

test("rotary simulation: pinned result for Rust (rotarysim-cases.json.gz)", () => {
  const cases: unknown[] = [];
  for (const pr of programs) {
    const p = parseGcodeProgram(pr.lines, pr.motion ? { motion } : {});
    for (const st of stocks) for (const { o, name } of optsList) for (const mode of (p.a0 ? ["a", "surface"] : ["surface"]) as ("a" | "surface")[]) {
      if (st !== ROUND && name !== "plain" && name !== "along y" && pr.name !== "A axis" && pr.name !== "A near a face") continue;   // die Formen mit zwei Lagen reichen
      const R = refRadius(st);
      const opts: WrapSimOpts = { ...o, stock: st };
      const w = wrapSimProgram(p, R, mode, opts);
      const body = rotarySimBody(p, R, mode, opts)!;
      cases.push({ name: `${pr.name} / ${st.shape} ${st.sides} / ${name} / ${mode}`, body: Buffer.from(body).toString("base64"), want: rotarySimSummary(w) });
    }
    // ohne Rohteil: rund mit Radius R
    const w = wrapSimProgram(p, 12, "surface", {});
    cases.push({ name: `${pr.name} / no stock`, body: Buffer.from(rotarySimBody(p, 12, "surface", {})!).toString("base64"), want: rotarySimSummary(w) });
  }
  // (über 4 Mio. Stücke werden sie gröber – das braucht Hunderte MB und bleibt hier ungeprüft)

  const helpers = stocks.concat([{ ...ROUND, shape: "poly", sides: NaN, flats: 5 }, { ...ROUND, shape: "other" as never }]).map(s => ({
    s, faces: faces(s), perimeter: perimeter(s), corner: cornerRadius(s), ref: faces(s).length || s.shape !== "poly" ? refRadius(s) : null, min: minRadius(s), coneCenter: coneCenter(s),
    cone: [-10, 0, 13.3, 40, 80, 200].map(a => coneRadius(s, a)), section: [0, 33].map(a => sectionAt(s, a)), section7: sectionAt(s, 5, 7),
    surface: [-3, -1, -0.2, 0, 0.3, 1, 2.5, 3.1].map(phi => surfaceRadius(s, 20, phi)),
    faceAt: faces(s).length ? [-50, -0.1, 0, 5, 33.3, 64, 1000].map(u => { const r = faceAt(faces(s), u); return [r.face.k, r.center]; }) : []
  }));
  const radial = [[0, 0, 10], [3, -2, 10], [-4, 5, 12.5], [0, -10, 10]].map(([q, z, R]) => ({ q, z, R, d: radialDepth(q, z, R) }));
  assert.ok(cases.length >= 60);
  const text = JSON.stringify({ cases, helpers, radial }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
