/**
 * WERKZEUG-ANSICHT AUF DER ZEICHENFLÄCHE (wie in Estlcam)
 *
 *  - Fräserbreite: Unter jeder Kontur wird der Streifen gezeigt, den der Fräser wegnimmt
 *    (außen/innen um den Radius versetzt, "auf Linie" mittig). Farbe = Werkzeugfarbe.
 *  - Passt das Werkzeug nicht in eine Kontur, wird sie rot gestrichelt markiert.
 *  - Marke "T1", "T2" … an jedem Teil, sobald mehr als ein Werkzeug benutzt wird.
 *
 * Ein-/ausschalten: Knopf in der Werkzeugleiste (options.showTools).
 * Die versetzten Konturen werden zwischengespeichert und nur neu berechnet, wenn sich
 * die Form, der Modus oder der Werkzeugdurchmesser ändert.
 */
import { toolForShape, toolNumber, toolColor, MillingTool } from "./toolLibrary";
import { arcGeometry, shapeBounds, makeEllipsePoints, MM_TO_PIXEL, Pt } from "./shapeTransform";
import { offsetPolygon } from "./polyOffset";
import { tabSettings, tabCenters, cumulative, pointAt, outline } from "./tabs";

type SX = (x: number) => number;

interface Cached { sig: string; loops: Pt[][]; tooBig: boolean }
const cache = new WeakMap<object, Cached>();
/** Konturen, in die das Werkzeug nicht passt (werden nach den Konturlinien rot gestrichelt) */
let pendingTooBig: any[] = [];
let lastScale = 1;

/** Billige Prüfsumme der Punkte (ändert sich bei jedem Verschieben/Skalieren/Drehen) */
function pointsSig(pts: Pt[]): string {
  let a = 0, b = 0;
  for (let i = 0; i < pts.length; i++) { a += pts[i].x * (i % 7 + 1); b += pts[i].y * (i % 5 + 1); }
  return `${pts.length}:${a.toFixed(3)}:${b.toFixed(3)}`;
}

/** Versetzte Kontur(en) für geschlossene Polylinien, aus dem Zwischenspeicher */
function offsetLoops(shape: any, d: number): Cached {
  const sig = `${shape.millingMode}|${d}|${pointsSig(shape.points)}`;
  const c = cache.get(shape);
  if (c && c.sig === sig) return c;
  let loops: Pt[][] = [];
  try { loops = offsetPolygon(shape.points, d, 0.05); } catch { loops = []; }
  const res = { sig, loops, tooBig: loops.length === 0 };
  cache.set(shape, res);
  return res;
}

/**
 * Fräserbreite unter die Formen zeichnen (vor den Konturlinien aufrufen).
 */
export function drawToolBands(
  ctx: CanvasRenderingContext2D, shapes: any[], sx: SX, sy: SX, scale: number,
  resolve?: (shape: any) => { diameter: number; color: string } | null
) {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.globalAlpha = 0.22;
  const tooBig: any[] = [];
  pendingTooBig = tooBig;
  lastScale = scale;

  for (const shape of shapes) {
    const r0 = resolve ? resolve(shape) : (() => { const tl = toolForShape(shape); return tl ? { diameter: tl.diameter, color: toolColor(tl) } : null; })();
    if (!r0 || !(r0.diameter > 0)) continue;
    const tool = r0;
    const mode = shape.millingMode || "outside";
    if (mode === "vcarve" || mode === "vplug") continue; // V-Carve: Breite hängt von der Tiefe ab – keine Fräserspur
    const rPx = (tool.diameter / 2) * MM_TO_PIXEL;
    if (mode === "drill") {
      // Bohrung: Fräser-Kreis in der Mitte der Form
      const b = shape.type === "circle" ? null : shapeBounds(shape);
      const cx = b ? (b.minX + b.maxX) / 2 : shape.x, cy = b ? (b.minY + b.maxY) / 2 : shape.y;
      ctx.fillStyle = tool.color;
      ctx.beginPath();
      ctx.arc(sx(cx), sy(cy), Math.max(1, rPx * scale), 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    const widthScreen = Math.max(1, tool.diameter * MM_TO_PIXEL * scale);
    ctx.strokeStyle = tool.color;
    ctx.lineWidth = widthScreen;
    const sign = mode === "outside" ? 1 : (mode === "inside" || mode === "pocket") ? -1 : 0;

    // Haltestege: Lage auf der Fräserbahn merken, gelb über den Streifen zeichnen
    let tabRing: Pt[] | null = null;
    ctx.beginPath();
    if (shape.type === "circle") {
      const r = Math.abs(shape.w) + sign * rPx;
      if (r > 0.01) ctx.arc(sx(shape.x), sy(shape.y), r * scale, 0, Math.PI * 2);
      else tooBig.push(shape);
      if (r > 0.01 && sign !== 0 && mode !== "pocket") tabRing = makeEllipsePoints(shape.x, shape.y, r, r);
    } else if (shape.type === "polyline" && shape.points?.length > 1) {
      if (!shape.closed || sign === 0) {
        tracePts(ctx, shape.points, !!shape.closed, sx, sy);
      } else {
        const c = offsetLoops(shape, sign * rPx);
        if (c.tooBig) tooBig.push(shape);
        for (const loop of c.loops) tracePts(ctx, loop, true, sx, sy);
        if (mode !== "pocket" && c.loops.length) tabRing = c.loops[0];
      }
    } else if (shape.type === "line") {
      ctx.moveTo(sx(shape.x), sy(shape.y));
      ctx.lineTo(sx(shape.x + shape.w), sy(shape.y + shape.h));
    } else if (shape.type === "arc") {
      const g = arcGeometry(shape);
      // Bogen außen/innen: Fräser weg vom bzw. hin zum Mittelpunkt (Tasche geht bei offenen Bögen nicht)
      const r = g ? g.r + (mode === "pocket" ? 0 : sign * rPx) : 0;
      if (g && r > 0.01) ctx.arc(sx(g.cx), sy(g.cy), r * scale, -g.start, -(g.start + g.sweep), !g.clockwise);
      else if (g) tooBig.push(shape);
    }
    ctx.stroke();
    // Plasma (resolve gesetzt): Stege ohne Höhe
    if (tabRing) drawTabs(ctx, shape, tabRing, sx, sy, widthScreen, rPx, !resolve);
    // Tasche: die ganze Fläche wird abgetragen → Fläche füllen
    if (mode === "pocket" && (shape.type === "circle" || (shape.type === "polyline" && shape.closed && shape.points?.length > 2))) {
      ctx.fillStyle = tool.color;
      ctx.beginPath();
      if (shape.type === "circle") ctx.arc(sx(shape.x), sy(shape.y), Math.abs(shape.w) * scale, 0, Math.PI * 2);
      else tracePts(ctx, shape.points, true, sx, sy);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** Haltestege als gelbe Stücke auf der Fräserbahn (gleiche Lage wie im G-Code, siehe tabs.ts) */
function drawTabs(ctx: CanvasRenderingContext2D, shape: any, loop: Pt[], sx: SX, sy: SX, width: number, rPx: number, needHeight = true) {
  const tab = tabSettings(shape, needHeight);
  if (!tab || loop.length < 3) return;
  const cum = cumulative(loop);
  const len = tab.len * MM_TO_PIXEL;
  const centers = tabCenters(shape, loop, cum, p => p, rPx * 1.5 + 2);
  if (shape.tabMode !== "manual" && cum[cum.length - 1] / Math.max(1, centers.length) < 3 * (len / 2 + rPx)) return; // zu viele – der G-Code meldet das
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = "#ffd23f";
  ctx.lineWidth = Math.max(width, 5); // bei dünnem Schnittspalt (Plasma) trotzdem gut sichtbar
  ctx.lineCap = "butt";
  for (const c of centers) {
    ctx.beginPath();
    for (let j = 0; j <= 6; j++) { const p = pointAt(loop, cum, c - len / 2 + (len * j) / 6); j ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y)); }
    ctx.stroke();
  }
  ctx.restore();
}

/** Laser: Stege direkt auf der Kontur (dort ist der Laser aus) */
export function drawLaserTabs(ctx: CanvasRenderingContext2D, shapes: any[], sx: SX, sy: SX) {
  for (const s of shapes) {
    const ring = tabSettings(s, false) ? outline(s) : null;
    if (ring) drawTabs(ctx, s, ring, sx, sy, 5, 0, false);
  }
}

function tracePts(ctx: CanvasRenderingContext2D, pts: Pt[], closed: boolean, sx: SX, sy: SX) {
  ctx.moveTo(sx(pts[0].x), sy(pts[0].y));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(sx(pts[i].x), sy(pts[i].y));
  if (closed) ctx.closePath();
}

/** Werkzeug zu groß: Kontur rot gestrichelt (eigener Pfad, stört den Streifen-Pfad nicht) */
function markTooBig(ctx: CanvasRenderingContext2D, shape: any, sx: SX, sy: SX, scale: number) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#ff4d4d";
  ctx.lineWidth = 2.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  if (shape.type === "circle") ctx.arc(sx(shape.x), sy(shape.y), Math.abs(shape.w) * scale, 0, Math.PI * 2);
  else if (shape.type === "arc") {
    const g = arcGeometry(shape);
    if (g) ctx.arc(sx(g.cx), sy(g.cy), g.r * scale, -g.start, -(g.start + g.sweep), !g.clockwise);
  }
  else tracePts(ctx, shape.points, true, sx, sy);
  ctx.stroke();
  ctx.restore();
}

/**
 * Werkzeug-Marken "T1", "T2" … und rote Warnungen (nach den Konturlinien aufrufen).
 * Nur wenn mehr als ein Werkzeug im Spiel ist. Teile mit gleicher groupId und gleichem
 * Werkzeug bekommen EINE Marke (z. B. ein ganzer Text oder ein Teil mit seinen Löchern).
 */
export function drawToolBadges(ctx: CanvasRenderingContext2D, shapes: any[], sx: SX, sy: SX) {
  // Werkzeug passt nicht -> rot gestrichelt ÜBER die Konturlinie
  for (const shape of pendingTooBig) markTooBig(ctx, shape, sx, sy, lastScale);
  pendingTooBig = [];

  const used = new Set<string>();
  for (const s of shapes) { const tl = toolForShape(s); if (tl) used.add(tl.id); }
  if (used.size < 2) return;

  // Gruppen bilden: groupId + Werkzeug
  const groups = new Map<string, { tool: MillingTool; minX: number; maxY: number }>();
  for (const s of shapes) {
    const tool = toolForShape(s);
    if (!tool) continue;
    const b = boundsOf(s);
    if (!b) continue;
    const key = (s.groupId ? "g:" + s.groupId : "s:" + s.id) + "|" + tool.id;
    const g = groups.get(key);
    if (g) { g.minX = Math.min(g.minX, b.minX); g.maxY = Math.max(g.maxY, b.maxY); }
    else groups.set(key, { tool, minX: b.minX, maxY: b.maxY });
  }

  ctx.save();
  ctx.font = "bold 10px sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const placed: { x: number; y: number }[] = [];
  for (const g of groups.values()) {
    const label = "T" + toolNumber(g.tool);
    const w = Math.max(20, ctx.measureText(label).width + 8), h = 14;
    let x = sx(g.minX) - 2, y = sy(g.maxY) - h - 3;
    // nicht genau übereinander stapeln
    while (placed.some(p => Math.abs(p.x - x) < w && Math.abs(p.y - y) < h)) x += w + 2;
    placed.push({ x, y });
    ctx.fillStyle = "rgba(16,16,20,0.85)";
    ctx.strokeStyle = toolColor(g.tool);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    roundRect(ctx, x, y, w, h, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = toolColor(g.tool);
    ctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
  }
  ctx.restore();
}

/** Maße einer Form – bei Polylinien direkt aus den Punkten (verlässlicher als gespeicherte Werte) */
function boundsOf(s: any): { minX: number; maxY: number } | null {
  if (s.type === "polyline" && s.points?.length) {
    let minX = Infinity, maxY = -Infinity;
    for (const p of s.points) { if (p.x < minX) minX = p.x; if (p.y > maxY) maxY = p.y; }
    return { minX, maxY };
  }
  const b = shapeBounds(s);
  return b && Number.isFinite(b.minX) && Number.isFinite(b.maxY) ? b : null;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
