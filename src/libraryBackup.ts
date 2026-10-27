/**
 * SICHERUNG DER BIBLIOTHEKEN (Export / Import)
 *
 * Fräswerkzeuge, Laser-Ebenen und Plasma-Schnitte liegen nur im Programm-Speicher (localStorage).
 * Nach einer Neuinstallation, auf einem zweiten Rechner oder zum Weitergeben lassen sie sich
 * als Datei sichern und wieder einlesen.
 *
 * Dateiformat (JSON, Endung .json):
 *   {
 *     "format": "cnc-craft-library", "version": 1, "app": "CNC Craft 0.2.0", "created": "2026-…",
 *     "tools":  { "tools": [...],  "settings": {...}, "active": "t1" },   // Fräse
 *     "laser":  { "layers": [...], "settings": {...}, "active": "L1" },   // Laser
 *     "plasma": { "cuts": [...],   "settings": {...}, "active": "P1" }    // Plasma
 *   }
 * Eine Datei kann einen oder alle drei Teile enthalten (Einzel-Export bzw. Komplett-Sicherung).
 * Fräswerkzeuge lassen sich außerdem aus Fusion-360-Bibliotheken einlesen (.tools / .json, siehe fusionTools.ts).
 * Beim Einlesen werden nur bekannte Felder übernommen und alle Werte geprüft (sanitize).
 *
 * Einlesen, zwei Arten:
 *   Hinzufügen – fehlende Einträge kommen dazu, gleiche werden übersprungen, Einstellungen bleiben
 *   Ersetzen   – Liste, Einstellungen und Standard-Eintrag werden durch die aus der Datei ersetzt
 */
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeFile, readTextFile, readFile } from "@tauri-apps/plugin-fs";
import { t } from "./i18n/i18n";
import { exportToolLibrary, importToolLibrary, getTools, toolSettings } from "./toolLibrary";
import { isFusionLibrary, fusionToTools, unzipJson } from "./fusionTools";
import { exportLaserLibrary, importLaserLibrary, getLayers } from "./laserLayers";
import { exportPlasmaLibrary, importPlasmaLibrary, getCuts } from "./plasmaCuts";
import { appInfo } from "./update/updater";

export type LibKind = "tools" | "laser" | "plasma";
export const ALL_KINDS: LibKind[] = ["tools", "laser", "plasma"];
export const LIB_FORMAT = "cnc-craft-library";

export interface LibFile {
  format: string;
  version: number;
  app?: string;
  created?: string;
  tools?: { tools: any[]; settings?: any; active?: string | null };
  laser?: { layers: any[]; settings?: any; active?: string | null };
  plasma?: { cuts: any[]; settings?: any; active?: string | null };
  /** aus einer Fusion-360-Bibliothek: so viele Einträge waren keine passenden Fräser (Halter, Taster …) */
  fusionSkipped?: number;
}

/** Anzahl Einträge je Teil (für Meldungen) */
export function libCounts(f: LibFile): Record<LibKind, number> {
  return {
    tools: Array.isArray(f.tools?.tools) ? f.tools!.tools.length : 0,
    laser: Array.isArray(f.laser?.layers) ? f.laser!.layers.length : 0,
    plasma: Array.isArray(f.plasma?.cuts) ? f.plasma!.cuts.length : 0
  };
}

/** Sicherung der gewünschten Teile zusammenstellen */
export function buildLibFile(kinds: LibKind[], appName = "CNC Craft"): LibFile {
  const f: LibFile = { format: LIB_FORMAT, version: 1, app: appName, created: new Date().toISOString() };
  if (kinds.includes("tools")) f.tools = exportToolLibrary();
  if (kinds.includes("laser")) f.laser = exportLaserLibrary();
  if (kinds.includes("plasma")) f.plasma = exportPlasmaLibrary();
  return f;
}

/**
 * Datei-Inhalt lesen. Nimmt auch eine nackte Liste (z. B. von Hand gebaut) und errät die Art
 * an den Feldern. Wirft Error("lib-invalid"), wenn nichts Brauchbares drin ist.
 */
export function parseLibFile(text: string): LibFile {
  let data: any;
  try { data = JSON.parse(text.replace(/^﻿/, "")); } catch { throw new Error("lib-invalid"); }
  const f: LibFile = { format: LIB_FORMAT, version: 1 };
  if (Array.isArray(data)) {
    const first = data.find(x => x && typeof x === "object") || {};
    if ("kerf" in first || "pierceDelay" in first) f.plasma = { cuts: data };
    else if ("power" in first || "interval" in first) f.laser = { layers: data };
    else if ("diameter" in first || "feedrate" in first) f.tools = { tools: data };
  } else if (isFusionLibrary(data)) {
    const r = fusionToTools(data, toolSettings.material);
    f.app = "Fusion 360";
    f.tools = { tools: r.tools };
    f.fusionSkipped = r.skipped;
  } else if (data && typeof data === "object") {
    if (data.format && data.format !== LIB_FORMAT) throw new Error("lib-invalid");
    f.app = typeof data.app === "string" ? data.app : undefined;
    f.created = typeof data.created === "string" ? data.created : undefined;
    if (data.tools && Array.isArray(data.tools.tools)) f.tools = data.tools;
    if (data.laser && Array.isArray(data.laser.layers)) f.laser = data.laser;
    if (data.plasma && Array.isArray(data.plasma.cuts)) f.plasma = data.plasma;
  }
  const c = libCounts(f);
  if (!c.tools && !c.laser && !c.plasma) throw new Error("lib-invalid");
  // IDs als Text, sonst verwirft sanitize die Einträge
  const fixIds = (list: any[], prefix: string) => list.forEach((x, i) => {
    if (x && typeof x === "object" && typeof x.id !== "string") x.id = x.id != null ? String(x.id) : `${prefix}${i + 1}`;
  });
  if (f.tools) fixIds(f.tools.tools, "t");
  if (f.laser) fixIds(f.laser.layers, "L");
  if (f.plasma) fixIds(f.plasma.cuts, "P");
  return f;
}

/** Teile aus der Datei übernehmen. Gibt je Teil die Anzahl übernommener Einträge zurück. */
export function applyLibFile(f: LibFile, kinds: LibKind[], replace: boolean): Partial<Record<LibKind, number>> {
  const r: Partial<Record<LibKind, number>> = {};
  if (kinds.includes("tools") && f.tools) r.tools = importToolLibrary(f.tools, replace);
  if (kinds.includes("laser") && f.laser) r.laser = importLaserLibrary(f.laser, replace);
  if (kinds.includes("plasma") && f.plasma) r.plasma = importPlasmaLibrary(f.plasma, replace);
  return r;
}

/** "12 Werkzeuge, 3 Laser-Ebenen" */
export function countsText(c: Partial<Record<LibKind, number>>, kinds: LibKind[] = ALL_KINDS): string {
  return kinds.filter(k => (c[k] || 0) > 0).map(k => t("lib.io.n." + k, { n: c[k] || 0 })).join(", ");
}

function today() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------------------------------------------------------------------
// Bedienung: Datei speichern / öffnen
// ---------------------------------------------------------------------

/** Bibliothek(en) als Datei speichern */
export async function exportLibrary(kinds: LibKind[], log: (s: string) => void) {
  try {
    const single = kinds.length === 1 ? kinds[0] : null;
    const name = `cnc-craft-${single ? t("lib.io.file." + single) : t("lib.io.file.all")}-${today()}.json`;
    const p = await save({
      title: t(single ? "lib.io.exportTitle." + single : "lib.io.backupTitle"),
      defaultPath: name,
      filters: [{ name: t("lib.io.filter"), extensions: ["json"] }]
    });
    if (!p) return;
    let appName = "CNC Craft";
    try { appName = `CNC Craft ${(await appInfo()).version}`; } catch { /* egal */ }
    const f = buildLibFile(kinds, appName);
    await writeFile(String(p), new TextEncoder().encode(JSON.stringify(f, null, 2) + "\n"));
    log(t("lib.io.saved", { what: countsText(libCounts(f), kinds), p: String(p) }));
  } catch (e) {
    log(`${t("log.error")} ${e}`);
  }
}

/**
 * Datei wählen und einlesen. kinds = welche Teile hier übernommen werden dürfen
 * (Einzel-Import: nur der Teil der aktuellen Seite, Sicherung laden: alle).
 */
export async function importLibrary(kinds: LibKind[], log: (s: string) => void) {
  let f: LibFile;
  try {
    const p = await open({
      multiple: false, directory: false,
      title: t(kinds.length === 1 ? "lib.io.importTitle." + kinds[0] : "lib.io.restoreTitle"),
      filters: kinds.includes("tools")
        ? [{ name: t("lib.io.filterFusion"), extensions: ["json", "tools"] }]
        : [{ name: t("lib.io.filter"), extensions: ["json"] }]
    });
    if (!p) return;
    const path = String(typeof p === "object" && p !== null ? (p as any).path : p);
    // Fusion 360 „.tools“ = ZIP mit tools.json
    const text = /\.tools$/i.test(path) ? await unzipJson(await readFile(path)) : await readTextFile(path);
    f = parseLibFile(text);
    if (f.fusionSkipped) log(t("lib.io.fusionSkipped", { n: f.fusionSkipped }));
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    const text = m === "lib-invalid" ? t("lib.io.invalid") : `${t("log.error")} ${m}`;
    log(text);
    window.alert(text);
    return;
  }
  const inFile = libCounts(f);
  const usable = kinds.filter(k => inFile[k] > 0);
  if (!usable.length) {
    const msg = t("lib.io.nothing", { what: t("lib.io.part." + kinds[0]), has: countsText(inFile) });
    log(msg);
    window.alert(msg);
    return;
  }
  const replace = await askImportMode(f, usable);
  if (replace === null) return;
  const r = applyLibFile(f, usable, replace);
  const done = countsText(r, usable);
  log(done ? t(replace ? "lib.io.replaced" : "lib.io.added", { what: done }) : t("lib.io.allKnown"));
}

/** Kleines Fenster: Hinzufügen / Ersetzen / Abbrechen. true = ersetzen, false = hinzufügen, null = Abbruch */
function askImportMode(f: LibFile, kinds: LibKind[]): Promise<boolean | null> {
  return new Promise(resolve => {
    document.getElementById("lib-import-overlay")?.remove();
    const now: Record<LibKind, number> = { tools: getTools().length, laser: getLayers().length, plasma: getCuts().length };
    const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
    const date = f.created ? new Date(f.created) : null;
    const ov = document.createElement("div");
    ov.id = "lib-import-overlay";
    ov.className = "dlg-overlay";
    ov.innerHTML = `
      <div class="dlg-box lib-io-box" role="dialog">
        <h3>⬆ ${esc(t("lib.io.askTitle"))}</h3>
        <div class="lib-io-file">${esc(t("lib.io.inFile", { what: countsText(libCounts(f), kinds) }))}
          ${f.app || date ? `<small>${esc([f.app, date && !isNaN(+date) ? date.toLocaleString() : ""].filter(Boolean).join(" · "))}</small>` : ""}</div>
        <button id="lib-io-add" class="lib-io-choice">
          <b>＋ ${esc(t("lib.io.add"))}</b><span>${esc(t("lib.io.addDesc"))}</span></button>
        <button id="lib-io-replace" class="lib-io-choice lib-io-danger">
          <b>♻ ${esc(t("lib.io.replace"))}</b><span>${esc(t("lib.io.replaceDesc", { what: countsText(now, kinds) }))}</span></button>
        <div class="dlg-buttons"><button id="lib-io-cancel" class="btn-secondary" style="flex:1;">${esc(t("dlg.cancel"))}</button></div>
      </div>`;
    document.body.appendChild(ov);
    const done = (v: boolean | null) => { ov.remove(); resolve(v); };
    ov.addEventListener("mousedown", e => { if (e.target === ov) done(null); });
    ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") done(null); });
    ov.querySelector<HTMLButtonElement>("#lib-io-add")!.onclick = () => done(false);
    ov.querySelector<HTMLButtonElement>("#lib-io-replace")!.onclick = () => {
      if (window.confirm(t("lib.io.replaceConfirm"))) done(true);
    };
    ov.querySelector<HTMLButtonElement>("#lib-io-cancel")!.onclick = () => done(null);
    setTimeout(() => ov.querySelector<HTMLButtonElement>("#lib-io-add")?.focus(), 0);
  });
}
