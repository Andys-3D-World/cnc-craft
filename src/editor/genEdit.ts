/**
 * GENERATOREN STARTEN UND BEARBEITEN (gemeinsam für alle Generatoren)
 *
 * openGenerator: Fenster öffnen; was bei OK neu auf dem Bett liegt, wird als Lauf gekennzeichnet.
 * editRun:       dasselbe Fenster mit den Werten des Laufs; bei OK ersetzen die neuen Teile die alten (ein Rückgängig-Schritt).
 * Abbrechen ändert nichts: Solange das Fenster offen ist, bleibt alles, wie es ist – erst done() ersetzt.
 * Die Logik selbst steht in genRun.ts.
 */
import { app, bedSizeMm } from "./editorState";
import { cleanPoints, minWebFor, outsideBed, thinnestWeb } from "../genCheck";
import { MM_TO_PIXEL, shapeToPaths } from "../shapeTransform";
import { getMachineMode } from "../machineMode";
import { bedCount, activeBed, bedShapes } from "./beds";
import { t } from "../i18n/i18n";
import { polishGenDialog } from "../ui/genDialog";
import { carrySettings, checkRun, imageOfShape, readGen, replaceRun, roleOf, tagRun, takeSettings, withSettings, type EditImage, type GenInfo, type RunCheck } from "./genRun";
import { openBoxDialog } from "./boxGen";
import { openMandalaDialog } from "./mandalaGen";
import { openBirdhouseDialog } from "./birdhouseGen";
import { openOrnamentDialog } from "./ornamentGen";
import { openGearDialog } from "./gearGen";
import { openHingeDialog } from "./hingeGen";
import { openScaleDialog } from "./scaleGen";
import { openJointDialog } from "./jointGen";
import { openShelfDialog } from "./shelfGen";
import { openDividerDialog } from "./dividerGen";
import { openFoldBoxDialog } from "./foldBoxGen";
import { openShapeBoxDialog } from "./shapeBoxGen";
import { openFamilyDialog } from "./familyGen";
import { openCandyHolderDialog } from "./candyHolderGen";
import { openVentDialog } from "./ventGen";
import { openBirthLetterDialog } from "./birthLetterGen";
import { openLetterTopperDialog } from "./letterTopperGen";
import { openPuzzleDialog } from "./puzzleGen";
import { openWordTilesDialog } from "./wordTilesGen";
import { openShadowBoxDialog } from "./shadowBoxGen";
import { openSlotOrnamentDialog } from "./slotOrnamentGen";
import { openNameGenerator } from "./nameGen";
import { openMaterialTestDialog } from "./materialTest";
import { openTestCardDialog } from "./testCardGen";

type Log = (s: string) => void;
type Open = (log: Log, done: () => void) => void;

/** Die Kennungen stehen in Projektdateien – nicht umbenennen */
const GENERATORS: Record<string, Open> = {
  box: openBoxDialog, mandala: openMandalaDialog, birdhouse: openBirdhouseDialog, ornament: openOrnamentDialog,
  gear: openGearDialog, hinge: openHingeDialog, scale: openScaleDialog, joint: openJointDialog, shelf: openShelfDialog,
  divider: openDividerDialog, vent: openVentDialog, birth: openBirthLetterDialog, letterTopper: openLetterTopperDialog,
  puzzle: openPuzzleDialog, wordTiles: openWordTilesDialog, shadowBox: openShadowBoxDialog, slotOrnament: openSlotOrnamentDialog,
  name: openNameGenerator, materialTest: openMaterialTestDialog, foldBox: openFoldBoxDialog, candyHolder: openCandyHolderDialog,
  testCard: openTestCardDialog, shapeBox: openShapeBoxDialog, family: openFamilyDialog
};

/** Ergebnis aufräumen und prüfen: Punkte fast aufeinander weg, Warnung bei zu dünnen Stegen und über dem Bett */
function checkMade(made: any[], log: Log) {
  for (const q of made) {
    if (q.type !== "polyline" || !Array.isArray(q.points)) continue;
    // Listen, die zu den Punkten gehören (z. B. Griffe von Kurven), müssen zusammenpassen: dann nicht anfassen
    if (Object.values(q).some(v => v !== q.points && Array.isArray(v) && v.length === q.points.length)) continue;
    q.points = cleanPoints(q.points, !!q.closed, 0.01 * MM_TO_PIXEL);
  }
  const paths = made.filter(q => q.type !== "image").flatMap(q => shapeToPaths(q).map(p => ({ s: q, closed: p.closed, pts: p.pts.map(c => ({ x: c.x / MM_TO_PIXEL, y: c.y / MM_TO_PIXEL })) })));
  const bed = bedSizeMm(), over = outsideBed(paths, bed.w, bed.h);
  if (over) log(t("gen.warnBed", { w: over.w.toFixed(0), h: over.h.toFixed(0), bw: bed.w, bh: bed.h }));
  const cuts = paths.filter(p => p.closed && (p.s.millingMode === "outside" || p.s.millingMode === "inside"));
  const limit = minWebFor(getMachineMode());
  const web = cuts.length <= 2000 ? thinnestWeb(cuts, limit) : null;
  if (web !== null && web < limit) log(t("gen.warnWeb", { d: web.toFixed(1), min: limit }));
}

const knownType = (type: string) => Object.prototype.hasOwnProperty.call(GENERATORS, type);
const idsOf = (list: any[]) => new Set<string>(list.map(s => s.id));
const newShapes = (before: Set<string>) => app().shapes.filter((s: any) => !before.has(s.id));

export function openGenerator(type: string, log: Log, finish: () => void) {
  const before = idsOf(app().shapes);
  takeSettings();
  GENERATORS[type](log, () => {
    const settings = takeSettings();
    const made = newShapes(before);
    checkMade(made, log);
    if (settings) tagRun(made, type, settings);
    finish();
  });
  polishGenDialog();
}

/** Der eine Lauf in dieser Auswahl – null: keiner, mehrere oder unbekannter Generator (z. B. aus einer neueren Version) */
export function runInSelection(sel: any[]): GenInfo | null {
  const gens = sel.map(readGen).filter((g): g is GenInfo => !!g && knownType(g.type));
  return gens.length && gens.every(g => g.id === gens[0].id) ? gens[0] : null;
}

/** Text der Warnung; leer = nichts von Hand geändert */
function warning(c: RunCheck, elsewhere: number): string {
  const lines: string[] = [];
  const gone = c.missing - elsewhere;
  if (gone > 0) lines.push(t("gen.warn.missing", { n: gone }));
  if (elsewhere > 0) lines.push(t("gen.warn.otherBed", { n: elsewhere }));
  if (c.extra) lines.push(t("gen.warn.extra", { n: c.extra }));
  if (c.edited) lines.push(t("gen.warn.edited", { n: c.edited }));
  if (c.moved) lines.push(t("gen.warn.moved"));
  if (c.ungrouped) lines.push(t("gen.warn.ungrouped", { n: c.ungrouped }));
  return lines.length ? [t("gen.warn.head"), ...lines.map(l => "• " + l), t("gen.warn.foot")].join("\n") : "";
}

export function editRun(gen: GenInfo, log: Log, finish: () => void) {
  const st = app();
  const partsNow = () => st.shapes.filter((s: any) => s.gen?.id === gen.id);
  const parts = partsNow();
  if (!parts.length || !knownType(gen.type)) return;
  const check = checkRun(parts);
  let elsewhere = 0;
  for (let i = 0; i < bedCount(); i++) if (i !== activeBed()) elsewhere += bedShapes(i).filter((s: any) => s.gen?.id === gen.id).length;
  const warn = warning(check, Math.min(elsewhere, check.missing));
  if (warn && !window.confirm(warn)) return;

  const before = idsOf(st.shapes);
  const pics = parts.filter((s: any) => s.type === "image").map(imageOfShape).filter((p: EditImage | null): p is EditImage => !!p);
  // Fenster sollen nicht die alten Teile als „Auswahl“ verwenden (Puzzle über der Auswahl)
  const keep = st.selectedShapeIds;
  st.selectedShapeIds = [];
  takeSettings();
  withSettings(gen.s, pics, () => GENERATORS[gen.type](log, () => {
    const settings = takeSettings();
    const made = newShapes(before);
    checkMade(made, log);
    const old = partsNow();
    if (made.length && old.length) {
      const roles = made.map(roleOf);
      carrySettings(old, made);
      st.shapes = replaceRun(st.shapes, idsOf(old), made, check.angle);
      if (settings) tagRun(made, gen.type, settings, roles);
      st.selectedShapeIds = made.map((s: any) => s.id);
      log(t("gen.replaced", { old: old.length, n: made.length }));
    }
    finish();
  }));
  st.selectedShapeIds = keep;
  polishGenDialog("edit");
  // im Fenster anzeigen, dass bearbeitet wird (als Text, nur eigene Übersetzung)
  const title = [...document.querySelectorAll<HTMLElement>(".dlg-overlay h3")].pop();
  if (title) { const m = document.createElement("span"); m.textContent = " – " + t("gen.editing"); m.style.opacity = "0.7"; title.appendChild(m); }
}
