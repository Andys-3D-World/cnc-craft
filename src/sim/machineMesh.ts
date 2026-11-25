/**
 * MASCHINE IN DER SIMULATION – Bett (Opferplatte, Wabe, Lamellen), Portal, Spannpratzen, Futter und Reitstock der Drehachse.
 * Nur gezeichnet, ohne Maße der echten Maschine. Je Punkt 10 Zahlen: Lage, Normale, Farbe mit Deckkraft (wie simCarveGl.ts).
 */
import earcut from "earcut";

export type EnvKind = "mill" | "laser" | "plasma";
type Col = [number, number, number];
const MDF: Col = [0.55, 0.43, 0.3], SLOT: Col = [0.2, 0.16, 0.12], ALU: Col = [0.62, 0.65, 0.7], DARK: Col = [0.24, 0.26, 0.31], STEEL: Col = [0.42, 0.44, 0.48], CLAMP: Col = [0.85, 0.3, 0.28], JAW: Col = [0.5, 0.52, 0.57];

export function box(o: number[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: Col, a = 1) {
  const q = (p: number[][], n: number[]) => { for (const k of [0, 1, 2, 0, 2, 3]) o.push(p[k][0], p[k][1], p[k][2], n[0], n[1], n[2], c[0], c[1], c[2], a); };
  q([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]); q([[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]], [0, 1, 0]);
  q([[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]], [-1, 0, 0]); q([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0]);
  q([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]); q([[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]], [0, 0, -1]);
}
/** Umriss (x, r) um die x-Achse gedreht */
export function turned(o: number[], pts: [number, number][], c: Col, a = 1, seg = 40) {
  for (let k = 0; k + 1 < pts.length; k++) {
    const [xa, ra] = pts[k], [xb, rb] = pts[k + 1], l = Math.hypot(xb - xa, rb - ra) || 1, nx = -(rb - ra) / l, nr = (xb - xa) / l;
    for (let s = 0; s < seg; s++) {
      const a0 = s / seg * 2 * Math.PI, a1 = (s + 1) / seg * 2 * Math.PI;
      const v = (x: number, r: number, w: number) => o.push(x, r * Math.cos(w), r * Math.sin(w), nx, nr * Math.cos(w), nr * Math.sin(w), c[0], c[1], c[2], a);
      v(xa, ra, a0); v(xa, ra, a1); v(xb, rb, a1); v(xa, ra, a0); v(xb, rb, a1); v(xb, rb, a0);
    }
  }
}
/** Abstand der Streben: höchstens `max` Stück */
const pitch = (len: number, want: number, max: number) => Math.max(want, len / max);

/** Bett unter dem Rohteil (Oberkante knapp unter der Unterseite) */
export function bedMesh(kind: EnvKind, W: number, H: number, T: number): Float32Array {
  const o: number[] = [], z = -T - 0.06;
  if (kind === "mill") {
    box(o, -15, W + 15, -15, H + 15, z - 14, z, MDF);
    const p = pitch(W, 75, 24);
    for (let x = p / 2; x < W; x += p) box(o, x - 4, x + 4, -15, H + 15, z - 0.5, z + 0.03, SLOT);
    box(o, -30, W + 30, -30, H + 30, z - 34, z - 14.1, DARK);
  } else if (kind === "laser") {
    const p = Math.max(pitch(W, 10, 70), pitch(H, 10, 70));
    for (let x = 0; x <= W + 1e-6; x += p) box(o, x - 0.25, x + 0.25, 0, H, z - 10, z, ALU);
    for (let y = 0; y <= H + 1e-6; y += p) box(o, 0, W, y - 0.25, y + 0.25, z - 10, z, ALU);
    frame(o, W, H, z, 14);
    box(o, -12, W + 12, -12, H + 12, z - 24, z - 22, DARK);
  } else {
    const p = pitch(W, 50, 50);
    for (let x = p / 2; x < W; x += p) box(o, x - 1.5, x + 1.5, -5, H + 5, z - 55, z, STEEL);
    frame(o, W, H, z - 5, 60);
  }
  return new Float32Array(o);
}
function frame(o: number[], W: number, H: number, z: number, h: number) {
  box(o, -14, W + 14, -14, -2, z - h, z, DARK); box(o, -14, W + 14, H + 2, H + 14, z - h, z, DARK);
  box(o, -14, -2, -2, H + 2, z - h, z, DARK); box(o, W + 2, W + 14, -2, H + 2, z - h, z, DARK);
}
/** Portal: bewegt sich mit Y. Steht hinter dem Werkzeug, halb durchsichtig. zTop: so hoch liegt der Kopf */
export function gantryMesh(kind: EnvKind, W: number, T: number, head: number): Float32Array {
  const o: number[] = [], a = 0.34, z0 = -T - (kind === "mill" ? 30 : 14), b = Math.max(30, head * 0.45), t = kind === "mill" ? 60 : 34, y = kind === "mill" ? 40 : 26;
  for (const x of [-46, W + 28]) box(o, x, x + 18, y - 6, y + t * 0.7 + 10, z0, b + t + 6, ALU, a);
  box(o, -28, W + 28, y, y + t * 0.55, b, b + t, ALU, a);
  return new Float32Array(o);
}
/** Schlitten am Portal: bewegt sich mit X und Y */
export function carriageMesh(kind: EnvKind, head: number): Float32Array {
  const o: number[] = [], b = Math.max(30, head * 0.45), t = kind === "mill" ? 60 : 34, y = kind === "mill" ? 40 : 26, w = kind === "mill" ? 38 : 22;
  box(o, -w, w, y - 9, y - 0.5, b - 12, b + t + 14, DARK, 0.5);
  return new Float32Array(o);
}
/** Spannpratzen (Sperrzonen) als Körper vom Bett bis zu ihrer Höhe */
export function clampMesh(zones: { pts: { x: number; y: number }[]; height: number }[], T: number): Float32Array {
  const o: number[] = [], a = 0.62, [r, g, b] = CLAMP;
  for (const zn of zones) {
    const p = zn.pts.filter((q, i) => { const n = zn.pts[(i + 1) % zn.pts.length]; return Math.hypot(q.x - n.x, q.y - n.y) > 1e-6; });
    if (p.length < 3) continue;
    const z0 = -T, z1 = Math.max(z0 + 0.5, zn.height);
    let area = 0;
    p.forEach((q, i) => { const n = p[(i + 1) % p.length]; area += q.x * n.y - n.x * q.y; });
    const ix = earcut(p.flatMap(q => [q.x, q.y]));
    for (const i of ix) o.push(p[i].x, p[i].y, z1, 0, 0, 1, r, g, b, a);
    p.forEach((q, i) => {
      const n = p[(i + 1) % p.length], l = Math.hypot(n.x - q.x, n.y - q.y), s = area > 0 ? 1 : -1, nx = s * (n.y - q.y) / l, ny = -s * (n.x - q.x) / l;
      const v = (x: number, y: number, z: number) => o.push(x, y, z, nx, ny, 0, r, g, b, a);
      v(q.x, q.y, z0); v(n.x, n.y, z0); v(n.x, n.y, z1); v(q.x, q.y, z0); v(n.x, n.y, z1); v(q.x, q.y, z1);
    });
  }
  return new Float32Array(o);
}
/** Drehachse mit Futter: dreht sich mit (Achse = x, Backen-Vorderkante bei x0). R = Umkreis des Rohteils */
export function rotaryChuck(x0: number, R: number): Float32Array {
  const o: number[] = [], Rc = Math.max(28, R * 1.5 + 8), jl = Math.max(8, Math.min(18, R * 0.6)), xb = x0 - jl, d = Math.max(16, Rc * 0.4);
  turned(o, [[xb - d, 0], [xb - d, Rc], [xb, Rc], [xb, 0]], STEEL);
  for (let k = 0; k < 3; k++) {
    const w = Math.max(4, Math.min(9, R * 0.45)), t: number[] = [], c = Math.cos(k * 2 * Math.PI / 3), s = Math.sin(k * 2 * Math.PI / 3);
    box(t, xb, x0 - 0.1, R, Rc * 0.85, -w, w, JAW);
    for (let i = 0; i < t.length; i += 10) for (const q of [1, 4]) { const y = t[i + q], z = t[i + q + 1]; t[i + q] = y * c - z * s; t[i + q + 1] = y * s + z * c; }
    for (const v of t) o.push(v);
  }
  return new Float32Array(o);
}
/** fester Teil der Drehachse: Kopf hinter dem Futter und Körnerspitze am anderen Ende */
export function rotaryFixed(x0: number, x1: number, R: number): Float32Array {
  const o: number[] = [], Rc = Math.max(28, R * 1.5 + 8), jl = Math.max(8, Math.min(18, R * 0.6)), xb = x0 - jl - Math.max(16, Rc * 0.4), c = Math.min(8, Math.max(3, R * 0.35));
  box(o, xb - 42, xb - 2, -Rc * 0.75, Rc * 0.75, -Rc * 1.15, Rc * 0.75, DARK);
  turned(o, [[x1 - 1, 0], [x1 + c * 1.73, c], [x1 + c * 1.73 + 14, c], [x1 + c * 1.73 + 14, c * 1.8], [x1 + c * 1.73 + 40, c * 1.8], [x1 + c * 1.73 + 40, 0]], ALU, 1, 28);
  box(o, x1 + c * 1.73 + 16, x1 + c * 1.73 + 38, -c * 2.4, c * 2.4, -Rc * 1.15, c * 2.2, DARK);
  return new Float32Array(o);
}
/** Rollen-Drehachse: zwei Walzen unter dem Teil (Achse = x, Mitte des Teils bei 0) */
export function rollers(x0: number, x1: number, R: number, dia: number): Float32Array {
  const o: number[] = [], r = Math.max(4, dia / 2), gap = Math.min(R + r - 1, Math.max(r + 1, R * 0.62)), z = -Math.sqrt(Math.max(0, (R + r) ** 2 - gap * gap));
  for (const s of [-1, 1]) {
    const t: number[] = [];
    turned(t, [[x0 - 15, 0], [x0 - 15, r], [x1 + 15, r], [x1 + 15, 0]], DARK, 1, 28);
    for (let i = 0; i < t.length; i += 10) { t[i + 1] += s * gap; t[i + 2] += z; }
    for (const v of t) o.push(v);
  }
  return new Float32Array(o);
}
