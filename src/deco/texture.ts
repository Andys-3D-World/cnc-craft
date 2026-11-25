/**
 * FLÄCHENMUSTER (Zier-Fräsen, Laser-Gravur): eine Fläche mit Linien oder Punkten füllen – reine Geometrie
 * (Tests: tests/deco.test.ts). Koordinaten in mm. Die Fläche ist alles, was von einer ungeraden Zahl Konturen umschlossen ist
 * (Löcher bleiben frei). inset = Abstand vom Rand (mindestens der Fräser-Radius, sonst wird der Rand angeschnitten).
 */
import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import { offsetArea, type XY } from "../joints.ts";

export interface Pt { x: number; y: number }
export type TextureKind = "lines" | "cross" | "diamond" | "waves" | "zigzag" | "brick" | "hex" | "scales" | "basket" | "rays" | "rings" | "dots" | "hammer";
export const TEXTURE_KINDS: TextureKind[] = ["lines", "cross", "diamond", "waves", "zigzag", "brick", "hex", "scales", "basket", "rays", "rings", "dots", "hammer"];
export interface TextureOpts { kind: TextureKind; spacing: number; angle: number; inset: number; seed: number }
export interface Texture { lines: { pts: Pt[]; closed: boolean }[]; dots: Pt[]; tooMany: boolean }

const MAX_PIECES = 12000;

/** Fläche aus Konturen, um inset verkleinert */
export function regionOf(loops: Pt[][], inset: number): MultiPolygon {
  const rings = loops.filter(l => l.length >= 3).map(l => [[...l.map(p => [p.x, p.y] as XY), [l[0].x, l[0].y] as XY]] as Polygon);
  if (!rings.length) return [];
  const m = polygonClipping.xor(rings[0], ...rings.slice(1));
  return inset > 1e-6 ? offsetArea(m, -inset) : m;
}

interface Seg { ax: number; ay: number; bx: number; by: number }
class Region {
  segs: Seg[] = [];
  box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  constructor(m: MultiPolygon) {
    for (const poly of m) for (const ring of poly) for (let i = 0; i + 1 < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
      this.segs.push({ ax, ay, bx, by });
      this.box.x0 = Math.min(this.box.x0, ax); this.box.x1 = Math.max(this.box.x1, ax); this.box.y0 = Math.min(this.box.y0, ay); this.box.y1 = Math.max(this.box.y1, ay);
    }
  }
  has(x: number, y: number): boolean {
    let c = false;
    for (const s of this.segs) if ((s.ay > y) !== (s.by > y) && x < (s.bx - s.ax) * (y - s.ay) / (s.by - s.ay) + s.ax) c = !c;
    return c;
  }
  /** Stücke eines Linienzugs, die in der Fläche liegen */
  clip(line: Pt[]): Pt[][] {
    const out: Pt[][] = [];
    let cur: Pt[] = [];
    const flush = () => { if (cur.length > 1) out.push(cur); cur = []; };
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i + 1], dx = b.x - a.x, dy = b.y - a.y;
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      if (x1 < this.box.x0 || x0 > this.box.x1 || y1 < this.box.y0 || y0 > this.box.y1) { flush(); continue; }
      const ts = [0, 1];
      for (const s of this.segs) {
        if (Math.max(s.ax, s.bx) < x0 || Math.min(s.ax, s.bx) > x1 || Math.max(s.ay, s.by) < y0 || Math.min(s.ay, s.by) > y1) continue;
        const ex = s.bx - s.ax, ey = s.by - s.ay, den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((s.ax - a.x) * ey - (s.ay - a.y) * ex) / den, u = ((s.ax - a.x) * dy - (s.ay - a.y) * dx) / den;
        if (t > 1e-9 && t < 1 - 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
      }
      ts.sort((p, q) => p - q);
      for (let k = 0; k + 1 < ts.length; k++) {
        if (ts[k + 1] - ts[k] < 1e-9) continue;
        const m = (ts[k] + ts[k + 1]) / 2;
        if (!this.has(a.x + dx * m, a.y + dy * m)) { flush(); continue; }
        if (!cur.length) cur.push({ x: a.x + dx * ts[k], y: a.y + dy * ts[k] });
        cur.push({ x: a.x + dx * ts[k + 1], y: a.y + dy * ts[k + 1] });
      }
    }
    flush();
    return out;
  }
}

/** Zufall, der bei gleichem Startwert gleich bleibt */
function rng(seed: number) { let s = (Math.abs(Math.round(seed)) % 2147483646) + 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

export function makeTexture(loops: Pt[][], o: TextureOpts): Texture {
  const out: Texture = { lines: [], dots: [], tooMany: false };
  const sp = Math.max(0.05, o.spacing), m = regionOf(loops, o.inset);
  if (!m.length) return out;
  const R = new Region(m), b = R.box, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, rad = Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2 + sp * 3;
  const a = o.angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const W = (u: number, v: number, ang = 0): Pt => {
    const c = ang ? Math.cos(a + ang) : ca, s = ang ? Math.sin(a + ang) : sa;
    return { x: cx + u * c - v * s, y: cy + u * s + v * c };
  };
  let flip = false;
  const add = (line: Pt[]) => {
    if (out.tooMany) return;
    const parts = R.clip(line).filter(p => len(p) > sp * 0.05);
    // abwechselnd hin und zurück: kurze Wege
    if (flip) { parts.reverse(); parts.forEach(p => p.reverse()); }
    flip = !flip;
    for (const pts of parts) out.lines.push({ pts, closed: false });
    if (out.lines.length > MAX_PIECES) out.tooMany = true;
  };
  const n = Math.ceil(rad / sp);
  if (n > 4000) { out.tooMany = true; return out; }
  const straight = (ang: number) => { for (let k = -n; k <= n; k++) add([W(-rad, k * sp, ang), W(rad, k * sp, ang)]); };
  const wave = (f: (u: number, k: number) => number, step: number) => {
    for (let k = -n - 1; k <= n + 1; k++) { const l: Pt[] = []; for (let u = -rad; u <= rad + 1e-9; u += step) l.push(W(u, k * sp + f(u, k))); add(l); }
  };
  switch (o.kind) {
    case "lines": straight(0); break;
    case "cross": straight(0); straight(Math.PI / 2); break;
    case "diamond": straight(Math.PI / 6); straight(-Math.PI / 6); break;
    case "waves": wave(u => Math.sin(u / (sp * 4) * 2 * Math.PI) * sp * 0.8, sp / 4); break;
    case "zigzag": { for (let k = -n - 1; k <= n + 1; k++) { const l: Pt[] = []; for (let i = -n; i <= n; i++) l.push(W(i * sp, k * sp + (i % 2 ? sp / 2 : -sp / 2))); add(l); } break; }
    case "brick": {
      straight(0);
      const L = sp * 2.2, q = Math.ceil(rad / L) + 1;
      for (let k = -n; k < n; k++) for (let i = -q; i <= q; i++) { const u = (i + (k % 2 ? 0.5 : 0)) * L; add([W(u, k * sp), W(u, (k + 1) * sp)]); }
      break;
    }
    case "hex": {
      // Wabenlinien: Zickzack-Reihen und die senkrechten Stege dazwischen
      const s = sp / Math.sqrt(3), q = Math.ceil(rad / sp) + 2, rows = Math.ceil(rad / (1.5 * s)) + 2;
      for (let j = -rows; j <= rows; j++) {
        const y = j * 1.5 * s, off = j % 2 ? sp / 2 : 0, l: Pt[] = [];
        for (let i = -q; i <= q; i++) { l.push(W(off + i * sp - sp / 2, y), W(off + i * sp, y + s / 2)); }
        add(l);
        for (let i = -q; i <= q; i++) add([W(off + i * sp, y + s / 2), W(off + i * sp, y + 1.5 * s)]);
      }
      break;
    }
    case "scales": {
      const r = sp, q = Math.ceil(rad / (2 * r)) + 1, rows = Math.ceil(rad / r) + 2;
      for (let j = -rows; j <= rows; j++) for (let i = -q; i <= q; i++) {
        const u = (i + (j % 2 ? 0.5 : 0)) * 2 * r, v = j * r, l: Pt[] = [];
        for (let t = 0; t <= 12; t++) l.push(W(u + r * Math.cos(Math.PI + Math.PI * t / 12), v + r * Math.sin(Math.PI + Math.PI * t / 12)));
        add(l);
      }
      break;
    }
    case "basket": {
      // Korbgeflecht: Felder mit je drei Linien, abwechselnd längs und quer
      const c = sp * 3, q = Math.ceil(rad / c) + 1;
      for (let j = -q; j <= q; j++) for (let i = -q; i <= q; i++) for (let k = 0; k < 3; k++) {
        const d = (k + 0.5) * sp;
        add((i + j) % 2 ? [W(i * c + d, j * c + sp * 0.15), W(i * c + d, (j + 1) * c - sp * 0.15)] : [W(i * c + sp * 0.15, j * c + d), W((i + 1) * c - sp * 0.15, j * c + d)]);
      }
      break;
    }
    case "rays": {
      const nr = Math.max(4, Math.min(720, Math.round(2 * Math.PI * rad / sp / 2)));
      for (let k = 0; k < nr; k++) { const t = 2 * Math.PI * k / nr, r0 = Math.min(sp, rad * 0.1); add([W(r0 * Math.cos(t), r0 * Math.sin(t)), W(rad * Math.cos(t), rad * Math.sin(t))]); }
      break;
    }
    case "rings": {
      let area = m;
      for (let k = 0; k < 2000 && area.length; k++) {
        for (const poly of area) for (const ring of poly) out.lines.push({ pts: ring.slice(0, -1).map(([x, y]) => ({ x, y })), closed: true });
        if (out.lines.length > MAX_PIECES) { out.tooMany = true; break; }
        area = offsetArea(area, -sp);
      }
      break;
    }
    case "dots": case "hammer": {
      const rand = rng(o.seed || 1), hx = sp, hy = sp * Math.sqrt(3) / 2, q = Math.ceil(rad / hx) + 1, rows = Math.ceil(rad / hy) + 1;
      if (q * rows * 4 > 200_000) { out.tooMany = true; break; }
      for (let j = -rows; j <= rows; j++) for (let i = -q; i <= q; i++) {
        let u = (i + (j % 2 ? 0.5 : 0)) * hx, v = j * hy;
        if (o.kind === "hammer") { u += (rand() - 0.5) * hx * 0.8; v += (rand() - 0.5) * hy * 0.8; }
        const p = W(u, v);
        if (R.has(p.x, p.y)) out.dots.push(p);
        if (out.dots.length > MAX_PIECES) { out.tooMany = true; return out; }
      }
      break;
    }
  }
  return out;
}

const len = (p: Pt[]) => { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y); return s; };
