/**
 * TRIM: Linienstück bis zum nächsten Schnittpunkt entfernen (Rechnung, Tests in tests/trim.test.ts).
 *
 * Alles läuft über Stationen = Strecke entlang der Kontur. Bögen und Kreise bleiben echte Bögen (für G2/G3), Linien und
 * Polylinien bleiben Polylinien; Kurven (Bézier) verlieren beim Teilen ihre Griffe, die Punkte bleiben auf der Kurve.
 * Schnittpunkte am Ende einer offenen Kontur zählen nicht: aus DXF kommen viele Linien, die sich nur an den Enden berühren.
 */
import { arcGeometry, createArc, createPolyline, shapeToPaths, type Path, type Pt } from "../shapeTransform.ts";

/** Toleranz in Welt-Pixeln (0,01 mm), fängt Rundungsfehler aus DXF ab */
export const TRIM_EPS = 0.02;

/** Eigenschaften, die die Teilstücke von der Ausgangsform übernehmen */
const KEEP = ["toolId", "laserLayerId", "plasmaCutId", "millingDepth", "source", "groupId"];

/** Offene Kontur mit gleichem Anfang und Ende wie eine geschlossene behandeln (kommt aus DXF/SVG vor) */
export function normalizePath(p: Path, eps = TRIM_EPS): Path {
  const n = p.pts.length;
  if (!p.closed && n > 3 && Math.hypot(p.pts[0].x - p.pts[n - 1].x, p.pts[0].y - p.pts[n - 1].y) <= eps) {
    return { pts: p.pts.slice(0, -1), closed: true };
  }
  return p;
}

function vertices(p: Path): Pt[] { return p.closed ? [...p.pts, p.pts[0]] : p.pts; }

export function pathLength(p: Path): number {
  const v = vertices(p);
  let l = 0;
  for (let i = 1; i < v.length; i++) l += Math.hypot(v[i].x - v[i - 1].x, v[i].y - v[i - 1].y);
  return l;
}

interface Chunk { from: number; to: number; minX: number; minY: number; maxX: number; maxY: number }

/** Segmente in kleine Pakete mit Umriss teilen: spart bei langen Konturen fast alle Vergleiche */
function chunksOf(v: Pt[], size = 24): Chunk[] {
  const out: Chunk[] = [];
  for (let from = 0; from < v.length - 1; from += size) {
    const to = Math.min(from + size, v.length - 1);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = from; i <= to; i++) {
      if (v[i].x < minX) minX = v[i].x; if (v[i].x > maxX) maxX = v[i].x;
      if (v[i].y < minY) minY = v[i].y; if (v[i].y > maxY) maxY = v[i].y;
    }
    out.push({ from, to, minX, minY, maxX, maxY });
  }
  return out;
}

const overlap = (a: Chunk, b: Chunk, e: number) => a.minX <= b.maxX + e && b.minX <= a.maxX + e && a.minY <= b.maxY + e && b.minY <= a.maxY + e;

/** Alle Stationen auf `target`, an denen eine andere Kontur (oder target selbst) sie kreuzt oder berührt */
export function intersections(target: Path, cutters: Path[], eps = TRIM_EPS): number[] {
  const tv = vertices(target);
  const cum = [0];
  for (let i = 1; i < tv.length; i++) cum.push(cum[i - 1] + Math.hypot(tv[i].x - tv[i - 1].x, tv[i].y - tv[i - 1].y));
  const total = cum[cum.length - 1];
  const tc = chunksOf(tv);
  const hits: number[] = [];

  const test = (cv: Pt[], self: boolean) => {
    const cc = chunksOf(cv);
    const lastSeg = tv.length - 2;
    for (const a of tc) for (const b of cc) {
      if (!overlap(a, b, eps)) continue;
      for (let i = a.from; i < a.to; i++) {
        const p = tv[i], q = tv[i + 1];
        const rx = q.x - p.x, ry = q.y - p.y, rl = Math.hypot(rx, ry);
        if (rl < 1e-12) continue;
        for (let j = b.from; j < b.to; j++) {
          if (self) {
            if (j <= i + 1 && j >= i - 1) continue; // Nachbarn teilen sich immer einen Punkt
            if (target.closed && ((i === 0 && j === lastSeg) || (j === 0 && i === lastSeg))) continue;
          }
          const c = cv[j], d = cv[j + 1];
          const sx = d.x - c.x, sy = d.y - c.y, sl = Math.hypot(sx, sy);
          if (sl < 1e-12) continue;
          const den = rx * sy - ry * sx;
          if (Math.abs(den) < 1e-9 * rl * sl) continue; // parallel
          const t = ((c.x - p.x) * sy - (c.y - p.y) * sx) / den;
          const u = ((c.x - p.x) * ry - (c.y - p.y) * rx) / den;
          const et = eps / rl, eu = eps / sl;
          if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) continue;
          hits.push(cum[i] + Math.max(0, Math.min(1, t)) * rl);
        }
      }
    }
  };
  for (const c of cutters) if (c.pts.length >= 2) test(vertices(c), false);
  test(tv, true);

  hits.sort((x, y) => x - y);
  const out: number[] = [];
  for (const h of hits) {
    if (!target.closed && (h <= eps || h >= total - eps)) continue; // Enden offener Konturen zählen nicht
    if (out.length && h - out[out.length - 1] <= eps) continue;
    out.push(h);
  }
  // Geschlossen: Treffer knapp vor und knapp nach der Naht sind derselbe
  if (target.closed && out.length > 1 && out[0] + total - out[out.length - 1] <= eps) out.pop();
  return out;
}

/** Nächste Station zum Punkt */
export function nearestStation(p: Path, at: Pt): { s: number; dist: number } {
  const v = vertices(p);
  let best = Infinity, bestS = 0, run = 0;
  for (let i = 0; i < v.length - 1; i++) {
    const a = v[i], b = v[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(a.x + dx * u - at.x, a.y + dy * u - at.y);
    if (d < best) { best = d; bestS = run + u * Math.sqrt(l2); }
    run += Math.sqrt(l2);
  }
  return { s: bestS, dist: best };
}

export interface Span { from: number; to: number } // to > length nur bei geschlossenen Konturen (über die Naht)

/** Das Stück um die Station s0 zwischen den beiden nächsten Schnittpunkten; null = nichts zu begrenzen */
export function trimSpan(length: number, closed: boolean, cuts: number[], s0: number): Span | null {
  if (!cuts.length) return null;
  if (closed) {
    if (cuts.length < 2) return null; // ein einzelner Punkt begrenzt keine Strecke
    let i = cuts.findIndex(c => c > s0);
    if (i < 0) i = 0;
    const to = cuts[i], from = cuts[(i - 1 + cuts.length) % cuts.length];
    return to > from ? { from, to } : { from, to: to + length };
  }
  let from = 0, to = length;
  for (const c of cuts) { if (c <= s0) from = c; else { to = c; break; } }
  return { from, to };
}

/** Was nach dem Entfernen von `span` übrig bleibt */
export function remainingSpans(length: number, closed: boolean, span: Span, eps = TRIM_EPS): Span[] {
  if (closed) return [{ from: span.to, to: span.from + length }];
  const out: Span[] = [];
  if (span.from > eps) out.push({ from: 0, to: span.from });
  if (span.to < length - eps) out.push({ from: span.to, to: length });
  return out;
}

/** Punkte der Kontur von Station from bis to */
export function slicePath(p: Path, span: Span): Pt[] {
  const v = vertices(p);
  const n = v.length;
  const closedLen = p.closed ? pathLength(p) : 0;
  const out: Pt[] = [];
  const push = (q: Pt) => {
    const l = out[out.length - 1];
    if (!l || Math.hypot(l.x - q.x, l.y - q.y) > 1e-9) out.push({ x: q.x, y: q.y });
  };
  // Bei „über die Naht“ läuft die Schleife ein zweites Mal
  const rounds = p.closed && span.to > closedLen + 1e-9 ? 2 : 1;
  let run = 0;
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < n - 1; i++) {
      const a = v[i], b = v[i + 1], l = Math.hypot(b.x - a.x, b.y - a.y);
      const s0 = run, s1 = run + l;
      run = s1;
      if (l < 1e-12 || s1 < span.from || s0 > span.to) continue;
      const lo = Math.max(0, (span.from - s0) / l), hi = Math.min(1, (span.to - s0) / l);
      push({ x: a.x + (b.x - a.x) * lo, y: a.y + (b.y - a.y) * lo });
      push({ x: a.x + (b.x - a.x) * hi, y: a.y + (b.y - a.y) * hi });
    }
  }
  return out;
}

/** Eine Form → Teilstücke als neue Formen (eigene Ids). Bogen und Kreis geben echte Bögen zurück */
export function piecesFromSpans(shape: any, path: Path, spans: Span[]): any[] {
  const len = pathLength(path);
  const extra: Record<string, any> = {};
  for (const k of KEEP) if (shape[k] !== undefined) extra[k] = shape[k];
  // Aus geschlossenen Formen wird eine offene Kontur: außen/innen ergibt dann keinen Sinn mehr
  const wasOpen = shape.type === "line" || shape.type === "arc" || (shape.type === "polyline" && !shape.closed);
  const mode = wasOpen ? shape.millingMode || "on-line" : "on-line";
  const withProps = (s: any) => { Object.assign(s, extra); s.millingMode = mode; return s; };
  const out: any[] = [];
  const g = shape.type === "arc" ? arcGeometry(shape) : null;
  for (const sp of spans) {
    if (sp.to - sp.from <= TRIM_EPS) continue;
    if (g) {
      const at = (f: number) => { const a = g.start + g.sweep * f; return { x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) }; };
      const a = at(sp.from / len), b = at(sp.to / len), m = at((sp.from + sp.to) / 2 / len);
      out.push(withProps(createArc(a.x, a.y, b.x, b.y, m.x, m.y)));
    } else if (shape.type === "circle") {
      // Die Kreis-Kontur beginnt bei 0° und läuft gegen den Uhrzeigersinn
      const r = Math.abs(shape.w);
      const at = (st: number) => { const a = (st / len) * 2 * Math.PI; return { x: shape.x + r * Math.cos(a), y: shape.y + r * Math.sin(a) }; };
      const a = at(sp.from), b = at(sp.to), m = at((sp.from + sp.to) / 2);
      out.push(withProps(createArc(a.x, a.y, b.x, b.y, m.x, m.y)));
    } else {
      const pts = slicePath(path, sp);
      if (pts.length >= 2) out.push(withProps(createPolyline(pts, false, mode)));
    }
  }
  return out;
}

export interface TrimResult { removed: Pt[]; pieces: any[] }

/**
 * Ein Klick bei `at` auf die Form `shape`: was fällt weg, was bleibt. cuts = fertige Schnittpunkte (zwischengespeichert,
 * die Maus bewegt sich oft). null = kein Schnittpunkt, dann bleibt die Form, wie sie ist.
 */
export function trimShape(shape: any, cutterPaths: Path[], at: Pt, cuts?: number[]): TrimResult | null {
  const raw = shapeToPaths(shape)[0];
  if (!raw || raw.pts.length < 2) return null;
  const path = normalizePath(raw);
  const stations = cuts ?? intersections(path, cutterPaths);
  const len = pathLength(path);
  const span = trimSpan(len, path.closed, stations, nearestStation(path, at).s);
  if (!span) return null;
  return { removed: slicePath(path, span), pieces: piecesFromSpans(shape, path, remainingSpans(len, path.closed, span)) };
}

/** Kontur für trimShape holen (die Schnittpunkte rechnet der Aufrufer nur einmal je Form) */
export function trimTargetPath(shape: any): Path | null {
  const raw = shapeToPaths(shape)[0];
  return raw && raw.pts.length >= 2 ? normalizePath(raw) : null;
}

