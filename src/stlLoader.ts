/**
 * STL-LOADER: Liest STL-Dateien (Binär UND ASCII) und schneidet daraus 2D-Konturen.
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

export interface StlMesh {
  /** 9 Werte pro Dreieck: x1,y1,z1, x2,y2,z2, x3,y3,z3 */
  positions: Float32Array;
  triangleCount: number;
  format: "binary" | "ascii";
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

function finishMesh(positions: Float32Array, format: "binary" | "ascii"): StlMesh {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const val = positions[i + a];
      if (!Number.isFinite(val)) continue;
      if (val < min[a]) min[a] = val;
      if (val > max[a]) max[a] = val;
    }
  }
  return { positions, triangleCount: positions.length / 9, format, min, max };
}

// =====================================================================
// 2. GLEICHE ECKPUNKTE ZUSAMMENFASSEN ("Verschweißen")
// =====================================================================

export function weldMesh(mesh: StlMesh): WeldedMesh {
  const p = mesh.positions;
  const index = new Map<string, number>();
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  const tris = new Uint32Array(mesh.triangleCount * 3);

  for (let i = 0; i < mesh.triangleCount * 3; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const key = x + "," + y + "," + z;
    let id = index.get(key);
    if (id === undefined) {
      id = xs.length;
      index.set(key, id);
      xs.push(x); ys.push(y); zs.push(z);
    }
    tris[i] = id;
  }

  return {
    x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs),
    tris, vertexCount: xs.length, triangleCount: mesh.triangleCount
  };
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

export function sliceMesh(mesh: WeldedMesh, vc: ViewCoords, height: number): SliceResult {
  const { u, v, w } = vc;
  const tris = mesh.tris;
  const V = mesh.vertexCount;

  // Jeder Schnittpunkt liegt auf einer Dreieckskante. Die Kante (a,b) bekommt
  // eine eindeutige Nummer -> zwei Nachbardreiecke liefern exakt denselben Punkt.
  const pointOfEdge = new Map<number, number>();
  const pu: number[] = [], pv: number[] = [];
  const segA: number[] = [], segB: number[] = [];

  const edgePoint = (a: number, b: number): number => {
    const key = a < b ? a * V + b : b * V + a;
    let id = pointOfEdge.get(key);
    if (id === undefined) {
      const t = (height - w[a]) / (w[b] - w[a]);
      id = pu.length;
      pu.push(u[a] + t * (u[b] - u[a]));
      pv.push(v[a] + t * (v[b] - v[a]));
      pointOfEdge.set(key, id);
    }
    return id;
  };

  for (let t = 0; t < mesh.triangleCount; t++) {
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
  const segsAt = new Map<number, number[]>();
  for (let s = 0; s < segA.length; s++) {
    for (const p of [segA[s], segB[s]]) {
      const list = segsAt.get(p);
      if (list) list.push(s); else segsAt.set(p, [s]);
    }
  }

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
      seg = -1;
      const cand = segsAt.get(cur);
      if (cand) for (const s of cand) if (!used[s]) { seg = s; break; }
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
      const cand = segsAt.get(ids[0]);
      let other = -1;
      if (cand) for (const c of cand) if (!used[c]) { other = c; break; }
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
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.u - last.u, p.v - last.v) > 1e-6) out.push(p);
  }
  if (closed && out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.hypot(f.u - l.u, f.v - l.v) <= 1e-6) out.pop();
  }
  return out;
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.u - a.u, dy = b.v - a.v;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.u - a.u, p.v - a.v);
  let t = ((p.u - a.u) * dx + (p.v - a.v) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.u - (a.u + t * dx), p.v - (a.v + t * dy));
}

function douglasPeucker(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const dd = perpDist(pts[i], pts[s], pts[e]);
      if (dd > maxD) { maxD = dd; idx = i; }
    }
    if (idx >= 0 && maxD > tol) {
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
    const dd = Math.hypot(pts[i].u - pts[0].u, pts[i].v - pts[0].v);
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
  for (const loop of closed) {
    const probe = loop.points[0];
    let depth = 0;
    for (const other of closed) {
      if (other === loop) continue;
      if (Math.abs(other.area) < Math.abs(loop.area)) continue; // kleinere können uns nicht umschließen
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
