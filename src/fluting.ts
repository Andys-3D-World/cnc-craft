/**
 * FLÖTEN (Nuten, die sanft ein- und auslaufen) – reine Rechnung, Tests in tests/millPack.test.ts
 *
 * Für offene Linien „auf Linie“ (Fräse): Die Tiefe läuft am Anfang über fluteIn mm von fluteStart % auf die volle
 * Frästiefe und am Ende über fluteOut mm auf fluteEnd % zurück. Felder an der Form, nur wenn eingeschaltet:
 *   flute      true
 *   fluteIn    Länge des Einlaufs (mm)      fluteOut  Länge des Auslaufs (mm)
 *   fluteStart Tiefe am Anfang (% von voll) fluteEnd  Tiefe am Ende (%)
 *   fluteEase  "linear" = gerade Schräge, sonst weich (S-Kurve ohne Knick)
 *
 * Jeder Durchgang fährt nur das Stück, das tiefer liegt als der Durchgang davor – er taucht dort ein, wo die Kurve die
 * Tiefe des vorigen Durchgangs erreicht, und kommt dort auch wieder heraus. So wird nie tiefer gefräst als die Kurve.
 */
export interface P2 { x: number; y: number }
export interface FluteOpts { in: number; out: number; start: number; end: number; linear: boolean }
export interface FlutePoint { x: number; y: number; z: number }

export const FLUTE_DEFAULT = { in: 20, out: 20, start: 0, end: 0 };
const MAX_LEN = 5000;

const num = (v: any, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);

/** Wirkt die Einstellung an dieser Form? (offene Linie, „auf Linie“) */
export function fluteFits(s: any): boolean {
  if (!s || (s.millingMode || "outside") !== "on-line") return false;
  return s.type === "line" || s.type === "arc" || (s.type === "polyline" && !s.closed && Array.isArray(s.points) && s.points.length >= 2);
}

/** Einstellungen der Form (bereinigt – können aus Projektdateien kommen); null = aus */
export function fluteSettings(s: any): FluteOpts | null {
  if (!s || s.flute !== true) return null;
  return {
    in: num(s.fluteIn, FLUTE_DEFAULT.in, 0, MAX_LEN), out: num(s.fluteOut, FLUTE_DEFAULT.out, 0, MAX_LEN),
    start: num(s.fluteStart, FLUTE_DEFAULT.start, 0, 100), end: num(s.fluteEnd, FLUTE_DEFAULT.end, 0, 100),
    linear: s.fluteEase === "linear"
  };
}

/** Ein- und Auslauf auf eine Bahn der Länge L bringen: zusammen nie länger als die Bahn */
export function fluteZones(L: number, o: FluteOpts): { in: number; out: number } {
  const sum = o.in + o.out;
  return sum > L && sum > 0 ? { in: L * o.in / sum, out: L * o.out / sum } : { in: o.in, out: o.out };
}

/** Anteil der vollen Tiefe (0…1) bei Länge s auf einer Bahn der Länge L */
export function fluteFrac(s: number, L: number, o: FluteOpts): number {
  const z = fluteZones(L, o);
  const ease = (u: number) => { u = Math.max(0, Math.min(1, u)); return o.linear ? u : u * u * (3 - 2 * u); };
  const a = z.in > 0 ? o.start / 100 + (1 - o.start / 100) * ease(s / z.in) : 1;
  const b = z.out > 0 ? o.end / 100 + (1 - o.end / 100) * ease((L - s) / z.out) : 1;
  return Math.min(a, b);
}

/** Stützstellen der Bahn mit der Tiefe nach der Kurve: alle Ecken und im Ein-/Auslauf alle ~0,5 mm */
function profile(pts: P2[], depth: number, o: FluteOpts): { pts: (FlutePoint & { s: number })[]; L: number } {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const L = cum[cum.length - 1];
  const zones = fluteZones(L, o);
  const at = new Set<number>(cum);
  const zone = (from: number, len: number) => {
    const n = Math.min(400, Math.max(32, Math.ceil(len / 0.5)));
    if (len > 1e-6) for (let k = 0; k <= n; k++) at.add(Math.min(L, Math.max(0, from + len * k / n)));
  };
  zone(0, zones.in); zone(L - zones.out, zones.out);
  const out: (FlutePoint & { s: number })[] = [];
  let i = 1;
  for (const s of [...at].sort((a, b) => a - b)) {
    if (out.length && s - out[out.length - 1].s < 1e-6) continue;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const f = (s - cum[i - 1]) / Math.max(1e-12, cum[i] - cum[i - 1]);
    out.push({ s, x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f, z: depth * fluteFrac(s, L, o) });
  }
  return { pts: out, L };
}

/** Punkte, die auf einer Geraden im Raum liegen, weglassen (Abweichung unter 0,002 mm) */
function thin(p: FlutePoint[]): FlutePoint[] {
  const out: FlutePoint[] = [];
  for (let i = 0; i < p.length; i++) {
    if (i === 0 || i === p.length - 1) { out.push(p[i]); continue; }
    const a = out[out.length - 1], b = p[i + 1], c = p[i];
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, l2 = dx * dx + dy * dy + dz * dz;
    const f = l2 > 0 ? ((c.x - a.x) * dx + (c.y - a.y) * dy + (c.z - a.z) * dz) / l2 : 0;
    if (f < 0 || f > 1 || Math.hypot(a.x + dx * f - c.x, a.y + dy * f - c.y, a.z + dz * f - c.z) > 0.002) out.push(c);
  }
  return out;
}

export interface FlutePass { pts: FlutePoint[]; top: number }

/**
 * Bahnen je Durchgang: passes = Tiefen von oben nach unten (negativ, die letzte = volle Tiefe).
 * top = bis hierhin ist an der Eintauchstelle schon alles frei.
 */
export function flutePasses(path: P2[], passes: number[], o: FluteOpts): FlutePass[] {
  const depth = passes[passes.length - 1];
  if (path.length < 2 || !(depth < 0)) return [];
  const prof = profile(path, depth, o);
  if (!(prof.L > 1e-6)) return [];
  const out: FlutePass[] = [];
  let prev = 0;
  for (const z of passes) {
    // zusammenhängendes Stück, an dem die Kurve tiefer liegt als der vorige Durchgang (die Kurve hat nur ein Tal)
    const p = prof.pts, pts: FlutePoint[] = [];
    for (let i = 0; i < p.length; i++) {
      const q = p[i + 1], deep = (w?: { z: number }) => !!w && w.z < prev - 1e-9;
      // genau auf der Höhe des vorigen Durchgangs zählt mit, wenn es daneben tiefer wird (Anfang/Ende der Kurve)
      const below = deep(p[i]) || (p[i].z <= prev + 1e-9 && (deep(p[i - 1]) || deep(q)));
      if (below) pts.push({ x: p[i].x, y: p[i].y, z: Math.max(z, p[i].z) });
      // Übergänge genau treffen: Tiefe des vorigen Durchgangs (rein/raus) und Tiefe dieses Durchgangs (Knick)
      if (q) {
        const cross = [prev, z].map(c => (c - p[i].z) / (q.z - p[i].z)).filter(f => Number.isFinite(f) && f > 1e-9 && f < 1 - 1e-9).sort((a, b) => a - b);
        for (const f of cross) {
          const zz = p[i].z + (q.z - p[i].z) * f;
          pts.push({ x: p[i].x + (q.x - p[i].x) * f, y: p[i].y + (q.y - p[i].y) * f, z: Math.max(z, Math.min(prev, zz)) });
        }
      }
    }
    const t = thin(pts);
    if (t.length > 1) out.push({ pts: t, top: prev });
    prev = z;
  }
  return out;
}
