/**
 * PRINT & CUT: Zeichnung auf einen bedruckten Bogen ausrichten (Rechnung, Tests in tests/printCut.test.ts).
 *
 * Zwei Passmarken in der Zeichnung (a1, a2) und ihre gemessene Lage an der Maschine (b1, b2) ergeben Drehung und Verschiebung.
 * Die Mitte zwischen den Marken wird aufeinander gelegt: Ein Längenfehler (Bogen anders gedruckt oder falsch angefahren)
 * verteilt sich gleichmäßig auf beide Marken. Skaliert wird nicht, die Abweichung wird nur gemeldet.
 */
export interface P { x: number; y: number }

export interface TwoPointFit {
  angle: number;      // Drehung um die Mitte der Marken in der Zeichnung (Bogenmaß, + = gegen den Uhrzeigersinn)
  center: P;          // Mitte der Marken in der Zeichnung
  dx: number; dy: number; // Verschiebung danach
  lengthA: number; lengthB: number;
  lengthError: number; // gemessener minus gezeichneter Abstand
}

/** Marken müssen so weit auseinander liegen, sonst wird die Drehung ungenau (mm) */
export const MIN_MARK_DISTANCE_MM = 10;
/** Weicht der Abstand mehr ab, wurde vermutlich die falsche Marke angefahren */
export const MAX_LENGTH_ERROR_RATIO = 0.05;

export function twoPointFit(a1: P, a2: P, b1: P, b2: P): TwoPointFit {
  const ax = a2.x - a1.x, ay = a2.y - a1.y, bx = b2.x - b1.x, by = b2.y - b1.y;
  const center = { x: (a1.x + a2.x) / 2, y: (a1.y + a2.y) / 2 };
  const lengthA = Math.hypot(ax, ay), lengthB = Math.hypot(bx, by);
  let angle = Math.atan2(by, bx) - Math.atan2(ay, ax);
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return {
    angle, center, lengthA, lengthB, lengthError: lengthB - lengthA,
    dx: (b1.x + b2.x) / 2 - center.x, dy: (b1.y + b2.y) / 2 - center.y
  };
}

/** Punkt der Zeichnung → Lage nach dem Ausrichten */
export function applyFit(f: TwoPointFit, p: P): P {
  const c = Math.cos(f.angle), s = Math.sin(f.angle);
  const x = p.x - f.center.x, y = p.y - f.center.y;
  return { x: f.center.x + x * c - y * s + f.dx, y: f.center.y + x * s + y * c + f.dy };
}

export type FitProblem = "" | "tooClose" | "lengthOff";

/** Kann man mit diesen Werten ausrichten? unitsPerMm = Einheiten der Punkte je mm (Welt-Pixel: 2) */
export function fitProblem(f: TwoPointFit, unitsPerMm = 1): FitProblem {
  const min = MIN_MARK_DISTANCE_MM * unitsPerMm;
  if (f.lengthA < min || f.lengthB < min) return "tooClose";
  if (Math.abs(f.lengthError) > f.lengthA * MAX_LENGTH_ERROR_RATIO) return "lengthOff";
  return "";
}

/** Reihenfolge der Marken: links vor rechts, bei gleicher Spalte unten vor oben. So zeigt das Fenster immer dasselbe an */
export function orderMarks<T extends P>(a: T, b: T): [T, T] {
  if (Math.abs(a.x - b.x) > 1e-6) return a.x < b.x ? [a, b] : [b, a];
  return a.y <= b.y ? [a, b] : [b, a];
}
