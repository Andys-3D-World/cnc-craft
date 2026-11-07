/**
 * BEFEHLSSUCHE (Strg+K / Cmd+K): Namen tippen, Enter drücken.
 * Die Liste kommt aus den vorhandenen Knöpfen der Leisten; ausgeführt wird per Klick auf den Knopf,
 * also genau das, was der Knopf sonst auch tut.
 */
import { t } from "../i18n/i18n";
import { searchItems, SearchItem } from "../commandSearch";
import { labelOf } from "./flyout";

interface Entry extends SearchItem { el: HTMLElement; key: string }

/** Wichtige Knöpfe außerhalb der Leisten: Selektor + Name */
const EXTRAS: [string, string][] = [
  ["#btn-to-machine", "rp.toMachine"],
  ["#btn-simulate", "rp.simulate"],
  ["#btn-cost", "cost.button"],
  ["#btn-save-gcode", "rp.saveGcode"],
  ["#btn-load-gcode", "rp.loadGcode"],
  [".mw-open", "mw.open"],
  ['.tab-navigation [data-tab="tab-sim"]', "nav.sim"],
  ['.tab-navigation [data-tab="tab-program"]', "nav.library"],
  ['.tab-navigation [data-tab="tab-calibrate"]', "nav.calibrate"],
  ['.tab-navigation [data-tab="tab-flash"]', "nav.flash"],
  ['.tab-navigation [data-tab="tab-wiring"]', "nav.wiring"]
];

function collect(): Entry[] {
  const seen = new Set<string>(), out: Entry[] = [];
  document.querySelectorAll<HTMLElement>("#dynamic-cam-panel [data-tool], #dynamic-cam-panel [data-cmd], #editor-toolbar [data-cmd]").forEach(el => {
    if (el.hasAttribute("data-fly-btn")) return; // Gruppen-Knopf: der Eintrag steht in seiner Liste
    const id = el.dataset.cmd ? "c:" + el.dataset.cmd : "t:" + el.dataset.tool;
    if (seen.has(id)) return;
    seen.add(id);
    const tipText = el.getAttribute("data-tip") || "";
    const l = labelOf(tipText);
    out.push({ el, name: l.name, key: l.key, more: tipText });
  });
  for (const [sel, key] of EXTRAS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) out.push({ el, name: t(key), key: "" });
  }
  return out;
}

function run(e: Entry) {
  // Knöpfe auf der Zeichenfläche und rechts: erst in den Entwurf wechseln
  if (document.getElementById("tab-cam")?.contains(e.el)) {
    document.querySelector<HTMLElement>('.tab-navigation [data-tab="tab-cam"]')?.click();
    const page = e.el.closest<HTMLElement>(".rp-page");
    if (page) document.querySelector<HTMLElement>(`.rp-tab[data-rp="${page.id}"]`)?.click();
  }
  e.el.click();
}

export function openCommandPalette() {
  if (document.getElementById("cmd-palette")) return;
  const all = collect();
  const ov = document.createElement("div");
  ov.id = "cmd-palette";
  ov.className = "cmdk-overlay";
  ov.innerHTML = `<div class="cmdk-box" role="dialog"><input class="cmdk-input" type="search" autocomplete="off" spellcheck="false"><div class="cmdk-list" role="listbox"></div></div>`;
  const input = ov.querySelector<HTMLInputElement>(".cmdk-input")!, list = ov.querySelector<HTMLElement>(".cmdk-list")!;
  input.placeholder = t("cmdk.placeholder");
  document.body.appendChild(ov);

  let shown: Entry[] = [], cur = 0;
  const close = () => ov.remove();
  const mark = () => list.querySelectorAll<HTMLElement>(".cmdk-row").forEach((r, i) => {
    r.classList.toggle("active", i === cur);
    if (i === cur) r.scrollIntoView({ block: "nearest" });
  });
  const go = (e?: Entry) => { if (e) { close(); run(e); } };
  const render = () => {
    shown = searchItems(all, input.value);
    cur = 0;
    list.textContent = "";
    if (!shown.length) {
      const none = document.createElement("div");
      none.className = "cmdk-none";
      none.textContent = t("cmdk.none");
      list.appendChild(none);
      return;
    }
    shown.forEach((e, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cmdk-row";
      const name = document.createElement("span");
      name.textContent = e.name;
      row.appendChild(name);
      if (e.key) { const k = document.createElement("kbd"); k.textContent = e.key; row.appendChild(k); }
      row.addEventListener("click", () => go(e));
      row.addEventListener("mousemove", () => { if (cur !== i) { cur = i; mark(); } });
      list.appendChild(row);
    });
    mark();
  };
  input.addEventListener("input", render);
  ov.addEventListener("keydown", e => {
    e.stopPropagation(); // Tastenkürzel der Zeichenfläche nicht auslösen
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Enter") { e.preventDefault(); go(shown[cur]); }
    else if (e.key === "ArrowDown" && shown.length) { e.preventDefault(); cur = (cur + 1) % shown.length; mark(); }
    else if (e.key === "ArrowUp" && shown.length) { e.preventDefault(); cur = (cur - 1 + shown.length) % shown.length; mark(); }
  });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  render();
  input.focus();
}

export function initCommandPalette() {
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (document.querySelector(".dlg-overlay")) return; // ein Fenster ist offen
      openCommandPalette();
    }
  }, true);
  document.getElementById("btn-cmd-search")?.addEventListener("click", openCommandPalette);
}
