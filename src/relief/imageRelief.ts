/**
 * RELIEF AUS EINEM BILD: Helligkeit wird Höhe.
 * Nur Rechnen (Bild ist schon in Grauwerte 0…1 gelesen, Zeile 0 = oben). Eingesetzt von ui/reliefDialog.ts.
 */
import { type HeightField, blur, normalizeTop } from "./heightField.ts";

export interface ImageReliefOpts {
  /** Maße in mm und Raster-Knoten */
  w: number; h: number; nx: number; ny: number;
  /** größte Relief-Tiefe (mm); tiefer als das wird nie gerechnet */
  depth: number;
  /** false: hell = hoch · true: dunkel = hoch */
  invert: boolean;
  /** Weichzeichnen in mm (0 = aus) */
  smooth: number;
  /** Kontrast (1 = neutral): S-Kurve, schwarz und weiß bleiben, wo sie sind */
  contrast: number;
  /** Gamma (1 = neutral): größer hebt die mittleren Töne an */
  gamma: number;
  /** Rand: gleichmäßiger Streifen in mm, dann weicher Übergang in mm */
  border: number;
  fade: number;
  /** Rand läuft zur Oberkante (Relief liegt vertieft im Rahmen) oder zur tiefsten Höhe */
  fadeTo: "top" | "bottom";
}

export const DEFAULT_IMAGE_RELIEF = { depth: 5, invert: false, smooth: 0.3, contrast: 1, gamma: 1, border: 0, fade: 0, fadeTo: "top" as "top" | "bottom" };

/** Grauwerte auf nx × ny Knoten bringen: beim Verkleinern mitteln, sonst weich zwischen den Pixeln. Zeile 0 = oben. */
export function resampleGray(gray: Float32Array, sw: number, sh: number, nx: number, ny: number): Float32Array {
  const out = new Float32Array(nx * ny);
  const kx = (sw - 1) / Math.max(1, nx - 1), ky = (sh - 1) / Math.max(1, ny - 1);
  const rx = kx / 2, ry = ky / 2;
  for (let j = 0; j < ny; j++) {
    const v = j * ky;
    for (let i = 0; i < nx; i++) {
      const u = i * kx;
      if (rx >= 1 || ry >= 1) {
        const x0 = Math.max(0, Math.ceil(u - rx)), x1 = Math.min(sw - 1, Math.floor(u + rx));
        const y0 = Math.max(0, Math.ceil(v - ry)), y1 = Math.min(sh - 1, Math.floor(v + ry));
        let s = 0, c = 0;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { s += gray[y * sw + x]; c++; }
        if (c) { out[j * nx + i] = s / c; continue; }
      }
      const a = Math.min(sw - 1, Math.floor(u)), b = Math.min(sh - 1, Math.floor(v));
      const a1 = Math.min(sw - 1, a + 1), b1 = Math.min(sh - 1, b + 1), fu = u - a, fv = v - b;
      out[j * nx + i] = (gray[b * sw + a] * (1 - fu) + gray[b * sw + a1] * fu) * (1 - fv)
        + (gray[b1 * sw + a] * (1 - fu) + gray[b1 * sw + a1] * fu) * fv;
    }
  }
  return out;
}

/** Schwarz- und Weißpunkt (je 0,2 % der hellsten/dunkelsten Punkte zählen nicht – einzelne Ausreißer verschenken sonst Tiefe) */
function levels(t: Float32Array): [number, number] {
  const bins = new Uint32Array(1024);
  for (let i = 0; i < t.length; i++) bins[Math.max(0, Math.min(1023, Math.floor(t[i] * 1024)))]++;
  const skip = t.length * 0.002;
  let c = 0, lo = 0, hi = 1023;
  for (let k = 0; k < 1024; k++) { c += bins[k]; if (c > skip) { lo = k; break; } }
  c = 0;
  for (let k = 1023; k >= 0; k--) { c += bins[k]; if (c > skip) { hi = k; break; } }
  return [lo / 1024, (hi + 1) / 1024];
}

/** Grauwerte → Höhenfeld. flat = im Bild gibt es keine Helligkeits-Unterschiede */
export function grayToField(gray: Float32Array, sw: number, sh: number, o: ImageReliefOpts): { field: HeightField; flat: boolean } {
  const { nx, ny } = o;
  const t = resampleGray(gray, sw, sh, nx, ny);
  const dx = o.w / (nx - 1), dy = o.h / (ny - 1);
  if (o.invert) for (let i = 0; i < t.length; i++) t[i] = 1 - t[i];
  if (o.smooth > 0) blur(t, nx, ny, o.smooth / dx, o.smooth / dy);
  // Ganzen Bereich ausnutzen: dunkelster Punkt = volle Tiefe, hellster = Oberkante
  const [lo, hi] = levels(t);
  let flat = hi - lo < 2 / 1024 + 1e-6;
  const g = 1 / Math.max(0.05, o.gamma), c = Math.max(0.05, o.contrast);
  for (let i = 0; i < t.length; i++) {
    let v = flat ? 1 : Math.max(0, Math.min(1, (t[i] - lo) / (hi - lo)));
    if (g !== 1) v = Math.pow(v, g);
    if (c !== 1 && v > 0 && v < 1) { const p = Math.pow(v, c), q = Math.pow(1 - v, c); v = p / (p + q); }
    t[i] = v;
  }
  // Rand
  const band = Math.max(0, o.border), fade = Math.max(0, o.fade);
  if (band + fade > 0) {
    const target = o.fadeTo === "bottom" ? 0 : 1;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const e = Math.min(i * dx, (nx - 1 - i) * dx, j * dy, (ny - 1 - j) * dy);
      if (e >= band + fade) continue;
      let k = 0;
      if (e > band && fade > 0) { const u = (e - band) / fade; k = u * u * (3 - 2 * u); }
      t[j * nx + i] = target + (t[j * nx + i] - target) * k;
    }
  }
  // Höhe: unterste Zeile im Feld = unterste Bildzeile (nicht gespiegelt)
  const z = new Float32Array(nx * ny), D = Math.max(0, o.depth);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = (t[(ny - 1 - j) * nx + i] - 1) * D;
  flat = normalizeTop(z) || flat;
  return { field: { nx, ny, w: o.w, h: o.h, z }, flat };
}
