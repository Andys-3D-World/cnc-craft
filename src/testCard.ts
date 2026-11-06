/**
 * LASER-TESTKARTE – die reine Rechnung (ohne Fenster), damit sie getestet werden kann
 *
 * Ein Stück Material, einmal lasern, mehrere Felder: Damit liest man ab, welche Werte auf der EIGENEN Maschine passen.
 * Es gibt bewusst keine Wertetabelle: Alles, was später gespeichert wird, kommt von den Feldern, die wirklich auf der Karte waren.
 *
 * Jedes Feld trägt seine Werte in shape.laserOverride (wie beim Testraster) und cardCell = wo es auf der Karte liegt.
 * Reihenfolge: stage in laserOverride (siehe STAGE) – gilt unabhängig davon, wie die Ebenen in der Liste stehen.
 *
 * Fokus-Leiter: fährt Z selbst. Nur aufwärts, kleine Schritte, jeder Schritt fährt danach zurück auf den Start (laserCam.ts).
 */
import { layoutTest, step, type GridLabel, type MaterialTestOptions } from "./materialGrid.ts";
import { livingHinge, suggestForThickness } from "./livingHinge.ts";

export interface Pt { x: number; y: number }

export const PANEL_IDS = ["engrave", "cut", "interval", "wedge", "threshold", "scan", "kerf", "text", "hinge", "air", "repeat", "ruler", "focus"] as const;
export type PanelId = typeof PANEL_IDS[number];
export const LASER_TYPES = ["diode", "co2", "fiber", "other"] as const;

export interface TestCardOptions {
  laserType: string; laserW: number;
  cardW: number; cardH: number;
  material: string; thickness: number; machine: string;
  header: boolean; outline: boolean;
  panels: string[];
  ePMin: number; ePMax: number; eCols: number; eSMin: number; eSMax: number; eRows: number; interval: number;
  cPMin: number; cPMax: number; cCols: number; cSMin: number; cSMax: number; cRows: number; cutAir: boolean;
  refPower: number; refSpeed: number;   // feste Werte der Gravur-Felder außerhalb des Rasters
  cutPower: number; cutSpeed: number;   // feste Werte für Kerf, Scharnier und Umriss
  iMin: number; iMax: number;
  scanMax: number; kerfMax: number;
  textPower: number; textSpeed: number;
  cell: number;
  focusStep: number; focusSteps: number; zConfirmed: boolean;
}

export const DEFAULT_CARD: TestCardOptions = {
  laserType: "diode", laserW: 10, cardW: 170, cardH: 150, material: "", thickness: 3, machine: "", header: true, outline: true,
  panels: PANEL_IDS.filter(p => p !== "focus"),
  ePMin: 20, ePMax: 100, eCols: 6, eSMin: 1000, eSMax: 6000, eRows: 5, interval: 0.1,
  cPMin: 60, cPMax: 100, cCols: 5, cSMin: 150, cSMax: 750, cRows: 4, cutAir: true,
  refPower: 40, refSpeed: 3000, cutPower: 100, cutSpeed: 300,
  iMin: 0.05, iMax: 0.3, scanMax: 0.3, kerfMax: 0.3,
  textPower: 20, textSpeed: 2000, cell: 6,
  focusStep: 0.5, focusSteps: 5, zConfirmed: false
};

/** Reihenfolge auf der Maschine: erst alles Gravierte, dann Linien, dann Schnitte von innen nach außen */
export const STAGE = { text: 0, repeatA: 1, engrave: 2, repeatB: 3, lines: 4, cutInner: 5, outline: 6 } as const;

export type Role = "text" | "engrave" | "line" | "cut";
export interface Ov { power: number; speed: number; interval: number; stage: number; air?: boolean; scanMm?: number; zOff?: number }
/** Lage eines Feldes auf der Karte; v = gemessener Wert (Kerf, Versatz, Linienabstand …) */
export interface Cell { p: string; r: number; c: number; v?: number }
export type Item =
  | { kind: "poly"; pts: Pt[]; closed: boolean; role: Role; ov: Ov; cell?: Cell }
  | { kind: "text"; text: string; x: number; y: number; h: number; align: GridLabel["align"]; rot?: boolean; ov: Ov };

export interface Panel { id: PanelId; w: number; h: number; items: Item[] }
export interface Placed { id: PanelId; x: number; y: number; w: number; h: number }
export interface CardResult { items: Item[]; placed: Placed[]; left: PanelId[]; scale: number; focusRefused: boolean }

type Tr = (key: string) => string;

const CARD_MARGIN = 3, PANEL_GAP = 4, LAB = 2, CAP = 1.5, TITLE = 2.4, HEADER = 3;
const CHAR = 0.82;   // mittlere Zeichenbreite der Einzellinien-Schrift, auf Höhe bezogen (etwas großzügig)
export const KERF_TAB = 4;    // Breite des Stegs am Probestück in mm
const SCALES = [1, 0.9, 0.8, 0.7, 0.6];

const rect = (x: number, y: number, w: number, h: number): Pt[] => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const textW = (s: string, h: number) => s.length * CHAR * h;
const round = (v: number, d: number) => { const f = 10 ** d; return Math.round(v * f) / f; };

/** Text in Zeilen dieser Breite umbrechen (Länge der Zeichen geschätzt) */
export function wrapText(s: string, maxW: number, h: number): string[] {
  const max = Math.max(4, Math.floor(maxW / (CHAR * h)));
  const out: string[] = [];
  let line = "";
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + w.length > max) { out.push(line); line = w; }
    else line = line ? line + " " + w : w;
  }
  if (line) out.push(line);
  return out;
}

const textOv = (o: TestCardOptions): Ov => ({ power: o.textPower, speed: o.textSpeed, interval: o.interval, stage: STAGE.text });
const fillOv = (o: TestCardOptions, extra: Partial<Ov> = {}): Ov => ({ power: o.refPower, speed: o.refSpeed, interval: o.interval, stage: STAGE.engrave, ...extra });
const cutOv = (o: TestCardOptions, stage: number = STAGE.cutInner): Ov => ({ power: o.cutPower, speed: o.cutSpeed, interval: o.interval, stage, air: o.cutAir });

/** Titel und Lesehilfe über den Inhalt setzen. Inhalt: (0,0) unten links, Breite cw, Höhe ch */
function frame(o: TestCardOptions, tr: Tr, id: PanelId, cw: number, ch: number, items: Item[], ox = 0): Panel {
  const w = Math.max(cw + ox, 36);
  const cap = wrapText(tr("tcard.read." + id), w, CAP);
  const ov = textOv(o);
  const out = items.map(it => shift(it, ox, 0));
  let y = ch + 1.2 + (cap.length - 1) * CAP * 1.5;
  cap.forEach((line, i) => out.push({ kind: "text", text: line, x: 0, y: y - i * CAP * 1.5, h: CAP, align: "left", ov }));
  y += CAP + 1;
  out.push({ kind: "text", text: tr("tcard.p." + id), x: 0, y, h: TITLE, align: "left", ov });
  return { id, w, h: y + TITLE, items: out };
}

function shift(it: Item, dx: number, dy: number): Item {
  if (it.kind === "poly") return { ...it, pts: it.pts.map(p => ({ x: p.x + dx, y: p.y + dy })) };
  return { ...it, x: it.x + dx, y: it.y + dy };
}

/** Raster aus dem Material-Test (Leistung × Geschwindigkeit) */
function grid(o: TestCardOptions, tr: Tr, id: "engrave" | "cut", cell: number): Panel {
  const engrave = id === "engrave";
  const mt: MaterialTestOptions = {
    mode: engrave ? "fill" : "line", rowVar: "speed",
    cols: engrave ? o.eCols : o.cCols, pMin: engrave ? o.ePMin : o.cPMin, pMax: engrave ? o.ePMax : o.cPMax,
    rows: engrave ? o.eRows : o.cRows, rMin: engrave ? o.eSMin : o.cSMin, rMax: engrave ? o.eSMax : o.cSMax,
    speed: o.refSpeed, interval: o.interval, passes: 1, cell, gap: Math.max(1, cell * 0.2), labels: true, textH: LAB,
    labelPower: o.textPower, labelSpeed: o.textSpeed
  };
  const L = layoutTest(mt);
  const items: Item[] = L.cells.map((c, i) => ({
    kind: "poly", pts: rect(c.x, c.y, cell, cell), closed: true, role: engrave ? "engrave" : "cut",
    ov: { power: c.power, speed: c.speed, interval: c.interval, stage: engrave ? STAGE.engrave : STAGE.cutInner, ...(engrave ? {} : { air: o.cutAir }) },
    cell: { p: id, r: Math.floor(i / mt.cols), c: i % mt.cols }
  }));
  const ov = textOv(o);
  for (const lb of L.labels) items.push({ kind: "text", text: lb.text, x: lb.x, y: lb.y, h: LAB, align: lb.align, rot: lb.rot, ov });
  const top = cell < LAB * 2.6 ? LAB * 5.2 : LAB * 3.7;
  return frame(o, tr, id, L.w, L.h + top, items, LAB * 5);
}

/** Reihe von Feldern mit Wert darüber */
function strip(o: TestCardOptions, tr: Tr, id: PanelId, fields: { label: string; ov: Ov; cell?: Cell }[], fw: number, fh: number, gap: number): Panel {
  const ov = textOv(o);
  const rot = fields.some(f => textW(f.label, LAB) > fw + gap);
  const labelH = rot ? Math.max(...fields.map(f => textW(f.label, LAB))) + 1 : LAB + 1;
  const items: Item[] = [];
  fields.forEach((f, i) => {
    const x = i * (fw + gap);
    items.push({ kind: "poly", pts: rect(x, 0, fw, fh), closed: true, role: "engrave", ov: f.ov, cell: f.cell });
    items.push({ kind: "text", text: f.label, x: x + fw / 2, y: fh + 1, h: LAB, align: "center", rot, ov });
  });
  return frame(o, tr, id, fields.length * (fw + gap) - gap, fh + labelH, items);
}

const lab = (v: number) => String(+v.toFixed(2));

function intervalPanel(o: TestCardOptions, tr: Tr, cell: number): Panel {
  const n = 6, fields = Array.from({ length: n }, (_, i) => {
    const v = step(o.iMin, o.iMax, i, n, 3);
    return { label: lab(v), ov: fillOv(o, { interval: v }), cell: { p: "interval", r: 0, c: i, v } };
  });
  return strip(o, tr, "interval", fields, cell, cell, 1.5);
}

function wedgePanel(o: TestCardOptions, tr: Tr, cell: number): Panel {
  const n = 10, fields = Array.from({ length: n }, (_, i) => {
    const v = step(o.ePMin, o.ePMax, i, n, 1);
    return { label: String(Math.round(v)), ov: fillOv(o, { power: v }), cell: { p: "wedge", r: 0, c: i, v } };
  });
  return strip(o, tr, "wedge", fields, Math.max(3, cell * 0.7), cell, 0);
}

function thresholdPanel(o: TestCardOptions, tr: Tr, cell: number): Panel {
  const n = 8, top = Math.max(n, Math.round(o.ePMin)), fields = Array.from({ length: n }, (_, i) => {
    const v = step(1, top, i, n, 1);
    return { label: String(v), ov: fillOv(o, { power: v }), cell: { p: "threshold", r: 0, c: i, v } };
  });
  return strip(o, tr, "threshold", fields, Math.max(3, cell * 0.7), cell, 0.8);
}

/** Geschwindigkeiten der Versatz-Zeilen */
export function scanSpeeds(o: TestCardOptions): number[] {
  return [o.eSMin, (o.eSMin + o.eSMax) / 2, o.eSMax].map(v => Math.round(v));
}

/** Versatz-Felder: je Zeile eine Geschwindigkeit, je Spalte ein Versatz. Die Striche zeigen ausgefranste Kanten am besten */
function scanPanel(o: TestCardOptions, tr: Tr): Panel {
  const cols = 7, bar = 1, gapBar = 1, bars = 3, fw = bars * bar + (bars - 1) * gapBar, fh = 7, pitchX = fw + 2, pitchY = fh + 2;
  const speeds = scanSpeeds(o), lm = LAB * 5, ov = textOv(o);
  const items: Item[] = [];
  const h = speeds.length * pitchY - 2;
  speeds.forEach((sp, r) => {
    const y = h - (r + 1) * pitchY + 2;
    items.push({ kind: "text", text: String(sp), x: -1, y: y + (fh - LAB) / 2, h: LAB, align: "right", ov });
    for (let c = 0; c < cols; c++) {
      const mm = step(0, o.scanMax, c, cols, 3);
      for (let b = 0; b < bars; b++) items.push({
        kind: "poly", pts: rect(c * pitchX + b * (bar + gapBar), y, bar, fh), closed: true, role: "engrave",
        ov: fillOv(o, { speed: sp, interval: 0.2, scanMm: mm }), cell: { p: "scan", r, c, v: mm }
      });
    }
  });
  for (let c = 0; c < cols; c++) items.push({ kind: "text", text: lab(step(0, o.scanMax, c, cols, 3)), x: c * pitchX + fw / 2, y: h + 1, h: LAB, align: "center", rot: true, ov });
  return frame(o, tr, "scan", cols * pitchX - 2, h + 9, items, lm);
}

/** Schlitze: jeder Schlitz passt zum Steg des Probestücks, wenn der Schnitt genau so breit ist wie sein Wert */
export function kerfSlots(kerfMax: number, n = 7): { k: number; width: number }[] {
  const top = Math.min(1, Math.max(0.05, kerfMax));
  return Array.from({ length: n }, (_, i) => { const k = step(0, top, i, n, 3); return { k, width: round(KERF_TAB - 2 * k, 3) }; });
}

/**
 * Schnittbreite aus dem Schlitz, der passt. Schlitz wird um den Schnitt breiter (D + k), der Steg schmaler (T − k).
 * Passt: D + k = T − k, also k = (T − D) / 2 – unabhängig von der Materialdicke.
 */
export function kerfFromFit(tab: number, slotWidth: number): number {
  return Math.max(0, round((tab - slotWidth) / 2, 3));
}

function kerfPanel(o: TestCardOptions, tr: Tr): Panel {
  const slots = kerfSlots(o.kerfMax), pitch = 6.5, sh = 10, ov = textOv(o), cut = cutOv(o);
  const items: Item[] = [];
  slots.forEach((s, i) => {
    const x = i * pitch + (KERF_TAB - s.width) / 2;
    items.push({ kind: "poly", pts: rect(x, 0, s.width, sh), closed: true, role: "cut", ov: cut, cell: { p: "kerf", r: 0, c: i, v: s.k } });
    items.push({ kind: "text", text: lab(s.k), x: i * pitch + KERF_TAB / 2, y: sh + 1, h: LAB, align: "center", rot: true, ov });
  });
  // Probestück: breiter Kopf, damit es nicht durch einen zu weiten Schlitz fällt
  const px = slots.length * pitch + 1, head = 10, stem = KERF_TAB, sl = sh - 2, hh = 3, sx = px + (head - stem) / 2;
  items.push({ kind: "poly", closed: true, role: "cut", ov: cut, pts: [
    { x: sx, y: 0 }, { x: sx + stem, y: 0 }, { x: sx + stem, y: sl }, { x: px + head, y: sl },
    { x: px + head, y: sl + hh }, { x: px, y: sl + hh }, { x: px, y: sl }, { x: sx, y: sl }
  ] });
  return frame(o, tr, "kerf", px + head, sh + 8, items);
}

function textPanel(o: TestCardOptions, tr: Tr): Panel {
  const sizes = [1, 1.5, 2, 3, 4], ov = textOv(o);
  const items: Item[] = [];
  let y = 0;
  for (const s of sizes) { items.push({ kind: "text", text: `Ag8 ${s}`, x: 0, y, h: s, align: "left", ov }); y += s + 1.2; }
  return frame(o, tr, "text", 30, y, items);
}

function hingePanel(o: TestCardOptions, tr: Tr): Panel {
  const W = 34, H = 20;
  const r = livingHinge({ pattern: "lines", width: W, height: H, panel: true, length: 20, thickness: o.thickness, ...suggestForThickness(o.thickness) });
  const cut = cutOv(o);
  const items: Item[] = r.lines.map(l => ({ kind: "poly", pts: l.pts.map(([x, y]) => ({ x, y })), closed: l.closed, role: "cut", ov: cut }));
  if (r.outline) items.push({ kind: "poly", pts: r.outline.map(([x, y]) => ({ x, y })), closed: true, role: "cut", ov: cut });
  return frame(o, tr, "hinge", W, H, items);
}

function airPanel(o: TestCardOptions, tr: Tr, cell: number): Panel {
  const ov = textOv(o), fw = Math.max(10, cell * 2), items: Item[] = [], slit = 5;
  [true, false].forEach((air, i) => {
    const x = i * (fw + 3);
    items.push({ kind: "poly", pts: rect(x, slit + 1, fw, fw * 0.7), closed: true, role: "engrave", ov: fillOv(o, { air }), cell: { p: "air", r: 0, c: i } });
    items.push({ kind: "poly", pts: [{ x, y: slit / 2 }, { x: x + fw, y: slit / 2 }], closed: false, role: "cut", ov: { ...cutOv(o), air } });
    items.push({ kind: "text", text: tr(air ? "tcard.airOn" : "tcard.airOff"), x, y: slit + 2 + fw * 0.7, h: LAB, align: "left", ov });
  });
  return frame(o, tr, "air", 2 * fw + 3, slit + 2 + fw * 0.7 + LAB + 1, items);
}

function repeatPanel(o: TestCardOptions, tr: Tr, cell: number): Panel {
  const fw = Math.max(10, cell * 2);
  return strip(o, tr, "repeat", [
    { label: "A", ov: fillOv(o, { stage: STAGE.repeatA }), cell: { p: "repeat", r: 0, c: 0 } },
    { label: "B", ov: fillOv(o, { stage: STAGE.repeatB }), cell: { p: "repeat", r: 0, c: 1 } }
  ], fw, fw * 0.7, 3);
}

function rulerPanel(o: TestCardOptions, tr: Tr): Panel {
  const L = 50, V = 12, ov: Ov = { ...textOv(o), stage: STAGE.lines }, tOv = textOv(o), items: Item[] = [];
  const tick = (a: Pt, b: Pt) => items.push({ kind: "poly", pts: [a, b], closed: false, role: "text", ov });
  tick({ x: 0, y: 0 }, { x: L, y: 0 });
  for (let i = 0; i <= L; i++) tick({ x: i, y: 0 }, { x: i, y: i % 10 === 0 ? 3.5 : i % 5 === 0 ? 2.5 : 1.5 });
  for (let i = 10; i <= L; i += 10) items.push({ kind: "text", text: String(i), x: i, y: 4, h: LAB, align: "center", ov: tOv });
  tick({ x: L + 4, y: 0 }, { x: L + 4, y: V });
  for (let i = 0; i <= V; i++) tick({ x: L + 4, y: i }, { x: L + 4 + (i % 10 === 0 ? 3 : i % 5 === 0 ? 2 : 1), y: i });
  return frame(o, tr, "ruler", L + 8, Math.max(V, 4 + LAB) + 0.5, items);
}

/** Fokus-Leiter darf nur mit kleinen Schritten, kurzem Weg und bestätigter Z-Achse */
export function focusAllowed(o: TestCardOptions): boolean {
  return o.zConfirmed === true && o.focusStep > 0 && o.focusStep <= 1 && Number.isInteger(o.focusSteps) && o.focusSteps >= 2 && o.focusSteps <= 9
    && o.focusStep * (o.focusSteps - 1) <= 5;
}

/** Fokus-Leiter: Linien in steigender Höhe (nur nach oben; Z 0 ist die Höhe beim Start) */
function focusPanel(o: TestCardOptions, tr: Tr): Panel {
  const ov = textOv(o), items: Item[] = [], lm = LAB * 3.5, pitch = 3.5;
  for (let i = 0; i < o.focusSteps; i++) {
    const z = round(i * o.focusStep, 3), y = i * pitch;
    items.push({ kind: "poly", pts: [{ x: 0, y }, { x: 26, y }], closed: false, role: "line",
      ov: { power: o.refPower, speed: o.refSpeed, interval: o.interval, stage: STAGE.lines, ...(z ? { zOff: z } : {}) }, cell: { p: "focus", r: i, c: 0, v: z } });
    items.push({ kind: "text", text: "+" + lab(z), x: -1, y: y - LAB / 2, h: LAB, align: "right", ov });
  }
  return frame(o, tr, "focus", 26, (o.focusSteps - 1) * pitch + LAB / 2 + 0.5, items.map(it => shift(it, 0, LAB / 2)), lm);
}

function buildPanel(o: TestCardOptions, tr: Tr, id: PanelId, s: number): Panel | null {
  const cell = Math.max(3, Math.round(o.cell * s * 10) / 10);
  switch (id) {
    case "engrave": case "cut": return grid(o, tr, id, cell);
    case "interval": return intervalPanel(o, tr, cell);
    case "wedge": return wedgePanel(o, tr, cell);
    case "threshold": return thresholdPanel(o, tr, cell);
    case "scan": return scanPanel(o, tr);
    case "kerf": return kerfPanel(o, tr);
    case "text": return textPanel(o, tr);
    case "hinge": return hingePanel(o, tr);
    case "air": return airPanel(o, tr, cell);
    case "repeat": return repeatPanel(o, tr, cell);
    case "ruler": return rulerPanel(o, tr);
    case "focus": return focusAllowed(o) ? focusPanel(o, tr) : null;
  }
}

/** Fläche füllen: die höchsten Felder zuerst, jedes in die erste Reihe, in die es passt. Oben links beginnen */
export function packPanels(sizes: { id: PanelId; w: number; h: number }[], W: number, H: number, gap = PANEL_GAP): { placed: Placed[]; left: PanelId[] } {
  const order = [...sizes].sort((a, b) => b.h - a.h || b.w - a.w);
  const shelves: { y: number; h: number; x: number }[] = [];
  const placed: Placed[] = [], left: PanelId[] = [];
  let used = 0;
  for (const p of order) {
    let sh = shelves.find(q => q.x + p.w <= W + 1e-6 && p.h <= q.h + 1e-6);
    if (!sh && p.w <= W && used + p.h <= H + 1e-6) {
      sh = { y: used, h: p.h, x: 0 };
      shelves.push(sh);
      used += p.h + gap;
    }
    if (!sh) { left.push(p.id); continue; }
    placed.push({ id: p.id, x: sh.x, y: H - sh.y - p.h, w: p.w, h: p.h });
    sh.x += p.w + gap;
  }
  return { placed, left };
}

/** Karte zusammensetzen: Felder werden erst verkleinert, was dann noch nicht passt, bleibt mit Warnung weg */
export function buildCard(o: TestCardOptions, tr: Tr): CardResult {
  const wanted = PANEL_IDS.filter(id => o.panels.includes(id));
  const focusRefused = wanted.includes("focus") && !focusAllowed(o);
  const top = o.header ? HEADER + 2 : 0;
  const W = o.cardW - 2 * CARD_MARGIN, H = o.cardH - 2 * CARD_MARGIN - top;
  let best: { panels: Panel[]; pack: ReturnType<typeof packPanels>; scale: number } | null = null;
  for (const s of SCALES) {
    const panels = wanted.map(id => buildPanel(o, tr, id, s)).filter((p): p is Panel => !!p);
    const pack = packPanels(panels, W, H);
    if (!best || pack.left.length < best.pack.left.length) best = { panels, pack, scale: s };
    if (!pack.left.length) break;
  }
  const items: Item[] = [];
  const { panels, pack, scale } = best!;
  for (const pl of pack.placed) {
    const p = panels.find(q => q.id === pl.id)!;
    for (const it of p.items) items.push(shift(it, CARD_MARGIN + pl.x, CARD_MARGIN + pl.y));
  }
  if (o.header) items.push({ kind: "text", text: headerText(o, tr), x: CARD_MARGIN, y: o.cardH - CARD_MARGIN - HEADER, h: HEADER, align: "left", ov: textOv(o) });
  if (o.outline) items.push({ kind: "poly", pts: rect(0, 0, o.cardW, o.cardH), closed: true, role: "cut", ov: cutOv(o, STAGE.outline) });
  return { items: sortByStage(items), placed: pack.placed, left: pack.left, scale, focusRefused };
}

function headerText(o: TestCardOptions, tr: Tr): string {
  const parts = [o.material, o.thickness > 0 ? `${o.thickness} mm` : "", `${tr("tcard.type." + o.laserType)} ${o.laserW} W`, o.machine];
  return parts.map(s => String(s).trim()).filter(Boolean).join(" - ");
}

const stageOf = (it: Item) => it.ov.stage;

/** Reihenfolge der Teile nach Stufe, gleiche Stufe bleibt wie sie ist */
export function sortByStage(items: Item[]): Item[] {
  return items.map((it, i) => ({ it, i })).sort((a, b) => stageOf(a.it) - stageOf(b.it) || a.i - b.i).map(x => x.it);
}

/** Blöcke im G-Code: ohne Stufe wie bisher zuerst, danach die Karte nach Stufen. Ohne Karte unverändert */
export function orderByStage<T extends { cardStage?: number }>(blocks: T[]): T[] {
  if (!blocks.some(b => b.cardStage !== undefined)) return blocks;
  const card = blocks.filter(b => b.cardStage !== undefined).map((b, i) => ({ b, i })).sort((a, b) => a.b.cardStage! - b.b.cardStage! || a.i - b.i).map(x => x.b);
  return [...blocks.filter(b => b.cardStage === undefined), ...card];
}

// =====================================================================
// NACH DEM LASERN: bestes Feld ablesen
// =====================================================================

export interface ReadCell { r: number; c: number; power: number; speed: number; interval: number; air: boolean; v?: number; scanMm?: number; zOff?: number }

/** Felder eines Bereichs aus den Formen der Karte lesen – nur, was wirklich dort liegt. Formen können aus fremden Dateien kommen */
export function readCells(shapes: any[], panel: string): ReadCell[] {
  const seen = new Map<string, ReadCell>();
  const n = (v: any, min: number, max: number) => { const x = Number(v); return Number.isFinite(x) && x >= min && x <= max ? x : NaN; };
  for (const s of shapes) {
    const c = s?.cardCell, o = s?.laserOverride;
    if (!c || !o || c.p !== panel) continue;
    const power = n(o.power, 0, 100), speed = n(o.speed, 1, 100000), interval = n(o.interval, 0.01, 10), r = n(c.r, 0, 99), col = n(c.c, 0, 99);
    if ([power, speed, interval, r, col].some(Number.isNaN)) continue;
    const v = Number(c.v), scan = Number(o.scanMm), z = Number(o.zOff);
    seen.set(`${r}|${col}`, { r, c: col, power, speed, interval, air: o.air === true,
      ...(Number.isFinite(v) ? { v } : {}), ...(Number.isFinite(scan) ? { scanMm: scan } : {}), ...(Number.isFinite(z) ? { zOff: z } : {}) });
  }
  return [...seen.values()].sort((a, b) => a.r - b.r || a.c - b.c);
}

/** Werte der Vorlage aus dem gewählten Feld. interval: Wert aus dem Linienabstand-Bereich, falls dort eines gewählt wurde */
export function presetFromCell(cell: ReadCell, kind: "engrave" | "cut", o: { material: string; thickness: number }, name: string, note: string, interval?: ReadCell): Record<string, unknown> {
  return {
    name, mode: kind === "engrave" ? "fill" : "line", power: cell.power, speed: cell.speed, fillPower: cell.power, fillSpeed: cell.speed,
    passes: 1, interval: interval?.v ?? cell.interval, angle: 0, air: cell.air, leadIn: 0,
    material: String(o.material).slice(0, 60), thickness: o.thickness, notes: note
  };
}

/** Name der Vorlage: Material, Dicke, Art, Werte */
export function presetName(material: string, thickness: number, kindText: string, cell: ReadCell): string {
  const m = material.trim() || "?";
  return `${m} ${thickness > 0 ? thickness + " mm " : ""}${kindText} ${cell.power} % ${cell.speed} mm/min`.slice(0, 120);
}



/** Gemessene Schnittbreite in die gespeicherten Werte eines Generators schreiben. nested: Werte liegen je Variante (Vogelhaus) */
export function withKerf(raw: string | null, kerf: number, nested: string[] = []): string {
  let s: any = {};
  try { s = JSON.parse(raw || "{}"); } catch { s = {}; }
  if (!s || typeof s !== "object" || Array.isArray(s)) s = {};
  if (nested.length) for (const k of nested) s[k] = { ...(s[k] && typeof s[k] === "object" ? s[k] : {}), kerf };
  else s.kerf = kerf;
  return JSON.stringify(s);
}
