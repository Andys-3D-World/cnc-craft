/**
 * GLEICHMÄSSIG VERTEILEN: gleiche Lücken zwischen den Teilen (Rechnung, Tests in tests/distribute.test.ts).
 * Das erste und das letzte Teil bleiben stehen, alle dazwischen rücken so, dass jede Lücke gleich groß wird.
 */
export interface Extent { min: number; max: number }

/** Verschiebung je Teil (in der Reihenfolge der Eingabe) und die Lücke; null = weniger als 3 Teile */
export function distributeDeltas(items: Extent[]): { deltas: number[]; gap: number } | null {
  if (items.length < 3) return null;
  const order = items.map((e, i) => ({ ...e, i })).sort((a, b) => a.min - b.min || a.max - b.max);
  const first = order[0];
  // Rechter Rand: das am weitesten reichende Teil bleibt am Ende
  let lastAt = order.length - 1;
  for (let k = 0; k < order.length; k++) if (order[k].max > order[lastAt].max) lastAt = k;
  const last = order[lastAt];
  const middle = order.filter((_, k) => k !== 0 && k !== lastAt);
  const used = order.reduce((n, e) => n + (e.max - e.min), 0);
  const gap = (last.max - first.min - used) / (order.length - 1);
  const deltas = items.map(() => 0);
  let x = first.max + gap;
  for (const e of middle) {
    deltas[e.i] = x - e.min;
    x += e.max - e.min + gap;
  }
  return { deltas, gap };
}
