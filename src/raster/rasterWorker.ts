/**
 * HINTERGRUND-THREAD für die Bildgravur: Graustufen auf Rastergröße bringen, Bild verbessern (Grafikkarte), rastern
 * (siehe dither.ts), Maske anwenden und Vorschau-Pixel bauen (burnImage.ts). Das Hauptfenster muss das Bild nur noch
 * anzeigen – so friert es weder nach dem Skalieren eines großen Fotos noch beim Regler-Ziehen im Gravur-Dialog ein.
 */
import { resample, rasterize } from "./dither";
import { applyAdjustAsync } from "./gpuAdjust";
import { maskBurn, burnPixels } from "./burnImage";

self.onmessage = async (ev: MessageEvent) => {
  const { seq, base, sw, sh, gw, gh, adjust, raster, mask } = ev.data;
  try {
    // Nachbessern auf der Grafikkarte (OffscreenCanvas mit WebGL2), wenn der Thread sie bekommt – sonst CPU
    const g = await applyAdjustAsync(resample(base, sw, sh, gw, gh), gw, gh, adjust);
    const burn = rasterize(g, gw, gh, raster);
    // Maske + Vorschau-Pixel auch hier (OffscreenCanvas) – dann bleibt im Hauptfenster fast nichts zu tun
    const masked = !mask?.length || maskBurn(burn, gw, gh, mask);
    if (masked) {
      const px = burnPixels(burn);
      (self as any).postMessage({ seq, ok: true, burn, masked: true, px }, [burn.buffer, px.buffer]);
    } else {
      (self as any).postMessage({ seq, ok: true, burn, masked: false }, [burn.buffer]);
    }
  } catch (e) {
    (self as any).postMessage({ seq, ok: false, error: String(e) });
  }
};
