/**
 * THEMEN-AUSWAHL für die Deko-Generatoren (Anhänger, Steckanhänger, Schattenbox): Auswahlfeld „Thema“ und
 * Auswahllisten, die je nach Thema neu befüllt werden. Die Einträge sind eigene Texte (t()), nichts Fremdes.
 */
import { t } from "../i18n/i18n";
import { THEMES, type Theme } from "../themes";

/** Auswahlfeld „Thema“ (rowClass: "dlg-row" bzw. "prop-row" – je nach Fenster) */
export function themeSelectHtml(id: string, rowClass: "dlg-row" | "prop-row"): string {
  const opts = THEMES.map(th => `<option value="${th}">${t("deco.theme." + th)}</option>`).join("");
  return rowClass === "dlg-row"
    ? `<label class="dlg-row"><span>${t("deco.theme")}</span><select id="${id}" style="width:auto;max-width:190px;">${opts}</select></label>`
    : `<label class="prop-row">${t("deco.theme")}<select id="${id}" class="prop-input" style="width:auto;">${opts}</select></label>`;
}

/** Auswahlliste neu befüllen; der bisherige Wert bleibt, wenn er noch dabei ist, sonst der erste Eintrag */
export function fillSelect(sel: HTMLSelectElement, values: readonly string[], prefix: string, prefer?: string): string {
  const keep = prefer ?? sel.value;
  sel.innerHTML = values.map(v => `<option value="${v}">${t(prefix + v)}</option>`).join("");
  sel.value = values.includes(keep) ? keep : values[0] ?? "";
  return sel.value;
}

export const isTheme = (v: unknown): v is Theme => typeof v === "string" && (THEMES as string[]).includes(v);
