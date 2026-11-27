/**
 * FRÄS-AUFTRAG FÜR RUST (src-tauri/src/millgcode.rs) – ETAPPEN 1 BIS 6 (alles außer Bildern, Datei für Steuerungen mit Werkzeugtabelle und Zwiebelhaut beim zweiseitigen Fräsen)
 *
 * cam.ts liest beim Erzeugen des G-Codes aus vielen Stellen: Werkzeug-Bibliothek, Material-Profile, Einstellungen,
 * Sprachdatei, Eingabefelder. millJob() sammelt all das für eine Liste von Formen in EIN Objekt, das sich als JSON
 * verschicken lässt. Was Rust noch nicht kann, wird hier erkannt: dann gibt es keinen Auftrag, sondern den Grund.
 *
 * AN DER MASCHINE NUR GEPRÜFT: „Zur Maschine“ und „G-Code speichern“ nehmen den G-Code aus Rust, wenn er Zeichen für
 * Zeichen gleich dem aus cam.ts ist (rustChecked, generateGcodeChecked in cam.ts) – sonst den aus cam.ts.
 * Alle Vorschauen rechnen mit cam.ts; im Entwicklungs-Build rechnet Rust daneben und vergleicht (shadowMill) – das
 * Ergebnis steht im Terminal (`millgcode: … same as cam.ts`) und in der Konsole.
 */
import { toolForShape, cutDiameter, routerDial, toolSettings, CONE_TYPES, DEFAULT_PLUNGE, type MillingTool } from "./toolLibrary";
import { resolveCut, cleanCutData } from "./millProfiles";
import en from "./i18n/lang/en.json";
import { tabSettings } from "./tabs";
import { expandOps } from "./ops";
import { spindleCode } from "./spindleDir";
import { leadOptions } from "./millLead";
import { ascii, t, tMm } from "./i18n/i18n";
import { feedAdapt } from "./feedAdapt";
import { probeSettings } from "./probe";
import { cutDirOf, cutStartOf, hasCutSetting, overridesMillDir } from "./cutSetting";
import { fluteFits, fluteSettings } from "./fluting";
import { troFits, troSettings } from "./trochoid";
import { skinRole, skinSettings } from "./onionSkin";
import { twoSidedFingerprint } from "./twoSidedJob";
import { postCtx } from "./post/postContext";
import { isInch } from "./units";
import { getTool, getTools, toolNumber } from "./toolLibrary";
import { toolChangeGcode } from "./toolChange";
import { cloneShape, convertToPolyline, shapeBounds, shapeToPaths } from "./shapeTransform";

/** gleiche Zahl wie JOB_VERSION in millgcode.rs – ändern, wenn sich der Auftrag ändert */
export const MILL_JOB_VERSION = 18;

const TEXTS = ["gc.unitMm", "gc.absolute", "gc.safeZ", "gc.tool", "gc.spindleOn", "gc.spinUp", "gc.feed", "gc.shape", "gc.tab", "gc.ramp",
  "gc.cutData", "gc.circleTooSmall", "gc.toolTooBig", "gc.spindleOff", "gc.park", "gc.end", "gc.toolList", "gc.toolListItem", "gc.toolChange", "gc.helix", "gc.finish", "gc.face", "gc.drill", "gc.peck", "gc.chamfer", "gc.thread", "gc.vcarve", "gc.vplug", "gc.skin", "gc.skinCutAll", "gc.skinCut", "gc.flute", "gc.trochoid", "gc.rest", "gc.restNone"];
/** diese Texte nimmt cam.ts in der Sprache der Oberfläche (t), nicht in der des G-Codes */
const TEXTS_UI = ["gc.threadIn", "gc.threadOut", "gc.threadLeft", "gc.threadRight"];

export type MillJob = Record<string, unknown>;

/** Schlüssel aller Hinweise, die cam.ts beim Fräsen melden kann (Rust bekommt die Texte dazu in der Sprache der Oberfläche) */
const WARN_KEYS = Object.keys(en).filter(k => k.startsWith("gcw.") || k.startsWith("cut."));
/** Werkzeugarten, die nicht für Konturen mit Fräser-Versatz und Taschen taugen (Hinweis gcw.toolType in cam.ts) */
const NO_CONTOUR = ["vbit", "drill", "spotdrill", "reamer", "countersink", "threadmill", "taper"];
/** Werkzeuge eines Auftrags in der Reihenfolge von job.tools – Rust nennt Werkzeuge nur mit ihrer Nummer darin */
export const jobTools = new WeakMap<object, MillingTool[]>();

/** Der Auftrag für diese Formen – oder { no: Grund }, wenn Etappe 1 das noch nicht kann */
export function millJob(shapes: any[], fallbackDepth: number, pocketStrategy: string): MillJob | { no: string } {
  // Drehachse, Sperrzonen, Bogen-Glättung und der Kopf für zweiseitiges Fräsen laufen in cam.ts erst NACH dem G-Code,
  // den Rust erzeugt (generateGcode) – sie ändern hier nichts
  if (postCtx.toolTable) return { no: "tool table post" };
  const tools: MillingTool[] = [];
  const out: unknown[] = [];
  if (shapes.some(s => s.restOf || s.opOf)) return { no: "shapes that are already copies" };
  // weitere Bearbeitungen (ops.ts): jede ist für den G-Code eine eigene Form (Kopie mit opOf = Original)
  const all = expandOps(shapes);
  // Restmaterial-Werkzeug gewählt, das nicht passt (restIgnored in cam.ts – dort über die Formen wie gezeichnet)
  const restFits = (s: any) => { const m = s.millingMode || "outside", r = getTool(s.restToolId), own = toolForShape(s); return !!((m === "pocket" || m === "inside") && r && own && r.id !== own.id && r.diameter < own.diameter); };
  const restIgnored = shapes.filter(s => getTool(s.restToolId) && !restFits(s)).length;
  for (const s of all) {
    if (s.type === "image") return { no: "image" };
    // Restmaterial (restToolFor in cam.ts): kleineres Werkzeug für Taschen und Innenkonturen
    const restMode = s.millingMode || "outside", restT = getTool(s.restToolId), ownT = toolForShape(s);
    const rest = (restMode === "pocket" || restMode === "inside") && restT && ownT && restT.id !== ownT.id && restT.diameter < ownT.diameter ? restT : null;
    if (rest && skinRole(s) === "skin") return { no: "rest material on a shape with onion skin" };
    if (rest && !tools.includes(rest)) tools.push(rest);
    const mode = s.millingMode || "outside";
    if (!["outside", "inside", "on-line", "pocket", "drill", "face", "chamfer", "thread", "cbore", "vcarve", "vplug"].includes(mode)) return { no: `mode ${mode}` };
    // Tasche: nur Kreis und geschlossener Linienzug (bei anderen Formen fräst cam.ts die Kontur – noch nicht hier)
    if (mode === "pocket" && !(s.type === "circle" || (s.type === "polyline" && s.closed && s.points?.length >= 3))) return { no: "pocket on an open shape" };
    if (s.type !== "polyline" && s.type !== "circle" && s.type !== "line" && s.type !== "arc") return { no: `shape ${s.type}` };
    if (s.type === "polyline" && !(Array.isArray(s.points) && s.points.length >= 1)) return { no: "polyline without points" };
    // Startpunkt/Richtung von Hand (cutSetting.ts) wirkt nur bei diesen Arten; Kreis, Bogen und Linie fährt cam.ts dann
    // als Linienzug (cutReady) – die Punkte dafür kommen von hier (shapeToPaths), die Form selbst bleibt für die Reihenfolge
    const cutSet = hasCutSetting(s) && ["on-line", "outside", "inside", "chamfer"].includes(mode);
    let cutPoints: unknown = null;
    if (cutSet && s.type !== "polyline") {
      const copy = cloneShape(s);
      convertToPolyline(copy);
      cutPoints = { pts: copy.points.map((p: any) => [p.x, p.y]), closed: !!copy.closed };
    }
    // Zwiebelhaut (onionSkin.ts): nur der Schnitt, der sie bekommt. Zweiseitig kennt die echte Materialdicke – noch nicht hier
    const skin = skinRole(s) === "skin" ? skinSettings(s) : null;
    if (skin && twoSidedFingerprint()) return { no: "onion skin with two-sided milling" };
    // Trochoidal (trochoid.ts): die Nut neben der Kontur in kleinen Kreisen freiräumen
    const tro = troFits(s) ? troSettings(s) : null;
    // Flöte (fluting.ts): offene Linie auf der Linie, die Tiefe folgt einer Kurve
    const flute = fluteFits(s) ? fluteSettings(s) : null;
    const sided = mode === "outside" || mode === "inside";
    const closedShape = s.type === "circle" || (s.type === "polyline" && s.closed);
    const lead = sided && closedShape ? leadOptions(s) : null;
    const allow = Number(s.finishAllow);
    const tool = toolForShape(s);
    if (tool && !tools.includes(tool)) tools.push(tool);
    const box = s.type === "arc" ? shapeBounds(s) : null;
    // Planfräsen: Fläche der Form in mm (wie millFace in cam.ts: Rahmen um alle Punkte der Bahn)
    let face: number[] | null = null;
    if (mode === "face") {
      const fp = shapeToPaths(s).flatMap(q => q.pts).map(q => ({ x: q.x / 2, y: q.y / 2 }));
      if (fp.length) {
        const xs = fp.map(q => q.x), ys = fp.map(q => q.y), x0 = Math.min(...xs), y0 = Math.min(...ys);
        face = [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0];
      }
    }
    // Fase an einem Bogen: die Bahn als Punkte in mm (shapeToPaths – wie millChamfer in cam.ts)
    const paths = (mode === "chamfer" || flute) && s.type === "arc"
      ? shapeToPaths(s).map(q => ({ pts: q.pts.map(v => [v.x / 2, v.y / 2]), closed: !!q.closed })) : null;
    // Gewinde: Länge wie millThread in cam.ts (ohne Tiefe an der Form 0 – nicht die Tiefe aus dem Eingabefeld)
    if (mode === "thread" && typeof s.millingDepth === "number" && !Number.isFinite(s.millingDepth)) return { no: "thread without a length" };
    const thread = mode === "thread" ? {
      len: Math.abs(typeof s.millingDepth === "number" ? s.millingDepth : 0),
      d: Number(s.threadD) || 0, pitch: Number(s.threadPitch) || 0, left: !!s.threadLeft,
      passes: Number(s.threadPasses) || 1, spring: !!s.threadSpring
    } : null;
    const cut = resolveCut(s.cutData, tool, toolSettings);
    // Material-Profil, das für ein anderes Werkzeug angewendet wurde: cam.ts nimmt die Werkzeug-Werte und sagt es
    const cutOff = !cut && !s.opOf ? cleanCutData(s.cutData)?.label ?? null : null;
    // Gewinde in ein Loch, das nur als Kontur „Innen“ gefräst wird: Werkzeug jener Kontur (Hinweis gcw.threadCore)
    const firstTool = mode === "thread" && s.opOf?.millingMode === "inside" ? toolForShape(s.opOf) : null;
    // Stege: Kreis nur außen/innen; Linienzug nur geschlossen außen/innen (sonst fragt cam.ts gar nicht danach)
    const tab = sided && closedShape ? tabSettings(s) : null;
    out.push({
      type: s.type, x: s.x, y: s.y, w: s.w, h: s.h,
      points: s.type === "polyline" ? s.points.map((p: any) => [p.x, p.y]) : [],
      closed: s.type === "polyline" ? !!s.closed : s.type === "circle",
      mode,
      depth: typeof s.millingDepth === "number" && Number.isFinite(s.millingDepth) ? s.millingDepth : fallbackDepth,
      millDir: s.millDir === "climb" || s.millDir === "conventional" ? s.millDir : "",
      cut: cut && { feedrate: cut.feedrate, rpm: cut.rpm, stepZ: cut.stepZ, plungeFeed: cut.plungeFeed, label: ascii(String(cut.label)) },
      tab: tab && {
        len: tab.len, h: tab.h, manual: s.tabMode === "manual",
        n: Math.round(Number(s.tabN) || 0),
        pts: s.tabMode === "manual" ? (s.tabPts || []).map((f: unknown) => Number(f)) : []
      },
      parentChainId: s.parentChainId ? String(s.parentChainId) : null,
      tool: tool ? tools.indexOf(tool) : null,
      lead, face, paths, thread,
      // Kopie für eine weitere Bearbeitung: Nummer des Originals in dieser Liste
      cutDir: cutSet ? cutDirOf(s) ?? "" : "", cutStart: cutSet ? cutStartOf(s) : null, cutPoints,
      skin, flute, tro,
      cutOff: cutOff === null ? null : String(cutOff),
      cutWarn: !hasCutSetting(s) ? "" : !cutSet ? "ignored" : overridesMillDir(s) ? "millDir" : "",
      skinIgnored: skinRole(s) === "ignored",
      threadFirst: firstTool ? [cutDiameter(firstTool), firstTool.diameter] : null,
      restTool: rest ? tools.indexOf(rest) : null,
      vStart: mode === "vplug" ? Math.max(0, s.vStart ?? 0) : 0,
      base: s.opOf ? all.indexOf(s.opOf) : null,
      // Stufenbohrung: Ø der Senkung und Ø des Lochs darunter (0 = kein Kreis)
      cbore: s.cbore ? [Number(s.cboreD), s.opOf?.type === "circle" ? 2 * Math.abs(s.opOf.w) / 2 : 0] : null,
      // Zweiseitig: Loch für einen Passstift heißt im G-Code auch so
      pinMark: s.pin ? `(--- ${ascii(tMm("two.gc.pin", { n: s.pin }))} ---)` : null,
      chamferW: Number(s.chamferW) || 0, chamferSide: Number(s.chamferSide) || 0,
      id: String(s.id ?? ""), noIsland: !!s.noIsland,
      islandFor: Array.isArray(s.islandFor) ? s.islandFor.map((v: unknown) => String(v)) : null,
      finishAllow: (mode === "pocket" || (sided && closedShape)) && Number.isFinite(allow) && allow > 0 ? Math.min(allow, 5) : 0,
      ...(s.type === "arc" ? { midX: s.midX, midY: s.midY, bounds: box && [box.minX, box.minY, box.maxX, box.maxY] } : {})
    });
  }
  // An-/Wegfahren: die Bahnen aller Formen in mm – daran muss die Anfahrbahn vorbeikommen (leadFree in cam.ts)
  const leadOthers: unknown[] = [];
  if (out.some((o: any) => o.lead || o.tro)) {
    shapes.forEach(s => {
      const owner = all.indexOf(s);
      try { for (const p of shapeToPaths(s)) leadOthers.push({ pts: p.pts.map(q => [q.x / 2, q.y / 2]), closed: p.closed, owner }); } catch { /* ohne Bahn */ }
    });
  }
  const lib = getTools();
  const job: MillJob = {
    version: MILL_JOB_VERSION,
    tools: tools.map(tool => {
      const dial = postCtx.foreign ? null : routerDial(tool.rpm);
      return {
        name: ascii(tool.name), rawName: String(tool.name), dialOut: dial?.out || null, dialRpm: dial ? dial.rpm : 0,
        spot: tool.type === "spotdrill", typeText: NO_CONTOUR.includes(tool.type) ? t("tl.type." + tool.type) : null,
        threadSingle: !!tool.threadSingle, fluteLen: Number(tool.fluteLen) || 0,
        diameter: cutDiameter(tool), rawDiameter: tool.diameter, libIndex: lib.indexOf(tool),
        stepZ: tool.stepZ, feedrate: tool.feedrate, rpm: tool.rpm,
        plungeFeed: tool.plungeFeed ?? DEFAULT_PLUNGE,
        // tan(Eintauchwinkel) wie in cam.ts gerechnet – Rust nimmt genau diese Zahl (sein Tangens kann in der letzten Stelle abweichen)
        rampTan: ((ra: number) => ra > 0 ? Math.tan((Math.min(45, ra) * Math.PI) / 180) : 0)(CONE_TYPES.includes(tool.type) ? 0 : tool.rampAngle ?? 0),
        dial: dial ? ascii(tMm("gc.dial", { pos: dial.pos, rpm: dial.rpm })) : null,
        // Anfang der Werkzeugwechsel-Zeile ("M0 " oder "M6 T3 "), der Hinweis dahinter entsteht in Rust
        change: toolChangeGcode(toolNumber(tool), ""),
        reamer: tool.type === "reamer",
        // Werkzeuge, mit denen cam.ts nicht trochoidal fräst
        noTro: CONE_TYPES.includes(tool.type) || tool.type === "reamer" || tool.type === "threadmill" || tool.type === "taper",
        // Fase: Kegel-Werkzeug (Winkel an der Spitze, Ø der Spitze); tan(halber Winkel) wie in cam.ts gerechnet
        cone: CONE_TYPES.includes(tool.type), angle: Number(tool.angle) || 0, tipDia: tool.tipDia || 0,
        chamferTan: Math.tan((tool.angle / 2) * Math.PI / 180) || 0,
        // Gewindefräser: Steigung des Werkzeugs (0 = Einzahn, schneidet jede Steigung); null = kein Gewindefräser
        threadPitch: tool.type === "threadmill" ? (tool.threadSingle ? 0 : tool.pitch || 1) : null
      };
    }),
    spindle: spindleCode("M3"),
    texts: Object.fromEntries([...TEXTS.map(k => [k, ascii(tMm(k))]), ...TEXTS_UI.map(k => [k, ascii(t(k))])]),
    shapes: out,
    pocketStrategy,
    // Vorschub in Kurven anpassen (feedAdapt.ts): kleinster Vorschub in %, null = aus
    feedAdapt: feedAdapt.on ? feedAdapt.minPct : null,
    // Werkzeug während langer Jobs nachmessen (driftPoints.ts): Abstand in Minuten und die Zeile für einen Mess-Punkt
    drift: probeSettings.drOn === 1 && !postCtx.foreign ? { everyMin: probeSettings.drMin, marker: `M0 (${ascii(tMm("gc.remeasure"))})`, noSpot: probeSettings.tcMode !== 1 && !probeSettings.tcPos } : null,
    helixTan: Math.tan((3 * Math.PI) / 180),
    leadOthers,
    // Hinweise: Texte in der Sprache der Oberfläche (Rust erkennt daran „schon gemeldet“, eingesetzt wird hier mit t())
    warnTexts: Object.fromEntries(WARN_KEYS.map(k => [k, t(k)])),
    restIgnored
  };
  jobTools.set(job, tools);
  // nur Zahlen, die JSON unverändert überträgt
  let ok = true;
  JSON.stringify(job, (_k, v) => { if (typeof v === "number" && !Number.isFinite(v)) ok = false; return v; });
  return ok ? job : { no: "a value is not a number" };
}

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/** Ergebnis des letzten Vergleichs (für Tests in der App und die Konsole) */
export let lastShadow: { same?: boolean; no?: string; lines?: number; ms?: number; line?: number; rust?: string; ts?: string; side?: string | null } | null = null;
/** Was cam.ts neben dem G-Code liefert: Hinweise (fertiger Text), Gewinde, Werkzeug je Abschnitt */
export interface InnerSide { warnings: string[]; threads: unknown[]; sectionTools: (MillingTool | null)[] }
/** Ergebnis des letzten Fräs-G-Codes aus cam.ts, noch vor Drehachse, Sperrzonen und Bogen-Glättung (für den Vergleich und die Testfälle) */
export let lastInner: { shapes: any[]; fallbackDepth: number; pocketStrategy: string; gcode: string | null; side: InnerSide } | null = null;
/** true, solange generateGcodeChecked (cam.ts) läuft: dann vergleicht rustChecked – nicht zusätzlich shadowMill */
let checking = false;
export const setChecking = (on: boolean) => { checking = on; };

export type RustMill =
  | { ok: true; gcode: string; warnings: string[]; threads: unknown[]; sectionTools: (MillingTool | null)[]; ms: number }
  | { ok: false; no: string; differs: boolean };

/**
 * FRÄS-G-CODE AUS RUST, MIT cam.ts GEPRÜFT – für „Zur Maschine“ und „G-Code speichern“ (generateGcodeChecked in cam.ts).
 * Nimmt den Auftrag des letzten Fräs-G-Codes aus cam.ts (lastInner), lässt Rust denselben Auftrag rechnen und gibt Rusts
 * Ergebnis nur zurück, wenn es Zeichen für Zeichen gleich ist und Hinweise, Gewinde und Werkzeuge stimmen.
 * Sonst { ok: false }: der Aufrufer bleibt beim G-Code aus cam.ts. differs = Rust hat etwas anderes gerechnet (das soll
 * man melden); ohne differs kann Rust diesen Auftrag nur noch nicht (Bilder, Vorschau im Browser …).
 * Der Auftrag entsteht sofort (vor dem ersten await) – spätere Änderungen an der Zeichnung ändern ihn nicht mehr.
 */
export function rustChecked(expected: string): Promise<RustMill> {
  const inner = lastInner;
  if (!IN_TAURI) return Promise.resolve({ ok: false, no: "not in the app", differs: false });
  if (!inner || !inner.gcode || inner.gcode !== expected) return Promise.resolve({ ok: false, no: "no G-code", differs: false });
  let job: ReturnType<typeof millJob>;
  try { job = millJob(inner.shapes, inner.fallbackDepth, inner.pocketStrategy); } catch (e) { job = { no: "job failed: " + String(e) }; }
  if ("no" in job) return Promise.resolve({ ok: false, no: String(job.no), differs: false });
  const tools = jobTools.get(job) || [];
  const side = { ...sideForJob(job as MillJob, inner.side), ...(isInch() ? { warnings: null } : {}) };
  type Reply = { gcode: string; same: boolean; near: number; side: string | null; line?: number; rust?: string; ts?: string; ms: number;
    warnings: { key: string; p: [string, string][] }[]; threads: unknown[]; sectionTools: (number | null)[] };
  return import("@tauri-apps/api/core").then(({ invoke }) => invoke<Reply>("millgcode_generate", { job, expected: inner.gcode, side }))
    .then((r): RustMill => {
      if (!r.same) return { ok: false, no: `line ${r.line}: Rust "${r.rust}", cam.ts "${r.ts}"`, differs: true };
      if (r.side) return { ok: false, no: r.side, differs: true };
      // ein Tausendstel in einer Zahl (Rundungsgrenze bei Sinus/Kosinus): kein Fehler, aber nicht derselbe Text
      if (r.near > 0 || r.gcode !== inner.gcode) return { ok: false, no: `${r.near} line(s) differ by 0.001`, differs: false };
      return {
        ok: true, gcode: r.gcode, ms: r.ms, threads: r.threads,
        warnings: r.warnings.map(w => t(w.key, Object.fromEntries(w.p))),
        sectionTools: r.sectionTools.map(i => i === null ? null : tools[i] ?? null)
      };
    })
    .catch(e => ({ ok: false, no: String(e), differs: false }));
}
/** Nebenergebnisse so, wie Rust sie nennt: Werkzeuge als Nummer in job.tools */
export const sideForJob = (job: MillJob, side: InnerSide) => {
  const tools = jobTools.get(job) || [];
  return { warnings: side.warnings, threads: side.threads, sectionTools: side.sectionTools.map(tl => tl ? tools.indexOf(tl) : null) };
};

/**
 * Nur im Entwicklungs-Build der App: Rust rechnet denselben Auftrag daneben und vergleicht mit dem G-Code aus cam.ts.
 * Ändert nichts am G-Code, der benutzt wird. Jede Abweichung steht in der Konsole (und im Terminal).
 */
export function shadowMill(shapes: any[], fallbackDepth: number, pocketStrategy: string, gcode: string | null, inner: InnerSide) {
  lastInner = { shapes, fallbackDepth, pocketStrategy, gcode, side: inner };
  if (checking || !IN_TAURI || !(import.meta as any).env?.DEV || !gcode) return;
  let job: ReturnType<typeof millJob>;
  try { job = millJob(shapes, fallbackDepth, pocketStrategy); } catch (e) { job = { no: "job failed: " + String(e) }; }
  if ("no" in job) { lastShadow = { no: String(job.no) }; console.debug("millgcode: not yet in Rust –", job.no); return; }
  void import("@tauri-apps/api/core").then(({ invoke }) => invoke<typeof lastShadow>("millgcode_shadow", { job, expected: gcode, side: { ...sideForJob(job as MillJob, inner), ...(isInch() ? { warnings: null } : {}) } }))
    .then(r => {
      lastShadow = r;
      if (r && !r.same) console.warn(`millgcode: Rust differs from cam.ts at line ${r.line}\n  Rust:   ${r.rust}\n  cam.ts: ${r.ts}`);
      if (r && r.side) console.warn(`millgcode: warnings, threads or tools differ from cam.ts – ${r.side}`);
    })
    .catch(e => { lastShadow = { no: String(e) }; console.warn("millgcode: comparison failed", e); });
}
