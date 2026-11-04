/**
 * FRÄSRICHTUNG je Bearbeitung: Gleichlauf oder Gegenlauf (reine Logik)
 *
 * Bezug: Spindel dreht von oben gesehen im Uhrzeigersinn (M3). „Drehrichtung umkehren“ (spindleDir.ts) gleicht nur eine
 * falsche Verkabelung aus – der Fräser dreht auch dann rechts herum, also ändert sich hier nichts.
 *
 * Gleichlauf: der Fräser „rollt“ am Material entlang wie ein Rad, das Material liegt rechts von der Fahrtrichtung.
 *   außen um das Teil:    im Uhrzeigersinn     (G2)
 *   innen (Loch, Tasche): gegen den Uhrzeigersinn (G3)
 * Gegenlauf: genau umgekehrt.
 *
 * "" (Standard) heißt: wie es bisher war – nichts wird umgedreht. Das ist NICHT überall dasselbe:
 * Linienzüge liefen außen gegen und innen im Uhrzeigersinn (Gegenlauf), Kreise ohne Stege immer G2
 * (außen Gleichlauf, innen Gegenlauf). So bleiben bestehende Projekte und Einstellwerte unverändert.
 */
export type MillDir = "" | "climb" | "conventional";
/** Wo liegt der Fräser? outside = außerhalb des Fertigteils, inside = in Loch oder Tasche */
export type MillSide = "outside" | "inside";
interface Pt { x: number; y: number }

export function cleanMillDir(v: unknown): MillDir {
  return v === "climb" || v === "conventional" ? v : "";
}

/** Soll die Bahn gegen den Uhrzeigersinn laufen? null = Standard, nichts vorgeben */
export function wantsCcw(side: MillSide, dir: MillDir): boolean | null {
  if (!dir) return null;
  return (side === "inside") === (dir === "climb");
}

function area(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return a / 2;
}

/** Geschlossene Bahn in die gewünschte Richtung drehen; sie fängt weiter am selben Punkt an (Lage der Haltestege bleibt) */
export function orientLoop<T extends Pt>(loop: T[], side: MillSide, dir: MillDir): T[] {
  const ccw = wantsCcw(side, dir);
  if (ccw === null || loop.length < 3) return loop;
  return (area(loop) > 0) === ccw ? loop : [loop[0], ...loop.slice(1).reverse()];
}

/** Befehl für einen Vollkreis; fallback = bisheriger Befehl bei Standard */
export function circleCmd(side: MillSide, dir: MillDir, fallback: "G2" | "G3" = "G2"): "G2" | "G3" {
  const ccw = wantsCcw(side, dir);
  return ccw === null ? fallback : ccw ? "G3" : "G2";
}

/** Muss ein Bogen mit dieser Richtung (clockwise) rückwärts gefahren werden? */
export function arcNeedsReverse(clockwise: boolean, side: MillSide, dir: MillDir): boolean {
  const ccw = wantsCcw(side, dir);
  return ccw !== null && ccw === clockwise;
}
