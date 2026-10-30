/**
 * VERBUNDENE NAMEN – reine Geometrie (ohne Oberfläche, mit Tests in tests/nameConnect.test.ts)
 *
 * Für den Namen-Generator (editor/nameGen.ts):
 *  - Ritzlinien: wo sich Buchstaben (oder Symbole) überlappen, verschwinden ihre Kanten beim Vereinigen.
 *    Die Kante des späteren (oberen) Teils über den früheren bleibt als Gravurlinie erhalten – so bleibt der
 *    Name lesbar, obwohl er ein Stück ist. Verdeckt ein noch späteres Teil die Kante, fällt sie weg.
 *  - Wachsen: Fläche um d nach außen (Umriss um den Namen, Innenräume gefüllt) oder Fettung (Innenräume bleiben)
 *  - Skalieren für die fertige Breite
 * Alles in mm, Y nach oben. Flächen im Format von polygon-clipping.
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Ring } from "polygon-clipping";

export type XY = [number, number];
/** Gravurlinie: offen (Ritzlinie) oder geschlossen (Kontur als Linie) */
export interface ScoreLine { pts: XY[]; closed: boolean }

export function bounds(m: MultiPolygon) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of m) for (const [x, y] of poly[0] || []) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

/** Punkt in Fläche (Gerade/Ungerade über alle Ringe) */
export function inRegion(m: MultiPolygon, x: number, y: number): boolean {
  let n = 0;
  for (const poly of m) for (const r of poly) {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) n++;
  }
  return n % 2 === 1;
}

/** Abstand Punkt – Rand der Fläche */
function edgeDist(m: MultiPolygon, x: number, y: number): number {
  let d = Infinity;
  for (const poly of m) for (const r of poly) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [ax, ay] = r[j], [bx, by] = r[i], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const u = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
    d = Math.min(d, Math.hypot(x - ax - u * dx, y - ay - u * dy));
  }
  return d;
}

const lineLen = (p: XY[]) => p.reduce((s, q, i) => (i ? s + Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) : 0), 0);

/** Douglas-Peucker für offene Linien */
function dp(pts: XY[], tol: number): XY[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [ax, ay] = pts[s], [bx, by] = pts[e], L = Math.hypot(bx - ax, by - ay);
    let md = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      // Anfang = Ende (ganze geschlossene Kontur): Abstand zum Punkt statt zur Geraden
      const d = L < 1e-9 ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay) : Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
      if (d > md) { md = d; idx = i; }
    }
    if (idx >= 0 && md > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** geschlossener Ring ohne doppelten Endpunkt, vereinfacht */
function cleanRing(r: Ring, tol: number): XY[] {
  const last = r[r.length - 1];
  const pts = (r.length > 1 && last[0] === r[0][0] && last[1] === r[0][1] ? r.slice(0, -1) : r) as XY[];
  if (pts.length < 4 || tol <= 0) return pts;
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = dp(pts.slice(0, far + 1), tol), b = dp([...pts.slice(far), pts[0]], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/**
 * Teile eines Rings, für die keep(Mitte) gilt – abgetastet in Schritten von step mm.
 * Läufe kürzer als minLen fallen weg (Krümel an Ecken).
 */
export function keepRuns(r: XY[], closed: boolean, keep: (x: number, y: number) => boolean, step = 0.1, minLen = 0.5): XY[][] {
  const seq = closed ? [...r, r[0]] : r;
  const runs: XY[][] = [];
  let cur: XY[] | null = null;
  for (let i = 1; i < seq.length; i++) {
    const [ax, ay] = seq[i - 1], [bx, by] = seq[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) {
      const p: XY = [ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n];
      const q: XY = [ax + ((bx - ax) * (k + 1)) / n, ay + ((by - ay) * (k + 1)) / n];
      if (keep((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)) {
        if (!cur) { cur = [p]; runs.push(cur); }
        cur.push(q);
      } else cur = null;
    }
  }
  // geschlossene Kontur: letzter und erster Lauf gehören zusammen
  if (closed && runs.length > 1) {
    const f = runs[0], l = runs[runs.length - 1], e = l[l.length - 1];
    if (Math.hypot(f[0][0] - e[0], f[0][1] - e[1]) < 1e-9) { runs[0] = [...l, ...f.slice(1)]; runs.pop(); }
  }
  return runs.map(p => dp(p, 0.01)).filter(p => p.length >= 2 && lineLen(p) >= minLen);
}

/** Vereinigung (leere Listen erlaubt) */
export function union(list: MultiPolygon[]): MultiPolygon {
  const l = list.filter(m => m.length);
  return l.length > 1 ? polygonClipping.union(l[0], ...l.slice(1)) : l[0] || [];
}

/**
 * Viele Flächen vereinigen: Koordinaten auf 1/1000 mm runden und in kleinen Paketen (Baum) vereinigen – sonst
 * verschluckt sich polygon-clipping bei sehr vielen fast deckungsgleichen Kanten („Unable to find segment“).
 */
export function unionMany(parts: MultiPolygon[]): MultiPolygon {
  const q = (v: number) => Math.round(v * 1000) / 1000;
  let list = parts.filter(m => m.length).map(m => m.map(p => p.map(r => r.map(([x, y]) => [q(x), q(y)] as XY))));
  while (list.length > 1) {
    const next: MultiPolygon[] = [];
    for (let i = 0; i < list.length; i += 16) {
      const chunk = list.slice(i, i + 16);
      try { next.push(polygonClipping.union(chunk[0], ...chunk.slice(1))); }
      catch { // einzeln nacheinander; was trotzdem scheitert, bleibt weg (nur ein Stück Rand)
        let acc = chunk[0];
        for (const c of chunk.slice(1)) { try { acc = polygonClipping.union(acc, c); } catch { /* überspringen */ } }
        next.push(acc);
      }
    }
    list = next;
  }
  return list[0] || [];
}

/**
 * Fläche um d nach außen wachsen lassen: Fläche ∪ „Kapsel“ (Streifen mit runden Enden) entlang jeder Kante –
 * robust auch bei verschnörkelten Schriften, wo ein Versatz der Kontur scheitert.
 * keepHoles = false: nur Außenkonturen (Innenräume gefüllt, für den Umriss);
 * keepHoles = true: auch Innenräume schrumpfen um d (Fettung – das o bleibt ein o).
 */
export function grow(m: MultiPolygon, d: number, keepHoles = false): MultiPolygon {
  if (!(d > 0)) return m;
  const parts: MultiPolygon[] = [];
  const steps = Math.max(8, Math.min(16, Math.ceil(d * 5)));
  const tol = Math.min(0.15, d / 8);
  for (const poly of m) {
    if (!poly[0]) continue;
    const rings = (keepHoles ? poly : [poly[0]]).map(r => cleanRing(r, tol)).filter(r => r.length >= 3);
    if (!rings.length) continue;
    parts.push([rings.map(r => [...r, r[0]])]);
    for (const pts of rings) for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (L > 1e-9) {
        const nx = (-(c[1] - a[1]) / L) * d, ny = ((c[0] - a[0]) / L) * d;
        parts.push([[[[a[0] + nx, a[1] + ny], [c[0] + nx, c[1] + ny], [c[0] - nx, c[1] - ny], [a[0] - nx, a[1] - ny]]]]);
      }
      parts.push([[Array.from({ length: steps }, (_, k) => [a[0] + d * Math.cos((k / steps) * Math.PI * 2), a[1] + d * Math.sin((k / steps) * Math.PI * 2)] as XY)]]);
    }
  }
  return unionMany(parts);
}

/**
 * Ritzlinien an Überlappungen. parts in Zeichen-Reihenfolge (später = oben).
 * Ergebnis: Kanten eines Teils, die über einem früheren Teil liegen und nicht von einem späteren verdeckt sind.
 * margin: Linien halten so viel Abstand vom Rand der vereinten Fläche (der Laser soll die Schnittkante nicht treffen).
 */
export function overlapScores(parts: MultiPolygon[], margin = 0.3, minLen = 0.8): ScoreLine[] {
  const list = parts.filter(m => m.length);
  if (list.length < 2) return [];
  // Vereinigung aller früheren bzw. späteren Teile, schrittweise aufgebaut
  const pre: MultiPolygon[] = [list[0]], suf: MultiPolygon[] = [];
  for (let i = 1; i < list.length; i++) pre[i] = union([pre[i - 1], list[i]]);
  suf[list.length - 1] = [];
  for (let i = list.length - 2; i >= 0; i--) suf[i] = union([suf[i + 1], list[i + 1]]);
  const all = pre[list.length - 1];
  const out: ScoreLine[] = [];
  list.forEach((m, i) => {
    if (!i) return;
    const under = pre[i - 1], over = suf[i];
    const ub = bounds(under), mb = bounds(m);
    if (ub.x1 < mb.x0 || mb.x1 < ub.x0 || ub.y1 < mb.y0 || mb.y1 < ub.y0) return; // berührt nichts darunter
    for (const poly of m) for (const r of poly) {
      const pts = cleanRing(r, 0);
      for (const run of keepRuns(pts, true, (x, y) =>
        inRegion(under, x, y) && !(over.length && inRegion(over, x, y)) && edgeDist(all, x, y) >= margin, 0.1, minLen))
        out.push({ pts: run, closed: false });
    }
  });
  return out;
}

/** Linien auf die Fläche beschneiden (z. B. nach dem Loch des Aufhängers) */
export function clipLines(lines: ScoreLine[], m: MultiPolygon, margin = 0): ScoreLine[] {
  const out: ScoreLine[] = [];
  for (const l of lines) {
    const ok = (x: number, y: number) => inRegion(m, x, y) && (!margin || edgeDist(m, x, y) >= margin);
    const runs = keepRuns(l.pts, l.closed, ok, 0.1, 0.5);
    // ganz drin: Linie unverändert lassen (geschlossene Konturen bleiben geschlossen)
    const whole = runs.length === 1 && Math.abs(lineLen(runs[0]) - lineLen(l.closed ? [...l.pts, l.pts[0]] : l.pts)) < 0.05;
    if (whole) out.push(l);
    else for (const run of runs) out.push({ pts: run, closed: false });
  }
  return out;
}

/** Konturen einer Fläche als geschlossene Gravurlinien */
export const outlineLines = (m: MultiPolygon): ScoreLine[] =>
  m.flatMap(poly => poly.map(r => ({ pts: cleanRing(r, 0), closed: true }))).filter(l => l.pts.length >= 3);

export const scaleArea = (m: MultiPolygon, k: number): MultiPolygon => m.map(p => p.map(r => r.map(([x, y]) => [x * k, y * k] as XY)));
export const scaleLines = (l: ScoreLine[], k: number): ScoreLine[] => l.map(s => ({ closed: s.closed, pts: s.pts.map(([x, y]) => [x * k, y * k] as XY) }));

/** Fläche um ihre Mitte drehen (Grad, gegen den Uhrzeigersinn) */
export function rotateArea(m: MultiPolygon, deg: number): MultiPolygon {
  if (!deg || !m.length) return m;
  const b = bounds(m), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  return m.map(p => p.map(r => r.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c] as XY)));
}
