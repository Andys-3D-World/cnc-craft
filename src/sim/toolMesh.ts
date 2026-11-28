/**
 * FRÄSER ALS 3D-KÖRPER – mit echten Spannuten statt eines glatten Zylinders (nur Bild, keine Kollisionsprüfung)
 *
 * Der Umriss (Radius, Höhe) kommt vom Aufrufer – in der Simulation ist das dieselbe Kurve, mit der auch gefräst wird
 * (profile() in carveSim.ts). Durchmesser, Schneidenlänge und Spitzenform stimmen deshalb maßstäblich.
 * Hier kommt nur das Aussehen dazu: an jeder Stelle wird der Radius je nach Winkel etwas kleiner (Spanraum),
 * und dieses Muster dreht sich mit der Höhe weiter (Drall). Die Schneidkante selbst bleibt auf dem vollen Radius.
 *
 *   sweep        – Körper aus einem Umriss, auf Wunsch mit Nuten; glatte Flächen, scharfe Kanten
 *   cutterLook   – Anzahl Nuten, Kerndicke und Drall je Werkzeugart
 *   millToolMesh – Fräser + Schaft (fest) und Spannmutter + Spindelnase (halb durchsichtig)
 *
 * Jeder Punkt: 10 Zahlen (Ort, Normale, Farbe, Deckkraft). Deckkraft über 1 heißt „Metall“ (siehe MESH_FS in
 * simCarveGl.ts): 2 = blank und undurchsichtig, 1.5 = blank und halb durchsichtig.
 * Wird je Werkzeug einmal gebaut (einige tausend Dreiecke), danach nur noch verschoben.
 */
import type { ToolGeom } from "../toolGraphics";
import { COATING_RGB } from "../toolCoating.ts";

export type RGB = [number, number, number];
type Pt = [number, number];

/** Deckkraft-Kennung für Metall (Glanz im Shader) */
export const METAL = 1;
const STEEL: RGB = [0.74, 0.76, 0.8];
const NUT: RGB = [0.5, 0.53, 0.58];
const SPINDLE: RGB = [0.3, 0.33, 0.4];
const COS_CREASE = Math.cos(28 * Math.PI / 180);

export interface SweepOpts {
  seg: number;
  col: RGB;
  alpha: number;
  /** Radius-Faktor (0…1) je Winkel und Höhe – ohne Angabe ein glatter Drehkörper */
  factor?: (theta: number, z: number) => number;
}

/** Körper aus einem Umriss (r, z): Flächen weich schattiert, Knicke im Umriss bleiben scharfe Kanten */
export function sweep(out: number[], pts: Pt[], o: SweepOpts) {
  const K = pts.length - 1, seg = o.seg, f = o.factor;
  if (K < 1) return;
  const P = (k: number, th: number): [number, number, number] => {
    const [r, z] = pts[k], rr = f ? r * f(th, z) : r;
    return [rr * Math.cos(th), rr * Math.sin(th), z];
  };
  const smooth = pts.map((_, k) => {
    if (k === 0 || k === K) return false;
    const ax = pts[k][0] - pts[k - 1][0], az = pts[k][1] - pts[k - 1][1], bx = pts[k + 1][0] - pts[k][0], bz = pts[k + 1][1] - pts[k][1];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    return la > 1e-9 && lb > 1e-9 && (ax * bx + az * bz) / (la * lb) > COS_CREASE;
  });
  const dth = (Math.PI * 2) / seg, eps = dth * 0.5;
  // Normale am Punkt k für die Reihe row (row = k oder k − 1)
  const normal = (k: number, row: number, th: number): [number, number, number] => {
    const a = P(k, th - eps), b = P(k, th + eps);
    const c = P(smooth[k] ? k - 1 : row, th), d = P(smooth[k] ? k + 1 : row + 1, th);
    const tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2], kx = d[0] - c[0], ky = d[1] - c[1], kz = d[2] - c[2];
    let nx = ty * kz - tz * ky, ny = tz * kx - tx * kz, nz = tx * ky - ty * kx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) {
      // in der Mitte (r = 0) gibt es keine Richtung rundherum: Normale des Umriss-Stücks nehmen
      const dr = pts[row + 1][0] - pts[row][0], dz = pts[row + 1][1] - pts[row][1], m = Math.hypot(dr, dz) || 1;
      return [(dz / m) * Math.cos(th), (dz / m) * Math.sin(th), -dr / m];
    }
    nx /= l; ny /= l; nz /= l;
    return [nx, ny, nz];
  };
  const [cr, cg, cb] = o.col;
  const v = (p: number[], n: number[]) => out.push(p[0], p[1], p[2], n[0], n[1], n[2], cr, cg, cb, o.alpha);
  for (let k = 0; k < K; k++) {
    if (Math.abs(pts[k][0] - pts[k + 1][0]) < 1e-9 && Math.abs(pts[k][1] - pts[k + 1][1]) < 1e-9) continue;
    let p0 = P(k, 0), p1 = P(k + 1, 0), n0 = normal(k, k, 0), n1 = normal(k + 1, k, 0);
    for (let j = 0; j < seg; j++) {
      const th = (j + 1) * dth;
      const q0 = P(k, th), q1 = P(k + 1, th), m0 = normal(k, k, th), m1 = normal(k + 1, k, th);
      v(p0, n0); v(q0, m0); v(q1, m1);
      v(p0, n0); v(q1, m1); v(p1, n1);
      p0 = q0; p1 = q1; n0 = m0; n1 = m1;
    }
  }
}

/**
 * Querschnitt einer Nut: u = Stelle innerhalb eines Zahns (0…1, in Richtung steigender Winkel).
 * Bei 0 liegt die Schneidkante (voller Radius), dahinter fällt der Rücken zum Kern ab,
 * am Ende steigt die Spanfläche des nächsten Zahns steil wieder an.
 */
export function fluteSection(u: number, core: number): number {
  u -= Math.floor(u);
  if (u < 0.1) return 1 - 0.04 * (u / 0.1);
  if (u < 0.6) return 0.96 + (core - 0.96) * (0.5 - 0.5 * Math.cos(Math.PI * (u - 0.1) / 0.5));
  if (u < 0.8) return core;
  return core + (1 - core) * Math.pow((u - 0.8) / 0.2, 1.6);
}

export interface CutterLook {
  flutes: number;      // gezeichnete Nuten (1…8)
  core: number;        // Kern-Ø als Anteil am Schneiden-Ø
  rate: number;        // Drall: so viel dreht sich die Nut je mm Höhe (rad/mm), + = Rechtsdrall (Späne nach oben)
  split: number;       // Kompressionsfräser: bis zu dieser Höhe Rechtsdrall, darüber Linksdrall (sonst unendlich)
}

/** Aussehen der Schneiden je Werkzeugart – R und Schneidenlänge in mm */
export function cutterLook(tl: ToolGeom | null, R: number, fluteLen: number): CutterLook {
  const type = tl?.type ?? "endmill";
  const flutes = Math.max(1, Math.min(8, Math.round(tl?.flutes || 2)));
  const byCount = Math.min(0.74, 0.445 + 0.056 * flutes);
  const helix = (deg: number) => Math.tan(deg * Math.PI / 180) / Math.max(0.05, R);
  const straight = { flutes, rate: 0, split: Infinity };
  switch (type) {
    case "drill": return { flutes: Math.max(2, flutes), core: 0.34, rate: helix(28), split: Infinity };
    case "spotdrill": return { ...straight, flutes: Math.max(2, flutes), core: 0.42 };
    case "vbit": case "chamfer": case "countersink": return { ...straight, core: 0.55 };
    case "reamer": return { ...straight, core: 0.84 };
    case "facemill": return { ...straight, core: 0.82 };
    case "threadmill": return { ...straight, core: 0.62 };
  }
  const h = tl?.helix ?? "up";
  if (h === "straight") return { ...straight, core: byCount };
  const rate = helix(30);
  if (h === "compression") return { flutes, core: byCount, rate, split: fluteLen * 0.35 };
  return { flutes, core: byCount, rate: h === "down" ? -rate : rate, split: Infinity };
}

/** Schneidenteil: Umriss von der Spitze (z = 0) bis oben an die Schneiden; oben laufen die Nuten aus */
export function cutterMesh(out: number[], outline: Pt[], look: CutterLook, col: RGB, alpha: number) {
  const top = outline[outline.length - 1][1];
  const R = outline.reduce((m, p) => Math.max(m, p[0]), 0.05);
  const fade = Math.max(0.2, Math.min(R * 1.2, top * 0.3));
  const twist = (z: number) => z <= look.split ? look.rate * z : look.rate * (2 * look.split - z);
  const period = (Math.PI * 2) / look.flutes;
  const factor = (th: number, z: number) => {
    const x = Math.max(0, Math.min(1, (top - z) / fade)), open = x * x * (3 - 2 * x);
    return open <= 0 ? 1 : 1 - (1 - fluteSection((th - twist(z)) / period, look.core)) * open;
  };
  // Umriss so fein teilen, dass sich die Nut von Schritt zu Schritt höchstens ~11° weiterdreht
  const pts: Pt[] = [outline[0]];
  for (let k = 1; k < outline.length; k++) {
    const [r0, z0] = outline[k - 1], [r1, z1] = outline[k], dz = Math.abs(z1 - z0);
    const n = Math.max(1, Math.min(120, Math.ceil(Math.max(Math.abs(look.rate) * dz / 0.2, dz * 4 / fade))));
    for (let i = 1; i <= n; i++) pts.push([r0 + (r1 - r0) * i / n, z0 + (z1 - z0) * i / n]);
  }
  const seg = look.flutes <= 2 ? 48 : Math.min(96, look.flutes * 20);
  sweep(out, pts, { seg, col, alpha, factor });
}

/** Maße, die millToolMesh braucht (gleiche Felder wie ToolHolder in simCarve.ts) */
export interface HolderDims { R: number; shankR: number; fluteLen: number; stickout: number; holderR: number; holderH: number; spindleR: number; spindleH: number }

/** Fräser + Schaft (undurchsichtig) und Spannmutter + Spindelnase (halb durchsichtig), Spitze bei 0 */
export function millToolMesh(tl: ToolGeom | null, hd: HolderDims, outline: Pt[]): { solid: Float32Array; ghost: Float32Array } {
  const solid: number[] = [], ghost: number[] = [];
  const col = COATING_RGB[tl?.coating ?? "none"] ?? COATING_RGB.none;
  cutterMesh(solid, outline, cutterLook(tl, hd.R, hd.fluteLen), col, METAL + 1);
  // Übergang zum Schaft: schräg statt als Stufe, soweit Platz bis zur Spannzange ist
  const fl = hd.fluteLen, zt = hd.stickout, zs = zt + hd.holderH;
  const neck = Math.max(0, Math.min(Math.abs(hd.R - hd.shankR), zt - fl - 0.5));
  // die Beschichtung sitzt nur auf den Schneiden – der Schaft bleibt blank
  sweep(solid, [[hd.R, fl], [hd.shankR, fl + neck], [hd.shankR, zt + 1]], { seg: 48, col: STEEL, alpha: METAL + 1 });
  // Spannmutter (ER-Form: unten angefast, oben Bund) und Spindelnase
  const h = hd.holderR, bevel = Math.min(h * 0.3, hd.holderH * 0.4);
  sweep(ghost, [[hd.shankR, zt], [h * 0.7, zt], [h, zt + bevel], [h, zs - 1.5], [h * 0.9, zs]], { seg: 48, col: NUT, alpha: METAL + 0.55 });
  const s = hd.spindleR, nose = Math.min(h * 1.08, s);
  sweep(ghost, [[h * 0.9, zs], [nose, zs], [nose, zs + 6], [s, zs + 10], [s, zs + hd.spindleH], [0, zs + hd.spindleH]], { seg: 48, col: SPINDLE, alpha: METAL + 0.4 });
  return { solid: new Float32Array(solid), ghost: new Float32Array(ghost) };
}
