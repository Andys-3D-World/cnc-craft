/**
 * ARC FITTING – kurze G1-Stücke zu echten Bögen G2/G3 zusammenfassen (Nachbearbeitung des fertigen Fräs-G-Codes)
 *
 * Runde Bahnen bestehen aus vielen kleinen Geraden. Bei hohem Vorschub kommt die Maschine mit dem Lesen und Abbremsen
 * nicht nach und stottert. Ein Bogen ist eine Zeile und fährt gleichmäßig.
 *
 * Es wird nur zusammengefasst, was sicher gleich bleibt:
 *  - nur Zeilen der Form „G1 X… Y…“, dazwischen nichts (kein Z, keine Kommentare, keine andere Zeile)
 *  - ein neues F beendet die Kette: die Zeile mit F darf nur am Anfang eines Bogens stehen (Vorschub in Kurven bleibt)
 *  - nur G17, G21 und G90; sonst bleibt der Rest des Programms unverändert
 *  - mindestens MIN_SEGS Stücke, nicht gerade, gleichbleibende Drehrichtung, höchstens MAX_SWEEP Grad je Bogen
 *  - Abstand zwischen alter Bahn und Bogen nirgends größer als die Toleranz (Ecken, Kantenmitten, Lot auf die Kante)
 *
 * Reihenfolge in cam.ts: NACH der Vorschub-Anpassung und den Nachmess-Punkten. Bei eingeschalteter Drehachse gar nicht:
 * dort wird Y zum Winkel, ein Bogen wäre auf der Maschine kein Bogen mehr. Nur Fräse (am Laser hängt die Leistung
 * an den Zeilen). Die Höhenkarte zerlegt Bögen beim Senden wieder in Geraden – das bleibt korrekt.
 */
export const ARC_TOL_DEFAULT = 0.01;
export const ARC_TOL_MIN = 0.001;
export const ARC_TOL_MAX = 0.1;
export const clampArcTol = (v: number) => Math.max(ARC_TOL_MIN, Math.min(ARC_TOL_MAX, v));

/** Einstellung (rechte Seite → Fräsparameter), Standard aus */
export const arcFit = { on: false, tol: ARC_TOL_DEFAULT };
const KEY = "cnc_craft_arc_fit";
export function loadArcFit() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (typeof o.on === "boolean") arcFit.on = o.on;
    if (Number.isFinite(+o.tol) && +o.tol > 0) arcFit.tol = clampArcTol(+o.tol);
  } catch { /* Standardwerte */ }
}
export function saveArcFit() {
  try { localStorage.setItem(KEY, JSON.stringify(arcFit)); } catch { /* egal */ }
}

const MIN_SEGS = 4;
const MAX_SWEEP = (270 * Math.PI) / 180;
const MAX_PROBE = 512;
const MAX_RADIUS = 5000;
const MIN_RADIUS = 0.05;

interface Pt { x: number; y: number }
export interface ArcFitResult { gcode: string; before: number; after: number; arcs: number }

const f3 = (v: number) => v.toFixed(3);

/** Mittelpunkt durch drei Punkte; null = (fast) auf einer Linie */
function circle3(a: Pt, b: Pt, c: Pt): Pt | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  return { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d };
}

interface Fit { i: number; j: number; ccw: boolean; ci: number; cj: number; sweep: number }

/** Passt ein Bogen auf die Punkte i..j? */
function tryFit(p: Pt[], i: number, j: number, tol: number): Fit | null {
  const a = p[i], b = p[j], m = p[(i + j) >> 1];
  const raw = circle3(a, m, b);
  if (!raw) return null;
  // I/J werden auf 3 Stellen gerundet: mit dem Mittelpunkt rechnen, den die Maschine wirklich sieht
  const ci = +(raw.x - a.x).toFixed(3), cj = +(raw.y - a.y).toFixed(3);
  const c = { x: a.x + ci, y: a.y + cj };
  const r = Math.hypot(ci, cj);
  if (r < MIN_RADIUS || r > MAX_RADIUS) return null;
  if (Math.abs(Math.hypot(b.x - c.x, b.y - c.y) - r) > Math.min(tol, 0.002)) return null; // sonst Fehler 33 bei GRBL

  // gerade? (dann ist es kein Bogen, auch wenn ein riesiger Kreis passen würde)
  const cx = b.x - a.x, cy = b.y - a.y, chord = Math.hypot(cx, cy);
  let bulge = 0;
  if (chord > 1e-9) for (let k = i + 1; k < j; k++) bulge = Math.max(bulge, Math.abs(cx * (p[k].y - a.y) - cy * (p[k].x - a.x)) / chord);
  if (chord > 1e-9 && bulge <= tol) return null;

  const off = (q: Pt) => Math.abs(Math.hypot(q.x - c.x, q.y - c.y) - r);
  let sweep = 0, sign = 0;
  for (let k = i; k < j; k++) {
    const s = p[k], e = p[k + 1];
    if (off(e) > tol) return null;
    const dx = e.x - s.x, dy = e.y - s.y, l2 = dx * dx + dy * dy;
    if (l2 < 1e-12) continue;
    // der größte Abstand einer Sehne zum Kreis liegt am Lot vom Mittelpunkt auf die Sehne
    const f = ((c.x - s.x) * dx + (c.y - s.y) * dy) / l2;
    if (f > 0 && f < 1 && off({ x: s.x + dx * f, y: s.y + dy * f }) > tol) return null;
    // Winkel um den Mittelpunkt: immer in dieselbe Richtung
    const an = Math.atan2((s.x - c.x) * (e.y - c.y) - (s.y - c.y) * (e.x - c.x), (s.x - c.x) * (e.x - c.x) + (s.y - c.y) * (e.y - c.y));
    if (Math.abs(an) > 1e-9) {
      const sg = Math.sign(an);
      if (sign && sg !== sign) return null;
      sign = sg;
      sweep += Math.abs(an);
    }
  }
  if (!sign || sweep > MAX_SWEEP) return null;
  return { i, j, ccw: sign > 0, ci, cj, sweep };
}

/** Längsten passenden Bogen ab i finden: in Sprüngen verlängern, dann eingrenzen */
function longestFit(p: Pt[], i: number, tol: number): Fit | null {
  const last = p.length - 1;
  // Feine Kurven sehen auf wenigen Punkten noch gerade aus (innerhalb der Toleranz): deshalb auch längere Stücke probieren
  let best: Fit | null = null;
  for (let size = MIN_SEGS; i + size <= last && size <= MAX_PROBE; size *= 2) {
    best = tryFit(p, i, i + size, tol);
    if (best) break;
  }
  if (!best) return null;
  let lo = best.j, step = 4, hi = -1;
  while (lo < last) {
    const j = Math.min(last, lo + step);
    const f = tryFit(p, i, j, tol);
    if (f) { best = f; lo = j; step *= 2; }
    else { hi = j; break; }
  }
  if (hi > 0) {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1, f = tryFit(p, i, mid, tol);
      if (f) { best = f; lo = mid; } else hi = mid;
    }
  }
  return best;
}

/** Linienzug als Geraden und Bögen: pts[i] → pts[i+1] mit Wölbung bulges[i] (0 = Gerade; tan(Winkel/4), + = gegen den Uhrzeigersinn) */
export function fitPathArcs(pts: Pt[], closed: boolean, tol: number): { pts: Pt[]; bulges: number[] } {
  let seq = pts;
  if (closed && pts.length > 2) {
    // an der schärfsten Ecke anfangen, damit kein Bogen am Anfang zerschnitten wird
    let best = 0, turn = -1;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
      const an = Math.abs(Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)));
      if (an > turn) { turn = an; best = i; }
    }
    // keine echte Ecke (alles tangential): am Anfang der längsten Geraden
    if (turn < Math.PI / 18) {
      let len = -1;
      for (let i = 0; i < n; i++) {
        const l = Math.hypot(pts[(i + 1) % n].x - pts[i].x, pts[(i + 1) % n].y - pts[i].y);
        if (l > len) { len = l; best = i; }
      }
    }
    seq = [...pts.slice(best), ...pts.slice(0, best), pts[best]];
  }
  const outP: Pt[] = [], outB: number[] = [];
  const last = seq.length - 1;
  for (let i = 0; i < last;) {
    const fit = longestFit(seq, i, tol);
    outP.push(seq[i]);
    if (fit) { outB.push((fit.ccw ? 1 : -1) * Math.tan(fit.sweep / 4)); i = fit.j; }
    else { outB.push(0); i++; }
  }
  if (!closed) { outP.push(seq[last]); outB.push(0); }
  // Punkte auf einer Geraden weglassen
  const P: Pt[] = [], B: number[] = [];
  const m = outP.length;
  for (let i = 0; i < m; i++) {
    const prevI = i - 1, nextP = outP[i + 1] ?? (closed ? outP[0] : null), prevP = P[P.length - 1];
    if (prevI >= 0 && nextP && outB[i] === 0 && B[B.length - 1] === 0) {
      const dx = nextP.x - prevP.x, dy = nextP.y - prevP.y, l = Math.hypot(dx, dy);
      if (l > 1e-9 && Math.abs(dx * (outP[i].y - prevP.y) - dy * (outP[i].x - prevP.x)) / l < 1e-3
        && (outP[i].x - prevP.x) * dx + (outP[i].y - prevP.y) * dy >= 0) continue;
    }
    P.push(outP[i]); B.push(outB[i]);
  }
  return { pts: P, bulges: B };
}

/** Ist der geschlossene Linienzug ein Kreis (z. B. ein Loch aus vielen Punkten)? Alle Ecken auf einem Kreis, mindestens 20 */
export function fitCircle(pts: Pt[], tol: number): { cx: number; cy: number; r: number } | null {
  const n = pts.length;
  if (n < 20) return null;
  const c = circle3(pts[0], pts[Math.floor(n / 3)], pts[Math.floor((2 * n) / 3)]);
  if (!c) return null;
  const r = Math.hypot(pts[0].x - c.x, pts[0].y - c.y);
  if (r > MAX_RADIUS) return null;
  const keep = Math.max(tol, r * 0.001);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(pts[i].x - c.x, pts[i].y - c.y);
    if (Math.abs(d - r) > keep) return null;
    const q = pts[(i + 1) % n];
    // rundherum in einer Richtung und ohne große Lücke (sonst wäre es nur ein Stück Kreis mit einer Geraden)
    const an = Math.atan2((pts[i].x - c.x) * (q.y - c.y) - (pts[i].y - c.y) * (q.x - c.x), (pts[i].x - c.x) * (q.x - c.x) + (pts[i].y - c.y) * (q.y - c.y));
    if (Math.abs(an) > Math.PI / 6) return null;
    sum += an;
  }
  if (Math.abs(Math.abs(sum) - 2 * Math.PI) > 1e-3) return null;
  return { cx: c.x, cy: c.y, r: pts.reduce((s, p) => s + Math.hypot(p.x - c.x, p.y - c.y), 0) / n };
}

const PLAIN = /^G0?1\s+X(-?\d*\.?\d+)\s+Y(-?\d*\.?\d+)(?:\s+F(\d*\.?\d+))?\s*$/;
const WORD = (l: string, c: string) => { const m = l.match(new RegExp(c + "\\s*(-?\\d*\\.?\\d+)")); return m ? parseFloat(m[1]) : null; };

export function fitArcs(gcode: string, tolerance: number = ARC_TOL_DEFAULT): ArcFitResult {
  const tol = clampArcTol(tolerance);
  const lines = gcode.split("\n");
  const out: string[] = [];
  let pos: Pt | null = null, arcs = 0;
  let chain: { line: string; p: Pt; f: string | null }[] = [];
  let chainStart: Pt | null = null;

  const flush = () => {
    if (!chain.length) return;
    const pts = [chainStart!, ...chain.map(c => c.p)];
    let i = 0;
    while (i < chain.length) {
      const fit = longestFit(pts, i, tol);
      if (fit) {
        const end = pts[fit.j], f = chain[fit.i].f;
        out.push(`${fit.ccw ? "G3" : "G2"} X${f3(end.x)} Y${f3(end.y)} I${f3(fit.ci)} J${f3(fit.cj)}${f ? ` F${f}` : ""}`);
        arcs++;
        i = fit.j;
      } else out.push(chain[i++].line);
    }
    chain = [];
    chainStart = null;
  };

  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const line = raw.trim();
    const m = line.match(PLAIN);
    if (m && pos) {
      const p = { x: parseFloat(m[1]), y: parseFloat(m[2]) };
      const f = m[3] ?? null;
      if (f !== null && chain.length) { flush(); }
      if (!chain.length) chainStart = pos;
      chain.push({ line: raw, p, f });
      pos = p;
      continue;
    }
    flush();
    const code = line.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").toUpperCase();
    // etwas, das die Rechnung ungültig macht: ab hier alles unverändert lassen
    if (/\bG(?:0?91|20|18|19|92|10)\b/.test(code)) {
      out.push(...lines.slice(n));
      break;
    }
    const x = WORD(code, "X"), y = WORD(code, "Y");
    // Maschinenkoordinaten / Referenzfahrt: Lage im Werkstück danach unbekannt
    if (/\bG(?:53|28|30)\b/.test(code)) pos = null;
    else if (x !== null || y !== null) {
      if (x !== null && y !== null) pos = { x, y };
      else if (pos) pos = { x: x ?? pos.x, y: y ?? pos.y };
    }
    out.push(raw);
  }
  flush();
  return { gcode: out.join("\n"), before: lines.length, after: out.length, arcs };
}
