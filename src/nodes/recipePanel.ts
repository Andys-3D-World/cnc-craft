/**
 * VORLAGEN im Knoten-Editor: mitgelieferte Abläufe, eigene Vorlagen (Name), als Datei weitergeben (*.cncgraph)
 */
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { t } from "../i18n/i18n";
import { Graph } from "./graph";
import { RECIPES } from "./recipes";
import { deleteRecipe, ownRecipes, parseRecipeFile, recipeFileText, saveRecipe } from "./graphStore";

const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const pathOf = (sel: any): string => (typeof sel === "object" && sel !== null ? sel.path : sel);

/** Ist das Vorlagen-Fenster offen? Dann schließt Esc nur das */
export function closeRecipePanel(): boolean {
  const el = document.querySelector(".ng-tpl");
  el?.remove();
  return !!el;
}

/**
 * box: Fenster des Editors, current: der Graph jetzt, load: Graph ersetzen (fragt vorher nach), log: Protokoll
 */
export function openRecipePanel(box: HTMLElement, current: () => Graph, load: (g: Graph, name: string) => void, log: (s: string) => void) {
  if (closeRecipePanel()) return;
  const el = document.createElement("div");
  el.className = "ng-tpl";
  box.appendChild(el);

  const render = () => {
    const own = ownRecipes();
    el.innerHTML = `
      <div class="ng-tpl-h">${t("ng.tpl.builtIn")}</div>
      ${RECIPES.map(r => `<button class="ng-tpl-item" data-builtin="${r.id}"><span>${r.icon}</span><div><b>${t("ng.tpl." + r.id)}</b>
        <small>${t("ng.tpl." + r.id + ".d")}</small></div></button>`).join("")}
      <div class="ng-tpl-h">${t("ng.tpl.own")}</div>
      ${own.length ? own.map((r, i) => `<div class="ng-tpl-own"><button class="ng-tpl-item" data-own="${i}"><span>⭐</span><div><b>${esc(r.name)}</b></div></button>
        <button class="ng-del" data-del="${i}" title="${t("ng.tpl.delete")}" aria-label="${t("ng.tpl.delete")}">✕</button></div>`).join("")
        : `<div class="dlg-hint">${t("ng.tpl.noOwn")}</div>`}
      <div class="ng-tpl-save">
        <input type="text" class="prop-input" maxlength="80" placeholder="${t("ng.tpl.namePh")}">
        <button class="btn-secondary" data-act="save">${t("ng.tpl.save")}</button>
      </div>
      <div class="ng-tpl-save">
        <button class="btn-secondary" data-act="export">💾 ${t("ng.tpl.export")}</button>
        <button class="btn-secondary" data-act="import">📂 ${t("ng.tpl.import")}</button>
      </div>
      <div class="dlg-hint">${t("ng.tpl.hint")}</div>`;
  };
  render();

  const nameInput = () => el.querySelector<HTMLInputElement>(".ng-tpl-save input")!;
  el.addEventListener("click", async e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!b) return;
    if (b.dataset.builtin) {
      const r = RECIPES.find(x => x.id === b.dataset.builtin);
      if (r) { closeRecipePanel(); load(r.make(), t("ng.tpl." + r.id)); }
    } else if (b.dataset.own) {
      const r = ownRecipes()[+b.dataset.own];
      if (r) { closeRecipePanel(); load(r.graph, r.name); }
    } else if (b.dataset.del) {
      const r = ownRecipes()[+b.dataset.del];
      if (r && window.confirm(t("ng.tpl.confirmDelete", { name: r.name }))) { deleteRecipe(r.name); render(); }
    } else if (b.dataset.act === "save") {
      const name = nameInput().value.trim();
      if (!name) { nameInput().focus(); return; }
      if (saveRecipe(name, current())) { log(t("ng.tpl.saved", { name })); render(); }
      else log(t("ng.tpl.full"));
    } else if (b.dataset.act === "export") {
      const name = nameInput().value.trim() || t("ng.title");
      try {
        const sel = await save({ title: t("ng.tpl.export"), defaultPath: name + ".cncgraph", filters: [{ name: t("ng.tpl.fileType"), extensions: ["cncgraph"] }] });
        if (!sel) return;
        // genau den gewählten Pfad nehmen (nur der ist freigegeben)
        await writeFile(String(sel), new TextEncoder().encode(recipeFileText(name, current())));
        log(t("ng.tpl.exported", { p: String(sel) }));
      } catch (err) { log(t("ng.tpl.fileError", { e: String(err) })); }
    } else if (b.dataset.act === "import") {
      try {
        const sel = await open({ multiple: false, directory: false, title: t("ng.tpl.import"), filters: [{ name: t("ng.tpl.fileType"), extensions: ["cncgraph"] }] });
        if (!sel) return;
        const r = parseRecipeFile(new TextDecoder().decode(await readFile(pathOf(sel))));
        if (!r) { log(t("ng.tpl.badFile")); return; }
        closeRecipePanel();
        load(r.graph, r.name || String(pathOf(sel)).split(/[\\/]/).pop() || "");
      } catch (err) { log(t("ng.tpl.fileError", { e: String(err) })); }
    }
  });
  el.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.target as HTMLElement).matches(".ng-tpl-save input")) el.querySelector<HTMLButtonElement>('[data-act="save"]')!.click();
  });
  // Klick daneben schließt
  setTimeout(() => {
    const away = (e: MouseEvent) => {
      if (!el.isConnected) { document.removeEventListener("mousedown", away, true); return; }
      const tgt = e.target as HTMLElement;
      if (!el.contains(tgt) && !tgt.closest("#ng-tpl-btn")) { el.remove(); document.removeEventListener("mousedown", away, true); }
    };
    document.addEventListener("mousedown", away, true);
  }, 0);
}
