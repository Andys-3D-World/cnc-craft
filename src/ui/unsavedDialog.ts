/**
 * FRAGE-FENSTER mit mehreren Knöpfen (z. B. "Speichern?" beim Schließen, "Wiederherstellen?" nach Absturz)
 * Esc / Klick daneben = erster Knopf mit `cancel: true` (sonst der letzte).
 */
import { t } from "../i18n/i18n";

interface Choice<K extends string> { key: K; label: string; primary?: boolean; cancel?: boolean }

export function askChoice<K extends string>(title: string, text: string, choices: Choice<K>[], danger = false): Promise<K> {
  return new Promise(resolve => {
    document.getElementById("choice-dialog-overlay")?.remove();
    const ov = document.createElement("div");
    ov.id = "choice-dialog-overlay";
    ov.className = "dlg-overlay";
    ov.innerHTML = `
      <div class="dlg-box" role="alertdialog" style="width:420px;">
        <h3></h3>
        <div class="dlg-hint"></div>
        <div class="dlg-buttons" style="justify-content:flex-end;"></div>
      </div>`;
    // Titel/Text können Dateinamen enthalten -> nur als Text
    ov.querySelector("h3")!.textContent = title;
    const hint = ov.querySelector<HTMLElement>(".dlg-hint")!;
    hint.textContent = text;
    hint.style.whiteSpace = "pre-line";
    if (danger) hint.style.color = "var(--color-danger)";
    const bar = ov.querySelector(".dlg-buttons")!;
    const fallback = (choices.find(c => c.cancel) || choices[choices.length - 1]).key;
    const done = (k: K) => { ov.remove(); document.removeEventListener("keydown", onKey, true); resolve(k); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(fallback); }
    };
    let focus: HTMLButtonElement | null = null;
    choices.forEach(c => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = c.primary ? "btn-primary" : "btn-secondary";
      b.textContent = c.label;
      b.addEventListener("click", () => done(c.key));
      bar.appendChild(b);
      if (c.primary) focus = b;
    });
    ov.addEventListener("mousedown", e => { if (e.target === ov) done(fallback); });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(ov);
    (focus as HTMLButtonElement | null)?.focus();
  });
}

/** "Änderungen speichern?" – Speichern / Nicht speichern / Abbrechen */
export function askUnsaved(): Promise<"save" | "discard" | "cancel"> {
  return askChoice(t("unsaved.title"), t("unsaved.text"), [
    { key: "discard", label: t("unsaved.discard") },
    { key: "cancel", label: t("dlg.cancel"), cancel: true },
    { key: "save", label: t("unsaved.save"), primary: true }
  ]);
}
