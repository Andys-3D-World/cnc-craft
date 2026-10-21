/**
 * GEMEINSAMER ZUSTAND DES ZEICHEN-EDITORS
 *
 * - app():     der Haupt-Zustand aus main.ts (Formen, Auswahl, Zoom)
 * - options:   Einstellungen der Werkzeuge (Fang, Raster, Ecken-Radius, Polygon-Ecken, Werkzeug-Ansicht)
 * - Umrechnung Bildschirm <-> Welt
 */
import { MM_TO_PIXEL } from "../shapeTransform";

export type ToolName = "select" | "pan" | "line" | "rect" | "ellipse" | "polygon" | "arc" | "text" | "measure" | "tab" | "node" | "pen";

export function app(): any {
  return (window as any).cncState;
}

export const options = {
  snapObjects: true,   // an Punkten/Mittelpunkten einrasten
  snapGrid: false,     // am Raster einrasten
  gridStep: 1,         // Raster-Fang in mm
  rectRadius: 0,       // Eckenradius für Rechtecke in mm
  polygonSides: 6,     // Ecken für das Polygon-Werkzeug
  showTools: true      // Fräserbreite + Werkzeug-Marken auf der Zeichenfläche zeigen
};

const OPTIONS_KEY = "cnc_craft_editor_options";

export function loadOptions() {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (raw) Object.assign(options, JSON.parse(raw));
  } catch { /* egal - Standardwerte bleiben */ }
}

export function saveOptions() {
  try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(options)); } catch { /* egal */ }
}

export function bedSizeMm(): { w: number; h: number } {
  const wIn = document.getElementById("bed-w") as HTMLInputElement | null;
  const hIn = document.getElementById("bed-h") as HTMLInputElement | null;
  return {
    w: wIn ? parseFloat(wIn.value) || 300 : 300,
    h: hIn ? parseFloat(hIn.value) || 300 : 300
  };
}

/** Welt-Pixel -> Bildschirm-Pixel im Canvas */
export function toScreen(x: number, y: number): { x: number; y: number } {
  const st = app();
  const bedH = bedSizeMm().h * MM_TO_PIXEL;
  return { x: x * st.scale + st.offsetX, y: (bedH - y) * st.scale + st.offsetY };
}

/** Bildschirm-Pixel im Canvas -> Welt-Pixel */
export function toWorld(sx: number, sy: number): { x: number; y: number } {
  const st = app();
  const bedH = bedSizeMm().h * MM_TO_PIXEL;
  return { x: (sx - st.offsetX) / st.scale, y: bedH - (sy - st.offsetY) / st.scale };
}

/** Ein paar Bildschirm-Pixel in Welt-Pixel umrechnen (für Fang- und Klick-Toleranzen) */
export function screenDist(px: number): number {
  return px / app().scale;
}

export function fmtMm(px: number, digits = 2): string {
  return (px / MM_TO_PIXEL).toFixed(digits);
}
