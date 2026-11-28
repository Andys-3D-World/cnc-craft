/**
 * DREHEN SIMULIEREN – Material nach einer beliebigen Stelle des Programms und die 3D-Körper dazu. Ohne Oberfläche (Tests: tests/latheSim.test.ts).
 * Welt der 3D-Ansicht: x = Drehachse (rechts = Reitstock), −y = vorne beim Bediener, z = oben.
 */
import { cutterMesh } from "../sim/toolMesh.ts";
import { dilate, makeGrid, refDz, shapeOf, sweep, type Grid, type LathePlan, type LatheTool } from "./turn.ts";

export interface TurnMove { z0: number; r0: number; z1: number; r1: number; rapid: boolean; tool: LatheTool | null; line: number }
export interface TurnStock { R: number; front: number; stickOut: number }

export interface ProgLike { lines: string[]; n: number; x0: ArrayLike<number>; z0: ArrayLike<number>; x1: ArrayLike<number>; z1: ArrayLike<number>; type: ArrayLike<number>; line: ArrayLike<number> }
/** Fahrten aus einem gelesenen Programm. k: X-Wert je mm Radius (z. B. −2 = Durchmesser, X+ zur Mitte). Werkzeug aus „T3“ in Kommentar oder Befehl */
export function movesFromProgram(p: ProgLike, k: number, tools: LatheTool[], rapidType: number): TurnMove[] {
  const at: (LatheTool | null)[] = new Array(p.lines.length);
  let cur: LatheTool | null = tools.find(x => x.type === "turn") ?? tools[0] ?? null;
  for (let i = 0; i < p.lines.length; i++) {
    const m = /\bT(\d{1,4})\b/.exec(p.lines[i]);
    if (m) { const n = m[1].length > 2 ? parseInt(m[1].slice(0, 2)) : parseInt(m[1]); cur = tools.find(x => x.num === n) ?? cur; }
    at[i] = cur;
  }
  const out: TurnMove[] = [];
  for (let i = 0; i < p.n; i++) out.push({ z0: p.z0[i], r0: p.x0[i] / k, z1: p.z1[i], r1: p.x1[i] / k, rapid: p.type[i] === rapidType, tool: at[p.line[i]] ?? cur, line: p.line[i] });
  return out;
}

/** Fahrten direkt aus dem Plan (Dreh-Fenster); Anfang jeder Bearbeitung ist die sichere Stelle vor dem Teil */
export function planMoves(plan: LathePlan, s: { job: { stockD: number; safeX: number; faceAllow: number; safeZ: number } }): TurnMove[] {
  const out: TurnMove[] = [], z = s.job.faceAllow + s.job.safeZ, r = s.job.stockD / 2 + s.job.safeX;
  for (const run of plan.runs) {
    let a = { z, r };
    for (const m of run.moves) { out.push({ z0: a.z, r0: a.r, z1: m.z, r1: m.r, rapid: m.rapid, tool: run.tool, line: 0 }); a = { z: m.z, r: m.r }; }
  }
  return out;
}

const KEY = 120;
export class LatheReplay {
  readonly g: Grid;
  /** Außenform und Bohrung (Radius je Stelle), wie sie gerade gezeigt werden */
  S: Float64Array; bore: Float64Array;
  /** Eilfahrten, die ins Material gehen (Zeile) – bei eigenen Programmen leer */
  readonly warnings: number[] = [];
  private keys: { S: Float64Array; b: Float64Array }[] = [];
  private S0: Float64Array; private b0: Float64Array;
  private at = -1; private cS: Float64Array; private cb: Float64Array;

  readonly moves: TurnMove[]; readonly stock: TurnStock;
  constructor(moves: TurnMove[], stock: TurnStock) {
    this.moves = moves; this.stock = stock;
    let zMin = -stock.stickOut - 10, zMax = stock.front + 12;
    for (const m of moves) { zMin = Math.min(zMin, Math.max(-stock.stickOut - 60, m.z0, m.z1)); zMax = Math.max(zMax, Math.min(stock.front + 60, m.z0, m.z1)); }
    this.g = makeGrid(zMin, zMax, Math.max(0.03, (zMax - zMin) / 2600));
    this.S0 = new Float64Array(this.g.n); this.b0 = new Float64Array(this.g.n);
    for (let i = 0; i < this.g.n; i++) this.S0[i] = this.g.z0 + i * this.g.h <= stock.front + 1e-6 ? stock.R : -1e9;
    this.cS = this.S0.slice(); this.cb = this.b0.slice();
    this.S = this.S0; this.bore = this.b0;
    // einmal ganz durch: Zwischenstände merken, damit Hin- und Herspulen sofort geht, und Eilfahrten prüfen
    for (let i = 0; i <= moves.length; i++) {
      if (i % KEY === 0) this.keys.push({ S: this.cS.slice(), b: this.cb.slice() });
      if (i === moves.length) break;
      if (i > 1) this.check(moves[i]);
      this.apply(moves[i], 1, this.cS, this.cb);
    }
    this.at = moves.length;
    this.S = this.cS; this.bore = this.cb;
  }
  private check(m: TurnMove) {
    if (!m.rapid || !m.tool || this.warnings.length > 100) return;
    const g = this.g, dz = refDz(m.tool), R = this.stock.R, need = m.tool.type === "drill" ? null : dilate(this.cS, g, shapeOf(m.tool)), len = Math.hypot(m.z1 - m.z0, m.r1 - m.r0), n = Math.min(400, Math.max(2, Math.ceil(len / 0.25)));
    for (let k = 0; k <= n; k++) {
      const z = m.z0 + (m.z1 - m.z0) * k / n, r = Math.abs(m.r0 + (m.r1 - m.r0) * k / n);
      const i = Math.round((z - dz - g.z0) / g.h);
      if (i < 0 || i >= g.n) continue;
      // Bohrer: nur in schon gebohrten Grund, sonst ganz außerhalb des Rohteils
      const hit = need ? need[i] > r + 0.06 && r < R + 0.05 : this.cS[i] > 0 && (r < 0.01 ? this.cb[i] < m.tool.dia / 2 - 0.05 && z < this.stock.front - 0.3 && !this.drilledTo(z) : r < R + m.tool.dia / 2);
      if (hit) { this.warnings.push(m.line); return; }
    }
  }
  private drilledTo(z: number) { const g = this.g, i = Math.max(0, Math.round((z + 0.6 - g.z0) / g.h)); return i >= g.n || this.cb[i] > 0.01 || this.cS[i] < 0; }
  private apply(m: TurnMove, f: number, S: Float64Array, b: Float64Array) {
    if (m.rapid || !m.tool || f <= 0) return;
    const z1 = m.z0 + (m.z1 - m.z0) * f, r1 = m.r0 + (m.r1 - m.r0) * f, t = m.tool;
    if (t.type === "drill") {
      const zt = Math.min(m.z0, z1), R = t.dia / 2, tan = Math.tan(59 * Math.PI / 180);
      if (Math.max(Math.abs(m.r0), Math.abs(r1)) > 0.5) return;
      for (let i = Math.max(0, Math.ceil((zt - this.g.z0) / this.g.h)); i < this.g.n; i++) { const v = Math.min(R, (this.g.z0 + i * this.g.h - zt) * tan); if (v > b[i]) b[i] = v; }
      return;
    }
    const dz = refDz(t);
    sweep(S, this.g, shapeOf(t), m.z0 - dz, m.r0, z1 - dz, r1);
  }
  /** Stand nach Bewegung i (Anteil frac). i < 0: Anfang */
  setTarget(i: number, frac: number) {
    const full = Math.max(0, Math.min(this.moves.length, i < 0 ? 0 : i));
    if (this.at > full || full - this.at > KEY) {
      const k = Math.min(this.keys.length - 1, Math.floor(full / KEY));
      if (this.at > full || k * KEY > this.at) { this.cS = this.keys[k].S.slice(); this.cb = this.keys[k].b.slice(); this.at = k * KEY; }
    }
    while (this.at < full) { this.apply(this.moves[this.at], 1, this.cS, this.cb); this.at++; }
    const m = i >= 0 ? this.moves[full] : undefined;
    if (m && frac > 1e-6 && !m.rapid) { const S = this.cS.slice(), b = this.cb.slice(); this.apply(m, Math.min(1, frac), S, b); this.S = S; this.bore = b; }
    else { this.S = this.cS; this.bore = this.cb; }
  }
}

// ---------------- 3D-Körper ----------------
export interface Tri { data: Float32Array; index: Uint32Array }
class Builder {
  private d: number[] = []; private ix: number[] = [];
  /** Vieleck (konvex) mit einer Normale */
  poly(pts: [number, number, number][], n: [number, number, number]) {
    const o = this.d.length / 8;
    for (const p of pts) this.d.push(p[0], p[1], p[2], n[0], n[1], n[2], 0, 0);
    for (let k = 2; k < pts.length; k++) this.ix.push(o, o + k - 1, o + k);
  }
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
    const P = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
    this.poly([P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)], [0, -1, 0]); this.poly([P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], [0, 1, 0]);
    this.poly([P(x0, y0, z0), P(x0, y1, z0), P(x0, y1, z1), P(x0, y0, z1)], [-1, 0, 0]); this.poly([P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)], [1, 0, 0]);
    this.poly([P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0)], [0, 0, -1]); this.poly([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], [0, 0, 1]);
  }
  /** Strecke (x, r) um die x-Achse drehen, von a0 bis a1 */
  turn(xa: number, ra: number, xb: number, rb: number, seg: number, a0 = 0, a1 = 2 * Math.PI) {
    const l = Math.hypot(xb - xa, rb - ra);
    if (l < 1e-9 || (ra < 1e-9 && rb < 1e-9)) return;
    const nx = -(rb - ra) / l, nr = (xb - xa) / l, o = this.d.length / 8;
    for (let k = 0; k <= seg; k++) {
      const a = a0 + (a1 - a0) * k / seg, c = Math.cos(a), s = Math.sin(a);
      this.d.push(xa, ra * c, ra * s, nx, nr * c, nr * s, 0, 0, xb, rb * c, rb * s, nx, nr * c, nr * s, 0, 0);
      if (k) { const q = o + (k - 1) * 2; this.ix.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    }
  }
  /** Vieleck in der x/y-Ebene zwischen den Höhen z0 und z1 */
  prism(pts: [number, number][], z0: number, z1: number) {
    this.poly(pts.map(p => [p[0], p[1], z1] as [number, number, number]), [0, 0, 1]);
    this.poly(pts.map(p => [p[0], p[1], z0] as [number, number, number]), [0, 0, -1]);
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      this.poly([[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]], [(b[1] - a[1]) / l, -(b[0] - a[0]) / l, 0]);
    }
  }
  /** Dreiecke aus sim/toolMesh.ts (je Ecke 10 Zahlen, Achse entlang z) übernehmen – hier liegt die Achse entlang x */
  swept(v: ArrayLike<number>) {
    const o = this.d.length / 8;
    for (let i = 0; i < v.length; i += 10) { this.d.push(v[i + 2], v[i], v[i + 1], v[i + 5], v[i + 3], v[i + 4], 0, 0); this.ix.push(o + i / 10); }
  }
  done(): Tri { return { data: new Float32Array(this.d), index: new Uint32Array(this.ix) }; }
}

/** Außenform und Bohrung auf wenige Stützstellen bringen (gleiche Stellen für beide) */
function stations(S: Float64Array, b: Float64Array, g: Grid, tol: number): { i0: number; i1: number; idx: number[] }[] {
  const out: { i0: number; i1: number; idx: number[] }[] = [];
  for (let i = 0; i < g.n;) {
    if (!(S[i] > 0.005)) { i++; continue; }
    let j = i;
    while (j + 1 < g.n && S[j + 1] > 0.005) j++;
    const keep = new Set<number>([i, j]);
    for (const arr of [S, b]) {
      const st: [number, number][] = [[i, j]];
      while (st.length) {
        const [p, q] = st.pop()!;
        let bi = -1, bd = tol;
        for (let k = p + 1; k < q; k++) { const e = Math.abs(arr[k] - (arr[p] + (arr[q] - arr[p]) * (k - p) / (q - p))); if (e > bd) { bd = e; bi = k; } }
        if (bi >= 0) { keep.add(bi); st.push([p, bi], [bi, q]); }
      }
    }
    out.push({ i0: i, i1: j, idx: [...keep].sort((x, y) => x - y) });
    i = j + 1;
  }
  return out;
}
/** Drehteil als Netze: unberührtes Rohteil, bearbeitete Flächen, Schnittflächen (nur bei cut: ein Viertel fehlt) */
export function partMeshes(r: Pick<LatheReplay, "S" | "bore" | "g">, R: number, cut: boolean, seg = 72): { raw: Tri; done: Tri; face: Tri } {
  const raw = new Builder(), done = new Builder(), face = new Builder(), g = r.g, z = (i: number) => g.z0 + i * g.h;
  // offenes Viertel: vorne oben, dort schaut man hin
  const a0 = cut ? Math.PI : 0, a1 = cut ? Math.PI * 2.5 : Math.PI * 2, n = cut ? Math.round(seg * 0.75) : seg;
  for (const s of stations(r.S, r.bore, g, 0.012)) {
    const q = s.idx, In = (i: number) => Math.max(0, Math.min(r.bore[i], r.S[i])), first = q[0], last = q[q.length - 1];
    for (let k = 1; k < q.length; k++) {
      const a = q[k - 1], b = q[k], un = r.S[a] > R - 0.01 && r.S[b] > R - 0.01;
      (un ? raw : done).turn(z(a), r.S[a], z(b), r.S[b], n, a0, a1);
      if (In(a) > 0.005 || In(b) > 0.005) done.turn(z(b), In(b), z(a), In(a), n, a0, a1);
      if (cut) for (const ang of [a0, a1]) {
        const c = Math.cos(ang), t = Math.sin(ang), P = (i: number, rad: number): [number, number, number] => [z(i), rad * c, rad * t];
        face.poly([P(a, In(a)), P(b, In(b)), P(b, r.S[b]), P(a, r.S[a])], [0, -t, c]);
      }
    }
    done.turn(z(last), r.S[last], z(last), In(last), n, a0, a1);
    (s.i0 === 0 ? raw : done).turn(z(first), In(first), z(first), r.S[first], n, a0, a1);
  }
  return { raw: raw.done(), done: done.done(), face: face.done() };
}
/** Futter mit drei Backen; Vorderkante der Backen bei x = front */
export function chuckMeshes(front: number, R: number): { body: Tri; jaws: Tri } {
  const body = new Builder(), jaws = new Builder(), Rc = Math.max(38, R * 1.7 + 12), jl = Math.max(10, Math.min(22, R * 0.6)), xb = front - jl, d = Math.max(22, Rc * 0.55);
  body.turn(xb - d, Rc, xb, Rc, 96); body.turn(xb, Rc, xb, R * 0.98, 96); body.turn(xb - d, 0, xb - d, Rc, 96);
  body.turn(xb - d - 26, Rc * 0.5, xb - d, Rc * 0.5, 64); body.turn(xb - d - 26, 0, xb - d - 26, Rc * 0.5, 64);
  for (let k = 0; k < 3; k++) {
    const a = k * 2 * Math.PI / 3 + Math.PI / 2, c = Math.cos(a), s = Math.sin(a), w = Math.max(5, Math.min(11, R * 0.45));
    // Backe als Kasten in eigener Lage, dann gedreht
    const b = new Builder();
    b.box(xb, front, R, Rc * 0.82, -w, w); b.box(xb - 0.5, xb + jl * 0.55, R, Rc * 0.97, -w, w);
    const t = b.done(), off = t.data.slice();
    for (let i = 0; i < off.length; i += 8) for (const o of [1, 4]) { const y = t.data[i + o], z = t.data[i + o + 1]; off[i + o] = y * c - z * s; off[i + o + 1] = y * s + z * c; }
    jaws.poly([], [0, 0, 0]);
    append(jaws, { data: off, index: t.index });
  }
  return { body: body.done(), jaws: jaws.done() };
}
function append(b: Builder, t: Tri) { const x = b as any, o = x.d.length / 8; for (const v of t.data) x.d.push(v); for (const v of t.index) x.ix.push(v + o); }
/** Körnerspitze (60°) mit Pinole ab x = front */
export function tailMesh(front: number, dia: number): Tri {
  const b = new Builder(), R = Math.max(2, dia / 2), l = R / Math.tan(Math.PI / 6);
  b.turn(front - l * 0.35, 0, front + l * 0.65, R, 48); b.turn(front + l * 0.65, R, front + l * 0.65 + 18, R, 48); b.turn(front + l * 0.65 + 18, R, front + l * 0.65 + 18, R * 1.6, 48); b.turn(front + l * 0.65 + 18, R * 1.6, front + l * 0.65 + 60, R * 1.6, 48);
  return b.done();
}
/** Umriss der Schneide in der Ebene (z, r), Ursprung = programmierte Spitze */
export function insertOutline(t: LatheTool, size = 9): [number, number][] {
  const dz = refDz(t);
  if (t.type === "groove") return [[0, 0], [t.width, 0], [t.width, 22], [0, 22]];
  const eps = Math.max(10, t.eps), k = t.hand === "N" ? (180 - eps) / 2 : t.kappa, m = t.hand === "L" ? -1 : 1;
  const dir = (deg: number): [number, number] => { const a = deg * Math.PI / 180; return [-Math.cos(a) * m, Math.sin(a)]; };
  const a = dir(k), b = dir(k + eps), half = eps * Math.PI / 360, bl = Math.hypot(a[0] + b[0], a[1] + b[1]), bis = [(a[0] + b[0]) / bl, (a[1] + b[1]) / bl];
  // Mitte des Schneidenradius liegt um die Nase über dem tiefsten Punkt
  const c: [number, number] = [-dz, t.nose], apex: [number, number] = [c[0] - bis[0] * t.nose / Math.sin(half), c[1] - bis[1] * t.nose / Math.sin(half)], q = t.nose / Math.tan(half), L = Math.max(size, q * 2.5);
  const out: [number, number][] = [];
  const A: [number, number] = [apex[0] + a[0] * L, apex[1] + a[1] * L], B: [number, number] = [apex[0] + b[0] * L, apex[1] + b[1] * L];
  const ta: [number, number] = [apex[0] + a[0] * q, apex[1] + a[1] * q], tb: [number, number] = [apex[0] + b[0] * q, apex[1] + b[1] * q];
  out.push(A, ta);
  const w0 = Math.atan2(ta[1] - c[1], ta[0] - c[0]);
  let dw = Math.atan2(tb[1] - c[1], tb[0] - c[0]) - w0;
  while (dw > Math.PI) dw -= 2 * Math.PI;
  while (dw < -Math.PI) dw += 2 * Math.PI;
  for (let i = 1; i < 8 && t.nose > 0.01; i++) out.push([c[0] + t.nose * Math.cos(w0 + dw * i / 8), c[1] + t.nose * Math.sin(w0 + dw * i / 8)]);
  out.push(tb, B, [A[0] + b[0] * L, A[1] + b[1] * L]);
  return out;
}
/** Spiralbohrer: Umriss (Spitze 118°) und Nuten – für toolMeshes und für die Rechnung in Rust */
export function drillSpec(t: LatheTool): { outline: [number, number][]; look: { flutes: number; core: number; rate: number; split: number }; R: number; len: number } {
  const R = t.dia / 2, l = R / Math.tan(59 * Math.PI / 180), len = l + Math.max(30, t.dia * 5);
  return { outline: [[0, 0], [R, l], [R, len]], look: { flutes: 2, core: 0.34, rate: Math.tan(28 * Math.PI / 180) / Math.max(0.05, R), split: Infinity }, R, len };
}
/**
 * Werkzeug: Schneide und Halter, Ursprung = programmierte Spitze. side −1 = vorne, +1 = hinten.
 * Nur Bild: Wendeplatte mit erhöhter Mitte und Schraube, Bohrer als Spiralbohrer – die Schneidkante selbst ist insertOutline.
 */
export function toolMeshes(t: LatheTool, side: -1 | 1, drill?: ArrayLike<number>): { insert: Tri; holder: Tri } {
  const ins = new Builder(), hol = new Builder();
  if (t.type === "drill") {
    // drill = fertig gerechneter Bohrer (in der App aus Rust), sonst hier rechnen
    const d = drillSpec(t), v: number[] = [];
    if (!drill) cutterMesh(v, d.outline, d.look, [1, 1, 1], 1);
    ins.swept(drill ?? v);
    const x = d.len; hol.turn(x, 0, x, d.R + 8, 40); hol.turn(x, d.R + 8, x + 34, d.R + 8, 40);
    return { insert: ins.done(), holder: hol.done() };
  }
  const o = insertOutline(t), P = o.map(p => [p[0], side * p[1]] as [number, number]);
  ins.prism(P, -3, 0);
  const z0 = Math.min(...o.map(p => p[0])), z1 = Math.max(...o.map(p => p[0])), r1 = Math.max(...o.map(p => p[1])), r0 = t.type === "groove" ? 16 : Math.max(t.nose + 2, r1 * 0.45);
  if (t.type === "turn") {
    // Mitte der Platte (zwischen den beiden äußeren Ecken): erhöhte Fläche hinter der Spanleitstufe, darin die Schraube
    const A = P[0], B = P[P.length - 2], c: [number, number] = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    ins.prism(P.map(q => [c[0] + (q[0] - c[0]) * 0.7, c[1] + (q[1] - c[1]) * 0.7] as [number, number]), 0, 0.3);
    const rs = Math.max(0.8, Math.min(2.2, Math.hypot(A[0] - B[0], A[1] - B[1]) * 0.16)), ring: [number, number][] = [];
    for (let k = 0; k < 18; k++) ring.push([c[0] + rs * Math.cos(k * Math.PI / 9), c[1] + rs * Math.sin(k * Math.PI / 9)]);
    hol.prism(ring, 0.3, 0.75);
  }
  const w = Math.max(t.type === "groove" ? t.width + 6 : 11, z1 - z0), x0 = t.type === "groove" ? z0 - 1 : t.hand === "L" ? z1 - w : t.hand === "N" ? (z0 + z1) / 2 - w / 2 : z0, yA = side * r0, yB = side * (r1 + 38);
  hol.box(x0 + 0.4, x0 + w, Math.min(yA, yB), Math.max(yA, yB), -14, -3);
  hol.box(x0 + 0.4, x0 + w, Math.min(side * (r1 + 2), yB), Math.max(side * (r1 + 2), yB), -3, 1.5);
  return { insert: ins.done(), holder: hol.done() };
}
/** Bahnen als Linien (Eilgang und Vorschub getrennt) in der Ebene der Schneide */
export function pathLines(moves: TurnMove[], side: -1 | 1): { feed: number[]; rapid: number[] } {
  const feed: number[] = [], rapid: number[] = [];
  moves.forEach((m, i) => { if (i < 2) return; (m.rapid ? rapid : feed).push(m.z0, side * m.r0, 0.05, m.z1, side * m.r1, 0.05); });
  return { feed, rapid };
}
