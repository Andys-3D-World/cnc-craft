/**
 * SVG-PFADE OHNE DOM: transform-Angaben und Pfad-Daten ("d") in Linienzüge (aus svgImport.ts herausgelöst, damit Tests und
 * der Zwilling in Rust – src-tauri/src/importsvg.rs – sie ohne Browser nutzen können).
 */
import { IDENTITY, matMul, matTranslate, matScale, matRotate, flattenCubic, flattenQuad, arcSegments, type Mat, type Pt } from "./common.ts";

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
