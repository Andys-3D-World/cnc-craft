/**
 * SIMULATION MIT DREHACHSE: Bahnen um das runde Teil wickeln (3D-Ansicht in simView.ts)
 *
 * Gezeigt wird das Teil, wie es im Futter liegt: Achse entlang X auf Höhe z = −R (Z 0 = Oberkante des Rohteils),
 * die Bahnen dort, wo der Fräser/Laser das Teil berührt. Zwei Fälle:
 *   - „surface“: G-Code der Zeichnung vor der Umrechnung (Y = mm rundherum auf der Oberfläche) → Winkel = Y / R
 *   - „a“: fertiger G-Code mit A-Achse (Grad), Y = Querfahrt (meist 0, beim Fräsen von mehreren Seiten nicht)
 * Der Fräser steht oben (+Z); bei Winkel θ berührt er die Stelle (y, z) des Teils, die um +X um θ gedreht oben liegt
 * – gleiche Richtung wie cam3d.rs (rotary_field) und rotary3d.ts.
 * Bewegungen mit Drehung werden in Stücke von höchstens 2° geteilt, damit sie auf dem Zylinder rund aussehen.
 * Achse entlang Y: intern gerechnet wie entlang X (X_i = Y, Y_i = −X, siehe rotaryWrap.ts), gezeigt wird das Teil
 * wieder entlang Y. „Drehrichtung umkehren“: A bedeutet die Gegenrichtung.
 */
import type { SimProgram } from "./gcodeParser";

const STEP = (2 * Math.PI) / 180;   // höchstens 2° je Stück
const MAX_MOVES = 4_000_000;

export interface WrapSimOpts {
  aScale?: number;        // Teil-Drehung je Grad A (Rollen-Drehachse: Rolle Ø / Teil Ø, sonst 1)
  along?: "x" | "y";      // Lage der Drehachse
  reverse?: boolean;      // Drehrichtung umgekehrt
}

export function wrapSimProgram(p: SimProgram, R: number, mode: "surface" | "a", o: WrapSimOpts = {}): SimProgram {
  const useA = mode === "a" && !!p.a0 && !!p.a1;
  const ay = o.along === "y";
  const aK = (o.aScale ?? 1) * (o.reverse ? -1 : 1);
  // intern: entlang (ax) und quer (cr)
  const ax = (i: number, end: boolean) => ay ? (end ? p.y1[i] : p.y0[i]) : (end ? p.x1[i] : p.x0[i]);
  const cr = (i: number, end: boolean) => ay ? -(end ? p.x1[i] : p.x0[i]) : (end ? p.y1[i] : p.y0[i]);
  const th = (i: number, end: boolean) => useA
    ? ((end ? p.a1![i] : p.a0![i]) * Math.PI * aK) / 180
    : cr(i, end) / R;
  // Stückzahl je Bewegung (bei sehr vielen Bewegungen gröber)
  let total = 0;
  const pieces = new Uint32Array(p.n);
  for (let i = 0; i < p.n; i++) { pieces[i] = Math.max(1, Math.ceil(Math.abs(th(i, true) - th(i, false)) / STEP - 1e-9)); total += pieces[i]; }
  if (total > MAX_MOVES) {
    const k = MAX_MOVES / total;
    total = 0;
    for (let i = 0; i < p.n; i++) { pieces[i] = Math.max(1, Math.floor(pieces[i] * k)); total += pieces[i]; }
  }
  const x0 = new Float32Array(total), y0 = new Float32Array(total), z0 = new Float32Array(total);
  const x1 = new Float32Array(total), y1 = new Float32Array(total), z1 = new Float32Array(total);
  const type = new Uint8Array(total), line = new Uint32Array(total), t0 = new Float64Array(total), dur = new Float32Array(total);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let aMin = Infinity, aMax = -Infinity;
  // Punkt (x, Querfahrt ym, Höhe z, Winkel t) → Lage am Teil
  const put = (x: number, ym: number, z: number, t: number, X: Float32Array, Y: Float32Array, Z: Float32Array, k: number) => {
    const c = Math.cos(t), s = Math.sin(t), r = R + z;
    const py = ym * c + r * s, pz = -ym * s + r * c - R;
    // gezeigt: Achse entlang X (x, py) oder zurück gedreht entlang Y (−py, x)
    const qx = ay ? -py : x, qy = ay ? x : py;
    X[k] = qx; Y[k] = qy; Z[k] = pz;
    if (qx < minX) minX = qx; if (qx > maxX) maxX = qx;
    if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  };
  let k = 0;
  for (let i = 0; i < p.n; i++) {
    const n = pieces[i];
    const ta = th(i, false), tb = th(i, true);
    aMin = Math.min(aMin, ta, tb); aMax = Math.max(aMax, ta, tb);
    const ya = useA ? cr(i, false) : 0, yb = useA ? cr(i, true) : 0;
    const xa = ax(i, false), xb = ax(i, true);
    for (let q = 0; q < n; q++, k++) {
      const u0 = q / n, u1 = (q + 1) / n;
      const L = (a: number, b: number, u: number) => a + (b - a) * u;
      put(L(xa, xb, u0), L(ya, yb, u0), L(p.z0[i], p.z1[i], u0), L(ta, tb, u0), x0, y0, z0, k);
      put(L(xa, xb, u1), L(ya, yb, u1), L(p.z0[i], p.z1[i], u1), L(ta, tb, u1), x1, y1, z1, k);
      type[k] = p.type[i]; line[k] = p.line[i];
      dur[k] = p.dur[i] / n;
      t0[k] = p.t0[i] + (p.dur[i] * q) / n;
    }
  }
  if (!total) { minX = minY = minZ = maxX = maxY = maxZ = 0; aMin = aMax = 0; }
  const deg = 180 / Math.PI;
  return {
    ...p, n: total, x0, y0, z0, x1, y1, z1, type, line, t0, dur, a0: undefined, a1: undefined,
    bounds: { minX, minY, minZ, maxX, maxY, maxZ },
    rotary: { R, flat: p.bounds, aMin: aMin * deg, aMax: aMax * deg, along: ay ? "y" : "x" }
  };
}

/** Tiefe eines Punkts am gewickelten Teil (Abstand zur Achse − R) – für die Farben nach Tiefe; q = quer zur Achse */
export function radialDepth(q: number, z: number, R: number): number {
  return Math.hypot(q, z + R) - R;
}
