/**
 * IMPORT-ZENTRALE: Ein Knopf (oder Datei aufs Fenster ziehen) für alle Formate.
 *
 *   Vektoren:  SVG, DXF, PDF, AI (PDF-kompatibel), HPGL/PLT
 *   3D:        STL, 3MF, OBJ, STEP/STP (eigener Dialog zum Schneiden, siehe meshImport.ts)
 *   Bilder:    PNG, JPG, BMP, GIF, WEBP (Nachzeichnen-Dialog)
 *   G-Code:    NC, GCODE, TAP, NGC (als Konturen)
 *   Projekt:   CNCC (eigenes Projektformat)
 *
 * Nach dem Import:
 *   - einzelne Linien werden zu geschlossenen Konturen verbunden
 *   - Teile mit Löchern bekommen automatisch Außen/Innen
 *   - alles landet als Gruppe im Arbeitsbereich (liegt es außerhalb des Betts,
 *     wird es nach X10/Y10 verschoben)
 */
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { ImportResult, ImpOrigin, ImpPath, Pt, joinPaths, resultBounds, decodeText } from "./common";
import { parseSvg } from "./svgImport";
import { parseDxf } from "./dxfImport";
import { parseHpgl, parseGcode } from "./plotImport";
import { parsePdf } from "./pdfImport";
import { openImageTraceDialog } from "./imageTrace";
import { createImageShape } from "../raster/imageShape";
import { openEngraveDialog } from "../raster/engraveDialog";
import { isLaser, isPlasma } from "../machineMode";
import { openReliefFromImage } from "../ui/reliefDialog";
import { openPcb, PCB_EXTENSIONS } from "../ui/pcbDialog";
import { surelyExcellon } from "../pcb/excellon";
import { openPhotoVcarve } from "../ui/photoVcarveDialog";
import { openStlFromBytes } from "../stlInteraction";
import { traceText } from "../editor/textTool";
import { createPolyline, createCircle, newId, MM_TO_PIXEL, pathArea, pointInPath } from "../shapeTransform";
import { updateDimensionInputs } from "../uiInputs";
import { bedSizeMm } from "../editor/editorState";
import { assignPartGroups } from "../editor/parts";
import { checkpoint } from "../editor/history";
import { t } from "../i18n/i18n";
import { toolsUsedBy, mergeProjectTools } from "../toolLibrary";
import { getMachineMode, setMachineMode } from "../machineMode";
import { getLayers, layersUsedBy, mergeProjectLayers } from "../laserLayers";
import { cutsUsedBy, mergeProjectCuts } from "../plasmaCuts";
import { allShapes, activeBed, bedsForSave, loadBeds } from "../editor/beds";
import { graphForProject, loadProjectGraph } from "../nodes/graphStore";
import { isDirty, markDirty, markClean, clearRecovery } from "../editor/projectDirty";
import { askChoice, askUnsaved } from "../ui/unsavedDialog";
import { stampImport, cleanImp } from "../reimportMatch";
import { openReimportPanel, knownSources, shapesOf } from "../ui/reimportPanel";

export const IMPORT_EXTENSIONS = {
  vector: ["svg", "dxf", "pdf", "ai", "plt", "hpgl", "hpg"],
  model: ["stl", "3mf", "obj", "step", "stp"],
  image: ["png", "jpg", "jpeg", "bmp", "gif", "webp"],
  gcode: ["nc", "gcode", "gc", "tap", "ngc", "cnc"],
  pcb: PCB_EXTENSIONS,
  project: ["cncc"]
};
/** „Zeichnung neu einlesen“ geht mit diesen Formaten (nicht mit nachgezeichneten Bildern und G-Code) */
export const REIMPORT_EXTENSIONS = [...IMPORT_EXTENSIONS.vector, ...IMPORT_EXTENSIONS.model];
const extOf = (name: string) => (name.split(".").pop() || "").toLowerCase();

let ctx = {
  state: null as any,
  redraw: (() => {}) as () => void,
  log: ((_t: string) => {}) as (t: string) => void,
  afterProjectLoad: (() => {}) as () => void
};
let lastProjectPath: string | null = null;
// Nach dem Wiederherstellen: Pfad der ursprünglichen Datei als Vorschlag im Speichern-Dialog
// (direkt schreiben geht nicht – die Freigabe aus dem Dialog gilt nur bis zum Programmende)
let suggestedPath: string | null = null;

/** Dateiname des Projekts (für den Fenstertitel), leer wenn noch nie gespeichert */
export function projectName(): string {
  return (lastProjectPath || suggestedPath || "").split(/[\\/]/).pop() || "";
}

export function initImports(state: any, redraw: () => void, log: (t: string) => void, afterProjectLoad: () => void) {
  ctx = { state, redraw, log, afterProjectLoad };
}

function pathOf(sel: any): string {
  return typeof sel === "object" && sel !== null ? sel.path : sel;
}

/** Datei-Auswahl für alle Formate */
export async function importWithDialog() {
  const all = Object.values(IMPORT_EXTENSIONS).flat();
  const sel = await open({
    multiple: true,
    directory: false,
    title: t("imp.dlgTitle"),
    filters: [
      { name: t("imp.fAll"), extensions: [...all, ...all.map(e => e.toUpperCase())] },
      { name: t("imp.fVector"), extensions: IMPORT_EXTENSIONS.vector },
      { name: t("imp.fImage"), extensions: IMPORT_EXTENSIONS.image },
      { name: t("imp.fModel"), extensions: IMPORT_EXTENSIONS.model },
      { name: t("rp.gcode"), extensions: IMPORT_EXTENSIONS.gcode },
      { name: t("pcb.filter"), extensions: [...PCB_EXTENSIONS, "txt", ...PCB_EXTENSIONS.map(e => e.toUpperCase()), "TXT"] },
      { name: t("imp.fProject"), extensions: IMPORT_EXTENSIONS.project }
    ]
  });
  if (!sel) return;
  const list = Array.isArray(sel) ? sel : [sel];
  for (const s of list) {
    const p = pathOf(s);
    try {
      const bytes = await readFile(p);
      await importBytes(String(p).split(/[\\/]/).pop() || "Datei", bytes, p);
    } catch (err) {
      ctx.log(`${t("imp.error")} ${String(err)}`);
    }
  }
}

/** Datei-Inhalt importieren (vom Dialog oder per Drag & Drop) */
export async function importBytes(name: string, bytes: Uint8Array, fullPath?: string) {
  const ext = extOf(name);
  const { log } = ctx;
  try {
    // dieselbe Datei ist schon im Projekt: neu einlesen oder noch einmal einfügen?
    if (REIMPORT_EXTENSIONS.includes(ext) && knownSources().some(s => s.name === name)) {
      const r = await askChoice(t("reimp.askTitle"), t("reimp.askText", { name }), [
        { key: "cancel", label: t("dlg.cancel"), cancel: true },
        { key: "again", label: t("reimp.askAgain") },
        { key: "update", label: t("reimp.askUpdate"), primary: true }
      ]);
      if (r === "cancel") return;
      if (r === "update") { await reimportBytes(name, name, bytes); return; }
    }
    let res: ImportResult | null = null;
    if (IMPORT_EXTENSIONS.vector.includes(ext)) res = await parseVector(ext, bytes);
    // manche Platinen-Programme nennen ihre Bohrdatei .nc oder .tap
    else if (IMPORT_EXTENSIONS.gcode.includes(ext) && surelyExcellon(decodeText(bytes.subarray(0, 4000))) && !isLaser() && !isPlasma()) { await openPcb(name, bytes, log, ctx.redraw); return; }
    else if (IMPORT_EXTENSIONS.gcode.includes(ext)) res = parseGcode(decodeText(bytes));
    else if (IMPORT_EXTENSIONS.image.includes(ext)) {
      // Bild: gravieren (Bild-Form) oder nachzeichnen (Konturen)
      const how = await chooseImageUse(name);
      if (!how) return;
      if (how === "engrave") { await insertEngraveImage(name, bytes); return; }
      if (how === "relief") { await openReliefFromImage(name, bytes, log); return; }
      if (how === "vcarve") { await openPhotoVcarve(name, bytes, log); return; }
      res = await openImageTraceDialog(name, bytes);
    }
    else if (IMPORT_EXTENSIONS.model.includes(ext)) { await openStlFromBytes(name, bytes, ctx.state, ctx.redraw, log); return; }
    else if (IMPORT_EXTENSIONS.pcb.includes(ext) || ext === "txt") {
      if (isLaser() || isPlasma()) { log(t("pcb.onlyMill")); return; }
      await openPcb(name, bytes, log, ctx.redraw);
      return;
    }
    else if (ext === "cncc") { await loadProjectText(decodeText(bytes), name, fullPath); return; }
    else if (ext === "dwg") throw new Error(t("imp.errDwg"));
    else if (ext === "eps") throw new Error(t("imp.errEps"));
    else throw new Error(t("imp.errType", { ext }));

    if (!res) return; // Dialog abgebrochen
    insertResult(res, name, ext !== "nc" && !IMPORT_EXTENSIONS.gcode.includes(ext));
  } catch (err) {
    log(`${t("imp.error")} ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function parseVector(ext: string, bytes: Uint8Array): Promise<ImportResult> {
  if (ext === "svg") return parseSvg(decodeText(bytes));
  if (ext === "dxf") return parseDxf(decodeText(bytes));
  if (ext === "pdf" || ext === "ai") return parsePdf(bytes);
  return parseHpgl(decodeText(bytes));
}

/**
 * Zeichnung neu einlesen: geänderte Datei wählen, mit den Formen von `source` vergleichen und fragen.
 * Gelesen wird nur die Datei, die gerade im Dialog gewählt wurde (Pfade werden nicht gemerkt).
 */
export async function reimportWithDialog(source: string) {
  const model = IMPORT_EXTENSIONS.model.includes(extOf(source));
  const list = model ? IMPORT_EXTENSIONS.model : IMPORT_EXTENSIONS.vector;
  const sel = await open({
    multiple: false, directory: false, title: t("reimp.dlgTitle", { name: source }),
    filters: [{ name: t(model ? "imp.fModel" : "imp.fVector"), extensions: [...list, ...list.map(e => e.toUpperCase())] }]
  });
  if (!sel) return;
  const p = pathOf(sel), name = String(p).split(/[\\/]/).pop() || source;
  try { await reimportBytes(source, name, await readFile(p)); }
  catch (err) { ctx.log(`${t("imp.error")} ${name}: ${err instanceof Error ? err.message : String(err)}`); }
}

/** Inhalt der geänderten Datei mit den Formen von `source` vergleichen; es wird erst nach der Bestätigung etwas geändert */
export async function reimportBytes(source: string, name: string, bytes: Uint8Array) {
  const { log } = ctx;
  const ext = extOf(name);
  const asNew = () => { void importFresh(name, bytes); };
  if (IMPORT_EXTENSIONS.model.includes(ext)) {
    // 3D-Modell: wieder mit Ansicht und Schnitthöhe, vorbelegt mit denen vom letzten Mal
    const last = shapesOf(source).map(s => cleanImp(s.imp)?.m).find(Boolean) ?? null;
    await openStlFromBytes(name, bytes, ctx.state, ctx.redraw, log, {
      start: last,
      take: shapes => openReimportPanel({ source, name, shapes, mesh: true, warnings: [], log, redraw: ctx.redraw, asNew })
    });
    return;
  }
  const res = await parseVector(ext, bytes);
  const built = buildShapes(res, source, true, false, "file");
  if (!built) { log(t("imp.noShapes", { name })); return; }
  openReimportPanel({ source, name, shapes: built.shapes, mesh: false, warnings: res.warnings, log, redraw: ctx.redraw, asNew });
}

/** Ganz normal einfügen (aus dem Vergleich heraus, wenn die Datei nichts mehr mit der alten zu tun hat) */
async function importFresh(name: string, bytes: Uint8Array) {
  const ext = extOf(name);
  try {
    if (IMPORT_EXTENSIONS.model.includes(ext)) await openStlFromBytes(name, bytes, ctx.state, ctx.redraw, ctx.log);
    else { insertResult(await parseVector(ext, bytes), name, true); checkpoint(); }
  } catch (err) {
    ctx.log(`${t("imp.error")} ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Kleines Fenster: Bild gravieren oder nachzeichnen? */
function chooseImageUse(name: string): Promise<"engrave" | "trace" | "relief" | "vcarve" | null> {
  return new Promise(resolve => {
    document.getElementById("imguse-overlay")?.remove();
    const ov = document.createElement("div");
    ov.id = "imguse-overlay";
    ov.className = "dlg-overlay";
    ov.innerHTML = `
      <div class="dlg-box" role="dialog" style="width:420px;">
        <h3>🖼️ ${t("img.choose")}</h3>
        <div class="dlg-hint imguse-file"></div>
        <button type="button" class="imguse-btn" data-how="engrave"><b>${t("img.engrave")}</b><span>${t("img.engraveD")}</span></button>
        <button type="button" class="imguse-btn" data-how="trace"><b>${t("img.trace")}</b><span>${t("img.traceD")}</span></button>
        ${isLaser() || isPlasma() ? "" : `<button type="button" class="imguse-btn" data-how="relief"><b>${t("img.relief")}</b><span>${t("img.reliefD")}</span></button>
        <button type="button" class="imguse-btn" data-how="vcarve"><b>${t("img.vcarve")}</b><span>${t("img.vcarveD")}</span></button>`}
        <div class="dlg-buttons"><button type="button" class="btn-secondary" data-how="">${t("dlg.cancel")}</button></div>
      </div>`;
    (ov.querySelector(".imguse-file") as HTMLElement).textContent = name;
    document.body.appendChild(ov);
    const done = (v: "engrave" | "trace" | "relief" | "vcarve" | null) => { ov.remove(); resolve(v); };
    ov.querySelectorAll<HTMLElement>("[data-how]").forEach(b => b.addEventListener("click", () => done((b.dataset.how || null) as any)));
    ov.addEventListener("mousedown", e => { if (e.target === ov) done(null); });
    ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") done(null); });
    (ov.querySelector(".imguse-btn") as HTMLElement).focus();
  });
}

/** Bild als Gravur-Form einfügen (unten links mit 10 mm Rand, höchstens halb so breit wie das Bett) und Einstellungen öffnen */
async function insertEngraveImage(name: string, bytes: Uint8Array) {
  const { state, log } = ctx;
  const bed = bedSizeMm();
  const shape = await createImageShape(name, bytes, Math.min(100, Math.max(20, bed.w / 2 - 10)), 10, 10);
  // Bilder in die Gravier-Ebene (Füllen) – nicht in die Schneid-Ebene mit voller Leistung
  const engraveLayer = getLayers().find(l => l.mode === "fill");
  if (engraveLayer) shape.laserLayerId = engraveLayer.id;
  state.shapes = [...state.shapes, shape];
  state.selectedShapeIds = [shape.id];
  updateDimensionInputs(null);
  ctx.redraw();
  const w = (shape.w / MM_TO_PIXEL).toFixed(1), h = (shape.h / MM_TO_PIXEL).toFixed(1);
  log(t("img.inserted", { name, w, h }));
  if (!isLaser()) log(t("img.notLaser"));
  openEngraveDialog(shape, log, () => { updateDimensionInputs(null); ctx.redraw(); });
}

// =====================================================================
// ERGEBNIS IN DEN ARBEITSBEREICH EINFÜGEN
// =====================================================================

interface Built { shapes: any[]; parts: number; texts: number; bounds: NonNullable<ReturnType<typeof resultBounds>>; inside: boolean; open: number }

/**
 * Formen aus dem Ergebnis einer Datei. `place`: auf dem Bett (liegt sie nicht darauf, bei X10/Y10), sonst so, wie die
 * Datei sie hat (für „Zeichnung neu einlesen“). `run` = Kennung dieses Imports, null = ohne Herkunft an den Formen.
 */
function buildShapes(res: ImportResult, name: string, autoModes: boolean, place: boolean, run: string | null): Built | null {

  // Text in Konturen umwandeln (DXF-Texte). Jeder Text bleibt als Ganzes zusammen.
  const textPaths: (ImpPath & { textIdx: number })[] = [];
  res.texts.forEach((t, textIdx) => {
    try {
      const tr = traceText({ text: t.text, font: t.font || "Arial", heightMm: t.height, bold: false, italic: false, align: "left", lineSpacing: 170, letterSpacing: 0 });
      const rad = (t.rotation * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
      for (const [k, loop] of tr.loops.entries()) {
        textPaths.push({ textIdx, keys: t.keys?.map(key => `${key}#${k}`), layer: t.layer, pts: loop.map(q => ({ x: t.x + q.x * c - q.y * s, y: t.y + q.x * s + q.y * c })), closed: true });
      }
    } catch { /* Schrift nicht verfügbar */ }
  });

  const paths = joinPaths(res.paths, 0.01);
  const all: ImportResult = { ...res, paths: [...paths, ...textPaths] };
  const b = resultBounds(all);
  if (!b) return null;

  // Platzierung: liegt alles auf dem Bett, bleibt es, wo es ist. Sonst nach X10/Y10.
  const bed = bedSizeMm();
  const inside = b.minX >= -1e-6 && b.minY >= -1e-6 && b.maxX <= bed.w + 1e-6 && b.maxY <= bed.h + 1e-6;
  const dx = inside || !place ? 0 : 10 - b.minX, dy = inside || !place ? 0 : 10 - b.minY;
  const P = (p: Pt) => ({ x: (p.x + dx) * MM_TO_PIXEL, y: (p.y + dy) * MM_TO_PIXEL });

  // Außen/Innen automatisch: Verschachtelungstiefe jeder geschlossenen Kontur
  type Closed = { kind: "path" | "circle"; idx: number; area: number; probe: Pt; box: [number, number, number, number]; inside: (p: Pt) => boolean };
  const closed: Closed[] = [];
  paths.forEach((p, idx) => {
    if (!p.closed || p.pts.length < 3) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of p.pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    closed.push({ kind: "path", idx, area: Math.abs(pathArea(p.pts)), probe: p.pts[0], box: [x0, y0, x1, y1], inside: q => pointInPath(q.x, q.y, p.pts) });
  });
  res.circles.forEach((c, idx) => {
    closed.push({ kind: "circle", idx, area: Math.PI * c.r * c.r, probe: { x: c.cx + c.r, y: c.cy }, box: [c.cx - c.r, c.cy - c.r, c.cx + c.r, c.cy + c.r], inside: q => Math.hypot(q.x - c.cx, q.y - c.cy) < c.r });
  });
  closed.sort((a, b2) => b2.area - a.area);
  const depth = new Map<string, number>();
  closed.forEach((cl, i) => {
    let d = 0;
    for (let j = 0; j < i; j++) {
      const o = closed[j];
      const [x0, y0, x1, y1] = o.box;
      if (cl.probe.x < x0 || cl.probe.x > x1 || cl.probe.y < y0 || cl.probe.y > y1) continue;
      if (o.area > cl.area && o.inside(cl.probe)) d++;
    }
    depth.set(`${cl.kind}${cl.idx}`, d);
  });
  const modeFor = (key: string) => {
    if (!autoModes) return "on-line";
    return (depth.get(key) || 0) % 2 === 0 ? "outside" : "inside";
  };

  // Herkunft: wo die Form in der Datei liegt (Bett → Datei nur verschoben), Kennung und Ebene
  const toFile: [number, number, number, number, number, number] = [1, 0, 0, 1, -dx * MM_TO_PIXEL, -dy * MM_TO_PIXEL];
  const stamp = (s: any, o: ImpOrigin) => { if (run) stampImport(s, dx || dy ? toFile : null, { f: run, k: o.keys, l: o.layer }); };
  const shapes: any[] = [];
  paths.forEach((p, idx) => {
    if (p.pts.length < 2) return;
    shapes.push(createPolyline(p.pts.map(P), p.closed, p.closed ? modeFor(`path${idx}`) : "on-line", { source: name }));
    stamp(shapes[shapes.length - 1], p);
  });
  res.circles.forEach((c, idx) => {
    const s = createCircle((c.cx + dx) * MM_TO_PIXEL, (c.cy + dy) * MM_TO_PIXEL, c.r * MM_TO_PIXEL, modeFor(`circle${idx}`));
    s.source = name;
    stamp(s, c);
    shapes.push(s);
  });
  // Jedes Teil (Außenkontur + Löcher) wird eine eigene Gruppe -> einzeln verschiebbar
  const parts = assignPartGroups(shapes);
  const textGroups = new Map<number, string>();
  textPaths.forEach(p => {
    if (!textGroups.has(p.textIdx)) textGroups.set(p.textIdx, "text-" + newId());
    shapes.push(createPolyline(p.pts.map(P), true, "on-line", { groupId: textGroups.get(p.textIdx), isText: true, source: name }));
    stamp(shapes[shapes.length - 1], p);
  });
  return { shapes, parts, texts: textGroups.size, bounds: b, inside, open: paths.filter(p => !p.closed).length };
}

function insertResult(res: ImportResult, name: string, autoModes: boolean) {
  const { state, log } = ctx;
  const built = buildShapes(res, name, autoModes, true, REIMPORT_EXTENSIONS.includes(extOf(name)) ? newId() : null);
  if (!built) {
    log(t("imp.noShapes", { name }));
    res.warnings.forEach(w => log(`${t("log.note")} ${w}`));
    return;
  }
  const { shapes, parts, bounds: b, inside, open } = built;
  const bed = bedSizeMm();

  state.shapes = [...state.shapes, ...shapes];
  state.selectedShapeIds = shapes.map(s => s.id);
  updateDimensionInputs(null);
  ctx.redraw();

  const w = (b.maxX - b.minX).toFixed(1), h = (b.maxY - b.minY).toFixed(1);
  log(`[Import] ${name}: ${res.info}`);
  log(t("imp.inserted", { parts: parts + built.texts, n: shapes.length, w, h }) + (open ? ", " + t("imp.openLines", { n: open }) : "") + (inside ? "" : " " + t("imp.moved")));
  if (res.texts.length) log(t("imp.texts", { n: res.texts.length }));
  if (b.maxX - b.minX > bed.w || b.maxY - b.minY > bed.h) log(t("imp.tooLarge"));
  res.warnings.forEach(wn => log(`${t("log.note")} ${wn}`));
}

// =====================================================================
// PROJEKT SPEICHERN / ÖFFNEN (.cncc)
// =====================================================================

/** Alles, was in eine .cncc-Datei gehört (auch für die automatische Sicherung) */
export function projectData() {
  const bed = bedSizeMm();
  // Alle Betten: Formen hintereinander, `beds` sagt, wie viele zu welchem Bett gehören
  const beds = bedsForSave(), all = allShapes();
  return { format: "cnc-craft-project", version: 1, saved: new Date().toISOString(), bed: { w: bed.w, h: bed.h }, shapes: all, tools: toolsUsedBy(all),
    machineMode: getMachineMode(), laserLayers: layersUsedBy(all), plasmaCuts: cutsUsedBy(all), beds, activeBed: activeBed(),
    nodeGraph: graphForProject() };
}

/** Automatische Sicherung: Projekt + Pfad der Datei, zu der es gehört */
export function recoveryText(): string {
  return JSON.stringify({ ...projectData(), recoveryPath: lastProjectPath || suggestedPath });
}

/** Speichern – true, wenn es geklappt hat (false: Dialog abgebrochen oder Fehler) */
export async function saveProject(saveAs: boolean): Promise<boolean> {
  const { log } = ctx;
  let p = saveAs ? null : lastProjectPath;
  if (!p) {
    const sel = await save({ title: t("proj.saveTitle"), defaultPath: suggestedPath || t("proj.defaultName") + ".cncc", filters: [{ name: t("imp.fProject"), extensions: ["cncc"] }] });
    if (!sel) return false;
    // Genau den gewählten Pfad nehmen: nur der ist zum Schreiben freigegeben (kein ".cncc" mehr anhängen –
    // der Dialog setzt die Endung über den Filter selbst)
    p = String(sel);
  }
  try {
    await writeFile(p, new TextEncoder().encode(JSON.stringify(projectData())));
    lastProjectPath = p;
    suggestedPath = null;
    markClean();
    void clearRecovery();
    log(t("proj.saved", { p }));
    return true;
  } catch (err) {
    log(t("proj.saveError", { e: String(err) }));
    return false;
  }
}

/** Vor dem Schließen/Öffnen: bei ungespeicherten Änderungen fragen. true = weitermachen */
export async function guardUnsaved(): Promise<boolean> {
  if (!isDirty()) return true;
  const r = await askUnsaved();
  if (r === "cancel") return false;
  if (r === "save") return saveProject(false);
  return true;
}

/** Projekt aus der automatischen Sicherung (nach Absturz) laden – bleibt "ungespeichert" */
export async function restoreRecovered(text: string) {
  let path: string | null = null;
  try { const d = JSON.parse(text); if (typeof d?.recoveryPath === "string") path = d.recoveryPath; } catch { /* meldet loadProjectText */ }
  try {
    await loadProjectText(text, path?.split(/[\\/]/).pop() || t("proj.recovered"), undefined, path);
  } catch (err) {
    ctx.log(t("proj.openError", { e: String(err) }));
  }
}

export async function openProjectWithDialog() {
  const sel = await open({ multiple: false, directory: false, title: t("proj.openTitle"), filters: [{ name: t("imp.fProject"), extensions: ["cncc"] }] });
  if (!sel) return;
  const p = pathOf(sel);
  try {
    const bytes = await readFile(p);
    await loadProjectText(decodeText(bytes), String(p).split(/[\\/]/).pop() || "Projekt", p);
  } catch (err) {
    ctx.log(t("proj.openError", { e: String(err) }));
  }
}

async function loadProjectText(text: string, name: string, fullPath?: string, recoveredFrom?: string | null) {
  const { log } = ctx;
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error(t("proj.errBroken")); }
  if (data?.format !== "cnc-craft-project" || !Array.isArray(data.shapes)) throw new Error(t("proj.errInvalid"));
  if (!(await guardUnsaved())) return;
  // Werkzeuge aus dem Projekt übernehmen, falls sie in dieser Bibliothek fehlen
  const addedTools = mergeProjectTools(data.tools, data.shapes);
  if (addedTools) log(t("tool.importedFromProject", { n: addedTools }));
  const addedLayers = mergeProjectLayers(data.laserLayers, data.shapes);
  if (addedLayers) log(t("laser.importedFromProject", { n: addedLayers }));
  const addedCuts = mergeProjectCuts(data.plasmaCuts, data.shapes);
  if (addedCuts) log(t("plasma.importedFromProject", { n: addedCuts }));
  if (["mill", "laser", "plasma"].includes(data.machineMode)) setMachineMode(data.machineMode);
  loadBeds(data.shapes, data.beds, data.activeBed);
  loadProjectGraph(data.nodeGraph);
  if (data.bed) {
    const w = document.getElementById("bed-w") as HTMLInputElement | null;
    const h = document.getElementById("bed-h") as HTMLInputElement | null;
    if (w) { w.value = String(data.bed.w); w.dispatchEvent(new Event("input")); }
    if (h) { h.value = String(data.bed.h); h.dispatchEvent(new Event("input")); }
  }
  lastProjectPath = fullPath || null;
  suggestedPath = recoveredFrom || null;
  updateDimensionInputs(null);
  ctx.afterProjectLoad();
  ctx.redraw();
  if (recoveredFrom !== undefined) markDirty(); // wiederhergestellt: noch nicht gespeichert
  else { markClean(); void clearRecovery(); }
  log(t("proj.opened", { name, n: data.shapes.length }));
}
