/**
 * HELL / DUNKEL
 *
 * - <html data-theme="light"> schaltet die hellen Farben in styles.css ein
 * - gemerkt unter cnc_craft_theme ("dark" | "light")
 * - canvasColors(): Farben für die Zeichenfläche (render.ts), die nicht aus CSS kommen
 * Simulation und 3D-Ansicht bleiben dunkel (Bahnen und Material sind dort auf dunklem Grund abgestimmt).
 */
const STORAGE = "cnc_craft_theme";
export type Theme = "dark" | "light";

function read(): Theme {
  try { return localStorage.getItem(STORAGE) === "light" ? "light" : "dark"; } catch { return "dark"; }
}

let current: Theme = read();

function apply() {
  document.documentElement.dataset.theme = current;
}
// Linux (WebKitGTK): Auswahllisten zeichnet sonst GTK selbst – grau und mit abgeschnittenem Text (styles.css: html.os-linux)
if (/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)) document.documentElement.classList.add("os-linux");
apply();

export function currentTheme(): Theme { return current; }
export function isLight(): boolean { return current === "light"; }

export function setTheme(th: Theme) {
  current = th;
  try { localStorage.setItem(STORAGE, th); } catch { /* egal */ }
  apply();
  window.dispatchEvent(new Event("cnc-theme-changed"));
  window.dispatchEvent(new Event("cnc-redraw"));
}

export function canvasColors() {
  return current === "light"
    ? { bg: "#e4e4ea", bed: "#fbfbfd", gridMinor: "rgba(0,0,0,0.06)", gridMajor: "rgba(0,0,0,0.16)", label: "#6a6a78" }
    : { bg: "#101014", bed: "#16161c", gridMinor: "rgba(255,255,255,0.035)", gridMajor: "rgba(255,255,255,0.09)", label: "#6d6d7c" };
}

/** Knopf ☀️/🌙 oben rechts */
export function initThemeButton(btn: HTMLElement | null) {
  if (!btn) return;
  const show = () => { btn.textContent = current === "light" ? "🌙" : "☀️"; };
  show();
  btn.addEventListener("click", () => { setTheme(current === "light" ? "dark" : "light"); show(); });
}
