/**
 * 3D-MODELL AUTOMATISCH ZERLEGEN (3D-Import → „Automatisch zerlegen“)
 *
 * Aus einem Bauteil, das von oben (Blickrichtung) gefräst wird, werden Fräs-Formen:
 *  - Umriss          → Ausschneiden (außen), volle Stärke
 *  - Durchgangslöcher → Innen, volle Stärke
 *  - Vertiefungen     → Tasche mit der Tiefe ihres Bodens (auch mehrere Stufen ineinander)
 * So geht es:
 *  1. Böden finden: waagerechte, nach oben zeigende Dreiecke zwischen Ober- und Unterseite → Höhen
 *  2. Knapp über jedem Boden schneiden: jedes Loch im Schnitt, unter dem knapp unter dem Boden Material ist,
 *     ist eine Tasche bis zu diesem Boden
 *  3. Knapp über der Unterseite schneiden: Außenkonturen = Umriss, Löcher = Durchgangslöcher
 * Nicht erkannt: Schrägen/Rundungen (Fasen, Radien), Stufen am Außenrand, Hinterschnitte.
 */
import { WeldedMesh, ViewCoords, SliceResult, SliceLoop, Pt, sliceMesh } from "./stlLoader";

export type FeatureKind = "outside" | "inside" | "pocket";
export interface MeshFeature { kind: FeatureKind; depth: number; points: Pt[] }
export interface FeatureResult {
  features: MeshFeature[];
  thickness: number;
  steps: number;      // Stufen am Außenrand (nicht als Tasche erkannt)
  fromBelow: number;  // Löcher nur von unten (nicht durchgehend) – übergangen
  open: number;       // offene Linien (Modell undicht)
  minU: number; minV: number; maxU: number; maxV: number;
}

function inLoop(p: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.v > p.v) !== (b.v > p.v) && p.u < (b.u - a.u) * (p.v - a.v) / (b.v - a.v) + a.u) inside = !inside;
  }
  return inside;
}

/** Material an dieser Stelle des Schnitts? (in ungerade vielen geschlossenen Konturen) */
function material(s: SliceResult, p: Pt): boolean {
  let n = 0;
  for (const l of s.loops) if (l.closed && inLoop(p, l.points)) n++;
  return n % 2 === 1;
}

/** Punkte im Inneren einer Kontur (Raster über die Umgebung) */
function samples(l: SliceLoop, n = 16): Pt[] {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of l.points) { u0 = Math.min(u0, p.u); u1 = Math.max(u1, p.u); v0 = Math.min(v0, p.v); v1 = Math.max(v1, p.v); }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const p = { u: u0 + (u1 - u0) * (i + 0.5) / n, v: v0 + (v1 - v0) * (j + 0.5) / n };
    if (inLoop(p, l.points)) out.push(p);
  }
  return out;
}

/** Höhen der Böden: waagerechte Dreiecke, die nach oben (zum Betrachter) zeigen */
export function floorLevels(mesh: WeldedMesh, vc: ViewCoords): number[] {
  const { u, v, w } = vc, T = vc.maxW - vc.minW;
  const tol = Math.max(1e-4, T * 1e-5), gap = Math.max(0.02, T * 0.002);
  const area = new Map<number, number>();
  for (let t = 0; t < mesh.triangleCount; t++) {
    const a = mesh.tris[3 * t], b = mesh.tris[3 * t + 1], c = mesh.tris[3 * t + 2];
    const wmin = Math.min(w[a], w[b], w[c]), wmax = Math.max(w[a], w[b], w[c]);
    if (wmax - wmin > tol) continue;
    // Normale (Kreuzprodukt in u/v): > 0 = zeigt nach oben, wenn die Dreiecke außen gegen den Uhrzeigersinn laufen
    const nz = (u[b] - u[a]) * (v[c] - v[a]) - (v[b] - v[a]) * (u[c] - u[a]);
    if (nz <= 1e-9) continue;
    const h = Math.round(((wmin + wmax) / 2) / tol) * tol;
    area.set(h, (area.get(h) || 0) + nz / 2);
  }
  const lv = [...area.keys()].filter(h => h > vc.minW + gap && h < vc.maxW - gap).sort((x, y) => y - x);
  // nah beieinander liegende Höhen zusammenfassen
  const out: number[] = [];
  for (const h of lv) if (!out.length || out[out.length - 1] - h > gap) out.push(h);
  return out;
}

export function recognizeFeatures(mesh: WeldedMesh, vc: ViewCoords): FeatureResult {
  const top = vc.maxW, bot = vc.minW, T = top - bot;
  const d = Math.min(0.1, Math.max(0.005, T / 100));
  const res: FeatureResult = { features: [], thickness: T, steps: 0, fromBelow: 0, open: 0, minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity };
  if (!(T > 0)) return res;
  const sBot = sliceMesh(mesh, vc, bot + d), sTop = sliceMesh(mesh, vc, top - d);
  res.open = sBot.openCount;
  const outerArea = (s: SliceResult) => s.loops.reduce((a, l) => a + (l.closed && !l.isHole ? Math.abs(l.area) : 0), 0);
  for (const l of sBot.loops) {
    if (!l.closed) continue;
    if (!l.isHole) { res.features.push({ kind: "outside", depth: T, points: l.points }); continue; }
    // durchgehend = auch oben ist dort kein Material
    const sm = samples(l);
    if (sm.length && sm.some(p => !material(sTop, p))) res.features.push({ kind: "inside", depth: T, points: l.points });
    else res.fromBelow++;
  }
  for (const L of floorLevels(mesh, vc)) {
    const above = sliceMesh(mesh, vc, L + d), below = sliceMesh(mesh, vc, L - d);
    for (const l of above.loops) {
      if (!l.closed || !l.isHole) continue;
      const sm = samples(l);
      // Boden darunter und nach oben offen → Tasche bis zu diesem Boden
      if (sm.some(p => material(below, p)) && sm.some(p => !material(sTop, p)))
        res.features.push({ kind: "pocket", depth: top - L, points: l.points });
    }
    if (outerArea(above) < outerArea(below) * 0.995) res.steps++;
  }
  for (const f of res.features) for (const p of f.points) {
    res.minU = Math.min(res.minU, p.u); res.maxU = Math.max(res.maxU, p.u);
    res.minV = Math.min(res.minV, p.v); res.maxV = Math.max(res.maxV, p.v);
  }
  return res;
}
