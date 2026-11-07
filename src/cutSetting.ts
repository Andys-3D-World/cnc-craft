/**
 * STARTPUNKT UND RICHTUNG EINER KONTUR (Rechnung, Tests in tests/cutSetting.test.ts)
 *
 * Felder an der Form, beide freiwillig. Fehlen sie, ändert sich am G-Code nichts:
 *   cutStart  Anteil 0..1 entlang der eigenen Kontur (nur geschlossene Konturen)
 *   cutDir    "cw"/"ccw" für geschlossene Konturen (Richtung im Raum), "forward"/"reverse" für offene (Zeichenrichtung)
 *
 * WAS GEWINNT (gilt für Laser, Plasma und Fräse; steht auch im Werkzeug-Fenster):
 *   - Von Hand gesetzt gewinnt: Richtung vor Gleich-/Gegenlauf und vor der Plasma-Regel (außen im Uhrzeigersinn);
 *     Startpunkt vor der Suche nach der schärfsten Ecke, der Anfahrt-Suche und der Reihenfolge-Optimierung.
 *   - Die Reihenfolge-Optimierung sortiert weiter die Konturen, ändert aber weder gesetzten Start noch gesetzte Richtung.
 *   - Haltestege gewinnen vor dem Start: Niemand soll in einem Steg eintauchen; der Start rückt dann ans Steg-Ende (mit Warnung).
 *   - Taschen, Bohren, V-Carve, Planfräsen und Gewinde bestimmen ihre Bahn selbst: dort wirkt die Einstellung nicht (mit Warnung).
 */
import { MM_TO_PIXEL, shapeToPaths, type Pt } from "./shapeTransform.ts";

export type CutDir = "cw" | "ccw" | "forward" | "reverse";
export type MachineKind = "laser" | "plasma" | "mill";

export function cutDirOf(s: any): CutDir | null {
  return s?.cutDir === "cw" || s?.cutDir === "ccw" || s?.cutDir === "forward" || s?.cutDir === "reverse" ? s.cutDir : null;
}

export function cutStartOf(s: any): number | null {
  const v = s?.cutStart;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

export function hasCutSetting(s: any): boolean {
  return cutDirOf(s) !== null || cutStartOf(s) !== null;
}

function area(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return a / 2;
}

/** Umlauf ohne doppelten Schlusspunkt */
function openLoop(loop: Pt[]): Pt[] {
  const n = loop.length;
  return n > 1 && Math.hypot(loop[0].x - loop[n - 1].x, loop[0].y - loop[n - 1].y) < 1e-9 ? loop.slice(0, -1) : loop;
}

/** Geschlossene Kontur in die gewünschte Richtung drehen; sie fängt weiter am selben Punkt an */
export function orientClosed<T extends Pt>(loop: T[], dir: "cw" | "ccw"): T[] {
  if (loop.length < 3) return loop;
  return (area(loop) > 0) === (dir === "ccw") ? loop : [loop[0], ...loop.slice(1).reverse()];
}

/** Geschlossene Kontur so drehen, dass sie am nächsten Punkt zu `target` beginnt. Liegt der auf einer Kante, kommt dort ein Punkt dazu */
export function rotateLoopTo(input: Pt[], target: Pt): Pt[] {
  const loop = openLoop(input);
  const n = loop.length;
  if (n < 2) return input;
  let best = Infinity, edge = 0, u = 0;
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const k = l2 > 0 ? Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(a.x + dx * k - target.x, a.y + dy * k - target.y);
    if (d < best - 1e-12) { best = d; edge = i; u = k; }
  }
  const a = loop[edge], b = loop[(edge + 1) % n];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (u * len < 1e-6) return [...loop.slice(edge), ...loop.slice(0, edge)];
  if ((1 - u) * len < 1e-6) { const k = (edge + 1) % n; return [...loop.slice(k), ...loop.slice(0, k)]; }
  const p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  return [p, ...loop.slice(edge + 1), ...loop.slice(0, edge + 1)];
}

/** Punkt bei einem Anteil 0..1 entlang der Kontur */
export function pointAtFraction(pts: Pt[], closed: boolean, f: number): Pt {
  const list = closed ? [...pts, pts[0]] : pts;
  let total = 0;
  for (let i = 1; i < list.length; i++) total += Math.hypot(list[i].x - list[i - 1].x, list[i].y - list[i - 1].y);
  let left = Math.max(0, Math.min(1, f)) * total;
  for (let i = 1; i < list.length; i++) {
    const l = Math.hypot(list[i].x - list[i - 1].x, list[i].y - list[i - 1].y);
    if (left <= l && l > 0) { const u = left / l; return { x: list[i - 1].x + (list[i].x - list[i - 1].x) * u, y: list[i - 1].y + (list[i].y - list[i - 1].y) * u }; }
    left -= l;
  }
  return { ...list[list.length - 1] };
}

/** Anteil 0..1 des nächsten Konturpunkts zu `at` */
export function fractionAt(pts: Pt[], closed: boolean, at: Pt): number {
  const list = closed ? [...pts, pts[0]] : pts;
  let total = 0, run = 0, best = Infinity, bestS = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i], dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
    const u = l > 0 ? Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / (l * l))) : 0;
    const d = Math.hypot(a.x + dx * u - at.x, a.y + dy * u - at.y);
    if (d < best) { best = d; bestS = run + u * l; }
    run += l;
    total += l;
  }
  return total > 0 ? bestS / total : 0;
}

/** Gesetzter Startpunkt der Form in mm (Maschine); null = keiner gesetzt */
export function cutStartMm(shape: any): Pt | null {
  const f = cutStartOf(shape);
  if (f === null) return null;
  const p = shapeToPaths(shape)[0];
  if (!p || !p.closed || p.pts.length < 2) return null;
  const q = pointAtFraction(p.pts, true, f);
  return { x: q.x / MM_TO_PIXEL, y: q.y / MM_TO_PIXEL };
}

/** Geschlossene Bahn (mm): gesetzte Richtung und gesetzten Start anwenden; ohne Einstellung dieselbe Liste */
export function applyCutClosed(loop: Pt[], shape: any): Pt[] {
  if (!hasCutSetting(shape)) return loop;
  const dir = cutDirOf(shape);
  let out = loop;
  if (dir === "cw" || dir === "ccw") out = orientClosed(out, dir);
  const start = cutStartMm(shape);
  if (start) out = rotateLoopTo(out, start);
  return out;
}

/** Offene Bahn (mm): nur rückwärts oder nicht */
export function applyCutOpen(pts: Pt[], shape: any): Pt[] {
  return cutDirOf(shape) === "reverse" ? [...pts].reverse() : pts;
}

export function applyCut(pts: Pt[], closed: boolean, shape: any): Pt[] {
  return closed ? applyCutClosed(pts, shape) : applyCutOpen(pts, shape);
}

/**
 * In welche Richtung läuft die Form wirklich?
 * Geschlossen: ccw true/false. Offen: forward true/false. auto = so ergibt es die Maschinen-Regel, nichts von Hand gesetzt.
 */
export function effectiveDirection(shape: any, machine: MachineKind): { closed: boolean; ccw: boolean; forward: boolean; auto: boolean } {
  const p = shapeToPaths(shape)[0];
  const closed = !!p?.closed;
  const dir = cutDirOf(shape);
  if (!closed) return { closed, ccw: false, forward: dir !== "reverse", auto: dir === null };
  if (dir === "cw" || dir === "ccw") return { closed, ccw: dir === "ccw", forward: true, auto: false };
  const drawn = p ? area(p.pts) > 0 : true;
  const mode = shape.millingMode || "outside";
  let ccw = drawn;
  if (machine === "plasma" && (mode === "outside" || mode === "inside")) ccw = mode === "inside";
  if (machine === "mill" && (mode === "outside" || mode === "inside")) {
    const md = shape.millDir;
    if (md === "climb" || md === "conventional") ccw = (mode === "inside") === (md === "climb");
    else if (shape.type === "circle") ccw = false; // Vollkreis ohne Vorgabe: immer G2
    else ccw = mode === "outside";
  }
  return { closed, ccw, forward: true, auto: true };
}

/** Fräse: ergibt diese Richtung Gleichlauf? null = keine Seite (auf der Linie) */
export function isClimb(mode: string, ccw: boolean): boolean | null {
  if (mode !== "outside" && mode !== "inside") return null;
  return ccw === (mode === "inside");
}

/** Gesetzte Richtung (cw/ccw) gegen die Gleich-/Gegenlauf-Vorgabe der Form: widerspricht sie? */
export function overridesMillDir(shape: any): boolean {
  const dir = cutDirOf(shape), md = shape.millDir, mode = shape.millingMode;
  if ((dir !== "cw" && dir !== "ccw") || (md !== "climb" && md !== "conventional")) return false;
  const climb = isClimb(mode, dir === "ccw");
  return climb !== null && climb !== (md === "climb");
}

/** Marke für die Ansicht: wo der Pfeil steht und wohin er zeigt (Welt-Pixel); null = Form hat keine Kontur */
export function cutMark(shape: any, machine: MachineKind, startOverride?: number | null): { at: Pt; dir: Pt; fixedStart: boolean } | null {
  const p = shapeToPaths(shape)[0];
  if (!p || p.pts.length < 2) return null;
  const eff = effectiveDirection(shape, machine);
  const start = startOverride !== undefined ? startOverride : cutStartOf(shape);
  let pts = p.pts;
  if (!eff.closed) pts = eff.forward ? pts : [...pts].reverse();
  else if ((area(pts) > 0) !== eff.ccw) pts = [...pts].reverse();
  const at = eff.closed && start !== null ? pointAtFraction(p.pts, true, start) : pts[0];
  // Richtung am Startpunkt: nächstes Stück Kontur, das nicht winzig ist
  const list = eff.closed ? rotateLoopTo(pts, at) : pts;
  let dx = 1, dy = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i], l = Math.hypot(a.x - at.x, a.y - at.y);
    if (l > 1e-6) { dx = (a.x - at.x) / l; dy = (a.y - at.y) / l; break; }
  }
  return { at, dir: { x: dx, y: dy }, fixedStart: eff.closed && start !== null };
}
