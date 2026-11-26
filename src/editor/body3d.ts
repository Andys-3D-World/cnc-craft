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
