/**
 * WERKSTATT-SYNC (Bibliotheken zwischen Büro und Werkstatt gleich halten)
 *
 * Beide Rechner wählen denselben Ordner (NAS/Netzlaufwerk, Dropbox, USB-Stick). Darin legt Rust
 * (libsync.rs) „cnc-craft-sync/tools.json“, „laser.json“ und „plasma.json“ an. Abgleich je Eintrag:
 * der neuere gewinnt, Gelöschtes bleibt gelöscht (Grabsteine, syncStamp.ts). Kein Netzwerk-Suchen,
 * kein offener Port – nur Dateien.
 *
 * Ablauf eines Abgleichs:
 *   1. je Bibliothek: lokaler Stand (+ Grabsteine + Reihenfolge) an Rust -> gemischter Stand zurück
 *      (Rust schreibt ihn gleich in den Ordner, mit Sperre gegen gleichzeitiges Schreiben)
 *   2. ändert sich hier etwas (oder ist es der erste Abgleich): erst eine Sicherung im App-Datenordner
 *      (backups/library-sync-….json, Format wie libraryBackup.ts)
 *   3. Stand übernehmen – die Bibliotheken prüfen alles mit ihrem sanitize
 *
 * Automatisch (wenn eingeschaltet): beim Wechsel ins Fenster, kurz nach Änderungen und jede Minute.
 * Abgeglichen werden nur die Einträge – nicht die Maschinen-Einstellungen und nicht der Standard-Eintrag.
 * Einstellungen unter cnc_craft_sync (Ordner, an/aus, Name dieses Rechners).
 */
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n/i18n";
import { SyncKind, deviceId, getMeta, saveMeta } from "./syncStamp";
import { getTools, applySyncedTools, TOOLS_CHANGED } from "./toolLibrary";
import { getLayers, applySyncedLayers, LAYERS_CHANGED } from "./laserLayers";
import { getCuts, applySyncedCuts, PLASMA_CHANGED } from "./plasmaCuts";
import { buildLibFile, ALL_KINDS } from "./libraryBackup";

const KEY = "cnc_craft_sync";
const FORMAT = "cnc-craft-sync";
const KINDS: SyncKind[] = ["tools", "laser", "plasma"];
const INTERVAL_MS = 60_000;
const AFTER_CHANGE_MS = 8_000;

export interface SyncConfig { enabled: boolean; folder: string; name: string }
interface Summary { added: number; updated: number; removed: number; copies: number; broken: boolean }
interface SyncResult { entries: any[]; order: { ids: string[]; updated: number; device: string }; summary: Summary; from: string }

export const SYNC_CHANGED = "cnc-sync-changed";

let cfg: SyncConfig = { enabled: false, folder: "", name: "" };
let log: (s: string) => void = () => {};
let running: Promise<boolean> | null = null;
let applying = false;
let changeTimer: ReturnType<typeof setTimeout> | null = null;
let lastError = "";

export function syncConfig(): SyncConfig { return cfg; }
export function syncLastError(): string { return lastError; }
export function syncLastTime(): number { return getMeta().lastSync; }
export function syncBusy(): boolean { return running !== null; }

function load() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || "{}");
    cfg = {
      enabled: !!c.enabled,
      folder: typeof c.folder === "string" ? c.folder : "",
      name: typeof c.name === "string" ? c.name.slice(0, 40) : ""
    };
  } catch { /* Standardwerte */ }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* gesperrt */ }
  window.dispatchEvent(new CustomEvent(SYNC_CHANGED));
}

export function setSyncConfig(c: Partial<SyncConfig>) {
  if (c.enabled !== undefined) cfg.enabled = !!c.enabled;
  // Pfad genau so behalten, wie der Dialog ihn geliefert hat
  if (c.folder !== undefined) cfg.folder = String(c.folder);
  if (c.name !== undefined) cfg.name = String(c.name).trim().slice(0, 40);
  save();
}

/** Ordner über den Dialog wählen (true = gewählt) */
export async function chooseSyncFolder(): Promise<boolean> {
  const p = await open({ directory: true, multiple: false, title: t("sync.chooseTitle") });
  if (!p || Array.isArray(p)) return false;
  setSyncConfig({ folder: String(p) });
  return true;
}

function current(kind: SyncKind): any[] {
  return kind === "tools" ? getTools() : kind === "laser" ? getLayers() : getCuts();
}

/** Lokaler Stand im Sync-Format: lebende Einträge, Grabsteine, Reihenfolge */
function localDoc(kind: SyncKind): string {
  const dev = deviceId();
  const m = getMeta()[kind];
  // Einträge ohne Gerät stammen von hier (alte Bibliothek)
  const alive = current(kind).map(x => ({ ...x, device: x.device || dev }));
  const ids = new Set(alive.map(x => x.id));
  const tombs = m.tombstones.filter(x => !ids.has(x.id));
  return JSON.stringify({
    format: FORMAT,
    entries: [...alive, ...tombs],
    order: { ids: alive.map(x => x.id), updated: m.order.updated, device: m.order.device }
  });
}

function apply(kind: SyncKind, r: SyncResult): boolean {
  const alive = r.entries.filter(e => e && !e.deleted);
  const order = Array.isArray(r.order?.ids) ? r.order.ids.map(String) : [];
  const ok = kind === "tools" ? applySyncedTools(alive, order)
    : kind === "laser" ? applySyncedLayers(alive, order)
    : applySyncedCuts(alive, order);
  if (!ok) return false;
  const m = getMeta()[kind];
  m.tombstones = r.entries.filter(e => e && e.deleted && typeof e.id === "string")
    .map(e => ({ id: String(e.id), deleted: true as const, updated: Math.max(0, Math.round(+e.updated) || 0), device: String(e.device || "") }));
  m.order = { updated: Math.max(0, Math.round(+r.order?.updated) || 0), device: String(r.order?.device || "") };
  return true;
}

function errText(e: unknown): string {
  const s = String(e);
  const k = "sync.err." + s;
  return t(k) !== k ? t(k) : s;
}

/** Ein Abgleich aller Bibliotheken. manual = auch „alles aktuell“ melden. true = geklappt */
export function syncNow(manual = false): Promise<boolean> {
  if (running) return running;
  running = doSync(manual).finally(() => { running = null; window.dispatchEvent(new CustomEvent(SYNC_CHANGED)); });
  window.dispatchEvent(new CustomEvent(SYNC_CHANGED));
  return running;
}

async function doSync(manual: boolean): Promise<boolean> {
  if (!cfg.folder) { if (manual) log(t("sync.needFolder")); return false; }
  const meta = getMeta();
  const first = meta.lastSync === 0;
  const results: [SyncKind, SyncResult][] = [];
  try {
    for (const kind of KINDS) {
      const r = await invoke<SyncResult>("libsync_sync", {
        folder: cfg.folder, kind, local: localDoc(kind), device: deviceId(), deviceName: cfg.name, now: Date.now()
      });
      results.push([kind, r]);
    }
  } catch (e) {
    lastError = errText(e);
    log(t("sync.log.fail", { e: lastError }));
    return false;
  }
  const changes = results.filter(([, r]) => r.summary.added + r.summary.updated + r.summary.removed + r.summary.copies > 0);
  // vor jeder Änderung hier (und vor dem allerersten Abgleich) den alten Stand sichern
  if (changes.length || first) {
    try {
      const p = await invoke<string>("libsync_backup", { data: JSON.stringify(buildLibFile(ALL_KINDS, "CNC Craft (sync)"), null, 2) });
      if (changes.length) log(t("sync.log.backup", { p }));
    } catch (e) {
      lastError = errText(e);
      log(t("sync.log.backupFail", { e: lastError }));
      return false;
    }
  }
  applying = true;
  try {
    for (const [kind, r] of results) {
      const s = r.summary;
      if (s.broken) log(t("sync.log.broken", { lib: t("lib.io.part." + kind) }));
      const n = s.added + s.updated + s.removed + s.copies;
      if (!apply(kind, r)) continue;
      if (!n) continue;
      const what = [
        s.updated ? t("sync.n.updated", { n: s.updated }) : "",
        s.added ? t("sync.n.added", { n: s.added }) : "",
        s.removed ? t("sync.n.removed", { n: s.removed }) : "",
        s.copies ? t("sync.n.copies", { n: s.copies }) : ""
      ].filter(Boolean).join(", ");
      log(t("sync.log.changes", { lib: t("lib.io.part." + kind), what, from: r.from ? t("sync.from", { name: r.from }) : "" }));
    }
  } finally {
    applying = false;
  }
  if (!changes.length && manual) log(t("sync.log.upToDate"));
  meta.lastSync = Date.now();
  saveMeta();
  lastError = "";
  return true;
}

function auto() {
  if (cfg.enabled && cfg.folder) void syncNow(false);
}

/** Nach einer Änderung hier kurz warten (mehrere Änderungen zusammen), dann abgleichen */
function onLocalChange() {
  if (applying || !cfg.enabled || !cfg.folder) return;
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => { changeTimer = null; auto(); }, AFTER_CHANGE_MS);
}

export function initLibSync(logFn: (s: string) => void) {
  log = logFn;
  load();
  for (const ev of [TOOLS_CHANGED, LAYERS_CHANGED, PLASMA_CHANGED]) window.addEventListener(ev, onLocalChange);
  window.addEventListener("focus", () => {
    // nicht bei jedem kurzen Fensterwechsel: höchstens alle 10 s
    if (Date.now() - getMeta().lastSync > 10_000) auto();
  });
  setInterval(auto, INTERVAL_MS);
  setTimeout(auto, 3000); // kurz nach dem Start
}
