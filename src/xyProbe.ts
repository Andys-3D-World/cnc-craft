/**
 * X/Y ANTASTEN – Rechnung und Ablauf ohne Oberfläche (Tests mit simulierter Maschine: tests/xyProbe.test.ts)
 *
 * Kante, Außenecke, Innenecke, Mitte einer Bohrung/Tasche – und die Mitte eines Teils aus vier einzelnen Kanten.
 *
 * SICHERHEIT
 *  - Z wird NIE bewegt: Man stellt die Spitze selbst auf die richtige Höhe neben (bzw. in) das Teil. Alles bleibt auf dieser Höhe.
 *  - Jede Fahrt ist überwacht: Meldet der Taster unterwegs Kontakt, wird sofort angehalten.
 *  - Gefahren wird in kurzen Stücken ($J=G91 …), von denen nie mehr als AHEAD_S Sekunden in der Maschine liegen. Reißt die
 *    Verbindung ab oder schläft das Fenster ein, bleibt sie nach diesem kleinen Rest von selbst stehen.
 *  - Nichts geht weiter als der eingestellte Suchweg; wird nichts gefunden, geht es zurück zum Anfang.
 *  - Nach einem Abbruch kommt keine Fahrt mehr.
 *  - Der Nullpunkt wird erst gesetzt, wenn alle Messungen zusammenpassen – und zwar dort, wo die Spitze gerade steht
 *    (kein Anfahren der Ecke nötig).
 */

export interface XYState { x: number; y: number; contact: boolean; state: string }
export interface XYIO {
  /** kurze relative Fahrt; erfüllt, wenn die Maschine sie angenommen hat (false = Fehler/Alarm) */
  jog(dx: number, dy: number, feed: number): Promise<boolean>;
  /** frischer Statusbericht (null = Verbindung weg oder kein Bericht) */
  status(): Promise<XYState | null>;
  /** Jog-Abbruch */
  cancel(): Promise<void>;
  aborted(): boolean;
  now(): number;
}

export type XYErr = "aborted" | "lost" | "alarm" | "jog" | "noContact" | "contactOnWay" | "stuck" | "unstable" | "timeout" | "size";
export class XYFail extends Error { code: XYErr; constructor(code: XYErr) { super(code); this.code = code; } }

export interface XYOpts {
  tip: number;      // Ø der Kugel bzw. des Stifts (mm)
  side: number;     // Dicke der Platte zwischen Spitze und Teil (mm), 0 = direkt am Teil
  search: number;   // so weit wird höchstens gesucht (mm)
  along: number;    // Außenecke: so weit am Teil entlang, bevor getastet wird (mm)
}
export const XY_DEF: XYOpts = { tip: 3, side: 0, search: 15, along: 10 };
export const XY_LIMITS: Record<keyof XYOpts, [number, number]> = { tip: [0, 25], side: [0, 60], search: [2, 100], along: [3, 40] };

const num = (v: any, d: number, [lo, hi]: [number, number]) => { const n = typeof v === "number" ? v : parseFloat(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
export function cleanXY(o: any): XYOpts {
  const out = { ...XY_DEF };
  for (const k of Object.keys(XY_LIMITS) as (keyof XYOpts)[]) out[k] = num(o?.[k], XY_DEF[k], XY_LIMITS[k]);
  return out;
}

export const FAST = 100, SLOW = 25, TRAVEL = 200; // mm/min
/** so viele Sekunden Fahrt liegen höchstens in der Maschine */
export const AHEAD_S = 0.8;
const CHUNK_S = 0.4;
const BACK = 2, BACK_MAX = 8;

type Dir = { x: number; y: number };
const good = (io: XYIO, s: XYState | null): XYState => {
  if (io.aborted()) throw new XYFail("aborted");
  if (!s) throw new XYFail("lost");
  if (s.state.startsWith("Alarm")) throw new XYFail("alarm");
  return s;
};

/** Warten, bis die Maschine steht (zwei Berichte „Idle“) */
async function still(io: XYIO): Promise<XYState> {
  const end = io.now() + 10000;
  let idle = 0;
  for (;;) {
    const s = good(io, await io.status());
    idle = s.state.startsWith("Idle") ? idle + 1 : 0;
    if (idle >= 2) return s;
    if (io.now() > end) throw new XYFail("timeout");
  }
}

/**
 * Überwachte Fahrt. until "end" = ganze Strecke, Kontakt ist ein Fehler; "contact" = bis Kontakt; "free" = bis der Taster frei ist.
 * Gezählt wird ein Kontakt erst, wenn zwei Berichte nacheinander ihn zeigen (Störimpulse vom Schrittmotor-Takt).
 * Rückgabe: wurde das Ziel (Kontakt bzw. frei) erreicht, und wo die Maschine steht.
 */
async function drive(io: XYIO, d: Dir, dist: number, feed: number, until: "end" | "contact" | "free"): Promise<{ hit: boolean; at: XYState }> {
  const from = await still(io);
  if (!(dist > 1e-4)) return { hit: false, at: from };
  const v = feed / 60, chunk = Math.max(0.05, v * CHUNK_S);
  const limit = io.now() + (dist / v) * 1000 * 3 + 10000;
  let sent = 0, hits = 0, seen = from, begun = 0;
  const done = (s: XYState) => (s.x - from.x) * d.x + (s.y - from.y) * d.y;
  for (;;) {
    for (;;) {
      const c = Math.min(chunk, dist - sent);
      if (!(c > 1e-6) || sent + c - done(seen) > v * AHEAD_S + 1e-6) break;
      if (io.aborted()) throw new XYFail("aborted");
      if (!await io.jog(d.x * c, d.y * c, feed)) { await io.cancel(); throw new XYFail(io.aborted() ? "aborted" : "jog"); }
      sent += c;
      if (!begun) begun = io.now();
    }
    let s: XYState;
    try { s = seen = good(io, await io.status()); }
    catch (e) { await io.cancel().catch(() => undefined); throw e; }
    const want = until === "free" ? !s.contact : s.contact;
    hits = want ? hits + 1 : 0;
    if (hits >= 2) {
      await io.cancel();
      const at = await still(io);
      if (until !== "end") return { hit: true, at };
      throw new XYFail("contactOnWay");
    }
    if (sent >= dist - 1e-6 && s.state.startsWith("Idle") && (done(s) > dist - 0.05 || io.now() - begun > (dist / v) * 1000 + 3000)) return { hit: false, at: await still(io) };
    if (io.now() > limit) { await io.cancel(); throw new XYFail("timeout"); }
  }
}

/** Überwachte Fahrt zu einer Stelle (Maschinenkoordinaten), erst X, dann Y oder umgekehrt */
async function goTo(io: XYIO, x: number, y: number, first: "x" | "y"): Promise<void> {
  for (const a of first === "x" ? ["x", "y"] as const : ["y", "x"] as const) {
    const s = await still(io), diff = a === "x" ? x - s.x : y - s.y;
    const d = a === "x" ? { x: Math.sign(diff), y: 0 } : { x: 0, y: Math.sign(diff) };
    await drive(io, d, Math.abs(diff), TRAVEL, "end");
  }
}

/** Weg vom Kontakt: 2 mm, ist der Taster dann noch zu, weiter bis höchstens 8 mm */
async function backOff(io: XYIO, d: Dir): Promise<number> {
  const a = await still(io), away = { x: -d.x, y: -d.y };
  if (!(await drive(io, away, BACK_MAX, TRAVEL / 2, "free")).hit) throw new XYFail("stuck");
  const r = await drive(io, away, BACK, TRAVEL / 2, "end").catch(e => { throw e instanceof XYFail && e.code === "contactOnWay" ? new XYFail("stuck") : e; });
  return Math.hypot(r.at.x - a.x, r.at.y - a.y);
}

/** Schnell suchen, zurück, langsam messen. Rückgabe: Lage der Spitzen-MITTE beim Kontakt; die Spitze steht danach frei */
async function touch(io: XYIO, d: Dir, dist: number): Promise<XYState> {
  // Störimpuls: hielt an, der Taster ist aber offen → mit dem Rest weitersuchen
  const seek = async (len: number, feed: number): Promise<XYState | null> => {
    let left = len;
    for (let glitch = 0; glitch < 10 && left > 0.02; glitch++) {
      const a = await still(io), r = await drive(io, d, left, feed, "contact");
      if (!r.hit) return null;
      const s1 = good(io, await io.status()), s2 = good(io, await io.status());
      if (s1.contact && s2.contact) return r.at;
      left -= Math.max(0, (r.at.x - a.x) * d.x + (r.at.y - a.y) * d.y);
    }
    return null;
  };
  const p1 = await seek(dist, FAST);
  if (!p1) throw new XYFail("noContact");
  const back = await backOff(io, d);
  const p2 = await seek(back + 1, SLOW);
  if (!p2) throw new XYFail("unstable");
  // die schnelle Suche läuft etwas nach: p2 liegt normal davor. Liegt es deutlich dahinter, war der erste Kontakt eine Störung
  if ((p2.x - p1.x) * d.x + (p2.y - p1.y) * d.y > 0.5 || Math.hypot(p2.x - p1.x, p2.y - p1.y) > 3) throw new XYFail("unstable");
  await backOff(io, d);
  return p2;
}

/** Wird nichts gefunden (oder unterwegs angestoßen), zurück zum Anfang – so steht die Spitze nicht irgendwo */
async function withReturn<T>(io: XYIO, fn: (s0: XYState) => Promise<T>): Promise<T> {
  const s0 = await still(io);
  try { return await fn(s0); }
  catch (e) {
    if (e instanceof XYFail && (e.code === "noContact" || e.code === "unstable" || e.code === "size") && !io.aborted()) {
      // den letzten Weg rückwärts: die zuletzt gefahrene Achse zuerst
      try { const s = await still(io); await goTo(io, s0.x, s0.y, Math.abs(s.x - s0.x) < Math.abs(s.y - s0.y) ? "y" : "x"); } catch { /* bleibt stehen */ }
    }
    throw e;
  }
}

export const XY_DIRS = { xp: { x: 1, y: 0 }, xn: { x: -1, y: 0 }, yp: { x: 0, y: 1 }, yn: { x: 0, y: -1 } } as const;
export type XYDir = keyof typeof XY_DIRS;

/** Kante in einer Richtung; Rückgabe: Maschinen-Koordinate der Kante auf dieser Achse. Danach wieder am Anfang */
export function probeEdge(io: XYIO, dir: XYDir, o: XYOpts): Promise<number> {
  const d = XY_DIRS[dir];
  return withReturn(io, async s0 => {
    const p = await touch(io, d, o.search);
    await goTo(io, s0.x, s0.y, "x");
    return d.x ? p.x + d.x * (o.tip / 2 + o.side) : p.y + d.y * (o.tip / 2 + o.side);
  });
}

/** Ecke: cx −1 links / +1 rechts, cy −1 vorne / +1 hinten */
export interface Corner { cx: -1 | 1; cy: -1 | 1 }

/**
 * AUSSENECKE: Die Spitze steht schräg außerhalb der Ecke, schon auf Tast-Höhe. Am Teil entlang, quer herantasten, zurück –
 * dasselbe für die andere Kante. Alles im Freien neben dem Teil.
 */
export function probeOuterCorner(io: XYIO, c: Corner, o: XYOpts): Promise<{ x: number; y: number }> {
  return withReturn(io, async s0 => {
    const ix = -c.cx, iy = -c.cy, off = o.tip / 2 + o.side;
    await drive(io, { x: 0, y: iy }, o.along, TRAVEL, "end");
    const px = await touch(io, { x: ix, y: 0 }, o.search);
    await goTo(io, s0.x, s0.y, "x");
    await drive(io, { x: ix, y: 0 }, o.along, TRAVEL, "end");
    const py = await touch(io, { x: 0, y: iy }, o.search);
    await goTo(io, s0.x, s0.y, "y");
    return { x: px.x + ix * off, y: py.y + iy * off };
  });
}

/** INNENECKE (Tasche, Anschlag): Die Spitze steht in der Tasche vor der Ecke */
export function probeInnerCorner(io: XYIO, c: Corner, o: XYOpts): Promise<{ x: number; y: number }> {
  return withReturn(io, async s0 => {
    const px = await touch(io, { x: c.cx, y: 0 }, o.search);
    await goTo(io, s0.x, s0.y, "x");
    const py = await touch(io, { x: 0, y: c.cy }, o.search);
    await goTo(io, s0.x, s0.y, "y");
    return { x: px.x + c.cx * o.tip / 2, y: py.y + c.cy * o.tip / 2 };
  });
}

export interface Centre { x: number; y: number; w: number; h: number }

/** MITTE einer Bohrung oder rechteckigen Tasche; die Spitze steht ungefähr in der Mitte und danach genau darin */
export function probeHole(io: XYIO, o: XYOpts): Promise<Centre> {
  return withReturn(io, async s0 => {
    const l = await touch(io, XY_DIRS.xn, o.search);
    await goTo(io, s0.x, s0.y, "x");
    const r = await touch(io, XY_DIRS.xp, o.search);
    const x = (l.x + r.x) / 2, w = r.x - l.x + o.tip;
    await goTo(io, x, s0.y, "x");
    const f = await touch(io, XY_DIRS.yn, o.search);
    await goTo(io, x, s0.y, "y");
    const b = await touch(io, XY_DIRS.yp, o.search);
    const y = (f.y + b.y) / 2, h = b.y - f.y + o.tip;
    if (!(w > o.tip && h > o.tip)) throw new XYFail("size");
    await goTo(io, x, y, "y");
    return { x, y, w, h };
  });
}

/** MITTE EINES TEILS aus einzelnen Kanten (links, rechts, vorne, hinten in Maschinen-Koordinaten) */
export interface Sides { left?: number; right?: number; front?: number; back?: number }
/** Kante → Seite: nach +X getastet ist die linke Seite usw. */
export const SIDE_OF: Record<XYDir, keyof Sides> = { xp: "left", xn: "right", yp: "front", yn: "back" };
export function sidesCentre(s: Sides): { x?: number; y?: number; w?: number; h?: number } {
  const out: { x?: number; y?: number; w?: number; h?: number } = {};
  if (s.left !== undefined && s.right !== undefined && s.right > s.left) { out.x = (s.left + s.right) / 2; out.w = s.right - s.left; }
  if (s.front !== undefined && s.back !== undefined && s.back > s.front) { out.y = (s.front + s.back) / 2; out.h = s.back - s.front; }
  return out;
}

/** Nullpunkt so setzen, dass die gemessene Stelle den Wert val bekommt – die Spitze steht bei pos (beides Maschinen-Koordinaten) */
export function zeroLine(pos: { x: number; y: number }, found: { x?: number; y?: number }, val = { x: 0, y: 0 }): string | null {
  const parts: string[] = [];
  if (found.x !== undefined) parts.push(`X${(pos.x - found.x + val.x).toFixed(3)}`);
  if (found.y !== undefined) parts.push(`Y${(pos.y - found.y + val.y).toFixed(3)}`);
  return parts.length ? `G10 L20 P0 ${parts.join(" ")}` : null;
}
