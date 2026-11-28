/**
 * WERKZEUGE „ECKE“ UND „VERLÄNGERN“: Maus-Teil (Rechnung in cornerOps.ts)
 *
 *  Ecke        Klick auf eine Ecke: nur diese wird verrundet (oder gefast). Radius und Fase in der Werkzeugleiste.
 *              Vorher zeigt Gelb, wie die Ecke wird.
 *  Verlängern  Klick nahe am Ende einer offenen Linie: das Ende läuft geradeaus bis zur nächsten Form (gelb gestrichelt).
 * Jeder Klick ist ein Rückgängig-Schritt (history.ts merkt die Änderung).
 */
import { app, options, screenDist } from "./editorState";
import { hitTest } from "./selection";
import { MM_TO_PIXEL, Pt, convertToPolyline, makeRectPoints, updatePolylineBounds } from "../shapeTransform";
import { extendTo, filletCorner, nearestCorner } from "./cornerOps";
import { primXY, primsNear } from "./snapGeom";
import { toolLog } from "./trimTool";
import { t } from "../i18n/i18n";
import { fmtLenU } from "../units";
import { checkImport, importInApp } from "../importers/importRust";

export const cornerHover = {
  corner: null as Pt | null,      // Ecke unter der Maus
  piece: null as Pt[] | null,     // neue Rundung/Fase (Vorschau)
  ext: null as { a: Pt; b: Pt } | null // Verlängerung (Vorschau)
};

const CORNER_PX = 14;
const MAX_REACH = 1e6; // so weit sucht „Verlängern“ (Welt-Pixel)

/** Punkte einer Form als Polylinie (Rechteck: seine Ecken), null = keine Ecken (Kreis, Bogen, Text, Bild) */
function cornerPoints(s: any): { pts: Pt[]; closed: boolean } | null {
  if (s.type === "polyline" && s.points?.length >= 3) return { pts: s.points, closed: !!s.closed };
  if (s.type === "rect") return { pts: makeRectPoints(s.x, s.y, s.x + s.w, s.y + s.h), closed: true };
  return null;
}

function pickCorner(world: Pt, rust = false) {
  const hit = hitTest(world.x, world.y, CORNER_PX);
  if (!hit || hit.textData || hit.type === "image") return null;
  const cp = cornerPoints(hit);
  if (!cp) return null;
  const tol = screenDist(CORNER_PX), r = options.cornerSize * MM_TO_PIXEL, arcTol = 0.01 * MM_TO_PIXEL;
  const i = nearestCorner(cp.pts, cp.closed, world, tol);
  const res = i < 0 ? null : filletCorner(cp.pts, cp.closed, i, r, options.cornerChamfer, arcTol);
  // beim Klick rechnet Rust dasselbe nach (snapgeom.rs) – nur Vergleich
  if (rust && importInApp())
    checkImport("snap_check", { job: { kind: "corner", pts: xy(cp.pts), closed: cp.closed, at: { x: world.x, y: world.y }, tol, r, chamfer: options.cornerChamfer, arcTol } },
      res ? { i, res: { ...res, pts: xy(res.pts), ...(res.arc ? { arc: xy(res.arc) } : {}) } } : { i });
  if (!res) return null;
  return { hit, cp, i, res };
}

/** nur x und y (Punkte der Formen können mehr tragen) */
const xy = (ps: Pt[]) => ps.map(q => ({ x: q.x, y: q.y }));

export function cornerMove(world: Pt) {
  cornerHover.corner = null; cornerHover.piece = null;
  const p = pickCorner(world);
  if (!p) return;
  cornerHover.corner = p.cp.pts[p.i];
  cornerHover.piece = p.res.error ? null : p.res.arc ?? null;
}

/** true = es wurde etwas geändert */
export function cornerClick(world: Pt): boolean {
  const p = pickCorner(world, true);
  if (!p) { toolLog(t("corner.none")); return false; }
  if (p.res.error === "tooBig") { toolLog(t("corner.tooBig", { r: fmtLenU(options.cornerSize) })); return false; }
  if (p.res.error) { toolLog(t("corner.straight")); return false; }
  const s = p.hit;
  if (s.type === "rect") convertToPolyline(s);
  s.points = p.res.pts;
  delete s.bez;    // Kurven-Knoten passen nicht mehr zu den neuen Punkten
  delete s.tabPts; // selbst gesetzte Stege hängen an der alten Kontur
  if (s.tabMode === "manual") s.tabMode = "auto";
  updatePolylineBounds(s);
  app().shapes = [...app().shapes]; // neu zeichnen und Rückgängig merken
  cornerHover.corner = null; cornerHover.piece = null;
  toolLog(t(options.cornerChamfer ? "corner.chamfered" : "corner.rounded", { r: fmtLenU(options.cornerSize) }));
  return true;
}

// ---------------------------------------------------------------------
// Verlängern
// ---------------------------------------------------------------------

function pickEnd(world: Pt, rust = false) {
  const hit = hitTest(world.x, world.y);
  if (!hit) return null;
  let pts: Pt[];
  if (hit.type === "line") pts = [{ x: hit.x, y: hit.y }, { x: hit.x + hit.w, y: hit.y + hit.h }];
  else if (hit.type === "polyline" && !hit.closed && hit.points?.length >= 2 && !hit.bez) pts = hit.points;
  else return { hit, why: hit.type === "polyline" && hit.bez ? "curve" : "closed" } as const;
  const n = pts.length;
  const end: "start" | "end" = Math.hypot(world.x - pts[0].x, world.y - pts[0].y) <= Math.hypot(world.x - pts[n - 1].x, world.y - pts[n - 1].y) ? "start" : "end";
  const own = end === "end" ? n - 2 : 0; // das Stück am Ende selbst ist kein Ziel
  const targets = primsNear(app().shapes, world, Infinity, undefined, 4000)
    .filter(p => !(p.id === hit.id && p.k === "seg" && p.i === own) && !(p.id === hit.id && hit.type === "line"));
  const to = extendTo(pts, end, targets, MAX_REACH);
  // beim Klick rechnet Rust dasselbe nach (snapgeom.rs) – nur Vergleich, nicht bei riesigen Zeichnungen
  if (rust && importInApp() && targets.length <= 20000)
    checkImport("snap_check", { job: { kind: "extend", pts: xy(pts), end, targets: targets.map(primXY), maxLen: MAX_REACH } }, to ? { x: to.x, y: to.y } : null);
  return { hit, pts, end, to };
}

export function extendMove(world: Pt) {
  cornerHover.ext = null;
  const p = pickEnd(world);
  if (!p || !("to" in p) || !p.to) return;
  cornerHover.ext = { a: p.end === "end" ? p.pts[p.pts.length - 1] : p.pts[0], b: p.to };
}

export function extendClick(world: Pt): boolean {
  const p = pickEnd(world, true);
  if (!p) return false;
  if (!("to" in p)) { toolLog(t(p.why === "curve" ? "extend.curve" : "extend.closed")); return false; }
  if (!p.to) { toolLog(t("extend.nothing")); return false; }
  const s = p.hit, to = p.to;
  const old = p.end === "end" ? p.pts[p.pts.length - 1] : p.pts[0];
  if (s.type === "line") {
    if (p.end === "start") { const ex = s.x + s.w, ey = s.y + s.h; s.x = to.x; s.y = to.y; s.w = ex - to.x; s.h = ey - to.y; }
    else { s.w = to.x - s.x; s.h = to.y - s.y; }
  } else {
    const pts = [...s.points];
    pts[p.end === "end" ? pts.length - 1 : 0] = { ...to };
    s.points = pts;
    delete s.tabPts;
    updatePolylineBounds(s);
  }
  app().shapes = [...app().shapes];
  cornerHover.ext = null;
  toolLog(t("extend.done", { d: fmtLenU(Math.hypot(to.x - old.x, to.y - old.y) / MM_TO_PIXEL) }));
  return true;
}
