/**
 * PLASMA-G-CODE
 *
 * Pro Kontur:
 *   1. Schnittspalt-Ausgleich: außen um Spalt/2 nach außen, innen (Löcher) nach innen,
 *      "auf Linie" und offene Linien ohne Versatz (wie die Bahn-Korrektur beim Fräsen)
 *   2. Richtung: Teile im Uhrzeigersinn, Löcher gegen den Uhrzeigersinn
 *      (bei üblichem Gasdrall liegt die saubere Schnittkante dann am Teil)
 *   3. Startpunkt an einer Ecke (dort sieht man den Ansatz am wenigsten)
 *   4. Anfahrbahn (Lead-in) vom Abfall her: außen von außen, bei Löchern aus dem Loch
 *   5. Einstechen: auf Einstechhöhe, Brenner an (M3), warten, auf Schneidhöhe, schneiden
 *   6. Überlauf am Ende, Brenner aus (M5), hoch auf Sicherheitshöhe
 *
 * Höhenregelung (THC):
 *   - externe Box: nach dem Einstechen (Maschine steht ohnehin) über M8/M7 freigeben,
 *     nach M5 mit M9 sperren. Mitten im Schnitt wird nicht geschaltet – M7/M8/M9 lassen
 *     GRBL kurz anhalten, das gäbe eine Delle.
 *   - grblHAL-Plasma-Plugin: M63 P2 / M62 P2 schalten bewegungs-synchron, ohne Anhalten.
 *     Damit wird die THC kurz vor Konturende gesperrt (Anti-Dive: der Brenner taucht
 *     sonst beim Abbremsen ins Blech, weil die Lichtbogenspannung steigt).
 *   - Kleine Löcher: ohne THC und langsamer (sauberere Löcher, kein Abtauchen).
 *
 * Reihenfolge: Schnitte in Listen-Reihenfolge; darin offene Linien, dann geschlossene
 * Konturen von klein nach groß (Löcher vor dem Teil – sonst fällt das Teil vorher heraus).
 * Mit "Reihenfolge optimieren": innerhalb eines Schnitts die Reihenfolge mit den kürzesten
 * Leerfahrten, Löcher weiter vor ihrem Teil, Einstichpunkte unverändert (siehe cutOrder.ts).
 */
import { MM_TO_PIXEL, shapeToPaths, Pt } from "./shapeTransform";
import { offsetPolygon, polygonArea, pointInPoly } from "./polyOffset";
import { getCuts, cutForShape, plasmaSettings, PlasmaCut } from "./plasmaCuts";
import { t, ascii } from "./i18n/i18n";
import { tabRuns } from "./tabs";
import { RapidPlanner } from "./rapidAvoid";
import { optimizeCutOrder, travelLength, CutItem } from "./cutOrder";

const Z_FEED = 600;  // mm/min für Z-Bewegungen unter Last
const PROBE_FEED = 300;
const AVOID_MARGIN = 5; // mm Abstand der Leerfahrt-Umwege zu ausgeschnittenen Teilen

export interface PlasmaPlan {
  pts: Pt[];          // Kontur in Schneid-Richtung, beginnt am Startpunkt (mm)
  closed: boolean;
  lead: Pt | null;    // Einstichpunkt der Anfahrbahn (mm) – null = direkt auf der Kontur
  over: Pt[];         // Überlauf-Punkte nach dem Schließen
  area: number;
  hole: boolean;      // Innenkontur (Loch)
  size: number;       // größte Ausdehnung der Kontur in mm
  runs: Pt[][] | null; // mit Haltestegen: Schneid-Stücke (dazwischen Brenner aus, neu einstechen)
}

interface ShapePlan { plans: PlasmaPlan[]; tooSmall: boolean; leadShort: boolean }

// ---------------------------------------------------------------------
// Planung (mit Zwischenspeicher – wird auch fürs Zeichnen benutzt)
// ---------------------------------------------------------------------

const cache = new WeakMap<object, { sig: string; plan: ShapePlan }>();

function sigOf(shape: any, cut: PlasmaCut): string {
  let a = 0, b = 0;
  const pts = shape.points || [];
  for (let i = 0; i < pts.length; i++) { a += pts[i].x * (i % 7 + 1); b += pts[i].y * (i % 5 + 1); }
  return [shape.type, shape.millingMode, shape.x, shape.y, shape.w, shape.h, shape.midX, shape.midY, pts.length,
    a.toFixed(3), b.toFixed(3), cut.kerf, cut.leadIn, plasmaSettings.overcut,
    shape.tabMode, shape.tabN, shape.tabLen, JSON.stringify(shape.tabPts || [])].join("|");
}

export function planShape(shape: any, cut: PlasmaCut): ShapePlan {
  const sig = sigOf(shape, cut);
  const c = cache.get(shape);
  if (c && c.sig === sig) return c.plan;
  const plan = computePlan(shape, cut);
  cache.set(shape, { sig, plan });
  return plan;
}

function computePlan(shape: any, cut: PlasmaCut): ShapePlan {
  const res: ShapePlan = { plans: [], tooSmall: false, leadShort: false };
  const mode = shape.millingMode || "outside";
  for (const path of shapeToPaths(shape)) {
    if (path.pts.length < 2) continue;
    const pts = path.pts.map(p => ({ x: p.x / MM_TO_PIXEL, y: p.y / MM_TO_PIXEL }));

    if (!path.closed || mode === "on-line") {
      res.plans.push({ pts, closed: path.closed, lead: null, over: [], area: 0, hole: false, size: extent(pts), runs: null });
      continue;
    }
    const outside = mode === "outside";
    let loops: Pt[][] = [pts];
    if (cut.kerf > 0) {
      try { loops = offsetPolygon(pts, (outside ? 1 : -1) * (cut.kerf / 2), 0.02); } catch { loops = []; }
    }
    if (!loops.length) { res.tooSmall = true; continue; }

    for (let loop of loops) {
      loop = cleanLoop(loop, 0.05);
      if (loop.length < 3) continue;
      // Richtung: außen im Uhrzeigersinn, Löcher gegen den Uhrzeigersinn
      const ccw = polygonArea(loop) > 0;
      if (outside === ccw) loop = loop.slice().reverse();
      // Startpunkt an der schärfsten Ecke
      const si = cornerIndex(loop);
      loop = loop.slice(si).concat(loop.slice(0, si));
      let lead = leadPoint(loop, outside, cut.leadIn);
      if (cut.leadIn > 0 && !lead) res.leadShort = true;
      // Haltestege: Lücke auf der Bahn = Steglänge + Schnittspalt; kein Überlauf (der liefe in einen Steg)
      const tr = tabRuns(shape, loop, q => ({ x: q.x / MM_TO_PIXEL, y: q.y / MM_TO_PIXEL }), (Number(shape.tabLen) || 0) + cut.kerf);
      if (tr?.rotated) lead = null;
      res.plans.push({ pts: loop, closed: true, lead, over: tr ? [] : overcutPoints(loop, plasmaSettings.overcut), area: Math.abs(polygonArea(loop)), hole: !outside, size: extent(loop), runs: tr ? tr.runs : null });
    }
  }
  return res;
}

const lastOf = (pts: Pt[]) => pts[pts.length - 1];

/** größte Ausdehnung (Breite oder Höhe) */
function extent(pts: Pt[]): number {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return pts.length ? Math.max(x1 - x0, y1 - y0) : 0;
}

/** Ist das ein "kleines Loch" (ohne THC, langsamer)? */
export function isSmallHole(p: PlasmaPlan): boolean {
  return p.closed && p.hole && plasmaSettings.smallHole > 0 && p.size <= plasmaSettings.smallHole + 1e-9;
}

/**
 * Kontur kurz vor dem Ende teilen: liefert die Ziel-Punkte und den Index, ab dem
 * (nach dem eingefügten Teilungspunkt) die letzten `rest` mm beginnen. -1 = zu kurz.
 */
export function splitBeforeEnd(start: Pt, targets: Pt[], rest: number): { pts: Pt[]; at: number } {
  let total = 0, prev = start;
  for (const q of targets) { total += Math.hypot(q.x - prev.x, q.y - prev.y); prev = q; }
  if (!(rest > 0) || total <= rest + 1e-6) return { pts: targets, at: -1 };
  const cut = total - rest;
  let run = 0;
  prev = start;
  for (let i = 0; i < targets.length; i++) {
    const q = targets[i];
    const d = Math.hypot(q.x - prev.x, q.y - prev.y);
    if (run + d >= cut - 1e-9) {
      const f = d > 0 ? (cut - run) / d : 1;
      if (f >= 1 - 1e-6) return { pts: targets, at: i + 1 };   // genau auf einem Punkt
      const m = { x: prev.x + (q.x - prev.x) * f, y: prev.y + (q.y - prev.y) * f };
      return { pts: [...targets.slice(0, i), m, ...targets.slice(i)], at: i + 1 };
    }
    run += d;
    prev = q;
  }
  return { pts: targets, at: -1 };
}

/**
 * Kontur aufräumen: Punkte näher als tol zusammenfassen und "Zacken" entfernen
 * (Hin-und-zurück-Stücke, wie sie beim Versetzen entstehen können).
 */
function cleanLoop(loop: Pt[], tol: number): Pt[] {
  let pts: Pt[] = [];
  for (const p of loop) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > tol) pts.push(p);
  }
  while (pts.length > 3 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= tol) pts.pop();
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const n = pts.length;
      const a = pts[(i - 1 + n) % n], p = pts[i], b = pts[(i + 1) % n];
      const ux = p.x - a.x, uy = p.y - a.y, vx = b.x - p.x, vy = b.y - p.y;
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      // fast genau umkehren = Zacke
      if (lu > 0 && lv > 0 && (ux * vx + uy * vy) / (lu * lv) < -0.95) { pts.splice(i, 1); changed = true; i--; }
    }
  }
  return pts;
}

/** Punkt, der auf der Kontur mindestens dist vom Index i entfernt liegt (vor- oder rückwärts) */
function farPoint(loop: Pt[], i: number, step: 1 | -1, dist: number): Pt {
  const n = loop.length, p = loop[i];
  for (let k = 1; k < n; k++) {
    const q = loop[((i + step * k) % n + n) % n];
    if (Math.hypot(q.x - p.x, q.y - p.y) >= dist) return q;
  }
  return loop[((i + step) % n + n) % n];
}

/** Index der schärfsten Ecke (Richtungsänderung > 30°), sonst 0 */
export function cornerIndex(loop: Pt[]): number {
  let best = 0, bestTurn = 0.52; // ~30°
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    // Richtung über mindestens 0,5 mm messen – winzige Stücke täuschen sonst Ecken vor
    const a = farPoint(loop, i, -1, 0.5), p = loop[i], b = farPoint(loop, i, 1, 0.5);
    const ux = p.x - a.x, uy = p.y - a.y, vx = b.x - p.x, vy = b.y - p.y;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-6 || lv < 1e-6) continue;
    const turn = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
    if (turn > bestTurn) { bestTurn = turn; best = i; }
  }
  return best;
}

/**
 * Einstichpunkt senkrecht zur Kontur auf der Abfallseite. Bei kleinen Löchern wird die
 * Anfahrbahn verkürzt; passt gar nichts, wird direkt auf der Kontur eingestochen.
 */
export function leadPoint(loop: Pt[], outside: boolean, len: number): Pt | null {
  if (!(len > 0)) return null;
  const p0 = loop[0];
  // Richtung am Start: Mittel aus ankommender und abgehender Strecke
  const prev = farPoint(loop, 0, -1, 0.5), next = farPoint(loop, 0, 1, 0.5);
  let dx = (next.x - p0.x) / (Math.hypot(next.x - p0.x, next.y - p0.y) || 1)
         + (p0.x - prev.x) / (Math.hypot(p0.x - prev.x, p0.y - prev.y) || 1);
  let dy = (next.y - p0.y) / (Math.hypot(next.x - p0.x, next.y - p0.y) || 1)
         + (p0.y - prev.y) / (Math.hypot(p0.x - prev.x, p0.y - prev.y) || 1);
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) { dx = next.x - p0.x; dy = next.y - p0.y; } else { dx /= l; dy /= l; }
  for (let L = len, k = 0; k < 4; k++, L /= 2) {
    for (const s of [1, -1]) {
      const nx = -dy * s, ny = dx * s;
      const q = { x: p0.x + nx * L, y: p0.y + ny * L };
      const mid = { x: p0.x + nx * L * 0.5, y: p0.y + ny * L * 0.5 };
      const inQ = pointInPoly(q.x, q.y, loop), inM = pointInPoly(mid.x, mid.y, loop);
      // außen: Einstich außerhalb des Teils; Loch: Einstich im Loch
      if (outside ? (!inQ && !inM) : (inQ && inM)) return q;
    }
  }
  return null;
}

/** Punkte für den Überlauf: vom Startpunkt aus ein Stück die Kontur entlang */
function overcutPoints(loop: Pt[], len: number): Pt[] {
  const out: Pt[] = [];
  let rest = len;
  for (let i = 1; i <= loop.length && rest > 1e-6; i++) {
    const a = loop[i - 1], b = loop[i % loop.length];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d < 1e-9) continue;
    if (d >= rest) { out.push({ x: a.x + (b.x - a.x) * (rest / d), y: a.y + (b.y - a.y) * (rest / d) }); rest = 0; }
    else { out.push(b); rest -= d; }
  }
  return out;
}

// ---------------------------------------------------------------------
// G-Code
// ---------------------------------------------------------------------

export function generatePlasmaGcode(shapes: any[]): { gcode: string | null; warnings: string[] } {
  const warnings: string[] = [];
  if (!shapes.length) return { gcode: null, warnings };
  const S = plasmaSettings;
  const c = (key: string, p?: Record<string, string | number>) => `(${ascii(t(key, p))})`;
  const n = (v: number) => String(+v.toFixed(3));

  const byCut = new Map<string, any[]>();
  for (const s of shapes) {
    const cut = cutForShape(s);
    if (!cut) continue;
    if (!byCut.has(cut.id)) byCut.set(cut.id, []);
    byCut.get(cut.id)!.push(s);
  }
  const order = getCuts().filter(cu => byCut.has(cu.id));

  const thcOn = S.thc === "external" ? `${S.thcOut} ${c("pgc.thcOn")}`
    : S.thc === "grblhal" ? `M63 P2 ${c("pgc.thcOn")}` : "";
  const thcOff = S.thc === "external" ? `M9 ${c("pgc.thcOff")}`
    : S.thc === "grblhal" ? `M62 P2 ${c("pgc.thcOff")}` : "";
  if (S.thc === "external" && S.useZ && !S.probe) warnings.push(t("pgw.thcProbe"));

  let g = "";
  g += `G21 ${c("gc.unitMm")}\n`;
  g += `G90 ${c("gc.absolute")}\n`;
  g += `M5 ${c("pgc.torchOffStart")}\n`;
  if (S.thc === "external") g += `M9 ${c("pgc.thcOff")}\n`;
  if (S.thc === "grblhal") g += `${c("pgc.thcHal")}\nM64 P2 ${c("pgc.thcOff")}\n`;
  g += `${c("pgc.header", { n: order.length })}\n`;
  if (S.useZ) g += `G0 Z${n(S.safeZ)} ${c("gc.safeZ")}\n`;
  let pierces = 0, smallHoles = 0;
  // Leerfahrten um schon ausgeschnittene Teile herum (sie können kippen)
  const avoid = S.avoidCut ? new RapidPlanner(AVOID_MARGIN) : null;
  let pos: Pt | null = null;
  const rapid = (to: Pt, note = "") => {
    if (avoid && pos) for (const v of avoid.route(pos, to)) g += `G0 X${n(v.x)} Y${n(v.y)} ${c("gc.avoid")}\n`;
    g += `G0 X${n(to.x)} Y${n(to.y)}${note}\n`;
    pos = to;
  };

  order.forEach((cut, ci) => {
    g += `\n${c("pgc.cut", { i: ci + 1, name: cut.name, f: cut.speed, k: cut.kerf })}\n`;
    const plans: PlasmaPlan[] = [];
    byCut.get(cut.id)!.forEach((s, si) => {
      const sp = planShape(s, cut);
      if (sp.tooSmall) warnings.push(t("pgw.tooSmall", { name: cut.name, n: si + 1, k: cut.kerf }));
      if (sp.leadShort) warnings.push(t("pgw.leadShort", { name: cut.name, n: si + 1 }));
      plans.push(...sp.plans);
    });
    // offene Linien zuerst, dann geschlossene von klein nach groß
    plans.sort((a, b) => (a.closed ? 1 : 0) - (b.closed ? 1 : 0) || a.area - b.area);
    // kürzeste Leerfahrten: Einstichpunkte bleiben, Löcher weiter vor ihrem Teil (siehe cutOrder.ts)
    if (S.optimizeOrder && plans.length > 1) {
      const items: CutItem[] = plans.map(p => ({
        entry: p.runs ? (p.lead || p.runs[0][0]) : (p.lead || p.pts[0]),
        exit: p.runs ? lastOf(p.runs[p.runs.length - 1]) : p.over.length ? lastOf(p.over) : p.closed ? p.pts[0] : lastOf(p.pts),
        pts: p.pts, closed: p.closed
      }));
      const from = pos || { x: 0, y: 0 };
      const steps = optimizeCutOrder(items, from);
      const before = travelLength(items, items.map((_, i) => ({ index: i, reversed: false, start: 0 })), from);
      const after = travelLength(items, steps, from);
      g += `${c("gc.orderOpt", { a: Math.round(before), b: Math.round(after) })}\n`;
      plans.splice(0, plans.length, ...steps.map(st => plans[st.index]));
    }

    for (const p of plans) {
      const small = isSmallHole(p);
      if (small) smallHoles++;
      const thc = !!thcOn && !small;
      // Stücke zum Schneiden: normal eins; mit Haltestegen eins pro Abschnitt zwischen den Stegen
      const pieces: { start: Pt; targets: Pt[] }[] = [];
      if (p.runs) {
        p.runs.forEach((run, ri) => pieces.push(ri === 0 && p.lead ? { start: p.lead, targets: run } : { start: run[0], targets: run.slice(1) }));
      } else {
        const targets: Pt[] = [];
        if (p.lead) targets.push(p.pts[0]);
        for (let i = 1; i < p.pts.length; i++) targets.push(p.pts[i]);
        if (p.closed) { targets.push(p.pts[0]); targets.push(...p.over); }
        pieces.push({ start: p.lead || p.pts[0], targets });
      }
      pieces.forEach((pc, k) => {
        const start = pc.start;
        pierces++;
        g += `${c("pgc.pierce", { n: pierces })}${small ? " " + c("pgc.smallHole", { d: n(p.size), p: S.holeSpeed }) : ""}${k > 0 ? " " + c("gc.tab") : ""}\n`;
        rapid(start);
        if (S.useZ) {
          if (S.probe) {
            // relativ ab der aktuellen Höhe – ein fester Zielwert reicht nicht, wenn Z0 weit über dem Blech liegt
            g += `G91 G38.2 Z${n(-S.probeDist)} F${PROBE_FEED} ${c("pgc.probe")}\n`;
            g += `G90\n`;
            g += `G92 Z${n(S.probeOffset)} ${c("pgc.probeSet")}\n`;
          }
          g += `G0 Z${n(cut.pierceHeight)} ${c("pgc.pierceHeight")}\n`;
        }
        g += `M3 S1000 ${c("pgc.torchOn")}\n`;
        if (cut.pierceDelay > 0) g += `G4 P${n(cut.pierceDelay)} ${c("pgc.pierceDelay")}\n`;
        if (S.useZ) g += `G1 Z${n(cut.cutHeight)} F${Z_FEED} ${c("pgc.cutHeight")}\n`;
        // THC erst freigeben, wenn die Maschine auf Schneidhöhe steht (vor der ersten Bewegung)
        if (thc) g += `${thcOn}\n`;
        g += `G1 F${n(small ? cut.speed * S.holeSpeed / 100 : cut.speed)}\n`;

        // Anti-Dive: nur grblHAL kann mitten in der Bewegung ohne Anhalten sperren
        const sp = thc && S.thc === "grblhal" ? splitBeforeEnd(start, pc.targets, S.antiDive) : { pts: pc.targets, at: -1 };
        sp.pts.forEach((q, i) => {
          if (i === sp.at) g += `M62 P2 ${c("pgc.antiDive")}\n`;
          g += `G1 X${n(q.x)} Y${n(q.y)}\n`;
        });
        g += `M5 ${c("pgc.torchOff")}\n`;
        if (thc && sp.at < 0) g += `${thcOff}\n`;
        if (S.useZ) g += `G0 Z${n(S.safeZ)}\n`;
        pos = sp.pts[sp.pts.length - 1] || start;
      });
      // ganz ausgeschnitten (ohne Haltestege) -> kann kippen, ab jetzt umfahren
      if (avoid && p.closed && !p.runs) avoid.addCut(p.pts);
    }
  });

  if (smallHoles) g += `${c("pgc.smallHoles", { n: smallHoles })}\n`;
  g += `\nM5\n`;
  if (thcOff) g += `${S.thc === "grblhal" ? "M64 P2" : "M9"}\n`;
  if (S.useZ) g += `G0 Z${n(S.safeZ)}\n`;
  // Verschiebung durchs Abtasten (G92) wieder aufheben – sonst stimmt Z beim nächsten Job nicht
  if (S.useZ && S.probe) g += `G92.1 ${c("pgc.probeClear")}\n`;
  rapid({ x: 0, y: 0 }, " " + c("gc.park"));
  g += `M30 ${c("gc.end")}\n`;
  return { gcode: g, warnings };
}

// ---------------------------------------------------------------------
// Vorschau auf der Zeichenfläche: Anfahrbahnen + Einstichpunkte
// ---------------------------------------------------------------------

export function drawPlasmaLeads(ctx: CanvasRenderingContext2D, shapes: any[], sx: (x: number) => number, sy: (y: number) => number) {
  ctx.save();
  ctx.lineWidth = 1.5;
  const px = (v: number) => v * MM_TO_PIXEL;
  for (const s of shapes) {
    const cut = cutForShape(s);
    if (!cut) continue;
    const sp = planShape(s, cut);
    for (const p of sp.plans) {
      const st = p.pts[0];
      const pierce = p.lead || st;
      if (p.lead) {
        ctx.strokeStyle = cut.color;
        ctx.beginPath();
        ctx.moveTo(sx(px(p.lead.x)), sy(px(p.lead.y)));
        ctx.lineTo(sx(px(st.x)), sy(px(st.y)));
        ctx.stroke();
      }
      // Einstich: kleiner Kreis mit Kreuz
      const x = sx(px(pierce.x)), y = sy(px(pierce.y));
      ctx.strokeStyle = "#fff";
      ctx.fillStyle = cut.color;
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Richtungspfeil kurz nach dem Start
      if (p.pts.length > 1) {
        const b = p.pts[1];
        const ax = sx(px(st.x)), ay = sy(px(st.y)), bx = sx(px(b.x)), by = sy(px(b.y));
        const d = Math.hypot(bx - ax, by - ay);
        if (d > 12) {
          const ux = (bx - ax) / d, uy = (by - ay) / d;
          const tx = ax + ux * Math.min(22, d * 0.5), ty = ay + uy * Math.min(22, d * 0.5);
          ctx.fillStyle = cut.color;
          ctx.beginPath();
          ctx.moveTo(tx + ux * 5, ty + uy * 5);
          ctx.lineTo(tx - ux * 3 - uy * 4, ty - uy * 3 + ux * 4);
          ctx.lineTo(tx - ux * 3 + uy * 4, ty - uy * 3 - ux * 4);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
    if (sp.tooSmall) {
      ctx.save();
      ctx.strokeStyle = "#ff4d4d";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      for (const path of shapeToPaths(s)) {
        if (path.pts.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(sx(path.pts[0].x), sy(path.pts[0].y));
        for (let i = 1; i < path.pts.length; i++) ctx.lineTo(sx(path.pts[i].x), sy(path.pts[i].y));
        if (path.closed) ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  ctx.restore();
}
