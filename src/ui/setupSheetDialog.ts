/**
 * EINRICHTEBLATT: Fenster in der App mit Drucken und Speichern als HTML-Datei.
 * Bewusst kein eigenes Fenster/iframe (CSP: frame-src none): die Seite liegt über der App, beim Drucken wird nur sie
 * ausgegeben (styles.css @media print). Die gespeicherte Datei geht in jedem Browser, falls Drucken hier nicht klappt.
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { t, currentLanguage } from "../i18n/i18n";
import { state } from "../main";
import { streamState } from "../machineStream";
import { generateGcode, lastGcodeWarnings, lastGcodeNotes, noGcodeMessage } from "../cam";
import { machine } from "../machine";
import { getMachineMode } from "../machineMode";
import { getStock } from "../stock";
import { parseGcodeProgram, MOVE_CUT } from "../sim/gcodeParser";
import { motionLimits } from "../sim/motionLimits";
import { getTool, toolForShape, toolNumber } from "../toolLibrary";
import { extraOps } from "../ops";
import { layersUsedBy } from "../laserLayers";
import { cutForShape } from "../plasmaCuts";
import { isKeepOut, keepValues } from "../keepOut";
import { zonesFromShapes } from "../keepOutShapes";
import { limitReport } from "./limitGuard";
import { jobSvg, sheetDocument, sheetHtml, summarizeJob, zeroPosition, SheetData, SheetMarks, SheetSide, SheetTool, SheetTwo, SHEET_CSS } from "../setupSheet";
import { activeSetup, depthWarnings, pinTool, pinWarnings } from "../twoSidedJob";
import { skinInfo } from "../skinNotes";
import { sideShapes } from "../editor/beds";
import { flipLine, mirrorPoint, type Side, type TwoSidedSetup } from "../twoSided";


function fmtTime(s: number): string {
  const m = Math.round(s / 60);
  if (s < 60) return `${Math.round(s)} s`;
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

function toolRows(fromDrawing: boolean, list: any[] = state.shapes, extra: any[] = []): SheetTool[] {
  if (!fromDrawing) return [];
  const shapes = list.filter((s: any) => !isKeepOut(s) && s.type !== "image");
  const mode = getMachineMode();
  if (mode === "laser") return layersUsedBy(shapes).map((l, i) => ({
    no: String(i + 1), name: l.name, dia: "–", type: [l.material, l.thickness > 0 ? `${+l.thickness.toFixed(2)} mm` : ""].filter(Boolean).join(" "), len: "–"
  }));
  if (mode === "plasma") {
    const seen = new Set<any>(), rows: SheetTool[] = [];
    for (const s of shapes) {
      const c = cutForShape(s);
      if (!c || seen.has(c)) continue;
      seen.add(c);
      rows.push({ no: String(rows.length + 1), name: c.name, dia: c.kerf ? `${c.kerf} mm` : "–", type: "", len: "–" });
    }
    return rows;
  }
  const seen = new Set<string>(), rows: SheetTool[] = [];
  const add = (tl: any) => {
    if (!tl || seen.has(tl.id)) return;
    seen.add(tl.id);
    rows.push({ no: `T${toolNumber(tl)}`, name: tl.name, dia: `${tl.diameter} mm`, type: t("tl.type." + tl.type), len: tl.length ? `${tl.length} mm` : "–" });
  };
  for (const s of shapes) {
    add(toolForShape(s));
    for (const op of extraOps(s)) add(getTool(op.toolId));
  }
  extra.forEach(add);
  return rows;
}

/** Was das Blatt aus einem Programm liest: Rahmen der Schnitte, Bearbeitungen, Zeit, Bild */
function programInfo(lines: string[], zones: { pts: { x: number; y: number }[] }[], marks?: SheetMarks) {
  const motion = motionLimits();
  const prog = parseGcodeProgram(lines, { motion });
  const isCut = (i: number) => prog.type[i] === MOVE_CUT;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < prog.n; i++) {
    if (!isCut(i)) continue;
    minX = Math.min(minX, prog.x0[i], prog.x1[i]); maxX = Math.max(maxX, prog.x0[i], prog.x1[i]);
    minY = Math.min(minY, prog.y0[i], prog.y1[i]); maxY = Math.max(maxY, prog.y0[i], prog.y1[i]);
  }
  const has = minX !== Infinity;
  const { ops, changes } = summarizeJob(lines);
  // Zwiebelhaut (onionSkin.ts): steht im Programm – bleibt sie stehen, hängen die Teile nach dem Job noch daran
  const sk = skinInfo(lines);
  const h = sk ? (sk.hMax - sk.hMin > 0.005 ? `${sk.hMin.toFixed(2)}–${sk.hMax.toFixed(2)}` : sk.hMax.toFixed(2)) : "";
  const skin = sk ? [sk.shapes - sk.cut > 0 ? t("sheet.skinStay", { n: sk.shapes - sk.cut, h }) : "", sk.cut > 0 ? t("sheet.skinCut", { n: Math.min(sk.cut, sk.shapes), h }) : ""].filter(Boolean).join(" · ") : "";
  return {
    prog, motion, has, minX, minY, maxX, maxY, ops, changes, skin, skinStock: sk ? sk.stock : 0,
    partSize: has ? `${(maxX - minX).toFixed(1)} × ${(maxY - minY).toFixed(1)} mm` : "–",
    time: `~ ${fmtTime(prog.totalTime)}`,
    svg: jobSvg({ n: prog.n, x0: prog.x0, y0: prog.y0, x1: prog.x1, y1: prog.y1, cut: isCut }, zones, 6000, marks),
  };
}

/** Zweiseitig fräsen: gemeinsame Einrichtung, Schritte am Tisch und je Seite ein Programm (null = geht nicht) */
function twoSidedSheet(two: TwoSidedSetup, log: (s: string) => void): { part: SheetTwo; warnings: string[] } | null {
  const turn = t(two.flip === "lr" ? "two.turnLr" : "two.turnFb");
  const sides: SheetSide[] = [];
  const common = new Set<string>();
  const shared = new Set([...pinWarnings(two), ...depthWarnings(two)]);
  const line = flipLine(two);
  for (const side of ["front", "back"] as Side[]) {
    const g = generateGcode(state.shapes, { side });
    const name = t(side === "front" ? "sheet.two.front" : "sheet.two.back", { turn });
    if (!g) { sides.push({ name, time: "–", partSize: "–", tools: [], ops: [], changes: [], warnings: [noGcodeMessage()], svg: "" }); continue; }
    const lines = g.split("\n");
    // Warnungen zu Stiften und Tiefen gelten für beide Seiten – nur einmal unten nennen
    const own: string[] = [];
    for (const w of [...lastGcodeWarnings, ...lastGcodeNotes]) { if (shared.has(w)) common.add(w); else own.push(w); }
    own.push(...limitReport(lines));
    const pins = two.pinsOn ? two.pins.map(p => (side === "back" ? mirrorPoint(p, two) : p)).map(p => ({ x: p.x, y: p.y, r: two.pinDia / 2 })) : [];
    const list = sideShapes(side);
    const info = programInfo(lines, zonesFromShapes(list), { rect: two.stock, line, pins });
    sides.push({
      name, time: info.time, partSize: info.partSize, ops: info.ops, changes: info.changes, warnings: own, svg: info.svg, skin: info.skin,
      tools: toolRows(true, list, side === "front" && two.pinsOn ? [pinTool(two)] : []),
    });
  }
  if (sides.every(sd => !sd.svg)) { log(noGcodeMessage()); return null; }
  const st = two.stock, f1 = (v: number) => (+v.toFixed(2)).toString();
  const rows: [string, string][] = [
    [t("sheet.two.turn"), t(two.flip === "lr" ? "sheet.two.turnLr" : "sheet.two.turnFb")],
    [t("sheet.two.corner"), t("sheet.two.cornerVal", { x: f1(st.x), y: f1(st.y) })],
    [t("sheet.zero"), t("sheet.two.zeroXY")],
    [t("sheet.zeroZ"), t(two.zRef === "spoil" ? "sheet.two.zSpoil" : "sheet.two.zTop", { t: f1(two.thickness) })],
    [t("sheet.two.pinRow"), two.pinsOn ? t("sheet.two.pinVal", { n: two.pins.length, d: f1(two.pinDia), z: f1(two.pinDepth), total: f1(two.thickness + two.pinDepth) }) : t("sheet.two.pinNone")],
  ];
  const steps = [
    t("sheet.two.s1", { w: f1(st.w), h: f1(st.h), t: f1(two.thickness), x: f1(st.x), y: f1(st.y) }),
    t(two.zRef === "spoil" ? "sheet.two.s2Spoil" : "sheet.two.s2Top", { t: f1(two.thickness) }),
    t(two.pinsOn ? "sheet.two.s3" : "sheet.two.s3NoPins", { n: two.pins.length, d: f1(two.pinDia) }),
    t(two.pinsOn ? "sheet.two.s4" : "sheet.two.s4NoPins", { n: two.pins.length, d: f1(two.pinDia), turn }),
    t(two.zRef === "spoil" ? "sheet.two.s5Spoil" : "sheet.two.s5Top", { t: f1(two.thickness) }),
    t("sheet.two.s6"),
  ];
  return {
    part: { rows, steps, sides, pins: two.pinsOn ? two.pins.map((p, i) => ({ no: String(i + 1), x: f1(p.x), y: f1(p.y) })) : [] },
    warnings: [...common],
  };
}

export function openSetupSheet(log: (s: string) => void) {
  const fromFile = streamState.loadedLines.length > 0;
  let lines: string[];
  let warnings: string[] = [];
  // Zweiseitig fräsen: ein Blatt für beide Seiten – aus der Zeichnung, auch wenn schon ein Job einer Seite geladen ist
  const twoSetup = activeSetup();
  const two = twoSetup ? twoSidedSheet(twoSetup, log) : null;
  if (twoSetup && !two) return;
  if (two) { lines = []; warnings = two.warnings; }
  else if (fromFile) lines = streamState.loadedLines;
  else {
    const g = generateGcode(state.shapes);
    if (!g) { log(noGcodeMessage()); return; }
    lines = g.split("\n");
    warnings = [...lastGcodeWarnings, ...lastGcodeNotes];
  }
  const drawing = !fromFile || !!two;
  const zones = drawing ? zonesFromShapes(state.shapes) : [];
  const info = programInfo(lines, zones);
  const { prog, motion, has, minX, minY, maxX, maxY, ops, changes } = info;
  const st = getStock();
  // mit Zwiebelhaut ist das Material dicker als der tiefste Schnitt
  const deep = Math.max(0, -prog.cutMinZ, info.skinStock);
  if (!two) warnings.push(...limitReport(lines));
  const zero = has ? zeroPosition({ minX, minY, maxX, maxY }) : "other";
  const zeroText = zero === "other" && has
    ? t("sheet.zero.other", { x: minX.toFixed(1), y: minY.toFixed(1) })
    : t("sheet.zero." + zero);
  const data: SheetData = {
    title: t("sheet.title", { name: drawing ? t("sim.currentDesign") : streamState.label }),
    date: new Date().toLocaleString(currentLanguage()),
    tools: toolRows(drawing),
    toolsNote: t("sheet.toolsFromFile"),
    stock: two && twoSetup ? t("sheet.stockVal", { x: twoSetup.stock.w, y: twoSetup.stock.h, z: twoSetup.thickness.toFixed(2) }) : t("sheet.stockVal", { x: st.w, y: st.h, z: deep.toFixed(2) }),
    partSize: info.partSize,
    time: info.time,
    timeBasis: t("sim.timeBasis." + (motion.source || "default")),
    zero: zeroText,
    zeroZ: t(prog.cutMaxZ <= 0.01 ? "sheet.zeroZ.top" : prog.cutMinZ >= -0.01 ? "sheet.zeroZ.bottom" : "sheet.zeroZ.other"),
    wcs: machine.connected && machine.wcs ? machine.wcs : t("sheet.wcsUnknown"),
    ops, changes, warnings,
    zones: state.shapes.filter(isKeepOut).map((s: any, i: number) => {
      const v = keepValues(s);
      return t("sheet.zoneRow", { n: i + 1, h: v.height, z: (v.height + v.margin).toFixed(1) });
    }),
    svg: info.svg,
    ...(info.skin ? { skin: info.skin } : {}),
    ...(two ? { two: two.part } : {}),
  };
  const body = sheetHtml(data, t);

  document.getElementById("setup-sheet-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "setup-sheet-overlay";
  ov.innerHTML = `
    <style>${SHEET_CSS}</style>
    <div class="sheet-bar">
      <button type="button" class="btn-primary" id="sheet-print">🖨 ${t("sheet.print")}</button>
      <button type="button" class="btn-secondary" id="sheet-save">💾 ${t("sheet.save")}</button>
      <button type="button" class="btn-secondary" id="sheet-close">${t("sheet.close")}</button>
    </div>
    <div class="setup-sheet">${body}</div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onKey, true);
  ov.querySelector<HTMLElement>("#sheet-close")!.onclick = close;
  ov.querySelector<HTMLElement>("#sheet-print")!.onclick = () => window.print();
  ov.querySelector<HTMLElement>("#sheet-save")!.onclick = async () => {
    try {
      const path = await save({ title: t("sheet.save"), defaultPath: "setup-sheet.html", filters: [{ name: "HTML", extensions: ["html"] }] });
      if (!path) return;
      await writeFile(path, new TextEncoder().encode(sheetDocument(body, data.title)));
      log(t("sheet.saved", { p: path }));
    } catch (e) { log(t("sheet.saveFailed", { e: String(e) })); }
  };
}
