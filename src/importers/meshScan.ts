/**
 * SCHNELL-LESER für die Dreiecks-Listen in 3MF-Dateien (<vertices> und <triangles>)
 *
 * Große 3MF (z. B. Lithophane) haben Millionen <vertex>/<triangle>-Einträge – oft über 1 GB XML. Der XML-Leser
 * (DOMParser) braucht dafür sehr lange und sehr viel Speicher. Darum werden diese Listen direkt aus den Bytes gelesen;
 * nur der kleine Rest (Objekte, Bauteile, Transformationen, Einheit) geht danach durch den DOMParser.
 *
 * Diese Datei greift nicht auf Oberfläche oder Übersetzungen zu: sie läuft auch im Web Worker (meshScanWorker.ts)
 * und lässt sich ohne Oberfläche testen.
 */

export interface MeshLists { xml: string; verts: Float64Array[]; tris: Uint32Array[] }

const C_LT = 60, C_GT = 62, C_SL = 47, C_COLON = 58, C_EQ = 61, C_DQ = 34, C_SQ = 39;
const POW10 = Array.from({ length: 41 }, (_, i) => Math.pow(10, i - 20));

/** Bytes ab i mit dem ASCII-Text s vergleichen */
function bytesAt(b: Uint8Array, i: number, s: string): boolean {
  for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false;
  return true;
}

/** Zahl aus Bytes [i, end) lesen (wie parseFloat, ohne Text zu erzeugen) */
export function numAt(b: Uint8Array, i: number, end: number): number {
  let neg = false, m = 0, e = 0, digits = 0, any = false;
  while (i < end && b[i] <= 32) i++;
  if (b[i] === 45) { neg = true; i++; } else if (b[i] === 43) i++;
  for (; i < end; i++) {
    const c = b[i] - 48;
    if (c < 0 || c > 9) break;
    any = true;
    if (digits < 15) { m = m * 10 + c; if (m) digits++; } else e++;
  }
  if (b[i] === 46) {
    for (i++; i < end; i++) {
      const c = b[i] - 48;
      if (c < 0 || c > 9) break;
      any = true;
      if (digits < 15) { m = m * 10 + c; e--; if (m) digits++; }
    }
  }
  if (!any) return NaN;
  if (b[i] === 101 || b[i] === 69) {
    i++;
    let eneg = false, ex = 0;
    if (b[i] === 45) { eneg = true; i++; } else if (b[i] === 43) i++;
    for (; i < end; i++) { const c = b[i] - 48; if (c < 0 || c > 9) break; ex = ex * 10 + c; }
    e += eneg ? -ex : ex;
  }
  const v = e >= -20 && e <= 20 ? (e < 0 ? m / POW10[20 - e] : m * POW10[20 + e]) : m * Math.pow(10, e);
  return neg ? -v : v;
}

/**
 * Alle Elemente <vertex x y z/> bzw. <triangle v1 v2 v3/> ab from lesen, bis zum ersten fremden End-Tag
 * (</vertices>). Fehlende Werte = 0. Rückgabe: je Element 3 Werte hintereinander und Lage des End-Tags.
 * Bewusst einfache Byte-Schleifen (schneller als indexOf je Element, wichtig bei 1 GB XML).
 */
function scanElements(b: Uint8Array, from: number, tri: boolean): { data: Float64Array | Uint32Array; end: number } {
  const tag = tri ? "triangle" : "vertex";
  const make = (len: number) => tri ? new Uint32Array(len) : new Float64Array(len);
  let out = make(3 << 15); // wächst bei Bedarf (verdoppeln)
  const N = b.length;
  let n = 0, i = from, end = -1;
  while (i < N) {
    while (i < N && b[i] !== C_LT) i++;
    if (i >= N) break;
    const lt = i++;
    const closing = b[i] === C_SL;
    if (closing) i++;
    // Name (mit möglichem Namensraum-Präfix "m:")
    let s = i;
    while (i < N && b[i] > 32 && b[i] !== C_GT && b[i] !== C_SL) { if (b[i] === C_COLON) s = i + 1; i++; }
    const isTag = i - s === tag.length && bytesAt(b, s, tag);
    if (closing && !isTag) { end = lt; break; }          // </vertices> – Liste zu Ende
    if (closing || !isTag) { while (i < N && b[i] !== C_GT) i++; i++; continue; }
    if (n * 3 + 3 > out.length) { const o2 = make(out.length * 2); o2.set(out); out = o2; }
    const base = n * 3;
    out[base] = 0; out[base + 1] = 0; out[base + 2] = 0;
    // Attribute bis zum Ende des Elements
    while (i < N && b[i] !== C_GT) {
      while (i < N && b[i] <= 32) i++;
      const as = i;
      while (i < N && b[i] > 32 && b[i] !== C_EQ && b[i] !== C_GT && b[i] !== C_SL) i++;
      const alen = i - as;
      while (i < N && b[i] <= 32) i++;
      if (b[i] !== C_EQ) { if (b[i] === C_SL) i++; continue; }
      i++;
      while (i < N && b[i] <= 32) i++;
      const q = b[i];
      if (q !== C_DQ && q !== C_SQ) continue;
      const vs = ++i;
      while (i < N && b[i] !== q) i++;
      const ve = i++;
      // welches Attribut? vertex: x/y/z, triangle: v1/v2/v3 (andere wie pid/p1 überspringen)
      let k = -1;
      if (!tri) { if (alen === 1) { k = b[as] - 120; if (k > 2) k = -1; } }
      else if (alen === 2 && b[as] === 118) { k = b[as + 1] - 49; if (k > 2) k = -1; }
      if (k >= 0) {
        const v = numAt(b, vs, ve);
        out[base + k] = Number.isFinite(v) ? v : 0;
      }
    }
    i++;
    n++;
  }
  return { data: out.slice(0, n * 3), end };
}

/**
 * Inhalte von <vertices> und <triangles> herausschneiden und schnell lesen.
 * Rückgabe: Rest-XML (mit leeren <vertices/>/<triangles>) und die gelesenen Listen in Dokument-Reihenfolge.
 */
export function extractMeshLists(b: Uint8Array): MeshLists {
  const verts: Float64Array[] = [], tris: Uint32Array[] = [];
  const keep: Uint8Array[] = [];
  let last = 0, i = 0;
  const N = b.length;
  while (i < N) {
    const lt = b.indexOf(C_LT, i);
    if (lt < 0) break;
    // Name des Elements
    let s = lt + 1, j = s;
    while (j < N && b[j] > 32 && b[j] !== C_GT && b[j] !== C_SL) { if (b[j] === C_COLON) s = j + 1; j++; }
    const isV = j - s === 8 && bytesAt(b, s, "vertices");
    const isT = !isV && j - s === 9 && bytesAt(b, s, "triangles");
    if (!isV && !isT) { i = lt + 1; continue; }
    const startEnd = b.indexOf(C_GT, j);
    if (startEnd < 0) break;
    if (b[startEnd - 1] === C_SL) {                                 // schon leer – Platz in der Reihenfolge halten
      if (isV) verts.push(new Float64Array(0)); else tris.push(new Uint32Array(0));
      i = startEnd + 1; continue;
    }
    const r = scanElements(b, startEnd + 1, isT);
    const closeAt = r.end;
    if (closeAt < 0) break;
    if (isV) verts.push(r.data as Float64Array); else tris.push(r.data as Uint32Array);
    keep.push(b.subarray(last, startEnd + 1));
    last = closeAt;
    i = closeAt + 1;
  }
  keep.push(b.subarray(last));
  const dec = new TextDecoder("utf-8");
  return { xml: keep.map(p => dec.decode(p)).join(""), verts, tris };
}
