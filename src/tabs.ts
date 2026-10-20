/**
 * HALTESTEGE: wo auf einer Kontur die Stege liegen (gemeinsam für G-Code, Vorschau und das Werkzeug „Stege setzen“)
 *
 * Je Form:
 *   tabMode  "auto" (Standard) = tabN Stege gleichmäßig verteilt
 *            "manual"          = selbst gesetzt: tabPts = Stellen als Anteil 0…1 entlang der Kontur der Form
 *   tabLen   Länge eines Stegs (mm), tabH Höhe ab dem Boden (mm, nur Fräse – Laser/Plasma lassen den Steg ganz stehen)
 *
 * Selbst gesetzte Stellen hängen an der Kontur der Form – sie wandern beim Verschieben, Drehen, Skalieren mit.
 * Für die Fräserbahn (außen/innen versetzt) wird jede Stelle auf die Bahn projiziert.
 */
import { makeEllipsePoints, Pt } from "./shapeTransform";

export interface TabSettings { len: number; h: number }

/** Länge/Höhe, wenn die Form Stege hat (sonst null). needHeight = false: Laser/Plasma (dort zählt keine Höhe) */
export function tabSettings(shape: any, needHeight = true): TabSettings | null {
  const len = Number(shape.tabLen) || 0, h = Number(shape.tabH) || 0;
  if (len <= 0 || (needHeight && h <= 0)) return null;
  if (shape.tabMode === "manual") return Array.isArray(shape.tabPts) && shape.tabPts.length ? { len, h } : null;
  return Math.round(Number(shape.tabN) || 0) > 0 ? { len, h } : null;
}

/** Kontur der Form in Welt-Pixeln (nur geschlossene Formen) */
export function outline(shape: any): Pt[] | null {
  if (shape.type === "circle") return makeEllipsePoints(shape.x, shape.y, Math.abs(shape.w), Math.abs(shape.w));
  if (shape.type === "polyline" && shape.closed && shape.points?.length >= 3) return shape.points;
  return null;
}

/** Laufende Länge entlang des Rings (geschlossen, letzter Punkt != erster) */
export function cumulative(ring: Pt[]): number[] {
  const cum = [0];
  for (let i = 1; i <= ring.length; i++) {
    const a = ring[i - 1], b = ring[i % ring.length];
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return cum;
}

/** Punkt bei Länge s auf dem Ring */
export function pointAt(ring: Pt[], cum: number[], s: number): Pt {
  const L = cum[cum.length - 1];
  s = ((s % L) + L) % L;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const a = ring[i - 1], b = ring[i % ring.length];
  const f = (s - cum[i - 1]) / Math.max(1e-12, cum[i] - cum[i - 1]);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** Nächste Stelle auf dem Ring: Länge s und Abstand d */
export function project(ring: Pt[], cum: number[], p: Pt): { s: number; d: number } {
  let best = { s: 0, d: Infinity };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best.d) best = { s: cum[i] + Math.sqrt(l2) * t, d };
  }
  return best;
}

/** Stelle (0…1) entlang der Kontur der Form → Weltpunkt */
export function outlinePoint(shape: any, f: number): Pt | null {
  const ring = outline(shape);
  if (!ring) return null;
  const cum = cumulative(ring);
  return pointAt(ring, cum, f * cum[cum.length - 1]);
}

/** Weltpunkt → Stelle (0…1) entlang der Kontur und Abstand zur Kontur */
export function outlineFraction(shape: any, p: Pt): { f: number; d: number } | null {
  const ring = outline(shape);
  if (!ring) return null;
  const cum = cumulative(ring);
  const r = project(ring, cum, p);
  return { f: r.s / cum[cum.length - 1], d: r.d };
}

/** Stellen (0…1) der automatischen Stege – Grundlage, wenn man auf „selbst gesetzt“ wechselt */
export function autoFractions(n: number): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, k) => (k + 0.5) / n);
}

/**
 * Mitten der Stege als Länge s auf einer Fräserbahn.
 * @param ring   Fräserbahn (geschlossen) in beliebiger Einheit
 * @param toRing Weltpixel → Einheit der Bahn
 * @param near   wie weit eine selbst gesetzte Stelle höchstens von der Bahn weg sein darf (Einheit der Bahn)
 */
export function tabCenters(shape: any, ring: Pt[], cum: number[], toRing: (p: Pt) => Pt, near: number): number[] {
  const L = cum[cum.length - 1];
  if (shape.tabMode === "manual") {
    const out: number[] = [];
    for (const f of shape.tabPts || []) {
      const w = outlinePoint(shape, Number(f));
      if (!w) continue;
      const r = project(ring, cum, toRing(w));
      if (r.d <= near) out.push(r.s);
    }
    return out;
  }
  const n = Math.round(Number(shape.tabN) || 0);
  return autoFractions(n).map(f => f * L);
}

/**
 * Laser/Plasma: Kontur an den Stegen in Schneid-Stücke zerlegen (dazwischen ist das Werkzeug aus).
 * Die Kontur beginnt bei loop[0]. Liegt der Anfang in einem Steg, beginnt das erste Stück am Ende dieses Stegs
 * (rotated = true, dann passt eine Anfahrbahn nicht mehr). null = keine Stege.
 * @param gap   Länge der Lücke auf der Bahn (Steglänge + Schnittbreite)
 */
export function tabRuns(shape: any, loop: Pt[], toRing: (p: Pt) => Pt, gap: number): { runs: Pt[][]; rotated: boolean } | null {
  if (!tabSettings(shape, false) || loop.length < 3 || !(gap > 0)) return null;
  const cum = cumulative(loop);
  const L = cum[cum.length - 1];
  const half = gap / 2;
  const centers = tabCenters(shape, loop, cum, toRing, half + 1).sort((a, b) => a - b);
  if (!centers.length || centers.length * gap >= L * 0.9) return null;
  // Startet die Kontur in einem Steg? Dann am Ende dieses Stegs anfangen
  let s0 = 0;
  for (const c of centers) {
    const d = Math.min(Math.abs(c), Math.abs(c - L));
    if (d < half) { s0 = c < L / 2 ? c + half : c - L + half; break; }
  }
  const rel = (x: number) => (((x - s0) % L) + L) % L;
  // Lücken (relativ zum Start), überlappende zusammenfassen
  const gaps = centers.map(c => [rel(c) - half, rel(c) + half]).sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const g of gaps) { const last = merged[merged.length - 1]; if (last && g[0] <= last[1]) last[1] = Math.max(last[1], g[1]); else merged.push([...g]); }
  // Schneid-Stücke = alles zwischen den Lücken
  const bounds: number[][] = [];
  let from = 0;
  for (const [a, b] of merged) { if (a > from + 1e-6) bounds.push([from, Math.min(a, L)]); from = Math.max(from, b); }
  if (from < L - 1e-6) bounds.push([from, L]);
  const verts = loop.map((p, i) => ({ p, s: rel(cum[i]) }));
  const runs = bounds.map(([a, b]) => [
    pointAt(loop, cum, s0 + a),
    ...verts.filter(v => v.s > a + 1e-6 && v.s < b - 1e-6).sort((u, v) => u.s - v.s).map(v => v.p),
    pointAt(loop, cum, s0 + b)
  ]);
  return { runs, rotated: Math.abs(s0) > 1e-9 };
}
