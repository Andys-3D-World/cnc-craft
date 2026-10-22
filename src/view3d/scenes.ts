/**
 * 3D-SZENEN für den Betrachter
 *
 *  - Teile: alles, was durchgeschnitten wird (Laser: Linien-Ebenen ab 70 % Leistung, Fräse: außen/innen,
 *    Plasma: alles Geschlossene), wird zu Körpern mit der Materialdicke. Oben die Material-Oberfläche mit der
 *    Gravur (wie die Materialansicht), Schnittkanten beim Laser auf Holz/Leder/Karton angekohlt dunkel.
 *    Auf Wunsch die Restplatte mit den Löchern dazu, die Teile herausgehoben.
 *  - Zylinder: die Zeichnung um ein rundes Teil gewickelt (Drehachse).
 */
import polygonClipping, { MultiPolygon, Polygon } from "polygon-clipping";
import earcut from "earcut";
import { Mesh } from "./viewer3d";
import { MM_TO_PIXEL, groupBounds, shapeToPaths } from "../shapeTransform";
import { Material, drawMaterialBed, drawMaterialShapes } from "../materialView";
import { isLaser, isPlasma } from "../machineMode";
import { layerForShape } from "../laserLayers";
import { circumference } from "../rotary";

type RGB = [number, number, number];
const col = (c: number[], k: number): RGB => [c[0] / 255 * k, c[1] / 255 * k, c[2] / 255 * k];

/** Wird diese Form durchgeschnitten? (gleiche Regel wie die Materialansicht) */
function isCut(s: any): boolean {
  if (s.type === "image") return false;
  if (isPlasma()) return true;
  if (isLaser()) { const l = layerForShape(s); return !!l && l.mode !== "fill" && l.power >= 70; }
  return s.millingMode === "outside" || s.millingMode === "inside";
}

/** Oberfläche (Material + Gravur) für den Bereich b (mm) als Bild */
function topTexture(shapes: any[], m: Material, b: { x0: number; y0: number; x1: number; y1: number }): HTMLCanvasElement {
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const k = Math.min(8, 4096 / Math.max(w, h));             // Bildpunkte pro mm
  const tex = document.createElement("canvas");
  tex.width = Math.max(2, Math.round(w * k)); tex.height = Math.max(2, Math.round(h * k));
  const ctx = tex.getContext("2d")!;
  const scale = k / MM_TO_PIXEL;
  drawMaterialBed(ctx, 0, 0, tex.width, tex.height, scale, m);
  drawMaterialShapes(ctx, shapes, new Set(),
    x => (x - b.x0 * MM_TO_PIXEL) * scale, y => (b.y1 * MM_TO_PIXEL - y) * scale, scale, m);
  return tex;
}

/** Fläche (mehrere Polygone mit Löchern) zu einem Körper von z0 bis z1 */
function extrude(mp: MultiPolygon, z0: number, z1: number, top: { tex: HTMLCanvasElement; b: { x0: number; y0: number; x1: number; y1: number } },
  side: RGB, bottom: RGB, offset: [number, number, number]): Mesh[] {
  const T: Mesh = { pos: [], nrm: [], uv: [], tex: top.tex, offset };
  const B: Mesh = { pos: [], nrm: [], color: bottom, offset };
  const S: Mesh = { pos: [], nrm: [], color: side, offset };
  const bw = top.b.x1 - top.b.x0, bh = top.b.y1 - top.b.y0;
  for (const poly of mp) {
    const flat: number[] = [], holes: number[] = [];
    poly.forEach((ring, ri) => {
      const r = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
      if (ri) holes.push(flat.length / 2);
      for (const [x, y] of r) flat.push(x, y);
      // Seitenwände
      for (let i = 0; i < r.length; i++) {
        const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length];
        const L = Math.hypot(bx - ax, by - ay);
        if (L < 1e-9) continue;
        const nx = (by - ay) / L, ny = -(bx - ax) / L;
        S.pos.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z0, bx, by, z1, ax, ay, z1);
        for (let k = 0; k < 6; k++) S.nrm.push(nx, ny, 0);
      }
    });
    const tri = earcut(flat, holes.length ? holes : null, 2);
    for (const i of tri) {
      const x = flat[i * 2], y = flat[i * 2 + 1];
      T.pos.push(x, y, z1); T.nrm.push(0, 0, 1); T.uv!.push((x - top.b.x0) / bw, (top.b.y1 - y) / bh);
      B.pos.push(x, y, z0); B.nrm.push(0, 0, -1);
    }
  }
  return [T, B, S];
}

export interface PartsOptions { thickness: number; sheet: boolean; lift: number }

/** Teile (und Restplatte) als 3D-Körper. Gibt auch die Anzahl Teile zurück. */
export function partsScene(shapes: any[], m: Material, o: PartsOptions): { meshes: Mesh[]; parts: number } {
  const gb = groupBounds(shapes);
  if (!gb) return { meshes: [], parts: 0 };
  const mm = (v: number) => v / MM_TO_PIXEL;
  const margin = 8;
  const b = { x0: mm(gb.minX) - margin, y0: mm(gb.minY) - margin, x1: mm(gb.maxX) + margin, y1: mm(gb.maxY) + margin };
  const tex = topTexture(shapes, m, b);
  // Fläche der Teile: alle Schnittkonturen nach Gerade/Ungerade
  const rings: Polygon[] = [];
  for (const s of shapes) if (isCut(s)) for (const p of shapeToPaths(s)) {
    if (p.closed && p.pts.length >= 3) rings.push([p.pts.map(q => [mm(q.x), mm(q.y)] as [number, number])]);
  }
  const parts: MultiPolygon = rings.length ? (rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1))) : [];
  const T = Math.max(0.2, o.thickness);
  const laserBurn = isLaser() && ["wood", "leather", "card"].includes(m.kind);
  const edge: RGB = laserBurn ? col(m.burn, 0.85) : col(m.base, 0.78);
  const bottom = col(m.base, 0.8);
  const rect: MultiPolygon = [[[[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]]];
  const meshes: Mesh[] = [];
  if (!parts.length) {
    // nichts wird ausgeschnitten: nur die Platte mit der Gravur
    meshes.push(...extrude(rect, 0, T, { tex, b }, col(m.base, 0.78), bottom, [0, 0, 0]));
    return { meshes, parts: 0 };
  }
  meshes.push(...extrude(parts, 0, T, { tex, b }, edge, bottom, [0, 0, o.sheet ? o.lift : 0]));
  if (o.sheet) {
    const rest = polygonClipping.difference(rect, parts);
    if (rest.length) meshes.push(...extrude(rest, 0, T, { tex, b }, edge, bottom, [0, 0, 0]));
  }
  return { meshes, parts: parts.length };
}

/** Zeichnung abgewickelt als Bild: Breite = Länge entlang X, Höhe = Umfang (oben = Umfang, unten = 0) */
export function wrapTexture(shapes: any[], m: Material, pxPerMm: number): { tex: HTMLCanvasElement; lenMm: number; yc: number } {
  const b = groupBounds(shapes);
  const margin = 15;
  const x0 = b ? b.minX / MM_TO_PIXEL - margin : 0;
  const x1 = b ? b.maxX / MM_TO_PIXEL + margin : 100;
  const lenMm = Math.max(40, x1 - x0), circ = circumference();
  const k = Math.min(pxPerMm, 4096 / Math.max(lenMm, circ));
  const tex = document.createElement("canvas");
  tex.width = Math.max(2, Math.round(lenMm * k));
  tex.height = Math.max(2, Math.round(circ * k));
  const ctx = tex.getContext("2d")!;
  const scale = k / MM_TO_PIXEL;
  drawMaterialBed(ctx, 0, 0, tex.width, tex.height, scale, m);
  const cPx = circ * MM_TO_PIXEL;
  drawMaterialShapes(ctx, shapes, new Set(), x => (x - x0 * MM_TO_PIXEL) * scale, y => (cPx - y) * scale, scale, m);
  const yc = b ? (b.minY + b.maxY) / 2 / MM_TO_PIXEL : circ / 2;
  return { tex, lenMm, yc };
}

/** Rundes Teil (Achse entlang x), die Mitte der Zeichnung zeigt nach vorn (zur Kamera, −y) */
export function cylinderScene(shapes: any[], m: Material, diameter: number): Mesh[] {
  const { tex, lenMm, yc } = wrapTexture(shapes, m, 6);
  const R = diameter / 2, N = 160, circ = circumference();
  const shift = (yc / circ) * Math.PI * 2;
  const side: Mesh = { pos: [], nrm: [], uv: [], tex };
  const P = (x: number, th: number) => { const a = th - shift; return [x, -R * Math.cos(a), R * Math.sin(a)]; };
  const Nn = (th: number) => { const a = th - shift; return [0, -Math.cos(a), Math.sin(a)]; };
  for (let j = 0; j < N; j++) {
    const t0 = (j / N) * Math.PI * 2, t1 = ((j + 1) / N) * Math.PI * 2;
    // Bildzeile: oben im Bild = großes y der Zeichnung; θ wächst nach oben (vorn), y der Zeichnung auch
    const v0 = 1 - j / N, v1 = 1 - (j + 1) / N;
    const quad: [number, number, number, number][] = [[0, t0, 0, v0], [lenMm, t0, 1, v0], [lenMm, t1, 1, v1], [0, t0, 0, v0], [lenMm, t1, 1, v1], [0, t1, 0, v1]];
    for (const [x, th, u, v] of quad) { side.pos.push(...P(x, th)); side.nrm.push(...Nn(th)); side.uv!.push(u, v); }
  }
  const caps: Mesh = { pos: [], nrm: [], color: col(m.base, 0.88) };
  for (const [x, nx] of [[0, -1], [lenMm, 1]] as const) for (let j = 0; j < N; j++) {
    const t0 = (j / N) * Math.PI * 2, t1 = ((j + 1) / N) * Math.PI * 2;
    caps.pos.push(x, 0, 0, ...P(x, t0), ...P(x, t1));
    for (let k = 0; k < 3; k++) caps.nrm.push(nx, 0, 0);
  }
  return [side, caps];
}
