/**
 * VEKTOR-EXPORT: Zeichnung als SVG, DXF, PDF oder PLT (HPGL) speichern
 *
 * Eingabe sind neutrale Elemente in MILLIMETERN mit Y nach OBEN (wie an der Maschine) – das Umwandeln der Formen
 * macht ui/exportMenu.ts. Diese Datei hängt nur von arcFit.ts ab, damit die Tests sie direkt laden können.
 *
 * Linienzüge aus vielen Punkten (Löcher aus Generatoren, nachgezeichnete Formen, Text) werden vorher zusammengefasst
 * (curveItems): runde Löcher werden ein echter Kreis, Rundungen echte Bögen im selben Pfad – die Kontur bleibt ein Element.
 *
 *   SVG:  Größe in mm (width/height + viewBox in mm), je Ebene eine Inkscape-Ebene, Gruppen bleiben Gruppen,
 *         Bilder werden eingebettet. Y wird umgedreht (SVG zeigt nach unten).
 *   DXF:  R12 (AC1009, ASCII), mm. LINE, ARC, CIRCLE und POLYLINE/VERTEX mit Wölbung (R12 kennt noch kein LWPOLYLINE).
 *         Je Ebene eine DXF-Ebene. Bilder gehen nicht – werden übersprungen und gezählt.
 *   PDF:  eine Seite in Bildgröße, Linien 0,1 mm. Bilder werden übersprungen.
 *   PLT:  HPGL, 40 Einheiten = 1 mm, je Ebene ein Stift (SP1, SP2 …). Bögen/Kreise als kurze Geraden.
 */

import { fitCircle, fitPathArcs } from "./arcFit.ts";

export interface XY { x: number; y: number; }

interface Base { layer: string; color: string; group?: string; name?: string }
export type ExpItem =
  /** bulges[i]: Wölbung von pts[i] zum nächsten Punkt (0 = Gerade, tan(Winkel/4), + = gegen den Uhrzeigersinn) */
  | (Base & { kind: "path"; pts: XY[]; closed: boolean; bulges?: number[] })
  | (Base & { kind: "circle"; cx: number; cy: number; r: number })
  /** start/sweep in Bogenmaß, sweep > 0 = gegen den Uhrzeigersinn */
  | (Base & { kind: "arc"; cx: number; cy: number; r: number; start: number; sweep: number })
  /** Ecken: unten links, unten rechts, oben rechts, oben links */
  | (Base & { kind: "image"; corners: [XY, XY, XY, XY]; src: string });

export interface ExpBounds { minX: number; minY: number; maxX: number; maxY: number }
export interface ExpResult { data: string; skippedImages: number }

const f = (v: number, d = 4) => {
  const s = (Math.round(v * 10 ** d) / 10 ** d).toFixed(d).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

/** Punkte entlang eines Bogens (höchstens tol mm Abweichung) */
function arcPts(cx: number, cy: number, r: number, a0: number, sweep: number, tol = 0.01): XY[] {
  const step = r > tol ? 2 * Math.acos(1 - tol / r) : Math.PI / 4;
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(1e-3, step)));
  const out: XY[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + sweep * (i / n);
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

/** Geschlossene Pfade: doppelten Endpunkt (= Anfang) weglassen */
function openPts(pts: XY[], closed: boolean): XY[] {
  if (!closed || pts.length < 2) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-6 ? pts.slice(0, -1) : pts;
}

/** Mittelpunkt, Radius und Winkel eines gewölbten Stücks */
function bulgeArc(a: XY, b: XY, bulge: number) {
  const sweep = 4 * Math.atan(bulge), d = Math.hypot(b.x - a.x, b.y - a.y);
  const r = d / (2 * Math.sin(Math.abs(sweep) / 2));
  // Abstand Mittelpunkt–Sehne; links der Fahrt bei positiver Wölbung (auch bei über 180°: dann negativ)
  const h = r * Math.cos(sweep / 2) * Math.sign(bulge);
  const cx = (a.x + b.x) / 2 - ((b.y - a.y) / d) * h, cy = (a.y + b.y) / 2 + ((b.x - a.x) / d) * h;
  return { cx, cy, r, start: Math.atan2(a.y - cy, a.x - cx), sweep };
}

/** Pfad als reine Punkte (Bögen fein abgetastet) – für PDF, PLT und die Grenzen */
function flatPath(it: { pts: XY[]; closed: boolean; bulges?: number[] }, tol = 0.01): XY[] {
  const src = openPts(it.pts, it.closed);
  if (!it.bulges) return src;
  const out: XY[] = [];
  const n = src.length;
  for (let i = 0; i < (it.closed ? n : n - 1); i++) {
    const a = src[i], b = src[(i + 1) % n], w = it.bulges[i] || 0;
    if (!w) { out.push(a); continue; }
    const g = bulgeArc(a, b, w);
    const q = arcPts(g.cx, g.cy, g.r, g.start, g.sweep, tol).slice(0, -1);
    q[0] = a;
    out.push(...q);
  }
  if (!it.closed) out.push(src[n - 1]);
  return out;
}

/** Linienzüge zusammenfassen: Kreis → circle, Rundungen → Bögen im Pfad. Höchstens tol mm Abweichung */
export function curveItems(items: ExpItem[], tol = 0.02): ExpItem[] {
  return items.map(it => {
    if (it.kind !== "path" || it.pts.length < 5) return it;
    const pts = openPts(it.pts, it.closed);
    if (it.closed) {
      const c = fitCircle(pts, tol);
      if (c) return { layer: it.layer, color: it.color, group: it.group, name: it.name, kind: "circle" as const, ...c };
    }
    const r = fitPathArcs(pts, it.closed, tol);
    return { ...it, pts: r.pts, bulges: r.bulges };
  });
}

export function exportBounds(items: ExpItem[]): ExpBounds | null {
  let b: ExpBounds | null = null;
  const add = (x: number, y: number) => {
    if (!b) b = { minX: x, minY: y, maxX: x, maxY: y };
    else { b.minX = Math.min(b.minX, x); b.minY = Math.min(b.minY, y); b.maxX = Math.max(b.maxX, x); b.maxY = Math.max(b.maxY, y); }
  };
  for (const it of items) {
    if (it.kind === "path") flatPath(it, 0.005).forEach(p => add(p.x, p.y));
    else if (it.kind === "circle") { add(it.cx - it.r, it.cy - it.r); add(it.cx + it.r, it.cy + it.r); }
    else if (it.kind === "arc") arcPts(it.cx, it.cy, it.r, it.start, it.sweep, 0.005).forEach(p => add(p.x, p.y));
    else it.corners.forEach(p => add(p.x, p.y));
  }
  return b;
}

/** Ebenen in der Reihenfolge, in der sie zuerst vorkommen */
function layersOf(items: ExpItem[]): { name: string; color: string }[] {
  const seen = new Map<string, string>();
  for (const it of items) if (!seen.has(it.layer)) seen.set(it.layer, it.color);
  return [...seen].map(([name, color]) => ({ name, color }));
}

// =====================================================================
// SVG
// =====================================================================

const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c] as string));
const safeColor = (c: string) => /^#[0-9a-f]{3,8}$/i.test(c) ? c : "#000000";
/** nur Bild-Daten-URLs einbetten (nichts, was ein Programm beim Öffnen aus dem Netz holen würde) */
const safeImage = (s: string) => /^data:image\/(png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]*$/.test(s);

export function toSvg(items: ExpItem[], strokeMm = 0.1): ExpResult {
  const b = exportBounds(items) || { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const w = Math.max(b.maxX - b.minX, 0.001), h = Math.max(b.maxY - b.minY, 0.001);
  // Welt (Y oben) -> SVG (Y unten, Ursprung links oben)
  const X = (x: number) => f(x - b.minX), Y = (y: number) => f(b.maxY - y);
  let skipped = 0;

  const el = (it: ExpItem): string => {
    const id = it.name ? ` id="${xml(it.name)}"` : "";
    switch (it.kind) {
      case "path": {
        const p = openPts(it.pts, it.closed);
        if (p.length < 2) return "";
        const seg = (i: number, q: XY) => {
          const w = it.bulges?.[i] || 0;
          if (!w) return `L${X(q.x)} ${Y(q.y)}`;
          const g = bulgeArc(p[i], q, w);
          // gegen den Uhrzeigersinn (Y oben) = sweep-flag 0 in SVG (Y unten)
          return `A${f(g.r)} ${f(g.r)} 0 ${Math.abs(g.sweep) > Math.PI ? 1 : 0} ${w > 0 ? 0 : 1} ${X(q.x)} ${Y(q.y)}`;
        };
        const parts = [`M${X(p[0].x)} ${Y(p[0].y)}`];
        for (let i = 1; i < p.length; i++) parts.push(seg(i - 1, p[i]));
        // geschlossen: das letzte Stück kann ein Bogen sein, dann erst damit zurück zum Anfang
        if (it.closed && it.bulges?.[p.length - 1]) parts.push(seg(p.length - 1, p[0]));
        const d = parts.join(" ") + (it.closed ? " Z" : "");
        return `<path${id} d="${d}"/>`;
      }
      case "circle":
        return `<circle${id} cx="${X(it.cx)}" cy="${Y(it.cy)}" r="${f(it.r)}"/>`;
      case "arc": {
        const a = { x: it.cx + it.r * Math.cos(it.start), y: it.cy + it.r * Math.sin(it.start) };
        const e = it.start + it.sweep;
        const z = { x: it.cx + it.r * Math.cos(e), y: it.cy + it.r * Math.sin(e) };
        const large = Math.abs(it.sweep) > Math.PI ? 1 : 0;
        // gegen den Uhrzeigersinn (Y oben) = im Uhrzeigersinn in SVG (Y unten) = sweep-flag 0
        const sweep = it.sweep > 0 ? 0 : 1;
        return `<path${id} d="M${X(a.x)} ${Y(a.y)} A${f(it.r)} ${f(it.r)} 0 ${large} ${sweep} ${X(z.x)} ${Y(z.y)}"/>`;
      }
      case "image": {
        if (!safeImage(it.src)) { skipped++; return ""; }
        const [bl, , tr, tl] = it.corners;
        // Bild 1×1 auf die Ecken legen: (u, v) -> oben links + u·(oben rechts − oben links) + v·(unten links − oben links)
        const m = [tr.x - tl.x, -(tr.y - tl.y), bl.x - tl.x, -(bl.y - tl.y), tl.x - b.minX, b.maxY - tl.y].map(v => f(v, 5));
        return `<image${id} x="0" y="0" width="1" height="1" preserveAspectRatio="none" transform="matrix(${m.join(" ")})" ` +
          `href="${it.src}" xlink:href="${it.src}"/>`;
      }
    }
  };

  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>`);
  out.push(`<!-- Created with CNC Craft -->`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
    `width="${f(w)}mm" height="${f(h)}mm" viewBox="0 0 ${f(w)} ${f(h)}" version="1.1">`);
  layersOf(items).forEach((l, li) => {
    const c = safeColor(l.color);
    out.push(`  <g id="layer${li + 1}" inkscape:groupmode="layer" inkscape:label="${xml(l.name)}" fill="none" stroke="${c}" ` +
      `stroke-width="${f(strokeMm)}" stroke-linejoin="round" stroke-linecap="round">`);
    // Formen mit gleicher Gruppe zusammenhalten (an der Stelle der ersten Form)
    const mine = items.filter(it => it.layer === l.name);
    const done = new Set<string>();
    for (const it of mine) {
      if (!it.group) { const s = el(it); if (s) out.push("    " + s); continue; }
      if (done.has(it.group)) continue;
      done.add(it.group);
      const inner = mine.filter(o => o.group === it.group).map(el).filter(Boolean);
      if (inner.length) out.push(`    <g id="${xml(l.name.replace(/\s+/g, "_") + "-" + it.group)}">`, ...inner.map(s => "      " + s), "    </g>");
    }
    out.push("  </g>");
  });
  out.push("</svg>", "");
  return { data: out.join("\n"), skippedImages: skipped };
}

// =====================================================================
// DXF (R12)
// =====================================================================

/** einige AutoCAD-Grundfarben (ACI) */
const ACI: [number, number, number, number][] = [
  [1, 255, 0, 0], [2, 255, 255, 0], [3, 0, 255, 0], [4, 0, 255, 255], [5, 0, 0, 255], [6, 255, 0, 255], [7, 0, 0, 0],
  [8, 128, 128, 128], [9, 192, 192, 192], [30, 255, 127, 0], [40, 255, 191, 0], [140, 0, 127, 255], [200, 191, 0, 255]
];

export function aciColor(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex) || /^#?([0-9a-f]{3})$/i.exec(hex);
  if (!m) return 7;
  const h = m[1].length === 3 ? m[1].split("").map(c => c + c).join("") : m[1];
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), bl = parseInt(h.slice(4, 6), 16);
  // fast weiß/schwarz -> 7 (wird je nach Hintergrund schwarz oder weiß gezeigt)
  if (Math.max(r, g, bl) - Math.min(r, g, bl) < 24 && (r > 220 || r < 40)) return 7;
  let best = 7, bestD = Infinity;
  for (const [n, cr, cg, cb] of ACI) {
    const d = (cr - r) ** 2 + (cg - g) ** 2 + (cb - bl) ** 2;
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

/** DXF-Ebenennamen: nur A–Z, 0–9, _ und - (R12), höchstens 31 Zeichen, nie leer */
export function dxfLayerName(name: string): string {
  const s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 31);
  return s || "0";
}

export function toDxf(items: ExpItem[]): ExpResult {
  const b = exportBounds(items) || { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const o: string[] = [];
  const p = (code: number, v: string | number) => o.push(String(code), typeof v === "number" ? f(v, 6) : v);
  // gleiche bereinigte Namen zusammenlegen, Farbe von der ersten Ebene
  const names = new Map<string, string>(); // Ebene -> DXF-Name
  const colors = new Map<string, number>();
  for (const l of layersOf(items)) {
    const n = dxfLayerName(l.name);
    names.set(l.name, n);
    if (!colors.has(n)) colors.set(n, aciColor(l.color));
  }

  p(999, "Created with CNC Craft");
  p(0, "SECTION"); p(2, "HEADER");
  p(9, "$ACADVER"); p(1, "AC1009");
  p(9, "$INSUNITS"); p(70, "4");
  p(9, "$MEASUREMENT"); p(70, "1");
  p(9, "$EXTMIN"); p(10, b.minX); p(20, b.minY); p(30, 0);
  p(9, "$EXTMAX"); p(10, b.maxX); p(20, b.maxY); p(30, 0);
  p(0, "ENDSEC");

  p(0, "SECTION"); p(2, "TABLES");
  p(0, "TABLE"); p(2, "LTYPE"); p(70, "1");
  p(0, "LTYPE"); p(2, "CONTINUOUS"); p(70, "0"); p(3, "Solid line"); p(72, "65"); p(73, "0"); p(40, 0);
  p(0, "ENDTAB");
  p(0, "TABLE"); p(2, "LAYER"); p(70, String(colors.size + 1));
  p(0, "LAYER"); p(2, "0"); p(70, "0"); p(62, "7"); p(6, "CONTINUOUS");
  for (const [n, c] of colors) {
    if (n === "0") continue;
    p(0, "LAYER"); p(2, n); p(70, "0"); p(62, String(c)); p(6, "CONTINUOUS");
  }
  p(0, "ENDTAB");
  p(0, "ENDSEC");

  let skipped = 0;
  const deg = (r: number) => r * 180 / Math.PI;
  p(0, "SECTION"); p(2, "ENTITIES");
  for (const it of items) {
    const L = names.get(it.layer) || "0";
    if (it.kind === "path") {
      const pts = openPts(it.pts, it.closed);
      if (pts.length < 2) continue;
      if (pts.length === 2 && !it.closed && !it.bulges?.[0]) {
        p(0, "LINE"); p(8, L); p(10, pts[0].x); p(20, pts[0].y); p(30, 0); p(11, pts[1].x); p(21, pts[1].y); p(31, 0);
        continue;
      }
      p(0, "POLYLINE"); p(8, L); p(66, "1"); p(10, 0); p(20, 0); p(30, 0); p(70, it.closed ? "1" : "0");
      pts.forEach((q, i) => {
        p(0, "VERTEX"); p(8, L); p(10, q.x); p(20, q.y); p(30, 0);
        if (it.bulges?.[i]) p(42, it.bulges[i]);
      });
      p(0, "SEQEND"); p(8, L);
    } else if (it.kind === "circle") {
      p(0, "CIRCLE"); p(8, L); p(10, it.cx); p(20, it.cy); p(30, 0); p(40, it.r);
    } else if (it.kind === "arc") {
      if (Math.abs(it.sweep) >= Math.PI * 2 - 1e-9) { p(0, "CIRCLE"); p(8, L); p(10, it.cx); p(20, it.cy); p(30, 0); p(40, it.r); continue; }
      // DXF-Bögen laufen immer gegen den Uhrzeigersinn
      const a0 = it.sweep >= 0 ? it.start : it.start + it.sweep;
      const a1 = a0 + Math.abs(it.sweep);
      const norm = (d: number) => ((d % 360) + 360) % 360;
      p(0, "ARC"); p(8, L); p(10, it.cx); p(20, it.cy); p(30, 0); p(40, it.r); p(50, norm(deg(a0))); p(51, norm(deg(a1)));
    } else skipped++;
  }
  p(0, "ENDSEC");
  p(0, "EOF");
  return { data: o.join("\r\n") + "\r\n", skippedImages: skipped };
}

// =====================================================================
// PDF (eine Seite, nur Linien)
// =====================================================================

const PT = 72 / 25.4;

function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255) as [number, number, number];
}

export function toPdf(items: ExpItem[], strokeMm = 0.1): ExpResult {
  const b = exportBounds(items) || { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const w = Math.max(b.maxX - b.minX, 0.001) * PT, h = Math.max(b.maxY - b.minY, 0.001) * PT;
  // PDF hat Y nach oben wie die Maschine – nur verschieben und auf Punkt umrechnen
  const X = (x: number) => f((x - b.minX) * PT, 3), Y = (y: number) => f((y - b.minY) * PT, 3);
  const c: string[] = [`${f(strokeMm * PT, 3)} w 1 J 1 j`];
  let skipped = 0;
  for (const l of layersOf(items)) {
    const [r, g, bl] = hexRgb(l.color);
    c.push(`${f(r, 3)} ${f(g, 3)} ${f(bl, 3)} RG`);
    for (const it of items) {
      if (it.layer !== l.name) continue;
      let pts: XY[] = [], closed = false;
      if (it.kind === "path") { pts = flatPath(it); closed = it.closed; }
      else if (it.kind === "circle") { pts = arcPts(it.cx, it.cy, it.r, 0, Math.PI * 2).slice(0, -1); closed = true; }
      else if (it.kind === "arc") pts = arcPts(it.cx, it.cy, it.r, it.start, it.sweep);
      else { skipped++; continue; }
      if (pts.length < 2) continue;
      c.push(pts.map((q, i) => `${X(q.x)} ${Y(q.y)} ${i ? "l" : "m"}`).join(" ") + (closed ? " s" : " S"));
    }
  }
  const content = c.join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(w, 3)} ${f(h, 3)}] /Contents 4 0 R /Resources << >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Producer (CNC Craft) >>"
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((s, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${s}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(n => String(n).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { data: out, skippedImages: skipped };
}

// =====================================================================
// PLT / HPGL
// =====================================================================

export const HPGL_PER_MM = 40;

export function toHpgl(items: ExpItem[]): ExpResult {
  const b = exportBounds(items) || { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  // Plotter mögen keine negativen Werte: Zeichnung an 0/0 legen
  const U = (v: number, o: number) => String(Math.round((v - o) * HPGL_PER_MM));
  const o: string[] = ["IN", "PA"];
  let skipped = 0;
  layersOf(items).forEach((l, li) => {
    o.push(`SP${(li % 8) + 1}`);
    for (const it of items) {
      if (it.layer !== l.name) continue;
      let pts: XY[] = [], closed = false;
      if (it.kind === "path") { pts = flatPath(it, 0.025); closed = it.closed; }
      else if (it.kind === "circle") { pts = arcPts(it.cx, it.cy, it.r, 0, Math.PI * 2, 0.025).slice(0, -1); closed = true; }
      else if (it.kind === "arc") pts = arcPts(it.cx, it.cy, it.r, it.start, it.sweep, 0.025);
      else { skipped++; continue; }
      if (pts.length < 2) continue;
      const seq = closed ? [...pts, pts[0]] : pts;
      o.push(`PU${U(seq[0].x, b.minX)},${U(seq[0].y, b.minY)}`);
      o.push("PD" + seq.slice(1).map(q => `${U(q.x, b.minX)},${U(q.y, b.minY)}`).join(","));
    }
  });
  o.push("PU", "SP0", "");
  return { data: o.join(";\n"), skippedImages: skipped };
}
