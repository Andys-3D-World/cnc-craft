/**
 * EINZELLINIEN-SCHRIFT (Relief SingleLine, SIL OFL)
 *
 * Normale Schriften bestehen aus Umrissen – zum Gravieren fährt die Maschine dann jeden
 * Buchstaben zweimal ab (außen herum). Eine Einzellinien-Schrift besteht aus offenen Linien:
 * die Maschine fährt jeden Strich nur einmal. Die Linien kommen aus der SVG-Schrift
 * public/fonts/reliefsingleline/ReliefSingleLine-Regular.svg (Glyphen = SVG-Pfade, Y nach oben).
 */
import { parsePathData } from "../importers/svgImport";
import type { TextParams, TracedText } from "./textTool";

interface Glyph { name: string; adv: number; paths: { pts: { x: number; y: number }[]; closed: boolean }[]; }
interface SvgFont { glyphs: Map<string, Glyph>; kern: Map<string, number>; defAdv: number; capHeight: number; }

let fontPromise: Promise<SvgFont> | null = null;

function loadFont(): Promise<SvgFont> {
  if (!fontPromise) {
    fontPromise = fetch("/fonts/reliefsingleline/ReliefSingleLine-Regular.svg")
      .then(r => r.text())
      .then(parseSvgFont)
      .catch(e => { fontPromise = null; throw e; });
  }
  return fontPromise;
}

export function parseSvgFont(text: string): SvgFont {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const fontEl = doc.querySelector("font");
  const defAdv = parseFloat(fontEl?.getAttribute("horiz-adv-x") || "500");
  const capHeight = parseFloat(doc.querySelector("font-face")?.getAttribute("cap-height") || "700");
  const glyphs = new Map<string, Glyph>();
  const byName = new Map<string, Glyph>();
  doc.querySelectorAll("glyph").forEach(g => {
    const uni = g.getAttribute("unicode");
    const name = g.getAttribute("glyph-name") || "";
    const glyph: Glyph = {
      name,
      adv: parseFloat(g.getAttribute("horiz-adv-x") || "") || defAdv,
      paths: parsePathData(g.getAttribute("d") || "", 2)
    };
    byName.set(name, glyph);
    // Nur Einzelzeichen (Ligaturen wie "fi" überspringen)
    if (uni && [...uni].length === 1 && !glyphs.has(uni)) glyphs.set(uni, glyph);
  });
  // Unterschneidung: Paare von Glyphen-Namen (g1/g2) oder Zeichen (u1/u2)
  const kern = new Map<string, number>();
  const names = (list: string | null) => (list || "").split(",").map(s => s.trim()).filter(Boolean);
  doc.querySelectorAll("hkern").forEach(h => {
    const k = parseFloat(h.getAttribute("k") || "0");
    if (!k) return;
    const left = [...names(h.getAttribute("g1")), ...names(h.getAttribute("u1")).map(u => glyphs.get(u)?.name || "")];
    const right = [...names(h.getAttribute("g2")), ...names(h.getAttribute("u2")).map(u => glyphs.get(u)?.name || "")];
    for (const a of left) for (const b of right) if (a && b) kern.set(a + "|" + b, k);
  });
  return { glyphs, kern, defAdv, capHeight };
}

/** Text als offene Linien (mm, Y nach oben, linke untere Ecke = 0,0) */
export async function traceSingleLine(p: TextParams): Promise<TracedText> {
  const font = await loadFont();
  const s = p.heightMm / font.capHeight;          // Schrift-Einheiten -> mm
  const ls = p.letterSpacing / s;                 // mm -> Schrift-Einheiten
  const lineH = font.capHeight * (p.lineSpacing / 100);
  const slant = p.italic ? 0.21 : 0;              // ~12° schräg
  const fallback = font.glyphs.get("?");

  const lines = p.text.replace(/\r/g, "").split("\n").map(line => {
    const items: { g: Glyph; x: number }[] = [];
    let x = 0;
    let prev: Glyph | null = null;
    for (const ch of line) {
      const g = font.glyphs.get(ch) ?? (ch.trim() ? fallback : undefined);
      if (!g) { x += (font.glyphs.get(" ")?.adv ?? font.defAdv) + ls; prev = null; continue; }
      if (prev) x -= font.kern.get(prev.name + "|" + g.name) ?? 0;
      items.push({ g, x });
      x += g.adv + ls;
      prev = g;
    }
    return { items, width: Math.max(0, x - ls) };
  });
  const maxW = Math.max(0, ...lines.map(l => l.width));

  const loops: { x: number; y: number }[][] = [];
  const closed: boolean[] = [];
  lines.forEach((l, i) => {
    const dx = p.align === "center" ? (maxW - l.width) / 2 : p.align === "right" ? maxW - l.width : 0;
    const baseY = -i * lineH;
    for (const it of l.items) for (const path of it.g.paths) {
      loops.push(path.pts.map(q => {
        const y = q.y + baseY;
        return { x: (q.x + it.x + dx + q.y * slant) * s, y: y * s };
      }));
      closed.push(path.closed);
    }
  });
  if (!loops.length) return { loops: [], holes: [], width: 0, height: 0 };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of loops) for (const q of l) {
    if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
  }
  return {
    loops: loops.map(l => l.map(q => ({ x: q.x - minX, y: q.y - minY }))),
    holes: loops.map(() => false),
    closed,
    width: maxX - minX,
    height: maxY - minY
  };
}
