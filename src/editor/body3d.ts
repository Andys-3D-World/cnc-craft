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
import { offsetPolygon } from "../polyOffset.ts";

export type FeatOp = "join" | "cut";
/** Kante oben am Schritt: Fase (45°) oder Rundung, Größe in mm (Aufbauen: obere Außenkante, Ausschneiden: Rand der Öffnung) */
export interface Edge { kind: "chamfer" | "round"; size: number }
/** Gespeichert an der ersten Profil-Form (s.feat3d), seq = Reihenfolge in der Zeitleiste */
export interface Feature { id: string; seq: number; op: FeatOp; z0: number; h: number; profile: string[]; off?: boolean; edge?: Edge }
export interface EvalFeat { op: FeatOp; z0: number; z1: number; region: MultiPolygon; edge?: Edge }
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

/** Fläche um d verschieben (d > 0 = größer, d < 0 = kleiner); Löcher gehen entgegengesetzt mit */
export function offsetRegion(mp: MultiPolygon, d: number, tol = 0.01): MultiPolygon {
  if (Math.abs(d) < 1e-9) return mp;
  const ring = (r: number[][]) => { const q = r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r; return q.map(([x, y]) => ({ x, y })); };
  const toMp = (loops: { x: number; y: number }[][]): MultiPolygon => loops.filter(l => l.length >= 3).map(l => [[...l.map(p => [p.x, p.y] as [number, number]), [l[0].x, l[0].y] as [number, number]]]);
  let out: MultiPolygon = [];
  for (const poly of mp) {
    let part: MultiPolygon = [];
    for (const m of toMp(offsetPolygon(ring(poly[0] as number[][]), d, tol))) part = part.length ? polygonClipping.union(part, m) : [m];
    for (const hole of poly.slice(1)) {
      const h = toMp(offsetPolygon(ring(hole as number[][]), -d, tol));
      if (h.length && part.length) part = polygonClipping.difference(part, ...h);
    }
    if (part.length) out = out.length ? polygonClipping.union(out, part) : part;
  }
  return out;
}

/** Wie weit die Kante auf Höhe v (über dem Beginn der Kante) zurückspringt: Fase linear, Rundung als Viertelkreis */
export function edgeInset(e: Edge, v: number): number {
  const s = e.size, t = Math.max(0, Math.min(s, v));
  return e.kind === "chamfer" ? t : s - Math.sqrt(Math.max(0, s * s - t * t));
}

/**
 * Kanten in feine Teilschritte zerlegen (Körper und STL zeigen sie als feine Stufen; je Stufe höchstens 0,25 mm hoch).
 * Aufbauen: oben wird die Fläche nach innen kleiner. Ausschneiden: oben am Rand der Öffnung wird sie nach außen größer.
 */
export function expandEdges(feats: EvalFeat[], rimTopOf: (f: EvalFeat) => number = () => Infinity): EvalFeat[] {
  const out: EvalFeat[] = [];
  for (const f0 of feats) {
    // Ausschnitt: die Kante sitzt an der Oberfläche rund um die Öffnung (nicht in der Luft darüber)
    const rt = f0.op === "cut" && f0.edge ? rimTopOf(f0) : Infinity;
    const f = rt < f0.z1 ? { ...f0, z1: rt } : f0;
    const e = f.edge;
    const H = f.z1 - f.z0;
    if (!e || !(e.size > 0) || !f.region.length || H <= 1e-6) { out.push({ op: f.op, z0: f.z0, z1: f.z1, region: f.region }); continue; }
    const s = Math.min(e.size, H), zb = f.z1 - s;
    if (f.op === "join" && zb > f.z0 + 1e-9) out.push({ op: "join", z0: f.z0, z1: zb, region: f.region });
    if (f.op === "cut") out.push({ op: "cut", z0: f0.z0, z1: f0.z1, region: f.region });
    const n = Math.max(3, Math.min(24, Math.ceil(s / 0.25)));
    for (let i = 0; i < n; i++) {
      const a = zb + (s * i) / n, b = zb + (s * (i + 1)) / n, d = edgeInset({ kind: e.kind, size: s }, (a + b) / 2 - zb);
      const region = offsetRegion(f.region, f.op === "join" ? -d : d); // Material springt oben um d zurück
      if (region.length) out.push({ op: f.op, z0: a, z1: b, region });
    }
  }
  return out;
}

/**
 * Höhe der Oberfläche rund um eine Öffnung: oberste Scheibe, die einen schmalen Ring um die Fläche (Breite d) zum
 * größten Teil bedeckt. -Infinity = dort ist kein Material
 */
export function rimTop(plain: Slab[], region: MultiPolygon, d: number): number {
  const band = polygonClipping.difference(offsetRegion(region, Math.max(0.05, d)), region);
  const a = area(band);
  if (a < 1e-9) return -Infinity;
  for (let i = plain.length - 1; i >= 0; i--) if (area(polygonClipping.intersection(band, plain[i].region)) >= 0.5 * a) return plain[i].z1;
  return -Infinity;
}

/** Scheiben des Körpers (von unten nach oben), leere weggelassen */
export function slabs(feats0: EvalFeat[]): Slab[] {
  let feats = feats0;
  if (feats0.some(f => f.edge)) {
    const plain = slabs(feats0.map(f => ({ op: f.op, z0: f.z0, z1: f.z1, region: f.region })));
    feats = expandEdges(feats0, f => rimTop(plain, f.region, f.edge!.size));
  }
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
export interface MillOp {
  mode: "outside" | "inside" | "pocket" | "chamfer"; depth: number; ring: [number, number][]; key?: string; islandOf?: string;
  /** chamfer: Fasenbreite (mm) und Seite: +1 außen an der Kontur (Kante eines Aufbaus), -1 innen (Rand einer Öffnung) */
  width?: number; side?: number;
}
/**
 * Hinweise: inner = Ausschnitt erreicht die Oberkante nicht (von oben nicht fräsbar, wird aufgefüllt), raised = Erhebungen,
 * rounds = Rundungen (nur im Körper, nicht gefräst), edgeLow = Fasen unterhalb der Oberkante (nicht gefräst)
 */
export interface MillPlan { ops: MillOp[]; height: number; bottom: number; inner: number; raised: number; rounds: number; edgeLow: number }

const openRing = (r: [number, number][]) => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r.slice());

/**
 * Fräs-Formen aus den Schritten des Körpers (von oben, Oberkante = Z 0). eps: Höhen-Toleranz in mm.
 * Für jede Höhe a, an der eine Scheibe beginnt: Tasche über alles, was ab a nach oben leer ist, bis Tiefe (Oberkante − a).
 * Was darin stehen bleibt, sind Inseln dieser Tasche. Hohlräume unter Material (von oben nicht erreichbar) gelten als voll.
 */
export function millPlan(feats: EvalFeat[], eps = 1e-6): MillPlan {
  // Kanten (Fase/Rundung) zählen hier nicht zur Form – sie werden unten als eigene Fasen-Bahnen angehängt
  const s = slabs(feats.map(f => ({ op: f.op, z0: f.z0, z1: f.z1, region: f.region })));
  if (!s.length) return { ops: [], height: 0, bottom: 0, inner: 0, raised: 0, rounds: 0, edgeLow: 0 };
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

  // Kanten: Fase an der Oberkante → V-Fräser-Fase an der Kontur; Rundungen und tiefer liegende Fasen nur melden
  let rounds = 0, edgeLow = 0;
  const outline: MultiPolygon = foot.map(poly => [poly[0]]); // Umriss ohne Löcher: Fasen an Durchbrüchen bleiben drin
  for (const f of feats) {
    const e = f.edge;
    if (!e || !(e.size > 0) || !f.region.length) continue;
    if (e.kind === "round") { rounds++; continue; }
    // Aufbau: seine Oberkante ist die Oberseite. Ausschnitt: die Oberfläche rund um die Öffnung ist die Oberseite
    const atTop = f.op === "cut" ? f.z1 >= top - eps && Math.abs(rimTop(s, f.region, e.size) - top) <= eps : Math.abs(f.z1 - top) <= eps;
    if (!atTop) { edgeLow++; continue; }
    const area = polygonClipping.intersection(f.region, outline);
    const outer = f.op === "join" ? 1 : -1;
    for (const poly of area) poly.forEach((ring, k) => ops.push({ mode: "chamfer", depth: 0, ring: openRing(ring as [number, number][]), width: e.size, side: k === 0 ? outer : -outer }));
  }
  return { ops: ops.filter(o => o.ring.length >= 3), height, bottom, inner, raised, rounds, edgeLow };
}
