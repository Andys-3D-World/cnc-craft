/**
 * LAUFZEIT MIT BESCHLEUNIGUNG (wie der GRBL-Planer rechnet)
 *
 * Eine Schätzung, die näher dran ist – nicht „exakt“: Übertragung, Überschreibungen und Firmware-Eigenheiten fehlen.
 *  - je Bewegung: Vorschub, begrenzt durch $110–$112; Beschleunigung, begrenzt durch $120–$122
 *  - je Ecke: Kurvengeschwindigkeit aus der Kurvenabweichung $11 (viele kurze Stücke und Bögen hängen daran)
 *  - Vorausschau: die Maschine muss am Ende ihres Puffers anhalten können (16 Blöcke bei GRBL)
 * Ein Durchlauf rückwärts, einer vorwärts: O(n), auch bei Millionen Zeilen schnell. Keine Abhängigkeiten (Tests: `npm test`).
 */

export interface MotionLimits {
  accel: number[];      // $120–$122, mm/s²
  maxRate: number[];    // $110–$112, mm/min
  junctionDev: number;  // $11, mm
  arcTol?: number;      // $12, mm (Standard 0,002): so fein teilt die Steuerung Bögen
  lookahead: number;    // Blöcke im Puffer
  source?: "machine" | "saved" | "default";
}

export interface PlanInput {
  n: number;
  x0: ArrayLike<number>; y0: ArrayLike<number>; z0: ArrayLike<number>;
  x1: ArrayLike<number>; y1: ArrayLike<number>; z1: ArrayLike<number>;
  /** gewünschter Vorschub in mm/min; 0 = Eilgang (so schnell, wie die Achsen dürfen) */
  rate: ArrayLike<number>;
  /** Weglänge (mit Drehachse länger als die XYZ-Strecke) */
  len: ArrayLike<number>;
  /** 1 = davor steht die Maschine (G4, M3, M5 …) */
  stop: ArrayLike<number>;
  dwell: ArrayLike<number>;
  /** Bogen: Radius (0 = gerade); arcIn = 1: Stück innerhalb des Bogens (nicht das erste) */
  arcR?: ArrayLike<number>;
  arcIn?: ArrayLike<number>;
}

/** Zeit für eine Strecke L von v²=e nach v²=x mit Höchstwert v²=n */
function blockTime(L: number, e: number, x: number, n: number, a: number): number {
  const ve = Math.sqrt(e), vx = Math.sqrt(x);
  const peak2 = (2 * a * L + e + x) / 2;
  if (peak2 <= n) return Math.max(0, (2 * Math.sqrt(peak2) - ve - vx) / a); // ohne Reisegeschwindigkeit
  const vn = Math.sqrt(n);
  const cruise = Math.max(0, L - (n - e) / (2 * a) - (n - x) / (2 * a));
  return (vn - ve) / a + (vn - vx) / a + cruise / vn;
}

/** Dauer jeder Bewegung in Sekunden (mit Wartezeit) */
export function planDurations(m: PlanInput, lim: MotionLimits): Float64Array {
  const n = m.n;
  const dur = new Float64Array(n);
  if (!n) return dur;
  const [ax, ay, az] = lim.accel, [rx, ry, rz] = lim.maxRate;
  const look = Math.max(1, lim.lookahead | 0);
  const tol = lim.arcTol && lim.arcTol > 0 ? lim.arcTol : 0.002;
  const nom2 = new Float64Array(n);  // Höchstgeschwindigkeit² (mm/s)²
  const acc = new Float64Array(n);
  const ent = new Float64Array(n);   // erlaubte Einfahrt²
  let px = 0, py = 0, pz = 0, pn = 0, hasPrev = false;
  for (let i = 0; i < n; i++) {
    const dx = m.x1[i] - m.x0[i], dy = m.y1[i] - m.y0[i], dz = m.z1[i] - m.z0[i];
    const geo = Math.hypot(dx, dy, dz), L = m.len[i];
    const ux = geo > 1e-12 ? dx / L : 0, uy = geo > 1e-12 ? dy / L : 0, uz = geo > 1e-12 ? dz / L : 0;
    const axU = Math.abs(ux), ayU = Math.abs(uy), azU = Math.abs(uz);
    // Achsen-Grenzen auf die Bahn umrechnen (X allein: voll; schräg: die erste Achse am Limit begrenzt)
    let v = Infinity, a = Infinity;
    if (axU > 1e-12) { v = Math.min(v, rx / axU); a = Math.min(a, ax / axU); }
    if (ayU > 1e-12) { v = Math.min(v, ry / ayU); a = Math.min(a, ay / ayU); }
    if (azU > 1e-12) { v = Math.min(v, rz / azU); a = Math.min(a, az / azU); }
    if (a === Infinity) { a = Math.min(ax, ay); v = m.rate[i] > 0 ? m.rate[i] : Math.min(rx, ry); } // nur Drehachse
    const want = m.rate[i] > 0 ? Math.min(m.rate[i], v) : v;
    const vn = Math.max(1, want) / 60;
    nom2[i] = vn * vn;
    acc[i] = a;

    let j = 0;
    if (hasPrev && !m.stop[i]) {
      const c = -(px * ux + py * uy + pz * uz); // −1 = geradeaus, +1 = Umkehr
      if (c < -0.999999 && !(m.arcIn && m.arcIn[i])) j = Infinity;
      else if (c > 0.999999) j = 0;
      else {
        const wx = ux - px, wy = uy - py, wz = uz - pz;
        const wl = Math.hypot(wx, wy, wz) || 1;
        let ja = Infinity;
        if (Math.abs(wx) > 1e-12) ja = Math.min(ja, ax / Math.abs(wx / wl));
        if (Math.abs(wy) > 1e-12) ja = Math.min(ja, ay / Math.abs(wy / wl));
        if (Math.abs(wz) > 1e-12) ja = Math.min(ja, az / Math.abs(wz / wl));
        if (ja === Infinity) ja = Math.min(ax, ay);
        const s = Math.sqrt(0.5 * (1 - c));
        // Im Bogen zählen die Stücke der Steuerung (Knick aus $12), nicht die feiner oder gröber gezeichneten der Anzeige
        const arcInside = m.arcIn ? m.arcIn[i] : 0;
        j = arcInside ? (ja * lim.junctionDev * m.arcR![i]) / tol : (ja * lim.junctionDev * s) / (1 - s);
      }
      j = Math.min(j, nom2[i], pn);
    }
    ent[i] = j;
    px = ux; py = uy; pz = uz; pn = nom2[i]; hasPrev = true;
  }

  // rückwärts: von jedem Punkt aus muss das Anhalten am Ende (und am Pufferende) reichen
  let exit2 = 0, sum = 0;
  for (let i = n - 1; i >= 0; i--) {
    const L = m.len[i], a = acc[i];
    sum += L;
    if (i + look < n) sum -= m.len[i + look];
    let e = Math.min(ent[i], exit2 + 2 * a * L, 2 * a * Math.max(0, sum));
    const r = m.arcR ? m.arcR[i] : 0;
    if (r > 0) e = Math.min(e, 2 * a * look * Math.sqrt(8 * tol * r)); // im Bogen sind die Puffer-Blöcke kurz
    if (m.stop[i]) e = 0;
    ent[i] = e;
    exit2 = e;
  }
  // vorwärts: Beschleunigen braucht Weg
  let v2 = 0;
  for (let i = 0; i < n; i++) {
    const L = m.len[i], a = acc[i];
    const e = Math.min(ent[i], v2);
    const x = Math.min(i + 1 < n ? ent[i + 1] : 0, e + 2 * a * L);
    dur[i] = (L > 0 ? blockTime(L, e, x, nom2[i], a) : 0) + m.dwell[i];
    v2 = x;
  }
  return dur;
}
