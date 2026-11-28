// PCB isolation paths: TypeScript (isolate in src/pcb/field.ts) and Rust (src-tauri/src/pcbiso.rs) must give the same
// copper outlines, isolation lines (all passes), nets and narrow places. This test reads small Gerber boards with
// parseGerber, runs isolate and pins the result in fixtures/pcbiso-cases.json.gz; `cargo test pcbiso` compares
// (numbers to 1e-9, the rest exactly). After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test pcbiso
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { parseGerber, gerberBox } from "../src/pcb/gerber.ts";
import { isolate, type IsoJob } from "../src/pcb/field.ts";

const file = new URL("./fixtures/pcbiso-cases.json.gz", import.meta.url);
const HEAD = "%FSLAX46Y46*%\n%MOMM*%\n";
const c = (v: number) => String(Math.round(v * 1e6));
const at = (x: number, y: number) => `X${c(x)}Y${c(y)}`;

const boards: { name: string; gerber: string; width: number; passes?: number; overlap?: number; step?: number }[] = [];
const add = (name: string, body: string, width = 0.2, o: { passes?: number; overlap?: number; step?: number } = {}) => boards.push({ name, gerber: HEAD + body + "M02*\n", width, ...o });

add("one round pad", "%ADD10C,1.6*%\nD10*\n" + at(5, 5) + "D03*\n");
add("two pads and a trace", "%ADD10C,1.6*%\n%ADD11C,0.3*%\nD10*\n" + at(2, 2) + "D03*\n" + at(9, 2) + "D03*\nD11*\n" + at(2, 2) + "D02*\n" + at(9, 2) + "D01*\n");
add("square and oblong pads", "%ADD12R,1.5X1.0*%\n%ADD13O,2.0X1.0*%\n%ADD14P,1.8X6X15*%\nD12*\n" + at(1, 1) + "D03*\nD13*\n" + at(4, 1) + "D03*\nD14*\n" + at(7, 1) + "D03*\n");
add("pads too close: narrow place reported", "%ADD10C,1.6*%\nD10*\n" + at(2, 2) + "D03*\n" + at(3.75, 2) + "D03*\n" + at(6, 2) + "D03*\n", 0.3);
add("region (copper pour) with a hole cleared", "G36*\n" + at(0, 0) + "D02*\n" + at(10, 0) + "D01*\n" + at(10, 8) + "D01*\n" + at(0, 8) + "D01*\n" + at(0, 0) + "D01*\nG37*\n%LPC*%\n%ADD15C,3*%\nD15*\n" + at(5, 4) + "D03*\n%LPD*%\n%ADD16C,1*%\nD16*\n" + at(5, 4) + "D03*\n");
add("pad with a drilled hole", "%ADD17C,2.0X0.8*%\nD17*\n" + at(3, 3) + "D03*\n" + at(6, 3) + "D03*\n");
add("thermal macro", "%AMTHERM*7,0,0,2.4,1.6,0.4,45*%\n%ADD18THERM*%\nD18*\n" + at(3, 3) + "D03*\n");
add("arc trace", "%ADD11C,0.4*%\nD11*\nG75*\n" + at(0, 0) + "D02*\nG03*\n" + at(6, 0) + "I" + c(3) + "J0D01*\nG01*\n" + at(6, 0) + "D02*\n" + at(6, -3) + "D01*\n");
add("three passes with overlap", "%ADD10C,1.2*%\n%ADD11C,0.25*%\nD10*\n" + at(1, 1) + "D03*\n" + at(5, 4) + "D03*\nD11*\n" + at(1, 1) + "D02*\n" + at(5, 1) + "D01*\n" + at(5, 4) + "D01*\n", 0.2, { passes: 3, overlap: 0.4 });
add("wide V-bit, fine step", "%ADD10C,1.0*%\nD10*\n" + at(1, 1) + "D03*\n" + at(3, 1) + "D03*\n", 0.5, { step: 0.03 });
add("traces crossing and touching", "%ADD11C,0.3*%\nD11*\n" + at(0, 0) + "D02*\n" + at(8, 6) + "D01*\n" + at(0, 6) + "D02*\n" + at(8, 0) + "D01*\n" + at(4, 0) + "D02*\n" + at(4, 6) + "D01*\n");
add("rectangle drawn with a square brush", "%ADD19R,0.5X0.5*%\nD19*\n" + at(0, 0) + "D02*\n" + at(6, 2) + "D01*\n");
add("larger board", (() => {
  let s = "%ADD10C,1.6*%\n%ADD11C,0.3*%\n%ADD12R,1.5X1.0*%\nD10*\n";
  for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) s += at(2 + i * 4, 2 + j * 5) + "D03*\n";
  s += "D12*\n" + at(13, 8) + "D03*\nD11*\n";
  for (let i = 0; i < 5; i++) s += at(2 + i * 4, 2) + "D02*\n" + at(6 + i * 4, 7) + "D01*\n";
  return s;
})(), 0.25, { passes: 2, overlap: 0.5 });
add("very thin diagonal trace (touches only corner to corner)", "%ADD10C,1.2*%\n%ADD20C,0.03*%\nD10*\n" + at(1, 1) + "D03*\n" + at(4, 3.3) + "D03*\nD20*\n" + at(1, 1) + "D02*\n" + at(4, 3.3) + "D01*\n");
add("gaps just under the cutter width", "%ADD10C,1.0*%\nD10*\n" + [0, 1.27, 2.545, 3.825, 5.11, 6.4].map((x, k) => at(1 + x + k * 0.0, 1)).map(a => a + "D03*\n").join(""), 0.3);
add("negative region inside pour", "G36*\n" + at(0, 0) + "D02*\n" + at(12, 0) + "D01*\n" + at(12, 10) + "D01*\n" + at(0, 10) + "D01*\n" + at(0, 0) + "D01*\nG37*\n%LPC*%\nG36*\n" + at(3, 3) + "D02*\n" + at(9, 3) + "D01*\n" + at(9, 7) + "D01*\n" + at(3, 7) + "D01*\n" + at(3, 3) + "D01*\nG37*\n%LPD*%\n%ADD10C,1.4*%\nD10*\n" + at(6, 5) + "D03*\n");

test("PCB isolation: pinned result for Rust (pcbiso-cases.json.gz)", () => {
  const built = boards.map(b => {
    const g = parseGerber(b.gerber);
    const box = gerberBox(g.objs)!;
    const job: IsoJob = { objs: g.objs, box, width: b.width, passes: b.passes ?? 1, overlap: b.overlap ?? 0.5, ...(b.step ? { step: b.step } : {}) };
    return { name: b.name, job, want: isolate(job) };
  });
  const text = JSON.stringify(built) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
