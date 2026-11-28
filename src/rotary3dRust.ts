/**
 * DREHACHSE + 3D-MODELL IN RUST, MIT DEM TYPESCRIPT GEPRÜFT (rotary3d.rs)
 *
 * Für den Vergleich in der App: der Auftrag als Rohdaten (Kopf als JSON, dann die f32-Werte von Modell oder
 * Höhenfeldern) und kurze Zusammenfassungen (Anzahl, Prüfsumme über die f32-Bits). Verwendet werden weiter die
 * Bahnen und das Modell aus dem TypeScript. Nur Rechnen, läuft auch in den Tests.
 */
import { f32Hash } from "./relief/reliefRust.ts";
import type { Path3D } from "./cam3d.ts";
import type { CarveResult } from "./view3d/carveSim.ts";

/** Kopf als JSON (4 Byte Länge, little-endian), danach die Werte aller Felder hintereinander */
export function rotaryBody(head: unknown, ...data: Float32Array[]): Uint8Array {
  const h = new TextEncoder().encode(JSON.stringify(head));
  const n = data.reduce((s, d) => s + d.length, 0);
  const out = new Uint8Array(4 + h.length + n * 4);
  new DataView(out.buffer).setUint32(0, h.length, true);
  out.set(h, 4);
  let at = 4 + h.length;
  for (const d of data) { out.set(new Uint8Array(d.buffer, d.byteOffset, d.length * 4), at); at += d.length * 4; }
  return out;
}

export const pathSummary = (paths: Path3D[]) => paths.map(p => ({ kind: p.kind, layer: p.layer, top: p.top, n: p.pts.length, h: f32Hash(p.pts) }));
export const meshSummary = (m: { tris: Float32Array; maxR: number; scale: number }) => ({ tris: f32Hash(m.tris), n: m.tris.length, maxR: m.maxR, scale: m.scale });
export const previewSummary = (p: CarveResult) => ({ nx: p.nx, ny: p.ny, x0: p.x0, y0: p.y0, cell: p.cell, h: f32Hash(p.h), minZ: p.minZ, moves: p.moves });
