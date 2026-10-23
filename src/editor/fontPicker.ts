/**
 * SCHRIFTAUSWAHL im Text-Dialog
 *
 * Knopf mit dem Namen der Schrift (in der Schrift selbst geschrieben). Klick öffnet eine Liste
 * mit Suchfeld und den Gruppen „Mitgeliefert“, „Eigene Dateien“ und „System“.
 * Schriftnamen kommen aus dem System bzw. aus Dateinamen -> nur über textContent einsetzen.
 */
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { t } from "../i18n/i18n";
import { BUNDLED, addCustomFont, customFontNames, previewFamily, systemFonts } from "./fonts";

export interface FontPicker {
  get(): string;
  setMissing(missing: boolean): void;
}

type Source = "bundled" | "system" | "custom";

export function createFontPicker(host: HTMLElement, initial: string, onChange: (family: string) => void): FontPicker {
  let value = initial;
  host.classList.add("fp");
  host.innerHTML = `
    <button type="button" class="fp-btn"><span class="fp-name"></span><span class="fp-arrow">▾</span></button>
    <div class="fp-panel" hidden>
      <div class="fp-top">
        <input class="fp-search" type="search" placeholder="${t("text.fontSearch")}">
        <button type="button" class="fp-refresh" title="${t("text.fontRefresh")}">↻</button>
      </div>
      <div class="fp-list"></div>
      <div class="fp-foot">
        <button type="button" class="fp-file">📂 ${t("text.fontLoadFile")}</button>
        <div class="fp-hint">${t("text.fontInstallHint")}</div>
      </div>
    </div>`;
  const btn = host.querySelector(".fp-btn") as HTMLButtonElement;
  const nameEl = host.querySelector(".fp-name") as HTMLSpanElement;
  const panel = host.querySelector(".fp-panel") as HTMLDivElement;
  const search = host.querySelector(".fp-search") as HTMLInputElement;
  const list = host.querySelector(".fp-list") as HTMLDivElement;
  const hint = host.querySelector(".fp-hint") as HTMLDivElement;
  let sysNames: string[] | null = null;

  const sourceOf = (f: string): Source =>
    BUNDLED.some(b => b.family === f) ? "bundled" : customFontNames().includes(f) ? "custom" : "system";

  const showValue = () => {
    nameEl.textContent = value;
    nameEl.style.fontFamily = previewFamily(value, sourceOf(value));
  };

  const pick = (f: string) => {
    value = f;
    showValue();
    close();
    onChange(f);
  };

  const heading = (text: string) => {
    const h = document.createElement("div");
    h.className = "fp-group";
    h.textContent = text;
    list.appendChild(h);
  };
  const item = (family: string, source: Source, tag?: string) => {
    const el = document.createElement("div");
    el.className = "fp-item" + (family === value ? " fp-sel" : "");
    const n = document.createElement("span");
    n.className = "fp-iname";
    n.textContent = family;
    n.style.fontFamily = previewFamily(family, source);
    el.appendChild(n);
    if (tag) {
      const tg = document.createElement("span");
      tg.className = "fp-tag";
      tg.textContent = tag;
      el.appendChild(tg);
    }
    el.addEventListener("click", () => pick(family));
    list.appendChild(el);
    return el;
  };

  const render = () => {
    const q = search.value.trim().toLowerCase();
    const match = (f: string) => !q || f.toLowerCase().includes(q);
    list.textContent = "";
    let count = 0;
    const bundled = BUNDLED.filter(b => match(b.family) || match(t("text.cat." + b.cat)));
    if (bundled.length) {
      heading(t("text.fontBundled"));
      for (const b of bundled) { item(b.family, "bundled", t("text.cat." + b.cat)); count++; }
    }
    const custom = customFontNames().filter(match);
    if (custom.length) {
      heading(t("text.fontCustom"));
      for (const f of custom) { item(f, "custom"); count++; }
    }
    if (sysNames === null) {
      heading(t("text.fontSystem"));
      const l = document.createElement("div");
      l.className = "fp-empty";
      l.textContent = t("text.fontLoading");
      list.appendChild(l);
    } else {
      const sys = sysNames.filter(match);
      if (sys.length) {
        heading(`${t("text.fontSystem")} (${sys.length})`);
        for (const f of sys) { item(f, "system"); count++; }
      }
      if (!count) {
        const l = document.createElement("div");
        l.className = "fp-empty";
        l.textContent = t("text.fontNone");
        list.appendChild(l);
      }
    }
    list.querySelector(".fp-sel")?.scrollIntoView({ block: "nearest" });
  };

  const loadSystem = (refresh: boolean) => {
    sysNames = null;
    render();
    systemFonts(refresh).then(m => {
      sysNames = [...m.keys()].sort((a, b) => a.localeCompare(b));
      if (!panel.hidden) render();
    });
  };

  const onOutside = (e: MouseEvent) => { if (!host.contains(e.target as Node)) close(); };
  function close() {
    panel.hidden = true;
    document.removeEventListener("mousedown", onOutside, true);
  }
  const openPanel = () => {
    panel.hidden = false;
    search.value = "";
    if (sysNames === null) loadSystem(false); else render();
    document.addEventListener("mousedown", onOutside, true);
    search.focus();
  };

  btn.addEventListener("click", () => (panel.hidden ? openPanel() : close()));
  search.addEventListener("input", render);
  search.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.stopPropagation(); close(); btn.focus(); }
    if (e.key === "Enter") {
      e.preventDefault();
      const first = list.querySelector(".fp-iname");
      if (first?.textContent) pick(first.textContent);
    }
  });
  host.querySelector(".fp-refresh")!.addEventListener("click", () => loadSystem(true));
  host.querySelector(".fp-file")!.addEventListener("click", async () => {
    const sel = await open({
      multiple: false, directory: false, title: t("text.fontLoadFile"),
      filters: [{ name: t("text.fontFileFilter"), extensions: ["ttf", "otf", "woff", "woff2"] }]
    });
    if (!sel) return;
    const path = typeof sel === "object" && sel !== null ? (sel as any).path : sel;
    try {
      const bytes = await readFile(path);
      const name = await addCustomFont(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      pick(name);
    } catch (e) {
      hint.textContent = t("text.fontLoadError", { e: String(e) });
    }
  });

  showValue();
  // Systemschriften schon im Hintergrund suchen, damit die Liste beim Öffnen bereit ist
  systemFonts().then(m => { sysNames = [...m.keys()].sort((a, b) => a.localeCompare(b)); });

  return {
    get: () => value,
    setMissing: (missing: boolean) => {
      btn.classList.toggle("fp-missing", missing);
      btn.title = missing ? t("text.fontMissingShort") : "";
    }
  };
}
