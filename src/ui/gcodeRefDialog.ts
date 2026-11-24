/**
 * G-CODE NACHSCHLAGEN: Fenster mit allen Befehlen, Suche und Angabe, ob GRBL sie kennt.
 * Daten: gcodeRef.ts, Texte: „gref.…“ in den Sprachdateien.
 */
import { t } from "../i18n/i18n";
import { GCODE_REF, type RefEntry } from "../gcodeRef";

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const GROUPS: RefEntry["group"][] = ["move", "plane", "pos", "cycle", "tool", "m", "word"];

/** Erklärung in einer Zeile (Hinweis an der G-Code-Liste) */
export function refTip(r: RefEntry): string {
  return `${r.code} – ${t("gref." + r.id)}${r.support === "yes" ? "" : " · " + t("gref.support." + r.support)}`;
}

export function openGcodeRef(start = "") {
  document.getElementById("gref-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "gref-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(720px, calc(100vw - 32px));">
      <h3>📚 ${esc(t("gref.title"))}</h3>
      <div class="dlg-hint">${esc(t("gref.hint"))}</div>
      <input id="gref-search" type="search" class="prop-input" placeholder="${esc(t("gref.search"))}" value="${esc(start)}">
      <div class="gref-list" id="gref-list"></div>
      <div class="dlg-buttons"><button id="gref-close" class="btn-primary" style="margin-left:auto;">${esc(t("dlg.close"))}</button></div>
    </div>`;
  document.body.appendChild(ov);
  const search = ov.querySelector("#gref-search") as HTMLInputElement, list = ov.querySelector("#gref-list") as HTMLElement;
  const render = () => {
    // „g01“ findet auch G1
    const q = search.value.trim().toLowerCase(), code = q.replace(/^([gm])0+(?=\d)/, "$1");
    const hit = (r: RefEntry) => !q || r.code.toLowerCase().startsWith(code) || t("gref." + r.id).toLowerCase().includes(q);
    list.innerHTML = GROUPS.map(g => {
      const rows = GCODE_REF.filter(r => r.group === g && hit(r));
      return rows.length ? `<h4>${esc(t("gref.group." + g))}</h4>` + rows.map(r => `
        <div class="gref-row"><b>${esc(r.code)}</b><span>${esc(t("gref." + r.id))}${r.example ? `<code>${esc(r.example)}</code>` : ""}</span>
          <em class="gref-${r.support}">${esc(t("gref.support." + r.support))}</em></div>`).join("") : "";
    }).join("") || `<div class="dlg-hint">${esc(t("gref.none"))}</div>`;
  };
  search.addEventListener("input", render);
  render();
  const close = () => ov.remove();
  (ov.querySelector("#gref-close") as HTMLElement).onclick = close;
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  search.focus();
}
