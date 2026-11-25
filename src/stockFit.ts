/**
 * PASST DER AUFTRAG INS ROHTEIL? (reine Rechnung, Tests in tests/stockFit.test.ts)
 * Nur Warnungen – am G-Code ändert sich nichts.
 */
export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface StockRect { x: number; y: number; w: number; h: number }

/** Wie viele Umrisse ragen über das Rohteil hinaus */
export function countOutside(boxes: Box[], s: StockRect, tol = 0.05): number {
  return boxes.filter(b => b.x0 < s.x - tol || b.y0 < s.y - tol || b.x1 > s.x + s.w + tol || b.y1 > s.y + s.h + tol).length;
}

/**
 * Tiefste Z-Stelle eines Fräsprogramms (0 = nie unter der Oberseite). Zählt nicht: Antasten (G38), Maschinen-
 * Koordinaten (G53), Nullpunkt-Befehle (G10, G92) und relative Wege (G91).
 */
export function deepestZ(gcode: string): number {
  let min = 0, rel = false;
  for (const raw of gcode.split("\n")) {
    const l = raw.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").toUpperCase();
    if (/G91(?![.\d])/.test(l)) rel = true;
    if (/G90(?![.\d])/.test(l)) rel = false;
    if (rel || /G(38|53|10|92|28|30)(?!\d)/.test(l)) continue;
    const m = l.match(/Z\s*(-?\d*\.?\d+)/);
    if (m) min = Math.min(min, parseFloat(m[1]));
  }
  return min;
}
