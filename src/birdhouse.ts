/**
 * VOGELHAUS-GENERATOR: Nistkasten aus flachen Platten zum Lasern oder Fräsen (Fenster: editor/birdhouseGen.ts)
 *
 * Platten: Vorderwand (Giebel) mit Einflugloch, Rückwand (Giebel), zwei Seitenwände, Boden, Satteldach aus zwei Teilen.
 * Wände und Boden greifen mit Fingerzinken ineinander – nach denselben Regeln wie der Box-Generator (box.ts):
 *   vorne/hinten besitzen die Eck-Würfel, Seitenwände und Boden sind dort zurückgesetzt.
 * Das Dach liegt auf den Giebeln und auf der äußeren Oberkante der Seitenwände; es wird geleimt oder genagelt.
 * Am First ist die linke Dachhälfte länger und deckt die Stirnseite der rechten ab (Schnitte bleiben rechtwinklig).
 *
 * Reinigungsklappe (door): die Front ist dann eine lose Klappe zwischen den Seitenwänden, etwas nach hinten versetzt.
 * Oben hält sie ein Stift (Nagel/Draht) durch beide Seitenwände – unten schwenkt sie auf; ein zweiter Stift unten
 * sichert sie. Die Löcher in den Seitenwänden kommen aus dem Laser, die in der Klappen-Kante bohrt man von Hand.
 *
 * Lage im Raum wie beim Box-Generator: X = Breite, Y = Tiefe (0 = vorne), Z = Höhe (0 = unten).
 * Alle Maße in mm. Nur Geometrie – keine Oberfläche (Tests: `npm test`).
 */
import { offsetPolygon } from "./polyOffset.ts";
import { profile, outline, merge, circle, flat, across, along, type Seg, type Place, type V3 } from "./box.ts";

export interface BirdhouseOptions {
  w: number; d: number; h: number; // Innenmaße: Breite, Tiefe, Höhe vom Boden bis zur Traufe (Oberkante Seitenwand)
  t: number;                       // Materialstärke
  finger: number;                  // gewünschte Fingerbreite
  kerf: number;                    // Schnittspalt
  pitch: number;                   // Dachneigung in Grad (20 … 60)
  overhang: number;                // Dachüberstand rundum (waagerecht gemessen)
  hole: number;                    // Einflugloch Ø
  perch: boolean;                  // Loch für eine Sitzstange (Rundstab Ø 8) unter dem Einflugloch
  drain: boolean;                  // Abflusslöcher im Boden
  vent: boolean;                   // Lüftungslöcher oben in den Seitenwänden
  hang: boolean;                   // Löcher zum Aufhängen im Dachüberstand vorne und hinten am First
  door: boolean;                   // Front als Reinigungsklappe auf Stiften
}

/** Übliche Einflugloch-Größen (mm) */
export const HOLE_SIZES = [26, 28, 32, 34, 45];

export type BirdPart = "front" | "back" | "left" | "right" | "bottom" | "roofL" | "roofR" | "door";
type Pt = { x: number; y: number };
export interface BirdPanel { name: BirdPart; w: number; h: number; pts: Pt[]; holes?: Pt[][]; at?: Place }

/** Warum es nicht geht: "" = alles gut */
export type BirdProblem = "" | "small" | "holeWide" | "holeLow";

export const PERCH_D = 8;          // Sitzstange (Rundstab)
const CLEAR = 0.5;                 // Luft rund um die Klappe
const HANG_D = 5;                  // Aufhänge-Löcher

/** Abgeleitete Maße: Außenbreite W, Außentiefe D, Traufhöhe Hs, Firsthöhe Zr, Versatz der Klappe s */
export function birdDims(o: BirdhouseOptions) {
  const t = Math.max(0.5, o.t);
  const a = (Math.max(15, Math.min(65, o.pitch)) * Math.PI) / 180;
  const s = o.door ? Math.max(4, t) : 0;                // Klappe sitzt so weit hinter der Vorderkante der Seitenwände
  const W = o.w + 2 * t, D = o.d + 2 * t + s, Hs = o.h + t;
  const Zr = Hs + (W / 2) * Math.tan(a);
  const ov = Math.max(0, o.overhang);
  const pinD = Math.max(1.5, Math.min(4, t * 0.6));     // Stifte der Klappe (Nagel/Draht)
  return { t, a, s, W, D, Hs, Zr, ov, pinD };
}

/** Lage des Einfluglochs (Mitte über dem Boden außen, Radius) und der Sitzstange */
export function holeSpot(o: BirdhouseOptions) {
  const { t, Hs } = birdDims(o), r = Math.max(5, o.hole / 2);
  const zc = Hs - r - Math.max(10, t + 4);             // knapp unter der Traufe – Platz für das Nest darunter
  const zp = zc - r - 12;                              // Sitzstange 12 mm unter dem Loch
  return { r, zc, zp, floor: zc - r - t };             // floor: Unterkante Loch über der Oberseite des Bodens
}

export function birdProblem(o: BirdhouseOptions): BirdProblem {
  const { t, W, Hs } = birdDims(o);
  if (!(o.t > 0) || o.w < 3 * t + 10 || o.d < 3 * t + 10 || o.h < 4 * t + 20) return "small";
  const { r, zc } = holeSpot(o);
  if (2 * r > W - 4 * t - 2 * CLEAR - 6) return "holeWide";
  if (zc - r < t + 15 || zc + r > Hs - 4) return "holeLow";
  return "";
}

const rectSeg = (L: number, out: boolean): Seg[] => [{ a: 0, b: L, out }];
const shift = (segs: Seg[], d: number): Seg[] => segs.map(g => ({ ...g, a: g.a + d, b: g.b + d }));
/** den vorderen Eck-Würfel [0, t] einer Kante einem anderen Besitzer geben (out = diese Platte reicht bis außen) */
function ownFirst(segs: Seg[], t: number, out: boolean): Seg[] {
  const rest = segs.map(g => ({ ...g, a: Math.max(g.a, t) })).filter(g => g.b - g.a > 1e-9);
  return merge([{ a: 0, b: t, out }, ...rest]);
}

/** Giebelspitze in einen Umriss einsetzen: zwischen (W, y0) und (0, y0) kommt (W/2, y0 + rise) */
function addGable(pts: Pt[], W: number, y0: number, rise: number): Pt[] {
  const i = pts.findIndex((q, k) => {
    const n = pts[(k + 1) % pts.length];
    return Math.abs(q.x - W) < 1e-9 && Math.abs(q.y - y0) < 1e-9 && Math.abs(n.x) < 1e-9 && Math.abs(n.y - y0) < 1e-9;
  });
  if (i < 0) return pts;
  return [...pts.slice(0, i + 1), { x: W / 2, y: y0 + rise }, ...pts.slice(i + 1)];
}

/** Platten ohne Schnittspalt */
function rawBird(o: BirdhouseOptions): BirdPanel[] {
  const { t, a, s, W, D, Hs, Zr, ov, pinD } = birdDims(o);
  const f = Math.max(t, o.finger);
  const P = (L: number, corner: boolean, odd: boolean, fingers = true) => profile(L, t, f, corner, odd, fingers);
  const rise = Zr - Hs, panels: BirdPanel[] = [];
  const spot = holeSpot(o);
  const entry = (cx: number): Pt[][] => {
    const hl = [circle(cx, spot.zc, spot.r)];
    if (o.perch) hl.push(circle(cx, spot.zp, PERCH_D / 2, 32));
    return hl;
  };

  // Rückwand: wie beim Box-Generator (Ecken + ungerade), oben glatt bis zur Traufe, darüber der Giebel
  const back = outline(W, Hs, t, P(W, true, true), P(Hs, true, true), rectSeg(W, true), P(Hs, true, true));
  panels.push({ name: "back", w: W, h: Zr, pts: addGable(back, W, Hs, rise), at: across(0, D - t, 0) });

  if (!o.door) {
    const front = outline(W, Hs, t, P(W, true, true), P(Hs, true, true), rectSeg(W, true), P(Hs, true, true));
    panels.push({ name: "front", w: W, h: Zr, pts: addGable(front, W, Hs, rise), holes: entry(W / 2), at: across(0, 0, 0) });
    // Seitenwände (D × Hs): Ecken frei; mit dem Boden ungerade, mit vorne/hinten gerade, oben glatt (Ecken gehören den Giebeln)
    const side = outline(D, Hs, t, P(D, false, true), P(Hs, false, false), P(D, false, true, false), P(Hs, false, false));
    panels.push({ name: "left", w: D, h: Hs, pts: side, at: along(0, 0, 0) });
    panels.push({ name: "right", w: D, h: Hs, pts: side.map(q => ({ ...q })), at: along(W - t, 0, 0) });
    panels.push({ name: "bottom", w: W, h: D, pts: outline(W, D, t, P(W, false, false), P(D, false, false), P(W, false, false), P(D, false, false)), at: flat(0, 0, 0) });
  } else {
    // Mit Klappe: vorne gibt es keine Zinken. Die Seitenwände reichen bis ganz nach vorne und besitzen dort die Ecken,
    // der Boden beginnt hinter der Klappe (bei s + t). Zinken zum Boden nur auf der Länge Db = D - s.
    const Db = D - s;
    const sideBottom = merge([{ a: 0, b: s, out: true }, ...shift(ownFirst(P(Db, false, true), t, true), s)]);
    const sideTop = merge([{ a: 0, b: D - t, out: true }, { a: D - t, b: D, out: false }]);
    const side = outline(D, Hs, t, sideBottom, P(Hs, false, false), sideTop, rectSeg(Hs, true));
    // Stift-Löcher: oben (Drehachse) und unten (Sicherung), mittig in der Dicke der Klappe
    const px = s + t / 2, pins = [circle(px, Hs - Math.max(8, 2 * pinD), pinD / 2, 24), circle(px, t + Math.max(8, 2 * pinD), pinD / 2, 24)];
    panels.push({ name: "left", w: D, h: Hs, pts: side, holes: pins, at: along(0, 0, 0) });
    panels.push({ name: "right", w: D, h: Hs, pts: side.map(q => ({ ...q })), holes: pins.map(c => c.map(q => ({ ...q }))), at: along(W - t, 0, 0) });
    panels.push({ name: "bottom", w: W, h: Db, pts: outline(W, Db, t, rectSeg(W, false), P(Db, false, false), P(W, false, false), P(Db, false, false)), at: flat(0, s, 0) });
    // Klappe: zwischen den Seitenwänden (Luft CLEAR je Seite), unten bündig, oben CLEAR unter dem Dach
    const x0 = t + CLEAR, x1 = W - t - CLEAR, dw = x1 - x0, ta = Math.tan(a), dz = CLEAR / Math.cos(a);
    const roofZ = (x: number) => Hs + Math.min(x, W - x) * ta - dz;
    const door = [{ x: 0, y: 0 }, { x: dw, y: 0 }, { x: dw, y: roofZ(x1) }, { x: W / 2 - x0, y: Zr - dz }, { x: 0, y: roofZ(x0) }];
    panels.push({ name: "door", w: dw, h: Zr - dz, pts: door, holes: entry(W / 2 - x0), at: across(x0, s, 0) });
  }

  // Dach: Innenseite liegt auf der Giebel-Schräge (durch die äußere Oberkante der Seitenwand und die Giebelspitze).
  // Rechte Hälfte beginnt s0 unter dem First, die linke ragt e darüber hinaus und deckt die rechte ab.
  const ca = Math.cos(a), sa = Math.sin(a), half = (W / 2 + ov) / ca;
  const s0 = Math.max(0, t / Math.tan(2 * a)), e = t / Math.sin(2 * a);
  const Dr = D + 2 * ov, LL = half + e, LR = half - s0;
  const roofL: Place = { o: [-ov, -ov, Hs - ov * Math.tan(a)], u: [ca, 0, sa], v: [0, 1, 0], n: [-sa, 0, ca] };
  const roofR: Place = { o: [W / 2 + s0 * ca, -ov, Zr - s0 * sa], u: [ca, 0, -sa], v: [0, 1, 0], n: [sa, 0, ca] };
  const rect = (L: number): Pt[] => [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: Dr }, { x: 0, y: Dr }];
  const L = { name: "roofL" as const, w: LL, h: Dr, pts: rect(LL), at: roofL, holes: [] as Pt[][] };
  const R = { name: "roofR" as const, w: LR, h: Dr, pts: rect(LR), at: roofR, holes: [] as Pt[][] };
  const hr = HANG_D / 2;
  if (o.hang && ov >= 2 * hr + 4) {
    // je ein Loch vorne und hinten im Überstand, nahe am First – eine Schnur durch beide Hälften
    for (const y of [ov / 2, Dr - ov / 2]) {
      L.holes.push(circle(half - hr - 4, y, hr, 24));
      R.holes.push(circle(hr + 4, y, hr, 24));
    }
  }
  panels.push(L, R);

  const get = (n: BirdPart) => panels.find(p => p.name === n)!;
  if (o.vent) for (const n of ["left", "right"] as const) {
    // zwei kleine Lüftungslöcher unter der Traufe (vom Dachüberstand geschützt)
    const p = get(n), r = 3, y = Hs - t - 8;
    if (y - r > t + 10) p.holes = [...(p.holes || []), circle(s + (D - s) / 3, y, r, 24), circle(s + (2 * (D - s)) / 3, y, r, 24)];
  }
  if (o.drain) {
    const b = get("bottom"), m = 3 * t + 6, y0 = o.door ? t : 0;
    if (b.w > 2 * m + 10 && b.h - y0 > 2 * m + 10)
      b.holes = [[m, y0 + m], [b.w - m, y0 + m], [b.w - m, b.h - m], [m, b.h - m]].map(([x, y]) => circle(x, y, 2.5, 24));
  }
  return panels;
}

/** Alle Platten; Schnittspalt: Umriss um kerf/2 nach außen, Löcher um kerf/2 nach innen */
export function birdhousePanels(o: BirdhouseOptions): BirdPanel[] {
  const panels = rawBird(o);
  if (o.kerf > 0) for (const p of panels) {
    const loops = offsetPolygon(p.pts, o.kerf / 2, 0.005);
    if (loops.length) p.pts = loops[0];
    if (p.holes) p.holes = p.holes.map(hl => offsetPolygon(hl, -o.kerf / 2, 0.005)[0]).filter(Boolean);
  }
  return panels;
}

/** Punkt (x, y) einer Platte in Tiefe s (0 … t) im Raum */
export function worldPt(at: Place, x: number, y: number, s: number): V3 {
  return [0, 1, 2].map(k => at.o[k] + at.u[k] * x + at.v[k] * y + at.n[k] * s) as V3;
}

/** Fertige Größe mit Dach (Breite X, Tiefe Y, Höhe Z) */
export function birdhouseSize(o: BirdhouseOptions): { W: number; D: number; H: number } {
  const t = Math.max(0.5, o.t), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of rawBird(o)) if (p.at) for (const q of p.pts) for (const s of [0, t]) {
    const v = worldPt(p.at, q.x, q.y, s);
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
  }
  return { W: hi[0] - lo[0], D: hi[1] - lo[1], H: hi[2] - lo[2] };
}
