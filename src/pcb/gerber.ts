/**
 * GERBER LESEN (RS-274X, Grundlage: Ucamco „Gerber Layer Format Specification“) – reine Rechnung, Tests in tests/pcb.test.ts
 *
 * Ergebnis: eine Liste von Flächen in mm, in Zeichen-Reihenfolge, jede „dunkel“ (Kupfer) oder „hell“ (löscht):
 *   stroke  Strich mit rundem Pinsel   poly  Vieleck (Region, gezogenes Rechteck)
 *   flash   Blitz einer Blende aus Teilen (an/aus – Makros und Blenden mit Loch)
 * lines = Mittellinien aller Striche (für die Platinenkontur).
 * Was nicht verstanden wird, kommt als Hinweis zurück – nie still weglassen.
 */

export type Pt2 = [number, number];
export type FlashPart = { on: boolean; c: [number, number, number] } | { on: boolean; p: Pt2[] };
export type GObj =
  | { k: "stroke"; dark: boolean; a: Pt2; b: Pt2; r: number }
  | { k: "poly"; dark: boolean; p: Pt2[] }
  | { k: "flash"; dark: boolean; parts: FlashPart[] };

export interface GerberFile {
  objs: GObj[];
  lines: Pt2[][];            // zusammenhängende Mittellinien (Bögen aufgelöst)
  func: string;              // %TF.FileFunction (z. B. "Copper,L1,Top"), sonst ""
  warnings: string[];        // Kennungen: "aperture", "macro", "block", "syntax", "units", "negative"
}

/** Grenze gegen riesige/kaputte Dateien */
const MAX_OBJS = 400_000;
const ARC_TOL = 0.004;

type Shape = { on: boolean; c: [number, number, number] } | { on: boolean; p: Pt2[] };
interface Aperture { round: number | null; parts: Shape[] } // round = Radius, wenn einfacher Kreis

const rot = (p: Pt2, deg: number): Pt2 => {
  if (!deg) return p;
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
};
const rectPts = (w: number, h: number): Pt2[] => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
/** Langloch (Obround) als Vieleck */
function obround(w: number, h: number): Pt2[] {
  const r = Math.min(w, h) / 2, n = arcSteps(r, Math.PI), out: Pt2[] = [], dx = w / 2 - r, dy = h / 2 - r;
  if (w >= h) {
    for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + Math.PI * i / n; out.push([dx + r * Math.cos(a), r * Math.sin(a)]); }
    for (let i = 0; i <= n; i++) { const a = Math.PI / 2 + Math.PI * i / n; out.push([-dx + r * Math.cos(a), r * Math.sin(a)]); }
  } else {
    for (let i = 0; i <= n; i++) { const a = Math.PI * i / n; out.push([r * Math.cos(a), dy + r * Math.sin(a)]); }
    for (let i = 0; i <= n; i++) { const a = Math.PI + Math.PI * i / n; out.push([r * Math.cos(a), -dy + r * Math.sin(a)]); }
  }
  return out;
}
/** so viele Stücke, dass die Sehne höchstens ARC_TOL abweicht */
export function arcSteps(r: number, sweep: number): number {
  if (!(r > 0)) return 1;
  const st = 2 * Math.acos(Math.max(0, 1 - Math.min(1, ARC_TOL / r)));
  return Math.max(2, Math.min(720, Math.ceil(Math.abs(sweep) / Math.max(1e-3, st))));
}
const ngon = (d: number, n: number, deg: number): Pt2[] => Array.from({ length: n }, (_, i) => rot([d / 2, 0], deg + 360 * i / n));
const circlePts = (x: number, y: number, r: number): Pt2[] => { const n = Math.max(12, arcSteps(r, 2 * Math.PI)); return Array.from({ length: n }, (_, i) => [x + r * Math.cos(2 * Math.PI * i / n), y + r * Math.sin(2 * Math.PI * i / n)] as Pt2); };

/** Rechenausdruck im Makro: Zahlen, $n, + - x /, Klammern */
export function macroExpr(s: string, vars: Record<string, number>): number {
  let i = 0;
  const src = s.replace(/\s+/g, "");
  const prim = (): number => {
    if (src[i] === "(") { i++; const v = sum(); if (src[i] === ")") i++; return v; }
    if (src[i] === "-") { i++; return -prim(); }
    if (src[i] === "+") { i++; return prim(); }
    if (src[i] === "$") { const m = /^\$(\d+)/.exec(src.slice(i)); if (!m) throw new Error("macro"); i += m[0].length; return vars[m[1]] ?? 0; }
    const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (!m) throw new Error("macro");
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const prod = (): number => { let v = prim(); while (src[i] === "x" || src[i] === "X" || src[i] === "/") { const op = src[i++]; const w = prim(); v = op === "/" ? (w ? v / w : 0) : v * w; } return v; };
  const sum = (): number => { let v = prod(); while (src[i] === "+" || src[i] === "-") { const op = src[i++]; const w = prod(); v = op === "+" ? v + w : v - w; } return v; };
  const v = sum();
  if (i < src.length) throw new Error("macro");
  return v;
}

/** Makro mit Werten zu Teilen (in Datei-Einheiten) */
function runMacro(body: string[], args: number[], warn: (w: string) => void): Shape[] {
  const vars: Record<string, number> = {};
  args.forEach((v, i) => { vars[String(i + 1)] = v; });
  const out: Shape[] = [];
  for (const raw of body) {
    const line = raw.trim();
    if (!line || /^0(\s|$)/.test(line)) continue;
    const eq = /^\$(\d+)=(.+)$/.exec(line.replace(/\s+/g, ""));
    if (eq) { vars[eq[1]] = macroExpr(eq[2], vars); continue; }
    const f = line.split(",").map(x => macroExpr(x, vars));
    const code = Math.round(f[0]), on = (f[1] ?? 1) !== 0;
    const R = (pts: Pt2[], deg = 0) => pts.map(p => rot(p, deg));
    if (code === 1) { const [x, y] = rot([f[3] || 0, f[4] || 0], f[5] || 0); out.push({ on, c: [x, y, (f[2] || 0) / 2] }); }
    else if (code === 20 || code === 2) {
      const [w, x0, y0, x1, y1, deg] = f.slice(2), l = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / l * w / 2, ny = (x1 - x0) / l * w / 2;
      out.push({ on, p: R([[x0 + nx, y0 + ny], [x0 - nx, y0 - ny], [x1 - nx, y1 - ny], [x1 + nx, y1 + ny]], deg || 0) });
    } else if (code === 21) { const [w, h, x, y, deg] = f.slice(2); out.push({ on, p: R(rectPts(w, h).map(q => [q[0] + x, q[1] + y] as Pt2), deg || 0) }); }
    else if (code === 22) { const [w, h, x, y, deg] = f.slice(2); out.push({ on, p: R([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], deg || 0) }); }
    else if (code === 4) {
      const n = Math.max(0, Math.round(f[2])), pts: Pt2[] = [];
      for (let k = 0; k < n; k++) pts.push([f[3 + 2 * k] || 0, f[4 + 2 * k] || 0]);
      out.push({ on, p: R(pts, f[3 + 2 * (n + 1)] || 0) });
    } else if (code === 5) { const [n, x, y, d, deg] = f.slice(2); out.push({ on, p: R(ngon(d, Math.max(3, Math.min(12, Math.round(n))), 0).map(q => [q[0] + x, q[1] + y] as Pt2), deg || 0) }); }
    else if (code === 7) {
      const [x, y, od, id, gap, deg] = f.slice(1);
      out.push({ on: true, c: [...rot([x, y], deg || 0), od / 2] as [number, number, number] }, { on: false, c: [...rot([x, y], deg || 0), id / 2] as [number, number, number] });
      for (const [w, h] of [[gap, od * 1.1], [od * 1.1, gap]]) out.push({ on: false, p: R(rectPts(w, h).map(q => [q[0] + x, q[1] + y] as Pt2), deg || 0) });
    } else if (code === 6) {
      const [x, y, od, th, gap, n, ct, cl, deg] = f.slice(1);
      let d = od;
      for (let k = 0; k < Math.min(20, Math.round(n)) && d > 0; k++, d -= 2 * (th + gap)) { out.push({ on: true, c: [x, y, d / 2] }); if (d - 2 * th > 0) out.push({ on: false, c: [x, y, d / 2 - th] }); }
      for (const [w, h] of [[ct, cl], [cl, ct]]) out.push({ on: true, p: R(rectPts(w, h).map(q => [q[0] + x, q[1] + y] as Pt2), deg || 0) });
    } else warn("macro");
  }
  return out;
}

const hull = (pts: Pt2[]): Pt2[] => {
  const s = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (list: Pt2[]) => { const h: Pt2[] = []; for (const p of list) { while (h.length > 1 && (h[h.length - 1][0] - h[h.length - 2][0]) * (p[1] - h[h.length - 2][1]) - (h[h.length - 1][1] - h[h.length - 2][1]) * (p[0] - h[h.length - 2][0]) <= 0) h.pop(); h.push(p); } h.pop(); return h; };
  return [...half(s), ...half(s.reverse())];
};

/** Sieht der Text wie Gerber aus? */
export const looksLikeGerber = (t: string) => /%FS[LTD]?[AI]X\d\d/.test(t.slice(0, 20000)) || /%MO(MM|IN)\*%/.test(t.slice(0, 20000)) || (/%ADD\d+/.test(t.slice(0, 20000)) && /D0?[123]\*/.test(t));

export function parseGerber(text: string): GerberFile {
  const warnings = new Set<string>();
  const warn = (w: string) => { warnings.add(w); };
  let objs: GObj[] = [];
  const lines: Pt2[][] = [];
  let func = "";
  let unit = 0, intX = 2, decX = 4, intY = 2, decY = 4, trailing = false;
  const ap = new Map<number, Aperture>(), macros = new Map<string, string[]>();
  let cur: Aperture | null = null, dark = true, interp = 1, multi = true, region = false, op = 2, incremental = false;
  let x = 0, y = 0; // mm
  let lm = "N", lr = 0, ls = 1;
  let contour: Pt2[] = [];
  let sr: { nx: number; ny: number; dx: number; dy: number; from: number } | null = null;
  const U = () => { if (!unit) { warn("units"); unit = 1; } return unit; };
  const push = (o: GObj) => { objs.push(o); if (objs.length > MAX_OBJS) throw new Error("too-big"); };

  const coord = (s: string, ints: number, dec: number): number => {
    if (s.includes(".")) return parseFloat(s) * U();
    const neg = s.startsWith("-"), d = s.replace(/^[+-]/, "");
    const v = trailing ? parseInt(d.padEnd(ints + dec, "0"), 10) : parseInt(d, 10);
    return (neg ? -1 : 1) * v / 10 ** dec * U();
  };
  const closeSr = () => {
    if (!sr) return;
    const s = sr, block = objs.slice(s.from);
    sr = null;
    for (let j = 0; j < s.ny; j++) for (let i = 0; i < s.nx; i++) { if (!i && !j) continue; for (const o of block) push(shift(o, i * s.dx, j * s.dy)); }
  };
  const endContour = () => { if (contour.length >= 3) push({ k: "poly", dark, p: contour }); contour = []; };
  const place = (s: Shape, px: number, py: number): FlashPart => {
    const tf = (p: Pt2): Pt2 => { let q: Pt2 = [p[0] * ls, p[1] * ls]; if (lm.includes("X")) q = [-q[0], q[1]]; if (lm.includes("Y")) q = [q[0], -q[1]]; q = rot(q, lr); return [q[0] + px, q[1] + py]; };
    if ("c" in s) { const [cx, cy] = tf([s.c[0], s.c[1]]); return { on: s.on, c: [cx, cy, s.c[2] * ls] }; }
    return { on: s.on, p: s.p.map(tf) };
  };
  const flash = () => {
    if (!cur) { warn("aperture"); return; }
    if (cur.parts.length) push({ k: "flash", dark, parts: cur.parts.map(s => place(s, x, y)) });
  };
  const strokeTo = (pts: Pt2[]) => {
    const last = lines[lines.length - 1];
    if (last && Math.hypot(last[last.length - 1][0] - pts[0][0], last[last.length - 1][1] - pts[0][1]) < 1e-9) last.push(...pts.slice(1));
    else lines.push(pts.slice());
    if (!cur) { warn("aperture"); return; }
    if (cur.round !== null) { const r = cur.round * ls; for (let i = 1; i < pts.length; i++) push({ k: "stroke", dark, a: pts[i - 1], b: pts[i], r }); return; }
    // anderer Pinsel: konvexe Hülle aus Anfang und Ende je Stück
    for (let i = 1; i < pts.length; i++) {
      const at = (p: Pt2) => cur!.parts.filter(s => s.on).flatMap(s => { const q = place(s, p[0], p[1]); return "c" in q ? circlePts(...q.c) : q.p; });
      const h = hull([...at(pts[i - 1]), ...at(pts[i])]);
      if (h.length >= 3) push({ k: "poly", dark, p: h });
    }
  };
  const move = (nx: number, ny: number, ox: number, oy: number) => {
    let pts: Pt2[];
    if (interp === 1) pts = [[x, y], [nx, ny]];
    else {
      const cw = interp === 2;
      let cx = x + ox, cy = y + oy;
      if (!multi) {
        // Viertelkreis-Modus: I/J ohne Vorzeichen – die Mitte suchen, die passt
        let best = Infinity;
        for (const sx of [1, -1]) for (const sy of [1, -1]) {
          const tx = x + sx * Math.abs(ox), ty = y + sy * Math.abs(oy);
          const e = Math.abs(Math.hypot(x - tx, y - ty) - Math.hypot(nx - tx, ny - ty)), sw = sweep(x - tx, y - ty, nx - tx, ny - ty, cw);
          if (Math.abs(sw) <= Math.PI / 2 + 0.01 && e < best) { best = e; cx = tx; cy = ty; }
        }
      }
      const r = Math.hypot(x - cx, y - cy);
      let sw = sweep(x - cx, y - cy, nx - cx, ny - cy, cw);
      if (multi && Math.hypot(nx - x, ny - y) < 1e-9) sw = cw ? -2 * Math.PI : 2 * Math.PI;
      const n = arcSteps(r, sw), a0 = Math.atan2(y - cy, x - cx), r1 = Math.hypot(nx - cx, ny - cy);
      pts = [[x, y]];
      for (let k = 1; k < n; k++) { const a = a0 + sw * k / n, rr = r + (r1 - r) * k / n; pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
      pts.push([nx, ny]);
    }
    if (region) { if (!contour.length) contour.push(pts[0]); contour.push(...pts.slice(1)); }
    else strokeTo(pts);
  };

  const ext = (block: string[]) => {
    const head = block[0];
    const fs = /^FS([LTD])?([AI])X(\d)(\d)Y(\d)(\d)/.exec(head);
    if (fs) { trailing = fs[1] === "T"; incremental = fs[2] === "I"; intX = +fs[3]; decX = +fs[4]; intY = +fs[5]; decY = +fs[6]; return; }
    if (/^MOMM/.test(head)) { unit = 1; return; }
    if (/^MOIN/.test(head)) { unit = 25.4; return; }
    if (head.startsWith("AM")) { macros.set(head.slice(2), block.slice(1)); return; }
    const ad = /^ADD(\d+)([A-Za-z_.$][\w.$-]*),?(.*)$/.exec(head);
    if (ad) {
      const u = U(), v = ad[3] ? ad[3].split(/[xX]/).map(parseFloat) : [], code = +ad[1], name = ad[2];
      const hole = (d: number | undefined): Shape[] => (d && d > 0 ? [{ on: false, c: [0, 0, d * u / 2] }] : []);
      let a: Aperture | null = null;
      if (name === "C") a = { round: v[1] > 0 ? null : (v[0] || 0) * u / 2, parts: [{ on: true, c: [0, 0, (v[0] || 0) * u / 2] }, ...hole(v[1])] };
      else if (name === "R") a = { round: null, parts: [{ on: true, p: rectPts(v[0] * u, v[1] * u) }, ...hole(v[2])] };
      else if (name === "O") a = { round: null, parts: [{ on: true, p: obround(v[0] * u, v[1] * u) }, ...hole(v[2])] };
      else if (name === "P") a = { round: null, parts: [{ on: true, p: ngon(v[0] * u, Math.max(3, Math.min(12, Math.round(v[1]))), v[2] || 0) }, ...hole(v[3])] };
      else if (macros.has(name)) {
        try { a = { round: null, parts: runMacro(macros.get(name)!, v, warn).map(s => ("c" in s ? { on: s.on, c: s.c.map(q => q * u) as [number, number, number] } : { on: s.on, p: s.p.map(q => [q[0] * u, q[1] * u] as Pt2) })) }; }
        catch { warn("macro"); }
        // ein einzelner Kreis um die Mitte ist ein runder Pinsel
        if (a && a.parts.length === 1 && "c" in a.parts[0] && a.parts[0].on && Math.hypot(a.parts[0].c[0], a.parts[0].c[1]) < 1e-9) a.round = a.parts[0].c[2];
      } else warn("aperture");
      if (a && a.parts.some(s => ("c" in s ? s.c.some(q => !Number.isFinite(q)) : s.p.some(q => !Number.isFinite(q[0]) || !Number.isFinite(q[1]))))) { warn("aperture"); a = null; }
      if (a) ap.set(code, a); else ap.delete(code);
      return;
    }
    if (/^LP[DC]/.test(head)) { dark = head[2] === "D"; return; }
    if (head.startsWith("LM")) { lm = head.slice(2); return; }
    if (head.startsWith("LR")) { lr = parseFloat(head.slice(2)) || 0; return; }
    if (head.startsWith("LS")) { ls = parseFloat(head.slice(2)) || 1; return; }
    if (head.startsWith("SR")) {
      closeSr();
      const m = /^SRX(\d+)Y(\d+)I([-+\d.]+)J([-+\d.]+)/.exec(head);
      if (m && (+m[1] > 1 || +m[2] > 1) && +m[1] * +m[2] <= 10000) sr = { nx: +m[1], ny: +m[2], dx: parseFloat(m[3]) * U(), dy: parseFloat(m[4]) * U(), from: objs.length };
      return;
    }
    if (head.startsWith("AB")) { warn("block"); return; }
    if (head.startsWith("TF")) { const m = /^TF\.FileFunction,(.+)$/.exec(head); if (m) func = m[1]; return; }
    if (/^IPNEG/.test(head)) { warn("negative"); return; }
    if (/^(TA|TO|TD|IP|LN|IN|OF|MI|SF|AS|IR|IF|KO)/.test(head)) return;
    warn("syntax");
  };

  const cmd = (line: string) => {
    let s = line;
    if (/^G0?4/.test(s)) { const m = /TF\.FileFunction,([^*]+)/.exec(s); if (m && !func) func = m[1].trim(); return false; }
    for (;;) {
      const g = /^G0*(\d+)/.exec(s);
      if (!g) break;
      s = s.slice(g[0].length);
      const n = +g[1];
      if (n === 1 || n === 2 || n === 3) interp = n;
      else if (n === 36) { region = true; contour = []; }
      else if (n === 37) { endContour(); region = false; }
      else if (n === 74) multi = false;
      else if (n === 75) multi = true;
      else if (n === 70) unit = 25.4;
      else if (n === 71) unit = 1;
      else if (n === 90) incremental = false;
      else if (n === 91) incremental = true;
      else if (n !== 54 && n !== 55) warn("syntax");
    }
    if (/^M0*[0-2]/.test(s)) return true;
    const m = /^((?:[XYIJ][-+]?[\d.]+)*)(?:D0*(\d+))?$/.exec(s);
    if (!m) { if (s) warn("syntax"); return false; }
    if (m[2] !== undefined && +m[2] >= 10) { cur = ap.get(+m[2]) ?? null; if (!cur) warn("aperture"); return false; }
    const get = (k: string) => { const q = new RegExp(k + "([-+]?[\\d.]+)").exec(m[1]); return q ? q[1] : null; };
    if (m[2] !== undefined) op = +m[2];
    else if (!m[1]) return false;
    const gx = get("X"), gy = get("Y"), gi = get("I"), gj = get("J");
    const nx = gx === null ? x : coord(gx, intX, decX) + (incremental ? x : 0), ny = gy === null ? y : coord(gy, intY, decY) + (incremental ? y : 0);
    if (op === 1) move(nx, ny, gi === null ? 0 : coord(gi, intX, decX), gj === null ? 0 : coord(gj, intY, decY));
    else if (op === 2 && region) endContour();
    x = nx; y = ny;
    if (op === 3) flash();
    return false;
  };

  // zerlegen: %…% = erweiterte Befehle (mehrere mit *), sonst bis *
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === "%") {
      const e = text.indexOf("%", i + 1);
      const body = text.slice(i + 1, e < 0 ? n : e);
      i = e < 0 ? n : e + 1;
      const parts = body.split("*").map(q => q.replace(/[\r\n]+/g, "").trim()).filter(Boolean);
      if (!parts.length) continue;
      if (parts[0].startsWith("AM")) ext(parts);
      else for (const p of parts) ext([p]);
      continue;
    }
    const e = text.indexOf("*", i), pct = text.indexOf("%", i);
    if (e < 0 || (pct >= 0 && pct < e)) { i = pct >= 0 ? pct : n; continue; }
    const c = text.slice(i, e).replace(/[\r\n\s]+/g, "");
    i = e + 1;
    if (c && cmd(c)) break;
  }
  endContour();
  closeSr();
  return { objs, lines, func, warnings: [...warnings] };
}

function sweep(ax: number, ay: number, bx: number, by: number, cw: boolean): number {
  let d = Math.atan2(by, bx) - Math.atan2(ay, ax);
  if (cw) { while (d > 1e-12) d -= 2 * Math.PI; } else while (d < -1e-12) d += 2 * Math.PI;
  return d;
}

function shift(o: GObj, dx: number, dy: number): GObj {
  const m = (p: Pt2): Pt2 => [p[0] + dx, p[1] + dy];
  if (o.k === "stroke") return { ...o, a: m(o.a), b: m(o.b) };
  if (o.k === "poly") return { ...o, p: o.p.map(m) };
  return { ...o, parts: o.parts.map(s => ("c" in s ? { on: s.on, c: [s.c[0] + dx, s.c[1] + dy, s.c[2]] } : { on: s.on, p: s.p.map(m) })) };
}

export interface Box { x0: number; y0: number; x1: number; y1: number }
export function gerberBox(objs: GObj[]): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number, r = 0) => { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); };
  for (const o of objs) {
    if (!o.dark) continue;
    if (o.k === "stroke") { add(o.a[0], o.a[1], o.r); add(o.b[0], o.b[1], o.r); }
    else if (o.k === "poly") for (const p of o.p) add(p[0], p[1]);
    else for (const s of o.parts) if (s.on) { if ("c" in s) add(s.c[0], s.c[1], s.c[2]); else for (const p of s.p) add(p[0], p[1]); }
  }
  return x1 >= x0 ? { x0, y0, x1, y1 } : null;
}
