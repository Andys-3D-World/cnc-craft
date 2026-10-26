/**
 * NAMEN-GENERATOR (Extras → Namen-Generator)
 *
 * Ein Name wird zu einem zusammenhängenden Schriftzug, der in einem Stück ausgeschnitten werden kann:
 *  - die Buchstaben (Schrift aus fonts.ts, Abstand auch negativ = überlappen) werden vereinigt
 *  - Verbindung: keine (Schreibschrift berührt sich selbst), Grundlinie (Steg unter den Buchstaben) oder
 *    Umriss (Versatz um alle Buchstaben, Innenräume gefüllt – die Buchstaben auf Wunsch als Gravur obendrauf)
 *  - Symbole aus der Formen-Bibliothek vorn/hinten, Aufhänger als Ring oder Loch
 *  - Vorlagen „Weihnachtskugel“ und „Weihnachtsstern“: Anhänger mit Kappe/Loch, der Name graviert oder ausgeschnitten
 * Die Vorschau zeigt, ob alles ein Teil ist (sonst Warnung mit der Anzahl). Rechnung in mm mit polygon-clipping,
 * „Aufs Bett“ legt das Ergebnis als Gruppe in die Bettmitte.
 */
import polygonClipping, { MultiPolygon, Polygon, Ring } from "polygon-clipping";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, Pt, newId, makeRectPoints, makeEllipsePoints } from "../shapeTransform";
import { simplifyClosed } from "../traceUtil";
import { toShapes } from "./shapeOps";
import { traceTextWithFont, TracedText } from "./textTool";
import { createFontPicker } from "./fontPicker";
import { SHAPES } from "./shapeLibrary";
import { getLayers } from "../laserLayers";
import { t } from "../i18n/i18n";

export type Connect = "none" | "baseline" | "outline";
export type Hanger = "none" | "ringLeft" | "ringTop" | "hole";
export type Template = "name" | "ball" | "star";
export type Inner = "engrave" | "cut" | "layer";

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
}

export const NAME_SYMBOLS = ["heart", "star5", "star6", "moon", "drop", "leaf", "paw", "flower", "tree", "cloud", "bolt", "check"];

export interface NameResult {
  cut: MultiPolygon; engrave: MultiPolygon;
  top: MultiPolygon;   // „eigenes Teil“: Schriftzug, der auf die Rückplatte (cut) geklebt wird
  pieces: number; w: number; h: number; openFont: boolean;
}

const KEY = "cnc_craft_namegen";
const DEF: NameOptions = {
  text: "Andreas", font: "Pacifico", bold: false, height: 25, spacing: 0, connect: "baseline", bar: 4, outline: 2.5,
  inner: "engrave", front: "", back: "heart", hanger: "none", holeD: 4, template: "name"
};

// ---------- kleine Flächen-Helfer (mm) ----------
const ring = (pts: Pt[]): Ring => pts.map(p => [p.x, p.y] as [number, number]);
const union = (list: MultiPolygon[]): MultiPolygon => {
  const l = list.filter(m => m.length);
  return l.length > 1 ? polygonClipping.union(l[0], ...l.slice(1)) : l[0] || [];
};
const diff = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => (a.length && b.length ? polygonClipping.difference(a, b) : a);
const disk = (cx: number, cy: number, r: number): MultiPolygon => [[ring(makeEllipsePoints(cx, cy, r, r))]];
const box = (x0: number, y0: number, x1: number, y1: number, r = 0): MultiPolygon => [[ring(makeRectPoints(x0, y0, x1, y1, r))]];

function bounds(m: MultiPolygon) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of m) for (const [x, y] of poly[0] || []) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

/**
 * Umriss: jede Außenkontur um d nach außen, Innenräume (Löcher) bleiben gefüllt. Fläche ∪ „Kapsel“ (Streifen mit
 * runden Enden) entlang jeder Kante – robust auch bei verschnörkelten Schriften, wo ein Versatz der Kontur scheitert.
 */
function grow(m: MultiPolygon, d: number): MultiPolygon {
  const parts: MultiPolygon[] = [];
  const steps = Math.max(8, Math.min(16, Math.ceil(d * 5)));
  for (const poly of m) {
    if (!poly[0]) continue;
    const r = poly[0], last = r[r.length - 1];
    const pts = simplifyClosed((r.length > 1 && last[0] === r[0][0] && last[1] === r[0][1] ? r.slice(0, -1) : r).map(([x, y]) => ({ x, y })), Math.min(0.15, d / 8));
    if (pts.length < 3) continue;
    parts.push([[ring(pts)]]);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      const L = Math.hypot(c.x - a.x, c.y - a.y);
      if (L > 1e-9) {
        const nx = (-(c.y - a.y) / L) * d, ny = ((c.x - a.x) / L) * d;
        parts.push([[[[a.x + nx, a.y + ny], [c.x + nx, c.y + ny], [c.x - nx, c.y - ny], [a.x - nx, a.y - ny]]]]);
      }
      parts.push([[Array.from({ length: steps }, (_, k) => [a.x + d * Math.cos((k / steps) * Math.PI * 2), a.y + d * Math.sin((k / steps) * Math.PI * 2)] as [number, number])]]);
    }
  }
  return unionMany(parts);
}

/**
 * Viele Flächen vereinigen: Koordinaten auf 1/1000 mm runden und in kleinen Paketen (Baum) vereinigen – sonst
 * verschluckt sich polygon-clipping bei sehr vielen fast deckungsgleichen Kanten („Unable to find segment“).
 */
function unionMany(parts: MultiPolygon[]): MultiPolygon {
  const q = (v: number) => Math.round(v * 1000) / 1000;
  let list = parts.map(m => m.map(p => p.map(r => r.map(([x, y]) => [q(x), q(y)] as [number, number]))));
  while (list.length > 1) {
    const next: MultiPolygon[] = [];
    for (let i = 0; i < list.length; i += 16) {
      const chunk = list.slice(i, i + 16);
      try { next.push(polygonClipping.union(chunk[0], ...chunk.slice(1))); }
      catch { // einzeln nacheinander; was trotzdem scheitert, bleibt weg (nur ein Stück Rand)
        let acc = chunk[0];
        for (const c of chunk.slice(1)) { try { acc = polygonClipping.union(acc, c); } catch { /* überspringen */ } }
        next.push(acc);
      }
    }
    list = next;
  }
  return list[0] || [];
}

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

/** Form aus der Bibliothek (SVG-Pfad im 100er-Feld, y nach unten) als Fläche mit Höhe h, unten links bei (x, y) */
function libShape(id: string, x: number, y: number, h: number): MultiPolygon {
  const s = SHAPES.find(q => q.id === id);
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
  if (!rings.length) return [];
  const m = rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1));
  const b = bounds(m), k = h / Math.max(1e-6, b.y1 - b.y0);
  return m.map(poly => poly.map(r => r.map(([px, py]) => [x + (px - b.x0) * k, y + (py - b.y0) * k] as [number, number])));
}
const libWidth = (id: string, h: number) => { const m = libShape(id, 0, 0, h); const b = bounds(m); return m.length ? b.x1 - b.x0 : 0; };

/** Anzahl zusammenhängender Teile (Fläche mit ihren Löchern = ein Teil) */
const countPieces = (m: MultiPolygon) => m.filter(p => p[0] && p[0].length >= 3).length;

export async function buildName(o: NameOptions): Promise<NameResult> {
  const traced = (await traceTextWithFont({
    text: o.text.replace(/\s*\n\s*/g, " ").trim() || " ", font: o.font, heightMm: o.height, bold: o.bold, italic: false,
    align: "left", lineSpacing: 170, letterSpacing: o.spacing
  })).traced;
  const openFont = !!traced.closed?.some(c => !c);
  let letters = textRegion(traced);
  if (letters.length > 1) letters = union([letters]);
  const empty: NameResult = { cut: [], engrave: [], top: [], pieces: 0, w: 0, h: 0, openFont };
  if (!letters.length) return empty;
  const lb = bounds(letters), base = baselineOf(letters);
  let cut: MultiPolygon, engrave: MultiPolygon = [], top: MultiPolygon = [];
  let hole: MultiPolygon = [];
  const H = o.height;

  if (o.template === "name") {
    const parts: MultiPolygon[] = [letters];
    // Symbole vorn/hinten: so hoch wie die Großbuchstaben, 0,8 mm in den Schriftzug geschoben (damit sie hängen)
    const ov = Math.min(1.5, H * 0.06);
    let x0 = lb.x0, x1 = lb.x1;
    if (o.front) { const w = libWidth(o.front, H); parts.push(libShape(o.front, lb.x0 - w + ov, base, H)); x0 = lb.x0 - w + ov; }
    if (o.back) { parts.push(libShape(o.back, lb.x1 - ov, base, H)); x1 = lb.x1 - ov + libWidth(o.back, H); }
    if (o.connect === "baseline") {
      const bh = Math.max(0.5, o.bar);
      parts.push(box(x0 + bh / 2, base - bh * 0.6, x1 - bh / 2, base + bh * 0.4, bh / 2));
    }
    let shape = dropPinholes(union(parts), Math.max(1, (H * 0.08) ** 2));
    if (o.connect === "outline") {
      engrave = o.inner === "engrave" ? shape : [];
      if (o.inner === "layer") top = shape;
      const outer = solid(grow(shape, Math.max(0.3, o.outline)));
      shape = o.inner === "cut" ? diff(outer, solid(shape)) : outer;
    }
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
    if (o.inner === "engrave") { engrave = letters; cut = diff(body, hole); }
    else if (o.inner === "layer") { top = letters; cut = diff(body, hole); }
    else cut = diff(body, union([hole, solid(letters)]));
  }
  top = diff(top, hole);
  const all = bounds(union([cut, engrave, top]));
  return { cut, engrave, top, pieces: countPieces(cut), w: all.x1 - all.x0, h: all.y1 - all.y0, openFont };
}

// =====================================================================
// FENSTER
// =====================================================================

function load(): NameOptions {
  try { return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...DEF }; }
}

function previewSvg(r: NameResult): string {
  const b = bounds(union([r.cut, r.engrave, r.top]));
  if (!isFinite(b.x0)) return "";
  const pad = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.04 + 1;
  const d = (m: MultiPolygon) => m.map(poly => poly.map(rg => rg.map(([x, y], i) => `${i ? "L" : "M"}${(x - b.x0 + pad).toFixed(2)},${(b.y1 - y + pad).toFixed(2)}`).join("") + "Z").join("")).join("");
  const sw = Math.max(b.x1 - b.x0, b.y1 - b.y0) / 400;
  return `<svg viewBox="0 0 ${(b.x1 - b.x0 + 2 * pad).toFixed(2)} ${(b.y1 - b.y0 + 2 * pad).toFixed(2)}" style="width:100%;height:240px;">
    <path d="${d(r.cut)}" fill="#c98a4b" fill-rule="evenodd" stroke="#ffd28a" stroke-width="${sw.toFixed(2)}"/>
    <path d="${d(r.engrave)}" fill="#5a3a1c" fill-rule="evenodd"/>
    <path d="${d(r.top)}" fill="#efdcb4" fill-rule="evenodd" stroke="#5a3a1c" stroke-width="${(sw * 1.5).toFixed(2)}"/></svg>`;
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
  const sym = [["", t("ng.symNone")] as [string, string], ...NAME_SYMBOLS.map(s => [s, t("sl." + s)] as [string, string])];
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
          ${num("ng-sp", "ng.spacing", "0.1", "-20")}
          <div class="ng-only-name">
            ${sel("ng-con", "ng.connect", [["none", t("ng.con.none")], ["baseline", t("ng.con.baseline")], ["outline", t("ng.con.outline")]])}
            <div class="ng-only-bar">${num("ng-bar", "ng.bar", "0.5")}</div>
            <div class="ng-only-outline">${num("ng-out", "ng.outline", "0.5")}</div>
            ${sel("ng-front", "ng.front", sym)}
            ${sel("ng-back", "ng.back", sym)}
          </div>
          <div class="ng-only-inner">${sel("ng-inner", "ng.inner", [["engrave", t("ng.inner.engrave")], ["cut", t("ng.inner.cut")], ["layer", t("ng.inner.layer")]])}</div>
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
      holeD: n("ng-hd", DEF.holeD, 1), template: v("ng-tpl") as Template
    };
  };
  const sync = (o: NameOptions) => {
    const show = (cls: string, on: boolean) => ov.querySelectorAll<HTMLElement>("." + cls).forEach(el => { el.style.display = on ? "" : "none"; });
    show("ng-only-name", o.template === "name");
    show("ng-only-bar", o.connect === "baseline");
    show("ng-only-outline", o.connect === "outline");
    show("ng-only-inner", o.template !== "name" || o.connect === "outline");
    show("ng-only-hole", o.hanger !== "none");
  };

  let last: NameResult | null = null, run = 0, timer = 0;
  const update = async () => {
    const o = read(), my = ++run;
    sync(o);
    const r = o.text.trim() ? await buildName(o) : null;
    if (my !== run) return; // inzwischen neu eingegeben
    last = r;
    $<HTMLElement>("ng-svg").innerHTML = r ? previewSvg(r) : "";
    $<HTMLElement>("ng-info").textContent = r && r.cut.length ? t("ng.info", { w: r.w.toFixed(1), h: r.h.toFixed(1) }) : "";
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
  const made = [...cut, ...eng, ...top];
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}
