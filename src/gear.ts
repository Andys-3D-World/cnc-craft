/**
 * ZAHNRAD-GENERATOR: Stirnräder mit Evolventen-Verzahnung zum Lasern oder Fräsen (Fenster: editor/gearGen.ts)
 *
 * Maße wie in der Mechanik üblich: Modul m, Zähnezahl z, Eingriffswinkel α (meist 20°).
 *   Teilkreis d = m·z, Grundkreis db = d·cos α, Kopfkreis da = d + 2m(1 + x), Fußkreis df = d − 2m(1,25 − x)
 *   (x = Profilverschiebung, Kopfspiel 0,25·m). Zahnflanken = Evolvente des Grundkreises; liegt der Fußkreis
 *   unter dem Grundkreis, geht die Flanke dort gerade (radial) bis zum Fuß.
 * Flankenspiel: der Zahn wird auf dem Teilkreis um die Hälfte des Spiels dünner – zwei Räder mit derselben
 * Einstellung haben zusammen genau das eingestellte Spiel.
 * Gegenrad (auf Wunsch): Profilverschiebung −x (V-Null), dann bleibt der Achsabstand a = m·(z1 + z2) / 2.
 *
 * Bohrung in der Mitte: keine, rund, mit Passfedernut (Maße nach DIN 6885-1 als Vorschlag) oder mit Abflachung
 * (D-Welle, z. B. Schrittmotor). Dazu auf Wunsch runde Erleichterungslöcher zwischen Nabe und Zahnkranz.
 *
 * Nur Geometrie, ohne Oberfläche (Tests: `npm test`). Alles in mm, Y nach oben, Radmitte bei (0, 0),
 * Zahn 0 zeigt nach +X, die Nut zeigt nach +Y.
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Polygon } from "polygon-clipping";

export type XY = [number, number];
export type BoreKind = "none" | "round" | "key" | "dflat";
export const BORE_KINDS: BoreKind[] = ["none", "round", "key", "dflat"];

export interface GearOptions {
  teeth: number;          // Zähnezahl (6 … 300)
  module: number;         // Modul m (mm)
  pressureAngle: number;  // Eingriffswinkel α (°)
  backlash: number;       // Flankenspiel gesamt (mm, auf dem Teilkreis)
  shift: number;          // Profilverschiebung x (× m)
  bore: BoreKind;
  boreD: number;          // Bohrung Ø (mm)
  keyAuto: boolean;       // Nutmaße nach DIN 6885 aus dem Ø
  keyW: number;           // Nutbreite b (mm)
  keyDepth: number;       // Nuttiefe in der Nabe t2 (mm, ab Bohrungsrand)
  flat: number;           // D-Welle: Maß von der Abflachung bis zur gegenüberliegenden Seite (mm)
  holes: number;          // Erleichterungslöcher (0 = keine, sonst 3 … 12)
  pair: boolean;          // Gegenrad dazu
  teeth2: number;         // Zähnezahl Gegenrad
}

export interface GearDims { z: number; m: number; x: number; d: number; db: number; da: number; df: number; p: number }

export interface GearPart {
  dims: GearDims;
  area: MultiPolygon;     // fertiges Teil (Außenkontur + Bohrung + Löcher), um die eigene Mitte
  outline: XY[];          // nur die Zahnkontur (geschlossen: letzter Punkt = erster)
  rootGap: number;        // Breite der Zahnlücke am Fußkreis (mm) – so dick darf ein Fräser höchstens sein
  pointed: boolean;       // Zähne wären spitz → Kopfkreis gekürzt
  holes: number;          // wirklich gesetzte Erleichterungslöcher
}

export interface GearResult {
  gears: GearPart[];      // 1 oder 2 Räder
  centerDist: number;     // Achsabstand (mm), 0 ohne Gegenrad
  /** Lage für die Vorschau im Eingriff: Mitte und Drehung (rad) je Rad – die Drehung steckt schon in `area` */
  mesh: XY[];
  key: KeySize | null;    // verwendete Nutmaße
  warnings: string[];     // Übersetzungs-Schlüssel
  undercutX: number;      // Profilverschiebung, ab der kein Unterschnitt mehr entsteht (für den Hinweis)
}

/** Passfeder nach DIN 6885-1 (Form A): Wellen-Ø-Bereich, Breite b, Höhe h, Nuttiefe Welle t1, Nabe t2 */
export interface KeySize { dMin: number; dMax: number; b: number; h: number; t1: number; t2: number }
export const DIN6885: KeySize[] = [
  { dMin: 6, dMax: 8, b: 2, h: 2, t1: 1.2, t2: 1.0 },
  { dMin: 8, dMax: 10, b: 3, h: 3, t1: 1.8, t2: 1.4 },
  { dMin: 10, dMax: 12, b: 4, h: 4, t1: 2.5, t2: 1.8 },
  { dMin: 12, dMax: 17, b: 5, h: 5, t1: 3.0, t2: 2.3 },
  { dMin: 17, dMax: 22, b: 6, h: 6, t1: 3.5, t2: 2.8 },
  { dMin: 22, dMax: 30, b: 8, h: 7, t1: 4.0, t2: 3.3 },
  { dMin: 30, dMax: 38, b: 10, h: 8, t1: 5.0, t2: 3.3 },
  { dMin: 38, dMax: 44, b: 12, h: 8, t1: 5.0, t2: 3.3 },
  { dMin: 44, dMax: 50, b: 14, h: 9, t1: 5.5, t2: 3.8 },
  { dMin: 50, dMax: 58, b: 16, h: 10, t1: 6.0, t2: 4.3 },
  { dMin: 58, dMax: 65, b: 18, h: 11, t1: 7.0, t2: 4.4 },
  { dMin: 65, dMax: 75, b: 20, h: 12, t1: 7.5, t2: 4.9 },
  { dMin: 75, dMax: 85, b: 22, h: 14, t1: 9.0, t2: 5.4 },
  { dMin: 85, dMax: 95, b: 25, h: 14, t1: 9.0, t2: 5.4 },
  { dMin: 95, dMax: 110, b: 28, h: 16, t1: 10.0, t2: 6.4 },
];

/** Passfeder für einen Wellen-Ø (Bereich „über dMin bis dMax“), null außerhalb der Tabelle */
export function keyFor(d: number): KeySize | null {
  if (d < DIN6885[0].dMin) return null;
  return DIN6885.find(k => d <= k.dMax) ?? null;
}

const inv = (a: number) => Math.tan(a) - a;
const rad = (deg: number) => deg * Math.PI / 180;

export function gearDims(z: number, m: number, alphaDeg: number, x = 0): GearDims {
  const d = m * z;
  return { z, m, x, d, db: d * Math.cos(rad(alphaDeg)), da: d + 2 * m * (1 + x), df: d - 2 * m * (1.25 - x), p: Math.PI * m };
}

/** halber Zahnwinkel (rad) auf dem Radius R (R ≥ Grundkreis) */
export function toothHalfAngle(z: number, m: number, alphaDeg: number, backlash: number, x: number, R: number): number {
  const a = rad(alphaDeg), r = m * z / 2, rb = r * Math.cos(a);
  const s = Math.PI * m / 2 + 2 * x * m * Math.tan(a) - backlash / 2; // Zahndicke auf dem Teilkreis
  const phi = Math.acos(Math.min(1, rb / Math.max(R, rb)));
  return s / (2 * r) + inv(a) - inv(phi);
}

/**
 * Zahnkontur gegen den Uhrzeigersinn (geschlossen). `rot` dreht die Zähne (rad).
 * Je Zahn: rechte Flanke hoch, Kopf, linke Flanke runter, Fußkreis bis zum nächsten Zahn.
 */
export function gearOutline(z: number, m: number, alphaDeg: number, backlash: number, x: number, rot = 0):
  { pts: XY[]; rootGap: number; pointed: boolean } {
  const dm = gearDims(z, m, alphaDeg, x);
  const rb = dm.db / 2, rf = dm.df / 2;
  let ra = dm.da / 2;
  const half = (R: number) => toothHalfAngle(z, m, alphaDeg, backlash, x, R);
  // spitze Zähne: Kopfkreis dorthin, wo der Zahn noch etwas Breite hat
  let pointed = false;
  const minTip = 0.02 * m;
  if (half(ra) * ra < minTip) {
    pointed = true;
    let lo = Math.max(rb, rf), hi = ra;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (half(mid) * mid < minTip) hi = mid; else lo = mid; }
    ra = lo;
  }
  const r0 = Math.max(rb, rf); // hier beginnt die Evolvente
  const th0 = half(r0);
  const pitch = 2 * Math.PI / z;
  const gap = Math.max(0, pitch - 2 * th0);
  const rootGap = 2 * rf * Math.sin(gap / 2);
  // Flanke: gleichmäßig im Abrollwinkel u = tan φ abtasten (dicht am Grundkreis, wo sie sich stark krümmt)
  const u0 = Math.sqrt(Math.max(0, (r0 / rb) ** 2 - 1)), u1 = Math.sqrt(Math.max(0, (ra / rb) ** 2 - 1));
  const N = 14;
  const flank: { R: number; th: number }[] = [];
  if (rf < rb) flank.push({ R: rf, th: half(rb) }); // gerades Stück unter dem Grundkreis
  for (let i = 0; i <= N; i++) {
    const u = u0 + (u1 - u0) * i / N, R = rb * Math.sqrt(1 + u * u);
    flank.push({ R, th: half(R) });
  }
  const pol = (R: number, ang: number): XY => [R * Math.cos(ang), R * Math.sin(ang)];
  const arc = (R: number, a0: number, a1: number, out: XY[]) => {
    const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) * R / Math.max(0.15, m * 0.15)));
    for (let i = 1; i < n; i++) out.push(pol(R, a0 + (a1 - a0) * i / n));
  };
  const pts: XY[] = [];
  for (let k = 0; k < z; k++) {
    const c = rot + k * pitch;
    for (const f of flank) pts.push(pol(f.R, c - f.th));                  // rechte Flanke hoch
    const tip = half(ra);
    arc(ra, c - tip, c + tip, pts);                                        // Kopf
    for (let i = flank.length - 1; i >= 0; i--) pts.push(pol(flank[i].R, c + flank[i].th)); // linke Flanke runter
    if (gap > 0) arc(rf, c + th0, c + pitch - th0, pts);                   // Fuß bis zum nächsten Zahn
  }
  pts.push([pts[0][0], pts[0][1]]);
  return { pts, rootGap, pointed };
}

export function circle(cx: number, cy: number, r: number): XY[] {
  const n = 4 * Math.ceil(Math.max(48, Math.min(360, 2 * Math.PI * r / 0.3)) / 4); // durch 4 teilbar: Punkte auf den Achsen
  const out: XY[] = [];
  for (let i = 0; i < n; i++) out.push([cx + r * Math.cos(2 * Math.PI * i / n), cy + r * Math.sin(2 * Math.PI * i / n)]);
  out.push([out[0][0], out[0][1]]);
  return out;
}

/** Bohrungs-Fläche (das, was ausgeschnitten wird) und wie weit sie höchstens von der Mitte reicht */
export function boreArea(o: Pick<GearOptions, "bore" | "boreD" | "keyAuto" | "keyW" | "keyDepth" | "flat">):
  { area: MultiPolygon; reach: number; key: KeySize | null } {
  const r = o.boreD / 2;
  if (o.bore === "none" || !(r > 0)) return { area: [], reach: 0, key: null };
  const c: Polygon = [circle(0, 0, r)];
  if (o.bore === "round") return { area: [c], reach: r, key: null };
  if (o.bore === "dflat") {
    const top = Math.min(r * 0.98, Math.max(-r * 0.5, o.flat - r)); // Abflachung bei y = top
    return { area: polygonClipping.intersection(c, [[[-r - 1, -r - 1], [r + 1, -r - 1], [r + 1, top], [-r - 1, top], [-r - 1, -r - 1]]]), reach: r, key: null };
  }
  // Passfedernut nach oben: Breite b, Grund bei y = r + t2
  const din = keyFor(o.boreD);
  const key: KeySize = o.keyAuto && din ? din : { dMin: 0, dMax: 0, b: o.keyW, h: 0, t1: 0, t2: o.keyDepth };
  const b = Math.min(key.b, o.boreD * 0.9), top = r + Math.max(0, key.t2);
  if (!(b > 0) || top <= r) return { area: [c], reach: r, key: null };
  const slot: Polygon = [[[-b / 2, 0], [b / 2, 0], [b / 2, top], [-b / 2, top], [-b / 2, 0]]];
  return { area: polygonClipping.union(c, slot), reach: Math.hypot(b / 2, top), key: { ...key, b } };
}

function onePart(z: number, x: number, rot: number, o: GearOptions, bore: MultiPolygon, reach: number): GearPart {
  const dims = gearDims(z, o.module, o.pressureAngle, x);
  const ol = gearOutline(z, o.module, o.pressureAngle, o.backlash, x, rot);
  let area: MultiPolygon = [[ol.pts]];
  if (bore.length) area = polygonClipping.difference(area, bore);
  const lh = lightenHoles(area, dims.df / 2, reach, o.holes, o.module);
  area = lh.area;
  const holes = lh.holes;
  return { dims, area, outline: ol.pts, rootGap: ol.rootGap, pointed: ol.pointed, holes };
}

/**
 * Erleichterungslöcher zwischen Nabe (Bohrung + Rand) und Kranz (`rim` = Fußkreis-Radius, davon geht noch ein Rand ab).
 * Steg und Rand je mindestens 2·m bzw. 2,5 mm. Kein Platz → keine Löcher (holes = 0).
 */
export function lightenHoles(area: MultiPolygon, rim0: number, reach: number, count: number, m: number): { area: MultiPolygon; holes: number } {
  const n = Math.round(count);
  if (n < 3) return { area, holes: 0 };
  const rim = rim0 - Math.max(2 * m, 2.5);
  const hub = Math.max(reach, 0) + Math.max(2 * m, 3);
  const web = Math.max(2 * m, 2.5);
  const mid = (rim + hub) / 2;
  const hr = Math.min((rim - hub) / 2, mid * Math.sin(Math.PI / n) - web / 2);
  if (hr < 1) return { area, holes: 0 };
  const cut: Polygon[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 + Math.PI / n + 2 * Math.PI * i / n; // zwischen die Nut gesetzt
    cut.push([circle(mid * Math.cos(a), mid * Math.sin(a), hr)]);
  }
  return { area: polygonClipping.difference(area, ...cut), holes: n };
}

/** kleinste Profilverschiebung ohne Unterschnitt (für z Zähne bei α) */
export function noUndercutShift(z: number, alphaDeg: number): number {
  return 1 - z * Math.sin(rad(alphaDeg)) ** 2 / 2;
}

export function gear(o: GearOptions): GearResult {
  const z1 = Math.round(o.teeth), z2 = Math.round(o.teeth2);
  const { area: bore, reach, key } = boreArea(o);
  const warnings: string[] = [];
  const g1 = onePart(z1, o.shift, 0, o, bore, reach);
  const gears = [g1];
  const mesh: XY[] = [[0, 0]];
  let centerDist = 0;
  if (o.pair && z2 >= 6) {
    centerDist = o.module * (z1 + z2) / 2;
    // Gegenrad: Zahnlücke zeigt auf Zahn 0 des ersten Rads (bei 180°)
    gears.push(onePart(z2, -o.shift, Math.PI + Math.PI / z2, o, bore, reach));
    mesh.push([centerDist, 0]);
  }
  const ux = noUndercutShift(z1, o.pressureAngle);
  if (o.shift < ux - 1e-9) warnings.push("gear.warnUndercut");
  if (gears.some(g => g.pointed)) warnings.push("gear.warnPointed");
  if (o.pair && gears.length > 1 && -o.shift < noUndercutShift(z2, o.pressureAngle) - 1e-9) warnings.push("gear.warnUndercut2");
  if (reach > 0 && reach > g1.dims.df / 2 - o.module) warnings.push("gear.warnBore");
  if (o.bore === "key" && o.keyAuto && !keyFor(o.boreD)) warnings.push("gear.warnNoDin");
  if (Math.round(o.holes) >= 3 && gears.some(g => !g.holes)) warnings.push("gear.warnHoles");
  return { gears, centerDist, mesh, key, warnings, undercutX: ux };
}
