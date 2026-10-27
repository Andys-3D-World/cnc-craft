/**
 * LASER-G-CODE (wie LightBurn, für GRBL im Laser-Modus $32=1)
 *
 * - Ebenen werden in der Reihenfolge der Ebenen-Liste gelasert (oben zuerst).
 * - "Füllen": waagerechte Scanlinien (gedreht um den Ebenen-Winkel) im Abstand "Linienabstand",
 *   abwechselnd hin und zurück. Alle geschlossenen Formen einer Ebene werden zusammen
 *   gefüllt (gerade/ungerade-Regel) -> Löcher in Buchstaben bleiben frei.
 * - "Linie": jede Kontur wird abgefahren, kleine/innere Konturen zuerst (Teile fallen
 *   sonst heraus, bevor ihre Löcher geschnitten sind). Mit "Reihenfolge optimieren" in der
 *   Reihenfolge mit den kürzesten Leerfahrten (Innenleben weiter zuerst, siehe cutOrder.ts).
 * - Bilder (Bildgravur): Zeile für Zeile, abwechselnd hin und zurück, vor allen Konturen der Ebene
 *   (siehe raster/imageShape.ts). Gerastert = Laser an/aus, Graustufen = Leistung folgt der Helligkeit.
 * - Leistung: S = Leistung% × S-Max ($30). M4 = dynamische Leistung (empfohlen),
 *   M3 = konstante Leistung. Bei jeder Leerfahrt steht zusätzlich S0 (Sicherheit).
 */
import { MM_TO_PIXEL, shapeToPaths, Pt } from "./shapeTransform";
import { polygonArea, pointInPoly } from "./polyOffset";
import { cornerIndex, leadPoint } from "./plasmaCam";
import { tabRuns } from "./tabs";
import { RapidPlanner } from "./rapidAvoid";
import { optimizeCutOrder, travelLength, orientPts, CutItem } from "./cutOrder";
import {
  getLayers, effectiveLayer, laserSettings, layerHasFill, layerHasLine, LaserLayer
} from "./laserLayers";
import { t, ascii } from "./i18n/i18n";
import { imageGcode } from "./raster/imageShape";

const MAX_SCANLINES = 40000; // Schutz vor riesigen Dateien
const AVOID_MARGIN = 3;      // mm Abstand der Leerfahrt-Umwege zu ausgeschnittenen Teilen

export function generateLaserGcode(shapes: any[]): { gcode: string | null; warnings: string[] } {
  const warnings: string[] = [];
  if (!shapes.length) return { gcode: null, warnings };

  const c = (key: string, p?: Record<string, string | number>) => `(${ascii(t(key, p))})`;
  const n = (v: number) => String(+v.toFixed(3));
  const sOf = (power: number) => Math.round((power / 100) * laserSettings.sMax);

  // ---- Formen nach Ebene sortieren (Reihenfolge wie in der Ebenen-Liste) ----
  // Formen mit eigenen Werten (Material-Testraster) bilden eigene Blöcke direkt hinter ihrer Ebene
  const byLayer = new Map<string, any[]>();
  const layerById = new Map<string, LaserLayer>();
  for (const s of shapes) {
    const l = effectiveLayer(s);
    if (!l) continue;
    if (!byLayer.has(l.id)) { byLayer.set(l.id, []); layerById.set(l.id, l); }
    byLayer.get(l.id)!.push(s);
  }
  const rank = new Map(getLayers().map((l, i) => [l.id, i]));
  const order = [...layerById.values()].sort((a, b) => (rank.get(a.id.split("~")[0]) ?? 0) - (rank.get(b.id.split("~")[0]) ?? 0));

  let g = "";
  g += `G21 ${c("gc.unitMm")}\n`;
  g += `G90 ${c("gc.absolute")}\n`;
  g += `${c("lgc.header", { n: order.length, s: laserSettings.sMax })}\n`;
  g += `${laserSettings.dynamic ? "M4" : "M3"} S0 ${c(laserSettings.dynamic ? "lgc.m4" : "lgc.m3")}\n`;

  // Leerfahrten (Linien-Modus) um schon ausgeschnittene Teile herum (sie können kippen)
  const avoid = laserSettings.avoidCut ? new RapidPlanner(AVOID_MARGIN) : null;
  let pos: Pt | null = null;
  const rapid = (to: Pt, note = "") => {
    if (avoid && pos) for (const v of avoid.route(pos, to)) g += `G0 X${n(v.x)} Y${n(v.y)} S0 ${c("gc.avoid")}\n`;
    g += `G0 X${n(to.x)} Y${n(to.y)} S0${note}\n`;
    pos = to;
  };

  order.forEach((layer, li) => {
    const list = byLayer.get(layer.id)!;
    // „Füllen + Linie“: Fläche und Linie haben eigene Leistung/Geschwindigkeit (z. B. leicht gravieren, kräftig schneiden)
    const both = layer.mode === "fill+line";
    const S = sOf(layer.power);
    const fillS = both ? sOf(layer.fillPower) : S;
    const fillF = both ? layer.fillSpeed : layer.speed;
    g += `\n${c("lgc.layer", { i: li + 1, name: layer.name, mode: t("laser.mode." + layer.mode), p: layer.power, f: layer.speed, x: layer.passes })}\n`;
    if (layer.air) g += `M8 ${c("lgc.airOn")}\n`;
    g += `F${n(layer.speed)}\n`;

    // ---- BILDER (zuerst gravieren, dann schneiden) ----
    for (const s of list) {
      if (s.type !== "image") continue;
      const r = imageGcode(s, S, n);
      if (!r) { warnings.push(t("lgw.imageLoading", { name: ascii(s.source || "") })); continue; }
      if (!r.rows) continue;
      for (let pass = 0; pass < layer.passes; pass++) {
        g += `${c("lgc.image", { name: s.source || "", rows: r.rows })}\n`;
        if (both) g += `F${n(fillF)}\n`;
        g += r.g;
      }
      pos = null; // Position nach dem Bild unbekannt -> nächste Leerfahrt gerade
      if (both) g += `F${n(layer.speed)}\n`;
    }

    // Pfade in mm
    const closed: Pt[][] = [];
    const closedShape = new Map<Pt[], any>(); // zu welcher Form gehört die Kontur (für Haltestege)
    const open: Pt[][] = [];
    for (const s of list) {
      for (const p of shapeToPaths(s)) {
        if (p.pts.length < 2) continue;
        const pts = p.pts.map(q => ({ x: q.x / MM_TO_PIXEL, y: q.y / MM_TO_PIXEL }));
        (p.closed ? closed : open).push(pts);
        if (p.closed) closedShape.set(pts, s);
      }
    }

    // ---- FÜLLEN ----
    if (layerHasFill(layer)) {
      if (open.length) warnings.push(t("lgw.openNoFill", { name: layer.name, n: open.length }));
      if (closed.length) {
        const res = hatch(closed, layer.interval, layer.angle);
        if (res.clipped) warnings.push(t("lgw.tooManyLines", { name: layer.name, max: MAX_SCANLINES }));
        for (let pass = 0; pass < layer.passes; pass++) {
          if (layer.passes > 1) g += `${c("lgc.pass", { i: pass + 1, n: layer.passes })}\n`;
          g += `${c("lgc.fill", { n: res.segs.length })}\n`;
          if (both) g += `F${n(fillF)}\n`;
          for (const sg of res.segs) {
            g += `G0 X${n(sg[0])} Y${n(sg[1])} S0\n`;
            g += `G1 X${n(sg[2])} Y${n(sg[3])} S${fillS}\n`;
          }
          const last = res.segs[res.segs.length - 1];
          if (last) pos = { x: last[2], y: last[3] };
        }
      }
    }

    // ---- LINIE ----
    if (layerHasLine(layer)) {
      // kleine (innere) Konturen zuerst, offene Linien ganz am Anfang
      // Haltestege: Kontur in Stücke, dazwischen Laser aus (das Teil bleibt im Blech hängen)
      const paths: { pts: Pt[]; closed: boolean; area: number; lead: Pt | null; runs: Pt[][] | null }[] = [
        ...open.map(pts => ({ pts, closed: false, area: 0, lead: null, runs: null })),
        ...closed.map(pts => {
          const lp = withLeadIn(pts, closed, layer.leadIn);
          const shape = closedShape.get(pts);
          const tr = shape ? tabRuns(shape, lp.pts, q => ({ x: q.x / MM_TO_PIXEL, y: q.y / MM_TO_PIXEL }), Number(shape.tabLen) || 0) : null;
          return { ...lp, lead: tr?.rotated ? null : lp.lead, runs: tr ? tr.runs : null, closed: true, area: Math.abs(polygonArea(pts)) };
        }).sort((a, b) => a.area - b.area)
      ];
      // kürzeste Leerfahrten (Löcher bleiben vor ihrem Teil, siehe cutOrder.ts)
      if (laserSettings.optimizeOrder && paths.length > 1) {
        const items: CutItem[] = paths.map(p => {
          if (p.runs) return { entry: p.lead || p.runs[0][0], exit: lastOf(p.runs[p.runs.length - 1]), pts: p.pts, closed: true };
          if (!p.closed) return { entry: p.pts[0], exit: lastOf(p.pts), pts: p.pts, closed: false, reversible: true };
          if (p.lead) return { entry: p.lead, exit: p.pts[0], pts: p.pts, closed: true };
          return { entry: p.pts[0], exit: p.pts[0], pts: p.pts, closed: true, freeStart: true };
        });
        const from = pos || { x: 0, y: 0 };
        const steps = optimizeCutOrder(items, from);
        const before = travelLength(items, items.map((_, i) => ({ index: i, reversed: false, start: 0 })), from);
        const after = travelLength(items, steps, from);
        g += `${c("gc.orderOpt", { a: Math.round(before), b: Math.round(after) })}\n`;
        paths.splice(0, paths.length, ...steps.map(st => ({ ...paths[st.index], pts: orientPts(items[st.index], st) })));
      }
      if (both) g += `F${n(layer.speed)}\n`; // nach dem Füllen wieder die Linien-Geschwindigkeit
      for (let pass = 0; pass < layer.passes; pass++) {
        if (layer.passes > 1) g += `${c("lgc.pass", { i: pass + 1, n: layer.passes })}\n`;
        for (const p of paths) {
          if (p.runs) {
            // mit Haltestegen: jedes Stück schneiden, über den Steg mit Laser aus springen
            p.runs.forEach((run, ri) => {
              if (ri === 0 && p.lead) {
                rapid(p.lead, " " + c("lgc.leadIn"));
                g += `G1 X${n(run[0].x)} Y${n(run[0].y)} S${S}\n`;
              } else {
                rapid(run[0], ri > 0 ? " " + c("gc.tab") : "");
              }
              g += `G1 X${n(run[1].x)} Y${n(run[1].y)} S${S}\n`;
              for (let i = 2; i < run.length; i++) g += `G1 X${n(run[i].x)} Y${n(run[i].y)}\n`;
              pos = run[run.length - 1];
            });
            continue;
          }
          const pts = p.pts;
          // Freischnitt: im Abfall einstechen und zur Kontur fahren
          if (p.lead) {
            rapid(p.lead, " " + c("lgc.leadIn"));
            g += `G1 X${n(pts[0].x)} Y${n(pts[0].y)} S${S}\n`;
          } else {
            rapid(pts[0]);
          }
          g += `G1 X${n(pts[1].x)} Y${n(pts[1].y)} S${S}\n`;
          for (let i = 2; i < pts.length; i++) g += `G1 X${n(pts[i].x)} Y${n(pts[i].y)}\n`;
          if (p.closed) g += `G1 X${n(pts[0].x)} Y${n(pts[0].y)}\n`;
          pos = p.closed ? pts[0] : pts[pts.length - 1];
          // ganz ausgeschnitten (ohne Haltestege) -> kann kippen, ab jetzt umfahren (einmal reicht)
          if (avoid && p.closed && pass === 0) avoid.addCut(pts);
        }
      }
    }
    if (layer.air) g += `M9 ${c("lgc.airOff")}\n`;
  });

  g += `\nS0\nM5 ${c("lgc.laserOff")}\n`;
  rapid({ x: 0, y: 0 }, " " + c("gc.park"));
  g += `M30 ${c("gc.end")}\n`;
  return { gcode: g, warnings };
}

const lastOf = (pts: Pt[]) => pts[pts.length - 1];

/**
 * Freischnitt (Lead-in) für eine geschlossene Kontur: Start an der schärfsten Ecke, Einstich
 * "len" mm daneben im Abfall. Liegt die Kontur in einer ungeraden Anzahl anderer Konturen, ist sie
 * ein Loch -> Einstich im Loch, sonst außerhalb des Teils.
 */
function withLeadIn(pts: Pt[], all: Pt[][], len: number): { pts: Pt[]; lead: Pt | null } {
  if (!(len > 0) || pts.length < 3) return { pts, lead: null };
  let loop = pts;
  const a = loop[0], z = loop[loop.length - 1];
  if (Math.hypot(a.x - z.x, a.y - z.y) < 1e-6) loop = loop.slice(0, -1);
  if (loop.length < 3) return { pts, lead: null };
  let depth = 0;
  for (const o of all) if (o !== pts && pointInPoly(loop[0].x, loop[0].y, o)) depth++;
  const si = cornerIndex(loop);
  loop = loop.slice(si).concat(loop.slice(0, si));
  return { pts: loop, lead: leadPoint(loop, depth % 2 === 0, len) };
}

/**
 * Scanlinien-Füllung (gerade/ungerade-Regel) für mehrere geschlossene Konturen.
 * Rückgabe: Strecken [x0, y0, x1, y1] in Fahr-Reihenfolge (abwechselnd hin und zurück).
 */
export function hatch(polys: Pt[][], interval: number, angleDeg: number): { segs: number[][]; clipped: boolean } {
  const a = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  // ins gedrehte System (Scanlinien dort waagerecht)
  const rot = (p: Pt) => ({ x: p.x * ca + p.y * sa, y: -p.x * sa + p.y * ca });
  const back = (x: number, y: number) => [x * ca - y * sa, x * sa + y * ca];

  interface Edge { y0: number; y1: number; x0: number; dxdy: number }
  const edges: Edge[] = [];
  let minY = Infinity, maxY = -Infinity;
  for (const poly of polys) {
    const r = poly.map(rot);
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      if (p.y === q.y) continue; // waagerecht: trägt nichts bei
      const lo = p.y < q.y ? p : q, hi = p.y < q.y ? q : p;
      edges.push({ y0: lo.y, y1: hi.y, x0: lo.x, dxdy: (hi.x - lo.x) / (hi.y - lo.y) });
      if (lo.y < minY) minY = lo.y;
      if (hi.y > maxY) maxY = hi.y;
    }
  }
  const segs: number[][] = [];
  if (!edges.length || !(interval > 0)) return { segs, clipped: false };
  edges.sort((e, f) => e.y0 - f.y0);

  let lines = Math.floor((maxY - minY) / interval);
  let step = interval;
  let clipped = false;
  if (lines > MAX_SCANLINES) { clipped = true; step = (maxY - minY) / MAX_SCANLINES; lines = MAX_SCANLINES; }

  let next = 0;
  let active: Edge[] = [];
  let row = 0;
  for (let y = minY + step / 2; y < maxY; y += step) {
    while (next < edges.length && edges[next].y0 <= y) active.push(edges[next++]);
    active = active.filter(e => e.y1 > y);
    const xs: number[] = [];
    for (const e of active) if (e.y0 <= y) xs.push(e.x0 + (y - e.y0) * e.dxdy);
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const rowSegs: number[][] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] < 1e-6) continue;
      rowSegs.push([xs[i], xs[i + 1]]);
    }
    if (!rowSegs.length) continue;
    // abwechselnd hin und zurück (spart Leerfahrten)
    const rev = row % 2 === 1;
    if (rev) rowSegs.reverse();
    for (const [x0, x1] of rowSegs) {
      const [ax, ay] = back(rev ? x1 : x0, y);
      const [bx, by] = back(rev ? x0 : x1, y);
      segs.push([ax, ay, bx, by]);
    }
    row++;
  }
  return { segs, clipped };
}
