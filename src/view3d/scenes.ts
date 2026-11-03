/**
 * 3D-SZENEN für den Betrachter
 *
 *  - Teile: alles, was durchgeschnitten wird (Laser: Linien-Ebenen ab 70 % Leistung, Fräse: außen/innen,
 *    Plasma: alles Geschlossene), wird zu Körpern mit der Materialdicke. Oben die Material-Oberfläche mit der
 *    Gravur (wie die Materialansicht), Schnittkanten beim Laser auf Holz/Leder/Karton angekohlt dunkel.
 *    Auf Wunsch die Restplatte mit den Löchern dazu, die Teile herausgehoben.
 *  - Zylinder: die Zeichnung um ein rundes Teil gewickelt (Drehachse).
 */
import polygonClipping, { MultiPolygon, Polygon } from "polygon-clipping";
import earcut from "earcut";
import { Mesh } from "./viewer3d";
import { MM_TO_PIXEL, groupBounds, shapeToPaths } from "../shapeTransform";
import { Material, drawMaterialBed, drawMaterialShapes, isWoody } from "../materialView";
import { isLaser, isPlasma } from "../machineMode";
import { layerForShape } from "../laserLayers";
import { circumference } from "../rotary";
import type { CarveResult } from "./carveSim";

type RGB = [number, number, number];
const col = (c: number[], k: number): RGB => [c[0] / 255 * k, c[1] / 255 * k, c[2] / 255 * k];

/** Wird diese Form durchgeschnitten? (gleiche Regel wie die Materialansicht) */
function isCut(s: any): boolean {
  if (s.type === "image") return false;
  if (isPlasma()) return true;
  if (isLaser()) { const l = layerForShape(s); return !!l && l.mode !== "fill" && l.power >= 70; }
  return s.millingMode === "outside" || s.millingMode === "inside";
}

/**
 * Gefräste Stelle im Bild: dunkler nach Tiefe (d = 0…1); Materialien mit anderer Farbe darunter (eloxiertes Alu,
 * Laminat, Platine) zeigen schon nach einem Hauch die Kernfarbe
 */
function shadeCut(px: Uint8ClampedArray, o: number, d: number, m: Material) {
  const s = 1 - (m.core ? 0.25 : 0.5) * Math.min(1, d);
  if (m.core) {
    const k = Math.min(1, d * 8);
    for (let ch = 0; ch < 3; ch++) px[o + ch] = (px[o + ch] * (1 - k) + m.core[ch] * k) * s;
  } else { px[o] *= s; px[o + 1] *= s; px[o + 2] *= s; }
}

/** Oberfläche (Material + Gravur) für den Bereich b (mm) als Bild */
function topTexture(shapes: any[], m: Material, b: { x0: number; y0: number; x1: number; y1: number }): HTMLCanvasElement {
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const k = Math.min(8, 4096 / Math.max(w, h));             // Bildpunkte pro mm
  const tex = document.createElement("canvas");
  tex.width = Math.max(2, Math.round(w * k)); tex.height = Math.max(2, Math.round(h * k));
  const ctx = tex.getContext("2d")!;
  const scale = k / MM_TO_PIXEL;
  drawMaterialBed(ctx, 0, 0, tex.width, tex.height, scale, m);
  drawMaterialShapes(ctx, shapes, new Set(),
    x => (x - b.x0 * MM_TO_PIXEL) * scale, y => (b.y1 * MM_TO_PIXEL - y) * scale, scale, m);
  return tex;
}

/** Fläche (mehrere Polygone mit Löchern) zu einem Körper von z0 bis z1 */
function extrude(mp: MultiPolygon, z0: number, z1: number, top: { tex: HTMLCanvasElement; b: { x0: number; y0: number; x1: number; y1: number } },
  side: RGB, bottom: RGB, offset: [number, number, number]): Mesh[] {
  const T: Mesh = { pos: [], nrm: [], uv: [], tex: top.tex, offset };
  const B: Mesh = { pos: [], nrm: [], color: bottom, offset };
  const S: Mesh = { pos: [], nrm: [], color: side, offset };
  const bw = top.b.x1 - top.b.x0, bh = top.b.y1 - top.b.y0;
  for (const poly of mp) {
    const flat: number[] = [], holes: number[] = [];
    poly.forEach((ring, ri) => {
      const r = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
      if (ri) holes.push(flat.length / 2);
      for (const [x, y] of r) flat.push(x, y);
      // Seitenwände
      for (let i = 0; i < r.length; i++) {
        const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length];
        const L = Math.hypot(bx - ax, by - ay);
        if (L < 1e-9) continue;
        const nx = (by - ay) / L, ny = -(bx - ax) / L;
        S.pos.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z0, bx, by, z1, ax, ay, z1);
        for (let k = 0; k < 6; k++) S.nrm.push(nx, ny, 0);
      }
    });
    const tri = earcut(flat, holes.length ? holes : null, 2);
    for (const i of tri) {
      const x = flat[i * 2], y = flat[i * 2 + 1];
      T.pos.push(x, y, z1); T.nrm.push(0, 0, 1); T.uv!.push((x - top.b.x0) / bw, (top.b.y1 - y) / bh);
      B.pos.push(x, y, z0); B.nrm.push(0, 0, -1);
    }
  }
  return [T, B, S];
}

export interface PartsOptions { thickness: number; sheet: boolean; lift: number }

/** Teile (und Restplatte) als 3D-Körper. Gibt auch die Anzahl Teile zurück. */
export function partsScene(shapes: any[], m: Material, o: PartsOptions): { meshes: Mesh[]; parts: number } {
  const gb = groupBounds(shapes);
  if (!gb) return { meshes: [], parts: 0 };
  const mm = (v: number) => v / MM_TO_PIXEL;
  const margin = 8;
  const b = { x0: mm(gb.minX) - margin, y0: mm(gb.minY) - margin, x1: mm(gb.maxX) + margin, y1: mm(gb.maxY) + margin };
  const tex = topTexture(shapes, m, b);
  // Fläche der Teile: alle Schnittkonturen nach Gerade/Ungerade
  const rings: Polygon[] = [];
  for (const s of shapes) if (isCut(s)) for (const p of shapeToPaths(s)) {
    if (p.closed && p.pts.length >= 3) rings.push([p.pts.map(q => [mm(q.x), mm(q.y)] as [number, number])]);
  }
  const parts: MultiPolygon = rings.length ? (rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1))) : [];
  const T = Math.max(0.2, o.thickness);
  const laserBurn = isLaser() && isWoody(m);
  const edge: RGB = laserBurn ? col(m.burn, 0.85) : col(m.core ?? m.base, 0.78);
  const bottom = col(m.base, 0.8);
  const rect: MultiPolygon = [[[[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]]];
  const meshes: Mesh[] = [];
  if (!parts.length) {
    // nichts wird ausgeschnitten: nur die Platte mit der Gravur
    meshes.push(...extrude(rect, 0, T, { tex, b }, col(m.core ?? m.base, 0.78), bottom, [0, 0, 0]));
    return { meshes, parts: 0 };
  }
  meshes.push(...extrude(parts, 0, T, { tex, b }, edge, bottom, [0, 0, o.sheet ? o.lift : 0]));
  if (o.sheet) {
    const rest = polygonClipping.difference(rect, parts);
    if (rest.length) meshes.push(...extrude(rest, 0, T, { tex, b }, edge, bottom, [0, 0, 0]));
  }
  return { meshes, parts: parts.length };
}

/** Zeichnung abgewickelt als Bild: Breite = Länge entlang X, Höhe = Umfang (oben = Umfang, unten = 0) */
export function wrapTexture(shapes: any[], m: Material, pxPerMm: number, along: "x" | "y" = "x"): { tex: HTMLCanvasElement; lenMm: number; yc: number } {
  const b = groupBounds(shapes);
  const margin = 15;
  // Achse entlang Y: entlang des Teils = Y der Zeichnung, rundherum = X (90° gedreht, nicht gespiegelt)
  const ay = along === "y";
  const x0 = b ? (ay ? b.minY : b.minX) / MM_TO_PIXEL - margin : 0;
  const x1 = b ? (ay ? b.maxY : b.maxX) / MM_TO_PIXEL + margin : 100;
  const lenMm = Math.max(40, x1 - x0), circ = circumference();
  const k = Math.min(pxPerMm, 4096 / Math.max(lenMm, circ));
  const tex = document.createElement("canvas");
  tex.width = Math.max(2, Math.round(lenMm * k));
  tex.height = Math.max(2, Math.round(circ * k));
  const ctx = tex.getContext("2d")!;
  const scale = k / MM_TO_PIXEL;
  drawMaterialBed(ctx, 0, 0, tex.width, tex.height, scale, m);
  const cPx = circ * MM_TO_PIXEL;
  if (ay) {
    // Bild: rechts = Y der Zeichnung, nach unten = X (intern rundherum = Umfang − X)
    ctx.save();
    ctx.transform(0, 1, 1, 0, -x0 * MM_TO_PIXEL * scale, 0);
    drawMaterialShapes(ctx, shapes, new Set(), x => x * scale, y => y * scale, scale, m);
    ctx.restore();
    return { tex, lenMm, yc: b ? circ - (b.minX + b.maxX) / 2 / MM_TO_PIXEL : circ / 2 };
  }
  drawMaterialShapes(ctx, shapes, new Set(), x => (x - x0 * MM_TO_PIXEL) * scale, y => (cPx - y) * scale, scale, m);
  const yc = b ? (b.minY + b.maxY) / 2 / MM_TO_PIXEL : circ / 2;
  return { tex, lenMm, yc };
}

/** Rundes Teil (Achse entlang x), die Mitte der Zeichnung zeigt nach vorn (zur Kamera, −y) */
export function cylinderScene(shapes: any[], m: Material, diameter: number, along: "x" | "y" = "x"): Mesh[] {
  const { tex, lenMm, yc } = wrapTexture(shapes, m, 6, along);
  const R = diameter / 2, N = 160, circ = circumference();
  const shift = (yc / circ) * Math.PI * 2;
  const side: Mesh = { pos: [], nrm: [], uv: [], tex };
  const P = (x: number, th: number) => { const a = th - shift; return [x, -R * Math.cos(a), R * Math.sin(a)]; };
  const Nn = (th: number) => { const a = th - shift; return [0, -Math.cos(a), Math.sin(a)]; };
  for (let j = 0; j < N; j++) {
    const t0 = (j / N) * Math.PI * 2, t1 = ((j + 1) / N) * Math.PI * 2;
    // Bildzeile: oben im Bild = großes y der Zeichnung; θ wächst nach oben (vorn), y der Zeichnung auch
    const v0 = 1 - j / N, v1 = 1 - (j + 1) / N;
    const quad: [number, number, number, number][] = [[0, t0, 0, v0], [lenMm, t0, 1, v0], [lenMm, t1, 1, v1], [0, t0, 0, v0], [lenMm, t1, 1, v1], [0, t1, 0, v1]];
    for (const [x, th, u, v] of quad) { side.pos.push(...P(x, th)); side.nrm.push(...Nn(th)); side.uv!.push(u, v); }
  }
  const caps: Mesh = { pos: [], nrm: [], color: col(m.core ?? m.base, 0.88) };
  for (const [x, nx] of [[0, -1], [lenMm, 1]] as const) for (let j = 0; j < N; j++) {
    const t0 = (j / N) * Math.PI * 2, t1 = ((j + 1) / N) * Math.PI * 2;
    caps.pos.push(x, 0, 0, ...P(x, t0), ...P(x, t1));
    for (let k = 0; k < 3; k++) caps.nrm.push(nx, 0, 0);
  }
  return [side, caps];
}

const MAX_QUADS = 160_000;

/**
 * Fräsergebnis (carveSim.ts) als Körper: Oberfläche mit Holzbild und Schatten nach Tiefe, Unterseite, Seiten.
 * Durchgefräste Stellen (tiefer als die Materialdicke) bleiben offen.
 */
export function carveScene(r: CarveResult, m: Material, thickness: number): Mesh[] {
  const T = Math.max(0.2, thickness);
  // gröberes Netz, falls das Raster sehr fein ist (Mittelwert je Block – so behalten V-Nuten ihre Form)
  const f = Math.max(1, Math.ceil(Math.sqrt((r.nx * r.ny) / MAX_QUADS)));
  const nx = Math.ceil(r.nx / f), ny = Math.ceil(r.ny / f), cs = r.cell * f;
  const H = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let v = 0, n = 0;
    for (let b = 0; b < f; b++) for (let a = 0; a < f; a++) {
      const ii = i * f + a, jj = j * f + b;
      if (ii < r.nx && jj < r.ny) { v += r.h[jj * r.nx + ii]; n++; }
    }
    H[j * nx + i] = Math.max(-T, n ? v / n : 0);
  }
  const X = (i: number) => r.x0 + (i + 0.5) * cs, Y = (j: number) => r.y0 + (j + 0.5) * cs;
  const at = (i: number, j: number) => H[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  const through = (i: number, j: number) => at(i, j) <= -T + 1e-3;

  // Bild: Material (Maserung nur angedeutet – hier zählt die Form) + Schatten nach Tiefe
  const k = Math.max(1, Math.floor(2048 / Math.max(nx, ny)));
  const tex = document.createElement("canvas");
  tex.width = nx * k; tex.height = ny * k;
  const ctx = tex.getContext("2d")!;
  // Maserung feiner (eine Kachel = 60 statt 200 mm), sonst wirken die breiten Jahresringe in 3D wie Wellen
  drawMaterialBed(ctx, 0, 0, tex.width, tex.height, (0.3 * k) / cs / MM_TO_PIXEL, m);
  ctx.fillStyle = `rgba(${m.base[0]}, ${m.base[1]}, ${m.base[2]}, 0.8)`;
  ctx.fillRect(0, 0, tex.width, tex.height);
  const img = ctx.getImageData(0, 0, tex.width, tex.height);
  // dunkler nach Tiefe, bezogen auf die tiefste gefräste Stelle (sonst sähe man flache Gravuren kaum)
  const deep = Math.max(0.2, Math.min(T, -r.minZ));
  for (let py = 0; py < tex.height; py++) for (let px = 0; px < tex.width; px++) {
    const d = -at(Math.floor(px / k), ny - 1 - Math.floor(py / k)) / deep;
    if (d <= 0.001) continue;
    shadeCut(img.data, (py * tex.width + px) * 4, d, m);
  }
  ctx.putImageData(img, 0, 0);

  const top: Mesh = { pos: [], nrm: [], uv: [], tex };
  const bottom: Mesh = { pos: [], nrm: [], color: col(m.base, 0.75) };
  const side: Mesh = { pos: [], nrm: [], color: col(m.core ?? m.base, 0.8) };
  const nrm = (i: number, j: number) => {
    const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * cs), dy = (at(i, j + 1) - at(i, j - 1)) / (2 * cs);
    const l = Math.hypot(dx, dy, 1);
    return [-dx / l, -dy / l, 1 / l];
  };
  const N: number[][] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) N.push(nrm(i, j));
  const vtx = (i: number, j: number) => {
    top.pos.push(X(i), Y(j), T + at(i, j));
    const n = N[j * nx + i]; top.nrm.push(n[0], n[1], n[2]);
    top.uv!.push((i + 0.5) / nx, 1 - (j + 0.5) / ny);
  };
  for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    const t00 = through(i, j), t10 = through(i + 1, j), t01 = through(i, j + 1), t11 = through(i + 1, j + 1);
    if (t00 && t10 && t01 && t11) continue; // durchgefräst: offen
    vtx(i, j); vtx(i + 1, j); vtx(i + 1, j + 1); vtx(i, j); vtx(i + 1, j + 1); vtx(i, j + 1);
    if (!(t00 || t10 || t01 || t11)) {
      bottom.pos.push(X(i), Y(j), 0, X(i + 1), Y(j + 1), 0, X(i + 1), Y(j), 0, X(i), Y(j), 0, X(i), Y(j + 1), 0, X(i + 1), Y(j + 1), 0);
      for (let q = 0; q < 6; q++) bottom.nrm.push(0, 0, -1);
    }
  }
  // Seiten des Blocks (am Rand wird nicht gefräst)
  const xa = X(0), xb = X(nx - 1), ya = Y(0), yb = Y(ny - 1);
  const wall = (ax: number, ay: number, bx: number, by: number, nx2: number, ny2: number) => {
    side.pos.push(ax, ay, 0, bx, by, 0, bx, by, T, ax, ay, 0, bx, by, T, ax, ay, T);
    for (let q = 0; q < 6; q++) side.nrm.push(nx2, ny2, 0);
  };
  wall(xa, ya, xb, ya, 0, -1); wall(xb, ya, xb, yb, 1, 0); wall(xb, yb, xa, yb, 0, 1); wall(xa, yb, xa, ya, -1, 0);
  return [top, bottom, side];
}

/**
 * Fräsergebnis auf dem runden Teil (Drehachse): das Höhenraster aus carveSim.ts (abgewickelt, Y = mm rundherum)
 * um einen Zylinder gewickelt – Radius an jeder Stelle = Teil-Radius + Tiefe. Außerhalb des Rasters bleibt
 * die Oberfläche glatt; links und rechts ein Stück ungefrästes Material.
 */
export function cylinderCarveScene(r: CarveResult, m: Material, diameter: number): Mesh[] {
  const R = diameter / 2, circ = Math.PI * diameter, margin = 3;
  // Rastergröße: rundherum etwa so fein wie das Fräsraster, insgesamt höchstens MAX_QUADS Vierecke
  const lenMm = r.nx * r.cell + 2 * margin;
  const f = Math.max(1, Math.sqrt((lenMm / r.cell) * (circ / r.cell) / MAX_QUADS));
  const cs = r.cell * f;
  const NX = Math.max(2, Math.ceil(lenMm / cs) + 1), NT = Math.max(24, Math.ceil(circ / cs));
  const xL = r.x0 - margin;
  // Tiefe an einer Stelle der Abwicklung (tiefster Wert im Umkreis einer Zelle – so verschwinden feine Nuten nicht)
  const cellH = (i: number, j: number) => (i >= 0 && j >= 0 && i < r.nx && j < r.ny ? r.h[j * r.nx + i] : 0);
  const depth = (x: number, y: number) => {
    let best = 0;
    for (const yy of [y, y - circ, y + circ]) {
      const ci = (x - r.x0) / r.cell, cj = (yy - r.y0) / r.cell;
      if (ci < -f || cj < -f || ci > r.nx + f || cj > r.ny + f) continue;
      const s = Math.max(1, Math.ceil(f / 2));
      const i0 = Math.floor(ci), j0 = Math.floor(cj);
      let v = 0, n = 0;
      for (let b = -s + 1; b < s; b++) for (let a = -s + 1; a < s; a++) { v += cellH(i0 + a, j0 + b); n++; }
      best = Math.min(best, n ? v / n : 0);
    }
    return Math.max(-R * 0.98, best);
  };
  const H = new Float32Array(NX * NT);
  for (let j = 0; j < NT; j++) for (let i = 0; i < NX; i++) H[j * NX + i] = depth(xL + (i * lenMm) / (NX - 1), (j / NT) * circ);
  const at = (i: number, j: number) => H[(((j % NT) + NT) % NT) * NX + Math.min(NX - 1, Math.max(0, i))];
  const X = (i: number) => xL + (i * lenMm) / (NX - 1);
  // vorne (zum Betrachter) liegt die Mitte des gefrästen Bereichs
  const shift = ((r.y0 + (r.ny * r.cell) / 2) / circ) * Math.PI * 2;
  const th = (j: number) => (j / NT) * Math.PI * 2 - shift;

  // Bild: Material + Schatten nach Tiefe (wie carveScene)
  const k = Math.max(1, Math.floor(2048 / Math.max(NX, NT)));
  const tex = document.createElement("canvas");
  tex.width = NX * k; tex.height = NT * k;
  const ctx = tex.getContext("2d")!;
  drawMaterialBed(ctx, 0, 0, tex.width, tex.height, (0.3 * k) / cs / MM_TO_PIXEL, m);
  ctx.fillStyle = `rgba(${m.base[0]}, ${m.base[1]}, ${m.base[2]}, 0.8)`;
  ctx.fillRect(0, 0, tex.width, tex.height);
  const img = ctx.getImageData(0, 0, tex.width, tex.height);
  const deep = Math.max(0.2, Math.min(R, -r.minZ));
  for (let py = 0; py < tex.height; py++) for (let px = 0; px < tex.width; px++) {
    const d = -at(Math.floor(px / k), NT - 1 - Math.floor(py / k)) / deep;
    if (d <= 0.001) continue;
    shadeCut(img.data, (py * tex.width + px) * 4, d, m);
  }
  ctx.putImageData(img, 0, 0);

  const side: Mesh = { pos: [], nrm: [], uv: [], tex };
  const P = (i: number, j: number) => { const a = th(j), rr = R + at(i, j); return [X(i), -rr * Math.cos(a), rr * Math.sin(a)]; };
  const nrm = (i: number, j: number) => {
    // Neigung entlang der Achse und rundherum → Normale aus der radialen Richtung kippen
    const ds = (Math.PI * 2 * R) / NT, dx = lenMm / (NX - 1);
    const gx = (at(i + 1, j) - at(i - 1, j)) / (2 * dx), gs = (at(i, j + 1) - at(i, j - 1)) / (2 * ds);
    const a = th(j), rad = [0, -Math.cos(a), Math.sin(a)], tan = [0, Math.sin(a), Math.cos(a)];
    const v = [rad[0] - gx, rad[1] - gs * tan[1], rad[2] - gs * tan[2]];
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const vtx = (i: number, j: number) => {
    side.pos.push(...P(i, j)); side.nrm.push(...nrm(i, j));
    side.uv!.push((i + 0.5) / NX, 1 - (j + 0.5) / NT);
  };
  for (let j = 0; j < NT; j++) for (let i = 0; i + 1 < NX; i++) {
    vtx(i, j); vtx(i + 1, j); vtx(i + 1, j + 1); vtx(i, j); vtx(i + 1, j + 1); vtx(i, j + 1);
  }
  // Stirnseiten (am Rand wird nicht gefräst)
  const caps: Mesh = { pos: [], nrm: [], color: col(m.core ?? m.base, 0.88) };
  for (const [i, nx] of [[0, -1], [NX - 1, 1]] as const) for (let j = 0; j < NT; j++) {
    caps.pos.push(X(i), 0, 0, ...P(i, j), ...P(i, j + 1));
    for (let q = 0; q < 3; q++) caps.nrm.push(nx, 0, 0);
  }
  return [side, caps];
}

/**
 * Drehachse entlang Y: Fräsergebnis der Zeichnung in die interne Lage bringen (entlang = Y der Zeichnung,
 * rundherum = Umfang − X) – danach wie gewohnt mit cylinderCarveScene zeigen
 */
export function carveAlongY(r: CarveResult, circ: number): CarveResult {
  const nx = r.ny, ny = r.nx;
  const h = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = r.h[i * r.nx + (r.nx - 1 - j)];
  return { ...r, nx, ny, x0: r.y0, y0: circ - (r.x0 + r.nx * r.cell), h };
}
