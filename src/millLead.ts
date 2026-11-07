/**
 * AN- UND WEGFAHREN beim Fräsen von Konturen (Lead-in / Lead-out) – reine Geometrie
 *
 * Statt auf der Kontur einzutauchen (hinterlässt eine Marke) taucht der Fräser im Abfall ein und fährt seitlich an:
 *   Bogen:  Viertelkreis, trifft die Bahn genau tangential
 *   Linie:  Gerade unter 45° von der Abfall-Seite
 * Abfall-Seite: außen vom Teil weg, innen zur Mitte des Lochs.
 *
 * Alles hier sind Bahnen des Fräser-MITTELPUNKTS. Die Bahn selbst hält schon den Radius Abstand zum Teil – solange der
 * Mittelpunkt auf der Abfall-Seite der Bahn bleibt, kann das An-/Wegfahren das Teil nicht beschädigen.
 * Passt es nirgends, kommt null zurück: cam.ts warnt dann und fräst wie ohne Anfahren.
 *
 * Nicht zu verwechseln mit dem Parameter `lead` von millPath/millTabbed: das ist die Schrupp-Bahn, auf der der
 * Schlichtgang eintaucht.
 */
import { pointInPoly, type P } from "./polyOffset.ts";

export type LeadType = "arc" | "line";
export interface LeadOpts { in: boolean; out: boolean; type: LeadType; len: number }
export type MillSide = "outside" | "inside";

export interface LeadMove {
  from: P;
  to: P;
  /** Punkte der Bewegung (von from bis to) – für die Prüfung und zum Rampen */
  pts: P[];
  /** nur beim Bogen: Befehl und Mittelpunkt relativ zu from */
  arc?: { cmd: "G2" | "G3"; i: number; j: number };
}
export interface LeadPlan { start: P; in: LeadMove | null; out: LeadMove | null }

export const LEAD_DEFAULT_LEN = 3;
export const LEAD_MIN = 0.1;
export const LEAD_MAX = 50;

/** Einstellungen der Form (bereinigt – können aus Projektdateien kommen); null = aus */
export function leadOptions(s: any): LeadOpts | null {
  if (!s || (s.leadIn !== true && s.leadOut !== true)) return null;
  const n = Number(s.leadLen);
  return {
    in: s.leadIn === true, out: s.leadOut === true,
    type: s.leadType === "line" ? "line" : "arc",
    len: Number.isFinite(n) && n > 0 ? Math.max(LEAD_MIN, Math.min(LEAD_MAX, n)) : LEAD_DEFAULT_LEN
  };
}

function area(pts: P[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return a / 2;
}
const unit = (a: P, b: P): P | null => {
  const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
  return l > 1e-9 ? { x: dx / l, y: dy / l } : null;
};

const ARC_SAMPLES = 16;

/**
 * Eine Bewegung. entering = zur Bahn hin (endet in p), sonst von der Bahn weg (beginnt in p).
 * t = Fahrtrichtung der Bahn in p, wasteLeft = Abfall liegt links der Fahrtrichtung.
 */
function makeMove(p: P, t: P, wasteLeft: boolean, type: LeadType, len: number, entering: boolean): LeadMove {
  const n = wasteLeft ? { x: -t.y, y: t.x } : { x: t.y, y: -t.x };
  const along = entering ? -1 : 1;
  if (type === "line") {
    const k = len * Math.SQRT1_2;
    const q = { x: p.x + n.x * k + t.x * k * along, y: p.y + n.y * k + t.y * k * along };
    const pts: P[] = [];
    for (let i = 0; i <= ARC_SAMPLES; i++) {
      const f = i / ARC_SAMPLES, a = entering ? q : p, b = entering ? p : q;
      pts.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    }
    return entering ? { from: q, to: p, pts } : { from: p, to: q, pts };
  }
  // Viertelkreis: Mittelpunkt auf der Abfall-Seite, an p genau tangential und in derselben Drehrichtung wie die Fahrt
  const c = { x: p.x + n.x * len, y: p.y + n.y * len };
  const q = { x: c.x + t.x * len * along, y: c.y + t.y * len * along };
  const from = entering ? q : p, to = entering ? p : q;
  const a0 = Math.atan2(from.y - c.y, from.x - c.x), sweep = wasteLeft ? Math.PI / 2 : -Math.PI / 2;
  const pts: P[] = [];
  for (let i = 0; i <= ARC_SAMPLES; i++) {
    const an = a0 + (sweep * i) / ARC_SAMPLES;
    pts.push({ x: c.x + Math.cos(an) * len, y: c.y + Math.sin(an) * len });
  }
  pts[0] = from; pts[ARC_SAMPLES] = to;
  return { from, to, pts, arc: { cmd: wasteLeft ? "G3" : "G2", i: c.x - from.x, j: c.y - from.y } };
}

/** Bleibt die Bewegung auf der Abfall-Seite? Punkte ganz nah an der Bahn zählen nicht (dort läuft sie ja an) */
function onWasteSide(m: LeadMove, p: P, loop: P[], side: MillSide, len: number): boolean {
  const near = Math.max(0.02, 0.15 * len);
  for (const q of m.pts) {
    if (Math.hypot(q.x - p.x, q.y - p.y) < near) continue;
    if (pointInPoly(q.x, q.y, loop) !== (side === "inside")) return false;
  }
  return true;
}

/**
 * An- und Wegfahren an einer festen Stelle der Bahn (Kreise, Bahnen mit Haltestegen).
 * Versucht die gewünschte Länge, dann die halbe. `free` prüft, ob andere Formen im Weg sind.
 */
export function leadAtPoint(p: P, tIn: P, tOut: P, loop: P[], ccw: boolean, side: MillSide, o: LeadOpts, free: (pts: P[]) => boolean): LeadPlan | null {
  const wasteLeft = ccw === (side === "inside");
  for (const len of [o.len, o.len / 2]) {
    const mIn = o.in ? makeMove(p, tIn, wasteLeft, o.type, len, true) : null;
    const mOut = o.out ? makeMove(p, tOut, wasteLeft, o.type, len, false) : null;
    const ok = (m: LeadMove | null) => !m || (onWasteSide(m, p, loop, side, len) && free(m.pts));
    if (ok(mIn) && ok(mOut)) return { start: p, in: mIn, out: mOut };
  }
  return null;
}

/**
 * Für eine geschlossene Bahn die beste Stelle suchen: zuerst die Mitte langer Geraden (dort sieht man die Marke am
 * wenigsten), dann gleichmäßig verteilte Ecken (runde Formen). Die Bahn fängt danach an dieser Stelle an.
 */
/** Wie planLead, aber der Start steht fest: An-/Wegfahren genau am ersten Punkt der Bahn (Startpunkt von Hand, cutSetting.ts) */
export function planLeadAtStart(loop: P[], side: MillSide, o: LeadOpts, free: (pts: P[]) => boolean): (LeadPlan & { loop: P[] }) | null {
  const n = loop.length;
  if (n < 3) return null;
  const tIn = unit(loop[n - 1], loop[0]), tOut = unit(loop[0], loop[1]);
  if (!tIn || !tOut) return null;
  const plan = leadAtPoint(loop[0], tIn, tOut, loop, area(loop) > 0, side, o, free);
  return plan ? { ...plan, loop } : null;
}

export function planLead(loop: P[], side: MillSide, o: LeadOpts, free: (pts: P[]) => boolean): (LeadPlan & { loop: P[] }) | null {
  const n = loop.length;
  if (n < 3) return null;
  const ccw = area(loop) > 0;
  const edges = loop.map((a, i) => ({ i, l: Math.hypot(loop[(i + 1) % n].x - a.x, loop[(i + 1) % n].y - a.y) }))
    .filter(e => e.l >= 1).sort((a, b) => b.l - a.l).slice(0, 12);
  for (const e of edges) {
    const a = loop[e.i], b = loop[(e.i + 1) % n], t = unit(a, b);
    if (!t) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const plan = leadAtPoint(mid, t, t, loop, ccw, side, o, free);
    if (plan) {
      const rest: P[] = [];
      for (let k = 1; k <= n; k++) rest.push(loop[(e.i + k) % n]);
      return { ...plan, loop: [mid, ...rest] };
    }
  }
  const tries = Math.min(n, 12);
  for (let c = 0; c < tries; c++) {
    const i = Math.floor((c * n) / tries);
    const t = unit(loop[(i - 1 + n) % n], loop[(i + 1) % n]);
    if (!t) continue;
    const plan = leadAtPoint(loop[i], t, t, loop, ccw, side, o, free);
    if (plan) return { ...plan, loop: [...loop.slice(i), ...loop.slice(0, i)] };
  }
  return null;
}

/** Kleinster Abstand eines Punktes zu einem Linienzug */
export function distToPath(p: P, path: P[], closed: boolean): number {
  let best = Infinity;
  const m = path.length;
  for (let i = 0; i < (closed ? m : m - 1); i++) {
    const a = path[i], b = path[(i + 1) % m], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const f = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(a.x + dx * f - p.x, a.y + dy * f - p.y));
  }
  return best;
}
