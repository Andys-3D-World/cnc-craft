/**
 * HINTERGRUND-THREAD für die Bildgravur: Graustufen auf Rastergröße bringen, Bild verbessern, rastern
 * (siehe dither.ts). Die Maske wird danach im Hauptfenster angewendet (braucht eine Zeichenfläche).
 * So friert das Fenster nach dem Skalieren eines großen Fotos nicht ein.
 */
import { resample, applyAdjust, rasterize } from "./dither";

self.onmessage = (ev: MessageEvent) => {
  const { seq, base, sw, sh, gw, gh, adjust, raster } = ev.data;
  try {
    const burn = rasterize(applyAdjust(resample(base, sw, sh, gw, gh), gw, gh, adjust), gw, gh, raster);
    (self as any).postMessage({ seq, ok: true, burn }, [burn.buffer]);
  } catch (e) {
    (self as any).postMessage({ seq, ok: false, error: String(e) });
  }
};
