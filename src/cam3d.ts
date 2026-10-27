/**
 * 3D-FRÄSEN (Relief, Schale, Freiform aus einem STL-Modell) – Teil im Frontend
 *
 * Gerechnet wird im App-Kern (src-tauri/src/cam3d.rs): Drop-Cutter, Schrupp-Schichten, Schlicht-Zeilen.
 * Hier: Modell als Binär-STL hinüberschicken, Bahnen abholen und daraus G-Code machen – genau wie cam.ts:
 * G21/G90, sichere Höhe, je Werkzeug Drehzahl und Vorschub, zwischen Schruppen und Schlichten Werkzeugwechsel (M0).
 * Z 0 = Material-Oberkante = Oberkante des Modells.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t, ascii } from "./i18n/i18n";
import { spindleCode } from "./spindleDir";
import { DEFAULT_PLUNGE, MillingTool, toolNumber, cutDiameter } from "./toolLibrary";
import { toolChangeGcode } from "./toolChange";

const SAFE_Z = 5.0;     // wie cam.ts
const CLEAR = 1.0;      // so weit über dem Material im Eilgang anfahren, dann eintauchen

/** Bahn im Vorschub: kind 0 = Schruppen, 1 = Schlichten; top = höchstens bis hier steht noch Material */
export interface Path3D { kind: number; layer: number; top: number; pts: Float32Array }

export interface Op3D {
  tool: MillingTool;
  stepDown: number;
  stepOver: number;
  allowance: number;
  dir: "x" | "y" | "xy";
  tolerance: number;
}

export interface Job3D {
  /** linke untere Ecke auf dem Bett, Größe und Modellhöhe in mm */
  place: { x0: number; y0: number; sizeX: number; sizeY: number; height: number };
  margin: boolean;
  rough: Op3D | null;
  finish: Op3D | null;
  name: string;
}

/** Dreiecke (9 Werte je Dreieck) als Binär-STL */
export function meshToStl(pos: Float32Array): Uint8Array {
  const n = Math.floor(pos.length / 9);
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12; // Normale bleibt 0 – wird drüben neu berechnet
    for (let k = 0; k < 9; k++) dv.setFloat32(o + k * 4, pos[i * 9 + k], true);
  }
  return new Uint8Array(buf);
}

/** Modell an den App-Kern geben; Antwort: Anzahl Dreiecke */
export async function loadModel3d(pos: Float32Array): Promise<number> {
  return invoke<number>("cam3d_load", meshToStl(pos));
}

/** Bahnen rechnen. onProgress(0…1, "rough" | "finish") */
export async function computePaths3d(job: Job3D, onProgress: (f: number, stage: string) => void): Promise<Path3D[]> {
  const op = (o: Op3D | null) => o && {
    ball: o.tool.type === "ball", diameter: cutDiameter(o.tool), stepDown: o.stepDown, stepOver: o.stepOver,
    allowance: o.allowance, dir: o.dir, tolerance: o.tolerance
  };
  const un = await listen<{ p: number; stage: string }>("cam3d-progress", e => onProgress(e.payload.p, e.payload.stage));
  try {
    const buf = await invoke<ArrayBuffer>("cam3d_compute", {
      job: { place: job.place, margin: job.margin, rough: op(job.rough), finish: op(job.finish) }
    });
    return decodePaths3d(buf);
  } finally { un(); }
}

export function cancelPaths3d() { invoke("cam3d_cancel").catch(() => { /* egal */ }); }

/** Aufbau siehe cam3d.rs → encode: u32 Anzahl, je Bahn u32 kind, u32 layer, f32 top, u32 n, n × xyz (f32) */
export function decodePaths3d(buf: ArrayBuffer): Path3D[] {
  const dv = new DataView(buf);
  const out: Path3D[] = [];
  let o = 4;
  const count = dv.getUint32(0, true);
  for (let i = 0; i < count; i++) {
    const kind = dv.getUint32(o, true), layer = dv.getUint32(o + 4, true), top = dv.getFloat32(o + 8, true), n = dv.getUint32(o + 12, true);
    o += 16;
    const pts = new Float32Array(n * 3);
    for (let k = 0; k < n * 3; k++) pts[k] = dv.getFloat32(o + k * 4, true);
    o += n * 12;
    out.push({ kind, layer, top, pts });
  }
  return out;
}

const pathLen = (p: Path3D) => {
  let L = 0;
  for (let i = 3; i < p.pts.length; i += 3) L += Math.hypot(p.pts[i] - p.pts[i - 3], p.pts[i + 1] - p.pts[i - 2], p.pts[i + 2] - p.pts[i - 1]);
  return L;
};

/** Länge (m) je Art und grobe Laufzeit (min) */
export function stats3d(paths: Path3D[], job: Job3D): { rough: number; finish: number; minutes: number } {
  let r = 0, f = 0;
  for (const p of paths) { if (p.kind === 0) r += pathLen(p); else f += pathLen(p); }
  const feed = (o: Op3D | null) => Math.max(10, o?.tool.feedrate || 600);
  // + etwa 3 s je Bahn für Hochfahren, Anfahren, Eintauchen
  const minutes = r / feed(job.rough) + f / feed(job.finish) + paths.length * 0.05;
  return { rough: r / 1000, finish: f / 1000, minutes };
}

/** G-Code für Schruppen + Schlichten */
export function gcode3d(paths: Path3D[], job: Job3D): string {
  const c = (key: string, p?: Record<string, string | number>) => `(${ascii(t(key, p))})`;
  const f3 = (v: number) => v.toFixed(3);
  const ops = ([[job.rough, 0], [job.finish, 1]] as [Op3D | null, number][])
    .filter(([o, k]) => o && paths.some(p => p.kind === k)) as [Op3D, number][];
  let g = `${c("c3d.gcHead", { name: job.name })}\n`;
  g += `G21 ${c("gc.unitMm")}\n`;
  g += `G90 ${c("gc.absolute")}\n`;
  g += `G0 Z${SAFE_Z.toFixed(2)} ${c("gc.safeZ")}\n`;
  if (ops.length > 1) {
    g += `${c("gc.toolList", { n: ops.length })}\n`;
    ops.forEach(([o], i) => { g += `${c("gc.toolListItem", { i: i + 1, name: o.tool.name, d: o.tool.diameter.toFixed(1) })}\n`; });
  }
  // nur geänderte Achsen schreiben (kürzerer G-Code)
  let lx = NaN, ly = NaN, lz = NaN;
  const move = (cmd: "G0" | "G1", x: number | null, y: number | null, z: number | null, extra = "") => {
    let s = cmd;
    if (x !== null && f3(x) !== f3(lx)) { s += ` X${f3(x)}`; lx = x; }
    if (y !== null && f3(y) !== f3(ly)) { s += ` Y${f3(y)}`; ly = y; }
    if (z !== null && f3(z) !== f3(lz)) { s += ` Z${f3(z)}`; lz = z; }
    if (s !== cmd || extra) g += s + extra + "\n";
  };
  ops.forEach(([o, kind], gi) => {
    const tl = o.tool;
    const feed = Math.max(10, Math.round(tl.feedrate || 600));
    const plunge = Math.max(10, Math.round(tl.plungeFeed || DEFAULT_PLUNGE));
    const rpm = Math.round(tl.rpm || 10000);
    if (gi > 0) {
      g += `\nG0 Z${SAFE_Z.toFixed(2)}\n`; lz = SAFE_Z;
      g += `M5 ${c("gc.spindleOff")}\n`;
      g += `${toolChangeGcode(toolNumber(tl), c("gc.toolChange", { i: gi + 1, name: tl.name, d: tl.diameter.toFixed(1) }))}\n`;
    }
    g += `\n${c("gc.tool", { name: tl.name, d: tl.diameter.toFixed(1) })}\n`;
    g += `${spindleCode("M3")} S${rpm} ${c("gc.spindleOn", { rpm })}\n`;
    if (gi > 0) g += `G4 P2 ${c("gc.spinUp")}\n`;
    g += `F${feed} ${c("gc.feed", { f: feed })}\n`;
    g += kind === 0 ? `${c("c3d.gcRough", { a: o.allowance, z: o.stepDown })}\n` : `${c("c3d.gcFinish")}\n`;
    lz = SAFE_Z;
    let layer = -1;
    for (const p of paths) {
      if (p.kind !== kind || p.pts.length < 3) continue;
      const P = p.pts, n = P.length / 3;
      if (kind === 0 && p.layer !== layer) { layer = p.layer; g += `${c("c3d.gcLayer", { z: P[2].toFixed(2) })}\n`; }
      // hoch, hinfahren, bis knapp über das Material, eintauchen
      move("G0", null, null, SAFE_Z);
      move("G0", P[0], P[1], null);
      const approach = Math.min(SAFE_Z, p.top + CLEAR);
      if (approach < SAFE_Z - 1e-6) move("G0", null, null, approach);
      const ramp = kind === 0 && (tl.rampAngle ?? 0) > 0 && approach - P[2] > 0.2;
      if (ramp) rampIn(P, approach, Math.min(45, tl.rampAngle!), Math.max(1, tl.diameter), plunge, move);
      else move("G1", null, null, P[2], ` F${plunge}`);
      let first = true;
      for (let i = 1; i < n; i++) {
        move("G1", P[i * 3], P[i * 3 + 1], P[i * 3 + 2], first ? ` F${feed}` : "");
        first = false;
      }
    }
    move("G0", null, null, SAFE_Z);
  });
  g += `\nG0 Z${SAFE_Z.toFixed(2)}\nM5 ${c("gc.spindleOff")}\nG0 X0 Y0 ${c("gc.park")}\nM30 ${c("gc.end")}\n`;
  return g;
}

/**
 * Rampe: auf dem ersten Stück der Bahn (bis 3 × Ø) hin und her, dabei schräg nach unten – endet genau am Startpunkt
 * auf Tiefe. Das Stück liegt in der Fläche, die in dieser Schicht ohnehin ausgeräumt wird.
 */
function rampIn(P: Float32Array, zTop: number, angle: number, dia: number, plunge: number,
  move: (cmd: "G0" | "G1", x: number | null, y: number | null, z: number | null, extra?: string) => void) {
  const z0 = P[2], n = P.length / 3;
  const stretch: [number, number][] = [[P[0], P[1]]];
  let L = 0;
  for (let i = 1; i < n && L < 3 * dia; i++) {
    const d = Math.hypot(P[i * 3] - stretch[stretch.length - 1][0], P[i * 3 + 1] - stretch[stretch.length - 1][1]);
    if (d < 1e-6) continue;
    L += d; stretch.push([P[i * 3], P[i * 3 + 1]]);
  }
  if (L < 0.5) { move("G1", null, null, z0, ` F${plunge}`); return; }
  const drop = zTop - z0;
  const trips = Math.max(1, Math.ceil(drop / Math.tan(angle * Math.PI / 180) / (2 * L)));
  const slope = drop / (2 * L * trips);
  let travelled = 0, first = true;
  const back = [...stretch].reverse();
  for (let k = 0; k < trips; k++) for (const seq of [stretch, back]) for (let i = 1; i < seq.length; i++) {
    travelled += Math.hypot(seq[i][0] - seq[i - 1][0], seq[i][1] - seq[i - 1][1]);
    move("G1", seq[i][0], seq[i][1], Math.max(z0, zTop - slope * travelled), first ? ` F${plunge}` : "");
    first = false;
  }
  move("G1", null, null, z0);
}
