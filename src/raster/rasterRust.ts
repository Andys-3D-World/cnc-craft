/**
 * BILDGRAVUR IN RUST RECHNEN (src-tauri/src/imgraster.rs) – in der App
 *
 * Rust rechnet dasselbe wie dither.ts (umrechnen aufs Raster, verbessern, rastern) und schickt das Ergebnis als Bytes
 * zurück. Im Browser (Vorschau) und in den Tests gibt es kein Rust: dort rechnet der Hintergrund-Thread
 * (rasterWorker.ts) bzw. dither.ts. Schlägt ein Aufruf fehl, bleibt es für diese Sitzung beim TypeScript.
 * Dass beide dieselben Punkte liefern, prüfen tests/imgRasterRust.test.ts und die Tests in imgraster.rs.
 */
import type { Adjust, RasterSettings } from "./dither";

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
let failed = false;

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const size = (v: unknown) => Number.isInteger(v) && (v as number) > 0;

/** Auftrag, wie imgraster.rs ihn erwartet. null = so nicht übertragbar (dann rechnet das TypeScript) */
export function rasterJob(sw: number, sh: number, gw: number, gh: number, a: Adjust, r: RasterSettings): string | null {
  if (![sw, sh, gw, gh].every(size)) return null;
  if (![a.black, a.white, a.gamma, a.brightness, a.contrast, a.sharpen, a.denoise].every(num)) return null;
  if (a.local !== undefined && !num(a.local)) return null;
  if (a.curve !== undefined && !(Array.isArray(a.curve) && a.curve.every(p => Array.isArray(p) && p.length >= 2 && p.every(num)))) return null;
  if (!/^[a-z]+$/.test(String(r.method)) || ![r.threshold, r.cell, r.angle].every(num)) return null;
  const adjust = { black: a.black, white: a.white, gamma: a.gamma, brightness: a.brightness, contrast: a.contrast, sharpen: a.sharpen, denoise: a.denoise, invert: !!a.invert, local: a.local, curve: a.curve };
  return JSON.stringify({ sw, sh, gw, gh, adjust, raster: { method: r.method, threshold: r.threshold, cell: r.cell, angle: r.angle } });
}

/** Rechnet Rust? (nur in der App und solange kein Aufruf fehlgeschlagen ist) */
export const rustRasterOn = () => IN_TAURI && !failed;

/** Bytes aus imgraster::encode zurück in „burn“ (Aufbau steht dort) */
export function decodeBurn(buf: ArrayBuffer, gw: number, gh: number): Float32Array {
  const head = new Uint32Array(buf, 0, 4), n = gw * gh, kind = head[2];
  if (head[0] !== gw || head[1] !== gh || buf.byteLength !== 16 + n * (kind ? 4 : 1)) throw new Error("imgraster: size");
  if (kind) return new Float32Array(buf.slice(16));
  return Float32Array.from(new Uint8Array(buf, 16, n));
}

/**
 * In Rust rechnen: base = Graustufen des Quellbilds (sw × sh). Wirft bei einem Fehler – dann rechnet der Aufrufer selbst.
 */
export async function rasterInRust(base: Float32Array, sw: number, sh: number, gw: number, gh: number, a: Adjust, r: RasterSettings): Promise<Float32Array> {
  const job = rasterJob(sw, sh, gw, gh, a, r);
  if (job === null) throw new Error("imgraster: job");
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const body = new Uint8Array(base.buffer, base.byteOffset, base.byteLength);
    const buf = await invoke<ArrayBuffer>("imgraster_run", body, { headers: { job } });
    return decodeBurn(buf, gw, gh);
  } catch (e) {
    failed = true;
    console.warn("imgraster: Rust did not answer, calculating in TypeScript", e);
    throw e;
  }
}
