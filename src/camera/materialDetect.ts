/**
 * MATERIAL ERKENNEN (Beta) – aus dem entzerrten Kamerabild (Bett von oben, siehe cameraWarp.ts „bed“)
 *
 * Am zuverlässigsten mit einem Bild vom LEEREN Bett (Vergleichsbild):
 *   1. Unterschied je Pixel zwischen leerem Bett und Bett mit Material (Helligkeit vorher angeglichen,
 *      damit etwas anderes Licht nicht gleich als Material zählt)
 *   2. Schwelle automatisch (Otsu) – mit Empfindlichkeit verschiebbar
 *   3. Kleine Störungen weg (schließen/öffnen), größte zusammenhängende Fläche = Platte
 *   4. Löcher in der Platte (sehen aus wie leeres Bett) = verbrauchte Fläche
 *   5. Umriss: kleinstes umschließendes Rechteck (auch schräg liegend) → 4 Ecken in mm
 *
 * Ohne Vergleichsbild (Notbehelf): Helligkeit, Schwelle nach Otsu; Material ist die Klasse, die weniger
 * am Bildrand liegt. Klappt nur, wenn Platte und Bett sehr verschieden hell sind.
 *
 * Alles reine Rechnung auf Pixel-Feldern (kein DOM) – lässt sich ohne Kamera prüfen.
 * Bild-Zeile 0 = OBEN (wie im Canvas); mm: Nullpunkt links UNTEN (wie das Bett).
 */

export interface Img { w: number; h: number; data: Uint8ClampedArray | Uint8Array } // RGBA

export interface DetectResult {
  w: number; h: number;          // Rastergröße (wie das Bild)
  plate: Uint8Array;             // 1 = Material (nach Aufräumen)
  holes: Uint8Array;             // 1 = Loch in der Platte (verbraucht)
  corners: { x: number; y: number }[]; // 4 Ecken der Platte in mm (gegen den Uhrzeigersinn)
  coverage: number;              // Anteil der Platte am Bild (0…1)
  holeCount: number;
  threshold: number;             // benutzte Schwelle
  usedRef: boolean;
}

/** Helligkeit 0…255 */
function lum(d: Img["data"], i: number) { return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; }

/** Kasten-Weichzeichner (Radius r) auf einem Float-Feld */
function blur(a: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return a;
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    let s = 0, n = 0;
    for (let x = -r; x < w + r; x++) {
      if (x + r < w) { s += a[y * w + x + r]; n++; }
      if (x - r - 1 >= 0) { s -= a[y * w + x - r - 1]; n--; }
      if (x >= 0 && x < w) tmp[y * w + x] = s / n;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let y = -r; y < h + r; y++) {
      if (y + r < h) { s += tmp[(y + r) * w + x]; n++; }
      if (y - r - 1 >= 0) { s -= tmp[(y - r - 1) * w + x]; n--; }
      if (y >= 0 && y < h) out[y * w + x] = s / n;
    }
  }
  return out;
}

/** Otsu-Schwelle für Werte 0…max (256 Stufen) */
export function otsu(v: Float32Array, max: number, valid?: Uint8Array): number {
  const hist = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < v.length; i++) {
    if (valid && !valid[i]) continue;
    hist[Math.max(0, Math.min(255, Math.round((v[i] / max) * 255)))]++; total++;
  }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = i; }
  }
  return ((thr + 0.5) / 255) * max;
}

/** Maske dehnen (Wert 1) bzw. schrumpfen – quadratisch, Radius r */
function morph(m: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  const f = new Float32Array(m.length);
  for (let i = 0; i < m.length; i++) f[i] = m[i];
  const b = blur(f, w, h, r);
  const out = new Uint8Array(m.length);
  // grow: irgendein Nachbar ist 1 → 1; shrink: alle Nachbarn 1 → 1
  for (let i = 0; i < m.length; i++) out[i] = grow ? (b[i] > 1e-6 ? 1 : 0) : (b[i] > 1 - 1e-6 ? 1 : 0);
  return out;
}

/** Zusammenhängende Flächen (4er-Nachbarschaft) mit Wert v; liefert Kennzahl je Pixel und Größen */
function components(m: Uint8Array, w: number, h: number, v: number): { label: Int32Array; sizes: number[]; touchesEdge: boolean[] } {
  const label = new Int32Array(m.length).fill(-1);
  const sizes: number[] = [], touchesEdge: boolean[] = [];
  const stack: number[] = [];
  for (let s = 0; s < m.length; s++) {
    if (m[s] !== v || label[s] >= 0) continue;
    const id = sizes.length;
    let size = 0, edge = false;
    stack.push(s); label[s] = id;
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      if (x > 0 && m[i - 1] === v && label[i - 1] < 0) { label[i - 1] = id; stack.push(i - 1); }
      if (x < w - 1 && m[i + 1] === v && label[i + 1] < 0) { label[i + 1] = id; stack.push(i + 1); }
      if (y > 0 && m[i - w] === v && label[i - w] < 0) { label[i - w] = id; stack.push(i - w); }
      if (y < h - 1 && m[i + w] === v && label[i + w] < 0) { label[i + w] = id; stack.push(i + w); }
    }
    sizes.push(size); touchesEdge.push(edge);
  }
  return { label, sizes, touchesEdge };
}

/** Kleinstes umschließendes Rechteck (beliebig gedreht) der Punkte → 4 Ecken */
export function minAreaRect(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: any, a: any, b: any) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: any[] = [], up: any[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  const hull = lo.slice(0, -1).concat(up.slice(0, -1));
  let best: { x: number; y: number }[] = [], bestA = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len; // Kante = Achse u, Normale v
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of hull) {
      const u = q.x * ux + q.y * uy, v = -q.x * uy + q.y * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < bestA) {
      bestA = area;
      const P = (u: number, v: number) => ({ x: u * ux - v * uy, y: u * uy + v * ux });
      best = [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)];
    }
  }
  return best;
}

/**
 * Material erkennen.
 * @param cur        Bett mit Material (entzerrt)
 * @param ref        leeres Bett (gleiche Größe) oder null
 * @param mmPerPx    Maßstab des Bildes
 * @param sensitivity -50…+50: höher = mehr wird als Material erkannt
 * @param minHoleMm2 kleinere Löcher werden ignoriert (Rauschen, Maserung)
 */
export function detectMaterial(cur: Img, ref: Img | null, mmPerPx: number, sensitivity = 0, minHoleMm2 = 30): DetectResult | null {
  const { w, h } = cur;
  const n = w * h;
  if (!n || (ref && (ref.w !== w || ref.h !== h))) return null;
  // Pixel außerhalb des Kamerabilds (durchsichtig nach dem Entzerren) zählen nicht
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) valid[i] = cur.data[i * 4 + 3] > 0 && (!ref || ref.data[i * 4 + 3] > 0) ? 1 : 0;

  const r = Math.max(1, Math.round(1 / mmPerPx)); // ca. 1 mm weichzeichnen
  let feat: Float32Array = new Float32Array(n), max = 255;
  if (ref) {
    // Helligkeit angleichen (Mittelwert), dann Farbabstand
    let sc = 0, sr = 0, k = 0;
    for (let i = 0; i < n; i++) if (valid[i]) { sc += lum(cur.data, i * 4); sr += lum(ref.data, i * 4); k++; }
    const gain = k && sc > 0 ? sr / sc : 1;
    for (let i = 0; i < n; i++) {
      if (!valid[i]) continue;
      const o = i * 4;
      const dr = cur.data[o] * gain - ref.data[o], dg = cur.data[o + 1] * gain - ref.data[o + 1], db = cur.data[o + 2] * gain - ref.data[o + 2];
      feat[i] = Math.sqrt(dr * dr + dg * dg + db * db);
    }
    max = 442;
  } else {
    for (let i = 0; i < n; i++) feat[i] = lum(cur.data, i * 4);
  }
  feat = blur(feat, w, h, r);
  let thr = otsu(feat, max, valid);
  if (ref) thr = Math.max(thr, 18);          // nie auf Bildrauschen reinfallen
  thr *= 1 - Math.max(-50, Math.min(50, sensitivity)) / 100;

  let mask: Uint8Array = new Uint8Array(n);
  if (ref) {
    for (let i = 0; i < n; i++) mask[i] = valid[i] && feat[i] > thr ? 1 : 0;
  } else {
    // Hell/dunkel: Material ist die Klasse, die weniger am Rand liegt
    let edgeBright = 0, edgeAll = 0;
    for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const i = y * w + x; if (valid[i]) { edgeAll++; if (feat[i] > thr) edgeBright++; } }
    for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { const i = y * w + x; if (valid[i]) { edgeAll++; if (feat[i] > thr) edgeBright++; } }
    const brightIsMaterial = edgeBright < edgeAll / 2;
    for (let i = 0; i < n; i++) mask[i] = valid[i] && ((feat[i] > thr) === brightIsMaterial) ? 1 : 0;
  }
  // Aufräumen: Lücken schließen (Maserung), dann Krümel weg
  const rr = Math.max(1, Math.round(2 / mmPerPx));
  mask = morph(morph(mask, w, h, rr, true), w, h, rr, false);
  mask = morph(morph(mask, w, h, rr, false), w, h, rr, true);

  // Größte Fläche = Platte
  const comp = components(mask, w, h, 1);
  if (!comp.sizes.length) return { w, h, plate: new Uint8Array(n), holes: new Uint8Array(n), corners: [], coverage: 0, holeCount: 0, threshold: thr, usedRef: !!ref };
  let big = 0;
  comp.sizes.forEach((s, i) => { if (s > comp.sizes[big]) big = i; });
  const plate = new Uint8Array(n);
  for (let i = 0; i < n; i++) plate[i] = comp.label[i] === big ? 1 : 0;

  // Löcher = Nicht-Material, das den Rand nicht berührt und ganz von der Platte umgeben ist
  const bg = components(plate, w, h, 0);
  const minPx = minHoleMm2 / (mmPerPx * mmPerPx);
  const holes = new Uint8Array(n);
  let holeCount = 0;
  const isHole = bg.sizes.map((s, i) => !bg.touchesEdge[i] && s >= minPx);
  isHole.forEach(v => { if (v) holeCount++; });
  for (let i = 0; i < n; i++) {
    const l = bg.label[i];
    if (l >= 0 && isHole[l]) holes[i] = 1;
    else if (l >= 0 && !bg.touchesEdge[l]) plate[i] = 1; // winziges „Loch“ = Rauschen → zur Platte
  }

  // Umriss in mm (Rand-Pixel der Platte reichen)
  const edgePts: { x: number; y: number }[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!plate[i] && !holes[i]) continue;
    const out = (xx: number, yy: number) => xx < 0 || yy < 0 || xx >= w || yy >= h || (!plate[yy * w + xx] && !holes[yy * w + xx]);
    if (out(x - 1, y) || out(x + 1, y) || out(x, y - 1) || out(x, y + 1)) {
      edgePts.push({ x: (x + 0.5) * mmPerPx, y: (h - y - 0.5) * mmPerPx });
    }
  }
  const rect = minAreaRect(edgePts);
  // gegen den Uhrzeigersinn
  let area = 0;
  for (let i = 0; i < rect.length; i++) { const a = rect[i], b = rect[(i + 1) % rect.length]; area += a.x * b.y - b.x * a.y; }
  const corners = area < 0 ? rect.reverse() : rect;
  let cov = 0, vc = 0;
  for (let i = 0; i < n; i++) if (valid[i]) { vc++; if (plate[i]) cov++; }
  return { w, h, plate, holes, corners, coverage: vc ? cov / vc : 0, holeCount, threshold: thr, usedRef: !!ref };
}

/** Punkt im Viereck (beliebige Ecken-Reihenfolge, nicht überkreuzt) */
export function inQuad(x: number, y: number, q: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    if (((q[i].y > y) !== (q[j].y > y)) && x < ((q[j].x - q[i].x) * (y - q[i].y)) / (q[j].y - q[i].y) + q[i].x) inside = !inside;
  }
  return inside;
}
