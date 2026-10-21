import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { activeTool, toolForShape, getTools, MillingTool, DEFAULT_PLUNGE } from "./toolLibrary";
import { berechne3PunktBogen } from "./arcEngine";
import { offsetPolygon, polygonArea, pointInPoly, P } from "./polyOffset";
import { pocketPaths, PocketStrategy } from "./pocket";
import { tabSettings, tabCenters, cumulative, pointAt, TabSettings } from "./tabs";
import { makeEllipsePoints } from "./shapeTransform";
import { spindleCode } from "./spindleDir";
import { t, ascii } from "./i18n/i18n";
import { isLaser, isPlasma } from "./machineMode";
import { generatePlasmaGcode } from "./plasmaCam";
import { generateLaserGcode } from "./laserCam";
import { stockWarnings, stockOptions, hasUsedArea, shapeOnUsedArea } from "./stock";

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
  // Formen auf verbrauchter Fläche weglassen (Schalter in "Material-Platte")
  const skipped = usedAreaShapes(shapes);
  allSkipped = skipped.size > 0 && skipped.size === shapes.length;
  const g = generateGcodeInner(skipped.size ? shapes.filter((s: any) => !skipped.has(s)) : shapes);
  if (skipped.size && !allSkipped) lastGcodeWarnings.push(t("stock.skipped", { n: skipped.size }));
  else if (g) lastGcodeWarnings.push(...stockWarnings(shapes, n => t("stock.gcodeWarn", { n })));
  return g;
};

/** Alle Formen auf der verbrauchten Fläche lagen -> nichts zu schneiden */
let allSkipped = false;

/** Meldung, wenn generateGcode() nichts geliefert hat */
export const noGcodeMessage = () => allSkipped ? t("stock.allSkipped") : (lastGcodeWarnings[0] || t("gcw.noObjects"));

/** Formen, die wegen verbrauchter Fläche nicht geschnitten werden (ganze Gruppe, wenn ein Teil davon betroffen ist) */
function usedAreaShapes(shapes: any[]): Set<any> {
  const out = new Set<any>();
  if (!stockOptions.skipUsed || !hasUsedArea()) return out;
  const groups = new Set<string>();
  for (const s of shapes) if (shapeOnUsedArea(s)) { out.add(s); if (s.groupId) groups.add(s.groupId); }
  if (groups.size) for (const s of shapes) if (s.groupId && groups.has(s.groupId)) out.add(s);
  return out;
}

const generateGcodeInner = (shapes: any): string | null => {
  lastGcodeWarnings = [];
  if (shapes.length === 0) return null;

  // LASER: eigener G-Code (Ebenen, Leistung %, Füllen) – siehe laserCam.ts
  if (isLaser()) {
    const res = generateLaserGcode(shapes);
    lastGcodeWarnings = res.warnings;
    return res.gcode;
  }
  // Bilder (Bildgravur) gibt es nur beim Laser
  const images = shapes.filter((s: any) => s.type === "image").length;
  if (images) {
    shapes = shapes.filter((s: any) => s.type !== "image");
    if (!shapes.length) { lastGcodeWarnings = [t("img.onlyLaser", { n: images })]; return null; }
  }
  const imageNote = () => { if (images) lastGcodeWarnings.unshift(t("img.onlyLaser", { n: images })); };

  // PLASMA: Schnittspalt, Anfahrbahn, Einstechen – siehe plasmaCam.ts
  if (isPlasma()) {
    const res = generatePlasmaGcode(shapes);
    lastGcodeWarnings = res.warnings;
    imageNote();
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
  const pocketSel = document.getElementById("dim-pocket-strategy") as HTMLSelectElement | null;
  const pocketStrategy: PocketStrategy = pocketSel?.value === "spiral" ? "spiral" : "linear";
  /** seitliche Zustellung in der Tasche: 40 % des Fräserdurchmessers */
  const STEPOVER = 0.4;

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

  /**
   * HALTESTEGE (wie in Estlcam): Beim Ausschneiden bleiben kleine Stege stehen, damit das Teil nicht lose wird.
   * Lage der Stege: automatisch (Anzahl) oder selbst gesetzt – siehe tabs.ts. tabLen = Länge, tabH = Höhe ab Boden.
   * Nur die Durchgänge, die tiefer als die Steg-Oberkante gehen, fahren über dem Steg auf Steg-Höhe.
   */
  /** Geschlossene Kontur mit Haltestegen fräsen; false = ging nicht (dann normal fräsen, Hinweis steht schon da) */
  const millTabbed = (loop: P[], shape: any, tab: TabSettings): boolean => {
    const target = passes[passes.length - 1];
    const zTab = target + tab.h;
    if (zTab >= -0.001) { lastGcodeWarnings.push(t("gcw.tabsTooHigh", { n: formCounter, h: tab.h })); return false; }
    const cum = cumulative(loop);
    const L = cum[cum.length - 1];
    // Fräserbahn über dem Steg = Steglänge + Fräserdurchmesser (der Fräser nimmt links und rechts den Radius weg)
    const half = tab.len / 2 + toolRadius;
    const centers = tabCenters(shape, loop, cum, p => toMachine(p.x, p.y), toolRadius * 1.5 + 1).sort((x, y) => x - y);
    if (!centers.length) return false;
    // Anfangen in der Mitte der größten Lücke – so taucht der Fräser nie in einem Steg ein
    let s0 = 0, gap = -1;
    centers.forEach((c, i) => {
      const next = i + 1 < centers.length ? centers[i + 1] : centers[0] + L;
      if (next - c > gap) { gap = next - c; s0 = (c + next) / 2; }
    });
    const tooMany = shape.tabMode === "manual" ? gap <= 2 * half : L / centers.length < 3 * half;
    if (tooMany) { lastGcodeWarnings.push(t("gcw.tabsTooMany", { n: formCounter, k: centers.length })); return false; }
    const rel = (x: number) => (((x - s0) % L) + L) % L;
    const spans = centers.map(c => [rel(c) - half, rel(c) + half]);
    // Punkte der Bahn ab s0 + Anfang/Ende jedes Stegs, nach Länge sortiert
    const start = pointAt(loop, cum, s0);
    const seq: { p: P; s: number }[] = [
      { p: start, s: 0 },
      ...loop.map((p, i) => ({ p, s: rel(cum[i]) })).filter(q => q.s > 1e-9),
      ...spans.flat().map(m => ({ p: pointAt(loop, cum, s0 + m), s: m })),
      { p: start, s: L }
    ].sort((u, v) => u.s - v.s);
    const inTab = (x: number) => spans.some(([a, b]) => x > a && x < b);
    gcode += `G0 Z${SAFE_Z.toFixed(2)}\nG0 X${start.x.toFixed(3)} Y${start.y.toFixed(3)}\n`;
    passes.forEach(z => {
      gcode += `G1 Z${z.toFixed(3)} F${PLUNGE_FEED}\nG1 F${feedXY}\n`;
      let up = false;
      for (let j = 1; j < seq.length; j++) {
        const want = z < zTab - 1e-6 && inTab((seq[j - 1].s + seq[j].s) / 2);
        if (want && !up) { gcode += `G1 Z${zTab.toFixed(3)} ${c("gc.tab")}\n`; up = true; }
        else if (!want && up) { gcode += `G1 Z${z.toFixed(3)} F${PLUNGE_FEED}\nG1 F${feedXY}\n`; up = false; }
        gcode += `G1 X${seq[j].p.x.toFixed(3)} Y${seq[j].p.y.toFixed(3)}\n`;
      }
    });
    gcode += `G0 Z${SAFE_Z.toFixed(2)}\n`;
    return true;
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

  // ---- TASCHE: Kontur in mm (Kreise als Vieleck) und die Inseln darin ----
  const closedMm = (s: any): P[] | null => {
    if (s.type === "circle") return makeEllipsePoints(s.x, s.y, Math.abs(s.w), Math.abs(s.w)).map(p => toMachine(p.x, p.y));
    if (s.type === "polyline" && s.closed && s.points?.length >= 3) return s.points.map((p: any) => toMachine(p.x, p.y));
    return null;
  };
  /** Inseln = geschlossene Formen direkt in der Tasche (was in einer Insel liegt, zählt nicht extra) */
  const islandsOf = (shape: any, outer: P[]): P[][] => {
    const area = Math.abs(polygonArea(outer));
    const cand: { pts: P[]; area: number }[] = [];
    for (const s of shapes) {
      if (s === shape) continue;
      const pts = closedMm(s);
      if (!pts) continue;
      const a = Math.abs(polygonArea(pts));
      if (a < area && pointInPoly(pts[0].x, pts[0].y, outer)) cand.push({ pts, area: a });
    }
    return cand.filter(c => !cand.some(o => o !== c && o.area > c.area && pointInPoly(c.pts[0].x, c.pts[0].y, o.pts))).map(c => c.pts);
  };
  const millPocket = (shape: any, outer: P[]) => {
    const { paths, tooBig } = pocketPaths(outer, islandsOf(shape, outer), toolRadius, Math.max(0.05, toolDiameter * STEPOVER), pocketStrategy);
    if (tooBig || !paths.length) {
      gcode += `${c("gc.toolTooBig")}\n`;
      lastGcodeWarnings.push(t("gcw.toolTooBig", { n: formCounter, d: toolDiameter }));
      return;
    }
    // je Tiefe alle Bahnen; zwischen den Bahnen abheben (sonst ginge es quer durchs Material)
    passes.forEach(z => {
      for (const p of paths) {
        const s = p.pts[0];
        gcode += `G0 Z${SAFE_Z.toFixed(2)}\nG0 X${s.x.toFixed(3)} Y${s.y.toFixed(3)}\n`;
        gcode += `G1 Z${z.toFixed(3)} F${PLUNGE_FEED}\nG1 F${feedXY}\n`;
        for (let i = 1; i < p.pts.length; i++) gcode += `G1 X${p.pts[i].x.toFixed(3)} Y${p.pts[i].y.toFixed(3)}\n`;
        if (p.closed) gcode += `G1 X${s.x.toFixed(3)} Y${s.y.toFixed(3)}\n`;
      }
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
  // M3 = rechts – bei „Drehrichtung umkehren“ M4 (Spindel falsch herum verkabelt)
  gcode += `${spindleCode("M3")} S${rpm} ${c("gc.spindleOn", { rpm })}\n`;
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

    const pocketOuter = mode === "pocket" ? closedMm(shape) : null;
    if (pocketOuter) {
      millPocket(shape, pocketOuter);
    }
    else if (shape.type === "line") {
      const s0 = toMachine(shape.x, shape.y);
      gcode += `G0 X${s0.x.toFixed(3)} Y${s0.y.toFixed(3)}\n`;
      const e0 = toMachine(shape.x + shape.w, shape.y + shape.h);
      passes.forEach((z) => {
        gcode += `G1 Z${z.toFixed(2)} F${PLUNGE_FEED}\nF${feedXY}\n`;
        gcode += `G1 X${e0.x.toFixed(3)} Y${e0.y.toFixed(3)}\n`;
        if (z !== passes[passes.length - 1]) gcode += `G0 Z${SAFE_Z.toFixed(2)}\nG0 X${s0.x.toFixed(3)} Y${s0.y.toFixed(3)}\n`;
      });
      gcode += `G0 Z${SAFE_Z.toFixed(2)}\n`;
    }
    else if (shape.type === "circle") {
      const center = toMachine(shape.x, shape.y);
      const radiusPx = Math.abs(shape.w);
      const radiusMm = radiusPx / MM_TO_PIXEL + offset;
      const tab = mode !== "on-line" ? tabSettings(shape) : null;
      // mit Haltestegen: Kreis als Vieleck (außen gegen, innen im Uhrzeigersinn – wie bei den Konturen)
      let ring = tab && radiusMm > 0.05 ? makeEllipsePoints(center.x, center.y, radiusMm, radiusMm) : null;
      if (ring && mode === "inside") ring = [ring[0], ...ring.slice(1).reverse()];
      if (ring && millTabbed(ring, shape, tab!)) { /* fertig */ }
      else if (radiusMm > 0.05) {
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
      // Außen/Innen: Fräser um den Radius weg vom Mittelpunkt bzw. zum Mittelpunkt hin (gleicher Mittelpunkt)
      const centerM = bogen ? toMachine(bogen.cx, bogen.cy) : null;
      const rMm = bogen ? bogen.r / MM_TO_PIXEL : 0;
      const rNew = rMm + (mode === "outside" ? toolRadius : mode === "inside" ? -toolRadius : 0);
      if (bogen && rNew <= 0.05) {
        gcode += `${c("gc.toolTooBig")}\n`;
        lastGcodeWarnings.push(t("gcw.toolTooBig", { n: formCounter, d: toolDiameter }));
      } else if (bogen && centerM) {
        const k = rNew / rMm;
        const radial = (p: { x: number; y: number }) => ({ x: centerM.x + (p.x - centerM.x) * k, y: centerM.y + (p.y - centerM.y) * k });
        const startM = radial(toMachine(shape.x, shape.y));
        const endM = radial(toMachine(shape.x + shape.w, shape.y + shape.h));
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

      // (Tasche bei geschlossenen Polylinien: siehe millPocket oben)
      if (!shape.closed || mode === "on-line" || mode === "pocket") {
        millPath(pts, !!shape.closed);
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
          // umdrehen, aber am selben Punkt anfangen (dann liegen die Haltestege wie in der Vorschau)
          if ((mode === "outside") !== ccw) path = [path[0], ...path.slice(1).reverse()];
          const tab = tabSettings(shape);
          if (!tab || !millTabbed(path, shape, tab)) millPath(path, true);
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

  imageNote();
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
  if (!gcode) { appendToConsole(noGcodeMessage()); return; }
  appendToConsole(gcode);
  showWarnings(appendToConsole);
};

/**
 * G-Code erzeugen und per Speichern-Dialog als .gcode-Datei ablegen.
 */
export async function exportGcodeToFile(shapes: any, appendToConsole: (t: string) => void, fileName = "cnc-auftrag.gcode") {
  const gcode = generateGcode(shapes);
  if (!gcode) { appendToConsole(noGcodeMessage()); return; }
  showWarnings(appendToConsole);

  try {
    const filePath = await save({
      title: t("rp.saveGcode"),
      defaultPath: fileName,
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
