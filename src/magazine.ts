/**
 * WERKZEUGMAGAZIN (reine Rechnung, Tests in tests/magazine.test.ts)
 *
 * Plätze mit Nummer und Werkzeug. Zwei Arten:
 *   hand  nur die Nummer: beim Wechsel steht im Fenster, aus welchem Platz das Werkzeug kommt
 *   rack  feste Werkzeugreihe auf der Maschine + Spindel mit geschaltetem Spanner: CNC Craft legt ab und holt selbst
 *
 * Sicherheit der Reihe (rack):
 *  - Z fährt nur über einem Platz nach unten und nie tiefer als dessen eingetragene Höhe, die letzten mm langsam
 *  - quer gefahren wird nur auf der freien Höhe (zClear); nur die Gabel-Einfahrt liegt tiefer
 *  - der Spanner wird nur mit M64/M65 (Ausgang P…) geschaltet. M3/M4 (Spindel) und M7/M8 (Kühlung) sind verboten:
 *    die kommen auch in Programmen vor, dann ginge der Spanner bei laufender Spindel auf
 *  - jeder Platz wird zuerst Schritt für Schritt geprüft; jede Änderung an den Werten verlangt das neu
 */
export type MagKind = "off" | "hand" | "rack";
export type Entry = "top" | "fork";
export type Dir = "x+" | "x-" | "y+" | "y-";
export interface XYZ { x: number; y: number; z: number }

export interface Slot {
  n: number;           // Platznummer (1 …)
  toolId: string;      // "" = leer
  x: number; y: number; z: number; // Maschinen-Koordinaten: hier sitzt das Werkzeug im Platz (Spindel gespannt)
  set: boolean;        // Stelle eingetragen
  okGet: boolean;      // Schritt für Schritt geholt
  okPut: boolean;      // Schritt für Schritt abgelegt
}
export interface Magazine {
  kind: MagKind;
  entry: Entry;
  dir: Dir;            // Gabel: in diese Richtung ist der Platz offen (dort steht die Spindel vor dem Einfahren)
  slide: number;       // Gabel: Weg der Einfahrt (mm)
  approach: number;    // die letzten mm nach unten langsam
  zClear: number;      // Maschinen-Z, auf der quer gefahren wird
  feedXY: number; feedZ: number; slow: number; // mm/min
  open: string; close: string;     // M64 P0 / M65 P0
  openS: number;       // Wartezeit nach Spanner auf/zu (s)
  spinS: number;       // Wartezeit nach Spindel aus (s)
  always: boolean;     // auch bei geprüften Plätzen jeden Schritt bestätigen
  auto: boolean;       // nach dem Wechsel ohne Klick weiter (nur wenn beide Plätze geprüft sind)
  size: number;        // Breite eines Platzes (mm), für Anzeige und Sperrzone
  top: number;         // Oberkante der Reihe mit Werkzeugen über der Material-Oberseite (mm), für die Sperrzone
  slots: Slot[];
  inSpindle: number;   // Platznummer des Werkzeugs in der Spindel, 0 = leer, -1 = unbekannt
}

export const MAX_SLOTS = 24;
export const DEFAULT_MAG: Magazine = {
  kind: "off", entry: "top", dir: "y-", slide: 40, approach: 15, zClear: -5, feedXY: 2000, feedZ: 800, slow: 150,
  open: "", close: "", openS: 1, spinS: 8, always: false, auto: false, size: 30, top: 60, slots: [], inSpindle: -1
};

const num = (v: any, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : d);

/** Nur Schaltbefehle für freie Ausgänge, sonst "" */
export function cleanOutput(v: any): string {
  const m = typeof v === "string" ? v.trim().toUpperCase().match(/^M(64|65)\s*P(\d{1,2})$/) : null;
  return m ? `M${m[1]} P${parseInt(m[2], 10)}` : "";
}

export function cleanMagazine(raw: any): Magazine {
  const d = DEFAULT_MAG, r = raw && typeof raw === "object" ? raw : {};
  const slots: Slot[] = [];
  for (const s of Array.isArray(r.slots) ? r.slots : []) {
    const n = num(s?.n, 1, 99, 0);
    if (!n || n !== Math.floor(n) || slots.some(o => o.n === n) || slots.length >= MAX_SLOTS) continue;
    const ok = [s.x, s.y, s.z].every(v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 20000);
    const set = s.set === true && ok;
    slots.push({
      n, toolId: typeof s.toolId === "string" && /^[\w-]{1,60}$/.test(s.toolId) ? s.toolId : "",
      x: ok ? s.x : 0, y: ok ? s.y : 0, z: ok ? s.z : 0, set, okGet: set && s.okGet === true, okPut: set && s.okPut === true
    });
  }
  slots.sort((a, b) => a.n - b.n);
  const inS = Math.floor(num(r.inSpindle, -1, 99, -1));
  return {
    kind: r.kind === "hand" || r.kind === "rack" ? r.kind : "off",
    entry: r.entry === "fork" ? "fork" : "top",
    dir: ["x+", "x-", "y+", "y-"].includes(r.dir) ? r.dir : d.dir,
    slide: num(r.slide, 5, 200, d.slide), approach: num(r.approach, 2, 100, d.approach),
    zClear: num(r.zClear, -2000, 2000, d.zClear),
    feedXY: num(r.feedXY, 50, 10000, d.feedXY), feedZ: num(r.feedZ, 20, 5000, d.feedZ), slow: num(r.slow, 10, 500, d.slow),
    open: cleanOutput(r.open), close: cleanOutput(r.close),
    openS: num(r.openS, 0.3, 20, d.openS), spinS: num(r.spinS, 3, 60, d.spinS),
    always: r.always === true, auto: r.auto === true, size: num(r.size, 5, 300, d.size), top: num(r.top, -500, 500, d.top), slots,
    inSpindle: inS <= 0 || slots.some(s => s.n === inS) ? inS : -1
  };
}

export function slotOf(m: Magazine, n: number): Slot | null { return m.slots.find(s => s.n === n) || null; }
/** Platz eines Werkzeugs (null = liegt nicht im Magazin) */
export function slotForTool(m: Magazine, toolId: string): Slot | null {
  return m.kind === "off" || !toolId ? null : m.slots.find(s => s.toolId === toolId) || null;
}

/** Wo ein Platz in der Zeichnung liegt: Maschinen-Koordinaten minus Nullpunkt der Zeichnung */
export function slotInDrawing(s: Slot, zero: { x: number; y: number }): { x: number; y: number } { return { x: s.x - zero.x, y: s.y - zero.y }; }
/** Rechteck um die ganze Reihe in der Zeichnung (null = noch kein Platz eingetragen). Bei der Gabel mit der Einfahrt */
export function rackBox(m: Magazine, zero: { x: number; y: number }, withSlide = false): { x0: number; y0: number; x1: number; y1: number } | null {
  let b: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const s of m.slots) {
    if (!s.set) continue;
    const at = [slotInDrawing(s, zero)];
    if (withSlide && m.entry === "fork") at.push(slotInDrawing({ ...s, ...before(m, s) }, zero));
    for (const p of at) {
      const r = m.size / 2, q = { x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r };
      b = b ? { x0: Math.min(b.x0, q.x0), y0: Math.min(b.y0, q.y0), x1: Math.max(b.x1, q.x1), y1: Math.max(b.y1, q.y1) } : q;
    }
  }
  return b;
}

export type MagProblem = "outputs" | "same" | "noSlot" | "unset" | "clear" | "near" | "double" | "";
/** Stimmen die Einstellungen der Reihe? Grund und Platz */
export function rackProblem(m: Magazine): { why: MagProblem; n: number } {
  if (!m.open || !m.close) return { why: "outputs", n: 0 };
  if (m.open === m.close) return { why: "same", n: 0 };
  if (!m.slots.length) return { why: "noSlot", n: 0 };
  for (const s of m.slots) {
    if (!s.set) return { why: "unset", n: s.n };
    if (m.zClear < s.z + m.approach + 5) return { why: "clear", n: s.n };
  }
  for (let i = 0; i < m.slots.length; i++) for (let j = i + 1; j < m.slots.length; j++) {
    const a = m.slots[i], b = m.slots[j];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 8) return { why: "near", n: b.n };
    if (a.toolId && a.toolId === b.toolId) return { why: "double", n: b.n };
  }
  return { why: "", n: 0 };
}

/**
 * Ein Schritt des Wechsels. down = fährt nach unten oder quer in den Platz und darf das nur genau dort
 * (at = wo die Maschine dafür stehen muss)
 */
export type Step =
  | { k: "up"; z: number }
  | { k: "xy"; x: number; y: number; feed: number; at?: XYZ }
  | { k: "z"; z: number; feed: number; at: { x: number; y: number } }
  | { k: "out"; cmd: string; what: "open" | "close"; wait: number };

export const before = (m: Magazine, s: Slot) => {
  const d = m.slide, v = { "x+": [d, 0], "x-": [-d, 0], "y+": [0, d], "y-": [0, -d] }[m.dir];
  return { x: s.x + v[0], y: s.y + v[1] };
};

/** Werkzeug holen (Spindel ist leer) */
export function getSteps(m: Magazine, s: Slot): Step[] {
  const at = { x: s.x, y: s.y };
  const down: Step[] = [
    { k: "up", z: m.zClear }, { k: "xy", ...at, feed: m.feedXY },
    { k: "out", cmd: m.open, what: "open", wait: m.openS },
    { k: "z", z: s.z + m.approach, feed: m.feedZ, at }, { k: "z", z: s.z, feed: m.slow, at },
    { k: "out", cmd: m.close, what: "close", wait: m.openS }
  ];
  if (m.entry === "top") return [...down, { k: "z", z: s.z + m.approach, feed: m.slow, at }, { k: "up", z: m.zClear }];
  const b = before(m, s);
  return [...down, { k: "xy", ...b, feed: m.slow, at: { ...at, z: s.z } }, { k: "up", z: m.zClear }];
}

/** Werkzeug ablegen (es steckt in der Spindel) */
export function putSteps(m: Magazine, s: Slot): Step[] {
  const at = { x: s.x, y: s.y };
  const leave: Step[] = [
    { k: "out", cmd: m.open, what: "open", wait: m.openS },
    { k: "z", z: s.z + m.approach, feed: m.slow, at }, { k: "up", z: m.zClear },
    { k: "out", cmd: m.close, what: "close", wait: m.openS }
  ];
  if (m.entry === "top") return [
    { k: "up", z: m.zClear }, { k: "xy", ...at, feed: m.feedXY },
    { k: "z", z: s.z + m.approach, feed: m.feedZ, at }, { k: "z", z: s.z, feed: m.slow, at }, ...leave
  ];
  const b = before(m, s);
  return [
    { k: "up", z: m.zClear }, { k: "xy", ...b, feed: m.feedXY },
    { k: "z", z: s.z + m.approach, feed: m.feedZ, at: b }, { k: "z", z: s.z, feed: m.slow, at: b },
    { k: "xy", ...at, feed: m.slow, at: { ...b, z: s.z } }, ...leave
  ];
}

/** Platz nur anfahren, um die Stelle zu prüfen: bis knapp darüber, Spanner bleibt zu */
export function lookSteps(m: Magazine, s: Slot): Step[] {
  const at = m.entry === "fork" ? before(m, s) : { x: s.x, y: s.y };
  return [{ k: "up", z: m.zClear }, { k: "xy", ...at, feed: m.feedXY }, { k: "z", z: s.z + m.approach, feed: m.feedZ, at }, { k: "up", z: m.zClear }];
}

/** Muss dieser Vorgang Schritt für Schritt bestätigt werden? */
export function needsSteps(m: Magazine, s: Slot, what: "get" | "put"): boolean { return m.always || !(what === "get" ? s.okGet : s.okPut); }

/** Darf ein Wechsel ohne Klick weiterlaufen? Nur auf Wunsch, und nur wenn beide Plätze schon geprüft sind */
export function runsOn(m: Magazine, want: Slot): boolean {
  const old = m.inSpindle > 0 ? slotOf(m, m.inSpindle) : null;
  return m.auto && !!old && !needsSteps(m, old, "put") && !needsSteps(m, want, "get");
}

/** Nach einer Änderung: was an Werten den Ablauf ändert, verlangt eine neue Prüfung */
export function forgetTests(prev: Magazine, next: Magazine): Magazine {
  const g = (m: Magazine) => JSON.stringify([m.entry, m.dir, m.slide, m.approach, m.zClear, m.feedXY, m.feedZ, m.slow, m.open, m.close, m.openS, m.spinS]);
  const all = g(prev) !== g(next);
  return { ...next, slots: next.slots.map(s => {
    const o = slotOf(prev, s.n);
    return !all && o && o.set && o.x === s.x && o.y === s.y && o.z === s.z ? s : { ...s, okGet: false, okPut: false };
  }) };
}

/** Werkzeugnummern der M6-Zeilen eines Programms (auch „T2“ in einer Zeile davor). 0 = M6 ohne Nummer */
export function toolNumbersIn(lines: string[]): number[] {
  const out: number[] = [];
  let last = 0;
  for (const raw of lines) {
    const l = raw.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").toUpperCase();
    const t = l.match(/T\s*(\d+)/);
    if (t) last = parseInt(t[1], 10);
    if (/M0*6(?!\d)/.test(l) && !out.includes(last)) out.push(last);
  }
  return out;
}
export type RackBlock = "grbl" | "firmware" | "home" | "inch" | "sensor" | "spindle" | MagProblem;
/** Darf die Reihe jetzt fahren? */
export function rackBlocked(m: Magazine, o: { grbl: boolean; firmware: string; homed: boolean; inches: boolean; sensor: boolean }): { why: RackBlock; n: number } {
  if (!o.grbl) return { why: "grbl", n: 0 };
  // Ausgänge mit M64/M65 gibt es bei grblHAL und FluidNC, nicht bei GRBL 1.1
  if (o.firmware !== "grblHAL" && o.firmware !== "FluidNC") return { why: "firmware", n: 0 };
  if (!o.homed) return { why: "home", n: 0 };
  if (o.inches) return { why: "inch", n: 0 };
  const p = rackProblem(m);
  if (p.why) return p;
  if (!o.sensor) return { why: "sensor", n: 0 };
  if (m.inSpindle < 0) return { why: "spindle", n: 0 };
  return { why: "", n: 0 };
}
