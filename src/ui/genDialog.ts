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

  box.tabIndex = -1;
  box.addEventListener("keydown", e => {
    e.stopPropagation(); // Tastenkürzel der Zeichenfläche nicht auslösen
    const el = e.target as HTMLElement;
    if (e.key === "Escape") {
      e.preventDefault();
      okCancel(box).cancel?.click();
    } else if (e.key === "Enter" && el.tagName === "INPUT" && !["checkbox", "radio", "file", "button"].includes((el as HTMLInputElement).type)) {
      e.preventDefault();
      const ok = okCancel(box).ok;
      if (ok && !ok.disabled) ok.click();
    }
  });
  ov.addEventListener("mousedown", e => { if (e.target === ov) e.stopImmediatePropagation(); }, true);
  if (!box.contains(document.activeElement)) box.focus();
}

function okCancel(box: HTMLElement) {
  const btns = Array.from(box.querySelectorAll<HTMLButtonElement>(":scope > .dlg-buttons button"));
  return { ok: btns.filter(b => b.classList.contains("btn-primary")).pop(), cancel: btns.find(b => b.classList.contains("btn-secondary")) };
}

/** Überall dieselbe Beschriftung; beim Bearbeiten sagt der Knopf, dass ersetzt wird */
function setOkLabel(box: HTMLElement, label: "new" | "edit") {
  const ok = okCancel(box).ok;
  if (ok) ok.textContent = "✔ " + t(label === "edit" ? "gen.okEdit" : "gen.okNew");
}
