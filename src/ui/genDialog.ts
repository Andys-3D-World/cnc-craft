/**
 * GEMEINSAMES LAYOUT DER GENERATOR-FENSTER
 *
 * Jeder Generator baut sein Fenster selbst (Felder links, Vorschau rechts). Diese Funktion ordnet das fertige Fenster
 * einheitlich an: gleiche Größe, Titel oben, Felder links scrollen für sich, die Vorschau bleibt stehen und nutzt den
 * freien Platz, Knöpfe immer sichtbar unten rechts. Knoten werden nur verschoben, IDs und Ereignisse bleiben erhalten.
 *
 * Tasten: Enter in einem Eingabefeld = OK (nicht im Mehrzeilen-Feld, nicht auf einem Knopf), Esc = Abbrechen.
 * Klick neben das Fenster schließt es nicht: Eingaben gehen so nicht versehentlich verloren.
 */
import { t } from "../i18n/i18n";
import { addPreset, removePreset, sanitizePresets, MAX_NAME, type GenPreset, type PresetValue } from "../genPresets";

const PRESET_KEY = "cnc_craft_gen_presets";

function readPresets(kind: string): GenPreset[] {
  try { return sanitizePresets(JSON.parse(localStorage.getItem(PRESET_KEY) || "{}")?.[kind]); } catch { return []; }
}
function writePresets(kind: string, list: GenPreset[]) {
  try {
    const all = JSON.parse(localStorage.getItem(PRESET_KEY) || "{}") || {};
    all[kind] = list;
    localStorage.setItem(PRESET_KEY, JSON.stringify(all));
  } catch { /* egal */ }
}

/** Felder mit Kennung im Fenster (Schriftauswahl und Suchfelder gehören nicht dazu) */
function presetFields(box: HTMLElement): (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[] {
  return Array.from(box.querySelectorAll<HTMLInputElement>("input[id], select[id], textarea[id]"))
    .filter(el => !["file", "search", "button", "hidden"].includes(el.type) && !el.closest(".gen-presets"));
}

/** Vorlagen unten links: häufige Maße unter einem Namen speichern. Namen nur als Text einsetzen */
function addPresetBar(ov: HTMLElement, box: HTMLElement, footer: HTMLElement) {
  const kind = (ov.dataset.preset || ov.id).replace(/-?(dialog-)?overlay$/, "");
  const bar = document.createElement("div");
  bar.className = "gen-presets";
  const sel = document.createElement("select");
  const name = document.createElement("input");
  name.type = "text"; name.maxLength = MAX_NAME; name.placeholder = t("gen.preset.name"); name.hidden = true;
  const save = document.createElement("button");
  save.type = "button"; save.className = "btn-secondary"; save.textContent = t("gen.preset.save");
  const del = document.createElement("button");
  del.type = "button"; del.className = "btn-secondary"; del.textContent = "✕"; del.title = t("gen.preset.delete");
  bar.append(sel, name, save, del);
  footer.prepend(bar);
  const fill = (current = "") => {
    const list = readPresets(kind);
    sel.textContent = "";
    sel.append(new Option(t("gen.preset.pick"), ""));
    for (const p of list) sel.append(new Option(p.name, p.name));
    sel.value = current;
    del.hidden = !sel.value;
    sel.hidden = !list.length;
  };
  const store = () => {
    const values: Record<string, PresetValue> = {};
    for (const el of presetFields(box)) values[el.id] = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? el.checked : el.value;
    const list = addPreset(readPresets(kind), name.value, values);
    writePresets(kind, list);
    const done = list.find(p => p.name.toLowerCase() === name.value.trim().toLowerCase());
    name.hidden = true; name.value = "";
    fill(done?.name || "");
  };
  save.addEventListener("click", () => {
    if (name.hidden) { name.hidden = false; name.value = sel.value; name.focus(); name.select(); return; }
    store();
  });
  name.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); store(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); name.hidden = true; }
  });
  sel.addEventListener("change", () => {
    del.hidden = !sel.value;
    const p = readPresets(kind).find(q => q.name === sel.value);
    if (!p) return;
    for (const el of presetFields(box)) {
      if (!(el.id in p.values)) continue;
      const v = p.values[el.id];
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) el.checked = v === true;
      else el.value = String(v);
      // jedes Feld meldet sich: der Generator blendet passende Felder ein und rechnet die Vorschau neu
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  del.addEventListener("click", () => {
    if (!sel.value) return;
    writePresets(kind, removePreset(readPresets(kind), sel.value));
    fill();
  });
  fill();
}

function gridOf(box: HTMLElement): HTMLElement | null {
  for (const el of Array.from(box.children) as HTMLElement[]) {
    if (el.classList.contains("box-grid") || el.style.display === "grid") return el;
  }
  return null;
}

/** Die Fläche der Vorschau: das Kind von .box-prev, in dem das Bild steckt */
function markStage(prev: HTMLElement) {
  const kids = Array.from(prev.children) as HTMLElement[];
  for (const k of kids) {
    const isImage = k.tagName.toLowerCase() === "svg" || k.tagName.toLowerCase() === "canvas";
    // Bild-Halter: <div id="…-svg">, wird bei jeder Änderung neu gefüllt (kann gerade leer sein)
    if (isImage || /-svg$/.test(k.id) || (!k.classList.contains("dlg-hint") && k.querySelector(":scope > svg:not(.ico)"))) k.classList.add("gen-stage");
  }
}

export function polishGenDialog(label: "new" | "edit" = "new") {
  const all = document.querySelectorAll<HTMLElement>(".dlg-overlay");
  const ov = all[all.length - 1];
  const box = ov?.querySelector<HTMLElement>(":scope > .dlg-box");
  if (!ov || !box) return;
  if (box.classList.contains("gen-dlg")) { setOkLabel(box, label); return; }
  const grid = gridOf(box);
  const footer = box.querySelector<HTMLElement>(":scope > .dlg-buttons");
  if (!grid || grid.children.length < 2 || !footer) return; // unbekannter Aufbau: Fenster bleibt, wie es ist

  box.classList.add("gen-dlg");
  box.style.width = "";
  grid.removeAttribute("style");
  grid.classList.remove("box-grid");
  grid.classList.add("gen-body");
  const left = grid.children[0] as HTMLElement, right = grid.children[1] as HTMLElement;
  left.classList.add("gen-left");
  right.classList.add("gen-right");
  left.style.maxHeight = "";
  left.style.overflow = "";
  left.style.overflowY = "";
  left.style.paddingRight = "";

  // Zwischen Einleitung und Spalten (Art der Box, Textfeld …): nach oben in die Felder. Danach (Hinweise): unter die Vorschau
  const kids = Array.from(box.children) as HTMLElement[];
  const gridAt = kids.indexOf(grid), footAt = kids.indexOf(footer);
  const firstField = kids.findIndex((k, i) => i > 0 && !k.classList.contains("dlg-hint"));
  const between = kids.slice(firstField, gridAt);
  // Kurzbeschreibung direkt hinter einem Feld gehört zu diesem Feld und wandert mit
  between.reverse().forEach(k => left.prepend(k));
  kids.slice(gridAt + 1, footAt).forEach(k => right.appendChild(k));

  if (right.classList.contains("box-prev")) markStage(right);
  right.querySelectorAll<HTMLElement>(".box-prev").forEach(markStage);
  setOkLabel(box, label);
  addPresetBar(ov, box, footer);

  box.tabIndex = -1;
  box.addEventListener("keydown", e => {
    e.stopPropagation(); // Tastenkürzel der Zeichenfläche nicht auslösen
    const el = e.target as HTMLElement;
    if (e.key === "Escape") {
      e.preventDefault();
      okCancel(box).cancel?.click();
    } else if (e.key === "Enter" && el.tagName === "INPUT" && !el.closest(".gen-presets") && !["checkbox", "radio", "file", "button"].includes((el as HTMLInputElement).type)) {
      e.preventDefault();
      const ok = okCancel(box).ok;
      if (ok && !ok.disabled) ok.click();
    }
  });
  ov.addEventListener("mousedown", e => { if (e.target === ov) e.stopImmediatePropagation(); }, true);
  if (!box.contains(document.activeElement)) box.focus();
}

function okCancel(box: HTMLElement) {
  const btns = Array.from(box.querySelectorAll<HTMLButtonElement>(":scope > .dlg-buttons > button"));
  return { ok: btns.filter(b => b.classList.contains("btn-primary")).pop(), cancel: btns.find(b => b.classList.contains("btn-secondary")) };
}

/** Überall dieselbe Beschriftung; beim Bearbeiten sagt der Knopf, dass ersetzt wird */
function setOkLabel(box: HTMLElement, label: "new" | "edit") {
  const ok = okCancel(box).ok;
  if (ok) ok.textContent = "✔ " + t(label === "edit" ? "gen.okEdit" : "gen.okNew");
}
