/**
 * X/Y ANTASTEN: AUFRUFE AN DIE MASCHINE AUFZEICHNEN (für den Vergleich mit Rust, xyprobe.rs)
 *
 * Reicht jeden Aufruf unverändert an die echte Verbindung weiter und merkt sich, was zurückkam. Danach spielt Rust den
 * Ablauf mit genau diesen Antworten nach und prüft, dass es dieselben Fahrten geschickt hätte. Ändert nichts an der Fahrt.
 */
import type { XYIO, XYState } from "./xyProbe.ts";

export type XYCall =
  | { c: "jog"; dx: number; dy: number; feed: number; r?: boolean; err?: true }
  | { c: "status"; r?: XYState | null; err?: true }
  | { c: "cancel"; err?: true }
  | { c: "aborted"; r: boolean }
  | { c: "now"; r: number };

export function recordXY(io: XYIO): { io: XYIO; log: XYCall[] } {
  const log: XYCall[] = [];
  const call = async <T,>(e: XYCall, p: () => Promise<T>, keep: (r: T) => void): Promise<T> => {
    log.push(e);
    try { const r = await p(); keep(r); return r; }
    catch (err) { (e as { err?: true }).err = true; throw err; }
  };
  return {
    log,
    io: {
      jog: (dx, dy, feed) => { const e = { c: "jog" as const, dx, dy, feed } as Extract<XYCall, { c: "jog" }>; return call(e, () => io.jog(dx, dy, feed), r => { e.r = r; }); },
      status: () => { const e = { c: "status" as const } as Extract<XYCall, { c: "status" }>; return call(e, () => io.status(), r => { e.r = r ? { x: r.x, y: r.y, contact: r.contact, state: r.state } : null; }); },
      cancel: () => call({ c: "cancel" }, () => io.cancel(), () => {}),
      aborted: () => { const r = io.aborted(); log.push({ c: "aborted", r }); return r; },
      now: () => { const r = io.now(); log.push({ c: "now", r }); return r; }
    }
  };
}
