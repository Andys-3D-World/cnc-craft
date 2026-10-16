/**
 * Berechnet Mittelpunkt, Radius sowie Start- und Endwinkel eines Kreises durch 3 Punkte.
 * Gibt null zurück, wenn die Punkte (fast) auf einer Geraden liegen.
 */
export function berechne3PunktBogen(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 0.1) return null;

  const cx = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
  const cy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;

  return {
    cx,
    cy,
    r: Math.hypot(x1 - cx, y1 - cy),
    start: Math.atan2(y1 - cy, x1 - cx),
    end: Math.atan2(y2 - cy, x2 - cx)
  };
}
