/**
 * LANGE PLATTE WEITERSCHIEBEN – reine Rechnung (Tests: tests/longBoard.test.ts)
 *
 * Ein Teil, das länger als die Maschine ist, wird in Abschnitten gefräst: Nach jedem Abschnitt schiebt man die Platte um ein
 * festes Maß S zurück. Zwei Passstifte in der Opferplatte und passende Löcher in der Platte sorgen dafür, dass es genau stimmt:
 * Abschnitt k bohrt Löcher im Abstand S hinter den Stiften; nach dem Schieben liegen sie genau auf den Stiften.
 *
 * Geteilt wird das fertige Programm (nicht die Zeichnung): So stimmen Fräserversatz, Taschen, Stege und Werkzeuge von selbst.
 * Abschnitt k bekommt alle Schnitte seines Fensters, um k·S verschoben. Die Fenster überlappen etwas. An der Grenze fährt
 * der Fräser hoch und taucht im Nachbar-Abschnitt an derselben Stelle wieder ein – senkrecht, im Eintauch-Vorschub.
 */
export type Axis = "x" | "y";
export interface LongOpts {
  axis: Axis;
  bed: number;        // nutzbare Länge der Maschine in dieser Achse (mm)
  start: number;      // Anfang des Fensters auf dem Bett (mm)
  shift: number;      // so weit wird geschoben (mm)
  overlap: number;    // so weit überlappen die Abschnitte auf jeder Seite (mm)
  pins: { x: number; y: number }[]; // Passstifte (Bett, mm)
  pinD: number;       // Stift-Ø
}

export interface Section { n: number; lo: number; hi: number; shift: number }

/** Fenster je Abschnitt in Zeichnungs-Koordinaten entlang der Achse; max = Ende der Fräsbahnen */
export function sections(o: LongOpts, max: number): Section[] {
  const out: Section[] = [];
  if (!(o.shift > 0)) return out;
  for (let k = 0; k < 200; k++) {
    const lo = o.start + k * o.shift, hi = lo + o.shift, last = hi >= max - 1e-6;
    out.push({ n: k + 1, lo: k === 0 ? -Infinity : lo - o.overlap, hi: last ? Infinity : hi + o.overlap, shift: k * o.shift });
    if (last) break;
  }
  return out;
}

export type LongErr = "shift" | "window" | "minOut" | "pinOut" | "holeOut" | "pinsSame" | "lastOut";
/** Was nicht geht (Fehler) – vor dem Teilen prüfen */
export function checkLong(o: LongOpts, min: number, max: number): LongErr[] {
  const e: LongErr[] = [], a = (p: { x: number; y: number }) => (o.axis === "x" ? p.x : p.y);
  if (!(o.shift >= 20)) e.push("shift");
  if (o.start - o.overlap < -1e-6 || o.start + o.shift + o.overlap > o.bed + 1e-6) e.push("window");
  if (min < -1e-6) e.push("minOut");
  const s = sections(o, max), l = s[s.length - 1];
  if (l && max - l.shift > o.bed + 1e-6) e.push("lastOut");
  if (o.pins.length < 2 || o.pins.some(p => a(p) - o.pinD / 2 < 0 || a(p) + o.pinD / 2 > o.bed)) e.push("pinOut");
  if (o.pins.some(p => a(p) + o.shift + o.pinD / 2 > o.bed)) e.push("holeOut");
  if (o.pins.length >= 2 && Math.hypot(o.pins[0].x - o.pins[1].x, o.pins[0].y - o.pins[1].y) < o.pinD * 2) e.push("pinsSame");
  return e;
}

interface P { x: number; y: number; z: number }
const val = (s: string, k: string): number | null => { const m = new RegExp("(?:^|[^A-Z])" + k + "\\s*([-+]?(?:\\d+\\.?\\d*|\\.\\d+))", "i").exec(s); return m ? parseFloat(m[1]) : null; };
const strip = (l: string) => l.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").trim();

export interface SplitProgram {
  lines: string[];        // ohne Kopf und Fuß
  cuts: number;           // Schnittbewegungen
  entries: number;        // Wiedereintauchen an der Grenze
  firstTool: string;      // Kommentar des ersten Werkzeugs in diesem Abschnitt
  box: { min: number; max: number } | null; // Ausdehnung auf dem Bett entlang der Achse
  /** Schnittpunkte auf dem Bett (für die Prüfung gegen die Stifte), grob */
  trace: P[];
}

/** Was der Teiler nicht kann (kommt in eigenen Fräsprogrammen nicht vor) */
export function unsupported(lines: string[]): string | null {
  for (const l of lines) {
    const s = strip(l).toUpperCase();
    const m = /(?:^|[^A-Z\d])G\s*0*(20|18|19|91|92|10|28|30|38|41|42|43|5[3-9]|68|73|8[1-9])(?![\d])/.exec(s);
    if (m) return "G" + m[1];
    if (/(?:^|\s)[AB]\s*[-+\d.]/.test(s)) return "A/B";
  }
  return null;
}

/** Ausdehnung der Schnitte entlang beider Achsen */
export function cutBounds(lines: string[]): { x0: number; y0: number; x1: number; y1: number; minZ: number } | null {
  let b: { x0: number; y0: number; x1: number; y1: number; minZ: number } | null = null;
  walk(lines, m => {
    if (m.g === 0) return;
    for (const p of m.pts) { b ??= { x0: p.x, y0: p.y, x1: p.x, y1: p.y, minZ: p.z }; b.x0 = Math.min(b.x0, p.x); b.x1 = Math.max(b.x1, p.x); b.y0 = Math.min(b.y0, p.y); b.y1 = Math.max(b.y1, p.y); b.minZ = Math.min(b.minZ, p.z); }
  }, () => undefined);
  return b;
}

interface Move { g: 0 | 1 | 2 | 3; from: P; to: P; i: number; j: number; feed: number; pts: P[] }
/** Programm durchgehen: move je Bewegung (Bögen zusätzlich als Punkte), other je andere Zeile */
function walk(lines: string[], move: (m: Move) => void, other: (line: string, code: string) => void) {
  let g: 0 | 1 | 2 | 3 = 0, pos: P = { x: 0, y: 0, z: 0 }, feed = 0;
  for (const line of lines) {
    const s = strip(line).toUpperCase();
    if (!s) { if (line.trim()) other(line, ""); continue; }
    const f = val(s, "F");
    if (f !== null) feed = f;
    const gm = [...s.matchAll(/G\s*0*(\d+)(?![\d.])/g)].map(m => +m[1]), motion = gm.filter(x => x <= 3).pop();
    if (motion !== undefined) g = motion as 0 | 1 | 2 | 3;
    const x = val(s, "X"), y = val(s, "Y"), z = val(s, "Z");
    if (gm.includes(4) || (x === null && y === null && z === null)) { other(line, s); continue; }
    const to = { x: x ?? pos.x, y: y ?? pos.y, z: z ?? pos.z }, i = val(s, "I") ?? 0, j = val(s, "J") ?? 0;
    const m: Move = { g, from: pos, to, i, j, feed, pts: [] };
    m.pts = g >= 2 ? arcPoints(m) : [pos, to];
    if (/M\s*0*[3-9]\b/.test(s)) other(line, s);
    move(m);
    pos = to;
  }
}
function arcPoints(m: Move): P[] {
  const cx = m.from.x + m.i, cy = m.from.y + m.j, r = Math.hypot(m.i, m.j);
  let a0 = Math.atan2(m.from.y - cy, m.from.x - cx), a1 = Math.atan2(m.to.y - cy, m.to.x - cx), sw = a1 - a0;
  if (m.g === 2) { while (sw > -1e-9) sw -= 2 * Math.PI; if (sw < -2 * Math.PI) sw += 2 * Math.PI; } else { while (sw < 1e-9) sw += 2 * Math.PI; if (sw > 2 * Math.PI) sw -= 2 * Math.PI; }
  if (Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y) < 1e-6) sw = m.g === 2 ? -2 * Math.PI : 2 * Math.PI;
  const n = Math.max(2, Math.min(720, Math.ceil(Math.abs(sw) / Math.max(0.02, 2 * Math.acos(Math.max(0, 1 - Math.min(1, 0.005 / Math.max(r, 1e-6)))))))), out: P[] = [m.from];
  for (let k = 1; k < n; k++) out.push({ x: cx + r * Math.cos(a0 + sw * k / n), y: cy + r * Math.sin(a0 + sw * k / n), z: m.from.z + (m.to.z - m.from.z) * k / n });
  out.push(m.to);
  return out;
}

const EPS = 1e-4;
const f3 = (v: number) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3);

/**
 * Programm eines Abschnitts: nur die Schnitte zwischen lo und hi, um shift verschoben.
 * keepM6: Steuerung mit Werkzeugtabelle – auch das erste Werkzeug wird mit „M6 T<n>“ geholt (sonst fehlt seine Länge)
 */
export function splitProgram(lines: string[], axis: Axis, sec: Section, safeZ: number, toolPrefix = "Werkzeug:", keepM6 = false): SplitProgram {
  const out: SplitProgram = { lines: [], cuts: 0, entries: 0, firstTool: "", box: null, trace: [] };
  const A = (p: P) => (axis === "x" ? p.x : p.y), inside = (p: P) => A(p) >= sec.lo - EPS && A(p) <= sec.hi + EPS;
  const X = (p: P) => f3(axis === "x" ? p.x - sec.shift : p.x), Y = (p: P) => f3(axis === "y" ? p.y - sec.shift : p.y);
  // wo die Maschine wirklich steht (Zeichnungs-Koordinaten); null = oben, XY egal
  let at: P | null = null, up = true, feedOut = -1, plunge = 300, touched = false;
  // Werkzeug-/Spindelzeilen, die erst geschrieben werden, wenn in diesem Abschnitt wirklich gefräst wird
  let group: string[] = [], toolBlock: string[] = [], spinBlock: string[] = [];
  const closeGroup = () => {
    if (!group.length) return;
    const code = group.map(l => strip(l).toUpperCase()).join("\n");
    if (/\bM\s*0*[016]\b/.test(code)) { toolBlock = group.slice(); spinBlock = []; }
    else if (/\bM\s*0*\d/.test(code)) { if (toolBlock.length) toolBlock.push(...group); else spinBlock = group.slice(); }
    group = [];
  };
  const raise = () => { if (!up) { out.lines.push(`G0 Z${f3(safeZ)}`); up = true; } };
  const flush = () => {
    closeGroup();
    const b = [...toolBlock, ...spinBlock];
    if (!b.length) return;
    raise();
    at = null; // nach einem Werkzeugwechsel neu anfahren
    // der erste Werkzeugwechsel eines Abschnitts ist kein Wechsel: das Werkzeug wird vor dem Start eingesetzt
    // (und der Kopf des ganzen Programms gehört nicht hierher)
    const ti = b.findIndex(l => l.trim().startsWith("(" + toolPrefix));
    const m6 = keepM6 ? b.findIndex(l => /\bM\s*0*6\b/.test(strip(l).toUpperCase())) : -1;
    const use = touched ? b : b.slice(Math.max(0, m6 >= 0 && m6 < ti ? m6 : ti)).filter(l => !(keepM6 ? /\bM\s*0*[015]\b|\bG\s*0*(17|21|90)\b/ : /\bM\s*0*[0156]\b|\bG\s*0*(17|21|90)\b/).test(strip(l).toUpperCase()));
    if (!touched && ti >= 0) out.firstTool = b[ti].trim().slice(1, -1);
    out.lines.push(...use);
    toolBlock = []; spinBlock = []; feedOut = -1;
  };
  /** Maschine auf p bringen (hoch, hin, eintauchen) */
  const reach = (p: P) => {
    flush();
    if (at && Math.abs(at.x - p.x) < EPS && Math.abs(at.y - p.y) < EPS && Math.abs(at.z - p.z) < EPS) return;
    raise();
    out.lines.push(`G0 X${X(p)} Y${Y(p)}`);
    if (p.z < safeZ - EPS) { out.lines.push(`G1 Z${f3(p.z)} F${f3feed(plunge)}`); up = false; feedOut = plunge; }
    at = { ...p };
    out.entries++;
  };
  const f3feed = (v: number) => String(Math.round(v * 100) / 100);
  const cutTo = (p: P, feed: number, from: P) => {
    const w: string[] = [];
    if (Math.abs(p.x - from.x) >= 5e-5 || Math.abs(p.y - from.y) >= 5e-5) w.push(`X${X(p)}`, `Y${Y(p)}`);
    if (Math.abs(p.z - from.z) >= 5e-5) w.push(`Z${f3(p.z)}`);
    if (!w.length) return;
    out.lines.push(`G1 ${w.join(" ")}${feed > 0 && feed !== feedOut ? ` F${f3feed(feed)}` : ""}`);
    if (feed > 0) feedOut = feed;
    at = { ...p }; up = p.z >= safeZ - EPS; out.cuts++; touched = true;
    note(from); note(p);
  };
  const note = (p: P) => {
    const a = A(p) - sec.shift;
    out.box = out.box ? { min: Math.min(out.box.min, a), max: Math.max(out.box.max, a) } : { min: a, max: a };
    out.trace.push({ x: axis === "x" ? p.x - sec.shift : p.x, y: axis === "y" ? p.y - sec.shift : p.y, z: p.z });
  };

  walk(lines, m => {
    // Eilgang: nur mitmachen, wenn die Maschine dort steht, wo das Programm sie vermutet, und das Ziel im Fenster liegt
    if (m.g === 0) {
      closeGroupIfMove();
      const synced: boolean = !!at && Math.abs(at.x - m.from.x) < EPS && Math.abs(at.y - m.from.y) < EPS && Math.abs(at.z - m.from.z) < EPS;
      const pend = toolBlock.length + spinBlock.length + group.length > 0;
      if (synced && !pend && inside(m.to)) {
        const w: string[] = [];
        if (Math.abs(m.to.x - m.from.x) >= 5e-5 || Math.abs(m.to.y - m.from.y) >= 5e-5) w.push(`X${X(m.to)}`, `Y${Y(m.to)}`);
        if (Math.abs(m.to.z - m.from.z) >= 5e-5) w.push(`Z${f3(m.to.z)}`);
        if (w.length) out.lines.push(`G0 ${w.join(" ")}`);
        at = { ...m.to }; up = m.to.z >= safeZ - EPS;
      } else if (!pend && inside(m.to) && m.to.z > 0 && (Math.abs(m.to.x - m.from.x) > EPS || Math.abs(m.to.y - m.from.y) > EPS)) {
        raise();
        out.lines.push(`G0 X${X(m.to)} Y${Y(m.to)}`);
        if (m.to.z < safeZ - EPS) { out.lines.push(`G0 Z${f3(m.to.z)}`); up = false; }
        at = { ...m.to };
      } else if (synced && !pend) { raise(); at = null; }
      return;
    }
    const flat = Math.abs(m.to.x - m.from.x) < EPS && Math.abs(m.to.y - m.from.y) < EPS && m.g === 1;
    if (flat && m.feed > 0 && m.to.z < m.from.z) plunge = m.feed;
    const allIn = m.pts.every(inside);
    if (!allIn && !m.pts.some((p, i) => i > 0 && span(A(m.pts[i - 1]), A(p), sec.lo, sec.hi))) { if (at) { raise(); at = null; } return; }
    if (allIn) {
      reach2(m.from, flat, m);
      if (m.g === 1) cutTo(m.to, m.feed, m.from);
      else {
        out.lines.push(`G${m.g} X${X(m.to)} Y${Y(m.to)}${Math.abs(m.to.z - m.from.z) >= 5e-5 ? ` Z${f3(m.to.z)}` : ""} I${f3(m.i)} J${f3(m.j)}${m.feed > 0 && m.feed !== feedOut ? ` F${f3feed(m.feed)}` : ""}`);
        if (m.feed > 0) feedOut = m.feed;
        at = { ...m.to }; up = false; out.cuts++; touched = true;
        for (let k = 1; k < m.pts.length; k++) { note(m.pts[k - 1]); note(m.pts[k]); } // immer paarweise (pinHits)
      }
      return;
    }
    // an der Grenze: Stück für Stück, nur was innen liegt
    for (let k = 1; k < m.pts.length; k++) {
      const a = m.pts[k - 1], b = m.pts[k], s = span(A(a), A(b), sec.lo, sec.hi);
      if (!s) { if (at) { raise(); at = null; } continue; }
      const lerp = (t: number): P => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
      const p0 = s[0] <= 0 ? a : lerp(s[0]), p1 = s[1] >= 1 ? b : lerp(s[1]);
      reach(p0);
      cutTo(p1, m.feed, p0);
      if (s[1] < 1) { raise(); at = null; }
    }
  }, (line, code) => {
    if (/\bM\s*0*(2|30)\b/.test(code)) return;
    if (/^F[\d.]+$/.test(code)) return; // Vorschub steht an den Bewegungen
    // reine Kommentare nur merken, wenn sie zu einem Werkzeug gehören (direkt vor M-Befehlen)
    group.push(line);
    if (!code && group.length > 1 && !group.some(l => /\bM\s*0*\d/.test(strip(l).toUpperCase()))) group = [line];
  });
  raise();

  function closeGroupIfMove() { if (group.some(l => /\bM\s*0*\d/.test(strip(l).toUpperCase()))) closeGroup(); else if (!toolBlock.length) group = []; }
  /** wie reach, aber ein senkrechter Eintauch-Befehl an einer neuen Stelle fährt gleich von oben */
  function reach2(p: P, flat: boolean, m: Move) {
    if (flat && m.to.z < m.from.z && (!at || Math.abs(at.x - p.x) > EPS || Math.abs(at.y - p.y) > EPS || Math.abs(at.z - p.z) > EPS)) {
      flush(); raise();
      out.lines.push(`G0 X${X(p)} Y${Y(p)}`);
      at = { x: p.x, y: p.y, z: safeZ };
      m.from = { ...at };
      return;
    }
    reach(p);
  }
  return out;
}
/** Anteil [t0, t1] der Strecke a→b, der zwischen lo und hi liegt */
function span(a: number, b: number, lo: number, hi: number): [number, number] | null {
  if (Math.abs(b - a) < 1e-12) return a >= lo - EPS && a <= hi + EPS ? [0, 1] : null;
  const t0 = (lo - a) / (b - a), t1 = (hi - a) / (b - a), s = Math.max(0, Math.min(t0, t1)), e = Math.min(1, Math.max(t0, t1));
  return e - s > 1e-9 ? [s, e] : null;
}

/** Wo dürfen die Stifte nicht stehen: kommt ein Schnitt näher als Stift- plus Fräser-Radius plus Luft? */
export function pinHits(trace: P[], pins: { x: number; y: number }[], keep: number): number[] {
  return pins.map((p, i) => {
    for (let k = 1; k < trace.length; k += 2) {
      const a = trace[k - 1], b = trace[k];
      if (Math.min(a.z, b.z) >= 0) continue;
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy, t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
      if (Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y) < keep) return i;
    }
    return -1;
  }).filter(i => i >= 0);
}

export interface HoleTool { drill: boolean; diameter: number; feed: number; plunge: number; stepZ: number }
/** Löcher (Mitte, Ø) bohren oder mit einem kleineren Fräser in Schraubenlinie fräsen */
export function holeLines(holes: { x: number; y: number }[], d: number, depth: number, tl: HoleTool, safeZ: number): string[] {
  const out: string[] = [];
  for (const h of holes) {
    const r = (d - tl.diameter) / 2, step = Math.max(0.1, tl.stepZ);
    out.push(`G0 Z${f3(safeZ)}`);
    if (tl.drill || r < 0.05) {
      out.push(`G0 X${f3(h.x)} Y${f3(h.y)}`, "G0 Z0.500");
      for (let z = 0; z > -depth + 1e-6;) { const n = Math.max(-depth, z - step); if (z < 0) out.push("G0 Z0.500", `G0 Z${f3(z + 0.3)}`); out.push(`G1 Z${f3(n)} F${Math.round(tl.plunge)}`); z = n; }
    } else {
      const pitch = Math.max(0.05, Math.min(step, 2 * Math.PI * r * Math.tan(3 * Math.PI / 180))), n = Math.ceil(depth / pitch);
      out.push(`G0 X${f3(h.x + r)} Y${f3(h.y)}`, "G0 Z0.500", `G1 Z0.000 F${Math.round(tl.plunge)}`);
      for (let k = 1; k <= n; k++) out.push(`G3 X${f3(h.x + r)} Y${f3(h.y)} Z${f3(-depth * k / n)} I${f3(-r)} J0.000${k === 1 ? ` F${Math.round(tl.feed)}` : ""}`);
      out.push(`G3 X${f3(h.x + r)} Y${f3(h.y)} I${f3(-r)} J0.000`, `G1 X${f3(h.x)} Y${f3(h.y)}`);
    }
    out.push(`G0 Z${f3(safeZ)}`);
  }
  return out;
}
