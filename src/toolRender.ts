/**
 * WERKZEUG-BILD wie ein Foto – für die Werkzeug-Bibliothek (toolGraphics.ts)
 *
 * Derselbe 3D-Körper wie in der Simulation (sim/toolMesh.ts: Spannuten, Kern, Drall) wird hier ohne Grafikkarte
 * gerechnet: genau von der Seite (oder von unten), ohne Perspektive – deshalb bleibt das Bild maßstäblich und die
 * Maßpfeile der Zeichnung passen weiter. Heraus kommt ein kleines Bild (PNG als Text), das in die SVG-Zeichnung gelegt wird.
 *
 * In der App rechnet Rust dieselbe Rechnung (src-tauri/src/toolmesh.rs, über toolRust.ts) – was hier steht, läuft im
 * Browser (Vorschau) und in den Tests. Beide Seiten müssen gleich bleiben.
 * Ein Bild kostet wenige Millisekunden und wird gemerkt (gleiche Maße + gleiche Größe = gleiches Bild).
 * Ohne Bildschirm (Tests) gibt es kein Bild – dann zeichnet toolGraphics.ts wie früher mit Linien.
 */
import type { ToolGeom } from "./toolGraphics";
import { cutterLook, cutterMesh, sweep, type RGB } from "./sim/toolMesh.ts";
import { COATING_RGB } from "./toolCoating.ts";
import { rustFailed, rustOn, rustPicture, toolJob } from "./toolRust.ts";

type Pt = [number, number];
const STEEL: RGB = [0.74, 0.76, 0.8];

/** Fräser als Dreiecke: Schneiden (cut, Spitze bei 0) und der Rest bis oben (rest), auf Wunsch mit Farbring am Schaft */
export function libraryMesh(g: ToolGeom, cut: Pt[], rest: Pt[], ring?: RGB): Float32Array {
  const out: number[] = [];
  const col = COATING_RGB[g.coating ?? "none"] ?? COATING_RGB.none;
  const top = cut[cut.length - 1][1];
  cutterMesh(out, cut, cutterLook(g, g.diameter / 2, top), col, 2);
  const bare = STEEL;   // die Beschichtung sitzt nur auf den Schneiden – der Schaft bleibt blank
  if (rest.length > 1) {
    const end = rest[rest.length - 1], rs = end[0], len = end[1] - rest[rest.length - 2][1];
    // Farbring wie bei gekennzeichneten Werkzeugen: oben am Schaft, in der Farbe des Werkzeugs
    const h = Math.min(len * 0.22, Math.max(rs * 1.2, 1.5)), z1 = end[1] - Math.min(len * 0.12, rs), z0 = z1 - h;
    if (ring && len > 2 && z0 > rest[rest.length - 2][1]) {
      sweep(out, [...rest.slice(0, -1), [rs, z0]], { seg: 48, col: bare, alpha: 2 });
      sweep(out, [[rs, z0], [rs, z1]], { seg: 48, col: ring, alpha: 1 });
      sweep(out, [[rs, z1], end, [0, end[1]]], { seg: 48, col: bare, alpha: 2 });
    } else sweep(out, [...rest, [0, end[1]]], { seg: 48, col: bare, alpha: 2 });
  }
  return new Float32Array(out);
}

const KEY = unit([-0.55, -0.75, 0.2]), RIM = unit([0.85, 0.35, 0.1]), LIGHT = unit([-0.45, -0.6, 0.75]);
function unit(v: number[]): number[] { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
const sstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Licht wie MESH_FS in simCarveGl.ts; V = Richtung zum Betrachter. Ergebnis 0…1 je Farbe */
function shade(nx: number, ny: number, nz: number, V: number[], c: ArrayLike<number>, ci: number, metal: boolean, o: number[]) {
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  let ndv = nx * V[0] + ny * V[1] + nz * V[2];
  if (ndv < 0) { nx = -nx; ny = -ny; nz = -nz; ndv = -ndv; }
  const diff = 0.5 + 0.5 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
  if (!metal) { for (let k = 0; k < 3; k++) o[k] = c[ci + k] * (0.45 + 0.6 * diff); return; }
  const rx = 2 * ndv * nx - V[0], ry = 2 * ndv * ny - V[1], rz = 2 * ndv * nz - V[2];
  const hl = Math.hypot(rx, ry, rz * 0.4) || 1, hx = rx / hl, hy = ry / hl, hz = rz * 0.4 / hl;
  const key = Math.pow(Math.max(0, hx * KEY[0] + hy * KEY[1] + hz * KEY[2]), 3);
  const rim = Math.pow(Math.max(0, hx * RIM[0] + hy * RIM[1] + hz * RIM[2]), 14);
  const sky = sstep(-0.95, 0.7, rz), fres = Math.pow(1 - ndv, 3);
  const body = 0.22 + 0.34 * diff + 0.4 * sky + 0.75 * key, add = key * key * key * 0.5 + rim * 0.45 + fres * 0.15;
  for (let k = 0; k < 3; k++) o[k] = c[ci + k] * body + add;
}

export interface Frame { x0: number; x1: number; y0: number; y1: number }

/**
 * Dreiecke in ein Pixelbild rechnen (RGBA, 0…255). view "side": von vorn, Bild-x = x, Bild-y = Höhe z;
 * "end": von unten auf die Spitze. frame = der Ausschnitt in mm, der das ganze Bild füllt.
 */
export function rasterize(mesh: Float32Array, view: "side" | "end", f: Frame, W: number, H: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4), zb = new Float32Array(W * H).fill(-Infinity);
  // von unten: Licht gespiegelt rechnen (als läge das Werkzeug mit der Spitze nach oben), sonst läge die Stirn im Schatten
  const side = view === "side", V = side ? [0, -1, 0] : [0, 0, 1], zs = side ? 1 : -1;
  const kx = W / (f.x1 - f.x0), ky = H / (f.y1 - f.y0), rgb = [0, 0, 0];
  const X = new Float64Array(3), Y = new Float64Array(3), D = new Float64Array(3);
  for (let t = 0; t + 29 < mesh.length; t += 30) {
    for (let i = 0; i < 3; i++) {
      const o = t + i * 10;
      X[i] = (mesh[o] - f.x0) * kx;
      Y[i] = (f.y1 - (side ? mesh[o + 2] : mesh[o + 1])) * ky;
      D[i] = side ? -mesh[o + 1] : -mesh[o + 2];
    }
    const area = (X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0]);
    if (Math.abs(area) < 1e-9) continue;
    const xa = Math.max(0, Math.floor(Math.min(X[0], X[1], X[2]))), xb = Math.min(W - 1, Math.ceil(Math.max(X[0], X[1], X[2])));
    const ya = Math.max(0, Math.floor(Math.min(Y[0], Y[1], Y[2]))), yb = Math.min(H - 1, Math.ceil(Math.max(Y[0], Y[1], Y[2])));
    const metal = mesh[t + 9] > 1;
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      const w0 = ((X[1] - cx) * (Y[2] - cy) - (X[2] - cx) * (Y[1] - cy)) / area;
      const w1 = ((X[2] - cx) * (Y[0] - cy) - (X[0] - cx) * (Y[2] - cy)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
      const d = w0 * D[0] + w1 * D[1] + w2 * D[2], at = y * W + x;
      if (d <= zb[at]) continue;
      zb[at] = d;
      shade(w0 * mesh[t + 3] + w1 * mesh[t + 13] + w2 * mesh[t + 23], w0 * mesh[t + 4] + w1 * mesh[t + 14] + w2 * mesh[t + 24],
        (w0 * mesh[t + 5] + w1 * mesh[t + 15] + w2 * mesh[t + 25]) * zs, V, mesh, t + 6, metal, rgb);
      const p = at * 4;
      px[p] = rgb[0] * 255; px[p + 1] = rgb[1] * 255; px[p + 2] = rgb[2] * 255; px[p + 3] = 255;
    }
  }
  return px;
}

const cache = new Map<string, string>();
const pending = new Map<string, number>();
let nextId = 0;

/** Was gezeichnet wird: Werkzeug, Schneiden-Umriss (Spitze bei 0), Rest bis oben, auf Wunsch der Farbring */
export interface PictureSpec { g: ToolGeom; cut: Pt[]; rest: Pt[]; ring?: RGB }

function toUrl(px: Uint8ClampedArray, W: number, H: number): string | null {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(W, H);
  img.data.set(px);
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

/**
 * Fertiges <image …/> für eine SVG-Zeichnung. wPx × hPx = Größe auf dem Bildschirm; gerechnet wird feiner,
 * damit die Kanten glatt sind. attrs = Lage und Größe (x, y, width, height …).
 * In der App rechnet Rust (toolmesh.rs): das Bild erscheint einen Augenblick später im selben <image>.
 * Im Browser rechnet TypeScript sofort. null = hier gibt es keine Zeichenfläche (Tests).
 */
export function toolImageTag(spec: PictureSpec, view: "side" | "end", f: Frame, wPx: number, hPx: number, attrs: string): string | null {
  if (typeof document === "undefined" || !(wPx > 0) || !(hPx > 0)) return null;
  const k = Math.max(1, Math.min(3, 900 / Math.max(wPx, hPx)));
  const W = Math.max(2, Math.round(wPx * k)), H = Math.max(2, Math.round(hPx * k));
  const tool = toolJob(spec.g), ring = spec.ring ?? null;
  const id = JSON.stringify([view, W, H, f, tool, spec.cut, spec.rest, ring]);
  const hit = cache.get(id);
  if (hit) return `<image href="${hit}" ${attrs}/>`;
  const local = (): string | null => {
    try {
      const url = toUrl(rasterize(libraryMesh(spec.g, spec.cut, spec.rest, spec.ring), view, f, W, H), W, H);
      if (url) { if (cache.size > 300) cache.clear(); cache.set(id, url); }
      return url;
    } catch { return null; }
  };
  if (rustOn()) {
    let n = pending.get(id);
    if (n === undefined) {
      n = ++nextId;
      pending.set(id, n);
      const show = (url: string | null) => {
        pending.delete(id);
        if (url) document.querySelectorAll(`image[data-timg="${n}"]`).forEach(e => e.setAttribute("href", url));
      };
      rustPicture({ tool, cut: spec.cut, rest: spec.rest, ring, view, frame: [f.x0, f.x1, f.y0, f.y1], w: W, h: H })
        .then(px => { const url = toUrl(px, W, H); if (url) { if (cache.size > 300) cache.clear(); cache.set(id, url); } show(url); })
        .catch(() => { rustFailed(); show(local()); });
    }
    return `<image data-timg="${n}" ${attrs}/>`;
  }
  const url = local();
  return url ? `<image href="${url}" ${attrs}/>` : null;
}
