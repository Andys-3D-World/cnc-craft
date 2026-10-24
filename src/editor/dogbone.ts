/**
 * DOGBONES (Bearbeiten → Dogbones)
 *
 * Ein Fräser ist rund – in einer Innenecke bleibt immer ein Rest mit seinem Radius stehen, und ein eckiger
 * Zapfen passt dann nicht in die Tasche / den Schlitz. Hier bekommt jede solche Ecke einen Kreisausschnitt mit
 * Fräser-Radius, der genau bis in die Ecke reicht:
 *  - Dogbone: Kreismittelpunkt auf der Winkelhalbierenden (Ecke liegt auf dem Kreis)
 *  - T-Bone: Kreismittelpunkt auf einer der beiden Kanten (die andere Kante bleibt voll lang)
 * Welche Ecken? Die, die aus Sicht des Materials nach innen zeigen: Fräser innen (Loch, Tasche) → die Ecken der
 * Kontur; Fräser außen (Umriss, Insel in einer Tasche) → die einspringenden Ecken.
 * Nur Ecken bis zum eingestellten Winkel und mit genug langen Kanten (Rundungen bleiben, wie sie sind).
 */
import { app } from "./editorState";
import { selectedShapes } from "./selection";
import {
  MM_TO_PIXEL, Pt, Bounds, shapeToPaths, convertToPolyline, updatePolylineBounds, groupBounds,
  cloneShape, pathArea, pointInPath
} from "../shapeTransform";
import { toolForShape } from "../toolLibrary";
import { t } from "../i18n/i18n";

export type BoneKind = "dogbone" | "tbone";
export interface BoneOptions {
  kind: BoneKind;
  tside: "long" | "short"; // T-Bone: Kreis in der längeren oder kürzeren Kante
  radius: number;          // Fräser-Radius (mm)
  extra: number;           // Zuschlag auf den Radius (mm)
  maxAngle: number;        // nur Ecken bis zu diesem Winkel (°)
  minEdge: number;         // beide Kanten mindestens so lang (mm)
}

export interface BoneResult {
  shapes: any[];                      // geänderte Kopien (gleiche IDs wie die Originale)
  marks: { c: Pt; r: number }[];      // eingefügte Kreise (für Vorschau und Prüfung)
  corners: number;
  tight: number;                      // Ecke erkannt, aber Kante zu kurz für den Kreis
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
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

interface Bone { i: number; c: Pt; a: number; b: number; A: Pt; B: Pt }

/**
 * Kreisbogen von A nach B um c, der durchs Material läuft (nicht durch den Fräser-Bereich zwischen den Kanten).
 * u1 = Richtung der ankommenden Kante, u2 = der abgehenden, P = Ecke. Ohne A und B selbst.
 */
function arcPoints(P: Pt, u1: Pt, u2: Pt, c: Pt, r: number, A: Pt, B: Pt): Pt[] {
  const s = Math.sign(cross({ x: -u1.x, y: -u1.y }, u2));
  // liegt q echt zwischen den beiden Kanten (im Fräser-Bereich)?
  const inWedge = (q: Pt) => { const v = sub(q, P); return cross({ x: -u1.x, y: -u1.y }, v) * s > 1e-9 && cross(v, u2) * s > 1e-9; };
  const a0 = Math.atan2(A.y - c.y, A.x - c.x);
  let a1 = Math.atan2(B.y - c.y, B.x - c.x);
  let ccw = a1 - a0;
  while (ccw <= 1e-9) ccw += 2 * Math.PI;
  const cw = ccw - 2 * Math.PI;
  const at = (sw: number, f: number): Pt => ({ x: c.x + r * Math.cos(a0 + sw * f), y: c.y + r * Math.sin(a0 + sw * f) });
  const outside = (sw: number) => [0.25, 0.5, 0.75].filter(f => !inWedge(at(sw, f))).length;
  const sweep = outside(ccw) >= outside(cw) ? ccw : cw;
  // Sehnenfehler höchstens 0,005 mm
  const tol = 0.005 * MM_TO_PIXEL;
  const step = r > tol ? 2 * Math.acos(1 - tol / r) : Math.PI / 8;
  const n = Math.max(6, Math.ceil(Math.abs(sweep) / step));
  const out: Pt[] = [];
  for (let k = 1; k < n; k++) out.push(at(sweep, k / n));
  return out;
}

/** Dogbones in eine Kontur einsetzen. cutterSide = +1: Fräser links der Kanten, −1: rechts. R in Pixeln. */
function addBones(pts: Pt[], cutterSide: number, R: number, o: BoneOptions, res: BoneResult): Pt[] | null {
  const n = pts.length;
  if (n < 3) return null;
  const at = (i: number) => pts[((i % n) + n) % n];
  const maxCos = Math.cos(Math.min(179, Math.max(1, o.maxAngle)) * Math.PI / 180);
  const minEdge = Math.max(0.01, o.minEdge) * MM_TO_PIXEL;
  const edgeLen = pts.map((p, i) => len(sub(at(i + 1), p)));   // Kante i = Punkt i → i+1
  const bones = new Map<number, Bone>();
  for (let i = 0; i < n; i++) {
    const P = pts[i], d1 = sub(P, at(i - 1)), d2 = sub(at(i + 1), P);
    const lIn = edgeLen[(i - 1 + n) % n], lOut = edgeLen[i];
    if (lIn < minEdge || lOut < minEdge) continue;
    // Ecke zeigt zum Fräser hin (Fräser auf der Innenseite des Knicks)?
    if (cross(d1, d2) * cutterSide <= 0) continue;
    const u1 = unit(d1), u2 = unit(d2);
    const cosA = dot({ x: -u1.x, y: -u1.y }, u2);   // Winkel zwischen den beiden Kanten
    if (cosA < maxCos - 1e-9) continue;
    // Richtung von der Ecke zum Kreismittelpunkt
    let w: Pt;
    if (o.kind === "tbone") {
      const inLonger = lIn >= lOut;
      w = (o.tside === "long") === inLonger ? { x: -u1.x, y: -u1.y } : u2;
    } else w = unit({ x: u2.x - u1.x, y: u2.y - u1.y });
    const c = { x: P.x + w.x * R, y: P.y + w.y * R };
    // zweiter Schnittpunkt des Kreises mit den beiden Kanten (Abstand von der Ecke)
    const a = Math.max(0, 2 * R * dot({ x: -u1.x, y: -u1.y }, w)), b = Math.max(0, 2 * R * dot(u2, w));
    const prev = bones.get((i - 1 + n) % n);
    if (a + (prev ? prev.b : 0) > lIn + 1e-6 || b > lOut + 1e-6) { res.tight++; continue; }
    bones.set(i, { i, c, a, b, A: { x: P.x - u1.x * a, y: P.y - u1.y * a }, B: { x: P.x + u2.x * b, y: P.y + u2.y * b } });
  }
  // die letzte Ecke hat die erste beim Prüfen noch nicht gekannt
  const last = bones.get(n - 1), first = bones.get(0);
  if (last && first && n > 1 && last.b + first.a > edgeLen[n - 1] + 1e-6) { bones.delete(n - 1); res.tight++; }
  if (!bones.size) return null;
  const out: Pt[] = [];
  const near = (p: Pt, q: Pt) => len(sub(p, q)) < 1e-6;
  for (let i = 0; i < n; i++) {
    const P = pts[i], bn = bones.get(i);
    if (!bn) { out.push({ x: P.x, y: P.y }); continue; }
    const u1 = unit(sub(P, at(i - 1))), u2 = unit(sub(at(i + 1), P));
    const A = near(bn.A, P) ? P : bn.A, B = near(bn.B, P) ? P : bn.B;
    // stoßen zwei Kreise genau aneinander, nicht denselben Punkt doppelt
    if (!out.length || !near(out[out.length - 1], A)) out.push({ x: A.x, y: A.y });
    out.push(...arcPoints(P, u1, u2, bn.c, R, A, B), { x: B.x, y: B.y });
    res.marks.push({ c: bn.c, r: R });
    res.corners++;
  }
  if (out.length > 1 && near(out[0], out[out.length - 1])) out.pop();
  return out;
}

/** Fräser innen oder außen an dieser Form? */
function cutterInside(s: any, isHole: boolean, inPocket: boolean): boolean {
  if (inPocket) return false;               // Insel in einer Tasche: Fräser läuft außen herum
  if (s.millingMode === "inside" || s.millingMode === "pocket") return true;
  if (s.millingMode === "outside") return false;
  return isHole;
}

/** Dogbones auf Kopien der Formen – für Vorschau und Übernehmen */
export function addDogbones(src: any[], o: BoneOptions): BoneResult {
  const res: BoneResult = { shapes: src.map(cloneShape), marks: [], corners: 0, tight: 0 };
  const R = (Math.max(0, o.radius) + Math.max(0, o.extra)) * MM_TO_PIXEL;
  if (!(R > 0)) return res;
  // nur Polylinien und Rechtecke haben Ecken; Kreise/Bögen bleiben
  const loops = res.shapes.map(s => (s.type === "polyline" && s.closed) || s.type === "rect" ? shapeToPaths(s)[0]?.pts || null : null);
  const areas = loops.map(p => (p && p.length >= 3 ? Math.abs(pathArea(p)) : 0));
  res.shapes.forEach((s, i) => {
    const raw = loops[i];
    if (!raw || raw.length < 3) return;
    // Loch = liegt in ungerade vielen größeren Konturen; Insel = die nächste größere Kontur ist eine Tasche
    let depth = 0, parent = -1;
    loops.forEach((q, j) => {
      if (!q || j === i || areas[j] <= areas[i] || !pointInPath(raw[0].x, raw[0].y, q)) return;
      depth++;
      if (parent < 0 || areas[j] < areas[parent]) parent = j;
    });
    const inPocket = parent >= 0 && res.shapes[parent].millingMode === "pocket";
    const pts = simplify(raw);
    const side = Math.sign(pathArea(pts)) * (cutterInside(s, depth % 2 === 1, inPocket) ? 1 : -1);
    const out = addBones(pts, side, R, o, res);
    if (!out) return;
    if (s.type === "rect") convertToPolyline(s);
    s.points = out;
    s.closed = true;
    delete s.bez; // Bézier-Knoten passen nicht mehr zu den neuen Ecken
    updatePolylineBounds(s);
  });
  return res;
}

// =====================================================================
// FENSTER
// =====================================================================

const KEY = "cnc_craft_dogbone";
const DEF: BoneOptions = { kind: "dogbone", tside: "long", radius: 1.5, extra: 0.05, maxAngle: 100, minEdge: 0.5 };

function load(): Omit<BoneOptions, "radius"> {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: any = { ...DEF };
    for (const k of ["extra", "maxAngle", "minEdge"] as const) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    if (s.kind === "dogbone" || s.kind === "tbone") o.kind = s.kind;
    if (s.tside === "long" || s.tside === "short") o.tside = s.tside;
    return o;
  } catch { return { ...DEF }; }
}

function previewSvg(r: BoneResult): string {
  const b: Bounds | null = groupBounds(r.shapes);
  if (!b) return "";
  const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.04 + 1;
  const X = (p: Pt) => (p.x - b.minX + pad).toFixed(2), Y = (p: Pt) => (b.maxY - p.y + pad).toFixed(2);
  const d = (pts: Pt[], close: boolean) => pts.map((p, i) => `${i ? "L" : "M"}${X(p)},${Y(p)}`).join("") + (close ? "Z" : "");
  const sw = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 300;
  const outl = r.shapes.flatMap(s => shapeToPaths(s)).filter(p => p.pts.length >= 2).map(p => d(p.pts, p.closed)).join("");
  // Kreise mindestens gut sichtbar groß zeichnen
  const marks = r.marks.map(m => `<circle cx="${X(m.c)}" cy="${Y(m.c)}" r="${Math.max(m.r * 1.6, sw * 5).toFixed(2)}" fill="#ff9f1c33" stroke="#ff9f1c" stroke-width="${sw.toFixed(2)}"/>`).join("");
  return `<svg viewBox="0 0 ${(b.maxX - b.minX + 2 * pad).toFixed(2)} ${(b.maxY - b.minY + 2 * pad).toFixed(2)}">
    ${marks}<path d="${outl}" fill="none" stroke="#cfd3dc" stroke-width="${sw.toFixed(2)}"/></svg>`;
}

export function openDogboneDialog(log: (s: string) => void, done: () => void) {
  const st = app();
  const sel = selectedShapes();
  const src = (sel.length ? sel : st.shapes).filter((s: any) => s.type !== "image");
  if (!src.some((s: any) => (s.type === "polyline" && s.closed) || s.type === "rect")) { log(t("bone.none")); return; }
  const init = load();
  // Vorschlag: größter Fräser der betroffenen Formen (zu kleine Kreise ließen Material stehen)
  let tool: any = null;
  for (const s of src) { const tl = toolForShape(s); if (tl && (!tool || tl.diameter > tool.diameter)) tool = tl; }
  const radius = tool && tool.diameter > 0 ? tool.diameter / 2 : DEF.radius;

  document.getElementById("bone-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "bone-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, v: number, step: string, unitTxt = "mm") =>
    `<label class="dlg-row"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="0" step="${step}" value="${v}"><em>${unitTxt}</em></span></label>`;
  const sel2 = (id: string, key: string, opts: [string, string][], v: string) =>
    `<label class="dlg-row"><span>${t(key)}</span><select id="${id}" class="prop-input" style="width:auto;">${opts.map(([k, l]) => `<option value="${k}" ${k === v ? "selected" : ""}>${t(l)}</option>`).join("")}</select></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:620px;">
      <h3>◔ ${t("bone.title")}</h3>
      <div class="dlg-hint">${t(sel.length ? "bone.descSel" : "bone.descAll", { n: src.length })}</div>
      <div class="box-grid">
        <div class="box-fields">
          ${sel2("bn-kind", "bone.kind", [["dogbone", "bone.kind.dogbone"], ["tbone", "bone.kind.tbone"]], init.kind)}
          <div id="bn-tside-row">${sel2("bn-tside", "bone.tside", [["long", "bone.tside.long"], ["short", "bone.tside.short"]], init.tside)}</div>
          ${num("bn-radius", "bone.radius", radius, "0.05")}
          ${tool ? `<div class="dlg-hint" style="margin:0;">${t("bone.tool", { name: esc(tool.name), d: tool.diameter })}</div>` : ""}
          ${num("bn-extra", "bone.extra", init.extra, "0.01")}
          ${num("bn-angle", "bone.maxAngle", init.maxAngle, "1", "°")}
          ${num("bn-edge", "bone.minEdge", init.minEdge, "0.1")}
        </div>
        <div class="box-prev"><div id="bn-svg" style="flex:1;display:flex;"></div><div id="bn-info" class="dlg-hint"></div></div>
      </div>
      <div class="dlg-hint">${t("bone.hint")}</div>
      <div class="dlg-buttons">
        <button id="bn-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="bn-ok" class="btn-primary">✔ ${t("bone.apply")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = (id: string) => ov.querySelector("#" + id) as HTMLInputElement;
  const read = (): BoneOptions => {
    const n = (id: string, d: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v >= 0 ? v : d; };
    return {
      kind: $("bn-kind").value === "tbone" ? "tbone" : "dogbone", tside: $("bn-tside").value === "short" ? "short" : "long",
      radius: n("bn-radius", radius), extra: n("bn-extra", DEF.extra), maxAngle: n("bn-angle", DEF.maxAngle), minEdge: n("bn-edge", DEF.minEdge)
    };
  };
  let last: BoneResult | null = null;
  const preview = () => {
    const o = read();
    (ov.querySelector("#bn-tside-row") as HTMLElement).style.display = o.kind === "tbone" ? "" : "none";
    last = o.radius > 0 ? addDogbones(src, o) : null;
    const box = ov.querySelector("#bn-svg") as HTMLElement;
    box.innerHTML = last ? previewSvg(last) : "";
    box.querySelector("svg")?.setAttribute("style", "width:100%;height:230px;");
    let info = last ? (last.corners ? t("bone.info", { n: last.corners }) : t("bone.found0")) : "";
    if (last?.tight) info += " " + t("bone.tight", { n: last.tight });
    ($("bn-info") as HTMLElement).textContent = info;
    $("bn-ok").disabled = !last || !last.corners;
  };
  ov.querySelectorAll("input, select").forEach(i => { i.addEventListener("input", preview); i.addEventListener("change", preview); });
  preview();
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") $("bn-ok").click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $("bn-cancel").onclick = close;
  $("bn-ok").onclick = () => {
    if (!last || $("bn-ok").disabled) return;
    const o = read();
    try { localStorage.setItem(KEY, JSON.stringify({ kind: o.kind, tside: o.tside, extra: o.extra, maxAngle: o.maxAngle, minEdge: o.minEdge })); } catch { /* egal */ }
    close();
    const byId = new Map(last.shapes.map(s => [s.id, s]));
    st.shapes = st.shapes.map((s: any) => byId.get(s.id) || s);
    st.selectedShapeIds = last.shapes.map(s => s.id);
    log(t("bone.done", { n: last.corners, r: +(o.radius + o.extra).toFixed(3) }));
    done();
  };
  setTimeout(() => $("bn-radius").select(), 0);
}
