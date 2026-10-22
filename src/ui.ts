/**
 * AUF-/ZUKLAPPBARE ABSCHNITTE: Klick auf die Überschrift (.menu-trigger) klappt den Abschnitt.
 * Der Zustand wird je Abschnitt gemerkt (Schlüssel = erster Sprach-Schlüssel der Überschrift).
 * Selten gebrauchte Abschnitte starten zugeklappt. Zugeklappt = Klasse .collapsed am Abschnitt (siehe styles.css) –
 * keine feste Höchsthöhe mehr, lange Abschnitte werden also nicht abgeschnitten.
 */
const KEY = "cnc_craft_sections";
/** zu Beginn zugeklappt, bis man sie einmal öffnet */
const START_CLOSED = new Set(["rp.origin", "rp.workArea", "rot.title", "stock.title", "pr.title"]);

let state: Record<string, boolean> = {};   // true = offen
try { state = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { state = {}; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* egal */ } };

function sectionKey(trigger: HTMLElement): string {
  return trigger.querySelector<HTMLElement>("[data-i18n]")?.dataset.i18n || trigger.textContent?.trim() || "";
}

/** Abschnitt (oder ohne Abschnitt: das Element nach der Überschrift) zeigen/verstecken */
function apply(trigger: HTMLElement, open: boolean) {
  const section = trigger.closest<HTMLElement>(".menu-section-unified");
  if (section) section.classList.toggle("collapsed", !open);
  else { const body = trigger.nextElementSibling as HTMLElement | null; if (body) body.style.display = open ? "" : "none"; }
  const arrow = trigger.querySelector<HTMLElement>(".arrow-indicator");
  if (arrow) arrow.style.transform = open ? "rotate(0deg)" : "rotate(-90deg)";
  trigger.dataset.open = open ? "1" : "0";
}

/** Abschnitt per Programm auf-/zuklappen (z. B. „Verbindung“ nach dem Verbinden). remember = Zustand merken */
export function setSectionOpen(key: string, open: boolean, remember = false) {
  document.querySelectorAll<HTMLElement>(".menu-trigger").forEach(tr => {
    if (sectionKey(tr) !== key) return;
    apply(tr, open);
    if (remember) { state[key] = open; save(); }
  });
}

export function initCollapsibleMenus() {
  document.querySelectorAll<HTMLElement>(".menu-trigger").forEach(trigger => {
    if (trigger.querySelector(".arrow-indicator")) return;
    trigger.style.cursor = "pointer";
    trigger.style.display = "flex";
    trigger.style.alignItems = "center";

    const arrow = document.createElement("span");
    arrow.className = "arrow-indicator";
    arrow.textContent = " ▾";
    arrow.style.fontSize = "0.75rem";
    arrow.style.transition = "transform 0.2s";
    trigger.appendChild(arrow);

    const key = sectionKey(trigger);
    apply(trigger, state[key] ?? !START_CLOSED.has(key));
    trigger.addEventListener("click", e => {
      e.preventDefault();
      const open = trigger.dataset.open !== "1";
      apply(trigger, open);
      state[key] = open;
      save();
    });
  });
}
