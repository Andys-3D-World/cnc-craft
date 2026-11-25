/** SPANNPLATZ auf der Zeichenfläche: feste Ecke und (beim Schraubstock) die Backen. Nur Anzeige */
import { isLathe } from "./machineMode";
import { rotary } from "./rotary";
import { twoSidedOn } from "./editor/beds";
import { getStock } from "./stock";
import { cornerPoint, jaws, type Rect } from "./places";
import { activePlace } from "./placesStore";
import { isLight } from "./theme";
import { MM_TO_PIXEL } from "./shapeTransform";

export function drawPlace(ctx: CanvasRenderingContext2D, sx: (x: number) => number, sy: (y: number) => number) {
  if (isLathe() || rotary.on || twoSidedOn()) return;
  const p = activePlace();
  if (!p) return;
  const s = getStock(), X = (mm: number) => sx(mm * MM_TO_PIXEL), Y = (mm: number) => sy(mm * MM_TO_PIXEL);
  const line = isLight() ? "#0b6b78" : "#3fd0e0";
  ctx.save();
  const j = jaws(p, s);
  if (j) for (const [r, fixed] of [[j.fixed, true], [j.moving, false]] as [Rect, boolean][]) {
    ctx.fillStyle = fixed ? "rgba(120,130,145,0.45)" : "rgba(120,130,145,0.22)";
    ctx.strokeStyle = isLight() ? "#5b6472" : "#9aa5b5";
    ctx.setLineDash(fixed ? [] : [5, 4]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.rect(X(r.x), Y(r.y + r.h), X(r.x + r.w) - X(r.x), Y(r.y) - Y(r.y + r.h));
    ctx.fill(); ctx.stroke();
  }
  // feste Ecke: Anschlag-Winkel nach außen, Kreuz und Name
  const c = cornerPoint(s, p.corner), cx = X(c.x), cy = Y(c.y);
  const ox = p.corner[1] === "r" ? 1 : -1, oy = p.corner[0] === "t" ? -1 : 1; // nach außen (Bildschirm)
  ctx.setLineDash([]);
  ctx.strokeStyle = line; ctx.fillStyle = line; ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cx + ox * 4 - ox * 26, cy + oy * 4); ctx.lineTo(cx + ox * 4, cy + oy * 4); ctx.lineTo(cx + ox * 4, cy + oy * 4 - oy * 26);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 2 * Math.PI); ctx.fill();
  ctx.font = "600 12px sans-serif";
  ctx.textAlign = ox > 0 ? "right" : "left"; // zur Mitte hin, damit der Name im Bild bleibt
  ctx.textBaseline = oy < 0 ? "bottom" : "top";
  ctx.fillText(p.name, cx, cy + oy * 10);
  ctx.restore();
}
