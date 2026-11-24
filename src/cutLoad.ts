/**
 * BELASTUNG DES FRÄSERS (ohne Oberfläche): Zahnvorschub, Spanvolumen und – nur bei Metall – die Leistung am Fräser.
 *
 * Gerechnet wird der schwerste übliche Fall: volle Nut (Fräser schneidet auf ganzer Breite), so wie beim Ausschneiden.
 *   Spanvolumen Q = ap × ae × vf     Leistung Pc = Q × kc     kc = kc1 × hm^−mc     hm = fz × 2/π (Mittel in der Nut)
 * kc1 (spezifische Schnittkraft bei 1 mm Spandicke) steht als BEREICH da, weil Legierung und Schneide viel ausmachen:
 * Stahl und rostfrei nach Sandvik Coromant (ISO P 1400–3100, ISO M 1800–2850 N/mm²); Alu, Messing und Kupfer sind
 * übliche Tabellenwerte. mc = 0,25 (üblich 0,2–0,3). Für Holz, Kunststoff, Schaum und Platinen gibt es keine
 * verlässlichen Werte: dort keine Leistung, lieber keine Zahl als eine erfundene.
 * Die Spindel gibt ihre Leistung erst bei voller Drehzahl ab (gleiches Drehmoment): darunter zählt der Anteil.
 */
import type { ToolType } from "./toolGraphics.ts";

const KC1: Record<string, [number, number]> = {
  alu: [350, 800], brass: [500, 800], copper: [1000, 1400], steel: [1400, 3100], stainless: [1800, 2850]
};
const MC = 0.25;
/** Arten, für die die Rechnung stimmt: Schneide am Umfang, volle Nut möglich */
const MILLS: ToolType[] = ["endmill", "bullnose", "ball"];

export interface LoadTool { type: ToolType; diameter: number; flutes: number; fluteLen: number; rpm: number; feedrate: number; stepZ: number }
export type LoadWarn = "rub" | "fast" | "deep" | "flute" | "power";
export interface CutLoad {
  fz: number;                       // mm je Zahn
  q: number;                        // Spanvolumen cm³/min
  watt: [number, number] | null;    // Leistung am Fräser von–bis (nur Metall)
  avail: number;                    // Leistung der Spindel bei dieser Drehzahl (0 = unbekannt)
  warn: LoadWarn[];
}

/**
 * rec = Vorschlag des Schnittdaten-Rechners für dieses Werkzeug und Material (fz mm/Zahn, stepZ mm).
 * null = diese Werkzeugart oder unvollständige Werte: keine Aussage.
 */
export function cutLoad(tl: LoadTool, material: string, rec: { fz: number; stepZ: number }, spindleW = 0, maxRpm = 0): CutLoad | null {
  if (!MILLS.includes(tl.type)) return null;
  const z = Math.max(1, Math.round(tl.flutes));
  if (!(tl.rpm > 0) || !(tl.feedrate > 0) || !(tl.stepZ > 0) || !(tl.diameter > 0)) return null;
  const fz = tl.feedrate / (tl.rpm * z);
  const qmm = tl.stepZ * tl.diameter * tl.feedrate; // mm³/min
  const kc = Object.prototype.hasOwnProperty.call(KC1, material) ? KC1[material] : null;
  const f = Math.pow(Math.max(1e-4, fz * 2 / Math.PI), -MC);
  // N/mm² × mm³/min = N·mm/min → ÷ 60 000 = Watt
  const watt = kc ? [qmm * kc[0] * f / 60000, qmm * kc[1] * f / 60000] as [number, number] : null;
  const avail = spindleW > 0 ? spindleW * (maxRpm > 0 ? Math.min(1, tl.rpm / maxRpm) : 1) : 0;
  const warn: LoadWarn[] = [];
  if (rec.fz > 0 && fz < rec.fz * 0.4) warn.push("rub");
  if (rec.fz > 0 && fz > rec.fz * 2) warn.push("fast");
  if (rec.stepZ > 0 && tl.stepZ > rec.stepZ * 2) warn.push("deep");
  if (tl.fluteLen > 0 && tl.stepZ > tl.fluteLen) warn.push("flute");
  if (watt && avail > 0 && watt[1] > avail) warn.push("power");
  return { fz, q: qmm / 1000, watt, avail, warn };
}
