/**
 * WERKSTATT-SYNC: Einstellungs-Fenster (Knopf „🔄 Werkstatt-Sync“ in der Sicherungs-Leiste der Bibliotheken)
 *
 * Gemeinsamer Ordner, an/aus, Name dieses Rechners, „Jetzt abgleichen“, letzter Abgleich.
 * Abgleich selbst: libSync.ts. Fremder Text (Ordnerpfad, Fehlertext) nur über esc().
 */
import { t } from "../i18n/i18n";
import {
  syncConfig, setSyncConfig, chooseSyncFolder, syncNow, syncLastTime, syncLastError, syncBusy, SYNC_CHANGED
} from "../libSync";

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/** Text für Knopf-Hinweis und Fenster: „Zuletzt abgeglichen: …“ */
export function syncStatusText(): string {
  const c = syncConfig();
  if (!c.folder) return t("sync.noFolder");
  if (syncBusy()) return t("sync.busy");
  const err = syncLastError();
  if (err) return t("sync.lastError", { e: err });
  const last = syncLastTime();
  return last ? t("sync.last", { time: new Date(last).toLocaleString() }) : t("sync.never");
}

export function openSyncDialog() {
  document.getElementById("sync-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "sync-overlay";
  ov.className = "dlg-overlay";
  document.body.appendChild(ov);

  const render = () => {
    const c = syncConfig();
    const busy = syncBusy();
    ov.innerHTML = `
      <div class="dlg-box lib-io-box sync-box" role="dialog">
        <h3>🔄 ${esc(t("sync.title"))}</h3>
        <div class="sync-intro">${esc(t("sync.intro"))}</div>
        <div class="sync-row">
          <span class="sync-label">${esc(t("sync.folder"))}</span>
          <div class="sync-folder ${c.folder ? "" : "sync-empty"}">${esc(c.folder || t("sync.noFolder"))}</div>
          <button id="sync-choose" class="btn-secondary btn-compact">📁 ${esc(t("sync.choose"))}</button>
        </div>
        <label class="sync-row">
          <span class="sync-label">${esc(t("sync.device"))}</span>
          <input type="text" id="sync-name" maxlength="40" value="${esc(c.name)}" placeholder="${esc(t("sync.devicePh"))}" spellcheck="false">
        </label>
        <label class="sync-check"><input type="checkbox" id="sync-auto" ${c.enabled ? "checked" : ""} ${c.folder ? "" : "disabled"}> ${esc(t("sync.auto"))}</label>
        <div class="sync-status ${syncLastError() ? "sync-err" : ""}" id="sync-status">${esc(syncStatusText())}</div>
        <small class="sync-note">${esc(t("sync.note"))}</small>
        <div class="dlg-buttons">
          <button id="sync-now" class="btn-primary" style="flex:1;" ${c.folder && !busy ? "" : "disabled"}>⟳ ${esc(t("sync.now"))}</button>
          <button id="sync-close" class="btn-secondary" style="flex:1;">${esc(t("dlg.close"))}</button>
        </div>
      </div>`;
    ov.querySelector<HTMLButtonElement>("#sync-choose")!.onclick = async () => {
      try { if (await chooseSyncFolder()) render(); } catch (e) { window.alert(String(e)); }
    };
    ov.querySelector<HTMLInputElement>("#sync-name")!.onchange = (e) => setSyncConfig({ name: (e.target as HTMLInputElement).value });
    ov.querySelector<HTMLInputElement>("#sync-auto")!.onchange = (e) => {
      setSyncConfig({ enabled: (e.target as HTMLInputElement).checked });
      if (syncConfig().enabled) void syncNow(false);
    };
    ov.querySelector<HTMLButtonElement>("#sync-now")!.onclick = () => {
      // Name übernehmen, falls noch nicht mit Enter/Tab bestätigt
      setSyncConfig({ name: ov.querySelector<HTMLInputElement>("#sync-name")!.value });
      void syncNow(true);
    };
    ov.querySelector<HTMLButtonElement>("#sync-close")!.onclick = close;
  };

  // nur Status und Knopf auffrischen – ein halb getippter Name bleibt stehen
  const onChange = () => {
    const st = ov.querySelector<HTMLElement>("#sync-status");
    if (st) { st.textContent = syncStatusText(); st.classList.toggle("sync-err", !!syncLastError()); }
    const now = ov.querySelector<HTMLButtonElement>("#sync-now");
    if (now) now.disabled = !syncConfig().folder || syncBusy();
  };
  const close = () => { window.removeEventListener(SYNC_CHANGED, onChange); ov.remove(); };
  window.addEventListener(SYNC_CHANGED, onChange);
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  render();
}
