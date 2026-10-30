/**
 * STL-LOADER: Liest STL-Dateien (Binär UND ASCII) und schneidet daraus 2D-Konturen.
 * 3MF und STEP werden in importers/meshImport.ts in dieselbe Dreiecksliste umgewandelt.
 *
 * Ablauf:
 *   1. parseStl()        -> Datei lesen (Binär oder Text), alle Dreiecke in mm
 *   2. weldMesh()        -> gleiche Eckpunkte zusammenfassen (einmal pro Datei)
 *   3. sliceMesh()       -> Schnitt auf einer Höhe, Konturen exakt über die
 *                           Dreieckskanten verketten (keine Rate-Toleranz mehr)
 *   4. findBestHeight()  -> optional: Höhe mit dem größten Umriss suchen
 *
 * Diese Datei greift NICHT auf das HTML zu. Dadurch lässt sie sich auch
 * ohne Oberfläche testen.
 */
import { t } from "./i18n/i18n";

export type StlView = "top" | "bottom" | "front" | "back" | "left" | "right";

export type MeshFormat = "binary" | "ascii" | "3mf" | "step";

export interface StlMesh {
  /** 9 Werte pro Dreieck: x1,y1,z1, x2,y2,z2, x3,y3,z3 */
  positions: Float32Array;
  triangleCount: number;
  format: MeshFormat;
  min: [number, number, number];
  max: [number, number, number];
}

export interface WeldedMesh {
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  /** 3 Eckpunkt-Nummern pro Dreieck */
  tris: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

export interface Pt { u: number; v: number; }

export interface SliceLoop {
  points: Pt[];
  closed: boolean;
  isHole: boolean;
  /** Fläche mit Vorzeichen: Außenkontur > 0 (gegen Uhrzeigersinn), Loch < 0 */
  area: number;
}

export interface SliceResult {
  height: number;          // Schnitthöhe in mm (im Ansichts-System)
  loops: SliceLoop[];
  outerCount: number;
  holeCount: number;
  openCount: number;       // nicht geschlossene Linien (Modell undicht)
  minU: number; maxU: number; minV: number; maxV: number;
}

// =====================================================================
// 1. STL EINLESEN
// =====================================================================

export function parseStl(buffer: ArrayBuffer): StlMesh {
  if (buffer.byteLength < 15) throw new Error(t("stl.errSmall"));

  const dv = new DataView(buffer);
  let isBinary = false;
  if (buffer.byteLength >= 84) {
    const count = dv.getUint32(80, true);
    const expected = 84 + count * 50;
    // Exakt passende Größe = sicher binär (auch wenn der Kopf mit "solid" beginnt!)
    if (expected === buffer.byteLength) isBinary = true;
    // Manche Programme hängen ein paar Bytes an
    else if (count > 0 && expected < buffer.byteLength && !startsWithSolid(buffer)) isBinary = true;
  }

  const mesh = isBinary ? parseBinary(dv) : parseAscii(buffer);
  if (mesh.triangleCount === 0) throw new Error(t("stl.errNoTriangles"));
  return mesh;
}

function startsWithSolid(buffer: ArrayBuffer): boolean {
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 300));
  const text = new TextDecoder("ascii").decode(head).trimStart().toLowerCase();
  return text.startsWith("solid") && text.includes("facet");
}

function parseBinary(dv: DataView): StlMesh {
  const declared = dv.getUint32(80, true);
  const possible = Math.floor((dv.byteLength - 84) / 50);
  const count = Math.min(declared, possible);
  const positions = new Float32Array(count * 9);

  let off = 84;
  for (let i = 0; i < count; i++) {
    // 12 Bytes Normale überspringen, dann 3 Eckpunkte à 3 Floats
    for (let k = 0; k < 9; k++) {
      positions[i * 9 + k] = dv.getFloat32(off + 12 + k * 4, true);
    }
    off += 50;
  }
  return finishMesh(positions, "binary");
}

function parseAscii(buffer: ArrayBuffer): StlMesh {
  const text = new TextDecoder("utf-8").decode(buffer);
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const values: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    values.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
  }
  const usable = values.length - (values.length % 9);
  return finishMesh(new Float32Array(values.slice(0, usable)), "ascii");
}

/** Dreiecksliste (9 Werte je Dreieck) -> Modell mit Größe */
export function meshFromPositions(positions: Float32Array, format: MeshFormat): StlMesh {
  return finishMesh(positions, format);
}

function finishMesh(positions: Float32Array, format: MeshFormat): StlMesh {
  // NaN fällt bei den Vergleichen von selbst heraus, ±Unendlich wird ausdrücklich übergangen
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < x0 && x > -Infinity) x0 = x; if (x > x1 && x < Infinity) x1 = x;
    if (y < y0 && y > -Infinity) y0 = y; if (y > y1 && y < Infinity) y1 = y;
    if (z < z0 && z > -Infinity) z0 = z; if (z > z1 && z < Infinity) z1 = z;
  }
  return { positions, triangleCount: positions.length / 9, format, min: [x0, y0, z0], max: [x1, y1, z1] };
}

// =====================================================================
// 2. GLEICHE ECKPUNKTE ZUSAMMENFASSEN ("Verschweißen")
// =====================================================================

export function weldMesh(mesh: StlMesh): WeldedMesh {
  // Schnell: die Float32-Bits direkt als Schlüssel (Hash-Tabelle mit offener Adressierung)
  // statt Text-Schlüssel "x,y,z" in einer Map – bei Millionen Dreiecken ~20× schneller
  const p = mesh.positions;
  const bits = new Uint32Array(p.buffer, p.byteOffset, mesh.triangleCount * 9);
  const corners = mesh.triangleCount * 3;
  const tris = new Uint32Array(corners);
  let cap = 1 << 10;
  while (cap < corners * 0.4) cap <<= 1;                // meist teilen sich ~6 Dreiecke eine Ecke (wächst sonst mit)
  let mask = cap - 1;
  let table = new Int32Array(cap).fill(-1);            // Tabelle -> Eckpunkt-Nummer
  let vb = new Uint32Array(Math.max(16, corners >> 2) * 3); // Bits der Eckpunkte (x,y,z)
  let n = 0;
  // -0 und 0 sind derselbe Punkt
  const norm = (b: number) => (b === 0x80000000 ? 0 : b);
  // Bits gut durchmischen: glatte Maße (z. B. 10.5) haben unten lauter Nullen
  const hash = (x: number, y: number, z: number) => {
    let h = Math.imul(x ^ (x >>> 15), 0x9e3779b1) ^ Math.imul(y ^ (y >>> 15), 0x85ebca77) ^ Math.imul(z ^ (z >>> 15), 0xc2b2ae3d);
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  };
  const grow = () => {
    cap <<= 1; mask = cap - 1;
    table = new Int32Array(cap).fill(-1);
    for (let id = 0; id < n; id++) {
      let h = hash(vb[id * 3], vb[id * 3 + 1], vb[id * 3 + 2]) & mask;
      while (table[h] !== -1) h = (h + 1) & mask;
      table[h] = id;
    }
  };

  for (let i = 0; i < corners; i++) {
    const x = norm(bits[i * 3]), y = norm(bits[i * 3 + 1]), z = norm(bits[i * 3 + 2]);
    let h = hash(x, y, z) & mask;
    let id = table[h];
    while (id !== -1 && (vb[id * 3] !== x || vb[id * 3 + 1] !== y || vb[id * 3 + 2] !== z)) {
      h = (h + 1) & mask;
      id = table[h];
    }
    if (id === -1) {
      id = n++;
      if (n * 3 > vb.length) { const v2 = new Uint32Array(vb.length * 2); v2.set(vb); vb = v2; }
      vb[id * 3] = x; vb[id * 3 + 1] = y; vb[id * 3 + 2] = z;
      table[h] = id;
      if (n * 2 > cap) grow();
    }
    tris[i] = id;
  }

  const f = new Float32Array(vb.buffer, 0, n * 3);
  const xs = new Float64Array(n), ys = new Float64Array(n), zs = new Float64Array(n);
  for (let id = 0; id < n; id++) { xs[id] = f[id * 3]; ys[id] = f[id * 3 + 1]; zs[id] = f[id * 3 + 2]; }
  return { x: xs, y: ys, z: zs, tris, vertexCount: n, triangleCount: mesh.triangleCount };
}

// =====================================================================
// 3. BLICKRICHTUNG: u = rechts, v = oben, w = Höhe (zum Betrachter hin)
//    Die Achsen sind so gewählt, dass nichts gespiegelt wird.
// =====================================================================

export function viewCoords(mesh: WeldedMesh, view: StlView) {
  const n = mesh.vertexCount;
  const u = new Float64Array(n), v = new Float64Array(n), w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = mesh.x[i], y = mesh.y[i], z = mesh.z[i];
    switch (view) {
      case "top":    u[i] = x;  v[i] = y; w[i] = z;  break;
      case "bottom": u[i] = -x; v[i] = y; w[i] = -z; break;
      case "front":  u[i] = x;  v[i] = z; w[i] = -y; break;
      case "back":   u[i] = -x; v[i] = z; w[i] = y;  break;
      case "left":   u[i] = -y; v[i] = z; w[i] = -x; break;
      case "right":  u[i] = y;  v[i] = z; w[i] = x;  break;
    }
  }
  let minW = Infinity, maxW = -Infinity;
  for (let i = 0; i < n; i++) { if (w[i] < minW) minW = w[i]; if (w[i] > maxW) maxW = w[i]; }
  return { u, v, w, minW, maxW };
}

export type ViewCoords = ReturnType<typeof viewCoords>;

// =====================================================================
// 4. SCHNITT AUF EINER HÖHE
// =====================================================================

const STITCH_TOL = 0.05;     // mm: nur für kaputte/undichte Modelle
const SIMPLIFY_TOL = 0.003;  // mm: entfernt überflüssige Punkte auf geraden Strecken

/**
 * Höhen-Index: die Höhe (w) wird in Schichten geteilt, jede Schicht kennt ihre Dreiecke.
 * Ein Schnitt schaut dann nur die Dreiecke seiner Schicht an statt alle (wichtig bei Millionen Dreiecken,
 * die automatische Höhensuche schneidet 40-mal).
 */
interface SlabIndex { minW: number; binW: number; bins: number; start: Uint32Array; list: Uint32Array }
const slabCache = new WeakMap<ViewCoords, SlabIndex>();

function slabIndex(mesh: WeldedMesh, vc: ViewCoords): SlabIndex {
  const cached = slabCache.get(vc);
  if (cached) return cached;
  const { w } = vc, tris = mesh.tris, T = mesh.triangleCount;
  const span = vc.maxW - vc.minW;
  // Schichtdicke nach der mittleren Dreieckshöhe wählen: ein Dreieck liegt dann meist in 1–3 Schichten
  // (sonst würde ein dünnes, fein aufgelöstes Modell wie ein Lithophan riesige Listen erzeugen)
  let ext = 0;
  for (let t = 0; t < T; t++) {
    const wa = w[tris[t * 3]], wb = w[tris[t * 3 + 1]], wc = w[tris[t * 3 + 2]];
    ext += Math.max(wa, wb, wc) - Math.min(wa, wb, wc);
  }
  ext /= Math.max(1, T);
  const bins = Math.max(1, Math.min(512, Math.floor(T / 32), ext > 0 ? Math.floor(span / (2 * ext)) : 512));
  const binW = span > 0 ? span / bins : 1;
  const bin = (x: number) => Math.max(0, Math.min(bins - 1, Math.floor((x - vc.minW) / binW)));
  const lo = new Uint16Array(T), hi = new Uint16Array(T);
  const count = new Uint32Array(bins + 1);
  for (let t = 0; t < T; t++) {
    const wa = w[tris[t * 3]], wb = w[tris[t * 3 + 1]], wc = w[tris[t * 3 + 2]];
    const b0 = bin(Math.min(wa, wb, wc)), b1 = bin(Math.max(wa, wb, wc));
    lo[t] = b0; hi[t] = b1;
    for (let b = b0; b <= b1; b++) count[b + 1]++;
  }
  for (let b = 0; b < bins; b++) count[b + 1] += count[b];
  const start = count.slice();
  const fill = count.slice(0, bins);
  const list = new Uint32Array(start[bins]);
  for (let t = 0; t < T; t++) for (let b = lo[t]; b <= hi[t]; b++) list[fill[b]++] = t;
  const idx = { minW: vc.minW, binW, bins, start, list };
  slabCache.set(vc, idx);
  return idx;
}

export function sliceMesh(mesh: WeldedMesh, vc: ViewCoords, height: number): SliceResult {
  const { u, v, w } = vc;
  const tris = mesh.tris;
  const slab = slabIndex(mesh, vc);
  const sb = Math.max(0, Math.min(slab.bins - 1, Math.floor((height - slab.minW) / slab.binW)));

  // Jeder Schnittpunkt liegt auf einer Dreieckskante. Die Kante (a,b) bekommt
  // eine eindeutige Nummer -> zwei Nachbardreiecke liefern exakt denselben Punkt.
  // Zahlen-Tabelle (offene Adressierung) statt Map: viel schneller bei zehntausenden Kanten je Schnitt
  const cand = slab.start[sb + 1] - slab.start[sb];
  let cap = 64;
  while (cap < cand * 4) cap <<= 1;
  const mask = cap - 1;
  const keyA = new Int32Array(cap).fill(-1), keyB = new Int32Array(cap), keyId = new Int32Array(cap);
  const pu: number[] = [], pv: number[] = [];
  const segA: number[] = [], segB: number[] = [];

  const edgePoint = (a: number, b: number): number => {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    let h = (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca77)) >>> 0;
    h = (h ^ (h >>> 15)) & mask;
    while (keyA[h] !== -1) {
      if (keyA[h] === lo && keyB[h] === hi) return keyId[h];
      h = (h + 1) & mask;
    }
    const t = (height - w[a]) / (w[b] - w[a]);
    const id = pu.length;
    pu.push(u[a] + t * (u[b] - u[a]));
    pv.push(v[a] + t * (v[b] - v[a]));
    keyA[h] = lo; keyB[h] = hi; keyId[h] = id;
    return id;
  };

  // Nur die Dreiecke der passenden Schicht (in Original-Reihenfolge -> gleiches Ergebnis wie vorher)
  for (let k = slab.start[sb], kEnd = slab.start[sb + 1]; k < kEnd; k++) {
    const t = slab.list[k];
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    // Punkte genau auf der Ebene zählen als "oben" -> keine Sonderfälle nötig
    const ua = w[a] >= height, ub = w[b] >= height, uc = w[c] >= height;
    if (ua === ub && ub === uc) continue;

    // Der Eckpunkt, der allein auf seiner Seite liegt
    let lone: number, o1: number, o2: number;
    if (ua !== ub && ua !== uc) { lone = a; o1 = b; o2 = c; }
    else if (ub !== ua && ub !== uc) { lone = b; o1 = c; o2 = a; }
    else { lone = c; o1 = a; o2 = b; }

    const p1 = edgePoint(lone, o1);
    const p2 = edgePoint(lone, o2);
    if (p1 !== p2) { segA.push(p1); segB.push(p2); }
  }

  // ---- Segmente über gemeinsame Punkte verketten ----
  // Je Punkt meist genau 2 Segmente (dichtes Modell): zwei feste Plätze, weitere (undicht/verzweigt) in einer Liste.
  // Reihenfolge bleibt wie beim Eintragen -> gleiche Ketten wie vorher.
  const P = pu.length;
  const at0 = new Int32Array(P).fill(-1), at1 = new Int32Array(P).fill(-1);
  const more = new Map<number, number[]>();
  const addAt = (p: number, sIdx: number) => {
    if (at0[p] < 0) at0[p] = sIdx;
    else if (at1[p] < 0) at1[p] = sIdx;
    else { const l = more.get(p); if (l) l.push(sIdx); else more.set(p, [sIdx]); }
  };
  for (let sIdx = 0; sIdx < segA.length; sIdx++) { addAt(segA[sIdx], sIdx); addAt(segB[sIdx], sIdx); }
  /** erstes noch nicht benutztes Segment an Punkt p (-1 = keins) */
  const freeAt = (p: number): number => {
    if (at0[p] >= 0 && !used[at0[p]]) return at0[p];
    if (at1[p] >= 0 && !used[at1[p]]) return at1[p];
    const l = more.get(p);
    if (l) for (const x of l) if (!used[x]) return x;
    return -1;
  };

  const used = new Uint8Array(segA.length);
  const chains: { ids: number[]; closed: boolean }[] = [];

  const walk = (startPoint: number, firstSeg: number, ids: number[]): number => {
    let seg = firstSeg;
    let cur = startPoint;
    while (seg >= 0) {
      used[seg] = 1;
      const next = segA[seg] === cur ? segB[seg] : segA[seg];
      ids.push(next);
      cur = next;
      seg = freeAt(cur);
    }
    return cur;
  };

  for (let s = 0; s < segA.length; s++) {
    if (used[s]) continue;
    const ids = [segA[s]];
    const end = walk(segA[s], s, ids);
    if (end === ids[0] && ids.length > 3) {
      ids.pop();
      chains.push({ ids, closed: true });
    } else {
      // Offene Kette: auch in die andere Richtung verlängern
      const back: number[] = [];
      const other = freeAt(ids[0]);
      if (other >= 0) walk(ids[0], other, back);
      chains.push({ ids: [...back.reverse(), ...ids], closed: false });
    }
  }

  // ---- In Punktlisten umwandeln ----
  let loops: { points: Pt[]; closed: boolean }[] = chains.map(ch => ({
    points: ch.ids.map(id => ({ u: pu[id], v: pv[id] })),
    closed: ch.closed
  }));

  // ---- Undichte Modelle: offene Enden mit kleiner Toleranz zusammenführen ----
  loops = stitchOpenChains(loops);

  // ---- Aufräumen ----
  const cleaned: SliceLoop[] = [];
  for (const l of loops) {
    let pts = removeDuplicates(l.points, l.closed);
    pts = l.closed ? simplifyClosed(pts, SIMPLIFY_TOL) : douglasPeucker(pts, SIMPLIFY_TOL);
    if (l.closed && pts.length < 3) continue;
    if (!l.closed && pts.length < 2) continue;
    const area = l.closed ? signedArea(pts) : 0;
    if (l.closed && Math.abs(area) < 1e-4) continue; // winzige Splitter
    cleaned.push({ points: pts, closed: l.closed, isHole: false, area });
  }

  classifyAndOrient(cleaned);

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const l of cleaned) for (const p of l.points) {
    if (p.u < minU) minU = p.u; if (p.u > maxU) maxU = p.u;
    if (p.v < minV) minV = p.v; if (p.v > maxV) maxV = p.v;
  }

  return {
    height,
    loops: cleaned,
    outerCount: cleaned.filter(l => l.closed && !l.isHole).length,
    holeCount: cleaned.filter(l => l.closed && l.isHole).length,
    openCount: cleaned.filter(l => !l.closed).length,
    minU, maxU, minV, maxV
  };
}

/**
 * Probiert viele Höhen durch und nimmt die mit der größten Außenfläche.
 * Für die meisten Fräs- und Laserteile ist das genau der Umriss, den man will.
 */
export function findBestHeight(mesh: WeldedMesh, vc: ViewCoords, samples = 40): number {
  const span = vc.maxW - vc.minW;
  if (span <= 0) return vc.minW;
  let best = vc.minW + span / 2;
  let bestArea = -1;
  for (let i = 0; i < samples; i++) {
    const h = vc.minW + span * (i + 0.5) / samples;
    const r = sliceMesh(mesh, vc, h);
    const area = r.loops.reduce((sum, l) => sum + (l.closed && !l.isHole ? Math.abs(l.area) : 0), 0);
    if (area > bestArea * 1.0001) { bestArea = area; best = h; }
  }
  return best;
}

// =====================================================================
// HILFSFUNKTIONEN
// =====================================================================

function stitchOpenChains(loops: { points: Pt[]; closed: boolean }[]) {
  const closed = loops.filter(l => l.closed);
  const open = loops.filter(l => !l.closed).map(l => l.points.slice());
  const d = (a: Pt, b: Pt) => Math.hypot(a.u - b.u, a.v - b.v);

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < open.length && !changed; i++) {
      const a = open[i];
      // Schließt sich die Kette selbst?
      if (a.length > 2 && d(a[0], a[a.length - 1]) < STITCH_TOL) {
        a.pop();
        closed.push({ points: a, closed: true });
        open.splice(i, 1);
        changed = true;
        break;
      }
      // Passt eine andere Kette an das Ende?
      let bestJ = -1, bestRev = false, bestD = STITCH_TOL;
      const end = a[a.length - 1];
      for (let j = 0; j < open.length; j++) {
        if (j === i) continue;
        const b = open[j];
        const ds = d(end, b[0]), de = d(end, b[b.length - 1]);
        if (ds < bestD) { bestD = ds; bestJ = j; bestRev = false; }
        if (de < bestD) { bestD = de; bestJ = j; bestRev = true; }
      }
      if (bestJ >= 0) {
        const b = open[bestJ];
        if (bestRev) b.reverse();
        open[i] = a.concat(b);
        open.splice(bestJ, 1);
        changed = true;
      }
    }
  }
  return [...closed, ...open.map(points => ({ points, closed: false }))];
}

function removeDuplicates(pts: Pt[], closed: boolean): Pt[] {
  const out: Pt[] = [];
  const EPS2 = 1e-12; // (1e-6 mm)²
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || (p.u - last.u) ** 2 + (p.v - last.v) ** 2 > EPS2) out.push(p);
  }
  if (closed && out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if ((f.u - l.u) ** 2 + (f.v - l.v) ** 2 <= EPS2) out.pop();
  }
  return out;
}

/** Abstand² von p zur Strecke a–b (ohne Wurzel – zum Vergleichen reicht das und ist schneller) */
function perpDist2(p: Pt, a: Pt, b: Pt): number {
  const dx = b.u - a.u, dy = b.v - a.v;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return (p.u - a.u) ** 2 + (p.v - a.v) ** 2;
  let t = ((p.u - a.u) * dx + (p.v - a.v) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = p.u - (a.u + t * dx), ey = p.v - (a.v + t * dy);
  return ex * ex + ey * ey;
}

function douglasPeucker(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const tol2 = tol * tol;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    const ps = pts[s], pe = pts[e];
    for (let i = s + 1; i < e; i++) {
      const dd = perpDist2(pts[i], ps, pe);
      if (dd > maxD) { maxD = dd; idx = i; }
    }
    if (idx >= 0 && maxD > tol2) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function simplifyClosed(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 4) return pts;
  // Am weitesten entfernten Punkt teilen, dann beide Hälften vereinfachen
  let far = 0, farD = -1;
  for (let i = 1; i < pts.length; i++) {
    const dd = (pts[i].u - pts[0].u) ** 2 + (pts[i].v - pts[0].v) ** 2;
    if (dd > farD) { farD = dd; far = i; }
  }
  const a = douglasPeucker(pts.slice(0, far + 1), tol);
  const b = douglasPeucker([...pts.slice(far), pts[0]], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

export function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].u * pts[i].v) - (pts[i].u * pts[j].v);
  }
  return a / 2;
}

export function pointInPolygon(px: number, py: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].u, yi = poly[i].v, xj = poly[j].u, yj = poly[j].v;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/**
 * Loch oder Außenkontur? Wir zählen, in wie vielen anderen Konturen ein Punkt
 * DIESER Kontur liegt. Ungerade = Loch. Danach einheitliche Drehrichtung:
 * Außen gegen den Uhrzeigersinn, Löcher im Uhrzeigersinn.
 */
function classifyAndOrient(loops: SliceLoop[]) {
  const closed = loops.filter(l => l.closed);
  // Umgebendes Rechteck je Kontur: Punkt außerhalb -> teurer Punkt-in-Polygon-Test entfällt
  const box = closed.map(l => {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of l.points) { if (p.u < u0) u0 = p.u; if (p.u > u1) u1 = p.u; if (p.v < v0) v0 = p.v; if (p.v > v1) v1 = p.v; }
    return [u0, u1, v0, v1];
  });
  for (let li = 0; li < closed.length; li++) {
    const loop = closed[li];
    const probe = loop.points[0];
    let depth = 0;
    for (let oi = 0; oi < closed.length; oi++) {
      const other = closed[oi];
      if (other === loop) continue;
      if (Math.abs(other.area) < Math.abs(loop.area)) continue; // kleinere können uns nicht umschließen
      const b = box[oi];
      if (probe.u < b[0] || probe.u > b[1] || probe.v < b[2] || probe.v > b[3]) continue;
      if (pointInPolygon(probe.u, probe.v, other.points)) depth++;
    }
    loop.isHole = depth % 2 === 1;
    const wantPositive = !loop.isHole;
    if ((loop.area > 0) !== wantPositive) {
      loop.points.reverse();
      loop.area = -loop.area;
    }
  }
}
