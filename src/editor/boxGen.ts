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
 * Alle Maße in mm.
 */
import { offsetPolygon } from "../polyOffset";
import { app, bedSizeMm } from "./editorState";
import { createPolyline, MM_TO_PIXEL } from "../shapeTransform";
import { t } from "../i18n/i18n";

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
 *   flex    Runde Kiste: Wand aus einem Streifen mit Biegescharnier (nur Laser), Boden mit Zapfen
 */
export type BoxType = "closed" | "open" | "tray" | "handle" | "drawer" | "lidbox" | "slide" | "shelf" | "flex";
export const BOX_TYPES: BoxType[] = ["closed", "open", "tray", "handle", "drawer", "lidbox", "slide", "shelf", "flex"];

export type PanelName = "bottom" | "top" | "front" | "back" | "left" | "right" | "divX" | "divY" | "blende" | "lidOuter" | "lidInner"
  | "slideLid" | "linerSide" | "linerBack" | "railSide" | "railBack" | "shelfBack" | "shelfEnd" | "shelf" | "flexWall";
/** holes: Ausschnitte in der Platte (Schlitze, Grifflöcher); lines: offene Schnitte (Biegescharnier) */
export interface Panel { name: PanelName; w: number; h: number; pts: { x: number; y: number }[]; holes?: { x: number; y: number }[][]; lines?: { x: number; y: number }[][] }

/** Außenmaße (W × D × H) aus den eingegebenen Maßen – je nach Art kommen die Wände anders dazu */
export function outerSize(o: BoxOptions): { W: number; D: number; H: number } {
  const t = Math.max(0.1, o.t), type = o.type || (o.lid ? "closed" : "open");
  if (!o.inner) return { W: o.w, D: o.d, H: o.h };
  if (type === "shelf") return { W: o.w + 2 * t, D: o.d + t, H: o.h + 2 * t }; // vorne offen, Rückwand hinten
  return { W: o.w + 2 * t, D: o.d + 2 * t, H: o.h + (type === "closed" ? 2 : 1) * t };
}

type Pt2 = { x: number; y: number };
const rect = (x0: number, y0: number, x1: number, y1: number): Pt2[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
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
  if (type === "flex") return flexPanels(o);
  if (type === "shelf") {
    // Regal = Sortierkasten auf den Rücken gelegt: Boden → Rückwand, vorne/hinten → Boden/Oberseite,
    // Quer-Trennwände → Regalbretter (die offene Seite zeigt nach vorne)
    const { W, D, H } = outerSize(o);
    const rename: Partial<Record<PanelName, PanelName>> = { bottom: "shelfBack", front: "shelfEnd", back: "shelfEnd", divX: "shelf" };
    return rawPanels({ ...o, inner: false, w: W, d: H, h: D, type: "tray", nx: o.shelves ?? 2, ny: 0 })
      .map(p => ({ ...p, name: rename[p.name] || p.name }));
  }
  const lid = type === "closed";
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

  const Wi = W - 2 * t, Di = D - 2 * t, Hi = H - t; // Innenmaße (offene Box)
  if (type === "tray") {
    // Trennwände stehen auf dem Boden (Höhe = Innenhöhe); Zapfen (t lang) stecken in Schlitzen der Außenwände.
    // Quer-Wände (divX, parallel zur Front) von oben, Längs-Wände (divY) von unten halb eingeschnitten → stecken ineinander
    const nx = Math.max(0, Math.min(20, Math.round(o.nx ?? 1))), ny = Math.max(0, Math.min(20, Math.round(o.ny ?? 1)));
    const tabH = Math.max(t, Hi / 3);
    const tb = (Hi - tabH) / 2, te = tb + tabH;   // Zapfen relativ zur Unterkante der Trennwand
    const xs = Array.from({ length: ny }, (_, i) => (Wi * (i + 1)) / (ny + 1)); // Längs-Wände: Abstand von der linken Innenseite
    const ys = Array.from({ length: nx }, (_, i) => (Di * (i + 1)) / (nx + 1)); // Quer-Wände: Abstand von der vorderen Innenseite
    // Schlitze in den Außenwänden (Wand-Koordinaten: + t Wanddicke; die Trennwand steht auf dem Boden bei t)
    for (const n of ["left", "right"] as const) get(n).holes = ys.map(y => rect(t + y - t / 2, t + tb, t + y + t / 2, t + te));
    for (const n of ["front", "back"] as const) get(n).holes = xs.map(x => rect(t + x - t / 2, t + tb, t + x + t / 2, t + te));
    /** Trennwand: Innenlänge L, Zapfen links/rechts; Einschnitte (Breite t, halbe Höhe) an den Stellen cuts */
    const divider = (L: number, cuts: number[], fromTop: boolean, name: "divX" | "divY"): Panel => {
      const pts: Pt2[] = [{ x: t, y: 0 }];
      if (!fromTop) for (const c of cuts) pts.push({ x: t + c - t / 2, y: 0 }, { x: t + c - t / 2, y: Hi / 2 }, { x: t + c + t / 2, y: Hi / 2 }, { x: t + c + t / 2, y: 0 });
      pts.push({ x: L + t, y: 0 }, { x: L + t, y: tb }, { x: L + 2 * t, y: tb }, { x: L + 2 * t, y: te }, { x: L + t, y: te }, { x: L + t, y: Hi });
      if (fromTop) for (const c of [...cuts].reverse()) pts.push({ x: t + c + t / 2, y: Hi }, { x: t + c + t / 2, y: Hi / 2 }, { x: t + c - t / 2, y: Hi / 2 }, { x: t + c - t / 2, y: Hi });
      pts.push({ x: t, y: Hi }, { x: t, y: te }, { x: 0, y: te }, { x: 0, y: tb }, { x: t, y: tb });
      return { name, w: L + 2 * t, h: Hi, pts };
    };
    for (let i = 0; i < nx; i++) panels.push(divider(Wi, xs, true, "divX"));
    for (let i = 0; i < ny; i++) panels.push(divider(Di, ys, false, "divY"));
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
    panels.push({ name: "blende", w: bw, h: bh, pts: rect(0, 0, bw, bh), holes: hl > hh * 1.5 ? [slot(bw / 2, bh * 0.6, hl, hh)] : [] });
  }
  if (slide) {
    // Innen: unten Futter-Leisten bis Hf (darauf liegt der Deckel), oben Halte-Leisten (2 t hoch) mit Luft c darunter
    const lh = Hf - t, bw = Wi - 2 * t;
    if (lh > 0.5) {
      panels.push({ name: "linerSide", w: Di, h: lh, pts: rect(0, 0, Di, lh) }, { name: "linerSide", w: Di, h: lh, pts: rect(0, 0, Di, lh) });
      panels.push({ name: "linerBack", w: bw, h: lh, pts: rect(0, 0, bw, lh) });
    }
    panels.push({ name: "railSide", w: Di, h: 2 * t, pts: rect(0, 0, Di, 2 * t) }, { name: "railSide", w: Di, h: 2 * t, pts: rect(0, 0, Di, 2 * t) });
    panels.push({ name: "railBack", w: bw, h: 2 * t, pts: rect(0, 0, bw, 2 * t) });
    // Deckel: so breit wie innen (minus Luft), von der Vorderkante bis an die Rückwand; Griffmulde vorne
    const lw = Wi - 2 * c, ld = D - t - c;
    const gl = Math.min(lw * 0.4, 50), gh = Math.min(10, ld * 0.15);
    panels.push({ name: "slideLid", w: lw, h: ld, pts: rect(0, 0, lw, ld), holes: gl > gh * 1.5 ? [slot(lw / 2, 6 + gh / 2, gl, gh)] : [] });
  }
  if (type === "lidbox") {
    // Stülpdeckel: außen W × D, innen passend in die Öffnung (0,2 mm Luft je Seite) – beide aufeinander kleben
    const c = 0.2;
    panels.push({ name: "lidOuter", w: W, h: D, pts: rect(0, 0, W, D) });
    panels.push({ name: "lidInner", w: Wi - 2 * c, h: Di - 2 * c, pts: rect(0, 0, Wi - 2 * c, Di - 2 * c) });
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
 * Runde Kiste: Boden mit Zapfen auf den geraden Seiten, die Wand ist EIN Streifen um den Boden herum.
 * In den Rundungen hat der Streifen ein Biegescharnier (viele versetzte Schnitte) – nur mit dem Laser sinnvoll.
 * Der Stoß ist vorne links (Anfang der Front) und wird geklebt. Deckel wie beim Stülpdeckel aus zwei Platten.
 */
function flexPanels(o: BoxOptions): Panel[] {
  const t = Math.max(0.1, o.t), f = Math.max(t, o.finger), c = 0.2;
  const { W, D, H } = outerSize({ ...o, type: "flex" });
  const r = Math.max(t + 1, Math.min(o.radius ?? 15, W / 2, D / 2));
  const Lw = W - 2 * r, Ld = D - 2 * r;
  const arc = (Math.PI / 2) * (r - t / 2);              // Länge der Rundung in der Wandmitte
  const panels: Panel[] = [];
  // Boden: liegt innerhalb der Wand, Zapfen gehen durch die Wand bis außen
  panels.push({ name: "bottom", w: W, h: D, pts: roundRect(t, t, W - t, D - t, r - t, { t, finger: f, d: t }) });
  // Wand: Abschnitte vorne, Rundung, rechts, Rundung, hinten, Rundung, links, Rundung
  const secs: { L: number; bend: boolean }[] = [];
  for (const L of [Lw, Ld, Lw, Ld]) secs.push({ L, bend: false }, { L: arc, bend: true });
  const len = secs.reduce((n, q) => n + q.L, 0);
  const pts: Pt2[] = [{ x: 0, y: 0 }];
  const lines: Pt2[][] = [];
  const g = Math.max(2, t);                               // Stege zwischen den Schnitten
  const step = Math.min(2.5, Math.max(1, t * 0.5));       // Abstand der Schnitt-Reihen
  const cut = (x: number, y0: number, y1: number) => { if (y1 - y0 > 1) lines.push([{ x, y: y0 }, { x, y: y1 }]); };
  let s0 = 0;
  for (const sec of secs) {
    if (!sec.bend) for (const [a, b] of tabsOn(sec.L, t, f)) pts.push({ x: s0 + a, y: 0 }, { x: s0 + a, y: t }, { x: s0 + b, y: t }, { x: s0 + b, y: 0 });
    else {
      // Biegescharnier etwas breiter als die Rundung; abwechselnd Reihe A (2 Schnitte) und B (3 Schnitte, versetzt)
      const m = Math.min(1, s0), from = s0 - m, span = sec.L + 2 * m;
      const n = Math.max(2, Math.round(span / step));
      for (let j = 0; j < n; j++) {
        const x = from + ((j + 0.5) * span) / n;
        if (j % 2 === 0) { cut(x, g, H / 2 - g / 2); cut(x, H / 2 + g / 2, H - g); }
        else { cut(x, 0, H / 4 - g / 2); cut(x, H / 4 + g / 2, (3 * H) / 4 - g / 2); cut(x, (3 * H) / 4 + g / 2, H); }
      }
    }
    s0 += sec.L;
  }
  pts.push({ x: len, y: 0 }, { x: len, y: H }, { x: 0, y: H });
  panels.push({ name: "flexWall", w: len, h: H, pts, lines });
  // Deckel: außen wie die Kiste, innen passend in die Öffnung
  panels.push({ name: "lidOuter", w: W, h: D, pts: roundRect(0, 0, W, D, r) });
  const iw = W - 2 * t - 2 * c, id = D - 2 * t - 2 * c;
  panels.push({ name: "lidInner", w: iw, h: id, pts: roundRect(0, 0, iw, id, Math.max(0.5, r - t - c)) });
  return panels;
}

// =====================================================================
// FENSTER: Maße eingeben, Vorschau, Platten aufs Bett legen
// =====================================================================

const KEY = "cnc_craft_box";
const DEF: BoxOptions = { w: 100, d: 80, h: 50, inner: false, t: 3, finger: 9, lid: true, kerf: 0.1, type: "closed", nx: 1, ny: 2, overhang: 5, shelves: 2, radius: 15 };

function loadBox(): BoxOptions {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: any = { ...DEF };
    for (const k of ["w", "d", "h", "t", "finger", "kerf", "nx", "ny", "overhang", "shelves", "radius"] as const) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    for (const k of ["inner", "lid"] as const) if (typeof s[k] === "boolean") o[k] = s[k];
    o.type = BOX_TYPES.includes(s.type) ? s.type : (o.lid ? "closed" : "open");
    return o;
  } catch { return { ...DEF }; }
}

/** Platten nebeneinander (Reihen) – Rückgabe: Rechtecke der Lage in mm */
function layout(panels: Panel[], gap: number, maxW: number): { x: number; y: number }[] {
  const pos: { x: number; y: number }[] = [];
  let x = 0, y = 0, rowH = 0;
  for (const p of panels) {
    if (x > 0 && x + p.w > maxW) { x = 0; y += rowH + gap; rowH = 0; }
    pos.push({ x, y });
    x += p.w + gap; rowH = Math.max(rowH, p.h);
  }
  return pos;
}

export function openBoxDialog(log: (s: string) => void, done: () => void) {
  const o = loadBox();
  document.getElementById("box-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "box-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, v: number, step = "1", min = "0") =>
    `<label class="prop-row">${t(key)}<input id="${id}" type="number" step="${step}" min="${min}" value="${v}" class="prop-input"></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:560px;">
      <h3>📦 ${t("box.title")}</h3>
      <div class="dlg-hint">${t("box.desc")}</div>
      <label class="prop-row">${t("box.type")}
        <select id="box-type" class="prop-input" style="width:auto;">${BOX_TYPES.map(k => `<option value="${k}">${t("box.type." + k)}</option>`).join("")}</select></label>
      <div id="box-tdesc" class="dlg-hint"></div>
      <div class="box-grid">
        <div class="box-fields">
          ${num("box-w", "box.w", o.w)}
          ${num("box-d", "box.d", o.d)}
          ${num("box-h", "box.h", o.h)}
          <label class="prop-row" style="cursor:pointer;"><span>${t("box.inner")}</span><input id="box-inner" type="checkbox" ${o.inner ? "checked" : ""} style="width:auto;"></label>
          ${num("box-t", "box.t", o.t, "0.1", "0.5")}
          ${num("box-f", "box.finger", o.finger, "0.5", "1")}
          <div class="box-x" data-for="tray">${num("box-nx", "box.nx", o.nx ?? 1, "1", "0")}${num("box-ny", "box.ny", o.ny ?? 2, "1", "0")}</div>
          <div class="box-x" data-for="drawer">${num("box-ov", "box.overhang", o.overhang ?? 5, "1", "0")}</div>
          <div class="box-x" data-for="shelf">${num("box-sh", "box.shelves", o.shelves ?? 2, "1", "0")}</div>
          <div class="box-x" data-for="flex">${num("box-rad", "box.radius", o.radius ?? 15, "1", "2")}</div>
          ${num("box-kerf", "box.kerf", o.kerf, "0.01", "0")}
        </div>
        <div class="box-prev"><svg id="box-svg" viewBox="0 0 100 100"></svg><div id="box-info" class="dlg-hint"></div></div>
      </div>
      <div class="dlg-hint">${t("box.hint")}</div>
      <div class="dlg-buttons">
        <button id="box-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="box-ok" class="btn-primary">✔ ${t("box.create")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const read = (): BoxOptions => {
    const n = (id: string, d: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v >= 0 ? v : d; };
    const type = $<HTMLSelectElement>("box-type").value as BoxType;
    return { w: n("box-w", o.w), d: n("box-d", o.d), h: n("box-h", o.h), inner: $("box-inner").checked, t: n("box-t", o.t),
      finger: n("box-f", o.finger), lid: type === "closed", kerf: n("box-kerf", o.kerf), type,
      nx: Math.round(n("box-nx", o.nx ?? 1)), ny: Math.round(n("box-ny", o.ny ?? 2)), overhang: n("box-ov", o.overhang ?? 5),
      shelves: Math.min(20, Math.round(n("box-sh", o.shelves ?? 2))), radius: n("box-rad", o.radius ?? 15) };
  };
  const valid = (b: BoxOptions) => {
    if (!(b.t > 0) || Math.min(b.w, b.d, b.h) <= (b.inner ? 0 : 3 * b.t)) return false;
    const { H } = outerSize(b);
    if (b.type === "slide" && H < 6 * b.t + 2) return false;         // Platz für Futter + Deckel + Leiste
    if (b.type === "flex" && H < 4 * Math.max(2, b.t) + 4) return false; // sonst passt kein Biegescharnier
    return true;
  };
  const preview = () => {
    const b = read();
    // Zusatzfelder nur bei der passenden Art
    ov.querySelectorAll<HTMLElement>(".box-x").forEach(el => { el.style.display = el.dataset.for === b.type ? "" : "none"; });
    $<HTMLElement>("box-tdesc").textContent = t("box.tdesc." + b.type);
    const svg = $<HTMLElement>("box-svg") as unknown as SVGSVGElement;
    const info = $<HTMLElement>("box-info");
    if (!valid(b)) { svg.innerHTML = ""; info.textContent = t("box.tooSmall"); $<HTMLButtonElement>("box-ok").disabled = true; return; }
    $<HTMLButtonElement>("box-ok").disabled = false;
    const ps = boxPanels(b);
    const pos = layout(ps, 4, Math.max(b.w, b.d) * 2.4);
    let W = 0, H = 0;
    ps.forEach((p, i) => { W = Math.max(W, pos[i].x + p.w); H = Math.max(H, pos[i].y + p.h); });
    svg.setAttribute("viewBox", `-2 -2 ${W + 4} ${H + 4}`);
    svg.innerHTML = ps.map((p, i) => {
      const ring = (pts: { x: number; y: number }[]) => pts.map((q, k) => `${k ? "L" : "M"}${(pos[i].x + q.x).toFixed(2)},${(pos[i].y + p.h - q.y).toFixed(2)}`).join("") + "Z";
      const d = ring(p.pts) + (p.holes || []).map(ring).join("");
      const ln = (p.lines || []).map(l => ring(l).slice(0, -1)).join("");
      return `<path d="${d}" fill-rule="evenodd" class="box-panel"/>${ln ? `<path d="${ln}" class="box-cut"/>` : ""}<text x="${pos[i].x + p.w / 2}" y="${pos[i].y + p.h / 2}" class="box-lbl" style="font-size:${Math.max(4, Math.min(p.w, p.h) / 6)}px">${t("box.p." + p.name)}</text>`;
    }).join("");
    const os = outerSize(b);
    info.textContent = t("box.info", { n: ps.length, w: os.W.toFixed(1), d: os.D.toFixed(1), h: os.H.toFixed(1) });
  };
  $<HTMLSelectElement>("box-type").value = o.type || "closed";
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener("input", preview));
  preview();
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") $<HTMLElement>("box-ok").click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("box-cancel").onclick = close;
  $<HTMLElement>("box-ok").onclick = () => {
    const b = read();
    if (!valid(b)) return;
    try { localStorage.setItem(KEY, JSON.stringify(b)); } catch { /* egal */ }
    close();
    const ps = boxPanels(b);
    const bed = bedSizeMm();
    const pos = layout(ps, 5, Math.max(bed.w - 20, Math.max(...ps.map(p => p.w))));
    const st = app();
    const toW = (i: number, pts: { x: number; y: number }[]) => pts.map(q => ({ x: (10 + pos[i].x + q.x) * MM_TO_PIXEL, y: (10 + pos[i].y + q.y) * MM_TO_PIXEL }));
    const made: any[] = [];
    ps.forEach((p, i) => {
      // Platte + ihre Ausschnitte (Schlitze, Griffe) als Gruppe – sie bewegen sich zusammen
      const gid = p.holes?.length || p.lines?.length ? "box-" + Math.random().toString(36).slice(2, 10) : undefined;
      const extra = gid ? { source: t("box.title"), groupId: gid } : { source: t("box.title") };
      made.push(createPolyline(toW(i, p.pts), true, "outside", extra));
      for (const hl of p.holes || []) made.push(createPolyline(toW(i, hl), true, "inside", extra));
      for (const ln of p.lines || []) made.push(createPolyline(toW(i, ln), false, "on-line", extra));
    });
    st.shapes = [...st.shapes, ...made];
    st.selectedShapeIds = made.map(s => s.id);
    log(t("box.done", { n: ps.length }));
    done();
  };
}
