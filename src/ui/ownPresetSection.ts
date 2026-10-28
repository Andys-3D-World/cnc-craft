/**
 * Abschnitt „Meine Vorlagen“ in den Material-Vorlagen von Laser und Plasma (Daten: ownPresets.ts).
 * Oben: eine Ebene / einen Schnitt aus der Bibliothek als Vorlage speichern. Darunter die eigenen Vorlagen mit ＋ / 🗑.
 */
import { t } from "../i18n/i18n";
import { OwnKind, ownPresets, addOwnPreset, removeOwnPreset } from "../ownPresets";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export interface OwnSource { id: string; name: string; values: object }

/**
 * @param host     Element, in das der Abschnitt gezeichnet wird
 * @param sources  Ebenen / Schnitte der Bibliothek (zum Speichern)
 * @param info     Kurzinfo zu gespeicherten Werten (z. B. „80 % · 300 mm/min“)
 * @param apply    Vorlage anlegen (neue Ebene / neuer Schnitt)
 */
export function mountOwnPresets(host: HTMLElement, kind: OwnKind, sources: () => OwnSource[],
  info: (data: Record<string, unknown>) => string, apply: (label: string, data: Record<string, unknown>) => void) {
  const render = () => {
    const own = ownPresets(kind), src = sources();
    host.innerHTML = `
      <div class="own-head">⭐ ${esc(t("own.title"))}</div>
      <div class="own-save">
        <select class="prop-input own-src">${src.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</select>
        <button type="button" class="btn-secondary btn-compact own-store" ${src.length ? "" : "disabled"} data-tip="${esc(t("own.saveTip"))}">💾 ${esc(t("own.save"))}</button>
      </div>
      ${own.length ? own.map(p => `
        <div class="own-row">
          <div style="flex:1;min-width:0;"><b>${esc(p.label)}</b><div class="tool-scope">${esc(info(p.data))}</div></div>
          <button type="button" class="btn-secondary btn-compact" data-apply="${esc(p.id)}">＋ ${esc(t("llib.pre.add"))}</button>
          <button type="button" class="btn-secondary btn-icon" data-del="${esc(p.id)}" data-tip="${esc(t("own.delTip"))}">🗑</button>
        </div>`).join("") : `<div class="tool-scope own-empty">${esc(t("own.empty"))}</div>`}`;
  };
  host.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    if (b.classList.contains("own-store")) {
      const id = (host.querySelector(".own-src") as HTMLSelectElement).value;
      const s = sources().find(x => x.id === id);
      if (!s) return;
      addOwnPreset(kind, s.name, s.values);
      render();
      return;
    }
    const p = ownPresets(kind).find(x => x.id === (b.dataset.apply || b.dataset.del));
    if (!p) return;
    if (b.dataset.apply) { apply(p.label, p.data); b.disabled = true; b.textContent = "✔ " + t("llib.pre.added"); }
    else if (window.confirm(t("own.delConfirm", { name: p.label }))) { removeOwnPreset(kind, p.id); render(); }
  });
  render();
  // Bibliothek geändert (z. B. eben eine Vorlage hinzugefügt): Auswahl zum Speichern aktuell halten
  const onChange = () => {
    if (!host.isConnected) { for (const ev of EVENTS) window.removeEventListener(ev, onChange); return; }
    const sel = host.querySelector(".own-src") as HTMLSelectElement | null;
    const keep = sel?.value;
    render();
    const now = host.querySelector(".own-src") as HTMLSelectElement | null;
    if (now && keep && [...now.options].some(o => o.value === keep)) now.value = keep;
  };
  for (const ev of EVENTS) window.addEventListener(ev, onChange);
}

/** Änderungen der Laser-Ebenen und Plasma-Schnitte (laserLayers.ts / plasmaCuts.ts) */
const EVENTS = ["cnc-laser-layers-changed", "cnc-plasma-changed"];
