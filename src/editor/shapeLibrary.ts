/**
 * FORMEN-BIBLIOTHEK: fertige Formen zum Einfügen (Grundformen, Sterne, Symbole, Maker-Teile)
 *
 * Jede Form ist ein SVG-Pfad in einem 100 × 100-Feld (y nach unten, wie in SVG). Mehrere
 * geschlossene Teilpfade = Löcher (z. B. Ring, Anhänger mit Loch) – der normale SVG-Import
 * erkennt sie und setzt außen/innen. Eingefügt wird in der gewählten Größe mitten aufs Bett.
 * Alle Pfade sind hier selbst gezeichnet oder berechnet – keine fremden Grafiken.
 */
import { t } from "../i18n/i18n";
import { bedSizeMm } from "./editorState";

export interface LibShape { id: string; cat: string; d: string }

const f = (v: number) => String(Math.round(v * 100) / 100);
const poly = (p: number[][]) => "M" + p.map(q => f(q[0]) + " " + f(q[1])).join(" L") + " Z";
const circle = (cx: number, cy: number, r: number) =>
  `M${f(cx - r)} ${f(cy)} A${f(r)} ${f(r)} 0 1 0 ${f(cx + r)} ${f(cy)} A${f(r)} ${f(r)} 0 1 0 ${f(cx - r)} ${f(cy)} Z`;
const ngon = (n: number, r: number, rot = -90) =>
  poly(Array.from({ length: n }, (_, i) => { const a = (rot + (i * 360) / n) * Math.PI / 180; return [50 + r * Math.cos(a), 50 + r * Math.sin(a)]; }));
const star = (n: number, r1: number, r2: number) =>
  poly(Array.from({ length: n * 2 }, (_, i) => { const a = (-90 + (i * 180) / n) * Math.PI / 180, r = i % 2 ? r2 : r1; return [50 + r * Math.cos(a), 50 + r * Math.sin(a)]; }));
/** Kurve in Polarform r(θ) */
const polar = (r: (a: number) => number, steps = 240) =>
  poly(Array.from({ length: steps }, (_, i) => { const a = (i / steps) * Math.PI * 2; return [50 + r(a) * Math.cos(a), 50 + r(a) * Math.sin(a)]; }));
const roundRect = (x0: number, y0: number, x1: number, y1: number, r: number) =>
  `M${f(x0 + r)} ${f(y0)} L${f(x1 - r)} ${f(y0)} A${f(r)} ${f(r)} 0 0 1 ${f(x1)} ${f(y0 + r)} L${f(x1)} ${f(y1 - r)} A${f(r)} ${f(r)} 0 0 1 ${f(x1 - r)} ${f(y1)} `
  + `L${f(x0 + r)} ${f(y1)} A${f(r)} ${f(r)} 0 0 1 ${f(x0)} ${f(y1 - r)} L${f(x0)} ${f(y0 + r)} A${f(r)} ${f(r)} 0 0 1 ${f(x0 + r)} ${f(y0)} Z`;

function gear(teeth: number, ro: number, ri: number, hole: number): string {
  const pts: number[][] = [];
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2, w = (Math.PI * 2) / teeth;
    for (const [da, r] of [[0, ri], [0.18, ri], [0.3, ro], [0.62, ro], [0.74, ri]] as const) {
      const b = a + da * w;
      pts.push([50 + r * Math.cos(b), 50 + r * Math.sin(b)]);
    }
  }
  return poly(pts) + " " + circle(50, 50, hole);
}

export const SHAPES: LibShape[] = [
  // ---- Grundformen ----
  { id: "circle", cat: "basic", d: circle(50, 50, 46) },
  { id: "square", cat: "basic", d: poly([[6, 6], [94, 6], [94, 94], [6, 94]]) },
  { id: "roundSquare", cat: "basic", d: roundRect(6, 6, 94, 94, 16) },
  { id: "triangle", cat: "basic", d: poly([[50, 6], [96, 88], [4, 88]]) },
  { id: "pentagon", cat: "basic", d: ngon(5, 47) },
  { id: "hexagon", cat: "basic", d: ngon(6, 47, 0) },
  { id: "octagon", cat: "basic", d: ngon(8, 47, 22.5) },
  { id: "diamond", cat: "basic", d: poly([[50, 4], [86, 50], [50, 96], [14, 50]]) },
  { id: "ring", cat: "basic", d: circle(50, 50, 46) + " " + circle(50, 50, 28) },
  { id: "semicircle", cat: "basic", d: "M4 72 A46 46 0 0 1 96 72 Z" },
  { id: "plus", cat: "basic", d: poly([[36, 6], [64, 6], [64, 36], [94, 36], [94, 64], [64, 64], [64, 94], [36, 94], [36, 64], [6, 64], [6, 36], [36, 36]]) },
  { id: "frame", cat: "basic", d: roundRect(4, 4, 96, 96, 10) + " " + roundRect(18, 18, 82, 82, 5) },
  // ---- Sterne & Abzeichen ----
  { id: "star5", cat: "stars", d: star(5, 48, 19) },
  { id: "star6", cat: "stars", d: star(6, 48, 26) },
  { id: "star8", cat: "stars", d: star(8, 48, 30) },
  { id: "star12", cat: "stars", d: star(12, 48, 16) },
  { id: "burst", cat: "stars", d: star(16, 48, 37) },
  { id: "seal", cat: "stars", d: polar(a => 43 + 5 * Math.cos(24 * a), 480) },
  { id: "shield", cat: "stars", d: "M50 4 L92 16 L92 46 C92 72 72 88 50 96 C28 88 8 72 8 46 L8 16 Z" },
  { id: "banner", cat: "stars", d: poly([[2, 30], [20, 30], [20, 22], [80, 22], [80, 30], [98, 30], [88, 48], [98, 66], [80, 66], [80, 74], [20, 74], [20, 66], [2, 66], [12, 48]]) },
  // ---- Symbole ----
  { id: "heart", cat: "symbols", d: "M50 90 C20 68 4 52 4 31 C4 15 16 5 30 5 C40 5 47 11 50 19 C53 11 60 5 70 5 C84 5 96 15 96 31 C96 52 80 68 50 90 Z" },
  { id: "arrow", cat: "symbols", d: poly([[4, 38], [58, 38], [58, 16], [96, 50], [58, 84], [58, 62], [4, 62]]) },
  { id: "arrow2", cat: "symbols", d: poly([[4, 50], [28, 22], [28, 38], [72, 38], [72, 22], [96, 50], [72, 78], [72, 62], [28, 62], [28, 78]]) },
  { id: "chevron", cat: "symbols", d: poly([[20, 4], [50, 4], [86, 50], [50, 96], [20, 96], [56, 50]]) },
  { id: "check", cat: "symbols", d: poly([[6, 52], [20, 38], [40, 58], [80, 18], [94, 32], [40, 86]]) },
  { id: "bolt", cat: "symbols", d: poly([[60, 2], [18, 56], [46, 56], [38, 98], [82, 40], [54, 40], [68, 2]]) },
  { id: "drop", cat: "symbols", d: "M50 4 C50 4 16 46 16 64 A34 34 0 0 0 84 64 C84 46 50 4 50 4 Z" },
  { id: "moon", cat: "symbols", d: "M58 6 A44 44 0 1 0 94 72 A36 36 0 1 1 58 6 Z" },
  { id: "cloud", cat: "symbols", d: "M26 80 A18 18 0 0 1 22 44 A22 22 0 0 1 60 28 A20 20 0 0 1 92 52 A15 15 0 0 1 80 80 Z" },
  { id: "bubble", cat: "symbols", d: "M14 10 L86 10 A10 10 0 0 1 96 20 L96 62 A10 10 0 0 1 86 72 L42 72 L22 92 L26 72 L14 72 A10 10 0 0 1 4 62 L4 20 A10 10 0 0 1 14 10 Z" },
  { id: "house", cat: "symbols", d: poly([[50, 4], [96, 44], [84, 44], [84, 96], [16, 96], [16, 44], [4, 44]]) + " " + poly([[42, 54], [58, 54], [58, 70], [42, 70]]) },
  { id: "gear", cat: "symbols", d: gear(12, 48, 39, 13) },
  { id: "flower", cat: "symbols", d: polar(a => 22 + 26 * Math.abs(Math.cos(2.5 * a + Math.PI / 4)), 360) + " " + circle(50, 50, 8) },
  { id: "leaf", cat: "symbols", d: "M8 92 C8 40 40 8 92 8 C92 60 60 92 8 92 Z" },
  { id: "paw", cat: "symbols", d: "M50 50 C68 50 82 70 78 84 C75 94 62 90 50 90 C38 90 25 94 22 84 C18 70 32 50 50 50 Z "
      + circle(22, 40, 10) + " " + circle(40, 22, 10) + " " + circle(60, 22, 10) + " " + circle(78, 40, 10) },
  { id: "tree", cat: "symbols", d: poly([[50, 2], [80, 34], [66, 34], [88, 62], [70, 62], [94, 86], [58, 86], [58, 98], [42, 98], [42, 86], [6, 86], [30, 62], [12, 62], [34, 34], [20, 34]]) },
  // ---- Maker-Teile ----
  { id: "tag", cat: "maker", d: poly([[30, 14], [96, 14], [96, 86], [30, 86], [4, 50]]) + " " + circle(26, 50, 6) },
  { id: "keychain", cat: "maker", d: roundRect(4, 24, 96, 76, 26) + " " + circle(22, 50, 7) },
  { id: "coaster", cat: "maker", d: polar(a => 46 + 3.5 * Math.cos(16 * a), 480) },
  { id: "puzzle", cat: "maker", d: "M20 20 L42 20 A10 10 0 1 1 58 20 L80 20 L80 42 A10 10 0 1 1 80 58 L80 80 L58 80 A10 10 0 1 0 42 80 L20 80 L20 58 A10 10 0 1 0 20 42 Z" },
  { id: "plate", cat: "maker", d: roundRect(4, 14, 96, 86, 8) + " " + circle(14, 24, 3.5) + " " + circle(86, 24, 3.5) + " " + circle(14, 76, 3.5) + " " + circle(86, 76, 3.5) },
  { id: "bracket", cat: "maker", d: poly([[6, 6], [30, 6], [30, 70], [94, 70], [94, 94], [6, 94]]) + " " + circle(18, 24, 5) + " " + circle(76, 82, 5) },
];

export const CATS = ["basic", "stars", "symbols", "maker"];

/** Kleines Vorschaubild (eigene Pfade, keine fremden Daten) */
export function shapeSvg(s: LibShape, size = 46): string {
  return `<svg viewBox="-2 -2 104 104" width="${size}" height="${size}"><path d="${s.d}" fill="currentColor" fill-opacity="0.18" fill-rule="evenodd" stroke="currentColor" stroke-width="2.5"/></svg>`;
}

/** Umriss eines Pfads (vom Browser gemessen, Bögen und Kurven genau) */
function pathBox(d: string): { x: number; y: number; w: number; h: number } {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("style", "position:absolute;left:-9999px;width:0;height:0;");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  svg.appendChild(p);
  document.body.appendChild(svg);
  try {
    const b = p.getBBox();
    return b.width > 0 ? { x: b.x, y: b.y, w: b.width, h: b.height } : { x: 0, y: 0, w: 100, h: 100 };
  } finally { svg.remove(); }
}

/** SVG-Datei: Form mit sizeMm Breite mitten auf dem Bett */
export function shapeFile(s: LibShape, sizeMm: number): string {
  const bed = bedSizeMm();
  const b = pathBox(s.d);
  const k = sizeMm / b.w;
  const tx = bed.w / 2 - (b.x + b.w / 2) * k, ty = bed.h / 2 - (b.y + b.h / 2) * k;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${bed.w}mm" height="${bed.h}mm" viewBox="0 0 ${bed.w} ${bed.h}">`
    + `<path transform="translate(${f(tx)} ${f(ty)}) scale(${k})" d="${s.d}" fill="none" stroke="black"/></svg>`;
}

export function shapeName(s: LibShape): string { return t("sl." + s.id); }

// =====================================================================
// FENSTER: Form anklicken = einfügen
// =====================================================================

const KEY_SIZE = "cnc_craft_shape_lib_size";

export function openShapeLibrary(log: (s: string) => void) {
  document.getElementById("sl-dialog-overlay")?.remove();
  let size = 50;
  try { const v = parseFloat(localStorage.getItem(KEY_SIZE) || ""); if (v > 0) size = v; } catch { /* egal */ }
  let cat = CATS[0];
  const ov = document.createElement("div");
  ov.id = "sl-dialog-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:560px;">
      <h3>🔷 ${t("sl.title")}</h3>
      <div class="sl-cats">${CATS.map(c => `<button type="button" class="sl-cat" data-cat="${c}">${t("sl.cat." + c)}</button>`).join("")}</div>
      <div class="sl-grid" id="sl-grid"></div>
      <label class="prop-row">${t("sl.size")}<input type="number" id="sl-size" min="1" step="1" class="prop-input" value="${size}"></label>
      <div class="dlg-hint">${t("sl.hint")}</div>
      <div class="dlg-buttons"><button id="sl-close" class="btn-secondary" style="margin-left:auto;">${t("dlg.close")}</button></div>
    </div>`;
  document.body.appendChild(ov);
  const grid = ov.querySelector("#sl-grid") as HTMLElement;
  const render = () => {
    ov.querySelectorAll<HTMLElement>(".sl-cat").forEach(b => b.classList.toggle("active", b.dataset.cat === cat));
    grid.innerHTML = SHAPES.filter(s => s.cat === cat)
      .map(s => `<button type="button" class="sl-item" data-id="${s.id}" title="${shapeName(s)}">${shapeSvg(s)}<span>${shapeName(s)}</span></button>`).join("");
  };
  ov.querySelector(".sl-cats")!.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-cat]");
    if (b) { cat = b.dataset.cat!; render(); }
  });
  const sizeIn = ov.querySelector("#sl-size") as HTMLInputElement;
  sizeIn.addEventListener("change", () => {
    const v = parseFloat(sizeIn.value);
    if (v > 0) { size = v; try { localStorage.setItem(KEY_SIZE, String(v)); } catch { /* egal */ } } else sizeIn.value = String(size);
  });
  const close = () => ov.remove();
  grid.addEventListener("click", async e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    const s = b && SHAPES.find(x => x.id === b.dataset.id);
    if (!s) return;
    const { importBytes } = await import("../importers/importManager");
    await importBytes(shapeName(s).replace(/[^\p{L}\p{N} _-]/gu, "") + ".svg", new TextEncoder().encode(shapeFile(s, size)));
    log(t("sl.inserted", { name: shapeName(s), size }));
    close();
  });
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  (ov.querySelector("#sl-close") as HTMLElement).onclick = close;
  render();
}
