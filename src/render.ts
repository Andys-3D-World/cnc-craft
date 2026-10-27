/**
 * ZEICHNET DEN ARBEITSBEREICH: Bett, Raster mit Linealen, alle Formen, Maschinen-Fadenkreuz.
 * (Auswahlrahmen, Vorschau usw. kommen aus editor/overlay.ts)
 *
 * Farben je Fräs-Modus: Blau = außen, Gelb = innen, Cyan = Mitte, Rot = Tasche, Grün = ausgewählt
 * Breiter, blasser Streifen = Fräserbreite in der Farbe des Werkzeugs (siehe toolView.ts)
 * LASER-Modus: Farbe = Laser-Ebene; Ebenen mit "Füllen" werden flächig (gerade/ungerade) gefüllt
 * PLASMA-Modus: Streifen = Schnittspalt in Schnitt-Farbe, Punkt = Einstich, Pfeil = Schneidrichtung
 * Material-Platte: rot schraffiert = schon verbraucht; roter Schein = Form liegt darauf (stock.ts)
 */
import { arcGeometry } from "./shapeTransform";
import { options } from "./editor/editorState";
import { drawToolBands, drawToolBadges, drawLaserTabs } from "./toolView";
import { isLaser, isPlasma } from "./machineMode";
import { cutForShape } from "./plasmaCuts";
import { drawPlasmaLeads } from "./plasmaCam";
import { drawStock, shapeOnUsedArea, hasUsedArea } from "./stock";
import { layerForShape, layerHasFill, LaserLayer } from "./laserLayers";
import { drawCameraUnderlay } from "./camera/cameraOverlay";
import { drawImageShape } from "./raster/imageShape";
import { materialView, drawMaterialBed, drawMaterialShapes } from "./materialView";

export const liveMachinePos = { x: 0, y: 0, z: 0 };

const MM_TO_PIXEL = 2;

export function modeColor(mode: string | undefined): string {
  if (mode === "inside") return "#ffc107";
  if (mode === "outside") return "#1e90ff";
  if (mode === "on-line") return "#00ffcc";
  if (mode === "pocket") return "#ff4d4d";
  if (mode === "vcarve") return "#e05cff";
  if (mode === "vplug") return "#ff9f1c";
  if (mode === "drill") return "#7CFC00";
  if (mode === "face") return "#c8a165";
  return "#6d4aff";
}

export function drawEverything(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  shapes: any[],
  selectedShapeIds: string[],
  offsetX: number,
  offsetY: number,
  scale: number
) {
  const bedWInput = document.getElementById("bed-w") as HTMLInputElement;
  const bedHInput = document.getElementById("bed-h") as HTMLInputElement;
  const bedW = bedWInput ? parseFloat(bedWInput.value) || 300 : 300;
  const bedH = bedHInput ? parseFloat(bedHInput.value) || 300 : 300;
  const bedHPx = bedH * MM_TO_PIXEL;

  const sx = (x: number) => x * scale + offsetX;
  const sy = (y: number) => (bedHPx - y) * scale + offsetY;

  // 1. Hintergrund
  ctx.fillStyle = "#101014";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 2. Bett
  const bx0 = sx(0), by0 = sy(bedHPx), bx1 = sx(bedW * MM_TO_PIXEL), by1 = sy(0);
  ctx.fillStyle = "#16161c";
  ctx.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
  // Materialansicht: Oberfläche + Brandfarben statt Raster und Bahn-Farben
  const mat = materialView();
  if (mat) {
    drawMaterialBed(ctx, bx0, by0, bx1 - bx0, by1 - by0, scale, mat);
    drawMaterialShapes(ctx, shapes, new Set(selectedShapeIds), sx, sy, scale, mat);
    drawCrosshair(ctx, sx, sy);
    return;
  }
  // 2b. Kamerabild (falls eingeschaltet) – liegt unter Raster und Zeichnung
  drawCameraUnderlay(ctx, bx0, by0, bx1 - bx0, by1 - by0);

  // 3. Raster: Abstand passt sich dem Zoom an
  const pxPerMm = scale * MM_TO_PIXEL;
  const steps = [0.1, 0.5, 1, 5, 10, 50, 100, 500];
  const minor = steps.find(s => s * pxPerMm >= 8) || 500;
  const major = steps.find(s => s >= minor * 5 && s * pxPerMm >= 50) || minor * 10;

  ctx.save();
  ctx.beginPath();
  ctx.rect(bx0, by0, bx1 - bx0, by1 - by0);
  ctx.clip();
  // Sichtbarer Bereich in mm (nur dort Linien zeichnen)
  const visX0 = Math.max(0, -offsetX / pxPerMm), visX1 = Math.min(bedW, (canvas.width - offsetX) / pxPerMm);
  const visY1 = Math.min(bedH, (bedHPx - (0 - offsetY) / scale) / MM_TO_PIXEL);
  const visY0 = Math.max(0, (bedHPx - (canvas.height - offsetY) / scale) / MM_TO_PIXEL);
  const drawGrid = (step: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let mm = Math.ceil(visX0 / step) * step; mm <= visX1 + 1e-9; mm += step) {
      const x = Math.round(sx(mm * MM_TO_PIXEL)) + 0.5;
      ctx.moveTo(x, by0); ctx.lineTo(x, by1);
    }
    for (let mm = Math.ceil(visY0 / step) * step; mm <= visY1 + 1e-9; mm += step) {
      const y = Math.round(sy(mm * MM_TO_PIXEL)) + 0.5;
      ctx.moveTo(bx0, y); ctx.lineTo(bx1, y);
    }
    ctx.stroke();
  };
  drawGrid(minor, "rgba(255,255,255,0.035)");
  drawGrid(major, "rgba(255,255,255,0.09)");
  ctx.restore();

  // 4. Bett-Rand + Nullpunkt
  ctx.strokeStyle = "#ff4d4d";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);

  // 5. Lineal-Beschriftung (unten und links am Bett)
  ctx.fillStyle = "#6d6d7c";
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  for (let mm = Math.ceil(visX0 / major) * major; mm <= visX1 + 1e-9; mm += major) {
    const x = sx(mm * MM_TO_PIXEL);
    ctx.fillText(String(+mm.toFixed(1)), x, by1 + 12);
  }
  ctx.textAlign = "right";
  for (let mm = Math.ceil(visY0 / major) * major; mm <= visY1 + 1e-9; mm += major) {
    const y = sy(mm * MM_TO_PIXEL);
    ctx.fillText(String(+mm.toFixed(1)), bx0 - 4, y + 3);
  }
  ctx.textAlign = "left";

  const laser = isLaser();
  const plasma = isPlasma();

  // 5b. Material-Platte: verbrauchte Fläche (schraffiert) + Plattenumriss
  drawStock(ctx, sx, sy, scale);
  const checkUsed = hasUsedArea();

  // 5c. Bilder (Bildgravur) unter allen Konturen
  for (const s of shapes) if (s.type === "image") drawImageShape(ctx, s, sx, sy);

  // 6a. Fräserbreite unter den Formen (Werkzeug-Ansicht) bzw. Laser-Füllflächen bzw. Plasma-Schnittspalt
  if (laser) drawLaserFills(ctx, shapes, sx, sy, scale);
  else if (plasma) {
    if (options.showTools) drawToolBands(ctx, shapes, sx, sy, scale, s => {
      const c = cutForShape(s);
      return c ? { diameter: Math.max(c.kerf, 0.3), color: c.color } : null;
    });
  }
  else if (options.showTools) drawToolBands(ctx, shapes, sx, sy, scale);

  // 6. Formen
  const selected = new Set(selectedShapeIds);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const shape of shapes) {
    const isSel = selected.has(shape.id);
    ctx.strokeStyle = isSel ? "#34d17b" : laser ? (layerForShape(shape)?.color || "#ff4040") : modeColor(shape.millingMode);
    ctx.lineWidth = isSel ? 2.2 : 1.5;
    ctx.beginPath();
    tracePath(ctx, shape, sx, sy, scale);
    // liegt auf verbrauchter Fläche -> roter Schein unter der Linie
    if (checkUsed && shapeOnUsedArea(shape)) {
      const keep = { s: ctx.strokeStyle, w: ctx.lineWidth };
      ctx.strokeStyle = "rgba(255,60,60,0.55)";
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.strokeStyle = keep.s; ctx.lineWidth = keep.w;
    }
    ctx.stroke();
  }

  // 6b. Werkzeug-Marken T1, T2 … (nur wenn mehrere Werkzeuge benutzt werden)
  if (options.showTools && !laser && !plasma) drawToolBadges(ctx, shapes, sx, sy);
  // Plasma: Anfahrbahnen, Einstichpunkte, Schneidrichtung
  if (plasma) drawPlasmaLeads(ctx, shapes, sx, sy);
  // Laser: Haltestege (gelb) auf der Kontur
  if (laser) drawLaserTabs(ctx, shapes, sx, sy);

  // 7. Maschinen-Fadenkreuz
  drawCrosshair(ctx, sx, sy);
}

function drawCrosshair(ctx: CanvasRenderingContext2D, sx: (x: number) => number, sy: (y: number) => number) {
  const mx = sx(liveMachinePos.x * MM_TO_PIXEL);
  const my = sy(liveMachinePos.y * MM_TO_PIXEL);
  ctx.strokeStyle = "#ff4d4d";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(mx, my, 6, 0, Math.PI * 2);
  ctx.moveTo(mx - 12, my); ctx.lineTo(mx + 12, my);
  ctx.moveTo(mx, my - 12); ctx.lineTo(mx, my + 12);
  ctx.stroke();
}

/** Umriss einer Form als Pfad anlegen (ohne beginPath/stroke) */
export function tracePath(ctx: CanvasRenderingContext2D, shape: any, sx: (x: number) => number, sy: (y: number) => number, scale: number) {
  if ((shape.type === "polyline" || shape.type === "image") && shape.points?.length > 1) {
    const pts = shape.points;
    ctx.moveTo(sx(pts[0].x), sy(pts[0].y));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(sx(pts[i].x), sy(pts[i].y));
    if (shape.closed || shape.type === "image") ctx.closePath();
  } else if (shape.type === "line") {
    ctx.moveTo(sx(shape.x), sy(shape.y));
    ctx.lineTo(sx(shape.x + shape.w), sy(shape.y + shape.h));
  } else if (shape.type === "circle") {
    ctx.moveTo(sx(shape.x) + Math.abs(shape.w) * scale, sy(shape.y));
    ctx.arc(sx(shape.x), sy(shape.y), Math.abs(shape.w) * scale, 0, Math.PI * 2);
  } else if (shape.type === "arc") {
    const g = arcGeometry(shape);
    if (g) {
      // Bildschirm-Y ist gespiegelt -> Winkel umdrehen
      ctx.arc(sx(g.cx), sy(g.cy), g.r * scale, -g.start, -(g.start + g.sweep), !g.clockwise);
    }
  } else if (shape.type === "rect") {
    ctx.rect(sx(shape.x), sy(shape.y + shape.h), shape.w * scale, shape.h * scale);
  }
}

/**
 * Laser: Füll-Ebenen als halbdurchsichtige Fläche zeigen. Alle geschlossenen Formen einer
 * Ebene bilden EINEN Pfad mit gerade/ungerade-Regel – genau wie beim Lasern (Löcher bleiben frei).
 */
function drawLaserFills(ctx: CanvasRenderingContext2D, shapes: any[], sx: (x: number) => number, sy: (y: number) => number, scale: number) {
  const groups = new Map<LaserLayer, any[]>();
  for (const s of shapes) {
    const l = layerForShape(s);
    if (!l || !layerHasFill(l)) continue;
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l)!.push(s);
  }
  ctx.save();
  ctx.globalAlpha = 0.28;
  for (const [layer, list] of groups) {
    ctx.fillStyle = layer.color;
    ctx.beginPath();
    for (const s of list) {
      if (s.type === "circle") {
        ctx.moveTo(sx(s.x) + Math.abs(s.w) * scale, sy(s.y));
        ctx.arc(sx(s.x), sy(s.y), Math.abs(s.w) * scale, 0, Math.PI * 2);
      } else if (s.type === "polyline" && s.closed && s.points?.length > 2) {
        ctx.moveTo(sx(s.points[0].x), sy(s.points[0].y));
        for (let i = 1; i < s.points.length; i++) ctx.lineTo(sx(s.points[i].x), sy(s.points[i].y));
        ctx.closePath();
      } else if (s.type === "rect") {
        ctx.rect(sx(s.x), sy(s.y + s.h), s.w * scale, s.h * scale);
      }
    }
    ctx.fill("evenodd");
  }
  ctx.restore();
}
