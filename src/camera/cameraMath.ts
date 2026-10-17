/**
 * KAMERA-MATHEMATIK (ohne DOM – lässt sich einzeln prüfen)
 *
 * Koordinaten:
 *   Bild (u, v)        0…1 von links oben, so wie das Bild angezeigt wird (nach Drehen/Spiegeln)
 *   normiert (nx, ny)  Bildmitte = 0, ny = -1 … +1 (oben … unten), nx = -ar … +ar (ar = Breite/Höhe)
 *   Bett (x, y)        mm, Nullpunkt links unten wie auf der Arbeitsfläche
 *
 * Linse: einfache radiale Verzeichnung (Tonne/Kissen) mit einem Wert k1:
 *   verzerrt = unverzerrt · (1 + k1 · r²)      (r² = nx² + ny²)
 *   k1 < 0  -> Tonne (typisch bei Weitwinkel-Webcams), k1 > 0 -> Kissen
 *
 * Perspektive: Homographie H (3×3), bildet Bett-mm auf unverzerrte normierte Bildpunkte ab.
 * Aus 4 Punktpaaren berechnet (Kamera muss nicht senkrecht über dem Bett hängen).
 */

export type Mat3 = number[]; // 9 Werte, zeilenweise

export function toNorm(u: number, v: number, ar: number): [number, number] {
  return [(u - 0.5) * 2 * ar, (v - 0.5) * 2];
}
export function fromNorm(nx: number, ny: number, ar: number): [number, number] {
  return [nx / (2 * ar) + 0.5, ny / 2 + 0.5];
}

export function distort(nx: number, ny: number, k1: number): [number, number] {
  const f = 1 + k1 * (nx * nx + ny * ny);
  return [nx * f, ny * f];
}
/** Umkehrung von distort (iterativ, für kleine k1 schnell genau) */
export function undistort(dx: number, dy: number, k1: number): [number, number] {
  let x = dx, y = dy;
  for (let i = 0; i < 30; i++) {
    const f = 1 + k1 * (x * x + y * y);
    if (Math.abs(f) < 1e-6) break;
    x = dx / f; y = dy / f;
  }
  return [x, y];
}

/** Lineares Gleichungssystem lösen (Gauß mit Pivotsuche). null = nicht lösbar */
export function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Homographie aus 4 Punktpaaren: src[i] -> dst[i]. null bei ungünstiger Lage (3 Punkte auf einer Linie …) */
export function homography(src: [number, number][], dst: [number, number][]): Mat3 | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
  }
  const h = solve(A, b);
  if (!h || h.some(v => !Number.isFinite(v))) return null;
  return [...h, 1];
}

export function applyH(H: Mat3, x: number, y: number): [number, number] {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Prüfen, ob 4 Punkte ein brauchbares Viereck bilden (keine 3 auf einer Linie, nicht überkreuzt) */
export function goodQuad(p: [number, number][]): boolean {
  if (p.length !== 4) return false;
  const cross = (a: [number, number], b: [number, number], c: [number, number]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const s = [cross(p[0], p[1], p[2]), cross(p[1], p[2], p[3]), cross(p[2], p[3], p[0]), cross(p[3], p[0], p[1])];
  const area = Math.abs(s[0]) + Math.abs(s[2]);
  if (area < 1e-6) return false;
  // alle Ecken gleich herum (konvex, nicht überkreuzt) und keine fast gerade
  const sign = Math.sign(s[0]);
  return s.every(v => Math.sign(v) === sign && Math.abs(v) > area * 0.02);
}

/** Standard-Positionen der Laser-Markierungen: 15 % vom Rand */
export function markPositions(bedW: number, bedH: number, inset = 0.15): [number, number][] {
  const r = (v: number) => Math.round(v);
  const x0 = r(bedW * inset), x1 = r(bedW * (1 - inset)), y0 = r(bedH * inset), y1 = r(bedH * (1 - inset));
  // Reihenfolge: links unten, rechts unten, rechts oben, links oben (gegen den Uhrzeigersinn)
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/**
 * G-Code für 4 Kreuze (Laser, geringe Leistung) an den Markierungs-Positionen.
 * sMax = S-Wert für 100 %, power in %, size = Kreuzlänge in mm.
 */
export function markGcode(points: [number, number][], power: number, speed: number, size: number, sMax: number, dynamic: boolean): string {
  const S = Math.max(1, Math.round(sMax * Math.min(100, Math.max(1, power)) / 100));
  const h = size / 2;
  const f = (v: number) => (Math.round(v * 1000) / 1000).toString();
  const on = dynamic ? "M4" : "M3";
  const out = ["(CNC Craft – Kamera-Ausrichtung: 4 Kreuze)", "G21", "G90", "M5"];
  points.forEach(([x, y], i) => {
    out.push(`(Kreuz ${i + 1}: X${f(x)} Y${f(y)})`);
    out.push(`G0 X${f(x - h)} Y${f(y)}`, `${on} S${S}`, `G1 X${f(x + h)} F${Math.round(speed)}`, "M5");
    out.push(`G0 X${f(x)} Y${f(y - h)}`, `${on} S${S}`, `G1 Y${f(y + h)} F${Math.round(speed)}`, "M5");
  });
  out.push("M5", "G0 X0 Y0");
  return out.join("\n");
}
