/**
 * GROSSES TEIL IN STÜCKE TEILEN (Fugen mit Verbindung) – nur Geometrie, ohne Oberfläche (Tests: `npm test`)
 *
 * Ein Teil, das größer ist als die Maschine, wird an Fugen in Stücke geteilt, die einzeln aufs Bett passen und
 * danach zusammengesteckt und verleimt werden. Fugen laufen gerade über die ganze Zeichnung, senkrecht ("x": bei
 * x = pos) oder waagerecht ("y": bei y = pos). Zwischen den Fugen liegen die Stücke wie in einer Tabelle:
 * Spalte = Buchstabe (links A), Reihe = Zahl (oben 1) → A1, B1, A2 …
 *
 * DIE TRENNLINIE einer Fuge besteht nur aus Geraden und Kreisbögen, die glatt ineinander übergehen, und kein Bogen
 * ist enger als der Fräser-Radius. Jedes Stück endet um das Spiel (je Seite) vor dieser Linie – als echte Parallele:
 * Gerade bleibt Gerade, Bogen bleibt Bogen mit Radius ± Spiel. Daraus folgt beides, was zählt:
 *   - der Fräser kann jede Innenrundung beider Stücke wirklich schneiden (keine Dogbone-Löcher in der Sichtfläche),
 *   - der Spalt zwischen den Stücken ist überall genau 2 × Spiel.
 * Verbindungen: "puzzle" (Noppe mit rundem Kopf an einem schmaleren Hals – hält auch auf Zug),
 *               "finger" (rechteckige Finger mit runden Ecken – richten nur aus), "butt" (stumpf, ohne Spiel).
 * Eine Verbindung sitzt nur dort, wo auf beiden Seiten genug Material ist: nicht in Löchern, nicht an dünnen
 * Stellen, nicht an Kreuzungen zweier Fugen. Was nicht passt, wird weggelassen und gemeldet.
 *
 * DIE STÜCKE: Als Teil gilt die Fläche aller geschlossenen Konturen „Außen/Innen“, die so tief gehen wie die tiefste
 * Außenkontur (= ausschneiden). Stück = Teil ∩ Zelle. Alles andere wird dem Stück zugeordnet, in dem es liegt:
 *   - liegt eine Form ganz in einer Zelle, kommt sie unverändert mit (Kreis bleibt Kreis, weitere Bearbeitungen bleiben);
 *   - geschlossene Formen über einer Fuge (Tasche, V-Carve, flache Kontur, Gravur-Kontur) werden als Fläche geteilt
 *     und reichen etwa einen Fräser-Ø (Gravur: Radius) über das Stück hinaus – die Fräser-Mitte läuft also einen Radius
 *     über die Fuge, an der Fuge bleibt nichts stehen. Das Stück daneben fräst seinen Teil genauso;
 *   - offene Linien werden einen Fräser-Radius hinter der Fuge abgeschnitten;
 *   - Bohrungen und Gewinde, die eine Fuge trifft, gibt es in keinem Stück (halbe Löcher am Rand verlaufen) → Meldung;
 *     Fasen an geteilten Konturen ebenso (sie würden auch die Fuge anfasen).
 *
 * LASER UND PLASMA (kind "laser" / "plasma") schneiden mit einem Schnittspalt statt mit einem Fräser:
 *   - Umriss des Teils sind die geschlossenen Formen, die durchschneiden (`beam(s).cut`): beim Laser die Formen der
 *     gewählten Schneid-Ebenen, beim Plasma alle geschlossenen Formen außer „auf Linie“. Tiefen gibt es dort nicht.
 *   - Der Spalt nimmt an beiden Stücken Material weg. Plasma gleicht ihn im G-Code selbst aus (plasmaCam.ts versetzt
 *     um den halben Spalt) – das Stück wird gezeichnet, wie es fertig sein soll. Der Laser fährt genau auf der Linie:
 *     dort wird die Fugenkante jedes Stücks um den halben Spalt weiter gezeichnet (Spiel − Spalt/2 von der Trennlinie,
 *     die gezeichneten Stücke überlappen also, wenn das Spiel kleiner ist als der halbe Spalt). Nach dem Schneiden
 *     liegt die Kante in beiden Fällen um das Spiel vor der Trennlinie, der Spalt zwischen den Stücken ist 2 × Spiel.
 *   - Rundungen: der Spalt-Ø gilt wie ein Fräser-Ø (der Brenner muss in jede Mulde kommen), Plasma bekommt größere.
 *   - Gefüllte Gravur-Flächen werden an der Stück-Kante abgeschnitten, Linien ebenso; gerade liegende Bilder werden
 *     auf den Rahmen des Stücks zugeschnitten (`cropMm`, das Zuschneiden selbst macht splitJob.ts).
 *
 * Einheiten: Formen kommen in Welt-Pixeln (shapeTransform.ts), gerechnet wird in mm, Y nach oben.
 */
import { fluteFits, fluteSettings } from "./fluting.ts";
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Polygon, Ring } from "polygon-clipping";
import { offsetArea, type XY } from "./joints.ts";
import { shapeToPaths, shapeBounds, createPolyline, cloneShape, newId, translateShape, MM_TO_PIXEL } from "./shapeTransform.ts";
import { extraOps, chamferSide } from "./ops.ts";

export type SeamAxis = "x" | "y";
/** Womit geschnitten wird: Fräser (Radius), Laser (Spalt, fährt auf der Linie) oder Plasma (Spalt, G-Code gleicht aus) */
export type SplitKind = "mill" | "laser" | "plasma";
export type SeamJoint = "puzzle" | "finger" | "butt";
export const SEAM_JOINTS: SeamJoint[] = ["puzzle", "finger", "butt"];

export interface Seam {
  axis: SeamAxis;      // "x" = senkrechte Fuge bei x = pos, "y" = waagerechte Fuge bei y = pos
  pos: number;         // mm, in den Koordinaten der Zeichnung
  joint: SeamJoint;
  size: number;        // Noppe: Kopf-Ø, Finger: Breite (mm)
  depth: number;       // Finger: wie weit sie ineinandergreifen (mm)
  count: number;       // Verbindungen je Material-Strecke, 0 = automatisch
  spacing: number;     // Noppen: Abstand Mitte–Mitte bei automatischer Anzahl (mm)
  clearance: number;   // Spiel je Seite (mm) – der Spalt zwischen zwei Stücken ist das Doppelte
  alternate: boolean;  // Noppen abwechselnd nach beiden Seiten
}

export interface SplitSetup {
  id: string;          // Kennung: die Stück-Betten gehören zu dieser Aufteilung
  seams: Seam[];
  made?: string;       // Fingerabdruck von Zeichnung + Fugen, als die Stücke zuletzt erzeugt wurden
  /** nur Laser: Ebenen, deren geschlossene Formen der Umriss des Teils sind (fehlt = automatisch die kräftigste) */
  cutLayers?: string[];
}

export const MAX_SEAMS = 12; // je Richtung
const PX = MM_TO_PIXEL;
const TOL = 0.004;           // Bögen der Trennlinie: größte Abweichung der Sehnen (mm)
const NECK = 0.56;           // Noppe: Halsbreite / Kopf-Ø

/** Spiel je Seite, mit dem eine neue Fuge beginnt: Plasma-Kanten sind rauer und schräg, Laser-Kanten fast glatt */
export const DEFAULT_CLEARANCE: Record<SplitKind, number> = { mill: 0.1, laser: 0.05, plasma: 0.3 };

export function defaultSeam(axis: SeamAxis = "x", pos = 0, kind: SplitKind = "mill"): Seam {
  return { axis, pos, joint: "puzzle", size: 24, depth: 12, count: 0, spacing: 120, clearance: DEFAULT_CLEARANCE[kind], alternate: true };
}

const num = (v: any, d: number, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

/** Fuge aus einer Projektdatei bereinigen */
export function cleanSeam(raw: any): Seam | null {
  if (!raw || (raw.axis !== "x" && raw.axis !== "y") || !Number.isFinite(Number(raw.pos))) return null;
  const d = defaultSeam();
  return {
    axis: raw.axis, pos: Number(raw.pos),
    joint: SEAM_JOINTS.includes(raw.joint) ? raw.joint : d.joint,
    size: num(raw.size, d.size, 1, 500), depth: num(raw.depth, d.depth, 0.5, 250),
    count: Math.round(num(raw.count, 0, 0, 200)), spacing: num(raw.spacing, d.spacing, 2, 5000),
    clearance: num(raw.clearance, d.clearance, 0, 5), alternate: raw.alternate !== false,
  };
}

/** Aufteilung aus einer Projektdatei bereinigen (null = keine) */
export function cleanSplit(raw: any): SplitSetup | null {
  if (!raw || !Array.isArray(raw.seams)) return null;
  const seams = raw.seams.map(cleanSeam).filter((s: Seam | null): s is Seam => !!s);
  const keep: Seam[] = [];
  for (const ax of ["x", "y"] as SeamAxis[]) keep.push(...seams.filter((s: Seam) => s.axis === ax).slice(0, MAX_SEAMS));
  const id = typeof raw.id === "string" && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : newId();
  // Ebenen-Kennungen landen in HTML-Attributen: nur harmlose Zeichen (wie laserLayers.ts sie vergibt)
  const cut = Array.isArray(raw.cutLayers) ? [...new Set<string>(raw.cutLayers.filter((x: any) => typeof x === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(x)))].slice(0, 40) : [];
  return { id, seams: keep, ...(typeof raw.made === "string" ? { made: raw.made.slice(0, 40) } : {}), ...(cut.length ? { cutLayers: cut } : {}) };
}

export const cloneSplit = (s: SplitSetup): SplitSetup => ({ ...s, seams: s.seams.map(m => ({ ...m })), ...(s.cutLayers ? { cutLayers: [...s.cutLayers] } : {}) });

/** Name eines Stücks: Spalte als Buchstabe (links A), Reihe als Zahl (oben 1) */
export function pieceName(col: number, row: number): string {
  let s = "", c = col;
  do { s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26) - 1; } while (c >= 0);
  return s + (row + 1);
}

// =====================================================================
// FORM DER VERBINDUNG
// =====================================================================

/**
 * Kleinster Bogen-Radius der Trennlinie für diesen Fräser-Ø bzw. Schnittspalt (etwas größer als der halbe Ø).
 * Plasma: mindestens 2 mm und 1,5 × Spalt – der Brenner fährt dann nie enger als einen Spalt-Radius um eine Ecke
 * (in engen Ecken bleibt er fast stehen und brennt sie aus).
 */
export function minCurveRadius(toolDia: number, kind: SplitKind = "mill"): number {
  if (kind === "plasma") return Math.max(2, 1.5 * Math.max(0, toolDia));
  return toolDia > 0 ? toolDia * 0.55 + 0.2 : 0.2;
}

export type IssueCode =
  | "noOutline"     // keine ausgeschnittene Außenkontur gefunden
  | "noOutlineLaser"  // Laser: keine geschlossene Form auf einer Ebene, die eine Linie schneidet
  | "noOutlinePlasma" // Plasma: keine geschlossene Form mit „Außen“ oder „Innen“
  | "kerf0"         // Laser: Schnittspalt nicht gemessen → die Fuge wird um einen Spalt weiter
  | "flute" | "fillLine"      // Laser: n Flächen „Füllen + Linie“ über einer Fuge – ihre Linie läuft auch an der Fuge entlang
  | "imageCut"      // Laser: n Bilder am Rahmen der Stücke zugeschnitten
  | "knobSmall"     // Noppe zu klein für den Fräser (v = kleinster Kopf-Ø)
  | "fingerSmall"   // Finger zu schmal für den Fräser (v = kleinste Breite)
  | "fingerShallow" // Finger zu flach (v = kleinste Tiefe)
  | "clearBig"      // Spiel zu groß für diese Verbindung (v = größtes Spiel)
  | "close"         // zwei Fugen liegen zu dicht beieinander (v = kleinster Abstand)
  | "outside"       // Fuge liegt neben dem Teil
  | "shortSpan"     // Material-Strecke zu kurz für eine Verbindung → dort stumpf (n Strecken, v = kürzeste)
  | "noRoom"        // Verbindungen weggelassen, weil ein Loch oder der Rand zu nah ist (n)
  | "hole"          // die Fuge läuft durch n Ausschnitte
  | "plain"         // auf der ganzen Fuge hat keine Verbindung Platz
  | "fragments"     // ein Stück besteht aus n losen Teilen
  | "sliver"        // ein Stück hat einen sehr schmalen Rest (w × h)
  | "flute"         // n Flöten liegen über einer Fuge: an der Fuge volle Tiefe
  | "drill"         // n Bohrungen/Gewinde liegen auf einer Fuge und fehlen in den Stücken (x, y = erste)
  | "chamfer"       // n Fasen an geteilten Konturen weggelassen
  | "image"         // n Bilder liegen über einer Fuge und bleiben ganz in einem Stück
  | "island"        // in einem Stück konnte eine Insel einer Tasche nicht sicher zugeordnet werden
  | "noFit"         // ein Stück passt nicht aufs Bett (w × h)
  | "geometry";     // die Flächen ließen sich nicht sicher berechnen (Fuge etwas verschieben)

export interface Issue {
  code: IssueCode; level: "error" | "warn";
  seam?: number;    // Nummer in setup.seams (0-basiert)
  piece?: string;
  n?: number; v?: number; w?: number; h?: number; x?: number; y?: number;
}

/** Maße einer Verbindung für einen Fräser-Ø. reach = wie weit sie über die Fugenlinie ragt (ohne Spiel) */
export interface Profile {
  joint: SeamJoint;
  c: number;       // Spiel je Seite, das wirklich gilt (stumpf: 0)
  rho: number;     // Radius der Rundungen
  R: number; w: number; h: number; // Noppe: Kopf-Radius, halbe Fußbreite, Abstand Kopf-Mitte von der Fuge
  halfW: number;   // Noppe: halbe Breite des Platzes entlang der Fuge
  F: number; D: number; // Finger: Breite, Tiefe
  reach: number;
  minPitch: number; // Noppen: kleinster Abstand Mitte–Mitte
  errors: Issue[];
}

export function seamProfile(seam: Seam, toolDia: number, index = 0, kind: SplitKind = "mill"): Profile {
  const rhoMin = minCurveRadius(toolDia, kind);
  const p: Profile = { joint: seam.joint, c: seam.joint === "butt" ? 0 : Math.max(0, seam.clearance), rho: rhoMin, R: 0, w: 0, h: 0, halfW: 0, F: 0, D: 0, reach: 0, minPitch: 0, errors: [] };
  const err = (code: IssueCode, v: number) => p.errors.push({ code, level: "error", seam: index, v: Math.ceil(v * 10 - 1e-9) / 10 });
  if (seam.joint === "puzzle") {
    const S = seam.size;
    p.R = S / 2;
    p.rho = Math.max(rhoMin, 0.16 * S);
    p.w = (NECK * S) / 2 + p.rho;
    p.h = p.rho + Math.sqrt(Math.max(0, (p.R + p.rho) ** 2 - p.w ** 2));
    p.halfW = Math.max(p.w, p.R);
    p.reach = p.h + p.R;
    p.minPitch = 2 * p.halfW + (seam.alternate ? 1 : toolDia + 2 * p.c + 0.5);
    // der Fräser muss durch die Öffnung in die Mulde des Gegenstücks kommen: Hals + 2 × Spiel ≥ Fräser-Ø
    if (toolDia > 0 && NECK * S + 2 * p.c < toolDia + 0.2) err("knobSmall", (toolDia + 0.2 - 2 * p.c) / NECK);
    // Kopf muss breiter bleiben als die Öffnung (sonst hält die Noppe nicht), Rundungen müssen das Spiel vertragen
    const cMax = Math.min(((1 - NECK) * S) / 4, p.rho, p.R) - 0.05;
    if (p.c > cMax) p.errors.push({ code: "clearBig", level: "error", seam: index, v: Math.max(0, Math.floor(cMax * 100) / 100) });
  } else if (seam.joint === "finger") {
    p.rho = Math.max(rhoMin, 0.5);
    p.F = seam.size; p.D = seam.depth;
    p.reach = p.D / 2;
    if (p.F < 2 * p.rho) err("fingerSmall", 2 * p.rho);
    if (p.D < 2 * p.rho) err("fingerShallow", 2 * p.rho);
    if (p.c > p.rho - 0.05) p.errors.push({ code: "clearBig", level: "error", seam: index, v: Math.max(0, Math.floor((p.rho - 0.05) * 100) / 100) });
  }
  return p;
}

/** Eine Verbindung auf der Fuge: Noppe (Mitte m, dir +1 = ragt zur Seite B) oder Finger-Reihe (ab s, n Finger) */
export type Feature = { kind: "knob"; m: number; dir: 1 | -1 } | { kind: "run"; s: number; n: number };

/**
 * Trennlinie in den eigenen Koordinaten der Fuge: u entlang der Fuge, v quer (v > 0 = Seite B, also rechts bzw. oben).
 * d = Parallel-Abstand: −c für den Rand von Stück A, +c für den Rand von Stück B, 0 = die Linie selbst.
 */
export function seamPath(p: Profile, feats: Feature[], d: number, u0: number, u1: number): XY[] {
  const pts: XY[] = [];
  const add = (u: number, v: number) => {
    const l = pts[pts.length - 1];
    if (!l || Math.hypot(l[0] - u, l[1] - v) > 1e-9) pts.push([u, v]);
  };
  // Bogen um (cu, cv): sweep > 0 dreht nach links (Mitte auf Seite B) → Radius − d, sonst Radius + d
  const arc = (cu: number, cv: number, r: number, a0: number, sweep: number) => {
    const rr = sweep > 0 ? r - d : r + d;
    if (rr <= 1e-9) { add(cu, cv); return; }
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(-1, 1 - TOL / rr)))));
    for (let i = 0; i <= n; i++) { const a = a0 + (sweep * i) / n; add(cu + rr * Math.cos(a), cv + rr * Math.sin(a)); }
  };
  /** Stufe bei u = at von Höhe a nach b (zwei Bögen, dazwischen bei hohen Stufen eine Gerade quer zur Fuge) */
  const step = (at: number, a: number, b: number) => {
    const H = Math.abs(b - a), up = b > a ? 1 : -1, rho = p.rho;
    if (H < 1e-9) return;
    if (H >= 2 * rho) {
      arc(at - rho, a + up * rho, rho, -up * Math.PI / 2, up * Math.PI / 2);
      add(at + up * d * -1, b - up * rho); // Flanke: quer zur Fuge, um d verschoben (links der Fahrtrichtung)
      arc(at + rho, b - up * rho, rho, Math.PI, -up * Math.PI / 2);
    } else {
      const th = Math.acos(1 - H / (2 * rho)), hl = rho * Math.sin(th);
      arc(at - hl, a + up * rho, rho, -up * Math.PI / 2, up * th);
      arc(at + hl, b - up * rho, rho, up * (Math.PI / 2 + th), -up * th);
    }
  };
  add(u0, d);
  for (const f of [...feats].sort((x, y) => (x.kind === "knob" ? x.m : x.s) - (y.kind === "knob" ? y.m : y.s))) {
    if (f.kind === "knob") {
      const s = f.dir, a1 = Math.atan2(p.h - p.rho, p.w);
      add(f.m - p.w, d);
      arc(f.m - p.w, s * p.rho, p.rho, -s * Math.PI / 2, s * (a1 + Math.PI / 2));
      arc(f.m, s * p.h, p.R, s * (a1 + Math.PI), -s * (Math.PI + 2 * a1));
      arc(f.m + p.w, s * p.rho, p.rho, s * (Math.PI - a1), s * (Math.PI / 2 + a1));
      add(f.m + p.w, d);
    } else {
      // Finger: abwechselnd +D/2 (Finger von A) und −D/2 (Finger von B), am Anfang und Ende eine halbe Stufe
      let level = 0;
      for (let k = 0; k <= f.n; k++) {
        const next = k === f.n ? 0 : (k % 2 === 0 ? 1 : -1) * p.D / 2;
        step(f.s + k * p.F, level, next);
        level = next;
      }
    }
  }
  add(u1, d);
  return pts;
}

/** Punkt der Fuge (u, v) → Zeichnung (mm) */
const toWorld = (seam: Seam, u: number, v: number): XY => seam.axis === "x" ? [seam.pos + v, u] : [u, seam.pos + v];

// =====================================================================
// FLÄCHEN-HELFER
// =====================================================================

const ringArea = (r: Ring) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return a / 2; };
export const areaOf = (m: MultiPolygon) => m.reduce((s, poly) => s + poly.reduce((t, r, i) => t + (i ? -1 : 1) * Math.abs(ringArea(r)), 0), 0);
const outerOnly = (m: MultiPolygon): MultiPolygon => m.map(poly => [poly[0]] as Polygon);

export interface Box { minX: number; minY: number; maxX: number; maxY: number }
const boxOfRing = (r: Ring): Box => {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of r) { if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x; if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y; }
  return b;
};
const boxOf = (m: MultiPolygon): Box | null => {
  let b: Box | null = null;
  for (const poly of m) { const o = boxOfRing(poly[0]); b = b ? { minX: Math.min(b.minX, o.minX), minY: Math.min(b.minY, o.minY), maxX: Math.max(b.maxX, o.maxX), maxY: Math.max(b.maxY, o.maxY) } : o; }
  return b;
};
const apart = (a: Box, b: Box, pad = 0) => a.maxX < b.minX - pad || a.minX > b.maxX + pad || a.maxY < b.minY - pad || a.minY > b.maxY + pad;

function inRing(r: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Punkt in der Fläche (Löcher zählen nicht dazu) */
export function inArea(m: MultiPolygon, x: number, y: number): boolean {
  for (const poly of m) if (inRing(poly[0], x, y) && !poly.slice(1).some(h => inRing(h, x, y))) return true;
  return false;
}

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
/** polygon-clipping kann bei fast deckungsgleichen Kanten scheitern: mitzählen, damit nie still ein Stück fehlt */
let clipErrors = 0;
const safe = <T>(f: () => T, fallback: T): T => { try { return f(); } catch { clipErrors++; return fallback; } };
const inter = (a: MultiPolygon, ...b: (MultiPolygon | Polygon)[]): MultiPolygon => (a.length ? safe(() => polygonClipping.intersection(a, ...(b as any)), []) : []);
const diff = (a: MultiPolygon | Polygon, ...b: (MultiPolygon | Polygon)[]): MultiPolygon => safe(() => polygonClipping.difference(a as any, ...(b as any)), []);

/** offene Linie auf eine Fläche zuschneiden → Stücke, die in der Fläche liegen */
export function clipLine(pts: XY[], m: MultiPolygon): XY[][] {
  const edges: [XY, XY, Box][] = [];
  for (const poly of m) for (const r of poly) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[j] as XY, b = r[i] as XY;
    edges.push([a, b, { minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) }]);
  }
  const out: XY[][] = [];
  let cur: XY[] = [];
  const end = () => { if (cur.length >= 2) out.push(cur); cur = []; };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], rx = b[0] - a[0], ry = b[1] - a[1];
    if (Math.hypot(rx, ry) < 1e-12) continue;
    const sb = { minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) };
    const ts = [0, 1];
    for (const [c, e, eb] of edges) {
      if (apart(sb, eb)) continue;
      const sx = e[0] - c[0], sy = e[1] - c[1], den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-14) continue;
      const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den, w = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
      if (t > 1e-9 && t < 1 - 1e-9 && w >= 0 && w <= 1) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    for (let k = 1; k < ts.length; k++) {
      if (ts[k] - ts[k - 1] < 1e-12) continue;
      const tm = (ts[k] + ts[k - 1]) / 2;
      const p: XY = [a[0] + rx * ts[k - 1], a[1] + ry * ts[k - 1]], q: XY = [a[0] + rx * ts[k], a[1] + ry * ts[k]];
      if (inArea(m, a[0] + rx * tm, a[1] + ry * tm)) {
        const l = cur[cur.length - 1];
        if (!l || Math.hypot(l[0] - p[0], l[1] - p[1]) > 1e-7) { end(); cur.push(p); }
        cur.push(q);
      } else end();
    }
  }
  end();
  return out;
}

// =====================================================================
// FUGE AUSLEGEN: wo ist Material, wo passt eine Verbindung hin
// =====================================================================

/** Strecken der Fugenlinie, die durch Material laufen (u-Werte, aufsteigend) */
function materialSpans(M: MultiPolygon, seam: Seam): [number, number][] {
  const us: number[] = [];
  for (const poly of M) for (const r of poly) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[j], b = r[i];
    const va = (seam.axis === "x" ? a[0] : a[1]) - seam.pos, vb = (seam.axis === "x" ? b[0] : b[1]) - seam.pos;
    if ((va > 0) === (vb > 0)) continue;
    const t = va / (va - vb), ua = seam.axis === "x" ? a[1] : a[0], ub = seam.axis === "x" ? b[1] : b[0];
    us.push(ua + t * (ub - ua));
  }
  us.sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < us.length; i += 2) if (us[i + 1] - us[i] > 1e-6) out.push([us[i], us[i + 1]]);
  return out;
}

export interface SeamLayout {
  seam: Seam; index: number; profile: Profile; feats: Feature[];
  reachA: number; reachB: number; // wie weit Verbindungen wirklich zur Seite A / B ragen (ohne Spiel)
  line: XY[];                     // Trennlinie in mm (Zeichnung), nur für Anzeige und Einrichteblatt
}

function layoutSeam(seam: Seam, index: number, prof: Profile, M: MultiPolygon, crossing: { at: number; reach: number }[], toolDia: number, issues: Issue[]): Feature[] {
  if (prof.joint === "butt" || prof.errors.length) return [];
  const edge = Math.max(3, toolDia);
  // Material-Strecken, an Kreuzungen mit Quer-Fugen unterbrochen
  let spans = materialSpans(M, seam);
  for (const c of crossing) {
    const lo = c.at - c.reach - edge, hi = c.at + c.reach + edge;
    spans = spans.flatMap(([a, b]): [number, number][] => b <= lo || a >= hi ? [[a, b]] : [[a, Math.min(b, lo)], [Math.max(a, hi), b]]).filter(([a, b]) => b - a > 1e-6);
  }
  // Platz einer Verbindung als Rechteck: muss ganz im Material liegen
  const free = (ua: number, ub: number, va: number, vb: number): boolean => {
    const p = [toWorld(seam, ua, va), toWorld(seam, ub, vb)];
    const box = rect(Math.min(p[0][0], p[1][0]), Math.min(p[0][1], p[1][1]), Math.max(p[0][0], p[1][0]), Math.max(p[0][1], p[1][1]));
    return areaOf(diff(box, M)) < 1e-6;
  };
  const feats: Feature[] = [];
  let short = 0, shortest = Infinity, dropped = 0, turn = 0;
  for (const [a, b] of spans) {
    const L = b - a, lo = a + edge, hi = b - edge;
    if (prof.joint === "puzzle") {
      const reach = prof.reach + prof.c + edge;
      let n = seam.count > 0 ? seam.count : Math.max(1, Math.round(L / Math.max(1, seam.spacing)));
      while (n > 0 && (hi - lo) / n < (n > 1 ? prof.minPitch : 2 * prof.halfW)) n--;
      if (n < 1) { short++; shortest = Math.min(shortest, L); continue; }
      const slot = (hi - lo) / n;
      for (let k = 0; k < n; k++) {
        const dir: 1 | -1 = seam.alternate && turn % 2 === 1 ? -1 : 1;
        const s0 = lo + k * slot, mid = s0 + slot / 2;
        const fits = (m: number) => free(m - prof.halfW - edge, m + prof.halfW + edge, dir > 0 ? -edge : -reach, dir > 0 ? reach : edge);
        // erst die Mitte des Platzes, dann in kleinen Schritten nach beiden Seiten
        let at: number | null = null;
        const room = slot / 2 - prof.halfW - (n > 1 ? (prof.minPitch - 2 * prof.halfW) / 2 : 0);
        for (let o = 0; o <= room + 1e-9 && at === null; o += 2) for (const sg of o ? [1, -1] : [1]) if (fits(mid + sg * o)) { at = mid + sg * o; break; }
        if (at === null) { dropped++; continue; }
        feats.push({ kind: "knob", m: at, dir });
        turn++;
      }
    } else {
      const rd = prof.D / 2 + prof.c + edge;
      const maxFit = Math.floor((hi - lo - 2 * prof.rho) / prof.F);
      const n = seam.count > 0 ? Math.min(seam.count, maxFit) : maxFit;
      if (n < 1) { short++; shortest = Math.min(shortest, L); continue; }
      const s = (a + b) / 2 - (n * prof.F) / 2;
      // jeder Finger braucht Material unter sich; zusammenhängende gute Finger bilden eine Reihe
      let from = -1;
      for (let k = 0; k <= n; k++) {
        const ok = k < n && free(s + k * prof.F - prof.rho - edge, s + (k + 1) * prof.F + prof.rho + edge, -rd, rd);
        if (ok && from < 0) from = k;
        if (!ok && from >= 0) { feats.push({ kind: "run", s: s + from * prof.F, n: k - from }); from = -1; }
        if (!ok && k < n) dropped++;
      }
    }
  }
  if (short) issues.push({ code: "shortSpan", level: "warn", seam: index, n: short, v: Math.round(shortest * 10) / 10 });
  if (dropped) issues.push({ code: "noRoom", level: "warn", seam: index, n: dropped });
  if (!feats.length && spans.length) issues.push({ code: "plain", level: "warn", seam: index });
  return feats;
}

// =====================================================================
// ZEICHNUNG TEILEN
// =====================================================================

/** Wie Laser oder Plasma eine Form bearbeiten */
export interface BeamInfo {
  cut: boolean;     // schneidet durch → geschlossene Formen damit sind der Umriss des Teils
  fill: boolean;    // gefüllte Gravur (Laser): geschlossene Formen werden als Fläche geteilt
  line: boolean;    // die Linie wird abgefahren
  kerf: number;     // Schnittspalt in mm (0 = nicht bekannt)
  margin: number;   // Platz, den die Bahn außerhalb der Kontur braucht (Anfahrbahn, halber Spalt) in mm
}

export interface SplitOptions {
  bed: { w: number; h: number };  // Arbeitsbereich in mm
  /** wirksamer Schneid-Radius (mm) für eine Bearbeitung – 0 = Laser/Plasma */
  radiusOf: (v: { mode: string; toolId?: string; depth: number }) => number;
  /** Tiefe für Formen ohne eigene Tiefe (wie das Eingabefeld der Fräse) */
  fallbackDepth?: number;
  /** womit geschnitten wird (fehlt = Fräse) */
  kind?: SplitKind;
  /** Laser/Plasma: wie eine Form bearbeitet wird (null = gar nicht) – nötig, wenn kind nicht "mill" ist */
  beam?: (s: any) => BeamInfo | null;
}

export interface Piece {
  name: string; col: number; row: number;
  region: MultiPolygon;   // Fläche des Stücks in mm (Zeichnung)
  shapes: any[];          // Formen des Stücks in Welt-Pixeln, an ihrem Platz in der Zeichnung (Bilder mit `cropMm` sind noch nicht zugeschnitten)
  extent: Box | null;     // Platz, den das Stück beim Schneiden braucht (mit Fräserbahn bzw. Anfahrbahn), mm
  fits: boolean;
}

export interface SplitResult {
  pieces: Piece[];
  cols: number; rows: number;
  seams: SeamLayout[];
  issues: Issue[];
  part: MultiPolygon;     // das ganze Teil (mm)
  bounds: Box | null;     // Rahmen des Teils (mm)
  toolDia: number;        // Fräser-Ø, mit dem die Stücke ausgeschnitten werden – Laser/Plasma: der Schnittspalt
  kind: SplitKind;
  /** Laser: so weit ist jede Fugenkante weiter gezeichnet, damit der Schnittspalt ausgeglichen ist (sonst 0) */
  kerfShift: number;
  ok: boolean;            // keine Fehler → Stücke dürfen erzeugt werden
}

/** eine Bearbeitung einer Form (die Form selbst oder eine weitere aus shape.ops) */
interface Virt { src: any; op: number; mode: string; out?: string; toolId?: string; depth: number; finishAllow?: number; millDir?: any; extra?: Record<string, any> }

function virtuals(s: any, fallback: number): Virt[] {
  const out: Virt[] = [{ src: s, op: -1, mode: s.millingMode || "outside", toolId: s.toolId, depth: typeof s.millingDepth === "number" && Number.isFinite(s.millingDepth) ? s.millingDepth : fallback, finishAllow: s.finishAllow, millDir: s.millDir }];
  extraOps(s).forEach((o, i) => out.push({
    src: s, op: i, mode: o.kind, toolId: o.toolId, depth: o.depth, finishAllow: o.finishAllow || undefined, millDir: o.millDir,
    extra: { chamferW: o.chamferW, chamferSide: chamferSide(s), threadD: o.threadD, threadLeft: o.threadLeft, threadPitch: o.threadPitch, threadPasses: o.threadPasses, threadSpring: o.threadSpring },
  }));
  return out;
}

const CONTOUR_KEYS = ["tabN", "tabLen", "tabH", "skinH", "skinCut", "skinFeed", "leadIn", "leadOut", "leadType", "leadLen", "tro", "troW", "troStep", "troDown"];

/** Einstellungen, die ein neu entstandenes Stück einer Form von ihr erbt */
function carry(v: Virt, contour: boolean): Record<string, any> {
  const s = v.src, out: Record<string, any> = { millingDepth: v.depth };
  if (typeof v.toolId === "string") out.toolId = v.toolId;
  if (v.finishAllow) out.finishAllow = v.finishAllow;
  if (v.millDir) out.millDir = v.millDir;
  for (const k of ["laserLayerId", "plasmaCutId", "source", "laserOverride", "foldLine"]) if (s[k] !== undefined) out[k] = s[k];
  if (v.op < 0) for (const k of ["cutData", "restToolId", "vStart"]) if (s[k] !== undefined) out[k] = s[k];
  if (contour) for (const k of CONTOUR_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

const mmRing = (pts: { x: number; y: number }[]): Ring => pts.map(p => [p.x / PX, p.y / PX] as [number, number]);
const key = (x: number, y: number) => `${x},${y}`;

/** Ring (mm, erster = letzter Punkt) → Punkte in Welt-Pixeln, beginnend beim Punkt `start` */
function ringPoints(r: Ring, start = 0): { x: number; y: number }[] {
  const open = r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r;
  const n = open.length, out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) { const q = open[(i + start) % n]; out.push({ x: q[0] * PX, y: q[1] * PX }); }
  return out;
}

/** Wie cam.ts Inseln einer Tasche erkennt: kleinere geschlossene Form, deren erster Punkt in der Tasche liegt */
const isIsland = (pocket: Ring, shape: Ring) => Math.abs(ringArea(shape)) < Math.abs(ringArea(pocket)) && inRing(pocket, shape[0][0], shape[0][1]);

/**
 * Die Zeichnung an den Fugen teilen. Ändert `shapes` nicht; die Formen der Stücke sind neue Objekte mit neuen Kennungen.
 */
export function splitDrawing(shapes: any[], setup: SplitSetup, o: SplitOptions): SplitResult {
  const issues: Issue[] = [];
  clipErrors = 0;
  const fallback = o.fallbackDepth ?? -2;
  const kind: SplitKind = o.kind ?? "mill", beam = kind !== "mill";
  const beamOf = (s: any): BeamInfo | null => (beam && o.beam ? o.beam(s) : null);
  const list = shapes.filter(s => s && !s.keepOut);
  const info = list.map(s => {
    let path: { pts: { x: number; y: number }[]; closed: boolean } | undefined;
    try { path = shapeToPaths(s)[0]; } catch { /* ohne Bahn */ }
    const ring = path && path.pts.length >= 2 ? mmRing(path.pts) : null;
    const closed = !!path?.closed && !!ring && ring.length >= 3;
    const bi = beamOf(s);
    // Laser/Plasma: genau eine Bearbeitung je Form – ausschneiden, Fläche füllen oder Linie abfahren
    const virts: Virt[] = beam
      ? [{ src: s, op: -1, mode: closed && bi?.cut ? "outside" : closed && bi?.fill ? "fill" : "on-line", out: s.millingMode || "outside", toolId: s.toolId, depth: typeof s.millingDepth === "number" && Number.isFinite(s.millingDepth) ? s.millingDepth : fallback }]
      : virtuals(s, fallback);
    return { s, ring, closed, virts, box: ring ? boxOfRing(ring) : null, beam: bi };
  });
  type Info = (typeof info)[number];

  // ---- das Teil: geschlossene Konturen außen/innen, so tief wie die tiefste Außenkontur (Laser/Plasma: was durchschneidet) ----
  let T = 0;
  for (const i of info) if (i.closed) for (const v of i.virts) if (v.mode === "outside") T = Math.max(T, Math.abs(v.depth));
  const isThrough = (i: Info, v: Virt) => beam
    ? i.closed && !!i.beam?.cut
    : i.closed && (v.mode === "outside" || v.mode === "inside") && T > 0 && Math.abs(v.depth) >= T - 0.011;
  const through = info.filter(i => i.virts.some(v => isThrough(i, v)));
  const empty: SplitResult = { pieces: [], cols: 1, rows: 1, seams: [], issues, part: [], bounds: null, toolDia: 0, kind, kerfShift: 0, ok: false };
  const noOutline: IssueCode = kind === "laser" ? "noOutlineLaser" : kind === "plasma" ? "noOutlinePlasma" : "noOutline";
  if (!through.length) { issues.push({ code: noOutline, level: "error" }); return empty; }
  const rings = through.map(i => [i.ring!] as Polygon);
  const M: MultiPolygon = rings.length === 1 ? safe(() => polygonClipping.union(rings[0]), [rings[0]]) : safe(() => polygonClipping.xor(rings[0], ...rings.slice(1)), []);
  const bounds = boxOf(M);
  if (!bounds) { issues.push({ code: noOutline, level: "error" }); return empty; }
  // Fräser-Ø – bei Laser/Plasma der (größte) Schnittspalt der Umriss-Formen: er muss in jede Mulde passen
  const toolDia = beam
    ? Math.max(0, ...through.map(i => i.beam?.kerf || 0))
    : 2 * Math.max(0, ...through.flatMap(i => i.virts.filter(v => isThrough(i, v)).map(v => o.radiusOf(v))));
  // Laser fährt auf der Linie: jede Fugenkante um den halben Spalt weiter zeichnen. Plasma versetzt im G-Code selbst
  const shift = kind === "laser" ? toolDia / 2 : 0;
  if (kind === "laser" && !(toolDia > 0)) issues.push({ code: "kerf0", level: "warn" });
  // welcher Punkt gehört zu welcher Außen-/Innenkontur (für die Einstellungen der neuen Stück-Umrisse)
  const owner = new Map<string, Info>();
  for (const i of through) for (const q of i.ring!) owner.set(key(q[0], q[1]), i);
  const biggest = through.reduce((a, b) => (Math.abs(ringArea(b.ring!)) > Math.abs(ringArea(a.ring!)) ? b : a));

  // ---- Fugen: sortieren, prüfen, auslegen ----
  const all = setup.seams.map((seam, index) => ({ seam, index, profile: seamProfile(seam, toolDia, index, kind) }));
  const inside = all.filter(a => {
    const lo = a.seam.axis === "x" ? bounds.minX : bounds.minY, hi = a.seam.axis === "x" ? bounds.maxX : bounds.maxY;
    if (a.seam.pos > lo + 0.5 && a.seam.pos < hi - 0.5) return true;
    issues.push({ code: "outside", level: "warn", seam: a.index });
    return false;
  });
  for (const a of inside) issues.push(...a.profile.errors);
  const edge = Math.max(3, toolDia);
  const along = (ax: SeamAxis) => inside.filter(a => a.seam.axis === ax).sort((p, q) => p.seam.pos - q.seam.pos);
  const xs = along("x"), ys = along("y");
  // so weit reicht eine Fuge höchstens zur Seite: Verbindung plus Spiel (Laser: plus die weiter gezeichnete Kante)
  const band = (a: (typeof all)[number]) => (a.profile.errors.length ? 0 : a.profile.reach) + Math.max(a.profile.c, shift);
  for (const set of [xs, ys]) for (let k = 1; k < set.length; k++) {
    const need = band(set[k - 1]) + band(set[k]) + edge;
    if (set[k].seam.pos - set[k - 1].seam.pos < need) issues.push({ code: "close", level: "error", seam: set[k].index, v: Math.ceil(need) });
  }
  const BIG = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 2 + 1000;
  const layouts: SeamLayout[] = inside.map(a => {
    const cross = (a.seam.axis === "x" ? ys : xs).map(c => ({ at: c.seam.pos, reach: band(c) }));
    const feats = layoutSeam(a.seam, a.index, a.profile, M, cross, toolDia, issues);
    const knobsA = feats.some(f => f.kind === "knob" && f.dir < 0), knobsB = feats.some(f => f.kind === "knob" && f.dir > 0), runs = feats.some(f => f.kind === "run");
    const u0 = (a.seam.axis === "x" ? bounds.minY : bounds.minX) - 5, u1 = (a.seam.axis === "x" ? bounds.maxY : bounds.maxX) + 5;
    return {
      seam: a.seam, index: a.index, profile: a.profile, feats,
      reachA: runs || knobsA ? a.profile.reach : 0, reachB: runs || knobsB ? a.profile.reach : 0,
      line: seamPath(a.profile, feats, 0, u0, u1).map(([u, v]) => toWorld(a.seam, u, v)),
    };
  });
  const lay = (a: (typeof all)[number]) => layouts.find(l => l.index === a.index)!;
  // Ausschnitte, durch die eine Fuge läuft
  for (const l of layouts) {
    let n = 0;
    for (const poly of M) for (const h of poly.slice(1)) { const b = boxOfRing(h); if (l.seam.axis === "x" ? b.minX < l.seam.pos && b.maxX > l.seam.pos : b.minY < l.seam.pos && b.maxY > l.seam.pos) n++; }
    if (n) issues.push({ code: "hole", level: "warn", seam: l.index, n });
  }

  // ---- Seiten einer Fuge als Flächen: A = links/unten bis zur Linie − Spiel, B = rechts/oben ab Linie + Spiel ----
  // (Laser: Spiel − halber Spalt – ist das negativ, reicht jede Seite über die Linie und die Zeichnungen überlappen)
  const side = (l: SeamLayout, b: boolean): Polygon => {
    const dd = l.profile.c - shift, d = b ? dd : -dd, far = b ? BIG : -BIG;
    const u0 = (l.seam.axis === "x" ? bounds.minY : bounds.minX) - BIG, u1 = (l.seam.axis === "x" ? bounds.maxY : bounds.maxX) + BIG;
    const path = seamPath(l.profile, l.feats, d, u0, u1);
    const loop = [...path, [u1, far] as XY, [u0, far] as XY].map(([u, v]) => toWorld(l.seam, u, v));
    return [[...loop, loop[0]]];
  };
  const sides = new Map<number, { a: Polygon; b: Polygon }>();
  for (const l of layouts) sides.set(l.index, { a: side(l, false), b: side(l, true) });

  // ---- Zellen: Spalten von links, Reihen von oben ----
  const cols = xs.length + 1, rows = ys.length + 1;
  interface Cell { col: number; row: number; name: string; terr: MultiPolygon; core: Box; reg: MultiPolygon; outer: MultiPolygon; shapes: any[]; grown: Map<number, MultiPolygon> }
  const cells: Cell[] = [];
  const world = rect(bounds.minX - BIG, bounds.minY - BIG, bounds.maxX + BIG, bounds.maxY + BIG);
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const yi = ys.length - row; // Reihe 0 liegt oben: zwischen ys[yi−1] und dem oberen Rand bzw. ys[yi]
    const left = xs[col - 1], right = xs[col], below = ys[yi - 1], above = ys[yi];
    const parts: Polygon[] = [];
    if (left) parts.push(sides.get(left.index)!.b);
    if (right) parts.push(sides.get(right.index)!.a);
    if (below) parts.push(sides.get(below.index)!.b);
    if (above) parts.push(sides.get(above.index)!.a);
    const terr = parts.length ? inter([world], ...parts) : [world];
    // Kern: hier ragt sicher keine Verbindung hinein
    const core: Box = {
      minX: left ? left.seam.pos + lay(left).reachB + left.profile.c + 0.01 : -Infinity,
      maxX: right ? right.seam.pos - lay(right).reachA - right.profile.c - 0.01 : Infinity,
      minY: below ? below.seam.pos + lay(below).reachB + below.profile.c + 0.01 : -Infinity,
      maxY: above ? above.seam.pos - lay(above).reachA - above.profile.c - 0.01 : Infinity,
    };
    const reg = inter(M, terr);
    cells.push({ col, row, name: pieceName(col, row), terr, core, reg, outer: outerOnly(reg), shapes: [], grown: new Map() });
  }
  /** Stück um g mm gewachsen (ohne Löcher) – bis dahin reichen geteilte Bearbeitungen */
  const grownOf = (c: Cell, g: number): MultiPolygon => {
    const k = Math.round(g * 1000);
    let m = c.grown.get(k);
    if (!m) { m = g > 1e-6 ? outerOnly(safe(() => offsetArea(c.outer, g), c.outer)) : c.outer; c.grown.set(k, m); }
    return m;
  };

  // ---- jede Form: ganz in einer Zelle → unverändert mit; sonst teilen ----
  const inBox = (b: Box, c: Box) => b.minX >= c.minX && b.maxX <= c.maxX && b.minY >= c.minY && b.maxY <= c.maxY;
  const wholeIn = (i: Info, c: Cell): boolean => {
    if (!i.box) return false;
    const pointLike = i.virts.every(v => v.mode === "drill" || v.mode === "thread");
    let b = i.box, ring = i.ring!;
    if (pointLike) {
      // Bohrung/Gewinde: der Kreis des Lochs (mindestens der Bohrer) muss ganz im Stück liegen
      const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
      const r = Math.max((b.maxX - b.minX) / 2, (b.maxY - b.minY) / 2, ...i.virts.map(v => o.radiusOf(v))) + 0.5;
      b = { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
      ring = Array.from({ length: 24 }, (_, k) => [cx + r * Math.cos(k * Math.PI / 12), cy + r * Math.sin(k * Math.PI / 12)] as [number, number]);
    }
    if (inBox(b, c.core)) return true;
    const tb = boxOf(c.terr);
    if (!tb || !inBox(b, tb)) return false;
    if (i.closed || pointLike) return areaOf(diff([ring] as Polygon, c.terr)) < 1e-7;
    // offene Linie: alle Punkte in der Zelle und kein Abschnitt verlässt sie
    return ring.every(q => inArea(c.terr, q[0], q[1])) && clipLine(ring as XY[], c.terr).length === 1;
  };
  let cutFlutes = 0, lostDrill = 0, lostChamfer = 0, images = 0, imagesCut = 0, fillLines = 0, firstDrill: XY | null = null;
  const wholeRings: { box: Box; area: number }[][] = cells.map(() => []);
  const crossing: Info[] = [];
  const idMap = cells.map(() => new Map<string, string>());
  const copy = (s: any, ci: number) => {
    const k = cloneShape(s);
    k.id = newId();
    delete k.gen; delete k.parentChainId;
    if (k.groupId) { const m = idMap[ci]; if (!m.has(k.groupId)) m.set(k.groupId, "grp-" + newId()); k.groupId = m.get(k.groupId); }
    return k;
  };
  for (const i of info) {
    if (!i.ring) {
      // Bild oder unbekannte Art: ganz in die Zelle, in der die Mitte liegt
      let b: Box | null = null;
      try { b = shapeBounds(i.s); } catch { /* ohne Maße */ }
      if (!b) continue;
      const cx = (b.minX + b.maxX) / 2 / PX, cy = (b.minY + b.maxY) / 2 / PX;
      const ci = Math.max(0, cells.findIndex(c => inArea(c.terr, cx, cy)));
      const mb: Box = { minX: b.minX / PX, minY: b.minY / PX, maxX: b.maxX / PX, maxY: b.maxY / PX };
      if (i.s.type === "image" && !inBox(mb, cells[ci].core)) {
        // Laser: ein gerade liegendes Bild bekommt jedes Stück als Ausschnitt in seinem Rahmen (um Noppen herum wird
        // dabei auch etwas Abfall graviert). Gedrehte Bilder lassen sich so nicht schneiden und bleiben ganz
        const q = i.s.points;
        const straight = kind === "laser" && Array.isArray(q) && q.length === 4 && Math.abs(q[1].y - q[0].y) < 1e-6 && Math.abs(q[3].x - q[0].x) < 1e-6;
        if (straight) {
          let n = 0;
          cells.forEach((c, k) => {
            const cb = boxOf(c.outer);
            if (!cb) return;
            const crop: Box = { minX: Math.max(mb.minX, cb.minX), minY: Math.max(mb.minY, cb.minY), maxX: Math.min(mb.maxX, cb.maxX), maxY: Math.min(mb.maxY, cb.maxY) };
            if (crop.maxX - crop.minX < 0.2 || crop.maxY - crop.minY < 0.2) return;
            c.shapes.push(Object.assign(copy(i.s, k), { cropMm: crop }));
            n++;
          });
          if (n) { imagesCut++; continue; }
        }
        images++;
      }
      cells[ci].shapes.push(copy(i.s, ci));
      continue;
    }
    const ci = cells.findIndex(c => wholeIn(i, c));
    if (ci >= 0) {
      cells[ci].shapes.push(copy(i.s, ci));
      if (through.includes(i)) wholeRings[ci].push({ box: i.box!, area: Math.abs(ringArea(i.ring)) });
    } else crossing.push(i);
  }

  // ---- Umrisse der Stücke ----
  cells.forEach((c, ci) => {
    for (const poly of c.reg) {
      const gid = poly.length > 1 ? "grp-" + newId() : undefined;
      poly.forEach((r, ri) => {
        const rb = boxOfRing(r), ra = Math.abs(ringArea(r));
        // dieselbe Kontur ist schon unverändert im Stück (z. B. ein Loch, das keine Fuge berührt)
        if (wholeRings[ci].some(w => Math.abs(w.box.minX - rb.minX) < 1e-6 && Math.abs(w.box.maxX - rb.maxX) < 1e-6 && Math.abs(w.box.minY - rb.minY) < 1e-6 && Math.abs(w.box.maxY - rb.maxY) < 1e-6 && Math.abs(w.area - ra) < 1e-6 * Math.max(1, ra))) return;
        if (r.length < 4 || ra < 1e-4) return;
        // Einstellungen von der Kontur, von der die meisten Punkte stammen; Anfang an einem Punkt des Originals
        const votes = new Map<Info, number>();
        let start = -1;
        r.forEach((q, k) => { const w = owner.get(key(q[0], q[1])); if (w) { votes.set(w, (votes.get(w) || 0) + 1); if (start < 0 && k < r.length - 1) start = k; } });
        let like = biggest, best = 0;
        for (const [w, n] of votes) if (n > best) { best = n; like = w; }
        const v = like.virts.find(x => isThrough(like, x))!;
        const shape = createPolyline(ringPoints(r, Math.max(0, start)), true, ri === 0 ? "outside" : "inside", { ...carry(v, true), ...(gid ? { groupId: gid } : {}) });
        // Schneid-Richtung von Hand (im/gegen den Uhrzeigersinn) gilt weiter; ein Startpunkt von Hand passt nicht mehr
        if (beam && (like.s.cutDir === "cw" || like.s.cutDir === "ccw")) shape.cutDir = like.s.cutDir;
        // der Umriss eines Stücks ist nie die „Insel“ einer Tasche, die über das Stück hinausreicht (cam.ts)
        if (ri === 0) shape.noIsland = true;
        c.shapes.push(shape);
      });
    }
  });

  // ---- Formen über einer Fuge teilen ----
  const lostIslands: string[] = [];
  for (const i of crossing) {
    for (const v of i.virts) {
      if (isThrough(i, v)) continue; // steckt schon in den Umrissen
      if (v.mode === "drill" || v.mode === "thread") {
        lostDrill++;
        if (!firstDrill) firstDrill = [(i.box!.minX + i.box!.maxX) / 2, (i.box!.minY + i.box!.maxY) / 2];
        continue;
      }
      if (v.mode === "chamfer") { lostChamfer++; continue; }
      const r = beam ? 0 : Math.max(0, o.radiusOf(v));
      // Fläche (Tasche, V-Carve, flache Kontur) oder Linie (Gravur, offene Bahn)?
      const asArea = i.closed && v.mode !== "on-line";
      if (asArea && beam && i.beam?.line) fillLines++;
      // so weit reicht die Bearbeitung über das Stück hinaus: die Fräser-Mitte kommt einen Radius hinter die Fuge,
      // und keine Bahn läuft bündig an der Fugenkante entlang (flache Innen-Kontur deshalb 3 Radien, außen einer).
      // Die krummen Zugaben verhindern, dass die Hilfskante einer Insel genau auf der Fräserbahn-Grenze einer Tasche
      // liegt (Tasche: 2 Radien, Grenze der Fräser-Mitte also 1 Radius) – deckungsgleiche Kanten verschluckt pocket.ts
      const g = !asArea ? r : v.mode === "inside" ? 3 * r + 0.23 : v.mode === "outside" ? r + 0.37 : 2 * r;
      // Tasche: was ihre Inseln stehen lassen, zählt nicht – liegt ein Stück ganz in einer Insel, gibt es dort nichts zu fräsen
      let eff: MultiPolygon | null = null, lineIslands: Ring[] = [];
      if (v.mode === "pocket" && i.closed) {
        const isl = info.filter(q => q.closed && q !== i && isIsland(i.ring!, q.ring!));
        if (isl.length) eff = diff([i.ring!] as Polygon, ...isl.map(q => [q.ring!] as Polygon));
        // Inseln, die nur eine gravierte Kontur sind, werden an der Fuge zu offenen Linien und sind dann keine Insel mehr
        lineIslands = isl.filter(q => crossing.includes(q) && q.virts.every(x => x.mode === "on-line")).map(q => q.ring!);
      }
      for (const c of cells) {
        if (!c.reg.length) continue;
        const cb = boxOf(c.outer)!;
        if (apart(i.box!, cb, g + 0.01)) continue;
        const grown = grownOf(c, g);
        if (v.mode === "face") {
          // Planfräsen nimmt das umgebende Rechteck: auf den Platz des Stücks (plus Fräser-Ø) begrenzen
          const gb = boxOf(grown)!;
          const x0 = Math.max(i.box!.minX, gb.minX), x1 = Math.min(i.box!.maxX, gb.maxX), y0 = Math.max(i.box!.minY, gb.minY), y1 = Math.min(i.box!.maxY, gb.maxY);
          if (x1 - x0 > 0.05 && y1 - y0 > 0.05) c.shapes.push(createPolyline(ringPoints(rect(x0, y0, x1, y1)[0]), true, "face", carry(v, false)));
          continue;
        }
        if (asArea) {
          // nur, wenn die Form das Stück selbst berührt (nicht bloß den Streifen dahinter)
          if (areaOf(inter(eff ?? [[i.ring!]], c.outer)) < 1e-4) continue;
          for (const poly of inter([[i.ring!]], grown)) {
            const ring = poly[0];
            if (ring.length < 4 || Math.abs(ringArea(ring)) < 1e-4) continue;
            c.shapes.push(Object.assign(createPolyline(ringPoints(ring, startIndex(ring, i.ring!, c.outer)), true, v.out ?? v.mode, { ...carry(v, false), ...(v.extra ?? {}) }), { splitOf: i.s.id }));
          }
          if (lineIslands.some(q => areaOf(inter([[q]], c.outer)) > 1e-4) && !lostIslands.includes(c.name)) lostIslands.push(c.name);
        } else {
          const path = (i.closed ? [...i.ring!, i.ring![0]] : i.ring!) as XY[];
          const runs = clipLine(path, grown);
          // geschlossene Kontur: liegt der Anfang im Stück, gehören letztes und erstes Stück zusammen
          const same = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7;
          let loop = false;
          if (i.closed && runs.length && same(runs[0][0], path[0]) && same(runs[runs.length - 1][runs[runs.length - 1].length - 1], path[0])) {
            if (runs.length === 1) loop = true;
            else { const last = runs.pop()!; runs[0] = [...last, ...runs[0].slice(1)]; }
          }
          for (const run of runs) {
            if (!run.some(q => inArea(c.outer, q[0], q[1])) && !clipLine(run, c.outer).length) continue;
            const pts = (loop ? run.slice(0, -1) : run).map(q => ({ x: q[0] * PX, y: q[1] * PX }));
            // Flöte (fluting.ts): Ein-/Auslauf nur am Stück mit dem Anfang bzw. Ende der Linie; an der Fuge volle Tiefe
            const fl = !loop && !i.closed && v.mode === "on-line" && fluteFits(v.src) ? fluteSettings(v.src) : null;
            const part = fl ? { flute: true, fluteIn: same(run[0], path[0]) ? fl.in : 0, fluteOut: same(run[run.length - 1], path[path.length - 1]) ? fl.out : 0, fluteStart: fl.start, fluteEnd: fl.end, ...(fl.linear ? { fluteEase: "linear" } : {}) } : {};
            if (fl) cutFlutes++;
            c.shapes.push(createPolyline(pts, loop, v.out ?? v.mode, { ...carry(v, false), ...part }));
          }
        }
      }
    }
  }
  if (lostDrill) issues.push({ code: "drill", level: "warn", n: lostDrill, x: Math.round(firstDrill![0] * 10) / 10, y: Math.round(firstDrill![1] * 10) / 10 });
  if (lostChamfer) issues.push({ code: "chamfer", level: "warn", n: lostChamfer });
  if (cutFlutes) issues.push({ code: "flute", level: "warn", n: cutFlutes });
  if (images) issues.push({ code: "image", level: "warn", n: images });
  if (imagesCut) issues.push({ code: "imageCut", level: "warn", n: imagesCut });
  if (fillLines) issues.push({ code: "fillLine", level: "warn", n: fillLines });

  // ---- Inseln der Taschen: im Stück muss dieselbe Form Insel sein wie im Original ----
  const srcRing = new Map<string, Ring>();
  for (const i of info) if (i.closed) srcRing.set(i.s.id, i.ring!);
  for (const c of cells) {
    // (nur Fräse: Laser und Plasma kennen keine Taschen mit Inseln)
    const closed = beam ? [] : c.shapes.filter(s => s.type === "polyline" && s.closed && s.splitOf && srcRing.has(s.splitOf));
    let bad = false;
    for (const p of closed) {
      if (p.millingMode !== "pocket") continue;
      const pr = mmRing(p.points);
      for (const q of closed) {
        if (q === p || q.splitOf === p.splitOf) continue;
        const want = isIsland(srcRing.get(p.splitOf)!, srcRing.get(q.splitOf)!);
        const qr = mmRing(q.points);
        if (Math.abs(ringArea(qr)) >= Math.abs(ringArea(pr))) { if (want) bad = true; continue; }
        if (inRing(pr, qr[0][0], qr[0][1]) === want) continue;
        // anderen Anfangspunkt suchen, der zur Tasche so liegt wie im Original
        const k = qr.findIndex(pt => inRing(pr, pt[0], pt[1]) === want);
        if (k < 0) { bad = true; continue; }
        q.points = [...q.points.slice(k), ...q.points.slice(0, k)];
      }
    }
    if (bad || lostIslands.includes(c.name)) issues.push({ code: "island", level: "warn", piece: c.name });
    for (const s of c.shapes) delete s.splitOf;
  }

  // ---- Stücke: Platzbedarf, passt es aufs Bett, lose Reste ----
  const minPart = Math.max(5, 2 * toolDia);
  const pieces: Piece[] = [];
  for (const c of cells) {
    if (!c.shapes.length) continue;
    let ext: Box | null = null;
    for (const s of c.shapes) {
      let b: Box | null = null;
      try { b = shapeBounds(s); } catch { /* ohne Maße */ }
      if (!b) continue;
      // ein Bild, das noch zugeschnitten wird, braucht nur seinen Ausschnitt
      if (s.cropMm) b = { minX: s.cropMm.minX * PX, minY: s.cropMm.minY * PX, maxX: s.cropMm.maxX * PX, maxY: s.cropMm.maxY * PX };
      const mode = s.millingMode || "outside", rr = s.type === "image" ? 0 : Math.max(0, o.radiusOf({ mode, toolId: s.toolId, depth: Number(s.millingDepth) || 0 }));
      // Laser/Plasma: Platz für Anfahrbahn und halben Spalt statt für den Fräser, bei Bildern für den Überlauf der Zeilen
      const grow = beam ? Math.max(0, beamOf(s)?.margin || 0) : mode === "outside" ? 2 * rr : mode === "on-line" ? rr : 0;
      const e: Box = { minX: b.minX / PX - grow, minY: b.minY / PX - grow, maxX: b.maxX / PX + grow, maxY: b.maxY / PX + grow };
      ext = ext ? { minX: Math.min(ext.minX, e.minX), minY: Math.min(ext.minY, e.minY), maxX: Math.max(ext.maxX, e.maxX), maxY: Math.max(ext.maxY, e.maxY) } : e;
    }
    const w = ext ? ext.maxX - ext.minX : 0, h = ext ? ext.maxY - ext.minY : 0;
    const fits = w <= o.bed.w + 1e-6 && h <= o.bed.h + 1e-6;
    if (!fits) issues.push({ code: "noFit", level: "warn", piece: c.name, w: Math.ceil(w * 10) / 10, h: Math.ceil(h * 10) / 10 });
    if (c.reg.length > 1) issues.push({ code: "fragments", level: "warn", piece: c.name, n: c.reg.length });
    for (const poly of c.reg) {
      const b = boxOfRing(poly[0]);
      if (Math.min(b.maxX - b.minX, b.maxY - b.minY) < minPart) { issues.push({ code: "sliver", level: "warn", piece: c.name, w: Math.round((b.maxX - b.minX) * 10) / 10, h: Math.round((b.maxY - b.minY) * 10) / 10 }); break; }
    }
    pieces.push({ name: c.name, col: c.col, row: c.row, region: c.reg, shapes: c.shapes, extent: ext, fits });
  }
  if (clipErrors) issues.push({ code: "geometry", level: "error" });
  return { pieces, cols, rows, seams: layouts, issues, part: M, bounds, toolDia, kind, kerfShift: shift, ok: !issues.some(x => x.level === "error") };
}

/**
 * Anfangspunkt eines abgeschnittenen Rings: am liebsten ein Punkt der Original-Form, der im Stück liegt – dann sieht
 * cam.ts die Form genauso als Insel einer Tasche (oder nicht) wie im Original.
 */
function startIndex(ring: Ring, src: Ring, piece: MultiPolygon): number {
  const own = new Set(src.map(q => key(q[0], q[1])));
  const n = ring.length - 1;
  let any = -1;
  for (let k = 0; k < n; k++) {
    if (!own.has(key(ring[k][0], ring[k][1]))) continue;
    if (inArea(piece, ring[k][0], ring[k][1])) return k;
    if (any < 0) any = k;
  }
  return Math.max(0, any);
}

// =====================================================================
// HELFER FÜR DAS FENSTER
// =====================================================================

/**
 * Stück an die Bett-Ecke legen: sein Platzbedarf (mit Fräserbahn bzw. Anfahrbahn) beginnt bei 0 – ist noch Luft,
 * mit 1 mm Abstand. Verschiebt die Formen des Stücks (und den Ausschnitt eines noch nicht zugeschnittenen Bildes).
 */
export function placeAtCorner(p: Piece, bed: { w: number; h: number }): void {
  if (!p.extent) return;
  const w = p.extent.maxX - p.extent.minX, h = p.extent.maxY - p.extent.minY;
  const dx = -p.extent.minX + (w + 2 <= bed.w ? 1 : 0), dy = -p.extent.minY + (h + 2 <= bed.h ? 1 : 0);
  for (const s of p.shapes) {
    translateShape(s, dx * PX, dy * PX);
    if (s.cropMm) s.cropMm = { minX: s.cropMm.minX + dx, minY: s.cropMm.minY + dy, maxX: s.cropMm.maxX + dx, maxY: s.cropMm.maxY + dy };
  }
}

/** Fugen gleichmäßig: cols Spalten und rows Reihen über den Rahmen, Einstellungen wie `like` */
export function gridSeams(b: Box, cols: number, rows: number, like: Seam): Seam[] {
  const out: Seam[] = [];
  const c = Math.max(1, Math.min(MAX_SEAMS + 1, Math.round(cols))), r = Math.max(1, Math.min(MAX_SEAMS + 1, Math.round(rows)));
  for (let i = 1; i < c; i++) out.push({ ...like, axis: "x", pos: Math.round((b.minX + ((b.maxX - b.minX) * i) / c) * 100) / 100 });
  for (let j = 1; j < r; j++) out.push({ ...like, axis: "y", pos: Math.round((b.minY + ((b.maxY - b.minY) * j) / r) * 100) / 100 });
  return out;
}

/**
 * Kleinste gleichmäßige Aufteilung, bei der jedes Stück aufs Bett passt (null = geht auch mit MAX_SEAMS nicht).
 * Probiert wirklich: erst Spalten, dann Reihen dazu, bis kein Stück mehr zu groß ist.
 */
export function fitGrid(shapes: any[], like: Seam, o: SplitOptions): { cols: number; rows: number; seams: Seam[] } | null {
  const first = splitDrawing(shapes, { id: "fit", seams: [] }, o);
  if (!first.bounds) return null;
  const b = first.bounds, W = b.maxX - b.minX, H = b.maxY - b.minY;
  let cols = Math.max(1, Math.ceil(W / o.bed.w - 1e-9)), rows = Math.max(1, Math.ceil(H / o.bed.h - 1e-9));
  for (let tries = 0; tries < 2 * MAX_SEAMS; tries++) {
    if (cols > MAX_SEAMS + 1 || rows > MAX_SEAMS + 1) return null;
    const seams = gridSeams(b, cols, rows, like);
    const r = splitDrawing(shapes, { id: "fit", seams }, o);
    const bad = r.pieces.filter(p => !p.fits && p.extent);
    if (!bad.length) return { cols, rows, seams };
    // dort mehr teilen, wo ein Stück übersteht
    const wide = bad.some(p => p.extent!.maxX - p.extent!.minX > o.bed.w + 1e-6), high = bad.some(p => p.extent!.maxY - p.extent!.minY > o.bed.h + 1e-6);
    if (wide) cols++;
    if (high) rows++;
    if (!wide && !high) return null;
  }
  return null;
}

/** Fingerabdruck von Zeichnung und Fugen – ändert er sich, sind die erzeugten Stücke veraltet (Bilddaten zählen nicht) */
export function splitFingerprint(shapes: any[], setup: SplitSetup, toolInfo = ""): string {
  // die gewählten Schneid-Ebenen (Laser) zählen nur, wenn es welche gibt – ältere Fingerabdrücke bleiben gültig
  const what: any[] = [shapes, setup.seams, toolInfo];
  if (setup.cutLayers?.length) what.push(setup.cutLayers);
  const text = JSON.stringify(what, (k, v) => (k === "img" || k === "id" || k === "made" || k === "imp" ? undefined : typeof v === "number" ? Math.round(v * 1000) / 1000 : v));
  let h1 = 0x811c9dc5, h2 = 0x1b873593;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + text.length.toString(36);
}
