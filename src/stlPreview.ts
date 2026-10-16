/**
 * VORSCHAU-BILDER für den STL-Dialog:
 *   - render3D():      schattiertes 3D-Modell, schräg von oben, dazu die rote Schnittebene
 *   - render2D():      die erzeugten 2D-Konturen mit Maßen
 */
import type { WeldedMesh, ViewCoords, SliceResult } from "./stlLoader";
import { t } from "./i18n/i18n";

const AZ = (-35 * Math.PI) / 180;  // Drehung um die Hochachse
const EL = (35 * Math.PI) / 180;   // Blick schräg von oben

interface Projected { sx: Float64Array; sy: Float64Array; depth: Float64Array; }

function project(vc: ViewCoords, cu: number, cv: number, cw: number): Projected {
  const n = vc.u.length;
  const sx = new Float64Array(n), sy = new Float64Array(n), depth = new Float64Array(n);
  const ca = Math.cos(AZ), sa = Math.sin(AZ), ce = Math.cos(EL), se = Math.sin(EL);
  for (let i = 0; i < n; i++) {
    const u = vc.u[i] - cu, v = vc.v[i] - cv, w = vc.w[i] - cw;
    const u1 = u * ca - v * sa;
    const v1 = u * sa + v * ca;
    sx[i] = u1;
    sy[i] = w * ce + v1 * se;      // nach oben auf dem Bildschirm
    depth[i] = -v1 * ce + w * se;  // größer = näher am Betrachter
  }
  return { sx, sy, depth };
}

/**
 * Zeichnet das Modell schattiert. "height" = aktuelle Schnitthöhe (rote Linien).
 * Das teure Grundbild wird zwischengespeichert, damit der Schieberegler flüssig bleibt.
 */
export class Mesh3DPreview {
  private base: HTMLCanvasElement | null = null;
  private fit = { scale: 1, cx: 0, cy: 0, cu: 0, cv: 0, cw: 0 };
  private canvas: HTMLCanvasElement;
  private mesh: WeldedMesh;
  private vc: ViewCoords | null = null;

  constructor(canvas: HTMLCanvasElement, mesh: WeldedMesh) {
    this.canvas = canvas;
    this.mesh = mesh;
  }

  setView(vc: ViewCoords) {
    this.vc = vc;
    const { canvas, mesh } = this;
    const W = canvas.width, H = canvas.height;

    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < vc.u.length; i++) {
      if (vc.u[i] < minU) minU = vc.u[i]; if (vc.u[i] > maxU) maxU = vc.u[i];
      if (vc.v[i] < minV) minV = vc.v[i]; if (vc.v[i] > maxV) maxV = vc.v[i];
    }
    const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2, cw = (vc.minW + vc.maxW) / 2;
    const pr = project(vc, cu, cv, cw);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pr.sx.length; i++) {
      if (pr.sx[i] < minX) minX = pr.sx[i]; if (pr.sx[i] > maxX) maxX = pr.sx[i];
      if (pr.sy[i] < minY) minY = pr.sy[i]; if (pr.sy[i] > maxY) maxY = pr.sy[i];
    }
    const scale = 0.85 * Math.min(W / Math.max(maxX - minX, 1e-6), H / Math.max(maxY - minY, 1e-6));
    this.fit = { scale, cx: W / 2 - ((minX + maxX) / 2) * scale, cy: H / 2 + ((minY + maxY) / 2) * scale, cu, cv, cw };

    // Dreiecke von hinten nach vorne sortieren (Maler-Verfahren)
    const T = mesh.triangleCount, tris = mesh.tris;
    const order = new Uint32Array(T);
    const tDepth = new Float64Array(T);
    for (let t = 0; t < T; t++) {
      order[t] = t;
      tDepth[t] = pr.depth[tris[t * 3]] + pr.depth[tris[t * 3 + 1]] + pr.depth[tris[t * 3 + 2]];
    }
    order.sort((a, b) => tDepth[a] - tDepth[b]);

    const base = document.createElement("canvas");
    base.width = W; base.height = H;
    const ctx = base.getContext("2d")!;
    ctx.fillStyle = "#121216";
    ctx.fillRect(0, 0, W, H);

    const X = (i: number) => this.fit.cx + pr.sx[i] * scale;
    const Y = (i: number) => this.fit.cy - pr.sy[i] * scale;
    const thin = T > 60000; // bei sehr großen Modellen keine Kantenlinien

    for (let k = 0; k < T; k++) {
      const t = order[k];
      const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
      // Licht: Normale im Bildschirm-Raum
      const ux = pr.sx[b] - pr.sx[a], uy = pr.sy[b] - pr.sy[a], uz = pr.depth[b] - pr.depth[a];
      const vx = pr.sx[c] - pr.sx[a], vy = pr.sy[c] - pr.sy[a], vz = pr.depth[c] - pr.depth[a];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const light = Math.abs(nx * 0.35 + ny * 0.6 + nz * 0.72);
      const g = Math.round(60 + 150 * light);
      ctx.fillStyle = `rgb(${Math.round(g * 0.62)},${Math.round(g * 0.55)},${g})`;
      ctx.beginPath();
      ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.lineTo(X(c), Y(c));
      ctx.closePath();
      ctx.fill();
      if (!thin) { ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.6; ctx.stroke(); }
    }
    this.base = base;
  }

  draw(slice: SliceResult | null) {
    const ctx = this.canvas.getContext("2d");
    if (!ctx || !this.base || !this.vc) return;
    ctx.drawImage(this.base, 0, 0);
    if (!slice) return;

    const { scale, cx, cy, cu, cv, cw } = this.fit;
    const ca = Math.cos(AZ), sa = Math.sin(AZ), ce = Math.cos(EL), se = Math.sin(EL);
    const w = slice.height - cw;
    const P = (pu: number, pv: number) => {
      const u = pu - cu, v = pv - cv;
      const u1 = u * ca - v * sa, v1 = u * sa + v * ca;
      return { x: cx + u1 * scale, y: cy - (w * ce + v1 * se) * scale };
    };

    ctx.save();
    ctx.strokeStyle = "#ff4d4d";
    ctx.lineWidth = 2;
    for (const loop of slice.loops) {
      ctx.beginPath();
      loop.points.forEach((p, i) => { const s = P(p.u, p.v); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); });
      if (loop.closed) ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** Zeichnet die 2D-Konturen eingepasst in das Canvas, inkl. Maßangabe */
export function render2D(canvas: HTMLCanvasElement, slice: SliceResult | null, scalePct = 100) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#121216";
  ctx.fillRect(0, 0, W, H);

  if (!slice || slice.loops.length === 0) {
    ctx.fillStyle = "#888";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(t("stl.noContour"), W / 2, H / 2);
    return;
  }

  const spanU = slice.maxU - slice.minU, spanV = slice.maxV - slice.minV;
  const pad = 28;
  const s = Math.min((W - pad * 2) / Math.max(spanU, 1e-6), (H - pad * 2) / Math.max(spanV, 1e-6));
  const ox = (W - spanU * s) / 2, oy = (H + spanV * s) / 2;
  const X = (u: number) => ox + (u - slice.minU) * s;
  const Y = (v: number) => oy - (v - slice.minV) * s;

  // Fläche leicht füllen (Löcher bleiben frei)
  ctx.save();
  ctx.beginPath();
  for (const loop of slice.loops) {
    if (!loop.closed) continue;
    loop.points.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p.u), Y(p.v)) : ctx.lineTo(X(p.u), Y(p.v))));
    ctx.closePath();
  }
  ctx.fillStyle = "rgba(0, 122, 204, 0.18)";
  ctx.fill("evenodd");
  ctx.restore();

  for (const loop of slice.loops) {
    ctx.beginPath();
    loop.points.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p.u), Y(p.v)) : ctx.lineTo(X(p.u), Y(p.v))));
    if (loop.closed) ctx.closePath();
    ctx.strokeStyle = !loop.closed ? "#ff4d4d" : loop.isHole ? "#ffc107" : "#3aa0ff";
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  // Maße
  const f = scalePct / 100;
  ctx.fillStyle = "#cfcfe0";
  ctx.font = "12px monospace";
  ctx.textAlign = "center";
  ctx.fillText(`${(spanU * f).toFixed(2)} mm`, W / 2, H - 8);
  ctx.save();
  ctx.translate(12, H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(`${(spanV * f).toFixed(2)} mm`, 0, 0);
  ctx.restore();
}
