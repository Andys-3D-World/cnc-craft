/**
 * FESTE SPANNPLÄTZE (reine Rechnung, Tests in tests/places.test.ts)
 *
 * Ein Platz ist eine feste Stelle der Maschine in MASCHINEN-Koordinaten (gezählt ab der Referenzfahrt): die Ecke am
 * Anschlag oder an der festen Backe eines Schraubstocks. Das Rohteil liegt immer mit derselben Ecke dort an.
 * Aus Platz + Rohteil-Maßen folgt der X/Y-Nullpunkt. Z gehört nie dazu: das ändert sich mit Werkzeug und Materialdicke.
 *
 * Es fährt nichts: der Nullpunkt wird mit G10 L20 aus der aktuellen Stelle gerechnet (so zählt auch ein G92 richtig mit).
 */
import { WCS_LIST } from "./wcs.ts";

export type Corner = "bl" | "br" | "tl" | "tr";
export const CORNERS: Corner[] = ["tl", "tr", "bl", "br"];
export type PlaceKind = "stop" | "vise";
/** Spannrichtung des Schraubstocks: die Backen drücken entlang Y oder entlang X */
export type ClampAxis = "y" | "x";
export interface XY { x: number; y: number }
/** Rohteil in Zeichnungs-Koordinaten (mm): linke untere Ecke und Größe */
export interface Rect { x: number; y: number; w: number; h: number }

export interface Place {
  id: string;
  name: string;
  mode: string;        // Maschinenart
  machine: string;     // Maschinen-Profil ("" = ohne)
  x: number; y: number; // Maschinen-Koordinaten der festen Ecke
  corner: Corner;      // diese Ecke des Rohteils liegt dort an
  wcs: string;         // "" = das gerade gewählte System, sonst G54 … G59
  kind: PlaceKind;
  clamp: ClampAxis;
  jawW: number;        // Breite der Backen
  jawD: number;        // Dicke der Backen
  jawOff: number;      // so weit steht die Backe über die feste Ecke hinaus
  jawZ: number;        // Oberkante der Backen über der Material-Oberseite (negativ = darunter)
}

export const MAX_PLACES = 40, MAX_PLACE_NAME = 40;
export const JAW_DEFAULTS = { clamp: "y" as ClampAxis, jawW: 100, jawD: 20, jawOff: 0, jawZ: -5 };
const MODES = ["mill", "laser", "plasma"];

const num = (v: any, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : d);

/** Ein Eintrag aus dem Speicher. null = unbrauchbar (ohne gültige Stelle wird nichts geraten) */
export function cleanPlace(raw: any): Place | null {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, MAX_PLACE_NAME) : "";
  const x = num(raw.x, -20000, 20000, NaN), y = num(raw.y, -20000, 20000, NaN);
  if (!name || !MODES.includes(raw.mode) || !Number.isFinite(x) || !Number.isFinite(y) || !CORNERS.includes(raw.corner)) return null;
  if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(raw.id)) return null;
  return {
    id: raw.id, name, mode: raw.mode, x, y, corner: raw.corner,
    machine: typeof raw.machine === "string" ? raw.machine.slice(0, 200) : "",
    wcs: (WCS_LIST as readonly string[]).includes(raw.wcs) ? raw.wcs : "",
    kind: raw.kind === "vise" ? "vise" : "stop",
    clamp: raw.clamp === "x" ? "x" : "y",
    jawW: num(raw.jawW, 1, 2000, JAW_DEFAULTS.jawW), jawD: num(raw.jawD, 1, 500, JAW_DEFAULTS.jawD),
    jawOff: num(raw.jawOff, -1000, 1000, JAW_DEFAULTS.jawOff), jawZ: num(raw.jawZ, -500, 500, JAW_DEFAULTS.jawZ)
  };
}

export function cleanPlaces(raw: any): Place[] {
  if (!Array.isArray(raw)) return [];
  const out: Place[] = [];
  for (const r of raw) {
    const p = cleanPlace(r);
    if (p && !out.some(o => o.id === p.id)) out.push(p);
    if (out.length >= MAX_PLACES) break;
  }
  return out;
}

/** Ecke des Rohteils in Zeichnungs-Koordinaten */
export function cornerPoint(s: Rect, c: Corner): XY {
  return { x: c[1] === "r" ? s.x + s.w : s.x, y: c[0] === "t" ? s.y + s.h : s.y };
}

/** Wo der X/Y-Nullpunkt der Zeichnung in Maschinen-Koordinaten liegen muss */
export function zeroFor(p: Place, s: Rect): XY {
  const c = cornerPoint(s, p.corner);
  return { x: p.x - c.x, y: p.y - c.y };
}

/** Umgekehrt: aus einem schon gesetzten Nullpunkt die feste Ecke */
export function placeFromZero(zero: XY, s: Rect, c: Corner): XY {
  const q = cornerPoint(s, c);
  return { x: zero.x + q.x, y: zero.y + q.y };
}

/** Befehl: die Stelle, an der die Maschine steht, bekommt die Koordinate, die sie vom neuen Nullpunkt aus hat. Nur X/Y */
export function zeroCommandFor(mpos: XY, zero: XY): string {
  const f = (v: number) => (Math.abs(v) < 0.0005 ? 0 : v).toFixed(3);
  return `G10 L20 P0 X${f(mpos.x - zero.x)} Y${f(mpos.y - zero.y)}`;
}

/** Liegt der Nullpunkt der Maschine dort, wo der Platz ihn haben will? */
export function zeroOffset(current: XY, want: XY, tol = 0.02): { ok: boolean; dx: number; dy: number } {
  const dx = current.x - want.x, dy = current.y - want.y;
  return { ok: Math.abs(dx) <= tol && Math.abs(dy) <= tol, dx, dy };
}

/** Backen des Schraubstocks in Zeichnungs-Koordinaten: feste Backe auf der Seite der festen Ecke, bewegliche gegenüber */
export function jaws(p: Place, s: Rect): { fixed: Rect; moving: Rect } | null {
  if (p.kind !== "vise") return null;
  if (p.clamp === "y") {
    const x = p.corner[1] === "l" ? s.x - p.jawOff : s.x + s.w + p.jawOff - p.jawW;
    const top: Rect = { x, y: s.y + s.h, w: p.jawW, h: p.jawD }, bottom: Rect = { x, y: s.y - p.jawD, w: p.jawW, h: p.jawD };
    return p.corner[0] === "t" ? { fixed: top, moving: bottom } : { fixed: bottom, moving: top };
  }
  const y = p.corner[0] === "b" ? s.y - p.jawOff : s.y + s.h + p.jawOff - p.jawW;
  const left: Rect = { x: s.x - p.jawD, y, w: p.jawD, h: p.jawW }, right: Rect = { x: s.x + s.w, y, w: p.jawD, h: p.jawW };
  return p.corner[1] === "l" ? { fixed: left, moving: right } : { fixed: right, moving: left };
}

export type ZeroBlock = "connect" | "grbl" | "rotary" | "back" | "busy" | "home" | "inch" | "";
/** Darf der Nullpunkt gesetzt werden? Grund, warum nicht ("" = ja) */
export function zeroBlocked(o: { connected: boolean; grbl: boolean; rotary: boolean; back: boolean; locked: boolean; homed: boolean; inches: boolean }): ZeroBlock {
  if (!o.connected) return "connect";
  if (!o.grbl) return "grbl";
  if (o.rotary) return "rotary";
  if (o.back) return "back";
  if (o.locked) return "busy";
  if (!o.homed) return "home";
  return o.inches ? "inch" : "";
}
