/**
 * KLEINE TEILE: Etikett, Schlüsselanhänger, Fotorahmen. Nur Geometrie, alles in mm, Y nach oben, Mitte bei (0, 0).
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import type { XY } from "./nameConnect.ts";

export const close = (r: XY[]): XY[] => [...r, r[0]];

/** Rechteck mit runden Ecken; die Punktzahl wächst mit dem Radius, damit große Ecken nicht eckig wirken */
export function roundedRect(x0: number, y0: number, x1: number, y1: number, rIn: number): XY[] {
  const r = Math.max(0, Math.min(rIn, (x1 - x0) / 2, (y1 - y0) / 2));
  if (r < 1e-6) return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const n = Math.max(6, Math.ceil(r * 2)), out: XY[] = [];
  const corners: [number, number, number][] = [[x1 - r, y0 + r, -90], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, 90], [x0 + r, y0 + r, 180]];
  for (const [cx, cy, a0] of corners) for (let i = 0; i <= n; i++) {
    const a = ((a0 + (90 * i) / n) * Math.PI) / 180;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

export function circleRing(cx: number, cy: number, r: number): XY[] {
  const n = Math.max(24, Math.min(96, Math.ceil(r * 8)));
  return Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as XY; });
}

export interface PartBox { x0: number; y0: number; x1: number; y1: number }
export interface SmallPart { cut: MultiPolygon; textBox: PartBox | null; key: string }
export interface SmallResult { parts: SmallPart[]; warnings: string[] }

// ---------------- Etikett ----------------
export interface LabelOptions { width: number; height: number; radius: number; holeD: number; holes: 0 | 1 | 2 }

export function labelPart(o: LabelOptions): SmallResult {
  const w = o.width / 2, h = o.height / 2, r = o.holeD / 2, warnings: string[] = [];
  const edge = Math.max(2, o.holeD * 0.75), inset = edge + r;
  const spots: XY[] = o.holes === 0 || !(o.holeD > 0) ? [] : o.holes === 1 ? [[-w + inset, 0]] : [[-w + inset, 0], [w - inset, 0]];
  if (spots.length && (2 * inset >= o.height + o.holeD * 0.5 || inset * (o.holes === 2 ? 2 : 1) >= o.width * 0.6)) warnings.push("part.warn.holeBig");
  const box: PartBox = { x0: -w + (spots.length ? inset + r + 1 : edge), y0: -h + edge, x1: w - (o.holes === 2 && spots.length ? inset + r + 1 : edge), y1: h - edge };
  return { parts: [{ key: "label", cut: [[close(roundedRect(-w, -h, w, h, o.radius)), ...spots.map(([x, y]) => close(circleRing(x, y, r)))]], textBox: box.x1 > box.x0 && box.y1 > box.y0 ? box : null }], warnings };
}

// ---------------- Schlüsselanhänger ----------------
export type KeyShape = "round" | "pill" | "rect";
export const KEY_SHAPES: KeyShape[] = ["pill", "round", "rect"];
export interface KeychainOptions { shape: KeyShape; width: number; height: number; holeD: number; ring: number }

export function keychainPart(o: KeychainOptions): SmallResult {
  const warnings: string[] = [];
  const w = o.width / 2, h = (o.shape === "round" ? o.width : o.height) / 2, r = o.holeD / 2;
  const body = o.shape === "round" ? circleRing(0, 0, w) : roundedRect(-w, -h, w, h, o.shape === "pill" ? h : Math.min(w, h) * 0.2);
  // Öse links: Scheibe, die in den Körper hineinragt, damit Loch und Rand immer stabil sind
  const eyeR = r + o.ring, eyeX = -w - r * 0.3;
  const outer = polygonClipping.union([[close(body)]], [[close(circleRing(eyeX, 0, eyeR))]]);
  if (o.ring < 2) warnings.push("part.warn.ringThin");
  const hole = close(circleRing(eyeX, 0, r));
  const m = o.shape === "round" ? w * 0.72 : w - Math.min(w, h) * 0.3;
  const hb = o.shape === "round" ? w * 0.42 : h * 0.68;
  const cut: MultiPolygon = outer.map((p, i) => (i === 0 ? [...p, hole] : p));
  return { parts: [{ key: "keychain", cut, textBox: { x0: -m + Math.max(0, eyeX + eyeR + 1 + m), y0: -hb, x1: m, y1: hb } }], warnings };
}

// ---------------- Fotorahmen ----------------
export type FrameStyle = "plain" | "rounded" | "scallop";
export const FRAME_STYLES: FrameStyle[] = ["plain", "rounded", "scallop"];
export interface FrameOptions { photoW: number; photoH: number; border: number; overlap: number; clear: number; style: FrameStyle; hanger: boolean }

function scallopRect(w: number, h: number, d: number): XY[] {
  const side = (ax: number, ay: number, bx: number, by: number, nx: number, ny: number): XY[] => {
    const L = Math.hypot(bx - ax, by - ay), bumps = Math.max(2, Math.round(L / (d * 4))), steps = bumps * 10, out: XY[] = [];
    for (let i = 0; i < steps; i++) { const u = i / steps, k = Math.abs(Math.sin(u * bumps * Math.PI)) * d; out.push([ax + (bx - ax) * u + nx * k, ay + (by - ay) * u + ny * k]); }
    return out;
  };
  return [...side(-w, -h, w, -h, 0, -1), ...side(w, -h, w, h, 1, 0), ...side(w, h, -w, h, 0, 1), ...side(-w, h, -w, -h, -1, 0)];
}

/** Drei Lagen: Vorderseite mit Fenster, Mittellage (U-förmig, oben offen: dort schiebt man das Foto ein), Rückwand */
export function framePart(o: FrameOptions): SmallResult {
  const warnings: string[] = [];
  const pw = o.photoW / 2 + o.clear, ph = o.photoH / 2 + o.clear;
  const ow = o.photoW / 2 + o.border, oh = o.photoH / 2 + o.border;
  const wx = o.photoW / 2 - o.overlap, wy = o.photoH / 2 - o.overlap;
  if (o.border - o.clear < 5) warnings.push("part.warn.borderThin");
  const outline = o.style === "scallop" ? scallopRect(ow - o.border * 0.15, oh - o.border * 0.15, o.border * 0.15) : roundedRect(-ow, -oh, ow, oh, o.style === "rounded" ? o.border * 0.8 : 0);
  const winR = o.style === "rounded" ? Math.min(o.border * 0.5, wx, wy) : 0;
  const hangers = o.hanger ? [close(circleRing(-ow * 0.5, oh - o.border / 2, 2)), close(circleRing(ow * 0.5, oh - o.border / 2, 2))] : [];
  const front: MultiPolygon = [[close(outline), close(roundedRect(-wx, -wy, wx, wy, winR))]];
  // Mittellage: Tasche fürs Foto, nach oben durchgehend offen
  const middle = polygonClipping.difference([[close(outline)]], [[close([[-pw, -ph], [pw, -ph], [pw, oh + 5], [-pw, oh + 5]] as XY[])]]);
  const back: MultiPolygon = [[close(outline), ...hangers]];
  return { warnings, parts: [{ key: "front", cut: front, textBox: null }, { key: "middle", cut: middle, textBox: null }, { key: "back", cut: back, textBox: null }] };
}

export interface Box { x0: number; y0: number; x1: number; y1: number }

/**
 * Teile aufs Bett legen: nebeneinander, mittig. Ist die Reihe breiter als das Bett, in weitere Reihen umbrechen
 * (erste Reihe oben). Rückgabe: linke untere Ecke je Teil in mm. Passt alles in eine Reihe, liegt jedes Teil
 * mittig in der Höhe – wie bisher.
 */
export function rowLayout(parts: Box[], bedW: number, bedH: number, gap = 5, margin = 5): { x: number; y: number }[] {
  const rows: { items: number[]; w: number; h: number }[] = [];
  parts.forEach((b, i) => {
    const w = b.x1 - b.x0, h = b.y1 - b.y0, row = rows[rows.length - 1];
    if (row && row.w + gap + w <= bedW - 2 * margin) { row.items.push(i); row.w += gap + w; row.h = Math.max(row.h, h); }
    else rows.push({ items: [i], w, h });
  });
  const total = rows.reduce((s, r) => s + r.h, 0) + gap * Math.max(0, rows.length - 1);
  let top = total <= bedH - 2 * margin ? (bedH + total) / 2 : margin + total;
  const out: { x: number; y: number }[] = [];
  for (const row of rows) {
    let x = Math.max(margin, (bedW - row.w) / 2);
    for (const i of row.items) {
      const b = parts[i], h = b.y1 - b.y0;
      out[i] = { x, y: top - row.h + (row.h - h) / 2 };
      x += b.x1 - b.x0 + gap;
    }
    top -= row.h + gap;
  }
  return out;
}
