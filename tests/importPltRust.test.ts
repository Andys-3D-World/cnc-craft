// HPGL/PLT and G-code import: TypeScript (src/importers/plotParse.ts) and Rust (src-tauri/src/importplt.rs) must read the
// same paths and circles. This test builds the shared cases and pins what the TypeScript reads in
// fixtures/importplt-cases.json; `cargo test importplt` compares the Rust result (points to 1e-9 mm, the rest exactly).
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test importplt
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gcodeParse, hpglParse, type PlotParsed } from "../src/importers/plotParse.ts";

const file = new URL("./fixtures/importplt-cases.json", import.meta.url);
type Case = { name: string; kind: "hpgl" | "gcode"; text: string };
const cases: Case[] = [];
const hp = (name: string, text: string) => cases.push({ name, kind: "hpgl", text });
const gc = (name: string, text: string) => cases.push({ name, kind: "gcode", text });

hp("square with circle", "IN;PU0,0;PD400,0,400,400,0,400,0,0;PU;CI200;");
hp("no semicolons, lower case", "in pu100,100 pd200,100 200,200 pu pd300,300,400,400");
hp("relative moves", "IN;PA0,0;PU40,40;PR;PD40,0,0,40,-40,0,0,-40;PU;");
hp("PR then PA again", "IN;PR;PU10,10;PD10,0;PA;PD0,0,100,0;PU;");
hp("ETX terminators", "IN\x03PU0,0\x03PD80,0,80,80\x03PU\x03");
hp("odd number of values", "IN;PD100,0,200;PU;PD300,300,400;");
hp("signs and odd numbers", "IN;PD+100,-50,1.,.5,.,7;PD+-5,3,--2,4,8,9;PU;");
hp("exponent splits the command", "IN;PD1e3,0;PU;");
hp("spaces and tabs as separators", "IN;PD 100 , 0\t100\n100;PU;");
hp("unicode space", "IN;PD100 0,200 0;PU;");
hp("arc AA counterclockwise", "IN;PU400,0;PD;AA0,0,90;PD0,800;PU;");
hp("arc AA clockwise", "IN;PU400,0;PD;AA0,0,-180;PU;");
hp("arc AR relative center", "IN;PU400,400;PD;AR-200,0,270;PU;");
hp("arc with pen up moves only", "IN;PU400,0;AA0,0,90;PD0,0;PU;");
hp("arc first in path", "IN;PU400,0;PD;PU;PD;AA0,0,45.5;PU;");
hp("tiny arc radius", "IN;PU0,0;PD;AA0,0,360;PU;");
hp("small radius arc", "IN;PU0.2,0;PD;AA0,0,100;PU;");
hp("big arc", "IN;PU40000,0;PD;AA0,0,350;PU;");
hp("arc too few values", "IN;PU400,0;PD;AA0,0;PD800,0;PU;");
hp("CI zero and negative", "IN;PU100,100;CI0;CI-5;CI;CI40.5,5;");
hp("IN in the middle", "IN;PD100,0,100,100;IN;PD50,50;PU;");
hp("DF resets", "PR;PD10,10;DF;PD20,0;PU;");
hp("unknown commands and junk", "IN;SP1;VS10;LT;PU0,0;PD10,10;;;XX9;PU;$%&PD;PD20,20");
hp("only one point", "IN;PU10,10;PD;PU;");
hp("pen down without values then move", "IN;PU5,5;PD;PA15,5;PR5,5;PU;");
hp("pen up arc at the end", "IN;PU400,0;AA0,0,90;");
hp("move after IN keeps pen up", "IN;PD100,0;IN;PA50,50;PD60,60;PU;");
hp("PU with values moves without drawing", "IN;PD100,0;PU200,200;PD300,300;PU;");
hp("IN switches back to absolute", "IN;PR;PU5,5;IN;PU10,10;PU10,10;PD10,0;PU;");
hp("too big number is left out", "IN;PD" + "9".repeat(400) + ",5,10,10;PU;");
hp("tiny radius, small angle", "IN;PU0.2,0;PD;AA0,0,10;PU;");
hp("empty", "");

gc("lines with rapids", "G0 X0 Y0\nG1 X10 Y0\nG1 X10 Y10\nG0 X20 Y20\nG1 X30 Y20 F100\n");
gc("modal motion and words without spaces", "G1X0Y0\nX5\nY5\nX0Y0\nG0X1");
gc("arc G2 with I J", "G0 X10 Y0\nG2 X0 Y-10 I-10 J0\nG1 X0 Y-20");
gc("arc G3 with I J", "G0 X10 Y0\nG3 X-10 Y0 I-10 J0");
gc("full circle G2", "G0 X10 Y0\nG2 X10 Y0 I-10 J0\n");
gc("full circle G3 only J", "G0 X0 Y-5\nG3 X0 Y-5 J5\n");
gc("arc with R positive", "G0 X0 Y0\nG2 X10 Y0 R5\nG3 X20 Y0 R5");
gc("arc with R negative", "G0 X0 Y0\nG2 X10 Y0 R-8\nG3 X0 Y0 R-8");
gc("arc with R too small", "G0 X0 Y0\nG2 X10 Y0 R2");
gc("arc with R and no move", "G0 X5 Y5\nG2 X5 Y5 R3\nG1 X6 Y6");
gc("arc with I0 J0", "G0 X5 Y5\nG2 X7 Y5 I0 J0\nG1 X9");
gc("relative G91", "G90 G0 X10 Y10\nG91\nG1 X5\nG1 Y5\nG2 X-5 Y5 I-5 J0\nG90 G1 X0 Y0");
gc("inch G20 then G21", "G20\nG0 X0 Y0\nG1 X1 Y1\nG2 X2 Y0 I1 J-1\nG21\nG1 X10 Y10");
gc("comments in brackets and after semicolon", "(start) G0 X0 Y0 (move)\nG1 X5 ; to the right\n; whole line\nG1 (a(b) Y5\nG1 X(c Y9");
gc("semicolon with line separator after it", "G1 X1 ;a b\nG1 X2 Y2");
gc("lone carriage return", "G1 X1 Y1\rG1 X2\r\nG1 X3 Y3\r\n");
gc("lower case and spaces in words", "g0 x0 y0\ng1 x 5 y - 5\ng1 x . 5\ng1 x+2.5y-.5");
gc("numbers with trailing dot and two dots", "G1 X12. Y3\nG1 X1.5.3 Y2\nG1 X007 Y-0.0");
gc("several G words and other letters", "N10 G21 G90 G1 X5 Y5 F500 S1000 M3\nN20 G17 G1 X10 Z-1\nT1 M6\nG4 P1\nG1 Z5");
gc("unicode upper case", "g1 x1 ß y2\ng1 X3 ﬀ Y4");
gc("arc after rapid starts new path", "G0 X0 Y0\nG1 X5 Y0\nG0 X10 Y0\nG3 X0 Y10 I-10 J0");
gc("big arc radius", "G0 X1000 Y0\nG3 X-1000 Y0 I-1000 J0");
gc("tiny arc", "G0 X0 Y0\nG2 X0.002 Y0 I0.001 J0");
gc("only rapids", "G0 X1 Y1\nG0 X2 Y2");
gc("no XY at all", "G21\nG90\nM3 S1000\nG1 Z-1 F100\nM5");
gc("numbers in brackets", "G0 X0 Y0 (X99 Y99)\nG1 X5 (Y77) Y5");
gc("comment with carriage return line end", "G0 X0 Y0\r\nG1 X1 Y1 ;X9\r\nG1 Y3 ;Y8\r\n");
gc("semicolon then line separator keeps the rest", "G1 X1 ;Y7\u2028Z\nG1 X2");
gc("dotless i as arc centre", "G0 X10 Y0\nG3 X-10 Y0 \u0131-10");
gc("inch relative", "G20 G91\nG1 X1 Y0.5\nG1 X-0.5\nG90 G21");
gc("inch R arc", "G20\nG0 X0 Y0\nG2 X1 Y0 R1\nG3 X2 Y0 R-1");
gc("arc with R and no move, then rapid", "G0 X5 Y5\nG2 X5 Y5 R3\nG0 X9 Y9\nG1 X10 Y10");
gc("radius exactly the tolerance", "G0 X0.01 Y0\nG3 X-0.01 Y0 I-0.01 J0");
gc("huge radius full circle", "G0 X10000 Y0\nG3 X10000 Y0 I-10000 J0");
gc("very small angle", "G0 X10 Y0\nG3 X9.99995 Y0.01 I-10 J0");
gc("empty", "");

const want = (p: PlotParsed) => ({
  n: p.n,
  paths: p.paths.map(q => q.pts.map(v => [v.x, v.y])),
  circles: p.circles.map(c => [c.cx, c.cy, c.r]),
});
const built = cases.map(c => ({ ...c, want: want(c.kind === "hpgl" ? hpglParse(c.text) : gcodeParse(c.text)) }));

test("HPGL and G-code import: pinned result for Rust (importplt-cases.json)", () => {
  // every path point must be a number (JSON would turn NaN into null)
  for (const c of built) for (const p of c.want.paths) for (const v of p) assert.ok(v.every(Number.isFinite), `${c.name}: point ${v}`);
  const text = JSON.stringify(built) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, text);
  assert.equal(readFileSync(file, "utf8"), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
