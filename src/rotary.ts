/**
 * DREHACHSE (Rotary) – Lasern und Fräsen auf runden Dingen (Becher, Flaschen, Stifte, Holzrollen, Stäbe)
 *
 * Gezeichnet wird ganz normal auf dem Bett: X = entlang der Achse, Y = abgewickelter Umfang
 * (0 … π × Durchmesser). Beim Erzeugen wird nur Y umgerechnet:
 *   - Y-Achse ersetzt (Drehachse am Y-Anschluss, wie bei xTool RA2, Creality, LaserPecker …):
 *     Y_neu = Y × mmPerRot / (π × D) – mmPerRot = so viel Y braucht eine ganze Umdrehung der Rolle/des Futters
 *   - eigene A-Achse (grblHAL / FluidNC mit 4. Achse): Y fällt weg, A = Y / (π × D) × 360°
 * D ist bei der Rollen-Drehachse der Rollen-Durchmesser (das Teil dreht so weit, wie die Rolle abrollt –
 * unabhängig vom Teil-Durchmesser), beim Futter der Durchmesser des Teils.
 * Liegt die Drehachse entlang Y (along "y"), gilt alles mit getauschten Rollen: Y = entlang des Teils,
 * X = rundherum (Band 0 … Umfang in X), Anschluss dann X statt Y. „Drehrichtung umkehren“ für Achsen, die
 * andersherum drehen (sonst käme das Teil gespiegelt heraus).
 * Fräse: Z = 0 oben auf dem Teil, der Fräser steht über der Mitte der Drehachse; Tiefe = in den Zylinder hinein.
 * Die Umrechnung selbst (Bögen zerlegen, Vorschub) steht in rotaryWrap.ts.
 */
import { MM_TO_PIXEL } from "./shapeTransform";
import { t, ascii } from "./i18n/i18n";
import { machine } from "./machine";
import { isLaser } from "./machineMode";
import { wrapGcode, WrapOptions } from "./rotaryWrap";

export interface RotarySettings {
  on: boolean;
  axis: "y" | "a";            // Y-Anschluss oder eigene A-Achse
  kind: "roller" | "chuck";   // Rollen oder Futter
  diameter: number;           // Durchmesser des Teils (mm)
  rollerDia: number;          // Durchmesser der Antriebsrolle (mm)
  mmPerRot: number;           // Y-Weg für eine Umdrehung (nur Y-Modus)
  along: "x" | "y";           // Lage der Drehachse: entlang X (Standard) oder entlang Y
  reverse: boolean;           // Drehrichtung umkehren
}

export const ROTARY_CHANGED = "cnc-rotary-changed";
const KEY = "cnc_craft_rotary";
export const rotary: RotarySettings = { on: false, axis: "y", kind: "roller", diameter: 80, rollerDia: 30, mmPerRot: 100, along: "x", reverse: false };

try {
  const s = JSON.parse(localStorage.getItem(KEY) || "null");
  if (s && typeof s === "object") {
    if (typeof s.on === "boolean") rotary.on = s.on;
    if (s.axis === "y" || s.axis === "a") rotary.axis = s.axis;
    if (s.kind === "roller" || s.kind === "chuck") rotary.kind = s.kind;
    if (s.along === "x" || s.along === "y") rotary.along = s.along;
    if (typeof s.reverse === "boolean") rotary.reverse = s.reverse;
    for (const k of ["diameter", "rollerDia", "mmPerRot"] as const) if (Number.isFinite(+s[k]) && +s[k] > 0) rotary[k] = +s[k];
  }
} catch { /* Standardwerte */ }

export function setRotary(p: Partial<RotarySettings>) {
  Object.assign(rotary, p);
  for (const k of ["diameter", "rollerDia", "mmPerRot"] as const) if (!(rotary[k] > 0)) rotary[k] = 1;
  try { localStorage.setItem(KEY, JSON.stringify(rotary)); } catch { /* egal */ }
  window.dispatchEvent(new CustomEvent(ROTARY_CHANGED));
  window.dispatchEvent(new Event("cnc-redraw"));
}

/** Abgewickelter Umfang des Teils in mm */
export function circumference(s: RotarySettings = rotary): number { return Math.PI * s.diameter; }

/** Rollen gibt es nur beim Laser – auf der Fräse ist das Teil immer eingespannt (Futter) */
function kindOf(s: RotarySettings): RotarySettings["kind"] { return isLaser() ? s.kind : "chuck"; }

/** Durchmesser, der die Drehung bestimmt (Rolle oder Teil) */
function driveDia(s: RotarySettings): number { return kindOf(s) === "roller" ? s.rollerDia : s.diameter; }

/** Name der Steuerung, die keine A-Achse kennt (null = kann eine haben) */
function noAxisController(): string | null {
  if (!machine.connected) return null;
  return machine.protocol === "ruida" ? "Ruida" : machine.protocol === "k40" ? "K40" : machine.protocol === "marlin" ? "Marlin" : null;
}

/**
 * Passt die Drehachse zur verbundenen Steuerung?
 *  - block: A-Achse an Ruida/K40/Marlin – deren Übersetzer verwerfen A, alles würde auf einer Linie graviert
 *  - warn:  GRBL ohne Einstellungen für eine 4. Achse ($103 fehlt) → vermutlich Fehler 20;
 *           Ruida: deren eigene Drehachsen-Funktion muss aus sein, sonst wird doppelt umgerechnet
 */
export function rotaryCheck(s: RotarySettings = rotary): { block: string | null; warn: string | null } {
  if (!s.on) return { block: null, warn: null };
  const fw = noAxisController();
  if (s.axis === "a" && fw) return { block: t("rot.aBlocked", { fw }), warn: null };
  let warn: string | null = null;
  if (s.axis === "a" && machine.connected && machine.protocol === "grbl" && machine.settings.size > 0 && !machine.settings.has("$103")) warn = t("rot.aNoAxis");
  if (machine.connected && machine.protocol === "ruida") warn = t("rot.ruidaOwn");
  return { block: null, warn };
}

/** G-Code mit A-Achse an eine Steuerung, die sie nicht kennt? (Auftrag starten) */
export function aAxisRefused(lines: string[]): string | null {
  const fw = noAxisController();
  if (!fw) return null;
  return lines.some(l => /\bA-?[\d.]/i.test(l.replace(/\([^)]*\)/g, "").replace(/;.*$/, ""))) ? t("rot.aBlocked", { fw }) : null;
}

/** Einstellungen für die Umrechnung (rotaryWrap.ts) */
export function wrapOptions(s: RotarySettings = rotary): WrapOptions {
  return { axis: s.axis, driveDia: driveDia(s), partDia: s.diameter, mmPerRot: s.mmPerRot, depthFeed: !isLaser(), along: s.along, reverse: s.reverse };
}

/**
 * G-Code für die Drehachse umrechnen (Laser und Fräse): Y → Drehung, Bögen → Geraden, Vorschub auf der
 * Oberfläche. Gibt bei Code, der sich nicht sicher umrechnen lässt, eine Meldung statt G-Code zurück.
 */
export function applyRotary(gcode: string, s: RotarySettings = rotary, input: "machine" | "internal" = "machine"): { gcode: string } | { error: string } {
  const r = wrapGcode(gcode.split("\n"), { ...wrapOptions(s), input });
  if (!r.ok) return { error: t("rot.err." + r.error, { n: r.line }) };
  const port = s.axis === "a" ? "A" : s.along === "y" ? "X" : "Y";
  const head = [`(${ascii(t("rot.gcHeader", { d: s.diameter, axis: port, kind: t("rot.kind." + kindOf(s)).replace(/\s*\(.*\)\s*/, "") }))})`];
  if (s.along === "y" || s.reverse) head.push(`(${ascii(t("rot.gcLayout", { along: s.along.toUpperCase(), dir: t(s.reverse ? "rot.dirRev" : "rot.dirNormal") }))})`);
  if (!isLaser()) head.push(`(${ascii(t("rot.gcMill"))})`);
  return { gcode: [...head, ...r.lines].join("\n") };
}

/** Bereich auf dem Bett, der um das Teil herum passt (Band 0 … Umfang) */
export function drawRotaryBand(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => { x: number; y: number }, bedWmm: number, bedHmm: number) {
  if (!rotary.on) return;
  const c = circumference();
  ctx.save();
  ctx.fillStyle = "rgba(77, 171, 247, 0.07)";
  ctx.strokeStyle = "rgba(77, 171, 247, 0.85)";
  ctx.lineWidth = 1.4;
  const label = `⟳ ${t("rot.band", { c: c.toFixed(1), d: rotary.diameter })}`;
  ctx.font = "600 11px system-ui, sans-serif";
  if (rotary.along === "y") {
    // Achse entlang Y: senkrechtes Band 0 … Umfang in X, über die ganze Bett-Höhe
    const a = toScreen(0, 0), b = toScreen(c * MM_TO_PIXEL, bedHmm * MM_TO_PIXEL);
    ctx.fillRect(a.x, b.y, b.x - a.x, a.y - b.y);
    ctx.setLineDash([8, 5]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x, b.y); ctx.moveTo(b.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(77, 171, 247, 0.95)";
    ctx.translate(b.x + 4, a.y - 6); ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = "top";
    ctx.fillText(label, 0, 0);
  } else {
    const a = toScreen(0, 0), b = toScreen(bedWmm * MM_TO_PIXEL, c * MM_TO_PIXEL);
    ctx.fillRect(a.x, b.y, b.x - a.x, a.y - b.y);
    ctx.setLineDash([8, 5]);
    ctx.beginPath(); ctx.moveTo(a.x, b.y); ctx.lineTo(b.x, b.y); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, a.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(77, 171, 247, 0.95)";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, a.x + 6, b.y - 3);
  }
  ctx.restore();
}

/** Teile außerhalb des Umfangs? (Warnung beim Erzeugen) */
export function outsideBand(shapes: any[], bounds: (s: any) => { minX: number; maxX: number; minY: number; maxY: number } | null): number {
  const c = circumference() * MM_TO_PIXEL;
  const y = rotary.along === "y";
  let n = 0;
  for (const s of shapes) {
    const b = bounds(s);
    if (b && ((y ? b.minX : b.minY) < -0.01 || (y ? b.maxX : b.maxY) > c + 0.01)) n++;
  }
  return n;
}
