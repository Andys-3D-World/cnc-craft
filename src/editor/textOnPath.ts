/**
 * TEXT AUF PFAD: Rechnung (ohne Oberfläche, mit Tests in tests/textOnPath.test.ts).
 *
 * Jeder Buchstabe wird als Ganzes auf die Kurve gesetzt und gedreht, nicht verbogen – so bleiben die Formen sauber.
 * Der Text läuft in Pfad-Richtung, „oben“ am Buchstaben zeigt nach links dazu. Einheiten: alles dieselbe (Welt-Pixel).
 */
export interface P { x: number; y: number }

export interface Glyph { loops: P[][]; closed?: boolean[] }

export interface OnPathOptions {
  offset: number;                       // Versatz entlang des Pfads
  side: "above" | "below";              // Buchstaben stehen auf dem Pfad oder hängen darunter
  anchor: "start" | "center" | "end";   // welches Textstück am Pfad-Anfang (plus Versatz) liegt
  spacing: number;                      // zusätzlicher Buchstabenabstand
  distance: number;                     // Abstand zwischen Text und Pfad
  capHeight: number;                    // Höhe der Großbuchstaben (für „darunter“)
  baseline: number;                     // Höhe der Grundlinie in den Glyphen-Koordinaten
}

export interface OnPathResult {
  loops: { pts: P[]; closed: boolean }[];
  textLength: number;
  pathLength: number;
  overflow: boolean;                    // Text ragt über das Ende hinaus bzw. läuft einmal ganz herum
}

function signedArea(pts: P[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return a / 2;
}

/**
 * Pfad so ausrichten, dass der Text ohne Zutun lesbar ist. Geschlossen: im Uhrzeigersinn, Start ganz oben (so steht Text
 * oben auf einem Kreis richtig herum). Offen: von links nach rechts. flip dreht die Laufrichtung um.
 */
export function orientPath(input: P[], closed: boolean, flip: boolean): P[] {
  let pts = input.map(p => ({ x: p.x, y: p.y }));
  if (closed) {
    if (signedArea(pts) > 0) pts.reverse();
    if (flip) pts.reverse();
    const top = Math.max(...pts.map(p => p.y));
    const eps = 1e-6;
    let at = pts.findIndex((p, i) => p.y >= top - eps && pts[(i + pts.length - 1) % pts.length].y < top - eps);
    if (at < 0) at = 0;
    pts = [...pts.slice(at), ...pts.slice(0, at)];
    // Flache Oberkante (Rechteck): Start in die Mitte der Kante legen
    if (pts.length > 1 && pts[1].y >= top - eps) {
      pts = [{ x: (pts[0].x + pts[1].x) / 2, y: top }, ...pts.slice(1), pts[0]];
    }
    return pts;
  }
  const a = pts[0], b = pts[pts.length - 1];
  const rtl = b.x < a.x - 1e-9;
  if (rtl !== flip) pts.reverse();
  return pts;
}

export function pathWalker(pts: P[], closed: boolean) {
  const list = closed ? [...pts, pts[0]] : pts;
  const cum: number[] = [0];
  for (let i = 1; i < list.length; i++) cum.push(cum[i - 1] + Math.hypot(list[i].x - list[i - 1].x, list[i].y - list[i - 1].y));
  const length = cum[cum.length - 1];
  /** Punkt bei Strecke s; offener Pfad: darüber hinaus geht es gerade weiter, geschlossen: im Kreis */
  const at = (sIn: number): P => {
    if (!length) return { ...list[0] };
    let s = sIn;
    if (closed) s = ((s % length) + length) % length;
    let i: number;
    if (s <= 0) i = 0;
    else if (s >= length) i = Math.max(0, list.length - 2);
    else {
      let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
      i = lo;
    }
    while (i < list.length - 2 && cum[i + 1] - cum[i] < 1e-12) i++;
    while (i > 0 && cum[i + 1] - cum[i] < 1e-12) i--;
    const seg = cum[i + 1] - cum[i] || 1;
    const u = (s - cum[i]) / seg;
    return { x: list[i].x + (list[i + 1].x - list[i].x) * u, y: list[i].y + (list[i + 1].y - list[i].y) * u };
  };
  return { length, at };
}

function xRange(g: Glyph): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (const l of g.loops) for (const q of l) { if (q.x < lo) lo = q.x; if (q.x > hi) hi = q.x; }
  return lo === Infinity ? null : [lo, hi];
}

/**
 * Buchstaben setzen. Die Glyphen liegen mit ihrem Abstand zueinander wie im geraden Schriftzug vor (x wächst);
 * ihre Mitte wandert auf den Pfad, spacing kommt pro Zeichen dazu (auch für Leerzeichen).
 */
export function layoutOnPath(glyphs: Glyph[], path: P[], closed: boolean, o: OnPathOptions): OnPathResult {
  const w = pathWalker(path, closed);
  const ranges = glyphs.map(xRange);
  const used = ranges.filter(Boolean) as [number, number][];
  const out: OnPathResult = { loops: [], textLength: 0, pathLength: w.length, overflow: false };
  if (!used.length || w.length <= 0) return out;
  const first = Math.min(...used.map(r => r[0])), last = Math.max(...used.map(r => r[1]));
  const lastIndex = ranges.reduce((n, r, i) => (r ? i : n), 0);
  const firstIndex = ranges.findIndex(Boolean);
  const textLength = last - first + o.spacing * (lastIndex - firstIndex);
  out.textLength = textLength;
  const startAt = o.offset - (o.anchor === "center" ? textLength / 2 : o.anchor === "end" ? textLength : 0);
  const lift = o.side === "above" ? o.distance - o.baseline : -o.distance - o.capHeight - o.baseline;

  glyphs.forEach((g, i) => {
    const r = ranges[i];
    if (!r) return;
    const mid = (r[0] + r[1]) / 2;
    const s = startAt + (mid - first) + o.spacing * (i - firstIndex);
    const half = Math.max((r[1] - r[0]) / 2, 1e-6);
    const c = w.at(s), a = w.at(s - half), b = w.at(s + half);
    let tx = b.x - a.x, ty = b.y - a.y;
    const n = Math.hypot(tx, ty);
    if (n < 1e-9) { tx = 1; ty = 0; } else { tx /= n; ty /= n; }
    g.loops.forEach((loop, k) => {
      out.loops.push({
        closed: g.closed?.[k] ?? true,
        pts: loop.map(q => {
          const dx = q.x - mid, dy = q.y + lift;
          return { x: c.x + tx * dx - ty * dy, y: c.y + ty * dx + tx * dy };
        })
      });
    });
  });
  out.overflow = closed ? textLength > w.length : startAt < -1e-6 || startAt + textLength > w.length + 1e-6;
  return out;
}
