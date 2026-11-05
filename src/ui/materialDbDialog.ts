/**
 * MATERIAL-DATENBANK (Seite „Werkzeuge“ → Werkzeug-Einstellungen → 📚)
 *
 * Tabelle aller Materialien für den Schnittdaten-Rechner: Schnittgeschwindigkeit vc, Zahnvorschub (Faktor × Ø,
 * höchstens fz max) und Zustellung (Faktor × Ø). Eingebaute Materialien kann man ändern und zurücksetzen,
 * eigene anlegen, umbenennen und löschen. Rechts daneben ein Beispiel (6-mm-Fräser, 2 Schneiden, Hartmetall),
 * damit man sieht, was die Werte bedeuten. Daten und Regeln: toolLibrary.ts.
 * Darüber „Meine Fräs-Profile“: feste Werte, die sich in den Fräs-Parametern mit einem Klick anwenden lassen
 * (millProfiles.ts). Formen behalten ihre Kopie – ein geändertes Profil gilt erst nach erneutem Anwenden.
 */
import { t } from "../i18n/i18n";
import { MATERIALS, materialName, materialEdited, setMaterial, resetMaterial, addMaterial, removeMaterial, calcCutData,
  typeGeom, toolSettings, getTools, getTool, activeTool, toolLabel, toolForShape } from "../toolLibrary";
import { getMillProfiles, addMillProfile, updateMillProfile, removeMillProfile, MillProfile } from "../millProfiles";

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
      <h4 style="margin:10px 0 2px;">${esc(t("mprof.own"))}</h4>
      <div class="dlg-hint">${esc(t("mprof.dbDesc"))}</div>
      <div class="matdb-wrap" style="max-height:26vh;"><table class="matdb">
        <thead><tr>
          <th>${esc(t("mprof.name"))}</th>
          <th data-tip="${esc(t("mprof.toolTip"))}">${esc(t("mprof.tool"))}</th>
          <th data-tip="${esc(t("mprof.diaTip"))}">Ø<br><small>mm</small></th>
          <th>${esc(t("mprof.feed"))}<br><small>mm/min</small></th>
          <th>${esc(t("mprof.rpm"))}<br><small>${esc(t("unit.rpm"))}</small></th>
          <th>${esc(t("matdb.ap"))}<br><small>mm</small></th>
          <th data-tip="${esc(t("mprof.plungeTip"))}">${esc(t("mprof.plunge"))}<br><small>mm/min</small></th>
          <th></th>
        </tr></thead>
        <tbody id="mprof-body"></tbody>
      </table></div>
      <div class="dlg-buttons"><button id="mprof-add" class="btn-secondary" data-tip="${esc(t("mprof.addTip"))}">＋ ${esc(t("mprof.add"))}</button></div>
      <h4 style="margin:10px 0 2px;">${esc(t("matdb.title"))}</h4>
      <div class="dlg-hint">${esc(t("matdb.desc"))}</div>
      <div class="matdb-wrap" style="max-height:30vh;"><table class="matdb">
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
  // ---- Meine Fräs-Profile ----
  const pBody = ov.querySelector("#mprof-body") as HTMLElement;
  const renderProfiles = () => {
    const tools = getTools();
    const num = (p: MillProfile, k: "diameter" | "feedrate" | "rpm" | "stepZ" | "plungeFeed", step: string, ph = "") =>
      `<td><input type="number" class="prop-input matdb-in" data-p="${esc(p.id)}" data-k="${k}" min="0" step="${step}" value="${p[k] ?? ""}"${ph ? ` placeholder="${esc(ph)}"` : ""}></td>`;
    pBody.innerHTML = getMillProfiles().map(p => `
      <tr>
        <td><input type="text" class="prop-input matdb-name" data-p="${esc(p.id)}" data-k="name" maxlength="60" value="${esc(p.name)}"></td>
        <td><select class="prop-input" style="width:120px;" data-p="${esc(p.id)}" data-k="toolId">
          <option value="">–</option>
          ${tools.map(tl => `<option value="${esc(tl.id)}"${tl.id === p.toolId ? " selected" : ""}>${esc(toolLabel(tl))}</option>`).join("")}
        </select></td>
        ${num(p, "diameter", "0.5", "–")}${num(p, "feedrate", "50")}${num(p, "rpm", "500")}${num(p, "stepZ", "0.1")}${num(p, "plungeFeed", "50", t("mprof.auto"))}
        <td><button class="btn-secondary btn-icon" data-pdel="${esc(p.id)}" data-tip="${esc(t("mprof.delTip"))}">🗑</button></td>
      </tr>`).join("");
  };
  pBody.addEventListener("change", e => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const id = el.dataset.p, k = el.dataset.k;
    if (!id || !k) return;
    if (k === "name") updateMillProfile(id, { name: el.value });
    else if (k === "toolId") {
      const tl = getTool(el.value);
      updateMillProfile(id, tl ? { toolId: tl.id, diameter: tl.diameter } : { toolId: undefined });
    } else {
      const v = parseFloat(el.value);
      // Pflichtwerte: leer/ungültig wird nicht übernommen; Ø und Eintauchen dürfen leer sein
      if (k === "diameter" || k === "plungeFeed") updateMillProfile(id, { [k]: v > 0 ? v : undefined });
      else if (v > 0) updateMillProfile(id, { [k]: v });
    }
    renderProfiles();
  });
  pBody.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
    const id = b?.dataset.pdel;
    if (!id) return;
    const p = getMillProfiles().find(x => x.id === id);
    if (p && window.confirm(t("matdb.delConfirm", { name: p.name }))) { removeMillProfile(id); renderProfiles(); }
  });
  // Neues Profil: Werte des Werkzeugs der Auswahl (sonst Standard-Werkzeug) als Startpunkt, Name gleich eintippen
  (ov.querySelector("#mprof-add") as HTMLElement).onclick = () => {
    const st = (window as any).cncState;
    const first = st?.shapes?.find((s: any) => st.selectedShapeIds?.includes(s.id));
    const tl = (first ? toolForShape(first) : activeTool) || getTools()[0];
    if (!tl) return;
    const p = addMillProfile({ name: t("mprof.newName"), toolId: tl.id, diameter: tl.diameter,
      feedrate: tl.feedrate, rpm: tl.rpm > 0 ? tl.rpm : 12000, stepZ: tl.stepZ, plungeFeed: tl.plungeFeed });
    if (!p) return;
    renderProfiles();
    const inp = pBody.querySelector<HTMLInputElement>(`.matdb-name[data-p="${p.id}"]`);
    inp?.scrollIntoView({ block: "nearest" }); inp?.focus(); inp?.select();
  };
  renderProfiles();
  const close = () => ov.remove();
  (ov.querySelector("#matdb-close") as HTMLElement).onclick = close;
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  render();
}
