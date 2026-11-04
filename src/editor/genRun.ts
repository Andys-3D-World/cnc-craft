/**
 * NOCHMAL MIT DEM GENERATOR BEARBEITEN – die reine Logik (ohne Fenster, damit sie getestet werden kann)
 *
 * Jede Form aus einem Generator trägt `gen`: Kennung des Laufs, Art des Generators, Einstellungen und ein paar Merkmale.
 * Das liegt direkt an der Form und ist damit automatisch im Projekt, im Rückgängig-Verlauf und in der Zwischenablage.
 * Alte Projekte ohne `gen` funktionieren wie immer: Es gibt dann nur keinen Menü-Eintrag.
 *
 * Merkmale je Form: r = Rolle (Art, Bearbeitung, Anritzen, geschlossen – so wie der Generator sie gemacht hat),
 * f = Punktzahl + Länge (zeigt von Hand geänderte Punkte, ändert sich beim Drehen und Verschieben nicht),
 * p = ein bis zwei Bezugspunkte (zeigen, ob der ganze Lauf nur verschoben/gedreht oder Teile einzeln bewegt wurden).
 *
 * Alles aus `gen` kann aus einer fremden Projektdatei stammen: readGen prüft den Aufbau, sanitizeSettings die Einstellungen,
 * die Fenster prüfen die einzelnen Werte danach noch einmal in ihrem load().
 */
import { groupBounds, newId, rotateShape, shapeToPaths, translateShape, type Pt } from "../shapeTransform.ts";

export interface GenInfo {
  id: string; type: string;
  i: number; n: number;      // Nummer der Form im Lauf, Anzahl aller Formen
  s: Record<string, any>;    // Einstellungen des Fensters
  g?: string;                // ursprüngliche Gruppe
  r: string; f: number[]; p: number[];
}

export interface RunCheck {
  missing: number;    // fehlende Teile (gelöscht, kaputt kopiert oder auf einem anderen Bett)
  extra: number;      // doppelte Teile
  edited: number;     // Punkte geändert, skaliert, umgewandelt
  moved: boolean;     // Teile einzeln bewegt oder gespiegelt
  ungrouped: number;  // Gruppe aufgelöst oder geändert
  angle: number;      // der ganze Lauf wurde um diesen Winkel gedreht (Bogenmaß)
  clean: boolean;     // nichts von Hand geändert
}

const MAX_SETTINGS = 32_000;   // Zeichen – sonst keine Bearbeitung (schützt auch vor riesigen Fremddaten)
const MAX_DEPTH = 5;
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Nur einfache JSON-Werte; alles andere fällt weg. null = unbrauchbar */
export function sanitizeSettings(v: any): Record<string, any> | null {
  const clean = (x: any, depth: number): any => {
    if (typeof x === "boolean") return x;
    if (typeof x === "number") return Number.isFinite(x) ? x : undefined;
    if (typeof x === "string") return x.slice(0, 4000);
    if (depth >= MAX_DEPTH || !x || typeof x !== "object") return undefined;
    if (Array.isArray(x)) return x.slice(0, 1000).map(q => clean(q, depth + 1)).filter(q => q !== undefined);
    const out: Record<string, any> = {};
    for (const k of Object.keys(x).slice(0, 200)) {
      if (BAD_KEYS.has(k)) continue;
      const c = clean(x[k], depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  };
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = clean(v, 0);
  return JSON.stringify(out).length <= MAX_SETTINGS ? out : null;
}

/** Nur Felder, die es in den Standardwerten gibt, und nur mit deren Datentyp */
export function matchDefaults<T extends Record<string, any>>(def: T, raw: any): Partial<T> {
  const out: Record<string, any> = {};
  if (!raw || typeof raw !== "object") return out as Partial<T>;
  for (const k of Object.keys(def)) {
    const d = def[k], v = raw[k];
    if (typeof d === "number") { if (typeof v === "number" && Number.isFinite(v)) out[k] = v; }
    else if (typeof d === "string") { if (typeof v === "string") out[k] = v.slice(0, 4000); }
    else if (typeof d === "boolean") { if (typeof v === "boolean") out[k] = v; }
    else if (Array.isArray(d)) { if (Array.isArray(v)) out[k] = v; }
  }
  return out as Partial<T>;
}

const nums = (a: any): number[] => (Array.isArray(a) ? a.filter(x => typeof x === "number" && Number.isFinite(x)) : []);

/** `gen` einer Form prüfen; null = keine oder kaputte Daten */
export function readGen(shape: any): GenInfo | null {
  const g = shape?.gen;
  if (!g || typeof g !== "object") return null;
  if (typeof g.id !== "string" || !g.id || g.id.length > 40) return null;
  if (typeof g.type !== "string" || !g.type || g.type.length > 40) return null;
  if (!Number.isInteger(g.i) || !Number.isInteger(g.n) || g.i < 0 || g.n < 1 || g.n > 200_000) return null;
  const s = sanitizeSettings(g.s);
  if (!s) return null;
  return { id: g.id, type: g.type, i: g.i, n: g.n, s, g: typeof g.g === "string" ? g.g : undefined,
    r: typeof g.r === "string" ? g.r : "", f: nums(g.f), p: nums(g.p) };
}

/** Rolle einer Form, so wie der Generator sie gemacht hat */
export function roleOf(s: any): string {
  return [s.type, s.millingMode, s.isScore ? 1 : 0, s.closed ? 1 : 0].join("|");
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Punktzahl + Länge */
function signature(s: any): number[] {
  const paths: { pts: Pt[]; closed?: boolean }[] = s.type === "image" ? [{ pts: s.points, closed: true }] : shapeToPaths(s);
  let n = 0, len = 0;
  for (const p of paths) {
    n += p.pts.length;
    for (let i = 1; i < p.pts.length; i++) len += Math.hypot(p.pts[i].x - p.pts[i - 1].x, p.pts[i].y - p.pts[i - 1].y);
    if (p.closed && p.pts.length > 1) len += Math.hypot(p.pts[0].x - p.pts[p.pts.length - 1].x, p.pts[0].y - p.pts[p.pts.length - 1].y);
  }
  return [n, round2(len)];
}

/** Bezugspunkte: x, y, (x, y) */
function anchors(s: any): number[] {
  if (Array.isArray(s.points) && s.points.length) {
    const a = s.points[0], b = s.points[Math.floor(s.points.length / 2)];
    return [a.x, a.y, b.x, b.y].map(round2);
  }
  if (s.type === "circle") return [s.x, s.y].map(round2);
  return [s.x, s.y, s.x + s.w, s.y + s.h].map(round2);
}

/** Formen eines Laufs kennzeichnen. roles: Rollen von vor dem Übertragen der Einstellungen */
export function tagRun(made: any[], type: string, settings: any, roles?: string[]): string | null {
  const s = sanitizeSettings(settings);
  if (!s || !made.length) return null;
  const id = newId();
  made.forEach((q, i) => {
    q.gen = { id, type, i, n: made.length, s, ...(q.groupId ? { g: q.groupId } : {}),
      r: roles?.[i] ?? roleOf(q), f: signature(q), p: anchors(q) };
  });
  return id;
}

/** Wie stark wurde der Lauf von Hand verändert? */
export function checkRun(parts: any[]): RunCheck {
  const items = parts.map(s => ({ s, g: readGen(s) })).filter(x => x.g) as { s: any; g: GenInfo }[];
  const n = items[0]?.g.n ?? 0;
  const seen = new Set<number>();
  let extra = 0, edited = 0, ungrouped = 0;
  const groups = new Map<string, string>();
  const rigid: { from: Pt; to: Pt }[] = [];
  for (const { s, g } of items) {
    if (seen.has(g.i)) extra++;
    seen.add(g.i);
    const sig = signature(s);
    const changed = g.f.length !== 2 || sig[0] !== g.f[0] || Math.abs(sig[1] - g.f[1]) > 0.1;
    if (changed) edited++;
    // Gruppen zählen nach Aufteilung, nicht nach Namen: Kopien bekommen neue Namen, bleiben aber gleich aufgeteilt
    const was = g.g ?? "", now = s.groupId ?? "";
    if (!was) { if (now) ungrouped++; }
    else if (!now || (groups.has(was) && groups.get(was) !== now)) ungrouped++;
    else groups.set(was, now);
    if (!changed) {
      const a = anchors(s);
      if (a.length === g.p.length) for (let k = 0; k + 1 < a.length; k += 2)
        rigid.push({ from: { x: g.p[k], y: g.p[k + 1] }, to: { x: a[k], y: a[k + 1] } });
    }
  }
  const { moved, angle } = rigidFit(rigid);
  const missing = Math.max(0, n - seen.size);
  return { missing, extra, edited, moved, ungrouped, angle, clean: !missing && !extra && !edited && !moved && !ungrouped };
}

/** Passen alle Punkte zu EINER Verschiebung + Drehung? */
function rigidFit(pairs: { from: Pt; to: Pt }[]): { moved: boolean; angle: number } {
  if (pairs.length < 2) return { moved: false, angle: 0 };
  const a = pairs[0];
  let far = a, best = 0;
  for (const q of pairs) {
    const d = Math.hypot(q.from.x - a.from.x, q.from.y - a.from.y);
    if (d > best) { best = d; far = q; }
  }
  let angle = 0;
  if (best > 1) {
    angle = Math.atan2(far.to.y - a.to.y, far.to.x - a.to.x) - Math.atan2(far.from.y - a.from.y, far.from.x - a.from.x);
    angle = Math.atan2(Math.sin(angle), Math.cos(angle));
    if (Math.abs(angle) < 1e-3) angle = 0;
  }
  const c = Math.cos(angle), sn = Math.sin(angle);
  for (const q of pairs) {
    const dx = q.from.x - a.from.x, dy = q.from.y - a.from.y;
    const x = a.to.x + dx * c - dy * sn, y = a.to.y + dx * sn + dy * c;
    if (Math.hypot(x - q.to.x, y - q.to.y) > 0.3) return { moved: true, angle: 0 };
  }
  return { moved: false, angle };
}

/** Bearbeitungs-Einstellungen, die von Hand gesetzt sein können und das neue Teil behalten soll */
const KEEP = ["millingMode", "millingDepth", "toolId", "laserLayerId", "plasmaCutId", "tabN", "tabLen", "tabH"];

/**
 * Einstellungen von den alten auf die neuen Formen übertragen.
 * Gleicher Aufbau: Form für Form. Sonst je Rolle – aber nur Werte, die bei allen alten Formen dieser Rolle gleich sind.
 */
export function carrySettings(oldParts: any[], made: any[]) {
  const olds = oldParts.map(s => ({ s, g: readGen(s) })).filter(x => x.g) as { s: any; g: GenInfo }[];
  if (!olds.length) return;
  const roles = made.map(roleOf);
  const same = olds[0].g.n === made.length && olds.length === made.length && olds.every(o => roles[o.g.i] === o.g.r);
  const copy = (from: any, to: any, keys: string[]) => {
    for (const k of keys) if (from[k] !== undefined) to[k] = from[k];
    // Gravur-Einstellungen eines Bildes bleiben; das Bild selbst und die Maske kommen vom neuen Lauf
    if (to.type === "image" && from.type === "image" && from.img && to.img) {
      const { src, pw, ph, mask, ...rest } = from.img;
      to.img = { ...to.img, ...rest };
    }
  };
  if (same) { for (const o of olds) copy(o.s, made[o.g.i], KEEP); return; }
  made.forEach((m, i) => {
    const list = olds.filter(o => o.g.r === roles[i]);
    if (!list.length) return;
    const keys = KEEP.filter(k => list.every(o => o.s[k] === list[0].s[k]));
    copy(list[0].s, m, keys);
  });
}

/**
 * Alte Formen durch neue ersetzen: gleiche Stelle in der Zeichenreihenfolge, gleiche linke untere Ecke,
 * und falls der ganze Lauf gedreht war, auch die neuen Teile drehen. made wird dabei verändert.
 * Rückgabe: die neue Liste aller Formen
 */
export function replaceRun(all: any[], oldIds: Set<string>, made: any[], angle = 0): any[] {
  const madeIds = new Set(made.map(s => s.id));
  const old = all.filter(s => oldIds.has(s.id));
  const oldB = groupBounds(old);
  if (angle) {
    const b = groupBounds(made);
    if (b) { const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2; made.forEach(s => rotateShape(s, cx, cy, angle)); }
  }
  const nb = groupBounds(made);
  if (oldB && nb) made.forEach(s => translateShape(s, oldB.minX - nb.minX, oldB.minY - nb.minY));
  const out: any[] = [];
  let placed = false;
  for (const s of all) {
    if (madeIds.has(s.id)) continue;
    if (oldIds.has(s.id)) { if (!placed) { out.push(...made); placed = true; } continue; }
    out.push(s);
  }
  if (!placed) out.push(...made);
  return out;
}

// =====================================================================
// EINSTELLUNGEN ZWISCHEN FENSTER UND MECHANISMUS
// =====================================================================

export interface EditImage { name: string; bytes: Uint8Array; ratio: number; src: string }

let editJson: string | null = null;  // beim Bearbeiten: diese Einstellungen statt der zuletzt benutzten
let editPics: EditImage[] = [];
let saved: any = null;               // was das Fenster bei OK gespeichert hat

/** Ersetzt localStorage.getItem im load() der Generator-Fenster */
export function loadSettings(key: string): string | null {
  if (editJson !== null) return editJson;
  try { return localStorage.getItem(key); } catch { return null; }
}

/** Ersetzt localStorage.setItem beim OK der Generator-Fenster */
export function saveSettings(key: string, o: any) {
  saved = o;
  try { localStorage.setItem(key, JSON.stringify(o)); } catch { /* egal */ }
}

/** Lauf soll nicht bearbeitbar werden (hängt an etwas, das nicht zum Lauf gehört) */
export function forgetSettings() { saved = null; }

/** Gespeicherte Einstellungen abholen (nur einmal) */
export function takeSettings(): any {
  const s = saved;
  saved = null;
  return s;
}

/** Fenster mit diesen Werten öffnen – die Fenster lesen sie beim Öffnen (gleich, nicht später) */
export function withSettings(settings: Record<string, any>, pics: EditImage[], open: () => void) {
  editJson = JSON.stringify(settings);
  editPics = pics;
  try { open(); } finally { editJson = null; editPics = []; }
}

/** Beim Öffnen: Bilder des alten Laufs (sie liegen nur an den Formen) */
export function editImages(): EditImage[] { return editPics; }

/** Bild einer Form wieder als Datei-Inhalt. null = kein sauberes eingebettetes PNG/JPEG */
export function imageOfShape(s: any): EditImage | null {
  const src = s?.img?.src, m = typeof src === "string" ? /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(src) : null;
  const pw = Number(s?.img?.pw), ph = Number(s?.img?.ph);
  if (!m || !(pw > 0) || !(ph > 0)) return null;
  const raw = atob(m[2]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const base = String(s.source || "image").replace(/\.[a-z0-9]+$/i, "").slice(0, 70);
  return { name: `${base}.${m[1] === "png" ? "png" : "jpg"}`, bytes, ratio: ph / pw, src };
}
