/**
 * LINEAL, WINKELMESSER, UHR-ZIFFERBLATT – Skalen zum Lasern oder Fräsen (Fenster: editor/scaleGen.ts)
 *
 * Lineal: mm (Striche je 1 mm, halb lang je 5 mm, lang je 10 mm, Zahlen in cm) oder Zoll (je 1/16", Zahlen je Zoll).
 *   Gemessen wird an der Oberkante, die Skala beginnt einen Rand vom linken Ende entfernt. Auf Wunsch ein Loch zum
 *   Aufhängen am rechten Ende.
 * Winkelmesser: Halbkreis mit Steg unten, Striche je 1°, 5°, 10°, Zahlen je 10°, Kreuz im Mittelpunkt (0°-Linie).
 * Zifferblatt: Kreis, 60 Minuten-Striche, 12 Stunden-Striche, Zahlen 1 … 12 (arabisch oder römisch) oder keine,
 *   Loch für das Uhrwerk in der Mitte.
 *
 * Ausgabe: Umriss (schneiden), Löcher (schneiden), Striche (gravieren als Linie), Beschriftung als Position + Text
 * (das Fenster setzt sie in Einzellinien-Schrift). Alles in mm, Y nach oben.
 */
export type XY = [number, number];
export type ScaleKind = "ruler" | "protractor" | "clock";
export const SCALE_KINDS: ScaleKind[] = ["ruler", "protractor", "clock"];
export type Numerals = "arabic" | "roman" | "none";
export const NUMERALS: Numerals[] = ["arabic", "roman", "none"];

export interface ScaleOptions {
  kind: ScaleKind;
  unit: "mm" | "inch";    // Lineal
  length: number;         // Lineal: Messlänge (mm bzw. Zoll)
  width: number;          // Lineal: Breite (mm)
  holeD: number;          // Lineal: Aufhänge-Loch Ø (0 = keins)
  radius: number;         // Winkelmesser: Radius (mm)
  diameter: number;       // Zifferblatt: Ø (mm)
  numerals: Numerals;     // Zifferblatt
  centerHole: number;     // Zifferblatt: Loch für das Uhrwerk (mm, 0 = keins)
  textH: number;          // Schrifthöhe (mm)
}

export interface Label { text: string; x: number; y: number; h: number; angle: number } // Mitte des Textes, Drehung (rad)
export interface ScaleResult {
  outline: XY[];          // geschlossen
  holes: XY[][];          // geschlossen
  ticks: XY[][];          // offene Linien
  labels: Label[];
  w: number; h: number;
  warnings: string[];
}

function circle(cx: number, cy: number, r: number, n = 0): XY[] {
  const k = n || Math.max(32, Math.min(240, Math.ceil(2 * Math.PI * r / 0.5)));
  const out: XY[] = [];
  for (let i = 0; i < k; i++) out.push([cx + r * Math.cos(2 * Math.PI * i / k), cy + r * Math.sin(2 * Math.PI * i / k)]);
  out.push([out[0][0], out[0][1]]);
  return out;
}

const ROMAN = ["XII", "I", "II", "III", "IIII", "V", "VI", "VII", "VIII", "IX", "X", "XI"];

/** Strichlänge auf dem Lineal: Stufe 0 = kürzester Strich … */
export function rulerTicks(unit: "mm" | "inch", length: number): { pos: number; level: number; label: string | null }[] {
  const out: { pos: number; level: number; label: string | null }[] = [];
  if (unit === "mm") {
    const n = Math.floor(length + 1e-9);
    for (let i = 0; i <= n; i++) out.push({ pos: i, level: i % 10 === 0 ? 2 : i % 5 === 0 ? 1 : 0, label: i % 10 === 0 ? String(i / 10) : null });
  } else {
    const n = Math.floor(length * 16 + 1e-9);
    for (let i = 0; i <= n; i++) {
      const level = i % 16 === 0 ? 4 : i % 8 === 0 ? 3 : i % 4 === 0 ? 2 : i % 2 === 0 ? 1 : 0;
      out.push({ pos: i * 25.4 / 16, level, label: i % 16 === 0 ? String(i / 16) : null });
    }
  }
  return out;
}

function ruler(o: ScaleOptions): ScaleResult {
  const warnings: string[] = [];
  const W = Math.max(8, o.width);
  const ticks0 = rulerTicks(o.unit, o.length);
  const scaleLen = ticks0[ticks0.length - 1]?.pos ?? 0;
  const left = 5, right = o.holeD > 0 ? o.holeD + 8 : 5;
  const L = left + scaleLen + right;
  const maxLevel = o.unit === "mm" ? 2 : 4;
  const longest = Math.min(W * 0.45, 8);
  const len = (lv: number) => longest * (0.4 + 0.6 * lv / maxLevel);
  const ticks: XY[][] = [], labels: Label[] = [];
  for (const tk of ticks0) {
    const x = left + tk.pos;
    ticks.push([[x, W], [x, W - len(tk.level)]]);
    if (tk.label !== null) labels.push({ text: tk.label, x, y: W - longest - 1 - o.textH / 2, h: o.textH, angle: 0 });
  }
  if (W - longest - 1 - o.textH < 1.5) warnings.push("scale.warnNarrow");
  const holes = o.holeD > 0 ? [circle(L - right / 2, W / 2, o.holeD / 2)] : [];
  if (o.holeD > W - 3) warnings.push("scale.warnHole");
  return { outline: [[0, 0], [L, 0], [L, W], [0, W], [0, 0]], holes, ticks, labels, w: L, h: W, warnings };
}

function protractor(o: ScaleOptions): ScaleResult {
  const R = Math.max(20, o.radius), base = Math.max(6, R * 0.12);
  const outline: XY[] = [[R, -base], [R, 0]];
  const n = Math.max(90, Math.ceil(Math.PI * R / 0.5));
  for (let i = 1; i < n; i++) { const a = Math.PI * i / n; outline.push([R * Math.cos(a), R * Math.sin(a)]); }
  outline.push([-R, 0], [-R, -base], [R, -base]);
  const longest = Math.min(R * 0.12, 8);
  const ticks: XY[][] = [], labels: Label[] = [];
  for (let d = 0; d <= 180; d++) {
    const a = d * Math.PI / 180, l = d % 10 === 0 ? longest : d % 5 === 0 ? longest * 0.7 : longest * 0.4;
    const c = Math.cos(a), s = Math.sin(a);
    ticks.push([[R * c, R * s], [(R - l) * c, (R - l) * s]]);
    if (d % 10 === 0) {
      const r = R - longest - 1 - o.textH / 2;
      labels.push({ text: String(d), x: r * c, y: r * s, h: o.textH, angle: a - Math.PI / 2 });
    }
  }
  const m = Math.min(5, R * 0.08);
  ticks.push([[-m, 0], [m, 0]], [[0, -Math.min(m, base - 1)], [0, m]]);
  const warnings: string[] = [];
  const rText = R - longest - 1 - o.textH;
  if (rText * Math.PI / 18 < o.textH * 1.6) warnings.push("scale.warnBig");
  return { outline, holes: [], ticks, labels, w: 2 * R, h: R + base, warnings };
}

function clock(o: ScaleOptions): ScaleResult {
  const R = Math.max(20, o.diameter / 2);
  const e = R * 0.04, major = R * 0.12, minor = R * 0.05;
  const ticks: XY[][] = [], labels: Label[] = [];
  for (let k = 0; k < 60; k++) {
    const a = Math.PI / 2 - k * Math.PI / 30, c = Math.cos(a), s = Math.sin(a), l = k % 5 === 0 ? major : minor;
    ticks.push([[(R - e) * c, (R - e) * s], [(R - e - l) * c, (R - e - l) * s]]);
  }
  const warnings: string[] = [];
  if (o.numerals !== "none") {
    const r = R - e - major - 1.5 - o.textH * 0.8;
    for (let k = 0; k < 12; k++) {
      const a = Math.PI / 2 - k * Math.PI / 6;
      labels.push({ text: o.numerals === "roman" ? ROMAN[k] : String(k === 0 ? 12 : k), x: r * Math.cos(a), y: r * Math.sin(a), h: o.textH, angle: 0 });
    }
    if (o.textH > r * Math.PI / 6 * 0.7) warnings.push("scale.warnBig");
  }
  const holes = o.centerHole > 0 ? [circle(0, 0, o.centerHole / 2)] : [];
  return { outline: circle(0, 0, R), holes, ticks, labels, w: 2 * R, h: 2 * R, warnings };
}

export function scale(o: ScaleOptions): ScaleResult {
  return o.kind === "ruler" ? ruler(o) : o.kind === "protractor" ? protractor(o) : clock(o);
}
