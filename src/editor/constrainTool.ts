/**
 * WERKZEUG „BEDINGUNG“ (Rechnung in sketchSolve.ts)
 *
 * Art oben in der Leiste wählen, dann Strecke(n), Punkte oder Kreise anklicken:
 *   Waagerecht, Senkrecht            eine Strecke
 *   Parallel, Rechtwinklig, Winkel   zwei Strecken (Winkel: Wert eingeben)
 *   Gleich lang                      zwei Strecken oder zwei Kreise (gleicher Radius)
 *   Länge                            eine Strecke (Länge) oder ein Kreis (Durchmesser) – Wert eingeben
 *   Punkte verbinden                 zwei Punkte (Ecken, Linienenden, Kreismitten)
 *   Auf Linie/Kreis                  ein Punkt, dann eine Strecke oder ein Kreis
 *   Festhalten                       ein Punkt bleibt, wo er ist
 *   Tangential                       Strecke + Kreis oder zwei Kreise (berühren sich so, wie sie gerade liegen: außen/innen)
 *   Gleiche Mitte                    zwei Kreise
 * Die Zeichnung wird sofort passend gemacht – so wenig wie möglich verschoben, die zuerst angeklickte Form bleibt eher
 * stehen. Widerspricht die neue Bedingung den alten, wird sie nicht gesetzt.
 *
 * Danach bleibt sie erhalten: Punkte ziehen (Werkzeug Punkte) und Formen verschieben (Auswahl) rechnen die verbundenen
 * Formen nach. Drehen und Größe ändern rechnen nicht nach – das Zeichen wird dann rot.
 *
 * Gespeichert an der Form (s.gcons, mit dem Projekt und Teil von Rückgängig). ns merkt sich die Punktzahl der beteiligten
 * Polylinien (-1 = Kreis): ändert sie sich (Punkt gelöscht, Ecke verrundet …), gilt die Bedingung nicht mehr.
 * Zeichen: blau = erfüllt, rot = verletzt, gelb = gewählt. Anklicken = auswählen (Entf löscht), Doppelklick = Wert ändern
 * bzw. wieder herstellen.
 */
import { app, options, screenDist, toScreen } from "./editorState";
import { MM_TO_PIXEL, Pt, arcGeometry, convertToPolyline, makeRectPoints, shapeBounds, updatePolylineBounds } from "../shapeTransform";
import { CirRef, GCon, PtRef, SegRef, Shapes, circumcircle, freedom, idsOf, satisfied, solve } from "./sketchSolve";
import { checkImport, importInApp } from "../importers/importRust";
import { syncPoints } from "./bezier";
import { toolLog } from "./trimTool";
import { t } from "../i18n/i18n";
import { fmtLenShort, fmtLenU, isInch } from "../units";
import { typedAngle, typedLen } from "./typedValues";

export type ConKind = "h" | "v" | "par" | "perp" | "eq" | "len" | "ang" | "coin" | "on" | "fix" | "tan" | "conc";
export const CON_KINDS: ConKind[] = ["h", "v", "par", "perp", "eq", "len", "ang", "coin", "on", "fix", "tan", "conc"];
type Stored = GCon & { ns: Record<string, number> };
type PickType = "seg" | "pt" | "cir";
type Pick = { t: "seg"; ref: SegRef } | { t: "pt"; ref: PtRef } | { t: "cir"; ref: CirRef };

/** Was bei jedem Klick angeklickt werden darf */
const STEPS: Record<ConKind, PickType[][]> = {
  h: [["seg"]], v: [["seg"]], len: [["seg", "cir"]], fix: [["pt"]],
  par: [["seg"], ["seg"]], perp: [["seg"], ["seg"]], ang: [["seg"], ["seg"]],
  eq: [["seg", "cir"], ["seg", "cir"]], coin: [["pt"], ["pt"]], on: [["pt"], ["seg", "cir"]],
  tan: [["seg", "cir"], ["seg", "cir"]], conc: [["cir"], ["cir"]]
};

export const conTool = {
  picks: [] as Pick[],
  hover: null as null | { pick: Pick; a?: Pt; b?: Pt; p?: Pt; c?: Pt; r?: number },
  sel: null as null | { owner: string; idx: number }
};

const kind = (): ConKind => (CON_KINDS.includes(options.conKind as ConKind) ? options.conKind as ConKind : "h");

export function conReset() { conTool.picks = []; conTool.hover = null; }
if (typeof window !== "undefined") window.addEventListener("cnc-con-kind", conReset);

/** Polylinien ohne Kurven (Rechtecke werden beim Anklicken umgewandelt) */
function usableLine(s: any): boolean {
  if (!s || s.textData || s.isText || s.type === "image") return false;
  if (s.type === "rect") return true;
  if (s.type !== "polyline" || !(s.points?.length >= 2) || s.points.length > 2000) return false;
  return !s.bez?.some((n: any) => (n.hi && (n.hi.x !== n.x || n.hi.y !== n.y)) || (n.ho && (n.ho.x !== n.x || n.ho.y !== n.y)));
}
const isCircle = (s: any) => s?.type === "circle" && !s.textData;
const isArc = (s: any) => s?.type === "arc" && !s.textData;
/** Freie Kurve: Polylinie mit Kurven-Knoten (Bedingungen nur an den Knoten) */
const isCurve = (s: any) => s?.type === "polyline" && !s.textData && Array.isArray(s.bez) && s.bez.length >= 2 && !usableLine(s);
/** Kennung der Form in ns: Polylinie = Punktzahl, -1 Kreis, -2 Bogen, -(100000 + Knoten) Kurve */
const nsOf = (s: any) => (isCircle(s) ? -1 : isArc(s) ? -2 : isCurve(s) ? -(100000 + s.bez.length) : s.points.length);

/** Punktliste für den Rechenkern: Polylinie = ihre Punkte, Kreis = [Mitte, {x: Radius}], Bogen = [Start, Ende, Mitte des Bogens], Kurve = Knoten */
function vec(s: any): Pt[] {
  if (isCircle(s)) return [{ x: s.x, y: s.y }, { x: Math.abs(s.w), y: 0 }];
  if (isArc(s)) return [{ x: s.x, y: s.y }, { x: s.x + s.w, y: s.y + s.h }, { x: s.midX, y: s.midY }];
  if (isCurve(s)) return s.bez.map((n: any) => ({ x: n.x, y: n.y }));
  return s.points;
}
/** Kopie der Punktliste (zum Zurücksetzen, wenn das Nachrechnen nicht geht) */
export const conSnapshot = (s: any): Pt[] => vec(s).map(p => ({ ...p }));
/** Kreis oder Bogen einer Form: Mitte und Radius */
function circleOf(s: any): { c: Pt; r: number } | null {
  if (isCircle(s)) return { c: { x: s.x, y: s.y }, r: Math.abs(s.w) };
  if (isArc(s)) { const v = vec(s); return circumcircle(v[0], v[1], v[2]); }
  return null;
}
function writeBack(s: any, pts: Pt[]) {
  if (isCircle(s)) { s.x = pts[0].x; s.y = pts[0].y; s.w = Math.abs(pts[1].x); s.h = Math.abs(pts[1].x); return; }
  if (isArc(s)) { s.x = pts[0].x; s.y = pts[0].y; s.w = pts[1].x - pts[0].x; s.h = pts[1].y - pts[0].y; s.midX = pts[2].x; s.midY = pts[2].y; return; }
  if (isCurve(s)) {
    // Knoten verschieben, ihre Griffe gleich mit, dann die Kurve neu glätten
    s.bez = s.bez.map((n: any, i: number) => {
      const dx = pts[i].x - n.x, dy = pts[i].y - n.y;
      return { ...n, x: pts[i].x, y: pts[i].y, hi: n.hi && { x: n.hi.x + dx, y: n.hi.y + dy }, ho: n.ho && { x: n.ho.x + dx, y: n.ho.y + dy } };
    });
    syncPoints(s);
    delete s.tabPts;
    return;
  }
  s.points = pts;
  if (s.bez && s.bez.length === pts.length) s.bez = pts.map((p, i) => ({ ...s.bez[i], x: p.x, y: p.y })); // gerade Knoten 1:1
  else delete s.bez;
  delete s.tabPts;
  if (s.tabMode === "manual") s.tabMode = "auto";
  updatePolylineBounds(s);
}

// ---------------------------------------------------------------------
// Gespeicherte Bedingungen
// ---------------------------------------------------------------------

function byId(): Map<string, any> { return new Map(app().shapes.map((s: any) => [s.id, s])); }

/** gilt die Bedingung noch? (Formen da, Punktzahl unverändert, Besitzer ist beteiligt) */
function alive(c: Stored, owner: string, map: Map<string, any>): boolean {
  const ids = Object.keys(c.ns || {});
  if (!ids.includes(owner)) return false;
  const shapeOk = ids.every(id => {
    const s = map.get(id);
    const n = c.ns[id];
    return n === -1 ? isCircle(s) : n === -2 ? isArc(s) : n <= -100000 ? isCurve(s) && s.bez.length === -n - 100000 : s?.type === "polyline" && !isCurve(s) && s.points?.length === n;
  });
  return shapeOk && idsOf(c).every(id => ids.includes(id));
}

export function allCons(): { owner: any; idx: number; c: Stored }[] {
  const map = byId(), out: { owner: any; idx: number; c: Stored }[] = [];
  for (const s of app().shapes) (s.gcons as Stored[] | undefined)?.forEach((c, idx) => { if (alive(c, s.id, map)) out.push({ owner: s, idx, c }); });
  return out;
}

export const hasCons = (id: string) => allCons().some(e => id in e.c.ns);

function prune() {
  const map = byId();
  for (const s of app().shapes) if (s.gcons?.length) {
    s.gcons = s.gcons.filter((c: Stored) => alive(c, s.id, map));
    if (!s.gcons.length) delete s.gcons;
  }
}

/** Alle Bedingungen, die über gemeinsame Formen mit ids verbunden sind, und die beteiligten Formen */
function component(ids: string[], extra: Stored[] = []): { cons: Stored[]; shapes: Set<string> } {
  const list = [...allCons().map(e => e.c), ...extra];
  const shapes = new Set(ids), cons = new Set<Stored>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of list) {
      if (cons.has(c)) continue;
      const cid = Object.keys(c.ns);
      if (cid.some(id => shapes.has(id))) { cons.add(c); cid.forEach(id => shapes.add(id)); grew = true; }
    }
  }
  return { cons: [...cons], shapes };
}

/** Lösen und (wenn es geht) in die Zeichnung schreiben. weight(id, i): wie schwer ein Punkt zu bewegen ist */
function solveAndApply(ids: string[], extra: Stored[], weight: (id: string, i: number) => number): boolean {
  const map = byId();
  const comp = component(ids, extra);
  if (!comp.cons.length) return true;
  const shapes: Shapes = new Map([...comp.shapes].map(id => [id, vec(map.get(id))]));
  // Kreise verschieben sich lieber, als ihre Größe zu ändern
  const wt = (id: string, i: number) => weight(id, i) * (i === 1 && isCircle(map.get(id)) ? 1e4 : 1);
  const r = solve(shapes, comp.cons, wt);
  // the same in Rust (sketchsolve.rs), in the background; what is written into the drawing stays the TypeScript result
  if (importInApp()) {
    const weights = Object.fromEntries([...shapes].map(([id, pts]) => [id, pts.map((_, i) => wt(id, i))]));
    checkImport("sketch_solve", { shapes: [...shapes], cons: comp.cons, weights }, { ok: r.ok, shapes: [...r.shapes], iterations: r.iterations });
  }
  if (!r.ok) return false;
  for (const [id, pts] of r.shapes) {
    const before = shapes.get(id)!;
    if (pts.every((p, i) => p.x === before[i].x && p.y === before[i].y)) continue;
    writeBack(map.get(id), pts);
  }
  app().shapes = [...app().shapes];
  return true;
}

// ---------------------------------------------------------------------
// Anklicken
// ---------------------------------------------------------------------

type Found = { pick: Pick; d: number; s: any; a?: Pt; b?: Pt; p?: Pt; c?: Pt; r?: number };

/** Nächstes Ziel unter der Maus; Punkte haben Vorrang (sie liegen ja auch auf Strecken) */
function findAt(world: Pt, types: PickType[]): Found | null {
  const segTol = screenDist(10), ptTol = screenDist(12);
  let best: Found | null = null;
  const take = (f: Found, tol: number, bonus: number) => { if (f.d <= tol && (!best || f.d - bonus < best.d)) best = { ...f, d: f.d - bonus }; };
  for (const s of app().shapes) {
    if (isCircle(s)) {
      const r = Math.abs(s.w), dc = Math.hypot(world.x - s.x, world.y - s.y);
      if (types.includes("pt")) take({ pick: { t: "pt", ref: { id: s.id, i: 0 } }, d: dc, s, p: { x: s.x, y: s.y } }, ptTol, ptTol);
      if (types.includes("cir")) take({ pick: { t: "cir", ref: { id: s.id } }, d: Math.abs(dc - r), s, c: { x: s.x, y: s.y }, r }, segTol, 0);
      continue;
    }
    if (isArc(s)) {
      // Bogen: Endpunkte sind Punkte, der Bogen selbst zählt wie ein Kreis
      const v = vec(s), g = arcGeometry(s);
      if (types.includes("pt")) [0, 1].forEach(i => take({ pick: { t: "pt", ref: { id: s.id, i } }, d: Math.hypot(world.x - v[i].x, world.y - v[i].y), s, p: v[i] }, ptTol, ptTol));
      if (types.includes("cir") && g) {
        const dc = Math.hypot(world.x - g.cx, world.y - g.cy);
        take({ pick: { t: "cir", ref: { id: s.id, arc: true } }, d: Math.abs(dc - g.r), s, c: { x: g.cx, y: g.cy }, r: g.r }, segTol, 0);
      }
      continue;
    }
    if (isCurve(s)) {
      // freie Kurve: nur ihre Knoten
      if (types.includes("pt")) s.bez.forEach((n: any, i: number) => take({ pick: { t: "pt", ref: { id: s.id, i } }, d: Math.hypot(world.x - n.x, world.y - n.y), s, p: { x: n.x, y: n.y } }, ptTol, ptTol));
      continue;
    }
    if (!usableLine(s)) continue;
    const pts: Pt[] = s.type === "rect" ? makeRectPoints(s.x, s.y, s.x + s.w, s.y + s.h) : s.points; // Reihenfolge wie convertToPolyline
    const closed = s.type === "rect" || !!s.closed, n = pts.length;
    if (types.includes("pt") && s.type !== "rect") pts.forEach((p, i) => take({ pick: { t: "pt", ref: { id: s.id, i } }, d: Math.hypot(world.x - p.x, world.y - p.y), s, p }, ptTol, ptTol));
    if (types.includes("seg")) for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      if (l2 < 1e-12) continue;
      const u = Math.max(0, Math.min(1, ((world.x - a.x) * dx + (world.y - a.y) * dy) / l2));
      take({ pick: { t: "seg", ref: { id: s.id, i, j: (i + 1) % n } }, d: Math.hypot(world.x - a.x - dx * u, world.y - a.y - dy * u), s, a, b }, segTol, 0);
    }
  }
  return best;
}

export function conMove(world: Pt) {
  const step = STEPS[kind()][conTool.picks.length];
  const f = step ? findAt(world, step) : null;
  conTool.hover = f ? { pick: f.pick, a: f.a, b: f.b, p: f.p, c: f.c, r: f.r } : null;
}

const samePick = (a: Pick, b: Pick) => a.t === b.t && a.ref.id === b.ref.id && (a.t === "cir" || (a.ref as any).i === (b.ref as any).i);

/** Klick mit dem Werkzeug: true = Zeichnung geändert. ask: Wert-Eingabe an der Maus (Text, null = abgebrochen) */
export function conClick(world: Pt, ask: (initial: string, done: (text: string | null) => void) => void): boolean {
  const k = kind(), step = STEPS[k][conTool.picks.length];
  const f = findAt(world, step);
  if (!f) { toolLog(t(step.length === 1 && step[0] === "pt" ? "con.pickPoint" : step.includes("seg") ? "con.pickSeg" : "con.pickCircle")); return false; }
  if (conTool.picks.some(p => samePick(p, f.pick))) return false;
  if (f.pick.t !== "cir" && f.s.type === "rect") convertToPolyline(f.s);
  conTool.picks.push(f.pick);
  if (conTool.picks.length < STEPS[k].length) return false;

  const picks = conTool.picks;
  conTool.picks = [];
  const map = byId();
  const first = picks[0].ref.id;
  if (k === "len") {
    const p = picks[0];
    if (p.t === "cir") {
      const d = ((circleOf(map.get(p.ref.id))?.r ?? 0) * 2) / MM_TO_PIXEL;
      ask(numText(d), txt => { const mm = txt === null ? NaN : typedLen(txt.replace(/^[øØ⌀]\s*/, ""), isInch()); if (mm > 0) addCon({ k: "rad", c: p.ref, v: (mm / 2) * MM_TO_PIXEL }, [first]); });
    } else if (p.t === "seg") {
      const pts = map.get(p.ref.id).points;
      const cur = Math.hypot(pts[p.ref.j].x - pts[p.ref.i].x, pts[p.ref.j].y - pts[p.ref.i].y) / MM_TO_PIXEL;
      ask(numText(cur), txt => { const mm = txt === null ? NaN : typedLen(txt, isInch()); if (mm > 0) addCon({ k: "len", a: p.ref, v: mm * MM_TO_PIXEL }, [first]); });
    }
    return false;
  }
  if (k === "ang") {
    const a = picks[0].ref as SegRef, b = picks[1].ref as SegRef;
    ask(String(+angleOf(a, b, map).toFixed(2)), txt => { const v = txt === null ? NaN : typedAngle(txt); if (Number.isFinite(v)) addCon({ k: "ang", a, b, v }, [first]); });
    return false;
  }
  const c = build(k, picks, map);
  if (typeof c === "string") { toolLog(t(c)); return false; }
  return addCon(c, [first]);
}

const numText = (mm: number) => String(+(isInch() ? mm / 25.4 : mm).toFixed(isInch() ? 4 : 3));

/** Winkel von Strecke a nach b in Grad (gegen den Uhrzeigersinn, 0…180) */
function angleOf(a: SegRef, b: SegRef, map: Map<string, any>): number {
  const pa = map.get(a.id).points, pb = map.get(b.id).points;
  const d = { x: pa[a.j].x - pa[a.i].x, y: pa[a.j].y - pa[a.i].y }, e = { x: pb[b.j].x - pb[b.i].x, y: pb[b.j].y - pb[b.i].y };
  let deg = (Math.atan2(d.x * e.y - d.y * e.x, d.x * e.x + d.y * e.y) * 180) / Math.PI;
  if (deg < 0) deg += 180;
  return deg;
}

/** Bedingung aus den Klicks – oder ein Text-Schlüssel, warum es nicht geht */
function build(k: ConKind, p: Pick[], map: Map<string, any>): GCon | string {
  const [a, b] = p;
  switch (k) {
    case "h": case "v": return { k, a: a.ref as SegRef };
    case "par": case "perp": return { k, a: a.ref as SegRef, b: b.ref as SegRef };
    case "eq":
      if (a.t !== b.t) return "con.mixEq";
      return a.t === "cir" ? { k: "eqR", c: a.ref as CirRef, d: b.ref as CirRef } : { k: "eq", a: a.ref as SegRef, b: b.ref as SegRef };
    case "coin": return a.ref.id === b.ref.id ? "con.samePoint" : { k: "coin", p: a.ref as PtRef, q: b.ref as PtRef };
    case "fix": { const pt = vec(map.get(a.ref.id))[(a.ref as PtRef).i]; return { k: "fix", p: a.ref as PtRef, at: { ...pt } }; }
    case "on":
      if (a.ref.id === b.ref.id) return "con.sameShape";
      return b.t === "cir" ? { k: "onCirc", p: a.ref as PtRef, c: b.ref as CirRef } : { k: "onLine", p: a.ref as PtRef, a: b.ref as SegRef };
    case "tan": {
      if (a.t === "seg" && b.t === "seg") return "con.tanNeedsCircle";
      if (a.t === "cir" && b.t === "cir") {
        if (a.ref.id === b.ref.id) return "con.sameShape";
        const k1 = circleOf(map.get(a.ref.id)), k2 = circleOf(map.get(b.ref.id));
        if (!k1 || !k2) return "con.pickCircle";
        const d = Math.hypot(k1.c.x - k2.c.x, k1.c.y - k2.c.y);
        return { k: "tanC", c: a.ref as CirRef, d: b.ref as CirRef, inner: d < Math.max(k1.r, k2.r) };
      }
      const seg = (a.t === "seg" ? a : b).ref as SegRef, cir = (a.t === "cir" ? a : b).ref as CirRef;
      return { k: "tanL", a: seg, c: cir };
    }
    case "conc": return a.ref.id === b.ref.id ? "con.sameShape" : { k: "conc", c: a.ref as CirRef, d: b.ref as CirRef };
    default: return "con.pickSeg";
  }
}

/** Bedingung setzen und lösen. heavyIds: diese Formen bleiben eher stehen (die zuerst angeklickte) */
export function addCon(c: GCon, heavyIds: string[]): boolean {
  prune();
  const map = byId();
  const ids = idsOf(c);
  const ns: Record<string, number> = {};
  for (const id of ids) ns[id] = nsOf(map.get(id));
  const stored: Stored = { ...c, ns } as Stored;
  const heavy = ids.length > 1 ? new Set(heavyIds) : new Set<string>();
  if (!solveAndApply(ids, [stored], id => (heavy.has(id) ? 20 : 1))) { toolLog(t("con.conflict")); return false; }
  const owner = map.get(ids[0]);
  owner.gcons = [...(owner.gcons || []), stored];
  toolLog(t("con.added", { k: t("con.k." + uiKind(c)) }));
  return true;
}

/** Art in der Leiste zu einer gespeicherten Bedingung (für Meldungen) */
function uiKind(c: GCon): ConKind {
  switch (c.k) {
    case "eqR": return "eq";
    case "rad": return "len";
    case "onLine": case "onCirc": return "on";
    case "tanL": case "tanC": return "tan";
    default: return c.k as ConKind;
  }
}

// ---------------------------------------------------------------------
// Nachrechnen nach Punkte ziehen und Verschieben
// ---------------------------------------------------------------------

/**
 * Nach dem Ziehen eines Punkts (Werkzeug Punkte): die Bedingungen nachrechnen, der gezogene Punkt bleibt bei der Maus.
 * Geht das nicht (z. B. gegen „Festhalten“), springt die Form zurück auf prev.
 */
export function conAfterNodeMove(id: string, idx: number, prev: Pt[]) {
  if (!hasCons(id)) return;
  if (!solveAndApply([id], [], (sid, i) => (sid === id && i === idx ? 1e6 : 1))) writeBack(byId().get(id), prev.map(p => ({ ...p })));
}

/** Nach dem Verschieben mit der Auswahl: verbundene Formen folgen (die verschobenen bleiben, wo sie hingelegt wurden) */
export function conAfterMove(ids: string[]) {
  const moved = new Set(ids.filter(hasCons));
  if (!moved.size) return;
  if (!solveAndApply([...moved], [], id => (moved.has(id) ? 1e4 : 1))) toolLog(t("con.brokenByMove"));
}

// ---------------------------------------------------------------------
// Zeichen an den Strecken
// ---------------------------------------------------------------------

const GLYPH: Record<string, string> = {
  h: "H", v: "V", par: "∥", perp: "⊥", eq: "=", eqR: "=", coin: "●", fix: "■", onLine: "∘", onCirc: "∘", tanL: "T", tanC: "T", conc: "◎"
};
let glyphs: { x: number; y: number; w: number; h: number; owner: string; idx: number }[] = [];

export function conAt(sx: number, sy: number): { owner: string; idx: number } | null {
  for (let i = glyphs.length - 1; i >= 0; i--) {
    const g = glyphs[i];
    if (sx >= g.x - 2 && sx <= g.x + g.w + 2 && sy >= g.y - 2 && sy <= g.y + g.h + 2) return { owner: g.owner, idx: g.idx };
  }
  return null;
}

function glyphText(c: GCon): string {
  if (c.k === "len") return fmtLenShort(c.v / MM_TO_PIXEL, 2);
  if (c.k === "rad") return "Ø" + fmtLenShort((c.v * 2) / MM_TO_PIXEL, 2);
  if (c.k === "ang") return `${+c.v.toFixed(2)}°`;
  return GLYPH[c.k] ?? "?";
}

/** Wo die Zeichen einer Bedingung stehen (Welt) und in welche Richtung sie von der Linie weg rücken */
function spots(c: GCon, shapes: Shapes): { p: Pt; nx: number; ny: number }[] {
  const seg = (s: SegRef) => { const pts = shapes.get(s.id)!, a = pts[s.i], b = pts[s.j]; return { p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, nx: -(b.y - a.y), ny: b.x - a.x }; };
  const cir = (r: CirRef) => {
    const v = shapes.get(r.id)!;
    if (r.arc) return { p: v[2], nx: 0, ny: 1 }; // Bogen: Zeichen am Punkt auf dem Bogen
    return { p: { x: v[0].x, y: v[0].y + v[1].x }, nx: 0, ny: 1 };
  };
  const pt = (r: PtRef) => ({ p: shapes.get(r.id)![r.i], nx: 1, ny: 1 });
  switch (c.k) {
    case "h": case "v": case "len": return [seg(c.a)];
    case "par": case "perp": case "eq": case "ang": return [seg(c.a), seg(c.b)];
    case "coin": case "fix": case "onLine": case "onCirc": return [pt(c.p)];
    case "rad": return [cir(c.c)];
    case "conc": case "eqR": case "tanC": return [cir(c.c), cir(c.d)];
    case "tanL": return [seg(c.a), cir(c.c)];
  }
}

export function drawConstraints(ctx: CanvasRenderingContext2D, tool: string) {
  glyphs = [];
  const list = allCons();
  const map = byId();
  if (list.length) {
    const shapes: Shapes = new Map();
    for (const e of list) for (const id of Object.keys(e.c.ns)) if (!shapes.has(id)) shapes.set(id, vec(map.get(id)));
    ctx.save();
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const used: { x: number; y: number }[] = [];
    for (const e of list) {
      const ok = satisfied(e.c, shapes, 0.002 * MM_TO_PIXEL);
      const sel = conTool.sel;
      const selected = !!sel && sel.owner === e.owner.id && sel.idx === e.idx;
      const text = glyphText(e.c);
      for (const sp of spots(e.c, shapes)) {
        const c = toScreen(sp.p.x, sp.p.y);
        const nl = Math.hypot(sp.nx, sp.ny) || 1;
        let x = c.x + (sp.nx / nl) * 12, y = c.y - (sp.ny / nl) * 12;
        while (used.some(u => Math.abs(u.x - x) < 14 && Math.abs(u.y - y) < 14)) x += 15;
        used.push({ x, y });
        const w = Math.max(14, ctx.measureText(text).width + 6), h = 14;
        ctx.fillStyle = selected ? "rgba(255, 225, 77, 0.95)" : ok ? "rgba(40, 110, 170, 0.92)" : "rgba(200, 50, 50, 0.95)";
        ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, 3); ctx.fill();
        ctx.fillStyle = selected ? "#222" : "#fff";
        ctx.fillText(text, x, y + 0.5);
        glyphs.push({ x: x - w / 2, y: y - h / 2, w, h, owner: e.owner.id, idx: e.idx });
      }
    }
    drawFreedom(ctx, list, map);
    ctx.restore();
  }

  if (tool !== "constrain") return;
  // Vorschau: angeklickte (gelb) und überfahrene (blau) Strecke, Punkt oder Kreis
  ctx.save();
  ctx.lineWidth = 3;
  const draw = (h: { a?: Pt; b?: Pt; p?: Pt; c?: Pt; r?: number }, col: string) => {
    ctx.strokeStyle = col; ctx.fillStyle = col;
    if (h.a && h.b) { const p = toScreen(h.a.x, h.a.y), q = toScreen(h.b.x, h.b.y); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
    if (h.p) { const s = toScreen(h.p.x, h.p.y); ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, Math.PI * 2); ctx.fill(); }
    if (h.c && h.r !== undefined) { const s = toScreen(h.c.x, h.c.y), e = toScreen(h.c.x + h.r, h.c.y); ctx.beginPath(); ctx.arc(s.x, s.y, Math.abs(e.x - s.x), 0, Math.PI * 2); ctx.stroke(); }
  };
  for (const pk of conTool.picks) {
    const s = map.get(pk.ref.id);
    if (!s) continue;
    if (pk.t === "cir") { const k = circleOf(s); if (k) draw({ c: k.c, r: k.r }, "#ffe14d"); }
    else if (pk.t === "pt") draw({ p: vec(s)[pk.ref.i] }, "#ffe14d");
    else draw({ a: s.points[pk.ref.i], b: s.points[pk.ref.j] }, "#ffe14d");
  }
  if (conTool.hover) draw(conTool.hover, "rgba(94, 200, 255, 0.9)");
  ctx.restore();
}

// ---------------------------------------------------------------------
// Wie weit ist die Skizze bestimmt? (je Gruppe verbundener Formen)
// ---------------------------------------------------------------------

const freeCache = new Map<string, number>();

function drawFreedom(ctx: CanvasRenderingContext2D, list: { owner: any; idx: number; c: Stored }[], map: Map<string, any>) {
  // Gruppen: Formen, die über Bedingungen zusammenhängen
  const parent = new Map<string, string>();
  const find = (a: string): string => { while (parent.get(a) !== a) a = parent.get(a)!; return a; };
  for (const e of list) { const ids = Object.keys(e.c.ns); for (const id of ids) if (!parent.has(id)) parent.set(id, id); for (const id of ids.slice(1)) parent.set(find(id), find(ids[0])); }
  const groups = new Map<string, { ids: Set<string>; cons: Stored[] }>();
  for (const e of list) {
    const root = find(Object.keys(e.c.ns)[0]);
    if (!groups.has(root)) groups.set(root, { ids: new Set(), cons: [] });
    const g = groups.get(root)!;
    Object.keys(e.c.ns).forEach(id => g.ids.add(id));
    g.cons.push(e.c);
  }
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  for (const g of groups.values()) {
    const shapes: Shapes = new Map([...g.ids].map(id => [id, vec(map.get(id))]));
    const circles = new Set([...g.ids].filter(id => isCircle(map.get(id))));
    // Merkmal für den Zwischenspeicher: Punkte (gerundet) und Bedingungen
    let sig = "";
    for (const [id, pts] of shapes) sig += id + ":" + pts.length + ":" + pts.reduce((a, q) => a + q.x * 1.3 + q.y * 0.7, 0).toFixed(4) + ";";
    sig += JSON.stringify(g.cons.map(c => [c.k, (c as any).v ?? 0]));
    let free = freeCache.get(sig);
    if (free === undefined) {
      free = freedom(shapes, g.cons, circles);
      if (importInApp()) checkImport("sketch_freedom", { shapes: [...shapes], cons: g.cons, circles: [...circles] }, free);
      if (freeCache.size > 200) freeCache.clear();
      freeCache.set(sig, free);
    }
    let x0 = Infinity, y1 = -Infinity;
    for (const id of g.ids) { const b = shapeBounds(map.get(id)); if (b) { x0 = Math.min(x0, b.minX); y1 = Math.max(y1, b.maxY); } }
    if (!isFinite(x0)) continue;
    const p = toScreen(x0, y1);
    const text = free <= 0 ? "✓ " + t("con.full") : t("con.free", { n: free });
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = free <= 0 ? "rgba(30, 140, 80, 0.92)" : "rgba(190, 120, 20, 0.92)";
    ctx.beginPath(); ctx.roundRect(p.x, p.y - 30, w, 16, 4); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(text, p.x + 5, p.y - 18);
  }
}

/** Text für die Statuszeile: was als Nächstes angeklickt wird */
export function conPrompt(): string {
  const k = kind(), n = conTool.picks.length, steps = STEPS[k], step = steps[n] ?? steps[0];
  const what = step.length > 1 ? (step.includes("pt") ? "any" : step.includes("seg") ? "segOrCircle" : "circle") : step[0] === "seg" ? "seg" : step[0] === "pt" ? "point" : "circle";
  return t(`con.prompt.${what}`, { k: t("con.k." + k), n: n + 1, of: steps.length });
}

// ---------------------------------------------------------------------
// Gewählte Bedingung: löschen, Wert ändern, wieder herstellen
// ---------------------------------------------------------------------

export function conDeleteSelected(): boolean {
  const sel = conTool.sel;
  if (!sel) return false;
  const s = byId().get(sel.owner);
  conTool.sel = null;
  if (!s?.gcons?.[sel.idx]) return false;
  s.gcons = s.gcons.filter((_: any, i: number) => i !== sel.idx);
  if (!s.gcons.length) delete s.gcons;
  app().shapes = [...app().shapes];
  toolLog(t("con.deleted"));
  return true;
}

/** Doppelklick auf ein Zeichen: Länge/Durchmesser/Winkel neu eingeben, sonst die Bedingung wieder herstellen */
export function conEdit(ref: { owner: string; idx: number }, ask: (initial: string, done: (text: string | null) => void) => void, done: () => void) {
  const s = byId().get(ref.owner);
  const c: Stored | undefined = s?.gcons?.[ref.idx];
  if (!c) return;
  const ids = Object.keys(c.ns);
  const change = (apply: () => void, undo: () => void, msg: string) => {
    apply();
    if (!solveAndApply(ids, [], () => 1)) { undo(); toolLog(t("con.conflict")); } else toolLog(msg);
    done();
  };
  if (c.k === "len" || c.k === "rad" || c.k === "ang") {
    const old = c.v;
    const initial = c.k === "len" ? numText(c.v / MM_TO_PIXEL) : c.k === "rad" ? numText((c.v * 2) / MM_TO_PIXEL) : String(+c.v.toFixed(3));
    ask(initial, txt => {
      if (txt === null) return;
      if (c.k === "ang") {
        const v = typedAngle(txt);
        if (Number.isFinite(v)) change(() => { c.v = v; }, () => { c.v = old; }, t("con.angSet", { v: +v.toFixed(3) }));
        return;
      }
      const mm = typedLen(txt.replace(/^[øØ⌀]\s*/, ""), isInch());
      if (!(mm > 0)) return;
      const v = c.k === "rad" ? (mm / 2) * MM_TO_PIXEL : mm * MM_TO_PIXEL;
      change(() => { c.v = v; }, () => { c.v = old; }, t("con.lenSet", { v: fmtLenU(mm) }));
    });
    return;
  }
  if (solveAndApply(ids, [], () => 1)) toolLog(t("con.restored")); else toolLog(t("con.conflict"));
  done();
}

/** kleines Eingabefeld an der Maus (Bildschirm-Koordinaten); done(null) = abgebrochen */
export function valueInput(clientX: number, clientY: number, initial: string, done: (text: string | null) => void) {
  document.getElementById("con-edit")?.remove();
  const inp = document.createElement("input");
  inp.id = "con-edit"; inp.type = "text"; inp.className = "dim-edit";
  inp.value = initial;
  inp.style.left = `${clientX + 12}px`; inp.style.top = `${clientY - 10}px`;
  document.body.appendChild(inp);
  inp.focus(); inp.select();
  let finished = false;
  const finish = (ok: boolean) => {
    if (finished) return;
    finished = true;
    const v = inp.value;
    inp.remove();
    done(ok ? v : null);
  };
  inp.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  inp.addEventListener("blur", () => finish(false));
}
