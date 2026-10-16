/**
 * KONTUREN AUS BILDERN GEWINNEN (für Text-Werkzeug und Bild-Nachzeichnen)
 */
import { Pt } from "./shapeTransform";

/**
 * Marching Squares: findet die Kante (Schwelle "iso") im Graustufenbild.
 * Jeder Kantenpunkt liegt auf einer Pixel-Verbindung und hat eine feste Nummer,
 * dadurch schließen sich die Konturen exakt.
 */
export function marchingSquares(v: Float32Array, W: number, H: number, iso: number): Pt[][] {
  const pointIdx = new Map<number, number>();
  const px: number[] = [], py: number[] = [];
  const segA: number[] = [], segB: number[] = [];

  // Kanten-Nummer: horizontal (i,j)-(i+1,j) = 2*(j*W+i), vertikal (i,j)-(i,j+1) = 2*(j*W+i)+1
  const edgePoint = (key: number, ax: number, ay: number, bx: number, by: number, va: number, vb: number) => {
    let id = pointIdx.get(key);
    if (id === undefined) {
      const t = (iso - va) / (vb - va);
      id = px.length;
      px.push(ax + (bx - ax) * t);
      py.push(ay + (by - ay) * t);
      pointIdx.set(key, id);
    }
    return id;
  };

  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const tl = v[j * W + i], tr = v[j * W + i + 1], br = v[(j + 1) * W + i + 1], bl = v[(j + 1) * W + i];
      const c = (tl > iso ? 8 : 0) | (tr > iso ? 4 : 0) | (br > iso ? 2 : 0) | (bl > iso ? 1 : 0);
      if (c === 0 || c === 15) continue;

      const top = () => edgePoint(2 * (j * W + i), i, j, i + 1, j, tl, tr);
      const bottom = () => edgePoint(2 * ((j + 1) * W + i), i, j + 1, i + 1, j + 1, bl, br);
      const left = () => edgePoint(2 * (j * W + i) + 1, i, j, i, j + 1, tl, bl);
      const right = () => edgePoint(2 * (j * W + i + 1) + 1, i + 1, j, i + 1, j + 1, tr, br);
      const seg = (a: number, b: number) => { segA.push(a); segB.push(b); };

      switch (c) {
        case 1: case 14: seg(left(), bottom()); break;
        case 2: case 13: seg(bottom(), right()); break;
        case 3: case 12: seg(left(), right()); break;
        case 4: case 11: seg(top(), right()); break;
        case 6: case 9: seg(top(), bottom()); break;
        case 7: case 8: seg(left(), top()); break;
        case 5: case 10: {
          const center = (tl + tr + br + bl) / 4;
          const joinTL = (c === 5) === (center > iso);
          if (joinTL) { seg(left(), top()); seg(bottom(), right()); }
          else { seg(left(), bottom()); seg(top(), right()); }
          break;
        }
      }
    }
  }

  // Segmente zu Ringen verketten
  const at = new Map<number, number[]>();
  for (let s = 0; s < segA.length; s++) {
    for (const q of [segA[s], segB[s]]) { const l = at.get(q); if (l) l.push(s); else at.set(q, [s]); }
  }
  const used = new Uint8Array(segA.length);
  const loops: Pt[][] = [];
  for (let s = 0; s < segA.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const start = segA[s];
    let cur = segB[s];
    const ids = [start, cur];
    let guard = 0;
    while (cur !== start && guard++ < segA.length) {
      const cand = at.get(cur);
      let next = -1;
      if (cand) for (const k of cand) if (!used[k]) { next = k; break; }
      if (next < 0) break;
      used[next] = 1;
      cur = segA[next] === cur ? segB[next] : segA[next];
      ids.push(cur);
    }
    if (cur === start) ids.pop();
    if (ids.length >= 3) loops.push(ids.map(id => ({ x: px[id], y: py[id] })));
  }
  return loops;
}

function perp(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (!l2) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function dp(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let md = 0, idx = -1;
    for (let i = s + 1; i < e; i++) { const d = perp(pts[i], pts[s], pts[e]); if (d > md) { md = d; idx = i; } }
    if (idx >= 0 && md > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function simplifyClosed(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 4) return pts;
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y); if (d > fd) { fd = d; far = i; } }
  const a = dp(pts.slice(0, far + 1), tol);
  const b = dp([...pts.slice(far), pts[0]], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

