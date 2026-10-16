/**
 * WERKZEUG-ZEICHNUNG (SVG) – wie die Bilder in Estlcams Werkzeug-Dialog
 *
 *   toolSideSvg  – Seitenansicht maßstäblich: Schaft, Schneiden mit Spiral-Richtung,
 *                  Spitze je nach Art (flach, Kugel, Eckenradius, V, Bohrerspitze …),
 *                  auf Wunsch mit Bemaßung (Ø, Schneidenlänge, Winkel, Schaft)
 *   toolEndSvg   – Draufsicht von unten: man sieht, wie viele Schneiden der Fräser hat
 *   toolIconSvg  – kleines Bild für Listen und Knöpfe
 *
 * Alles ohne Bibliothek, nur SVG-Text – funktioniert in der App und im Test-Browser.
 */

export type ToolType = "endmill" | "ball" | "bullnose" | "vbit" | "chamfer" | "countersink" | "drill" | "facemill";
export type Helix = "up" | "down" | "compression" | "straight";

/** Die Maße, die man zum Zeichnen braucht (Teil von MillingTool) */
export interface ToolGeom {
  type: ToolType;
  diameter: number;   // Schneiden-Ø (bei V/Fase/Senker: größter Ø)
  shankDia: number;   // Schaft-Ø
  fluteLen: number;   // Schneidenlänge
  length: number;     // Gesamtlänge
  flutes: number;     // Anzahl Schneiden
  helix: Helix;
  angle: number;      // Spitzenwinkel (V, Fase, Senker, Bohrer)
  tipDia: number;     // Spitzen-Ø (V-Stichel/Fase)
  cornerR: number;    // Eckenradius (Torusfräser)
}

type P = [number, number];
const n = (v: number) => (Math.round(v * 100) / 100).toString();
const fmt = (v: number) => (Math.round(v * 1000) / 1000).toString();
let uid = 0;

/** Höhe des kegeligen Teils bei V/Fase/Senker/Bohrer (in mm) */
export function coneHeight(g: ToolGeom): number {
  const R = g.diameter / 2;
  const half = Math.max(1, Math.min(179, g.angle)) / 2 * Math.PI / 180;
  if (g.type === "vbit" || g.type === "chamfer" || g.type === "countersink") return Math.max(0, (R - g.tipDia / 2)) / Math.tan(half);
  if (g.type === "drill") return R / Math.tan(half);
  return 0;
}

/** Rechte Hälfte der Schneiden-Kontur, von der Spitze (y = 0) bis oben an die Schneiden */
function cutterProfile(g: ToolGeom): { pts: P[]; top: number } {
  const R = g.diameter / 2;
  const pts: P[] = [];
  let top = Math.max(g.fluteLen, 0.1);
  switch (g.type) {
    case "ball": {
      for (let i = 0; i <= 12; i++) { const a = i / 12 * Math.PI / 2; pts.push([R * Math.sin(a), R - R * Math.cos(a)]); }
      top = Math.max(top, R);
      pts.push([R, top]);
      break;
    }
    case "bullnose": {
      const r = Math.min(Math.max(g.cornerR, 0), R);
      pts.push([0, 0], [R - r, 0]);
      for (let i = 1; i <= 8; i++) { const a = i / 8 * Math.PI / 2; pts.push([R - r + r * Math.sin(a), r - r * Math.cos(a)]); }
      top = Math.max(top, r);
      pts.push([R, top]);
      break;
    }
    case "vbit": case "chamfer": case "countersink": {
      const h = coneHeight(g);
      pts.push([0, 0], [g.tipDia / 2, 0], [R, h]);
      top = Math.max(top, h);
      if (top > h + 1e-6) pts.push([R, top]);
      break;
    }
    case "drill": {
      const h = coneHeight(g);
      pts.push([0, 0], [R, h]);
      top = Math.max(top, h);
      pts.push([R, top]);
      break;
    }
    default: // endmill, facemill
      pts.push([0, 0], [R, 0], [R, top]);
  }
  return { pts, top };
}

/** Komplette rechte Hälfte (Schneiden + Übergang + Schaft) */
function fullProfile(g: ToolGeom): { cut: P[]; all: P[]; top: number; total: number } {
  const { pts, top } = cutterProfile(g);
  const R = g.diameter / 2, Rs = Math.max(0.1, g.shankDia / 2);
  const conical = g.type === "vbit" || g.type === "chamfer" || g.type === "countersink";
  const neck = Math.abs(R - Rs) < 1e-6 ? 0 : (conical && R > Rs ? 0.6 : Math.min(Math.abs(R - Rs) * 0.8, 4));
  const total = Math.max(g.length, top + neck + Math.max(4, Rs * 2));
  const all = pts.slice();
  const lastX = all[all.length - 1][0];
  if (Math.abs(lastX - Rs) > 1e-6) all.push([Rs, top + neck]);
  all.push([Rs, total]);
  return { cut: pts, all, top, total };
}

function mirror(half: P[]): P[] {
  const right = half.filter((p, i) => !(i === 0 && p[0] === 0));
  const left = right.slice().reverse().map(([x, y]) => [-x, y] as P);
  const start: P[] = half[0][0] === 0 ? [half[0]] : [];
  return [...start, ...right, ...left];
}

export interface SideOpts { w: number; h: number; dims?: boolean; accent?: string; t?: (k: string) => string }

/** Seitenansicht. Spitze unten, Schaft oben. */
export function toolSideSvg(g: ToolGeom, o: SideOpts): string {
  const id = "tg" + (++uid);
  const { cut, all, top, total } = fullProfile(g);
  const maxR = Math.max(g.diameter, g.shankDia) / 2;
  const padX = o.dims ? 64 : 4, padTop = o.dims ? 14 : 3, padBot = o.dims ? 34 : 3;
  const s = Math.min((o.w - 2 * padX) / (2 * maxR), (o.h - padTop - padBot) / total);
  const cx = o.w / 2, by = o.h - padBot - Math.max(0, (o.h - padTop - padBot - total * s) / 2);
  const X = (x: number) => cx + x * s, Y = (y: number) => by - y * s;
  const path = (pts: P[]) => "M" + pts.map(([x, y]) => `${n(X(x))},${n(Y(y))}`).join("L") + "Z";
  const body = path(mirror(all));
  const cutPoly = path(mirror([...cut, [cut[cut.length - 1][0], top]]));
  const accent = o.accent || "#ffb547";
  const R = g.diameter / 2;

  // Spiral-/Schneiden-Linien im Schneidenbereich
  let stripes = "";
  const conical = g.type === "vbit" || g.type === "chamfer" || g.type === "countersink";
  const fl = Math.max(1, Math.min(12, Math.round(g.flutes)));
  if (g.helix === "straight" || conical) {
    for (let i = 0; i < fl; i++) {
      const a = (i + 0.5) / fl * Math.PI;
      const xr = Math.cos(a);
      if (Math.abs(xr) > 0.97) continue;
      const tx = R * xr, bx = (conical ? g.tipDia / 2 : R) * xr;
      stripes += `<line x1="${n(X(bx))}" y1="${n(Y(0))}" x2="${n(X(tx))}" y2="${n(Y(top))}" />`;
    }
  } else {
    const k = 2 * R * Math.tan(35 * Math.PI / 180);        // Steigung über die Breite (Drallwinkel ~35°)
    const step = Math.max(top / 14, (2 * R * 1.1) / fl);
    for (let y = -k; y < top + k; y += step) {
      const comp = g.helix === "compression";
      const split = top * 0.35;
      const up = g.helix === "up" || (comp && y < split);
      const y1 = up ? y : y + k, y2 = up ? y + k : y;
      stripes += `<line x1="${n(X(-R))}" y1="${n(Y(y1))}" x2="${n(X(R))}" y2="${n(Y(y2))}" />`;
    }
  }

  // Bemaßung
  let dims = "";
  if (o.dims) {
    const tr = o.t || ((k: string) => k);
    const arrow = (x1: number, y1: number, x2: number, y2: number) =>
      `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" marker-start="url(#${id}a)" marker-end="url(#${id}a)" />`;
    // Ø unten
    const yD = by + 18;
    dims += `<line class="tg-ext" x1="${n(X(-R))}" y1="${n(Y(conical ? coneHeight(g) : 0))}" x2="${n(X(-R))}" y2="${n(yD + 4)}" />`;
    dims += `<line class="tg-ext" x1="${n(X(R))}" y1="${n(Y(conical ? coneHeight(g) : 0))}" x2="${n(X(R))}" y2="${n(yD + 4)}" />`;
    dims += arrow(X(-R), yD, X(R), yD);
    dims += `<text x="${n(cx)}" y="${n(yD + 13)}" text-anchor="middle">Ø ${fmt(g.diameter)}</text>`;
    // Schneidenlänge rechts
    const xL = X(maxR) + 14;
    dims += `<line class="tg-ext" x1="${n(X(R) + 2)}" y1="${n(Y(top))}" x2="${n(xL + 4)}" y2="${n(Y(top))}" />`;
    dims += `<line class="tg-ext" x1="${n(X(conical ? g.tipDia / 2 : R) + 2)}" y1="${n(Y(0))}" x2="${n(xL + 4)}" y2="${n(Y(0))}" />`;
    dims += arrow(xL, Y(0), xL, Y(top));
    dims += `<text x="${n(xL + 5)}" y="${n((Y(0) + Y(top)) / 2 + 4)}">${fmt(top)}</text>`;
    // Gesamtlänge links
    const xT = X(-maxR) - 16;
    dims += `<line class="tg-ext" x1="${n(X(-g.shankDia / 2) - 2)}" y1="${n(Y(total))}" x2="${n(xT - 4)}" y2="${n(Y(total))}" />`;
    dims += `<line class="tg-ext" x1="${n(X(conical ? -g.tipDia / 2 : -R) - 2)}" y1="${n(Y(0))}" x2="${n(xT - 4)}" y2="${n(Y(0))}" />`;
    dims += arrow(xT, Y(0), xT, Y(total));
    dims += `<text x="${n(xT - 5)}" y="${n((Y(0) + Y(total)) / 2 + 4)}" text-anchor="end">${fmt(total)}</text>`;
    // Schaft-Ø oben
    if (Math.abs(g.shankDia - g.diameter) > 1e-6) {
      const yS = Y(total) + 12;
      dims += `<text x="${n(X(g.shankDia / 2) + 6)}" y="${n(yS)}">${tr("tl.g.shankShort")} Ø ${fmt(g.shankDia)}</text>`;
    }
    // Winkel
    if (conical || g.type === "drill") {
      dims += `<text x="${n(cx)}" y="${n(Y(coneHeight(g) * 0.5) + 4)}" text-anchor="middle" class="tg-angle">${fmt(g.angle)}°</text>`;
    }
    if (g.type === "bullnose" && g.cornerR > 0) {
      dims += `<text x="${n(X(R) + 4)}" y="${n(Y(0) - 2)}" class="tg-angle">R${fmt(g.cornerR)}</text>`;
    }
  }

  return `<svg class="tool-svg" viewBox="0 0 ${o.w} ${o.h}" width="${o.w}" height="${o.h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="${id}s" x1="0" x2="1"><stop offset="0" stop-color="#6b737d"/><stop offset="0.45" stop-color="#d6dce3"/><stop offset="1" stop-color="#5a616a"/></linearGradient>
      <linearGradient id="${id}c" x1="0" x2="1"><stop offset="0" stop-color="#7d6a45"/><stop offset="0.45" stop-color="${accent}"/><stop offset="1" stop-color="#6e5a33"/></linearGradient>
      <clipPath id="${id}k"><path d="${cutPoly}"/></clipPath>
      <marker id="${id}a" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="currentColor"/></marker>
    </defs>
    <path d="${body}" fill="url(#${id}s)" stroke="#2b3036" stroke-width="0.8"/>
    <path d="${cutPoly}" fill="url(#${id}c)" stroke="#2b3036" stroke-width="0.8"/>
    <g clip-path="url(#${id}k)" stroke="rgba(30,25,15,0.7)" stroke-width="${o.dims ? 1.6 : 0.9}">${stripes}</g>
    ${o.dims ? `<g class="tg-dims">${dims}</g>` : ""}
  </svg>`;
}

/** Ansicht von unten: Kreis mit N Schneiden */
export function toolEndSvg(g: ToolGeom, size: number, accent = "#ffb547"): string {
  const c = size / 2, R = size / 2 - 4;
  const fl = Math.max(1, Math.min(12, Math.round(g.flutes)));
  let parts = "";
  for (let i = 0; i < fl; i++) {
    const a0 = i / fl * Math.PI * 2 - Math.PI / 2;
    const span = Math.min(0.55, 0.42 * (Math.PI * 2 / fl));
    const r0 = R * 0.22;
    // Spanraum (dunkle Nut) hinter der Schneide
    const p1 = [c + r0 * Math.cos(a0), c + r0 * Math.sin(a0)];
    const p2 = [c + R * Math.cos(a0), c + R * Math.sin(a0)];
    const p3 = [c + R * Math.cos(a0 - span), c + R * Math.sin(a0 - span)];
    parts += `<path d="M${n(p1[0])},${n(p1[1])} L${n(p2[0])},${n(p2[1])} A${n(R)},${n(R)} 0 0 0 ${n(p3[0])},${n(p3[1])} Q${n(c + R * 0.45 * Math.cos(a0 - span * 0.6))},${n(c + R * 0.45 * Math.sin(a0 - span * 0.6))} ${n(p1[0])},${n(p1[1])}Z" fill="#1d2126"/>`;
    // Schneide
    parts += `<line x1="${n(p1[0])}" y1="${n(p1[1])}" x2="${n(p2[0])}" y2="${n(p2[1])}" stroke="${accent}" stroke-width="2.2" stroke-linecap="round"/>`;
  }
  return `<svg class="tool-svg tool-end" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${c}" cy="${c}" r="${R}" fill="#9aa3ad" stroke="#2b3036" stroke-width="1"/>
    ${parts}
    <circle cx="${c}" cy="${c}" r="${n(R * 0.12)}" fill="#5a616a"/>
  </svg>`;
}

/** Kleines Bild (ohne Maße) – Proportionen wie ein typisches Werkzeug dieser Art */
export function toolIconSvg(g: ToolGeom, w = 22, h = 40, accent?: string): string {
  return toolSideSvg(g, { w, h, accent });
}
