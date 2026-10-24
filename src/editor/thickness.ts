/**
 * MATERIALSTÄRKE ANPASSEN (Bearbeiten → Materialstärke)
 *
 * Ein Steckmodell ist für z. B. 3 mm gezeichnet, das Holz ist aber 3,6 mm dick. Hier werden nur die Schlitze und
 * Zapfen umgerechnet, alles andere bleibt gleich groß:
 *  - Schlitz / Zapfen in einer Kante: vier Ecken in U-Form (Wand – Boden – Wand), die beiden Wände stehen
 *    senkrecht auf dem Boden und zeigen in entgegengesetzte Richtung, der Boden ist ≈ alte Stärke breit.
 *    Beide Wände rücken um die halbe Differenz auseinander (bzw. zusammen) → Mitte bleibt, wo sie war
 *  - Rechteck-Loch, dessen eine Seite ≈ alte Stärke ist: wird in dieser Richtung breiter (bzw. schmaler)
 * Schlitz oder Zapfen? Das sagt die Drehrichtung an den Ecken (zeigen sie ins Material → Schlitz).
 * Nur geschlossene Konturen; Bögen in den Schlitzen (Rundungen) werden nicht erkannt.
 * Danach auf Wunsch der Schnittspalt wie im Box-Generator: Umriss kerf/2 nach außen, Löcher kerf/2 nach innen.
 */
import { app } from "./editorState";
import { selectedShapes } from "./selection";
import {
  MM_TO_PIXEL, Pt, Bounds, shapeToPaths, convertToPolyline, updatePolylineBounds, scaleShape, groupBounds,
  cloneShape, pathArea, pointInPath
} from "../shapeTransform";
import { offsetPolygon } from "../polyOffset";
import { t } from "../i18n/i18n";

export interface ThickOptions {
  from: number;    // gezeichnete Stärke (mm)
  to: number;      // gemessene Stärke (mm)
  tol: number;     // ± mm, wie genau der Schlitz der alten Stärke entsprechen muss
  slots: boolean;
  tabs: boolean;
  holes: boolean;
  scale: number;   // ganzes Modell skalieren (%), 100 = nein
  kerf: number;    // Schnittspalt (mm)
}

export type MarkKind = "slot" | "tab" | "hole";
export interface ThickResult {
  shapes: any[];                          // geänderte Kopien (gleiche IDs wie die Originale)
  marks: { pts: Pt[]; kind: MarkKind }[]; // geänderte Stellen (für die Vorschau)
  slots: number; tabs: number; holes: number;
  tight: number;                          // erkannt, aber zu wenig Platz zum Verbreitern
}

const SIN_TOL = Math.sin(4 * Math.PI / 180);   // Wände dürfen ~4° schief sein
const MIN_WALL = 0.4 * MM_TO_PIXEL;           // kürzere Wände sind keine Schlitze (Zacken, Rundungen)

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v: Pt) => Math.hypot(v.x, v.y);
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x;
const unit = (v: Pt): Pt => { const l = len(v) || 1; return { x: v.x / l, y: v.y / l }; };

/** Doppelte und gerade durchlaufende Punkte weg (Importe zerlegen Kanten oft in mehrere Stücke) */
function simplify(src: Pt[]): Pt[] {
  let pts = src.map(p => ({ x: p.x, y: p.y }));
  const eps = 0.005 * MM_TO_PIXEL;
  for (let changed = true; changed && pts.length > 3;) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], p = pts[i], b = pts[(i + 1) % pts.length];
      const ab = sub(b, a), l = len(ab);
      const off = l > 1e-9 ? Math.abs(cross(ab, sub(p, a))) / l : len(sub(p, a));
      if (len(sub(p, a)) < eps || off < eps && dot(sub(p, a), sub(b, p)) >= 0) { pts.splice(i, 1); i--; changed = true; }
    }
  }
  return pts;
}

/**
 * Schlitze / Zapfen in einer Kontur umrechnen. matSide = +1: Material links der Kanten (Umriss gegen den
 * Uhrzeigersinn oder Loch im Uhrzeigersinn), −1: rechts. w0 = alte Breite in Pixeln, w1 = neue.
 */
function adjustLoop(pts: Pt[], matSide: number, w0: number, w1: number, tol: number, o: ThickOptions, res: ThickResult): { idx: number[]; kind: MarkKind }[] {
  const n = pts.length;
  const found: { idx: number[]; kind: MarkKind }[] = [];
  if (n < 6) return found;
  const at = (i: number) => pts[((i % n) + n) % n];
  const used = new Set<number>();
  const moves: { idx: number[]; d: Pt }[] = [];
  for (let i = 0; i < n; i++) {
    const ids = [i, i + 1, i + 2, i + 3].map(k => k % n);
    if (ids.some(k => used.has(k))) continue;
    const [p1, p2, p3, p4] = ids.map(k => pts[k]);
    const m = sub(p3, p2), w = len(m);
    if (Math.abs(w - w0) > tol) continue;
    const d1 = sub(p2, p1), d2 = sub(p4, p3);
    if (len(d1) < MIN_WALL || len(d2) < MIN_WALL) continue;
    const mu = unit(m), u1 = unit(d1), u2 = unit(d2);
    if (Math.abs(dot(u1, mu)) > SIN_TOL || Math.abs(dot(u2, mu)) > SIN_TOL || dot(u1, u2) > -0.99) continue;
    // beide Ecken drehen gleich herum; zum Material hin = Zapfen (steht vor), vom Material weg = Schlitz
    const tab = cross(d1, m) * matSide > 0;
    if (tab ? !o.tabs : !o.slots) continue;
    const delta = (w1 - w) / 2;
    // beim Verbreitern muss vor und hinter dem Schlitz genug Kante übrig bleiben
    if (delta > 0) {
      const before = dot(sub(p1, at(i - 1)), mu), after = dot(sub(at(i + 4), p4), mu);
      if (before < delta + 0.05 * MM_TO_PIXEL || after < delta + 0.05 * MM_TO_PIXEL) { res.tight++; continue; }
    }
    ids.forEach(k => used.add(k));
    moves.push({ idx: [ids[0], ids[1]], d: { x: -mu.x * delta, y: -mu.y * delta } });
    moves.push({ idx: [ids[2], ids[3]], d: { x: mu.x * delta, y: mu.y * delta } });
    if (tab) res.tabs++; else res.slots++;
    found.push({ idx: ids, kind: tab ? "tab" : "slot" });
  }
  for (const mv of moves) for (const k of mv.idx) { pts[k].x += mv.d.x; pts[k].y += mv.d.y; }
  return found;
}

/** Rechteck-Loch (4 Ecken, rechte Winkel): Seite ≈ alte Stärke → in dieser Richtung auf die neue Stärke */
function adjustRectHole(pts: Pt[], w0: number, w1: number, tol: number, res: ThickResult): boolean {
  if (pts.length !== 4) return false;
  const e = [0, 1, 2, 3].map(i => sub(pts[(i + 1) % 4], pts[i]));
  for (let i = 0; i < 4; i++) if (Math.abs(dot(unit(e[i]), unit(e[(i + 1) % 4]))) > SIN_TOL) return false;
  let hit = false;
  // Breite in Richtung e[1] (Abstand der Seiten 0→1 und 2→3), dann in Richtung e[0]
  for (const [dir, a, b] of [[1, [0, 1], [2, 3]], [0, [3, 0], [1, 2]]] as [number, number[], number[]][]) {
    const w = len(e[dir]);
    if (Math.abs(w - w0) > tol) continue;
    const u = unit(e[dir]), delta = (w1 - w) / 2;
    for (const k of a) { pts[k].x -= u.x * delta; pts[k].y -= u.y * delta; }
    for (const k of b) { pts[k].x += u.x * delta; pts[k].y += u.y * delta; }
    hit = true;
  }
  if (hit) res.holes++;
  return hit;
}

/** Umrechnen auf Kopien der Formen – für Vorschau und Übernehmen */
export function adjustThickness(src: any[], o: ThickOptions): ThickResult {
  const res: ThickResult = { shapes: src.map(cloneShape), marks: [], slots: 0, tabs: 0, holes: 0, tight: 0 };
  const sc = o.scale > 0 ? o.scale / 100 : 1;
  if (Math.abs(sc - 1) > 1e-9) {
    const b = groupBounds(res.shapes);
    if (b) res.shapes.forEach(s => scaleShape(s, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, sc, sc));
  }
  const w0 = o.from * sc * MM_TO_PIXEL, w1 = o.to * MM_TO_PIXEL, tol = Math.max(0.01, o.tol) * MM_TO_PIXEL;
  // nur Polylinien und Rechtecke haben Ecken; Kreise/Bögen bleiben
  const loops = res.shapes.map(s => (s.type === "polyline" && s.closed) || s.type === "rect" ? shapeToPaths(s)[0]?.pts || null : null);
  const areas = loops.map(p => (p && p.length >= 3 ? Math.abs(pathArea(p)) : 0));
  res.shapes.forEach((s, i) => {
    const raw = loops[i];
    if (!raw || raw.length < 3) return;
    // Loch = liegt in ungerade vielen größeren Konturen
    let depth = 0;
    loops.forEach((q, j) => { if (q && j !== i && areas[j] > areas[i] && pointInPath(raw[0].x, raw[0].y, q)) depth++; });
    const isHole = depth % 2 === 1;
    let pts = simplify(raw);
    const matSide = Math.sign(pathArea(pts)) * (isHole ? -1 : 1);
    const found = adjustLoop(pts, matSide, w0, w1, tol, o, res);
    for (const f of found) res.marks.push({ pts: f.idx.map(k => ({ x: pts[k].x, y: pts[k].y })), kind: f.kind });
    let changed = found.length > 0;
    if (!changed && isHole && o.holes && adjustRectHole(pts, w0, w1, tol, res)) {
      changed = true;
      res.marks.push({ pts: [...pts, pts[0]].map(p => ({ ...p })), kind: "hole" });
    }
    if (o.kerf > 0) {
      const off = offsetPolygon(pts, (isHole ? -1 : 1) * o.kerf / 2 * MM_TO_PIXEL, 0.01)[0];
      if (off && off.length >= 3) { pts = off; changed = true; }
    }
    if (!changed) return;
    if (s.type === "rect") convertToPolyline(s);
    s.points = pts;
    s.closed = true;
    delete s.bez; // Bézier-Knoten passen nicht mehr zu den verschobenen Ecken
    updatePolylineBounds(s);
  });
  return res;
}

/** Häufigste Breite schmaler U-Formen (1–12 mm) als Vorschlag für die gezeichnete Stärke */
export function guessThickness(src: any[]): number | null {
  const count = new Map<number, number>();
  for (const s of src) {
    if (!((s.type === "polyline" && s.closed) || s.type === "rect")) continue;
    const pts = simplify(shapeToPaths(s)[0]?.pts || []);
    const n = pts.length;
    if (n < 4) continue;
    for (let i = 0; i < n; i++) {
      const [p1, p2, p3, p4] = [0, 1, 2, 3].map(k => pts[(i + k) % n]);
      const m = sub(p3, p2), d1 = sub(p2, p1), d2 = sub(p4, p3);
      const w = len(m) / MM_TO_PIXEL;
      if (w < 1 || w > 12 || len(d1) < MIN_WALL || len(d2) < MIN_WALL) continue;
      const mu = unit(m);
      if (Math.abs(dot(unit(d1), mu)) > SIN_TOL || Math.abs(dot(unit(d2), mu)) > SIN_TOL || dot(unit(d1), unit(d2)) > -0.99) continue;
      const k = Math.round(w * 10) / 10;
      count.set(k, (count.get(k) || 0) + 1);
    }
  }
  let best: number | null = null, bestN = 0;
  count.forEach((c, k) => { if (c > bestN) { bestN = c; best = k; } });
  return best;
}

// =====================================================================
// FENSTER
// =====================================================================

const KEY = "cnc_craft_thickness";
const DEF: ThickOptions = { from: 3, to: 3.6, tol: 0.25, slots: true, tabs: true, holes: true, scale: 100, kerf: 0 };

function load(): ThickOptions {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: any = { ...DEF };
    for (const k of ["from", "to", "tol", "scale", "kerf"] as const) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    for (const k of ["slots", "tabs", "holes"] as const) if (typeof s[k] === "boolean") o[k] = s[k];
    return o;
  } catch { return { ...DEF }; }
}

function previewSvg(r: ThickResult): string {
  const b: Bounds | null = groupBounds(r.shapes);
  if (!b) return "";
  const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.04 + 1;
  const X = (p: Pt) => (p.x - b.minX + pad).toFixed(2), Y = (p: Pt) => (b.maxY - p.y + pad).toFixed(2);
  const d = (pts: Pt[], close: boolean) => pts.map((p, i) => `${i ? "L" : "M"}${X(p)},${Y(p)}`).join("") + (close ? "Z" : "");
  const sw = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 300;
  const outl = r.shapes.flatMap(s => shapeToPaths(s)).filter(p => p.pts.length >= 2).map(p => d(p.pts, p.closed)).join("");
  const col: Record<MarkKind, string> = { slot: "#ff9f1c", tab: "#3ec6ff", hole: "#ff5c8a" };
  const marks = r.marks.map(mk => `<path d="${d(mk.pts, false)}" fill="none" stroke="${col[mk.kind]}" stroke-width="${(sw * 4).toFixed(2)}" stroke-linejoin="round"/>`).join("");
  return `<svg viewBox="0 0 ${(b.maxX - b.minX + 2 * pad).toFixed(2)} ${(b.maxY - b.minY + 2 * pad).toFixed(2)}">
    <path d="${outl}" fill="none" stroke="#cfd3dc" stroke-width="${sw.toFixed(2)}"/>${marks}</svg>`;
}

export function openThicknessDialog(log: (s: string) => void, done: () => void) {
  const st = app();
  const sel = selectedShapes();
  const src = (sel.length ? sel : st.shapes).filter((s: any) => s.type !== "image");
  if (!src.some((s: any) => (s.type === "polyline" && s.closed) || s.type === "rect")) { log(t("thick.none")); return; }
  const init = load();
  const guess = guessThickness(src);

  document.getElementById("thick-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "thick-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, v: number, step: string, unitTxt = "mm") =>
    `<label class="dlg-row"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="0" step="${step}" value="${v}"><em>${unitTxt}</em></span></label>`;
  const chk = (id: string, key: string, on: boolean, color: string) =>
    `<label class="dlg-row" style="cursor:pointer;"><span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin-right:6px;"></i>${t(key)}</span><input id="${id}" type="checkbox" ${on ? "checked" : ""} style="width:auto;"></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:620px;">
      <h3>▥ ${t("thick.title")}</h3>
      <div class="dlg-hint">${t(sel.length ? "thick.descSel" : "thick.descAll", { n: src.length })}</div>
      <div class="box-grid">
        <div class="box-fields">
          ${num("th-from", "thick.from", init.from, "0.1")}
          ${guess !== null ? `<button type="button" id="th-guess" class="btn-secondary btn-compact">${t("thick.guess", { v: guess })}</button>` : ""}
          ${num("th-to", "thick.to", init.to, "0.1")}
          ${num("th-tol", "thick.tol", init.tol, "0.05")}
          ${chk("th-slots", "thick.slots", init.slots, "#ff9f1c")}
          ${chk("th-tabs", "thick.tabs", init.tabs, "#3ec6ff")}
          ${chk("th-holes", "thick.holes", init.holes, "#ff5c8a")}
          ${num("th-scale", "thick.scale", init.scale, "1", "%")}
          ${num("th-kerf", "box.kerf", init.kerf, "0.01", "")}
        </div>
        <div class="box-prev"><div id="th-svg" style="flex:1;display:flex;"></div><div id="th-info" class="dlg-hint"></div></div>
      </div>
      <div class="dlg-hint">${t("thick.hint")}</div>
      <div class="dlg-buttons">
        <button id="th-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="th-ok" class="btn-primary">✔ ${t("thick.apply")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = (id: string) => ov.querySelector("#" + id) as HTMLInputElement;
  const read = (): ThickOptions => {
    const n = (id: string, d: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v >= 0 ? v : d; };
    return {
      from: n("th-from", DEF.from), to: n("th-to", DEF.to), tol: n("th-tol", DEF.tol), scale: n("th-scale", 100) || 100, kerf: n("th-kerf", 0),
      slots: $("th-slots").checked, tabs: $("th-tabs").checked, holes: $("th-holes").checked
    };
  };
  let last: ThickResult | null = null;
  const preview = () => {
    const o = read();
    last = o.from > 0 && o.to > 0 ? adjustThickness(src, o) : null;
    const box = ov.querySelector("#th-svg") as HTMLElement;
    box.innerHTML = last ? previewSvg(last) : "";
    box.querySelector("svg")?.setAttribute("style", "width:100%;height:230px;");
    const total = last ? last.slots + last.tabs + last.holes : 0;
    let info = last ? t("thick.info", { s: last.slots, t: last.tabs, h: last.holes }) : "";
    if (last && !total) info = t("thick.found0", { v: o.from });
    if (last?.tight) info += " " + t("thick.tight", { n: last.tight });
    ($("th-info") as HTMLElement).textContent = info;
    $("th-ok").disabled = !last || (!total && !(o.kerf > 0) && Math.abs(o.scale - 100) < 1e-9);
  };
  ov.querySelectorAll("input").forEach(i => i.addEventListener("input", preview));
  const gb = ov.querySelector("#th-guess") as HTMLElement | null;
  if (gb) gb.onclick = () => { $("th-from").value = String(guess); preview(); };
  preview();
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") $("th-ok").click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $("th-cancel").onclick = close;
  $("th-ok").onclick = () => {
    if (!last || $("th-ok").disabled) return;
    try { localStorage.setItem(KEY, JSON.stringify(read())); } catch { /* egal */ }
    close();
    const byId = new Map(last.shapes.map(s => [s.id, s]));
    st.shapes = st.shapes.map((s: any) => byId.get(s.id) || s);
    st.selectedShapeIds = last.shapes.map(s => s.id);
    log(t("thick.done", { s: last.slots, t: last.tabs, h: last.holes, v: read().to }));
    done();
  };
  setTimeout(() => $("th-to").select(), 0);
}
