/**
 * HOLZVERBINDUNGEN für die Fräse (und den Laser): zwei Bretter, die genau ineinanderpassen (Fenster: editor/jointGen.ts)
 *
 *   finger    Fingerzinken für eine Ecke (90°): Teil A und B haben abwechselnd Finger und Schlitze, Tiefe = Materialdicke.
 *             Innenecken bekommen Dogbones (Kreis mit Fräser-Radius auf der Winkelhalbierenden) oder T-Bones (Kreis
 *             in der Schlitz-Flanke) – sonst bleibt dort der Fräser-Radius stehen und die Finger passen nicht hinein.
 *   dovetail  Schwalbenschwanz in der Fläche: zwei Platten Stoß an Stoß verbinden (z. B. größer als das Bett).
 *             Alle Außenecken werden mit Fräser-Radius + Spiel gerundet; die Innenecken rundet der Fräser selbst
 *             (kleinerer Radius) – so passt es ohne Dogbones.
 * Spiel: jedes Teil wird um Spiel/2 kleiner (Finger schmaler, Schlitze breiter → zusammen genau das Spiel).
 *
 * Nur Geometrie (Tests: `npm test`). Alles in mm, Y nach oben. Die Fuge liegt bei x = 0, Breite von y = 0 bis W.
 * Teil A liegt links (x < 0), Teil B rechts (x > 0); Längen gelten ab der Fuge. Beim Fingerzinken liegen die Finger
 * von B flach in den Schlitzen von A (x = −t … 0) – so sieht man, wie es zusammengehört.
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Polygon } from "polygon-clipping";
import { offsetPolygon } from "./polyOffset.ts";

export type XY = [number, number];
export type JointKind = "finger" | "dovetail";
export const JOINT_KINDS: JointKind[] = ["finger", "dovetail"];
export type Relief = "dogbone" | "tbone" | "none";
export const RELIEFS: Relief[] = ["dogbone", "tbone", "none"];

export interface JointOptions {
  kind: JointKind;
  width: number;       // Breite der Fuge W (mm)
  thickness: number;   // Materialdicke (Fingerzinken: Tiefe)
  count: number;       // Finger bzw. Schwalbenschwänze
  lengthA: number;     // Länge Teil A (ohne Zinken)
  lengthB: number;     // Länge Teil B
  tool: number;        // Fräser-Ø (0 = Laser, keine Rundung/Dogbones)
  clearance: number;   // Spiel (mm)
  relief: Relief;      // Fingerzinken: Innenecken
  angle: number;       // Schwalbenschwanz: Flankenwinkel (°)
  depth: number;       // Schwalbenschwanz: Tiefe (mm)
}

export interface JointResult { a: MultiPolygon; b: MultiPolygon; segments: number; bones: number; warnings: string[] }

function circle(cx: number, cy: number, r: number): XY[] {
  const n = Math.max(24, Math.min(120, Math.ceil(2 * Math.PI * r / 0.2)));
  const out: XY[] = [];
  for (let i = 0; i < n; i++) out.push([cx + r * Math.cos(2 * Math.PI * i / n), cy + r * Math.sin(2 * Math.PI * i / n)]);
  out.push([out[0][0], out[0][1]]);
  return out;
}

const close = (pts: XY[]): XY[] => [...pts, [pts[0][0], pts[0][1]]];
const ringArea = (r: XY[]) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return a / 2; };

/** Fläche um d versetzen (> 0 größer, < 0 kleiner) – Außenring und Löcher */
export function offsetArea(m: MultiPolygon, d: number): MultiPolygon {
  if (Math.abs(d) < 1e-9) return m;
  const parts: MultiPolygon[] = [];
  for (const poly of m) {
    const outer = offsetPolygon(poly[0].slice(0, -1).map(([x, y]) => ({ x, y })), d, 0.01).map(l => close(l.map(p => [p.x, p.y] as XY)));
    if (!outer.length) continue;
    const polys = outer.map(r => [r] as Polygon);
    let res: MultiPolygon = polygonClipping.union(polys[0], ...polys.slice(1));
    for (const hole of poly.slice(1)) {
      const h = offsetPolygon(hole.slice(0, -1).map(([x, y]) => ({ x, y })), -d, 0.01).map(l => close(l.map(p => [p.x, p.y] as XY)));
      if (h.length) res = polygonClipping.difference(res, ...h.map(r => [r] as Polygon));
    }
    parts.push(res);
  }
  return parts.length ? polygonClipping.union(parts[0], ...parts.slice(1)) : [];
}

/**
 * Innenecken (Material-Seite > 180°) einer Kontur. `hole`: die Kontur ist ein Loch (Material liegt außen).
 * `minTurn`: nur Ecken mit mindestens diesem Knick (°) – flache Ecken eines Bogens zählen dann nicht.
 */
export function concaveCorners(ring: XY[], hole = false, minTurn = 0): { p: XY; e1: XY; e2: XY }[] {
  const pts = ring.slice(0, -1);
  const ccw = (ringArea(ring) > 0 ? 1 : -1) * (hole ? -1 : 1);
  const lim = Math.sin(minTurn * Math.PI / 180);
  const out: { p: XY; e1: XY; e2: XY }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length], p = pts[i], b = pts[(i + 1) % pts.length];
    const n1 = Math.hypot(a[0] - p[0], a[1] - p[1]), n2 = Math.hypot(b[0] - p[0], b[1] - p[1]);
    if (n1 < 1e-9 || n2 < 1e-9) continue;
    const cr = ((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0])) / (n1 * n2);
    const dot = ((p[0] - a[0]) * (b[0] - p[0]) + (p[1] - a[1]) * (b[1] - p[1])) / (n1 * n2);
    const sharp = dot < 0 || Math.abs(cr) >= lim; // Knick über 90° oder mindestens minTurn
    if (cr * ccw < -1e-9 && sharp) out.push({ p, e1: [(a[0] - p[0]) / n1, (a[1] - p[1]) / n1], e2: [(b[0] - p[0]) / n2, (b[1] - p[1]) / n2] });
  }
  return out;
}

/** Dogbones/T-Bones an allen scharfen Innenecken (Knick ≥ 30°) abziehen. T-Bone: Kreis entlang der Kante, die in X-Richtung läuft */
export function addBones(m: MultiPolygon, r: number, kind: Relief): { area: MultiPolygon; n: number } {
  if (kind === "none" || r <= 0) return { area: m, n: 0 };
  const cuts: Polygon[] = [];
  for (const poly of m) poly.forEach((ring, ri) => { for (const c of concaveCorners(ring, ri > 0, 30)) {
    let dir: XY;
    if (kind === "dogbone") { const bx = c.e1[0] + c.e2[0], by = c.e1[1] + c.e2[1], n = Math.hypot(bx, by); dir = [bx / n, by / n]; }
    else dir = Math.abs(c.e1[0]) > Math.abs(c.e2[0]) ? c.e1 : c.e2;
    cuts.push([circle(c.p[0] + dir[0] * r, c.p[1] + dir[1] * r, r)]);
  } });
  return cuts.length ? { area: polygonClipping.difference(m, ...cuts), n: cuts.length } : { area: m, n: 0 };
}

function fingers(o: JointOptions): JointResult {
  const warnings: string[] = [];
  const W = o.width, t = o.thickness;
  let n = Math.max(3, Math.round(o.count));
  if (n % 2 === 0) n++; // ungerade: außen hat Teil A Finger
  const s = W / n;
  // Teil A: Finger bei geraden Abschnitten bis x = 0, sonst bis −t
  const a: XY[] = [[-Math.max(o.lengthA, 2 * t), 0]];
  for (let i = 0; i < n; i++) { const x = i % 2 === 0 ? 0 : -t; a.push([x, i * s], [x, (i + 1) * s]); }
  a.push([-Math.max(o.lengthA, 2 * t), W]);
  // Teil B: Finger bei ungeraden Abschnitten bis x = −t (greifen flach in die Schlitze von A), sonst bis 0
  const b: XY[] = [[Math.max(o.lengthB, t), W]];
  for (let i = n - 1; i >= 0; i--) { const x = i % 2 === 1 ? -t : 0; b.push([x, (i + 1) * s], [x, i * s]); }
  b.push([Math.max(o.lengthB, t), 0]);
  const r = o.tool / 2;
  // erst Dogbones an den scharfen Ecken, dann das Spiel (sonst wird jede Ecke zu einem Bogen aus vielen Punkten)
  const ba = addBones([[close(a)]], r + 0.02, o.relief), bb = addBones([[close(b)]], r + 0.02, o.relief);
  ba.area = offsetArea(ba.area, -o.clearance / 2); bb.area = offsetArea(bb.area, -o.clearance / 2);
  if (o.tool > 0 && s - o.clearance < o.tool) warnings.push("joint.warnTool");
  if (o.tool > 0 && o.relief === "none") warnings.push("joint.warnNoRelief");
  return { a: ba.area, b: bb.area, segments: n, bones: ba.n + bb.n, warnings };
}

function dovetail(o: JointOptions): JointResult {
  const warnings: string[] = [];
  const W = o.width, D = Math.max(1, o.depth), n = Math.max(1, Math.round(o.count));
  const p = W / n, ta = Math.tan(o.angle * Math.PI / 180);
  const tip = p * 0.58, base = tip - 2 * D * ta;
  if (base < Math.max(1, o.tool)) warnings.push("joint.warnNarrow");
  const tails: Polygon[] = [];
  for (let i = 0; i < n; i++) {
    const c = (i + 0.5) * p, hb = Math.max(0.5, base / 2), ht = tip / 2;
    tails.push([[[-0.01, c - hb], [D, c - ht], [D, c + ht], [-0.01, c + hb], [-0.01, c - hb]]]);
  }
  const rectA: Polygon = [[[-o.lengthA, 0], [0, 0], [0, W], [-o.lengthA, W], [-o.lengthA, 0]]];
  const rectB: Polygon = [[[0, 0], [Math.max(o.lengthB, D + 2), 0], [Math.max(o.lengthB, D + 2), W], [0, W], [0, 0]]];
  let A = polygonClipping.union(rectA, ...tails);
  let B = polygonClipping.difference(rectB, ...tails.map(tl => [tl[0].map(([x, y]) => [Math.max(0, x), y] as XY)] as Polygon));
  // Außenecken runden (Öffnen: erst kleiner, dann wieder größer) – Radius > Fräser-Radius, dann Spiel abziehen
  const R = o.tool > 0 ? o.tool / 2 + Math.max(0.1, o.clearance) : 0;
  if (R > 0) { A = offsetArea(offsetArea(A, -R), R); B = offsetArea(offsetArea(B, -R), R); }
  A = offsetArea(A, -o.clearance / 2); B = offsetArea(B, -o.clearance / 2);
  if (B.length > 1 || A.length > 1) warnings.push("joint.warnNarrow");
  return { a: A, b: B, segments: n, bones: 0, warnings };
}

export function joint(o: JointOptions): JointResult {
  return o.kind === "finger" ? fingers(o) : dovetail(o);
}
