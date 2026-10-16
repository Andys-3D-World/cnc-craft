/**
 * AUFTRAG-WERKZEUGE (Reiter „Maschine“ und „Laser“)
 *
 *  - ▢ Rahmen abfahren: fährt mit ausgeschaltetem Laser einmal um den Auftrag herum,
 *    damit man sieht, ob er aufs Material passt (wie „Frame“ in LightBurn).
 *    Nimmt den geladenen Job, sonst die aktuelle Zeichnung.
 *    GRBL: G0-Fahrten in Werkstück-Koordinaten. Ruida: Maschine fährt die Ecken nacheinander an.
 *  - 💾 .rd speichern: Auftrag als Ruida-Datei (für den USB-Stick am Laser, RDWorks, LightBurn)
 */
import { save } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n/i18n";
import { machine, canCommand, sendAndWait, exportRd } from "../machine";
import { streamState } from "../machineStream";
import { generateGcode, lastGcodeWarnings } from "../cam";
import { state } from "../main";

export interface Bounds { x0: number; y0: number; x1: number; y1: number }

/**
 * Bereich, in dem wirklich gearbeitet wird (Laser an bzw. Vorschub-Fahrten).
 * Bögen: Mittelpunkt ± Radius (etwas großzügig – für einen Rahmen genau richtig).
 */
export function jobBounds(lines: string[], laser = true): Bounds | null {
  let x = 0, y = 0, abs = true, k = 1, motion = 0, on = false, s = 0;
  let b: Bounds | null = null;
  const add = (px: number, py: number) => {
    if (!b) b = { x0: px, y0: py, x1: px, y1: py };
    else { b.x0 = Math.min(b.x0, px); b.y0 = Math.min(b.y0, py); b.x1 = Math.max(b.x1, px); b.y1 = Math.max(b.y1, py); }
  };
  for (const raw of lines) {
    const line = raw.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").toUpperCase();
    if (!line.trim() || line.trim().startsWith("$")) continue;
    const w: Record<string, number> = {};
    const gs: number[] = [];
    for (const m of line.matchAll(/([A-Z])\s*([-+]?\d*\.?\d+)/g)) {
      const v = parseFloat(m[2]);
      if (m[1] === "G") gs.push(v); else w[m[1]] = v;
    }
    for (const g of gs) {
      if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
      else if (g === 90) abs = true;
      else if (g === 91) abs = false;
      else if (g === 20) k = 25.4;
      else if (g === 21) k = 1;
    }
    if ("M" in w) { if (w.M === 3 || w.M === 4) on = true; else if (w.M === 5) on = false; }
    if ("S" in w) s = w.S;
    if (gs.some(g => g === 4 || g === 10 || g === 92 || g === 28 || g === 53)) continue;
    if (!("X" in w) && !("Y" in w)) continue;
    const tx = "X" in w ? (abs ? w.X * k : x + w.X * k) : x;
    const ty = "Y" in w ? (abs ? w.Y * k : y + w.Y * k) : y;
    const working = motion !== 0 && (!laser || (on && s > 0));
    if (working) {
      add(x, y); add(tx, ty);
      if ((motion === 2 || motion === 3) && ("I" in w || "J" in w)) {
        const cx = x + (w.I || 0) * k, cy = y + (w.J || 0) * k;
        const r = Math.hypot(x - cx, y - cy);
        add(cx - r, cy - r); add(cx + r, cy + r);
      }
    }
    x = tx; y = ty;
  }
  return b;
}

function currentLines(): { lines: string[]; label: string } | null {
  if (streamState.loadedLines.length) return { lines: streamState.loadedLines, label: streamState.label };
  const g = generateGcode(state.shapes);
  return g ? { lines: g.split("\n"), label: t("sim.currentDesign") } : null;
}

const r2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

export async function runFrame(log: (s: string) => void) {
  if (!machine.connected) { log(t("conn.connectFirst")); return; }
  if (!canCommand()) { log(t("m.why.job running")); return; }
  const job = currentLines();
  if (!job) { log(t("gcw.noObjects")); return; }
  const b = jobBounds(job.lines, true);
  if (!b) { log(t("frame.empty")); return; }
  log(t("frame.start", { w: r2(b.x1 - b.x0), h: r2(b.y1 - b.y0), label: job.label }));
  const corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1], [b.x0, b.y0]];
  if (machine.protocol === "grbl") await sendAndWait("M5", 4000, true);
  for (const [px, py] of corners) {
    const a = await sendAndWait(`G90 G0 X${r2(px)} Y${r2(py)}`, machine.protocol === "ruida" || machine.protocol === "k40" ? 40000 : 8000, true);
    if (!a.ok) { log(t("frame.failed")); return; }
  }
  log(t("frame.done"));
}

export async function saveRdFile(log: (s: string) => void) {
  const job = currentLines();
  if (!job) { log(t("gcw.noObjects")); return; }
  if (!streamState.loadedLines.length) lastGcodeWarnings.forEach(w => log(`${t("log.warning")} ${w}`));
  try {
    const path = await save({ title: t("rd.save"), defaultPath: "cnc-craft.rd", filters: [{ name: "Ruida (.rd)", extensions: ["rd"] }] });
    if (!path) return;
    const info = await exportRd(job.lines, path);
    log(t("rd.saved", { p: path, parts: info.parts, w: r2(info.w), h: r2(info.h) }));
  } catch (e) {
    const k = "m.why." + String(e);
    log(t("rd.failed", { e: t(k) !== k ? t(k) : String(e) }));
  }
}

export function initJobTools(log: (s: string) => void) {
  document.getElementById("btn-job-frame")?.addEventListener("click", () => runFrame(log));
  document.getElementById("btn-save-rd")?.addEventListener("click", () => saveRdFile(log));
}
