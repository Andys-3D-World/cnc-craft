/**
 * ECKEN-LEISTUNG für Laser OHNE dynamische Leistung (M3, z. B. Marlin)
 *
 * Mit M4 regelt GRBL die Leistung selbst nach der echten Geschwindigkeit. Mit M3 bleibt sie fest – in Ecken bremst
 * die Maschine ab, verweilt länger und brennt dunkler. Hier wird die Bremsfahrt nachgerechnet und die Leistung
 * im G-Code passend gesenkt:
 *   Kurvengeschwindigkeit an einer Ecke wie im GRBL-Planer (Junction Deviation):
 *     cos θ = −(u_ein · u_aus),  sin(θ/2) = √((1 − cos θ)/2),  v_Ecke² = a · δ · sin(θ/2) / (1 − sin(θ/2))
 *   Bremsweg von v auf v_Ecke: (v² − v_Ecke²) / (2a). Im Brems- und Beschleunigungsbereich wird jede Strecke in
 *   kleine Stücke geteilt, jedes mit S × (Geschwindigkeit dort / v) – nie unter dem Mindestanteil.
 * Anfang und Ende offener Linien gelten als Stillstand (dort fährt die Maschine an bzw. hält).
 * Keine Abhängigkeiten (Tests: `npm test`).
 */

export type Pt = { x: number; y: number };
export interface CornerOpts { accel: number; deviation: number; minPct: number }
/** Ein G1-Stück: Zielpunkt und S-Wert */
export interface PowerMove { x: number; y: number; s: number }

const STEPS = 3;        // Stücke je Brems-/Beschleunigungsbereich
const MIN_PIECE = 0.15; // kürzer wird nicht geteilt (mm)

/** Kurvengeschwindigkeit (mm/s) an einem Punkt zwischen zwei Richtungen, höchstens v */
export function junctionSpeed(a: Pt, b: Pt, c: Pt, v: number, o: CornerOpts): number {
  const ux = b.x - a.x, uy = b.y - a.y, wx = c.x - b.x, wy = c.y - b.y;
  const lu = Math.hypot(ux, uy), lw = Math.hypot(wx, wy);
  if (lu < 1e-9 || lw < 1e-9) return v;
  const cos = -(ux * wx + uy * wy) / (lu * lw);
  if (cos < -0.999999) return v; // geradeaus
  const sin = Math.sqrt(Math.max(0, 0.5 * (1 - cos)));
  if (sin >= 0.999999) return v;
  return Math.min(v, Math.sqrt((o.accel * o.deviation * sin) / (1 - sin)));
}

/**
 * Pfad (erster Punkt = Startposition, dorthin wurde schon gefahren) → G1-Stücke mit S.
 * @param feed  Vorschub mm/min,  S  volle Leistung
 */
export function cornerPowerPath(pts: Pt[], closed: boolean, feed: number, S: number, o: CornerOpts): PowerMove[] {
  const P = closed && (pts[0].x !== pts[pts.length - 1].x || pts[0].y !== pts[pts.length - 1].y) ? [...pts, pts[0]] : pts;
  const n = P.length;
  if (n < 2) return [];
  const v = Math.max(1, feed / 60), a = Math.max(10, o.accel), minK = Math.min(1, Math.max(0, o.minPct / 100));
  // Geschwindigkeit an jedem Punkt
  const vAt: number[] = P.map((p, i) => {
    if (i === 0 || i === n - 1) {
      // geschlossen: Start = Ende, Ecke zwischen letzter und erster Strecke; offen: Stillstand
      if (!closed || n < 3) return 0;
      return junctionSpeed(P[n - 2], P[0], P[1], v, o);
    }
    return junctionSpeed(P[i - 1], p, P[i + 1], v, o);
  });
  const sOf = (sp: number) => Math.round(S * Math.max(minK, Math.min(1, sp / v)));
  const out: PowerMove[] = [];
  const push = (x: number, y: number, s: number) => {
    const last = out[out.length - 1];
    if (last && last.s === s && out.length > 1) {
      // gleiche Leistung wie das Stück davor: nur verlängern, wenn es auf derselben Geraden liegt
      const prev = out[out.length - 2];
      const cross = (last.x - prev.x) * (y - last.y) - (last.y - prev.y) * (x - last.x);
      if (Math.abs(cross) < 1e-9) { last.x = x; last.y = y; return; }
    }
    out.push({ x, y, s });
  };
  for (let i = 0; i + 1 < n; i++) {
    const A = P[i], B = P[i + 1], L = Math.hypot(B.x - A.x, B.y - A.y);
    if (L < 1e-9) continue;
    const vA = vAt[i], vB = vAt[i + 1];
    // Beschleunigen ab A, Bremsen vor B; treffen sich die Bereiche, gilt die kleinere Kurve (Dreieck)
    let dA = Math.max(0, (v * v - vA * vA) / (2 * a)), dB = Math.max(0, (v * v - vB * vB) / (2 * a));
    if (dA + dB > L) {
      const peak2 = (2 * a * L + vA * vA + vB * vB) / 2; // höchste Geschwindigkeit²
      dA = Math.max(0, (peak2 - vA * vA) / (2 * a)); dB = Math.max(0, L - dA);
    }
    const at = (d: number) => ({ x: A.x + ((B.x - A.x) * d) / L, y: A.y + ((B.y - A.y) * d) / L });
    const speedAt = (d: number) => Math.min(v, Math.sqrt(vA * vA + 2 * a * d), Math.sqrt(vB * vB + 2 * a * (L - d)));
    const cuts: number[] = [];
    if (dA >= MIN_PIECE) for (let k = 1; k <= STEPS; k++) cuts.push((dA * k) / STEPS);
    if (dB >= MIN_PIECE) for (let k = STEPS - 1; k >= 0; k--) cuts.push(L - (dB * k) / STEPS);
    cuts.push(L);
    let from = 0;
    for (const d of [...new Set(cuts.map(x => Math.min(L, Math.max(0, x))))].sort((p, q) => p - q)) {
      if (d - from < 1e-6) continue;
      const q = at(d);
      push(q.x, q.y, sOf(speedAt((from + d) / 2)));
      from = d;
    }
  }
  return out;
}
