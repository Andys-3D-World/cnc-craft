/**
 * RELIEF: HÖHENFELD – gemeinsame Grundlage für Relief aus Bild und aus Vektoren
 *
 * Raster aus Knoten über die Fläche w × h (mm). z[j * nx + i] ist die Höhe in mm: 0 = Oberkante, nach unten negativ,
 * j = 0 ist die untere Kante (Y zeigt nach oben, wie an der Maschine). Daraus wird eine Dreiecksfläche, die durch
 * denselben 3D-Dialog läuft wie ein STL-Modell (cam3dDialog.ts → cam3d.rs).
 * Nur Rechnen, keine Oberfläche: läuft im Worker und in den Tests.
 */

export interface HeightField { nx: number; ny: number; w: number; h: number; z: Float32Array }

/** Höchstens so viele Knoten (entspricht 2,4 Mio. Dreiecken) – mehr bringt keine Fräsgenauigkeit, nur Wartezeit */
export const MAX_NODES = 1_200_000;
/** Feiner als das ist jeder Fräser grob */
const MIN_CELL = 0.05;

/** Rastergröße für w × h mm: längste Seite bekommt `longSide` Zellen, Zellen nie kleiner als 0,05 mm */
export function gridFor(w: number, h: number, longSide: number): { nx: number; ny: number } {
  const L = Math.max(w, h);
  let cell = Math.max(L / Math.max(2, longSide), MIN_CELL);
  const count = () => [Math.max(2, Math.round(w / cell) + 1), Math.max(2, Math.round(h / cell) + 1)];
  let [nx, ny] = count();
  if (nx * ny > MAX_NODES) {
    cell *= Math.sqrt((nx * ny) / MAX_NODES) * 1.001;
    [nx, ny] = count();
  }
  return { nx, ny };
}

/** Weichzeichnen: drei Durchläufe Kastenfilter (fast wie Gauß). sigmaX/Y in Zellen, wirkt direkt auf das Feld. */
export function blur(a: Float32Array, nx: number, ny: number, sigmaX: number, sigmaY: number) {
  const rad = (s: number) => Math.round((Math.sqrt(4 * s * s + 1) - 1) / 2);
  const rx = rad(sigmaX), ry = rad(sigmaY);
  const buf = new Float32Array(Math.max(nx, ny));
  const line = (start: number, step: number, n: number, r: number) => {
    if (r < 1) return;
    for (let pass = 0; pass < 3; pass++) {
      for (let k = 0; k < n; k++) buf[k] = a[start + k * step];
      const at = (k: number) => buf[k < 0 ? 0 : k >= n ? n - 1 : k];
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += at(k);
      const f = 1 / (2 * r + 1);
      for (let k = 0; k < n; k++) {
        a[start + k * step] = sum * f;
        sum += at(k + r + 1) - at(k - r);
      }
    }
  };
  for (let j = 0; j < ny; j++) line(j * nx, 1, nx, rx);
  for (let i = 0; i < nx; i++) line(i, nx, ny, ry);
}

/** Oberkante genau auf 0 schieben; true = das Feld ist ganz flach (nichts zu fräsen) */
export function normalizeTop(z: Float32Array): boolean {
  let hi = -Infinity, lo = Infinity;
  for (let i = 0; i < z.length; i++) { if (z[i] > hi) hi = z[i]; if (z[i] < lo) lo = z[i]; }
  if (hi !== 0) for (let i = 0; i < z.length; i++) z[i] -= hi;
  return hi - lo < 1e-4;
}

export function fieldRange(f: HeightField): number {
  let lo = 0;
  for (let i = 0; i < f.z.length; i++) if (f.z[i] < lo) lo = f.z[i];
  return lo < 0 ? -lo : 0;
}

/** Fläche als Dreiecke (9 Werte je Dreieck), x 0…w, y 0…h, z wie im Feld. Nur die Oberfläche: mehr braucht der Drop-Cutter nicht */
export function fieldToMesh(f: HeightField): Float32Array {
  const { nx, ny, z } = f;
  const dx = f.w / (nx - 1), dy = f.h / (ny - 1);
  const out = new Float32Array((nx - 1) * (ny - 1) * 18);
  let o = 0;
  const put = (i: number, j: number) => { out[o++] = i * dx; out[o++] = j * dy; out[o++] = z[j * nx + i]; };
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    put(i, j); put(i + 1, j); put(i + 1, j + 1);
    put(i, j); put(i + 1, j + 1); put(i, j + 1);
  }
  return out;
}

/** Für die Ansicht: Fläche + Seitenwände hinunter bis `bottom` (mm, negativ) als Dreiecke */
export function fieldPreviewTris(f: HeightField, bottom: number): Float32Array {
  const { nx, ny, z } = f;
  const top = fieldToMesh(f);
  const dx = f.w / (nx - 1), dy = f.h / (ny - 1);
  const out = new Float32Array(top.length + 2 * (nx - 1 + ny - 1) * 18 + 18);
  out.set(top);
  let o = top.length;
  const v = (x: number, y: number, h: number) => { out[o++] = x; out[o++] = y; out[o++] = h; };
  const wall = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    v(x0, y0, z0); v(x1, y1, z1); v(x1, y1, bottom);
    v(x0, y0, z0); v(x1, y1, bottom); v(x0, y0, bottom);
  };
  for (let i = 0; i < nx - 1; i++) {
    wall(i * dx, 0, z[i], (i + 1) * dx, 0, z[i + 1]);
    wall((i + 1) * dx, f.h, z[(ny - 1) * nx + i + 1], i * dx, f.h, z[(ny - 1) * nx + i]);
  }
  for (let j = 0; j < ny - 1; j++) {
    wall(f.w, j * dy, z[j * nx + nx - 1], f.w, (j + 1) * dy, z[(j + 1) * nx + nx - 1]);
    wall(0, (j + 1) * dy, z[(j + 1) * nx], 0, j * dy, z[j * nx]);
  }
  // Boden
  v(0, 0, bottom); v(f.w, f.h, bottom); v(f.w, 0, bottom);
  v(0, 0, bottom); v(0, f.h, bottom); v(f.w, f.h, bottom);
  return out;
}

export interface DetailLoss { share: number; worst: number }

/**
 * Wie viel der Fläche erreicht ein Kugelfräser nicht? (für die Warnung im 3D-Dialog)
 * Rechnet die Fläche, die der Kugelfräser wirklich hinterlässt (Kugel von oben aufsetzen, dann die Hüllfläche
 * der Kugeln), auf einem groben Raster und vergleicht mit dem Ziel. Schräge Flächen zählen nicht, nur echte Details.
 *
 * @param sizeX,sizeY,height  Maße im Dialog (können vom Feld abweichen)
 * @param ballR               Radius des Kugelfräsers (mm)
 * @returns share = Anteil der Fläche mit Rest über `max(0,1 mm; 3 % der Höhe)`, worst = größter Rest (mm)
 */
export function detailLoss(f: HeightField, sizeX: number, sizeY: number, height: number, ballR: number): DetailLoss {
  const range = fieldRange(f) || 1;
  const kz = height / range;
  const g = Math.max(ballR / 5, Math.max(sizeX, sizeY) / 220);
  const nx = Math.max(2, Math.round(sizeX / g) + 1), ny = Math.max(2, Math.round(sizeY / g) + 1);
  const gx = sizeX / (nx - 1), gy = sizeY / (ny - 1);
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const fj = Math.round((j / (ny - 1)) * (f.ny - 1));
    for (let i = 0; i < nx; i++) z[j * nx + i] = f.z[fj * f.nx + Math.round((i / (nx - 1)) * (f.nx - 1))] * kz;
  }
  // Scheibe des Fräsers auf diesem Raster
  const disc: { di: number; dj: number; b: number }[] = [];
  const ni = Math.floor(ballR / gx), nj = Math.floor(ballR / gy);
  for (let dj = -nj; dj <= nj; dj++) for (let di = -ni; di <= ni; di++) {
    const d2 = (di * gx) ** 2 + (dj * gy) ** 2;
    if (d2 <= ballR * ballR) disc.push({ di, dj, b: ballR - Math.sqrt(ballR * ballR - d2) });
  }
  if (disc.length < 5) return { share: 0, worst: 0 };   // Fräser kleiner als das Raster: fein genug
  const tip = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let m = -Infinity;
    for (const c of disc) {
      const a = i + c.di, b = j + c.dj;
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const v = z[b * nx + a] - c.b;
      if (v > m) m = v;
    }
    tip[j * nx + i] = m;
  }
  const limit = Math.max(0.1, 0.03 * height);
  let over = 0, worst = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let m = Infinity;
    for (const c of disc) {
      const a = i + c.di, b = j + c.dj;
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const v = tip[b * nx + a] + c.b;
      if (v < m) m = v;
    }
    const gap = m - z[j * nx + i];
    if (gap > limit) over++;
    if (gap > worst) worst = gap;
  }
  return { share: over / (nx * ny), worst };
}
