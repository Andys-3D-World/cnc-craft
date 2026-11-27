/**
 * FRÄSERGEBNIS IN RUST RECHNEN (src-tauri/src/carvesim.rs) – in der App
 *
 * Rust rechnet dasselbe wie carveHere() in carveSim.ts und schickt das Höhenraster als Bytes zurück.
 * Im Browser (Vorschau) und in den Tests gibt es kein Rust: dort rechnet das TypeScript.
 * Schlägt ein Aufruf fehl, bleibt es für diese Sitzung beim TypeScript.
 */
import type { CarveResult } from "./carveSim.ts";
import type { ToolGeom } from "../toolGraphics.ts";

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
let failed = false;
let count = 0;

/** Nur was die Form des Fräsers bestimmt (keine Namen, Notizen …) */
const shape = (t: ToolGeom | null) => t ? { type: t.type, diameter: t.diameter, angle: t.angle, tipDia: t.tipDia, cornerR: t.cornerR } : null;
const numberOk = (v: unknown) => v === undefined || v === null || (typeof v === "number" && Number.isFinite(v));

/** Auftrag, wie carvesim.rs ihn erwartet. null = so nicht übertragbar (dann rechnet das TypeScript) */
export function carveJob(tools: (ToolGeom | null)[], maxCells: number): string | null {
  const list = tools.map(shape);
  for (const t of list) {
    if (!t) continue;
    if (!(t.type === undefined || /^[a-z]+$/i.test(String(t.type)))) return null;
    if (![t.diameter, t.angle, t.tipDia, t.cornerR].every(numberOk)) return null;
  }
  if (!Number.isFinite(maxCells)) return null;
  return JSON.stringify({ tools: list, maxCells });
}

/** Rechnet Rust? (nur in der App, nur mit sauberen Angaben und solange kein Aufruf fehlgeschlagen ist) */
export const rustCarveOn = (tools: (ToolGeom | null)[], maxCells: number) => IN_TAURI && !failed && carveJob(tools, maxCells) !== null;

/** Bytes aus carvesim::encode zurück in das Ergebnis; leer = nichts gefräst */
export function decodeCarve(buf: ArrayBuffer): CarveResult | null {
  if (buf.byteLength === 0) return null;
  const head = new Uint32Array(buf, 0, 4), s = new Float64Array(buf, 16, 4);
  const nx = head[0], ny = head[1];
  if (buf.byteLength !== 48 + nx * ny * 4) throw new Error("carvesim: size");
  return { nx, ny, x0: s[0], y0: s[1], cell: s[2], h: new Float32Array(buf.slice(48)), minZ: s[3], moves: head[2] };
}

/** In Rust rechnen. null = abgebrochen oder nichts gefräst. Wirft bei einem Fehler – dann rechnet der Aufrufer selbst. */
export async function carveInRust(lines: string[], tools: (ToolGeom | null)[], onProgress: (f: number) => boolean, maxCells: number): Promise<CarveResult | null> {
  const job = carveJob(tools, maxCells);
  if (job === null) throw new Error("carvesim: job");
  // Kennung, die auch nach einem Neuladen des Fensters nicht noch einmal vorkommt
  const id = Date.now() * 1000 + (count++ % 1000);
  let cancelled = false;
  let unlisten: (() => void) | null = null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    unlisten = await listen<{ id: number; p: number }>("carvesim-progress", ev => {
      if (ev.payload.id !== id || cancelled) return;
      if (!onProgress(ev.payload.p)) {
        cancelled = true;
        invoke("carvesim_cancel", { id }).catch(() => { /* dann läuft die Rechnung zu Ende, das Ergebnis wird verworfen */ });
      }
    });
    const text = new TextEncoder().encode(lines.join("\n"));
    const buf = await invoke<ArrayBuffer>("carvesim_run", text, { headers: { job, id: String(id) } });
    return cancelled ? null : decodeCarve(buf);
  } catch (e) {
    if (cancelled) return null;
    failed = true;
    console.warn("carvesim: Rust did not answer, calculating in TypeScript", e);
    throw e;
  } finally {
    unlisten?.();
  }
}
