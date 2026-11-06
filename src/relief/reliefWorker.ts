/** Hintergrund-Thread für das volle Relief-Raster (siehe reliefBuild.ts) */
import { type ReliefJob, buildRelief } from "./reliefBuild.ts";

self.onmessage = (ev: MessageEvent<ReliefJob>) => {
  try {
    const r = buildRelief(ev.data);
    (self as any).postMessage({ ok: true, r }, r ? [r.pos.buffer, r.field.z.buffer] : []);
  } catch (e) {
    (self as any).postMessage({ ok: false, error: String(e) });
  }
};
