/**
 * BILDGRAVUR – Maske anwenden und Vorschau-Pixel bauen.
 * Ohne Oberflächen-Abhängigkeiten: läuft im Hauptfenster und im Hintergrund-Thread (rasterWorker.ts).
 */

/** Zeichenfläche zum Rechnen: im Hintergrund-Thread OffscreenCanvas, sonst ein normales canvas-Element */
function scratchCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined") { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
  return null;
}

/**
 * Alles außerhalb der Maske löschen (Maske über eine Zeichenfläche füllen – schnell auch bei vielen Punkten).
 * false = keine Zeichenfläche verfügbar (dann muss es das Hauptfenster machen).
 */
export function maskBurn(burn: Float32Array, gw: number, gh: number, rings: { u: number; v: number }[][]): boolean {
  const c = scratchCanvas(gw, gh);
  const ctx = c?.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return false;
  ctx.beginPath();
  for (const r of rings) r.forEach((q, i) => (i ? ctx.lineTo(q.u * gw, (1 - q.v) * gh) : ctx.moveTo(q.u * gw, (1 - q.v) * gh)));
  ctx.fillStyle = "#000";
  ctx.fill("evenodd");
  const a = ctx.getImageData(0, 0, gw, gh).data;
  for (let i = 0; i < burn.length; i++) if (a[i * 4 + 3] < 128) burn[i] = 0;
  return true;
}

/** Vorschau-Pixel: gebrannt = dunkelbraun, frei = helles Holz */
export function burnPixels(burn: Float32Array): Uint8ClampedArray<ArrayBuffer> {
  const px = new Uint8ClampedArray(burn.length * 4);
  const L = [236, 222, 196], D = [52, 36, 26];
  for (let i = 0; i < burn.length; i++) {
    const b = burn[i];
    px[i * 4] = L[0] + (D[0] - L[0]) * b;
    px[i * 4 + 1] = L[1] + (D[1] - L[1]) * b;
    px[i * 4 + 2] = L[2] + (D[2] - L[2]) * b;
    px[i * 4 + 3] = 255;
  }
  return px;
}
