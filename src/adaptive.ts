/**
 * ADAPTIVES AUSRÄUMEN (Taschen-Strategie „Adaptiv“)
 *
 * Ziel: der Fräser soll überall etwa gleich stark im Material stecken (gleichmäßige Umschlingung) –
 * nie voll im Material wie beim ersten Zickzack-Schnitt oder in Ecken. Das schont Fräser und Maschine.
 *
 *  1. Ringe im Abstand RING (Anteil vom Fräserdurchmesser) wie bei „Kontur“, aber von innen nach außen.
 *  2. Ein Raster merkt sich, wo schon Material weg ist. Vor jedem Schritt wird gemessen, welcher Teil des
 *     Fräserumfangs im Material steckt.
 *  3. Wenig Umschlingung -> gerade weiterfahren. Zu viel (Ecken, Einstieg, enge Stellen) -> kleine
 *     Schleifen (trochoidal), die jedes Mal nur einen schmalen Streifen abnehmen.
 *  4. In neues Material taucht der Fräser schraubenförmig ein (Helix), nicht senkrecht.
 * Schleifen und Helix werden so klein, dass sie nie näher als den Werkzeugradius an Wand oder Insel kommen.
 */
import { offsetPolygon, pointInPoly, P } from "./polyOffset";

export interface AdaptivePath { pts: P[]; closed: boolean; helix?: { x: number; y: number; r: number } }
/** Linie an Kanten teilen und nur die erlaubten Stücke behalten (clip aus pocket.ts) */
export type ClipFn = (pts: P[], closed: boolean, edges: [P, P][], keep: (p: P) => boolean) => { pts: P[]; closed: boolean }[];

const RING = 0.3;      // Abstand der Ringe (× Durchmesser) = seitliche Zustellung auf geraden Stücken
const LOOP = 0.3;      // Radius der Schleifen (× Durchmesser)
const PITCH = 0.08;    // Vorschub je Schleife (× Durchmesser) = Materialstreifen je Schleife
const EMAX = 0.25;     // erlaubte Umschlingung (Anteil des Umfangs, 0.25 = 90°; voller Schnitt = 180°)
const LOOP_PTS = 16;   // Punkte je Schleife
const MAX_CELLS = 3_000_000;

/** Raster über der Tasche: was noch Material ist und wie viel Platz der Fräsermittelpunkt hat */
class Grid {
  w: number; h: number;
  rest: Uint8Array;      // 1 = Material steht noch
  clear: Float32Array;   // Abstand (mm) des Mittelpunkts bis zur verbotenen Zone
  constructor(public x0: number, public y0: number, x1: number, y1: number, public c: number) {
    this.w = Math.max(1, Math.ceil((x1 - x0) / c));
    this.h = Math.max(1, Math.ceil((y1 - y0) / c));
    this.rest = new Uint8Array(this.w * this.h);
    this.clear = new Float32Array(this.w * this.h);
  }
  idx(x: number, y: number): number {
    const i = Math.floor((x - this.x0) / this.c), j = Math.floor((y - this.y0) / this.c);
    return i < 0 || j < 0 || i >= this.w || j >= this.h ? -1 : j * this.w + i;
  }
  /** Zeilenweise füllen (gerade/ungerade-Regel), fn bekommt Zeile und Spalten-Bereich */
  spans(polys: P[][], fn: (j: number, i0: number, i1: number) => void) {
    for (let j = 0; j < this.h; j++) {
      const y = this.y0 + (j + 0.5) * this.c;
      const xs: number[] = [];
      for (const p of polys) for (let k = 0; k < p.length; k++) {
        const a = p[k], b = p[(k + 1) % p.length];
        if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - this.x0) / this.c - 0.5));
        const i1 = Math.min(this.w - 1, Math.floor((xs[k + 1] - this.x0) / this.c - 0.5));
        if (i1 >= i0) fn(j, i0, i1);
      }
    }
  }
  /** Fräser (Kreis) an dieser Stelle: Material dort ist weg */
  stamp(x: number, y: number, rad: number) {
    const c = this.c, r2 = rad * rad;
    const i0 = Math.max(0, Math.floor((x - rad - this.x0) / c)), i1 = Math.min(this.w - 1, Math.ceil((x + rad - this.x0) / c));
    const j0 = Math.max(0, Math.floor((y - rad - this.y0) / c)), j1 = Math.min(this.h - 1, Math.ceil((y + rad - this.y0) / c));
    for (let j = j0; j <= j1; j++) {
      const dy = this.y0 + (j + 0.5) * c - y;
      for (let i = i0; i <= i1; i++) {
        const dx = this.x0 + (i + 0.5) * c - x;
        if (dx * dx + dy * dy <= r2) this.rest[j * this.w + i] = 0;
      }
    }
  }
  isRest(x: number, y: number): boolean { const k = this.idx(x, y); return k >= 0 && this.rest[k] === 1; }
  clearance(x: number, y: number): number { const k = this.idx(x, y); return k < 0 ? 0 : Math.max(0, this.clear[k] - this.c); }
}

/** Abstand jeder erlaubten Zelle bis zur nächsten verbotenen (Chamfer 1 / √2, in mm) */
function distance(g: Grid, allowed: Uint8Array) {
  const W = g.w, H = g.h, D = g.clear, s2 = Math.SQRT2;
  for (let k = 0; k < W * H; k++) D[k] = allowed[k] ? 1e9 : 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (!D[k]) continue;
    let v = D[k];
    if (i > 0) v = Math.min(v, D[k - 1] + 1); else v = Math.min(v, 1);
    if (j > 0) { v = Math.min(v, D[k - W] + 1); if (i > 0) v = Math.min(v, D[k - W - 1] + s2); if (i < W - 1) v = Math.min(v, D[k - W + 1] + s2); } else v = Math.min(v, 1);
    D[k] = v;
  }
  for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
    const k = j * W + i;
    if (!D[k]) continue;
    let v = D[k];
    if (i < W - 1) v = Math.min(v, D[k + 1] + 1); else v = Math.min(v, 1);
    if (j < H - 1) { v = Math.min(v, D[k + W] + 1); if (i < W - 1) v = Math.min(v, D[k + W + 1] + s2); if (i > 0) v = Math.min(v, D[k + W - 1] + s2); } else v = Math.min(v, 1);
    D[k] = v;
  }
  // Chamfer schätzt bis ~8 % zu viel -> etwas abziehen (lieber kleinere Schleifen)
  for (let k = 0; k < W * H; k++) D[k] = D[k] * g.c * 0.92;
}

/** Linie in gleich lange Stücke teilen (closed: zurück zum Anfang) */
function resample(pts: P[], closed: boolean, h: number): P[] {
  const seq = closed ? [...pts, pts[0]] : pts;
  const out: P[] = [seq[0]];
  let carry = 0;
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1], b = seq[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let d = h - carry;
    while (d <= len) { const t = d / len; out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); d += h; }
    carry = len - (d - h);
  }
  const last = seq[seq.length - 1], end = out[out.length - 1];
  if (Math.hypot(last.x - end.x, last.y - end.y) > 1e-6) out.push(last);
  return out;
}

/** Punkte auf geraden Strecken weglassen (kleinere Dateien) */
function simplify(p: P[], tol = 0.002): P[] {
  if (p.length < 3) return p;
  const out = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const a = out[out.length - 1], b = p[i], c = p[i + 1];
    const len = Math.hypot(c.x - a.x, c.y - a.y);
    const dist = len < 1e-9 ? Math.hypot(b.x - a.x, b.y - a.y) : Math.abs((c.x - a.x) * (a.y - b.y) - (a.x - b.x) * (c.y - a.y)) / len;
    if (dist > tol) out.push(b);
  }
  out.push(p[p.length - 1]);
  return out;
}

/**
 * @param outer   Wand der Tasche (mm), islands: Inseln
 * @param wall    Grenze für den Fräsermittelpunkt (outer um -r versetzt), isl: Inseln um +r versetzt
 * @param clip    Linie an Kanten teilen (aus pocket.ts)
 */
export function adaptivePaths(outer: P[], islands: P[][], r: number, wall: P[][], isl: P[][], clip: ClipFn): AdaptivePath[] {
  const D = 2 * r;
  const s = Math.max(0.02, RING * D), a = LOOP * D, h = Math.max(0.01, PITCH * D);

  // ---- Raster ----
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of outer) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const area = (x1 - x0 + 2 * D) * (y1 - y0 + 2 * D);
  const c = Math.max(D / 20, Math.sqrt(area / MAX_CELLS), 0.005);
  const g = new Grid(x0 - D, y0 - D, x1 + D, y1 + D, c);
  g.spans([outer, ...islands], (j, i0, i1) => g.rest.fill(1, j * g.w + i0, j * g.w + i1 + 1));
  const allowed = new Uint8Array(g.w * g.h);
  g.spans(wall, (j, i0, i1) => allowed.fill(1, j * g.w + i0, j * g.w + i1 + 1));
  for (const i of isl) g.spans([i], (j, i0, i1) => allowed.fill(0, j * g.w + i0, j * g.w + i1 + 1));
  distance(g, allowed);

  // Umschlingung: Anteil des Umfangs (knapp außerhalb des Fräsers), der noch im Material liegt
  const N = 48, rm = r + c;
  const ring = Array.from({ length: N }, (_, k) => ({ x: Math.cos((2 * Math.PI * k) / N) * rm, y: Math.sin((2 * Math.PI * k) / N) * rm }));
  // dir = Fahrtrichtung: nur die vordere Hälfte zählt (dahinter schneidet der Fräser nicht); ohne dir der ganze Umfang
  const engage = (q: P, dir?: P) => {
    let n = 0;
    for (const o of ring) if ((!dir || o.x * dir.x + o.y * dir.y >= 0) && g.isRest(q.x + o.x, q.y + o.y)) n++;
    return n / N;
  };
  const dirAt = (S: P[], k: number) => { const a = S[Math.max(0, k - 1)], b = S[Math.max(1, k)]; return { x: b.x - a.x, y: b.y - a.y }; };

  // ---- Ringe von innen nach außen (wie „Kontur“, nur umgekehrt) ----
  // Ring auf Höhe d = alle Punkte, die von Wand UND Inseln mindestens d entfernt sind (sonst lägen weit
  // entfernte Insel-Ringe in den Ecken an der Wand und würden zuerst – im vollen Material – gefräst)
  const edgesOf = (loops: P[][]) => loops.flatMap(l => l.map((p, i) => [p, l[(i + 1) % l.length]] as [P, P]));
  const levels: { pts: P[]; closed: boolean }[][] = [];
  for (let k = 1; k < 4000; k++) {
    const d = r + k * s;
    const W = offsetPolygon(outer, -d, 0.01);
    if (!W.length) break;
    const I = islands.flatMap(i => offsetPolygon(i, d, 0.01));
    const inW = (p: P) => W.some(w => pointInPoly(p.x, p.y, w));
    const inI = (p: P, skip?: P[]) => I.some(i => i !== skip && pointInPoly(p.x, p.y, i));
    const kept = [
      ...W.flatMap(w => clip(w, true, edgesOf(I), p => !inI(p))),
      ...I.flatMap(i => clip(i, true, edgesOf([...W, ...I.filter(o => o !== i)]), p => inW(p) && !inI(p, i)))
    ];
    if (!kept.length) break;
    levels.push(kept);
  }
  levels.reverse();

  const out: AdaptivePath[] = [];
  for (const level of levels) for (const rp of level) {
    const S = resample(rp.pts, rp.closed, h);
    if (S.length < 2) continue;
    const pts: P[] = [S[0]];
    let helix: AdaptivePath["helix"];
    // Einstieg: steht dort noch Material, schraubenförmig eintauchen
    if (engage(S[0]) > EMAX) {
      const rho = Math.min(a, g.clearance(S[0].x, S[0].y));
      if (rho >= 0.15 * r) { helix = { x: S[0].x, y: S[0].y, r: rho }; g.stamp(S[0].x, S[0].y, rho + r); }
    }
    g.stamp(S[0].x, S[0].y, r);

    // Seite mit weniger Material (dort beginnt jede Schleife) als Winkel
    const sideAngle = (k: number, rho: number) => {
      const p = S[k], q = S[Math.min(S.length - 1, k + 1)], o = S[Math.max(0, k - 1)];
      let tx = q.x - o.x, ty = q.y - o.y;
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const reach = rho + r;
      const count = (sx: number, sy: number) => { let n = 0; for (let f = 0.4; f <= 1.01; f += 0.3) if (g.isRest(p.x + sx * reach * f, p.y + sy * reach * f)) n++; return n; };
      return count(-ty, tx) <= count(ty, -tx) ? Math.atan2(tx, -ty) : Math.atan2(-tx, ty);
    };
    const rhoAt = (k: number) => Math.min(a, g.clearance(S[k].x, S[k].y));

    let i = 1;
    while (i < S.length) {
      if (engage(S[i], dirAt(S, i)) <= EMAX) { pts.push(S[i]); g.stamp(S[i].x, S[i].y, r); i++; continue; }
      // ---- Schleifen ab S[i-1], bis das Material hinter dem Schleifen-Streifen wieder normal ist ----
      let k = i - 1;
      let rho = rhoAt(k), phi = sideAngle(k, rho);
      if (rho < 0.15 * r) { pts.push(S[i]); g.stamp(S[i].x, S[i].y, r); i++; continue; } // zu eng: gerade (wie bisher)
      pts.push({ x: S[k].x + rho * Math.cos(phi), y: S[k].y + rho * Math.sin(phi) });
      while (k < S.length - 1) {
        const rho2 = rhoAt(k + 1);
        if (rho2 < 0.15 * r) break; // zu eng für Schleifen
        const phi2 = sideAngle(k + 1, rho2);
        let dphi = phi2 - phi;
        while (dphi > Math.PI) dphi -= 2 * Math.PI;
        while (dphi <= -Math.PI) dphi += 2 * Math.PI;
        for (let m = 1; m <= LOOP_PTS; m++) {
          const u = m / LOOP_PTS;
          const cx = S[k].x + (S[k + 1].x - S[k].x) * u, cy = S[k].y + (S[k + 1].y - S[k].y) * u;
          const rr = rho + (rho2 - rho) * u, an = phi + (2 * Math.PI + dphi) * u; // gegen den Uhrzeiger = Gleichlauf
          const q = { x: cx + rr * Math.cos(an), y: cy + rr * Math.sin(an) };
          pts.push(q);
          g.stamp(q.x, q.y, r);
        }
        k++; rho = rho2; phi = phi2;
        // vorausschauen: hinter dem Streifen der Schleife wieder normale Umschlingung?
        const look = Math.min(S.length - 1, k + Math.ceil((rho + r * 0.5) / h));
        if (engage(S[look], dirAt(S, look)) <= EMAX) break;
      }
      if (k === i - 1) { k = i; } // keine Schleife möglich (zu eng): ein gerader Schritt, damit es weitergeht
      pts.push(S[k]); // zurück auf die Mittellinie
      g.stamp(S[k].x, S[k].y, r);
      i = k + 1;
    }
    out.push({ pts: simplify(pts), closed: false, helix });
  }
  return out;
}
