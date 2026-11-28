/**
 * BEDINGUNGEN WIE IN EINER PARAMETRISCHEN SKIZZE – nur Rechnung (mit `npm test` prüfbar). Werkzeug: constrainTool.ts
 *
 * Bedingungen hängen an Strecken (zwei Punkte einer Polylinie) bzw. an Punkten:
 *   h / v     Strecke waagerecht / senkrecht
 *   par/perp  zwei Strecken parallel / rechtwinklig
 *   eq        zwei Strecken gleich lang
 *   len       Strecke genau so lang (Wert in Zeichen-Einheiten)
 *   coin      zwei Punkte liegen aufeinander (auch Punkte verschiedener Formen)
 *   fix       Punkt bleibt an seiner Stelle (at)
 *   onLine    Punkt liegt auf der (verlängerten) Strecke
 *   ang       Winkel von Strecke a nach b (Grad, gegen den Uhrzeigersinn; 180° weiter gilt auch)
 * Kreise: in der Punktliste stehen [Mitte, {x: Radius, y: 0}] – Punkt 0 ist also die Mitte (geht auch bei coin/fix …)
 * Bögen (CirRef mit arc): [Start, Ende, Punkt auf dem Bogen] – Mitte und Radius ergeben sich aus den drei Punkten
 *   rad       Radius genau v
 *   conc      gleiche Mitte
 *   tanL      Strecke berührt den Kreis (Abstand Mitte–Gerade = Radius)
 *   tanC      zwei Kreise berühren sich, außen oder innen (inner)
 *   onCirc    Punkt liegt auf dem Kreis
 *   eqR       gleicher Radius
 *
 * Lösen: Newton-Verfahren mit kleinstem Schritt – es wird so wenig wie möglich verschoben, und Punkte mit höherem
 * Gewicht (z. B. die zuerst angeklickte Strecke) bewegen sich weniger. Widersprechen sich Bedingungen, gibt es kein
 * Ergebnis (ok = false) und nichts wird geändert.
 */
export interface P { x: number; y: number }
/** Strecke: Punkte i und j der Form id */
export interface SegRef { id: string; i: number; j: number }
export interface PtRef { id: string; i: number }
/** Kreis: id einer Kreis-Form (Punktliste [Mitte, {x: r, y: 0}]) oder eines Bogens (arc: [Start, Ende, Mitte des Bogens]) */
export interface CirRef { id: string; arc?: boolean }

/** Umkreis durch drei Punkte (null = auf einer Geraden) */
export function circumcircle(a: P, b: P, c: P): { c: P; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { c: { x, y }, r: Math.hypot(a.x - x, a.y - y) };
}
export type GCon =
  | { k: "h" | "v"; a: SegRef }
  | { k: "par" | "perp" | "eq"; a: SegRef; b: SegRef }
  | { k: "len"; a: SegRef; v: number }
  | { k: "ang"; a: SegRef; b: SegRef; v: number }
  | { k: "coin"; p: PtRef; q: PtRef }
  | { k: "fix"; p: PtRef; at: P }
  | { k: "onLine"; p: PtRef; a: SegRef }
  | { k: "rad"; c: CirRef; v: number }
  | { k: "conc" | "eqR"; c: CirRef; d: CirRef }
  | { k: "tanL"; a: SegRef; c: CirRef }
  | { k: "tanC"; c: CirRef; d: CirRef; inner: boolean }
  | { k: "onCirc"; p: PtRef; c: CirRef };

export type Shapes = Map<string, P[]>;

/** Alle Punkte, die eine Bedingung braucht */
export function refsOf(c: GCon): PtRef[] {
  const seg = (s: SegRef): PtRef[] => [{ id: s.id, i: s.i }, { id: s.id, i: s.j }];
  const cir = (r: CirRef): PtRef[] => r.arc ? [{ id: r.id, i: 0 }, { id: r.id, i: 1 }, { id: r.id, i: 2 }] : [{ id: r.id, i: 0 }, { id: r.id, i: 1 }];
  switch (c.k) {
    case "h": case "v": case "len": return seg(c.a);
    case "par": case "perp": case "eq": case "ang": return [...seg(c.a), ...seg(c.b)];
    case "coin": return [c.p, c.q];
    case "fix": return [c.p];
    case "onLine": return [c.p, ...seg(c.a)];
    case "rad": return cir(c.c);
    case "conc": case "eqR": case "tanC": return [...cir(c.c), ...cir(c.d)];
    case "tanL": return [...seg(c.a), ...cir(c.c)];
    case "onCirc": return [c.p, ...cir(c.c)];
  }
}

/** Ids aller beteiligten Formen */
export function idsOf(c: GCon): string[] { return [...new Set(refsOf(c).map(r => r.id))]; }

/** Fehler einer Bedingung (0 = erfüllt). get(id, i) liefert den Punkt */
export function residual(c: GCon, get: (id: string, i: number) => P): number[] {
  const seg = (s: SegRef) => { const a = get(s.id, s.i), b = get(s.id, s.j); return { x: b.x - a.x, y: b.y - a.y }; };
  /** Mitte und Radius eines Kreises oder Bogens (Bogen auf einer Geraden: sehr groß, damit der Rechner weg davon findet) */
  const circ = (r: CirRef): { c: P; r: number } => {
    if (!r.arc) return { c: get(r.id, 0), r: get(r.id, 1).x };
    return circumcircle(get(r.id, 0), get(r.id, 1), get(r.id, 2)) ?? { c: get(r.id, 2), r: 1e9 };
  };
  switch (c.k) {
    case "h": return [seg(c.a).y];
    case "v": return [seg(c.a).x];
    case "len": { const d = seg(c.a); return [Math.hypot(d.x, d.y) - c.v]; }
    case "eq": { const d = seg(c.a), e = seg(c.b); return [Math.hypot(d.x, d.y) - Math.hypot(e.x, e.y)]; }
    case "par": case "perp": {
      const d = seg(c.a), e = seg(c.b), l = Math.hypot(d.x, d.y) * Math.hypot(e.x, e.y) || 1;
      return [(c.k === "par" ? d.x * e.y - d.y * e.x : d.x * e.x + d.y * e.y) / l];
    }
    case "coin": { const p = get(c.p.id, c.p.i), q = get(c.q.id, c.q.i); return [p.x - q.x, p.y - q.y]; }
    case "fix": { const p = get(c.p.id, c.p.i); return [p.x - c.at.x, p.y - c.at.y]; }
    case "onLine": {
      const p = get(c.p.id, c.p.i), a = get(c.a.id, c.a.i), d = seg(c.a), l = Math.hypot(d.x, d.y) || 1;
      return [(d.x * (p.y - a.y) - d.y * (p.x - a.x)) / l];
    }
    case "ang": {
      const d = seg(c.a), e = seg(c.b), l = Math.hypot(d.x, d.y) * Math.hypot(e.x, e.y) || 1, t = (c.v * Math.PI) / 180;
      return [((d.x * e.y - d.y * e.x) * Math.cos(t) - (d.x * e.x + d.y * e.y) * Math.sin(t)) / l];
    }
    case "rad": return [circ(c.c).r - c.v];
    case "eqR": return [circ(c.c).r - circ(c.d).r];
    case "conc": { const p = circ(c.c).c, q = circ(c.d).c; return [p.x - q.x, p.y - q.y]; }
    case "tanL": {
      const a = get(c.a.id, c.a.i), d = seg(c.a), l = Math.hypot(d.x, d.y) || 1, k = circ(c.c);
      return [Math.abs(d.x * (k.c.y - a.y) - d.y * (k.c.x - a.x)) / l - k.r];
    }
    case "tanC": {
      const k1 = circ(c.c), k2 = circ(c.d);
      return [Math.hypot(k1.c.x - k2.c.x, k1.c.y - k2.c.y) - (c.inner ? Math.abs(k1.r - k2.r) : k1.r + k2.r)];
    }
    case "onCirc": { const p = get(c.p.id, c.p.i), k = circ(c.c); return [Math.hypot(p.x - k.c.x, p.y - k.c.y) - k.r]; }
  }
}

/** Winkel-Bedingungen (Fehler ohne Einheit) */
const isAngle = (c: GCon) => c.k === "par" || c.k === "perp" || c.k === "ang";

/** Gilt die Bedingung? (tol für Längen in Zeichen-Einheiten, Winkel ~ tol/100) */
export function satisfied(c: GCon, shapes: Shapes, tol = 1e-3): boolean {
  const get = (id: string, i: number) => shapes.get(id)![i];
  return residual(c, get).every(r => Math.abs(r) <= (isAngle(c) ? 1e-5 : tol));
}

/** Sind alle Punkte der Bedingung vorhanden? */
export function valid(c: GCon, shapes: Shapes): boolean {
  return refsOf(c).every(r => { const s = shapes.get(r.id); return !!s && r.i >= 0 && r.i < s.length; });
}

export interface SolveResult { ok: boolean; shapes: Shapes; iterations: number }

/**
 * Bedingungen erfüllen, mit möglichst kleinen Verschiebungen. weight(id, i): wie schwer ein Punkt zu bewegen ist (Standard 1).
 * Das Ergebnis enthält neue Punktlisten (die Eingabe bleibt unverändert).
 */
export function solve(shapes: Shapes, cons: GCon[], weight: (id: string, i: number) => number = () => 1, maxIter = 60): SolveResult {
  const out: Shapes = new Map([...shapes].map(([id, pts]) => [id, pts.map(p => ({ ...p }))]));
  const use = cons.filter(c => valid(c, out));
  if (!use.length) return { ok: true, shapes: out, iterations: 0 };

  // Unbekannte: x und y jedes beteiligten Punkts
  const idx = new Map<string, number>(), vars: PtRef[] = [];
  for (const c of use) for (const r of refsOf(c)) { const k = r.id + "#" + r.i; if (!idx.has(k)) { idx.set(k, vars.length); vars.push(r); } }
  const n = vars.length * 2;
  const x = new Float64Array(n);
  vars.forEach((r, k) => { const p = out.get(r.id)![r.i]; x[2 * k] = p.x; x[2 * k + 1] = p.y; });
  const w = new Float64Array(n);
  vars.forEach((r, k) => { const v = Math.max(1e-6, weight(r.id, r.i)); w[2 * k] = v; w[2 * k + 1] = v; });

  // Maßstab für Toleranzen (Größe der Zeichnung)
  let scale = 1;
  for (let k = 0; k < n; k++) scale = Math.max(scale, Math.abs(x[k]));
  const getter = (xs: Float64Array) => (id: string, i: number) => { const k = idx.get(id + "#" + i)!; return { x: xs[2 * k], y: xs[2 * k + 1] }; };
  const tolOf = (c: GCon) => (isAngle(c) ? 1e-10 : 1e-9 * scale);

  const rows = () => use.flatMap(c => residual(c, getter(x)).map(v => ({ c, v })));
  let iter = 0;
  for (; iter < maxIter; iter++) {
    const r = rows();
    if (r.every(({ c, v }) => Math.abs(v) <= tolOf(c))) break;
    const m = r.length;
    // Jacobi-Matrix numerisch: nur die Unbekannten der jeweiligen Bedingung
    const J: Float64Array[] = Array.from({ length: m }, () => new Float64Array(n));
    let row = 0;
    for (const c of use) {
      const cols = refsOf(c).flatMap(ref => { const k = idx.get(ref.id + "#" + ref.i)!; return [2 * k, 2 * k + 1]; });
      const base = residual(c, getter(x));
      for (const col of [...new Set(cols)]) {
        const h = 1e-7 * Math.max(1, Math.abs(x[col]));
        const old = x[col];
        x[col] = old + h; const fp = residual(c, getter(x));
        x[col] = old - h; const fm = residual(c, getter(x));
        x[col] = old;
        for (let q = 0; q < base.length; q++) J[row + q][col] = (fp[q] - fm[q]) / (2 * h);
      }
      row += base.length;
    }
    // kleinster gewichteter Schritt: Δ = -W⁻¹ Jᵀ (J W⁻¹ Jᵀ + μI)⁻¹ r
    const A: Float64Array[] = Array.from({ length: m }, () => new Float64Array(m));
    let trace = 0;
    for (let a = 0; a < m; a++) for (let b = a; b < m; b++) {
      let s = 0;
      const ja = J[a], jb = J[b];
      for (let k = 0; k < n; k++) if (ja[k] !== 0 && jb[k] !== 0) s += (ja[k] * jb[k]) / w[k];
      A[a][b] = s; A[b][a] = s;
      if (a === b) trace += s;
    }
    const mu = 1e-10 * (trace / Math.max(1, m)) + 1e-14;
    for (let a = 0; a < m; a++) A[a][a] += mu;
    const y = gauss(A, r.map(q => q.v));
    if (!y) return { ok: false, shapes, iterations: iter };
    let stepMax = 0;
    for (let k = 0; k < n; k++) {
      let s = 0;
      for (let a = 0; a < m; a++) s += J[a][k] * y[a];
      const d = -s / w[k];
      x[k] += d;
      stepMax = Math.max(stepMax, Math.abs(d));
    }
    if (!Number.isFinite(stepMax)) return { ok: false, shapes, iterations: iter };
  }
  const final = rows();
  // Längen dürfen nicht negativ werden (eine Strecke „durch null“ wäre kein sinnvolles Ergebnis)
  const ok = final.every(({ c, v }) => Math.abs(v) <= Math.max(tolOf(c) * 1e3, isAngle(c) ? 1e-7 : 1e-6 * scale));
  if (!ok) return { ok: false, shapes, iterations: iter };
  // eine Strecke, die vorher Länge hatte, darf nicht zu einem Punkt zusammenfallen (z. B. waagerecht UND senkrecht)
  const g = getter(x);
  for (const c of use) {
    const segs = c.k === "par" || c.k === "perp" || c.k === "eq" || c.k === "ang" ? [c.a, c.b] : c.k === "h" || c.k === "v" || c.k === "len" || c.k === "onLine" || c.k === "tanL" ? [c.a] : [];
    for (const s of segs) {
      const a0 = shapes.get(s.id)![s.i], b0 = shapes.get(s.id)![s.j], a1 = g(s.id, s.i), b1 = g(s.id, s.j);
      if (Math.hypot(b0.x - a0.x, b0.y - a0.y) > 1e-9 && Math.hypot(b1.x - a1.x, b1.y - a1.y) < 1e-6 * scale) return { ok: false, shapes, iterations: iter };
    }
  }
  vars.forEach((r, k) => { out.get(r.id)![r.i] = { x: x[2 * k], y: x[2 * k + 1] }; });
  return { ok: true, shapes: out, iterations: iter };
}

/** Gauß-Elimination mit Spaltenpivot, null = singulär */
function gauss(A: Float64Array[], b: number[]): number[] | null {
  const m = b.length;
  const M = A.map((row, i) => { const r = new Float64Array(m + 1); r.set(row); r[m] = b[i]; return r; });
  for (let c = 0; c < m; c++) {
    let piv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-300) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < m; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= m; k++) M[r][k] -= f * M[c][k];
    }
  }
  const y = new Array(m).fill(0);
  for (let r = m - 1; r >= 0; r--) {
    let s = M[r][m];
    for (let k = r + 1; k < m; k++) s -= M[r][k] * y[k];
    y[r] = s / M[r][r];
  }
  return y;
}

/**
 * Wie viele Freiheiten bleiben? (0 = voll bestimmt, wie „Skizze vollständig bestimmt“ in CAD-Programmen)
 * Unbekannte: alle Koordinaten der Formen; bei Kreisen zählt vom zweiten „Punkt“ nur x (der Radius).
 * Freiheiten = Unbekannte − Rang der Jacobi-Matrix (doppelte Bedingungen zählen nur einmal).
 */
export function freedom(shapes: Shapes, cons: GCon[], circles: Set<string> = new Set()): number {
  const use = cons.filter(c => valid(c, shapes));
  const cols = new Map<string, number>(); // "id#i#x|y" -> Spalte
  for (const [id, pts] of shapes) pts.forEach((_, i) => {
    cols.set(`${id}#${i}#x`, cols.size);
    if (!(circles.has(id) && i === 1)) cols.set(`${id}#${i}#y`, cols.size);
  });
  const n = cols.size;
  if (!use.length) return n;
  const x = new Map<string, P[]>([...shapes].map(([id, pts]) => [id, pts.map(p => ({ ...p }))]));
  const get = (id: string, i: number) => x.get(id)![i];
  const rows: number[][] = [];
  for (const c of use) {
    const base = residual(c, get);
    const local = base.map(() => new Array(n).fill(0));
    for (const r of refsOf(c)) for (const ax of ["x", "y"] as const) {
      const col = cols.get(`${r.id}#${r.i}#${ax}`);
      if (col === undefined) continue;
      const p = x.get(r.id)![r.i], old = p[ax], h = 1e-6 * Math.max(1, Math.abs(old));
      p[ax] = old + h; const fp = residual(c, get);
      p[ax] = old - h; const fm = residual(c, get);
      p[ax] = old;
      fp.forEach((v, q) => { local[q][col] = (v - fm[q]) / (2 * h); });
    }
    rows.push(...local);
  }
  return n - rank(rows);
}

/** Rang einer Matrix (Gauß mit relativer Toleranz) */
function rank(m: number[][]): number {
  const a = m.map(r => r.slice());
  const rowsN = a.length, colsN = rowsN ? a[0].length : 0;
  let scale = 0;
  for (const r of a) for (const v of r) scale = Math.max(scale, Math.abs(v));
  const tol = 1e-7 * Math.max(1, scale);
  let rk = 0;
  for (let c = 0; c < colsN && rk < rowsN; c++) {
    let piv = rk;
    for (let r = rk + 1; r < rowsN; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    if (Math.abs(a[piv][c]) <= tol) continue;
    [a[rk], a[piv]] = [a[piv], a[rk]];
    for (let r = rk + 1; r < rowsN; r++) {
      const f = a[r][c] / a[rk][c];
      if (f === 0) continue;
      for (let k = c; k < colsN; k++) a[r][k] -= f * a[rk][k];
    }
    rk++;
  }
  return rk;
}
