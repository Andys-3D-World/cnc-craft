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
 * Schattiertes Bild mit Tiefenpuffer (z-Buffer) selbst ausrechnen – in doppelter Auflösung, dann verkleinert
 * (glatte Kanten). Kein Sortieren und kein Canvas-Pfad je Dreieck: auch 10 Mio. Dreiecke dauern nur Sekundenbruchteile.
 */
function rasterize(mesh: WeldedMesh, pr: Projected, W: number, H: number, scale: number, cx: number, cy: number): HTMLCanvasElement {
  const SS = 2, w = W * SS, h = H * SS;
  const k = scale * SS, ox = cx * SS, oy = cy * SS;
  const n = pr.sx.length;
  const X = new Float32Array(n), Y = new Float32Array(n);
  for (let i = 0; i < n; i++) { X[i] = ox + pr.sx[i] * k; Y[i] = oy - pr.sy[i] * k; }
  const D = pr.depth;
  const zbuf = new Float32Array(w * h).fill(-Infinity);
  const img = new ImageData(w, h);
  const px = new Uint32Array(img.data.buffer);
  px.fill(0xff161212); // #121216 (ABGR im Speicher)
  const tris = mesh.tris, T = mesh.triangleCount;

  for (let t = 0; t < T; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    const x0 = X[a], y0 = Y[a], x1 = X[b], y1 = Y[b], x2 = X[c], y2 = Y[c];
    // doppelte Fläche (Bildschirm); 0 = Dreieck von der Kante gesehen
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area === 0 || area !== area) continue;
    const minX = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 0.5)), maxX = Math.min(w - 1, Math.floor(Math.max(x0, x1, x2) - 0.5));
    const minY = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 0.5)), maxY = Math.min(h - 1, Math.floor(Math.max(y0, y1, y2) - 0.5));
    if (minX > maxX || minY > maxY) continue;
    // Licht: Normale im Bildschirm-Raum (wie früher beim Malen mit Pfaden)
    const ux = pr.sx[b] - pr.sx[a], uy = pr.sy[b] - pr.sy[a], uz = D[b] - D[a];
    const vx = pr.sx[c] - pr.sx[a], vy = pr.sy[c] - pr.sy[a], vz = D[c] - D[a];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const light = Math.abs((nx * 0.35 + ny * 0.6 + nz * 0.72) / len);
    const g = Math.round(60 + 150 * light);
    const col = 0xff000000 | (g << 16) | (Math.round(g * 0.55) << 8) | Math.round(g * 0.62);
    const inv = 1 / area, d0 = D[a], d1 = D[b], d2 = D[c];
    for (let py = minY; py <= maxY; py++) {
      const fy = py + 0.5;
      for (let pxi = minX; pxi <= maxX; pxi++) {
        const fx = pxi + 0.5;
        // Schwerpunkt-Koordinaten: alle >= 0 -> Pixelmitte liegt im Dreieck
        const l1 = ((fx - x0) * (y2 - y0) - (x2 - x0) * (fy - y0)) * inv;
        const l2 = ((x1 - x0) * (fy - y0) - (fx - x0) * (y1 - y0)) * inv;
        const l0 = 1 - l1 - l2;
        if (l0 < 0 || l1 < 0 || l2 < 0) continue;
        const z = l0 * d0 + l1 * d1 + l2 * d2;
        const o = py * w + pxi;
        if (z > zbuf[o]) { zbuf[o] = z; px[o] = col; }
      }
    }
  }

  const big = document.createElement("canvas");
  big.width = w; big.height = h;
  big.getContext("2d")!.putImageData(img, 0, 0);
  const base = document.createElement("canvas");
  base.width = W; base.height = H;
  const ctx = base.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(big, 0, 0, W, H);
  return base;
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

    this.base = rasterize(mesh, pr, W, H, scale, this.fit.cx, this.fit.cy);
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
