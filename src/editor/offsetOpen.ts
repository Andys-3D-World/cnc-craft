/**
 * VERSATZ FÜR OFFENE LINIEN – nur Rechnung (mit `npm test` prüfbar). Dialog und Seite anklicken: commands.ts
 *
 * Jedes gerade Stück wird um d zur Seite geschoben (d > 0 = links in Zeichenrichtung, d < 0 = rechts).
 *   1. Grob versetzen: innen treffen sich die Stücke an ihrem Schnittpunkt, außen spitz – bei sehr spitzen Ecken
 *      (mehr als 120° Richtungswechsel) ein Bogen um die alte Ecke, damit nichts weit hinaussticht.
 *   2. Wo sich das Ergebnis selbst kreuzt (enge Kurven, schmale Buchten), wird es aufgeschnitten. Jedes Stück, das
 *      näher als d an der Originallinie liegt, fällt weg – so bleiben keine Schleifen.
 * Ergebnis: eine oder mehrere Linien (mehrere, wenn eine Bucht den Versatz unterbricht), oder keine.
 * Die Enden der Linie bleiben gerade (senkrecht verschoben).
 */
export interface P { x: number; y: number }

const cross = (a: P, b: P) => a.x * b.y - a.y * b.x;
const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

/** Schnittpunkt zweier Geraden (Punkt + Richtung), null = parallel */
function lineX(p: P, u: P, q: P, v: P): P | null {
  const den = cross(u, v);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross({ x: q.x - p.x, y: q.y - p.y }, v) / den;
  return { x: p.x + u.x * t, y: p.y + u.y * t };
}

/** Bogen um c von a nach b (dir: +1 gegen, -1 mit dem Uhrzeigersinn), ohne a und b */
function arcBetween(c: P, a: P, b: P, r: number, dir: number, tol: number): P[] {
  const a0 = Math.atan2(a.y - c.y, a.x - c.x), a1 = Math.atan2(b.y - c.y, b.x - c.x);
  let sweep = a1 - a0;
  if (dir > 0) { while (sweep <= 0) sweep += 2 * Math.PI; } else { while (sweep >= 0) sweep -= 2 * Math.PI; }
  const step = 2 * Math.acos(Math.max(-1, 1 - tol / Math.max(r, tol)));
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / step));
  const out: P[] = [];
  for (let k = 1; k < n; k++) { const t = a0 + (sweep * k) / n; out.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) }); }
  return out;
}

/** Schritt 1: grob versetzte Linie (kann sich in engen Stellen selbst kreuzen) */
function rawOffset(p: P[], d: number, tol: number): P[] {
  const ad = Math.abs(d), MITER = 2;
  const segs = [];
  for (let i = 0; i < p.length - 1; i++) {
    const l = dist(p[i], p[i + 1]);
    const u = { x: (p[i + 1].x - p[i].x) / l, y: (p[i + 1].y - p[i].y) / l }, n = { x: -u.y * d, y: u.x * d };
    segs.push({ a: { x: p[i].x + n.x, y: p[i].y + n.y }, b: { x: p[i + 1].x + n.x, y: p[i + 1].y + n.y }, u, l, o1: p[i + 1] });
  }
  const out: P[] = [segs[0].a];
  for (let i = 0; i + 1 < segs.length; i++) {
    const s = segs[i], t = segs[i + 1];
    const c = cross(s.u, t.u);
    if (Math.abs(c) < 1e-12 && dot(s.u, t.u) > 0) { out.push(s.b); continue; } // gerade weiter
    const outer = c * d < 0 || Math.abs(c) < 1e-12;
    const x = Math.abs(c) < 1e-12 ? null : lineX(s.a, s.u, t.a, t.u);
    if (!outer && x) {
      // innen: am Schnittpunkt treffen, wenn er auf beiden Stücken liegt – sonst über Eck (die Schleife fällt in Schritt 2 weg)
      const t1 = dot({ x: x.x - s.a.x, y: x.y - s.a.y }, s.u), t2 = dot({ x: x.x - t.a.x, y: x.y - t.a.y }, t.u);
      if (t1 >= 0 && t1 <= s.l && t2 >= 0 && t2 <= t.l) out.push(x);
      else out.push(s.b, t.a);
    } else if (outer && x && dist(x, s.o1) <= MITER * ad) out.push(x);
    else out.push(s.b, ...arcBetween(s.o1, s.b, t.a, ad, d > 0 ? -1 : 1, tol), t.a);
  }
  out.push(segs[segs.length - 1].b);
  return out.filter((q, i) => i === 0 || dist(q, out[i - 1]) > 1e-12);
}

/**
 * Parallele zu einer offenen Linie. d > 0 = links, d < 0 = rechts (in Zeichenrichtung). tol: größte Abweichung der Bögen.
 * Ergebnis: Linien (Punktlisten); leer, wenn nichts übrig bleibt
 */
export function offsetOpenPath(pts: P[], d: number, tol = 0.02): P[][] {
  const p: P[] = [];
  for (const q of pts) if (!p.length || dist(q, p[p.length - 1]) > 1e-9) p.push(q);
  if (p.length < 2) return [];
  if (d === 0) return [p.map(q => ({ ...q }))];
  const raw = rawOffset(p, d, tol);

  // Schritt 2: von jedem Stück der groben Linie den Teil wegschneiden, der näher als d am Original liegt.
  // Etwas weniger als d (r), damit die richtige Parallele (genau d entfernt) sicher bleibt und Bogen-Sehnen nicht stören
  const r = Math.abs(d) - Math.max(1.5 * tol, 1e-6 * Math.abs(d));
  const oBox = p.slice(0, -1).map((a, k) => { const b = p[k + 1]; return [Math.min(a.x, b.x) - r, Math.min(a.y, b.y) - r, Math.max(a.x, b.x) + r, Math.max(a.y, b.y) + r]; });
  const out: P[][] = [];
  let open = false; // letzte Linie läuft am Ende des vorigen Stücks weiter
  for (let i = 0; i + 1 < raw.length; i++) {
    const A = raw[i], B = raw[i + 1];
    const bx = [Math.min(A.x, B.x), Math.min(A.y, B.y), Math.max(A.x, B.x), Math.max(A.y, B.y)];
    const gone: [number, number][] = [];
    for (let k = 0; k + 1 < p.length; k++) {
      const ob = oBox[k];
      if (ob[0] > bx[2] || ob[2] < bx[0] || ob[1] > bx[3] || ob[3] < bx[1]) continue;
      const iv = nearInterval(A, B, p[k], p[k + 1], r);
      if (iv) gone.push(iv);
    }
    for (const [t0, t1] of keptIntervals(gone)) {
      const q0 = at(A, B, t0), q1 = at(A, B, t1);
      if (open && t0 === 0) out[out.length - 1].push(q1);
      else out.push([q0, q1]);
      open = t1 === 1;
    }
    if (!keptIntervals(gone).some(([, t1]) => t1 === 1)) open = false;
  }
  return tidy(out, Math.abs(d) - r, tol);
}

/**
 * Aufräumen nach dem Wegschneiden: winzige Stummel an Schnittstellen weg (kürzer als 4·eps) und Stücke, die auf
 * derselben Geraden weiterlaufen (z. B. über eine Kerbe hinweg), wieder zu einer Linie verbinden
 */
function tidy(pieces: P[][], eps: number, tol: number): P[][] {
  const stub = 4 * eps + 1e-9;
  const cleaned = pieces.map(pc => {
    const q = [...pc];
    while (q.length > 2 && dist(q[q.length - 1], q[q.length - 2]) < stub) q.pop();
    while (q.length > 2 && dist(q[0], q[1]) < stub) q.shift();
    return q;
  }).filter(pc => pc.length >= 2 && pathLen(pc) > tol);
  const onSeg = (q: P, a: P, b: P) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    if (l2 <= 0) return false;
    const t = ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2;
    return t >= -1e-9 && t <= 1 + 1e-9 && Math.abs(cross({ x: dx, y: dy }, { x: q.x - a.x, y: q.y - a.y })) / Math.sqrt(l2) < eps;
  };
  const dirOf = (a: P, b: P) => { const l = dist(a, b) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
  const out: P[][] = [];
  for (const pc of cleaned) {
    const A = out[out.length - 1];
    if (A) {
      const a0 = A[A.length - 2], a1 = A[A.length - 1], b0 = pc[0], b1 = pc[1];
      if (dot(dirOf(a0, a1), dirOf(b0, b1)) > 0.9999) {
        if (onSeg(b0, a0, a1)) { A.pop(); A.push(...pc); continue; }   // B beginnt auf A's letztem Stück
        if (onSeg(a1, b0, b1)) { A.push(...pc.slice(1)); continue; }    // A endet auf B's erstem Stück
      }
    }
    out.push(pc);
  }
  return out;
}

const at = (A: P, B: P, t: number): P => (t === 0 ? A : t === 1 ? B : { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t });
const pathLen = (pc: P[]) => pc.reduce((s, q, i) => (i ? s + dist(q, pc[i - 1]) : 0), 0);

/** Teil [t0, t1] der Strecke A→B, der näher als r an der Strecke P→Q liegt (eine „Kapsel“ – das ist immer ein Stück), null = keiner */
function nearInterval(A: P, B: P, Pp: P, Q: P, r: number): [number, number] | null {
  const D = { x: B.x - A.x, y: B.y - A.y };
  let lo = Infinity, hi = -Infinity;
  const add = (iv: [number, number] | null) => { if (iv && iv[1] > iv[0]) { lo = Math.min(lo, iv[0]); hi = Math.max(hi, iv[1]); } };
  // Kreise um beide Enden
  for (const C of [Pp, Q]) {
    const f = { x: A.x - C.x, y: A.y - C.y };
    const a = dot(D, D), b = 2 * dot(f, D), c = dot(f, f) - r * r;
    const disc = b * b - 4 * a * c;
    if (a > 0 && disc > 0) { const sq = Math.sqrt(disc); add([(-b - sq) / (2 * a), (-b + sq) / (2 * a)]); }
  }
  // Streifen entlang der Strecke
  const L = dist(Pp, Q);
  if (L > 1e-12) {
    const u = { x: (Q.x - Pp.x) / L, y: (Q.y - Pp.y) / L }, f = { x: A.x - Pp.x, y: A.y - Pp.y };
    const s = lin(dot(f, u), dot(D, u), 0, L), h = lin(cross(u, f), cross(u, D), -r, r);
    if (s && h) add([Math.max(s[0], h[0]), Math.min(s[1], h[1])]);
  }
  const t0 = Math.max(0, lo), t1 = Math.min(1, hi);
  return t1 > t0 ? [t0, t1] : null;
}

/** t, für die c0 + c1·t zwischen lo und hi liegt */
function lin(c0: number, c1: number, lo: number, hi: number): [number, number] | null {
  if (Math.abs(c1) < 1e-15) return c0 > lo && c0 < hi ? [-Infinity, Infinity] : null;
  const a = (lo - c0) / c1, b = (hi - c0) / c1;
  return a < b ? [a, b] : [b, a];
}

/** Was von [0, 1] übrig bleibt, wenn die Stücke in gone wegfallen */
function keptIntervals(gone: [number, number][]): [number, number][] {
  const g = [...gone].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let pos = 0;
  for (const [a, b] of g) {
    if (a > pos + 1e-12) out.push([pos, a]);
    pos = Math.max(pos, b);
  }
  if (pos < 1 - 1e-12) out.push([pos, 1]);
  return out;
}

/** Auf welcher Seite der Linie liegt der Punkt? +1 = links, -1 = rechts (am nächsten Stück gemessen) */
export function sideOf(pts: P[], at: P): number {
  let best = Infinity, side = 1;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    if (l2 < 1e-18) continue;
    const t = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / l2));
    const q = { x: a.x + dx * t, y: a.y + dy * t }, dist = Math.hypot(at.x - q.x, at.y - q.y);
    if (dist < best) { best = dist; side = cross({ x: dx, y: dy }, { x: at.x - a.x, y: at.y - a.y }) >= 0 ? 1 : -1; }
  }
  return side;
}
