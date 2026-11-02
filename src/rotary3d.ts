/**
 * DREHACHSE + 3D-MODELL (STL): Rundum-Fräsen und Fräsen von mehreren Seiten – Bahnen und Hilfen (ohne Tauri → testbar)
 *
 * Das Modell liegt mit seiner Längsachse auf der Drehachse (X), Mitte des Querschnitts auf y = z = 0.
 * Rohteil: runder Stab mit Radius R. Z 0 = Oberkante des Stabs (R über der Achse), Y 0 = über der Achsmitte.
 *
 * RUNDUM (4. Achse gleichzeitig): Der App-Kern (cam3d.rs → rotary_field) liefert für jeden Winkel und jede X-Stelle,
 * wie weit die Fräserspitze von der Achse weg bleiben muss. Daraus entstehen hier Bahnen auf der abgewickelten
 * Fläche: X = entlang der Achse, Y = Winkel × R (mm rundherum auf dem Rohteil), Z = Spitzenradius − R.
 * Die Umrechnung Y → A und der Vorschub passieren danach wie bei allem anderen in rotaryWrap.ts.
 *   - Schruppen: Schichten (Radius R − Zustellung …), je Schicht Zeilen entlang X im Zickzack, Fräser nie tiefer als
 *     die Schicht und nie tiefer als Modell + Aufmaß. Zeilen ganz in der Luft fallen weg.
 *   - Schlichten: Zeilen entlang der Achse (Zickzack) oder eine Spirale rundherum.
 * MEHRERE SEITEN (Indexing): Modell je Seite gedreht, dann wie normales 3D-Fräsen von oben (cam3d.rs);
 * zwischen den Seiten dreht A auf den nächsten Winkel. Ein Kern um die Achse bleibt stehen und hält das Teil.
 */
import type { Path3D } from "./cam3d";
import type { CarveResult } from "./view3d/carveSim";

/** Spitzenradius je Winkel (Zeile j) und X-Stelle (Spalte i): h[j * nx + i] */
export interface RField { x0: number; dx: number; nx: number; nt: number; h: Float32Array }

/** Modell drehen: gewählte Modell-Achse → X (Länge), Querschnitt mittig auf die Achse, gleichmäßig skaliert */
export function meshForRotary(pos: Float32Array, axis: 0 | 1 | 2, length: number): { tris: Float32Array; maxR: number; scale: number } {
  // zyklisch tauschen, damit das Modell nicht gespiegelt wird
  const ord = axis === 0 ? [0, 1, 2] : axis === 1 ? [1, 2, 0] : [2, 0, 1];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) {
    const v = pos[i + ord[a]];
    if (v < lo[a]) lo[a] = v;
    if (v > hi[a]) hi[a] = v;
  }
  const k = length / Math.max(1e-9, hi[0] - lo[0]);
  const cy = (lo[1] + hi[1]) / 2, cz = (lo[2] + hi[2]) / 2;
  const out = new Float32Array(pos.length);
  let maxR = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const x = (pos[i + ord[0]] - lo[0]) * k, y = (pos[i + ord[1]] - cy) * k, z = (pos[i + ord[2]] - cz) * k;
    out[i] = x; out[i + 1] = y; out[i + 2] = z;
    maxR = Math.max(maxR, Math.hypot(y, z));
  }
  return { tris: out, maxR, scale: k };
}

/** Modell um +X drehen (wie die Maschine bei A = deg): (y, z) → (y cos − z sin, y sin + z cos) */
export function rotateX(pos: Float32Array, deg: number): Float32Array {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    out[i] = pos[i];
    out[i + 1] = pos[i + 1] * c - pos[i + 2] * s;
    out[i + 2] = pos[i + 1] * s + pos[i + 2] * c;
  }
  return out;
}

/** Schichten von R nach innen bis zum Boden */
function radii(R: number, step: number, bottom: number): number[] {
  const out: number[] = [];
  const st = Math.max(0.05, step);
  for (let r = R - st; r > bottom + 1e-6; r -= st) out.push(r);
  if (bottom < R - 1e-6) out.push(bottom);
  return out;
}

/** Punkte auf fast geraden Stücken weglassen (Abweichung höchstens tol) */
export function thin3(pts: number[][], tol: number): number[][] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  let a = 0;
  const dist = (p: number[], s: number[], e: number[]) => {
    const d = [e[0] - s[0], e[1] - s[1], e[2] - s[2]], w = [p[0] - s[0], p[1] - s[1], p[2] - s[2]];
    const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const u = l2 > 1e-18 ? Math.max(0, Math.min(1, (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / l2)) : 0;
    return Math.hypot(w[0] - u * d[0], w[1] - u * d[1], w[2] - u * d[2]);
  };
  for (let e = 2; e < pts.length; e++) {
    let ok = e - a <= 400;
    for (let m = a + 1; ok && m < e; m++) if (dist(pts[m], pts[a], pts[e]) > tol) ok = false;
    if (!ok) { out.push(pts[e - 1]); a = e - 1; }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const toPath = (kind: number, layer: number, top: number, pts: number[][], tol: number): Path3D => {
  const t = thin3(pts, tol);
  const P = new Float32Array(t.length * 3);
  t.forEach((p, i) => { P[i * 3] = p[0]; P[i * 3 + 1] = p[1]; P[i * 3 + 2] = p[2]; });
  return { kind, layer, top, pts: P };
};

/** SCHRUPPEN rundum: Schichten, je Schicht zusammenhängende Zeilen-Gruppen im Zickzack */
export function roughRotary(f: RField, R: number, stepDown: number, core: number, tol = 0.01): Path3D[] {
  const ds = (2 * Math.PI * R) / f.nt;
  let lowest = Infinity;
  for (const v of f.h) lowest = Math.min(lowest, v);
  const zs = radii(R, stepDown, Math.max(core, lowest));
  const out: Path3D[] = [];
  zs.forEach((rho, k) => {
    const prev = k === 0 ? R : zs[k - 1];
    const tip = (j: number, i: number) => Math.min(R, Math.max(rho, f.h[j * f.nx + i]));
    const cuts: boolean[] = [];
    for (let j = 0; j < f.nt; j++) {
      let c = false;
      for (let i = 0; i < f.nx && !c; i++) if (tip(j, i) < prev - 1e-3) c = true;
      cuts.push(c);
    }
    if (!cuts.some(Boolean)) return;
    // Gruppen hintereinander liegender Zeilen (rundherum: über die Naht hinweg)
    const starts: number[] = [];
    if (cuts.every(Boolean)) starts.push(0);
    else for (let j = 0; j < f.nt; j++) if (cuts[j] && !cuts[(j + f.nt - 1) % f.nt]) starts.push(j);
    for (const s of starts) {
      const pts: number[][] = [];
      for (let m = 0; m < f.nt && cuts[(s + m) % f.nt]; m++) {
        const j = (s + m) % f.nt, y = (s + m) * ds;
        for (let q = 0; q < f.nx; q++) {
          const i = m % 2 === 0 ? q : f.nx - 1 - q;
          pts.push([f.x0 + i * f.dx, y, tip(j, i) - R]);
        }
      }
      out.push(toPath(0, k, prev - R, pts, tol));
    }
  });
  return out;
}

/**
 * SCHLICHTEN rundum. dir "x": Zeilen entlang der Achse (jede Feldzeile eine Bahn-Zeile), "around": Spirale –
 * je Umdrehung um stepOver weiter in X. levels: ohne Schruppen in Zustellungen von außen nach innen.
 */
export function finishRotary(f: RField, R: number, dir: "x" | "around", stepOver: number, tol: number, levelStep = 0): Path3D[] {
  const ds = (2 * Math.PI * R) / f.nt;
  const pts: number[][] = [];
  if (dir === "x") {
    for (let j = 0; j < f.nt; j++) for (let q = 0; q < f.nx; q++) {
      const i = j % 2 === 0 ? q : f.nx - 1 - q;
      pts.push([f.x0 + i * f.dx, j * ds, f.h[j * f.nx + i] - R]);
    }
  } else {
    const x1 = f.x0 + (f.nx - 1) * f.dx;
    const per = Math.max(0.01, stepOver);
    const total = Math.ceil(((x1 - f.x0) / per) * f.nt);
    for (let u = 0; u <= total; u++) {
      const x = Math.min(x1, f.x0 + (u / f.nt) * per), j = u % f.nt;
      const fi = (x - f.x0) / f.dx, i0 = Math.min(f.nx - 1, Math.floor(fi)), i1 = Math.min(f.nx - 1, i0 + 1), w = fi - i0;
      // zwischen zwei Feldpunkten: der höhere Wert (nie tiefer als erlaubt)
      const h = w < 1e-6 ? f.h[j * f.nx + i0] : Math.max(f.h[j * f.nx + i0], f.h[j * f.nx + i1]);
      pts.push([x, u * ds, h - R]);
    }
  }
  if (!(levelStep > 0)) return [toPath(1, 0, 0, pts, tol)];
  let lowest = Infinity;
  for (const p of pts) lowest = Math.min(lowest, p[2]);
  const lv = radii(R, levelStep, lowest + R);
  // letzte Stufe = die fertige Fläche
  return lv.map((rho, k) => toPath(1, k, 0, pts.map(p => [p[0], p[1], k === lv.length - 1 ? p[2] : Math.max(p[2], rho - R)]), tol));
}

/**
 * Bahnen rundherum aneinanderhängen: jede Bahn um ganze Umfänge verschieben, so dass sie dort beginnt, wo die
 * Drehachse gerade steht (sonst dreht A zwischen zwei Bahnen viele Umdrehungen zurück).
 */
export function chainRotary(paths: Path3D[], R: number): void {
  const C = 2 * Math.PI * R;
  let cur = 0;
  for (const p of paths) {
    if (p.pts.length < 3) continue;
    const m = Math.round((cur - p.pts[1]) / C);
    if (m) for (let i = 1; i < p.pts.length; i += 3) p.pts[i] += m * C;
    cur = p.pts[p.pts.length - 2];
  }
}

/** Vorschau: Höhenraster (abgewickelt, Zellen quadratisch) für view3d/scenes.ts → cylinderCarveScene */
export function fieldPreview(f: RField, R: number): CarveResult {
  const cell = f.dx, C = 2 * Math.PI * R;
  const ny = Math.max(8, Math.round(C / cell));
  const h = new Float32Array(f.nx * ny);
  let minZ = 0;
  for (let j = 0; j < ny; j++) {
    const t = ((j + 0.5) / ny) * f.nt, j0 = Math.floor(t) % f.nt, j1 = (j0 + 1) % f.nt, w = t - Math.floor(t);
    for (let i = 0; i < f.nx; i++) {
      const v = Math.min(0, f.h[j0 * f.nx + i] * (1 - w) + f.h[j1 * f.nx + i] * w - R);
      h[j * f.nx + i] = v;
      minZ = Math.min(minZ, v);
    }
  }
  return { nx: f.nx, ny, x0: f.x0 - cell / 2, y0: 0, cell, h, minZ, moves: 0 };
}
