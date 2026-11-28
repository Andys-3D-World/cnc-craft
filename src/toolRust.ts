/**
 * WERKZEUG-BILDER AUS RUST (src-tauri/src/toolmesh.rs)
 *
 * In der App rechnet Rust die Form der Fräser (Spannuten) und die Bilder für die Bibliothek. Die Antwort kommt
 * einen Augenblick später: bis dahin heißt das Ergebnis "wait", danach wird `ready` gerufen und neu gezeichnet.
 * Im Browser (Vorschau) und in den Tests gibt es kein Rust – dann kommt null und es rechnet dieselbe Rechnung
 * in TypeScript (sim/toolMesh.ts, toolRender.ts). Schlägt ein Aufruf fehl, bleibt es für diese Sitzung bei TypeScript.
 */
import type { ToolGeom } from "./toolGraphics";

type Pt = [number, number];
export type Wait = "wait";
const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
let failed = false;

/** Rechnet Rust? (nur in der App, und nur solange kein Aufruf fehlgeschlagen ist) */
export const rustOn = () => IN_TAURI && !failed;
export const rustFailed = () => { failed = true; };

async function call(cmd: string, job: unknown): Promise<ArrayBuffer> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ArrayBuffer>(cmd, { job });
}
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** nur die Angaben, die das Bild braucht (keine Namen, Notizen …) */
export const toolJob = (tl: ToolGeom | null) => tl ? { type: tl.type, diameter: num(tl.diameter), flutes: num(tl.flutes), helix: tl.helix ?? null, coating: tl.coating ?? null } : null;

export interface HolderJob { R: number; shankR: number; fluteLen: number; stickout: number; holderR: number; holderH: number; spindleR: number; spindleH: number }
export interface MillMesh { solid: Float32Array; ghost: Float32Array }
const mills = new Map<string, MillMesh | Wait>();

/** Fräser + Schaft + Spannmutter + Spindelnase für die Simulation */
export function rustMillMesh(tl: ToolGeom | null, hd: HolderJob, outline: Pt[], ready: () => void): MillMesh | Wait | null {
  if (!rustOn()) return null;
  const job = { tool: toolJob(tl), holder: { r: hd.R, shankR: hd.shankR, fluteLen: hd.fluteLen, stickout: hd.stickout, holderR: hd.holderR, holderH: hd.holderH, spindleR: hd.spindleR, spindleH: hd.spindleH }, outline };
  const key = JSON.stringify(job), hit = mills.get(key);
  if (hit) return hit;
  if (mills.size > 60) mills.clear();
  mills.set(key, "wait");
  call("toolmesh_mill", job).then(buf => {
    const n = new Uint32Array(buf, 0, 1)[0], all = new Float32Array(buf, 4);
    mills.set(key, { solid: all.slice(0, n), ghost: all.slice(n) });
  }).catch(() => { failed = true; mills.delete(key); }).then(ready);
  return "wait";
}

export interface LookJob { flutes: number; core: number; rate: number; split: number }
const cutters = new Map<string, Float32Array | Wait>();

/** Nur der Schneidenteil (Bohrer an der Drehbank), Farbe weiß – je Ecke 10 Zahlen wie cutterMesh */
export function rustCutter(outline: Pt[], look: LookJob, ready: () => void): Float32Array | Wait | null {
  if (!rustOn()) return null;
  const job = { outline, look: { flutes: look.flutes, core: look.core, rate: look.rate, split: Number.isFinite(look.split) ? look.split : null } };
  const key = JSON.stringify(job), hit = cutters.get(key);
  if (hit) return hit;
  if (cutters.size > 60) cutters.clear();
  cutters.set(key, "wait");
  call("toolmesh_cutter", job).then(buf => { cutters.set(key, new Float32Array(buf)); })
    .catch(() => { failed = true; cutters.delete(key); }).then(ready);
  return "wait";
}

export interface PictureJob { tool: ReturnType<typeof toolJob>; cut: Pt[]; rest: Pt[]; ring: [number, number, number] | null; view: "side" | "end"; frame: [number, number, number, number]; w: number; h: number }

/** Bild für die Bibliothek: RGBA-Bytes, w × h */
export async function rustPicture(job: PictureJob): Promise<Uint8ClampedArray> {
  const px = new Uint8ClampedArray(await call("toolmesh_picture", job));
  if (px.length !== job.w * job.h * 4) throw new Error("picture size");
  return px;
}
