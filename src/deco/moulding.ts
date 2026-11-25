/**
 * PROFILLEISTE ENTLANG EINER BAHN – reine Rechnung (Tests: tests/deco.test.ts)
 *
 * Ein Querschnitt (u = Abstand von der Linie, z ≤ 0) wird an einer Kontur entlanggezogen. Der Fräser fährt viele parallele
 * Bahnen; die Tiefe jeder Bahn ist die tiefste, bei der er den Querschnitt nirgends unterschreitet (Form des Fräsers
 * eingerechnet). Erst schruppen in Ebenen mit Aufmaß, dann schlichten. Genau an geraden Stücken; in engen Innenbögen
 * (Bogenradius kleiner als Profil plus Fräser) fallen Bahnen weg.
 */
import { offsetPolygon, type P } from "../polyOffset.ts";

export type MouldKind = "chamfer" | "cove" | "round" | "ogee" | "steps" | "double" | "groove" | "bead";
export const MOULD_KINDS: MouldKind[] = ["chamfer", "cove", "round", "ogee", "steps", "double", "groove", "bead"];
/** bei diesen bleibt das Material hinter dem Profil stehen */
export const STANDING: MouldKind[] = ["groove", "bead"];

/** Höhe des Querschnitts bei u (0…W) */
export function profileZ(kind: MouldKind, u: number, W: number, H: number): number {
  if (u < 0) return 0;
  if (u > W) return STANDING.includes(kind) ? 0 : -H;
  const q = (x: number) => Math.sqrt(Math.max(0, 1 - x * x)), t = u / W;
  switch (kind) {
    case "chamfer": return -H * t;
    case "cove": return -H * q(1 - t);
    case "round": return -H + H * q(t);
    case "ogee": return t < 0.5 ? -H / 2 * (1 - q(2 * t)) : -H / 2 - H / 2 * q(1 - (2 * t - 1));
    case "steps": return t < 0.5 ? -H / 2 : -H;
    case "double": return t < 0.5 ? -H / 2 * (1 - q(2 * t)) : -H / 2 - H / 2 * (1 - q(2 * t - 1));
    case "groove": return -H * q(2 * t - 1);
    case "bead": return -H * (1 - q(2 * t - 1));
  }
}

export interface MouldOpts {
  kind: MouldKind; width: number; height: number;
  /** Fräser: Radius und Form (Höhe der Schneide im Abstand r von der Mitte) */
  R: number; shape: (r: number) => number;
  roughOver: number; finishOver: number; stepDown: number; allowance: number;
}

/** Tiefste erlaubte Spitze, wenn die Fräsermitte bei u steht */
export function cutterZ(u: number, o: MouldOpts): number {
  const n = Math.max(60, Math.min(1200, Math.ceil(2 * o.R / 0.01)));
  let z = -Infinity;
  const test = (r: number) => { const h = o.shape(Math.min(o.R, Math.abs(r))); if (Number.isFinite(h)) z = Math.max(z, profileZ(o.kind, u + r, o.width, o.height) - h); };
  for (let k = 0; k <= n; k++) test(-o.R + 2 * o.R * k / n);
  // an Stufen genau auf der Kante prüfen
  for (const e of [0, o.width / 2, o.width]) for (const s of [-1e-6, 1e-6]) { const r = e + s - u; if (Math.abs(r) <= o.R + 2e-6) test(r); }
  return Math.min(0, z);
}

/** Bahnen quer: Lage u und Tiefe z; rough = Ebene */
export interface Lane { u: number; z: number; from: number; finish: boolean }
export function lanes(o: MouldOpts): Lane[] {
  const u0 = -o.R, u1 = STANDING.includes(o.kind) ? o.width + o.R : o.width + o.R;
  const grid = (step: number) => { const n = Math.max(1, Math.ceil((u1 - u0) / Math.max(0.02, step))); return Array.from({ length: n + 1 }, (_, k) => u0 + (u1 - u0) * k / n); };
  const out: Lane[] = [], rough = grid(o.roughOver).map(u => ({ u, z: cutterZ(u, o) })), down = Math.max(0.05, o.stepDown);
  const floor = Math.min(...rough.map(r => r.z));
  // schruppen: Ebene für Ebene, nur wo noch etwas zu holen ist
  for (let lv = -down, prev = 0; ; lv -= down) {
    const level = Math.max(lv, floor + o.allowance);
    for (const r of rough) { const z = Math.max(level, r.z + o.allowance); if (z < prev - 1e-6 && z < -1e-6) out.push({ u: r.u, z, from: prev, finish: false }); }
    if (level <= floor + o.allowance + 1e-9) break;
    prev = level;
    if (out.length > 20000) break;
  }
  for (const u of grid(o.finishOver)) { const z = cutterZ(u, o); if (z < -1e-4) out.push({ u, z, from: 0, finish: true }); }
  return out;
}

/** Linie um d nach links (d > 0) versetzen; in engen Stellen fallen Stücke weg */
export function offsetOpen(pts: P[], d: number): P[][] {
  const p = pts.filter((q, i) => i === 0 || Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y) > 1e-9);
  if (p.length < 2) return [];
  if (Math.abs(d) < 1e-9) return [p];
  const raw: P[] = [], step = 0.15;
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[i], b = p[i + 1], l = Math.hypot(b.x - a.x, b.y - a.y), nx = -(b.y - a.y) / l * d, ny = (b.x - a.x) / l * d;
    if (i > 0) {
      // Außenecke: Bogen um die Ecke
      const o = p[i - 1], l0 = Math.hypot(a.x - o.x, a.y - o.y), a0 = Math.atan2((a.x - o.x) / l0 * d, -(a.y - o.y) / l0 * d), a1 = Math.atan2(ny, nx);
      let sw = a1 - a0; while (sw > Math.PI) sw -= 2 * Math.PI; while (sw < -Math.PI) sw += 2 * Math.PI;
      const n = Math.ceil(Math.abs(sw) * Math.abs(d) / step);
      for (let k = 1; k < n; k++) raw.push({ x: a.x + Math.abs(d) * Math.cos(a0 + sw * k / n), y: a.y + Math.abs(d) * Math.sin(a0 + sw * k / n) });
    }
    const n = Math.max(1, Math.ceil(l / step));
    for (let k = 0; k <= n; k++) raw.push({ x: a.x + (b.x - a.x) * k / n + nx, y: a.y + (b.y - a.y) * k / n + ny });
  }
  const near = (q: P) => { let m = Infinity; for (let i = 0; i + 1 < p.length; i++) { const a = p[i], b = p[i + 1], dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy))); m = Math.min(m, Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy)); } return m; };
  const runs: P[][] = [];
  let cur: P[] = [];
  for (const q of raw) { if (near(q) >= Math.abs(d) - 1e-4) cur.push(q); else { if (cur.length > 1) runs.push(cur); cur = []; } }
  if (cur.length > 1) runs.push(cur);
  // benachbarte Stücke an der Innenecke verbinden: dort, wo sich ihre Enden kreuzen
  const out: P[][] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last) {
      const e = last[last.length - 1], s = r[0];
      if (Math.hypot(e.x - s.x, e.y - s.y) < step * 3) {
        const a = last[last.length - 2], b = r[1], x = cross(a, e, s, b);
        if (x) last.push(x);
        last.push(...r);
        continue;
      }
    }
    out.push(r.slice());
  }
  return out.map(r => thin(r)).filter(r => r.length > 1);
}
/** Schnitt der Geraden a–b und c–d, wenn er gleich bei ihren Enden liegt */
function cross(a: P, b: P, c: P, d: P): P | null {
  const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y, den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den, q = { x: a.x + dx * t, y: a.y + dy * t };
  return Math.hypot(q.x - b.x, q.y - b.y) < 0.5 ? q : null;
}
function thin(p: P[]): P[] {
  const out: P[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = out[out.length - 1], b = p[i], c = p[i + 1];
    if (a && c) { const l = Math.hypot(c.x - a.x, c.y - a.y); if (l > 1e-9 && Math.abs((c.x - a.x) * (a.y - b.y) - (a.x - b.x) * (c.y - a.y)) / l < 0.002) continue; }
    out.push(b);
  }
  return out;
}

/** Bahnen einer Kontur im Abstand u. side: +1 außen/links, −1 innen/rechts */
export function laneAt(pts: P[], closed: boolean, side: 1 | -1, u: number): { pts: P[]; closed: boolean }[] {
  if (!closed) return offsetOpen(pts, side * u).map(p => ({ pts: p, closed: false }));
  return offsetPolygon(pts, side * u).map(p => ({ pts: p, closed: true }));
}

export interface MouldJob { paths: { pts: P[]; closed: boolean }[]; side: 1 | -1; opts: MouldOpts; feed: number; plunge: number; safeZ: number }
/** G-Code-Zeilen (ohne Kopf); lost = Bahnen, die in engen Stellen wegfallen */
export function mouldLines(j: MouldJob): { lines: string[]; cut: number; air: number; lost: number } {
  const f = (v: number) => v.toFixed(3), lines: string[] = [];
  let cut = 0, air = 0, lost = 0, lx = 0, ly = 0;
  const all = lanes(j.opts), tan = Math.tan(3 * Math.PI / 180);
  const cache = new Map<string, { pts: P[]; closed: boolean }[]>();
  for (const [pi, path] of j.paths.entries()) for (const ln of all) {
    const key = `${pi}|${ln.u.toFixed(4)}`;
    let loops = cache.get(key);
    if (!loops) { loops = laneAt(path.pts, path.closed, j.side, ln.u); cache.set(key, loops); }
    if (!loops.length) lost++;
    for (const lp of loops) {
      const s = lp.pts[0], seq = lp.closed ? [...lp.pts, s] : lp.pts;
      lines.push(`G0 X${f(s.x)} Y${f(s.y)}`);
      air += Math.hypot(s.x - lx, s.y - ly);
      const top = Math.min(0, ln.finish ? Math.min(0, ln.z + j.opts.allowance) : ln.from), drop = top - ln.z;
      let done = 0;
      const total = seq.reduce((a, q, i) => a + (i ? Math.hypot(q.x - seq[i - 1].x, q.y - seq[i - 1].y) : 0), 0), ramp = drop / tan;
      lines.push(`G1 Z${f(top)} F${j.plunge}`);
      if (lp.closed && drop > 0.05 && total > 1) {
        // geschlossen: schräg entlang der Bahn eintauchen (höchstens eine Runde), danach eine volle Runde
        const L = Math.min(ramp, total);
        for (let i = 1; i < seq.length; i++) {
          const a = seq[i - 1], b = seq[i], d = Math.hypot(b.x - a.x, b.y - a.y), feed = i === 1 ? ` F${j.feed}` : "";
          if (done < L - 1e-9 && done + d > L + 1e-9) {
            const t = (L - done) / d;
            lines.push(`G1 X${f(a.x + (b.x - a.x) * t)} Y${f(a.y + (b.y - a.y) * t)} Z${f(ln.z)}${feed}`, `G1 X${f(b.x)} Y${f(b.y)}`);
          } else if (done < L - 1e-9) lines.push(`G1 X${f(b.x)} Y${f(b.y)} Z${f(top - drop * Math.min(1, (done + d) / L))}${feed}`);
          else lines.push(`G1 X${f(b.x)} Y${f(b.y)}`);
          done += d;
        }
        cut += total;
      } else lines.push(`G1 Z${f(ln.z)} F${j.plunge}`);
      seq.slice(1).forEach((q, i) => lines.push(`G1 X${f(q.x)} Y${f(q.y)}${i === 0 ? ` F${j.feed}` : ""}`));
      cut += total;
      const e = seq[seq.length - 1];
      lx = e.x; ly = e.y;
      lines.push(`G0 Z${f(j.safeZ)}`);
    }
    if (lines.length > 600_000) return { lines, cut, air, lost };
  }
  return { lines, cut, air, lost };
}

/** Die Oberfläche, die nach dem Schlichten übrig bleibt (für die Vorschau): Höhe bei u */
export function leftover(o: MouldOpts): (u: number) => number {
  const fin = lanes(o).filter(l => l.finish);
  return u => { let z = 0; for (const l of fin) { const r = Math.abs(u - l.u); if (r <= o.R) { const h = o.shape(r); if (Number.isFinite(h)) z = Math.min(z, l.z + h); } } return z; };
}
