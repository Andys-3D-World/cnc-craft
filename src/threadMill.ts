/**
 * GEWINDE FRÄSEN (Innen- und Außengewinde mit dem Gewindefräser)
 *
 * Der Fräser fährt eine Schraubenlinie (G2/G3 mit Z): pro Umdrehung genau eine Steigung.
 * Metrisches ISO-Gewinde (60°): Innengewinde – Zahnspitzen bis zum Nenn-Ø D;
 * Außengewinde – Zahnspitzen bis zum Kern-Ø d3 = D − 1,22687 · P.
 * Immer Gleichlauf (Spindel rechts, M3):
 *   innen G3 – Rechtsgewinde von unten nach oben, Linksgewinde von oben nach unten
 *   außen G2 – Rechtsgewinde von oben nach unten, Linksgewinde von unten nach oben
 * Ein- und Ausfahren: gerade zur Mitte (innen) bzw. von außen (außen) mit Eintauch-Vorschub.
 * Der Vorschub gilt an der Schneide – der Mittelpunkt des Fräsers fährt innen langsamer, außen schneller.
 */

export interface ThreadParams {
  cx: number; cy: number;   // Mitte des Kreises (Maschinen-Koordinaten, mm)
  holeD: number;            // gezeichneter Kreis-Ø (Kernloch bzw. Bolzen)
  internal: boolean;
  D: number;                // Nenn-Ø (0 = aus dem Kreis: innen Kernloch + Steigung, außen Kreis-Ø)
  pitch: number;            // Steigung
  toolD: number;            // Ø über die Zahnspitzen
  length: number;           // Gewindelänge (positiv, ab Oberkante Z0)
  left: boolean;            // Linksgewinde
  feed: number;             // Vorschub an der Schneide (mm/min)
  plunge: number;           // Ein-/Ausfahren (mm/min)
  safeZ: number;
}

export type ThreadResult =
  | { ok: true; lines: string[]; D: number; turns: number }
  | { ok: false; why: "pitch" | "length" | "toolTooBig" | "toolNoFit" | "small" };

const f3 = (v: number) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3);

/** Nenn-Ø: eingegeben oder aus dem Kreis (innen: Kernloch + P, auf 0,5 mm gerundet – M8: 6,8 + 1,25 → 8) */
export function threadDiameter(p: Pick<ThreadParams, "D" | "holeD" | "pitch" | "internal">): number {
  if (p.D > 0) return p.D;
  return p.internal ? Math.round((p.holeD + p.pitch) * 2) / 2 : p.holeD;
}

export function threadPath(p: ThreadParams): ThreadResult {
  const P = p.pitch;
  if (!(P > 0)) return { ok: false, why: "pitch" };
  if (!(p.length > 0)) return { ok: false, why: "length" };
  const D = threadDiameter(p);
  const Rt = p.toolD / 2;
  if (!(D > P)) return { ok: false, why: "small" };
  // Bahnradius der Fräsermitte
  const R = p.internal ? D / 2 - Rt : (D - 1.22687 * P) / 2 + Rt;
  if (p.internal && R < 0.05) return { ok: false, why: "toolTooBig" };
  // innen muss der Fräser ins Kernloch passen
  if (p.internal && p.toolD > p.holeD + 1e-6) return { ok: false, why: "toolNoFit" };

  const turns = Math.ceil(p.length / P - 1e-9);
  const up = p.internal !== p.left;              // innen rechts / außen links: von unten nach oben
  const arc = p.internal ? "G3" : "G2";
  // so beginnen, dass die Bahn genau bei −Länge endet bzw. beginnt (nicht tiefer als gewünscht)
  const zBottom = -p.length, zTop = -p.length + turns * P;
  const zStart = up ? zBottom : zTop;
  const dz = up ? P : -P;

  const edgeR = p.internal ? D / 2 : (D - 1.22687 * P) / 2;
  const feed = Math.max(1, Math.round(p.feed * R / edgeR));
  const sx = p.cx + R, sy = p.cy;                 // Startpunkt auf der Bahn (rechts von der Mitte)
  // außen: von weiter außen anfahren (Fräser-Ø + 2 mm Luft)
  const ax = p.internal ? p.cx : p.cx + R + Rt + 2;

  const L: string[] = [];
  L.push(`G0 Z${f3(p.safeZ)}`);
  L.push(`G0 X${f3(ax)} Y${f3(sy)}`);
  L.push(`G0 Z${f3(Math.min(p.safeZ, zStart + 1))}`);
  L.push(`G1 Z${f3(zStart)} F${Math.round(p.plunge)}`);
  L.push(`G1 X${f3(sx)} Y${f3(sy)} F${Math.round(p.plunge)}`);
  let z = zStart;
  for (let i = 0; i < turns; i++) {
    z += dz;
    L.push(`${arc} X${f3(sx)} Y${f3(sy)} Z${f3(z)} I${f3(-R)} J0${i === 0 ? ` F${feed}` : ""}`);
  }
  L.push(`G1 X${f3(ax)} Y${f3(sy)} F${Math.round(p.plunge)}`);
  L.push(`G0 Z${f3(p.safeZ)}`);
  return { ok: true, lines: L, D, turns };
}
