/**
 * INFO & UPDATES (Knopf ⓘ oben rechts)
 *
 *   - Version, System, Hinweis „Beta“
 *   - Update-Prüfung über GitHub Releases (update/updater.ts):
 *       „Jetzt nach Updates suchen“, automatisch beim Start (einmal am Tag), Beta-Versionen anbieten
 *       neue Version: Änderungen, Download der passenden Datei, Release-Seite, „Überspringen“
 *   - Solange kein Repository eingetragen ist: „Update-Funktion noch nicht aktiviert“
 * Gibt es ein Update, erscheint oben zusätzlich der Knopf „⬆ v…“ (öffnet dieses Fenster).
 */
import { t } from "../i18n/i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import { settingsDir } from "../settingsStore";
import {
  updateRepo, UPDATE_EVENT, updateSettings, saveSettings, updatesEnabled, appInfo, checkForUpdate,
  openDownload, errorText, lastResult, UpdateResult
} from "../update/updater";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
const mb = (n: number) => (n / 1048576).toFixed(1).replace(".", ",") + " MB";
const osName = (os: string, arch: string) =>
  (os === "macos" ? "macOS" : os === "windows" ? "Windows" : os === "linux" ? "Linux" : os || "?") + (arch ? ` (${arch === "aarch64" ? "ARM / Apple Silicon" : arch})` : "");

function showPill(r: UpdateResult | null) {
  const pill = document.getElementById("update-pill");
  if (!pill) return;
  const show = !!r && r.newer && !!r.latest && r.latest.tag_name !== updateSettings.skip;
  pill.style.display = show ? "" : "none";
  if (show) {
    pill.textContent = `⬆ ${r!.latest!.tag_name}`;
    pill.setAttribute("data-tip", t("upd.pillTip", { v: r!.latest!.tag_name }));
  }
}

/** Freiwillige Unterstützung (Ko-fi) */
export const SUPPORT_URL = "https://ko-fi.com/andys3dworld";

export function initAboutDialog(log: (s: string) => void) {
  document.getElementById("about-btn")?.addEventListener("click", () => openAboutDialog(log));
  document.getElementById("update-pill")?.addEventListener("click", () => openAboutDialog(log));
  window.addEventListener(UPDATE_EVENT, (e) => showPill((e as CustomEvent).detail));
  window.addEventListener("cnc-language-changed", () => showPill(lastResult));
}

export async function openAboutDialog(log: (s: string) => void) {
  document.getElementById("about-dialog-overlay")?.remove();
  const me = await appInfo();
  const on = updatesEnabled();
  const ov = document.createElement("div");
  ov.id = "about-dialog-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box about-box" role="dialog">
      <div class="about-head">
        <div class="about-logo">🛠️</div>
        <div>
          <h3>CNC Craft</h3>
          <div class="about-ver">${esc(t("upd.version", { v: me.version }))} <span class="about-beta">Beta</span></div>
          <div class="about-sys">${esc(osName(me.os, me.arch))}</div>
          <div class="about-sys">${esc(t("about.license"))}</div>
        </div>
      </div>
      <div class="about-section">
        <h4>⬆ ${esc(t("upd.title"))}</h4>
        ${on ? `
          <label class="about-check"><input type="checkbox" id="upd-auto" ${updateSettings.auto ? "checked" : ""}> ${esc(t("upd.auto"))}</label>
          <label class="about-check"><input type="checkbox" id="upd-betas" ${updateSettings.betas ? "checked" : ""}> ${esc(t("upd.betas"))}</label>
          <button id="upd-check" class="btn-primary">🔍 ${esc(t("upd.check"))}</button>
          <div id="upd-status" class="about-status"></div>
          <div id="upd-result"></div>
          <div class="about-repo">GitHub: <a href="#" id="upd-repo">${esc(updateRepo())}</a></div>
          <div class="about-status">🔒 ${esc(t("about.privacy"))}</div>
        ` : `<div class="about-status">${esc(t("upd.disabled"))}</div>`}
      </div>
      <div class="about-section about-support">
        <h4>❤️ ${esc(t("about.support"))}</h4>
        <div class="about-status">${esc(t("about.supportText"))}</div>
        <button id="about-kofi" class="btn-secondary">☕ ${esc(t("about.supportBtn"))}</button>
      </div>
      <div class="about-section">
        <h4>💾 ${esc(t("store.title"))}</h4>
        <div class="about-status">${esc(t(settingsDir() ? "store.info" : "store.noFile"))}</div>
        ${settingsDir() ? `<div class="about-path" title="${esc(settingsDir())}">${esc(settingsDir())}</div>` : ""}
      </div>
      <div class="dlg-buttons"><button id="about-close" class="btn-secondary" style="flex:1;">${esc(t("upd.close"))}</button></div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.querySelector<HTMLButtonElement>("#about-close")!.onclick = close;
  ov.querySelector<HTMLButtonElement>("#about-kofi")!.onclick = async () => {
    try { await openUrl(SUPPORT_URL); } catch { window.open(SUPPORT_URL, "_blank"); }
  };
  if (!on) return;

  const status = ov.querySelector("#upd-status") as HTMLElement;
  const box = ov.querySelector("#upd-result") as HTMLElement;
  ov.querySelector<HTMLInputElement>("#upd-auto")!.onchange = (e) => saveSettings({ auto: (e.target as HTMLInputElement).checked });
  ov.querySelector<HTMLInputElement>("#upd-betas")!.onchange = (e) => { saveSettings({ betas: (e.target as HTMLInputElement).checked }); run(); };
  ov.querySelector<HTMLElement>("#upd-repo")!.onclick = (e) => { e.preventDefault(); openDownload({ current: "", newer: false, asset: null, latest: { html_url: `https://github.com/${updateRepo()}/releases` } as any }); };

  const show = (r: UpdateResult) => {
    if (!r.latest) { status.textContent = t("upd.noReleases"); box.innerHTML = ""; return; }
    if (!r.newer) { status.textContent = t("upd.upToDate", { v: r.current }); box.innerHTML = ""; return; }
    const rel = r.latest;
    const date = rel.published_at ? new Date(rel.published_at).toLocaleDateString() : "";
    status.textContent = t("upd.available", { v: rel.tag_name, cur: r.current });
    box.innerHTML = `
      <div class="upd-card">
        <div class="upd-title"><b>${esc(rel.name || rel.tag_name)}</b>${rel.prerelease ? ` <span class="about-beta">Beta</span>` : ""}<span>${esc(date)}</span></div>
        ${rel.body ? `<pre class="upd-notes">${esc(rel.body.slice(0, 4000))}</pre>` : ""}
        ${r.asset
          ? `<button id="upd-dl" class="btn-primary">⬇ ${esc(t("upd.download"))} <small>${esc(r.asset.name)} · ${mb(r.asset.size)}</small></button>`
          : `<div class="about-status">${esc(t("upd.noAsset"))}</div>`}
        <div class="upd-btns">
          <button id="upd-page" class="btn-secondary">🌐 ${esc(t("upd.page"))}</button>
          <button id="upd-skip" class="btn-secondary">${esc(t("upd.skip"))}</button>
        </div>
        <div id="upd-after" class="about-status" style="display:none;">${esc(t("upd.after." + (r.asset ? "dl" : "page")))}</div>
      </div>`;
    const after = box.querySelector("#upd-after") as HTMLElement;
    box.querySelector<HTMLButtonElement>("#upd-dl")?.addEventListener("click", async () => {
      await openDownload(r);
      after.textContent = t("upd.after.dl");
      after.style.display = "";
      log(t("upd.log.download", { f: r.asset!.name }));
    });
    box.querySelector<HTMLButtonElement>("#upd-page")!.onclick = async () => {
      await openDownload({ ...r, asset: null });
    };
    box.querySelector<HTMLButtonElement>("#upd-skip")!.onclick = () => {
      saveSettings({ skip: rel.tag_name });
      showPill(r);
      status.textContent = t("upd.skipped", { v: rel.tag_name });
      box.innerHTML = "";
    };
  };

  const btn = ov.querySelector<HTMLButtonElement>("#upd-check")!;
  async function run() {
    btn.disabled = true;
    status.textContent = t("upd.checking");
    box.innerHTML = "";
    try {
      const r = await checkForUpdate();
      // „Überspringen“ gilt nur für die automatische Prüfung – von Hand gesucht wird alles gezeigt
      show(r);
    } catch (e) {
      status.textContent = errorText(e);
    } finally {
      btn.disabled = false;
    }
  }
  btn.onclick = run;
  // Ergebnis der letzten Prüfung gleich zeigen, sonst sofort suchen
  if (lastResult) show(lastResult); else run();
}
