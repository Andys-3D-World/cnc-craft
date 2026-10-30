/**
 * NAMEN-GENERATOR (Extras → Namen-Generator)
 *
 * Ein Name wird zu einem zusammenhängenden Schriftzug, der in einem Stück ausgeschnitten werden kann:
 *  - die Buchstaben (Schrift aus fonts.ts, Abstand auch negativ = überlappen) werden vereinigt
 *  - Verbindung: keine (Schreibschrift berührt sich selbst), Grundlinie (Steg unter den Buchstaben) oder
 *    Umriss (Versatz um alle Buchstaben, Innenräume gefüllt – die Buchstaben auf Wunsch als Gravur obendrauf)
 *  - beliebig viele Symbole (Formen-Bibliothek, nameIcons.ts, eigenes SVG): im Raster anklicken, in der Vorschau
 *    hinziehen, Größe/Drehung einstellen; sie werden mit dem Namen vereinigt. Aufhänger als Ring oder Loch
 *  - Ritzlinien: wo sich Buchstaben überlappen, bleibt die Kante des oberen als Gravurlinie (nameConnect.ts) –
 *    dafür wird jeder Buchstabe einzeln nachgezeichnet. Fettung macht dünne Schriften stabiler.
 *  - Fertige Breite: der Schriftzug wird so skaliert, dass er genau so breit wird
 *  (Weihnachtskugel und -stern mit Namen gibt es im Weihnachtsschmuck-Generator, editor/ornamentGen.ts)
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
import { grow, union, bounds, overlapScores, clipLines, outlineLines, scaleArea, scaleLines, rotateArea, ScoreLine, XY } from "../nameConnect";
import { createFontPicker } from "./fontPicker";
import { SHAPES } from "./shapeLibrary";
import { getLayers } from "../laserLayers";
import { t } from "../i18n/i18n";

export type Connect = "none" | "baseline" | "outline";
export type Hanger = "none" | "ringLeft" | "ringTop" | "hole";
export type Inner = "engrave" | "cut" | "layer" | "score";

export interface NameOptions {
  text: string; font: string; bold: boolean;
  height: number;      // Großbuchstaben-Höhe (mm)
  spacing: number;     // zusätzlicher Buchstabenabstand (mm), negativ = überlappen
  connect: Connect;
  bar: number;         // Dicke der Grundlinie (mm)
  outline: number;     // Abstand des Umrisses (mm)
  inner: Inner;        // Umriss: Buchstaben gravieren, ausschneiden oder als eigenes Teil (Rückplatte)
  syms: NameSym[];     // Symbole am Namen
  hanger: Hanger;
  holeD: number;       // Loch-Ø des Aufhängers (mm)
  score: boolean;      // Ritzlinien, wo sich Buchstaben/Symbole überlappen
  thicken: number;     // Fettung: jeder Buchstabe wächst um so viel (mm), Innenräume bleiben
  width: number;       // fertige Breite (mm), 0 = die Höhe gilt
  own: XY[][];         // eigenes Symbol (Ringe aus einem SVG, mm, y nach oben) für id = "own"
}

/**
 * Ein Symbol am Namen. Maße in Großbuchstaben-Höhen (so wächst es mit der Schrift mit):
 * unten links bei x/y, bezogen auf die Grundlinie und – je nach a – die linke (0) oder rechte (1) Kante des Namens
 * (Symbole am Ende bleiben am Ende, wenn der Name länger wird). s = Höhe, r = Drehung in Grad.
 */
export interface NameSym { id: string; a: 0 | 1; x: number; y: number; s: number; r: number }

export const NAME_SYMBOLS = ["heart", "star5", "star6", "moon", "drop", "leaf", "paw", "flower", "tree", "cloud", "bolt", "check"];

export interface NameResult {
  cut: MultiPolygon; engrave: MultiPolygon;
  top: MultiPolygon;   // „eigenes Teil“: Schriftzug, der auf die Rückplatte (cut) geklebt wird
  syms: MultiPolygon[]; // jedes Symbol einzeln (für die Vorschau: anklicken und ziehen)
  origin: XY; unit: number; // Kante links/rechts des Namens (x0, x1) auf der Grundlinie bzw. mm je Großbuchstaben-Höhe
  originR: number;
  lines: ScoreLine[];  // Gravurlinien (Ritzlinien an Überlappungen, Konturen bei „als Linie gravieren“)
  linesTop: boolean;   // Linien gehören zum Schriftzug („eigenes Teil“), nicht zur Rückplatte
  pieces: number; w: number; h: number; openFont: boolean;
}

const KEY = "cnc_craft_namegen";
const DEF: NameOptions = {
  text: "Andreas", font: "Pacifico", bold: false, height: 25, spacing: 0, connect: "baseline", bar: 4, outline: 2.5,
  inner: "engrave", syms: [{ id: "heart", a: 1, x: -0.06, y: 0, s: 1, r: 0 }], hanger: "none", holeD: 4,
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

/** Umriss eines Symbols im 100er-Feld (für die Bilder im Raster) */
export const symbolPath = (id: string) => (SHAPES.find(q => q.id === id) || NAME_ICONS.find(q => q.id === id))?.d || "";

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
  return {
    ...r, cut: scaleArea(r.cut, k), engrave: scaleArea(r.engrave, k), top: scaleArea(r.top, k), lines: scaleLines(r.lines, k),
    syms: r.syms.map(m => scaleArea(m, k)), origin: [r.origin[0] * k, r.origin[1] * k], originR: r.originR * k, unit: r.unit * k, w: r.w * k, h: r.h * k
  };
}

const glyphCache = new Map<string, MultiPolygon[]>();

async function buildAt(o: NameOptions): Promise<NameResult> {
  const tp: TextParams = {
    text: o.text.replace(/\s*\n\s*/g, " ").trim() || " ", font: o.font, heightMm: o.height, bold: o.bold, italic: false,
    align: "left", lineSpacing: 170, letterSpacing: o.spacing
  };
  // Ritzlinien/Fettung brauchen jeden Buchstaben einzeln (Einzellinien-Schrift: null → wie bisher)
  let glyphs: MultiPolygon[] = [];
  if (o.score || o.thicken > 0) {
    // Zwischenspeicher: beim Ziehen eines Symbols ändert sich die Schrift nicht
    const key = JSON.stringify([tp, o.thicken]);
    const hit = glyphCache.get(key);
    if (hit) glyphs = hit;
    else {
      const g = await traceGlyphsWithFont(tp);
      if (g) glyphs = g.map(textRegion).filter(m => m.length).map(m => (o.thicken > 0 ? grow(m, o.thicken, true) : m));
      glyphCache.set(key, glyphs);
      if (glyphCache.size > 6) glyphCache.delete(glyphCache.keys().next().value!);
    }
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
  const empty: NameResult = { cut: [], engrave: [], top: [], syms: [], origin: [0, 0], originR: 0, unit: 1, lines: [], linesTop: false, pieces: 0, w: 0, h: 0, openFont };
  if (!letters.length) return empty;
  const lb = bounds(letters), base = baselineOf(letters);
  let engrave: MultiPolygon = [], top: MultiPolygon = [];
  let scores: ScoreLine[] = [], lines: ScoreLine[] = [];
  let hole: MultiPolygon = [];
  const H = o.height;

  // Symbole liegen über den Buchstaben (ihre Kanten werden zu Ritzlinien, wo sie den Namen überdecken)
  const symAreas = (o.syms || []).map(q => rotateArea(libShape(q.id, (q.a ? lb.x1 : lb.x0) + q.x * H, base + q.y * H, Math.max(0.1, q.s) * H, o.own), q.r));
  const parts: MultiPolygon[] = [letters, ...symAreas];
  const sb = bounds(union(parts));
  const x0 = sb.x0, x1 = sb.x1;
  if (o.score && glyphs.length) scores = overlapScores([...glyphs, ...symAreas]);
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
  const cut = diff(shape, hole);
  engrave = diff(engrave, hole);
  top = diff(top, hole);
  const linesTop = !!top.length;
  lines = clipLines(lines, linesTop ? top : cut, 0.2);
  const all = bounds(union([cut, engrave, top]));
  return { cut, engrave, top, syms: symAreas, origin: [lb.x0, base], originR: lb.x1, unit: H, lines, linesTop, pieces: countPieces(cut), w: all.x1 - all.x0, h: all.y1 - all.y0, openFont };
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
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    // ältere Fassung: ein Symbol vorn und eins hinten
    if (!Array.isArray(raw.syms) && (raw.front !== undefined || raw.back !== undefined)) {
      raw.syms = [];
      if (raw.front) raw.syms.push({ id: raw.front, a: 0, x: -1, y: 0, s: 1, r: 0 });
      if (raw.back) raw.syms.push({ id: raw.back, a: 1, x: -0.06, y: 0, s: 1, r: 0 });
    }
    // ältere Fassung: Vorlagen Kugel/Stern (jetzt im Weihnachtsschmuck-Generator) → normaler Schriftzug
    delete raw.template;
    const o = { ...DEF, ...raw };
    o.syms = (Array.isArray(o.syms) ? o.syms : []).filter((q: any) => q && typeof q.id === "string")
      .map((q: any) => ({ id: q.id, a: q.a ? 1 : 0, x: +q.x || 0, y: +q.y || 0, s: +q.s || 1, r: +q.r || 0 }));
    return o;
  } catch { return { ...DEF }; }
}

function previewSvg(r: NameResult, sel: number): string {
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
    <path d="${r.lines.map(ln).join("")}" fill="none" stroke="#3ccf4e" stroke-width="${(sw * 1.6).toFixed(2)}" stroke-linecap="round"/>
    ${r.syms.map((m, i) => `<path class="ng-sym" data-i="${i}" d="${d(m)}" fill="rgba(255,255,255,0.01)" fill-rule="evenodd" style="cursor:move;"
      stroke="${i === sel ? "#4ea8ff" : "none"}" stroke-width="${(sw * 2).toFixed(2)}" stroke-dasharray="${(sw * 6).toFixed(2)}"/>`).join("")}</svg>`;
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
  // Symbol-Raster: Bilder statt Namen (Name nur als Tooltip); die Pfade sind unsere eigenen Daten
  const tile = (id: string, label: string, inner: string) =>
    `<button type="button" class="ng-tile" data-id="${id}" title="${label}" style="width:36px;height:36px;padding:4px;display:flex;align-items:center;justify-content:center;">${inner}</button>`;
  const grid = [...NAME_ICONS.map(s => [s.id, t("ng.ic." + s.id)]), ...NAME_SYMBOLS.map(s => [s, t("sl." + s)])]
    .map(([id, label]) => tile(id, label, `<svg viewBox="0 0 100 100" width="26" height="26"><path d="${symbolPath(id)}" fill="currentColor" fill-rule="evenodd"/></svg>`)).join("")
    + tile("own", t("ng.ownSym"), `<span style="font-size:0.62rem;line-height:1;">SVG<br>+</span>`);
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(860px, calc(100vw - 32px));">
      <h3>✍ ${t("ngen.title")}</h3>
      <div class="dlg-hint">${t("ng.desc")}</div>
      <div style="display:grid;grid-template-columns:300px 1fr;gap:12px;align-items:start;">
        <div class="box-fields">
          <input id="ng-text" type="text" maxlength="60" style="width:100%;box-sizing:border-box;font-size:1rem;">
          <label class="dlg-row"><span>${t("text.font")}</span><div id="ng-font" style="width:170px;"></div></label>
          <label class="dlg-row" style="cursor:pointer;"><span>${t("text.bold")}</span><input id="ng-bold" type="checkbox" style="width:auto;"></label>
          ${num("ng-h", "ng.height", "1", "3")}
          ${num("ng-w", "ng.width", "1")}
          ${num("ng-sp", "ng.spacing", "0.1", "-20")}
          ${num("ng-thick", "ng.thicken", "0.1")}
          <label class="dlg-row" style="cursor:pointer;" title="${t("ng.scoreTip")}"><span>${t("ng.score")}</span><input id="ng-score" type="checkbox" style="width:auto;"></label>
          <div>
            ${sel("ng-con", "ng.connect", [["none", t("ng.con.none")], ["baseline", t("ng.con.baseline")], ["outline", t("ng.con.outline")]])}
            <div class="ng-only-bar">${num("ng-bar", "ng.bar", "0.5")}</div>
            <div class="ng-only-outline">${num("ng-out", "ng.outline", "0.5")}</div>
            <div class="dlg-row" style="margin-top:6px;"><span>${t("ng.symbols")}</span></div>
            <div id="ng-grid" style="display:flex;flex-wrap:wrap;gap:4px;max-height:120px;overflow-y:auto;">${grid}</div>
            <input id="ng-own-file" type="file" accept=".svg,image/svg+xml" style="display:none;">
            <div class="dlg-hint" style="margin:4px 0;">${t("ng.symHint")}</div>
            <div id="ng-symsel" style="display:none;">
              <label class="dlg-row"><span>${t("ng.symSize")}</span><span class="dlg-num"><input id="ng-ss" type="number" min="10" max="400" step="5"><em>%</em></span></label>
              <label class="dlg-row"><span>${t("ng.symRot")}</span><span class="dlg-num"><input id="ng-sr" type="number" step="15"><em>°</em></span></label>
              <div class="dlg-row"><span></span><button id="ng-sdel" type="button" class="btn-secondary">🗑 ${t("ng.symDel")}</button></div>
            </div>
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
  $("ng-bold").checked = init.bold;
  $("ng-h").value = String(init.height); $("ng-sp").value = String(init.spacing);
  $("ng-w").value = String(init.width); $("ng-thick").value = String(init.thicken); $("ng-score").checked = init.score;
  let own: XY[][] = Array.isArray(init.own) ? init.own : [];
  $<HTMLSelectElement>("ng-con").value = init.connect;
  $("ng-bar").value = String(init.bar); $("ng-out").value = String(init.outline);
  let syms: NameSym[] = init.syms.map(q => ({ ...q })), selSym = -1;
  $<HTMLSelectElement>("ng-inner").value = init.inner;
  $<HTMLSelectElement>("ng-hang").value = init.hanger; $("ng-hd").value = String(init.holeD);

  const read = (): NameOptions => {
    const n = (id: string, d: number, min: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.max(min, v) : d; };
    const v = (id: string) => $<HTMLSelectElement>(id).value;
    return {
      text: $("ng-text").value, font, bold: $("ng-bold").checked, height: n("ng-h", DEF.height, 3), spacing: n("ng-sp", 0, -20),
      connect: v("ng-con") as Connect, bar: n("ng-bar", DEF.bar, 0.5), outline: n("ng-out", DEF.outline, 0.3),
      inner: v("ng-inner") as Inner, syms: syms.map(q => ({ ...q })), hanger: v("ng-hang") as Hanger,
      holeD: n("ng-hd", DEF.holeD, 1),
      score: $("ng-score").checked, thicken: Math.min(5, n("ng-thick", 0, 0)), width: n("ng-w", 0, 0), own
    };
  };
  const sync = (o: NameOptions) => {
    const show = (cls: string, on: boolean) => ov.querySelectorAll<HTMLElement>("." + cls).forEach(el => { el.style.display = on ? "" : "none"; });
    show("ng-only-bar", o.connect === "baseline");
    show("ng-only-outline", o.connect === "outline");
    show("ng-only-inner", o.connect === "outline");
    show("ng-only-hole", o.hanger !== "none");
    $<HTMLElement>("ng-symsel").style.display = syms[selSym] ? "" : "none";
    if (syms[selSym]) {
      const ss = $("ng-ss"), sr = $("ng-sr");
      if (document.activeElement !== ss) ss.value = String(Math.round(syms[selSym].s * 100));
      if (document.activeElement !== sr) sr.value = String(Math.round(syms[selSym].r));
    }
    $<HTMLInputElement>("ng-h").disabled = o.width > 0; // fertige Breite bestimmt dann die Höhe
  };

  // Symbol hinzufügen: hinten an den Namen bzw. hinter das letzte Symbol, leicht überlappend
  const addSym = (id: string) => {
    let x = -0.06;
    if (last && last.unit > 0) {
      const b = bounds(union([last.cut, last.top]));
      x = (b.x1 - last.originR) / last.unit - 0.12;
    }
    syms.push({ id, a: 1, x, y: 0, s: 1, r: 0 });
    selSym = syms.length - 1;
    schedule();
  };
  $<HTMLElement>("ng-grid").addEventListener("click", e => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".ng-tile")?.dataset.id;
    if (!id) return;
    if (id === "own") $<HTMLInputElement>("ng-own-file").click();
    else addSym(id);
  });
  // Eigenes Symbol: SVG lesen (nur die Pfade, nichts davon kommt ins innerHTML), geschlossene Konturen als Ringe
  $<HTMLInputElement>("ng-own-file").onchange = async () => {
    const f = $<HTMLInputElement>("ng-own-file").files?.[0];
    if (!f) return;
    try { own = svgRings(await f.text()); } catch { own = []; }
    $<HTMLInputElement>("ng-own-file").value = "";
    if (!own.length) { log(t("ng.ownNone")); return; }
    addSym("own");
  };
  $("ng-ss").addEventListener("input", () => { const v = parseFloat($("ng-ss").value); if (syms[selSym] && v >= 10) { syms[selSym].s = Math.min(4, v / 100); schedule(); } });
  $("ng-sr").addEventListener("input", () => { const v = parseFloat($("ng-sr").value); if (syms[selSym] && Number.isFinite(v)) { syms[selSym].r = v; schedule(); } });
  $<HTMLElement>("ng-sdel").onclick = () => { if (syms[selSym]) { syms.splice(selSym, 1); selSym = -1; schedule(); } };

  // Symbole in der Vorschau anklicken (auswählen) und ziehen (verschieben)
  const prev = $<HTMLElement>("ng-svg");
  prev.addEventListener("pointerdown", e => {
    const el = (e.target as Element).closest?.(".ng-sym") as SVGPathElement | null;
    const svg = prev.querySelector("svg");
    if (!el || !svg || !last) { if (selSym >= 0) { selSym = -1; schedule(); } return; }
    e.preventDefault();
    const i = +(el.dataset.i || -1), q = syms[i];
    if (!q) return;
    selSym = i;
    prev.querySelectorAll(".ng-sym").forEach(p => p.setAttribute("stroke", p === el ? "#4ea8ff" : "none"));
    const ctm = svg.getScreenCTM()?.inverse();
    const at = (ev: PointerEvent) => { const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm); return [p.x, p.y]; };
    const [sx, sy] = at(e), unit = last.unit;
    let dx = 0, dy = 0;
    const move = (ev: PointerEvent) => {
      const [x, y] = at(ev);
      dx = x - sx; dy = y - sy;
      el.setAttribute("transform", `translate(${dx} ${dy})`);
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      if (Math.abs(dx) + Math.abs(dy) > 0.01) { q.x += dx / unit; q.y -= dy / unit; } // Vorschau: y nach unten
      schedule();
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  });

  let last: NameResult | null = null, run = 0, timer = 0;
  const update = async () => {
    const o = read(), my = ++run;
    sync(o);
    const r = o.text.trim() ? await buildName(o) : null;
    if (my !== run) return; // inzwischen neu eingegeben
    last = r;
    $<HTMLElement>("ng-svg").innerHTML = r ? previewSvg(r, selSym) : "";
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
