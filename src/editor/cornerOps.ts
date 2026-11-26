/**
 * EINE ECKE VERRUNDEN/FASEN UND LINIEN VERLÄNGERN – nur Rechnung (mit `npm test` prüfbar). Maus-Teil: cornerTool.ts
 *
 * Ecke: nur die angeklickte Ecke einer Polylinie bekommt einen Bogen mit Radius r (bzw. eine Fase mit Schenkellänge r).
 *   Anders als „Verrunden“ für die ganze Form wird nichts heimlich verkleinert: passt der Radius nicht an die Kanten,
 *   gibt es eine Meldung.
 * Verlängern: das angeklickte Ende einer offenen Linie läuft geradeaus weiter bis zur nächsten Form (Gegenstück zu Stutzen).
 */
import { intersect, type Prim } from "./snapGeom.ts";

export interface P { x: number; y: number }

/** Nächste Ecke einer Polylinie zur Maus (innerhalb tol), -1 = keine. Offene Linien: Anfang und Ende sind keine Ecken */
export function nearestCorner(pts: P[], closed: boolean, at: P, tol: number): number {
  let best = -1, bestD = tol;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const d = Math.hypot(pts[i].x - at.x, pts[i].y - at.y);
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}

export type CornerError = "straight" | "tooBig" | "none";
export interface CornerResult { pts: P[]; error?: CornerError; arc?: P[] }

/**
 * Ecke i verrunden (chamfer = false) oder fasen. r in denselben Einheiten wie die Punkte.
 * pts: neue Punktliste; arc: nur das neue Stück (für die Vorschau). tol: größte Abweichung des Bogens als Vieleck
 */
export function filletCorner(pts: P[], closed: boolean, i: number, r: number, chamfer: boolean, tol = 0.02): CornerResult {
  const n = pts.length;
  if (n < 3 || i < 0 || i >= n || (!closed && (i === 0 || i === n - 1)) || !(r > 0)) return { pts, error: "none" };
  const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
  const l1 = Math.hypot(a.x - b.x, a.y - b.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
  if (l1 < 1e-9 || l2 < 1e-9) return { pts, error: "none" };
  const u1 = { x: (a.x - b.x) / l1, y: (a.y - b.y) / l1 }, u2 = { x: (c.x - b.x) / l2, y: (c.y - b.y) / l2 };
  const inner = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y))); // π = gerade weiter
  if (Math.PI - inner < 1e-3 || inner < 1e-6) return { pts, error: "straight" };
  const half = inner / 2;
  const d = chamfer ? r : r / Math.tan(half); // Abstand der Berührpunkte von der Ecke
  const eps = 1e-9 * Math.max(1, d);
  if (d > l1 + eps || d > l2 + eps) return { pts, error: "tooBig" };

  const t1 = { x: b.x + u1.x * d, y: b.y + u1.y * d }, t2 = { x: b.x + u2.x * d, y: b.y + u2.y * d };
  let piece: P[];
  if (chamfer) piece = [t1, t2];
  else {
    const bis = { x: u1.x + u2.x, y: u1.y + u2.y }, bl = Math.hypot(bis.x, bis.y) || 1;
    const k = r / Math.sin(half);
    const cx = b.x + (bis.x / bl) * k, cy = b.y + (bis.y / bl) * k;
    const a0 = Math.atan2(t1.y - cy, t1.x - cx), a1 = Math.atan2(t2.y - cy, t2.x - cx);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    const step = 2 * Math.acos(Math.max(-1, 1 - tol / Math.max(r, tol)));
    const steps = Math.max(3, Math.ceil(Math.abs(sweep) / step));
    piece = [];
    for (let s = 0; s <= steps; s++) {
      const ang = a0 + (sweep * s) / steps;
      piece.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });
    }
    piece[0] = t1; piece[piece.length - 1] = t2; // Berührpunkte exakt
  }
  // Fällt ein Berührpunkt genau auf den Nachbarpunkt, diesen nicht doppelt
  const same = (p: P, q: P) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-9 * Math.max(1, r);
  const head = same(piece[0], a) ? piece.slice(1) : piece;
  const body = same(head[head.length - 1], c) ? head.slice(0, -1) : head;
  const out = [...pts.slice(0, i), ...body, ...pts.slice(i + 1)];
  // Geschlossene Form: wurde Punkt 0 ersetzt und sein Vorgänger (der letzte Punkt) weggelassen, stimmt die Reihenfolge trotzdem
  return { pts: out, arc: piece };
}

/**
 * Ende einer offenen Linie bis zur nächsten Form verlängern.
 * end = "start" oder "end"; targets: Bausteine der anderen Formen (snapGeom.ts), maxLen: wie weit höchstens gesucht wird.
 * Ergebnis: der neue Endpunkt, null = nichts in Reichweite
 */
export function extendTo(pts: P[], end: "start" | "end", targets: Prim[], maxLen: number): P | null {
  const n = pts.length;
  if (n < 2) return null;
  const tip = end === "end" ? pts[n - 1] : pts[0], prev = end === "end" ? pts[n - 2] : pts[1];
  const dx = tip.x - prev.x, dy = tip.y - prev.y, len = Math.hypot(dx, dy);
  if (len < 1e-12) return null;
  const ux = dx / len, uy = dy / len;
  const ray = { k: "seg" as const, a: tip, b: { x: tip.x + ux * maxLen, y: tip.y + uy * maxLen }, id: "\u0000ray", i: 0 };
  const minGo = 1e-6 * Math.max(1, len);
  let best: P | null = null, bestT = Infinity;
  for (const p of targets) {
    for (const q of intersect(ray, p)) {
      const t = (q.x - tip.x) * ux + (q.y - tip.y) * uy;
      if (t > minGo && t < bestT) { bestT = t; best = q; }
    }
  }
  return best;
}
