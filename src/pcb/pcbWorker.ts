/** Hintergrund-Thread für die Isolationsbahnen (field.ts) */
import { isolate, type IsoJob } from "./field.ts";

self.onmessage = (ev: MessageEvent<IsoJob>) => {
  try { (self as any).postMessage({ ok: true, r: isolate(ev.data) }); }
  catch (e) { (self as any).postMessage({ ok: false, error: String(e instanceof Error ? e.message : e) }); }
};
