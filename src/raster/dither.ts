/**
 * BILDGRAVUR – RECHNEN (ohne Oberfläche, damit es auch im Test läuft)
 *
 * Ablauf: Graustufen (0 = schwarz, 1 = weiß) → auf das Gravur-Raster umrechnen (1 Bildpunkt = Linienabstand)
 *         → verbessern (Schwarz-/Weißpunkt, Gamma, Helligkeit, Kontrast, Entrauschen, Schärfen, Umkehren)
 *         → Rasterverfahren → „burn“ je Bildpunkt 0…1 (1 = Laser voll an).
 *
 * Rasterverfahren:
 *   threshold  Schwarz/Weiß an einer Schwelle
 *   floyd, jarvis, stucki, atkinson, sierra   Fehlerverteilung (Dithering), Zeilen abwechselnd (Schlangenlinie)
 *   bayer      geordnetes Raster 8×8
 *   halftone   Punktraster (runde Punkte in Zellen, Größe = Helligkeit, Winkel einstellbar)
 *   lines      Linienraster (Linien, Dicke = Helligkeit, Winkel einstellbar)
 *   gray       Graustufen: keine Punkte, die Leistung folgt der Helligkeit
 * Bildeffekte (Zellgröße/Winkel einstellbar):
 *   stipple    Punkte in einem leicht verwackelten Raster – wirkt wie von Hand getupft
 *   spiral     eine einzige Spirale von der Mitte aus, dicker wo es dunkel ist
 *   waves      Wellenlinien, dicker wo es dunkel ist
 *   crosshatch Kreuzschraffur wie mit dem Stift: je dunkler, desto mehr Lagen (schräg, gegenschräg, waagerecht)
 */

export type RasterMethod = "threshold" | "floyd" | "jarvis" | "stucki" | "atkinson" | "sierra" | "bayer" | "halftone" | "lines" | "gray"
  | "stipple" | "spiral" | "waves" | "crosshatch";
export const RASTER_METHODS: RasterMethod[] = ["jarvis", "floyd", "stucki", "atkinson", "sierra", "bayer", "halftone", "lines", "threshold", "gray",
  "stipple", "spiral", "waves", "crosshatch"];
/** Verfahren mit Zellgröße + Winkel */
export const CELL_METHODS: RasterMethod[] = ["halftone", "lines", "stipple", "spiral", "waves", "crosshatch"];

/** Gravurtypen (wie Voreinstellungen): Verfahren + passende Werte */
export type EngravePreset = "photo" | "graphic" | "bw" | "lines" | "dots" | "newspaper";
export const ENGRAVE_PRESETS: EngravePreset[] = ["photo", "graphic", "bw", "lines", "dots", "newspaper"];

export interface Adjust {
  black: number;      // Schwarzpunkt 0…1 (alles darunter wird schwarz)
  white: number;      // Weißpunkt 0…1
  gamma: number;      // 0.3…3 (über 1 = Mitteltöne heller)
  brightness: number; // -100…100
  contrast: number;   // -100…100
  sharpen: number;    // 0…100
  denoise: number;    // 0…3 (Weichzeichnen vor dem Schärfen)
  invert: boolean;    // für Acryl / dunkles Material
  local?: number;     // 0…100: lokaler Kontrast (Details in Fell, Haaren, Fassaden), mit Schutz vor hellen Kanten
  curve?: number[][]; // Bildkurve: Punkte [ein, aus] 0…1, sortiert, mit Anfang (x = 0) und Ende (x = 1)
}
export const NO_ADJUST: Adjust = { black: 0, white: 1, gamma: 1, brightness: 0, contrast: 0, sharpen: 0, denoise: 0, invert: false };

export interface RasterSettings {
  method: RasterMethod;
  threshold: number; // 0…1 (nur „threshold“)
  cell: number;      // Zellgröße in Raster-Punkten (Punkt-/Linienraster)
  angle: number;     // Winkel des Punkt-/Linienrasters in Grad
}

export function presetSettings(p: EngravePreset): { raster: RasterSettings; adjust: Partial<Adjust>; auto: boolean } {
  const r = (method: RasterMethod, cell = 6, angle = 0): RasterSettings => ({ method, threshold: 0.5, cell, angle });
  switch (p) {
    case "photo": return { raster: r("jarvis"), adjust: { sharpen: 35 }, auto: true };
    case "graphic": return { raster: r("atkinson"), adjust: { contrast: 20, sharpen: 20 }, auto: true };
    case "bw": return { raster: r("threshold"), adjust: {}, auto: false };
    case "lines": return { raster: r("lines", 6), adjust: { sharpen: 20 }, auto: true };
    case "dots": return { raster: r("halftone", 5, 0), adjust: {}, auto: true };
    case "newspaper": return { raster: r("halftone", 7, 45), adjust: { contrast: 15 }, auto: true };
  }
}

// ---------------------------------------------------------------------
// Graustufen + Umrechnen aufs Raster
// ---------------------------------------------------------------------

/** RGBA → Grau 0…1 (durchsichtig = weiß, also kein Laser) */
export function toGray(data: Uint8ClampedArray, n: number): Float32Array {
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    const y = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
    g[i] = y * a + (1 - a);
  }
  return g;
}

/** Auf gw × gh umrechnen: verkleinern = Mittelwert der Fläche, vergrößern = bilinear */
export function resample(src: Float32Array, sw: number, sh: number, gw: number, gh: number): Float32Array {
  const out = new Float32Array(gw * gh);
  if (gw <= sw && gh <= sh) {
    // Summen-Tabelle für schnelle Flächen-Mittelwerte
    const S = new Float64Array((sw + 1) * (sh + 1));
    for (let y = 0; y < sh; y++) {
      let row = 0;
      for (let x = 0; x < sw; x++) { row += src[y * sw + x]; S[(y + 1) * (sw + 1) + x + 1] = S[y * (sw + 1) + x + 1] + row; }
    }
    const sum = (x0: number, y0: number, x1: number, y1: number) =>
      S[y1 * (sw + 1) + x1] - S[y0 * (sw + 1) + x1] - S[y1 * (sw + 1) + x0] + S[y0 * (sw + 1) + x0];
    for (let y = 0; y < gh; y++) {
      const y0 = Math.floor((y * sh) / gh), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / gh));
      for (let x = 0; x < gw; x++) {
        const x0 = Math.floor((x * sw) / gw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / gw));
        out[y * gw + x] = sum(x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
      }
    }
    return out;
  }
  for (let y = 0; y < gh; y++) {
    const fy = Math.max(0, Math.min(sh - 1, ((y + 0.5) * sh) / gh - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < gw; x++) {
      const fx = Math.max(0, Math.min(sw - 1, ((x + 0.5) * sw) / gw - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * gw + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/**
 * Hintergrund entfernen: Farbe des Randes (Median aller Randpunkte) gilt als Hintergrund; von allen Rändern aus
 * werden zusammenhängende Punkte, die höchstens „tol“ (0…100) davon abweichen, weiß (= kein Laser).
 * Innen liegende Flächen in derselben Farbe bleiben erhalten, wenn das Motiv sie umschließt.
 */
export function removeBackground(g: Float32Array, w: number, h: number, tol: number): Float32Array {
  const out = g.slice();
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(g[x], g[(h - 1) * w + x]);
  for (let y = 0; y < h; y++) border.push(g[y * w], g[y * w + w - 1]);
  border.sort((a, b) => a - b);
  const bg = border[border.length >> 1];
  const lim = (Math.max(0, Math.min(100, tol)) / 100) * 0.5;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => { if (!seen[i] && Math.abs(g[i] - bg) <= lim) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    out[i] = 1;
    const x = i % w, y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return out;
}

// ---------------------------------------------------------------------
// Verbessern
// ---------------------------------------------------------------------

/**
 * Weichzeichnen (3 × Kastenfilter ≈ Gauß), Radius in Bildpunkten.
 * Senkrecht wird zeilenweise mit einer laufenden Summe je Spalte gerechnet (gleiche Rechenschritte wie spaltenweise,
 * also gleiches Ergebnis – aber viel schneller, weil der Speicher der Reihe nach gelesen wird).
 */
function blur(g: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return g.slice();
  let a = g.slice(), b = new Float32Array(g.length);
  const col = new Float64Array(w);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let s = 0, n = 0;
      for (let x = -r; x < w; x++) {
        if (x + r < w) { s += a[row + x + r]; n++; }
        if (x - r - 1 >= 0) { s -= a[row + x - r - 1]; n--; }
        if (x >= 0) b[row + x] = s / Math.max(1, n);
      }
    }
    [a, b] = [b, a];
    col.fill(0);
    let n = 0;
    for (let y = -r; y < h; y++) {
      if (y + r < h) { const o = (y + r) * w; for (let x = 0; x < w; x++) col[x] += a[o + x]; n++; }
      if (y - r - 1 >= 0) { const o = (y - r - 1) * w; for (let x = 0; x < w; x++) col[x] -= a[o + x]; n--; }
      if (y >= 0) { const o = y * w, d = Math.max(1, n); for (let x = 0; x < w; x++) b[o + x] = col[x] / d; }
    }
    [a, b] = [b, a];
  }
  return a;
}

/** Ist die Kurve nur die Diagonale (ändert nichts)? */
export function curveIsIdentity(c?: number[][]): boolean {
  return !c || c.length < 2 || c.every(p => Math.abs(p[0] - p[1]) < 1e-4);
}

/**
 * Bildkurve als Tabelle mit 256 Werten: weiche Kurve durch die Punkte, die nie „überschwingt“
 * (monotone kubische Interpolation nach Fritsch–Carlson) – wie die Gradationskurve in Bildprogrammen.
 */
export function curveLut(pts: number[][]): Float32Array {
  const p = pts.map(q => [Math.min(1, Math.max(0, q[0])), Math.min(1, Math.max(0, q[1]))]).sort((a, b) => a[0] - b[0]);
  const lut = new Float32Array(256);
  const n = p.length;
  if (n < 2) { for (let i = 0; i < 256; i++) lut[i] = i / 255; return lut; }
  const d: number[] = [], m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1][1] - p[i][1]) / Math.max(1e-6, p[i + 1][0] - p[i][0]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-9) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], r = a * a + b * b;
    if (r > 9) { const k = 3 / Math.sqrt(r); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    let i = 0;
    while (i < n - 2 && x > p[i + 1][0]) i++;
    let y: number;
    if (x <= p[0][0]) y = p[0][1];
    else if (x >= p[n - 1][0]) y = p[n - 1][1];
    else {
      const h = p[i + 1][0] - p[i][0], t = (x - p[i][0]) / h, t2 = t * t, t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1];
    }
    lut[k] = Math.min(1, Math.max(0, y));
  }
  return lut;
}

export function applyAdjust(src: Float32Array, w: number, h: number, a: Adjust): Float32Array {
  let g: Float32Array = new Float32Array(src.length);
  const span = Math.max(0.02, a.white - a.black);
  const inv = 1 / Math.max(0.1, a.gamma);
  const c = a.contrast >= 0 ? 1 + a.contrast / 50 : 1 + a.contrast / 100; // -100 → flach, +100 → 3-fach
  const b = a.brightness / 200;
  for (let i = 0; i < g.length; i++) {
    let v = Math.min(1, Math.max(0, (src[i] - a.black) / span));
    v = Math.pow(v, inv);
    v = (v - 0.5) * c + 0.5 + b;
    g[i] = Math.min(1, Math.max(0, v));
  }
  if (!curveIsIdentity(a.curve)) {
    const lut = curveLut(a.curve!);
    for (let i = 0; i < g.length; i++) {
      const f = g[i] * 255, k = Math.min(254, Math.floor(f));
      g[i] = lut[k] + (lut[k + 1] - lut[k]) * (f - k);
    }
  }
  if ((a.local ?? 0) > 0) g = localContrast(g, w, h, a.local!);
  if (a.denoise > 0) g = blur(g, w, h, Math.round(a.denoise));
  if (a.sharpen > 0) {
    const soft = blur(g, w, h, 1), k = a.sharpen / 40;
    for (let i = 0; i < g.length; i++) g[i] = Math.min(1, Math.max(0, g[i] + k * (g[i] - soft[i])));
  }
  if (a.invert) for (let i = 0; i < g.length; i++) g[i] = 1 - g[i];
  return g;
}

/**
 * Lokaler Kontrast: Unterschied zur weichgezeichneten Umgebung (Radius ~4 % der Bildgröße, damit Vorschau und
 * Gravur gleich aussehen) verstärken. An harten Kanten würde das helle Säume („Halos“) erzeugen – deshalb wird der
 * Zuwachs weich begrenzt, nach hell viel stärker als nach dunkel, und in fast weißen Bereichen ausgeblendet.
 */
function localContrast(g: Float32Array, w: number, h: number, amount: number): Float32Array {
  const r = Math.max(2, Math.round(Math.max(w, h) * 0.04));
  amount = Math.min(100, Math.max(0, amount));
  const base = blur(g, w, h, r), k = (amount / 100) * 1.6;
  const limUp = 0.06 + 0.06 * (amount / 100), limDown = 0.18;
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) {
    const d = (g[i] - base[i]) * k;
    const lim = d > 0 ? limUp * (1 - 0.7 * Math.max(0, g[i] - 0.8) / 0.2) : limDown;
    out[i] = Math.min(1, Math.max(0, g[i] + d / (1 + Math.abs(d) / Math.max(0.01, lim))));
  }
  return out;
}

/** Profile für „Automatisch verbessern“: behutsam (natürlich) oder kräftig (mehr Kontrast und Details) */
export type AutoProfile = "gentle" | "strong";

/** Werte für „Automatisch verbessern“: Tonwerte spreizen, Mitteltöne ausgleichen, etwas schärfen */
export function autoAdjust(g: Float32Array, base: Partial<Adjust> = {}, profile: AutoProfile = "gentle"): Adjust {
  const strong = profile === "strong";
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[Math.min(255, Math.max(0, Math.round(g[i] * 255)))]++;
  const pct = (p: number) => { let n = 0; const want = p * g.length; for (let i = 0; i < 256; i++) { n += hist[i]; if (n >= want) return i / 255; } return 1; };
  // kräftig: mehr abschneiden (ganz dunkle/helle Ränder des Histogramms), behutsam: fast nichts
  let black = pct(strong ? 0.012 : 0.005), white = pct(strong ? 0.992 : 0.997);
  if (white - black < 0.1) { black = 0; white = 1; }
  const m = Math.min(0.95, Math.max(0.05, (pct(0.5) - black) / Math.max(0.02, white - black)));
  // Mittelton auf etwa 0,55 bringen (eine Laser-Gravur wirkt sonst schnell zu dunkel)
  const gamma = Math.min(2.2, Math.max(0.5, Math.log(m) / Math.log(0.55)));
  // flache Bilder (wenig Streuung) bekommen mehr lokalen Kontrast
  let s = 0, s2 = 0;
  for (let i = 0; i < g.length; i++) { s += g[i]; s2 += g[i] * g[i]; }
  const sd = Math.sqrt(Math.max(0, s2 / g.length - (s / g.length) ** 2));
  const flat = Math.min(1, Math.max(0, (0.25 - sd) / 0.15));
  const local = Math.round(strong ? 35 + 25 * flat : 15 + 15 * flat);
  return { ...NO_ADJUST, black: +black.toFixed(3), white: +white.toFixed(3), gamma: +gamma.toFixed(2),
    contrast: strong ? 5 : 0, sharpen: strong ? 35 : 20, local, ...base };
}

/** Kennzahlen für die Bewertung vorher/nachher */
export function stats(g: Float32Array, w: number, h: number): { mean: number; contrast: number; detail: number; clipped: number } {
  let s = 0, s2 = 0, clip = 0, grad = 0;
  for (let i = 0; i < g.length; i++) { s += g[i]; s2 += g[i] * g[i]; if (g[i] < 0.02 || g[i] > 0.98) clip++; }
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    grad += Math.abs(g[i + 1] - g[i]) + Math.abs(g[i + w] - g[i]);
  }
  const mean = s / g.length;
  return { mean, contrast: Math.sqrt(Math.max(0, s2 / g.length - mean * mean)), detail: grad / Math.max(1, (w - 1) * (h - 1)), clipped: clip / g.length };
}

// ---------------------------------------------------------------------
// Rasterverfahren
// ---------------------------------------------------------------------

type Kernel = { d: number; k: [number, number, number][] }; // [dx, dy, Gewicht], Summe / d
const KERNELS: Record<string, Kernel> = {
  floyd: { d: 16, k: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  jarvis: { d: 48, k: [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]] },
  stucki: { d: 42, k: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]] },
  atkinson: { d: 8, k: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
  sierra: { d: 32, k: [[1, 0, 5], [2, 0, 3], [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2], [-1, 2, 2], [0, 2, 3], [1, 2, 2]] }
};

/** Bayer-Matrix 8×8 (Schwellen 0…1) */
const BAYER8 = (() => {
  let cur = [[0]];
  for (let n = 1; n < 8; n *= 2) {
    const nx: number[][] = [];
    for (let y = 0; y < n * 2; y++) {
      nx.push([]);
      for (let x = 0; x < n * 2; x++) nx[y].push(cur[y % n][x % n] * 4 + [0, 2, 3, 1][(y < n ? 0 : 2) + (x < n ? 0 : 1)]);
    }
    cur = nx;
  }
  return cur.map(r => r.map(v => (v + 0.5) / 64));
})();

/** Graustufen (0 = schwarz) → burn 0…1 (1 = Laser an) */
export function rasterize(g: Float32Array, w: number, h: number, s: RasterSettings): Float32Array {
  const out = new Float32Array(g.length);
  if (s.method === "gray") { for (let i = 0; i < g.length; i++) out[i] = 1 - g[i]; return out; }
  if (s.method === "threshold") { for (let i = 0; i < g.length; i++) out[i] = g[i] < s.threshold ? 1 : 0; return out; }
  if (s.method === "bayer") {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = 1 - g[y * w + x] > BAYER8[y & 7][x & 7] ? 1 : 0;
    return out;
  }
  if (s.method === "halftone" || s.method === "lines") {
    const cell = Math.max(2, s.cell);
    const a = (s.angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    // Helligkeit geglättet, damit die Punkte rund und die Linien ruhig bleiben
    const soft = blur(g, w, h, Math.max(1, Math.round(cell / 3)));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * ca + (y + 0.5) * sa, v = -(x + 0.5) * sa + (y + 0.5) * ca;
      const cu = (Math.floor(u / cell) + 0.5) * cell, cv = (Math.floor(v / cell) + 0.5) * cell;
      if (s.method === "lines") {
        // Linie beginnt am Zellrand und ist so dick wie die Dunkelheit (in ganzen Bildpunkten genau)
        out[y * w + x] = v - (cv - cell / 2) < (1 - soft[y * w + x]) * cell ? 1 : 0;
        continue;
      }
      // Zellmitte zurück ins Bild → Helligkeit dort
      const px = Math.min(w - 1, Math.max(0, Math.round(cu * ca - cv * sa))), py = Math.min(h - 1, Math.max(0, Math.round(cu * sa + cv * ca)));
      const d = 1 - soft[py * w + px];
      // Fläche des Punktes = Dunkelheit; ab ~78 % wachsen die Punkte zusammen
      const r = Math.sqrt(d / Math.PI) * cell * (d > 0.78 ? 1 + (d - 0.78) : 1);
      out[y * w + x] = Math.hypot(u - cu, v - cv) < r ? 1 : 0;
    }
    return out;
  }
  if (s.method === "stipple" || s.method === "spiral" || s.method === "waves" || s.method === "crosshatch") return effect(g, w, h, s, out);
  // Fehlerverteilung, Zeilen abwechselnd von links und von rechts
  const k = KERNELS[s.method] || KERNELS.floyd;
  const e = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) e[i] = 1 - g[i];
  for (let y = 0; y < h; y++) {
    const rtl = y % 2 === 1;
    for (let j = 0; j < w; j++) {
      const x = rtl ? w - 1 - j : j, i = y * w + x;
      const on = e[i] >= 0.5 ? 1 : 0;
      out[i] = on;
      const err = e[i] - on;
      if (!err) continue;
      for (const [dx0, dy, wt] of k.k) {
        const xx = x + (rtl ? -dx0 : dx0), yy = y + dy;
        if (xx < 0 || xx >= w || yy >= h) continue;
        e[yy * w + xx] += (err * wt) / k.d;
      }
    }
  }
  return out;
}

/** Pseudo-Zufall 0…1 je Zelle (immer gleich → Vorschau und G-Code stimmen überein) */
function hash(a: number, b: number): number {
  let x = (a * 374761393 + b * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Bildeffekte (siehe oben) */
function effect(g: Float32Array, w: number, h: number, s: RasterSettings, out: Float32Array): Float32Array {
  const cell = Math.max(2, s.cell);
  const soft = blur(g, w, h, Math.max(1, Math.round(cell / 3)));
  const a = (s.angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  // Kante einer Linie: Abstand dist von der Mitte, halbe Breite half – der angeschnittene Bildpunkt wird
  // nach Bayer-Raster an/aus gesetzt, sonst springt die Breite in ganzen Punkten (Streifen, wo die Linie
  // genau senkrecht oder waagerecht läuft)
  const edge = (dist: number, half: number, x: number, y: number) => {
    const cov = Math.min(1, Math.max(0, half - dist + 0.5));
    return cov > BAYER8[y & 7][x & 7] ? 1 : 0;
  };
  const dark = (x: number, y: number) => 1 - soft[Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)))];
  if (s.method === "stipple") {
    // jede Zelle: ein Punkt an verwackelter Stelle, Fläche = Dunkelheit (Nachbarzellen mitprüfen, Punkte ragen hinüber)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const cx0 = Math.floor(x / cell), cy0 = Math.floor(y / cell);
      let on = 0;
      for (let j = -1; j <= 1 && !on; j++) for (let i = -1; i <= 1 && !on; i++) {
        const cx = cx0 + i, cy = cy0 + j;
        const px = (cx + 0.2 + 0.6 * hash(cx, cy)) * cell, py = (cy + 0.2 + 0.6 * hash(cy + 7919, cx)) * cell;
        const d = dark(px, py);
        if (d < 0.02) continue;
        const r = Math.sqrt(d / Math.PI) * cell * 1.05;
        if (Math.hypot(x + 0.5 - px, y + 0.5 - py) < r) on = 1;
      }
      out[y * w + x] = on;
    }
    return out;
  }
  if (s.method === "spiral") {
    // archimedische Spirale ab der Bildmitte, Windungsabstand = cell, Linie so dick wie die Dunkelheit
    const mx = w / 2, my = h / 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - mx, dy = y + 0.5 - my;
      const r = Math.hypot(dx, dy), th = Math.atan2(dy, dx) + a;
      const f = ((r - (th / (2 * Math.PI)) * cell) % cell + cell) % cell; // 0…cell: Lage zwischen zwei Windungen
      out[y * w + x] = edge(Math.abs(f - cell / 2), (dark(x, y) * cell) / 2, x, y);
    }
    return out;
  }
  if (s.method === "waves") {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * ca + (y + 0.5) * sa, v = -(x + 0.5) * sa + (y + 0.5) * ca;
      const vv = v + Math.sin((u / (cell * 3)) * 2 * Math.PI) * cell * 0.6;
      const f = ((vv % cell) + cell) % cell;
      out[y * w + x] = edge(Math.abs(f - cell / 2), (dark(x, y) * cell) / 2, x, y);
    }
    return out;
  }
  // Kreuzschraffur: Lagen ab 15 %, 40 %, 65 %, 85 % Dunkelheit
  const layers = [a + Math.PI / 4, a - Math.PI / 4, a, a + Math.PI / 2];
  const from = [0.15, 0.4, 0.65, 0.85];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = dark(x, y);
    let on = 0;
    for (let k = 0; k < 4 && !on; k++) {
      if (d < from[k]) break;
      const v = -(x + 0.5) * Math.sin(layers[k]) + (y + 0.5) * Math.cos(layers[k]);
      if (((v % cell) + cell) % cell < 1) on = 1;
    }
    out[y * w + x] = on;
  }
  return out;
}
