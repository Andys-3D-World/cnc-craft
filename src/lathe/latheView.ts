/** DREHTEIL IN 3D: Material mit Abtrag, Futter, Meißel, Reitstock und Bahnen. Für die Simulation und das Dreh-Fenster. */
import { Viewer3D, type Mesh } from "../view3d/viewer3d";
import { chuckMeshes, LatheReplay, partMeshes, pathLines, tailMesh, toolMeshes, type Tri, type TurnMove, type TurnStock } from "./latheSim";
import type { LatheSettings } from "./latheJob";
import type { LatheTool } from "./turn";

export interface LatheScene { moves: TurnMove[]; stock: TurnStock; tail: { z: number; d: number } | null; side: -1 | 1; dir: 1 | -1; color: [number, number, number] }
const EMPTY: Tri = { data: new Float32Array(0), index: new Uint32Array(0) };
const DOT: Tri = { data: new Float32Array(24), index: new Uint32Array([0, 1, 2]) };
const IX = { raw: 0, done: 1, face: 2, chuck: 3, jaws: 4, insert: 5, holder: 6, tail: 7, feed: 8, rapid: 9 };

export class LatheView {
  private v: Viewer3D;
  private scene: LatheScene | null = null;
  replay: LatheReplay | null = null;
  private tool: LatheTool | null = null;
  private i = -1; private frac = 0; private angle = 0; private last = 0;
  cut = false; showPaths = true;
  constructor(canvas: HTMLCanvasElement) { this.v = new Viewer3D(canvas); }
  get ok() { return this.v.ok; }

  setScene(s: LatheScene | null, keepView = false) {
    this.scene = s; this.tool = null;
    if (!s) { this.replay = null; this.v.setMeshes([], true); return; }
    this.replay = new LatheReplay(s.moves, s.stock);
    const m = (t: Tri, color: [number, number, number], ghost = false): Mesh => ({ pos: [], nrm: [], data: t.data.length ? t.data : DOT.data, index: t.index.length ? t.index : DOT.index, color, ghost });
    const ch = chuckMeshes(-s.stock.stickOut, s.stock.R), p = pathLines(s.moves, s.side), line = (a: number[], color: [number, number, number]): Mesh => ({ pos: a.length ? a : [0, 0, 0, 0, 0, 0], nrm: new Array(Math.max(6, a.length)).fill(0), color, lines: true, ghost: true });
    const shade = (f: number): [number, number, number] => [s.color[0] * f, s.color[1] * f, s.color[2] * f];
    this.v.setMeshes([
      m(EMPTY, shade(0.62), true), m(EMPTY, s.color, true), m(EMPTY, [0.86, 0.42, 0.3], true),
      m(ch.body, [0.34, 0.35, 0.4]), m(ch.jaws, [0.5, 0.51, 0.56]), m(EMPTY, [1, 0.82, 0.24], true), m(EMPTY, [0.22, 0.24, 0.3], true),
      m(s.tail ? tailMesh(s.tail.z, s.tail.d) : EMPTY, [0.55, 0.57, 0.62], true),
      line(p.feed, [0.21, 0.7, 1]), line(p.rapid, [0.75, 0.47, 0.16]),
    ], true);
    const R = s.stock.R, xL = -s.stock.stickOut - 34, xR = s.stock.front + 30;
    this.v.frame([(xL + xR) / 2 + 6, 0, 0], Math.hypot((xR - xL) / 2, Math.max(30, R * 1.5)) * 0.9);
    if (!keepView) this.preset("iso");
    this.update(true);
  }
  setProgress(i: number, frac: number) { this.i = i; this.frac = frac; this.update(false); }
  /** alles neu zeichnen (z. B. Schnitt an/aus) */
  update(all: boolean) {
    const s = this.scene, r = this.replay;
    if (!s || !r) return;
    void all;
    r.setTarget(this.i < 0 ? r.moves.length : this.i, this.i < 0 ? 0 : this.frac);
    const p = partMeshes(r, s.stock.R, this.cut);
    this.v.replace(IX.raw, p.raw.data, p.raw.index); this.v.replace(IX.done, p.done.data, p.done.index); this.v.replace(IX.face, p.face.data, p.face.index);
    const m = this.i >= 0 ? r.moves[Math.min(this.i, r.moves.length - 1)] : undefined, t = m?.tool ?? null;
    if (t !== this.tool) {
      this.tool = t;
      const q = t ? toolMeshes(t, s.side) : { insert: EMPTY, holder: EMPTY };
      this.v.replace(IX.insert, q.insert.data, q.insert.index); this.v.replace(IX.holder, q.holder.data, q.holder.index);
    }
    if (m && t) {
      const off: [number, number, number] = [m.z0 + (m.z1 - m.z0) * this.frac, s.side * (m.r0 + (m.r1 - m.r0) * this.frac), 0];
      this.v.place(IX.insert, off); this.v.place(IX.holder, off);
    }
    const far: [number, number, number] = this.showPaths ? [0, 0, 0] : [1e7, 0, 0];
    this.v.place(IX.feed, far); this.v.place(IX.rapid, far);
  }
  /** Futter drehen (nur Anzeige, höchstens 1 Umdrehung je Sekunde) */
  turn(now: number, running: boolean) {
    if (running && this.last) { this.angle += (this.scene?.dir ?? 1) * Math.min(0.1, (now - this.last) / 1000) * 2 * Math.PI; this.v.place(IX.jaws, null, this.angle); }
    this.last = running ? now : 0;
  }
  preset(v: "iso" | "top" | "front") {
    this.v.reset();
    if (v === "iso") { this.v.yaw = -0.45; this.v.pitch = -1.05; }
    else if (v === "top") { this.v.yaw = 0; this.v.pitch = 0; }
    else { this.v.yaw = 0; this.v.pitch = -Math.PI / 2; }
  }
  destroy() { this.v.destroy(); }
}

const COLORS: Record<string, [number, number, number]> = { alu: [0.82, 0.84, 0.87], brass: [0.86, 0.72, 0.36], steel: [0.66, 0.69, 0.74], stainless: [0.76, 0.78, 0.8], plastic: [0.9, 0.9, 0.86] };
/** X-Wert im Programm je mm Radius */
export const xFactor = (s: LatheSettings) => (s.out.xMode === "dia" || s.out.xMode === "g7" ? 2 : 1) * s.out.xSign;
export function latheScene(s: LatheSettings, moves: TurnMove[]): LatheScene {
  const j = s.job;
  return { moves, stock: { R: j.stockD / 2, front: j.faceAllow, stickOut: j.stickOut }, tail: j.tailOn ? { z: j.tailZ, d: j.tailD } : null, side: s.post === "rear" ? 1 : -1, dir: s.out.dir === "M4" ? -1 : 1, color: COLORS[s.material] ?? COLORS.steel };
}
