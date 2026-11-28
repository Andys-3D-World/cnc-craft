/** WERKZEUGREIHE und Längensensor auf der Zeichenfläche (Anzeige) und als Sperrzone – Rechnung in magazine.ts */
import { t } from "./i18n/i18n";
import { app } from "./editor/editorState";
import { checkpoint } from "./editor/history";
import { before, rackBox, slotInDrawing } from "./magazine";
import { magazine, rackOn } from "./magazineStore";
import { drawingZero } from "./drawingZero";
import { probeSettings } from "./probe";
import { getTool, toolColor } from "./toolLibrary";
import { KEEP_MARGIN } from "./keepOut";
import { rotary } from "./rotary";
import { isLight } from "./theme";
import { fmtLenU } from "./units";
import { MM_TO_PIXEL, createPolyline, makeRectPoints } from "./shapeTransform";
import { fluteSection } from "./sim/toolMesh.ts";

export interface RackPart { n: number; x: number; y: number; size: number; top: number; dia: number; color: string; inSpindle: boolean; flutes?: number }

/** Plätze in Zeichnungs-Koordinaten (leer = Magazin aus oder Nullpunkt unbekannt) */
export function rackParts(): RackPart[] {
  if (!rackOn() || rotary.on) return [];
  const z = drawingZero(), m = magazine();
  if (!z) return [];
  return m.slots.filter(s => s.set).map(s => {
    const tl = s.toolId ? getTool(s.toolId) : null, out = m.inSpindle === s.n;
    return { n: s.n, ...slotInDrawing(s, z), size: m.size, top: m.top, dia: tl?.diameter || 0, color: tl && !out ? toolColor(tl) : "", inSpindle: out, flutes: tl?.flutes };
  });
}

/** Fräser von oben im Platz: Querschnitt mit Spannuten (gleiche Form wie in Simulation und Bibliothek), Ø maßstäblich */
function drawCutterEnd(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, flutes: number) {
  const n = Math.max(1, Math.min(8, Math.round(flutes)));
  ctx.beginPath();
  if (r < 3) ctx.arc(x, y, r, 0, 2 * Math.PI);
  else for (let i = 0; i <= 72; i++) {
    const a = (i / 72) * 2 * Math.PI, q = r * fluteSection(a / (2 * Math.PI / n), Math.min(0.74, 0.445 + 0.056 * n));
    if (i) ctx.lineTo(x + q * Math.cos(a), y - q * Math.sin(a)); else ctx.moveTo(x + q, y);
  }
  ctx.closePath();
  const g = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
  g.addColorStop(0, "#f4f6f8"); g.addColorStop(0.5, "#aab2bd"); g.addColorStop(1, "#6a727e");
  ctx.fillStyle = "rgba(15,17,21,0.55)"; ctx.fill("nonzero");
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = "rgba(20,22,26,0.7)"; ctx.lineWidth = 0.8; ctx.stroke();
}

export function drawRack(ctx: CanvasRenderingContext2D, sx: (x: number) => number, sy: (y: number) => number) {
  const parts = rackParts();
  if (!parts.length) return;
  const m = magazine(), z = drawingZero()!, X = (mm: number) => sx(mm * MM_TO_PIXEL), Y = (mm: number) => sy(mm * MM_TO_PIXEL);
  const k = X(1) - X(0), line = isLight() ? "#5b6472" : "#9aa5b5";
  ctx.save();
  // Reihe als Ganzes; bei der Gabel gestrichelt mit der Einfahrt
  const b = rackBox(m, z)!, wide = m.entry === "fork" ? rackBox(m, z, true)! : null;
  const rect = (r: typeof b) => { ctx.beginPath(); ctx.rect(X(r.x0), Y(r.y1), X(r.x1) - X(r.x0), Y(r.y0) - Y(r.y1)); };
  ctx.strokeStyle = line; ctx.lineWidth = 1.2;
  if (wide) { ctx.setLineDash([4, 4]); rect(wide); ctx.stroke(); ctx.setLineDash([]); }
  rect(b); ctx.fillStyle = "rgba(120,130,145,0.18)"; ctx.fill(); ctx.stroke();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const p of parts) {
    const x = X(p.x), y = Y(p.y), r = Math.max(3, (p.size / 2) * k * 0.8);
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
    if (p.color) {
      // belegter Platz von oben: Spannmutter als blankes Metall, außen der Ring in der Farbe des Werkzeugs
      const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
      g.addColorStop(0, "#e3e7ec"); g.addColorStop(0.55, "#8a93a1"); g.addColorStop(1, "#4b525d");
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = p.color; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, r * 0.78, 0, 2 * Math.PI); ctx.strokeStyle = "rgba(20,22,26,0.45)"; ctx.lineWidth = 1; ctx.stroke();
      const rc = Math.min(r * 0.7, Math.max(1, (p.dia / 2) * k));
      if (p.dia > 0) drawCutterEnd(ctx, x, y, rc, p.flutes || 2);
    } else {
      ctx.fillStyle = "rgba(120,130,145,0.15)"; ctx.fill();
      ctx.strokeStyle = line; ctx.lineWidth = 1.6;
      ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    if (m.entry === "fork") {
      // Pfeil: von hier fährt die Spindel ein
      const s = m.slots.find(q => q.n === p.n)!, o = slotInDrawing({ ...s, ...before(m, s) }, z);
      ctx.beginPath(); ctx.moveTo(X(o.x), Y(o.y)); ctx.lineTo(x, y); ctx.strokeStyle = line; ctx.setLineDash([2, 4]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.fillStyle = isLight() ? "#22262c" : "#f0f2f5";
    ctx.font = `700 ${Math.max(9, Math.min(15, r * 0.8))}px sans-serif`;
    // Nummer mit dunklem Rand, damit sie auch auf dem hellen Metall lesbar bleibt
    if (p.color) { ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.strokeStyle = isLight() ? "rgba(255,255,255,0.85)" : "rgba(15,17,21,0.85)"; ctx.strokeText(String(p.n), x, y); }
    ctx.fillText(String(p.n), x, y);
  }
  ctx.font = "600 12px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.fillStyle = line;
  ctx.fillText(t("mag.title"), X(b.x0), Y(b.y1) - 4);
  // fester Längensensor
  if (probeSettings.sensorSet && probeSettings.tcMode === 1) {
    const x = X(probeSettings.sx - z.x), y = Y(probeSettings.sy - z.y), r = Math.max(4, 8 * k);
    ctx.strokeStyle = "#ffb020"; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.moveTo(x - r * 1.4, y); ctx.lineTo(x + r * 1.4, y); ctx.moveTo(x, y - r * 1.4); ctx.lineTo(x, y + r * 1.4); ctx.stroke();
    ctx.fillStyle = "#ffb020"; ctx.textBaseline = "top"; ctx.textAlign = "center";
    ctx.fillText(t("mag.sensor"), x, y + r * 1.5);
  }
  ctx.restore();
}

/** Reihe als Sperrzone in die Zeichnung: Eilfahrten darüber werden angehoben. Eine früher eingefügte wird ersetzt */
export function insertRackZone(log: (s: string) => void) {
  const z = drawingZero(), m = magazine(), b = z && rackBox(m, z, true);
  if (!b) { log(t("mag.notShown")); return; }
  const k = MM_TO_PIXEL;
  const sh: any = createPolyline(makeRectPoints(b.x0 * k, b.y0 * k, b.x1 * k, b.y1 * k), true, "outside");
  sh.keepOut = { height: m.top, margin: KEEP_MARGIN };
  sh.rackZone = true;
  const st = app();
  st.shapes = [...st.shapes.filter((s: any) => !s.rackZone), sh];
  st.selectedShapeIds = [];
  checkpoint();
  window.dispatchEvent(new Event("cnc-redraw"));
  log(t("mag.zoneDone", { z: fmtLenU(m.top + KEEP_MARGIN) }));
}
