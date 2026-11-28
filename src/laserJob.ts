/**
 * LASER-AUFTRAG FÜR RUST (src-tauri/src/lasergcode.rs) – Linien und Füllen
 *
 * laserCam.ts liest beim Erzeugen aus Ebenen, Einstellungen, Sprachdatei und den Formen. laserJob() sammelt das für
 * eine Liste von Formen in EIN Objekt, das sich als JSON verschicken lässt – in derselben Reihenfolge und mit denselben
 * Regeln wie generateLaserGcode() (Ebenen ordnen, Bahnen der Formen, Startpunkt/Richtung von Hand, Freischnitt,
 * Haltestege: das hängt an den Formen und bleibt hier). Rust rechnet daraus alles Weitere: Füll-Linien, Ringe,
 * Reihenfolge, Umwege um ausgeschnittene Teile, Ecken-Leistung, Überlauf, Z je Durchgang und den G-Code-Text.
 * Was Rust noch nicht kann (Bildgravur), gibt { no: Grund }.
 *
 * WICHTIG: wer in laserCam.ts etwas an der Reihenfolge der Ebenen oder an den Bahnen ändert, ändert es auch hier –
 * der Vergleich (tests/fixtures/lasergcode-cases.json.gz, in der App checkPost) merkt es sonst als Abweichung.
 */
import { MM_TO_PIXEL, shapeToPaths, type Pt } from "./shapeTransform";
import { polygonArea } from "./polyOffset";
import { tabRuns } from "./tabs";
import { bedSizeMm } from "./editor/editorState";
import { applyCutClosed, applyCutOpen, cutDirOf, cutStartOf } from "./cutSetting";
import { getLayers, effectiveLayer, laserSettings, layerHasFill, layerHasLine, type LaserLayer } from "./laserLayers";
import { foldLayersFirst } from "./foldBox";
import { t, ascii, tMm } from "./i18n/i18n";
import { scanOffsetAt } from "./scanOffset";
import { orderByStage } from "./testCard";
import { withLeadIn } from "./laserCam";

/** gleiche Zahl wie JOB_VERSION in lasergcode.rs – ändern, wenn sich der Auftrag ändert */
export const LASER_JOB_VERSION = 1;

const TEXTS = ["gc.unitMm", "gc.absolute", "lgc.header", "lgc.m4", "lgc.m3", "lgc.zUp", "lgc.airOn", "lgc.pass", "lgc.fill", "gc.orderOpt",
  "lgc.zDown", "lgc.leadIn", "gc.tab", "lgc.zBack", "lgc.airOff", "lgc.laserOff", "gc.park", "gc.end", "gc.avoid"];
const WARN_KEYS = ["lgw.openNoFill", "lgw.ringRest", "lgw.tooManyLines", "lgw.zStep", "cut.startInTab", "tcard.w.zJob"];

const xy = (p: Pt) => [p.x, p.y];
const fin = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function laserJob(shapes: any[]): Record<string, unknown> | { no: string } {
  if (!shapes.length) return { no: "no shapes" };
  // ---- Formen nach Ebene, Reihenfolge der Ebenen (wie generateLaserGcode) ----
  const byLayer = new Map<string, any[]>();
  const layerById = new Map<string, LaserLayer>();
  for (const s of shapes) {
    const l = effectiveLayer(s);
    if (!l) continue;
    if (!byLayer.has(l.id)) { byLayer.set(l.id, []); layerById.set(l.id, l); }
    byLayer.get(l.id)!.push(s);
  }
  const rank = new Map(getLayers().map((l, i) => [l.id, i]));
  const sorted = [...layerById.values()].sort((a, b) => (rank.get(a.id.split("~")[0]) ?? 0) - (rank.get(b.id.split("~")[0]) ?? 0));
  const foldIds = new Set(shapes.filter(s => s.foldLine).map(s => effectiveLayer(s)?.id));
  const order = orderByStage(foldLayersFirst(sorted, l => foldIds.has(l.id)));

  const layers: unknown[] = [];
  for (let li = 0; li < order.length; li++) {
    const layer = order[li], list = byLayer.get(layer.id)!;
    if (list.some(s => s.type === "image")) return { no: "image engraving" };
    const both = layer.mode === "fill+line";
    const fillF = both ? layer.fillSpeed : layer.speed;
    // ---- Bahnen in mm, Startpunkt/Richtung von Hand ----
    const closed: Pt[][] = [], open: Pt[][] = [];
    const closedShape = new Map<Pt[], any>();
    const fixedOpen = new Set<Pt[]>();
    for (const s of list) {
      for (const p of shapeToPaths(s)) {
        if (p.pts.length < 2) continue;
        const raw = p.pts.map(q => ({ x: q.x / MM_TO_PIXEL, y: q.y / MM_TO_PIXEL }));
        const pts = p.closed ? applyCutClosed(raw, s) : applyCutOpen(raw, s);
        (p.closed ? closed : open).push(pts);
        if (p.closed) closedShape.set(pts, s);
        else if (cutDirOf(s)) fixedOpen.add(pts);
      }
    }
    // ---- Linie: Freischnitt und Haltestege je Kontur, kleine (innere) Konturen zuerst, offene Linien am Anfang ----
    let startInTab = 0;
    const paths = !layerHasLine(layer) ? [] : [
      ...open.map(pts => ({ pts: pts.map(xy), closed: false, lead: null, runs: null, reversible: !fixedOpen.has(pts), freeStart: false, area: 0 })),
      ...closed.map(pts => {
        const shape = closedShape.get(pts);
        const lp = withLeadIn(pts, closed, layer.leadIn, cutStartOf(shape) !== null);
        const tr = shape ? tabRuns(shape, lp.pts, q => ({ x: q.x / MM_TO_PIXEL, y: q.y / MM_TO_PIXEL }), Number(shape.tabLen) || 0) : null;
        if (tr?.rotated && cutStartOf(shape) !== null) startInTab++;
        const lead = tr?.rotated ? null : lp.lead;
        return { pts: lp.pts.map(xy), closed: true, lead: lead ? xy(lead) : null, runs: tr ? tr.runs.map(r => r.map(xy)) : null,
          reversible: false, freeStart: cutStartOf(shape) === null, area: Math.abs(polygonArea(pts)) };
      }).sort((a, b) => a.area - b.area)
    ];
    const rad = (deg: number) => (deg * Math.PI) / 180;
    layers.push({
      // Überschrift der Ebene (mit ihrem Namen) fertig als Kommentar; alle anderen Kommentare setzt Rust aus `texts`
      head: `(${ascii(tMm("lgc.layer", { i: li + 1, name: layer.name, mode: t("laser.mode." + layer.mode), p: layer.power, f: layer.speed, x: layer.passes }))})`,
      name: String(layer.name), hasFill: layerHasFill(layer), hasLine: layerHasLine(layer), both,
      power: layer.power, speed: layer.speed, fillPower: layer.fillPower, fillSpeed: layer.fillSpeed, passes: layer.passes,
      // Versatz hin/zurück (scanOffset.ts): fester Wert der Testkarte, sonst aus der Tabelle der Einstellungen
      scanMm: layer.scanMm ?? scanOffsetAt(laserSettings.scanOffsets, fillF),
      zOff: fin(layer.zOff), air: !!layer.air, interval: layer.interval, fillKind: String(layer.fillKind ?? ""),
      // Winkel der Füll-Linien: Kosinus/Sinus wie in hatch() gerechnet (Rusts letzte Stelle kann abweichen); +90° für „über Kreuz“
      ca: Math.cos(rad(layer.angle)), sa: Math.sin(rad(layer.angle)), ca90: Math.cos(rad(layer.angle + 90)), sa90: Math.sin(rad(layer.angle + 90)),
      overcut: fin(layer.overcut), zStep: fin(Number(layer.zStep)), thickness: fin(layer.thickness),
      closed: closed.map(l => l.map(xy)), open: open.length,
      paths: paths.map(({ area: _area, ...p }) => p), startInTab,
    });
  }
  const job = {
    version: LASER_JOB_VERSION,
    sMax: laserSettings.sMax, dynamic: !!laserSettings.dynamic, avoidCut: !!laserSettings.avoidCut, optimizeOrder: !!laserSettings.optimizeOrder,
    // Ecken-Leistung nur ohne M4 (mit M4 regelt das Board selbst)
    corner: laserSettings.cornerPower && !laserSettings.dynamic ? { accel: laserSettings.cornerAccel, deviation: 0.02, minPct: laserSettings.cornerMin } : null,
    // Arbeitsfläche: Umwege bleiben darauf (ohne Seite, z. B. in Tests, keine Grenze)
    bed: typeof document !== "undefined" ? bedSizeMm() : null,
    // Fokus-Leiter der Testkarte: der Job fährt Z von selbst
    zJob: shapes.some(s => Number(s.laserOverride?.zOff) > 0),
    layers,
    texts: Object.fromEntries(TEXTS.map(k => [k, ascii(tMm(k))])),
    warnTexts: Object.fromEntries(WARN_KEYS.map(k => [k, t(k)])),
  };
  // nur Zahlen, die JSON unverändert überträgt
  let ok = true;
  JSON.stringify(job, (_k, v) => { if (typeof v === "number" && !Number.isFinite(v)) ok = false; return v; });
  return ok ? job : { no: "a value is not a number" };
}
