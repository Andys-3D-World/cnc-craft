/**
 * GROSSES TEIL TEILEN – Bild für die Seite „Zusammenbau“ im Einrichteblatt: das ganze Teil mit seinen Stücken,
 * den Fugen (die Lücke zwischen den Stücken ist die Fuge) und den Namen. Nur Text, ohne Oberfläche (Tests: `npm test`).
 */
import type { MultiPolygon } from "polygon-clipping";

export interface AsmPiece { name: string; region: MultiPolygon; fits: boolean }

/** SVG des ganzen Teils (mm, Y nach oben). `current` = Stück dieses Blattes, wird hervorgehoben */
export function assemblySvg(pieces: AsmPiece[], current: string | null = null): string {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pieces) for (const poly of p.region) for (const [x, y] of poly[0]) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return "";
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1), pad = Math.max(w, h) * 0.03;
  const n = (v: number) => (Math.round(v * 100) / 100).toString();
  const Y = (y: number) => maxY - y;
  const sw = n(Math.max(w, h) / 450);
  let body = "";
  for (const p of pieces) {
    const d = p.region.map(poly => poly.map(ring => "M" + ring.map(([x, y]) => `${n(x)} ${n(Y(y))}`).join("L") + "Z").join("")).join("");
    body += `<path d="${d}" fill="${p.name === current ? "#ffd58a" : "#f1f1f1"}" fill-rule="evenodd" stroke="#111" stroke-width="${sw}" stroke-linejoin="round"/>`;
  }
  // Namen: in die Mitte des größten Teils jedes Stücks, Schrift passend zur kleineren Seite
  for (const p of pieces) {
    let best: { x: number; y: number; s: number } | null = null;
    for (const poly of p.region) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of poly[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const s = (x1 - x0) * (y1 - y0);
      if (!best || s > best.s) best = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, s };
    }
    if (!best) continue;
    const fs = Math.max(Math.min(w, h) / 9, Math.max(w, h) / 40);
    body += `<text x="${n(best.x)}" y="${n(Y(best.y))}" font-size="${n(fs)}" font-family="Arial, sans-serif" font-weight="${p.name === current ? "bold" : "normal"}" text-anchor="middle" dominant-baseline="central" fill="#111">${p.name.replace(/[^A-Z0-9]/g, "")}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(minX - pad)} ${n(-pad)} ${n(w + 2 * pad)} ${n(h + 2 * pad)}" role="img">${body}</svg>`;
}
