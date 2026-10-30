/**
 * VOGELHAUS-GENERATOR: Nistkasten aus flachen Platten zum Lasern oder Fräsen (Fenster: editor/birdhouseGen.ts)
 *
 * Platten: Vorderwand (Giebel) mit Einflugloch, Rückwand (Giebel), zwei Seitenwände, Boden, Satteldach aus zwei Teilen.
 * Wände und Boden greifen mit Fingerzinken ineinander – nach denselben Regeln wie der Box-Generator (box.ts):
 *   vorne/hinten besitzen die Eck-Würfel, Seitenwände und Boden sind dort zurückgesetzt.
 * Das Dach liegt auf den Giebeln und auf der äußeren Oberkante der Seitenwände. Steckdach (roofTabs): auf den
 * Giebelschrägen stehen Zapfen, die durch Schlitze in den Dachhälften greifen – dann hält das Dach ohne Leim.
 * Am First ist die linke Dachhälfte länger und deckt die Stirnseite der rechten ab (Schnitte bleiben rechtwinklig).
 * Die Traufkante (unten am Dach) kann verziert sein: Bögen, Zacken, Zähne, Wellen, Blätter, Bögen mit Löchern.
 *
 * Reinigungsklappe (door): die Front ist dann eine lose Klappe zwischen den Seitenwänden, etwas nach hinten versetzt.
 * Oben hält sie ein Stift (Nagel/Draht) durch beide Seitenwände – unten schwenkt sie auf; ein zweiter Stift unten
 * sichert sie. Die Löcher in den Seitenwänden kommen aus dem Laser, die in der Klappen-Kante bohrt man von Hand.
 *
 * Anhänger (kind = "ornament"): kleines Vogelhaus zum Aufhängen (Weihnachtsbaum, Fenster). Ohne Boden stecken die Wände
 * mit Zapfen in einer Grundplatte (viele Formen). Statt der überlappenden Dachhälften steht auf dem First eine Platte
 * mit Aufhänger (Ring, Herz, Stern, Krone …); sie steckt in Schlitzen der Giebel und die beiden gleich langen
 * Dachhälften lehnen links und rechts daran. Einflugloch in vielen Formen, auf Wunsch mit aufgeklebtem Zierrahmen.
 * Alle Formen sind selbst gezeichnet (keine fremden Vorlagen).
 *
 * Lage im Raum wie beim Box-Generator: X = Breite, Y = Tiefe (0 = vorne), Z = Höhe (0 = unten).
 * Alle Maße in mm. Nur Geometrie – keine Oberfläche (Tests: `npm test`).
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import { offsetPolygon } from "./polyOffset.ts";
import { profile, outline, merge, circle, flat, across, along, type Seg, type Place, type V3 } from "./box.ts";

export interface BirdhouseOptions {
  w: number; d: number; h: number; // Innenmaße: Breite, Tiefe, Höhe vom Boden bis zur Traufe (Oberkante Seitenwand)
  t: number;                       // Materialstärke
  finger: number;                  // gewünschte Fingerbreite
  kerf: number;                    // Schnittspalt
  pitch: number;                   // Dachneigung in Grad (20 … 60)
  overhang: number;                // Dachüberstand rundum (waagerecht gemessen)
  hole: number;                    // Einflugloch Ø (Anhänger: Breite der Form)
  perch: boolean;                  // Loch für eine Sitzstange unter dem Einflugloch
  drain: boolean;                  // Abflusslöcher im Boden
  vent: boolean;                   // Lüftungslöcher oben in den Seitenwänden
  hang: boolean;                   // Löcher zum Aufhängen im Dachüberstand vorne und hinten am First
  door: boolean;                   // Front als Reinigungsklappe auf Stiften
  roofTabs?: boolean;              // Steckdach: Zapfen auf den Giebelschrägen, Schlitze im Dach
  roofEdge?: RoofEdge;             // Verzierung der Traufkante
  edgeCount?: number;              // so oft wiederholt sich das Muster an der Traufe (0 = automatisch)
  kind?: BirdKind;                 // Nistkasten (Standard) oder Anhänger
  hanger?: Hanger;                 // Anhänger: Aufhänger auf dem First
  entrance?: Entrance;             // Anhänger: Form des Einfluglochs
  frame?: boolean;                 // Anhänger: Zierrahmen um das Einflugloch
  base?: BaseShape;                // Anhänger: Grundplatte (none = Boden mit Fingerzinken wie beim Nistkasten)
  baseMargin?: number;             // Anhänger: so weit steht die Grundplatte rundum über
}

export type BirdKind = "nest" | "ornament";
export type Hanger = "ring" | "arch" | "point" | "heart" | "star" | "crown" | "wings" | "tree" | "none";
export type Entrance = "circle" | "arch" | "heart" | "square" | "triangle" | "pentagon" | "star" | "diamond" | "flower" | "leaf" | "tree" | "clover" | "none";
export type BaseShape = "rect" | "round" | "oval" | "wave" | "circle" | "flower" | "rosette" | "notched" | "concave" | "none";
export type RoofEdge = "plain" | "scallops" | "points" | "teeth" | "waves" | "petals" | "holes";
export const HANGERS: Hanger[] = ["ring", "arch", "point", "heart", "star", "crown", "wings", "tree", "none"];
export const ENTRANCES: Entrance[] = ["circle", "arch", "heart", "square", "triangle", "pentagon", "star", "diamond", "flower", "leaf", "tree", "clover", "none"];
export const BASES: BaseShape[] = ["rect", "round", "oval", "wave", "circle", "flower", "rosette", "notched", "concave", "none"];
export const ROOF_EDGES: RoofEdge[] = ["plain", "scallops", "points", "teeth", "waves", "petals", "holes"];

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
  const s = o.door && o.kind !== "ornament" ? Math.max(4, t) : 0; // Klappe sitzt so weit hinter der Vorderkante der Seitenwände
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

/** Giebel einsetzen: zwischen (W, y0) und (0, y0) kommen die Punkte `mid` (von rechts nach links) */
function insertTop(pts: Pt[], W: number, y0: number, mid: Pt[]): Pt[] {
  const i = pts.findIndex((q, k) => {
    const n = pts[(k + 1) % pts.length];
    return Math.abs(q.x - W) < 1e-9 && Math.abs(q.y - y0) < 1e-9 && Math.abs(n.x) < 1e-9 && Math.abs(n.y - y0) < 1e-9;
  });
  return i < 0 ? pts : [...pts.slice(0, i + 1), ...mid, ...pts.slice(i + 1)];
}

// ───────────────────────────── Dach (für beide Arten) ─────────────────────────────

/**
 * Zapfen auf den Giebelschrägen: Abschnitte [s1, s2] entlang der Schräge, gemessen ab der Traufecke des Giebels,
 * bis sEnd (dort endet die kürzere Dachhälfte). Ungerade Teilung wie bei den Fingerzinken, jeder zweite Abschnitt
 * ist ein Zapfen (so hoch wie das Dach dick ist), höchstens drei je Schräge.
 */
function slopeTabs(o: BirdhouseOptions, sEnd: number): [number, number][] {
  const { t, ov } = birdDims(o);
  if (!o.roofTabs || ov < Math.max(2, 0.7 * t)) return [];       // ohne Überstand läge der Schlitz am Dachrand
  const s0 = Math.max(1.5, 0.5 * t), s1 = sEnd - Math.max(1.5, 0.5 * t), L = s1 - s0;
  if (L < 3 * t) return [];
  const k = Math.min(7, Math.max(3, 2 * Math.floor(L / Math.max(t, o.finger) / 2) + 1));
  const g = L / k, out: [number, number][] = [];
  for (let i = 1; i < k; i += 2) out.push([s0 + i * g, s0 + (i + 1) * g]);
  return out;
}

/**
 * Oberkante eines Giebels von rechts unten (W, y0) bis links unten (0, y0): Schrägen mit Zapfen, oben `top`
 * (Spitze oder Schlitz für die Firstplatte). Rückgabe ohne die beiden Traufecken.
 */
function gableTop(W: number, y0: number, a: number, t: number, top: Pt[], tabs: [number, number][]): Pt[] {
  const ca = Math.cos(a), sa = Math.sin(a), out: Pt[] = [];
  const R = (s: number, d = 0) => ({ x: W - s * ca + d * sa, y: y0 + s * sa + d * ca });   // rechte Schräge, d nach außen
  const L = (s: number, d = 0) => ({ x: s * ca - d * sa, y: y0 + s * sa + d * ca });       // linke Schräge
  for (const [s1, s2] of tabs) out.push(R(s1), R(s1, t), R(s2, t), R(s2));
  out.push(...top);
  for (const [s1, s2] of [...tabs].reverse()) out.push(L(s2), L(s2, t), L(s1, t), L(s1));
  return out;
}

/**
 * Verzierte Traufkante der Länge len: Weg entlang der Kante (x ≤ 0 = nach außen), Tiefe und Löcher.
 * Das Muster wiederholt sich n mal (count, sonst passend zur Materialstärke).
 */
function eaveEdge(style: RoofEdge, len: number, t: number, count: number) {
  if (style === "plain" || len < 6) return { depth: 0, path: [] as Pt[], holes: [] as Pt[][] };
  const n = count > 0 ? Math.max(1, Math.round(count)) : Math.max(3, Math.round(len / Math.max(4, Math.min(14, 2.2 * t + 2))));
  const p = len / n;
  const A = style === "scallops" || style === "holes" ? p / 2 : style === "points" || style === "petals" ? p * 0.6 : style === "teeth" ? p * 0.45 : p * 0.35;
  const dep = (y: number) => {
    const u = Math.min(1, Math.max(0, (y % p) / p)), yl = u * p;
    switch (style) {
      case "scallops": case "holes": return Math.sqrt(Math.max(0, (p / 2) ** 2 - (yl - p / 2) ** 2));
      case "points": return A * (1 - Math.abs(2 * u - 1));
      case "teeth": return A * Math.min(1, Math.max(0, (0.5 - Math.abs(u - 0.5)) / 0.2));
      case "waves": return A * (0.5 - 0.5 * Math.cos(2 * Math.PI * u));
      default: return A * Math.sin(Math.PI * u) ** 0.6;   // Blätter
    }
  };
  const steps = style === "points" ? 2 : style === "teeth" ? 10 : 24, path: Pt[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < steps; j++) { const y = (i + j / steps) * p; path.push({ x: -dep(y), y }); }
  path.push({ x: 0, y: len });
  const clean = path.filter((q, i) => i === 0 || Math.hypot(q.x - path[i - 1].x, q.y - path[i - 1].y) > 1e-9);
  const holes = style === "holes" && A > 2 ? Array.from({ length: n }, (_, i) => circle(-A * 0.45, (i + 0.5) * p, A * 0.3, 20)) : [];
  return { depth: A, path: clean, holes };
}

/**
 * Beide Dachhälften. withPlate: Anhänger mit Firstplatte (gleich lange Hälften, stoßen an die Platte);
 * sonst deckt die linke Hälfte am First die rechte ab. Schlitze für die Giebel-Zapfen (vorne und hinten),
 * Verzierung an der Traufe (die Platten werden um deren Tiefe länger).
 */
function buildRoof(o: BirdhouseOptions, withPlate: boolean) {
  const { t, a, W, D, Hs, Zr, ov } = birdDims(o);
  const ca = Math.cos(a), sa = Math.sin(a), ta = Math.tan(a), Dr = D + 2 * ov;
  // Länge der linken (LL) und rechten (LR) Hälfte; sR = Lage des Firstendes der rechten Hälfte (Schräge ab Traufecke)
  let LL: number, LR: number, sR: number, oR: V3;
  if (withPlate) {
    LL = LR = (W / 2 - t / 2 + ov) / ca; sR = (W / 2 - t / 2) / ca;
    oR = [W / 2 + t / 2, -ov, Zr - (t / 2) * ta];
  } else {
    const s0 = Math.max(0, t / Math.tan(2 * a)), e = t / Math.sin(2 * a);
    LL = (W / 2 + ov) / ca + e; LR = (W / 2 + ov) / ca - s0; sR = (W / 2) / ca - s0;
    oR = [W / 2 + s0 * ca, -ov, Zr - s0 * sa];
  }
  const tabs = slopeTabs(o, sR);
  const edge = eaveEdge(ROOF_EDGES.includes(o.roofEdge!) ? o.roofEdge! : "plain", Dr, t, o.edgeCount ?? 0);
  const dd = edge.depth, sOff = ov / ca;          // Traufecke des Giebels liegt auf der linken Platte bei x = dd + sOff
  const slots = (x: (s: number) => number): Pt[][] => tabs.flatMap(([s1, s2]) => [ov, ov + D - t].map(y0 => {
    const xa = Math.min(x(s1), x(s2)), xb = Math.max(x(s1), x(s2));
    return [{ x: xa, y: y0 }, { x: xb, y: y0 }, { x: xb, y: y0 + t }, { x: xa, y: y0 + t }];
  }));
  // links: Traufe bei x = dd (davor die Verzierung), First bei x = LL + dd
  const Lpts: Pt[] = dd > 0
    ? [{ x: dd, y: 0 }, { x: LL + dd, y: 0 }, { x: LL + dd, y: Dr }, ...[...edge.path].reverse().map(q => ({ x: dd + q.x, y: q.y })).slice(0, -1)]
    : [{ x: 0, y: 0 }, { x: LL, y: 0 }, { x: LL, y: Dr }, { x: 0, y: Dr }];
  const L: BirdPanel = { name: "roofL", w: LL + dd, h: Dr, pts: Lpts,
    holes: [...slots(s => dd + sOff + s), ...edge.holes.map(h => h.map(q => ({ x: dd + q.x, y: q.y })))],
    at: { o: [-ov - dd * ca, -ov, Hs - ov * ta - dd * sa], u: [ca, 0, sa], v: [0, 1, 0], n: [-sa, 0, ca] } };
  // rechts: First bei x = 0, Traufe bei x = LR (dahinter die Verzierung)
  const Rpts: Pt[] = dd > 0
    ? [{ x: 0, y: 0 }, ...edge.path.map(q => ({ x: LR - q.x, y: q.y })), { x: 0, y: Dr }]
    : [{ x: 0, y: 0 }, { x: LR, y: 0 }, { x: LR, y: Dr }, { x: 0, y: Dr }];
  const R: BirdPanel = { name: "roofR", w: LR + dd, h: Dr, pts: Rpts,
    holes: [...slots(s => sR - s), ...edge.holes.map(h => h.map(q => ({ x: LR - q.x, y: q.y })))],
    at: { o: oR, u: [ca, 0, -sa], v: [0, 1, 0], n: [sa, 0, ca] } };
  return { L, R, tabs, dd, Dr };
}

/** Platten ohne Schnittspalt */
function rawBird(o: BirdhouseOptions): BirdPanel[] {
  if (o.kind === "ornament") return ornamentPanels(o);
  const { t, a, s, W, D, Hs, Zr, ov, pinD } = birdDims(o);
  const f = Math.max(t, o.finger);
  const P = (L: number, corner: boolean, odd: boolean, fingers = true) => profile(L, t, f, corner, odd, fingers);
  const panels: BirdPanel[] = [];
  const spot = holeSpot(o);
  const entry = (cx: number): Pt[][] => {
    const hl = [circle(cx, spot.zc, spot.r)];
    if (o.perch) hl.push(circle(cx, spot.zp, PERCH_D / 2, 32));
    return hl;
  };
  const roof = buildRoof(o, false);
  const top = () => gableTop(W, Hs, a, t, [{ x: W / 2, y: Zr }], roof.tabs);

  // Rückwand: wie beim Box-Generator (Ecken + ungerade), oben glatt bis zur Traufe, darüber der Giebel
  const back = outline(W, Hs, t, P(W, true, true), P(Hs, true, true), rectSeg(W, true), P(Hs, true, true));
  panels.push({ name: "back", w: W, h: Zr, pts: insertTop(back, W, Hs, top()), at: across(0, D - t, 0) });

  if (!o.door) {
    const front = outline(W, Hs, t, P(W, true, true), P(Hs, true, true), rectSeg(W, true), P(Hs, true, true));
    panels.push({ name: "front", w: W, h: Zr, pts: insertTop(front, W, Hs, top()), holes: entry(W / 2), at: across(0, 0, 0) });
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
    // die Klappe hat keine Zapfen – vorne bräuchte das Dach keine Schlitze, nur hinten
    const front = (h: Pt[]) => h.length === 4 && Math.abs(h[0].y - ov) < 1e-9;
    roof.L.holes = roof.L.holes!.filter(h => !front(h));
    roof.R.holes = roof.R.holes!.filter(h => !front(h));
  }

  // Aufhänge-Löcher: je eins vorne und hinten im Überstand, nahe am First – eine Schnur durch beide Hälften
  const hr = HANG_D / 2;
  if (o.hang && ov >= 2 * hr + 4) for (const y of [ov / 2, roof.Dr - ov / 2]) {
    roof.L.holes!.push(circle(roof.dd + (W / 2 + ov) / Math.cos(a) - hr - 4, y, hr, 24));
    roof.R.holes!.push(circle(hr + 4, y, hr, 24));
  }
  panels.push(roof.L, roof.R);

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
  // Zapfen, Verzierungen und der Schnittspalt können über x = 0 / y = 0 hinausragen: Platte so verschieben, dass sie bei 0 beginnt
  // (die Lage im Raum wird mitverschoben), Breite und Höhe aus dem echten Umriss
  for (const p of panels) {
    const mx = Math.min(...p.pts.map(q => q.x)), my = Math.min(...p.pts.map(q => q.y));
    if (mx < 0 || my < 0) {
      const dx = Math.min(0, mx), dy = Math.min(0, my), mv = (r: Pt[]) => r.map(q => ({ x: q.x - dx, y: q.y - dy }));
      p.pts = mv(p.pts); if (p.holes) p.holes = p.holes.map(mv);
      if (p.at) p.at = { ...p.at, o: [0, 1, 2].map(k => p.at!.o[k] + p.at!.u[k] * dx + p.at!.v[k] * dy) as V3 };
    }
    p.w = Math.max(...p.pts.map(q => q.x)); p.h = Math.max(...p.pts.map(q => q.y));
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

// ───────────────────────────── Formen (selbst gezeichnet) ─────────────────────────────

const signedArea = (p: Pt[]) => p.reduce((s, q, i) => { const n = p[(i + 1) % p.length]; return s + q.x * n.y - n.x * q.y; }, 0) / 2;
const ccw = (p: Pt[]) => (signedArea(p) < 0 ? [...p].reverse() : p);
const poly = (xy: number[][]): Pt[] => xy.map(([x, y]) => ({ x, y }));
const toMP = (p: Pt[]): MultiPolygon => [[p.map(q => [q.x, q.y] as [number, number])]];
/** Flächen vereinigen, größter Umriss (gegen den Uhrzeigersinn, ohne doppelten Endpunkt) */
function unite(parts: Pt[][]): Pt[] {
  const m = polygonClipping.union(toMP(parts[0]), ...parts.slice(1).map(toMP));
  let best: Pt[] = [], ba = -1;
  for (const pg of m) {
    const r = pg[0].map(([x, y]) => ({ x, y }));
    if (r.length > 1 && Math.hypot(r[0].x - r[r.length - 1].x, r[0].y - r[r.length - 1].y) < 1e-9) r.pop();
    const ar = Math.abs(signedArea(r));
    if (ar > ba) { ba = ar; best = r; }
  }
  return ccw(best);
}
/** Kleinster Abstand eines Punktes zum Umriss (wie groß darf ein Loch dort sein?) */
function freeRadius(p: Pt[], x: number, y: number): number {
  let d = Infinity;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
    d = Math.min(d, Math.hypot(a.x + u * dx - x, a.y + u * dy - y));
  }
  return d;
}
const ring = (cx: number, cy: number, r: number, n = 48): Pt[] => circle(cx, cy, r, n);
const starPts = (cx: number, cy: number, R: number, r: number, n = 5): Pt[] =>
  Array.from({ length: 2 * n }, (_, i) => { const u = Math.PI / 2 + (Math.PI * i) / n, rr = i % 2 ? r : R; return { x: cx + rr * Math.cos(u), y: cy + rr * Math.sin(u) }; });
/** Herzkurve: Breite 32 k, Spitze unten */
const heartPts = (k: number, dy: number): Pt[] => ccw(Array.from({ length: 72 }, (_, i) => {
  const u = (2 * Math.PI * i) / 72;
  return { x: k * 16 * Math.sin(u) ** 3, y: dy + k * (13 * Math.cos(u) - 5 * Math.cos(2 * u) - 2 * Math.cos(3 * u) - Math.cos(4 * u)) };
}));
/** Tannenbaum aus drei Dreiecken und Stamm (Breite 1, unten bei 0, Spitze bei top) */
const firTree = (top: number): Pt[][] => [
  poly([[-0.5, 0.12], [0.5, 0.12], [0, 0.5]]), poly([[-0.4, 0.36], [0.4, 0.36], [0, 0.72]]), poly([[-0.28, 0.6], [0.28, 0.6], [0, top]]),
  poly([[-0.08, 0], [0.08, 0], [0.08, 0.16], [-0.08, 0.16]])
];

/** Einflugloch-Form (beliebige Größe, wird danach auf die gewünschte Breite gebracht) */
function entranceRaw(e: Entrance): Pt[] {
  switch (e) {
    case "square": return poly([[-1, -1], [1, -1], [1, 1], [-1, 1]]);
    case "arch": {
      const pts = poly([[-1, -1.2], [1, -1.2]]);
      for (let i = 0; i <= 24; i++) { const a = (Math.PI * i) / 24; pts.push({ x: Math.cos(a), y: 0.2 + Math.sin(a) }); }
      return pts;
    }
    case "heart": return heartPts(1 / 16, 0);
    case "triangle": return poly([[-1, -0.87], [1, -0.87], [0, 0.87]]);
    case "pentagon": return Array.from({ length: 5 }, (_, i) => { const u = Math.PI / 2 + (2 * Math.PI * i) / 5; return { x: Math.cos(u), y: Math.sin(u) }; });
    case "star": return starPts(0, 0, 1, 0.45);
    case "diamond": return poly([[0, -1.3], [1, 0], [0, 1.3], [-1, 0]]);
    case "flower": return Array.from({ length: 128 }, (_, i) => { const u = (2 * Math.PI * i) / 128, r = 0.78 + 0.22 * Math.cos(8 * u); return { x: r * Math.cos(u), y: r * Math.sin(u) }; });
    case "leaf": {
      const pts: Pt[] = [];
      for (let i = 0; i <= 24; i++) { const y = -1 + (2 * i) / 24; pts.push({ x: 1 - y * y, y: 1.3 * y }); }
      for (let i = 23; i > 0; i--) { const y = -1 + (2 * i) / 24; pts.push({ x: -(1 - y * y), y: 1.3 * y }); }
      return pts;
    }
    case "tree": return unite(firTree(0.92));
    case "clover": return unite([ring(0.5, 0, 0.5), ring(-0.5, 0, 0.5), ring(0, 0.5, 0.5), ring(0, -0.5, 0.5), poly([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]])]);
    default: return ring(0, 0, 1, 64);
  }
}
/** Form des Einfluglochs mit der Breite 2 r, Mitte (der umgebenden Box) bei (cx, cz) */
function entranceShape(e: Entrance, cx: number, cz: number, r: number): Pt[] {
  const p = entranceRaw(e), xs = p.map(q => q.x), ys = p.map(q => q.y);
  const k = (2 * r) / (Math.max(...xs) - Math.min(...xs)), mx = (Math.max(...xs) + Math.min(...xs)) / 2, my = (Math.max(...ys) + Math.min(...ys)) / 2;
  return ccw(p.map(q => ({ x: cx + (q.x - mx) * k, y: cz + (q.y - my) * k })));
}
const entranceH = (e: Entrance, r: number) => { const ys = entranceShape(e, 0, 0, r).map(q => q.y); return Math.max(...ys) - Math.min(...ys); };

/** Aufhänger (oben auf der Firstplatte), etwa 1 hoch und 1 breit, unten bei y = 0; dazu die Mitte des Lochs */
function hangerRaw(h: Hanger): { shape: Pt[]; hx: number; hy: number } {
  switch (h) {
    case "heart": return { shape: heartPts(1 / 32, 0.56), hx: 0, hy: 0.52 };
    case "star": return { shape: starPts(0, 0.5, 0.55, 0.27), hx: 0, hy: 0.5 };
    case "crown": return {
      shape: unite([poly([[-0.5, 0], [0.5, 0], [0.55, 0.85], [0.28, 0.5], [0, 0.95], [-0.28, 0.5], [-0.55, 0.85]]),
        ring(0.55, 0.85, 0.08, 16), ring(0, 0.95, 0.08, 16), ring(-0.55, 0.85, 0.08, 16)]), hx: 0, hy: 0.28 };
    case "wings": {
      const wing = (sg: number) => poly([[0.15, 0.35], [0.6, 0.5], [0.98, 0.95], [0.78, 0.66], [0.9, 0.7], [0.66, 0.46], [0.76, 0.42], [0.35, 0.25]].map(([x, y]) => [sg * x, y]));
      return { shape: unite([ring(0, 0.55, 0.34), ccw(wing(1)), ccw(wing(-1)), poly([[-0.15, 0], [0.15, 0], [0.15, 0.4], [-0.15, 0.4]])]), hx: 0, hy: 0.55 };
    }
    case "tree": return { shape: unite([...firTree(0.95), ring(0, 1.02, 0.19, 32)]), hx: 0, hy: 1.02 };
    default: return { shape: ring(0, 0.5, 0.5), hx: 0, hy: 0.5 };
  }
}

// ───────────────────────────── Anhänger (Mini-Vogelhaus) ─────────────────────────────

const ORN_PERCH_D = 3;             // Sitzstange: Zahnstocher / Rundstab Ø 3
const ornOpts = (o: BirdhouseOptions) => ({
  hanger: HANGERS.includes(o.hanger!) ? o.hanger! : "ring", entrance: ENTRANCES.includes(o.entrance!) ? o.entrance! : "circle",
  base: BASES.includes(o.base!) ? o.base! : "rect", m: Math.max(0, o.baseMargin ?? 5), frame: !!o.frame && o.entrance !== "none"
});
/** Breite des Zierrahmens */
const frameW = (t: number) => Math.max(2, 0.8 * t);

/** Lage des Einfluglochs beim Anhänger: Mitte zc, Höhe eh, Rand (mit Rahmen) und Sitzstange zp */
function ornSpot(o: BirdhouseOptions) {
  const { t, Hs } = birdDims(o), { entrance, frame } = ornOpts(o);
  const r = Math.max(1.5, o.hole / 2), eh = entranceH(entrance === "none" ? "circle" : entrance, r), fw = frame ? frameW(t) : 0;
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

/** Rechteck bw × bd mit ausgeklinkten (notched) oder nach innen gerundeten (concave) Ecken, gegen den Uhrzeigersinn */
function cornerCut(shape: "notched" | "concave", bw: number, bd: number, c: number): Pt[] {
  const out: Pt[] = [];
  // je Ecke (links unten, rechts unten, rechts oben, links oben): von der Kante davor zur Kante danach
  for (const [cx, cy, a0] of [[0, 0, 0], [bw, 0, Math.PI / 2], [bw, bd, Math.PI], [0, bd, (3 * Math.PI) / 2]]) {
    const p1 = { x: cx + c * Math.cos(a0 + Math.PI / 2), y: cy + c * Math.sin(a0 + Math.PI / 2) };
    const p0 = { x: cx + c * Math.cos(a0), y: cy + c * Math.sin(a0) };
    if (shape === "notched") out.push(p1, { x: p1.x + p0.x - cx, y: p1.y + p0.y - cy }, p0);
    else for (let i = 0; i <= 10; i++) { const a = a0 + Math.PI / 2 - (Math.PI / 2) * (i / 10); out.push({ x: cx + c * Math.cos(a), y: cy + c * Math.sin(a) }); }
  }
  return ccw(out.filter((q, i) => i === 0 || Math.hypot(q.x - out[i - 1].x, q.y - out[i - 1].y) > 1e-9));
}

/** Grundplatte um die Grundfläche W × D: Umriss in eigenen Koordinaten, deren Ursprung in der Welt bei (x0, y0) liegt */
function basePlate(shape: BaseShape, W: number, D: number, m: number): { x0: number; y0: number; pts: Pt[] } {
  const bw = W + 2 * m, bd = D + 2 * m;
  // runde Formen um die Mitte: der Grundradius reicht über die Ecken der Grundfläche hinaus
  const polar = (f: (u: number) => number) => {
    const R0 = Math.hypot(W / 2, D / 2) + m, rs = Array.from({ length: 192 }, (_, i) => R0 + f((2 * Math.PI * i) / 192)), ext = Math.max(...rs);
    return { x0: W / 2 - ext, y0: D / 2 - ext, pts: rs.map((r, i) => { const u = (2 * Math.PI * i) / 192; return { x: ext + r * Math.cos(u), y: ext + r * Math.sin(u) }; }) };
  };
  const amp = Math.max(2, m * 0.8);
  switch (shape) {
    case "oval": {
      // Ellipse durch die Ecken der Grundfläche plus Überstand
      const A = (W / 2 + m) * Math.SQRT2, B = (D / 2 + m) * Math.SQRT2;
      const pts = Array.from({ length: 96 }, (_, i) => { const u = (2 * Math.PI * i) / 96; return { x: A + A * Math.cos(u), y: B + B * Math.sin(u) }; });
      return { x0: W / 2 - A, y0: D / 2 - B, pts };
    }
    case "wave": {
      // Wellenrand: Bögen nach außen auf einem abgerundeten Rechteck (Überstand m = Fuß der Wellen)
      const a2 = Math.max(1.5, m * 0.6);
      const path = roundedPath(a2, a2, a2 + bw, a2 + bd, Math.max(a2, Math.min(bw, bd) / 5), 0.4);
      const n = path.length, waves = Math.max(8, Math.round((2 * (bw + bd)) / Math.max(6, 4 * a2)));
      const pts = path.map((q, i) => { const k = a2 * Math.abs(Math.sin((Math.PI * waves * i) / n)); return { x: q.x + q.nx * k, y: q.y + q.ny * k }; });
      return { x0: -m - a2, y0: -m - a2, pts };
    }
    case "circle": return polar(() => 0);
    case "flower": return polar(u => amp * Math.abs(Math.cos(3 * u)) ** 0.7);          // sechs Blütenblätter
    case "rosette": return polar(u => amp * 0.5 * Math.abs(Math.cos(8 * u)));         // sechzehn kleine Bögen
    case "notched": case "concave": return { x0: -m, y0: -m, pts: cornerCut(shape, bw, bd, Math.max(0.5, m * 0.85)) };
    default: {
      const pts = shape === "round" ? roundedPath(0, 0, bw, bd, Math.min(bw, bd) / 4, 0.8).map(q => ({ x: q.x, y: q.y }))
        : [{ x: 0, y: 0 }, { x: bw, y: 0 }, { x: bw, y: bd }, { x: 0, y: bd }];
      return { x0: -m, y0: -m, pts };
    }
  }
}

function ornamentPanels(o: BirdhouseOptions): BirdPanel[] {
  const { t, a, W, D, Hs, Zr, ov } = birdDims({ ...o, door: false });
  const { hanger, entrance, base, m, frame } = ornOpts(o);
  const f = Math.max(t, o.finger), P = (L: number, corner: boolean, odd: boolean, fingers = true) => profile(L, t, f, corner, odd, fingers);
  const ta = Math.tan(a), ca = Math.cos(a), panels: BirdPanel[] = [];
  const tabbed = base !== "none", plate = hanger !== "none";
  // mit Grundplatte: unter jeder Wand ein Streifen (t hoch) mit Zapfen; die Platte liegt dann bei z = -t … 0
  const z0 = tabbed ? t : 0, H = Hs + z0;
  const bottomEdge = (L: number, corner: boolean, odd: boolean) => (tabbed ? P(L, false, true) : P(L, corner, odd));
  const roof = buildRoof(o, plate);

  // Firstplatte mit Aufhänger: steckt in einem Schlitz (Breite t) oben in beiden Giebeln
  const zr0 = Zr - (t / 2) * ta;                          // Dach-Innenseite an der Firstplatte
  const k = Math.max(0.5, Math.min(3 * t, 0.6 * (zr0 - Hs)));
  const zb = zr0 - k;
  const apex = !plate ? [{ x: W / 2, y: Zr + z0 }]
    : [{ x: W / 2 + t / 2, y: zr0 + z0 }, { x: W / 2 + t / 2, y: zb + z0 }, { x: W / 2 - t / 2, y: zb + z0 }, { x: W / 2 - t / 2, y: zr0 + z0 }];
  const top = gableTop(W, H, a, t, apex, roof.tabs);

  const spot = ornSpot(o), holes: Pt[][] = [];
  if (entrance !== "none") {
    holes.push(entranceShape(entrance, W / 2, spot.zc + z0, spot.r));
    if (o.perch && spot.zp - ORN_PERCH_D / 2 > 1) holes.push(circle(W / 2, spot.zp + z0, ORN_PERCH_D / 2, 24));
  }
  const fb = (name: "front" | "back", y: number, hl?: Pt[][]) => {
    const pts = outline(W, H, t, bottomEdge(W, true, true), P(H, true, true), rectSeg(W, true), P(H, true, true));
    panels.push({ name, w: W, h: Zr + z0, pts: insertTop(pts, W, H, top.map(q => ({ ...q }))), holes: hl, at: across(0, y, -z0) });
  };
  fb("front", 0, holes); fb("back", D - t);
  const side = outline(D, H, t, bottomEdge(D, false, true), P(H, false, false), P(D, false, true, false), P(H, false, false));
  panels.push({ name: "left", w: D, h: H, pts: side, at: along(0, 0, -z0) });
  panels.push({ name: "right", w: D, h: H, pts: side.map(q => ({ ...q })), at: along(W - t, 0, -z0) });

  if (tabbed) {
    // Grundplatte mit Schlitzen genau unter den Zapfen der Wände
    // mindestens ein schmaler Rand, sonst wären die Schlitze am Rand offen
    const bp = basePlate(base, W, D, Math.max(m, 2, 0.7 * t)), slots: Pt[][] = [];
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

  panels.push(roof.L, roof.R);
  if (!plate) return panels;

  // Firstplatte (x = Tiefe ab dem vorderen Dachrand, y = Höhe z): unten bis zr0, zwischen den Giebeln bis zb;
  // oben ein schmaler Kamm über dem Dach und in der Mitte der Aufhänger
  const Lp = roof.Dr, zt = zr0 + t * ca + Math.max(0.8, 0.4 * t), w = Math.max(1.5, 0.7 * t), mid = Lp / 2;
  const pts: Pt[] = [{ x: 0, y: zr0 }, { x: ov, y: zr0 }, { x: ov, y: zb }, { x: ov + D, y: zb }, { x: ov + D, y: zr0 }, { x: Lp, y: zr0 }, { x: Lp, y: zt }];
  let hole: Pt[], shapePts: Pt[];
  if (hanger === "arch" || hanger === "point") {
    const Rh = Math.max(1.5, Math.min(4, Lp * 0.07));
    if (hanger === "arch") {
      const hh = 2 * Rh + 2 * w + 1;
      for (let i = 1; i < 48; i++) { const u = (Math.PI * i) / 48; pts.push({ x: mid + mid * Math.cos(u), y: zt + hh * Math.sin(u) }); }
      hole = circle(mid, zt + hh - w - Rh, Rh, 32);
    } else {
      const hh = Math.max(Lp * 0.35, 3.2 * (Rh + w));
      pts.push({ x: mid, y: zt + hh });
      hole = circle(mid, zt + Math.max(Rh + 0.5, hh * 0.32), Rh, 32);
    }
    pts.push({ x: 0, y: zt });
    shapePts = pts;
  } else {
    // freie Form (Ring, Herz, Stern, Krone, Flügel, Baum): mit dem Kamm vereinigt; Loch so groß, wie die Form erlaubt
    pts.push({ x: 0, y: zt });
    const { shape, hx, hy } = hangerRaw(hanger), fr = freeRadius(shape, hx, hy);
    const S = Math.max(10, Math.min(40, Lp * 0.55), (1.5 + w) / fr);   // Loch mindestens Ø 3 mm
    const by = zt - 0.12 * S;                                          // etwas in den Kamm hinein, damit es fest verbunden ist
    shapePts = unite([pts, shape.map(q => ({ x: mid + q.x * S, y: by + q.y * S }))]);
    hole = circle(mid + hx * S, by + hy * S, fr * S - w, 32);
  }
  const topZ = Math.max(...shapePts.map(q => q.y));
  panels.push({ name: "hanger", w: Lp, h: topZ - zb, pts: shapePts.map(q => ({ x: q.x, y: q.y - zb })), holes: [hole.map(q => ({ x: q.x, y: q.y - zb }))],
    at: { o: [W / 2 + t / 2, -ov, zb], u: [0, 1, 0], v: [0, 0, 1], n: [-1, 0, 0] } });
  return panels;
}

/** Lage des Einfluglochs für die Anzeige (Unterkante über dem Boden innen), für beide Arten */
export function holeFloor(o: BirdhouseOptions): number {
  return o.kind === "ornament" ? ornSpot(o).floor : holeSpot(o).floor;
}
