/**
 * KAMERA AM MASCHINENKOPF: Offset und Fadenkreuz (reine Rechnung, ohne Oberfläche – Tests: `npm test`)
 *
 * Festlegung des Vorzeichens (überall gleich):
 *     Offset = Fadenkreuz-Punkt − Werkzeug-Mitte
 * Beispiel: Die Kamera sitzt 40 mm rechts (+X) und 10 mm vor (−Y) dem Fräser → Offset X = +40, Y = −10.
 *
 * Daraus folgt alles Weitere:
 *   - Zeigt das Fadenkreuz auf Punkt P, steht das Werkzeug bei P − Offset. Soll P der neue Nullpunkt sein, hat die
 *     aktuelle Position also die Werkstück-Koordinate −Offset: G10 L20 P0 X(−Offset X) Y(−Offset Y). Keine Bewegung.
 *   - Soll das Werkzeug auf P fahren, fährt es um +Offset; danach G10 L20 P0 X0 Y0.
 *   - Messen: Werkzeug macht bei M1 eine Marke; das Fadenkreuz steht auf der Marke, wenn der Kopf bei M2 ist.
 *     Dann gilt M2 + Offset = M1, also Offset = M1 − M2.
 *
 * Immer G10 L20 P0 (aktives System), nie G92 und nie Z.
 */
import { clampJog } from "../jogLimit.ts";
import { zeroCommand } from "../wcs.ts";

export interface Offset { x: number; y: number }

/** Größter sinnvoller Betrag: Eingabefehler (Komma vergessen …) werden so nicht zu einem Nullpunkt weit weg */
export const OFFSET_MAX = 2000;
/** Darunter gilt ein gemessener Offset als „nicht gemessen“ (Kopf wurde zwischen den Schritten kaum bewegt) */
export const MEASURE_MIN = 0.05;
/** So nah muss der Kopf nach der Fahrt am Ziel stehen, sonst wird kein Nullpunkt gesetzt */
export const ARRIVE_TOLERANCE = 0.02;

/** Auf 3 Stellen runden, ohne „-0“ */
const r3 = (v: number): number => { const n = +v.toFixed(3); return n === 0 ? 0 : n; };
const f3 = (v: number): string => r3(v).toFixed(3);

/** Wert aus Eingabefeld oder Einstellungs-Datei: Zahl im erlaubten Bereich oder null (= nicht eingestellt). Komma geht auch */
export function parseOffsetValue(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).trim().replace(",", "."));
  if (!Number.isFinite(n) || Math.abs(n) > OFFSET_MAX) return null;
  return r3(n);
}

export type OffsetProblem = "" | "unset" | "zero";

/** "unset" = fehlt, "zero" = 0/0 (Kamera müsste genau in der Werkzeug-Achse sitzen) */
export function offsetProblem(x: number | null, y: number | null): OffsetProblem {
  if (x === null || y === null) return "unset";
  if (x === 0 && y === 0) return "zero";
  return "";
}

/** Nullpunkt OHNE Fahrt: die aktuelle Position bekommt die Koordinate −Offset. Nur X und Y, Z bleibt unberührt */
export function zeroAtCrosshairCommand(off: Offset): string {
  return `G10 L20 P0 X${f3(-off.x)} Y${f3(-off.y)}`;
}

/** Offset aus zwei Maschinen-Positionen: mark = Werkzeug über der Marke, cross = Fadenkreuz auf der Marke */
export function measureOffset(mark: readonly number[], cross: readonly number[]): Offset {
  return { x: r3(mark[0] - cross[0]), y: r3(mark[1] - cross[1]) };
}

/** Wurde beim Messen wirklich gefahren? */
export function measureIsPlausible(off: Offset): boolean {
  return Math.hypot(off.x, off.y) >= MEASURE_MIN && Math.abs(off.x) <= OFFSET_MAX && Math.abs(off.y) <= OFFSET_MAX;
}

export interface DrivePlan {
  /** Fahrweg in X/Y (= Offset) */
  dx: number;
  dy: number;
  /** Länge des Fahrwegs */
  dist: number;
  /** Wie weit Z vorher hochfährt (0 = steht schon hoch genug) */
  lift: number;
  /** Maschinen-Z nach dem Anheben */
  liftTo: number;
  /** Maschinen-Ziel in X/Y – nach der Fahrt wird damit geprüft, ob der Kopf wirklich dort steht */
  target: [number, number];
  /** Befehle der Reihe nach (als Jog: GRBL lehnt sie bei Soft-Limits ab, statt in einen Alarm zu laufen) */
  liftCmd: string;
  moveCmd: string;
  zeroCmd: string;
  /** X/Y-Achsen, bei denen das Ziel außerhalb des Betts läge */
  outside: number[];
}

/**
 * Plan für die Variante MIT Fahrt.
 * @param mpos  Maschinen-Position
 * @param wpos  Werkstück-Position
 * @param safeZ sichere Höhe über dem Werkstück-Nullpunkt (Z)
 * @param topZ  oberste erreichbare Maschinen-Höhe, falls bekannt (null = unbekannt)
 * Z fährt nur hoch, nie runter. Steht das Werkzeug schon höher als safeZ, fährt Z gar nicht.
 */
export function drivePlan(off: Offset, mpos: readonly number[], wpos: readonly number[], safeZ: number, topZ: number | null,
                          bed: { w: number; h: number }, feed: number): DrivePlan {
  const dx = r3(off.x), dy = r3(off.y);
  let liftTo = Math.max(mpos[2], mpos[2] + (safeZ - wpos[2]));
  if (topZ !== null) liftTo = Math.max(mpos[2], Math.min(liftTo, topZ));
  liftTo = r3(liftTo);
  const lift = r3(liftTo - mpos[2]);
  const { clamped } = clampJog([wpos[0], wpos[1], wpos[2]], [dx, dy, 0], bed);
  return {
    dx, dy, dist: r3(Math.hypot(dx, dy)), lift, liftTo,
    target: [r3(mpos[0] + dx), r3(mpos[1] + dy)],
    liftCmd: lift > 0 ? `$J=G53 G21 Z${f3(liftTo)} F${Math.round(feed)}` : "",
    moveCmd: `$J=G91 G21 X${f3(dx)} Y${f3(dy)} F${Math.round(feed)}`,
    zeroCmd: zeroCommand("XY"),
    outside: clamped
  };
}

/** Steht der Kopf am Ziel der Fahrt? */
export function hasArrived(mpos: readonly number[], target: readonly number[]): boolean {
  return Math.abs(mpos[0] - target[0]) <= ARRIVE_TOLERANCE && Math.abs(mpos[1] - target[1]) <= ARRIVE_TOLERANCE;
}

/** Oberste Maschinen-Höhe aus den GRBL-Einstellungen; nur mit Referenzfahrt nach oben bekannt (wie beim Werkzeugwechsel) */
export function topZFromSettings(s: { get(k: string): string | undefined }): number | null {
  const num = (k: string) => parseFloat(s.get(k) || "");
  const homing = (num("$22") | 0) & 1, zDown = (num("$23") | 0) & 4;
  if (!homing || zDown) return null;
  const pull = num("$27");
  return -Math.max(1, Number.isFinite(pull) ? pull : 1);
}

/** Warum gerade kein Nullpunkt gesetzt werden darf ("" = frei) */
export function zeroBlockReason(m: { connected: boolean; protocol: string; jobActive: boolean; state: string; otherBusy: boolean }): string {
  if (!m.connected) return "notConnected";
  if (m.protocol !== "grbl") return "notGrbl";
  if (m.jobActive) return "job";
  if (m.state === "Alarm") return "alarm";
  if (m.otherBusy) return "busy";
  if (m.state !== "Idle") return "notIdle";
  return "";
}

// ---------------------------------------------------------------------
// Fadenkreuz im Bild
// ---------------------------------------------------------------------

/**
 * Die Mitte wird in BILD-Koordinaten gespeichert (−0,5 … 0,5, 0 = Bildmitte), bezogen auf das Kamerabild VOR Drehen und
 * Spiegeln: Sie gehört zur Linse. So wandert das Fadenkreuz beim Drehen/Spiegeln mit dem Bild und zeigt auf denselben Punkt.
 */
export function clampCentre(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-0.5, Math.min(0.5, n));
}

/** Bild → Anzeige und zurück (dieselbe Rechnung: zweimal angewendet ergibt wieder das Original) */
export function flipCentre(cx: number, cy: number, rot180: boolean, mirror: boolean): { x: number; y: number } {
  const sx = (rot180 ? -1 : 1) * (mirror ? -1 : 1), sy = rot180 ? -1 : 1;
  const x = cx * sx, y = cy * sy;
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
}

/** Wo liegt das Bild in der Anzeige? (object-fit: contain = mittig, Seitenverhältnis bleibt, schwarze Ränder) */
export function fittedRect(viewW: number, viewH: number, imgW: number, imgH: number): { x: number; y: number; w: number; h: number } {
  if (!(imgW > 0) || !(imgH > 0)) return { x: 0, y: 0, w: viewW, h: viewH };
  const k = Math.min(viewW / imgW, viewH / imgH);
  const w = imgW * k, h = imgH * k;
  return { x: (viewW - w) / 2, y: (viewH - h) / 2, w, h };
}

/** Bildschirm-Punkt des Fadenkreuzes in der Anzeige */
export function crosshairToPixel(cx: number, cy: number, viewW: number, viewH: number, imgW: number, imgH: number,
                                 rot180: boolean, mirror: boolean): { x: number; y: number } {
  const r = fittedRect(viewW, viewH, imgW, imgH);
  const d = flipCentre(cx, cy, rot180, mirror);
  return { x: r.x + r.w * (0.5 + d.x), y: r.y + r.h * (0.5 + d.y) };
}

/** Klick in der Anzeige → gespeicherte Mitte (außerhalb des Bildes: am Rand) */
export function pixelToCrosshair(px: number, py: number, viewW: number, viewH: number, imgW: number, imgH: number,
                                 rot180: boolean, mirror: boolean): { x: number; y: number } {
  const r = fittedRect(viewW, viewH, imgW, imgH);
  const dx = clampCentre((px - r.x) / r.w - 0.5), dy = clampCentre((py - r.y) / r.h - 0.5);
  return flipCentre(dx, dy, rot180, mirror);
}
