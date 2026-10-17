/**
 * EINSTELLUNGEN ÜBER UPDATES RETTEN
 *
 * Alle Einstellungen (Werkzeuge, Laser-Ebenen, Plasma-Schnitte, Maschine, Sprache, Bett, Fenster …)
 * liegen im localStorage unter Schlüsseln mit "cnc_craft_". Der bleibt bei Updates normalerweise
 * erhalten – aber nicht immer (andere Herkunft der Seite nach einem Tauri-Update, `tauri dev`
 * gegen fertige App, gelöschter Webview-Speicher). Deshalb:
 *
 *   1. Beim Start (VOR allem anderen, siehe main.ts) wird die Einstellungs-Datei aus dem
 *      App-Datenordner gelesen (Rust: store.rs). Fehlt im localStorage ein Schlüssel, der in der
 *      Datei steht, wird er zurückgeholt. Was im localStorage steht, hat Vorrang.
 *      Ist die Datei kaputt, wird die neueste Tages-Sicherung genommen.
 *   2. Danach wird jede Änderung (setItem/removeItem) kurz gesammelt und als Ganzes in die Datei
 *      geschrieben (+ eine Sicherung pro Tag, 14 Tage).
 *
 * Konnte die Datei beim Start nicht gelesen werden, wird sie zur Sicherheit auch nicht
 * überschrieben – sonst könnten leere Standardwerte einen guten Stand ersetzen.
 */
import { invoke } from "@tauri-apps/api/core";

const PREFIX = "cnc_craft_";
const FORMAT = "cnc-craft-settings";
/** Schlüssel, die nicht mitgesichert werden (nur Kurzzeit-Merker) */
const SKIP = new Set(["cnc_craft_update_last_check"]);

interface StoreRead { dir: string; main: string | null; backups: string[] }
interface SettingsFile { format: string; version: number; saved: string; data: Record<string, string> }

let dir = "";
let writable = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastWritten = "";
let restoredCount = 0;

/** Ordner der Einstellungs-Datei (für das Info-Fenster) */
export function settingsDir(): string { return dir; }
/** Wie viele Einträge beim Start aus der Datei zurückgeholt wurden */
export function settingsRestored(): number { return restoredCount; }

function parse(text: string | null | undefined): SettingsFile | null {
  if (!text) return null;
  try {
    const f = JSON.parse(text);
    if (f && f.format === FORMAT && f.data && typeof f.data === "object") return f as SettingsFile;
  } catch { /* kaputt */ }
  return null;
}

function snapshot(): Record<string, string> {
  const data: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX) || SKIP.has(k)) continue;
      const v = localStorage.getItem(k);
      if (v !== null) data[k] = v;
    }
  } catch { /* gesperrt */ }
  return data;
}

/**
 * Beim Start aufrufen, bevor irgendein Teil Einstellungen liest.
 * Holt fehlende Einträge aus der Datei zurück. Gibt die Anzahl zurückgeholter Einträge zurück.
 */
export async function restoreSettings(): Promise<number> {
  let r: StoreRead | null = null;
  try {
    r = await invoke<StoreRead>("settings_store_read");
  } catch {
    r = null;
  }
  if (!r || typeof r !== "object") return 0; // ohne Rust-Teil (z. B. im Browser): nichts tun, nichts schreiben
  dir = r.dir || "";
  writable = true;
  const file = parse(r.main) || (r.backups || []).map(parse).find(Boolean) || null;
  if (!file) return 0;
  let n = 0;
  try {
    for (const [k, v] of Object.entries(file.data)) {
      if (!k.startsWith(PREFIX) || SKIP.has(k) || typeof v !== "string") continue;
      if (localStorage.getItem(k) === null) { localStorage.setItem(k, v); n++; }
    }
  } catch { /* Speicher gesperrt */ }
  restoredCount = n;
  return n;
}

/** Jetzt in die Datei schreiben (nur wenn sich etwas geändert hat) */
export async function flushSettings(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!writable) return;
  const data = snapshot();
  // Leerer Speicher (z. B. gerade gelöscht) überschreibt nie einen guten Stand in der Datei
  if (Object.keys(data).length === 0) return;
  const body = JSON.stringify(data);
  if (body === lastWritten) return;
  const file: SettingsFile = { format: FORMAT, version: 1, saved: new Date().toISOString(), data };
  try {
    await invoke("settings_store_write", { data: JSON.stringify(file) });
    lastWritten = body;
  } catch (e) {
    console.warn("CNC Craft: Einstellungen konnten nicht in die Datei geschrieben werden", e);
  }
}

function schedule() {
  if (!writable) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void flushSettings(); }, 1500);
}

/** Änderungen am localStorage beobachten und in die Datei spiegeln */
export function startSettingsMirror() {
  if (!writable) return;
  const proto = Storage.prototype;
  const origSet = proto.setItem, origRemove = proto.removeItem;
  proto.setItem = function (this: Storage, k: string, v: string) {
    origSet.call(this, k, v);
    if (this === localStorage && String(k).startsWith(PREFIX)) schedule();
  };
  proto.removeItem = function (this: Storage, k: string) {
    origRemove.call(this, k);
    if (this === localStorage && String(k).startsWith(PREFIX)) schedule();
  };
  // Beim Verlassen/Verstecken des Fensters sofort sichern
  window.addEventListener("beforeunload", () => { void flushSettings(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void flushSettings(); });
  // Erster Stand (z. B. nach dem allerersten Start oder nach dem Zurückholen)
  void flushSettings();
}
