/**
 * DXF-IMPORT (AutoCAD, Fusion 360, FreeCAD, LibreCAD, QCAD, SolidWorks, Inkscape ...)
 *
 * Unterstützt (2D, ASCII-DXF):
 *   LINE, ARC, CIRCLE, ELLIPSE, LWPOLYLINE (mit Bögen/"Bulge"), POLYLINE/VERTEX,
 *   SPLINE (NURBS, auch über Stützpunkte), INSERT (Blöcke, auch verschachtelt,
 *   mit Skalierung/Drehung/Reihen), TEXT/MTEXT (werden in Konturen umgewandelt),
 *   SOLID/TRACE (Umriss), POINT wird ignoriert.
 * Einheiten aus $INSUNITS (mm, cm, m, Zoll, Fuß). Ohne Angabe: mm.
 * Einzelne Linien/Bögen werden danach automatisch zu geschlossenen Konturen verbunden.
 */
import {
  ImportResult, emptyResult, Mat, matMul, matApply, matTranslate, matScale, matRotate,
  matScaleFactor, matIsUniform, arcPoints, ellipsePoints, bulgePoints, CURVE_TOL, Pt
} from "./common";
import { t } from "../i18n/i18n";

type Pair = [number, string];

interface Entity {
  type: string;
  pairs: Pair[];
}

const UNITS_TO_MM: Record<number, [number, string]> = {
  0: [1, "dxf.unit.none"], 1: [25.4, "dxf.unit.inch"], 2: [304.8, "dxf.unit.feet"], 4: [1, "mm"],
  5: [10, "cm"], 6: [1000, "m"], 8: [0.0000254, "µin"], 9: [0.0254, "mil"], 10: [914.4, "yd"],
  13: [0.001, "µm"], 14: [100, "dm"]
};

function readPairs(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) { i--; continue; } // verrutschte Zeile -> eine Zeile weiter versuchen
    pairs.push([code, lines[i + 1]]);
  }
  return pairs;
}

export function parseDxf(text: string): ImportResult {
  if (text.startsWith("AutoCAD Binary DXF")) throw new Error(t("dxf.errBinary"));
  const pairs = readPairs(text);
  const res = emptyResult();

  // ---- Abschnitte zerlegen ----
  let units = 0;
  const blocks = new Map<string, { base: Pt; entities: Entity[] }>();
  const entities: Entity[] = [];

  let section = "";
  let i = 0;
  let currentBlock: { name: string; base: Pt; entities: Entity[] } | null = null;

  while (i < pairs.length) {
    const [code, raw] = pairs[i];
    const val = raw.trim();
    if (code === 0 && val === "SECTION") {
      section = (pairs[i + 1]?.[1] || "").trim();
      i += 2;
      continue;
    }
    if (code === 0 && val === "ENDSEC") { section = ""; i++; continue; }

    if (section === "HEADER") {
      if (code === 9 && val === "$INSUNITS") {
        const next = pairs[i + 1];
        if (next && next[0] === 70) units = parseInt(next[1], 10) || 0;
      }
      i++;
      continue;
    }

    if ((section === "ENTITIES" || section === "BLOCKS") && code === 0) {
      if (val === "BLOCK") {
        const blk = readEntity(pairs, i);
        const name = getStr(blk.pairs, 2) ?? "";
        currentBlock = { name, base: { x: getNum(blk.pairs, 10), y: getNum(blk.pairs, 20) }, entities: [] };
        i = blk.next;
        continue;
      }
      if (val === "ENDBLK") {
        if (currentBlock) blocks.set(currentBlock.name, { base: currentBlock.base, entities: currentBlock.entities });
        currentBlock = null;
        i = readEntity(pairs, i).next;
        continue;
      }
      const ent = readEntity(pairs, i);
      i = ent.next;
      const e: Entity = { type: val, pairs: ent.pairs };
      // POLYLINE: die folgenden VERTEX-Einträge bis SEQEND einsammeln
      if (val === "POLYLINE") {
        const verts: Entity[] = [];
        while (i < pairs.length) {
          const v = pairs[i][1].trim();
          if (pairs[i][0] !== 0) { i++; continue; }
          if (v === "VERTEX") { const ve = readEntity(pairs, i); verts.push({ type: "VERTEX", pairs: ve.pairs }); i = ve.next; continue; }
          if (v === "SEQEND") { i = readEntity(pairs, i).next; }
          break;
        }
        (e as any).vertices = verts;
      }
      if (section === "BLOCKS" && currentBlock) currentBlock.entities.push(e);
      else if (section === "ENTITIES") entities.push(e);
      continue;
    }
    i++;
  }

  const [toMm, unitKey] = UNITS_TO_MM[units] || [1, "dxf.unit.none"];
  const unitName = unitKey.startsWith("dxf.") ? t(unitKey) : unitKey;
  const counts: Record<string, number> = {};
  const skipped: Record<string, number> = {};

  const emit = (list: Entity[], m: Mat, depth: number) => {
    if (depth > 20) return;
    for (const e of list) {
      counts[e.type] = (counts[e.type] || 0) + 1;
      if (!handleEntity(e, m, depth)) skipped[e.type] = (skipped[e.type] || 0) + 1;
    }
  };

  const addPath = (pts: Pt[], closed: boolean, m: Mat) => {
    if (pts.length < 2) return;
    res.paths.push({ pts: pts.map(p => matApply(m, p.x, p.y)), closed });
  };

  const handleEntity = (e: Entity, m0: Mat, depth: number): boolean => {
    const p = e.pairs;
    // Objekt-Koordinatensystem: Extrusion Z = -1 bedeutet gespiegelt (häufig bei Kreisen/Bögen)
    const flipped = getNum(p, 230, 1) < 0;
    const m = flipped ? matMul(m0, matScale(-1, 1)) : m0;
    const tol = CURVE_TOL / (matScaleFactor(m) || 1);

    switch (e.type) {
      case "LINE":
        addPath([{ x: getNum(p, 10), y: getNum(p, 20) }, { x: getNum(p, 11), y: getNum(p, 21) }], false, m);
        return true;
      case "CIRCLE": {
        const cx = getNum(p, 10), cy = getNum(p, 20), r = getNum(p, 40);
        if (r <= 0) return true;
        if (matIsUniform(m)) {
          const c = matApply(m, cx, cy);
          res.circles.push({ cx: c.x, cy: c.y, r: r * matScaleFactor(m) });
        } else {
          const pts = arcPoints(cx, cy, r, 0, Math.PI * 2, tol); pts.pop();
          addPath(pts, true, m);
        }
        return true;
      }
      case "ARC": {
        const cx = getNum(p, 10), cy = getNum(p, 20), r = getNum(p, 40);
        const a0 = (getNum(p, 50) * Math.PI) / 180;
        let a1 = (getNum(p, 51) * Math.PI) / 180;
        while (a1 <= a0) a1 += Math.PI * 2;
        addPath(arcPoints(cx, cy, r, a0, a1 - a0, tol), false, m);
        return true;
      }
      case "ELLIPSE": {
        const cx = getNum(p, 10), cy = getNum(p, 20);
        const mx = getNum(p, 11), my = getNum(p, 21), ratio = getNum(p, 40, 1);
        const t0 = getNum(p, 41, 0);
        let t1 = getNum(p, 42, Math.PI * 2);
        while (t1 <= t0) t1 += Math.PI * 2;
        const full = Math.abs(t1 - t0 - Math.PI * 2) < 1e-6;
        const pts = ellipsePoints(cx, cy, mx, my, ratio, t0, t1, tol);
        if (full) pts.pop();
        addPath(pts, full, m);
        return true;
      }
      case "LWPOLYLINE": {
        const closed = (getNum(p, 70) & 1) === 1;
        const verts: { x: number; y: number; b: number }[] = [];
        for (const [c, v] of p) {
          if (c === 10) verts.push({ x: parseFloat(v), y: 0, b: 0 });
          else if (c === 20 && verts.length) verts[verts.length - 1].y = parseFloat(v);
          else if (c === 42 && verts.length) verts[verts.length - 1].b = parseFloat(v);
        }
        addPath(polyWithBulges(verts, closed, tol), closed, m);
        return true;
      }
      case "POLYLINE": {
        const flags = getNum(p, 70);
        if (flags & (16 | 64)) return false; // 3D-Netze
        const closed = (flags & 1) === 1;
        const verts = ((e as any).vertices as Entity[] || [])
          .filter(v => !(getNum(v.pairs, 70) & 16)) // Spline-Stützpunkte überspringen
          .map(v => ({ x: getNum(v.pairs, 10), y: getNum(v.pairs, 20), b: getNum(v.pairs, 42) }));
        addPath(polyWithBulges(verts, closed, tol), closed, m);
        return true;
      }
      case "SPLINE": {
        const pts = splinePoints(p, tol);
        if (!pts) return false;
        const closed = (getNum(p, 70) & 1) === 1 || (pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-9);
        if (closed && pts.length > 2) pts.pop();
        addPath(pts, closed, m);
        return true;
      }
      case "SOLID":
      case "TRACE":
      case "3DFACE": {
        const c = [[10, 20], [11, 21], [13, 23], [12, 22]].map(([a, b]) => ({ x: getNum(p, a), y: getNum(p, b) }));
        // SOLID: Punkte 3 und 4 sind vertauscht (Ecken-Reihenfolge 1-2-4-3)
        const pts = e.type === "3DFACE" ? [c[0], c[1], c[3], c[2]] : c;
        addPath(pts, true, m);
        return true;
      }
      case "INSERT": {
        const blk = blocks.get(getStr(p, 2) ?? "");
        if (!blk) return false;
        const ix = getNum(p, 10), iy = getNum(p, 20);
        const sx = getNum(p, 41, 1), sy = getNum(p, 42, 1);
        const rot = (getNum(p, 50) * Math.PI) / 180;
        const cols = Math.max(1, getNum(p, 70, 1)), rows = Math.max(1, getNum(p, 71, 1));
        const dc = getNum(p, 44), dr = getNum(p, 45);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            // Reihen/Spalten liegen im gedrehten Koordinatensystem
            const off = matApply(matRotate(rot), c * dc, r * dr);
            const bm = matMul(m, matMul(matTranslate(ix + off.x, iy + off.y), matMul(matRotate(rot), matMul(matScale(sx, sy), matTranslate(-blk.base.x, -blk.base.y)))));
            emit(blk.entities, bm, depth + 1);
          }
        }
        return true;
      }
      case "TEXT":
      case "MTEXT":
      case "ATTRIB": {
        let txt = e.type === "MTEXT" ? mtextPlain(p) : (getStr(p, 1) ?? "");
        txt = txt.replace(/%%[cC]/g, "Ø").replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±").replace(/%%%/g, "%");
        if (!txt.trim()) return true;
        const h = getNum(p, 40, 2.5);
        let rot = getNum(p, 50);
        if (e.type === "MTEXT" && hasCode(p, 11)) rot = (Math.atan2(getNum(p, 21), getNum(p, 11)) * 180) / Math.PI;
        // Einfügepunkt: bei ausgerichtetem TEXT steht er in 11/21
        const aligned = e.type === "TEXT" && (getNum(p, 72) !== 0 || getNum(p, 73) !== 0) && hasCode(p, 11);
        const x = aligned ? getNum(p, 11) : getNum(p, 10), y = aligned ? getNum(p, 21) : getNum(p, 20);
        const pos = matApply(m, x, y);
        const s = matScaleFactor(m);
        const mrot = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
        // MTEXT-Einfügepunkt ist meist oben links -> grob nach unten verschieben
        const topLeft = e.type === "MTEXT" && [1, 2, 3, 0].includes(getNum(p, 71, 1));
        res.texts.push({ text: txt, x: pos.x, y: topLeft ? pos.y - h * s : pos.y, height: h * s, rotation: rot + mrot });
        return true;
      }
      case "POINT":
      case "DIMENSION":
      case "HATCH":
      case "VIEWPORT":
      case "ATTDEF":
      case "LEADER":
      case "MLEADER":
      case "IMAGE":
      case "WIPEOUT":
        return false;
      default:
        return false;
    }
  };

  emit(entities, matScale(toMm, toMm), 0);

  const skippedList = Object.entries(skipped).map(([k, v]) => `${v}× ${k}`).join(", ");
  if (skippedList) res.warnings.push(t("dxf.skipped", { list: skippedList }));
  if (units === 0) res.warnings.push(t("dxf.noUnits"));
  res.info = `DXF (${unitName}): ` + Object.entries(counts).filter(([k]) => !skipped[k]).map(([k, v]) => `${v}× ${k}`).join(", ");
  return res;
}

// ---------------------------------------------------------------------

function readEntity(pairs: Pair[], start: number): { pairs: Pair[]; next: number } {
  const out: Pair[] = [];
  let i = start + 1;
  while (i < pairs.length && pairs[i][0] !== 0) { out.push(pairs[i]); i++; }
  return { pairs: out, next: i };
}

function getNum(p: Pair[], code: number, def = 0): number {
  for (const [c, v] of p) if (c === code) { const n = parseFloat(v); return Number.isFinite(n) ? n : def; }
  return def;
}
function getStr(p: Pair[], code: number): string | undefined {
  for (const [c, v] of p) if (c === code) return v.trim();
  return undefined;
}
function hasCode(p: Pair[], code: number): boolean {
  return p.some(([c]) => c === code);
}
function getAll(p: Pair[], code: number): number[] {
  return p.filter(([c]) => c === code).map(([, v]) => parseFloat(v));
}

function polyWithBulges(verts: { x: number; y: number; b: number }[], closed: boolean, tol: number): Pt[] {
  if (!verts.length) return [];
  const out: Pt[] = [{ x: verts[0].x, y: verts[0].y }];
  const n = verts.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = verts[i], b = verts[(i + 1) % n];
    out.push(...bulgePoints(a, b, a.b, tol));
  }
  if (closed && out.length > 1) out.pop(); // letzter Punkt = erster Punkt
  return out;
}

/** MTEXT: Formatierungs-Codes entfernen, \P = neue Zeile */
function mtextPlain(p: Pair[]): string {
  let s = p.filter(([c]) => c === 3).map(([, v]) => v).join("") + (getStr(p, 1) ?? "");
  // 1 enthält den letzten Teil, 3 die vorherigen Stücke (Reihenfolge laut DXF-Referenz)
  s = s.replace(/\\P/g, "\n")
    .replace(/\\[ACcFfHhQqTtWw][^;]*;/g, "")
    .replace(/\\[LlOoKk]/g, "")
    .replace(/\\S([^;]*);/g, (_m, g) => String(g).replace(/[#^/]/g, "/"))
    .replace(/\\~/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\\\\/g, "\\");
  return s;
}

/**
 * NURBS-Kurve auswerten (de Boor). Wenn keine Kontrollpunkte vorhanden sind,
 * werden die Stützpunkte (Fit Points) einfach verbunden.
 */
function splinePoints(p: Pair[], tol: number): Pt[] | null {
  const degree = getNum(p, 71, 3);
  const knots = getAll(p, 40);
  const xs = getAll(p, 10), ys = getAll(p, 20);
  const weights = getAll(p, 41);
  if (xs.length < 2 || knots.length < xs.length + degree + 1) {
    const fx = getAll(p, 11), fy = getAll(p, 21);
    if (fx.length >= 2) return catmullRom(fx.map((x, i) => ({ x, y: fy[i] ?? 0 })), tol);
    return null;
  }
  const ctrl = xs.map((x, i) => ({ x, y: ys[i] ?? 0, w: weights.length === xs.length ? weights[i] : 1 }));
  const k0 = knots[degree], k1 = knots[knots.length - degree - 1];
  // Anzahl Auswertungen: nach Länge des Kontrollpolygons
  let len = 0;
  for (let i = 1; i < ctrl.length; i++) len += Math.hypot(ctrl[i].x - ctrl[i - 1].x, ctrl[i].y - ctrl[i - 1].y);
  const n = Math.min(4000, Math.max(ctrl.length * 8, Math.ceil(len / Math.max(tol * 20, 0.05))));
  const out: Pt[] = [];
  for (let s = 0; s <= n; s++) {
    const t = k0 + ((k1 - k0) * s) / n;
    out.push(deBoor(t, degree, knots, ctrl));
  }
  return out;
}

function deBoor(t: number, p: number, knots: number[], ctrl: { x: number; y: number; w: number }[]): Pt {
  // Knoten-Intervall finden
  let k = p;
  const last = knots.length - p - 2;
  while (k < last && t >= knots[k + 1]) k++;
  const d = [];
  for (let j = 0; j <= p; j++) {
    const c = ctrl[Math.min(ctrl.length - 1, Math.max(0, j + k - p))];
    d.push({ x: c.x * c.w, y: c.y * c.w, w: c.w });
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p;
      const den = knots[i + p - r + 1] - knots[i];
      const a = den === 0 ? 0 : (t - knots[i]) / den;
      d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y, w: (1 - a) * d[j - 1].w + a * d[j].w };
    }
  }
  const r = d[p];
  return { x: r.x / (r.w || 1), y: r.y / (r.w || 1) };
}

/** Glatte Kurve durch Stützpunkte (für Splines ohne Kontrollpunkte) */
function catmullRom(pts: Pt[], tol: number): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const n = Math.max(2, Math.min(100, Math.ceil(segLen / Math.max(tol * 20, 0.05))));
    for (let s = 1; s <= n; s++) {
      const t = s / n, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
      });
    }
  }
  return out;
}

