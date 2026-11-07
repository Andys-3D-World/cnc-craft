/**
 * ÜBERLAGERUNG: alles, was über die Formen gezeichnet wird, aber nicht zum
 * Werkstück gehört: Auswahlrahmen mit Griffen, Vorschau beim Zeichnen,
 * Fangpunkt-Markierung, Messlinie, Info-Text an der Maus, Statuszeile.
 */
import { app, toScreen, toWorld, fmtMm, options, bedSizeMm } from "./editorState";
import { live, currentTool, toolHint, dragRect, dragPolygonPoints, dragSlotPoints, dragStarPoints, lineDimHover, measureText, previewCenterArc } from "./tools";
import { t } from "../i18n/i18n";
import { selectionBounds, selectionHandles, HANDLE_SIZE, selectedShapes } from "./selection";
import { Pt, shapeToPaths, makeEllipsePoints, makeRectPoints, arcGeometry, MM_TO_PIXEL } from "../shapeTransform";
import { berechne3PunktBogen } from "../arcEngine";
import { drawBezierOverlay } from "./bezier";
import { drawDims, drawDimPreview } from "./dims";
import { drawRotaryBand } from "../rotary";
import { isPlasma } from "../machineMode";
import { livePreview } from "./livePreview";
import { trimHover } from "./trimTool";
import { cutMark, hasCutSetting, MachineKind } from "../cutSetting";
import { isLaser } from "../machineMode";

const PREVIEW = "rgba(0, 255, 204, 0.95)";
const SELECT = "#34d17b";

export function drawOverlay(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
  ctx.save();
  const tool = currentTool();
  // ---- Drehachse: Band für den abgewickelten Umfang ----
  if (!isPlasma()) drawRotaryBand(ctx, toScreen, bedSizeMm().w, bedSizeMm().h);

  // ---- Hover: Form unter der Maus leicht hervorheben ----
  if (tool === "select" && live.mode === "idle" && live.hover && !app().selectedShapeIds.includes(live.hover.id)) {
    strokeShape(ctx, live.hover, "rgba(255,255,255,0.55)", 3);
  }

  // ---- Auswahlrahmen mit Griffen ----
  const sel = selectedShapes();
  if (sel.length && live.mode !== "boxselect") drawSelectionFrame(ctx);

  // ---- Rahmen-Auswahl ----
  if (live.mode === "boxselect") {
    const a = live.boxStart, b = live.screen;
    const crossing = b.x < a.x;
    ctx.setLineDash(crossing ? [5, 4] : []);
    ctx.strokeStyle = crossing ? SELECT : "#37a6ff";
    ctx.fillStyle = crossing ? "rgba(52, 209, 123, 0.08)" : "rgba(55, 166, 255, 0.08)";
    ctx.lineWidth = 1.2;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  // ---- Zeichen-Vorschau ----
  drawToolPreview(ctx, tool);
  drawLivePreview(ctx);
  drawCutMarks(ctx);
  // ---- Linie bemaßen: welches Stück, und welches Ende wandert (Punkt) ----
  if (tool === "lineDim" && lineDimHover.pick) {
    const h = lineDimHover.pick;
    ctx.strokeStyle = "#ffe14d";
    ctx.lineWidth = 3;
    polyPath(ctx, [h.a, h.b], false);
    ctx.stroke();
    const m = toScreen(h.moved.x, h.moved.y);
    ctx.fillStyle = "#ffe14d";
    ctx.beginPath(); ctx.arc(m.x, m.y, 5, 0, Math.PI * 2); ctx.fill();
  }
  // ---- Trim: gelb, was beim Klick wegfällt (rot wäre auf der Schneid-Ebene nicht zu sehen) ----
  if (tool === "trim" && trimHover.removed) {
    ctx.strokeStyle = "#ffe14d";
    ctx.lineWidth = 3;
    polyPath(ctx, trimHover.removed, false);
    ctx.stroke();
  }
  // ---- Maße (immer sichtbar) + Vorschau beim Bemaßen ----
  drawDims(ctx);
  if (tool === "dim") drawDimPreview(ctx);
  // ---- Kurven: Knoten und Tangenten (Punkte bearbeiten, Kurve zeichnen) ----
  if (tool === "node" || tool === "pen") drawBezierOverlay(ctx, tool);

  // ---- Messlinie (bleibt stehen, bis neu gemessen wird) ----
  if (live.measure) drawMeasure(ctx, live.measure.a, live.measure.b);

  // ---- Fangpunkt ----
  if (live.snap) drawSnapMarker(ctx, live.snap.x, live.snap.y, live.snap.kind);

  // ---- Info an der Maus ----
  if (live.label) {
    ctx.font = "12px monospace";
    const tw = ctx.measureText(live.label).width;
    const x = live.screen.x + 16, y = live.screen.y + 26;
    ctx.fillStyle = "rgba(18, 18, 22, 0.88)";
    ctx.fillRect(x - 5, y - 13, tw + 10, 19);
    ctx.fillStyle = "#e6e6ee";
    ctx.fillText(live.label, x, y);
  }

  drawStatusBar(ctx, canvas, tool);
  ctx.restore();
}

export const machineKind = (): MachineKind => isPlasma() ? "plasma" : isLaser() ? "laser" : "mill";

/** Startpunkt (Kreis) und Richtung (Pfeil) von Hand gesetzter Konturen, immer sichtbar (cutSetting.ts) */
function drawCutMarks(ctx: CanvasRenderingContext2D) {
  const kind = machineKind();
  for (const s of app().shapes as any[]) {
    if (!hasCutSetting(s) || livePreview.hideMarksOf.has(s.id)) continue;
    const m = cutMark(s, kind);
    if (m) drawCutMark(ctx, m);
  }
  for (const m of livePreview.marks) drawCutMark(ctx, m);
}

function drawCutMark(ctx: CanvasRenderingContext2D, m: { at: Pt; dir: Pt; fixedStart: boolean }) {
  const p = toScreen(m.at.x, m.at.y);
  const dx = m.dir.x, dy = -m.dir.y; // Bildschirm: Y nach unten
  const L = 16, W = 5;
  const tip = { x: p.x + dx * L, y: p.y + dy * L };
  ctx.save();
  ctx.strokeStyle = "#ffb454"; ctx.fillStyle = "#ffb454"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(tip.x + dx * 5, tip.y + dy * 5);
  ctx.lineTo(tip.x - dy * W, tip.y + dx * W);
  ctx.lineTo(tip.x + dy * W, tip.y - dx * W);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
  if (m.fixedStart) ctx.fill(); else { ctx.fillStyle = "#1f1f26"; ctx.fill(); ctx.stroke(); }
  ctx.restore();
}

/** Vorschau der Werkzeug-Fenster (Array, Text auf Pfad …): blass = vorher, leuchtend = nachher */
function drawLivePreview(ctx: CanvasRenderingContext2D) {
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = "rgba(255, 180, 84, 0.55)";
  for (const p of livePreview.ghost) { polyPath(ctx, p.pts, p.closed); ctx.stroke(); }
  ctx.strokeStyle = PREVIEW;
  for (const p of livePreview.paths) { polyPath(ctx, p.pts, p.closed); ctx.stroke(); }
  ctx.fillStyle = PREVIEW;
  for (const d of livePreview.dots) {
    const s = toScreen(d.x, d.y);
    ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, Math.PI * 2); ctx.fill();
  }
}

function polyPath(ctx: CanvasRenderingContext2D, pts: Pt[], closed: boolean) {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = toScreen(p.x, p.y);
    if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
  });
  if (closed) ctx.closePath();
}

function strokeShape(ctx: CanvasRenderingContext2D, shape: any, color: string, width: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  for (const p of shapeToPaths(shape)) { polyPath(ctx, p.pts, p.closed); ctx.stroke(); }
}

function drawSelectionFrame(ctx: CanvasRenderingContext2D) {
  const b = selectionBounds();
  if (!b) return;
  const handles = selectionHandles();
  const nw = handles.find(h => h.name === "nw")!, se = handles.find(h => h.name === "se")!;
  const n = handles.find(h => h.name === "n")!, rot = handles.find(h => h.name === "rotate")!;

  ctx.strokeStyle = "rgba(52, 209, 123, 0.8)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(nw.sx, nw.sy, se.sx - nw.sx, se.sy - nw.sy);
  ctx.setLineDash([]);

  // Verbindung zum Dreh-Griff
  ctx.beginPath(); ctx.moveTo(n.sx, n.sy); ctx.lineTo(rot.sx, rot.sy); ctx.stroke();

  for (const h of handles) {
    if (h.name === "rotate") {
      ctx.beginPath();
      ctx.arc(h.sx, h.sy, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#1f1f26"; ctx.fill();
      ctx.strokeStyle = SELECT; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(h.sx, h.sy, 2.5, 0, Math.PI * 1.5); ctx.stroke();
      continue;
    }
    const s = HANDLE_SIZE;
    ctx.fillStyle = "#1f1f26";
    ctx.fillRect(h.sx - s / 2, h.sy - s / 2, s, s);
    ctx.strokeStyle = SELECT; ctx.lineWidth = 1.5;
    ctx.strokeRect(h.sx - s / 2, h.sy - s / 2, s, s);
  }

  // Drehpunkt beim Drehen
  if (live.mode === "rotating") {
    const c = toScreen(live.center.x, live.center.y);
    ctx.strokeStyle = SELECT;
    ctx.beginPath(); ctx.moveTo(c.x - 7, c.y); ctx.lineTo(c.x + 7, c.y); ctx.moveTo(c.x, c.y - 7); ctx.lineTo(c.x, c.y + 7); ctx.stroke();
  }

  // Größe unter dem Rahmen
  ctx.font = "11px monospace";
  ctx.fillStyle = "rgba(52, 209, 123, 0.95)";
  const txt = `${fmtMm(b.maxX - b.minX)} × ${fmtMm(b.maxY - b.minY)} mm`;
  ctx.fillText(txt, nw.sx, se.sy + 16);
}

function drawToolPreview(ctx: CanvasRenderingContext2D, tool: string) {
  ctx.strokeStyle = PREVIEW;
  ctx.lineWidth = 1.6;
  const w = live.world;

  if (tool === "line" && live.points.length > 0) {
    polyPath(ctx, [...live.points, w], false);
    ctx.stroke();
    // Startpunkt markieren (zum Schließen anklicken)
    const s0 = toScreen(live.points[0].x, live.points[0].y);
    ctx.strokeRect(s0.x - 4, s0.y - 4, 8, 8);
    return;
  }

  if (tool === "arcCenter" && live.points.length > 0) {
    const c = toScreen(live.points[0].x, live.points[0].y);
    ctx.beginPath(); ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2); ctx.fillStyle = PREVIEW; ctx.fill();
    ctx.strokeStyle = PREVIEW;
    ctx.lineWidth = 1.2;
    const a = previewCenterArc();
    if (a) {
      const steps = Math.max(8, Math.ceil(Math.abs(a.sweep) / 0.05));
      const a0 = Math.atan2(a.start.y - live.points[0].y, a.start.x - live.points[0].x);
      const pts = Array.from({ length: steps + 1 }, (_, i) => ({ x: live.points[0].x + a.radius * Math.cos(a0 + (a.sweep * i) / steps), y: live.points[0].y + a.radius * Math.sin(a0 + (a.sweep * i) / steps) }));
      polyPath(ctx, pts, false);
      ctx.stroke();
    } else {
      polyPath(ctx, [live.points[0], live.world], false);
      ctx.stroke();
    }
    return;
  }
  if (tool === "arc" && live.points.length > 0) {
    const p = live.points;
    if (p.length === 1) {
      polyPath(ctx, [p[0], w], false);
      ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    } else {
      const fake = { type: "arc", x: p[0].x, y: p[0].y, w: p[1].x - p[0].x, h: p[1].y - p[0].y, midX: w.x, midY: w.y };
      const g = berechne3PunktBogen(fake.x, fake.y, p[1].x, p[1].y, w.x, w.y) && arcGeometry(fake);
      if (g) strokeShape(ctx, fake, PREVIEW, 1.6);
      else { polyPath(ctx, [p[0], p[1]], false); ctx.stroke(); }
    }
    return;
  }

  if (live.mode !== "dragDraw" || !live.dragStart) return;

  if (tool === "rect") {
    const r = dragRect();
    polyPath(ctx, makeRectPoints(r.x0, r.y0, r.x1, r.y1, options.rectRadius * MM_TO_PIXEL), true);
    ctx.stroke();
  } else if (tool === "ellipse") {
    const r = dragRect();
    polyPath(ctx, makeEllipsePoints((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, Math.abs(r.x1 - r.x0) / 2, Math.abs(r.y1 - r.y0) / 2), true);
    ctx.stroke();
  } else if (tool === "polygon") {
    polyPath(ctx, dragPolygonPoints(), true);
    ctx.stroke();
    const c = toScreen(live.dragStart.x, live.dragStart.y);
    ctx.beginPath(); ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2); ctx.fillStyle = PREVIEW; ctx.fill();
  } else if (tool === "star" || tool === "ring") {
    if (tool === "star") polyPath(ctx, dragStarPoints(), true);
    else {
      const r = Math.hypot(w.x - live.dragStart.x, w.y - live.dragStart.y);
      polyPath(ctx, makeEllipsePoints(live.dragStart.x, live.dragStart.y, r, r), true);
      ctx.stroke();
      const inner = r - options.ringWall * MM_TO_PIXEL;
      if (inner > 0) polyPath(ctx, makeEllipsePoints(live.dragStart.x, live.dragStart.y, inner, inner), true);
    }
    ctx.stroke();
    const c = toScreen(live.dragStart.x, live.dragStart.y);
    ctx.beginPath(); ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2); ctx.fillStyle = PREVIEW; ctx.fill();
  } else if (tool === "slot") {
    polyPath(ctx, dragSlotPoints(), true);
    ctx.stroke();
  } else if (tool === "measure") {
    drawMeasure(ctx, live.dragStart, w);
  }
}

function drawMeasure(ctx: CanvasRenderingContext2D, a: Pt, b: Pt) {
  const sa = toScreen(a.x, a.y), sb = toScreen(b.x, b.y);
  ctx.strokeStyle = "#ffc043";
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
  for (const s of [sa, sb]) { ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, Math.PI * 2); ctx.stroke(); }
  if (live.mode !== "dragDraw") {
    const txt = measureText(a, b);
    ctx.font = "12px monospace";
    const tw = ctx.measureText(txt).width;
    const x = (sa.x + sb.x) / 2 + 8, y = (sa.y + sb.y) / 2 - 8;
    ctx.fillStyle = "rgba(18, 18, 22, 0.88)";
    ctx.fillRect(x - 5, y - 13, tw + 10, 19);
    ctx.fillStyle = "#ffc043";
    ctx.fillText(txt, x, y);
  }
}

function drawSnapMarker(ctx: CanvasRenderingContext2D, x: number, y: number, kind: string) {
  const s = toScreen(x, y);
  ctx.strokeStyle = "#ff3df0";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (kind === "center") ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
  else if (kind === "mid") { ctx.moveTo(s.x, s.y - 7); ctx.lineTo(s.x + 7, s.y + 5); ctx.lineTo(s.x - 7, s.y + 5); ctx.closePath(); }
  else if (kind === "grid") { ctx.moveTo(s.x - 5, s.y - 5); ctx.lineTo(s.x + 5, s.y + 5); ctx.moveTo(s.x + 5, s.y - 5); ctx.lineTo(s.x - 5, s.y + 5); }
  else ctx.rect(s.x - 5, s.y - 5, 10, 10);
  ctx.stroke();
}

function drawStatusBar(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, tool: string) {
  const h = 22;
  const y = canvas.height - h;
  ctx.fillStyle = "rgba(23, 23, 28, 0.92)";
  ctx.fillRect(0, y, canvas.width, h);
  const w = live.mode === "idle" && (tool === "select" || tool === "pan") ? toWorld(live.screen.x, live.screen.y) : live.world;
  ctx.font = "11px monospace";
  ctx.fillStyle = "#e6e6ee";
  const pos = `X ${(w.x / MM_TO_PIXEL).toFixed(2).padStart(8)}  Y ${(w.y / MM_TO_PIXEL).toFixed(2).padStart(8)} mm`;
  ctx.fillText(pos, 8, y + 15);
  const posW = ctx.measureText(pos).width;
  ctx.fillStyle = "#8d8d9c";
  ctx.font = "11px sans-serif";
  let hint = toolHint(tool as any);
  const n = app().selectedShapeIds.length;
  if (tool === "select" && n) hint = t("status.selected", { n }) + " · " + hint;
  // Text kürzen, falls zu lang
  const maxW = canvas.width - posW - 30;
  while (hint.length > 4 && ctx.measureText(hint).width > maxW) hint = hint.slice(0, -2);
  ctx.fillText(hint, posW + 22, y + 15);
}
