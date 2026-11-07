/**
 * ÄHNLICHES AUSWÄHLEN: offene Formen, gleiche Ebene, gleiche Größe (Rechnung, Tests in tests/selectSimilar.test.ts).
 * Teile = Gruppe oder einzelne Form. Größe wird am Teil gemessen, damit ein Text oder eine Gruppe als Ganzes vergleicht.
 */
/** Toleranz beim Größenvergleich in mm */
export const SIZE_TOL_MM = 0.1;

export function isOpenShape(s: any): boolean {
  if (s.type === "line" || s.type === "arc") return true;
  return s.type === "polyline" && !s.closed;
}

export interface UnitSize { key: string; w: number; h: number }

/** Gleiche Maße, auch um 90° gedreht */
export function sameSize(a: UnitSize, b: UnitSize, tol: number): boolean {
  const eq = (x: number, y: number) => Math.abs(x - y) <= tol;
  return (eq(a.w, b.w) && eq(a.h, b.h)) || (eq(a.w, b.h) && eq(a.h, b.w));
}

/** Schlüssel aller Teile mit derselben Größe wie eines der Bezugs-Teile */
export function unitsOfSameSize(all: UnitSize[], refKeys: Set<string>, tol: number): Set<string> {
  const refs = all.filter(u => refKeys.has(u.key));
  return new Set(all.filter(u => refs.some(r => sameSize(u, r, tol))).map(u => u.key));
}

/** Alle Formen, deren Schlüssel einer der Bezugs-Formen gleicht */
export function shapesWithSameKey<T>(all: T[], refs: T[], keyOf: (s: T) => string): T[] {
  const keys = new Set(refs.map(keyOf));
  return all.filter(s => keys.has(keyOf(s)));
}
