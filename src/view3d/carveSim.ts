/**
 * FRÄSERGEBNIS AUS DEM G-CODE (Materialabtrag für die 3D-Ansicht)
 *
 * Das Material ist ein Höhenraster: jede Zelle merkt sich, wie hoch dort noch Material steht (Oberkante Z = 0).
 * Jede Bewegung des G-Codes (Simulations-Leser, Bögen schon in Geraden zerlegt) drückt die Fräserform hinein:
 * an jedem Punkt der Bahn sinkt jede Zelle unter dem Fräser auf die Höhe der Schneide dort.
 *   Schaftfräser/Planfräser: flach · Kugelfräser: Halbkugel · Radiusfräser: flach mit runder Ecke ·
 *   V-Fräser, Fase, Senker, Bohrer: Kegel (mit Spitzen-Durchmesser)
 * Welcher Fräser gerade arbeitet, ergibt sich aus den Werkzeugwechseln (M0/M1/M6) im G-Code.
 * Nur Anzeige – rechnet in Stücken, damit die Oberfläche flüssig bleibt.
 */
import { parseGcodeProgram } from "../sim/gcodeParser.ts";
import type { ToolGeom } from "../toolGraphics.ts";

export interface CarveResult {
  nx: number; ny: number;      // Zellen
  x0: number; y0: number;      // linke untere Ecke (mm)
  cell: number;                // Zellgröße (mm)
  h: Float32Array;             // Höhe je Zelle (≤ 0), h[j * nx + i]
  minZ: number;                // tiefste gefräste Stelle
  moves: number;               // Schnittbewegungen
}

const MAX_CELLS = 5_000_000;

export interface Kernel { di: Int32Array; dj: Int32Array; dz: Float32Array; dist: Float32Array; R: number }

/** Höhe der Schneide über der Spitze im Abstand r von der Mitte (Infinity = außerhalb) */
export function profile(tool: ToolGeom | null): (r: number) => number {
  const R = Math.max(0.05, (tool?.diameter ?? 3) / 2);
  const type = tool?.type ?? "endmill";
  if (type === "ball") return r => (r > R ? Infinity : R - Math.sqrt(Math.max(0, R * R - r * r)));
  if (type === "bullnose") {
    const cr = Math.min(R, Math.max(0, tool?.cornerR ?? 0)), flat = R - cr;
    return r => (r > R ? Infinity : r <= flat ? 0 : cr - Math.sqrt(Math.max(0, cr * cr - (r - flat) ** 2)));
  }
  if (type === "vbit" || type === "chamfer" || type === "countersink" || type === "drill") {
    const half = ((tool?.angle || (type === "drill" ? 118 : 90)) * Math.PI) / 360;
    const tr = Math.min(R, Math.max(0, (tool?.tipDia ?? 0) / 2)), k = 1 / Math.tan(Math.max(0.05, half));
    return r => (r > R ? Infinity : r <= tr ? 0 : (r - tr) * k);
  }
  return r => (r > R ? Infinity : 0);
}

export function kernel(tool: ToolGeom | null, c: number): Kernel {
  const R = Math.max(0.05, (tool?.diameter ?? 3) / 2);
  const f = profile(tool);
  const n = Math.ceil(R / c);
  const list: [number, number, number, number][] = [];
  for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
    const d = Math.hypot(i, j) * c;
    if (d <= R + c * 0.5) { const z = f(Math.min(d, R)); list.push([i, j, z, d]); }
  }
  list.sort((a, b) => a[3] - b[3]);
  return {
    di: Int32Array.from(list.map(q => q[0])), dj: Int32Array.from(list.map(q => q[1])),
    dz: Float32Array.from(list.map(q => q[2])), dist: Float32Array.from(list.map(q => q[3])), R
  };
}

/**
 * Zellen um den Fräser für den genauen Abdruck: etwas größer als der Fräser, weil seine Mitte nicht auf einer
 * Zellmitte liegen muss. Die Höhe kommt dann aus dem echten Abstand (profile), nicht aus dieser Liste.
 */
export function exactKernel(tool: ToolGeom | null, c: number): Kernel {
  const k = kernel({ ...(tool ?? {}), type: "endmill", diameter: (tool?.diameter ?? 3) + 2 * c } as ToolGeom, c);
  return { ...k, R: Math.max(0.05, (tool?.diameter ?? 3) / 2) };
}

/**
 * @param tools      Fräser je Abschnitt (Abschnitt = zwischen zwei Werkzeugwechseln); fehlt einer: 3-mm-Schaftfräser
 * @param onProgress 0…1; gibt false zurück = abbrechen
 */
export async function carve(lines: string[], tools: (ToolGeom | null)[], onProgress: (f: number) => boolean): Promise<CarveResult | null> {
  const prog = parseGcodeProgram(lines);
  // Abschnitt (Werkzeug) je Zeile
  const sect = new Int32Array(lines.length + 1);
  let k = 0;
  lines.forEach((l, i) => {
    sect[i] = k;
    if (/^\s*M0?[016]\b/i.test(l.replace(/\([^)]*\)/g, ""))) k++;
  });
  const toolOf = (line: number) => tools[Math.min(tools.length - 1, sect[line] ?? 0)] ?? null;
  const radius = (tl: ToolGeom | null) => Math.max(0.05, (tl?.diameter ?? 3) / 2);

  // Bereich: alle Bewegungen unter Z = 0 plus Fräserradius und Rand
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cuts = 0;
  for (let m = 0; m < prog.n; m++) {
    if (Math.min(prog.z0[m], prog.z1[m]) >= 0) continue;
    const R = radius(toolOf(prog.line[m]));
    x0 = Math.min(x0, prog.x0[m] - R, prog.x1[m] - R); x1 = Math.max(x1, prog.x0[m] + R, prog.x1[m] + R);
    y0 = Math.min(y0, prog.y0[m] - R, prog.y1[m] - R); y1 = Math.max(y1, prog.y0[m] + R, prog.y1[m] + R);
    cuts++;
  }
  if (!cuts) return null;
  const margin = Math.max(4, 0.06 * Math.max(x1 - x0, y1 - y0));
  x0 -= margin; y0 -= margin; x1 += margin; y1 += margin;
  // Kleine Teile: nicht feiner als nötig (feiner = viel länger rechnen, sieht man aber nicht). Feine Fräser dürfen feiner.
  const rMin = Math.min(...(tools.length ? tools : [null]).map(radius));
  const c = Math.max(Math.min(0.06, Math.max(0.03, rMin / 4)), Math.sqrt(((x1 - x0) * (y1 - y0)) / MAX_CELLS));
  const nx = Math.max(2, Math.ceil((x1 - x0) / c)), ny = Math.max(2, Math.ceil((y1 - y0) / c));
  const h = new Float32Array(nx * ny); // 0 = Oberkante
  const kernels = new Map<ToolGeom | null, Kernel>();
  const kern = (tl: ToolGeom | null) => { let q = kernels.get(tl); if (!q) { q = exactKernel(tl, c); kernels.set(tl, q); } return q; };

  // Fräser an Punkt (x, y) mit Spitze auf z. Abstand von der echten Mitte zur Zellmitte – nicht aufs Raster gerundet,
  // sonst werden runde Taschen und schräge Kanten eckig
  const stamp = (K: Kernel, f: (r: number) => number, x: number, y: number, z: number, reach: number) => {
    const ci = Math.floor((x - x0) / c), cj = Math.floor((y - y0) / c);
    const fx = (x - x0) / c - ci - 0.5, fy = (y - y0) / c - cj - 0.5;
    const { di, dj, dist } = K;
    const limit = reach + c;
    for (let q = 0; q < di.length; q++) {
      if (dist[q] > limit) break;
      const i = ci + di[q], j = cj + dj[q];
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const ex = di[q] - fx, ey = dj[q] - fy, d = Math.sqrt(ex * ex + ey * ey) * c;
      if (d > reach) continue;
      const v = z + f(d), id = j * nx + i;
      if (v < h[id]) h[id] = v;
    }
  };

  let minZ = 0, done = 0, budget = 0;
  for (let m = 0; m < prog.n; m++) {
    const za = prog.z0[m], zb = prog.z1[m];
    if (Math.min(za, zb) >= 0) continue;
    const tl = toolOf(prog.line[m]);
    const K = kern(tl), f = profile(tl);
    // so weit reicht der Fräser bis zur Oberkante (V-Fräser in geringer Tiefe nur ein kleiner Kreis)
    const zmin = Math.min(za, zb);
    let reach = K.R;
    if (f(K.R) > -zmin) { let lo = 0, hi = K.R; for (let it = 0; it < 20; it++) { const mid = (lo + hi) / 2; if (f(mid) <= -zmin) lo = mid; else hi = mid; } reach = lo + c; }
    // Abstand der Punkte: höchstens ein Viertel des wirksamen Radius, mindestens eine Zelle
    const len = Math.hypot(prog.x1[m] - prog.x0[m], prog.y1[m] - prog.y0[m], zb - za);
    const step = Math.max(c * 0.7, Math.min(reach / 4, c * 3));
    const n = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s <= n; s++) {
      const u = s / n, z = za + (zb - za) * u;
      if (z >= 0) continue;
      stamp(K, f, prog.x0[m] + (prog.x1[m] - prog.x0[m]) * u, prog.y0[m] + (prog.y1[m] - prog.y0[m]) * u, z, reach);
    }
    minZ = Math.min(minZ, zmin);
    done++;
    budget += n * Math.min(K.di.length, Math.PI * (reach / c) ** 2);
    if (budget > 4_000_000) {
      budget = 0;
      if (!onProgress(done / cuts)) return null;
      await new Promise(r => setTimeout(r, 0));
    }
  }
  onProgress(1);
  return { nx, ny, x0, y0, cell: c, h, minZ, moves: cuts };
}
