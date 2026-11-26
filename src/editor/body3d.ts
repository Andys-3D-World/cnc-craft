/**
 * 3D-KÖRPER AUS DER SKIZZE (Extrudieren) – nur Rechnung (mit `npm test` prüfbar). Fenster: ui/bodyDialog.ts
 *
 * Ein Körper entsteht aus Schritten wie in einem CAD-Programm, der Reihe nach (Zeitleiste):
 *   join   Fläche der Profil-Formen von z0 bis z0 + h hochziehen und dazunehmen (h < 0 = nach unten)
 *   cut    dasselbe wegnehmen (Tasche, Loch, Absatz)
 * Die Profil-Formen bleiben in der Zeichnung und sind verbunden: ändert man die Skizze (oder ein Maß über die
 * Bedingungen), ändert sich der Körper beim nächsten Rechnen mit. Formen in Formen sind Löcher (wie beim Fräsen).
 *
 * Gerechnet wird „2,5D“: alles entlang Z, so wie eine Fräse arbeitet. Der Körper wird in Scheiben zerlegt
 * (zwischen allen vorkommenden Höhen); je Scheibe ergibt sich eine Fläche aus den Schritten, die sie überdecken,
 * in ihrer Reihenfolge. Gleiche Nachbarscheiben werden zusammengefasst. Maße in mm, z nach oben.
 */
import polygonClipping, { type MultiPolygon } from "polygon-clipping";
import { extrudeRegion, type Shell } from "../view3d/solid.ts";

export type FeatOp = "join" | "cut";
/** Gespeichert an der ersten Profil-Form (s.feat3d), seq = Reihenfolge in der Zeitleiste */
export interface Feature { id: string; seq: number; op: FeatOp; z0: number; h: number; profile: string[]; off?: boolean }
export interface EvalFeat { op: FeatOp; z0: number; z1: number; region: MultiPolygon }
export interface Slab { z0: number; z1: number; region: MultiPolygon }

/** Von–bis in mm (unten zuerst) */
export function zRange(f: { z0: number; h: number }): [number, number] {
  return f.h >= 0 ? [f.z0, f.z0 + f.h] : [f.z0 + f.h, f.z0];
}

const area = (mp: MultiPolygon) => {
  let a = 0;
  for (const poly of mp) poly.forEach((r, i) => {
    let s = 0;
    for (let k = 0, j = r.length - 1; k < r.length; j = k++) s += r[j][0] * r[k][1] - r[k][0] * r[j][1];
    a += (i === 0 ? 1 : -1) * Math.abs(s / 2);
  });
  return a;
};
export const regionArea = area;

/** Gleiche Fläche? (Unterschied kleiner als tol mm²) */
function sameRegion(a: MultiPolygon, b: MultiPolygon, tol = 1e-6): boolean {
  if (!a.length && !b.length) return true;
  if (!a.length || !b.length) return false;
  return area(polygonClipping.xor(a, b)) < tol;
}

/** Scheiben des Körpers (von unten nach oben), leere weggelassen */
export function slabs(feats: EvalFeat[]): Slab[] {
  const use = feats.filter(f => f.z1 - f.z0 > 1e-6 && f.region.length);
  const levels = [...new Set(use.flatMap(f => [f.z0, f.z1]))].sort((a, b) => a - b);
  const out: Slab[] = [];
  for (let i = 0; i + 1 < levels.length; i++) {
    const a = levels[i], b = levels[i + 1], mid = (a + b) / 2;
    let region: MultiPolygon = [];
    for (const f of use) {
      if (f.z0 > mid || f.z1 < mid) continue;
      region = f.op === "join" ? (region.length ? polygonClipping.union(region, f.region) : f.region) : region.length ? polygonClipping.difference(region, f.region) : region;
    }
    if (!region.length || area(region) < 1e-9) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.z1 - a) < 1e-9 && sameRegion(last.region, region)) last.z1 = b;
    else out.push({ z0: a, z1: b, region });
  }
  return out;
}

/** Dreiecke des Körpers (für Anzeige und STL) */
export function bodyShells(feats: EvalFeat[]): Shell[] {
  const tris: number[] = [];
  for (const s of slabs(feats)) extrudeRegion(s.region, s.z0, s.z1, tris);
  return tris.length ? [{ kind: "body", tris }] : [];
}

/** Rauminhalt in mm³ (für Anzeige und Tests) */
export function volume(feats: EvalFeat[]): number {
  return slabs(feats).reduce((v, s) => v + area(s.region) * (s.z1 - s.z0), 0);
}

/** Oberste Höhe des Körpers (für den Vorschlag „Ausschneiden ab Oberkante“), 0 ohne Körper */
export function topOf(feats: EvalFeat[]): number {
  const s = slabs(feats);
  return s.length ? s[s.length - 1].z1 : 0;
}

// ---------------------------------------------------------------------
// Fräsen aus dem Körper (von oben, Oberkante des Körpers = Z 0 = Material-Oberseite)
// ---------------------------------------------------------------------

/**
 * Eine Fräs-Form: Ring in mm (geschlossen, ohne Wiederholung des ersten Punkts), Art und Tiefe ab Oberkante (positiv)
 *   outside  Außenkontur, volle Höhe (Teil ausschneiden) – oder Insel einer Tasche (islandOf), dann deren Tiefe
 *   inside   Durchbruch, volle Höhe
 *   pocket   Tasche bis zur Tiefe (key: Kennung, auf die sich ihre Inseln beziehen)
 * Inseln gelten nur für ihre eigene Tasche (cam.ts: islandFor). So bleibt bei Stufen nichts falsch stehen: eine Insel der
 * tiefen Tasche ist für die flachere Tasche darüber keine.
 */
export interface MillOp { mode: "outside" | "inside" | "pocket"; depth: number; ring: [number, number][]; key?: string; islandOf?: string }
/** Hinweise: inner = Ausschnitt erreicht die Oberkante nicht (von oben nicht fräsbar, wird aufgefüllt), raised = Erhebungen */
export interface MillPlan { ops: MillOp[]; height: number; bottom: number; inner: number; raised: number }

const openRing = (r: [number, number][]) => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r.slice());

/**
 * Fräs-Formen aus den Schritten des Körpers (von oben, Oberkante = Z 0). eps: Höhen-Toleranz in mm.
 * Für jede Höhe a, an der eine Scheibe beginnt: Tasche über alles, was ab a nach oben leer ist, bis Tiefe (Oberkante − a).
 * Was darin stehen bleibt, sind Inseln dieser Tasche. Hohlräume unter Material (von oben nicht erreichbar) gelten als voll.
 */
export function millPlan(feats: EvalFeat[], eps = 1e-6): MillPlan {
  const s = slabs(feats);
  if (!s.length) return { ops: [], height: 0, bottom: 0, inner: 0, raised: 0 };
  const bottom = s[0].z0, top = s[s.length - 1].z1, height = top - bottom;
  let foot: MultiPolygon = s[0].region;
  for (const x of s.slice(1)) foot = polygonClipping.union(foot, x.region);
  const ops: MillOp[] = [];
  for (const poly of foot) poly.forEach((ring, i) => ops.push({ mode: i === 0 ? "outside" : "inside", depth: height, ring: openRing(ring as [number, number][]) }));

  let n = 0;
  for (let i = 1; i < s.length; i++) {
    const a = s[i].z0;
    if (a <= bottom + eps) continue;
    // alles, was ab dieser Höhe nach oben Körper ist (Spalten von oben gesehen)
    let above: MultiPolygon = s[i].region;
    for (const x of s.slice(i + 1)) above = polygonClipping.union(above, x.region);
    const free = polygonClipping.difference(foot, above);
    if (regionArea(free) < 1e-6) continue;
    const depth = top - a;
    for (const poly of free) {
      const key = "p" + (n++);
      ops.push({ mode: "pocket", depth, ring: openRing(poly[0] as [number, number][]), key });
      for (const hole of poly.slice(1)) {
        // Loch der Tasche: steht dort Körper, ist es eine Insel; sonst ist es ein Durchbruch (schon als „inside“ da)
        const hp: MultiPolygon = [[hole]];
        if (regionArea(polygonClipping.intersection(hp, above)) < 1e-6) continue;
        ops.push({ mode: "outside", depth, ring: openRing(hole as [number, number][]), islandOf: key });
      }
    }
  }

  // Hinweise: inner = Stellen, an denen Körper über leerem Raum hängt (von oben nicht fräsbar, wird als voll gefräst)
  let inner = 0, raised = 0;
  for (let i = 0; i + 1 < s.length; i++) if (regionArea(polygonClipping.difference(s[i + 1].region, s[i].region)) > 1e-6) inner++;
  const firstJoin = feats.findIndex(f => f.op === "join" && f.region.length && f.z1 - f.z0 > eps);
  feats.forEach((f, i) => { if (f.op === "join" && i !== firstJoin && f.region.length && f.z1 - f.z0 > eps && f.z0 > bottom + eps) raised++; });
  return { ops: ops.filter(o => o.ring.length >= 3), height, bottom, inner, raised };
}
