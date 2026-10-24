/**
 * MATERIAL-VORLAGEN FÜR DEN LASER (Laser-Bibliothek → „Vorlagen“)
 *
 * Startwerte je Material, Dicke und Arbeit (schneiden / gravieren) für einen Bezugs-Laser:
 * Diode 10 W (optische Leistung) und CO2 50 W. Für den eigenen Laser wird umgerechnet:
 *  - schneiden: gleiche Leistung %, Geschwindigkeit im Verhältnis der Watt (gleiche Energie pro mm);
 *    wird es langsamer als sinnvoll, gibt es stattdessen mehr Durchgänge
 *  - gravieren: gleiche Geschwindigkeit, Leistung % im umgekehrten Verhältnis der Watt;
 *    reicht 100 % nicht, wird langsamer graviert
 * Bewusst vorsichtige Richtwerte aus üblichen Tabellen – immer erst mit dem Material-Testraster prüfen.
 */

export type LaserKind = "diode" | "co2";
export type PresetOp = "cut" | "engrave";

/** [Leistung %, Geschwindigkeit mm/min, Durchgänge] am Bezugs-Laser; fehlt = für diese Laserart nicht geeignet */
type Val = [number, number, number];

export interface LaserPreset {
  id: string;
  mat: string;        // Schlüssel für llib.mat.<mat>
  thick: number;      // mm, 0 = Gravur ohne Dicke
  op: PresetOp;
  diode?: Val;
  co2?: Val;
  note?: string;      // i18n-Schlüssel für einen Hinweis (z. B. nur dunkles Acryl)
}

export const REF_WATT: Record<LaserKind, number> = { diode: 10, co2: 50 };
const LIMITS: Record<LaserKind, { minP: number; maxV: number; minCutV: number }> = {
  diode: { minP: 1, maxV: 6000, minCutV: 100 },
  co2: { minP: 10, maxV: 24000, minCutV: 300 }
};
/** mehr Durchgänge als so viele: zu schwach für diese Arbeit */
export const MAX_PASSES = 6;

export const PRESETS: LaserPreset[] = [
  { id: "ply3c", mat: "plywood", thick: 3, op: "cut", diode: [100, 300, 1], co2: [60, 900, 1] },
  { id: "ply4c", mat: "plywood", thick: 4, op: "cut", diode: [100, 300, 2], co2: [65, 720, 1] },
  { id: "ply6c", mat: "plywood", thick: 6, op: "cut", diode: [100, 200, 3], co2: [75, 480, 1] },
  { id: "plye", mat: "plywood", thick: 0, op: "engrave", diode: [40, 3000, 1], co2: [25, 18000, 1] },
  { id: "hw3c", mat: "hardwood", thick: 3, op: "cut", diode: [100, 200, 2], co2: [70, 600, 1] },
  { id: "hwe", mat: "hardwood", thick: 0, op: "engrave", diode: [50, 2500, 1], co2: [30, 15000, 1] },
  { id: "mdf3c", mat: "mdf", thick: 3, op: "cut", diode: [100, 200, 2], co2: [65, 720, 1] },
  { id: "mdfe", mat: "mdf", thick: 0, op: "engrave", diode: [35, 3000, 1], co2: [25, 15000, 1] },
  { id: "acr3c", mat: "acrylic", thick: 3, op: "cut", diode: [100, 120, 3], co2: [65, 900, 1], note: "llib.pre.noteAcryl" },
  { id: "acre", mat: "acrylic", thick: 0, op: "engrave", diode: [60, 2000, 1], co2: [20, 18000, 1], note: "llib.pre.noteAcryl" },
  { id: "card2c", mat: "cardboard", thick: 2, op: "cut", diode: [100, 900, 1], co2: [25, 1800, 1] },
  { id: "pap0c", mat: "paper", thick: 0.2, op: "cut", diode: [30, 1500, 1], co2: [10, 3000, 1] },
  { id: "lea2c", mat: "leather", thick: 2, op: "cut", diode: [100, 400, 2], co2: [60, 900, 1], note: "llib.pre.noteLeather" },
  { id: "leae", mat: "leather", thick: 0, op: "engrave", diode: [30, 3000, 1], co2: [20, 12000, 1], note: "llib.pre.noteLeather" },
  { id: "cork3c", mat: "cork", thick: 3, op: "cut", diode: [100, 600, 1], co2: [30, 1500, 1] },
  { id: "felt3c", mat: "felt", thick: 3, op: "cut", diode: [100, 600, 1], co2: [30, 1800, 1] },
  { id: "slatee", mat: "slate", thick: 0, op: "engrave", diode: [80, 2000, 1], co2: [30, 12000, 1] },
  { id: "glasse", mat: "glass", thick: 0, op: "engrave", co2: [30, 6000, 1], note: "llib.pre.noteGlass" },
  { id: "anoe", mat: "anodized", thick: 0, op: "engrave", diode: [60, 3000, 1], co2: [40, 12000, 1] }
];

export interface PresetValues { power: number; speed: number; passes: number; weak: boolean }

const round = (v: number, step: number) => Math.round(v / step) * step;

/** Startwerte einer Vorlage für den eigenen Laser (null = Laserart dafür nicht geeignet) */
export function presetValues(p: LaserPreset, kind: LaserKind, watt: number): PresetValues | null {
  const v0 = p[kind];
  if (!v0) return null;
  const [p0, s0, n0] = v0;
  const k = Math.max(0.05, watt / REF_WATT[kind]);
  const lim = LIMITS[kind];
  let power = p0, speed = s0, passes = n0;
  if (p.op === "cut") {
    // stärkerer Laser: erst weniger Durchgänge, dann schneller (gleiche Energie pro mm)
    passes = Math.max(1, Math.ceil(n0 / Math.max(1, k)));
    speed = Math.min(lim.maxV, s0 * k * passes / n0);
    if (speed < lim.minCutV) {
      // zu langsam: lieber mehr Durchgänge mit sinnvoller Geschwindigkeit
      const more = Math.ceil(passes * lim.minCutV / speed);
      speed = speed * more / passes;
      passes = more;
    }
  } else {
    power = p0 / k;
    if (power > 100) { speed = s0 * 100 / power; power = 100; }
    else if (power < lim.minP) { speed = Math.min(lim.maxV, s0 * lim.minP / power); power = lim.minP; }
  }
  return {
    power: Math.max(lim.minP, Math.min(100, round(power, 1))),
    speed: Math.max(10, round(speed, speed >= 1000 ? 50 : 10)),
    passes,
    weak: passes > MAX_PASSES
  };
}
