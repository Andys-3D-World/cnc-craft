/**
 * SIMULATION MIT DREHACHSE IN RUST, MIT DEM TYPESCRIPT GEPRÜFT (rotarysim.rs)
 *
 * Für den Vergleich in der App: das gelesene Programm als Rohdaten (Kopf als JSON, die Bewegungen als f32, die
 * Startzeiten als f64) und eine kurze Zusammenfassung des gewickelten Programms (Anzahl, Maße, Prüfsummen über die
 * Bits jeder Liste). Angezeigt wird weiter das Ergebnis aus dem TypeScript. Nur Rechnen, läuft auch in den Tests.
 */
import type { SimProgram } from "./gcodeParser.ts";
import type { WrapSimOpts } from "./rotarySim.ts";

/** FNV-1a, 32 bit, über die Bytes (little-endian) einer Liste */
function hb(v: ArrayBufferView): number {
  const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193) >>> 0;
  return h;
}

export function rotarySimSummary(w: SimProgram) {
  const r = w.rotary!;
  const n = w.n, cut = <T extends Float32Array | Uint8Array | Uint32Array | Float64Array | Int16Array>(a: T) => hb(a.subarray(0, n));
  return {
    n, bounds: w.bounds, cutMinZ: w.cutMinZ, cutMaxZ: w.cutMaxZ,
    x0: cut(w.x0), y0: cut(w.y0), z0: cut(w.z0), x1: cut(w.x1), y1: cut(w.y1), z1: cut(w.z1),
    type: cut(w.type), line: cut(w.line), t0: cut(w.t0), dur: cut(w.dur), ...(w.durPlain ? { durPlain: cut(w.durPlain) } : {}),
    rotary: {
      R: r.R, flat: r.flat, aMin: r.aMin, aMax: r.aMax, along: r.along, depth: hb(r.depth),
      ...(r.theta ? { theta: hb(r.theta) } : {}),
      ...(r.raster ? { raster: { x0: hb(r.raster.x0), y0: hb(r.raster.y0), z0: hb(r.raster.z0), x1: hb(r.raster.x1), y1: hb(r.raster.y1), z1: hb(r.raster.z1), face: r.raster.face ? hb(r.raster.face) : null } } : {})
    }
  };
}

/** Rohdaten für rotary_sim_check; null = zu groß für den Vergleich (Zeilennummern ab 2^24 passen nicht in f32) */
export function rotarySimBody(p: SimProgram, R: number, mode: "surface" | "a", o: WrapSimOpts, maxMoves = 300_000): Uint8Array | null {
  const n = p.n;
  if (n > maxMoves) return null;
  for (let i = 0; i < n; i++) if (p.line[i] >= 1 << 24) return null;
  const hasA = !!(p.a0 && p.a1), hasPlain = !!p.durPlain;
  const head = { r: R, mode, o: { aScale: o.aScale, along: o.along, reverse: o.reverse, stock: o.stock }, n, hasA, hasPlain, bounds: p.bounds, cutMinZ: p.cutMinZ, cutMaxZ: p.cutMaxZ };
  const h = new TextEncoder().encode(JSON.stringify(head));
  const f32 = [p.x0, p.y0, p.z0, p.x1, p.y1, p.z1, ...(hasA ? [p.a0!, p.a1!] : []), p.dur, ...(hasPlain ? [p.durPlain!] : []),
    Float32Array.from(p.type.subarray(0, n)), Float32Array.from(p.line.subarray(0, n))].map(a => a.subarray(0, n));
  const out = new Uint8Array(4 + h.length + n * (f32.length * 4 + 8));
  new DataView(out.buffer).setUint32(0, h.length, true);
  out.set(h, 4);
  let at = 4 + h.length;
  for (const a of f32) { out.set(new Uint8Array(Float32Array.from(a).buffer), at); at += n * 4; }
  out.set(new Uint8Array(Float64Array.from(p.t0.subarray(0, n)).buffer), at);
  return out;
}
