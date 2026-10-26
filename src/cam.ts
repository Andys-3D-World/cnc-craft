import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { activeTool, toolForShape, getTools, getTool, MillingTool, DEFAULT_PLUNGE, toolNumber } from "./toolLibrary";
import { toolChangeGcode } from "./toolChange";
import { berechne3PunktBogen } from "./arcEngine";
import { offsetPolygon, polygonArea, pointInPoly, P } from "./polyOffset";
import { pocketPaths, pocketWallPaths, PocketStrategy } from "./pocket";
import { vcarvePaths } from "./vcarve";
import { CONE_TYPES } from "./toolLibrary";
import { tabSettings, tabCenters, cumulative, pointAt, TabSettings } from "./tabs";
import { makeEllipsePoints, shapeBounds, shapeToPaths } from "./shapeTransform";
import { expandOps } from "./ops";
import { spindleCode } from "./spindleDir";
import { t, ascii } from "./i18n/i18n";
import { isLaser, isPlasma } from "./machineMode";
import { generatePlasmaGcode } from "./plasmaCam";
import { generateLaserGcode } from "./laserCam";
import { rotary, applyRotary, outsideBand, circumference, rotaryCheck } from "./rotary";
import { stockWarnings, stockOptions, hasUsedArea, shapeOnUsedArea } from "./stock";
import { adaptFeed, feedAdapt } from "./feedAdapt";

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
  // weitere Bearbeitungen je Form (Tasche, Fase, Ausschneiden …) – jede wie eine eigene Form (ops.ts)
  for (const s of expandOps(shapes)) {
    const tool = toolForShape(s);
    const key = tool ? tool.id : "";
    if (!map.has(key)) map.set(key, { tool, shapes: [] });
    map.get(key)!.shapes.push(s);
  }
  const lib = getTools();
  const cutsOut = (g: ToolGroup) => g.shapes.some(s => (s.millingMode || "outside") === "outside") ? 1 : 0;
  const sorted = [...map.values()].sort((a, b) =>
    cutsOut(a) - cutsOut(b)
    || (a.tool?.diameter ?? 0) - (b.tool?.diameter ?? 0)
    || lib.indexOf(a.tool as MillingTool) - lib.indexOf(b.tool as MillingTool));
  return withRestGroups(sorted);
}

/** Werkzeug für das Restmaterial dieser Form (kleiner als das eigene), sonst null */
export function restToolFor(s: any): MillingTool | null {
  const mode = s.millingMode || "outside";
  if (mode !== "pocket" && mode !== "inside") return null;
  const rest = getTool(s.restToolId), own = toolForShape(s);
  return rest && own && rest.id !== own.id && rest.diameter < own.diameter ? rest : null;
}

/**
 * RESTMATERIAL: Formen mit restToolId bekommen nach ihrem Werkzeug einen zweiten Durchgang mit dem kleineren
 * Werkzeug (Eintrag { restOf: Form } in dessen Gruppe). Schneidet eine Gruppe auch Teile aus, wird sie geteilt:
 * erst innen (großes Werkzeug), dann Restmaterial, dann ausschneiden – sonst wäre das Teil schon lose.
 */
function withRestGroups(groups: ToolGroup[]): ToolGroup[] {
  const out: ToolGroup[] = [];
  const push = (g: ToolGroup) => {
    if (!g.shapes.length) return;
    const last = out[out.length - 1];
    if (last && last.tool === g.tool) last.shapes.push(...g.shapes); else out.push(g);
  };
  for (const g of groups) {
    const rests = new Map<MillingTool, any[]>();
    for (const s of g.shapes) { const r = restToolFor(s); if (r) { if (!rests.has(r)) rests.set(r, []); rests.get(r)!.push({ restOf: s, millingMode: s.millingMode, id: s.id + "#rest" }); } }
    if (!rests.size) { push({ tool: g.tool, shapes: [...g.shapes] }); continue; }
    const outer = g.shapes.filter(s => (s.millingMode || "outside") === "outside");
    push({ tool: g.tool, shapes: g.shapes.filter(s => !outer.includes(s)) });
    // größeres Restwerkzeug zuerst
    [...rests.entries()].sort((a, b) => b[0].diameter - a[0].diameter).forEach(([tool, list]) => push({ tool, shapes: list }));
    push({ tool: g.tool, shapes: outer });
  }
  return out;
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
/** flat: Drehachse nicht umrechnen (Simulation zeigt die abgewickelte Fläche) */
let flatOnly = false;
export const generateGcode = (shapes: any, opts: { flat?: boolean } = {}): string | null => {
  flatOnly = !!opts.flat;
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
    // Drehachse: Y auf den Umfang umrechnen (Y-Anschluss) oder in eine A-Achse (Grad)
    if (rotary.on && res.gcode && !flatOnly) {
      const chk = rotaryCheck();
      if (chk.block) { lastGcodeWarnings.unshift(chk.block); return null; }
      if (chk.warn) lastGcodeWarnings.push(chk.warn);
      const out = outsideBand(shapes, shapeBounds);
      if (out) lastGcodeWarnings.push(t("rot.outside", { n: out, c: circumference().toFixed(1) }));
      const g = applyRotary(res.gcode);
      if (!g) { lastGcodeWarnings.unshift(t("rot.arcs")); return null; }
      return g;
    }
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
  /** tan(Eintauchwinkel) – 0 = senkrecht eintauchen (Bohrer, V-Stichel & Co. immer senkrecht) */
  let rampTan = 0;
  const useTool = (tool: MillingTool | null) => {
    curTool = tool;
    toolDiameter = tool ? tool.diameter : 3.0;
    toolRadius = toolDiameter / 2;
    stepZ = tool ? Math.max(0.05, Math.abs(tool.stepZ)) : 1.5;
    feedXY = tool ? tool.feedrate : 800;
    rpm = tool ? tool.rpm : 12000;
    PLUNGE_FEED = tool?.plungeFeed ?? DEFAULT_PLUNGE;
    const ra = tool && !CONE_TYPES.includes(tool.type) ? tool.rampAngle ?? 0 : 0;
    rampTan = ra > 0 ? Math.tan((Math.min(45, ra) * Math.PI) / 180) : 0;
  };

  // ---- 2. FRÄSPARAMETER ----
  // Frästiefe kommt aus der Form; nur alte Formen ohne Tiefe nehmen den Wert aus dem Eingabefeld
  const depthInput = document.getElementById("dim-depth") as HTMLInputElement;
  const fallbackDepth = depthInput && Number.isFinite(parseFloat(depthInput.value)) ? parseFloat(depthInput.value) : -2.0;
  const pocketSel = document.getElementById("dim-pocket-strategy") as HTMLSelectElement | null;
  const pocketStrategy: PocketStrategy = pocketSel?.value === "spiral" || pocketSel?.value === "adaptive" ? pocketSel.value : "linear";
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
    mode === "drill" ? -1 : mode === "inside" ? 0 : mode === "pocket" ? 1 : mode === "vcarve" || mode === "vplug" ? 1.5 : mode === "on-line" ? 2 : mode === "chamfer" ? 2.5 : 3;
  const groups = orderToolGroups(shapes);
  const restIgnored = shapes.filter((s: any) => getTool(s.restToolId) && !restToolFor(s)).length;
  if (restIgnored) lastGcodeWarnings.push(t("gcw.restIgnored", { n: restIgnored }));
  groups.forEach(g => g.shapes.sort((a: any, b: any) => priority(a.millingMode) - priority(b.millingMode)));
  // Bohrungen: immer zur nächsten Bohrung fahren (kurze Wege)
  groups.forEach(g => {
    const drills = g.shapes.filter((s: any) => s.millingMode === "drill");
    if (drills.length < 2) return;
    const at = (s: any) => { const b = s.type === "circle" ? null : shapeBounds(s); return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: s.x, y: s.y }; };
    const order: any[] = [];
    let cur = { x: 0, y: 0 };
    const left = [...drills];
    while (left.length) {
      let bi = 0, bd = Infinity;
      left.forEach((s, i) => { const p = at(s), d = Math.hypot(p.x - cur.x, p.y - cur.y); if (d < bd) { bd = d; bi = i; } });
      const [s] = left.splice(bi, 1);
      order.push(s); cur = at(s);
    }
    g.shapes = [...order, ...g.shapes.filter((s: any) => s.millingMode !== "drill")];
  });

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

  /**
   * EINTAUCHEN von zTop auf z am Anfang der Bahn pts. Mit Eintauchwinkel als Rampe: schräg entlang der Bahn ein
   * Stück vor und wieder zurück (bei Bedarf mehrmals) – endet genau am Anfang, danach geht es normal weiter.
   * maxLen begrenzt die Strecke (Haltestege). Zu kurze Bahnen tauchen senkrecht ein.
   */
  const plungeTo = (pts: P[], closed: boolean, zTop: number, z: number, maxLen = Infinity) => {
    const drop = zTop - z;
    const straight = () => { gcode += `G1 Z${z.toFixed(3)} F${PLUNGE_FEED}\nG1 F${feedXY}\n`; };
    if (!(rampTan > 0) || drop <= 1e-6 || pts.length < 2) return straight();
    const seq = closed ? [...pts, pts[0]] : pts;
    const cum = [0];
    for (let i = 1; i < seq.length; i++) cum.push(cum[i - 1] + Math.hypot(seq[i].x - seq[i - 1].x, seq[i].y - seq[i - 1].y));
    const avail = Math.min(cum[cum.length - 1], maxLen);
    const L = drop / rampTan;
    const k = Math.ceil(L / (2 * Math.max(avail, 1e-9)));
    if (avail < 0.5 || k > 50) return straight();
    const d = L / (2 * k);
    const at = (sd: number): P => {
      let i = 1;
      while (i < cum.length - 1 && cum[i] < sd) i++;
      const f = (sd - cum[i - 1]) / Math.max(1e-12, cum[i] - cum[i - 1]);
      return { x: seq[i - 1].x + (seq[i].x - seq[i - 1].x) * f, y: seq[i - 1].y + (seq[i].y - seq[i - 1].y) * f };
    };
    // Stützpunkte der Strecke 0 → d (Ecken der Bahn dazwischen), zurück dieselben rückwärts
    const fwd: number[] = [...cum.filter(x => x > 1e-9 && x < d - 1e-9), d];
    const back = [...fwd.slice(0, -1).reverse(), 0];
    gcode += `G1 Z${zTop.toFixed(3)} F${PLUNGE_FEED} ${c("gc.ramp")}\n`;
    let travelled = 0, pos = 0, first = true;
    for (let j = 0; j < k; j++) {
      for (const sd of [...fwd, ...back]) {
        travelled += Math.abs(sd - pos); pos = sd;
        const p = at(sd), hz = Math.max(z, zTop - drop * travelled / L);
        gcode += `G1 X${p.x.toFixed(3)} Y${p.y.toFixed(3)} Z${hz.toFixed(3)}${first ? ` F${feedXY}` : ""}\n`;
        first = false;
      }
    }
  };

  /**
   * SCHLICHTGANG: Erst wird mit Aufmaß (shape.finishAllow mm) geschruppt, danach fährt der Fräser die Wand noch
   * einmal in voller Tiefe auf Maß. Er taucht dafür auf der Schrupp-Bahn ein (dort ist schon alles frei) und fährt
   * dann seitlich an – so taucht er nie in den stehen gebliebenen Rest.
   */
  const finishAllow = (s: any): number => { const a = Number(s.finishAllow); return Number.isFinite(a) && a > 0 ? Math.min(a, 5) : 0; };
  /** nächster Punkt auf den Bahnen (Eintauchstelle für den Schlichtgang) */
  const nearestOn = (paths: { pts: P[]; closed: boolean }[], p: P): P | null => {
    let best: P | null = null, bd = Infinity;
    for (const { pts, closed } of paths) {
      const n = pts.length;
      for (let i = 0; i < (closed ? n : n - 1); i++) {
        const a = pts[i], b = pts[(i + 1) % n], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
        const f = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
        const q = { x: a.x + dx * f, y: a.y + dy * f }, d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < bd) { bd = d; best = q; }
      }
    }
    return best;
  };
  /** Schlichtgang-Hinweis in den G-Code und nur die Endtiefe fräsen */
  const finishStart = () => { gcode += `${c("gc.finish")}\n`; const z = passes[passes.length - 1]; passes = [z]; };

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
  const millTabbed = (loop: P[], shape: any, tab: TabSettings, lead: P[][] | null = null): boolean => {
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
    const entry = lead ? nearestOn(lead.map(l => ({ pts: l, closed: true })), start) : null;
    gcode += `G0 Z${SAFE_Z.toFixed(2)}\nG0 X${(entry ?? start).x.toFixed(3)} Y${(entry ?? start).y.toFixed(3)}\n`;
    passes.forEach((z, pi) => {
      if (entry && pi === 0) gcode += `G1 Z${z.toFixed(3)} F${PLUNGE_FEED}\nG1 X${start.x.toFixed(3)} Y${start.y.toFixed(3)} F${feedXY}\n`;
      // Rampe nur bis kurz vor den ersten Steg
      else plungeTo(seq.map(q => q.p), false, pi > 0 ? passes[pi - 1] : 0, z, Math.max(0, gap / 2 - half - toolRadius));
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
  const millPath = (pts: P[], closed: boolean, lead: { pts: P[]; closed: boolean }[] | null = null) => {
    if (pts.length < 2) return;
    const start = pts[0];
    const entry = lead ? nearestOn(lead, start) : null;
    gcode += `G0 Z${SAFE_Z.toFixed(2)}\n`;
    gcode += `G0 X${(entry ?? start).x.toFixed(3)} Y${(entry ?? start).y.toFixed(3)}\n`;
    passes.forEach((z, passIdx) => {
      if (!closed && passIdx > 0) {
        gcode += `G0 Z${SAFE_Z.toFixed(2)}\n`;
        gcode += `G0 X${start.x.toFixed(3)} Y${start.y.toFixed(3)}\n`;
      }
      if (entry && passIdx === 0) gcode += `G1 Z${z.toFixed(3)} F${PLUNGE_FEED}\nG1 X${start.x.toFixed(3)} Y${start.y.toFixed(3)} F${feedXY}\n`;
      else plungeTo(pts, closed, passIdx > 0 ? passes[passIdx - 1] : 0, z);
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
    const islands = islandsOf(shape, outer), step = Math.max(0.05, toolDiameter * STEPOVER);
    let allow = finishAllow(shape);
    let { paths, tooBig } = pocketPaths(outer, islands, toolRadius + allow, step, pocketStrategy);
    if (allow > 0 && (tooBig || !paths.length)) {
      // mit Aufmaß passt der Fräser nicht mehr hinein → ohne Schlichtgang
      lastGcodeWarnings.push(t("gcw.finishSkip", { n: formCounter, a: allow }));
      allow = 0;
      ({ paths, tooBig } = pocketPaths(outer, islands, toolRadius, step, pocketStrategy));
    }
    if (tooBig || !paths.length) {
      gcode += `${c("gc.toolTooBig")}\n`;
      lastGcodeWarnings.push(t("gcw.toolTooBig", { n: formCounter, d: toolDiameter }));
      return;
    }
    // je Tiefe alle Bahnen; zwischen den Bahnen abheben (sonst ginge es quer durchs Material)
    passes.forEach((z, pi) => {
      const prevZ = pi > 0 ? passes[pi - 1] : 0;
      for (const p of paths) {
        const s = p.pts[0];
        if (p.helix) {
          // Adaptiv: schraubenförmig in neues Material (von der letzten Tiefe aus), unten eine volle Runde
          const { x: hx, y: hy, r: hr } = p.helix;
          const perRev = Math.max(0.05, Math.min(stepZ, 2 * Math.PI * hr * Math.tan((3 * Math.PI) / 180)));
          const revs = Math.max(1, Math.ceil((prevZ + 0.5 - z) / perRev));
          const seg = 24;
          gcode += `G0 Z${SAFE_Z.toFixed(2)}\nG0 X${(hx + hr).toFixed(3)} Y${hy.toFixed(3)}\n`;
          gcode += `G1 Z${(prevZ + 0.5).toFixed(3)} F${PLUNGE_FEED} ${c("gc.helix")}\nG1 F${Math.max(PLUNGE_FEED, Math.round(feedXY / 2))}\n`;
          for (let k = 1; k <= (revs + 1) * seg; k++) {
            const an = (2 * Math.PI * k) / seg, hz = Math.max(z, prevZ + 0.5 - ((prevZ + 0.5 - z) * k) / (revs * seg));
            gcode += `G1 X${(hx + hr * Math.cos(an)).toFixed(3)} Y${(hy + hr * Math.sin(an)).toFixed(3)} Z${hz.toFixed(3)}\n`;
          }
          gcode += `G1 X${s.x.toFixed(3)} Y${s.y.toFixed(3)} F${feedXY}\n`;
        } else {
          gcode += `G0 Z${SAFE_Z.toFixed(2)}\nG0 X${s.x.toFixed(3)} Y${s.y.toFixed(3)}\n`;
          plungeTo(p.pts, p.closed, prevZ, z);
        }
        for (let i = 1; i < p.pts.length; i++) gcode += `G1 X${p.pts[i].x.toFixed(3)} Y${p.pts[i].y.toFixed(3)}\n`;
        if (p.closed) gcode += `G1 X${s.x.toFixed(3)} Y${s.y.toFixed(3)}\n`;
      }
    });
    gcode += `G0 Z${SAFE_Z.toFixed(2)}\n`;
    if (allow > 0) {
      finishStart();
      for (const w of pocketWallPaths(outer, islands, toolRadius)) millPath(w.pts, w.closed, paths);
    }
  };

  /**
   * V-CARVE / INLAY-STECKER: alle Formen einer Gruppe mit gleicher Art, Tiefe und Start-Tiefe zusammen –
   * Löcher in Buchstaben und nahe Formen gehören zur selben Fläche (siehe vcarve.ts).
   * Tiefe in Lagen (Zustellung des Werkzeugs): jede Bahn wird in der Lage gefräst, in der sie ihre Tiefe erreicht;
   * tiefere Bahnen fahren in den Lagen davor schon auf Lagen-Tiefe.
   */
  const VSTEP = 0.12, CLEAR = 1.0;
  const millVcarve = (list: any[], mode: string, depth: number, start: number) => {
    const tool = curTool;
    if (!tool || !CONE_TYPES.includes(tool.type) || !(tool.angle > 0)) {
      lastGcodeWarnings.push(t("gcw.vNeedsVbit", { n: formCounter }));
      return;
    }
    const loops = list.map(closedMm).filter((x): x is P[] => !!x);
    if (!loops.length) return;
    const total = Math.abs(depth);
    const { paths, flat } = vcarvePaths(loops, {
      angle: tool.angle, tipDia: tool.tipDia || 0, toolDia: tool.diameter, maxDepth: total, start,
      step: VSTEP, outside: mode === "vplug"
    });
    if (!paths.length) { lastGcodeWarnings.push(t("gcw.vEmpty", { n: formCounter })); return; }
    const deepest = Math.min(...paths.map(p => p.z));
    if (mode === "vcarve" && flat && total > 0) lastGcodeWarnings.push(t("gcw.vFlat", { n: formCounter, d: (-deepest).toFixed(2) }));
    computePasses(deepest);
    let prev = 0;
    for (const lz of passes) {
      const todo = paths.filter(p => p.z < prev - 1e-6);
      for (const p of todo) {
        const z = Math.max(p.z, lz), s0 = p.pts[0];
        gcode += `G0 Z${CLEAR.toFixed(2)}\nG0 X${s0.x.toFixed(3)} Y${s0.y.toFixed(3)}\n`;
        gcode += `G1 Z${z.toFixed(3)} F${PLUNGE_FEED}\nG1 F${feedXY}\n`;
        for (let i = 1; i < p.pts.length; i++) gcode += `G1 X${p.pts[i].x.toFixed(3)} Y${p.pts[i].y.toFixed(3)}\n`;
        if (p.closed) gcode += `G1 X${s0.x.toFixed(3)} Y${s0.y.toFixed(3)}\n`;
      }
      prev = lz;
    }
    gcode += `G0 Z${SAFE_Z.toFixed(2)}\n`;
  };

  /**
   * BOHREN (Spänebrechen): senkrecht in der Mitte der Form, je Zustellung des Werkzeugs ein Stück tiefer,
   * dazwischen ganz heraus (Späne raus) und im Eilgang zurück bis kurz über die letzte Tiefe.
   * Ohne G81/G83 – die kennt GRBL nicht.
   */
  const DRILL_CLEAR = 0.5;
  const millDrill = (shape: any) => {
    const b = shape.type === "circle" ? null : shapeBounds(shape);
    const cPx = b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: shape.x, y: shape.y };
    const holeDia = (b ? Math.max(b.maxX - b.minX, b.maxY - b.minY) : 2 * Math.abs(shape.w)) / MM_TO_PIXEL;
    if (Math.abs(holeDia - toolDiameter) > 0.05) lastGcodeWarnings.push(t("gcw.drillSize", { n: formCounter, h: holeDia.toFixed(2), d: toolDiameter }));
    const p = toMachine(cPx.x, cPx.y);
    gcode += `G0 Z${SAFE_Z.toFixed(2)}\nG0 X${p.x.toFixed(3)} Y${p.y.toFixed(3)}\nG0 Z${DRILL_CLEAR.toFixed(2)}\n`;
    passes.forEach((z, i) => {
      if (i > 0) gcode += `G0 Z${DRILL_CLEAR.toFixed(2)} ${c("gc.peck")}\nG0 Z${(passes[i - 1] + 0.3).toFixed(3)}\n`;
      gcode += `G1 Z${z.toFixed(3)} F${PLUNGE_FEED}\n`;
    });
    gcode += `G0 Z${SAFE_Z.toFixed(2)}\n`;
  };

  /**
   * RESTMATERIAL mit dem aktuellen (kleinen) Werkzeug: Bahnen des kleinen Fräsers wie für die ganze Form,
   * aber nur die Stücke, an denen das große Werkzeug nicht hinkam (Ecken, enge Stellen). Ein Punkt gilt als
   * schon frei, wenn der kleine Fräser dort ganz in einen Kreis des großen passt: Abstand zur großen Bahn ≤ R − r.
   */
  const millRest = (shape: any) => {
    const big = toolForShape(shape);
    if (!big) return;
    const R = big.diameter / 2, r = toolRadius, mode = shape.millingMode;
    let bigPaths: { pts: P[]; closed: boolean }[] = [], small: { pts: P[]; closed: boolean }[] = [];
    if (mode === "pocket") {
      const outer = closedMm(shape);
      if (!outer) return;
      const isl = islandsOf(shape, outer);
      bigPaths = pocketPaths(outer, isl, R, Math.max(0.05, big.diameter * STEPOVER), pocketStrategy).paths;
      small = pocketPaths(outer, isl, r, Math.max(0.05, toolDiameter * STEPOVER), "spiral").paths;
    } else if (shape.type === "polyline" && shape.closed) {
      const pts: P[] = shape.points.map((p: any) => toMachine(p.x, p.y));
      bigPaths = offsetPolygon(pts, -R).map(l => ({ pts: l, closed: true }));
      // innen im Uhrzeigersinn (Gleichlauf wie bei den Konturen)
      small = offsetPolygon(pts, -r).map(l => ({ pts: [l[0], ...l.slice(1).reverse()], closed: true }));
    } else { gcode += `${c("gc.restNone")}\n`; return; } // Kreis innen: keine Ecken
    if (!small.length) { lastGcodeWarnings.push(t("gcw.toolTooBig", { n: formCounter, d: toolDiameter })); return; }
    // Strecken der großen Bahn in einem Raster (schnelle Abstandsfrage)
    const thr = R - r + 0.005, cell = Math.max(1, thr);
    const grid = new Map<string, [P, P][]>();
    for (const { pts, closed } of bigPaths) {
      for (let i = 0; i < (closed ? pts.length : pts.length - 1); i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        for (let gx = Math.floor(Math.min(a.x, b.x) / cell); gx <= Math.floor(Math.max(a.x, b.x) / cell); gx++)
          for (let gy = Math.floor(Math.min(a.y, b.y) / cell); gy <= Math.floor(Math.max(a.y, b.y) / cell); gy++) {
            const k = gx + "," + gy;
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k)!.push([a, b]);
          }
      }
    }
    const cleared = (p: P) => {
      for (let gx = Math.floor((p.x - thr) / cell); gx <= Math.floor((p.x + thr) / cell); gx++)
        for (let gy = Math.floor((p.y - thr) / cell); gy <= Math.floor((p.y + thr) / cell); gy++)
          for (const [a, b] of grid.get(gx + "," + gy) || []) {
            const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
            const f = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
            if (Math.hypot(a.x + dx * f - p.x, a.y + dy * f - p.y) <= thr) return true;
          }
      return false;
    };
    const stepS = Math.max(0.02, Math.min(0.2, r / 4));
    // Abtastpunkte auf geraden Stücken wieder weglassen (kürzerer G-Code)
    const thin = (q: P[]) => q.filter((p, i) => {
      if (i === 0 || i === q.length - 1) return true;
      const a = q[i - 1], b = q[i + 1];
      return Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) > 1e-6;
    });
    let pieces = 0;
    for (const { pts, closed } of small) {
      // Bahn fein abtasten
      const seq = closed ? [...pts, pts[0]] : pts;
      const sm: P[] = [seq[0]];
      for (let i = 1; i < seq.length; i++) {
        const a = seq[i - 1], b = seq[i], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / stepS));
        for (let k = 1; k <= n; k++) sm.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
      }
      const need = sm.map(p => !cleared(p));
      if (!need.some(Boolean)) continue;
      if (need.every(Boolean) && closed) { millPath(pts, true); pieces++; continue; }
      // jedes Stück um den Fräserradius verlängern (sauberer Übergang, Eintauchen im Freien)
      const ext = Math.ceil(r / stepS) + 1, N = sm.length;
      const keep = need.slice();
      need.forEach((v, i) => { if (!v) return; for (let k = -ext; k <= ext; k++) { const j = closed ? ((i + k) % N + N) % N : i + k; if (j >= 0 && j < N) keep[j] = true; } });
      // geschlossene Bahn: am Anfang eines freien Stücks beginnen, damit Stücke nicht über das Ende zerfallen
      let s0 = 0;
      if (closed) { const f = keep.indexOf(false); if (f >= 0) s0 = f; }
      let cur: P[] = [];
      for (let k = 0; k < N; k++) {
        const i = (s0 + k) % N;
        if (keep[i]) cur.push(sm[i]);
        else if (cur.length) { if (cur.length > 1) { millPath(thin(cur), false); pieces++; } cur = []; }
        if (!closed && k === N - 1) break;
      }
      if (cur.length > 1) { millPath(thin(cur), false); pieces++; }
    }
    if (!pieces) gcode += `${c("gc.restNone")}\n`;
  };

  /**
   * FASE mit Fasen- oder V-Fräser (halber Winkel θ, Spitze d0): Tiefe h = Breite / tan θ, die Spitze läuft d0/2
   * neben der Kante (außen bei Außenkonturen, innen bei Löchern/Taschen) – dann trifft der Kegel die Wand genau an
   * der Kante und die Oberseite in Fasenbreite daneben.
   */
  const millChamfer = (shape: any) => {
    const tool = curTool;
    if (!tool || !CONE_TYPES.includes(tool.type) || !(tool.angle > 0) || tool.angle >= 180) {
      lastGcodeWarnings.push(t("gcw.chamferTool", { n: formCounter }));
      return;
    }
    const w = Math.max(0.05, Number(shape.chamferW) || 1), th = (tool.angle / 2) * Math.PI / 180;
    const h = w / Math.tan(th), o = (tool.tipDia || 0) / 2;
    if (o + w > tool.diameter / 2 + 1e-6) { lastGcodeWarnings.push(t("gcw.chamferWide", { n: formCounter, w, d: tool.diameter })); return; }
    computePasses(-h);
    const side = Number(shape.chamferSide) || 0;
    if (shape.type === "circle") {
      const c0 = toMachine(shape.x, shape.y), r = Math.abs(shape.w) / MM_TO_PIXEL + side * o;
      if (r <= 0.05) { lastGcodeWarnings.push(t("gcw.toolTooBig", { n: formCounter, d: toolDiameter })); return; }
      gcode += `G0 Z${SAFE_Z.toFixed(2)}\nG0 X${c0.x.toFixed(3)} Y${(c0.y + r).toFixed(3)}\n`;
      passes.forEach(z => {
        gcode += `G1 Z${z.toFixed(3)} F${PLUNGE_FEED}\nG1 F${feedXY}\n`;
        gcode += `G2 X${c0.x.toFixed(3)} Y${(c0.y + r).toFixed(3)} I0.000 J${(-r).toFixed(3)}\n`;
      });
      gcode += `G0 Z${SAFE_Z.toFixed(2)}\n`;
      return;
    }
    if (shape.type === "polyline" && shape.closed && side !== 0) {
      const pts: P[] = shape.points.map((p: any) => toMachine(p.x, p.y));
      const loops = o > 1e-9 ? offsetPolygon(pts, side * o) : [pts];
      if (!loops.length) { lastGcodeWarnings.push(t("gcw.toolTooBig", { n: formCounter, d: toolDiameter })); return; }
      // Gleichlauf wie bei den Konturen: außen gegen, innen im Uhrzeigersinn
      for (const l of loops) millPath((side > 0) !== (polygonArea(l) > 0) ? [l[0], ...l.slice(1).reverse()] : l, true);
      return;
    }
    // offene Linien, Bögen, Gravur-Formen: auf der Linie
    for (const p of shapeToPaths(shape)) if (p.pts.length > 1) millPath(p.pts.map(q => toMachine(q.x, q.y)), p.closed);
  };

  // ---- 6. FORMEN NACHEINANDER ABFAHREN ----
  let formCounter = 0;
  const computeDepth = (s: any): number => typeof s.millingDepth === "number" && Number.isFinite(s.millingDepth) ? s.millingDepth : fallbackDepth;
  const alreadyChained = new Set<string>();
  /** Vorschub-Anpassung nur bei Fräsern mit Schneide am Umfang – nicht Bohren, V-Carve, Fase, adaptive Tasche */
  const adaptsFeed = (shape: any): boolean => {
    if (curTool && (CONE_TYPES.includes(curTool.type) || curTool.type === "drill")) return false;
    if (shape.restOf) return true;
    const mode = shape.millingMode || "outside";
    if (mode === "drill" || mode === "vcarve" || mode === "vplug" || mode === "chamfer") return false;
    return !(mode === "pocket" && pocketStrategy === "adaptive");
  };

  groups.forEach((group, gi) => {
  useTool(group.tool);
  const toolName = curTool ? curTool.name : "Standard";
  if (gi > 0) {
    // ---- WERKZEUGWECHSEL ----
    gcode += `\nG0 Z${SAFE_Z.toFixed(2)}\n`;
    gcode += `M5 ${c("gc.spindleOff")}\n`;
    gcode += `${toolChangeGcode(curTool ? toolNumber(curTool) : 0, c("gc.toolChange", { i: gi + 1, name: toolName, d: toolDiameter.toFixed(1) }))}\n`;
  }
  gcode += `\n${c("gc.tool", { name: toolName, d: toolDiameter.toFixed(1) })}\n`;
  // M3 = rechts – bei „Drehrichtung umkehren“ M4 (Spindel falsch herum verkabelt)
  gcode += `${spindleCode("M3")} S${rpm} ${c("gc.spindleOn", { rpm })}\n`;
  if (gi > 0) gcode += `G4 P2 ${c("gc.spinUp")}\n`;
  gcode += `F${feedXY} ${c("gc.feed", { f: feedXY })}\n`;

  const vDone = new Set<any>();
  const millShape = (shape: any) => {
    if (vDone.has(shape)) return;
    if (shape.restOf) {
      formCounter++;
      computePasses(computeDepth(shape.restOf));
      gcode += `\n${c("gc.rest", { n: formCounter })}\n`;
      millRest(shape.restOf);
      return;
    }
    if (shape.parentChainId && alreadyChained.has(shape.parentChainId)) return;
    if (shape.parentChainId) alreadyChained.add(shape.parentChainId);

    formCounter++;
    computePasses(computeDepth(shape));
    const mode = shape.millingMode || "outside";
    if (mode === "chamfer") {
      gcode += `\n${c("gc.chamfer", { n: formCounter, w: Number(shape.chamferW) || 1 })}\n`;
      millChamfer(shape);
      return;
    }
    if (mode === "drill") {
      gcode += `\n${c("gc.drill", { n: formCounter })}\n`;
      millDrill(shape);
      return;
    }
    if (mode === "vcarve" || mode === "vplug") {
      const depth = computeDepth(shape), start = mode === "vplug" ? Math.max(0, shape.vStart ?? 0) : 0;
      const same = group.shapes.filter((o: any) => (o.millingMode === mode) && computeDepth(o) === depth
        && (mode !== "vplug" || Math.max(0, o.vStart ?? 0) === start));
      same.forEach((o: any) => vDone.add(o));
      gcode += `\n${c(mode === "vplug" ? "gc.vplug" : "gc.vcarve", { n: formCounter, k: same.length })}\n`;
      millVcarve(same, mode, depth, start);
      return;
    }
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
      passes.forEach((z, pi) => {
        plungeTo([s0, e0], false, pi > 0 ? passes[pi - 1] : 0, z);
        gcode += `G1 X${e0.x.toFixed(3)} Y${e0.y.toFixed(3)}\n`;
        if (z !== passes[passes.length - 1]) gcode += `G0 Z${SAFE_Z.toFixed(2)}\nG0 X${s0.x.toFixed(3)} Y${s0.y.toFixed(3)}\n`;
      });
      gcode += `G0 Z${SAFE_Z.toFixed(2)}\n`;
    }
    else if (shape.type === "circle") {
      const center = toMachine(shape.x, shape.y);
      const radiusPx = Math.abs(shape.w);
      const radiusFinal = radiusPx / MM_TO_PIXEL + offset;
      // Schlichtgang: erst mit Aufmaß (außen größer, innen kleiner), danach auf Maß
      let allow = mode === "outside" || mode === "inside" ? finishAllow(shape) : 0;
      if (allow > 0 && mode === "inside" && radiusFinal - allow <= 0.05) { lastGcodeWarnings.push(t("gcw.finishSkip", { n: formCounter, a: allow })); allow = 0; }
      const radiusMm = radiusFinal + (mode === "outside" ? allow : -allow);
      const tab = mode !== "on-line" ? tabSettings(shape) : null;
      // mit Haltestegen: Kreis als Vieleck (außen gegen, innen im Uhrzeigersinn – wie bei den Konturen)
      let ring = tab && radiusMm > 0.05 ? makeEllipsePoints(center.x, center.y, radiusMm, radiusMm) : null;
      if (ring && mode === "inside") ring = [ring[0], ...ring.slice(1).reverse()];
      if (ring && millTabbed(ring, shape, tab!)) {
        if (allow > 0) {
          let fin = makeEllipsePoints(center.x, center.y, radiusFinal, radiusFinal);
          if (mode === "inside") fin = [fin[0], ...fin.slice(1).reverse()];
          finishStart();
          millTabbed(fin, shape, tab!, [ring]);
        }
      }
      else if (radiusMm > 0.05) {
        passes.forEach((z, pi) => {
          const entryX = center.x;
          const entryY = center.y + radiusMm;
          const full = (zz?: number) => `G2 X${entryX.toFixed(3)} Y${entryY.toFixed(3)}${zz === undefined ? "" : ` Z${zz.toFixed(3)}`} I0.000 J${(-radiusMm).toFixed(3)}\n`;
          gcode += `G0 X${entryX.toFixed(3)} Y${entryY.toFixed(3)}\n`;
          const zTop = pi > 0 ? passes[pi - 1] : 0, drop = zTop - z;
          if (rampTan > 0 && drop > 1e-6) {
            // Rampe als Schraube auf dem Kreis (so viele Runden, dass der Winkel nicht steiler wird)
            const revs = Math.max(1, Math.ceil(drop / rampTan / (2 * Math.PI * radiusMm)));
            gcode += `G1 Z${zTop.toFixed(3)} F${PLUNGE_FEED} ${c("gc.ramp")}\nG1 F${feedXY}\n`;
            for (let k = 1; k <= revs; k++) gcode += full(zTop - (drop * k) / revs);
          } else gcode += `G1 Z${z.toFixed(2)} F${PLUNGE_FEED}\nF${feedXY}\n`;
          gcode += full();
        });
        if (allow > 0) {
          // auf der Schrupp-Bahn eintauchen, seitlich auf Maß, eine Runde, zurück
          const z = passes[passes.length - 1], yF = center.y + radiusFinal;
          gcode += `${c("gc.finish")}\nG1 Z${z.toFixed(3)} F${PLUNGE_FEED}\nG1 X${center.x.toFixed(3)} Y${yF.toFixed(3)} F${feedXY}\n`;
          gcode += `G2 X${center.x.toFixed(3)} Y${yF.toFixed(3)} I0.000 J${(-radiusFinal).toFixed(3)}\n`;
          gcode += `G1 X${center.x.toFixed(3)} Y${(center.y + radiusMm).toFixed(3)}\n`;
        }
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
        let allow = finishAllow(shape);
        let loops = offsetPolygon(pts, offset + Math.sign(offset) * allow);
        if (allow > 0 && loops.length === 0) {
          lastGcodeWarnings.push(t("gcw.finishSkip", { n: formCounter, a: allow }));
          allow = 0;
          loops = offsetPolygon(pts, offset);
        }
        if (loops.length === 0) {
          gcode += `${c("gc.toolTooBig")}\n`;
          lastGcodeWarnings.push(t("gcw.toolTooBig", { n: formCounter, d: toolDiameter }));
        }
        if (loops.length > 1) {
          lastGcodeWarnings.push(t("gcw.split", { n: formCounter, parts: loops.length }));
        }
        // Gleichlauf-Fräsen (bei rechtsdrehender Spindel M3):
        // außen gegen den Uhrzeigersinn, innen im Uhrzeigersinn
        // umdrehen, aber am selben Punkt anfangen (dann liegen die Haltestege wie in der Vorschau)
        const orient = (loop: P[]) => ((mode === "outside") !== (polygonArea(loop) > 0) ? [loop[0], ...loop.slice(1).reverse()] : loop);
        const tab = tabSettings(shape);
        const rough = loops.map(orient);
        rough.forEach(path => { if (!tab || !millTabbed(path, shape, tab)) millPath(path, true); });
        if (allow > 0) {
          finishStart();
          offsetPolygon(pts, offset).map(orient).forEach(path => {
            if (!tab || !millTabbed(path, shape, tab, rough)) millPath(path, true, rough.map(l => ({ pts: l, closed: true })));
          });
        }
      }
    }
    else if (shape.type === "rect" || shape.type === "path") {
      gcode += `${c("gc.unsupported", { type: shape.type })}\n`;
      lastGcodeWarnings.push(t("gcw.unsupported", { n: formCounter, type: shape.type }));
    }
  };
  group.shapes.forEach((shape: any) => {
    const from = gcode.length;
    millShape(shape);
    // Vorschub in engen Kurven und Innenecken senken (feedAdapt.ts)
    if (feedAdapt.on && adaptsFeed(shape)) gcode = gcode.slice(0, from) + adaptFeed(gcode.slice(from), toolRadius, feedAdapt.minPct);
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
