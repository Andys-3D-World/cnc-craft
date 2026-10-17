/**
 * REITER "WERKZEUGE / LASER-BIBLIOTHEK / PLASMA-BIBLIOTHEK"
 *
 * Ein Reiter für alle drei Bibliotheken:
 *   Fräse  -> Werkzeug-Bibliothek  (ui/toolEditor.ts,   #tool-page)
 *   Laser  -> Laser-Bibliothek     (ui/laserLibPage.ts,  #laser-lib-page)
 *   Plasma -> Plasma-Bibliothek    (ui/plasmaLibPage.ts, #plasma-lib-page)
 *
 * Oben ein Umschalter Fräse / Laser / Plasma: wechselt nur die ANSICHT (data-view am Reiter),
 * der Maschinen-Modus im CAM-Bereich bleibt. Der grüne Punkt zeigt den aktiven Modus.
 * Wechselt man den Maschinen-Modus, springt die Ansicht mit. Zeigt man eine andere Bibliothek
 * als den aktiven Modus, erscheint ein Hinweis mit Knopf „Maschine auf … umschalten“.
 *
 * Rechts die Sicherungs-Leiste (libraryBackup.ts):
 *   ⬇ Exportieren / ⬆ Importieren – nur die gerade gezeigte Bibliothek
 *   🗄 Komplett-Sicherung          – Werkzeuge + Laser + Plasma in einer Datei
 *   ♻ Sicherung laden              – alles aus einer Sicherungsdatei übernehmen
 */
import { t } from "../i18n/i18n";
import { getMachineMode, setMachineMode, MODE_CHANGED, MachineMode } from "../machineMode";
import { exportLibrary, importLibrary, LibKind, ALL_KINDS } from "../libraryBackup";
import { initLaserLibPage, rebuildLaserLibPage } from "./laserLibPage";
import { initPlasmaLibPage, rebuildPlasmaLibPage } from "./plasmaLibPage";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

const KIND_OF: Record<MachineMode, LibKind> = { mill: "tools", laser: "laser", plasma: "plasma" };
const MODE_OF: Record<LibKind, MachineMode> = { tools: "mill", laser: "laser", plasma: "plasma" };
const ICON: Record<LibKind, string> = { tools: "🛠️", laser: "🔦", plasma: "🔥" };

let view: LibKind = "tools";
let log: (s: string) => void = () => {};

/** Gerade gezeigte Bibliothek */
export function currentLibKind(): LibKind {
  return view;
}

/** Andere Bibliothek zeigen (Maschinen-Modus bleibt) */
export function showLibrary(kind: LibKind) {
  view = kind;
  document.getElementById("tab-program")?.setAttribute("data-view", kind);
  syncSwitch();
  syncTips();
  syncNote();
}

function renderSwitch() {
  const sw = document.getElementById("lib-switch");
  if (!sw) return;
  sw.innerHTML = ALL_KINDS.map(k => `
    <button type="button" role="tab" data-kind="${k}" data-tip="${esc(t("lib.sw.tip." + k))}">${ICON[k]} ${esc(t("mode." + MODE_OF[k]))}</button>`).join("");
  sw.querySelectorAll<HTMLButtonElement>("button").forEach(b => b.addEventListener("click", () => showLibrary(b.dataset.kind as LibKind)));
  syncSwitch();
}

function syncSwitch() {
  const active = KIND_OF[getMachineMode()];
  document.querySelectorAll<HTMLButtonElement>("#lib-switch button").forEach(b => {
    const k = b.dataset.kind as LibKind;
    b.classList.toggle("active", k === view);
    b.setAttribute("aria-selected", String(k === view));
    // grüner Punkt = Maschinen-Modus, mit dem gerade gearbeitet wird
    b.querySelector(".lib-sw-dot")?.remove();
    if (k === active) b.insertAdjacentHTML("beforeend", `<span class="lib-sw-dot" data-tip="${esc(t("lib.sw.activeMode"))}"></span>`);
  });
}

/** Hinweis, wenn eine andere Bibliothek als der aktive Modus gezeigt wird */
function syncNote() {
  const note = document.getElementById("lib-mode-note");
  if (!note) return;
  const mode = getMachineMode();
  if (KIND_OF[mode] === view) { note.style.display = "none"; note.innerHTML = ""; return; }
  note.style.display = "";
  note.innerHTML = `<span>${esc(t("lib.sw.note", { lib: t("lib.sw.name." + view), mode: t("mode." + mode) }))}</span>
    <button type="button" class="btn-secondary" id="lib-sw-apply">${ICON[view]} ${esc(t("lib.sw.apply", { mode: t("mode." + MODE_OF[view]) }))}</button>`;
  note.querySelector<HTMLButtonElement>("#lib-sw-apply")!.onclick = () => setMachineMode(MODE_OF[view]);
}

function renderBar() {
  const bar = document.getElementById("lib-bar");
  if (!bar) return;
  const perKind = (base: string) => ALL_KINDS.map(k => `<span data-lib="${k}">${esc(t(base + k))}</span>`).join("");
  bar.innerHTML = `
    <div class="lib-bar-group">
      <button id="lib-export" class="btn-secondary" data-tip-kind="lib.io.exportTip.">⬇ ${perKind("lib.io.export.")}</button>
      <button id="lib-import" class="btn-secondary" data-tip-kind="lib.io.importTip.">⬆ ${perKind("lib.io.import.")}</button>
    </div>
    <div class="lib-bar-group">
      <button id="lib-backup" class="btn-secondary" data-tip="${esc(t("lib.io.backupTip"))}">🗄 ${esc(t("lib.io.backup"))}</button>
      <button id="lib-restore" class="btn-secondary" data-tip="${esc(t("lib.io.restoreTip"))}">♻ ${esc(t("lib.io.restore"))}</button>
    </div>`;
  syncTips();
  bar.querySelector<HTMLButtonElement>("#lib-export")!.onclick = () => exportLibrary([view], log);
  bar.querySelector<HTMLButtonElement>("#lib-import")!.onclick = () => importLibrary([view], log);
  bar.querySelector<HTMLButtonElement>("#lib-backup")!.onclick = () => exportLibrary(ALL_KINDS, log);
  bar.querySelector<HTMLButtonElement>("#lib-restore")!.onclick = () => importLibrary(ALL_KINDS, log);
}

/** Tooltips der Einzel-Knöpfe passend zur gezeigten Bibliothek */
function syncTips() {
  document.querySelectorAll<HTMLElement>("#lib-bar [data-tip-kind]").forEach(b => {
    b.setAttribute("data-tip", t(b.dataset.tipKind + view));
  });
}

export function initLibraryTab(logFn: (s: string) => void) {
  log = logFn;
  renderSwitch();
  renderBar();
  initLaserLibPage();
  initPlasmaLibPage();
  showLibrary(KIND_OF[getMachineMode()]);
  // Maschinen-Modus gewechselt -> Ansicht springt mit
  window.addEventListener(MODE_CHANGED, () => showLibrary(KIND_OF[getMachineMode()]));
  window.addEventListener("cnc-language-changed", () => {
    renderSwitch();
    renderBar();
    syncNote();
    rebuildLaserLibPage();
    rebuildPlasmaLibPage();
  });
}
