/**
 * KÖRPER FÜR DEN 3D-DRUCK (STL)
 *
 * Aus 2D-Flächen werden geschlossene Körper (je Fläche Deckel, Boden, Wände – wasserdicht, Normalen nach außen).
 * Mehrere Körper dürfen sich berühren oder überlappen; der Slicer vereinigt sie.
 *  - Grundkörper: Fläche der Formen nach Gerade/Ungerade (Ausschnitte/Löcher bleiben frei), Höhe je Gruppe
 *  - Vertiefung: an diesen Stellen ist der Grundkörper nur (Höhe − Tiefe) hoch
 *  - Erhebung: steht um die Höhe über dem Grundkörper vor (ohne Grundkörper: frei stehend ab 0)
 * Koordinaten in mm: x rechts, y nach hinten, z nach oben (wie der 3D-Betrachter).
 */
import polygonClipping, { MultiPolygon, Polygon, Ring } from "polygon-clipping";
import earcut from "earcut";
import { Mesh } from "./viewer3d";
import { MM_TO_PIXEL, shapeToPaths } from "../shapeTransform";

export type SolidKind = "body" | "recess" | "raise";
export interface SolidPart { kind: SolidKind; value: number; shapes: any[] }
/** Dreiecke: je 9 Zahlen (3 Ecken × xyz), gegen den Uhrzeigersinn von außen gesehen */
export interface Shell { kind: SolidKind; tris: number[] }

/** Fläche der geschlossenen Formen nach Gerade/Ungerade (innere Konturen = Löcher) */
export function regionOf(shapes: any[]): MultiPolygon {
  const rings: Polygon[] = [];
  for (const s of shapes) for (const p of shapeToPaths(s)) {
    if (p.closed && p.pts.length >= 3) rings.push([p.pts.map(q => [q.x / MM_TO_PIXEL, q.y / MM_TO_PIXEL] as [number, number])]);
  }
  if (!rings.length) return [];
  return rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1));
}

const ringArea = (r: Ring) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return a / 2; };

/** Fläche zu einem Körper von z0 bis z1 */
export function extrudeRegion(mp: MultiPolygon, z0: number, z1: number, out: number[]) {
  if (!(z1 - z0 > 1e-4)) return;
  for (const poly of mp) {
    const flat: number[] = [], holes: number[] = [];
    poly.forEach((ring0, ri) => {
      let r = ring0.length > 1 && ring0[0][0] === ring0[ring0.length - 1][0] && ring0[0][1] === ring0[ring0.length - 1][1] ? ring0.slice(0, -1) : ring0.slice();
      if (r.length < 3) return;
      // außen gegen den Uhrzeigersinn, Löcher im Uhrzeigersinn → Wände zeigen immer nach außen
      if ((ringArea(r) > 0) !== (ri === 0)) r = r.reverse();
      if (ri) holes.push(flat.length / 2);
      for (const [x, y] of r) flat.push(x, y);
      for (let i = 0; i < r.length; i++) {
        const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length];
        if (Math.hypot(bx - ax, by - ay) < 1e-9) continue;
        out.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z0, bx, by, z1, ax, ay, z1);
      }
    });
    if (flat.length < 6) continue;
    const tri = earcut(flat, holes.length ? holes : null, 2);
    for (let k = 0; k + 2 < tri.length; k += 3) {
      let [a, b, c] = [tri[k], tri[k + 1], tri[k + 2]];
      const cr = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
      if (Math.abs(cr) < 1e-12) continue;
      if (cr < 0) [b, c] = [c, b];
      out.push(flat[a * 2], flat[a * 2 + 1], z1, flat[b * 2], flat[b * 2 + 1], z1, flat[c * 2], flat[c * 2 + 1], z1);
      out.push(flat[a * 2], flat[a * 2 + 1], z0, flat[c * 2], flat[c * 2 + 1], z0, flat[b * 2], flat[b * 2 + 1], z0);
    }
  }
}

const diff = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => (a.length && b.length ? polygonClipping.difference(a, b) : a);
const inter = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => (a.length && b.length ? polygonClipping.intersection(a, b) : []);
const union = (list: MultiPolygon[]): MultiPolygon => {
  const l = list.filter(m => m.length);
  return l.length > 1 ? polygonClipping.union(l[0], ...l.slice(1)) : l[0] || [];
};

/** Alle Gruppen zu Körpern */
export function buildSolid(parts: SolidPart[]): Shell[] {
  const bodies = parts.filter(p => p.kind === "body" && p.value > 0).map(p => ({ h: p.value, r: regionOf(p.shapes) })).filter(b => b.r.length);
  const recesses = parts.filter(p => p.kind === "recess" && p.value > 0).map(p => ({ d: p.value, r: regionOf(p.shapes) })).filter(b => b.r.length);
  const raises = parts.filter(p => p.kind === "raise" && p.value > 0).map(p => ({ h: p.value, r: regionOf(p.shapes) })).filter(b => b.r.length);
  const shells: Shell[] = [];
  const allRec = union(recesses.map(r => r.r));
  for (const b of bodies) {
    const s: Shell = { kind: "body", tris: [] };
    extrudeRegion(diff(b.r, allRec), 0, b.h, s.tris);
    // Vertiefungen: Stelle niedriger; überlappen sich zwei, zählt die zuerst genannte
    let done: MultiPolygon = [];
    for (const rc of recesses) {
      const here = diff(inter(b.r, rc.r), done);
      done = union([done, rc.r]);
      if (b.h - rc.d > 0.05) extrudeRegion(here, 0, b.h - rc.d, s.tris);
    }
    shells.push(s);
  }
  const allBody = union(bodies.map(b => b.r));
  for (const ra of raises) {
    const s: Shell = { kind: "raise", tris: [] };
    for (const b of bodies) extrudeRegion(inter(ra.r, b.r), 0, b.h + ra.h, s.tris);
    extrudeRegion(diff(ra.r, allBody), 0, ra.h, s.tris);
    shells.push(s);
  }
  return shells.filter(s => s.tris.length);
}

/** Für den Betrachter (Flächen-Normalen, Farbe je Art) */
export function shellMeshes(shells: Shell[]): Mesh[] {
  const color: Record<SolidKind, [number, number, number]> = { body: [0.86, 0.55, 0.22], recess: [0.86, 0.55, 0.22], raise: [0.35, 0.65, 0.95] };
  return shells.map(s => {
    const m: Mesh = { pos: s.tris, nrm: [], color: color[s.kind] };
    for (let i = 0; i < s.tris.length; i += 9) {
      const n = triNormal(s.tris, i);
      m.nrm.push(...n, ...n, ...n);
    }
    return m;
  });
}

function triNormal(t: number[], i: number): [number, number, number] {
  const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2];
  const vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** Binäres STL: 80 Byte Kopf, Anzahl, je Dreieck Normale + 3 Ecken (float32) + 2 Byte */
export function stlBinary(shells: Shell[], header = "CNC Craft STL"): Uint8Array {
  const n = shells.reduce((a, s) => a + s.tris.length / 9, 0);
  const buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf), u8 = new Uint8Array(buf);
  for (let i = 0; i < Math.min(80, header.length); i++) u8[i] = header.charCodeAt(i) & 0x7f;
  dv.setUint32(80, n, true);
  let o = 84;
  for (const s of shells) for (let i = 0; i < s.tris.length; i += 9) {
    const nm = triNormal(s.tris, i);
    for (const v of nm) { dv.setFloat32(o, v, true); o += 4; }
    for (let k = 0; k < 9; k++) { dv.setFloat32(o, s.tris[i + k], true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return u8;
}

/** Größe aller Körper (mm) */
export function shellBounds(shells: Shell[]): { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } | null {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const s of shells) for (let i = 0; i < s.tris.length; i += 3) {
    x0 = Math.min(x0, s.tris[i]); x1 = Math.max(x1, s.tris[i]);
    y0 = Math.min(y0, s.tris[i + 1]); y1 = Math.max(y1, s.tris[i + 1]);
    z0 = Math.min(z0, s.tris[i + 2]); z1 = Math.max(z1, s.tris[i + 2]);
  }
  return isFinite(x0) ? { x0, y0, z0, x1, y1, z1 } : null;
}
