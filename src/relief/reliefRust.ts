/**
 * RELIEF IN RUST, MIT DEM TYPESCRIPT GEPRÜFT (relief.rs)
 *
 * Für den Vergleich in der App: der Auftrag als Rohdaten (Kopf als JSON, Grauwerte als f32) und eine kurze
 * Zusammenfassung des fertigen Reliefs (Maße, Lage, flach, Prüfsummen über die f32-Bits von Feld und Fläche).
 * Verwendet wird weiter das Relief aus dem TypeScript. Nur Rechnen, läuft auch in den Tests.
 */
import { fieldRange } from "./heightField.ts";
import type { ReliefBuilt, ReliefJob } from "./reliefBuild.ts";

/** FNV-1a, 32 bit, über die Bytes (f32 little-endian) */
export function f32Hash(v: Float32Array): number {
  const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193) >>> 0;
  return h;
}

export function reliefSummary(r: ReliefBuilt) {
  const f = r.field;
  return { nx: f.nx, ny: f.ny, w: f.w, h: f.h, x0: r.x0, y0: r.y0, flat: r.flat, z: f32Hash(f.z), pos: f32Hash(r.pos), low: fieldRange(f) };
}

export function reliefBody(job: ReliefJob): Uint8Array {
  const head = job.kind === "image"
    ? { kind: "image", sw: job.sw, sh: job.sh, image: job.opts }
    : { kind: "vector", loops: job.loops, vector: job.opts };
  const h = new TextEncoder().encode(JSON.stringify(head));
  const gray = job.kind === "image" ? job.gray : new Float32Array(0);
  const out = new Uint8Array(4 + h.length + gray.length * 4);
  new DataView(out.buffer).setUint32(0, h.length, true);
  out.set(h, 4);
  out.set(new Uint8Array(gray.buffer, gray.byteOffset, gray.length * 4), 4 + h.length);
  return out;
}
