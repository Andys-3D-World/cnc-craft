/**
 * ❤️ UNTERSTÜTZEN – freiwillig und unaufdringlich
 *
 *  - ❤️-Knopf oben rechts: kleines Fenster mit Ko-fi und GitHub Sponsors
 *  - kleiner Hinweis unten rechts nach dem 5., 25. und 100. fertigen Job (nie öfter, nie mitten in der Arbeit),
 *    mit „Nicht mehr anzeigen“
 *  - keine Funktion hängt davon ab – alles bleibt für alle frei
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "../i18n/i18n";
import { MACHINE_EVENT } from "../machine";

export const KOFI_URL = "https://ko-fi.com/andys3dworld";
export const SPONSORS_URL = "https://github.com/sponsors/Andys-3D-World";
const KEY_JOBS = "cnc_craft_jobs_done";
const KEY_OFF = "cnc_craft_support_tip_off";
const MILESTONES = [5, 25, 100];

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function open(url: string) {
  try { await openUrl(url); } catch { window.open(url, "_blank"); }
}

function get(k: string): string { try { return localStorage.getItem(k) || ""; } catch { return ""; } }
function set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* egal */ } }

/** Kleines Fenster unter dem ❤️-Knopf */
function togglePopover() {
  const old = document.getElementById("support-pop");
  if (old) { old.remove(); return; }
  const btn = document.getElementById("support-btn");
  const pop = document.createElement("div");
  pop.id = "support-pop";
  pop.className = "support-pop";
  pop.innerHTML = `
    <b>❤️ ${esc(t("about.support"))}</b>
    <div class="support-txt">${esc(t("about.supportText"))}</div>
    <button type="button" class="btn-primary" data-url="kofi">☕ ${esc(t("about.supportBtn"))}</button>
    <button type="button" class="btn-secondary" data-url="sponsors">💖 ${esc(t("support.sponsors"))}</button>
    <div class="support-free">${esc(t("support.free"))}</div>`;
  document.body.appendChild(pop);
  if (btn) {
    const r = btn.getBoundingClientRect();
    pop.style.top = `${r.bottom + 8}px`;
    pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  }
  pop.querySelectorAll<HTMLButtonElement>("button[data-url]").forEach(b => b.addEventListener("click", () => {
    void open(b.dataset.url === "kofi" ? KOFI_URL : SPONSORS_URL);
    pop.remove();
  }));
  // Klick daneben oder Esc schließt
  setTimeout(() => {
    const away = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node) && e.target !== btn) { pop.remove(); document.removeEventListener("mousedown", away, true); }
    };
    document.addEventListener("mousedown", away, true);
  }, 0);
  pop.tabIndex = -1;
  pop.addEventListener("keydown", e => { if (e.key === "Escape") pop.remove(); });
}

/** Hinweis unten rechts nach einem Meilenstein */
export function showSupportToast(jobs: number) {
  if (get(KEY_OFF) === "1" || document.getElementById("support-toast")) return;
  const el = document.createElement("div");
  el.id = "support-toast";
  el.className = "support-toast";
  el.innerHTML = `
    <button type="button" class="support-x" data-tip="${esc(t("upd.close"))}">✕</button>
    <div class="support-toast-title">🎉 ${esc(t("support.milestone", { n: jobs }))}</div>
    <div class="support-txt">${esc(t("support.toastText"))}</div>
    <div class="support-toast-btns">
      <button type="button" class="btn-primary" data-act="kofi">☕ ${esc(t("about.supportBtn"))}</button>
      <button type="button" class="btn-secondary" data-act="never">${esc(t("support.never"))}</button>
    </div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelector<HTMLButtonElement>(".support-x")!.onclick = close;
  el.querySelector<HTMLButtonElement>("[data-act=kofi]")!.onclick = () => { void open(KOFI_URL); close(); };
  el.querySelector<HTMLButtonElement>("[data-act=never]")!.onclick = () => { set(KEY_OFF, "1"); close(); };
  setTimeout(close, 30000);   // verschwindet von selbst
}

export function initSupport() {
  document.getElementById("support-btn")?.addEventListener("click", togglePopover);
  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    const { type, data } = (e as CustomEvent).detail || {};
    if (type !== "job-done" || !data || data.aborted) return;
    const n = (parseInt(get(KEY_JOBS), 10) || 0) + 1;
    set(KEY_JOBS, String(n));
    if (MILESTONES.includes(n)) setTimeout(() => showSupportToast(n), 1500);
  });
}
