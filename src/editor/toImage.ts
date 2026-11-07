/**
 * IN BILD UMWANDELN: Rechnung für die Bildgröße (Tests in tests/toImage.test.ts). Das Malen selbst macht editTools.ts.
 * Ein Bildpunkt entspricht einem Linienabstand beim Gravieren. Bei sehr großen Zeichnungen wird die Auflösung begrenzt.
 */
const MM_TO_PX = 2; // wie MM_TO_PIXEL in shapeTransform.ts

/** Längste Bildseite: darüber wird es für den Speicher und die Vorschau zu viel */
export const MAX_IMAGE_PX = 8000;

export interface RasterPlan {
  pw: number; ph: number;
  dpi: number;         // wirklich verwendete Auflösung
  intervalMm: number;  // Größe eines Bildpunkts = Linienabstand
  limited: boolean;    // musste gegenüber dem Wunsch verkleinert werden
  toPixel: (x: number, y: number) => { x: number; y: number };
}

/** Welt-Rechteck + gewünschte DPI → Bildgröße und Umrechnung Welt-Pixel → Bildpunkt (Bild: Y nach unten) */
export function rasterPlan(b: { minX: number; minY: number; maxX: number; maxY: number }, wantDpi: number, maxPx = MAX_IMAGE_PX): RasterPlan {
  const wMm = Math.max(0.01, (b.maxX - b.minX) / MM_TO_PX), hMm = Math.max(0.01, (b.maxY - b.minY) / MM_TO_PX);
  const longest = Math.max(wMm, hMm);
  let ppm = Math.max(0.1, wantDpi) / 25.4;
  const limited = longest * ppm > maxPx;
  if (limited) ppm = maxPx / longest;
  const pw = Math.max(1, Math.round(wMm * ppm)), ph = Math.max(1, Math.round(hMm * ppm));
  const sx = pw / wMm / MM_TO_PX, sy = ph / hMm / MM_TO_PX;
  return {
    pw, ph, dpi: ppm * 25.4, intervalMm: wMm / pw, limited,
    toPixel: (x, y) => ({ x: (x - b.minX) * sx, y: (b.maxY - y) * sy })
  };
}
