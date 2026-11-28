// DXF import: TypeScript (src/importers/dxfParse.ts) and Rust (src-tauri/src/importdxf.rs) must read the same paths,
// circles, texts, units and counts. This test builds the shared cases and pins what the TypeScript reads in
// fixtures/importdxf-cases.json; `cargo test importdxf` compares the Rust result (numbers to 1e-9, the rest exactly).
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test importdxf
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dxfParse } from "../src/importers/dxfParse.ts";

const file = new URL("./fixtures/importdxf-cases.json", import.meta.url);
type G = [number | string, string | number];
const grp = (g: G[]) => g.map(([c, v]) => `${c}\n${v}`).join("\n");
const ent = (type: string, g: G[] = []) => grp([[0, type], ...g]);
const dxf = (ents: string[], o: { units?: number | string; blocks?: string[]; eol?: string } = {}) => {
  const parts = [];
  if (o.units !== undefined) parts.push(grp([[0, "SECTION"], [2, "HEADER"], [9, "$ACADVER"], [1, "AC1015"], [9, "$INSUNITS"], [70, o.units], [0, "ENDSEC"]]));
  if (o.blocks) parts.push(grp([[0, "SECTION"], [2, "BLOCKS"]]), ...o.blocks, grp([[0, "ENDSEC"]]));
  parts.push(grp([[0, "SECTION"], [2, "ENTITIES"]]), ...ents, grp([[0, "ENDSEC"], [0, "EOF"]]));
  return parts.join("\n").replace(/\n/g, o.eol ?? "\n");
};
const block = (name: string, base: [number, number], ents: string[]) => [ent("BLOCK", [[2, name], [10, base[0]], [20, base[1]]]), ...ents, ent("ENDBLK")].join("\n");
const line = (x0: number, y0: number, x1: number, y1: number, h = "", layer = "") => ent("LINE", [...(h ? [[5, h]] as G[] : []), ...(layer ? [[8, layer]] as G[] : []), [10, x0], [20, y0], [11, x1], [21, y1]]);
const lw = (pts: [number, number, number?][], flags = 0) => ent("LWPOLYLINE", [[90, pts.length], [70, flags], ...pts.flatMap(([x, y, b]) => [[10, x], [20, y], ...(b !== undefined ? [[42, b]] : [])] as G[])]);

const cases: { name: string; text: string }[] = [];
const add = (name: string, text: string) => cases.push({ name, text });

add("lines in mm", dxf([line(0, 0, 10, 0, "1A", "Cut"), line(10, 0, 10, 10, "1B"), line(10, 10, 0, 0)], { units: 4 }));
add("no units", dxf([line(0, 0, 5, 5)]));
add("inch", dxf([line(0, 0, 1, 2), ent("CIRCLE", [[10, 1], [20, 1], [40, 0.5]])], { units: 1 }));
for (const u of [2, 5, 6, 8, 9, 10, 13, 14, 3, 99, "4.7", "x"]) add(`units ${u}`, dxf([line(0, 0, 1, 1)], { units: u }));
add("CRLF and CR line ends", dxf([line(0, 0, 3, 4), ent("CIRCLE", [[10, 0], [20, 0], [40, 2]])], { eol: "\r\n" }));
add("old Mac line ends", dxf([line(0, 0, 3, 4)], { eol: "\r" }));
add("circle, zero and negative radius", dxf([ent("CIRCLE", [[5, "C1"], [8, "L"], [10, 5], [20, 5], [40, 3]]), ent("CIRCLE", [[10, 0], [20, 0], [40, 0]]), ent("CIRCLE", [[10, 0], [20, 0], [40, -1]])]));
add("circle mirrored by extrusion", dxf([ent("CIRCLE", [[10, 5], [20, 5], [40, 3], [230, -1]])]));
add("arcs", dxf([ent("ARC", [[10, 0], [20, 0], [40, 10], [50, 0], [51, 90]]), ent("ARC", [[10, 0], [20, 0], [40, 5], [50, 270], [51, 45]]), ent("ARC", [[10, 3], [20, 3], [40, 2], [50, 30], [51, 30]])]));
add("arc mirrored", dxf([ent("ARC", [[10, 4], [20, 1], [40, 3], [50, 10], [51, 100], [230, -1]])]));
add("ellipse full and part", dxf([ent("ELLIPSE", [[10, 0], [20, 0], [11, 20], [21, 0], [40, 0.5]]), ent("ELLIPSE", [[10, 5], [20, 5], [11, 3], [21, 4], [40, 0.3], [41, 1], [42, 4]]), ent("ELLIPSE", [[10, 0], [20, 0], [11, 0], [21, 8], [40, 0.25], [41, 5], [42, 1]])]));
add("lwpolyline open and closed", dxf([lw([[0, 0], [10, 0], [10, 10]]), lw([[20, 0], [30, 0], [30, 10], [20, 10]], 1), lw([[0, 0]]), lw([])]));
add("lwpolyline with bulges", dxf([lw([[0, 0, 1], [10, 0], [10, 10, -0.5], [0, 10]], 1), lw([[0, 0, 0.2], [5, 0, -2.5], [5, 5]]), lw([[0, 0, 1], [0, 0], [3, 0]])]));
add("lwpolyline flags 129 and odd values", dxf([ent("LWPOLYLINE", [[70, 129], [10, 1], [20, 1], [10, " 4.5e0 "], [20, "2abc"], [42, "0.3x"], [10, "nope"], [20, 7], [10, 8]])]));
add("polyline with vertices", dxf([[ent("POLYLINE", [[66, 1], [70, 1]]), ent("VERTEX", [[10, 0], [20, 0], [42, 0.4]]), ent("VERTEX", [[10, 10], [20, 0]]), ent("VERTEX", [[10, 10], [20, 10], [70, 16]]), ent("VERTEX", [[10, 0], [20, 10]]), ent("SEQEND")].join("\n"), line(0, 0, 1, 1)]));
add("polyline 3D mesh is skipped", dxf([[ent("POLYLINE", [[70, 16]]), ent("VERTEX", [[10, 0], [20, 0]]), ent("VERTEX", [[10, 1], [20, 0]]), ent("SEQEND")].join("\n"), [ent("POLYLINE", [[70, 64]]), ent("SEQEND")].join("\n")]));
add("polyline without SEQEND", dxf([[ent("POLYLINE", [[70, 0]]), ent("VERTEX", [[10, 0], [20, 0]]), ent("VERTEX", [[10, 4], [20, 4]])].join("\n"), line(9, 9, 8, 8)]));
add("spline NURBS", dxf([ent("SPLINE", [[70, 8], [71, 3], [72, 8], [73, 4], ...[0, 0, 0, 0, 1, 1, 1, 1].map(k => [40, k] as G), [10, 0], [20, 0], [10, 5], [20, 10], [10, 10], [20, -10], [10, 15], [20, 0]])]));
add("spline closed periodic", dxf([ent("SPLINE", [[70, 11], [71, 2], ...[0, 0, 0, 1, 2, 3, 3, 3].map(k => [40, k] as G), [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 10], [10, 0], [20, 10], [10, 0], [20, 0]])]));
add("spline rational with weights", dxf([ent("SPLINE", [[71, 2], ...[0, 0, 0, 1, 1, 1].map(k => [40, k] as G), [10, 10], [20, 0], [41, 1], [10, 10], [20, 10], [41, 0.7071067811865476], [10, 0], [20, 10], [41, 1]])]));
add("spline degree 1 and wrong weights", dxf([ent("SPLINE", [[71, 1], ...[0, 0, 1, 2, 2].map(k => [40, k] as G), [10, 0], [20, 0], [10, 3], [20, 4], [10, 6], [20, 0], [41, 2]])]));
add("spline fit points only", dxf([ent("SPLINE", [[71, 3], [11, 0], [21, 0], [11, 10], [21, 5], [11, 20], [21, 0], [11, 30], [21, 8]]), ent("SPLINE", [[11, 0], [21, 0], [11, 0.01]]), ent("SPLINE", [[10, 1], [20, 1]])]));
add("spline closed by its points", dxf([ent("SPLINE", [[71, 1], ...[0, 0, 1, 2, 3, 3].map(k => [40, k] as G), [10, 0], [20, 0], [10, 4], [20, 0], [10, 4], [20, 4], [10, 0], [20, 0]])]));
add("solid, trace, 3dface", dxf([ent("SOLID", [[10, 0], [20, 0], [11, 4], [21, 0], [12, 0], [22, 3], [13, 4], [23, 3]]), ent("TRACE", [[10, 5], [20, 5], [11, 6], [21, 5], [12, 5], [22, 6], [13, 6], [23, 6]]), ent("3DFACE", [[10, 0], [20, 0], [11, 1], [21, 0], [12, 1], [22, 1], [13, 0], [23, 1]])]));
const sq = [line(0, 0, 2, 0, "B1", "0"), line(2, 0, 2, 2, "B2", "Own"), ent("CIRCLE", [[5, "B3"], [10, 1], [20, 1], [40, 0.5]]), ent("TEXT", [[1, "in block"], [10, 0], [20, 3], [40, 1]])];
add("insert block, scaled and turned", dxf([ent("INSERT", [[5, "I1"], [8, "Top"], [2, "SQ"], [10, 10], [20, 10], [41, 2], [42, 2], [50, 30]]), ent("INSERT", [[2, "SQ"], [10, -5], [20, 0]])], { blocks: [block("SQ", [1, 1], sq)] }));
add("insert not uniform turns circles into paths", dxf([ent("INSERT", [[5, "I2"], [2, "SQ"], [10, 0], [20, 0], [41, 3], [42, 1], [50, 45]])], { blocks: [block("SQ", [0, 0], sq)] }));
add("insert array rows and columns", dxf([ent("INSERT", [[5, "AR"], [2, "SQ"], [10, 0], [20, 0], [50, 90], [70, 3], [71, 2], [44, 5], [45, 7]]), ent("INSERT", [[2, "SQ"], [70, 1.5], [71, 0], [44, 4]])], { blocks: [block("SQ", [0, 0], sq)] }));
add("insert mirrored", dxf([ent("INSERT", [[5, "M"], [2, "SQ"], [10, 0], [20, 0], [41, -1], [230, -1]])], { blocks: [block("SQ", [0, 0], sq)] }));
add("nested blocks", dxf([ent("INSERT", [[5, "N1"], [8, "Outer"], [2, "OUT"], [10, 100], [20, 0], [50, 15]])], { units: 5, blocks: [block("IN", [0, 0], [line(0, 0, 1, 0, "L1"), ent("ARC", [[5, "A1"], [10, 0], [20, 0], [40, 1], [50, 0], [51, 180]])]), block("OUT", [0, 0], [ent("INSERT", [[5, "N2"], [8, "0"], [2, "IN"], [10, 5], [20, 5], [41, 2], [42, 2]]), ent("INSERT", [[2, "IN"], [10, -5], [20, 5]]), line(0, 0, 0, 9, "L2", "")])] }));
add("block inserts itself", dxf([ent("INSERT", [[5, "R0"], [2, "LOOP"], [10, 1], [20, 0]])], { blocks: [block("LOOP", [0, 0], [line(0, 0, 1, 0, "X"), ent("INSERT", [[5, "R"], [2, "LOOP"], [10, 1], [20, 0], [41, 0.9], [42, 0.9]])])] }));
add("missing block and unknown entities", dxf([ent("INSERT", [[2, "NONE"]]), ent("POINT", [[10, 1], [20, 1]]), ent("DIMENSION"), ent("HATCH"), ent("HATCH"), ent("WEIRD"), ent("12"), ent("3"), line(0, 0, 1, 0)]));
add("texts", dxf([ent("TEXT", [[5, "T1"], [1, "Hello %%c10 %%d %%p0.1 100%%%"], [10, 2], [20, 3], [40, 5], [50, 30]]), ent("TEXT", [[1, "aligned"], [10, 0], [20, 0], [11, 7], [21, 8], [72, 1], [40, 2]]), ent("TEXT", [[1, "aligned no 11"], [10, 1], [20, 1], [73, 2]]), ent("TEXT", [[1, "   "], [10, 0], [20, 0]]), ent("TEXT", [[10, 0], [20, 0]]), ent("ATTRIB", [[1, "attr"], [10, 4], [20, 4], [40, 1.5]])], { units: 1 }));
add("mtext with codes", dxf([ent("MTEXT", [[3, "{\\fArial|b1;Line \\Pone}"], [3, "\\H2.5;big\\L under\\l \\S1/2; \\S3#4;"], [1, "\\~end\\\\x \\Cred \\Wnot closed"], [10, 1], [20, 9], [40, 3], [71, 7]]), ent("MTEXT", [[1, "top\\Pleft"], [10, 0], [20, 0], [40, 2], [71, 1], [11, 0], [21, 1]]), ent("MTEXT", [[1, "x"], [10, 0], [20, 0], [71, 0]]), ent("MTEXT", [[1, "\\Ttight;\\Q15;\\A1;{}"], [10, 0], [20, 0]])]));
add("text in turned insert", dxf([ent("INSERT", [[2, "TX"], [10, 0], [20, 0], [50, 90], [41, 2], [42, 2]])], { blocks: [block("TX", [0, 0], [ent("MTEXT", [[1, "mt"], [10, 1], [20, 1], [40, 1]]), ent("TEXT", [[1, "t"], [10, 2], [20, 2]])])] }));
add("shifted lines and junk codes", "0\nSECTION\n2\nENTITIES\n  0  \nLINE\nxx\n10\n1\n20\n2\n11\n3\n21\n4\n0\nENDSEC\n0\nEOF");
add("entities before any section and in an unknown section", grp([[0, "LINE"], [10, 0], [20, 0], [11, 1], [21, 1], [0, "SECTION"], [2, "OBJECTS"], [0, "LINE"], [10, 0], [20, 0], [11, 2], [21, 2], [0, "ENDSEC"]]) + "\n" + dxf([line(0, 0, 3, 3)]));
add("block in entities section", dxf([block("B", [0, 0], [line(0, 0, 1, 1)]), ent("INSERT", [[2, "B"], [10, 5], [20, 5]])]));
add("too big numbers fall back", dxf([ent("LINE", [[10, "1e400"], [20, 2], [11, "-Infinity"], [21, 3]]), ent("CIRCLE", [[10, 1], [20, 1], [40, "Infinity"]])]));
add("spaces round handle, layer and section", "0\nSECTION\n2\n  ENTITIES  \n" + ent("LINE", [[5, " H1 "], [8, " Cut "], [10, 0], [20, 0], [11, 1], [21, 1]]) + "\n0\nENDSEC\n0\nEOF");
add("type names that look like numbers", dxf([ent("012"), ent("5"), ent("-1"), ent("4294967295"), ent("4294967294"), ent("1.5"), line(0, 0, 1, 1)]));
add("ellipse without ratio", dxf([ent("ELLIPSE", [[10, 0], [20, 0], [11, 6], [21, 2]])]));
add("spline with too many weights", dxf([ent("SPLINE", [[71, 2], ...[0, 0, 0, 1, 1, 1].map(k => [40, k] as G), [10, 0], [20, 0], [41, 1], [10, 5], [20, 5], [41, 3], [10, 10], [20, 0], [41, 1], [41, 7]])]));
add("tiny spline with many points", dxf([ent("SPLINE", [[71, 3], ...[0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 7, 7, 7].map(k => [40, k] as G), ...Array.from({ length: 10 }, (_, i) => [[10, i * 0.01], [20, (i % 2) * 0.01]] as G[]).flat()])]));
add("spline with a full interior knot", dxf([ent("SPLINE", [[71, 2], ...[0, 0, 0, 1, 1, 1, 2, 2, 2].map(k => [40, k] as G), [10, 0], [20, 0], [10, 5], [20, 9], [10, 10], [20, 0], [10, 20], [20, 5], [10, 25], [20, -5], [10, 30], [20, 0]])]));
add("upper case percent codes and aligned by 73", dxf([ent("TEXT", [[1, "%%C5 %%D %%P1 %%%%"], [10, 0], [20, 0]]), ent("TEXT", [[1, "right"], [10, 1], [20, 1], [11, 9], [21, 9], [73, 3]])]));
add("mtext codes O K and blank after codes", dxf([ent("MTEXT", [[1, "\\Oover\\o \\Kstrike\\k \\lx"], [10, 0], [20, 0]]), ent("MTEXT", [[1, "{ }"], [10, 0], [20, 0]]), ent("MTEXT", [[1, "\\P"], [10, 0], [20, 0]])]));
add("skewed by a non-uniform outer insert", dxf([ent("INSERT", [[2, "OUT"], [10, 0], [20, 0], [41, 3], [42, 1]])], { blocks: [block("C", [0, 0], [ent("CIRCLE", [[10, 2], [20, 0], [40, 1]])]), block("OUT", [0, 0], [ent("INSERT", [[2, "C"], [10, 0], [20, 0], [50, 45]])])] }));
add("binary", "AutoCAD Binary DXF\r\n\x1a\x00");
add("empty", "");

const built = cases.map(c => ({ ...c, want: dxfParse(c.text) }));

test("DXF import: pinned result for Rust (importdxf-cases.json)", () => {
  // every number must be finite (JSON would turn NaN into null)
  const finite = (v: unknown, at: string): void => {
    if (typeof v === "number") assert.ok(Number.isFinite(v), at);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) finite(x, `${at}.${k}`);
  };
  for (const c of built) finite(c.want, c.name);
  const text = JSON.stringify(built) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, text);
  assert.equal(readFileSync(file, "utf8"), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
