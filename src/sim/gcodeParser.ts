/**
 * G-CODE-LESER FÜR DIE SIMULATION
 *
 * Wandelt G-Code in eine Liste von Bewegungen um (gerade Stücke; Bögen werden fein unterteilt).
 * Jede Bewegung weiß, aus welcher Zeile sie stammt und wann sie beginnt (Zeitschätzung).
 *
 * Verstanden wird: G0/G1/G2/G3 (I/J/K- und R-Schreibweise, auch Helix) in allen drei Ebenen (G17/G18/G19), G20/G21,
 * G90/G91, G90.1/G91.1 (Mittelpunkt absolut/relativ), G92 bis G92.3 (Nullpunkt im Job verschieben),
 * F (Vorschub), M3/M4/M5 (Spindel/Laser/Plasma an/aus, S0 = aus), G4 (Warten, zählt zur Zeit),
 * G38.x (Antasten – wird nicht nachgebildet), Kommentare ( ) und ;
 * A (Drehachse, Grad): nur gemerkt (a0/a1) – die Anzeige um den Zylinder macht sim/rotarySim.ts
 * Bohrzyklen G73/G74/G81–G85/G89 (G98/G99, R/Z/Q/P bleiben gültig bis G80) – so, wie cycles.rs sie
 * vor dem Senden in G0/G1 umwandelt
 * Alles andere kommt in „notes“ (simNotes.ts) – die Bahn wird dann nicht stillschweigend falsch gezeigt
 *
 * Bewegungsarten:  0 = Eilgang (G0), 1 = Schnitt (G1-G3 mit Werkzeug an), 2 = Leerfahrt (G1 mit Werkzeug aus)
 * Enthält die Datei gar keine M3/M4/M5-Befehle, gilt jede G1-G3-Bewegung als Schnitt.
 */

import { planDurations, type MotionLimits } from "./motionPlan.ts";
import { SimNotes, type SimNote } from "./simNotes.ts";

export const MOVE_RAPID = 0;
export const MOVE_CUT = 1;
export const MOVE_TRAVEL = 2;

/** Bohrzyklen, die nachgebildet werden (wie cycles.rs) */
const CYCLES = [73, 74, 81, 82, 83, 84, 85, 89];

export interface SimProgram {
  lines: string[];
  n: number;
  x0: Float32Array; y0: Float32Array; z0: Float32Array;
  x1: Float32Array; y1: Float32Array; z1: Float32Array;
  type: Uint8Array;
  line: Uint32Array;          // Zeilennummer (0-basiert) der Bewegung
  t0: Float64Array;           // Startzeit in Sekunden
  dur: Float32Array;          // Dauer in Sekunden
  /** mit Beschleunigung gerechnet: Dauer ohne Rampen (daraus liest die Laser-Vorschau den programmierten Vorschub) */
  durPlain?: Float32Array;
  /** Werte, mit denen die Zeit gerechnet ist (fehlt = ohne Beschleunigung) */
  motion?: MotionLimits;
  totalTime: number;
  cutLength: number;
  rapidLength: number;
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  cutMinZ: number;            // tiefste Schnitt-Höhe
  cutMaxZ: number;
  /** was die Simulation nicht nachbildet (fehlt = nichts) */
  notes?: SimNote[];
  /** nur wenn der G-Code eine A-Achse hat: Winkel (Grad) am Anfang/Ende jeder Bewegung */
  a0?: Float32Array; a1?: Float32Array;
  /** um die Drehachse gewickelt (rotarySim.ts): Achse bei y = 0, z = −R; flat = Maße vor dem Wickeln */
  rotary?: {
    R: number; flat: SimProgram["bounds"]; aMin: number; aMax: number; along: "x" | "y";
    stock: import("../rotaryStock").RotaryStock;
    depth: Float32Array;    // Tiefe je Bewegung unter der Oberfläche (für die Farben)
    /** nicht rund: Teil-Winkel je Bewegung (rad) und die Bewegungen im Raster des Materialabtrags (simCarve.ts) */
    theta?: Float32Array;
    raster?: {
      x0: Float32Array; y0: Float32Array; z0: Float32Array;
      x1: Float32Array; y1: Float32Array; z1: Float32Array;
      face: Int16Array | null;   // Eckig: Fläche je Bewegung, −1 = beim Drehen
    };
  };
}

export interface ParseOptions {
  rapidRate?: number;   // mm/min für G0 (Schätzung)
  defaultFeed?: number; // mm/min, falls kein F angegeben
  arcTol?: number;      // mm, Genauigkeit der Bogen-Unterteilung
  motion?: MotionLimits; // Zeit mit Beschleunigung rechnen (motionPlan.ts); ohne: einfache Schätzung Weg/Vorschub
}

export function parseGcodeProgram(lines: string[], opts: ParseOptions = {}): SimProgram {
  const rapidRate = opts.rapidRate ?? 5000;
  const arcTol = opts.arcTol ?? 0.02;

  const x0: number[] = [], y0: number[] = [], z0: number[] = [];
  const x1: number[] = [], y1: number[] = [], z1: number[] = [];
  const type: number[] = [], lineNo: number[] = [], dur: number[] = [];
  // nur für die Rechnung mit Beschleunigung
  const plan = !!opts.motion;
  const rateOf: number[] = [], lenOf: number[] = [], stopOf: number[] = [], dwellOf: number[] = [];
  const arcROf: number[] = [], arcInOf: number[] = [];
  let arcNow = 0, arcInside = 0;
  let stopNext = false;
  // Drehachse A: nur wenn sie vorkommt (sonst kein Speicher dafür)
  const hasA = lines.some(l => /(^|[^A-Z])A\s*[-+]?[\d.]/i.test(stripComments(l)));
  const a0: number[] = [], a1: number[] = [];
  let a = 0, na = 0;

  // Gibt es überhaupt Spindel-Befehle? Sonst ist jede Vorschub-Bewegung ein Schnitt.
  const hasSpindle = lines.some(l => /\bM0?[345]\b/i.test(stripComments(l)));

  let x = 0, y = 0, z = 0;
  let absolute = true, inch = false, plane = 17, arcAbs = false;
  // G92: Versatz je Achse (x, y, z bleiben die gezeichnete Lage) und ob die Lage schon bekannt ist
  let ox = 0, oy = 0, oz = 0;
  let kept = [0, 0, 0];
  let kx = false, ky = false, kz = false;
  const notes = new SimNotes();
  let motion = 0;
  let feed = opts.defaultFeed ?? 1000;
  let toolCmdOn = false;  // M3/M4 aktiv
  let power = 1;          // letzter S-Wert (S0 = Laser/Plasma aus)
  let cutLength = 0, rapidLength = 0;
  let dwell = 0; // Wartezeit (G4), wird der nächsten Bewegung zugeschlagen
  // Bohrzyklus: aktive Nummer (0 = keiner), Rückzug auf Starthöhe (G98) oder R (G99), gemerkte Werte
  let cycle = 0, retractInitial = true;
  let cR: number | undefined, cZ: number | undefined, cQ: number | undefined, cP: number | undefined;

  const add = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, kind: number, li: number, f: number) => {
    // A zählt wie GRBL als „mm“ mit (Grad) – nur für die Zeit; die Länge bleibt die XYZ-Strecke
    const da = hasA ? na - a : 0;
    const geo = Math.hypot(bx - ax, by - ay, bz - az);
    const len = Math.hypot(geo, da);
    if (len < 1e-9) return;
    x0.push(ax); y0.push(ay); z0.push(az); x1.push(bx); y1.push(by); z1.push(bz);
    if (hasA) { a0.push(a); a1.push(na); a = na; }
    type.push(kind); lineNo.push(li);
    const rate = kind === MOVE_RAPID ? rapidRate : Math.max(1, f);
    dur.push(len / (rate / 60) + dwell);
    if (plan) {
      rateOf.push(kind === MOVE_RAPID ? 0 : Math.max(1, f)); lenOf.push(len); stopOf.push(stopNext ? 1 : 0); dwellOf.push(dwell);
      arcROf.push(arcNow); arcInOf.push(arcInside);
      stopNext = false;
    }
    dwell = 0;
    if (kind === MOVE_RAPID) rapidLength += geo; else if (kind === MOVE_CUT) cutLength += geo;
  };

  for (let li = 0; li < lines.length; li++) {
    const code = stripComments(lines[li]).toUpperCase();
    if (!code) continue;

    const words: Record<string, number> = {};
    const gs: number[] = [];
    const ms: number[] = [];
    const re = /([A-Z])\s*([-+]?\d*\.?\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const v = parseFloat(m[2]);
      if (m[1] === "G") gs.push(v);
      else if (m[1] === "M") ms.push(v);
      else words[m[1]] = v;
    }

    for (const g of gs) {
      if (g === 0 || g === 1 || g === 2 || g === 3 || g === 80 || (g >= 38 && g < 39)) {
        if (g <= 3) motion = g;
        cycle = 0; cR = cZ = cQ = cP = undefined;
      }
      else if (CYCLES.includes(g)) cycle = g;
      else if (g === 98) retractInitial = true;
      else if (g === 99) retractInitial = false;
      else if (g === 90) absolute = true;
      else if (g === 91) absolute = false;
      else if (g === 20) inch = true;
      else if (g === 21) inch = false;
      else if (g === 17 || g === 18 || g === 19) plane = g;
      else if (g === 90.1) arcAbs = true;
      else if (g === 91.1) arcAbs = false;
    }
    notes.line(code, gs, ms, words, li, absolute, plane);
    const f = inch ? 25.4 : 1;
    if (words.F !== undefined) feed = words.F * f;

    if (words.S !== undefined) power = words.S;
    for (const mc of ms) {
      if (mc === 3 || mc === 4) toolCmdOn = true;
      else if (mc === 5 || mc === 2 || mc === 30) toolCmdOn = false;
      // Die Steuerung wartet hier, bis alle Fahrten fertig sind (Spindel, Kühlung, Pause)
      if (mc <= 5 || mc === 7 || mc === 8 || mc === 9) stopNext = true;
    }
    const spindleOn = !hasSpindle || (toolCmdOn && power > 0);

    // G4 P = warten (Sekunden; bei GRBL immer Sekunden)
    if (gs.includes(4)) { if (words.P !== undefined) dwell += Math.max(0, words.P); stopNext = true; continue; }
    // Antasten (G38.2 usw.): Ergebnis ist unbekannt -> nicht nachbilden
    if (gs.some(g => g >= 38 && g < 39)) {
      if (words.X !== undefined) kx = false;
      if (words.Y !== undefined) ky = false;
      if (words.Z !== undefined) kz = false;
      continue;
    }
    // G92: die jetzige Stelle bekommt neue Werte. Ist die Lage unbekannt (Programmanfang, nach dem Antasten),
    // gibt es nichts zu verschieben – dann gilt einfach der angegebene Wert.
    if (gs.includes(92)) {
      if (words.X !== undefined) { if (kx) ox = x - words.X * f; else { x = words.X * f; ox = 0; kx = true; } }
      if (words.Y !== undefined) { if (ky) oy = y - words.Y * f; else { y = words.Y * f; oy = 0; ky = true; } }
      if (words.Z !== undefined) { if (kz) oz = z - words.Z * f; else { z = words.Z * f; oz = 0; kz = true; } }
      kept = [ox, oy, oz];
      continue;
    }
    if (gs.includes(92.1)) { ox = oy = oz = 0; kept = [0, 0, 0]; }
    else if (gs.includes(92.2)) { ox = oy = oz = 0; }
    else if (gs.includes(92.3)) { [ox, oy, oz] = kept; }

    // Zyklus-Werte auch von Zeilen ohne Loch merken (z. B. "G99 G83 R1 Q2")
    if (cycle) {
      if (words.R !== undefined) cR = words.R * f + oz;
      if (words.Q !== undefined) cQ = Math.abs(words.Q * f);
      if (words.P !== undefined) cP = words.P;
    }
    if (hasA) na = words.A === undefined ? a : (absolute ? words.A : a + words.A);
    const hasXYZ = words.X !== undefined || words.Y !== undefined || words.Z !== undefined || (hasA && na !== a);
    if (!hasXYZ) continue;
    // G53/G28 usw. nicht nachbilden (Lage in Werkstück-Koordinaten unbekannt)
    if (gs.some(g => g === 28 || g === 30 || g === 53)) {
      if (words.X !== undefined) kx = false;
      if (words.Y !== undefined) ky = false;
      if (words.Z !== undefined) kz = false;
      continue;
    }
    if (words.X !== undefined) kx = true;
    if (words.Y !== undefined) ky = true;
    if (words.Z !== undefined) kz = true;

    // Bohrzyklus: ein Loch an X/Y (Z = Bohrtiefe, nicht Position)
    if (cycle && absolute) {
      if (words.Z !== undefined) cZ = words.Z * f + oz;
      const hx = words.X === undefined ? x : words.X * f + ox;
      const hy = words.Y === undefined ? y : words.Y * f + oy;
      if (cR === undefined || cZ === undefined || cZ > cR) { x = hx; y = hy; continue; }
      const r = cR, zb = cZ, ret = retractInitial ? Math.max(z, r) : r;
      const kind = spindleOn ? MOVE_CUT : MOVE_TRAVEL;
      const clear = inch ? 0.254 : 0.25;
      const to = (nz: number, k: number) => { add(x, y, z, x, y, nz, k, li, feed); z = nz; };
      if (z < r) to(r, MOVE_RAPID);
      add(x, y, z, hx, hy, z, MOVE_RAPID, li, feed); x = hx; y = hy;
      to(r, MOVE_RAPID);
      if ((cycle === 83 || cycle === 73) && cQ && cQ > 0) {
        let depth = r;
        for (let k = 0; k < 10000; k++) {
          const next = Math.max(depth - cQ, zb);
          if (depth < r) to(depth + clear, MOVE_RAPID);
          to(next, kind);
          depth = next;
          if (depth <= zb + 1e-9) break;
          to(cycle === 83 ? r : depth + clear, MOVE_RAPID);
        }
      } else {
        to(zb, kind);
      }
      if (cP && cP > 0 && cycle !== 81 && cycle !== 83 && cycle !== 73 && cycle !== 85) dwell += Math.min(cP, 60);
      // Ausbohren / Gewindebohren: mit Vorschub wieder heraus
      if (cycle === 84 || cycle === 74 || cycle === 85 || cycle === 89) to(r, kind);
      to(ret, MOVE_RAPID);
      continue;
    }

    const nx = words.X === undefined ? x : (absolute ? words.X * f + ox : x + words.X * f);
    const ny = words.Y === undefined ? y : (absolute ? words.Y * f + oy : y + words.Y * f);
    const nz = words.Z === undefined ? z : (absolute ? words.Z * f + oz : z + words.Z * f);
    const kind = motion === 0 ? MOVE_RAPID : (spindleOn ? MOVE_CUT : MOVE_TRAVEL);

    if (motion === 0 || motion === 1) {
      add(x, y, z, nx, ny, nz, kind, li, feed);
    } else {
      // Bogen in der gewählten Ebene, die dritte Achse läuft linear mit (Helix). u/v = Achsen der Ebene, w = dritte:
      // G17: X/Y, Z · G18: Z/X, Y · G19: Y/Z, X (Reihenfolge wie GRBL, dann stimmt die Drehrichtung)
      const xz = plane === 18, yz = plane === 19;
      const u0 = xz ? z : yz ? y : x, v0 = xz ? x : yz ? z : y, w0 = xz ? y : yz ? x : z;
      const u1 = xz ? nz : yz ? ny : nx, v1 = xz ? nx : yz ? nz : ny, w1 = xz ? ny : yz ? nx : nz;
      const iu = xz ? words.K : yz ? words.J : words.I, iv = xz ? words.I : yz ? words.K : words.J;
      let cx: number, cy: number;
      if (words.R !== undefined && iu === undefined && iv === undefined) {
        const r = words.R * f;
        const dx = u1 - u0, dy = v1 - v0, d = Math.hypot(dx, dy);
        if (d < 1e-9) { x = nx; y = ny; z = nz; continue; }
        const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
        const sgn = (motion === 2) === (r > 0) ? -1 : 1;
        cx = u0 + dx / 2 + (sgn * h * -dy) / d;
        cy = v0 + dy / 2 + (sgn * h * dx) / d;
      } else if (arcAbs) {
        cx = iu === undefined ? u0 : iu * f + (xz ? oz : yz ? oy : ox);
        cy = iv === undefined ? v0 : iv * f + (xz ? ox : yz ? oz : oy);
      } else {
        cx = u0 + (iu || 0) * f;
        cy = v0 + (iv || 0) * f;
      }
      const r = Math.hypot(u0 - cx, v0 - cy);
      const a0 = Math.atan2(v0 - cy, u0 - cx);
      const a1 = Math.atan2(v1 - cy, u1 - cx);
      let sweep = a1 - a0;
      if (motion === 2) { while (sweep >= -1e-9) sweep -= Math.PI * 2; }
      else { while (sweep <= 1e-9) sweep += Math.PI * 2; }
      const step = r > arcTol ? 2 * Math.acos(1 - arcTol / r) : Math.PI / 8;
      const segs = Math.min(720, Math.max(2, Math.ceil(Math.abs(sweep) / step)));
      let px = x, py = y, pz = z;
      const aS = a, aE = na;
      for (let s = 1; s <= segs; s++) {
        na = aS + (aE - aS) * (s / segs);
        const tt = s / segs;
        const a = a0 + sweep * tt;
        const qu = s === segs ? u1 : cx + r * Math.cos(a);
        const qv = s === segs ? v1 : cy + r * Math.sin(a);
        const qw = w0 + (w1 - w0) * tt;
        const qx = xz ? qv : yz ? qw : qu, qy = xz ? qw : yz ? qu : qv, qz = xz ? qu : yz ? qv : qw;
        arcNow = r; arcInside = s > 1 ? 1 : 0;
        add(px, py, pz, qx, qy, qz, kind, li, feed);
        px = qx; py = qy; pz = qz;
      }
      arcNow = 0; arcInside = 0;
    }
    x = nx; y = ny; z = nz;
  }

  const n = x0.length;
  const t0 = new Float64Array(n);
  let t = 0;
  const planned = opts.motion
    ? planDurations({ n, x0, y0, z0, x1, y1, z1, rate: rateOf, len: lenOf, stop: stopOf, dwell: dwellOf, arcR: arcROf, arcIn: arcInOf }, opts.motion)
    : null;
  for (let i = 0; i < n; i++) { t0[i] = t; t += planned ? planned[i] : dur[i]; }

  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let cutMinZ = Infinity, cutMaxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    for (const [px, py, pz] of [[x0[i], y0[i], z0[i]], [x1[i], y1[i], z1[i]]]) {
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
    }
    // Tiefen-Farben nur aus waagerechten Schnitten (Eintauchen von Z+5 würde die Skala verzerren)
    if (type[i] === MOVE_CUT && Math.abs(z0[i] - z1[i]) < 1e-6) {
      if (z0[i] < cutMinZ) cutMinZ = z0[i]; if (z0[i] > cutMaxZ) cutMaxZ = z0[i];
    }
  }
  if (n === 0) { minX = minY = minZ = maxX = maxY = maxZ = 0; }
  if (cutMinZ === Infinity) { cutMinZ = minZ; cutMaxZ = maxZ; }

  const noteList = notes.list();
  return {
    lines, n,
    ...(noteList.length ? { notes: noteList } : {}),
    x0: Float32Array.from(x0), y0: Float32Array.from(y0), z0: Float32Array.from(z0),
    x1: Float32Array.from(x1), y1: Float32Array.from(y1), z1: Float32Array.from(z1),
    type: Uint8Array.from(type), line: Uint32Array.from(lineNo),
    t0, dur: Float32Array.from(planned || dur),
    ...(planned ? { durPlain: Float32Array.from(dur), motion: opts.motion } : {}),
    totalTime: t, cutLength, rapidLength,
    bounds: { minX, minY, minZ, maxX, maxY, maxZ }, cutMinZ, cutMaxZ,
    ...(hasA ? { a0: Float32Array.from(a0), a1: Float32Array.from(a1) } : {})
  };
}

function stripComments(l: string): string {
  // nicht geschlossene Klammer: der Rest ist Kommentar (wie beim Senden)
  return l.replace(/\([^)]*(?:\)|$)/g, "").replace(/;.*$/, "").trim();
}

/** Index der Bewegung, die zur Zeit t läuft (binäre Suche) */
export function moveAtTime(p: SimProgram, t: number): number {
  if (p.n === 0) return -1;
  if (t <= 0) return 0;
  if (t >= p.totalTime) return p.n - 1;
  let lo = 0, hi = p.n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.t0[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Erste Bewegung, die aus Zeile >= line stammt (für "springe zu Zeile") */
export function firstMoveOfLine(p: SimProgram, line: number): number {
  let lo = 0, hi = p.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p.line[mid] < line) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Werkzeugposition zur Zeit t */
export function positionAt(p: SimProgram, t: number): { i: number; frac: number; x: number; y: number; z: number } {
  const i = moveAtTime(p, t);
  if (i < 0) return { i: -1, frac: 0, x: 0, y: 0, z: 0 };
  const d = p.dur[i];
  const frac = d > 0 ? Math.max(0, Math.min(1, (t - p.t0[i]) / d)) : 1;
  return {
    i, frac,
    x: p.x0[i] + (p.x1[i] - p.x0[i]) * frac,
    y: p.y0[i] + (p.y1[i] - p.y0[i]) * frac,
    z: p.z0[i] + (p.z1[i] - p.z0[i]) * frac
  };
}

/** Zeitpunkt, an dem alle Bewegungen VOR einer Zeile fertig sind (für die Live-Anzeige) */
export function timeBeforeLine(p: SimProgram, line: number): number {
  const i = firstMoveOfLine(p, line);
  if (i >= p.n) return p.totalTime;
  return p.t0[i];
}
