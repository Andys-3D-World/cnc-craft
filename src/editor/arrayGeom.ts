/**
 * ARRAY: Rechnung für Raster- und Kreis-Anordnung (ohne Oberfläche, mit Tests in tests/arrayGeom.test.ts).
 * Einheiten sind egal, solange alle Werte dieselbe haben. Das Original zählt immer mit und liegt an Stelle (0, 0)
 * bzw. beim Winkel 0: geliefert werden nur die Kopien.
 */
export interface Offset { col: number; row: number; dx: number; dy: number }
export interface PolarPlacement { index: number; angle: number; dx: number; dy: number }

/** Abstand von Kopie zu Kopie: "gap" = freier Raum zwischen den Teilen, "pitch" = Mitte zu Mitte */
export function gridStep(mode: "gap" | "pitch", size: number, value: number): number {
  return mode === "gap" ? size + value : value;
}

/** Alle Kopien eines Rasters: nach rechts und oben, negative Schritte gehen nach links und unten */
export function gridOffsets(cols: number, rows: number, stepX: number, stepY: number): Offset[] {
  const out: Offset[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (col === 0 && row === 0) continue;
      out.push({ col, row, dx: col * stepX, dy: row * stepY });
    }
  }
  return out;
}

/** Winkelschritt: voller Kreis = gleichmäßig verteilt ohne Doppel am Ende, Teilkreis = von Anfang bis Ende */
export function polarStep(count: number, totalRad: number): number {
  if (count < 2) return 0;
  return Math.abs(totalRad) >= Math.PI * 2 - 1e-9 ? totalRad / count : totalRad / (count - 1);
}

/**
 * Alle Kopien um einen Mittelpunkt. count zählt das Original mit. dx/dy = Verschiebung des Bezugspunkts `from`
 * (gebraucht, wenn die Kopien sich nicht mitdrehen). Positiver Winkel = gegen den Uhrzeigersinn.
 */
export function polarPlacements(count: number, cx: number, cy: number, from: { x: number; y: number }, totalRad: number): PolarPlacement[] {
  const step = polarStep(count, totalRad);
  const out: PolarPlacement[] = [];
  for (let i = 1; i < count; i++) {
    const a = step * i, c = Math.cos(a), s = Math.sin(a);
    const rx = from.x - cx, ry = from.y - cy;
    out.push({ index: i, angle: a, dx: cx + rx * c - ry * s - from.x, dy: cy + rx * s + ry * c - from.y });
  }
  return out;
}
