/**
 * RECHTES PANEL: BREITE (UND KONSOLEN-HÖHE) PER MAUS ÄNDERN
 *
 *   - Am linken Rand des rechten Panels (CAM und Simulation) sitzt ein schmaler Griff.
 *     Ziehen = Breite ändern, Doppelklick = zurück auf Standardbreite.
 *   - Die Breite wird pro Bereich gespeichert (localStorage) und beim nächsten Start wieder benutzt.
 *   - Technisch: Die Breite steht in der CSS-Variable --rp-w am Layout-Container
 *     (styles.css: grid-template-columns ... var(--rp-w, Standard)).
 *     Die Zeichenfläche passt sich über ihren ResizeObserver von selbst an.
 */
import { t } from "../i18n/i18n";

const MIN_W = 320;            // schmaler wird es unübersichtlich
const MIN_CANVAS = 360;       // so viel Platz bleibt mindestens für die Zeichenfläche
const KEY = "cnc_craft_panel_w_";

function load(key: string): number {
  try { return parseFloat(localStorage.getItem(KEY + key) || "") || 0; } catch { return 0; }
}
function save(key: string, w: number) {
  try {
    if (w > 0) localStorage.setItem(KEY + key, String(Math.round(w)));
    else localStorage.removeItem(KEY + key);
  } catch { /* egal */ }
}

/** größte erlaubte Breite: Zeichenfläche (plus linke Werkzeugleiste) muss noch Platz haben */
function maxWidth(layout: HTMLElement, panel: HTMLElement): number {
  // feste Spalten links (z. B. die Werkzeugleiste im CAM-Bereich) mitzählen
  let fixed = 0;
  for (const el of Array.from(layout.children) as HTMLElement[]) {
    if (el !== panel && el.classList.contains("tool-strip")) fixed += el.getBoundingClientRect().width;
  }
  return Math.max(MIN_W, layout.clientWidth - fixed - MIN_CANVAS);
}

function apply(layout: HTMLElement, panel: HTMLElement, w: number) {
  if (w > 0) {
    const max = maxWidth(layout, panel);
    layout.style.setProperty("--rp-w", `${Math.round(Math.min(Math.max(w, MIN_W), max))}px`);
  } else {
    layout.style.removeProperty("--rp-w");
  }
  window.dispatchEvent(new Event("resize")); // Zeichenflächen neu einpassen
}

/**
 * Griff an das Panel hängen.
 * @param layout  Grid-Container (.main-content bzw. .sim-layout)
 * @param panel   das rechte Panel darin
 * @param key     Name zum Speichern ("cam", "sim")
 */
export function attachPanelResizer(layout: HTMLElement | null, panel: HTMLElement | null, key: string) {
  if (!layout || !panel || panel.querySelector(":scope > .panel-resizer")) return;
  panel.classList.add("has-resizer");
  const grip = document.createElement("div");
  grip.className = "panel-resizer";
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "vertical");
  const setTip = () => grip.title = t("panel.resizeTip");
  setTip();
  window.addEventListener("cnc-language-changed", setTip);
  panel.prepend(grip);

  let saved = load(key);
  if (saved) apply(layout, panel, saved);

  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    document.body.classList.add("panel-resizing");
    grip.classList.add("active");
    const move = (ev: PointerEvent) => {
      // Griff links am Panel: nach links ziehen = breiter
      saved = startW + (startX - ev.clientX);
      apply(layout, panel, saved);
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      document.body.classList.remove("panel-resizing");
      grip.classList.remove("active");
      saved = panel.getBoundingClientRect().width;
      save(key, saved);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });

  grip.addEventListener("dblclick", () => {
    saved = 0;
    save(key, 0);
    apply(layout, panel, 0);
  });

  // Fenster kleiner gezogen: gespeicherte Breite wieder in die Grenzen holen
  window.addEventListener("resize", () => {
    if (!saved || document.body.classList.contains("panel-resizing")) return;
    const cur = parseFloat(layout.style.getPropertyValue("--rp-w")) || 0;
    const want = Math.min(Math.max(saved, MIN_W), maxWidth(layout, panel));
    if (Math.abs(cur - want) > 1) layout.style.setProperty("--rp-w", `${Math.round(want)}px`);
  });
}

/**
 * KONSOLE: HÖHE PER MAUS ÄNDERN
 * Griff an der Oberkante der Konsole im rechten Panel. Ziehen = Höhe ändern,
 * Doppelklick = Standardhöhe. Die Höhe wird gespeichert.
 */
const CON_MIN = 90;            // Kopfzeile + ein paar Zeilen + Eingabe
const PANEL_KEEP = 180;        // so viel bleibt oben mindestens für die Einstellungen
const CON_KEY = "cnc_craft_console_h";

export function attachConsoleResizer(con: HTMLElement | null) {
  if (!con || con.querySelector(":scope > .console-resizer")) return;
  const panel = con.parentElement as HTMLElement | null;
  if (!panel) return;
  const grip = document.createElement("div");
  grip.className = "console-resizer";
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "horizontal");
  const setTip = () => grip.title = t("panel.consoleResizeTip");
  setTip();
  window.addEventListener("cnc-language-changed", setTip);
  con.prepend(grip);

  let saved = 0;
  try { saved = parseFloat(localStorage.getItem(CON_KEY) || "") || 0; } catch { /* egal */ }
  const clampH = (h: number) => Math.round(Math.min(Math.max(h, CON_MIN), Math.max(CON_MIN, panel.clientHeight - PANEL_KEEP)));
  const apply = (h: number) => { if (h > 0) con.style.height = clampH(h) + "px"; else con.style.removeProperty("height"); };
  if (saved) apply(saved);

  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || con.classList.contains("collapsed")) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = con.getBoundingClientRect().height;
    document.body.classList.add("panel-resizing-v");
    grip.classList.add("active");
    const move = (ev: PointerEvent) => { saved = startH + (startY - ev.clientY); apply(saved); };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      document.body.classList.remove("panel-resizing-v");
      grip.classList.remove("active");
      saved = con.getBoundingClientRect().height;
      try { localStorage.setItem(CON_KEY, String(Math.round(saved))); } catch { /* egal */ }
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });

  grip.addEventListener("dblclick", () => {
    saved = 0;
    try { localStorage.removeItem(CON_KEY); } catch { /* egal */ }
    apply(0);
  });

  // Fenster niedriger gezogen: gespeicherte Höhe in die Grenzen holen
  window.addEventListener("resize", () => { if (saved) apply(saved); });
}
