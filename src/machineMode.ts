/**
 * MASCHINENART: Fräse, Laser oder Plasma
 *
 * Die Art bestimmt:
 *  - welche Abschnitte rechts sichtbar sind (Fräswerkzeuge / Laser-Ebenen / Plasma-Schnitte)
 *  - wie die Formen gezeichnet werden (Fräserbreite / Ebenen-Farben / Schnittspalt + Einstiche)
 *  - welcher G-Code erzeugt wird (cam.ts / laserCam.ts / plasmaCam.ts)
 *
 * Gespeichert in localStorage und in der Projektdatei. Bei Änderung: Ereignis
 * "cnc-machine-mode-changed" und die CSS-Klasse "mode-mill" / "mode-laser" / "mode-plasma" am <body>.
 */
export type MachineMode = "mill" | "laser" | "plasma";
const MODES: MachineMode[] = ["mill", "laser", "plasma"];

export const MODE_CHANGED = "cnc-machine-mode-changed";
const KEY = "cnc_craft_machine_mode";

let mode: MachineMode = "mill";

export function initMachineMode() {
  try {
    const saved = localStorage.getItem(KEY);
    if (MODES.includes(saved as MachineMode)) mode = saved as MachineMode;
  } catch { /* Standard: Fräse */ }
  applyBodyClass();
}

export function getMachineMode(): MachineMode {
  return mode;
}

export function isLaser(): boolean {
  return mode === "laser";
}

export function isPlasma(): boolean {
  return mode === "plasma";
}

export function setMachineMode(m: MachineMode) {
  if (!MODES.includes(m)) return;
  if (m === mode) return;
  mode = m;
  try { localStorage.setItem(KEY, m); } catch { /* egal */ }
  applyBodyClass();
  window.dispatchEvent(new CustomEvent(MODE_CHANGED, { detail: { mode } }));
  window.dispatchEvent(new Event("cnc-redraw"));
}

function applyBodyClass() {
  for (const m of MODES) document.body.classList.toggle("mode-" + m, mode === m);
}
