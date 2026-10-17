/**
 * SPRACH-SYSTEM (Übersetzungen)
 *
 *  t("tool.line")                     -> Text in der aktuellen Sprache
 *  t("import.parts", { n: 3 })        -> Platzhalter {n} wird ersetzt
 *
 * Sprachdateien liegen als JSON in src/i18n/lang/  (de.json, en.json, ...).
 * Fehlt in einer Sprache ein Text, wird Englisch und dann Deutsch genommen.
 *
 * In HTML-Vorlagen:
 *   <span data-i18n="key">                Textinhalt
 *   data-i18n-tip="key"                   Hinweis-Text (data-tip)
 *   data-i18n-ph="key"                    Platzhalter in Eingabefeldern
 * Beim Umschalten der Sprache werden diese Stellen sofort aktualisiert – ohne Neustart.
 *
 * Eigene Sprachpakete: JSON-Datei mit "_code" und "_name" laden (siehe README in lang/).
 */
import de from "./lang/de.json";
import en from "./lang/en.json";
import fr from "./lang/fr.json";
import es from "./lang/es.json";
import it from "./lang/it.json";
import nl from "./lang/nl.json";
import pl from "./lang/pl.json";

export type Dict = Record<string, string>;

const BUILTIN: Record<string, Dict> = { de, en, fr, es, it, nl, pl } as Record<string, Dict>;
const STORAGE_LANG = "cnc_craft_language";
const STORAGE_CUSTOM = "cnc_craft_custom_languages";

let custom: Record<string, Dict> = {};
let current = "de";
let dict: Dict = de as Dict;

/**
 * Texte aus fremden Sprachpaketen landen als HTML in der Oberfläche. Damit ein weitergegebenes
 * Sprachpaket keinen Code einschleusen kann, sind darin nur <b>, </b> und <br> erlaubt – alles
 * andere mit < > wird als normaler Text angezeigt.
 */
export function safeText(v: string): string {
  // < nur für <b>, </b>, <br> erlauben, sonst durch ‹ ersetzen; " durch ” (damit nichts aus Attributen ausbricht).
  // Ersetzt statt maskiert, damit der Text auch in der Konsole (reiner Text) normal aussieht.
  return String(v)
    .replace(/<(?!\/?b>|br\s*\/?>)/gi, "‹")
    .replace(/"/g, "”");
}

function cleanPack(d: any): Dict {
  const out: Dict = {};
  if (d && typeof d === "object") for (const [k, v] of Object.entries(d)) if (typeof v === "string") out[k] = safeText(v).slice(0, 4000);
  return out;
}

function loadCustom() {
  try {
    const raw = localStorage.getItem(STORAGE_CUSTOM);
    const parsed = raw ? JSON.parse(raw) || {} : {};
    custom = {};
    for (const [code, d] of Object.entries(parsed)) if (/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(code)) custom[code] = cleanPack(d);
  } catch { custom = {}; }
}

function allPacks(): Record<string, Dict> {
  return { ...BUILTIN, ...custom };
}

/** Beim Start: gespeicherte Sprache, sonst Systemsprache, sonst Englisch */
export function initI18n() {
  loadCustom();
  let code: string | null = null;
  try { code = localStorage.getItem(STORAGE_LANG); } catch { /* egal */ }
  if (!code || !allPacks()[code]) {
    const sys = (navigator.language || "en").slice(0, 2).toLowerCase();
    code = allPacks()[sys] ? sys : "en";
  }
  current = code;
  dict = allPacks()[code];
  document.documentElement.lang = code;
}

export function currentLanguage(): string {
  return current;
}

export function t(key: string, params?: Record<string, string | number>): string {
  let s = dict[key] ?? (en as Dict)[key] ?? (de as Dict)[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

/** HTML-Helfer: Text, der sich beim Sprachwechsel automatisch aktualisiert */
export function T(key: string): string {
  return `<span data-i18n="${key}">${escapeHtml(t(key))}</span>`;
}

/** HTML-Helfer: Hinweis-Attribut (data-tip) mit Übersetzung */
export function tip(key: string): string {
  return `data-i18n-tip="${key}" data-tip="${escapeAttr(t(key))}"`;
}

/** HTML-Helfer: Platzhalter-Attribut mit Übersetzung */
export function ph(key: string): string {
  return `data-i18n-ph="${key}" placeholder="${escapeAttr(t(key))}"`;
}

export interface LanguageInfo { code: string; name: string; custom: boolean; complete: number; }

/** Liste aller Sprachen mit Vollständigkeit in Prozent (gemessen an Deutsch) */
export function availableLanguages(): LanguageInfo[] {
  const total = Object.keys(de).filter(k => !k.startsWith("_")).length;
  return Object.entries(allPacks()).map(([code, d]) => {
    const have = Object.keys(de).filter(k => !k.startsWith("_") && d[k]).length;
    return { code, name: d._name || code, custom: !!custom[code] && !BUILTIN[code], complete: Math.round((have / total) * 100) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function setLanguage(code: string) {
  const pack = allPacks()[code];
  if (!pack) return;
  current = code;
  dict = pack;
  document.documentElement.lang = code;
  try { localStorage.setItem(STORAGE_LANG, code); } catch { /* egal */ }
  applyTranslations(document);
  window.dispatchEvent(new CustomEvent("cnc-language-changed", { detail: code }));
}

/** Alle markierten Stellen im HTML in der aktuellen Sprache neu beschriften */
export function applyTranslations(root: ParentNode) {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n!); });
  root.querySelectorAll<HTMLElement>("[data-i18n-tip]").forEach(el => { el.setAttribute("data-tip", t(el.dataset.i18nTip!)); });
  root.querySelectorAll<HTMLElement>("[data-i18n-ph]").forEach(el => { el.setAttribute("placeholder", t(el.dataset.i18nPh!)); });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach(el => { el.setAttribute("title", t(el.dataset.i18nTitle!)); });
}

/**
 * Eigenes Sprachpaket hinzufügen (JSON-Text). Muss "_code" (z.B. "pt") und "_name" (z.B. "Português") enthalten.
 * Gibt den Sprachcode zurück.
 */
export function addCustomLanguage(jsonText: string): string {
  let data: any;
  try { data = JSON.parse(jsonText); } catch { throw new Error(t("lang.errInvalidJson")); }
  if (!data || typeof data !== "object" || typeof data._code !== "string" || typeof data._name !== "string") {
    throw new Error(t("lang.errMissingCode"));
  }
  const code = data._code.trim().toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(code)) throw new Error(t("lang.errMissingCode"));
  const clean: Dict = cleanPack(data);
  // Eingebaute Sprache verbessern: fehlende/geänderte Texte überschreiben
  custom[code] = { ...(BUILTIN[code] || {}), ...clean };
  try { localStorage.setItem(STORAGE_CUSTOM, JSON.stringify(custom)); } catch { /* egal */ }
  return code;
}

export function removeCustomLanguage(code: string) {
  delete custom[code];
  try { localStorage.setItem(STORAGE_CUSTOM, JSON.stringify(custom)); } catch { /* egal */ }
  if (current === code) setLanguage(BUILTIN[code] ? code : "en");
}

/** Vorlage für Übersetzer: alle Schlüssel mit deutschem und englischem Text */
export function translationTemplate(code = "xx", name = "Neue Sprache"): string {
  const out: Record<string, string> = { _code: code, _name: name, _author: "" };
  const target = allPacks()[code] || {};
  for (const k of Object.keys(en)) {
    if (k.startsWith("_")) continue;
    out[k] = target[k] || (en as Dict)[k];
  }
  return JSON.stringify(out, null, 2);
}

/** Text ohne Umlaute/Akzente (für G-Code-Kommentare, die manche Steuerungen nicht mögen) */
export function ascii(s: string): string {
  return s
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue").replace(/ß/g, "ss")
    .replace(/°/g, "deg").replace(/[Øø⌀]/g, "D").replace(/[×]/g, "x").replace(/[·•]/g, "-")
    .replace(/[–—]/g, "-").replace(/[„“”«»]/g, "'").replace(/[‚‘’]/g, "'")
    .replace(/ł/g, "l").replace(/Ł/g, "L").replace(/đ/g, "d").replace(/Đ/g, "D").replace(/æ/g, "ae").replace(/œ/g, "oe")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/[()]/g, "");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}
function escapeAttr(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
