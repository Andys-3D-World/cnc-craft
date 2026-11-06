/**
 * RELIEF AUS VEKTOREN: geschlossene Konturen (Text, Logos) werden erhaben.
 * Innen/Außen nach gerade/ungerade (even-odd): Löcher in Buchstaben bleiben Löcher.
 * Die Höhe hängt am Abstand zur nächsten Kontur (Abstandsfeld auf dem Raster, Abstand zur echten Strecke, nicht zum Pixel).
 * Hintergrund = tiefste Höhe, höchste Stelle = 0 (Material-Oberkante).
 */
import { type HeightField, blur, gridFor, normalizeTop } from "./heightField.ts";

export interface VPt { x: number; y: number }

export type ReliefProfile = "round" | "slope" | "dome";

export interface VectorReliefOpts {
  /** größte Höhe (mm) */
  height: number;
  /** Kante: runde Kante, schräge Kante, Kuppel */
  profile: ReliefProfile;
  /** Breite der Kante (mm). Kuppel: 0 = bis zur dicksten Stelle */
  width: number;
  /** Fläche rund um die Konturen (mm) */
  pad: number;
  /** Weichzeichnen in mm: glättet Grate auf der Mittellinie, die Außenkontur bleibt */
  smooth: number;
  /** Zellen auf der längsten Seite */
  long: number;
}

export interface VectorField { field: HeightField; x0: number; y0: number; flat: boolean }

export function loopBounds(loops: VPt[][]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of loops) for (const p of l) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  return { x0, y0, x1, y1 };
}

/** Knoten innerhalb nach gerade/ungerade: Zeile für Zeile die Kreuzungen sortieren */
export function insideMask(loops: VPt[][], x0: number, y0: number, dx: number, dy: number, nx: number, ny: number): Uint8Array {
  const rows: number[][] = Array.from({ length: ny }, () => []);
  for (const l of loops) {
    if (l.length < 3) continue;
    for (let k = 0; k < l.length; k++) {
      const a = l[k], b = l[k + 1 === l.length ? 0 : k + 1];
      if (a.y === b.y) continue;
      const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
      // halboffen [lo, hi): ein Eckpunkt genau auf der Zeile zählt nur einmal
      const j0 = Math.max(0, Math.ceil((lo - y0) / dy)), j1 = Math.min(ny - 1, Math.ceil((hi - y0) / dy) - 1);
      for (let j = j0; j <= j1; j++) rows[j].push(a.x + ((y0 + j * dy - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
  }
  const m = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const r = rows[j].sort((p, q) => p - q);
    for (let k = 0; k + 1 < r.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((r[k] - x0) / dx)), i1 = Math.min(nx - 1, Math.floor((r[k + 1] - x0) / dx));
      for (let i = i0; i <= i1; i++) m[j * nx + i] = 1;
    }
  }
  return m;
}

/**
 * Abstand jedes Knotens zur nächsten Kontur (mm). Jeder Knoten merkt sich die nächste Strecke und gibt sie an die
 * Nachbarn weiter (zwei Durchläufe in jede Richtung) – geht in linearer Zeit, auch bei vielen Tausend Strecken.
 */
export function contourDistance(loops: VPt[][], x0: number, y0: number, dx: number, dy: number, nx: number, ny: number): Float32Array {
  const seg: number[] = [];
  for (const l of loops) {
    if (l.length < 2) continue;
    for (let k = 0; k < l.length; k++) {
      const a = l[k], b = l[k + 1 === l.length ? 0 : k + 1];
      seg.push(a.x, a.y, b.x, b.y);
    }
  }
  const near = new Int32Array(nx * ny).fill(-1);
  const d2 = new Float64Array(nx * ny).fill(Infinity);
  const dist2 = (i: number, j: number, s: number) => {
    const px = x0 + i * dx, py = y0 + j * dy;
    const ax = seg[s], ay = seg[s + 1], bx = seg[s + 2] - ax, by = seg[s + 3] - ay;
    const L = bx * bx + by * by;
    const u = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / L)) : 0;
    const qx = px - ax - u * bx, qy = py - ay - u * by;
    return qx * qx + qy * qy;
  };
  const offer = (i: number, j: number, s: number) => {
    const v = dist2(i, j, s), c = j * nx + i;
    if (v < d2[c]) { d2[c] = v; near[c] = s; }
  };
  // Start: Knoten direkt an den Strecken
  const step = Math.min(dx, dy) / 2;
  for (let s = 0; s < seg.length; s += 4) {
    const n = Math.max(1, Math.ceil(Math.hypot(seg[s + 2] - seg[s], seg[s + 3] - seg[s + 1]) / step));
    for (let k = 0; k <= n; k++) {
      const x = seg[s] + ((seg[s + 2] - seg[s]) * k) / n, y = seg[s + 1] + ((seg[s + 3] - seg[s + 1]) * k) / n;
      const ci = Math.floor((x - x0) / dx), cj = Math.floor((y - y0) / dy);
      for (let j = Math.max(0, cj); j <= Math.min(ny - 1, cj + 1); j++)
        for (let i = Math.max(0, ci); i <= Math.min(nx - 1, ci + 1); i++) offer(i, j, s);
    }
  }
  const take = (i: number, j: number, a: number, b: number) => {
    if (a < 0 || b < 0 || a >= nx || b >= ny) return;
    const s = near[b * nx + a];
    if (s >= 0) offer(i, j, s);
  };
  for (let round = 0; round < 2; round++) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      take(i, j, i - 1, j); take(i, j, i - 1, j - 1); take(i, j, i, j - 1); take(i, j, i + 1, j - 1);
    }
    for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
      take(i, j, i + 1, j); take(i, j, i + 1, j + 1); take(i, j, i, j + 1); take(i, j, i - 1, j + 1);
    }
  }
  const out = new Float32Array(nx * ny);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(d2[i]);
  return out;
}

/** Konturen (mm, Y nach oben) → Höhenfeld. (x0, y0) = linke untere Ecke auf dem Bett */
export function loopsToField(loops: VPt[][], o: VectorReliefOpts): VectorField | null {
  const used = loops.filter(l => l.length >= 3);
  if (!used.length) return null;
  const b = loopBounds(used), pad = Math.max(0, o.pad);
  const w = b.x1 - b.x0 + 2 * pad, h = b.y1 - b.y0 + 2 * pad;
  if (!(w > 0 && h > 0)) return null;
  const { nx, ny } = gridFor(w, h, o.long);
  const dx = w / (nx - 1), dy = h / (ny - 1), x0 = b.x0 - pad, y0 = b.y0 - pad;
  const inside = insideMask(used, x0, y0, dx, dy, nx, ny);
  const dist = contourDistance(used, x0, y0, dx, dy, nx, ny);
  let dmax = 0;
  for (let i = 0; i < dist.length; i++) if (inside[i] && dist[i] > dmax) dmax = dist[i];
  const H = Math.max(0, o.height);
  const wid = o.profile === "dome" && !(o.width > 0) ? dmax : Math.max(0, o.width);
  const lift = new Float32Array(nx * ny);
  for (let i = 0; i < lift.length; i++) {
    if (!inside[i]) continue;
    const t = wid > 0 ? Math.min(1, dist[i] / wid) : 1;
    lift[i] = H * (o.profile === "slope" ? t : Math.sqrt(1 - (1 - t) * (1 - t)));
  }
  if (o.smooth > 0) {
    // nur abrunden: nie höher als vorher – so bleibt die Kontur scharf und die Höhe gedeckelt
    const soft = lift.slice();
    blur(soft, nx, ny, o.smooth / dx, o.smooth / dy);
    for (let i = 0; i < lift.length; i++) if (soft[i] < lift[i]) lift[i] = soft[i];
  }
  const z = new Float32Array(nx * ny);
  for (let i = 0; i < z.length; i++) z[i] = lift[i] - H;
  const flat = normalizeTop(z);
  return { field: { nx, ny, w, h, z }, x0, y0, flat };
}
