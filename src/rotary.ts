/**
 * DREHACHSE (Rotary) – Gravieren auf runden Dingen (Becher, Flaschen, Stifte, Holzrollen)
 *
 * Gezeichnet wird ganz normal auf dem Bett: X = entlang der Achse, Y = abgewickelter Umfang
 * (0 … π × Durchmesser). Beim Erzeugen wird nur Y umgerechnet:
 *   - Y-Achse ersetzt (Drehachse am Y-Anschluss, wie bei xTool RA2, Creality, LaserPecker …):
 *     Y_neu = Y × mmPerRot / (π × D) – mmPerRot = so viel Y braucht eine ganze Umdrehung der Rolle/des Futters
 *   - eigene A-Achse (grblHAL / FluidNC mit 4. Achse): Y fällt weg, A = Y / (π × D) × 360°
 * D ist bei der Rollen-Drehachse der Rollen-Durchmesser (das Teil dreht so weit, wie die Rolle abrollt –
 * unabhängig vom Teil-Durchmesser), beim Futter der Durchmesser des Teils.
 * Der Laser-G-Code hat nur gerade Fahrten (G0/G1) – Y ist linear umrechenbar, Bögen gibt es nicht.
 */
import { MM_TO_PIXEL } from "./shapeTransform";
import { t, ascii } from "./i18n/i18n";

export interface RotarySettings {
  on: boolean;
  axis: "y" | "a";            // Y-Anschluss oder eigene A-Achse
  kind: "roller" | "chuck";   // Rollen oder Futter
  diameter: number;           // Durchmesser des Teils (mm)
  rollerDia: number;          // Durchmesser der Antriebsrolle (mm)
  mmPerRot: number;           // Y-Weg für eine Umdrehung (nur Y-Modus)
}

export const ROTARY_CHANGED = "cnc-rotary-changed";
const KEY = "cnc_craft_rotary";
export const rotary: RotarySettings = { on: false, axis: "y", kind: "roller", diameter: 80, rollerDia: 30, mmPerRot: 100 };

try {
  const s = JSON.parse(localStorage.getItem(KEY) || "null");
  if (s && typeof s === "object") {
    if (typeof s.on === "boolean") rotary.on = s.on;
    if (s.axis === "y" || s.axis === "a") rotary.axis = s.axis;
    if (s.kind === "roller" || s.kind === "chuck") rotary.kind = s.kind;
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

/** Durchmesser, der die Drehung bestimmt (Rolle oder Teil) */
function driveDia(s: RotarySettings): number { return s.kind === "roller" ? s.rollerDia : s.diameter; }

/** Y (mm auf der Oberfläche) → Wert für die Maschine */
export function mapY(y: number, s: RotarySettings = rotary): number {
  const turns = y / (Math.PI * driveDia(s));
  return s.axis === "a" ? turns * 360 : turns * s.mmPerRot;
}

/**
 * Laser-G-Code für die Drehachse umrechnen. Gibt null zurück, wenn der Code Bögen enthält
 * (die lassen sich nicht strecken).
 */
export function applyRotary(gcode: string, s: RotarySettings = rotary): string | null {
  const n = (v: number) => String(+v.toFixed(4));
  const out: string[] = [];
  out.push(`(${ascii(t("rot.gcHeader", { d: s.diameter, axis: s.axis.toUpperCase(), kind: t("rot.kind." + s.kind).replace(/\s*\(.*\)\s*/, "") }))})`);
  for (const line of gcode.split("\n")) {
    // Kommentare in Klammern nicht anfassen
    const code = line.replace(/\([^)]*\)/g, "");
    if (/\bG0?[23]\b/i.test(code)) return null;
    if (!/\bY-?[\d.]/i.test(code)) { out.push(line); continue; }
    out.push(line.replace(/(\([^)]*\))|\bY(-?\d*\.?\d+)/gi, (m, comment, v) =>
      comment ? m : (s.axis === "a" ? "A" : "Y") + n(mapY(parseFloat(v), s))));
  }
  return out.join("\n");
}

/** Bereich auf dem Bett, der um das Teil herum passt (Band 0 … Umfang) */
export function drawRotaryBand(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => { x: number; y: number }, bedWmm: number) {
  if (!rotary.on) return;
  const c = circumference();
  const a = toScreen(0, 0), b = toScreen(bedWmm * MM_TO_PIXEL, c * MM_TO_PIXEL);
  ctx.save();
  ctx.fillStyle = "rgba(77, 171, 247, 0.07)";
  ctx.fillRect(a.x, b.y, b.x - a.x, a.y - b.y);
  ctx.strokeStyle = "rgba(77, 171, 247, 0.85)";
  ctx.setLineDash([8, 5]); ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(a.x, b.y); ctx.lineTo(b.x, b.y); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, a.y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(77, 171, 247, 0.95)";
  ctx.font = "600 11px system-ui, sans-serif";
  ctx.textBaseline = "bottom";
  ctx.fillText(`⟳ ${t("rot.band", { c: c.toFixed(1), d: rotary.diameter })}`, a.x + 6, b.y - 3);
  ctx.restore();
}

/** Teile außerhalb des Umfangs? (Warnung beim Erzeugen) */
export function outsideBand(shapes: any[], bounds: (s: any) => { minY: number; maxY: number } | null): number {
  const c = circumference() * MM_TO_PIXEL;
  let n = 0;
  for (const s of shapes) { const b = bounds(s); if (b && (b.minY < -0.01 || b.maxY > c + 0.01)) n++; }
  return n;
}
