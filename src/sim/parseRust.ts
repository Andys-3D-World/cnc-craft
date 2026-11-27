/**
 * G-CODE LESEN IN RUST (src-tauri/src/gcodesim.rs) – für große Programme in der App
 *
 * Rust rechnet dasselbe wie gcodeParser.ts + motionPlan.ts + simNotes.ts und schickt die Zahlenreihen als Bytes zurück.
 * Im Browser (Vorschau) und in den Tests gibt es kein Rust: dort liest weiter das TypeScript (parseAsync.ts).
 * Schlägt ein Aufruf fehl, bleibt es für diese Sitzung beim TypeScript.
 * Dass beide dasselbe liefern, prüfen tests/gcodeSimRust.test.ts und die Tests in gcodesim.rs mit denselben Fällen.
 */
import type { ParseOptions, SimProgram } from "./gcodeParser";
import type { SimNote } from "./simNotes";

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
let failed = false;

/** Jede Zahl in den Einstellungen muss endlich sein (JSON kennt weder NaN noch Unendlich) */
function finite(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(finite);
  if (v && typeof v === "object") return Object.values(v).every(finite);
  return true;
}

/** Liest Rust? (nur in der App, nur mit sauberen Einstellungen und solange kein Aufruf fehlgeschlagen ist) */
export const rustParseOn = (opts: ParseOptions) => IN_TAURI && !failed && finite(opts);

/** Einstellungen, wie gcodesim.rs sie erwartet (nur Zahlen – ASCII, passt in einen Kopf der Anfrage) */
export function rustParseOpts(opts: ParseOptions): string {
  const m = opts.motion;
  return JSON.stringify({
    rapidRate: opts.rapidRate, defaultFeed: opts.defaultFeed, arcTol: opts.arcTol,
    motion: m && { accel: m.accel, maxRate: m.maxRate, junctionDev: m.junctionDev, arcTol: m.arcTol, lookahead: m.lookahead }
  });
}

/** Bytes aus gcodesim::encode zurück in ein Programm (Aufbau steht dort) */
export function decodeProgram(buf: ArrayBuffer, lines: string[], opts: ParseOptions): SimProgram {
  const head = new Uint32Array(buf, 0, 4);
  const n = head[0], flags = head[1], notesLen = head[2];
  const plain = (flags & 1) !== 0, hasA = (flags & 2) !== 0;
  const size = 104 + n * (8 + 4 * (7 + (plain ? 1 : 0) + (hasA ? 2 : 0)) + 4 + 1) + notesLen;
  if (buf.byteLength !== size) throw new Error("gcodesim: size");
  const s = new Float64Array(buf, 16, 11);
  let off = 104;
  // jede Reihe bekommt ihren eigenen Speicher (wie beim TypeScript-Leser)
  const f64 = () => { const a = new Float64Array(buf.slice(off, off + n * 8)); off += n * 8; return a; };
  const f32 = () => { const a = new Float32Array(buf.slice(off, off + n * 4)); off += n * 4; return a; };
  const t0 = f64();
  const x0 = f32(), y0 = f32(), z0 = f32(), x1 = f32(), y1 = f32(), z1 = f32(), dur = f32();
  const durPlain = plain ? f32() : null;
  const a0 = hasA ? f32() : null, a1 = hasA ? f32() : null;
  const line = new Uint32Array(buf.slice(off, off + n * 4)); off += n * 4;
  const type = new Uint8Array(buf.slice(off, off + n)); off += n;
  const notes: SimNote[] = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off, notesLen)));
  return {
    lines, n,
    ...(notes.length ? { notes } : {}),
    x0, y0, z0, x1, y1, z1, type, line, t0, dur,
    ...(durPlain ? { durPlain, motion: opts.motion } : {}),
    totalTime: s[0], cutLength: s[1], rapidLength: s[2],
    bounds: { minX: s[3], minY: s[4], minZ: s[5], maxX: s[6], maxY: s[7], maxZ: s[8] }, cutMinZ: s[9], cutMaxZ: s[10],
    ...(a0 && a1 ? { a0, a1 } : {})
  };
}

/** In Rust lesen. Wirft bei einem Fehler – der Aufrufer liest dann mit dem TypeScript. */
export async function parseInRust(lines: string[], opts: ParseOptions): Promise<SimProgram> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const text = new TextEncoder().encode(lines.join("\n"));
    const buf = await invoke<ArrayBuffer>("gcodesim_parse", text, { headers: { opts: rustParseOpts(opts) } });
    return decodeProgram(buf, lines, opts);
  } catch (e) {
    failed = true;
    console.warn("gcodesim: Rust did not answer, reading in TypeScript", e);
    throw e;
  }
}
