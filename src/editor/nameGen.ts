/**
 * NAMEN-GENERATOR (Extras → Namen-Generator)
 *
 * Ein Name wird zu einem zusammenhängenden Schriftzug, der in einem Stück ausgeschnitten werden kann:
 *  - die Buchstaben (Schrift aus fonts.ts, Abstand auch negativ = überlappen) werden vereinigt
 *  - Verbindung: keine (Schreibschrift berührt sich selbst), Grundlinie (Steg unter den Buchstaben) oder
 *    Umriss (Versatz um alle Buchstaben, Innenräume gefüllt – die Buchstaben auf Wunsch als Gravur obendrauf)
 *  - Symbole aus der Formen-Bibliothek oder nameIcons.ts (Tiere …) vorn/hinten, auch ein eigenes SVG;
 *    Aufhänger als Ring oder Loch
 *  - Ritzlinien: wo sich Buchstaben überlappen, bleibt die Kante des oberen als Gravurlinie (nameConnect.ts) –
 *    dafür wird jeder Buchstabe einzeln nachgezeichnet. Fettung macht dünne Schriften stabiler.
 *  - Fertige Breite: der Schriftzug wird so skaliert, dass er genau so breit wird
 *  - Vorlagen „Weihnachtskugel“ und „Weihnachtsstern“: Anhänger mit Kappe/Loch, der Name graviert oder ausgeschnitten
 * Die Vorschau zeigt, ob alles ein Teil ist (sonst Warnung mit der Anzahl). Rechnung in mm mit polygon-clipping,
 * „Aufs Bett“ legt das Ergebnis als Gruppe in die Bettmitte.
 */
import polygonClipping, { MultiPolygon, Polygon, Ring } from "polygon-clipping";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, Pt, newId, makeRectPoints, makeEllipsePoints, createPolyline } from "../shapeTransform";
import { toShapes } from "./shapeOps";
import { traceTextWithFont, traceGlyphsWithFont, TracedText, TextParams } from "./textTool";
import { NAME_ICONS } from "./nameIcons";
import { parseSvg } from "../importers/svgImport";
import { grow, union, bounds, overlapScores, clipLines, outlineLines, scaleArea, scaleLines, ScoreLine, XY } from "../nameConnect";
import { createFontPicker } from "./fontPicker";
import { SHAPES } from "./shapeLibrary";
import { getLayers } from "../laserLayers";
import { t } from "../i18n/i18n";

export type Connect = "none" | "baseline" | "outline";
export type Hanger = "none" | "ringLeft" | "ringTop" | "hole";
export type Template = "name" | "ball" | "star";
export type Inner = "engrave" | "cut" | "layer" | "score";

export interface NameOptions {
  text: string; font: string; bold: boolean;
  height: number;      // Großbuchstaben-Höhe (mm)
  spacing: number;     // zusätzlicher Buchstabenabstand (mm), negativ = überlappen
  connect: Connect;
  bar: number;         // Dicke der Grundlinie (mm)
  outline: number;     // Abstand des Umrisses (mm)
  inner: Inner;        // Umriss/Vorlage: Buchstaben gravieren, ausschneiden oder als eigenes Teil (Rückplatte)
  front: string; back: string; // Symbol-IDs aus der Formen-Bibliothek ("" = keins)
  hanger: Hanger;
  holeD: number;       // Loch-Ø des Aufhängers (mm)
  template: Template;
  score: boolean;      // Ritzlinien, wo sich Buchstaben/Symbole überlappen
  thicken: number;     // Fettung: jeder Buchstabe wächst um so viel (mm), Innenräume bleiben
  width: number;       // fertige Breite (mm), 0 = die Höhe gilt
  own: XY[][];         // eigenes Symbol (Ringe aus einem SVG, mm, y nach oben) für front/back = "own"
}

export const NAME_SYMBOLS = ["heart", "star5", "star6", "moon", "drop", "leaf", "paw", "flower", "tree", "cloud", "bolt", "check"];

export interface NameResult {
  cut: MultiPolygon; engrave: MultiPolygon;
  top: MultiPolygon;   // „eigenes Teil“: Schriftzug, der auf die Rückplatte (cut) geklebt wird
  lines: ScoreLine[];  // Gravurlinien (Ritzlinien an Überlappungen, Konturen bei „als Linie gravieren“)
  linesTop: boolean;   // Linien gehören zum Schriftzug („eigenes Teil“), nicht zur Rückplatte
  pieces: number; w: number; h: number; openFont: boolean;
}

const KEY = "cnc_craft_namegen";
const DEF: NameOptions = {
  text: "Andreas", font: "Pacifico", bold: false, height: 25, spacing: 0, connect: "baseline", bar: 4, outline: 2.5,
  inner: "engrave", front: "", back: "heart", hanger: "none", holeD: 4, template: "name",
  score: true, thicken: 0, width: 0, own: []
};

// ---------- kleine Flächen-Helfer (mm) ----------
const ring = (pts: Pt[]): Ring => pts.map(p => [p.x, p.y] as [number, number]);
const diff = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => (a.length && b.length ? polygonClipping.difference(a, b) : a);
const disk = (cx: number, cy: number, r: number): MultiPolygon => [[ring(makeEllipsePoints(cx, cy, r, r))]];
const box = (x0: number, y0: number, x1: number, y1: number, r = 0): MultiPolygon => [[ring(makeRectPoints(x0, y0, x1, y1, r))]];

/** nur die Außenkonturen (Innenräume gefüllt) */
const solid = (m: MultiPolygon): MultiPolygon => union(m.filter(p => p[0]).map(p => [[p[0]]] as MultiPolygon));

/** Winzige Löcher füllen (Zwickel, wo runde Buchstaben auf die Grundlinie treffen) – zu klein zum Schneiden */
function dropPinholes(m: MultiPolygon, minArea: number): MultiPolygon {
  const area = (r: Ring) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(a / 2); };
  return m.map(p => [p[0], ...p.slice(1).filter(h => area(h) >= minArea)]);
}

/** Text-Konturen (Gerade/Ungerade) als Fläche */
function textRegion(tr: TracedText): MultiPolygon {
  const rings: Polygon[] = tr.loops.filter((l, i) => l.length >= 3 && tr.closed?.[i] !== false).map(l => [ring(l)]);
  if (!rings.length) return [];
  return rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1));
}

/** Grundlinie der Schrift: Median der Unterkanten der Buchstaben (Unterlängen wie g, y zählen kaum) */
function baselineOf(m: MultiPolygon): number {
  const ys = m.map(p => Math.min(...(p[0] || []).map(q => q[1]))).filter(Number.isFinite).sort((a, b) => a - b);
  return ys.length ? ys[Math.floor(ys.length / 2)] : 0;
}

/** Fläche auf Höhe h bringen, unten links bei (x, y) */
function fit(m: MultiPolygon, x: number, y: number, h: number): MultiPolygon {
  const b = bounds(m), k = h / Math.max(1e-6, b.y1 - b.y0);
  return m.map(poly => poly.map(r => r.map(([px, py]) => [x + (px - b.x0) * k, y + (py - b.y0) * k] as [number, number])));
}
const xorAll = (rings: Polygon[]): MultiPolygon => rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1));

/**
 * Symbol als Fläche mit Höhe h, unten links bei (x, y): Form aus der Bibliothek bzw. nameIcons.ts
 * (SVG-Pfad im 100er-Feld, y nach unten) oder „own“ = eigenes SVG
 */
function libShape(id: string, x: number, y: number, h: number, own: XY[][] = []): MultiPolygon {
  if (id === "own") return own.length ? fit(xorAll(own.map(r => [r])), x, y, h) : [];
  const s = SHAPES.find(q => q.id === id) || NAME_ICONS.find(q => q.id === id);
  if (!s) return [];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("style", "position:absolute;left:-9999px;width:0;height:0;");
  document.body.appendChild(svg);
  const rings: Polygon[] = [];
  try {
    for (const sub of s.d.split(/(?=M)/).map(q => q.trim()).filter(Boolean)) {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", sub);
      svg.appendChild(p);
      const L = p.getTotalLength();
      const n = Math.max(24, Math.min(600, Math.ceil(L)));
      const pts: [number, number][] = [];
      for (let i = 0; i < n; i++) { const q = p.getPointAtLength((i / n) * L); pts.push([q.x, -q.y]); }
      if (pts.length >= 3) rings.push([pts]);
    }
  } finally { svg.remove(); }
  return rings.length ? fit(xorAll(rings), x, y, h) : [];
}

/** Anzahl zusammenhängender Teile (Fläche mit ihren Löchern = ein Teil) */
const countPieces = (m: MultiPolygon) => m.filter(p => p[0] && p[0].length >= 3).length;

/** Schriftzug bauen; mit fertiger Breite: zweimal rechnen (Höhe anpassen) und das Ergebnis genau skalieren */
export async function buildName(o: NameOptions): Promise<NameResult> {
  const r1 = await buildAt(o);
  if (!(o.width > 0) || !(r1.w > 0)) return r1;
  const k1 = o.width / r1.w;
  const r = await buildAt({ ...o, height: o.height * k1, spacing: o.spacing * k1 });
  if (!(r.w > 0)) return r;
  const k = o.width / r.w;
  return { ...r, cut: scaleArea(r.cut, k), engrave: scaleArea(r.engrave, k), top: scaleArea(r.top, k), lines: scaleLines(r.lines, k), w: r.w * k, h: r.h * k };
}

async function buildAt(o: NameOptions): Promise<NameResult> {
  const tp: TextParams = {
    text: o.text.replace(/\s*\n\s*/g, " ").trim() || " ", font: o.font, heightMm: o.height, bold: o.bold, italic: false,
    align: "left", lineSpacing: 170, letterSpacing: o.spacing
  };
  // Ritzlinien/Fettung brauchen jeden Buchstaben einzeln (Einzellinien-Schrift: null → wie bisher)
  let glyphs: MultiPolygon[] = [];
  if (o.score || o.thicken > 0) {
    const g = await traceGlyphsWithFont(tp);
    if (g) glyphs = g.map(textRegion).filter(m => m.length).map(m => (o.thicken > 0 ? grow(m, o.thicken, true) : m));
  }
  let letters: MultiPolygon, openFont = false;
  if (glyphs.length) letters = union(glyphs);
  else {
    const traced = (await traceTextWithFont(tp)).traced;
    openFont = !!traced.closed?.some(c => !c);
    letters = textRegion(traced);
    if (letters.length > 1) letters = union([letters]);
    if (o.thicken > 0 && !openFont) letters = grow(letters, o.thicken, true);
  }
  const empty: NameResult = { cut: [], engrave: [], top: [], lines: [], linesTop: false, pieces: 0, w: 0, h: 0, openFont };
  if (!letters.length) return empty;
  const lb = bounds(letters), base = baselineOf(letters);
  let cut: MultiPolygon, engrave: MultiPolygon = [], top: MultiPolygon = [];
  let scores: ScoreLine[] = [], lines: ScoreLine[] = [];
  let hole: MultiPolygon = [];
  const H = o.height;

  if (o.template === "name") {
    const parts: MultiPolygon[] = [letters];
    // Symbole vorn/hinten: so hoch wie die Großbuchstaben, 0,8 mm in den Schriftzug geschoben (damit sie hängen)
    const ov = Math.min(1.5, H * 0.06);
    let x0 = lb.x0, x1 = lb.x1;
    let fr: MultiPolygon = [], bk: MultiPolygon = [];
    if (o.front) {
      const m0 = libShape(o.front, 0, 0, H, o.own), w = m0.length ? bounds(m0).x1 : 0;
      fr = libShape(o.front, lb.x0 - w + ov, base, H, o.own); parts.push(fr); x0 = lb.x0 - w + ov;
    }
    if (o.back) { bk = libShape(o.back, lb.x1 - ov, base, H, o.own); parts.push(bk); if (bk.length) x1 = bounds(bk).x1; }
    // Ritzlinien: vorderes Symbol zuunterst, dann die Buchstaben, das hintere Symbol obenauf
    if (o.score && glyphs.length) scores = overlapScores([fr, ...glyphs, bk]);
    if (o.connect === "baseline") {
      const bh = Math.max(0.5, o.bar);
      parts.push(box(x0 + bh / 2, base - bh * 0.6, x1 - bh / 2, base + bh * 0.4, bh / 2));
    }
    let shape = dropPinholes(union(parts), Math.max(1, (H * 0.08) ** 2));
    if (o.connect === "outline") {
      engrave = o.inner === "engrave" ? shape : [];
      if (o.inner === "layer") top = shape;
      if (o.inner === "score") lines = [...outlineLines(shape), ...scores];
      else if (o.inner === "layer") lines = scores;
      const outer = solid(grow(shape, Math.max(0.3, o.outline)));
      shape = o.inner === "cut" ? diff(outer, solid(shape)) : outer;
    } else lines = scores;
    // Aufhänger
    const b = bounds(shape), rIn = Math.max(0.5, o.holeD / 2), rOut = rIn + Math.max(1.5, H * 0.08);
    const midY = (base + H * 0.5);
    if (o.hanger === "ringLeft") {
      const cx = b.x0 - rOut + rOut * 0.45;
      shape = union([shape, disk(cx, midY, rOut)]); hole = disk(cx, midY, rIn);
    } else if (o.hanger === "ringTop") {
      // am höchsten Punkt des Schriftzugs (z. B. Oberlänge vom d), sonst hinge der Ring in der Luft
      let hi: [number, number] = [(b.x0 + b.x1) / 2, b.y1];
      for (const poly of shape) for (const q of poly[0] || []) if (q[1] > hi[1] - 1e-9) hi = q;
      const cx = hi[0], cy = hi[1] + rOut - rOut * 0.45;
      shape = union([shape, disk(cx, cy, rOut)]); hole = disk(cx, cy, rIn);
    } else if (o.hanger === "hole") {
      // Loch im ersten Stück Material links (beim Umriss bzw. im vorderen Symbol): wo eine waagerechte Linie
      // durch die Mitte zuerst aufs Material trifft, plus Rand
      let xIn = Infinity;
      for (const poly of shape) for (const rg of poly) for (let i = 0, j = rg.length - 1; i < rg.length; j = i++) {
        const [ax, ay] = rg[j], [bx, by] = rg[i];
        if ((ay > midY) !== (by > midY)) { const x = ax + ((midY - ay) * (bx - ax)) / (by - ay); xIn = Math.min(xIn, x); }
      }
      hole = disk((isFinite(xIn) ? xIn : b.x0) + rOut, midY, rIn);
    }
    cut = diff(shape, hole);
    engrave = diff(engrave, hole);
  } else {
    // Vorlagen: Kugel oder Stern, Name in der Mitte
    const W = lb.x1 - lb.x0, cx = (lb.x0 + lb.x1) / 2, cy = (base + lb.y1) / 2;
    let body: MultiPolygon, topY: number;
    if (o.template === "ball") {
      const R = Math.max(W * 0.62, H * 1.3);
      const capW = R * 0.42, capH = R * 0.24;
      body = union([disk(cx, cy, R), box(cx - capW / 2, cy + R - capH * 0.4, cx + capW / 2, cy + R + capH * 0.6, capH * 0.15)]);
      topY = cy + R + capH * 0.6;
      if (o.hanger !== "ringTop" && o.hanger !== "none") hole = disk(cx, cy + R + capH * 0.12, Math.min(o.holeD / 2, capW * 0.3, capH * 0.3));
    } else {
      const Ro = Math.max(W * 0.8, H * 2.2), Ri = Ro * 0.48;
      const pts: Pt[] = Array.from({ length: 10 }, (_, i) => {
        const a = Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? Ri : Ro;
        return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
      });
      body = [[ring(pts)]];
      topY = cy + Ro;
      if (o.hanger !== "ringTop" && o.hanger !== "none") hole = disk(cx, cy + Ro * 0.72, Math.min(o.holeD / 2, Ro * 0.07));
    }
    if (o.hanger === "ringTop") {
      const rIn = Math.max(0.5, o.holeD / 2), rOut = rIn + Math.max(1.5, H * 0.08), ccy = topY + rOut * 0.55;
      body = union([body, disk(cx, ccy, rOut)]); hole = disk(cx, ccy, rIn);
    }
    // Name: gravieren oder ausschneiden (wie eine Schablone – Innenräume von o, a … fallen mit heraus)
    if (o.score && glyphs.length) scores = overlapScores(glyphs);
    if (o.inner === "engrave") { engrave = letters; cut = diff(body, hole); }
    else if (o.inner === "score") { lines = [...outlineLines(letters), ...scores]; cut = diff(body, hole); }
    else if (o.inner === "layer") { top = letters; lines = scores; cut = diff(body, hole); }
    else cut = diff(body, union([hole, solid(letters)]));
  }
  top = diff(top, hole);
  const linesTop = !!top.length;
  lines = clipLines(lines, linesTop ? top : cut, 0.2);
  const all = bounds(union([cut, engrave, top]));
  return { cut, engrave, top, lines, linesTop, pieces: countPieces(cut), w: all.x1 - all.x0, h: all.y1 - all.y0, openFont };
}

/** SVG-Text → geschlossene Konturen (mm, y nach oben), höchstens 400 Punkte je Kontur */
function svgRings(text: string): XY[][] {
  const res = parseSvg(text);
  const rings: XY[][] = res.paths.filter(p => p.closed && p.pts.length >= 3).map(p => p.pts.map(q => [q.x, q.y] as XY));
  for (const c of res.circles) rings.push(Array.from({ length: 48 }, (_, i) => [c.cx + c.r * Math.cos((i / 48) * Math.PI * 2), c.cy + c.r * Math.sin((i / 48) * Math.PI * 2)] as XY));
  return rings.slice(0, 200).map(r => { const k = Math.ceil(r.length / 400); return k > 1 ? r.filter((_, i) => i % k === 0) : r; });
}

// =====================================================================
// FENSTER
// =====================================================================

function load(): NameOptions {
  try { return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...DEF }; }
}

function previewSvg(r: NameResult): string {
  const ln = (l: ScoreLine) => l.pts.map(([x, y], i) => `${i ? "L" : "M"}${(x - b.x0 + pad).toFixed(2)},${(b.y1 - y + pad).toFixed(2)}`).join("") + (l.closed ? "Z" : "");
  const b = bounds(union([r.cut, r.engrave, r.top]));
  if (!isFinite(b.x0)) return "";
  const pad = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.04 + 1;
  const d = (m: MultiPolygon) => m.map(poly => poly.map(rg => rg.map(([x, y], i) => `${i ? "L" : "M"}${(x - b.x0 + pad).toFixed(2)},${(b.y1 - y + pad).toFixed(2)}`).join("") + "Z").join("")).join("");
  const sw = Math.max(b.x1 - b.x0, b.y1 - b.y0) / 400;
  return `<svg viewBox="0 0 ${(b.x1 - b.x0 + 2 * pad).toFixed(2)} ${(b.y1 - b.y0 + 2 * pad).toFixed(2)}" style="width:100%;height:240px;">
    <path d="${d(r.cut)}" fill="#c98a4b" fill-rule="evenodd" stroke="#ffd28a" stroke-width="${sw.toFixed(2)}"/>
    <path d="${d(r.engrave)}" fill="#5a3a1c" fill-rule="evenodd"/>
    <path d="${d(r.top)}" fill="#efdcb4" fill-rule="evenodd" stroke="#5a3a1c" stroke-width="${(sw * 1.5).toFixed(2)}"/>
    <path d="${r.lines.map(ln).join("")}" fill="none" stroke="#3ccf4e" stroke-width="${(sw * 1.6).toFixed(2)}" stroke-linecap="round"/></svg>`;
}

export function openNameGenerator(log: (s: string) => void, done: () => void) {
  const init = load();
  document.getElementById("name-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "name-dialog-overlay";
  ov.className = "dlg-overlay";
  const sel = (id: string, key: string, opts: [string, string][]) =>
    `<label class="dlg-row"><span>${t(key)}</span><select id="${id}" style="width:auto;max-width:190px;">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>`;
  const num = (id: string, key: string, step: string, min = "0") =>
    `<label class="dlg-row"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="${min}" step="${step}"><em>mm</em></span></label>`;
  const sym = [["", t("ng.symNone")] as [string, string], ...NAME_SYMBOLS.map(s => [s, t("sl." + s)] as [string, string]),
    ...NAME_ICONS.map(s => [s.id, t("ng.ic." + s.id)] as [string, string]), ["own", t("ng.ownSym")] as [string, string]];
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(860px, calc(100vw - 32px));">
      <h3>✍ ${t("ngen.title")}</h3>
      <div class="dlg-hint">${t("ng.desc")}</div>
      <div style="display:grid;grid-template-columns:300px 1fr;gap:12px;align-items:start;">
        <div class="box-fields">
          <input id="ng-text" type="text" maxlength="60" style="width:100%;box-sizing:border-box;font-size:1rem;">
          ${sel("ng-tpl", "ng.template", [["name", t("ng.tpl.name")], ["ball", t("ng.tpl.ball")], ["star", t("ng.tpl.star")]])}
          <label class="dlg-row"><span>${t("text.font")}</span><div id="ng-font" style="width:170px;"></div></label>
          <label class="dlg-row" style="cursor:pointer;"><span>${t("text.bold")}</span><input id="ng-bold" type="checkbox" style="width:auto;"></label>
          ${num("ng-h", "ng.height", "1", "3")}
          ${num("ng-w", "ng.width", "1")}
          ${num("ng-sp", "ng.spacing", "0.1", "-20")}
          ${num("ng-thick", "ng.thicken", "0.1")}
          <label class="dlg-row" style="cursor:pointer;" title="${t("ng.scoreTip")}"><span>${t("ng.score")}</span><input id="ng-score" type="checkbox" style="width:auto;"></label>
          <div class="ng-only-name">
            ${sel("ng-con", "ng.connect", [["none", t("ng.con.none")], ["baseline", t("ng.con.baseline")], ["outline", t("ng.con.outline")]])}
            <div class="ng-only-bar">${num("ng-bar", "ng.bar", "0.5")}</div>
            <div class="ng-only-outline">${num("ng-out", "ng.outline", "0.5")}</div>
            ${sel("ng-front", "ng.front", sym)}
            ${sel("ng-back", "ng.back", sym)}
            <div class="ng-only-own dlg-row"><span id="ng-own-info" class="dlg-hint" style="margin:0;"></span>
              <button id="ng-own" class="btn-secondary" type="button">${t("ng.ownLoad")}</button>
              <input id="ng-own-file" type="file" accept=".svg,image/svg+xml" style="display:none;"></div>
          </div>
          <div class="ng-only-inner">${sel("ng-inner", "ng.inner", [["engrave", t("ng.inner.engrave")], ["cut", t("ng.inner.cut")], ["layer", t("ng.inner.layer")], ["score", t("ng.inner.score")]])}</div>
          ${sel("ng-hang", "ng.hanger", [["none", t("ng.hang.none")], ["ringLeft", t("ng.hang.ringLeft")], ["ringTop", t("ng.hang.ringTop")], ["hole", t("ng.hang.hole")]])}
          <div class="ng-only-hole">${num("ng-hd", "ng.holeD", "0.5", "1")}</div>
        </div>
        <div class="box-prev" style="min-height:280px;"><div id="ng-svg" style="flex:1;display:flex;align-items:center;"></div>
          <div id="ng-info" class="dlg-hint"></div><div id="ng-warn" class="dlg-hint" style="color:#ffb454;"></div></div>
      </div>
      <div class="dlg-buttons">
        <button id="ng-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="ng-ok" class="btn-primary">✔ ${t("ng.place")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  let font = init.font;
  createFontPicker($<HTMLElement>("ng-font"), font, f => { font = f; schedule(); });
  // Werte per value setzen (der Name ist fremder Text – nie ins innerHTML)
  $("ng-text").value = init.text;
  $<HTMLSelectElement>("ng-tpl").value = init.template;
  $("ng-bold").checked = init.bold;
  $("ng-h").value = String(init.height); $("ng-sp").value = String(init.spacing);
  $("ng-w").value = String(init.width); $("ng-thick").value = String(init.thicken); $("ng-score").checked = init.score;
  let own: XY[][] = Array.isArray(init.own) ? init.own : [];
  $<HTMLSelectElement>("ng-con").value = init.connect;
  $("ng-bar").value = String(init.bar); $("ng-out").value = String(init.outline);
  $<HTMLSelectElement>("ng-front").value = init.front; $<HTMLSelectElement>("ng-back").value = init.back;
  $<HTMLSelectElement>("ng-inner").value = init.inner;
  $<HTMLSelectElement>("ng-hang").value = init.hanger; $("ng-hd").value = String(init.holeD);

  const read = (): NameOptions => {
    const n = (id: string, d: number, min: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.max(min, v) : d; };
    const v = (id: string) => $<HTMLSelectElement>(id).value;
    return {
      text: $("ng-text").value, font, bold: $("ng-bold").checked, height: n("ng-h", DEF.height, 3), spacing: n("ng-sp", 0, -20),
      connect: v("ng-con") as Connect, bar: n("ng-bar", DEF.bar, 0.5), outline: n("ng-out", DEF.outline, 0.3),
      inner: v("ng-inner") as Inner, front: v("ng-front"), back: v("ng-back"), hanger: v("ng-hang") as Hanger,
      holeD: n("ng-hd", DEF.holeD, 1), template: v("ng-tpl") as Template,
      score: $("ng-score").checked, thicken: Math.min(5, n("ng-thick", 0, 0)), width: n("ng-w", 0, 0), own
    };
  };
  const sync = (o: NameOptions) => {
    const show = (cls: string, on: boolean) => ov.querySelectorAll<HTMLElement>("." + cls).forEach(el => { el.style.display = on ? "" : "none"; });
    show("ng-only-name", o.template === "name");
    show("ng-only-bar", o.connect === "baseline");
    show("ng-only-outline", o.connect === "outline");
    show("ng-only-inner", o.template !== "name" || o.connect === "outline");
    show("ng-only-hole", o.hanger !== "none");
    show("ng-only-own", o.front === "own" || o.back === "own");
    $<HTMLElement>("ng-own-info").textContent = own.length ? t("ng.ownOk") : t("ng.ownMissing");
    $<HTMLInputElement>("ng-h").disabled = o.width > 0; // fertige Breite bestimmt dann die Höhe
  };

  // Eigenes Symbol: SVG lesen (nur die Pfade, nichts davon kommt ins innerHTML), geschlossene Konturen als Ringe
  $<HTMLElement>("ng-own").onclick = () => $<HTMLInputElement>("ng-own-file").click();
  $<HTMLInputElement>("ng-own-file").onchange = async () => {
    const f = $<HTMLInputElement>("ng-own-file").files?.[0];
    if (!f) return;
    try { own = svgRings(await f.text()); } catch { own = []; }
    $<HTMLInputElement>("ng-own-file").value = "";
    if (!own.length) log(t("ng.ownNone"));
    schedule();
  };

  let last: NameResult | null = null, run = 0, timer = 0;
  const update = async () => {
    const o = read(), my = ++run;
    sync(o);
    const r = o.text.trim() ? await buildName(o) : null;
    if (my !== run) return; // inzwischen neu eingegeben
    last = r;
    $<HTMLElement>("ng-svg").innerHTML = r ? previewSvg(r) : "";
    $<HTMLElement>("ng-info").textContent = r && r.cut.length ? t("ng.info", { w: r.w.toFixed(1), h: r.h.toFixed(1) })
      + (r.lines.length ? " · " + t("ng.lines", { n: r.lines.length }) : "") : "";
    $<HTMLElement>("ng-warn").textContent = !r ? "" : r.openFont ? t("ng.openFont") : r.pieces > 1 ? t("ng.pieces", { n: r.pieces }) : "";
    $<HTMLButtonElement>("ng-ok").disabled = !r || !r.cut.length;
  };
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(update, 160); };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener(i.tagName === "SELECT" || (i as HTMLInputElement).type === "checkbox" ? "change" : "input", schedule));
  update();

  const close = () => { clearTimeout(timer); run++; ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("ng-cancel").onclick = close;
  $<HTMLElement>("ng-ok").onclick = async () => {
    clearTimeout(timer);
    await update();
    const r = last;
    if (!r || !r.cut.length) return;
    const o = read();
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* egal */ }
    close();
    placeName(r, o);
    log(t(r.top.length ? "ng.doneLayer" : "ng.done", { w: r.w.toFixed(1), h: r.h.toFixed(1) }));
    done();
  };
  setTimeout(() => { const i = $("ng-text"); i.focus(); i.select(); }, 0);
}

/**
 * Ergebnis als eine Gruppe in die Bettmitte: Schnitt (stärkste Linien-Ebene / außen+innen), Gravur (Füll-Ebene / Tasche).
 * „Eigenes Teil“: Rückplatte und Schriftzug als zwei Gruppen, der Schriftzug 8 mm über der Rückplatte
 * (meist aus anderem Material – dann einfach aufs zweite Bett schieben).
 */
function placeName(r: NameResult, o: NameOptions) {
  const st = app();
  const bed = bedSizeMm();
  const b = bounds(union([r.cut, r.engrave, r.top]));
  const lift = r.top.length ? (b.y1 - b.y0 + 8) / 2 : 0;
  const dx = bed.w / 2 - (b.x0 + b.x1) / 2, dy = bed.h / 2 - (b.y0 + b.y1) / 2 - lift;
  const px = (m: MultiPolygon, up = 0): MultiPolygon => m.map(p => p.map(rg => rg.map(([x, y]) => [(x + dx) * MM_TO_PIXEL, (y + dy + up) * MM_TO_PIXEL] as [number, number])));
  const layers = getLayers();
  const cutL = layers.filter(l => l.mode === "line").sort((a, c) => c.power - a.power)[0];
  const engL = layers.find(l => l.mode === "fill");
  const groupId = "name-" + newId();
  const cut = toShapes(px(r.cut), cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId, source: o.text.slice(0, 40) }));
  const eng = toShapes(px(r.engrave), engL ? { laserLayerId: engL.id } : {})
    .map(s => ({ ...s, groupId, millingMode: "pocket", millingDepth: -0.5, source: o.text.slice(0, 40) }));
  const topId = "name-" + newId();
  const top = toShapes(px(r.top, 2 * lift), cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId: topId, source: o.text.slice(0, 40) }));
  // Gravurlinien: schwächste Linien-Ebene (wie „Verbinden + anritzen“), an der Fräse flach graviert
  const mark = layers.filter(l => l.mode === "line").sort((a, c) => a.power - c.power)[0];
  const lines = r.lines.map(l => createPolyline(l.pts.map(([x, y]) => ({ x: (x + dx) * MM_TO_PIXEL, y: (y + dy + (r.linesTop ? 2 * lift : 0)) * MM_TO_PIXEL })),
    l.closed, "on-line", { ...(mark ? { laserLayerId: mark.id } : {}), millingDepth: -0.3, isScore: true, groupId: r.linesTop ? topId : groupId, source: o.text.slice(0, 40) }));
  const made = [...cut, ...eng, ...top, ...lines];
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}
