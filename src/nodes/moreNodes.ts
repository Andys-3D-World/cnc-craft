/**
 * WEITERE KNOTEN – Bausteine für Funktionen, die nach dem ersten Knotengraph dazugekommen sind:
 * Generatoren (Text, Stern, Formen-Bibliothek, Zahnrad, Mandala, Puzzle, Lüftungsgitter, Biegemuster)
 * und Bearbeitungen (Kopien im Kreis, Kopien auf einem Pfad, Perforieren, Dogbones, Vereinfachen, Rahmen,
 * Filter, Größe messen).
 *
 * Wie in nodeDefs.ts: jeder Knoten ruft die Funktion auf, die auch das Fenster im Programm benutzt, arbeitet auf
 * Kopien und legt neue Formen mit der linken unteren Ecke auf den Nullpunkt.
 * Kein Knoten hier spricht mit der Maschine.
 */
import type { NodeDef } from "./graph";
import { PX, num, clamp, fresh, mmShape, toOrigin } from "./nodeUtil";
import {
  createPolyline, groupBounds, translateShape, rotateShape, shapeToPaths, updatePolylineBounds, makeRectPoints,
  makeEllipsePoints, pathArea, pointInPath, newId, Pt
} from "../shapeTransform";
import { toShapes } from "../editor/shapeOps";
import { polarPlacements } from "../editor/arrayGeom";
import { perforate, spotsOnPath } from "../editor/perforate";
import { simplifyPath } from "../editor/simplify";
import { gear } from "../gear";
import { mandala, MANDALA_EDGES, MANDALA_CENTERS, MOTIFS } from "../mandala";
import { puzzle, PUZZLE_SHAPES } from "../puzzle";
import { vent, VENT_PATTERNS } from "../vent";
import { livingHinge, suggestForThickness, HINGE_PATTERNS } from "../livingHinge";
import { BUNDLED, FALLBACK_FONT } from "../editor/fonts";
import { t } from "../i18n/i18n";

/** höchstens so viele Formen aus einem Knoten (wie bei den Raster-Kopien) */
const MAX_OUT = 20000;

const opts = (list: readonly string[], prefix: string) => () => list.map(v => ({ value: v, label: t(prefix + v) }));

/** Löcher erkennen: eine Kontur, die in ungerade vielen größeren liegt, wird innen geschnitten */
function nestedModes(loops: Pt[][]): string[] {
  const areas = loops.map(l => Math.abs(pathArea(l)));
  return loops.map((l, a) => {
    let depth = 0;
    loops.forEach((o, b) => { if (b !== a && areas[b] > areas[a] && pointInPath(l[0].x, l[0].y, o)) depth++; });
    return depth % 2 === 1 ? "inside" : "outside";
  });
}

export const MORE_NODES: NodeDef[] = [
  // -------------------------------------------------------------------
  // Quellen
  // -------------------------------------------------------------------
  {
    type: "text", cat: "source", icon: "🔤",
    inputs: [], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "text", kind: "text", def: "CNC Craft" },
      { key: "font", kind: "select", def: FALLBACK_FONT, label: "text.font", options: () => BUNDLED.map(b => ({ value: b.family, label: b.family })) },
      { key: "size", kind: "number", def: 20, min: 0.5, step: 1, port: true, label: "text.height" },
      { key: "bold", kind: "check", def: false, label: "text.bold" },
      { key: "spacing", kind: "number", def: 0, step: 0.1, port: true, label: "text.letterSpacing" }
    ],
    run: async (_i, p, ctx) => {
      const text = String(p.text ?? "");
      if (!text.trim()) { ctx.warn("ng.w.noText"); return { shapes: [] }; }
      // erst hier laden: das Text-Werkzeug braucht die Oberfläche (Schriften, Zeichenfläche)
      const tt = await import("../editor/textTool");
      const font = BUNDLED.some(b => b.family === p.font) ? p.font : FALLBACK_FONT;
      const params = { ...tt.TEXT_DEFAULTS, text, font, heightMm: Math.max(0.5, num(p.size, 20)), bold: !!p.bold, letterSpacing: num(p.spacing) };
      const r = await tt.traceTextWithFont(params);
      if (r.missing) ctx.warn("text.fontMissingShort");
      return { shapes: toOrigin(tt.textShapes(params, r.traced, 0, 0, null)) };
    }
  },
  {
    type: "star", cat: "source", icon: "★",
    inputs: [], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "points", kind: "number", def: 5, min: 3, max: 64, step: 1, port: true },
      { key: "d", kind: "number", def: 60, min: 0.1, step: 1, port: true },
      { key: "inner", kind: "number", def: 45, min: 5, max: 100, step: 5, port: true }
    ],
    run: (_i, p) => {
      const n = Math.round(clamp(num(p.points, 5), 3, 64)), R = Math.max(0.05, num(p.d, 60) / 2) * PX;
      const r = R * clamp(num(p.inner, 45), 5, 100) / 100;
      const pts: Pt[] = [];
      for (let k = 0; k < n * 2; k++) {
        const a = Math.PI / 2 + (k * Math.PI) / n, q = k % 2 ? r : R;
        pts.push({ x: R + q * Math.cos(a), y: R + q * Math.sin(a) });
      }
      return { shapes: toOrigin([createPolyline(pts, true, "outside")]) };
    }
  },
  {
    type: "libShape", cat: "source", icon: "🔷",
    inputs: [], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "shape", kind: "select", def: "heart", options: () => libList().map(s => ({ value: s.id, label: t("sl." + s.id) })) },
      { key: "size", kind: "number", def: 50, min: 1, step: 5, port: true, label: "ng.p.libSize" }
    ],
    run: async (_i, p, ctx) => {
      const lib = await loadLib();
      const s = lib.shapes.find(x => x.id === p.shape);
      if (!s) { ctx.warn("ng.w.noShape"); return { shapes: [] }; }
      // Die Vorlagen stehen in einem Feld von 100 × 100 Einheiten, Y nach unten
      const k = (Math.max(1, num(p.size, 50)) / 100) * PX;
      const loops = lib.parse(s.d, 0.05).filter(q => q.pts.length >= 3).map(q => q.pts.map(c => ({ x: c.x * k, y: (100 - c.y) * k })));
      const modes = nestedModes(loops);
      const gid = loops.length > 1 ? "grp-" + newId() : undefined;
      return { shapes: toOrigin(loops.map((l, i) => createPolyline(l, true, modes[i], gid ? { groupId: gid } : {}))) };
    }
  },

  // -------------------------------------------------------------------
  // Generatoren
  // -------------------------------------------------------------------
  {
    type: "gear", cat: "gen", icon: "⚙",
    inputs: [], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "teeth", kind: "number", def: 20, min: 6, max: 300, step: 1, port: true, label: "gear.teeth" },
      { key: "module", kind: "number", def: 2, min: 0.2, max: 20, step: 0.5, port: true, label: "gear.module" },
      { key: "bore", kind: "number", def: 6, min: 0, step: 1, port: true },
      { key: "holes", kind: "number", def: 0, min: 0, max: 12, step: 1, label: "gear.holes" }
    ],
    run: (_i, p, ctx) => {
      const bore = Math.max(0, num(p.bore));
      const r = gear({
        teeth: Math.round(clamp(num(p.teeth, 20), 6, 300)), module: clamp(num(p.module, 2), 0.2, 20), pressureAngle: 20, backlash: 0.1, shift: 0,
        bore: bore > 0 ? "round" : "none", boreD: bore, keyAuto: true, keyW: 3, keyDepth: 1.4, flat: 4.5,
        holes: Math.round(clamp(num(p.holes), 0, 12)), pair: false, teeth2: 40
      });
      if (r.warnings.length) ctx.warn(r.warnings[0], { x: Math.max(0, r.undercutX).toFixed(2) });
      const area = r.gears[0].area.map(poly => poly.map(ring => ring.map(([x, y]) => [x * PX, y * PX] as [number, number])));
      return { shapes: toOrigin(toShapes(area, null)) };
    }
  },
  {
    type: "mandala", cat: "gen", icon: "❂",
    inputs: [], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "d", kind: "number", def: 150, min: 20, step: 10, port: true },
      { key: "sym", kind: "number", def: 12, min: 4, max: 36, step: 1, port: true, label: "mand.n" },
      { key: "rings", kind: "number", def: 4, min: 1, max: 8, step: 1, port: true, label: "mand.rings" },
      { key: "web", kind: "number", def: 2, min: 0.3, step: 0.5, label: "mand.web" },
      { key: "motif", kind: "select", def: "mixed", label: "mand.motif", options: opts(["mixed", ...MOTIFS], "mand.motif.") },
      { key: "edge", kind: "select", def: "petals", label: "mand.edge", options: opts(MANDALA_EDGES, "mand.edge.") },
      { key: "center", kind: "select", def: "flower", label: "mand.center", options: opts(MANDALA_CENTERS, "mand.center.") },
      { key: "seed", kind: "number", def: 1, min: 1, step: 1, port: true }
    ],
    run: (_i, p) => {
      const m = mandala({
        d: Math.max(20, num(p.d, 150)), n: num(p.sym, 12), rings: num(p.rings, 4), web: Math.max(0.3, num(p.web, 2)),
        edge: MANDALA_EDGES.includes(p.edge) ? p.edge : "petals", center: MANDALA_CENTERS.includes(p.center) ? p.center : "flower",
        seed: Math.max(1, Math.round(num(p.seed, 1))), motif: MOTIFS.includes(p.motif) ? p.motif : "mixed"
      });
      const gid = "grp-" + newId();
      const px = (pts: { x: number; y: number }[]) => pts.map(q => ({ x: q.x * PX, y: q.y * PX }));
      return { shapes: toOrigin([...m.holes.map(h => createPolyline(px(h), true, "inside", { groupId: gid })), createPolyline(px(m.outer), true, "outside", { groupId: gid })]) };
    }
  },
  {
    type: "puzzle", cat: "gen", icon: "🧩",
    inputs: [], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "w", kind: "number", def: 200, min: 20, step: 10, port: true },
      { key: "h", kind: "number", def: 150, min: 20, step: 10, port: true },
      { key: "cols", kind: "number", def: 6, min: 1, max: 40, step: 1, port: true },
      { key: "rows", kind: "number", def: 4, min: 1, max: 40, step: 1, port: true },
      { key: "outline", kind: "select", def: "rect", label: "pz.shape", options: opts(PUZZLE_SHAPES, "pz.shape.") },
      { key: "seed", kind: "number", def: 1, min: 1, step: 1, port: true }
    ],
    run: (_i, p) => {
      const r = puzzle({
        w: Math.max(20, num(p.w, 200)), h: Math.max(20, num(p.h, 150)), cols: Math.round(clamp(num(p.cols, 6), 1, 40)), rows: Math.round(clamp(num(p.rows, 4), 1, 40)),
        shape: PUZZLE_SHAPES.includes(p.outline) ? p.outline : "rect", tab: 100, jitter: 50, seed: Math.max(1, Math.round(num(p.seed, 1)))
      });
      const gid = "grp-" + newId();
      // erst die Linien, dann der Umriss – wie im Puzzle-Fenster alles auf der Linie
      return { shapes: toOrigin([...r.lines.map(l => mmShape(l.pts, false, "on-line", { groupId: gid })), mmShape(r.outline, true, "on-line", { groupId: gid })]) };
    }
  },
  {
    type: "vent", cat: "gen", icon: "▦",
    inputs: [], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "w", kind: "number", def: 120, min: 10, step: 5, port: true },
      { key: "h", kind: "number", def: 80, min: 10, step: 5, port: true },
      { key: "holePattern", kind: "select", def: "hex", label: "vent.pattern", options: opts(VENT_PATTERNS, "vent.pattern.") },
      { key: "hole", kind: "number", def: 6, min: 0.5, step: 0.5, port: true },
      { key: "web", kind: "number", def: 1.5, min: 0.3, step: 0.5, label: "mand.web" },
      { key: "margin", kind: "number", def: 6, min: 0, step: 1 },
      { key: "plate", kind: "check", def: true, label: "vent.plate" }
    ],
    run: (_i, p, ctx) => {
      const r = vent({
        shape: "rect", width: Math.max(10, num(p.w, 120)), height: Math.max(10, num(p.h, 80)), radius: 6, margin: Math.max(0, num(p.margin, 6)),
        pattern: VENT_PATTERNS.includes(p.holePattern) ? p.holePattern : "hex", size: Math.max(0.5, num(p.hole, 6)), web: Math.max(0.3, num(p.web, 1.5)),
        slotLength: 20, plate: !!p.plate, mountD: 0, mountInset: 6
      });
      if (r.holes.length > MAX_OUT) { ctx.warn("ng.w.tooMany"); return { shapes: [] }; }
      if (r.warnings.length) ctx.warn(r.warnings[0]);
      const gid = "grp-" + newId();
      const made = r.holes.map(h => mmShape(h, true, "inside", { groupId: gid }));
      if (r.outline) made.push(mmShape(r.outline, true, "outside", { groupId: gid }));
      return { shapes: toOrigin(made) };
    }
  },
  {
    type: "hinge", cat: "gen", icon: "〰",
    inputs: [], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "w", kind: "number", def: 200, min: 10, step: 10, port: true },
      { key: "h", kind: "number", def: 100, min: 10, step: 10, port: true },
      { key: "zone", kind: "number", def: 60, min: 5, step: 5, port: true },
      { key: "cuts", kind: "select", def: "lines", label: "hinge.pattern", options: opts(HINGE_PATTERNS, "hinge.pattern.") },
      { key: "thick", kind: "number", def: 3, min: 0.5, step: 0.5, port: true },
      { key: "plate", kind: "check", def: true, label: "hinge.panel" }
    ],
    run: (_i, p, ctx) => {
      const thick = Math.max(0.5, num(p.thick, 3));
      const r = livingHinge({
        pattern: HINGE_PATTERNS.includes(p.cuts) ? p.cuts : "lines", width: Math.max(10, num(p.w, 200)), height: Math.max(10, num(p.h, 100)),
        panel: !!p.plate, length: Math.max(5, num(p.zone, 60)), ...suggestForThickness(thick), thickness: thick
      });
      if (r.lines.length > MAX_OUT) { ctx.warn("ng.w.tooMany"); return { shapes: [] }; }
      if (r.warnings.length) ctx.warn(r.warnings[0]);
      const gid = "grp-" + newId();
      const made = r.lines.map(l => mmShape(l.pts, l.closed, l.closed ? "inside" : "on-line", { groupId: gid }));
      if (r.outline) made.push(mmShape(r.outline, true, "outside", { groupId: gid }));
      return { shapes: toOrigin(made) };
    }
  },

  // -------------------------------------------------------------------
  // Formen bearbeiten
  // -------------------------------------------------------------------
  {
    type: "polar", cat: "shape", icon: "✺",
    inputs: [{ name: "shapes", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    // Mittelpunkt des Kreises: `radius` mm unter der Mitte der Formen (0 = die Formen drehen sich um die eigene Mitte)
    params: [
      { key: "count", kind: "number", def: 8, min: 1, max: 360, step: 1, port: true, label: "array.count" },
      { key: "radius", kind: "number", def: 40, min: 0, step: 5, port: true },
      { key: "total", kind: "number", def: 360, min: -360, max: 360, step: 15, port: true, label: "array.total" },
      { key: "turn", kind: "check", def: true, label: "array.rotate" }
    ],
    run: (i, p, ctx) => {
      const src = i.shapes as any[];
      const b = groupBounds(src);
      if (!b) return { shapes: [] };
      const count = Math.round(clamp(num(p.count, 8), 1, 360));
      if (count * src.length > MAX_OUT) { ctx.warn("ng.w.tooMany"); return { shapes: fresh(src) }; }
      const from = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
      const cx = from.x, cy = from.y - Math.max(0, num(p.radius, 40)) * PX;
      const total = (clamp(num(p.total, 360), -360, 360) * Math.PI) / 180;
      const out = fresh(src);
      for (const pl of polarPlacements(count, cx, cy, from, total)) {
        const copy = fresh(src);
        for (const s of copy) { if (p.turn) rotateShape(s, cx, cy, pl.angle); else translateShape(s, pl.dx, pl.dy); }
        out.push(...copy);
      }
      return { shapes: out };
    }
  },
  {
    type: "onPath", cat: "shape", icon: "∿",
    inputs: [{ name: "shapes", type: "shapes", need: true }, { name: "path", type: "shapes", need: true }], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "count", kind: "number", def: 8, min: 1, max: 1000, step: 1, port: true, label: "array.count" },
      { key: "turn", kind: "check", def: true, label: "pathcopy.rotate" },
      { key: "keepPath", kind: "check", def: false }
    ],
    run: (i, p, ctx) => {
      const src = i.shapes as any[], paths = (i.path as any[]).flatMap(s => shapeToPaths(s)).filter(q => q.pts.length >= 2);
      const b = groupBounds(src);
      if (!b || !paths.length) { if (src.length || (i.path as any[]).length) ctx.warn("pathcopy.selectFirst"); return { shapes: fresh(src) }; }
      const count = Math.round(clamp(num(p.count, 8), 1, 1000));
      if (count * src.length * paths.length > MAX_OUT) { ctx.warn("ng.w.tooMany"); return { shapes: fresh(src) }; }
      const from = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
      const out: any[] = p.keepPath ? fresh(i.path) : [];
      for (const q of paths) {
        const spots = spotsOnPath(q.pts, q.closed, count);
        for (const spot of spots) {
          const copy = fresh(src);
          for (const s of copy) {
            translateShape(s, spot.x - from.x, spot.y - from.y);
            if (p.turn) rotateShape(s, spot.x, spot.y, spot.angle - spots[0].angle);
          }
          out.push(...copy);
        }
      }
      return { shapes: out };
    }
  },
  {
    type: "perforate", cat: "shape", icon: "┄",
    inputs: [{ name: "shapes", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "cut", kind: "number", def: 5, min: 0.1, step: 0.5, port: true, label: "perf.cut" },
      { key: "bridge", kind: "number", def: 1, min: 0.05, step: 0.1, port: true, label: "perf.gap" }
    ],
    run: (i, p, ctx) => {
      const cut = Math.max(0.1, num(p.cut, 5)) * PX, gap = Math.max(0.05, num(p.bridge, 1)) * PX;
      const out: any[] = [];
      for (const s of i.shapes as any[]) {
        if (s.type === "image") continue;
        const parts = shapeToPaths(s).flatMap(q => perforate(q.pts, q.closed, cut, gap));
        if (out.length + parts.length > MAX_OUT) { ctx.warn("ng.w.tooMany"); return { shapes: fresh(i.shapes) }; }
        const keep = { ...(s.laserLayerId ? { laserLayerId: s.laserLayerId } : {}), ...(s.millingDepth !== undefined ? { millingDepth: s.millingDepth } : {}),
          ...(s.toolId ? { toolId: s.toolId } : {}), groupId: "perf-" + newId() };
        for (const pts of parts) out.push(createPolyline(pts.map(c => ({ x: c.x, y: c.y })), false, "on-line", keep));
      }
      return { shapes: out };
    }
  },
  {
    type: "dogbone", cat: "shape", icon: "◔",
    inputs: [{ name: "shapes", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "tool", kind: "number", def: 3, min: 0.1, step: 0.5, port: true },
      { key: "bone", kind: "select", def: "dogbone", label: "bone.kind", options: opts(["dogbone", "tbone"], "bone.kind.") }
    ],
    run: async (i, p, ctx) => {
      const src = i.shapes as any[];
      if (!src.length) return { shapes: [] };
      // erst hier laden: das Dogbone-Fenster hängt an der Oberfläche
      const { addDogbones } = await import("../editor/dogbone");
      const r = addDogbones(src, { kind: p.bone === "tbone" ? "tbone" : "dogbone", tside: "long", radius: Math.max(0.05, num(p.tool, 3) / 2), extra: 0.05, maxAngle: 100, minEdge: 0.5 });
      if (!r.corners) ctx.warn(r.tight ? "ng.w.boneTight" : "bone.found0");
      return { shapes: fresh(r.shapes) };
    }
  },
  {
    type: "simplify", cat: "shape", icon: "⌇",
    inputs: [{ name: "shapes", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    params: [{ key: "tolerance", kind: "number", def: 0.1, min: 0.01, max: 5, step: 0.05, port: true, label: "simplify.tol" }],
    run: (i, p) => {
      const tol = clamp(num(p.tolerance, 0.1), 0.01, 5) * PX;
      const list = fresh(i.shapes);
      for (const s of list) if (s.type === "polyline" && s.points?.length > 2) {
        s.points = simplifyPath(s.points, !!s.closed, tol);
        updatePolylineBounds(s);
      }
      return { shapes: list };
    }
  },
  {
    type: "frame", cat: "shape", icon: "▢",
    inputs: [{ name: "shapes", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "margin", kind: "number", def: 8, step: 1, port: true },
      { key: "frameShape", kind: "select", def: "rect", options: ["rect", "oval"] },
      { key: "r", kind: "number", def: 4, min: 0, step: 0.5, port: true, when: p => p.frameShape !== "oval" },
      { key: "keepIn", kind: "check", def: true }
    ],
    run: (i, p) => {
      const b = groupBounds(i.shapes);
      if (!b) return { shapes: [] };
      const m = num(p.margin, 8) * PX;
      const x0 = b.minX - m, y0 = b.minY - m, x1 = b.maxX + m, y1 = b.maxY + m;
      if (x1 - x0 < 0.1 * PX || y1 - y0 < 0.1 * PX) return { shapes: fresh(i.shapes) };
      let pts: Pt[];
      if (p.frameShape === "oval") {
        // Ellipse, die das Rechteck (mit Rand) gerade umschließt
        pts = makeEllipsePoints((x0 + x1) / 2, (y0 + y1) / 2, ((x1 - x0) / 2) * Math.SQRT2, ((y1 - y0) / 2) * Math.SQRT2);
      } else {
        pts = makeRectPoints(x0, y0, x1, y1, Math.min(Math.max(0, num(p.r, 4)) * PX, (x1 - x0) / 2, (y1 - y0) / 2));
      }
      // erst der Inhalt, dann der Rahmen – das Teil fällt zuletzt heraus
      return { shapes: [...(p.keepIn ? fresh(i.shapes) : []), createPolyline(pts, true, "outside")] };
    }
  },
  {
    type: "filter", cat: "shape", icon: "⏷",
    inputs: [{ name: "shapes", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    // Größe = längere Seite der Form in mm; 0 = keine Grenze
    params: [
      { key: "pick", kind: "select", def: "all", options: ["all", "closed", "open"] },
      { key: "minSize", kind: "number", def: 0, min: 0, step: 1, port: true },
      { key: "maxSize", kind: "number", def: 0, min: 0, step: 1, port: true }
    ],
    run: (i, p, ctx) => {
      const lo = Math.max(0, num(p.minSize)) * PX, hi = Math.max(0, num(p.maxSize)) * PX;
      const list = (i.shapes as any[]).filter(s => {
        if (p.pick !== "all") {
          const closed = shapeToPaths(s).some(q => q.closed);
          if (closed !== (p.pick === "closed")) return false;
        }
        const b = groupBounds([s]);
        const size = b ? Math.max(b.maxX - b.minX, b.maxY - b.minY) : 0;
        return size >= lo && (!hi || size <= hi);
      });
      if (!list.length && (i.shapes as any[]).length) ctx.warn("ng.w.filterEmpty");
      return { shapes: fresh(list) };
    }
  },

  // -------------------------------------------------------------------
  // Zahlen
  // -------------------------------------------------------------------
  {
    type: "measure", cat: "number", icon: "📏",
    inputs: [{ name: "shapes", type: "shapes" }], outputs: [{ name: "width", type: "number" }, { name: "height", type: "number" }],
    params: [],
    run: i => {
      const b = groupBounds(i.shapes);
      return { width: b ? (b.maxX - b.minX) / PX : 0, height: b ? (b.maxY - b.minY) / PX : 0 };
    }
  }
];

// ---------------------------------------------------------------------
// Formen-Bibliothek: wird erst beim ersten Gebrauch geladen (braucht den SVG-Leser)
// ---------------------------------------------------------------------

interface Lib { shapes: { id: string; d: string }[]; parse: (d: string, tol: number) => { pts: Pt[]; closed: boolean }[] }
let lib: Lib | null = null;

async function loadLib(): Promise<Lib> {
  if (lib) return lib;
  const [a, b] = await Promise.all([import("../editor/shapeLibrary"), import("../importers/svgImport")]);
  lib = { shapes: a.SHAPES, parse: b.parsePathData };
  return lib;
}

/** Für die Auswahlliste: bis die Bibliothek geladen ist, nur der eingestellte Standard */
function libList(): { id: string }[] {
  if (!lib) { loadLib().catch(() => {}); return [{ id: "heart" }]; }
  return lib.shapes;
}

/** Vor dem Öffnen des Editors laden, damit die Auswahlliste gleich vollständig ist */
export function preloadNodeData(): Promise<unknown> { return loadLib().catch(() => {}); }
