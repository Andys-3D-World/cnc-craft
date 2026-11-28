/**
 * PLASMA-AUFTRAG FÜR RUST (src-tauri/src/plasmagcode.rs)
 *
 * plasmaCam.ts plant jede Form für sich (planShape: Schnittspalt, Richtung, Startpunkt an der schärfsten Ecke, Anfahr-
 * und Ausfahrbahn, Überlauf, Haltestege) und entscheidet, ob sie geschnitten, nur angekörnt oder ausgelassen wird
 * (shapeOp). Das bleibt hier im Fenster – die Startecke sucht eine Winkelfunktion, deren letzte Stelle in Rust anders sein
 * kann. plasmaJob() sammelt diese Pläne je Schnitt-Einstellung, in derselben Reihenfolge und mit denselben Regeln wie
 * generatePlasmaGcode(). Rust rechnet daraus alles Weitere: Reihenfolge (kurze Wege oder Wärme verteilen), Ankörnen,
 * Umwege um ausgeschnittene Teile, Abtasten, Einstechen, Höhenregelung samt Anti-Dive, den G-Code-Text.
 *
 * WICHTIG: wer in generatePlasmaGcode() etwas am Sammeln der Formen ändert, ändert es auch hier – der Vergleich
 * (tests/fixtures/plasmagcode-cases.json.gz, in der App checkPost) merkt es sonst als Abweichung.
 */
import { type Pt } from "./shapeTransform";
import { getCuts, cutForShape, plasmaSettings } from "./plasmaCuts";
import { t, ascii, tMm } from "./i18n/i18n";
import { bedSizeMm } from "./editor/editorState";
import { planShape, shapeOp } from "./plasmaCam";

/** gleiche Zahl wie JOB_VERSION in plasmagcode.rs – ändern, wenn sich der Auftrag ändert */
export const PLASMA_JOB_VERSION = 1;

const TEXTS = ["gc.unitMm", "gc.absolute", "pgc.torchOffStart", "pgc.thcOff", "pgc.thcHal", "pgc.header", "gc.safeZ", "gc.avoid",
  "pgc.probeSkip", "pgc.probe", "pgc.probeSet", "pgc.thcOn", "pgc.spread", "gc.orderOpt", "pgc.spot", "pgc.pierceHeight", "pgc.torchOn",
  "pgc.spotTime", "pgc.torchOff", "pgc.pierce", "pgc.smallHole", "gc.tab", "pgc.pierceDelay", "pgc.cutHeight", "pgc.antiDive",
  "pgc.smallHoles", "pgc.spots", "pgc.probesSaved", "pgc.skipped", "pgc.probeClear", "gc.park", "gc.end"];
const WARN_KEYS = ["fold.plasmaSkipped", "pgw.thcProbe", "pgw.probeSkipThc", "pgw.tooSmall", "pgw.leadShort", "cut.plasmaDir", "cut.startInTab", "pgw.skipped"];

const xy = (p: Pt) => [p.x, p.y];
/** ein Hinweis als Schlüssel und Werte (als Text, wie t() sie einsetzt) */
const warn = (key: string, p: Record<string, string | number> = {}) => ({ key, p: Object.entries(p).map(([k, v]) => [k, String(v)]) });

export function plasmaJob(all: any[]): Record<string, unknown> | { no: string } {
  // Faltlinien aus der Faltschachtel: Plasma schneidet immer durch – also nicht mitnehmen
  const shapes = all.filter(s => !s.foldLine);
  if (!shapes.length) return { no: "no shapes" };
  const S = plasmaSettings;
  const byCut = new Map<string, any[]>();
  for (const s of shapes) {
    const cut = cutForShape(s);
    if (!cut) continue;
    if (!byCut.has(cut.id)) byCut.set(cut.id, []);
    byCut.get(cut.id)!.push(s);
  }
  const order = getCuts().filter(cu => byCut.has(cu.id));
  const cuts = order.map((cut, ci) => {
    const plans: unknown[] = [], spots: unknown[] = [], warns: unknown[] = [];
    let skipped = 0;
    byCut.get(cut.id)!.forEach((s, si) => {
      const what = shapeOp(s);
      if (what.op === "skip") { skipped++; return; }
      if (what.op === "spot") { spots.push(xy(what.at)); return; }
      const sp = planShape(s, cut);
      if (sp.tooSmall) warns.push(warn("pgw.tooSmall", { name: cut.name, n: si + 1, k: cut.kerf }));
      if (sp.leadShort) warns.push(warn("pgw.leadShort", { name: cut.name, n: si + 1 }));
      if (sp.dirByHand) warns.push(warn("cut.plasmaDir", { name: cut.name, n: si + 1 }));
      if (sp.startInTab) warns.push(warn("cut.startInTab"));
      for (const p of sp.plans) plans.push({
        pts: p.pts.map(xy), closed: p.closed, lead: p.lead && xy(p.lead), over: p.over.map(xy), out: p.out && xy(p.out),
        area: p.area, hole: p.hole, size: p.size, runs: p.runs && p.runs.map(r => r.map(xy)),
      });
    });
    return {
      // Überschrift des Schnitts (mit seinem Namen) fertig als Kommentar
      head: `(${ascii(tMm("pgc.cut", { i: ci + 1, name: cut.name, f: cut.speed, k: cut.kerf }))})`,
      speed: cut.speed, pierceHeight: cut.pierceHeight, pierceDelay: cut.pierceDelay, cutHeight: cut.cutHeight,
      plans, spots, warns, skipped,
    };
  });
  const job = {
    version: PLASMA_JOB_VERSION,
    folds: all.length - shapes.length,
    settings: {
      safeZ: S.safeZ, useZ: !!S.useZ, probe: !!S.probe, probeOffset: S.probeOffset, probeDist: S.probeDist, thc: S.thc, thcOut: S.thcOut,
      antiDive: S.antiDive, smallHole: S.smallHole, holeSpeed: S.holeSpeed, avoidCut: !!S.avoidCut, optimizeOrder: !!S.optimizeOrder,
      spotTime: S.spotTime, probeSkip: S.probeSkip, spread: !!S.spread,
    },
    // Arbeitsfläche: Umwege bleiben darauf (ohne Seite, z. B. in Tests, keine Grenze)
    bed: S.avoidCut && typeof document !== "undefined" ? bedSizeMm() : null,
    cuts,
    texts: Object.fromEntries(TEXTS.map(k => [k, ascii(tMm(k))])),
    warnTexts: Object.fromEntries(WARN_KEYS.map(k => [k, t(k)])),
  };
  // nur Zahlen, die JSON unverändert überträgt
  let ok = true;
  JSON.stringify(job, (_k, v) => { if (typeof v === "number" && !Number.isFinite(v)) ok = false; return v; });
  return ok ? job : { no: "a value is not a number" };
}
