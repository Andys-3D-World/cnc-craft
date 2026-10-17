/**
 * KAMERABILD UNTER DER ZEICHNUNG (wird von render.ts gezeichnet)
 *
 * camera.ts legt hier das fertig entzerrte Bild ab (Bett von oben, links unten = Nullpunkt).
 * render.ts zeichnet es direkt nach der Bettfläche – also unter Raster, Formen und Fräsbahnen.
 * Eigenes kleines Modul, damit render.ts nichts von Kamera, WebGL und Fenstern wissen muss.
 */
export const cameraUnderlay: { image: CanvasImageSource | null; on: boolean; opacity: number } = {
  image: null,
  on: false,
  opacity: 0.85
};

/** In render.ts: Bild in das Bett-Rechteck (Bildschirm-Pixel) zeichnen */
export function drawCameraUnderlay(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const u = cameraUnderlay;
  if (!u.on || !u.image || w <= 0 || h <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0.05, Math.min(1, u.opacity));
  ctx.imageSmoothingEnabled = true;
  try { ctx.drawImage(u.image, x, y, w, h); } catch { /* Bild noch nicht bereit */ }
  ctx.restore();
}
