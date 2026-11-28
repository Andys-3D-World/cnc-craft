/**
 * PLANUNG JE FORM IN RUST NACHRECHNEN (cutplan.rs)
 *
 * Laser und Plasma planen jede Form im Fenster: Richtung, Startpunkt (von Hand oder schärfste Ecke), Anfahrbahn,
 * Haltestege, Überlauf, Ausfahrbahn. Beim Erzeugen des G-Codes merkt sich das Fenster hier, womit es geplant hat und
 * was herauskam, und lässt Rust danach im Hintergrund dasselbe rechnen (importRust.ts vergleicht, Abweichungen nur in
 * der Konsole). Verwendet wird weiter, was das Fenster geplant hat. Vorschau im Browser und Tests: nichts wird gemerkt.
 */
import { MM_TO_PIXEL, shapeToPaths, type Pt } from "./shapeTransform";
import { cutDirOf, cutStartOf } from "./cutSetting";
import { outline } from "./tabs";
import { checkImport, importInApp } from "./importers/importRust";

/** Was an der Form für die Planung zählt (gesetzte Richtung/Start, Haltestege) – für cutplan.rs */
export function shapeCutData(shape: any) {
  const start = cutStartOf(shape);
  const first = start !== null ? shapeToPaths(shape)[0] : undefined;
  const manual = shape?.tabMode === "manual";
  return {
    dir: cutDirOf(shape), start,
    path: first ? { pts: first.pts.map(p => ({ x: p.x, y: p.y })), closed: !!first.closed } : null,
    px: MM_TO_PIXEL,
    tab: {
      len: Number(shape?.tabLen) || 0, mode: String(shape?.tabMode ?? ""), n: Number(shape?.tabN) || 0,
      list: Array.isArray(shape?.tabPts), pts: manual && Array.isArray(shape.tabPts) ? shape.tabPts.map((f: unknown) => Number(f)) : [],
      outline: manual ? (outline(shape)?.map(p => ({ x: p.x, y: p.y })) ?? null) : null,
    },
  };
}

export interface PlanRecord { plasma: { input: unknown; plan: unknown }[]; laser: { input: unknown; out: unknown }[] }
let rec: PlanRecord | null = null;
let sink: ((r: PlanRecord) => void) | null = null;
/** Für Tests (tests/cutPlanRust.test.ts): das Gemerkte bekommen statt es an Rust zu schicken – auch ohne App */
export function setPlanSink(f: ((r: PlanRecord) => void) | null) { sink = f; }

/** Merken ein (nur in der App); finishPlanRecord() schickt alles an Rust */
export function startPlanRecord() { rec = importInApp() || sink ? { plasma: [], laser: [] } : null; }
export const planRecording = () => rec !== null;
export function notePlasmaPlan(input: unknown, plan: unknown) { rec?.plasma.push({ input, plan: structuredClone(plan) }); }
export function noteLaserLayer(input: unknown, out: unknown) { rec?.laser.push({ input, out: structuredClone(out) }); }
export function finishPlanRecord() {
  const r = rec;
  rec = null;
  if (!r || (!r.plasma.length && !r.laser.length)) return;
  if (sink) { sink(r); return; }
  checkImport("plan_check", { job: { plasma: r.plasma.map(x => x.input), laser: r.laser.map(x => x.input) } },
    { plasma: r.plasma.map(x => x.plan), laser: r.laser.map(x => x.out) });
}

/** Punkte als einfache Objekte (ohne weitere Felder) */
export const plain = (pts: Pt[]) => pts.map(p => ({ x: p.x, y: p.y }));
