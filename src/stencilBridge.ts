/**
 * STENCIL BRIDGES: keep the inside of a cut-out attached to the sheet.
 *
 * When a ring-shaped area is cut out (the letter O, a frame, a logo), the piece in its middle falls out too.
 * A bridge is a narrow strip of material that is left standing across the cut-out, from the middle piece to the
 * material around it. Geometry only (mm or any other unit), no shapes and no interface – see editTools.ts.
 *
 *   cut-out area = hole contour minus the islands inside it
 *   with bridges = that area minus one straight strip per island (and per extra bridge)
 *
 * Which contours are cut-outs depends on what the outermost contour is:
 *   outerIsPart = true:  outermost = the part (stays), contours inside it = cut-outs, inside those = islands …
 *   outerIsPart = false: outermost = already a cut-out (e.g. only the letters are given), inside it = islands …
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Ring } from "polygon-clipping";

export type XY = [number, number];

export interface BridgeOptions {
  width: number;          // width of the bridge
  count: number;          // bridges per island: 1 … 4, spread evenly round the island
  angle: number | null;   // direction of the first bridge in degrees (0 = right, 90 = up); null = the shortest way
  outerIsPart: boolean;
}

export interface Island { loop: number; hole: number }   // indexes into the list of loops

export interface BridgeResult {
  cutouts: { hole: number; islands: number[]; rings: XY[][]; loose: number }[];  // per changed hole: its new cut contours
  bridges: XY[][];        // the strips (4 corners each), for the preview
  bridged: number;        // islands that are attached now
  loose: number;          // islands still loose afterwards (bridge did not reach, e.g. width too small)
}

const area = (r: XY[]) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };

export function inside(p: XY, r: XY[]): boolean {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/** For each loop: the smallest loop that contains it (-1 = none) and how deep it is nested */
export function nesting(loops: XY[][]): { parent: number; depth: number }[] {
  const ar = loops.map(l => Math.abs(area(l)));
  const parent = loops.map((l, i) => {
    let best = -1;
    loops.forEach((o, j) => {
      if (j === i || ar[j] <= ar[i] || !l.length || !inside(l[0], o)) return;
      if (best < 0 || ar[j] < ar[best]) best = j;
    });
    return best;
  });
  return loops.map((_, i) => {
    let d = 0, k = parent[i];
    for (let guard = 0; k >= 0 && guard < loops.length; guard++) { d++; k = parent[k]; }
    return { parent: parent[i], depth: d };
  });
}

/** Pieces of material that fall out with a cut-out: loops lying directly inside a cut-out contour */
export function findIslands(loops: XY[][], outerIsPart: boolean): Island[] {
  const n = nesting(loops);
  const out: Island[] = [];
  n.forEach((v, i) => {
    // cut-outs have odd depth when the outermost loop is the part, even depth when it is a cut-out itself
    const parentIsCutout = v.parent >= 0 && (n[v.parent].depth % 2 === 1) === outerIsPart;
    if (parentIsCutout && loops[i].length >= 3) out.push({ loop: i, hole: v.parent });
  });
  return out;
}

/** Is the outermost level one single contour that holds everything else? Then it is most likely the part */
export function guessOuterIsPart(loops: XY[][]): boolean {
  const n = nesting(loops);
  return n.filter(v => v.depth === 0).length === 1 && n.some(v => v.depth >= 2);
}

const centroid = (r: XY[]): XY => {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length], f = p[0] * q[1] - q[0] * p[1];
    a += f; x += (p[0] + q[0]) * f; y += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-12) return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
  return [x / (3 * a), y / (3 * a)];
};

/** Distances along the ray from `o` in direction `d` (unit) at which it crosses the loop, ascending */
function rayHits(o: XY, d: XY, r: XY[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const den = d[0] * ey - d[1] * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a[0] - o[0]) * ey - (a[1] - o[1]) * ex) / den;
    const u = ((a[0] - o[0]) * d[1] - (a[1] - o[1]) * d[0]) / den;
    if (t > 1e-9 && u >= 0 && u < 1) out.push(t);
  }
  return out.sort((x, y) => x - y);
}

/**
 * Where a bridge from the island runs in direction `deg`: from inside the island (t0) to inside the material
 * beyond the cut-out (t1). gap = width of the cut-out it has to cross. null = this direction does not work.
 */
function span(c: XY, deg: number, island: XY[], hole: XY[]): { d: XY; t0: number; t1: number; gap: number } | null {
  const d: XY = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  const hi = rayHits(c, d, island), hh = rayHits(c, d, hole);
  if (!hi.length || !hh.length) return null;
  const leave = hi[hi.length - 1];           // last time the ray leaves the island
  const reach = hh.find(t => t > leave - 1e-9); // first time it reaches the edge of the cut-out after that
  if (reach === undefined) return null;
  return { d, t0: 0, t1: reach, gap: reach - leave };
}

const closeRing = (r: XY[]): Ring => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) ? [...r, r[0]] : r) as Ring;
const openRing = (r: Ring): XY[] => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r) as XY[];

export function bridgeIslands(loops: XY[][], o: BridgeOptions): BridgeResult {
  const res: BridgeResult = { cutouts: [], bridges: [], bridged: 0, loose: 0 };
  const width = Math.max(0, o.width), count = Math.max(1, Math.min(4, Math.round(o.count) || 1));
  const islands = findIslands(loops, o.outerIsPart);
  if (!islands.length || !(width > 0)) { res.loose = islands.length; return res; }
  const byHole = new Map<number, number[]>();
  for (const i of islands) byHole.set(i.hole, [...(byHole.get(i.hole) || []), i.loop]);

  for (const [hole, list] of byHole) {
    const H = loops[hole];
    const strips: XY[][] = [];
    for (const li of list) {
      const I = loops[li], c = centroid(I);
      // a centre outside the island (C-shaped piece): start from one of its points instead
      const from: XY = inside(c, I) ? c : [(I[0][0] + I[1][0] + I[2][0]) / 3, (I[0][1] + I[1][1] + I[2][1]) / 3];
      let first = o.angle;
      if (first === null || !Number.isFinite(first)) {
        // the shortest way across the cut-out, tried every 15 degrees (up wins a tie: easiest to read on letters)
        let best = Infinity; first = 90;
        for (let k = 0; k < 24; k++) {
          const deg = 90 + k * 15, s = span(from, deg, I, H);
          if (s && s.gap < best - 1e-9) { best = s.gap; first = deg; }
        }
      }
      for (let k = 0; k < count; k++) {
        const s = span(from, first + (k * 360) / count, I, H);
        if (!s) continue;
        // a little past the edge on the far side, so the strip ends inside the material
        const len = s.t1 + width, nx = -s.d[1] * width / 2, ny = s.d[0] * width / 2;
        const a: XY = [from[0], from[1]], b: XY = [from[0] + s.d[0] * len, from[1] + s.d[1] * len];
        strips.push([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]);
      }
    }
    if (!strips.length) { res.loose += list.length; continue; }
    let region: MultiPolygon;
    try {
      region = polygonClipping.difference([[closeRing(H), ...list.map(li => closeRing(loops[li]))]], ...strips.map(s => [[closeRing(s)]] as MultiPolygon));
    } catch { res.loose += list.length; continue; }
    // every ring left inside a piece of the cut-out is an island that is still loose
    const rings: XY[][] = [];
    let loose = 0;
    for (const poly of region) poly.forEach((r, k) => { const q = openRing(r); if (q.length >= 3) { rings.push(q); if (k > 0) loose++; } });
    res.cutouts.push({ hole, islands: list, rings, loose });
    res.bridges.push(...strips);
    res.bridged += list.length - Math.min(list.length, loose);
    res.loose += Math.min(list.length, loose);
  }
  return res;
}
