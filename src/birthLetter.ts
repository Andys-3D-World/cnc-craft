/**
 * GEBURTSBUCHSTABE: großer Holz-Buchstabe mit Name, Geburtsdatum und Geburtsdaten (Uhrzeit, Größe, Gewicht …),
 * dazu eigene Bilder und kleine Motive (Fenster: editor/birthLetterGen.ts)
 *
 * Aufteilung im Buchstaben (alles automatisch, danach auf der Zeichenfläche frei verschiebbar):
 *   1. Name: im breitesten waagerechten Streifen, so groß wie möglich (höchstens Namenshöhe), bevorzugt mittig
 *   2. Datum direkt darunter, darunter ein Trenner (Linie – Herz – Linie)
 *   3. eigene Bilder: so groß wie möglich in den freien Flächen
 *   4. Geburtsdaten (Symbol über Text): jeweils dorthin, wo am meisten Abstand zu allem anderen ist
 *   5. kleine Motive (Herzen, Sterne, Blätter …) füllen den restlichen Platz
 * Grundlage ist ein Raster der Buchstabenfläche (Zelle ≈ Höhe/160) mit Summentabelle – damit ist „passt das
 * Rechteck ganz hinein?“ ein schneller Nachschlag. Der Rand zum Umriss wird dabei mitgeprüft.
 *
 * Symbole und Motive sind für CNC Craft gezeichnet (einfache Linien, gut zu gravieren).
 * Nur Geometrie (Tests: `npm test`). Alles in mm, Y nach oben.
 */
import type { MultiPolygon } from "polygon-clipping";

export type XY = [number, number];
export interface Box { x: number; y: number; w: number; h: number }
export interface Line { pts: XY[]; closed: boolean }

export type IconKind = "clock" | "ruler" | "scale" | "feet";
export const ICON_KINDS: IconKind[] = ["clock", "ruler", "scale", "feet"];
export type MotifKind = "heart" | "star" | "leaf" | "flower" | "butterfly";
export const MOTIF_KINDS: MotifKind[] = ["heart", "star", "leaf", "flower", "butterfly"];

// ---------------------------------------------------------------------------------------------------
// Raster der Fläche
// ---------------------------------------------------------------------------------------------------

export interface Grid { x0: number; y0: number; cell: number; nx: number; ny: number; sat: Int32Array } // sat: Anzahl Zellen AUSSERHALB

function inside(m: MultiPolygon, x: number, y: number): boolean {
  let c = false;
  for (const poly of m) for (const r of poly) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

export function makeGrid(m: MultiPolygon, cell: number): Grid {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of m) for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell)), ny = Math.max(1, Math.ceil((y1 - y0) / cell));
  const sat = new Int32Array((nx + 1) * (ny + 1));
  for (let j = 0; j < ny; j++) {
    let row = 0;
    for (let i = 0; i < nx; i++) {
      // Zelle zählt als innen, wenn Mitte und alle vier Ecken innen liegen (sicher, auch an schrägen Kanten)
      const cx = x0 + i * cell, cy = y0 + j * cell;
      const ok = inside(m, cx + cell / 2, cy + cell / 2) && inside(m, cx, cy) && inside(m, cx + cell, cy) && inside(m, cx, cy + cell) && inside(m, cx + cell, cy + cell);
      row += ok ? 0 : 1;
      sat[(j + 1) * (nx + 1) + i + 1] = sat[j * (nx + 1) + i + 1] + row;
    }
  }
  return { x0, y0, cell, nx, ny, sat };
}

/** liegt das Rechteck (plus Rand) ganz in der Fläche? */
export function boxFits(g: Grid, b: Box, margin = 0): boolean {
  const i0 = Math.floor((b.x - margin - g.x0) / g.cell), j0 = Math.floor((b.y - margin - g.y0) / g.cell);
  const i1 = Math.ceil((b.x + b.w + margin - g.x0) / g.cell), j1 = Math.ceil((b.y + b.h + margin - g.y0) / g.cell);
  if (i0 < 0 || j0 < 0 || i1 > g.nx || j1 > g.ny) return false;
  const W = g.nx + 1, s = g.sat;
  return s[j1 * W + i1] - s[j0 * W + i1] - s[j1 * W + i0] + s[j0 * W + i0] === 0;
}

const boxDist = (a: Box, b: Box) => {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.hypot(dx, dy);
};

/**
 * Rechteck w × h dorthin setzen, wo es ganz in die Fläche passt und am weitesten von allem Belegten entfernt ist
 * (mindestens `gap`). null = passt nirgends.
 */
export function placeBox(g: Grid, occupied: Box[], w: number, h: number, margin: number, gap: number): Box | null {
  let best: Box | null = null, bestD = -1;
  const cx = g.x0 + g.nx * g.cell / 2, cy = g.y0 + g.ny * g.cell / 2;
  for (let j = 0; j * g.cell + h <= g.ny * g.cell; j++) for (let i = 0; i * g.cell + w <= g.nx * g.cell; i++) {
    const b = { x: g.x0 + i * g.cell, y: g.y0 + j * g.cell, w, h };
    if (!boxFits(g, b, margin)) continue;
    let d = Infinity;
    for (const o of occupied) d = Math.min(d, boxDist(b, o));
    if (d < gap) continue;
    // gleich weit weg: lieber näher an der Mitte (ruhigeres Bild)
    const score = Math.min(d, 1e6) - 1e-3 * Math.hypot(b.x + w / 2 - cx, b.y + h / 2 - cy);
    if (score > bestD) { bestD = score; best = b; }
  }
  return best;
}

/**
 * Breitester waagerechter Streifen für einen Text mit Seitenverhältnis ratio (Breite/Höhe): größtmögliche Texthöhe
 * bis hMax. Bei gleicher Größe gewinnt der Streifen näher an `preferY`.
 */
export function widestBand(g: Grid, ratio: number, hMax: number, margin: number, preferY: number): Box | null {
  let best: Box | null = null, bestScore = -Infinity;
  const W = g.nx + 1, s = g.sat;
  for (let k = 0; k < 8; k++) {
    const h = hMax * (1 - k * 0.08);
    const rows = Math.ceil((h + 2 * margin) / g.cell);
    for (let j = 0; j + rows <= g.ny; j++) {
      // Spalten, die über die ganze Streifenhöhe innen sind → längster Lauf
      let run = 0, bestRun = 0, bestEnd = 0;
      for (let i = 0; i < g.nx; i++) {
        const out = s[(j + rows) * W + i + 1] - s[j * W + i + 1] - s[(j + rows) * W + i] + s[j * W + i];
        run = out === 0 ? run + 1 : 0;
        if (run > bestRun) { bestRun = run; bestEnd = i + 1; }
      }
      const runW = bestRun * g.cell - 2 * margin;
      if (runW <= 0) continue;
      const th = Math.min(h, runW / ratio), tw = th * ratio;
      const y = g.y0 + j * g.cell + margin + (h - th) / 2;
      const score = th - 1e-3 * Math.abs(y + th / 2 - preferY);
      if (score > bestScore) {
        bestScore = score;
        const xr0 = g.x0 + (bestEnd - bestRun) * g.cell + margin;
        best = { x: xr0 + (runW - tw) / 2, y, w: tw, h: th };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------
// Aufteilung
// ---------------------------------------------------------------------------------------------------

export interface LayoutInput {
  letter: MultiPolygon;          // Buchstabe in mm (fertige Größe)
  height: number;                // Höhe des Buchstabens (mm)
  margin: number;                // Abstand zum Rand (mm)
  nameRatio: number;             // Name: Breite/Höhe (0 = kein Name)
  nameSize: number;              // höchste Namenshöhe in % der Buchstabenhöhe
  dateRatio: number;             // Datum: Breite/Höhe (0 = kein Datum)
  dateSize: number;              // Datumshöhe in % der Buchstabenhöhe
  infos: { w: number; h: number }[]; // Geburtsdaten-Kästchen (Symbol + Text), fertige Größe in mm
  images: number[];              // eigene Bilder: Seitenverhältnis Höhe/Breite
  imageMax: number;              // größte Bildseite in % der Buchstabenhöhe
  motifs: number;                // so viele kleine Motive wie möglich, höchstens
  motifSize: number;             // Größe der Motive (mm)
}

export interface Layout {
  name: Box | null; date: Box | null; divider: Box | null;
  infos: (Box | null)[]; images: (Box | null)[]; motifs: Box[];
  warnings: string[];
}

export function layoutBirth(inp: LayoutInput): Layout {
  const H = inp.height, warnings: string[] = [];
  const g = makeGrid(inp.letter, Math.max(0.4, H / 160));
  const occ: Box[] = [];
  const gap = H * 0.015;
  let name: Box | null = null, date: Box | null = null, divider: Box | null = null;
  if (inp.nameRatio > 0) {
    // Platz für Datum + Trenner unter dem Namen gleich mit reservieren: Streifen etwas höher suchen
    name = widestBand(g, inp.nameRatio, H * inp.nameSize / 100, inp.margin, g.y0 + g.ny * g.cell * 0.55);
    if (name) occ.push(name);
    if (!name || name.h < 5) warnings.push("birth.warnName"); // unter 5 mm Schrifthöhe kaum lesbar
  }
  if (inp.dateRatio > 0) {
    const dh = H * inp.dateSize / 100, dw = dh * inp.dateRatio;
    if (name) {
      // unter dem Namen: erst mittig, dann seitlich verschoben, dann etwas kleiner (bis 70 %)
      search: for (let k = 1; k >= 0.69; k -= 0.1) {
        const w = dw * k, h = dh * k;
        for (let step = 0; step <= 12; step++) for (const sgn of step ? [1, -1] : [1]) {
          const b = { x: name.x + name.w / 2 - w / 2 + sgn * step * w / 24, y: name.y - gap - h, w, h };
          if (boxFits(g, b, inp.margin * 0.5)) { date = b; break search; }
        }
      }
    }
    if (!date) date = placeBox(g, occ, dw, dh, inp.margin, gap);
    if (date) {
      occ.push(date);
      const vh = dh * 0.9, vw = Math.min(dw * 1.2, dh * 7);
      const v = { x: date.x + date.w / 2 - vw / 2, y: date.y - gap * 0.6 - vh, w: vw, h: vh };
      if (boxFits(g, v, inp.margin * 0.5) && !occ.some(o => boxDist(o, v) < 1e-9 && o !== date)) { divider = v; occ.push(v); }
    } else warnings.push("birth.warnDate");
  }
  const images: (Box | null)[] = inp.images.map(ratio => {
    for (let s = H * inp.imageMax / 100; s >= Math.max(H * 0.1, 8); s *= 0.9) { // kleiner als 8 mm lohnt kein Bild
      const w = ratio > 1 ? s / ratio : s, h = ratio > 1 ? s : s * ratio;
      const b = placeBox(g, occ, w, h, inp.margin, gap);
      if (b) { occ.push(b); return b; }
    }
    warnings.push("birth.warnImage");
    return null;
  });
  const infos: (Box | null)[] = inp.infos.map(s => {
    // passt es nicht, etwas kleiner versuchen (bis 60 %)
    for (let k = 1; k >= 0.6; k -= 0.1) {
      const b = placeBox(g, occ, s.w * k, s.h * k, inp.margin, gap);
      if (b) { occ.push(b); return b; }
    }
    warnings.push("birth.warnInfo");
    return null;
  });
  const motifs: Box[] = [];
  for (let n = 0; n < inp.motifs; n++) {
    const b = placeBox(g, occ, inp.motifSize, inp.motifSize, inp.margin * 0.6, Math.max(gap, inp.motifSize * 0.6));
    if (!b) break;
    occ.push(b); motifs.push(b);
  }
  return { name, date, divider, infos, images, motifs, warnings };
}

// ---------------------------------------------------------------------------------------------------
// Symbole und Motive – im Feld 0 … 1 (Y nach oben), Linien zum Gravieren
// ---------------------------------------------------------------------------------------------------

const arc = (cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 24): XY[] =>
  Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / n; return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as XY; });
const ring = (cx: number, cy: number, rx: number, ry: number, n = 32): Line => ({ pts: arc(cx, cy, rx, ry, 0, 2 * Math.PI, n), closed: true });
const rot = (pts: XY[], cx: number, cy: number, a: number): XY[] =>
  pts.map(([x, y]) => [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)]);

function heart(): Line[] {
  const pts: XY[] = [];
  for (let i = 0; i < 48; i++) {
    const t = 2 * Math.PI * i / 48;
    pts.push([0.5 + 0.48 * Math.sin(t) ** 3, 0.47 + 0.4 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 16]);
  }
  pts.push(pts[0]);
  return [{ pts, closed: true }];
}

function star(): Line[] {
  const pts: XY[] = [];
  for (let i = 0; i < 10; i++) { const a = Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.2 : 0.5; pts.push([0.5 + r * Math.cos(a), 0.47 + r * Math.sin(a)]); }
  pts.push(pts[0]);
  return [{ pts, closed: true }];
}

function leaf(): Line[] {
  // Blatt schräg: zwei Bögen, Mittelrippe, drei Adern je Seite
  const a = arc(0.85, 0.5, 0.5, 0.5, Math.PI * 0.75, Math.PI * 1.25, 16), b = arc(0.15, 0.5, 0.5, 0.5, -Math.PI * 0.25, Math.PI * 0.25, 16);
  const body: XY[] = [...a, ...b.slice(1), a[0]];
  const r = (p: XY[]) => rot(p, 0.5, 0.5, -Math.PI / 4);
  const lines: Line[] = [{ pts: r(body), closed: true }, { pts: r([[0.5, 0.15], [0.5, 0.92]]), closed: false }];
  for (const y of [0.35, 0.5, 0.65]) { lines.push({ pts: r([[0.5, y], [0.38, y + 0.1]]), closed: false }, { pts: r([[0.5, y], [0.62, y + 0.1]]), closed: false }); }
  return lines;
}

function flower(): Line[] {
  const lines: Line[] = [ring(0.5, 0.5, 0.11, 0.11, 20)];
  for (let k = 0; k < 5; k++) {
    const a = Math.PI / 2 + k * 2 * Math.PI / 5;
    lines.push({ pts: rot(arc(0.5, 0.75, 0.13, 0.2, 0, 2 * Math.PI, 24), 0.5, 0.5, a - Math.PI / 2), closed: true });
  }
  return lines;
}

function butterfly(): Line[] {
  const w = (cx: number, cy: number, rx: number, ry: number, a: number): Line => ({ pts: rot(arc(cx, cy, rx, ry, 0, 2 * Math.PI, 28), cx, cy, a), closed: true });
  return [w(0.3, 0.62, 0.2, 0.15, 0.5), w(0.7, 0.62, 0.2, 0.15, -0.5), w(0.34, 0.33, 0.13, 0.1, -0.5), w(0.66, 0.33, 0.13, 0.1, 0.5),
    { pts: [[0.5, 0.2], [0.5, 0.75]], closed: false }, { pts: [[0.5, 0.75], [0.42, 0.92]], closed: false }, { pts: [[0.5, 0.75], [0.58, 0.92]], closed: false }];
}

function clock(): Line[] {
  return [ring(0.5, 0.45, 0.33, 0.33, 40), { pts: [[0.5, 0.45], [0.5, 0.65]], closed: false }, { pts: [[0.5, 0.45], [0.64, 0.38]], closed: false },
    { pts: arc(0.24, 0.8, 0.13, 0.1, 0, Math.PI, 12).concat([[0.11, 0.8]]), closed: true },
    { pts: arc(0.76, 0.8, 0.13, 0.1, 0, Math.PI, 12).concat([[0.63, 0.8]]), closed: true },
    { pts: [[0.3, 0.17], [0.2, 0.04]], closed: false }, { pts: [[0.7, 0.17], [0.8, 0.04]], closed: false }];
}

function ruler(): Line[] {
  const r = (p: XY[]) => rot(p, 0.5, 0.5, Math.PI / 9);
  const lines: Line[] = [{ pts: r([[0.02, 0.36], [0.98, 0.36], [0.98, 0.64], [0.02, 0.64], [0.02, 0.36]]), closed: true }];
  for (let i = 1; i < 10; i++) { const x = 0.02 + i * 0.096; lines.push({ pts: r([[x, 0.64], [x, i % 5 === 0 ? 0.46 : 0.54]]), closed: false }); }
  return lines;
}

function scale(): Line[] {
  // Gewicht (wie ein Kilo-Gewicht): Trapez mit Griff, kleines Herz in der Mitte
  const body: Line = { pts: [[0.1, 0.06], [0.9, 0.06], [0.74, 0.62], [0.26, 0.62], [0.1, 0.06]], closed: true };
  const handle: Line = { pts: arc(0.5, 0.75, 0.15, 0.15, -0.3, Math.PI + 0.3, 20), closed: false };
  const h = heart()[0].pts.map(([x, y]) => [0.38 + x * 0.24, 0.22 + y * 0.24] as XY);
  return [body, handle, { pts: h, closed: true }];
}

function feet(): Line[] {
  const foot = (dx: number, flip: number): Line[] => {
    const out: Line[] = [{ pts: rot(arc(dx, 0.32, 0.13, 0.27, 0, 2 * Math.PI, 28), dx, 0.32, flip * 0.12), closed: true }];
    const toes: [number, number, number][] = [[-0.09, 0.66, 0.045], [-0.03, 0.71, 0.04], [0.03, 0.72, 0.037], [0.08, 0.7, 0.033], [0.12, 0.65, 0.03]];
    for (const [tx, ty, r] of toes) out.push(ring(dx + flip * tx, ty, r, r, 14));
    return out;
  };
  return [...foot(0.28, -1), ...foot(0.72, 1)];
}

export function iconLines(kind: IconKind | MotifKind): Line[] {
  switch (kind) {
    case "clock": return clock();
    case "ruler": return ruler();
    case "scale": return scale();
    case "feet": return feet();
    case "heart": return heart();
    case "star": return star();
    case "leaf": return leaf();
    case "flower": return flower();
    default: return butterfly();
  }
}

/** Trenner unter dem Datum: Linie – Herz – Linie, im Feld w × h */
export function dividerLines(w: number, h: number): Line[] {
  const hs = h, hx = w / 2 - hs / 2;
  const hrt = heart()[0].pts.map(([x, y]) => [hx + x * hs, y * hs] as XY);
  return [{ pts: [[0, h / 2], [hx - h * 0.4, h / 2]], closed: false }, { pts: hrt, closed: true }, { pts: [[hx + hs + h * 0.4, h / 2], [w, h / 2]], closed: false }];
}

/** Linien ins Rechteck b setzen (Feld 0 … 1 → b) */
export function fitLines(lines: Line[], b: Box): Line[] {
  const s = Math.min(b.w, b.h), ox = b.x + (b.w - s) / 2, oy = b.y + (b.h - s) / 2;
  return lines.map(l => ({ closed: l.closed, pts: l.pts.map(([x, y]) => [ox + x * s, oy + y * s] as XY) }));
}
