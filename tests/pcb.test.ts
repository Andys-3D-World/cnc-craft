import test from "node:test";
import assert from "node:assert/strict";
import { gerberBox, looksLikeGerber, macroExpr, parseGerber } from "../src/pcb/gerber.ts";
import { bySize, looksLikeExcellon, parseExcellon } from "../src/pcb/excellon.ts";
import { addObjects, bridges, clipLoop, contours, cutWidth, isolate, makeGrid, nets, passLevels, redistance } from "../src/pcb/field.ts";
import { polygonArea } from "../src/polyOffset.ts";

import { boardOf, buildDescs, guessRole, holeMode, holesOff, outlineLoops, pickHoleTool, placer, readPcbFile, slotOutline } from "../src/pcb/pcbJob.ts";
import { surelyExcellon } from "../src/pcb/excellon.ts";

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);
const HEAD = "%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.5*%\n%ADD11R,2X1*%\n%ADD12O,3X1*%\n%ADD13C,2X1*%\n";
const G = (body: string) => parseGerber(HEAD + body + "M02*\n");
const dist = (p: { x: number; y: number }, ax: number, ay: number, bx: number, by: number) => { const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p.x - ax - t * dx, p.y - ay - t * dy); };

// ---------------- Gerber ----------------
test("gerber: strokes, flashes, units and formats (hand-worked)", () => {
  const g = G("D10*\nX1000000Y2000000D02*\nX11000000D01*\nD11*\nX5000000Y5000000D03*\n");
  assert.deepEqual(g.objs[0], { k: "stroke", dark: true, a: [1, 2], b: [11, 2], r: 0.25 });
  assert.deepEqual((g.objs[1] as any).parts[0].p, [[4, 4.5], [6, 4.5], [6, 5.5], [4, 5.5]]);
  assert.deepEqual(gerberBox(g.objs), { x0: 0.75, y0: 1.75, x1: 11.25, y1: 5.5 });
  assert.deepEqual(g.warnings, []);
  // Zoll 2.4, vorne abgeschnitten; und hinten abgeschnitten
  const inch = parseGerber("%FSLAX24Y24*%%MOIN*%%ADD10C,0.01*%D10*X10000Y-5000D03*M02*");
  near((inch.objs[0] as any).parts[0].c[0], 25.4); near((inch.objs[0] as any).parts[0].c[1], -12.7);
  const tz = parseGerber("%FSTAX24Y24*%%MOIN*%%ADD10C,0.01*%D10*X01Y00D03*M02*");
  near((tz.objs[0] as any).parts[0].c[0], 25.4);
  assert.ok(looksLikeGerber(HEAD) && !looksLikeGerber("G21\nG90\nG0 X1"));
});

test("gerber: arcs, quadrant modes, regions, polarity, step and repeat", () => {
  // Viertelkreis um (0,0) von (10,0) nach (0,10), Radius 10
  const a = G("G75*D10*X10000000Y0D02*G03X0Y10000000I-10000000J0D01*");
  for (const o of a.objs) if (o.k === "stroke") near(Math.hypot(o.b[0], o.b[1]), 10, 1e-6);
  assert.deepEqual((a.objs[a.objs.length - 1] as any).b, [0, 10]);
  // im Viertelkreis-Modus ohne Vorzeichen: gleiche Bahn
  const q = G("G74*D10*X10000000Y0D02*G03X0Y10000000I10000000J0D01*");
  assert.equal(q.objs.length, a.objs.length);
  near((q.objs[3] as any).b[0], (a.objs[3] as any).b[0], 1e-9);
  // Vollkreis: Anfang = Ende
  const f = G("G75*D10*X5000000Y0D02*G02X5000000Y0I-5000000J0D01*");
  near(Math.min(...f.objs.map(o => (o as any).b[0])), -5, 0.01);
  const r = G("G36*X0Y0D02*X10000000D01*Y10000000D01*X0D01*Y0D01*G37*%LPC*%D10*X5000000Y5000000D03*");
  assert.equal(r.objs[0].k, "poly"); assert.equal(r.objs[0].dark, true); assert.equal(r.objs[1].dark, false);
  const sr = G("%SRX3Y2I20J10*%D10*X0Y0D03*%SR*%X1000000Y0D03*");
  assert.equal(sr.objs.length, 7);
  near((sr.objs[5] as any).parts[0].c[0], 40); near((sr.objs[5] as any).parts[0].c[1], 10);
});

test("gerber: macros (rounded rectangle, thermal), expressions, attributes, unknown things are reported", () => {
  near(macroExpr("$1x2+(3-$2)/4", { 1: 1.5, 2: 1 }), 3.5);
  near(macroExpr("-$1", { 1: 2 }), -2);
  const g = G("%AMRR*4,1,4,-1,-0.5,1,-0.5,1,0.5,-1,0.5,-1,-0.5,$1*1,1,0.4,0,0*%%ADD20RR,90*%D20*X0Y0D03*");
  const p = (g.objs[0] as any).parts;
  near(p[0].p[0][0], 0.5, 1e-9); near(p[0].p[0][1], -1, 1e-9); // 90° gedreht
  near(p[1].c[2], 0.2);
  const th = G("%AMTH*7,0,0,3,2,0.4,0*%%ADD21TH*%D21*X0Y0D03*");
  assert.equal((th.objs[0] as any).parts.length, 4);
  assert.equal(parseGerber("%TF.FileFunction,Copper,L1,Top*%" + HEAD + "M02*").func, "Copper,L1,Top");
  assert.equal(parseGerber("G04 #@! TF.FileFunction,Profile,NP*" + HEAD + "M02*").func, "Profile,NP");
  assert.deepEqual(G("D99*X0Y0D03*").warnings, ["aperture"]);
  assert.ok(G("%ABD30*%%AB*%").warnings.includes("block"));
  assert.ok(parseGerber("%FSLAX46Y46*%%ADD10C,1*%D10*X0Y0D03*M02*").warnings.includes("units"));
  // veraltete Form: Koordinaten ohne D-Befehl wiederholen den letzten
  assert.equal(G("D10*X0Y0D02*X1000000D01*X2000000*").objs.length, 2);
  // Müll wirft nicht
  for (const s of ["", "%%%%", "****", "%ADD*%", "%AMX*9,9,9*%%ADD50X*%D50*X0Y0D03*", "G36*G37*", "X9Y9D01*"]) parseGerber(s);
});

// ---------------- Excellon ----------------
test("excellon: decimal, implied formats, slots, repeats, routing", () => {
  const k = parseExcellon("M48\n; #@! TF.FileFunction,Plated,1,2,PTH\nFMAT,2\nMETRIC\nT1C0.800\nT2C1.000\n%\nG90\nG05\nT1\nX10.0Y-5.5\nX12.0\nT2\nX1.0Y2.0G85X4.0Y2.0\nT0\nM30\n");
  assert.deepEqual(k.holes, [{ x: 10, y: -5.5, d: 0.8 }, { x: 12, y: -5.5, d: 0.8 }]);
  assert.deepEqual(k.slots, [{ pts: [[1, 2], [4, 2]], d: 1 }]);
  assert.equal(k.plated, "plated"); assert.equal(k.guessed, false); assert.deepEqual(k.warnings, []);
  // Zoll, hintere Nullen weggelassen (LZ): X01 = 1 Zoll
  const lz = parseExcellon("M48\nINCH,LZ\nT01C0.0320\n%\nT01\nX01Y005\nM30");
  near(lz.holes[0].x, 25.4); near(lz.holes[0].y, 12.7); near(lz.holes[0].d, 0.8128); assert.equal(lz.guessed, true);
  // metrisch, vordere Nullen weggelassen, Format in der Datei
  const tz = parseExcellon(";FILE_FORMAT=4:4\nM48\nMETRIC,TZ\nT1F00S00C0.9\n%\nT01\nX25400Y127000\nR3X10000\nM30");
  near(tz.holes[0].x, 2.54); near(tz.holes[0].y, 12.7); assert.equal(tz.holes.length, 4); near(tz.holes[3].x, 5.54); assert.equal(tz.guessed, false);
  const fmt = parseExcellon("M48\nMETRIC,TZ,000.00\nT1C1\n%\nT1\nX1234Y0\nM30");
  near(fmt.holes[0].x, 12.34);
  const rt = parseExcellon("M48\nMETRIC\nT1C1.2\n%\nT1\nG00X0.0Y0.0\nM15\nG01X5.0Y0.0\nG01X5.0Y3.0\nM16\nG05\nX9.0Y9.0\nM30");
  assert.deepEqual(rt.slots[0].pts, [[0, 0], [5, 0], [5, 3]]);
  assert.equal(rt.holes.length, 1);
  assert.ok(parseExcellon("T1\nX1.0Y1.0").warnings.includes("tool"));
  assert.ok(looksLikeExcellon("M48\nMETRIC") && !looksLikeExcellon("G21\nG0 X1 Y1\nM30"));
  assert.deepEqual(bySize([{ x: 0, y: 0, d: 0.8 }, { x: 1, y: 0, d: 0.3 }, { x: 2, y: 0, d: 0.8004 }]).map(s => [s.d, s.holes.length]), [[0.3, 1], [0.8, 2]]);
});

// ---------------- Isolation ----------------
test("isolation of a trace: every point of the path has exactly the wanted distance", () => {
  const g = G("D10*X0Y0D02*X20000000Y7000000D01*");
  const r = isolate({ objs: g.objs, box: gerberBox(g.objs)!, width: 0.2, passes: 3, overlap: 0.5 });
  assert.equal(r.nets, 1); assert.equal(r.bridges.length, 0);
  const lv = passLevels(0.2, 3, 0.5);
  assert.deepEqual(lv.map(v => +v.toFixed(3)), [0.1, 0.2, 0.3]);
  for (const l of r.lines) if (l.pass === 0) for (const p of l.pts) near(dist(p, 0, 0, 20, 7) - 0.25, 0.1, 0.006);
  assert.equal(r.lines.filter(l => l.pass === 0).length, 1);
  for (const c of r.copper) for (const p of c) near(dist(p, 0, 0, 20, 7), 0.25, 0.006);
});

test("isolation of a rectangle pad: straight sides exact, corners round, oriented round the copper", () => {
  const g = G("D11*X5000000Y5000000D03*");
  const r = isolate({ objs: g.objs, box: gerberBox(g.objs)!, width: 0.3, passes: 1, overlap: 0 });
  const l = r.lines[0].pts;
  assert.ok(polygonArea(l) > 0);
  // Fläche: 2×1 + Umfang·0,15 + π·0,15²
  near(polygonArea(l), 2 + 6 * 0.15 + Math.PI * 0.15 ** 2, 0.01);
  near(Math.min(...l.map(p => p.x)), 4 - 0.15, 0.003); near(Math.max(...l.map(p => p.y)), 5.5 + 0.15, 0.003);
});

test("cut-outs: region with clear polarity and pad with a hole keep the right distance on the inside too", () => {
  // Fläche 10×10, darin ein gelöschter Kreis Ø 4, darin ein Pad Ø 1
  const g = parseGerber(HEAD + "%ADD30C,4*%%ADD31C,1*%G36*X0Y0D02*X10000000D01*Y10000000D01*X0D01*Y0D01*G37*%LPC*%D30*X5000000Y5000000D03*%LPD*%D31*X5000000Y5000000D03*M02*");
  const r = isolate({ objs: g.objs, box: gerberBox(g.objs)!, width: 0.4, passes: 1, overlap: 0 });
  assert.equal(r.nets, 2); assert.equal(r.bridges.length, 0); assert.equal(r.lines.length, 3);
  const rad = r.lines.map(l => Math.max(...l.pts.map(p => Math.hypot(p.x - 5, p.y - 5)))).sort((a, b) => a - b);
  near(rad[0], 0.7, 0.02);  // um das Pad
  near(rad[1], 1.8, 0.02);  // innen an der Fläche
  const hole = parseGerber(HEAD + "D13*X0Y0D03*M02*");
  const h = isolate({ objs: hole.objs, box: gerberBox(hole.objs)!, width: 0.2, passes: 1, overlap: 0 });
  assert.equal(h.copper.length, 2);
  const areas = h.copper.map(l => Math.abs(polygonArea(l))).sort((a, b) => a - b);
  near(areas[0], Math.PI * 0.25, 0.01); near(areas[1], Math.PI, 0.01);
});

test("too narrow gaps are found with place and width; wide gaps are not reported", () => {
  // zwei Pads Ø 0,5: Mitten 0,65 mm auseinander → Lücke 0,15 mm
  const g = G("D10*X0Y0D03*X650000Y0D03*X5000000Y0D03*");
  const job = { objs: g.objs, box: gerberBox(g.objs)!, passes: 1, overlap: 0 };
  const bad = isolate({ ...job, width: 0.3 });
  assert.equal(bad.nets, 3); assert.equal(bad.bridges.length, 1);
  near(bad.bridges[0].gap, 0.15, 0.04); near(bad.bridges[0].x, 0.325, 0.06); near(bad.minGap, bad.bridges[0].gap);
  assert.equal(isolate({ ...job, width: 0.1 }).bridges.length, 0);
  // gleiches Netz (überlappende Striche) ist keine Brücke
  const one = G("D10*X0Y0D02*X5000000D01*X5000000Y5000000D01*D11*X5000000Y5000000D03*");
  const o = isolate({ objs: one.objs, box: gerberBox(one.objs)!, width: 0.3, passes: 1, overlap: 0 });
  assert.equal(o.nets, 1); assert.equal(o.bridges.length, 0); assert.equal(o.lines.length, 1);
});

test("random board: the cutter never touches copper (checked against the exact shapes)", () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const n = (v: number) => Math.round(v * 1e6);
  let body = "", segs: number[][] = [], pads: number[][] = [];
  for (let k = 0; k < 40; k++) { const x = rnd() * 30, y = rnd() * 20, x2 = x + rnd() * 8 - 4, y2 = y + rnd() * 8 - 4; segs.push([x, y, x2, y2]); body += `D10*X${n(x)}Y${n(y)}D02*X${n(x2)}Y${n(y2)}D01*`; }
  for (let k = 0; k < 25; k++) { const x = rnd() * 30, y = rnd() * 20; pads.push([x, y]); body += `D11*X${n(x)}Y${n(y)}D03*`; }
  const g = G(body), w = 0.2, r = isolate({ objs: g.objs, box: gerberBox(g.objs)!, width: w, passes: 2, overlap: 0.4 });
  let pts = 0;
  for (const l of r.lines) for (const p of l.pts) {
    pts++;
    const d = Math.min(...segs.map(s => dist(p, s[0], s[1], s[2], s[3]) - 0.25), ...pads.map(q => { const ex = Math.abs(p.x - q[0]) - 1, ey = Math.abs(p.y - q[1]) - 0.5; return Math.hypot(Math.max(ex, 0), Math.max(ey, 0)) + Math.min(0, Math.max(ex, ey)); }));
    assert.ok(d >= w / 2 - 0.012, `cuts into copper: ${d}`);
    if (l.pass === 0) assert.ok(d <= w / 2 + 0.03, `too far: ${d}`);
  }
  assert.ok(pts > 500);
});

test("clipping, cut width, pass count", () => {
  const c = clipLoop([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], { x0: -1, y0: -1, x1: 5, y1: 11 });
  assert.equal(c.length, 1); assert.equal(c[0].closed, false);
  assert.deepEqual([c[0].pts[0], c[0].pts[c[0].pts.length - 1]], [{ x: 5, y: 10 }, { x: 5, y: 0 }]);
  near(cutWidth({ type: "vbit", diameter: 3, angle: 30, tipDia: 0.1 }, -0.1), 0.1 + 0.2 * Math.tan(15 * Math.PI / 180), 1e-9);
  near(cutWidth({ type: "endmill", diameter: 0.8, angle: 0, tipDia: 0 }, -0.1), 0.8);
  assert.equal(passLevels(0.2, 999, 0).length, 40);
  const g = makeGrid(0, 0, 4, 4, 0.1, 1);
  addObjects(g, [{ k: "stroke", dark: true, a: [2, 2], b: [2, 2], r: 0.5 }]);
  assert.equal(nets(g).n, 1); assert.equal(contours(g, 0).length, 1); redistance(g); near(contours(g, 0.3)[0][0].x - 2 ? Math.hypot(contours(g, 0.3)[0][0].x - 2, contours(g, 0.3)[0][0].y - 2) : 0.8, 0.8, 0.02);
  assert.equal(bridges(g, 0.5).list.length, 0);
});

// ---------------- Platine → Formen ----------------
test("roles from attributes and names; unknown files are not taken", () => {
  for (const [n, f, r] of [["a.gbr", "Copper,L1,Top", "top"], ["a.gbr", "Copper,L2,Bot", "bottom"], ["a.gbr", "Profile,NP", "outline"], ["a.gbr", "Soldermask,Top", "ignore"],
    ["x-F_Cu.gbr", "", "top"], ["x-B_Cu.gbr", "", "bottom"], ["x-F_Mask.gbr", "", "ignore"], ["x-Edge_Cuts.gbr", "", "outline"], ["b.GTL", "", "top"], ["b.gbl", "", "bottom"], ["b.gko", "", "outline"], ["b.gto", "", "ignore"],
    ["copper_top.gbr", "", "top"], ["profile.gbr", "", "outline"]] as const) assert.equal(guessRole(n, f), r, n + f);
  assert.equal(readPcbFile("a.txt", "hello world"), null);
  assert.equal(readPcbFile("a.gbr", HEAD + "M02*")!.role, "ignore");
  assert.equal(readPcbFile("a.drl", "M48\nMETRIC\nT1C0.8\n%\nT1\nX1.0Y1.0\nM30")!.role, "drill");
  assert.ok(surelyExcellon("M48\nMETRIC,TZ\nT01C0.8\n%"));
  assert.ok(!surelyExcellon("G21\nM48\nG0 X1")); assert.ok(!surelyExcellon("%\nO1\nM48\nG0X1"));
});

const L = (...p: number[][]) => p as [number, number][];
test("outline: loose lines in any order become closed loops, biggest first, doubles once, open lines counted", () => {
  const sq = [L([0, 0], [40, 0]), L([40, 30], [40, 0]), L([0, 30], [40, 30]), L([0, 30], [0, 0.02])];
  const r = outlineLoops([...sq, L([10, 10], [15, 10], [15, 15], [10, 15], [10, 10]), ...sq.map(l => l.slice()), L([50, 0], [60, 0])]);
  assert.equal(r.loops.length, 2); assert.equal(r.open, 1);
  near(Math.abs(polygonArea(r.loops[0])), 1200, 1); near(Math.abs(polygonArea(r.loops[1])), 25, 1e-6);
});

test("board, placing, mirroring, hole tools and shapes", () => {
  const files = [
    readPcbFile("b-Edge_Cuts.gbr", parseHead("D10*X100000000Y50000000D02*X140000000D01*Y80000000D01*X100000000D01*Y50000000D01*"))!,
    readPcbFile("b-B_Cu.gbr", parseHead("D10*X110000000Y60000000D03*"))!,
    readPcbFile("b.drl", "M48\nMETRIC\nT1C0.8\nT2C3.2\nT3C1.0\nT4C0.55\n%\nT1\nX110.0Y60.0\nT2\nX105.0Y55.0\nT3\nX120.0Y70.0G85X125.0Y70.0\nT4\nX112.0Y60.0\nM30")!,
  ];
  const b = boardOf(files)!;
  assert.deepEqual(b.box, { x0: 100, y0: 50, x1: 140, y1: 80 });
  assert.equal(holesOff(b), 0);
  assert.equal(holesOff({ ...b, holes: [{ x: 1, y: 1, d: 1 }] }), 1);
  const top = placer(b.box, { x: 10, y: 5 }, false), bot = placer(b.box, { x: 10, y: 5 }, true);
  assert.deepEqual(top({ x: 110, y: 60 }), { x: 20, y: 15 });
  assert.deepEqual(bot({ x: 110, y: 60 }), { x: 40, y: 15 }); // von rechts gezählt
  const tools = [{ id: "d8", type: "drill", diameter: 0.8 }, { id: "e1", type: "endmill", diameter: 1 }, { id: "e2", type: "endmill", diameter: 2 }, { id: "v", type: "vbit", diameter: 3.2 }];
  assert.equal(pickHoleTool(0.8, tools)!.id, "d8"); assert.equal(pickHoleTool(3.2, tools)!.id, "e2"); assert.equal(pickHoleTool(1, tools)!.id, "e1"); assert.equal(pickHoleTool(0.55, tools), null);
  assert.equal(holeMode(3.2, tools[3]), "no"); assert.equal(holeMode(0.9, tools[0]), "no"); assert.equal(holeMode(0.83, tools[0]), "drill"); assert.equal(holeMode(3.2, tools[2]), "mill"); assert.equal(holeMode(1.9, tools[2]), "no");
  const { descs, skipped } = buildDescs(b, {
    place: bot, mirror: true, iso: { lines: [{ pts: [{ x: 110, y: 60 }, { x: 111, y: 60 }, { x: 111, y: 61 }], closed: true, pass: 0 }], toolId: "v", depth: 0.1 },
    drill: { tool: d => pickHoleTool(d, tools), depth: 1.9 }, outline: { tool: tools[2], depth: 1.8, tabs: true },
  });
  assert.equal(skipped, 1);
  assert.deepEqual(descs.map(d => [d.kind, d.mode, d.depth, d.toolId, d.tabs]), [["iso", "on-line", -0.1, "v", false], ["hole", "drill", -1.9, "d8", false], ["hole", "inside", -1.9, "e2", false], ["slot", "on-line", -1.9, "e1", false], ["outline", "outside", -1.8, "e2", true]]);
  // gespiegelt: Umlaufsinn bleibt wie bei der Vorderseite
  assert.ok(polygonArea(descs[0].pts) > 0);
  assert.equal(buildDescs({ ...b, holes: [{ x: 1, y: 1, d: 0.55 }], slots: [], loops: [] }, { place: top, mirror: false, iso: null, drill: { tool: () => null, depth: 2 }, outline: null }).skipped, 1);
  const ring = slotOutline([[0, 0], [5, 0]], 2)!;
  near(Math.abs(polygonArea(ring)), 10 + Math.PI, 0.02);
  // ohne Kontur: Platine aus Kupfer und Löchern
  const c = boardOf(files.slice(1))!;
  assert.equal(c.source, "content"); near(c.box.x1, 112.275, 1e-6);
});
function parseHead(body: string) { return HEAD + body + "M02*\n"; }
