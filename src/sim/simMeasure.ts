/**
 * MESSEN IN DER SIMULATION – reine Rechnung (Tests: tests/smallPack.test.ts)
 *
 * Material: Der Blickstrahl durch den Mauspunkt wird von oben nach unten verfolgt, bis er auf das abgetragene Material
 * trifft (Höhenraster aus simCarve.ts). Genauigkeit in X/Y: eine Rasterzelle.
 * Bahnen: die nächste Bahn im Bild, mit Fang an ihren Enden (dort genau).
 */
export interface MPoint { x: number; y: number; z: number; kind: "surface" | "path" | "end" | "flat" }
export interface Camera { yaw: number; pitch: number; scale: number; ox: number; oy: number; cx: number; cy: number; cz: number }
export interface HeightGrid { nx: number; ny: number; x0: number; y0: number; cell: number; T: number; h: ArrayLike<number> }

/** Punkt auf dem Strahl durch den Bildpunkt in der Höhe z; null = Blick genau waagerecht (Vorderansicht) */
export function rayAt(sx: number, sy: number, z: number, c: Camera): { x: number; y: number } | null {
  const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
  if (cp < 0.02) return null;
  const u = (sx - c.ox) / c.scale, v = -(sy - c.oy) / c.scale;
  const yr = (v - (z - c.cz) * sp) / cp, cw = Math.cos(c.yaw), sw = Math.sin(c.yaw);
  return { x: c.cx + u * cw + yr * sw, y: c.cy - u * sw + yr * cw };
}

/** Erste Stelle, an der der Strahl Material trifft; daneben oder durchgefräst = null */
export function surfaceHit(sx: number, sy: number, c: Camera, g: HeightGrid): MPoint | null {
  const at = (x: number, y: number): number | null => {
    const i = Math.floor((x - g.x0) / g.cell), j = Math.floor((y - g.y0) / g.cell);
    return i >= 0 && j >= 0 && i < g.nx && j < g.ny ? g.h[j * g.nx + i] : null;
  };
  const sp = Math.sin(c.pitch), cp = Math.cos(c.pitch);
  if (cp < 0.02) return null;
  // so fein in der Höhe, dass sich der Strahl in der Ebene höchstens eine halbe Zelle bewegt
  const dz = sp < 1e-3 ? g.T : Math.min(g.T, Math.max(g.T / 4000, (g.cell / 2) * cp / sp));
  for (let z = 0; ; z -= dz) {
    const zz = Math.max(z, -g.T), p = rayAt(sx, sy, zz, c)!, h = at(p.x, p.y);
    if (sp < 1e-3) return h === null || h <= -g.T + 1e-6 ? null : { x: p.x, y: p.y, z: Math.min(0, h), kind: "surface" };
    // getroffen: hier steht Material bis mindestens zu dieser Höhe (durchgefräste Zellen haben keins)
    if (h !== null && h > -g.T + 1e-6 && h >= zz - 1e-9) {
      // Boden (Höhe kaum über dem Strahl) genau auf die Fläche legen; sonst ist es eine Wand
      const floor = Math.min(0, h);
      return floor - zz <= dz * 1.5 ? { x: p.x, y: p.y, z: floor, kind: "surface" } : { x: p.x, y: p.y, z: zz, kind: "surface" };
    }
    if (z <= -g.T) return null;
  }
}

export interface Measured { dx: number; dy: number; dz: number; xy: number; d3: number; angle: number }
export function measured(a: MPoint, b: MPoint): Measured {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, xy = Math.hypot(dx, dy);
  return { dx, dy, dz, xy, d3: Math.hypot(xy, dz), angle: xy > 1e-9 ? Math.atan2(dy, dx) * 180 / Math.PI : 0 };
}
