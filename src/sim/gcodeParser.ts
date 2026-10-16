/**
 * G-CODE-LESER FÜR DIE SIMULATION
 *
 * Wandelt G-Code in eine Liste von Bewegungen um (gerade Stücke; Bögen werden fein unterteilt).
 * Jede Bewegung weiß, aus welcher Zeile sie stammt und wann sie beginnt (Zeitschätzung).
 *
 * Verstanden wird: G0/G1/G2/G3 (I/J- und R-Schreibweise, auch Helix mit Z), G17, G20/G21, G90/G91,
 * F (Vorschub), M3/M4/M5 (Spindel/Laser/Plasma an/aus, S0 = aus), G4 (Warten, zählt zur Zeit),
 * G38.x (Antasten – wird nicht nachgebildet), Kommentare ( ) und ;
 *
 * Bewegungsarten:  0 = Eilgang (G0), 1 = Schnitt (G1-G3 mit Werkzeug an), 2 = Leerfahrt (G1 mit Werkzeug aus)
 * Enthält die Datei gar keine M3/M4/M5-Befehle, gilt jede G1-G3-Bewegung als Schnitt.
 */

export const MOVE_RAPID = 0;
export const MOVE_CUT = 1;
export const MOVE_TRAVEL = 2;

export interface SimProgram {
  lines: string[];
  n: number;
  x0: Float32Array; y0: Float32Array; z0: Float32Array;
  x1: Float32Array; y1: Float32Array; z1: Float32Array;
  type: Uint8Array;
  line: Uint32Array;          // Zeilennummer (0-basiert) der Bewegung
  t0: Float64Array;           // Startzeit in Sekunden
  dur: Float32Array;          // Dauer in Sekunden
  totalTime: number;
  cutLength: number;
  rapidLength: number;
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  cutMinZ: number;            // tiefste Schnitt-Höhe
  cutMaxZ: number;
}

export interface ParseOptions {
  rapidRate?: number;   // mm/min für G0 (Schätzung)
  defaultFeed?: number; // mm/min, falls kein F angegeben
  arcTol?: number;      // mm, Genauigkeit der Bogen-Unterteilung
}

export function parseGcodeProgram(lines: string[], opts: ParseOptions = {}): SimProgram {
  const rapidRate = opts.rapidRate ?? 5000;
  const arcTol = opts.arcTol ?? 0.02;

  const x0: number[] = [], y0: number[] = [], z0: number[] = [];
  const x1: number[] = [], y1: number[] = [], z1: number[] = [];
  const type: number[] = [], lineNo: number[] = [], dur: number[] = [];

  // Gibt es überhaupt Spindel-Befehle? Sonst ist jede Vorschub-Bewegung ein Schnitt.
  const hasSpindle = lines.some(l => /\bM0?[345]\b/i.test(stripComments(l)));

  let x = 0, y = 0, z = 0;
  let absolute = true, inch = false;
  let motion = 0;
  let feed = opts.defaultFeed ?? 1000;
  let toolCmdOn = false;  // M3/M4 aktiv
  let power = 1;          // letzter S-Wert (S0 = Laser/Plasma aus)
  let cutLength = 0, rapidLength = 0;
  let dwell = 0; // Wartezeit (G4), wird der nächsten Bewegung zugeschlagen

  const add = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, kind: number, li: number, f: number) => {
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    if (len < 1e-9) return;
    x0.push(ax); y0.push(ay); z0.push(az); x1.push(bx); y1.push(by); z1.push(bz);
    type.push(kind); lineNo.push(li);
    const rate = kind === MOVE_RAPID ? rapidRate : Math.max(1, f);
    dur.push(len / (rate / 60) + dwell);
    dwell = 0;
    if (kind === MOVE_RAPID) rapidLength += len; else if (kind === MOVE_CUT) cutLength += len;
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
      if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
      else if (g === 90) absolute = true;
      else if (g === 91) absolute = false;
      else if (g === 20) inch = true;
      else if (g === 21) inch = false;
    }
    const f = inch ? 25.4 : 1;
    if (words.F !== undefined) feed = words.F * f;

    if (words.S !== undefined) power = words.S;
    for (const mc of ms) {
      if (mc === 3 || mc === 4) toolCmdOn = true;
      else if (mc === 5 || mc === 2 || mc === 30) toolCmdOn = false;
    }
    const spindleOn = !hasSpindle || (toolCmdOn && power > 0);

    // G4 P = warten (Sekunden; bei GRBL immer Sekunden)
    if (gs.includes(4)) { if (words.P !== undefined) dwell += Math.max(0, words.P); continue; }
    // Antasten (G38.2 usw.): Ergebnis ist unbekannt -> nicht nachbilden
    if (gs.some(g => g >= 38 && g < 39)) continue;

    const hasXYZ = words.X !== undefined || words.Y !== undefined || words.Z !== undefined;
    if (!hasXYZ) continue;
    // G53/G28 usw. nicht nachbilden
    if (gs.some(g => g === 28 || g === 30 || g === 53 || g === 92)) continue;

    const nx = words.X === undefined ? x : (absolute ? words.X * f : x + words.X * f);
    const ny = words.Y === undefined ? y : (absolute ? words.Y * f : y + words.Y * f);
    const nz = words.Z === undefined ? z : (absolute ? words.Z * f : z + words.Z * f);
    const kind = motion === 0 ? MOVE_RAPID : (spindleOn ? MOVE_CUT : MOVE_TRAVEL);

    if (motion === 0 || motion === 1) {
      add(x, y, z, nx, ny, nz, kind, li, feed);
    } else {
      // Bogen (XY-Ebene), Z läuft linear mit (Helix)
      let cx: number, cy: number;
      if (words.R !== undefined && words.I === undefined && words.J === undefined) {
        const r = words.R * f;
        const dx = nx - x, dy = ny - y, d = Math.hypot(dx, dy);
        if (d < 1e-9) { x = nx; y = ny; z = nz; continue; }
        const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
        const sgn = (motion === 2) === (r > 0) ? -1 : 1;
        cx = x + dx / 2 + (sgn * h * -dy) / d;
        cy = y + dy / 2 + (sgn * h * dx) / d;
      } else {
        cx = x + (words.I || 0) * f;
        cy = y + (words.J || 0) * f;
      }
      const r = Math.hypot(x - cx, y - cy);
      const a0 = Math.atan2(y - cy, x - cx);
      const a1 = Math.atan2(ny - cy, nx - cx);
      let sweep = a1 - a0;
      if (motion === 2) { while (sweep >= -1e-9) sweep -= Math.PI * 2; }
      else { while (sweep <= 1e-9) sweep += Math.PI * 2; }
      const step = r > arcTol ? 2 * Math.acos(1 - arcTol / r) : Math.PI / 8;
      const segs = Math.min(720, Math.max(2, Math.ceil(Math.abs(sweep) / step)));
      let px = x, py = y, pz = z;
      for (let s = 1; s <= segs; s++) {
        const tt = s / segs;
        const a = a0 + sweep * tt;
        const qx = s === segs ? nx : cx + r * Math.cos(a);
        const qy = s === segs ? ny : cy + r * Math.sin(a);
        const qz = z + (nz - z) * tt;
        add(px, py, pz, qx, qy, qz, kind, li, feed);
        px = qx; py = qy; pz = qz;
      }
    }
    x = nx; y = ny; z = nz;
  }

  const n = x0.length;
  const t0 = new Float64Array(n);
  let t = 0;
  for (let i = 0; i < n; i++) { t0[i] = t; t += dur[i]; }

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

  return {
    lines, n,
    x0: Float32Array.from(x0), y0: Float32Array.from(y0), z0: Float32Array.from(z0),
    x1: Float32Array.from(x1), y1: Float32Array.from(y1), z1: Float32Array.from(z1),
    type: Uint8Array.from(type), line: Uint32Array.from(lineNo),
    t0, dur: Float32Array.from(dur),
    totalTime: t, cutLength, rapidLength,
    bounds: { minX, minY, minZ, maxX, maxY, maxZ }, cutMinZ, cutMaxZ
  };
}

function stripComments(l: string): string {
  return l.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").trim();
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
