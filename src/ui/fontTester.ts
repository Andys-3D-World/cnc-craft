/**
 * SCHRIFTEN TESTEN: der eigene Text in jeder Schrift als Vorschau; ein Klick nimmt die Schrift für den nächsten Text.
 * Schriftnamen kommen aus dem System bzw. aus Dateinamen: nur über textContent einsetzen.
 */
import { icon } from "./icons";
import { t } from "../i18n/i18n";
import { BUNDLED, customFontNames, previewFamily, systemFonts } from "../editor/fonts";
import { setNextTextFont } from "../editor/textTool";

const KEY = "cnc_craft_font_test";
interface Entry { family: string; source: "bundled" | "system" | "custom" }

export function openFontTester(log: (s: string) => void) {
  document.getElementById("font-test-overlay")?.remove();
  let saved: { text?: string; cols?: number; filled?: boolean } = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { /* egal */ }
  const ov = document.createElement("div");
  ov.id = "font-test-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box ft-box" role="dialog">
      <h3>${icon("text", 20)}${t("ft.title")}</h3>
      <div class="dlg-hint">${t("ft.desc")}</div>
      <div class="ft-bar">
        <input id="ft-text" type="text" maxlength="60">
        <input id="ft-search" type="search" placeholder="${t("text.fontSearch")}">
        <label>${t("ft.cols")} <input id="ft-cols" type="range" min="2" max="10" step="1"></label>
        <label><input id="ft-fill" type="checkbox" style="width:auto;"> ${t("ft.filled")}</label>
      </div>
      <div class="ft-grid" id="ft-grid"></div>
      <div class="dlg-buttons" style="justify-content:flex-end;"><button id="ft-close" class="btn-secondary">${t("upd.close")}</button></div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const text = $("ft-text"), search = $("ft-search"), cols = $("ft-cols"), fill = $("ft-fill"), grid = $<HTMLElement>("ft-grid");
  text.value = saved.text || t("ft.sample");
  cols.value = String(saved.cols || 4);
  fill.checked = saved.filled !== false;
  let fonts: Entry[] = [...BUNDLED.map(b => ({ family: b.family, source: "bundled" as const })), ...customFontNames().map(f => ({ family: f, source: "custom" as const }))];

  const render = () => {
    grid.style.gridTemplateColumns = `repeat(${cols.value}, minmax(0, 1fr))`;
    const q = search.value.trim().toLowerCase(), big = Math.max(12, Math.min(44 - Number(cols.value) * 3, (grid.clientWidth / Number(cols.value) - 20) / (Math.max(text.value.length, 1) * 0.62)));
    grid.textContent = "";
    for (const f of fonts) {
      if (q && !f.family.toLowerCase().includes(q)) continue;
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "ft-tile";
      const sample = document.createElement("span");
      sample.className = "ft-sample" + (fill.checked ? "" : " ft-outline");
      sample.textContent = text.value || " ";
      sample.style.fontFamily = previewFamily(f.family, f.source);
      sample.style.fontSize = big + "px";
      const name = document.createElement("small");
      name.textContent = f.family;
      tile.append(sample, name);
      tile.addEventListener("click", () => {
        setNextTextFont(f.family);
        log(t("ft.picked", { font: f.family }));
        ov.remove();
      });
      grid.appendChild(tile);
    }
    try { localStorage.setItem(KEY, JSON.stringify({ text: text.value, cols: Number(cols.value), filled: fill.checked })); } catch { /* egal */ }
  };
  [text, search, cols, fill].forEach(el => el.addEventListener("input", render));
  fill.addEventListener("change", render);
  $<HTMLElement>("ft-close").onclick = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") ov.remove(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) ov.remove(); });
  render();
  text.focus();
  text.select();
  // Systemschriften kommen später dazu (Tauri); ohne sie bleibt die Liste mit den mitgelieferten
  systemFonts().then(m => {
    if (!document.getElementById("font-test-overlay")) return;
    const known = new Set(fonts.map(f => f.family));
    const sys = [...m.keys()].filter(f => !known.has(f)).sort((a, b) => a.localeCompare(b)).map(family => ({ family, source: "system" as const }));
    fonts = [...fonts, ...sys];
    render();
  }).catch(() => { /* ohne Systemschriften geht es auch */ });
}
