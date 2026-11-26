/**
 * ENTWURF IN 3D – die Rechnung (keine Oberfläche, Tests in tests/design3d.test.ts)
 *
 * Kamera schaut auf einen Punkt der Material-Oberseite (Z = 0): Abstand, Drehung (yaw) und Höhe über der Ebene (el).
 * Welt in mm wie im G-Code: x rechts, y nach hinten, z nach oben. Bildschirm in Pixeln ab links oben.
 */
export interface Cam { tx: number; ty: number; dist: number; yaw: number; el: number }
export interface View { w: number; h: number }
export type M4 = Float32Array;

export const FOV = 0.6, MIN_EL = 0.14, MAX_EL = Math.PI / 2;
const T2 = Math.tan(FOV / 2);

const ident = (): M4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
export function mul(a: M4, b: M4): M4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
const trans = (x: number, y: number, z: number): M4 => { const m = ident(); m[12] = x; m[13] = y; m[14] = z; return m; };
const rotX = (a: number): M4 => { const m = ident(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; };
const rotZ = (a: number): M4 => { const m = ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; };

export function clampCam(c: Cam): Cam {
  return { tx: c.tx, ty: c.ty, yaw: c.yaw, dist: Math.min(50000, Math.max(2, c.dist)), el: Math.min(MAX_EL, Math.max(MIN_EL, c.el)) };
}

/** Welt → Bildschirm-Matrix (far = Größe der Szene, damit nichts abgeschnitten wird) */
export function matrix(c: Cam, v: View, size: number): M4 {
  const view = mul(trans(0, 0, -c.dist), mul(rotX(-(Math.PI / 2 - c.el)), mul(rotZ(c.yaw), trans(-c.tx, -c.ty, 0))));
  const near = Math.max(0.5, c.dist * 0.02), far = c.dist + size * 4 + 1000;
  const f = 1 / T2, p = new Float32Array(16);
  p[0] = f / (v.w / v.h); p[5] = f; p[10] = (far + near) / (near - far); p[11] = -1; p[14] = (2 * far * near) / (near - far);
  return mul(p, view);
}

/** Punkt der Welt auf den Bildschirm. null = hinter der Kamera */
export function project(c: Cam, v: View, x: number, y: number, z: number): { x: number; y: number } | null {
  const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), dx = x - c.tx, dy = y - c.ty;
  const rx = dx * cy - dy * sy, ry = dx * sy + dy * cy;
  const a = Math.PI / 2 - c.el, ca = Math.cos(a), sa = Math.sin(a);
  const ux = rx, uy = ry * ca + z * sa, uz = -ry * sa + z * ca - c.dist;
  if (uz > -1e-6) return null;
  const k = v.h / 2 / T2 / -uz;
  return { x: v.w / 2 + ux * k, y: v.h / 2 - uy * k };
}

/** Wo trifft der Sehstrahl durch diesen Bildschirm-Punkt die Ebene Z = z? null = gar nicht (über dem Horizont) */
export function onPlane(c: Cam, v: View, px: number, py: number, z = 0): { x: number; y: number } | null {
  const k = T2 / (v.h / 2);
  const dx = (px - v.w / 2) * k, dy = -(py - v.h / 2) * k, dz = -1;
  const a = Math.PI / 2 - c.el, ca = Math.cos(a), sa = Math.sin(a);
  // zurück in die Welt: erst Neigung, dann Drehung
  const back = (x: number, y: number, zz: number) => {
    const ry = y * ca - zz * sa, rz = y * sa + zz * ca;
    const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
    return { x: x * cy + ry * sy, y: -x * sy + ry * cy, z: rz };
  };
  const d = back(dx, dy, dz), e = back(0, 0, c.dist);
  if (d.z > -1e-4) return null;
  const s = (z - e.z) / d.z;
  return s > 0 ? { x: c.tx + e.x + d.x * s, y: c.ty + e.y + d.y * s } : null;
}

/** Bildschirm-Pixel je mm in der Mitte des Bildes */
export function pxPerMm(c: Cam, v: View): number { return v.h / 2 / T2 / c.dist; }
export function distFor(pxmm: number, v: View): number { return v.h / 2 / T2 / pxmm; }

/** Zum Punkt p (auf der Ebene) hin zoomen: p bleibt unter der Maus */
export function zoomAt(c: Cam, p: { x: number; y: number } | null, factor: number): Cam {
  const n = clampCam({ ...c, dist: c.dist * factor }), k = n.dist / c.dist;
  if (!p) return n;
  return { ...n, tx: p.x + (c.tx - p.x) * k, ty: p.y + (c.ty - p.y) * k };
}

/** Tiefe ziehen: neue Tiefe (negativ) aus der Mausbewegung nach unten. Je flacher der Blick, desto direkter */
export function dragDepth(c: Cam, v: View, z0: number, dyPx: number, max: number, step: number): number {
  const z = z0 - dyPx / (pxPerMm(c, v) * Math.max(0.25, Math.cos(c.el)));
  const r = Math.round(Math.max(-max, Math.min(0, z)) / step) * step;
  return Math.abs(r) < 1e-9 ? 0 : +r.toFixed(3);
}

export interface Box { x0: number; y0: number; x1: number; y1: number }
/** Rand des Rohteils um das gerechnete Stück herum: bis zu vier Rechtecke */
export function frameRects(outer: Box, inner: Box): Box[] {
  const i = { x0: Math.max(outer.x0, inner.x0), y0: Math.max(outer.y0, inner.y0), x1: Math.min(outer.x1, inner.x1), y1: Math.min(outer.y1, inner.y1) };
  if (!(i.x1 > i.x0 && i.y1 > i.y0)) return [outer];
  return [
    { x0: outer.x0, y0: outer.y0, x1: outer.x1, y1: i.y0 }, { x0: outer.x0, y0: i.y1, x1: outer.x1, y1: outer.y1 },
    { x0: outer.x0, y0: i.y0, x1: i.x0, y1: i.y1 }, { x0: i.x1, y0: i.y0, x1: outer.x1, y1: i.y1 }
  ].filter(r => r.x1 - r.x0 > 1e-6 && r.y1 - r.y0 > 1e-6);
}

/** Höhenraster auf das Rohteil zuschneiden (carveSim rechnet immer etwas Rand mit). null = liegt ganz daneben */
export function cropGrid<G extends { nx: number; ny: number; x0: number; y0: number; cell: number; h: Float32Array }>(g: G, b: Box): G | null {
  const i0 = Math.max(0, Math.round((b.x0 - g.x0) / g.cell)), i1 = Math.min(g.nx, Math.round((b.x1 - g.x0) / g.cell));
  const j0 = Math.max(0, Math.round((b.y0 - g.y0) / g.cell)), j1 = Math.min(g.ny, Math.round((b.y1 - g.y0) / g.cell));
  const nx = i1 - i0, ny = j1 - j0;
  if (nx < 2 || ny < 2) return null;
  if (nx === g.nx && ny === g.ny) return g;
  const h = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) h.set(g.h.subarray((j + j0) * g.nx + i0, (j + j0) * g.nx + i1), j * nx);
  return { ...g, nx, ny, x0: g.x0 + i0 * g.cell, y0: g.y0 + j0 * g.cell, h };
}
