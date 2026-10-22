/**
 * KNOTEN für den Knotengraph – jeder Knoten ruft eine Funktion auf, die es im Programm schon gibt
 * (Versatz, Verbinden, Ecken abrunden, Musterfüllung, Verschachteln, Kacheln, Bildkurve, Gravurtyp …).
 * Alle Knoten arbeiten auf Kopien, die Eingänge bleiben unverändert.
 * Texte: Name t("ng.n.<typ>"), Ein-/Ausgänge t("ng.port.<name>"), Einstellungen t("ng.p.<key>").
 */
import polygonClipping from "polygon-clipping";
import { registerNode, NodeDef } from "./graph";
import {
  MM_TO_PIXEL, Pt, groupBounds, translateShape, scaleShape, rotateShape, cloneShape, newId, shapeToPaths,
  createPolyline, createCircle, makeRectPoints, makePolygonPoints, pathArea, pointInPath
} from "../shapeTransform";
import { offsetPolygon } from "../polyOffset";
import { combine, units, region, toShapes, roundCorners, patternFill, tileShapes } from "../editor/shapeOps";
import { nestShapes, NestOptions } from "../editor/nest";
import { getLayers } from "../laserLayers";
import { app } from "../editor/editorState";
import { t } from "../i18n/i18n";
import { RASTER_METHODS, CELL_METHODS, NO_ADJUST } from "../raster/dither";
import { toImageUV, imageSizeMm } from "../raster/imageShape";

const PX = MM_TO_PIXEL;

/** Kopien mit neuen IDs; Gruppen bleiben zusammen, bekommen aber eigene Kennungen */
export function fresh(list: any[]): any[] {
  const gmap = new Map<string, string>();
  return list.map(s => {
    const c = s.type === "image" ? cloneImage(s) : cloneShape(s);
    c.id = newId();
    if (c.groupId) {
      if (!gmap.has(c.groupId)) gmap.set(c.groupId, "grp-" + newId());
      c.groupId = gmap.get(c.groupId);
    }
    return c;
  });
}

/** Bild-Form kopieren, ohne die (große) Bild-Adresse durch JSON zu schicken */
function cloneImage(s: any): any {
  const src = s.img?.src || "";
  const c = JSON.parse(JSON.stringify({ ...s, img: { ...s.img, src: "" } }));
  c.img.src = src;
  return c;
}

/** Bild für diesen Knoten: eigene, gleichbleibende ID (das gerasterte Ergebnis wird je ID zwischengespeichert) */
function imageFor(s: any, nodeId: string): any {
  const c = cloneImage(s);
  c.id = String(s.id).split("~")[0] + "~" + nodeId;
  c.img.adjust = { ...NO_ADJUST, ...(c.img.adjust || {}) };
  c.img.preset = "custom";
  return c;
}

const closedRings = (list: any[]): Pt[][] =>
  list.flatMap(s => shapeToPaths(s).filter(p => p.closed && p.pts.length >= 3).map(p => p.pts));

const num = (v: any, d = 0) => (Number.isFinite(+v) ? +v : d);

/** Quelle „live“: aktuelle Formen auf dem Bett mit den IDs der Kopie (fehlende: die Kopie) */
function liveShapes(p: Record<string, any>): any[] {
  const saved: any[] = Array.isArray(p.shapes) ? p.shapes : [];
  const onBed = new Map<string, any>((app().shapes || []).map((s: any) => [s.id, s]));
  return saved.map(s => onBed.get(s.id) || s);
}

/** Kurzer Stand einer Formen-Liste (Bild-Adresse nur über Länge + Ende, die ist sehr lang) */
function signature(list: any[]): string {
  return JSON.stringify(list.map(s => s.type === "image" ? { ...s, img: { ...s.img, src: s.img?.src?.length + ":" + String(s.img?.src).slice(-32) } } : s));
}

// ---------------------------------------------------------------------
// Quellen
// ---------------------------------------------------------------------

const defs: NodeDef[] = [
  {
    type: "source", cat: "source", icon: "📥",
    inputs: [], outputs: [{ name: "shapes", type: "shapes" }, { name: "image", type: "image" }],
    // shapes = übernommene Formen (Kopien), take = Knopf „Auswahl übernehmen“ (Editor füllt shapes).
    // live: stattdessen die Formen mit denselben IDs, wie sie gerade auf dem Bett liegen (fehlen sie, gilt die Kopie)
    params: [{ key: "take", kind: "button", def: null }, { key: "live", kind: "check", def: false }, { key: "shapes", kind: "data", def: [] }],
    sourceKey: p => p.live ? signature(liveShapes(p)) : "",
    run: (_i, p, ctx) => {
      const all: any[] = p.live ? liveShapes(p) : Array.isArray(p.shapes) ? p.shapes : [];
      if (!all.length) ctx.warn("ng.w.takeFirst");
      const img = all.find(s => s.type === "image");
      return { shapes: all.filter(s => s.type !== "image"), image: img ? imageFor(img, ctx.node.id) : null };
    }
  },
  {
    type: "rect", cat: "source", icon: "▭",
    inputs: [], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "w", kind: "number", def: 80, min: 0.1, step: 1, port: true },
      { key: "h", kind: "number", def: 50, min: 0.1, step: 1, port: true },
      { key: "r", kind: "number", def: 0, min: 0, step: 0.5, port: true }
    ],
    run: (_i, p) => {
      const w = Math.max(0.1, num(p.w)) * PX, h = Math.max(0.1, num(p.h)) * PX;
      const r = Math.min(Math.max(0, num(p.r)) * PX, w / 2, h / 2);
      return { shapes: [createPolyline(makeRectPoints(0, 0, w, h, r), true, "outside")] };
    }
  },
  {
    type: "circle", cat: "source", icon: "◯",
    inputs: [], outputs: [{ name: "shapes", type: "shapes" }],
    params: [{ key: "d", kind: "number", def: 50, min: 0.1, step: 1, port: true }],
    run: (_i, p) => { const r = Math.max(0.05, num(p.d) / 2) * PX; return { shapes: [createCircle(r, r, r)] }; }
  },
  {
    type: "polygon", cat: "source", icon: "⬡",
    inputs: [], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "sides", kind: "number", def: 6, min: 3, max: 64, step: 1, port: true },
      { key: "d", kind: "number", def: 50, min: 0.1, step: 1, port: true }
    ],
    run: (_i, p) => {
      const r = Math.max(0.05, num(p.d) / 2) * PX, n = Math.round(Math.min(64, Math.max(3, num(p.sides, 6))));
      return { shapes: [createPolyline(makePolygonPoints(r, r, r, n, Math.PI / 2), true, "outside")] };
    }
  },

  // -------------------------------------------------------------------
  // Zahlen
  // -------------------------------------------------------------------
  {
    type: "number", cat: "number", icon: "#",
    inputs: [], outputs: [{ name: "value", type: "number" }],
    params: [{ key: "value", kind: "number", def: 10, step: 1 }],
    run: (_i, p) => ({ value: num(p.value) })
  },
  {
    type: "math", cat: "number", icon: "±",
    inputs: [], outputs: [{ name: "value", type: "number" }],
    params: [
      { key: "a", kind: "number", def: 10, step: 1, port: true },
      { key: "op", kind: "select", def: "add", options: ["add", "sub", "mul", "div"] },
      { key: "b", kind: "number", def: 2, step: 1, port: true }
    ],
    run: (_i, p, ctx) => {
      const a = num(p.a), b = num(p.b);
      if (p.op === "div" && b === 0) { ctx.warn("ng.w.div0"); return { value: 0 }; }
      return { value: p.op === "sub" ? a - b : p.op === "mul" ? a * b : p.op === "div" ? a / b : a + b };
    }
  },

  // -------------------------------------------------------------------
  // Formen bearbeiten
  // -------------------------------------------------------------------
  {
    type: "transform", cat: "shape", icon: "✥",
    inputs: [{ name: "shapes", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "dx", kind: "number", def: 0, step: 1, port: true },
      { key: "dy", kind: "number", def: 0, step: 1, port: true },
      { key: "angle", kind: "number", def: 0, step: 15, port: true },
      { key: "scale", kind: "number", def: 100, min: 1, step: 5, port: true },
      { key: "mirror", kind: "select", def: "none", options: ["none", "h", "v"] }
    ],
    run: (i, p) => {
      const list = fresh(i.shapes);
      const b = groupBounds(list);
      if (!b) return { shapes: [] };
      const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
      const k = Math.max(0.01, num(p.scale, 100) / 100), a = (num(p.angle) * Math.PI) / 180;
      for (const s of list) {
        if (p.mirror === "h") scaleShape(s, cx, cy, -1, 1);
        else if (p.mirror === "v") scaleShape(s, cx, cy, 1, -1);
        if (k !== 1) scaleShape(s, cx, cy, k, k);
        if (a) rotateShape(s, cx, cy, a);
        translateShape(s, num(p.dx) * PX, num(p.dy) * PX);
      }
      return { shapes: list };
    }
  },
  {
    type: "place", cat: "shape", icon: "⌖",
    inputs: [{ name: "shapes", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    // an eine feste Stelle schieben: Ecke unten links (oder Mitte) auf x/y
    params: [
      { key: "x", kind: "number", def: 10, step: 1, port: true },
      { key: "y", kind: "number", def: 10, step: 1, port: true },
      { key: "anchor", kind: "select", def: "bl", options: ["bl", "c"] }
    ],
    run: (i, p) => {
      const list = fresh(i.shapes);
      const b = groupBounds(list);
      if (!b) return { shapes: [] };
      const ax = p.anchor === "c" ? (b.minX + b.maxX) / 2 : b.minX, ay = p.anchor === "c" ? (b.minY + b.maxY) / 2 : b.minY;
      for (const s of list) translateShape(s, num(p.x) * PX - ax, num(p.y) * PX - ay);
      return { shapes: list };
    }
  },
  {
    type: "offset", cat: "shape", icon: "⧉",
    inputs: [{ name: "shapes", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "dist", kind: "number", def: 2, min: 0.01, step: 0.5, port: true },
      { key: "dir", kind: "select", def: "out", options: ["out", "in", "both"] },
      { key: "keep", kind: "check", def: false }
    ],
    run: (i, p, ctx) => {
      // wie der Versatz-Dialog: Löcher (ungerade Tiefe) werden andersherum versetzt
      const paths = (i.shapes as any[]).map(s => shapeToPaths(s)[0]).filter(q => q && q.closed && q.pts.length >= 3);
      const areas = paths.map(q => Math.abs(pathArea(q.pts)));
      const d = Math.max(0.01, num(p.dist)) * PX;
      const out: any[] = p.keep ? fresh(i.shapes) : [];
      const gid = "offs-" + newId();
      paths.forEach((q, a) => {
        let depth = 0;
        paths.forEach((o, b) => { if (b !== a && areas[b] > areas[a] && pointInPath(q.pts[0].x, q.pts[0].y, o.pts)) depth++; });
        const sign = depth % 2 === 1 ? -1 : 1;
        const dists = p.dir === "both" ? [d, -d] : p.dir === "in" ? [-d] : [d];
        for (const dd of dists) for (const loop of offsetPolygon(q.pts, dd * sign, 0.02)) {
          out.push(createPolyline(loop, true, depth % 2 === 1 ? "inside" : "outside", { groupId: gid }));
        }
      });
      if (!paths.length && (i.shapes as any[]).length) ctx.warn("ng.w.needClosed");
      return { shapes: out };
    }
  },
  {
    type: "boolean", cat: "shape", icon: "◑",
    inputs: [{ name: "a", type: "shapes" }, { name: "b", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    params: [{ key: "op", kind: "select", def: "union", options: ["union", "subtract", "intersect", "xor"] }],
    run: (i, p, ctx) => {
      const A = i.a as any[], B = i.b as any[];
      if (p.op === "union" && !B.length) {
        // nur ein Eingang: alles darin miteinander verbinden
        const r = combine("union", A);
        if (r.error) { if (A.length) ctx.warn(r.error); return { shapes: fresh(A) }; }
        return { shapes: r.add };
      }
      const ra = units(A).map(region).filter(r => r && r.length) as any[];
      const rb = units(B).map(region).filter(r => r && r.length) as any[];
      if (!ra.length || !rb.length) { ctx.warn("ops.needTwo"); return { shapes: fresh(A) }; }
      const ua = ra.length > 1 ? polygonClipping.union(ra[0], ...ra.slice(1)) : ra[0];
      const ub = rb.length > 1 ? polygonClipping.union(rb[0], ...rb.slice(1)) : rb[0];
      const res = p.op === "subtract" ? polygonClipping.difference(ua, ub)
        : p.op === "intersect" ? polygonClipping.intersection(ua, ub)
          : p.op === "xor" ? polygonClipping.xor(ua, ub) : polygonClipping.union(ua, ub);
      if (!res.length) ctx.warn(p.op === "intersect" ? "ops.noOverlap" : "ops.empty");
      return { shapes: toShapes(res, A[0]) };
    }
  },
  {
    type: "fillet", cat: "shape", icon: "◜",
    inputs: [{ name: "shapes", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "r", kind: "number", def: 3, min: 0.01, step: 0.5, port: true },
      { key: "chamfer", kind: "check", def: false }
    ],
    run: (i, p) => {
      const list = fresh(i.shapes);
      for (const s of list) roundCorners(s, Math.max(0.01, num(p.r)) * PX, !!p.chamfer);
      return { shapes: list };
    }
  },
  {
    type: "array", cat: "shape", icon: "⊞",
    inputs: [{ name: "shapes", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "cols", kind: "number", def: 3, min: 1, max: 100, step: 1, port: true },
      { key: "rows", kind: "number", def: 2, min: 1, max: 100, step: 1, port: true },
      { key: "gapX", kind: "number", def: 5, step: 0.5, port: true },
      { key: "gapY", kind: "number", def: 5, step: 0.5, port: true }
    ],
    run: (i, p, ctx) => {
      const src = i.shapes as any[];
      const b = groupBounds(src);
      if (!b) return { shapes: [] };
      const cols = Math.round(Math.min(100, Math.max(1, num(p.cols, 1)))), rows = Math.round(Math.min(100, Math.max(1, num(p.rows, 1))));
      if (cols * rows * src.length > 20000) { ctx.warn("ng.w.tooMany"); return { shapes: fresh(src) }; }
      const sx = b.maxX - b.minX + num(p.gapX) * PX, sy = b.maxY - b.minY + num(p.gapY) * PX;
      const out: any[] = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const copy = fresh(src);
        for (const s of copy) translateShape(s, c * sx, r * sy);
        out.push(...copy);
      }
      return { shapes: out };
    }
  },
  {
    type: "pattern", cat: "shape", icon: "▦",
    inputs: [{ name: "area", type: "shapes" }, { name: "motif", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "gapX", kind: "number", def: 3, min: 0, step: 0.5, port: true },
      { key: "gapY", kind: "number", def: 3, min: 0, step: 0.5, port: true },
      { key: "brick", kind: "check", def: false },
      { key: "clip", kind: "check", def: false }
    ],
    run: (i, p, ctx) => {
      const area = fresh(i.area), motif = fresh(i.motif);
      if (!area.length || !motif.length) { ctx.warn("pat.select"); return { shapes: [...area, ...motif] }; }
      // Fläche und Motiv als je eine Gruppe, damit patternFill sie auseinanderhält
      const ga = "grp-" + newId(), gm = "grp-" + newId();
      area.forEach(s => { s.groupId = ga; });
      motif.forEach(s => { s.groupId = gm; });
      const r = patternFill([...area, ...motif], { gapX: Math.max(0, num(p.gapX)), gapY: Math.max(0, num(p.gapY)), brick: !!p.brick, clip: !!p.clip });
      if (r.error) { ctx.warn(r.error); return { shapes: [...area, ...motif] }; }
      const gone = new Set(r.remove);
      return { shapes: [...[...area, ...motif].filter(s => !gone.has(s)), ...r.add] };
    }
  },
  {
    type: "nest", cat: "shape", icon: "🧩",
    inputs: [{ name: "shapes", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "gap", kind: "number", def: 3, min: 0, step: 0.5, port: true },
      { key: "margin", kind: "number", def: 5, min: 0, step: 0.5, port: true },
      { key: "rotate", kind: "select", def: "90", options: ["none", "90", "45", "auto"] },
      { key: "holes", kind: "check", def: true }
    ],
    run: (i, p, ctx) => {
      const list = fresh(i.shapes);
      if (!list.length) return { shapes: [] };
      const o: NestOptions = { gapMm: Math.max(0, num(p.gap)), marginMm: Math.max(0, num(p.margin)), rotate: p.rotate, holes: !!p.holes, anchor: "bl", dir: "right", ignoreBed: true };
      const r = nestShapes(o, list);
      if (r.failed) ctx.warn("ng.w.nestFailed", { n: r.failed });
      return { shapes: list };
    }
  },
  {
    type: "tiles", cat: "shape", icon: "▤",
    inputs: [{ name: "shapes", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    // Die Kacheln liegen etwas auseinander (Vorschau). Mit toBeds bekommt jede ngBed = Nummer (0, 1, 2 …) und
    // ngShift = so weit wird sie beim Übernehmen zurückgeschoben (Kachel-Ecke an den Nullpunkt, eigenes Bett)
    params: [
      { key: "w", kind: "number", def: 300, min: 1, step: 10, port: true },
      { key: "h", kind: "number", def: 300, min: 1, step: 10, port: true },
      { key: "toBeds", kind: "check", def: true }
    ],
    run: (i, p, ctx) => {
      if ((i.shapes as any[]).some(s => s.type === "image")) ctx.warn("ng.w.tileImage");
      const r = tileShapes(i.shapes, Math.max(1, num(p.w)) * PX, Math.max(1, num(p.h)) * PX);
      if (r.error) { if ((i.shapes as any[]).length) ctx.warn(r.error); return { shapes: [] }; }
      const used = r.tiles.filter(tl => tl.shapes.length);
      const gap = 8 * PX;
      const out: any[] = [];
      used.forEach((tl, k) => {
        for (const s of tl.shapes) {
          translateShape(s, tl.col * gap, tl.row * gap);
          if (p.toBeds) { s.ngBed = k; s.ngShift = [tl.x0 + tl.col * gap, tl.y0 + tl.row * gap]; }
          out.push(s);
        }
      });
      return { shapes: out };
    }
  },
  {
    type: "layer", cat: "shape", icon: "🎨",
    inputs: [{ name: "shapes", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    params: [
      { key: "laser", kind: "select", def: "", options: () => [{ value: "", label: t("ng.keep") }, ...getLayers().map(l => ({ value: l.id, label: l.name }))] },
      { key: "mode", kind: "select", def: "", options: () => [{ value: "", label: t("ng.keep") },
        ...[["outside", "mode.part"], ["inside", "mode.hole"], ["on-line", "mode.engrave"], ["pocket", "mode.pocket"]].map(([v, k]) => ({ value: v, label: t(k) }))] },
      { key: "depth", kind: "number", def: 0, step: 0.5 }
    ],
    run: (i, p) => {
      const list = fresh(i.shapes);
      for (const s of list) {
        if (p.laser && getLayers().some(l => l.id === p.laser)) s.laserLayerId = p.laser;
        if (p.mode) s.millingMode = p.mode;
        if (num(p.depth) > 0) s.millingDepth = -Math.abs(num(p.depth));
      }
      return { shapes: list };
    }
  },
  {
    type: "merge", cat: "shape", icon: "⊕",
    inputs: [{ name: "a", type: "shapes" }, { name: "b", type: "shapes" }, { name: "c", type: "shapes" }], outputs: [{ name: "shapes", type: "shapes" }],
    params: [],
    run: i => ({ shapes: [...fresh(i.a), ...fresh(i.b), ...fresh(i.c)] })
  },

  // -------------------------------------------------------------------
  // Bild
  // -------------------------------------------------------------------
  {
    type: "bgRemove", cat: "image", icon: "✂",
    inputs: [{ name: "image", type: "image" }], outputs: [{ name: "image", type: "image" }],
    params: [{ key: "tol", kind: "number", def: 25, min: 0, max: 100, step: 1, port: true }],
    run: (i, p, ctx) => {
      if (!i.image) return { image: null };
      const im = imageFor(i.image, ctx.node.id);
      im.img.bg = { on: true, tol: Math.min(100, Math.max(0, num(p.tol, 25))) };
      return { image: im };
    }
  },
  {
    type: "curve", cat: "image", icon: "〜",
    inputs: [{ name: "image", type: "image" }], outputs: [{ name: "image", type: "image" }],
    // Bildkurve aus drei Reglern: Tiefen / Mitten / Lichter verschieben (−50 … 50)
    params: [
      { key: "shadows", kind: "number", def: 0, min: -50, max: 50, step: 5, port: true },
      { key: "mids", kind: "number", def: 0, min: -50, max: 50, step: 5, port: true },
      { key: "lights", kind: "number", def: 0, min: -50, max: 50, step: 5, port: true }
    ],
    run: (i, p, ctx) => {
      if (!i.image) return { image: null };
      const im = imageFor(i.image, ctx.node.id);
      const c = (v: any) => Math.min(50, Math.max(-50, num(v))) / 200;
      im.img.adjust.curve = [[0, 0], [0.25, Math.min(1, Math.max(0, 0.25 + c(p.shadows)))], [0.5, Math.min(1, Math.max(0, 0.5 + c(p.mids)))],
        [0.75, Math.min(1, Math.max(0, 0.75 + c(p.lights)))], [1, 1]];
      return { image: im };
    }
  },
  {
    type: "adjust", cat: "image", icon: "◐",
    inputs: [{ name: "image", type: "image" }], outputs: [{ name: "image", type: "image" }],
    params: [
      { key: "brightness", kind: "number", def: 0, min: -100, max: 100, step: 5, port: true },
      { key: "contrast", kind: "number", def: 0, min: -100, max: 100, step: 5, port: true },
      { key: "gamma", kind: "number", def: 1, min: 0.3, max: 3, step: 0.1, port: true },
      { key: "sharpen", kind: "number", def: 0, min: 0, max: 100, step: 5, port: true },
      { key: "invert", kind: "check", def: false }
    ],
    run: (i, p, ctx) => {
      if (!i.image) return { image: null };
      const im = imageFor(i.image, ctx.node.id);
      const cl = (v: any, a: number, b: number, d: number) => Math.min(b, Math.max(a, num(v, d)));
      Object.assign(im.img.adjust, {
        brightness: cl(p.brightness, -100, 100, 0), contrast: cl(p.contrast, -100, 100, 0),
        gamma: cl(p.gamma, 0.3, 3, 1), sharpen: cl(p.sharpen, 0, 100, 0), invert: !!p.invert
      });
      return { image: im };
    }
  },
  {
    type: "engrave", cat: "image", icon: "▒",
    inputs: [{ name: "image", type: "image" }], outputs: [{ name: "image", type: "image" }],
    params: [
      { key: "method", kind: "select", def: "jarvis", options: () => RASTER_METHODS.map(m => ({ value: m, label: t("eng.m." + m) })) },
      { key: "interval", kind: "number", def: 0.1, min: 0.02, max: 2, step: 0.01, port: true },
      { key: "threshold", kind: "number", def: 50, min: 0, max: 100, step: 5, when: p => p.method === "threshold" },
      { key: "cell", kind: "number", def: 6, min: 2, max: 40, step: 1, when: p => CELL_METHODS.includes(p.method) },
      { key: "angle", kind: "number", def: 0, min: -90, max: 90, step: 15, when: p => CELL_METHODS.includes(p.method) }
    ],
    run: (i, p, ctx) => {
      if (!i.image) return { image: null };
      const im = imageFor(i.image, ctx.node.id);
      const method = RASTER_METHODS.includes(p.method) ? p.method : "jarvis";
      im.img.raster = { method, threshold: Math.min(1, Math.max(0, num(p.threshold, 50) / 100)),
        cell: Math.min(40, Math.max(2, num(p.cell, 6))), angle: num(p.angle) };
      im.img.interval = Math.min(2, Math.max(0.02, num(p.interval, 0.1)));
      return { image: im };
    }
  },
  {
    type: "imgSize", cat: "image", icon: "⤢",
    inputs: [{ name: "image", type: "image" }], outputs: [{ name: "image", type: "image" }],
    // Breite in mm (Höhe passt sich an), Ecke unten links auf x/y
    params: [
      { key: "w", kind: "number", def: 100, min: 1, step: 5, port: true },
      { key: "x", kind: "number", def: 10, step: 1, port: true },
      { key: "y", kind: "number", def: 10, step: 1, port: true }
    ],
    run: (i, p, ctx) => {
      if (!i.image) return { image: null };
      const im = imageFor(i.image, ctx.node.id);
      const cur = imageSizeMm(im);
      const k = Math.max(1, num(p.w, 100)) / Math.max(0.01, cur.w);
      const p0 = im.points[0];
      scaleShape(im, p0.x, p0.y, k, k);
      translateShape(im, num(p.x) * PX - im.points[0].x, num(p.y) * PX - im.points[0].y);
      return { image: im };
    }
  },
  {
    type: "mask", cat: "image", icon: "◎",
    inputs: [{ name: "image", type: "image" }, { name: "shapes", type: "shapes" }], outputs: [{ name: "image", type: "image" }],
    params: [],
    run: (i, _p, ctx) => {
      if (!i.image) return { image: null };
      const im = imageFor(i.image, ctx.node.id);
      const rings = closedRings(i.shapes);
      if (rings.length) im.img.mask = rings.map(r => r.map(q => toImageUV(im, q)));
      else { delete im.img.mask; if ((i.shapes as any[]).length) ctx.warn("mask.needContour"); }
      return { image: im };
    }
  },

  // -------------------------------------------------------------------
  // Ausgabe
  // -------------------------------------------------------------------
  {
    type: "output", cat: "output", icon: "📤",
    inputs: [{ name: "shapes", type: "shapes" }, { name: "image", type: "image" }], outputs: [],
    // removeSrc: beim Übernehmen die Originale der Quell-Knoten vom Bett nehmen
    params: [{ key: "removeSrc", kind: "check", def: false }],
    run: i => ({ shapes: i.shapes, image: i.image })
  }
];

let done = false;
export function registerAllNodes() {
  if (done) return;
  done = true;
  defs.forEach(registerNode);
}

/** Reihenfolge der Gruppen in der Knoten-Liste */
export const NODE_CATS: NodeDef["cat"][] = ["source", "shape", "image", "number", "output"];
