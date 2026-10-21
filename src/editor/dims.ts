/**
 * BEMASSUNG UND BEDINGUNGEN
 *
 * Abstandsmaß (Bedingung): hängt an der abhängigen Form als „cons“:
 *   { axis: "x" | "y", ref: Bezugsform-ID, rk/ok: Bezugspunkt an Bezugsform/eigener Form
 *     (x: "l" links, "c" Mitte, "r" rechts – y: "b" unten, "c" Mitte, "t" oben),
 *     value: Abstand (Welt-Pixel, eigener Punkt − Bezugspunkt), pos: Lage der Maßlinie, lastRef: zuletzt gesehener
 *     Bezugspunkt, force: beim nächsten Lösen sofort durchsetzen, center: „mittig“ (ohne Maßlinie) }
 *   Wird die BEZUGSFORM verschoben/verändert, wandert die abhängige Form (mit ihrer Gruppe) mit.
 *   Wird die ABHÄNGIGE Form selbst verschoben, passt sich nur der Wert an – nichts springt zurück.
 * Größenmaß: „dims“ an der Form: { axis: "x" | "y", pos } – zeigt Breite/Höhe, Doppelklick = neue Größe.
 * Maße werden mit dem Projekt gespeichert und sind Teil von Rückgängig.
 *
 * Werkzeug „Bemaßung“ (D): Form A anklicken, Form B anklicken (Ecke/Kante/Mitte rastet ein), dann die Maßlinie
 * platzieren – Maus seitlich = senkrechtes Maß, Maus darüber/darunter = waagerechtes Maß. Dieselbe Form zweimal =
 * Größenmaß. Maßzahl anklicken = auswählen (Entf löscht), Doppelklick auf die Zahl = Wert eingeben.
 */
import { app, toScreen } from "./editorState";
import { Pt, Bounds, MM_TO_PIXEL, shapeBounds, translateShape, scaleShape, shapeToPaths, pointInPath, pathArea } from "../shapeTransform";

type KX = "l" | "c" | "r";
type KY = "b" | "c" | "t";
export interface Cons { axis: "x" | "y"; ref: string; rk: KX | KY; ok: KX | KY; value: number; pos: number; lastRef?: number; force?: boolean; center?: boolean }
export interface SizeDim { axis: "x" | "y"; pos: number }

const ax = (b: Bounds, k: string) => (k === "l" ? b.minX : k === "r" ? b.maxX : (b.minX + b.maxX) / 2);
const ay = (b: Bounds, k: string) => (k === "b" ? b.minY : k === "t" ? b.maxY : (b.minY + b.maxY) / 2);
const anchor = (b: Bounds, axis: "x" | "y", k: string) => (axis === "x" ? ax(b, k) : ay(b, k));

/** Form samt Gruppe verschieben */
function moveUnit(s: any, dx: number, dy: number) {
  const list = s.groupId ? app().shapes.filter((q: any) => q.groupId === s.groupId) : [s];
  for (const q of list) translateShape(q, dx, dy);
}

// ---------------------------------------------------------------------
// Lösen (vor jedem Zeichnen, main.ts)
// ---------------------------------------------------------------------

export function solveConstraints(): boolean {
  const st = app();
  const byId = new Map<string, any>(st.shapes.map((s: any) => [s.id, s]));
  let changed = false;
  for (let pass = 0; pass < 5; pass++) {
    let moved = false;
    for (const s of st.shapes) {
      if (!s.cons?.length) continue;
      // Bezugsform weg (gelöscht, anderes Bett) oder in derselben Gruppe → Bedingung entfällt
      s.cons = s.cons.filter((c: Cons) => { const r = byId.get(c.ref); return r && r !== s && !(s.groupId && r.groupId === s.groupId); });
      for (const c of s.cons as Cons[]) {
        const rb = shapeBounds(byId.get(c.ref)), ob = shapeBounds(s);
        if (!rb || !ob) continue;
        const cur = anchor(rb, c.axis, c.rk), own = anchor(ob, c.axis, c.ok);
        if (c.force || (c.lastRef !== undefined && Math.abs(cur - c.lastRef) > 1e-6)) {
          const d = cur + c.value - own;
          if (Math.abs(d) > 1e-6) { moveUnit(s, c.axis === "x" ? d : 0, c.axis === "y" ? d : 0); moved = true; }
          c.force = false;
        } else {
          c.value = own - cur; // abhängige Form wurde selbst verschoben → Maß folgt
        }
        c.lastRef = cur;
      }
    }
    if (!moved) break;
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------
// Anlegen, ändern, löschen
// ---------------------------------------------------------------------

/** nächster der 9 Bezugspunkte (Ecken, Kantenmitten, Mitte) */
export function nearestAnchor(s: any, p: Pt): { kx: KX; ky: KY; pt: Pt } | null {
  const b = shapeBounds(s);
  if (!b) return null;
  let best: { kx: KX; ky: KY; pt: Pt } | null = null, bd = Infinity;
  for (const kx of ["l", "c", "r"] as KX[]) for (const ky of ["b", "c", "t"] as KY[]) {
    const pt = { x: ax(b, kx), y: ay(b, ky) }, d = Math.hypot(pt.x - p.x, pt.y - p.y);
    if (d < bd) { bd = d; best = { kx, ky, pt }; }
  }
  return best;
}

/** Abstandsmaß: Form b hängt an Form a */
export function addDistance(a: any, ak: { kx: KX; ky: KY }, b: any, bk: { kx: KX; ky: KY }, axis: "x" | "y", pos: number) {
  const ab = shapeBounds(a), bb = shapeBounds(b);
  if (!ab || !bb) return;
  const rk = axis === "x" ? ak.kx : ak.ky, ok = axis === "x" ? bk.kx : bk.ky;
  const c: Cons = { axis, ref: a.id, rk, ok, value: anchor(bb, axis, ok) - anchor(ab, axis, rk), pos };
  b.cons = [...(b.cons || []).filter((q: Cons) => !(q.ref === a.id && q.axis === axis)), c];
}

export function addSize(s: any, axis: "x" | "y", pos: number) {
  s.dims = [...(s.dims || []).filter((d: SizeDim) => d.axis !== axis), { axis, pos }];
}

/** Mittig fixieren: alle Teile außer der Bezugsform bleiben mittig darauf (x und y) */
export function centerOn(ref: any, others: any[]): number {
  let n = 0;
  for (const s of others) {
    if (s === ref || (s.groupId && s.groupId === ref.groupId)) continue;
    s.cons = (s.cons || []).filter((c: Cons) => c.ref !== ref.id);
    for (const axis of ["x", "y"] as const) s.cons.push({ axis, ref: ref.id, rk: "c", ok: "c", value: 0, pos: 0, force: true, center: true });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------
// Anzeige + Anklicken der Maßzahlen
// ---------------------------------------------------------------------

export interface DimRef { kind: "cons" | "size"; shapeId: string; idx: number }
interface Label { r: { x: number; y: number; w: number; h: number }; ref: DimRef }
let labels: Label[] = [];
export const dimSel = { cur: null as DimRef | null };

const same = (a: DimRef | null, b: DimRef) => !!a && a.kind === b.kind && a.shapeId === b.shapeId && a.idx === b.idx;
const fmt = (px: number) => String(+(px / MM_TO_PIXEL).toFixed(2)).replace(".", ",");

/** Maßzahl unter der Maus (Bildschirm-Pixel) */
export function dimAt(sx: number, sy: number): DimRef | null {
  for (let i = labels.length - 1; i >= 0; i--) {
    const { r, ref } = labels[i];
    if (sx >= r.x - 3 && sx <= r.x + r.w + 3 && sy >= r.y - 3 && sy <= r.y + r.h + 3) return ref;
  }
  return null;
}

export function drawDims(ctx: CanvasRenderingContext2D) {
  labels = [];
  const st = app();
  const byId = new Map<string, any>(st.shapes.map((s: any) => [s.id, s]));
  ctx.save();
  ctx.font = "600 11px system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const s of st.shapes) {
    const ob = (s.cons?.length || s.dims?.length) ? shapeBounds(s) : null;
    if (!ob) continue;
    (s.cons || []).forEach((c: Cons, idx: number) => {
      const r = byId.get(c.ref), rb = r ? shapeBounds(r) : null;
      if (!rb) return;
      const ref: DimRef = { kind: "cons", shapeId: s.id, idx };
      if (c.center) {
        // mittig: kleines Zeichen in der Mitte der Form (nur einmal je Form, bei der x-Bedingung)
        if (c.axis !== "x") return;
        const p = toScreen((ob.minX + ob.maxX) / 2, (ob.minY + ob.maxY) / 2);
        ctx.strokeStyle = "#4dabf7"; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.moveTo(p.x - 9, p.y); ctx.lineTo(p.x + 9, p.y); ctx.moveTo(p.x, p.y - 9); ctx.lineTo(p.x, p.y + 9); ctx.stroke();
        label(ctx, "⊕", p.x + 16, p.y - 12, ref);
        return;
      }
      const a = anchor(rb, c.axis, c.rk), b = anchor(ob, c.axis, c.ok);
      const ea = c.axis === "x" ? ay(rb, "c") : ax(rb, "c"), eb = c.axis === "x" ? ay(ob, "c") : ax(ob, "c");
      dimLine(ctx, c.axis, a, b, ea, eb, c.pos, fmt(Math.abs(c.value)), ref);
    });
    (s.dims || []).forEach((d: SizeDim, idx: number) => {
      const a = d.axis === "x" ? ob.minX : ob.minY, b = d.axis === "x" ? ob.maxX : ob.maxY;
      const e = d.axis === "x" ? (d.pos > ob.maxY ? ob.maxY : ob.minY) : (d.pos > ob.maxX ? ob.maxX : ob.minX);
      dimLine(ctx, d.axis, a, b, e, e, d.pos, fmt(b - a), { kind: "size", shapeId: s.id, idx });
    });
  }
  ctx.restore();
}

/** Maßlinie entlang axis von a nach b (Welt), Hilfslinien von ea/eb (andere Achse) bis zur Linie bei pos */
function dimLine(ctx: CanvasRenderingContext2D, axis: "x" | "y", a: number, b: number, ea: number, eb: number, pos: number, text: string, ref: DimRef) {
  const P = (u: number, v: number) => (axis === "x" ? toScreen(u, v) : toScreen(v, u));
  const sel = same(dimSel.cur, ref);
  ctx.strokeStyle = ctx.fillStyle = sel ? "#34d17b" : "#4dabf7";
  ctx.lineWidth = 1;
  const pa = P(a, pos), pb = P(b, pos);
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  const xa = P(a, ea), xb = P(b, eb);
  ctx.moveTo(xa.x, xa.y); ctx.lineTo(pa.x, pa.y); ctx.moveTo(xb.x, xb.y); ctx.lineTo(pb.x, pb.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  // Pfeilspitzen
  const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1, ux = (pb.x - pa.x) / len, uy = (pb.y - pa.y) / len;
  for (const [p, s] of [[pa, 1], [pb, -1]] as [Pt, number][]) {
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + s * ux * 7 - uy * 3, p.y + s * uy * 7 + ux * 3);
    ctx.lineTo(p.x + s * ux * 7 + uy * 3, p.y + s * uy * 7 - ux * 3);
    ctx.closePath(); ctx.fill();
  }
  label(ctx, text, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2, ref);
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, ref: DimRef) {
  const w = ctx.measureText(text).width + 8, h = 16;
  const sel = same(dimSel.cur, ref);
  ctx.fillStyle = sel ? "#34d17b" : "#1b2a3a";
  ctx.fillRect(x - w / 2, y - h / 2, w, h);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x, y + 0.5);
  labels.push({ r: { x: x - w / 2, y: y - h / 2, w, h }, ref });
}

export function deleteDim(ref: DimRef): boolean {
  const s = app().shapes.find((q: any) => q.id === ref.shapeId);
  if (!s) return false;
  if (ref.kind === "size") { s.dims?.splice(ref.idx, 1); return true; }
  const c: Cons | undefined = s.cons?.[ref.idx];
  if (!c) return false;
  // „mittig“ besteht aus zwei Bedingungen (x und y) – beide entfernen
  s.cons = c.center ? s.cons.filter((q: Cons) => !(q.center && q.ref === c.ref)) : s.cons.filter((_: Cons, i: number) => i !== ref.idx);
  return true;
}

/** Wert einer Maßzahl (mm) */
export function dimValue(ref: DimRef): number | null {
  const s = app().shapes.find((q: any) => q.id === ref.shapeId);
  if (!s) return null;
  if (ref.kind === "cons") { const c = s.cons?.[ref.idx]; return c && !c.center ? Math.abs(c.value) / MM_TO_PIXEL : null; }
  const d: SizeDim | undefined = s.dims?.[ref.idx], b = shapeBounds(s);
  return d && b ? (d.axis === "x" ? b.maxX - b.minX : b.maxY - b.minY) / MM_TO_PIXEL : null;
}

/** Neuen Wert (mm) setzen: Abstand → abhängige Form verschieben, Größe → Form skalieren */
export function setDimValue(ref: DimRef, mm: number): boolean {
  if (!(mm >= 0)) return false;
  const s = app().shapes.find((q: any) => q.id === ref.shapeId);
  if (!s) return false;
  if (ref.kind === "cons") {
    const c: Cons | undefined = s.cons?.[ref.idx];
    if (!c || c.center) return false;
    c.value = Math.sign(c.value || 1) * mm * MM_TO_PIXEL; // Richtung bleibt
    c.force = true;
    solveConstraints();
    return true;
  }
  const d: SizeDim | undefined = s.dims?.[ref.idx], b = shapeBounds(s);
  if (!d || !b) return false;
  const cur = d.axis === "x" ? b.maxX - b.minX : b.maxY - b.minY;
  if (cur < 1e-6 || mm <= 0) return false;
  const f = (mm * MM_TO_PIXEL) / cur;
  // Kreise bleiben rund, sonst nur in Maß-Richtung; fest bleibt die linke/untere Kante
  if (s.type === "circle") scaleShape(s, b.minX, b.minY, f, f);
  else scaleShape(s, b.minX, b.minY, d.axis === "x" ? f : 1, d.axis === "y" ? f : 1);
  return true;
}

// ---------------------------------------------------------------------
// Werkzeug „Bemaßung“
// ---------------------------------------------------------------------

export const dimTool = {
  a: null as null | { s: any; k: { kx: KX; ky: KY }; pt: Pt },
  b: null as null | { s: any; k: { kx: KX; ky: KY }; pt: Pt },
  mouse: { x: 0, y: 0 } as Pt
};

export function dimCancel() { dimTool.a = null; dimTool.b = null; }

/** Ausrichtung beim Platzieren: Maus eher seitlich der beiden Punkte → senkrechtes Maß */
function placement(): { axis: "x" | "y"; pos: number } | null {
  const { a, b, mouse } = dimTool;
  if (!a || !b) return null;
  const p = a.pt, q = b.pt;
  const outY = mouse.y > Math.max(p.y, q.y) || mouse.y < Math.min(p.y, q.y);
  const outX = mouse.x > Math.max(p.x, q.x) || mouse.x < Math.min(p.x, q.x);
  const axis: "x" | "y" = outY && !outX ? "x" : outX && !outY ? "y" : Math.abs(q.x - p.x) >= Math.abs(q.y - p.y) ? "x" : "y";
  return { axis, pos: axis === "x" ? mouse.y : mouse.x };
}

/** Form für die Bemaßung: Kontur unter der Maus, sonst die kleinste geschlossene Form, in der der Punkt liegt
 *  (so trifft ein Klick in die Mitte einer Bohrung die Bohrung) */
export function pickForDim(p: Pt, hit: any | null): any | null {
  if (hit) return hit;
  let best: any = null, ba = Infinity;
  for (const s of app().shapes) {
    const path = shapeToPaths(s).find(q => q.closed && q.pts.length >= 3);
    if (!path || !pointInPath(p.x, p.y, path.pts)) continue;
    const a = Math.abs(pathArea(path.pts));
    if (a < ba) { ba = a; best = s; }
  }
  return best;
}

/** Klick im Bemaßungs-Werkzeug; hit = Form unter der Maus. Gibt true zurück, wenn ein Maß angelegt wurde */
export function dimClick(world: Pt, hit0: any | null): boolean {
  const hit = dimTool.a && dimTool.b ? hit0 : pickForDim(world, hit0);
  if (!dimTool.a) {
    if (!hit) return false;
    const k = nearestAnchor(hit, world);
    if (k) dimTool.a = { s: hit, k, pt: k.pt };
    return false;
  }
  if (!dimTool.b) {
    if (!hit) return false;
    const k = nearestAnchor(hit, world);
    if (!k) return false;
    dimTool.b = { s: hit, k, pt: k.pt };
    // dieselbe Form: Größenmaß – Ecken als Endpunkte, damit die Vorschau Breite/Höhe zeigt
    if (hit === dimTool.a.s) {
      const b = shapeBounds(hit)!;
      dimTool.a.pt = { x: b.minX, y: b.minY };
      dimTool.b.pt = { x: b.maxX, y: b.maxY };
    }
    return false;
  }
  const pl = placement();
  const { a, b } = dimTool;
  dimCancel();
  if (!pl || !a || !b) return false;
  if (a.s === b.s) addSize(a.s, pl.axis, pl.pos);
  else addDistance(a.s, a.k, b.s, b.k, pl.axis, pl.pos);
  return true;
}

/** Vorschau beim Anlegen */
export function drawDimPreview(ctx: CanvasRenderingContext2D) {
  const { a, b } = dimTool;
  if (!a) return;
  ctx.save();
  ctx.fillStyle = "#4dabf7";
  for (const p of [a.pt, b?.pt]) if (p) { const q = toScreen(p.x, p.y); ctx.beginPath(); ctx.arc(q.x, q.y, 4, 0, Math.PI * 2); ctx.fill(); }
  const pl = placement();
  if (pl && b) {
    ctx.strokeStyle = "#4dabf7"; ctx.setLineDash([4, 3]);
    const P = (u: number, v: number) => (pl.axis === "x" ? toScreen(u, v) : toScreen(v, u));
    const ua = pl.axis === "x" ? a.pt.x : a.pt.y, ub = pl.axis === "x" ? b.pt.x : b.pt.y;
    const pa = P(ua, pl.pos), pb = P(ub, pl.pos);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "600 11px system-ui"; ctx.textAlign = "center";
    ctx.fillText(fmt(Math.abs(ub - ua)) + " mm", (pa.x + pb.x) / 2, (pa.y + pb.y) / 2 - 8);
  }
  ctx.restore();
}

/** kleines Eingabefeld über der Maßzahl; done() danach (neu zeichnen, Verlauf) */
export function editDimValue(ref: DimRef, canvas: HTMLCanvasElement, done: () => void) {
  const v = dimValue(ref);
  if (v === null) return;
  const lab = labels.find(l => same(l.ref, ref));
  const r = canvas.getBoundingClientRect();
  const k = r.width / canvas.width;
  document.getElementById("dim-edit")?.remove();
  const inp = document.createElement("input");
  inp.id = "dim-edit"; inp.type = "number"; inp.step = "0.1"; inp.min = "0";
  inp.value = String(+v.toFixed(3));
  inp.className = "dim-edit";
  inp.style.left = `${r.left + (lab ? lab.r.x + lab.r.w / 2 : 0) * k - 45}px`;
  inp.style.top = `${r.top + (lab ? lab.r.y : 0) * k - 4}px`;
  document.body.appendChild(inp);
  inp.focus(); inp.select();
  let finished = false;
  const finish = (ok: boolean) => {
    if (finished) return;
    finished = true;
    const mm = parseFloat(inp.value.replace(",", "."));
    inp.remove();
    if (ok && Number.isFinite(mm)) setDimValue(ref, mm);
    done();
  };
  inp.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  inp.addEventListener("blur", () => finish(true));
}
