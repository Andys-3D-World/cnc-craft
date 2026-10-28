/**
 * MATERIAL-DATENBANK (Seite „Werkzeuge“ → Werkzeug-Einstellungen → 📚)
 *
 * Tabelle aller Materialien für den Schnittdaten-Rechner: Schnittgeschwindigkeit vc, Zahnvorschub (Faktor × Ø,
 * höchstens fz max) und Zustellung (Faktor × Ø). Eingebaute Materialien kann man ändern und zurücksetzen,
 * eigene anlegen, umbenennen und löschen. Rechts daneben ein Beispiel (6-mm-Fräser, 2 Schneiden, Hartmetall),
 * damit man sieht, was die Werte bedeuten. Daten und Regeln: toolLibrary.ts.
 */
import { t } from "../i18n/i18n";
import { MATERIALS, materialName, materialEdited, setMaterial, resetMaterial, addMaterial, removeMaterial, calcCutData,
  typeGeom, toolSettings } from "../toolLibrary";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Beispiel-Werkzeug für die Spalte „Beispiel“ */
const SAMPLE = { ...typeGeom("endmill"), diameter: 6, flutes: 2, fluteLen: 22, toolMat: "carbide" as const };

export function openMaterialDb() {
  document.getElementById("matdb-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "matdb-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(860px, calc(100vw - 32px));">
      <h3>📚 ${esc(t("matdb.title"))}</h3>
      <div class="dlg-hint">${esc(t("matdb.desc"))}</div>
      <div class="matdb-wrap"><table class="matdb">
        <thead><tr>
          <th>${esc(t("matdb.name"))}</th>
          <th data-tip="${esc(t("matdb.vcTip"))}">vc<br><small>m/min</small></th>
          <th data-tip="${esc(t("matdb.fzKTip"))}">fz<br><small>× Ø</small></th>
          <th data-tip="${esc(t("matdb.fzMaxTip"))}">fz max<br><small>mm</small></th>
          <th data-tip="${esc(t("matdb.apTip"))}">${esc(t("matdb.ap"))}<br><small>× Ø</small></th>
          <th data-tip="${esc(t("matdb.exTip"))}">${esc(t("matdb.ex"))}<br><small>Ø6 · Z2</small></th>
          <th></th>
        </tr></thead>
        <tbody id="matdb-body"></tbody>
      </table></div>
      <div class="dlg-hint">${esc(t("matdb.hint"))}</div>
      <div class="dlg-buttons">
        <button id="matdb-add" class="btn-secondary">＋ ${esc(t("matdb.add"))}</button>
        <button id="matdb-close" class="btn-primary" style="margin-left:auto;">${esc(t("dlg.close"))}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const body = ov.querySelector("#matdb-body") as HTMLElement;

  const example = (id: string) => {
    const r = calcCutData(SAMPLE, id);
    // an die Grenzen der Maschine gestoßen (Werkzeug-Einstellungen)? Dann sieht man Änderungen hier kaum
    return `S${r.rpm} · F${r.feedrate} · ${r.stepZ} mm` + (r.limited ? ` (${t("matdb.limited")})` : "");
  };
  const render = () => {
    const cell = (id: string, k: string, v: number, step: string) =>
      `<td><input type="number" class="prop-input matdb-in" data-id="${esc(id)}" data-k="${k}" step="${step}" min="0" value="${v}"></td>`;
    body.innerHTML = MATERIALS.map(m => `
      <tr${m.id === toolSettings.material ? ' class="matdb-cur"' : ""}>
        <td>${m.custom
          ? `<input type="text" class="prop-input matdb-name" data-id="${esc(m.id)}" value="${esc(m.name || "")}">`
          : esc(materialName(m.id)) + (materialEdited(m.id) ? ` <span class="tool-scope">${esc(t("matdb.edited"))}</span>` : "")}</td>
        ${cell(m.id, "vc", m.vc, "10")}${cell(m.id, "fzK", m.fzK, "0.001")}${cell(m.id, "fzMax", m.fzMax, "0.005")}${cell(m.id, "ap", m.ap, "0.05")}
        <td class="matdb-ex">${esc(example(m.id))}</td>
        <td>${m.custom
          ? `<button class="btn-secondary btn-icon" data-del="${esc(m.id)}" data-tip="${esc(t("matdb.delTip"))}">🗑</button>`
          : materialEdited(m.id) ? `<button class="btn-secondary btn-icon" data-reset="${esc(m.id)}" data-tip="${esc(t("matdb.resetTip"))}">↺</button>` : ""}</td>
      </tr>`).join("");
  };
  body.addEventListener("change", e => {
    const el = e.target as HTMLInputElement;
    const id = el.dataset.id;
    if (!id) return;
    if (el.classList.contains("matdb-name")) setMaterial(id, { name: el.value });
    else if (el.dataset.k) setMaterial(id, { [el.dataset.k]: parseFloat(el.value) });
    render();
  });
  body.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
    if (!b) return;
    if (b.dataset.reset) { resetMaterial(b.dataset.reset); render(); }
    else if (b.dataset.del && window.confirm(t("matdb.delConfirm", { name: materialName(b.dataset.del) }))) { removeMaterial(b.dataset.del); render(); }
  });
  // Neues Material: Werte vom gewählten Material übernehmen, Name gleich in der Zeile eintippen
  (ov.querySelector("#matdb-add") as HTMLElement).onclick = () => {
    const id = addMaterial(t("matdb.newName", { from: materialName(toolSettings.material) }), toolSettings.material);
    render();
    const inp = body.querySelector<HTMLInputElement>(`.matdb-name[data-id="${id}"]`);
    inp?.scrollIntoView({ block: "nearest" }); inp?.focus(); inp?.select();
  };
  const close = () => ov.remove();
  (ov.querySelector("#matdb-close") as HTMLElement).onclick = close;
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  render();
}
