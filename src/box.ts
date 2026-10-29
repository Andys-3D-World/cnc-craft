/**
 * BOX-GENERATOR (wie boxes.py): Kiste mit Fingerzinken zum Lasern oder Fräsen
 *
 * Sechs (oder fünf, ohne Deckel) Platten: Boden, Deckel, vorne, hinten, links, rechts.
 * Jede Kante zwischen zwei Platten ist in eine ungerade Zahl Abschnitte geteilt; abwechselnd ragt die
 * eine oder die andere Platte bis an die Außenkante (Finger) – die andere ist dort um die Materialstärke
 * zurückgesetzt (Schlitz). Die Eck-Würfel (t × t × t) gehören immer der vorderen/hinteren Platte.
 *
 * Regeln (damit alles zusammenpasst):
 *   vorne/hinten  mit allen anderen: ungerade Abschnitte + die Ecken
 *   links/rechts  mit vorne/hinten: gerade Abschnitte; mit Boden/Deckel: ungerade
 *   Boden/Deckel  immer gerade Abschnitte
 * Kerf (Schnittspalt): jede Platte wird um kerf/2 nach außen versetzt → die Teile klemmen leicht.
 * Alle Maße in mm. Nur die Geometrie (Fenster: editor/boxGen.ts) – keine Abhängigkeiten zur Oberfläche (Tests: `npm test`).
 */
import { offsetPolygon } from "./polyOffset.ts";

export interface BoxOptions {
  w: number; d: number; h: number; // Breite (X), Tiefe (Y), Höhe (Z)
  inner: boolean;                  // Maße sind Innenmaße
  t: number;                       // Materialstärke
  finger: number;                  // gewünschte Fingerbreite
  lid: boolean;                    // mit Deckel (nur Art „closed“)
  kerf: number;                    // Schnittspalt (Laser ~0,1–0,2 mm)
  type?: BoxType;                  // Art der Box (Standard: closed)
  nx?: number;                     // Sortierkasten: Trennwände quer (parallel zur Front)
  ny?: number;                     // Sortierkasten: Trennwände längs (parallel zu den Seiten)
  overhang?: number;               // Schublade: so viel steht die Blende rundum über (mm)
  shelves?: number;                // Regal: Anzahl Regalbretter
  radius?: number;                 // runde Kiste: Eckenradius außen (mm)
  sides?: number;                  // Vieleck-Kiste: Anzahl Seiten (5 … 12)
}

/**
 * Arten (wie in boxes.py):
 *   closed  Kiste mit Deckel       open    offene Kiste
 *   tray    Sortierkasten (offen + Trennwände mit Zapfen in Schlitzen, an Kreuzungen halb eingeschnitten)
 *   handle  Tragekiste (offen + Grifflöcher links/rechts)
 *   drawer  Schublade (offen + größere Frontblende mit Griffloch)
 *   lidbox  Kiste mit Stülpdeckel (offen + Deckel aus zwei Platten: außen + innen als Führung)
 *   slide   Kiste mit Schiebedeckel (vorne niedriger; Leisten innen bilden die Führung für den Deckel)
 *   shelf   Regal (vorne offen, Regalbretter mit Zapfen in Schlitzen der Seitenwände)
 *   traylid Sortierkasten mit Stülpdeckel (Trennwände um eine Materialstärke niedriger)
 *   flex    Runde Kiste: Wand aus einem Streifen mit Biegescharnier (nur Laser), Boden und Ring oben mit Zapfen,
 *           Stoß hinten mit Puzzle-Verschluss, Stülpdeckel
 *   flexcup Runder Becher: wie flex, ohne Deckel (Stifte, Pinsel …)
 *   lantern Laterne / Teelichthaus: geschlossen, Fenster in allen vier Wänden, Abzugsloch im Deckel
 *   coin    Spardose: geschlossen, Münzschlitz im Deckel, rundes Loch im Boden mit Stopfen (zwei Scheiben)
 *   tissue  Taschentuchbox: geschlossen, langes Loch mit runden Enden im Deckel
 *   bird    Vogelhaus / Nistkasten: geschlossen, Einflugloch vorne oben, Lüftungs- und Abflusslöcher
 *   planter Pflanzkasten: offen, Abflusslöcher im Boden
 *   scoop   Karteikasten / Ablage: offen, halbrunde Griffmulde oben in der Front
 *   hex     Vieleck-Kiste (Sechseck …): Wände mit Zapfen in Schlitzen von Boden, innen stoßen die Wände aneinander;
 *           Stülpdeckel. Breite = Breite über die Flächen der Bodenplatte, die Tiefe ergibt sich daraus
 *   dice    Würfelturm: oben offen, drei schräge Rampen mit Zapfen in Schlitzen der Seitenwände, Ausgang unten vorne
 *   cabinet Schubladenschrank: Regal (vorne offen) + je Fach eine passende Schublade mit Blende
 */
export type BoxType = "closed" | "open" | "tray" | "traylid" | "handle" | "drawer" | "lidbox" | "slide" | "shelf" | "flex" | "flexcup" | "lantern" | "coin"
  | "tissue" | "bird" | "planter" | "scoop" | "hex" | "dice" | "cabinet";
export const BOX_TYPES: BoxType[] = ["closed", "open", "lidbox", "slide", "tray", "traylid", "handle", "drawer", "shelf", "flex", "flexcup",
  "lantern", "coin", "tissue", "bird", "planter", "scoop", "hex", "dice", "cabinet"];
/** Arten mit Deckel aus Fingerzinken (sechs Platten) */
export const LIDDED: BoxType[] = ["closed", "lantern", "coin", "tissue", "bird"];
export const isFlex = (ty?: BoxType) => ty === "flex" || ty === "flexcup";

export type PanelName = "bottom" | "top" | "front" | "back" | "left" | "right" | "divX" | "divY" | "blende" | "lidOuter" | "lidInner"
  | "slideLid" | "linerSide" | "linerBack" | "railSide" | "railBack" | "shelfBack" | "shelfEnd" | "shelf" | "flexWall" | "flexRing"
  | "plugOuter" | "plugInner" | "hexWall" | "ramp" | "drBottom" | "drEnd" | "drSide" | "drPlate";
/** holes: Ausschnitte in der Platte (Schlitze, Grifflöcher); lines: offene Schnitte (Biegescharnier) */
export interface Panel {
  name: PanelName; w: number; h: number; pts: { x: number; y: number }[]; holes?: { x: number; y: number }[][]; lines?: { x: number; y: number }[][];
  at?: Place;                                         // Lage in der fertigen Kiste (für die 3D-Ansicht)
  wrap?: { loop: { x: number; y: number }[]; z0: number; z1: number }; // gebogene Wand: Mittellinie (Draufsicht), Höhe
}

/**
 * Lage einer Platte in der fertigen Kiste: Punkt (x, y) der Platte in Tiefe s (0 … Materialstärke) liegt bei
 * o + u·x + v·y + n·s. Kiste: X = Breite, Y = Tiefe (0 = vorne), Z = Höhe (0 = unten).
 */
export type V3 = [number, number, number];
export interface Place { o: V3; u: V3; v: V3; n: V3 }
const EX: V3 = [1, 0, 0], EY: V3 = [0, 1, 0], EZ: V3 = [0, 0, 1];
const flat = (x: number, y: number, z: number): Place => ({ o: [x, y, z], u: EX, v: EY, n: EZ });       // liegend
const across = (x: number, y: number, z: number): Place => ({ o: [x, y, z], u: EX, v: EZ, n: EY });     // stehend, parallel zur Front
const along = (x: number, y: number, z: number): Place => ({ o: [x, y, z], u: EY, v: EZ, n: EX });      // stehend, parallel zur Seite
/** Lage mit einer Abbildung (Drehung/Spiegelung M, danach verschieben um T) umrechnen */
function movePlace(pl: Place, M: (v: V3) => V3, T: V3): Place {
  const o = M(pl.o);
  return { o: [o[0] + T[0], o[1] + T[1], o[2] + T[2]], u: M(pl.u), v: M(pl.v), n: M(pl.n) };
}

/** Außenmaße (W × D × H) aus den eingegebenen Maßen – je nach Art kommen die Wände anders dazu */
export function outerSize(o: BoxOptions): { W: number; D: number; H: number } {
  const t = Math.max(0.1, o.t), type = o.type || (o.lid ? "closed" : "open");
  if (type === "hex") return hexSize(o);
  if (!o.inner) return { W: o.w, D: o.d, H: o.h };
  if (type === "shelf" || type === "cabinet") return { W: o.w + 2 * t, D: o.d + t, H: o.h + 2 * t }; // vorne offen, Rückwand hinten
  return { W: o.w + 2 * t, D: o.d + 2 * t, H: o.h + (LIDDED.includes(type) ? 2 : 1) * t };
}

type Pt2 = { x: number; y: number };
const rect = (x0: number, y0: number, x1: number, y1: number): Pt2[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
/** Kreis als Vieleck (Mitte cx, cy) */
const circle = (cx: number, cy: number, r: number, n = 64): Pt2[] =>
  Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }));
/** Fenster mit Rundbogen oben (unten links x0,y0, Breite w, Höhe h) */
function archWindow(x0: number, y0: number, w: number, h: number): Pt2[] {
  const r = Math.min(w / 2, h / 2), pts: Pt2[] = [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }];
  for (let i = 0; i <= 16; i++) { const a = (Math.PI * i) / 16; pts.push({ x: x0 + w / 2 + (w / 2) * Math.cos(a), y: y0 + h - r + r * Math.sin(a) }); }
  return pts;
}
/** Langloch (Griff) mit runden Enden, Mitte (cx, cy) */
function slot(cx: number, cy: number, len: number, hgt: number): Pt2[] {
  const r = hgt / 2, a = len / 2 - r, pts: Pt2[] = [];
  for (let i = 0; i <= 16; i++) { const t = -Math.PI / 2 + (Math.PI * i) / 16; pts.push({ x: cx + a + r * Math.cos(t), y: cy + r * Math.sin(t) }); }
  for (let i = 0; i <= 16; i++) { const t = Math.PI / 2 + (Math.PI * i) / 16; pts.push({ x: cx - a + r * Math.cos(t), y: cy + r * Math.sin(t) }); }
  return pts;
}

type Seg = { a: number; b: number; out: boolean };

/** Abschnitte einer Kante (Länge L): Ecken [0,t] und [L-t,L] gehören `corner`; dazwischen k ungerade Teile */
function profile(L: number, t: number, finger: number, corner: boolean, odd: boolean, fingers = true): Seg[] {
  const segs: Seg[] = [];
  const Li = L - 2 * t;
  if (Li <= 0) return [{ a: 0, b: L, out: corner }];
  segs.push({ a: 0, b: t, out: corner });
  if (!fingers) segs.push({ a: t, b: L - t, out: true });
  else {
    let k = Math.max(1, 2 * Math.floor(Li / Math.max(0.1, finger) / 2) + 1);
    if (k < 3 && Li >= 3 * Math.max(0.5, t)) k = 3;
    const s = Li / k;
    for (let i = 0; i < k; i++) segs.push({ a: t + i * s, b: t + (i + 1) * s, out: (i % 2 === 1) === odd });
  }
  segs.push({ a: L - t, b: L, out: corner });
  return merge(segs);
}

/**
 * Umriss einer Platte W × H aus vier Kanten-Profilen (Achse aufsteigend): unten/oben entlang x, links/rechts entlang y.
 * „out“ = auf der Außenlinie, sonst um t nach innen.
 */
function outline(W: number, H: number, t: number, bottom: Seg[], right: Seg[], top: Seg[], left: Seg[]) {
  const pts: { x: number; y: number }[] = [];
  const add = (x: number, y: number) => {
    const l = pts[pts.length - 1];
    if (!l || Math.abs(l.x - x) > 1e-9 || Math.abs(l.y - y) > 1e-9) pts.push({ x, y });
  };
  // An einer Ecke beginnt eine Kante dort, wo die Nachbarkante liegt (Ecke frei → um t eingerückt)
  const dep = (g: Seg) => (g.out ? 0 : t);
  const clip = (segs: Seg[], lo: number, hi: number) =>
    segs.map(g => ({ ...g, a: Math.max(g.a, lo), b: Math.min(g.b, hi) })).filter(g => g.b - g.a > 1e-9);
  const B = clip(bottom, dep(left[0]), W - dep(right[0]));
  const R = clip(right, dep(bottom[bottom.length - 1]), H - dep(top[top.length - 1]));
  const T = clip(top, dep(left[left.length - 1]), W - dep(right[right.length - 1]));
  const Lf = clip(left, dep(bottom[0]), H - dep(top[0]));
  // feste Eckpunkte: (0,0) wenn der Platte die Ecke gehört, sonst (t,t) – sonst würde die Ecke schräg abgeschnitten
  add(dep(left[0]), dep(bottom[0]));
  for (const g of B) { const y = g.out ? 0 : t; add(g.a, y); add(g.b, y); }
  add(W - dep(right[0]), dep(bottom[bottom.length - 1]));
  for (const g of R) { const x = g.out ? W : W - t; add(x, g.a); add(x, g.b); }
  add(W - dep(right[right.length - 1]), H - dep(top[top.length - 1]));
  for (const g of [...T].reverse()) { const y = g.out ? H : H - t; add(g.b, y); add(g.a, y); }
  add(dep(left[left.length - 1]), H - dep(top[0]));
  for (const g of [...Lf].reverse()) { const x = g.out ? 0 : t; add(x, g.b); add(x, g.a); }
  // erster == letzter Punkt? weg damit; dann Punkte auf einer Geraden entfernen
  if (pts.length > 1 && Math.abs(pts[0].x - pts[pts.length - 1].x) < 1e-9 && Math.abs(pts[0].y - pts[pts.length - 1].y) < 1e-9) pts.pop();
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length], p = pts[i], b = pts[(i + 1) % pts.length];
    const cross = (p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x);
    if (Math.abs(cross) > 1e-9) out.push(p);
  }
  return out;
}

export function boxPanels(o: BoxOptions): Panel[] {
  const panels = rawPanels(o);
  // Schnittspalt: Umriss um kerf/2 nach außen, Löcher um kerf/2 nach innen (enger); offene Schnitte bleiben
  if (o.kerf > 0) for (const p of panels) {
    const loops = offsetPolygon(p.pts, o.kerf / 2, 0.005);
    if (loops.length) p.pts = loops[0];
    if (p.holes) p.holes = p.holes.map(hl => offsetPolygon(hl, -o.kerf / 2, 0.005)[0]).filter(Boolean);
  }
  return panels;
}

/** Zusammenhängende Abschnitte gleicher Art zusammenfassen */
function merge(segs: Seg[]): Seg[] {
  const m: Seg[] = [];
  for (const g of segs) { const last = m[m.length - 1]; if (last && last.out === g.out) last.b = g.b; else m.push({ ...g }); }
  return m;
}

function rawPanels(o: BoxOptions): Panel[] {
  const type: BoxType = o.type && BOX_TYPES.includes(o.type) ? o.type : (o.lid ? "closed" : "open");
  if (isFlex(type)) return flexPanels({ ...o, type });
  if (type === "hex") return hexPanels(o);
  if (type === "cabinet") return cabinetPanels(o);
  if (type === "shelf") {
    // Regal = Sortierkasten auf den Rücken gelegt: Boden → Rückwand, vorne/hinten → Boden/Oberseite,
    // Quer-Trennwände → Regalbretter (die offene Seite zeigt nach vorne)
    const { W, D, H } = outerSize(o);
    const rename: Partial<Record<PanelName, PanelName>> = { bottom: "shelfBack", front: "shelfEnd", back: "shelfEnd", divX: "shelf" };
    // Lage: Boden des Sortierkastens (z = 0) wird zur Rückwand (y = D), seine Tiefe zur Höhe
    const M = (v: V3): V3 => [v[0], -v[2], v[1]];
    return rawPanels({ ...o, inner: false, w: W, d: H, h: D, type: "tray", nx: o.shelves ?? 2, ny: 0 })
      .map(p => ({ ...p, name: rename[p.name] || p.name, at: p.at && movePlace(p.at, M, [0, D, 0]) }));
  }
  const lid = LIDDED.includes(type);
  const t = Math.max(0.1, o.t);
  const { W, D, H } = outerSize({ ...o, type });
  const f = Math.max(t, o.finger);
  const P = (L: number, corner: boolean, odd: boolean, fingers = true) => profile(L, t, f, corner, odd, fingers);
  const panels: Panel[] = [];
  const get = (n: PanelName) => panels.find(p => p.name === n)!;
  // Boden/Deckel (W × D): Ecken frei, gerade Abschnitte
  const bt = (name: "bottom" | "top") => panels.push({ name, w: W, h: D, pts: outline(W, D, t, P(W, false, false), P(D, false, false), P(W, false, false), P(D, false, false)) });
  bt("bottom");
  if (lid) bt("top");
  // vorne/hinten (W × H): Ecken + ungerade überall; oben ohne Deckel glatt
  // Schiebedeckel: die Front ist niedriger (Hf), darüber schiebt man den Deckel ein; Leisten innen (2 t hoch) halten ihn
  const slide = type === "slide", c = 0.3;
  const Hf = slide ? H - 3 * t - c : H;
  const fb = (name: "front" | "back", h: number) => panels.push({ name, w: W, h, pts: outline(W, h, t, P(W, true, true), P(h, true, true), lid ? P(W, true, true) : [{ a: 0, b: W, out: true }], P(h, true, true)) });
  fb("front", Hf); fb("back", H);
  // links/rechts (D × H): Ecken frei; mit Boden/Deckel ungerade, mit vorne/hinten gerade
  // (beim Schiebedeckel ist die Kante zur Front nur bis Hf verzinkt, darüber glatt)
  const frontEdge = slide ? merge([...P(Hf, false, false), { a: Hf, b: H, out: true }]) : P(H, false, false);
  // (oben vorne gehört die Ecke dann der Seitenwand, die Front reicht nicht hinauf)
  const topEdge = slide ? merge([{ a: 0, b: t, out: true }, ...P(D, false, true, false).slice(1)]) : P(D, false, true, lid);
  const lr = (name: "left" | "right") => panels.push({ name, w: D, h: H, pts: outline(D, H, t, P(D, false, true), P(H, false, false), topEdge, frontEdge) });
  lr("left"); lr("right");
  get("bottom").at = flat(0, 0, 0);
  if (lid) get("top").at = flat(0, 0, H - t);
  get("front").at = across(0, 0, 0); get("back").at = across(0, D - t, 0);
  get("left").at = along(0, 0, 0); get("right").at = along(W - t, 0, 0);

  const Wi = W - 2 * t, Di = D - 2 * t, Hi = H - t; // Innenmaße (offene Box)
  if (type === "tray" || type === "traylid") {
    // Trennwände stehen auf dem Boden (Höhe = Innenhöhe); Zapfen (t lang) stecken in Schlitzen der Außenwände.
    // Quer-Wände (divX, parallel zur Front) von oben, Längs-Wände (divY) von unten halb eingeschnitten → stecken ineinander
    const nx = Math.max(0, Math.min(20, Math.round(o.nx ?? 1))), ny = Math.max(0, Math.min(20, Math.round(o.ny ?? 1)));
    // mit Stülpdeckel: Trennwände eine Materialstärke niedriger, sonst stößt der Deckel innen an
    const Hd = type === "traylid" ? Hi - t : Hi;
    const tabH = Math.max(t, Hd / 3);
    const tb = (Hd - tabH) / 2, te = tb + tabH;   // Zapfen relativ zur Unterkante der Trennwand
    const xs = Array.from({ length: ny }, (_, i) => (Wi * (i + 1)) / (ny + 1)); // Längs-Wände: Abstand von der linken Innenseite
    const ys = Array.from({ length: nx }, (_, i) => (Di * (i + 1)) / (nx + 1)); // Quer-Wände: Abstand von der vorderen Innenseite
    // Schlitze in den Außenwänden (Wand-Koordinaten: + t Wanddicke; die Trennwand steht auf dem Boden bei t)
    for (const n of ["left", "right"] as const) get(n).holes = ys.map(y => rect(t + y - t / 2, t + tb, t + y + t / 2, t + te));
    for (const n of ["front", "back"] as const) get(n).holes = xs.map(x => rect(t + x - t / 2, t + tb, t + x + t / 2, t + te));
    /** Trennwand: Innenlänge L, Zapfen links/rechts; Einschnitte (Breite t, halbe Höhe) an den Stellen cuts */
    const divider = (L: number, cuts: number[], fromTop: boolean, name: "divX" | "divY"): Panel => {
      const pts: Pt2[] = [{ x: t, y: 0 }];
      if (!fromTop) for (const c of cuts) pts.push({ x: t + c - t / 2, y: 0 }, { x: t + c - t / 2, y: Hd / 2 }, { x: t + c + t / 2, y: Hd / 2 }, { x: t + c + t / 2, y: 0 });
      pts.push({ x: L + t, y: 0 }, { x: L + t, y: tb }, { x: L + 2 * t, y: tb }, { x: L + 2 * t, y: te }, { x: L + t, y: te }, { x: L + t, y: Hd });
      if (fromTop) for (const c of [...cuts].reverse()) pts.push({ x: t + c + t / 2, y: Hd }, { x: t + c + t / 2, y: Hd / 2 }, { x: t + c - t / 2, y: Hd / 2 }, { x: t + c - t / 2, y: Hd });
      pts.push({ x: t, y: Hd }, { x: t, y: te }, { x: 0, y: te }, { x: 0, y: tb }, { x: t, y: tb });
      return { name, w: L + 2 * t, h: Hd, pts };
    };
    for (let i = 0; i < nx; i++) panels.push({ ...divider(Wi, xs, true, "divX"), at: across(0, t + ys[i] - t / 2, t) });
    for (let i = 0; i < ny; i++) panels.push({ ...divider(Di, ys, false, "divY"), at: along(t + xs[i] - t / 2, 0, t) });
  }
  if (type === "handle") {
    // Grifflöcher in links/rechts, oben mittig
    const len = Math.min(D * 0.5, 100), hg = Math.min(30, H * 0.25);
    if (len > hg * 1.5 && H > hg + 3 * t + 10) for (const n of ["left", "right"] as const) get(n).holes = [slot(D / 2, H - 8 - hg / 2, len, hg)];
  }
  if (type === "drawer") {
    // Blende: rundum `overhang` größer als die Front (unten bündig, oben + overhang), mit Griffloch
    const ov = Math.max(0, o.overhang ?? 5), bw = W + 2 * ov, bh = H + ov;
    const hl = Math.min(bw * 0.35, 90), hh = Math.min(25, bh * 0.25);
    panels.push({ name: "blende", w: bw, h: bh, pts: rect(0, 0, bw, bh), holes: hl > hh * 1.5 ? [slot(bw / 2, bh * 0.6, hl, hh)] : [], at: across(-ov, -t, 0) });
  }
  if (slide) {
    // Innen: unten Futter-Leisten bis Hf (darauf liegt der Deckel), oben Halte-Leisten (2 t hoch) mit Luft c darunter
    const lh = Hf - t, bw = Wi - 2 * t;
    if (lh > 0.5) {
      panels.push({ name: "linerSide", w: Di, h: lh, pts: rect(0, 0, Di, lh), at: along(t, t, t) }, { name: "linerSide", w: Di, h: lh, pts: rect(0, 0, Di, lh), at: along(W - 2 * t, t, t) });
      panels.push({ name: "linerBack", w: bw, h: lh, pts: rect(0, 0, bw, lh), at: across(2 * t, D - 2 * t, t) });
    }
    panels.push({ name: "railSide", w: Di, h: 2 * t, pts: rect(0, 0, Di, 2 * t), at: along(t, t, H - 2 * t) }, { name: "railSide", w: Di, h: 2 * t, pts: rect(0, 0, Di, 2 * t), at: along(W - 2 * t, t, H - 2 * t) });
    panels.push({ name: "railBack", w: bw, h: 2 * t, pts: rect(0, 0, bw, 2 * t), at: across(2 * t, D - 2 * t, H - 2 * t) });
    // Deckel: so breit wie innen (minus Luft), von der Vorderkante bis an die Rückwand; Griffmulde vorne
    const lw = Wi - 2 * c, ld = D - t - c;
    const gl = Math.min(lw * 0.4, 50), gh = Math.min(10, ld * 0.15);
    panels.push({ name: "slideLid", w: lw, h: ld, pts: rect(0, 0, lw, ld), holes: gl > gh * 1.5 ? [slot(lw / 2, 6 + gh / 2, gl, gh)] : [], at: flat(t + c, 0, Hf) });
  }
  if (type === "lantern") {
    // Fenster mit Rundbogen in allen vier Wänden (Rand frei für die Zinken), Abzugsloch im Deckel
    const m = Math.max(8, 3 * t + 4);
    for (const n of ["front", "back", "left", "right"] as const) {
      const p = get(n), ww = p.w - 2 * m, wh = p.h - 2 * m;
      if (ww > 8 && wh > 8) p.holes = [archWindow(m, m, ww, wh)];
    }
    const top = get("top"), vr = Math.min(top.w, top.h) * 0.15;
    if (vr > 4) top.holes = [circle(top.w / 2, top.h / 2, vr)];
  }
  if (type === "coin") {
    // Münzschlitz im Deckel (passt bis 2-€-Münze), Loch im Boden mit Stopfen aus zwei Scheiben (innen 0,2 mm kleiner)
    const top = get("top"), bot = get("bottom");
    const sl = Math.min(32, top.w - 4 * t), sh = 4;
    if (sl > 2 * sh) top.holes = [slot(top.w / 2, top.h / 2, sl, sh)];
    const hr = Math.min(25, (Math.min(bot.w, bot.h) - 4 * t) / 2 - 2);
    if (hr > 6) {
      bot.holes = [circle(bot.w / 2, bot.h / 2, hr)];
      panels.push({ name: "plugOuter", w: 2 * hr + 10, h: 2 * hr + 10, pts: circle(hr + 5, hr + 5, hr + 5), at: flat(W / 2 - hr - 5, D / 2 - hr - 5, -t) });
      panels.push({ name: "plugInner", w: 2 * hr, h: 2 * hr, pts: circle(hr, hr, hr - 0.2), at: flat(W / 2 - hr, D / 2 - hr, 0) });
    }
  }
  if (type === "tissue") {
    // Entnahme-Loch im Deckel: Langloch mit runden Enden (Standard-Box ca. 120 × 25 mm)
    const top = get("top"), sl = Math.min(140, top.w * 0.6), sh = Math.min(30, top.h * 0.3);
    if (sl > sh * 1.5 && sh > 5) top.holes = [slot(top.w / 2, top.h / 2, sl, sh)];
  }
  if (type === "bird") {
    // Einflugloch (Meise: 32 mm) vorne im oberen Drittel, kleine Lüftungslöcher oben in den Seiten, Abfluss im Boden
    const fr = get("front"), r = Math.min(16, (fr.w - 6 * t) / 2 - 2, (fr.h - 6 * t) / 4);
    if (r > 5) fr.holes = [circle(fr.w / 2, Math.min(fr.h * 0.65, fr.h - 3 * t - r - 4), r)];
    for (const n of ["left", "right"] as const) { const p = get(n); if (p.h > 8 * t + 20) p.holes = [circle(p.w / 2, p.h - 3 * t - 6, 3, 24)]; }
    const bot = get("bottom"), m = 3 * t + 6;
    if (bot.w > 2 * m + 10 && bot.h > 2 * m + 10) bot.holes = [[m, m], [bot.w - m, m], [bot.w - m, bot.h - m], [m, bot.h - m]].map(([x, y]) => circle(x, y, 2.5, 24));
  }
  if (type === "planter") {
    // Abflusslöcher (Ø 6 mm) im Raster von etwa 30 mm, mit Abstand zu den Zinken
    const bot = get("bottom"), m = 3 * t + 6, aw = bot.w - 2 * m, ah = bot.h - 2 * m;
    if (aw > 0 && ah > 0) {
      const nx = Math.max(1, Math.round(aw / 30) + 1), ny = Math.max(1, Math.round(ah / 30) + 1), holes: Pt2[][] = [];
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++)
        holes.push(circle(nx > 1 ? m + (aw * i) / (nx - 1) : bot.w / 2, ny > 1 ? m + (ah * j) / (ny - 1) : bot.h / 2, 3, 24));
      bot.holes = holes;
    }
  }
  if (type === "scoop") {
    // Griffmulde: Halbkreis oben in der Front (die Oberkante läuft von rechts nach links)
    const fr = get("front"), r = Math.min(25, fr.w * 0.2, (fr.h - 2 * t) * 0.5);
    const i = fr.pts.findIndex((q, k) => Math.abs(q.y - fr.h) < 1e-9 && Math.abs(fr.pts[(k + 1) % fr.pts.length].y - fr.h) < 1e-9);
    if (r > 4 && i >= 0) {
      const notch: Pt2[] = [];
      for (let k = 0; k <= 24; k++) { const a = (Math.PI * k) / 24; notch.push({ x: fr.w / 2 + r * Math.cos(a), y: fr.h - r * Math.sin(a) }); }
      fr.pts.splice(i + 1, 0, ...notch);
    }
  }
  if (type === "dice") panels.push(...diceRamps(get("front"), get("left"), get("right"), t, f));
  if (type === "lidbox" || type === "traylid") {
    // Stülpdeckel: außen W × D, innen passend in die Öffnung (0,2 mm Luft je Seite) – beide aufeinander kleben
    const c = 0.2;
    panels.push({ name: "lidOuter", w: W, h: D, pts: rect(0, 0, W, D), at: flat(0, 0, H) });
    panels.push({ name: "lidInner", w: Wi - 2 * c, h: Di - 2 * c, pts: rect(0, 0, Wi - 2 * c, Di - 2 * c), at: flat(t + c, t + c, H - t) });
  }
  return panels;
}

/** Zapfen auf einer geraden Strecke der Länge L: ungerade Teilung, jeder zweite Abschnitt ist ein Zapfen */
function tabsOn(L: number, t: number, finger: number): [number, number][] {
  if (L < 3 * t) return [];
  let k = Math.max(1, 2 * Math.floor(L / Math.max(0.5, finger) / 2) + 1);
  if (k < 3) k = 3;
  const s = L / k, out: [number, number][] = [];
  for (let i = 1; i < k; i += 2) out.push([i * s, (i + 1) * s]);
  return out;
}

/**
 * Abgerundetes Rechteck (x0,y0)–(x1,y1) mit Radius rad, gegen den Uhrzeigersinn ab vorne links.
 * bump: auf den geraden Seiten stehen Zapfen (Tiefe d) nach außen.
 */
function roundRect(x0: number, y0: number, x1: number, y1: number, rad: number, bump?: { t: number; finger: number; d: number }): Pt2[] {
  rad = Math.max(0, Math.min(rad, (x1 - x0) / 2, (y1 - y0) / 2));
  const Lw = x1 - x0 - 2 * rad, Ld = y1 - y0 - 2 * rad;
  const sides = [
    { p: { x: x0 + rad, y: y0 }, u: { x: 1, y: 0 }, n: { x: 0, y: -1 }, L: Lw, c: { x: x1 - rad, y: y0 + rad }, a0: -90 },
    { p: { x: x1, y: y0 + rad }, u: { x: 0, y: 1 }, n: { x: 1, y: 0 }, L: Ld, c: { x: x1 - rad, y: y1 - rad }, a0: 0 },
    { p: { x: x1 - rad, y: y1 }, u: { x: -1, y: 0 }, n: { x: 0, y: 1 }, L: Lw, c: { x: x0 + rad, y: y1 - rad }, a0: 90 },
    { p: { x: x0, y: y1 - rad }, u: { x: 0, y: -1 }, n: { x: -1, y: 0 }, L: Ld, c: { x: x0 + rad, y: y0 + rad }, a0: 180 }
  ];
  const pts: Pt2[] = [];
  const at = (sd: typeof sides[0], s: number, out = 0) => ({ x: sd.p.x + sd.u.x * s + sd.n.x * out, y: sd.p.y + sd.u.y * s + sd.n.y * out });
  for (const sd of sides) {
    pts.push(at(sd, 0));
    if (bump) for (const [a, b] of tabsOn(sd.L, bump.t, bump.finger)) pts.push(at(sd, a), at(sd, a, bump.d), at(sd, b, bump.d), at(sd, b));
    if (rad > 0.01) for (let i = 0; i < 12; i++) {
      const a = ((sd.a0 + (90 * i) / 12) * Math.PI) / 180;
      pts.push({ x: sd.c.x + rad * Math.cos(a), y: sd.c.y + rad * Math.sin(a) });
    }
  }
  // doppelte Punkte (Radius 0) entfernen
  return pts.filter((q, i) => { const n = pts[(i + 1) % pts.length]; return Math.hypot(q.x - n.x, q.y - n.y) > 1e-6; });
}

/**
 * Runde Kiste / runder Becher: Boden und Ring oben mit Zapfen auf den geraden Seiten, die Wand ist EIN Streifen
 * drumherum. In den Rundungen hat der Streifen ein Biegescharnier (viele versetzte Schnitte) – nur mit dem Laser.
 * Zusammenbau: Streifen um den Boden legen (Zapfen in die Aussparungen unten), Ring oben aufstecken – dann hält
 * die Form von selbst. Der Stoß liegt mitten auf der längeren geraden Seite hinten und hat einen Puzzle-Verschluss
 * (Schwalbenschwanz-Nasen greifen in passende Aussparungen); ein Tropfen Leim genügt.
 * Kiste (flex): Stülpdeckel aus zwei Platten, die kleine passt in die Öffnung des Rings.
 */
function flexPanels(o: BoxOptions): Panel[] {
  const t = Math.max(0.1, o.t), f = Math.max(t, o.finger), c = 0.2;
  const { W, D, H } = outerSize({ ...o, type: "flex" });
  const r = Math.max(t + 1, Math.min(o.radius ?? 15, W / 2, D / 2));
  const Lw = W - 2 * r, Ld = D - 2 * r;
  const arc = (Math.PI / 2) * (r - t / 2);              // Länge der Rundung in der Wandmitte
  const rw = Math.max(6, 2 * t + 2);                     // Breite des Rings oben
  const panels: Panel[] = [];
  // Boden + Ring: liegen innerhalb der Wand, Zapfen gehen durch die Wand bis außen
  const plate = () => roundRect(t, t, W - t, D - t, r - t, { t, finger: f, d: t });
  panels.push({ name: "bottom", w: W, h: D, pts: plate(), at: flat(0, 0, 0) });
  const hole = roundRect(t + rw, t + rw, W - t - rw, D - t - rw, Math.max(0.5, r - t - rw));
  panels.push({ name: "flexRing", w: W, h: D, pts: plate(), holes: [hole], at: flat(0, 0, H - t) });

  // Stoß mitten auf der längeren geraden Seite (hinten bzw. links); Reihenfolge wie roundRect: vorne, rechts, hinten, links
  const straight = [Lw, Ld, Lw, Ld];
  const seamSide = Lw >= Ld ? 2 : 3;
  const order = [seamSide, (seamSide + 1) % 4, (seamSide + 2) % 4, (seamSide + 3) % 4, seamSide];
  type Sec = { L: number; bend: boolean; tabs: [number, number][] };
  const secs: Sec[] = [];
  // Stoß in die Mitte einer Lücke zwischen zwei Zapfen, die der Seitenmitte am nächsten ist (nie durch eine Aussparung)
  const Ls = straight[seamSide], tabsS = tabsOn(Ls, t, f);
  let sp = Ls / 2;
  if (tabsS.length) {
    const gaps: number[] = [tabsS[0][0] / 2];
    for (let i = 0; i < tabsS.length; i++) gaps.push(((tabsS[i][1]) + (i + 1 < tabsS.length ? tabsS[i + 1][0] : Ls)) / 2);
    sp = gaps.reduce((best, x) => (Math.abs(x - Ls / 2) < Math.abs(best - Ls / 2) ? x : best));
  }
  order.forEach((side, i) => {
    const L = straight[side];
    const all = tabsOn(L, t, f);
    // Stoß-Seite: erst das Stück ab dem Stoß, am Ende das Stück bis zum Stoß
    if (i === 0) secs.push({ L: L - sp, bend: false, tabs: all.filter(([a2]) => a2 > sp).map(([a2, b2]) => [a2 - sp, b2 - sp]) });
    else if (i === 4) secs.push({ L: sp, bend: false, tabs: all.filter(([, b2]) => b2 < sp) });
    else secs.push({ L, bend: false, tabs: all });
    if (i < 4) secs.push({ L: arc, bend: true, tabs: [] });
  });
  const len = secs.reduce((n, q) => n + q.L, 0);

  const lines: Pt2[][] = [];
  const g = Math.max(2, t);                               // Stege zwischen den Schnitten
  const step = Math.min(2.5, Math.max(1, t * 0.5));       // Abstand der Schnitt-Reihen
  const cut = (x: number, y0: number, y1: number) => { if (y1 - y0 > 1) lines.push([{ x, y: y0 }, { x, y: y1 }]); };
  const notches: [number, number][] = [];                 // Aussparungen unten und oben (für die Zapfen)
  let s0 = 0;
  for (const sec of secs) {
    if (!sec.bend) for (const [a2, b2] of sec.tabs) notches.push([s0 + a2, s0 + b2]);
    else {
      // Biegescharnier etwas breiter als die Rundung (t je Seite, nicht über die Nachbar-Abschnitte hinaus);
      // abwechselnd Reihe A (2 Schnitte) und B (3 Schnitte, versetzt, bis an die Kanten)
      const m = Math.min(t, s0, len - s0 - sec.L), from = s0 - m, span = sec.L + 2 * m;
      const n = Math.max(2, Math.round(span / step));
      for (let j = 0; j < n; j++) {
        const x = from + ((j + 0.5) * span) / n;
        if (j % 2 === 0) { cut(x, g, H / 2 - g / 2); cut(x, H / 2 + g / 2, H - g); }
        else { cut(x, 0, H / 4 - g / 2); cut(x, H / 4 + g / 2, (3 * H) / 4 - g / 2); cut(x, (3 * H) / 4 + g / 2, H); }
      }
    }
    s0 += sec.L;
  }

  // Puzzle-Verschluss: Nasen am Ende (x = len) greifen in Aussparungen am Anfang (x = 0)
  const kd = Math.max(4, 2 * t), hw = kd * 1.3, nw = kd * 0.75;
  const free = H - 2 * t - 4;
  const nK = Math.max(1, Math.min(4, Math.floor(free / (2.6 * hw))));
  const knobs = Array.from({ length: nK }, (_, i) => t + 2 + (free * (i + 0.5)) / nK);

  const pts: Pt2[] = [{ x: 0, y: 0 }];
  for (const [a2, b2] of notches) pts.push({ x: a2, y: 0 }, { x: a2, y: t }, { x: b2, y: t }, { x: b2, y: 0 });
  pts.push({ x: len, y: 0 });
  for (const yc of knobs) pts.push({ x: len, y: yc - nw / 2 }, { x: len + kd, y: yc - hw / 2 }, { x: len + kd, y: yc + hw / 2 }, { x: len, y: yc + nw / 2 });
  pts.push({ x: len, y: H });
  for (const [a2, b2] of [...notches].reverse()) pts.push({ x: b2, y: H }, { x: b2, y: H - t }, { x: a2, y: H - t }, { x: a2, y: H });
  pts.push({ x: 0, y: H });
  for (const yc of [...knobs].reverse()) pts.push({ x: 0, y: yc + nw / 2 }, { x: kd, y: yc + hw / 2 }, { x: kd, y: yc - hw / 2 }, { x: 0, y: yc - nw / 2 });
  const clean = pts.filter((q, i) => { const nq = pts[(i + 1) % pts.length]; return Math.hypot(q.x - nq.x, q.y - nq.y) > 1e-6; });
  panels.push({ name: "flexWall", w: len + kd, h: H, pts: clean, lines, wrap: { loop: roundRect(t / 2, t / 2, W - t / 2, D - t / 2, r - t / 2), z0: 0, z1: H } });

  if (o.type !== "flexcup") {
    // Stülpdeckel: außen wie die Kiste, innen passend in die Öffnung des Rings
    panels.push({ name: "lidOuter", w: W, h: D, pts: roundRect(0, 0, W, D, r), at: flat(0, 0, H) });
    const iw = W - 2 * (t + rw) - 2 * c, id = D - 2 * (t + rw) - 2 * c;
    panels.push({ name: "lidInner", w: iw, h: id, pts: roundRect(0, 0, iw, id, Math.max(0.5, r - t - rw - c)), at: flat(t + rw + c, t + rw + c, H - t) });
  }
  return panels;
}

/**
 * Würfelturm: Ausgang unten in der Front, drei schräge Rampen (20–35°) zwischen den Seitenwänden.
 * Oben fällt der Würfel auf Rampe 1 (hinten hoch), rollt nach vorne auf Rampe 2 (vorne hoch), dann auf die
 * untere Rampe, die über die ganze Tiefe bis zum Ausgang führt. Jede Rampe hat links/rechts Zapfen, die in
 * schräge Schlitze der Seitenwände greifen (beide Seitenwände gleich, x = 0 ist vorne).
 * Passt die oberste Rampe nicht mehr hinein, bleibt sie weg (mindestens zwei Rampen, sonst „zu klein“).
 */
/**
 * Würfelturm: Höhen der Rampen-Mittellinien (Rampe 3 unten … Rampe 1 oben) bei Innentiefe Di und Außenhöhe H.
 * Am liebsten 35° steil; ist der Turm dafür zu niedrig, werden die Rampen flacher (bis 20°, flacher rollen Würfel
 * schlecht). Drei Rampen, wenn sie mit mindestens 20° hineinpassen, sonst zwei.
 */
const DICE_TAN_MAX = Math.tan((35 * Math.PI) / 180), DICE_TAN_MIN = Math.tan((20 * Math.PI) / 180);
function diceLevels(t: number, Di: number, H: number) {
  const k = 0.6, G = 26 + t;                                         // Fallhöhe zwischen zwei Rampen (Würfel bis ~20 mm)
  const ze = 2 * t + 1;                                              // Unterkante Ausgang, knapp über dem Boden
  const z3lo = ze - t / 2;
  // Steigung, bei der Rampe 1 (oben) bzw. Rampe 2 gerade noch hineinpasst (Platz über Rampe 1: t + 15 mm)
  const tan3 = (H - t - 15 - z3lo - 2 * G) / ((4 * k - 1) * Di), tan2 = (H - t / 2 - 2 - z3lo - G) / (2 * k * Di);
  const tan = tan3 >= DICE_TAN_MIN ? Math.min(tan3, DICE_TAN_MAX) : Math.max(DICE_TAN_MIN, Math.min(tan2, DICE_TAN_MAX));
  const z3hi = z3lo + Di * tan;
  const z2lo = z3lo + k * Di * tan + G, z2hi = z2lo + k * Di * tan;
  const z1lo = z2hi - (1 - k) * Di * tan + G, z1hi = z1lo + k * Di * tan;
  return { k, ze, z3lo, z3hi, z2lo, z2hi, z1lo, z1hi, deg: (Math.atan(tan) * 180) / Math.PI };
}
/** Würfelturm: so hoch muss er außen mindestens sein, damit zwei Rampen (20°) hineinpassen (mm, aufgerundet) */
export function diceMinHeight(o: BoxOptions): number {
  const t = Math.max(0.1, o.t), Di = outerSize({ ...o, type: "dice" }).D - 2 * t;
  return Math.ceil(t / 2 + 2 + (2 * t + 1 - t / 2) + 2 * 0.6 * Di * DICE_TAN_MIN + 26 + t);
}
/** Würfelturm: Neigung der Rampen in Grad (für die Anzeige) */
export function diceAngle(o: BoxOptions): number {
  const t = Math.max(0.1, o.t), { D, H } = outerSize({ ...o, type: "dice" });
  return diceLevels(t, D - 2 * t, H).deg;
}

function diceRamps(front: Panel, left: Panel, right: Panel, t: number, f: number): Panel[] {
  const W = front.w, D = left.w, H = left.h, Wi = W - 2 * t, Di = D - 2 * t;
  const { k, ze, z3lo, z3hi, z2lo, z2hi, z1lo, z1hi } = diceLevels(t, Di, H);
  // Ausgang: so hoch wie ein großer Würfel
  const eh = Math.min(Math.max(24, H * 0.2), H - ze - 2 * t);
  if (Wi > 8 && eh > 8) front.holes = [rect(t + 2, ze, W - t - 2, ze + eh)];
  // Rampen als Mittellinie (x, z) von der Wand zum freien Ende
  const lines: [Pt2, Pt2][] = [[{ x: D - t, y: z3hi }, { x: t, y: z3lo }], [{ x: t, y: z2hi }, { x: t + k * Di, y: z2lo }]];
  if (z1hi + t + 15 <= H) lines.push([{ x: D - t, y: z1hi }, { x: D - t - k * Di, y: z1lo }]);
  const ramps: Panel[] = [], slots: Pt2[][] = [];
  for (const [P, Q] of lines) {
    if (Math.max(P.y, Q.y) + t / 2 > H - 2) continue;
    const L = Math.hypot(Q.x - P.x, Q.y - P.y), ux = (Q.x - P.x) / L, uy = (Q.y - P.y) / L;
    // die Rampe ist schräg: an beiden Enden so viel kürzer, dass ihre Ecken nicht in die Wand ragen
    const d0 = (t / 2) * Math.abs(uy / ux) + 0.25;
    const Lr = L - 2 * d0, tabs = tabsOn(Lr, t, f);
    // Schlitz: Rechteck um die Mittellinie, so lang wie der Zapfen, so breit wie das Material
    for (const [a, b] of tabs) slots.push([[a, -1], [b, -1], [b, 1], [a, 1]].map(([s, n]) => ({ x: P.x + ux * (d0 + s) - uy * n * t / 2, y: P.y + uy * (d0 + s) + ux * n * t / 2 })));
    // Rampe: Länge Lr × Innenbreite, Zapfen (t) an beiden langen Seiten
    const pts: Pt2[] = [{ x: 0, y: t }];
    for (const [a, b] of tabs) pts.push({ x: a, y: t }, { x: a, y: 0 }, { x: b, y: 0 }, { x: b, y: t });
    pts.push({ x: Lr, y: t }, { x: Lr, y: t + Wi });
    for (const [a, b] of [...tabs].reverse()) pts.push({ x: b, y: t + Wi }, { x: b, y: Wi + 2 * t }, { x: a, y: Wi + 2 * t }, { x: a, y: t + Wi });
    pts.push({ x: 0, y: t + Wi });
    // Lage: Wand-x = Tiefe Y, Wand-y = Höhe Z; Rampe quer über die Breite, Dicke um die Mittellinie
    const sx = P.x + ux * d0 + uy * t / 2, sz = P.y + uy * d0 - ux * t / 2;
    ramps.push({ name: "ramp", w: Lr, h: Wi + 2 * t, pts, at: { o: [0, sx, sz], u: [0, ux, uy], v: EX, n: [0, -uy, ux] } });
  }
  left.holes = slots.map(sl => sl.map(q => ({ ...q })));
  right.holes = slots.map(sl => sl.map(q => ({ ...q })));
  return ramps;
}

/** Ecken eines regelmäßigen Vielecks mit Abstand ap (Mitte → Seitenmitte); Seite 0 zeigt nach rechts (+x) */
function polyVerts(cx: number, cy: number, ap: number, n: number): Pt2[] {
  const R = ap / Math.cos(Math.PI / n);
  return Array.from({ length: n }, (_, i) => { const a = ((2 * i - 1) * Math.PI) / n; return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }; });
}

/** Vieleck-Kiste: Abstände Mitte → Plattenrand (A), → Außenseite der Wände (a), → Innenseite (ai); Wandhöhe Hw */
function hexDims(o: BoxOptions) {
  const t = Math.max(0.1, o.t), n = Math.max(5, Math.min(12, Math.round(o.sides ?? 6)));
  const A = o.inner ? o.w / 2 + 2 * t : o.w / 2, a = A - t, ai = a - t;
  const Hw = o.inner ? o.h : o.h - 2 * t;
  return { t, n, A, a, ai, Hw };
}
function hexSize(o: BoxOptions): { W: number; D: number; H: number } {
  const { t, n, A, Hw } = hexDims(o), v = polyVerts(0, 0, A, n);
  const ext = (k: "x" | "y") => Math.max(...v.map(q => q[k])) - Math.min(...v.map(q => q[k]));
  return { W: ext("x"), D: ext("y"), H: Hw + 2 * t };
}

/**
 * Vieleck-Kiste: Boden mit Schlitzen (Rand t breit), n gleiche Wände mit Zapfen unten. Die Wände sind so breit wie
 * die Innenseite – innen stoßen sie genau aneinander, außen bleibt an jeder Ecke ein kleiner Keil (verleimen).
 * Stülpdeckel aus zwei Platten: die kleine passt innen zwischen die Wände.
 */
function hexPanels(o: BoxOptions): Panel[] {
  const { t, n, A, a, ai, Hw } = hexDims(o), f = Math.max(t, o.finger), c = 0.2;
  const { W, D } = hexSize(o), cx = W - Math.max(...polyVerts(0, 0, A, n).map(q => q.x)), cy = D / 2;
  const side = 2 * ai * Math.tan(Math.PI / n), tabs = tabsOn(side, t, f);
  const slots: Pt2[][] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n, nx = Math.cos(th), ny = Math.sin(th);
    for (const [s0, s1] of tabs) slots.push([[ai, s0], [a, s0], [a, s1], [ai, s1]].map(([r, s]) => {
      const u = s - side / 2;
      return { x: cx + nx * r - ny * u, y: cy + ny * r + nx * u };
    }));
  }
  const panels: Panel[] = [{ name: "bottom", w: W, h: D, pts: polyVerts(cx, cy, A, n), holes: slots }];
  const wall: Pt2[] = [{ x: 0, y: t }];
  for (const [s0, s1] of tabs) wall.push({ x: s0, y: t }, { x: s0, y: 0 }, { x: s1, y: 0 }, { x: s1, y: t });
  wall.push({ x: side, y: t }, { x: side, y: t + Hw }, { x: 0, y: t + Hw });
  for (let i = 0; i < n; i++) {
    // Wand i: Innenseite im Abstand ai, Dicke nach außen, Platten-x entlang der Seite
    const th = (2 * Math.PI * i) / n, nx = Math.cos(th), ny = Math.sin(th);
    panels.push({ name: "hexWall", w: side, h: Hw + t, pts: wall.map(q => ({ ...q })),
      at: { o: [cx + nx * ai + ny * side / 2, cy + ny * ai - nx * side / 2, 0], u: [-ny, nx, 0], v: EZ, n: [nx, ny, 0] } });
  }
  panels[0].at = flat(0, 0, 0);
  panels.push({ name: "lidOuter", w: W, h: D, pts: polyVerts(cx, cy, A, n), at: flat(0, 0, Hw + t) });
  const li = polyVerts(0, 0, ai - c, n), lx = Math.min(...li.map(q => q.x)), ly = Math.min(...li.map(q => q.y));
  const lw = Math.max(...li.map(q => q.x)) - lx, lh = Math.max(...li.map(q => q.y)) - ly;
  panels.push({ name: "lidInner", w: lw, h: lh, pts: li.map(q => ({ x: q.x - lx, y: q.y - ly })), at: flat(cx + lx, cy + ly, Hw) });
  return panels;
}

/** Schubladenschrank: Fächer und Schubladen (Maße je Schublade außen, ohne Blende) */
export function cabinetDrawer(o: BoxOptions): { n: number; w: number; d: number; h: number } {
  const t = Math.max(0.1, o.t), c = 1, n = Math.max(0, Math.min(20, Math.round(o.shelves ?? 2)));
  const { W, D, H } = outerSize({ ...o, type: "cabinet" });
  // Regalbretter stehen gleichmäßig verteilt (Mitte bei (H - 2t)·(i+1)/(n+1)) → lichte Fachhöhe
  const ch = (H - 2 * t) / (n + 1) - t;
  return { n: n + 1, w: W - 2 * t - 2 * c, d: D - t - t - c, h: ch - c };
}

/**
 * Schubladenschrank = Regal mit (Regalbrettern + 1) Fächern, in jedes Fach eine Schublade mit Luft (1 mm je Seite).
 * Die Blende ist so groß wie die Schubladen-Front und wird vorne aufgeleimt – dann schließt sie bündig mit dem Schrank.
 */
function cabinetPanels(o: BoxOptions): Panel[] {
  const panels = rawPanels({ ...o, type: "shelf" });
  const dr = cabinetDrawer(o);
  const rename: Partial<Record<PanelName, PanelName>> = { bottom: "drBottom", front: "drEnd", back: "drEnd", left: "drSide", right: "drSide", blende: "drPlate" };
  const t = Math.max(0.1, o.t), { H } = outerSize({ ...o, type: "cabinet" }), I = (v: V3): V3 => v;
  // Schublade k steht auf dem Boden ihres Fachs (Fach 0: auf der unteren Platte, sonst auf dem Regalbrett darunter);
  // die Blende vorne bündig, 1 mm Luft links
  const floor = (k: number) => (k === 0 ? t : t + ((H - 2 * t) * k) / (dr.n) + t / 2);
  if (Math.min(dr.w, dr.d, dr.h) > 3 * t) for (let i = 0; i < dr.n; i++)
    panels.push(...rawPanels({ ...o, inner: false, type: "drawer", w: dr.w, d: dr.d, h: dr.h, overhang: 0 })
      .map(p => ({ ...p, name: rename[p.name] || p.name, at: p.at && movePlace(p.at, I, [t + 1, t, floor(i)]) })));
  return panels;
}
