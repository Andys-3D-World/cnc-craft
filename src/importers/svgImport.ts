/**
 * SVG-IMPORT (Inkscape, Illustrator, CorelDRAW, Affinity, Fusion-Export ...)
 *
 * Unterstützt: path (alle Befehle M L H V C S Q T A Z, absolut und relativ),
 * rect (auch mit runden Ecken), circle, ellipse, line, polyline, polygon,
 * Gruppen, <use>, Transformationen (matrix/translate/scale/rotate/skew),
 * Einheiten über width/height/viewBox (mm, cm, in, pt, pc, px).
 * Ausgeblendete Elemente und <defs>/<clipPath>/<mask> werden übersprungen.
 *
 * Texte in SVG werden NICHT übernommen (dafür "Objekt in Pfad umwandeln" im Grafikprogramm).
 */
import {
  ImportResult, ImpOrigin, emptyResult, Mat, matMul, matApply, matTranslate, matScale,
  matScaleFactor, matIsUniform, arcSegments, CURVE_TOL, Pt
} from "./common";
import { parseTransform, parsePathData } from "./svgPath";
import { checkImport, importInApp } from "./importRust";
import { t } from "../i18n/i18n";

const PX_PER_INCH = 96; // Inkscape / Browser-Standard
/** Höchstens so viele Elemente (mit allen <use>-Kopien) – echte Zeichnungen bleiben weit darunter */
export const SVG_MAX_VISITS = 300_000;

const UNIT_MM: Record<string, number> = {
  mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / PX_PER_INCH, "": 25.4 / PX_PER_INCH, q: 0.25
};

function lengthToMm(v: string | null): number | null {
  if (!v) return null;
  const m = v.trim().match(/^([-+]?[\d.]+(?:e[-+]?\d+)?)\s*([a-z%]*)$/i);
  if (!m || m[2] === "%") return null;
  const f = UNIT_MM[m[2].toLowerCase()];
  return f === undefined ? null : parseFloat(m[1]) * f;
}

export function parseSvg(text: string): ImportResult {
  const res = emptyResult();
  // für den Vergleich mit Rust (importsvg.rs): jeder Pfad und jede Transformation, mit dem, was das TypeScript daraus macht
  const rust = { paths: [] as [string, number][], transforms: [] as string[] }, got = { paths: [] as unknown[], transforms: [] as Mat[] };
  const rec = importInApp();
  const transform = (t: string) => { const m = parseTransform(t); if (rec) { rust.transforms.push(t); got.transforms.push(m); } return m; };
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) {
    throw new Error(t("svg.errInvalid"));
  }

  // ---- Einheiten: Benutzer-Einheit -> mm ----
  const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(parseFloat);
  const hasVB = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  const wMm = lengthToMm(svg.getAttribute("width"));
  const hMm = lengthToMm(svg.getAttribute("height"));
  let sx = UNIT_MM.px, sy = UNIT_MM.px, ox = 0, oy = 0;
  if (hasVB) {
    sx = wMm ? wMm / vb[2] : UNIT_MM.px;
    sy = hMm ? hMm / vb[3] : (wMm ? sx : UNIT_MM.px);
    if (!hMm && wMm) sy = sx;
    ox = vb[0]; oy = vb[1];
  }
  const docHmm = hMm ?? (hasVB ? vb[3] * sy : 0);

  // SVG: Y nach unten -> Maschine: Y nach oben. Dokument-Oberkante = docHmm.
  const root: Mat = matMul([1, 0, 0, -1, 0, docHmm], matMul(matScale(sx, sy), matTranslate(-ox, -oy)));

  const ids = new Map<string, Element>();
  svg.querySelectorAll("[id]").forEach(el => ids.set(el.getAttribute("id")!, el));
  let skippedText = 0, skippedImage = 0;
  // <use> kann auf Gruppen zeigen, die wieder <use> enthalten: jede Ebene verdoppelt die Arbeit.
  // Ohne Obergrenze friert eine präparierte Datei von wenigen KB das Programm ein.
  let visits = 0, tooBig = false;

  // Herkunft der Formen für „Zeichnung neu einlesen“: id des Elements (bei <use> mit dessen id davor) und Ebene (Inkscape)
  let origin: ImpOrigin = {}, sub = 0;
  const from = (): ImpOrigin => ({ ...(origin.keys ? { keys: [origin.keys[0] + (sub ? "#" + sub : "")] } : {}), ...(origin.layer ? { layer: origin.layer } : {}) });

  const walk = (el: Element, m: Mat, depth: number, use: string | null = "", layer = "") => {
    if (depth > 50 || tooBig) return;
    if (++visits > SVG_MAX_VISITS) { tooBig = true; return; }
    const tag = el.localName.toLowerCase();
    if (["defs", "clippath", "mask", "symbol", "metadata", "title", "desc", "style", "script", "marker", "pattern", "lineargradient", "radialgradient", "filter"].includes(tag)) return;
    if (isHidden(el)) return;

    const t = el.getAttribute("transform");
    const mm = t ? matMul(m, transform(t)) : m;
    const id = el.getAttribute("id") || "";
    if (tag === "g" && el.getAttribute("inkscape:groupmode") === "layer") layer = el.getAttribute("inkscape:label") || id;
    // Kopie über ein <use> ohne id: keine eindeutige Kennung
    origin = { ...(id && use !== null ? { keys: [use + id] } : {}), ...(layer ? { layer } : {}) };
    sub = 0;

    switch (tag) {
      case "svg":
      case "g":
      case "a":
      case "switch":
        for (const c of Array.from(el.children)) walk(c, mm, depth + 1, use, layer);
        return;
      case "use": {
        const href = el.getAttribute("href") || el.getAttribute("xlink:href") || "";
        const ref = ids.get(href.replace(/^#/, ""));
        if (!ref) return;
        const x = num(el, "x"), y = num(el, "y");
        const um = matMul(mm, matTranslate(x, y));
        const inner = id && use !== null ? use + id + "/" : null;
        if (ref.localName.toLowerCase() === "symbol") for (const c of Array.from(ref.children)) walk(c, um, depth + 1, inner, layer);
        else walk(ref, um, depth + 1, inner, layer);
        return;
      }
      case "path": addPathData(el.getAttribute("d") || "", mm); return;
      case "rect": addRect(el, mm); return;
      case "circle": {
        const r = num(el, "r");
        if (r > 0) addEllipse(num(el, "cx"), num(el, "cy"), r, r, mm);
        return;
      }
      case "ellipse": {
        const rx = num(el, "rx"), ry = num(el, "ry");
        if (rx > 0 && ry > 0) addEllipse(num(el, "cx"), num(el, "cy"), rx, ry, mm);
        return;
      }
      case "line":
        addPoly([{ x: num(el, "x1"), y: num(el, "y1") }, { x: num(el, "x2"), y: num(el, "y2") }], false, mm);
        return;
      case "polyline":
      case "polygon": {
        const v = (el.getAttribute("points") || "").trim().split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
        const pts: Pt[] = [];
        for (let i = 0; i + 1 < v.length; i += 2) pts.push({ x: v[i], y: v[i + 1] });
        addPoly(pts, tag === "polygon", mm);
        return;
      }
      case "text":
      case "tspan":
      case "textpath":
        skippedText++;
        return;
      case "image":
        skippedImage++;
        return;
      default:
        for (const c of Array.from(el.children)) walk(c, mm, depth + 1, use, layer);
    }
  };

  const addPoly = (pts: Pt[], closed: boolean, m: Mat) => {
    if (pts.length < 2) return;
    res.paths.push({ pts: pts.map(p => matApply(m, p.x, p.y)), closed, ...from() });
    sub++; // weitere Teilpfade desselben Elements
  };

  const addEllipse = (cx: number, cy: number, rx: number, ry: number, m: Mat) => {
    if (rx === ry && matIsUniform(m)) {
      const c = matApply(m, cx, cy);
      res.circles.push({ cx: c.x, cy: c.y, r: rx * matScaleFactor(m), ...from() });
      return;
    }
    const tol = CURVE_TOL / matScaleFactor(m);
    const n = Math.max(24, arcSegments(Math.max(rx, ry), Math.PI * 2, tol));
    const pts: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
    }
    addPoly(pts, true, m);
  };

  const addRect = (el: Element, m: Mat) => {
    const x = num(el, "x"), y = num(el, "y"), w = num(el, "width"), h = num(el, "height");
    if (w <= 0 || h <= 0) return;
    let rx = el.hasAttribute("rx") ? num(el, "rx") : NaN;
    let ry = el.hasAttribute("ry") ? num(el, "ry") : NaN;
    if (isNaN(rx) && !isNaN(ry)) rx = ry;
    if (isNaN(ry) && !isNaN(rx)) ry = rx;
    rx = Math.min(isNaN(rx) ? 0 : rx, w / 2); ry = Math.min(isNaN(ry) ? 0 : ry, h / 2);
    if (rx <= 0 || ry <= 0) {
      addPoly([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], true, m);
      return;
    }
    const d = `M${x + rx},${y} H${x + w - rx} A${rx},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} ` +
      `A${rx},${ry} 0 0 1 ${x + w - rx},${y + h} H${x + rx} A${rx},${ry} 0 0 1 ${x},${y + h - ry} ` +
      `V${y + ry} A${rx},${ry} 0 0 1 ${x + rx},${y} Z`;
    addPathData(d, m);
  };

  const addPathData = (d: string, m: Mat) => {
    const tol = CURVE_TOL / matScaleFactor(m);
    const subs = parsePathData(d, tol);
    if (rec) { rust.paths.push([d, tol]); got.paths.push(structuredClone(subs)); }
    for (const sub of subs) addPoly(sub.pts, sub.closed, m);
  };

  walk(svg, root, 0);
  if (tooBig) throw new Error(t("svg.errTooBig"));
  if (rec) checkImport("import_svg", rust, got);

  if (skippedText) res.warnings.push(t("svg.textSkipped", { n: skippedText }));
  if (skippedImage) res.warnings.push(t("svg.imageSkipped", { n: skippedImage }));
  res.info = t("svg.info", { paths: res.paths.length, circles: res.circles.length }) + (wMm ? ", " + t("svg.doc", { w: wMm.toFixed(1), h: (hMm ?? 0).toFixed(1) }) : ", " + t("svg.px"));
  return res;
}

function num(el: Element, attr: string): number {
  const v = el.getAttribute(attr);
  if (!v) return 0;
  const mm = lengthToMm(v);
  // In Attributen sind Zahlen ohne Einheit Benutzer-Einheiten
  const n = parseFloat(v);
  if (/[a-z]$/i.test(v.trim()) && mm !== null) return mm / UNIT_MM.px; // z.B. "10mm" in Benutzer-Einheiten (px)
  return Number.isFinite(n) ? n : 0;
}

function isHidden(el: Element): boolean {
  const style = (el.getAttribute("style") || "").replace(/\s/g, "").toLowerCase();
  if (el.getAttribute("display") === "none" || style.includes("display:none")) return true;
  if (el.getAttribute("visibility") === "hidden" || style.includes("visibility:hidden")) return true;
  return false;
}

export { parseTransform, parsePathData };
