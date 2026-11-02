/**
 * FLEX-SCHARNIER (Living Hinge): Schnittmuster, mit dem sich eine Platte (Sperrholz, MDF, Acryl dünn) biegen lässt
 * (Fenster: editor/hingeGen.ts)
 *
 * Viele parallele Schnitte quer zur Biegung, Spalte für Spalte um eine halbe Teilung versetzt. Zwischen den Schnitten
 * einer Spalte bleibt ein Steg stehen – so hängt alles zusammen, und die dünnen Streifen verdrehen sich beim Biegen.
 * Muster:
 *   lines  gerade Schnitte (klassisch)
 *   wave   Wellenlinien (biegt sich weicher, sieht schöner aus)
 *   slots  Langlöcher mit einstellbarer Breite (für dickes Material oder wenn der Laser-Schnitt zu schmal ist)
 * Die Schnitte laufen senkrecht (Biegeachse senkrecht), die Scharnier-Zone liegt waagerecht mittig in der Platte.
 * Oben und unten bleibt immer ein Rand (= Steg), damit die Platte außen ganz bleibt.
 *
 * Nur Geometrie, ohne Oberfläche (Tests: `npm test`). Alles in mm, Y nach oben, Platte links unten bei (0, 0).
 */
export type XY = [number, number];
export type HingePattern = "lines" | "wave" | "slots";
export const HINGE_PATTERNS: HingePattern[] = ["lines", "wave", "slots"];

export interface HingeOptions {
  pattern: HingePattern;
  width: number;      // Platte Breite (mm)
  height: number;     // Platte Höhe = Länge der Biegeachse (mm)
  panel: boolean;     // Umriss der Platte mit ausgeben (sonst nur das Muster)
  length: number;     // Breite der Scharnier-Zone (mm)
  spacing: number;    // Abstand der Schnitte (mm)
  cut: number;        // Länge eines Schnitts (mm)
  bridge: number;     // Steg zwischen zwei Schnitten (mm)
  amplitude: number;  // Welle: Ausschlag (mm)
  slotWidth: number;  // Langloch: Breite (mm)
  thickness: number;  // Materialdicke (mm) – nur für Hinweise und den Vorschlag
}

export interface HingeLine { pts: XY[]; closed: boolean }

export interface HingeResult {
  outline: XY[] | null;   // Platte (geschlossen), null ohne Platte
  lines: HingeLine[];     // Schnitte (offen) bzw. Langlöcher (geschlossen)
  columns: number;        // Spalten
  x0: number; x1: number; // Scharnier-Zone
  cutLength: number;      // gesamte Schnittlänge (mm)
  radius90: number;       // so eng lässt sich die Zone um 90° biegen (Innenradius, mm)
  radius180: number;
  warnings: string[];     // Übersetzungs-Schlüssel
}

/** Vorschlag für Abstand, Schnittlänge und Steg aus der Materialdicke (Erfahrungswerte für Sperrholz) */
export function suggestForThickness(t: number): Pick<HingeOptions, "spacing" | "cut" | "bridge" | "amplitude" | "slotWidth"> {
  const th = Math.max(0.5, t);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return { spacing: r1(Math.max(1.2, 0.6 * th)), cut: r1(Math.max(10, 6 * th)), bridge: r1(Math.max(2, th)),
    amplitude: r1(Math.max(0.6, 0.3 * th)), slotWidth: r1(Math.max(0.5, 0.25 * th)) };
}

/** Schnitt-Abschnitte einer Spalte: [y0, y1], symmetrisch zur Mitte, oben/unten ein Rand von `margin` */
export function columnSegments(height: number, cut: number, bridge: number, shifted: boolean, margin: number): [number, number][] {
  const p = cut + bridge;
  // Spalte A: ein Schnitt liegt genau in der Mitte; Spalte B: um eine halbe Teilung versetzt
  const center = height / 2 + (shifted ? p / 2 : 0);
  const kMin = Math.floor((margin - center - cut / 2) / p) - 1, kMax = Math.ceil((height - margin - center + cut / 2) / p) + 1;
  const out: [number, number][] = [];
  const minLen = Math.max(1, Math.min(cut / 4, 3));
  for (let k = kMin; k <= kMax; k++) {
    const a = Math.max(margin, center + k * p - cut / 2), b = Math.min(height - margin, center + k * p + cut / 2);
    if (b - a >= minLen) out.push([a, b]);
  }
  return out;
}

function stadium(x: number, y0: number, y1: number, w: number): XY[] {
  const r = w / 2, pts: XY[] = [];
  const n = 8;
  for (let i = 0; i <= n; i++) { const a = Math.PI + Math.PI * i / n; pts.push([x + r * Math.cos(a), y0 + r + r * Math.sin(a)]); }
  for (let i = 0; i <= n; i++) { const a = Math.PI * i / n; pts.push([x + r * Math.cos(a), y1 - r + r * Math.sin(a)]); }
  pts.push([pts[0][0], pts[0][1]]);
  return pts;
}

export function livingHinge(o: HingeOptions): HingeResult {
  const warnings: string[] = [];
  const W = Math.max(1, o.width), H = Math.max(1, o.height);
  const L = Math.min(Math.max(0, o.length), W);
  if (o.length > W) warnings.push("hinge.warnLength");
  const x0 = (W - L) / 2, x1 = x0 + L;
  const n = Math.max(1, Math.round(L / Math.max(0.3, o.spacing)));
  const s = L / n; // Abstand so angepasst, dass die Zone genau ausgefüllt wird
  const margin = Math.max(o.bridge, 0.5);
  const lines: HingeLine[] = [];
  let cutLength = 0;
  const amp = o.pattern === "wave" ? Math.max(0, Math.min(o.amplitude, s * 0.45)) : 0;
  const lambda = Math.max(2 * Math.PI * amp, 4); // Wellenlänge: Steigung höchstens 1, sonst rücken die Linien zu nah
  for (let i = 0; i <= n; i++) {
    const x = x0 + i * s;
    for (const [a, b] of columnSegments(H, o.cut, o.bridge, i % 2 === 1, margin)) {
      if (o.pattern === "slots") {
        const w = Math.min(o.slotWidth, b - a);
        lines.push({ pts: stadium(x, a, b, w), closed: true });
        cutLength += 2 * (b - a - w) + Math.PI * w;
      } else if (o.pattern === "wave") {
        const steps = Math.max(2, Math.ceil((b - a) / 0.5));
        const pts: XY[] = [];
        for (let k = 0; k <= steps; k++) { const y = a + (b - a) * k / steps; pts.push([x + amp * Math.sin(2 * Math.PI * (y - H / 2) / lambda), y]); }
        for (let k = 1; k < pts.length; k++) cutLength += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        lines.push({ pts, closed: false });
      } else {
        lines.push({ pts: [[x, a], [x, b]], closed: false });
        cutLength += b - a;
      }
    }
  }
  const outline: XY[] | null = o.panel ? [[0, 0], [W, 0], [W, H], [0, H], [0, 0]] : null;
  if (o.panel) cutLength += 2 * (W + H);
  // Streifen zwischen zwei Schnitten: Abstand minus Schnittbreite (Langloch) bzw. minus Wellen-Ausschlag
  const strip = s - (o.pattern === "slots" ? o.slotWidth : 0) - (o.pattern === "wave" ? 2 * amp * 0.3 : 0);
  if (strip < 0.8) warnings.push("hinge.warnStrip");
  if (o.bridge < 1) warnings.push("hinge.warnBridge");
  if (o.cut < 2 * o.bridge) warnings.push("hinge.warnStiff");
  if (o.cut + 2 * margin > H) warnings.push("hinge.warnShort");
  // Biegung: die Zone wird zum Bogen; Länge des Bogens in der Mitte der Dicke = Zone
  const t = Math.max(0, o.thickness);
  const radius90 = Math.max(0, L / (Math.PI / 2) - t / 2), radius180 = Math.max(0, L / Math.PI - t / 2);
  return { outline, lines, columns: n + 1, x0, x1, cutLength, radius90, radius180, warnings };
}
