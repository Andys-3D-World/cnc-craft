/**
 * MATERIAL-VORLAGEN FÜR PLASMA (Plasma-Bibliothek → 📋 Material-Vorlagen)
 *
 * Startwerte je Material, Blechdicke und Geräteklasse (40 A / 60 A Luftplasma mit Pilotzündung, typische
 * Hobby-Geräte). Bewusst vorsichtig aus üblichen Schneidtabellen gemittelt – jedes Gerät, jede Düse und jeder
 * Luftdruck ist anders: immer erst ein Testschnitt (Schnittbild, Schlacke unten, Schnittspalt messen).
 * Faustregeln: zu langsam = viel Schlacke unten; zu schnell = Funken nach vorn, Schnitt geht nicht durch.
 */

export type PlasmaMat = "mild" | "stainless" | "alu";
/** Geschwindigkeit mm/min, Schnittspalt, Einstechhöhe, Einstechzeit s, Schneidhöhe, Anfahrlänge (alle mm) */
export interface PlasmaPreset { id: string; mat: PlasmaMat; thick: number; amps: number; speed: number; kerf: number; pierceHeight: number; pierceDelay: number; cutHeight: number; leadIn: number }

const P = (mat: PlasmaMat, amps: number, thick: number, speed: number, kerf: number, pierceDelay: number, leadIn: number): PlasmaPreset =>
  ({ id: `${mat}${amps}_${thick}`, mat, thick, amps, speed, kerf, pierceHeight: thick >= 8 ? 4.5 : 3.8, pierceDelay, cutHeight: 1.5, leadIn });

export const PLASMA_AMPS = [40, 60];

export const PLASMA_PRESETS: PlasmaPreset[] = [
  P("mild", 40, 1, 4000, 1.3, 0.1, 3), P("mild", 40, 2, 2500, 1.5, 0.3, 3), P("mild", 40, 3, 1900, 1.6, 0.4, 4),
  P("mild", 40, 4, 1500, 1.7, 0.6, 4), P("mild", 40, 6, 900, 1.9, 1.0, 5), P("mild", 40, 8, 550, 2.1, 1.5, 6),
  P("mild", 60, 2, 4000, 1.5, 0.2, 3), P("mild", 60, 3, 3000, 1.6, 0.3, 4), P("mild", 60, 4, 2300, 1.7, 0.4, 4),
  P("mild", 60, 6, 1500, 1.9, 0.6, 5), P("mild", 60, 8, 1000, 2.1, 0.9, 6), P("mild", 60, 10, 700, 2.3, 1.2, 6), P("mild", 60, 12, 500, 2.5, 1.6, 7),
  P("stainless", 40, 1, 3200, 1.3, 0.1, 3), P("stainless", 40, 2, 2000, 1.5, 0.3, 3), P("stainless", 40, 3, 1500, 1.6, 0.5, 4),
  P("stainless", 40, 4, 1200, 1.7, 0.7, 4), P("stainless", 40, 6, 700, 1.9, 1.2, 5),
  P("stainless", 60, 2, 3200, 1.5, 0.2, 3), P("stainless", 60, 3, 2400, 1.6, 0.4, 4), P("stainless", 60, 4, 1800, 1.7, 0.5, 4),
  P("stainless", 60, 6, 1200, 1.9, 0.8, 5), P("stainless", 60, 8, 800, 2.1, 1.1, 6), P("stainless", 60, 10, 550, 2.3, 1.5, 6),
  P("alu", 40, 1, 4500, 1.5, 0.1, 3), P("alu", 40, 2, 3000, 1.7, 0.2, 3), P("alu", 40, 3, 2200, 1.8, 0.3, 4),
  P("alu", 40, 4, 1700, 1.9, 0.4, 4), P("alu", 40, 6, 1000, 2.1, 0.7, 5),
  P("alu", 60, 2, 4500, 1.7, 0.2, 3), P("alu", 60, 3, 3400, 1.8, 0.3, 4), P("alu", 60, 4, 2600, 1.9, 0.3, 4),
  P("alu", 60, 6, 1700, 2.1, 0.5, 5), P("alu", 60, 8, 1100, 2.3, 0.8, 6), P("alu", 60, 10, 750, 2.5, 1.1, 6)
];
