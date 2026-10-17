/**
 * UPDATE-PRÜFUNG ÜBER GITHUB RELEASES
 *
 * Aktiv für das GitHub-Repository in UPDATE_REPO (gleich unter den Imports): Andys-3D-World/cnc-craft.
 * Das Repository muss öffentlich sein, sonst antwortet GitHub ohne Anmeldung mit „nicht gefunden“.
 * UPDATE_REPO leer setzen = Funktion aus (das Info-Fenster sagt dann „noch nicht aktiviert“).
 *
 * Ablauf:
 *   - Beim Start (höchstens einmal am Tag) oder per Knopf im Info-Fenster werden die
 *     Releases des Repositorys gelesen (GitHub-API, ohne Anmeldung, nur veröffentlichte –
 *     Entwürfe nicht). Beta-Versionen (Pre-Release) nur, wenn „Beta-Versionen anbieten“ an ist.
 *   - Ist eine neuere Version da, erscheint oben ein Knopf „⬆ v0.2.0“. Das Info-Fenster
 *     zeigt die Änderungen und lädt die passende Datei für dieses System herunter
 *     (Mac: .dmg passend zu Apple Silicon/Intel, Windows: -setup.exe, Linux: .AppImage).
 *     Der Download läuft im Browser; danach wie gewohnt installieren.
 *
 * Version und System kommen aus dem Rust-Teil (Befehl app_info, Version aus tauri.conf.json).
 */
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "../i18n/i18n";

/** GitHub-Repository "besitzer/name" – leer = Update-Funktion aus */
export const UPDATE_REPO = "Andys-3D-World/cnc-craft";

/**
 * Repository, das tatsächlich benutzt wird. Zum Ausprobieren vor dem Aktivieren lässt es sich
 * in der Entwickler-Konsole setzen: localStorage.setItem("cnc_craft_update_repo_test", "besitzer/name")
 */
export function updateRepo(): string {
  let test = "";
  try { test = localStorage.getItem("cnc_craft_update_repo_test") || ""; } catch { /* egal */ }
  return (UPDATE_REPO || test).trim();
}

const KEY_SET = "cnc_craft_update_settings";
const KEY_LAST = "cnc_craft_update_last_check";
const DAY = 20 * 3600 * 1000; // „einmal am Tag“ (mit etwas Luft)

export interface AppInfo { version: string; os: string; arch: string }
export interface Asset { name: string; size: number; browser_download_url: string }
export interface Release { tag_name: string; name: string; body: string; html_url: string; draft: boolean; prerelease: boolean; published_at: string; assets: Asset[] }
export interface UpdateSettings { auto: boolean; betas: boolean; skip: string }
export interface UpdateResult { current: string; latest: Release | null; newer: boolean; asset: Asset | null }

export const updateSettings: UpdateSettings = { auto: true, betas: true, skip: "" };
export let lastResult: UpdateResult | null = null;
export const UPDATE_EVENT = "cnc-update-state";

function loadSettings() {
  try { Object.assign(updateSettings, JSON.parse(localStorage.getItem(KEY_SET) || "{}")); } catch { /* Standard */ }
}
export function saveSettings(s: Partial<UpdateSettings>) {
  Object.assign(updateSettings, s);
  try { localStorage.setItem(KEY_SET, JSON.stringify(updateSettings)); } catch { /* egal */ }
}

export function updatesEnabled(repo = updateRepo()): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(repo.trim());
}

let info: AppInfo | null = null;
export async function appInfo(): Promise<AppInfo> {
  if (info) return info;
  try { info = await invoke<AppInfo>("app_info"); } catch { info = { version: "0.0.0", os: "", arch: "" }; }
  return info;
}

// ---------------------------------------------------------------------
// Versionen vergleichen: "v0.2.0-beta.3" < "0.2.0" < "0.2.1-beta"
// ---------------------------------------------------------------------
interface Ver { nums: number[]; pre: string[] }
export function parseVersion(s: string): Ver | null {
  const m = String(s).trim().replace(/^v/i, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { nums: [+m[1], +(m[2] || 0), +(m[3] || 0)], pre: m[4] ? m[4].split(".") : [] };
}
/** >0: a ist neuer als b */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (!x.pre.length && y.pre.length) return 1;   // fertige Version ist neuer als ihre Beta
  if (x.pre.length && !y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** Passende Datei für dieses System */
export function pickAsset(assets: Asset[], os: string, arch: string): Asset | null {
  const has = (re: RegExp) => assets.filter(a => re.test(a.name));
  if (os === "macos") {
    const dmg = has(/\.dmg$/i);
    const own = arch === "aarch64" ? /aarch64|arm64/i : /x64|x86_64|intel/i;
    return dmg.find(a => own.test(a.name)) || dmg.find(a => /universal/i.test(a.name)) || null;
  }
  if (os === "windows") {
    const win = arch === "aarch64" ? /arm64/i : /x64|x86_64|amd64/i;
    const exe = has(/-setup\.exe$/i), msi = has(/\.msi$/i);
    return exe.find(a => win.test(a.name)) || msi.find(a => win.test(a.name)) || exe[0] || msi[0] || null;
  }
  if (os === "linux") {
    const lx = arch === "aarch64" ? /aarch64|arm64/i : /amd64|x86_64/i;
    const app = has(/\.AppImage$/i), deb = has(/\.deb$/i);
    return app.find(a => lx.test(a.name)) || deb.find(a => lx.test(a.name)) || app[0] || deb[0] || null;
  }
  return null;
}

/** Releases lesen und das neueste passende heraussuchen */
export async function checkForUpdate(repo = updateRepo()): Promise<UpdateResult> {
  const me = await appInfo();
  const res = await fetch(`https://api.github.com/repos/${repo.trim()}/releases?per_page=20`, {
    headers: { Accept: "application/vnd.github+json" }
  });
  if (res.status === 404) throw new Error("repo-not-found");
  if (res.status === 403 || res.status === 429) throw new Error("rate-limit");
  if (!res.ok) throw new Error("http-" + res.status);
  const list = (await res.json()) as Release[];
  const usable = (Array.isArray(list) ? list : []).filter(r => !r.draft && (updateSettings.betas || !r.prerelease) && parseVersion(r.tag_name));
  usable.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const latest = usable[0] || null;
  const newer = !!latest && compareVersions(latest.tag_name, me.version) > 0;
  const result: UpdateResult = { current: me.version, latest, newer, asset: latest ? pickAsset(latest.assets || [], me.os, me.arch) : null };
  lastResult = result;
  try { localStorage.setItem(KEY_LAST, String(Date.now())); } catch { /* egal */ }
  window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail: result }));
  return result;
}

export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m === "repo-not-found") return t("upd.err.repo");
  if (m === "rate-limit") return t("upd.err.rate");
  return t("upd.err.net");
}

/** Download im Browser starten (oder Release-Seite, wenn keine passende Datei dabei ist) */
export async function openDownload(r: UpdateResult) {
  const url = r.asset ? r.asset.browser_download_url : r.latest?.html_url;
  if (!url) return;
  try { await openUrl(url); } catch { window.open(url, "_blank"); }
}

/** Beim Start: einmal am Tag still prüfen */
export function initUpdater(log: (s: string) => void) {
  loadSettings();
  if (!updatesEnabled() || !updateSettings.auto) return;
  let last = 0;
  try { last = +(localStorage.getItem(KEY_LAST) || 0); } catch { /* egal */ }
  if (Date.now() - last < DAY) return;
  setTimeout(async () => {
    try {
      const r = await checkForUpdate();
      if (r.newer && r.latest && r.latest.tag_name !== updateSettings.skip) log(t("upd.log.found", { v: r.latest.tag_name }));
    } catch { /* offline o. Ä. – beim Start nicht stören */ }
  }, 4000);
}
