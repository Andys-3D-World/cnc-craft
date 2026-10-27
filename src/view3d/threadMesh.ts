/**
 * GEWINDEGÄNGE IN DER 3D-ANSICHT
 *
 * Das Fräsergebnis (carveSim.ts) ist ein Höhenraster – seitliche Rillen in einer Wand kann es nicht zeigen.
 * Dort sieht ein Gewinde aus wie ein glattes Loch (Ø = Nenn-Ø) bzw. ein glatter Bolzen (Ø = Kern-Ø).
 * Diese Datei legt deshalb an jedes gefräste Gewinde (cam.ts → lastThreads) die Gewindeflanken als eigenes Netz:
 * eine Fläche um die Achse, deren Radius mit Höhe und Winkel dem ISO-Profil (60°) folgt – innen stehen die
 * Spitzen bis zum Kernloch nach innen, außen bis zum Nenn-Ø nach außen. Dazu Ringe oben und unten.
 */
import type { Mesh } from "./viewer3d";
import type { ThreadInfo } from "../threadMill";

const SLOPE = Math.tan(60 * Math.PI / 180); // radiale Tiefe je mm entlang der Achse (60°-Flanken)
const MAX_TRIS = 400_000;

/** Radius der Gewindefläche bei Höhe z (≤ 0) und Winkel a */
export function threadRadius(t: ThreadInfo, z: number, a: number): number {
  const Rmaj = t.majorD / 2, Rmin = t.minorD / 2, P = t.P;
  // Lage im Gewindegang: Rechtsgewinde steigt gegen den Uhrzeigersinn
  let u = z / P - (t.left ? -1 : 1) * a / (2 * Math.PI);
  u -= Math.floor(u);
  const d = Math.max(0, Math.abs(u - 0.5) * P - P / 16) * SLOPE; // Abstand vom Gewindegrund (radial)
  return t.internal ? Math.max(Rmin, Rmaj - d) : Math.min(Rmaj, Rmin + d);
}

export function threadMeshes(threads: ThreadInfo[], top: number, color: [number, number, number]): Mesh[] {
  const out: Mesh[] = [];
  let budget = MAX_TRIS;
  for (const t of threads) {
    if (!(t.P > 0 && t.length > 0 && t.majorD > t.minorD)) continue;
    const NA = 72;
    const NZ = Math.max(8, Math.min(4000, Math.ceil(t.length / t.P * 24), Math.floor(budget / (NA * 2))));
    if (NZ < 8) break;
    budget -= NA * NZ * 2;
    const wall: Mesh = { pos: [], nrm: [], color };
    const caps: Mesh = { pos: [], nrm: [], color };
    const pt = (a: number, z: number) => {
      const r = threadRadius(t, z, a);
      return [t.cx + r * Math.cos(a), t.cy + r * Math.sin(a), top + z];
    };
    // Normale aus zwei Richtungen (Winkel, Höhe); innen zur Achse hin, außen von ihr weg
    const normal = (a: number, z: number) => {
      const e = 1e-3;
      const p0 = pt(a, z), pa = pt(a + e, z), pz = pt(a, z + e);
      const ta = [pa[0] - p0[0], pa[1] - p0[1], pa[2] - p0[2]], tz = [pz[0] - p0[0], pz[1] - p0[1], pz[2] - p0[2]];
      let n = [ta[1] * tz[2] - ta[2] * tz[1], ta[2] * tz[0] - ta[0] * tz[2], ta[0] * tz[1] - ta[1] * tz[0]];
      const out = n[0] * Math.cos(a) + n[1] * Math.sin(a);
      if ((t.internal && out > 0) || (!t.internal && out < 0)) n = n.map(v => -v);
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      return n.map(v => v / l);
    };
    const A = (i: number) => (i / NA) * Math.PI * 2;
    const Z = (j: number) => -t.length + (j / NZ) * t.length;
    const push = (m: Mesh, p: number[], n: number[]) => { m.pos.push(p[0], p[1], p[2]); m.nrm.push(n[0], n[1], n[2]); };
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NA; i++) {
      const q = [[A(i), Z(j)], [A(i + 1), Z(j)], [A(i + 1), Z(j + 1)], [A(i), Z(j + 1)]];
      for (const k of [0, 1, 2, 0, 2, 3]) push(wall, pt(q[k][0], q[k][1]), normal(q[k][0], q[k][1]));
    }
    // Ringe oben (Werkstück-Oberkante) und unten: zwischen Gewindefläche und glatter Wand des Höhenrasters
    const edgeR = t.internal ? t.majorD / 2 + 0.02 : t.minorD / 2 - 0.02;
    for (const [z, nz] of [[0, 1], [-t.length, -1]] as const) {
      for (let i = 0; i < NA; i++) {
        const a0 = A(i), a1 = A(i + 1);
        const p0 = pt(a0, z), p1 = pt(a1, z);
        const e0 = [t.cx + edgeR * Math.cos(a0), t.cy + edgeR * Math.sin(a0), top + z];
        const e1 = [t.cx + edgeR * Math.cos(a1), t.cy + edgeR * Math.sin(a1), top + z];
        for (const p of [p0, e0, e1, p0, e1, p1]) push(caps, p, [0, 0, nz]);
      }
    }
    out.push(wall, caps);
  }
  return out;
}
