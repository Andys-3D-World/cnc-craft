/**
 * MATERIALANSICHT: das Design so zeigen, wie es auf dem Material aussehen würde
 *
 * Das Bett bekommt die Oberfläche des Materials (Holz, Kunststoff, Metall, Schiefer …), gezeichnet als Kachel
 * im echten Maßstab (eine Kachel = 200 mm). Gravuren erscheinen in der Brandfarbe des Materials
 * (Holz/Leder dunkel, Acryl/Schiefer/eloxiertes Alu hell), Schnitte als dunkle Fuge.
 * core = Farbe unter der Oberfläche (gefräste Stellen, Seiten): eloxiertes Alu und Gravurlaminat zeigen dort das
 * blanke Alu bzw. die zweite Farbe, Platinen das Trägermaterial. layers = Leimfugen-Farbe bei Sperrholz.
 * gloss = Glanz (0 matt … 1 spiegelnd) für die 3D-Darstellung in der Simulation (sim/simCarveGl.ts).
 * Laser: Füll-Ebenen = Fläche graviert, Linien-Ebenen = Linie graviert, starke Linien-Ebenen (ab 70 %) = Schnitt.
 * Fräse: Tasche = vertiefte Fläche, sonst Fräsbahn als Fuge. Plasma: alles Schnitt.
 * Nur Anzeige – am G-Code ändert sich nichts.
 */
import { MM_TO_PIXEL } from "./shapeTransform";
import { isLaser, isPlasma } from "./machineMode";
import { effectiveLayer, layerHasFill } from "./laserLayers";
import { tracePath } from "./render";
import { drawImageShape } from "./raster/imageShape";

type RGB = [number, number, number];
export type MatKind = "wood" | "plywood" | "mdf" | "cork" | "acrylic" | "plastic" | "foam" | "laminate" | "leather"
  | "slate" | "stone" | "card" | "metal" | "brushed" | "anodized" | "pcb";
export type MatGroup = "wood" | "plastic" | "metal" | "other";
export interface Material {
  id: string; group: MatGroup; kind: MatKind;
  base: RGB; burn: RGB;
  core?: RGB; layers?: RGB; gloss?: number;
}

const ALU: RGB = [214, 218, 224];   // blankes Alu unter der Eloxalschicht
export const MATERIALS: Material[] = [
  // Holz
  { id: "birch", group: "wood", kind: "wood", base: [232, 211, 176], burn: [64, 38, 22] },
  { id: "beech", group: "wood", kind: "wood", base: [222, 184, 142], burn: [66, 38, 20] },
  { id: "oak", group: "wood", kind: "wood", base: [196, 160, 112], burn: [58, 36, 20] },
  { id: "walnut", group: "wood", kind: "wood", base: [128, 84, 54], burn: [36, 20, 11] },
  { id: "plywood", group: "wood", kind: "plywood", base: [228, 206, 166], burn: [62, 38, 22], layers: [176, 146, 98] },
  { id: "mdf", group: "wood", kind: "mdf", base: [176, 134, 92], burn: [42, 26, 15], core: [158, 116, 78] },
  { id: "cork", group: "wood", kind: "cork", base: [186, 142, 98], burn: [52, 32, 18] },
  // Kunststoff
  { id: "acrylBlack", group: "plastic", kind: "acrylic", base: [20, 20, 23], burn: [226, 226, 230], gloss: 0.85 },
  { id: "acrylWhite", group: "plastic", kind: "acrylic", base: [238, 238, 234], burn: [206, 206, 202], gloss: 0.8 },
  { id: "acrylClear", group: "plastic", kind: "acrylic", base: [196, 222, 234], burn: [246, 250, 252], gloss: 0.9 },
  { id: "acrylRed", group: "plastic", kind: "acrylic", base: [190, 30, 38], burn: [238, 168, 168], gloss: 0.85 },
  { id: "laminate", group: "plastic", kind: "laminate", base: [26, 26, 28], burn: [240, 240, 238], core: [240, 240, 238], gloss: 0.45 },
  { id: "pom", group: "plastic", kind: "plastic", base: [236, 234, 226], burn: [196, 176, 146], gloss: 0.4 },
  { id: "hdpe", group: "plastic", kind: "plastic", base: [242, 242, 238], burn: [208, 202, 186], gloss: 0.25 },
  { id: "pvcFoam", group: "plastic", kind: "foam", base: [245, 245, 243], burn: [150, 128, 96] },
  { id: "xpsFoam", group: "plastic", kind: "foam", base: [150, 198, 128], burn: [96, 120, 70] },
  // Metall
  { id: "aluRaw", group: "metal", kind: "brushed", base: [198, 202, 208], burn: [120, 122, 126], core: ALU, gloss: 0.7 },
  { id: "aluE6EV1", group: "metal", kind: "anodized", base: [184, 188, 192], burn: [238, 240, 242], core: ALU, gloss: 0.3 },
  { id: "aluE6C4", group: "metal", kind: "anodized", base: [114, 86, 58], burn: [230, 228, 222], core: ALU, gloss: 0.3 },
  { id: "anodized", group: "metal", kind: "anodized", base: [32, 34, 38], burn: [218, 218, 218], core: ALU, gloss: 0.3 },
  { id: "brass", group: "metal", kind: "brushed", base: [200, 166, 82], burn: [92, 72, 40], core: [216, 182, 98], gloss: 0.75 },
  { id: "copper", group: "metal", kind: "brushed", base: [192, 114, 74], burn: [82, 42, 26], core: [216, 136, 92], gloss: 0.75 },
  { id: "steel", group: "metal", kind: "metal", base: [128, 132, 138], burn: [62, 62, 66], core: [178, 182, 188], gloss: 0.45 },
  { id: "stainless", group: "metal", kind: "brushed", base: [178, 182, 188], burn: [42, 38, 42], core: [198, 202, 208], gloss: 0.75 },
  // Sonstiges
  { id: "pcb", group: "other", kind: "pcb", base: [186, 118, 74], burn: [44, 32, 22], core: [196, 188, 120], gloss: 0.55 },
  { id: "leather", group: "other", kind: "leather", base: [166, 110, 70], burn: [56, 32, 18] },
  { id: "slate", group: "other", kind: "slate", base: [58, 63, 68], burn: [205, 205, 205] },
  { id: "granite", group: "other", kind: "stone", base: [86, 86, 90], burn: [222, 222, 222], gloss: 0.35 },
  { id: "cardboard", group: "other", kind: "card", base: [201, 168, 121], burn: [72, 46, 26] }
];

export const MATERIAL_GROUPS: MatGroup[] = ["wood", "plastic", "metal", "other"];

/** Auswahl-Liste (nach Gruppen) – für Werkzeugleiste, 3D-Ansicht und 3D-Fräsen */
export function materialOptionsHtml(t: (k: string) => string, selected = ""): string {
  return MATERIAL_GROUPS.map(g => `<optgroup label="${t("mat3d.g." + g)}">${MATERIALS.filter(m => m.group === g)
    .map(m => `<option value="${m.id}"${m.id === selected ? " selected" : ""}>${t("mat3d." + m.id)}</option>`).join("")}</optgroup>`).join("");
}

/** Material nach Kennung (sonst null) */
export function materialById(id: string): Material | null { return MATERIALS.find(m => m.id === id) || null; }

/** Holz-artig (brennt beim Lasern dunkel, Maserung) */
export function isWoody(m: Material): boolean { return ["wood", "plywood", "mdf", "cork", "card", "leather"].includes(m.kind); }

const KEY = "cnc_craft_material_view";
let current = "off";
try { current = localStorage.getItem(KEY) || "off"; } catch { /* egal */ }

export function materialView(): Material | null { return MATERIALS.find(m => m.id === current) || null; }

/** Auswahlfeld in der Werkzeugleiste anbinden */
export function initMaterialView(redraw: () => void) {
  const sel = document.getElementById("opt-material") as HTMLSelectElement | null;
  if (!sel) return;
  sel.value = materialView() ? current : "off";
  sel.addEventListener("change", () => {
    current = sel.value;
    try { localStorage.setItem(KEY, current); } catch { /* egal */ }
    redraw();
  });
}

const rgb = (c: RGB, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// ---------------------------------------------------------------------
// Oberfläche (einmal je Material als Kachel 512 × 512 berechnet)
// ---------------------------------------------------------------------

const tiles = new Map<string, HTMLCanvasElement>();

function tile(m: Material): HTMLCanvasElement {
  const hit = tiles.get(m.id);
  if (hit) return hit;
  const N = 512, c = document.createElement("canvas");
  c.width = N; c.height = N;
  const ctx = c.getContext("2d")!;
  const id = ctx.createImageData(N, N);
  // weiches Muster aus ein paar Sinus-Wellen (kachelbar, weil alle Perioden in N aufgehen) + etwas Körnung
  const wave = (x: number, y: number, fx: number, fy: number, ph: number) => Math.sin(((x * fx + y * fy) / N) * 2 * Math.PI + ph);
  let seed = 0;
  for (const ch of m.id) seed = (seed * 31 + ch.charCodeAt(0)) % 2147483647;
  seed = seed || 9973;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // gebürstet: jede Zeile etwas heller/dunkler (weich, kachelbar über die Zeilen)
  const rows = new Float32Array(N);
  for (let y = 0; y < N; y++) rows[y] = rnd() - 0.5;
  const streak = new Float32Array(N);
  for (let y = 0; y < N; y++) streak[y] = 0.5 * rows[y] + 0.25 * rows[(y + 1) % N] + 0.25 * rows[(y + N - 1) % N];
  // Flecken (Kork, Granit): zufällige Punkte, Wert je Pixel aus einem groben Raster
  const G = 128, blob = new Float32Array(G * G);
  for (let k = 0; k < blob.length; k++) blob[k] = rnd();
  const blobAt = (x: number, y: number) => blob[((y >> 2) % G) * G + ((x >> 2) % G)];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v: number;
    if (m.kind === "wood" || m.kind === "plywood") {
      // Maserung: gestreckte, leicht gewellte Jahresringe
      const ring = wave(x, y, 0, 22, 0.9 * wave(x, y, 2, 1, 0) + 0.35 * wave(x, y, 5, 3, 1));
      v = 0.28 * ring * Math.abs(ring) + 0.18 * wave(x, y, 1, 40, 0.5) + 0.06 * (rnd() - 0.5);
      if (m.kind === "plywood") v *= 0.7; // Schälfurnier: ruhiger
    } else if (m.kind === "mdf") {
      v = 0.035 * wave(x, y, 2, 3, 0.4) + 0.07 * (rnd() - 0.5);
    } else if (m.kind === "cork") {
      const b = blobAt(x, y);
      v = (b > 0.85 ? -0.22 : b < 0.12 ? 0.12 : 0) + 0.16 * (rnd() - 0.5);
    } else if (m.kind === "stone") {
      const b = blobAt(x, y);
      v = (b > 0.8 ? 0.55 : b < 0.18 ? -0.35 : 0) + 0.2 * (rnd() - 0.5);
    } else if (m.kind === "foam") {
      v = 0.05 * wave(x, y, 23, 37, 0) * wave(x, y, 41, 19, 2) + 0.06 * (rnd() - 0.5);
    } else if (m.kind === "plastic" || m.kind === "laminate") {
      v = 0.02 * wave(x, y, 1, 2, 0.3) + 0.02 * (rnd() - 0.5);
    } else if (m.kind === "brushed") {
      // gebürstet: feine Längsstriche + leichte Wolken
      v = 0.11 * streak[y] + 0.03 * (rnd() - 0.5) + 0.03 * wave(x, y, 2, 1, 0.7);
    } else if (m.kind === "anodized") {
      // eloxiert: samtig matt, ganz leicht gebürstet
      v = 0.035 * streak[y] + 0.035 * (rnd() - 0.5);
    } else if (m.kind === "pcb") {
      v = 0.05 * wave(x, y, 3, 2, 0.2) + 0.04 * (rnd() - 0.5);
    } else if (m.kind === "leather") {
      v = 0.22 * wave(x, y, 31, 17, 0) * wave(x, y, 13, 29, 1) + 0.18 * (rnd() - 0.5);
    } else if (m.kind === "slate") {
      v = 0.16 * wave(x, y, 3, 1, 0) + 0.1 * wave(x, y, 1, 7, 2) + 0.12 * (rnd() - 0.5);
    } else if (m.kind === "card") {
      v = 0.08 * wave(x, y, 0, 64, 0) + 0.14 * (rnd() - 0.5);
    } else if (m.kind === "metal") {
      // Walzhaut: Wolken + feines Korn
      v = 0.07 * wave(x, y, 3, 2, 0) * wave(x, y, 1, 4, 1.3) + 0.05 * (rnd() - 0.5);
    } else {
      // Acryl: glatt, nur ein weicher, sich wiederholender Glanz
      v = 0.05 * wave(x, y, 1, 1, 0.8);
    }
    const k = (y * N + x) * 4;
    for (let ch = 0; ch < 3; ch++) id.data[k + ch] = Math.max(0, Math.min(255, m.base[ch] * (1 + v)));
    id.data[k + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  tiles.set(m.id, c);
  return c;
}

/** Oberflächen-Kachel (512 × 512 Punkte = 200 mm) – auch als Textur für die Simulation */
export function materialTile(m: Material): HTMLCanvasElement { return tile(m); }

/** Bett mit Material-Oberfläche füllen (x, y, w, h in Bildschirm-Pixeln) */
export function drawMaterialBed(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, scale: number, m: Material) {
  const t = tile(m);
  const size = 200 * MM_TO_PIXEL * scale; // eine Kachel = 200 mm
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  // als Muster füllen (nahtlos), Ursprung unten links am Bett, 512 Kachel-Punkte = 200 mm
  const pat = ctx.createPattern(t, "repeat");
  if (pat) {
    pat.setTransform(new DOMMatrix().translate(x, y + h - size).scale(size / t.width));
    ctx.fillStyle = pat;
    ctx.fillRect(x, y, w, h);
  }
  // Plattenkante
  ctx.strokeStyle = "rgba(0,0,0,0.45)"; ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.restore();
}

/** Formen und Bilder im Material-Aussehen */
export function drawMaterialShapes(ctx: CanvasRenderingContext2D, shapes: any[], selected: Set<string>,
  sx: (x: number) => number, sy: (y: number) => number, scale: number, m: Material) {
  const laser = isLaser(), plasma = isPlasma();
  const line = Math.max(1, 0.15 * MM_TO_PIXEL * scale);
  // Schnittfuge: auf hellem Material dunkel, auf dunklem (Acryl schwarz, Schiefer, Alu) als helle Kante
  const dark = 0.299 * m.base[0] + 0.587 * m.base[1] + 0.114 * m.base[2] < 90;
  const gap = dark ? "rgba(255,255,255,0.55)" : "rgba(8,6,5,0.9)";
  for (const s of shapes) if (s.type === "image") drawImageShape(ctx, s, sx, sy, m.burn);
  ctx.save();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  // gefüllte Flächen (Laser-Füll-Ebenen, Taschen) je Ebene zusammen → Löcher bleiben frei
  const fills = new Map<string, any[]>();
  for (const s of shapes) {
    if (s.type === "image") continue;
    const l = laser ? effectiveLayer(s) : null;
    const key = laser ? (l && layerHasFill(l) ? "L:" + l.id : "") : (!plasma && s.millingMode === "pocket" ? "P" : "");
    if (!key) continue;
    if (!fills.has(key)) fills.set(key, []);
    fills.get(key)!.push(s);
  }
  for (const [key, list] of fills) {
    ctx.beginPath();
    for (const s of list) tracePath(ctx, s, sx, sy, scale);
    // eigene Leistung (Testraster): je mehr Leistung, desto dunkler
    const ov = list[0].laserOverride ? effectiveLayer(list[0]) : null;
    // Tasche: Farbe darunter (eloxiertes Alu blank, Laminat zweite Farbe), sonst dunkler
    ctx.fillStyle = key === "P" ? (m.core ? rgb(m.core, 0.92) : "rgba(0,0,0,0.35)") : rgb(m.burn, ov ? 0.15 + 0.8 * ov.power / 100 : 0.88);
    ctx.fill("evenodd");
  }
  // Linien: gravieren (Brandfarbe) oder schneiden (dunkle Fuge)
  for (const s of shapes) {
    if (s.type === "image") continue;
    const l = laser ? effectiveLayer(s) : null;
    if (l && l.mode === "fill") continue; // reine Füll-Ebene: keine Kontur
    const cut = plasma || !laser || !l || l.power >= 70;
    ctx.beginPath();
    tracePath(ctx, s, sx, sy, scale);
    ctx.strokeStyle = cut ? gap : rgb(m.burn, 0.95);
    ctx.lineWidth = cut ? Math.max(1.4, line * 1.2) : line;
    ctx.stroke();
  }
  // Auswahl gut sichtbar darüber
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = "#34d17b"; ctx.lineWidth = 1.5;
  for (const s of shapes) {
    if (!selected.has(s.id)) continue;
    ctx.beginPath(); tracePath(ctx, s, sx, sy, scale); ctx.stroke();
  }
  ctx.restore();
}
