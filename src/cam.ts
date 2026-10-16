import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { activeTool, toolForShape, getTools, MillingTool, DEFAULT_PLUNGE } from "./toolLibrary";
import { berechne3PunktBogen } from "./arcEngine";
import { offsetPolygon, polygonArea, P } from "./polyOffset";
import { t, ascii } from "./i18n/i18n";
import { isLaser, isPlasma } from "./machineMode";
import { generatePlasmaGcode } from "./plasmaCam";
import { generateLaserGcode } from "./laserCam";
import { stockWarnings } from "./stock";

const MM_TO_PIXEL = 2;
const SAFE_Z = 5.0;       // Sicherheitsabstand über dem Werkstück

// FIX: TextEncoder wandelt Strings in das Byte-Format um, das writeFile braucht
const encoder = new TextEncoder();

/** Hinweise aus der letzten G-Code-Erzeugung (werden in der Konsole angezeigt) */
export let lastGcodeWarnings: string[] = [];

/** Formen, die mit demselben Werkzeug gefräst werden */
export interface ToolGroup { tool: MillingTool | null; shapes: any[] }

/**
 * Teilt die Formen nach Werkzeug auf und legt die Reihenfolge fest:
 *  1. Werkzeuge ohne "Außen"-Konturen zuerst (Gravieren, Löcher, Taschen)
 *  2. Werkzeuge, die Teile ausschneiden, zuletzt – sonst liegt das Teil schon lose
 *  3. sonst: kleineres Werkzeug zuerst, dann Reihenfolge in der Bibliothek
 */
export function orderToolGroups(shapes: any[]): ToolGroup[] {
  const map = new Map<string, ToolGroup>();
  for (const s of shapes) {
    const tool = toolForShape(s);
    const key = tool ? tool.id : "";
    if (!map.has(key)) map.set(key, { tool, shapes: [] });
    map.get(key)!.shapes.push(s);
  }
  const lib = getTools();
  const cutsOut = (g: ToolGroup) => g.shapes.some(s => (s.millingMode || "outside") === "outside") ? 1 : 0;
  return [...map.values()].sort((a, b) =>
    cutsOut(a) - cutsOut(b)
    || (a.tool?.diameter ?? 0) - (b.tool?.diameter ?? 0)
    || lib.indexOf(a.tool as MillingTool) - lib.indexOf(b.tool as MillingTool));
}

/**
 * Der CAM-Kern: Erzeugt vollständige Fräsbahnen und gibt den G-Code als String zurück.
 * Jede Form wird mit IHREM Werkzeug (shape.toolId, sonst Standard-Werkzeug) und IHRER
 * Frästiefe (shape.millingDepth) gefräst. Zwischen verschiedenen Werkzeugen: Werkzeugwechsel (M0).
 */
/**
 * G-Code erzeugen (Fräse / Laser / Plasma je nach Maschinenart).
 * Zusätzlich: Warnung, wenn Formen auf bereits verbrauchter Fläche der Platte liegen.
 */
export const generateGcode = (shapes: any): string | null => {
  const g = generateGcodeInner(shapes);
  if (g) lastGcodeWarnings.push(...stockWarnings(shapes, n => t("stock.gcodeWarn", { n })));
  return g;
};

const generateGcodeInner = (shapes: any): string | null => {
  lastGcodeWarnings = [];
  if (shapes.length === 0) return null;

  // LASER: eigener G-Code (Ebenen, Leistung %, Füllen) – siehe laserCam.ts
  if (isLaser()) {
    const res = generateLaserGcode(shapes);
    lastGcodeWarnings = res.warnings;
    return res.gcode;
  }
  // PLASMA: Schnittspalt, Anfahrbahn, Einstechen – siehe plasmaCam.ts
  if (isPlasma()) {
    const res = generatePlasmaGcode(shapes);
    lastGcodeWarnings = res.warnings;
    return res.gcode;
  }

  // ---- 1. WERKZEUG-PARAMETER (werden pro Werkzeug-Gruppe neu gesetzt) ----
  let curTool: MillingTool | null = activeTool;
  let toolDiameter = 3.0, toolRadius = 1.5, stepZ = 1.5, feedXY = 800, rpm = 12000, PLUNGE_FEED = DEFAULT_PLUNGE;
  const useTool = (tool: MillingTool | null) => {
    curTool = tool;
    toolDiameter = tool ? tool.diameter : 3.0;
    toolRadius = toolDiameter / 2;
    stepZ = tool ? Math.max(0.05, Math.abs(tool.stepZ)) : 1.5;
    feedXY = tool ? tool.feedrate : 800;
    rpm = tool ? tool.rpm : 12000;
    PLUNGE_FEED = tool?.plungeFeed ?? DEFAULT_PLUNGE;
  };

  // ---- 2. FRÄSPARAMETER ----
  // Frästiefe kommt aus der Form; nur alte Formen ohne Tiefe nehmen den Wert aus dem Eingabefeld
  const depthInput = document.getElementById("dim-depth") as HTMLInputElement;
  const fallbackDepth = depthInput && Number.isFinite(parseFloat(depthInput.value)) ? parseFloat(depthInput.value) : -2.0;
  const tabInput = document.getElementById("dim-tab-w") as HTMLInputElement;
  const tabLength = tabInput ? Math.abs(parseFloat(tabInput.value)) || 0 : 0;

  // Weltkoordinate -> Maschinen-mm.
  // FIX: Y zeigt im Speicher schon nach oben (wie an der Maschine). Vorher wurde hier
  // ein zweites Mal gespiegelt -> der G-Code war gegenüber der Anzeige auf den Kopf gestellt!
  const toMachine = (xPx: number, yPx: number) => ({
    x: xPx / MM_TO_PIXEL,
    y: yPx / MM_TO_PIXEL
  });

  // ---- 3. SORTIERUNG: INNEN VOR AUSSEN (innerhalb eines Werkzeugs) ----
  const priority = (mode: string) =>
    mode === "inside" ? 0 : mode === "pocket" ? 1 : mode === "on-line" ? 2 : 3;
  const groups = orderToolGroups(shapes);
  groups.forEach(g => g.shapes.sort((a: any, b: any) => priority(a.millingMode) - priority(b.millingMode)));

  // ---- 4. ZUSTELLUNGEN BERECHNEN (pro Form, weil jede Form ihre eigene Tiefe hat) ----
  let passes: number[] = [];
  const computePasses = (targetDepth: number) => {
    passes = [];
    if (targetDepth >= 0) {
      passes.push(targetDepth === 0 ? 0 : targetDepth);
    } else {
      let z = -stepZ;
      while (z > targetDepth + 0.001) { passes.push(z); z -= stepZ; }
      passes.push(targetDepth);
    }
  };

  // ---- 5. G-CODE HEADER ----
  let gcode = "";
  const c = (key: string, p?: Record<string, string | number>) => `(${ascii(t(key, p))})`;
  gcode += `G21 ${c("gc.unitMm")}\n`;
  gcode += `G90 ${c("gc.absolute")}\n`;
  gcode += `G0 Z${SAFE_Z.toFixed(2)} ${c("gc.safeZ")}\n`;
  if (groups.length > 1) {
    gcode += `${c("gc.toolList", { n: groups.length })}\n`;
    groups.forEach((g, i) => { gcode += `${c("gc.toolListItem", { i: i + 1, name: g.tool ? g.tool.name : "Standard", d: (g.tool ? g.tool.diameter : 3).toFixed(1) })}\n`; });
  }

  // Hilfsfunktion: Eine Bahn (Start->Ende, evtl. mit Haltestegen) fräsen
  const millSegment = (
    sx: number, sy: number, ex: number, ey: number,
    zDepth: number, allowTabs: boolean
  ) => {
    const s = toMachine(sx, sy);
    const e = toMachine(ex, ey);
    const length = Math.hypot(e.x - s.x, e.y - s.y);

    if (allowTabs && tabLength > 0 && length > tabLength * 2.5) {
      const tabCount = Math.max(1, Math.floor(length / 60));
      const segment = length / (tabCount * 2);
      const dx = (e.x - s.x) / length;
      const dy = (e.y - s.y) / length;
      let pos = 0;
      let cutting = true;
      while (pos < length) {
        const segLen = Math.min(segment, length - pos);
        if (cutting) {
          gcode += `G1 X${(s.x + dx * (pos + segLen)).toFixed(3)} Y${(s.y + dy * (pos + segLen)).toFixed(3)}\n`;
        } else {
          gcode += `G0 Z${SAFE_Z.toFixed(2)} (Haltesteg ${tabLength.toFixed(1)}mm)\n`;
          gcode += `G0 X${(s.x + dx * (pos + segLen)).toFixed(3)} Y${(s.y + dy * (pos + segLen)).toFixed(3)}\n`;
          gcode += `G1 Z${zDepth.toFixed(2)} F${PLUNGE_FEED}\n`;
          gcode += `F${feedXY}\n`;
        }
        pos += segLen;
        cutting = !cutting;
      }
    } else {
      gcode += `G1 X${e.x.toFixed(3)} Y${e.y.toFixed(3)}\n`;
    }
  };

  /**
   * Fräst einen Punktezug in allen Zustellungen.
   * Geschlossene Konturen: unten bleiben, nur tiefer eintauchen (spart Zeit).
   */
  const millPath = (pts: P[], closed: boolean) => {
    if (pts.length < 2) return;
    const start = pts[0];
    gcode += `G0 Z${SAFE_Z.toFixed(2)}\n`;
    gcode += `G0 X${start.x.toFixed(3)} Y${start.y.toFixed(3)}\n`;
    passes.forEach((z, passIdx) => {
      if (!closed && passIdx > 0) {
        gcode += `G0 Z${SAFE_Z.toFixed(2)}\n`;
        gcode += `G0 X${start.x.toFixed(3)} Y${start.y.toFixed(3)}\n`;
      }
      gcode += `G1 Z${z.toFixed(3)} F${PLUNGE_FEED}\n`;
      gcode += `G1 F${feedXY}\n`;
      for (let i = 1; i < pts.length; i++) {
        gcode += `G1 X${pts[i].x.toFixed(3)} Y${pts[i].y.toFixed(3)}\n`;
      }
      if (closed) gcode += `G1 X${start.x.toFixed(3)} Y${start.y.toFixed(3)}\n`;
    });
    gcode += `G0 Z${SAFE_Z.toFixed(2)}\n`;
  };

  // ---- 6. FORMEN NACHEINANDER ABFAHREN ----
  let formCounter = 0;
  const alreadyChained = new Set<string>();

  groups.forEach((group, gi) => {
  useTool(group.tool);
  const toolName = curTool ? curTool.name : "Standard";
  if (gi > 0) {
    // ---- WERKZEUGWECHSEL ----
    gcode += `\nG0 Z${SAFE_Z.toFixed(2)}\n`;
    gcode += `M5 ${c("gc.spindleOff")}\n`;
    gcode += `M0 ${c("gc.toolChange", { i: gi + 1, name: toolName, d: toolDiameter.toFixed(1) })}\n`;
  }
  gcode += `\n${c("gc.tool", { name: toolName, d: toolDiameter.toFixed(1) })}\n`;
  gcode += `M3 S${rpm} ${c("gc.spindleOn", { rpm })}\n`;
  if (gi > 0) gcode += `G4 P2 ${c("gc.spinUp")}\n`;
  gcode += `F${feedXY} ${c("gc.feed", { f: feedXY })}\n`;

  group.shapes.forEach((shape: any) => {
    if (shape.parentChainId && alreadyChained.has(shape.parentChainId)) return;
    if (shape.parentChainId) alreadyChained.add(shape.parentChainId);

    formCounter++;
    computePasses(typeof shape.millingDepth === "number" && Number.isFinite(shape.millingDepth) ? shape.millingDepth : fallbackDepth);
    const mode = shape.millingMode || "outside";
    // V-Stichel, Bohrer und Senker taugen nicht für Konturen mit Fräser-Versatz/Taschen
    if (curTool && mode !== "on-line" && (curTool.type === "vbit" || curTool.type === "drill" || curTool.type === "countersink")) {
      const w = t("gcw.toolType", { name: curTool.name, type: t("tl.type." + curTool.type) });
      if (!lastGcodeWarnings.includes(w)) lastGcodeWarnings.push(w);
    }
    let offset = 0;
    if (mode === "outside") offset = toolRadius;
    if (mode === "inside") offset = -toolRadius;

    gcode += `\n${c("gc.shape", { n: formCounter, type: shape.type.toUpperCase(), mode })}\n`;

    if (shape.type === "line") {
      const s0 = toMachine(shape.x, shape.y);
      gcode += `G0 X${s0.x.toFixed(3)} Y${s0.y.toFixed(3)}\n`;
      passes.forEach((z) => {
        gcode += `G1 Z${z.toFixed(2)} F${PLUNGE_FEED}\nF${feedXY}\n`;
        millSegment(shape.x, shape.y, shape.x + shape.w, shape.y + shape.h, z, true);
      });
      gcode += `G0 Z${SAFE_Z.toFixed(2)}\n`;
    }
    else if (shape.type === "circle") {
      const center = toMachine(shape.x, shape.y);
      const radiusPx = Math.abs(shape.w);
      const radiusMm = radiusPx / MM_TO_PIXEL + offset;
      if (radiusMm > 0.05) {
        passes.forEach((z) => {
          const entryX = center.x;
          const entryY = center.y + radiusMm;
          gcode += `G0 X${entryX.toFixed(3)} Y${entryY.toFixed(3)}\n`;
          gcode += `G1 Z${z.toFixed(2)} F${PLUNGE_FEED}\nF${feedXY}\n`;
          gcode += `G2 X${entryX.toFixed(3)} Y${entryY.toFixed(3)} I0.000 J${(-radiusMm).toFixed(3)}\n`;
        });
        gcode += `G0 Z${SAFE_Z.toFixed(2)}\n`;
      } else {
        gcode += `${c("gc.circleTooSmall")}\n`;
        lastGcodeWarnings.push(t("gcw.circleTooSmall", { n: formCounter }));
      }
    }
    else if (shape.type === "arc") {
      const bogen = berechne3PunktBogen(shape.x, shape.y, shape.x + shape.w, shape.y + shape.h, shape.midX, shape.midY);
      if (bogen) {
        const startM = toMachine(shape.x, shape.y);
        const endM = toMachine(shape.x + shape.w, shape.y + shape.h);
        const centerM = toMachine(bogen.cx, bogen.cy);
        const iVal = centerM.x - startM.x;
        const jVal = centerM.y - startM.y;
        // FIX: Liegt der Mittelpunkt links der Sehne Start->Ende, läuft der Bogen im Uhrzeigersinn (G2).
        // (Vorher war das vertauscht und wurde nur durch die alte Y-Spiegelung "ausgeglichen".)
        const cross = (shape.w * (shape.midY - shape.y)) - (shape.h * (shape.midX - shape.x));
        const clockwise = cross > 0;
        const cmd = clockwise ? "G2" : "G3";

        passes.forEach((z) => {
          gcode += `G0 X${startM.x.toFixed(3)} Y${startM.y.toFixed(3)}\n`;
          gcode += `G1 Z${z.toFixed(2)} F${PLUNGE_FEED}\nF${feedXY}\n`;
          gcode += `${cmd} X${endM.x.toFixed(3)} Y${endM.y.toFixed(3)} I${iVal.toFixed(3)} J${jVal.toFixed(3)}\n`;
        });
        gcode += `G0 Z${SAFE_Z.toFixed(2)}\n`;
      }
    }
    else if (shape.type === "polyline") {
      // KONTUR AUS VIELEN PUNKTEN (z.B. STL-Import) - mit echter Radius-Korrektur
      const pts: P[] = shape.points.map((p: any) => toMachine(p.x, p.y));

      if (!shape.closed || mode === "on-line") {
        millPath(pts, !!shape.closed);
      } else if (mode === "pocket") {
        gcode += `${c("gc.pocketTodo")}\n`;
        lastGcodeWarnings.push(t("gcw.pocketTodo", { n: formCounter }));
      } else {
        const loops = offsetPolygon(pts, offset);
        if (loops.length === 0) {
          gcode += `${c("gc.toolTooBig")}\n`;
          lastGcodeWarnings.push(t("gcw.toolTooBig", { n: formCounter, d: toolDiameter }));
        }
        if (loops.length > 1) {
          lastGcodeWarnings.push(t("gcw.split", { n: formCounter, parts: loops.length }));
        }
        loops.forEach(loop => {
          // Gleichlauf-Fräsen (bei rechtsdrehender Spindel M3):
          // außen gegen den Uhrzeigersinn, innen im Uhrzeigersinn
          let path = loop;
          const ccw = polygonArea(path) > 0;
          if ((mode === "outside") !== ccw) path = path.slice().reverse();
          millPath(path, true);
        });
      }
    }
    else if (shape.type === "rect" || shape.type === "path") {
      gcode += `${c("gc.unsupported", { type: shape.type })}\n`;
      lastGcodeWarnings.push(t("gcw.unsupported", { n: formCounter, type: shape.type }));
    }
  });
  });

  // ---- 7. FOOTER ----
  gcode += `\nG0 Z${SAFE_Z.toFixed(2)}\nM5 ${c("gc.spindleOff")}\nG0 X0 Y0 ${c("gc.park")}\nM30 ${c("gc.end")}\n`;

  return gcode;
};

function showWarnings(appendToConsole: (t: string) => void) {
  lastGcodeWarnings.forEach(w => appendToConsole(`${t("log.warning")} ${w}`));
}

/**
 * G-Code erzeugen und in der Konsole anzeigen.
 */
export const handleGcodeGeneration = (shapes: any, appendToConsole: (t: string) => void) => {
  const gcode = generateGcode(shapes);
  if (!gcode) { appendToConsole(t("gcw.noObjects")); return; }
  appendToConsole(gcode);
  showWarnings(appendToConsole);
};

/**
 * G-Code erzeugen und per Speichern-Dialog als .gcode-Datei ablegen.
 */
export async function exportGcodeToFile(shapes: any, appendToConsole: (t: string) => void) {
  const gcode = generateGcode(shapes);
  if (!gcode) { appendToConsole(t("gcw.noObjects")); return; }
  showWarnings(appendToConsole);

  try {
    const filePath = await save({
      title: t("rp.saveGcode"),
      defaultPath: "cnc-auftrag.gcode",
      filters: [
        { name: t("stream.dlgFilter"), extensions: ["gcode", "nc", "tap"] }
      ]
    });

    if (filePath) {
      // FIX: writeFile will Bytes sehen - TextEncoder macht aus dem String ein Uint8Array!
      await writeFile(filePath, encoder.encode(gcode));
      appendToConsole(t("gcw.saved", { p: filePath }));
    }
  } catch (err) {
    appendToConsole(t("gcw.saveError", { e: String(err) }));
  }
}
