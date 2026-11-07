/**
 * PERFORATION und VERTEILEN AUF EINER STRECKE: nur Geometrie.
 */
export interface Pp { x: number; y: number }

/** Strecke in Schnitt und Lücke zerlegen. Geschlossene Pfade: der Abstand wird angeglichen, damit das Muster aufgeht */
export function perforate(pts: Pp[], closed: boolean, cut: number, gap: number): Pp[][] {
  const list = closed && pts.length > 2 ? [...pts, pts[0]] : pts;
  const cum: number[] = [0];
  for (let i = 1; i < list.length; i++) cum.push(cum[i - 1] + Math.hypot(list[i].x - list[i - 1].x, list[i].y - list[i - 1].y));
  const total = cum[cum.length - 1];
  if (!(cut > 0) || !(gap > 0) || !(total > 0)) return [list.slice()];
  let c = cut, g = gap;
  if (closed) {
    const n = Math.max(1, Math.round(total / (cut + gap)));
    const k = total / (n * (cut + gap));
    c = cut * k; g = gap * k;
  } else if (total > cut) {
    // offen: beide Enden werden geschnitten
    const n = Math.max(1, Math.round((total + gap) / (cut + gap)));
    g = n > 1 ? (total - n * cut) / (n - 1) : gap;
    if (g <= 0) return [list.slice()];
  }
  const at = (s: number): Pp => {
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const u = cum[hi] > cum[lo] ? (s - cum[lo]) / (cum[hi] - cum[lo]) : 0;
    return { x: list[lo].x + (list[hi].x - list[lo].x) * u, y: list[lo].y + (list[hi].y - list[lo].y) * u };
  };
  const out: Pp[][] = [];
  for (let s = 0; s < total - 1e-9; s += c + g) {
    const e = Math.min(total, s + c);
    const piece: Pp[] = [at(s)];
    for (let i = 0; i < list.length; i++) if (cum[i] > s + 1e-9 && cum[i] < e - 1e-9) piece.push(list[i]);
    piece.push(at(e));
    out.push(piece);
  }
  return out;
}

export interface PathSpot { x: number; y: number; angle: number }

/** Gleichmäßig verteilte Stellen auf einer Strecke, mit Richtung. Offen: von Anfang bis Ende, geschlossen: rundum */
export function spotsOnPath(pts: Pp[], closed: boolean, count: number): PathSpot[] {
  const list = closed && pts.length > 2 ? [...pts, pts[0]] : pts;
  const cum: number[] = [0];
  for (let i = 1; i < list.length; i++) cum.push(cum[i - 1] + Math.hypot(list[i].x - list[i - 1].x, list[i].y - list[i - 1].y));
  const total = cum[cum.length - 1];
  if (!(total > 0) || count < 1) return [];
  const out: PathSpot[] = [];
  const step = closed ? total / count : count > 1 ? total / (count - 1) : 0;
  for (let n = 0; n < count; n++) {
    const s = Math.min(total, n * step);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    // Abschnitte ohne Länge überspringen, sonst gäbe es keine Richtung
    while (hi < list.length - 1 && cum[hi] - cum[lo] < 1e-9) hi++;
    while (lo > 0 && cum[hi] - cum[lo] < 1e-9) lo--;
    const u = cum[hi] > cum[lo] ? (s - cum[lo]) / (cum[hi] - cum[lo]) : 0;
    out.push({ x: list[lo].x + (list[hi].x - list[lo].x) * u, y: list[lo].y + (list[hi].y - list[lo].y) * u, angle: Math.atan2(list[hi].y - list[lo].y, list[hi].x - list[lo].x) });
  }
  return out;
}
