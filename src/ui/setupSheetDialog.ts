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
import { jobSvg, sheetDocument, sheetHtml, summarizeJob, zeroPosition, SheetData, SheetTool, SHEET_CSS } from "../setupSheet";


function fmtTime(s: number): string {
  const m = Math.round(s / 60);
  if (s < 60) return `${Math.round(s)} s`;
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

function toolRows(fromDrawing: boolean): SheetTool[] {
  if (!fromDrawing) return [];
  const shapes = state.shapes.filter((s: any) => !isKeepOut(s) && s.type !== "image");
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
  return rows;
}

export function openSetupSheet(log: (s: string) => void) {
  const fromFile = streamState.loadedLines.length > 0;
  let lines: string[];
  let warnings: string[] = [];
  if (fromFile) lines = streamState.loadedLines;
  else {
    const g = generateGcode(state.shapes);
    if (!g) { log(noGcodeMessage()); return; }
    lines = g.split("\n");
    warnings = [...lastGcodeWarnings, ...lastGcodeNotes];
  }
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
  const st = getStock();
  const deep = Math.max(0, -prog.cutMinZ);
  const zones = fromFile ? [] : zonesFromShapes(state.shapes);
  const { ops, changes } = summarizeJob(lines);
  warnings.push(...limitReport(lines));
  const zero = has ? zeroPosition({ minX, minY, maxX, maxY }) : "other";
  const zeroText = zero === "other" && has
    ? t("sheet.zero.other", { x: minX.toFixed(1), y: minY.toFixed(1) })
    : t("sheet.zero." + zero);
  const data: SheetData = {
    title: t("sheet.title", { name: fromFile ? streamState.label : t("sim.currentDesign") }),
    date: new Date().toLocaleString(currentLanguage()),
    tools: toolRows(!fromFile),
    toolsNote: t("sheet.toolsFromFile"),
    stock: t("sheet.stockVal", { x: st.w, y: st.h, z: deep.toFixed(2) }),
    partSize: has ? `${(maxX - minX).toFixed(1)} × ${(maxY - minY).toFixed(1)} mm` : "–",
    time: `~ ${fmtTime(prog.totalTime)}`,
    timeBasis: t("sim.timeBasis." + (motion.source || "default")),
    zero: zeroText,
    zeroZ: t(prog.cutMaxZ <= 0.01 ? "sheet.zeroZ.top" : prog.cutMinZ >= -0.01 ? "sheet.zeroZ.bottom" : "sheet.zeroZ.other"),
    wcs: machine.connected && machine.wcs ? machine.wcs : t("sheet.wcsUnknown"),
    ops, changes, warnings,
    zones: state.shapes.filter(isKeepOut).map((s: any, i: number) => {
      const v = keepValues(s);
      return t("sheet.zoneRow", { n: i + 1, h: v.height, z: (v.height + v.margin).toFixed(1) });
    }),
    svg: jobSvg({ n: prog.n, x0: prog.x0, y0: prog.y0, x1: prog.x1, y1: prog.y1, cut: isCut }, zones)
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
