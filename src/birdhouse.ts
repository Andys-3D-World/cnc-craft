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
 * Anhänger (kind = "ornament"): kleines Vogelhaus zum Aufhängen (Weihnachtsbaum, Fenster). Ohne Boden stecken die Wände
 * mit Zapfen in einer Grundplatte (rechteckig, abgerundet, oval oder mit Wellenrand). Statt der überlappenden Dachhälften
 * steht auf dem First eine Platte mit Öse (Ring, Bogen oder Spitze); sie steckt in Schlitzen der Giebel und die beiden
 * gleich langen Dachhälften lehnen links und rechts daran. Einflugloch als Kreis, Rundbogen, Herz oder Quadrat,
 * auf Wunsch mit aufgeklebtem Zierrahmen.
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
  kind?: BirdKind;                 // Nistkasten (Standard) oder Anhänger
  hanger?: Hanger;                 // Anhänger: Öse auf dem First
  entrance?: Entrance;             // Anhänger: Form des Einfluglochs
  frame?: boolean;                 // Anhänger: Zierrahmen um das Einflugloch
  base?: BaseShape;                // Anhänger: Grundplatte (none = Boden mit Fingerzinken wie beim Nistkasten)
  baseMargin?: number;             // Anhänger: so weit steht die Grundplatte rundum über
}

export type BirdKind = "nest" | "ornament";
export type Hanger = "ring" | "arch" | "point" | "none";
export type Entrance = "circle" | "arch" | "heart" | "square" | "none";
export type BaseShape = "rect" | "round" | "oval" | "wave" | "none";
export const HANGERS: Hanger[] = ["ring", "arch", "point", "none"];
export const ENTRANCES: Entrance[] = ["circle", "arch", "heart", "square", "none"];
export const BASES: BaseShape[] = ["rect", "round", "oval", "wave", "none"];

/** Übliche Einflugloch-Größen (mm) */
export const HOLE_SIZES = [26, 28, 32, 34, 45];

export type BirdPart = "front" | "back" | "left" | "right" | "bottom" | "roofL" | "roofR" | "door" | "hanger" | "frame" | "base";
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
  if (o.kind === "ornament") return ornProblem(o);
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
  if (o.kind === "ornament") return ornamentPanels(o);
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

// ───────────────────────────── Anhänger (Mini-Vogelhaus) ─────────────────────────────

const ORN_PERCH_D = 3;             // Sitzstange: Zahnstocher / Rundstab Ø 3
const ornOpts = (o: BirdhouseOptions) => ({
  hanger: HANGERS.includes(o.hanger!) ? o.hanger! : "ring", entrance: ENTRANCES.includes(o.entrance!) ? o.entrance! : "circle",
  base: BASES.includes(o.base!) ? o.base! : "rect", m: Math.max(0, o.baseMargin ?? 5), frame: !!o.frame && o.entrance !== "none"
});
/** Breite des Zierrahmens */
const frameW = (t: number) => Math.max(2, 0.8 * t);

/** Form des Einfluglochs um die Mitte (cx, cz) mit halber Breite r; Höhe der Form */
function entranceShape(e: Entrance, cx: number, cz: number, r: number): Pt[] {
  if (e === "square") return [{ x: cx - r, y: cz - r }, { x: cx + r, y: cz - r }, { x: cx + r, y: cz + r }, { x: cx - r, y: cz + r }];
  if (e === "arch") {
    // Rundbogen: unten gerade, oben Halbkreis; Höhe 2,4 r
    const h = 2.4 * r, y0 = cz - h / 2, pts: Pt[] = [{ x: cx - r, y: y0 }, { x: cx + r, y: y0 }];
    for (let i = 0; i <= 24; i++) { const a = (Math.PI * i) / 24; pts.push({ x: cx + r * Math.cos(a), y: y0 + h - r + r * Math.sin(a) }); }
    return pts.filter((q, i) => i < 2 || Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y) > 1e-9);
  }
  if (e === "heart") {
    // Herzkurve (Breite 32, Höhe ≈ 29 Einheiten) auf die Breite 2 r skaliert und um die Mitte gelegt
    const k = r / 16, pts: Pt[] = [];
    for (let i = 0; i < 72; i++) {
      const u = (2 * Math.PI * i) / 72, x = 16 * Math.sin(u) ** 3;
      const y = 13 * Math.cos(u) - 5 * Math.cos(2 * u) - 2 * Math.cos(3 * u) - Math.cos(4 * u);
      pts.push({ x: cx + k * x, y: cz + k * (y + 2.4) });
    }
    return pts.reverse();
  }
  return circle(cx, cz, r);
}
const entranceH = (e: Entrance, r: number) => (e === "arch" ? 2.4 * r : e === "heart" ? 1.82 * r : 2 * r);

/** Lage des Einfluglochs beim Anhänger: Mitte zc, Höhe eh, Rand (mit Rahmen) und Sitzstange zp */
function ornSpot(o: BirdhouseOptions) {
  const { t, Hs } = birdDims(o), { entrance, frame } = ornOpts(o);
  const r = Math.max(1.5, o.hole / 2), eh = entranceH(entrance, r), fw = frame ? frameW(t) : 0;
  const gap = Math.max(1.5, t / 2);
  const zc = Math.min(Hs * 0.55, Hs - gap - fw - eh / 2);
  const zp = zc - eh / 2 - fw - ORN_PERCH_D / 2 - 1.5;
  return { r, eh, fw, zc, zp, floor: zc - eh / 2 - fw };
}

function ornProblem(o: BirdhouseOptions): BirdProblem {
  const { t, W } = birdDims(o), { entrance } = ornOpts(o);
  if (!(o.t > 0) || o.w < 3 * t + 6 || o.d < 3 * t + 6 || o.h < 3 * t + 6) return "small";
  if (entrance === "none") return "";
  const { r, fw, zc, eh } = ornSpot(o);
  if (2 * (r + fw) > W - 2 * t - 2) return "holeWide";
  if (zc - eh / 2 - fw < Math.max(1.5, t / 2)) return "holeLow";
  return "";
}

/** Abgerundetes Rechteck als Punktfolge mit Außen-Normale, etwa alle `step` mm ein Punkt (gegen den Uhrzeigersinn) */
function roundedPath(x0: number, y0: number, x1: number, y1: number, rad: number, step: number) {
  rad = Math.max(0, Math.min(rad, (x1 - x0) / 2, (y1 - y0) / 2));
  const out: { x: number; y: number; nx: number; ny: number }[] = [];
  const line = (ax: number, ay: number, bx: number, by: number, nx: number, ny: number) => {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let i = 0; i < n; i++) out.push({ x: ax + ((bx - ax) * i) / n, y: ay + ((by - ay) * i) / n, nx, ny });
  };
  const arc = (cx: number, cy: number, a0: number) => {
    if (rad < 1e-9) return;
    const n = Math.max(2, Math.ceil(((Math.PI / 2) * rad) / step));
    for (let i = 0; i < n; i++) { const a = a0 + ((Math.PI / 2) * i) / n; out.push({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) }); }
  };
  line(x0 + rad, y0, x1 - rad, y0, 0, -1); arc(x1 - rad, y0 + rad, -Math.PI / 2);
  line(x1, y0 + rad, x1, y1 - rad, 1, 0); arc(x1 - rad, y1 - rad, 0);
  line(x1 - rad, y1, x0 + rad, y1, 0, 1); arc(x0 + rad, y1 - rad, Math.PI / 2);
  line(x0, y1 - rad, x0, y0 + rad, -1, 0); arc(x0 + rad, y0 + rad, Math.PI);
  return out;
}

/** Grundplatte um die Grundfläche W × D (Welt-Koordinaten der Kante: x0, y0 … x0 + bw, y0 + bd) */
function basePlate(shape: BaseShape, W: number, D: number, m: number): { x0: number; y0: number; pts: Pt[] } {
  if (shape === "oval") {
    // Ellipse durch die Ecken der Grundfläche plus Überstand
    const A = (W / 2 + m) * Math.SQRT2, B = (D / 2 + m) * Math.SQRT2;
    const pts = Array.from({ length: 96 }, (_, i) => { const u = (2 * Math.PI * i) / 96; return { x: A + A * Math.cos(u), y: B + B * Math.sin(u) }; });
    return { x0: W / 2 - A, y0: D / 2 - B, pts };
  }
  if (shape === "wave") {
    // Wellenrand: Bögen nach außen auf einem abgerundeten Rechteck (Überstand m = Fuß der Wellen)
    const amp = Math.max(1.5, m * 0.6), bw = W + 2 * m, bd = D + 2 * m;
    const path = roundedPath(amp, amp, amp + bw, amp + bd, Math.max(amp, Math.min(bw, bd) / 5), 0.4);
    const n = path.length, waves = Math.max(8, Math.round((2 * (bw + bd)) / Math.max(6, 4 * amp)));
    const pts = path.map((q, i) => { const k = amp * Math.abs(Math.sin((Math.PI * waves * i) / n)); return { x: q.x + q.nx * k, y: q.y + q.ny * k }; });
    return { x0: -m - amp, y0: -m - amp, pts };
  }
  const bw = W + 2 * m, bd = D + 2 * m, rad = shape === "round" ? Math.min(bw, bd) / 4 : 0;
  const pts = shape === "round" ? roundedPath(0, 0, bw, bd, rad, 0.8).map(q => ({ x: q.x, y: q.y }))
    : [{ x: 0, y: 0 }, { x: bw, y: 0 }, { x: bw, y: bd }, { x: 0, y: bd }];
  return { x0: -m, y0: -m, pts };
}

/** Giebel einsetzen: zwischen (W, y0) und (0, y0) kommen die Punkte `mid` (von rechts nach links) */
function insertTop(pts: Pt[], W: number, y0: number, mid: Pt[]): Pt[] {
  const i = pts.findIndex((q, k) => {
    const n = pts[(k + 1) % pts.length];
    return Math.abs(q.x - W) < 1e-9 && Math.abs(q.y - y0) < 1e-9 && Math.abs(n.x) < 1e-9 && Math.abs(n.y - y0) < 1e-9;
  });
  return i < 0 ? pts : [...pts.slice(0, i + 1), ...mid, ...pts.slice(i + 1)];
}

function ornamentPanels(o: BirdhouseOptions): BirdPanel[] {
  const { t, a, W, D, Hs, Zr, ov } = birdDims({ ...o, door: false });
  const { hanger, entrance, base, m, frame } = ornOpts(o);
  const f = Math.max(t, o.finger), P = (L: number, corner: boolean, odd: boolean, fingers = true) => profile(L, t, f, corner, odd, fingers);
  const ta = Math.tan(a), ca = Math.cos(a), sa = Math.sin(a), panels: BirdPanel[] = [];
  const tabbed = base !== "none";
  // mit Grundplatte: unter jeder Wand ein Streifen (t hoch) mit Zapfen; die Platte liegt dann bei z = -t … 0
  const z0 = tabbed ? t : 0, H = Hs + z0;
  const bottomEdge = (L: number, corner: boolean, odd: boolean) => (tabbed ? P(L, false, true) : P(L, corner, odd));

  // Firstplatte mit Öse: steckt in einem Schlitz (Breite t) oben in beiden Giebeln
  const zr0 = Zr - (t / 2) * ta;                          // Dach-Innenseite an der Firstplatte
  const k = Math.max(0.5, Math.min(3 * t, 0.6 * (zr0 - Hs)));
  const zb = zr0 - k;
  const gableTop = (): Pt[] => hanger === "none" ? [{ x: W / 2, y: Zr + z0 }]
    : [{ x: W / 2 + t / 2, y: zr0 + z0 }, { x: W / 2 + t / 2, y: zb + z0 }, { x: W / 2 - t / 2, y: zb + z0 }, { x: W / 2 - t / 2, y: zr0 + z0 }];

  const spot = ornSpot(o), holes: Pt[][] = [];
  if (entrance !== "none") {
    holes.push(entranceShape(entrance, W / 2, spot.zc + z0, spot.r));
    if (o.perch && spot.zp - ORN_PERCH_D / 2 > 1) holes.push(circle(W / 2, spot.zp + z0, ORN_PERCH_D / 2, 24));
  }
  const fb = (name: "front" | "back", y: number, hl?: Pt[][]) => {
    const pts = outline(W, H, t, bottomEdge(W, true, true), P(H, true, true), rectSeg(W, true), P(H, true, true));
    panels.push({ name, w: W, h: Zr + z0, pts: insertTop(pts, W, H, gableTop()), holes: hl, at: across(0, y, -z0) });
  };
  fb("front", 0, holes); fb("back", D - t);
  const side = outline(D, H, t, bottomEdge(D, false, true), P(H, false, false), P(D, false, true, false), P(H, false, false));
  panels.push({ name: "left", w: D, h: H, pts: side, at: along(0, 0, -z0) });
  panels.push({ name: "right", w: D, h: H, pts: side.map(q => ({ ...q })), at: along(W - t, 0, -z0) });

  if (tabbed) {
    // Grundplatte mit Schlitzen genau unter den Zapfen der Wände
    const bp = basePlate(base, W, D, m), slots: Pt[][] = [];
    const sl = (x0: number, y0: number, x1: number, y1: number) => slots.push([{ x: x0 - bp.x0, y: y0 - bp.y0 }, { x: x1 - bp.x0, y: y0 - bp.y0 }, { x: x1 - bp.x0, y: y1 - bp.y0 }, { x: x0 - bp.x0, y: y1 - bp.y0 }]);
    for (const g of P(W, false, true).filter(g => g.out)) { sl(g.a, 0, g.b, t); sl(g.a, D - t, g.b, D); }
    for (const g of P(D, false, true).filter(g => g.out)) { sl(0, g.a, t, g.b); sl(W - t, g.a, W, g.b); }
    const xs = bp.pts.map(q => q.x), ys = bp.pts.map(q => q.y);
    panels.push({ name: "base", w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), pts: bp.pts, holes: slots, at: flat(bp.x0, bp.y0, -t) });
  } else {
    panels.push({ name: "bottom", w: W, h: D, pts: outline(W, D, t, P(W, false, false), P(D, false, false), P(W, false, false), P(D, false, false)), at: flat(0, 0, 0) });
  }

  if (frame && entrance !== "none") {
    // Zierrahmen: Einflug-Form um die Rahmenbreite vergrößert, außen auf die Front geklebt
    const inner = entranceShape(entrance, W / 2, spot.zc, spot.r), outer = offsetPolygon(inner, spot.fw, 0.005)[0];
    if (outer) {
      const bx = Math.min(...outer.map(q => q.x)), bz = Math.min(...outer.map(q => q.y));
      const mv = (pts: Pt[]) => pts.map(q => ({ x: q.x - bx, y: q.y - bz }));
      panels.push({ name: "frame", w: Math.max(...outer.map(q => q.x)) - bx, h: Math.max(...outer.map(q => q.y)) - bz, pts: mv(outer), holes: [mv(inner)], at: across(bx, -t, bz) });
    }
  }

  const Dr = D + 2 * ov, rect = (L: number): Pt[] => [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: Dr }, { x: 0, y: Dr }];
  if (hanger === "none") {
    // Dach wie beim Nistkasten: links länger, deckt die rechte Hälfte ab
    const half = (W / 2 + ov) / ca, s0 = Math.max(0, t / Math.tan(2 * a)), e = t / Math.sin(2 * a);
    panels.push({ name: "roofL", w: half + e, h: Dr, pts: rect(half + e), at: { o: [-ov, -ov, Hs - ov * ta], u: [ca, 0, sa], v: [0, 1, 0], n: [-sa, 0, ca] } });
    panels.push({ name: "roofR", w: half - s0, h: Dr, pts: rect(half - s0), at: { o: [W / 2 + s0 * ca, -ov, Zr - s0 * sa], u: [ca, 0, -sa], v: [0, 1, 0], n: [sa, 0, ca] } });
    return panels;
  }
  // zwei gleiche Dachhälften, die Innenkante oben stößt an die Firstplatte
  const LH = (W / 2 - t / 2 + ov) / ca;
  panels.push({ name: "roofL", w: LH, h: Dr, pts: rect(LH), at: { o: [-ov, -ov, Hs - ov * ta], u: [ca, 0, sa], v: [0, 1, 0], n: [-sa, 0, ca] } });
  panels.push({ name: "roofR", w: LH, h: Dr, pts: rect(LH), at: { o: [W / 2 + t / 2, -ov, zr0], u: [ca, 0, -sa], v: [0, 1, 0], n: [sa, 0, ca] } });

  // Firstplatte (x = Tiefe ab dem vorderen Dachrand, y = Höhe z): unten bis zr0, zwischen den Giebeln bis zb;
  // oben ein schmaler Kamm über dem Dach und in der Mitte die Öse
  const Lp = Dr, zt = zr0 + t * ca + Math.max(0.8, 0.4 * t), w = Math.max(1.5, 0.7 * t), mid = Lp / 2;
  const pts: Pt[] = [{ x: 0, y: zr0 }, { x: ov, y: zr0 }, { x: ov, y: zb }, { x: ov + D, y: zb }, { x: ov + D, y: zr0 }, { x: Lp, y: zr0 }, { x: Lp, y: zt }];
  let hole: Pt[];
  if (hanger === "ring") {
    const Rh = Math.max(1.5, Math.min(5, Lp * 0.09)), Rr = Rh + w, cz = zt + Rh + 0.5, hw = Math.sqrt(Rr * Rr - (cz - zt) ** 2);
    const a0 = Math.atan2(zt - cz, hw);
    pts.push({ x: mid + hw, y: zt });
    for (let i = 1; i < 40; i++) { const u = a0 + ((Math.PI - 2 * a0) * i) / 40; pts.push({ x: mid + Rr * Math.cos(u), y: cz + Rr * Math.sin(u) }); }
    pts.push({ x: mid - hw, y: zt });
    hole = circle(mid, cz, Rh, 32);
  } else if (hanger === "arch") {
    const Rh = Math.max(1.5, Math.min(4, Lp * 0.07)), hh = 2 * Rh + 2 * w + 1;
    for (let i = 1; i < 48; i++) { const u = (Math.PI * i) / 48; pts.push({ x: mid + mid * Math.cos(u), y: zt + hh * Math.sin(u) }); }
    hole = circle(mid, zt + hh - w - Rh, Rh, 32);
  } else {
    const Rh = Math.max(1.5, Math.min(4, Lp * 0.07)), hh = Math.max(Lp * 0.35, 3.2 * (Rh + w));
    pts.push({ x: mid, y: zt + hh });
    hole = circle(mid, zt + Math.max(Rh + 0.5, hh * 0.32), Rh, 32);
  }
  pts.push({ x: 0, y: zt });
  const top = Math.max(...pts.map(q => q.y));
  panels.push({ name: "hanger", w: Lp, h: top - zb, pts: pts.map(q => ({ x: q.x, y: q.y - zb })), holes: [hole.map(q => ({ x: q.x, y: q.y - zb }))],
    at: { o: [W / 2 + t / 2, -ov, zb], u: [0, 1, 0], v: [0, 0, 1], n: [-1, 0, 0] } });
  return panels;
}

/** Lage des Einfluglochs für die Anzeige (Unterkante über dem Boden innen), für beide Arten */
export function holeFloor(o: BirdhouseOptions): number {
  return o.kind === "ornament" ? ornSpot(o).floor : holeSpot(o).floor;
}
