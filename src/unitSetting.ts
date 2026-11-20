/**
 * EINHEIT WÄHLEN: Millimeter oder Zoll
 *
 * - gemerkt unter cnc_craft_unit ("mm" | "in"), Standard mm
 * - Knopf oben rechts (mm / in) und Auswahl im Abschnitt „Arbeitsfläche“
 * - gilt nur für Anzeige und Eingabe: Projektdateien, G-Code und alles, was zur Maschine geht, bleiben in mm
 *   (rechnen: units.ts, Zahlenfelder: unitFields.ts)
 * Nach dem Umschalten melden sich „cnc-unit-changed“ und – weil sich Texte mit Maßen ändern – dieselbe Auffrischung
 * wie beim Sprachwechsel.
 */
import { getUnit, setUnit, type Unit } from "./units";
import { initUnitFields } from "./unitFields";
import { t, currentLanguage } from "./i18n/i18n";

const STORAGE = "cnc_craft_unit";

function read(): Unit {
  try { return localStorage.getItem(STORAGE) === "in" ? "in" : "mm"; } catch { return "mm"; }
}

/** Beim Start, bevor die Oberfläche gebaut wird: gespeicherte Einheit einstellen */
export function initUnits() {
  setUnit(read());
  initUnitFields();
}

export function chooseUnit(u: Unit) {
  if (u === getUnit()) return;
  setUnit(u);
  try { localStorage.setItem(STORAGE, u); } catch { /* egal */ }
  window.dispatchEvent(new CustomEvent("cnc-unit-changed", { detail: u }));
  // Meldungen und Listen mit Maßen neu beschriften (gleicher Weg wie beim Sprachwechsel) und neu zeichnen
  window.dispatchEvent(new CustomEvent("cnc-language-changed", { detail: currentLanguage() }));
  window.dispatchEvent(new Event("cnc-redraw"));
}

/** Knopf oben rechts: zeigt die Einheit, Klick schaltet um */
export function initUnitButton(btn: HTMLElement | null) {
  if (!btn) return;
  const show = () => {
    btn.textContent = getUnit();
    btn.setAttribute("data-tip", t(getUnit() === "in" ? "unit.tipIn" : "unit.tipMm"));
    document.querySelectorAll<HTMLSelectElement>("select.unit-select").forEach(s => { s.value = getUnit(); });
  };
  show();
  btn.addEventListener("click", () => chooseUnit(getUnit() === "in" ? "mm" : "in"));
  window.addEventListener("cnc-unit-changed", show);
  window.addEventListener("cnc-language-changed", show);
  // Auswahl in den Einstellungen (Abschnitt „Arbeitsfläche“)
  document.addEventListener("change", e => {
    const s = e.target as HTMLElement | null;
    if (s instanceof HTMLSelectElement && s.classList.contains("unit-select")) chooseUnit(s.value === "in" ? "in" : "mm");
  });
}
