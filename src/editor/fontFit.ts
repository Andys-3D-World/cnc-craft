/**
 * PASST DER FRÄSER? – wie breit die Striche einer Schrift sind, gemessen an einem gemalten Beispiel (Maske).
 * Ergebnis: größter Kreis-Ø (im Verhältnis zur Schrifthöhe), mit dem fast die ganze Buchstabenfläche erreichbar ist.
 * Ecken werden mit einem runden Fräser nie ganz spitz – deshalb zählt die Fläche, nicht jeder Punkt. Ohne Oberfläche, mit Tests.
 */
/** Quadrat des Abstands zum nächsten Punkt außerhalb (Felzenszwalb, exakt) */
export function distance2(mask: Uint8Array, w: number, h: number, inside = 1): Float64Array {
  const INF = 1e12, f = new Float64Array(w * h), m = Math.max(w, h), v = new Int32Array(m), z = new Float64Array(m + 1), g = new Float64Array(m), d = new Float64Array(m);
  for (let i = 0; i < f.length; i++) f[i] = (mask[i] ? 1 : 0) === inside ? INF : 0;
  const line = (n: number) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (g[q] + q * q - g[v[k]] - v[k] * v[k]) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = (g[q] + q * q - g[v[k]] - v[k] * v[k]) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + g[v[k]]; }
  };
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) g[y] = f[y * w + x]; line(h); for (let y = 0; y < h; y++) f[y * w + x] = d[y]; }
  for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) g[x] = f[y * w + x]; line(w); for (let x = 0; x < w; x++) f[y * w + x] = d[x]; }
  return f;
}
/** Anteil der Fläche, den ein Kreis mit Radius r (Pixel) erreicht */
export function reachable(mask: Uint8Array, w: number, h: number, r: number, dist = distance2(mask, w, h)): number {
  const core = new Uint8Array(w * h);
  let area = 0, any = false;
  for (let i = 0; i < core.length; i++) { if (mask[i]) area++; if (mask[i] && dist[i] >= r * r) { core[i] = 1; any = true; } }
  if (!area) return 0;
  if (!any) return 0;
  const back = distance2(core, w, h, 0);
  let n = 0;
  for (let i = 0; i < core.length; i++) if (mask[i] && back[i] <= r * r + 1e-9) n++;
  return n / area;
}
/** größter Durchmesser (Pixel), der mindestens `share` der Fläche erreicht */
export function largestTool(mask: Uint8Array, w: number, h: number, share = 0.93): number {
  const dist = distance2(mask, w, h);
  let max = 0;
  for (let i = 0; i < dist.length; i++) if (mask[i] && dist[i] < 1e11 && dist[i] > max) max = dist[i];
  let lo = 0, hi = Math.sqrt(max);
  if (reachable(mask, w, h, hi, dist) >= share) return hi * 2;
  for (let k = 0; k < 12; k++) { const m = (lo + hi) / 2; if (reachable(mask, w, h, m, dist) >= share) lo = m; else hi = m; }
  return lo * 2;
}
/** kleinste Schrifthöhe (mm, Höhe der Großbuchstaben), bei der ein Fräser mit d mm durchpasst */
export const minHeight = (d: number, toolPx: number, capPx: number) => (toolPx > 0.5 && capPx > 0 ? d * capPx / toolPx : Infinity);
