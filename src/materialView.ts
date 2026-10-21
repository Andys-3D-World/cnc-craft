/**
 * MATERIALANSICHT: das Design so zeigen, wie es auf dem Material aussehen würde
 *
 * Das Bett bekommt die Oberfläche des Materials (Holz, Acryl, Leder, Schiefer …), gezeichnet als Kachel
 * im echten Maßstab (eine Kachel = 200 mm). Gravuren erscheinen in der Brandfarbe des Materials
 * (Holz/Leder dunkel, Acryl/Schiefer/eloxiertes Alu hell), Schnitte als dunkle Fuge.
 * Laser: Füll-Ebenen = Fläche graviert, Linien-Ebenen = Linie graviert, starke Linien-Ebenen (ab 70 %) = Schnitt.
 * Fräse: Tasche = vertiefte Fläche, sonst Fräsbahn als Fuge. Plasma: alles Schnitt.
 * Nur Anzeige – am G-Code ändert sich nichts.
 */
import { MM_TO_PIXEL } from "./shapeTransform";
import { isLaser, isPlasma } from "./machineMode";
import { layerForShape, layerHasFill } from "./laserLayers";
import { tracePath } from "./render";
import { drawImageShape } from "./raster/imageShape";

type RGB = [number, number, number];
export interface Material { id: string; base: RGB; burn: RGB; kind: "wood" | "acrylic" | "leather" | "slate" | "card" | "metal" }

export const MATERIALS: Material[] = [
  { id: "birch", base: [232, 211, 176], burn: [64, 38, 22], kind: "wood" },
  { id: "walnut", base: [128, 84, 54], burn: [36, 20, 11], kind: "wood" },
  { id: "acrylBlack", base: [20, 20, 23], burn: [226, 226, 230], kind: "acrylic" },
  { id: "acrylClear", base: [196, 222, 234], burn: [246, 250, 252], kind: "acrylic" },
  { id: "leather", base: [166, 110, 70], burn: [56, 32, 18], kind: "leather" },
  { id: "slate", base: [58, 63, 68], burn: [205, 205, 205], kind: "slate" },
  { id: "cardboard", base: [201, 168, 121], burn: [72, 46, 26], kind: "card" },
  { id: "anodized", base: [32, 34, 38], burn: [218, 218, 218], kind: "metal" }
];

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
  let seed = m.id.length * 9973;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v: number;
    if (m.kind === "wood") {
      // Maserung: gestreckte, leicht gewellte Jahresringe
      const ring = wave(x, y, 0, 22, 0.9 * wave(x, y, 2, 1, 0) + 0.35 * wave(x, y, 5, 3, 1));
      v = 0.28 * ring * Math.abs(ring) + 0.18 * wave(x, y, 1, 40, 0.5) + 0.06 * (rnd() - 0.5);
    } else if (m.kind === "leather") {
      v = 0.22 * wave(x, y, 31, 17, 0) * wave(x, y, 13, 29, 1) + 0.18 * (rnd() - 0.5);
    } else if (m.kind === "slate") {
      v = 0.16 * wave(x, y, 3, 1, 0) + 0.1 * wave(x, y, 1, 7, 2) + 0.12 * (rnd() - 0.5);
    } else if (m.kind === "card") {
      v = 0.08 * wave(x, y, 0, 64, 0) + 0.14 * (rnd() - 0.5);
    } else if (m.kind === "metal") {
      v = 0.06 * wave(x, y, 0, 128, 0) + 0.05 * (rnd() - 0.5);
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
    const l = laser ? layerForShape(s) : null;
    const key = laser ? (l && layerHasFill(l) ? "L:" + l.id : "") : (!plasma && s.millingMode === "pocket" ? "P" : "");
    if (!key) continue;
    if (!fills.has(key)) fills.set(key, []);
    fills.get(key)!.push(s);
  }
  for (const [key, list] of fills) {
    ctx.beginPath();
    for (const s of list) tracePath(ctx, s, sx, sy, scale);
    ctx.fillStyle = key === "P" ? "rgba(0,0,0,0.35)" : rgb(m.burn, 0.88);
    ctx.fill("evenodd");
  }
  // Linien: gravieren (Brandfarbe) oder schneiden (dunkle Fuge)
  for (const s of shapes) {
    if (s.type === "image") continue;
    const l = laser ? layerForShape(s) : null;
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
