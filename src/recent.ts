/**
 * ZULETZT BENUTZTE PROJEKTE (Oberfläche) – Liste und Freigabe führt der Rust-Teil (src-tauri/src/recent.rs).
 * Hier: nach dem Öffnen/Speichern merken, mit einem kleinen Bild der Zeichnung.
 */
import { invoke } from "@tauri-apps/api/core";
import { allShapes } from "./editor/beds";
import { shapeToPaths, shapeBounds } from "./shapeTransform";
import { state } from "./main";

export interface RecentItem { path: string; name: string; folder: string; used: number; thumb: string; exists: boolean }

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Kleines Bild der Zeichnung (aktuelles Bett, sonst alle); "" = nichts zu zeichnen */
export function drawThumb(shapes: any[], w = 240, h = 150): string {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const list = shapes.filter(s => !s.keepOut).slice(0, 4000);
  for (const s of list) { const b = shapeBounds(s); if (b) { x0 = Math.min(x0, b.minX); y0 = Math.min(y0, b.minY); x1 = Math.max(x1, b.maxX); y1 = Math.max(y1, b.maxY); } }
  if (!(x1 > x0 || y1 > y0)) return "";
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#16161c"; ctx.fillRect(0, 0, w, h);
  const k = Math.min((w - 16) / Math.max(1e-6, x1 - x0), (h - 16) / Math.max(1e-6, y1 - y0)), ox = w / 2 - (x0 + x1) / 2 * k, oy = h / 2 + (y0 + y1) / 2 * k;
  ctx.strokeStyle = "#34d17b"; ctx.lineWidth = 1.2;
  let pts = 0;
  ctx.beginPath();
  for (const s of list) {
    if (pts > 40000) break;
    let paths: { pts: { x: number; y: number }[]; closed: boolean }[] = [];
    try { paths = shapeToPaths(s); } catch { continue; }
    for (const p of paths) { p.pts.forEach((q, i) => (i ? ctx.lineTo(q.x * k + ox, oy - q.y * k) : ctx.moveTo(q.x * k + ox, oy - q.y * k))); if (p.closed) ctx.closePath(); pts += p.pts.length; }
  }
  ctx.stroke();
  return cv.toDataURL("image/jpeg", 0.75);
}

/** Nach Öffnen/Speichern merken (im Hintergrund; geht es nicht, fehlt nur der Eintrag) */
export function noteRecent(path: string) {
  if (!IN_TAURI) return;
  setTimeout(() => {
    let thumb = "";
    try { thumb = drawThumb(state.shapes.length ? state.shapes : allShapes()); } catch { /* ohne Bild */ }
    invoke("recent_add", { path, thumb }).catch(() => undefined);
  }, 300);
}

export async function recentList(): Promise<RecentItem[]> {
  if (!IN_TAURI) return [];
  try { const l = await invoke<RecentItem[]>("recent_list"); return Array.isArray(l) ? l : []; } catch { return []; }
}
/** Datei wieder freigeben; false = nicht (mehr) möglich */
export async function recentAllow(path: string): Promise<boolean> {
  try { await invoke("recent_open", { path }); return true; } catch { return false; }
}
export async function recentRemove(path: string | null) { try { await invoke("recent_remove", { path }); } catch { /* egal */ } }
