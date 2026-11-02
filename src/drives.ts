/**
 * ANTRIEBE im Zahnrad-Generator: Zahnstange, Zahnriemenscheibe und Kettenrad (Fenster: editor/gearGen.ts)
 *
 * Zahnstange: Bezugsprofil wie beim Stirnrad (Modul m, Eingriffswinkel α, Kopf m, Fuß 1,25·m), gerade Flanken.
 *   Teilung p = π·m, Zahndicke auf der Teillinie p/2 − Spiel/2. Auf Wunsch ein Ritzel (Stirnrad) dazu – dessen
 *   Mitte liegt m·z/2 über der Teillinie.
 * Zahnriemenscheibe: Außen-Ø = z·P/π − 2u (P = Teilung, u = Abstand Teillinie–Riemen-Unterseite). Die Rillen sind
 *   eine Näherung des Riemenprofils (Flanken + gerundeter Grund) – für Lasern/Fräsen genau genug, vorher eine
 *   Probe mit dem eigenen Riemen machen. Auf Wunsch zwei Bordscheiben (Ø + 4 mm) zum Aufkleben.
 * Kettenrad (Rollenkette nach ISO 606): Teilkreis D = p / sin(180°/z), Rollenbett-Radius ri = 0,505·d1 + 0,069·∛d1,
 *   Kopfkreis ≈ p·(0,6 + cot(180°/z)). Zahnflanken: Kreis um die Nachbarrolle mit Radius p − ri – so dreht sich die
 *   Rolle beim Ein- und Auslaufen frei heraus.
 *
 * Nur Geometrie (Tests: `npm test`). Alles in mm, Y nach oben. Räder: Mitte (0, 0), Nut nach +Y.
 * Zahnstange: Teillinie bei y = 0, erster Zahn bei x = 0.
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Polygon } from "polygon-clipping";
import { gearOutline, circle, lightenHoles, type XY } from "./gear.ts";

// ---------- Zahnstange ----------

export interface RackOptions { module: number; pressureAngle: number; backlash: number; teeth: number; back: number }

export function rackOutline(o: RackOptions): { pts: XY[]; length: number; height: number; rootGap: number } {
  const m = o.module, p = Math.PI * m, ta = Math.tan(o.pressureAngle * Math.PI / 180);
  const s = p / 2 - o.backlash / 2;
  const n = Math.max(1, Math.round(o.teeth));
  const ha = m, hf = 1.25 * m;
  const tipHalf = Math.max(0.01 * m, s / 2 - ha * ta), rootHalf = s / 2 + hf * ta;
  const bottom = -hf - Math.max(0.5, o.back);
  const x0 = -p / 2, x1 = (n - 1) * p + p / 2;
  const pts: XY[] = [[x0, bottom], [x1, bottom], [x1, -hf]];
  // von rechts nach links über die Zähne (gegen den Uhrzeigersinn)
  for (let k = n - 1; k >= 0; k--) {
    const c = k * p;
    pts.push([c + rootHalf, -hf], [c + tipHalf, ha], [c - tipHalf, ha], [c - rootHalf, -hf]);
  }
  pts.push([x0, -hf], [x0, bottom]);
  return { pts, length: x1 - x0, height: ha - bottom, rootGap: p - 2 * rootHalf };
}

// ---------- Zahnriemenscheibe ----------

export type BeltProfile = "gt2" | "htd3m" | "htd5m" | "t5";
export const BELT_PROFILES: BeltProfile[] = ["gt2", "htd3m", "htd5m", "t5"];
/** Teilung P, 2u (Außen-Ø = Teilkreis − 2u), Rillentiefe h, halbe Breite oben/unten, Rundung im Grund */
export const BELTS: Record<BeltProfile, { pitch: number; pld2: number; depth: number; wTop: number; wBot: number; r: number }> = {
  gt2: { pitch: 2, pld2: 0.508, depth: 0.76, wTop: 0.68, wBot: 0.555, r: 0.555 },
  htd3m: { pitch: 3, pld2: 0.762, depth: 1.2, wTop: 1.0, wBot: 0.86, r: 0.86 },
  htd5m: { pitch: 5, pld2: 1.143, depth: 2.1, wTop: 1.7, wBot: 1.5, r: 1.5 },
  t5: { pitch: 5, pld2: 0.85, depth: 1.25, wTop: 1.45, wBot: 1.0, r: 0.3 },
};

export function pulleyOD(profile: BeltProfile, z: number): number {
  const b = BELTS[profile];
  return z * b.pitch / Math.PI - b.pld2;
}

/** Rille in Polarkoordinaten (r = radial, t = quer), um die Richtung `ang` gedreht */
function groove(R: number, b: (typeof BELTS)[BeltProfile], ang: number): XY[] {
  const loc: [number, number][] = [];
  const cr = R - b.depth + b.r;                 // Mitte der Grund-Rundungen (radial)
  const ct = Math.max(0, b.wBot - b.r);         // … quer
  loc.push([R + 1, -b.wTop], [R, -b.wTop]);
  for (let i = 0; i <= 6; i++) { const f = i / 6 * Math.PI / 2; loc.push([cr - b.r * Math.sin(f), -ct - b.r * Math.cos(f)]); }
  for (let i = 0; i <= 6; i++) { const f = i / 6 * Math.PI / 2; loc.push([cr - b.r * Math.cos(f), ct + b.r * Math.sin(f)]); }
  loc.push([R, b.wTop], [R + 1, b.wTop]);
  const c = Math.cos(ang), s = Math.sin(ang);
  const out = loc.map(([r, t]) => [r * c - t * s, r * s + t * c] as XY);
  out.push([out[0][0], out[0][1]]);
  return out;
}

export function pulleyArea(profile: BeltProfile, z: number): MultiPolygon {
  const R = pulleyOD(profile, z) / 2, b = BELTS[profile];
  const cuts: Polygon[] = [];
  for (let k = 0; k < z; k++) cuts.push([groove(R, b, 2 * Math.PI * k / z)]);
  return polygonClipping.difference([[circle(0, 0, R)]], ...cuts);
}

// ---------- Kettenrad ----------

export interface ChainSize { id: string; p: number; d1: number }
/** gängige Rollenketten (ISO 606 / DIN 8187/8188) – Teilung p und Rollen-Ø d1 */
export const CHAINS: ChainSize[] = [
  { id: "04C", p: 6.35, d1: 3.3 },
  { id: "05B", p: 8, d1: 5 },
  { id: "06C", p: 9.525, d1: 5.08 },
  { id: "06B", p: 9.525, d1: 6.35 },
  { id: "08A", p: 12.7, d1: 7.92 },
  { id: "08B", p: 12.7, d1: 8.51 },
  { id: "bike", p: 12.7, d1: 7.75 },
  { id: "10A", p: 15.875, d1: 10.16 },
  { id: "10B", p: 15.875, d1: 10.16 },
  { id: "12B", p: 19.05, d1: 12.07 },
];

export function sprocketDims(p: number, d1: number, z: number) {
  const ri = 0.505 * d1 + 0.069 * Math.cbrt(d1);
  const D = p / Math.sin(Math.PI / z);
  const da = p * (0.6 + 1 / Math.tan(Math.PI / z));
  return { ri, D, da, df: D - 2 * ri };
}

export function sprocketArea(p: number, d1: number, z: number): MultiPolygon {
  const { ri, D, da } = sprocketDims(p, d1, z);
  const P = (k: number): XY => [D / 2 * Math.cos(2 * Math.PI * k / z), D / 2 * Math.sin(2 * Math.PI * k / z)];
  const tipDisc: Polygon = [circle(0, 0, da / 2)];
  const teeth: MultiPolygon[] = [];
  for (let k = 0; k < z; k++) {
    const a = P(k), b = P(k + 1);
    teeth.push(polygonClipping.intersection(tipDisc, [circle(a[0], a[1], p - ri)], [circle(b[0], b[1], p - ri)]));
  }
  const body = polygonClipping.union([circle(0, 0, D / 2)], ...teeth);
  const seats: Polygon[] = [];
  for (let k = 0; k < z; k++) { const c = P(k); seats.push([circle(c[0], c[1], ri)]); }
  return polygonClipping.difference(body, ...seats);
}

// ---------- gemeinsam: Bohrung + Erleichterungslöcher anbringen ----------

export function finishWheel(area: MultiPolygon, bore: MultiPolygon, reach: number, rim: number, holes: number, unit: number) {
  const a = bore.length ? polygonClipping.difference(area, bore) : area;
  const lh = lightenHoles(a, rim, reach, holes, unit);
  return { area: lh.area, holes: lh.holes };
}

/** Ritzel zur Zahnstange: Zahnlücke zeigt nach unten auf den Zahn in der Mitte der Stange */
export function rackPinion(o: RackOptions, z: number): { pts: XY[]; at: XY } {
  const n = Math.max(1, Math.round(o.teeth));
  const ol = gearOutline(z, o.module, o.pressureAngle, o.backlash, 0, -Math.PI / 2 + Math.PI / z);
  return { pts: ol.pts, at: [Math.floor((n - 1) / 2) * Math.PI * o.module, o.module * z / 2] };
}
