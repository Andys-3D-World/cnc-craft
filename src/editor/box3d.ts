/**
 * BOX-GENERATOR – 3D-Ansicht: die fertige Kiste aus den Platten (Lage aus box.ts), drehbar mit der Maus.
 * Ohne 3D-Bibliothek (wie die 3D-Simulation): jede Platte wird zu Flächen (oben, unten, Kanten), die Flächen werden
 * von hinten nach vorne gemalt. „Auseinander“ schiebt die Platten von der Mitte weg – so sieht man die Zinken.
 */
import type { Panel, V3 } from "../box";

type Face = { pts: V3[][]; nrm: V3; edge: boolean };
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossV = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Flächen aller Platten; `explode` (0 … 1) schiebt jede Platte von der Kistenmitte weg */
function buildFaces(panels: Panel[], t: number, explode: number): { faces: Face[]; center: V3; radius: number } {
  // Mitte und Größe aus den nicht verschobenen Punkten
  const all: V3[] = [];
  const world = (p: Panel, x: number, y: number, s: number): V3 => {
    const a = p.at!;
    return [0, 1, 2].map(k => a.o[k] + a.u[k] * x + a.v[k] * y + a.n[k] * s) as V3;
  };
  for (const p of panels) {
    if (p.at) for (const q of p.pts) all.push(world(p, q.x, q.y, t / 2));
    if (p.wrap) for (const q of p.wrap.loop) all.push([q.x, q.y, p.wrap.z0], [q.x, q.y, p.wrap.z1]);
  }
  if (!all.length) return { faces: [], center: [0, 0, 0], radius: 1 };
  const lo = [0, 1, 2].map(k => Math.min(...all.map(v => v[k]))), hi = [0, 1, 2].map(k => Math.max(...all.map(v => v[k])));
  const center: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;

  const faces: Face[] = [];
  for (const p of panels) {
    if (p.wrap) {
      // gebogene Wand: nur die Fläche (ohne Biegeschnitte), Kante oben und unten
      const { loop, z0, z1 } = p.wrap;
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        faces.push({ pts: [[[a.x, a.y, z0], [b.x, b.y, z0], [b.x, b.y, z1], [a.x, a.y, z1]]], nrm: norm([b.y - a.y, a.x - b.x, 0]), edge: false });
      }
      continue;
    }
    if (!p.at) continue;
    // Verschiebung beim Auseinanderziehen: von der Kistenmitte zur Plattenmitte
    const cx = p.pts.reduce((s, q) => s + q.x, 0) / p.pts.length, cy = p.pts.reduce((s, q) => s + q.y, 0) / p.pts.length;
    const pc = world(p, cx, cy, t / 2), dir = sub(pc, center), dl = Math.hypot(...dir) || 1;
    const off: V3 = explode > 0 ? (dir.map(v => (v / dl) * explode * size * 0.6) as V3) : [0, 0, 0];
    const W = (x: number, y: number, s: number): V3 => { const v = world(p, x, y, s); return [v[0] + off[0], v[1] + off[1], v[2] + off[2]]; };
    const rings = [p.pts, ...(p.holes || [])];
    for (const s of [0, t]) faces.push({ pts: rings.map(r => r.map(q => W(q.x, q.y, s))), nrm: p.at.n, edge: false });
    // Kanten (Stirnseiten) jeder Kontur
    for (const r of rings) for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      const A0 = W(a.x, a.y, 0), B0 = W(b.x, b.y, 0), B1 = W(b.x, b.y, t), A1 = W(a.x, a.y, t);
      faces.push({ pts: [[A0, B0, B1, A1]], nrm: norm(crossV(sub(B0, A0), p.at.n)), edge: true });
    }
  }
  return { faces, center, radius: size * (1 + explode * 0.6) };
}

/** Ansicht in einem Canvas: setPanels(...) zeichnet neu, Maus ziehen = drehen, Rad = zoomen, Doppelklick = zurück */
export class Box3DView {
  private yaw = -0.6;
  private elev = 0.55;
  private zoom = 1;
  private faces: Face[] = [];
  private center: V3 = [0, 0, 0];
  private radius = 1;

  constructor(private canvas: HTMLCanvasElement) {
    let drag: { x: number; y: number } | null = null;
    canvas.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
    canvas.addEventListener("pointermove", e => {
      if (!drag) return;
      this.yaw -= (e.clientX - drag.x) * 0.01;
      this.elev = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.elev + (e.clientY - drag.y) * 0.01));
      drag = { x: e.clientX, y: e.clientY };
      this.draw();
    });
    const stop = () => { drag = null; };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      this.zoom = Math.max(0.3, Math.min(6, this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      this.draw();
    }, { passive: false });
    canvas.addEventListener("dblclick", () => { this.yaw = -0.6; this.elev = 0.55; this.zoom = 1; this.draw(); });
  }

  setPanels(panels: Panel[], t: number, explode: number) {
    const b = buildFaces(panels, t, explode);
    this.faces = b.faces; this.center = b.center; this.radius = b.radius || 1;
    this.draw();
  }

  draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, c.clientWidth), h = Math.max(10, c.clientHeight);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // Blick: erst um die Hochachse drehen (yaw), dann von schräg oben (elev) schauen
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), ce = Math.cos(this.elev), se = Math.sin(this.elev);
    const s = (Math.min(w, h) / (2.15 * this.radius)) * this.zoom, [mx, my, mz] = this.center;
    const view = (v: V3): V3 => {
      const x = v[0] - mx, y = v[1] - my, z = v[2] - mz;
      const xr = x * cy - y * sy, yr = x * sy + y * cy;
      return [xr, yr * se + z * ce, yr * ce - z * se]; // rechts, oben, Tiefe (größer = weiter weg)
    };
    const light = norm([-0.45, 0.75, -0.5]); // von links oben, etwas von vorne (Blick-Koordinaten)
    const list = this.faces.map(f => {
      const vp = f.pts.map(r => r.map(view));
      const n = view([f.nrm[0] + mx, f.nrm[1] + my, f.nrm[2] + mz]);
      let d = 0, k = 0;
      for (const r of vp) for (const q of r) { d += q[2]; k++; }
      return { f, vp, depth: d / k, shade: Math.abs(n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) };
    }).sort((a, b) => b.depth - a.depth);
    ctx.lineJoin = "round";
    for (const { f, vp, shade } of list) {
      ctx.beginPath();
      for (const r of vp) r.forEach((q, i) => { const X = w / 2 + q[0] * s, Y = h / 2 - q[1] * s; if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
      ctx.closePath();
      // Holz: Flächen hell, Stirnseiten (Kanten) dunkler wie gelaserte Schnittkanten
      const L = f.edge ? 22 + 22 * shade : 42 + 30 * shade;
      ctx.fillStyle = `hsl(30, ${f.edge ? 40 : 48}%, ${L}%)`;
      ctx.fill("evenodd");
      ctx.strokeStyle = f.edge ? ctx.fillStyle : "rgba(40, 22, 8, 0.55)";
      ctx.lineWidth = f.edge ? 0.6 : 0.8;
      ctx.stroke();
    }
  }
}
