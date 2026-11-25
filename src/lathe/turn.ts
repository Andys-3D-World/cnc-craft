/**
 * DREHEN – reine Rechnung (Tests: tests/lathe.test.ts)
 *
 * Koordinaten: z entlang der Drehachse (0 = Planfläche des fertigen Teils, negativ = zum Futter), r = Radius.
 * Die Kontur ist eine Höhenlinie p[i] über z. Jedes Werkzeug hat eine Form t(dz): so weit liegt seine Unterkante an der Stelle
 * dz über dem tiefsten Punkt der Schneide (Schneidenradius, dann die zwei Schneidkanten als Geraden).
 *   dilate(p, t): wie tief darf das Werkzeug an jeder Stelle, ohne die Kontur zu verletzen (damit ist der Schneidenradius
 *                 genau eingerechnet, und wo der Stahl nicht hinkommt, bleibt von selbst Material stehen)
 *   sweep(S, …):  was nach einer Fahrt vom Material übrig ist
 * Alle Bahnen entstehen so, und jede fertige Bahn wird noch einmal gegen das Restmaterial gefahren (check()).
 */
export interface LatheTool {
  id: string; num: number; name: string;
  type: "turn" | "groove" | "drill";
  hand: "R" | "L" | "N";   // R: schneidet zum Futter hin, L: vom Futter weg, N: neutral
  nose: number;            // Schneidenradius (mm)
  kappa: number;           // Einstellwinkel der Hauptschneide (Grad)
  eps: number;             // Spitzenwinkel der Platte (Grad)
  width: number;           // Stechbreite (mm)
  dia: number;             // Bohrer-Ø
  ap: number;              // Zustellung je Seite (mm); Stechen/Bohren: Spanbruch-Schritt
  feed: number;            // mm je Umdrehung
  vcPct: number;           // Schnittgeschwindigkeit in % der Werkstoff-Vorgabe
}
export type OpKind = "face" | "rough" | "finish" | "drill" | "groove" | "part";
export interface LatheOp { kind: OpKind; on: boolean; tool: string; z?: number; width?: number; d?: number; depth?: number }
export interface LatheJob {
  stockD: number;     // Rohteil-Ø
  faceAllow: number;  // Rohteil steht so weit vor der Planfläche
  stickOut: number;   // Länge von der Planfläche des fertigen Teils bis zum Futter
  margin: number;     // Abstand zum Futter, den keine Schneide unterschreitet
  allowX: number; allowZ: number; // Schlichtaufmaß (X je Seite)
  vc: number;         // Schnittgeschwindigkeit des Werkstoffs (m/min)
  maxRpm: number;
  safeX: number; safeZ: number;   // Freifahren: über dem Rohteil / vor der Planfläche
  clear: number;      // kleiner Sicherheitsabstand
  tailOn: boolean; tailD: number; tailZ: number; // Reitstock/Spitze: Ø und vorderste Stelle
  ops: LatheOp[];
}
export interface Pt { z: number; r: number }
export interface Move { rapid: boolean; z: number; r: number; feed: number; op: number } // programmierte Punkte
export interface OpRun { op: LatheOp; tool: LatheTool; rpm: number; moves: Move[]; passes: number; rpms: number[] }
export interface LatheIssue { code: string; op: number; v?: number; hard: boolean }

const HUGE = 1e9, EPS = 1e-6;
const rad = (d: number) => d * Math.PI / 180;

// ---------------- Raster ----------------
export interface Grid { z0: number; h: number; n: number }
export const makeGrid = (zMin: number, zMax: number, h: number): Grid => ({ z0: Math.floor(zMin / h) * h, h, n: Math.ceil((zMax - Math.floor(zMin / h) * h) / h) + 1 });
const zOf = (g: Grid, i: number) => g.z0 + i * g.h;
const iOf = (g: Grid, z: number) => Math.max(0, Math.min(g.n - 1, Math.round((z - g.z0) / g.h)));

/** Höhenlinie der Kontur: größter Radius je Stelle. Links vom Teil bleibt das Rohteil stehen, rechts ist Luft */
export function heightLine(lines: Pt[][], g: Grid, left: number): Float64Array {
  const p = new Float64Array(g.n).fill(-HUGE);
  const put = (i: number, r: number) => { if (i >= 0 && i < g.n && r > p[i]) p[i] = r; };
  let zMin = HUGE;
  for (const l of lines) for (let k = 0; k < l.length; k++) {
    const b = l[k], a = l[Math.max(0, k - 1)];
    zMin = Math.min(zMin, b.z);
    const lo = a.z <= b.z ? a : b, hi = a.z <= b.z ? b : a;
    // jede Zelle bekommt den größten Wert der Linie in ihrer Umgebung (nie zu tief); +EPS: Punkte genau auf der Zellgrenze
    const i0 = Math.ceil((lo.z - g.z0) / g.h - 0.5 - EPS), i1 = Math.floor((hi.z - g.z0) / g.h + 0.5 - 1e-3);
    if (hi.z - lo.z < EPS) { put(Math.round((lo.z - g.z0) / g.h), Math.max(lo.r, hi.r)); continue; }
    for (let i = i0; i <= i1; i++) {
      const at = (z: number) => lo.r + (hi.r - lo.r) * Math.max(0, Math.min(1, (z - lo.z) / (hi.z - lo.z)));
      const z = zOf(g, i);
      put(i, Math.max(at(Math.max(lo.z, z - g.h / 2)), at(Math.min(hi.z, z + g.h / 2))));
    }
  }
  if (zMin < HUGE) for (let i = 0; i < g.n && zOf(g, i) < zMin - g.h / 2; i++) p[i] = left;
  return p;
}

// ---------------- Werkzeugform ----------------
export interface Shape { flat: number; nose: number; aL: number; aR: number } // aL/aR: Kantenwinkel links/rechts (Grad, 90 = senkrecht)
export function shapeOf(t: LatheTool): Shape {
  if (t.type === "groove") return { flat: t.width / 2, nose: 0, aL: 90, aR: 90 };
  if (t.type === "drill") return { flat: t.dia / 2, nose: 0, aL: 90, aR: 90 };
  const main = Math.min(90, t.kappa), back = Math.max(1, Math.min(90, 180 - t.kappa - t.eps));
  if (t.hand === "N") { const a = Math.min(90, (180 - t.eps) / 2); return { flat: 0, nose: t.nose, aL: a, aR: a }; }
  return t.hand === "R" ? { flat: 0, nose: t.nose, aL: main, aR: back } : { flat: 0, nose: t.nose, aL: back, aR: main };
}
const mirror = (s: Shape): Shape => ({ ...s, aL: s.aR, aR: s.aL });
/** Abstand der programmierten Spitze von der Mitte des Schneidenradius */
export function refDz(t: LatheTool): number {
  if (t.type === "groove") return -t.width / 2;
  if (t.type === "drill") return 0;
  return t.hand === "R" ? -t.nose : t.hand === "L" ? t.nose : 0;
}

/** Werkzeug-Unterkante über dem tiefsten Punkt an der Stelle dz (für Tests und Zeichnung) */
export function toolEdge(s: Shape, dz: number): number {
  if (s.flat) return Math.abs(dz) <= s.flat + EPS ? 0 : HUGE;
  const a = rad(dz < 0 ? s.aL : s.aR), d = Math.abs(dz), d0 = s.nose * Math.sin(a);
  if (d <= d0 + EPS) return s.nose - Math.sqrt(Math.max(0, s.nose * s.nose - d * d));
  return (dz < 0 ? s.aL : s.aR) >= 90 - EPS ? HUGE : s.nose * (1 - Math.cos(a)) + (d - d0) * Math.tan(a);
}

/** F[c] = max über i von p[i] − t(z_i − z_c): so tief darf der tiefste Punkt der Schneide an der Stelle c */
export function dilate(p: Float64Array, g: Grid, s: Shape): Float64Array {
  const n = g.n, h = g.h, F = new Float64Array(n).fill(-HUGE);
  const kL = Math.floor((s.flat || s.nose * Math.sin(rad(s.aL))) / h + 1e-6), kR = Math.floor((s.flat || s.nose * Math.sin(rad(s.aR))) / h + 1e-6);
  const off = new Float64Array(kL + kR + 1);
  for (let k = -kL; k <= kR; k++) off[k + kL] = toolEdge(s, k * h);
  for (let c = 0; c < n; c++) {
    let best = -HUGE;
    for (let k = Math.max(-kL, -c), e = Math.min(kR, n - 1 - c); k <= e; k++) { const v = p[c + k] - off[k + kL]; if (v > best) best = v; }
    F[c] = best;
  }
  if (!s.flat) {
    const side = (a: number, k0: number, dir: 1 | -1) => {
      if (a >= 90 - EPS) return;
      const tan = Math.tan(rad(a)), c0 = s.nose * (1 - Math.cos(rad(a))) - s.nose * Math.sin(rad(a)) * tan;
      let run = -HUGE;
      for (let q = 0; q < n; q++) {
        const c = dir < 0 ? q : n - 1 - q, i = c + dir * (k0 + 1); // dir −1: Material links vom Werkzeug
        run -= tan * h;
        if (i >= 0 && i < n && p[i] - tan * (k0 + 1) * h > run) run = p[i] - tan * (k0 + 1) * h;
        if (run - c0 > F[c]) F[c] = run - c0;
      }
    };
    side(s.aL, kL, -1);
    side(s.aR, kR, 1);
  }
  return F;
}

/** Restmaterial nach einer geraden Fahrt des tiefsten Punkts von (c1, r1) nach (c2, r2) */
export function sweep(S: Float64Array, g: Grid, s: Shape, z1: number, r1: number, z2: number, r2: number) {
  const A = new Float64Array(g.n).fill(-HUGE), a = Math.min(z1, z2), b = Math.max(z1, z2);
  const i0 = Math.max(0, Math.ceil((a - g.z0) / g.h - 1e-6)), i1 = Math.min(g.n - 1, Math.floor((b - g.z0) / g.h + 1e-6));
  const put = (i: number, r: number) => { if (-r > A[i]) A[i] = -r; };
  if (b - a < EPS) put(iOf(g, a), Math.min(r1, r2));
  else for (let i = i0; i <= i1; i++) put(i, r1 + (r2 - r1) * (zOf(g, i) - z1) / (z2 - z1));
  const E = dilate(A, g, mirror(s));
  for (let i = 0; i < g.n; i++) if (-E[i] < S[i]) S[i] = -E[i] > 1e-6 ? -E[i] : -HUGE; // bis zur Mitte: dort ist kein Material mehr
}

/** Bahn vereinfachen (Douglas-Peucker) */
export function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st: [number, number][] = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop()!, A = pts[a], B = pts[b], dz = B.z - A.z, dr = B.r - A.r, l = Math.hypot(dz, dr);
    let bi = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = l < 1e-9 ? Math.hypot(pts[i].z - A.z, pts[i].r - A.r) : Math.abs((pts[i].z - A.z) * dr - (pts[i].r - A.r) * dz) / l;
      if (d > bd) { bd = d; bi = i; }
    }
    if (bi >= 0) { keep[bi] = 1; st.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Drehzahl aus Schnittgeschwindigkeit, begrenzt */
export const rpmFor = (vc: number, d: number, max: number) => Math.max(1, Math.round(Math.min(max, vc * 1000 / (Math.PI * Math.max(0.5, d)))));

export interface LathePlan { runs: OpRun[]; issues: LatheIssue[]; grid: Grid; profile: Float64Array; stock: Float64Array; left: Float64Array; seconds: number; partLen: number }

export interface PlanInput { job: LatheJob; tools: LatheTool[]; profile: Pt[][] } // Kontur: rechtes Ende bei z = 0

/** Fest: so fein wird gerechnet */
const gridStep = (len: number) => Math.max(0.01, len / 6000);

export function planLathe({ job, tools, profile }: PlanInput): LathePlan {
  const issues: LatheIssue[] = [], R = job.stockD / 2;
  let zEnd = 0, rTop = 0;
  for (const l of profile) for (const p of l) { zEnd = Math.min(zEnd, p.z); rTop = Math.max(rTop, p.r); }
  const partLen = -zEnd, partOp = job.ops.find(o => o.kind === "part" && o.on), partTool = partOp && tools.find(x => x.id === partOp.tool);
  const ext = partTool ? partTool.width + 1 : 0; // hinter dem Teil Platz für den Abstechstahl
  const zMin = Math.min(zEnd - ext, -job.stickOut) - 6, zMax = job.faceAllow + job.safeZ + 12;
  const g = makeGrid(zMin, zMax, gridStep(zMax - zMin));
  const runs: OpRun[] = [], zStock = job.faceAllow, zChuck = -job.stickOut;
  const bad = (code: string, op: number, v?: number, hard = true) => { if (!issues.some(i => i.code === code && i.op === op)) issues.push({ code, op, v, hard }); };

  if (!profile.some(l => l.length > 1) || !(partLen > 0.05)) bad("noProfile", -1);
  if (rTop > R + 1e-3) bad("stockSmall", -1, rTop * 2);
  if (!(R > 0)) bad("stockBad", -1);
  if (!(job.maxRpm > 0) || !(job.vc > 0)) bad("speedBad", -1);
  if (-zEnd + ext > job.stickOut - job.margin + 1e-6) bad("stickOut", -1, partLen + ext + job.margin);
  const lod = job.stickOut / Math.max(0.1, job.stockD);
  if (!job.tailOn && lod > 4) bad("slender", -1, Math.round(lod * 10) / 10, false);

  const last = profile.map(l => l.filter(q => Math.abs(q.z - zEnd) < 1e-6)).flat().reduce((m, q) => Math.max(m, q.r), 0);
  const prof = ext ? [...profile, [{ z: zEnd - ext, r: last }, { z: zEnd, r: last }]] : profile;
  const p = heightLine(prof, g, R);
  // Rohteil
  const S = new Float64Array(g.n), stock = new Float64Array(g.n);
  for (let i = 0; i < g.n; i++) S[i] = stock[i] = zOf(g, i) <= zStock + EPS ? R : -HUGE;
  if (issues.some(i => i.hard)) return { runs, issues, grid: g, profile: p, stock, left: S, seconds: 0, partLen };

  let seconds = 0;
  job.ops.forEach((op, oi) => {
    if (!op.on) return;
    const tool = tools.find(x => x.id === op.tool);
    if (!tool) { bad("noTool", oi); return; }
    const want = op.kind === "drill" ? "drill" : op.kind === "groove" || op.kind === "part" ? "groove" : "turn";
    if (tool.type !== want) { bad("wrongTool", oi); return; }
    const sh = shapeOf(tool), dz = refDz(tool), vc = job.vc * tool.vcPct / 100;
    if (!(tool.feed > 0) || !(tool.ap > 0) || !(vc > 0)) { bad("toolBad", oi); return; }
    const run: OpRun = { op, tool, rpm: 0, moves: [], passes: 0, rpms: [] };
    const safeR = R + job.safeX, safeC = zStock + job.safeZ;
    let cz = safeC - dz, cr = safeR, rpm = 0; // Lage des tiefsten Punkts (z der Schneidenmitte)
    let need = dilate(S, g, sh), stale = false;
    const fresh = () => { if (stale) { need = dilate(S, g, sh); stale = false; } };
    const push = (rapid: boolean, z: number, r: number, f: number) => {
      if (Math.abs(z - cz) < 1e-9 && Math.abs(r - cr) < 1e-9) return;
      // geprüft wird jede Fahrt: im Eilgang nie ins Material, nie ins Futter, nie in den Reitstock
      if (rapid) {
        fresh();
        const i0 = iOf(g, Math.min(z, cz)), i1 = iOf(g, Math.max(z, cz));
        for (let i = i0; i <= i1; i++) {
          const rr = i0 === i1 || Math.abs(z - cz) < 1e-9 ? Math.min(r, cr) : cr + (r - cr) * Math.max(0, Math.min(1, (zOf(g, i) - cz) / (z - cz)));
          if (need[i] > rr + 0.02 && rr < R + 0.02) { bad("rapidHit", oi); break; }
        }
      } else if (tool.type !== "drill") { sweep(S, g, sh, cz, cr, z, r); stale = true; }
      const leftEdge = z - (sh.flat || sh.nose * Math.sin(rad(sh.aL)));
      if (leftEdge < zChuck + job.margin - 1e-6) bad("chuck", oi);
      if (job.tailOn && tool.type === "drill") bad("tailDrill", oi);
      if (job.tailOn && Math.min(r, cr) < job.tailD / 2 + 0.2 && Math.max(z, cz) + (sh.flat || sh.nose) > job.tailZ) bad("tail", oi);
      const len = Math.hypot(z - cz, r - cr);
      seconds += rapid ? len / 1500 * 60 : len / Math.max(0.1, f * rpm) * 60;
      run.moves.push({ rapid, z: z + dz, r, feed: rapid ? 0 : f, op: oi });
      run.rpms.push(rpm);
      cz = z; cr = r;
    };
    /** höchste Stelle, über der das Werkzeug zwischen zwei Stellen frei ist */
    const top = (a: number, b: number) => { fresh(); let m = -HUGE; for (let i = iOf(g, Math.min(a, b)), e = iOf(g, Math.max(a, b)); i <= e; i++) if (need[i] > m) m = need[i]; return m; };
    /** im Eilgang nach (z, r): erst hoch, dann längs, dann so weit wie frei hinunter, den Rest im Vorschub */
    const travel = (z: number, r: number, f: number) => {
      const t = Math.max(top(cz, z) + job.clear, cr, Math.min(r, safeR));
      if (cr < t) push(true, cz, t, 0);
      push(true, z, t, 0);
      const free = Math.max(r, top(z, z) + job.clear);
      if (free < t) push(true, z, free, 0);
      if (free > r) push(false, z, r, f);
    };
    const setRpm = (d: number) => { rpm = rpmFor(vc, d, job.maxRpm); if (!run.rpm) run.rpm = rpm; };
    setRpm(job.stockD);

    if (op.kind === "face") {
      // Planen: von außen zur Mitte, Schneide muss mit dem Radius über die Mitte hinaus
      const n = Math.max(1, Math.ceil(job.faceAllow / tool.ap - 1e-6)), noseL = sh.nose * Math.sin(rad(sh.aL));
      if (job.faceAllow < 1e-6) bad("faceNothing", oi, undefined, false);
      if (job.tailOn) bad("tailFace", oi);
      for (let k = 1; k <= n && job.faceAllow >= 1e-6; k++) {
        const z = job.faceAllow * (1 - k / n) + noseL;
        // von rechts neben dem Rohteil an die Startstelle: außen herum
        if (cr < safeR) push(true, cz, safeR, 0);
        push(true, z, safeR, 0);
        push(true, z, R + job.clear, 0);
        push(false, z, -tool.nose, tool.feed);
        push(false, z + job.clear, -tool.nose, tool.feed * 2);
        push(true, z + job.clear, safeR, 0);
        run.passes++;
      }
    } else if (op.kind === "rough") {
      const pa = new Float64Array(g.n), w = Math.round(job.allowZ / g.h);
      for (let i = 0; i < g.n; i++) { let m = -HUGE; for (let k = Math.max(0, i - w), e = Math.min(g.n - 1, i + w); k <= e; k++) if (p[k] > m) m = p[k]; pa[i] = m > -HUGE / 2 ? m + job.allowX : -HUGE; }
      const F = dilate(pa, g, sh);
      const zRight = Math.max(0, rightEnd(S, g)) + job.clear + (sh.flat || tool.nose);
      const cs = iOf(g, zRight), cMin = iOf(g, zChuck + job.margin + tool.nose);
      let low = R;
      for (let c = cMin, e = iOf(g, 0); c <= e; c++) if (F[c] > -HUGE / 2 && F[c] < low) low = F[c];
      low = Math.max(low, 0);
      const n = Math.max(1, Math.ceil((R - low) / tool.ap - 1e-6)), step = (R - low) / n;
      for (let k = 1; k <= n && step > 1e-4; k++) {
        const r = R - step * k, rPrev = r + step;
        setRpm(rPrev * 2);
        for (let b = cs; b >= cMin;) {
          if (F[b] > r + EPS) { b--; continue; }
          let a = b;
          while (a - 1 >= cMin && F[a - 1] <= r + EPS) a--;
          let any = false;
          for (let i = a; i <= b && !any; i++) if (S[i] > r + 2e-3) any = true;
          // auch links vom Ende des Intervalls nimmt die Schneide noch Material mit (Schneidenradius)
          if (any) {
            if (b === cs) travel(zOf(g, b), r, tool.feed);
            else {
              // Tal: an der rechten Flanke (Freiwinkel des Stahls) entlang hinunter
              let q = b;
              while (q + 1 <= cs && F[q + 1] <= rPrev && F[q + 1] > F[q] - EPS) q++;
              travel(zOf(g, q), Math.max(F[q], r), tool.feed);
              if (q > b) for (const t of simplify(range(q, b, -1).map(i => ({ z: zOf(g, i), r: Math.max(F[i], r) })), 0.005).slice(1)) push(false, t.z, t.r, tool.feed);
              push(false, zOf(g, b), r, tool.feed);
            }
            push(false, zOf(g, a), r, tool.feed);
            // am Ende der Kontur nach bis zur vorigen Höhe: keine Stufen
            let e = a;
            const up: Pt[] = [{ z: zOf(g, a), r }];
            while (e - 1 >= cMin && F[e - 1] <= rPrev) { e--; up.push({ z: zOf(g, e), r: Math.max(r, F[e]) }); }
            for (const t of simplify(up, 0.005).slice(1)) push(false, t.z, t.r, tool.feed);
            if (cr < rPrev) push(false, cz, rPrev, tool.feed);
            push(false, cz + Math.min(0.3, job.clear), cr + Math.min(0.3, job.clear), tool.feed * 3);
            run.passes++;
          }
          b = a - 1;
        }
      }
    } else if (op.kind === "finish") {
      const F = dilate(p, g, sh), zRight = Math.max(0, rightEnd(S, g)) + job.clear + tool.nose, cs = iOf(g, zRight), cMin = iOf(g, zChuck + job.margin + tool.nose);
      let c = cs;
      while (c > cMin && F[c] < -tool.nose - EPS) c--;
      const r0 = Math.max(-tool.nose, F[c]);
      const pts: Pt[] = [{ z: zOf(g, c), r: r0 }];
      for (let i = c - 1; i >= cMin; i--) {
        const r = Math.max(-tool.nose, F[i]);
        pts.push({ z: zOf(g, i), r: Math.min(r, R + 0.3) });
        if (r >= R - EPS && zOf(g, i) < zEnd - ext) break;
      }
      // Schlichten heißt wenig abnehmen: steht irgendwo noch viel Material, wird es abgelehnt (erst schruppen)
      const thr = Math.max(job.allowX, tool.ap) * 2 + 0.1;
      for (let i = 0, run0 = 0, big = 0; i < g.n; i++) {
        const e = zOf(g, i) >= zEnd && zOf(g, i) <= zStock ? S[i] - Math.max(0, p[i]) : 0;
        if (e > thr) { run0++; big = Math.max(big, e); if (run0 * g.h > job.allowZ + thr + 4 * g.h && F[i] < S[i] - thr) bad("finishDeep", oi, Math.round(big * 10) / 10); }
        else { run0 = 0; big = 0; }
      }
      let dMax = 0;
      for (let i = 0; i < g.n; i++) if (zOf(g, i) >= zEnd && p[i] > dMax) dMax = p[i];
      setRpm(dMax * 2);
      travel(zOf(g, cs), r0, tool.feed);
      for (const t of simplify(pts, 0.002)) push(false, t.z, t.r, tool.feed);
      if (cr < R + 0.3) push(false, cz, Math.min(R + 0.3, Math.max(cr + 0.3, top(cz, cz) + 0.3)), tool.feed);
      run.passes = 1;
      // was dieser Stahl nicht erreicht (der Schneidenradius in Ecken zählt nicht)
      let rest = 0;
      for (let i = 0; i < g.n; i++) if (zOf(g, i) >= zEnd + 0.05 && zOf(g, i) <= -0.05 && p[i] > 0) rest = Math.max(rest, S[i] - p[i]);
      if (rest > Math.max(0.05, tool.nose)) bad("rest", oi, Math.round(rest * 100) / 100, false);
    } else if (op.kind === "groove" || op.kind === "part") {
      const w = tool.width, isPart = op.kind === "part", zL = isPart ? zEnd - w : (op.z ?? -10), W = isPart ? w : (op.width ?? w), rB = isPart ? Math.max(0, (op.d ?? 0) / 2) : (op.d ?? 0) / 2;
      if (W < w - 1e-6) { bad("grooveNarrow", oi, w); return; }
      if (rB >= R - 1e-6 || rB < 0) { bad("grooveDepth", oi); return; }
      if (!isPart && (zL < zEnd - 1e-6 || zL + W > 1e-6)) bad("grooveOutside", oi);
      const cnt = Math.max(1, Math.ceil((W - w) / (w * 0.8) - 1e-6) + 1), bottom = cnt > 1 ? rB + 0.05 : rB;
      let rOut = Math.max(0, top(zL + w / 2, zL + W - w / 2)) + job.clear;
      setRpm(Math.max(1, (rOut - job.clear) * 2));
      if (rB < 0.02) bad("falls", oi, undefined, false);
      for (let k = 0; k < cnt; k++) {
        const z = zL + W - w / 2 - (cnt > 1 ? (W - w) * k / (cnt - 1) : 0);
        travel(z, Math.max(rOut, rB + job.clear), tool.feed);
        for (let r = Math.max(0, top(z, z)); r > bottom + 1e-6;) {
          r = Math.max(bottom, r - tool.ap);
          // nahe der Mitte langsamer (Abstechen)
          push(false, z, r, r < Math.min(3, R * 0.3) && isPart ? tool.feed * 0.5 : tool.feed);
          if (r > bottom + 1e-6) push(false, z, r + 0.2, tool.feed * 3);
        }
        push(false, z, Math.max(cr, rOut), tool.feed * 4);
        run.passes++;
      }
      if (cnt > 1) {
        travel(zL + W - w / 2, rOut, tool.feed);
        push(false, zL + W - w / 2, rB, tool.feed);
        push(false, zL + w / 2, rB, tool.feed);
        push(false, zL + w / 2, rOut, tool.feed * 4);
      }
      rOut = safeR;
    } else if (op.kind === "drill") {
      const depth = op.depth ?? 0;
      if (!(depth > 0)) { bad("drillDepth", oi); return; }
      if (tool.dia >= job.stockD) { bad("drillBig", oi); return; }
      if (depth > job.stickOut + 1e-6) bad("drillDeep", oi, depth, false);
      setRpm(tool.dia);
      const zTop = Math.max(0, rightEnd(S, g));
      // der Bohrer steht auf der Drehmitte: erst vor dem Teil zur Mitte, dann längs (die Außenform zählt hier nicht)
      const raw = (rapid: boolean, z: number, r: number, f: number) => {
        if (job.tailOn) bad("tailDrill", oi);
        if (rapid && z < zTop + 0.2 && r > 1e-6) bad("rapidHit", oi);
        const len = Math.hypot(z - cz, r - cr); seconds += rapid ? len / 1500 * 60 : len / Math.max(0.1, f * rpm) * 60;
        run.moves.push({ rapid, z, r, feed: rapid ? 0 : f, op: oi }); run.rpms.push(rpm); cz = z; cr = r;
      };
      raw(true, safeC, 0, 0);
      raw(true, zTop + job.clear, 0, 0);
      for (let z = zTop; z > -depth + 1e-6;) {
        const next = Math.max(-depth, z - tool.ap);
        if (z < zTop) { raw(true, zTop + job.clear, 0, 0); raw(true, z + 0.5, 0, 0); }
        raw(false, next, 0, tool.feed);
        z = next; run.passes++;
      }
      raw(true, safeC, 0, 0);
      raw(true, safeC, safeR, 0);
      runs.push(run);
      return;
    }
    // frei fahren: erst nach außen, dann vor das Teil
    if (cr < safeR) push(true, cz, safeR, 0);
    push(true, safeC - dz, safeR, 0);
    if (run.passes) runs.push(run);
  });
  return { runs, issues, grid: g, profile: p, stock, left: S, seconds, partLen };
}
const range = (a: number, b: number, d: 1 | -1) => { const o: number[] = []; for (let i = a; d > 0 ? i <= b : i >= b; i += d) o.push(i); return o; };
function rightEnd(S: Float64Array, g: Grid): number { for (let i = g.n - 1; i >= 0; i--) if (S[i] > 0.01) return zOf(g, i); return 0; }

// ---------------- G-Code ----------------
export interface LatheOut { xMode: "radius" | "dia" | "g8" | "g7"; xSign: 1 | -1; spindle: "auto" | "m8" | "hand"; dir: "M3" | "M4" }
export interface LatheText { (key: string, v?: Record<string, string | number>): string } // fertiger Kommentar ohne Klammern
export function latheGcode(plan: LathePlan, job: LatheJob, o: LatheOut, c: LatheText): string {
  const out: string[] = [], k = (o.xMode === "dia" || o.xMode === "g7" ? 2 : 1) * o.xSign;
  const f3 = (v: number) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3), X = (r: number) => "X" + f3(r * k), Z = (z: number) => "Z" + f3(z);
  const safeR = job.stockD / 2 + job.safeX, safeZ = job.faceAllow + job.safeZ, cm = (s: string) => `(${s})`;
  out.push(cm(c("title")), "G21 " + cm(c("mm")), "G90 " + cm(c("abs")), "G94 " + cm(c("feedMin")));
  if (o.xMode === "g7") out.push("G7 " + cm(c("g7")));
  if (o.xMode === "g8") out.push("G8 " + cm(c("g8")));
  // m8: Ein/Aus des Motorreglers hängt am Kühlmittel-Ausgang (Boards, bei denen M3 und S derselbe Ausgang sind)
  const ctl = o.spindle !== "hand", stopCode = () => { if (o.spindle === "m8") out.push("M9 " + cm(c("off"))); out.push("M5 " + cm(c("off"))); };
  let tool = "", on = 0;
  plan.runs.forEach((run, ri) => {
    const same = ri > 0 && tool === run.tool.id;
    if (ri > 0 && !same) {
      if (on && ctl) stopCode();
      out.push("M0 " + cm(c("tool", { n: run.tool.num, name: run.tool.name })));
      on = 0;
    }
    if (o.spindle === "hand") { if (on !== run.rpm) out.push("M0 " + cm(c("hand", { rpm: run.rpm }))); on = run.rpm; }
    // nach jeder Pause kann die Maschine von Hand verfahren worden sein: immer erst vor das Teil, dann nach außen
    // der Kommentar nennt Bearbeitung und Werkzeug (daran erkennt auch die Simulation, welcher Meißel dran ist)
    out.push(`G0 ${Z(safeZ)} ${cm(c("op." + run.op.kind, { n: run.tool.num, name: run.tool.name }))}`, `G0 ${X(safeR)}`);
    let rpm = on, feed = -1, lz = safeZ, lr = safeR;
    run.moves.forEach((m, i) => {
      const want = run.rpms[i];
      if (ctl && want !== rpm && (!on || m.rapid)) {
        out.push(`${o.dir} S${want} ${cm(c("on", { rpm: want }))}`);
        if (!on && o.spindle === "m8") out.push("M8 " + cm(c("on", { rpm: want })));
        if (!on) out.push("G4 P3 " + cm(c("spinUp")));
        rpm = on = want;
      }
      const w: string[] = [];
      if (Math.abs(m.z - lz) > 4e-4) w.push(Z(m.z));
      if (Math.abs(m.r - lr) > 4e-4) w.push(X(m.r));
      if (!w.length) return;
      // Vorschub je Minute aus der Drehzahl, die gerade läuft
      const F = Math.max(1, Math.round(m.feed * (o.spindle === "hand" ? run.rpm : rpm)));
      out.push(m.rapid ? `G0 ${w.join(" ")}` : `G1 ${w.join(" ")}${F !== feed ? ` F${F}` : ""}`);
      if (!m.rapid) feed = F;
      lz = m.z; lr = m.r;
    });
    tool = run.tool.id;
  });
  if (ctl) stopCode(); else out.push("M0 " + cm(c("handOff")));
  out.push("M30 " + cm(c("end")));
  return out.join("\n") + "\n";
}

// ---------------- Vorgaben ----------------
export const DEFAULT_LATHE_TOOLS: LatheTool[] = [
  { id: "l1", num: 1, name: "CCMT 80 R0.4", type: "turn", hand: "R", nose: 0.4, kappa: 95, eps: 80, width: 0, dia: 0, ap: 0.5, feed: 0.1, vcPct: 100 },
  { id: "l2", num: 2, name: "VCMT 35 R0.2", type: "turn", hand: "R", nose: 0.2, kappa: 93, eps: 35, width: 0, dia: 0, ap: 0.2, feed: 0.05, vcPct: 120 },
  { id: "l3", num: 3, name: "MGMN 2 mm", type: "groove", hand: "N", nose: 0, kappa: 90, eps: 0, width: 2, dia: 0, ap: 0.8, feed: 0.03, vcPct: 40 },
  { id: "l4", num: 4, name: "HSS 5 mm", type: "drill", hand: "N", nose: 0, kappa: 90, eps: 0, width: 0, dia: 5, ap: 2, feed: 0.05, vcPct: 25 },
];
/** vorsichtige Schnittgeschwindigkeiten (m/min) für Wendeplatten auf kleinen Drehbänken */
export const LATHE_MATERIALS: { id: string; vc: number; kc: number }[] = [
  { id: "alu", vc: 150, kc: 800 }, { id: "brass", vc: 120, kc: 900 }, { id: "steel", vc: 90, kc: 2000 }, { id: "stainless", vc: 60, kc: 2400 }, { id: "plastic", vc: 150, kc: 300 },
];
/** benötigte Leistung in W (Schruppen) */
export const powerW = (vc: number, ap: number, f: number, kc: number) => vc * ap * f * kc / 60;
