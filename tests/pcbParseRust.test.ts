// Gerber and Excellon reading: TypeScript (src/pcb/gerber.ts, src/pcb/excellon.ts) and Rust (src-tauri/src/pcbparse.rs)
// must read the same objects, lines, holes, slots and notes. This test pins what the TypeScript reads in
// fixtures/pcbparse-cases.json; `cargo test pcbparse` compares (numbers to 1e-9, the rest exactly).
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test pcbparse
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { parseGerber } from "../src/pcb/gerber.ts";
import { parseExcellon } from "../src/pcb/excellon.ts";

const file = new URL("./fixtures/pcbparse-cases.json", import.meta.url);
const cases: { name: string; kind: "gerber" | "drill"; text: string }[] = [];
const gb = (name: string, text: string) => cases.push({ name, kind: "gerber", text });
const dr = (name: string, text: string) => cases.push({ name, kind: "drill", text });
const H = "%FSLAX46Y46*%\n%MOMM*%\n";

gb("pads and trace", H + "%TF.FileFunction,Copper,L1,Top*%\n%ADD10C,1.6*%\n%ADD11C,0.3*%\nD10*\nX2000000Y2000000D03*\nX9000000Y2000000D03*\nD11*\nX2000000Y2000000D02*\nX9000000Y2000000D01*\nX9000000Y5000000D01*\nM02*\n");
gb("all standard apertures with holes", H + "%ADD10C,1.0X0.4*%\n%ADD11R,1.2X0.8X0.3*%\n%ADD12O,2X1*%\n%ADD13O,1X2X0.5*%\n%ADD14P,1.5X5X10X0.3*%\n%ADD15P,1.5X40*%\nD10*\nX0Y0D03*\nD11*\nX3000000Y0D03*\nD12*\nX6000000Y0D03*\nD13*\nX9000000Y0D03*\nD14*\nX12000000Y0D03*\nD15*\nX15000000Y0D03*\nM02*\n");
gb("inch, trailing zeros, incremental", "%FSTIX24Y24*%\n%MOIN*%\n%ADD10C,0.05*%\nD10*\nX1Y1D02*\nX2Y0D01*\nX0Y15D01*\nG90*\nM02*\n");
gb("no units given", "%FSLAX24Y24*%\n%ADD10C,0.5*%\nD10*\nX10000Y10000D03*\nM02*\n");
gb("G70/G71 units and leading zeros format", "%FSDAX24Y24*%\nG70*\n%ADD10C,0.02*%\nD10*\nX010000Y020000D03*\nG71*\nX01Y02D03*\nM02*\n");
gb("arcs multi quadrant", H + "%ADD11C,0.2*%\nD11*\nG75*\nX0Y0D02*\nG03*\nX4000000Y0I2000000J0D01*\nG02*\nX4000000Y0I-1000000J0D01*\nG01*\nX5000000Y1000000D01*\n");
gb("arcs single quadrant", H + "%ADD11C,0.2*%\nD11*\nG74*\nX3000000Y0D02*\nG03X0Y3000000I3000000J0D01*\nG02X-3000000Y0I3000000J0D01*\nG01*\nM02*\n");
gb("regions and clear polarity", H + "G36*\nX0Y0D02*\nX10000000Y0D01*\nX10000000Y8000000D01*\nG03X0Y8000000I-5000000J0D01*\nG01*\nX0Y0D01*\nX2000000Y2000000D02*\nX3000000Y2000000D01*\nX3000000Y3000000D01*\nG37*\n%LPC*%\n%ADD10C,2*%\nD10*\nX5000000Y4000000D03*\n%LPD*%\nM02*\n");
gb("step and repeat", H + "%ADD10C,0.8*%\n%SRX3Y2I2.5J4*%\nD10*\nX0Y0D03*\nX1000000Y0D03*\n%SR*%\nX20000000Y0D03*\nM02*\n");
gb("step and repeat too big or single", H + "%ADD10C,0.8*%\n%SRX1Y1I2J2*%\nD10*\nX0Y0D03*\n%SR*%\n%SRX200Y200I1J1*%\nX1000000Y0D03*\n%SR*%\nM02*\n");
gb("aperture macros", H + "%AMTHERM*0 thermal*7,0,0,2.4,1.6,0.4,45*%\n%AMBOX*$3=$1x2*21,1,$3,$2,0,0,30*1,0,0.5,0,0*%\n%AMPOLY*4,1,4,0,0,1,0,1,1,0,1,0,0,15*%\n%AMLINE*20,1,0.3,0,0,2,1,0*2,1,0.2,0,1,2,0,10*%\n%AMOCT*5,1,8,0,0,2,22.5*%\n%AMMOIRE*6,0,0,3,0.2,0.3,3,0.1,4,0*%\n%AMROUND*1,1,1.2,0,0*%\n%AMCENT*22,1,2,1,0,0,0*%\n%ADD20THERM*%\n%ADD21BOX,1.5X0.8*%\n%ADD22POLY*%\n%ADD23LINE*%\n%ADD24OCT*%\n%ADD25MOIRE*%\n%ADD26ROUND*%\n%ADD27CENT*%\nD20*\nX0Y0D03*\nD21*\nX4000000Y0D03*\nD22*\nX8000000Y0D03*\nD23*\nX12000000Y0D03*\nD24*\nX16000000Y0D03*\nD25*\nX20000000Y0D03*\nD26*\nX24000000Y0D03*\nX26000000Y0D01*\nD27*\nX28000000Y0D03*\nM02*\n");
gb("bad macros and apertures", H + "%AMBAD*1,1,(2*%\n%AMUNK*99,1,1*%\n%ADD20BAD*%\n%ADD21UNK*%\n%ADD22NOPE*%\n%ADD23R,1*%\nD20*\nX0Y0D03*\nD21*\nX1000000Y0D03*\nD22*\nX2000000Y0D03*\nD23*\nX3000000Y0D03*\nD99*\nX4000000Y0D03*\nM02*\n");
gb("square brush stroke (hull)", H + "%ADD12R,0.6X0.6*%\n%ADD13O,1X0.4*%\nD12*\nX0Y0D02*\nX5000000Y2000000D01*\nD13*\nX0Y3000000D02*\nX4000000Y3000000D01*\nX4000000Y6000000D01*\nM02*\n");
gb("mirror rotate scale", H + "%ADD10R,1X0.5*%\n%LMXY*%\n%LR30*%\n%LS1.5*%\nD10*\nX2000000Y2000000D03*\n%LMN*%\n%LR0*%\n%LS1*%\n%LMX*%\nX4000000Y2000000D03*\nM02*\n");
gb("redefine an aperture after selecting it", H + "%ADD10C,1*%\nD10*\nX0Y0D03*\n%ADD10C,2*%\nX2000000Y0D03*\nD10*\nX4000000Y0D03*\nM02*\n");
gb("unknown commands and notes", H + "%IPNEG*%\n%ABD10*%\nG04 comment %TF.FileFunction,Legend*\nG54D10*\n%XYZ123*%\nG99*\n%TA.AperFunction,Conductor*%\n%ADD10C,1*%\nG54D10*\nX0Y0D03*\nQ123*\nX1000000D03*\nY1000000D03*\nX2000000Y2000000I5D02*\nM00*\nX9000000Y9000000D03*\n");
gb("coordinates with decimal points", H + "%ADD10C,0.5*%\nD10*\nX1.5Y2.25D03*\nX-1.5Y-.5D03*\nM02*\n");
gb("stroke continues the last line", H + "%ADD11C,0.2*%\nD11*\nX0Y0D02*\nX1000000Y0D01*\nX2000000Y0D01*\nX2000000Y0D02*\nX2000000Y1000000D01*\nX0Y0D02*\nX0Y1000000D01*\nM02*\n");
gb("strokes without aperture", H + "X0Y0D02*\nX1000000Y0D01*\nX2000000Y0D03*\nM02*\n");
gb("M02 inside, text after", H + "%ADD10C,1*%\nD10*\nX0Y0D03*\nM02*\nX1000000Y0D03*\n");
gb("scaled round brush and LS0", H + "%ADD10C,0.5*%\n%ADD11C,0.2X0.1*%\n%ADD12O,1X1*%\n%LS1.5*%\nD10*\nX0Y0D03*\nX0Y0D02*\nX2000000Y0D01*\n%LS0*%\nX3000000Y0D03*\nD11*\nX0Y2000000D02*\nX3000000Y2000000D01*\nD12*\nX5000000Y0D03*\nM02*\n");
gb("region with two points, G00, G4 comment", H + "G36*\nX0Y0D02*\nX1000000Y0D01*\nG37*\nG00*\nG4 just a comment*\n%ADD10C,1*%\nD10*\nX0Y0D03*\nM02*\n");
gb("M0 ends the file", H + "%ADD10C,1*%\nD10*\nX0Y0D03*\nM0*\nX5000000Y0D03*\n");
gb("single quadrant: no centre fits, spiral arc", H + "%ADD11C,0.1*%\nD11*\nG74*\nX1000000Y0D02*\nG03X-1000000Y0I1000000J0D01*\nG75*\nX0Y0D02*\nG03X4000000Y0I1000000J0D01*\nG01*\nM02*\n");
gb("macro arithmetic and odd primitives", H + "%AMEX*$1=2X3*$2=$1/0+$9*1,1,$1,$2,0*1*21,1,1,0.5,$2,0*%\n%AMMOI*6,0,0,1,0.6,0.1,2,0.1,1.5,0*%\n%ADD20EX*%\n%ADD21MOI*%\nD20*\nX0Y0D03*\nD21*\nX5000000Y0D03*\nM02*\n");
gb("tiny round brush with a hole", H + "%ADD11C,0.02X0.01*%\nD11*\nX0Y0D02*\nX1000000Y500000D01*\nM02*\n");
gb("G4 comment alone", H + "G4 nothing else here*\n%ADD10C,1*%\nD10*\nX0Y0D03*\nM02*\n");
gb("empty", "");

dr("metric with decimals", "M48\n; FILE_FORMAT=4:4\nMETRIC,TZ\nT1C0.800\nT2C1.000\n%\nG90\nG05\nT1\nX1.5Y2.5\nX3.5Y2.5\nT2\nX10.0Y10.0\nM30\n");
dr("inch leading zeros format", "M48\nINCH,LZ,00.0000\nT01C0.0320\n%\nT01\nX010000Y020000\nX-005Y0005\nM30\n");
dr("inch trailing zeros default format", "M48\nINCH,TZ\nT1C0.03\n%\nT1\nX10000Y20000\nX5Y15\nM30\n");
dr("no units: guessed", "T1C0.8\nT1\nX100Y200\nX300Y400\n");
dr("M71 M72 and incremental", "M48\nM71\nT1C1\n%\nT1\nX1.0Y1.0\nICI,ON\nX1.0Y0\nX1.0Y0\nG90\nX5.0Y5.0\nM72\nX1.0Y1.0\nM30\n");
dr("plated and non plated comments", "; #@! TF.FileFunction,NonPlated,1,2,NPTH\nM48\nMETRIC\nT1C3.0\n%\nT1\nX1.0Y1.0\nM30\n");
dr("type plated", "; TYPE=PLATED\nM48\nMETRIC\nT1C0.5\n%\nT1\nX0.0Y0.0\nM30\n");
dr("slots G85", "M48\nMETRIC\nT1C1.0\n%\nT1\nX1.0Y1.0G85X5.0Y1.0\nX1.0Y3.0G85X1.0Y8.0\nM30\n");
dr("routed slots and arcs", "M48\nMETRIC\nT1C0.8\n%\nT1\nG00X0.0Y0.0\nM15\nG01X10.0Y0.0\nG03X10.0Y10.0I0.0J5.0\nG02X0.0Y10.0A5.0\nG01X0.0Y0.0\nM16\nG05\nX20.0Y20.0\nM30\n");
dr("repeat holes", "M48\nMETRIC\nT1C0.6\n%\nT1\nX1.0Y1.0\nR4X2.0\nR03Y1.5X0.5\nM30\n");
dr("tools without size and tool 0", "M48\nMETRIC\nT1C0.8\n%\nT2\nX1.0Y1.0\nT0\nX2.0Y2.0\nT1\nX3.0Y3.0\nM30\n");
dr("header noise and unknown lines", "M48\n;comment\nFMAT,2\nVER,1\nDETECT,ON\nATC,ON\nMETRIC,LZ\nT1F00S00C0.8\nT2\n%\nT1\nG93X0Y0\nF100\nS10000\nM25\nX1.0Y1.0\nhello world\nX2.0Y2.0#\nM08\nM01\nM30\nX9.0Y9.0\n");
dr("M00 then more", "M48\nMETRIC\nT1C1\n%\nT1\nX1.0Y1.0\nM00\nX2.0Y2.0\nM30\n");
dr("metric without decimal points", "M48\nMETRIC\nT1C0.8\n%\nT1\nX1000Y2000\nX-500Y250\nM30\n");
dr("arc with too small radius", "M48\nMETRIC\nT1C0.8\n%\nT1\nG00X0.0Y0.0\nM15\nG02X10.0Y0.0A2.0\nM16\nM30\n");
dr("both plated notes", "; TYPE=NON_PLATED\n; #@! TF.FileFunction,Plated,1,2,PTH\nM48\nMETRIC\nT1C1\n%\nT1\nX1.0Y1.0\nM30\n");
dr("odd characters in the header", "M48\nMETRIC\n@@@\nT1C1\n%\nT1\nX1.0Y1.0\nM30\n");
dr("metric leading zeros without format", "M48\nMETRIC,LZ\nT1C0.8\n%\nT1\nX0125Y025\nM30\n");
dr("empty", "");

test("Gerber and Excellon reading: pinned result for Rust (pcbparse-cases.json)", () => {
  const built = cases.map(c => {
    let want: unknown;
    try { want = c.kind === "gerber" ? parseGerber(c.text) : parseExcellon(c.text); }
    catch (e) { want = { error: e instanceof Error ? e.message : String(e) }; }
    return { ...c, want };
  });
  const text = JSON.stringify(built) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, text);
  assert.equal(readFileSync(file, "utf8"), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
