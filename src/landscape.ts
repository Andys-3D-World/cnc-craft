/**
 * LANDSCHAFT als Silhouette – für den Weihnachtsschmuck (zwei Schichten) und die Schattenbox
 *
 * Sanfte Hügel, darauf Tannen (drei Stufen), Häuschen (Satteldach, Schornstein, Fenster und Tür als Löcher,
 * damit Licht durchscheint) oder Geschenke (Päckchen mit Band als Schlitz und Schleife). Alles für CNC Craft gezeichnet, Zufall mit Startwert – dasselbe seed gibt dieselbe
 * Landschaft. Die Silhouette ist ein zusammenhängendes Stück: Bäume und Häuser stehen im Hügel.
 *
 * Nur Geometrie (Tests: tests/landscape.test.ts). Alles in mm, Y nach oben.
 */
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import { unionMany, type XY } from "./nameConnect.ts";

export type SceneKind = "none" | "hills" | "trees" | "village" | "gifts";
export const SCENE_KINDS: SceneKind[] = ["none", "hills", "trees", "village", "gifts"];

export interface SceneOptions {
  x0: number; x1: number;  // Breite der Landschaft
  bottom: number;          // Unterkante (alles darunter ist Material)
  base: number;            // mittlere Höhe der Hügel-Oberkante
  hill: number;            // Höhe der Wellen (± um base)
  item: number;            // Größe von Bäumen/Häusern
  kind: SceneKind;
  seed: number;
  houses?: number;         // Anteil Häuser 0 … 1 (village)
}

export function rng(seed: number) {
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const poly = (r: XY[]): MultiPolygon => [[[...r, r[0]]]];

/** Tanne: drei Stufen und Stamm; unten Mitte bei (x, y), Höhe h */
export function fir(x: number, y: number, h: number): MultiPolygon {
  const w = h * 0.62, s = (u: number, v: number): XY => [x + u * w, y + v * h];
  return poly([s(-0.06, -0.08), s(0.06, -0.08), s(0.06, 0.1), s(0.5, 0.1), s(0.24, 0.42), s(0.38, 0.42), s(0.15, 0.7), s(0.26, 0.7),
    s(0, 1), s(-0.26, 0.7), s(-0.15, 0.7), s(-0.38, 0.42), s(-0.24, 0.42), s(-0.5, 0.1), s(-0.06, 0.1)]);
}

/** Häuschen: unten Mitte bei (x, y), Breite w; Ergebnis: Umriss und Fenster/Tür (als Löcher) */
export function house(x: number, y: number, w: number, r: () => number): { area: MultiPolygon; lights: MultiPolygon } {
  const h = w * (0.7 + r() * 0.35), roof = w * 0.55, x0 = x - w / 2, x1 = x + w / 2, yb = y - w * 0.15;
  const chim = r() < 0.6 ? w * (r() < 0.5 ? -0.25 : 0.22) : null;
  const outline: XY[] = [[x0, yb], [x1, yb], [x1, y + h], [x1 + w * 0.08, y + h], [x, y + h + roof], [x0 - w * 0.08, y + h]];
  let area = poly(outline);
  if (chim !== null) area = polygonClipping.union(area, poly([[x + chim - w * 0.06, y + h + roof * 0.3], [x + chim + w * 0.06, y + h + roof * 0.3],
    [x + chim + w * 0.06, y + h + roof * 0.85], [x + chim - w * 0.06, y + h + roof * 0.85]]));
  const lights: MultiPolygon = [];
  const win = (cx: number, cy: number, s: number) => lights.push(...poly([[cx - s, cy - s], [cx + s, cy - s], [cx + s, cy + s], [cx - s, cy + s]]));
  const ws = w * 0.09;
  // Tür unten, Fenster daneben, ein Fenster im Giebel
  const doorL = r() < 0.5;
  lights.push(...poly([[x + (doorL ? -0.32 : 0.12) * w, y + w * 0.04], [x + (doorL ? -0.12 : 0.32) * w, y + w * 0.04],
    [x + (doorL ? -0.12 : 0.32) * w, y + h * 0.55], [x + (doorL ? -0.32 : 0.12) * w, y + h * 0.55]]));
  win(x + (doorL ? 0.22 : -0.22) * w, y + h * 0.45, ws);
  win(x, y + h + roof * 0.32, ws * 0.85);
  return { area, lights };
}

/** Geschenk: unten Mitte bei (x, y), Breite w; Band als Schlitz (nicht ganz durch, sonst zerfiele es), Schleife oben */
export function gift(x: number, y: number, w: number, r: () => number): { area: MultiPolygon; lights: MultiPolygon } {
  const h = w * (0.65 + r() * 0.35), x0 = x - w / 2, x1 = x + w / 2, yb = y - w * 0.12, lid = w * 0.14;
  const ell = (cx: number, cy: number, rx: number, ry: number, rot: number): XY[] => Array.from({ length: 28 }, (_, i) => {
    const a = (i / 28) * Math.PI * 2, px = rx * Math.cos(a), py = ry * Math.sin(a);
    return [cx + px * Math.cos(rot) - py * Math.sin(rot), cy + px * Math.sin(rot) + py * Math.cos(rot)] as XY;
  });
  // Kasten mit etwas breiterem Deckel, Schleife aus zwei Schlaufen
  let area = polygonClipping.union(poly([[x0, yb], [x1, yb], [x1, y + h - lid], [x0, y + h - lid]]),
    poly([[x0 - w * 0.06, y + h - lid], [x1 + w * 0.06, y + h - lid], [x1 + w * 0.06, y + h], [x0 - w * 0.06, y + h]]));
  const loops = [-1, 1].map(sd => polygonClipping.difference(poly(ell(x + sd * w * 0.16, y + h + w * 0.1, w * 0.17, w * 0.09, sd * 0.5)),
    poly(ell(x + sd * w * 0.16, y + h + w * 0.1, w * 0.09, w * 0.04, sd * 0.5))));
  area = polygonClipping.union(area, ...loops);
  const band = w * 0.05;
  const lights: MultiPolygon = [
    ...poly([[x - band, y + h * 0.12], [x + band, y + h * 0.12], [x + band, y + h - lid - band], [x - band, y + h - lid - band]]),
    ...poly([[x0 + w * 0.12, y + h * 0.45 - band], [x - band * 2.5, y + h * 0.45 - band], [x - band * 2.5, y + h * 0.45 + band], [x0 + w * 0.12, y + h * 0.45 + band]]),
    ...poly([[x + band * 2.5, y + h * 0.45 - band], [x1 - w * 0.12, y + h * 0.45 - band], [x1 - w * 0.12, y + h * 0.45 + band], [x + band * 2.5, y + h * 0.45 + band]]),
  ];
  return { area, lights };
}

/** Oberkante der Hügel (Summe von Sinuswellen mit zufälligen Phasen) */
export function hillLine(o: SceneOptions, r: () => number): (x: number) => number {
  const W = o.x1 - o.x0, waves = [1, 2.3, 4.1].map(f => ({ f, p: r() * Math.PI * 2, a: 1 / f }));
  const sum = waves.reduce((s, w) => s + w.a, 0);
  return (x: number) => o.base + (o.hill * waves.reduce((s, w) => s + w.a * Math.sin(((x - o.x0) / W) * Math.PI * 2 * w.f * 0.5 + w.p), 0)) / sum;
}

/** Landschaft als eine Silhouette + Lichter (Fenster/Türen, schon herausgeschnitten) */
export function scene(o: SceneOptions): { area: MultiPolygon; lights: MultiPolygon } {
  if (o.kind === "none" || !(o.x1 > o.x0)) return { area: [], lights: [] };
  const r = rng(o.seed), top = hillLine(o, r);
  const ground: XY[] = [];
  const n = 60;
  for (let i = 0; i <= n; i++) { const x = o.x0 + ((o.x1 - o.x0) * i) / n; ground.push([x, top(x)]); }
  const parts: MultiPolygon[] = [poly([...ground, [o.x1, o.bottom], [o.x0, o.bottom]])];
  const lights: MultiPolygon = [];
  if (o.kind !== "hills") {
    // Plätze nebeneinander, mit etwas Zufall; Häuser größer als Bäume
    let x = o.x0 + o.item * (0.2 + r() * 0.4);
    while (x < o.x1 - o.item * 0.3) {
      const isHouse = o.kind === "village" && r() < (o.houses ?? 0.4);
      const y = top(x) - o.item * 0.05;
      if (o.kind === "gifts" && r() < 0.65) {
        const w = o.item * (0.42 + r() * 0.18);
        if (x - w / 2 > o.x0 && x + w / 2 < o.x1) {
          const g = gift(x, y, w, r);
          parts.push(g.area);
          lights.push(...g.lights);
          x += w * (1.05 + r() * 0.25);
          continue;
        }
      }
      if (isHouse) {
        const w = o.item * (0.75 + r() * 0.25);
        if (x - w / 2 > o.x0 && x + w / 2 < o.x1) {
          const hs = house(x, y, w, r);
          parts.push(hs.area);
          lights.push(...hs.lights);
          x += w * (1.05 + r() * 0.3);
          continue;
        }
      }
      const h = o.item * (0.7 + r() * 0.6);
      parts.push(fir(x, y, h));
      x += h * (0.38 + r() * 0.35);
    }
  }
  let area = unionMany(parts);
  if (lights.length) area = polygonClipping.difference(area, lights);
  // seitlich nicht über die Breite hinaus (Bäume am Rand werden abgeschnitten)
  area = polygonClipping.intersection(area, poly([[o.x0, o.bottom], [o.x1, o.bottom], [o.x1, o.base + o.hill + o.item * 3], [o.x0, o.base + o.hill + o.item * 3]]));
  return { area, lights };
}
