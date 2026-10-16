/**
 * HPGL/PLT-IMPORT (Schneideplotter, CorelDRAW-, Inkscape-, SignCut-Export)
 * und G-CODE-IMPORT (vorhandene .nc/.gcode-Dateien als Konturen anzeigen/weiterbearbeiten).
 */
import { ImportResult, emptyResult, arcPoints, CURVE_TOL, Pt } from "./common";
import { t } from "../i18n/i18n";

// =====================================================================
// HPGL
// =====================================================================

const HPGL_UNIT = 0.025; // 1 Plotter-Einheit = 0,025 mm (40 pro mm)

export function parseHpgl(text: string): ImportResult {
  const res = emptyResult();
  let x = 0, y = 0;
  let penDown = false;
  let absolute = true;
  let cur: Pt[] = [];
  let count = 0;

  const flush = () => {
    if (cur.length >= 2) res.paths.push({ pts: cur, closed: false });
    cur = [];
  };
  const moveTo = (nx: number, ny: number) => {
    if (penDown) {
      if (!cur.length) cur.push({ x: x * HPGL_UNIT, y: y * HPGL_UNIT });
      cur.push({ x: nx * HPGL_UNIT, y: ny * HPGL_UNIT });
    }
    x = nx; y = ny;
  };

  // Befehle: zwei Buchstaben + Parameter, getrennt durch ";" oder direkt hintereinander
  const re = /([A-Z]{2})([^A-Z;\x03]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cmd = m[1].toUpperCase();
    const args = m[2].split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
    count++;
    switch (cmd) {
      case "IN": case "DF": flush(); penDown = false; absolute = true; x = y = 0; break;
      case "PA": absolute = true; applyMoves(args); break;
      case "PR": absolute = false; applyMoves(args); break;
      case "PU": flush(); penDown = false; applyMoves(args); break;
      case "PD":
        if (!penDown) { cur = [{ x: x * HPGL_UNIT, y: y * HPGL_UNIT }]; }
        penDown = true; applyMoves(args); break;
      case "CI": {
        const r = args[0];
        if (r > 0) res.circles.push({ cx: x * HPGL_UNIT, cy: y * HPGL_UNIT, r: r * HPGL_UNIT });
        break;
      }
      case "AA": case "AR": {
        // Bogen: Mittelpunkt (absolut/relativ), Winkel in Grad
        if (args.length < 3) break;
        const cx = cmd === "AA" ? args[0] : x + args[0];
        const cy = cmd === "AA" ? args[1] : y + args[1];
        const sweep = (args[2] * Math.PI) / 180;
        const r = Math.hypot(x - cx, y - cy);
        const a0 = Math.atan2(y - cy, x - cx);
        const pts = arcPoints(cx * HPGL_UNIT, cy * HPGL_UNIT, r * HPGL_UNIT, a0, sweep, CURVE_TOL);
        if (penDown) {
          if (!cur.length) cur.push(pts[0]);
          cur.push(...pts.slice(1));
        }
        x = cx + r * Math.cos(a0 + sweep);
        y = cy + r * Math.sin(a0 + sweep);
        break;
      }
      default:
        break;
    }
  }
  flush();

  function applyMoves(args: number[]) {
    for (let i = 0; i + 1 < args.length; i += 2) {
      const nx = absolute ? args[i] : x + args[i];
      const ny = absolute ? args[i + 1] : y + args[i + 1];
      moveTo(nx, ny);
    }
  }

  res.info = t("hpgl.info", { paths: res.paths.length, circles: res.circles.length, n: count });
  return res;
}

// =====================================================================
// G-CODE
// =====================================================================

export function parseGcode(text: string): ImportResult {
  const res = emptyResult();
  let x = 0, y = 0;
  let absolute = true;
  let inch = false;
  let motion = 0; // 0 = Eilgang, 1 = Gerade, 2/3 = Bogen
  let cur: Pt[] = [];
  let lines = 0;

  const flush = () => {
    if (cur.length >= 2) res.paths.push({ pts: cur, closed: false });
    cur = [];
  };

  for (let raw of text.split(/\r?\n/)) {
    lines++;
    raw = raw.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").trim().toUpperCase();
    if (!raw) continue;
    const words: Record<string, number> = {};
    const gs: number[] = [];
    const re = /([A-Z])\s*([-+]?\d*\.?\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const v = parseFloat(m[2]);
      if (m[1] === "G") gs.push(v); else words[m[1]] = v;
    }
    for (const g of gs) {
      if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
      else if (g === 90) absolute = true;
      else if (g === 91) absolute = false;
      else if (g === 20) inch = true;
      else if (g === 21) inch = false;
    }
    if (words.X === undefined && words.Y === undefined) continue;
    const f = inch ? 25.4 : 1;
    const nx = words.X === undefined ? x : (absolute ? words.X * f : x + words.X * f);
    const ny = words.Y === undefined ? y : (absolute ? words.Y * f : y + words.Y * f);

    if (motion === 0) {
      flush();
    } else {
      if (!cur.length) cur.push({ x, y });
      if (motion === 1) {
        cur.push({ x: nx, y: ny });
      } else {
        let cx: number, cy: number;
        if (words.R !== undefined) {
          // Radius-Schreibweise
          const r = words.R * f;
          const dx = nx - x, dy = ny - y, d = Math.hypot(dx, dy);
          const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
          const sgn = (motion === 2) === (r > 0) ? -1 : 1;
          cx = x + dx / 2 + (sgn * h * -dy) / d;
          cy = y + dy / 2 + (sgn * h * dx) / d;
        } else {
          cx = x + (words.I || 0) * f;
          cy = y + (words.J || 0) * f;
        }
        const r = Math.hypot(x - cx, y - cy);
        const a0 = Math.atan2(y - cy, x - cx);
        let a1 = Math.atan2(ny - cy, nx - cx);
        let sweep = a1 - a0;
        if (motion === 2) { while (sweep >= -1e-9) sweep -= Math.PI * 2; }
        else { while (sweep <= 1e-9) sweep += Math.PI * 2; }
        const pts = arcPoints(cx, cy, r, a0, sweep, CURVE_TOL);
        pts[pts.length - 1] = { x: nx, y: ny };
        cur.push(...pts.slice(1));
      }
    }
    x = nx; y = ny;
  }
  flush();
  res.info = t("gcodeImp.info", { n: res.paths.length, lines });
  if (res.paths.length) res.warnings.push(t("gcodeImp.warn"));
  return res;
}
