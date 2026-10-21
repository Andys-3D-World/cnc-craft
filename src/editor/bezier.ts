/**
 * KURVEN MIT PUNKTEN UND TANGENTEN (Bézier)
 *
 * Eine Polylinie kann zusätzlich „bez“ haben: Knoten { x, y, hi?, ho?, smooth? } in Welt-Pixeln.
 *   hi = Tangente zum vorigen Knoten hin, ho = Tangente zum nächsten Knoten (fehlt = gerade/spitze Ecke)
 *   smooth = beim Ziehen einer Tangente dreht die Gegenseite mit (glatter Übergang)
 * Aus den Knoten wird „points“ berechnet (kubische Bézier-Kurven) – damit arbeiten G-Code, Verschachteln,
 * Versatz usw. wie bisher. Verschieben/Skalieren/Drehen nimmt die Knoten mit (shapeTransform.ts),
 * alles was „points“ direkt ändert, löscht „bez“.
 *
 * Werkzeuge:
 *   Punkte bearbeiten (N)  Kontur anklicken → Knoten zeigen. Knoten ziehen = verschieben, Tangente ziehen = Kurve
 *                          formen (Alt = nur diese Seite), Linie zwischen zwei Knoten ziehen = biegen,
 *                          Doppelklick auf die Linie = Knoten einfügen, Doppelklick auf einen Knoten = Ecke ↔ rund,
 *                          Entf = Knoten löschen
 *   Kurve zeichnen (B)     Klick = Ecke, Klicken und Ziehen = runder Knoten mit Tangenten, Klick auf den ersten
 *                          Knoten = schließen, Doppelklick/Enter = offen fertig, Esc = abbrechen
 */
import { app, toScreen, screenDist } from "./editorState";
import { Pt, MM_TO_PIXEL, createPolyline, convertToPolyline, updatePolylineBounds } from "../shapeTransform";

export interface BezNode { x: number; y: number; hi?: Pt; ho?: Pt; smooth?: boolean }

// ---------------------------------------------------------------------
// Rechnen
// ---------------------------------------------------------------------

const cubic = (a: Pt, b: Pt, c: Pt, d: Pt, t: number): Pt => {
  const u = 1 - t;
  return { x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x, y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y };
};

/** Kontrollpunkte des Abschnitts i → i+1 */
function segment(n: BezNode[], i: number): [Pt, Pt, Pt, Pt] {
  const a = n[i], b = n[(i + 1) % n.length];
  return [a, a.ho || a, b.hi || b, b];
}
const segCount = (n: BezNode[], closed: boolean) => (closed ? n.length : n.length - 1);
const isStraight = (n: BezNode[], i: number) => !n[i].ho && !n[(i + 1) % n.length].hi;

/** Knoten → Punkte (gerade Abschnitte = 1 Strecke, Kurven fein genug für ~0,02 mm) */
export function flatten(n: BezNode[], closed: boolean): Pt[] {
  const out: Pt[] = [{ x: n[0].x, y: n[0].y }];
  const tol = 0.02 * MM_TO_PIXEL;
  for (let i = 0; i < segCount(n, closed); i++) {
    const [a, b, c, d] = segment(n, i);
    let steps = 1;
    if (!isStraight(n, i)) {
      const len = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y) + Math.hypot(d.x - c.x, d.y - c.y);
      steps = Math.max(6, Math.min(400, Math.ceil(Math.sqrt(len / tol) * 1.5)));
    }
    for (let k = 1; k <= steps; k++) out.push(cubic(a, b, c, d, k / steps));
  }
  if (closed) out.pop(); // letzter = erster Punkt
  return out;
}

/** Punkte aus den Knoten neu berechnen */
export function syncPoints(s: any) {
  if (!s.bez?.length) return;
  s.points = flatten(s.bez, !!s.closed);
  updatePolylineBounds(s);
}

/** Form zum Bearbeiten vorbereiten: Kreis → 4 runde Knoten, Rechteck/Linie/Polylinie → Ecken */
export function ensureBez(s: any): boolean {
  if (s.type === "image" || s.isText) return false;
  if (s.bez?.length) return true;
  if (s.type === "circle") {
    const r = Math.abs(s.w), k = 0.5523 * r, cx = s.x, cy = s.y;
    s.bez = [
      { x: cx + r, y: cy, hi: { x: cx + r, y: cy - k }, ho: { x: cx + r, y: cy + k }, smooth: true },
      { x: cx, y: cy + r, hi: { x: cx + k, y: cy + r }, ho: { x: cx - k, y: cy + r }, smooth: true },
      { x: cx - r, y: cy, hi: { x: cx - r, y: cy + k }, ho: { x: cx - r, y: cy - k }, smooth: true },
      { x: cx, y: cy - r, hi: { x: cx - k, y: cy - r }, ho: { x: cx + k, y: cy - r }, smooth: true }
    ];
    s.type = "polyline"; s.closed = true;
    syncPoints(s);
    return true;
  }
  if (s.type === "rect" || s.type === "line") convertToPolyline(s);
  if (s.type !== "polyline" || !s.points?.length) return false;
  s.bez = s.points.map((p: Pt) => ({ x: p.x, y: p.y }));
  return true;
}

/** Abschnitt bei t teilen (de Casteljau) → neuer Knoten mit passenden Tangenten */
function insertAt(n: BezNode[], i: number, t: number) {
  const [a, b, c, d] = segment(n, i);
  const j = (i + 1) % n.length;
  if (isStraight(n, i)) { n.splice(i + 1, 0, { x: a.x + (d.x - a.x) * t, y: a.y + (d.y - a.y) * t }); return; }
  const L = (p: Pt, q: Pt) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const ab = L(a, b), bc = L(b, c), cd = L(c, d), abc = L(ab, bc), bcd = L(bc, cd), m = L(abc, bcd);
  n[i] = { ...n[i], ho: ab };
  n[j] = { ...n[j], hi: cd };
  n.splice(i + 1, 0, { x: m.x, y: m.y, hi: abc, ho: bcd, smooth: true });
}

/** nächster Punkt auf der Kontur: Abschnitt, t, Abstand (Welt) */
function nearestOnPath(n: BezNode[], closed: boolean, p: Pt): { i: number; t: number; d: number } | null {
  let best: { i: number; t: number; d: number } | null = null;
  for (let i = 0; i < segCount(n, closed); i++) {
    const [a, b, c, d] = segment(n, i);
    const steps = isStraight(n, i) ? 40 : 80;
    for (let k = 0; k <= steps; k++) {
      const q = cubic(a, b, c, d, k / steps);
      const dist = Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || dist < best.d) best = { i, t: k / steps, d: dist };
    }
  }
  return best;
}

// ---------------------------------------------------------------------
// Werkzeug „Punkte bearbeiten“
// ---------------------------------------------------------------------

type Grab = { kind: "node"; i: number } | { kind: "hi" | "ho"; i: number } | { kind: "bend"; i: number; start: BezNode[] };

export const nodeEdit = {
  targetId: null as string | null,
  sel: -1,
  grab: null as Grab | null,
  down: { x: 0, y: 0 }
};

export function nodeTarget(): any | null {
  const id = nodeEdit.targetId;
  return id ? app().shapes.find((s: any) => s.id === id) || null : null;
}

/** Abstand in Bildschirm-Pixeln zwischen Weltpunkt und Bildschirmpunkt */
const scrDist = (w: Pt, sx: number, sy: number) => { const p = toScreen(w.x, w.y); return Math.hypot(p.x - sx, p.y - sy); };

/** Maus gedrückt; hit = Form unter der Maus (aus selection.hitTest) */
export function nodeDown(world: Pt, sx: number, sy: number, hit: any | null): boolean {
  const s = nodeTarget();
  nodeEdit.down = { ...world };
  if (s?.bez) {
    const n: BezNode[] = s.bez;
    // 1. Tangenten des gewählten Knotens
    if (nodeEdit.sel >= 0 && n[nodeEdit.sel]) {
      for (const k of ["hi", "ho"] as const) {
        const h = n[nodeEdit.sel][k];
        if (h && scrDist(h, sx, sy) < 8) { nodeEdit.grab = { kind: k, i: nodeEdit.sel }; return true; }
      }
    }
    // 2. Knoten
    let bi = -1, bd = 9;
    n.forEach((p, i) => { const d = scrDist(p, sx, sy); if (d < bd) { bd = d; bi = i; } });
    if (bi >= 0) { nodeEdit.sel = bi; nodeEdit.grab = { kind: "node", i: bi }; return true; }
    // 3. Linie dazwischen → biegen
    const near = nearestOnPath(n, !!s.closed, world);
    if (near && near.d < screenDist(7)) {
      nodeEdit.grab = { kind: "bend", i: near.i, start: JSON.parse(JSON.stringify(n)) };
      return true;
    }
  }
  // andere Form anklicken → wird bearbeitet
  if (hit && ensureBez(hit)) {
    nodeEdit.targetId = hit.id;
    nodeEdit.sel = -1;
    app().selectedShapeIds = [hit.id];
    return true;
  }
  nodeEdit.targetId = null;
  nodeEdit.sel = -1;
  return false;
}

export function nodeMove(world: Pt, alt: boolean): boolean {
  const s = nodeTarget(), g = nodeEdit.grab;
  if (!s?.bez || !g) return false;
  const n: BezNode[] = s.bez;
  if (g.kind === "node") {
    const p = n[g.i], dx = world.x - p.x, dy = world.y - p.y;
    p.x += dx; p.y += dy;
    if (p.hi) p.hi = { x: p.hi.x + dx, y: p.hi.y + dy };
    if (p.ho) p.ho = { x: p.ho.x + dx, y: p.ho.y + dy };
  } else if (g.kind === "hi" || g.kind === "ho") {
    const p = n[g.i];
    p[g.kind] = { ...world };
    if (alt) p.smooth = false;
    // glatt: Gegenseite zeigt in die Gegenrichtung und behält ihre Länge
    const o = g.kind === "hi" ? "ho" : "hi";
    const other = p[o];
    if (p.smooth && other) {
      const len = Math.hypot(other.x - p.x, other.y - p.y), vx = p.x - world.x, vy = p.y - world.y, vl = Math.hypot(vx, vy) || 1;
      p[o] = { x: p.x + (vx / vl) * len, y: p.y + (vy / vl) * len };
    }
  } else if (g.kind === "bend") {
    // Linie biegen: beide inneren Kontrollpunkte um d verschieben → die Kurvenmitte wandert um ¾·d,
    // also d = 4/3 · Mausweg, dann folgt die Mitte genau der Maus
    const st = g.start, a = st[g.i], b = st[(g.i + 1) % st.length];
    const P1 = a.ho || { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 };
    const P2 = b.hi || { x: a.x + ((b.x - a.x) * 2) / 3, y: a.y + ((b.y - a.y) * 2) / 3 };
    const d = { x: ((world.x - nodeEdit.down.x) * 4) / 3, y: ((world.y - nodeEdit.down.y) * 4) / 3 };
    n[g.i] = { ...n[g.i], ho: { x: P1.x + d.x, y: P1.y + d.y } };
    const j = (g.i + 1) % n.length;
    n[j] = { ...n[j], hi: { x: P2.x + d.x, y: P2.y + d.y } };
  }
  syncPoints(s);
  return true;
}

export function nodeUp() { nodeEdit.grab = null; }

/** Doppelklick: auf Knoten = Ecke ↔ rund, auf Linie = Knoten einfügen */
export function nodeDblClick(world: Pt, sx: number, sy: number): boolean {
  const s = nodeTarget();
  if (!s?.bez) return false;
  const n: BezNode[] = s.bez;
  const i = n.findIndex(p => scrDist(p, sx, sy) < 9);
  if (i >= 0) {
    const p = n[i];
    if (p.hi || p.ho) { delete p.hi; delete p.ho; p.smooth = false; }
    else {
      const prev = n[(i - 1 + n.length) % n.length], next = n[(i + 1) % n.length];
      const hasPrev = s.closed || i > 0, hasNext = s.closed || i < n.length - 1;
      let dx = (hasNext ? next.x : p.x) - (hasPrev ? prev.x : p.x), dy = (hasNext ? next.y : p.y) - (hasPrev ? prev.y : p.y);
      const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const lp = hasPrev ? Math.hypot(p.x - prev.x, p.y - prev.y) / 3 : 0, ln = hasNext ? Math.hypot(next.x - p.x, next.y - p.y) / 3 : 0;
      if (hasPrev) p.hi = { x: p.x - dx * lp, y: p.y - dy * lp };
      if (hasNext) p.ho = { x: p.x + dx * ln, y: p.y + dy * ln };
      p.smooth = true;
    }
    nodeEdit.sel = i;
    syncPoints(s);
    return true;
  }
  const near = nearestOnPath(n, !!s.closed, world);
  if (near && near.d < screenDist(8) && near.t > 0.001 && near.t < 0.999) {
    insertAt(n, near.i, near.t);
    nodeEdit.sel = near.i + 1;
    syncPoints(s);
    return true;
  }
  return false;
}

/** Entf/Rücktaste: gewählten Knoten löschen */
export function nodeDelete(): boolean {
  const s = nodeTarget();
  if (!s?.bez || nodeEdit.sel < 0) return false;
  if (s.bez.length <= (s.closed ? 3 : 2)) return false;
  s.bez.splice(nodeEdit.sel, 1);
  nodeEdit.sel = Math.min(nodeEdit.sel, s.bez.length - 1);
  syncPoints(s);
  return true;
}

// ---------------------------------------------------------------------
// Werkzeug „Kurve zeichnen“ (Zeichenstift)
// ---------------------------------------------------------------------

export const pen = { nodes: [] as BezNode[], dragging: false, mouse: { x: 0, y: 0 } as Pt };

/** Klick: neuer Knoten oder (am ersten Knoten) schließen → gibt die fertige Form zurück */
export function penDown(world: Pt, sx: number, sy: number): any | null {
  const n = pen.nodes;
  if (n.length >= 2 && scrDist(n[0], sx, sy) < 9) return penFinish(true);
  n.push({ x: world.x, y: world.y });
  pen.dragging = true;
  return null;
}

export function penMove(world: Pt) {
  pen.mouse = { ...world };
  if (!pen.dragging || !pen.nodes.length) return;
  const p = pen.nodes[pen.nodes.length - 1];
  if (Math.hypot(world.x - p.x, world.y - p.y) < screenDist(3)) return;
  // ziehen = runder Knoten: Tangente nach vorne zur Maus, nach hinten gespiegelt
  p.ho = { ...world };
  p.hi = { x: 2 * p.x - world.x, y: 2 * p.y - world.y };
  p.smooth = true;
}

export function penUp() { pen.dragging = false; }

/** Fertig: offen (Doppelklick/Enter) oder geschlossen (Klick auf den ersten Knoten) */
export function penFinish(close: boolean): any | null {
  const n = pen.nodes;
  // Doppelklick setzt zwei gleiche Knoten – den doppelten weglassen
  while (n.length >= 2 && Math.hypot(n[n.length - 1].x - n[n.length - 2].x, n[n.length - 1].y - n[n.length - 2].y) < screenDist(2)) n.pop();
  pen.nodes = [];
  pen.dragging = false;
  if (n.length < 2 || (close && n.length < 3)) return null;
  const s = createPolyline(flatten(n, close), close, close ? "outside" : "on-line");
  s.bez = n;
  return s;
}

export function penCancel() { pen.nodes = []; pen.dragging = false; }

// ---------------------------------------------------------------------
// Anzeige (overlay.ts)
// ---------------------------------------------------------------------

export function drawBezierOverlay(ctx: CanvasRenderingContext2D, tool: string) {
  ctx.save();
  if (tool === "node") {
    const s = nodeTarget();
    if (s?.bez) drawNodes(ctx, s.bez, !!s.closed, nodeEdit.sel);
  } else if (tool === "pen" && pen.nodes.length) {
    const n = [...pen.nodes, { ...pen.mouse }];
    ctx.strokeStyle = "#34d17b"; ctx.lineWidth = 1.6;
    ctx.beginPath();
    flatten(n, false).forEach((p, i) => { const q = toScreen(p.x, p.y); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
    ctx.stroke();
    drawNodes(ctx, pen.nodes, false, pen.nodes.length - 1);
  }
  ctx.restore();
}

function drawNodes(ctx: CanvasRenderingContext2D, n: BezNode[], closed: boolean, sel: number) {
  // Kontur hervorheben
  ctx.strokeStyle = "rgba(52,209,123,0.9)"; ctx.lineWidth = 1.4;
  ctx.beginPath();
  flatten(n, closed).forEach((p, i) => { const q = toScreen(p.x, p.y); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
  if (closed) ctx.closePath();
  ctx.stroke();
  // Tangenten: am gewählten Knoten und an seinen Nachbarn (die betreffen dieselben Abschnitte)
  const show = new Set([sel, sel - 1, sel + 1].map(i => (closed ? (i + n.length) % n.length : i)).filter(i => sel >= 0 && i >= 0 && i < n.length));
  ctx.strokeStyle = "#ffb020"; ctx.fillStyle = "#ffb020"; ctx.lineWidth = 1;
  for (const i of show) {
    const p = n[i], ps = toScreen(p.x, p.y);
    for (const h of [p.hi, p.ho]) {
      if (!h) continue;
      const hs = toScreen(h.x, h.y);
      ctx.beginPath(); ctx.moveTo(ps.x, ps.y); ctx.lineTo(hs.x, hs.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(hs.x, hs.y, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  // Knoten: Ecke = Quadrat, rund = Kreis, gewählter grün gefüllt
  n.forEach((p, i) => {
    const q = toScreen(p.x, p.y);
    ctx.fillStyle = i === sel ? "#34d17b" : "#fff";
    ctx.strokeStyle = "#111"; ctx.lineWidth = 1;
    ctx.beginPath();
    if (p.hi || p.ho) ctx.arc(q.x, q.y, 4.2, 0, Math.PI * 2);
    else ctx.rect(q.x - 3.8, q.y - 3.8, 7.6, 7.6);
    ctx.fill(); ctx.stroke();
  });
}
