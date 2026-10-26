/**
 * WERKSTATT-SYNC: Zeitstempel und Grabsteine für die Bibliotheken
 *
 * Jeder Eintrag (Werkzeug, Laser-Ebene, Plasma-Schnitt) trägt
 *   updated – Zeit der letzten Änderung in ms (0 = aus der Zeit vor dem Sync)
 *   device  – Kennung des Rechners, der zuletzt geändert hat
 * Gelöschte Einträge merkt sich dieses Modul als Grabstein, die Reihenfolge der Liste (T1, T2 …)
 * bekommt einen eigenen Zeitstempel. Damit kann libSync.ts entscheiden, welcher Stand neuer ist.
 *
 * Bewusst ohne Abhängigkeiten zu den Bibliotheken (die importieren dieses Modul).
 * Gespeichert unter cnc_craft_sync_device und cnc_craft_sync_meta.
 */

export type SyncKind = "tools" | "laser" | "plasma";

const KEY_DEVICE = "cnc_craft_sync_device";
const KEY_META = "cnc_craft_sync_meta";

export interface Tombstone { id: string; deleted: true; updated: number; device: string }
export interface KindMeta { tombstones: Tombstone[]; order: { updated: number; device: string } }
export interface SyncMeta { tools: KindMeta; laser: KindMeta; plasma: KindMeta; lastSync: number }

let device = "";
let meta: SyncMeta | null = null;

/** Feste, zufällige Kennung dieses Rechners (nur a-z0-9) */
export function deviceId(): string {
  if (device) return device;
  try { device = (localStorage.getItem(KEY_DEVICE) || "").replace(/[^a-z0-9]/g, "").slice(0, 24); } catch { /* gesperrt */ }
  if (!device) {
    device = "d" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    try { localStorage.setItem(KEY_DEVICE, device); } catch { /* gesperrt */ }
  }
  return device;
}

function emptyKind(): KindMeta { return { tombstones: [], order: { updated: 0, device: "" } }; }

export function getMeta(): SyncMeta {
  if (meta) return meta;
  meta = { tools: emptyKind(), laser: emptyKind(), plasma: emptyKind(), lastSync: 0 };
  try {
    const m = JSON.parse(localStorage.getItem(KEY_META) || "{}");
    for (const k of ["tools", "laser", "plasma"] as SyncKind[]) {
      const x = m?.[k];
      if (!x || typeof x !== "object") continue;
      meta[k].tombstones = (Array.isArray(x.tombstones) ? x.tombstones : [])
        .filter((t: any) => t && typeof t.id === "string")
        .map((t: any) => ({ id: cleanId(t.id), deleted: true as const, updated: stampNum(t.updated), device: cleanDevice(t.device) }));
      meta[k].order = { updated: stampNum(x.order?.updated), device: cleanDevice(x.order?.device) };
    }
    meta.lastSync = stampNum(m?.lastSync);
  } catch { /* Standardwerte */ }
  return meta;
}

export function saveMeta() {
  try { localStorage.setItem(KEY_META, JSON.stringify(getMeta())); } catch { /* gesperrt */ }
}

function stampNum(v: any): number {
  const n = Math.round(+v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function cleanDevice(v: any): string {
  return typeof v === "string" ? v.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) : "";
}
function cleanId(v: any): string {
  return String(v).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
}

/** Für sanitize der Bibliotheken: Verwaltungsfelder geprüft übernehmen */
export function syncFields(x: any): { updated: number; device: string } {
  return { updated: stampNum(x?.updated), device: cleanDevice(x?.device) };
}

/** Eintrag als „gerade hier geändert“ markieren */
export function stamp<T extends { updated?: number; device?: string }>(x: T): T {
  x.updated = Date.now();
  x.device = deviceId();
  return x;
}

/** Einträge wurden hier gelöscht -> Grabsteine, damit der andere Rechner sie nicht zurückbringt */
export function noteRemoved(kind: SyncKind, ids: string[]) {
  if (!ids.length) return;
  const m = getMeta()[kind];
  const now = Date.now(), dev = deviceId();
  for (const id of ids) {
    m.tombstones = m.tombstones.filter(t => t.id !== id);
    m.tombstones.push({ id, deleted: true, updated: now, device: dev });
  }
  saveMeta();
}

/** Reihenfolge wurde hier geändert (verschoben, Kopie eingefügt) */
export function noteOrder(kind: SyncKind) {
  getMeta()[kind].order = { updated: Date.now(), device: deviceId() };
  saveMeta();
}

/** Liste nach der gemeinsamen Reihenfolge sortieren (doppelte IDs fallen weg, Unbekannte hinten dran) */
export function sortByOrder<T extends { id: string }>(list: T[], order: string[]): T[] {
  const pos = new Map(order.map((id, i) => [id, i]));
  const seen = new Set<string>();
  return list
    .filter(x => !seen.has(x.id) && !!seen.add(x.id))
    .map((x, i) => ({ x, k: pos.has(x.id) ? pos.get(x.id)! : order.length + i }))
    .sort((a, b) => a.k - b.k)
    .map(a => a.x);
}
