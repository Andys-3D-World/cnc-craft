/**
 * ISOLATIONSBAHNEN – reine Rechnung, Tests in tests/pcb.test.ts
 *
 * Alle Kupferflächen werden als ABSTANDSFELD auf ein feines Raster gebracht: jeder Rasterpunkt kennt seinen genauen Abstand
 * zum Kupfer (negativ = im Kupfer). Die Mitte des Fräsers fährt auf der Höhenlinie „Abstand = halbe Schnittbreite“.
 * Das ist unempfindlich gegen Überlappungen, doppelte Linien und Lötflächen, die in Leiterbahnen liegen, und kann auch
 * Flächen mit Aussparungen (helle Polarität). Zwischen den Rasterpunkten wird gerade interpoliert: an geraden Kanten
 * genau, an scharfen Innenecken um höchstens etwa eine Rasterweite gerundet.
 *
 * Prüfung: Liegen zwei Netze enger beisammen als die Schnittbreite, passt der Fräser nicht dazwischen – sie blieben
 * verbunden. Das wird gemeldet (Stelle und Abstand), nie still hingenommen.
 */
import type { GObj, Pt2, FlashPart } from "./gerber.ts";
import { simplifyPolygon, type P } from "../polyOffset.ts";

export interface Grid { x0: number; y0: number; h: number; nx: number; ny: number; f: Float32Array; cap: number }

const MAX_NODES = 9_000_000;

/** Rasterweite: fein, aber nie mehr Punkte als erlaubt */
export function gridStep(w: number, hgt: number, want = 0.04): number {
  return Math.max(want, Math.sqrt((w * hgt) / MAX_NODES));
}

export function makeGrid(x0: number, y0: number, x1: number, y1: number, h: number, cap: number): Grid {
  const nx = Math.max(3, Math.ceil((x1 - x0) / h) + 1), ny = Math.max(3, Math.ceil((y1 - y0) / h) + 1);
  const f = new Float32Array(nx * ny); f.fill(cap);
  return { x0, y0, h, nx, ny, f, cap };
}

/** Abstand zu einer Strecke in alle Punkte eintragen, die näher als R sind: put(Index, Abstand²) */
function splat(g: Grid, ax: number, ay: number, bx: number, by: number, R: number, put: (k: number, d2: number) => void) {
  const { x0, y0, h, nx, ny } = g;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, R2 = R * R;
  const j0 = Math.max(0, Math.ceil((Math.min(ay, by) - R - y0) / h)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) + R - y0) / h));
  for (let j = j0; j <= j1; j++) {
    const y = y0 + j * h;
    // Teil der Strecke, der in dieser Zeile überhaupt nah genug ist
    let t0 = 0, t1 = 1;
    if (Math.abs(dy) > 1e-12) { const a = (y - R - ay) / dy, b = (y + R - ay) / dy; t0 = Math.max(0, Math.min(a, b)); t1 = Math.min(1, Math.max(a, b)); if (t0 > t1) continue; }
    const xa = ax + dx * t0, xb = ax + dx * t1;
    const i0 = Math.max(0, Math.ceil((Math.min(xa, xb) - R - x0) / h)), i1 = Math.min(nx - 1, Math.floor((Math.max(xa, xb) + R - x0) / h));
    for (let i = i0; i <= i1; i++) {
      const x = x0 + i * h;
      let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - ax - t * dx, ey = y - ay - t * dy, d2 = ex * ex + ey * ey;
      if (d2 < R2) put(j * nx + i, d2);
    }
  }
}

/** Ausschnitt des Rasters mit dem Abstand zu einem Vieleck (innen negativ) */
function polyField(g: Grid, pts: Pt2[]): Grid | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const s = sub(g, x0 - g.cap, y0 - g.cap, x1 + g.cap, y1 + g.cap);
  if (!s) return null;
  const n = pts.length;
  for (let k = 0; k < n; k++) { const a = pts[k], b = pts[(k + 1) % n]; splat(s, a[0], a[1], b[0], b[1], g.cap, (q, d2) => { if (d2 < s.f[q] * s.f[q]) s.f[q] = Math.sqrt(d2); }); }
  // innen: ungerade Zahl von Kanten links davon
  const xs: number[] = [];
  for (let j = 0; j < s.ny; j++) {
    const y = s.y0 + j * s.h;
    xs.length = 0;
    for (let k = 0; k < n; k++) { const a = pts[k], b = pts[(k + 1) % n]; if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0])); }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - s.x0) / s.h)), i1 = Math.min(s.nx - 1, Math.floor((xs[k + 1] - s.x0) / s.h));
      for (let i = i0; i <= i1; i++) { const q = j * s.nx + i; s.f[q] = -Math.max(1e-6, Math.abs(s.f[q])); }
    }
  }
  return s;
}

/** Teil-Raster auf denselben Punkten */
function sub(g: Grid, x0: number, y0: number, x1: number, y1: number): (Grid & { i0: number; j0: number }) | null {
  const i0 = Math.max(0, Math.floor((x0 - g.x0) / g.h)), j0 = Math.max(0, Math.floor((y0 - g.y0) / g.h));
  const i1 = Math.min(g.nx - 1, Math.ceil((x1 - g.x0) / g.h)), j1 = Math.min(g.ny - 1, Math.ceil((y1 - g.y0) / g.h));
  if (i1 < i0 || j1 < j0) return null;
  const nx = i1 - i0 + 1, ny = j1 - j0 + 1, f = new Float32Array(nx * ny);
  f.fill(g.cap);
  return { x0: g.x0 + i0 * g.h, y0: g.y0 + j0 * g.h, h: g.h, nx, ny, f, cap: g.cap, i0, j0 };
}
function each(g: Grid, s: Grid, fn: (k: number, v: number) => void) {
  const i0 = Math.round((s.x0 - g.x0) / g.h), j0 = Math.round((s.y0 - g.y0) / g.h);
  for (let j = 0; j < s.ny; j++) for (let i = 0, k = (j + j0) * g.nx + i0, q = j * s.nx; i < s.nx; i++, k++, q++) fn(k, s.f[q]);
}
function circleField(g: Grid, c: [number, number, number], put: (k: number, d: number) => void) {
  const R = c[2] + g.cap;
  splat(g, c[0], c[1], c[0], c[1], R, (k, d2) => put(k, Math.sqrt(d2) - c[2]));
}

/** Flächen in Zeichen-Reihenfolge eintragen. Rückgabe: wurde irgendwo etwas gelöscht? */
export function addObjects(g: Grid, objs: GObj[]): boolean {
  const f = g.f;
  let cleared = false;
  for (const o of objs) {
    const put = o.dark ? (k: number, d: number) => { if (d < f[k]) f[k] = d; } : (k: number, d: number) => { if (-d > f[k]) f[k] = -d; };
    if (!o.dark) cleared = true;
    if (o.k === "stroke") splat(g, o.a[0], o.a[1], o.b[0], o.b[1], o.r + g.cap, (k, d2) => put(k, Math.sqrt(d2) - o.r));
    else if (o.k === "poly") { const s = polyField(g, o.p); if (s) each(g, s, put); }
    else if (o.parts.every(p => p.on)) for (const p of o.parts) part(g, p, put);
    else {
      // Blende mit Aussparung: erst für sich zusammensetzen
      cleared = true;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of o.parts) if (p.on) for (const [x, y, r] of "c" in p ? [p.c] : p.p.map(q => [q[0], q[1], 0])) { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); }
      const s = sub(g, x0 - g.cap, y0 - g.cap, x1 + g.cap, y1 + g.cap);
      if (!s) continue;
      for (const p of o.parts) part(s, p, p.on ? (k, d) => { if (d < s.f[k]) s.f[k] = d; } : (k, d) => { if (-d > s.f[k]) s.f[k] = -d; });
      each(g, s, put);
    }
  }
  return cleared;
}
function part(g: Grid, p: FlashPart, put: (k: number, d: number) => void) {
  if ("c" in p) circleField(g, p.c, put);
  else { const s = polyField(g, p.p); if (s) each(g, s, put); }
}

/** Nach Löschungen stimmt das Vorzeichen, aber nicht jeder Abstand: neu messen – zum Umriss */
export function redistance(g: Grid): void {
  const loops = contours(g, 0, 0);
  const d = new Float32Array(g.f.length);
  d.fill(g.cap);
  for (const l of loops) for (let i = 0; i < l.length; i++) { const a = l[i], b = l[(i + 1) % l.length]; splat(g, a.x, a.y, b.x, b.y, g.cap, (k, d2) => { if (d2 < d[k] * d[k]) d[k] = Math.sqrt(d2); }); }
  for (let k = 0; k < d.length; k++) g.f[k] = g.f[k] < 0 ? -d[k] : d[k];
}

/** Höhenlinie „Abstand = level“ als geschlossene Linien (gegen den Uhrzeigersinn um das Kupfer). tol = Vereinfachen */
export function contours(g: Grid, level: number, tol = g.h * 0.06): P[][] {
  const { nx, ny, h, x0, y0, f } = g;
  const next = new Map<number, number>();
  const pos = new Map<number, P>();
  const V = (i: number, j: number) => (i <= 0 || j <= 0 || i >= nx - 1 || j >= ny - 1 ? Math.max(f[j * nx + i], level + h * 0.5) : f[j * nx + i]) - level;
  // Kante: waagerecht (i,j)-(i+1,j) = 2·k, senkrecht (i,j)-(i,j+1) = 2·k+1
  const edge = (i: number, j: number, vert: boolean, a: number, b: number): number => {
    const id = 2 * (j * nx + i) + (vert ? 1 : 0);
    if (!pos.has(id)) { const t = a / (a - b); pos.set(id, vert ? { x: x0 + i * h, y: y0 + (j + t) * h } : { x: x0 + (i + t) * h, y: y0 + j * h }); }
    return id;
  };
  for (let j = 0; j < ny - 1; j++) {
    // Zeilen ohne Wechsel schnell überspringen
    for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i;
      const q = f[k] < level, r = f[k + 1] < level, s = f[k + nx + 1] < level, u = f[k + nx] < level;
      if (q === r && r === s && s === u && i > 0 && j > 0 && i < nx - 2 && j < ny - 2) continue;
      const a = V(i, j), b = V(i + 1, j), c = V(i + 1, j + 1), d = V(i, j + 1);
      const code = (a < 0 ? 1 : 0) | (b < 0 ? 2 : 0) | (c < 0 ? 4 : 0) | (d < 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const B = () => edge(i, j, false, a, b), Rr = () => edge(i + 1, j, true, b, c), T = () => edge(i, j + 1, false, d, c), Ll = () => edge(i, j, true, a, d);
      // innen liegt links der Laufrichtung
      const seg = (from: number, to: number) => { next.set(from, to); };
      switch (code) {
        case 1: seg(B(), Ll()); break;
        case 2: seg(Rr(), B()); break;
        case 3: seg(Rr(), Ll()); break;
        case 4: seg(T(), Rr()); break;
        case 6: seg(T(), B()); break;
        case 7: seg(T(), Ll()); break;
        case 8: seg(Ll(), T()); break;
        case 9: seg(B(), T()); break;
        case 11: seg(Rr(), T()); break;
        case 12: seg(Ll(), Rr()); break;
        case 13: seg(B(), Rr()); break;
        case 14: seg(Ll(), B()); break;
        case 5: if (a + b + c + d < 0) { seg(B(), Rr()); seg(T(), Ll()); } else { seg(B(), Ll()); seg(T(), Rr()); } break;
        case 10: if (a + b + c + d < 0) { seg(Ll(), B()); seg(Rr(), T()); } else { seg(Rr(), B()); seg(Ll(), T()); } break;
      }
    }
  }
  const out: P[][] = [];
  while (next.size) {
    const start = next.keys().next().value as number;
    const loop: P[] = [];
    let cur: number | undefined = start;
    while (cur !== undefined && next.has(cur)) { loop.push(pos.get(cur)!); const n: number = next.get(cur)!; next.delete(cur); cur = n; if (cur === start) break; }
    const clean = loop.filter((p, i) => { const o = loop[(i + loop.length - 1) % loop.length]; return Math.hypot(p.x - o.x, p.y - o.y) > 1e-7; });
    if (clean.length >= 3) out.push(tol > 0 ? simplifyPolygon(clean, tol) : clean);
  }
  return out;
}

/** Zusammenhängende Kupferflächen nummerieren (1…n), 0 = kein Kupfer */
export function nets(g: Grid): { label: Int32Array; n: number } {
  const { nx, ny, f } = g, label = new Int32Array(nx * ny);
  let n = 0;
  const stack: number[] = [];
  for (let k = 0; k < f.length; k++) {
    if (label[k] || f[k] > 0) continue;
    n++; label[k] = n; stack.push(k);
    while (stack.length) {
      const q = stack.pop()!, i = q % nx;
      for (const r of [i > 0 ? q - 1 : -1, i < nx - 1 ? q + 1 : -1, q - nx, q + nx]) if (r >= 0 && r < f.length && !label[r] && f[r] <= 0) { label[r] = n; stack.push(r); }
    }
  }
  return { label, n };
}

export interface Bridge { x: number; y: number; gap: number }
/**
 * Stellen, an denen zwei Netze enger als 2·d beisammen liegen. Von jedem Netz aus wird in der Reihenfolge des Abstands
 * gewachsen; wo zwei Netze zusammenstoßen, ist die Lücke die Summe beider Abstände (plus der Schritt dazwischen).
 */
export function bridges(g: Grid, d: number): { list: Bridge[]; nets: number } {
  const { nx, f } = g, { label, n } = nets(g);
  // Eimer nach Abstand: damit wächst jedes Netz gleichmäßig und trifft das andere in der Mitte
  const B = Math.max(1, Math.ceil(d / g.h * 4)) + 1, buckets: number[][] = Array.from({ length: B }, () => []);
  const bucket = (k: number, min: number) => Math.max(min, Math.min(B - 1, Math.floor(Math.max(0, f[k]) / d * (B - 1))));
  const own = label;
  const pairs = new Map<string, { gap: number; k: number }>();
  const nb = (q: number) => { const i = q % nx; return [i > 0 ? q - 1 : -1, i < nx - 1 ? q + 1 : -1, q - nx, q + nx]; };
  // Start: die Kupferpunkte am Rand ihres Netzes
  for (let k = 0; k < f.length; k++) if (own[k] && nb(k).some(r => r >= 0 && r < f.length && !own[r])) buckets[0].push(k);
  for (let b = 0; b < B; b++) for (let q = 0; q < buckets[b].length; q++) {
    const k = buckets[b][q];
    for (const r of nb(k)) {
      if (r < 0 || r >= f.length) continue;
      if (!own[r]) { if (f[r] < d) { own[r] = own[k]; buckets[bucket(r, b)].push(r); } }
      else if (own[r] !== own[k]) {
        const key = own[k] < own[r] ? `${own[k]},${own[r]}` : `${own[r]},${own[k]}`, gap = Math.max(0, f[k]) + Math.max(0, f[r]) + g.h, old = pairs.get(key);
        if (!old || gap < old.gap) pairs.set(key, { gap, k });
      }
    }
  }
  return { list: [...pairs.values()].map(p => ({ x: g.x0 + (p.k % nx) * g.h, y: g.y0 + Math.floor(p.k / nx) * g.h, gap: p.gap })).sort((a, b) => a.gap - b.gap), nets: n };
}

export interface IsoJob { objs: GObj[]; box: { x0: number; y0: number; x1: number; y1: number }; width: number; passes: number; overlap: number; step?: number }
export interface IsoLine { pts: P[]; closed: boolean; pass: number }
export interface IsoResult { copper: P[][]; lines: IsoLine[]; bridges: Bridge[]; nets: number; h: number; minGap: number }

/** Abstände der Fräser-Mitte je Durchgang */
export function passLevels(width: number, passes: number, overlap: number): number[] {
  const step = width * (1 - Math.max(0, Math.min(0.9, overlap)));
  return Array.from({ length: Math.max(1, Math.min(40, Math.round(passes))) }, (_, k) => width / 2 + k * step);
}

/** Alles rechnen. box = Platine (danach wird ab dem 2. Durchgang beschnitten) */
export function isolate(job: IsoJob): IsoResult {
  const lv = passLevels(job.width, job.passes, job.overlap);
  const last = lv[lv.length - 1];
  const b = job.box;
  const h0 = gridStep(b.x1 - b.x0 + 2 * last, b.y1 - b.y0 + 2 * last, job.step ?? Math.max(0.02, Math.min(0.04, job.width / 4)));
  const cap = Math.max(last, job.width) + 3 * h0, m = cap + 2 * h0;
  const h = gridStep(b.x1 - b.x0 + 2 * m, b.y1 - b.y0 + 2 * m, h0);
  const g = makeGrid(b.x0 - m, b.y0 - m, b.x1 + m, b.y1 + m, h, cap);
  if (addObjects(g, job.objs)) redistance(g);
  const copper = contours(g, 0);
  const lines: IsoLine[] = [];
  const keep = { x0: b.x0 - job.width, y0: b.y0 - job.width, x1: b.x1 + job.width, y1: b.y1 + job.width };
  lv.forEach((d, pass) => {
    for (const l of contours(g, d)) {
      if (pass === 0) lines.push({ pts: l, closed: true, pass });
      else for (const r of clipLoop(l, keep)) lines.push({ ...r, pass });
    }
  });
  const br = bridges(g, lv[0]);
  // Rasterfehler: eine Lücke, die nur einen halben Rasterpunkt zu klein ist, ist keine
  const list = br.list.filter(x => x.gap < job.width - h * 0.25);
  return { copper, lines, bridges: list, nets: br.nets, h, minGap: list.length ? list[0].gap : Infinity };
}

/** Stücke einer geschlossenen Linie im Rechteck */
export function clipLoop(l: P[], b: { x0: number; y0: number; x1: number; y1: number }): { pts: P[]; closed: boolean }[] {
  const inside = (p: P) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
  if (l.every(inside)) return [{ pts: l, closed: true }];
  const first = l.findIndex(p => !inside(p));
  const r = [...l.slice(first), ...l.slice(0, first + 1)];
  const out: { pts: P[]; closed: boolean }[] = [];
  let cur: P[] = [];
  for (let i = 0; i + 1 < r.length; i++) {
    const a = r[i], c = r[i + 1], dx = c.x - a.x, dy = c.y - a.y;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, a.x - b.x0], [dx, b.x1 - a.x], [-dy, a.y - b.y0], [dy, b.y1 - a.y]]) {
      if (Math.abs(p) < 1e-12) { if (q < 0) ok = false; continue; }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    if (!ok || t0 >= t1) { if (cur.length > 1) out.push({ pts: cur, closed: false }); cur = []; continue; }
    if (!cur.length || t0 > 0) { if (cur.length > 1) out.push({ pts: cur, closed: false }); cur = [{ x: a.x + dx * t0, y: a.y + dy * t0 }]; }
    cur.push({ x: a.x + dx * t1, y: a.y + dy * t1 });
    if (t1 < 1) { if (cur.length > 1) out.push({ pts: cur, closed: false }); cur = []; }
  }
  if (cur.length > 1) out.push({ pts: cur, closed: false });
  return out;
}

/** Breite der Nut, die ein V-Stichel in dieser Tiefe schneidet (Schaftfräser: sein Ø) */
export function cutWidth(tool: { type: string; diameter: number; angle: number; tipDia: number }, depth: number): number {
  if (tool.type === "vbit" || tool.type === "chamfer" || tool.type === "countersink") return Math.min(tool.diameter, Math.max(0, tool.tipDia) + 2 * Math.abs(depth) * Math.tan(Math.max(1, Math.min(170, tool.angle)) * Math.PI / 360));
  return tool.diameter;
}
