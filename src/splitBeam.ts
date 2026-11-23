/**
 * GROSSES TEIL TEILEN – Laser und Plasma: was ist der Umriss des Teils, wie breit ist der Schnittspalt
 * (Geometrie: seamSplit.ts, Betten und Fenster: splitJob.ts). Ohne Oberfläche (Tests: `npm test`).
 *
 * LASER: Eine Ebene ist „Linie“, „Füllen“ oder „Füllen + Linie“ – ob sie durchschneidet, steht nirgends. Deshalb:
 *   - Umriss sind die geschlossenen Formen der SCHNEID-EBENEN. Die wählt man im Fenster an; ohne Auswahl gilt die
 *     kräftigste Ebene mit Linie (Leistung × Durchgänge ÷ Geschwindigkeit), auf der eine geschlossene Form liegt.
 *   - Alles andere ist Gravur: Flächen (Füllen) werden an der Stück-Kante abgeschnitten, Linien ebenso.
 *   - Der Laser fährt genau auf der Linie. Der gemessene Schnittspalt (Laser-Bibliothek → Maschine, Testkarte) wird
 *     an der Fuge ausgeglichen: jede Fugenkante wird um den halben Spalt weiter gezeichnet.
 * PLASMA schneidet immer durch: Umriss sind alle geschlossenen Formen mit „Außen“ oder „Innen“ (alles außer
 *   „auf Linie“ – so behandelt sie auch plasmaCam.ts). Den Schnittspalt gleicht der G-Code selbst aus.
 */
import { shapeToPaths } from "./shapeTransform";
import { layerForShape, getLayers, layerHasFill, layerHasLine, laserSettings, activeLayer, type LaserLayer } from "./laserLayers";
import { cutForShape, getCuts, activeCut, plasmaSettings } from "./plasmaCuts";
import { AVOID_MARGIN as LASER_AVOID } from "./laserCam";
import { AVOID_MARGIN as PLASMA_AVOID } from "./plasmaCam";
import type { BeamInfo, SplitKind, SplitOptions, SplitSetup } from "./seamSplit";

const isClosed = (s: any): boolean => {
  try { const p = shapeToPaths(s)[0]; return !!p && p.closed && p.pts.length >= 3; } catch { return false; }
};

/** Wie kräftig eine Ebene schneidet – nur zum Vergleichen */
const energy = (l: LaserLayer) => (l.power * l.passes) / Math.max(1, l.speed);

export interface CutLayerChoice { id: string; name: string; color: string; on: boolean }

/**
 * Laser: Ebenen, die Umriss sein können (mit Linie, mindestens eine geschlossene Form), in der Reihenfolge der Liste.
 * `on` = zählt als Schneid-Ebene; `auto` = nicht von Hand gewählt, sondern die kräftigste genommen.
 */
export function laserCutLayers(shapes: any[], setup: Pick<SplitSetup, "cutLayers"> | null): { list: CutLayerChoice[]; auto: boolean } {
  const used = new Set<string>();
  for (const s of shapes) {
    if (!s || s.keepOut || s.type === "image" || !isClosed(s)) continue;
    const l = layerForShape(s);
    if (l && layerHasLine(l)) used.add(l.id);
  }
  const cands = getLayers().filter(l => used.has(l.id));
  const chosen = (setup?.cutLayers ?? []).filter(id => used.has(id));
  let on = new Set(chosen);
  const auto = !chosen.length;
  if (auto && cands.length) on = new Set([cands.reduce((a, b) => (energy(b) > energy(a) ? b : a)).id]);
  return { list: cands.map(l => ({ id: l.id, name: l.name, color: l.color, on: on.has(l.id) })), auto };
}

const NO_RADIUS = () => 0;

/** Einstellungen fürs Teilen im Laser-Modus */
export function laserSplitOptions(shapes: any[], setup: Pick<SplitSetup, "cutLayers"> | null, bed: { w: number; h: number }): SplitOptions {
  const on = new Set(laserCutLayers(shapes, setup).list.filter(c => c.on).map(c => c.id));
  const kerf = Math.max(0, laserSettings.kerf || 0);
  // Gravur-Zeilen (Bild, Füllen) rücken um den halben Versatz hin/zurück zur Seite (scanOffset.ts)
  const scan = Math.max(0, ...laserSettings.scanOffsets.map(p => Math.abs(p.mm))) / 2;
  const beam = (s: any): BeamInfo | null => {
    // Bild: jede Zeile fährt um den Überlauf über den Bildrand hinaus (Laser aus) – auch das muss aufs Bett passen
    if (s.type === "image") return { cut: false, fill: false, line: false, kerf, margin: Math.max(0, Number(s.img?.overscan) || 0) + scan };
    const l = layerForShape(s);
    if (!l) return null;
    const line = layerHasLine(l);
    // Anfahrbahn (Freischnitt) geschlossener Konturen liegt bis zu leadIn mm neben der Kontur; mit „Leerfahrten um
    // ausgeschnittene Teile“ führt der Umweg so weit um den Rahmen des Teils herum (rapidAvoid.ts)
    return { cut: line && on.has(l.id), fill: layerHasFill(l), line, kerf, margin: Math.max(line ? Math.max(0, l.leadIn || 0, laserSettings.avoidCut ? LASER_AVOID : 0) : 0, layerHasFill(l) ? scan : 0) };
  };
  return { bed, radiusOf: NO_RADIUS, kind: "laser", beam };
}

/** Einstellungen fürs Teilen im Plasma-Modus */
export function plasmaSplitOptions(bed: { w: number; h: number }): SplitOptions {
  const beam = (s: any): BeamInfo | null => {
    const c = cutForShape(s);
    if (!c) return null;
    const onLine = (s.millingMode || "outside") === "on-line";
    // der Brenner fährt den halben Spalt neben der Kontur, der Einstich liegt noch die Anfahrlänge weiter draußen –
    // und mit „Leerfahrten um ausgeschnittene Teile“ führt der Umweg so weit um den Rahmen der Bahn herum (rapidAvoid.ts)
    return { cut: !onLine, fill: false, line: true, kerf: Math.max(0, c.kerf), margin: onLine ? 0 : Math.max(0, c.kerf) / 2 + Math.max(0, c.leadIn, plasmaSettings.avoidCut ? PLASMA_AVOID : 0) };
  };
  return { bed, radiusOf: NO_RADIUS, kind: "plasma", beam };
}

/**
 * Was außer Zeichnung und Fugen noch bestimmt, wie die Stücke aussehen – gehört zum Fingerabdruck: ändert sich der
 * Schnittspalt, eine Ebene oder die Anfahrlänge, passen die erzeugten Stücke nicht mehr zum Original.
 */
export function beamFingerprint(kind: Exclude<SplitKind, "mill">, shapes: any[], setup: Pick<SplitSetup, "cutLayers"> | null): string {
  if (kind === "laser") {
    const cut = laserCutLayers(shapes, setup).list.filter(c => c.on).map(c => c.id).join(",");
    return `laser|${laserSettings.kerf}|${laserSettings.avoidCut ? 1 : 0}|${getLayers().map(l => `${l.id}:${l.mode}:${l.leadIn}`).join(",")}|${activeLayer?.id ?? ""}|${cut}`;
  }
  return `plasma|${plasmaSettings.avoidCut ? 1 : 0}|${getCuts().map(c => `${c.id}:${c.kerf}:${c.leadIn}`).join(",")}|${activeCut?.id ?? ""}`;
}
