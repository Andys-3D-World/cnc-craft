/**
 * DREHBANK: gängige Werkzeuge zum Übernehmen. Geometrie nach ISO (Plattenform = Spitzenwinkel, Halter = Einstellwinkel),
 * Zustellung und Vorschub sind vorsichtige Startwerte für kleine Drehbänke – die Packung der Platte geht vor.
 */
import type { LatheTool } from "./turn";

export interface LathePreset { group: "rough" | "finish" | "neutral" | "left" | "hss" | "groove" | "drill"; name: string; tool: Omit<LatheTool, "id" | "num" | "name"> }
const turn = (group: LathePreset["group"], name: string, hand: LatheTool["hand"], kappa: number, eps: number, nose: number, ap: number, feed: number, vcPct = 100): LathePreset =>
  ({ group, name, tool: { type: "turn", hand, nose, kappa, eps, width: 0, dia: 0, ap, feed, vcPct } });
const groove = (name: string, width: number, ap: number, feed: number, vcPct = 40): LathePreset => ({ group: "groove", name, tool: { type: "groove", hand: "N", nose: 0, kappa: 90, eps: 0, width, dia: 0, ap, feed, vcPct } });
const drill = (dia: number, vcPct = 25): LathePreset => ({ group: "drill", name: `HSS ${dia} mm`, tool: { type: "drill", hand: "N", nose: 0, kappa: 90, eps: 0, width: 0, dia, ap: Math.max(1, Math.round(dia * 0.5 * 10) / 10), feed: Math.round(Math.max(0.02, Math.min(0.12, dia * 0.01)) * 100) / 100, vcPct } });

export const LATHE_PRESETS: LathePreset[] = [
  turn("rough", "SCLCR · CCMT 060204", "R", 95, 80, 0.4, 0.5, 0.1), turn("rough", "SCLCR · CCMT 09T304", "R", 95, 80, 0.4, 0.8, 0.12), turn("rough", "SCLCR · CCMT 09T308", "R", 95, 80, 0.8, 1, 0.15),
  turn("rough", "MWLNR · WNMG 080404", "R", 95, 80, 0.4, 1, 0.15), turn("rough", "MWLNR · WNMG 080408", "R", 95, 80, 0.8, 1.2, 0.18), turn("rough", "STGCR · TCMT 110204", "R", 91, 60, 0.4, 0.5, 0.1),
  turn("finish", "SDJCR · DCMT 070202", "R", 93, 55, 0.2, 0.25, 0.05, 120), turn("finish", "SDJCR · DCMT 070204", "R", 93, 55, 0.4, 0.3, 0.08, 120), turn("finish", "SDJCR · DCMT 11T304", "R", 93, 55, 0.4, 0.4, 0.08, 120),
  turn("finish", "SVJCR · VCMT 110302", "R", 93, 35, 0.2, 0.2, 0.05, 120), turn("finish", "SVJCR · VCMT 110304", "R", 93, 35, 0.4, 0.25, 0.07, 120), turn("finish", "SCLCR · CCGT 060202 (Alu)", "R", 95, 80, 0.2, 0.3, 0.06, 130),
  turn("neutral", "SDNCN · DCMT 070204", "N", 62.5, 55, 0.4, 0.3, 0.07, 110), turn("neutral", "SVVCN · VCMT 110304", "N", 72.5, 35, 0.4, 0.2, 0.06, 110), turn("neutral", "SSDCN · SCMT 09T304", "N", 45, 90, 0.4, 0.4, 0.1),
  turn("left", "SCLCL · CCMT 060204", "L", 95, 80, 0.4, 0.5, 0.1), turn("left", "SDJCL · DCMT 070204", "L", 93, 55, 0.4, 0.3, 0.08, 120),
  turn("hss", "HSS 80°", "R", 93, 80, 0.3, 0.3, 0.06, 35), turn("hss", "HSS 60°", "N", 60, 60, 0.2, 0.15, 0.04, 35), turn("hss", "HSS 80° L", "L", 93, 80, 0.3, 0.3, 0.06, 35),
  groove("MGMN 150 · 1.5 mm", 1.5, 0.6, 0.03), groove("MGMN 200 · 2 mm", 2, 0.8, 0.03), groove("MGMN 300 · 3 mm", 3, 1, 0.04), groove("MGMN 400 · 4 mm", 4, 1, 0.05), groove("HSS 2 mm", 2, 0.4, 0.02, 20),
  ...[3, 4, 5, 6, 8, 10, 12].map(d => drill(d)),
];
