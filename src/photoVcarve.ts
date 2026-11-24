/**
 * FOTO MIT DEM V-STICHEL – reine Rechnung, Tests in tests/millPack.test.ts
 *
 * Das Bild wird mit parallelen Linien im festen Abstand graviert. Je dunkler eine Stelle, desto tiefer – und damit
 * breiter – schneidet der V-Stichel dort: Nutbreite = Abstand × Dunkelheit, Tiefe = (Breite − Spitze) / (2 · tan(halber Winkel)).
 * Helle Stellen (Nut schmaler als die halbe Spitze) werden ausgelassen: der Fräser fährt dort oben.
 * Nie tiefer als maxDepth und nie tiefer als der Kegel hoch ist.
 */
export interface PhotoOpts {
  x0: number; y0: number; w: number; h: number; // Lage und Größe auf dem Bett (mm)
  spacing: number;   // Abstand der Linien (mm)
  angle: number;     // Spitzenwinkel des V-Stichels (ganz)
  tipDia: number; toolDia: number;
  maxDepth: number;  // größte Tiefe (mm)
  stepDown: number;  // Zustellung je Durchgang (mm)
  lines: number;     // Winkel der Linien in Grad (0 = waagerecht)
}

export interface PhotoPt { x: number; y: number; d: number } // d = Tiefe (positiv)
export interface PhotoPlan {
  /** je Linie die zusammenhängenden Stücke, abwechselnd hin und zurück */
  segs: PhotoPt[][];
  deepest: number;
  /** Anteil der Fläche, an dem die dunkelste gewünschte Nut breiter wäre, als die größte Tiefe erlaubt */
  clipped: number;
  lines: number;
}

/** Höhe des Kegels: tiefer kann der Stichel keine V-Nut schneiden */
export function coneDepth(o: Pick<PhotoOpts, "angle" | "tipDia" | "toolDia">): number {
  return Math.max(0, (o.toolDia - o.tipDia) / 2 / Math.tan(half(o.angle)));
}
const half = (angle: number) => Math.max(10, Math.min(170, angle)) / 2 * Math.PI / 180;

/** Tiefe, bei der eine Nut mit der Breite w entsteht; 0 = hier nicht schneiden */
export function depthForWidth(w: number, o: Pick<PhotoOpts, "angle" | "tipDia">): number {
  const tip = Math.max(0, o.tipDia);
  if (w < Math.max(tip / 2, 0.02)) return 0;
  return Math.max(0.02, (w - tip) / 2 / Math.tan(half(o.angle)));
}
/** Breite der Nut bei dieser Tiefe */
export function widthAtDepth(d: number, o: Pick<PhotoOpts, "angle" | "tipDia">): number {
  return d > 0 ? Math.max(0, o.tipDia) + 2 * d * Math.tan(half(o.angle)) : 0;
}

/** mehr Punkte als das werden nicht gerechnet (riesige Datei) */
const MAX_POINTS = 3_000_000;

/** Wie fein entlang der Linie abgetastet wird (mm) */
export const sampleStep = (spacing: number) => Math.max(0.05, Math.min(0.3, spacing / 3));

/** Punkte einer Linie zu groß für einen Job? (Vorschau auf die Menge, ohne zu rechnen) */
export function tooMuch(o: Pick<PhotoOpts, "w" | "h" | "spacing">): boolean {
  return !(o.spacing > 0) || o.w * o.h / (o.spacing * sampleStep(o.spacing)) > MAX_POINTS;
}

/** dark(u, v) = Dunkelheit 0…1 an der Stelle u (von links) und v (von unten) in mm */
export function photoPlan(dark: (u: number, v: number) => number, o: PhotoOpts): PhotoPlan {
  const a = o.lines * Math.PI / 180, ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
  const limit = Math.min(o.maxDepth, coneDepth(o));
  const segs: PhotoPt[][] = [];
  let deepest = 0, over = 0, all = 0, count = 0;
  // Bereich der Linien: Ecken des Bildes auf die Querrichtung
  const cs = [[0, 0], [o.w, 0], [0, o.h], [o.w, o.h]].map(([x, y]) => x * nx + y * ny);
  const lo = Math.min(...cs), hi = Math.max(...cs);
  const n = Math.max(1, Math.floor((hi - lo) / o.spacing + 1e-9));
  const rest = (hi - lo - (n - 1) * o.spacing) / 2;
  for (let k = 0; k < n; k++) {
    const c = lo + rest + k * o.spacing;
    // Linie p = c·n + s·u auf das Rechteck schneiden
    let s0 = -Infinity, s1 = Infinity, ok = true;
    for (const [p, d, size] of [[c * nx, ux, o.w], [c * ny, uy, o.h]] as const) {
      if (Math.abs(d) < 1e-9) { if (p < -1e-9 || p > size + 1e-9) ok = false; continue; }
      const t0 = -p / d, t1 = (size - p) / d;
      s0 = Math.max(s0, Math.min(t0, t1)); s1 = Math.min(s1, Math.max(t0, t1));
    }
    if (!ok || !(s1 - s0 > 1e-6)) continue;
    count++;
    const m = Math.max(1, Math.ceil((s1 - s0) / sampleStep(o.spacing)));
    const line: PhotoPt[] = [];
    for (let i = 0; i <= m; i++) {
      const s = s0 + (s1 - s0) * i / m, x = c * nx + s * ux, y = c * ny + s * uy;
      const want = depthForWidth(o.spacing * Math.max(0, Math.min(1, dark(x, y))), o);
      if (want > limit + 1e-9) over++;
      all++;
      line.push({ x: o.x0 + x, y: o.y0 + y, d: Math.min(want, limit) });
    }
    const parts = cutParts(line, 0);
    if (count % 2 === 0) { parts.reverse(); parts.forEach(p => p.reverse()); }
    for (const p of parts) { const t = thin(p); for (const q of t) deepest = Math.max(deepest, q.d); segs.push(t); }
  }
  return { segs, deepest, clipped: all ? over / all : 0, lines: count };
}

/** Stücke einer Linie, die tiefer als `above` sind; Übergänge genau zwischen den Stützstellen (Punkt auf der Höhe `above`) */
function cutParts(line: PhotoPt[], above: number): PhotoPt[][] {
  const out: PhotoPt[][] = [];
  let cur: PhotoPt[] = [];
  const mix = (a: PhotoPt, b: PhotoPt): PhotoPt => { const f = (above - a.d) / (b.d - a.d); return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, d: above }; };
  for (let i = 0; i < line.length; i++) {
    const p = line[i], q = line[i + 1];
    if (p.d > above) {
      cur.push(p);
      if (!q || q.d <= above) { if (q) cur.push(mix(p, q)); out.push(cur); cur = []; }
    } else if (q && q.d > above) cur = [mix(p, q)];
  }
  return out.filter(s => s.length > 1);
}

/** Punkte weglassen, die auf der Geraden im Raum liegen (Tiefe weicht weniger als 0,01 mm ab) */
function thin(p: PhotoPt[]): PhotoPt[] {
  if (p.length < 3) return p;
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack: [number, number][] = [[0, p.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const len = Math.hypot(p[j].x - p[i].x, p[j].y - p[i].y) || 1;
    let worst = 0.01, at = -1;
    for (let k = i + 1; k < j; k++) {
      const f = Math.hypot(p[k].x - p[i].x, p[k].y - p[i].y) / len;
      const e = Math.abs(p[i].d + (p[j].d - p[i].d) * f - p[k].d);
      if (e > worst) { worst = e; at = k; }
    }
    if (at > 0) { keep[at] = 1; stack.push([i, at], [at, j]); }
  }
  return p.filter((_, i) => keep[i]);
}

/** G-Code-Zeilen: durchgangsweise; in jedem Durchgang nur, was tiefer liegt als der vorige */
export function photoLines(plan: PhotoPlan, o: PhotoOpts, feed: number, plunge: number, safeZ: number): { lines: string[]; cut: number; air: number } {
  const f = (v: number) => v.toFixed(3);
  const lines: string[] = [];
  const clear = Math.min(safeZ, 1.5);
  let cut = 0, air = 0, lx = 0, ly = 0;
  const step = Math.max(0.05, o.stepDown);
  const passes = Math.max(1, Math.ceil(plan.deepest / step - 1e-6));
  for (let k = 0; k < passes; k++) {
    const above = k * step, floor = k === passes - 1 ? Infinity : (k + 1) * step;
    if (k > 0) lines.push(`G0 Z${f(safeZ)}`);
    for (const seg of plan.segs) {
      for (const part of k === 0 ? [seg] : cutParts(seg, above)) {
        const pts = clampPart(part, floor), a = pts[0];
        lines.push(`G0 X${f(a.x)} Y${f(a.y)}`, `G1 Z${f(-a.d)} F${plunge}`);
        air += Math.hypot(a.x - lx, a.y - ly);
        for (let i = 1; i < pts.length; i++) {
          lines.push(`G1 X${f(pts[i].x)} Y${f(pts[i].y)} Z${f(-pts[i].d)}${i === 1 ? ` F${feed}` : ""}`);
          cut += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        }
        lines.push(`G0 Z${f(clear)}`);
        lx = pts[pts.length - 1].x; ly = pts[pts.length - 1].y;
      }
    }
  }
  lines.push(`G0 Z${f(safeZ)}`);
  return { lines, cut, air };
}

/** Tiefe auf floor begrenzen; wo die Kurve floor kreuzt, kommt ein Punkt dazu (sonst schnitte der Durchgang Schrägen falsch) */
function clampPart(p: PhotoPt[], floor: number): PhotoPt[] {
  if (!Number.isFinite(floor)) return p;
  const out: PhotoPt[] = [];
  p.forEach((a, i) => {
    out.push({ ...a, d: Math.min(a.d, floor) });
    const b = p[i + 1];
    if (b && (a.d - floor) * (b.d - floor) < 0) { const t = (floor - a.d) / (b.d - a.d); out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, d: floor }); }
  });
  return out;
}
