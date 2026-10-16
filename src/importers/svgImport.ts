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
  ImportResult, emptyResult, Mat, IDENTITY, matMul, matApply, matTranslate, matScale, matRotate,
  matScaleFactor, matIsUniform, flattenCubic, flattenQuad, arcSegments, CURVE_TOL, Pt
} from "./common";
import { t } from "../i18n/i18n";

const PX_PER_INCH = 96; // Inkscape / Browser-Standard

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

  const walk = (el: Element, m: Mat, depth: number) => {
    if (depth > 50) return;
    const tag = el.localName.toLowerCase();
    if (["defs", "clippath", "mask", "symbol", "metadata", "title", "desc", "style", "script", "marker", "pattern", "lineargradient", "radialgradient", "filter"].includes(tag)) return;
    if (isHidden(el)) return;

    const t = el.getAttribute("transform");
    const mm = t ? matMul(m, parseTransform(t)) : m;

    switch (tag) {
      case "svg":
      case "g":
      case "a":
      case "switch":
        for (const c of Array.from(el.children)) walk(c, mm, depth + 1);
        return;
      case "use": {
        const href = el.getAttribute("href") || el.getAttribute("xlink:href") || "";
        const ref = ids.get(href.replace(/^#/, ""));
        if (!ref) return;
        const x = num(el, "x"), y = num(el, "y");
        const um = matMul(mm, matTranslate(x, y));
        if (ref.localName.toLowerCase() === "symbol") for (const c of Array.from(ref.children)) walk(c, um, depth + 1);
        else walk(ref, um, depth + 1);
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
        for (const c of Array.from(el.children)) walk(c, mm, depth + 1);
    }
  };

  const addPoly = (pts: Pt[], closed: boolean, m: Mat) => {
    if (pts.length < 2) return;
    res.paths.push({ pts: pts.map(p => matApply(m, p.x, p.y)), closed });
  };

  const addEllipse = (cx: number, cy: number, rx: number, ry: number, m: Mat) => {
    if (rx === ry && matIsUniform(m)) {
      const c = matApply(m, cx, cy);
      res.circles.push({ cx: c.x, cy: c.y, r: rx * matScaleFactor(m) });
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
    for (const sub of parsePathData(d, tol)) addPoly(sub.pts, sub.closed, m);
  };

  walk(svg, root, 0);

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

export function parseTransform(t: string): Mat {
  let m: Mat = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let r: RegExpExecArray | null;
  while ((r = re.exec(t)) !== null) {
    const a = r[2].trim().split(/[\s,]+/).map(parseFloat);
    let n: Mat = IDENTITY;
    switch (r[1].toLowerCase()) {
      case "matrix": if (a.length >= 6) n = [a[0], a[1], a[2], a[3], a[4], a[5]]; break;
      case "translate": n = matTranslate(a[0] || 0, a[1] || 0); break;
      case "scale": n = matScale(a[0] ?? 1, a.length > 1 ? a[1] : a[0] ?? 1); break;
      case "rotate": {
        const rad = ((a[0] || 0) * Math.PI) / 180;
        n = matRotate(rad);
        if (a.length >= 3) n = matMul(matTranslate(a[1], a[2]), matMul(n, matTranslate(-a[1], -a[2])));
        break;
      }
      case "skewx": n = [1, 0, Math.tan(((a[0] || 0) * Math.PI) / 180), 1, 0, 0]; break;
      case "skewy": n = [1, Math.tan(((a[0] || 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = matMul(m, n);
  }
  return m;
}

/**
 * Zerlegt einen SVG-Pfad ("d"-Attribut) in Linienzüge. Ergebnis in Benutzer-Einheiten.
 */
export function parsePathData(d: string, tol: number): { pts: Pt[]; closed: boolean }[] {
  const tokens = tokenize(d);
  const out: { pts: Pt[]; closed: boolean }[] = [];
  let cur: Pt[] = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastCtrl: Pt | null = null, lastCmd = "";
  let i = 0;
  let cmd = "";

  const flush = (closed: boolean) => {
    if (cur.length >= 2) out.push({ pts: cur, closed });
    cur = [];
  };
  const isNum = () => i < tokens.length && typeof tokens[i] === "number";
  const n = () => tokens[i++] as number;
  // Bogen-Flags dürfen ohne Trennzeichen stehen ("0 01") -> tokenize liefert sie einzeln
  const flag = () => {
    const v = tokens[i++];
    return v === 1 || v === "1" ? 1 : 0;
  };

  while (i < tokens.length) {
    if (typeof tokens[i] === "string" && /[a-z]/i.test(tokens[i] as string)) cmd = tokens[i++] as string;
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    switch (C) {
      case "M": {
        if (!isNum()) { i++; break; }
        flush(false);
        x = (rel ? x : 0) + n(); y = (rel ? y : 0) + n();
        sx = x; sy = y;
        cur = [{ x, y }];
        cmd = rel ? "l" : "L"; // weitere Koordinaten = Linien
        lastCtrl = null;
        break;
      }
      case "L":
        if (!isNum()) { i++; break; }
        x = (rel ? x : 0) + n(); y = (rel ? y : 0) + n();
        cur.push({ x, y }); lastCtrl = null;
        break;
      case "H":
        if (!isNum()) { i++; break; }
        x = (rel ? x : 0) + n(); cur.push({ x, y }); lastCtrl = null;
        break;
      case "V":
        if (!isNum()) { i++; break; }
        y = (rel ? y : 0) + n(); cur.push({ x, y }); lastCtrl = null;
        break;
      case "C": {
        if (!isNum()) { i++; break; }
        const bx = rel ? x : 0, by = rel ? y : 0;
        const p1 = { x: bx + n(), y: by + n() }, p2 = { x: bx + n(), y: by + n() }, p3 = { x: bx + n(), y: by + n() };
        cur.push(...flattenCubic({ x, y }, p1, p2, p3, tol));
        x = p3.x; y = p3.y; lastCtrl = p2;
        break;
      }
      case "S": {
        if (!isNum()) { i++; break; }
        const bx = rel ? x : 0, by = rel ? y : 0;
        const p1: Pt = lastCtrl && /[CS]/i.test(lastCmd) ? { x: 2 * x - lastCtrl.x, y: 2 * y - lastCtrl.y } : { x, y };
        const p2 = { x: bx + n(), y: by + n() }, p3 = { x: bx + n(), y: by + n() };
        cur.push(...flattenCubic({ x, y }, p1, p2, p3, tol));
        x = p3.x; y = p3.y; lastCtrl = p2;
        break;
      }
      case "Q": {
        if (!isNum()) { i++; break; }
        const bx = rel ? x : 0, by = rel ? y : 0;
        const p1 = { x: bx + n(), y: by + n() }, p2 = { x: bx + n(), y: by + n() };
        cur.push(...flattenQuad({ x, y }, p1, p2, tol));
        x = p2.x; y = p2.y; lastCtrl = p1;
        break;
      }
      case "T": {
        if (!isNum()) { i++; break; }
        const bx = rel ? x : 0, by = rel ? y : 0;
        const p1: Pt = lastCtrl && /[QT]/i.test(lastCmd) ? { x: 2 * x - lastCtrl.x, y: 2 * y - lastCtrl.y } : { x, y };
        const p2 = { x: bx + n(), y: by + n() };
        cur.push(...flattenQuad({ x, y }, p1, p2, tol));
        x = p2.x; y = p2.y; lastCtrl = p1;
        break;
      }
      case "A": {
        if (!isNum()) { i++; break; }
        const rx = Math.abs(n()), ry = Math.abs(n()), rot = n();
        const large = flag(), sweep = flag();
        const ex = (rel ? x : 0) + n(), ey = (rel ? y : 0) + n();
        cur.push(...arcToPoints(x, y, rx, ry, rot, large, sweep, ex, ey, tol));
        x = ex; y = ey; lastCtrl = null;
        break;
      }
      case "Z":
        if (cur.length) {
          flush(true);
          x = sx; y = sy;
          cur = [{ x, y }];
        }
        lastCtrl = null;
        cmd = "";
        break;
      default:
        i++;
    }
    lastCmd = C;
  }
  flush(false);
  // Pfade, die nur aus dem Startpunkt nach "Z" bestehen, wurden oben schon verworfen
  return out;
}

function tokenize(d: string): (number | string)[] {
  const tokens: (number | string)[] = [];
  const re = /([MmZzLlHhVvCcSsQqTtAa])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  let lastCmd = "";
  let argIndex = 0;
  while ((m = re.exec(d)) !== null) {
    if (m[1]) { tokens.push(m[1]); lastCmd = m[1].toUpperCase(); argIndex = 0; continue; }
    let s = m[2];
    // Bogen-Flags (4. und 5. Argument) können zusammengeschrieben sein: "a10 10 0 0110 20"
    if (lastCmd === "A") {
      const pos = argIndex % 7;
      if ((pos === 3 || pos === 4) && /^[01]/.test(s) && s.length > 1 && !s.includes(".")) {
        tokens.push(parseInt(s[0], 10)); argIndex++;
        re.lastIndex = m.index + 1; // Rest erneut lesen
        continue;
      }
    }
    tokens.push(parseFloat(s));
    argIndex++;
  }
  return tokens;
}

/** SVG-Ellipsenbogen (Endpunkt-Schreibweise) in Punkte umrechnen (ohne Startpunkt) */
function arcToPoints(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: number, sweep: number, x2: number, y2: number, tol: number): Pt[] {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [{ x: x2, y: y2 }];
  const phi = (rotDeg * Math.PI) / 180;
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  // Radien vergrößern, falls zu klein
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2;
  const cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= Math.PI * 2;
  if (sweep && dt < 0) dt += Math.PI * 2;
  const n = arcSegments(Math.max(rx, ry), dt, tol);
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = t1 + (dt * i) / n;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    out.push({ x: cp * ex - sp * ey + cx, y: sp * ex + cp * ey + cy });
  }
  out[out.length - 1] = { x: x2, y: y2 };
  return out;
}
