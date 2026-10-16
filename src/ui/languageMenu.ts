/**
 * SPRACHAUSWAHL oben rechts in der Titelleiste.
 *
 * - alle eingebauten Sprachen + selbst geladene Sprachpakete
 * - "Sprachpaket laden…": eine JSON-Datei mit Übersetzungen hinzufügen
 * - "Übersetzungs-Vorlage speichern…": Datei für Übersetzer (alle Texte der aktuellen Sprache,
 *   fehlende auf Englisch) – ausfüllen und wieder laden bzw. ans Projekt schicken
 */
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import {
  t, availableLanguages, currentLanguage, setLanguage, addCustomLanguage, translationTemplate
} from "../i18n/i18n";
import { icon } from "./icons";

const LOAD = "__load__";
const TEMPLATE = "__template__";

export function initLanguageMenu(container: HTMLElement | null, log: (s: string) => void) {
  if (!container) return;

  const render = () => {
    const langs = availableLanguages();
    container.innerHTML = `
      <span class="lang-ico">${icon("globe", 16)}</span>
      <select id="lang-select" data-tip="${t("lang.tip")}">
        ${langs.map(l => `<option value="${l.code}" ${l.code === currentLanguage() ? "selected" : ""}>${l.name}${l.complete < 100 ? ` (${l.complete}%)` : ""}</option>`).join("")}
        <option disabled>──────────</option>
        <option value="${LOAD}">➕ ${t("lang.load")}</option>
        <option value="${TEMPLATE}">⬇ ${t("lang.template")}</option>
      </select>`;

    const sel = container.querySelector("#lang-select") as HTMLSelectElement;
    sel.addEventListener("change", async () => {
      const v = sel.value;
      sel.value = currentLanguage();
      if (v === LOAD) await loadPack();
      else if (v === TEMPLATE) await saveTemplate();
      else { setLanguage(v); render(); }
    });
  };

  const loadPack = async () => {
    try {
      const p = await open({ multiple: false, directory: false, title: t("lang.load"), filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!p) return;
      const path = typeof p === "object" && p !== null ? (p as any).path : p;
      const bytes = await readFile(path);
      const code = addCustomLanguage(new TextDecoder("utf-8").decode(bytes));
      setLanguage(code);
      render();
      log(t("lang.loaded", { name: availableLanguages().find(l => l.code === code)?.name || code }));
    } catch (err) {
      log(`${t("log.error")} ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const saveTemplate = async () => {
    try {
      const code = currentLanguage();
      const name = availableLanguages().find(l => l.code === code)?.name || code;
      const p = await save({ title: t("lang.template"), defaultPath: `cnc-craft-${code}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!p) return;
      await writeFile(String(p), new TextEncoder().encode(translationTemplate(code, name)));
      log(t("lang.templateSaved", { p: String(p) }));
    } catch (err) {
      log(`${t("log.error")} ${String(err)}`);
    }
  };

  render();
}
