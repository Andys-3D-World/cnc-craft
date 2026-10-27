/**
 * GEWINDE FRÄSEN (Innen- und Außengewinde mit dem Gewindefräser) – Bahn wie in Fusion 360
 *
 * Der Fräser fährt eine Schraubenlinie (G2/G3 mit Z): pro Umdrehung genau eine Steigung.
 * Metrisches ISO-Gewinde (60°): Innengewinde – Zahnspitzen bis zum Nenn-Ø D;
 * Außengewinde – Zahnspitzen bis zum Kern-Ø d3 = D − 1,22687 · P.
 * Immer Gleichlauf (Spindel rechts, M3):
 *   innen G3 – Rechtsgewinde von unten nach oben, Linksgewinde von oben nach unten
 *   außen G2 – Rechtsgewinde von oben nach unten, Linksgewinde von unten nach oben
 * Ein- und Ausfahren im Bogen, tangential und schon mit Steigung (der Zahn bleibt im Gewindegang):
 *   innen ein Halbkreis von der Lochmitte aus, außen ein Viertelkreis von außen.
 * Mehrere Durchgänge: radial gleichmäßig vom ersten Kontakt mit dem Material bis zur vollen Tiefe,
 * auf Wunsch ein Leerdurchgang (gleiche Bahn noch einmal – glättet die Flanken).
 * Der Vorschub gilt an der Schneide – der Mittelpunkt des Fräsers fährt innen langsamer, außen schneller.
 * Einzahn-Fräser schneiden jede Steigung: dann kommt die Steigung aus der ISO-Tabelle (M8 → 1,25).
 */

export interface ThreadParams {
  cx: number; cy: number;   // Mitte des Kreises (Maschinen-Koordinaten, mm)
  holeD: number;            // gezeichneter Kreis-Ø (Kernloch bzw. Bolzen)
  internal: boolean;
  D: number;                // Nenn-Ø (0 = automatisch)
  pitch: number;            // Steigung (0 = automatisch: Werkzeug bzw. ISO-Regelgewinde)
  toolPitch: number;        // Steigung des Werkzeugs (mehrzahnig; 0 = Einzahn, schneidet jede Steigung)
  toolD: number;            // Ø über die Zahnspitzen
  length: number;           // Gewindelänge (positiv, ab Oberkante Z0)
  left: boolean;            // Linksgewinde
  passes?: number;          // radiale Durchgänge (1 = volle Tiefe auf einmal)
  springPass?: boolean;     // Leerdurchgang am Ende
  feed: number;             // Vorschub an der Schneide (mm/min)
  plunge: number;           // senkrechte Bewegungen im Loch (mm/min)
  safeZ: number;
}

export interface ThreadInfo {
  cx: number; cy: number; D: number; P: number; internal: boolean; left: boolean; length: number;
  majorD: number; minorD: number; // Gewinde im Material: außen Spitzen, innen Grund (für die 3D-Ansicht)
}

export type ThreadResult =
  | { ok: true; lines: string[]; D: number; P: number; turns: number; info: ThreadInfo }
  | { ok: false; why: "pitch" | "length" | "toolTooBig" | "toolNoFit" | "small" };

/** ISO-Regelgewinde (metrisch grob): Nenn-Ø → Steigung */
export const ISO_COARSE: [number, number][] = [
  [1.4, 0.3], [1.6, 0.35], [2, 0.4], [2.5, 0.45], [3, 0.5], [3.5, 0.6], [4, 0.7], [5, 0.8], [6, 1], [7, 1],
  [8, 1.25], [10, 1.5], [12, 1.75], [14, 2], [16, 2], [18, 2.5], [20, 2.5], [22, 2.5], [24, 3], [27, 3],
  [30, 3.5], [33, 3.5], [36, 4], [42, 4.5], [48, 5],
];

const f3 = (v: number) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3);
const nearest = <T>(list: T[], d: (x: T) => number): T => list.reduce((a, b) => (d(b) < d(a) ? b : a));

/**
 * Nenn-Ø und Steigung festlegen. Reihenfolge: eingegebene Werte, Steigung des Werkzeugs,
 * sonst das passende ISO-Regelgewinde (innen über das Kernloch D − P, außen über den Bolzen-Ø).
 */
export function resolveThread(p: Pick<ThreadParams, "D" | "holeD" | "pitch" | "toolPitch" | "internal">): { D: number; P: number } {
  let P = p.pitch > 0 ? p.pitch : p.toolPitch > 0 ? p.toolPitch : 0;
  let D = p.D;
  if (!(D > 0)) {
    if (P > 0) D = p.internal ? Math.round((p.holeD + P) * 2) / 2 : p.holeD;
    else D = nearest(ISO_COARSE, ([d, s]) => Math.abs((p.internal ? d - s : d) - p.holeD))[0];
  }
  if (!(P > 0)) P = nearest(ISO_COARSE, ([d]) => Math.abs(d - D))[1];
  return { D, P };
}

/** Nenn-Ø (für ältere Aufrufe/Tests) */
export function threadDiameter(p: { D: number; holeD: number; pitch: number; internal: boolean }): number {
  return resolveThread({ ...p, toolPitch: 0 }).D;
}

export function threadPath(p: ThreadParams): ThreadResult {
  const { D, P } = resolveThread(p);
  if (!(P > 0)) return { ok: false, why: "pitch" };
  if (!(p.length > 0)) return { ok: false, why: "length" };
  const Rt = p.toolD / 2;
  if (!(D > P)) return { ok: false, why: "small" };
  const minor = D - 1.22687 * P;
  // Bahnradius der Fräsermitte bei voller Tiefe
  const Rf = p.internal ? D / 2 - Rt : minor / 2 + Rt;
  if (p.internal && Rf < 0.05) return { ok: false, why: "toolTooBig" };
  // innen muss der Fräser ins Kernloch passen
  if (p.internal && p.toolD > p.holeD + 1e-6) return { ok: false, why: "toolNoFit" };

  // Radien der Durchgänge: vom ersten Kontakt mit dem Material bis zur vollen Tiefe
  const n = Math.max(1, Math.min(10, Math.round(p.passes || 1)));
  const R0 = p.internal ? Math.max(0.05, Math.min(Rf, p.holeD / 2 - Rt)) : Math.max(Rf, p.holeD / 2 + Rt);
  const radii = Array.from({ length: n }, (_, k) => R0 + (Rf - R0) * (k + 1) / n);
  if (p.springPass) radii.push(Rf);

  const up = p.internal !== p.left;              // innen rechts / außen links: von unten nach oben
  const arc = p.internal ? "G3" : "G2";
  const q = p.internal ? 0.5 : 0.25;             // Ein-/Ausfahrbogen: halbe bzw. Viertel-Umdrehung
  const dz = up ? P : -P;
  // so viele volle Umdrehungen, dass die Bahn genau bei −Länge beginnt bzw. endet und oben über Z0 reicht
  const turns = Math.max(1, Math.ceil((up ? p.length - q * P : p.length - 2 * q * P) / P - 1e-9));
  const zStart = up ? -p.length : -p.length + 2 * q * P + turns * P;

  const L: string[] = [];
  L.push(`G0 Z${f3(p.safeZ)}`);
  radii.forEach((R, k) => {
    const edge = p.internal ? R + Rt : Math.max(0.1, R - Rt);
    const feed = Math.max(1, Math.round(p.feed * R / edge));
    let z = zStart;
    if (p.internal) {
      // Lochmitte: einmal mit Eilgang hinüber, dann im leeren Loch senkrecht auf Starthöhe
      if (k === 0) L.push(`G0 X${f3(p.cx)} Y${f3(p.cy)}`);
      L.push(`G1 Z${f3(z)} F${Math.round(p.plunge)}`);
      // Halbkreis (Mitte bei R/2) von der Lochmitte tangential auf die Bahn
      z += q * dz;
      L.push(`G3 X${f3(p.cx + R)} Y${f3(p.cy)} Z${f3(z)} I${f3(R / 2)} J0 F${feed}`);
    } else {
      const Rl = Math.max(1, Rt);                  // Bogenradius außen
      const ax = p.cx + R + Rl;
      L.push(`G0 Z${f3(p.safeZ)}`);
      L.push(`G0 X${f3(ax)} Y${f3(p.cy + Rl)}`);
      L.push(`G1 Z${f3(z)} F${Math.round(p.plunge)}`);
      z += q * dz;
      L.push(`G3 X${f3(p.cx + R)} Y${f3(p.cy)} Z${f3(z)} I0 J${f3(-Rl)} F${feed}`);
    }
    for (let i = 0; i < turns; i++) {
      z += dz;
      L.push(`${arc} X${f3(p.cx + R)} Y${f3(p.cy)} Z${f3(z)} I${f3(-R)} J0`);
    }
    z += q * dz;
    if (p.internal) {
      L.push(`G3 X${f3(p.cx)} Y${f3(p.cy)} Z${f3(z)} I${f3(-R / 2)} J0`);
    } else {
      const Rl = Math.max(1, Rt);
      L.push(`G3 X${f3(p.cx + R + Rl)} Y${f3(p.cy - Rl)} Z${f3(z)} I${f3(Rl)} J0`);
    }
  });
  L.push(`G0 Z${f3(p.safeZ)}`);
  const info: ThreadInfo = {
    cx: p.cx, cy: p.cy, D, P, internal: p.internal, left: p.left, length: p.length,
    majorD: p.internal ? D : Math.min(D, p.holeD), minorD: p.internal ? Math.max(p.holeD, minor) : minor,
  };
  return { ok: true, lines: L, D, P, turns, info };
}
