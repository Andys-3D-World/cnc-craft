/**
 * TROCHOIDAL ENTLANG DER KONTUR – reine Geometrie, Tests in tests/millPack.test.ts
 *
 * Statt die volle Nut auf einmal zu fräsen, fährt der Fräser kleine Kreise, deren Mitte auf der Kontur wandert: Er greift
 * immer nur ein wenig ein. Dafür wird die Nut breiter (troW in % vom Fräser-Ø) – immer zur Abfall-Seite. Danach fährt
 * die normale Kontur auf Maß. Felder an der Form, nur wenn eingeschaltet:
 *   tro true, troW Nutbreite in % vom Ø, troStep Vorschub je Kreis in % vom Ø, troDown Zustellung in mm (0 = vom Fräser)
 *
 * Sicher, weil die Mitte der Kreise um Fräser-Radius + Kreisradius neben der Kontur liegt: Der Fräser berührt das Teil nie.
 * Die Nut ist höchstens doppelt so breit wie der Fräser – dann bleibt in der Mitte der Kreise nichts stehen.
 */
import { offsetPolygon, polygonArea, type P } from "./polyOffset.ts";
import { distToPath } from "./millLead.ts";

export const TRO_DEFAULT = { w: 160, step: 10 };
export const TRO_W_MIN = 120, TRO_W_MAX = 200, TRO_STEP_MIN = 2, TRO_STEP_MAX = 40;
/** so viel bleibt an der Wand für die Kontur danach stehen (saubere Wand; gleicht auch Kreise als Vieleck aus) */
export const TRO_LEAVE = 0.05;
/** mehr Kreise als das werden nicht erzeugt (riesige Datei) */
const MAX_LOOPS = 40000;

export interface TroOpts { w: number; step: number; down: number }

const num = (v: any, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);

/** Wirkt die Einstellung an dieser Form? (geschlossene Kontur außen oder innen) */
export function troFits(s: any): boolean {
  const m = s?.millingMode || "outside";
  return !!s && (m === "outside" || m === "inside") && (s.type === "circle" || (s.type === "polyline" && s.closed === true));
}

/** Einstellungen der Form (bereinigt); null = aus */
export function troSettings(s: any): TroOpts | null {
  if (!s || s.tro !== true) return null;
  return { w: num(s.troW, TRO_DEFAULT.w, TRO_W_MIN, TRO_W_MAX), step: num(s.troStep, TRO_DEFAULT.step, TRO_STEP_MIN, TRO_STEP_MAX), down: num(s.troDown, 0, 0, 200) };
}

export interface TroPlan {
  /** Radius der kleinen Kreise */
  rho: number;
  /** je Umlauf die Mittelpunkte der Kreise; start = Stelle auf dem Kreis, an der er beginnt und endet (hinten) */
  loops: { c: P; start: P }[][];
  /** hat die Nut die ganze Kontur freigelegt? (sonst muss die Kontur in normalen Durchgängen nachkommen) */
  full: boolean;
}

/**
 * Bahnen für eine Kontur (mm). side = außen/innen, r = Fräser-Radius, allow = Schlicht-Aufmaß, das stehen bleibt.
 * null = kein Platz (innen zu eng) oder zu viele Kreise.
 */
export function trochoidPlan(poly: P[], side: "outside" | "inside", r: number, allow: number, o: TroOpts): TroPlan | null {
  const rho = (2 * r * o.w / 100 - 2 * r) / 2;
  const sg = side === "outside" ? 1 : -1;
  const rings = offsetPolygon(poly, sg * (r + allow + TRO_LEAVE + rho));
  if (!rings.length || !(rho > 0)) return null;
  const step = 2 * r * o.step / 100;
  const loops: { c: P; start: P }[][] = [];
  let total = 0;
  for (const ring0 of rings) {
    // Umlauf wie die normale Kontur: außen gegen, innen im Uhrzeigersinn (die Richtung der Kreise zählt, nicht die des Umlaufs)
    const ring = (side === "outside") === (polygonArea(ring0) > 0) ? ring0 : [ring0[0], ...ring0.slice(1).reverse()];
    const cum = [0];
    for (let i = 1; i <= ring.length; i++) cum.push(cum[i - 1] + Math.hypot(ring[i % ring.length].x - ring[i - 1].x, ring[i % ring.length].y - ring[i - 1].y));
    const L = cum[cum.length - 1];
    if (L < 1e-6) continue;
    const n = Math.max(8, Math.ceil(L / step));
    total += n;
    if (total > MAX_LOOPS) return null;
    const list: { c: P; start: P }[] = [];
    let i = 1;
    for (let k = 0; k <= n; k++) {
      const s = L * k / n;
      while (i < cum.length - 1 && cum[i] < s) i++;
      const a = ring[i - 1], b = ring[i % ring.length], l = Math.max(1e-12, cum[i] - cum[i - 1]), f = (s - cum[i - 1]) / l;
      const ux = (b.x - a.x) / l, uy = (b.y - a.y) / l, c = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      list.push({ c, start: { x: c.x - ux * rho, y: c.y - uy * rho } });
    }
    loops.push(list);
  }
  if (!loops.length) return null;
  // Jeder Punkt der fertigen Kontur muss in der freigefrästen Nut liegen, sonst steht dort (enge Ecke) noch Material
  const want = offsetPolygon(poly, sg * (r + allow));
  let full = want.length > 0;
  const tol = TRO_LEAVE + Math.max(0.05, 0.1 * rho);
  for (const w of want) {
    for (let i = 0; full && i < w.length; i++) {
      const a = w[i], b = w[(i + 1) % w.length], l = Math.hypot(b.x - a.x, b.y - a.y), m = Math.max(1, Math.ceil(l / Math.max(0.2, r / 2)));
      for (let k = 0; k < m; k++) {
        const p = { x: a.x + (b.x - a.x) * k / m, y: a.y + (b.y - a.y) * k / m };
        if (!rings.some(q => distToPath(p, q, true) <= rho + tol)) { full = false; break; }
      }
    }
  }
  return { rho, loops, full };
}

/** Höhen, in denen der Fräser bei einem Kreis mit Radius rho in Schraubenlinie eintaucht (letzte = z) */
export function helixZ(zTop: number, z: number, rho: number, tan: number): number[] {
  const drop = zTop - z;
  if (!(drop > 1e-6)) return [z];
  const revs = Math.max(1, Math.min(400, Math.ceil(drop / Math.max(1e-6, (tan > 0 ? tan : Math.tan(3 * Math.PI / 180)) * 2 * Math.PI * rho))));
  return Array.from({ length: revs }, (_, k) => zTop - drop * (k + 1) / revs);
}
