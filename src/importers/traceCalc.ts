/**
 * BILD NACHZEICHNEN – die Rechnung ohne Fenster (aus imageTrace.ts herausgelöst): automatische Schwelle, Weichzeichnen,
 * Umrisse (Marching Squares) und Mittellinien (centerline.ts). Zwilling in Rust: src-tauri/src/imagetrace.rs.
 * Das Graustufenbild ist ein Float32Array (wie toGray() es liefert); gerechnet wird wie in JavaScript mit Zahlen
 * doppelter Genauigkeit, gespeichert in Float32Array wird auf einfache Genauigkeit gerundet.
 */
import { marchingSquares, simplifyClosed } from "../traceUtil.ts";
import { pathArea } from "../shapeTransform.ts";
import { centerlines } from "../centerline.ts";

export interface TraceOpts { threshold: number; invert: boolean; blur: number; smooth: number; minArea: number; widthMm: number; center: boolean; }
/** Ein Ergebnis: Umriss (geschlossen) oder Mittellinie (meist offen) */
export interface TracePath { pts: { x: number; y: number }[]; closed: boolean }
/** Mittellinie wird auf höchstens so viele Pixel verkleinert gerechnet (Ausdünnen ist bei großen Bildern langsam) */
const CENTER_SIDE = 900;

/** Automatische Schwelle (Otsu-Verfahren) */
export function otsu(gray: Float32Array): number {
  const hist = new Array(256).fill(0);
  for (const g of gray) hist[Math.max(0, Math.min(255, Math.round(g)))]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, first = 128, last = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best * (1 + 1e-9)) { best = between; first = last = t; }
    else if (between >= best * (1 - 1e-9)) last = t;
  }
  // Bei reinen Schwarz/Weiß-Bildern ist jeder Wert dazwischen gleich gut -> Mitte nehmen
  return Math.max(1, Math.min(254, Math.round((first + last) / 2) + 1));
}

export function boxBlur(src: Float32Array, W: number, H: number, r: number): Float32Array {
  if (r <= 0) return src;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * W + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = acc / (2 * r + 1);
      acc += src[y * W + Math.min(W - 1, x + r + 1)] - src[y * W + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
    }
  }
  return out;
}

export function trace(gray: Float32Array, W: number, H: number, o: TraceOpts): { x: number; y: number }[][] {
  const g = boxBlur(gray, W, H, o.blur);
  // Rand von 1 Pixel "außen", damit sich alle Konturen schließen
  const PW = W + 2, PH = H + 2;
  const v = new Float32Array(PW * PH);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const val = g[y * W + x];
    v[(y + 1) * PW + x + 1] = o.invert ? val : 255 - val; // "innen" = dunkel (bzw. hell bei Umkehren)
  }
  const iso = o.invert ? o.threshold : 255 - o.threshold;
  return marchingSquares(v, PW, PH, iso)
    .map(l => simplifyClosed(l.map(p => ({ x: p.x - 1, y: p.y - 1 })), o.smooth * 0.5))
    .filter(l => l.length >= 3 && Math.abs(pathArea(l)) >= Math.max(1, o.minArea));
}

/** Mittellinien: Maske wie beim Umriss (dunkel = Strich), dann ausdünnen und nachfahren */
export function traceCenter(gray: Float32Array, W: number, H: number, o: TraceOpts): TracePath[] {
  const g = boxBlur(gray, W, H, o.blur);
  const k = Math.min(1, CENTER_SIDE / Math.max(W, H));
  const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = g[Math.min(H - 1, Math.floor(y / k)) * W + Math.min(W - 1, Math.floor(x / k))];
    mask[y * w + x] = (o.invert ? v >= o.threshold : v < o.threshold) ? 1 : 0;
  }
  // Mindestlänge aus „Flecken ignorieren“ (Fläche → Seitenlänge), Vereinfachung aus „Glätten“
  const minLen = Math.max(3, Math.sqrt(o.minArea) * k);
  return centerlines(mask, w, h, minLen, Math.max(0.3, o.smooth * 0.6))
    .map(p => ({ pts: p.pts.map(q => ({ x: q.x / k, y: q.y / k })), closed: p.closed }));
}

/** Was der Dialog anzeigt und einfügt: Umrisse (geschlossen) oder Mittellinien */
export function traceAll(gray: Float32Array, W: number, H: number, o: TraceOpts): TracePath[] {
  return o.center ? traceCenter(gray, W, H, o) : trace(gray, W, H, o).map(l => ({ pts: l, closed: true }));
}

/** Auftrag für Rust (import_trace): 4 Bytes Länge (little-endian), JSON mit Größe und Einstellungen, dann die Graustufen als f32 */
export function traceBody(gray: Float32Array, W: number, H: number, o: TraceOpts): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify({ w: W, h: H, threshold: o.threshold, invert: o.invert, blur: o.blur, smooth: o.smooth, minArea: o.minArea, center: o.center }));
  const out = new Uint8Array(4 + head.length + gray.length * 4);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  const g = new Uint8Array(gray.buffer, gray.byteOffset, gray.length * 4);
  // f32 in der Reihenfolge des Rechners (little-endian auf allen Zielen von CNC Craft)
  out.set(g, 4 + head.length);
  return out;
}
