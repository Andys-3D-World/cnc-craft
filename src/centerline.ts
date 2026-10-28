/**
 * MITTELLINIE (Centerline) AUS EINEM BILD – Handschrift, Skizzen, Strichzeichnungen
 *
 * Statt des Umrisses einer Linie (zwei Konturen links und rechts) entsteht EINE Linie in ihrer Mitte –
 * zum Gravieren mit dem Laser („Linie“) oder mit dem V-Stichel / Fräser „auf der Linie“.
 *   1. Maske: 1 = Strich (dunkel), 0 = Hintergrund
 *   2. Ausdünnen nach Zhang-Suen, bis jeder Strich nur noch 1 Pixel breit ist
 *   3. Gerippe in Linien zerlegen: von Enden und Kreuzungen aus den Pixeln folgen; übrig bleibende Ringe als geschlossene Linien
 *   4. kurze Stummel (Sporne an Kreuzungen, Pixelrauschen) weglassen, Linien vereinfachen (Douglas-Peucker)
 * Keine Abhängigkeiten (Tests: `npm test`). Koordinaten in Pixeln, y nach unten.
 */

export type Pt = { x: number; y: number };
export interface CenterPath { pts: Pt[]; closed: boolean }

/** Zhang-Suen-Ausdünnung (ändert die Maske an Ort und Stelle) */
export function thin(m: Uint8Array, W: number, H: number): Uint8Array {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : m[y * W + x]);
  const del: number[] = [];
  for (let changed = true, guard = 0; changed && guard < 500; guard++) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!m[y * W + x]) continue;
        // Nachbarn P2…P9 im Uhrzeigersinn ab oben
        const p = [at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1)];
        const b = p.reduce((s, v) => s + v, 0);
        if (b < 2 || b > 6) continue;
        let a = 0;
        for (let i = 0; i < 8; i++) if (!p[i] && p[(i + 1) % 8]) a++;
        if (a !== 1) continue;
        if (step === 0 ? (p[0] && p[2] && p[4]) || (p[2] && p[4] && p[6]) : (p[0] && p[2] && p[6]) || (p[0] && p[4] && p[6])) continue;
        del.push(y * W + x);
      }
      for (const i of del) m[i] = 0;
      if (del.length) changed = true;
    }
  }
  return m;
}

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/**
 * Gerippe (1 Pixel breit) → Linien.
 * Art jedes Pixels über die Übergangszahl (0→1-Wechsel rund herum): 1 = Ende, 2 = Linie, ≥ 3 = Kreuzung.
 * (Die Zahl der Nachbarn taugt nicht – an Treppenstufen schräger Linien hat ein Pixel oft 3 Nachbarn.)
 * Nachgefahren wird Pixel für Pixel, gerade Nachbarn zuerst; Kreuzungen beenden eine Linie und dürfen von
 * mehreren Linien erreicht werden. Was übrig bleibt, sind Ringe.
 */
export function traceSkeleton(m: Uint8Array, W: number, H: number): CenterPath[] {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && m[y * W + x] === 1;
  const RING = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  const cross = (x: number, y: number) => {
    let a = 0, b = 0;
    for (let i = 0; i < 8; i++) {
      if (on(x + RING[i][0], y + RING[i][1])) b++;
      if (!on(x + RING[i][0], y + RING[i][1]) && on(x + RING[(i + 1) % 8][0], y + RING[(i + 1) % 8][1])) a++;
    }
    return { a, b };
  };
  // Treppenstufen wegräumen: ein Pixel, dessen Nachbarn einen zusammenhängenden Bogen bilden (a = 1) und das kein
  // Ende ist (b ≥ 2), verbindet nichts – ohne ihn hängt alles weiter zusammen. Sonst hielte man es für ein Ende.
  for (let changed = true, guard = 0; changed && guard < 20; guard++) {
    changed = false;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!on(x, y)) continue;
      const { a, b } = cross(x, y);
      if (a === 1 && b >= 2) { m[y * W + x] = 0; changed = true; }
    }
  }
  const kind = new Uint8Array(W * H); // 0 = leer, 1 = Ende, 2 = Linie, 3 = Kreuzung
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!on(x, y)) continue;
    const { a, b } = cross(x, y);
    kind[y * W + x] = b <= 1 ? 1 : a === 2 ? 2 : a >= 3 ? 3 : 1;
  }
  const visited = new Uint8Array(W * H);
  const pt = (i: number): Pt => ({ x: i % W + 0.5, y: Math.floor(i / W) + 0.5 });
  /** nächster Pixel: noch nicht besuchte Nachbarn (gerade zuerst), sonst eine Kreuzung zum Abschließen */
  const nextOf = (cur: number, prev: number): number => {
    const x = cur % W, y = (cur - x) / W;
    let junction = -1;
    for (const [dx, dy] of DIRS.filter(d => d[0] === 0 || d[1] === 0).concat(DIRS.filter(d => d[0] !== 0 && d[1] !== 0))) {
      if (!on(x + dx, y + dy)) continue;
      const n = (y + dy) * W + x + dx;
      if (n === prev) continue;
      if (!visited[n]) return n;
      if (kind[n] === 3 && junction < 0) junction = n;
    }
    return junction;
  };
  const walk = (start: number, first: number): number[] => {
    const line = [start];
    if (kind[start] !== 3) visited[start] = 1;
    let prev = start, cur = first;
    for (let guard = 0; guard < W * H && cur >= 0; guard++) {
      line.push(cur);
      if (kind[cur] === 3 && line.length > 1 && cur !== start) { visited[cur] = 1; break; }
      visited[cur] = 1;
      const nx = nextOf(cur, prev);
      if (nx < 0 || nx === start && line.length < 3) break;
      prev = cur; cur = nx;
    }
    return line;
  };
  const paths: CenterPath[] = [];
  const emit = (line: number[]) => { if (line.length >= 2) paths.push({ pts: line.map(pt), closed: false }); };
  // 1. von Enden aus
  for (let i = 0; i < W * H; i++) if (kind[i] === 1 && !visited[i]) {
    const n = nextOf(i, -1);
    if (n >= 0) emit(walk(i, n)); else visited[i] = 1;
  }
  // 2. von Kreuzungen aus in jede noch freie Richtung
  for (let i = 0; i < W * H; i++) if (kind[i] === 3) {
    visited[i] = 1;
    for (let n = nextOf(i, -1); n >= 0 && !visited[n]; n = nextOf(i, -1)) emit(walk(i, n));
  }
  // 3. Ringe
  for (let i = 0; i < W * H; i++) if (kind[i] && !visited[i]) {
    const n = nextOf(i, -1);
    if (n < 0) { visited[i] = 1; continue; }
    const line = walk(i, n);
    const last = line[line.length - 1], lx = last % W, ly = (last - lx) / W, sx = i % W, sy = (i - sx) / W;
    const closed = line.length > 3 && Math.abs(lx - sx) <= 1 && Math.abs(ly - sy) <= 1;
    if (closed) line.push(i);
    paths.push({ pts: line.map(pt), closed });
  }
  return paths;
}

/** Douglas-Peucker für offene Linien */
export function simplifyOpen(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  // Anfang = Ende (Ring): am entferntesten Punkt teilen, sonst fiele alles auf die eine Strecke zusammen
  const f = pts[0], l = pts[pts.length - 1];
  if (Math.hypot(f.x - l.x, f.y - l.y) < 1e-9) {
    let far = 1, best = -1;
    pts.forEach((q, i) => { const d = Math.hypot(q.x - f.x, q.y - f.y); if (d > best) { best = d; far = i; } });
    if (far > 0 && far < pts.length - 1) return [...simplifyOpen(pts.slice(0, far + 1), tol).slice(0, -1), ...simplifyOpen(pts.slice(far), tol)];
  }
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = pts[a], B = pts[b], dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i].x - A.x) * dy - (pts[i].y - A.y) * dx) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const lengthOf = (p: Pt[]) => p.reduce((s, q, i) => (i ? s + Math.hypot(q.x - p[i - 1].x, q.y - p[i - 1].y) : 0), 0);

/**
 * Maske → Mittellinien
 * @param minLen  kürzere Linien weglassen (Pixel) – Sporne und Rauschen
 * @param tol     Vereinfachung (Pixel)
 */
export function centerlines(mask: Uint8Array, W: number, H: number, minLen: number, tol: number): CenterPath[] {
  const m = thin(Uint8Array.from(mask), W, H);
  return traceSkeleton(m, W, H)
    .filter(p => lengthOf(p.pts) >= minLen)
    .map(p => ({ pts: simplifyOpen(p.pts, tol), closed: p.closed }))
    .filter(p => p.pts.length >= 2);
}
