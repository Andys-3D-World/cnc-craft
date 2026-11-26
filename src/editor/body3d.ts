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
 *   outside  Außenkontur, volle Höhe (Teil ausschneiden)
 *   inside   Durchbruch, volle Höhe
 *   pocket   Tasche bis zur Tiefe; Inseln (stehen bleibende Stellen in der Tasche) kommen als outside mit derselben Tiefe –
 *            so erkennt die Fräsbahn sie als Insel und fährt ihre Wand sauber ab
 */
export interface MillOp { mode: "outside" | "inside" | "pocket"; depth: number; ring: [number, number][] }
/** Hinweise: inner = Ausschnitt erreicht die Oberkante nicht (von oben nicht fräsbar), raised = Aufbauen über der Grundplatte */
export interface MillPlan { ops: MillOp[]; height: number; bottom: number; inner: number; raised: number }

const openRing = (r: [number, number][]) => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r.slice());

/** Fräs-Formen aus den Schritten des Körpers. eps: Höhen-Toleranz in mm */
export function millPlan(feats: EvalFeat[], eps = 1e-6): MillPlan {
  const s = slabs(feats);
  if (!s.length) return { ops: [], height: 0, bottom: 0, inner: 0, raised: 0 };
  const bottom = s[0].z0, top = s[s.length - 1].z1, height = top - bottom;
  // Grundfläche: alles, was irgendwo Körper ist; ihre Löcher gehen ganz durch
  let foot: MultiPolygon = s[0].region;
  for (const x of s.slice(1)) foot = polygonClipping.union(foot, x.region);
  const ops: MillOp[] = [];
  for (const poly of foot) poly.forEach((ring, i) => ops.push({ mode: i === 0 ? "outside" : "inside", depth: height, ring: openRing(ring as [number, number][]) }));

  let inner = 0, raised = 0;
  // Grundplatte = erster Aufbau-Schritt, der ganz unten beginnt; spätere Aufbauten über ihr sind Erhebungen
  const firstJoin = feats.findIndex(f => f.op === "join" && f.region.length && f.z1 - f.z0 > eps);
  feats.forEach((f, i) => {
    if (!f.region.length || f.z1 - f.z0 <= eps) return;
    if (f.op === "join") { if (i !== firstJoin && f.z1 > bottom + eps && f.z0 > bottom + eps) raised++; return; }
    if (f.z1 < top - eps) { if (f.z0 < top - eps) inner++; return; }   // erreicht die Oberkante nicht
    if (f.z0 <= bottom + eps) return;                                  // geht ganz durch: steckt schon in den Löchern der Grundfläche
    const area = polygonClipping.intersection(f.region, foot);         // nur, wo Körper ist
    const depth = top - f.z0;
    for (const poly of area) poly.forEach((ring, k) => ops.push({ mode: k === 0 ? "pocket" : "outside", depth, ring: openRing(ring as [number, number][]) }));
  });
  return { ops: ops.filter(o => o.ring.length >= 3), height, bottom, inner, raised };
}
